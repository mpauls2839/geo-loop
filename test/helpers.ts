import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, type Config } from "../src/config.ts";
import type { EngineAdapter, EngineAnswer } from "../src/engines/index.ts";
import { Ledger } from "../src/lib/ledger.ts";

export function testConfig(over: Partial<Record<string, unknown>> = {}): Config {
  return ConfigSchema.parse({
    brand: { name: "Synta", domain: "synta.io", aliases: [] },
    site: { baseUrl: "https://synta.io" },
    positioning: { line: "n8n builds it. Synta keeps it running.", bannedPhrases: ["MCP layer"] },
    questions: [
      { id: "q1", text: "How do I keep n8n workflows reliable?", topic: "reliability" },
      { id: "q2", text: "n8n vs Kestra?", topic: "comparisons" },
    ],
    engines: [{ id: "claude" }, { id: "chatgpt" }, { id: "perplexity" }],
    ...over,
  });
}

export function tempLedger() {
  const dir = mkdtempSync(join(tmpdir(), "geo-loop-test-"));
  return new Ledger(join(dir, "ledger.db"));
}

export function fakeEngine(id: EngineAdapter["id"], answer: (q: string, n: number) => EngineAnswer | Error): EngineAdapter {
  let n = 0;
  return {
    id,
    model: `${id}-fixture`,
    via: "direct",
    async ask(q) {
      const r = answer(q, n++);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

export const ans = (text: string, urls: string[]): EngineAnswer => ({ text, citedUrls: urls, costUsd: 0.01, model: "fixture" });
