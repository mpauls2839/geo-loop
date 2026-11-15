import type { Config, EngineConfig, QuestionT } from "../config.js";
import { createEngine, EngineAuthError, type EngineAdapter, type EngineAnswer } from "../engines/index.js";
import type { Ledger, Run } from "../lib/ledger.js";
import { isBrandUrl, mentionsBrand, normalizeUrl } from "../lib/urls.js";

export type ProbeOptions = {
  force?: boolean;
  // Test seam: replaces live engines (fixtures).
  engines?: EngineAdapter[];
  sleep?: (ms: number) => Promise<void>;
  concurrency?: number;
  only?: string[]; // re-probe just these engine ids
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
  const only = opts.only?.length ? opts.only : null;
  const scope = only ? ` AND engine IN (${only.map(() => "?").join(",")})` : "";
  const existing = ledger.db.prepare(`SELECT COUNT(*) AS n FROM probe_answers WHERE date = ? AND error IS NULL${scope}`).get(date, ...(only ?? [])) as { n: number };
  if (existing.n > 0 && !opts.force && !only) {
    run.note({ level: "skipped", item: "probe", reason: `reused today's probe (${existing.n} answers); pass --force to re-run` });
    return summarize(config, ledger, date, true, false);
  }
  if (opts.force || only) ledger.db.prepare(`DELETE FROM probe_answers WHERE date = ?${scope}`).run(date, ...(only ?? []));

  const enabled = config.engines.filter((e) => e.enabled && (!only || only.includes(e.id)));
  const engines: (EngineAdapter | { id: EngineConfig["id"]; error: string })[] = opts.engines
    ? opts.engines.filter((e) => !only || only.includes(e.id))
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
  const insertQuery = ledger.db.prepare("INSERT OR IGNORE INTO engine_queries (date, question_id, engine, query) VALUES (?, ?, ?, ?)");
  let spent = 0;
  let budgetHit = false;
  const failed = new Map<string, string>();

  // Engines run in parallel; each engine runs up to `concurrency` questions at once.
  const concurrency = opts.concurrency ?? 4;
  await Promise.all(
    engines.map(async (engine) => {
      if ("error" in engine) {
        failed.set(engine.id, engine.error);
        return;
      }
      const tasks = config.questions.flatMap((q) =>
        Array.from({ length: config.probe.samples }, (_, i) => ({ q, sample: i + 1 })),
      );
      const engineCfg = config.engines.find((e) => e.id === engine.id);
      const interval = engineCfg?.rpm ? 60_000 / engineCfg.rpm : 0;
      let nextSlot = 0;
      const pace = async () => {
        if (!interval) return;
        const now = Date.now();
        const at = Math.max(now, nextSlot);
        nextSlot = at + interval;
        if (at > now) await sleep(at - now);
      };
      let consecutiveFailures = 0;
      let next = 0;
      let inflight = 0;
      let maxCost = 0;
      const worker = async () => {
        while (next < tasks.length && !failed.has(engine.id)) {
          // Reserve the cost of calls already in flight so parallel workers can't overshoot the budget.
          if (spent + inflight * maxCost >= config.probe.budgetUsd) {
            budgetHit = true;
            return;
          }
          const { q, sample } = tasks[next++];
          inflight++;
          const res = await askWithRetry(engine, q, config.probe.maxRetries, sleep, pace);
          inflight--;
          if (!("error" in res)) maxCost = Math.max(maxCost, res.costUsd);
          if ("error" in res) {
            consecutiveFailures++;
            insert.run(run.id, date, q.id, engine.id, engine.model, sample, "", "[]", 0, 0, 0, res.error);
            // An engine that keeps failing is skipped for the rest of the run (spec 2.5).
            if (consecutiveFailures >= 3) failed.set(engine.id, res.error);
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
          for (const sq of res.searchQueries ?? []) insertQuery.run(date, q.id, engine.id, sq.trim().toLowerCase());
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, engineCfg?.concurrency ?? concurrency) }, worker));
    }),
  );

  for (const [id, err] of failed) run.note({ level: "error", item: `engine:${id}`, reason: err });
  if (budgetHit) run.markPartial(`probe stopped at budget $${config.probe.budgetUsd}`);
  return summarize(config, ledger, date, false, budgetHit, failed);
}

export function isRateLimit(msg: string) {
  return /\b429\b|rate limit/i.test(msg);
}

async function askWithRetry(
  engine: EngineAdapter,
  q: QuestionT,
  retries: number,
  sleep: (ms: number) => Promise<void>,
  pace: () => Promise<void> = async () => {},
): Promise<EngineAnswer | { error: string }> {
  let last = "";
  let rateWaits = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await pace();
      return await engine.ask(q.text);
    } catch (err) {
      if (err instanceof EngineAuthError) return { error: err.message };
      last = (err as Error).message ?? String(err);
      // Rate limits are waited out (up to 5 times) and don't use up a retry.
      if (isRateLimit(last) && rateWaits < 5) {
        rateWaits++;
        attempt--;
        const after = Number(/retry after (\d+)\s*s/i.exec(last)?.[1] ?? 60);
        await sleep(Math.min(after, 120) * 1000);
        continue;
      }
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
