import { describe, expect, it } from "vitest";
import {
  baselineUrls,
  decideNewPost,
  decideRefresh,
  evalPage,
  resolvePageUrl,
  targetQuestions,
} from "../src/commands/eval.ts";
import { parseLetter, positionBiasCheck, runJudge, seededRng, type JudgeFn, type LabeledPage } from "../src/lib/judge.ts";
import { extractReadable, fetchPage, PageFetchError, pageFromText, type PageLoader, type PageText } from "../src/lib/page.ts";
import type { Ledger } from "../src/lib/ledger.ts";
import { tempLedger, testConfig } from "./helpers.ts";

const DATE = "2026-11-15";
const LIVE = "https://synta.io/blog/n8n-vs-kestra";
const page = (url: string, marker: string): PageText => ({ url, title: `Title ${marker}`, headings: [marker], text: `${marker} body text` });

function seedProbe(ledger: Ledger, qid: string, urls: string[][]) {
  const ins = ledger.db.prepare(
    `INSERT INTO probe_answers (run_id, date, question_id, engine, model, sample, answer, cited_urls, cited, mentioned) VALUES ('r', ?, ?, ?, 'm', ?, '', ?, 0, 0)`,
  );
  urls.forEach((u, i) => ins.run(DATE, qid, ["claude", "chatgpt", "perplexity"][i % 3], i + 1, JSON.stringify(u)));
}

/** Fake fetcher: known pages by url; anything in `fail` throws like a 403/timeout. */
function loader(pages: Record<string, string>, fail: Record<string, string> = {}): PageLoader & { calls: string[] } {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    if (fail[url]) throw new PageFetchError(url, fail[url]);
    if (!pages[url]) throw new PageFetchError(url, "HTTP 404");
    return page(url, pages[url]);
  };
  return Object.assign(f, { calls });
}

/** Fake judge that picks the page whose headings contain `marker`, recording each prompt. */
function pickMarker(marker: string | ((q: string) => string)): JudgeFn & { seen: LabeledPage[][] } {
  const seen: LabeledPage[][] = [];
  const f: JudgeFn = async (q, pages) => {
    seen.push(pages);
    const m = typeof marker === "string" ? marker : marker(q);
    return pages.find((p) => p.headings.includes(m))?.label ?? "A";
  };
  return Object.assign(f, { seen });
}

describe("page extraction", () => {
  it("strips scripts/nav and keeps title, headings, body", () => {
    const html = `<html><head><title>N8n &amp; Kestra</title><script>var x=1</script></head><body>
      <nav><a>Home</a><a>Pricing</a></nav><main><h1>Compare</h1><p>${"Kestra is a workflow engine. ".repeat(10)}</p>
      <h2>Pricing</h2><p>Free &mdash; tier</p><script>track()</script></main><footer>(c) 2026</footer></body></html>`;
    const p = extractReadable(html, "https://x.dev/a");
    expect(p.title).toBe("N8n & Kestra");
    expect(p.headings).toEqual(["Compare", "Pricing"]);
    expect(p.text).toContain("Kestra is a workflow engine");
    expect(p.text).not.toMatch(/track\(\)|var x|Home|\(c\) 2026/);
  });

  it("caps length", () => {
    const p = pageFromText(`# Big\n${"word ".repeat(10_000)}`, "u", 500);
    expect(p.title).toBe("Big");
    expect(p.text.length).toBeLessThan(520);
  });

  it("4.9 fetchPage turns 403 and timeouts into PageFetchError", async () => {
    const f403 = (async () => new Response("no", { status: 403 })) as typeof fetch;
    await expect(fetchPage("https://a.dev", { fetchImpl: f403 })).rejects.toMatchObject({ reason: "HTTP 403" });
    const fTimeout = (async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    }) as typeof fetch;
    await expect(fetchPage("https://a.dev", { fetchImpl: fTimeout })).rejects.toMatchObject({ reason: "timeout" });
    const ok = (async () =>
      new Response(`<html><title>T</title><body><p>${"real content here ".repeat(10)}</p></body></html>`, {
        headers: { "content-type": "text/html" },
      })) as typeof fetch;
    expect((await fetchPage("https://a.dev", { fetchImpl: ok })).title).toBe("T");
  });
});

