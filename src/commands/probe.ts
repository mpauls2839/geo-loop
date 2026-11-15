import type { Config, EngineConfig, QuestionT } from "../config.js";
import { createEngine, EngineAuthError, type EngineAdapter, type EngineAnswer } from "../engines/index.js";
import type { Ledger, Run } from "../lib/ledger.js";
import { isBrandUrl, mentionsBrand, normalizeUrl } from "../lib/urls.js";

export type ProbeOptions = {
  force?: boolean;
  // Test seam: replaces live engines (fixtures).
  engines?: EngineAdapter[];
  sleep?: (ms: number) => Promise<void>;
};

export type ProbeSummary = {
  date: string;
  engines: { id: string; model: string; ok: boolean; samples: number; cited: number; mentioned: number; error?: string }[];
  citationShare: number; // over engines that worked
  mentionRate: number;
  enginesOk: number;
  enginesFailed: number;
  reused: boolean;
  budgetHit: boolean;
};

export async function probe(config: Config, ledger: Ledger, run: Run, opts: ProbeOptions = {}): Promise<ProbeSummary> {
  const date = run.date;
  const existing = ledger.db.prepare("SELECT COUNT(*) AS n FROM probe_answers WHERE date = ? AND error IS NULL").get(date) as { n: number };
  if (existing.n > 0 && !opts.force) {
    run.note({ level: "skipped", item: "probe", reason: `reused today's probe (${existing.n} answers); pass --force to re-run` });
    return summarize(config, ledger, date, true, false);
  }
  if (opts.force) ledger.db.prepare("DELETE FROM probe_answers WHERE date = ?").run(date);

  const enabled = config.engines.filter((e) => e.enabled);
  const engines: (EngineAdapter | { id: EngineConfig["id"]; error: string })[] = opts.engines
    ? opts.engines
    : enabled.map((e) => {
        try {
          return createEngine(e);
        } catch (err) {
          return { id: e.id, error: (err as Error).message };
        }
      });

  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const names = [config.brand.name, ...config.brand.aliases];
  const insert = ledger.db.prepare(
    `INSERT OR REPLACE INTO probe_answers (run_id, date, question_id, engine, model, sample, answer, cited_urls, cited, mentioned, cost_usd, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let spent = 0;
  let budgetHit = false;
  const failed = new Map<string, string>();

  for (const engine of engines) {
    if ("error" in engine) {
      failed.set(engine.id, engine.error);
      continue;
    }
    let consecutiveFailures = 0;
    for (const q of config.questions) {
      for (let sample = 1; sample <= config.probe.samples; sample++) {
        if (spent >= config.probe.budgetUsd) {
          budgetHit = true;
          break;
        }
        const res = await askWithRetry(engine, q, config.probe.maxRetries, sleep);
        if ("error" in res) {
          consecutiveFailures++;
          insert.run(run.id, date, q.id, engine.id, engine.model, sample, "", "[]", 0, 0, 0, res.error);
          // An engine that keeps failing is skipped for the rest of the run (spec 2.5).
          if (consecutiveFailures >= 3) {
            failed.set(engine.id, res.error);
            break;
          }
          continue;
        }
        consecutiveFailures = 0;
        spent += res.costUsd;
        run.addCost(res.costUsd);
        const urls = res.citedUrls.map(normalizeUrl).filter((u): u is string => !!u);
        const cited = urls.some((u) => isBrandUrl(u, config.brand.domain));
        insert.run(
          run.id, date, q.id, engine.id, res.model, sample, res.text, JSON.stringify([...new Set(urls)]),
          cited ? 1 : 0, mentionsBrand(res.text, names) ? 1 : 0, res.costUsd, null,
        );
      }
      if (failed.has(engine.id) || budgetHit) break;
    }
  }

  for (const [id, err] of failed) run.note({ level: "error", item: `engine:${id}`, reason: err });
  if (budgetHit) run.markPartial(`probe stopped at budget $${config.probe.budgetUsd}`);
  return summarize(config, ledger, date, false, budgetHit, failed);
}

async function askWithRetry(
  engine: EngineAdapter,
  q: QuestionT,
  retries: number,
  sleep: (ms: number) => Promise<void>,
): Promise<EngineAnswer | { error: string }> {
  let last = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await engine.ask(q.text);
    } catch (err) {
      if (err instanceof EngineAuthError) return { error: err.message };
      last = (err as Error).message ?? String(err);
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    }
  }
  return { error: `failed after ${retries + 1} attempts: ${last}` };
}

export function summarize(
  config: Config,
  ledger: Ledger,
  date: string,
  reused: boolean,
  budgetHit: boolean,
  failed = new Map<string, string>(),
): ProbeSummary {
  const rows = ledger.db
    .prepare(
      `SELECT engine, MAX(model) AS model, SUM(error IS NULL) AS samples, SUM(cited) AS cited, SUM(mentioned) AS mentioned,
              MAX(error) AS lastError
       FROM probe_answers WHERE date = ? GROUP BY engine`,
    )
    .all(date) as { engine: string; model: string; samples: number; cited: number; mentioned: number; lastError: string | null }[];
  const engines = config.engines
    .filter((e) => e.enabled)
    .map((e) => {
      const r = rows.find((x) => x.engine === e.id);
      const err = failed.get(e.id) ?? (r && r.samples === 0 ? r.lastError ?? "no answers" : undefined);
      return {
        id: e.id,
        model: r?.model ?? e.model ?? "",
        ok: !err && !!r && r.samples > 0,
        samples: r?.samples ?? 0,
        cited: r?.cited ?? 0,
        mentioned: r?.mentioned ?? 0,
        ...(err ? { error: err } : {}),
      };
    });
  const ok = engines.filter((e) => e.ok);
  const samples = ok.reduce((a, e) => a + e.samples, 0);
  return {
    date,
    engines,
    citationShare: samples ? ok.reduce((a, e) => a + e.cited, 0) / samples : 0,
    mentionRate: samples ? ok.reduce((a, e) => a + e.mentioned, 0) / samples : 0,
    enginesOk: ok.length,
    enginesFailed: engines.length - ok.length,
    reused,
    budgetHit,
  };
}

/** Shipping is allowed only when at most one engine failed (spec 2.6 / 8.3). */
export function shippingAllowed(s: ProbeSummary) {
  return s.enginesOk > 0 && s.enginesFailed <= 1;
}
