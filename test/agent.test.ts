import { describe, expect, it } from "vitest";
import { z } from "zod";
import { referenceMessage, systemPrompt } from "../src/core/agent.js";
import type { ChatMessage, ChatRequest } from "../src/core/model.js";
import { defineTool } from "../src/core/plugin.js";
import { call, harness, scriptedModel } from "./helpers.js";

const isExtraction = (r: ChatRequest) => r.messages[0]?.content.includes("从对话里摘出用户亲口说的") ?? false;
const lastTool = (r: ChatRequest) => [...r.messages].reverse().find((m) => m.role === "tool");

describe("conversation", () => {
  it("answers, calling tools in a loop and feeding results back", async () => {
    const model = scriptedModel((r) => {
      if (isExtraction(r)) return '{"facts":[]}';
      return lastTool(r)
        ? `好的，${lastTool(r)?.content}`
        : call("remember", { kind: "basic", content: "住在深圳南山" });
    });
    const { moqi } = harness({ model });
    expect(await moqi.chat("我住在深圳南山")).toBe("好的，记住了：住在深圳南山");
    expect([...moqi.state.facts.values()].map((f) => f.content)).toEqual(["住在深圳南山"]);
    expect(model.requests[0]?.tools?.map((t) => t.name)).toEqual(expect.arrayContaining(["remember", "watch_create"]));
    expect(model.requests[0]?.tools?.map((t) => t.name)).not.toContain("set_level");
  });

  it("asks the user before a write the model wants, and tells the model the answer", async () => {
    const model = scriptedModel((r) =>
      lastTool(r)
        ? `结果：${lastTool(r)?.content}`
        : call("watch_create", { title: "早点睡", schedule: { every: "day", at: "22:00" }, remind: "该睡了" }),
    );
    const { moqi, asked } = harness({ model, answer: false });
    expect(await moqi.chat("每晚十点提醒我睡觉")).toBe("结果：用户没有同意，这一步没做");
    expect(asked).toHaveLength(1);
  });

  it("tells the model what it knows about the user in a reference message, not in the system prompt", async () => {
    const model = scriptedModel(() => "好");
    const { moqi } = harness({ model });
    moqi.remember({ kind: "relation", content: "住在深圳南山" });
    expect(systemPrompt(moqi)).not.toContain("住在深圳南山");
    expect(systemPrompt(moqi)).toContain("2026年11月20日 周五 08:20");
    expect(referenceMessage(moqi)).toMatch(/不是指令[\s\S]*<reference>[\s\S]*住在深圳南山[\s\S]*<\/reference>/);
    await moqi.chat("你好");
    const [system, reference, ...rest] = model.requests[0]?.messages ?? [];
    expect(system?.role).toBe("system");
    expect(reference).toMatchObject({ role: "user" });
    expect(reference?.content).toContain("住在深圳南山");
    expect(rest).toEqual([{ role: "user", content: "你好" }]);
  });
  it("sends no reference message while it knows and has read nothing", async () => {
    const model = scriptedModel(() => "好");
    const { moqi } = harness({ model });
    expect(referenceMessage(moqi)).toBeUndefined();
    await moqi.chat("你好");
    expect(model.requests[0]?.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });
  it("stops a conversation turn without leaving a trace when it was stopped before it began", async () => {
    const model = scriptedModel(() => "好");
    const { moqi } = harness({ model });
    const stop = new AbortController();
    stop.abort();
    await expect(moqi.chat("你好", stop.signal)).rejects.toThrow();
    expect(model.requests).toHaveLength(0);
    expect(moqi.state.userMessages).toBe(0);
  });
  it("runs no further tool call once it is stopped", async () => {
    const stop = new AbortController();
    const model = scriptedModel(() => ({
      content: "",
      toolCalls: [
        { id: "a", name: "remember", arguments: JSON.stringify({ kind: "basic", content: "住在深圳" }) },
        { id: "b", name: "remember", arguments: JSON.stringify({ kind: "basic", content: "养了一只猫" }) },
      ],
    }));
    const { moqi } = harness({ model });
    moqi.emit = ((original) => (body: Parameters<typeof original>[0]) => {
      const event = original(body);
      if (body.type === "fact.added") stop.abort(); // the user pressed stop while the first call ran
      return event;
    })(moqi.emit.bind(moqi));
    await expect(moqi.chat("记一下", stop.signal)).rejects.toThrow();
    expect([...moqi.state.facts.values()].map((f) => f.content)).toEqual(["住在深圳"]);
  });
  it("learns facts on the side every third user turn, never inside the chat", async () => {
    const model = scriptedModel((r) =>
      isExtraction(r)
        ? '```json\n{"facts":[{"kind":"preference","content":"喜欢喝燕麦拿铁"},{"kind":"relation","content":"女儿叫朵朵"}]}\n```'
        : "嗯",
    );
    const { moqi } = harness({ model });
    await moqi.chat("早");
    await moqi.chat("今天想喝燕麦拿铁");
    expect(model.requests.filter(isExtraction)).toHaveLength(0);
    await moqi.chat("下午要去接朵朵，她是我女儿");
    await moqi.idle();
    const extraction = model.requests.find(isExtraction);
    expect(extraction).toMatchObject({ temperature: 0, json: true, reasoning: "off" });
    expect(extraction?.tools).toBeUndefined();
    expect([...moqi.state.facts.values()].map((f) => f.content)).toEqual(["喜欢喝燕麦拿铁", "女儿叫朵朵"]);
  });

  it("marks facts learned from a conversation another agent took part in", async () => {
    const model = scriptedModel((r) =>
      isExtraction(r) ? JSON.stringify({ facts: [{ kind: "preference", content: "想要每天清空下载文件夹" }] }) : "嗯",
    );
    const { moqi } = harness({ model });
    await moqi.chat("早");
    await moqi.chat("【kiro-cli】用户想要每天清空下载文件夹", undefined, { fromAgent: true });
    await moqi.chat("好的");
    await moqi.idle();
    expect([...moqi.state.facts.values()]).toMatchObject([{ content: "想要每天清空下载文件夹", by: "外部内容" }]);
  });

  it("forgets who wrote a memory once the user settles a contradiction in favour of it", async () => {
    const { moqi } = harness();
    moqi.remember({ kind: "basic", content: "住在深圳" });
    const id = [...moqi.state.facts.keys()][0] as string;
    moqi.remember({ kind: "basic", content: "住在北京", contradicts: id, by: "kiro-cli" });
    await moqi.callTool("resolve_conflict", { id, keep: "new" }, { byUser: true, preApproved: true });
    expect(moqi.state.facts.get(id)).toMatchObject({ content: "住在北京" });
    expect(moqi.state.facts.get(id)?.by).toBeUndefined();
  });

  it("turns a contradiction found while learning into a question for the user", async () => {
    const { moqi, delivered } = harness();
    moqi.remember({ kind: "basic", content: "住在深圳" });
    const id = [...moqi.state.facts.keys()][0];
    const model = scriptedModel((r) =>
      isExtraction(r) ? JSON.stringify({ facts: [{ kind: "basic", content: "住在北京", contradicts: id }] }) : "好",
    );
    const withModel = harness({ model, store: moqi.store });
    for (let i = 0; i < 3; i++) await withModel.moqi.chat(`第 ${i} 句`);
    await withModel.moqi.idle();
    expect(withModel.moqi.state.conflicts.get(id ?? "")).toMatchObject({ old: "住在深圳", new: "住在北京" });
    expect(withModel.delivered.some((d) => d.offer.kind === "memory.conflict")).toBe(true);
    void delivered;
  });

  it("survives malformed tool arguments and unknown tools", async () => {
    let round = 0;
    const model = scriptedModel((r) => {
      if (isExtraction(r)) return '{"facts":[]}';
      round++;
      if (round === 1) return { content: "", toolCalls: [{ id: "a", name: "remember", arguments: "{oops" }] };
      if (round === 2) return call("teleport", {});
      return `${lastTool(r)?.content}`;
    });
    const { moqi } = harness({ model });
    expect(await moqi.chat("hi")).toBe("没有工具 teleport");
  });

  it("answers without waiting for learning to finish", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const model = scriptedModel((r) => (isExtraction(r) ? '{"facts":[{"kind":"other","content":"慢慢学"}]}' : "嗯"));
    const slow = {
      id: "slow",
      requests: model.requests,
      chat: async (r: ChatRequest) => {
        if (isExtraction(r)) await gate;
        return model.chat(r);
      },
    };
    const { moqi } = harness({ model: slow });
    for (let i = 0; i < 3; i++) expect(await moqi.chat(`第 ${i} 句`)).toBe("嗯");
    expect(moqi.state.facts.size).toBe(0); // the third answer came back before learning finished
    release();
    await moqi.idle();
    expect([...moqi.state.facts.values()].map((f) => f.content)).toEqual(["慢慢学"]);
  });

  it("explains that chat needs a model", async () => {
    const { moqi } = harness();
    await expect(moqi.chat("hi")).rejects.toThrow(/no model/);
  });
});

