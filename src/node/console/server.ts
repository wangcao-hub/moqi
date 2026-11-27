// The console: a page on 127.0.0.1 for chatting, answering offers, seeing memories and changing settings.
// It is served by the running home, so the page, the terminal and (later) the phone all go through one process.
import { execFileSync } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { lastSegment } from "../../core/code.js";
import { seenOffers } from "../../core/feed.js";
import { FACT_KINDS, isFaded } from "../../core/memory.js";
import { canSeeImages, complete, openAICompatible } from "../../core/model.js";
import { describeSchedule } from "../../core/schedule.js";
import { daysLate, laterTodos, recentlyDone, todayTodos } from "../../core/todo.js";
import type { Answer, Choices, FactKind, Todo, Urgency, Verdict } from "../../core/types.js";
import { parseIcs } from "../../plugins/calendar.js";
import { NEWS_FEEDS } from "../../plugins/news.js";
import { connectAgent, disconnectAgent, findAgents, importableServers } from "../agents.js";
import type { Config } from "../config.js";
import { ConfigSchema, expandHome, loadConfig, readConfigFile, saveConfig } from "../config.js";
import type { Home } from "../home.js";
import { listShortcuts } from "../mac.js";
import { MEDIA_ID, MEDIA_MAX, sniff } from "../media.js";
import { browserPreset } from "../presets.js";
import { A2A_PATH, AGENT_CARD_PATH, agentCard, handleA2A } from "./a2a.js";
import { CONSOLE_HOST, consoleUrl } from "./info.js";

/** M-O-Q-I on a phone keypad. */
export const DEFAULT_PORT = 6674;
const MAX_BODY = 64 * 1024;
const VERDICT_WORDS = {
  accepted: "你接受了",
  dismissed: "你拒绝了",
  ignored: "你没理",
  muted: "你关掉了这类",
} as const;
const ANSWER_TIMEOUT_MS = 5 * 60_000;
/** How the settings page names moqi's own ordinary write tools; others show their tool name. */
const ORDINARY_LABELS: Record<string, string> = {
  files_mkdir: "新建文件夹",
  files_write_new: "新建文件",
  files_move: "移动文件",
  files_rename: "改名",
  mac_clipboard_write: "写剪贴板",
  watch_create: "新建盯梢",
  watch_cancel: "取消盯梢",
  todo_remove: "删除待办",
};

/** Questions moqi asks before an action it has not earned trust for, answered from the page. */
export interface Asker {
  ask(question: string, details?: string, choices?: Choices): Promise<Answer>;
  pending():
    | { readonly id: string; readonly text: string; readonly details?: string; readonly always?: string }
    | undefined;
  /** `always`: the user pressed the question's "do not ask again" button; ignored when it offers none. */
  answer(id: string, yes: boolean, always?: boolean): boolean;
}

export function confirmQueue(timeoutMs = ANSWER_TIMEOUT_MS): Asker {
  let current:
    | {
        id: string;
        text: string;
        details?: string;
        always?: string;
        resolve: (answer: Answer) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let n = 0;
  const settle = (answer: Answer) => {
    if (!current) return;
    clearTimeout(current.timer);
    const { resolve } = current;
    current = undefined;
    resolve(answer);
  };
  return {
    ask(text, details, choices) {
      settle(false); // only one question at a time; an unanswered one counts as "no"
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(false), timeoutMs);
        current = {
          id: `q${++n}`,
          text,
          ...(details !== undefined && { details }),
          ...(choices && { always: choices.always }),
          resolve,
          timer,
        };
      });
    },
    pending: () =>
      current
        ? {
            id: current.id,
            text: current.text,
            ...(current.details !== undefined && { details: current.details }),
            ...(current.always !== undefined && { always: current.always }),
          }
        : undefined,
    answer(id, yes, always = false) {
      if (current?.id !== id) return false;
      settle(yes && always && current.always !== undefined ? "always" : yes);
      return true;
    },
  };
}

export interface ConsoleOptions {
  readonly home: Home;
  readonly asker: Asker;
  readonly token: string;
  /** Tried first; a free port is used if it is taken. 0 picks any free port. */
  readonly port?: number;
  readonly fetch?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  /** Key other agents present over A2A (`Authorization: Bearer …`). Without it, A2A is off. */
  readonly a2aKey?: string;
  /** moqi's version, for the A2A agent card. */
  readonly version?: string;
  /** Lists the user's shortcuts; tests pass a fake. */
  readonly shortcuts?: () => Promise<string[] | undefined>;
}

