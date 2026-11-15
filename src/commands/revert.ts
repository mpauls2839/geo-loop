// geo-loop revert <change-id> (spec §9). Restores the snapshot taken before the change shipped.
// Revert is itself an external write, so it snapshots the current state first (invariant 3).

import type { Config } from "../config.js";
import { redact, secretValues } from "../lib/gates.js";
import { defaultCheckPaths, mergeGate, type FileChange, type GithubPort, type LocalCheck } from "../lib/github.js";
import type { Ledger, Run } from "../lib/ledger.js";
import { expectGone, postcheck, realSleep, type FetchLike, type Sleep } from "../lib/postcheck.js";
import { stripSystemFields, type SanityDoc, type SanityPort } from "../lib/sanity.js";
import { defaultShipSettings, getChange, getSnapshot, openRevertPr, saveSnapshot, type ChangeRow, type ShipSettings } from "./ship.js";

export type RevertDeps = {
  config: Config;
  ledger: Ledger;
  run?: Run;
  /** Sanity client for the dataset the change was shipped to. */
  sanityFor?: (dataset: string) => SanityPort | undefined;
  github?: GithubPort;
  fetch?: FetchLike;
  sleep?: Sleep;
  settings?: Partial<ShipSettings>;
  localCheck?: LocalCheck;
  previewUrl?: string;
  previewHeaders?: Record<string, string>;
  force?: boolean;
  dryRun?: boolean;
  log?: (line: string) => void;
  secrets?: string[];
};

export type RevertStatus = "reverted" | "noop" | "refused" | "not_found" | "not_revertable" | "held" | "dry_run";
export type RevertResult = {
  changeId: string;
  status: RevertStatus;
  message: string;
  reasons: string[];
  laterChanges?: string[];
  exitCode: 0 | 1 | 2;
  payload?: unknown;
};

export function laterChangesOn(ledger: Ledger, row: ChangeRow): string[] {
  return (
    ledger.db
      .prepare("SELECT id FROM changes WHERE target = ? AND id != ? AND created_at > ? AND status IN ('shipped','pending') ORDER BY created_at")
      .all(row.target, row.id, row.created_at) as { id: string }[]
  ).map((r) => r.id);
}

function markReverted(ledger: Ledger, row: ChangeRow, note: string, ref: Record<string, unknown>) {
  const now = new Date().toISOString();
  const prev = row.external_ref ? (JSON.parse(row.external_ref) as Record<string, unknown>) : {};
  ledger.db
    .prepare("UPDATE changes SET status = 'reverted', reason = ?, external_ref = ?, updated_at = ? WHERE id = ?")
    .run(`${row.reason} | reverted ${now}: ${note}`, JSON.stringify({ ...prev, ...ref, revertedAt: now }), now, row.id);
}

