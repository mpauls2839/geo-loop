import { describe, expect, it } from "vitest";
import { mdToPt, ptToMd } from "../src/lib/portable.ts";

describe("portable text <-> markdown", () => {
  it("round-trips headings, lists, marks, links and keeps images", () => {
    const original = [{ _type: "image", _key: "img1", alt: "diagram", asset: { _ref: "image-abc" } }];
    const md = "## Fix it\n\nUse **bold**, *em*, `code` and [docs](https://docs.n8n.io).\n\n- one\n- two\n  - nested\n\n![diagram](pt:img1)\n\n> quote\n";
    const pt = mdToPt(md, original);
    expect(pt[0]).toMatchObject({ style: "h2" });
    const p = pt[1] as { children: { text: string; marks: string[] }[]; markDefs: { href: string }[] };
    expect(p.children.find((s) => s.text === "bold")?.marks).toEqual(["strong"]);
    expect(p.markDefs[0].href).toBe("https://docs.n8n.io");
    expect(pt.filter((b) => b.listItem === "bullet").map((b) => b.level)).toEqual([1, 1, 2]);
    expect(pt.find((b) => b._type === "image")).toMatchObject({ _key: "img1", asset: { _ref: "image-abc" } });
    expect(ptToMd(pt)).toContain("[docs](https://docs.n8n.io)");
    expect(ptToMd(pt)).toContain("![diagram](pt:img1)");
    expect(mdToPt(ptToMd(pt), original).length).toBe(pt.length);
  });

  it("drops unknown image placeholders instead of inventing assets", () => {
    expect(mdToPt("![x](pt:nope)\n\ntext").length).toBe(1);
  });
});
