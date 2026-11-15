import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import type { Ctx } from "../cli.js";
import type { Config } from "../config.js";
import { redact, secretValues } from "../lib/gates.js";
import { githubClient, type GithubPort, type LocalCheck } from "../lib/github.js";
import { exitCodeFor } from "../lib/ledger.js";
import { sanityClient, sanityDataset, type SanityPort } from "../lib/sanity.js";
import { loadProductFacts, shipChange, shipExitCode, type ShipResult } from "./ship.js";

export function makeSanityFor(config: Config): (dataset: string) => SanityPort | undefined {
  return (dataset) => (config.sanity ? sanityClient(config, { dataset, token: process.env.SANITY_WRITE_TOKEN || undefined }) : undefined);
}

export function makeGithub(config: Config): GithubPort | undefined {
  const token = process.env.GITHUB_TOKEN;
  return config.github && token ? githubClient({ repo: config.github.repo, token }) : undefined;
}

export function previewHeaders(): Record<string, string> | undefined {
  const b = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return b ? { "x-vercel-protection-bypass": b } : undefined;
}

/**
 * Local build/typecheck for a code PR (6.9): a throwaway `git worktree` of `repoDir` HEAD with the
 * change's files applied, node_modules symlinked, then `cmd` run there. The checkout itself is untouched.
 */
export function worktreeLocalCheck(repoDir: string, cmd: string): LocalCheck {
  return async ({ files }) => {
    const tmp = mkdtempSync(join(tmpdir(), "geo-loop-wt-"));
    const wt = join(tmp, "wt");
    const git = (...args: string[]) => spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
    const add = git("worktree", "add", "--detach", wt, "HEAD");
    if (add.status !== 0) return { ok: false, output: `git worktree add failed: ${add.stderr}` };
    try {
      for (const f of files) {
        const p = join(wt, f.path);
        if (f.content === null) rmSync(p, { force: true });
        else {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, f.content);
        }
      }
      const nm = join(resolve(repoDir), "node_modules");
      if (existsSync(nm) && !existsSync(join(wt, "node_modules"))) symlinkSync(nm, join(wt, "node_modules"));
      const r = spawnSync(cmd, { cwd: wt, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return { ok: r.status === 0, output: redact(`${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-2000), secretValues()) };
    } finally {
      git("worktree", "remove", "--force", wt);
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

export function localCheckFromOpts(o: { localCheckPassed?: boolean; repoDir?: string; buildCmd: string }): LocalCheck | undefined {
  if (o.localCheckPassed) return async () => ({ ok: true, output: "--local-check-passed" });
  if (o.repoDir) return worktreeLocalCheck(o.repoDir, o.buildCmd);
  return undefined;
}

const DEFAULT_BUILD = "npx tsc --noEmit && npx next build";

export function register(program: Command, ctx: () => Promise<Ctx>) {
  program
    .command("ship")
    .description("gate, snapshot, write and post-check one change (or an array of changes) from a change.json")
    .requiredOption("--change <file>", "change.json (one change or an array)")
    .option("--dry-run", "run gates and reads, print the exact payload, write nothing external")
    .option("--test-dataset", "write to config.sanity.testDataset instead of the production dataset")
    .option("--preview-url <url>", "code PR: Vercel preview URL (otherwise discovered from the PR's deployment status)")
    .option("--repo-dir <dir>", "code PR: local checkout used for the build/typecheck merge gate")
    .option("--build-cmd <cmd>", "code PR: build/typecheck command run in a worktree of --repo-dir", DEFAULT_BUILD)
    .option("--local-check-passed", "code PR: the caller already ran build + typecheck on these files and they passed")
    .action(async (o) => {
      const c = await ctx();
      const raw = JSON.parse(readFileSync(o.change, "utf8")) as unknown;
      const changes = Array.isArray(raw) ? raw : [raw];
      const run = c.ledger.startRun("ship", c.date);
      const dataset = c.config.sanity ? sanityDataset(c.config, !!o.testDataset) : undefined;
      const sanity = dataset ? makeSanityFor(c.config)(dataset) : undefined;
      const results: ShipResult[] = [];
      for (const ch of changes) {
        results.push(
          await shipChange(ch, {
            config: c.config,
            ledger: c.ledger,
            run,
            date: c.date,
            sanity,
            github: makeGithub(c.config),
            productFacts: loadProductFacts(c.config),
            // config.shipMode "dry_run" forces a dry run (e.g. a new routine's first runs).
            dryRun: !!o.dryRun || c.config.shipMode === "dry_run",
            testDataset: !!o.testDataset,
            localCheck: localCheckFromOpts(o),
            previewUrl: o.previewUrl,
            previewHeaders: previewHeaders(),
            log: c.json ? () => {} : console.log,
          }),
        );
      }
      const status = run.finish();
      if (c.json) console.log(JSON.stringify({ run: run.id, status, results }, null, 2));
      const codes = results.map(shipExitCode);
      process.exitCode = codes.includes(1) ? 1 : codes.includes(2) ? 2 : exitCodeFor(status) === 1 ? 1 : 0;
    });
}