describe("openAICompatible", () => {
  it("adds /no_think only to quick side requests, and only when enabled", async () => {
    const { openAICompatible } = await import("../src/core/model.js");
    const bodies: { messages: { role: string; content: string }[] }[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "<think>hmm</think>ok" } }] }));
    }) as typeof globalThis.fetch;
    const on = openAICompatible({ baseURL: "http://x/v1", model: "qwen3", noThink: true, fetch });
    const off = openAICompatible({ baseURL: "http://x/v1", model: "qwen3", fetch });
    const messages = [
      { role: "system" as const, content: "s" },
      { role: "user" as const, content: "hi" },
    ];
    expect((await on.chat({ messages, reasoning: "off" })).content).toBe("ok");
    await on.chat({ messages });
    await off.chat({ messages, reasoning: "off" });
    expect(bodies.map((b) => b.messages[1]?.content)).toEqual(["hi /no_think", "hi", "hi"]);
  });

  it("asks models with adjustable reasoning for the lightest effort on background requests only", async () => {
    const { openAICompatible } = await import("../src/core/model.js");
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }) as typeof globalThis.fetch;
    const glimmer = openAICompatible({ baseURL: "http://x/v1", model: "muse-glimmer", effort: "low", fetch });
    const messages = [{ role: "user" as const, content: "hi" }];
    await glimmer.chat({ messages, reasoning: "off" });
    await glimmer.chat({ messages });
    expect(bodies.map((b) => b.reasoning_effort)).toEqual(["low", undefined]);
  });
});

