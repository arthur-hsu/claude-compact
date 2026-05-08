# HANDOFF Dual-Track Mechanism Spec

> Purpose: Preserve critical context before Claude Code context window degradation, enabling lossless restart after `/compact` or `/clear`.

---

## Update Log

### 2026-05-05 — L1 proactive HANDOFF removed (single-track auto-only)

Field observation: L1 "Claude proactively writes HANDOFF.md at 150K/250K" almost never fired. The Stop hook emits `[CONTEXT]` but Claude, mid-task, typically ignores it. Very few `HANDOFF.md` files were actually written — L1 was a paper design.

Decision: remove the proactive path, switch to single-track:

- Removed `.claude/HANDOFF.md` (primary defense) dual-file design; only PreCompact auto-written `.claude/HANDOFF-{shortId}.md` remains
- Deleted `/handoff` skill (`~/.claude/skills/handoff/`)
- L2 Stop hook message changed from "write `.claude/HANDOFF.md`" to "consider `/compact` or `/clear`" (PreCompact hook handles the fallback)
- §§1.6 / 3.2 / 3.3 / 5.3 / 5.4 removed (proactive path peripheral specs)
- §11 flow quick-reference removed L1 branch
- Lost capability: `/clear` before topic switch can't proactively write high-quality handoff (`/clear` doesn't trigger PreCompact). Acceptable cost — `WINDOW=300000` pulls auto to 300K, only 50K overshoot past the 250K redline, not catastrophic

### 2026-05-04 — schema-orthogonal redesign

