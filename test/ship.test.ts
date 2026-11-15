import { describe, expect, it } from "vitest";
import { queuedChanges, recordChange, shipChange, type ShipDeps } from "../src/commands/ship.ts";
import type { FileChange, GithubPort } from "../src/lib/github.ts";
import { renderTitleCardPng } from "../src/lib/ogimage.ts";
import { SanityAuthError, type ExistingPost, type FieldMap, type SanityDoc, type SanityPort } from "../src/lib/sanity.ts";
import { ptToText } from "../src/lib/gates.ts";
import { tempLedger, testConfig } from "./helpers.ts";

// ---------- fakes (no network, no Sanity, no GitHub) ----------

const DATE = "2026-11-15";
const SECRET = "sk-test-secret-value-123";
const noSleep = async () => {};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

class FakeSanity implements SanityPort {
  dataset = "production";
  canWrite = true;
  docs = new Map<string, SanityDoc>();
  assets: { filename: string; data: Buffer }[] = [];
  writes: string[] = [];
  beforeWrite?: (op: string, id: string) => void;
  failWith?: Error;
  failUpload?: Error;
  put(d: SanityDoc) {
    this.docs.set(d._id, clone(d));
  }
  private write(op: string, id: string) {
    this.beforeWrite?.(op, id);
    if (this.failWith) throw this.failWith;
    this.writes.push(`${op}:${id}`);
  }
  async getPublishedBySlug(type: string, f: string, slug: string) {
    if (this.failWith instanceof SanityAuthError) throw this.failWith;
    const d = [...this.docs.values()].find((x) => x._type === type && !x._id.startsWith("drafts.") && (x[f] as { current?: string })?.current === slug);
    return d ? clone(d) : null;
  }
  async getDocument(id: string) {
    const d = this.docs.get(id);
    return d ? clone(d) : null;
  }
  async listPosts(type: string, f: FieldMap): Promise<ExistingPost[]> {
    return [...this.docs.values()]
      .filter((d) => d._type === type && !d._id.startsWith("drafts."))
      .map((d) => ({ id: d._id, slug: (d[f.slug] as { current: string }).current, title: d[f.title] as string, text: [d[f.title], d[f.excerpt], ptToText(d[f.body])].join("\n") }));
  }
  async latestAuthorRef() {
    return "author-mike";
  }
  async createOrReplace(doc: SanityDoc) {
    this.write("createOrReplace", doc._id);
    this.put({ ...doc, _rev: "r2", _updatedAt: "now" });
  }
  async patchSet(id: string, set: Record<string, unknown>) {
    this.write("patch", id);
    this.put({ ...this.docs.get(id)!, ...set, _rev: "r3" });
  }
  async unpublish(id: string) {
    this.write("unpublish", id);
    const d = this.docs.get(id);
    if (!d) return;
    this.docs.delete(id);
    this.put({ ...d, _id: `drafts.${id}` });
  }
  async uploadImage(data: Buffer, filename: string) {
    if (this.failUpload) throw this.failUpload;
    this.write("upload", filename);
    this.assets.push({ filename, data });
    return { assetId: `image-${this.assets.length}-1200x630-png`, url: `https://cdn.sanity.io/images/p/d/${this.assets.length}.png` };
  }
}

/** Fake synta.io: renders whatever is published in the fake dataset (or a frozen copy when stale). */
function siteFetch(sanity: FakeSanity, opts: { stale?: boolean } = {}) {
  const frozen = new Map(sanity.docs);
  const requested: string[] = [];
  const f = async (url: string) => {
    requested.push(url);
    if (url.startsWith("https://cdn.sanity.io/")) return new Response("png", { status: 200, headers: { "content-type": "image/png" } });
    const m = url.match(/^https:\/\/synta\.io\/blog\/(.+)$/);
    const docs = opts.stale ? frozen : sanity.docs;
    const d = m && [...docs.values()].find((x) => !x._id.startsWith("drafts.") && (x.slug as { current: string })?.current === m[1]);
    if (!d) return new Response("not found", { status: 404 });
    const links = ((d.body as { markDefs?: { href?: string }[] }[]) ?? []).flatMap((b) => b.markDefs ?? []).map((x) => `<a href="${x.href}">x</a>`);
    const html = `<html><head><title>${d.title} | Synta</title><meta name="description" content="${(d.excerpt as string) || d.title}"></head><body>${links.join("")}</body></html>`;
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  };
  return Object.assign(f, { requested });
}

