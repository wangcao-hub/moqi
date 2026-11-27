# moqi: the conversation on taugraph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** moqi uses taugraph's model contract and `taugraph/openai`, runs every conversation turn as a `taugraph/agent` run, and stores the trace of every turn and every watch under the home's `runs/`.

**Architecture:** `src/core/model.ts` shrinks to a wrapper around `taugraph/openai` (moqi's `noThink` / `effort` switches, `<think>` stripping), a `complete` helper for side requests, `withMedia` (reads `media:<id>` image references when a request is sent) and the image check. `chatTurn` builds one `createAgent` per turn whose tools call `moqi.callTool`, so every rule there stays. `MoqiOptions.onTrace` receives the events of every agent and watch run; the home passes a `taugraph/file` store and prunes it after 30 days.

**Tech Stack:** TypeScript (NodeNext, strict, `noUncheckedIndexedAccess`), vitest (`TZ=Asia/Shanghai`), Zod, biome; taugraph `^0.4.1` (`taugraph`, `taugraph/nodes`, `taugraph/agent`, `taugraph/openai` in the core; `taugraph/file` in `src/node` only).

Spec: `docs/superpowers/specs/2026-11-26-taugraph-agent-design.md` (committed as 9f1f4f8).

## Global Constraints

- Prerequisite: taugraph 0.4.1 is published on npm (it adds `createAgent({ lastRound })` and `FileStore.remove`). Task 1 depends on `taugraph@^0.4.1`.
- `src/core` and `src/plugins` stay portable: no Node built-ins, no `process.`, `Buffer`, `require(`, `__dirname`, `crypto.randomUUID`. The core may import `taugraph`, `taugraph/nodes`, `taugraph/agent`, `taugraph/openai` and `zod`; `taugraph/file` only in `src/node`. Runtime dependencies stay exactly `taugraph` and `zod`.
- Behavior stays the same unless the spec says otherwise: tool rules in `callTool` (validation, trust levels, confirmations, tainting, sites, images, events, promotions), history (last 12 messages, images on the last 3 user messages that had them, "[图片]" for missing ones), the fallback answer, background learning, `noThink` / `effort` / `<think>` stripping, and the model id `openai-compatible:<model>`.
- Differences the spec accepts: the agent answers bad JSON arguments with `Invalid arguments: arguments are not valid JSON` and unknown tools with `No tool named "<name>"`; at most 32 tool calls run per reply; the model can no longer call hidden tools; after 6 tool rounds the 7th call goes without tools (`lastRound: "answer"`).
- Texts, verbatim: `Image media:<id> is gone`; fallback answer `（我这次没想好怎么回答，换个说法再试试？）`; trace store warning `moqi：运行记录存不进 <dir>（<reason>），之后不再提示`.
- Retention: traces of runs whose `updatedAt` is more than 30 days old and whose status is `completed`, `failed` or `interrupted` are removed; `running` and `paused` are kept.
- moqi's own user-facing text stays Chinese; code comments in English.
- `pnpm check` (typecheck, biome, build, `TZ=Asia/Shanghai vitest run`) must pass after every task; `pnpm format` fixes formatting.
- Work on branch `feat/taugraph-agent` (spec commit 9f1f4f8).

---

### Task 1: The model layer on taugraph

Behavior does not change in this task; the hand-written loop in `agent.ts` stays and only adopts the new contract. Task 2 replaces the loop.

**Files:**

- Modify: `package.json`, `pnpm-lock.yaml` (`taugraph@^0.4.1`)
- Rewrite: `src/core/model.ts`
- Modify: `src/core/plugin.ts` (own `ToolSpec`), `src/core/moqi.ts` (model type, `withMedia`, `MediaImage`), `src/core/agent.ts` (history parts, loop on `LLMModel`), `src/core/learn.ts`, `src/core/reflect.ts`, `src/core/study.ts` (call sites), `src/core/index.ts` (exports), `src/node/console/server.ts` (model test)
- Modify: `test/architecture.test.ts`, `test/helpers.ts`, and every test that uses the old contract (find them with `pnpm typecheck`)
- Test: `test/agent.test.ts` (new and rewritten tests below)

**Interfaces:**

- Produces (moqi public API): `openAICompatible(options: OpenAICompatibleOptions): LLMModel` (options unchanged); `complete(model: LLMModel, request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse>`; `stripThinking(text)`; `type MediaImage = { type: string; data: string }`; `type ToolSpec` now from `plugin.ts` (same shape); `type LLMModel` re-exported from `taugraph/nodes`; `MoqiOptions.model?: LLMModel`.
- Produces (internal, `src/core/model.ts`): `MEDIA = "media:"`; `withMedia(model: LLMModel, load: (id: string) => Promise<MediaImage | undefined>): LLMModel`; `canSeeImages(model: LLMModel, signal?: AbortSignal): Promise<boolean>`.
- Produces (internal, `src/core/agent.ts`): `userMessage(moqi, text, ids, keep): Promise<ChatMessage>` writes kept images as `{ type: "image", url: "media:<id>" }` after the text part. Task 2 reuses `history` and `userMessage` unchanged.
- Removed: `ChatModel`, `ChatRequest`, `ChatReply`, moqi's `ChatMessage`, `ToolCall`, `ImagePart`.

- [ ] **Step 1: Depend on taugraph 0.4.1.**

Run: `pnpm add taugraph@^0.4.1`
Expected: `package.json` has `"taugraph": "^0.4.1"`; `pnpm-lock.yaml` resolves 0.4.1.

- [ ] **Step 2: Write the failing tests.** In `test/agent.test.ts`, replace the whole `describe("openAICompatible", ...)` block and the whole `describe("openAICompatible with images", ...)` block with:

```ts
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
    expect((bodies[0]?.messages as { content: unknown }[])[0]?.content).toEqual([
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
    expect((bodies[0]?.messages as { content: unknown }[])[0]?.content).toEqual([
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
```

and change the imports at the top of `test/agent.test.ts` to:

```ts
import type { ChatMessage, LLMRequest } from "taugraph/nodes";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { systemPrompt } from "../src/core/agent.js";
import { defineTool } from "../src/core/plugin.js";
import { call, harness, scriptedModel, words } from "./helpers.js";
```

(`pnpm format` orders them.) In the same file, change `isExtraction` and `lastTool` to:

```ts
const isExtraction = (r: LLMRequest) => words(r.messages[0]).includes("从对话里摘出用户亲口说的");
const lastTool = (r: LLMRequest) => [...r.messages].reverse().find((m) => m.role === "tool");
```

and rewrite the two image tests in `describe("images in chat")`:

```ts
it("gives the model the user's images, and only the last three messages with images keep them", async () => {
  const model = scriptedModel(() => "好");
  const { moqi } = harness({ model, media: media(["m_1", "m_2", "m_3", "m_4"]) });
  for (const id of ["m_1", "m_2", "m_3"]) await moqi.chat(`看 ${id}`, undefined, { images: [id] });
  await moqi.chat("看最后一张", undefined, { images: ["m_4"] });
  const sent = userMessages(model.requests.at(-1));
  expect(sent.map(words)).toEqual(["看 m_1 [图片]", "看 m_2", "看 m_3", "看最后一张"]);
  const imagesOf = (m: ChatMessage) =>
    typeof m.content === "string" ? [] : m.content.flatMap((p) => (p.type === "image" && "data" in p ? [p.data] : []));
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
```

In `test/helpers.ts`, replace the model helpers (`Script`, `scriptedModel`, `call`) and the import from `../src/core/model.js` with:

```ts
import { type ChatMessage, type LLMModel, type LLMRequest, type LLMResponse, textOf } from "taugraph/nodes";

export type Script = (request: LLMRequest) => LLMResponse | string;

export function scriptedModel(script: Script): LLMModel & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    id: "scripted",
    requests,
    async complete(request) {
      requests.push(request);
      const r = script(request);
      return typeof r === "string" ? { content: r } : r;
    },
  };
}

export function call(name: string, args: Record<string, unknown>, id = `c_${name}`): LLMResponse {
  return { content: "", toolCalls: [{ id, name, arguments: args }] };
}

/** The words of a message, images left out. */
export const words = (m: ChatMessage | undefined): string => (m ? textOf(m.content, { imagePlaceholder: "" }) : "");
```

- [ ] **Step 3: Run the new tests to verify they fail.**

Run: `pnpm exec vitest run test/agent.test.ts`
Expected: FAIL (type errors and missing `complete` / `withMedia` exports; the vitest run fails on the import of the new helpers or on `model.complete is not a function`).

- [ ] **Step 4: Rewrite `src/core/model.ts`.** Replace the whole file with:

```ts
// The model contract is taugraph's `LLMModel`. This file adds what moqi needs around it: an OpenAI-compatible
// endpoint with moqi's switches, image references read from moqi's media, side requests, and the image check.
import { type ChatMessage, type LLMModel, type LLMRequest, type LLMResponse, resolveImages } from "taugraph/nodes";
import { openAICompatible as openAIEndpoint } from "taugraph/openai";

/** An image as moqi's media keeps it: its MIME type and its bytes in base64. */
export interface MediaImage {
  readonly type: string;
  readonly data: string;
}

export interface OpenAICompatibleOptions {
  /** e.g. "https://api.deepseek.com/v1" or "http://127.0.0.1:11434/v1" for Ollama. */
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey?: string;
  /** Overrides global fetch, e.g. for tests. */
  readonly fetch?: typeof fetch;
  /**
   * For Qwen3-style models: honour `reasoning: "off"` by appending the "/no_think" switch to the last
   * user message. Without it, small local models can spend the whole token budget thinking.
   */
  readonly noThink?: boolean;
  /**
   * Sent as `reasoning_effort` with `reasoning: "off"` requests, for models with adjustable reasoning
   * strength (Muse Glimmer, gpt-oss): background work then uses the lightest setting.
   */
  readonly effort?: "low" | "medium" | "high";
}

/** OpenAI-compatible /chat/completions through taugraph/openai, with moqi's `noThink` and `effort` switches. */
export function openAICompatible(options: OpenAICompatibleOptions): LLMModel {
  const endpoint = openAIEndpoint({
    baseURL: options.baseURL,
    model: options.model,
    apiKey: options.apiKey,
    fetch: options.fetch,
    // "off" sends nothing unless `effort` is set: some endpoints refuse taugraph's default `reasoning_effort: "none"`.
    reasoningParams: (level) =>
      level === "off" ? (options.effort ? { reasoning_effort: options.effort } : {}) : { reasoning_effort: level },
  });
  return {
    id: endpoint.id,
    async complete(request, { signal }) {
      const sent = options.noThink === true && request.reasoning === "off" ? withNoThink(request) : request;
      const response = await endpoint.complete(sent, { signal });
      return { ...response, content: stripThinking(response.content) };
    },
  };
}

/** Qwen3's switch: " /no_think" after the words of the last user message, or after its images if it has no words. */
function withNoThink(request: LLMRequest): LLMRequest {
  const last = request.messages.map((m) => m.role).lastIndexOf("user");
  return {
    ...request,
    messages: request.messages.map((m, i): ChatMessage => {
      if (i !== last || m.role !== "user") return m;
      if (typeof m.content === "string") return { ...m, content: `${m.content} /no_think` };
      const at = m.content.map((p) => p.type).lastIndexOf("text");
      if (at === -1) return { ...m, content: [...m.content, { type: "text", text: "/no_think" }] };
      return {
        ...m,
        content: m.content.map((p, j) => (j === at && p.type === "text" ? { ...p, text: `${p.text} /no_think` } : p)),
      };
    }),
  };
}

/** Reasoning models (Qwen3, DeepSeek-R1 via some servers) put their thoughts in <think> tags. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

const NEVER = new AbortController().signal;

/** One model call outside a graph: learning, reflection, study, checks. Without a signal nothing cancels it. */
export async function complete(model: LLMModel, request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
  return model.complete(request, { signal: signal ?? NEVER });
}

/** How messages refer to an image in moqi's media: `media:<id>`. */
export const MEDIA = "media:";

/**
 * The model with `media:<id>` image references read through `load` when a request is sent, so requests (and the
 * traces that record them) keep only the reference. Other URLs pass as they are.
 */
export function withMedia(model: LLMModel, load: (id: string) => Promise<MediaImage | undefined>): LLMModel {
  return {
    id: model.id,
    async complete(request, options) {
      const messages = await resolveImages(request.messages, async (url) => {
        if (!url.startsWith(MEDIA)) return { type: "image", url };
        const image = await load(url.slice(MEDIA.length));
        if (!image) throw new Error(`Image ${url} is gone`);
        return { type: "image", data: image.data, mimeType: image.type };
      });
      return model.complete({ ...request, messages }, options);
    },
  };
}

/** A 32×32 solid red PNG: a model that can see says "red". */
const RED_SQUARE =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC";

/** Statuses that mean the endpoint refused the request itself (it cannot take images), not that it failed. */
const REFUSED: ReadonlySet<number> = new Set([400, 413, 415, 422]);

/** The nearest numeric `status` on an error or its `cause` chain, as HTTP errors carry it (taugraph's `HTTPError`). */
function statusOf(error: unknown): number | undefined {
  let current = error;
  for (let depth = 0; depth <= 5 && typeof current === "object" && current !== null; depth++) {
    const status = (current as { status?: unknown }).status;
    if (typeof status === "number") return status;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Whether the model reads images: it is shown a red square and asked its colour. A refusal of the request
 * itself (400, 413, 415, 422) means it cannot; any other failure is not an answer and is thrown. The token
 * limit leaves room for models that think before they answer (deepseek-flash by that name does).
 */
export async function canSeeImages(model: LLMModel, signal?: AbortSignal): Promise<boolean> {
  try {
    const reply = await complete(
      model,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "这张图是什么颜色？只回答颜色。" },
              { type: "image", data: RED_SQUARE, mimeType: "image/png" },
            ],
          },
        ],
        maxTokens: 512,
        reasoning: "off",
      },
      signal,
    );
    return /红|red/i.test(reply.content);
  } catch (error) {
    const status = statusOf(error);
    if (status !== undefined && REFUSED.has(status)) return false;
    throw error;
  }
}
```

- [ ] **Step 5: `ToolSpec` moves to `plugin.ts`.** In `src/core/plugin.ts`, delete `import type { ToolSpec } from "./model.js";` and add, before `export function toolSpec`:

```ts
/** A tool as moqi describes it to the model: its JSON Schema under `parameters`. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the arguments object. */
  readonly parameters: Record<string, unknown>;
}
```

- [ ] **Step 6: `Moqi` holds an `LLMModel` that reads media references.** In `src/core/moqi.ts`:

- Replace `import type { ChatModel, ImagePart } from "./model.js";` with `import { type MediaImage, withMedia } from "./model.js";` and add `import type { LLMModel } from "taugraph/nodes";`.
- `MoqiOptions.model?: ChatModel` becomes `readonly model?: LLMModel;` (same doc comment).
- `MoqiOptions.media` becomes `readonly media?: { load(id: string): Promise<MediaImage | undefined> };`.
- The field `readonly model: ChatModel | undefined;` becomes `readonly model: LLMModel | undefined;`.
- In the constructor, replace `this.model = options.model;` with:

```ts
// Messages refer to images as media:<id>; they are read when a request is sent, so traces keep only the id.
this.model = options.model && withMedia(options.model, (id) => this.loadImage(id));
```

- `loadImage` returns `Promise<MediaImage | undefined>`.

- [ ] **Step 7: The history and the loop on the new contract.** In `src/core/agent.ts`:

Replace the imports with:

```ts
import type { ChatMessage, ContentPart } from "taugraph/nodes";
import { extractFacts, LEARN } from "./learn.js";
import { activeFacts, OUTSIDE, promptSection } from "./memory.js";
import { complete, MEDIA } from "./model.js";
import type { Moqi } from "./moqi.js";
import { toolSpec } from "./plugin.js";
import type { SiteGrant } from "./sites.js";
import { studySection } from "./study.js";
```

Replace `loadImages` and `userMessage` with:

```ts
/** The images of one message that can still be read, and whether any could not. */
async function readable(moqi: Moqi, ids: readonly string[]): Promise<{ found: string[]; missing: boolean }> {
  const loaded = await Promise.all(ids.map((id) => moqi.loadImage(id)));
  const found = ids.filter((_, i) => loaded[i] !== undefined);
  return { found, missing: found.length < ids.length };
}

/** A user message for the model: references to its images when it keeps them, "[图片]" for the ones it does not. */
async function userMessage(moqi: Moqi, text: string, ids: readonly string[], keep: boolean): Promise<ChatMessage> {
  if (ids.length === 0) return { role: "user", content: text };
  if (!keep) return { role: "user", content: withImageMark(text) };
  const { found, missing } = await readable(moqi, ids);
  const said = missing ? withImageMark(text) : text;
  if (found.length === 0) return { role: "user", content: said };
  const parts: ContentPart[] = [
    ...(said ? [{ type: "text" as const, text: said }] : []),
    ...found.map((id) => ({ type: "image" as const, url: `${MEDIA}${id}` })),
  ];
  return { role: "user", content: parts };
}
```

In `chatTurn`, replace `const tools = moqi.visibleTools().map(toolSpec);` with:

```ts
const tools = moqi.visibleTools().map((t) => {
  const spec = toolSpec(t);
  return { name: spec.name, description: spec.description, inputSchema: spec.parameters };
});
```

and replace the whole `for (let round = 0; ...) { ... }` loop with:

```ts
for (let round = 0; round <= AGENT.maxToolRounds; round++) {
  const offer = round < AGENT.maxToolRounds && tools.length > 0;
  const reply = await complete(model, { messages, ...(offer && { tools }), temperature: 0.3 }, signal);
  const calls = reply.toolCalls ?? [];
  if (calls.length === 0) {
    answer = reply.content;
    break;
  }
  messages.push({ role: "assistant", content: reply.content, toolCalls: calls });
  for (const call of calls) {
    if (call.parseError) {
      messages.push({ role: "tool", toolCallId: call.id, content: "参数不是合法的 JSON" });
      continue;
    }
    const result = await moqi.callTool(
      call.name,
      { ...call.arguments },
      { byUser: true, tainted, sites, images: shown },
    );
    const used = moqi.tool(call.name);
    if (used && !used.local) tainted = true;
    messages.push({ role: "tool", toolCallId: call.id, content: result });
  }
}
```

- [ ] **Step 8: Side requests through `complete`.** Each of these becomes `await complete(<model>, { <same fields> }, signal)`, with `json: true` written as `responseFormat: "json"` and the `...(signal && { signal })` line removed:

- `src/core/learn.ts` (`extractFacts`): also change its `model: ChatModel` parameter to `model: LLMModel` (`import type { LLMModel } from "taugraph/nodes";`) and import `complete` from `./model.js`.
- `src/core/reflect.ts` (`moqi.model.chat({...})` in `reflect`).
- `src/core/study.ts` (the three `model.chat({...})` calls).
- `src/node/console/server.ts` (`POST /api/model/test`): `await complete(model, { messages: [{ role: "user", content: "用一句话打个招呼。" }], maxTokens: 1024, reasoning: "off" }, AbortSignal.timeout(60_000))`; change the import to `import { canSeeImages, complete, openAICompatible } from "../../core/model.js";`.

- [ ] **Step 9: Exports.** In `src/core/index.ts`, replace the `export { ... } from "./model.js";` block with:

```ts
export {
  complete,
  type MediaImage,
  type OpenAICompatibleOptions,
  openAICompatible,
  stripThinking,
} from "./model.js";
```

add `type ToolSpec,` to the export list from `./plugin.js`, and add `export type { LLMModel } from "taugraph/nodes";`.

- [ ] **Step 10: The architecture rule.** In `test/architecture.test.ts`, change the core import pattern to `/^(\.\/[\w-]+\.js|taugraph(\/(nodes|agent|openai))?|zod)$/`.

- [ ] **Step 11: Move the remaining tests to the new contract.** Run `pnpm typecheck`; it lists every test that still uses the old shapes (expected: `agent.test.ts`, `reflect.test.ts`, `study.test.ts`, `console.test.ts`, `sites.test.ts`, `safety.test.ts`, `todo.test.ts`, `interop.test.ts`, `a2a.test.ts`, `mac.test.ts`). Apply these rules and nothing else:

| Old                                                                                 | New                                                                                                                                                      |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import type { ChatRequest, ... } from "../src/core/model.js"`                      | `import type { LLMRequest, ... } from "taugraph/nodes"` (`ChatRequest` → `LLMRequest`, `ChatReply` → `LLMResponse`, `ChatMessage` from `taugraph/nodes`) |
| a request's `json: true` (in `toMatchObject` and scripts)                           | `responseFormat: "json"`                                                                                                                                 |
| `m.content.includes(...)` / `m.content.startsWith(...)` on a message from a request | `words(m).includes(...)` (helper from `./helpers.js`)                                                                                                    |
| a tool call with string arguments, e.g. `arguments: "{oops"`                        | `arguments: {}, parseError: "arguments are not valid JSON"`; valid JSON strings become objects                                                           |
| a hand-written model `{ id, chat: async (r) => ({ content, toolCalls: [] }) }`      | `{ id, complete: async (r) => ({ content }) }` (wrapping another scripted model: call its `complete`)                                                    |
| `m.images` on a request's user message                                              | the message's image parts (`{ type: "image", data, mimeType }` after `withMedia`)                                                                        |
| a request's tool `t.parameters`                                                     | `t.inputSchema`                                                                                                                                          |

Tests that drive an OpenAI-compatible endpoint through a fake `fetch` (console, a2a) keep their wire-format assertions; if one fails, compare the body taugraph/openai sends with the old one and report the difference instead of loosening the assertion.

- [ ] **Step 12: Run the tests.**

Run: `pnpm format && pnpm check`
Expected: PASS, the same number of tests as before plus the new ones, output pristine.

- [ ] **Step 13: Commit.**

```bash
git add -A src test package.json pnpm-lock.yaml
git commit -m "refactor(model): taugraph's LLMModel and taugraph/openai instead of moqi's own contract"
```

---

### Task 2: Each conversation turn is a taugraph agent run

**Files:**

- Modify: `src/core/agent.ts` (`chatTurn` on `createAgent`)
- Modify: `src/core/moqi.ts` (`MoqiOptions.onTrace`, `Moqi.onTrace`)
- Modify: `src/core/types.ts` (`run` on `message` events)
- Test: `test/agent.test.ts`

**Interfaces:**

- Consumes: `userMessage`, `history`, `systemPrompt`, `toolSpec`, `moqi.callTool`, `moqi.model` (wrapped by `withMedia`) from Task 1; taugraph 0.4.1 `createAgent({ lastRound: "answer" })`.
- Produces (public): `MoqiOptions.onTrace?: (event: TraceEvent) => void`; `Moqi.onTrace: ((event: TraceEvent) => void) | undefined` (the option wrapped so it never throws); `message` events may carry `run?: string`.
- Produces (internal): the runId of a turn is `newId("run", moqi.clock)`; Task 3 uses the same for watches.

- [ ] **Step 1: Write the failing tests.** In `test/agent.test.ts`, inside `describe("conversation")`, replace the test "survives malformed tool arguments and unknown tools" with:

```ts
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
  expect(replies).toEqual(["Invalid arguments: arguments are not valid JSON"]);
});
```

and append a new block at the end of the file:

```ts
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

  it("gives the model one last call without tools after six rounds of tools", async () => {
    const model = scriptedModel((r) => {
      if (isExtraction(r)) return '{"facts":[]}';
      return r.tools ? call("list_memories", {}) : "说完了";
    });
    const { moqi } = harness({ model });
    expect(await moqi.chat("查一下")).toBe("说完了");
    const turn = model.requests.filter((r) => !isExtraction(r));
    expect(turn).toHaveLength(7);
    expect(turn.slice(0, 6).every((r) => (r.tools?.length ?? 0) > 0)).toBe(true);
    expect(turn[6]).not.toHaveProperty("tools");
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
});
```

Add `import type { TraceEvent } from "taugraph";` to the imports.

- [ ] **Step 2: Run them to verify they fail.**

Run: `pnpm exec vitest run test/agent.test.ts`
Expected: FAIL: `onTrace` is not an option (type error, and no events arrive), the unknown tool still answers `没有工具 teleport`, and the answer has no `run`. "gives the model one last call without tools" may already pass with Task 1's loop; it guards that behavior across the switch.

- [ ] **Step 3: The `run` field and the `onTrace` option.** In `src/core/types.ts`, change the `message` member of the event union to:

```ts
  | {
      type: "message";
      role: "user" | "assistant";
      text: string;
      images?: readonly string[];
      /** For an answer: the taugraph run of its turn, whose trace has every model and tool call. */
      run?: string;
    }
