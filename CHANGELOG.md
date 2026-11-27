# Changelog

## [Unreleased]

- **Breaking:** the model contract is taugraph's `LLMModel` (`complete(request, { signal })`, from `taugraph/nodes`, re-exported as a type). `ChatModel`, `ChatRequest`, `ChatReply`, `ChatMessage`, `ToolCall` and moqi's own adapter are gone; `MoqiOptions.model` takes an `LLMModel`, and `complete(model, request, signal?)` makes one call. `openAICompatible` keeps its name and options (`noThink`, `effort`) and now runs on `taugraph/openai`.
- Each conversation turn runs as a `taugraph/agent` run and each watch as a taugraph flow, and `MoqiOptions.onTrace` receives their traces. The home keeps them under `~/.moqi/runs/`, one JSONL file per run, for 30 days. Answers and `watch.ran` events carry the `run` id of their trace. Images in requests are `media:<id>` references, read when a request is sent.
- After six rounds of tools the last model call still goes without tools. Changed: invalid tool arguments and unknown tools are answered in English (`Invalid arguments: ...`, `No tool named "x"`), at most 32 tool calls run per reply, and the model can no longer call hidden tools.
- The image check reads the status of a refusal (400, 413, 415, 422) instead of matching the error text.
- Depends on taugraph `^0.4.1`. A watch whose check fails now waits 250–500 ms before its one retry.

## [0.7.2] - 2026-11-23

- Fix: weather watches named after your city reported 北京. The config template no longer puts in 北京 as a placeholder; the weather tool takes a city (`place`) and looks it up, so "南京天气" watches carry 南京; and when moqi remembers you live somewhere other than the weather place, it offers once to switch, saving the new place when you accept.
- Settings: unlock all of one MCP server's tools at once, or set them all back to asking; unlocking takes a second tap and leaves tools the server adds later asking. Tools are listed by where they come from.
- Feed: 「现在想一想」 sits at the top of the page.

## [0.7.1] - 2026-11-23

