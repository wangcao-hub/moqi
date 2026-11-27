// Searching the web and reading pages through a search service, in the background: no browser, nothing to
// confirm. One adapter per service; the tools do not care which one answers. What comes back is outside
// content like any web page, so a dangerous action after it is asked again.
import { z } from "zod";
import { defineTool, type Plugin } from "../core/plugin.js";
import { fetchPage } from "./page.js";

export type SearchProvider = "deepseek" | "baidu";

export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly date?: string;
  readonly summary: string;
}

export interface WebPage {
  readonly title: string;
  readonly text: string;
}

/** One search service: finds pages and reads one. A failure throws its reason in Chinese, for the model to pass on. */
export interface SearchService {
  search(query: string, count: number): Promise<SearchHit[]>;
  read(url: string): Promise<WebPage>;
}

export interface SearchOptions {
  readonly provider: SearchProvider;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
}

export const SEARCH = {
  timeoutMs: 30_000,
  summaryChars: 500,
  resultChars: 5_000,
  pageChars: 8_000,
  /** The line the chat prompt gets while search is on. */
  guide:
    "查资料、看新闻、找网页内容，先用 web_search 搜，再用 web_read 读需要的网页；只有要登录、点按钮、填表时才用浏览器。",
} as const;

const DEEPSEEK = "https://api.deepseek.com/v1/tools";
const BAIDU = "https://qianfan.baidubce.com/v2/ai_search/web_search";

/** What a failed status means, in words the model can pass on. */
function statusProblem(service: string, status: number): string {
  if (status === 401) return "搜索的 key 不对，去设置里检查一下";
  if (status === 402 && service.startsWith("DeepSeek")) return "DeepSeek 余额不足，充值后才能接着搜";
  if (status === 429) return "搜索太频繁，或今天的免费额度用完了，过一会儿再试";
  return `${service}出错了（${status}）`;
}

