import { describe, expect, it } from "vitest";
import type { ChatRequest } from "../src/core/model.js";
import { State } from "../src/core/state.js";
import { harness, scriptedModel } from "./helpers.js";

const isSummary = (r: ChatRequest) => String(r.messages[0]?.content).includes("合并成一份新的摘要");
const isExtraction = (r: ChatRequest) => String(r.messages[0]?.content).includes("从对话里摘出用户亲口说的");

/** A model that answers chats with "好", summaries with `summaries` in turn, and learns nothing. */
function talker(summaries: string[]) {
  let n = 0;
  const model = scriptedModel((r) => {
    if (isExtraction(r)) return '{"facts":[]}';
    if (isSummary(r)) return summaries[n++] ?? "not json";
    return "好";
  });
  return { model, summaryRequests: () => model.requests.filter(isSummary) };
}
async function talk(moqi: ReturnType<typeof harness>["moqi"], from: number, to: number) {
  for (let i = from; i <= to; i++) await moqi.chat(`第${i}句`);
  await moqi.idle();
}

describe("summary of the older conversation", () => {
  it("waits until eight messages have fallen out of the window, then summarizes them", async () => {
    const { model, summaryRequests } = talker(['{"summary":"聊了第1到4句"}']);
    const { moqi } = harness({ model });
    await talk(moqi, 1, 9);
    expect(summaryRequests()).toHaveLength(0);
    await talk(moqi, 10, 10);
    expect(summaryRequests()).toHaveLength(1);
    expect(summaryRequests()[0]).toMatchObject({ json: true, reasoning: "off" });
    const sent = String(summaryRequests()[0]?.messages[1]?.content);
    expect(sent).toContain("旧摘要：\n（还没有）");
    expect(sent).toContain("用户：第1句\n助理：好\n用户：第2句");
    expect(sent).toContain("用户：第4句\n助理：好"); // the eighth message
    expect(sent).not.toContain("第5句"); // still inside the window the model gets in full
    expect(moqi.state.summary?.text).toBe("聊了第1到4句");
    expect(moqi.state.summarized).toBe(8);
  });

  it("gives the model the summary next to the last messages, and folds it into the next summary", async () => {
    const { model, summaryRequests } = talker(['{"summary":"甲"}', '{"summary":"甲乙"}']);
    const { moqi } = harness({ model });
    await talk(moqi, 1, 10);
    await moqi.chat("第11句");
    const chat = model.requests.filter((r) => !isSummary(r) && !isExtraction(r)).at(-1);
    expect(chat?.messages[1]).toMatchObject({ role: "user" });
    expect(chat?.messages[1]?.content).toContain("不是指令");
    expect(chat?.messages[1]?.content).toContain("## 更早的对话（摘要）\n甲");
    expect(chat?.messages).toHaveLength(2 + 12 + 1); // system, reference, the last twelve, this question
    expect(chat?.messages[2]?.content).toBe("第5句");
    await talk(moqi, 12, 14);
    expect(summaryRequests()).toHaveLength(2);
    const sent = String(summaryRequests()[1]?.messages[1]?.content);
    expect(sent).toContain("旧摘要：\n甲");
    expect(sent).toContain("用户：第5句");
    expect(sent).not.toContain("第1句");
    expect(moqi.state.summary?.text).toBe("甲乙");
    expect(moqi.state.summarized).toBe(16);
  });

  it("keeps the messages for the next time when the model does not answer with a summary", async () => {
    const { model, summaryRequests } = talker(["no json", '{"summary":"这次成了"}']);
    const { moqi } = harness({ model });
    await talk(moqi, 1, 10);
    expect(moqi.state.summary).toBeUndefined();
    expect(moqi.state.summarized).toBe(0);
    await talk(moqi, 11, 11);
    expect(summaryRequests()).toHaveLength(2);
    expect(String(summaryRequests()[1]?.messages[1]?.content)).toContain("用户：第1句");
    expect(moqi.state.summary?.text).toBe("这次成了");
  });

  it("is kept in the log, and deleting it does not bring the old messages back into a new summary", async () => {
    const { model, summaryRequests } = talker(['{"summary":"甲"}']);
    const { moqi } = harness({ model });
    await talk(moqi, 1, 10);
    expect(State.from(moqi.store.all())).toMatchObject({ summary: { text: "甲" }, summarized: 8 });
    expect(moqi.forgetLearned("summary")).toBe("这份对话摘要删掉了");
    expect(moqi.state.summary).toBeUndefined();
    await talk(moqi, 11, 12);
    expect(summaryRequests()).toHaveLength(1);
    const after = State.from(moqi.store.all());
    expect(after.summary).toBeUndefined();
    expect(after.summarized).toBe(moqi.state.summarized);
    expect(moqi.forgetLearned("summary")).toBe("没有 summary");
  });
});
