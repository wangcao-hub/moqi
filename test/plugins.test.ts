import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/core/plugin.js";
import { calendarPlugin, parseIcs } from "../src/plugins/calendar.js";
import { describeWeather, fetchForecast, weatherPlugin } from "../src/plugins/weather.js";
import { harness } from "./helpers.js";

describe("plugin tools", () => {
  it("refuses at startup a tool name the model providers do not accept", () => {
    const bad = defineTool({
      name: "bad name",
      description: "A tool with a space in its name",
      input: z.object({}),
      effect: "read",
      run: () => "x",
    });
    expect(() => harness({ plugins: [{ name: "broken", tools: [bad] }] })).toThrow(
      'Tool name "bad name" must match ^[A-Za-z0-9_-]{1,64}$',
    );
  });
});

const ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:a",
  "DTSTART;TZID=Asia/Shanghai:20261120T093000",
  "DTEND;TZID=Asia/Shanghai:20261120T103000",
  "SUMMARY:周会\\, 产品",
  "LOCATION:3 号会议",
  " 室",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:b",
  "DTSTART;VALUE=DATE:20261120",
  "SUMMARY:朵朵生日",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:c",
  "DTSTART:20261120T060000Z",
  "SUMMARY:和美国同事通话",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:d",
  "DTSTART:20261121T080000",
  "RRULE:FREQ=DAILY",
  "SUMMARY:每天晨跑",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("calendar (.ics)", () => {
  it("parses timed, all-day and UTC events, folded lines and escapes; skips repeats", () => {
    const events = parseIcs(ICS);
    expect(events.map((e) => [e.uid, new Date(e.start).toISOString(), e.allDay, e.summary])).toEqual([
      ["b", "2026-11-19T16:00:00.000Z", true, "朵朵生日"],
      ["a", "2026-11-20T01:30:00.000Z", false, "周会, 产品"],
      ["c", "2026-11-20T06:00:00.000Z", false, "和美国同事通话"],
    ]);
    expect(events[1]?.location).toBe("3 号会议室");
  });

  it("adds today's events to the briefing and warns 30 minutes before, once", async () => {
    const { moqi, clock, delivered } = harness({
      plugins: [calendarPlugin({ load: () => ICS })],
      start: "2026-11-20T08:50:00+08:00",
    });
    expect((await moqi.briefing()).body).toContain("【今天的日程】\n· 全天 朵朵生日\n· 09:30 周会, 产品（3 号会议室）");
    await moqi.tick();
    expect(delivered.filter((d) => d.offer.kind === "calendar.soon")).toHaveLength(0);
    clock.set("2026-11-20T09:05:00+08:00");
    await moqi.tick();
    await moqi.tick();
    const soon = delivered.filter((d) => d.offer.kind === "calendar.soon");
    expect(soon).toHaveLength(1);
    expect(soon[0]).toMatchObject({
      surface: "notify",
      offer: { title: "09:30 周会, 产品", body: "25 分钟后开始，在3 号会议室" },
    });
  });
});

