import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Moqi } from "../src/core/moqi.js";
import { ConfigSchema, loadConfig, searchSetup, TEMPLATE, writeTemplate } from "../src/node/config.js";
import { acquireLock, fileEventStore } from "../src/node/file-store.js";
import { openHome, terminalAnswer } from "../src/node/home.js";
import { desktopNotifier } from "../src/node/notify.js";
import { fakeClock } from "./helpers.js";

const tmp = () => mkdtempSync(join(tmpdir(), "moqi-"));

describe("file event store", () => {
  it("persists every event and rebuilds the same moqi after a restart", async () => {
    const dir = tmp();
    const clock = fakeClock();
    const a = new Moqi({
      store: fileEventStore(join(dir, "events.jsonl")),
      clock,
      briefingAt: null,
      confirm: async () => true,
    });
    a.remember({ kind: "basic", content: "住在深圳" });
    await a.callTool(
      "watch_create",
      { title: "早点睡", schedule: { every: "day", at: "22:00" }, remind: "该睡了" },
      { byUser: true },
    );

    const b = new Moqi({ store: fileEventStore(join(dir, "events.jsonl")), clock, briefingAt: null });
    expect([...b.state.facts.values()]).toEqual([...a.state.facts.values()]);
    expect([...b.state.watches.values()]).toEqual([...a.state.watches.values()]);
    expect(readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n")).toHaveLength(a.store.all().length);
  });

  it("skips a line torn by a crash", () => {
    const dir = tmp();
    const path = join(dir, "events.jsonl");
    const store = fileEventStore(path);
    store.append({ type: "message", role: "user", text: "hi", id: "e1", at: 1 });
    appendFileSync(path, '{"type":"message","ro');
    const reopened = fileEventStore(path);
    expect(reopened.all()).toHaveLength(1);
    expect(reopened.skipped).toBe(1);
  });
  it("keeps the first event written after a torn line", () => {
    const dir = tmp();
    const path = join(dir, "events.jsonl");
    writeFileSync(path, '{"type":"message","role":"user","text":"a","id":"e1","at":1}\n{"type":"mess');
    fileEventStore(path).append({ type: "message", role: "user", text: "after", id: "e2", at: 2 });
    expect(
      fileEventStore(path)
        .all()
        .map((e) => e.id),
    ).toEqual(["e1", "e2"]);
  });
});

describe("single-process lock", () => {
  it("refuses a second moqi on the same home and takes over a stale lock", () => {
    const dir = tmp();
    const release = acquireLock(dir);
    expect(() => acquireLock(dir)).toThrow(/already running/);
    release();
    writeFileSync(join(dir, "moqi.lock"), "999999");
    const again = acquireLock(dir);
    again();
  });
});

describe("notifications", () => {
  it("passes text as arguments so a title cannot inject a script", async () => {
    const calls: [string, readonly string[]][] = [];
    const exec = async (file: string, args: readonly string[]) => void calls.push([file, args]);
    const evil = '"; do shell script "rm -rf ~" --';
    await desktopNotifier("darwin", exec)(evil, "body");
    await desktopNotifier("linux", exec)("--help", "body");
    expect(calls[0]?.[0]).toBe("osascript");
    expect(calls[0]?.[1].slice(-2)).toEqual([evil, "body"]);
    expect(calls[0]?.[1].filter((a) => a.includes("rm -rf"))).toEqual([evil]);
    expect(calls[1]).toEqual(["notify-send", ["--app-name=moqi", "--", "--help", "body"]]);
  });
});

describe("config", () => {
  it("init creates the home directory on a fresh machine and writes a template that loads", () => {
    const home = join(tmp(), "fresh", ".moqi");
    const path = writeTemplate(home);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(TEMPLATE);
    expect(TEMPLATE).not.toHaveProperty("weather"); // no made-up city: the user picks theirs
    expect(loadConfig(home, {}).model?.model).toBe(TEMPLATE.model.model);
    expect(() => writeTemplate(home)).toThrow(/already exists/);
  });

  it("reads config.json and lets environment variables override the model", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ model: { baseURL: "http://a/v1", model: "m1" }, dailyBudget: 5 }),
    );
    expect(loadConfig(dir, {})).toMatchObject({ model: { model: "m1" }, dailyBudget: 5, briefingAt: "08:00" });
    expect(loadConfig(dir, { MOQI_BASE_URL: "http://b/v1", MOQI_MODEL: "m2", MOQI_API_KEY: "k" }).model).toEqual({
      baseURL: "http://b/v1",
      model: "m2",
      apiKey: "k",
    });
  });

  it("opens a home with the plugins the config asks for", () => {
    const dir = tmp();
    writeFileSync(join(dir, "cal.ics"), "BEGIN:VCALENDAR\nEND:VCALENDAR\n");
    const home = openHome({
      home: dir,
      config: loadConfig(dir, {}),
      lock: false,
    });
    // news is on unless turned off; moqi always looks for other agents unless told not to
    expect(home.moqi.plugins.map((p) => p.name)).toEqual(["weather", "news", "agents", "mcp"]); // weather answers for a city without a place of its own
    expect(home.agents?.command.args.at(-1)).toBe("mcp");
    home.close();
    const withPlugins = openHome({
      home: dir,
      config: {
        ...loadConfig(dir, {}),
        weather: { latitude: 1, longitude: 2, place: "x" },
        calendar: { ics: join(dir, "cal.ics") },
      },
      lock: false,
      agents: false,
    });
    expect(withPlugins.moqi.plugins.map((p) => p.name)).toEqual(["weather", "calendar", "news", "mcp"]);
    expect(withPlugins.moqi.tool("weather")).toBeDefined();
  });
});

