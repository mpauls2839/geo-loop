// Hard gates checked by code before anything ships (spec 5.x/6.x, invariants 2, 4, 5, 6).
// Every check is pure: inputs in, {pass, reasons} out. Ledger lookups live in the small
// helpers at the bottom so the checks themselves stay testable without a database.

import type { Config } from "../config.js";
import type { Ledger } from "./ledger.js";
import { registeredDomain } from "./urls.js";

export type GateResult = { pass: boolean; reasons: string[] };
export type Lane = "refresh" | "new_post" | "code_pr";

const result = (reasons: string[]): GateResult => ({ pass: reasons.length === 0, reasons });

export function combine(...results: GateResult[]): GateResult {
  return result(results.flatMap((r) => r.reasons));
}

// ---------- Portable Text helpers ----------

export type PtSpan = { _type: string; _key?: string; text?: string; marks?: string[] };
export type PtMarkDef = { _key: string; _type: string; href?: string };
export type PtBlock = {
  _type: string;
  _key?: string;
  style?: string;
  listItem?: string;
  children?: PtSpan[];
  markDefs?: PtMarkDef[];
  [k: string]: unknown;
};

/** Plain text of a Portable Text body, one block per line. `skipCode` drops spans marked `code`. */
export function ptToText(body: unknown, opts: { skipCode?: boolean } = {}): string {
  if (!Array.isArray(body)) return "";
  return (body as PtBlock[])
    .filter((b) => b && b._type === "block" && Array.isArray(b.children))
    .map((b) =>
      b.children!
        .filter((c) => !(opts.skipCode && c.marks?.includes("code")))
        .map((c) => c.text ?? "")
        .join(""),
    )
    .join("\n");
}

export function ptHeadings(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  return (body as PtBlock[])
    .filter((b) => b?._type === "block" && /^h[1-6]$/.test(b.style ?? ""))
    .map((b) => (b.children ?? []).map((c) => c.text ?? "").join("").trim())
    .filter(Boolean);
}

export function ptLinks(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  return (body as PtBlock[]).flatMap((b) => (b?.markDefs ?? []).flatMap((m) => (m._type === "link" && m.href ? [m.href] : [])));
}

// ---------- Invariant 4: banned positioning phrases ----------

const norm = (s: string) =>
  s.normalize("NFKC").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, " ").toLowerCase();

export function bannedPhrases(text: string, phrases: string[]): GateResult {
  const t = norm(text);
  return result(phrases.filter((p) => p.trim() && t.includes(norm(p).trim())).map((p) => `banned phrase "${p}"`));
}

// ---------- Invariant 5: no unsourced numbers ----------

// A number token: optional currency, digits (with thousands commas), optional decimal, optional suffix.
// The lookbehinds skip digits glued to letters/digits/dots/slashes or letter-hyphen (n8n, GPT-4, v1.2, 11/15, OAuth2).
const NUM_RE =
  /(?<![\p{L}\p{N}_./])(?<!\p{L}-)([$€£])?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(\s?%|\s?(?:percent|million|billion|thousand)\b|[a-zA-Z]{1,3})?(?![\p{L}\p{N}])/gu;
