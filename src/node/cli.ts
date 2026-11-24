#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { activeFacts } from "../core/memory.js";
import type { ModelCall } from "../core/model.js";
import { describeSchedule } from "../core/schedule.js";
import type { Offer, Surface, Verdict } from "../core/types.js";
import { moqiHome, writeTemplate } from "./config.js";
import { a2aKeyFor, consoleAddress, consoleToken, runningConsole, writeConsoleInfo } from "./console/info.js";
import { confirmQueue, DEFAULT_PORT, startConsole } from "./console/server.js";
import { lockHolder } from "./file-store.js";
import { type Home, openHome, terminalAnswer } from "./home.js";
import { type MoqiLink, serveMcp } from "./mcp.js";

const HELP = `moqi — 不用开口就懂你的个人 agent

  moqi            在后台运行 moqi，并在浏览器里打开控制台（对话、动态、记忆、设置）
  moqi stop       停掉后台的 moqi
  moqi brief      打印今天的简报
  moqi chat       在终端里对话（后台的 moqi 没在运行时）
  moqi daemon     在前台运行，不开浏览器（给 launchd、systemd 这类服务管理器用）
  moqi mcp        MCP 服务（stdio），让 Kiro、Cursor 等其他 agent 和 moqi 交流
  moqi a2a        显示 A2A 的地址和钥匙，让支持 A2A 的 agent 和 moqi 交流
  moqi init       在 ~/.moqi/config.json 写一份配置模板

对话里的命令：
  /brief  /offers  /accept <id>  /dismiss <id>  /mute <id>  /unmute <kind>
  /memory  /watches  /trust  /help  /quit

数据都在 $MOQI_HOME（默认 ~/.moqi），events.jsonl 是全部记录。`;

const TICK_MS = 30_000;

function show(offer: Offer, surface: Surface): string {
  const head = surface === "notify" ? "[提醒]" : "[动态]";
  const action = offer.action ? `  （/accept ${offer.id}）` : "";
  return `${head} ${offer.title}${offer.body ? `\n  ${offer.body.split("\n").join("\n  ")}` : ""}${action}`;
}

/** One line per model attempt, for the daemon log. */
function modelLine(c: ModelCall): string {
  const what = `${c.model} ${c.purpose === "chat" ? "对话" : "后台"} 第 ${c.attempt} 次 ${c.ms}ms`;
  if (!c.ok) return `moqi: 模型失败 ${what}：${c.error ?? ""}`;
  return `moqi: 模型 ${what}${c.promptTokens !== undefined ? ` ${c.promptTokens}+${c.completionTokens ?? 0} tokens` : ""}`;
}
function heartbeat(home: Home, onError: (e: unknown) => void): () => void {
  let busy = false;
  const beat = async () => {
    if (busy) return;
    busy = true;
    try {
      await home.serial(() => home.moqi.tick());
    } catch (error) {
      onError(error);
    } finally {
      busy = false;
    }
  };
  void beat();
  const timer = setInterval(beat, TICK_MS);
  return () => clearInterval(timer);
}

async function command(home: Home, line: string): Promise<string | "quit"> {
  const { moqi } = home;
  const [cmd, arg = ""] = line.slice(1).trim().split(/\s+/, 2);
  const verdicts: Record<string, Verdict> = { accept: "accepted", dismiss: "dismissed", mute: "muted" };
  switch (cmd) {
    case "quit":
    case "exit":
      return "quit";
    case "help":
      return HELP;
    case "brief": {
      const b = await moqi.briefing();
      return `${b.title}\n${b.body}`;
    }
    case "offers": {
      const open = moqi.state.openOffers(moqi.clock.now());
      return open.length
        ? open.map((o) => `${o.id}  ${o.title}${o.action ? "（可接受）" : ""}`).join("\n")
        : "没有待处理的事";
    }
    case "accept":
    case "dismiss":
    case "mute":
      return arg ? moqi.feedback(arg, verdicts[cmd] as Verdict) : `用法：/${cmd} <id>`;
    case "unmute":
      if (!arg) return "用法：/unmute <kind>";
      moqi.unmute(arg);
      return `恢复提醒「${arg}」`;
    case "memory": {
      const facts = activeFacts(moqi.state, moqi.clock.now());
      return facts.length
        ? facts
            .map((f) => `${f.id}  ${f.content}  ${f.term === "long" ? "长期" : `印证 ${f.confirmations}/3`}`)
            .join("\n")
        : "还不了解你，多聊几句";
    }
    case "watches": {
      const ws = [...moqi.state.watches.values()];
      return ws.length
        ? ws.map((w) => `${w.id}  ${w.title}  ${describeSchedule(w.schedule)}`).join("\n")
        : "没有托管的事";
    }
    case "trust": {
      const rows = [...moqi.state.trust.entries()].map(([kind, t]) => `${kind}: ${t.level}（连续同意 ${t.streak} 次）`);
      return rows.length ? rows.join("\n") : "还没有需要你批准过的事";
    }
    default:
      return `不认识 /${cmd}，/help 看用法`;
  }
}

