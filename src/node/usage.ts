// What the model calls took, by local day, kept in memory since moqi started. Every attempt counts, retries too.
import type { ModelCall } from "../core/model.js";
import { dayKey } from "../core/schedule.js";

export interface UsageKind {
  /** Every request sent, retries included. */
  attempts: number;
  failed: number;
  /** Milliseconds the answered requests took, together. */
  answeredMs: number;
  /** Requests that came back with a token count. Some providers send none. */
  counted: number;
  promptTokens: number;
  completionTokens: number;
}
export interface UsageDay {
  readonly day: string;
  readonly chat: UsageKind;
  readonly background: UsageKind;
}

const KEEP_DAYS = 14;
const empty = (): UsageKind => ({
  attempts: 0,
  failed: 0,
  answeredMs: 0,
  counted: 0,
  promptTokens: 0,
  completionTokens: 0,
});

export class UsageLog {
  private readonly days = new Map<string, UsageDay>();
  readonly since: number;
  constructor(private readonly now: () => number = Date.now) {
    this.since = now();
  }

  record(call: ModelCall): void {
    const day = dayKey(this.now());
    let entry = this.days.get(day);
    if (!entry) {
      entry = { day, chat: empty(), background: empty() };
      this.days.set(day, entry);
      for (const old of [...this.days.keys()].slice(0, Math.max(0, this.days.size - KEEP_DAYS))) this.days.delete(old);
    }
    const kind = entry[call.purpose];
    kind.attempts++;
    if (!call.ok) return void kind.failed++;
    kind.answeredMs += call.ms;
    if (call.promptTokens !== undefined) {
      kind.counted++;
      kind.promptTokens += call.promptTokens;
      kind.completionTokens += call.completionTokens ?? 0;
    }
  }

  /** The latest days that had any call, newest first. */
  recent(count = 7): UsageDay[] {
    return [...this.days.values()].reverse().slice(0, count);
  }
}
