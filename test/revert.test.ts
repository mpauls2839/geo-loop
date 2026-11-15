import { describe, expect, it } from "vitest";
import { revertChange, type RevertDeps } from "../src/commands/revert.ts";
import { shipChange, type ShipDeps } from "../src/commands/ship.ts";
import type { FileChange, GithubPort } from "../src/lib/github.ts";
import type { ExistingPost, SanityDoc, SanityPort } from "../src/lib/sanity.ts";
import { tempLedger, testConfig } from "./helpers.ts";

// Minimal fakes (kept local: importing ship.test.ts would re-register its tests).
const DATE = "2026-11-15";
const noSleep = async () => {};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

class FakeSanity implements SanityPort {
  dataset = "production";
  canWrite = true;
  docs = new Map<string, SanityDoc>();
  writes: string[] = [];
  put = (d: SanityDoc) => void this.docs.set(d._id, clone(d));
  getPublishedBySlug = async (type: string, f: string, slug: string) =>
    clone([...this.docs.values()].find((x) => x._type === type && !x._id.startsWith("drafts.") && (x[f] as { current?: string })?.current === slug) ?? null);
  getDocument = async (id: string) => clone(this.docs.get(id) ?? null);
  listPosts = async (): Promise<ExistingPost[]> => [];
  latestAuthorRef = async () => "author-mike";
  createOrReplace = async (doc: SanityDoc) => {
    this.writes.push(`createOrReplace:${doc._id}`);
    this.put(doc);
  };
  patchSet = async (id: string, set: Record<string, unknown>) => {
    this.writes.push(`patch:${id}`);
    this.put({ ...this.docs.get(id)!, ...set });
  };
  unpublish = async (id: string) => {
    this.writes.push(`unpublish:${id}`);
    const d = this.docs.get(id)!;
    this.docs.delete(id);
    this.put({ ...d, _id: `drafts.${id}` });
  };
  uploadImage = async () => ({ assetId: "image-1-1200x630-png", url: "https://cdn.sanity.io/images/p/d/1.png" });
}

function siteFetch(sanity: FakeSanity) {
  return async (url: string) => {
    if (url.startsWith("https://cdn.sanity.io/")) return new Response("png", { status: 200, headers: { "content-type": "image/png" } });
    const slug = url.match(/\/blog\/(.+)$/)?.[1];
    const d = [...sanity.docs.values()].find((x) => !x._id.startsWith("drafts.") && (x.slug as { current: string })?.current === slug);
    if (!d) return new Response("nf", { status: 404 });
    const links = ((d.body as { markDefs?: { href?: string }[] }[]) ?? []).flatMap((b) => b.markDefs ?? []).map((x) => `<a href="${x.href}">x</a>`);
    return new Response(`<title>${d.title} | Synta</title><meta name="description" content="${(d.excerpt as string) || d.title}">${links.join("")}`, { status: 200 });
  };
}

class FakeGithub implements GithubPort {
  repo = "Synta-ai/synta-web-app";
  files = new Map<string, string>([["app/llms.txt", "# old llms"]]);
  branches = new Map<string, FileChange[]>();
  prs: { head: string; title: string; merged: boolean }[] = [];
  getFile = async (p: string) => (this.files.has(p) ? { content: this.files.get(p)!, sha: "s" } : null);
  getBranchSha = async () => "base";
  createBranchWithFiles = async (o: { branch: string; files: FileChange[] }) => {
    this.branches.set(o.branch, o.files);
    return { commitSha: "c" };
  };
  openPr = async (o: { title: string; head: string }) => {
    this.prs.push({ head: o.head, title: o.title, merged: false });
    return { number: this.prs.length, url: `u/${this.prs.length}`, headSha: `sha-${this.prs.length}` };
  };
  comment = async () => {};
  squashMerge = async (n: number) => {
    const pr = this.prs[n - 1];
    pr.merged = true;
    for (const f of this.branches.get(pr.head) ?? []) f.content === null ? this.files.delete(f.path) : this.files.set(f.path, f.content);
    return { sha: `m${n}` };
  };
  findPreviewUrl = async () => "https://preview.vercel.app";
}

