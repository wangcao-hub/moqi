// Reflection: moqi thinks about the user on its own, not only when spoken to. It looks at what it knows,
// what is going on and how the user reacted before, and comes back with a few ideas: something to do for
// the user, a question to understand them better, or news from the world that matters to them.
// Every idea is still an offer, so the proactive policy decides whether it interrupts, waits, or is dropped.
import { z } from "zod";
import { parseJsonObject } from "./learn.js";
import { activeFacts, normalize, promptSection } from "./memory.js";
import { complete } from "./model.js";
import type { Moqi } from "./moqi.js";
import { type OfferInput, type Plugin, toolSpec } from "./plugin.js";
import { dayKey, describeSchedule } from "./schedule.js";
import { studySection } from "./study.js";
import { openTodos, TODO_KIND, todoContext } from "./todo.js";
import type { Idea, IdeaType } from "./types.js";

export const REFLECT = {
  /** On the timer, at most this often. */
  everyMs: 2 * 3_600_000,
  /** A conversation that has settled for this long is worth a thought sooner. */
  afterChatMs: 10 * 60_000,
  /** Never more often than this, whatever triggers it. */
  minGapMs: 20 * 60_000,
  maxIdeas: 3,
  questionsPerDay: 2,
  recentMessages: 12,
  /** The same idea is not offered twice within this window. */
  repeatWindowMs: 7 * 86_400_000,
  /** Ideas never reach the 0.9 that may break quiet hours; that is for things the user set up. */
  maxValue: 0.85,
} as const;

export const IDEA_KIND: Record<IdeaType, string> = { serve: "idea.serve", ask: "learn.question", world: "idea.world" };

const IdeaFields = z.object({
  type: z.enum(["serve", "ask", "world"]),
  title: z.string().trim().min(1).max(120),
  body: z.string().max(600).default(""),
  value: z.coerce.number().min(0).max(1).catch(0.5),
  timely: z.boolean().catch(false).default(false),
  watch: z.record(z.string(), z.unknown()).nullish(),
  todo: z.record(z.string(), z.unknown()).nullish(),
  refs: z
    .union([z.string().transform((r) => [r]), z.array(z.string()).max(8)])
    .catch([])
    .default([]),
});

/** Small models rename fields ("question" for an ask's title); read what they meant. */
const RawIdea = z.preprocess((v) => {
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  return o.title === undefined ? { ...o, title: o.question ?? o.text ?? o.content } : o;
}, IdeaFields);

const SYSTEM = `你是 moqi（默契），用户的个人助理。现在不是在和用户对话，是你自己在想：根据你对用户的了解和眼下的情况，有什么能主动替 TA 做的、需要了解 TA 的、值得告诉 TA 的。
最多 3 个点子，宁缺毋滥。三类：
- serve：替用户做一件具体的事。能定时替 TA 盯着的（查天气、新闻、日程，或到点提醒）就填 watch，用户点一下就办好；watch 的格式和「可以用来盯着的工具」一节一致。
- 用户在对话里提到自己要做、但「用户的待办」里还没有的事（比如"明天下午要交报告"），出一个 serve，title 写成一句问话，填 todo：{"text":"交报告","day":"tomorrow","at":"14:00"}；day 填 today、tomorrow 或 YYYY-MM-DD，没说时间就不填 at。
- ask：问用户一个问题，好在以后帮得更准。一次只问一件事，口语、简短；body 说一句为什么问。不要问档案里已有的，不要问收入、病情、密码这类隐私。
- world：从「眼下的情况」里挑和用户有关的外部信息，title 写成一句告诉 TA 的话，refs 填条目编号（如 n3），只能用给出的编号。
value 是这件事值得占用用户多少注意力（0 到 1）：和 TA 明确相关、今天就用得上的才高于 0.6。
timely：只有今天不说就晚了的事才填 true（比如今天下雨、马上要出发）；其余的放进动态，等用户有空再看。
看「用户对之前提议的反应」：被拒绝或关掉的那类别再提，提过的别重复。
只输出 JSON：{"ideas":[{"type":"serve","title":"一句话","body":"补充","value":0.6,"timely":false,"watch":{"title":"…","schedule":{"every":"day","at":"08:00"},"tool":"weather","args":{"day":"today"},"notify":"always"}},{"type":"ask","title":"问题","body":"为什么问","value":0.4},{"type":"world","title":"…","body":"…","value":0.5,"refs":["n1"]}]}
想不到就输出 {"ideas":[]}。`;

const VERDICT_WORDS = { accepted: "接受了", dismissed: "拒绝了", ignored: "没理", muted: "关掉了这类" } as const;

