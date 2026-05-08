# claude-compact Plugin Spec

> Companion spec: `handoff-spec.md` (HANDOFF dual-track mechanism overview)
> This spec: packaging the PreCompact/PostCompact HANDOFF mechanism as a Claude Code plugin — fully automated, zero user interaction, working around platform PreCompact instability.

---

## 0. Platform Constraints (read before other sections)

Findings from https://github.com/anthropics/claude-code/issues:

| Constraint | Issue | Response |
|---|---|---|
| **No programmatic `/compact` API** | #52002, #54580 | Accepted. Plugin does not attempt to trigger compact. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set to 320K in settings.json. |
| **PreCompact hook unreliable on auto-compact** (v2.1.105–2.1.114) | #50467 | PreCompact is best-effort. HANDOFF write failure is not plugin failure. |
| **Manual `/compact [instructions]` has bugs** | #43685 | Plugin does not depend on instruction form. |
| **Compact may fire at 30%** (bug) | #45117 | HANDOFF written by PreCompact when it fires; early trigger still yields output. |
| **Compact race condition may corrupt transcript** | #40352 | HANDOFF written to `<cwd>/.claude/`, unaffected. |

**What the plugin can and cannot do:**

| Can | Cannot |
|---|---|
| Set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` via settings.json | Programmatically trigger compact |
| PreCompact hook writes HANDOFF (best-effort) | Guarantee PreCompact always fires |
| PostCompact hook reads HANDOFF, injects additionalContext | See Claude Code internal token % |
| | Block UserPromptSubmit / PreToolUse (zero-interaction requirement) |

---

## 1. Why This Plugin Exists

**Problems with Claude Code's built-in auto-compact:**

1. Default threshold (~1M for Opus 4.7) is too late — degradation starts at 200–280K
2. PreCompact hook is unreliable on auto-compact (#50467) — HANDOFF may never be written
3. The compact summary is written by Claude Code's internal LLM — lacks structured preservation of session progress
4. After reload, no clear "where we left off / what's next"

**Plugin response:**

- `CLAUDE_CODE_AUTO_COMPACT_WINDOW=320000` in settings.json — auto-compact fires at 320K, near the degradation boundary
- PreCompact hook writes structured HANDOFF when it fires (best-effort)
- PostCompact hook selectively reloads orthogonal HANDOFF sections into additionalContext
- If PreCompact doesn't fire, reload degrades to self-contained mode

---

## 2. Scope

**Plugin provides:**

| Component | Role |
|---|---|
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW=320000` | env in `~/.claude/settings.json` |
| `PreCompact` hook (`hooks/pre-compact.mjs`) | Sonnet 4.6 dual-path → HANDOFF-{shortId}.md (best-effort) |
| `PostCompact` hook (`hooks/post-compact.mjs`) | Selective HANDOFF reload into additionalContext |
| `bin/claude-compact` | CLI: read compact summaries + HANDOFF from completed sessions |

**HANDOFF artifact:** `<cwd>/.claude/HANDOFF-{shortId}.md` (schema defined in `handoff-spec.md` §5).

**Not included (intentionally):**
- PostToolUse save-point detection + progress.md
- Stop hook token estimation
- SessionStart / SessionEnd hooks
- State file / progress log mechanism
- `/handoff-status` slash command

**Unchanged from original:**
- `pre-compact.mjs` internal Sonnet + mechanical fallback dual-path
- HANDOFF message-level schema

---

## 3. Plugin Structure

```
claude-compact/
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── hooks/
│   ├── hooks.json             # Hook declarations
│   ├── pre-compact.mjs        # PreCompact: transcript digest → HANDOFF
│   └── post-compact.mjs       # PostCompact: selective HANDOFF reload
├── bin/
│   └── claude-compact         # CLI: view compact summaries + HANDOFF
└── README.md
```

### 3.1 plugin.json

```json
{
  "name": "claude-compact",
  "version": "0.6.2",
  "description": "Auto-compact HANDOFF hooks: structured state preserved before compaction, selectively reloaded after. Zero user interaction required.",
  "author": {
    "name": "arthur"
  }
}
```

### 3.2 hooks.json

```json
{
  "description": "PreCompact: write structured HANDOFF via Sonnet 4.6 (mechanical fallback on failure). PostCompact: selectively reload orthogonal sections into additionalContext.",
  "hooks": {
    "PreCompact": [
      {
        "matcher": "auto",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/pre-compact.mjs\"",
            "timeout": 120,
            "statusMessage": "Writing HANDOFF-{shortId}.md before auto-compact (Sonnet 4.6, ≤90s)..."
          }
        ]
      }
    ],
    "PostCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/post-compact.mjs\""
          }
        ]
      }
    ]
  }
}
```