const okSite = async (url: string) => new Response("ok", { status: 200, headers: { "content-type": url.endsWith(".txt") ? "text/plain" : "text/html" } });

const h2 = (t: string) => ({ _type: "block", style: "h2", children: [{ _type: "span", text: t }] });
const cta = { _type: "block", markDefs: [{ _key: "c", _type: "link", href: "https://synta.io/signup" }], children: [{ _type: "span", text: "Try Synta", marks: ["c"] }] };

function setup() {
  const config = testConfig({ sanity: { projectId: "jincnh50" }, github: { repo: "Synta-ai/synta-web-app", allowlist: ["app/llms.txt"] } });
  const ledger = tempLedger();
  const sanity = new FakeSanity();
  sanity.put({ _id: "post-x", _type: "post", title: "Old title", excerpt: "Old excerpt", slug: { current: "x" }, body: [h2("A"), h2("B")] });
  sanity.put({ _id: "cat-1", _type: "category", title: "T" });
  const github = new FakeGithub();
  const settings = { postcheck: { attempts: 1, intervalMs: 0, mobile: false }, prodCheck: { attempts: 1, intervalMs: 0 }, preview: { attempts: 1, intervalMs: 0 } };
  const shipDeps = (extra: Partial<ShipDeps> = {}): ShipDeps => ({
    config, ledger, run: ledger.startRun("ship", DATE), date: DATE, sanity, github, fetch: siteFetch(sanity), sleep: noSleep,
    log: () => {}, secrets: [], settings, localCheck: async () => ({ ok: true }), ...extra,
  });
  const revDeps = (extra: Partial<RevertDeps> = {}): RevertDeps => ({
    config, ledger, sanityFor: () => sanity, github, fetch: siteFetch(sanity), sleep: noSleep, log: () => {}, secrets: [], settings,
    localCheck: async () => ({ ok: true }), ...extra,
  });
  const status = (id: string) => (ledger.db.prepare("SELECT status FROM changes WHERE id = ?").get(id) as { status: string }).status;
  return { config, ledger, sanity, github, shipDeps, revDeps, status };
}

const refresh = (id: string) => ({
  id, lane: "refresh", target: "x", eval: { decision: "pass" },
  content: { title: "New title", excerpt: "New excerpt", body: [h2("A"), h2("B"), cta] },
});

