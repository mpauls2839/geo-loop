import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Config, QuestionsFile, QuestionT } from "../config.js";
import { classifyUrl } from "../lib/fetchmeta.js";
import type { Ledger } from "../lib/ledger.js";
import { autocomplete, gscQueries, loadServiceAccount, type GscRow } from "../lib/searchdata.js";
import { registeredDomain } from "../lib/urls.js";

// Question discovery from real search data. Candidates come from:
//   gsc          - queries your site already shows up for (Google Search Console)
//   engine       - the web searches AI engines themselves ran during probes
//   autocomplete - Google's public suggestions for your category terms
//   thread       - titles of forum/Reddit threads AI engines cite for your topics
// Each candidate keeps its sources and evidence; near-duplicates merge.

export type Source = "gsc" | "engine" | "autocomplete" | "thread";
export type Candidate = { id: string; text: string; topic: string; score: number; sources: Source[]; evidence: string[] };

export type SuggestDeps = {
  gsc?: () => Promise<GscRow[]>;
  autocomplete?: (terms: string[]) => Promise<{ query: string; seed: string; rank: number }[]>;
  now?: Date;
};

const STOP = new Set(["the", "a", "an", "to", "in", "on", "for", "of", "and", "or", "is", "my", "how", "do", "i", "with", "what", "why", "can", "does", "it"]);
const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t && !STOP.has(t)));
function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function topicFor(text: string): string {
  const t = text.toLowerCase();
  if (/\b(vs|versus|alternatives?|compared?|best|top)\b/.test(t)) return "comparisons";
  if (/(error|not working|fail|failing|fix|issue|broken|not firing|empty|timeout|problem)/.test(t)) return "errors";
  if (/^(how|how to)\b|\bhow to\b|\bsetup\b|\bset up\b|\bguide\b/.test(t)) return "how-to";
  return "general";
}

const idFor = (text: string) => `d-${createHash("sha256").update(text.toLowerCase().trim()).digest("hex").slice(0, 8)}`;

/** Readable title from a thread URL slug, e.g. /t/silent-failures-in-production/308805 -> "silent failures in production". */
export function titleFromThreadUrl(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const slug = [...parts].reverse().find((p) => /[a-z]/i.test(p) && /[-_]/.test(p) && !/^\d+$/.test(p));
    return slug ? decodeURIComponent(slug).replace(/[-_]+/g, " ").trim() : null;
  } catch {
    return null;
  }
}

