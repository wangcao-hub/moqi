import type { ChatMessage, ContentPart } from "taugraph/nodes";
import { extractFacts, LEARN } from "./learn.js";
import { activeFacts, OUTSIDE, promptSection } from "./memory.js";
import { complete, MEDIA } from "./model.js";
import type { Moqi } from "./moqi.js";
import { toolSpec } from "./plugin.js";
import type { SiteGrant } from "./sites.js";
import { studySection } from "./study.js";

export const AGENT = { maxToolRounds: 6, historyMessages: 12, imageMessages: 3, replyImages: 8 } as const;

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

/** One user turn: answer with tools, then learn on the side. `fromAgent`: another agent wrote this message. */
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

  const tools = moqi.visibleTools().map((t) => {
    const spec = toolSpec(t);
    return { name: spec.name, description: spec.description, inputSchema: spec.parameters };
  });
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(moqi) },
    ...past,
    await userMessage(moqi, text, images, true),
  ];
  // Once this turn has read anything from outside moqi, a dangerous action is asked again, unlocked or not.
  // A memory another agent wrote is in the prompt, so it counts from the start.
  let tainted = how.fromAgent === true || activeFacts(moqi.state, moqi.clock.now()).some((f) => f.by !== undefined);
  const sites: SiteGrant = { granted: new Set() }; // sites the user agreed to open in this turn
  const shown: string[] = []; // images tools brought back, for the user
  let answer = "";
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
  answer ||= "（我这次没想好怎么回答，换个说法再试试？）";
  moqi.emit({
    type: "message",
    role: "assistant",
    text: answer,
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
