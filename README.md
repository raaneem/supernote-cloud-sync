# Supernote Cloud Sync

Bring your complete Supernote workflow into Obsidian. Supernote Cloud Sync
mirrors Cloud files into your vault, renders native `.note` notebooks, and turns
handwritten pages into readable, linkable, exportable, transcribable, and
automatable Obsidian content.

The normal Mirror never uploads changes to your Supernote notebooks. Sending
files back is available only through an explicit action or the optional Paired
folder.

This is an unofficial community project and is not affiliated with or endorsed
by Ratta.

## Highlights

- **Direct Cloud mirror** — browse Supernote Cloud and mirror the files and
  folders you choose while preserving their hierarchy.
- **Native notebook reader** — open `.note` files inside Obsidian with smooth
  paging, swipe gestures, zoom, pan, keyboard navigation, and a fast thumbnail
  grid.
- **Page-perfect links and embeds** — embed a complete notebook or one exact
  page, copy embed syntax from the reader, and open links directly at `#page=N`.
- **Flexible exports** — export one page or a multi-page selection as Markdown,
  PDF, PNG images, formatted transcription, or combined output.
- **Handwriting to knowledge** — use Supernote's on-device recognition or
  optional AI transcription through an OpenAI-compatible API, Claude Code, Codex
  CLI, or a custom command.
- **Changed-page Automations** — send only new or edited notebook pages to an
  agent or command after sync, or run an Automation manually.
- **Optional return trip** — explicitly send files to Supernote Cloud or enable
  one conflict-aware Paired folder for two-way synchronization.

## Complete feature guide

### Supernote Cloud and Mirror

- Sign in directly to Supernote Cloud, including verification-code login.
- Browse the Cloud folder tree without leaving Obsidian.
- Mirror individual files or complete folders and preserve their Cloud structure
  in the vault.
- See which vault folders are connected to Supernote Cloud.
- Sync manually or on a configurable automatic interval.
- Skip unchanged downloads using Cloud and local checksums.
- Protect locally edited Mirror files from silent Cloud overwrite or deletion.
- Move the entire Mirror to another vault folder through Setup.
- Move Cloud-deleted, unchanged Mirror files to Obsidian Trash after a complete
  Cloud scan; incomplete scans do not apply destructive changes.

The Mirror is a one-way, Cloud-owned view. Edit exported files or use the Paired
folder when you need writable content.

### Native `.note` reader

- Render Supernote handwriting, recognized text, and native text boxes locally.
- Resume at the last page opened on the Supernote device when no explicit page
  link was requested.
- Turn pages by scrolling, swiping, clicking, or using the arrow keys.
- Pinch to zoom on touch devices, use Ctrl/Cmd-wheel on desktop, and drag to pan
  while zoomed.
- Jump through a virtualized thumbnail grid that stays responsive on large
  notebooks.
- Long-press or enter selection mode to choose multiple pages for export.
- Support right-to-left paging and reduced-motion preferences.
- Use a compact, touch-friendly toolbar on narrow screens.

### Obsidian links and embeds

- Embed a complete notebook with normal Obsidian syntax:

  ```md
  ![[My notebook.note]]
  ```

- Embed one exact page, with optional Obsidian width or size aliases:

  ```md
  ![[My notebook.note#page=12]]

  ![[My notebook.note#page=12|500]]

  ![[My notebook.note#page=12|500x320]]
  ```

- Click an embedded page to open the full reader at that page.
- Copy the current-page or whole-notebook embed directly from the reader.
- Follow page links created in exported Markdown and Automation context.

### Export and transcription

Export the current page or any selection to a chosen vault folder with a custom
filename. Available formats are:

- Markdown
- PDF
- PNG images
- Markdown + PDF
- Markdown + images
- Markdown with formatted transcription
- Markdown with formatted transcription + PDF

Exports can:

- Include Supernote's on-device handwriting recognition and extracted text
  boxes.
- Add selectable, positioned text to PDFs when recognition is available.
- Run optional AI transcription page by page while retaining the original
  on-device recognition in a collapsed callout.
- Turn a page selection into one structured document with optional instructions
  such as “organize these notes into sections and add a short summary.”
- Choose a transcription engine and model for one export without changing the
  saved default.
- Confirm before replacing existing output.

Exported Markdown, PDFs, and images are ordinary vault files. Later Cloud syncs
do not rewrite them.

### Transcription engines

- **OpenAI-compatible API** — works on desktop and mobile, supports model
  discovery, and defaults to OpenRouter while allowing a custom compatible
  endpoint.
- **Claude Code** — uses the installed desktop CLI and its existing login.
- **Codex CLI** — uses the installed desktop CLI and its existing login.
- **Custom command** — sends rendered pages through a user-configured desktop
  command.

Configure default instructions, models, executable paths, timeouts, and API
credentials in Settings. Desktop agent paths can be detected and tested from the
plugin.

### Automations

Create independent Automations for mirrored notebooks:

- Watch one source notebook and process only pages that are new or changed since
  the last successful run.
- Run after manual or automatic sync, with a device-local switch so only the
  intended Obsidian installation executes them.
- Run any Automation immediately from Settings.
- Send native-resolution page images to Claude Code or Codex CLI with your own
  prompt and model.
- Send page images or existing device-recognition Markdown to a custom command.
- Configure Claude allowed tools or the Codex sandbox.
- Keep rendered batches in a chosen vault folder, or automatically remove
  successful temporary batches.
- Preserve failed or timed-out batches for inspection and retry them after a
  later sync.

### Send to Supernote and Paired folder

**Send to Supernote** is an explicit command and file-menu action:

- Upload ordinary vault files to a Cloud folder.
- Render Markdown as a device-readable PDF or send it as plain text.
- Choose whether to replace an existing Cloud file or keep both.

The optional **Paired folder** synchronizes one vault folder with one Supernote
Cloud folder in both directions:

- Propagate file and folder additions, edits, renames, and deletions.
- Detect simultaneous edits, delete/edit collisions, and ambiguous renames.
- Resolve conflicts by using the Vault copy, using the Cloud copy, or keeping
  both.
- Stop instead of applying changes when either inventory is incomplete.

### Activity, diagnostics, and safety

- Follow sync, upload, transcription, and Automation work from the Supernote
  activity view.
- Inspect live stdout/stderr for desktop runs, copy logs, and cancel supported
  operations.
- Keep unresolved Paired-folder conflicts visible until you choose a resolution.
- Copy a secret-free diagnostics report from Setup for bug reports.
- Store the Supernote session token in device-local Obsidian storage instead of
  synced plugin settings.

## Install

In Obsidian, open **Settings → Community plugins → Browse**, search for
**Supernote Cloud Sync**, and select **Install**.

For a manual installation, download `main.js`, `manifest.json`, and `styles.css`
from the same release and place them in:

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

## Sync model

### Mirror

Mirror downloads selected Cloud folders into the configured vault folder. Cloud
updates replace unchanged mirrored copies. When a Cloud file disappears, its
unchanged mirrored copy moves to the trash configured in Obsidian.

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

## Platform support

The core Cloud, reader, vault, export, and API-transcription features support
macOS, Windows, Linux, iOS, and Android. Desktop command engines are unavailable
on mobile, where transcription uses the configured OpenAI-compatible API.

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
