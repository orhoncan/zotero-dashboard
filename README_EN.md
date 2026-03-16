# Orhon's Zotero Dashboard

Orhon's Zotero Dashboard is a desktop app for browsing your Zotero library, opening PDFs, running AI analysis, and sending notes back to Zotero or Obsidian.

## What it does

- Lists collections and papers with search and filtering.
- Shows PDF, abstract, tags, notes, and annotations.
- Runs academic analysis with Claude, Codex, or Gemini.
- Keeps AI output in the note editor and syncs it to Zotero or Obsidian.

## Requirements

- `Zotero Desktop` must be open
- At least one AI CLI installed:
  - `claude`
  - `codex`
  - `gemini`

Notes:
- The app includes a built-in `Zotero Bridge`.
- End users do not need to install `Node.js` or `zotero-mcp`.

## Installation

## macOS

Download one of these from the Releases page:

- `.dmg`
- `.zip`

Recommended path:

1. Open the `.dmg` file.
2. Drag the app into `Applications`.
3. Open `Zotero Desktop`.
4. Launch `Orhon's Zotero Dashboard.app`.

## Windows

Download one of these from the Releases page:

- `Setup.exe`
- portable `.exe`

Recommended path:

1. Run `Setup.exe`.
2. Finish the installation.
3. Open `Zotero Desktop`.
4. Launch the app.

If you use the portable build, open the `.exe` file directly.

## First use

1. Open Zotero.
2. Open the dashboard.
3. Select a paper from the left panel.
4. Choose a provider in the `AI Analysis` tab.
5. Use a quick action or ask a question.
6. The response is added to the note editor.
7. Save it to Zotero or Obsidian if needed.

## Common issues

**Cannot connect to Zotero**

- Make sure Zotero Desktop is running.
- Check the status panel in the top-right corner.

**AI provider is missing**

- Test `claude --version`, `codex --version`, or `gemini --version` in your terminal.
- If needed, set the CLI path from the app's check panel.

**PDF content looks limited**

- Make sure the PDF is attached and indexed in Zotero.
- Open the PDF inside Zotero and wait briefly if needed.
