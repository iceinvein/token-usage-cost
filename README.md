# claude-cost

Minimal Bun CLI for tracking local AI coding assistant usage and estimating cost from model pricing when local token data is available.

## Commands

```bash
bun install
bun run src/cli.ts sync
bun run src/cli.ts today
bun run src/cli.ts week
bun run src/cli.ts month
bun run src/cli.ts daily --from 2026-04-08 --to 2026-04-14
bun run src/cli.ts models --from 2026-04-08 --to 2026-04-14
bun run src/cli.ts dashboard
bun run src/cli.ts dashboard --no-watch
bun run src/cli.ts dashboard --no-sync
bun run src/cli.ts dashboard --source claude-code
bun run src/cli.ts projects --from 2026-04-01 --to 2026-04-14
bun run src/cli.ts export --type daily --format csv --out /tmp/claude-cost-daily.csv
bun run src/cli.ts today --sync --root ~/.claude/projects --date 2026-04-14
```

## Dashboard

- `bun run src/cli.ts dashboard` starts the interactive dashboard with automatic refresh enabled.
- The dashboard syncs Claude/Codex usage before each refresh by default.
- Cursor activity is also included during sync.
- Use `--no-watch` to disable automatic refresh.
- Use `--no-sync` to read only what is already stored in SQLite.
- Use `--source claude-code`, `--source codex-cli`, or `--source cursor` to filter the dashboard to a single tool.
- The `Sources` panel is only shown when `--source all` is active.

## What it does

- Reads local Claude Code transcripts, Codex usage data, and Cursor workspace activity
- Extracts actual token usage from assistant entries
- Persists normalized usage events in SQLite
- Fetches model pricing from LiteLLM and caches it locally
- Calculates estimated USD cost from usage plus pricing
- Flags unknown model names instead of hiding them
- Auto-refreshes the dashboard every 10 seconds by default
- Syncs Claude/Codex/Cursor usage before each dashboard refresh by default
- Supports filtering the dashboard to a single tool

## Notes

- Token counts come from local transcript logs.
- USD totals are estimates, not billing API results.
- Cursor currently contributes activity/session counts and timestamps, but not priced token usage, because Cursor does not appear to expose reliable local token accounting in the inspected on-disk data.