---

## 4. PreCompact Hook (`pre-compact.mjs`)

### 4.1 Trigger

`matcher: "auto"` — fires only on auto-compact, NOT on manual `/compact`. Timeout: 120s.

### 4.2 Dual-Path Model

**Path A (preferred):** Parse JSONL transcript → build digest (cap 80K chars) → pipe digest + instruction to `claude -p --model claude-sonnet-4-6` (cost cap $1.50, internal 90s timeout). Sonnet returns structured HANDOFF with 6 sections.

**Path B (fallback):** On Sonnet timeout / non-zero exit / empty stdout / output < 200 chars → mechanical extract directly from transcript (last 30 user messages, last 50 file touches, TodoWrite snapshot).

**Always `exit 0`** — never block compaction.

### 4.3 What It Extracts

| Source | Content |
|---|---|
| `user` text (filtered) | First-5 + last-45 messages (preserves session intent + current focus) |
| `assistant` text | Last 20 turns |
| `tool_use` Edit/Write/NotebookEdit | File touch map (deduplicated) |
| `tool_use` TodoWrite | Latest todo snapshot |
| `tool_use` TaskCreate/TaskUpdate/TaskStop/TaskList | Task event sequence (last 30) |

### 4.4 Hook-Side Ground Truth (Not Through LLM)

Written directly into YAML frontmatter by the hook, zero hallucination risk:

```yaml
env:
  branch: <git rev-parse --abbrev-ref HEAD>
  head: <git rev-parse --short HEAD>
  upstream: <remote/branch>
  ahead: <N>
  behind: <N>
  dirty_files: |
    <git status --porcelain, max 50 lines>
last_failed_bash:
  command: <verbatim>
  description: <verbatim>
  error: |
    <verbatim error text, max 24 lines>
```

### 4.5 HANDOFF Output

Written to `<cwd>/.claude/HANDOFF-{shortId}.md`. Format: YAML frontmatter + 6 schema sections (Decisions, Ruled Out, Key References, Open Tasks, Constraints, Next Action). Full schema in `handoff-spec.md` §5.

### 4.6 Early-Exit Guards

- `trigger !== "auto"` → exit 0 (manual compact not handled)
- Transcript path missing / file nonexistent / 0 bytes → exit 0 (prevents spurious Sonnet calls from syntax checks)
- `LOCUS_PRECOMPACT_FORCE_FALLBACK=1` → skip Sonnet, go directly to mechanical

---

## 5. PostCompact Hook (`post-compact.mjs`)

### 5.1 Trigger

Fires after every compact (both auto and manual, since `matcher` is unset).

### 5.2 Behavior

1. Find the auto-written HANDOFF file in `<cwd>/.claude/`:
   - Prefer `HANDOFF-{8-char}.md` matching the current hook `session_id`
   - Otherwise, fall back to newest `HANDOFF-{8-char}.md` by mtime
2. Extract only the **orthogonal sections** (not the full file):
   - YAML frontmatter (env-state ground truth)
   - `## Decisions`
   - `## Ruled Out`
   - `## Constraints`
   - `## Next Action`
3. Inject as `additionalContext` via stdout JSON

Sections NOT injected (Key References, Open Tasks) remain on disk as archival memory — Claude can `Read` them on demand.

### 5.3 Rationale

Pasting the entire HANDOFF back duplicates content with the auto-compact summary, triggering task interference (ACL 2024 EMNLP) and lost-in-the-middle. Selective re-inject keeps the high-signal slice in context and treats the rest as Letta-style archival memory accessible via `Read`.

---

## 6. claude-compact CLI

### 6.1 Purpose

Read-only tool for post-session review. Resolves `$PWD` to `~/.claude/projects/<slug>/`, finds the newest session with compact summaries, and prints them with the matching HANDOFF file.

### 6.2 Usage

```bash
claude-compact              # Last compact summary + HANDOFF (newest session)
claude-compact -l           # List sessions with compact summaries (count + filename)
claude-compact -a           # ALL compact summaries (chronological)
claude-compact -n 3         # Last 3 compact summaries
claude-compact -c           # Compact summary only (skip HANDOFF)
claude-compact -f           # HANDOFF only (skip compact summary)
claude-compact -d           # Overlap diagnostic: HANDOFF vs compact summary redundancy
claude-compact -s <sid>     # Target a specific session ID
claude-compact -p           # Print resolved jsonl path only
claude-compact -h           # Help
```

### 6.3 Overlap Diagnostic (`-d`)

