#!/usr/bin/env node
// PreCompact hook (matcher: "auto"): writes
// <cwd>/.claude/HANDOFF-<session>.md before auto-compaction so the next
// session can resume without losing semantic state.
//
// Path A (preferred): pre-digest the JSONL transcript in Node (cap ~80k chars),
// pipe digest+instruction to `claude -p --model claude-sonnet-4-6` (cost cap
// $1.50, internal 90s timeout). Sonnet returns a structured HANDOFF.
// Path B (fallback): on timeout / non-zero exit / empty stdout, emit a
// mechanical extract from the transcript.
//
// Always exit 0 — never block compaction.

import { spawn, execSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, statSync,
  readdirSync, unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const HEADLESS_TIMEOUT_MS = 90_000;
const DIGEST_CHAR_CAP = 80_000;
const CLAUDE_MD_CHAR_CAP = 12_000;
const FALLBACK_USER_MSG_COUNT = 30;
const FALLBACK_FILE_TOUCH_COUNT = 50;
const FALLBACK_ASSISTANT_TURN_COUNT = 20;
const SONNET_MIN_OUTPUT_CHARS = 200;
const KEEP_COUNT = Math.max(1, parseInt(process.env.LOCUS_PRECOMPACT_KEEP || '5', 10));
const HANDOFF_PATTERN = /^HANDOFF-[A-Za-z0-9]{1,16}\.md$/;

const RESUME_BANNER = '> Schema handoff (orthogonal to auto-compact summary). Both will be in context — treat as additive, not duplicative. The compact summary owns narrative; this file owns structured state. Verify env-state in frontmatter (branch, dirty files) matches reality before acting.';

const HANDOFF_INSTRUCTION = `You are producing the structured-state half of a two-part handoff. The narrative half is Claude Code's auto-compact summary (in-context, not yours to write). Your output is OUT-OF-BAND, schema-first, and MUST be ORTHOGONAL to that narrative — do NOT replicate the timeline, code snippets, file lists, or "what happened" prose.

The DIGEST below contains: (1) the project's CLAUDE.md (durable rules — honor but do NOT echo back); (2) extracted user messages (first-N + last-N preserved), recent assistant text, file edits, latest TodoWrite snapshot, AND Task tool events (TaskCreate/TaskUpdate/TaskStop/TaskList).

Output markdown only, no preamble. Total under 600 words. Use these sections EXACTLY (omit a section ONLY if truly empty after honest effort):

## Decisions
What was decided this session AND the rationale. Format:
- **Decision:** <one line>
  **Why:** <reason, including alternatives weighed>

## Ruled Out
Approaches tried and abandoned. Preserve VERBATIM error strings / denial reasons / failure messages — do not paraphrase, paraphrasing destroys grep-ability and causes the next session to retry the same failure. Format:
- **Approach:** <what was attempted>
  **Reason:** <verbatim error or quoted denial>

## Key References
Verbatim identifiers the next session will grep for. Bullets, no narrative. Include all of:
- Commit SHAs (full or short, e.g. \`a8293c07\`)
- file:line references discussed (e.g. \`enroll.go:168\`)
- External IDs (PR numbers, ticket IDs, task IDs like \`#198\`)
- API paths / function names central to the work

## Open Tasks
In-progress items from BOTH the TodoWrite snapshot AND the Task tool events. Format:
- [<status>] [<id-if-any>] <description>
"(none)" if the session tracked nothing.

## Constraints
Repo-specific rules surfaced THIS session (not generic CLAUDE.md content). Format:
- <rule>
  **Source:** <how it was learned — denial / explicit user statement / failed attempt>

## Next Action
ONE line. The single most actionable next step. Not a paragraph.

Rules:
- Do NOT include TL;DR — the auto-compact summary IS the TL;DR.
- Do NOT include an "Active Hypothesis" or narrative section — that lives in the auto-compact summary.
- Do NOT list every file touched — files only appear in Key References (with line numbers), not in a separate dump.
- Do NOT echo CLAUDE.md.
- Preserve error strings, SHAs, file:line refs VERBATIM.

CRITICAL: this handoff complements the auto-compact summary; both will be in context. Repetition triggers task interference (ACL 2024 EMNLP) and lost-in-the-middle. Keep yours strictly schema, strictly orthogonal.`;

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function shortSessionId(rawId) {
  const cleaned = String(rawId || '').replace(/[^A-Za-z0-9]/g, '');
  return (cleaned || 'unknown').slice(0, 8);
}

function ensureHandoffDir(cwd) {
  const dir = join(cwd, '.claude');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Walk up from cwd looking for CLAUDE.md. Stops at filesystem root or after a
// reasonable depth. Returns { path, content } or null. Content is capped.
function findProjectClaudeMd(cwd) {
  let dir = cwd;
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'CLAUDE.md');
    if (existsSync(candidate)) {
      try {
        let content = readFileSync(candidate, 'utf8');
        if (content.length > CLAUDE_MD_CHAR_CAP) {
          content = content.slice(0, CLAUDE_MD_CHAR_CAP) + '\n\n[...CLAUDE.md truncated to fit cap...]';
        }
        return { path: candidate, content };
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return null;
}

function pruneOldHandoffs(dir, currentName) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  const others = [];
  for (const name of entries) {
    if (name === currentName) continue;
    if (!HANDOFF_PATTERN.test(name)) continue;
    try {
      const s = statSync(join(dir, name));
      others.push([name, s.mtimeMs]);
    } catch {}
  }
  // Newest first; keep KEEP_COUNT-1 others (current session's file = the +1).
  others.sort((a, b) => b[1] - a[1]);
  for (const [name] of others.slice(KEEP_COUNT - 1)) {
    try { unlinkSync(join(dir, name)); } catch {}
  }
}

function readJsonlLines(path) {
  if (!path || !existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join(' ');
}

function parseTranscript(lines) {
  const userMsgs = [];
  const assistantTurns = [];
  const fileTouches = new Map();
  const taskEvents = [];
  let lastTodos = null;

  for (const line of lines) {
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (!evt || typeof evt !== 'object') continue;

    if (evt.type === 'user' && evt.message?.content) {
      const text = extractText(evt.message.content).trim();
      if (text && !text.startsWith('<system-reminder>') && !text.startsWith('<command-')) {
        userMsgs.push(text);
      }
    }

    if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
      const textParts = [];
      for (const part of evt.message.content) {
        if (!part) continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          textParts.push(part.text);
        } else if (part.type === 'tool_use') {
          const name = part.name;
          const input = part.input || {};
          if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
            const fp = input.file_path;
            if (typeof fp === 'string') fileTouches.set(fp, name);
          } else if (name === 'TodoWrite') {
            if (Array.isArray(input.todos)) lastTodos = input.todos;
          } else if (name === 'TaskCreate' || name === 'TaskUpdate' || name === 'TaskStop' || name === 'TaskList') {
            taskEvents.push({
              type: name,
              subject: typeof input.subject === 'string' ? input.subject.slice(0, 200) : '',
              description: typeof input.description === 'string' ? input.description.slice(0, 200) : '',
              taskId: input.taskId || '',
              status: input.status || '',
            });
          }
        }
      }
      const joined = textParts.join('\n').trim();
      if (joined) assistantTurns.push(joined);
    }
  }

  return { userMsgs, assistantTurns, fileTouches, lastTodos, taskEvents };
}

