// Reading a web page moqi downloads itself. A page can tell the model to read any address, so only public
// http(s) addresses are fetched, and every redirect is checked again. What a public name resolves to is not
// visible here (plugins use no Node APIs), so a name pointing into the local network (DNS rebinding) gets
// through; moqi's own console still needs its key.
import { articleText, decode } from "./news.js";

export const PAGE = { maxBytes: 2_000_000, timeoutMs: 20_000, maxRedirects: 5 } as const;

const LOCAL = "不能读本机或局域网里的地址";

export interface PageText {
  readonly title: string;
  readonly text: string;
}

/** A reason this module gives itself; anything else thrown on the way is a failed download. */
class PageProblem extends Error {}

/** 0/8, 10/8, 127/8, 169.254/16, 172.16/12 and 192.168/16, by the first two parts of the address. */
function v4Local(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Loopback, unspecified, fc00::/7, fe80::/10, and an IPv4 address written as IPv6 (in the URL's short form). */
function v6Local(address: string): boolean {
  if (address === "::" || address === "::1") return true;
  const v4 = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (v4) {
    const high = Number.parseInt(v4[1] ?? "0", 16);
    return v4Local(high >> 8, high & 0xff);
  }
  const first = address.startsWith("::") ? 0 : Number.parseInt(address.split(":")[0] ?? "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/** Why moqi will not fetch this address itself, or undefined when it may. */
export function addressProblem(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "网址不对";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "只能读 http 和 https 的网页";
  if (parsed.username || parsed.password) return "网址里不能带用户名或密码";
  // The URL parser already turned 127.1, 2130706433 and 0x7f.0.0.1 into 127.0.0.1, and IPv6 into its short form.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return LOCAL;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4 && v4Local(Number(v4[1]), Number(v4[2]))) return LOCAL;
  if (host.startsWith("[") && v6Local(host.slice(1, -1))) return LOCAL;
  return undefined;
}

/** At most `max` bytes of the body; the rest is not downloaded. */
async function readBytes(response: Response, max: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.byteLength, max - size);
    chunks.push(value.subarray(0, take));
    size += take;
  }
  if (size >= max) await reader.cancel();
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** The text in the charset the server declared, UTF-8 when it declared none or one this runtime lacks. */
function textOf(bytes: Uint8Array, type: string): string {
  const charset = /charset=["']?([\w-]+)/.exec(type)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder();
  }
  return decoder.decode(bytes, { stream: true }); // a character cut at the size limit is left out
}

async function download(url: string, doFetch: typeof fetch): Promise<PageText> {
  const signal = AbortSignal.timeout(PAGE.timeoutMs);
  let current = url;
  for (let hop = 0; ; hop++) {
    const problem = addressProblem(current);
    if (problem) throw new PageProblem(problem);
    const response = await doFetch(current, {
      redirect: "manual",
      signal,
      headers: { accept: "text/html, text/plain;q=0.9" },
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new PageProblem("这个网页跳转出错了");
      if (hop >= PAGE.maxRedirects) throw new PageProblem("这个网页跳转太多次了");
      try {
        current = new URL(location, current).href;
      } catch {
        throw new PageProblem("这个网页跳转出错了");
      }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PageProblem(`这个网页打不开（${response.status}）`);
    }
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    const html = type.startsWith("text/html");
    if (!html && !type.startsWith("text/plain")) {
      await response.body?.cancel();
      throw new PageProblem("这不是网页，读不了");
    }
    const body = textOf(await readBytes(response, PAGE.maxBytes), type);
    if (!html) return { title: "", text: body.trim() };
    const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
    return { title: title ? decode(title).slice(0, 200) : "", text: articleText(body) };
  }
}

/** Downloads a public page: its title and readable text. Throws the reason, in Chinese, when it cannot. */
export async function fetchPage(url: string, doFetch: typeof fetch): Promise<PageText> {
  try {
    return await download(url, doFetch);
  } catch (error) {
    if (error instanceof PageProblem) throw new Error(error.message);
    const late = error instanceof Error && error.name === "TimeoutError";
    throw new Error(late ? "这个网页太久没有打开" : "这个网页打不开");
  }
}
