import { dirname, resolve } from "node:path";
import type { Command } from "commander";
import type { Ctx } from "../cli.js";
import { loadConfig } from "../config.js";
import { Ledger } from "../lib/ledger.js";
import { applySuggestions, defaultSuggestDeps, readQuestionsFile, suggestQuestions, writeQuestionsFile } from "./questions.js";

export function register(program: Command, _ctx: () => Promise<Ctx>) {
  const q = program.command("questions").description("the buyer questions the probe asks: list them, or discover new ones from real search data");

  q.command("list")
    .description("show every question and where it came from")
    .action(async () => {
      const { config, questionsFile } = await loadConfig(program.opts().config, process.cwd(), { allowNoQuestions: true });
      const core = new Set(questionsFile?.core.map((x) => x.id) ?? []);
      const explore = new Set(questionsFile?.explore.map((x) => x.id) ?? []);
      console.log(`mode ${questionsFile?.mode ?? "user"}  (${config.questions.length} questions)`);
      for (const x of config.questions) {
        const tier = explore.has(x.id) ? "explore" : core.has(x.id) ? "core" : "config";
        console.log(`  ${x.id.padEnd(12)} ${tier.padEnd(8)} ${x.source.padEnd(12)} ${x.text}`);
      }
    });

  q.command("suggest")
    .description("rank candidate questions from Search Console, engine-issued searches, Google autocomplete and cited threads")
    .option("-n, --limit <n>", "rows to print", "30")
    .option("--write", "update questions.json per its mode (data: fill core once, refresh explore; hybrid: refresh explore)")
    .option("--mode <mode>", "set questions.json mode before writing: user | data | hybrid")
    .option("--force", "write even in user mode")
    .action(async (o: { limit: string; write?: boolean; mode?: string; force?: boolean }) => {
      const { config, path } = await loadConfig(program.opts().config, process.cwd(), { allowNoQuestions: true });
      const ledger = new Ledger(resolve(config.dataDir, "ledger.db"));
      const { candidates, notes } = await suggestQuestions(config, ledger, defaultSuggestDeps(config));
      const json = !!program.opts().json;
      if (json) console.log(JSON.stringify({ notes, candidates }, null, 2));
      else {
        for (const n of notes) console.log(`# ${n}`);
        for (const c of candidates.slice(0, Number(o.limit)))
          console.log(`${c.score.toFixed(1).padStart(5)}  ${c.sources.join("+").padEnd(20)} ${c.topic.padEnd(12)} ${c.text}`);
      }
      if (!o.write) return;
      const file = resolve(dirname(path), config.questionsFile);
      const current = readQuestionsFile(file);
      if (o.mode) {
        if (!["user", "data", "hybrid"].includes(o.mode)) throw new Error("--mode must be user, data or hybrid");
        current.mode = o.mode as typeof current.mode;
      }
      if (current.mode === "user" && !o.force) {
        console.error(`${config.questionsFile} is in user mode: your questions are left alone. Use --mode data|hybrid (or --force).`);
        process.exitCode = 2;
        return;
      }
      const next = applySuggestions(current, candidates, config);
      writeQuestionsFile(file, next);
      if (!json) console.log(`wrote ${file}: mode ${next.mode}, ${next.core.length} core, ${next.explore.length} explore`);
    });
}
