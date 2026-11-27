// The moqi console. No framework and no outside requests: everything goes to the moqi on this machine.

// The key comes once in the link moqi opens; this browser remembers it, so later the short address is enough.
const fromLink = new URLSearchParams(location.hash.slice(1)).get("t");
if (fromLink) {
  localStorage.setItem("moqi.key", fromLink);
  history.replaceState(null, "", location.pathname);
}
const token = fromLink || localStorage.getItem("moqi.key") || "";
const $ = (id) => document.getElementById(id);

const OLLAMA = "http://127.0.0.1:11434/v1";
const PRESETS = {
  ollama: {
    baseURL: OLLAMA,
    model: "qwen3:4b",
    noThink: true,
    local: true,
    hint: "先在终端运行 ollama pull qwen3:4b（约 2.5 GB）",
  },
  glimmer: {
    baseURL: OLLAMA,
    model: "muse-glimmer",
    noThink: false,
    effort: "low",
    local: true,
    hint: "Meta 的本地 Muse 模型，想得比小模型好得多。约 18 GB，建议 24 GB 以上内存；先在终端运行 ollama pull muse-glimmer",
  },
  deepseek: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", noThink: false },
  qwen: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", noThink: false },
  custom: { baseURL: "", model: "", noThink: false },
};
const IDEA_LABEL = { serve: "帮你做", ask: "了解你", world: "看世界" };

const EXAMPLES = [
  "把下载文件夹里的 PDF 收进一个新文件夹",
  "打开 news.ycombinator.com，挑 5 条翻成中文",
  "明天上午十点提醒我交周报",
];

function greeting(now = new Date()) {
  const hour = now.getHours();
  if (hour >= 5 && hour < 11) return "早上好";
  if (hour >= 11 && hour < 13) return "中午好";
  if (hour >= 13 && hour < 18) return "下午好";
  return "晚上好";
}

const ICONS = {
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6",
  x: "M18 6 6 18M6 6l12 12",
  check: "M5 12l5 5L19 7",
};

let state = null;
let view = sessionStorage.getItem("moqi.view") || "chat";
let sending = null; // { text, images } being sent, shown until moqi answers
let lastMessages = "";
let settingsLoaded = false;
let weather = null; // { latitude, longitude, place }
let hasKey = false;
let keyFor = ""; // the endpoint the saved key belongs to
let searchInfo = null; // what the settings said about web search when they were loaded
let searchTouched = false; // the user changed a search field since then
let toldAbout = ""; // the question id the user was already told about
let effort; // reasoning strength for background work, set by the preset or the saved config
let newsPresets = [];
// Lists are rebuilt only when what they show changed: polling must never replace a box the user is typing in.
let offersKey = "";
let thoughtsKey = "";
let memoryKey = "";
let todosKey = "";
let codeKey = "";
let historyKey = "";
let historyShown = 10;
const drafts = new Map(); // offer id -> what the user has typed so far
const MAX_IMAGES = 4;
const MAX_EDGE = 2048;
const MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const NO_VISION = "当前模型看不了图，可以换成 deepseek-flash 这类能看图的模型";
let attachments = []; // { preview, id?, error?, uploading }
let visionAsked = null; // the one check in flight
let checking = false; // while it runs, nothing is sent: the image would be left behind
const pictures = new Map(); // media id -> Promise of a blob: URL
let tested = null; // { baseURL, model, vision } of the last connection test

/* Small helpers */

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

async function api(method, path, body) {
  const headers = { "x-moqi-token": token };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) localStorage.removeItem("moqi.key");
  if (!res.ok) throw Object.assign(new Error(data.error || `出错了（HTTP ${res.status}）`), { status: res.status });
  return data;
}

let toastTimer = 0;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2800);
}

function banner(text) {
  $("banner").textContent = text || "";
  $("banner").hidden = !text;
}

function when(at) {
  const d = new Date(at);
  const diff = Date.now() - at;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `今天 ${hm}`;
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function setResult(el, text, kind) {
  el.textContent = text;
  el.className = `${el.className.replace(/\b(ok|bad)\b/g, "").trim()}${kind ? ` ${kind}` : ""}`;
}

/* Tabs */

const TABS = ["chat", "todo", "feed", "memory", "settings"];

function show(next, focus) {
  view = next;
  sessionStorage.setItem("moqi.view", next);
  for (const name of TABS) {
    const tab = $(`tab-${name}`);
    const on = name === next;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`view-${name}`).hidden = !on;
    if (on && focus) tab.focus();
  }
  if (next === "settings" && !settingsLoaded) loadSettings();
  if (next === "chat") {
    scrollToEnd();
    $("input").focus({ preventScroll: true });
  }
  render();
}

for (const name of TABS) {
  const tab = $(`tab-${name}`);
  tab.addEventListener("click", () => show(name));
  tab.addEventListener("keydown", (e) => {
    const i = TABS.indexOf(name);
    if (e.key === "ArrowRight") show(TABS[(i + 1) % TABS.length], true);
    else if (e.key === "ArrowLeft") show(TABS[(i + TABS.length - 1) % TABS.length], true);
    else return;
    e.preventDefault();
  });
}

/* State and rendering */

async function refresh() {
  try {
    state = await api("GET", "/api/state");
    banner("");
    render();
  } catch (error) {
    banner(
      error.status === 401
        ? "钥匙不对。请在终端运行 moqi，用它打开的链接进来一次。"
        : `连不上 moqi：${error.message}。它可能已经停了，在终端运行 moqi 重新打开。`,
    );
  }
}

function render() {
  if (!state) return;
  const count = state.offers.length;
  $("feed-count").hidden = count === 0;
  $("feed-count").textContent = String(count);
  const left = state.todos.today.length;
  $("todo-count").hidden = left === 0;
  $("todo-count").textContent = String(left);
  renderAsk();
  if (view === "chat") renderChat();
  if (view === "todo") renderTodos();
  if (view === "feed") renderFeed();
  if (view === "memory") renderMemory();
}

function scrollToEnd() {
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
}

/** An image from moqi, fetched with the key and shown through a blob: URL. */
function mediaUrl(id) {
  if (!pictures.has(id))
    pictures.set(
      id,
      fetch(`/api/media?id=${encodeURIComponent(id)}`, { headers: { "x-moqi-token": token } })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.blob();
        })
        .then((b) => URL.createObjectURL(b)),
    );
  return pictures.get(id);
}

function picture(id, alt) {
  const img = h("img", { alt });
  const button = h("button", { type: "button", class: "pic", "aria-label": `放大看：${alt}` }, img);
  button.addEventListener("click", () => openViewer(img.src, alt, button));
  mediaUrl(id)
    .then((url) => {
      img.src = url;
    })
    .catch(() => {
      button.classList.add("gone");
      img.alt = `${alt}（找不到了）`;
    });
  return button;
}

function openViewer(src, alt, from) {
  if (!src) return;
  $("viewer-img").src = src;
  $("viewer-img").alt = alt;
  $("viewer").addEventListener("close", () => from.focus(), { once: true });
  $("viewer").showModal();
}
$("viewer").addEventListener("click", (e) => {
  if (e.target === $("viewer")) $("viewer").close();
});

/** moqi's answer, from Markdown data to elements; text goes in as text and only http(s) links become links. */
function renderAnswer(text) {
  const parse = globalThis.moqiMarkdown?.parse;
  const blocks = parse ? parse(text) : [{ t: "p", c: [{ t: "text", v: text }] }];
  return h("div", { class: "md" }, blocks.map(blockEl));
}

