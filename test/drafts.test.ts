import { describe, expect, it } from "vitest";
import { generateDrafts, type DraftRequest } from "../src/commands/drafts.ts";
import { classifyUrl, type FetchFn } from "../src/lib/fetchmeta.ts";
import type { Ledger, RunNote } from "../src/lib/ledger.ts";
import { tempLedger, testConfig } from "./helpers.ts";

const DATE = "2026-11-15";
const NOW = new Date("2026-11-15T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function seed(ledger: Ledger, rows: { q: string; engine?: string; urls: string[] }[]) {
  const ins = ledger.db.prepare(
    `INSERT INTO probe_answers (run_id, date, question_id, engine, model, sample, answer, cited_urls, cited, mentioned)
     VALUES ('seed', ?, ?, ?, 'fixture', ?, 'a', ?, 0, 0)`,
  );
  rows.forEach((r, i) => ins.run(DATE, r.q, r.engine ?? "claude", i + 1, JSON.stringify(r.urls)));
}

type Call = { url: string; init?: RequestInit };
function fakeFetch(routes: Record<string, unknown | ((url: string) => Response)>) {
  const calls: Call[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const hit = routes[url];
    if (hit === undefined) return new Response("not found", { status: 404 });
    if (typeof hit === "function") return (hit as (u: string) => Response)(url);
    if (typeof hit === "string") return new Response(hit, { headers: { "content-type": "text/html" } });
    return Response.json(hit);
  };
  return { fn, calls };
}

const reddit = (created: Date, extra: Record<string, unknown> = {}) => [
  { data: { children: [{ data: { title: "How do I keep n8n flows from silently failing?", selftext: "they die at night", created_utc: created.getTime() / 1000, locked: false, archived: false, ...extra } }] } },
];
const discourse = (created: Date, extra: Record<string, unknown> = {}) => ({
  title: "Google Sheets append row not working",
  created_at: created.toISOString(),
  closed: false,
  archived: false,
  post_stream: { posts: [{ cooked: "<p>Append row does nothing</p>" }] },
  ...extra,
});

function fakeDrafter(texts: (req: DraftRequest, n: number) => string) {
  const reqs: DraftRequest[] = [];
  return {
    reqs,
    drafter: async (req: DraftRequest) => {
      reqs.push(req);
      return texts(req, reqs.length - 1);
    },
  };
}

const notes = (ledger: Ledger, runId: string) =>
  JSON.parse((ledger.db.prepare("SELECT notes FROM runs WHERE id = ?").get(runId) as { notes: string }).notes) as RunNote[];
const draftRows = (ledger: Ledger) =>
  ledger.db.prepare("SELECT * FROM drafts ORDER BY id").all() as { kind: string; target_url: string; body: string; meta: string; status: string }[];

const REDDIT = "https://reddit.com/r/n8n/comments/abc123/how_do_i_keep_flows_alive";
const REDDIT_JSON = "https://www.reddit.com/r/n8n/comments/abc123/how_do_i_keep_flows_alive.json?raw_json=1";
const FORUM = "https://community.n8n.io/t/google-sheets-append-row/4242";
const FORUM_JSON = "https://community.n8n.io/t/4242.json";
const LISTICLE = "https://blog.example.com/best-n8n-alternatives";

describe("classifyUrl", () => {
  it("recognizes threads, listicles and non-targets by URL pattern", () => {
    expect(classifyUrl(REDDIT)).toEqual({ kind: "thread", platform: "reddit" });
    expect(classifyUrl(FORUM)).toEqual({ kind: "thread", platform: "discourse" });
    expect(classifyUrl("https://stackoverflow.com/questions/123/n8n-http")).toEqual({ kind: "thread", platform: "stackexchange" });
    expect(classifyUrl("https://github.com/n8n-io/n8n/discussions/99")).toEqual({ kind: "thread", platform: "github" });
    expect(classifyUrl("https://news.ycombinator.com/item?id=1")).toEqual({ kind: "thread", platform: "hn" });
    expect(classifyUrl(LISTICLE)).toEqual({ kind: "article" });
    expect(classifyUrl("https://zapier.com/blog/n8n-vs-make")).toEqual({ kind: "article" });
    expect(classifyUrl("https://example.com/blog/why-we-moved")).toEqual({ kind: "maybe-article" });
    expect(classifyUrl("https://docs.n8n.io/integrations/sheets")).toEqual({ kind: "other" });
    expect(classifyUrl("https://n8n.io/")).toEqual({ kind: "other" });
  });
});

