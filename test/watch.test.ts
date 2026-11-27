import type { TraceEvent } from "taugraph";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/core/plugin.js";
import { nextRun } from "../src/core/schedule.js";
import type { Watch } from "../src/core/types.js";
import { watchGraph } from "../src/core/watch.js";
import { harness } from "./helpers.js";

function priceTool() {
  const state = { price: "1280", fail: false, calls: 0 };
  const tool = defineTool({
    name: "flight_price",
    description: "price",
    input: z.object({}),
    effect: "read" as const,
    run: () => {
      state.calls++;
      if (state.fail) throw new Error("network down");
      return { value: state.price, headline: `最低 ${state.price} 元` };
    },
  });
  return { state, plugin: { name: "price", tools: [tool] } };
}

describe("watches", () => {
  it("speaks up the first time and when the value changes, not when it stays the same", async () => {
    const price = priceTool();
    const { moqi, clock, delivered } = harness({ plugins: [price.plugin], start: "2026-11-20T08:00:00+08:00" });
    await moqi.callTool(
      "watch_create",
      { title: "机票", schedule: { every: "hours", hours: 1 }, tool: "flight_price" },
      { byUser: true },
    );
    const alerts = () => delivered.filter((d) => d.offer.kind === "watch.alert").map((d) => d.offer.body);

    clock.advance(3_600_001);
    await moqi.tick();
    clock.advance(3_600_001);
    await moqi.tick();
    expect(alerts()).toEqual(["最低 1280 元"]);

    price.state.price = "990";
    clock.advance(3_600_001);
    await moqi.tick();
    expect(alerts()).toEqual(["最低 1280 元", "最低 990 元"]);
  });

  it("records a failed check without alerting, and tries again next time", async () => {
    const price = priceTool();
    price.state.fail = true;
    const { moqi, clock, delivered } = harness({ plugins: [price.plugin] });
    await moqi.callTool(
      "watch_create",
      { title: "机票", schedule: { every: "hours", hours: 1 }, tool: "flight_price" },
      { byUser: true },
    );
    clock.advance(3_600_001);
    await moqi.tick();
    const [watch] = [...moqi.state.watches.values()];
    expect(watch?.last?.headline).toMatch(/这次没查成/);
    expect(price.state.calls).toBe(2); // one retry inside the flow
    expect(delivered.some((d) => d.offer.kind === "watch.alert")).toBe(false);
    expect(watch?.nextAt).toBeGreaterThan(clock.now());
  });

  it("only lets watches call read tools", async () => {
    const { moqi, clock } = harness();
    moqi.emit({
      type: "watch.created",
      watch: {
        id: "w_bad",
        title: "bad",
        schedule: { every: "hours", hours: 1 },
        check: { tool: "forget", args: { id: "x" } },
        notify: "always",
        nextAt: clock.now(),
      },
    });
    await moqi.tick();
    expect(moqi.state.watches.get("w_bad")?.last?.headline).toMatch(/只读/);
  });

  it("reminds at the scheduled local time", async () => {
    const { moqi, clock, delivered } = harness({ start: "2026-11-20T20:00:00+08:00" });
    await moqi.callTool(
      "watch_create",
      { title: "早点睡", schedule: { every: "day", at: "22:00" }, remind: "该睡了" },
      { byUser: true },
    );
    clock.set("2026-11-20T21:59:00+08:00");
    await moqi.tick();
    expect(delivered.filter((d) => d.offer.kind === "watch.alert")).toHaveLength(0);
    clock.set("2026-11-20T22:00:10+08:00");
    await moqi.tick();
    expect(delivered.filter((d) => d.offer.kind === "watch.alert").map((d) => d.offer.body)).toEqual(["该睡了"]);
  });

  it("is a taugraph flow whose alert never fires again on replay", async () => {
    let alerts = 0;
    const watch: Watch = {
      id: "w1",
      title: "t",
      schedule: { every: "hours", hours: 1 },
      check: { remind: "hi" },
      notify: "always",
      nextAt: 0,
    };
    const graph = watchGraph(watch, { callTool: async () => "", alert: () => void alerts++ });
    const first = await graph.run({});
    expect(first.trace.find((e) => e.type === "enter" && e.nodeId === "alert")?.meta).toMatchObject({
      effect: "write",
    });
    await expect(graph.replay(first.trace, { mode: "live" })).rejects.toThrow(/write node "alert"/);
    expect(alerts).toBe(1);
  });

  it("computes the next local run for daily and weekly schedules", () => {
    const at = Date.parse("2026-11-20T09:30:00+08:00"); // Friday
    expect(new Date(nextRun({ every: "day", at: "09:00" }, at)).toISOString()).toBe("2026-11-21T01:00:00.000Z");
    expect(new Date(nextRun({ every: "week", days: [1], at: "08:00" }, at)).toISOString()).toBe(
      "2026-11-23T00:00:00.000Z",
    );
  });
  it("traces every run and links it from watch.ran, also when the check fails", async () => {
    const price = priceTool();
    const events: TraceEvent[] = [];
    const { moqi, clock } = harness({
      plugins: [price.plugin],
      start: "2026-11-20T08:00:00+08:00",
      onTrace: (e) => events.push(e),
    });
    await moqi.callTool(
      "watch_create",
      { title: "机票", schedule: { every: "hours", hours: 1 }, tool: "flight_price" },
      { byUser: true },
    );
    clock.advance(3_600_001);
    await moqi.tick();
    price.state.fail = true;
    clock.advance(3_600_001);
    await moqi.tick();
    const ran = moqi.store.all().filter((e) => e.type === "watch.ran");
    expect(ran).toHaveLength(2);
    const [ok, failed] = ran.map((e) => (e as { run?: string }).run);
    const of = (run: string | undefined) => events.filter((e) => e.runId === run);
    expect(of(ok).map((e) => (e.type === "enter" ? e.nodeId : e.type))).toEqual([
      "run_start",
      "check",
      "exit",
      "compare",
      "exit",
      "alert",
      "exit",
      "run_end",
    ]);
    expect(of(ok).find((e) => e.type === "enter" && e.nodeId === "alert")?.meta).toMatchObject({ effect: "write" });
    expect(of(failed).at(-1)).toMatchObject({ type: "run_end", meta: { status: "failed" } });
  });
});