describe("judge", () => {
  it("parses letters robustly; unparseable is null", () => {
    expect(parseLetter("B", 3)).toBe("B");
    expect(parseLetter(" (c). ", 3)).toBe("C");
    expect(parseLetter("**A**", 3)).toBe("A");
    expect(parseLetter("Answer: B", 3)).toBe("B");
    expect(parseLetter("I would cite page C because it is direct.", 3)).toBe("C");
    expect(parseLetter("D", 3)).toBeNull();
    expect(parseLetter("I can't decide between A and B", 3)).toBeNull();
    expect(parseLetter("", 3)).toBeNull();
  });

  it("4.1 shuffles and anonymizes each call; win rate over k", async () => {
    const candidates = ["ours", "x", "y", "z"].map((id) => ({ id, page: page(`https://${id}.dev`, id) }));
    const judge = pickMarker("ours");
    const r = await runJudge({ question: "q", candidates, subjectId: "ours", k: 10, judge, rng: seededRng(1) });
    expect(r).toMatchObject({ k: 10, wins: 10, winRate: 1, unparseable: 0 });
    expect(new Set(r.calls.map((c) => c.order.join(","))).size).toBeGreaterThan(1);
    for (const pages of judge.seen) {
      expect(pages.map((p) => p.label)).toEqual(["A", "B", "C", "D"]);
      expect(JSON.stringify(pages)).not.toContain("https://");
    }
  });

  it("unparseable answers and judge errors count as non-wins and are recorded", async () => {
    const candidates = ["ours", "x"].map((id) => ({ id, page: page(id, id) }));
    let n = 0;
    const judge: JudgeFn = async (_q, pages) => {
      n++;
      if (n === 1) return "no idea";
      if (n === 2) throw new Error("529 overloaded");
      return pages.find((p) => p.headings.includes("ours"))!.label;
    };
    const r = await runJudge({ question: "q", candidates, subjectId: "ours", k: 4, judge, rng: seededRng(2) });
    expect(r.wins).toBe(2);
    expect(r.unparseable).toBe(2);
    expect(r.calls[0]).toMatchObject({ raw: "no idea", letter: null, picked: null });
    expect(r.calls[1].error).toBe("529 overloaded");
  });

  it("4.2 position-bias check: a label-blind judge splits evenly, a position-biased one is flagged", async () => {
    const others = [{ id: "x", page: page("x", "x") }];
    const p = page(LIVE, "ours");
    // Content-driven judge: picks the first copy of our page it sees, so picks depend on shuffle only.
    const fair = await positionBiasCheck({ question: "q", page: p, others, k: 40, judge: pickMarker("ours"), rng: seededRng(7) });
    expect(fair.rateA + fair.rateB).toBe(1);
    expect(fair.ok).toBe(true);
    expect(fair.gapPts).toBeLessThanOrEqual(20);
    // A judge that always answers "A", with shuffling stuck (rng always 0), keeps picking one copy: flagged.
    const alwaysA: JudgeFn = async () => "A";
    const b = await positionBiasCheck({ question: "q", page: p, others, k: 20, judge: alwaysA, rng: () => 0 });
    expect(b.gapPts).toBeGreaterThan(20);
    expect(b.ok).toBe(false);
  });
});

describe("baseline", () => {
  it("uses today's cited urls, excluding our own domain, most-cited first", () => {
    const config = testConfig();
    const ledger = tempLedger();
    seedProbe(ledger, "q2", [["https://a.dev/1", "https://synta.io/blog/x"], ["https://b.dev/2", "https://a.dev/1"], []]);
    expect(baselineUrls(config, ledger, DATE, config.questions[1])).toEqual({ source: "probe", urls: ["https://a.dev/1", "https://b.dev/2"] });
  });

  it("4.8 falls back to config competitors for the topic, else none", () => {
    const config = testConfig({ competitors: { comparisons: ["https://kestra.io/vs-n8n"] } });
    const ledger = tempLedger();
    seedProbe(ledger, "q2", [["https://synta.io/x"]]);
    expect(baselineUrls(config, ledger, DATE, config.questions[1])).toEqual({ source: "competitors", urls: ["https://kestra.io/vs-n8n"] });
    expect(baselineUrls(config, ledger, DATE, config.questions[0])).toEqual({ source: "none", urls: [] });
  });
});