class FakeGithub implements GithubPort {
  repo = "Synta-ai/synta-web-app";
  files = new Map<string, string>([["app/robots.ts", "export default robots"]]);
  branches = new Map<string, FileChange[]>();
  prs: { number: number; head: string; body: string; title: string; merged: boolean }[] = [];
  comments: { number: number; body: string }[] = [];
  calls: string[] = [];
  preview: string | null = "https://synta-pr.vercel.app";
  async getFile(path: string) {
    this.calls.push(`get:${path}`);
    const c = this.files.get(path);
    return c === undefined ? null : { content: c, sha: "s" };
  }
  async getBranchSha() {
    return "base";
  }
  async createBranchWithFiles(o: { branch: string; files: FileChange[] }) {
    this.calls.push(`branch:${o.branch}`);
    this.branches.set(o.branch, o.files);
    return { commitSha: `c-${o.branch}` };
  }
  async openPr(o: { title: string; head: string; body: string }) {
    const n = this.prs.length + 1;
    this.prs.push({ number: n, head: o.head, body: o.body, title: o.title, merged: false });
    return { number: n, url: `https://github.com/x/pull/${n}`, headSha: `sha-${n}` };
  }
  async comment(number: number, body: string) {
    this.comments.push({ number, body });
  }
  async squashMerge(n: number) {
    const pr = this.prs[n - 1];
    pr.merged = true;
    for (const f of this.branches.get(pr.head) ?? []) f.content === null ? this.files.delete(f.path) : this.files.set(f.path, f.content);
    return { sha: `merge-${n}` };
  }
  async findPreviewUrl() {
    return this.preview;
  }
}

/** Fake Vercel: preview + production serve llms.txt / robots.txt as text/plain. */
function vercelFetch(o: { prodOk?: boolean; previewOk?: boolean } = {}) {
  return async (url: string) => {
    const prod = url.startsWith("https://synta.io");
    const ok = prod ? o.prodOk !== false : o.previewOk !== false;
    if (!ok) return new Response("err", { status: 500 });
    return new Response(url.endsWith(".txt") ? "text" : "<html></html>", { status: 200, headers: { "content-type": url.endsWith(".txt") ? "text/plain; charset=utf-8" : "text/html" } });
  };
}

// ---------- fixtures ----------

const config = (over: Record<string, unknown> = {}) =>
  testConfig({
    positioning: { line: "n8n builds it. Synta keeps it running.", bannedPhrases: ["MCP layer", "AI builds your workflow from plain English"] },
    sanity: { projectId: "jincnh50" },
    github: { repo: "Synta-ai/synta-web-app", allowlist: ["app/llms.txt", "public/llms.txt", "app/robots.ts", "app/sitemap.ts"] },
    ...over,
  });

const h2 = (t: string) => ({ _type: "block", style: "h2", children: [{ _type: "span", text: t }] });
const p = (t: string) => ({ _type: "block", style: "normal", children: [{ _type: "span", text: t }] });
const cta = (t = "Keep it running with Synta") => ({
  _type: "block",
  style: "normal",
  markDefs: [{ _key: "cta", _type: "link", href: "https://synta.io/signup" }],
  children: [{ _type: "span", text: t, marks: ["cta"] }],
});

const livePost = (slug: string): SanityDoc => ({
  _id: `post-${slug}`,
  _type: "post",
  _rev: "r1",
  title: "Old title",
  slug: { _type: "slug", current: slug },
  excerpt: "Old excerpt",
  body: [h2("Why it fails"), p("The page had 6,772 impressions."), h2("Fix 1"), h2("Fix 2")],
});