function inlineEl(n) {
  if (n.t === "text") return n.v;
  if (n.t === "br") return h("br");
  if (n.t === "code") return h("code", { text: n.v });
  if (n.t === "b") return h("strong", {}, n.c.map(inlineEl));
  if (n.t === "i") return h("em", {}, n.c.map(inlineEl));
  if (n.t === "a" && /^https?:\/\//i.test(n.href))
    return h("a", { href: n.href, target: "_blank", rel: "noopener noreferrer" }, n.c.map(inlineEl));
  return n.c ? n.c.map(inlineEl) : "";
}

function blockEl(b) {
  if (b.t === "p") return h("p", {}, b.c.map(inlineEl));
  if (b.t === "h") return h(b.level === 1 ? "h3" : "h4", { class: "md-h" }, b.c.map(inlineEl));
  if (b.t === "hr") return h("hr");
  if (b.t === "quote") return h("blockquote", {}, b.blocks.map(blockEl));
  if (b.t === "code") {
    const copy = h("button", { type: "button", class: "copy", text: "复制" });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.text);
        toast("复制了");
      } catch {
        toast("复制不了，手动选中吧");
      }
    });
    return h(
      "div",
      { class: "codeblock" },
      h("div", { class: "code-head" }, h("span", { text: b.lang || "代码" }), copy),
      h("pre", {}, h("code", { text: b.text })),
    );
  }
  if (b.t === "ul" || b.t === "ol")
    return h(
      b.t,
      b.t === "ol" && b.start !== 1 ? { start: String(b.start) } : {},
      b.items.map((it) => h("li", {}, it.c.map(inlineEl), it.sub ? blockEl(it.sub) : null)),
    );
  if (b.t === "table")
    return h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        {},
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            b.head.map((c, i) => h("th", { class: `al-${b.align[i] || "left"}` }, c.map(inlineEl))),
          ),
        ),
        h(
          "tbody",
          {},
          b.rows.map((row) =>
            h(
              "tr",
              {},
              row.map((c, i) => h("td", { class: `al-${b.align[i] || "left"}` }, c.map(inlineEl))),
            ),
          ),
        ),
      ),
    );
  if (b.t === "cards")
    return h(
      "div",
      { class: "link-cards" },
      b.links
        .filter((l) => /^https?:\/\//i.test(l.href))
        .map((l) =>
          h(
            "a",
            { class: "link-card", href: l.href, target: "_blank", rel: "noopener noreferrer" },
            h("span", { class: "link-title", text: l.text }),
            h("span", { class: "link-host", text: l.host }),
          ),
        ),
    );
  return null;
}

function messageEl(m) {
  const user = m.role === "user";
  const ids = m.images || [];
  const pics = ids.length
    ? h(
        "div",
        { class: "pics" },
        ids.map((id, i) => picture(id, user ? `你发的图片 ${i + 1}` : `moqi 带回的图片 ${i + 1}`)),
      )
    : null;
  if (user) return h("div", { class: "msg user" }, pics, m.text ? h("div", { class: "msg-text", text: m.text }) : null);
  return h("div", { class: "msg moqi" }, renderAnswer(m.text), pics);
}

function renderChat() {
  const list = $("messages");
  const key = JSON.stringify([state.messages.length, state.messages.at(-1)?.at, sending, state.configured]);
  if (key === lastMessages) return;
  lastMessages = key;
  list.replaceChildren();
  if (!state.configured) {
    list.append(
      h(
        "div",
        { class: "empty" },
        h("strong", { text: "先给 moqi 接一个模型" }),
        "本机 Ollama 或云端模型都可以，一分钟就好。",
        h("br"),
        h("button", { type: "button", class: "btn primary", text: "去设置", onclick: () => show("settings") }),
      ),
    );
  } else if (state.messages.length === 0 && !sending) {
    list.append(
      h(
        "div",
        { class: "hello" },
        h("strong", { class: "hello-title", text: greeting() }),
        h("p", { text: "跟 moqi 说说你自己，或者让它替你做点事。" }),
        h(
          "div",
          { class: "examples" },
          EXAMPLES.map((text) =>
            h("button", {
              type: "button",
              class: "example",
              text,
              onclick: () => {
                input.value = text;
                autosize();
                input.focus();
              },
            }),
          ),
        ),
      ),
    );
  }
  for (const m of state.messages) list.append(messageEl(m));
  if (sending !== null) {
    const last = state.messages.at(-1);
    if (!(last && last.role === "user" && last.text === sending.text))
      list.append(messageEl({ role: "user", text: sending.text, images: sending.images }));
    list.append(h("div", { class: "msg moqi thinking", text: "moqi 在想" }));
  }
  $("input").disabled = !state.configured;
  renderAttach();
  scrollToEnd();
}

function renderAsk() {
  const q = state.question;
  $("ask").hidden = !q;
  if (!q) return;
  $("ask-text").textContent = q.text;
  $("ask-details").textContent = q.details || "";
  $("ask-details").hidden = !q.details;
  $("ask").dataset.id = q.id;
  $("ask-always").hidden = !q.always;
  $("ask-always").textContent = q.always || "";
  if (view !== "chat" && toldAbout !== q.id) {
    toldAbout = q.id;
    toast("moqi 有件事想问你，在「对话」里");
  }
}

async function answer(yes, always = false) {
  const id = $("ask").dataset.id;
  $("ask").hidden = true;
  try {
    await api("POST", "/api/confirm", { id, yes, always });
  } catch (error) {
    toast(error.message);
  }
  refresh();
}
$("ask-yes").addEventListener("click", () => answer(true));
$("ask-always").addEventListener("click", () => answer(true, true));
$("ask-no").addEventListener("click", () => answer(false));

function renderCode() {
  const list = $("code-running");
  const running = (state.code || []).filter((t) => t.status === "running");
  const key = JSON.stringify(running);
  if (key === codeKey) return refreshTimes(list);
  codeKey = key;
  list.replaceChildren();
  for (const t of running) {
    const stop = async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      try {
        await api("POST", "/api/code/stop", { id: t.id });
        toast("让它停下了，已经做的改动会留在分支上");
      } catch (error) {
        toast(error.message);
      }
      refresh();
    };
    list.append(
      h(
        "div",
        { class: "item" },
        h(
          "div",
          { class: "item-main" },
          h(
            "p",
            { class: "item-text" },
            h("span", { class: "tag", text: "进行中" }),
            `${t.agent} · ${t.project}：${t.task}`,
          ),
          h("p", { class: "item-meta" }, "开始于", timeOf(t.startedAt)),
        ),
        h("button", { type: "button", class: "btn", text: "停下", onclick: stop }),
      ),
    );
  }
}

function renderFeed() {
  renderCode();
  const list = $("offers");
  const key = JSON.stringify(state.offers);
  if (key !== offersKey) {
    offersKey = key;
    // Keep the answer the user is typing, and the cursor in it, across a rebuild.
    const active = document.activeElement;
    const typing = active?.dataset?.offer;
    const selection = typing ? [active.selectionStart, active.selectionEnd] : null;
    list.replaceChildren();
    if (state.offers.length === 0) {
      list.append(h("p", { class: "none", text: "现在没有需要你的事。moqi 有话想说时，会先放在这里。" }));
    }
    for (const o of state.offers) {
      const card = offerCard(o);
      card.id = `offer-${o.id}`;
      list.append(card);
    }
    for (const id of drafts.keys()) if (!state.offers.some((o) => o.id === id)) drafts.delete(id);
    const box = typing && list.querySelector(`textarea[data-offer="${CSS.escape(typing)}"]`);
    if (box) {
      box.focus({ preventScroll: true });
      box.setSelectionRange(selection[0], selection[1]);
    }
  }
  refreshTimes(list);
  renderHistory();
  renderThoughts();
}

function timeOf(at) {
  return h("span", { "data-at": String(at), text: when(at) });
}

/** Relative times ("3 分钟前") move on without rebuilding anything. */
function refreshTimes(root) {
  for (const el of root.querySelectorAll("[data-at]")) el.textContent = when(Number(el.dataset.at));
}

const hostOf = (url) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** Shows or hides a coding task's changes under its card. */
function diffToggle(taskId, changes) {
  return async (e) => {
    const button = e.currentTarget;
    if (!changes.hidden) {
      changes.hidden = true;
      button.textContent = "看改动";
      return;
    }
    button.disabled = true;
    try {
      const { diff } = await api("GET", `/api/code/diff?id=${encodeURIComponent(taskId)}`);
      changes.textContent = diff || "（没有改动）";
      changes.hidden = false;
      button.textContent = "收起改动";
    } catch (error) {
      toast(error.message);
    }
    button.disabled = false;
  };
}

