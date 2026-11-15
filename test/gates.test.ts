import { describe, expect, it } from "vitest";
import {
  allowlisted, bannedPhrases, cooldown, ctaPresent, dailyCap, duplicateTopic, extractNumbers, headingsKept,
  noSecrets, notShippedToday, ptHeadings, ptLinks, ptToText, redact, slugImmutable, unsourcedNumbers,
} from "../src/lib/gates.ts";
import { testConfig } from "./helpers.ts";

const caps = testConfig().caps;

describe("banned phrases (invariant 4, 5.4)", () => {
  it("fails case-insensitively and across whitespace", () => {
    const r = bannedPhrases("Synta is the  mcp\nLayer for n8n", ["MCP layer", "AI builds your workflow from plain English"]);
    expect(r.pass).toBe(false);
    expect(r.reasons).toEqual(['banned phrase "MCP layer"']);
  });
  it("passes clean text", () => {
    expect(bannedPhrases("n8n builds it. Synta keeps it running.", ["MCP layer"]).pass).toBe(true);
  });
});

describe("unsourced numbers (invariant 5, 5.5)", () => {
  it("5.5 fails an unsourced percentage", () => {
    const r = unsourcedNumbers("Synta cuts failures by 63%.", { sources: [], facts: "" });
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toMatch(/"63%"/);
  });
  it("passes when the number is in a source or the facts file (comma-insensitive)", () => {
    expect(unsourcedNumbers("cuts failures by 63%", { sources: ["a study found 63% fewer failures"] }).pass).toBe(true);
    expect(unsourcedNumbers("over 1,200 users", { facts: "Users: 1200" }).pass).toBe(true);
    expect(unsourcedNumbers("plans from $29/month", { facts: "Pro plan $29" }).pass).toBe(true);
  });
  it("money and multipliers are claims even when small", () => {
    expect(unsourcedNumbers("only $5 a month", {}).pass).toBe(false);
    expect(unsourcedNumbers("5x faster", {}).pass).toBe(false);
    expect(unsourcedNumbers("2.5 seconds", {}).pass).toBe(false);
  });
  it("allows step numbers, years, small how-to counts and identifiers", () => {
    const text = "Step 12: open n8n. In 2025, add 3 nodes and retry 2 times. GPT-4 and OAuth2 and v1.82.0 are fine.";
    expect(unsourcedNumbers(text, {}).pass).toBe(true);
  });
  it("grandfathers numbers already on the live page", () => {
    expect(unsourcedNumbers("6772 impressions", { oldText: "had 6,772 impressions" }).pass).toBe(true);
  });
  it("ignores URLs and inline code", () => {
    expect(unsourcedNumbers("see https://x.io/a/12345 and `timeout: 30000`", {}).pass).toBe(true);
  });
  it("catches 30-50% ranges", () => {
    expect(extractNumbers("a 30-50% drop").map((t) => t.value)).toEqual(["30", "50"]);
  });
});

describe("refresh shape", () => {
  it("6.3 slug is immutable", () => {
    expect(slugImmutable("a", "b", "a").pass).toBe(false);
    expect(slugImmutable("a", undefined, "a").pass).toBe(true);
    expect(slugImmutable("a", "a", "a").pass).toBe(true);
  });
  it("5.3 keeps ≥70% of headings (punctuation/case-insensitive)", () => {
    const old = ["Why it fails", "Fix 1", "Fix 2", "FAQ"];
    expect(headingsKept(old, ["why it fails?", "Fix 1", "Fix 2", "New"], 0.7).pass).toBe(true);
    const r = headingsKept(old, ["Why it fails", "Fix 1", "New"], 0.7);
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toMatch(/2\/4/);
    expect(headingsKept([], ["x"], 0.7).pass).toBe(true);
  });
});

