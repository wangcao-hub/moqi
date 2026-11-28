import type { TraceEvent } from "taugraph";
import type { LLMModel } from "taugraph/nodes";
import { chatTurn, learn } from "./agent.js";
import { guarded, levelOf, needsConfirmation, promotionDue, rank } from "./autonomy.js";
import { type Briefing, composeBriefing } from "./briefing.js";
import { type CodeResult, type CodeRunner, codeOffer, codeTools } from "./code.js";
import { normalize, type RememberInput, rememberEvents } from "./memory.js";
import { type MediaImage, withMedia } from "./model.js";
import { actionPolicy, type OfferInput, type Plugin, type PluginContext, resultText, type Tool } from "./plugin.js";
import { decide, defaultPolicy, inQuietHours, type Policy } from "./proactive.js";
import { REFLECT, reflect } from "./reflect.js";
import { findRoutines } from "./routines.js";
import { dayKey, describeSchedule, minuteOfDay, nextRun, parseTime } from "./schedule.js";
import {
  hostOf,
  pageHost,
  READS_AFTER_OUTSIDE,
  type SiteGrant,
  seenAddress,
  siteDecision,
  TOO_MANY_READS,
  UNSEEN_ADDRESS,
} from "./sites.js";
import { State } from "./state.js";
import { STUDY, studiedOn, study } from "./study.js";
import { dueReminders, findRepeatedTodos, reminderOffer, reviewOffer, TODO, TODO_KIND } from "./todo.js";
import { builtinTools, type Kernel } from "./tools.js";
import {
  type Answer,
  type Choices,
  type Clock,
  type EventBody,
  type EventStore,
  type Idea,
  type MoqiEvent,
  memoryEventStore,
  newId,
  type Offer,
  type Surface,
  systemClock,
  type ToolPolicy,
  type Verdict,
} from "./types.js";
import { runWatch } from "./watch.js";

/** Read tools that make no sense on a schedule: they list moqi's own state. */
const UNWATCHABLE = ["list_memories", "watch_list", "todo_list"];

/** Tool names OpenAI and the other providers accept; taugraph/agent refuses any other. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

export interface MoqiOptions {
  readonly store?: EventStore;
  /** Needed for chat and learning. Briefings, watches and routines work without one. */
  readonly model?: LLMModel;
  readonly plugins?: readonly Plugin[];
  readonly clock?: Clock;
  readonly policy?: Partial<Policy>;
  /** Who moqi is to this user. Prepended to the system prompt. */
  readonly persona?: string;
  /** Local "HH:MM" for the daily briefing; null turns it off. Default "08:00". */
  readonly briefingAt?: string | null;
  /** Local "HH:MM" for the evening look at unfinished todos; null turns it off. Default "21:00". */
  readonly todoReviewAt?: string | null;
  /** Shows an offer: a system notification for "notify", a quiet entry for "feed". */
  readonly deliver?: (offer: Offer, surface: Surface) => void | Promise<void>;
  /**
   * Asks the user before an action that has not earned trust yet. `details`: exactly what a dangerous one does.
   * `choices`: extra answers this question offers, e.g. "以后都允许" for a site. Without it, such actions are refused.
   */
  readonly confirm?: (question: string, details?: string, choices?: Choices) => Promise<Answer>;
  /** Think about the user on its own between conversations (needs a model). Default true. */
  readonly reflect?: boolean;
  /** Learn on its own while the user is away: lessons from feedback, notes from articles. Default true. */
  readonly study?: boolean;
  /** Runs coding tasks; absent: no coding agents. */
  readonly code?: CodeRunner;
  /** Reads the images messages refer to, by media id. Without it, images are mentioned as "[图片]". */
  readonly media?: { load(id: string): Promise<MediaImage | undefined> };
  /**
   * Receives the trace of every conversation turn and every watch run, event by event (taugraph's `onEvent`).
   * It is called synchronously for each event and not awaited. A trace is for looking back and replaying; a
   * failure to store it, thrown or rejected, never stops moqi.
   */
  readonly onTrace?: (event: TraceEvent) => void;
}

export interface TickReport {
  readonly watchesRun: number;
  readonly offers: readonly Offer[];
}

export class Moqi {
  readonly state: State;
  readonly store: EventStore;
  readonly clock: Clock;
  readonly model: LLMModel | undefined;
  /** `onTrace` made harmless: the event log is moqi's record, a trace only helps to look back. */
  readonly onTrace: ((event: TraceEvent) => void) | undefined;
  readonly policy: Policy;
  readonly persona: string;
  readonly plugins: readonly Plugin[];
  private readonly tools = new Map<string, Tool>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly sources = new Map<string, string>();
  /** Where web tools come from: every tool of such a source reports which page the browser is on. */
  private readonly browsers = new Set<string>();
  private thinking: Promise<Idea[]> | undefined;
  private studying: Promise<number> | undefined;
  private readonly options: MoqiOptions;