const refresh = (slug: string, over: Record<string, unknown> = {}, content: Record<string, unknown> = {}) => ({
  lane: "refresh",
  target: slug,
  reason: "low CTR on high impressions",
  eval: { decision: "pass", delta: 25 },
  techniques: ["answer-first", "faq"],
  sources: [{ url: "https://n8n.io/docs", text: "n8n retries up to 5 times" }],
  content: { title: "New title", excerpt: "New excerpt", body: [h2("Why it fails"), p("Retry up to 5 times."), h2("Fix 1"), h2("Fix 2"), cta()], ...content },
  ...over,
});

const newPost = (slug: string, over: Record<string, unknown> = {}, content: Record<string, unknown> = {}) => ({
  lane: "new_post",
  target: slug,
  mainQuery: "n8n webhook timeout",
  reason: "uncovered question",
  eval: { decision: "pass", winRate: 0.5 },
  techniques: ["answer-first"],
  content: {
    title: "Fix n8n webhook timeouts",
    slug,
    excerpt: "Why n8n webhooks time out in queue mode and three ways to stop it, step by step for self-hosted setups.",
    body: [h2("Why webhooks time out"), p("Queue mode moves execution to workers."), cta()],
    categoryRef: "cat-troubleshooting",
    ...content,
  },
  ...over,
});

function setup(cfgOver: Record<string, unknown> = {}) {
  const cfg = config(cfgOver);
  const ledger = tempLedger();
  const run = ledger.startRun("ship", DATE);
  const sanity = new FakeSanity();
  sanity.put({ _id: "cat-troubleshooting", _type: "category", title: "Troubleshooting" });
  const github = new FakeGithub();
  const logs: string[] = [];
  const deps = (extra: Partial<ShipDeps> = {}): ShipDeps => ({
    config: cfg, ledger, run, date: DATE, sanity, github, fetch: siteFetch(sanity), sleep: noSleep,
    log: (l) => logs.push(l), secrets: [SECRET],
    settings: { postcheck: { attempts: 2, intervalMs: 0, mobile: true }, prodCheck: { attempts: 2, intervalMs: 0 }, preview: { attempts: 2, intervalMs: 0 } },
    localCheck: async () => ({ ok: true }),
    ...extra,
  });
  const change = (id: string) => ledger.db.prepare("SELECT * FROM changes WHERE id = ?").get(id) as Record<string, string> | undefined;
  return { cfg, ledger, run, sanity, github, logs, deps, change };
}

// ---------- 6a refresh ----------