export interface Console {
  readonly port: number;
  /** Includes the token, after "#" so it never reaches a server log or a Referer header. */
  readonly url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/markdown.js": { file: "markdown.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

export async function startConsole(options: ConsoleOptions): Promise<Console> {
  const { home, asker } = options;
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? fetch;
  const assets = Object.fromEntries(
    Object.entries(ASSETS).map(([path, a]) => [
      path,
      { body: readFileSync(new URL(`./assets/${a.file}`, import.meta.url)), type: a.type },
    ]),
  );
  const expected = Buffer.from(options.token);
  let chatting = 0;
  let port = 0;

  /** The saved key, only for the endpoint it was saved with: switching providers must never send it elsewhere. */
  const savedKeyFor = (baseURL: string) => {
    const saved = readConfigFile(home.dir).model;
    return saved?.apiKey && saved.baseURL.replace(/\/+$/, "") === baseURL.replace(/\/+$/, "")
      ? saved.apiKey
      : undefined;
  };

  /** A model built from what the settings form says, with the saved key only for its own endpoint. */
  const formModel = (m: Record<string, unknown>) => {
    const baseURL = str(m.baseURL, "baseURL");
    if (!/^https?:\/\//.test(baseURL)) throw new HttpError(400, "接口地址要以 http:// 或 https:// 开头");
    const apiKey = (typeof m.apiKey === "string" && m.apiKey) || env.MOQI_API_KEY || savedKeyFor(baseURL);
    return openAICompatible({
      baseURL,
      model: str(m.model, "model"),
      ...(apiKey && { apiKey }),
      ...(m.noThink === true && { noThink: true }),
      fetch: doFetch,
    });
  };

  const same = (value: string | string[] | undefined, want: Buffer) => {
    if (typeof value !== "string") return false;
    const given = Buffer.from(value);
    return given.length === want.length && timingSafeEqual(given, want);
  };
  const tokenOk = (value: string | string[] | undefined) => same(value, expected);
  const a2aKey = options.a2aKey ? Buffer.from(`Bearer ${options.a2aKey}`) : undefined;
  /** Another agent's message joins the conversation marked as theirs, so moqi never takes it for the user's words. */
  const fromAgent = (text: string, from: unknown) =>
    typeof from === "string" && from.trim() ? `【${from.trim().slice(0, 40)}】${text}` : text;
  /** Another agent's words count as outside content: a dangerous action they lead to is asked again. */
  const byAgent = (from: unknown) => typeof from === "string" && from.trim() !== "";

  /** Changes moqi's own config file and applies it, the same way the settings page does. */
  const updateConfig = async (change: (c: Config) => Config) => {
    if (asker.pending()) throw new HttpError(409, "moqi 正在等你回答一个问题，先回答再改");
    const parsed = ConfigSchema.safeParse(change(readConfigFile(home.dir)));
    if (!parsed.success)
      throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；"));
    saveConfig(home.dir, parsed.data);
    await home.reconfigure(loadConfig(home.dir, env));
  };

  /** The page's todo buttons. What is wrong comes back as a 400 with the same words the model would get. */
  const todoCall = async (tool: string, args: Record<string, unknown>) => {
    const problem = home.moqi.checkTool(tool, args);
    if (problem) throw new HttpError(400, problem);
    // Deleting on the page is the user's own decision, so it does not ask again.
    const how = { byUser: true, ...(tool === "todo_remove" && { preApproved: true }) };
    return { message: await home.serial(() => home.moqi.callTool(tool, args, how)) };
  };

  const routes: Record<string, (body: Record<string, unknown>, url: URL) => Promise<unknown> | unknown> = {
    "GET /api/state": () => {
      const moqi = home.moqi;
      const now = moqi.clock.now();
      const messages = moqi.store
        .all()
        .flatMap((e) =>
          e.type === "message" ? [{ role: e.role, text: e.text, at: e.at, ...(e.images && { images: e.images }) }] : [],
        )
        .slice(-60);
      const offers = moqi.state.openOffers(now).flatMap((o) => {
        const record = moqi.state.offers.get(o.id);
        if (!record?.surface) return []; // dropped offers never show
        return [
          {
            id: o.id,
            kind: o.kind,
            title: o.title,
            body: o.body,
            at: o.createdAt,
            action: !!o.action,
            answer: o.answer === "text",
            links: o.links ?? [],
            surface: record.surface,
            ...(o.kind === "code.done" && { taskId: o.about ?? "" }),
          },
        ];
      });
      const thoughts = moqi.state.thoughts
        .slice(-8)
        .reverse()
        .map((t) => ({
          at: t.at,
          trigger: t.trigger,
          error: t.error ?? null,
          ideas: t.ideas.map((idea) => {
            const record = idea.offerId ? moqi.state.offers.get(idea.offerId) : undefined;
            const verdict = record?.verdict ? VERDICT_WORDS[record.verdict] : "";
            const outcome = idea.skipped ? `没说：${idea.skipped}` : (record?.reason ?? "");
            return {
              type: idea.type,
              title: idea.title,
              value: idea.value,
              outcome: verdict ? `${outcome} · ${verdict}` : outcome,
              offerId: idea.offerId ?? null,
            };
          }),
        }));
      const facts = [...moqi.state.facts.values()]
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .map((f) => ({
          id: f.id,
          kind: f.kind,
          content: f.content,
          term: f.term,
          confirmations: f.confirmations,
          faded: isFaded(f, now),
          by: f.by ?? null,
        }));
      const watches = [...moqi.state.watches.values()].map((w) => ({
        id: w.id,
        title: w.title,
        schedule: describeSchedule(w.schedule),
        last: w.last?.headline ?? null,
      }));
      const todo = (t: Todo) => ({
        id: t.id,
        text: t.text,
        day: t.day,
        remindAt: t.remindAt ?? null,
        by: t.by ?? null,
        late: daysLate(t, now),
        doneAt: t.doneAt ?? null,
      });
      const todos = {
        today: todayTodos(moqi.state, now).map(todo),
        later: laterTodos(moqi.state, now).map(todo),
        done: recentlyDone(moqi.state, now).map(todo),
      };
      return {
        configured: !!moqi.model,
        busy: chatting > 0,
        question: asker.pending() ?? null,
        thinking: moqi.isReflecting,
        studying: moqi.isStudying,
        lessons: [...moqi.state.lessons.values()].reverse(),
        notes: [...moqi.state.notes.values()].reverse().slice(0, 30),
        lastStudy: moqi.state.studies.at(-1) ?? null,
        messages,
        offers,
        history: seenOffers(moqi.state, now).map((s) => ({
          id: s.record.offer.id,
          kind: s.record.offer.kind,
          title: s.record.offer.title,
          body: s.record.offer.body,
          links: s.record.offer.links ?? [],
          at: s.record.offer.createdAt,
          decidedAt: s.decidedAt,
          outcome: s.outcome,
          ...(s.task && {
            taskId: s.task.task.id,
            stat: s.task.stat ?? "",
            canDiff: s.task.status === "merged" && s.task.head !== undefined,
          }),
        })),
        facts,
        watches,
        todos,
        code: [...moqi.state.codeTasks.values()]
          .filter((t) => t.status === "running" || now - (t.finishedAt ?? t.task.startedAt) < 30 * 86_400_000)
          .reverse()
          .map((t) => ({
            id: t.task.id,
            agent: home.code.label(t.task.agent),
            project: lastSegment(t.task.project),
            task: t.task.task,
            status: t.status,
            startedAt: t.task.startedAt,
            branch: t.task.branch,
            files: t.files?.length ?? 0,
            ...((t.status === "done" || t.status === "failed") && { into: home.code.currentBranch(t.task.project) }),
          })),
        thoughts,
        vision: home.config.model?.vision ?? null,
      };
    },

    "POST /api/chat": async (body) => {
      const text = str(body.text, "text").trim();
      const images = Array.isArray(body.images) ? body.images : [];
      if (text === "" && images.length === 0) throw new HttpError(400, "说点什么吧");
      if (text.length > 4000) throw new HttpError(400, "一次说得太长了");
      if (images.length > 4) throw new HttpError(400, "一次最多 4 张图片");
      if (images.length > 0 && body.from !== undefined) throw new HttpError(400, "别的 agent 只能发文字");
      if (!images.every((id) => typeof id === "string" && home.media.read(id)))
        throw new HttpError(400, "有一张图片找不到了，重新加一下");
      if (!home.moqi.model) throw new HttpError(409, "还没配置模型，先去设置里接一个");
      chatting++;
      try {
        return {
          reply: await home.serial(() =>
            home.moqi.chat(fromAgent(text, body.from), undefined, {
              fromAgent: byAgent(body.from),
              ...(images.length > 0 && { images: images as string[] }),
            }),
          ),
        };
      } catch (error) {
        throw new HttpError(502, `模型出错了：${message(error)}`);
      } finally {
        chatting--;
      }
    },

    "POST /api/answer": async (body) => {
      const id = str(body.id, "id");
      const text = str(body.text, "text");
      return { message: await home.serial(() => home.moqi.answer(id, text)) };
    },

    // For other agents (through `moqi mcp`): what they learned about the user, and what they want to tell them.
    "POST /api/remember": async (body) => {
      const content = str(body.content, "content").trim();
      if (content === "") throw new HttpError(400, "content 是空的");
      const kind =
        typeof body.kind === "string" && FACT_KINDS.includes(body.kind as FactKind) ? (body.kind as FactKind) : "other";
      // Only other agents call this; what they write counts as outside content in later conversations.
      const by = byAgent(body.from) ? String(body.from).trim().slice(0, 40) : "另一个 agent";
      return { message: await home.serial(async () => home.moqi.remember({ kind, content, by })) };
    },

    "POST /api/tell": async (body) => {
      const title = str(body.title, "title").trim().slice(0, 120);
      if (title === "") throw new HttpError(400, "title 是空的");
      const from = (typeof body.from === "string" ? body.from : "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 32);
      const urgency = ["now", "today", "whenever"].includes(String(body.urgency)) ? (body.urgency as Urgency) : "today";
      const value = Math.min(0.85, Math.max(0, typeof body.value === "number" ? body.value : 0.6)); // never breaks quiet hours
      const offer = await home.serial(() =>
        home.moqi.offer({
          kind: `agent.${from || "other"}`,
          title,
          body: typeof body.body === "string" ? body.body.slice(0, 2000) : "",
          value,
          urgency,
        }),
      );
      const record = home.moqi.state.offers.get(offer.id);
      return { id: offer.id, surface: record?.dropped ? "drop" : record?.surface, reason: record?.reason ?? "" };
    },

    "GET /api/agents": () => {
      const a = home.agents;
      if (!a) return { agents: [] };
      return { agents: findAgents(a.home, a.platform).map((x) => ({ ...x, path: tilde(x.path, a.home) })) };
    },

    "POST /api/agents/connect": (body) => {
      const a = home.agents;
      if (!a) throw new HttpError(404, "没有开启找 agent");
      try {
        return { path: tilde(connectAgent(str(body.id, "id"), a.command, a.home, a.platform), a.home) };
      } catch (error) {
        throw new HttpError(409, message(error));
      }
    },

    "POST /api/agents/disconnect": (body) => {
      const a = home.agents;
      if (!a) throw new HttpError(404, "没有开启找 agent");
      try {
        return { path: tilde(disconnectAgent(str(body.id, "id"), a.home, a.platform), a.home) };
      } catch (error) {
        throw new HttpError(409, message(error));
      }
    },

    "POST /api/study": async () => {
      if (!home.moqi.model) throw new HttpError(409, "还没配置模型，先去设置里接一个");
      return { learned: await home.moqi.study("user") };
    },

    "POST /api/learned/remove": async (body) => {
      const id = str(body.id, "id");
      return { message: await home.serial(async () => home.moqi.forgetLearned(id)) };
    },

    // What moqi uses from other agents (MCP servers, A2A agents) and how others reach it (A2A).
    "GET /api/interop": (_body, url) => {
      const file = readConfigFile(home.dir);
      const status = new Map(home.mcpStatus().map((s) => [s.name, s]));
      const servers = Object.entries(file.mcp?.servers ?? {}).map(([name, c]) => ({
        name,
        command: [c.command, ...(c.args ?? [])].join(" "),
        state: status.get(name)?.state ?? "stopped",
        tools: status.get(name)?.tools.length ?? 0,
        error: status.get(name)?.error ?? null,
      }));
      const own = new Set(servers.map((s) => s.name));
      const importable = home.agents
        ? importableServers(home.agents.home, home.agents.platform)
            .filter((s) => !own.has(s.name))
            .map((s) => ({
              name: s.name,
              from: s.from,
              command: [s.config.command, ...(s.config.args ?? [])].join(" "),
            }))
        : [];
      return {
        servers,
        importable,
        a2a: {
          card: options.a2aKey ? `${url.protocol}//${url.host}${AGENT_CARD_PATH}` : null,
          key: options.a2aKey ?? null,
          agents: (file.a2a?.agents ?? []).map((a) => ({ name: a.name, url: a.url, hasKey: !!a.key })),
        },
      };
    },

    "POST /api/preset": async (body) => {
      if (body.name !== "browser") throw new HttpError(400, "没有这个能力包");
      const on = body.on === true;
      if (on) mkdirSync(join(home.dir, "browser"), { recursive: true, mode: 0o700 });
      await updateConfig((c) => {
        const { browser: _old, ...rest } = c.mcp?.servers ?? {};
        return { ...c, mcp: { servers: on ? { ...rest, browser: browserPreset(home.dir) } : rest } };
      });
      return { ok: true };
    },

    "POST /api/mcp/add": async (body) => {
      const name = str(body.name, "name").trim();
      const command = str(body.command, "command").trim();
      const args = Array.isArray(body.args) ? body.args.filter((a): a is string => typeof a === "string") : [];
      await updateConfig((c) => ({
        ...c,
        mcp: { servers: { ...c.mcp?.servers, [name]: { command, ...(args.length && { args }) } } },
      }));
      return { ok: true };
    },

    "POST /api/mcp/import": async (body) => {
      const names = Array.isArray(body.names) ? body.names.filter((n): n is string => typeof n === "string") : [];
      const picked = home.agents
        ? importableServers(home.agents.home, home.agents.platform).filter((s) => names.includes(s.name))
        : [];
      if (picked.length === 0) throw new HttpError(404, "没找到这些工具");
      await updateConfig((c) => {
        const servers = { ...c.mcp?.servers };
        for (const s of picked) servers[s.name] = s.config;
        return { ...c, mcp: { servers } };
      });
      return { ok: true, names: picked.map((s) => s.name) };
    },

    "POST /api/mcp/remove": async (body) => {
      const name = str(body.name, "name");
      await updateConfig((c) => {
        const { [name]: _gone, ...servers } = c.mcp?.servers ?? {};
        return { ...c, mcp: { servers } };
      });
      return { ok: true };
    },

    "POST /api/a2a/add": async (body) => {
      const agent = {
        name: str(body.name, "name").trim(),
        url: str(body.url, "url").trim(),
        ...(typeof body.key === "string" && body.key.trim() && { key: body.key.trim() }),
      };
      await updateConfig((c) => ({
        ...c,
        a2a: { agents: [...(c.a2a?.agents ?? []).filter((a) => a.name !== agent.name), agent] },
      }));
      return { ok: true };
    },

    "POST /api/a2a/remove": async (body) => {
      const name = str(body.name, "name");
      await updateConfig((c) => ({ ...c, a2a: { agents: (c.a2a?.agents ?? []).filter((a) => a.name !== name) } }));
      return { ok: true };
    },

    "POST /api/reflect": async () => {
      if (!home.moqi.model) throw new HttpError(409, "还没配置模型，先去设置里接一个");
      const ideas = await home.moqi.reflect("user");
      return { ideas: ideas.length };
    },

    "POST /api/confirm": (body) => {
      if (!asker.answer(str(body.id, "id"), body.yes === true, body.always === true))
        throw new HttpError(409, "这个问题已经过期了");
      return { ok: true };
    },

    "POST /api/offer": async (body) => {
      const verdict = str(body.verdict, "verdict");
      if (!["accepted", "dismissed", "muted"].includes(verdict)) throw new HttpError(400, "verdict 不对");
      const id = str(body.id, "id");
      return { message: await home.serial(() => home.moqi.feedback(id, verdict as Verdict)) };
    },

    "POST /api/forget": async (body) => {
      const id = str(body.id, "id");
      // Pressing "delete" on the page is the user's own decision, so it does not ask again.
      return {
        message: await home.serial(() => home.moqi.callTool("forget", { id }, { byUser: true, preApproved: true })),
      };
    },

    "GET /api/code/agents": () => ({ kiro: home.code.available("kiro"), claude: home.code.available("claude") }),

    "GET /api/code/diff": async (_body, url) => {
      const t = home.moqi.state.codeTasks.get(url.searchParams.get("id") ?? "");
      if (!t) throw new HttpError(404, "没有这个任务");
      if (t.status === "discarded") throw new HttpError(409, "这个任务丢弃了，改动没有留下");
      if (t.status === "merged" && !t.head) throw new HttpError(409, "这个任务合并前没记下提交，看不了改动");
      return { diff: await home.code.diff(t.task, t.status === "merged" ? t.head : undefined) };
    },

    "POST /api/code/stop": (body) => {
      if (!home.code.stop(str(body.id, "id"))) throw new HttpError(409, "这个任务已经不在跑了");
      return { ok: true };
    },

    "POST /api/code/discard": async (body) => {
      const id = str(body.id, "id");
      const problem = home.moqi.checkTool("code_discard", { id });
      if (problem) throw new HttpError(400, problem);
      // Pressing "discard" twice on the page is the user's own decision, so it does not ask again.
      const message = await home.serial(async () => {
        const said = await home.moqi.callTool("code_discard", { id }, { byUser: true, preApproved: true });
        for (const o of home.moqi.state.openOffers(home.moqi.clock.now()))
          if (o.kind === "code.done" && o.action?.args.id === id) await home.moqi.feedback(o.id, "dismissed");
        return said;
      });
      return { message };
    },

    "GET /api/tools": () => ({
      tools: home.moqi.dangerousTools(),
      ordinary: home.moqi.ordinaryTools().map((t) => ({ ...t, label: ORDINARY_LABELS[t.name] ?? t.name })),
      sites: home.moqi.rememberedSites(),
    }),

    "POST /api/tool-policy": async (body) => {
      const name = str(body.tool, "tool");
      const policy = str(body.policy, "policy");
      if (!["ask", "auto", "normal"].includes(policy)) throw new HttpError(400, "policy 只能是 ask、auto 或 normal");
      const tool = home.moqi.tool(name);
      if (!tool?.danger || tool.hidden) throw new HttpError(400, `${name} 不是能在这里设置的工具`);
      return {
        message: await home.serial(async () => home.moqi.setToolPolicy(name, policy as "ask" | "auto" | "normal")),
      };
    },

    "POST /api/tool-policy/source": async (body) => {
      const source = str(body.source, "source");
      const policy = str(body.policy, "policy");
      if (policy !== "ask" && policy !== "auto") throw new HttpError(400, "policy 只能是 ask 或 auto");
      if (!home.moqi.dangerousTools().some((t) => t.source === source))
        throw new HttpError(400, `${source} 没有会改动东西的工具`);
      return { message: await home.serial(async () => home.moqi.setSourcePolicy(source, policy)) };
    },

    "POST /api/tool-level": async (body) => {
      const name = str(body.tool, "tool");
      const level = str(body.level, "level");
      if (level !== "ask" && level !== "auto") throw new HttpError(400, "level 只能是 ask 或 auto");
      if (!home.moqi.ordinaryTools().some((t) => t.name === name))
        throw new HttpError(400, `${name} 不是能在这里设置的工具`);
      return { message: await home.serial(async () => home.moqi.setToolLevel(name, level)) };
    },

    "POST /api/site/forget": async (body) => {
      const host = str(body.host, "host");
      if (!(await home.serial(async () => home.moqi.forgetSite(host)))) throw new HttpError(404, `没有记住 ${host}`);
      return { message: `以后打开 ${host} 会先问你` };
    },

    "POST /api/watch/cancel": async (body) => {
      const id = str(body.id, "id");
      return {
        message: await home.serial(() =>
          home.moqi.callTool("watch_cancel", { id }, { byUser: true, preApproved: true }),
        ),
      };
    },

    "POST /api/todo/add": (body) =>
      todoCall("todo_add", {
        text: str(body.text, "text"),
        ...(typeof body.day === "string" && body.day && { day: body.day }),
        ...(typeof body.at === "string" && body.at && { at: body.at }),
        ...(typeof body.by === "string" && body.by.trim() && { by: body.by.trim().slice(0, 40) }),
      }),
    "POST /api/todo/done": (body) => todoCall("todo_done", { id: str(body.id, "id") }),
    "POST /api/todo/undone": (body) => todoCall("todo_undone", { id: str(body.id, "id") }),
    "POST /api/todo/remove": (body) => todoCall("todo_remove", { id: str(body.id, "id") }),

    "GET /api/briefing": async () => {
      const b = await home.moqi.briefing();
      return { title: b.title, body: b.body };
    },

    "GET /api/config": () => {
      const file = readConfigFile(home.dir);
      const { apiKey, ...model } = file.model ?? { baseURL: "", model: "" };
      return {
        config: { ...file, model: file.model ? model : null },
        hasKey: !!apiKey,
        newsPresets: NEWS_FEEDS,
        platform: process.platform,
        env: { model: !!(env.MOQI_BASE_URL && env.MOQI_MODEL), apiKey: !!env.MOQI_API_KEY },
      };
    },

    "POST /api/config": async (body) => {
      if (asker.pending()) throw new HttpError(409, "moqi 正在等你回答一个问题，先回答再保存");
      const raw = (body.config ?? {}) as Record<string, unknown>;
      const file = readConfigFile(home.dir);
      const model = raw.model as Record<string, unknown> | null | undefined;
      const saved = savedKeyFor(typeof model?.baseURL === "string" ? model.baseURL : "");
      if (model && !model.apiKey && saved) model.apiKey = saved; // a blank key field keeps the saved key
      if (model && model.apiKey === "") delete model.apiKey;
      // What moqi found out about seeing images belongs to that model: kept while it stays, dropped when it changes.
      if (model && typeof model.vision !== "boolean") {
        const old = file.model;
        if (old?.vision !== undefined && old.baseURL === model.baseURL && old.model === model.model)
          model.vision = old.vision;
        else delete model.vision;
      }
      if (raw.model === null) delete raw.model;
      // MCP servers and A2A agents have their own buttons; a page that does not send them keeps them.
      if (raw.mcp === undefined && file.mcp) raw.mcp = file.mcp;
      if (raw.a2a === undefined && file.a2a) raw.a2a = file.a2a;
      const parsed = ConfigSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
        throw new HttpError(
          400,
          `有 ${issues.length} 处要改：${issues.map((i) => `${i.path} ${i.message}`).join("；")}`,
        );
      }
      for (const folder of parsed.data.files?.folders ?? []) {
        let dir = false;
        try {
          dir = statSync(expandHome(folder)).isDirectory();
        } catch {
          dir = false;
        }
        if (!dir) throw new HttpError(400, `文件夹「${folder}」不存在，或者不是文件夹`);
      }
      for (const p of parsed.data.code?.projects ?? []) {
        let same = false;
        try {
          const real = realpathSync(expandHome(p.path));
          const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: real, encoding: "utf8" }).trim();
          same = realpathSync(top) === real;
        } catch {
          same = false;
        }
        if (!same) throw new HttpError(400, `「${p.path}」不是 git 仓库的根目录`);
      }
      saveConfig(home.dir, parsed.data);
      await home.reconfigure(loadConfig(home.dir, env));
      return { ok: true };
    },

    "GET /api/shortcuts": async () => {
      const list = await (options.shortcuts ?? (() => listShortcuts()))();
      return { available: list !== undefined, shortcuts: list ?? [] };
    },

    "POST /api/model/test": async (body) => {
      const model = formModel((body.model ?? {}) as Record<string, unknown>);
      const started = Date.now();
      try {
        const reply = await complete(
          model,
          { messages: [{ role: "user", content: "用一句话打个招呼。" }], maxTokens: 1024, reasoning: "off" },
          AbortSignal.timeout(60_000),
        );
        const ms = Date.now() - started;
        // No answer about images (a timeout, a bad key) is not "cannot see": null, and nothing is kept.
        const vision = await canSeeImages(model, AbortSignal.timeout(60_000)).catch(() => null);
        return { ok: true, ms, reply: reply.content.trim().slice(0, 200), vision };
      } catch (error) {
        return { ok: false, ms: Date.now() - started, error: message(error) };
      }
    },

    "POST /api/model/vision": async (body) => {
      if (body.model !== undefined) {
        const model = formModel(body.model as Record<string, unknown>);
        return { vision: await canSeeImages(model, AbortSignal.timeout(60_000)) };
      }
      const current = home.moqi.model;
      if (!current) throw new HttpError(409, "还没配置模型，先去设置里接一个");
      // The model this answer is about, taken now: the settings may change while the check runs.
      const asked = home.config.model && { baseURL: home.config.model.baseURL, model: home.config.model.model };
      let vision: boolean;
      try {
        vision = await canSeeImages(current, AbortSignal.timeout(60_000));
      } catch (error) {
        throw new HttpError(502, `模型出错了：${message(error)}`);
      }
      // Kept with the model it is about; a model from the environment has nowhere to keep it.
      const file = readConfigFile(home.dir);
      if (file.model && asked && file.model.baseURL === asked.baseURL && file.model.model === asked.model) {
        saveConfig(home.dir, { ...file, model: { ...file.model, vision } });
        await home.reconfigure(loadConfig(home.dir, env));
      }
      return { vision };
    },

    "GET /api/geocode": async (_body, url) => {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (q === "" || q.length > 60) throw new HttpError(400, "城市名不对");
      const api = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=zh&format=json`;
      let data: { results?: Record<string, unknown>[] };
      try {
        const response = await doFetch(api, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = (await response.json()) as typeof data;
      } catch (error) {
        throw new HttpError(502, `查不到城市：${message(error)}`);
      }
      return {
        results: (data.results ?? []).map((r) => ({
          name: String(r.name ?? ""),
          region: [r.admin1, r.country].filter((x) => typeof x === "string" && x !== "").join(" · "),
          latitude: Number(r.latitude),
          longitude: Number(r.longitude),
        })),
      };
    },

    "POST /api/calendar/check": (body) => {
      const path = expandHome(str(body.path, "path").trim());
      if (!existsSync(path) || !statSync(path).isFile()) return { exists: false, events: 0 };
      if (statSync(path).size > 5 * 1024 * 1024) throw new HttpError(400, "文件太大了，不像日历");
      try {
        return { exists: true, events: parseIcs(readFileSync(path, "utf8")).length };
      } catch {
        throw new HttpError(400, "读不懂这个文件，确认是 .ics 日历");
      }
    },
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? "";
    // Only the names a browser on this machine would use; blocks DNS rebinding from other sites.
    if (![CONSOLE_HOST, "localhost", "127.0.0.1"].some((name) => host === `${name}:${port}`))
      return send(res, 403, { error: "forbidden" });
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (a2aKey && url.pathname === AGENT_CARD_PATH && req.method === "GET") {
      return send(res, 200, agentCard(`http://${host}`, options.version ?? "0.0.0"));
    }
    if (a2aKey && url.pathname === A2A_PATH && req.method === "POST") {
      if (!same(req.headers.authorization, a2aKey)) {
        return send(res, 401, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "需要 moqi 的 A2A 钥匙：运行 moqi a2a 查看" },
        });
      }
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch (error) {
        return send(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: message(error) } });
      }
      const reply = await handleA2A(body, {
        newId: () => randomUUID(),
        chat: async (text, from) => {
          if (!home.moqi.model) throw new Error("moqi 还没配置模型");
          chatting++;
          try {
            return await home.serial(() =>
              home.moqi.chat(fromAgent(text, from ?? "另一个 agent"), undefined, { fromAgent: true }),
            );
          } finally {
            chatting--;
          }
        },
      });
      return send(res, 200, reply);
    }
    const asset = req.method === "GET" ? assets[url.pathname] : undefined;
    if (asset) {
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": asset.type });
      return void res.end(asset.body);
    }
    if (url.pathname === "/api/media") {
      if (!tokenOk(req.headers["x-moqi-token"])) return send(res, 401, { error: "需要从 moqi 打开的链接进入" });
      try {
        if (req.method === "POST") return send(res, 200, { id: home.media.save(await readImage(req)) });
        if (req.method !== "GET") throw new HttpError(405, "只能上传或读取");
        const id = url.searchParams.get("id") ?? "";
        if (!MEDIA_ID.test(id)) throw new HttpError(400, "图片编号不对");
        const found = home.media.read(id);
        if (!found) throw new HttpError(404, "没有这张图片");
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "Content-Type": found.type,
          "Cache-Control": "private, max-age=31536000, immutable",
        });
        return void res.end(found.bytes);
      } catch (error) {
        return send(res, error instanceof HttpError ? error.status : 500, { error: message(error) });
      }
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, { error: "没有这个地址" });
    if (!tokenOk(req.headers["x-moqi-token"])) return send(res, 401, { error: "需要从 moqi 打开的链接进入" });
    try {
      const body = req.method === "POST" ? await readJson(req) : {};
      send(res, 200, await route(body, url));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      send(res, status, { error: message(error) });
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => send(res, 500, { error: message(error) }));
  });
  port = await listen(server, options.port ?? DEFAULT_PORT);
  return {
    port,
    url: consoleUrl(port, options.token),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && port !== 0) {
        server.listen(0, "127.0.0.1");
        return;
      }
      reject(error);
    };
    server.on("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    });
    server.listen(port, "127.0.0.1");
  });
}

function send(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/** An uploaded image: raw bytes with an image content type, at most MEDIA_MAX, recognised by its header. */
async function readImage(req: IncomingMessage): Promise<Buffer> {
  if (!(req.headers["content-type"] ?? "").startsWith("image/")) throw new HttpError(415, "只收图片");
  if (Number(req.headers["content-length"] ?? 0) > MEDIA_MAX) throw new HttpError(413, "图片太大了，最多 3 MB");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MEDIA_MAX) throw new HttpError(413, "图片太大了，最多 3 MB");
    chunks.push(chunk as Buffer);
  }
  const bytes = Buffer.concat(chunks);
  if (!sniff(bytes)) throw new HttpError(415, "只收 PNG、JPEG、GIF、WebP 图片");
  return bytes;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "只收 JSON");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "内容太长");
    chunks.push(chunk as Buffer);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("not an object");
    return data as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "JSON 格式不对");
  }
}

function tilde(path: string, home: string): string {
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function str(value: unknown, name: string): string {
  if (typeof value !== "string") throw new HttpError(400, `缺少 ${name}`);
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