// Walk transcript in order, find the most recent Bash tool_use that received
// a tool_result with is_error=true. Returns the original command, description,
// and the verbatim error text (capped). Used so the handoff frontmatter can
// surface the BLOCKER that ended the session — a class of info the LLM-side
// summary tends to paraphrase or drop entirely.
function lastFailedBash(lines) {
  const toolUseMap = new Map();
  let lastErr = null;
  for (const line of lines) {
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (!evt || typeof evt !== 'object') continue;

    if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
      for (const part of evt.message.content) {
        if (part?.type === 'tool_use' && part.name === 'Bash') {
          toolUseMap.set(part.id, {
            command: typeof part.input?.command === 'string' ? part.input.command.slice(0, 500) : '',
            description: typeof part.input?.description === 'string' ? part.input.description.slice(0, 200) : '',
          });
        }
      }
    }
    if (evt.type === 'user' && Array.isArray(evt.message?.content)) {
      for (const part of evt.message.content) {
        if (part?.type === 'tool_result' && part.is_error) {
          const tool = toolUseMap.get(part.tool_use_id);
          if (tool) {
            const errText = typeof part.content === 'string'
              ? part.content
              : JSON.stringify(part.content || '');
            lastErr = { ...tool, error: errText.slice(0, 800) };
          }
        }
      }
    }
  }
  return lastErr;
}

