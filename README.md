# codex-changelog

Autonomous release announcer for OpenAI's Codex. It watches the changelog, drafts a post, ships it to X — and commits its own memory back to the repo. Runs hourly, touches no human.

## What it does

Every hour a GitHub Action wakes up and checks two sources:

- **Codex app** — the changelog at [developers.openai.com/codex/changelog](https://developers.openai.com/codex/changelog)
- **Codex CLI** — public GitHub releases for [`openai/codex`](https://github.com/openai/codex/releases)

Anything unseen goes to the local `claude` CLI, which writes a tight post — exactly 3 feature bullets, each starting with an emoji, the whole thing under 280 characters. It publishes to X, then writes the last-posted key back to `.state/`. (That's why the git log is a quiet stream of `chore(state): update last posted keys`.)

Several unseen entries at once? It posts them oldest → newest, and each source advances independently, so a same-day app + CLI drop don't block each other.

## Run

```bash
bun install
bun run index.ts
```

## Fail-loud by design

Post copy comes from Claude, and only Claude. If the output isn't 3–5 emoji-led lines under the character budget, it retries up to 3 times and then hard-fails rather than tweet something malformed. Better silent than sloppy.

## Secrets

| Variable | For |
| --- | --- |
| `X_API_KEY` / `X_API_SECRET` | X app credentials |
| `X_ACCESS_TOKEN` / `X_ACCESS_TOKEN_SECRET` | X account (OAuth1) |
| `CLAUDE_CODE_OAUTH_TOKEN` | post generation in CI |
| `GITHUB_TOKEN` | optional — raises GitHub API rate limits |

## Automation

`.github/workflows/hourly.yml` — `0 * * * *` plus a manual trigger. One run generates, publishes, and commits state.
