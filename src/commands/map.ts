import type { Config } from "../config.js";
import type { Ledger } from "../lib/ledger.js";
import { isBrandUrl, registeredDomain } from "../lib/urls.js";

export type MapRow = {
  domain: string;
  self: boolean;
  citations: number;
  questions: number;
  engines: string[];
  topics: string[];
  topUrls: { url: string; count: number }[];
};

/** Citation-source map: which domains AI engines cite for our questions (spec §3). */
export function citationMap(config: Config, ledger: Ledger, date: string, opts: { topic?: string } = {}): MapRow[] {
  const rows = ledger.db
    .prepare("SELECT question_id, engine, cited_urls FROM probe_answers WHERE date = ? AND error IS NULL")
    .all(date) as { question_id: string; engine: string; cited_urls: string }[];
  const topicOf = new Map(config.questions.map((q) => [q.id, q.topic]));
  const byDomain = new Map<string, { citations: number; qs: Set<string>; engines: Set<string>; topics: Set<string>; urls: Map<string, number> }>();
  for (const r of rows) {
    const topic = topicOf.get(r.question_id) ?? "general";
    if (opts.topic && topic !== opts.topic) continue;
    for (const url of JSON.parse(r.cited_urls) as string[]) {
      const d = registeredDomain(url);
      if (!d) continue;
      const e = byDomain.get(d) ?? { citations: 0, qs: new Set(), engines: new Set(), topics: new Set(), urls: new Map() };
      e.citations++;
      e.qs.add(r.question_id);
      e.engines.add(r.engine);
      e.topics.add(topic);
      e.urls.set(url, (e.urls.get(url) ?? 0) + 1);
      byDomain.set(d, e);
    }
  }
  return [...byDomain.entries()]
    .map(([domain, e]) => ({
      domain,
      self: isBrandUrl(`https://${domain}`, config.brand.domain),
      citations: e.citations,
      questions: e.qs.size,
      engines: [...e.engines].sort(),
      topics: [...e.topics].sort(),
      topUrls: [...e.urls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([url, count]) => ({ url, count })),
    }))
    .sort((a, b) => Number(a.self) - Number(b.self) || b.questions - a.questions || b.citations - a.citations);
}

export function topicsOf(config: Config) {
  return [...new Set(config.questions.map((q) => q.topic))];
}
