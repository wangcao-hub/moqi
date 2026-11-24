// Everything moqi knows is an event in an append-only log. State is a fold over events.

export interface Clock {
  /** Milliseconds since epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

// ---------------------------------------------------------------------------
// User model
// ---------------------------------------------------------------------------

export type FactKind = "basic" | "preference" | "ongoing" | "relation" | "routine" | "other";

export interface Fact {
  readonly id: string;
  readonly kind: FactKind;
  readonly content: string;
  /** How many separate times this was stated or observed. 3 makes it long-term. */
  readonly confirmations: number;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly term: "short" | "long";
  /** Who wrote it, when not the user: another agent's name, or "外部内容" for what came in with outside content. */
  readonly by?: string;
}

export interface Conflict {
  readonly factId: string;
  readonly old: string;
  readonly new: string;
  readonly at: number;
}

// ---------------------------------------------------------------------------
// Proactivity
// ---------------------------------------------------------------------------

export type Urgency = "now" | "today" | "whenever";
export type Verdict = "accepted" | "dismissed" | "ignored" | "muted";

/** Something moqi wants to tell or offer the user without being asked. */
export interface Offer {
  readonly id: string;
  /** Feedback is learned per kind, e.g. "briefing", "watch.alert", "routine.automate". */
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  /** 0..1, how much this is worth the user's attention. */
  readonly value: number;
  readonly urgency: Urgency;
  readonly createdAt: number;
  readonly expiresAt?: number;
  /** What accepting it does. Absent: it is information only. */
  readonly action?: { readonly tool: string; readonly args: Record<string, unknown> };
  /** What it reports on, for a host that shows its kind specially, e.g. the coding task of a "code.done". */
  readonly about?: string;
  /** "text": a question; the user answers it in words, and the answer is learned from. */
  readonly answer?: "text";
  /** Where to read more, e.g. the articles a world idea is about. Only http(s) URLs. */
  readonly links?: readonly { readonly title: string; readonly url: string }[];
  /** The user asked to be told at this time (a todo reminder): it notifies whatever the rules, and costs no budget. */
  readonly userTimed?: true;
}

export type IdeaType = "serve" | "ask" | "world";

/** Something moqi worked out about how to help this user, from how they reacted before. */
export interface Lesson {
  readonly id: string;
  readonly content: string;
  readonly at: number;
}

/** Something moqi learned about the world for this user, with where it read it. */
export interface Note {
  readonly id: string;
  readonly topic: string;
  readonly content: string;
  readonly source?: { readonly title: string; readonly url: string };
  readonly at: number;
}

/** One thing moqi thought of while reflecting, and what became of it. */
export interface Idea {
  readonly type: IdeaType;
  readonly title: string;
  readonly value: number;
  /** The offer it became; absent when it was skipped before becoming one. */
  readonly offerId?: string;
  readonly skipped?: string;
}

export type Surface = "notify" | "feed";

// ---------------------------------------------------------------------------
// Autonomy
// ---------------------------------------------------------------------------

export type Level = "inform" | "suggest" | "auto-undo" | "auto";

/** What the user decided about one dangerous tool: always ask, unlocked, or not dangerous after all. */
export type ToolPolicy = "ask" | "auto" | "normal";

/** What the user answered: yes, no, or yes and do not ask about this again ("以后都允许"). */
export type Answer = boolean | "always";

/** Extra answers a question offers. `always`: the label of the "do not ask again" button. */
export interface Choices {
  readonly always: string;
}

// ---------------------------------------------------------------------------
// Watches (托管事务)
// ---------------------------------------------------------------------------

export type Schedule =
  | { readonly every: "day"; readonly at: string }
  | { readonly every: "week"; readonly days: readonly number[]; readonly at: string }
  | { readonly every: "hours"; readonly hours: number };

export interface Watch {
  readonly id: string;
  readonly title: string;
  readonly schedule: Schedule;
  /** A tool to call, or a plain reminder. */
  readonly check: { readonly tool: string; readonly args: Record<string, unknown> } | { readonly remind: string };
  readonly notify: "on-change" | "always";
  readonly nextAt: number;
  readonly last?: { readonly at: number; readonly value: string; readonly headline: string };
}

// ---------------------------------------------------------------------------
// Todos (待办)
// ---------------------------------------------------------------------------

/** Something the user means to do on a day, sometimes at a set time. */
export interface Todo {
  readonly id: string;
  readonly text: string;
  /** The local day it is planned for, YYYY-MM-DD. Unfinished todos from earlier days count as today's. */
  readonly day: string;
  /** When to remind the user. Without it, the todo is only on the list and in the briefing. */
  readonly remindAt?: number;
  /** Who added it: absent for the user, "moqi" for one moqi heard in conversation, else another agent's name. */
  readonly by?: string;
  readonly createdAt: number;
  readonly doneAt?: number;
  /** Deleted todos stay in the state for review; nothing shows them. */
  readonly removedAt?: number;
  /** When the reminder went out, so each reminder time is used once. */
  readonly remindedAt?: number;
}