```

In `src/core/moqi.ts`, add `import type { TraceEvent } from "taugraph";`, add to `MoqiOptions`:

```ts
  /**
   * Receives the trace of every conversation turn and every watch run, event by event (taugraph's `onEvent`).
   * A trace is for looking back and replaying; a failure to store it never stops moqi.
   */
  readonly onTrace?: (event: TraceEvent) => void;
```

add a field to `Moqi`:

```ts
  /** `onTrace` made harmless: the event log is moqi's record, a trace only helps to look back. */
  readonly onTrace: ((event: TraceEvent) => void) | undefined;
```

and set it in the constructor, after `this.model = ...`:

```ts
const onTrace = options.onTrace;
this.onTrace =
  onTrace &&
  ((event) => {
    try {
      onTrace(event);
    } catch {
      // a trace that cannot be stored is lost; the conversation goes on
    }
  });
```

- [ ] **Step 4: `chatTurn` on `createAgent`.** In `src/core/agent.ts`, add the imports

```ts
import { isTaugraphError } from "taugraph";
import { createAgent, tool } from "taugraph/agent";
import { newId } from "./types.js";
```

remove `complete` from the `./model.js` import (keep `MEDIA`), and replace `chatTurn` with:

```ts
/** One user turn, as one taugraph agent run: answer with tools, then learn on the side. `fromAgent`: another agent wrote this message. */
export async function chatTurn(
  moqi: Moqi,
  text: string,
  signal?: AbortSignal,
  how: { readonly fromAgent?: boolean; readonly images?: readonly string[] } = {},
): Promise<string> {
  const model = moqi.model;
  if (!model) throw new Error("moqi has no model; set one to chat (briefings and watches work without it)");
  const images = how.images ?? [];
  const past = await history(moqi, AGENT.historyMessages, AGENT.imageMessages - (images.length > 0 ? 1 : 0));
  moqi.emit({ type: "message", role: "user", text, ...(images.length > 0 && { images: [...images] }) });

  // Once this turn has read anything from outside moqi, a dangerous action is asked again, unlocked or not.
  // A memory another agent wrote is in the prompt, so it counts from the start.
  let tainted = how.fromAgent === true || activeFacts(moqi.state, moqi.clock.now()).some((f) => f.by !== undefined);
  const sites: SiteGrant = { granted: new Set() }; // sites the user agreed to open in this turn
  const shown: string[] = []; // images tools brought back, for the user
  // Every rule about running a tool (checks, trust, confirmations) stays in callTool; the agent only records the call.
  const tools = moqi.visibleTools().map((t) => {
    const spec = toolSpec(t);
    return tool({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.parameters,
      effect: t.effect,
      run: async (args) => {
        const result = await moqi.callTool(t.name, { ...args }, { byUser: true, tainted, sites, images: shown });
        if (!t.local) tainted = true;
        return result;
      },
    });
  });
  const agent = createAgent({
    model,
    tools,
    system: systemPrompt(moqi),
    maxRounds: AGENT.maxToolRounds + 1, // the last call goes without tools, so the model answers in words
    lastRound: "answer",
    temperature: 0.3,
  });
  const run = newId("run", moqi.clock);
  const input = { messages: [...past, await userMessage(moqi, text, images, true)] };
  let final: string | null;
  try {
    const result = await agent.run(input, {
      runId: run,
      ...(signal && { signal }),
      ...(moqi.onTrace && { onEvent: moqi.onTrace }),
    });
    final = result.state.final;
  } catch (error) {
    // A model or tool failure surfaces as itself, as before the turn ran on taugraph.
    throw isTaugraphError(error) && error.code === "NODE_FAILED" && error.cause !== undefined ? error.cause : error;
  }
  const answer = final || "（我这次没想好怎么回答，换个说法再试试？）";
  moqi.emit({
    type: "message",
    role: "assistant",
    text: answer,
    run,
    ...(shown.length > 0 && { images: shown.slice(0, AGENT.replyImages) }),
  });
  // Learning never delays the answer. moqi.idle() waits for it.
  if (moqi.state.userMessages % LEARN.everyUserTurns === 0) moqi.track(learn(moqi, signal));
  return answer;
}
```

If the `newId` import creates an import cycle problem (it should not: `types.ts` imports nothing from `agent.ts`), report it. If biome or tsc complains that `final` is used before assignment, initialise it with `let final: string | null = null;`.

- [ ] **Step 5: Run the tests.**

Run: `pnpm exec vitest run test/agent.test.ts test/safety.test.ts test/sites.test.ts test/interop.test.ts test/todo.test.ts`
Expected: PASS. The safety and sites tests prove that tainting, site grants and confirmations work as before inside the agent's tools.

Run: `pnpm format && pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/core/agent.ts src/core/moqi.ts src/core/types.ts test/agent.test.ts
git commit -m "feat(chat): each turn is a taugraph agent run, traced through onTrace"
```

---

### Task 3: Watches are traced too

**Files:**

- Modify: `src/core/watch.ts` (`runWatch` takes run options)
- Modify: `src/core/moqi.ts` (`runDueWatches` passes the runId and `onTrace`)
- Modify: `src/core/types.ts` (`run` on `watch.ran`)
- Test: `test/watch.test.ts`

**Interfaces:**

- Consumes: `Moqi.onTrace` and `newId("run", clock)` from Task 2.
- Produces (public): `runWatch(watch, deps, options?: { readonly runId?: string; readonly onEvent?: (event: TraceEvent) => void })`; `watch.ran` events may carry `run?: string`. (The spec said `WatchOutcome` would carry the runId; passing the runId in instead also covers runs that fail, so `WatchOutcome` stays as it is.)

- [ ] **Step 1: Write the failing test.** Append to `describe("watches")` in `test/watch.test.ts`:

```ts
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
```

Add `import type { TraceEvent } from "taugraph";` to the imports. (The failing run retries `check` once after 250–500 ms; the test takes that long.)

- [ ] **Step 2: Run it to verify it fails.**

Run: `pnpm exec vitest run test/watch.test.ts`
Expected: FAIL (`watch.ran` has no `run`; no events reach `onTrace`).

- [ ] **Step 3: Implement.** In `src/core/types.ts`, change the `watch.ran` member to:

```ts
  | {
      type: "watch.ran";
      watchId: string;
      value: string;
      headline: string;
      changed: boolean;
      nextAt: number;
      /** The taugraph run of this check, whose trace has each step. */
      run?: string;
    }
