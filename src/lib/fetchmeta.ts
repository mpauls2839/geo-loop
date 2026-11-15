// Off-site target classification and thread metadata (spec slice 8, verification 7.x).
// URL patterns decide first; the network is touched only to read age/lock state of a thread
// or to check an article page for brand/competitor presence. Read-only, no credentials.

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type Platform = "reddit" | "discourse" | "stackexchange" | "github" | "hn" | "forum";
export type UrlClass =
  | { kind: "thread"; platform: Platform }
  | { kind: "article" }
  | { kind: "maybe-article" } // needs a fetch to decide
  | { kind: "other" };

const SE_HOSTS = /(^|\.)(stackoverflow\.com|stackexchange\.com|serverfault\.com|superuser\.com|askubuntu\.com)$/;
const LISTICLE = /(^|[-_/])(best|top|alternatives?|vs|versus|compared?|comparison|reviews?|tools|roundup|listicle)([-_/.]|$)|\d+-(best|top)|top-\d+/i;
const NOT_CONTENT = /^\/(docs?|documentation|api|reference|pricing|login|signup|sign-up|download|integrations?|changelog|legal|privacy|terms)(\/|$)/i;

export function classifyUrl(raw: string): UrlClass {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { kind: "other" };
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname;
  if (/(^|\.)reddit\.com$/.test(host) && /\/comments\/[a-z0-9]+/i.test(path)) return { kind: "thread", platform: "reddit" };
  if (host === "news.ycombinator.com" && path === "/item" && u.searchParams.get("id")) return { kind: "thread", platform: "hn" };
  if (SE_HOSTS.test(host) && /^\/questions\/\d+/.test(path)) return { kind: "thread", platform: "stackexchange" };
  if (host === "github.com" && /^\/[^/]+\/[^/]+\/(discussions|issues)\/\d+/.test(path)) return { kind: "thread", platform: "github" };
  if (/^\/t\/[^/]+(\/\d+)?/.test(path) && discourseId(path)) return { kind: "thread", platform: "discourse" };
  if (/^(community|forum|forums|discuss|discourse)\./.test(host) || /\/(forum|forums|community|threads?)\//.test(path)) {
    return { kind: "thread", platform: "forum" };
  }
  if (docsHost(host) || path === "/" || NOT_CONTENT.test(path)) return { kind: "other" };
  if (LISTICLE.test(path)) return { kind: "article" };
  if (/\/(blog|articles?|posts?|news|guides?|resources)\//i.test(path)) return { kind: "maybe-article" };
  return { kind: "other" };
}

function docsHost(host: string) {
  return /^(docs|developer|developers|api|status|app|help|support)\./.test(host);
}

function discourseId(path: string): string | null {
  // /t/<slug>/<id>[/<post>] or /t/<id>
  const m = path.match(/^\/t\/(?:[^/]+\/)?(\d+)(?:\/\d+)?\/?$/);
  return m ? m[1] : null;
}

export type ThreadMeta = {
  platform: Platform;
  fetched: boolean;
  title?: string;
  body?: string;
  createdAt?: string; // ISO
  locked?: boolean;
  archived?: boolean;
  closed?: boolean;
  error?: string;
};

const UA = { "user-agent": "geo-loop/0.1 (+https://github.com/geo-loop)", accept: "application/json" };

async function getJson(fetchFn: FetchFn, url: string): Promise<unknown> {
  const res = await fetchFn(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Best-effort thread metadata. Never throws: unknown fields stay undefined and `error` says why. */
export async function fetchThreadMeta(url: string, platform: Platform, fetchFn: FetchFn = fetch): Promise<ThreadMeta> {
  const base: ThreadMeta = { platform, fetched: false };
  try {
    const u = new URL(url);
    switch (platform) {
      case "reddit": {
        const j = (await getJson(fetchFn, `https://www.reddit.com${u.pathname.replace(/\/$/, "")}.json?raw_json=1`)) as any;
        const d = j?.[0]?.data?.children?.[0]?.data;
        if (!d) throw new Error("unexpected reddit payload");
        return {
          ...base, fetched: true, title: d.title, body: d.selftext,
          createdAt: typeof d.created_utc === "number" ? new Date(d.created_utc * 1000).toISOString() : undefined,
          locked: !!d.locked, archived: !!d.archived,
        };
      }
      case "discourse":
      case "forum": {
        const id = discourseId(u.pathname);
        if (!id) return { ...base, error: "no thread id in URL" };
        const j = (await getJson(fetchFn, `${u.origin}/t/${id}.json`)) as any;
        if (!j || typeof j !== "object" || !("created_at" in j)) throw new Error("not a Discourse topic");
        return {
          ...base, platform: "discourse", fetched: true, title: j.title,
          body: stripHtml(j.post_stream?.posts?.[0]?.cooked ?? ""),
          createdAt: j.created_at, closed: !!j.closed, archived: !!j.archived,
        };
      }
      case "stackexchange": {
        const id = u.pathname.match(/^\/questions\/(\d+)/)?.[1];
        const site = u.hostname.replace(/^www\./, "").replace(/\.com$/, "").replace(/\.stackexchange$/, "");
        const j = (await getJson(fetchFn, `https://api.stackexchange.com/2.3/questions/${id}?site=${site}&filter=withbody`)) as any;
        const q = j?.items?.[0];
        if (!q) throw new Error("question not found");
        return {
          ...base, fetched: true, title: q.title, body: stripHtml(q.body ?? ""),
          createdAt: new Date(q.creation_date * 1000).toISOString(),
          closed: q.closed_date != null, locked: q.locked_date != null,
        };
      }
      case "github": {
        const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(discussions|issues)\/(\d+)/)!;
        const j = (await getJson(fetchFn, `https://api.github.com/repos/${m[1]}/${m[2]}/${m[3]}/${m[4]}`)) as any;
        return {
          ...base, fetched: true, title: j.title, body: j.body ?? "", createdAt: j.created_at,
          locked: !!j.locked, closed: j.state === "closed" || j.closed === true,
        };
      }
      case "hn": {
        const id = u.searchParams.get("id");
        const j = (await getJson(fetchFn, `https://hacker-news.firebaseio.com/v0/item/${id}.json`)) as any;
        if (!j) throw new Error("item not found");
        return {
          ...base, fetched: true, title: j.title, body: stripHtml(j.text ?? ""),
          createdAt: new Date(j.time * 1000).toISOString(), closed: !!j.dead || !!j.deleted,
        };
      }
    }
  } catch (err) {
    return { ...base, error: (err as Error).message };
  }
}

export type PageInfo = { ok: boolean; title?: string; author?: string; text: string; links: string[]; error?: string };

/** Fetches an article page (HTML) for title, author, visible text and outbound links. Never throws. */
export async function fetchPage(url: string, fetchFn: FetchFn = fetch): Promise<PageInfo> {
  try {
    const res = await fetchFn(url, { headers: { ...UA, accept: "text/html" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, text: "", links: [], error: `HTTP ${res.status}` };
    const html = (await res.text()).slice(0, 2_000_000);
    const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "") || undefined;
    const author =
      attr(html, /<meta[^>]+name=["']author["'][^>]*>/i) ??
      html.match(/"author"\s*:\s*(?:\[\s*)?\{[^}]*?"name"\s*:\s*"([^"]+)"/)?.[1] ??
      undefined;
    const links = [...html.matchAll(/href=["'](https?:\/\/[^"'#]+)["']/gi)].map((m) => m[1]);
    return { ok: true, title, author, text: stripHtml(html), links };
  } catch (err) {
    return { ok: false, text: "", links: [], error: (err as Error).message };
  }
}

function attr(html: string, tagRe: RegExp): string | undefined {
  const tag = html.match(tagRe)?.[0];
  return tag?.match(/content=["']([^"']+)["']/i)?.[1];
}

export function stripHtml(html: string): string {
  return decode(
    html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function decode(s: string) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, " ");
}

export function ageDays(createdAt: string | undefined, now: Date): number | undefined {
  if (!createdAt) return undefined;
  const t = Date.parse(createdAt);
  return Number.isNaN(t) ? undefined : Math.floor((now.getTime() - t) / 86_400_000);
}
