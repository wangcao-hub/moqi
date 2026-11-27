import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { EventStore, MoqiEvent } from "../core/types.js";

/**
 * The log as JSONL, one event per line, appended synchronously. A torn last line from a crash is
 * skipped on load (the event it held was never acted on).
 */
export function fileEventStore(path: string): EventStore & { readonly path: string; readonly skipped: number } {
  mkdirSync(dirname(path), { recursive: true });
  const events: MoqiEvent[] = [];
  let skipped = 0;
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    // End a torn last line, or the next event would be glued onto it and lost on the following load.
    if (text !== "" && !text.endsWith("\n")) appendFileSync(path, "\n");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        events.push(JSON.parse(line) as MoqiEvent);
      } catch {
        skipped++;
      }
    }
  }
  return {
    path,
    skipped,
    append(event) {
      appendFileSync(path, `${JSON.stringify(event)}\n`);
      events.push(event);
    },
    all: () => events,
  };
}

/** One moqi process per home: two writers would interleave the log. */
export function acquireLock(home: string): () => void {
  mkdirSync(home, { recursive: true, mode: 0o700 }); // a new home is readable only by the user
  const path = join(home, "moqi.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
      };
      process.once("exit", release);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(path, "utf8"));
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
        throw new Error(`moqi is already running (pid ${pid}). Stop it first, or use the running one.`);
      }
      unlinkSync(path); // stale lock from a process that died
    }
  }
  throw new Error(`Could not take the lock at ${path}`);
}

/** The pid of the moqi that holds this home's lock, if one is running. */
export function lockHolder(home: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(home, "moqi.lock"), "utf8"));
    return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
