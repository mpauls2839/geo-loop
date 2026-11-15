import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkKeys, mask, parseEnv, protectEnv, renderEnv, writeEnvFile } from "../src/commands/onboard.ts";

describe("onboard env handling", () => {
  it("keeps comments and unknown lines, replaces values, appends new keys", () => {
    const orig = "# my env\nFOO=1\nAI_GATEWAY_API_KEY=\n";
    const v = parseEnv(orig);
    v.set("AI_GATEWAY_API_KEY", "gw_secret_123456");
    v.set("GITHUB_TOKEN", "ghp with space");
    const out = renderEnv(orig, v);
    expect(out).toContain("# my env\nFOO=1\nAI_GATEWAY_API_KEY=gw_secret_123456");
    expect(out).toContain('GITHUB_TOKEN="ghp with space"');
    expect(parseEnv(out).get("GITHUB_TOKEN")).toBe("ghp with space");
  });

  it("writes .env with mode 600 and gitignores it", () => {
    const dir = mkdtempSync(join(tmpdir(), "onboard-"));
    writeEnvFile(join(dir, ".env"), "A=1\n");
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    expect(protectEnv(dir).gitignoreUpdated).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".env");
    expect(protectEnv(dir).gitignoreUpdated).toBe(false);
  });

  it("masks secrets", () => {
    expect(mask("abcdefghijkl1234")).toBe("set, ends ...1234");
    expect(mask("")).toBe("not set");
  });

  it("validates the gateway key against /v1/credits and never sends it elsewhere", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      const auth = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ balance: "12.00" }), { status: auth === "Bearer good" ? 200 : 401 });
    }) as typeof fetch;
    const ok = await checkKeys(new Map([["AI_GATEWAY_API_KEY", "good"]]), { fetchImpl: fakeFetch });
    expect(ok[0]).toMatchObject({ status: "ok", detail: "valid, balance $12.00" });
    const bad = await checkKeys(new Map([["AI_GATEWAY_API_KEY", "bad"]]), { fetchImpl: fakeFetch });
    expect(bad[0].status).toBe("invalid");
    expect(new Set(calls)).toEqual(new Set(["https://ai-gateway.vercel.sh/v1/credits"]));
  });

  it("flags missing engine keys", async () => {
    const r = await checkKeys(new Map(), { fetchImpl: (async () => new Response("{}")) as typeof fetch });
    expect(r[0]).toMatchObject({ name: "engines", status: "missing" });
  });

  it("checks GitHub push access on the configured repo", async () => {
    const f = (async () => new Response(JSON.stringify({ permissions: { push: false } }), { status: 200 })) as typeof fetch;
    const r = await checkKeys(new Map([["GITHUB_TOKEN", "t"], ["AI_GATEWAY_API_KEY", ""]]), { githubRepo: "o/r", fetchImpl: f });
    expect(r.find((c) => c.name === "GITHUB_TOKEN")?.status).toBe("invalid");
  });
});

describe("Sanity Studio URL", () => {
  it("is checked as an https URL, and the config loader picks it up from the environment", async () => {
    const ok = await checkKeys(new Map([["SANITY_STUDIO_URL", "https://www.sanity.io/@o/studio/x/default/structure"], ["AI_GATEWAY_API_KEY", ""]]), { fetchImpl: (async () => new Response("{}")) as typeof fetch });
    expect(ok.find((c) => c.name === "SANITY_STUDIO_URL")?.status).toBe("ok");
    const bad = await checkKeys(new Map([["SANITY_STUDIO_URL", "studio"]]), { fetchImpl: (async () => new Response("{}")) as typeof fetch });
    expect(bad.find((c) => c.name === "SANITY_STUDIO_URL")?.status).toBe("invalid");

    const { loadConfig } = await import("../src/config.ts");
    const dir = mkdtempSync(join(tmpdir(), "studio-"));
    writeFileSync(join(dir, "geo-loop.config.json"), JSON.stringify({ brand: { name: "A", domain: "a.dev" }, site: { baseUrl: "https://a.dev" }, questions: [{ id: "q", text: "x y z" }], sanity: { projectId: "p" } }));
    process.env.SANITY_STUDIO_URL = "https://a.sanity.studio";
    try {
      expect((await loadConfig(undefined, dir)).config.sanity?.studioUrl).toBe("https://a.sanity.studio");
    } finally {
      delete process.env.SANITY_STUDIO_URL;
    }
  });
});
