// Page fetching and readable-text extraction for the mock eval (spec §4).

export type PageText = { url: string; title: string; headings: string[]; text: string };

/** Loads one candidate page. Throws PageFetchError when the page can't be used (4.9). */
export type PageLoader = (url: string) => Promise<PageText>;

export class PageFetchError extends Error {
  constructor(readonly url: string, readonly reason: string) {
    super(`${url}: ${reason}`);
  }
}

export const MAX_PAGE_CHARS = 12_000;

export type FetchPageOptions = { fetchImpl?: typeof fetch; timeoutMs?: number; maxChars?: number };

export async function fetchPage(url: string, opts: FetchPageOptions = {}): Promise<PageText> {
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      headers: { "user-agent": "geo-loop/0.1", accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
    });
  } catch (err) {
    const e = err as Error;
    throw new PageFetchError(url, e.name === "TimeoutError" || e.name === "AbortError" ? "timeout" : `fetch failed: ${e.message}`);
  }
  if (!res.ok) throw new PageFetchError(url, `HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (type && !/html|text|xml/i.test(type)) throw new PageFetchError(url, `unsupported content-type ${type}`);
  const body = await res.text();
  const page = /html/i.test(type) || /<html|<body|<p[\s>]/i.test(body) ? extractReadable(body, url, opts.maxChars) : pageFromText(body, url, opts.maxChars);
  if (page.text.length < 50) throw new PageFetchError(url, "no readable text");
  return page;
}

const DROP_BLOCKS = ["script", "style", "noscript", "template", "svg", "nav", "header", "footer", "aside", "form", "iframe", "button"];

/** Title, h1-h3 headings and body text from HTML, minus scripts and chrome. Prefers <main>/<article> when present. */
export function extractReadable(html: string, url: string, maxChars = MAX_PAGE_CHARS): PageText {
  let h = html.replace(/<!--[\s\S]*?-->/g, " ");
  const title = clean(h.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  for (const tag of DROP_BLOCKS) h = h.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  h = h.replace(/<head\b[\s\S]*?<\/head>/i, " ");
  const main = h.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? h.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  if (main && clean(stripTags(main)).length > 200) h = main;
  const headings = [...h.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => clean(stripTags(m[2]))).filter(Boolean);
  const text = clean(
    stripTags(h.replace(/<\/(p|div|li|h[1-6]|tr|section|article|br|pre|blockquote)>|<br\s*\/?>/gi, "\n")),
    true,
  );
  return { url, title: title || headings[0] || "", headings, text: cap(text, maxChars) };
}

/** A draft passed as markdown or plain text (draft vs live, 4.3). */
export function pageFromText(body: string, url: string, maxChars = MAX_PAGE_CHARS): PageText {
  const lines = body.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  const headings = lines.filter((l) => /^#{1,3}\s+\S/.test(l)).map((l) => l.replace(/^#+\s+/, "").trim());
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { url, title: headings[0] ?? "", headings, text: cap(text, maxChars) };
}

function stripTags(s: string) {
  return s.replace(/<[^>]+>/g, " ");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "-", ndash: "-", hellip: "..." };

function clean(s: string, keepLines = false) {
  const decoded = s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
  if (!keepLines) return decoded.replace(/\s+/g, " ").trim();
  return decoded
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function cap(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`;
}
