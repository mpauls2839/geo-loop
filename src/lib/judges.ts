import { createHash } from "node:crypto";
import OpenAI from "openai";
import { gateway, generateText } from "ai";
import type { Config } from "../config.js";
import { claude } from "./claude.js";
import { claudeJudge, JUDGE_SYSTEM, judgePrompt, type JudgeFn, type LabeledPage } from "./judge.js";
import type { PageLoader, PageText } from "./page.js";

// Judge backends. The eval only needs a JudgeFn; where the answer comes from is configurable so the
// open-source CLI works with any model: Anthropic, any OpenAI-compatible endpoint (OpenAI, OpenRouter,
// Ollama, LM Studio, vLLM via OPENAI_BASE_URL), the Vercel AI Gateway, or an external host agent.

export type JudgeProvider = "anthropic" | "openai" | "gateway";

export function resolveJudgeProvider(config: Config, env = process.env): JudgeProvider | "external" {
  const p = config.judge.provider;
  if (p !== "auto") return p;
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.OPENAI_API_KEY) return "openai";
  if (env.AI_GATEWAY_API_KEY) return "gateway";
  throw new Error("no judge credentials: set ANTHROPIC_API_KEY, OPENAI_API_KEY (+ OPENAI_BASE_URL for other endpoints) or AI_GATEWAY_API_KEY, or use judge.provider \"external\"");
}

export function judgeFromConfig(config: Config, env = process.env): JudgeFn {
  const provider = resolveJudgeProvider(config, env);
  const model = config.judge.model;
  switch (provider) {
    case "anthropic":
      return claudeJudge(config, claude({ ...env, AI_GATEWAY_API_KEY: undefined }));
    case "openai": {
      const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL || "https://api.openai.com/v1" });
      return async (question, pages) => {
        const res = await client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: JUDGE_SYSTEM },
            { role: "user", content: judgePrompt(question, pages) },
          ],
        });
        return res.choices[0]?.message?.content ?? "";
      };
    }
    case "gateway":
      return async (question, pages) => {
        const res = await generateText({
          model: gateway(model.includes("/") ? model : `anthropic/${model}`),
          system: JUDGE_SYSTEM,
          prompt: judgePrompt(question, pages),
        });
        return res.text;
      };
    case "external":
      throw new Error('judge.provider is "external": run `geo-loop eval --prepare <job.json>`, have an agent fill in the answers, then `geo-loop eval --answers <job.json>`');
  }
}

// ---------- external judge: two-pass record / replay ----------

export type JudgeJobCall = { id: string; question: string; system: string; prompt: string; labels: string[]; answer: string };
export type JudgeJob = {
  version: 1;
  seed: number;
  page: string;
  draft?: { id: string; body: string };
  questionIds: string[];
  date: string;
  pages: Record<string, PageText | { error: string }>;
  calls: JudgeJobCall[];
  instructions: string;
};

export const JOB_INSTRUCTIONS =
  "Answer each call independently, as the judge. For every entry in `calls`, read `system` and `prompt` and set " +
  "`answer` to the single letter of the page you would cite (one of `labels`). Use a fresh sub-agent with no other " +
  "context (no repo, no knowledge of which page is whose), ideally one per question. Do not change anything else.";

export const callId = (question: string, pages: LabeledPage[]) =>
  createHash("sha256").update(question).update("\u0000").update(judgePrompt(question, pages)).digest("hex").slice(0, 16);

/** Pass 1: records every prompt and returns no answer (the eval's own results are discarded). */
export function recordingJudge(calls: JudgeJobCall[]): JudgeFn {
  return async (question, pages) => {
    const id = callId(question, pages);
    if (!calls.some((c) => c.id === id)) {
      calls.push({ id, question, system: JUDGE_SYSTEM, prompt: judgePrompt(question, pages), labels: pages.map((p) => p.label), answer: "" });
    }
    return "";
  };
}

/** Pass 2: answers each call from the job file; a call that isn't there fails loudly. */
export function replayJudge(job: JudgeJob): JudgeFn {
  const answers = new Map(job.calls.map((c) => [c.id, c.answer]));
  return async (question, pages) => {
    const id = callId(question, pages);
    if (!answers.has(id)) throw new Error(`judge job has no call ${id}: the page set changed since --prepare`);
    return answers.get(id) ?? "";
  };
}

/** Pass 1 records fetched pages; pass 2 serves the same content so prompts match exactly. */
export function recordingLoader(inner: PageLoader, store: JudgeJob["pages"]): PageLoader {
  return async (url) => {
    try {
      const p = await inner(url);
      store[url] = p;
      return p;
    } catch (err) {
      store[url] = { error: (err as Error).message };
      throw err;
    }
  };
}

export function replayLoader(store: JudgeJob["pages"]): PageLoader {
  return async (url) => {
    const p = store[url];
    if (!p) throw new Error(`page not in judge job: ${url}`);
    if ("error" in p) throw new Error(p.error);
    return p;
  };
}

export function unansweredCalls(job: JudgeJob) {
  return job.calls.filter((c) => !c.labels.includes(c.answer.trim().replace(/[^A-Z]/gi, "").toUpperCase().slice(0, 1)));
}
