// geo-loop ship: gates → snapshot → write → postcheck → ledger (spec §6, invariants 1–6).
// One change per call. The daily run calls shipChange() for each planned change in priority order.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import {
  allowlisted, bannedPhrases, combine, cooldown, ctaPresent, dailyCap, duplicateTopic, headingsKept,
  noSecrets, notShippedToday, ptHeadings, ptLinks, ptToText, redact, secretValues, shippedCountToday,
  shippedToTarget, shippedToTargetOn, slugImmutable, unsourcedNumbers,
  type CtaMatcher, type GateResult, type Lane, type PtBlock,
} from "../lib/gates.js";
import { toPt } from "../lib/portable.js";
import { defaultCheckPaths, mergeGate, type FileChange, type GithubPort, type LocalCheck } from "../lib/github.js";
import type { Ledger, Run } from "../lib/ledger.js";
import { makeHeroImage, renderTitleCardPng, type TitleCardInput } from "../lib/ogimage.js";
import { pollSitePaths, postcheck, realSleep, type FetchLike, type Sleep } from "../lib/postcheck.js";
import {
  DEFAULT_FIELDS, draftId, isAuthError, stripSystemFields, type FieldMap, type SanityDoc, type SanityPort,
} from "../lib/sanity.js";

// ---------- change.json ----------

const Block = z.looseObject({ _type: z.string() });
// Portable Text, or a Markdown string converted at ship time (see lib/portable.ts).
const Body = z.union([z.array(Block).min(1), z.string().min(1)]);
const Source = z.object({ url: z.string(), text: z.string().default("") });
// Accepts either {decision: "pass"|"fail", ...} or the raw `geo-loop eval --json` output,
// whose decision is an object {kind, verdict, reason, ...}.
export const EvalResult = z.preprocess(
  (v) => {
    if (!v || typeof v !== "object") return v;
    const e = v as Record<string, unknown>;
    const d = e.decision as Record<string, unknown> | undefined;
    if (d && typeof d === "object" && typeof d.verdict === "string") {
      return { ...e, ...d, decision: d.verdict, reason: e.reason ?? d.reason };
    }
    return v;
  },
  z.looseObject({
    decision: z.enum(["pass", "fail"]),
    reason: z.string().optional(),
  }),
);

const common = {
  id: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "id: letters, digits, . _ - only").optional(),
  target: z.string().min(1),
  reason: z.string().default(""),
  sources: z.array(Source).default([]),
  eval: EvalResult,
  techniques: z.array(z.string()).default([]),
  questionIds: z.array(z.string()).default([]),
  cta: z.object({ hrefPrefixes: z.array(z.string()).min(1) }).optional(),
};

export const RefreshChange = z.object({
  ...common,
  lane: z.literal("refresh"),
  content: z.object({
    title: z.string().min(1).optional(),
    slug: z.string().optional(), // if present must equal the live slug
    excerpt: z.string().min(1).optional(),
    tldr: z.array(z.string()).optional(),
    body: Body,
  }),
});

export const NewPostChange = z.object({
  ...common,
  lane: z.literal("new_post"),
  mainQuery: z.string().min(1),
  content: z.object({
    title: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be kebab-case"),
    excerpt: z.string().min(50).max(160),
    tldr: z.array(z.string()).optional(),
    body: Body,
    categoryRef: z.string().min(1),
    authorRef: z.string().optional(),
    readTime: z.number().int().min(1).optional(),
  }),
});

export const CodePrChange = z.object({
  ...common,
  lane: z.literal("code_pr"),
  content: z.object({
    title: z.string().min(1),
    files: z.array(z.object({ path: z.string().min(1), content: z.string() })).min(1),
    checkPaths: z.array(z.string()).optional(),
  }),
});

export const ChangeSchema = z.discriminatedUnion("lane", [RefreshChange, NewPostChange, CodePrChange]);
export type Change = z.infer<typeof ChangeSchema>;
export type ChangeInput = z.input<typeof ChangeSchema>;

// ---------- settings / deps / result ----------

export type ShipSettings = {
  fields: FieldMap;
  postType: string;
  categoryType: string;
  postUrl: (slug: string) => string;
  cta: CtaMatcher;
  authorRef?: string;
  heroColors?: TitleCardInput["colors"];
  postcheck: { attempts: number; intervalMs: number; mobile: boolean };
  prodCheck: { attempts: number; intervalMs: number }; // code PR after merge: 15 × 60s
  preview: { attempts: number; intervalMs: number };
};

