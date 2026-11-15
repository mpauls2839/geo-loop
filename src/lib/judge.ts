import type { Config } from "../config.js";
import { claude, textOf, type ClaudeHandle } from "./claude.js";
import type { PageText } from "./page.js";

// The mock-eval judge (spec §4): a question plus N anonymized, shuffled candidate pages;
// the judge names the single page it would cite. Repeated k times, win rate = our wins / k.

export type Candidate = { id: string; page: PageText };
export type LabeledPage = { label: string; title: string; headings: string[]; text: string };
/** One judge call. Returns the raw model text; parsing happens here, not in the judge. */
export type JudgeFn = (question: string, pages: LabeledPage[]) => Promise<string>;
export type Rng = () => number;

export type JudgeCall = {
  order: string[]; // candidate ids in label order: order[0] was "A"
  raw: string;
  letter: string | null; // null = unparseable (counts as a non-win)
  picked: string | null; // candidate id
  error?: string;
};

export type JudgeResult = {
  k: number;
  wins: number;
  winRate: number;
  picks: Record<string, number>; // candidate id -> times picked
  unparseable: number;
  calls: JudgeCall[];
};

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const JUDGE_SYSTEM =
  "You are an AI search assistant deciding which source to cite when answering a user's question. " +
  "You will see the question and several candidate web pages, each labeled with a letter. " +
  "Pick the single page you would cite in your answer: the one that answers the question most directly, " +
  "accurately and usefully. Reply with only the letter of that page, nothing else.";

export function judgePrompt(question: string, pages: LabeledPage[]): string {
  const blocks = pages.map(
    (p) =>
      `<page label="${p.label}">\n<title>${p.title}</title>\n` +
      (p.headings.length ? `<headings>${p.headings.join(" | ")}</headings>\n` : "") +
      `<content>\n${p.text}\n</content>\n</page>`,
  );
  return `<question>${question}</question>\n\n${blocks.join("\n\n")}\n\nWhich page (${pages.map((p) => p.label).join(", ")}) would you cite? Answer with the letter only.`;
}

/** Live judge: config.judge.model through claude() (direct key or AI Gateway). */
export function claudeJudge(config: Config, handle: ClaudeHandle = claude()): JudgeFn {
  return async (question, pages) => {
    const res = await handle.client.messages.create({
      model: handle.model(config.judge.model),
      max_tokens: 16,
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: judgePrompt(question, pages) }],
    });
    return textOf(res);
  };
}

/** The candidate letter in a judge reply, or null. Accepts "B", "(B)", "B.", "Answer: B", "Page B", "**B**". */
export function parseLetter(raw: string, n: number): string | null {
  const valid = LABELS.slice(0, n);
  const s = raw.replace(/[*_`"']/g, "").trim();
  const bare = s.match(/^\(?\[?([A-Z])\]?\)?[.:)]?$/i);
  if (bare && valid.includes(bare[1].toUpperCase())) return bare[1].toUpperCase();
  const tagged = s.match(/\b(?:answer|page|source|label|option|cite|choice)\s*(?:is)?\s*[:\-]?\s*\(?([A-Z])\b/i);
  if (tagged && valid.includes(tagged[1].toUpperCase())) return tagged[1].toUpperCase();
  // Last resort: exactly one distinct standalone capital that is a valid label.
  const singles = new Set([...s.matchAll(/(?:^|[^A-Za-z])([A-Z])(?![A-Za-z])/g)].map((m) => m[1]).filter((l) => valid.includes(l)));
  return singles.size === 1 ? [...singles][0] : null;
}

export function shuffle<T>(xs: T[], rng: Rng): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Deterministic RNG for tests and reproducible runs. */
export function seededRng(seed: number): Rng {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export type JudgeInput = {
  question: string;
  candidates: Candidate[];
  subjectId: string; // the candidate whose wins we count
  k: number;
  judge: JudgeFn;
  rng?: Rng;
};

/** Run k shuffled, anonymized judge calls. A failed or unparseable call counts as a non-win and is recorded. */
export async function runJudge({ question, candidates, subjectId, k, judge, rng = Math.random }: JudgeInput): Promise<JudgeResult> {
  if (candidates.length > LABELS.length) throw new Error(`too many candidates (${candidates.length})`);
  if (!candidates.some((c) => c.id === subjectId)) throw new Error(`subject ${subjectId} is not a candidate`);
  const calls: JudgeCall[] = [];
  const picks: Record<string, number> = Object.fromEntries(candidates.map((c) => [c.id, 0]));
  for (let i = 0; i < k; i++) {
    const order = shuffle(candidates, rng);
    const pages = order.map((c, j) => ({ label: LABELS[j], title: c.page.title, headings: c.page.headings, text: c.page.text }));
    let raw = "";
    let error: string | undefined;
    try {
      raw = await judge(question, pages);
    } catch (err) {
      error = (err as Error).message;
    }
    const letter = error ? null : parseLetter(raw, order.length);
    const picked = letter ? order[LABELS.indexOf(letter)].id : null;
    if (picked) picks[picked]++;
    calls.push({ order: order.map((c) => c.id), raw, letter, picked, ...(error ? { error } : {}) });
  }
  const wins = picks[subjectId];
  return { k, wins, winRate: k ? wins / k : 0, picks, unparseable: calls.filter((c) => !c.letter).length, calls };
}

export type BiasCheck = { rateA: number; rateB: number; gapPts: number; tolerancePts: number; ok: boolean; result: JudgeResult };

/**
 * Position/label bias check (4.2): the same page enters twice under two ids, alongside the others.
 * A fair judge splits its picks of that page roughly evenly; the gap is reported in points.
 */
export async function positionBiasCheck(input: {
  question: string;
  page: PageText;
  others: Candidate[];
  k: number;
  judge: JudgeFn;
  rng?: Rng;
  tolerancePts?: number;
}): Promise<BiasCheck> {
  const tolerancePts = input.tolerancePts ?? 20;
  const candidates = [{ id: "copy-a", page: input.page }, { id: "copy-b", page: input.page }, ...input.others];
  const result = await runJudge({ question: input.question, candidates, subjectId: "copy-a", k: input.k, judge: input.judge, rng: input.rng });
  const rateA = result.picks["copy-a"] / input.k;
  const rateB = result.picks["copy-b"] / input.k;
  const gapPts = Math.abs(rateA - rateB) * 100;
  return { rateA, rateB, gapPts, tolerancePts, ok: gapPts <= tolerancePts, result };
}
