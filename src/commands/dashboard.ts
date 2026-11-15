import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../config.js";
import type { Ledger } from "../lib/ledger.js";
import { registeredDomain } from "../lib/urls.js";
import { redact } from "./report.js";

// The visual dashboard: one self-contained HTML page that walks the loop top to bottom
// (measure -> where AI looks -> what we changed -> what the judge said -> what's next).
// No external scripts or fonts; light and dark themes; safe to open offline.

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

type Proposal = {
  id: string;
  changeId?: string;
  lane?: string;
  link?: string;
  linkLabel?: string;
  target: string;
  status: "would ship" | "held" | "eval only";
  reason: string;
  techniques: string[];
  title?: string;
  excerpt?: string;
  rows: { q: string; live: number | null; draft: number | null }[];
  verdict?: string;
  verdictReason?: string;
};

function readProposals(dir: string): Proposal[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir);
  const out: Proposal[] = [];
  for (const f of files.filter((x) => x.endsWith(".change.json"))) {
    const base = f.replace(/\.change\.json$/, "");
    let change: Record<string, unknown> = {};
    try {
      change = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    const evalFile = join(dir, `${base}.eval.json`);
    const shipFile = join(dir, `${base}.ship-dry-run.txt`);
    let rows: Proposal["rows"] = [];
    let verdict: string | undefined;
    let verdictReason: string | undefined;
    if (existsSync(evalFile)) {
      try {
        const e = JSON.parse(readFileSync(evalFile, "utf8")) as {
          rows?: { questionId: string; live?: { winRate: number | null }; draft?: { winRate: number | null } }[];
          decision?: { verdict?: string; reason?: string };
        };
        rows = (e.rows ?? []).map((r) => ({ q: r.questionId, live: r.live?.winRate ?? null, draft: r.draft?.winRate ?? null }));
        verdict = e.decision?.verdict;
        verdictReason = e.decision?.reason;
      } catch {
        /* unreadable eval: show the proposal without scores */
      }
    }
    let status: Proposal["status"] = "eval only";
    let reason = verdictReason ?? "";
    let changeId: string | undefined;
    if (existsSync(shipFile)) {
      const first = readFileSync(shipFile, "utf8").split("\n")[0].trim().split(/\s{2,}/);
      status = first[0] === "dry_run" || first[0] === "shipped" ? "would ship" : "held";
      changeId = first[1];
      if (status === "held") reason = first.slice(2).join(" ") || reason;
    }
    const content = (change.content ?? {}) as { title?: string; excerpt?: string };
    out.push({
      id: base,
      changeId,
      lane: String(change.lane ?? "refresh"),
      target: String(change.target ?? base),
      status,
      reason,
      techniques: (change.techniques as string[]) ?? [],
      title: content.title,
      excerpt: content.excerpt,
      rows,
      verdict,
      verdictReason,
    });
  }
  const rank = { "would ship": 0, held: 1, "eval only": 2 } as const;
  return out.sort((a, b) => rank[a.status] - rank[b.status]);
}

/** Say what the change does: update an existing post, publish a new one, or open a code PR. */
function badgeText(p: Proposal, dry: boolean): string {
  if (p.status === "held") return "■ HELD";
  if (p.status === "eval only") return "EVAL ONLY";
  if (p.lane === "new_post") return dry ? "✓ WOULD PUBLISH" : "✓ PUBLISHED";
  if (p.lane === "code_pr") return dry ? "✓ WOULD OPEN PR" : "✓ PR OPENED";
  return dry ? "✓ WOULD UPDATE" : "✓ UPDATED";
}

function laneText(lane?: string): string {
  if (lane === "new_post") return "New blog post";
  if (lane === "code_pr") return "Site code change (pull request)";
  return "Update to an existing live post";
}