export function defaultShipSettings(config: Config, over: Partial<ShipSettings> = {}): ShipSettings {
  const base = config.site.baseUrl.replace(/\/$/, "");
  const blog = `/${config.site.blogPath.replace(/^\/|\/$/g, "")}/`;
  return {
    fields: DEFAULT_FIELDS,
    postType: config.sanity?.postType ?? "post",
    categoryType: "category",
    postUrl: (slug) => `${base}${blog}${slug}`,
    cta: { brandDomain: config.brand.domain },
    postcheck: { attempts: 6, intervalMs: 15_000, mobile: true },
    prodCheck: { attempts: 15, intervalMs: 60_000 },
    preview: { attempts: 20, intervalMs: 30_000 },
    ...over,
  };
}

export type ShipDeps = {
  config: Config;
  ledger: Ledger;
  run: Run;
  date: string;
  sanity?: SanityPort;
  github?: GithubPort;
  fetch?: FetchLike;
  sleep?: Sleep;
  productFacts?: string;
  dryRun?: boolean;
  /** Writing to the test dataset: there is no live site rendering it, so skip live postchecks. */
  testDataset?: boolean;
  settings?: Partial<ShipSettings>;
  localCheck?: LocalCheck;
  previewUrl?: string;
  previewHeaders?: Record<string, string>;
  renderHero?: (i: TitleCardInput) => Buffer;
  log?: (line: string) => void;
  secrets?: string[];
  now?: () => Date;
};

export type ShipStatus = "shipped" | "held" | "ship_failed" | "queued" | "skipped" | "dry_run";
export type ShipResult = {
  changeId: string;
  lane: Lane;
  target: string;
  status: ShipStatus;
  reasons: string[];
  notes: string[];
  snapshotId?: string;
  externalRef?: Record<string, unknown>;
  payload?: unknown;
};

export function shipExitCode(r: Pick<ShipResult, "status">): 0 | 1 | 2 {
  return r.status === "shipped" || r.status === "dry_run" ? 0 : r.status === "ship_failed" ? 1 : 2;
}

// ---------- ledger helpers ----------

