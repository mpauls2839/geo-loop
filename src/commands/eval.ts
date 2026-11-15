import type { Config, QuestionT } from "../config.js";
import { runJudge, type Candidate, type JudgeCall, type JudgeFn, type Rng } from "../lib/judge.js";
import type { Ledger } from "../lib/ledger.js";
import { fetchPage, PageFetchError, pageFromText, type PageLoader, type PageText } from "../lib/page.js";
import { isBrandUrl, normalizeUrl } from "../lib/urls.js";

// Mock eval (spec slice 4, verification §4): our page vs the pages engines currently cite.

export const MAX_BASELINE_PAGES = 5;

export type Baseline = {
  source: "probe" | "competitors" | "none";
  candidates: Candidate[];
  dropped: { url: string; reason: string }[];
};

export type QuestionEval = {
  questionId: string;
  subject: string;
  status: "ok" | "no_baseline";
  k: number;
  wins: number;
  winRate: number | null; // null when there is no baseline
  unparseable: number;
  baselineSource: Baseline["source"];
  candidates: string[]; // baseline urls actually judged against
  dropped: { url: string; reason: string }[];
  calls: JudgeCall[];
  evalId?: number;
};

export type Decision = { kind: "refresh" | "new_post"; verdict: "pass" | "fail"; reason: string; avgDeltaPts?: number; avgWinRate?: number };

export type Rates = Record<string, number | null>;

export type EvalDeps = { judge: JudgeFn; loadPage?: PageLoader; rng?: Rng };

/** Baseline URLs for a question: what engines cited today (minus our own domain), most-cited first; else config competitors (4.8). */
export function baselineUrls(config: Config, ledger: Ledger, date: string, q: QuestionT): { source: Baseline["source"]; urls: string[] } {
  const rows = ledger.db
    .prepare("SELECT cited_urls FROM probe_answers WHERE date = ? AND question_id = ? AND error IS NULL")
    .all(date, q.id) as { cited_urls: string }[];
  const counts = new Map<string, number>();
  for (const r of rows)
    for (const u of JSON.parse(r.cited_urls) as string[]) {
      const n = normalizeUrl(u);
      if (n && !isBrandUrl(n, config.brand.domain)) counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  if (counts.size) return { source: "probe", urls: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u).slice(0, MAX_BASELINE_PAGES) };
  const comp = (config.competitors[q.topic] ?? []).filter((u) => !isBrandUrl(u, config.brand.domain));
  if (comp.length) return { source: "competitors", urls: comp.slice(0, MAX_BASELINE_PAGES) };
  return { source: "none", urls: [] };
}

/** Fetch baseline pages; unfetchable ones are dropped and logged (4.9). */
export async function loadBaseline(config: Config, ledger: Ledger, date: string, q: QuestionT, loadPage: PageLoader = (u) => fetchPage(u)): Promise<Baseline> {
  const { source, urls } = baselineUrls(config, ledger, date, q);
  const candidates: Candidate[] = [];
  const dropped: Baseline["dropped"] = [];
  for (const url of urls) {
    try {
      candidates.push({ id: url, page: await loadPage(url) });
    } catch (err) {
      dropped.push({ url, reason: err instanceof PageFetchError ? err.reason : (err as Error).message });
    }
  }
  return { source, candidates, dropped };
}