describe("ship: Sanity refresh", () => {
  it("6.1 snapshots first, then patches; ledger has change id, snapshot, eval, techniques", async () => {
    const t = setup();
    t.sanity.put(livePost("n8n-http-request-node-guide"));
    t.sanity.beforeWrite = (_op, id) => {
      const snaps = t.ledger.db.prepare("SELECT * FROM snapshots WHERE target LIKE ?").all(`%${id}`);
      expect(snaps.length).toBe(1); // invariant 3: snapshot exists before the write
      expect(t.change("2026-11-15-refresh-n8n-http-request-node-guide")?.status).toBe("pending");
    };
    const r = await shipChange(refresh("n8n-http-request-node-guide"), t.deps());
    expect(r.status).toBe("shipped");
    expect(t.sanity.docs.get("post-n8n-http-request-node-guide")?.title).toBe("New title");
    const row = t.change(r.changeId)!;
    expect(row.status).toBe("shipped");
    expect(row.snapshot_id).toBe(r.snapshotId);
    expect(JSON.parse(row.eval)).toMatchObject({ decision: "pass", delta: 25 });
    expect(JSON.parse(row.techniques)).toEqual(["answer-first", "faq"]);
    const snap = t.ledger.db.prepare("SELECT body FROM snapshots WHERE id = ?").get(r.snapshotId!) as { body: string };
    expect(JSON.parse(snap.body).title).toBe("Old title");
    expect(r.notes.join()).toMatch(/playwright not installed/);
    expect(t.run.finish()).toBe("ok");
  });

  it("6.2 postcheck failure auto-restores the snapshot and records ship_failed", async () => {
    const t = setup();
    t.sanity.put(livePost("x"));
    const r = await shipChange(refresh("x"), t.deps({ fetch: siteFetch(t.sanity, { stale: true }) }));
    expect(r.status).toBe("ship_failed");
    expect(r.reasons.join()).toMatch(/title mismatch/);
    expect(r.reasons.join()).toMatch(/restored snapshot/);
    expect(t.sanity.docs.get("post-x")?.title).toBe("Old title");
    expect(t.change(r.changeId)?.status).toBe("ship_failed");
    expect(t.run.finish()).toBe("partial");
  });

  it("6.3 slug change fails the gate and is kept as an unpublished draft (6.7)", async () => {
    const t = setup();
    t.sanity.put(livePost("x"));
    const r = await shipChange(refresh("x", {}, { slug: "x-new" }), t.deps());
    expect(r.status).toBe("held");
    expect(r.reasons.join()).toMatch(/slug changed/);
    expect(t.sanity.docs.get("post-x")?.title).toBe("Old title");
    expect(t.sanity.docs.get("drafts.post-x")?.title).toBe("New title");
    expect(t.change(r.changeId)?.reason).toMatch(/slug changed/);
  });

  it("5.3 dropping headings below the keep ratio is held", async () => {
    const t = setup();
    t.sanity.put(livePost("x"));
    const r = await shipChange(refresh("x", {}, { body: [h2("Brand new"), cta()] }), t.deps());
    expect(r.status).toBe("held");
    expect(r.reasons.join()).toMatch(/existing headings/);
  });

  it("5.4/5.5 banned phrase and unsourced number are held with both reasons", async () => {
    const t = setup();
    t.sanity.put(livePost("x"));
    const body = [h2("Why it fails"), p("Synta is the MCP layer that cuts failures by 63%."), h2("Fix 1"), h2("Fix 2"), cta()];
    const r = await shipChange(refresh("x", {}, { body }), t.deps());
    expect(r.status).toBe("held");
    expect(r.reasons.join()).toMatch(/banned phrase "MCP layer"/);
    expect(r.reasons.join()).toMatch(/unsourced number "63%"/);
  });

  it("CTA missing is held", async () => {
    const t = setup();
    t.sanity.put(livePost("x"));
    const r = await shipChange(refresh("x", {}, { body: [h2("Why it fails"), h2("Fix 1"), h2("Fix 2")] }), t.deps());
    expect(r.reasons).toContain("no CTA link in the body");
  });

  it("5.2 a page changed within cooldownDays is held", async () => {
    const t = setup();
    t.sanity.put(livePost("x"));
    recordChange(t.ledger, { id: "old", date: "2026-11-10", lane: "refresh", target: "x", status: "shipped", reason: "" });
    const r = await shipChange(refresh("x"), t.deps());
    expect(r.status).toBe("held");
    expect(r.reasons.join()).toMatch(/14-day measurement window/);
  });

  it("6.4 a refresh over the per-run cap is queued for the next run", async () => {
    const t = setup({ caps: { newPosts: 1, refreshes: 2, codePrs: 1, offsiteDrafts: 5 } });
    for (const s of ["a", "b", "c"]) t.sanity.put(livePost(s));
    expect((await shipChange(refresh("a"), t.deps())).status).toBe("shipped");
    expect((await shipChange(refresh("b"), t.deps())).status).toBe("shipped");
    const r = await shipChange(refresh("c"), t.deps());
    expect(r.status).toBe("queued");
    expect(r.reasons.join()).toMatch(/daily cap reached/);
    expect(t.sanity.docs.get("post-c")?.title).toBe("Old title");
    expect(queuedChanges(t.ledger).map((c) => c.target)).toEqual(["c"]);
  });

  it("invariant 2: never ships twice to the same target on the same date", async () => {
    const t = setup();
    t.sanity.put(livePost("x"));
    expect((await shipChange(refresh("x"), t.deps())).status).toBe("shipped");
    const again = await shipChange(refresh("x"), t.deps());
    expect(again.status).toBe("skipped");
    const other = await shipChange(refresh("x", { id: "different-id" }), t.deps());
    expect(other.status).toBe("skipped");
    expect(other.reasons.join()).toMatch(/already shipped today/);
    expect(t.sanity.writes.filter((w) => w.startsWith("patch")).length).toBe(1);
  });

  it("eval fail is held, not shipped", async () => {
    const t = setup();
    t.sanity.put(livePost("x"));
    const r = await shipChange(refresh("x", { eval: { decision: "fail", reason: "regressed on q2" } }), t.deps());
    expect(r.status).toBe("held");
    expect(r.reasons).toContain("eval: regressed on q2");
  });

  it("--dry-run prints the exact payload and writes nothing", async () => {
    const t = setup();
    t.sanity.put(livePost("x"));
    const r = await shipChange(refresh("x"), t.deps({ dryRun: true }));
    expect(r.status).toBe("dry_run");
    expect(r.payload).toMatchObject({ op: "patch", id: "post-x", set: { title: "New title" } });
    expect(t.sanity.writes).toEqual([]);
    expect(t.ledger.db.prepare("SELECT COUNT(*) n FROM changes").get()).toEqual({ n: 0 });
    expect(t.ledger.db.prepare("SELECT COUNT(*) n FROM snapshots").get()).toEqual({ n: 0 });
    expect(t.logs.join("\n")).toMatch(/payload/);
  });

  it("--test-dataset ships without a live postcheck and says so", async () => {
    const t = setup();
    t.sanity.dataset = "geo-loop-test";
    t.sanity.put(livePost("x"));
    const r = await shipChange(refresh("x"), t.deps({ testDataset: true, fetch: siteFetch(t.sanity, { stale: true }) }));
    expect(r.status).toBe("shipped");
    expect(r.notes.join()).toMatch(/postcheck skipped/);
  });

  it("8.4 Sanity auth failure is held with a reason and the run is partial", async () => {
    const t = setup();
    t.sanity.put(livePost("x"));
    t.sanity.failWith = new SanityAuthError("sanity fetch: Unauthorized (auth failed)");
    const r = await shipChange(refresh("x"), t.deps());
    expect(r.status).toBe("held");
    expect(r.reasons.join()).toMatch(/auth failed/);
    expect(t.run.finish()).toBe("partial");
  });

  it("invariant 6: secrets in errors never reach the ledger or logs", async () => {
    const t = setup();
    t.sanity.put(livePost("x"));
    t.sanity.beforeWrite = () => {
      throw new Error(`request failed with token ${SECRET}`);
    };
    const r = await shipChange(refresh("x"), t.deps());
    expect(r.status).toBe("held");
    const dump = JSON.stringify(t.ledger.db.prepare("SELECT * FROM changes").all()) + t.logs.join("\n");
    t.run.finish();
    const runs = JSON.stringify(t.ledger.db.prepare("SELECT * FROM runs").all());
    expect(dump + runs).not.toContain(SECRET);
    expect(dump).toContain("[redacted]");
  });

  it("an invalid change.json is held with the validation error", async () => {
    const t = setup();
    const r = await shipChange({ lane: "refresh", target: "x" }, t.deps());
    expect(r.status).toBe("held");
    expect(r.reasons[0]).toMatch(/invalid change/);
  });
});

