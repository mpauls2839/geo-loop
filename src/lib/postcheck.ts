// Post-ship checks against the live site (spec 6.2, 6.5, 6.9, 9.1, 9.2). Pure HTTP via an injected
// fetch. Polls because the site revalidates on a timer (Synta blog: ISR revalidate = 60s), so the first
// fetch after a publish can still serve the old page. Restoring on failure is the caller's job (ship.ts).

import { isCtaHref, type CtaMatcher, type GateResult } from "./gates.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export type PageExpect = {
  url: string;
  title?: string;
  description?: string;
  cta?: CtaMatcher;
  imageUrl?: string;
};

export type PollOpts = { fetch: FetchLike; sleep?: Sleep; attempts?: number; intervalMs?: number; log?: (s: string) => void };
export type CheckResult = GateResult & { notes: string[] };

export function decodeEntities(s: string) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const squash = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

export function htmlTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? squash(m[1]) : null;
}

export function metaDescription(html: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (/\bname\s*=\s*["']description["']/i.test(tag)) {
      const c = tag.match(/\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i);
      if (c) return squash(c[1] ?? c[2] ?? "");
    }
  }
  return null;
}

export function anchorHrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => decodeEntities(m[1]));
}

export function jsonLdBlocks(html: string): string[] {
  return [...html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
}

/** One pass over a page. */
export async function checkPage(expect: PageExpect, fetchFn: FetchLike): Promise<GateResult> {
  const reasons: string[] = [];
  let res: Response;
  try {
    res = await fetchFn(expect.url, { redirect: "follow" });
  } catch (err) {
    return { pass: false, reasons: [`${expect.url}: fetch failed (${(err as Error).message})`] };
  }
  if (res.status !== 200) return { pass: false, reasons: [`${expect.url} returned ${res.status}`] };
  const html = await res.text();
  if (expect.title !== undefined) {
    const t = htmlTitle(html);
    if (!t || !t.includes(squash(expect.title))) reasons.push(`title mismatch: expected "${expect.title}", got "${t ?? "(none)"}"`);
  }
  if (expect.description !== undefined) {
    const d = metaDescription(html);
    if (d !== squash(expect.description)) reasons.push(`meta description mismatch: expected "${expect.description}", got "${d ?? "(none)"}"`);
  }
  if (expect.cta && !anchorHrefs(html).some((h) => isCtaHref(h, expect.cta!))) reasons.push("CTA link not found on the live page");
  if (expect.imageUrl) {
    try {
      const img = await fetchFn(expect.imageUrl, { method: "GET" });
      const type = img.headers.get("content-type") ?? "";
      if (img.status !== 200) reasons.push(`hero image returned ${img.status}`);
      else if (!type.startsWith("image/")) reasons.push(`hero image content-type "${type}"`);
    } catch (err) {
      reasons.push(`hero image fetch failed (${(err as Error).message})`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}

/** Optional 390px mobile render. Runs only when `playwright` is importable; otherwise a logged note. */
export async function mobileRender(url: string): Promise<{ ran: boolean; pass: boolean; note: string }> {
  const name = "playwright";
  let pw: { chromium: { launch: () => Promise<{ newPage: (o: unknown) => Promise<PwPage>; close: () => Promise<void> }> } };
  try {
    pw = await import(name);
  } catch {
    return { ran: false, pass: true, note: "mobile 390px render skipped: playwright not installed" };
  }
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const res = await page.goto(url);
    const overflow = await page.evaluate("document.documentElement.scrollWidth > 391");
    const ok = !!res && res.status() === 200 && !overflow;
    return { ran: true, pass: ok, note: ok ? "mobile 390px render ok" : `mobile 390px render failed (status ${res?.status()}, overflow ${overflow})` };
  } finally {
    await browser.close();
  }
}
type PwPage = { goto: (u: string) => Promise<{ status: () => number } | null>; evaluate: (js: string) => Promise<unknown> };

/** Poll until the page passes or attempts run out. */
export async function postcheck(expect: PageExpect, opts: PollOpts & { mobile?: boolean }): Promise<CheckResult> {
  const attempts = opts.attempts ?? 6;
  const sleep = opts.sleep ?? realSleep;
  let last: GateResult = { pass: false, reasons: ["not checked"] };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(opts.intervalMs ?? 15_000);
    last = await checkPage(expect, opts.fetch);
    if (last.pass) break;
  }
  const notes: string[] = [];
  if (last.pass && opts.mobile !== false) {
    const m = await mobileRender(expect.url);
    notes.push(m.note);
    opts.log?.(m.note);
    if (!m.pass) return { pass: false, reasons: [m.note], notes };
  }
  return { ...last, notes };
}

/** 9.2: poll until the URL returns 404 (or 410). */
export async function expectGone(url: string, opts: PollOpts): Promise<CheckResult> {
  const attempts = opts.attempts ?? 6;
  const sleep = opts.sleep ?? realSleep;
  let status = 0;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(opts.intervalMs ?? 15_000);
    try {
      status = (await opts.fetch(url, { redirect: "manual" })).status;
    } catch {
      status = -1;
    }
    if (status === 404 || status === 410) return { pass: true, reasons: [], notes: [] };
  }
  return { pass: false, reasons: [`${url} still returns ${status} after ${attempts} checks`], notes: [] };
}

// ---------- code-PR checks (6.9) ----------

/** Check a deployed site for the paths a code PR touched: 200, JSON-LD parses with schema.org @type, .txt served as text/plain. */
export async function checkSitePaths(baseUrl: string, paths: string[], fetchFn: FetchLike, headers: Record<string, string> = {}): Promise<GateResult> {
  const reasons: string[] = [];
  for (const p of paths) {
    const url = new URL(p, baseUrl).toString();
    let res: Response;
    try {
      res = await fetchFn(url, { headers });
    } catch (err) {
      reasons.push(`${p}: fetch failed (${(err as Error).message})`);
      continue;
    }
    if (res.status !== 200) {
      reasons.push(`${p} returned ${res.status}`);
      continue;
    }
    const type = res.headers.get("content-type") ?? "";
    if (p.endsWith(".txt") && !type.startsWith("text/plain")) reasons.push(`${p} served as "${type}", expected text/plain`);
    if (type.includes("html")) {
      const html = await res.text();
      for (const raw of jsonLdBlocks(html)) {
        try {
          const items = [JSON.parse(raw)].flat();
          for (const it of items) {
            const graph = it?.["@graph"] ? [it["@graph"]].flat() : [it];
            const ctxOk = String(it?.["@context"] ?? "").includes("schema.org");
            if (!ctxOk) reasons.push(`${p}: JSON-LD missing schema.org @context`);
            for (const g of graph) if (!g?.["@type"]) reasons.push(`${p}: JSON-LD item without @type`);
          }
        } catch {
          reasons.push(`${p}: JSON-LD does not parse`);
        }
      }
    }
  }
  return { pass: reasons.length === 0, reasons };
}

export async function pollSitePaths(baseUrl: string, paths: string[], opts: PollOpts & { headers?: Record<string, string> }): Promise<GateResult> {
  const attempts = opts.attempts ?? 1;
  const sleep = opts.sleep ?? realSleep;
  let last: GateResult = { pass: false, reasons: ["not checked"] };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(opts.intervalMs ?? 60_000);
    last = await checkSitePaths(baseUrl, paths, opts.fetch, opts.headers);
    if (last.pass) break;
  }
  return last;
}