```

In `src/core/watch.ts`, add `import type { TraceEvent } from "taugraph";` and change `runWatch` to:

```ts
export async function runWatch(
  watch: Watch,
  deps: WatchDeps,
  options: { readonly runId?: string; readonly onEvent?: (event: TraceEvent) => void } = {},
): Promise<WatchOutcome> {
  const result = await watchGraph(watch, deps).run({}, options);
  if (result.status !== "completed") throw new Error(`watch ${watch.id} paused unexpectedly`);
  const s = result.state;
  return { value: s.value ?? "", headline: s.headline ?? "", changed: s.changed, alerted: s.alerted };
}
```

In `src/core/moqi.ts` `runDueWatches`, inside the `for` loop, before `try`, add

```ts
const run = newId("run", this.clock);
```

pass `{ runId: run, ...(this.onTrace && { onEvent: this.onTrace }) }` as the third argument of `runWatch`, and add `run,` to both `this.emit({ type: "watch.ran", ... })` calls (after `nextAt`). `newId` is already imported from `./types.js` in `moqi.ts`; if not, add it.

- [ ] **Step 4: Run the tests.**

Run: `pnpm exec vitest run test/watch.test.ts test/proactive.test.ts`
Expected: PASS.

Run: `pnpm format && pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/core/watch.ts src/core/moqi.ts src/core/types.ts test/watch.test.ts
git commit -m "feat(watch): trace every watch run and link it from watch.ran"
```

---

### Task 4: The home stores traces under `runs/` and prunes them

**Files:**

- Create: `src/node/traces.ts`
- Modify: `src/node/home.ts` (create the store, pass `onTrace`, prune in the background, expose `traces`)
- Test: `test/traces.test.ts` (new), `test/console.test.ts` (one integration test)

**Interfaces:**

- Consumes: `MoqiOptions.onTrace` (Task 2); taugraph 0.4.1 `fileStore(dir, { durability }).remove(runId)`.
- Produces (internal, `src/node/traces.ts`): `TRACE_DAYS = 30`; `traces(home: string, report?: (line: string) => void): Traces` with `{ dir: string; sink(event: TraceEvent): void; prune(now?: number): number }`; `Home.traces: Traces`.

- [ ] **Step 1: Write the failing tests.** Create `test/traces.test.ts`:

```ts
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
```

In `test/console.test.ts`, add `readdirSync` to the `node:fs` import and add this test inside the first `describe` that uses `start` (next to the other chat tests):

```ts
it("keeps the trace of each conversation turn under runs/", async () => {
  const { home, api } = await start({ model: { baseURL: "http://x/v1", model: "m" } }, () => ({ content: "好" }));
  expect((await api("POST", "/api/chat", { text: "hi" })).data.reply).toBe("好");
  const answer = home.moqi.store
    .all()
    .filter((e) => e.type === "message")
    .at(-1) as { run?: string } | undefined;
  expect(answer?.run).toMatch(/^run_/);
  expect(readdirSync(home.traces.dir)).toContain(`${answer?.run}.jsonl`);
});
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `pnpm exec vitest run test/traces.test.ts test/console.test.ts -t "trace"`
Expected: FAIL (`../src/node/traces.js` does not exist; `home.traces` is undefined).

