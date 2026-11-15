import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReport, redact, writeReport } from "../src/commands/report.ts";
import type { Ledger } from "../src/lib/ledger.ts";
import { tempLedger, testConfig } from "./helpers.ts";

function seedProbe(ledger: Ledger, date: string, engine: string, cited: number[], urls: string[] = ["https://community.n8n.io/t/x/1"]) {
  const ins = ledger.db.prepare(
    `INSERT INTO probe_answers (run_id, date, question_id, engine, model, sample, answer, cited_urls, cited, mentioned)
     VALUES ('r', ?, 'q1', ?, 'm', ?, 'a', ?, ?, ?)`,
  );
  cited.forEach((c, i) => ins.run(date, engine, i + 1, JSON.stringify(c ? [...urls, "https://synta.io/blog/a"] : urls), c, 1));
}

function seedAll(ledger: Ledger) {
  seedProbe(ledger, "2026-11-14", "claude", [0, 0, 1]);
  seedProbe(ledger, "2026-11-15", "claude", [1, 1, 0]);
  seedProbe(ledger, "2026-11-15", "chatgpt", [0, 0, 0]);
  const now = "2026-11-15T10:00:00.000Z";
  ledger.db
    .prepare("INSERT INTO changes (id, run_id, date, lane, target, status, reason, eval, created_at, updated_at) VALUES (?, 'r', '2026-11-15', ?, ?, ?, ?, ?, ?, ?)")
    .run("chg-abc123", "refresh", "n8n-http-request-node-guide", "shipped", "eval +25 pts", JSON.stringify({ delta: 25 }), now, now);
  ledger.db
    .prepare("INSERT INTO changes (id, run_id, date, lane, target, status, reason, created_at, updated_at) VALUES (?, 'r', '2026-11-14', 'refresh', 'old', 'reverted', '', ?, ?)")
    .run("chg-old999", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:00.000Z");
  ledger.db
    .prepare("INSERT INTO evals (run_id, created_at, subject, question_id, k, wins, win_rate, candidates) VALUES ('r', ?, 'draft:n8n-http', 'q1', 10, 7, 0.7, '[]')")
    .run(now);
  ledger.db
    .prepare("INSERT INTO drafts (id, run_id, date, kind, target_url, body, meta) VALUES ('d1', 'r', '2026-11-15', 'reply', ?, ?, ?)")
    .run("https://reddit.com/r/n8n/comments/abc/x", "Use an Error Trigger.\n\nI run Synta. <script>alert(1)</script>", JSON.stringify({ platform: "reddit", ageUnknown: true }));
}

afterEach(() => vi.unstubAllEnvs());

describe("report", () => {
  it("12.1 renders status, trend chart, map, change log with revert commands, evals, drafts, steer", () => {
    const ledger = tempLedger();
    seedAll(ledger);
    const run = ledger.startRun("daily", "2026-11-15");
    run.shipped("refresh:n8n-http-request-node-guide");
    run.finish();
    const html = buildReport(testConfig(), ledger, { env: {} });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("Latest run: daily on 2026-11-15");
    expect(html).toContain("<svg");
    expect(html).toContain("Citation share");
    expect(html).toMatch(/claude<\/td><td>3<\/td><td>66\.7%/); // 2026-11-15 claude: 2 of 3 cited
    expect(html).toContain("n8n.io");
    expect(html).toContain("geo-loop revert chg-abc123");
    expect(html).not.toContain("geo-loop revert chg-old999"); // already reverted
    expect(html).toContain("70.0%");
    expect(html).toContain("Use an Error Trigger.");
    expect(html).toContain("age unknown");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;"); // draft text escaped
    expect(html).toContain("Weekly steer");
    expect(html).toContain("Not run yet.");
    // self-contained: no external scripts, styles or fonts
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+stylesheet|@import|fonts\.googleapis/);
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain('name="viewport"');
  });

  it("12.1 renders a steer run when the ledger has one", () => {
    const ledger = tempLedger();
    const run = ledger.startRun("steer", "2026-11-15");
    run.note({ level: "info", item: "technique:faq", reason: "insufficient data (3 < 5 uses)" });
    run.finish();
    const html = buildReport(testConfig(), ledger, { env: {} });
    expect(html).toContain("insufficient data (3 &lt; 5 uses)");
    expect(html).not.toContain("Not run yet.");
  });

  it("12.3 partial or failed latest run is shown at the top with its reasons", () => {
    for (const status of ["partial", "failed"] as const) {
      const ledger = tempLedger();
      seedAll(ledger);
      const run = ledger.startRun("daily", "2026-11-15");
      run.note({ level: "held", item: "sanity:refresh", reason: "auth failed" });
      run.finish(status);
      const html = buildReport(testConfig(), ledger, { env: {} });
      const banner = html.indexOf(`class="banner ${status}"`);
      expect(banner).toBeGreaterThan(-1);
      expect(banner).toBeLessThan(html.indexOf("Citation share and mention rate"));
      expect(html).toContain(status.toUpperCase());
      expect(html).toContain("auth failed");
    }
  });

  it("empty ledger renders without errors", () => {
    const html = buildReport(testConfig(), tempLedger(), { env: {} });
    expect(html).toContain("No runs yet");
    expect(html).toContain("No probe data yet.");
  });

  it("12.2 / invariant 6: secrets never appear in the page", () => {
    const secrets = {
      ANTHROPIC_API_KEY: "sk-ant-api03-FAKEFAKEFAKEFAKE1234567890",
      AI_GATEWAY_API_KEY: "vck_fakegatewaykey0123456789abcdef",
      SANITY_WRITE_TOKEN: "skFakeSanityTokenThatIsVeryLongIndeed0123456789abcdefABCDEF",
      GITHUB_TOKEN: "ghp_FakeGithubToken0123456789abcdefgh",
      POSTHOG_PERSONAL_API_KEY: "phx_FakePosthogKey0123456789abcdef",
      GSC_REFRESH_TOKEN: "weird&<secret>value-42",
      OPENAI_API_KEY: "sk-proj-fakeopenai0123456789abcdefghij",
    };
    for (const [k, v] of Object.entries(secrets)) vi.stubEnv(k, v);
    const ledger = tempLedger();
    seedAll(ledger);
    // A leaky error message and a leaky draft, as a bug elsewhere might produce.
    const run = ledger.startRun("daily", "2026-11-15");
    run.note({ level: "error", item: "engine:claude", reason: `401 for key ${secrets.ANTHROPIC_API_KEY}` });
    run.note({ level: "held", item: "sanity", reason: `token ${secrets.SANITY_WRITE_TOKEN} rejected; refresh ${secrets.GSC_REFRESH_TOKEN}` });
    run.finish();
    ledger.db
      .prepare("INSERT INTO drafts (id, run_id, date, kind, target_url, body) VALUES ('d2', 'r', '2026-11-15', 'pitch', 'https://x.com/best', ?)")
      .run(`Authorization: Bearer ${secrets.GITHUB_TOKEN} ${secrets.POSTHOG_PERSONAL_API_KEY} ${secrets.OPENAI_API_KEY}`);

    const dir = mkdtempSync(join(tmpdir(), "geo-loop-report-"));
    const file = writeReport(testConfig(), ledger, dir); // default env = process.env
    expect(file).toBe(join(dir, "index.html"));
    const html = readFileSync(file, "utf8");
    for (const v of Object.values(secrets)) {
      expect(html).not.toContain(v);
      expect(html).not.toContain(v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    }
    expect(html).toContain("[redacted]");
  });

  it("redact also catches well-known token shapes not present in env", () => {
    expect(redact("key sk-ant-api03-abcdefghijklmnop and ghp_abcdefghijklmnopqrstuvwxyz", {})).toBe("key [redacted] and [redacted]");
  });

  it("writeReport defaults to <dataDir>/report/index.html", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "geo-loop-data-"));
    const file = writeReport(testConfig({ dataDir }), tempLedger());
    expect(file).toBe(join(dataDir, "report", "index.html"));
    expect(existsSync(file)).toBe(true);
  });
});
