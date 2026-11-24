import { describe, expect, it } from "vitest";
import type { ModelCall } from "../src/core/model.js";
import { UsageLog } from "../src/node/usage.js";

const call = (c: Partial<ModelCall> = {}): ModelCall => ({
  model: "m",
  purpose: "chat",
  attempt: 1,
  ms: 1000,
  ok: true,
  ...c,
});
const at = (iso: string) => Date.parse(iso);

describe("usage log", () => {
  it("adds up attempts, failures, time and tokens by kind of request", () => {
    const log = new UsageLog(() => at("2026-11-24T10:00:00+08:00"));
    log.record(call({ ok: false, ms: 50, error: "503" }));
    log.record(call({ attempt: 2, ms: 3000, promptTokens: 100, completionTokens: 10 }));
    log.record(call({ ms: 1000, promptTokens: 200, completionTokens: 20 }));
    log.record(call({ purpose: "background", ms: 500 })); // answered, but the provider sent no token count
    expect(log.recent()).toEqual([
      {
        day: "2026-11-24",
        chat: { attempts: 3, failed: 1, answeredMs: 4000, counted: 2, promptTokens: 300, completionTokens: 30 },
        background: { attempts: 1, failed: 0, answeredMs: 500, counted: 0, promptTokens: 0, completionTokens: 0 },
      },
    ]);
  });

  it("starts a new day at local midnight and lists the newest first", () => {
    let now = at("2026-11-24T23:59:00+08:00");
    const log = new UsageLog(() => now);
    log.record(call());
    now = at("2026-11-25T00:01:00+08:00");
    log.record(call());
    log.record(call());
    expect(log.recent().map((d) => [d.day, d.chat.attempts])).toEqual([
      ["2026-11-25", 2],
      ["2026-11-24", 1],
    ]);
    expect(log.since).toBe(at("2026-11-24T23:59:00+08:00"));
  });

  it("keeps two weeks and shows the last seven days", () => {
    let now = at("2026-11-01T12:00:00+08:00");
    const log = new UsageLog(() => now);
    for (let i = 0; i < 20; i++) {
      log.record(call());
      now += 24 * 3_600_000;
    }
    expect(log.recent(100)).toHaveLength(14);
    expect(log.recent()).toHaveLength(7);
    expect(log.recent()[0]?.day).toBe("2026-11-20");
  });
});
