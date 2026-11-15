# geo-loop

An open-source SEO/GEO improvement loop for small SaaS teams. Every day it:

1. **Probes** ChatGPT, Perplexity and Claude (web search on) with your buyers' questions and records which URLs they cite.
2. **Maps** the third-party sites AI engines trust for your topics, so you know where you need to show up.
3. **Plans and drafts** changes with Claude: refreshes to pages that already rank, new posts, metadata/schema/llms.txt PRs, and off-site reply and pitch drafts.
4. **Evaluates** each draft with a mock eval: shown your page next to the pages engines cite today, does an LLM judge pick yours?
5. **Ships** what passes, behind hard gates (positioning rules, no unsourced numbers, slug immutability, daily caps), with a snapshot and one-command `revert`.
6. **Measures and adapts** weekly: real citation share and AI-referred signups re-rank which techniques it tries next, and it checks whether the mock eval actually predicts real citations.

Off-site work (Reddit, forums, listicles) is drafted for a human to post. The tool never posts or sends anything.

## Why

Most GEO tools monitor. A few patch technical SEO. Few close the loop: try a change, measure the result, keep it or roll it back, and learn which techniques work for your site. The research says AI visibility tracks mentions on other sites more than on-site edits (see Ahrefs' brand-mention study), so the citation map and off-site drafts are first-class here, not an afterthought.

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

Shipping needs `SANITY_WRITE_TOKEN` (Sanity CMS lane) and `GITHUB_TOKEN` (code-PR lane). Measurement uses Google Search Console and PostHog.

## Commands

| Command | What it does |
|---|---|
| `geo-loop onboard` | Set up config and keys safely (hidden input, `.env` 600 + gitignored, free key checks) |
| `geo-loop config check` | Validate config and keys |
| `geo-loop probe [--force]` | Ask every engine every question; record citations |
| `geo-loop map [--by-topic]` | Citation-source map |
| `geo-loop eval --page <url> [--draft <file>]` | Mock eval: win rate vs currently cited pages (`--prepare` / `--answers` for an external judge) |
| `geo-loop ship --change <file> [--dry-run]` | Gate, snapshot, publish, verify live |
| `geo-loop revert <change-id>` | Restore the snapshot / unpublish / revert PR |
| `geo-loop drafts` | Off-site reply and pitch drafts from the map |
| `geo-loop report` | Private static HTML results page |

Exit codes: `0` ok, `2` partial (some work held or skipped, with reasons), `1` failed. A run never reports success silently: every held or skipped item has a reason in the ledger.

## Running it daily

The `skill/geo-loop` folder is a Claude skill that drives the loop: the CLI does the deterministic work, Claude does the judgment (what to change, drafting, review). Schedule it as a Claude Code cloud routine, or any cron that can run Claude Code.

## Case study

Built at Sundai Hack 149 (MIT, Nov 15 2026) for [Synta](https://synta.io), an n8n reliability copilot.

## License

MIT