export function saveSnapshot(ledger: Ledger, s: { target: string; kind: string; body: unknown }): string {
  const id = `snap-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  ledger.db
    .prepare("INSERT INTO snapshots (id, target, kind, body, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, s.target, s.kind, JSON.stringify(s.body), new Date().toISOString());
  return id;
}

export function getSnapshot(ledger: Ledger, id: string) {
  const r = ledger.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id) as
    | { id: string; target: string; kind: string; body: string; created_at: string }
    | undefined;
  return r ? { ...r, body: JSON.parse(r.body) as unknown } : undefined;
}

export type ChangeRow = {
  id: string; run_id: string | null; date: string; lane: Lane; target: string; status: string; reason: string;
  snapshot_id: string | null; eval: string; techniques: string; external_ref: string | null; created_at: string; updated_at: string;
};

export function getChange(ledger: Ledger, id: string) {
  return ledger.db.prepare("SELECT * FROM changes WHERE id = ?").get(id) as ChangeRow | undefined;
}

export function recordChange(
  ledger: Ledger,
  row: { id: string; runId?: string; date: string; lane: Lane; target: string; status: string; reason: string; snapshotId?: string; eval?: unknown; techniques?: string[]; externalRef?: unknown },
) {
  const now = new Date().toISOString();
  ledger.db
    .prepare(
      `INSERT INTO changes (id, run_id, date, lane, target, status, reason, snapshot_id, eval, techniques, external_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, date = excluded.date, status = excluded.status, reason = excluded.reason,
         snapshot_id = COALESCE(excluded.snapshot_id, changes.snapshot_id), eval = excluded.eval, techniques = excluded.techniques,
         external_ref = COALESCE(excluded.external_ref, changes.external_ref), updated_at = excluded.updated_at`,
    )
    .run(
      row.id, row.runId ?? null, row.date, row.lane, row.target, row.status, row.reason, row.snapshotId ?? null,
      JSON.stringify(row.eval ?? {}), JSON.stringify(row.techniques ?? []),
      row.externalRef === undefined ? null : JSON.stringify(row.externalRef), now, now,
    );
}

/** Queued changes (6.4 overflow) for the daily run to re-check against the next probe. */
export function queuedChanges(ledger: Ledger, lane?: Lane): Change[] {
  const rows = (lane
    ? ledger.db.prepare("SELECT payload FROM queue WHERE status = 'queued' AND lane = ? ORDER BY id").all(lane)
    : ledger.db.prepare("SELECT payload FROM queue WHERE status = 'queued' ORDER BY id").all()) as { payload: string }[];
  return rows.map((r) => ChangeSchema.parse(JSON.parse(r.payload)));
}

export function loadProductFacts(config: Config, cwd = process.cwd()): string {
  if (!config.productFactsFile) return "";
  const p = resolve(cwd, config.productFactsFile);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** Deterministic default id: one change per lane/target/date. */
export function defaultChangeId(lane: Lane, target: string, date: string) {
  const t = target.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "target";
  return `${date}-${lane}-${t}`;
}

/** Portable Text needs _key on blocks and spans for Studio editing. Deterministic keys for missing ones. */
export function withKeys(body: unknown[]): PtBlock[] {
  return (body as PtBlock[]).map((b, i) => ({
    ...b,
    _key: b._key ?? `gl${i}`,
    ...(Array.isArray(b.children) ? { children: b.children.map((c, j) => ({ ...c, _key: c._key ?? `gl${i}s${j}` })) } : {}),
  }));
}

// ---------- orchestration ----------

type Ctx = {
  deps: ShipDeps;
  s: ShipSettings;
  change: Change;
  id: string;
  secrets: string[];
  log: (l: string) => void;
  notes: string[];
  fetch: FetchLike;
  sleep: Sleep;
};

export async function shipChange(input: ChangeInput | unknown, deps: ShipDeps): Promise<ShipResult> {
  const parsed = ChangeSchema.safeParse(input);
  if (!parsed.success) {
    const reason = `invalid change: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
    deps.run.note({ level: "held", item: "change", reason });
    return { changeId: "", lane: "refresh", target: "", status: "held", reasons: [reason], notes: [] };
  }
  const change = parsed.data;
  const secrets = deps.secrets ?? secretValues();
  const ctx: Ctx = {
    deps,
    change,
    secrets,
    s: defaultShipSettings(deps.config, deps.settings),
    id: change.id ?? defaultChangeId(change.lane, change.target, deps.date),
    log: (l) => (deps.log ?? console.log)(redact(l, secrets)),
    notes: [],
    fetch: deps.fetch ?? fetch,
    sleep: deps.sleep ?? realSleep,
  };
  if (change.cta) ctx.s.cta = { ...ctx.s.cta, hrefPrefixes: change.cta.hrefPrefixes };

  const prior = getChange(deps.ledger, ctx.id);
  if (prior && ["shipped", "reverted", "pending"].includes(prior.status))
    return finish(ctx, "skipped", [`change ${ctx.id} already recorded (${prior.status})`], { record: false });

  // Invariant 2: never ship twice to the same target on the same date.
  const today = notShippedToday(shippedToTargetOn(deps.ledger, change.target, deps.date).filter((x) => x !== ctx.id));
  if (!today.pass) return finish(ctx, "skipped", today.reasons, { record: false });

  try {
    if (change.lane === "refresh") return await shipRefresh(ctx, change);
    if (change.lane === "new_post") return await shipNewPost(ctx, change);
    return await shipCodePr(ctx, change);
  } catch (err) {
    const msg = redact((err as Error)?.message ?? String(err), secrets);
    const pending = getChange(deps.ledger, ctx.id)?.status === "pending";
    if (isAuthError(err)) deps.run.markPartial(`auth failed: ${msg}`);
    return finish(ctx, pending ? "ship_failed" : "held", [isAuthError(err) && !/auth failed/.test(msg) ? `auth failed: ${msg}` : msg]);
  }
}

function evalGate(change: Change): GateResult {
  return change.eval.decision === "pass"
    ? { pass: true, reasons: [] }
    : { pass: false, reasons: [`eval: ${change.eval.reason ?? "decision fail"}`] };
}

function capGate(ctx: Ctx): GateResult {
  return dailyCap(ctx.change.lane, shippedCountToday(ctx.deps.ledger, ctx.change.lane, ctx.deps.date), ctx.deps.config.caps);
}

function evalJson(ctx: Ctx) {
  const c = ctx.change;
  return { ...c.eval, ...(c.lane === "new_post" ? { mainQuery: c.mainQuery } : {}), questionIds: c.questionIds, sources: c.sources.map((s) => s.url) };
}