- [ ] **Step 3: Create `src/node/traces.ts`.**

```ts
// Traces of conversation turns and watch runs: one JSONL file per taugraph run under <moqi home>/runs, kept 30 days.
// The event log stays moqi's only record; a trace is for looking back and for replaying a conversation.
import { join } from "node:path";
import type { TraceEvent } from "taugraph";
import { fileStore } from "taugraph/file";

/** Days the trace of a finished run is kept. */
export const TRACE_DAYS = 30;
const DAY = 86_400_000;

export interface Traces {
  readonly dir: string;
  /** Pass as moqi's `onTrace`. Never throws: the first failure is reported once, later ones are dropped. */
  sink(event: TraceEvent): void;
  /** Removes runs that completed, failed or were cut short more than TRACE_DAYS days before `now`. Returns how many. */
  prune(now?: number): number;
}

export function traces(home: string, report: (line: string) => void = (line) => console.error(line)): Traces {
  // No fsync: losing the last events of a trace in a power cut costs nothing moqi relies on.
  const store = fileStore(join(home, "runs"), { durability: "none" });
  let reported = false;
  return {
    dir: store.dir,
    sink(event) {
      try {
        store.sink(event);
      } catch (error) {
        if (reported) return;
        reported = true;
        const reason = error instanceof Error ? error.message : String(error);
        report(`moqi：运行记录存不进 ${store.dir}（${reason}），之后不再提示`);
      }
    },
    prune(now = Date.now()) {
      const before = now - TRACE_DAYS * DAY;
      let removed = 0;
      for (const run of store.list()) {
        if (run.updatedAt >= before || run.status === "running" || run.status === "paused") continue;
        try {
          if (store.remove(run.runId)) removed++;
        } catch {
          // written again just now; the next pass takes it
        }
      }
      return removed;
    },
  };
}
```

