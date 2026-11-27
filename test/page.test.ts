import { describe, expect, it } from "vitest";
import { addressProblem, fetchPage, PAGE } from "../src/plugins/page.js";

const LOCAL = "不能读本机或局域网里的地址";

/** A fake web: each address answers with what `pages` says; every request is recorded. */
function web(pages: Record<string, () => Response>) {
  const seen: { url: string; redirect: RequestRedirect | undefined; auth: string | null }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, redirect: init?.redirect, auth: new Headers(init?.headers).get("authorization") });
    const page = pages[url];
    return page ? page() : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: impl, seen };
}

const page =
  (body: BodyInit, type = "text/html; charset=utf-8") =>
  () =>
    new Response(body, { headers: { "content-type": type } });
const moved = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });

describe("addresses moqi may fetch itself", () => {
  it("allows public http and https pages", () => {
    for (const url of [
      "https://example.com/a?b=1",
      "http://news.example.cn/",
      "http://8.8.8.8/",
      "http://172.32.0.1/",
      "http://[2001:db8::1]/",
      "http://[::ffff:8.8.8.8]/",
    ])
      expect(addressProblem(url), url).toBeUndefined();
  });

  it("refuses other schemes, user names and passwords, and what is not a URL", () => {
    expect(addressProblem("ftp://example.com/")).toBe("只能读 http 和 https 的网页");
    expect(addressProblem("file:///etc/passwd")).toBe("只能读 http 和 https 的网页");
    expect(addressProblem("http://user:pw@example.com/")).toBe("网址里不能带用户名或密码");
    expect(addressProblem("http://user@example.com/")).toBe("网址里不能带用户名或密码");
    expect(addressProblem("not a url")).toBe("网址不对");
  });

  it("refuses this computer and the local network, however the address is written", () => {
    for (const url of [
      "http://localhost:6674/api/state",
      "http://LOCALHOST./",
      "http://app.localhost/",
      "http://nas.local/",
      "http://nas.local./",
      "http://127.0.0.1/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f.0.0.1/",
      "http://0.0.0.0/",
      "http://10.0.0.8/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://[::]/",
      "http://[fc00::1]/",
      "http://[fd12:3456::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:192.168.1.1]/",
    ])
      expect(addressProblem(url), url).toBe(LOCAL);
  });
});

describe("reading a page moqi fetches itself", () => {
  it("returns the title and the article text, and never lets fetch follow a redirect", async () => {
    const net = web({
      "https://news.example/a": page(
        "<html><head><title>深圳 &amp; 暴雨</title></head><body><nav>菜单</nav><article><p>气象台说明天有暴雨。</p></article></body></html>",
      ),
    });
    expect(await fetchPage("https://news.example/a", net.fetch)).toEqual({
      title: "深圳 & 暴雨",
      text: "气象台说明天有暴雨。",
    });
    expect(net.seen).toEqual([{ url: "https://news.example/a", redirect: "manual", auth: null }]);
  });

  it("follows a redirect to a public page, checking the new address", async () => {
    const net = web({
      "https://a.example/old": moved("/new"),
      "https://a.example/new": page("<html><head><title>新</title></head><body><p>到了</p></body></html>"),
    });
    expect(await fetchPage("https://a.example/old", net.fetch)).toEqual({ title: "新", text: "到了" });
    expect(net.seen.map((s) => s.url)).toEqual(["https://a.example/old", "https://a.example/new"]);
  });

  it("stops at a redirect into the local network, before fetching it", async () => {
    const net = web({ "https://evil.example/x": moved("http://127.0.0.1:6674/api/state") });
    await expect(fetchPage("https://evil.example/x", net.fetch)).rejects.toThrow(LOCAL);
    expect(net.seen.map((s) => s.url)).toEqual(["https://evil.example/x"]);
  });

  it("refuses a local address without fetching anything", async () => {
    const net = web({});
    await expect(fetchPage("http://192.168.1.1/", net.fetch)).rejects.toThrow(LOCAL);
    expect(net.seen).toEqual([]);
  });

  it("gives up after five redirects", async () => {
    const pages: Record<string, () => Response> = {};
    for (let i = 0; i < 10; i++) pages[`https://loop.example/${i}`] = moved(`/${i + 1}`);
    const net = web(pages);
    await expect(fetchPage("https://loop.example/0", net.fetch)).rejects.toThrow("这个网页跳转太多次了");
    expect(net.seen).toHaveLength(PAGE.maxRedirects + 1);
  });

  it("says so when a redirect has nowhere to go", async () => {
    const net = web({ "https://a.example/r": () => new Response(null, { status: 301 }) });
    await expect(fetchPage("https://a.example/r", net.fetch)).rejects.toThrow("这个网页跳转出错了");
  });

  it("reads plain text, and refuses what is not a web page", async () => {
    const net = web({
      "https://a.example/t.txt": page("  就是一段文字  ", "text/plain"),
      "https://a.example/f.pdf": page("%PDF-1.7", "application/pdf"),
    });
    expect(await fetchPage("https://a.example/t.txt", net.fetch)).toEqual({ title: "", text: "就是一段文字" });
    await expect(fetchPage("https://a.example/f.pdf", net.fetch)).rejects.toThrow("这不是网页，读不了");
  });

  it("reads at most 2 MB, leaving out a character cut at the limit", async () => {
    const net = web({ "https://a.example/big": page("字".repeat(1_000_000), "text/plain; charset=utf-8") }); // 3 MB
    expect((await fetchPage("https://a.example/big", net.fetch)).text).toBe("字".repeat(666_666));
  });

  it("decodes a page in the charset it declares", async () => {
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]); // 中文 in GBK
    const net = web({ "https://a.example/gbk": page(gbk, "text/plain; charset=GBK") });
    expect((await fetchPage("https://a.example/gbk", net.fetch)).text).toBe("中文");
  });

  it("says why a page cannot be read", async () => {
    const net = web({ "https://a.example/gone": () => new Response("no", { status: 410 }) });
    await expect(fetchPage("https://a.example/gone", net.fetch)).rejects.toThrow("这个网页打不开（410）");
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(fetchPage("https://a.example/", down)).rejects.toThrow(/^这个网页打不开$/);
    const slow = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as typeof fetch;
    await expect(fetchPage("https://a.example/", slow)).rejects.toThrow("这个网页太久没有打开");
  });
});
