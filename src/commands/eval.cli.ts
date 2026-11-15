import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import type { Ctx } from "../cli.js";
import { claudeJudge } from "../lib/judge.js";
import { evalPage, resolvePageUrl, targetQuestions, type PageEvalResult } from "./eval.js";

export function register(program: Command, ctx: () => Promise<Ctx>) {
  program
    .command("eval")
    .description("mock eval: does the judge cite our page over the pages engines cite today?")
    .requiredOption("--page <url-or-slug>", "live page URL or blog slug")
    .option("--draft <file-or-id>", "draft to compare against the live page (markdown/text file, or a drafts.id from the ledger)")
    .option("--questions <ids>", "comma-separated target question ids (default: questions where today's probe cited the page, else all)")
    .action(async (o: { page: string; draft?: string; questions?: string }) => {
      const c = await ctx();
      const url = resolvePageUrl(c.config, o.page);
      const questions = targetQuestions(c.config, c.ledger, c.date, url, o.questions?.split(",").map((s) => s.trim()).filter(Boolean));
      const draft = o.draft ? loadDraft(c, o.draft) : undefined;
      const res = await evalPage({ config: c.config, ledger: c.ledger, date: c.date, url, questions, draft, deps: { judge: claudeJudge(c.config) } });
      if (c.json) console.log(JSON.stringify(res, null, 2));
      else printHuman(res, c.config.judge.k);
      process.exitCode = res.decision.verdict === "pass" ? 0 : 2;
    });
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