describe("drafts", () => {
  it("7.1 reply draft answers first, discloses 'I run Synta' when Synta is mentioned, keeps the thread link", async () => {
    const config = testConfig();
    const ledger = tempLedger();
    seed(ledger, [{ q: "q1", urls: [REDDIT, FORUM, "https://synta.io/blog/x", "https://docs.n8n.io/x"] }]);
    const { fn } = fakeFetch({ [REDDIT_JSON]: reddit(daysAgo(30)), [FORUM_JSON]: discourse(daysAgo(10)) });
    const d = fakeDrafter((req) => (req.prompt.includes("reddit") ? "Add an Error Trigger workflow. Synta can watch it too." : "Use the Append or Update operation with a header row."));
    const run = ledger.startRun("drafts", DATE);
    const s = await generateDrafts(config, ledger, run, { fetch: fn, drafter: d.drafter, now: NOW });
    expect(s.drafted.map((x) => x.targetUrl).sort()).toEqual([FORUM, REDDIT].sort());
    const rows = draftRows(ledger);
    const r = rows.find((x) => x.target_url === REDDIT)!;
    expect(r.kind).toBe("reply");
    expect(r.body.startsWith("Add an Error Trigger")).toBe(true);
    expect(r.body).toContain("I run Synta");
    const f = rows.find((x) => x.target_url === FORUM)!;
    expect(f.body).not.toContain("I run Synta"); // no brand mention, no disclosure needed
    expect(JSON.parse(f.meta)).toMatchObject({ platform: "discourse", ageDays: 10, ageUnknown: false, questionIds: ["q1"] });
    expect(d.reqs[0].system).toContain("Answer the asker's actual question first");
    expect(d.reqs[0].prompt).toContain("<source>"); // thread text fenced as untrusted data
    expect(run.finish()).toBe("ok");
  });

  it("7.2 pitch to a listicle that cites competitors but not the brand, with the article URL and a reason", async () => {
    const config = testConfig({ competitors: { reliability: ["https://kestra.io", "https://make.com"] } });
    const ledger = tempLedger();
    const MENTIONS = "https://example.org/top-10-n8n-tools";
    const NOCOMP = "https://example.net/best-pizza-ovens";
    seed(ledger, [{ q: "q1", urls: [LISTICLE, MENTIONS, NOCOMP] }]);
    const { fn } = fakeFetch({
      [LISTICLE]: `<html><head><title>Best n8n alternatives in 2026</title><meta name="author" content="Jane Doe"></head><body><a href="https://kestra.io">Kestra</a> and Make.</body></html>`,
      [MENTIONS]: `<html><title>Top 10 n8n tools</title><body>Synta keeps n8n running. <a href="https://kestra.io">Kestra</a></body></html>`,
      [NOCOMP]: `<html><title>Best pizza ovens</title><body>ovens</body></html>`,
    });
    const d = fakeDrafter(() => "Subject: n8n reliability for your list\n\nHi Jane, I run Synta. Your readers comparing Kestra would want a way to keep n8n running.");
    const run = ledger.startRun("drafts", DATE);
    const s = await generateDrafts(config, ledger, run, { fetch: fn, drafter: d.drafter, now: NOW });
    expect(s.drafted).toHaveLength(1);
    const p = draftRows(ledger)[0];
    expect(p).toMatchObject({ kind: "pitch", target_url: LISTICLE, status: "new" });
    expect(p.body).toContain(LISTICLE); // appended by code when the model leaves it out
    expect(p.body).toContain("I run Synta");
    expect(JSON.parse(p.meta)).toMatchObject({ author: "Jane Doe", competitors: ["kestra", "make"] });
    expect(d.reqs[0].system).toContain("why Synta fits");
    expect(d.reqs[0].prompt).toContain("Author: Jane Doe");
    const reasons = s.skipped.map((x) => `${x.url} ${x.reason}`);
    expect(reasons).toContain(`${MENTIONS} article already mentions Synta`);
    expect(reasons).toContain(`${NOCOMP} article cites no configured competitor`);
  });

  it("7.3 nothing is posted or sent: only unauthenticated GETs, no credentials in config", async () => {
    const config = testConfig({ competitors: { reliability: ["https://kestra.io"] } });
    const ledger = tempLedger();
    seed(ledger, [{ q: "q1", urls: [REDDIT, FORUM, LISTICLE] }]);
    const { fn, calls } = fakeFetch({
      [REDDIT_JSON]: reddit(daysAgo(1)),
      [FORUM_JSON]: discourse(daysAgo(1)),
      [LISTICLE]: `<title>Best n8n alternatives</title><a href="https://kestra.io">k</a>`,
    });
    const d = fakeDrafter(() => "Helpful answer.");
    await generateDrafts(config, ledger, ledger.startRun("drafts", DATE), { fetch: fn, drafter: d.drafter, now: NOW });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.init?.method ?? "GET").toBe("GET");
      expect(c.init?.body).toBeUndefined();
      const h = new Headers(c.init?.headers);
      expect(h.has("authorization")).toBe(false);
      expect(h.has("cookie")).toBe(false);
    }
    expect(JSON.stringify(config)).not.toMatch(/reddit|password|cookie|oauth/i);
  });

  it("7.4 skips old, locked and archived threads with a logged reason; unknown age is kept and marked", async () => {
    const config = testConfig();
    const ledger = tempLedger();
    const OLD = "https://reddit.com/r/n8n/comments/old111/x";
    const LOCKED = "https://reddit.com/r/n8n/comments/lck222/x";
    const CLOSED = "https://community.n8n.io/t/closed-topic/77";
    const UNKNOWN = "https://forum.example.com/threads/n8n-help.55";
    seed(ledger, [{ q: "q1", urls: [OLD, LOCKED, CLOSED, UNKNOWN] }]);
    const { fn } = fakeFetch({
      "https://www.reddit.com/r/n8n/comments/old111/x.json?raw_json=1": reddit(daysAgo(400)),
      "https://www.reddit.com/r/n8n/comments/lck222/x.json?raw_json=1": reddit(daysAgo(5), { locked: true }),
      "https://community.n8n.io/t/77.json": discourse(daysAgo(5), { closed: true }),
    });
    const d = fakeDrafter(() => "Answer.");
    const run = ledger.startRun("drafts", DATE);
    const s = await generateDrafts(config, ledger, run, { fetch: fn, drafter: d.drafter, now: NOW });
    expect(s.skipped).toEqual(
      expect.arrayContaining([
        { url: OLD, reason: "thread is 400 days old (max 365)" },
        { url: LOCKED, reason: "thread is locked" },
        { url: CLOSED, reason: "thread is closed" },
      ]),
    );
    expect(s.drafted.map((x) => x.targetUrl)).toEqual([UNKNOWN]);
    expect(s.drafted[0].meta).toMatchObject({ ageUnknown: true });
    run.finish();
    const n = notes(ledger, run.id);
    expect(n.filter((x) => x.level === "skipped")).toHaveLength(3);
    expect(n.some((x) => x.level === "info" && /age unknown/.test(x.reason))).toBe(true);
  });

  it("positioning: a banned phrase is regenerated once, then held if it persists", async () => {
    const config = testConfig();
    const ledger = tempLedger();
    const A = "https://reddit.com/r/n8n/comments/aaa/x";
    const B = "https://reddit.com/r/n8n/comments/bbb/x";
    seed(ledger, [{ q: "q1", urls: [A] }, { q: "q2", urls: [B] }]);
    const { fn } = fakeFetch({
      "https://www.reddit.com/r/n8n/comments/aaa/x.json?raw_json=1": reddit(daysAgo(1)),
      "https://www.reddit.com/r/n8n/comments/bbb/x.json?raw_json=1": reddit(daysAgo(1)),
    });
    const d = fakeDrafter((req, n) => {
      if (req.prompt.includes("/aaa/")) return n === 0 ? "Synta is an MCP layer for n8n." : "Synta keeps n8n running.";
      return "It is basically an mcp layer.";
    });
    const run = ledger.startRun("drafts", DATE);
    const s = await generateDrafts(config, ledger, run, { fetch: fn, drafter: d.drafter, now: NOW });
    expect(d.reqs).toHaveLength(4);
    expect(d.reqs[1].prompt).toContain('banned phrase "MCP layer"');
    expect(s.drafted.map((x) => x.targetUrl)).toEqual([A]);
    expect(s.drafted[0].body).not.toMatch(/mcp layer/i);
    expect(s.drafted[0].meta.regenerated).toBe(true);
    expect(s.held).toEqual([{ url: B, reason: 'banned phrase "MCP layer" after one regeneration' }]);
    expect(draftRows(ledger).find((r) => r.target_url === B)?.status).toBe("held");
  });

  it("caps drafts per day, and a second run the same day does not redraft", async () => {
    const config = testConfig({ caps: { newPosts: 1, refreshes: 2, codePrs: 1, offsiteDrafts: 2 } });
    const ledger = tempLedger();
    const urls = ["a1", "a2", "a3", "a4"].map((id) => `https://reddit.com/r/n8n/comments/${id}/x`);
    seed(ledger, [{ q: "q1", urls }]);
    const routes = Object.fromEntries(urls.map((u) => [`${u.replace("reddit.com", "www.reddit.com")}.json?raw_json=1`, reddit(daysAgo(1))]));
    const { fn } = fakeFetch(routes);
    const d = fakeDrafter(() => "Answer.");
    const s1 = await generateDrafts(config, ledger, ledger.startRun("drafts", DATE), { fetch: fn, drafter: d.drafter, now: NOW });
    expect(s1.drafted).toHaveLength(2);
    expect(s1.skipped).toEqual([{ url: "2 target(s)", reason: "daily off-site draft cap reached (2); left for tomorrow" }]);
    const s2 = await generateDrafts(config, ledger, ledger.startRun("drafts", DATE), { fetch: fn, drafter: d.drafter, now: NOW });
    expect(s2.drafted).toHaveLength(0);
    expect(draftRows(ledger)).toHaveLength(2);
  });

  it("--dry-run stores nothing; drafter errors hold the item and mark the run partial", async () => {
    const config = testConfig();
    const ledger = tempLedger();
    seed(ledger, [{ q: "q1", urls: [REDDIT] }]);
    const { fn } = fakeFetch({ [REDDIT_JSON]: reddit(daysAgo(1)) });
    const ok = fakeDrafter(() => "Answer.");
    const s = await generateDrafts(config, ledger, ledger.startRun("drafts", DATE), { fetch: fn, drafter: ok.drafter, now: NOW, dryRun: true });
    expect(s.drafted).toHaveLength(1);
    expect(draftRows(ledger)).toHaveLength(0);

    const run = ledger.startRun("drafts", DATE);
    const s2 = await generateDrafts(config, ledger, run, {
      fetch: fn, now: NOW,
      drafter: async () => { throw new Error("401 bad key sk-ant-api03-leakedleakedleaked"); },
    });
    expect(s2.held[0].reason).toContain("draft generation failed");
    expect(s2.held[0].reason).not.toContain("leakedleaked");
    expect(run.finish()).toBe("partial");
  });

  it("no probe data: logs a reason instead of running silently", async () => {
    const ledger = tempLedger();
    const run = ledger.startRun("drafts", DATE);
    const s = await generateDrafts(testConfig(), ledger, run, { fetch: fakeFetch({}).fn, drafter: fakeDrafter(() => "x").drafter });
    expect(s.drafted).toHaveLength(0);
    run.finish();
    expect(notes(ledger, run.id)[0].reason).toMatch(/no third-party citations/);
  });
});