function seenCard(o) {
  const links = o.links.filter((l) => /^https?:\/\//i.test(l.url));
  const changes = h("pre", { class: "ask-details", hidden: true });
  const good = /^(已合并|好|有用|完成了|回答了)/.test(o.outcome);
  return h(
    "article",
    { class: "card seen", id: `offer-${o.id}` },
    h(
      "div",
      { class: "card-head" },
      h("h3", { class: "card-title", text: o.title }),
      h("span", { class: "card-time", "data-at": String(o.at), text: when(o.at) }),
    ),
    o.body ? h("p", { class: "card-body", text: o.body }) : null,
    links.length
      ? h(
          "div",
          { class: "link-cards" },
          links.map((l) =>
            h(
              "a",
              { class: "link-card", href: l.url, target: "_blank", rel: "noopener noreferrer" },
              h("span", { class: "link-title", text: l.title }),
              h("span", { class: "link-host", text: hostOf(l.url) }),
            ),
          ),
        )
      : null,
    changes,
    h(
      "div",
      { class: "actions" },
      h(
        "span",
        { class: `outcome${good ? " good" : ""}` },
        good ? icon("check") : null,
        `${o.outcome} · `,
        timeOf(o.decidedAt),
      ),
      h("span", { class: "spacer" }),
      o.canDiff
        ? h("button", { type: "button", class: "btn", text: "看改动", onclick: diffToggle(o.taskId, changes) })
        : null,
    ),
  );
}

function renderHistory() {
  const items = state.history || [];
  $("history-head").hidden = items.length === 0;
  $("history-count").textContent = `最近 30 天 · ${items.length} 条`;
  const key = JSON.stringify([items, historyShown]);
  if (key !== historyKey) {
    historyKey = key;
    $("history").replaceChildren(...items.slice(0, historyShown).map(seenCard));
  }
  $("history-more").hidden = items.length <= historyShown;
  refreshTimes($("history"));
}
$("history-more").addEventListener("click", () => {
  historyShown += 20;
  renderHistory();
});

/** Scrolls to the card an idea became, opening more of "看过的" when it is further down. */
function jumpTo(offerId) {
  const index = (state.history || []).findIndex((o) => o.id === offerId);
  if (index >= historyShown) {
    historyShown = index + 1;
    renderHistory();
  }
  const card = document.getElementById(`offer-${offerId}`);
  if (!card) return;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 2000);
}

function offerCard(o) {
  const respond = (verdict) => async (e) => {
    e.currentTarget.disabled = true;
    try {
      const r = await api("POST", "/api/offer", { id: o.id, verdict });
      toast(r.message);
    } catch (error) {
      toast(error.message);
    }
    refresh();
  };
  const links = o.links.filter((l) => /^https?:\/\//i.test(l.url));
  const head = h(
    "div",
    { class: "card-head" },
    h("h3", { class: "card-title", text: o.title }),
    h("span", { class: "card-time", "data-at": String(o.at), text: when(o.at) }),
  );
  const body = o.body ? h("p", { class: "card-body", text: o.body }) : null;
  const linkList = links.length
    ? h(
        "ul",
        { class: "links" },
        links.map((l) =>
          h("li", {}, h("a", { href: l.url, target: "_blank", rel: "noopener noreferrer", text: l.title })),
        ),
      )
    : null;
  if (o.kind === "code.done") {
    const task = (state.code || []).find((t) => t.id === o.taskId);
    const changes = h("pre", { class: "ask-details", hidden: true });
    const changed = !!task && task.files > 0;
    const open = !!task && (task.status === "done" || task.status === "failed");
    return h(
      "article",
      { class: "card" },
      head,
      body,
      changes,
      h(
        "div",
        { class: "actions" },
        changed && open
          ? h("button", {
              type: "button",
              class: "btn primary",
              text: task.into ? `合并到 ${task.into}` : "合并",
              onclick: respond("accepted"),
            })
          : null,
        changed
          ? h("button", { type: "button", class: "btn", text: "看改动", onclick: diffToggle(o.taskId, changes) })
          : null,
        h("span", { class: "spacer" }),
        open
          ? removeButton("丢弃这个任务的分支", "确定丢弃", () => api("POST", "/api/code/discard", { id: o.taskId }))
          : null,
      ),
    );
  }
  if (o.answer) {
    const box = h("textarea", {
      class: "answer",
      rows: "2",
      placeholder: "随便说说，几个字也行",
      "aria-label": "回答这个问题",
      "data-offer": o.id,
    });
    box.value = drafts.get(o.id) ?? "";
    box.addEventListener("input", () => drafts.set(o.id, box.value));
    const send = async (e) => {
      const text = box.value.trim();
      if (!text) return box.focus();
      e.currentTarget.disabled = true;
      try {
        const r = await api("POST", "/api/answer", { id: o.id, text });
        drafts.delete(o.id);
        toast(r.message);
      } catch (error) {
        toast(error.message);
      }
      refresh();
    };
    return h(
      "article",
      { class: "card question" },
      head,
      body,
      box,
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", class: "btn primary", text: "回答", onclick: send }),
        h("button", { type: "button", class: "btn", text: "不想说", onclick: respond("dismissed") }),
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn ghost", text: "别再问这类", onclick: respond("muted") }),
      ),
    );
  }
  const remind = o.kind === "todo.remind";
  return h(
    "article",
    { class: "card" },
    head,
    body,
    linkList,
    h(
      "div",
      { class: "actions" },
      h("button", {
        type: "button",
        class: "btn primary",
        text: remind ? "完成" : o.action ? "好" : "有用",
        onclick: respond("accepted"),
      }),
      h("button", {
        type: "button",
        class: "btn",
        text: remind ? "还没做" : o.action ? "不用" : "不需要",
        onclick: respond("dismissed"),
      }),
      o.kind === "todo.review"
        ? h("button", { type: "button", class: "btn", text: "打开待办", onclick: () => show("todo") })
        : null,
      h("span", { class: "spacer" }),
      // One stray tap must never silence every reminder the user set.
      remind
        ? null
        : h("button", { type: "button", class: "btn ghost", text: "不再提这类", onclick: respond("muted") }),
    ),
  );
}

function renderThoughts() {
  const status = $("think-status");
  const last = state.thoughts[0];
  $("think").disabled = state.thinking || !state.configured;
  $("think").textContent = state.thinking ? "正在想…" : "现在想一想";
  if (!state.configured) status.textContent = "接上模型后，moqi 每两小时、以及每次聊完都会自己想一想。";
  else if (state.thinking) status.textContent = "moqi 正在想你可能需要什么。";
  else if (last) status.textContent = `上次是${when(last.at)}。每两小时、以及每次聊完，它都会自己想一想。`;
  else status.textContent = "还没想过。每两小时、以及每次聊完，它都会自己想一想。";
  const list = $("thoughts");
  const key = JSON.stringify([state.thoughts, state.offers.map((o) => o.id), (state.history || []).map((o) => o.id)]);
  if (key === thoughtsKey) return refreshTimes(list);
  thoughtsKey = key;
  list.replaceChildren();
  for (const t of state.thoughts) {
    if (t.error) {
      list.append(
        h(
          "div",
          { class: "thought" },
          h("p", { class: "item-text", text: "这次没想成" }),
          h("p", { class: "item-meta" }, timeOf(t.at), ` · ${t.error}`),
        ),
      );
      continue;
    }
    if (t.ideas.length === 0) {
      list.append(
        h(
          "div",
          { class: "thought" },
          h("p", { class: "item-text", text: "想了想，这次没什么要说的" }),
          h("p", { class: "item-meta" }, timeOf(t.at)),
        ),
      );
    }
    for (const idea of t.ideas) {
      const known =
        idea.offerId &&
        (state.offers.some((o) => o.id === idea.offerId) || (state.history || []).some((o) => o.id === idea.offerId));
      const title = known
        ? h("button", { type: "button", class: "linkish", text: idea.title, onclick: () => jumpTo(idea.offerId) })
        : idea.title;
      list.append(
        h(
          "div",
          { class: "thought" },
          h("p", { class: "item-text" }, h("span", { class: "tag", text: IDEA_LABEL[idea.type] || idea.type }), title),
          h("p", { class: "item-meta" }, timeOf(t.at), ` · ${idea.outcome}`),
        ),
      );
    }
  }
}

$("think").addEventListener("click", async () => {
  $("think").disabled = true;
  $("think").textContent = "正在想…";
  try {
    const r = await api("POST", "/api/reflect", {});
    toast(r.ideas ? `想到了 ${r.ideas} 件事` : "想了想，这次没什么要说的");
  } catch (error) {
    toast(error.message);
  }
  refresh();
});

/* Todos */

