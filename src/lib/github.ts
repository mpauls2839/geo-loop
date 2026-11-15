// Code-PR lane over the GitHub REST API (spec 6.8–6.12, 9.3). Plain fetch with GITHUB_TOKEN; no gh CLI.
// Everything else talks to GithubPort so tests inject a fake.

import { redact, type GateResult } from "./gates.js";
import { pollSitePaths, realSleep, type FetchLike, type Sleep } from "./postcheck.js";

export type FileChange = { path: string; content: string | null }; // null = delete
export type PullRequest = { number: number; url: string; headSha: string };

export interface GithubPort {
  readonly repo: string;
  getFile(path: string, ref: string): Promise<{ content: string; sha: string } | null>;
  getBranchSha(branch: string): Promise<string>;
  createBranchWithFiles(o: { base: string; branch: string; message: string; files: FileChange[] }): Promise<{ commitSha: string }>;
  openPr(o: { title: string; head: string; base: string; body: string }): Promise<PullRequest>;
  comment(number: number, body: string): Promise<void>;
  squashMerge(number: number, title: string): Promise<{ sha: string }>;
  findPreviewUrl(sha: string): Promise<string | null>;
}

export class GithubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function githubClient(o: { repo: string; token: string; fetch?: FetchLike; apiBase?: string }): GithubPort {
  const f = o.fetch ?? fetch;
  const base = o.apiBase ?? "https://api.github.com";
  const secrets = [o.token];
  const call = async <T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T | null> => {
    const res = await f(`${base}/repos/${o.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${o.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "geo-loop",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (okStatuses.includes(res.status)) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GithubError(redact(`github ${method} ${path}: ${res.status} ${text.slice(0, 300)}`, secrets), res.status);
    }
    return res.status === 204 ? null : ((await res.json()) as T);
  };
  const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

  return {
    repo: o.repo,
    async getFile(path, ref) {
      const r = await call<{ content: string; sha: string; encoding: string }>("GET", `/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`, undefined, [404]);
      return r ? { content: Buffer.from(r.content, "base64").toString("utf8"), sha: r.sha } : null;
    },
    async getBranchSha(branch) {
      const r = await call<{ object: { sha: string } }>("GET", `/git/ref/heads/${enc(branch)}`);
      return r!.object.sha;
    },
    async createBranchWithFiles({ base: baseBranch, branch, message, files }) {
      const parent = await this.getBranchSha(baseBranch);
      const commit = await call<{ tree: { sha: string } }>("GET", `/git/commits/${parent}`);
      const tree = await call<{ sha: string }>("POST", "/git/trees", {
        base_tree: commit!.tree.sha,
        tree: files.map((x) => (x.content === null ? { path: x.path, mode: "100644", type: "blob", sha: null } : { path: x.path, mode: "100644", type: "blob", content: x.content })),
      });
      const created = await call<{ sha: string }>("POST", "/git/commits", { message, tree: tree!.sha, parents: [parent] });
      await call("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: created!.sha });
      return { commitSha: created!.sha };
    },
    async openPr({ title, head, base: b, body }) {
      const r = await call<{ number: number; html_url: string; head: { sha: string } }>("POST", "/pulls", { title, head, base: b, body: redact(body, secrets) });
      return { number: r!.number, url: r!.html_url, headSha: r!.head.sha };
    },
    async comment(number, body) {
      await call("POST", `/issues/${number}/comments`, { body: redact(body, secrets) });
    },
    async squashMerge(number, title) {
      const r = await call<{ sha: string }>("PUT", `/pulls/${number}/merge`, { merge_method: "squash", commit_title: title });
      return { sha: r!.sha };
    },
    async findPreviewUrl(sha) {
      const deps = (await call<{ id: number; environment: string }[]>("GET", `/deployments?sha=${sha}&per_page=20`)) ?? [];
      for (const d of deps) {
        if (/production/i.test(d.environment)) continue;
        const statuses = (await call<{ state: string; environment_url?: string; target_url?: string }[]>("GET", `/deployments/${d.id}/statuses?per_page=20`)) ?? [];
        const ok = statuses.find((s) => s.state === "success" && (s.environment_url || s.target_url));
        if (ok) return ok.environment_url || ok.target_url || null;
      }
      return null;
    },
  };
}

/** Paths on the deployed site to check for a set of changed repo files (overridable per change). */
export function defaultCheckPaths(files: string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    if (/(^|\/)llms\.txt$/.test(f)) out.add("/llms.txt");
    else if (/(^|\/)sitemap\.(ts|js|xml)$/.test(f)) out.add("/sitemap.xml");
    else if (/(^|\/)robots\.(ts|js|txt)$/.test(f)) out.add("/robots.txt");
    else out.add("/");
  }
  return [...out];
}

export type LocalCheck = (info: { branch: string; files: FileChange[] }) => Promise<{ ok: boolean; output?: string }>;

export type MergeGateOpts = {
  github: GithubPort;
  pr: PullRequest;
  branch: string;
  files: FileChange[];
  checkPaths: string[];
  localCheck?: LocalCheck;
  previewUrl?: string;
  fetch: FetchLike;
  sleep?: Sleep;
  previewAttempts?: number;
  previewIntervalMs?: number;
  headers?: Record<string, string>;
};

/** 6.9: local build/typecheck passed + Vercel preview ready + changed URLs check out on the preview. */
export async function mergeGate(o: MergeGateOpts): Promise<GateResult & { previewUrl?: string }> {
  const reasons: string[] = [];
  if (!o.localCheck) reasons.push("no local build/typecheck result (pass --build-cmd with --repo-dir, or --local-check-passed)");
  else {
    const r = await o.localCheck({ branch: o.branch, files: o.files });
    if (!r.ok) reasons.push(`local build/typecheck failed${r.output ? `: ${r.output.slice(-500)}` : ""}`);
  }
  let previewUrl = o.previewUrl;
  const sleep = o.sleep ?? realSleep;
  for (let i = 0; !previewUrl && i < (o.previewAttempts ?? 20); i++) {
    if (i > 0) await sleep(o.previewIntervalMs ?? 30_000);
    previewUrl = (await o.github.findPreviewUrl(o.pr.headSha)) ?? undefined;
  }
  if (!previewUrl) reasons.push("Vercel preview deployment not ready");
  else {
    const site = await pollSitePaths(previewUrl, o.checkPaths, { fetch: o.fetch, sleep, attempts: 3, intervalMs: 20_000, headers: o.headers });
    reasons.push(...site.reasons.map((r) => `preview: ${r}`));
  }
  return { pass: reasons.length === 0, reasons, previewUrl };
}
