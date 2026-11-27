import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGraph, isTaugraphError, toJSONL } from "taugraph";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TRACE_DAYS, traces } from "../src/node/traces.js";

const tmp = () => mkdtempSync(join(tmpdir(), "moqi-traces-"));
const schema = z.object({ n: z.number(), answer: z.string().nullable().default(null) });
type S = z.infer<typeof schema>;
const done = createGraph(schema, { start: "a", nodes: { a: (s: S) => ({ ...s, n: s.n + 1 }) }, endNodes: ["a"] });
const failing = createGraph(schema, {
  start: "a",
  nodes: {
    a: (): S => {
      throw new Error("x");
    },
  },
  endNodes: ["a"],
});
const asking = createGraph(schema, {
  start: "ask",
  nodes: { ask: (s: S, ctx) => ({ ...s, answer: ctx.interrupt<string>("?") }) },
  endNodes: ["ask"],
});
const files = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

describe("traces", () => {
  it("keeps one file per run under runs/ and removes runs that ended more than 30 days ago", async () => {
    const home = tmp();
    const t = traces(home);
    const old = await done.run({ n: 0 }, { onEvent: t.sink });
    const recent = await done.run({ n: 1 }, { onEvent: t.sink });
    const error = await failing.run({ n: 0 }, { onEvent: t.sink }).catch((e: unknown) => e);
    const failed = isTaugraphError(error) ? (error.trace?.[0]?.runId as string) : "";
    const paused = await asking.run({ n: 0 }, { onEvent: t.sink });
    const cut = (await done.run({ n: 2 })).trace;
    const interrupted = cut[0]?.runId as string;
    writeFileSync(join(t.dir, `${interrupted}.jsonl`), toJSONL(cut.slice(0, 2)));
    expect(t.dir).toBe(join(home, "runs"));
    expect(files(t.dir)).toHaveLength(5);

    const longAgo = new Date(Date.now() - (TRACE_DAYS + 1) * 86_400_000);
    for (const id of [old.runId, failed, paused.runId, interrupted]) {
      utimesSync(join(t.dir, `${id}.jsonl`), longAgo, longAgo);
    }
    expect(t.prune()).toBe(3);
    expect(files(t.dir)).toEqual([`${recent.runId}.jsonl`, `${paused.runId}.jsonl`].sort());
    expect(t.prune(Date.now() + (TRACE_DAYS + 1) * 86_400_000)).toBe(1); // the recent one, a month later
  });

  it("reports the first failure to store a trace once, and never stops a run", async () => {
    const home = tmp();
    writeFileSync(join(home, "runs"), "not a directory");
    const lines: string[] = [];
    const t = traces(home, (line) => lines.push(line));
    expect((await done.run({ n: 0 }, { onEvent: t.sink })).status).toBe("completed");
    expect((await done.run({ n: 1 }, { onEvent: t.sink })).status).toBe("completed");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^moqi：运行记录存不进 .*runs（.+），之后不再提示$/);
  });
});