export async function reflect(moqi: Moqi, trigger: "timer" | "chat" | "user", signal?: AbortSignal): Promise<Idea[]> {
  if (!moqi.model) return [];
  const now = moqi.clock.now();
  const { text: situation, links } = await gatherContext(moqi);
  const questionsLeft = Math.max(0, REFLECT.questionsPerDay - moqi.state.offeredOn(IDEA_KIND.ask, now));
  let raw: unknown[] | undefined;
  try {
    const reply = await complete(
      moqi.model,
      {
        messages: [
          { role: "system", content: `${moqi.persona}\n\n${SYSTEM}` },
          { role: "user", content: briefOf(moqi, now, situation, questionsLeft) },
        ],
        temperature: 0.7,
        maxTokens: 6144, // reasoning models think first; this runs in the background, so room is cheap
        responseFormat: "json",
        reasoning: "off",
      },
      signal,
    );
    raw = parseIdeas(reply.content);
    if (raw === undefined) throw new Error("模型的回答不是 JSON");
  } catch (error) {
    moqi.emit({ type: "thought", trigger, ideas: [], error: error instanceof Error ? error.message : String(error) });
    return [];
  }

  const list = raw;
  const ideas: Idea[] = [];
  let asked = 0;
  for (const item of list.slice(0, REFLECT.maxIdeas)) {
    const parsed = RawIdea.safeParse(item);
    if (!parsed.success) continue;
    const idea = parsed.data;
    const value = Math.min(REFLECT.maxValue, idea.value);
    const todo = idea.type === "serve" && idea.todo ? todoArgs(moqi, idea.todo) : undefined;
    const kind = todo ? TODO_KIND.capture : IDEA_KIND[idea.type];
    const base = { type: idea.type, title: idea.title, value } as const;
    if (repeated(moqi, kind, idea.title, now)) {
      ideas.push({ ...base, skipped: "最近提过" });
      continue;
    }
    if (todo && alreadyListed(moqi, String(todo.text))) {
      ideas.push({ ...base, skipped: "待办里已经有了" });
      continue;
    }
    if (idea.type === "ask" && asked >= questionsLeft) {
      ideas.push({ ...base, skipped: "今天问够了" });
      continue;
    }
    // Only what matters today may interrupt; everything else waits in the feed for when the user looks.
    const input: OfferInput = {
      kind,
      title: idea.title,
      body: idea.body,
      value,
      urgency: idea.timely ? "today" : "whenever",
    };
    let offer: OfferInput = input;
    if (idea.type === "ask") {
      offer = { ...input, urgency: "whenever", answer: "text" };
      asked++;
    } else if (todo) {
      offer = { ...input, action: { tool: "todo_add", args: todo } };
    } else if (idea.type === "serve" && idea.watch) {
      // Only an action that would actually work is offered; otherwise the idea stays a suggestion.
      if (!moqi.checkTool("watch_create", idea.watch)) {
        offer = { ...input, action: { tool: "watch_create", args: idea.watch } };
      }
    } else if (idea.type === "world") {
      // News waits in the feed; what deserves an interruption comes from sources the user set up.
      const picked = idea.refs.flatMap((r) => (links[r] ? [links[r]] : []));
      const matched = picked.length > 0 ? picked : closest(`${idea.title}${idea.body}`, links);
      offer = { ...input, urgency: "whenever", ...(matched.length > 0 && { links: matched }) };
    }
    const made = await moqi.offer(offer);
    ideas.push({ ...base, offerId: made.id });
  }
  moqi.emit({ type: "thought", trigger, ideas });
  return ideas;
}

/** Small models answer `{"ideas":[…]}`, another name for the list, a bare list, or one idea; all mean the same. */
export function parseIdeas(text: string): unknown[] | undefined {
  const obj = parseJsonObject(text) as Record<string, unknown> | undefined;
  if (obj && Array.isArray(obj.ideas)) return obj.ideas;
  if (obj && typeof obj.type === "string") return [obj];
  const list = obj && Object.values(obj).find((v) => Array.isArray(v));
  if (Array.isArray(list)) return list;
  try {
    const list = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    if (Array.isArray(list)) return list;
  } catch {
    // not a list either
  }
  return obj ? [] : undefined;
}

/** The source item an idea talks about when the model forgot to say which: the longest shared run of text. */
function closest(
  text: string,
  links: Record<string, { title: string; url: string }>,
): { title: string; url: string }[] {
  const said = normalize(text);
  let best: { title: string; url: string } | undefined;
  let bestLen = 5; // at least 6 characters in common, so a stray word does not count
  for (const link of Object.values(links)) {
    const len = commonRun(said, normalize(link.title));
    if (len > bestLen) {
      best = link;
      bestLen = len;
    }
  }
  return best ? [best] : [];
}

function commonRun(a: string, b: string): number {
  let best = 0;
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j] ?? 0;
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0;
      best = Math.max(best, row[j] ?? 0);
      prev = keep;
    }
  }
  return best;
}