/** Lines from stdin, queued so none are lost when input is piped faster than moqi answers. */
function lineReader() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const queued: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let closed = false;
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else queued.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const w of waiting.splice(0)) w(undefined);
  });
  return {
    next(prompt: string): Promise<string | undefined> {
      process.stdout.write(prompt);
      if (queued.length > 0) return Promise.resolve(queued.shift());
      if (closed) return Promise.resolve(undefined);
      return new Promise((resolve) => waiting.push(resolve));
    },
    close: () => rl.close(),
  };
}

async function interactive(): Promise<void> {
  const input = lineReader();
  const print = (text: string) => process.stdout.write(`${text}\n`);
  const home = openHome({
    home: moqiHome(),
    onDeliver: (offer, surface) => print(show(offer, surface)),
    confirm: async (question, details, choices) => {
      if (details) console.log(details);
      const line = (await input.next(`${question} ${choices ? "[y/N/a]" : "[y/N]"} `)) ?? "";
      return terminalAnswer(line, choices !== undefined);
    },
  });
  const stop = heartbeat(home, (e) => print(`（后台出错：${e instanceof Error ? e.message : String(e)}）`));
  print(`moqi 在。${home.config.model ? "" : "还没配置模型，只能用命令；运行 moqi 在控制台里设置。"}/help 看用法`);
  try {
    for (;;) {
      const raw = await input.next("你：");
      if (raw === undefined) break; // input closed
      const line = raw.trim();
      if (line === "") continue;
      if (line.startsWith("/")) {
        const out = await command(home, line);
        if (out === "quit") break;
        print(out);
        continue;
      }
      if (!home.moqi.model) {
        print(
          "还没配置模型。运行 moqi 在控制台里设置，或编辑 ~/.moqi/config.json，或设置 MOQI_BASE_URL 和 MOQI_MODEL。",
        );
        continue;
      }
      try {
        print(`moqi：${await home.moqi.chat(line)}`);
      } catch (error) {
        print(`（出错了：${error instanceof Error ? error.message : String(error)}）`);
      }
    }
  } finally {
    stop();
    input.close();
    await home.moqi.idle(); // let background learning finish writing to the log
    home.close();
  }
}

function pkgVersion(): string {
  return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string })
    .version;
}

async function main(): Promise<void> {
  const [cmd] = process.argv.slice(2);
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return void console.log(HELP);
  if (cmd === "--version" || cmd === "-v") return void console.log(pkg.version);
  if (cmd === "init")
    return void console.log(`写好了：${writeTemplate(moqiHome())}\n运行 moqi，在控制台的「设置」里改。`);
  if (cmd === undefined || cmd === "open") return openConsole();
  if (cmd === "daemon") return daemon();
  if (cmd === "stop") return stop();
  if (cmd === "brief") return brief();
  if (cmd === "mcp") return mcp(pkg.version);
  if (cmd === "a2a") return a2a();
  if (cmd === "chat") {
    const running = runningConsole(moqiHome());
    if (running)
      throw new Error(
        `moqi 正在后台运行，请在控制台里对话：${consoleAddress(running.port)}\n想用终端对话，先 moqi stop。`,
      );
    return interactive();
  }
  console.error(`不认识 ${cmd}\n\n${HELP}`);
  process.exitCode = 2;
}

/** The always-on home: heartbeat plus the console, in the foreground. */
async function daemon(): Promise<void> {
  const dir = moqiHome();
  const asker = confirmQueue();
  const home = openHome({
    home: dir,
    onDeliver: (o, s) => console.log(show(o, s)),
    confirm: (q, d, c) => asker.ask(q, d, c),
    onModelCall: (c) => console.error(modelLine(c)),
  });
  const stopBeat = heartbeat(home, (e) => console.error(`moqi: ${e instanceof Error ? e.message : String(e)}`));
  const token = consoleToken(dir);
  const a2aKey = a2aKeyFor(dir);
  const ui = await startConsole({ home, asker, token, a2aKey, version: pkgVersion(), port: DEFAULT_PORT });
  writeConsoleInfo(dir, { pid: process.pid, port: ui.port, token, a2aKey });
  console.log(
    `moqi 在后台留意着（${home.logPath}）。\n控制台：${consoleAddress(ui.port)}\n第一次用这个带钥匙的链接打开：${ui.url}`,
  );
  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    stopBeat();
    await ui.close();
    await home.moqi.idle();
    home.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void quit());
  process.once("SIGTERM", () => void quit());
}

