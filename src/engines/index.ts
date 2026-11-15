import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createPerplexity } from "@ai-sdk/perplexity";
import { gateway, generateText } from "ai";
import type { EngineConfig } from "../config.js";

// Each engine answers a buyer question with web search on and returns the URLs it cited.
// Auth: the provider's own key if set, otherwise AI_GATEWAY_API_KEY through Vercel AI Gateway,
// which exposes the native Anthropic Messages and OpenAI Responses APIs.

export type EngineAnswer = { text: string; citedUrls: string[]; costUsd: number; model: string };
export interface EngineAdapter {
  id: EngineConfig["id"];
  model: string;
  via: "direct" | "gateway";
  ask(question: string): Promise<EngineAnswer>;
}

const GATEWAY_BASE = "https://ai-gateway.vercel.sh";
const DEFAULT_MODELS = { claude: "claude-opus-5-5", chatgpt: "gpt-5.4-mini", perplexity: "sonar" } as const;
const ENV_KEYS = { claude: "ANTHROPIC_API_KEY", chatgpt: "OPENAI_API_KEY", perplexity: "PERPLEXITY_API_KEY" } as const;
const GATEWAY_PREFIX = { claude: "anthropic", chatgpt: "openai", perplexity: "perplexity" } as const;

// Rough per-call cost estimates (USD) for budget tracking; real billing lives with the provider.
const EST_COST = { claude: 0.05, chatgpt: 0.03, perplexity: 0.01 } as const;

export class EngineAuthError extends Error {}

export function resolveAuth(id: EngineConfig["id"], env = process.env) {
  if (env[ENV_KEYS[id]]) return { via: "direct" as const, key: env[ENV_KEYS[id]]! };
  if (env.AI_GATEWAY_API_KEY) return { via: "gateway" as const, key: env.AI_GATEWAY_API_KEY };
  return null;
}

export function expectedEnv(id: EngineConfig["id"]) {
  return `${ENV_KEYS[id]} or AI_GATEWAY_API_KEY`;
}

export function createEngine(cfg: EngineConfig, env = process.env): EngineAdapter {
  const auth = resolveAuth(cfg.id, env);
  if (!auth) throw new EngineAuthError(`engine ${cfg.id}: no key (expected ${expectedEnv(cfg.id)})`);
  const base = cfg.model ?? DEFAULT_MODELS[cfg.id];
  const model = auth.via === "gateway" && !base.includes("/") ? `${GATEWAY_PREFIX[cfg.id]}/${base}` : base;
  switch (cfg.id) {
    case "claude":
      return claudeEngine(model, auth);
    case "chatgpt":
      return chatgptEngine(model, auth);
    case "perplexity":
      return perplexityEngine(model, auth);
  }
}

const SYSTEM =
  "You are answering a user's question the way an AI assistant with web search would. Search the web, " +
  "recommend specific tools or resources where relevant, and cite your sources.";

function claudeEngine(model: string, auth: { via: "direct" | "gateway"; key: string }): EngineAdapter {
  const client = new Anthropic({ apiKey: auth.key, ...(auth.via === "gateway" ? { baseURL: GATEWAY_BASE } : {}) });
  // The gateway documents the basic search tool; direct calls get the dynamic-filtering version.
  const toolType = auth.via === "gateway" ? "web_search_20250305" : "web_search_20260209";
  return {
    id: "claude",
    model,
    via: auth.via,
    async ask(question) {
      const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: question }];
      const content: Anthropic.Messages.ContentBlock[] = [];
      // Server-side search loops can pause mid-turn; resend to let Claude finish (bounded).
      for (let turn = 0; turn < 4; turn++) {
        const res = await client.messages.stream({
          model,
          max_tokens: 16000,
          system: SYSTEM,
          tools: [{ type: toolType, name: "web_search", max_uses: 8 } as Anthropic.Messages.ToolUnion],
          messages,
        }).finalMessage();
        if (res.stop_reason === "refusal") throw new Error("claude refused the question");
        content.push(...res.content);
        if (res.stop_reason !== "pause_turn") break;
        messages.push({ role: "assistant", content: res.content });
      }
      const searchErrors = content.flatMap((b) =>
        b.type === "web_search_tool_result" && !Array.isArray(b.content) ? [b.content.error_code] : [],
      );
      const searched = content.some((b) => b.type === "web_search_tool_result" && Array.isArray(b.content));
      if (!searched && searchErrors.length) throw new Error(`web search failed: ${searchErrors.join(", ")}`);
      let text = "";
      const cited: string[] = [];
      for (const block of content) {
        if (block.type !== "text") continue;
        text += block.text;
        for (const c of block.citations ?? []) {
          if (c.type === "web_search_result_location") cited.push(c.url);
        }
      }
      return { text, citedUrls: dedupe(cited), costUsd: EST_COST.claude, model };
    },
  };
}

function chatgptEngine(model: string, auth: { via: "direct" | "gateway"; key: string }): EngineAdapter {
  const client = new OpenAI({ apiKey: auth.key, ...(auth.via === "gateway" ? { baseURL: `${GATEWAY_BASE}/v1` } : {}) });
  return {
    id: "chatgpt",
    model,
    via: auth.via,
    async ask(question) {
      const res = await client.responses.create({
        model,
        instructions: SYSTEM,
        tools: [{ type: "web_search" }],
        input: question,
      });
      const cited: string[] = [];
      for (const item of res.output ?? []) {
        if (item.type !== "message") continue;
        for (const part of item.content) {
          if (part.type !== "output_text") continue;
          for (const a of part.annotations ?? []) if (a.type === "url_citation") cited.push(a.url);
        }
      }
      return { text: res.output_text ?? "", citedUrls: dedupe(cited), costUsd: EST_COST.chatgpt, model };
    },
  };
}

function perplexityEngine(model: string, auth: { via: "direct" | "gateway"; key: string }): EngineAdapter {
  const lm =
    auth.via === "direct" ? createPerplexity({ apiKey: auth.key })(model) : gateway(model);
  return {
    id: "perplexity",
    model,
    via: auth.via,
    async ask(question) {
      const res = await generateText({ model: lm, system: SYSTEM, prompt: question });
      const cited = res.sources.flatMap((s) => (s.sourceType === "url" ? [s.url] : []));
      return { text: res.text, citedUrls: dedupe(cited), costUsd: EST_COST.perplexity, model };
    },
  };
}

function dedupe(xs: string[]) {
  return [...new Set(xs)];
}
