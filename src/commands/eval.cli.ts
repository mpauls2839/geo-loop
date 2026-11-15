import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import type { Ctx } from "../cli.js";
import { seededRng } from "../lib/judge.js";
import {
  JOB_INSTRUCTIONS, judgeFromConfig, recordingJudge, recordingLoader, replayJudge, replayLoader, unansweredCalls, type JudgeJob,
} from "../lib/judges.js";
import { fetchPage } from "../lib/page.js";
import { evalPage, resolvePageUrl, targetQuestions, type PageEvalResult } from "./eval.js";

export function register(program: Command, ctx: () => Promise<Ctx>) {
  program
    .command("eval")
    .description("mock eval: does the judge cite our page over the pages engines cite today?")
    .option("--page <url-or-slug>", "live page URL or blog slug")
    .option("--draft <file-or-id>", "draft to compare against the live page (markdown/text file, or a drafts.id from the ledger)")
    .option("--questions <ids>", "comma-separated target question ids (default: questions where today's probe cited the page, else all)")
    .option("--prepare <job.json>", "external judge, pass 1: write the judge prompts to a job file instead of calling a model")
    .option("--answers <job.json>", "external judge, pass 2: score a job file whose calls have answers filled in")
    .action(async (o: { page?: string; draft?: string; questions?: string; prepare?: string; answers?: string }) => {
      const c = await ctx();

      if (o.answers) {
        const job = JSON.parse(readFileSync(o.answers, "utf8")) as JudgeJob;
        const missing = unansweredCalls(job);
        if (missing.length) {
          console.error(`${missing.length}/${job.calls.length} calls have no valid answer yet (ids: ${missing.slice(0, 5).map((m) => m.id).join(", ")}${missing.length > 5 ? ", ..." : ""})`);
          process.exitCode = 1;
          return;
        }
        const questions = targetQuestions(c.config, c.ledger, job.date, job.page, job.questionIds);
        const res = await evalPage({
          config: c.config, ledger: c.ledger, date: job.date, url: job.page, questions, draft: job.draft,
          deps: { judge: replayJudge(job), loadPage: replayLoader(job.pages), rng: seededRng(job.seed) },
        });
        report(c, res);
        return;
      }

      if (!o.page) throw new Error("--page is required (or --answers <job.json>)");
      const url = resolvePageUrl(c.config, o.page);
      const questions = targetQuestions(c.config, c.ledger, c.date, url, o.questions?.split(",").map((s) => s.trim()).filter(Boolean));
      const draft = o.draft ? loadDraft(c, o.draft) : undefined;

      if (o.prepare || c.config.judge.provider === "external") {
        const file = o.prepare ?? "judge-job.json";
        const seed = Math.floor(Math.random() * 2 ** 31);
        const job: JudgeJob = { version: 1, seed, page: url, draft, questionIds: questions.map((q) => q.id), date: c.date, pages: {}, calls: [], instructions: JOB_INSTRUCTIONS };
        const before = (c.ledger.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM evals").get() as { m: number }).m;
        await evalPage({
          config: c.config, ledger: c.ledger, date: c.date, url, questions, draft,
          deps: { judge: recordingJudge(job.calls), loadPage: recordingLoader((u) => fetchPage(u), job.pages), rng: seededRng(seed) },
        });
        // Pass 1 only records prompts; its placeholder scores must not reach the ledger.
        c.ledger.db.prepare("DELETE FROM evals WHERE id > ?").run(before);
        writeFileSync(file, JSON.stringify(job, null, 2));
        const perQ = new Map<string, number>();
        for (const call of job.calls) perQ.set(call.question, (perQ.get(call.question) ?? 0) + 1);
        console.log(`judge job written: ${file}  (${job.calls.length} calls across ${perQ.size} question(s))`);
        console.log(`next: fill in each call's "answer" (one letter), then: geo-loop eval --answers ${file}`);
        return;
      }

      const res = await evalPage({ config: c.config, ledger: c.ledger, date: c.date, url, questions, draft, deps: { judge: judgeFromConfig(c.config) } });
      report(c, res);
    });
}

function report(c: Ctx, res: PageEvalResult) {
  if (c.json) console.log(JSON.stringify(res, null, 2));
  else printHuman(res, c.config.judge.k);
  process.exitCode = res.decision.verdict === "pass" ? 0 : 2;
}

function loadDraft(c: Ctx, ref: string): { id: string; body: string } {
  if (existsSync(ref)) return { id: ref, body: readFileSync(ref, "utf8") };
  const row = c.ledger.db.prepare("SELECT id, body FROM drafts WHERE id = ?").get(ref) as { id: string; body: string } | undefined;
  if (!row) throw new Error(`draft not found: ${ref} is neither a file nor a drafts.id`);
  return row;
}

const pct = (x: number | null | undefined) => (x == null ? "  n/a " : `${(x * 100).toFixed(0).padStart(4)}%`);

function printHuman(r: PageEvalResult, k: number) {
  console.log(`eval ${r.url}  mode ${r.mode}  k=${k}${r.liveError ? `  (live page unavailable: ${r.liveError})` : ""}`);
  for (const row of r.rows) {
    const e = row.draft ?? row.live!;
    const parts = [`  ${row.questionId.padEnd(8)}`];
    if (row.live) parts.push(`live ${pct(row.live.winRate)}`);
    if (row.draft) parts.push(`draft ${pct(row.draft.winRate)}`);
    if (row.deltaPts != null) parts.push(`delta ${row.deltaPts >= 0 ? "+" : ""}${row.deltaPts} pts`);
    parts.push(e.status === "no_baseline" ? "NO BASELINE" : `vs ${e.candidates.length} page(s) [${e.baselineSource}]`);
    if (e.unparseable) parts.push(`${e.unparseable} unparseable`);
    console.log(parts.join("  "));
    for (const d of e.dropped) console.log(`      dropped ${d.url} (${d.reason})`);
  }
  console.log(`decision ${r.decision.verdict.toUpperCase()} (${r.decision.kind}): ${r.decision.reason}`);
}
