---
name: geo-loop
description: Runs a geo-loop SEO/GEO improvement run for a site - probe AI engines, map who they cite, pick and draft gated content changes, mock-eval them, ship what passes, draft off-site replies, steer, and publish the private report. Use when asked to "run geo-loop", "run the SEO/GEO loop", or when the scheduled (weekly) routine fires.
---

# geo-loop run (weekly by default)

The CLI does the deterministic work and enforces every safety rule. You do the judgment: which pages to change, what to write, and whether a draft is honest and on-positioning. **Never bypass the CLI to write to the CMS, GitHub or any website.** If a command holds or refuses something, record why and move on; do not retry with a weaker change to sneak it through.

Run everything from the data repo (the folder with `geo-loop.config.ts`). `geo-loop` below means `npx geo-loop` or the local `./geo-loop` link.

## 0. Preflight

In a cloud session the tool repo is checked out next to the data repo. Install once per session:
```bash
(cd <path-to-geo-loop-checkout> && npm ci --no-audit --no-fund)
alias geo-loop="node <path-to-geo-loop-checkout>/bin/geo-loop.mjs"   # or use the full path each time
geo-loop onboard --from-env   # cloud only: copies secrets from the environment into .env (never commit it)
geo-loop config check
```
If config check fails, stop and report the error. Read `geo-loop.config.ts` for the brand, positioning line, banned phrases and caps, and read the product facts file it names. These are the only claims you may make about the product.

## 1. Measure

If `questions.json` has `mode` `data` or `hybrid`, refresh the data-driven questions first, so this run probes them:
```bash
geo-loop questions suggest --write   # data: fills core once (then frozen), refreshes explore; hybrid: explore only
```
Never edit core questions yourself: changing them breaks week-over-week comparison. Mention notable new explore questions in the final message.

```bash
geo-loop probe          # exit 0 ok, 2 partial (an engine failed or budget hit), 1 failed
geo-loop map --json > /tmp/map.json
```
- Exit 1: stop, run `geo-loop report`, commit, and report the failure.
- If two or more engines failed, **ship nothing today** (drafts and report still run).

## 2. Plan (at most the daily caps)

Candidates, in priority order:
1. **Refreshes** of existing posts that target a probe question where engines cite other pages and not ours. `geo-loop page list` lists posts; match questions to the closest existing post by topic. Skip any page changed in the last `gates.cooldownDays` (ship will refuse it anyway).
2. **New posts** only for a question with no reasonably matching post. Hold this lane if the config has no category reference for new posts.
3. **Code PRs** (llms.txt, JSON-LD, sitemap) only for files in `github.allowlist`, and only when `GITHUB_TOKEN` is set.

For each candidate, write down: target, target question ids, the technique(s) you'll apply, and why (citing probe/map data). Try at most `gates.maxUntestedTechniquesPerDay` technique you have not used before.

### Technique library
- **Answer first**: open with a 2-3 sentence direct answer to the target question.
- **Cite sources**: link the authoritative pages engines already cite (docs, community threads) for the claims you make.
- **Statistics with sources**: add a figure only if it appears in a source you fetched or in the product facts.
- **Quotations**: quote a short line from an authoritative cited source, attributed.
- **FAQ matching the questions**: add H3 questions phrased like the probe questions, each answered in 1-3 sentences.
- **Comparison table**: for comparison questions, a compact factual table.
- **Freshness**: update steps that changed; note the version or date the steps were checked against.

## 3. Draft

For a refresh:
```bash
geo-loop page get <slug> > /tmp/<slug>.json
```
Edit `bodyMarkdown` (keep every `![alt](pt:<key>)` image line you want to keep; keep at least `gates.headingKeepRatio` of the existing headings; never change the slug). Keep the positioning line's spirit, never use a banned phrase, keep the existing CTA link. Save the new body to `/tmp/<slug>.draft.md`.