describe("Portable Text helpers + CTA", () => {
  const body = [
    { _type: "block", style: "h2", children: [{ _type: "span", text: "Intro" }] },
    {
      _type: "block",
      style: "normal",
      markDefs: [{ _key: "l1", _type: "link", href: "https://app.synta.io/signup" }],
      children: [{ _type: "span", text: "Try " }, { _type: "span", text: "Synta", marks: ["l1"] }, { _type: "span", text: " code 42", marks: ["code"] }],
    },
  ];
  it("extracts text, headings and links", () => {
    expect(ptToText(body)).toBe("Intro\nTry Synta code 42");
    expect(ptToText(body, { skipCode: true })).toBe("Intro\nTry Synta");
    expect(ptHeadings(body)).toEqual(["Intro"]);
    expect(ptLinks(body)).toEqual(["https://app.synta.io/signup"]);
  });
  it("CTA: brand-domain link passes, other domains fail, prefixes override", () => {
    expect(ctaPresent(["https://app.synta.io/signup"], { brandDomain: "synta.io" }).pass).toBe(true);
    expect(ctaPresent(["https://n8n.io"], { brandDomain: "synta.io" }).pass).toBe(false);
    expect(ctaPresent(["https://synta.io/blog/x"], { brandDomain: "synta.io", hrefPrefixes: ["https://app.synta.io"] }).pass).toBe(false);
  });
});

describe("5.2 cooldown", () => {
  it("blocks a page changed within cooldownDays", () => {
    expect(cooldown([{ id: "c1", date: "2026-11-05" }], "2026-11-15", 14).pass).toBe(false);
    expect(cooldown([{ id: "c1", date: "2026-10-31" }], "2026-11-15", 14).pass).toBe(true);
  });
});

describe("5.6 duplicate topic", () => {
  const existing = [
    { id: "n8n-google-sheets-append-row-not-working", text: "n8n Google Sheets append row not working. Fix the append row node when Google Sheets returns no data in n8n." },
    { id: "n8n-vs-kestra", mainQuery: "n8n vs kestra", text: "Comparing n8n and Kestra for workflow orchestration." },
  ];
  it("same main query is a duplicate", () => {
    const r = duplicateTopic({ mainQuery: "N8N vs Kestra", text: "something else entirely" }, existing, 0.85);
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toMatch(/n8n-vs-kestra.*refresh it instead/);
  });
  it("near-identical text is a duplicate", () => {
    const r = duplicateTopic({ text: existing[0].text }, existing, 0.85);
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toMatch(/similarity/);
  });
  it("a distinct topic passes", () => {
    expect(duplicateTopic({ mainQuery: "n8n webhook timeout", text: "Webhook timeouts in self-hosted queue mode and how to raise them." }, existing, 0.85).pass).toBe(true);
  });
});

describe("caps, idempotency, allowlist, secrets", () => {
  it("6.4 daily cap per lane", () => {
    expect(dailyCap("refresh", 1, caps).pass).toBe(true);
    expect(dailyCap("refresh", 2, caps).pass).toBe(false);
    expect(dailyCap("new_post", 1, caps).pass).toBe(false);
  });
  it("invariant 2: already shipped today", () => {
    expect(notShippedToday(["c1"]).pass).toBe(false);
    expect(notShippedToday([]).pass).toBe(true);
  });
  it("6.10 allowlist with globs, rejects traversal", () => {
    const allow = ["app/llms.txt", "app/sitemap.ts", "components/seo/**"];
    expect(allowlisted(["app/llms.txt", "components/seo/json-ld/Article.tsx"], allow).pass).toBe(true);
    expect(allowlisted(["app/page.tsx"], allow).reasons).toEqual(['gate_failed: file outside allowlist "app/page.tsx"']);
    expect(allowlisted(["components/seo/../../package.json"], allow).pass).toBe(false);
    expect(allowlisted(["app/llms.txt"], []).pass).toBe(false);
  });
  it("invariant 6: redact and detect secrets", () => {
    expect(redact("token=sk-abcdef123456 here", ["sk-abcdef123456"])).toBe("token=[redacted] here");
    expect(noSecrets("x sk-abcdef123456", ["sk-abcdef123456"]).pass).toBe(false);
  });
});