function finish(
  ctx: Ctx,
  status: ShipStatus,
  reasons: string[],
  extra: { snapshotId?: string; externalRef?: Record<string, unknown>; payload?: unknown; record?: boolean } = {},
): ShipResult {
  const { deps, change, id } = ctx;
  const safe = reasons.map((r) => redact(r, ctx.secrets));
  const reason = safe.join("; ") || status;
  const item = `${change.lane}:${change.target}`;
  if (!deps.dryRun && extra.record !== false && status !== "skipped") {
    recordChange(deps.ledger, {
      id, runId: deps.run.id, date: deps.date, lane: change.lane, target: change.target, status, reason,
      snapshotId: extra.snapshotId, eval: evalJson(ctx), techniques: change.techniques, externalRef: extra.externalRef,
    });
    if (status !== "queued")
      deps.ledger.db.prepare("UPDATE queue SET status = 'done' WHERE status = 'queued' AND json_extract(payload, '$.id') = ?").run(id);
  }
  if (status === "shipped") deps.run.shipped(item, `${id}: ${reason}`);
  else if (status === "skipped") deps.run.note({ level: "skipped", item, reason: `${id}: ${reason}` });
  else if (status === "ship_failed") deps.run.note({ level: "error", item, reason: `${id}: ship_failed: ${reason}` });
  else if (status === "dry_run") deps.run.note({ level: "info", item, reason: `${id}: dry run` });
  else deps.run.note({ level: "held", item, reason: `${id}: ${status === "queued" ? "queued: " : ""}${reason}` });
  ctx.log(`${status.padEnd(11)} ${id}  ${reason}`);
  if (deps.dryRun && extra.payload !== undefined) ctx.log(`payload ${redact(JSON.stringify(extra.payload, null, 2), ctx.secrets)}`);
  return { changeId: id, lane: change.lane, target: change.target, status, reasons: safe, notes: ctx.notes, snapshotId: extra.snapshotId, externalRef: extra.externalRef, payload: extra.payload };
}

function queue(ctx: Ctx, reasons: string[]): ShipResult {
  if (!ctx.deps.dryRun) {
    const payload = JSON.stringify({ ...ctx.change, id: ctx.id });
    const exists = ctx.deps.ledger.db.prepare("SELECT 1 FROM queue WHERE status = 'queued' AND json_extract(payload, '$.id') = ?").get(ctx.id);
    if (!exists)
      ctx.deps.ledger.db.prepare("INSERT INTO queue (created_at, lane, payload) VALUES (?, ?, ?)").run(new Date().toISOString(), ctx.change.lane, payload);
  }
  return finish(ctx, "queued", [...reasons, "queued for tomorrow"]);
}

const sanityTarget = (sanity: SanityPort, docId: string) => `sanity:${sanity.dataset}:${docId}`;

function liveText(doc: SanityDoc, F: FieldMap) {
  return [doc[F.title], doc[F.excerpt], ...((doc[F.tldr] as string[] | undefined) ?? []), ptToText(doc[F.body])].filter(Boolean).join("\n");
}

function contentGates(ctx: Ctx, text: { full: string; prose: string; oldText?: string }) {
  const { config, productFacts } = ctx.deps;
  return combine(
    bannedPhrases(text.full, config.positioning.bannedPhrases),
    unsourcedNumbers(text.prose, { sources: ctx.change.sources.map((s) => s.text), facts: productFacts ?? "", oldText: text.oldText }),
    noSecrets(text.full, ctx.secrets),
  );
}

// ---------- lane: refresh ----------

