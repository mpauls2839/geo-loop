# geo-loop

An open-source CLI (plus a Claude skill) that improves how often AI engines and search cite your site. It does three things:

1. **Measures** where you stand today in SEO and GEO: which AI answers cite your site or name your brand, and which sites they trust instead.
2. **Changes** your content to close the gaps: new blog posts, rewrites of existing ones, and drafted replies to real social posts.
3. **Tracks** the results week over week, so you can see which changes moved the numbers.

## How it works

1. **Onboard.** `geo-loop onboard` connects your analytics (Google Search Console) and collects model keys safely. One Vercel AI Gateway key is enough to query all the engines, or bring each provider's own key.
2. **Probe.** It asks Claude, ChatGPT and Perplexity (with web search on) your buyers' questions and records every source they cite. The questions come from your own list, real search data, or both. That gives you a baseline: citation share, mention rate, and a map of the sites AI engines trust for your topics.
3. **Propose.** From the gaps, it drafts new blog posts, rewrites of pages that already rank, and replies to recent posts on X, LinkedIn, Bluesky, Hacker News and forums where your product fits.
4. **Eval.** Before anything ships, a separate judge (a fresh sub-agent that never saw the drafting) compares anonymized pages and picks the one it would cite. A rewrite has to beat the live page by 20 points; a new post has to win at least 40% of the time. This predicts, in theory, which content will work before real engines ever see it.
5. **Ship safely.** Changes that pass hard guardrails (no unsourced numbers, positioning rules, per-run caps, cooldowns) publish to your CMS, with a snapshot first and one-command `revert`. Start in dry run. Social replies are drafts only: a human posts them.
6. **Repeat weekly.** It runs as a scheduled cloud agent and writes every probe, change and verdict to a ledger committed to git, plus a dashboard. Each week is compared with the last, and any change can be rolled back from its snapshot.

Not built yet: using real citation and signup data to choose which techniques to try next, and deciding on its own which changes to keep or revert.

## Why

Most GEO tools only monitor. A few patch technical SEO. Few close the loop: try a change, measure the result, keep it or roll it back. AI visibility also tracks mentions on other sites more than on-site edits, so the citation map and social reply drafts are first-class here, not an afterthought.

## Quick start

```bash
npm i -g geo-loop            # or: npx geo-loop
cp examples/geo-loop.config.ts .
echo "AI_GATEWAY_API_KEY=..." > .env   # one key for all engines, or per-provider keys below
geo-loop config check
geo-loop probe
geo-loop map
```

### Keys

Each engine uses its provider's own key when present, otherwise a Vercel AI Gateway key. Any key can also be given as `GEO_LOOP_<NAME>` (e.g. `GEO_LOOP_ANTHROPIC_API_KEY`) for hosts that reserve the plain name, such as Claude Code cloud sessions:

| Engine | Direct key | Via gateway |
|---|---|---|
| Claude (judge and drafting too) | `ANTHROPIC_API_KEY` | `AI_GATEWAY_API_KEY` |
| ChatGPT | `OPENAI_API_KEY` | `AI_GATEWAY_API_KEY` |
| Perplexity | `PERPLEXITY_API_KEY` | `AI_GATEWAY_API_KEY` |

### Where the questions come from

The probe asks AI engines your buyers' questions. `geo-loop onboard` asks which mode you want (stored in `questions.json`):