/** A todo the model heard in conversation, as todo_add arguments; undefined when it would not work. */
function todoArgs(moqi: Moqi, raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = { by: "moqi" };
  for (const key of ["text", "day", "at", "inMinutes"]) {
    const v = raw[key];
    if (v !== null && v !== undefined && v !== "") args[key] = v;
  }
  return moqi.checkTool("todo_add", args) ? undefined : args;
}

/** The same todo is already on the list, or nearly: "交报告" and "交季度报告". */
function alreadyListed(moqi: Moqi, text: string): boolean {
  const key = normalize(text);
  return openTodos(moqi.state).some((t) => {
    const other = normalize(t.text);
    return other === key || commonRun(key, other) >= Math.max(2, 0.6 * Math.min(key.length, other.length));
  });
}

/** The same idea again, or nearly: "深圳小雨提醒" after "深圳小雨，记得带伞". */
function repeated(moqi: Moqi, kind: string, title: string, now: number): boolean {
  const key = normalize(title);
  for (const { offer } of moqi.state.offers.values()) {
    if (offer.kind !== kind || now - offer.createdAt >= REFLECT.repeatWindowMs) continue;
    const other = normalize(offer.title);
    if (other === key) return true;
    if (commonRun(key, other) >= Math.max(4, 0.6 * Math.min(key.length, other.length))) return true;
  }
  return false;
}

/** What every source knows right now, its keyed links, and which source each link came from. */
export async function gatherContext(moqi: Moqi): Promise<{
  text: string;
  links: Record<string, { title: string; url: string }>;
  owners: Record<string, Plugin>;
}> {
  const ctx = moqi.pluginContext();
  const parts: string[] = [];
  const links: Record<string, { title: string; url: string }> = {};
  const owners: Record<string, Plugin> = {};
  for (const plugin of moqi.plugins) {
    try {
      if (plugin.context) {
        const c = await plugin.context(ctx);
        if (c?.text) parts.push(`【${plugin.name}】\n${c.text}`);
        for (const [key, link] of Object.entries(c?.links ?? {})) {
          links[key] = link;
          owners[key] = plugin;
        }
      } else if (plugin.briefing) {
        const s = await plugin.briefing(ctx);
        if (s) parts.push(`【${s.title}】\n${s.lines.join("\n")}`);
      }
    } catch {
      // A source that fails this time is simply not part of this thought.
    }
  }
  return { text: parts.join("\n\n"), links, owners };
}

function briefOf(moqi: Moqi, now: number, situation: string, questionsLeft: number): string {
  const d = new Date(now);
  const week = "日一二三四五六"[d.getDay()];
  const time = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${week} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const messages = moqi.store
    .all()
    .flatMap((e) => (e.type === "message" ? [`${e.role === "user" ? "用户" : "你"}：${e.text}`] : []))
    .slice(-REFLECT.recentMessages);
  const watches = [...moqi.state.watches.values()].map((w) => `- ${w.title}（${describeSchedule(w.schedule)}）`);
  const reactions = [...moqi.state.offers.values()]
    .filter((r) => now - r.offer.createdAt < 14 * 86_400_000 && r.offer.kind !== "briefing")
    .slice(-15)
    .map((r) => `- [${r.offer.kind}] ${r.offer.title}：${r.verdict ? VERDICT_WORDS[r.verdict] : "还没回应"}`);
  const muted = [...moqi.state.kinds.entries()].filter(([, k]) => k.muted).map(([kind]) => kind);
  const tools = moqi.watchableTools().map((t) => {
    const spec = toolSpec(t);
    return `- ${spec.name}：${spec.description} 参数 ${JSON.stringify(spec.parameters.properties ?? {})}`;
  });
  return [
    `现在：${time}（${dayKey(now)}）`,
    promptSection(moqi.state, now) || "## 你对用户的了解\n（还不了解，可以问问）",
    studySection(moqi.state),
    `## 最近的对话\n${messages.join("\n") || "（还没聊过）"}`,
    `## 眼下的情况\n${situation || "（没有接入信息源）"}`,
    `## 正在替用户盯着的事\n${watches.join("\n") || "（没有）"}`,
    `## 用户的待办\n${todoContext(moqi.state, now)}`,
    `## 用户对之前提议的反应\n${reactions.join("\n") || "（还没有）"}${muted.length ? `\n关掉了：${muted.join("、")}` : ""}`,
    `## 可以用来盯着的工具（watch.tool 只能填这些；不填 tool 就填 remind，做成到点提醒）\n${tools.join("\n") || "（没有）"}`,
    `今天还能问 ${questionsLeft} 个问题${questionsLeft === 0 ? "，这次不要出 ask" : ""}。${
      questionsLeft > 0 && activeFacts(moqi.state, now).length < 5 ? "你对用户还了解得很少，这次至少出一个 ask。" : ""
    }`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