async function shipRefresh(ctx: Ctx, change: z.infer<typeof RefreshChange>): Promise<ShipResult> {
  const { deps, s } = ctx;
  const sanity = deps.sanity;
  if (!sanity) return finish(ctx, "held", ["sanity not configured"]);
  const F = s.fields;
  const live = await sanity.getPublishedBySlug(s.postType, F.slug, change.target);
  if (!live) return finish(ctx, "held", [`post "${change.target}" not found in dataset ${sanity.dataset}`]);

  const c = { ...change.content, body: toPt(change.content.body, live[F.body]) };
  const liveSlug = (live[F.slug] as { current?: string } | undefined)?.current ?? "";
  const full = [c.title, c.excerpt, ...(c.tldr ?? []), ptToText(c.body)].filter(Boolean).join("\n");
  const prose = [c.title, c.excerpt, ...(c.tldr ?? []), ptToText(c.body, { skipCode: true })].filter(Boolean).join("\n");
  const gates = combine(
    evalGate(change),
    slugImmutable(liveSlug, c.slug, change.target),
    contentGates(ctx, { full, prose, oldText: liveText(live, F) }),
    headingsKept(ptHeadings(live[F.body]), ptHeadings(c.body), deps.config.gates.headingKeepRatio),
    ctaPresent(ptLinks(c.body), s.cta),
    cooldown(shippedToTarget(deps.ledger, change.target).filter((p) => p.id !== ctx.id), deps.date, deps.config.gates.cooldownDays),
  );

  const set: Record<string, unknown> = { [F.body]: withKeys(c.body) };
  if (c.title) set[F.title] = c.title;
  if (c.excerpt) set[F.excerpt] = c.excerpt;
  if (c.tldr) set[F.tldr] = c.tldr;

  if (!gates.pass) {
    // 6.7: keep the proposal as an unpublished draft of the live doc, unless an editor draft exists.
    const dId = draftId(live._id);
    const draft = { ...stripSystemFields(live), ...set, _id: dId };
    if (deps.dryRun) return finish(ctx, "held", gates.reasons, { payload: { op: "createOrReplace", doc: draft } });
    if (await sanity.getDocument(dId)) return finish(ctx, "held", [...gates.reasons, "an editor draft already exists; proposal not written to Sanity"]);
    const snapshotId = saveSnapshot(deps.ledger, { target: sanityTarget(sanity, dId), kind: "sanity_absent", body: { _id: dId, absent: true } });
    recordChange(deps.ledger, { id: ctx.id, runId: deps.run.id, date: deps.date, lane: "refresh", target: change.target, status: "held", reason: gates.reasons.join("; "), snapshotId, eval: evalJson(ctx), techniques: change.techniques });
    const extra = await sanity.createOrReplace(draft).then(() => [] as string[], (e) => [`draft write failed: ${(e as Error).message}`]);
    return finish(ctx, "held", [...gates.reasons, ...extra], { snapshotId, externalRef: { draftId: dId } });
  }

  const cap = capGate(ctx);
  if (!cap.pass) return queue(ctx, cap.reasons);

  const url = s.postUrl(change.target);
  const title = c.title ?? (live[F.title] as string);
  const description = (c.excerpt ?? (live[F.excerpt] as string | undefined)) || title;
  if (deps.dryRun) return finish(ctx, "dry_run", [], { payload: { op: "patch", dataset: sanity.dataset, id: live._id, set, postcheck: { url, title, description } } });

  // Invariant 3: snapshot + change id stored before the write.
  const snapshotId = saveSnapshot(deps.ledger, { target: sanityTarget(sanity, live._id), kind: "sanity_doc", body: live });
  recordChange(deps.ledger, { id: ctx.id, runId: deps.run.id, date: deps.date, lane: "refresh", target: change.target, status: "pending", reason: "writing", snapshotId, eval: evalJson(ctx), techniques: change.techniques, externalRef: { docId: live._id, dataset: sanity.dataset } });
  try {
    await sanity.patchSet(live._id, set);
  } catch (err) {
    if (isAuthError(err)) deps.run.markPartial("sanity auth failed");
    return finish(ctx, "held", [`write failed: ${(err as Error).message}`], { snapshotId });
  }

  if (deps.testDataset) {
    ctx.notes.push(`postcheck skipped: test dataset ${sanity.dataset} has no live site`);
    return finish(ctx, "shipped", ctx.notes, { snapshotId, externalRef: { docId: live._id, dataset: sanity.dataset } });
  }
  const pc = await postcheck({ url, title, description, cta: s.cta }, { fetch: ctx.fetch, sleep: ctx.sleep, ...s.postcheck, log: ctx.log });
  ctx.notes.push(...pc.notes);
  if (pc.pass) return finish(ctx, "shipped", [`postcheck ok ${url}`, ...pc.notes], { snapshotId, externalRef: { docId: live._id, dataset: sanity.dataset } });

  // 6.2: auto-restore the snapshot.
  const restore = await sanity.createOrReplace(stripSystemFields(live)).then(() => `restored snapshot ${snapshotId}`, (e) => `RESTORE FAILED (${(e as Error).message}); run geo-loop revert ${ctx.id}`);
  return finish(ctx, "ship_failed", [...pc.reasons, restore], { snapshotId, externalRef: { docId: live._id, dataset: sanity.dataset } });
}

// ---------- lane: new post ----------