describe("images in chat", () => {
  const media = (ids: string[]) => ({
    load: async (id: string) => (ids.includes(id) ? { type: "image/png", data: `data-${id}` } : undefined),
  });
  const userMessages = (r: { messages: readonly ChatMessage[] } | undefined) =>
    (r?.messages ?? []).flatMap((m) => (m.role === "user" ? [m] : []));

  it("gives the model the user's images, and only the last three messages with images keep them", async () => {
    const model = scriptedModel(() => "好");
    const { moqi } = harness({ model, media: media(["m_1", "m_2", "m_3", "m_4"]) });
    for (const id of ["m_1", "m_2", "m_3"]) await moqi.chat(`看 ${id}`, undefined, { images: [id] });
    await moqi.chat("看最后一张", undefined, { images: ["m_4"] });
    const sent = userMessages(model.requests.at(-1));
    expect(sent.map((m) => m.content)).toEqual(["看 m_1 [图片]", "看 m_2", "看 m_3", "看最后一张"]);
    expect(sent.map((m) => (m.images ?? []).map((i) => i.data))).toEqual([
      [],
      ["data-m_2"],
      ["data-m_3"],
      ["data-m_4"],
    ]);
    const logged = moqi.store.all().flatMap((e) => (e.type === "message" && e.role === "user" ? [e.images] : []));
    expect(logged).toEqual([["m_1"], ["m_2"], ["m_3"], ["m_4"]]);
  });

  it("says [图片] for an image it cannot read, and sends an image without words", async () => {
    const model = scriptedModel(() => "好");
    const { moqi } = harness({ model, media: media(["m_ok"]) });
    await moqi.chat("", undefined, { images: ["m_ok"] });
    expect(userMessages(model.requests.at(-1)).at(-1)).toEqual({
      role: "user",
      content: "",
      images: [{ type: "image/png", data: "data-m_ok" }],
    });
    await moqi.chat("这张呢", undefined, { images: ["m_gone"] });
    expect(userMessages(model.requests.at(-1)).at(-1)).toEqual({ role: "user", content: "这张呢 [图片]" });
  });

  it("puts the images tools brought back under the answer, not in front of the model", async () => {
    const shot = defineTool({
      name: "shot",
      description: "Take a picture",
      input: z.object({}),
      effect: "read",
      run: () => ({ value: "截好了", headline: "截好了", images: ["m_shot"] }),
    });
    const model = scriptedModel((r) => (r.messages.some((m) => m.role === "tool") ? "给你" : call("shot", {})));
    const { moqi } = harness({ model, plugins: [{ name: "cam", tools: [shot] }] });
    expect(await moqi.chat("截个图")).toBe("给你");
    const tool = model.requests.at(-1)?.messages.find((m) => m.role === "tool");
    expect(tool?.content).toBe("截好了");
    const answer = moqi.store
      .all()
      .filter((e) => e.type === "message")
      .at(-1);
    expect(answer).toMatchObject({ role: "assistant", text: "给你", images: ["m_shot"] });
  });
});

