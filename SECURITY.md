# Security policy

## Supported versions

Security fixes are made for the latest published release. Pre-releases receive
best-effort fixes while they are being tested. Older releases are not supported;
users should update before reporting a problem that may already be fixed.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability.

Use GitHub's private
[Report a vulnerability](https://github.com/raaneem/supernote-cloud-sync/security/advisories/new)
form. Include:

- the affected plugin and Obsidian versions;
- the operating system and desktop or mobile environment;
- the impact and the conditions needed to reproduce it;
- minimal reproduction steps or a proof of concept; and
- any suggested mitigation.

Remove credentials, tokens, private notebook content, personal paths, and other
sensitive data. The maintainer, Raaneem
([@raaneem](https://github.com/raaneem)), will acknowledge a report within seven
calendar days and provide a substantive status update within thirty calendar
days. Investigation and release timing depends on severity and complexity; these
targets are not a promise of resolution within thirty days.

Private vulnerability reporting must be enabled when the repository becomes
public. If the form is unavailable, contact
[@raaneem](https://github.com/raaneem) without disclosing vulnerability details
in a public issue.

## Security model

The following behavior is intentional and should be considered when assessing a
report:

- A configured OpenAI-compatible transcription API key may be stored as plain
  text in this plugin's `data.json` inside the Obsidian vault. Protect the vault
  and its backups accordingly.
- The Supernote Cloud session token is handled differently. It is stored in
  device-local Obsidian application storage and stripped from the settings
  object before `data.json` is persisted.
- Custom commands and Automation command backends are explicit desktop-only
  capabilities. User-supplied commands execute through the login shell with the
  inherited process environment and the permissions of the Obsidian process.
  Configure only commands you trust.
- Claude Code and Codex CLI integrations use those tools' existing local
  authentication. Prompts are delivered out of process and temporary batches may
  contain rendered notebook pages.

Ordinary bugs without a security impact should use the public bug-report form.
