// The "home": the always-on moqi on a computer, with its log, plugins and notifications.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodeRunner } from "../core/code.js";
import { type ModelCall, openAICompatible } from "../core/model.js";
import { Moqi, type MoqiOptions } from "../core/moqi.js";
import type { Plugin } from "../core/plugin.js";
import type { Answer, EventStore, Offer, Surface } from "../core/types.js";
import { a2aPlugin } from "../plugins/a2a.js";
import { calendarPlugin } from "../plugins/calendar.js";
import { newsPlugin } from "../plugins/news.js";
import { type WeatherPlace, weatherPlugin } from "../plugins/weather.js";
import { type AgentsPluginOptions, agentsPlugin } from "./agents.js";
import { codeRunner, type Launch } from "./code.js";
import { type Config, expandHome, loadConfig, readConfigFile, saveConfig } from "./config.js";
import { acquireLock, fileEventStore } from "./file-store.js";
import { filesPlugin } from "./files.js";
import { macPlugin } from "./mac.js";
import { McpHub, type McpServerStatus } from "./mcp-client.js";
import { type MediaStore, mediaStore } from "./media.js";
import { desktopNotifier, type Notifier } from "./notify.js";
import { UsageLog } from "./usage.js";

/** A typed answer to a question in the terminal. "a" means "以后都允许", only where the question offers it. */
export function terminalAnswer(line: string, always: boolean): Answer {
  const text = line.trim();
  if (always && /^(a|always|以后都允许)$/i.test(text)) return "always";
  return /^(y|yes|好|是|可以)/i.test(text);
}

export interface HomeOptions {
  readonly home: string;
  readonly config?: Config;
  readonly notifier?: Notifier;
  /** Also told about every delivery, e.g. to print it in the terminal. */
  readonly onDeliver?: (offer: Offer, surface: Surface) => void;
  readonly confirm?: MoqiOptions["confirm"];
  /** Told about every model attempt: how long it took, how many tokens, what went wrong. */
  readonly onModelCall?: (call: ModelCall) => void;
  readonly extraPlugins?: readonly Plugin[];
  readonly lock?: boolean;
  /** Used for the model and the weather plugin. Tests pass a fake. */
  readonly fetch?: typeof fetch;
  /** Looking for other agents to connect over MCP. Default: the user's home, launching this moqi; false turns it off. */
  readonly agents?: AgentsPluginOptions | false;
  /** Starting the MCP servers in the config. Default true. */
  readonly mcp?: boolean;
  /** Tests: stand-ins for running and finding coding agents. */
  readonly codeLaunch?: Launch;
  readonly codeFind?: (bin: string) => string | undefined;
}

const VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/** How other agents launch this very moqi: absolute paths, and the same home when it is not the default one. */
export function defaultAgentsOptions(env: NodeJS.ProcessEnv = process.env): AgentsPluginOptions {
  return {
    home: homedir(),
    command: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./cli.js", import.meta.url)), "mcp"],
      ...(env.MOQI_HOME && { env: { MOQI_HOME: env.MOQI_HOME } }),
    },
  };
}

export interface Home {
  /** The current moqi. It is replaced when the config changes, so read it each time. */
  readonly moqi: Moqi;
  readonly config: Config;
  readonly dir: string;
  readonly logPath: string;
  /** Where moqi looks for other agents, and how they launch it; undefined when that is off. */
  readonly agents: AgentsPluginOptions | undefined;
  /** The MCP servers moqi uses and how they are doing. */
  mcpStatus(): McpServerStatus[];
  /** Runs jobs that use moqi one after another, so a config change never lands in the middle of one. */
  serial<T>(job: () => Promise<T>): Promise<T>;
  /** Rebuilds moqi from a new config on the same log, after the jobs before it and background learning settle. */
  reconfigure(config: Config): Promise<void>;
  /** Runs coding tasks; lives as long as the home, so a rebuild of moqi does not lose them. */
  readonly code: CodeRunner;
  /** What the model calls took since this home was opened. */
  readonly usage: UsageLog;
  /** Images the user sent and tools brought back. */
  readonly media: MediaStore;
  close(): void;
}

export function pluginsFrom(
  config: Config,
  fetchImpl?: typeof fetch,
  platform: NodeJS.Platform = process.platform,
  media?: MediaStore,
  saveWeather?: (place: WeatherPlace) => void | Promise<void>,
): Plugin[] {
  const plugins: Plugin[] = [];
  // Always there: without a place of its own, the weather tool still answers for a city it is given.
  plugins.push(
    weatherPlugin({
      ...config.weather,
      ...(fetchImpl && { fetch: fetchImpl }),
      ...(saveWeather && { save: saveWeather }),
    }),
  );
  if (config.calendar) {
    const path = expandHome(config.calendar.ics);
    plugins.push(calendarPlugin({ load: () => readFileSync(path, "utf8") }));
  }
  if (config.a2a && config.a2a.agents.length > 0) plugins.push(a2aPlugin(config.a2a.agents, fetchImpl));
  if (config.news && config.news.feeds.length > 0)
    plugins.push(newsPlugin({ feeds: config.news.feeds, ...(fetchImpl && { fetch: fetchImpl }) }));
  if (config.files) plugins.push(filesPlugin({ folders: config.files.folders }));
  if (config.mac && platform === "darwin")
    plugins.push(macPlugin({ shortcuts: config.mac.shortcuts, ...(media && { media }) }));
  return plugins;
}