function dayOf(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hm(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dayLabel(day) {
  const today = dayOf(Date.now());
  if (day === today) return "今天";
  if (day === dayOf(Date.now() + 86_400_000)) return "明天";
  const [, m, d] = day.split("-");
  return `${Number(m)}月${Number(d)}日`;
}

function renderTodos() {
  const key = JSON.stringify(state.todos);
  if (key === todosKey) return; // keeps a half-done two-step delete as it is
  todosKey = key;
  fillTodos($("todo-today"), state.todos.today, "今天没有要做的事。");
  fillTodos($("todo-later"), state.todos.later, "以后的事也可以先记下来。");
  fillTodos($("todo-done"), state.todos.done, "这 7 天还没勾掉过什么。");
}

function fillTodos(list, todos, empty) {
  list.replaceChildren();
  if (todos.length === 0) list.append(h("p", { class: "none", text: empty }));
  for (const t of todos) list.append(todoItem(t));
}

function todoItem(t) {
  const done = t.doneAt !== null;
  const box = h("input", { type: "checkbox", class: "todo-check" });
  box.checked = done;
  box.addEventListener("change", async () => {
    box.disabled = true;
    try {
      const r = await api("POST", done ? "/api/todo/undone" : "/api/todo/done", { id: t.id });
      toast(r.message);
    } catch (error) {
      toast(error.message);
      // Nothing changed, so the list is not rebuilt: put the box back as it was.
      box.checked = done;
      box.disabled = false;
    }
    refresh();
  });
  const meta = [];
  if (done) meta.push(`完成于${when(t.doneAt)}`);
  else {
    const today = dayOf(Date.now());
    if (t.day > today) meta.push(dayLabel(t.day));
    if (t.remindAt !== null && dayOf(t.remindAt) >= today) meta.push(`${hm(t.remindAt)} 提醒`);
    if (t.late > 0) meta.push(`已拖 ${t.late} 天`);
  }
  if (t.by) meta.push(t.by === "moqi" ? "moqi 听出来的" : `${t.by} 加的`);
  return h(
    "div",
    { class: `item todo${done ? " done" : ""}${t.late > 0 ? " late" : ""}` },
    h(
      "label",
      { class: "item-main todo-label" },
      box,
      h(
        "span",
        { class: "todo-words" },
        h("span", { class: "item-text", text: t.text }),
        meta.length ? h("span", { class: "item-meta", text: meta.join(" · ") }) : null,
      ),
    ),
    removeButton("删除这件待办", "确定删除", () => api("POST", "/api/todo/remove", { id: t.id })),
  );
}

$("todo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("todo-text").value.trim();
  if (!text) return $("todo-text").focus();
  const body = { text };
  if ($("todo-day").value) body.day = $("todo-day").value;
  if ($("todo-at").value) body.at = $("todo-at").value;
  $("todo-add").disabled = true;
  try {
    const r = await api("POST", "/api/todo/add", body);
    toast(r.message);
    $("todo-text").value = "";
    $("todo-day").value = "";
    $("todo-at").value = "";
  } catch (error) {
    toast(error.message);
  }
  $("todo-add").disabled = false;
  $("todo-text").focus();
  refresh();
});

function renderMemory() {
  renderStudyStatus();
  const key = JSON.stringify([state.facts, state.watches, state.lessons, state.notes]);
  if (key === memoryKey) return; // keeps a half-done two-step delete as it is
  memoryKey = key;
  const facts = $("facts");
  facts.replaceChildren();
  if (state.facts.length === 0) facts.append(h("p", { class: "none", text: "还不了解你。多聊几句，它会记下来。" }));
  for (const f of state.facts) {
    facts.append(
      h(
        "div",
        { class: `item${f.faded ? " faded" : ""}` },
        h(
          "div",
          { class: "item-main" },
          h("p", { class: "item-text", text: f.content }),
          h(
            "p",
            { class: "item-meta" },
            f.term === "long" ? h("span", { class: "tag", text: "长期" }) : `印证 ${f.confirmations}/3`,
            f.faded ? (f.term === "long" ? "已淡出" : " · 已淡出") : null,
            f.by ? ` · 来自 ${f.by}` : null,
          ),
        ),
        removeButton("删除这条记忆", "确定删除", () => api("POST", "/api/forget", { id: f.id })),
      ),
    );
  }
  const learned = $("learned");
  learned.replaceChildren();
  if (state.lessons.length + state.notes.length === 0) {
    learned.append(
      h("p", { class: "none", text: "还没学到什么。你不在的时候，它会复盘自己做得怎么样，也会读和你有关的文章。" }),
    );
  }
  for (const l of state.lessons) {
    learned.append(
      h(
        "div",
        { class: "item" },
        h(
          "div",
          { class: "item-main" },
          h("p", { class: "item-text" }, h("span", { class: "tag", text: "经验" }), l.content),
          h("p", { class: "item-meta" }, "从你的反应里总结 · ", timeOf(l.at)),
        ),
        removeButton("删除这条经验", "确定删除", () => api("POST", "/api/learned/remove", { id: l.id })),
      ),
    );
  }
  for (const n of state.notes) {
    const source =
      n.source && /^https?:\/\//i.test(n.source.url)
        ? h("a", { href: n.source.url, target: "_blank", rel: "noopener noreferrer", text: n.source.title })
        : null;
    learned.append(
      h(
        "div",
        { class: "item" },
        h(
          "div",
          { class: "item-main" },
          h("p", { class: "item-text" }, h("span", { class: "tag", text: "笔记" }), n.content),
          h("p", { class: "item-meta" }, `${n.topic} · `, source ?? "", source ? " · " : "", timeOf(n.at)),
        ),
        removeButton("删除这条笔记", "确定删除", () => api("POST", "/api/learned/remove", { id: n.id })),
      ),
    );
  }
  refreshTimes(learned);
  const watches = $("watches");
  watches.replaceChildren();
  if (state.watches.length === 0)
    watches.append(h("p", { class: "none", text: "没有托管的事。对 moqi 说「每天早上告诉我天气」试试。" }));
  for (const w of state.watches) {
    watches.append(
      h(
        "div",
        { class: "item" },
        h(
          "div",
          { class: "item-main" },
          h("p", { class: "item-text", text: w.title }),
          h("p", { class: "item-meta", text: w.last ? `${w.schedule} · 上次：${w.last}` : w.schedule }),
        ),
        removeButton("取消这件事", "确定取消", () => api("POST", "/api/watch/cancel", { id: w.id }), "x"),
      ),
    );
  }
}

function renderStudyStatus() {
  const s = state.lastStudy;
  $("study").disabled = state.studying || !state.configured;
  $("study").textContent = state.studying ? "正在学…" : "现在学一学";
  let text = "你不在的时候，它一天会学几次：复盘自己做得怎么样，或者读和你有关的文章。";
  if (!state.configured) text = "接上模型后，你不在的时候它会自己学。";
  else if (state.studying) text = "moqi 正在学。";
  else if (s) {
    const what = s.mode === "lessons" ? "复盘了自己做得怎么样" : `学了「${s.topic || "新闻"}」`;
    const result = s.error ? `没学成：${s.error}` : s.skipped ? s.skipped : `记下 ${s.learned} 条`;
    text = `上次${when(s.at)}${s.mode === "world" && !s.topic ? "想学点东西" : what}，${result}。`;
  }
  $("study-status").textContent = text;
}

$("study").addEventListener("click", async () => {
  $("study").disabled = true;
  $("study").textContent = "正在学…";
  try {
    const r = await api("POST", "/api/study", {});
    toast(r.learned ? `学到了 ${r.learned} 条` : "这次没学到新东西");
  } catch (error) {
    toast(error.message);
  }
  refresh();
});

/** Two steps, so one stray click never deletes anything. */
function removeButton(label, confirmText, run, iconName = "trash") {
  const wrap = h("div", {});
  const first = h("button", { type: "button", class: "icon-btn", "aria-label": label, title: label }, icon(iconName));
  first.addEventListener("click", () => {
    const sure = h("button", { type: "button", class: "btn danger", text: confirmText });
    sure.addEventListener("click", async () => {
      sure.disabled = true;
      try {
        const r = await run();
        toast(r.message);
      } catch (error) {
        toast(error.message);
      }
      refresh();
    });
    wrap.replaceChildren(sure);
    sure.focus();
    setTimeout(() => {
      if (wrap.contains(sure) && !sure.disabled) wrap.replaceChildren(first);
    }, 4000);
  });
  wrap.append(first);
  return wrap;
}

/* Chat */

const input = $("input");

function autosize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  const ready = attachments.filter((a) => a.id);
  if (sending !== null || checking || attachments.some((a) => a.uploading) || (!text && ready.length === 0)) return;
  sending = { text, images: ready.map((a) => a.id) };
  const sent = attachments;
  attachments = [];
  input.value = "";
  autosize();
  render();
  try {
    await api("POST", "/api/chat", { text, ...(sending.images.length > 0 && { images: sending.images }) });
    for (const a of sent) URL.revokeObjectURL(a.preview);
  } catch (error) {
    toast(error.message);
    if (!input.value) input.value = text;
    attachments = sent; // kept, to send again
  }
  sending = null;
  await refresh();
});

