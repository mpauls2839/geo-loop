import type Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import { claude, type ClaudeHandle } from "./claude.js";

// Social listening for the outreach lane: find real, recent posts where people ask what the
// brand's buyer questions ask, on X, LinkedIn, Bluesky, Reddit, Hacker News and Threads.
// Read-only. Nothing here posts, likes or follows; drafts are written elsewhere for a human.
//
// Sources (each best effort, each can fail without failing the run):
// - X, LinkedIn, Threads: Claude web search restricted to those domains (no free search APIs).
// - Bluesky: search API with an optional app-password session (BSKY_HANDLE, BSKY_APP_PASSWORD);
//   without it, web search still covers bsky.app.
// - Reddit: public JSON search (often blocked from cloud IPs; then web search covers it).
// - Hacker News: Algolia's public API.

export type SocialPlatform = "x" | "linkedin" | "bluesky" | "reddit" | "hn" | "threads";
export type SocialPost = {
  url: string;
  platform: SocialPlatform;
  title: string;
  snippet: string;
  createdAt?: string;
  via: string; // which source found it
  query: string;
};

type FetchFn = typeof fetch;

const PATTERNS: [SocialPlatform, RegExp][] = [
  ["x", /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/i],
  ["linkedin", /^https?:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/(?:posts\/|feed\/update\/)/i],
  ["bluesky", /^https?:\/\/bsky\.app\/profile\/[^/]+\/post\/[a-z0-9]+/i],
  ["reddit", /^https?:\/\/(?:www\.|old\.)?reddit\.com\/r\/[^/]+\/comments\//i],
  ["hn", /^https?:\/\/news\.ycombinator\.com\/item\?id=\d+/i],
  ["threads", /^https?:\/\/(?:www\.)?threads\.(?:net|com)\/@[^/]+\/post\//i],
];

/** The platform of a URL that points at one specific post (not a profile, search or feed). */
export function socialPlatform(url: string): SocialPlatform | null {
  for (const [p, re] of PATTERNS) if (re.test(url)) return p;
  return null;
}

export const PLATFORM_LABEL: Record<SocialPlatform, string> = {
  x: "X",
  linkedin: "LinkedIn",
  bluesky: "Bluesky",
  reddit: "Reddit",
  hn: "Hacker News",
  threads: "Threads",
};

/** Reply length limits: X allows 280 characters, Bluesky 300; others get a word budget. */
export const REPLY_LIMIT: Record<SocialPlatform, { chars?: number; words?: number }> = {
  x: { chars: 270 },
  bluesky: { chars: 290 },
  threads: { chars: 480 },
  linkedin: { words: 120 },
  reddit: { words: 180 },
  hn: { words: 150 },
};

export type SocialDeps = {
  fetch?: FetchFn;
  webSearch?: (query: string, domains: string[]) => Promise<{ url: string; title: string; snippet: string; pageAge?: string }[]>;
  now?: Date;
};

/** Claude web search limited to the given domains. Returns the search results it saw (not an answer). */
export function claudeWebSearch(config: Config, handle?: ClaudeHandle): NonNullable<SocialDeps["webSearch"]> {
  return async (query, domains) => {
    const h = handle ?? claude();
    const res = await h.client.messages.create({
      model: h.model(config.judge.model),
      max_tokens: 1024,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2, allowed_domains: domains } as Anthropic.Messages.ToolUnion],
      messages: [{ role: "user", content: `Search for recent social posts where people ask about: ${query}. Just search; a one-line answer is enough.` }],
    });
    const out: { url: string; title: string; snippet: string; pageAge?: string }[] = [];
    for (const b of res.content) {
      if (b.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
      for (const r of b.content) out.push({ url: r.url, title: r.title, snippet: "", pageAge: r.page_age ?? undefined });
    }
    return out;
  };
}

async function hnSearch(q: string, f: FetchFn, sinceSec: number): Promise<SocialPost[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=(story,comment)&numericFilters=created_at_i>${sinceSec}&hitsPerPage=5`;
  const r = await f(url);
  if (!r.ok) return [];
  const j = (await r.json()) as { hits: { objectID: string; title?: string; story_title?: string; comment_text?: string; created_at: string }[] };
  return j.hits.map((h) => ({
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    platform: "hn" as const,
    title: h.title ?? h.story_title ?? "",
    snippet: (h.comment_text ?? "").replace(/<[^>]+>/g, " ").slice(0, 400),
    createdAt: h.created_at,
    via: "hn-algolia",
    query: q,
  }));
}

/** Bluesky search needs a session: BSKY_HANDLE + BSKY_APP_PASSWORD (an app password, read-only use). */
export async function blueskySession(f: FetchFn, env = process.env): Promise<string | null> {
  if (!env.BSKY_HANDLE || !env.BSKY_APP_PASSWORD) return null;
  const r = await f("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: env.BSKY_HANDLE, password: env.BSKY_APP_PASSWORD }),
  });
  if (!r.ok) throw new Error(`Bluesky sign-in failed: HTTP ${r.status}`);
  return ((await r.json()) as { accessJwt: string }).accessJwt;
}

async function blueskySearch(q: string, f: FetchFn, jwt: string): Promise<SocialPost[]> {
  const r = await f(`https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=8&sort=latest`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as { posts?: { uri: string; author: { handle: string }; record: { text?: string; createdAt?: string } }[] };
  return (j.posts ?? []).map((p) => {
    const rkey = p.uri.split("/").pop();
    return {
      url: `https://bsky.app/profile/${p.author.handle}/post/${rkey}`,
      platform: "bluesky" as const,
      title: (p.record.text ?? "").slice(0, 120),
      snippet: (p.record.text ?? "").slice(0, 400),
      createdAt: p.record.createdAt,
      via: "bluesky-api",
      query: q,
    };
  });
}