describe("evalPage", () => {
  const pages = { [LIVE]: "live", "https://a.dev/1": "a", "https://b.dev/2": "b", "https://c.dev/3": "c" };

  it("4.1 our live page vs 3 cited pages: win rate over k=10, stored in evals", async () => {
    const config = testConfig();
    const ledger = tempLedger();
    seedProbe(ledger, "q2", [["https://a.dev/1"], ["https://b.dev/2"], ["https://c.dev/3"]]);
    let i = 0;
    const judge: JudgeFn = async (_q, ps) => {
      const want = i++ % 10 < 3 ? "live" : "a";
      return ps.find((p) => p.headings.includes(want))!.label;
    };
    const res = await evalPage({
      config, ledger, date: DATE, url: LIVE, questions: [config.questions[1]],
      deps: { judge, loadPage: loader(pages), rng: seededRng(4) },
    });
    const row = res.rows[0].live!;
    expect(row).toMatchObject({ status: "ok", k: 10, wins: 3, winRate: 0.3, baselineSource: "probe" });
    expect(row.candidates).toHaveLength(3);
    expect(res.mode).toBe("score");
    const db = ledger.db.prepare("SELECT * FROM evals").all() as { subject: string; k: number; wins: number; win_rate: number; candidates: string; detail: string }[];
    expect(db).toHaveLength(1);
    expect(db[0]).toMatchObject({ subject: `live:${LIVE}`, k: 10, wins: 3, win_rate: 0.3 });
    expect(JSON.parse(db[0].candidates)).toHaveLength(3);
    const detail = JSON.parse(db[0].detail);
    expect(detail.calls).toHaveLength(10);
    expect(detail.calls[0].order).toContain("ours");
    expect(detail.calls[0].letter).toMatch(/^[A-D]$/);
  });

  it("4.3 draft vs live: per-question draft rate, live rate, delta; baseline fetched once", async () => {
    const config = testConfig();
    const ledger = tempLedger();
    seedProbe(ledger, "q1", [["https://a.dev/1"]]);
    seedProbe(ledger, "q2", [["https://b.dev/2"]]);
    const load = loader(pages);
    // Judge always prefers the draft over everything, and the live page over competitors on q1 only.
    const judge: JudgeFn = async (q, ps) => {
      const want = ps.find((p) => p.title === "Better draft") ?? (q.includes("reliable") ? ps.find((p) => p.headings.includes("live")) : undefined);
      return (want ?? ps.find((p) => !p.headings.includes("live"))!).label;
    };
    const res = await evalPage({
      config, ledger, date: DATE, url: LIVE, questions: config.questions,
      draft: { id: "d1", body: "# Better draft\nfresh content" },
      deps: { judge, loadPage: load, rng: seededRng(5) },
    });
    expect(res.mode).toBe("refresh");
    expect(res.rows.map((r) => [r.questionId, r.live?.winRate, r.draft?.winRate, r.deltaPts])).toEqual([
      ["q1", 1, 1, 0],
      ["q2", 0, 1, 100],
    ]);
    expect(res.decision).toMatchObject({ kind: "refresh", verdict: "pass", avgDeltaPts: 50 });
    expect(load.calls.filter((u) => u === "https://a.dev/1")).toHaveLength(1);
    expect((ledger.db.prepare("SELECT COUNT(*) n FROM evals").get() as { n: number }).n).toBe(4);
  });

  it("4.8 no cited pages and no competitors: no baseline, draft held", async () => {
    const config = testConfig();
    const ledger = tempLedger();
    const res = await evalPage({
      config, ledger, date: DATE, url: "https://synta.io/blog/new-post", questions: [config.questions[0]],
      draft: { id: "d2", body: "# New\nbody" },
      deps: { judge: pickMarker("x"), loadPage: loader(pages) },
    });
    expect(res.mode).toBe("new_post");
    expect(res.rows[0].draft).toMatchObject({ status: "no_baseline", winRate: null, baselineSource: "none" });
    expect(res.decision).toMatchObject({ verdict: "fail", reason: "no baseline for q1" });
    const stored = ledger.db.prepare("SELECT detail FROM evals").get() as { detail: string };
    expect(JSON.parse(stored.detail).status).toBe("no_baseline");
  });

  it("4.8 falls back to competitors when engines cited nothing", async () => {
    const config = testConfig({ competitors: { reliability: ["https://c.dev/3"] } });
    const ledger = tempLedger();
    const res = await evalPage({
      config, ledger, date: DATE, url: LIVE, questions: [config.questions[0]],
      deps: { judge: pickMarker("live"), loadPage: loader(pages), rng: seededRng(6) },
    });
    expect(res.rows[0].live).toMatchObject({ status: "ok", baselineSource: "competitors", candidates: ["https://c.dev/3"], winRate: 1 });
  });

  it("4.9 unfetchable candidates are dropped and logged; < 2 candidates = no baseline", async () => {
    const config = testConfig();
    const ledger = tempLedger();
    seedProbe(ledger, "q1", [["https://a.dev/1", "https://blocked.dev/x"]]);
    seedProbe(ledger, "q2", [["https://slow.dev/y"]]);
    const load = loader(pages, { "https://blocked.dev/x": "HTTP 403", "https://slow.dev/y": "timeout" });
    const res = await evalPage({
      config, ledger, date: DATE, url: LIVE, questions: config.questions,
      deps: { judge: pickMarker("live"), loadPage: load, rng: seededRng(8) },
    });
    const [q1, q2] = res.rows.map((r) => r.live!);
    expect(q1).toMatchObject({ status: "ok", candidates: ["https://a.dev/1"], dropped: [{ url: "https://blocked.dev/x", reason: "HTTP 403" }] });
    expect(q2).toMatchObject({ status: "no_baseline", dropped: [{ url: "https://slow.dev/y", reason: "timeout" }] });
    expect(res.decision.verdict).toBe("fail");
  });
});

