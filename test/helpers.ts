import { type ChatMessage, type LLMModel, type LLMRequest, type LLMResponse, textOf } from "taugraph/nodes";
import { Moqi, type MoqiOptions } from "../src/core/moqi.js";
import type { Answer, Clock, Offer, Surface } from "../src/core/types.js";

/** Tests run with TZ=Asia/Shanghai, so local times below are Beijing time. */
export function fakeClock(start = "2026-11-20T08:20:00+08:00") {
  let t = Date.parse(start);
  const clock: Clock & { set(iso: string): void; advance(ms: number): void } = {
    now: () => t,
    set: (iso) => {
      t = Date.parse(iso);
    },
    advance: (ms) => {
      t += ms;
    },
  };
  return clock;
}

/** A 32×32 solid red PNG. */
export const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC",
  "base64",
);

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export type Script = (request: LLMRequest) => LLMResponse | string;

export function scriptedModel(script: Script): LLMModel & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    id: "scripted",
    requests,
    async complete(request) {
      requests.push(request);
      const r = script(request);
      return typeof r === "string" ? { content: r } : r;
    },
  };
}

export function call(name: string, args: Record<string, unknown>, id = `c_${name}`): LLMResponse {
  return { content: "", toolCalls: [{ id, name, arguments: args }] };
}

/** The words of a message, images left out. */
export const words = (m: ChatMessage | undefined): string => (m ? textOf(m.content, { imagePlaceholder: "" }) : "");

export interface Harness {
  moqi: Moqi;
  clock: ReturnType<typeof fakeClock>;
  delivered: { offer: Offer; surface: Surface }[];
  asked: string[];
  details: (string | undefined)[];
}

export function harness(
  options: Partial<MoqiOptions> & { answer?: Answer | ((q: string) => Answer); start?: string } = {},
): Harness {
  const clock = fakeClock(options.start);
  const delivered: Harness["delivered"] = [];
  const asked: string[] = [];
  const details: Harness["details"] = [];
  const answer = options.answer ?? true;
  const moqi = new Moqi({
    clock,
    briefingAt: null,
    reflect: false, // reflection has its own tests; elsewhere it would consume scripted replies
    study: false,
    deliver: (offer, surface) => void delivered.push({ offer, surface }),
    confirm: async (q, d) => {
      asked.push(q);
      details.push(d);
      return typeof answer === "function" ? answer(q) : answer;
    },
    ...options,
  });
  return { moqi, clock, delivered, asked, details };
}
