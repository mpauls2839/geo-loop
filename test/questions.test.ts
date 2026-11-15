import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { applySuggestions, suggestQuestions, titleFromThreadUrl, topicFor } from "../src/commands/questions.ts";
import { gscQueries, serviceAccountJwt } from "../src/lib/searchdata.ts";
import { tempLedger, testConfig } from "./helpers.ts";

function seedLedger() {
  const ledger = tempLedger();
  ledger.db.prepare("INSERT INTO engine_queries (date, question_id, engine, query) VALUES (?, ?, ?, ?)").run("2026-11-15", "q1", "claude", "n8n error trigger workflow setup");
  ledger.db.prepare("INSERT INTO engine_queries (date, question_id, engine, query) VALUES (?, ?, ?, ?)").run("2026-11-15", "q2", "chatgpt", "n8n error trigger workflow setup");
  ledger.db.prepare("INSERT INTO engine_queries (date, question_id, engine, query) VALUES (?, ?, ?, ?)").run("2026-11-15", "q1", "claude", "synta pricing");
  ledger.db.prepare(
    "INSERT INTO probe_answers (run_id, date, question_id, engine, model, sample, answer, cited_urls, cited, mentioned) VALUES ('r','2026-11-15','q1','claude','m',1,'',?,0,0)",
  ).run(JSON.stringify(["https://community.n8n.io/t/silent-failures-in-production-how-do-you-handle-observability/308805", "https://docs.n8n.io/x"]));
  return ledger;
}

describe("question discovery", () => {
  it("merges GSC, engine searches, autocomplete and cited threads; drops branded and duplicate questions", async () => {
    const config = testConfig({ discovery: { seedTerms: ["n8n"], coreSize: 3, exploreSize: 2, sources: ["gsc", "engine", "autocomplete", "thread"] } });
    const { candidates, notes } = await suggestQuestions(config, seedLedger(), {
      gsc: async () => [
        { query: "n8n google sheets append row not working", clicks: 5, impressions: 6772, ctr: 0.001, position: 8 },
        { query: "synta login", clicks: 9, impressions: 500, ctr: 0.02, position: 1 },
        { query: "tiny query", clicks: 0, impressions: 3, ctr: 0, position: 50 },
      ],
      autocomplete: async () => [
        { query: "n8n error trigger workflow setup", seed: "n8n", rank: 2 },
        { query: "n8n webhook not working", seed: "n8n", rank: 1 },
      ],
    });
    const texts = candidates.map((c) => c.text);
    expect(texts).toContain("n8n google sheets append row not working");
    expect(texts.some((t) => t.includes("synta"))).toBe(false);
    expect(texts).not.toContain("tiny query");
    const merged = candidates.find((c) => c.text === "n8n error trigger workflow setup")!;
    expect(merged.sources.sort()).toEqual(["autocomplete", "engine"]);
    expect(candidates.find((c) => c.sources.includes("thread"))?.text).toBe("silent failures in production how do you handle observability");
    expect(notes.join(" ")).toMatch(/gsc: 3 queries/);
  });

  it("skips sources that aren't configured and says why", async () => {
    const config = testConfig({ discovery: { seedTerms: [], coreSize: 3, exploreSize: 2, sources: ["gsc", "autocomplete"] } });
    const { notes } = await suggestQuestions(config, tempLedger(), {});
    expect(notes.join(" ")).toMatch(/gsc: skipped.*autocomplete: skipped/);
  });

  it("data mode fills core once, then only explore changes; hybrid never touches core; user mode is the caller's to protect", () => {
    const config = testConfig({ discovery: { seedTerms: [], coreSize: 2, exploreSize: 1, sources: [] } });
    const cands = ["a b c one", "d e f two", "g h i three", "j k l four"].map((t, i) => ({ id: `d-${i}`, text: t, topic: "general", score: 10 - i, sources: ["gsc" as const], evidence: ["x"] }));
    const first = applySuggestions({ mode: "data", core: [], explore: [] }, cands, config);
    expect(first.core.map((q) => q.id)).toEqual(["d-0", "d-1"]);
    expect(first.explore.map((q) => q.id)).toEqual(["d-2"]);
    const second = applySuggestions(first, cands.slice(2).reverse(), config);
    expect(second.core).toEqual(first.core);
    expect(second.explore.map((q) => q.id)).toEqual(["d-3"]);
    const hybrid = applySuggestions({ mode: "hybrid", core: [{ id: "mine", text: "my q", topic: "general", source: "seed" }], explore: [] }, cands, config);
    expect(hybrid.core.map((q) => q.id)).toEqual(["mine"]);
  });

  it("helpers: thread titles from slugs, topic heuristics", () => {
    expect(titleFromThreadUrl("https://www.reddit.com/r/n8n/comments/abc123/how_do_you_monitor_n8n_in_prod/")).toBe("how do you monitor n8n in prod");
    expect(topicFor("n8n vs kestra")).toBe("comparisons");
    expect(topicFor("n8n webhook not working")).toBe("errors");
    expect(topicFor("how to set up n8n retries")).toBe("how-to");
  });
});

