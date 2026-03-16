import { app, BrowserWindow, dialog, shell } from 'electron';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let dashboardServer = null;
let dashboardUrl = '';
const APP_ICON = path.join(__dirname, '..', 'assets', 'icons', 'icon.png');

function splitPathEntries(value) {
  return String(value || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function shellReportedPath() {
  if (process.platform === 'win32') return '';
  const shellCandidates = [
    String(process.env.SHELL || '').trim(),
    '/bin/zsh',
    '/bin/bash',
  ].filter(Boolean);

  for (const shellPath of [...new Set(shellCandidates)]) {
    const run = spawnSync(shellPath, ['-l', '-c', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 2500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (run.status === 0 && String(run.stdout || '').trim()) {
      return String(run.stdout || '').trim();
    }
  }
  return '';
}

function enrichProcessPath() {
  const base = splitPathEntries(process.env.PATH);
  const fromShell = splitPathEntries(shellReportedPath());
  const common = process.platform === 'win32'
    ? [
        path.join(String(process.env.APPDATA || ''), 'npm'),
        path.join(String(process.env.USERPROFILE || ''), 'AppData', 'Roaming', 'npm'),
      ]
    : [
        path.join(os.homedir(), '.local', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
      ];

  const merged = [...new Set([...base, ...fromShell, ...common].filter(Boolean))];
  if (merged.length) process.env.PATH = merged.join(path.delimiter);
}

function resolveRuntimeDir() {
  return path.join(app.getPath('userData'), 'runtime');
}

async function startDashboardServer() {
  const runtimeDir = resolveRuntimeDir();
  await fs.mkdir(runtimeDir, { recursive: true });

  process.env.ZOTERO_DASHBOARD_DATA_DIR = runtimeDir;
  process.env.ZOTERO_DASHBOARD_RUNTIME_DIR = runtimeDir;
  process.env.HOST = '127.0.0.1';
  process.env.PORT = process.env.PORT && Number(process.env.PORT) > 0 ? process.env.PORT : '0';

  const serverModuleUrl = pathToFileURL(path.join(__dirname, '..', 'server.mjs')).href;
  const { createServer } = await import(serverModuleUrl);

  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 8080;
  const url = `http://127.0.0.1:${port}`;
  process.env.ZOTERO_DASHBOARD_BASE_URL = url;
  return { server, url };
}

function isLocalDashboardUrl(url) {
  return url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:');
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1120,
    minHeight: 700,
    backgroundColor: '#e9edf4',
    title: "Orhon's Zotero Dashboard",
    icon: APP_ICON,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalDashboardUrl(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (isLocalDashboardUrl(targetUrl)) return;
    event.preventDefault();
    shell.openExternal(targetUrl);
  });

  mainWindow.loadURL(dashboardUrl);
}

async function bootstrap() {
  app.setName("Orhon's Zotero Dashboard");
  enrichProcessPath();

  try {
    const started = await startDashboardServer();
    dashboardServer = started.server;
    dashboardUrl = started.url;
    createMainWindow();
  } catch (err) {
    const details = String(err?.stack || err?.message || err || 'Unknown startup error');
    dialog.showErrorBox('Başlatma Hatası', `Uygulama başlatılamadı.\n\n${details}`);
    app.quit();
  }
}

app.whenReady().then(bootstrap);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && dashboardUrl) {
    createMainWindow();
  }
});

app.on('before-quit', () => {
  if (!dashboardServer) return;
  try {
    dashboardServer.close();
  } catch {
    // no-op
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
