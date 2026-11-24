import { dayKey } from "./schedule.js";
import type {
  CodeTask,
  Conflict,
  Fact,
  Idea,
  Lesson,
  Level,
  MoqiEvent,
  Note,
  Offer,
  Surface,
  Todo,
  ToolPolicy,
  Verdict,
  Watch,
} from "./types.js";

export const RULES = {
  /** Separate confirmations that make a fact long-term. */
  longTermAfter: 3,
  /** A short-term fact not seen for this long stops entering the prompt. */
  fadeAfterMs: 30 * 24 * 3_600_000,
  /** Consecutive approvals before moqi offers to do a kind of action on its own. */
  trustAfter: 3,
  thresholdStart: 0.5,
  thresholdMin: 0.2,
  thresholdMax: 0.95,
  onAccepted: -0.05,
  onDismissed: 0.1,
  onIgnored: 0.03,
} as const;

export interface OfferRecord {
  readonly offer: Offer;
  surface?: Surface;
  /** Why it went where it went (or was dropped), in words for the user. */
  reason?: string;
  dropped?: boolean;
  verdict?: Verdict;
  /** When the user reacted. */
  decidedAt?: number;
}

export interface Study {
  readonly at: number;
  readonly mode: "lessons" | "world";
  readonly trigger: "timer" | "user";
  readonly topic?: string;
  readonly learned: number;
  readonly feedbackSeen: number;
  readonly error?: string;
  readonly skipped?: string;
}

export interface CodeTaskState {
  readonly task: CodeTask;
  readonly status: "running" | "done" | "failed" | "merged" | "discarded";
  readonly summary?: string;
  readonly files?: readonly string[];
  readonly stat?: string;
  readonly error?: string;
  readonly finishedAt?: number;
  /** The commit moqi made, when there were changes. */
  readonly head?: string;
  /** The branch it was merged into. */
  readonly into?: string;
}

export interface Thought {
  readonly at: number;
  readonly trigger: "timer" | "chat" | "user";
  readonly ideas: readonly Idea[];
  readonly error?: string;
}

export interface KindStats {
  threshold: number;
  muted: boolean;
  accepted: number;
  dismissed: number;
  ignored: number;
}

export interface Trust {
  level: Level;
  streak: number;
}

export interface ToolUse {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly at: number;
}

/** Everything derived from the log. Rebuild it any time with `State.from(events)`. */
export class State {
  readonly facts = new Map<string, Fact>();
  readonly conflicts = new Map<string, Conflict>();
  readonly offers = new Map<string, OfferRecord>();
  readonly kinds = new Map<string, KindStats>();
  readonly trust = new Map<string, Trust>();
  readonly toolPolicies = new Map<string, ToolPolicy>();
  /** Sites the user allowed for good ("以后都允许"); opening and browsing there is not asked. */
  readonly sites = new Set<string>();
  readonly watches = new Map<string, Watch>();
  readonly todos = new Map<string, Todo>();
  readonly codeTasks = new Map<string, CodeTaskState>();
  readonly notifiedPerDay = new Map<string, number>();
  readonly userToolUses: ToolUse[] = [];
  /** The most recent reflections, newest last. */
  readonly thoughts: Thought[] = [];
  readonly lessons = new Map<string, Lesson>();
  readonly notes = new Map<string, Note>();
  /** The most recent study sessions, newest last. */
  readonly studies: Study[] = [];
  /** Every answer the user gave to an offer, ignoring included, and every todo they finished or deleted. */
  feedbackCount = 0;
  userMessages = 0;
  /** Every message, the user's and moqi's. */
  messageCount = 0;
  /** The older conversation in a few sentences, and how many messages it covers. */
  summary: { readonly text: string; readonly at: number } | undefined;
  summarized = 0;
  lastUserMessageAt = 0;
  lastEventAt = 0;

  static from(events: readonly MoqiEvent[]): State {
    const state = new State();
    for (const event of events) state.apply(event);
    return state;
  }

  kind(name: string): KindStats {
    let stats = this.kinds.get(name);
    if (!stats) {
      stats = { threshold: RULES.thresholdStart, muted: false, accepted: 0, dismissed: 0, ignored: 0 };
      this.kinds.set(name, stats);
    }
    return stats;
  }

