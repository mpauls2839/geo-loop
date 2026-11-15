import type { Command } from "commander";
import type { Ctx } from "../cli.js";
import { revertChange } from "./revert.js";
import { localCheckFromOpts, makeGithub, makeSanityFor, previewHeaders } from "./ship.cli.js";

export function register(program: Command, ctx: () => Promise<Ctx>) {
  program
    .command("revert <change-id>")
    .description("restore the snapshot taken before a shipped change (refresh → restore, new post → unpublish, code PR → revert PR)")
    .option("--force", "restore even if the target was changed again later")
    .option("--dry-run", "print what would be restored, write nothing")
    .option("--preview-url <url>", "code PR: Vercel preview URL of the revert PR")
    .option("--repo-dir <dir>", "code PR: local checkout used for the build/typecheck merge gate")
    .option("--build-cmd <cmd>", "code PR: build/typecheck command", "npx tsc --noEmit && npx next build")
    .option("--local-check-passed", "code PR: build + typecheck already passed")
    .action(async (id: string, o) => {
      const c = await ctx();
      const run = c.ledger.startRun("revert", c.date);
      const r = await revertChange(id, {
        config: c.config,
        ledger: c.ledger,
        run,
        sanityFor: makeSanityFor(c.config),
        github: makeGithub(c.config),
        localCheck: localCheckFromOpts(o),
        previewUrl: o.previewUrl,
        previewHeaders: previewHeaders(),
        force: !!o.force,
        dryRun: !!o.dryRun,
        log: c.json ? () => {} : console.log,
      });
      run.finish(r.exitCode === 1 ? "failed" : r.exitCode === 2 ? "partial" : "ok");
      if (c.json) console.log(JSON.stringify(r, null, 2));
      process.exitCode = r.exitCode;
    });
}