async function shrink(file) {
  if (file.type === "image/gif") {
    if (file.size > MAX_BYTES) throw new Error("GIF 太大了，最多 2 MB");
    return file;
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_BYTES) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("这张图处理不了");
  return blob;
}

async function upload(blob) {
  const res = await fetch("/api/media", {
    method: "POST",
    headers: { "x-moqi-token": token, "content-type": blob.type || "application/octet-stream" },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `上传失败（HTTP ${res.status}）`);
  return data.id;
}

/** Whether the model can see images; asks it once when nobody knows yet. */
async function canSee() {
  if (typeof state?.vision === "boolean") return state.vision;
  $("attach-status").textContent = "正在确认模型能不能看图…";
  checking = true;
  renderAttach();
  visionAsked ??= api("POST", "/api/model/vision", {})
    .then((r) => r.vision)
    .finally(() => {
      visionAsked = null;
    });
  try {
    state.vision = await visionAsked;
    return state.vision;
  } finally {
    $("attach-status").textContent = "";
    checking = false;
    renderAttach();
  }
}

async function addImages(files) {
  const images = [...files].filter((f) => IMAGE_TYPES.includes(f.type));
  if (images.length === 0) return;
  if (!state?.configured) return toast("先给 moqi 接一个模型");
  let ok = false;
  try {
    ok = await canSee();
  } catch (error) {
    return toast(error.message);
  }
  renderAttach();
  if (!ok) return toast(NO_VISION);
  for (const file of images) {
    if (attachments.length >= MAX_IMAGES) {
      toast(`一条消息最多 ${MAX_IMAGES} 张图片`);
      break;
    }
    const a = { preview: URL.createObjectURL(file), uploading: true };
    attachments.push(a);
    renderAttach();
    try {
      a.id = await upload(await shrink(file));
    } catch (error) {
      a.error = error.message;
      toast(`有一张图片没传上：${error.message}`);
    }
    a.uploading = false;
    renderAttach();
  }
}

function renderAttach() {
  const strip = $("attachments");
  strip.replaceChildren();
  strip.hidden = attachments.length === 0;
  for (const a of attachments) {
    const remove = h("button", { type: "button", class: "thumb-remove", "aria-label": "移除这张图片" }, icon("x"));
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(a.preview);
      attachments = attachments.filter((x) => x !== a);
      renderAttach();
    });
    const cls = `thumb${a.error ? " bad" : ""}${a.uploading ? " busy" : ""}`;
    strip.append(
      h(
        "div",
        { class: cls, title: a.error || "" },
        h("img", { src: a.preview, alt: a.error ? `没传上的图片：${a.error}` : "要发的图片" }),
        remove,
      ),
    );
  }
  const blocked = state?.vision === false;
  $("attach").setAttribute("aria-disabled", String(blocked || !state?.configured));
  $("attach").title = blocked ? NO_VISION : "添加图片";
  $("send").disabled = !state?.configured || sending !== null || checking || attachments.some((a) => a.uploading);
}

$("attach").addEventListener("click", () => {
  if (!state?.configured) return toast("先给 moqi 接一个模型");
  if (state.vision === false) return toast(NO_VISION);
  $("file").click();
});
$("file").addEventListener("change", () => {
  addImages($("file").files);
  $("file").value = "";
});
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.some((f) => f.type.startsWith("image/"))) return;
  e.preventDefault();
  addImages(files);
});
$("view-chat").addEventListener("dragover", (e) => {
  if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file")) e.preventDefault();
});
$("view-chat").addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  addImages(e.dataTransfer.files);
});

/* Settings */

function choosePreset(name) {
  for (const r of document.querySelectorAll('input[name="preset"]')) r.checked = r.value === name;
  const p = PRESETS[name];
  if (name !== "custom") {
    $("m-base").value = p.baseURL;
    $("m-model").value = p.model;
  }
  $("m-nothink").checked = p.noThink;
  if (name !== "custom") effort = p.effort;
  $("m-preset-hint").textContent = p.hint || "";
  $("m-preset-hint").hidden = !p.hint;
  keyHint(name);
}

function presetOf(model) {
  if (model.baseURL === OLLAMA) return model.model.startsWith("muse-glimmer") ? "glimmer" : "ollama";
  for (const [name, p] of Object.entries(PRESETS)) if (p.baseURL && p.baseURL === model.baseURL) return name;
  return "custom";
}

function keyHint(name) {
  const local = !!PRESETS[name]?.local;
  const kept = hasKey && $("m-base").value.trim().replace(/\/+$/, "") === keyFor;
  $("m-key").placeholder = kept ? "已保存，留空就不改" : local ? "不用填" : "sk-…";
  $("m-key-hint").textContent = local ? "本机模型不用填" : "只存在这台电脑上，不会显示在页面里";
}

for (const r of document.querySelectorAll('input[name="preset"]'))
  r.addEventListener("change", () => choosePreset(r.value));

$("m-base").addEventListener("input", () =>
  keyHint(document.querySelector('input[name="preset"]:checked')?.value || "custom"),
);

function toggle(id, bodyId) {
  const on = $(id).checked;
  $(bodyId).classList.toggle("off", !on);
  for (const el of $(bodyId).querySelectorAll("input, button")) el.disabled = !on;
}
$("w-on").addEventListener("change", () => toggle("w-on", "w-body"));
$("c-on").addEventListener("change", () => toggle("c-on", "c-body"));
$("n-on").addEventListener("change", () => toggle("n-on", "n-body"));
$("f-on").addEventListener("change", () => {
  toggle("f-on", "f-body");
  $("f-folders").disabled = !$("f-on").checked;
});
$("mac-on").addEventListener("change", () => toggle("mac-on", "mac-body"));

function searchInput() {
  return {
    enabled: $("s-on").checked,
    provider: $("s-provider").value,
    apiKey: $("s-key").value.trim() || undefined,
  };
}

function searchHint() {
  const provider = $("s-provider").value;
  const kept = !!searchInfo && searchInfo.hasKey && searchInfo.provider === provider;
  $("s-key").placeholder = kept ? "已保存，留空就不改" : "";
  $("s-key-hint").textContent = provider === "baidu" ? "填 AppBuilder API Key" : "留空就用模型的 key";
}

function toggleSearch() {
  toggle("s-on", "s-body");
  $("s-provider").disabled = !$("s-on").checked;
}

$("s-on").addEventListener("change", () => {
  searchTouched = true;
  toggleSearch();
});
$("s-provider").addEventListener("change", () => {
  searchTouched = true;
  searchHint();
  setResult($("s-test-result"), "");
});
$("s-key").addEventListener("input", () => {
  searchTouched = true;
});

$("s-test").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  const out = $("s-test-result");
  button.disabled = true;
  setResult(out, "正在搜「今天的新闻」…");
  try {
    const r = await api("POST", "/api/search/test", { search: searchInput() });
    if (r.ok) setResult(out, r.title ? `能用，搜到：${r.title}` : "能用，这次没有搜到结果", "ok");
    else setResult(out, `不能用：${r.error}`, "bad");
  } catch (error) {
    setResult(out, error.message, "bad");
  }
  button.disabled = false;
});
$("p-browser").addEventListener("click", async () => {
  const on = !$("p-browser").dataset.on;
  $("p-browser").disabled = true;
  try {
    await api("POST", "/api/preset", { name: "browser", on });
    toast(on ? "加上了浏览器，正在启动" : "移除了浏览器");
  } catch (error) {
    toast(error.message);
  }
  $("p-browser").disabled = false;
  await loadInterop();
});

