import type { Command } from "commander";
import type { Ctx } from "../cli.js";
import { exitCodeFor } from "../lib/ledger.js";
import { generateDrafts } from "./drafts.js";

export function register(program: Command, ctx: () => Promise<Ctx>) {
  program
    .command("drafts")
    .description("draft off-site replies (threads) and pitches (listicles) from today's citation map; never posts")
    .option("--dry-run", "generate and print drafts without storing them in the ledger")
    .action(async (o) => {
      const c = await ctx();
      const run = c.ledger.startRun("drafts", c.date);
      let s;
      try {
        s = await generateDrafts(c.config, c.ledger, run, { dryRun: !!o.dryRun });
      } catch (err) {
        run.note({ level: "error", item: "drafts", reason: (err as Error).message });
        const status = run.finish("failed");
        console.error(`drafts failed: ${(err as Error).message}`);
        process.exitCode = exitCodeFor(status);
        return;
      }
      const status = run.finish();
      if (c.json) console.log(JSON.stringify({ status, dryRun: !!o.dryRun, ...s }, null, 2));
      else {
        console.log(`drafts ${s.date}${o.dryRun ? " (dry run, not stored)" : ""}  status ${status}`);
        for (const d of s.drafted) {
          console.log(`\n--- ${d.kind} → ${d.targetUrl}${d.meta.ageUnknown ? " (age unknown)" : ""}\n${d.body}`);
        }
        for (const h of s.held) console.log(`held     ${h.url}: ${h.reason}`);
        for (const k of s.skipped) console.log(`skipped  ${k.url}: ${k.reason}`);
        console.log(`\n${s.drafted.length} drafted, ${s.held.length} held, ${s.skipped.length} skipped. Nothing was posted.`);
      }
      process.exitCode = exitCodeFor(status);
    });
}
