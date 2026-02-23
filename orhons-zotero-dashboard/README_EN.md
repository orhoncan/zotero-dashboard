# Orhon's Zotero Dashboard (English)

This project is a web dashboard for managing and analyzing your Zotero library.

Quick summary:
- Lists Zotero items and collections.
- Opens PDFs and shows notes/annotations.
- Runs AI analysis via CLI tools (Claude/Codex/Gemini).
- Lets you edit AI output and sync it back to Zotero notes.
- Syncs AI notes to an Obsidian folder.
- Uses `zotero-mcp` for Zotero tool access.

## 1. What does this app do?

With Orhon's Zotero Dashboard, you can:
- Search/filter items in your library.
- Open item details (metadata, abstract, tags).
- Open and review PDFs, including annotation-related workflows.
- Use the AI Analysis panel for summaries, critique, note analysis, and more.
- Keep all AI responses in the note editor and then:
  - Save to Zotero as a note
  - Sync to Obsidian as a Markdown file

## 2. Requirements

## Required
- Python 3 (recommended: 3.10+)
- Zotero Desktop (must be running)
- `zotero-mcp` (for Zotero tool access)
- At least one AI CLI:
  - Claude CLI
  - Codex CLI
  - Gemini CLI

Notes:
- You do not need all three AI CLIs; one is enough.
- The built-in self-check panel shows which tools are available.

## Optional
- Obsidian (if you want note sync)

## 3. Setup (macOS)

1. Download or clone this project.
2. Open Terminal in the project folder:

```bash
cd /path/to/zotero-dashboard
```

3. Check tools:

```bash
python3 --version
zotero-mcp --help
claude --version    # if installed
codex --version     # if installed
gemini --version    # if installed
```

4. Start Zotero Desktop.
5. Run the server:

```bash
python3 serve.py
```

6. Open in browser:
- [http://localhost:8080](http://localhost:8080)

## 4. Setup (Windows)

1. Download or clone this project.
2. Open PowerShell or CMD in the project folder:

```powershell
cd C:\path\to\zotero-dashboard
```

3. Check tools:

```powershell
py -3 --version
zotero-mcp --help
claude --version    # if installed
codex --version     # if installed
gemini --version    # if installed
```

4. Start Zotero Desktop.
5. Run the server:

```powershell
py -3 serve.py
```

6. Open in browser:
- [http://localhost:8080](http://localhost:8080)

## 5. First use (basic)

1. Select a collection or item from the left panel.
2. On the right panel:
   - `Detail` tab shows metadata/abstract/tags.
   - `AI Analysis` tab lets you select provider/model.
3. Click a quick action (`Summarize`, `Critical Review`, etc.).
4. AI output is appended to the note editor.
5. Then you can:
   - `Sync to Zotero`
   - `Sync to Obsidian`

## 6. Obsidian sync

- The first sync asks for your Obsidian folder.
- You can change it later using the folder icon.
- File naming format:
  - `paper-title-year.md`

## 7. Optional environment variables

If commands are not detected automatically, set these:

- `ZOTERO_MCP_COMMAND`
- `ZOTERO_STORAGE_DIR`
- `CLAUDE_COMMAND`
- `CODEX_COMMAND`
- `GEMINI_COMMAND`

## 8. Common issues

## "Cannot connect to Zotero"
- Make sure Zotero Desktop is open.
- Restart dashboard server with `python3 serve.py` or `py -3 serve.py`.

## "CLI not found"
- The related CLI may not be installed or not in PATH.
- Test with `--version` commands in terminal.

## "Unexpected token '<' ... is not valid JSON"
- You may be hitting the wrong server/endpoint.
- Restart the dashboard server and reload.

## 9. App name

- Turkish: **Orhon'un Zotero Paneli**
- English: **Orhon's Zotero Dashboard**

