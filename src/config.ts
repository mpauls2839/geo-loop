import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const Question = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  topic: z.string().default("general"),
  source: z.enum(["seed", "persona", "gsc", "engine", "autocomplete", "thread", "mixed"]).default("seed"),
  evidence: z.string().optional(),
});

/**
 * questions.json (next to the config): where questions come from.
 * - user: only the questions you write (config `questions` and/or this file's `core`)
 * - data: `geo-loop questions suggest --write` fills `core` once from real search data (then frozen,
 *   so weekly trends stay comparable) and refreshes `explore` every run
 * - hybrid: your `core`, data-driven `explore`
 */
export const QuestionsFileSchema = z.object({
  mode: z.enum(["user", "data", "hybrid"]).default("user"),
  seedTerms: z.array(z.string()).optional(), // used when config.discovery.seedTerms is empty
  updatedAt: z.string().optional(),
  core: z.array(Question).default([]),
  explore: z.array(Question).default([]),
});
export type QuestionsFile = z.infer<typeof QuestionsFileSchema>;

const Engine = z.object({
  id: z.enum(["claude", "chatgpt", "perplexity"]),
  model: z.string().optional(),
  enabled: z.boolean().default(true),
  rpm: z.number().positive().optional(), // requests per minute cap (e.g. 5 on a free AI Gateway tier)
  concurrency: z.number().int().min(1).optional(),
});

export const ConfigSchema = z.object({
  brand: z.object({
    name: z.string().min(1),
    domain: z.string().min(1), // registered domain, e.g. "synta.io"
    aliases: z.array(z.string()).default([]),
  }),
  site: z.object({
    baseUrl: z.string().url(),
    blogPath: z.string().default("/blog/"),
  }),
  positioning: z
    .object({
      line: z.string().optional(),
      bannedPhrases: z.array(z.string()).default([]),
    })
    .default({ bannedPhrases: [] }),
  productFactsFile: z.string().optional(),
  questions: z.array(Question).default([]),
  questionsFile: z.string().default("questions.json"),
  discovery: z
    .object({
      seedTerms: z.array(z.string()).default([]), // category terms for autocomplete, e.g. ["n8n"]
      gscSiteUrl: z.string().optional(), // e.g. "sc-domain:example.com"; GSC_SITE_URL also works
      coreSize: z.number().int().min(1).default(20),
      exploreSize: z.number().int().min(0).default(10),
      sources: z.array(z.enum(["gsc", "engine", "autocomplete", "thread"])).default(["gsc", "engine", "autocomplete", "thread"]),
    })
    .default({ seedTerms: [], coreSize: 20, exploreSize: 10, sources: ["gsc", "engine", "autocomplete", "thread"] }),
  competitors: z.record(z.string(), z.array(z.string().url())).default({}),
  engines: z.array(Engine).default([{ id: "claude" }, { id: "chatgpt" }, { id: "perplexity" }] as never),
  judge: z
    .object({
      // auto: Anthropic key, else OpenAI-compatible key, else AI Gateway.
      // external: no API calls; `eval --prepare` writes prompts for a host agent, `eval --answers` scores them.
      provider: z.enum(["auto", "anthropic", "openai", "gateway", "external"]).default("auto"),
      model: z.string().default("claude-opus-5-5"),
      k: z.number().int().min(1).default(10),
    })
    .default({ provider: "auto", model: "claude-opus-5-5", k: 10 }),
  probe: z
    .object({
      samples: z.number().int().min(1).default(3),
      budgetUsd: z.number().positive().default(5),
      maxRetries: z.number().int().min(0).default(2),
    })
    .default({ samples: 3, budgetUsd: 5, maxRetries: 2 }),
  caps: z
    .object({
      newPosts: z.number().int().min(0).default(1),
      refreshes: z.number().int().min(0).default(2),
      codePrs: z.number().int().min(0).default(1),
      offsiteDrafts: z.number().int().min(0).default(5),
    })
    .default({ newPosts: 1, refreshes: 2, codePrs: 1, offsiteDrafts: 5 }),
  gates: z
    .object({
      refreshDeltaPts: z.number().default(20),
      newPostMinWinRate: z.number().min(0).max(1).default(0.4),
      headingKeepRatio: z.number().min(0).max(1).default(0.7),
      cooldownDays: z.number().int().default(14),
      dupSimilarity: z.number().min(0).max(1).default(0.85),
      maxUntestedTechniquesPerDay: z.number().int().default(1),
      minUsesToAdjust: z.number().int().default(5),
      threadMaxAgeDays: z.number().int().default(365),
    })
    .default({
      refreshDeltaPts: 20,
      newPostMinWinRate: 0.4,
      headingKeepRatio: 0.7,
      cooldownDays: 14,
      dupSimilarity: 0.85,
      maxUntestedTechniquesPerDay: 1,
      minUsesToAdjust: 5,
      threadMaxAgeDays: 365,
    }),
  sanity: z
    .object({
      projectId: z.string(),
      dataset: z.string().default("production"),
      testDataset: z.string().default("geo-loop-test"),
      postType: z.string().default("post"),
      apiVersion: z.string().default("2025-02-19"),
    })
    .optional(),
  github: z
    .object({
      repo: z.string(), // owner/name
      baseBranch: z.string().default("main"),
      allowlist: z.array(z.string()).default([]),
    })
    .optional(),
  aiReferrers: z
    .array(z.string())
    .default(["chatgpt.com", "chat.openai.com", "perplexity.ai", "claude.ai", "gemini.google.com", "copilot.microsoft.com"]),
  // "dry_run": ship runs gates and prints payloads but writes nothing. Flip to "live" once reviewed.
  shipMode: z.enum(["live", "dry_run"]).default("live"),
  dataDir: z.string().default(".geo-loop"),
});

