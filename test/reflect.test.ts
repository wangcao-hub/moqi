import type { LLMRequest } from "taugraph/nodes";
import { describe, expect, it } from "vitest";
import type { Plugin } from "../src/core/plugin.js";
import { IDEA_KIND, REFLECT } from "../src/core/reflect.js";
import { HOUR, harness, scriptedModel } from "./helpers.js";

const MIN = 60_000;

/** A source that knows two headlines, like the news plugin. */
const world: Plugin = {
  name: "world",
  context: () => ({
    text: "[n1] 深圳明天暴雨（气象台）\n[n2] 新款手机发布（IT之家）",
    links: {
      n1: { title: "深圳明天暴雨", url: "https://example.com/rain" },
      n2: { title: "新款手机发布", url: "https://example.com/phone" },
    },
  }),
};

const ideas = (...list: unknown[]) => JSON.stringify({ ideas: list });
const reflectRequest = (r: LLMRequest) => String(r.messages[0]?.content).includes("你自己在想");

describe("reflection", () => {
  it("turns ideas into offers: a ready-made action, a question to answer, news with real links", async () => {
    const model = scriptedModel(() =>
      ideas(
        {
          type: "serve",
          title: "明晚提醒你收衣服？",
          body: "明天暴雨",
          value: 0.7,
          timely: true,
          watch: { title: "收衣服", schedule: { every: "day", at: "20:00" }, remind: "收衣服" },
        },
        { type: "ask", title: "你一般几点下班？", body: "好提前提醒路况", value: 0.4 },
        {
          type: "world",
          title: "深圳明天暴雨",
          body: "出门带伞",
          value: 0.99,
          refs: ["n1", "n9"],
          url: "https://evil.example",
        },
      ),
    );
    const { moqi } = harness({ model, plugins: [world] });
    moqi.remember({ kind: "basic", content: "住在深圳南山" });

    const result = await moqi.reflect("user");
    expect(result.map((i) => i.type)).toEqual(["serve", "ask", "world"]);
    const offers = [...moqi.state.offers.values()].map((r) => r.offer);
    const serve = offers.find((o) => o.kind === IDEA_KIND.serve);
    expect(serve?.action).toEqual({
      tool: "watch_create",
      args: { title: "收衣服", schedule: { every: "day", at: "20:00" }, remind: "收衣服" },
    });
    expect(serve?.urgency).toBe("today"); // matters today: it may interrupt
    const ask = offers.find((o) => o.kind === IDEA_KIND.ask);
    expect(ask).toMatchObject({ answer: "text", urgency: "whenever", title: "你一般几点下班？" });
    const news = offers.find((o) => o.kind === IDEA_KIND.world);
    expect(news?.links).toEqual([{ title: "深圳明天暴雨", url: "https://example.com/rain" }]); // n9 is unknown, the model's url is ignored
    expect(news?.value).toBe(REFLECT.maxValue); // a model's idea never gets to break quiet hours

    const prompt = String(model.requests[0]?.messages[1]?.content);
    expect(prompt).toContain("住在深圳南山");
    expect(prompt).toContain("[n1] 深圳明天暴雨");
    expect(prompt).toContain("今天还能问 2 个问题");
    expect(prompt).toContain("可以用来盯着的工具");
    expect(model.requests[0]).toMatchObject({ responseFormat: "json", reasoning: "off" });

    const thought = moqi.state.thoughts.at(-1);
    expect(thought?.trigger).toBe("user");
    expect(thought?.ideas.every((i) => i.offerId)).toBe(true);
  });

  it("hears a todo in conversation and offers to put it on the list, unless it is there already", async () => {
    const model = scriptedModel(() =>
      ideas(
        {
          type: "serve",
          title: "要我明天 14:00 提醒你交报告吗？",
          value: 0.7,
          todo: { text: "交报告", day: "tomorrow", at: "14:00" },
        },
        { type: "serve", title: "要我记下买牛奶吗？", value: 0.5, todo: { text: "买牛奶", at: null } },
        { type: "serve", title: "早上 7 点提醒你开会？", value: 0.5, todo: { text: "开会", at: "07:00" } },
      ),
    );
    const { moqi } = harness({ model }); // 08:20
    await moqi.callTool("todo_add", { text: "买牛奶" }, { byUser: true });

    const result = await moqi.reflect("user");
    expect(result.map((i) => i.skipped ?? "")).toEqual(["", "待办里已经有了", ""]);
    const offers = [...moqi.state.offers.values()].map((r) => r.offer);
    const capture = offers.find((o) => o.kind === "todo.capture");
    expect(capture?.action).toEqual({
      tool: "todo_add",
      args: { text: "交报告", day: "tomorrow", at: "14:00", by: "moqi" },
    });
    // 07:00 has passed today: it stays a plain suggestion without a broken action.
    const past = offers.find((o) => o.title === "早上 7 点提醒你开会？");
    expect(past).toMatchObject({ kind: IDEA_KIND.serve });
    expect(past?.action).toBeUndefined();

    await moqi.feedback(capture?.id as string, "accepted");
    expect([...moqi.state.todos.values()].find((t) => t.text === "交报告")).toMatchObject({ by: "moqi" });
    expect(String(model.requests[0]?.messages[1]?.content)).toContain("## 用户的待办\n今天：\n- 买牛奶");
  });

  it("understands a bare idea or a bare list from a small model, and finds the article it meant", async () => {
    const replies = [
      JSON.stringify({ type: "world", title: "深圳明天暴雨，出门带伞", value: 0.8 }),
      `好的：[${JSON.stringify({ type: "ask", title: "你怕热吗？", value: 0.3 })}]`,
      JSON.stringify({ type: "world", title: "新品", value: 0.5, refs: "n2" }), // one ref, not a list
      JSON.stringify({ points: [{ type: "ask", question: "朵朵周末想去哪？", value: 0.5 }] }), // other names
    ];
    const model = scriptedModel(() => replies.shift() ?? ideas());
    const { moqi } = harness({ model, plugins: [world] });
    const [news] = await moqi.reflect();
    const offer = moqi.state.offers.get(news?.offerId ?? "")?.offer;
    expect(offer?.links).toEqual([{ title: "深圳明天暴雨", url: "https://example.com/rain" }]); // no refs: matched by text
    expect(offer?.urgency).toBe("whenever"); // news waits in the feed
    expect((await moqi.reflect()).map((i) => i.title)).toEqual(["你怕热吗？"]);
    const [phone] = await moqi.reflect();
    expect(moqi.state.offers.get(phone?.offerId ?? "")?.offer.links).toEqual([
      { title: "新款手机发布", url: "https://example.com/phone" },
    ]);
    expect((await moqi.reflect()).map((i) => i.title)).toEqual(["朵朵周末想去哪？"]);
  });

  it("asks for at least one question while it knows little about the user", async () => {
    const model = scriptedModel(() => ideas());
    const { moqi } = harness({ model });
    await moqi.reflect();
    expect(String(model.requests[0]?.messages[1]?.content)).toContain("这次至少出一个 ask");
    for (const c of ["住在深圳", "做产品", "女儿叫朵朵", "喜欢喝茶", "周末爬山"])
      moqi.remember({ kind: "basic", content: c });
    await moqi.reflect();
    expect(String(model.requests[1]?.messages[1]?.content)).not.toContain("这次至少出一个 ask");
  });

  it("keeps a suggestion whose action would not work, without the action", async () => {
    const model = scriptedModel(() =>
      ideas({
        type: "serve",
        title: "每天告诉你股价",
        value: 0.6,
        watch: { title: "股价", schedule: { every: "day", at: "09:30" }, tool: "stock_price" },
      }),
    );
    const { moqi } = harness({ model });
    await moqi.reflect();
    const offer = [...moqi.state.offers.values()][0]?.offer;
    expect(offer?.title).toBe("每天告诉你股价");
    expect(offer?.action).toBeUndefined();
    expect(offer?.urgency).toBe("whenever"); // not timely: it waits in the feed
  });

  it("does not repeat an idea, and asks at most two questions a day", async () => {
    const model = scriptedModel(() =>
      ideas(
        { type: "ask", title: "你喜欢喝茶还是咖啡？", value: 0.4 },
        { type: "ask", title: "周末一般做什么？", value: 0.4 },
        { type: "ask", title: "有养宠物吗？", value: 0.4 },
      ),
    );
    const { moqi, clock } = harness({ model });
    const first = await moqi.reflect();
    expect(first.map((i) => i.skipped ?? "ok")).toEqual(["ok", "ok", "今天问够了"]);
    expect(moqi.state.offeredOn(IDEA_KIND.ask, clock.now())).toBe(2);

    clock.advance(25 * HOUR); // a new day: the budget is back, but the same questions are not asked again
    const second = await moqi.reflect();
    expect(second.map((i) => i.skipped ?? "ok")).toEqual(["最近提过", "最近提过", "ok"]);
    expect(String(model.requests[1]?.messages[1]?.content)).toContain("你喜欢喝茶还是咖啡？：还没回应");
  });

  it("also skips an idea that is nearly one it just had", async () => {
    const titles = ["深圳小雨，记得带伞", "深圳小雨提醒", "朵朵周末去哪玩"];
    const model = scriptedModel(() => ideas({ type: "serve", title: titles.shift(), value: 0.6 }));
    const { moqi } = harness({ model });
    const skipped = [];
    for (let i = 0; i < 3; i++) skipped.push((await moqi.reflect())[0]?.skipped ?? "ok");
    expect(skipped).toEqual(["ok", "最近提过", "ok"]);
  });

  it("drops ideas of a kind the user turned off, and says why", async () => {
    const titles = ["新款手机发布", "火星探测器成功着陆"];
    const model = scriptedModel(() => ideas({ type: "world", title: titles.shift(), value: 0.8, refs: ["n2"] }));
    const { moqi, delivered } = harness({ model, plugins: [world] });
    const [first] = await moqi.reflect();
    expect(delivered).toHaveLength(1);
    await moqi.feedback(first?.offerId ?? "", "muted");
    const [second] = await moqi.reflect();
    expect(moqi.state.offers.get(second?.offerId ?? "")).toMatchObject({ dropped: true, reason: "你关掉了这类事" });
    expect(delivered).toHaveLength(1);
    expect(String(model.requests[1]?.messages[1]?.content)).toContain("关掉了：idea.world");
  });

  it("records a thought that failed, and the heartbeat goes on", async () => {
    const model = scriptedModel(() => {
      throw new Error("model is down");
    });
    const { moqi } = harness({ model, reflect: true });
    await moqi.tick();
    await moqi.idle();
    expect(moqi.state.thoughts.at(-1)).toMatchObject({ trigger: "timer", ideas: [], error: "model is down" });
  });

  it("thinks on its own every two hours and soon after a chat, never in quiet hours, one at a time", async () => {
    const model = scriptedModel((r) => (reflectRequest(r) ? ideas() : "好"));
    const { moqi, clock } = harness({ model, reflect: true, start: "2026-11-20T08:20:00+08:00" });
    const thoughts = () => moqi.state.thoughts.map((t) => t.trigger);

    await moqi.tick();
    await moqi.tick(); // the first one is still running or just done: not twice
    await moqi.idle();
    expect(thoughts()).toEqual(["timer"]);

    clock.advance(30 * MIN);
    await moqi.tick();
    await moqi.idle();
    expect(thoughts()).toEqual(["timer"]); // not yet

    await moqi.chat("我下周三去上海出差");
    clock.advance(REFLECT.afterChatMs);
    await moqi.tick();
    await moqi.idle();
    expect(thoughts()).toEqual(["timer", "chat"]); // the conversation settled

    clock.advance(REFLECT.everyMs);
    await moqi.tick();
    await moqi.idle();
    expect(thoughts()).toEqual(["timer", "chat", "timer"]);

    clock.set("2026-11-20T23:30:00+08:00");
    await moqi.tick();
    await moqi.idle();
    expect(thoughts()).toEqual(["timer", "chat", "timer"]); // the user is asleep
  });

  it("thinks once at a time, however many times it is asked", async () => {
    const model = scriptedModel(() => ideas());
    const { moqi } = harness({ model });
    await Promise.all([moqi.reflect(), moqi.reflect(), moqi.reflect()]);
    expect(model.requests).toHaveLength(1);
    expect(moqi.state.thoughts).toHaveLength(1);
    expect(moqi.isReflecting).toBe(false);
  });

  it("does not think without a model, or when turned off", async () => {
    const off = harness({ model: scriptedModel(() => ideas()), reflect: false });
    await off.moqi.tick();
    await off.moqi.idle();
    expect(off.moqi.state.thoughts).toEqual([]);
    const none = harness({ reflect: true });
    expect(await none.moqi.reflect()).toEqual([]);
  });

  it("learns from the user's answer to a question at once, and shows it as part of the conversation", async () => {
    const model = scriptedModel((r) => {
      if (reflectRequest(r)) return ideas({ type: "ask", title: "你一般几点下班？", value: 0.4 });
      return JSON.stringify({ facts: [{ kind: "routine", content: "一般晚上 7 点下班" }] });
    });
    const { moqi } = harness({ model });
    const [idea] = await moqi.reflect();
    const id = idea?.offerId ?? "";
    expect(await moqi.answer(id, "  ")).toBe("回答是空的");
    expect(await moqi.answer(id, "一般 7 点")).toBe("记下了，谢谢");
    await moqi.idle();
    expect([...moqi.state.facts.values()].map((f) => f.content)).toEqual(["一般晚上 7 点下班"]);
    const messages = moqi.store.all().flatMap((e) => (e.type === "message" ? [`${e.role}:${e.text}`] : []));
    expect(messages).toEqual(["assistant:你一般几点下班？", "user:一般 7 点"]);
    expect(moqi.state.offers.get(id)?.verdict).toBe("accepted");
    expect(await moqi.answer(id, "8 点")).toBe("这条已经处理过了");
  });
});