/** Starts the home in the background if it is not running, then opens the console in the browser. */
async function openConsole(): Promise<void> {
  const running = await ensureRunning(moqiHome(), (line) => console.log(line));
  console.log(`控制台：${consoleAddress(running.port)}`);
  console.log(`第一次请用这个带钥匙的链接打开，之后这个浏览器直接输入上面的地址就行：\n${running.url}`);
  if (!process.env.MOQI_NO_OPEN) openBrowser(running.url);
}

/** The running moqi, started in the background first if needed. */
async function ensureRunning(dir: string, say: (line: string) => void) {
  let running = runningConsole(dir);
  if (!running) {
    const holder = lockHolder(dir);
    if (holder) throw new Error(`终端里的 moqi chat 正在用这个目录（pid ${holder}），先退出它。`);
    mkdirSync(dir, { recursive: true, mode: 0o700 }); // first run on this machine
    const log = join(dir, "daemon.log");
    const out = openSync(log, "w");
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "daemon"], {
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env,
    });
    child.unref();
    for (let i = 0; i < 100 && !running; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (child.exitCode !== null) break;
      running = runningConsole(dir);
      if (running && running.pid !== child.pid) running = undefined;
    }
    if (!running) throw new Error(`moqi 没能启动，看看 ${log}`);
    say(`moqi 在后台运行了（pid ${running.pid}）。停掉它：moqi stop`);
  }
  return running;
}

/** Where other agents find moqi over A2A, and the key they need. */
async function a2a(): Promise<void> {
  const running = await ensureRunning(moqiHome(), (line) => console.log(line));
  if (!running.a2aKey) throw new Error("后台的 moqi 是旧版本，先 moqi stop 再 moqi");
  console.log(`A2A agent card：${consoleAddress(running.port)}/.well-known/agent-card.json`);
  console.log(`钥匙（请求头 Authorization: Bearer <钥匙>）：${running.a2aKey}`);
}

/** MCP over stdio for other agents. stdout carries the protocol only; everything else goes to stderr. */
async function mcp(version: string): Promise<void> {
  const dir = moqiHome();
  const say = (line: string) => process.stderr.write(`${line}\n`);
  const link: MoqiLink = {
    async call(method, path, body) {
      const running = await ensureRunning(dir, say); // looked up each time: moqi may have been restarted
      const response = await fetch(`http://127.0.0.1:${running.port}${path}`, {
        method,
        headers: { "x-moqi-token": running.token, ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(data.error ?? `moqi 回答了 HTTP ${response.status}`));
      return data;
    },
  };
  await serveMcp(link, version);
}

async function stop(): Promise<void> {
  const dir = moqiHome();
  const pid = lockHolder(dir);
  if (!pid) return void console.log("moqi 没在运行");
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50 && lockHolder(dir); i++) await new Promise((r) => setTimeout(r, 100));
  if (lockHolder(dir)) throw new Error(`pid ${pid} 还没退出`);
  console.log("moqi 已停止");
}

async function brief(): Promise<void> {
  const dir = moqiHome();
  const running = runningConsole(dir);
  if (running) {
    // The running moqi owns the log, so ask it instead of opening the log a second time.
    const response = await fetch(`http://127.0.0.1:${running.port}/api/briefing`, {
      headers: { "x-moqi-token": running.token },
    });
    const data = (await response.json()) as { title?: string; body?: string; error?: string };
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return void console.log(`${data.title}\n${data.body}`);
  }
  const home = openHome({ home: dir });
  try {
    const b = await home.moqi.briefing();
    console.log(`${b.title}\n${b.body}`);
  } finally {
    home.close();
  }
}

/** Arguments, never a shell string, so a URL cannot run commands. */
function openBrowser(url: string): void {
  const [file, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  execFile(file, args, () => {}); // no browser is fine: the URL is printed
}

main().catch((error: unknown) => {
  console.error(`moqi: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
