# Obsidian API floor

The minimum supported Obsidian version is **1.7.2**.

`scripts/audit-obsidian-api.mjs` enumerates every Obsidian import and every
resolved Obsidian member used under `src/`, prints their `@since` values, and
checks `manifest.json` and `versions.json` together.

The lasting compatibility policy is recorded in
[decision 0001](decisions/0001-obsidian-api-floor.md).

The determining API is `Plugin.removeCommand`, introduced in Obsidian 1.7.2. The
next-highest requirement is `FileManager.trashFile` at 1.6.6. The vault store
injects that method through a narrow local port, so the audit records its
official compatibility annotation explicitly. `Vault.process`, adopted for
atomic indexed-text updates, requires 1.1.0.

The compatibility annotations were checked against the official
`obsidianmd/obsidian-api` declarations on 2026-07-28. The installed
`obsidian@1.8.7` package omits most historical `@since` annotations, so the
audit carries explicit overrides for the post-1.0 APIs used by this plugin. When
the Obsidian dependency changes, rerun the audit against the current official
declaration:

```sh
OBSIDIAN_API_DECLARATION=/path/to/obsidian.d.ts \
  node scripts/audit-obsidian-api.mjs
```