// ---------- 6b new post ----------

describe("ship: Sanity net-new post", () => {
  it("6.5 renders + uploads the hero, publishes with category/CTA/meta, checks the image URL", async () => {
    const t = setup();
    const f = siteFetch(t.sanity);
    const r = await shipChange(newPost("n8n-webhook-timeout"), t.deps({ fetch: f, now: () => new Date("2026-11-15T12:00:00Z") }));
    expect(r.status).toBe("shipped");
    const doc = t.sanity.docs.get("geo-loop-n8n-webhook-timeout")!;
    expect(doc.category).toEqual({ _type: "reference", _ref: "cat-troubleshooting" });
    expect(doc.author).toEqual({ _type: "reference", _ref: "author-mike" });
    expect((doc.mainImage as { asset: { _ref: string } }).asset._ref).toBe("image-1-1200x630-png");
    expect(doc.publishedAt).toBe("2026-11-15T12:00:00.000Z");
    expect((doc.body as { _key?: string }[]).every((b) => b._key)).toBe(true);
    expect(t.sanity.assets[0].data.subarray(1, 4).toString()).toBe("PNG");
    expect(f.requested).toContain("https://cdn.sanity.io/images/p/d/1.png");
    const snap = t.ledger.db.prepare("SELECT kind FROM snapshots WHERE id = ?").get(r.snapshotId!) as { kind: string };
    expect(snap.kind).toBe("sanity_absent");
  });

  it("6.6 hero image failure holds the publish and keeps a draft", async () => {
    const t = setup();
    t.sanity.failUpload = new Error("upload 500");
    const r = await shipChange(newPost("n8n-webhook-timeout"), t.deps());
    expect(r.status).toBe("held");
    expect(r.reasons.join()).toMatch(/hero image failed: upload 500/);
    expect(t.sanity.docs.has("geo-loop-n8n-webhook-timeout")).toBe(false);
    expect(t.sanity.docs.has("drafts.geo-loop-n8n-webhook-timeout")).toBe(true);
    expect(t.change(r.changeId)?.status).toBe("held");
  });

  it("5.6 duplicate topic is held and points at the existing post", async () => {
    const t = setup();
    t.sanity.put({ ...livePost("n8n-webhook-timeouts-explained"), title: "Fix n8n webhook timeouts", excerpt: "Why n8n webhooks time out in queue mode and three ways to stop it, step by step for self-hosted setups.", body: [h2("Why webhooks time out"), p("Queue mode moves execution to workers.")] });
    const r = await shipChange(newPost("n8n-webhook-timeout"), t.deps());
    expect(r.status).toBe("held");
    expect(r.reasons.join()).toMatch(/duplicate of "n8n-webhook-timeouts-explained".*refresh it instead/);
  });

  it("6.7 any gate failure saves an unpublished draft and records which gate failed", async () => {
    const t = setup();
    const r = await shipChange(newPost("n8n-webhook-timeout", {}, { categoryRef: "cat-missing" }), t.deps());
    expect(r.status).toBe("held");
    expect(t.sanity.docs.has("drafts.geo-loop-n8n-webhook-timeout")).toBe(true);
    expect(t.change(r.changeId)?.reason).toMatch(/category "cat-missing" not found/);
  });

  it("an existing slug is held (refresh instead)", async () => {
    const t = setup();
    t.sanity.put(livePost("n8n-webhook-timeout"));
    const r = await shipChange(newPost("n8n-webhook-timeout"), t.deps());
    expect(r.reasons.join()).toMatch(/already exists/);
  });

  it("6.2 for new posts: failed postcheck unpublishes and keeps a draft", async () => {
    const t = setup();
    const r = await shipChange(newPost("n8n-webhook-timeout"), t.deps({ fetch: siteFetch(t.sanity, { stale: true }) }));
    expect(r.status).toBe("ship_failed");
    expect(t.sanity.docs.has("geo-loop-n8n-webhook-timeout")).toBe(false);
    expect(t.sanity.docs.has("drafts.geo-loop-n8n-webhook-timeout")).toBe(true);
  });
});