- [ ] **Step 4: Wire it into the home.** In `src/node/home.ts`:

- Add `import { type Traces, traces } from "./traces.js";`.
- Add to `interface Home`, after `media`:

```ts
  /** Traces of conversation turns and watch runs, under `runs/` in the home. */
  readonly traces: Traces;
```

- Add a last parameter `runs: Traces` to `build(...)`, and `onTrace: runs.sink,` to the `new Moqi({ ... })` options in it (after `media,`).
- In `openHome`, after `const media = mediaStore(options.home);`, add:

```ts
const runs = traces(options.home);
// Old traces go in the background: a short command exits before the first pass; the always-on home prunes daily.
const prune = () => {
  try {
    runs.prune();
  } catch {
    // the next pass tries again
  }
};
const firstPrune = setTimeout(prune, 60_000);
const dailyPrune = setInterval(prune, 86_400_000);
firstPrune.unref();
dailyPrune.unref();
```

- Pass `runs` as the last argument to all three `build(...)` calls.
- Add `traces: runs,` to the returned object (after `media,`), and in `close`, before `hub.stop();`, add `clearTimeout(firstPrune);` and `clearInterval(dailyPrune);`.

- [ ] **Step 5: Run the tests.**

Run: `pnpm exec vitest run test/traces.test.ts test/console.test.ts test/node.test.ts`
Expected: PASS.