/** Judge one subject page against a question's baseline and store the result in `evals`. */
export async function evalQuestion(input: {
  config: Config;
  ledger: Ledger;
  question: QuestionT;
  subject: string; // e.g. "live:https://synta.io/blog/x" or "draft:<id>"
  page: PageText;
  baseline: Baseline;
  deps: EvalDeps;
  runId?: string;
}): Promise<QuestionEval> {
  const { config, ledger, question, subject, page, baseline, deps } = input;
  const base = {
    questionId: question.id,
    subject,
    baselineSource: baseline.source,
    candidates: baseline.candidates.map((c) => c.id),
    dropped: baseline.dropped,
  };
  let r: QuestionEval;
  // Fewer than 2 candidates (ours + at least one baseline page) = no baseline.
  if (baseline.candidates.length < 1) {
    r = { ...base, status: "no_baseline", k: 0, wins: 0, winRate: null, unparseable: 0, calls: [] };
  } else {
    const SELF = "__subject__";
    const res = await runJudge({
      question: question.text,
      candidates: [{ id: SELF, page }, ...baseline.candidates],
      subjectId: SELF,
      k: config.judge.k,
      judge: deps.judge,
      rng: deps.rng,
    });
    const calls = res.calls.map((c) => ({ ...c, order: c.order.map((id) => (id === SELF ? "ours" : id)), picked: c.picked === SELF ? "ours" : c.picked }));
    r = { ...base, status: "ok", k: res.k, wins: res.wins, winRate: res.winRate, unparseable: res.unparseable, calls };
  }
  const info = ledger.db
    .prepare("INSERT INTO evals (run_id, created_at, subject, question_id, k, wins, win_rate, candidates, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      input.runId ?? null, new Date().toISOString(), subject, question.id, r.k, r.wins, r.winRate ?? 0,
      JSON.stringify(r.candidates),
      JSON.stringify({ status: r.status, model: config.judge.model, baselineSource: r.baselineSource, dropped: r.dropped, unparseable: r.unparseable, calls: r.calls }),
    );
  return { ...r, evalId: Number(info.lastInsertRowid) };
}

export type PageEvalRow = { questionId: string; live?: QuestionEval; draft?: QuestionEval; deltaPts: number | null };

export type PageEvalResult = {
  url: string;
  mode: "refresh" | "new_post" | "score";
  liveError?: string;
  rows: PageEvalRow[];
  decision: Decision;
};

/**
 * Eval a page on its target questions. With a draft: draft vs live (refresh decision), or draft alone
 * when the live URL doesn't exist yet (new-post decision). Without a draft: scores the live page against
 * the new-post bar. Baselines are fetched once per question and shared by draft and live.
 */
export async function evalPage(input: {
  config: Config;
  ledger: Ledger;
  date: string;
  url: string;
  questions: QuestionT[];
  draft?: { id: string; body: string };
  deps: EvalDeps;
  runId?: string;
}): Promise<PageEvalResult> {
  const { config, ledger, date, url, questions, draft, deps } = input;
  const loadPage = deps.loadPage ?? ((u: string) => fetchPage(u));
  let live: PageText | undefined;
  let liveError: string | undefined;
  try {
    live = await loadPage(url);
  } catch (err) {
    liveError = err instanceof PageFetchError ? err.reason : (err as Error).message;
  }
  if (!live && !draft) throw new Error(`can't fetch ${url}: ${liveError}`);
  const draftPage = draft ? { ...pageFromText(draft.body, url) } : undefined;

  const rows: PageEvalRow[] = [];
  for (const q of questions) {
    const baseline = await loadBaseline(config, ledger, date, q, loadPage);
    const common = { config, ledger, question: q, baseline, deps, runId: input.runId };
    const l = live ? await evalQuestion({ ...common, subject: `live:${url}`, page: live }) : undefined;
    const d = draftPage ? await evalQuestion({ ...common, subject: `draft:${draft!.id}`, page: draftPage }) : undefined;
    const deltaPts = l?.winRate != null && d?.winRate != null ? round1((d.winRate - l.winRate) * 100) : null;
    rows.push({ questionId: q.id, live: l, draft: d, deltaPts });
  }

  const rate = (pick: (r: PageEvalRow) => QuestionEval | undefined): Rates => Object.fromEntries(rows.map((r) => [r.questionId, pick(r)?.winRate ?? null]));
  let mode: PageEvalResult["mode"];
  let decision: Decision;
  if (draft && live) {
    mode = "refresh";
    decision = decideRefresh(rate((r) => r.draft), rate((r) => r.live), config);
  } else if (draft) {
    mode = "new_post";
    decision = decideNewPost(rate((r) => r.draft), config);
  } else {
    mode = "score";
    decision = decideNewPost(rate((r) => r.live), config);
  }
  return { url, mode, ...(liveError ? { liveError } : {}), rows, decision };
}

/**
 * Refresh gate (4.4, 4.5): pass only if the draft beats live by >= gates.refreshDeltaPts on average
 * across target questions AND is below live on none. Rates are 0..1; null = no baseline (held).
 */