export function openHome(options: HomeOptions): Home {
  const release = options.lock === false ? () => {} : acquireLock(options.home);
  try {
    const store = fileEventStore(join(options.home, "events.jsonl"));
    const notify = options.notifier ?? desktopNotifier();
    const baseAgents = options.agents === false ? undefined : (options.agents ?? defaultAgentsOptions());
    // Servers the user agrees to take from other agents go into moqi's own config, then take effect.
    const agents: AgentsPluginOptions | undefined = baseAgents && {
      ...baseAgents,
      ownServers: () => Object.keys(config.mcp?.servers ?? {}),
      useServers: (servers) => {
        const file = readConfigFile(options.home);
        const next = { ...file, mcp: { servers: { ...file.mcp?.servers } } };
        for (const s of servers) next.mcp.servers[s.name] = s.config;
        saveConfig(options.home, next);
        void reconfigureLater(loadConfig(options.home));
        return `好，moqi 也能用 ${servers.map((s) => s.name).join("、")} 了。启动好后，它们的工具会出现在设置里。`;
      },
    };
    // A tool runs inside a serial job, so the rebuild it asks for is queued after that job, not awaited in it.
    let reconfigureLater = async (_next: Config) => {};
    let config = options.config ?? loadConfig(options.home);
    // The user accepted moqi's offer to take the weather from where they live: keep it, then rebuild.
    const saveWeather = (place: WeatherPlace) => {
      const file = readConfigFile(options.home);
      saveConfig(options.home, { ...file, weather: place });
      void reconfigureLater(loadConfig(options.home));
    };
    const media = mediaStore(options.home);
    const hub = new McpHub(VERSION, media);
    const usage = new UsageLog();
    const onCall = (call: ModelCall) => {
      usage.record(call);
      options.onModelCall?.(call);
    };
    // A finished task is reported to whichever moqi is current by then, after the jobs before it.
    const code = codeRunner({
      home: options.home,
      settings: () => config.code,
      onFinished: (id, result) => void serial(async () => moqi.codeFinished(id, result)),
      ...(options.codeFind && { find: options.codeFind }),
      ...(options.codeLaunch && { launch: options.codeLaunch }),
    });
    if (options.mcp !== false) hub.reconcile(config.mcp?.servers);
    let moqi = build(config, store, options, notify, agents, hub, code, media, saveWeather, onCall);
    moqi.recoverCode(); // tasks a previous run left running were cut short
    let chain: Promise<unknown> = Promise.resolve();
    const serial = <T>(job: () => Promise<T>): Promise<T> => {
      const run = chain.then(job, job);
      chain = run.catch(() => {});
      return run;
    };
    // When MCP servers come up (or go away), rebuild moqi so the model sees their tools.
    hub.watch(() => {
      void serial(async () => {
        await moqi.idle();
        moqi = build(config, store, options, notify, agents, hub, code, media, saveWeather, onCall);
      });
    });
    const reconfigure = (next: Config) =>
      serial(async () => {
        await moqi.idle();
        if (options.mcp !== false) hub.reconcile(next.mcp?.servers);
        moqi = build(next, store, options, notify, agents, hub, code, media, saveWeather, onCall);
        config = next;
      });
    reconfigureLater = (next) => reconfigure(next);
    return {
      get moqi() {
        return moqi;
      },
      get config() {
        return config;
      },
      dir: options.home,
      logPath: store.path,
      agents,
      serial,
      reconfigure,
      mcpStatus: () => hub.status(),
      code,
      usage,
      media,
      close: () => {
        hub.stop();
        release();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

function build(
  config: Config,
  store: EventStore,
  options: HomeOptions,
  notify: Notifier,
  agents: AgentsPluginOptions | undefined,
  hub: McpHub,
  code: CodeRunner,
  media: MediaStore,
  saveWeather: (place: WeatherPlace) => void,
  onCall: (call: ModelCall) => void,
): Moqi {
  return new Moqi({
    store,
    ...(config.model && {
      model: openAICompatible({
        ...config.model,
        ...(options.fetch && { fetch: options.fetch }),
        onCall,
      }),
    }),
    plugins: [
      ...pluginsFrom(config, options.fetch, process.platform, media, saveWeather),
      ...(agents ? [agentsPlugin(agents)] : []),
      hub.plugin(),
      ...(options.extraPlugins ?? []),
    ],
    ...(config.persona && { persona: config.persona }),
    briefingAt: config.briefingAt,
    code,
    media,
    todoReviewAt: config.todoReviewAt,
    policy: { quietFrom: config.quiet.from, quietTo: config.quiet.to, dailyBudget: config.dailyBudget },
    ...(options.confirm && { confirm: options.confirm }),
    deliver: async (offer, surface) => {
      options.onDeliver?.(offer, surface);
      if (surface === "notify") await notify(offer.title, offer.body.split("\n").slice(0, 3).join("\n"));
    },
  });
}
