# claude-compact

Lower auto-compact threshold (320K) + structured HANDOFF for session continuity. Zero user interaction required.

> **First-time setup:** Set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` to `320000` in `~/.claude/settings.json`:
> ```json
> { "env": { "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "320000" } }
> ```
> Without this, Claude Code defaults to ~1M and auto-compact fires too late — deep in the degradation zone.

## What it does

1. **PreCompact hook** (best-effort) — before auto-compact fires, extracts structured state from the transcript via Sonnet 4.6 and writes `<cwd>/.claude/HANDOFF-<sid>.md`. Falls back to mechanical extract if Sonnet fails.
2. **PostCompact hook** — selectively reloads the orthogonal sections (Decisions, Ruled Out, Constraints, Next Action) + YAML frontmatter into `additionalContext` so the compacted session retains structured state.
3. **claude-compact CLI** — read compact summaries + HANDOFF files from the terminal (post-session review).

## Install

### From GitHub

```bash
# 1. Add marketplace and install
/plugin marketplace add arthur-hsu/claude-compact
/plugin install claude-compact

# 2. Set auto-compact threshold (REQUIRED — see note above)
jq '.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW' ~/.claude/settings.json
# → should be "320000"

# 3. (Optional) Download the CLI to ~/.local/bin
curl -o ~/.local/bin/claude-compact https://raw.githubusercontent.com/arthur-hsu/claude-compact/master/bin/claude-compact
chmod +x ~/.local/bin/claude-compact
# Ensure ~/.local/bin is on PATH:
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc   # or ~/.zshrc

# 4. Restart Claude Code session
```


## Uninstall

```bash
/plugin uninstall claude-compact
```

## Plugin vs raw hooks

| | Raw hooks in `~/.claude/hooks/` | Plugin |
|---|---|---|
| Install | Edit settings.json manually | `/plugin install` |
| Uninstall | Edit settings.json manually | `/plugin uninstall` |
| Versioning | None | `plugin.json` version field |
| Distribution | Manual copy | Marketplace / git clone |
| Hook paths | Hardcoded absolute paths | `${CLAUDE_PLUGIN_ROOT}` portable |
| Conflict detection | None | Merge semantics documented |

## Components

- `hooks/pre-compact.mjs` — PreCompact: transcript digest → Sonnet 4.6 → HANDOFF.md
- `hooks/post-compact.mjs` — PostCompact: selective HANDOFF reload into additionalContext
- `bin/claude-compact` — CLI: read compact summaries + HANDOFF from completed sessions

## claude-compact CLI

```bash
# List all sessions with compact summaries (newest first)
claude-compact -l

# Print the last compact summary for current cwd
claude-compact

# Print ALL compact summaries (chronological)
claude-compact -a

# Print last 3 summaries
claude-compact -n 3

# Print compact summary only (skip handoff)
claude-compact -c

# Print handoff file only (skip compact summary)
claude-compact -f

# Diagnostic: check HANDOFF orthogonality vs compact summary
claude-compact -d

# Target a specific session
claude-compact -s <session-id>
```

## Env

`CLAUDE_CODE_AUTO_COMPACT_WINDOW=320000` — set in `~/.claude/settings.json` env block. Plugin hooks fire on auto-compact; threshold is controlled by this env var.