const CLAIM_SUFFIX = /^(\s?%|\s?percent|\s?million|\s?billion|\s?thousand|k|m|b|x)$/i;
const STEP_PREFIX = /(?:\bsteps?|\bpart|\bphase|\boption|\bmethod|\btip|\bway|\bfix|\bstage|#)\s*$/i;

export type NumberToken = { raw: string; value: string; index: number; claim: boolean };

function stripNonProse(text: string) {
  return text.replace(/https?:\/\/\S+/g, " ").replace(/`[^`]*`/g, " ");
}

export function extractNumbers(text: string): NumberToken[] {
  const t = stripNonProse(text);
  const out: NumberToken[] = [];
  for (const m of t.matchAll(NUM_RE)) {
    const [raw, currency, int, dec, suffix] = m;
    const value = int.replace(/,/g, "") + (dec && !/^0+$/.test(dec) ? `.${dec}` : "");
    const claim = !!currency || !!dec || (!!suffix && CLAIM_SUFFIX.test(suffix));
    out.push({ raw: raw.trim(), value, index: m.index ?? 0, claim });
  }
  return out;
}

function exempt(tok: NumberToken, text: string): boolean {
  const n = Number(tok.value);
  if (tok.claim) return false;
  if (/^(19|20)\d\d$/.test(tok.value)) return true; // years
  if (Number.isInteger(n) && n <= 10) return true; // small counts in how-to steps
  if (STEP_PREFIX.test(text.slice(Math.max(0, tok.index - 12), tok.index))) return true; // "step 12"
  return false;
}

/**
 * Every number/percentage/money figure in `text` must appear in a source, the product-facts file,
 * or the previous version of the page (numbers already live are not "new or changed").
 */
export function unsourcedNumbers(text: string, refs: { sources?: string[]; facts?: string; oldText?: string }): GateResult {
  const known = new Set(
    [...(refs.sources ?? []), refs.facts ?? "", refs.oldText ?? ""].flatMap((s) => extractNumbers(s).map((t) => t.value)),
  );
  const prose = stripNonProse(text);
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const tok of extractNumbers(text)) {
    if (exempt(tok, prose) || known.has(tok.value) || seen.has(tok.raw)) continue;
    seen.add(tok.raw);
    const ctx = prose.slice(Math.max(0, tok.index - 30), tok.index + tok.raw.length + 30).replace(/\s+/g, " ").trim();
    reasons.push(`unsourced number "${tok.raw}" in "…${ctx}…"`);
  }
  return result(reasons);
}

// ---------- 6.3 / 5.3 refresh shape ----------

export function slugImmutable(liveSlug: string, draftSlug: string | undefined, target: string): GateResult {
  const reasons: string[] = [];
  if (draftSlug !== undefined && draftSlug !== liveSlug) reasons.push(`slug changed ("${liveSlug}" → "${draftSlug}"); slug and URL are immutable`);
  if (target !== liveSlug) reasons.push(`target "${target}" does not match live slug "${liveSlug}"`);
  return result(reasons);
}

const normHeading = (h: string) => h.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function headingsKept(oldHeadings: string[], newHeadings: string[], ratio: number): GateResult {
  if (oldHeadings.length === 0) return result([]);
  const next = new Set(newHeadings.map(normHeading));
  const kept = oldHeadings.filter((h) => next.has(normHeading(h))).length;
  const r = kept / oldHeadings.length;
  return result(
    r + 1e-9 >= ratio ? [] : [`kept ${kept}/${oldHeadings.length} existing headings (${Math.round(r * 100)}%), need ≥${Math.round(ratio * 100)}%`],
  );
}

// ---------- CTA ----------

export type CtaMatcher = { brandDomain: string; hrefPrefixes?: string[] };

/** A CTA link is a Portable Text link to one of `hrefPrefixes`, or (default) any link on the brand's domain. */
export function isCtaHref(href: string, m: CtaMatcher): boolean {
  if (m.hrefPrefixes?.length) return m.hrefPrefixes.some((p) => href.startsWith(p));
  if (href.startsWith("/") && !href.startsWith("//")) return true;
  return registeredDomain(href) === registeredDomain(m.brandDomain);
}

export function ctaPresent(links: string[], m: CtaMatcher): GateResult {
  return result(links.some((h) => isCtaHref(h, m)) ? [] : ["no CTA link in the body"]);
}

// ---------- 5.2 cooldown ----------

export function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function cooldown(prior: { id: string; date: string }[], date: string, days: number): GateResult {
  const recent = prior.filter((p) => daysBetween(p.date, date) < days);
  return result(
    recent.length ? [`changed ${recent.map((p) => `${p.date} (${p.id})`).join(", ")}, inside the ${days}-day measurement window`] : [],
  );
}

// ---------- 5.6 duplicate topic (local tf-idf cosine) ----------

const STOP = new Set(
  "a an and are as at be but by can do does for from how i if in into is it its of on or our so that the their them then there these this to vs was we what when where which who why will with you your".split(" "),
);

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
}

export function tfidfCosine(a: string, docs: string[]): number[] {
  const all = [a, ...docs].map(tokenize);
  const df = new Map<string, number>();
  for (const toks of all) for (const w of new Set(toks)) df.set(w, (df.get(w) ?? 0) + 1);
  const N = all.length;
  const vec = (toks: string[]) => {
    const tf = new Map<string, number>();
    for (const w of toks) tf.set(w, (tf.get(w) ?? 0) + 1);
    const v = new Map<string, number>();
    for (const [w, c] of tf) v.set(w, (c / toks.length) * (Math.log((N + 1) / ((df.get(w) ?? 0) + 1)) + 1));
    return v;
  };
  const cos = (x: Map<string, number>, y: Map<string, number>) => {
    let dot = 0, nx = 0, ny = 0;
    for (const [w, v] of x) {
      nx += v * v;
      const o = y.get(w);
      if (o) dot += v * o;
    }
    for (const v of y.values()) ny += v * v;
    return nx && ny ? dot / Math.sqrt(nx * ny) : 0;
  };
  const [va, ...vs] = all.map(vec);
  return vs.map((v) => cos(va, v));
}

export type ExistingTopic = { id: string; mainQuery?: string; text: string };

export function duplicateTopic(candidate: { mainQuery?: string; text: string }, existing: ExistingTopic[], threshold: number): GateResult {
  const q = candidate.mainQuery ? normHeading(candidate.mainQuery) : "";
  const reasons: string[] = [];
  const sims = existing.length ? tfidfCosine(candidate.text, existing.map((e) => e.text)) : [];
  existing.forEach((e, i) => {
    if (q && e.mainQuery && normHeading(e.mainQuery) === q) reasons.push(`duplicate of "${e.id}" (same main query); refresh it instead`);
    else if (sims[i] > threshold) reasons.push(`duplicate of "${e.id}" (similarity ${sims[i].toFixed(2)} > ${threshold}); refresh it instead`);
  });
  return result(reasons);
}

// ---------- 6.4 caps, invariant 2 idempotency ----------

export function capFor(lane: Lane, caps: Config["caps"]): number {
  return lane === "refresh" ? caps.refreshes : lane === "new_post" ? caps.newPosts : caps.codePrs;
}

export function dailyCap(lane: Lane, shippedToday: number, caps: Config["caps"]): GateResult {
  const cap = capFor(lane, caps);
  return result(shippedToday >= cap ? [`daily cap reached (${shippedToday}/${cap} ${lane} today)`] : []);
}

export function notShippedToday(shippedToTargetToday: string[]): GateResult {
  return result(shippedToTargetToday.length ? [`already shipped today (${shippedToTargetToday.join(", ")})`] : []);
}

// ---------- 6.10 code-PR allowlist ----------

function globToRe(glob: string) {
  const re = glob
    .split("**")
    .map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${re}$`);
}

