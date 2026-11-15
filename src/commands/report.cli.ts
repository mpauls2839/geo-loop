import type { Command } from "commander";
import type { Ctx } from "../cli.js";
import { writeReport } from "./report.js";

export function register(program: Command, ctx: () => Promise<Ctx>) {
  program
    .command("report")
    .description("write the private results page (static HTML) from the ledger")
    .option("--out <dir>", "output directory (default: <dataDir>/report)")
    .action(async (o) => {
      const c = await ctx();
      const file = writeReport(c.config, c.ledger, o.out, { date: c.date });
      if (c.json) console.log(JSON.stringify({ file }));
      else console.log(`report written: ${file}`);
    });
}