export function buildDashboard(config: Config, ledger: Ledger, opts: { date?: string; env?: NodeJS.ProcessEnv; now?: Date; proposedDir?: string } = {}): string {
  const db = ledger.db;
  const date =
    opts.date ?? ((db.prepare("SELECT MAX(date) AS d FROM probe_answers WHERE error IS NULL").get() as { d: string | null }).d ?? "");
  const brand = config.brand.name;
  const qById = new Map(config.questions.map((q) => [q.id, q]));

  // ---------- measurement ----------
  const answers = db
    .prepare("SELECT question_id, engine, sample, cited, mentioned, cited_urls FROM probe_answers WHERE date = ? AND error IS NULL")
    .all(date) as { question_id: string; engine: string; sample: number; cited: number; mentioned: number; cited_urls: string }[];
  const engines = [...new Set(answers.map((a) => a.engine))].sort();
  const total = answers.length;
  const cited = answers.filter((a) => a.cited).length;
  const named = answers.filter((a) => a.mentioned).length;
  const perEngine = engines.map((e) => {
    const xs = answers.filter((a) => a.engine === e);
    return { e, n: xs.length, c: xs.filter((a) => a.cited).length, m: xs.filter((a) => a.mentioned).length };
  });
  const topics = [...new Set(config.questions.map((q) => q.topic))];
  const topicRows = topics
    .map((t) => {
      const xs = answers.filter((a) => qById.get(a.question_id)?.topic === t);
      return { t, n: xs.length, cells: engines.map((e) => { const ys = xs.filter((a) => a.engine === e); return { n: ys.length, c: ys.filter((a) => a.cited).length }; }) };
    })
    .filter((r) => r.n > 0);

  // ---------- where AI looks ----------
  const domainCount = new Map<string, number>();
  for (const a of answers) for (const u of JSON.parse(a.cited_urls) as string[]) {
    const d = registeredDomain(u);
    if (d) domainCount.set(d, (domainCount.get(d) ?? 0) + 1);
  }
  const brandDomain = registeredDomain(config.brand.domain);
  const domains = [...domainCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const maxDomain = Math.max(1, ...domains.map((d) => d[1]));
  const searches = db
    .prepare("SELECT query, COUNT(*) AS n FROM engine_queries WHERE date = ? GROUP BY query ORDER BY n DESC, query LIMIT 18")
    .all(date) as { query: string; n: number }[];
  const searchTotal = (db.prepare("SELECT COUNT(*) AS n FROM engine_queries WHERE date = ?").get(date) as { n: number }).n;

  // ---------- questions ----------
  const qRows = config.questions.map((q) => {
    const xs = answers.filter((a) => a.question_id === q.id);
    return { q, byEngine: engines.map((e) => xs.filter((a) => a.engine === e).sort((a, b) => a.sample - b.sample)) };
  });

  // ---------- acting ----------
  const proposals = readProposals(opts.proposedDir ?? resolve(config.dataDir, "proposed", date));
  // Link each change: its PR when the loop opened one, otherwise the live blog post it targets.
  const base = config.site.baseUrl.replace(/\/$/, "") + config.site.blogPath.replace(/\/?$/, "/");
  for (const p of proposals) {
    const row = p.changeId
      ? (db.prepare("SELECT external_ref, lane FROM changes WHERE id = ?").get(p.changeId) as { external_ref: string | null; lane: string } | undefined)
      : undefined;
    const ref = row?.external_ref ? (JSON.parse(row.external_ref) as { prUrl?: string; pr?: number }) : {};
    if (ref.prUrl) {
      p.link = ref.prUrl;
      p.linkLabel = `PR #${ref.pr ?? ""}`.trim();
    } else if ((row?.lane ?? p.lane) !== "code_pr") {
      p.link = base + p.target;
      p.linkLabel = "live post";
    }
  }
  const drafts = db.prepare("SELECT kind, target_url, body, status, meta FROM drafts WHERE date = ? AND status = 'new' ORDER BY kind DESC, target_url").all(date) as {
    kind: string; target_url: string; body: string; status: string; meta: string;
  }[];
  const PLATFORM: Record<string, string> = { x: "X", linkedin: "LinkedIn", bluesky: "Bluesky", reddit: "Reddit", hn: "Hacker News", threads: "Threads", discourse: "Forum", forum: "Forum", stackexchange: "Stack Overflow", github: "GitHub" };
  const draftMeta = (m: string) => { try { return JSON.parse(m) as { platform?: string; title?: string; source?: string }; } catch { return {}; } };
  const runs = db.prepare("SELECT kind, status, started_at, shipped, held, skipped FROM runs WHERE date = ? ORDER BY started_at").all(date) as {
    kind: string; status: string; started_at: string; shipped: number; held: number; skipped: number;
  }[];
  const judgeCalls = (db.prepare("SELECT COALESCE(SUM(k), 0) AS n FROM evals WHERE created_at >= ?").get(date) as { n: number }).n;
  const held = proposals.filter((p) => p.status === "held").length;
  const wouldShip = proposals.filter((p) => p.status === "would ship").length;
  const coreN = config.questions.filter((q) => !q.id.startsWith("d-")).length;
  const exploreN = config.questions.length - coreN;

  const kpi = (big: string, label: string, sub: string, tone = "") =>
    `<div class="kpi ${tone}"><div class="big">${big}</div><div class="label">${esc(label)}</div><div class="sub">${sub}</div></div>`;
  const bar = (v: number, max: number, cls = "") => `<div class="bar ${cls}"><span style="width:${max ? Math.max(2, (v / max) * 100) : 0}%"></span></div>`;
  const heat = (c: number, n: number) => {
    if (!n) return `<td class="heat na">–</td>`;
    const p = c / n;
    return `<td class="heat" style="--h:${p.toFixed(2)}"><b>${Math.round(p * 100)}%</b><small>${c}/${n}</small></td>`;
  };
  const dots = (xs: { cited: number; mentioned: number }[]) =>
    xs.length ? xs.map((a) => `<i class="dot ${a.mentioned ? "named" : a.cited ? "cited" : ""}" title="${a.mentioned ? "named" : a.cited ? "cited" : "not cited"}"></i>`).join("") : `<span class="muted">–</span>`;
  const srcChip = (s: string) => `<span class="chip src-${esc(s)}">${esc(s === "seed" ? "your list" : s)}</span>`;
  const isExplore = (id: string) => id.startsWith("d-");

  const loopSteps: [string, string, string][] = [
    ["Discover", `${config.questions.length}`, `questions (${coreN} core, ${exploreN} from search data)`],
    ["Probe", `${total}`, `AI answers across ${engines.length} engines`],
    ["Map", `${domainCount.size}`, `domains AI cites`],
    ["Draft", `${proposals.length}`, `page changes proposed`],
    ["Judge", `${judgeCalls}`, `blind judge calls`],
    ["Gate", `${held}`, `held by guardrails`],
    ["Ship", `${wouldShip}`, config.shipMode === "dry_run" ? "would ship (dry run)" : "shipped"],
    ["Outreach", `${drafts.length}`, `off-site drafts for a human`],
  ];

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>geo-loop · ${esc(config.brand.domain)}</title>
<style>
:root{--bg:#f6f5f1;--card:#fff;--ink:#16181d;--muted:#6b7080;--line:#e6e3dc;--accent:#2f6df6;--good:#14935a;--warn:#c27a00;--bad:#c2410c;--brand:#7c3aed;--heat:47,109,246}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--ink:#eef0f4;--muted:#9aa1b2;--line:#262b36;--accent:#6b9bff;--good:#3ccf8e;--warn:#f0b03e;--bad:#ff7a45;--brand:#b28cff;--heat:107,155,255}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 60px}
header{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:22px}
h1{font-size:30px;margin:0;letter-spacing:-.02em}h1 span{color:var(--muted);font-weight:500}
h2{font-size:19px;margin:0 0 4px;letter-spacing:-.01em}.lede{color:var(--muted);margin:0 0 16px}
.pill{display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--line);background:var(--card)}
.pill.dry{color:var(--warn);border-color:var(--warn)}.pill.live{color:var(--good);border-color:var(--good)}
section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;margin:16px 0}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.kpi{border:1px solid var(--line);border-radius:14px;padding:16px;background:var(--card)}
.kpi .big{font-size:40px;font-weight:750;letter-spacing:-.03em;line-height:1}.kpi .label{font-weight:650;margin-top:8px}.kpi .sub{color:var(--muted);font-size:13px}
.kpi.alert .big{color:var(--bad)}.kpi.good .big{color:var(--good)}
.callout{margin-top:14px;padding:14px 16px;border-radius:12px;background:color-mix(in srgb,var(--brand) 10%,transparent);border:1px solid color-mix(in srgb,var(--brand) 35%,transparent);font-size:16px}
.loop{display:grid;grid-template-columns:repeat(8,1fr);gap:8px;position:relative}
.step{border:1px solid var(--line);border-radius:12px;padding:12px 10px;text-align:center;position:relative}
.step .n{font-size:26px;font-weight:750;color:var(--accent)}.step .t{font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.06em}.step .d{color:var(--muted);font-size:12px;line-height:1.3;margin-top:4px}
.step:not(:last-child)::after{content:"→";position:absolute;right:-10px;top:50%;transform:translateY(-50%);color:var(--muted);font-weight:700;z-index:1}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}.grid2>section{margin:0}
.row{display:grid;grid-template-columns:150px 1fr 70px;gap:10px;align-items:center;margin:8px 0}
.bar{height:12px;border-radius:99px;background:color-mix(in srgb,var(--muted) 15%,transparent);overflow:hidden}.bar span{display:block;height:100%;background:var(--accent);border-radius:99px}
.bar.named span{background:var(--brand)}.bar.self span{background:var(--brand)}.num{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted);font-size:13px}
.dom{grid-template-columns:170px 1fr 44px}.dom.self .name{color:var(--brand);font-weight:700}
table{width:100%;border-collapse:separate;border-spacing:0}th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);text-align:left;padding:8px;border-bottom:1px solid var(--line)}
td{padding:8px;border-bottom:1px solid var(--line);vertical-align:middle}
td.heat{text-align:center;background:rgba(var(--heat),calc(var(--h)*.85 + .04));border-radius:8px;border:3px solid var(--card)}td.heat b{display:block;font-size:16px}td.heat small{color:var(--muted)}
td.heat.na{background:transparent;color:var(--muted)}
.dot{display:inline-block;width:12px;height:12px;border-radius:50%;margin-right:3px;border:1.5px solid color-mix(in srgb,var(--muted) 50%,transparent)}
.dot.cited{background:var(--accent);border-color:var(--accent)}.dot.named{background:var(--brand);border-color:var(--brand)}
.legend{color:var(--muted);font-size:13px}.legend .dot{vertical-align:-2px}
.chip{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:650;background:color-mix(in srgb,var(--muted) 14%,transparent);color:var(--muted);margin:2px 4px 2px 0;white-space:nowrap}
.chip.src-gsc{background:#e8f1ff;color:#1d4fd8}.chip.src-autocomplete{background:#fff3e0;color:#a85d00}.chip.src-thread{background:#f3e8ff;color:#7c3aed}.chip.src-mixed{background:#e6f7ef;color:#0f7a4a}.chip.src-engine{background:#e7f7fb;color:#0e7490}
@media (prefers-color-scheme:dark){.chip.src-gsc{background:#1d2b4a;color:#9cc0ff}.chip.src-autocomplete{background:#3a2a12;color:#ffc979}.chip.src-thread{background:#2c1f45;color:#cfb3ff}.chip.src-mixed{background:#123a2a;color:#7fe0b2}.chip.src-engine{background:#123540;color:#86dff0}}
.tier{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.searches{display:flex;flex-wrap:wrap;gap:6px}.searches span{padding:6px 10px;border-radius:10px;border:1px solid var(--line);font-size:13px}.searches b{color:var(--accent);margin-left:6px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}
.card{border:1px solid var(--line);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:8px}
.badge{align-self:flex-start;font-size:12px;font-weight:750;padding:3px 10px;border-radius:999px}
.badge.ship{background:color-mix(in srgb,var(--good) 18%,transparent);color:var(--good)}.badge.held{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}.badge.eval{background:color-mix(in srgb,var(--muted) 18%,transparent);color:var(--muted)}
.card h3{margin:0;font-size:16px}.card .why{color:var(--muted);font-size:13px}
.vs{display:grid;grid-template-columns:70px 1fr 40px;gap:8px;align-items:center;font-size:12px}.vs .bar{height:10px}.vs .bar.draft span{background:var(--good)}.vs .bar.live span{background:color-mix(in srgb,var(--muted) 60%,transparent)}
.qid{font-weight:700;font-size:12px;margin-top:4px}
.draft pre{white-space:pre-wrap;font:13px/1.45 ui-sans-serif,system-ui;margin:0;color:var(--ink);max-height:130px;overflow:hidden;-webkit-mask-image:linear-gradient(#000 70%,transparent)}
.timeline{display:flex;flex-wrap:wrap;gap:8px}.run{border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:12px}.run b{display:block;font-size:13px}
.run.ok{border-color:color-mix(in srgb,var(--good) 50%,var(--line))}.run.partial{border-color:color-mix(in srgb,var(--warn) 60%,var(--line))}.run.failed{border-color:var(--bad)}
.card h3 a,.card h3 a:visited{color:inherit;text-decoration:none;border-bottom:1.5px solid color-mix(in srgb,var(--accent) 55%,transparent)}.card h3 a:hover{color:var(--accent)}
.chip.plat-x{background:#111;color:#fff}.chip.plat-linkedin{background:#0a66c2;color:#fff}.chip.plat-bluesky{background:#1185fe;color:#fff}.chip.plat-reddit{background:#ff4500;color:#fff}.chip.plat-hn{background:#ff6600;color:#fff}.chip.plat-threads{background:#000;color:#fff}
.muted{color:var(--muted)}footer{color:var(--muted);font-size:12px;text-align:center;margin-top:24px}
@media (max-width:900px){.kpis{grid-template-columns:repeat(2,1fr)}.loop{grid-template-columns:repeat(4,1fr)}.step:nth-child(4)::after{display:none}.grid2{grid-template-columns:1fr}}
@media (max-width:520px){.kpis{grid-template-columns:1fr}.loop{grid-template-columns:repeat(2,1fr)}.step:nth-child(2n)::after{display:none}.row{grid-template-columns:110px 1fr 56px}}
</style></head><body><div class="wrap">

<header><div><div class="muted">geo-loop · weekly SEO/GEO loop</div><h1>${esc(brand)} <span>in AI answers · ${esc(date)}</span></h1></div>
<div><span class="pill ${config.shipMode === "dry_run" ? "dry" : "live"}">${config.shipMode === "dry_run" ? "DRY RUN · nothing published" : "LIVE"}</span></div></header>

<section>
<div class="kpis">
${kpi(`${pct(cited, total)}%`, "Citation share", `${cited} of ${total} AI answers cite ${esc(config.brand.domain)}`)}
${kpi(`${pct(named, total)}%`, "Mention rate", `${named} of ${total} answers name ${esc(brand)}`, "alert")}
${kpi(`${config.questions.length}`, "Buyer questions", `${coreN} yours · ${exploreN} from real search data`)}
${kpi(`${wouldShip}/${proposals.length}`, "Changes passed", `${held} held by guardrails`, wouldShip ? "good" : "")}
</div>
<div class="callout">AI engines use <b>${esc(config.brand.domain)}</b> as a source in <b>${pct(cited, total)}%</b> of answers, but recommend <b>${esc(brand)}</b> by name in only <b>${pct(named, total)}%</b>.</div>
</section>

<section><h2>The loop</h2><p class="lede">Every Monday an isolated cloud agent runs this end to end and commits the results.</p>
<div class="loop">${loopSteps.map(([t, n, d]) => `<div class="step"><div class="t">${t}</div><div class="n">${n}</div><div class="d">${esc(d)}</div></div>`).join("")}</div></section>

<div class="grid2">
<section><h2>By engine</h2><p class="lede">Share of answers that cite the site, and that name the brand.</p>
${perEngine.map((p) => `<div class="row"><b>${esc(p.e)}</b>${bar(p.c, p.n)}<span class="num">${pct(p.c, p.n)}% cite</span></div><div class="row"><span class="muted">named</span>${bar(p.m, p.n, "named")}<span class="num">${pct(p.m, p.n)}%</span></div>`).join("")}
</section>
<section><h2>By topic</h2><p class="lede">Where ${esc(brand)} is cited, and where it's invisible.</p>
<table><tr><th>Topic</th>${engines.map((e) => `<th style="text-align:center">${esc(e)}</th>`).join("")}</tr>
${topicRows.map((r) => `<tr><td><b>${esc(r.t)}</b></td>${r.cells.map((c) => heat(c.c, c.n)).join("")}</tr>`).join("")}</table>
</section>
</div>

<div class="grid2">
<section><h2>Who AI trusts for these questions</h2><p class="lede">Most-cited domains across all answers.</p>
${domains.map(([d, n]) => `<div class="row dom ${d === brandDomain ? "self" : ""}"><span class="name">${esc(d)}${d === brandDomain ? " ★" : ""}</span>${bar(n, maxDomain, d === brandDomain ? "self" : "")}<span class="num">${n}</span></div>`).join("")}
</section>
<section><h2>What the AI engines actually searched</h2><p class="lede">${searchTotal} web searches the engines ran while answering. Real demand data, fed back into question discovery.</p>
<div class="searches">${searches.map((s) => `<span>${esc(s.query)}${s.n > 1 ? `<b>×${s.n}</b>` : ""}</span>`).join("") || `<span class="muted">No searches recorded for this date.</span>`}</div>
</section>
</div>

<section><h2>Every question, every answer</h2><p class="lede legend">Each dot is one AI answer: <i class="dot cited"></i>cites ${esc(config.brand.domain)} <i class="dot named"></i>names ${esc(brand)} <i class="dot"></i>neither.</p>
<table><tr><th>Question</th><th>Source</th>${engines.map((e) => `<th>${esc(e)}</th>`).join("")}</tr>
${qRows.map(({ q, byEngine }) => `<tr><td>${esc(q.text)}<div class="tier">${isExplore(q.id) ? "explore" : "core"} · ${esc(q.topic)}</div></td><td>${srcChip(q.source)}</td>${byEngine.map((xs) => `<td>${dots(xs)}</td>`).join("")}</tr>`).join("")}
</table></section>

<section><h2>What the loop wants to change</h2><p class="lede">Each draft is scored by blind judges (fresh sub-agents shown anonymized pages: "which would you cite?"). Only passes ship; guardrails hold the rest.</p>
<div class="cards">${proposals.map((p) => `<div class="card">
<span class="badge ${p.status === "would ship" ? "ship" : p.status === "held" ? "held" : "eval"}">${badgeText(p, config.shipMode === "dry_run")}</span>
<div class="tier">${esc(laneText(p.lane))}</div>
<h3>${p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener">/${esc(p.target)} ↗</a>` : `/${esc(p.target)}`}${/\.pass(\d+)$/.test(p.id) ? ` <span class="muted" style="font-weight:500">· retry</span>` : ""}</h3>
${p.linkLabel ? `<div class="tier">${esc(p.linkLabel)}</div>` : ""}
${p.title || p.excerpt ? `<div class="why">${esc(p.title ?? p.excerpt)}</div>` : ""}
${p.rows.map((r) => `<div class="qid">${esc(qById.get(r.q)?.text ?? r.q)}</div>
<div class="vs"><span class="muted">live page</span>${bar((r.live ?? 0) * 10, 10, "live")}<span class="num">${r.live == null ? "–" : Math.round(r.live * 10) + "/10"}</span></div>
<div class="vs"><span><b>draft</b></span>${bar((r.draft ?? 0) * 10, 10, "draft")}<span class="num"><b>${r.draft == null ? "–" : Math.round(r.draft * 10) + "/10"}</b></span></div>`).join("")}
<div class="why">${esc(p.status === "held" ? `Held: ${p.reason}` : p.verdictReason ?? "")}</div>
<div>${p.techniques.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>
</div>`).join("") || `<p class="muted">No proposals for this date.</p>`}</div></section>

<section><h2>Outreach drafts for a human</h2><p class="lede">Mentions on other sites drive AI visibility, so the loop drafts replies and pitches. It never posts anything itself.</p>
<div class="cards">${drafts.map((d) => {
  const m = draftMeta(d.meta);
  const plat = m.platform ? PLATFORM[m.platform] ?? m.platform : d.kind === "pitch" ? "Article" : "Thread";
  const label = m.title ? m.title.slice(0, 90) : host(d.target_url);
  return `<div class="card draft"><div><span class="badge eval">${esc(d.kind === "pitch" ? "PITCH" : "REPLY")}</span> <span class="chip plat-${esc(m.platform ?? "web")}">${esc(plat)}</span>${m.source ? `<span class="chip">${esc(m.source)}</span>` : ""}</div>
<h3><a href="${esc(d.target_url)}" target="_blank" rel="noopener">${esc(label)} ↗</a></h3><div class="tier">${esc(host(d.target_url))}</div><pre>${esc(d.body.slice(0, 600))}</pre></div>`;
}).join("") || `<p class="muted">No drafts for this date.</p>`}</div></section>

<section><h2>Runs</h2><p class="lede">Every run leaves a record. No silent runs.</p>
<div class="timeline">${runs.map((r) => `<div class="run ${esc(r.status)}"><b>${esc(r.kind)}</b>${esc(r.started_at.slice(11, 16))} UTC · ${esc(r.status)}${r.shipped || r.held ? ` · ${r.shipped} ok, ${r.held} held` : ""}</div>`).join("")}</div></section>

<footer>Generated by geo-loop · github.com/mpauls2839/geo-loop · ${esc((opts.now ?? new Date()).toISOString().slice(0, 16).replace("T", " "))} UTC</footer>
</div></body></html>`;
  return redact(html, opts.env ?? process.env);
}

export function writeDashboard(config: Config, ledger: Ledger, outDir?: string, opts: Parameters<typeof buildDashboard>[2] = {}): string {
  const dir = resolve(outDir ?? resolve(config.dataDir, "report"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "dashboard.html");
  writeFileSync(file, buildDashboard(config, ledger, opts));
  return file;
}