describe("decisions", () => {
  const config = testConfig();

  it("4.4 refresh: avg delta >= +20 pts and no regression passes", () => {
    expect(decideRefresh({ q1: 0.6, q2: 0.5 }, { q1: 0.3, q2: 0.4 }, config)).toMatchObject({ verdict: "pass", avgDeltaPts: 20 });
    expect(decideRefresh({ q1: 0.5 }, { q1: 0.3 }, config).verdict).toBe("pass");
  });

  it("4.4 refresh below the delta threshold fails", () => {
    expect(decideRefresh({ q1: 0.4, q2: 0.5 }, { q1: 0.3, q2: 0.4 }, config)).toMatchObject({ verdict: "fail", avgDeltaPts: 10 });
  });

  it("4.5 refresh +25 on one question, -5 on another fails naming the regression", () => {
    const d = decideRefresh({ q1: 0.75, q2: 0.35 }, { q1: 0.5, q2: 0.4 }, config);
    expect(d).toMatchObject({ verdict: "fail", reason: "regressed on q2" });
  });

  it("refresh with a missing baseline is held", () => {
    expect(decideRefresh({ q1: null }, { q1: 0.2 }, config)).toMatchObject({ verdict: "fail", reason: "no baseline for q1" });
  });

  it("4.6 new post at >= 40% passes", () => {
    expect(decideNewPost({ q1: 0.4 }, config).verdict).toBe("pass");
    expect(decideNewPost({ q1: 0.5, q2: 0.4 }, config).verdict).toBe("pass");
  });

  it("4.7 new post at 35% fails", () => {
    expect(decideNewPost({ q1: 0.35 }, config)).toMatchObject({ verdict: "fail", reason: "win rate 35% < 40%" });
  });

  it("thresholds come from config", () => {
    const strict = testConfig({ gates: { refreshDeltaPts: 30, newPostMinWinRate: 0.6 } });
    expect(decideRefresh({ q1: 0.6 }, { q1: 0.35 }, strict).verdict).toBe("fail");
    expect(decideNewPost({ q1: 0.5 }, strict).verdict).toBe("fail");
  });
});

describe("cli helpers", () => {
  it("resolves slugs and picks target questions", () => {
    const config = testConfig();
    const ledger = tempLedger();
    expect(resolvePageUrl(config, "n8n-vs-kestra")).toBe(LIVE);
    expect(resolvePageUrl(config, "https://www.synta.io/blog/n8n-vs-kestra/")).toBe(LIVE);
    expect(targetQuestions(config, ledger, DATE, LIVE).map((q) => q.id)).toEqual(["q1", "q2"]);
    seedProbe(ledger, "q2", [[LIVE]]);
    expect(targetQuestions(config, ledger, DATE, LIVE).map((q) => q.id)).toEqual(["q2"]);
    expect(targetQuestions(config, ledger, DATE, LIVE, ["q1"]).map((q) => q.id)).toEqual(["q1"]);
    expect(() => targetQuestions(config, ledger, DATE, LIVE, ["nope"])).toThrow(/unknown/);
  });
});