function fakeForecast(rainTomorrow: number, places: Record<string, { latitude: number; longitude: number }> = {}) {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(String(url));
    if (String(url).includes("geocoding-api")) {
      const name = new URL(String(url)).searchParams.get("name") ?? "";
      const hit = places[name];
      return new Response(JSON.stringify(hit ? { results: [{ name, ...hit }] } : {}));
    }
    return new Response(
      JSON.stringify({
        daily: {
          time: ["2026-11-20", "2026-11-21"],
          weather_code: [2, 63],
          temperature_2m_max: [8, 6],
          temperature_2m_min: [-1, 2],
          precipitation_probability_max: [0, rainTomorrow],
        },
      }),
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("weather (Open-Meteo)", () => {
  const place = { latitude: 39.9, longitude: 116.4, place: "北京" };

  it("reads the forecast and describes it", async () => {
    const f = fakeForecast(80);
    const [today, tomorrow] = await fetchForecast({ ...place, fetch: f.fetch });
    expect(f.calls[0]).toContain("latitude=39.9&longitude=116.4");
    expect(describeWeather(today as never, "北京", "今天")).toBe("北京今天多云，-1~8°C，降水概率 0%");
    expect(tomorrow?.code).toBe(63);
  });

  it("is a tool that watches can compare", async () => {
    const f = fakeForecast(80);
    const { moqi } = harness({ plugins: [weatherPlugin({ ...place, fetch: f.fetch })] });
    expect(await moqi.callTool("weather", { day: "tomorrow" }, { byUser: true })).toBe(
      "北京明天中雨，2~6°C，降水概率 80%",
    );
  });

  it("warns about rain tomorrow in the evening, unasked and once", async () => {
    const f = fakeForecast(80);
    const { moqi, clock, delivered } = harness({
      plugins: [weatherPlugin({ ...place, fetch: f.fetch })],
      start: "2026-11-20T19:00:00+08:00",
    });
    await moqi.tick();
    expect(delivered).toHaveLength(0);
    clock.set("2026-11-20T20:10:00+08:00");
    await moqi.tick();
    await moqi.tick();
    expect(delivered.map((d) => [d.surface, d.offer.title])).toEqual([["notify", "明天记得带伞"]]);
  });

  it("looks a city up when asked about one, once per name, and says when it cannot find it", async () => {
    const f = fakeForecast(80, { 南京: { latitude: 32.06, longitude: 118.78 } });
    const { moqi } = harness({ plugins: [weatherPlugin({ ...place, fetch: f.fetch })] });
    expect(await moqi.callTool("weather", { day: "tomorrow", place: "南京" }, { byUser: true })).toBe(
      "南京明天中雨，2~6°C，降水概率 80%",
    );
    await moqi.callTool("weather", { day: "today", place: "南京" }, { byUser: true });
    expect(f.calls.filter((u) => u.includes("geocoding")).length).toBe(1);
    expect(f.calls.some((u) => u.includes("latitude=32.06&longitude=118.78"))).toBe(true);
    expect(await moqi.callTool("weather", { place: "火星" }, { byUser: true })).toBe("出错了：找不到「火星」这个地方");
  });

  it("works without a place of its own, asking for a city instead of guessing one", async () => {
    const f = fakeForecast(80);
    const { moqi } = harness({ plugins: [weatherPlugin({ fetch: f.fetch })] });
    expect(await moqi.callTool("weather", {}, { byUser: true })).toBe(
      "出错了：还没设天气地点：告诉我城市，或者在设置里搜一下",
    );
    expect((await moqi.briefing()).body).not.toContain("天气");
  });

  it("offers once to follow the city the user lives in, and saves it when accepted", async () => {
    const f = fakeForecast(10, { 南京: { latitude: 32.06, longitude: 118.78 } });
    const saved: unknown[] = [];
    const { moqi, delivered } = harness({
      plugins: [weatherPlugin({ ...place, fetch: f.fetch, save: (w) => void saved.push(w) })],
    });
    moqi.remember({ kind: "basic", content: "住在南京市江宁区" });
    await moqi.tick();
    await moqi.tick();
    const offers = delivered.filter((d) => d.offer.kind === "weather.place");
    expect(offers.map((d) => d.offer)).toMatchObject([
      {
        title: "天气要改成南京吗？",
        body: "你说过住在南京，天气现在设的是北京。",
        action: { tool: "weather_use_place", args: { place: "南京" } },
      },
    ]);
    expect(await moqi.feedback(offers[0]?.offer.id ?? "", "accepted")).toBe("好，天气改成南京了");
    expect(saved).toEqual([{ latitude: 32.06, longitude: 118.78, place: "南京" }]);
  });

  it("stays quiet when the place it has is where the user lives", async () => {
    const f = fakeForecast(10);
    const { moqi, delivered } = harness({ plugins: [weatherPlugin({ ...place, fetch: f.fetch })] });
    moqi.remember({ kind: "basic", content: "住在北京朝阳" });
    await moqi.tick();
    expect(delivered.filter((d) => d.offer.kind === "weather.place")).toEqual([]);
  });

  it("offers a place when it has none yet", async () => {
    const f = fakeForecast(10, { 深圳: { latitude: 22.54, longitude: 114.06 } });
    const { moqi, delivered } = harness({ plugins: [weatherPlugin({ fetch: f.fetch })] });
    moqi.remember({ kind: "basic", content: "住在深圳南山" });
    await moqi.tick();
    expect(delivered.find((d) => d.offer.kind === "weather.place")?.offer).toMatchObject({
      title: "天气要改成深圳吗？",
      body: "你说过住在深圳，天气还没设地点。",
    });
  });

  it("says nothing when tomorrow is dry", async () => {
    const f = fakeForecast(10);
    const { moqi, delivered } = harness({
      plugins: [weatherPlugin({ ...place, fetch: f.fetch })],
      start: "2026-11-20T20:10:00+08:00",
    });
    await moqi.tick();
    expect(delivered).toHaveLength(0);
  });
});