Field testing + multi-source research revealed the old HANDOFF design had high semantic overlap with the auto-compact summary, triggering task interference (ACL 2024 EMNLP) and lost-in-the-middle dual degradation. Three independent sources agree ([Anthropic compaction docs](https://platform.claude.com/docs/en/build-with-claude/compaction), [Letta MemGPT three-layer memory](https://docs.letta.com/concepts/memgpt/), [LangGraph schema-checkpointer](https://docs.langchain.com/oss/python/langgraph/add-memory), [dbreunig "How Long Contexts Fail"](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html), [NeurIPS 2025 Information Gain & Redundancy in Multi-Turn](https://neurips.cc/virtual/2025/128070)) — both summaries must be **orthogonal**:

- **auto-compact summary** owns narrative continuity (timeline, code snippets, why-we-did-X)
- **HANDOFF** owns structured state (schema fields, verbatim refs, env-state, ruled-out original errors)

Changes landed:

| Component | Change |
|---|---|
| `precompact-handoff.mjs` HANDOFF_INSTRUCTION | Removed TL;DR / Active Hypothesis / Files Touched / Next Action blocks; replaced with schema 6-section (Decisions / Ruled Out / Key References / Open Tasks / Constraints / Next Action one-liner) |
| `precompact-handoff.mjs` parser | Added `TaskCreate` / `TaskUpdate` / `TaskStop` / `TaskList` extraction (previously only `TodoWrite`, causing sessions using Task tools to show `(none)`) |
| `precompact-handoff.mjs` env_state | Added `gatherEnvState()` + `lastFailedBash()`, hook directly writes YAML frontmatter (branch / HEAD / ahead-behind / dirty files / last failed Bash with verbatim error). Pure facts, no LLM, zero hallucination |
| `precompact-handoff.mjs` digest | Changed from "last 50 user msgs" to "first 5 + last 45" dual-end preservation (avoids losing session intent on long transcripts) |
| `precompact-handoff.mjs` RESUME_BANNER | Changed from "read CLAUDE.md first" to "supplement, not replace, the compact summary" (avoids conflicting with compact's "continue immediately" instruction) |
| `postcompact-handoff-reload.mjs` (new, replaces old `.sh`) | PostCompact injects only Decisions / Ruled Out / Constraints / Next Action + frontmatter; full HANDOFF path surfaced for on-demand Read. Letta-style archival memory |
| `~/.local/bin/claude-compact` (new CLI) | View compact summary / handoff; `-d` flag quantifies orthogonality of the two files via 6-word window overlap diagnostic |

See §5 (new schema), §7 (implementation), §14 (claude-compact CLI and diagnostics), §15 (future: evaluation hook design discussion).

---

## 1. Why This Mechanism Is Needed

### 1.1 Context Windows Are Not Lossless (Evidence Base)

#### 1.1.1 Primary Data: MRCR v2 — Anthropic Official Claude Long-Context Recall

> This is the **primary evidence base** for all token band decisions in this spec. Other benchmarks (§1.1.2 / §1.1.3) are cross-vendor corroboration.

[**Anthropic Opus 4.6 Announcement**](https://www.anthropic.com/news/claude-opus-4-6) · [Vellum summary](https://www.vellum.ai/blog/claude-opus-4-6-benchmarks) · [Claude Code Camp 1M context analysis](https://www.claudecodecamp.com/p/claude-code-1m-context-window)

**MRCR v2** (Multi-Round Coreference Resolution v2) is a long-context retrieval benchmark proposed by OpenAI, measuring the ability to "find multiple specific facts in a long input." The **8-needle variant** is especially rigorous — retrieving 8 target needles simultaneously, close to real agentic scenarios (tracking multiple facts at once).

**Anthropic's official numbers published with the Opus 4.6 release:**

| Model | 256K | 1M (8-needle) | 1M vs 256K gap |
|---|---|---|---|
| **Claude Opus 4.6** | **93.0%** | **76.0%** | -17 percentage points |
| GPT-5.2 Thinking | 98% (4-needle) / 70% (8-needle) | — | — |
| Gemini 3 Pro | 77% (8-needle) | 26.3% | -51 percentage points |
| **Claude Sonnet 4.5** | — | **18.5%** | — |

**Why this is the primary data** (not Chroma / NoLiMa):
1. **Anthropic official release** — using Anthropic's own methodology on their own models, no third-party methodology drift
2. **Includes Claude-specific numbers** — Opus 4.6 / Sonnet 4.5, the models we actually use
3. **Covers token scales we care about** — 256K / 1M correspond to real work boundaries, not 32K academic slices
4. **8-needle approximates real agentic work** — real tasks also require tracking multiple facts simultaneously

**Core conclusions (directly driving this spec's thresholds):**

- **Opus 4.6 at 1M is still 76%** — the most reliable frontier 1M-window model (vs Gemini 3 Pro 26.3%, Sonnet 4.5 18.5%, 3–4× worse). But 76% means **24% of key facts are forgotten in a single call** — this directly corresponds to §1.5: `/compact` is lossy summarization, which is why PreCompact must auto-write HANDOFF
- **Sonnet 4.5 at 1M is only 18.5%** — "claims 1M" ≠ "usable 1M." Can't even recall 1/5 of facts, the window is effectively non-functional
- **Anthropic has not yet published MRCR numbers for Sonnet 4.6** — without official numbers, assume Sonnet at long context underperforms Opus

**Direct derivation of §4 token bands from this data:**

| Token Band | Corresponding MRCR Inference |
|---|---|
| 150K boundary | Safe lower bound of the 256K high-score zone (buffer) |
| 250K redline | Approaching 256K, the inflection point where recall begins sliding toward 1M levels |
| 400K degraded zone | Far from 256K high-score zone, entering the 76% region headed downward |
| 1M unusable | Opus 4.6 alone at 76%, Sonnet at 18.5% — **designed not to be used as working zone** |

#### 1.1.2 Corroboration 1: Chroma "Context Rot" (2025-07-14) — Cross-Vendor Universality

[Paper](https://research.trychroma.com/context-rot) · [GitHub reproduction](https://github.com/chroma-core/context-rot)

**18 frontier models across 4 vendors** (Anthropic / OpenAI / Google / Alibaba) empirically tested — **all degrade as input length increases**. Quote:

> "every single one of the 18 frontier models gets worse as input length increases"
>
> "A model with a 200K token window can exhibit significant degradation at 50K tokens, with the decline being continuous, not a cliff."

**Reinforcement for this spec:**
- Confirms degradation is not Anthropic-specific, **it's a transformer-wide problem**
- "200K window degrades at 50K" provides **scaling inference**: a 1M-window model should begin degrading at ~250–300K, consistent with §4 redline
- Claude family shows **most pronounced** focused vs full prompt gap on LongMemEval (Anthropic's ambiguous-refusal mode is treated as a feature, but gets caught by benchmarks — for us, good news, means Claude won't fabricate)

#### 1.1.3 Corroboration 2: NoLiMa Benchmark (ICML 2025) — Semantic Reasoning Degrades Steeper

[arXiv 2502.05167](https://arxiv.org/abs/2502.05167) · [Adobe GitHub](https://github.com/adobe-research/NoLiMa) · [Leaderboard](https://llm-stats.com/benchmarks/nolima)

**13 models claiming ≥128K**, extends NIAH but **enforces zero lexical overlap between question and needle** — must perform semantic linking. Quote:

> "At 32K, 11 models drop below 50% of their strong short-length baselines. Even GPT-4o ... reduces from 99.3% to 69.7%."

**Reinforcement for this spec:**
- The more reasoning a task requires, the earlier degradation hits. MRCR fact retrieval and Chroma needle tasks are relatively shallow; **real coding work requires cross-file reasoning, with a steeper degradation curve**
- 11/13 models halve at 32K, consistent with Chroma's "50K onset" observation
- 32K ≈ 16% of a 200K window — **strongest evidence that official window ≠ reliable working zone**

#### 1.1.4 Consensus Across Three Studies

| Finding | MRCR v2 (primary) | Chroma (corroboration) | NoLiMa (corroboration) |
|---|---|---|---|
| Degradation is universal | Opus 256K→1M drops 17pt | 18/18 models affected | 11/13 models halve at 32K |
| Absolute token, not percentage | 1M 76% is absolute | 200K-window degrades from 50K | 32K consistent across models |
| Reasoning tasks degrade steeper | 8-needle > 4-needle | low-similarity > high | enforced semantic linking |
| 1M is not a working zone | Opus 76%, Sonnet 18.5% | continuous decline | 128K claims half-broken at 32K |

**Concrete implication for Claude Code users:** Real agentic coding is harder than benchmarks — the model must simultaneously read code, trace callgraphs, retain ruled-out reasoning, cross-file reason, and not forget user intent. If synthetic needle tasks already show this much degradation, real sessions are worse.

**Therefore §4 adopts absolute token bands, with MRCR v2 as primary basis: 150K boundary / 250K redline / 400K degraded zone.**

### 1.2 Key Conclusion: Degradation Is About Absolute Tokens, Not Percentage

`Recall` drops non-linearly with **absolute token count**, independent of window utilization percentage. Anthropic charged a 2× premium for >200K input before 2026/3/13 — effectively the vendor admitting 200K is the reliable boundary.

**2026/3/13 update:** Anthropic removed long-context premium for Opus 4.6 / Sonnet 4.6, 1M became standard rate ([Anthropic announcement](https://www.anthropic.com/news/claude-opus-4-6)). But **quality degradation boundaries are unchanged** — removing the premium is a business decision, not a model improvement. For pre-4.6 models, the 200K economic boundary still exists.

### 1.3 Lost-in-the-Middle: Position Determines Attention (Empirical)

Source: [Claude Code Camp — Claude Code 1M Context Window](https://www.claudecodecamp.com/p/claude-code-1m-context-window) (Abhishek Ray, 2026-03-11)

**Phenomenon:** Transformers attend significantly less to the middle of context than the beginning and end. Quote:

> "models don't pay equal attention to everything in their context window. They consistently over-attend to the beginning and end, and under-attend to the middle. Researchers call this lost in the middle."
>
> "if you're using 1M context and have critical information the model must use, **put it at the beginning or end of your context**. Middle placement is a gamble."

**Impact on HANDOFF mechanism:**

1. **Reading HANDOFF on restart is the correct strategy** — after auto-compact, the PostCompact hook injects 4 HANDOFF sections at the front of new context (right after system prompt), the strongest attention position. For more detail, `cat .claude/HANDOFF-*.md`. This is also the implicit benefit of the §3.3 restart protocol.
2. **HANDOFF internal section order should align:** Task / Next at beginning and end (already the §5 order), **Ruled Out** is most prone to being forgotten after multiple turns — §5 already bold-emphasizes this but it's still mid-file; if HANDOFF is long, adding a **TL;DR block at the top** listing the most critical ruled-out / decisions exploits beginning attention (see §5.4 best practice).
3. **Searching for old context in long windows is inherently unreliable** — rather than expecting the model to find a decision from 50K tokens ago in the middle of 500K context, proactively write it into HANDOFF and `/compact`.

### 1.4 Cold Prefill Latency: HANDOFF Is Also a Performance Strategy

Source: same as above (Claude Code Camp article Experiment 3).

**Measured TTFT (Time To First Token):**

| Context | Cached (warm) | Cold (no cache) |
|---|---|---|
| 50K | ~0.8s | ~2s |
| 200K | ~1.6s | ~9s |
| 500K | ~3.5s | **~35s** |
| 1M (extrapolated) | — | **60–90s** |

**Cold prefill is super-linear** (power-law exponent ~1.24). Cache TTL is **5 minutes**; AFK > 5 minutes means cache expires, next turn at 500K+ waits 30+ seconds.

**HANDOFF + /clear is a dual optimization:**
- **Quality:** After restart, context resets to ~10–30K (system + HANDOFF + first request), back in the §1.1 "reliable working zone"
- **Performance:** Cold prefill no longer hits 500K+, TTFT drops from 30s+ to <2s

**Implementation implication:** If you expect to be AFK > 5 minutes with context > 250K, proactively `/compact` (triggers PreCompact path, writes HANDOFF) is a mandatory action — not just for quality, but to save 30 seconds of wait time. This has been added to §4.1 proactive check timing.

### 1.5 `/compact` and Auto-Compact Are Lossy Summarization

What gets dropped (in priority order, from field observation):

1. **Ruled-out reasoning** ("why we didn't choose approach X") — first to go
2. **Exact signature / error string** — summary paraphrases to "something like"
3. **Decision rationale** — conclusion preserved, but "why" gets diluted

To preserve these, the PreCompact hook must auto-write structured HANDOFF before degradation hits.

### 1.6 Why Single-Track Auto-Only

Field testing showed the proactive path (Claude writes HANDOFF.md at 150K/250K) almost never triggered — Stop hook emits `[CONTEXT]` but Claude, mid-task, ignores it. It was a paper design. Therefore this spec (as of 2026-05-05) uses auto path only:

- L0 context-mode: source reduction (highest ROI)
- L2 Stop hook: soft reminder, user decides `/compact` / `/clear` (optional)
- L3 PreCompact hook: auto-compact fires → auto-write `HANDOFF-{shortId}.md` (Sonnet 4.6 digest)
- L4 claude-mem: cross-session episodic memory

With `CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000`, L3 fires at 300K — only 50K overshoot past the 250K redline, Sonnet digest still in usable quality zone. Lost capability: proactively writing high-quality handoff before `/clear` topic switch (since `/clear` doesn't trigger PreCompact). Acceptable cost.

---

## 2. Defense Layers (Within-Session 3 × Cross-Session 1)

| Layer | Mechanism | Time Scale | Role |
|---|---|---|---|
| **L0 Source Reduction** | `context-mode` plugin keeps raw output in sandbox, returns only summary (see §8) | within-session | Keep garbage out of context |
| **L2 Soft Reminder** | Stop hook estimates tokens per turn, emits `[CONTEXT]` system message at >150K / >250K | within-session | Remind user to consider `/compact` / `/clear` |
| **L3 Hard Fallback** | `CLAUDE_CODE_AUTO_COMPACT_WINDOW=320000` + PreCompact hook writes `.claude/HANDOFF-{shortId}.md` + PostCompact selective re-inject | session boundary | Preserve critical context when auto-compact fires |
| **L4 Cross-Session Memory** | `claude-mem` plugin continuously observes + persists to KB, any session can `mem-search` (see §16) | cross-session, permanent | Recall past experience across time |

> Numbering preserves L0 / L2 / L3 / L4 without renumbering. Original L1 (proactive HANDOFF.md) was removed 2026-05-05; the gap avoids breaking references in §11 flow quick-reference / §12 failure modes.

---

## 3. Handoff File Specification (Auto-Only)

| Filename | Trigger | Writer | Role |
|---|---|---|---|
| `.claude/HANDOFF-{shortId}.md` | PreCompact hook, auto-compact fire | Sonnet 4.6 from transcript digest | Auto-compact fallback |

`shortId` = first 8 alphanumeric characters of `session_id`; falls back to `unknown` if `session_id` is missing. Multi-session concurrent writes use session ID for isolation, no symlinks. `LOCUS_PRECOMPACT_KEEP=5` (default 5) historical copies retained.

### 3.1 Finding the Latest File

```bash
# Only exists after auto-compact
ls -t .claude/HANDOFF-*.md | head -1
```

After `/compact` or `/clear`, the first action is to re-read the latest HANDOFF; the system summary left by `/compact` is lossy, subject to the drop priority order in §1.5.

### 3.2 PostCompact Auto-Injection

After PreCompact writes `HANDOFF-{shortId}.md`, auto-compact executes; PostCompact hook then injects frontmatter + Decisions / Ruled Out / Constraints / Next Action into the new context (full file remains on disk; Claude actively `Read`s when Key References / Open Tasks are needed).

### 3.3 Restart Protocol

- **After auto-compact:** PostCompact hook has injected 4 sections + frontmatter. Claude should verify frontmatter env-state (branch, dirty files) matches current reality before acting; for more detail, `cat` the full `HANDOFF-{shortId}.md`
- **After manual `/clear`:** No PreCompact trigger, therefore no HANDOFF. Reconstruct context from git log + uncommitted changes, or manually write task state into a commit message / scratchpad before `/clear`
- **Manual `/compact`:** `matcher: "auto"` filters out manual `/compact`, so no HANDOFF is written. Manual `/compact` = trust the system summary, cost is on you

---

## 4. Token Budget Bands

Decisions are based on **absolute token count**, not percentage.

| Band | Action |
|---|---|
| <100K | Continue working |
| **150–200K** | **Sweet spot** — propose `/compact` at next clean task boundary (triggers PreCompact hook, writes HANDOFF) |
| **>250K** | **Redline** — don't start new subtasks, wrap up current unit then `/compact` or `/clear` |
| >400K | Already in degradation zone — `/clear` and restart; to preserve schema state, `/compact` first (lets PreCompact write HANDOFF), then `/clear` |

> Note: `/clear` does not trigger PreCompact, so no HANDOFF fallback. To preserve context across restart, use `/compact` (auto-compact path).

### 4.1 Proactive Check Timing

Run `/context` at these points:

- After each `git commit` lands
- After subagent returns
- Before accepting the next request (if previous turn had >2 tool calls)
- When >5 consecutive turns chasing the same bug
- **When expecting AFK > 5 minutes and context > 250K** (cache TTL = 5 min, cold restart at 500K context waits 30s+ TTFT — see §1.4)
- **When session turns > 80** (article empirically finds 80+ turns of stale context **actively hurts**, `/compact` + restart is faster than continuing)

### 4.2 Most Sessions Won't Hit 150K (Don't Panic)

The article empirically observes: **most daily Claude Code sessions peak at 80–120K context** and get auto-compacted before ever approaching 200K.

Meaning: the 150K boundary in this spec is **a line for the minority of long tasks**, not an everyday anxiety threshold. Only these scenarios hit it:
- Cross-file refactoring / global refactors
- Long debug sessions (>10 turns on the same bug)
- Large codebase exploration (reading >20 files)
- Agent team tasks (multiple subagent reports accumulating)

Short tasks (write a function, check a bug) typically finish under 80K — checking at §4.1 commit/subagent boundaries is sufficient, won't hit auto-compact.

### 4.3 The 1M Window Trap

The community heuristic "compact at 60% capacity" is a **200K-era rule of thumb** (200K × 60% = 120K, which aligns with the reliable boundary).

**Don't apply it to 1M.** Per Chroma Context Rot conclusions (§1.1.1), a 200K-window model begins degrading at ~50K, absolute token count is the driver, not percentage. 1M × 60% = 600K pushed onto a 1M window puts you deep in the degradation zone. The extra 800K of a 1M window is buffer / disaster-avoidance space, **not usable working zone**.

In practice: for Opus 4.7 with a 1M window, internal usage observes quality visibly deteriorating past 250–300K (consistent with Chroma's "200K window degrades at 50K" scaling inference — a 1M window begins degrading at ~300K). Therefore §4 of this spec adopts absolute token bands (150K / 250K / 400K), not percentages.

### 4.4 When 1M Is Actually Useful (Not Default)

The article lists four scenarios where 1M genuinely helps (for all other cases, 200K + HANDOFF is better):

1. **Single-shot large file analysis** — dump an entire codebase / contract / document at once, model reads once and reasons. **No multi-turn attention dilution**, context rot is lowest. **This is what 1M was designed for.**
2. **Deep debug requiring full context** — chasing a bug across 15 files, stack traces + repro steps + failed hypotheses all need to stay; compaction would drop critical information
3. **Agent team shared state** — multiple subagent reports accumulate fast, team lead needs everything held
4. **Compliance / audit verbatim quoting** — 300-page contract in context at once, model must cite specific paragraphs

**Conversely:** daily Claude Code sessions **are not in these four categories**. 1M only costs you cold prefill latency + cache risk with no substantive benefit. **HANDOFF + /clear is always better than 1M for daily use.**

---

## 5. HANDOFF Format (Produced by PreCompact Hook)

### 5.1 Format — YAML Frontmatter + Schema 6 Sections (since 2026-05-04)

> ⚠ Changed from "TL;DR + 5 sections" to "schema 6 sections." See Update Log: auto-compact summary now owns narrative, HANDOFF owns structured state, the two are orthogonal and don't repeat.
> Since 2026-05-05: this format is only produced by PreCompact hook, no user / Claude proactively written version.

```text
---
session: <id>
generated_at: <ISO timestamp>
transcript: <jsonl path>
env:
  branch: <name>
  head: <short SHA>
  upstream: <remote/branch>
  ahead: <N>
  behind: <N>
  dirty_files: |
    <git status --porcelain output, max 50 lines>
  # OR when working tree is clean:
  # dirty_files: clean
last_failed_bash:    # only present when last Bash result was is_error: true
  command: <verbatim>
  description: <verbatim>
  error: |
    <verbatim error text, max 24 lines>
---

# HANDOFF (Sonnet 4.6 schema)

## Decisions       — one decision + Why (rationale, including alternatives weighed)
## Ruled Out       — one approach + Reason (verbatim error / quoted denial, never paraphrase)
## Key References  — verbatim SHAs / file:line / external IDs (what the next session will grep for)
## Open Tasks      — dual source: TodoWrite + TaskCreate/Update
## Constraints     — repo rules learned this session + Source (denial / failed attempt)
## Next Action     — one line, single most actionable step
```

**Design highlights** (§14 overlap diagnostic quantifies this):
- **Frontmatter written directly by hook**, not through LLM — git state and last failed Bash are verbatim, zero hallucination
- **Every section has "verbatim rules"** — paraphrasing destroys grep-ability, causing the next session to hit the same wall again
- **No more TL;DR / Active Hypothesis / Files Touched** — auto-compact summary already covers narrative; duplication triggers task interference (ACL 2024 EMNLP)
- **Next Action stays at the end** (§1.3 lost-in-the-middle aligns with end attention)
- **Ruled Out enforces verbatim error string preservation** — this is the information auto-compact most frequently paraphrases away (§1.5)

### 5.2 Full Example (New Schema)

> Copyable template. **Decisions / Ruled Out / Key References / Constraints are the four sections most likely to be lost by auto-compact — must be written in full.**

````markdown
---
session: "0d2ef14b"
generated_at: "2026-05-04T04:43:10.077Z"
transcript: "/Users/arthur/.claude/projects/-Users-.../session.jsonl"
env:
  branch: "feat/totp-first-step-up"
  head: "84096545"
  upstream: "origin/feat/totp-first-step-up"
  ahead: 1
  behind: 0
  dirty_files: |
     M backend/controller/authn/step-up.go
    ?? tests/e2e/step_up_totp_test.go
last_failed_bash:
  command: "go test ./tests/e2e/..."
  description: "run e2e step-up tests"
  error: |
    --- FAIL: TestStepUpTOTP (0.42s)
        step_up_totp_test.go:63: expected 200, got 401
---

# HANDOFF (Sonnet 4.6 schema)

> Schema handoff (orthogonal to auto-compact summary). Both will be in context — treat as additive, not duplicative. The compact summary owns narrative; this file owns structured state. Verify env-state in frontmatter (branch, dirty files) matches reality before acting.

## Decisions
- **Decision:** factor priority set to `["totp", "push", "webauthn"]` instead of webauthn-first
  **Why:** free-tier Okta doesn't allow 2FA-at-the-door grant, must use admin factor verify path

## Ruled Out
- **Approach:** directly call `/api/v1/authn/factors/:id/verify`
  **Reason:** `400 Bad Request: missing required field 'transactionId'`
- **Approach:** remove webauthn factor
  **Reason:** `TestExistingWebauthnUsers FAIL: factor not found in user.factors`
- **Approach:** use `policy.factors.totp.required` Okta API field
  **Reason:** `404 Not Found: field does not exist on free-tier Okta`

## Key References
- Commit `84096545` (squashed L16 wave)
- `backend/controller/authn/step-up.go:142` (factor priority array)
- `backend/controller/authn/tests/step_up_test.go:88` (status="success" check)
- `tests/e2e/step_up_totp_test.go:63` (failing assert)
- Spec C `docs/api/Spec_C_Local_IAM_ENDUser_First.md` row L16

## Open Tasks
- [in_progress] #198 — L8 deep review: Codex adversarial
- [in_progress] #199 — L9 deep review: Codex adversarial
- [in_progress] #200 — L9.5 deep review: Codex adversarial
- [pending] L17 docs: CLAUDE.md auth section + deploy/local-mode/README.md

## Constraints
- Use `OktaDirectAuthProvider` admin factor verify path, not OAuth2 step-up
  **Source:** free-tier Okta rejected 2FA-at-the-door, three attempts all failed (see Ruled Out #1)
- Codex external CLI requires explicit authorization before Claude can invoke
  **Source:** denial reason: "vague reference, not specific authorization"

## Next Action
Write e2e test `tests/e2e/step_up_totp_test.go`, referencing existing `step_up_webauthn_test.go`, simulating new user first login triggering totp challenge → verify → ContinueAuth flow.
````

### 5.3 Trigger Point

Only PreCompact hook (`matcher: "auto"`) produces this format. Manual `/compact` does not trigger. `/clear` does not trigger.

---

## 6. Manually Setting the Context Limit (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`)

### 6.1 Why Set It Manually

Claude Code v2.1.117+ aligns Opus 4.7 session auto-compact default to ~1M window, effectively **disabling this safety net** — by the time it fires, you're deep in the degradation zone.

**Dual motivation:**
- **Quality:** §1.1 three studies empirically show 1M-window recall deteriorates past 250–300K; waiting for ~1M auto-compact means already past the degradation zone
- **Latency:** §1.4 cold prefill latency at 1M is 60–90s TTFT; even with cache hit, cold restart at 500K is 30s+. Manual 320K setting pulls auto-compact to the "degradation edge + performance tolerable" intersection

(After 2026/3/13, Opus/Sonnet 4.6 have no long-context premium, so **this is now a quality and performance issue, not a cost issue**. For pre-4.6 models, it remains a cost issue too.)

### 6.2 Configuration

`~/.claude/settings.json` `env` block:

```json
{
  "env": {
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "320000"
  }
}
```

### 6.3 Why 320000

| Candidate | Result |
|---|---|
| 200000 | Overlaps with proactive `/compact` zone, produces mid-task auto-compact, signature/decision lossy |
| **320000** | ✅ Auto-compact fires at ~300–320K, just past 250K redline, not yet in 400K degradation zone |
| 500000+ | Too late, entering degradation zone before triggering, can't rescue |

320000 is the "proactive miss → auto fallback" reasonable trigger point.

---

## 7. Implementation

### 7.1 Plugin-Based Architecture

The PreCompact and PostCompact hooks are now packaged as the `claude-compact` plugin at `/Users/arthur/Workdir/claude-compact/`. Plugin structure:

```
claude-compact/
├── .claude-plugin/plugin.json
├── hooks/
│   ├── hooks.json
│   ├── pre-compact.mjs
│   └── post-compact.mjs
├── bin/
│   └── claude-compact
└── README.md
```

Hooks are declared in `hooks/hooks.json` and auto-registered by Claude Code's plugin system. No manual `settings.json` hook configuration needed — plugin hooks merge with user hooks automatically.

**CLAUDE_CODE_AUTO_COMPACT_WINDOW** is set to `320000` in `~/.claude/settings.json` env block (not in the plugin manifest, since plugin env support is platform-dependent).

### 7.2 `pre-compact.mjs` (Design Highlights)

> Full source too long (~550 lines) to inline. Canonical version at `hooks/pre-compact.mjs`. This section lists design highlights only.

**Dual-path model:**
- **Path A (preferred):** Pre-digest JSONL transcript (cap 80K chars) → pipe digest + HANDOFF_INSTRUCTION to `claude -p --model claude-sonnet-4-6` (cost cap $1.50, internal 90s timer). Sonnet returns schema 6-section HANDOFF
- **Path B (fallback):** Sonnet timeout / non-zero exit / empty stdout / output < 200 chars — any of these → degrade to mechanical extract (pure transcript dump)
- **Always `exit 0`** — never block compaction

**Hook-side ground truth (not through LLM):**
```js
// gatherEnvState(cwd) — runs these git commands, failure of any one doesn't poison others
git rev-parse --abbrev-ref HEAD       // branch
git rev-parse --short HEAD            // head
git rev-parse --abbrev-ref @{u}       // upstream
git rev-list --count @{u}..HEAD       // ahead
git rev-list --count HEAD..@{u}       // behind
git status --porcelain                // dirty files (cap 50 lines)

// lastFailedBash(lines) — pairs tool_use ↔ tool_result from transcript,
// finds the last Bash with is_error: true, injects verbatim error string
```

Written as YAML frontmatter at the top of HANDOFF.

**parseTranscript captured events:**

| Event | Use |
|---|---|
| `user` text (filter `<system-reminder>` / `<command-`) | First-5 + last-45 dual-end preservation |
| `assistant` text | Last 20 turns |
| `tool_use` `Edit` / `Write` / `NotebookEdit` | File edit map (deduplicated) |
| `tool_use` `TodoWrite` | Latest todo snapshot |
| `tool_use` `TaskCreate` / `TaskUpdate` / `TaskStop` / `TaskList` | Task event sequence (added 2026-05-04; previously only TodoWrite) |

**HANDOFF_INSTRUCTION (to Sonnet)** — enforces schema, explicitly orthogonal to auto-compact:
- Mandatory sections: Decisions / Ruled Out / Key References / Open Tasks / Constraints / Next Action (format per §5.1)
- Forbidden items: TL;DR / Active Hypothesis / Files Touched (already covered by auto-compact summary)
- Verbatim enforcement: error strings / SHAs / file:line / external IDs must not be paraphrased
- Total word cap: 600

### 7.3 `post-compact.mjs` (Added 2026-05-04)

PostCompact hook receives stdin JSON, reads cwd, finds the newest `HANDOFF-*.md` in `<cwd>/.claude/` (single source since 2026-05-05; no more `HANDOFF.md` primary file). **Does not paste the entire file**, only extracts:
- Full YAML frontmatter (env-state ground truth)
- 4 H2 sections: `Decisions` / `Ruled Out` / `Constraints` / `Next Action`

Adds a line "full file at `<path>`, Read it if you need Key References / Open Tasks" then injects as `additionalContext`. Remaining sections (`Key References` / `Open Tasks`) become Letta-style archival memory (on disk, on-demand, not consuming working memory).

Full source: `hooks/post-compact.mjs` (~110 lines).

### 7.4 Deployment

```bash
# 1. Install the plugin
/plugin marketplace add /Users/arthur/Workdir/claude-compact
/plugin install claude-compact

# 2. Verify CLAUDE_CODE_AUTO_COMPACT_WINDOW is set
jq '.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW' ~/.claude/settings.json
# → "320000"

# 3. (Optional) Add claude-compact CLI to PATH
ln -s /Users/arthur/Workdir/claude-compact/bin/claude-compact ~/.local/bin/claude-compact

# 4. Restart Claude Code session
```

Optional env vars:
- `LOCUS_PRECOMPACT_KEEP=N` — how many old `HANDOFF-*.md` files to keep (default 5)
- `LOCUS_PRECOMPACT_FORCE_FALLBACK=1` — skip Sonnet, go directly to mechanical extract (local testing)

### 7.5 Design Rationale

**Why Sonnet 4.6, not Opus:**
- Opus for PreCompact is too expensive; this is "retroactively produce a summary," doesn't need top-tier intelligence
- Sonnet 4.6 on 80K digest reliably produces 6-section HANDOFF (13–21s wall-clock)
- $1.50 cost cap + 90s timeout dual brake

**Why pre-digest the transcript instead of feeding raw JSONL:**
- Raw JSONL is routinely multiple MB, feeding it directly blows up Sonnet input
- Node pre-filters: user/assistant text, tool_use limited to Edit/Write/NotebookEdit/TodoWrite/Task*, system-reminder noise filtered
- 80K char cap keeps Sonnet input in controllable range

**Why a mechanical fallback:**
- Sonnet may timeout, `claude` binary may not exist, quota may be exhausted
- Mechanical directly dumps last 30 user messages / 50 file touches / TodoWrite snapshot from transcript
- Ugly but lifesaving, **never blocks compaction** (`exit 0` always guaranteed)

**Why `matcher: "auto"`:**
- Manual `/compact` means the user is actively operating — shouldn't add 90s Sonnet digest delay
- Limiting to auto means the hook only acts on "unavoidable compaction" fallback, doesn't affect user-driven flow
- Side effect: manual `/compact` leaves no HANDOFF. To preserve schema state, must wait for auto-compact trigger, or run `/compact` and accept no HANDOFF

**Why the transcript-empty early-exit guard:**
- ES module `import()` executes top-level IIFE; any tool doing "syntax check on .mjs" would inadvertently trigger the hook
- Without a real transcript, it would waste a Sonnet call and write `HANDOFF-unknown.md` (content: Sonnet confabulating from git branch name)
- Guard conditions: `transcript_path` empty / file nonexistent / 0 bytes — any true → `exit 0`, no write, no Sonnet call

---

## 8. Companion: context-mode Plugin (Source Reduction)

The HANDOFF mechanism solves "context preservation before and after degradation," but **the most effective context management is keeping garbage out in the first place**. We pair with `context-mode` plugin for source-level filtering.

### 8.1 What It Solves

Bash / WebFetch / Read tool raw output floods the context window:
- `git log` thousands of lines
- Web fetch entire HTML pages
- Test suite full stdout
- Large-file grep results

**Most of this is reference material, not decision substrate**, but it burns token budget toward the 250K redline.

### 8.2 How context-mode Works

Keeps raw output in a **sandbox** (SQLite + FTS5 index), only sends summary / query results into context:

| Tool | Use |
|---|---|
| `ctx_batch_execute(commands, queries)` | Run multiple shell commands → auto-index → query. One call replaces many Bash calls |
| `ctx_search(queries[])` | FTS5 search over indexed content, returns only relevant chunks |
| `ctx_execute(language, code)` / `ctx_execute_file` | Run analysis scripts in sandbox (API calls, log parsing, data processing), only stdout returns |
| `ctx_fetch_and_index(url)` | Replaces WebFetch; page content stays in sandbox, context only sees summary |

### 8.3 Measured Token Savings

Per `ctx_stats`:
- Large grep / log analysis: **70–90% context token savings**
- Documentation lookup (library docs): **60–80% savings**
- Within-session repeated calls reuse the index, compounding benefits

### 8.4 Integration with HANDOFF Mechanism

| Defense | Role |
|---|---|
| **L0 context-mode** (this section) | **Source reduction** — keep raw output out of context |
| **L2 Stop hook** | Soft reminder: user considers `/compact` / `/clear` |
| **L3 PreCompact hook** | Auto-compact triggers → auto-write schema HANDOFF |

L0 is the most important and highest-ROI — one `ctx_batch_execute` replaces 10× Bash + Grep, extending session ceiling by multiples of workload.

### 8.5 Mandatory Usage Rules

Enforced by plugin's SessionStart-injected `<context_window_protection>` system prompt:

- `Bash` only for git / mkdir / rm / mv / navigation; commands producing >20 lines output must use `ctx_*`
- `Read` for files to be `Edit`ed; **analysis** use `ctx_execute_file`
- `WebFetch` forbidden → `ctx_fetch_and_index`
- File writes still use native `Write` / `Edit` (`ctx_execute*` is read-only)

---

## 9. `/compact` vs `/clear` Pairing

| Scenario | Use |
|---|---|
| Switch topics, old context not needed | `/clear` (clean, no inherited rot; but no HANDOFF fallback) |
| Same task dragging long, want to preserve schema state | `/compact` (triggers PreCompact path, Sonnet writes HANDOFF-{shortId}.md); can specify focus: `/compact focus on the API changes` |
| **Session turns > 80** | **Prefer `/clear`** — article empirically shows stale context **actively hurts** |

**Never `/compact` mid-task** — exact signatures and decision rationale get lossy-compressed. Finish the current unit of work first.

> Note: settings.json `matcher: "auto"` means manual `/compact` does NOT trigger PreCompact hook, so no HANDOFF. To make manual `/compact` also write HANDOFF, change matcher to `""` (all triggers) — cost: user-driven `/compact` gets 90s extra delay.

### 9.1 `/clear` Is Stronger Than You Think

Article quote (Claude Code Camp, same source as §1.3/§1.4):

> "Long sessions where you'd benefit from a fresh start anyway. After 80+ turns, the model often benefits from a clean slate. **Stale context from early turns can actively hurt.** The model wastes attention on irrelevant early exploration instead of focusing on the current task."
>
> "**A /clear + fresh start is often better than both compaction and 1M context.**"

Key is "actively hurts" — not just neutral, **old context in the degradation zone steals attention**, causing the model to be distracted when processing the current task. Long sessions aren't "use it while you can" — they're "dragging on makes it worse."

**Implementation implications:**
- 80+ turns should be treated as a signal to `/clear` (regardless of token count) — but `/clear` has no HANDOFF; to preserve schema state, use `/compact` instead
- After `/clear`, all cache invalidates, must re-prefill — but **re-prefilling 80K of fresh context is faster and more accurate than continuing with 500K of stale context** (§1.4 latency data supports this)
- 1M is not the solution for long sessions — fresh start is better

### 9.2 "Dump-and-Clear" Pattern with Subagents

The article's recommended context management triad:

1. **Intentional `/clear` boundaries** — proactively clear at task switches, don't wait for forced compaction
2. **Subagents for exploration** — long-running exploration tasks go to subagents, only answers return, not raw output (aligned with L0 context-mode in this spec)
3. **Dump-and-clear pattern** — at subtask end, dump conclusions to commit message / scratchpad, then clear the main session, maintaining small context, warm cache, low cost

These three + L0/L2/L3 defense layers form a complete context economy.

---

## 10. Validation

24-case test suite (local) covers:

- Multiple `KEEP` values for pruning
- Same-session repeat fire (overwrite, no accumulation)
- Concurrent fire (multi-session same repo, session ID isolation)
- `session_id` with special characters / missing → fallback to `unknown`
- Manual `/compact` not triggering (matcher filter verified)
- `claude` binary failure → mechanical fallback
- Real Sonnet end-to-end (13–21s wall, 6 sections including semantic ruled-out)
- **Transcript-empty early-exit guard** (empty stdin / missing path / non-existent file / 0-byte file — 4 scenarios)

All pass.

---

## 11. Flow Quick Reference

```
[L0 continuously active] context-mode plugin filters all raw output
  - Bash only for git/mkdir/rm/mv; >20 line output uses ctx_*
  - WebFetch → ctx_fetch_and_index
  - Large grep / log uses ctx_execute
  ↓
Working (tokens accumulating)
  ↓
[Checkpoints] git commit / subagent return / multi-tool-call / /context
  ↓
  <150K?     → continue
  150–250K?  → next clean boundary /compact (triggers PreCompact, writes HANDOFF)
  >250K?     → immediately wrap up → /compact (preserve schema state) or /clear (clean restart, no HANDOFF)
  >400K?     → /clear restart; to preserve state, /compact first then /clear
  ↓
[L2 Soft Reminder] Stop hook emits [CONTEXT] warning at >150K / >250K (if deployed)
  ↓
[L3 Hard Fallback] auto-compact fires at ~320K
  (because CLAUDE_CODE_AUTO_COMPACT_WINDOW=320000 is manually set)
  ↓
PreCompact hook activates (matcher: "auto"):
  ↓ Path A: Sonnet 4.6 pre-digests transcript → 6-section schema HANDOFF
  ↓ Path B (on failure): mechanical extract from transcript dump
  ↓
Writes to .claude/HANDOFF-{shortId}.md
  ↓
Auto-compact executes
  ↓
PostCompact hook activates:
  Injects HANDOFF frontmatter + Decisions/Ruled Out/Constraints/Next Action into new context
  ↓
==== New session / compacted session begins ====
  ↓
[Restart Protocol] PostCompact has injected 4 sections + frontmatter:
  1. Verify frontmatter env-state (branch / dirty files) matches current reality
  2. For more schema state (Key References / Open Tasks), cat .claude/HANDOFF-*.md
  3. No HANDOFF at all (after /clear) → reconstruct from git log + uncommitted changes
  ↓
Read complete before starting next user request
```

---

## 12. Failure Modes and Recovery

The mechanism is not infallible. Common failure scenarios and responses:

| Scenario | Detection | Recovery |
|---|---|---|
| **Multiple HANDOFF-{*}.md conflict** (multi-session same repo) | `ls -t HANDOFF-*.md` to see chronological order | Take newest; old ones cleaned by prune mechanism (`KEEP=5`) |
| **Sonnet returned <200 chars / empty / garbage** | HANDOFF file header HTML comment says `Sonnet path failed: exit=N len=M` | Script already auto-degraded to mechanical fallback, content still salvageable; if even mechanical is broken, manually extract from transcript |
| **`claude` binary not in PATH (headless fails)** | HTML comment `spawn-throw: ...` | Verify PATH includes `claude` CLI; workaround: pure mechanical (`LOCUS_PRECOMPACT_FORCE_FALLBACK=1`) |
| **PreCompact hook timeout (>120s)** | settings.json `timeout` limit hit | Internal 90s timer should trigger degradation first; if still times out, degrade to pure mechanical |
| **PostCompact didn't inject** | New session doesn't show HANDOFF 4-section summary | Check PostCompact hook registration; on hook failure, manually `cat .claude/HANDOFF-*.md` |
| **Auto-compact fired but no HANDOFF-{*}.md written** | `.claude/` has no new HANDOFF-*.md | Check hook registration (§7.5); possibly PreCompact not mounted, permissions issue, or script syntax error |
| **After `/clear`, no HANDOFF at all** | Expected behavior — `/clear` doesn't trigger PreCompact | To preserve state, use `/compact` instead; after `/clear`, reconstruct from git log + current dirty files |
| **HANDOFF-*.md accidentally committed to git** | Appears in `git status` | `.claude/` is usually gitignored; if not, add to `.gitignore` |

### 12.1 Success Metrics

If working correctly:
- After auto-compact, the new session's first turn won't ask "what were we doing" (because PostCompact injected schema state)
- `ctx_stats` shows context-mode saving 60%+ tokens
- In a week, need to reconstruct context from git log fewer than once

If failing:
- After restart, Claude re-does already-ruled-out approaches → possible PreCompact Sonnet path failure, HANDOFF Ruled Out section empty, PostCompact didn't extract that section
- ctx_stats savings < 30% → context-mode not correctly used, raw output still flooding in
- After `/clear` topic switch, frequently chasing old bugs from scratch → should use `/compact` to preserve schema state instead

---

## 13. Key Takeaways

1. **Context degradation is a function of absolute token count, not percentage** — Anthropic official [MRCR v2](https://www.anthropic.com/news/claude-opus-4-6) data: Opus 4.6 at 1M only 76%, Sonnet 4.5 only 18.5% (§1.1.1 primary data); [Chroma Context Rot](https://research.trychroma.com/context-rot) 18 models all affected; [NoLiMa](https://arxiv.org/abs/2502.05167) 11/13 models halve at 32K (§1.1.2/1.1.3 corroboration). Don't use the 60% heuristic
2. **`/compact` is lossy, ruled-out reasoning is the first to go** — PreCompact hook writing HANDOFF is the only way to preserve it
3. **Three defense layers (single-track since 2026-05-05):** L0 context-mode source reduction → L2 Stop hook soft reminder (optional) → L3 PreCompact hook + `CLAUDE_CODE_AUTO_COMPACT_WINDOW=320000` auto fallback
4. **Manually setting context limit is mandatory:** Claude Code v2.1.117+ defaults to ~1M = effectively disabling the safety net; set to 320000 to pull it back
5. **context-mode is the single highest-ROI tool:** Large raw output stays in sandbox, only summary enters context, measured 60–90% savings
6. **`/clear` is both a quality and performance strategy** — [Claude Code Camp measured](https://www.claudecodecamp.com/p/claude-code-1m-context-window): 500K cold prefill 30s+, 1M 60–90s; after fresh start, TTFT back to <2s
7. **80+ turns of stale context actively hurts** — not "use it while you can"; dragging on makes it worse; but `/clear` has no HANDOFF, use `/compact` to preserve state
8. **Lost-in-the-middle:** Critical info goes at context beginning or end, middle attention is weak; HANDOFF Next Action stays at the end to exploit end attention
9. **First action after restart:** Under auto-compact, PostCompact has injected 4 sections + frontmatter; verify frontmatter env-state matches current reality first; if insufficient, `cat .claude/HANDOFF-*.md`
10. **HANDOFF ≠ auto-compact summary** — the two must be orthogonally divided (since 2026-05-04): compact owns narrative, HANDOFF owns schema state (SHAs / file:line / verbatim errors / env-state). Duplication triggers task interference and lost-in-the-middle dual degradation
11. **`claude-compact` CLI is an observation tool for both summaries** — `claude-compact -d` quantifies overlap between the two files; score > 10 = schema discipline degradation warning (§14)
12. **`claude-mem` is cross-session episodic memory** — HANDOFF solves "**this** session's handoff," claude-mem solves "**weeks ago in another repo** how did we handle X." `mem-search` replaces "hunting through git log for the last solution," cross-temporal recall (§16)

---

## 14. Observation & Diagnostics: `claude-compact` CLI

The CLI tool `bin/claude-compact` (symlinked to `~/.local/bin/claude-compact` or `~/.local/bin/plugin-compact`) provides external visibility into the dual summaries (compact summary + HANDOFF) and quantifies their overlap. **Read-only, never modifies any file.**

### 14.1 Path Resolution

Converts current `$PWD` to a transcript directory name using Claude Code's slug rule (non-alphanumeric → `-`), e.g.:

```
$PWD = /Users/arthur/Workdir/locus-locus/.worktrees/local-iam
slug  = -Users-arthur-Workdir-locus-locus--worktrees-local-iam
transcript dir = ~/.claude/projects/<slug>/
```

Finds the newest jsonl with `isCompactSummary: true` entries in that directory; then resolves the handoff path from the most recent `.cwd` field in the jsonl (`<cwd>/.claude/HANDOFF-<sid first 8>.md`).

### 14.2 Common Commands

```bash
claude-compact          # Default: print last compact summary + handoff for newest session in current cwd
claude-compact -C       # Compact summary only (message.content of isCompactSummary entries in jsonl)
claude-compact -H       # Handoff file only
claude-compact -n 3     # Last 3 compact summaries (observe compression history)
claude-compact -a       # ALL compact summaries for the session (full chronology)
claude-compact -l       # List all sessions in current cwd that have compact summaries (count + filename)
claude-compact -s SID   # Target a specific session ID (filename prefix from -l output)
claude-compact -p       # Print jsonl path only (for pipe / cat / less)
claude-compact -d       # Overlap diagnostic: quantify semantic redundancy between compact and handoff
claude-compact -h       # Help
```

### 14.3 Meaning of `-d` Overlap Diagnostic

Research shows semantically overlapping summaries trigger task interference. But "overlap" is hard to judge by eye, so `-d` uses a 6-word sliding window comparison:

```
=== Overlap diagnostic (handoff vs compact summary) ===
compact chars (normalized): 289087
handoff chars (raw):        3060

FULL overlap (handoff line wholly in compact): 0
PARTIAL overlap (6-word window match):    0

Heuristic redundancy score: 0.0
  (≤2 = good orthogonality; ≥10 = schema discipline slipping)
```

- **FULL overlap** = entire handoff line appears verbatim in compact summary → strong signal: that line is already in compact
- **PARTIAL overlap** = 6 consecutive words from handoff appear in compact → weak signal: could be shared vocabulary, could be real duplication
- **Heuristic redundancy score** = `len(FULL) + 0.5 × len(PARTIAL)`, >10 means the hook's schema instruction has broken down, check HANDOFF_INSTRUCTION

### 14.4 Use: Ongoing Validation for This Spec

Treat `claude-compact -d` as a regression test for schema discipline: every time you modify `pre-compact.mjs`'s HANDOFF_INSTRUCTION, wait for the next auto-compact trigger, then run `-d` to check the score. If the score significantly rises, the prompt change made the LLM start repeating compact content again.

Also usable for debugging individual sessions — if after restart Claude behaves oddly (re-doing things everywhere), run `-d` first to see if the two summaries are interfering with each other.

---

## 15. Future Work: Evaluation Hook (P2.5, Under Design Discussion)

### 15.1 Motivation

[Zylos AI Agent Context Compression](https://zylos.ai/research/2026-02-28-ai-agent-context-compression-strategies) proposes "ACON paired-trajectory": after each compaction, run a micro-eval to test whether the compressed context can still answer key questions; on failure, trigger re-expansion (load more original details).

Corresponding to this spec: **there is currently no closed-loop validation** — we don't know whether the PreCompact hook's schema HANDOFF truly enables the next session to pick up seamlessly. Failure modes can only be inferred retroactively from "Claude is re-doing ruled-out approaches."

### 15.2 Design Draft

```
SessionStart hook
  → Extract 3 micro-eval questions from HANDOFF.md:
    Q1: What was the previous session's Next Action?
    Q2: Which approaches have been ruled out?
    Q3: What caused the last Bash failure?
  → Run these 3 questions with Sonnet headless on the just-injected context
  → Compare answers vs HANDOFF corresponding fields' verbatim content
  → Any question fails → re-inject the full HANDOFF (instead of schema slice)
                         + write failed questions to .claude/HANDOFF-eval.log for ongoing calibration
```

### 15.3 Design Questions to Resolve

1. **Trigger point:** SessionStart? PostCompact? Both?
   - SessionStart covers all resume scenarios (including non-compact), but running Sonnet eval delays the first prompt response
   - PostCompact is lighter (only runs after compact), but misses manual `/clear` restart scenarios
2. **Who runs the eval:** Headless Sonnet (cost) vs pure rule-based matching (fast but misses semantic drift)
3. **Failure action:** Re-injecting the full HANDOFF inversely consumes context window, requires trade-off
4. **False positive rate:** What prompt for Q1/Q2/Q3 avoids treating "Claude used different wording" as failure? Need to design an oracle comparison strategy (verbatim grep + semantic similarity dual threshold?)
5. **Relationship with §14 `-d` overlap diagnostic:** Eval is a quality metric, `-d` is a redundancy metric — different dimensions, but combinable into a health dashboard

### 15.4 Blockers Before Adoption

- Running Sonnet eval costs ~2–3s each time; is adding this delay to SessionStart worth it?
- HANDOFF schema hasn't run across many real sessions yet; collect baseline first, then add eval
- The failure re-injection strategy needs alignment with PostCompact hook design

**Conclusion:** **Run the schema-orthogonal design for 1–2 weeks, continuously observe with `claude-compact -d`, collect sufficient baseline, then decide whether to build the evaluation hook.**

If during this observation period "Claude re-does ruled-out approaches" decreases significantly, evaluation hook priority drops — because schema-ization itself has shifted the problem from "compression loss" to "prompt failure," the latter being easier to point-fix.

---

## 16. Cross-Session Persistence: `claude-mem` Plugin

### 16.1 What It Solves

§8 `context-mode` is **within-session source reduction**; HANDOFF (§3 / §7) is **session-boundary context handoff**. But both live within a "single session lifecycle" — once you cross repos / topics / return to the same task two weeks later, both are useless.

`claude-mem` ([thedotmack/claude-mem](https://github.com/thedotmack/claude-mem), v12.4.9, AGPL-3.0) fills this layer: **cross-session episodic memory**. It runs a background worker service, observes every tool call and prompt, writes "observations worth remembering" into a local SQLite knowledge base, retrievable by any future session via `mem-search`.

### 16.2 Architecture

```
[Primary session]
  ↓ PostToolUse:* / UserPromptSubmit / PreToolUse:Read
worker-service.cjs (background, persistent)
  ↓ wraps tool call + result as <observed_from_primary_session> XML
[Observer sub-session]
  ← another Claude running in ~/.claude/projects/-Users-arthur--claude-mem-observer-sessions/
  → judges each observation: is this worth remembering?
  → if yes, outputs <observation>...</observation> written to persistent KB
[Persistent KB]
  ↓ SessionStart (matcher: startup|clear|compact)
worker-service hook injects claude-code context
  ↓ injects relevant historical context into new session
[New primary session starts with historical context]
```

Field measurement: local `~/.claude/projects/-Users-arthur--claude-mem-observer-sessions/` has accumulated 122 observer session jsonls.

### 16.3 Installed Hooks (Auto-Registered by Plugin)

| Hook | Matcher | Purpose |
|---|---|---|
| `Setup` | `*` | smart-install.js ensures worker / dependencies ready |
| `SessionStart` | `startup\|clear\|compact` | Start worker + inject cross-session historical context |
| `UserPromptSubmit` | (all) | session-init notification to worker: new prompt |
| `PostToolUse` | `*` | Observation: each tool call result sent to observer for evaluation |
| `PreToolUse` | `Read` | File-context: inject past memories about that file before reading |
| `Stop` | (all) | Wrap-up observation |

### 16.4 Role Division with This Spec's Mechanisms

| Layer | Mechanism | Time Scale | Content Type |
|---|---|---|---|
| **L0** | `context-mode` plugin (§8) | within-session | Raw output stays in sandbox, only summary returns |
| **L2 / L3** | Stop hook + HANDOFF auto path (§3 / §7) | session boundary | Current task's schema state (current cwd) |
| **L4 (new)** | `claude-mem` plugin (this section) | cross-session, cross-cwd, permanent | Episodic observations accumulated across all past sessions |

**Complementary, not overlapping:**
- HANDOFF solves "**this** session's ruled-out / decisions / next action" (high fidelity, immediate handoff)
- claude-mem solves "**weeks ago in another repo** how did we handle problem X" (fuzzy retrieval, cross-temporal recall)
- HANDOFF is working memory (must-read); claude-mem is long-term memory (query-based access)

### 16.5 Useful Commands

| Command | Purpose |
|---|---|
| `mem-search` skill | Ask "how did we handle X before," "what was the solution to last week's bug" |
| `knowledge-agent` skill | Build topic knowledge bases from observation history (e.g., "all my OAuth experience") |
| `pathfinder` skill | Map codebase into feature flowcharts, find duplicated concerns |
| `smart-explore` skill | Tree-sitter AST structural search (token-optimized, replaces raw Read) |
| `make-plan` / `do` skill | Use past experience to produce phased plans + dispatch subagents for execution |
| `timeline-report` skill | Produce narrative reports of a project's entire history |

### 16.6 Known Interactions / Caveats

1. **AGENTS.md auto-injection:** claude-mem injects `AGENTS.md` into context as agent behavior hints. **Before commit, must `git checkout AGENTS.md` to discard this injection** (already marked as a fixed step in the user's commit workflow, per this session's ruled-out record).
2. **Observer sessions count toward transcript directories:** `~/.claude/projects/-Users-arthur--claude-mem-observer-sessions/` sits alongside regular cwd-slug directories, but `claude-compact` CLI won't treat it as a main session — observer sessions have no user-facing compact flow.
3. **Relationship with PreCompact hook:** claude-mem observes hooks running at PostToolUse; PreCompact hook runs before compact. The two **don't conflict** (different events, different workers), but HANDOFF written by PreCompact will also be observed by claude-mem and enter the KB — meaning HANDOFF content also becomes part of long-term memory.
4. **`/ctx-purge` doesn't affect claude-mem KB:** context-mode's purge doesn't touch claude-mem's SQLite. To clear claude-mem's own memories, use its plugin command (if available) or directly delete the KB file.

### 16.7 Quick Reference: Which to Use When

| Scenario | Use |
|---|---|
| "What were we doing before the auto-compact THIS session" | PostCompact has injected schema state; if insufficient, `claude-compact -H` or `cat .claude/HANDOFF-*.md` (L3) |
| "Keep raw output from eating tokens" | `ctx_*` tools (L0 context-mode) |
| "Two weeks ago in another repo, how did we solve X" | `mem-search` (L4 claude-mem) |
| "Compile all my auth-related experience" | `knowledge-agent` (L4 claude-mem) |
| "Explore new codebase structure" | `smart-explore` (L4 claude-mem, tree-sitter) |