export function allowlisted(paths: string[], allowlist: string[]): GateResult {
  const res = allowlist.map(globToRe);
  const reasons: string[] = [];
  for (const p of paths) {
    if (p.startsWith("/") || p.split("/").includes("..") || p.includes("\\")) reasons.push(`gate_failed: invalid path "${p}"`);
    else if (!res.some((r) => r.test(p))) reasons.push(`gate_failed: file outside allowlist "${p}"`);
  }
  return result(reasons);
}

// ---------- Invariant 6: secrets ----------

export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return ["SANITY_WRITE_TOKEN", "GITHUB_TOKEN", "VERCEL_AUTOMATION_BYPASS_SECRET", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PERPLEXITY_API_KEY", "AI_GATEWAY_API_KEY"]
    .map((k) => env[k])
    .filter((v): v is string => !!v && v.length >= 8);
}

export function redact(text: string, secrets: string[]): string {
  let t = text;
  for (const s of secrets) if (s) t = t.split(s).join("[redacted]");
  return t;
}

export function noSecrets(text: string, secrets: string[]): GateResult {
  return result(secrets.some((s) => s && text.includes(s)) ? ["text contains a secret value"] : []);
}

// ---------- ledger lookups used by the gates ----------

export function shippedCountToday(ledger: Ledger, lane: Lane, date: string): number {
  return (ledger.db.prepare("SELECT COUNT(*) AS n FROM changes WHERE lane = ? AND date = ? AND status = 'shipped'").get(lane, date) as { n: number }).n;
}

export function shippedToTargetOn(ledger: Ledger, target: string, date: string): string[] {
  return (ledger.db.prepare("SELECT id FROM changes WHERE target = ? AND date = ? AND status IN ('shipped','pending')").all(target, date) as { id: string }[]).map((r) => r.id);
}

export function shippedToTarget(ledger: Ledger, target: string): { id: string; date: string }[] {
  return ledger.db
    .prepare("SELECT id, date FROM changes WHERE target = ? AND status IN ('shipped','pending') ORDER BY created_at")
    .all(target) as { id: string; date: string }[];
}