Run: `pnpm format && pnpm check`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/node/traces.ts src/node/home.ts test/traces.test.ts test/console.test.ts
git commit -m "feat(home): keep traces under runs/ for 30 days"
```

---

### Task 5: Documentation and CHANGELOG

**Files:**

- Modify: `README.md`, `README.zh-CN.md`, `docs/design.md`, `CHANGELOG.md`

**Interfaces:** documentation only. biome formats code blocks in Markdown; run `pnpm format`.

- [ ] **Step 1: `README.md`.** In "Use it as a library", after the paragraph that starts with "`effect: \"read\"` tools run freely", add:

```
`model` takes any taugraph `LLMModel` (`{ id, complete(request, { signal }) }`); `openAICompatible` covers OpenAI-compatible endpoints. Each conversation turn runs as a [`taugraph/agent`](https://github.com/wangcao-hub/taugraph) run and each watch as a taugraph flow; pass `onTrace` to receive their traces, event by event.
```

In "Data and privacy", after the first paragraph (it starts with "All state is replayed from"), add:

```
Each conversation turn and each watch run also leaves a trace under `~/.moqi/runs/`, one JSONL file per run, with every request to the model, its reply and every tool call. Traces are for looking back and for replaying real conversations after a change; the log stays the only record of state. They are kept 30 days. Images appear in them as `media:<id>` references, not as image data.
```