async function loadCodeAgents() {
  let found = { kiro: false, claude: false };
  try {
    found = await api("GET", "/api/code/agents");
  } catch {
    // shown as none found
  }
  const names = [found.kiro ? "Kiro" : "", found.claude ? "Claude Code" : ""].filter(Boolean);
  $("code-agents").textContent = names.length
    ? `找到了：${names.join("、")}。Cursor 暂不支持：要先登录，并实测它的权限限制能生效。`
    : "这台电脑上没找到 Kiro 或 Claude Code。";
}

function projectRow(p) {
  const path = h("input", {
    type: "text",
    class: "code-path",
    spellcheck: "false",
    placeholder: "~/code/项目",
    "aria-label": "项目路径",
  });
  path.value = p.path || "";
  const agent = h(
    "select",
    { class: "policy code-agent", "aria-label": "交给谁" },
    h("option", { value: "kiro", text: "Kiro" }),
    h("option", { value: "claude", text: "Claude Code" }),
  );
  agent.value = p.agent || "kiro";
  const commands = h("textarea", {
    class: "code-commands",
    rows: "2",
    spellcheck: "false",
    placeholder: "pnpm test",
    "aria-label": "允许跑的命令",
  });
  commands.value = (p.commands || []).join("\n");
  const network = h("input", { type: "checkbox", class: "code-network" });
  network.checked = !!p.network;
  const row = h(
    "div",
    { class: "item code-project" },
    h(
      "div",
      { class: "item-main" },
      path,
      h("p", { class: "hint", text: "允许跑的命令，一行一条；其他命令一律拒绝：" }),
      commands,
      h("label", { class: "check" }, network, "允许命令联网（比如要装依赖）"),
    ),
    h(
      "div",
      { class: "code-side" },
      agent,
      h(
        "button",
        {
          type: "button",
          class: "icon-btn",
          "aria-label": "删除这个项目",
          title: "删除这个项目",
          onclick: () => row.remove(),
        },
        icon("trash"),
      ),
    ),
  );
  return row;
}

$("code-add").addEventListener("click", () => $("code-projects").append(projectRow({ commands: ["pnpm test"] })));

function projectsInput() {
  return [...document.querySelectorAll(".code-project")]
    .map((row) => ({
      path: row.querySelector(".code-path").value.trim(),
      agent: row.querySelector(".code-agent").value,
      commands: row
        .querySelector(".code-commands")
        .value.split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      network: row.querySelector(".code-network").checked,
    }))
    .filter((p) => p.path);
}

async function loadShortcuts(chosen) {
  const box = $("mac-shortcuts");
  box.replaceChildren();
  let data;
  try {
    data = await api("GET", "/api/shortcuts");
  } catch (error) {
    box.append(h("p", { class: "hint", text: error.message }));
    return;
  }
  if (!data.available) return box.append(h("p", { class: "hint", text: "没找到快捷指令，需要 macOS 12 以上。" }));
  if (data.shortcuts.length === 0)
    return box.append(h("p", { class: "hint", text: "你还没有快捷指令。在「快捷指令」App 里做好后，这里就能勾选。" }));
  const picked = new Set(chosen);
  for (const name of data.shortcuts) {
    const check = h("input", { type: "checkbox", value: name });
    check.checked = picked.has(name);
    box.append(h("label", { class: "check" }, check, name));
  }
}
$("b-on").addEventListener("change", () => {
  $("b-at").disabled = !$("b-on").checked;
});
$("r-on").addEventListener("change", () => {
  $("r-at").disabled = !$("r-on").checked;
});

function showWeather() {
  $("w-chosen").textContent = weather
    ? `已选：${weather.place}（${weather.latitude.toFixed(2)}, ${weather.longitude.toFixed(2)}）`
    : "还没选城市";
}

async function loadSettings() {
  try {
    const { config, hasKey: saved, env, newsPresets: feeds, platform, search } = await api("GET", "/api/config");
    newsPresets = feeds;
    settingsLoaded = true;
    hasKey = saved;
    keyFor = config.model ? config.model.baseURL.replace(/\/+$/, "") : "";
    const model = config.model;
    const preset = model ? presetOf(model) : "ollama";
    choosePreset(preset);
    if (model) {
      $("m-base").value = model.baseURL;
      $("m-model").value = model.model;
      $("m-nothink").checked = !!model.noThink;
      effort = model.effort;
    }
    keyHint(preset);
    const notes = [];
    if (env.model) notes.push("现在实际用的是环境变量 MOQI_BASE_URL 和 MOQI_MODEL 指定的模型，它优先于这里的设置。");
    if (env.apiKey) notes.push("API Key 来自环境变量 MOQI_API_KEY。");
    if (env.searchKey) notes.push("联网搜索的 key 来自环境变量 MOQI_SEARCH_API_KEY。");
    $("env-note").textContent = notes.join(" ");
    $("env-note").hidden = notes.length === 0;
    $("persona").value = config.persona || "";
    weather = config.weather || null;
    $("w-on").checked = !!config.weather;
    $("w-q").value = config.weather ? config.weather.place : "";
    showWeather();
    toggle("w-on", "w-body");
    $("c-on").checked = !!config.calendar;
    $("c-path").value = config.calendar ? config.calendar.ics : "";
    toggle("c-on", "c-body");
    $("b-on").checked = config.briefingAt !== null;
    $("b-at").value = config.briefingAt || "08:00";
    $("b-at").disabled = config.briefingAt === null;
    $("r-on").checked = config.todoReviewAt !== null;
    $("r-at").value = config.todoReviewAt || "21:00";
    $("r-at").disabled = config.todoReviewAt === null;
    $("q-from").value = config.quiet.from;
    $("q-to").value = config.quiet.to;
    $("budget").value = String(config.dailyBudget);
    showNews(config.news ? config.news.feeds : null);
    searchInfo = search;
    searchTouched = false;
    $("s-on").checked = search.enabled;
    $("s-provider").value = search.provider;
    $("s-key").value = "";
    searchHint();
    toggleSearch();
    if (search.enabled && search.problem) setResult($("s-test-result"), search.problem, "bad");
    else setResult($("s-test-result"), "");
    $("f-on").checked = !!config.files;
    $("f-folders").value = (config.files ? config.files.folders : ["~/Downloads", "~/Desktop"]).join("\n");
    toggle("f-on", "f-body");
    $("f-folders").disabled = !config.files;
    $("m-field").hidden = platform !== "darwin";
    $("mac-on").checked = !!config.mac;
    if (platform === "darwin") await loadShortcuts(config.mac ? config.mac.shortcuts : []);
    toggle("mac-on", "mac-body");
    $("code-projects").replaceChildren(...(config.code ? config.code.projects : []).map(projectRow));
    $("code-timeout").value = String(config.code ? config.code.timeoutMinutes : 30);
    await loadCodeAgents();
    await loadAgents();
    await loadInterop();
    await loadDangerTools();
  } catch (error) {
    toast(error.message);
  }
}

$("m-test").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  const out = $("m-test-result");
  button.disabled = true;
  setResult(out, "正在连接…");
  try {
    const r = await api("POST", "/api/model/test", { model: modelInput() });
    const secs = (r.ms / 1000).toFixed(1);
    if (r.ok) {
      const m = modelInput();
      tested = typeof r.vision === "boolean" ? { baseURL: m.baseURL, model: m.model, vision: r.vision } : null;
      const sees = r.vision === true ? "，能看图" : r.vision === false ? "，看不了图" : "，没测出能不能看图";
      setResult(out, r.reply ? `连上了（${secs} 秒${sees}）：${r.reply}` : `连上了（${secs} 秒${sees}）`, "ok");
    } else setResult(out, `连不上：${r.error}`, "bad");
  } catch (error) {
    setResult(out, error.message, "bad");
  }
  button.disabled = false;
});

function modelInput() {
  return {
    baseURL: $("m-base").value.trim(),
    model: $("m-model").value.trim(),
    apiKey: $("m-key").value.trim() || undefined,
    noThink: $("m-nothink").checked || undefined,
    effort: effort || undefined,
  };
}

const STATE_WORDS = { starting: "启动中", ready: "可用", failed: "出错了", stopped: "没在运行" };
let interopTimer = 0;

function row(title, meta, button, tag) {
  return h(
    "div",
    { class: "item" },
    h(
      "div",
      { class: "item-main" },
      h("p", { class: "item-text" }, tag ? h("span", { class: "tag", text: tag }) : null, title),
      h("p", { class: "item-meta", text: meta }),
    ),
    button,
  );
}

