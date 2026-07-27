# Supernote Cloud Sync

Supernote Cloud Sync brings Supernote notebooks into Obsidian. It mirrors Cloud
folders into your vault, renders `.note` files locally, and lets you read,
embed, export, transcribe, and optionally send files back without changing the
original Cloud notebooks.

This is an unofficial community project and is not affiliated with or endorsed
by Ratta.

## What it does

- Mirrors selected Supernote Cloud folders while preserving their structure.
- Opens mirrored notebooks in a fast page reader with paging, zoom, pan, and a
  thumbnail grid.
- Embeds a notebook or one notebook page in Markdown.
- Exports selected pages as Markdown, PDF, images, or combined formats.
- Sends ordinary files or rendered Markdown to a chosen Cloud folder.
- Provides one optional Paired folder for conflict-aware two-way sync.
- Supports optional AI transcription and per-notebook Automations.

The normal Mirror is one-way from Supernote Cloud to Obsidian. Uploads happen
only through an explicit Send to Supernote action or the configured Paired
folder.

## Install

During beta testing, install the repository through BRAT. For a manual
installation, download `main.js`, `manifest.json`, and `styles.css` from the
same release and place them in:

```text
<vault>/.obsidian/plugins/supernote-cloud-sync/
```

Restart Obsidian, open Settings, enable community plugins if needed, and enable
Supernote Cloud Sync.

## First-time setup

1. Open Settings, Community plugins, Supernote Cloud Sync.
2. In Setup, sign in to your Supernote Cloud account and enter the verification
   code sent by Supernote.
3. Choose the local Mirror folder.
4. Use Mirror from Supernote Cloud to select the Cloud folders you want.
5. Run Sync now.

Only the Supernote Cloud session token is saved for Cloud access.

## Sync workflows

### Mirror

Mirror downloads selected Cloud folders into the configured vault folder. Cloud
updates replace their mirrored copies. When a Cloud file disappears, its
mirrored copy moves to the trash configured in Obsidian.

Do not edit mirrored files as a way to upload changes. Treat the Mirror as a
Cloud-owned local view.

### Send to Supernote

Use Send to Supernote from the command palette or a file menu. Choose a Cloud
destination and confirm the transfer. Ordinary files are copied as-is; Markdown
is rendered to a device-readable PDF by default.

### Paired folder

The optional Paired folder synchronizes one vault folder with its matching
Supernote folder in both directions. Conflicting simultaneous edits are kept for
review instead of silently overwriting one side.

## Reader, embeds, and Export

Open a mirrored `.note` file to use the reader. Scroll or swipe between pages,
use pinch or Ctrl/Cmd-wheel to zoom, drag to pan above fit, and open the
thumbnail grid to jump or select pages.

Embed a notebook with a normal Obsidian embed, or append `#page=N` to show one
page. Activating the rendered page opens the full reader at that page.

Export from the reader to create Markdown, searchable PDF, page images, or
combined formats. Exports are ordinary vault files and are not rewritten by
later Mirror syncs.

## Optional transcription and Automations

OpenAI-compatible API transcription works on desktop and mobile. Claude Code,
Codex CLI, and custom-command engines are desktop-only and use their existing
local authentication or configuration.

Automations watch selected mirrored notebooks and process only new or changed
pages. A failed or timed-out run keeps its temporary batch for inspection and
retries on a later sync.

## Platform support

The core Cloud, reader, vault, export, and API-transcription features support
macOS, Windows, and Linux. They are designed for iOS and Android, where desktop
command engines are unavailable; final mobile release acceptance remains pending
a clean real-device load.

Claude Code, Codex CLI, and custom commands are experimental on Windows until a
real Windows 11 beta report verifies the supplied `.cmd` recipe and one agent
CLI. Deep Windows paths can still be limited by the system's `MAX_PATH`
configuration.

The minimum supported Obsidian version is 1.7.2.

## Privacy and security disclosures

- **Account required.** A Supernote Cloud account is required for Cloud sync,
  browsing, Send to Supernote, and the Paired folder.
- **Network services.** The plugin contacts Supernote Cloud to authenticate,
  list, download, and explicitly upload files. If API transcription is enabled,
  it also sends selected page images and prompts to the configured
  OpenAI-compatible endpoint. The default endpoint is
  `https://openrouter.ai/api/v1`.
- **Files outside the vault.** Desktop transcription and Automation engines use
  OS temporary directories for rendered page batches. Desktop features also
  resolve absolute vault and executable paths so external processes can read the
  intended files.
- **Shell execution.** Custom-command and Automation command backends execute
  user-supplied commands through the login shell with the inherited environment
  and the permissions of Obsidian. Configure only commands you trust.
- **Credentials.** An OpenAI-compatible API key is stored as plain text in this
  plugin's `data.json` inside the vault. Protect the vault and its backups. The
  Supernote Cloud session token is kept in device-local Obsidian application
  storage and removed from synced plugin settings.
- **Third-party tools.** Claude Code and Codex CLI receive selected rendered
  pages and prompts out of process and use their existing local login.

Never post `data.json`, credentials, personal notebook pages, private paths, or
unsanitized diagnostics in a public issue.

## Troubleshooting

- If login fails, retry verification from Setup and confirm Supernote Cloud is
  reachable.
- If a notebook will not open, disable `Supernote (Unofficial)` because only one
  plugin can own the `.note` extension.
- If a desktop agent is not detected, configure its absolute executable path and
  run the built-in verification.
- If sync is blocked, open Setup and repair the prerequisite named there.
- For a bug report, copy diagnostics from Setup, review them, and remove any
  private information before posting.

## Contributing and licensing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before participating.

This project is distributed under GPL-3.0-or-later. It depends on
`supernote-typescript`, which is also published under GPL-3.0-or-later; that
dependency establishes the plugin's GPL-compatible distribution requirement.
