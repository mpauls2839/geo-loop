import { describe, expect, it } from "vitest";
import { evalPage } from "../src/commands/eval.ts";
import { seededRng, type JudgeFn } from "../src/lib/judge.ts";
import {
  JOB_INSTRUCTIONS, judgeFromConfig, recordingJudge, recordingLoader, replayJudge, replayLoader, resolveJudgeProvider, unansweredCalls, type JudgeJob,
} from "../src/lib/judges.ts";
import { PageFetchError, type PageText } from "../src/lib/page.ts";
import { tempLedger, testConfig } from "./helpers.ts";

const DATE = "2026-11-15";
const LIVE = "https://synta.io/blog/x";
const page = (url: string, m: string): PageText => ({ url, title: `T ${m}`, headings: [m], text: `${m} body` });
const PAGES: Record<string, PageText> = {
  [LIVE]: page(LIVE, "live"),
  "https://a.dev/1": page("https://a.dev/1", "a"),
  "https://b.dev/2": page("https://b.dev/2", "b"),
};
const loader = async (u: string) => {
  if (!PAGES[u]) throw new PageFetchError(u, "HTTP 404");
  return PAGES[u];
};

function setup() {
  const config = testConfig({ judge: { provider: "external", model: "x", k: 4 } });
  const ledger = tempLedger();
  const ins = ledger.db.prepare(
    "INSERT INTO probe_answers (run_id, date, question_id, engine, model, sample, answer, cited_urls, cited, mentioned) VALUES ('r', ?, ?, 'claude', 'm', ?, '', ?, 0, 0)",
  );
  ins.run(DATE, "q1", 1, JSON.stringify(["https://a.dev/1", "https://b.dev/2", "https://gone.dev/x"]));
  ins.run(DATE, "q2", 1, JSON.stringify(["https://b.dev/2"]));
  return { config, ledger, questions: config.questions };
}

// A judge that prefers the draft, then the live page.
const prefer: JudgeFn = async (_q, pages) =>
  (pages.find((p) => p.headings.includes("draft")) ?? pages.find((p) => p.headings.includes("live")) ?? pages[0]).label;
const draft = { id: "d1", body: "## draft\n\nbetter answer" };

describe("external judge: prepare -> answers -> replay", () => {
  it("replay with the same answers equals a direct run", async () => {
    const { config, ledger, questions } = setup();
    const direct = await evalPage({ config, ledger, date: DATE, url: LIVE, questions, draft, deps: { judge: prefer, loadPage: loader, rng: seededRng(7) } });

    const job: JudgeJob = { version: 1, seed: 7, page: LIVE, draft, questionIds: questions.map((q) => q.id), date: DATE, pages: {}, calls: [], instructions: JOB_INSTRUCTIONS };
    await evalPage({ config, ledger, date: DATE, url: LIVE, questions, draft, deps: { judge: recordingJudge(job.calls), loadPage: recordingLoader(loader, job.pages), rng: seededRng(7) } });
    expect(job.calls.length).toBeGreaterThan(0);
    expect(job.calls.every((c) => !c.prompt.includes("a.dev") && !c.prompt.includes("synta.io"))).toBe(true); // anonymized
    expect(unansweredCalls(job).length).toBe(job.calls.length);
    expect(job.pages["https://gone.dev/x"]).toEqual({ error: expect.stringContaining("404") });

    // The "host agent" answers each call.
    for (const call of job.calls) {
      const m = /<page label="([A-Z])">\n<title>[^<]*<\/title>\n<headings>draft/.exec(call.prompt) ?? /<page label="([A-Z])">\n<title>[^<]*<\/title>\n<headings>live/.exec(call.prompt);
      call.answer = m ? m[1] : "A";
    }
    expect(unansweredCalls(job)).toEqual([]);

    const replayed = await evalPage({
      config, ledger, date: DATE, url: LIVE, questions, draft,
      deps: { judge: replayJudge(JSON.parse(JSON.stringify(job))), loadPage: replayLoader(job.pages), rng: seededRng(job.seed) },
    });
    expect(replayed.decision).toEqual(direct.decision);
    expect(replayed.rows.map((r) => [r.live?.wins, r.draft?.wins])).toEqual(direct.rows.map((r) => [r.live?.wins, r.draft?.wins]));
  });

  it("a changed page set fails loudly instead of scoring wrong", async () => {
    const { config, ledger, questions } = setup();
    const job: JudgeJob = { version: 1, seed: 1, page: LIVE, draft, questionIds: ["q1"], date: DATE, pages: {}, calls: [], instructions: "" };
    await evalPage({ config, ledger, date: DATE, url: LIVE, questions: [questions[0]], draft, deps: { judge: recordingJudge(job.calls), loadPage: recordingLoader(loader, job.pages), rng: seededRng(1) } });
    job.pages["https://a.dev/1"] = page("https://a.dev/1", "edited");
    for (const c of job.calls) c.answer = "A";
    const r = await evalPage({ config, ledger, date: DATE, url: LIVE, questions: [questions[0]], draft, deps: { judge: replayJudge(job), loadPage: replayLoader(job.pages), rng: seededRng(1) } });
    expect(r.rows[0].draft?.calls.every((c) => c.error?.includes("page set changed"))).toBe(true);
    expect(r.decision.verdict).toBe("fail");
  });
});

describe("judge providers", () => {
  it("auto picks Anthropic, then OpenAI-compatible, then gateway", () => {
    const c = testConfig();
    expect(resolveJudgeProvider(c, { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" })).toBe("anthropic");
    expect(resolveJudgeProvider(c, { OPENAI_API_KEY: "o", AI_GATEWAY_API_KEY: "g" })).toBe("openai");
    expect(resolveJudgeProvider(c, { AI_GATEWAY_API_KEY: "g" })).toBe("gateway");
    expect(() => resolveJudgeProvider(c, {})).toThrow(/external/);
  });
  it("external provider refuses direct calls with the two-pass instructions", () => {
    expect(() => judgeFromConfig(testConfig({ judge: { provider: "external", model: "x", k: 1 } }), {})).toThrow(/--prepare/);
  });
});