- [ ] **Step 2: `README.zh-CN.md`.** In "当作库使用", after the paragraph that starts with "`effect: \"read\"` 的工具随时可用", add:

```
`model` 接受任何 taugraph 的 `LLMModel`（`{ id, complete(request, { signal }) }`）；`openAICompatible` 用于 OpenAI 兼容接口。每轮对话是一次 [`taugraph/agent`](https://github.com/wangcao-hub/taugraph) 运行，每次托管事务是一次 taugraph 流程运行；传入 `onTrace` 可以逐个收到它们的 trace 事件。
```

In "数据与隐私", after the first paragraph (it starts with "所有状态都由事件日志重放得到"), add:

```
每轮对话和每次托管事务还会在 `~/.moqi/runs/` 下留一份 trace，一次运行一个 JSONL 文件，记下每次发给模型的请求、模型的回答和每次工具调用。trace 用来回头排查，以及改动之后用真实对话回放；状态仍然只由事件日志决定。trace 保留 30 天，里面的图片只记 `media:<编号>` 引用，不记图片数据。
```

- [ ] **Step 3: `docs/design.md`.** In "## 3. 架构", after the paragraph that starts with "**内核不碰 Node API**", add:

```
**对话也是 taugraph 运行**：每轮对话是一次 `taugraph/agent` 运行，每次托管事务是一次 taugraph 流程运行。工具的规矩（参数校验、信任等级、确认、是否读过外部内容、网站授权）都在 `callTool` 里，agent 只负责循环和记录；工具轮数用完时，最后一次模型调用不带工具，让模型用文字作答。每次运行的 trace 交给 `onTrace`，家把它存在 `runs/` 下，保留 30 天，用来排查和改了提示词之后回放真实对话。事件日志仍是唯一事实来源，trace 存不下不影响 moqi。
```

