# Contributing to Supernote Cloud Sync

Thank you for helping improve Supernote Cloud Sync. Please start with a GitHub
issue so the problem, scope, and user-facing behavior can be agreed before a
large implementation begins.

Security vulnerabilities and private conduct reports do not belong in public
issues. Follow [SECURITY.md](SECURITY.md) or
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) instead.

## Prerequisites

- Git
- Node.js 22
- pnpm 10.18.1

## Set up the project

```sh
git clone https://github.com/raaneem/supernote-cloud-sync.git
cd supernote-cloud-sync
pnpm install --frozen-lockfile
pnpm check
```

For local Obsidian testing, copy or symlink the repository into:

```text
<vault>/.obsidian/plugins/supernote-cloud-sync/
```

Run `pnpm build`, then enable **Supernote Cloud Sync** in Obsidian's community
plugin settings. The build creates the ignored `main.js`; Obsidian also needs
the tracked `manifest.json` and `styles.css`.

Never commit a vault's `data.json`, generated `main.js`, personal notebooks,
credentials, tokens, private benchmark inputs, or benchmark results.

## Work on a change

1. Open or choose a public GitHub issue.
2. Keep the change focused on that issue.
3. Add or update tests for changed behavior.
4. Run focused tests while iterating:

   ```sh
   pnpm exec vitest run tests/path-to-test.test.ts
   ```

5. Run the required pull-request gate:

   ```sh
   pnpm check
   ```

`pnpm check` is the single required local gate. It checks formatting, lint,
types, tests, the production bundle, contributor-document links, and production
dependency licenses.

Performance work may also run the optional generated-data benchmark suite:

```sh
pnpm perf
```

Do not publish local benchmark results or results derived from personal
notebooks.

## Decisions and work tracking

GitHub issues are the public source of work. Link the issue in the pull request
and describe any user-visible or compatibility effect.

Durable architecture decisions use the convention in
[docs/decisions/README.md](docs/decisions/README.md). A pull request must say
whether it preserves an existing public decision, supersedes one, or does not
affect one. Private development records and internal tickets are deliberately
not part of this repository.

## Pull requests

Keep commits reviewable and explain why the change is needed. In the pull
request:

- link the public issue;
- summarize the approach and user-visible behavior;
- list focused and manual checks;
- confirm `pnpm check` passes; and
- call out any public architecture decision affected.

Maintainers may ask for a change to be split when independent concerns can be
reviewed and released separately.

## Licensing

This project is distributed under GPL-3.0-or-later. By contributing, you agree
that your contribution may be distributed under GPL-3.0-or-later and confirm
that you have the right to submit it under those terms.
