import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { expectedEnv, resolveAuth } from "./engines/index.js";
import { exitCodeFor, Ledger, today } from "./lib/ledger.js";
import { citationMap } from "./commands/map.js";
import { probe } from "./commands/probe.js";

for (const f of [".env", ".env.local"]) if (existsSync(f)) process.loadEnvFile(f);

const program = new Command("geo-loop")
  .description("SEO/GEO improvement loop: probe AI engines, map citations, ship gated changes, measure, adapt.")
  .option("-c, --config <path>", "config file (default: geo-loop.config.{ts,mjs,js,json})")
  .option("--date <yyyy-mm-dd>", "run date (default: today, UTC)")
  .option("--json", "machine-readable output");

export type Ctx = { config: Config; ledger: Ledger; date: string; json: boolean };

async function ctx(): Promise<Ctx> {
  const o = program.opts();
  const { config } = await loadConfig(o.config);
  const ledger = new Ledger(resolve(config.dataDir, "ledger.db"));
  return { config, ledger, date: o.date ?? today(), json: !!o.json };
}

function out(c: { json: boolean }, data: unknown, human: () => void) {
  if (c.json) console.log(JSON.stringify(data, null, 2));
  else human();
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const config = program.command("config").description("validate and inspect configuration");
config
  .command("check")
  .description("validate the config and that every enabled engine has a key")
  .action(async () => {
    const { config: c, path } = await loadConfig(program.opts().config);
    const problems: string[] = [];
    const engines = c.engines.filter((e) => e.enabled).map((e) => {
      const auth = resolveAuth(e.id);
      if (!auth) problems.push(`engine ${e.id}: missing key (expected ${expectedEnv(e.id)})`);
      return { id: e.id, via: auth?.via ?? "missing" };
    });
    const warnings = c.positioning.line ? [] : ["no positioning line configured"];
    out({ json: !!program.opts().json }, { path, domain: c.brand.domain, engines, questions: c.questions.length, caps: c.caps, problems, warnings }, () => {
      console.log(`config  ${path}`);
      console.log(`brand   ${c.brand.name} (${c.brand.domain})`);
      console.log(`engines ${engines.map((e) => `${e.id}[${e.via}]`).join(", ")}`);
      console.log(`questions ${c.questions.length} across ${new Set(c.questions.map((q) => q.topic)).size} topics`);
      console.log(`caps    new ${c.caps.newPosts} / refresh ${c.caps.refreshes} / pr ${c.caps.codePrs} / drafts ${c.caps.offsiteDrafts}`);
      if (c.positioning.line) console.log(`positioning "${c.positioning.line}"  banned: ${c.positioning.bannedPhrases.join(" | ") || "(none)"}`);
      for (const w of warnings) console.log(`warning: ${w}`);
      for (const p of problems) console.error(`error: ${p}`);
    });
    process.exitCode = problems.length ? 1 : 0;
  });

program
  .command("probe")
  .description("ask every enabled engine every question (with web search) and record citations")
  .option("--force", "re-run even if today's probe exists")
  .action(async (o) => {
    const c = await ctx();
    const run = c.ledger.startRun("probe", c.date);
    const s = await probe(c.config, c.ledger, run, { force: !!o.force });
    const status = s.enginesOk === 0 ? run.finish("failed") : run.finish();
    out(c, { status, ...s }, () => {
      console.log(`probe ${s.date}${s.reused ? " (reused)" : ""}  status ${status}`);
      for (const e of s.engines)
        console.log(`  ${e.id.padEnd(11)} ${e.ok ? "ok    " : "FAILED"} ${e.model.padEnd(26)} cited ${e.cited}/${e.samples}  mentioned ${e.mentioned}/${e.samples}${e.error ? `  (${e.error})` : ""}`);
      console.log(`citation share ${pct(s.citationShare)}  mention rate ${pct(s.mentionRate)}  over ${s.enginesOk} engine(s)`);
    });
    process.exitCode = exitCodeFor(status);
  });

program
  .command("map")
  .description("citation-source map: which domains AI engines cite for your questions")
  .option("--by-topic", "one table per topic")
  .option("-n, --limit <n>", "rows per table", "15")
  .action(async (o) => {
    const c = await ctx();
    const topics = o.byTopic ? [...new Set(c.config.questions.map((q) => q.topic))] : [undefined];
    const tables = topics.map((t) => ({ topic: t ?? "all", rows: citationMap(c.config, c.ledger, c.date, { topic: t }) }));
    out(c, tables, () => {
      for (const t of tables) {
        console.log(`\n${t.topic}`);
        if (!t.rows.length) console.log("  (no probe data for this date; run `geo-loop probe` first)");
        for (const r of t.rows.slice(0, Number(o.limit)))
          console.log(`  ${(r.self ? "★ " : "  ") + r.domain.padEnd(30)} ${String(r.questions).padStart(3)} q  ${String(r.citations).padStart(4)} cites  ${r.engines.join(",").padEnd(26)} ${r.topUrls[0]?.url ?? ""}`);
      }
    });
  });

// Each command module in src/commands/<name>.cli.ts exports register(program, ctx).
// Modules are optional so slices can be built independently.
const MODULES = ["onboard", "page", "eval", "ship", "revert", "drafts", "report", "run", "steer", "research"];
for (const m of MODULES) {
  const file = new URL(`./commands/${m}.cli.ts`, import.meta.url);
  if (existsSync(file)) {
    const mod = (await import(file.href)) as { register: (p: Command, c: () => Promise<Ctx>) => void };
    mod.register(program, ctx);
  }
}

program.parseAsync().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
