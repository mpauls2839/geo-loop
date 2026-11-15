import type { Command } from "commander";
import type { Ctx } from "../cli.js";
import { writeDashboard } from "./dashboard.js";

export function register(program: Command, ctx: () => Promise<Ctx>) {
  program
    .command("dashboard")
    .description("visual one-page dashboard of the latest run (self-contained HTML, private)")
    .option("--out <dir>", "output directory (default: <dataDir>/report)")
    .option("--open", "open it in your browser")
    .action(async (o: { out?: string; open?: boolean }) => {
      const c = await ctx();
      const file = writeDashboard(c.config, c.ledger, o.out, { date: program.opts().date });
      console.log(`dashboard written: ${file}`);
      if (o.open) {
        const { openBrowser } = await import("./gscauth.js");
        openBrowser(`file://${file}`);
      }
    });
}
