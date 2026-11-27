import { isTaugraphError, type TraceEvent } from "taugraph";
import type { ChatMessage, LLMRequest, LLMResponse } from "taugraph/nodes";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AGENT, systemPrompt } from "../src/core/agent.js";
import { defineTool } from "../src/core/plugin.js";
import { call, harness, scriptedModel, words } from "./helpers.js";

const isExtraction = (r: LLMRequest) => words(r.messages[0]).includes("从对话里摘出用户亲口说的");
const lastTool = (r: LLMRequest) => [...r.messages].reverse().find((m) => m.role === "tool");
// The tool-call markup DeepSeek wrote into an answer when its last call had no tools (the bar is U+FF5C).
const DSML = [
  "<｜｜DSML｜｜ calls>",
  '<｜｜DSML｜｜ invoke name="browser__browser_evaluate">',
  '<｜｜DSML｜｜ parameter name="function" string="true">() => document.body.innerText...</｜｜DSML｜｜ parameter>',
  "</｜｜DSML｜｜ invoke>",
  "</｜｜DSML｜｜ calls>",
].join("\n");

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

  it("puts what it knows about the user into the system prompt", () => {
    const { moqi } = harness();
    moqi.remember({ kind: "relation", content: "女儿叫朵朵" });
    expect(systemPrompt(moqi)).toMatch(/女儿叫朵朵[\s\S]*做事的方式/);
    expect(systemPrompt(moqi)).toContain("2026年11月20日 周五 08:20");
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
    expect(extraction).toMatchObject({ temperature: 0, responseFormat: "json", reasoning: "off" });
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
    const replies: string[] = [];
    const model = scriptedModel((r) => {
      if (isExtraction(r)) return '{"facts":[]}';
      round++;
      if (round === 1) {
        return {
          content: "",
          toolCalls: [{ id: "a", name: "remember", arguments: {}, parseError: "arguments are not valid JSON" }],
        };
      }
      replies.push(words(lastTool(r)));
      if (round === 2) return call("teleport", {});
      return words(lastTool(r));
    });
    const { moqi } = harness({ model });
    expect(await moqi.chat("hi")).toBe('No tool named "teleport"');
    expect(replies).toEqual(["Invalid arguments: arguments are not valid JSON", 'No tool named "teleport"']);
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
      complete: async (r: LLMRequest, options: { signal: AbortSignal }) => {
        if (isExtraction(r)) await gate;
        return model.complete(r, options);
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
  const signal = new AbortController().signal;
  const recording = (content = "ok") => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    }) as typeof globalThis.fetch;
    return { bodies, fetch };
  };
  const userText = (body: Record<string, unknown> | undefined) =>
    (body?.messages as { content: unknown }[] | undefined)?.[1]?.content;

  it("adds /no_think only to quick side requests, only when enabled, and drops <think>", async () => {
    const { openAICompatible } = await import("../src/core/model.js");
    const { bodies, fetch } = recording("<think>hmm</think>ok");
    const on = openAICompatible({ baseURL: "http://x/v1", model: "qwen3", noThink: true, fetch });
    const off = openAICompatible({ baseURL: "http://x/v1", model: "qwen3", fetch });
    const messages = [
      { role: "system" as const, content: "s" },
      { role: "user" as const, content: "hi" },
    ];
    expect((await on.complete({ messages, reasoning: "off" }, { signal })).content).toBe("ok");
    await on.complete({ messages }, { signal });
    await off.complete({ messages, reasoning: "off" }, { signal });
    expect(bodies.map(userText)).toEqual(["hi /no_think", "hi", "hi"]);
    expect(on.id).toBe("openai-compatible:qwen3");
  });

  it("asks for the lightest effort on background requests only, and sends no effort when none is set", async () => {
    const { openAICompatible } = await import("../src/core/model.js");
    const { bodies, fetch } = recording();
    const glimmer = openAICompatible({ baseURL: "http://x/v1", model: "muse-glimmer", effort: "low", fetch });
    const plain = openAICompatible({ baseURL: "http://x/v1", model: "qwen3", fetch });
    const messages = [{ role: "user" as const, content: "hi" }];
    await glimmer.complete({ messages, reasoning: "off" }, { signal });
    await glimmer.complete({ messages }, { signal });
    await plain.complete({ messages, reasoning: "off" }, { signal });
    expect(bodies.map((b) => b.reasoning_effort)).toEqual(["low", undefined, undefined]);
    expect(bodies[2]).not.toHaveProperty("reasoning_effort");
  });

  it("sends images as content parts, with /no_think on the words", async () => {
    const { openAICompatible } = await import("../src/core/model.js");
    const { bodies, fetch } = recording("红色");
    const model = openAICompatible({ baseURL: "http://x/v1", model: "qwen3-vl", noThink: true, fetch });
    await model.complete(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "这是什么" },
              { type: "image", data: "QUJD", mimeType: "image/png" },
            ],
          },
        ],
        reasoning: "off",
      },
      { signal },
    );
    expect((bodies[0]?.messages as { content: unknown }[] | undefined)?.[0]?.content).toEqual([
      { type: "text", text: "这是什么 /no_think" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ]);
  });

  it("puts /no_think after an image that came without words", async () => {
    const { openAICompatible } = await import("../src/core/model.js");
    const { bodies, fetch } = recording();
    const model = openAICompatible({ baseURL: "http://x/v1", model: "qwen3-vl", noThink: true, fetch });
    await model.complete(
      {
        messages: [{ role: "user", content: [{ type: "image", data: "QUJD", mimeType: "image/png" }] }],
        reasoning: "off",
      },
      { signal },
    );
    expect((bodies[0]?.messages as { content: unknown }[] | undefined)?.[0]?.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
      { type: "text", text: "/no_think" },
    ]);
  });

  it("tells a model that sees from one that does not, by the status of a refusal", async () => {
    const { canSeeImages } = await import("../src/core/model.js");
    const said = (content: string) => ({ id: "m", complete: async () => ({ content }) });
    const fails = (error: unknown) => ({
      id: "m",
      complete: async () => {
        throw error;
      },
    });
    const refused = (status: number) => Object.assign(new Error(`responded ${status}`), { status });
    expect(await canSeeImages(said("红色"))).toBe(true);
    // A model that thinks first spends its first tokens on thinking: a tight limit leaves no answer.
    const thinker = {
      id: "m",
      complete: async (r: LLMRequest) => ({ content: (r.maxTokens ?? 0) >= 400 ? "红色" : "" }),
    };
    expect(await canSeeImages(thinker)).toBe(true);
    expect(await canSeeImages(said("Red."))).toBe(true);
    expect(await canSeeImages(said("我看不到图片"))).toBe(false);
    for (const status of [400, 413, 415, 422]) expect(await canSeeImages(fails(refused(status)))).toBe(false);
    expect(await canSeeImages(fails(new Error("wrapped", { cause: refused(415) })))).toBe(false);
    await expect(canSeeImages(fails(new Error("fetch failed")))).rejects.toThrow("fetch failed");
    await expect(canSeeImages(fails(refused(401)))).rejects.toThrow("401");
  });

  it("sends a tool loop in OpenAI's format, with the model's own reasoning unless sendReasoning is false", async () => {
    const { openAICompatible } = await import("../src/core/model.js");
    const args = { kind: "basic", content: "住在深圳" };
    const loop = async (sendReasoning?: boolean) => {
      const bodies: Record<string, unknown>[] = [];
      const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        const message =
          bodies.length === 1
            ? {
                content: null,
                reasoning_content: "think",
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "remember", arguments: JSON.stringify(args) } },
                ],
              }
            : { content: "记住了" };
        return new Response(JSON.stringify({ choices: [{ message }] }));
      }) as typeof globalThis.fetch;
      const model = openAICompatible({
        baseURL: "http://x/v1",
        model: "deepseek-v4",
        fetch,
        ...(sendReasoning !== undefined && { sendReasoning }),
      });
      const { moqi } = harness({ model });
      expect(await moqi.chat("我住在深圳")).toBe("记住了");
      const messages = (bodies[1]?.messages ?? []) as Record<string, unknown>[];
      const assistant = messages.find((m) => m.role === "assistant");
      const calls = assistant?.tool_calls as { function: { arguments: unknown } }[] | undefined;
      expect(typeof calls?.[0]?.function.arguments).toBe("string");
      expect(JSON.parse(String(calls?.[0]?.function.arguments))).toEqual(args);
      expect(messages.find((m) => m.role === "tool")).toMatchObject({ tool_call_id: "c1" });
      expect(assistant?.content).toBeNull();
      return assistant;
    };
    expect(await loop()).toMatchObject({ reasoning_content: "think" });
    expect(await loop(false)).not.toHaveProperty("reasoning_content");
  });

  it("drops tool-call markup a model writes as text", async () => {
    const { openAICompatible } = await import("../src/core/model.js");
    const replies = [
      DSML,
      `前面的话\n${DSML}`,
      "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>x\n```json\n{}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>",
      '答案\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="x">',
    ];
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const content = replies[bodies.length - 1];
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    }) as typeof globalThis.fetch;
    const model = openAICompatible({ baseURL: "http://x/v1", model: "deepseek-flash", fetch });
    const messages = [{ role: "user" as const, content: "查" }];
    const contents: string[] = [];
    for (const _ of replies) contents.push((await model.complete({ messages }, { signal })).content);
    expect(contents).toEqual(["", "前面的话", "", "答案"]);
  });
});

