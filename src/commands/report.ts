import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../config.js";
import type { Ledger, RunNote, RunRow } from "../lib/ledger.js";
import { citationMap } from "./map.js";

// Private results page (spec slice 9, verification 12.1-12.3). One self-contained static HTML
// file built from the ledger: no external scripts, styles or fonts. Secrets are redacted (inv. 6).

// ---------- secret redaction (invariant 6) ----------

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|PRIVATE|DSN)/i;
const SECRET_SHAPES: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, // OpenAI
  /\bpplx-[A-Za-z0-9]{20,}/g, // Perplexity
  /\bvck_[A-Za-z0-9]{20,}/g, // Vercel AI Gateway
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk[A-Za-z0-9]{40,}/g, // Sanity tokens
  /\bphx_[A-Za-z0-9]{20,}/g, // PostHog personal keys
  /\bya29\.[A-Za-z0-9._-]{20,}/g, // Google OAuth access tokens
  /\b1\/\/[A-Za-z0-9_-]{20,}/g, // Google refresh tokens
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
];

/** Removes secret env values and well-known token shapes from text. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [k, v] of Object.entries(env)) {
    if (!v || v.length < 8 || !SECRET_ENV.test(k)) continue;
    for (const form of new Set([v, escapeHtml(v), encodeURIComponent(v)])) out = out.split(form).join("[redacted]");
  }
  for (const re of SECRET_SHAPES) out = out.replace(re, "[redacted]");
  return out;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------- data ----------

export type ReportOptions = { date?: string; env?: NodeJS.ProcessEnv; now?: Date };

type TrendRow = { date: string; engine: string; n: number; cited: number; mentioned: number };
type ChangeRow = {
  id: string; date: string; lane: string; target: string; status: string; reason: string;
  eval: string; techniques: string; external_ref: string | null; created_at: string;
};
type EvalRow = { created_at: string; subject: string; question_id: string; k: number; wins: number; win_rate: number };
type DraftRow = { id: string; date: string; kind: string; target_url: string; body: string; meta: string; status: string };
type TechniqueRow = { id: string; name: string; weight: number; uses: number; status: string; evidence_grade: string; updated_at: string };

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function buildReport(config: Config, ledger: Ledger, opts: ReportOptions = {}): string {
  const env = opts.env ?? process.env;
  const db = ledger.db;
  const e = (s: unknown) => escapeHtml(redact(String(s ?? ""), env));

  const runs = db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 30").all() as RunRow[];
  const latest = runs[0];
  const latestByKind = db
    .prepare("SELECT r.* FROM runs r JOIN (SELECT kind, MAX(started_at) m FROM runs GROUP BY kind) x ON r.kind = x.kind AND r.started_at = x.m ORDER BY r.started_at DESC")
    .all() as RunRow[];
  const trend = db
    .prepare(
      `SELECT date, engine, COUNT(*) n, SUM(cited) cited, SUM(mentioned) mentioned
       FROM probe_answers WHERE error IS NULL GROUP BY date, engine ORDER BY date`,
    )
    .all() as TrendRow[];
  const mapDate =
    opts.date ?? (db.prepare("SELECT MAX(date) d FROM probe_answers WHERE error IS NULL").get() as { d: string | null }).d ?? undefined;
  const map = mapDate ? citationMap(config, ledger, mapDate) : [];
  const changes = db.prepare("SELECT * FROM changes ORDER BY created_at DESC LIMIT 200").all() as ChangeRow[];
  const evals = db.prepare("SELECT created_at, subject, question_id, k, wins, win_rate FROM evals ORDER BY created_at DESC LIMIT 100").all() as EvalRow[];
  const drafts = db.prepare("SELECT * FROM drafts ORDER BY date DESC, kind, id LIMIT 60").all() as DraftRow[];
  const steer = ledger.lastRun("steer");
  const techniques = db.prepare("SELECT * FROM techniques ORDER BY weight DESC, name LIMIT 50").all() as TechniqueRow[];
  const generated = (opts.now ?? new Date()).toISOString();

  // ---------- sections ----------

  const statusSection = (() => {
    if (!latest) return `<section class="banner running"><h2>No runs yet</h2><p>Run <code>geo-loop probe</code> or the daily routine to populate this page.</p></section>`;
    const notes = parse<RunNote[]>(latest.notes, []);
    const problems = notes.filter((n) => n.level !== "info");
    const infos = notes.filter((n) => n.level === "info");
    const other = latestByKind.filter((r) => r.id !== latest.id && r.status !== "ok" && r.date === latest.date);
    return `<section class="banner ${e(latest.status)}" id="status">
  <div class="banner-head"><span class="pill ${e(latest.status)}">${e(latest.status.toUpperCase())}</span>
  <h2>Latest run: ${e(latest.kind)} on ${e(latest.date)}</h2></div>
  <p class="counts">shipped ${latest.shipped} · held ${latest.held} · skipped ${latest.skipped} · cost $${latest.cost_usd.toFixed(2)} · ${e(latest.started_at)}${latest.ended_at ? ` → ${e(latest.ended_at)}` : " (still running or crashed)"}</p>
  ${problems.length ? `<ul class="reasons">${problems.map((n) => `<li><b>${e(n.level)}</b>${n.item ? ` <code>${e(n.item)}</code>` : ""}: ${e(n.reason)}</li>`).join("")}</ul>` : ""}
  ${infos.length ? `<details><summary>${infos.length} info note(s)</summary><ul>${infos.map((n) => `<li>${n.item ? `<code>${e(n.item)}</code> ` : ""}${e(n.reason)}</li>`).join("")}</ul></details>` : ""}
  ${other.length ? `<p class="also">Also today: ${other.map((r) => `<span class="pill ${e(r.status)}">${e(r.kind)} ${e(r.status)}</span>`).join(" ")}</p>` : ""}
</section>`;
  })();

  const engines = [...new Set(trend.map((t) => t.engine))].sort();
  const dates = [...new Set(trend.map((t) => t.date))].sort();
  const trendSection = trend.length
    ? `<section><h2>Citation share and mention rate per engine</h2>
<p class="muted">Citation share: share of samples citing a ${e(config.brand.domain)} URL. Mention rate: share naming ${e(config.brand.name)}. ${dates.length} probe day(s).</p>
<div class="legend">${engines.map((en, i) => `<span><i style="background:var(--s${(i % 5) + 1})"></i>${e(en)}</span>`).join("")}</div>
<div class="charts">
<figure>${chart(dates, engines, trend, "cited", e)}<figcaption>Citation share</figcaption></figure>
<figure>${chart(dates, engines, trend, "mentioned", e)}<figcaption>Mention rate</figcaption></figure>
</div>
${table(
  ["Date", "Engine", "Samples", "Citation share", "Mention rate"],
  [...trend].reverse().slice(0, 60).map((t) => [e(t.date), e(t.engine), String(t.n), pct(t.cited / t.n), pct(t.mentioned / t.n)]),
)}</section>`
    : `<section><h2>Citation share and mention rate per engine</h2><p class="muted">No probe data yet.</p></section>`;

  const mapSection = `<section><h2>Citation map${mapDate ? ` (${e(mapDate)})` : ""}</h2>
${map.length ? table(
  ["Domain", "Questions", "Citations", "Engines", "Top URLs"],
  map.slice(0, 40).map((r) => [
    `${e(r.domain)}${r.self ? ` <span class="pill ok">self</span>` : ""}`,
    String(r.questions),
    String(r.citations),
    e(r.engines.join(", ")),
    r.topUrls.map((u) => `<a href="${e(u.url)}" rel="noreferrer">${e(shortUrl(u.url))}</a> (${u.count})`).join("<br>"),
  ]),
) : `<p class="muted">No probe data for this date.</p>`}</section>`;

  const changeSection = `<section><h2>Change log</h2>
${changes.length ? table(
  ["Change id", "Date", "Lane", "Target", "Status", "Reason", "Eval", "Revert"],
  changes.map((c) => {
    const ev = parse<Record<string, unknown>>(c.eval, {});
    return [
      `<code>${e(c.id)}</code>`,
      e(c.date),
      e(c.lane),
      e(c.target),
      `<span class="pill ${statusClass(c.status)}">${e(c.status)}</span>`,
      e(c.reason),
      Object.keys(ev).length ? `<code class="small">${e(JSON.stringify(ev))}</code>` : "",
      c.status === "reverted" ? `<span class="muted">reverted</span>` : `<code class="copyable">geo-loop revert ${e(c.id)}</code>`,
    ];
  }),
) : `<p class="muted">No changes recorded yet.</p>`}</section>`;

  const evalSection = `<section><h2>Eval scores</h2>
${evals.length ? table(
  ["When", "Subject", "Question", "Win rate", "Wins / k"],
  evals.map((v) => [e(v.created_at.slice(0, 16).replace("T", " ")), e(v.subject), e(v.question_id), pct(v.win_rate), `${v.wins} / ${v.k}`]),
) : `<p class="muted">No evals yet.</p>`}</section>`;

  const draftSection = `<section><h2>Off-site drafts</h2>
<p class="muted">Never posted by the loop. Review, edit and post by hand.</p>
${drafts.length ? drafts.map((d, i) => {
    const m = parse<Record<string, unknown>>(d.meta, {});
    const facts = [
      m.platform ? String(m.platform) : "",
      m.author ? `author: ${m.author}` : "",
      m.ageUnknown ? "age unknown" : m.ageDays !== undefined ? `${m.ageDays} days old` : "",
      Array.isArray(m.competitors) && m.competitors.length ? `covers ${m.competitors.join(", ")}` : "",
      m.heldReason ? `held: ${m.heldReason}` : "",
    ].filter(Boolean);
    return `<article class="draft">
  <header><span class="pill ${d.status === "held" ? "partial" : "ok"}">${e(d.kind)}${d.status === "held" ? " · held" : ""}</span>
  <a href="${e(d.target_url)}" rel="noreferrer">${e(m.title ? String(m.title) : shortUrl(d.target_url))}</a>
  <span class="muted">${e(d.date)}${facts.length ? ` · ${e(facts.join(" · "))}` : ""}</span>
  <button type="button" data-copy="d${i}">Copy</button></header>
  <pre id="d${i}">${e(d.body)}</pre>
</article>`;
  }).join("\n") : `<p class="muted">No drafts yet.</p>`}</section>`;

  const steerSection = (() => {
    const head = `<section><h2>Weekly steer</h2>`;
    if (!steer && !techniques.length) return `${head}<p class="muted">Not run yet.</p></section>`;
    const notes = steer ? parse<RunNote[]>(steer.notes, []) : [];
    return `${head}
${steer ? `<p><span class="pill ${e(steer.status)}">${e(steer.status)}</span> ${e(steer.date)}</p>
${notes.length ? `<ul>${notes.map((n) => `<li>${n.level !== "info" ? `<b>${e(n.level)}</b> ` : ""}${n.item ? `<code>${e(n.item)}</code> ` : ""}${e(n.reason)}</li>`).join("")}</ul>` : ""}` : `<p class="muted">Steer not run yet.</p>`}
${techniques.length ? `<h3>Techniques</h3>${table(
  ["Technique", "Weight", "Uses", "Evidence", "Status"],
  techniques.map((t) => [e(t.name), t.weight.toFixed(2), String(t.uses), e(t.evidence_grade), e(t.status)]),
)}` : ""}</section>`;
  })();

  const recentRuns = runs.length
    ? `<section><h2>Recent runs</h2>${table(
        ["Started", "Kind", "Status", "Shipped", "Held", "Skipped"],
        runs.map((r) => [e(r.started_at.slice(0, 16).replace("T", " ")), e(r.kind), `<span class="pill ${e(r.status)}">${e(r.status)}</span>`, String(r.shipped), String(r.held), String(r.skipped)]),
      )}</section>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>geo-loop report</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header class="top"><h1>geo-loop · ${e(config.brand.name)}</h1><p class="muted">Generated ${e(generated)}. Private: do not publish.</p></header>
${statusSection}
${trendSection}
${mapSection}
${changeSection}
${evalSection}
${draftSection}
${steerSection}
${recentRuns}
</main>
<script>
document.addEventListener("click", function (ev) {
  var b = ev.target.closest && ev.target.closest("[data-copy]");
  if (!b) return;
  var t = document.getElementById(b.getAttribute("data-copy")).innerText;
  navigator.clipboard.writeText(t).then(function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1200); });
});
</script>
</body>
</html>
`;
  return redact(html, env);
}

/** Writes <outDir>/index.html (default <dataDir>/report) and returns its path. */
export function writeReport(config: Config, ledger: Ledger, outDir?: string, opts: ReportOptions = {}): string {
  const dir = resolve(outDir ?? join(config.dataDir, "report"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "index.html");
  writeFileSync(file, buildReport(config, ledger, opts));
  return file;
}

// ---------- helpers ----------

function statusClass(s: string) {
  if (/fail|error|reverted/.test(s)) return "failed";
  if (/held|draft|pending|queued|open/.test(s)) return "partial";
  return "ok";
}

function shortUrl(u: string) {
  return u.replace(/^https?:\/\//, "").slice(0, 70);
}

function table(head: string[], rows: string[][]) {
  return `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function chart(dates: string[], engines: string[], rows: TrendRow[], field: "cited" | "mentioned", e: (s: unknown) => string) {
  const W = 640, H = 220, L = 40, R = 12, T = 12, B = 28;
  const x = (i: number) => (dates.length === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (dates.length - 1));
  const y = (v: number) => T + (1 - v) * (H - T - B);
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${v * 100}%</text>`)
    .join("");
  const ticks = [0, Math.floor((dates.length - 1) / 2), dates.length - 1]
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((i) => `<text x="${x(i)}" y="${H - 8}" class="axis" text-anchor="middle">${e(dates[i].slice(5))}</text>`)
    .join("");
  const series = engines
    .map((en, k) => {
      const pts = dates
        .map((d, i) => {
          const r = rows.find((t) => t.date === d && t.engine === en);
          return r ? { i, v: r[field] / r.n, d } : null;
        })
        .filter((p): p is { i: number; v: number; d: string } => !!p);
      const color = `var(--s${(k % 5) + 1})`;
      const line = pts.length > 1 ? `<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}"/>` : "";
      const dots = pts.map((p) => `<circle cx="${x(p.i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.5" fill="${color}"><title>${e(en)} ${e(p.d)}: ${pct(p.v)}</title></circle>`).join("");
      return line + dots;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${field === "cited" ? "Citation share" : "Mention rate"} per engine over time">${grid}${ticks}${series}</svg>`;
}

const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--fg:#1c1c1a;--muted:#6b6b66;--line:#e2e2dc;--ok:#1f7a3d;--ok-bg:#e6f4ea;--warn:#8a5a00;--warn-bg:#fff4d6;--bad:#a8201a;--bad-bg:#fde8e6;
--s1:#2f6fdb;--s2:#d9480f;--s3:#2b8a3e;--s4:#9c36b5;--s5:#868e96;--code:#f0f0ec}
@media (prefers-color-scheme: dark){:root{--bg:#131312;--card:#1d1d1b;--fg:#ecece8;--muted:#a1a19a;--line:#33332f;--ok:#7bd99a;--ok-bg:#163020;--warn:#ffcf66;--warn-bg:#352a0e;--bad:#ff8a80;--bad-bg:#3a1714;
--s1:#74a4ff;--s2:#ff9056;--s3:#69db7c;--s4:#da77f2;--s5:#adb5bd;--code:#2a2a27}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1040px;margin:0 auto;padding:16px}
h1{font-size:1.4rem;margin:0}h2{font-size:1.1rem;margin:0 0 8px}h3{font-size:1rem}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:14px 0}
.muted{color:var(--muted)}a{color:var(--s1)}
code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:.88em;word-break:break-all}
code.small{font-size:.78em}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;white-space:nowrap}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.78rem;font-weight:600;background:var(--code)}
.pill.ok{color:var(--ok);background:var(--ok-bg)}.pill.partial,.pill.running{color:var(--warn);background:var(--warn-bg)}.pill.failed{color:var(--bad);background:var(--bad-bg)}
.banner{border-width:2px}
.banner.ok{border-color:var(--ok)}
.banner.partial,.banner.running{border-color:var(--warn);background:var(--warn-bg)}
.banner.failed{border-color:var(--bad);background:var(--bad-bg)}
.banner-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.banner-head h2{margin:0}
.banner .pill{font-size:.95rem;padding:3px 12px}
.reasons li{margin:3px 0}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin:6px 0}.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
figure{margin:0}figcaption{color:var(--muted);font-size:.85rem;text-align:center}
svg{width:100%;height:auto;display:block}
svg .grid{stroke:var(--line);stroke-width:1}svg .axis{fill:var(--muted);font-size:11px}
.draft{border-top:1px solid var(--line);padding:10px 0}
.draft header{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.draft button{margin-left:auto;font:inherit;font-size:.82rem;padding:3px 10px;border-radius:6px;border:1px solid var(--line);background:var(--code);color:var(--fg);cursor:pointer}
pre{white-space:pre-wrap;word-wrap:break-word;background:var(--code);padding:10px 12px;border-radius:8px;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:all;-webkit-user-select:all;margin:8px 0 0}
`;
