import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, type Plugin } from "../src/core/plugin.js";
import type { Launch } from "../src/node/code.js";
import { readConfigFile } from "../src/node/config.js";
import { type Console, type ConsoleOptions, confirmQueue, startConsole } from "../src/node/console/server.js";
import { type Home, type HomeOptions, openHome } from "../src/node/home.js";
import { RED_PNG } from "./helpers.js";

type Reply = { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };

/** Plays the model, the geocoder and anything else moqi would fetch. */
function fakeNet(model: (body: { messages: { role: string; content: string }[] }) => Reply) {
  const seen: { url: string; auth: string | null; body: unknown }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    seen.push({ url, auth: headers.get("authorization"), body });
    if (url.includes("geocoding-api.open-meteo.com")) {
      return Response.json({
        results: [{ name: "深圳", admin1: "广东", country: "中国", latitude: 22.54554, longitude: 114.0683 }],
      });
    }
    if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: model(body) }] });
    if (url === "https://feed.test/rss") {
      return new Response(
        "<rss><channel><item><title>深圳明天暴雨</title><link>https://feed.test/rain</link></item></channel></rss>",
      );
    }
    if (url === "https://feed.test/rain") return new Response("<article><p>气象台说深圳明天有暴雨。</p></article>");
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: impl, seen };
}

const open: { home: Home; ui: Console }[] = [];