  constructor(options: MoqiOptions = {}) {
    this.options = options;
    this.store = options.store ?? memoryEventStore();
    this.clock = options.clock ?? systemClock;
    // Messages refer to images as media:<id>; they are read when a request is sent, so traces keep only the id.
    this.model = options.model && withMedia(options.model, (id) => this.loadImage(id));
    const onTrace = options.onTrace;
    this.onTrace =
      onTrace &&
      ((event) => {
        try {
          const stored: unknown = onTrace(event);
          // not awaited: a sink that rejects loses its trace, never the conversation (nor the process)
          if (isThenable(stored)) stored.then(undefined, () => {});
        } catch {
          // a trace that cannot be stored is lost; the conversation goes on
        }
      });
    this.policy = { ...defaultPolicy, ...options.policy };
    this.persona = options.persona ?? "你是 moqi（默契），用户的个人助理。你话少、靠谱，先替用户想到，再开口。";
    this.plugins = options.plugins ?? [];
    this.state = State.from(this.store.all());
    const kernel: Kernel = {
      now: () => this.clock.now(),
      remember: (input) => this.remember(input),
      emit: (body) => void this.emit(body),
      state: this.state,
      toolNames: () => [...this.tools.keys()],
      isReadTool: (name) => this.isWatchable(name),
      readTools: () => [...this.tools.values()].filter((t) => this.isWatchable(t.name)).map((t) => t.name),
    };
    const owned: [Tool, string][] = [
      ...builtinTools(kernel).map((t): [Tool, string] => [t, "moqi"]),
      ...(options.code ? codeTools(kernel, options.code).map((t): [Tool, string] => [t, t.source ?? "moqi"]) : []),
      ...this.plugins.flatMap((p) => (p.tools ?? []).map((t): [Tool, string] => [t, t.source ?? p.name])),
    ];
    for (const [tool, source] of owned) {
      if (!TOOL_NAME.test(tool.name)) throw new Error(`Tool name "${tool.name}" must match ^[A-Za-z0-9_-]{1,64}$`);
      if (this.tools.has(tool.name)) throw new Error(`Two tools are named "${tool.name}"`);
      this.tools.set(tool.name, tool);
      this.sources.set(tool.name, source);
      if (tool.site) this.browsers.add(source);
    }
  }

  /** Appends an event and folds it into the state. The only way state changes. */
  emit(body: EventBody): MoqiEvent {
    const event = { ...body, id: newId("e", this.clock), at: this.clock.now() } as MoqiEvent;
    this.store.append(event);
    this.state.apply(event);
    return event;
  }

  /** Keeps a background job (like learning) alive until it settles. Errors are swallowed by the job itself. */
  track(job: Promise<unknown>): void {
    const settled = job.catch(() => {}).finally(() => this.background.delete(settled));
    this.background.add(settled);
  }

