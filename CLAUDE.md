# claude-compact

## Always bump the version when hook code changes

Claude Code caches installed plugins under
`~/.claude/plugins/cache/<marketplace>/claude-compact/<version>/` — a
version-named directory. It refreshes that cache only when the version number
changes, **not** when the repo gets new commits.

So a push without a version bump does nothing: `/plugin` reports "already at
the latest version", the marketplace clone updates, and the hooks that actually
run stay stale. This already happened once — a model upgrade sat unapplied for
months because the version never moved.

Any change to `hooks/` must bump `version` in `.claude-plugin/plugin.json` in
the same commit.

Verify after pushing:

```sh
rg -n -e '--model' ~/.claude/plugins/cache/*/claude-compact/*/hooks/pre-compact.mjs
```
