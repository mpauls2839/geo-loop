import { describe, expect, it } from "vitest";
import { probe, shippingAllowed } from "../src/commands/probe.ts";
import { citationMap } from "../src/commands/map.ts";
import { ans, fakeEngine, tempLedger, testConfig } from "./helpers.ts";

const noSleep = async () => {};

describe("probe", () => {
  it("2.1 stores questions x engines x samples rows", async () => {
    const config = testConfig();
    const ledger = tempLedger();
    const run = ledger.startRun("probe", "2026-11-15");
    const engines = ["claude", "chatgpt", "perplexity"].map((id) => fakeEngine(id as never, () => ans("answer", ["https://n8n.io/x"])));
    const s = await probe(config, ledger, run, { engines, sleep: noSleep });
    const n = (ledger.db.prepare("SELECT COUNT(*) n FROM probe_answers").get() as { n: number }).n;
    expect(n).toBe(2 * 3 * 3);
    expect(s.enginesOk).toBe(3);
  });

  it("2.2/2.3/2.4 cited vs mentioned vs lookalike domains", async () => {
    const config = testConfig({ questions: [{ id: "q1", text: "q", topic: "t" }], engines: [{ id: "claude" }] });
    const ledger = tempLedger();
    const run = ledger.startRun("probe", "2026-11-15");
    const answers = [
      ans("Try it", ["https://www.synta.io/blog/x/?utm_source=chatgpt"]),
      ans("Synta is good", ["https://n8n.io"]),
      ans("other", ["https://syntax.dev/a"]),
    ];
    await probe(config, ledger, run, { engines: [fakeEngine("claude", (_q, i) => answers[i])], sleep: noSleep });
    const rows = ledger.db.prepare("SELECT sample, cited, mentioned, cited_urls FROM probe_answers ORDER BY sample").all() as {
      cited: number; mentioned: number; cited_urls: string;
    }[];
    expect(rows[0].cited).toBe(1);
    expect(JSON.parse(rows[0].cited_urls)).toEqual(["https://synta.io/blog/x"]);
    expect([rows[1].cited, rows[1].mentioned]).toEqual([0, 1]);
    expect(rows[2].cited).toBe(0);
  });

  it("2.5 one failing engine: skipped, run partial, share over the rest, shipping allowed", async () => {
    const config = testConfig();
    const ledger = tempLedger();
    const run = ledger.startRun("probe", "2026-11-15");
    const engines = [
      fakeEngine("claude", () => ans("x", ["https://synta.io"])),
      fakeEngine("chatgpt", () => ans("x", ["https://n8n.io"])),
      fakeEngine("perplexity", () => new Error("503")),
    ];
    const s = await probe(config, ledger, run, { engines, sleep: noSleep });
    expect(s.enginesOk).toBe(2);
    expect(s.citationShare).toBeCloseTo(0.5);
    expect(shippingAllowed(s)).toBe(true);
    expect(run.finish()).toBe("partial");
  });

  it("2.6 two failing engines disables shipping", async () => {
    const config = testConfig();
    const ledger = tempLedger();
    const run = ledger.startRun("probe", "2026-11-15");
    const engines = [
      fakeEngine("claude", () => ans("x", [])),
      fakeEngine("chatgpt", () => new Error("timeout")),
      fakeEngine("perplexity", () => new Error("503")),
    ];
    const s = await probe(config, ledger, run, { engines, sleep: noSleep });
    expect(shippingAllowed(s)).toBe(false);
  });

  it("2.7 all engines fail", async () => {
    const config = testConfig();
    const ledger = tempLedger();
    const run = ledger.startRun("probe", "2026-11-15");
    const engines = ["claude", "chatgpt", "perplexity"].map((id) => fakeEngine(id as never, () => new Error("down")));
    const s = await probe(config, ledger, run, { engines, sleep: noSleep });
    expect(s.enginesOk).toBe(0);
  });

  it("2.8 second probe the same day reuses data unless forced", async () => {
    const config = testConfig({ engines: [{ id: "claude" }] });
    const ledger = tempLedger();
    let calls = 0;
    const engine = fakeEngine("claude", () => (calls++, ans("x", [])));
    await probe(config, ledger, ledger.startRun("probe", "2026-11-15"), { engines: [engine], sleep: noSleep });
    const before = calls;
    const s = await probe(config, ledger, ledger.startRun("probe", "2026-11-15"), { engines: [engine], sleep: noSleep });
    expect(calls).toBe(before);
    expect(s.reused).toBe(true);
    const n = (ledger.db.prepare("SELECT COUNT(*) n FROM probe_answers").get() as { n: number }).n;
    expect(n).toBe(2 * 3);
  });

  it("2.9 stops at the budget and marks the run partial", async () => {
    const config = testConfig({ engines: [{ id: "claude" }], probe: { samples: 3, budgetUsd: 0.025, maxRetries: 0 } });
    const ledger = tempLedger();
    const run = ledger.startRun("probe", "2026-11-15");
    const s = await probe(config, ledger, run, { engines: [fakeEngine("claude", () => ans("x", []))], sleep: noSleep });
    expect(s.budgetHit).toBe(true);
    expect(run.finish()).toBe("partial");
  });
});

