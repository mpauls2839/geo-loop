import { randomBytes } from "node:crypto";

// Markdown <-> Portable Text, enough for blog posts: h2-h4, quotes, bullet/number lists,
// bold/italic/inline code, links, fenced code, and inline images carried through as
// `![alt](pt:<key>)` placeholders so a Markdown rewrite never drops existing images.

type Span = { _type: "span"; _key: string; text: string; marks: string[] };
type MarkDef = { _type: "link"; _key: string; href: string };
export type PtBlock = {
  _type: string;
  _key: string;
  style?: string;
  listItem?: "bullet" | "number";
  level?: number;
  children?: Span[];
  markDefs?: MarkDef[];
  [k: string]: unknown;
};

const key = () => randomBytes(6).toString("hex");

export function ptToMd(body: unknown): string {
  if (!Array.isArray(body)) return "";
  const out: string[] = [];
  let prevList = false;
  for (const b of body as PtBlock[]) {
    if (b._type !== "block") {
      if (prevList) out.push("");
      prevList = false;
      const alt = typeof b.alt === "string" ? b.alt : "";
      out.push(`![${alt}](pt:${b._key})`, "");
      continue;
    }
    const text = spansToMd(b.children ?? [], b.markDefs ?? []);
    if (b.listItem) {
      const indent = "  ".repeat(Math.max(0, (b.level ?? 1) - 1));
      out.push(`${indent}${b.listItem === "number" ? "1." : "-"} ${text}`);
      prevList = true;
      continue;
    }
    if (prevList) out.push("");
    prevList = false;
    const style = b.style ?? "normal";
    const prefix = { h1: "# ", h2: "## ", h3: "### ", h4: "#### ", blockquote: "> " }[style] ?? "";
    out.push(prefix + text, "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function spansToMd(children: Span[], defs: MarkDef[]): string {
  return children
    .map((s) => {
      let t = s.text ?? "";
      if (!t) return "";
      const marks = s.marks ?? [];
      if (marks.includes("code")) t = "`" + t + "`";
      if (marks.includes("em")) t = `*${t}*`;
      if (marks.includes("strong")) t = `**${t}**`;
      const link = defs.find((d) => marks.includes(d._key));
      if (link) t = `[${t}](${link.href})`;
      return t;
    })
    .join("");
}

export function mdToPt(md: string, original?: unknown): PtBlock[] {
  const originals = new Map<string, PtBlock>();
  if (Array.isArray(original)) for (const b of original as PtBlock[]) if (b._type !== "block" && b._key) originals.set(b._key, b);

  const blocks: PtBlock[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(textBlock(para.join(" "), "normal"));
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i].trim()); i++) code.push(lines[i]);
      blocks.push({ _type: "block", _key: key(), style: "normal", markDefs: [], children: [{ _type: "span", _key: key(), text: code.join("\n"), marks: ["code"] }] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const img = /^!\[([^\]]*)\]\(pt:([^)]+)\)\s*$/.exec(line.trim());
    if (img) {
      flush();
      const orig = originals.get(img[2]);
      if (orig) blocks.push({ ...orig, alt: img[1] || orig.alt });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push(textBlock(h[2], h[1].length === 1 ? "h2" : `h${h[1].length}`));
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      flush();
      blocks.push(textBlock(q[1], "blockquote"));
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const level = Math.floor(li[1].replace(/\t/g, "  ").length / 2) + 1;
      blocks.push({ ...textBlock(li[3], "normal"), listItem: /\d/.test(li[2]) ? "number" : "bullet", level });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

function textBlock(text: string, style: string): PtBlock {
  const markDefs: MarkDef[] = [];
  const children = parseInline(text, [], markDefs);
  return { _type: "block", _key: key(), style, markDefs, children: children.length ? children : [{ _type: "span", _key: key(), text: "", marks: [] }] };
}

const INLINE = /(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(__([^_]+)__)|(`([^`]+)`)|(\*([^*]+)\*)|(_([^_]+)_)/;

function parseInline(text: string, marks: string[], defs: MarkDef[]): Span[] {
  const out: Span[] = [];
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push({ _type: "span", _key: key(), text: rest, marks: [...marks] });
      break;
    }
    if (m.index > 0) out.push({ _type: "span", _key: key(), text: rest.slice(0, m.index), marks: [...marks] });
    if (m[1]) {
      const def: MarkDef = { _type: "link", _key: key(), href: m[3] };
      defs.push(def);
      out.push(...parseInline(m[2], [...marks, def._key], defs));
    } else if (m[4] || m[6]) out.push(...parseInline(m[5] ?? m[7], [...marks, "strong"], defs));
    else if (m[8]) out.push({ _type: "span", _key: key(), text: m[9], marks: [...marks, "code"] });
    else out.push(...parseInline(m[11] ?? m[13], [...marks, "em"], defs));
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/** Accepts Portable Text as-is, or converts a Markdown string (keeping the original's images). */
export function toPt(body: unknown, original?: unknown): PtBlock[] {
  return typeof body === "string" ? mdToPt(body, original) : (body as PtBlock[]);
}
