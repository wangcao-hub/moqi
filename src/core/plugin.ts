import { z } from "zod";
import type { ActionPolicy } from "./autonomy.js";
import type { State } from "./state.js";
import type { Offer } from "./types.js";

export interface ToolContext {
  now(): number;
  readonly state: State;
  readonly signal?: AbortSignal;
  /** This conversation turn has read outside content, so what the tool keeps is marked as such. */
  readonly tainted?: boolean;
}

export interface Tool<A = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType<A>;
  /** The JSON Schema shown to the model, when the tool comes with its own (e.g. from an MCP server). */
  readonly parameters?: Record<string, unknown>;
  /** "read" tools run freely; "write" tools start at "suggest" and earn trust. */
  readonly effect: "read" | "write";
  /** Starting autonomy, when the default for `effect` does not fit (e.g. remembering what the user said). */
  readonly start?: ActionPolicy["start"];
  /** Highest autonomy this tool can reach. Default "auto" for read, "auto-undo" for write. */
  readonly cap?: ActionPolicy["cap"];
  /** Not offered to the model; only offers and moqi itself call it. */
  readonly hidden?: boolean;
  /** Hard to undo: runs commands, changes or deletes files, submits forms, pays, sends the user's words elsewhere. Asked every time unless the user unlocks it. */
  readonly danger?: boolean;
  /** Its result is moqi's own state (memories, todos, watches), never outside content. */
  readonly local?: true;
  /** Who provides it, for the confirmation and the settings: an MCP server or an A2A agent. */
  readonly source?: string;
  /** For web tools: "goto" opens `args.url` and is granted once per site and turn; "within" acts on a granted site. */
  readonly site?: "goto" | "within";
  /** A read tool that must not run on a schedule, e.g. reading the clipboard. */
  readonly noWatch?: true;
  /** Says in plain words what a call will do, for the confirmation question, e.g. "每天 22:00 提醒你「早点睡」". */
  describe?(args: A): string;
  /** More about a call for its confirmation, after the arguments: what it passes on, what it may run. */
  explain?(args: A): string;
  /** Rejects a call before anyone is asked to approve it. Returns the problem, or undefined if the call is fine. */
  validate?(args: A, ctx: ToolContext): string | undefined;
  /** Return a short result for the model. For watches, `{ value, headline }` lets moqi compare runs. */
  run(args: A, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

export type ToolResult =
  | string
  | {
      readonly value: string;
      readonly headline: string;
      readonly details?: string;
      /** Media ids of images to show the user under the answer; the model only sees the words. */
      readonly images?: readonly string[];
    };

export function defineTool<A>(tool: Tool<A>): Tool<A> {
  return tool;
}

/** A tool as moqi describes it to the model: its JSON Schema under `parameters`. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the arguments object. */
  readonly parameters: Record<string, unknown>;
}

export function toolSpec(tool: Tool): ToolSpec {
  const schema = { ...(tool.parameters ?? (z.toJSONSchema(tool.input) as Record<string, unknown>)) };
  delete schema.$schema;
  return { name: tool.name, description: tool.description, parameters: schema };
}

export function actionPolicy(tool: Tool): ActionPolicy {
  const danger = tool.danger === true;
  if (tool.effect === "read") return { start: tool.start ?? "auto", cap: tool.cap ?? "auto", danger };
  return { start: tool.start ?? "suggest", cap: tool.cap ?? "auto-undo", danger };
}

export function resultText(result: ToolResult): string {
  return typeof result === "string" ? result : [result.headline, result.details].filter(Boolean).join("\n");
}

export interface BriefingSection {
  readonly title: string;
  readonly lines: readonly string[];
}

export interface PluginContext {
  now(): number;
  readonly state: State;
  /** Record what a source saw. It becomes part of the log the user model learns from. */
  observe(source: string, data: unknown): void;
  /** Propose something to the user. moqi decides whether and how to deliver it. */
  offer(input: OfferInput): Offer;
}

export type OfferInput = Omit<Offer, "id" | "createdAt">;

/** What a source knows right now, for moqi's own thinking. Ideas point at `links` by key, never by a made-up URL. */
export interface SourceContext {
  readonly text: string;
  readonly links?: Readonly<Record<string, { readonly title: string; readonly url: string }>>;
}

/** Sources, tools and briefing sections. Everything outside the kernel is a plugin. */
export interface Plugin {
  readonly name: string;
  // biome-ignore lint/suspicious/noExplicitAny: a plugin's tools have unrelated argument types
  readonly tools?: readonly Tool<any>[];
  /** One line for the chat prompt's 「做事的方式」: when to reach for this plugin's tools. */
  readonly guide?: string;
  /** A section for the daily briefing, or undefined to skip. */
  briefing?(ctx: PluginContext): Promise<BriefingSection | undefined> | BriefingSection | undefined;
  /** Runs on every tick; observe the world and propose offers. */
  tick?(ctx: PluginContext): Promise<void> | void;
  /** What this source knows now, for reflection. Without it, reflection reads the briefing section. */
  context?(ctx: PluginContext): Promise<SourceContext | undefined> | SourceContext | undefined;
  /** The readable text behind one of the links this source gave in `context`, for moqi to study. */
  read?(url: string, ctx: PluginContext): Promise<string | undefined> | string | undefined;
}