Rules that the gates will enforce anyway (save the round trip):
- Every number, percentage or price must appear in a fetched source (put its text in `sources`) or the product facts.
- No invented quotes, customers, benchmarks or features.

## 4. Mock eval

How the judge runs depends on `judge.provider` in the config.

**API judge** (`auto`, `anthropic`, `openai`, `gateway`):
```bash
geo-loop eval --page <slug> --draft /tmp/<slug>.draft.md --questions <ids> --json > /tmp/<slug>.eval.json
```

**External judge** (`external`, e.g. when this agent host can run sub-agents and no judge API key is wanted). Three steps:
1. `geo-loop eval --page <slug> --draft /tmp/<slug>.draft.md --questions <ids> --prepare /tmp/<slug>.judge.json`
   This writes anonymized, shuffled judge prompts (`calls[]`, each with `system`, `prompt`, `labels`, empty `answer`).
2. You wrote the draft, so **you must not judge it**. For each question in the job, start a fresh sub-agent
   (Claude Code: the Agent/Task tool; other hosts: their sub-agent or a separate session) and give it ONLY that
   question's calls: their `system` and `prompt` text and the instruction "for each call, reply with only the
   letter of the page you would cite". No repo access, no files, no mention of the brand, of which page is ours,
   or of the draft. Write each returned letter into that call's `answer` in the job file. Change nothing else.
3. `geo-loop eval --answers /tmp/<slug>.judge.json --json > /tmp/<slug>.eval.json`
   It refuses a job with missing answers, and fails a call if the prompts no longer match.

Only a `decision.verdict` of `pass` may ship. A fail is a normal outcome: note the reason and move on.

## 5. Ship

Write `/tmp/<slug>.change.json`:
```json
{
  "lane": "refresh",
  "target": "<slug>",
  "reason": "<why, citing probe/map data>",
  "questionIds": ["<ids>"],
  "techniques": ["answer-first", "faq-matching"],
  "sources": [{ "url": "<source url>", "text": "<the excerpt containing any number you used>" }],
  "eval": "<paste the whole `geo-loop eval --json` output here; ship reads decision.verdict>",
  "content": { "title": "<optional new title>", "excerpt": "<optional new meta description>", "body": "<the draft markdown>" }
}
```
```bash
geo-loop ship --change /tmp/<slug>.change.json
```
Exit 0 shipped, 2 held/queued (reason printed), 1 ship failed (it auto-restored). Do not re-run a held change unchanged.
If `shipMode` in the config is `"dry_run"`, ship writes nothing and prints the exact payload: that is expected. Keep each `change.json` in `.geo-loop/proposed/<date>/` so a human can review what would have shipped.

## 6. Off-site drafts and report

```bash
geo-loop drafts      # reply/pitch drafts for a human to post; never post anything yourself
geo-loop report      # writes <dataDir>/report/index.html (detailed log)
geo-loop dashboard   # writes <dataDir>/report/dashboard.html (latest) and report/history/<date>.html (kept per run)
```

## 7. Persist

The ledger is the loop's memory (snapshots for `revert`, cooldowns, trends). Commit it and the report to the data repo and push:
`git add .geo-loop && git commit -m "geo-loop run <date>" && git push`. Never commit `.env`.
If pushing to the default branch is refused, push to the branch `geo-loop/state` and say so in the final message; the next run must start from that branch.

## 8. Final message

Three to six lines: run status, ship mode (live or dry run), the dashboard path (`<dataDir>/report/history/<date>.html`), citation share per engine vs the previous run, what shipped (change ids + `geo-loop revert <id>`), what was held and why, and drafts waiting for a human. If nothing shipped, say why.

## Steer (end of every weekly run)

Read the previous runs and changes in the report. Write a short diagnosis that cites numbers. You may propose new techniques, questions or gate settings **only as a pull request against `geo-loop.config.ts`** for a human to merge; never edit the config directly in a run.