async function shipNewPost(ctx: Ctx, change: z.infer<typeof NewPostChange>): Promise<ShipResult> {
  const { deps, s } = ctx;
  const sanity = deps.sanity;
  if (!sanity) return finish(ctx, "held", ["sanity not configured"]);
  const F = s.fields;
  const c = { ...change.content, body: toPt(change.content.body) };
  if (change.target !== c.slug) return finish(ctx, "held", [`target "${change.target}" must equal content.slug "${c.slug}"`]);

  const existing = await sanity.getPublishedBySlug(s.postType, F.slug, c.slug);
  if (existing) return finish(ctx, "held", [`slug "${c.slug}" already exists (${existing._id}); refresh it instead`]);

  const posts = await sanity.listPosts(s.postType, F);
  const priorQueries = (deps.ledger.db.prepare("SELECT target, eval FROM changes WHERE lane = 'new_post' AND status IN ('shipped','pending') AND id != ?").all(ctx.id) as { target: string; eval: string }[])
    .map((r) => ({ id: r.target, mainQuery: (JSON.parse(r.eval) as { mainQuery?: string }).mainQuery, text: "" }));
  const full = [c.title, c.excerpt, ...(c.tldr ?? []), ptToText(c.body)].join("\n");
  const prose = [c.title, c.excerpt, ...(c.tldr ?? []), ptToText(c.body, { skipCode: true })].join("\n");

  const cat = await sanity.getDocument(c.categoryRef);
  const author = c.authorRef ?? s.authorRef ?? (await sanity.latestAuthorRef(s.postType, F.author));
  const refReasons: string[] = [];
  if (!cat || cat._type !== s.categoryType) refReasons.push(`category "${c.categoryRef}" not found`);
  if (!author) refReasons.push("no author: set content.authorRef");

  const gates = combine(
    evalGate(change),
    contentGates(ctx, { full, prose }),
    ctaPresent(ptLinks(c.body), s.cta),
    duplicateTopic({ mainQuery: change.mainQuery, text: full }, [...posts.map((p) => ({ id: p.slug, text: p.text })), ...priorQueries.filter((q) => q.id !== c.slug)], deps.config.gates.dupSimilarity),
    { pass: refReasons.length === 0, reasons: refReasons },
  );

  const docId = `geo-loop-${c.slug}`.slice(0, 128);
  const doc: SanityDoc = {
    _id: docId,
    _type: s.postType,
    [F.title]: c.title,
    [F.slug]: { _type: "slug", current: c.slug },
    [F.excerpt]: c.excerpt,
    [F.body]: withKeys(c.body),
    [F.category]: { _type: "reference", _ref: c.categoryRef },
    ...(author ? { [F.author]: { _type: "reference", _ref: author } } : {}),
    [F.publishedAt]: (deps.now?.() ?? new Date()).toISOString(),
    ...(c.tldr ? { [F.tldr]: c.tldr } : {}),
    ...(c.readTime ? { [F.readTime]: c.readTime } : {}),
  };

  const holdAsDraft = async (reasons: string[], snapshotId?: string): Promise<ShipResult> => {
    const draft = { ...doc, _id: draftId(docId) };
    if (deps.dryRun) return finish(ctx, "held", reasons, { payload: { op: "createOrReplace", doc: draft } });
    const prev = await sanity.getDocument(draft._id);
    const snap = saveSnapshot(deps.ledger, { target: sanityTarget(sanity, draft._id), kind: prev ? "sanity_doc" : "sanity_absent", body: prev ?? { _id: draft._id, absent: true } });
    recordChange(deps.ledger, { id: ctx.id, runId: deps.run.id, date: deps.date, lane: "new_post", target: change.target, status: "held", reason: reasons.join("; "), snapshotId: snapshotId ?? snap, eval: evalJson(ctx), techniques: change.techniques });
    const extra = await sanity.createOrReplace(draft).then(() => [] as string[], (e) => [`draft write failed: ${(e as Error).message}`]);
    return finish(ctx, "held", [...reasons, ...extra], { snapshotId: snapshotId ?? snap, externalRef: { draftId: draft._id, dataset: sanity.dataset } });
  };

  if (!gates.pass) return holdAsDraft(gates.reasons);
  const cap = capGate(ctx);
  if (!cap.pass) return queue(ctx, cap.reasons);

  const url = s.postUrl(c.slug);
  if (deps.dryRun)
    return finish(ctx, "dry_run", [], { payload: { op: "publish", dataset: sanity.dataset, hero: `${c.slug}-og.png (rendered title card)`, doc, postcheck: { url, title: c.title, description: c.excerpt } } });

  const snapshotId = saveSnapshot(deps.ledger, { target: sanityTarget(sanity, docId), kind: "sanity_absent", body: { _id: docId, absent: true } });
  recordChange(deps.ledger, { id: ctx.id, runId: deps.run.id, date: deps.date, lane: "new_post", target: change.target, status: "pending", reason: "writing", snapshotId, eval: evalJson(ctx), techniques: change.techniques, externalRef: { docId, dataset: sanity.dataset } });

  // 6.5/6.6: hero image, or hold with a draft.
  let hero: { assetId: string; url: string; alt: string };
  try {
    hero = await makeHeroImage(sanity, { brand: deps.config.brand.name, title: c.title, slug: c.slug, colors: s.heroColors }, deps.renderHero ?? renderTitleCardPng);
  } catch (err) {
    if (isAuthError(err)) deps.run.markPartial("sanity auth failed");
    return holdAsDraft([`hero image failed: ${(err as Error).message}`], snapshotId);
  }
  doc[F.mainImage] = { _type: "image", asset: { _type: "reference", _ref: hero.assetId }, alt: hero.alt };

  try {
    await sanity.createOrReplace(doc);
  } catch (err) {
    if (isAuthError(err)) deps.run.markPartial("sanity auth failed");
    return finish(ctx, "held", [`publish failed: ${(err as Error).message}`], { snapshotId });
  }
  const ref = { docId, dataset: sanity.dataset, imageUrl: hero.url };
  if (deps.testDataset) {
    ctx.notes.push(`postcheck skipped: test dataset ${sanity.dataset} has no live site`);
    return finish(ctx, "shipped", ctx.notes, { snapshotId, externalRef: ref });
  }
  const pc = await postcheck({ url, title: c.title, description: c.excerpt, cta: s.cta, imageUrl: hero.url }, { fetch: ctx.fetch, sleep: ctx.sleep, ...s.postcheck, log: ctx.log });
  ctx.notes.push(...pc.notes);
  if (pc.pass) return finish(ctx, "shipped", [`postcheck ok ${url}`, ...pc.notes], { snapshotId, externalRef: ref });
  const undo = await sanity.unpublish(docId).then(() => "unpublished; kept as draft", (e) => `UNPUBLISH FAILED (${(e as Error).message}); run geo-loop revert ${ctx.id}`);
  return finish(ctx, "ship_failed", [...pc.reasons, undo], { snapshotId, externalRef: ref });
}