function actionButton(text, primary, run) {
  const b = h("button", { type: "button", class: primary ? "btn primary" : "btn", text });
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      const message = await run();
      if (message) toast(message);
    } catch (error) {
      toast(error.message);
    }
    loadInterop();
  });
  return b;
}

const POLICY_LABEL = { ask: "每次都问", auto: "放开（读过外部内容时仍会问）", normal: "普通" };

async function loadDangerTools() {
  const list = $("danger-tools");
  try {
    const { tools, ordinary, sites } = await api("GET", "/api/tools");
    list.replaceChildren();
    if (tools.length === 0) list.append(h("p", { class: "none", text: "现在没有会改动东西的外来工具。" }));
    // Grouped by where the tools come from; a group of several can be decided all at once.
    const groups = new Map();
    for (const t of tools) groups.set(t.source, [...(groups.get(t.source) || []), t]);
    for (const [source, group] of groups) {
      if (group.length > 1) list.append(sourceHead(source, group));
      for (const t of group) list.append(toolRow(t));
    }
    renderOrdinary(ordinary);
    renderSites(sites);
  } catch (error) {
    list.replaceChildren(h("p", { class: "none", text: error.message }));
  }
}

function toolRow(t) {
  const select = h(
    "select",
    { class: "policy", "aria-label": `${t.name} 怎么处理` },
    Object.entries(POLICY_LABEL).map(([value, text]) => h("option", { value, text })),
  );
  select.value = t.policy;
  select.addEventListener("change", async () => {
    select.disabled = true;
    try {
      toast((await api("POST", "/api/tool-policy", { tool: t.name, policy: select.value })).message);
    } catch (error) {
      toast(error.message);
      select.value = t.policy;
    }
    select.disabled = false;
  });
  return h(
    "div",
    { class: "item" },
    h(
      "div",
      { class: "item-main" },
      h("p", { class: "item-text", text: t.name }),
      h("p", { class: "item-meta", text: `来自 ${t.source}` }),
    ),
    select,
  );
}

/** One source's tools decided together. Unlocking them all takes a second tap. */
function sourceHead(source, group) {
  const setAll = async (policy, button) => {
    button.disabled = true;
    try {
      toast((await api("POST", "/api/tool-policy/source", { source, policy })).message);
    } catch (error) {
      toast(error.message);
    }
    loadDangerTools();
  };
  const unlock = h("button", { type: "button", class: "btn", text: "全部放开" });
  let armed = 0;
  unlock.addEventListener("click", () => {
    if (armed) return setAll("auto", unlock);
    unlock.textContent = "确定全部放开";
    unlock.classList.add("primary");
    armed = setTimeout(() => {
      armed = 0;
      unlock.textContent = "全部放开";
      unlock.classList.remove("primary");
    }, 4000);
  });
  const lock = h("button", { type: "button", class: "btn", text: "全部每次都问" });
  lock.addEventListener("click", () => setAll("ask", lock));
  const allOpen = group.every((t) => t.policy === "auto");
  const allAsk = group.every((t) => t.policy === "ask");
  return h(
    "div",
    { class: "source-head" },
    h("p", { class: "source-name", text: `${source} · ${group.length} 个工具` }),
    h("span", { class: "spacer" }),
    allOpen ? null : unlock,
    allAsk ? null : lock,
  );
}

const LEVEL_LABEL = { ask: "先问我", auto: "直接办，办完告诉你" };

function renderOrdinary(tools) {
  const list = $("ordinary-tools");
  list.replaceChildren();
  for (const t of tools) {
    const select = h(
      "select",
      { class: "policy", "aria-label": `${t.label} 怎么处理` },
      Object.entries(LEVEL_LABEL).map(([value, text]) => h("option", { value, text })),
    );
    select.value = t.level;
    select.addEventListener("change", async () => {
      select.disabled = true;
      try {
        toast((await api("POST", "/api/tool-level", { tool: t.name, level: select.value })).message);
      } catch (error) {
        toast(error.message);
        select.value = t.level;
      }
      select.disabled = false;
    });
    list.append(
      h(
        "div",
        { class: "item" },
        h(
          "div",
          { class: "item-main" },
          h("p", { class: "item-text", text: t.label }),
          h("p", { class: "item-meta", text: `${t.name} · 来自 ${t.source}` }),
        ),
        select,
      ),
    );
  }
}

function renderSites(sites) {
  const list = $("sites");
  list.replaceChildren();
  if (sites.length === 0) return;
  list.append(h("p", { class: "item-meta", text: "记住的网站：打开、点击、翻页不再问" }));
  for (const host of sites) {
    const remove = h("button", { type: "button", class: "btn", text: "移除", "aria-label": `移除 ${host}` });
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        toast((await api("POST", "/api/site/forget", { host })).message);
      } catch (error) {
        toast(error.message);
      }
      loadDangerTools();
    });
    list.append(
      h("div", { class: "item" }, h("div", { class: "item-main" }, h("p", { class: "item-text", text: host })), remove),
    );
  }
}

async function loadInterop() {
  let data;
  try {
    data = await api("GET", "/api/interop");
  } catch (error) {
    $("mcp-servers").replaceChildren(h("p", { class: "hint", text: error.message }));
    return;
  }
  const browser = data.servers.find((s) => s.name === "browser");
  $("p-browser-status").textContent = !browser
    ? "未加上。第一次启动要联网下载 Playwright，稍等片刻。"
    : browser.state === "ready"
      ? `已就绪 · ${browser.tools} 个工具`
      : `${STATE_WORDS[browser.state] || browser.state}${browser.error ? `：${browser.error}` : ""}`;
  $("p-browser").textContent = browser ? "移除" : "加上";
  $("p-browser").dataset.on = browser ? "1" : "";
  const servers = $("mcp-servers");
  servers.replaceChildren();
  if (data.servers.length === 0)
    servers.append(h("p", { class: "none", text: "还没有 MCP 工具。可以从下面其他 agent 的工具里选，或手动添加。" }));
  for (const s of data.servers) {
    const meta =
      s.state === "ready"
        ? `${s.tools} 个工具 · ${s.command}`
        : `${STATE_WORDS[s.state] || s.state}${s.error ? `：${s.error}` : ""} · ${s.command}`;
    servers.append(
      row(
        s.name,
        meta,
        actionButton("移除", false, async () => {
          await api("POST", "/api/mcp/remove", { name: s.name });
          return `已移除 ${s.name}`;
        }),
        s.state === "ready" ? "可用" : null,
      ),
    );
  }
  // A server takes a moment to start: look again until none is starting.
  clearTimeout(interopTimer);
  if (data.servers.some((s) => s.state === "starting") && view === "settings")
    interopTimer = setTimeout(loadInterop, 1000);
  const importable = $("mcp-import");
  importable.replaceChildren();
  for (const s of data.importable) {
    importable.append(
      row(
        s.name,
        `来自 ${s.from} · ${s.command}`,
        actionButton("也给 moqi 用", true, async () => {
          await api("POST", "/api/mcp/import", { names: [s.name] });
          return `${s.name} 正在启动`;
        }),
      ),
    );
  }
  const self = $("a2a-self");
  self.replaceChildren();
  if (data.a2a.card) {
    const reveal = h("button", { type: "button", class: "btn", text: "显示钥匙" });
    const meta = h("p", { class: "item-meta", text: data.a2a.card });
    reveal.addEventListener("click", () => {
      meta.textContent = `${data.a2a.card}\n钥匙：${data.a2a.key}`;
      meta.style.whiteSpace = "pre-wrap";
      reveal.remove();
    });
    self.append(
      h(
        "div",
        { class: "item" },
        h("div", { class: "item-main" }, h("p", { class: "item-text", text: "moqi 的 agent card" }), meta),
        reveal,
      ),
    );
  } else {
    self.append(h("p", { class: "hint", text: "后台的 moqi 是旧版本，重启后才有 A2A。" }));
  }
  const agents = $("a2a-agents");
  agents.replaceChildren();
  if (data.a2a.agents.length === 0)
    agents.append(h("p", { class: "none", text: "还没有。添加后，moqi 在对话里需要时会去问它们（每次先问你）。" }));
  for (const a of data.a2a.agents) {
    agents.append(
      row(
        a.name,
        `${a.url}${a.hasKey ? " · 带钥匙" : ""}`,
        actionButton("移除", false, async () => {
          await api("POST", "/api/a2a/remove", { name: a.name });
          return `已移除 ${a.name}`;
        }),
      ),
    );
  }
}