export async function revertChange(changeId: string, deps: RevertDeps): Promise<RevertResult> {
  const secrets = deps.secrets ?? secretValues();
  const log = (l: string) => (deps.log ?? console.log)(redact(l, secrets));
  const done = (r: Omit<RevertResult, "changeId" | "reasons"> & { reasons?: string[] }): RevertResult => {
    const res: RevertResult = { changeId, reasons: [], ...r, message: redact(r.message, secrets) };
    const level = r.exitCode === 0 ? "info" : r.status === "held" ? "held" : "error";
    deps.run?.note({ level, item: `revert:${changeId}`, reason: res.message });
    log(`${res.status} ${changeId}  ${res.message}`);
    if (deps.dryRun && r.payload !== undefined) log(`payload ${redact(JSON.stringify(r.payload, null, 2), secrets)}`);
    return res;
  };

  const row = getChange(deps.ledger, changeId);
  if (!row) return done({ status: "not_found", message: `unknown change id ${changeId}`, exitCode: 1 });
  if (row.status === "reverted") return done({ status: "noop", message: `already reverted (${row.updated_at})`, exitCode: 0 });
  if (row.status !== "shipped") return done({ status: "not_revertable", message: `status is ${row.status}; nothing live to revert`, exitCode: 1 });

  const later = laterChangesOn(deps.ledger, row);
  if (later.length && !deps.force)
    return done({ status: "refused", message: `target ${row.target} changed again later by ${later.join(", ")}; pass --force to restore anyway`, laterChanges: later, exitCode: 1 });

  const snap = row.snapshot_id ? getSnapshot(deps.ledger, row.snapshot_id) : undefined;
  if (!snap) return done({ status: "not_revertable", message: `snapshot ${row.snapshot_id ?? "(none)"} missing`, exitCode: 1 });
  const ext = (row.external_ref ? JSON.parse(row.external_ref) : {}) as Record<string, unknown>;
  const s = defaultShipSettings(deps.config, deps.settings);
  const fetchFn = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? realSleep;

  if (row.lane === "refresh" || row.lane === "new_post") {
    const dataset = (ext.dataset as string | undefined) ?? snap.target.split(":")[1];
    const docId = (ext.docId as string | undefined) ?? snap.target.split(":").slice(2).join(":");
    const live = dataset === deps.config.sanity?.dataset; // only the production dataset has a live site to check
    const url = s.postUrl(row.target);

    if (row.lane === "refresh") {
      const restore = stripSystemFields(snap.body as SanityDoc);
      if (deps.dryRun) return done({ status: "dry_run", message: `would restore ${docId} from ${snap.id}`, payload: { op: "createOrReplace", dataset, doc: restore }, exitCode: 0 });
      const sanity = deps.sanityFor?.(dataset);
      if (!sanity) return done({ status: "held", message: "sanity not configured (SANITY_WRITE_TOKEN?)", exitCode: 2 });
      const current = await sanity.getDocument(docId);
      const pre = saveSnapshot(deps.ledger, { target: snap.target, kind: current ? "sanity_doc" : "sanity_absent", body: current ?? { _id: docId, absent: true } });
      await sanity.createOrReplace(restore);
      const F = s.fields;
      const title = restore[F.title] as string;
      const pc = live
        ? await postcheck({ url, title, description: ((restore[F.excerpt] as string | undefined) || title) }, { fetch: fetchFn, sleep, ...s.postcheck, log })
        : { pass: true, reasons: [], notes: [`postcheck skipped: dataset ${dataset} has no live site`] };
      markReverted(deps.ledger, row, `restored ${snap.id}; pre-revert snapshot ${pre}${pc.pass ? "" : `; postcheck failed: ${pc.reasons.join("; ")}`}`, { preRevertSnapshot: pre });
      return done({
        status: "reverted",
        message: `restored ${docId} from ${snap.id}${pc.pass ? "; postcheck ok" : `; postcheck failed: ${pc.reasons.join("; ")}`}`,
        reasons: [...pc.reasons, ...pc.notes],
        exitCode: pc.pass ? 0 : 2,
      });
    }

    // new post → unpublish, keep as draft (9.2)
    if (deps.dryRun) return done({ status: "dry_run", message: `would unpublish ${docId} (kept as draft)`, payload: { op: "unpublish", dataset, id: docId }, exitCode: 0 });
    const sanity = deps.sanityFor?.(dataset);
    if (!sanity) return done({ status: "held", message: "sanity not configured (SANITY_WRITE_TOKEN?)", exitCode: 2 });
    const current = await sanity.getDocument(docId);
    const pre = saveSnapshot(deps.ledger, { target: snap.target, kind: current ? "sanity_doc" : "sanity_absent", body: current ?? { _id: docId, absent: true } });
    await sanity.unpublish(docId);
    const gone = live ? await expectGone(url, { fetch: fetchFn, sleep, attempts: s.postcheck.attempts * 10, intervalMs: s.postcheck.intervalMs }) : { pass: true, reasons: [] };
    markReverted(deps.ledger, row, `unpublished ${docId} (kept as draft); pre-revert snapshot ${pre}${gone.pass ? "" : `; ${gone.reasons.join("; ")}`}`, { preRevertSnapshot: pre });
    return done({ status: "reverted", message: `unpublished ${docId} (kept as draft)${gone.pass ? "" : `; ${gone.reasons.join("; ")}`}`, reasons: gone.reasons, exitCode: gone.pass ? 0 : 2 });
  }

  // code PR → revert PR through the same merge gate (9.3)
  const body = snap.body as { repo: string; base: string; files: FileChange[] };
  if (deps.dryRun) return done({ status: "dry_run", message: `would open a revert PR on ${body.repo} restoring ${body.files.map((f) => f.path).join(", ")}`, payload: { op: "revert_pull_request", ...body }, exitCode: 0 });
  const github = deps.github;
  if (!github) return done({ status: "held", message: "github not configured (GITHUB_TOKEN?)", exitCode: 2 });
  const current = await Promise.all(body.files.map(async (f) => ({ path: f.path, content: (await github.getFile(f.path, body.base))?.content ?? null })));
  const pre = saveSnapshot(deps.ledger, { target: snap.target, kind: "github_files", body: { ...body, files: current } });
  const { pr, branch } = await openRevertPr(github, { changeId, base: body.base, files: body.files, reason: "geo-loop revert" });
  const gate = await mergeGate({
    github, pr, branch, files: body.files, checkPaths: defaultCheckPaths(body.files.map((f) => f.path)), localCheck: deps.localCheck,
    previewUrl: deps.previewUrl, fetch: fetchFn, sleep, previewAttempts: s.preview.attempts, previewIntervalMs: s.preview.intervalMs, headers: deps.previewHeaders,
  });
  if (!gate.pass) {
    await github.comment(pr.number, `geo-loop merge gate failed; not merging.\n\n${gate.reasons.map((r) => `- ${r}`).join("\n")}`).catch(() => {});
    return done({ status: "held", message: `revert PR #${pr.number} open; merge gate failed: ${gate.reasons.join("; ")}`, reasons: gate.reasons, exitCode: 2 });
  }
  const merged = await github.squashMerge(pr.number, `Revert geo-loop change ${changeId} (#${pr.number})`);
  markReverted(deps.ledger, row, `revert PR #${pr.number} merged; pre-revert snapshot ${pre}`, { revertPr: pr.number, revertSha: merged.sha, preRevertSnapshot: pre });
  return done({ status: "reverted", message: `revert PR #${pr.number} merged`, exitCode: 0 });
}