// ---------- 6c code PR ----------

const codePr = (files: { path: string; content: string }[], over: Record<string, unknown> = {}) => ({
  lane: "code_pr",
  target: "llms.txt",
  reason: "AI engines look for /llms.txt",
  eval: { decision: "pass" },
  techniques: ["llms-txt"],
  sources: [{ url: "https://llmstxt.org", text: "" }],
  content: { title: "Add llms.txt", files },
  ...over,
});
const llms = [{ path: "app/llms.txt", content: "# Synta\n> n8n builds it. Synta keeps it running.\n" }];

describe("ship: code PR lane", () => {
  it("6.8/6.9 opens a PR with change id, reason and evidence, passes the merge gate, squash-merges", async () => {
    const t = setup();
    const r = await shipChange(codePr(llms), t.deps({ fetch: vercelFetch() }));
    expect(r.status).toBe("shipped");
    const pr = t.github.prs[0];
    expect(pr.body).toContain(r.changeId);
    expect(pr.body).toContain("AI engines look for /llms.txt");
    expect(pr.body).toContain("https://llmstxt.org");
    expect(pr.merged).toBe(true);
    expect(t.github.files.get("app/llms.txt")).toContain("Synta keeps it running");
    expect(r.externalRef).toMatchObject({ pr: 1, mergeSha: "merge-1", previewUrl: "https://synta-pr.vercel.app" });
  });

  it("6.10 a non-allowlisted file never reaches GitHub", async () => {
    const t = setup();
    const r = await shipChange(codePr([...llms, { path: "app/page.tsx", content: "x" }]), t.deps());
    expect(r.status).toBe("held");
    expect(r.reasons).toContain('gate_failed: file outside allowlist "app/page.tsx"');
    expect(t.github.calls).toEqual([]);
    expect(t.change(r.changeId)?.reason).toMatch(/gate_failed: file outside allowlist/);
  });

  it("6.11 failed build leaves the PR open with an explaining comment", async () => {
    const t = setup();
    const r = await shipChange(codePr(llms), t.deps({ fetch: vercelFetch(), localCheck: async () => ({ ok: false, output: "Type error" }) }));
    expect(r.status).toBe("held");
    expect(t.github.prs[0].merged).toBe(false);
    expect(t.github.comments[0].body).toMatch(/local build\/typecheck failed: Type error/);
  });

  it("6.11 failed preview check leaves the PR open", async () => {
    const t = setup();
    const r = await shipChange(codePr(llms), t.deps({ fetch: vercelFetch({ previewOk: false }) }));
    expect(r.status).toBe("held");
    expect(r.reasons.join()).toMatch(/preview: \/llms.txt returned 500/);
  });

  it("6.12 production check failure after merge opens a revert PR", async () => {
    const t = setup();
    const r = await shipChange(codePr(llms), t.deps({ fetch: vercelFetch({ prodOk: false }) }));
    expect(r.status).toBe("ship_failed");
    expect(t.github.prs).toHaveLength(2);
    expect(t.github.prs[1].title).toMatch(/Revert geo-loop change/);
    expect(t.github.branches.get(t.github.prs[1].head)).toEqual([{ path: "app/llms.txt", content: null }]);
  });

  it("missing GITHUB_TOKEN holds with an auth reason", async () => {
    const t = setup();
    const r = await shipChange(codePr(llms), t.deps({ github: undefined }));
    expect(r.status).toBe("held");
    expect(r.reasons.join()).toMatch(/GITHUB_TOKEN not set/);
  });
});

describe("ogimage", () => {
  it("is deterministic and a valid 1200x630 PNG", () => {
    const a = renderTitleCardPng({ brand: "Synta", title: "Fix n8n webhook timeouts — a very long title that has to wrap over several lines" });
    const b = renderTitleCardPng({ brand: "Synta", title: "Fix n8n webhook timeouts — a very long title that has to wrap over several lines" });
    expect(a.equals(b)).toBe(true);
    expect(a.readUInt32BE(16)).toBe(1200);
    expect(a.readUInt32BE(20)).toBe(630);
  });
});

describe("eval output compatibility", () => {
  it("accepts raw `geo-loop eval --json` output as change.eval", async () => {
    const { ChangeSchema } = await import("../src/commands/ship.ts");
    const parsed = ChangeSchema.parse({
      lane: "refresh",
      target: "x",
      content: { body: "## Hi\n\ntext" },
      eval: { url: "https://synta.io/blog/x", mode: "refresh", rows: [], decision: { kind: "refresh", verdict: "pass", reason: "avg delta +25", avgDeltaPts: 25 } },
    });
    expect(parsed.eval.decision).toBe("pass");
    expect(parsed.eval.reason).toBe("avg delta +25");
  });
});
