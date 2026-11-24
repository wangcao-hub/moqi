import { describe, expect, it } from "vitest";
import { type ModelCall, openAICompatible } from "../src/core/model.js";

const ok = (content = "好", usage?: Record<string, number>) =>
  Response.json({ choices: [{ message: { content } }], ...(usage && { usage }) });
const ask = { messages: [{ role: "user" as const, content: "你好" }] };
/** A fetch that plays one scripted answer per call and counts the calls. */
function script(...answers: (Response | Error | ((init: RequestInit) => Promise<Response>))[]) {
  const state = { calls: 0 };
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const next = answers[Math.min(state.calls++, answers.length - 1)];
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(init ?? {}) : (next as Response).clone();
  }) as typeof fetch;
  return { state, fetchImpl };
}
const model = (fetchImpl: typeof fetch, extra: Partial<Parameters<typeof openAICompatible>[0]> = {}) =>
  openAICompatible({ baseURL: "http://m.test/v1", model: "m", fetch: fetchImpl, retryDelayMs: 1, ...extra });

describe("model calls", () => {
  it("tries again after a rate limit or a server error, then gives the answer", async () => {
    const { state, fetchImpl } = script(
      new Response("slow down", { status: 429 }),
      new Response("", { status: 503 }),
      ok(),
    );
    expect((await model(fetchImpl).chat(ask)).content).toBe("好");
    expect(state.calls).toBe(3);
  });
  it("tries again when the connection breaks", async () => {
    const { state, fetchImpl } = script(new TypeError("fetch failed"), ok());
    expect((await model(fetchImpl).chat(ask)).content).toBe("好");
    expect(state.calls).toBe(2);
  });
  it("gives up after three attempts and says what the last one answered", async () => {
    const { state, fetchImpl } = script(new Response("busy", { status: 503 }));
    await expect(model(fetchImpl).chat(ask)).rejects.toThrow("responded 503: busy");
    expect(state.calls).toBe(3);
  });
  it("does not retry what would fail the same way again", async () => {
    const { state, fetchImpl } = script(new Response("bad key", { status: 401 }), ok());
    await expect(model(fetchImpl).chat(ask)).rejects.toThrow("responded 401");
    expect(state.calls).toBe(1);
  });
  it("gives up on an attempt that takes too long, without trying again", async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    const { state, fetchImpl } = script(hang);
    await expect(model(fetchImpl, { timeoutMs: 30 }).chat(ask)).rejects.toThrow("没有回应");
    expect(state.calls).toBe(1);
  });
  it("stops at once, with no retry, when the caller stops", async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    const { state, fetchImpl } = script(hang);
    const stop = new AbortController();
    const turn = model(fetchImpl).chat({ ...ask, signal: stop.signal });
    setTimeout(() => stop.abort("stop"), 10);
    await expect(turn).rejects.toBe("stop");
    expect(state.calls).toBe(1);
  });
  it("reports every attempt: how long, which kind of request, tokens used, what failed", async () => {
    const calls: ModelCall[] = [];
    const { fetchImpl } = script(
      new Response("", { status: 502 }),
      ok("好", { prompt_tokens: 120, completion_tokens: 7 }),
    );
    const m = model(fetchImpl, { onCall: (c) => calls.push(c) });
    await m.chat({ ...ask, reasoning: "off" });
    expect(calls).toMatchObject([
      { model: "m", purpose: "background", attempt: 1, ok: false },
      { model: "m", purpose: "background", attempt: 2, ok: true, promptTokens: 120, completionTokens: 7 },
    ]);
    expect(calls[0]?.error).toContain("502");
    await model(script(ok()).fetchImpl, { onCall: (c) => calls.push(c) }).chat(ask);
    expect(calls.at(-1)).toMatchObject({ purpose: "chat", ok: true });
    expect(calls.at(-1)).not.toHaveProperty("promptTokens");
  });
});