// ---------- lane: code PR ----------

export function prBody(o: { changeId: string; reason: string; evalJson: unknown; sources: string[]; techniques: string[]; files: string[] }) {
  return [
    `geo-loop change \`${o.changeId}\``,
    "",
    `**Reason:** ${o.reason || "(none given)"}`,
    "",
    `**Files:** ${o.files.map((f) => `\`${f}\``).join(", ")}`,
    `**Techniques:** ${o.techniques.join(", ") || "(none)"}`,
    "",
    "**Evidence**",
    ...o.sources.map((s) => `- ${s}`),
    "",
    "```json",
    JSON.stringify(o.evalJson, null, 2),
    "```",
    "",
    `Revert: \`geo-loop revert ${o.changeId}\``,
  ].join("\n");
}

export async function openRevertPr(
  github: GithubPort,
  o: { changeId: string; base: string; files: FileChange[]; reason: string },
) {
  const branch = `geo-loop/revert-${o.changeId}-${Date.now().toString(36)}`.slice(0, 200);
  await github.createBranchWithFiles({ base: o.base, branch, message: `Revert geo-loop change ${o.changeId}`, files: o.files });
  const pr = await github.openPr({
    title: `Revert geo-loop change ${o.changeId}`,
    head: branch,
    base: o.base,
    body: `Reverts geo-loop change \`${o.changeId}\`.\n\n**Why:** ${o.reason}`,
  });
  return { pr, branch };
}

const TEXTY = /\.(txt|md|mdx)$/i;

