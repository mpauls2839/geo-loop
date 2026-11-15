import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDashboard } from "../src/commands/dashboard.ts";
import { tempLedger, testConfig } from "./helpers.ts";

describe("dashboard", () => {
  it("renders KPIs, per-engine, map, searches, proposals with verdicts, drafts, runs; no secrets", () => {
    const config = testConfig({ shipMode: "dry_run" });
    const ledger = tempLedger();
    const ins = ledger.db.prepare(
      "INSERT INTO probe_answers (run_id, date, question_id, engine, model, sample, answer, cited_urls, cited, mentioned) VALUES ('r','2026-11-15',?,?,'m',?,'',?,?,?)",
    );
    ins.run("q1", "claude", 1, JSON.stringify(["https://synta.io/blog/a", "https://docs.n8n.io/x"]), 1, 0);
    ins.run("q1", "claude", 2, JSON.stringify(["https://docs.n8n.io/y"]), 0, 1);
    ins.run("q2", "perplexity", 1, JSON.stringify(["https://kestra.io/vs"]), 0, 0);
    ledger.db.prepare("INSERT INTO engine_queries (date, question_id, engine, query) VALUES ('2026-11-15','q1','claude','n8n error trigger')").run();
    ledger.db.prepare("INSERT INTO drafts (id, date, kind, target_url, body) VALUES ('d1','2026-11-15','reply','https://community.n8n.io/t/x/1','Use the Error Trigger. I run Synta.')").run();
    ledger.startRun("probe", "2026-11-15").finish("ok");
    const dir = mkdtempSync(join(tmpdir(), "prop-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "post-a.change.json"), JSON.stringify({ target: "post-a", techniques: ["answer-first"], content: { title: "Better title" } }));
    writeFileSync(join(dir, "post-a.eval.json"), JSON.stringify({ rows: [{ questionId: "q1", live: { winRate: 0 }, draft: { winRate: 1 } }], decision: { verdict: "pass", reason: "avg delta +100 pts" } }));
    writeFileSync(join(dir, "post-a.ship-dry-run.txt"), "dry_run     2026-11-15-refresh-post-a  dry_run\npayload {}");
    writeFileSync(join(dir, "post-b.change.json"), JSON.stringify({ target: "post-b" }));
    writeFileSync(join(dir, "post-b.ship-dry-run.txt"), "held        2026-11-15-refresh-post-b  no CTA link in the body\n");

    const html = buildDashboard(config, ledger, { date: "2026-11-15", proposedDir: dir, env: { SANITY_WRITE_TOKEN: "sk-secret-value-123456" } });
    expect(html).toContain("33.3%"); // 1 of 3 answers cites synta.io
    expect(html).toContain("names Synta");
    expect(html).toContain("docs.n8n.io".replace("docs.", "")); // n8n.io domain bar
    expect(html).toContain("n8n error trigger");
    expect(html).toMatch(/WOULD SHIP[\s\S]*\/post-a[\s\S]*10\/10/);
    expect(html).toContain("Held: no CTA link in the body");
    expect(html).toContain("community.n8n.io");
    expect(html).not.toContain("sk-secret-value-123456");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("DRY RUN");
    expect(html).toContain('href="https://synta.io/blog/post-a"'); // no PR: links the live post
    expect(html).toContain('href="https://community.n8n.io/t/x/1"'); // outreach card links the real thread
    ledger.db.prepare("INSERT INTO changes (id, date, lane, target, status, external_ref, created_at, updated_at) VALUES ('2026-11-15-refresh-post-a','2026-11-15','refresh','post-a','shipped',?, 'x','x')")
      .run(JSON.stringify({ prUrl: "https://github.com/o/r/pull/7", pr: 7 }));
    expect(buildDashboard(config, ledger, { date: "2026-11-15", proposedDir: dir })).toContain('href="https://github.com/o/r/pull/7"');
    const live = buildDashboard(testConfig(), ledger, { date: "2026-11-15", proposedDir: dir });
    expect(live).toContain("✓ SHIPPED");
  });
});