| Mode | Questions |
|---|---|
| `user` | Only your own list (in the config's `questions`, or `questions.json` `core`). Nothing is generated |
| `data` | Discovered from real search data. The first `questions suggest --write` fills `core`, which then stays frozen so weekly trends are comparable; `explore` refreshes every run |
| `hybrid` | Your own `core` list, plus data-driven `explore` questions |

`geo-loop questions suggest` ranks candidates from four real sources, merging near-duplicates and keeping the evidence:

| Source | What it is | Needs |
|---|---|---|
| `gsc` | Non-brand queries your site already appears for, by impressions | Search Console access (below) and `GSC_SITE_URL` |
| `engine` | The web searches AI engines themselves ran while answering your probe questions | Nothing (recorded by `probe`) |
| `autocomplete` | Google's public suggestions for your category terms (`seedTerms`) | Nothing (unofficial public endpoint, rate-limited, best effort) |
| `thread` | Titles of Reddit/forum threads AI engines cite for your topics | Nothing (from the probe's citations) |

#### Connecting Search Console

Two ways, both read-only:

- **Your own Google sign-in (recommended, works when your org blocks service-account keys):** create an OAuth client of type **Desktop app** in Google Cloud (APIs & Services → Credentials; consent screen **Internal** if you're on Google Workspace, so the sign-in doesn't expire), put its id and secret in `.env` with `geo-loop onboard --only GSC_OAUTH_CLIENT_ID,GSC_OAUTH_CLIENT_SECRET`, then run `geo-loop auth gsc`. It opens Google sign-in, uses a loopback redirect with PKCE, and saves `GSC_OAUTH_REFRESH_TOKEN` to `.env`. For a cloud routine, copy the three `GSC_OAUTH_*` values into its environment.
- **A service account:** `GSC_SERVICE_ACCOUNT_JSON` (base64 or raw) or `GSC_SERVICE_ACCOUNT_FILE`, with the account added as a user in Search Console.

### The eval judge

The mock eval asks a judge model "which of these anonymized pages would you cite?". Pick where it runs with `judge.provider`:

| `judge.provider` | Uses |
|---|---|
| `auto` (default) | `ANTHROPIC_API_KEY`, else `OPENAI_API_KEY`, else `AI_GATEWAY_API_KEY` |
| `anthropic` | Claude via `ANTHROPIC_API_KEY` |
| `openai` | Any OpenAI-compatible endpoint: OpenAI, OpenRouter, or a local model (Ollama, LM Studio, vLLM) via `OPENAI_BASE_URL` |
| `gateway` | Any model on the Vercel AI Gateway (`judge.model` like `openai/gpt-5.4`) |
| `external` | No API calls. `geo-loop eval --prepare job.json` writes the prompts; a host agent (Claude Code, Codex, Cursor...) has fresh sub-agents fill in each `answer`; `geo-loop eval --answers job.json` scores them |

`external` lets an agent host judge with its own model, but the agent that wrote a draft must never judge it: the skill hands each question to a fresh sub-agent that sees only the anonymized prompts.

Optional: `SANITY_STUDIO_URL` (your Studio address, as copied from the browser) makes every dashboard change link straight into Sanity Studio.

Shipping needs `SANITY_WRITE_TOKEN` (Sanity CMS lane) and `GITHUB_TOKEN` (code-PR lane). Measurement uses Google Search Console and PostHog.

## Commands

| Command | What it does |
|---|---|
| `geo-loop onboard` | Set up config and keys safely (hidden input, `.env` 600 + gitignored, free key checks) |
| `geo-loop auth gsc` | Sign in with Google once to read Search Console (no service-account key) |
| `geo-loop config check` | Validate config and keys |
| `geo-loop questions list` / `suggest [--write]` | Show the questions, or discover new ones from real search data |
| `geo-loop probe [--force]` | Ask every engine every question; record citations |
| `geo-loop map [--by-topic]` | Citation-source map |
| `geo-loop eval --page <url> [--draft <file>]` | Mock eval: win rate vs currently cited pages (`--prepare` / `--answers` for an external judge) |
| `geo-loop ship --change <file> [--dry-run]` | Gate, snapshot, publish, verify live |
| `geo-loop revert <change-id>` | Restore the snapshot / unpublish / revert PR |
| `geo-loop drafts` | Off-site reply and pitch drafts from the map |
| `geo-loop report` | Private static HTML results log |
| `geo-loop dashboard [--open]` | Visual one-page dashboard: citation share, who AI trusts, what engines searched, every answer, proposed changes with judge scores |

Exit codes: `0` ok, `2` partial (some work held or skipped, with reasons), `1` failed. A run never reports success silently: every held or skipped item has a reason in the ledger.

## Running it weekly

The `skill/geo-loop` folder is a Claude skill that drives the loop: the CLI does the deterministic work, Claude does the judgment (what to change, drafting, review). Schedule it as a Claude Code cloud routine (Synta runs it every Monday), or any cron that can run Claude Code.

## Case study

Built at Sundai Hack 149 (MIT, Nov 15 2026) for [Synta](https://synta.io), an n8n reliability copilot.

## License

MIT