- [ ] **Step 4: `CHANGELOG.md`.** Under `## [Unreleased]`, add:

```
- **Breaking:** the model contract is taugraph's `LLMModel` (`complete(request, { signal })`, from `taugraph/nodes`, re-exported as a type). `ChatModel`, `ChatRequest`, `ChatReply`, `ChatMessage`, `ToolCall` and moqi's own adapter are gone; `MoqiOptions.model` takes an `LLMModel`, and `complete(model, request, signal?)` makes one call. `openAICompatible` keeps its name and options (`noThink`, `effort`) and now runs on `taugraph/openai`.
- Each conversation turn runs as a `taugraph/agent` run and each watch as a taugraph flow, and `MoqiOptions.onTrace` receives their traces. The home keeps them under `~/.moqi/runs/`, one JSONL file per run, for 30 days. Answers and `watch.ran` events carry the `run` id of their trace. Images in requests are `media:<id>` references, read when a request is sent.
- After six rounds of tools the last model call still goes without tools. Changed: invalid tool arguments and unknown tools are answered in English (`Invalid arguments: ...`, `No tool named "x"`), at most 32 tool calls run per reply, and the model can no longer call hidden tools.
- The image check reads the status of a refusal (400, 413, 415, 422) instead of matching the error text.
- Depends on taugraph `^0.4.1`. A watch whose check fails now waits 250–500 ms before its one retry.
```

- [ ] **Step 5: Check and commit.**

Run: `pnpm format && pnpm check`
Expected: PASS.

```bash
git add README.md README.zh-CN.md docs/design.md CHANGELOG.md
git commit -m "docs: the conversation on taugraph, traces under runs/"
```

---

### Task 6: Final verification

**Files:** none changed, unless a check fails.

- [ ] **Step 1: Checks.** `pnpm check` passes (it builds `dist/` first).

- [ ] **Step 2: A real turn through the CLI.** With a stub OpenAI-compatible endpoint that asks for one tool call and then answers:

```bash
cat > /tmp/moqi-stub.mjs <<'EOF'
import { createServer } from "node:http";
createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const sent = JSON.parse(body);
    const answered = sent.messages.some((m) => m.role === "tool");
    const message =
      sent.tools && !answered
        ? { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_memories", arguments: "{}" } }] }
        : { content: "在的" };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
}).listen(18765);
EOF
node /tmp/moqi-stub.mjs & STUB=$!
H=$(mktemp -d)
printf 'hi\n' | HOME=$H MOQI_HOME=$H MOQI_BASE_URL=http://127.0.0.1:18765/v1 MOQI_MODEL=stub node dist/node/cli.js chat
ls "$H/runs"
kill $STUB
```

Expected: the CLI prints `moqi：在的`; `$H/runs` holds one `run_….jsonl` file whose events include an `llm_call`, a `tool_call` for `list_memories` and a `run_end` with status `completed` (check with `grep -c '"type":"llm_call"' "$H"/runs/*.jsonl` → 2).

- [ ] **Step 3: Spec coverage.** Read `docs/superpowers/specs/2026-11-26-taugraph-agent-design.md` sections 2 to 7 and confirm each item has code and a test, or a doc change, on this branch (`git diff 9f1f4f8 --stat`). Report anything missing instead of fixing it silently.