export function decideRefresh(draftRates: Rates, liveRates: Rates, config: Config): Decision {
  const ids = Object.keys(draftRates);
  if (!ids.length) return { kind: "refresh", verdict: "fail", reason: "no target questions" };
  const noBase = ids.filter((id) => draftRates[id] == null || liveRates[id] == null);
  if (noBase.length) return { kind: "refresh", verdict: "fail", reason: `no baseline for ${noBase.join(", ")}` };
  const deltas = ids.map((id) => round1(((draftRates[id] as number) - (liveRates[id] as number)) * 100));
  const avgDeltaPts = round1(deltas.reduce((a, b) => a + b, 0) / deltas.length);
  const regressed = ids.filter((_, i) => deltas[i] < 0);
  if (regressed.length) return { kind: "refresh", verdict: "fail", reason: `regressed on ${regressed.join(", ")}`, avgDeltaPts };
  if (avgDeltaPts < config.gates.refreshDeltaPts)
    return { kind: "refresh", verdict: "fail", reason: `avg delta +${avgDeltaPts} pts < +${config.gates.refreshDeltaPts} required`, avgDeltaPts };
  return { kind: "refresh", verdict: "pass", reason: `avg delta +${avgDeltaPts} pts, no regressions`, avgDeltaPts };
}

/** New-post gate (4.6, 4.7): average win rate on target questions >= gates.newPostMinWinRate. */
export function decideNewPost(rates: Rates, config: Config): Decision {
  const ids = Object.keys(rates);
  if (!ids.length) return { kind: "new_post", verdict: "fail", reason: "no target questions" };
  const noBase = ids.filter((id) => rates[id] == null);
  if (noBase.length) return { kind: "new_post", verdict: "fail", reason: `no baseline for ${noBase.join(", ")}` };
  const avgWinRate = ids.reduce((a, id) => a + (rates[id] as number), 0) / ids.length;
  const min = config.gates.newPostMinWinRate;
  const pctStr = (x: number) => `${round1(x * 100)}%`;
  return avgWinRate + 1e-9 >= min
    ? { kind: "new_post", verdict: "pass", reason: `win rate ${pctStr(avgWinRate)} >= ${pctStr(min)}`, avgWinRate }
    : { kind: "new_post", verdict: "fail", reason: `win rate ${pctStr(avgWinRate)} < ${pctStr(min)}`, avgWinRate };
}

/** `--page` accepts a URL or a blog slug. */
export function resolvePageUrl(config: Config, pageOrSlug: string): string {
  if (/^https?:\/\//i.test(pageOrSlug)) return normalizeUrl(pageOrSlug) ?? pageOrSlug;
  const base = config.site.baseUrl.replace(/\/$/, "");
  const path = config.site.blogPath.replace(/^\/?/, "/").replace(/\/?$/, "/");
  return normalizeUrl(`${base}${path}${pageOrSlug.replace(/^\//, "")}`)!;
}

/**
 * Target questions: explicit ids, else questions where today's probe cited this page, else all questions.
 * Unknown ids throw.
 */
export function targetQuestions(config: Config, ledger: Ledger, date: string, url: string, ids?: string[]): QuestionT[] {
  if (ids?.length) {
    const unknown = ids.filter((id) => !config.questions.some((q) => q.id === id));
    if (unknown.length) throw new Error(`unknown question id(s): ${unknown.join(", ")}`);
    return config.questions.filter((q) => ids.includes(q.id));
  }
  const rows = ledger.db
    .prepare("SELECT DISTINCT question_id, cited_urls FROM probe_answers WHERE date = ? AND error IS NULL")
    .all(date) as { question_id: string; cited_urls: string }[];
  const target = normalizeUrl(url);
  const hit = new Set(rows.filter((r) => (JSON.parse(r.cited_urls) as string[]).some((u) => normalizeUrl(u) === target)).map((r) => r.question_id));
  const qs = config.questions.filter((q) => hit.has(q.id));
  return qs.length ? qs : config.questions;
}

function round1(x: number) {
  return Math.round(x * 10) / 10;
}