async function start(
  config: Record<string, unknown>,
  model: Parameters<typeof fakeNet>[0] = () => ({ content: "好" }),
  extra: Plugin[] = [],
  consoleExtra: Partial<ConsoleOptions> = {},
  homeExtra: Partial<HomeOptions> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "moqi-console-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  const net = fakeNet(model);
  const asker = confirmQueue();
  const osHome = mkdtempSync(join(tmpdir(), "moqi-os-home-"));
  const home = openHome({
    home: dir,
    notifier: async () => {},
    fetch: net.fetch,
    confirm: (q, d, c) => asker.ask(q, d, c),
    extraPlugins: extra,
    ...homeExtra,
    agents: {
      home: osHome,
      command: { command: "/usr/bin/node", args: ["/opt/moqi/cli.js", "mcp"] },
      platform: "darwin",
    },
  });
  const ui = await startConsole({
    home,
    asker,
    token: "t".repeat(32),
    port: 0,
    fetch: net.fetch,
    env: {},
    ...consoleExtra,
  });
  open.push({ home, ui });
  const api = async (method: string, path: string, body?: unknown, token = "t".repeat(32)) => {
    const res = await fetch(`http://127.0.0.1:${ui.port}${path}`, {
      method,
      headers: { "x-moqi-token": token, ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return {
      status: res.status,
      // biome-ignore lint/suspicious/noExplicitAny: tests read whatever shape each endpoint returns
      data: (await res.json()) as Record<string, any>,
    };
  };
  return { dir, osHome, home, ui, api, net };
}

afterEach(async () => {
  for (const { home, ui } of open.splice(0)) {
    await ui.close();
    await home.moqi.idle();
    home.close();
  }
});

const MODEL = { baseURL: "http://model.test/v1", model: "m1" };

describe("console", () => {
  it("offers to allow a site for good, lists remembered sites, and removes them", async () => {
    const site: Plugin = {
      name: "web",
      tools: [
        defineTool({
          name: "navigate",
          description: "Open a page",
          input: z.object({ url: z.string() }),
          effect: "write",
          danger: true,
          site: "goto",
          source: "web",
          run: ({ url }) => `opened ${url}`,
        }),
      ],
    };
    const { api } = await start(
      { model: MODEL, briefingAt: null },
      (body) =>
        body.messages.at(-1)?.role === "tool"
          ? { content: "开好了" }
          : {
              content: "",
              tool_calls: [{ id: "c1", function: { name: "navigate", arguments: '{"url":"https://jd.com/"}' } }],
            },
      [site],
    );
    const turn = api("POST", "/api/chat", { text: "打开京东" });
    let question: { id: string; text: string; always?: string } | null = null;
    for (let i = 0; i < 50 && !question; i++) {
      await new Promise((r) => setTimeout(r, 20));
      question = (await api("GET", "/api/state")).data.question;
    }
    expect(question).toMatchObject({ text: "要我打开 jd.com 吗？", always: "以后都允许" });
    await api("POST", "/api/confirm", { id: question?.id, yes: true, always: true });
    expect((await turn).data.reply).toBe("开好了");
    expect((await api("GET", "/api/tools")).data.sites).toEqual(["jd.com"]);
    expect((await api("POST", "/api/site/forget", { host: "jd.com" })).status).toBe(200);
    expect((await api("POST", "/api/site/forget", { host: "jd.com" })).status).toBe(404);
    expect((await api("GET", "/api/tools")).data.sites).toEqual([]);
  });

  it("lists ordinary write tools and lets the user unlock them", async () => {
    const { home, api } = await start({ briefingAt: null });
    const { ordinary } = (await api("GET", "/api/tools")).data;
    expect(ordinary).toEqual(
      expect.arrayContaining([{ name: "watch_create", source: "moqi", label: "新建盯梢", level: "ask" }]),
    );
    expect((await api("POST", "/api/tool-level", { tool: "watch_create", level: "auto" })).status).toBe(200);
    expect(home.moqi.ordinaryTools().find((t) => t.name === "watch_create")?.level).toBe("auto");
    expect((await api("POST", "/api/tool-level", { tool: "forget", level: "auto" })).status).toBe(400);
    expect((await api("POST", "/api/tool-level", { tool: "watch_create", level: "always" })).status).toBe(400);
  });

  it("serves the page under a strict CSP, and the API only with the token", async () => {
    const { ui, api } = await start({});
    const page = await fetch(`http://127.0.0.1:${ui.port}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
    const html = await page.text();
    expect(html).toContain('<script src="/app.js"');
    expect(html).toContain('id="view-todo"');
    expect(html).toContain('id="r-at"');
    expect(html).toContain('id="ask-details"');
    expect(html).toContain('id="danger-tools"');
    expect(html).toContain('id="p-browser"');
    expect(html).toContain('id="f-folders"');
    expect(html).toContain('id="mac-shortcuts"');
    expect(html).toContain('id="code-running"');
    expect(html).toContain('id="code-projects"');
    expect((await fetch(`http://127.0.0.1:${ui.port}/app.js`)).headers.get("content-type")).toContain("javascript");
    expect((await fetch(`http://127.0.0.1:${ui.port}/markdown.js`)).headers.get("content-type")).toContain(
      "javascript",
    );
    expect(html).toContain('<script src="/markdown.js"');

    expect((await api("GET", "/api/state", undefined, "wrong")).status).toBe(401);
    expect((await api("GET", "/api/state", undefined, "")).status).toBe(401);
    const ok = await api("GET", "/api/state");
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({
      configured: false,
      messages: [],
      offers: [],
      facts: [],
      watches: [],
      question: null,
    });
  });

  it("refuses a request whose Host is not this machine, so other sites cannot reach it by DNS rebinding", async () => {
    const { ui } = await start({});
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: ui.port,
          path: "/api/state",
          headers: { host: `evil.example:${ui.port}`, "x-moqi-token": "t".repeat(32) },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    // The easy-to-remember name is this machine too.
    const named = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: ui.port,
          path: "/api/state",
          headers: { host: `moqi.localhost:${ui.port}`, "x-moqi-token": "t".repeat(32) },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(named).toBe(200);
    expect(ui.url).toBe(`http://moqi.localhost:${ui.port}/#t=${"t".repeat(32)}`);
  });

  it("rejects bodies that are not JSON, so a plain HTML form cannot post to it", async () => {
    const { ui } = await start({ model: MODEL });
    const res = await fetch(`http://127.0.0.1:${ui.port}/api/chat`, {
      method: "POST",
      headers: { "x-moqi-token": "t".repeat(32), "content-type": "text/plain" },
      body: '{"text":"hi"}',
    });
    expect(res.status).toBe(415);
  });

  it("chats, and asks on the page before an action that has not earned trust", async () => {
    const { api } = await start({ model: MODEL, briefingAt: null }, (body) => {
      const last = body.messages.at(-1);
      if (last?.role === "user" && last.content.includes("提醒我早点睡")) {
        const args = { title: "早点睡", schedule: { every: "day", at: "22:00" }, remind: "早点睡" };
        return {
          content: "",
          tool_calls: [{ id: "c1", function: { name: "watch_create", arguments: JSON.stringify(args) } }],
        };
      }
      return { content: last?.role === "tool" ? "好，每天 22:00 提醒你" : "你好" };
    });

    expect((await api("POST", "/api/chat", { text: "你好" })).data.reply).toBe("你好");

    const turn = api("POST", "/api/chat", { text: "每天晚上 10 点提醒我早点睡" });
    let question: { id: string; text: string } | null = null;
    for (let i = 0; i < 50 && !question; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const s = await api("GET", "/api/state");
      question = s.data.question;
      if (question) expect(s.data.busy).toBe(true);
    }
    expect(question?.text).toContain("22:00");
    expect((await api("POST", "/api/confirm", { id: question?.id, yes: true })).status).toBe(200);
    expect((await turn).data.reply).toBe("好，每天 22:00 提醒你");
    expect((await api("POST", "/api/confirm", { id: question?.id, yes: true })).status).toBe(409); // answered already

    const after = await api("GET", "/api/state");
    expect(after.data.question).toBeNull();
    expect(after.data.watches).toMatchObject([{ title: "早点睡", schedule: "每天 22:00" }]);
    expect(after.data.messages.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("stops a conversation that waits for an answer, and leaves the question unanswered as a no", async () => {
    const { api } = await start({ model: { baseURL: "http://m.test/v1", model: "m" }, briefingAt: null }, (body) => {
      const last = body.messages.at(-1);
      if (last?.role === "tool") return { content: "不该走到这里" };
      const args = { title: "早点睡", schedule: { every: "day", at: "22:00" }, remind: "该睡了" };
      return {
        content: "",
        tool_calls: [{ id: "c1", function: { name: "watch_create", arguments: JSON.stringify(args) } }],
      };
    });
    expect((await api("POST", "/api/chat/stop", {})).status).toBe(409); // nothing to stop yet
    const turn = api("POST", "/api/chat", { text: "每天晚上 10 点提醒我早点睡" });
    let question: { id: string } | null = null;
    for (let i = 0; i < 50 && !question; i++) {
      await new Promise((r) => setTimeout(r, 20));
      question = (await api("GET", "/api/state")).data.question;
    }
    expect(question).not.toBeNull();
    expect((await api("POST", "/api/chat/stop", {})).status).toBe(200);
    const done = await turn;
    expect(done.status).toBe(200);
    expect(done.data).toMatchObject({ stopped: true, reply: "" });
    const after = await api("GET", "/api/state");
    expect(after.data.question).toBeNull();
    expect(after.data.busy).toBe(false);
    expect(after.data.watches).toEqual([]);
  });
  it("counts the model calls of the day for the settings page", async () => {
    const { api, home } = await start({ model: { baseURL: "http://m.test/v1", model: "m" }, briefingAt: null });
    expect((await api("GET", "/api/usage")).data.days).toEqual([]);
    await api("POST", "/api/chat", { text: "你好" });
    await home.moqi.idle();
    const { data } = await api("GET", "/api/usage");
    expect(data.since).toBeGreaterThan(0);
    expect(data.days).toHaveLength(1);
    expect(data.days[0].chat).toMatchObject({ attempts: 1, failed: 0 });
  });
  it("says so instead of chatting when no model is set", async () => {
    const { api } = await start({});
    const res = await api("POST", "/api/chat", { text: "你好" });
    expect(res.status).toBe(409);
    expect(res.data.error).toContain("还没配置模型");
  });

  it("answers offers, forgets memories and cancels watches for the user, without asking again", async () => {
    const { home, api } = await start({ briefingAt: null });
    const offer = await home.moqi.offer({
      kind: "test.note",
      title: "一件事",
      body: "细节",
      value: 0.9,
      urgency: "today",
    });
    home.moqi.remember({ kind: "basic", content: "住在深圳南山" });
    await home.moqi.callTool(
      "watch_create",
      { title: "早点睡", schedule: { every: "day", at: "22:00" }, remind: "早点睡" },
      { byUser: true, preApproved: true },
    );
    const before = await api("GET", "/api/state");
    expect(before.data.offers).toMatchObject([{ id: offer.id, title: "一件事", action: false }]);
    const fact = before.data.facts[0];
    expect(fact).toMatchObject({ content: "住在深圳南山", term: "short", confirmations: 1, faded: false });
    const watch = before.data.watches[0];

    expect((await api("POST", "/api/offer", { id: offer.id, verdict: "nonsense" })).status).toBe(400);
    expect((await api("POST", "/api/offer", { id: offer.id, verdict: "accepted" })).status).toBe(200);
    expect((await api("POST", "/api/forget", { id: fact.id })).data.message).toContain("已忘掉");
    expect((await api("POST", "/api/watch/cancel", { id: watch.id })).status).toBe(200);

    const after = await api("GET", "/api/state");
    expect(after.data).toMatchObject({ offers: [], facts: [], watches: [], question: null });
    expect(home.moqi.state.kind("test.note").accepted).toBe(1);

    // A kind the user muted is dropped, so it never shows up in the feed.
    const muted = await home.moqi.offer({ kind: "test.note", title: "又一件", body: "", value: 0.9, urgency: "today" });
    expect((await api("POST", "/api/offer", { id: muted.id, verdict: "muted" })).status).toBe(200);
    await home.moqi.offer({ kind: "test.note", title: "不该出现", body: "", value: 0.9, urgency: "today" });
    expect((await api("GET", "/api/state")).data.offers).toEqual([]);
  });

  it("never sends the API key to the page, keeps it when the field is left blank, and applies changes at once", async () => {
    const { dir, home, api, net } = await start({ model: { ...MODEL, apiKey: "sk-secret" }, briefingAt: null });
    const got = await api("GET", "/api/config");
    expect(JSON.stringify(got.data)).not.toContain("sk-secret");
    expect(got.data).toMatchObject({ hasKey: true, config: { model: MODEL, dailyBudget: 3 } });

    const first = home.moqi;
    const config = {
      ...got.data.config,
      model: { ...MODEL, model: "m2" },
      dailyBudget: 5,
      persona: "叫我小王",
    };
    expect((await api("POST", "/api/config", { config })).data).toEqual({ ok: true });
    const file = readConfigFile(dir);
    expect(file).toMatchObject({
      model: { ...MODEL, model: "m2", apiKey: "sk-secret" },
      dailyBudget: 5,
    });
    expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);

    // The running moqi changed without a restart.
    expect(home.moqi).not.toBe(first);
    expect(home.moqi.policy.dailyBudget).toBe(5);
    expect(home.moqi.persona).toBe("叫我小王");
    await api("POST", "/api/chat", { text: "你好" });
    const call = net.seen.findLast((s) => s.url === "http://model.test/v1/chat/completions");
    expect(call?.auth).toBe("Bearer sk-secret");
    expect(JSON.stringify(call?.body)).toContain("叫我小王");

    const bad = await api("POST", "/api/config", { config: { ...config, quiet: { from: "25:00", to: "08:00" } } });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain("quiet.from");
    expect(readConfigFile(dir).quiet.from).toBe("22:30"); // unchanged

    expect((await api("POST", "/api/config", { config: { ...config, model: null } })).status).toBe(200);
    expect(readConfigFile(dir).model).toBeUndefined();
    expect(home.moqi.model).toBeUndefined();
  });

  it("never carries a saved key over to a different endpoint", async () => {
    const { dir, api, net } = await start({ model: { ...MODEL, apiKey: "sk-deepseek" }, briefingAt: null });
    const other = { baseURL: "http://elsewhere.test/v1", model: "m" };
    await api("POST", "/api/model/test", { model: other });
    expect(net.seen.find((x) => x.url.startsWith("http://elsewhere.test"))?.auth).toBeNull();

    const { config } = (await api("GET", "/api/config")).data;
    expect((await api("POST", "/api/config", { config: { ...config, model: other } })).status).toBe(200);
    expect(readConfigFile(dir).model).toEqual(other); // the old key is gone, not moved
  });

  it("tests a model connection, looks up a city and checks a calendar file", async () => {
    const { dir, api, net } = await start({ model: { ...MODEL, apiKey: "sk-saved" } }, () => ({
      content: "<think>嗯</think>你好呀",
    }));
    const test = await api("POST", "/api/model/test", {
      model: { ...MODEL, model: "m", noThink: true },
    });
    expect(test.data).toMatchObject({ ok: true, reply: "你好呀" });
    const sent = net.seen.find((s) => s.url === "http://model.test/v1/chat/completions");
    expect(sent?.auth).toBe("Bearer sk-saved"); // same endpoint: falls back to the saved key
    expect(JSON.stringify(sent?.body)).toContain("/no_think");
    expect((await api("POST", "/api/model/test", { model: { baseURL: "ftp://x", model: "m" } })).status).toBe(400);

    const city = await api("GET", `/api/geocode?q=${encodeURIComponent("深圳")}`);
    expect(city.data.results).toEqual([
      { name: "深圳", region: "广东 · 中国", latitude: 22.54554, longitude: 114.0683 },
    ]);

    const ics = join(dir, "cal.ics");
    writeFileSync(
      ics,
      "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:周会\nDTSTART:20261120T100000\nDTEND:20261120T110000\nEND:VEVENT\nEND:VCALENDAR\n",
    );
    expect((await api("POST", "/api/calendar/check", { path: ics })).data).toEqual({ exists: true, events: 1 });
    expect((await api("POST", "/api/calendar/check", { path: join(dir, "nope.ics") })).data).toEqual({
      exists: false,
      events: 0,
    });
    expect(readFileSync(ics, "utf8")).toContain("周会");
  });
});

describe("console: moqi thinking", () => {
  it("thinks on request, shows what it thought and why, and takes answers to its questions", async () => {
    const { api } = await start(
      { model: MODEL, briefingAt: null, news: { feeds: [{ name: "T", url: "https://feed.test/rss" }] } },
      (body) => {
        const system = body.messages[0]?.content ?? "";
        if (system.includes("你自己在想")) {
          const situation = body.messages[1]?.content ?? "";
          expect(situation).toContain("[n1] 深圳明天暴雨（T）");
          return {
            content: JSON.stringify({
              ideas: [
                { type: "ask", title: "你一般几点下班？", body: "好提前提醒路况", value: 0.4 },
                { type: "world", title: "深圳明天暴雨", body: "记得带伞", value: 0.3, refs: ["n1"] },
              ],
            }),
          };
        }
        if (system.includes("从对话里摘出"))
          return { content: '{"facts":[{"kind":"routine","content":"晚上 7 点下班"}]}' };
        return { content: "好" };
      },
    );
    const thought = await api("POST", "/api/reflect", {});
    expect(thought.data).toEqual({ ideas: 2 });

    const state = (await api("GET", "/api/state")).data;
    expect(state.thinking).toBe(false);
    const question = state.offers.find((o: { answer: boolean }) => o.answer);
    expect(question).toMatchObject({ title: "你一般几点下班？", links: [] });
    const news = state.offers.find((o: { links: unknown[] }) => o.links.length > 0);
    expect(news.links).toEqual([{ title: "深圳明天暴雨", url: "https://feed.test/rain" }]);
    expect(state.thoughts[0].trigger).toBe("user");
    expect(state.thoughts[0].ideas).toEqual([
      { type: "ask", title: "你一般几点下班？", value: 0.4, outcome: "不急，放进动态", offerId: question.id },
      { type: "world", title: "深圳明天暴雨", value: 0.3, outcome: "不急，放进动态", offerId: news.id },
    ]);

    expect((await api("POST", "/api/answer", { id: question.id, text: "一般 7 点" })).data.message).toBe(
      "记下了，谢谢",
    );
    const after = (await api("GET", "/api/state")).data;
    expect(after.messages.map((m: { text: string }) => m.text)).toEqual(["你一般几点下班？", "一般 7 点"]);
    expect(after.thoughts[0].ideas[0].outcome).toBe("不急，放进动态 · 你接受了");
  });

  it("needs a model to think, and offers the news presets in settings", async () => {
    const { dir, home, api } = await start({});
    expect((await api("POST", "/api/reflect", {})).status).toBe(409);
    const got = (await api("GET", "/api/config")).data;
    // A config written before news existed gets the default feeds; an empty list turns news off.
    expect(got.config.news.feeds.map((f: { name: string }) => f.name)).toEqual(["少数派", "IT之家", "Solidot"]);
    expect(home.moqi.plugins.map((p) => p.name)).toContain("news");
    expect(
      (await api("POST", "/api/config", { config: { ...got.config, model: null, news: { feeds: [] } } })).status,
    ).toBe(200);
    expect(home.moqi.plugins.map((p) => p.name)).not.toContain("news");
    expect(readConfigFile(dir).news).toEqual({ feeds: [] });
    expect(got.newsPresets.map((f: { name: string }) => f.name)).toContain("少数派");
    const feeds = [got.newsPresets[0], { name: "mine", url: "https://mine.example/feed" }];
    expect((await api("POST", "/api/config", { config: { ...got.config, model: null, news: { feeds } } })).status).toBe(
      200,
    );
    expect(readConfigFile(dir).news?.feeds).toEqual(feeds);
    const bad = await api("POST", "/api/config", {
      config: { ...got.config, model: null, news: { feeds: [{ name: "x", url: "not a url" }] } },
    });
    expect(bad.status).toBe(400);
  });
});

describe("console: what moqi learned", () => {
  it("studies on request, shows lessons and notes with sources, and deletes them", async () => {
    const { home, api } = await start(
      { model: MODEL, briefingAt: null, news: { feeds: [{ name: "T", url: "https://feed.test/rss" }] } },
      (body) => {
        const system = body.messages[0]?.content ?? "";
        if (system.includes("你在自学")) return { content: '{"topic":"深圳天气","refs":["n1"]}' };
        if (system.includes("正在为用户读一篇文章")) return { content: '{"notes":["深圳明天有暴雨"]}' };
        return { content: "{}" };
      },
    );
    expect((await api("POST", "/api/study", {})).data).toEqual({ learned: 1 });
    const s = (await api("GET", "/api/state")).data;
    expect(s.studying).toBe(false);
    expect(s.lastStudy).toMatchObject({ mode: "world", topic: "深圳天气", learned: 1 });
    expect(s.notes).toMatchObject([
      { content: "深圳明天有暴雨", source: { title: "深圳明天暴雨", url: "https://feed.test/rain" } },
    ]);
    home.moqi.emit({ type: "lesson.learned", lesson: { id: "l_x", content: "早上提醒更有用", at: 1 } });
    expect((await api("GET", "/api/state")).data.lessons).toMatchObject([{ id: "l_x", content: "早上提醒更有用" }]);
    expect((await api("POST", "/api/learned/remove", { id: "l_x" })).data.message).toBe("这条经验删掉了");
    expect((await api("POST", "/api/learned/remove", { id: s.notes[0].id })).data.message).toBe("这条笔记删掉了");
    const after = (await api("GET", "/api/state")).data;
    expect(after.lessons.length + after.notes.length).toBe(0);
  });
});

describe("console: dangerous tools", () => {
  it("lists them, lets the user unlock one, and shows what a confirmation is about", async () => {
    const ran: string[] = [];
    const term: Plugin = {
      name: "term",
      tools: [
        defineTool({
          name: "shell",
          description: "Run a shell command",
          input: z.object({ cmd: z.string() }),
          effect: "write",
          danger: true,
          source: "term-server",
          run: ({ cmd }) => {
            ran.push(cmd);
            return `ran ${cmd}`;
          },
        }),
      ],
    };
    const { home, api } = await start({ briefingAt: null }, undefined, [term]);
    expect((await api("GET", "/api/tools")).data.tools).toEqual([
      { name: "shell", source: "term-server", description: "Run a shell command", policy: "ask" },
    ]);
    expect((await api("POST", "/api/tool-policy", { tool: "shell", policy: "yolo" })).status).toBe(400);
    expect((await api("POST", "/api/tool-policy", { tool: "todo_add", policy: "auto" })).status).toBe(400);
    expect((await api("POST", "/api/tool-policy", { tool: "shell", policy: "auto" })).status).toBe(200);
    expect(home.moqi.state.toolPolicies.get("shell")).toBe("auto");
    expect((await api("POST", "/api/tool-policy/source", { source: "term-server", policy: "ask" })).data.message).toBe(
      "term-server 的 1 个工具以后每次都先问",
    );
    expect(home.moqi.state.toolPolicies.get("shell")).toBe("ask");
    expect((await api("POST", "/api/tool-policy/source", { source: "nobody", policy: "auto" })).status).toBe(400);
    expect((await api("POST", "/api/tool-policy/source", { source: "term-server", policy: "normal" })).status).toBe(
      400,
    );
    await api("POST", "/api/tool-policy", { tool: "shell", policy: "auto" });

    const offer = await home.moqi.offer({
      kind: "idea.serve",
      title: "看看主目录？",
      body: "",
      value: 0.5,
      urgency: "whenever",
      action: { tool: "shell", args: { cmd: "ls ~" } },
    });
    const answering = api("POST", "/api/offer", { id: offer.id, verdict: "accepted" });
    let question: { id: string; text: string; details?: string } | null = null;
    for (let i = 0; i < 50 && !question; i++) {
      await new Promise((r) => setTimeout(r, 20));
      question = (await api("GET", "/api/state")).data.question;
    }
    expect(question?.text).toBe("要我用「term-server」的 shell 吗？");
    expect(question?.details).toContain('"cmd": "ls ~"');
    await api("POST", "/api/confirm", { id: question?.id, yes: true });
    expect((await answering).data.message).toBe("ran ls ~");
    expect(ran).toEqual(["ls ~"]);
  });
});

describe("console: abilities", () => {
  it("checks the folders for files, loads the files plugin, and lists shortcuts", async () => {
    const folder = mkdtempSync(join(tmpdir(), "moqi-folder-"));
    const { api } = await start({ briefingAt: null }, undefined, [], { shortcuts: async () => ["早上模式"] });
    const { config, platform } = (await api("GET", "/api/config")).data;
    expect(platform).toBe(process.platform);
    const page = { model: null, briefingAt: null, quiet: config.quiet, dailyBudget: 3, news: { feeds: [] } };
    const bad = await api("POST", "/api/config", { config: { ...page, files: { folders: ["/no/such/folder"] } } });
    expect(bad).toMatchObject({ status: 400, data: { error: "文件夹「/no/such/folder」不存在，或者不是文件夹" } });
    expect((await api("POST", "/api/config", { config: { ...page, files: { folders: [folder] } } })).status).toBe(200);
    const tools = (await api("GET", "/api/tools")).data.tools as { name: string }[];
    expect(tools.map((t) => t.name)).toContain("files_trash");
    expect((await api("GET", "/api/shortcuts")).data).toEqual({ available: true, shortcuts: ["早上模式"] });
  });
});

describe("console: coding agents", () => {
  it("checks projects are git roots, shows a task, its changes, and discards it from the page", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "moqi-proj-")));
    const g = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project });
    g("init", "-q", "-b", "main");
    writeFileSync(join(project, "README.md"), "# p\n");
    g("add", ".");
    g("commit", "-qm", "init");
    const launch: Launch = async (run) => {
      writeFileSync(join(run.cwd, "NEW.md"), "hello\n");
      return { code: 0, stdout: "加了 NEW.md\n", stderr: "" };
    };
    const config = {
      briefingAt: null,
      code: { projects: [{ path: project, agent: "kiro", commands: ["pnpm test"] }] },
    };
    const { home, api } = await start(
      config,
      undefined,
      [],
      {},
      { codeFind: (bin) => `/bin/${bin}`, codeLaunch: launch },
    );
    expect((await api("GET", "/api/code/agents")).data).toEqual({ kiro: true, claude: true });

    const asking = home.moqi.callTool(
      "code_delegate",
      { project: basename(project), task: "加一个 NEW.md" },
      { byUser: true },
    );
    let question: { id: string; details?: string } | null = null;
    for (let i = 0; i < 50 && !question; i++) {
      await new Promise((r) => setTimeout(r, 20));
      question = (await api("GET", "/api/state")).data.question;
    }
    expect(question?.details).toContain("能跑的命令：pnpm test");
    await api("POST", "/api/confirm", { id: question?.id, yes: true });
    expect(await asking).toMatch(/^已经交给 Kiro 了/);
    let task: { id: string; status: string; files: number } | undefined;
    for (let i = 0; i < 100 && task?.status !== "done"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      task = (await api("GET", "/api/state")).data.code[0];
    }
    expect(task).toMatchObject({ status: "done", files: 1, agent: "Kiro", project: basename(project), into: "main" });
    const offer = (await api("GET", "/api/state")).data.offers.find((o: { kind: string }) => o.kind === "code.done");
    expect(offer?.taskId).toBe(task?.id);
    expect((await api("GET", `/api/code/diff?id=${task?.id}`)).data.diff).toContain("+hello");
    expect((await api("POST", "/api/code/stop", { id: task?.id })).status).toBe(409);
    expect((await api("POST", "/api/code/discard", { id: task?.id })).data.message).toMatch(/^丢弃了 moqi\//);
    expect((await api("GET", `/api/code/diff?id=${task?.id}`)).status).toBe(409);
    const after = (await api("GET", "/api/state")).data;
    expect(after.code[0].status).toBe("discarded");
    expect(after.history.find((o: { kind: string }) => o.kind === "code.done")).toMatchObject({
      outcome: "已丢弃",
      taskId: task?.id,
      canDiff: false,
    });
    expect(after.offers.filter((o: { kind: string }) => o.kind === "code.done")).toEqual([]);

    const notRepo = mkdtempSync(join(tmpdir(), "moqi-plain-"));
    const page = {
      model: null,
      briefingAt: null,
      quiet: { from: "22:30", to: "08:00" },
      dailyBudget: 3,
      news: { feeds: [] },
    };
    const bad = await api("POST", "/api/config", {
      config: { ...page, code: { projects: [{ path: notRepo, agent: "kiro", commands: [] }] } },
    });
    expect(bad).toMatchObject({ status: 400, data: { error: `「${notRepo}」不是 git 仓库的根目录` } });
  });
});

describe("console: todos", () => {
  it("adds, ticks off, reopens and deletes todos for the user, and says what is wrong", async () => {
    const { home, api } = await start({ briefingAt: null });
    const added = await api("POST", "/api/todo/add", { text: "交报告", day: "tomorrow", at: "15:00" });
    expect(added.status).toBe(200);
    expect(added.data.message).toContain("明天 15:00 提醒你「交报告」");
    expect((await api("POST", "/api/todo/add", { text: "买牛奶" })).status).toBe(200);
    expect((await api("POST", "/api/todo/add", { text: "  " })).status).toBe(400);
    const bad = await api("POST", "/api/todo/add", { text: "开会", at: "25:00" });
    expect(bad).toMatchObject({ status: 400, data: { error: "at 要写成 HH:MM，例如 15:00" } });

    const s = await api("GET", "/api/state");
    expect(s.data.todos.today).toMatchObject([{ text: "买牛奶", late: 0, by: null, remindAt: null, doneAt: null }]);
    expect(s.data.todos.later).toMatchObject([{ text: "交报告" }]);
    const milk = s.data.todos.today[0].id;
    expect((await api("POST", "/api/todo/done", { id: milk })).data.message).toContain("勾掉了「买牛奶」");
    expect((await api("GET", "/api/state")).data.todos.done).toMatchObject([{ id: milk }]);
    expect((await api("POST", "/api/todo/done", { id: milk })).status).toBe(400);
    expect((await api("POST", "/api/todo/undone", { id: milk })).status).toBe(200);
    expect((await api("POST", "/api/todo/remove", { id: milk })).data.message).toBe("删掉了「买牛奶」");
    const after = await api("GET", "/api/state");
    expect(after.data.todos.today).toEqual([]);
    expect(after.data.question).toBeNull(); // deleting on the page does not ask again
    expect(home.moqi.state.todos.get(milk)?.removedAt).toBeDefined();
    expect((await api("GET", "/api/config")).data.config.todoReviewAt).toBe("21:00");
  });
});

describe("console: other agents", () => {
  it("records what another agent learned, and caps what it tells the user below the quiet-hours bar", async () => {
    const { home, api } = await start({ briefingAt: null });
    const r = await api("POST", "/api/remember", { content: "在做 taugraph", kind: "nonsense" });
    expect(r.data.message).toContain("记住了");
    expect([...home.moqi.state.facts.values()][0]).toMatchObject({ content: "在做 taugraph", kind: "other" });
    await api("POST", "/api/remember", { content: "用 Kiro 写代码", from: "kiro-cli" });
    const facts = (await api("GET", "/api/state")).data.facts as { content: string; by: string | null }[];
    expect(facts.find((f) => f.content === "用 Kiro 写代码")?.by).toBe("kiro-cli");
    expect(facts.find((f) => f.content === "在做 taugraph")?.by).toBe("另一个 agent");
    expect((await api("POST", "/api/remember", { content: "  " })).status).toBe(400);

    const told = await api("POST", "/api/tell", { title: "部署好了", urgency: "now", value: 1, from: "Kiro!" });
    expect(told.data.surface).toMatch(/notify|feed/);
    expect(home.moqi.state.offers.get(told.data.id)?.offer).toMatchObject({ kind: "agent.kiro", value: 0.85 });
    expect((await api("POST", "/api/tell", { title: "" })).status).toBe(400);
  });
});

describe("console: connecting other agents", () => {
  it("lists the agents moqi found and connects or disconnects one on the user's click", async () => {
    const { osHome, api } = await start({ briefingAt: null });
    expect((await api("GET", "/api/agents")).data.agents).toEqual([]);
    mkdirSync(join(osHome, ".cursor"), { recursive: true });
    writeFileSync(join(osHome, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const listed = (await api("GET", "/api/agents")).data.agents;
    expect(listed).toEqual([{ id: "cursor", name: "Cursor", path: "~/.cursor/mcp.json", connected: false }]);

    expect((await api("POST", "/api/agents/connect", { id: "cursor" })).data).toEqual({ path: "~/.cursor/mcp.json" });
    const file = JSON.parse(readFileSync(join(osHome, ".cursor", "mcp.json"), "utf8"));
    expect(Object.keys(file.mcpServers)).toEqual(["other", "moqi"]);
    expect((await api("GET", "/api/agents")).data.agents[0].connected).toBe(true);

    expect((await api("POST", "/api/agents/disconnect", { id: "cursor" })).status).toBe(200);
    expect((await api("GET", "/api/agents")).data.agents[0].connected).toBe(false);
    expect((await api("POST", "/api/agents/connect", { id: "nobody" })).status).toBe(409);
  });
});

describe("console: tools and agents moqi uses", () => {
  it("adds and removes the browser preset", async () => {
    const { dir, api } = await start({ briefingAt: null });
    expect((await api("POST", "/api/preset", { name: "nope", on: true })).status).toBe(400);
    expect((await api("POST", "/api/preset", { name: "browser", on: true })).status).toBe(200);
    expect(readConfigFile(dir).mcp?.servers.browser?.args).toContain("@playwright/mcp@0.0.86");
    expect(existsSync(join(dir, "browser"))).toBe(true);
    expect((await api("POST", "/api/preset", { name: "browser", on: false })).status).toBe(200);
    expect(readConfigFile(dir).mcp?.servers.browser).toBeUndefined();
  });

  it("keeps MCP servers and A2A agents when the settings page is saved", async () => {
    const { dir, api } = await start({
      briefingAt: null,
      mcp: { servers: { echo: { command: "/usr/bin/true" } } },
      a2a: { agents: [{ name: "bob", url: "https://bob.test" }] },
    });
    const { config } = (await api("GET", "/api/config")).data;
    const page = { model: null, briefingAt: null, quiet: config.quiet, dailyBudget: 3, news: { feeds: [] } };
    expect((await api("POST", "/api/config", { config: page })).status).toBe(200);
    const saved = readConfigFile(dir);
    expect(Object.keys(saved.mcp?.servers ?? {})).toEqual(["echo"]);
    expect(saved.a2a?.agents.map((a) => a.name)).toEqual(["bob"]);
  });

  const fixture = join(import.meta.dirname, "fixtures", "echo-mcp.mjs");

  it("takes an MCP server from another agent, shows its tools, and removes it", async () => {
    const { dir, osHome, home, api } = await start({ briefingAt: null }, () => ({ content: "好" }));
    mkdirSync(join(osHome, ".cursor"), { recursive: true });
    writeFileSync(
      join(osHome, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [fixture] }, moqi: { command: "x" } } }),
    );
    const before = (await api("GET", "/api/interop")).data;
    expect(before.servers).toEqual([]);
    expect(before.importable).toEqual([{ name: "echo", from: "Cursor", command: `${process.execPath} ${fixture}` }]);
    expect(before.a2a).toMatchObject({ agents: [] });

    expect((await api("POST", "/api/mcp/import", { names: ["echo"] })).data).toEqual({ ok: true, names: ["echo"] });
    expect(readConfigFile(dir).mcp?.servers.echo).toEqual({ command: process.execPath, args: [fixture] });
    for (let i = 0; i < 200 && home.mcpStatus()[0]?.state !== "ready"; i++) await new Promise((r) => setTimeout(r, 20));
    const after = (await api("GET", "/api/interop")).data;
    expect(after.servers).toMatchObject([{ name: "echo", state: "ready", tools: 4, error: null }]);
    expect(after.importable).toEqual([]);

    expect((await api("POST", "/api/mcp/remove", { name: "echo" })).status).toBe(200);
    expect(home.mcpStatus()).toEqual([]);
    expect((await api("POST", "/api/mcp/add", { name: "bad name!", command: "x" })).status).toBe(400);
  });

  it("adds and removes A2A agents moqi may ask, without sending their keys to the page", async () => {
    const { dir, home, api } = await start({ briefingAt: null });
    expect(
      (await api("POST", "/api/a2a/add", { name: "travel", url: "https://travel.example", key: "secret" })).status,
    ).toBe(200);
    expect(readConfigFile(dir).a2a?.agents).toEqual([{ name: "travel", url: "https://travel.example", key: "secret" }]);
    const listed = (await api("GET", "/api/interop")).data.a2a.agents;
    expect(listed).toEqual([{ name: "travel", url: "https://travel.example", hasKey: true }]);
    expect(JSON.stringify(listed)).not.toContain("secret");
    expect(home.moqi.tool("ask_travel")?.effect).toBe("write"); // asking another agent is asked first
    expect((await api("POST", "/api/a2a/remove", { name: "travel" })).status).toBe(200);
    expect(home.moqi.tool("ask_travel")).toBeUndefined();
  });
});

