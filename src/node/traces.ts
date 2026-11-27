// Traces of conversation turns and watch runs: one JSONL file per taugraph run under <moqi home>/runs, kept 30 days.
// The event log stays moqi's only record; a trace is for looking back and for replaying a conversation.
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TraceEvent } from "taugraph";
import { fileStore } from "taugraph/file";

/** Days the trace of a finished run is kept. */
export const TRACE_DAYS = 30;
const DAY = 86_400_000;

export interface Traces {
  readonly dir: string;
  /** Pass as moqi's `onTrace`. Never throws: the first failure is reported once, later ones are dropped. */
  sink(event: TraceEvent): void;
  /** Removes runs that completed, failed or were cut short more than TRACE_DAYS days before `now`. Returns how many. */
  prune(now?: number): number;
}

export function traces(home: string, report: (line: string) => void = (line) => console.error(line)): Traces {
  // Readable only by the user, like media: a trace holds the prompt with the memories, files and web pages read.
  const dir = join(home, "runs");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch {
    // the first trace that cannot be stored says why
  }
  // No fsync: losing the last events of a trace in a power cut costs nothing moqi relies on.
  const store = fileStore(dir, { durability: "none" });
  let reported = false;
  return {
    dir: store.dir,
    sink(event) {
      try {
        store.sink(event);
      } catch (error) {
        if (reported) return;
        reported = true;
        const reason = error instanceof Error ? error.message : String(error);
        report(`moqi：运行记录存不进 ${store.dir}（${reason}），之后不再提示`);
      }
    },
    prune(now = Date.now()) {
      const before = now - TRACE_DAYS * DAY;
      let removed = 0;
      for (const run of store.list()) {
        if (run.updatedAt >= before || run.status === "running" || run.status === "paused") continue;
        try {
          if (store.remove(run.runId)) removed++;
        } catch {
          // written again just now; the next pass takes it
        }
      }
      return removed;
    },
  };
}
