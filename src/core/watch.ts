// A watch run is a taugraph flow: check (read) -> compare (code) -> alert (write).
// The alert is a `write` step, so replaying a run never notifies the user twice.
import type { TraceEvent } from "taugraph";
import { createGraph } from "taugraph";
import { CodeNode } from "taugraph/nodes";
import { z } from "zod";
import type { ToolResult } from "./plugin.js";
import type { Watch } from "./types.js";

const RunState = z.object({
  value: z.string().nullable().default(null),
  headline: z.string().nullable().default(null),
  changed: z.boolean().default(false),
  alerted: z.boolean().default(false),
});
type RunState = z.infer<typeof RunState>;

export interface WatchDeps {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Called by the write step. */
  alert(headline: string, value: string): void;
}

export interface WatchOutcome {
  readonly value: string;
  readonly headline: string;
  readonly changed: boolean;
  readonly alerted: boolean;
}

export function watchGraph(watch: Watch, deps: WatchDeps) {
  return createGraph(RunState, {
    start: "check",
    nodes: {
      check: CodeNode<RunState>(
        async (s) => {
          if ("remind" in watch.check) return { ...s, value: watch.check.remind, headline: watch.check.remind };
          const result = await deps.callTool(watch.check.tool, watch.check.args);
          const value = typeof result === "string" ? result.trim() : result.value;
          const headline = typeof result === "string" ? (result.trim().split("\n")[0] ?? "") : result.headline;
          return { ...s, value, headline };
        },
        { retry: { maxAttempts: 2 } },
      ),
      compare: CodeNode<RunState>((s) => ({
        ...s,
        changed:
          "remind" in watch.check ||
          watch.notify === "always" ||
          watch.last === undefined ||
          watch.last.value !== s.value,
      })),
      alert: CodeNode<RunState>(
        (s) => {
          deps.alert(s.headline ?? "", s.value ?? "");
          return { ...s, alerted: true };
        },
        { effect: "write" },
      ),
      done: CodeNode<RunState>((s) => s),
    },
    edges: [{ from: "check", to: "compare" }],
    conditionalEdges: [{ from: "compare", route: (s) => (s.changed ? "alert" : "done"), targets: ["alert", "done"] }],
    endNodes: ["alert", "done"],
  });
}

export async function runWatch(
  watch: Watch,
  deps: WatchDeps,
  options: { readonly runId?: string; readonly onEvent?: (event: TraceEvent) => void } = {},
): Promise<WatchOutcome> {
  const result = await watchGraph(watch, deps).run({}, options);
  if (result.status !== "completed") throw new Error(`watch ${watch.id} paused unexpectedly`);
  const s = result.state;
  return { value: s.value ?? "", headline: s.headline ?? "", changed: s.changed, alerted: s.alerted };
}
