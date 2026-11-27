// Learning from conversation runs beside the chat, never inside it: answering and extracting at the
// same time makes both worse, and most turns have nothing new.
import type { LLMModel } from "taugraph/nodes";
import { z } from "zod";
import { FACT_KINDS, type RememberInput } from "./memory.js";
import { complete } from "./model.js";
import type { Fact } from "./types.js";

export const LEARN = { everyUserTurns: 3, recentMessages: 6, maxFacts: 5 } as const;

const Extracted = z.object({
  facts: z
    .array(
      z.object({
        kind: z.enum(FACT_KINDS as [string, ...string[]]),
        content: z.string().min(1),
        contradicts: z.string().nullish(),
      }),
    )
    .default([]),
});

const SYSTEM = `从对话里摘出用户亲口说的、以后用得上的个人信息：住哪、工作、偏好、家人朋友、在忙的事、习惯。
每条只写一件事，一句话写明关系，例如「女儿叫朵朵，5 岁」「不喝咖啡，只喝茶」。
不要摘：助理说的话、一次性的请求、档案里已有的内容。
只有当用户明确改口（例如搬家了）时，才在 contradicts 填被推翻的那条档案的 id；临时出差、旅行不算改口。
只输出 JSON：{"facts":[{"kind":"basic|preference|ongoing|relation|routine|other","content":"...","contradicts":"f_..."}]}，没有就输出 {"facts":[]}。`;

export async function extractFacts(
  model: LLMModel,
  recent: readonly { role: "user" | "assistant"; text: string }[],
  known: readonly Fact[],
  signal?: AbortSignal,
): Promise<RememberInput[]> {
  const profile = known.length ? known.map((f) => `- [${f.id}] ${f.content}`).join("\n") : "（空）";
  const dialog = recent.map((m) => `${m.role === "user" ? "用户" : "助理"}：${m.text}`).join("\n");
  const reply = await complete(
    model,
    {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `已有档案：\n${profile}\n\n最近对话：\n${dialog}` },
      ],
      temperature: 0,
      // Reasoning models (Qwen3 on Ollama, DeepSeek-R1) think before answering and do not always obey
      // "/no_think"; a tight cap leaves the answer empty. Learning runs in the background, so room is cheap.
      maxTokens: 6144,
      responseFormat: "json",
      reasoning: "off",
    },
    signal,
  );
  const parsed = Extracted.safeParse(parseJsonObject(reply.content));
  if (!parsed.success) return [];
  const ids = new Set(known.map((f) => f.id));
  return parsed.data.facts.slice(0, LEARN.maxFacts).map((f) => ({
    kind: f.kind as RememberInput["kind"],
    content: f.content,
    ...(f.contradicts && ids.has(f.contradicts) && { contradicts: f.contradicts }),
  }));
}

/** Accepts bare JSON, fenced JSON, or JSON surrounded by prose. */
export function parseJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}
