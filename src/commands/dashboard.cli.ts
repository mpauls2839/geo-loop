import { resolve } from "node:path";
import type { Command } from "commander";
import type { Ctx } from "../cli.js";
import type { PostVersion } from "../lib/diff.js";
import { ptToMd } from "../lib/portable.js";
import { DEFAULT_FIELDS, sanityDataset } from "../lib/sanity.js";
import { readProposals, writeDashboard } from "./dashboard.js";
import { makeSanityFor } from "./ship.cli.js";

export function register(program: Command, ctx: () => Promise<Ctx>) {
  program
    .command("dashboard")
    .description("visual one-page dashboard of the latest run, plus a before/after page per proposed change (private HTML)")
    .option("--out <dir>", "output directory (default: <dataDir>/report)")
    .option("--open", "open it in your browser")
    .action(async (o: { out?: string; open?: boolean }) => {
      const c = await ctx();
      const date =
        program.opts().date ??
        ((c.ledger.db.prepare("SELECT MAX(date) AS d FROM probe_answers WHERE error IS NULL").get() as { d: string | null }).d ?? undefined);

      // Read the current live version of each refresh target (read-only) so the dashboard can say what changes.
      const befores: Record<string, PostVersion> = {};
      const sanity = c.config.sanity ? makeSanityFor(c.config)(sanityDataset(c.config, false)) : undefined;
      if (sanity && date) {
        for (const p of readProposals(resolve(c.config.dataDir, "proposed", date))) {
          if (p.lane !== "refresh" || befores[p.target]) continue;
          try {
            const doc = await sanity.getPublishedBySlug(c.config.sanity!.postType, DEFAULT_FIELDS.slug, p.target);
            if (doc) befores[p.target] = { title: doc[DEFAULT_FIELDS.title] as string, excerpt: doc[DEFAULT_FIELDS.excerpt] as string, md: ptToMd(doc[DEFAULT_FIELDS.body]) };
          } catch (err) {
            console.error(`could not read live /${p.target} from the CMS: ${(err as Error).message}`);
          }
        }
      }
      const file = writeDashboard(c.config, c.ledger, o.out, { date, befores });
      console.log(`dashboard written: ${file}`);
      if (o.open) {
        const { openBrowser } = await import("./gscauth.js");
        openBrowser(`file://${file}`);
      }
    });
}
