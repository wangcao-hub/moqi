import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { NEWS_FEEDS } from "../plugins/news.js";
import type { SearchProvider } from "../plugins/search.js";

const time = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "时间要写成 HH:MM");

export const ConfigSchema = z.object({
  model: z
    .object({
      baseURL: z.string().url(),
      model: z.string().min(1),
      apiKey: z.string().optional(),
      noThink: z.boolean().optional(),
      effort: z.enum(["low", "medium", "high"]).optional(),
      sendReasoning: z.boolean().optional(),
      vision: z.boolean().optional(),
    })
    .optional(),
  persona: z.string().optional(),
  briefingAt: time.nullable().default("08:00"),
  todoReviewAt: time.nullable().default("21:00"),
  quiet: z.object({ from: time, to: time }).default({ from: "22:30", to: "08:00" }),
  dailyBudget: z.number().int().min(0).max(50).default(3),
  weather: z.object({ latitude: z.number(), longitude: z.number(), place: z.string() }).optional(),
  calendar: z.object({ ics: z.string() }).optional(),
  /** MCP servers whose tools moqi may use, by name. */
  mcp: z
    .object({
      servers: z.record(
        z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, "名字只能用字母、数字、_ 和 -"),
        z.object({
          command: z.string().min(1),
          args: z.array(z.string()).optional(),
          env: z.record(z.string(), z.string()).optional(),
          cwd: z.string().optional(),
        }),
      ),
    })
    .optional(),
  /** Other A2A agents moqi may ask, by name. */
  a2a: z
    .object({
      agents: z
        .array(
          z.object({
            name: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, "名字只能用字母、数字、_ 和 -"),
            url: z.string().url(),
            key: z.string().optional(),
          }),
        )
        .max(20),
    })
    .optional(),
  /** Folders moqi may organize. Absent: off. */
  files: z.object({ folders: z.array(z.string().min(1)).min(1).max(20) }).optional(),
  /** Actions on this Mac, and the Shortcuts moqi may run. Absent: off. */
  mac: z.object({ shortcuts: z.array(z.string().min(1).max(200)).max(50).default([]) }).optional(),
  /** Coding agents and the projects they may work on. Absent: off. */
  code: z
    .object({
      timeoutMinutes: z.number().int().min(1).max(240).default(30),
      projects: z
        .array(
          z.object({
            path: z.string().min(1),
            agent: z.enum(["kiro", "claude"]),
            commands: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
            network: z.boolean().default(false),
          }),
        )
        .max(20)
        .default([]),
    })
    .optional(),
  news: z
    .object({ feeds: z.array(z.object({ name: z.string().min(1).max(40), url: z.string().url() })).max(20) })
    // On unless turned off with an empty list, so an existing config gets news after an upgrade too.
    .default({ feeds: NEWS_FEEDS.slice(0, 3) }),
  /** Web search through a service. Absent: on when the model is DeepSeek's own, with the model's key. */
  search: z
    .object({
      enabled: z.boolean().default(true),
      provider: z.enum(["deepseek", "baidu"]).default("deepseek"),
      apiKey: z.string().optional(),
    })
    .optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export const TEMPLATE = {
  model: { baseURL: "http://127.0.0.1:11434/v1", model: "qwen3:4b", noThink: true },
  briefingAt: "08:00",
  todoReviewAt: "21:00",
  quiet: { from: "22:30", to: "08:00" },
  dailyBudget: 3,
  calendar: { ics: "~/calendar.ics" },
  news: { feeds: NEWS_FEEDS.slice(0, 3) },
};

export function moqiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MOQI_HOME ?? join(homedir(), ".moqi");
}

export function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * ~/.moqi/config.json, then MOQI_BASE_URL / MOQI_MODEL / MOQI_API_KEY / MOQI_SEARCH_API_KEY on top. Keys stay
 * out of the event log.
 */
export function loadConfig(home: string, env: NodeJS.ProcessEnv = process.env): Config {
  const config = withModelEnv(readConfigFile(home), env);
  const key = env.MOQI_SEARCH_API_KEY;
  // The key replaces the one search would use and fills a missing one; it never turns on search that is off or not set up.
  if (!key || (!config.search && !isDeepSeekModel(config))) return config;
  return {
    ...config,
    search: {
      enabled: config.search?.enabled ?? true,
      provider: config.search?.provider ?? "deepseek",
      apiKey: key,
    },
  };
}

function withModelEnv(config: Config, env: NodeJS.ProcessEnv): Config {
  if (env.MOQI_BASE_URL && env.MOQI_MODEL) {
    return {
      ...config,
      model: {
        baseURL: env.MOQI_BASE_URL,
        model: env.MOQI_MODEL,
        ...(env.MOQI_API_KEY && { apiKey: env.MOQI_API_KEY }),
      },
    };
  }
  if (config.model && env.MOQI_API_KEY) return { ...config, model: { ...config.model, apiKey: env.MOQI_API_KEY } };
  return config;
}

/** Whether the model is DeepSeek's own API, whose key also pays for DeepSeek's web search. */
export function isDeepSeekModel(config: Config): boolean {
  const url = config.model?.baseURL;
  if (!url) return false;
  try {
    return new URL(url).hostname === "api.deepseek.com";
  } catch {
    return false;
  }
}

export type SearchSetup =
  | { readonly on: true; readonly provider: SearchProvider; readonly apiKey: string }
  | { readonly on: false; readonly provider: SearchProvider; readonly problem?: string };

/** Whether moqi searches the web, with which service and key; when a key is missing, what the settings say. */
export function searchSetup(config: Config): SearchSetup {
  const search = config.search;
  const provider = search?.provider ?? "deepseek";
  if (search?.enabled === false) return { on: false, provider };
  const deepseekModel = isDeepSeekModel(config);
  // Without a section of its own, search follows the model: on with DeepSeek's, off with any other.
  if (!search && !deepseekModel) return { on: false, provider };
  const apiKey = search?.apiKey || (provider === "deepseek" && deepseekModel ? config.model?.apiKey : undefined);
  if (apiKey) return { on: true, provider, apiKey };
  return {
    on: false,
    provider,
    problem: provider === "deepseek" ? "需要填 DeepSeek 的 key" : "需要填 AppBuilder API Key",
  };
}

export function writeTemplate(home: string): string {
  const path = join(home, "config.json");
  if (existsSync(path)) throw new Error(`${path} already exists`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(TEMPLATE, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/** Only what is in config.json, without environment overrides: what a settings page edits. */
export function readConfigFile(home: string): Config {
  const path = join(home, "config.json");
  return ConfigSchema.parse(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
}

/** Writes config.json readable only by the user, atomically so a crash never leaves half a file. */
export function saveConfig(home: string, config: Config): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, "config.json");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
