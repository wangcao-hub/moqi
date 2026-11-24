// The model contract: chat with optional tool calling. Bring any provider with an adapter.

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** JSON text, as the model produced it. */
  readonly arguments: string;
}

/** An image for the model: its type and its bytes in base64. */
export interface ImagePart {
  readonly type: string;
  readonly data: string;
}

export type ChatMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string; readonly images?: readonly ImagePart[] }
  | { readonly role: "assistant"; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly role: "tool"; readonly content: string; readonly toolCallId: string };

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the arguments object. */
  readonly parameters: Record<string, unknown>;
}

export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolSpec[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Ask for a JSON object reply, where the provider supports it. */
  readonly json?: boolean;
  /** "off" asks reasoning models not to think first. Used for quick side requests; adapters map it as they can. */
  readonly reasoning?: "off";
  readonly signal?: AbortSignal;
}

export interface ChatReply {
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
}

export interface ChatModel {
  readonly id: string;
  chat(request: ChatRequest): Promise<ChatReply>;
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
  /** How long one attempt may take before it is given up on. Default 120 seconds. */
  readonly timeoutMs?: number;
  /** Wait before the first retry, doubled for each one after it. Default 500 ms; tests make it small. */
  readonly retryDelayMs?: number;
  /** Told about every attempt, e.g. to log how long it took and how many tokens it used. */
  readonly onCall?: (call: ModelCall) => void;
}

export interface ModelCall {
  readonly model: string;
  /** "background" for the quick side requests (`reasoning: "off"`): learning, reflecting, studying. */
  readonly purpose: "chat" | "background";
  readonly attempt: number;
  readonly ms: number;
  readonly ok: boolean;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly error?: string;
}

const TIMEOUT_MS = 120_000;
const ATTEMPTS = 3;
/** Rate limits and server trouble pass; anything else (bad key, bad request) would fail the same way again. */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_AFTER_MAX_MS = 10_000;

/** OpenAI-compatible /chat/completions with function calling: OpenAI, DeepSeek, Qwen, Ollama, vLLM, ... */
export function openAICompatible(options: OpenAICompatibleOptions): ChatModel {
  const url = `${options.baseURL.replace(/\/+$/, "")}/chat/completions`;
  const doFetch = options.fetch ?? fetch;
  return {
    id: `openai-compatible:${options.model}`,
    async chat(request) {
      const body = JSON.stringify({
        model: options.model,
        messages: withNoThink(request, options.noThink === true).map(toWire),
        ...(request.tools?.length && {
          tools: request.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }),
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
        ...(request.json && { response_format: { type: "json_object" } }),
        ...(request.reasoning === "off" && options.effort && { reasoning_effort: options.effort }),
      });
      const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
      const report = (c: Omit<ModelCall, "model" | "purpose">) =>
        options.onCall?.({ model: options.model, purpose: request.reasoning === "off" ? "background" : "chat", ...c });
      for (let attempt = 1; ; attempt++) {
        const started = Date.now();
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
        let failure: Error;
        let retry = false;
        let waitMs = (options.retryDelayMs ?? 500) * 2 ** (attempt - 1);
        try {
          const response = await doFetch(url, {
            method: "POST",
            signal,
            headers: {
              "content-type": "application/json",
              ...(options.apiKey && { authorization: `Bearer ${options.apiKey}` }),
            },
            body,
          });
          if (response.ok) {
            const reply = (await response.json()) as {
              choices?: {
                message?: {
                  content?: string | null;
                  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
                };
              }[];
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            report({
              attempt,
              ms: Date.now() - started,
              ok: true,
              ...(reply.usage?.prompt_tokens !== undefined && { promptTokens: reply.usage.prompt_tokens }),
              ...(reply.usage?.completion_tokens !== undefined && { completionTokens: reply.usage.completion_tokens }),
            });
            const message = reply.choices?.[0]?.message;
            return {
              content: stripThinking(message?.content ?? ""),
              toolCalls: (message?.tool_calls ?? []).flatMap((c, i) =>
                c.function?.name
                  ? [{ id: c.id ?? `call_${i}`, name: c.function.name, arguments: c.function.arguments ?? "{}" }]
                  : [],
              ),
            };
          }
          failure = new Error(`${url} responded ${response.status}: ${(await response.text()).slice(0, 300)}`);
          retry = RETRY_STATUS.has(response.status);
          const after = Number(response.headers.get("retry-after"));
          if (retry && after > 0) waitMs = Math.min(after * 1000, RETRY_AFTER_MAX_MS);
        } catch (error) {
          if (request.signal?.aborted) throw error; // the caller stopped: no retry, no report
          if (timeout.aborted) failure = new Error(`模型 ${Math.round(timeoutMs / 1000)} 秒没有回应（${url}）`);
          else {
            failure = error instanceof Error ? error : new Error(String(error));
            retry = true; // the connection broke, or the answer did not arrive whole
          }
        }
        report({ attempt, ms: Date.now() - started, ok: false, error: failure.message });
        if (!retry || attempt >= ATTEMPTS) throw failure;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    },
  };
}

function withNoThink(request: ChatRequest, enabled: boolean): readonly ChatMessage[] {
  if (!enabled || request.reasoning !== "off") return request.messages;
  const last = request.messages.map((m) => m.role).lastIndexOf("user");
  return request.messages.map((m, i) =>
    i === last && m.role === "user" ? { ...m, content: `${m.content} /no_think` } : m,
  );
}

function toWire(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      })),
    };
  }
  if (m.role === "user" && m.images?.length)
    return {
      role: "user",
      content: [
        ...(m.content ? [{ type: "text", text: m.content }] : []),
        ...m.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.type};base64,${i.data}` } })),
      ],
    };
  return { role: m.role, content: m.content };
}

/** Reasoning models (Qwen3, DeepSeek-R1 via some servers) put their thoughts in <think> tags. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** A 32×32 solid red PNG: a model that can see says "red". */
const RED_SQUARE =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC";

/**
 * Whether the model reads images: it is shown a red square and asked its colour. A refusal of the request
 * itself (400, 413, 415, 422) means it cannot; any other failure is not an answer and is thrown. The token
 * limit leaves room for models that think before they answer (deepseek-flash by that name does).
 */
export async function canSeeImages(model: ChatModel, signal?: AbortSignal): Promise<boolean> {
  try {
    const reply = await model.chat({
      messages: [
        { role: "user", content: "这张图是什么颜色？只回答颜色。", images: [{ type: "image/png", data: RED_SQUARE }] },
      ],
      maxTokens: 512,
      reasoning: "off",
      ...(signal && { signal }),
    });
    return /红|red/i.test(reply.content);
  } catch (error) {
    if (/ responded (400|413|415|422):/.test(error instanceof Error ? error.message : String(error))) return false;
    throw error;
  }
}
