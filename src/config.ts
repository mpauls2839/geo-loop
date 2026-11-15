import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const Question = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  topic: z.string().default("general"),
  source: z.enum(["seed", "persona", "gsc"]).default("seed"),
});

const Engine = z.object({
  id: z.enum(["claude", "chatgpt", "perplexity"]),
  model: z.string().optional(),
  enabled: z.boolean().default(true),
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
  questions: z.array(Question).min(1, "config needs at least one question"),
  competitors: z.record(z.string(), z.array(z.string().url())).default({}),
  engines: z.array(Engine).default([{ id: "claude" }, { id: "chatgpt" }, { id: "perplexity" }] as never),
  judge: z
    .object({ model: z.string().default("claude-opus-5-5"), k: z.number().int().min(1).default(10) })
    .default({ model: "claude-opus-5-5", k: 10 }),
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
  dataDir: z.string().default(".geo-loop"),
});

export type Config = z.infer<typeof ConfigSchema>;
export type QuestionT = z.infer<typeof Question>;
export type EngineConfig = z.infer<typeof Engine>;

const CANDIDATES = ["geo-loop.config.ts", "geo-loop.config.mjs", "geo-loop.config.js", "geo-loop.config.json"];

export function defineConfig(c: z.input<typeof ConfigSchema>) {
  return c;
}

export async function loadConfig(path?: string, cwd = process.cwd()): Promise<{ config: Config; path: string }> {
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
  return { config: parsed.data, path: file };
}

export class ConfigError extends Error {}
