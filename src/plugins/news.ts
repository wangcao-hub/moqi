// News from RSS and Atom feeds the user picked. moqi reads the headlines while it reflects and tells the
// user about the ones that matter to them; the `news` tool lets the chat or a watch look things up.
import { z } from "zod";
import { defineTool, type Plugin, type SourceContext } from "../core/plugin.js";

export interface Feed {
  readonly name: string;
  readonly url: string;
}

export interface NewsItem {
  readonly title: string;
  readonly url: string;
  readonly source: string;
  readonly at?: number;
}

/** Feeds that work without a key and load from mainland China. The first three are on by default. */
export const NEWS_FEEDS: readonly Feed[] = [
  { name: "少数派", url: "https://sspai.com/feed" },
  { name: "IT之家", url: "https://www.ithome.com/rss/" },
  { name: "Solidot", url: "https://www.solidot.org/index.rss" },
  { name: "爱范儿", url: "https://www.ifanr.com/feed" },
  { name: "Hacker News", url: "https://hnrss.org/frontpage" },
];

export interface NewsOptions {
  readonly feeds: readonly Feed[];
  readonly fetch?: typeof fetch;
  /** Feeds are fetched again after this long. Default 30 minutes. */
  readonly refreshMs?: number;
  /** Items kept per feed. Default 15. */
  readonly perFeed?: number;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Plain text from a bit of HTML or XML: CDATA and entities decoded, tags dropped, white space folded. */
export function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1]?.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
    if (m?.[1] !== undefined) return m[1];
  }
  return undefined;
}

function atomLink(block: string): string | undefined {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1] ?? "");
  const pick = links.find((a) => !/\brel=/.test(a) || /\brel=["']alternate["']/.test(a)) ?? links[0];
  return pick ? /\bhref=["']([^"']+)["']/.exec(pick)?.[1] : undefined;
}

/** The readable text of an article page: the <article> (or <main>, or <body>) without scripts, styles and chrome. */
export function articleText(html: string): string {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, " ");
  const part =
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(cleaned)?.[1] ??
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(cleaned)?.[1] ??
    /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(cleaned)?.[1] ??
    cleaned;
  return decode(part.replace(/<\/(p|div|li|h[1-6]|br|tr)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "));
}

/** RSS 2.0 and Atom, read leniently: a broken item is skipped, not the whole feed. */
export function parseFeed(xml: string, source: string): NewsItem[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const items: NewsItem[] = [];
  for (const block of blocks) {
    const title = decode(tag(block, ["title"]) ?? "");
    const url = decode(tag(block, ["link"]) ?? "") || decode(atomLink(block) ?? "");
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const date = Date.parse(decode(tag(block, ["pubDate", "published", "updated", "dc:date"]) ?? ""));
    items.push({ title: title.slice(0, 200), url, source, ...(Number.isFinite(date) && { at: date }) });
  }
  return items;
}

async function fetchText(doFetch: typeof fetch, url: string, ms: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await doFetch(url, {
      signal: controller.signal,
      headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
    });
    if (!response.ok) throw new Error(`${url} responded ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export function newsPlugin(options: NewsOptions): Plugin {
  const doFetch = options.fetch ?? fetch;
  const refreshMs = options.refreshMs ?? 30 * 60_000;
  const perFeed = options.perFeed ?? 15;
  let cache: { at: number; items: NewsItem[] } | undefined;
  let loading: Promise<NewsItem[]> | undefined;

  const latest = async (now: number): Promise<NewsItem[]> => {
    if (cache && now - cache.at < refreshMs) return cache.items;
    if (loading) return loading;
    loading = (async () => {
      const results = await Promise.allSettled(
        options.feeds.map(async (f) => parseFeed(await fetchText(doFetch, f.url, 15_000), f.name).slice(0, perFeed)),
      );
      const seen = new Set<string>();
      const items = results
        .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
        .filter((it) => !seen.has(it.url) && seen.add(it.url))
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      // Keep the old headlines when every feed failed this time.
      if (items.length > 0 || !cache) cache = { at: now, items };
      return cache.items;
    })().finally(() => {
      loading = undefined;
    });
    return loading;
  };

  return {
    name: "news",
    // Only articles this plugin listed itself: a model cannot send it to any other address.
    read: async (url, ctx) => {
      const items = await latest(ctx.now());
      if (!items.some((it) => it.url === url)) return undefined;
      const html = await fetchText(doFetch, url, 20_000);
      return articleText(html.slice(0, 2_000_000)).slice(0, 20_000);
    },
    tools: [
      defineTool({
        name: "news",
        description:
          "Latest headlines from the news feeds the user follows, optionally only those containing a keyword.",
        input: z.object({
          query: z.string().optional().describe("A keyword, e.g. AI 或 手机; omit for all"),
          limit: z.number().int().min(1).max(20).default(8),
        }),
        effect: "read",
        run: async ({ query, limit }, ctx) => {
          const all = await latest(ctx.now());
          const q = query?.trim().toLowerCase();
          const hits = (q ? all.filter((it) => it.title.toLowerCase().includes(q)) : all).slice(0, limit);
          if (hits.length === 0) return q ? `最近的新闻里没有「${query}」` : "暂时拿不到新闻";
          return {
            value: hits.map((it) => it.url).join("\n"),
            headline: hits[0] ? `${hits[0].title}（${hits[0].source}）` : "",
            details: hits.map((it) => `- ${it.title}（${it.source}）${it.url}`).join("\n"),
          };
        },
      }),
    ],
    context: async (ctx): Promise<SourceContext | undefined> => {
      const items = (await latest(ctx.now())).slice(0, 24);
      if (items.length === 0) return undefined;
      const links: Record<string, { title: string; url: string }> = {};
      const lines = items.map((it, i) => {
        links[`n${i + 1}`] = { title: it.title, url: it.url };
        return `[n${i + 1}] ${it.title}（${it.source}）`;
      });
      return { text: `最新的新闻：\n${lines.join("\n")}`, links };
    },
  };
}