Quantifies semantic overlap between the HANDOFF file and the auto-compact summary using a 6-word sliding window. Output:

```
=== Overlap diagnostic (handoff vs compact summary) ===
compact chars (normalized): 38797
handoff chars (raw):        5549
FULL overlap (handoff line wholly in compact): 0
PARTIAL overlap (6-word window match):    0
Heuristic redundancy score: 0.0
  (≤2 = good orthogonality; ≥10 = schema discipline slipping)
```

- **FULL overlap** = entire handoff line appears verbatim in compact summary
- **PARTIAL overlap** = 6 consecutive words match
- **Redundancy score** = `len(FULL) + 0.5 × len(PARTIAL)`. ≥10 means schema discipline has slipped — check the HANDOFF_INSTRUCTION prompt.

### 6.4 Compatibility

Written in **bash** (not zsh). Uses `stat -f '%m %N'` for mtime sorting (macOS BSD stat compatible). Requires `jq` and `python3` (for `-d` diagnostic only).

---

## 7. Install

```bash
# 1. Register marketplace and install
/plugin marketplace add <marketplace-url>
/plugin install claude-compact

# 2. Verify CLAUDE_CODE_AUTO_COMPACT_WINDOW is set in settings.json:
jq '.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW' ~/.claude/settings.json
# → "320000"

# 3. (Optional) Add claude-compact CLI to PATH:
ln -s <plugin-path>/bin/claude-compact ~/.local/bin/claude-compact

# 4. Restart Claude Code session
```

### 7.1 Uninstall

```bash
/plugin uninstall claude-compact
```

### 7.2 Conflict Resolution

If you previously had PreCompact/PostCompact hooks in `~/.claude/settings.json` pointing to `~/.claude/hooks/`, those entries should be removed to avoid duplicate execution. Plugin hooks merge with user hooks and run in parallel.

---

## 8. Failure Modes and Recovery

| Failure | Behavior | Why |
|---|---|---|
| **PreCompact hook doesn't fire (auto-compact, #50467)** | Silent; reload degrades to self-contained mode | PreCompact is best-effort, not plugin failure |
| **HANDOFF write fails (disk full, permissions)** | Silent fail, log to stderr | fail-open |
| **Plugin script throws** | `console.error` + `exit 0` | Hook never fail-close |
| **PostCompact can't find HANDOFF** | Inject empty context, reload self-contained | Doesn't break session |
| **`CLAUDE_CODE_AUTO_COMPACT_WINDOW` not set** | Claude Code uses default (~1M) | Degrades to no-plugin behavior, no breakage |
| **Sonnet path fails (timeout, quota, missing binary)** | Falls back to mechanical extract | Mechanical HANDOFF is uglier but functional |
| **Transcript empty/missing** | Early-exit guard, no HANDOFF written | Prevents spurious Sonnet calls |

**Core principles:**
1. **fail-open** — all hooks pass on error
2. **HANDOFF is best-effort** — missing HANDOFF is not plugin failure
3. **PreCompact instability is a known platform constraint** — accepted, not worked around

---

## 9. Plugin vs Raw Hooks

| | Raw hooks in `~/.claude/hooks/` | Plugin |
|---|---|---|
| Install | Edit settings.json manually | `/plugin install` |
| Uninstall | Edit settings.json manually | `/plugin uninstall` |
| Versioning | None | `.claude-plugin/plugin.json` version field |
| Distribution | Manual copy | Marketplace / git clone |
| Hook paths | Hardcoded absolute paths | `${CLAUDE_PLUGIN_ROOT}` portable |
| Conflict detection | None | Merge semantics documented |

---

## 10. Key Takeaways for Future Maintainers

- **Platform constraints are the design starting point** (§0). Plugin cannot trigger compact, PreCompact is unreliable on auto-compact — these two facts determine the entire architecture.
- **Zero user interaction is a hard requirement** — no blocking, no `/compact` prompts, no plugin commands. The plugin only observes, writes HANDOFF, and manages env.
- **PreCompact is best-effort.** HANDOFF not written ≠ plugin failure.
- **fail-open is the bottom line** (§8). Any script throw, API failure, corrupt file, hook not firing — all pass. Silence is better than blocking the user.
- **PostCompact injects selectively, not the full HANDOFF** — avoids task interference with the auto-compact summary.
- **Plugin structure: hooks + bin + .claude-plugin** — hooks are pure functions, easy to test in isolation.
- **Future:** If Anthropic opens a programmatic compact API (#52002) or context-usage hook (#54580), this plugin can upgrade to truly proactive compaction. Until then, this is the maximum viable design given platform constraints.
