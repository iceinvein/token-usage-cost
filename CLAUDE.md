# claude-cost

Bun CLI that tracks local Claude Code, Codex, and Cursor token usage and ships
aggregated events to Grafana Loki. Ink/React terminal dashboard.

## Commands

```bash
bun run dev               # Run CLI (src/cli.ts)
bun run dashboard         # Ink terminal dashboard (auto-refresh, auto-sync)
bun run sync              # Ingest claude/codex/cursor into SQLite
bun run today | week | month | projects | models | daily
bun run loki:push         # Push unsynced events to Grafana Loki
bun run loki:delete       # List or cancel Loki delete requests
bun run loki:reset        # Reset synced_at flags (after retention skips)
bun run check             # tsc --noEmit (also runs as prepublishOnly)
bun run release patch     # Bump, tag, push; CI publishes on vX.Y.Z tag
bun run build:all         # Compile 5-target binary matrix into dist/
```

## Architecture

- `src/cli.ts` - Commander entry; `bin` field publishes as `claude-cost`.
- `src/ingest.ts` + `parser.ts`, `codex.ts`, `cursor.ts`, `claude-usage.ts` - source readers.
- `src/db.ts` - `bun:sqlite` schema, sync tracking, additive migrations.
- `src/aggregate.ts` + `dashboard-data.ts` - query/derive views.
- `src/dashboard-app.tsx` - Ink/React terminal UI.
- `src/loki-sink.ts` - batched Loki push w/ structured metadata, claude-code only.
- `src/pricing.ts` - LiteLLM model pricing fetch + cache.
- `grafana/claude-cost-overview.json` - Grafana dashboard (separate from terminal UI).
- `scripts/release.ts` - guarded version bump + tag + push.
- `.github/workflows/release.yml` - npm publish + 5-platform binary build on tag.

## Storage

- SQLite at `~/.local/share/claude-cost/usage.sqlite` (WAL mode).
- Claude `/usage` snapshot cache at `~/.local/share/claude-cost/claude-usage.json`.
- Schema migrations are additive `ALTER TABLE` statements in `db.ts`; never rewrite history.

## Gotchas

- **Codex DB**: open with `file:${path}?immutable=1` URI. Plain readonly fails on
  WAL files (SQLITE_CANTOPEN). See `codex.ts:36`.
- **Loki cutoff**: `LOKI_MAX_AGE_HOURS` (default 168) silently marks old events
  synced. Use `bun loki:reset` to recover. See `loki-sink.ts`.
- **Loki source filter**: only `claude-code` events ship; `codex-cli`/`cursor`
  are filtered at SQL layer.
- **Loki structured metadata**: `model`, `speed`, `user` go as structured
  metadata, not labels (cardinality control).
- **Release**: refuses non-main, dirty tree, or out-of-sync origin. Tag triggers
  CI publish via OIDC trusted publishing.
- **Grafana dashboard**: panel queries use `[$__interval]` (not `[1d]`) for
  windowed aggregations; piechart needs Reduce transform + queryType=range.

## Environment

- `.env.local` is auto-loaded by Bun. Required for Loki: `LOKI_URL`,
  `LOKI_USERNAME`, `LOKI_PASSWORD` (or `LOKI_TOKEN`). Optional: `LOKI_TENANT_ID`,
  `LOKI_TEAM`, `LOKI_ENV`, `LOKI_USER_LABEL`, `LOKI_BATCH_SIZE`,
  `LOKI_MAX_AGE_HOURS`.

## Conventions

- Bun primitives (`bun:sqlite`, `Bun.file`, `Bun.$`) per global rules.
- `type` over `interface` (TS).
- No emdashes anywhere.
- Commit protocol: `bun run check` before any commit; tests where they exist.
