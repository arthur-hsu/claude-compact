#!/usr/bin/env node
// PostCompact hook (replaces postcompact-handoff-reload.sh).
//
// After auto-compact finishes, locate the matching HANDOFF-<session>.md in
// <cwd>/.claude/ and inject ONLY the orthogonal-to-compact sections
// (Decisions / Ruled Out / Constraints / Next Action) plus the YAML
// frontmatter (env-state ground truth). The full file path is surfaced
// so Claude can Read it on demand.
//
// Rationale: pasting the entire HANDOFF back duplicates content with the
// auto-compact summary and triggers task interference + lost-in-the-middle
// (ACL 2024 EMNLP; NeurIPS 2025 information-gain studies). Selective
// re-inject keeps the small high-signal slice in context and treats the
// rest as Letta-style archival memory accessible via Read.
//
// Always exit 0 — never block.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SECTIONS_TO_INJECT = ['decisions', 'ruled out', 'constraints', 'next action'];
const HANDOFF_PATTERN = /^HANDOFF-[A-Za-z0-9]{1,16}\.md$/;

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

// Prefer the current session's auto-written HANDOFF file. If the hook input
// lacks a session id, fall back to newest HANDOFF-*.md by mtime.
function findHandoff(cwd, rawSessionId) {
  const dir = join(cwd, '.claude');
  if (!existsSync(dir)) return null;
  if (rawSessionId) {
    const exact = join(dir, `HANDOFF-${shortSessionId(rawSessionId)}.md`);
    if (existsSync(exact)) return exact;
  }
  let best = null;
  let entries;
  try { entries = readdirSync(dir); } catch { return null; }
  for (const name of entries) {
    if (!HANDOFF_PATTERN.test(name)) continue;
    const p = join(dir, name);
    try {
      const s = statSync(p);
      if (!best || s.mtimeMs > best.mtime) best = { path: p, mtime: s.mtimeMs };
    } catch {}
  }
  return best?.path || null;
}

// Pull verbatim YAML frontmatter (--- ... ---) and selected H2 sections.
// A section ends at the next H2 or H1.
function extractSelectedSections(content, wantedLowercase) {
  const out = [];
  const fmMatch = content.match(/^---\n[\s\S]*?\n---\n/);
  if (fmMatch) out.push(fmMatch[0].trimEnd());

  const wanted = new Set(wantedLowercase);
  const lines = content.split('\n');
  let inSection = false;
  let buffer = [];

  const flush = () => {
    if (inSection && buffer.length) {
      out.push(buffer.join('\n').trimEnd());
    }
    buffer = [];
  };

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      flush();
      inSection = wanted.has(h2[1].toLowerCase());
      if (inSection) buffer.push(line);
      continue;
    }
    if (line.startsWith('# ')) {
      flush();
      inSection = false;
      continue;
    }
    if (inSection) buffer.push(line);
  }
  flush();

  return out.join('\n\n').trim();
}

(async () => {
  try {
    const raw = await readStdin();
    let input = {};
    try { input = JSON.parse(raw || '{}'); } catch {}
    const cwd = input.cwd || process.cwd();

    const handoffPath = findHandoff(cwd, input.session_id);
    if (!handoffPath) { process.exit(0); return; }

    const content = readFileSync(handoffPath, 'utf8');
    if (!content.trim()) { process.exit(0); return; }

    const sliced = extractSelectedSections(content, SECTIONS_TO_INJECT);
    if (!sliced) { process.exit(0); return; }

    const src = handoffPath.split('/').pop();
    const note = [
      `[HANDOFF auto-reloaded from ${src} — schema slice only.`,
      `Full file (with Key References / Open Tasks / digest sections) at: ${handoffPath}`,
      `Read it if you need anything beyond Decisions / Ruled Out / Constraints / Next Action.]`,
    ].join('\n');

    const additional = `${note}\n\n${sliced}`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostCompact',
        additionalContext: additional,
      },
    }));
    process.exit(0);
  } catch {
    process.exit(0);
  }
})();