// Snapshot the on-disk git state. Pure facts — never goes through the LLM,
// so it can't be paraphrased or hallucinated. Each command isolated so a
// single failure (no upstream, etc.) doesn't poison the rest.
function gatherEnvState(cwd) {
  const safe = (cmd) => {
    try {
      return execSync(cmd, {
        cwd, encoding: 'utf8', timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { return ''; }
  };
  const branch = safe('git rev-parse --abbrev-ref HEAD');
  const head = safe('git rev-parse --short HEAD');
  const upstream = safe('git rev-parse --abbrev-ref @{u}');
  const ahead = upstream ? safe('git rev-list --count @{u}..HEAD') : '';
  const behind = upstream ? safe('git rev-list --count HEAD..@{u}') : '';
  const porcelain = safe('git status --porcelain');
  return {
    branch, head, upstream, ahead, behind,
    porcelain: porcelain ? porcelain.split('\n').slice(0, 50).join('\n') : '',
  };
}

function formatFrontmatter({ env, lastBashErr, sessionId, transcriptPath, generatedAt }) {
  const yamlStr = (v) => JSON.stringify(String(v));
  const lines = ['---'];
  lines.push(`session: ${yamlStr(sessionId)}`);
  lines.push(`generated_at: ${yamlStr(generatedAt)}`);
  lines.push(`transcript: ${yamlStr(transcriptPath)}`);
  lines.push('env:');
  if (env.branch) lines.push(`  branch: ${yamlStr(env.branch)}`);
  if (env.head) lines.push(`  head: ${yamlStr(env.head)}`);
  if (env.upstream) {
    lines.push(`  upstream: ${yamlStr(env.upstream)}`);
    lines.push(`  ahead: ${env.ahead || '0'}`);
    lines.push(`  behind: ${env.behind || '0'}`);
  }
  if (env.porcelain) {
    lines.push('  dirty_files: |');
    for (const l of env.porcelain.split('\n')) lines.push(`    ${l}`);
  } else {
    lines.push('  dirty_files: clean');
  }
  if (lastBashErr) {
    lines.push('last_failed_bash:');
    lines.push(`  command: ${yamlStr(lastBashErr.command)}`);
    if (lastBashErr.description) {
      lines.push(`  description: ${yamlStr(lastBashErr.description)}`);
    }
    lines.push('  error: |');
    for (const l of lastBashErr.error.split('\n').slice(0, 24)) {
      lines.push(`    ${l}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function buildDigest({ userMsgs, assistantTurns, fileTouches, lastTodos, taskEvents, claudeMd }) {
  // Preserve BOTH ends of the user-message stream: session intent usually
  // sits in the first messages, current focus in the last. Pure tail-only
  // slicing loses opening context on long transcripts.
  const FIRST_N = 5;
  const LAST_N = 45;
  const total = userMsgs.length;
  let earlyUser = [];
  let recentUser;
  if (total > FIRST_N + LAST_N) {
    earlyUser = userMsgs.slice(0, FIRST_N);
    recentUser = userMsgs.slice(-LAST_N);
  } else {
    recentUser = userMsgs;
  }
  const recentAssist = assistantTurns.slice(-FALLBACK_ASSISTANT_TURN_COUNT);
  const fileList = [...fileTouches.entries()];
  const openTodos = (lastTodos || []).filter((t) => t && t.status !== 'completed');
  const recentTaskEvents = (taskEvents || []).slice(-30);

  const sections = [];
  if (claudeMd) {
    sections.push(`## Project CLAUDE.md (${claudeMd.path})`);
    sections.push('');
    sections.push(claudeMd.content);
    sections.push('');
    sections.push('---');
    sections.push('');
  } else {
    sections.push('## Project CLAUDE.md');
    sections.push('(none found via upward walk from cwd)');
    sections.push('');
  }
  sections.push('# SESSION DIGEST (auto-extract)');
  sections.push('');
  if (earlyUser.length > 0) {
    sections.push(`## Earliest user messages (first ${earlyUser.length} of ${total})`);
    earlyUser.forEach((m, i) => {
      sections.push(`${i + 1}. ${m.replace(/\s+/g, ' ').slice(0, 600)}`);
    });
    sections.push('');
  }
  const recentLabel = earlyUser.length
    ? `last ${recentUser.length} of ${total}`
    : `all ${recentUser.length}`;
  sections.push(`## User messages (${recentLabel})`);
  recentUser.forEach((m, i) => {
    sections.push(`${i + 1}. ${m.replace(/\s+/g, ' ').slice(0, 600)}`);
  });
  sections.push('');
  sections.push(`## Assistant text turns (last ${recentAssist.length})`);
  recentAssist.forEach((m, i) => {
    sections.push(`### turn ${i + 1}`);
    sections.push(m.slice(0, 1200));
  });
  sections.push('');
  sections.push(`## File edits (${fileList.length})`);
  if (fileList.length === 0) sections.push('(none)');
  for (const [fp, op] of fileList) sections.push(`- ${op}: ${fp}`);
  sections.push('');
  sections.push(`## Latest TodoWrite snapshot (open=${openTodos.length})`);
  if (!lastTodos || lastTodos.length === 0) {
    sections.push('(no TodoWrite calls in transcript)');
  } else {
    for (const t of lastTodos) {
      sections.push(`- [${t.status || '?'}] ${t.content || t.activeForm || '(empty)'}`);
    }
  }
  sections.push('');
  sections.push(`## Task tool events (last ${recentTaskEvents.length} of ${(taskEvents || []).length})`);
  if (recentTaskEvents.length === 0) {
    sections.push('(no TaskCreate/TaskUpdate/TaskStop/TaskList calls in transcript)');
  } else {
    for (const ev of recentTaskEvents) {
      const sub = ev.subject || ev.description || '(empty)';
      const status = ev.status ? ` status=${ev.status}` : '';
      const id = ev.taskId ? ` id=${ev.taskId}` : '';
      sections.push(`- ${ev.type}${id}${status}: ${sub}`);
    }
  }

  let digest = sections.join('\n');
  if (digest.length > DIGEST_CHAR_CAP) {
    digest = digest.slice(0, DIGEST_CHAR_CAP) + '\n\n[...digest truncated to fit cap...]';
  }
  return digest;
}

function mechanicalHandoff(parsed, transcriptPath) {
  const { userMsgs, fileTouches, lastTodos } = parsed;
  const recentUser = userMsgs.slice(-FALLBACK_USER_MSG_COUNT);
  const fileList = [...fileTouches.entries()].slice(-FALLBACK_FILE_TOUCH_COUNT);
  const openTodos = (lastTodos || []).filter((t) => t && t.status !== 'completed');

  const out = [];
  out.push('# HANDOFF (mechanical fallback)');
  out.push('');
  out.push(`Generated by precompact-handoff.mjs after Sonnet path failed.`);
  out.push(`Transcript: ${transcriptPath}`);
  out.push('');
  out.push('## Open TodoWrite Items');
  if (openTodos.length === 0) {
    out.push('- (none)');
  } else {
    for (const t of openTodos) out.push(`- [${t.status}] ${t.content || t.activeForm || '(empty)'}`);
  }
  out.push('');
  out.push(`## Files Touched (last ${fileList.length})`);
  if (fileList.length === 0) {
    out.push('- (none)');
  } else {
    for (const [fp, op] of fileList) out.push(`- ${op}: ${fp}`);
  }
  out.push('');
  out.push(`## Recent User Messages (last ${recentUser.length})`);
  if (recentUser.length === 0) {
    out.push('- (none)');
  } else {
    recentUser.forEach((m, i) => {
      out.push(`${i + 1}. ${m.replace(/\s+/g, ' ').slice(0, 400)}`);
    });
  }
  out.push('');
  return out.join('\n');
}

function runHeadlessClaude(digest) {
  return new Promise((resolve) => {
    const args = [
      '-p',
      '--model', 'claude-sonnet-4-6',
      '--max-turns', '1',
      '--max-budget-usd', '1.50',
      '--input-format', 'text',
    ];
    let child;
    try {
      child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, output: '', error: `spawn-throw: ${err.message}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, output: stdout, error: 'timeout' });
    }, HEADLESS_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: stdout, error: `spawn: ${err.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const trimmed = stdout.trim();
      if (code === 0 && trimmed.length >= SONNET_MIN_OUTPUT_CHARS) {
        resolve({ ok: true, output: trimmed, error: null });
      } else {
        resolve({
          ok: false,
          output: trimmed,
          error: `exit=${code} len=${trimmed.length} stderr=${stderr.slice(0, 240)}`,
        });
      }
    });

    try {
      child.stdin.write(`${HANDOFF_INSTRUCTION}\n\n----- DIGEST -----\n${digest}\n`);
      child.stdin.end();
    } catch (err) {
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, output: '', error: `stdin: ${err.message}` });
    }
  });
}

(async () => {
  let cwd = process.cwd();
  let handoffDir = '';
  let handoffName = '';
  try {
    const raw = await readStdin();
    let input = {};
    try { input = JSON.parse(raw || '{}'); } catch {}
    const trigger = input.trigger || 'auto';
    const transcriptPath = input.transcript_path || '';
    cwd = input.cwd || cwd;

    if (trigger !== 'auto') process.exit(0);

    // Early exit guard: no real session content = nothing to summarize.
    if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0);
    const transcriptStat = statSync(transcriptPath);
    if (transcriptStat.size === 0) process.exit(0);

    const sessionId = shortSessionId(input.session_id);
    handoffName = `HANDOFF-${sessionId}.md`;
    handoffDir = ensureHandoffDir(cwd);
    const handoffPath = join(handoffDir, handoffName);

    pruneOldHandoffs(handoffDir, handoffName);

    const lines = readJsonlLines(transcriptPath);
    const parsed = parseTranscript(lines);
    const stamp = new Date().toISOString();
    const tSize = transcriptPath && existsSync(transcriptPath) ? statSync(transcriptPath).size : 0;
    const header = `<!-- precompact-handoff trigger=${trigger} session=${sessionId} ts=${stamp} transcript=${transcriptPath} bytes=${tSize} lines=${lines.length} -->`;

    // Hook-side ground truth: pure facts the LLM cannot hallucinate.
    const env = gatherEnvState(cwd);
    const lastBashErr = lastFailedBash(lines);
    const frontmatter = formatFrontmatter({
      env, lastBashErr, sessionId, transcriptPath, generatedAt: stamp,
    });

    let body;
    if (process.env.LOCUS_PRECOMPACT_FORCE_FALLBACK === '1') {
      body = `${frontmatter}\n${header}\n${RESUME_BANNER}\n\n<!-- forced fallback via env -->\n${mechanicalHandoff(parsed, transcriptPath)}\n`;
    } else {
      const claudeMd = findProjectClaudeMd(cwd);
      const digest = buildDigest({ ...parsed, claudeMd });
      const result = await runHeadlessClaude(digest);
      if (result.ok) {
        body = `${frontmatter}\n${header}\n# HANDOFF (Sonnet 4.6 schema)\n\n${RESUME_BANNER}\n\n${result.output}\n`;
      } else {
        body = `${frontmatter}\n${header}\n${RESUME_BANNER}\n\n<!-- Sonnet path failed: ${result.error} -->\n${mechanicalHandoff(parsed, transcriptPath)}\n`;
      }
    }
    writeFileSync(handoffPath, body, 'utf8');
    process.exit(0);
  } catch (err) {
    try {
      const dir = handoffDir || ensureHandoffDir(cwd);
      const name = handoffName || `HANDOFF-${shortSessionId(process.pid)}.md`;
      writeFileSync(join(dir, name), `# HANDOFF\n\n${RESUME_BANNER}\n\n<!-- precompact hook crashed: ${err && err.message ? err.message : String(err)} -->\n`, 'utf8');
    } catch {}
    process.exit(0);
  }
})();