// ---------------------------------------------------------------------------
// Coding tasks (交给编程 agent)
// ---------------------------------------------------------------------------

/** A coding task handed to a coding agent, worked on a branch of its own in a worktree outside the project. */
export interface CodeTask {
  readonly id: string;
  readonly agent: string;
  /** The repository root. */
  readonly project: string;
  readonly task: string;
  readonly branch: string;
  /** The worktree. */
  readonly dir: string;
  /** The commit the branch started from. */
  readonly base: string;
  readonly startedAt: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventBody =
  | { type: "message"; role: "user" | "assistant"; text: string; images?: readonly string[] }
  | { type: "observation"; source: string; data: unknown }
  | { type: "fact.added"; fact: Fact }
  | { type: "fact.confirmed"; factId: string }
  | { type: "fact.contradicted"; factId: string; content: string }
  | { type: "fact.resolved"; factId: string; keep: "old" | "new" }
  | { type: "fact.forgotten"; factId: string }
  | { type: "offer.created"; offer: Offer }
  | { type: "offer.delivered"; offerId: string; surface: Surface; reason?: string }
  | { type: "offer.dropped"; offerId: string; reason: string }
  | { type: "thought"; trigger: "timer" | "chat" | "user"; ideas: readonly Idea[]; error?: string }
  | { type: "offer.feedback"; offerId: string; verdict: Verdict }
  | { type: "tool.called"; tool: string; args: Record<string, unknown>; byUser: boolean; ok: boolean }
  | { type: "approval"; kind: string; approved: boolean }
  | { type: "level.changed"; kind: string; level: Level }
  | { type: "tool.policy"; tool: string; policy: ToolPolicy }
  | { type: "site.remembered"; host: string }
  | { type: "site.forgotten"; host: string }
  | { type: "watch.created"; watch: Watch }
  | { type: "watch.ran"; watchId: string; value: string; headline: string; changed: boolean; nextAt: number }
  | { type: "watch.cancelled"; watchId: string }
  | { type: "todo.added"; todo: Todo }
  | { type: "todo.updated"; todoId: string; text?: string; day?: string; remindAt?: number | null }
  | { type: "todo.done"; todoId: string }
  | { type: "todo.undone"; todoId: string }
  | { type: "todo.removed"; todoId: string }
  | { type: "todo.reminded"; todoId: string }
  | { type: "code.started"; task: CodeTask }
  | {
      type: "code.finished";
      taskId: string;
      ok: boolean;
      summary: string;
      files: readonly string[];
      stat: string;
      error?: string;
      head?: string;
    }
  | { type: "code.merged"; taskId: string; into?: string }
  | { type: "code.discarded"; taskId: string }
  | { type: "kind.unmuted"; kind: string }
  | { type: "lesson.learned"; lesson: Lesson }
  | { type: "lesson.removed"; lessonId: string }
  | { type: "note.added"; note: Note }
  | { type: "note.removed"; noteId: string }
  /** The older part of the conversation, in a few sentences. `covered`: how many messages, counted from the first, it stands for. */
  | { type: "summary.updated"; text: string; covered: number }
  /** The user deleted the summary; `covered` keeps what it stood for from being summarized again. */
  | { type: "summary.cleared"; covered: number }
  | {
      type: "studied";
      mode: "lessons" | "world";
      trigger: "timer" | "user";
      topic?: string;
      learned: number;
      /** How many reactions to offers there had been, so the next review only starts when there are new ones. */
      feedbackSeen: number;
      error?: string;
      skipped?: string;
    };

export type MoqiEvent = EventBody & { readonly id: string; readonly at: number };

/** Compile-time guard: a body field named like the envelope would be silently overwritten. */
type Collides = Extract<EventBody, { id: unknown } | { at: unknown }>;
const noEnvelopeCollision: [Collides] extends [never] ? true : never = true;
void noEnvelopeCollision;

/** Append-only. Hosts persist it; the core never edits an event. */
export interface EventStore {
  append(event: MoqiEvent): void;
  all(): readonly MoqiEvent[];
}

export function memoryEventStore(initial: readonly MoqiEvent[] = []): EventStore {
  const events = [...initial];
  return { append: (e) => void events.push(e), all: () => events };
}

let counter = 0;
/** Runtime-neutral id (no crypto dependency, so it works in React Native too). */
export function newId(prefix: string, clock: Clock = systemClock): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${clock.now().toString(36)}${counter.toString(36).padStart(4, "0")}${Math.random().toString(36).slice(2, 6)}`;
}