describe("map", () => {
  it("3.1/3.2/3.4 groups by registered domain, marks self", async () => {
    const config = testConfig({ engines: [{ id: "claude" }] });
    const ledger = tempLedger();
    const run = ledger.startRun("probe", "2026-11-15");
    const engine = fakeEngine("claude", () => ans("x", ["https://community.n8n.io/t/1", "https://n8n.io/docs", "https://synta.io/blog/a"]));
    await probe(config, ledger, run, { engines: [engine], sleep: noSleep });
    const rows = citationMap(config, ledger, "2026-11-15");
    expect(rows[0].domain).toBe("n8n.io");
    expect(rows[0].citations).toBe(12);
    expect(rows.at(-1)).toMatchObject({ domain: "synta.io", self: true });
    expect(citationMap(config, ledger, "2026-11-15", { topic: "reliability" })[0].questions).toBe(1);
  });
});

describe("rate limits", () => {
  it("waits out 429s without using up retries", async () => {
    const config = testConfig({ questions: [{ id: "q1", text: "q", topic: "t" }], engines: [{ id: "perplexity" }], probe: { samples: 1, budgetUsd: 5, maxRetries: 0 } });
    const ledger = tempLedger();
    const waits: number[] = [];
    let n = 0;
    const engine = fakeEngine("perplexity", () => (n++ < 2 ? new Error("Rate limit exceeded ... Retry after 7s.") : ans("ok", [])));
    const s = await probe(config, ledger, ledger.startRun("probe", "2026-11-15"), { engines: [engine], sleep: async (ms) => void waits.push(ms) });
    expect(s.enginesOk).toBe(1);
    expect(waits).toEqual([7000, 7000]);
  });
});

describe("engine search queries", () => {
  it("stores the searches engines issued, deduped and lowercased", async () => {
    const config = testConfig({ questions: [{ id: "q1", text: "q", topic: "t" }], engines: [{ id: "claude" }], probe: { samples: 2, budgetUsd: 5, maxRetries: 0 } });
    const ledger = tempLedger();
    const engine = fakeEngine("claude", () => ({ ...ans("x", []), searchQueries: ["n8n Error Trigger", "n8n retry on fail"] }));
    await probe(config, ledger, ledger.startRun("probe", "2026-11-15"), { engines: [engine], sleep: noSleep });
    const rows = ledger.db.prepare("SELECT query FROM engine_queries ORDER BY query").all() as { query: string }[];
    expect(rows.map((r) => r.query)).toEqual(["n8n error trigger", "n8n retry on fail"]);
  });
});
