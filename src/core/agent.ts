import { isTaugraphError } from "taugraph";
import { createAgent, tool } from "taugraph/agent";
import type { ChatMessage, ContentPart } from "taugraph/nodes";
import { extractFacts, LEARN } from "./learn.js";
import { activeFacts, OUTSIDE, promptSection } from "./memory.js";
import { MEDIA } from "./model.js";
import type { Moqi } from "./moqi.js";
import { toolSpec } from "./plugin.js";
import type { SiteGrant } from "./sites.js";
import { studySection } from "./study.js";
import { newId } from "./types.js";

export const AGENT = {
  maxToolRounds: 6,
  historyMessages: 12,
  imageMessages: 3,
  replyImages: 8,
  /** Ends the last request of a turn, after six rounds of tools: the model answers in words from what it has. */
  lastRoundNote:
    "这一轮的工具调用次数已经用完了。请根据上面已经拿到的结果，直接用文字回答用户；没查到的就说还没查到，不要再调用任何工具。",
} as const;

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

const GUIDE = `## 做事的方式
- 用户提到自己的情况（住哪、做什么、喜欢什么、身边的人、在忙的事），用 remember 记下：一件事调用一次，写成完整的一句话并写明关系，例如「女儿叫朵朵，5 岁」；和已记的矛盾时填 contradicts。
- 用户要你"提醒我"某件事，或说了自己要做的事想记下，用 todo_add：到点提醒填 at（HH:MM，配合 day）或 inMinutes（几分钟后）；不说时间就只进待办清单。查改待办先用 todo_list 拿 id。
- "每天"、"每周"这类反复的提醒，或要你定时去查的事（每天的天气、某个价格），用 watch_create；有工具能查的填 tool，纯提醒填 remind。
- 用户加待办没说时间时，参照「你总结的经验」建议一个时间问一句，用户同意再用 todo_update 填上。
- 需要用户确认的操作，moqi 会自己去问，你直接调用工具即可。
- 回答可以用 Markdown：列表、加粗、行内代码和代码块、表格、链接；不要用 HTML。
- 回答简短、直接，用中文；不知道就说不知道，不编造。`;

export function systemPrompt(moqi: Moqi): string {
  const now = new Date(moqi.clock.now());
  const time = `现在是 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 周${WEEKDAYS[now.getDay()]} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}。`;
  return [moqi.persona, time, promptSection(moqi.state, moqi.clock.now()), studySection(moqi.state), GUIDE]
    .filter(Boolean)
    .join("\n\n");
}

const withImageMark = (text: string) => (text ? `${text} [图片]` : "[图片]");

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

/** The last messages; only the latest `withImages` user messages that had images still carry them. */
async function history(moqi: Moqi, limit: number, withImages: number): Promise<ChatMessage[]> {
  const recent = moqi.store
    .all()
    .flatMap((e) => (e.type === "message" ? [e] : []))
    .slice(-limit);
  let left = withImages;
  const out: ChatMessage[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    if (!e) continue;
    if (e.role === "assistant") {
      out.unshift({ role: "assistant", content: e.text });
      continue;
    }
    const ids = e.images ?? [];
    const keep = ids.length > 0 && left > 0;
    if (keep) left--;
    out.unshift(await userMessage(moqi, e.text, ids, keep));
  }
  return out;
}

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
  // A tool call that throws fails the turn with its error, as before the turn ran on taugraph: the agent would
  // hand it to the model as an answer, and after a write the model might do it again. Stopping the run keeps it
  // from going on; the caller's signal stops it too.
  const stop = new AbortController();
  let failure: { readonly error: unknown } | undefined;
  // Every rule about running a tool (checks, trust, confirmations) stays in callTool; the agent only records the call.
  const tools = moqi.visibleTools().map((t) => {
    const spec = toolSpec(t);
    return tool({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.parameters,
      effect: t.effect,
      run: async (args) => {
        try {
          return await moqi.callTool(t.name, { ...args }, { byUser: true, tainted, sites, images: shown });
        } catch (error) {
          failure ??= { error };
          stop.abort(error);
          throw error;
        } finally {
          if (!t.local) tainted = true;
        }
      },
    });
  });
  const agent = createAgent({
    model,
    tools,
    system: systemPrompt(moqi),
    maxRounds: AGENT.maxToolRounds + 1, // the last call may use no tool, so the model answers in words
    lastRound: "answer",
    lastRoundNote: AGENT.lastRoundNote,
    temperature: 0.3,
  });
  const run = newId("run", moqi.clock);
  const input = { messages: [...past, await userMessage(moqi, text, images, true)] };
  let final: string | null;
  const forward = () => stop.abort(signal?.reason);
  if (signal?.aborted) stop.abort(signal.reason);
  else signal?.addEventListener("abort", forward, { once: true });
  try {
    const result = await agent.run(input, {
      runId: run,
      signal: stop.signal,
      ...(moqi.onTrace && { onEvent: moqi.onTrace }),
    });
    final = result.state.final;
  } catch (error) {
    // What reaches here: a run stopped for a tool call that threw (thrown as that error), a failed model call
    // (NODE_FAILED, thrown as the model's own error, as before the turn ran on taugraph), or an abort (ABORTED).
    if (failure) throw failure.error;
    throw isTaugraphError(error) && error.code === "NODE_FAILED" && error.cause !== undefined ? error.cause : error;
  } finally {
    signal?.removeEventListener("abort", forward);
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

/** Side-channel extraction. Failures only cost this round's learning. */
export async function learn(moqi: Moqi, signal?: AbortSignal): Promise<number> {
  if (!moqi.model) return 0;
  const recent = moqi.store
    .all()
    .flatMap((e) => (e.type === "message" ? [{ role: e.role, text: e.text }] : []))
    .slice(-LEARN.recentMessages);
  try {
    const facts = await extractFacts(moqi.model, recent, activeFacts(moqi.state, moqi.clock.now()), signal);
    // Another agent spoke in this window: what was learned may be its words, not the user's.
    const outside = recent.some((m) => m.role === "user" && /^【[^】]{1,40}】/.test(m.text));
    for (const fact of facts) moqi.remember(outside ? { ...fact, by: OUTSIDE } : fact);
    return facts.length;
  } catch {
    return 0;
  }
}
