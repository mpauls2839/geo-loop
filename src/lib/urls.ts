// URL normalization and registered-domain matching (spec 2.2, 2.4).

const MULTI_PART_TLDS = new Set(["co.uk", "com.au", "co.jp", "com.br", "co.in", "co.nz", "org.uk", "ac.uk"]);

export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) {
    if (/^utm_|^ref$|^fbclid$|^gclid$/i.test(k)) u.searchParams.delete(k);
  }
  let s = u.toString();
  if (u.pathname !== "/" && s.endsWith("/")) s = s.slice(0, -1);
  if (u.pathname === "/" && !u.search) s = s.replace(/\/$/, "");
  return s;
}

export function registeredDomain(urlOrHost: string): string | null {
  let host = urlOrHost;
  if (/^https?:\/\//i.test(urlOrHost)) {
    try {
      host = new URL(urlOrHost).hostname;
    } catch {
      return null;
    }
  }
  host = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const parts = host.split(".");
  if (parts.length < 2) return null;
  const lastTwo = parts.slice(-2).join(".");
  if (MULTI_PART_TLDS.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join(".");
  return lastTwo;
}

export function isBrandUrl(url: string, brandDomain: string): boolean {
  const d = registeredDomain(url);
  return d !== null && d === registeredDomain(brandDomain);
}

export function mentionsBrand(text: string, names: string[]): boolean {
  return names.some((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}($|[^\\p{L}\\p{N}])`, "iu").test(text));
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