- Fix: after a crash left the last line of `events.jsonl` half written, the next event was written onto the same line and lost on the following start. The log now ends a torn last line before writing again. Thanks @lycenxx (#1).

## [0.7.0] - 2026-11-23

- Images in the conversation: paste, drop or pick up to 4 images; moqi checks once whether the model can see them (it shows the model a red square) and greys out the button when it cannot. Images stay under `~/.moqi/media` and go only to your model; the last three messages with images keep them. Answers are formatted: lists, bold, code with a copy button, tables and link cards, with no HTML and nothing loaded from outside. Images that tools bring back (browser and macOS screenshots, MCP servers) show under the answer and can be opened large.
- Console style: warm paper colours, the teal kept, more room, a greeting with three examples to start from.
- Feed: cards you handled stay in "看过的" for 30 days (at most 100) with their links and what became of them; a merged coding task can still show its changes; ideas in "moqi 在想" lead to their cards.
- Fewer questions: a site can be allowed for good ("以后都允许"), after which opening, clicking and paging there are not asked (typing, forms, uploads and scripts still are); remembered sites are listed in Settings and can be removed. Ordinary actions (new folder, new file, move, rename, clipboard, watches, removing todos) can be set to run without asking in Settings. Merging a finished coding task takes one tap on its card, which names the branch. Browser tools set to "放开" keep to the sites already granted after reading a page, instead of asking at every click. In `moqi chat`, `a` answers "以后都允许".

## [0.6.1] - 2026-11-23

- Fix: an MCP server that exited or closed its input right after starting could crash moqi with `EPIPE`; it is now marked failed. A macOS command that exits without reading its input no longer crashes moqi either.
- Fix: merging a coding task failed in a repository without a git identity, and said there was a conflict. The merge commit now uses moqi as its author there, like moqi's commit in the worktree, and a merge that fails for another reason says why.

## [0.6.0] - 2026-11-23

- Coding agents: in chat, hand a coding task to Kiro CLI or Claude Code for a project you set up in Settings. Each task gets a branch of its own in a worktree under `~/.moqi/code`, so your project directory stays untouched until you merge. The agent may edit only that worktree and run only the commands you list for the project; Claude Code runs them in its sandbox, offline unless the project allows the network, while Kiro refuses every other command but does not cut the network for listed ones. moqi passes on your coding preferences and lessons, listed one by one in the confirmation, commits the result, and tells you in the feed: look at the changes, merge (asked again, refused over uncommitted work or a conflict), or discard. Tasks can be stopped, time out after 30 minutes, and a restart marks them interrupted. moqi runs no git hooks in its own git steps, so a hook the agent wrote never runs outside its sandbox (your project's hooks do not run on the merge either), and Claude Code gets none of your or the repo's settings, only the login in `~/.claude/settings.json`. Tried on this computer with Kiro: edits stayed in the worktree, `ls ~` and writing to /tmp were refused. Claude Code is not tried for real yet. Questions that end in an English word get a space before 吗.

- Abilities: moqi can work on the web, with your files and on your Mac. The browser is Playwright's MCP server (pinned to 0.0.86) with a profile of its own; within a conversation turn each site is asked once, after which moqi browses and clicks there freely, while typing, forms, uploads, scripts and other sites are still asked. Files works only in the folders you pick (Downloads and Desktop by default): list, read, make folders and new files, move, rename, and move to the Trash, never overwriting or deleting for good. On macOS: open apps, show files in Finder, take screenshots, set the volume, read and write the clipboard, and run the Shortcuts you tick in Settings, each one asked first. Saving the settings page no longer drops MCP servers and A2A agents.
- Dangerous actions: write tools from MCP servers and A2A agents are dangerous by default and asked every time, with exactly what they would do and why. Only you can unlock one, in Settings; moqi never offers to. An unlocked one is still asked when the conversation turn has read anything from outside (a web page, a file, a calendar entry, another agent's message), and a dangerous action an offer carries is confirmed after you accept it. Another agent's message through `/api/chat`, `moqi_ask` or A2A counts as outside content, and so do memories other agents wrote (the Memory tab shows who) or that moqi kept after reading outside content. Notes from articles go into the prompt as reference only.

## [0.5.1] - 2026-11-23

- License: Apache-2.0 from this version, with a NOTICE file that copies and derived works must keep. Versions up to 0.5.0 stay under MIT.

## [0.5.0] - 2026-11-23

- Todos: a list of what you mean to do, by day, with reminders at a time you set. Those reminders always arrive, in quiet hours and past the daily budget, without using it; a reminder more than half an hour late is treated as an ordinary offer. Unfinished todos roll over and show how many days they were put off; at 21:00 (`todoReviewAt`) moqi lists what is left. Add them in chat ("明天下午三点提醒我交报告"), in the console's new 待办 tab, or from other agents with `moqi_todo`. moqi also learns from them: reflection hears todos you mentioned without asking and offers to keep them, a todo added for three days becomes a daily reminder offer, and study reviews which reminders get done and which get put off.
- Study: while the user is away (half an hour without a message, outside quiet hours, at most three times a day), moqi learns on its own. With enough new reactions to review, it writes lessons about how to help this user and retires ones proven wrong; otherwise it picks a topic from the profile, reads one or two articles its feeds listed, and keeps notes with their source. Lessons and notes go into every chat and reflection, show in the Memory tab with sources, and can be deleted. A "现在学一学" button studies on demand.
- A2A server: the running moqi publishes an agent card at `/.well-known/agent-card.json` and answers `SendMessage` (A2A 1.0) and `message/send` (0.3) over JSON-RPC with its own key (`moqi a2a` shows it). Other agents' messages are marked as theirs in the conversation. Tested with the official A2A JS client.
- MCP client: servers in `mcp.servers` become moqi's tools; read-only ones run freely and can drive watches, the rest are asked first. moqi offers once to use the MCP servers other agents have configured. Settings show each server's state and tools, with add, import and remove.
- A2A client: agents in `a2a.agents` become `ask_<name>` tools, asked first because what moqi sends is shared. Works with 1.0 and 0.3 agents.
- MCP server: `moqi_tell` and `moqi_ask` name the calling agent from its MCP handshake; `moqi_profile` includes the lessons moqi learned.

## [0.4.0] - 2026-11-20

- Finding other agents: moqi looks for Kiro, Cursor, Claude Code, Claude Desktop, VS Code, Windsurf and Gemini CLI, and for unknown agents by their MCP config in the home directory, then offers once in the feed to connect the ones not connected yet. Settings list every agent found with connect and disconnect buttons. Only the `moqi` entry is added or removed; the rest of the file and its permissions are kept, the file is backed up once as `.moqi-backup`, and unreadable files are left alone. Entries use absolute paths so GUI apps find moqi without a shell PATH.
- `moqi mcp`: an MCP server over stdio so other agents (Kiro, Cursor, Claude Code) can read the user's profile, record what they learned about the user, tell the user something through moqi's attention rules (per agent, so one can be muted alone), talk to moqi, and read its feed and briefing. It starts moqi in the background when needed. No new runtime dependency; tested with the official MCP client and with Kiro CLI.
- Fix: in the console, the answer box of a question lost focus and what was typed every few seconds. The feed and memory lists are now rebuilt only when what they show changes, and a draft answer and its cursor survive a rebuild.

## [0.3.0] - 2026-11-20

- Reflection: every two hours while the user is awake, and ten minutes after a conversation settles, moqi asks the model for up to three ideas: something to do (with a ready action), a question to know the user better (at most two a day; answers are learned from at once), or news that matters to them. Ideas are offers like everything else; only timely ones may interrupt, near-duplicates within a week are skipped, and small-model replies are read leniently.
- Console: "moqi 在想" lists every idea and what became of it, with a "现在想一想" button; questions have an answer box; news links open the article. The address is now `http://moqi.localhost:6674` (MOQI on a phone keypad) and the browser remembers the key after the first visit.
- News plugin: RSS and Atom feeds, a `news` tool for chat and watches, headlines for reflection. On by default with 少数派, IT之家 and Solidot, also for existing configs; `"news": { "feeds": [] }` turns it off.
- Model presets in settings include Muse Glimmer (local); `model.effort` sends `reasoning_effort` with background requests.
- Decisions about offers now carry a reason in plain Chinese, also for dropped offers.

## [0.2.0] - 2026-11-20

- Console: `moqi` now starts moqi in the background and opens a page on 127.0.0.1 with chat, feed, memory and settings. Settings apply at once without a restart; model presets with a connection test, city search for the weather, a check for the calendar file. The page needs a per-home key, refuses foreign `Host` headers, loads nothing from outside and never receives a saved API key; a saved key is only ever sent to the endpoint it was saved for.
- `moqi stop`; `moqi brief` asks the running moqi instead of failing on its lock. The terminal chat moved to `moqi chat`.
- Config: times must be `HH:MM`.

## [0.1.0] - 2026-11-20

First version (P0): runs on a computer.

- Core in plain TypeScript (no Node APIs): event-sourced state, user model (3 confirmations to long-term, 30-day fade, contradictions settled by the user), proactive engine (quiet hours, daily interruption budget, per-kind thresholds learned from feedback), trust ladder per action kind, routine detection, daily briefing, watches as taugraph flows, side-channel learning from conversation.
- Plugins: weather (Open-Meteo, no key) and calendar (.ics).
- Node host: append-only JSONL log with a single-process lock, system notifications (macOS, Linux), config file, `moqi` / `moqi daemon` / `moqi brief` / `moqi init`.
- OpenAI-compatible model adapter with tool calling; `noThink` for Qwen3-style local models.