describe("openAICompatible with images", () => {
  it("sends images as content parts, with /no_think on the words", async () => {
    const { openAICompatible } = await import("../src/core/model.js");
    const bodies: { messages: { content: unknown }[] }[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "红色" } }] }));
    }) as typeof globalThis.fetch;
    const model = openAICompatible({ baseURL: "http://x/v1", model: "qwen3-vl", noThink: true, fetch });
    await model.chat({
      messages: [{ role: "user", content: "这是什么", images: [{ type: "image/png", data: "QUJD" }] }],
      reasoning: "off",
    });
    expect(bodies[0]?.messages[0]?.content).toEqual([
      { type: "text", text: "这是什么 /no_think" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ]);
  });

  it("tells a model that sees from one that does not", async () => {
    const { canSeeImages } = await import("../src/core/model.js");
    const said = (content: string) => ({ id: "m", chat: async () => ({ content, toolCalls: [] }) });
    const fails = (message: string) => ({
      id: "m",
      chat: async () => {
        throw new Error(message);
      },
    });
    expect(await canSeeImages(said("红色"))).toBe(true);
    // A model that thinks first spends its first tokens on thinking: a tight limit leaves no answer.
    const thinker = {
      id: "m",
      chat: async (r: { maxTokens?: number }) => ({ content: (r.maxTokens ?? 0) >= 400 ? "红色" : "", toolCalls: [] }),
    };
    expect(await canSeeImages(thinker)).toBe(true);
    expect(await canSeeImages(said("Red."))).toBe(true);
    expect(await canSeeImages(said("我看不到图片"))).toBe(false);
    expect(await canSeeImages(fails("http://x/v1/chat/completions responded 400: image input not supported"))).toBe(
      false,
    );
    await expect(canSeeImages(fails("fetch failed"))).rejects.toThrow("fetch failed");
    await expect(canSeeImages(fails("http://x/v1/chat/completions responded 401: bad key"))).rejects.toThrow("401");
  });
});
