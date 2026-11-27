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
  /**
   * Send the model's own reasoning back as `reasoning_content` in tool loops. Default true, which DeepSeek V4 and
   * Kimi need; set false for endpoints that refuse the field, such as Groq and Cerebras.
   */
  readonly sendReasoning?: boolean;
}

/** OpenAI-compatible /chat/completions through taugraph/openai, with moqi's `noThink` and `effort` switches. */
export function openAICompatible(options: OpenAICompatibleOptions): LLMModel {
  const endpoint = openAIEndpoint({
    baseURL: options.baseURL,
    model: options.model,
    apiKey: options.apiKey,
    fetch: options.fetch,
    sendReasoning: options.sendReasoning,
    // "off" sends nothing unless `effort` is set: some endpoints refuse taugraph's default `reasoning_effort: "none"`.
    reasoningParams: (level) =>
      level === "off" ? (options.effort ? { reasoning_effort: options.effort } : {}) : { reasoning_effort: level },
  });
  return {
    id: endpoint.id,
    async complete(request, { signal }) {
      const sent = options.noThink === true && request.reasoning === "off" ? withNoThink(request) : request;
      const response = await endpoint.complete(sent, { signal });
      return { ...response, content: stripToolMarkup(stripThinking(response.content)) };
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

/**
 * Tool-call markup some models write into the answer instead of calling the tool: DeepSeek's DSML blocks
 * (`<｜｜DSML｜｜ calls>` … `</｜｜DSML｜｜ calls>`, the bar is U+FF5C) and its older `<｜tool▁calls▁begin｜>` …
 * `<｜tool▁calls▁end｜>`. An unclosed block is cut to the end of the text.
 */
const TOOL_MARKUP = [
  /<[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*calls\s*>[\s\S]*?(?:<\/[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*calls\s*>|$)/g,
  /<｜tool▁calls▁begin｜>[\s\S]*?(?:<｜tool▁calls▁end｜>|$)/g,
];

/** The answer without tool-call markup the model wrote as text. */
export function stripToolMarkup(text: string): string {
  return TOOL_MARKUP.reduce((t, pattern) => t.replace(pattern, ""), text).trim();
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