/** POSTs JSON and returns the parsed reply. `special` names a status this call explains its own way. */
async function postJson(
  doFetch: typeof fetch,
  service: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  special: Readonly<Record<number, string>> = {},
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEARCH.timeoutMs),
    });
  } catch (error) {
    const late = error instanceof Error && error.name === "TimeoutError";
    throw new Error(late ? `${service}没有及时回应，稍后再试` : `${service}连不上`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(special[response.status] ?? statusProblem(service, response.status));
  }
  try {
    const data: unknown = await response.json();
    return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  } catch {
    throw new Error(`${service}回了看不懂的内容`);
  }
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** One result, or none when it lacks a title or a web address. The summary is the first field that has words. */
function hitOf(raw: unknown, summaryFields: readonly string[]): SearchHit[] {
  if (typeof raw !== "object" || raw === null) return [];
  const r = raw as Record<string, unknown>;
  const title = text(r.title);
  const url = text(r.url);
  if (!title || !/^https?:\/\//i.test(url)) return [];
  const summary = summaryFields.map((f) => text(r[f])).find(Boolean) ?? "";
  const date = text(r.date);
  return [{ title, url, ...(date && { date }), summary }];
}

function deepseek(apiKey: string, doFetch: typeof fetch): SearchService {
  const auth = { authorization: `Bearer ${apiKey}` };
  return {
    async search(query, count) {
      const data = await postJson(doFetch, "DeepSeek 搜索", `${DEEPSEEK}/search`, auth, { query, count });
      // `summary` is the long one DeepSeek writes for models; `snippet` when there is none.
      return (Array.isArray(data.results) ? data.results : []).flatMap((r) => hitOf(r, ["summary", "snippet"]));
    },
    async read(url) {
      const data = await postJson(
        doFetch,
        "DeepSeek 读网页",
        `${DEEPSEEK}/fetch`,
        auth,
        { url },
        {
          404: "这个网页读不出来",
        },
      );
      return { title: text(data.title), text: text(data.content) };
    },
  };
}

/** Baidu reports some failures with status 200 and a code in the body. */
function baiduProblem(code: unknown, message: string): string {
  if (/auth|apikey|api key|token/i.test(message)) return statusProblem("百度搜索", 401);
  if (/quota|limit|exceed|频|额度/i.test(message)) return statusProblem("百度搜索", 429);
  return `百度搜索出错了（${String(code)}）${message ? `：${message.slice(0, 200)}` : ""}`;
}

function baidu(apiKey: string, doFetch: typeof fetch): SearchService {
  // Baidu's text and its example disagree on the header; both carry the key.
  const auth = { authorization: `Bearer ${apiKey}`, "x-appbuilder-authorization": `Bearer ${apiKey}` };
  return {
    async search(query, count) {
      const data = await postJson(doFetch, "百度搜索", BAIDU, auth, {
        messages: [{ role: "user", content: query }],
        search_source: "baidu_search_v2",
        resource_type_filter: [{ type: "web", top_k: count }],
      });
      if (Array.isArray(data.references)) return data.references.flatMap((r) => hitOf(r, ["content"]));
      if (data.code !== undefined) throw new Error(baiduProblem(data.code, text(data.message)));
      return [];
    },
    // Baidu has no reader: moqi downloads the page itself, from public addresses only, without the key.
    read: (url) => fetchPage(url, doFetch),
  };
}

export function searchService(options: SearchOptions): SearchService {
  const doFetch = options.fetch ?? fetch;
  return options.provider === "baidu" ? baidu(options.apiKey, doFetch) : deepseek(options.apiKey, doFetch);
}

/** One block per hit the model reads: each summary cut short, the blocks kept to about SEARCH.resultChars. */
export function hitBlocks(hits: readonly SearchHit[]): string[] {
  const blocks: string[] = [];
  let size = 0;
  for (const [i, h] of hits.entries()) {
    const summary = h.summary.length > SEARCH.summaryChars ? `${h.summary.slice(0, SEARCH.summaryChars)}…` : h.summary;
    const block = [`${i + 1}. ${h.title.slice(0, 200)}`, h.url, h.date, summary].filter(Boolean).join("\n");
    if (blocks.length > 0 && size + block.length > SEARCH.resultChars) break;
    blocks.push(block.slice(0, SEARCH.resultChars));
    size += block.length + 2;
  }
  return blocks;
}

/** The results as the model reads them: each summary cut short, the list kept to about SEARCH.resultChars. */
export function formatHits(hits: readonly SearchHit[]): string {
  return hitBlocks(hits).join("\n\n");
}

/** A page as the model reads it: the title, then the text, cut at SEARCH.pageChars with a note that there is more. */
export function formatPage(page: WebPage): string {
  if (!page.text.trim()) return "这个网页没有读到正文";
  const body = page.title ? `${page.title}\n\n${page.text}` : page.text;
  return body.length > SEARCH.pageChars ? `${body.slice(0, SEARCH.pageChars)}\n（后面还有，没有读完）` : body;
}

export function searchPlugin(options: SearchOptions): Plugin {
  const service = searchService(options);
  return {
    name: "search",
    guide: SEARCH.guide,
    tools: [
      defineTool({
        name: "web_search",
        description:
          "Search the web: news, facts, prices, how-tos, anything on public pages. Returns titles, links, dates and summaries; read a page in full with web_read.",
        input: z.object({
          query: z.string().min(1).max(128).describe("What to search for, in the user's language"),
          count: z.number().int().min(1).max(10).default(6).describe("How many results, 1 to 10"),
        }),
        effect: "read",
        run: async ({ query, count }) => {
          const hits = await service.search(query, count);
          const first = hits[0];
          if (!first) return "没有搜到相关的网页";
          const blocks = hitBlocks(hits);
          return {
            value: hits.map((h) => h.url).join("\n"),
            headline: `搜到 ${blocks.length} 条，第一条是「${first.title}」`,
            details: blocks.join("\n\n"),
          };
        },
      }),
      defineTool({
        name: "web_read",
        description: "Read the main text of a web page by its address, e.g. one web_search found.",
        input: z.object({
          url: z
            .string()
            .url()
            .refine((url) => /^https?:\/\//i.test(url), "只能读 http 和 https 的网页")
            .describe("The page's address, http or https"),
        }),
        effect: "read",
        readsUrl: true,
        run: async ({ url }) => formatPage(await service.read(url)),
      }),
    ],
  };
}
