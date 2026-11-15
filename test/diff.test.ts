import { describe, expect, it } from "vitest";
import { diffBlocks, summarizeChange } from "../src/lib/diff.ts";

describe("change summary", () => {
  const before = { title: "n8n vs Kestra", excerpt: "Compare them.", md: "## Quick answer\n\nKestra is code-first.\n\n## Pricing\n\nBoth have free tiers.\n\n## FAQ\n\nIs Kestra better?" };
  it("aligns paragraphs and finds added and removed blocks", () => {
    const d = diffBlocks(["a", "b", "c"], ["a", "x", "c", "d"]);
    expect(d.map((x) => `${x.kind}:${x.text}`)).toEqual(["same:a", "removed:b", "added:x", "same:c", "added:d"]);
  });
  it("new sections added", () => {
    const s = summarizeChange(before, { md: before.md + "\n\n## At a glance\n\n| a | b |" });
    expect(s.type).toBe("New sections added");
    expect(s.details.join(" ")).toMatch(/\+1 section: At a glance/);
  });
  it("wording edits", () => {
    const s = summarizeChange(before, { md: before.md.replace("Both have free tiers.", "Both offer a free tier.") });
    expect(s.type).toBe("Wording edits");
  });
  it("title and meta only", () => {
    const s = summarizeChange(before, { title: "n8n vs Kestra (2026)", excerpt: "Which one fits your team?", md: before.md });
    expect(s.type).toBe("Title & meta description");
    expect(s.details).toEqual(["new title", "new meta description"]);
  });
  it("major rewrite", () => {
    const s = summarizeChange(before, { md: "## One\n\nall new\n\n## Two\n\nall new too\n\n## Three\n\nand more" });
    expect(s.type).toBe("Major rewrite");
  });
});