describe("geo-loop revert", () => {
  it("9.1 restores a shipped refresh from its snapshot and postchecks the restored page", async () => {
    const t = setup();
    expect((await shipChange(refresh("c1"), t.shipDeps())).status).toBe("shipped");
    expect(t.sanity.docs.get("post-x")?.title).toBe("New title");
    const r = await revertChange("c1", t.revDeps());
    expect(r).toMatchObject({ status: "reverted", exitCode: 0 });
    expect(r.message).toMatch(/postcheck ok/);
    expect(t.sanity.docs.get("post-x")?.title).toBe("Old title");
    expect(t.status("c1")).toBe("reverted");
    const row = t.ledger.db.prepare("SELECT reason, external_ref FROM changes WHERE id = 'c1'").get() as { reason: string; external_ref: string };
    expect(row.reason).toMatch(/reverted \d{4}-/);
    expect(JSON.parse(row.external_ref).revertedAt).toBeTruthy();
    // invariant 3: the revert itself snapshotted the pre-revert state
    expect((t.ledger.db.prepare("SELECT COUNT(*) n FROM snapshots").get() as { n: number }).n).toBe(2);
  });

  it("9.2 unpublishes a shipped new post, keeps it as a draft, URL returns 404", async () => {
    const t = setup();
    const change = {
      id: "n1", lane: "new_post", target: "new-one", mainQuery: "q", eval: { decision: "pass" },
      content: { title: "New one", slug: "new-one", excerpt: "x".repeat(60), body: [h2("A"), cta], categoryRef: "cat-1" },
    };
    expect((await shipChange(change, t.shipDeps())).status).toBe("shipped");
    const r = await revertChange("n1", t.revDeps());
    expect(r).toMatchObject({ status: "reverted", exitCode: 0 });
    expect(t.sanity.docs.has("geo-loop-new-one")).toBe(false);
    expect(t.sanity.docs.has("drafts.geo-loop-new-one")).toBe(true);
    expect((await siteFetch(t.sanity)("https://synta.io/blog/new-one")).status).toBe(404);
  });

  it("9.3 a merged code PR is reverted by a revert PR that passes the same merge gate", async () => {
    const t = setup();
    const change = { id: "p1", lane: "code_pr", target: "llms.txt", eval: { decision: "pass" }, content: { title: "Update llms.txt", files: [{ path: "app/llms.txt", content: "# new llms" }] } };
    expect((await shipChange(change, t.shipDeps({ fetch: okSite }))).status).toBe("shipped");
    expect(t.github.files.get("app/llms.txt")).toBe("# new llms");
    const r = await revertChange("p1", t.revDeps({ fetch: okSite }));
    expect(r).toMatchObject({ status: "reverted", exitCode: 0 });
    expect(t.github.prs[1]).toMatchObject({ title: "Revert geo-loop change p1", merged: true });
    expect(t.github.files.get("app/llms.txt")).toBe("# old llms");
  });

  it("9.3 revert PR that fails the merge gate stays open (exit 2)", async () => {
    const t = setup();
    const change = { id: "p1", lane: "code_pr", target: "llms.txt", eval: { decision: "pass" }, content: { title: "u", files: [{ path: "app/llms.txt", content: "# new" }] } };
    await shipChange(change, t.shipDeps({ fetch: okSite }));
    const r = await revertChange("p1", t.revDeps({ fetch: okSite, localCheck: undefined }));
    expect(r).toMatchObject({ status: "held", exitCode: 2 });
    expect(t.github.prs[1].merged).toBe(false);
    expect(t.status("p1")).toBe("shipped");
  });

  it("9.4 refuses when the target changed again later, listing the ids; --force restores anyway", async () => {
    const t = setup();
    await shipChange(refresh("c1"), t.shipDeps());
    t.ledger.db
      .prepare("INSERT INTO changes (id, date, lane, target, status, created_at, updated_at) VALUES ('c2', '2026-12-01', 'refresh', 'x', 'shipped', '2999-01-01', '2999-01-01')")
      .run();
    const r = await revertChange("c1", t.revDeps());
    expect(r).toMatchObject({ status: "refused", exitCode: 1, laterChanges: ["c2"] });
    expect(t.sanity.docs.get("post-x")?.title).toBe("New title");
    const forced = await revertChange("c1", t.revDeps({ force: true }));
    expect(forced.status).toBe("reverted");
    expect(t.sanity.docs.get("post-x")?.title).toBe("Old title");
  });

  it("9.5 already reverted is a no-op with exit 0", async () => {
    const t = setup();
    await shipChange(refresh("c1"), t.shipDeps());
    await revertChange("c1", t.revDeps());
    const writes = t.sanity.writes.length;
    const r = await revertChange("c1", t.revDeps());
    expect(r).toMatchObject({ status: "noop", exitCode: 0 });
    expect(r.message).toMatch(/already reverted/);
    expect(t.sanity.writes.length).toBe(writes);
  });

  it("9.6 unknown id exits 1", async () => {
    const t = setup();
    expect(await revertChange("nope", t.revDeps())).toMatchObject({ status: "not_found", exitCode: 1 });
  });

  it("--dry-run shows the restore payload and writes nothing", async () => {
    const t = setup();
    await shipChange(refresh("c1"), t.shipDeps());
    const writes = t.sanity.writes.length;
    const r = await revertChange("c1", t.revDeps({ dryRun: true }));
    expect(r.status).toBe("dry_run");
    expect(r.payload).toMatchObject({ op: "createOrReplace", doc: { _id: "post-x", title: "Old title" } });
    expect(t.sanity.writes.length).toBe(writes);
    expect(t.status("c1")).toBe("shipped");
  });

  it("a held change has nothing live to revert (exit 1)", async () => {
    const t = setup();
    await shipChange({ ...refresh("h1"), eval: { decision: "fail" } }, t.shipDeps());
    expect(await revertChange("h1", t.revDeps())).toMatchObject({ status: "not_revertable", exitCode: 1 });
  });
});
