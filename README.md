# codex-changelog

Autonomous release announcer for OpenAI's Codex. It watches the changelog, drafts a post, ships it to X — and commits its own memory back to the repo. Runs hourly, touches no human.

## What it does

Every hour a GitHub Action wakes up and checks two sources:

- **Codex app** — the changelog at [developers.openai.com/codex/changelog](https://developers.openai.com/codex/changelog)
- **Codex CLI** — public GitHub releases for [`openai/codex`](https://github.com/openai/codex/releases)

Anything unseen goes to the OpenRouter API using `anthropic/claude-opus-5`, which writes a tight post — exactly 3 feature bullets, each starting with an emoji, the whole thing under 280 characters. It publishes to X, then writes the last-posted key back to `.state/`. (That's why the git log is a quiet stream of `chore(state): update last posted keys`.)

Several unseen entries at once? It posts them oldest → newest, and each source advances independently, so a same-day app + CLI drop don't block each other.

## Run

```bash
bun install
bun run index.ts
```

Set `OPENROUTER_API_KEY` and the X credentials before running. In Actions, the optional `OPENROUTER_MODEL` repository variable selects the model.

`bun test` runs local checks. When `OPENROUTER_API_KEY` is set, it also generates a post from the live changelog without publishing to X or changing saved progress.

## Fail-loud by design

Post copy comes from OpenRouter. Posts must have 3–5 emoji-led lines and stay under 280 characters. Output that exceeds the length limit gets up to 3 attempts; invalid structure or API failures stop the run. Better silent than sloppy.

## Secrets

| Variable                                   | For                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `X_API_KEY` / `X_API_SECRET`               | X app credentials                                                                                       |
| `X_ACCESS_TOKEN` / `X_ACCESS_TOKEN_SECRET` | X account (OAuth1)                                                                                      |
| `OPENROUTER_API_KEY`                       | OpenRouter post generation; Actions uses the `CODEX_CHANGELOG_OPENROUTER_API_KEY` secret from Bitwarden |
| `OPENROUTER_MODEL`                         | optional model override; defaults to `anthropic/claude-opus-5`                                          |
| `GITHUB_TOKEN`                             | raises GitHub API rate limits; Actions supplies its built-in token                                      |

## Automation

`.github/workflows/hourly.yml` — `0 * * * *` plus a manual trigger. One run generates, publishes, and commits state.
