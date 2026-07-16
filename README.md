# claude-compact

Lower auto-compact threshold (320K) + structured HANDOFF for session continuity. Zero user interaction required.

> **First-time setup:** Set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` to `320000` in `~/.claude/settings.json`:
> ```json
> { "env": { "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "320000" } }
> ```
> Without this, Claude Code defaults to ~1M and auto-compact fires too late — deep in the degradation zone.

## Why this exists

Claude Code's long context window is not a reliable working-memory zone all the way to 1M tokens. The core problem is absolute token count, not percentage of window used: long-context recall degrades well before the advertised limit, and real coding sessions are harder than synthetic retrieval benchmarks because they require cross-file reasoning, user intent, failed attempts, and current repo state to remain available at the same time.

Claude Code's built-in auto-compact is useful, but it is lossy. Field use showed the first things to disappear are exactly the facts that keep an agent from repeating work: ruled-out approaches, verbatim error strings, exact signatures, and decision rationale. A broad narrative summary can say "we tried X"; it often does not preserve the precise reason X must not be retried.

`claude-compact` is a zero-interaction continuity layer around that behavior:

- It pulls auto-compact back to `320000`, near the practical degradation edge instead of waiting for the default ~1M safety net to fire too late.
- It writes a schema HANDOFF when the auto `PreCompact` hook fires, including decisions, ruled-out paths, key references, open tasks, constraints, next action, git state, and last failed Bash output.
- It keeps HANDOFF orthogonal to Claude Code's own compact summary: compact owns narrative continuity; HANDOFF owns structured state, verbatim references, and operational constraints.
- It injects only the high-value HANDOFF slice after compact, leaving the full file on disk for explicit lookup and avoiding another giant context payload.

The goal is not to replace `/compact`. The goal is to make automatic compaction survivable: after a long session rolls over, the next turn should not have to reconstruct what branch it was on, which attempts already failed, or what exact action should happen next.

## What it does

1. **PreCompact hook** (best-effort) — before auto-compact fires, extracts structured state from the transcript via Sonnet 5 and writes `<cwd>/.claude/HANDOFF-<sid>.md`. Falls back to mechanical extract if Sonnet fails.
2. **PostCompact hook** — selectively reloads the orthogonal sections (Decisions, Ruled Out, Constraints, Next Action) + YAML frontmatter into `additionalContext` so the compacted session retains structured state.
3. **claude-compact CLI** — read compact summaries + HANDOFF files from the terminal (post-session review).

## Install

### From GitHub

```bash
# 1. Add marketplace, or refresh it if it was already added
/plugin marketplace add arthur-hsu/claude-compact
/plugin marketplace update arthur-plugins

# 2. Install
/plugin install claude-compact@arthur-plugins

# 3. Set auto-compact threshold (REQUIRED — see note above)
tmp="$(mktemp)"

jq '.env = (.env // {}) | .env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "320000"' \
  ~/.claude/settings.json > "$tmp" && mv "$tmp" ~/.claude/settings.json

# Check config
jq '.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW' ~/.claude/settings.json
# → should be "320000"

# 4. (Optional) Download the CLI to ~/.local/bin
curl -o ~/.local/bin/claude-compact https://raw.githubusercontent.com/arthur-hsu/claude-compact/master/bin/claude-compact
chmod +x ~/.local/bin/claude-compact
# Ensure ~/.local/bin is on PATH:
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc   # or ~/.zshrc

# 5. Restart Claude Code session
```


## Uninstall

```bash
/plugin uninstall claude-compact@arthur-plugins
```

## Plugin vs raw hooks

| | Raw hooks in `~/.claude/hooks/` | Plugin |
|---|---|---|
| Install | Edit settings.json manually | `/plugin install` |
| Uninstall | Edit settings.json manually | `/plugin uninstall` |
| Versioning | None | `.claude-plugin/plugin.json` version field |
| Distribution | Manual copy | Marketplace / git clone |
| Hook paths | Hardcoded absolute paths | `${CLAUDE_PLUGIN_ROOT}` portable |
| Conflict detection | None | Merge semantics documented |

## Components

- `hooks/pre-compact.mjs` — PreCompact: transcript digest → Sonnet 5 → HANDOFF-<sid>.md
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
