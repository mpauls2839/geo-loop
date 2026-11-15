// Block-level diff for blog posts: split Markdown into paragraphs/headings/list items and align them
// with a longest-common-subsequence so the before/after page and the change-type summary are honest.

export type Block = { kind: "same" | "added" | "removed"; text: string };
export type PostVersion = { title?: string; excerpt?: string; md: string };

export function blocks(md: string): string[] {
  return md
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function diffBlocks(before: string[], after: string[]): Block[] {
  const a = before.map(norm);
  const b = after.map(norm);
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Block[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) (out.push({ kind: "same", text: after[j] }), i++, j++);
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: "removed", text: before[i++] });
    else out.push({ kind: "added", text: after[j++] });
  }
  while (i < n) out.push({ kind: "removed", text: before[i++] });
  while (j < m) out.push({ kind: "added", text: after[j++] });
  return out;
}

const headings = (bs: string[]) => bs.filter((b) => /^#{1,4}\s/.test(b)).map((b) => b.replace(/^#{1,4}\s+/, "").trim());

export type ChangeSummary = {
  type: "Major rewrite" | "New sections added" | "Sections removed" | "Wording edits" | "Title & meta description" | "No visible change";
  details: string[];
  changedPct: number;
  addedHeadings: string[];
  removedHeadings: string[];
  titleChanged: boolean;
  excerptChanged: boolean;
  diff: Block[];
};

/** Classify a refresh by what actually changed between the live post and the draft. */
export function summarizeChange(before: PostVersion, after: PostVersion): ChangeSummary {
  const b = blocks(before.md);
  const a = blocks(after.md);
  const diff = diffBlocks(b, a);
  const same = diff.filter((d) => d.kind === "same").length;
  const changedPct = Math.round((1 - same / Math.max(1, Math.max(a.length, b.length))) * 100);
  const hb = new Set(headings(b).map(norm));
  const ha = new Set(headings(a).map(norm));
  const addedHeadings = headings(a).filter((h) => !hb.has(norm(h)));
  const removedHeadings = headings(b).filter((h) => !ha.has(norm(h)));
  const titleChanged = !!after.title && norm(after.title) !== norm(before.title ?? "");
  const excerptChanged = !!after.excerpt && norm(after.excerpt) !== norm(before.excerpt ?? "");
  const bodyChanged = diff.some((d) => d.kind !== "same");

  let type: ChangeSummary["type"];
  if (!bodyChanged) type = titleChanged || excerptChanged ? "Title & meta description" : "No visible change";
  else if (changedPct >= 60) type = "Major rewrite";
  else if (addedHeadings.length) type = "New sections added";
  else if (removedHeadings.length) type = "Sections removed";
  else type = "Wording edits";

  const details: string[] = [];
  if (titleChanged) details.push("new title");
  if (excerptChanged) details.push("new meta description");
  if (bodyChanged) details.push(`${changedPct}% of paragraphs changed`);
  if (addedHeadings.length) details.push(`+${addedHeadings.length} section${addedHeadings.length > 1 ? "s" : ""}: ${addedHeadings.slice(0, 3).join(", ")}${addedHeadings.length > 3 ? "…" : ""}`);
  if (removedHeadings.length) details.push(`−${removedHeadings.length} section${removedHeadings.length > 1 ? "s" : ""}`);
  return { type, details, changedPct, addedHeadings, removedHeadings, titleChanged, excerptChanged, diff };
}