$("mcp-add").addEventListener("click", async () => {
  const name = $("mcp-name").value.trim();
  const parts = $("mcp-command").value.trim().split(/\s+/).filter(Boolean);
  if (!name || parts.length === 0) return toast("名字和启动命令都要填");
  try {
    await api("POST", "/api/mcp/add", { name, command: parts[0], args: parts.slice(1) });
    $("mcp-name").value = "";
    $("mcp-command").value = "";
    toast(`${name} 正在启动`);
  } catch (error) {
    toast(error.message);
  }
  loadInterop();
});

$("a2a-add").addEventListener("click", async () => {
  const name = $("a2a-name").value.trim();
  const url = $("a2a-url").value.trim();
  if (!name || !url) return toast("名字和地址都要填");
  try {
    await api("POST", "/api/a2a/add", { name, url, key: $("a2a-key").value.trim() || undefined });
    for (const id of ["a2a-name", "a2a-url", "a2a-key"]) $(id).value = "";
    toast(`已添加 ${name}`);
  } catch (error) {
    toast(error.message);
  }
  loadInterop();
});

async function loadAgents() {
  const box = $("agents");
  let agents = [];
  try {
    agents = (await api("GET", "/api/agents")).agents;
  } catch (error) {
    box.replaceChildren(h("p", { class: "hint", text: error.message }));
    return;
  }
  box.replaceChildren();
  if (agents.length === 0) {
    box.append(
      h("p", { class: "none", text: "没找到别的 agent。装了 Kiro、Cursor、Claude Code 之类的之后，moqi 会自己发现。" }),
    );
  }
  for (const a of agents) {
    const status = a.problem ? a.problem : a.connected ? "已接入" : "未接入";
    const button = h("button", {
      type: "button",
      class: a.connected ? "btn" : "btn primary",
      text: a.connected ? "断开" : "接入",
      disabled: !!a.problem,
    });
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api("POST", a.connected ? "/api/agents/disconnect" : "/api/agents/connect", { id: a.id });
        toast(
          a.connected ? `已从 ${a.name} 断开` : `已接入 ${a.name}。新开一个会话，或在它的 MCP 设置里刷新一下就能用`,
        );
      } catch (error) {
        toast(error.message);
      }
      loadAgents();
    });
    box.append(
      h(
        "div",
        { class: "item" },
        h(
          "div",
          { class: "item-main" },
          h("p", { class: "item-text" }, a.connected ? h("span", { class: "tag", text: "已接入" }) : null, a.name),
          h("p", { class: "item-meta", text: a.connected ? a.path : `${status} · ${a.path}` }),
        ),
        button,
      ),
    );
  }
}

function showNews(feeds) {
  const on = feeds !== null && feeds.length > 0;
  const chosen = new Set((feeds || []).map((f) => f.url));
  const box = $("n-presets");
  box.replaceChildren();
  for (const f of newsPresets) {
    const check = h("input", { type: "checkbox", value: f.url });
    check.checked = on ? chosen.has(f.url) : newsPresets.indexOf(f) < 3;
    box.append(h("label", { class: "check" }, check, f.name));
  }
  const known = new Set(newsPresets.map((f) => f.url));
  $("n-extra").value = (feeds || [])
    .filter((f) => !known.has(f.url))
    .map((f) => f.url)
    .join("\n");
  $("n-on").checked = on;
  toggle("n-on", "n-body");
}

function newsInput() {
  const picked = [...$("n-presets").querySelectorAll("input:checked")].map((c) =>
    newsPresets.find((f) => f.url === c.value),
  );
  const extra = $("n-extra")
    .value.split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((url) => ({ name: new URL(url).hostname.replace(/^www\./, ""), url }));
  return [...picked, ...extra];
}

async function searchCity() {
  const q = $("w-q").value.trim();
  const box = $("w-results");
  if (!q) return;
  box.replaceChildren(h("p", { class: "hint", text: "正在查…" }));
  try {
    const { results } = await api("GET", `/api/geocode?q=${encodeURIComponent(q)}`);
    box.replaceChildren();
    if (results.length === 0)
      box.append(h("p", { class: "hint", text: "没找到，换个写法试试，比如「深圳」或「Shenzhen」" }));
    for (const r of results) {
      const radio = h("input", { type: "radio", name: "city" });
      radio.addEventListener("change", () => {
        weather = { latitude: r.latitude, longitude: r.longitude, place: r.name };
        showWeather();
      });
      box.append(h("label", {}, radio, h("span", {}, r.name, h("small", { text: r.region }))));
    }
  } catch (error) {
    box.replaceChildren(h("p", { class: "hint", text: error.message }));
  }
}
$("w-search").addEventListener("click", searchCity);
$("w-q").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    searchCity();
  }
});

$("c-check").addEventListener("click", async () => {
  const out = $("c-result");
  const path = $("c-path").value.trim();
  if (!path) return setResult(out, "先填文件路径", "bad");
  try {
    const r = await api("POST", "/api/calendar/check", { path });
    if (r.exists) setResult(out, `找到 ${r.events} 个日程`, "ok");
    else setResult(out, "找不到这个文件", "bad");
  } catch (error) {
    setResult(out, error.message, "bad");
  }
});

$("settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = $("save-result");
  const m = modelInput();
  if ((m.baseURL && !m.model) || (!m.baseURL && m.model)) return setResult(out, "接口地址和模型名要一起填", "bad");
  if ($("w-on").checked && !weather) return setResult(out, "天气开着，但还没选城市", "bad");
  if ($("c-on").checked && !$("c-path").value.trim()) return setResult(out, "日历开着，但还没填文件路径", "bad");
  let feeds = [];
  try {
    feeds = $("n-on").checked ? newsInput() : [];
  } catch {
    return setResult(out, "有一个 RSS 地址不对，要以 https:// 开头", "bad");
  }
  if ($("n-on").checked && feeds.length === 0) return setResult(out, "新闻开着，但一个来源都没选", "bad");
  const folders = $("f-folders")
    .value.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if ($("f-on").checked && folders.length === 0) return setResult(out, "文件开着，但一个文件夹都没填", "bad");
  const config = {
    model: m.baseURL
      ? { ...m, ...(tested && tested.baseURL === m.baseURL && tested.model === m.model && { vision: tested.vision }) }
      : null,
    persona: $("persona").value.trim() || undefined,
    briefingAt: $("b-on").checked ? $("b-at").value : null,
    todoReviewAt: $("r-on").checked ? $("r-at").value : null,
    quiet: { from: $("q-from").value, to: $("q-to").value },
    dailyBudget: Number($("budget").value),
    weather: $("w-on").checked ? weather : undefined,
    calendar: $("c-on").checked ? { ics: $("c-path").value.trim() } : undefined,
    news: { feeds }, // an empty list turns news off; leaving it out would mean the default feeds
    // Left out while untouched and never saved, so search keeps following the model.
    search: searchInfo?.saved || searchTouched ? searchInput() : undefined,
    files: $("f-on").checked ? { folders } : undefined,
    code: projectsInput().length
      ? { timeoutMinutes: Number($("code-timeout").value) || 30, projects: projectsInput() }
      : undefined,
    mac: $("mac-on").checked
      ? { shortcuts: [...$("mac-shortcuts").querySelectorAll("input:checked")].map((c) => c.value) }
      : undefined,
  };
  $("save").disabled = true;
  setResult(out, "正在保存…");
  try {
    await api("POST", "/api/config", { config });
    $("m-key").value = "";
    $("s-key").value = "";
    settingsLoaded = false;
    await loadSettings();
    setResult(out, "已保存，已经生效", "ok");
    await refresh();
  } catch (error) {
    setResult(out, error.message, "bad");
  }
  $("save").disabled = false;
});

/* Start */

async function loop() {
  await refresh();
  const fast = sending !== null || !!state?.question || !!state?.thinking || !!state?.studying;
  setTimeout(loop, document.hidden ? 10_000 : fast ? 800 : 3000);
}

if (!token) {
  banner("这个浏览器还没有 moqi 的钥匙。请在终端运行 moqi，用它打开的链接进来一次，之后直接输入地址就行。");
} else {
  refresh().then(() => {
    if (state && !state.configured && view === "chat") view = "settings";
    show(view);
    loop();
  });
}