describe("questions.json loading", () => {
  it("merges questions.json into the config and requires at least one question overall", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qf-"));
    writeFileSync(join(dir, "geo-loop.config.json"), JSON.stringify({ brand: { name: "Acme", domain: "acme.dev" }, site: { baseUrl: "https://acme.dev" } }));
    await expect(loadConfig(undefined, dir)).rejects.toThrow(/at least one question/);
    expect((await loadConfig(undefined, dir, { allowNoQuestions: true })).config.questions).toEqual([]);
    writeFileSync(join(dir, "questions.json"), JSON.stringify({ mode: "data", core: [{ id: "c1", text: "core q" }], explore: [{ id: "e1", text: "explore q" }] }));
    const { config, questionsFile } = await loadConfig(undefined, dir);
    expect(config.questions.map((q) => q.id)).toEqual(["c1", "e1"]);
    expect(questionsFile?.mode).toBe("data");
  });
});

describe("Google Search Console client", () => {
  it("signs a valid RS256 service-account JWT and reads query rows", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sa = { client_email: "bot@x.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    const jwt = serviceAccountJwt(sa, "scope-x", 1_000);
    const [h, c, sig] = jwt.split(".");
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toMatchObject({ iss: sa.client_email, scope: "scope-x", exp: 4_600 });

    const calls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok" }));
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
      expect(JSON.parse(String(init?.body))).toMatchObject({ startDate: "2026-10-18", endDate: "2026-11-15", dimensions: ["query"] });
      return new Response(JSON.stringify({ rows: [{ keys: ["n8n vs kestra"], clicks: 4, impressions: 670, ctr: 0.006, position: 9.2 }] }));
    }) as typeof fetch;
    const rows = await gscQueries({ siteUrl: "sc-domain:acme.dev", sa, fetchImpl: f, now: new Date("2026-11-15T12:00:00Z") });
    expect(rows).toEqual([{ query: "n8n vs kestra", clicks: 4, impressions: 670, ctr: 0.006, position: 9.2 }]);
    expect(calls[1]).toContain(encodeURIComponent("sc-domain:acme.dev"));
  });
});

describe("brand-typo filter", () => {
  it("drops navigational brand searches and misspellings, keeps real questions", async () => {
    const { isBrandSearch } = await import("../src/commands/questions.ts");
    const brand = ["synta", "synta.io"];
    for (const q of ["sintax ai", "sinta ai", "synidia", "synta"]) expect(isBrandSearch(q, brand)).toBe(true);
    for (const q of ["kestra vs n8n", "n8n syntax error", "n8n execute command", "n8n alternatives"]) expect(isBrandSearch(q, brand)).toBe(false);
  });
});
