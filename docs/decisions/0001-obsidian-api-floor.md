# 0001 - Derive the Obsidian API floor

**Status:** Accepted

## Context

Obsidian uses `manifest.json` and `versions.json` to decide whether a plugin can
run on an installed app version. Declaring a floor below the newest API used by
the plugin causes runtime failures; declaring an arbitrary recent version
unnecessarily excludes users.

The installed API package does not retain every historical `@since` annotation,
while the official `obsidianmd/obsidian-api` declaration does. Some Obsidian
capabilities are also injected through narrow local ports and cannot be resolved
directly at their call sites.

## Decision

The public compatibility contract is derived from every Obsidian import and
resolved member used under `src/`. `scripts/audit-obsidian-api.mjs` enumerates
that surface, supplements missing official annotations for post-1.0 APIs, and
requires `manifest.json` and `versions.json` to match the highest version.

The initial floor is Obsidian 1.7.2, determined by `Plugin.removeCommand`.

## Consequences

- Adding an Obsidian API can raise the supported-version floor.
- API changes must update the audit annotations and both version declarations
  together.
- Contributors can rerun the audit against a downloaded current official
  declaration when upgrading the Obsidian dependency.
- The initial public issue and pull request links will be added after the
  approval-gated repository is created.