describe("withMedia", () => {
  it("reads media: references when a request is sent, and leaves the request it was given as it was", async () => {
    const { withMedia } = await import("../src/core/model.js");
    const inner = scriptedModel(() => "好");
    const model = withMedia(inner, async (id) => (id === "m_1" ? { type: "image/png", data: "QUJD" } : undefined));
    const request: LLMRequest = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "看" },
            { type: "image", url: "media:m_1" },
            { type: "image", url: "https://example.com/a.png" },
          ],
        },
      ],
    };
    await model.complete(request, { signal: new AbortController().signal });
    expect(inner.requests[0]?.messages[0]?.content).toEqual([
      { type: "text", text: "看" },
      { type: "image", data: "QUJD", mimeType: "image/png" },
      { type: "image", url: "https://example.com/a.png" },
    ]);
    expect(request.messages[0]?.content).toContainEqual({ type: "image", url: "media:m_1" });
    expect(model.id).toBe("scripted");
    await expect(
      model.complete(
        { messages: [{ role: "user", content: [{ type: "image", url: "media:m_gone" }] }] },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("Image media:m_gone is gone");
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
    expect(sent.map(words)).toEqual(["看 m_1 [图片]", "看 m_2", "看 m_3", "看最后一张"]);
    const imagesOf = (m: ChatMessage) =>
      typeof m.content === "string"
        ? []
        : m.content.flatMap((p) => (p.type === "image" && "data" in p ? [p.data] : []));
    expect(sent.map(imagesOf)).toEqual([[], ["data-m_2"], ["data-m_3"], ["data-m_4"]]);
    const logged = moqi.store.all().flatMap((e) => (e.type === "message" && e.role === "user" ? [e.images] : []));
    expect(logged).toEqual([["m_1"], ["m_2"], ["m_3"], ["m_4"]]);
  });

  it("says [图片] for an image it cannot read, and sends an image without words", async () => {
    const model = scriptedModel(() => "好");
    const { moqi } = harness({ model, media: media(["m_ok"]) });
    await moqi.chat("", undefined, { images: ["m_ok"] });
    expect(userMessages(model.requests.at(-1)).at(-1)).toEqual({
      role: "user",
      content: [{ type: "image", data: "data-m_ok", mimeType: "image/png" }],
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

describe("a turn as a taugraph run", () => {
  it("hands every event to onTrace and links the answer to its run", async () => {
    const events: TraceEvent[] = [];
    const model = scriptedModel((r) => {
      if (isExtraction(r)) return '{"facts":[]}';
      if (!lastTool(r)) return call("remember", { kind: "basic", content: "住在深圳南山" });
      if (words(lastTool(r)).startsWith("记住了")) return call("list_memories", {});
      return "好的";
    });
    const { moqi } = harness({ model, onTrace: (e) => events.push(e) });
    expect(await moqi.chat("我住在深圳南山")).toBe("好的");
    const answer = moqi.store
      .all()
      .filter((e) => e.type === "message")
      .at(-1);
    const runId = events[0]?.runId;
    expect(answer).toMatchObject({ role: "assistant", text: "好的", run: runId });
    expect(events.at(-1)).toMatchObject({ type: "run_end", meta: { status: "completed" } });
    expect(events.filter((e) => e.type === "llm_call")).toHaveLength(3);
    const tools = events.filter((e) => e.type === "tool_call");
    expect(tools.map((e) => [e.nodeId, (e.input as { name: string }).name])).toEqual([
      ["act_write", "remember"],
      ["act", "list_memories"],
    ]);
    expect(events.every((e) => e.runId === runId)).toBe(true);
  });

  it("asks for words, not tools, on the last call after six rounds of tools", async () => {
    const model = scriptedModel((r) => {
      if (isExtraction(r)) return '{"facts":[]}';
      return r.toolChoice !== "none" ? call("list_memories", {}) : "说完了";
    });
    const { moqi } = harness({ model });
    expect(await moqi.chat("查一下")).toBe("说完了");
    const turn = model.requests.filter((r) => !isExtraction(r));
    expect(turn).toHaveLength(7);
    expect(turn.slice(0, 6).every((r) => (r.tools?.length ?? 0) > 0 && r.toolChoice === undefined)).toBe(true);
    expect(turn[6]?.tools?.length ?? 0).toBeGreaterThan(0);
    expect(turn[6]?.toolChoice).toBe("none");
    expect(turn[6]?.messages.at(-1)).toEqual({ role: "user", content: AGENT.lastRoundNote });
    const stored = moqi.store.all().flatMap((e) => (e.type === "message" ? [e.text] : []));
    expect(stored).not.toContain(AGENT.lastRoundNote);
  });

  it("falls back when the last answer was only tool-call markup", async () => {
    const { openAICompatible } = await import("../src/core/model.js");
    let n = 0;
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tool_choice?: unknown };
      const message =
        body.tool_choice === "none"
          ? { content: DSML }
          : {
              content: null,
              tool_calls: [{ id: `c${++n}`, type: "function", function: { name: "list_memories", arguments: "{}" } }],
            };
      return new Response(JSON.stringify({ choices: [{ message }] }));
    }) as typeof globalThis.fetch;
    const { moqi } = harness({ model: openAICompatible({ baseURL: "http://x/v1", model: "deepseek-flash", fetch }) });
    expect(await moqi.chat("查")).toBe("（我这次没想好怎么回答，换个说法再试试？）");
  });

  it("answers even when the trace cannot be stored", async () => {
    const model = scriptedModel((r) => (isExtraction(r) ? '{"facts":[]}' : "嗯"));
    const { moqi } = harness({
      model,
      onTrace: () => {
        throw new Error("disk full");
      },
    });
    expect(await moqi.chat("hi")).toBe("嗯");
  });

  it("throws the model's own error", async () => {
    const boom = new Error("http://x/v1/chat/completions responded 500: down");
    const model = {
      id: "m",
      complete: async () => {
        throw boom;
      },
    };
    const { moqi } = harness({ model });
    await expect(moqi.chat("hi")).rejects.toBe(boom);
  });

  it("answers when an async onTrace rejects, leaving no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const model = scriptedModel((r) => (isExtraction(r) ? '{"facts":[]}' : "嗯"));
      const { moqi } = harness({
        model,
        onTrace: async () => {
          throw new Error("db down");
        },
      });
      expect(await moqi.chat("hi")).toBe("嗯");
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("fails the turn with the error a tool call threw", async () => {
    const crash = new Error("confirm UI crashed");
    const model = scriptedModel((r) => {
      if (isExtraction(r)) return '{"facts":[]}';
      if (lastTool(r)) return "又试了一次";
      return call("watch_create", { title: "早点睡", schedule: { every: "day", at: "22:00" }, remind: "该睡了" });
    });
    const { moqi } = harness({
      model,
      confirm: async () => {
        throw crash;
      },
    });
    await expect(moqi.chat("每晚十点提醒我睡觉")).rejects.toBe(crash);
    expect(model.requests.filter((r) => !isExtraction(r))).toHaveLength(1);
  });

  it("an aborted turn throws ABORTED", async () => {
    const model = {
      id: "m",
      complete: (_r: LLMRequest, { signal }: { signal: AbortSignal }) =>
        new Promise<LLMResponse>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    };
    const { moqi } = harness({ model });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const error = await moqi.chat("hi", controller.signal).catch((e: unknown) => e);
    expect(isTaugraphError(error)).toBe(true);
    expect((error as { code?: unknown }).code).toBe("ABORTED");
  });
});