async function shipCodePr(ctx: Ctx, change: z.infer<typeof CodePrChange>): Promise<ShipResult> {
  const { deps, s } = ctx;
  const gh = deps.config.github;
  const files: FileChange[] = change.content.files;
  const paths = files.map((f) => f.path);

  // 6.10: refuse before any GitHub call.
  const allow = allowlisted(paths, gh?.allowlist ?? []);
  if (!allow.pass) return finish(ctx, "held", allow.reasons);
  if (!gh) return finish(ctx, "held", ["config.github is not set"]);
  const github = deps.github;
  if (!github && !deps.dryRun) {
    deps.run.markPartial("github auth failed");
    return finish(ctx, "held", ["auth failed: GITHUB_TOKEN not set"]);
  }

  const baseFiles = github ? await Promise.all(paths.map(async (p) => ({ path: p, content: (await github.getFile(p, gh.baseBranch))?.content ?? null }))) : paths.map((p) => ({ path: p, content: null }));
  const allText = files.map((f) => f.content).join("\n");
  const proseText = files.filter((f) => TEXTY.test(f.path)).map((f) => f.content).join("\n");
  const gates = combine(
    evalGate(change),
    contentGates(ctx, { full: allText, prose: proseText, oldText: baseFiles.map((f) => f.content ?? "").join("\n") }),
    cooldown(shippedToTarget(deps.ledger, change.target).filter((p) => p.id !== ctx.id), deps.date, deps.config.gates.cooldownDays),
  );
  if (!gates.pass) return finish(ctx, "held", gates.reasons);
  const cap = capGate(ctx);
  if (!cap.pass) return queue(ctx, cap.reasons);

  const branch = `geo-loop/${ctx.id}`.slice(0, 200);
  const checkPaths = change.content.checkPaths ?? defaultCheckPaths(paths);
  const body = prBody({ changeId: ctx.id, reason: change.reason, evalJson: evalJson(ctx), sources: change.sources.map((x) => x.url), techniques: change.techniques, files: paths });
  if (deps.dryRun || !github)
    return finish(ctx, "dry_run", [], { payload: { op: "pull_request", repo: gh.repo, base: gh.baseBranch, branch, title: change.content.title, body, files, checkPaths } });

  const snapshotId = saveSnapshot(deps.ledger, { target: `github:${gh.repo}`, kind: "github_files", body: { repo: gh.repo, base: gh.baseBranch, files: baseFiles } });
  recordChange(deps.ledger, { id: ctx.id, runId: deps.run.id, date: deps.date, lane: "code_pr", target: change.target, status: "pending", reason: "opening PR", snapshotId, eval: evalJson(ctx), techniques: change.techniques });

  await github.createBranchWithFiles({ base: gh.baseBranch, branch, message: change.content.title, files });
  const pr = await github.openPr({ title: change.content.title, head: branch, base: gh.baseBranch, body });
  const ref: Record<string, unknown> = { repo: gh.repo, pr: pr.number, prUrl: pr.url, branch };
  recordChange(deps.ledger, { id: ctx.id, runId: deps.run.id, date: deps.date, lane: "code_pr", target: change.target, status: "pending", reason: "merge gate", eval: evalJson(ctx), techniques: change.techniques, externalRef: ref });

  const gate = await mergeGate({
    github, pr, branch, files, checkPaths, localCheck: deps.localCheck, previewUrl: deps.previewUrl, fetch: ctx.fetch, sleep: ctx.sleep,
    previewAttempts: s.preview.attempts, previewIntervalMs: s.preview.intervalMs, headers: deps.previewHeaders,
  });
  if (gate.previewUrl) ref.previewUrl = gate.previewUrl;
  if (!gate.pass) {
    // 6.11: leave the PR open with a comment.
    await github.comment(pr.number, `geo-loop merge gate failed; not merging.\n\n${gate.reasons.map((r) => `- ${r}`).join("\n")}`).catch(() => {});
    return finish(ctx, "held", [`merge gate: ${gate.reasons.join("; ")}`, `PR #${pr.number} left open`], { snapshotId, externalRef: ref });
  }
  const merged = await github.squashMerge(pr.number, `${change.content.title} (#${pr.number})`);
  ref.mergeSha = merged.sha;

  // 6.12: production checks after merge; on failure open a revert PR.
  const prod = await pollSitePaths(deps.config.site.baseUrl, checkPaths, { fetch: ctx.fetch, sleep: ctx.sleep, ...s.prodCheck });
  if (prod.pass) return finish(ctx, "shipped", [`PR #${pr.number} merged`, `production checks ok (${checkPaths.join(", ")})`], { snapshotId, externalRef: ref });
  const rv = await openRevertPr(github, { changeId: ctx.id, base: gh.baseBranch, files: baseFiles, reason: `production checks failed: ${prod.reasons.join("; ")}` });
  ref.revertPr = rv.pr.number;
  return finish(ctx, "ship_failed", [`PR #${pr.number} merged but production checks failed: ${prod.reasons.join("; ")}`, `revert PR #${rv.pr.number} opened`], { snapshotId, externalRef: ref });
}