  apply(e: MoqiEvent): void {
    this.lastEventAt = e.at;
    switch (e.type) {
      case "message":
        this.messageCount++;
        if (e.role === "user") {
          this.userMessages++;
          this.lastUserMessageAt = e.at;
        }
        break;
      case "thought":
        this.thoughts.push({ at: e.at, trigger: e.trigger, ideas: e.ideas, ...(e.error && { error: e.error }) });
        if (this.thoughts.length > 50) this.thoughts.shift();
        break;
      case "lesson.learned":
        this.lessons.set(e.lesson.id, e.lesson);
        break;
      case "lesson.removed":
        this.lessons.delete(e.lessonId);
        break;
      case "note.added":
        this.notes.set(e.note.id, e.note);
        break;
      case "note.removed":
        this.notes.delete(e.noteId);
        break;
      case "summary.updated":
        this.summary = { text: e.text, at: e.at };
        this.summarized = e.covered;
        break;
      case "summary.cleared":
        this.summary = undefined;
        this.summarized = e.covered;
        break;
      case "studied": {
        const { type: _t, id: _i, at, ...rest } = e;
        this.studies.push({ at, ...rest });
        if (this.studies.length > 20) this.studies.shift();
        break;
      }
      case "offer.dropped": {
        const r = this.offers.get(e.offerId);
        if (r) {
          r.dropped = true;
          r.reason = e.reason;
        }
        break;
      }
      case "fact.added":
        this.facts.set(e.fact.id, e.fact);
        break;
      case "fact.confirmed": {
        const f = this.facts.get(e.factId);
        if (!f) break;
        const confirmations = f.confirmations + 1;
        const term = confirmations >= RULES.longTermAfter ? "long" : f.term;
        this.facts.set(e.factId, { ...f, confirmations, lastSeenAt: e.at, term });
        break;
      }
      case "fact.contradicted": {
        const f = this.facts.get(e.factId);
        if (f) this.conflicts.set(e.factId, { factId: e.factId, old: f.content, new: e.content, at: e.at });
        break;
      }
      case "fact.resolved": {
        const c = this.conflicts.get(e.factId);
        const f = this.facts.get(e.factId);
        this.conflicts.delete(e.factId);
        // Keeping the new statement replaces the content; the user's decision counts as a confirmation.
        if (c && f && e.keep === "new") {
          // The user chose these words, so they are the user's now, whoever wrote them first.
          const { by: _by, ...mine } = f;
          this.facts.set(e.factId, { ...mine, content: c.new, lastSeenAt: e.at, confirmations: 1, term: "short" });
        }
        if (c && f && e.keep === "old") this.facts.set(e.factId, { ...f, lastSeenAt: e.at });
        break;
      }
      case "fact.forgotten":
        this.facts.delete(e.factId);
        this.conflicts.delete(e.factId);
        break;
      case "offer.created":
        this.offers.set(e.offer.id, { offer: e.offer });
        break;
      case "offer.delivered": {
        const r = this.offers.get(e.offerId);
        if (!r) break;
        r.surface = e.surface;
        if (e.reason) r.reason = e.reason;
        if (e.surface === "notify" && !r.offer.userTimed) {
          const day = dayKey(e.at);
          this.notifiedPerDay.set(day, (this.notifiedPerDay.get(day) ?? 0) + 1);
        }
        break;
      }
      case "offer.feedback": {
        const r = this.offers.get(e.offerId);
        if (!r || r.verdict) break;
        r.verdict = e.verdict;
        r.decidedAt = e.at;
        this.feedbackCount++;
        const k = this.kind(r.offer.kind);
        if (e.verdict === "accepted") {
          k.accepted++;
          k.threshold += RULES.onAccepted;
        } else if (e.verdict === "dismissed") {
          k.dismissed++;
          k.threshold += RULES.onDismissed;
        } else if (e.verdict === "ignored") {
          k.ignored++;
          k.threshold += RULES.onIgnored;
        } else {
          k.muted = true;
        }
        k.threshold = Math.min(RULES.thresholdMax, Math.max(RULES.thresholdMin, k.threshold));
        break;
      }
      case "kind.unmuted":
        this.kind(e.kind).muted = false;
        break;
      case "tool.called":
        if (e.byUser && e.ok) this.userToolUses.push({ tool: e.tool, args: e.args, at: e.at });
        break;
      case "approval": {
        const t = this.trust.get(e.kind) ?? { level: "suggest", streak: 0 };
        this.trust.set(e.kind, e.approved ? { ...t, streak: t.streak + 1 } : { level: "suggest", streak: 0 });
        break;
      }
      case "level.changed":
        this.trust.set(e.kind, { level: e.level, streak: 0 });
        break;
      case "tool.policy":
        this.toolPolicies.set(e.tool, e.policy);
        break;
      case "site.remembered":
        this.sites.add(e.host);
        break;
      case "site.forgotten":
        this.sites.delete(e.host);
        break;
      case "watch.created":
        this.watches.set(e.watch.id, e.watch);
        break;
      case "watch.ran": {
        const w = this.watches.get(e.watchId);
        if (w)
          this.watches.set(e.watchId, {
            ...w,
            nextAt: e.nextAt,
            last: { at: e.at, value: e.value, headline: e.headline },
          });
        break;
      }
      case "watch.cancelled":
        this.watches.delete(e.watchId);
        break;
      case "todo.added":
        this.todos.set(e.todo.id, e.todo);
        break;
      case "todo.updated": {
        const t = this.todos.get(e.todoId);
        if (!t) break;
        let next: Todo = {
          ...t,
          ...(e.text !== undefined && { text: e.text }),
          ...(e.day !== undefined && { day: e.day }),
        };
        if (e.remindAt !== undefined) {
          // A new reminder time is reminded again.
          const { remindAt: _old, remindedAt: _sent, ...rest } = next;
          next = e.remindAt === null ? rest : { ...rest, remindAt: e.remindAt };
        }
        this.todos.set(e.todoId, next);
        break;
      }
      case "todo.done": {
        const t = this.todos.get(e.todoId);
        if (!t || t.doneAt !== undefined || t.removedAt !== undefined) break;
        this.todos.set(e.todoId, { ...t, doneAt: e.at });
        this.feedbackCount++; // finishing something is a reaction too; enough of them start a review
        break;
      }
      case "todo.undone": {
        const t = this.todos.get(e.todoId);
        if (!t || t.doneAt === undefined) break;
        const { doneAt: _done, ...rest } = t;
        this.todos.set(e.todoId, rest);
        break;
      }
      case "todo.removed": {
        const t = this.todos.get(e.todoId);
        if (!t || t.removedAt !== undefined) break;
        this.todos.set(e.todoId, { ...t, removedAt: e.at });
        this.feedbackCount++;
        break;
      }
      case "code.started":
        this.codeTasks.set(e.task.id, { task: e.task, status: "running" });
        break;
      case "code.finished": {
        const t = this.codeTasks.get(e.taskId);
        if (t?.status !== "running") break;
        this.codeTasks.set(e.taskId, {
          ...t,
          status: e.ok ? "done" : "failed",
          summary: e.summary,
          files: e.files,
          stat: e.stat,
          ...(e.error && { error: e.error }),
          ...(e.head && { head: e.head }),
          finishedAt: e.at,
        });
        break;
      }
      case "code.merged": {
        const t = this.codeTasks.get(e.taskId);
        if (t) this.codeTasks.set(e.taskId, { ...t, status: "merged", ...(e.into && { into: e.into }) });
        break;
      }
      case "code.discarded": {
        const t = this.codeTasks.get(e.taskId);
        if (t) this.codeTasks.set(e.taskId, { ...t, status: "discarded" });
        break;
      }
      case "todo.reminded": {
        const t = this.todos.get(e.todoId);
        if (t) this.todos.set(e.todoId, { ...t, remindedAt: e.at });
        break;
      }
      case "observation":
        break;
    }
  }

  /** Offers created but not yet answered, newest first. */
  openOffers(now: number): Offer[] {
    return [...this.offers.values()]
      .filter((r) => !r.verdict && (r.offer.expiresAt === undefined || r.offer.expiresAt > now))
      .map((r) => r.offer)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  notifiedOn(at: number): number {
    return this.notifiedPerDay.get(dayKey(at)) ?? 0;
  }

  /** Offers of one kind created on the local day of `at`, e.g. how many questions moqi asked today. */
  offeredOn(kind: string, at: number): number {
    const day = dayKey(at);
    let n = 0;
    for (const { offer } of this.offers.values()) if (offer.kind === kind && dayKey(offer.createdAt) === day) n++;
    return n;
  }
}