describe("confirm queue", () => {
  it("treats an unanswered question as no, and only one question is open at a time", async () => {
    const asker = confirmQueue(30);
    const first = asker.ask("A？");
    const firstId = asker.pending()?.id ?? "";
    const second = asker.ask("B？");
    expect(await first).toBe(false); // replaced by the newer question
    expect(asker.answer(firstId, true)).toBe(false);
    expect(asker.pending()?.text).toBe("B？");
    expect(await second).toBe(false); // timed out
    expect(asker.pending()).toBeUndefined();
  });
});

describe("console: images", () => {
  const T = "t".repeat(32);
  const upload = (port: number, bytes: Uint8Array, type = "image/png", token = T) =>
    fetch(`http://127.0.0.1:${port}/api/media`, {
      method: "POST",
      headers: { "x-moqi-token": token, "content-type": type },
      body: new Blob([new Uint8Array(bytes)]),
    });

  it("takes images, gives them back, and sends them to the model with the message", async () => {
    let seen: unknown;
    const { ui, api } = await start({ model: MODEL, briefingAt: null }, (body) => {
      seen = body.messages.at(-1);
      return { content: "一个红色方块" };
    });
    expect((await upload(ui.port, RED_PNG, "image/png", "x".repeat(32))).status).toBe(401);
    expect((await upload(ui.port, Buffer.from("hello"), "text/plain")).status).toBe(415);
    expect((await upload(ui.port, Buffer.from("hello"), "image/png")).status).toBe(415);
    const tooBig = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: ui.port,
          path: "/api/media",
          method: "POST",
          headers: { "x-moqi-token": T, "content-type": "image/png", "content-length": String(3 * 1024 * 1024 + 1) },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        },
      );
      req.on("error", reject);
      req.flushHeaders();
    });
    expect(tooBig).toBe(413);

    const { id } = (await (await upload(ui.port, RED_PNG)).json()) as { id: string };
    expect(id).toMatch(/^m_[0-9a-f]{16}$/);
    const got = await fetch(`http://127.0.0.1:${ui.port}/api/media?id=${id}`, { headers: { "x-moqi-token": T } });
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await got.arrayBuffer()).equals(RED_PNG)).toBe(true);
    expect((await api("GET", "/api/media?id=../config.json")).status).toBe(400);
    expect((await api("GET", "/api/media?id=m_0000000000000000")).status).toBe(404);

    expect((await api("POST", "/api/chat", { text: "", images: [] })).status).toBe(400);
    expect((await api("POST", "/api/chat", { text: "这是什么", images: ["m_0000000000000000"] })).status).toBe(400);
    expect((await api("POST", "/api/chat", { text: "这是什么", images: [id], from: "kiro" })).status).toBe(400);
    expect((await api("POST", "/api/chat", { text: "这是什么", images: [id] })).data.reply).toBe("一个红色方块");
    expect(seen).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "这是什么" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${RED_PNG.toString("base64")}` } },
      ],
    });
    const state = (await api("GET", "/api/state")).data;
    expect(state.messages.at(-2)).toMatchObject({ role: "user", text: "这是什么", images: [id] });
    expect(state.vision).toBeNull();
  });

  it("finds out once whether the model can see, and forgets it when the model changes", async () => {
    let answer = "红色";
    const { dir, api } = await start({ model: MODEL, briefingAt: null }, () => ({ content: answer }));
    expect((await api("POST", "/api/model/vision", {})).data).toEqual({ vision: true });
    expect(readConfigFile(dir).model?.vision).toBe(true);
    expect((await api("GET", "/api/state")).data.vision).toBe(true);
    answer = "我看不到图片";
    expect((await api("POST", "/api/model/vision", { model: MODEL })).data).toEqual({ vision: false });
    expect(readConfigFile(dir).model?.vision).toBe(true); // testing a form's model does not save
    const config = (await api("GET", "/api/config")).data.config;
    await api("POST", "/api/config", { config: { ...config, model: { ...MODEL } } });
    expect(readConfigFile(dir).model?.vision).toBe(true); // same model: kept
    await api("POST", "/api/config", { config: { ...config, model: { ...MODEL, model: "m2" } } });
    expect(readConfigFile(dir).model?.vision).toBeUndefined(); // another model: forgotten
    await api("POST", "/api/config", { config: { ...config, model: { ...MODEL, model: "m2", vision: false } } });
    expect(readConfigFile(dir).model?.vision).toBe(false); // the page tested this very model
  });

  it("lets images come from the page only, under the policy", async () => {
    const { ui } = await start({});
    const csp = (await fetch(`http://127.0.0.1:${ui.port}/`)).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("img-src 'self' data: blob:");
  });
});
