import { describe, expect, it } from "vitest";
import { State } from "../src/core/state.js";
import { articleText, newsPlugin, parseFeed } from "../src/plugins/news.js";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>
<item><title><![CDATA[苹果发布 <b>新</b> 手机]]></title><link>https://a.example/1</link><pubDate>Fri, 20 Nov 2026 09:00:00 +0800</pubDate></item>
<item><title>R&amp;D &#x4E2D;&#25991; &quot;quoted&quot;</title><link>https://a.example/2</link></item>
<item><title>no link</title></item>
<item><title>bad link</title><link>javascript:alert(1)</link></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title>
<entry><title>Atom 条目</title><link rel="self" href="https://b.example/self"/><link rel="alternate" href="https://b.example/post"/><updated>2026-11-20T10:00:00Z</updated></entry>
</feed>`;

describe("news feeds", () => {
  it("reads RSS and Atom, decodes entities and CDATA, and skips items without a web link", () => {
    expect(parseFeed(RSS, "A")).toEqual([
      { title: "苹果发布 新 手机", url: "https://a.example/1", source: "A", at: Date.parse("2026-11-20T01:00:00Z") },
      { title: 'R&D 中文 "quoted"', url: "https://a.example/2", source: "A" },
    ]);
    expect(parseFeed(ATOM, "B")).toEqual([
      { title: "Atom 条目", url: "https://b.example/post", source: "B", at: Date.parse("2026-11-20T10:00:00Z") },
    ]);
    expect(parseFeed("<html>not a feed</html>", "C")).toEqual([]);
    // A numeric entity past the last code point stays as written instead of breaking the feed.
    expect(
      parseFeed(
        "<rss><item><title>大&#99999999;数 &#x110000; &#x10FFFF;</title><link>https://a.example/3</link></item></rss>",
        "D",
      ),
    ).toEqual([{ title: "大&#99999999;数 &#x110000; \u{10FFFF}", url: "https://a.example/3", source: "D" }]);
  });

  it("merges feeds newest first, caches them, survives a failing feed, and gives reflection keyed links", async () => {
    let calls = 0;
    let down = false;
    const fetchImpl = (async (url: string | URL | Request) => {
      calls++;
      if (down || String(url).includes("broken")) return new Response("nope", { status: 500 });
      return new Response(String(url).includes("atom") ? ATOM : RSS);
    }) as typeof fetch;
    let now = Date.parse("2026-11-20T12:00:00+08:00");
    const plugin = newsPlugin({
      feeds: [
        { name: "A", url: "https://a.example/rss" },
        { name: "B", url: "https://b.example/atom" },
        { name: "X", url: "https://broken.example/rss" },
      ],
      fetch: fetchImpl,
    });
    const ctx = { now: () => now, state: new State(), observe: () => {}, offer: () => ({}) as never };

    const context = await plugin.context?.(ctx);
    expect(context?.text).toContain("[n1] Atom 条目（B）");
    expect(context?.text).toContain("[n2] 苹果发布 新 手机（A）");
    expect(context?.links?.n1).toEqual({ title: "Atom 条目", url: "https://b.example/post" });
    expect(calls).toBe(3);

    const tool = plugin.tools?.[0];
    const toolCtx = { now: () => now, state: new State() };
    const found = await tool?.run({ query: "手机", limit: 8 }, toolCtx);
    expect(found).toMatchObject({ headline: "苹果发布 新 手机（A）", value: "https://a.example/1" });
    expect(await tool?.run({ query: "火星", limit: 8 }, toolCtx)).toBe("最近的新闻里没有「火星」");
    expect(calls).toBe(3); // cached

    now += 31 * 60_000;
    down = true;
    expect((await plugin.context?.(ctx))?.links?.n1?.title).toBe("Atom 条目"); // every feed failed: keep the old ones
    expect(calls).toBe(6);
  });

  it("reads an article whose markup is never closed, and stays fast on such pages", () => {
    // A block that is never closed stays; a closed one goes, whatever the case of its tags.
    expect(articleText("<body><NAV>菜单</nav><p>正文</p><aside>未关")).toBe("正文 未关");
    // An <article> that is never closed falls back to <main>.
    expect(articleText("<article>未关<main><p>主要的</p></main>")).toBe("主要的");
    // A "<!--" that is never closed is dropped by itself, so a script holding one does not eat the page.
    expect(articleText('<body><script>var s = "<!--";</script><p>正文</p></body>')).toBe("正文");
    expect(articleText("<p>前</p><!-- 没有结束 <p>后</p>")).toBe("前 没有结束 后");
    // <!--> and <!---> are empty comments; a closed comment goes.
    const empty = articleText("<p>前</p><!--> <p>后</p>");
    expect(empty).toContain("前");
    expect(empty).toContain("后");
    expect(articleText("<p>前</p><!---> <p>后</p>")).toBe("前 后");
    expect(articleText("<p>前</p><!-- 注释 --><p>后</p>")).toBe("前 后");
    const start = performance.now();
    for (const html of ["<!--".repeat(500_000), "<nav>".repeat(400_000), "<main ".repeat(330_000)]) articleText(html);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});