export type Config = z.infer<typeof ConfigSchema>;
export type QuestionT = z.infer<typeof Question>;
export type EngineConfig = z.infer<typeof Engine>;

const CANDIDATES = ["geo-loop.config.ts", "geo-loop.config.mjs", "geo-loop.config.js", "geo-loop.config.json"];

export function defineConfig(c: z.input<typeof ConfigSchema>) {
  return c;
}

export async function loadConfig(
  path?: string,
  cwd = process.cwd(),
  opts: { allowNoQuestions?: boolean } = {},
): Promise<{ config: Config; path: string; questionsFile: QuestionsFile | null }> {
  const file = path ? resolve(cwd, path) : CANDIDATES.map((c) => resolve(cwd, c)).find((p) => existsSync(p));
  if (!file || !existsSync(file)) throw new ConfigError(`No config found. Looked for ${path ?? CANDIDATES.join(", ")} in ${cwd}`);
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const raw = (await jiti.import(file, { default: true })) as unknown;
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new ConfigError(`Invalid config ${file}:\n${msg}`);
  }
  const config = parsed.data;
  const qfPath = resolve(dirname(file), config.questionsFile);
  let questionsFile: QuestionsFile | null = null;
  if (existsSync(qfPath)) {
    const q = QuestionsFileSchema.safeParse(JSON.parse(readFileSync(qfPath, "utf8")));
    if (!q.success) throw new ConfigError(`Invalid ${qfPath}: ${q.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
    questionsFile = q.data;
    if (!config.discovery.seedTerms.length && q.data.seedTerms?.length) config.discovery.seedTerms = q.data.seedTerms;
    const seen = new Set(config.questions.map((x) => x.id));
    for (const x of [...q.data.core, ...q.data.explore]) if (!seen.has(x.id)) (config.questions.push(x), seen.add(x.id));
  }
  if (!config.questions.length && !opts.allowNoQuestions) {
    throw new ConfigError(`Invalid config ${file}:\n  questions: config needs at least one question (write them in the config or ${config.questionsFile}, or run \`geo-loop questions suggest --write\`)`);
  }
  return { config, path: file, questionsFile };
}

export class ConfigError extends Error {}