  /** Resolves when background work started so far has finished. */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.all([...this.background]);
  }

  /** An image a message refers to, for the model; undefined when it is gone or there is no media. */
  async loadImage(id: string): Promise<MediaImage | undefined> {
    return (await this.options.media?.load(id)) ?? undefined;
  }

  /** One conversation turn. `fromAgent`: another agent wrote it, so it counts as outside content. `images`: media ids. */
  chat(
    text: string,
    signal?: AbortSignal,
    how?: { readonly fromAgent?: boolean; readonly images?: readonly string[] },
  ): Promise<string> {
    return chatTurn(this, text, signal, how);
  }

  /** Read tools a watch may call on a schedule. */
  private isWatchable(name: string): boolean {
    const tool = this.tools.get(name);
    return !!tool && tool.effect === "read" && !tool.hidden && !tool.noWatch && !UNWATCHABLE.includes(name);
  }

  visibleTools(): Tool[] {
    return [...this.tools.values()].filter((t) => !t.hidden);
  }

  tool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Who provides a tool: an MCP server or A2A agent, a plugin, or "moqi" for its own. */
  sourceOf(name: string): string {
    return this.sources.get(name) ?? "moqi";
  }

  /** Dangerous tools and what the user decided about each, for the settings. */
  dangerousTools(): { name: string; source: string; description: string; policy: ToolPolicy }[] {
    return [...this.tools.values()]
      .filter((t) => t.danger && !t.hidden) // a hidden one only ever runs from the user's own tap
      .map((t) => ({
        name: t.name,
        source: this.sourceOf(t.name),
        description: t.description,
        policy: this.state.toolPolicies.get(t.name) ?? "ask",
      }));
  }

  /** The user's decision about one dangerous tool. Only the user makes it: no tool and no offer calls this. */
  setToolPolicy(name: string, policy: ToolPolicy): string {
    this.emit({ type: "tool.policy", tool: name, policy });
    if (policy === "auto") return `以后 ${name} 直接办；这一轮读过外部内容时仍会先问`;
    if (policy === "normal") return `${name} 按普通动作处理了`;
    return `${name} 每次都会先问你`;
  }

  /** The user's decision for every dangerous tool of one source at once, the same as deciding each in turn. */
  setSourcePolicy(source: string, policy: "ask" | "auto"): string {
    const tools = this.dangerousTools().filter((t) => t.source === source);
    if (tools.length === 0) throw new Error(`${source} 没有会改动东西的工具`);
    for (const t of tools) this.emit({ type: "tool.policy", tool: t.name, policy });
    return policy === "auto"
      ? `把 ${source} 的 ${tools.length} 个工具都放开了；这一轮读过外部内容时仍会先问`
      : `${source} 的 ${tools.length} 个工具以后每次都先问`;
  }

  /** Sites the user allowed for good, in order. */
  rememberedSites(): string[] {
    return [...this.state.sites].sort();
  }

  /** The user's own decision to stop allowing a site for good. False when it was not remembered. */
  forgetSite(host: string): boolean {
    if (!this.state.sites.has(host)) return false;
    this.emit({ type: "site.forgotten", host });
    return true;
  }

  /** Write tools the user may let run without asking: visible, not dangerous, asked first, allowed higher. */
  ordinaryTools(): { name: string; source: string; level: "ask" | "auto" }[] {
    return [...this.tools.values()]
      .filter((t) => this.isOrdinary(t))
      .map((t) => ({
        name: t.name,
        source: this.sourceOf(t.name),
        level: rank(levelOf(this.state, t.name, actionPolicy(t))) <= rank("suggest") ? "ask" : "auto",
      }));
  }

  /** The user's own switch for one ordinary tool, the same level the trust ladder raises. */
  setToolLevel(name: string, level: "ask" | "auto"): string {
    const tool = this.tools.get(name);
    if (!tool || !this.isOrdinary(tool)) throw new Error(`${name} 不是能在这里设置的工具`);
    this.emit({ type: "level.changed", kind: name, level: level === "ask" ? "suggest" : actionPolicy(tool).cap });
    return level === "ask" ? `${name} 以后先问你` : `以后 ${name} 直接办，办完告诉你`;
  }

  private isOrdinary(tool: Tool): boolean {
    const p = actionPolicy(tool);
    return (
      tool.effect === "write" &&
      tool.hidden !== true &&
      tool.danger !== true &&
      rank(p.start) <= rank("suggest") &&
      rank(p.cap) > rank("suggest")
    );
  }

  /** Read tools a watch may use, e.g. for reflection to suggest one. */
  watchableTools(): Tool[] {
    return [...this.tools.values()].filter((t) => this.isWatchable(t.name));
  }

  /** What is wrong with a call, without running it or asking anyone; undefined when it would work. */
  checkTool(name: string, args: unknown): string | undefined {
    const tool = this.tools.get(name);
    if (!tool) return `没有工具 ${name}`;
    const parsed = tool.input.safeParse(args);
    if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ");
    return tool.validate?.(parsed.data, { now: () => this.clock.now(), state: this.state });
  }

  get isReflecting(): boolean {
    return this.thinking !== undefined;
  }

  get isStudying(): boolean {
    return this.studying !== undefined;
  }

  /** Learns something now: lessons when there is new feedback to review, otherwise from an article. */
  study(trigger: "timer" | "user" = "user"): Promise<number> {
    if (this.studying) return this.studying;
    const run = study(this, trigger).finally(() => {
      this.studying = undefined;
    });
    this.studying = run;
    this.track(run);
    return run;
  }

  /** The user deletes something moqi learned. */
  forgetLearned(id: string): string {
    if (this.state.lessons.has(id)) {
      this.emit({ type: "lesson.removed", lessonId: id });
      return "这条经验删掉了";
    }
    if (this.state.notes.has(id)) {
      this.emit({ type: "note.removed", noteId: id });
      return "这条笔记删掉了";
    }
    return `没有 ${id}`;
  }

  /** The host's word that a coding task ended. Recorded once, then offered to the user. */
  codeFinished(taskId: string, result: CodeResult): void {
    const t = this.state.codeTasks.get(taskId);
    if (t?.status !== "running") return;
    this.emit({
      type: "code.finished",
      taskId,
      ok: result.ok,
      summary: result.summary,
      files: result.files,
      stat: result.stat,
      ...(result.error && { error: result.error }),
      ...(result.head && { head: result.head }),
    });
    void this.offer(
      codeOffer(t.task, result, this.options.code?.label(t.task.agent) ?? t.task.agent, this.clock.now()),
    );
  }

  /** After a restart: tasks the log calls running but no process runs any more were cut short. */
  recoverCode(): void {
    const live = new Set(this.options.code?.running() ?? []);
    for (const [id, t] of this.state.codeTasks)
      if (t.status === "running" && !live.has(id))
        this.codeFinished(id, { ok: false, summary: "", files: [], stat: "", error: "moqi 重启了，任务中断" });
  }

  /** Thinks about the user now and offers what comes of it. One reflection at a time. */
  reflect(trigger: "timer" | "chat" | "user" = "user"): Promise<Idea[]> {
    if (this.thinking) return this.thinking;
    const run = reflect(this, trigger).finally(() => {
      this.thinking = undefined;
    });
    this.thinking = run;
    this.track(run);
    return run;
  }

  /** The user's answer to a question moqi asked. It goes into the conversation and is learned from at once. */
  async answer(offerId: string, text: string): Promise<string> {
    const record = this.state.offers.get(offerId);
    if (!record) return `没有 ${offerId}`;
    if (record.offer.answer !== "text") return "这条不是问题";
    if (record.verdict) return "这条已经处理过了";
    const reply = text.trim().slice(0, 1000);
    if (reply === "") return "回答是空的";
    this.emit({ type: "offer.feedback", offerId, verdict: "accepted" });
    this.emit({ type: "message", role: "assistant", text: record.offer.title });
    this.emit({ type: "message", role: "user", text: reply });
    this.track(learn(this));
    return "记下了，谢谢";
  }

  /** Remembers, confirms, or raises a contradiction for the user to settle. Returns a short note. */
  remember(input: RememberInput): string {
    const events = rememberEvents(this.state, input, this.clock);
    for (const body of events) {
      this.emit(body);
      if (body.type === "fact.contradicted") {
        const c = this.state.conflicts.get(body.factId);
        if (c) {
          void this.offer({
            kind: "memory.conflict",
            title: "需要你定一下",
            body: `你之前说「${c.old}」，现在说「${c.new}」。接受＝以新的为准，忽略＝保留原来的。`,
            value: 0.6,
            urgency: "whenever",
            action: { tool: "resolve_conflict", args: { id: c.factId, keep: "new" } },
          });
        }
      }
    }
    const e = events[0];
    if (!e) return "没什么新的要记";
    if (e.type === "fact.added") return `记住了：${e.fact.content}`;
    if (e.type === "fact.confirmed") return "这条之前就记着，又印证了一次";
    return "这和之前记的不一样，已经请用户定";
  }

  /**
   * Runs a tool through the trust gate. Actions that have not earned trust are confirmed first
   * (`preApproved` when the user already said yes, e.g. by accepting an offer).
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    how: {
      byUser: boolean;
      preApproved?: boolean;
      confirmed?: boolean;
      tainted?: boolean;
      sites?: SiteGrant;
      images?: string[]; // where images a tool brings back are collected
    },
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `没有工具 ${name}`;
    const parsed = tool.input.safeParse(args);
    if (!parsed.success)
      return `参数不对：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`;
    const ctx = { now: () => this.clock.now(), state: this.state, ...(how.tainted && { tainted: true }) };
    const problem = tool.validate?.(parsed.data, ctx);
    if (problem) return `参数不对：${problem}`; // back to the model; never ask the user to approve a broken call
    // After outside content, an address the model put together is not read; asking would only teach the user to say yes.
    // The tool gets the address as it was compared, so what goes out is what was checked.
    if (how.tainted === true && how.sites?.seen) {
      const data = parsed.data as Record<string, unknown>;
      if (tool.readsUrl) {
        const url = seenAddress(how.sites.seen, typeof data.url === "string" ? data.url : "");
        if (!url) return UNSEEN_ADDRESS;
        if ((how.sites.reads ?? 0) >= READS_AFTER_OUTSIDE) return TOO_MANY_READS;
        how.sites.reads = (how.sites.reads ?? 0) + 1;
        data.url = url;
      }
      // A call that has another tool run later with its arguments (watch_create's { tool, args }) would carry the
      // address out of the turn, where nothing checks it; any such call is checked here, not only watch_create.
      const inner = typeof data.tool === "string" ? this.tools.get(data.tool) : undefined;
      if (inner?.readsUrl && typeof data.args === "object" && data.args !== null) {
        const innerArgs = data.args as Record<string, unknown>;
        const url = seenAddress(how.sites.seen, typeof innerArgs.url === "string" ? innerArgs.url : "");
        if (!url) return UNSEEN_ADDRESS;
        innerArgs.url = url;
      }
    }
    const policy = actionPolicy(tool);
    const guard = guarded(this.state, name, policy);
    const chosen = this.state.toolPolicies.get(name) ?? "ask";
    // Within a turn, a site the user agreed to (in this turn or for good) may be browsed without asking again:
    // while the tool is asked about, and, once the user unlocked it, after the turn read outside content.
    const bySite = guard && (chosen === "ask" || (chosen === "auto" && how.tainted === true));
    const site =
      bySite && tool.site && how.sites
        ? siteDecision(tool.site, args, {
            granted: new Set([...how.sites.granted, ...this.state.sites]),
            current: how.sites.current,
          })
        : undefined;
    if (site && "host" in site) {
      const answer = await this.ask(
        `要我打开 ${site.host} 吗？`,
        `这一轮里在 ${site.host} 上打开页面、点击、翻页不再问；输入文字、上传、执行脚本仍会问。\n\n${site.url}`,
        { always: "以后都允许" },
      );
      this.emit({ type: "approval", kind: name, approved: answer !== false });
      if (answer === false) return "用户没有同意，这一步没做";
      how.sites?.granted.add(site.host);
      if (answer === "always" && !this.state.sites.has(site.host))
        this.emit({ type: "site.remembered", host: site.host });
    } else if (!site) {
      // A dangerous action is confirmed with exactly what it does, even when an offer was accepted:
      // the offer's words are the model's and may not match its action. `confirmed`: the user tapped this
      // very action on a card moqi itself made, so there is nothing left to show them.
      const confirmed = how.preApproved === true && how.confirmed === true;
      const offered = how.preApproved === true && guard && !confirmed;
      const preApproved = how.preApproved === true && (!guard || confirmed);
      const tainted = how.tainted === true || offered;
      const asked = !preApproved && needsConfirmation(this.state, name, policy, tainted);
      if (asked || preApproved) {
        const what = tool.describe?.(parsed.data) ?? describeAction(tool, parsed.data as Record<string, unknown>);
        const question =
          guard && !tool.describe
            ? `要我用「${this.sourceOf(name)}」的 ${name} 吗？`
            : `要我${what}${/[A-Za-z0-9]$/.test(what) ? " " : ""}吗？`; // "合并进 main 吗", not "main吗"
        const reason = offered
          ? "offer"
          : tainted && this.state.toolPolicies.get(name) === "auto"
            ? "outside"
            : "danger";
        const more = tool.explain?.(parsed.data);
        const details = tool.danger
          ? `${dangerDetails(args, guard ? reason : undefined)}${more ? `\n\n${more}` : ""}`
          : undefined;
        const approved = preApproved || (await this.ask(question, details)) !== false;
        if (tool.effect === "write") this.emit({ type: "approval", kind: name, approved });
        if (!approved) return "用户没有同意，这一步没做";
      }
      // An unlocked tool opening a site the user's own words led to, before any outside content: that site
      // counts as granted for the rest of the turn, so reading its page does not make every click ask.
      if (guard && tool.site === "goto" && how.sites && chosen === "auto" && how.tainted !== true) {
        const host = typeof args.url === "string" ? hostOf(args.url) : undefined;
        if (host) how.sites.granted.add(host);
      }
    }
    let text: string;
    try {
      const out = await tool.run(parsed.data, ctx);
      text = resultText(out);
      if (how.images && typeof out === "object" && out.images) how.images.push(...out.images);
      // Where the browser ended up decides whether the next move on the page needs asking. Any tool of the
      // browser may move it (typing Enter submits a form); a site tool that does not say where it is leaves
      // the page unknown, so the next move asks.
      if (how.sites && this.browsers.has(this.sourceOf(name))) {
        const host = pageHost(text);
        if (host || tool.site) how.sites.current = host;
      }
      this.emit({ type: "tool.called", tool: name, args, byUser: how.byUser, ok: true });
    } catch (error) {
      this.emit({ type: "tool.called", tool: name, args, byUser: how.byUser, ok: false });
      return `出错了：${error instanceof Error ? error.message : String(error)}`;
    }
    if (tool.effect === "write") await this.offerPromotion(tool);
    return text;
  }

  private async ask(question: string, details?: string, choices?: Choices): Promise<Answer> {
    if (!this.options.confirm) return false;
    if (choices) return this.options.confirm(question, details, choices);
    return details === undefined ? this.options.confirm(question) : this.options.confirm(question, details);
  }

  private async offerPromotion(tool: Tool): Promise<void> {
    const next = promotionDue(this.state, tool.name, actionPolicy(tool));
    if (!next) return;
    const pending = this.state
      .openOffers(this.clock.now())
      .some((o) => o.kind === "trust.promote" && o.action?.args.kind === tool.name);
    if (pending) return;
    await this.offer({
      kind: "trust.promote",
      title: "以后这类事直接办？",
      body: `「${tool.name}」你已经连着同意了好几次。接受后，这类事我直接办，办完告诉你；你随时可以收回。`,
      value: 0.55,
      urgency: "whenever",
      action: { tool: "set_level", args: { kind: tool.name, level: next } },
    });
  }

  /** Creates an offer and lets the policy decide whether it interrupts, waits in the feed, or is dropped. */
  async offer(input: OfferInput): Promise<Offer> {
    const now = this.clock.now();
    const ttl = input.urgency === "whenever" ? 7 * 86_400_000 : 86_400_000;
    const offer: Offer = {
      ...input,
      id: newId("o", this.clock),
      createdAt: now,
      expiresAt: input.expiresAt ?? now + ttl,
    };
    this.emit({ type: "offer.created", offer });
    const decision = decide(this.state, this.policy, offer, now);
    if (decision.surface === "drop") {
      this.emit({ type: "offer.dropped", offerId: offer.id, reason: decision.reason });
    } else {
      this.emit({ type: "offer.delivered", offerId: offer.id, surface: decision.surface, reason: decision.reason });
      await this.options.deliver?.(offer, decision.surface);
    }
    return offer;
  }

  /** The user's answer to an offer. Accepting runs its action with the user's consent. */
  async feedback(offerId: string, verdict: Verdict): Promise<string> {
    const record = this.state.offers.get(offerId);
    if (!record) return `没有 ${offerId}`;
    if (record.verdict) return "这条已经处理过了";
    this.emit({ type: "offer.feedback", offerId, verdict });
    const { offer } = record;
    if (offer.kind === "memory.conflict" && offer.action) {
      const keep = verdict === "accepted" ? "new" : "old";
      return this.callTool("resolve_conflict", { ...offer.action.args, keep }, { byUser: true, preApproved: true });
    }
    if (verdict === "accepted" && offer.action)
      return this.callTool(offer.action.tool, offer.action.args, {
        byUser: true,
        preApproved: true,
        ...(this.ownMerge(offer) && { confirmed: true }),
      });
    if (verdict === "muted") return `以后不再提「${offer.kind}」这类事（/unmute ${offer.kind} 恢复）`;
    return "好";
  }

  /** moqi's own "done" card for a coding task, whose merge the user tapped: nothing about it came from a model. */
  private ownMerge(offer: Offer): boolean {
    const id = offer.action?.args.id;
    const status = typeof id === "string" ? this.state.codeTasks.get(id)?.status : undefined;
    return (
      offer.kind === "code.done" &&
      offer.action?.tool === "code_merge" &&
      offer.about === id &&
      (status === "done" || status === "failed")
    );
  }

  unmute(kind: string): void {
    this.emit({ type: "kind.unmuted", kind });
  }

  /** What plugins get: the clock, the state, and a way to observe and to offer. */
  pluginContext(): PluginContext {
    return {
      now: () => this.clock.now(),
      state: this.state,
      observe: (source, data) => void this.emit({ type: "observation", source, data }),
      offer: (input) => {
        const placeholder = { ...input, id: "pending", createdAt: this.clock.now() } as Offer;
        void this.offer(input);
        return placeholder;
      },
    };
  }

  async briefing(): Promise<Briefing> {
    const ctx = this.pluginContext();
    const sections = [];
    for (const plugin of this.plugins) {
      try {
        const section = await plugin.briefing?.(ctx);
        if (section) sections.push(section);
      } catch {
        // One broken source must not cost the user the whole briefing.
      }
    }
    return composeBriefing(this.state, this.clock.now(), sections);
  }

  /** The proactive heartbeat. Call it every minute or so; it is cheap when nothing is due. */
  async tick(): Promise<TickReport> {
    const now = this.clock.now();
    const before = this.state.offers.size;
    for (const { offer, verdict } of [...this.state.offers.values()]) {
      if (!verdict && offer.expiresAt !== undefined && offer.expiresAt <= now) {
        this.emit({ type: "offer.feedback", offerId: offer.id, verdict: "ignored" });
      }
    }
    const watchesRun = await this.runDueWatches(now);
    await this.remindTodos(now);
    const ctx = this.pluginContext();
    for (const plugin of this.plugins) {
      try {
        await plugin.tick?.(ctx);
      } catch {
        // A failing source is skipped this round.
      }
    }
    await this.maybeBrief(now);
    await this.maybeReviewTodos(now);
    await this.offerRoutines(now);
    await this.offerTodoRoutines(now);
    this.maybeReflect(now);
    this.maybeStudy(now);
    const offers = [...this.state.offers.values()].slice(before).map((r) => r.offer);
    return { watchesRun, offers };
  }

  private async runDueWatches(now: number): Promise<number> {
    const due = [...this.state.watches.values()].filter((w) => w.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt);
    for (const watch of due) {
      const nextAt = nextRun(watch.schedule, now);
      const run = newId("run", this.clock);
      try {
        const outcome = await runWatch(
          watch,
          {
            callTool: async (name, args) => {
              const tool = this.tools.get(name);
              if (tool?.effect !== "read") throw new Error(`托管事务只能用只读工具，${name} 不行`);
              return tool.run(tool.input.parse(args), { now: () => this.clock.now(), state: this.state });
            },
            alert: (headline) => {
              void this.offer({
                kind: "watch.alert",
                title: watch.title,
                body: headline,
                value: 0.75,
                urgency: "today",
              });
            },
          },
          { runId: run, ...(this.onTrace && { onEvent: this.onTrace }) },
        );
        this.emit({
          type: "watch.ran",
          watchId: watch.id,

          value: outcome.value,
          headline: outcome.headline,
          changed: outcome.changed,
          nextAt,
          run,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.emit({
          type: "watch.ran",
          watchId: watch.id,

          value: watch.last?.value ?? "",
          headline: `这次没查成：${reason}`,
          changed: false,
          nextAt,
          run,
        });
      }
    }
    return due.length;
  }

  /** Todos whose reminder time has come. The offer goes first: a reminder twice beats none. */
  private async remindTodos(now: number): Promise<void> {
    for (const todo of dueReminders(this.state, now)) {
      await this.offer(reminderOffer(todo, now));
      this.emit({ type: "todo.reminded", todoId: todo.id });
    }
  }

  /** Every couple of hours while the user is awake, and soon after a conversation settles. In the background. */
  private maybeReflect(now: number): void {
    if (!this.model || this.options.reflect === false || this.thinking || this.studying) return;
    if (inQuietHours(this.policy, now)) return;
    const last = this.state.thoughts.at(-1)?.at ?? 0;
    if (now - last < REFLECT.minGapMs) return;
    const settled = this.state.lastUserMessageAt > last && now - this.state.lastUserMessageAt >= REFLECT.afterChatMs;
    if (settled) void this.reflect("chat");
    else if (now - last >= REFLECT.everyMs) void this.reflect("timer");
  }

  /** While the user is away and awake hours last: a few times a day, never alongside a reflection. */
  private maybeStudy(now: number): void {
    if (!this.model || this.options.study === false || this.thinking || this.studying) return;
    if (inQuietHours(this.policy, now)) return;
    if (now - this.state.lastUserMessageAt < STUDY.idleMs) return;
    if (studiedOn(this.state, now) >= STUDY.perDay) return;
    const last = [...this.state.studies].reverse().find((s) => s.trigger === "timer")?.at ?? 0;
    if (now - last < STUDY.minGapMs) return;
    void this.study("timer");
  }

  private async maybeBrief(now: number): Promise<void> {
    const at = this.options.briefingAt === undefined ? "08:00" : this.options.briefingAt;
    if (at === null) return;
    const { hours, minutes } = parseTime(at);
    if (minuteOfDay(now) < hours * 60 + minutes) return;
    const today = dayKey(now);
    const done = [...this.state.offers.values()].some(
      (r) => r.offer.kind === "briefing" && dayKey(r.offer.createdAt) === today,
    );
    if (done) return;
    const b = await this.briefing();
    await this.offer({
      kind: "briefing",
      title: b.title,
      body: b.body,
      value: b.sections > 0 ? 0.8 : 0.3,
      urgency: "today",
    });
  }

  /** In the evening, what is left today. Within a while after the set time only, never deep into the night. */
  private async maybeReviewTodos(now: number): Promise<void> {
    const at = this.options.todoReviewAt === undefined ? "21:00" : this.options.todoReviewAt;
    if (at === null) return;
    const { hours, minutes } = parseTime(at);
    const since = (minuteOfDay(now) - (hours * 60 + minutes)) * 60_000;
    if (since < 0 || since >= TODO.reviewWindowMs) return;
    const today = dayKey(now);
    const done = [...this.state.offers.values()].some(
      (r) => r.offer.kind === TODO_KIND.review && dayKey(r.offer.createdAt) === today,
    );
    if (done) return;
    const offer = reviewOffer(this.state, now);
    if (offer) await this.offer(offer);
  }

  private async offerRoutines(now: number): Promise<void> {
    const offered = new Set(
      [...this.state.offers.values()]
        .filter((r) => r.offer.kind === "routine.automate")
        .map((r) => String(r.offer.action?.args.routineKey)),
    );
    const watched = new Set(
      [...this.state.watches.values()].map((w) =>
        "tool" in w.check ? `${w.check.tool}:${JSON.stringify(w.check.args)}` : "",
      ),
    );
    const automatable = (name: string) => {
      const tool = this.tools.get(name);
      return !!tool && tool.effect === "read" && !tool.hidden && !tool.noWatch && !UNWATCHABLE.includes(name);
    };
    for (const r of findRoutines(this.state, now, automatable)) {
      if (offered.has(r.key) || watched.has(`${r.tool}:${JSON.stringify(r.args)}`)) continue;
      const when = describeSchedule(r.schedule);
      await this.offer({
        kind: "routine.automate",
        title: "以后不用你问了？",
        body: `这 ${r.days} 天你差不多同一时间都会让我查「${r.tool}」。要不要${when}直接告诉你？`,
        value: 0.6,
        urgency: "whenever",
        action: {
          tool: "watch_create",
          args: {
            title: `${when}的${r.tool}`,
            schedule: r.schedule,
            tool: r.tool,
            args: r.args,
            notify: "always",
            routineKey: r.key,
          },
        },
      });
    }
  }
  /** "You added it three times; the fourth time you shouldn't have to." Each habit is offered once. */
  private async offerTodoRoutines(now: number): Promise<void> {
    const offered = new Set(
      [...this.state.offers.values()]
        .filter((r) => r.offer.kind === TODO_KIND.routine)
        .map((r) => String(r.offer.action?.args.routineKey)),
    );
    const reminded = new Set(
      [...this.state.watches.values()].flatMap((w) => ("remind" in w.check ? [normalize(w.check.remind)] : [])),
    );
    for (const r of findRepeatedTodos(this.state, now)) {
      if (offered.has(r.key) || reminded.has(r.key.slice("todo:".length))) continue;
      await this.offer({
        kind: TODO_KIND.routine,
        title: `以后每天提醒你「${r.text}」？`,
        body: `这 ${r.days} 天你每天都加了这一条。接受后每天 ${r.at} 提醒你，不用再加。`,
        value: 0.6,
        urgency: "whenever",
        action: {
          tool: "watch_create",
          args: { title: r.text, schedule: { every: "day", at: r.at }, remind: r.text, routineKey: r.key },
        },
      });
    }
  }
}

function describeAction(tool: Tool, args: Record<string, unknown>): string {
  const detail = Object.entries(args)
    .filter(([, v]) => (typeof v === "string" && v !== "") || typeof v === "number")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("，");
  return `执行「${tool.name}」${detail ? `（${detail}）` : ""}`;
}

const DETAILS_MAX = 2000;
const WHY = {
  danger: "这是会改动东西的动作，每次都要你确认。",
  outside: "这一轮读到了外部内容（网页、工具结果、别的 agent 写的话或记忆），所以再确认一次。",
  offer: "这是 moqi 提议的动作，确认一下它实际要做的事。",
} as const;

/** Exactly what a dangerous action would do, and why it is asked when the trust ladder is not the reason. */
function dangerDetails(args: Record<string, unknown>, reason?: keyof typeof WHY): string {
  const json = JSON.stringify(args, null, 2);
  const shown =
    json.length > DETAILS_MAX ? `${json.slice(0, DETAILS_MAX)}\n…还有 ${json.length - DETAILS_MAX} 字没显示` : json;
  return reason ? `${WHY[reason]}\n\n${shown}` : shown;
}