describe("web search setup", () => {
  const deepseek = { baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "sk-model" };
  const keyless = { baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat" };
  const local = { baseURL: "http://127.0.0.1:11434/v1", model: "qwen3:4b" };
  const config = (raw: Record<string, unknown>) => ConfigSchema.parse(raw);

  it("is on by itself with DeepSeek's model, using the model's key", () => {
    expect(searchSetup(config({ model: deepseek }))).toEqual({ on: true, provider: "deepseek", apiKey: "sk-model" });
    expect(searchSetup(config({ model: { ...deepseek, baseURL: "https://api.deepseek.com" } }))).toMatchObject({
      on: true,
    });
    expect(searchSetup(config({ model: { ...deepseek, baseURL: "https://api.deepseek.com.evil.test/v1" } }))).toEqual({
      on: false,
      provider: "deepseek",
    });
    expect(searchSetup(config({ model: local }))).toEqual({ on: false, provider: "deepseek" });
    expect(searchSetup(config({}))).toEqual({ on: false, provider: "deepseek" });
  });

  it("stays off once turned off, and says which key is missing", () => {
    expect(searchSetup(config({ model: deepseek, search: { enabled: false } }))).toEqual({
      on: false,
      provider: "deepseek",
    });
    expect(searchSetup(config({ model: keyless }))).toEqual({
      on: false,
      provider: "deepseek",
      problem: "需要填 DeepSeek 的 key",
    });
    expect(searchSetup(config({ model: local, search: { enabled: true, provider: "deepseek" } }))).toEqual({
      on: false,
      provider: "deepseek",
      problem: "需要填 DeepSeek 的 key",
    });
    expect(searchSetup(config({ model: local, search: { provider: "deepseek", apiKey: "sk-search" } }))).toEqual({
      on: true,
      provider: "deepseek",
      apiKey: "sk-search",
    });
    // The model's key never goes to Baidu.
    expect(searchSetup(config({ model: deepseek, search: { provider: "baidu" } }))).toEqual({
      on: false,
      provider: "baidu",
      problem: "需要填 AppBuilder API Key",
    });
    expect(searchSetup(config({ model: local, search: { provider: "baidu", apiKey: "bce" } }))).toEqual({
      on: true,
      provider: "baidu",
      apiKey: "bce",
    });
  });

  it("takes the key from MOQI_SEARCH_API_KEY, without turning search on", () => {
    const dir = tmp();
    const write = (c: unknown) => writeFileSync(join(dir, "config.json"), JSON.stringify(c));
    const env = { MOQI_SEARCH_API_KEY: "sk-env" };
    write({ model: deepseek });
    expect(searchSetup(loadConfig(dir, env))).toEqual({ on: true, provider: "deepseek", apiKey: "sk-env" });
    write({ model: local, search: { provider: "baidu", apiKey: "bce-file" } });
    expect(searchSetup(loadConfig(dir, env))).toEqual({ on: true, provider: "baidu", apiKey: "sk-env" });
    write({ model: local });
    expect(searchSetup(loadConfig(dir, env))).toEqual({ on: false, provider: "deepseek" });
    write({ model: deepseek, search: { enabled: false } });
    expect(searchSetup(loadConfig(dir, env))).toEqual({ on: false, provider: "deepseek" });
  });

  it("gives a home with DeepSeek's model the two tools, searching with the model's key", async () => {
    const dir = tmp();
    const sent: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ results: [{ title: "深圳天气", url: "https://w.example/1", summary: "晴" }] });
    }) as typeof fetch;
    const base = { ...loadConfig(dir, {}), model: deepseek };
    const home = openHome({ home: dir, config: base, lock: false, agents: false, mcp: false, fetch: fetchImpl });
    expect(home.moqi.plugins.map((p) => p.name)).toEqual(["weather", "news", "search", "mcp"]);
    expect(await home.moqi.callTool("web_search", { query: "深圳天气" }, { byUser: true })).toContain("深圳天气");
    expect(sent).toEqual([{ url: "https://api.deepseek.com/v1/tools/search", auth: "Bearer sk-model" }]);
    home.close();

    const off = openHome({
      home: dir,
      config: { ...base, search: { enabled: false, provider: "deepseek" } },
      lock: false,
      agents: false,
      mcp: false,
    });
    expect(off.moqi.tool("web_search")).toBeUndefined();
    expect(off.moqi.tool("web_read")).toBeUndefined();
    off.close();
  });
});

describe("terminal answers", () => {
  it("reads yes, no, and 'always' only where the question offers it", () => {
    expect(terminalAnswer("y", false)).toBe(true);
    expect(terminalAnswer(" 好 ", false)).toBe(true);
    expect(terminalAnswer("", false)).toBe(false);
    expect(terminalAnswer("a", false)).toBe(false);
    expect(terminalAnswer("a", true)).toBe("always");
    expect(terminalAnswer("以后都允许", true)).toBe("always");
    expect(terminalAnswer("n", true)).toBe(false);
  });
});
