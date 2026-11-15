import Anthropic from "@anthropic-ai/sdk";

const GATEWAY_BASE = "https://ai-gateway.vercel.sh";

export type ClaudeHandle = { client: Anthropic; model: (m: string) => string; via: "direct" | "gateway" };

/**
 * Claude client for judgment calls (eval judge, drafting). Uses ANTHROPIC_API_KEY when set,
 * otherwise AI_GATEWAY_API_KEY through Vercel AI Gateway's Anthropic Messages endpoint,
 * where model ids carry an "anthropic/" prefix.
 */
export function claude(env = process.env): ClaudeHandle {
  if (env.ANTHROPIC_API_KEY) {
    return { client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }), model: (m) => m, via: "direct" };
  }
  if (env.AI_GATEWAY_API_KEY) {
    return {
      client: new Anthropic({ apiKey: env.AI_GATEWAY_API_KEY, baseURL: GATEWAY_BASE }),
      model: (m) => (m.includes("/") ? m : `anthropic/${m}`),
      via: "gateway",
    };
  }
  throw new Error("no Claude credentials: set ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY");
}

/** Plain text from a Messages response; throws on refusal so callers never treat it as an answer. */
export function textOf(res: Anthropic.Messages.Message): string {
  if (res.stop_reason === "refusal") throw new Error("claude refused");
  return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}