export async function suggestQuestions(config: Config, ledger: Ledger, deps: SuggestDeps = {}): Promise<{ candidates: Candidate[]; notes: string[] }> {
  const notes: string[] = [];
  const brandWords = [config.brand.name, ...config.brand.aliases, config.brand.domain.split(".")[0]].map((w) => w.toLowerCase());
  const seeds = config.discovery.seedTerms.map((s) => s.toLowerCase());
  const relevant = (q: string) => !seeds.length || seeds.some((s) => q.toLowerCase().includes(s));
  const branded = (q: string) => brandWords.some((b) => q.toLowerCase().includes(b));
  const raw: { text: string; score: number; source: Source; evidence: string }[] = [];
  const on = new Set(config.discovery.sources);

  if (on.has("gsc")) {
    if (!deps.gsc) notes.push("gsc: skipped (no GSC_SERVICE_ACCOUNT_JSON/FILE or site URL)");
    else {
      try {
        const rows = await deps.gsc();
        for (const r of rows) {
          if (branded(r.query) || r.impressions < 10) continue;
          raw.push({ text: r.query, score: 2 * Math.log10(r.impressions + 1) + (r.position <= 20 ? 1 : 0), source: "gsc", evidence: `${r.impressions} impressions, pos ${r.position.toFixed(1)}` });
        }
        notes.push(`gsc: ${rows.length} queries read`);
      } catch (err) {
        notes.push(`gsc: failed (${(err as Error).message})`);
      }
    }
  }

  if (on.has("engine")) {
    const since = new Date((deps.now ?? new Date()).getTime() - 60 * 86_400_000).toISOString().slice(0, 10);
    const rows = ledger.db
      .prepare("SELECT query, COUNT(DISTINCT question_id || engine) AS n, GROUP_CONCAT(DISTINCT engine) AS engines FROM engine_queries WHERE date >= ? GROUP BY query")
      .all(since) as { query: string; n: number; engines: string }[];
    for (const r of rows) {
      if (branded(r.query) || !relevant(r.query)) continue;
      raw.push({ text: r.query, score: 1.5 * r.n, source: "engine", evidence: `searched by ${r.engines} (${r.n}x)` });
    }
    notes.push(`engine: ${rows.length} engine-issued searches in the last 60 days`);
  }

  if (on.has("autocomplete")) {
    if (!seeds.length) notes.push("autocomplete: skipped (set discovery.seedTerms, e.g. your category)");
    else {
      const rows = await (deps.autocomplete ?? ((t) => autocomplete(t)))(seeds);
      for (const r of rows) {
        if (branded(r.query)) continue;
        raw.push({ text: r.query, score: 1 + (10 - Math.min(r.rank, 10)) / 10, source: "autocomplete", evidence: `google suggest #${r.rank} for "${r.seed}"` });
      }
      notes.push(`autocomplete: ${rows.length} suggestions`);
    }
  }

  if (on.has("thread")) {
    const rows = ledger.db.prepare("SELECT DISTINCT cited_urls FROM probe_answers WHERE error IS NULL").all() as { cited_urls: string }[];
    const seen = new Set<string>();
    for (const r of rows) {
      for (const url of JSON.parse(r.cited_urls) as string[]) {
        if (seen.has(url) || classifyUrl(url).kind !== "thread" || registeredDomain(url) === registeredDomain(config.brand.domain)) continue;
        seen.add(url);
        const title = titleFromThreadUrl(url);
        // Cited for our own questions, so relevant by construction: no seed-term filter here.
        if (title && title.split(" ").length >= 4 && !branded(title)) {
          raw.push({ text: title, score: 1.5, source: "thread", evidence: `cited thread ${url}` });
        }
      }
    }
    notes.push(`thread: ${seen.size} cited threads`);
  }

  // Too short to be a real question (a bare category term, or a truncated suggestion like "n8n nod").
  const usable = (t: string) => t.trim().split(/\s+/).length >= 3 && !seeds.includes(t.trim().toLowerCase());
  for (let i = raw.length - 1; i >= 0; i--) if (raw[i].source !== "gsc" && !usable(raw[i].text)) raw.splice(i, 1);

  // Merge near-duplicates (token Jaccard >= 0.6), keeping the best phrasing and summing scores.
  const merged: Candidate[] = [];
  for (const r of raw.sort((a, b) => b.score - a.score)) {
    const t = tokens(r.text);
    const hit = merged.find((m) => jaccard(tokens(m.text), t) >= 0.6);
    if (hit) {
      hit.score += r.score * 0.5;
      if (!hit.sources.includes(r.source)) hit.sources.push(r.source);
      if (hit.evidence.length < 4) hit.evidence.push(r.evidence);
      continue;
    }
    merged.push({ id: idFor(r.text), text: r.text, topic: topicFor(r.text), score: r.score, sources: [r.source], evidence: [r.evidence] });
  }
  // Candidates that duplicate an existing question are dropped.
  const existing = config.questions.map((q) => tokens(q.text));
  const fresh = merged.filter((m) => !existing.some((e) => jaccard(e, tokens(m.text)) >= 0.6));
  // Multi-source candidates are stronger evidence of real demand.
  for (const c of fresh) c.score = Math.round((c.score + 1.5 * (c.sources.length - 1)) * 100) / 100;
  return { candidates: fresh.sort((a, b) => b.score - a.score), notes };
}

const toQuestion = (c: Candidate): QuestionT => ({
  id: c.id,
  text: c.text,
  topic: c.topic,
  source: c.sources.length > 1 ? "mixed" : c.sources[0],
  evidence: c.evidence.join("; "),
});

/**
 * Apply suggestions to questions.json by mode. Core is filled once (data mode) and then frozen so the
 * weekly citation-share trend stays comparable; explore is replaced every time.
 */
export function applySuggestions(file: QuestionsFile, candidates: Candidate[], config: Config, now = new Date()): QuestionsFile {
  const out: QuestionsFile = { ...file, core: [...file.core], updatedAt: now.toISOString() };
  let pool = [...candidates];
  if (out.mode === "data" && out.core.length === 0) {
    out.core = pool.slice(0, config.discovery.coreSize).map(toQuestion);
    pool = pool.slice(config.discovery.coreSize);
  }
  const taken = new Set(out.core.map((q) => q.id));
  out.explore = pool.filter((c) => !taken.has(c.id)).slice(0, config.discovery.exploreSize).map(toQuestion);
  return out;
}

export function readQuestionsFile(path: string): QuestionsFile {
  if (!existsSync(path)) return { mode: "user", core: [], explore: [] };
  return JSON.parse(readFileSync(path, "utf8")) as QuestionsFile;
}

export function writeQuestionsFile(path: string, f: QuestionsFile) {
  writeFileSync(path, JSON.stringify(f, null, 2) + "\n");
}

export function defaultSuggestDeps(config: Config, env = process.env): SuggestDeps {
  const site = config.discovery.gscSiteUrl ?? env.GSC_SITE_URL;
  let sa: ReturnType<typeof loadServiceAccount> = null;
  try {
    sa = loadServiceAccount(env);
  } catch {
    sa = null;
  }
  return { gsc: sa && site ? () => gscQueries({ siteUrl: site, sa: sa! }) : undefined };
}