async function redditSearch(q: string, f: FetchFn): Promise<SocialPost[]> {
  const r = await f(`https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=new&t=month&limit=8`, {
    headers: { "user-agent": "geo-loop/0.1 (+https://github.com/mpauls2839/geo-loop)" },
  });
  if (!r.ok) return [];
  const j = (await r.json()) as { data?: { children?: { data: { permalink: string; title: string; selftext?: string; created_utc: number; locked?: boolean; archived?: boolean } }[] } };
  return (j.data?.children ?? [])
    .filter((c) => !c.data.locked && !c.data.archived)
    .map((c) => ({
      url: `https://www.reddit.com${c.data.permalink}`,
      platform: "reddit" as const,
      title: c.data.title,
      snippet: (c.data.selftext ?? "").slice(0, 400),
      createdAt: new Date(c.data.created_utc * 1000).toISOString(),
      via: "reddit-api",
      query: q,
    }));
}

function parsePageAge(s?: string, now = new Date()): string | undefined {
  if (!s) return undefined;
  const d = Date.parse(s);
  if (!Number.isNaN(d)) return new Date(d).toISOString();
  const m = /(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/i.exec(s);
  if (!m) return undefined;
  const unit = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[m[2].toLowerCase() as "day"];
  return new Date(now.getTime() - Number(m[1]) * unit).toISOString();
}

/**
 * Find real posts to reply to. Queries are the brand's buyer questions (core first, then explore).
 * Returns at most `limit` posts, newest first, spread across platforms, excluding the brand's own posts.
 */
export async function findSocialPosts(
  config: Config,
  opts: SocialDeps & { maxQueries?: number; limit?: number; notes?: string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<SocialPost[]> {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? new Date();
  const notes = opts.notes ?? [];
  const maxAgeMs = config.gates.threadMaxAgeDays * 864e5;
  const questions = config.questions.slice(0, opts.maxQueries ?? 6).map((q) => q.text);
  const brand = [config.brand.name, ...config.brand.aliases, config.brand.domain].map((b) => b.toLowerCase());
  const found: SocialPost[] = [];
  const sinceSec = Math.floor((now.getTime() - maxAgeMs) / 1000);

  const tryIt = async (label: string, fn: () => Promise<SocialPost[]>) => {
    try {
      const xs = await fn();
      found.push(...xs);
      return xs.length;
    } catch (err) {
      notes.push(`${label}: ${(err as Error).message}`);
      return 0;
    }
  };

  const webSearch = opts.webSearch ?? (() => { try { return claudeWebSearch(config); } catch { return undefined; } })();
  let bskyJwt: string | null = null;
  try {
    bskyJwt = await blueskySession(f, opts.env);
  } catch (err) {
    notes.push((err as Error).message);
  }
  const counts: Record<string, number> = {};
  for (const q of questions) {
    // Keyword form for the APIs (they match words, not full questions).
    const kw = q.replace(/[?.,!]/g, "").split(/\s+/).filter((w) => w.length > 2 && !/^(how|what|the|and|for|with|from|does|are|can|should|which|best|why|when|keep|make|my|your|there|that|this|into|use|get)$/i.test(w)).slice(0, 5).join(" ");
    counts.hn = (counts.hn ?? 0) + (await tryIt("hn", () => hnSearch(kw, f, sinceSec)));
    if (bskyJwt) counts.bluesky = (counts.bluesky ?? 0) + (await tryIt("bluesky", () => blueskySearch(kw, f, bskyJwt!)));
    counts.reddit = (counts.reddit ?? 0) + (await tryIt("reddit", () => redditSearch(kw, f)));
    if (webSearch) {
      counts.web =
        (counts.web ?? 0) +
        (await tryIt("web search", async () =>
          (await webSearch(q, ["x.com", "twitter.com", "linkedin.com", "threads.net", "bsky.app", "reddit.com"])).flatMap((r): SocialPost[] => {
            const platform = socialPlatform(r.url);
            return platform ? [{ url: r.url, platform, title: r.title, snippet: r.snippet, createdAt: parsePageAge(r.pageAge, now), via: "web-search", query: q }] : [];
          })));
    }
  }
  notes.push(`social: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}${webSearch ? "" : " (web search off: no Claude key)"}`);

  // Keep only specific posts, recent enough, not the brand's own; dedupe by URL.
  const seen = new Set<string>();
  const fresh = found.filter((p) => {
    const key = p.url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
    if (seen.has(key) || !socialPlatform(p.url)) return false;
    seen.add(key);
    if (brand.some((b) => p.url.toLowerCase().includes(`/${b.replace(/\..*$/, "")}`))) return false;
    if (p.createdAt && now.getTime() - Date.parse(p.createdAt) > maxAgeMs) return false;
    return true;
  });
  fresh.sort((a, b) => (b.createdAt ? Date.parse(b.createdAt) : 0) - (a.createdAt ? Date.parse(a.createdAt) : 0));

  // Round-robin across platforms so one noisy source can't fill the cap.
  const byPlatform = new Map<SocialPlatform, SocialPost[]>();
  for (const p of fresh) byPlatform.set(p.platform, [...(byPlatform.get(p.platform) ?? []), p]);
  const out: SocialPost[] = [];
  const limit = opts.limit ?? 20;
  while (out.length < limit && [...byPlatform.values()].some((xs) => xs.length)) {
    for (const xs of byPlatform.values()) if (xs.length && out.length < limit) out.push(xs.shift()!);
  }
  return out;
}
