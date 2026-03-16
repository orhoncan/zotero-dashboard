#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const DIR = path.dirname(__filename);
const DATA_DIR = (() => {
  const raw = String(process.env.ZOTERO_DASHBOARD_DATA_DIR || '').trim();
  if (!raw) return DIR;
  return path.resolve(raw);
})();
const RUNTIME_DIR = (() => {
  const raw = String(process.env.ZOTERO_DASHBOARD_RUNTIME_DIR || '').trim();
  if (raw) return path.resolve(raw);
  return DATA_DIR;
})();
try {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
} catch {
  // fallback to DIR at runtime if creation fails
}

const PORT = Number(process.env.PORT || 8080);
const HOST = String(process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';
const ZOTERO_API = process.env.ZOTERO_API || 'http://localhost:23119';
const OBSIDIAN_CONFIG_FILE = path.join(DATA_DIR, '.obsidian-config.json');
const OBSIDIAN_CONFIG_FILE_LEGACY = path.join(DIR, '.obsidian-config.json');
const CLI_CONFIG_FILE = path.join(DATA_DIR, '.cli-config.json');
const CLI_CONFIG_FILE_LEGACY = path.join(DIR, '.cli-config.json');
const CLAUDE_MCP_CONFIG_FILE = path.join(DATA_DIR, '.mcp-zotero.json');
const CLAUDE_MCP_CONFIG_FILE_LEGACY = path.join(DIR, '.mcp-zotero.json');
const GEMINI_WORKSPACE_DIR = path.join(DATA_DIR, '.gemini');
const GEMINI_WORKSPACE_SETTINGS_FILE = path.join(GEMINI_WORKSPACE_DIR, 'settings.json');
const LOCAL_MCP_BRIDGE_TOKEN = crypto.randomBytes(18).toString('hex');

const PROVIDERS = ['claude', 'codex', 'gemini'];
const ANALYSIS_MODES = new Set(['fast', 'balanced', 'deep']);

const PROVIDER_HEALTH = {
  claude: { status: 'unknown', lastError: '', lastSuccessAt: 0, lastCheckedAt: 0, latencyMs: 0, available: false },
  codex: { status: 'unknown', lastError: '', lastSuccessAt: 0, lastCheckedAt: 0, latencyMs: 0, available: false },
  gemini: { status: 'unknown', lastError: '', lastSuccessAt: 0, lastCheckedAt: 0, latencyMs: 0, available: false },
};

const PROVIDER_CIRCUIT = {
  claude: { openUntil: 0, reason: '', category: '', openedAt: 0 },
  codex: { openUntil: 0, reason: '', category: '', openedAt: 0 },
  gemini: { openUntil: 0, reason: '', category: '', openedAt: 0 },
};

const PROVIDER_CIRCUIT_COOLDOWN_SECONDS = {
  rate_limit: 300,
  timeout: 180,
  unavailable: 240,
  error: 120,
};

const AI_RESPONSE_CACHE = new Map();
const AI_RESPONSE_CACHE_TTL_SECONDS = {
  fast: 10 * 60,
  balanced: 20 * 60,
  deep: 30 * 60,
};
const AI_RESPONSE_CACHE_MAX = 800;

const EXTERNAL_SEARCH_CACHE = new Map();
const EXTERNAL_SEARCH_CACHE_MAX = 600;
const EXTERNAL_SEARCH_CACHE_TTL_SECONDS = 20 * 60;

const TOOL_RESULT_CACHE = new Map();
const TOOL_RESULT_CACHE_MAX = 1200;
const TOOL_RESULT_CACHE_TTL_SECONDS = {
  metadata: 15 * 60,
  fulltext: 10 * 60,
  notes: 10 * 60,
};

const INFLIGHT_AI_REQUESTS = new Map();
const BIG_PDF_RESULT_CACHE = new Map();
const BIG_PDF_RESULT_CACHE_MAX = 260;
const BIG_PDF_PIPELINE_VERSION = 'v2';
const ZOTERO_LIBRARY_CACHE = new Map();
const ZOTERO_LIBRARY_CACHE_TTL_SECONDS = 8 * 60;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};
let CACHED_NODE_BINARY = '';

function dashboardBaseUrl() {
  const envUrl = String(process.env.ZOTERO_DASHBOARD_BASE_URL || '').trim();
  if (envUrl) return envUrl.replace(/\/+$/, '');
  return `http://${HOST}:${PORT}`;
}

function isWin() {
  return process.platform === 'win32';
}

function defaultZoteroMcpCommand() {
  if (isWin()) return 'zotero-mcp.cmd';
  return path.join(os.homedir(), '.local', 'bin', 'zotero-mcp');
}

function splitPathEntries(value) {
  return String(value || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniquePathEntries(entries) {
  return [...new Set((entries || []).map((entry) => String(entry || '').trim()).filter(Boolean))];
}

function defaultCliSearchDirs() {
  if (isWin()) {
    const dirs = [];
    const appData = String(process.env.APPDATA || '').trim();
    const userProfile = String(process.env.USERPROFILE || '').trim();
    const localAppData = String(process.env.LOCALAPPDATA || '').trim();
    const programFiles = String(process.env.ProgramFiles || '').trim();
    const programFilesX86 = String(process.env['ProgramFiles(x86)'] || '').trim();
    if (appData) dirs.push(path.join(appData, 'npm'));
    if (userProfile) dirs.push(path.join(userProfile, 'AppData', 'Roaming', 'npm'));
    if (localAppData) dirs.push(path.join(localAppData, 'Programs'));
    if (programFiles) dirs.push(path.join(programFiles, 'nodejs'));
    if (programFilesX86) dirs.push(path.join(programFilesX86, 'nodejs'));
    return uniquePathEntries(dirs);
  }

  return uniquePathEntries([
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.volta', 'bin'),
    path.join(os.homedir(), '.asdf', 'shims'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/local/bin',
  ]);
}

function isExecutableFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return false;
    if (!isWin()) fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function collectNvmNodeCandidates() {
  if (isWin()) return [];
  const root = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    return entries.map((name) => path.join(root, name, 'bin', 'node'));
  } catch {
    return [];
  }
}

function resolveNodeBinary() {
  if (CACHED_NODE_BINARY && isExecutableFile(CACHED_NODE_BINARY)) return CACHED_NODE_BINARY;

  const envNode = String(process.env.NODE_BINARY || '').trim();
  const candidates = [
    envNode,
    ...collectNvmNodeCandidates(),
    ...defaultCliSearchDirs().map((dir) => path.join(dir, isWin() ? 'node.exe' : 'node')),
    'node',
  ];
  const resolved = resolveCommandFromCandidates(candidates);
  if (resolved && isExecutableFile(resolved)) {
    CACHED_NODE_BINARY = resolved;
    return resolved;
  }
  return '';
}

function runningInsideElectron() {
  return Boolean(process.versions && process.versions.electron);
}

function bundledMcpBridgeScriptCandidates() {
  const baseCandidates = [
    path.join(DIR, 'mcp', 'zotero-bridge.mjs'),
  ];

  if (DIR.includes('app.asar')) {
    baseCandidates.push(
      path.join(DIR.replace('app.asar', 'app.asar.unpacked'), 'mcp', 'zotero-bridge.mjs'),
      path.join(process.resourcesPath || '', 'mcp', 'zotero-bridge.mjs')
    );
  }

  return uniquePathEntries(baseCandidates.filter(Boolean));
}

function resolveBundledMcpBridgeScript() {
  for (const candidate of bundledMcpBridgeScriptCandidates()) {
    try {
      const st = fs.statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return '';
}

function bundledMcpServerSetup() {
  const script = resolveBundledMcpBridgeScript();
  if (!script) return null;

  const command = runningInsideElectron()
    ? process.execPath
    : (resolveNodeBinary() || process.execPath);
  const env = {
    ZOTERO_DASHBOARD_MCP_BASE_URL: dashboardBaseUrl(),
    ZOTERO_DASHBOARD_MCP_TOKEN: LOCAL_MCP_BRIDGE_TOKEN,
  };

  if (runningInsideElectron()) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }

  return {
    kind: 'bundled',
    command,
    args: [script],
    env,
    script,
  };
}

function enrichEnvPathForCli(env) {
  const workingEnv = env || process.env;
  const existing = splitPathEntries(workingEnv.PATH || process.env.PATH || '');
  const extra = [...defaultCliSearchDirs()];
  const nodeBin = resolveNodeBinary();
  if (nodeBin) extra.unshift(path.dirname(nodeBin));
  const merged = uniquePathEntries([...existing, ...extra]);
  if (merged.length) {
    workingEnv.PATH = merged.join(path.delimiter);
  }
}

enrichEnvPathForCli(process.env);

function detectZoteroStorageCandidates() {
  const candidates = [];
  const envDir = String(process.env.ZOTERO_STORAGE_DIR || '').trim();
  if (envDir) candidates.push(envDir);
  candidates.push(path.join(os.homedir(), 'Zotero', 'storage'));

  if (isWin()) {
    const appdata = String(process.env.APPDATA || '').trim();
    if (appdata) {
      const profilesRoot = path.join(appdata, 'Zotero', 'Zotero', 'Profiles');
      try {
        const entries = fs.readdirSync(profilesRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          candidates.push(path.join(profilesRoot, entry.name, 'zotero', 'storage'));
        }
      } catch {
        // ignore
      }
    }
    const userProfile = String(process.env.USERPROFILE || '').trim();
    if (userProfile) {
      candidates.push(path.join(userProfile, 'Zotero', 'storage'));
    }
  }

  const out = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    const token = normalized.toLowerCase();
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(normalized);
  }
  return out.length ? out : [path.resolve(path.join(os.homedir(), 'Zotero', 'storage'))];
}

const ZOTERO_STORAGE_CANDIDATES = detectZoteroStorageCandidates();
const ZOTERO_STORAGE = ZOTERO_STORAGE_CANDIDATES.find((p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}) || ZOTERO_STORAGE_CANDIDATES[0];

function normalizeProvider(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  return PROVIDERS.includes(normalized) ? normalized : 'claude';
}

function normalizeAnalysisMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  return ANALYSIS_MODES.has(normalized) ? normalized : 'balanced';
}

function normalizeOutputLanguage(language) {
  const normalized = String(language || '').trim().toLowerCase();
  if (['tr', 'turkish', 'türkçe'].includes(normalized)) return 'tr';
  if (['en', 'english'].includes(normalized)) return 'en';
  return '';
}

function defaultModelForProvider(provider) {
  const map = {
    claude: 'sonnet',
    codex: 'gpt-5-codex',
    gemini: 'gemini-2.5-flash',
  };
  return map[normalizeProvider(provider)] || '';
}

function resolveFromPath(command) {
  const candidate = String(command || '').trim();
  if (!candidate) return '';

  const hasSep = candidate.includes(path.sep) || candidate.includes('/');
  if (path.isAbsolute(candidate) || hasSep) {
    try {
      const st = fs.statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {
      return '';
    }
    return '';
  }

  const envPath = String(process.env.PATH || '');
  const dirs = splitPathEntries(envPath);
  const searchDirs = uniquePathEntries([...dirs, ...defaultCliSearchDirs()]);
  const extensions = isWin()
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];

  for (const dir of searchDirs) {
    if (isWin()) {
      const hasExt = /\.[a-z0-9]+$/i.test(candidate);
      const variants = hasExt ? [candidate] : [candidate, ...extensions.map((ext) => `${candidate}${ext}`)];
      for (const variant of variants) {
        const full = path.join(dir, variant);
        try {
          const st = fs.statSync(full);
          if (st.isFile()) return full;
        } catch {
          // continue
        }
      }
    } else {
      const full = path.join(dir, candidate);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        const st = fs.statSync(full);
        if (st.isFile()) return full;
      } catch {
        // continue
      }
    }
  }
  return '';
}

function resolveCommandFromCandidates(candidates) {
  for (const candidate of (candidates || [])) {
    const command = String(candidate || '').trim();
    if (!command) continue;
    if (path.isAbsolute(command)) {
      try {
        const st = fs.statSync(command);
        if (st.isFile()) return command;
      } catch {
        // continue
      }
      continue;
    }
    const resolved = resolveFromPath(command);
    if (resolved) return resolved;
  }
  return '';
}

function providerCommandCandidates(provider) {
  const normalized = normalizeProvider(provider);
  const cliOverrides = readCliCommandOverridesSync();
  const envKey = {
    claude: 'CLAUDE_COMMAND',
    codex: 'CODEX_COMMAND',
    gemini: 'GEMINI_COMMAND',
  }[normalized];

  const candidates = [String(cliOverrides[normalized] || '').trim(), String(process.env[envKey] || '').trim()];

  if (normalized === 'claude') {
    if (isWin()) {
      const localAppData = String(process.env.LOCALAPPDATA || '').trim();
      if (localAppData) {
        candidates.push(path.join(localAppData, 'Programs', 'Claude', 'claude.exe'));
        candidates.push(path.join(localAppData, 'Programs', 'Claude', 'claude.cmd'));
      }
      candidates.push('claude.cmd', 'claude.exe', 'claude');
    } else {
      candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude'), 'claude');
    }
    return candidates;
  }

  if (normalized === 'codex') {
    if (isWin()) {
      const appData = String(process.env.APPDATA || '').trim();
      if (appData) candidates.push(path.join(appData, 'npm', 'codex.cmd'));
      candidates.push('codex.cmd', 'codex.exe', 'codex');
    } else {
      candidates.push(
        path.join(os.homedir(), '.local', 'bin', 'codex'),
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        'codex',
      );
    }
    return candidates;
  }

  if (normalized === 'gemini') {
    if (isWin()) {
      const appData = String(process.env.APPDATA || '').trim();
      if (appData) candidates.push(path.join(appData, 'npm', 'gemini.cmd'));
      candidates.push('gemini.cmd', 'gemini.exe', 'gemini');
    } else {
      candidates.push(
        path.join(os.homedir(), '.local', 'bin', 'gemini'),
        '/opt/homebrew/bin/gemini',
        '/usr/local/bin/gemini',
        'gemini',
      );
    }
    return candidates;
  }

  return candidates;
}

function resolveProviderCommand(provider) {
  const normalized = normalizeProvider(provider);
  const resolved = resolveCommandFromCandidates(providerCommandCandidates(normalized));
  if (resolved) return resolved;
  return { claude: 'claude', codex: 'codex', gemini: 'gemini' }[normalized] || 'claude';
}

function providerBinaryAvailable(provider) {
  return Boolean(resolveCommandFromCandidates(providerCommandCandidates(provider)));
}

function providerFallbackChain(requestedProvider) {
  const requested = normalizeProvider(requestedProvider);
  const priority = ['codex', 'gemini', 'claude'];
  const rest = priority.filter((p) => p !== requested);
  return [requested, ...rest];
}

function providerCircuitState(provider) {
  const normalized = normalizeProvider(provider);
  const now = Date.now() / 1000;
  const state = { ...(PROVIDER_CIRCUIT[normalized] || {}) };
  const openUntil = Number(state.openUntil || 0);
  const cooldownSec = Math.max(0, Math.floor(openUntil - now));
  return {
    open: cooldownSec > 0,
    cooldownSec,
    openUntil,
    reason: String(state.reason || ''),
    category: String(state.category || ''),
    openedAt: Number(state.openedAt || 0),
  };
}

function providerCircuitClose(provider) {
  const normalized = normalizeProvider(provider);
  PROVIDER_CIRCUIT[normalized] = { openUntil: 0, reason: '', category: '', openedAt: 0 };
}

function providerCircuitOpen(provider, category, reason) {
  const normalized = normalizeProvider(provider);
  let normalizedCategory = String(category || 'error').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_CIRCUIT_COOLDOWN_SECONDS, normalizedCategory)) {
    normalizedCategory = 'error';
  }
  const cooldown = Number(PROVIDER_CIRCUIT_COOLDOWN_SECONDS[normalizedCategory] || 120);
  const now = Date.now() / 1000;
  const prev = PROVIDER_CIRCUIT[normalized] || {};
  const openUntil = Math.max(Number(prev.openUntil || 0), now + cooldown);
  PROVIDER_CIRCUIT[normalized] = {
    openUntil,
    reason: String(reason || '').slice(0, 320),
    category: normalizedCategory,
    openedAt: now,
  };
}

function isRateLimitError(message) {
  const normalized = String(message || '').toLowerCase();
  const tokens = [
    'status 429',
    'too many requests',
    'rate limit',
    'quota',
    'resource_exhausted',
    'retrying with backoff',
    'exceeded your current quota',
  ];
  return tokens.some((token) => normalized.includes(token));
}

function providerFailureCategory(message) {
  const normalized = String(message || '').toLowerCase();
  if (isRateLimitError(normalized)) return 'rate_limit';
  if (normalized.includes('zaman aşımı') || normalized.includes('timeout')) return 'timeout';
  if (normalized.includes('cli bulunamadı') || normalized.includes('not found') || normalized.includes('enoent')) {
    return 'unavailable';
  }
  return 'error';
}

function updateProviderHealth(provider, status, error = '', latencyMs = 0) {
  const normalized = normalizeProvider(provider);
  const now = Date.now() / 1000;
  const state = { ...(PROVIDER_HEALTH[normalized] || {}) };
  state.status = String(status || 'unknown');
  state.lastCheckedAt = now;
  state.latencyMs = Number(latencyMs || 0);
  state.available = providerBinaryAvailable(normalized);
  if (error) state.lastError = String(error).slice(0, 320);
  else if (state.status === 'ok') state.lastError = '';
  if (state.status === 'ok') {
    state.lastSuccessAt = now;
    providerCircuitClose(normalized);
  }
  PROVIDER_HEALTH[normalized] = state;
}

function getProviderHealthSnapshot() {
  const snapshot = {};
  for (const provider of PROVIDERS) {
    const state = { ...(PROVIDER_HEALTH[provider] || {}) };
    const available = providerBinaryAvailable(provider);
    if (!state.status || state.status === 'unknown') {
      state.status = available ? 'ok' : 'down';
      state.lastError = available ? '' : 'CLI not found';
    }
    const circuit = providerCircuitState(provider);
    state.cooldownSec = circuit.cooldownSec;
    state.cooldownReason = circuit.reason;
    if (circuit.open && state.status !== 'down') {
      state.status = 'cooldown';
      if (!state.lastError) state.lastError = circuit.reason || 'Circuit breaker open';
    }
    state.available = available;
    snapshot[provider] = state;
    PROVIDER_HEALTH[provider] = { ...state };
  }
  return snapshot;
}

function providerFallbackChainAvailable(requestedProvider) {
  const ordered = providerFallbackChain(requestedProvider);
  const available = ordered.filter((provider) => !providerCircuitState(provider).open);
  return available.length ? available : ordered.slice(0, 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function parseFirstRelevantError(message) {
  const raw = String(message || '');
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return '';
  const preferred = lines.find((line) => /(error|failed|hata|timeout|quota)/i.test(line)) || lines[0];
  return preferred.split(/\s+/).join(' ').slice(0, 320);
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(ms) || 1000));
  return { controller, timer };
}

async function fetchJson(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 12000);
  const { controller, timer } = timeoutSignal(timeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: options.headers || {},
    });
  } finally {
    clearTimeout(timer);
  }
  const raw = await resp.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  if (!resp.ok) {
    const detail = String(data.error || data.message || raw || resp.statusText || '').slice(0, 300);
    throw new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ''}`);
  }
  return data;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': String(body.length),
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf-8');
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Content-Length': String(buffer.length),
    ...extraHeaders,
  });
  res.end(buffer);
}

async function readRequestBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(rawBuffer) {
  const text = Buffer.isBuffer(rawBuffer) ? rawBuffer.toString('utf-8') : String(rawBuffer || '');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function readJsonFile(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

async function readJsonFileWithFallback(primaryPath, fallbackPath = '') {
  const primary = await readJsonFile(primaryPath);
  if (primary && Object.keys(primary).length > 0) return primary;
  if (!fallbackPath || fallbackPath === primaryPath) return primary;
  return readJsonFile(fallbackPath);
}

function readJsonFileSyncSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // ignore
  }
  return {};
}

function readJsonFileWithFallbackSync(primaryPath, fallbackPath = '') {
  const primary = readJsonFileSyncSafe(primaryPath);
  if (primary && Object.keys(primary).length > 0) return primary;
  if (!fallbackPath || fallbackPath === primaryPath) return primary;
  return readJsonFileSyncSafe(fallbackPath);
}

async function writeJsonFile(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

function normalizeCliCommandOverrides(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    claude: String(source.claude || '').trim(),
    codex: String(source.codex || '').trim(),
    gemini: String(source.gemini || '').trim(),
  };
}

async function readCliCommandOverrides() {
  const raw = await readJsonFileWithFallback(CLI_CONFIG_FILE, CLI_CONFIG_FILE_LEGACY);
  return normalizeCliCommandOverrides(raw);
}

function readCliCommandOverridesSync() {
  const raw = readJsonFileWithFallbackSync(CLI_CONFIG_FILE, CLI_CONFIG_FILE_LEGACY);
  return normalizeCliCommandOverrides(raw);
}

function normalizeDirectory(raw) {
  const p = String(raw || '').trim();
  if (!p) return '';
  const expanded = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(expanded);
}

function getObsidianTargetDir(savedConfig = {}) {
  const saved = normalizeDirectory(savedConfig.directory || '');
  if (saved) return saved;

  const envOverride = normalizeDirectory(process.env.OBSIDIAN_ZOTDASHBOARD_DIR || '');
  if (envOverride) return envOverride;

  const candidates = [
    path.join(os.homedir(), 'Documents', 'Obsidian', 'ZotDashboard'),
    path.join(os.homedir(), 'Obsidian', 'ZotDashboard'),
    path.join(os.homedir(), 'Documents', 'ZotDashboard'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // continue
    }
  }
  return path.join(os.homedir(), 'Documents', 'Obsidian', 'ZotDashboard');
}

function sanitizeFilename(raw) {
  let name = String(raw || '').trim();
  if (!name) name = 'ai-note';
  name = name.replace(/[\\/:*?"<>|]+/g, '-');
  name = name.replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  if (name.length > 150) name = name.slice(0, 150).trim();
  return name || 'ai-note';
}

function normalizeProcessMetaCandidate(text) {
  let candidate = String(text || '').trim().toLowerCase();
  if (!candidate) return '';
  candidate = candidate.replace(/^[\s\-*#>\u2022"'`“”‘’()\[\]{}:;,.!?]+/g, '');
  candidate = candidate.replace(/[\s"'`“”‘’()\[\]{}:;,.!?]+$/g, '');
  return candidate.trim();
}

function processMetaPrefixes() {
  return [
    'yeterli içerik elde ettim',
    'yeterli bağlam elde ettim',
    'çıktıyı şimdi üretiyorum',
    'çıktıyı şimdi hazırlıyorum',
    'şimdi çıktıyı üretiyorum',
    'şimdi çıktıyı hazırlıyorum',
    'şu anda zotero kütüphanenizdeki veritabanı durumunu kontrol ediyor',
    'şu anda zotero kütüphanesindeki veritabanı durumunu kontrol ediyor',
    'zotero kütüphanenizdeki veritabanı durumunu kontrol ediyor',
    'zotero kütüphanenizdeki çalışmayla ilişkili kaynakları belirliyorum',
    'zotero kütüphanenizdeki kaynakları belirliyorum',
    'zotero kütüphanenizde semantik arama yapıyorum',
    'zotero kütüphanenizdeki',
    'i am checking your zotero library',
    'i am searching your zotero library',
    'currently checking your zotero library',
    'currently searching your zotero library',
    'i am running semantic search',
    'currently running semantic search',
    'i now have enough content',
    'i now have enough context',
    'i will now produce the output',
    'i will now generate the output',
    'now generating the output',
    'now producing the output',
  ];
}

const PROCESS_META_PATTERNS = [
  /^yeterli .* (elde ettim|topladım)/i,
  /^çıktıyı şimdi .*/i,
  /^şimdi .*çıktı.*/i,
  /^(şu anda|şimdi)\b.*\b(kontrol ediyor(?:um)?|inceliyor(?:um)?|tarıyor(?:um)?|arıyor(?:um)?|belirliyor(?:um)?|tespit ediyor(?:um)?|doğruluyor(?:um)?|derliyor(?:um)?|topluyor(?:um)?|hazırlıyor(?:um)?)\b/i,
  /^zotero\b.*\b(veritabanı durumunu kontrol ediyor(?:um)?|semantik arama yapıyor(?:um)?|arama yapıyor(?:um)?|kaynakları belirliyor(?:um)?)\b/i,
  /^zotero\b.*\btespit etmek için\b.*\bsemantik arama yapıyor(?:um)?\b/i,
  /^i (now )?(have|got) enough (content|context)/i,
  /^i will now (produce|generate|prepare) (the )?output/i,
  /^now (producing|generating|preparing) (the )?output/i,
  /^i(?:'m| am|’m)\b.*\b(checking|searching|scanning|identifying|retrieving|looking up|reviewing|analyzing|compiling)\b/i,
  /^currently\b.*\b(checking|searching|scanning|identifying|retrieving|looking up|reviewing|analyzing|compiling)\b/i,
  /^to\b.*\b(i(?:'m| am|’m)|currently)\b.*\b(searching|checking|scanning|identifying|retrieving)\b/i,
];

function isProcessMetaLine(text) {
  const candidate = normalizeProcessMetaCandidate(text);
  if (!candidate) return false;
  if (processMetaPrefixes().some((prefix) => candidate.startsWith(prefix))) return true;
  return PROCESS_META_PATTERNS.some((re) => re.test(candidate));
}

function isProcessMetaPrefix(text) {
  const candidate = normalizeProcessMetaCandidate(text);
  if (!candidate) return false;
  const prefixes = processMetaPrefixes();
  return prefixes.some((prefix) => prefix.startsWith(candidate) || candidate.startsWith(prefix));
}

function providerNoisePrefixes(provider) {
  const normalized = normalizeProvider(provider);
  if (normalized === 'gemini') {
    return [
      'yolo mode is enabled',
      'loaded cached credentials',
      "server 'zotero-mcp' supports tool updates",
      'mcp startup:',
      'mcp:',
    ];
  }
  if (normalized === 'codex') {
    return [
      'openai codex v',
      'tokens used',
      'thinking',
      'codex',
      'user',
      'tool ',
      'plan update',
      'evaluating skill',
      'preparing ',
      'reviewing ',
      'selecting ',
      'verifying ',
      'moving to ',
      'noting ',
      'workdir:',
      'model:',
      'provider:',
      'approval:',
      'sandbox:',
      'reasoning effort:',
      'reasoning summaries:',
      'session id:',
      '--------',
    ];
  }
  return [];
}

function isNoiseOutputLine(line, provider) {
  const candidate = String(line || '').trim();
  if (!candidate) return false;
  if (isProcessMetaLine(candidate)) return true;

  const lowered = candidate.toLowerCase();
  const normalized = normalizeProvider(provider);

  if (normalized === 'gemini') {
    return [
      /^yolo mode is enabled/i,
      /^loaded cached credentials/i,
      /^server 'zotero-mcp' supports tool updates/i,
      /^mcp startup:/i,
      /^mcp:\s*/i,
    ].some((re) => re.test(lowered));
  }

  if (normalized === 'codex') {
    return [
      /^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}.*\bwarn\b/i,
      /^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}.*\berror\b/i,
      /^openai codex v/i,
      /^tokens used$/i,
      /^\d{1,3}(,\d{3})+$/,
      /^thinking$/i,
      /^codex$/i,
      /^user$/i,
      /^tool\s+[a-z0-9_.:-]+\(/i,
      /^plan update$/i,
      /^evaluating skill\b/i,
      /^preparing\b.*\b(call|search|request)\b/i,
      /^reviewing\b/i,
      /^selecting\b/i,
      /^verifying\b/i,
      /^moving to next\b/i,
      /^noting next\b/i,
      /^[→✓]\s+/,
      /^zotero-mcp\.[a-z0-9_]+\(/i,
      /^[a-z0-9_.:-]+\(.+\)\s+success in\s+\d+ms:?$/i,
      /^"content"\s*:/i,
      /^"structuredcontent"\s*:/i,
      /^"iserror"\s*:/i,
      /^"result"\s*:/i,
      /^"type"\s*:/i,
      /^"text"\s*:/i,
      /^"url"\s*:/i,
      /^"doi"\s*:/i,
      /^"authors"\s*:/i,
      /^"date"\s*:/i,
      /^"journal"\s*:/i,
      /^"item key"\s*:/i,
      /^[{}[\],]+$/,
      /^workdir:/i,
      /^model:/i,
      /^provider:/i,
      /^approval:/i,
      /^sandbox:/i,
      /^reasoning effort:/i,
      /^reasoning summaries:/i,
      /^session id:/i,
      /^-{3,}$/,
      /^mcp:/i,
      /^mcp startup:/i,
    ].some((re) => re.test(lowered));
  }

  return false;
}

function isNoiseOutputPrefix(text, provider) {
  const candidate = String(text || '').trim().toLowerCase();
  if (!candidate) return false;
  if (isProcessMetaPrefix(candidate)) return true;
  const prefixes = providerNoisePrefixes(provider);
  return prefixes.some((prefix) => prefix.startsWith(candidate) || candidate.startsWith(prefix));
}

function sanitizeProviderOutput(text, provider) {
  const content = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!content) return '';
  const normalized = normalizeProvider(provider);
  const lines = content.split('\n');
  const cleaned = [];
  let blankRun = 0;

  const traceMode = normalized === 'codex'
    && (
      /(^|\n)\s*tool\s+[a-z0-9_.:-]+\(/i.test(content)
      || /(^|\n)\s*plan update\s*$/im.test(content)
      || /(^|\n)\s*zotero-mcp\.[a-z0-9_]+\(/i.test(content)
    );

  for (const line of lines) {
    const checkLine = String(line || '').trim();
    if (!checkLine) {
      blankRun += 1;
      if (cleaned.length && blankRun <= 2) cleaned.push('');
      continue;
    }
    blankRun = 0;
    if (isProcessMetaLine(checkLine)) continue;
    if (normalized === 'gemini' || normalized === 'codex') {
      if (isNoiseOutputLine(checkLine, normalized)) continue;
      if (traceMode && /^[{}[\],]+$/.test(checkLine)) continue;
    }
    cleaned.push(String(line).replace(/[\s\t]+$/g, ''));
  }
  return cleaned.join('\n').trim();
}

function streamNoiseFilterPush(chunk, provider, state) {
  const payload = String(chunk || '');
  if (!payload) return '';
  state.buffer = String(state.buffer || '') + payload;
  const emitted = [];
  let directMode = Boolean(state.directMode);

  while (state.buffer.includes('\n')) {
    const idx = state.buffer.indexOf('\n');
    const line = state.buffer.slice(0, idx);
    state.buffer = state.buffer.slice(idx + 1);
    if (isNoiseOutputLine(line, provider)) continue;
    directMode = true;
    emitted.push(`${line}\n`);
  }

  const remainder = String(state.buffer || '');
  if (remainder) {
    if (directMode) {
      if (!isNoiseOutputLine(remainder, provider)) emitted.push(remainder);
      state.buffer = '';
    } else if (remainder.length >= 28 && !isNoiseOutputPrefix(remainder, provider)) {
      emitted.push(remainder);
      state.buffer = '';
      directMode = true;
    }
  }

  state.directMode = directMode;
  return emitted.join('');
}

function streamNoiseFilterFlush(provider, state) {
  const tail = String(state.buffer || '');
  state.buffer = '';
  state.directMode = false;
  if (!tail) return '';
  if (isNoiseOutputLine(tail, provider)) return '';
  return tail;
}

function languageComplianceScore(text, targetLanguage) {
  const content = String(text || '').trim();
  if (!content) return 1;
  const tokens = content.toLowerCase().match(/[a-zçğıöşü']+/gi) || [];
  if (tokens.length < 6) return 1;

  const englishMarkers = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'is', 'are', 'of', 'to', 'in', 'on',
    'from', 'by', 'paper', 'study', 'analysis', 'summary', 'method', 'findings',
  ]);
  const turkishMarkers = new Set([
    've', 'ile', 'için', 'bu', 'şu', 'olarak', 'gibi', 'bir', 'da', 'de', 'ama',
    'ancak', 'çalışma', 'analiz', 'özet', 'yöntem', 'bulgu', 'sonuç',
  ]);

  let enHits = 0;
  let trHits = 0;
  for (const token of tokens) {
    if (englishMarkers.has(token)) enHits += 1;
    if (turkishMarkers.has(token)) trHits += 1;
  }
  const trCharHits = (content.match(/[çğıöşüÇĞİÖŞÜ]/g) || []).length;

  if (targetLanguage === 'tr') {
    let score = (trHits + Math.min(8, trCharHits)) / Math.max(1, enHits + trHits + 1);
    if (enHits > trHits * 2 + 3) score *= 0.55;
    return Math.max(0, Math.min(1, score));
  }
  if (targetLanguage === 'en') {
    let score = (enHits + 1) / Math.max(1, enHits + trHits + trCharHits + 1);
    if (trHits > enHits * 2 + 3) score *= 0.55;
    return Math.max(0, Math.min(1, score));
  }
  return 1;
}

function isLanguageCompliant(text, targetLanguage) {
  const target = normalizeOutputLanguage(targetLanguage);
  if (!target) return true;
  const threshold = target === 'tr' ? 0.68 : 0.6;
  return languageComplianceScore(text, target) >= threshold;
}

function languageRewritePrompt(text, targetLanguage) {
  const target = normalizeOutputLanguage(targetLanguage);
  const content = String(text || '').trim();
  if (!target || !content) return '';
  if (target === 'en') {
    return (
      'Rewrite the text below strictly in natural English. '
      + 'Preserve meaning exactly, keep factual content unchanged, do not add new information, '
      + 'do not remove important details, and avoid Turkish words unless they are unavoidable proper nouns. '
      + 'Keep an academic, concise, and comprehensive tone.\n\n'
      + "Do not include process narration such as 'I now have enough content' or 'I will now produce the output'.\n\n"
      + `Text:\n${content}`
    );
  }
  return (
    'Aşağıdaki metni sadece doğal Türkçe ile yeniden yaz. '
    + 'Anlamı birebir koru, olgusal içeriği değiştirme, yeni bilgi ekleme, önemli ayrıntıları silme, '
    + 'zorunlu özel adlar dışında yabancı kelime kullanma. '
    + 'Akademik, öz ve kapsayıcı bir üslup kullan. '
    + 'Türkçe karakterleri doğru kullan (ç, ğ, ı, İ, ö, ş, ü). '
    + "Yana not/süreç cümlesi yazma (ör. 'Yeterli içerik elde ettim', 'Çıktıyı şimdi üretiyorum').\n\n"
    + `Metin:\n${content}`
  );
}

function stripPromptDirectiveBlock(prompt, headers) {
  const text = String(prompt || '');
  if (!text) return '';
  const tokens = (headers || []).map((h) => String(h || '').trim()).filter(Boolean);
  if (!tokens.length) return text.trim();
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`(?:^|\\n)(?:${escaped})\\s*`, 'ig');
  let cutIdx = -1;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    cutIdx = match.index;
  }
  if (cutIdx < 0) return text.trim();
  return text.slice(0, cutIdx).trimEnd();
}

function applyTemplateRuleFromRequest(prompt) {
  return stripPromptDirectiveBlock(prompt, ['OUTPUT TEMPLATE:', 'ÇIKTI ŞABLONU:']);
}

function outputQualityInstruction(targetLanguage, requireVerifiedSources = false) {
  const lang = normalizeOutputLanguage(targetLanguage);
  if (lang === 'en') {
    const lines = [
      'Write strictly in the selected language; do not mix languages.',
      'Use concise but comprehensive academic style (neutral, technical, clear).',
      'No process narration, no filler, no hidden chain-of-thought.',
      'Do not output tool-call traces, plan updates, command traces, or JSON/debug fragments.',
      'Keep source titles in their original language and script; do not translate or transliterate source titles.',
      'When listing sources, keep titles plain text; avoid markdown wrappers around titles (**, __, [], ()).',
      'Do not invent claims, references, DOI, URL, datasets, or quotations.',
      'If evidence is uncertain or missing, label it explicitly as inference/limitation.',
    ];
    if (requireVerifiedSources) {
      lines.push('When external sources are used, cite only verified records and provide a short source list: Title — Year — DOI/URL.');
    }
    return lines.map((line) => `- ${line}`).join('\n');
  }

  const lines = [
    'Yalnızca seçili dilde yaz; dil karıştırma.',
    'Öz fakat kapsayıcı, akademik üslup kullan (tarafsız, teknik, açık).',
    'Süreç anlatımı, dolgu cümlesi ve iç düşünme metni yazma.',
    'Araç çağrı izi, plan güncellemesi, komut izi veya JSON/hata ayıklama parçaları yazma.',
    'Kaynak başlıklarını özgün dilinde ve yazımında koru; başlıkları çevirme veya dönüştürme.',
    'Kaynak listesinde başlıkları düz metin ver; başlıklarda markdown işaretleri (**, __, [ ], ( )) kullanma.',
    'İddia, kaynak, DOI, URL, veri seti veya alıntı uydurma.',
    'Kanıt eksikse bunu açıkça çıkarım/sınırlılık olarak etiketle.',
  ];
  if (requireVerifiedSources) {
    lines.push('Dış kaynak kullanılıyorsa yalnız doğrulanmış kayıtları kullan; kısa kaynak listesi ver: Başlık — Yıl — DOI/URL.');
  }
  return lines.map((line) => `- ${line}`).join('\n');
}

function applyOutputQualityRule(prompt, targetLanguage, requireVerifiedSources = false) {
  const base = stripPromptDirectiveBlock(prompt, ['OUTPUT QUALITY:', 'ÇIKTI KALİTESİ:']);
  const lang = normalizeOutputLanguage(targetLanguage);
  const header = lang === 'en' ? 'OUTPUT QUALITY:' : 'ÇIKTI KALİTESİ:';
  const rules = outputQualityInstruction(targetLanguage, requireVerifiedSources);
  return `${base}\n\n${header}\n${rules}`.trim();
}

function normalizeSourceRoutingMode(reqData) {
  const data = reqData || {};
  return toBool(data.sourceRoutingMode) || toBool(data.forceSourceRouting);
}

function sourceRoutingInstruction(targetLanguage) {
  const lang = normalizeOutputLanguage(targetLanguage);
  if (lang === 'en') {
    return [
      'Run external scholarly lookup automatically based on the current request when Zotero context is not enough.',
      'Do not output search-plan/query-suggestion sections unless the user explicitly asks for queries.',
      'Use only academic sources and verify each cited item before presenting it.',
      'If external evidence is limited, continue with an academic synthesis using Zotero context and clearly label inferences.',
      'Return a direct evidence-based answer and include a short source list (title, year, DOI/URL).',
    ].join('\n');
  }
  return [
    'Zotero bağlamı yetmezse mevcut isteğe göre dış akademik aramayı otomatik çalıştır.',
    'Kullanıcı açıkça istemedikçe arama planı/sorgu önerisi bölümü üretme.',
    'Yalnız akademik kaynak kullan ve sunmadan önce her kaynağı doğrula.',
    'Dış kanıt sınırlıysa Zotero bağlamıyla akademik bir sentezle devam et ve çıkarımı açıkça etiketle.',
    'Kanıta dayalı doğrudan yanıt ver ve kısa kaynak listesi ekle (başlık, yıl, DOI/URL).',
  ].join('\n');
}

function applySourceRoutingRuleFromRequest(prompt, reqData, targetLanguage) {
  const base = stripPromptDirectiveBlock(prompt, ['EXTERNAL SOURCE ROUTING:', 'DIŞ KAYNAK YÖNLENDİRME:']);
  if (!normalizeSourceRoutingMode(reqData)) return base;
  const lang = normalizeOutputLanguage(targetLanguage);
  const header = lang === 'en' ? 'EXTERNAL SOURCE ROUTING:' : 'DIŞ KAYNAK YÖNLENDİRME:';
  const instruction = sourceRoutingInstruction(targetLanguage);
  return `${base}\n\n${header}\n- ${instruction}`.trim();
}

function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'evet'].includes(normalized);
}

function aiResponseCacheTtlSeconds(analysisMode) {
  const mode = normalizeAnalysisMode(analysisMode);
  return Number(AI_RESPONSE_CACHE_TTL_SECONDS[mode] || AI_RESPONSE_CACHE_TTL_SECONDS.balanced);
}

function getCachedAiResponse(cacheKey) {
  const entry = AI_RESPONSE_CACHE.get(cacheKey);
  if (!entry) return null;
  if (Date.now() > Number(entry.expiresAt || 0)) {
    AI_RESPONSE_CACHE.delete(cacheKey);
    return null;
  }
  return { ...entry };
}

function setCachedAiResponse(cacheKey, payload, ttlSec) {
  const expiresAt = Date.now() + Math.max(1, Number(ttlSec || 1)) * 1000;
  AI_RESPONSE_CACHE.set(cacheKey, { ...payload, expiresAt, createdAt: Date.now() });

  if (AI_RESPONSE_CACHE.size > AI_RESPONSE_CACHE_MAX) {
    const entries = [...AI_RESPONSE_CACHE.entries()];
    entries.sort((a, b) => Number(a[1].expiresAt || 0) - Number(b[1].expiresAt || 0));
    const toDelete = Math.max(1, entries.length - AI_RESPONSE_CACHE_MAX);
    for (let i = 0; i < toDelete; i += 1) {
      AI_RESPONSE_CACHE.delete(entries[i][0]);
    }
  }
}

function bigPdfResultCacheTtlSeconds(analysisMode) {
  const mode = normalizeAnalysisMode(analysisMode);
  if (mode === 'fast') return 10 * 60;
  if (mode === 'deep') return 30 * 60;
  return 20 * 60;
}

function buildBigPdfResultCacheKey({
  itemKey = '',
  attachmentHash = '',
  query = '',
  analysisMode = 'balanced',
  outputLanguage = '',
  provider = '',
  model = '',
  chunkLimit = 0,
} = {}) {
  const safeItemKey = String(itemKey || '').trim() || '__item__';
  const safeAttachmentHash = String(attachmentHash || '').trim() || '__hash__';
  const safeMode = normalizeAnalysisMode(analysisMode);
  const safeLang = normalizeOutputLanguage(outputLanguage) || 'na';
  const safeProvider = normalizeProvider(provider || 'claude');
  const safeModel = String(model || '').trim() || '__default__';
  const safeChunkLimit = Math.max(0, Number(chunkLimit || 0));
  const queryHash = crypto
    .createHash('sha256')
    .update(String(query || '').trim().toLowerCase(), 'utf-8')
    .digest('hex')
    .slice(0, 20);

  return [
    BIG_PDF_PIPELINE_VERSION,
    safeItemKey,
    safeAttachmentHash,
    queryHash || '__query__',
    safeMode,
    safeLang,
    safeProvider,
    safeModel,
    `cl${safeChunkLimit}`,
  ].join('|');
}

function getCachedBigPdfResult(cacheKey) {
  const entry = BIG_PDF_RESULT_CACHE.get(cacheKey);
  if (!entry) return null;
  if (Date.now() > Number(entry.expiresAt || 0)) {
    BIG_PDF_RESULT_CACHE.delete(cacheKey);
    return null;
  }
  return { ...entry };
}

function setCachedBigPdfResult(cacheKey, payload, ttlSec) {
  const expiresAt = Date.now() + Math.max(1, Number(ttlSec || 1)) * 1000;
  BIG_PDF_RESULT_CACHE.set(cacheKey, { ...payload, expiresAt, createdAt: Date.now() });
  if (BIG_PDF_RESULT_CACHE.size > BIG_PDF_RESULT_CACHE_MAX) {
    const entries = [...BIG_PDF_RESULT_CACHE.entries()];
    entries.sort((a, b) => Number(a[1].createdAt || 0) - Number(b[1].createdAt || 0));
    const toDelete = Math.max(1, entries.length - BIG_PDF_RESULT_CACHE_MAX);
    for (let i = 0; i < toDelete; i += 1) {
      BIG_PDF_RESULT_CACHE.delete(entries[i][0]);
    }
  }
}

function cleanupInflightRequests() {
  const now = Date.now();
  for (const [key, entry] of INFLIGHT_AI_REQUESTS.entries()) {
    if (now - Number(entry.createdAt || now) > 12 * 60 * 1000) {
      INFLIGHT_AI_REQUESTS.delete(key);
    }
  }
}

function clearAllCaches() {
  TOOL_RESULT_CACHE.clear();
  AI_RESPONSE_CACHE.clear();
  EXTERNAL_SEARCH_CACHE.clear();
  BIG_PDF_RESULT_CACHE.clear();
  ZOTERO_LIBRARY_CACHE.clear();
}

function toolCacheProfileForPath(rawPath) {
  const pathOnly = String(rawPath || '').split('?', 1)[0];
  const patterns = [
    [/^\/api\/(users|groups)\/\d+\/items\/[A-Z0-9]{8}\/fulltext$/i, 'fulltext'],
    [/^\/api\/(users|groups)\/\d+\/items\/[A-Z0-9]{8}\/children$/i, 'notes'],
    [/^\/api\/(users|groups)\/\d+\/items\/[A-Z0-9]{8}$/i, 'metadata'],
  ];
  for (const [pattern, kind] of patterns) {
    if (pattern.test(pathOnly)) {
      return { kind, ttl: Number(TOOL_RESULT_CACHE_TTL_SECONDS[kind] || (5 * 60)) };
    }
  }
  return null;
}

function toolCacheKey(pathWithQuery) {
  return `GET|${String(pathWithQuery || '')}`;
}

function getCachedToolResult(cacheKey) {
  const entry = TOOL_RESULT_CACHE.get(cacheKey);
  if (!entry) return null;
  if (Date.now() > Number(entry.expiresAt || 0)) {
    TOOL_RESULT_CACHE.delete(cacheKey);
    return null;
  }
  return { ...entry };
}

function setCachedToolResult(cacheKey, payload, ttlSec) {
  const expiresAt = Date.now() + Math.max(1, Number(ttlSec || 1)) * 1000;
  TOOL_RESULT_CACHE.set(cacheKey, {
    ...payload,
    expiresAt,
    createdAt: Date.now(),
  });
  if (TOOL_RESULT_CACHE.size > TOOL_RESULT_CACHE_MAX) {
    const entries = [...TOOL_RESULT_CACHE.entries()];
    entries.sort((a, b) => Number(a[1].createdAt || 0) - Number(b[1].createdAt || 0));
    const toDelete = Math.max(1, entries.length - TOOL_RESULT_CACHE_MAX);
    for (let i = 0; i < toDelete; i += 1) {
      TOOL_RESULT_CACHE.delete(entries[i][0]);
    }
  }
}

function buildAiResponseCacheKey(reqData, prompt, provider, model, analysisMode) {
  const itemKey = String((reqData || {}).itemKey || '').trim();
  const contextKeys = Array.isArray(reqData?.contextKeys) ? reqData.contextKeys.slice(0, 8).join(',') : '';
  const compareKeys = Array.isArray(reqData?.compareKeys) ? reqData.compareKeys.slice(0, 8).join(',') : '';
  const sourceRoutingEnabled = normalizeSourceRoutingMode(reqData);
  const sourceRouting = sourceRoutingEnabled ? 'sr1' : 'sr0';
  const pipeline = toBool(reqData?.bigPdfPipeline) ? 'bp1' : 'bp0';
  const lang = normalizeOutputLanguage(reqData?.language || '');
  const mode = normalizeAnalysisMode(analysisMode);
  const normalizedProvider = normalizeProvider(provider);
  const modelToken = String(model || '').trim();
  const sourceQuery = sourceRoutingEnabled ? normalizeExternalSearchQuery(reqData, prompt) : '';
  const sourceHash = sourceRoutingEnabled
    ? crypto.createHash('sha256').update(String(sourceQuery || ''), 'utf-8').digest('hex').slice(0, 12)
    : 'none';

  const scope = [itemKey, contextKeys, compareKeys, pipeline, sourceRouting, sourceHash, lang].join('|');
  const promptHash = crypto.createHash('sha256').update(String(prompt || ''), 'utf-8').digest('hex').slice(0, 24);
  return `${scope}|${normalizedProvider}|${modelToken}|${mode}|${promptHash}`;
}

function normalizeItemApiBase(rawBase) {
  let base = String(rawBase || '').trim();
  if (!base) return '/api/users/0';
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.startsWith('/api/')) return '/api/users/0';
  if (!/^\/api\/(users|groups)\/\d+$/i.test(base)) return '/api/users/0';
  return base;
}

function itemApiBaseCandidates(reqData) {
  const provided = normalizeItemApiBase(reqData?.itemApiBase || '');
  const candidates = [provided];
  if (provided !== '/api/users/0') candidates.push('/api/users/0');
  return [...new Set(candidates)];
}

async function fetchZoteroApiJson(pathSuffix, timeoutMs = 12000) {
  let suffix = String(pathSuffix || '').trim();
  if (!suffix) throw new Error('Zotero API path is empty');
  if (!suffix.startsWith('/')) suffix = `/${suffix}`;
  const target = `${ZOTERO_API}${suffix}`;
  const { controller, timer } = timeoutSignal(timeoutMs);
  let resp;
  try {
    resp = await fetch(target, { method: 'GET', signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`Zotero API bağlantı hatası: ${String(e.message || e).slice(0, 220)}`);
  }
  clearTimeout(timer);
  const raw = await resp.text();
  if (!resp.ok) {
    const detail = String(raw || resp.statusText || '').slice(0, 220);
    throw new Error(`Zotero API ${resp.status}: ${detail || 'Not found'}`);
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function extractFulltextContent(payload) {
  const candidates = [];

  function collect(node) {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      const text = node.trim();
      if (text.length >= 80) candidates.push(text);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 30)) collect(item);
      return;
    }
    if (typeof node === 'object') {
      const preferredKeys = ['content', 'text', 'body', 'fulltext', 'fullText'];
      for (const key of preferredKeys) {
        if (key in node) collect(node[key]);
      }
      for (const [key, value] of Object.entries(node)) {
        if (preferredKeys.includes(key)) continue;
        if (typeof value === 'string' && value.trim().length >= 120) candidates.push(value.trim());
      }
    }
  }

  collect(payload);
  if (!candidates.length) return '';
  let best = '';
  for (const candidate of candidates) {
    if (candidate.length > best.length) best = candidate;
  }
  return best
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeMcpItemKey(args = {}) {
  return String(args.item_key || args.itemKey || '').trim().toUpperCase();
}

function normalizeMcpCollectionKey(args = {}) {
  return String(args.collection_key || args.collectionKey || '').trim().toUpperCase();
}

function normalizeMcpQuery(args = {}) {
  return String(args.query || args.q || '').trim();
}

function normalizeMcpLimit(rawValue, fallback = 10, max = 50) {
  const parsed = parseInt(String(rawValue ?? fallback).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function normalizeMcpItemApiBase(args = {}) {
  return normalizeItemApiBase(args.item_api_base || args.itemApiBase || '');
}

function stripHtmlToPlainText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function zoteroItemData(item) {
  return item && typeof item.data === 'object' ? item.data : {};
}

function zoteroItemTitle(item) {
  const data = zoteroItemData(item);
  return String(data.title || item?.title || item?.key || 'Untitled').trim() || String(item?.key || 'Untitled');
}

function zoteroItemDate(item) {
  const data = zoteroItemData(item);
  return String(data.date || data.accessDate || '').trim();
}

function zoteroItemYear(item) {
  const raw = zoteroItemDate(item);
  const match = raw.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : '';
}

function zoteroCreatorSummary(item) {
  const data = zoteroItemData(item);
  const creators = Array.isArray(data.creators) ? data.creators : [];
  const names = creators
    .map((row) => {
      const first = String(row?.firstName || '').trim();
      const last = String(row?.lastName || row?.name || '').trim();
      return [first, last].filter(Boolean).join(' ').trim();
    })
    .filter(Boolean);
  return names.length ? names.join('; ') : 'No authors listed';
}

function zoteroTagSummary(item) {
  const data = zoteroItemData(item);
  const tags = Array.isArray(data.tags) ? data.tags : [];
  return tags
    .map((row) => String(row?.tag || '').trim())
    .filter(Boolean)
    .slice(0, 20);
}

function zoteroVenueSummary(item) {
  const data = zoteroItemData(item);
  return String(
    data.publicationTitle
    || data.bookTitle
    || data.proceedingsTitle
    || data.publisher
    || data.university
    || data.websiteTitle
    || data.blogTitle
    || ''
  ).trim();
}

function zoteroDoi(item) {
  const data = zoteroItemData(item);
  return String(data.DOI || data.doi || '').trim();
}

function zoteroUrl(item) {
  const data = zoteroItemData(item);
  return String(data.url || '').trim();
}

function zoteroAbstract(item) {
  const data = zoteroItemData(item);
  return stripHtmlToPlainText(data.abstractNote || data.abstract || '');
}

function formatMetadataToolText(item, options = {}) {
  const includeAbstract = options.includeAbstract !== false;
  const type = String(zoteroItemData(item).itemType || item?.itemType || 'item').trim();
  const lines = [
    `# ${zoteroItemTitle(item)}`,
    '',
    `Type: ${type || '-'}`,
    '',
    `Item Key: ${String(item?.key || '').trim() || '-'}`,
  ];
  const date = zoteroItemDate(item);
  if (date) lines.push('', `Date: ${date}`);
  lines.push('', `Authors: ${zoteroCreatorSummary(item)}`);
  const venue = zoteroVenueSummary(item);
  if (venue) lines.push('', `Venue: ${venue}`);
  const doi = zoteroDoi(item);
  if (doi) lines.push('', `DOI: ${doi}`);
  const url = zoteroUrl(item);
  if (url) lines.push('', `URL: ${url}`);
  const tags = zoteroTagSummary(item);
  if (tags.length) lines.push('', `Tags: ${tags.join(', ')}`);
  const abstract = zoteroAbstract(item);
  if (includeAbstract && abstract) {
    lines.push('', '## Abstract', '', abstract);
  }
  return lines.join('\n').trim();
}

async function fetchItemWithFallback(itemKey, itemApiBase = '/api/users/0') {
  let lastError = null;
  for (const base of itemApiBaseCandidates({ itemApiBase })) {
    try {
      return await fetchZoteroApiJson(`${base}/items/${itemKey}?format=json`, 10000);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('Öğe bulunamadı.');
}

async function fetchItemChildrenWithFallback(itemKey, itemApiBase = '/api/users/0') {
  let lastError = null;
  for (const base of itemApiBaseCandidates({ itemApiBase })) {
    try {
      const rows = await fetchZoteroApiJson(`${base}/items/${itemKey}/children?format=json`, 10000);
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('Öğe çocukları alınamadı.');
}

async function fetchFulltextWithAttachmentFallback(itemKey, itemApiBase = '/api/users/0') {
  let metadata = null;
  let resolvedBase = '';

  for (const base of itemApiBaseCandidates({ itemApiBase })) {
    try {
      metadata = await fetchZoteroApiJson(`${base}/items/${itemKey}?format=json`, 10000);
      resolvedBase = base;
      break;
    } catch {
      // continue
    }
  }

  if (!metadata || !resolvedBase) {
    throw new Error('Seçili öğe için metadata alınamadı.');
  }

  try {
    const own = await fetchZoteroApiJson(`${resolvedBase}/items/${itemKey}/fulltext?format=json`, 12000);
    const content = extractFulltextContent(own);
    if (content) return { content, sourceKey: itemKey, item: metadata };
  } catch {
    // continue
  }

  const children = await fetchItemChildrenWithFallback(itemKey, resolvedBase);
  const attachmentKeys = children
    .filter((child) => {
      const data = zoteroItemData(child);
      return String(data.itemType || '').toLowerCase() === 'attachment'
        && String(data.contentType || '').toLowerCase() === 'application/pdf';
    })
    .map((child) => String(child?.key || '').trim())
    .filter(Boolean);

  for (const attachmentKey of attachmentKeys.slice(0, 8)) {
    try {
      const payload = await fetchZoteroApiJson(`${resolvedBase}/items/${attachmentKey}/fulltext?format=json`, 14000);
      const content = extractFulltextContent(payload);
      if (content) {
        return { content, sourceKey: attachmentKey, item: metadata };
      }
    } catch {
      // continue
    }
  }

  throw new Error('Zotero tam metni bulunamadı. PDF içeriği indekslenmemiş olabilir.');
}

function zoteroLibraryCacheKey(itemApiBase = '/api/users/0') {
  return `library-index:${normalizeItemApiBase(itemApiBase)}`;
}

function getCachedZoteroLibraryIndex(itemApiBase = '/api/users/0') {
  const key = zoteroLibraryCacheKey(itemApiBase);
  const cached = ZOTERO_LIBRARY_CACHE.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Math.floor(Date.now() / 1000)) {
    ZOTERO_LIBRARY_CACHE.delete(key);
    return null;
  }
  return cached.value || null;
}

function setCachedZoteroLibraryIndex(itemApiBase, value, ttlSeconds = ZOTERO_LIBRARY_CACHE_TTL_SECONDS) {
  const key = zoteroLibraryCacheKey(itemApiBase);
  ZOTERO_LIBRARY_CACHE.set(key, {
    expiresAt: Math.floor(Date.now() / 1000) + Math.max(60, Number(ttlSeconds || ZOTERO_LIBRARY_CACHE_TTL_SECONDS)),
    value,
  });
  if (ZOTERO_LIBRARY_CACHE.size > 12) {
    const oldest = ZOTERO_LIBRARY_CACHE.keys().next().value;
    if (oldest) ZOTERO_LIBRARY_CACHE.delete(oldest);
  }
}

async function fetchZoteroLibraryIndex(itemApiBase = '/api/users/0') {
  const cached = getCachedZoteroLibraryIndex(itemApiBase);
  if (cached) return cached;

  const rows = [];
  let start = 0;
  let total = Infinity;

  while (start < total) {
    const suffix = `${normalizeItemApiBase(itemApiBase)}/items/top?format=json&limit=100&start=${start}`;
    const target = `${ZOTERO_API}${suffix}`;
    const { controller, timer } = timeoutSignal(12000);
    const resp = await fetch(target, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) {
      const detail = String(await resp.text() || resp.statusText || '').slice(0, 180);
      throw new Error(`Zotero API ${resp.status}: ${detail || 'Not found'}`);
    }
    const page = await resp.json();
    const list = Array.isArray(page) ? page : [];
    total = Number(resp.headers.get('total-results') || list.length || 0);
    rows.push(...list.filter((item) => {
      const type = String(zoteroItemData(item).itemType || '').toLowerCase();
      return type && type !== 'attachment' && type !== 'note' && type !== 'annotation';
    }));
    if (!list.length) break;
    start += list.length;
  }

  setCachedZoteroLibraryIndex(itemApiBase, rows);
  return rows;
}

function normalizeSearchTokens(query) {
  const stopwords = new Set([
    'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'are', 'was', 'were',
    'bir', 've', 'ile', 'için', 'ama', 'gibi', 'olan', 'olanlar', 'daha', 'çok', 'son',
  ]);
  return String(query || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !stopwords.has(token));
}

function scoreZoteroLibraryItem(item, query, tokens) {
  const data = zoteroItemData(item);
  const title = zoteroItemTitle(item).toLowerCase();
  const abstract = zoteroAbstract(item).toLowerCase();
  const creators = zoteroCreatorSummary(item).toLowerCase();
  const venue = zoteroVenueSummary(item).toLowerCase();
  const tags = zoteroTagSummary(item).join(' ').toLowerCase();
  const haystack = `${title}\n${abstract}\n${creators}\n${venue}\n${tags}`;
  const normalizedQuery = String(query || '').trim().toLowerCase();

  let score = 0;
  if (normalizedQuery && title.includes(normalizedQuery)) score += 12;
  if (normalizedQuery && haystack.includes(normalizedQuery)) score += 6;

  for (const token of tokens) {
    if (title.includes(token)) score += 4.2;
    if (creators.includes(token)) score += 2.8;
    if (venue.includes(token)) score += 2.2;
    if (tags.includes(token)) score += 2.2;
    if (abstract.includes(token)) score += 1.6;
  }

  const year = parseInt(zoteroItemYear(item), 10);
  if (Number.isFinite(year)) {
    const freshness = Math.max(0, 1 - ((new Date().getFullYear() - year) / 14));
    score += freshness;
  }

  return score;
}

function formatSemanticSearchToolText(query, rows) {
  const lines = [`# Semantic Search Results for '${query}'`, '', `Found ${rows.length} similar items:`, ''];
  rows.forEach((item, idx) => {
    const data = zoteroItemData(item);
    const abstract = zoteroAbstract(item);
    const tags = zoteroTagSummary(item);
    lines.push(`## ${idx + 1}. ${zoteroItemTitle(item)}`);
    lines.push(`Similarity Score: ${Number(item?._score || 0).toFixed(3)}`);
    lines.push(`Type: ${String(data.itemType || '-').trim() || '-'}`);
    lines.push(`Item Key: ${String(item?.key || '').trim() || '-'}`);
    lines.push(`Authors: ${zoteroCreatorSummary(item)}`);
    if (zoteroItemDate(item)) lines.push(`Date: ${zoteroItemDate(item)}`);
    if (tags.length) lines.push(`Tags: ${tags.join(', ')}`);
    if (abstract) lines.push(`Abstract: ${abstract.slice(0, 260)}${abstract.length > 260 ? '...' : ''}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

function formatRecentItemsToolText(rows) {
  const lines = ['# Recently Added Items', ''];
  rows.forEach((item, idx) => {
    lines.push(`${idx + 1}. ${zoteroItemTitle(item)}`);
    lines.push(`   - Item Key: ${String(item?.key || '').trim() || '-'}`);
    lines.push(`   - Type: ${String(zoteroItemData(item).itemType || '-').trim() || '-'}`);
    if (zoteroItemDate(item)) lines.push(`   - Date: ${zoteroItemDate(item)}`);
    lines.push(`   - Authors: ${zoteroCreatorSummary(item)}`);
  });
  return lines.join('\n').trim();
}

function formatCollectionsToolText(rows) {
  const lines = ['# Collections', ''];
  rows.forEach((row, idx) => {
    const data = row && typeof row.data === 'object' ? row.data : {};
    lines.push(`${idx + 1}. ${String(data.name || row?.name || row?.key || 'Collection').trim()}`);
    lines.push(`   - Collection Key: ${String(row?.key || data.key || '').trim() || '-'}`);
    if (data.parentCollection) lines.push(`   - Parent: ${String(data.parentCollection || '').trim()}`);
  });
  return lines.join('\n').trim();
}

async function invokeInternalMcpTool(name, args = {}) {
  const toolName = String(name || '').trim();
  const itemApiBase = normalizeMcpItemApiBase(args);

  if (toolName === 'zotero_get_item_metadata') {
    const itemKey = normalizeMcpItemKey(args);
    if (!itemKey) throw new Error('item_key gerekli.');
    const item = await fetchItemWithFallback(itemKey, itemApiBase);
    const text = formatMetadataToolText(item, { includeAbstract: true });
    return { content: [{ type: 'text', text }], structuredContent: { result: text }, isError: false };
  }

  if (toolName === 'zotero_get_item_fulltext') {
    const itemKey = normalizeMcpItemKey(args);
    if (!itemKey) throw new Error('item_key gerekli.');
    const payload = await fetchFulltextWithAttachmentFallback(itemKey, itemApiBase);
    const text = [
      `# Full Text for ${zoteroItemTitle(payload.item)}`,
      '',
      `Item Key: ${itemKey}`,
      `Source Key: ${payload.sourceKey}`,
      '',
      payload.content,
    ].join('\n').trim();
    return { content: [{ type: 'text', text }], structuredContent: { result: text }, isError: false };
  }

  if (toolName === 'zotero_get_notes') {
    const itemKey = normalizeMcpItemKey(args);
    if (!itemKey) throw new Error('item_key gerekli.');
    const rows = await fetchItemChildrenWithFallback(itemKey, itemApiBase);
    const notes = rows
      .filter((row) => String(zoteroItemData(row).itemType || '').toLowerCase() === 'note')
      .map((row) => stripHtmlToPlainText(zoteroItemData(row).note || ''))
      .filter(Boolean);
    const text = notes.length
      ? ['# Notes', '', ...notes.map((note, idx) => `${idx + 1}. ${note}`)].join('\n').trim()
      : '# Notes\n\nNo notes found.';
    return { content: [{ type: 'text', text }], structuredContent: { result: text }, isError: false };
  }

  if (toolName === 'zotero_get_annotations') {
    const itemKey = normalizeMcpItemKey(args);
    if (!itemKey) throw new Error('item_key gerekli.');
    const rows = await fetchItemChildrenWithFallback(itemKey, itemApiBase);
    const annotations = rows
      .filter((row) => String(zoteroItemData(row).itemType || '').toLowerCase() === 'annotation')
      .map((row) => {
        const data = zoteroItemData(row);
        const selectedText = stripHtmlToPlainText(data.annotationText || '');
        const comment = stripHtmlToPlainText(data.annotationComment || '');
        const pageLabel = String(data.annotationPageLabel || '?').trim() || '?';
        return {
          selectedText,
          comment,
          pageLabel,
        };
      })
      .filter((row) => row.selectedText || row.comment);
    const text = annotations.length
      ? ['# Annotations', '', ...annotations.map((row, idx) => {
          const parts = [`${idx + 1}. Page ${row.pageLabel}`];
          if (row.selectedText) parts.push(`   - Text: ${row.selectedText}`);
          if (row.comment) parts.push(`   - Comment: ${row.comment}`);
          return parts.join('\n');
        })].join('\n').trim()
      : '# Annotations\n\nNo annotations found.';
    return { content: [{ type: 'text', text }], structuredContent: { result: text }, isError: false };
  }

  if (toolName === 'zotero_semantic_search' || toolName === 'zotero_search_items') {
    const query = normalizeMcpQuery(args);
    if (!query) throw new Error('query gerekli.');
    const limit = normalizeMcpLimit(args.limit, 10, 25);
    const rows = await fetchZoteroLibraryIndex(itemApiBase);
    const tokens = normalizeSearchTokens(query);
    const ranked = rows
      .map((item) => ({ ...item, _score: scoreZoteroLibraryItem(item, query, tokens) }))
      .filter((item) => Number(item._score || 0) > 0)
      .sort((a, b) => Number(b._score || 0) - Number(a._score || 0))
      .slice(0, limit);
    const text = formatSemanticSearchToolText(query, ranked);
    return { content: [{ type: 'text', text }], structuredContent: { result: text }, isError: false };
  }

  if (toolName === 'zotero_get_recent') {
    const limit = normalizeMcpLimit(args.limit, 10, 25);
    const rows = await fetchZoteroApiJson(`${itemApiBase}/items/top?format=json&sort=dateAdded&direction=desc&limit=${limit}`, 12000);
    const list = Array.isArray(rows) ? rows : [];
    const text = formatRecentItemsToolText(list);
    return { content: [{ type: 'text', text }], structuredContent: { result: text }, isError: false };
  }

  if (toolName === 'zotero_get_collections') {
    const limit = normalizeMcpLimit(args.limit, 50, 100);
    const rows = await fetchZoteroApiJson(`${itemApiBase}/collections?format=json&limit=${limit}`, 12000);
    const list = Array.isArray(rows) ? rows : [];
    const text = formatCollectionsToolText(list);
    return { content: [{ type: 'text', text }], structuredContent: { result: text }, isError: false };
  }

  if (toolName === 'zotero_get_collection_items') {
    const collectionKey = normalizeMcpCollectionKey(args);
    if (!collectionKey) throw new Error('collection_key gerekli.');
    const limit = normalizeMcpLimit(args.limit, 25, 100);
    const rows = await fetchZoteroApiJson(`${itemApiBase}/collections/${collectionKey}/items/top?format=json&limit=${limit}`, 12000);
    const list = Array.isArray(rows) ? rows : [];
    const text = formatRecentItemsToolText(list);
    return { content: [{ type: 'text', text }], structuredContent: { result: text }, isError: false };
  }

  throw new Error(`Desteklenmeyen tool: ${toolName}`);
}

function normalizeSectionHeadingLine(line) {
  const base = String(line || '')
    .replace(/^#+\s*/, '')
    .replace(/^\(?\d+(?:\.\d+)*\)?[\s).:-]+/, '')
    .replace(/^[IVXLCDM]+[\s).:-]+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return base;
}

function detectSectionHeadingInfo(line) {
  const normalizedLine = normalizeSectionHeadingLine(line);
  if (!normalizedLine) return null;
  if (normalizedLine.length < 3 || normalizedLine.length > 90) return null;
  const lower = normalizedLine.toLowerCase();
  const compact = lower.replace(/[:\-–—]+$/g, '').trim();

  const table = [
    { key: 'abstract', title: 'Abstract', priority: 3.0, re: /^(abstract|özet)$/i },
    { key: 'introduction', title: 'Introduction', priority: 2.5, re: /^(introduction|giriş)$/i },
    { key: 'background', title: 'Background', priority: 2.1, re: /^(background|arka plan)$/i },
    { key: 'literature', title: 'Literature Review', priority: 2.4, re: /^(literature review|related work|related works|literatür(?: taraması)?)$/i },
    { key: 'method', title: 'Method', priority: 3.1, re: /^(method|methods|methodology|materials and methods|yöntem|yöntemler|metodoloji)$/i },
    { key: 'data', title: 'Data', priority: 2.9, re: /^(data|dataset|datasets|veri|veri seti|veri setleri)$/i },
    { key: 'results', title: 'Results', priority: 3.3, re: /^(results?|findings?|bulgular|sonuçlar)$/i },
    { key: 'discussion', title: 'Discussion', priority: 3.0, re: /^(discussion|tartışma)$/i },
    { key: 'conclusion', title: 'Conclusion', priority: 3.2, re: /^(conclusion|conclusions|sonuç|sonuçlar ve öneriler|öneriler)$/i },
    { key: 'limitations', title: 'Limitations', priority: 2.8, re: /^(limitations?|sınırlılıklar)$/i },
    { key: 'references', title: 'References', priority: 1.0, re: /^(references|bibliography|kaynakça|referanslar)$/i },
    { key: 'appendix', title: 'Appendix', priority: 1.2, re: /^(appendix|ek|ekler)$/i },
  ];

  for (const row of table) {
    if (row.re.test(compact)) return { ...row, raw: normalizedLine };
  }

  const tokens = compact.split(/\s+/).filter(Boolean);
  const looksUpper = normalizedLine === normalizedLine.toUpperCase() && tokens.length <= 8;
  const looksTitleCase = tokens.length <= 8 && tokens.every((token) => /^[A-ZÇĞİÖŞÜ][a-zçğıöşü]+$/.test(token));
  if (looksUpper || looksTitleCase) {
    return {
      key: `section-${compact.replace(/[^a-z0-9]+/g, '-').slice(0, 24) || 'misc'}`,
      title: normalizedLine,
      priority: 1.8,
      raw: normalizedLine,
    };
  }

  return null;
}

function splitTextLinearForBigPdfPipeline(text, chunkSize, overlap, maxChunks, sectionMeta = {}) {
  const content = String(text || '').trim();
  if (!content) return [];

  const size = Math.max(1200, Number(chunkSize || 6400));
  const overlapLen = Math.max(0, Math.min(Number(overlap || 0), Math.floor(size / 3)));
  const maxChunkCount = Math.max(1, Number(maxChunks || 8));
  const sectionTitle = String(sectionMeta.sectionTitle || 'Body').trim() || 'Body';
  const sectionKey = String(sectionMeta.sectionKey || 'body').trim() || 'body';
  const sectionPriority = Math.max(0.6, Number(sectionMeta.sectionPriority || 1.5));
  const offset = Math.max(0, Number(sectionMeta.offset || 0));

  const out = [];
  let cursor = 0;
  while (cursor < content.length && out.length < maxChunkCount) {
    let end = Math.min(content.length, cursor + size);
    if (end < content.length) {
      const paraBreak = content.lastIndexOf('\n\n', end);
      const sentenceBreak = Math.max(content.lastIndexOf('. ', end), content.lastIndexOf('। ', end));
      const splitPoint = Math.max(paraBreak, sentenceBreak);
      if (splitPoint > cursor + Math.floor(size * 0.5)) {
        end = splitPoint === sentenceBreak ? splitPoint + 1 : splitPoint;
      }
    }

    const chunkText = content.slice(cursor, end).trim();
    if (chunkText) {
      out.push({
        text: chunkText,
        sectionTitle,
        sectionKey,
        sectionPriority,
        start: offset + cursor,
        end: offset + end,
      });
    }
    if (end >= content.length) break;
    cursor = Math.max(cursor + 1, end - overlapLen);
  }

  return out;
}

function scorePipelineChunk(chunk, queryTerms, textLength) {
  const row = chunk && typeof chunk === 'object' ? chunk : {};
  const text = String(row.text || '');
  const sectionTitle = String(row.sectionTitle || '').toLowerCase();
  const sectionPriority = Math.max(0.6, Number(row.sectionPriority || 1.0));
  const start = Math.max(0, Number(row.start || 0));
  let score = sectionPriority * 2;

  const keywordBoost = /(result|findings|conclusion|discussion|method|yöntem|bulgu|sonuç|tartışma)/i.test(sectionTitle) ? 1.4 : 0;
  score += keywordBoost;

  if (Array.isArray(queryTerms) && queryTerms.length) {
    const lower = text.toLowerCase();
    let hits = 0;
    for (const token of queryTerms) {
      const t = String(token || '').toLowerCase().trim();
      if (!t || t.length < 3) continue;
      if (lower.includes(t)) hits += 1;
    }
    score += hits * 0.85;
  }

  const earlyBias = 1 - Math.min(0.55, start / Math.max(1, textLength * 1.8));
  score += earlyBias;

  if (text.length >= 2200 && text.length <= 7600) score += 0.4;
  if (text.length < 900) score -= 0.6;
  return score;
}

function splitTextForBigPdfPipeline(text, chunkSize, overlap, maxChunks, options = {}) {
  const content = String(text || '').trim();
  if (!content) return [];
  const maxChunkCount = Math.max(1, Number(maxChunks || 8));
  const queryTerms = extractExternalQueryKeywords(String(options.query || ''), 12);
  const sectionAware = options.sectionAware !== false;

  if (!sectionAware) {
    return splitTextLinearForBigPdfPipeline(content, chunkSize, overlap, maxChunkCount, {
      sectionTitle: 'Body',
      sectionKey: 'body',
      sectionPriority: 1.5,
      offset: 0,
    });
  }

  const lines = content.split('\n');
  const boundaries = [{ index: 0, title: 'Body', key: 'body', priority: 1.5 }];
  let offset = 0;
  for (const line of lines) {
    const heading = detectSectionHeadingInfo(line);
    const lineStart = offset;
    offset += line.length + 1;
    if (!heading) continue;
    if (lineStart < 600) continue;
    if (content.length - lineStart < 700) continue;
    const prev = boundaries[boundaries.length - 1];
    if (Math.abs(lineStart - Number(prev?.index || 0)) < 420) continue;
    boundaries.push({
      index: lineStart,
      title: heading.title || heading.raw || 'Section',
      key: heading.key || 'section',
      priority: Number(heading.priority || 1.8),
    });
  }

  if (boundaries.length <= 1) {
    return splitTextLinearForBigPdfPipeline(content, chunkSize, overlap, maxChunkCount, {
      sectionTitle: 'Body',
      sectionKey: 'body',
      sectionPriority: 1.5,
      offset: 0,
    });
  }

  const chunkPool = [];
  for (let i = 0; i < boundaries.length; i += 1) {
    const start = boundaries[i].index;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].index : content.length;
    const segment = content.slice(start, end).trim();
    if (!segment) continue;
    const localChunks = splitTextLinearForBigPdfPipeline(segment, chunkSize, overlap, Math.max(1, maxChunkCount * 3), {
      sectionTitle: boundaries[i].title,
      sectionKey: boundaries[i].key,
      sectionPriority: boundaries[i].priority,
      offset: start,
    });
    chunkPool.push(...localChunks);
  }

  if (!chunkPool.length) {
    return splitTextLinearForBigPdfPipeline(content, chunkSize, overlap, maxChunkCount, {
      sectionTitle: 'Body',
      sectionKey: 'body',
      sectionPriority: 1.5,
      offset: 0,
    });
  }

  if (chunkPool.length <= maxChunkCount) {
    return chunkPool.sort((a, b) => Number(a.start || 0) - Number(b.start || 0));
  }

  const ranked = chunkPool
    .map((chunk, idx) => ({
      ...chunk,
      _idx: idx,
      _score: scorePipelineChunk(chunk, queryTerms, content.length),
    }))
    .sort((a, b) => Number(b._score || 0) - Number(a._score || 0) || Number(a.start || 0) - Number(b.start || 0))
    .slice(0, maxChunkCount)
    .sort((a, b) => Number(a.start || 0) - Number(b.start || 0));

  return ranked.map((row) => {
    const { _idx, _score, ...rest } = row;
    return rest;
  });
}

function bigPdfPipelineConfig(analysisMode) {
  const mode = normalizeAnalysisMode(analysisMode);
  if (mode === 'fast') {
    return {
      chunkSize: 5200,
      chunkOverlap: 320,
      maxChunks: 4,
      maxSourceChars: 5200 * 5,
      chunkAnalysisMode: 'fast',
      sectionAware: true,
    };
  }
  if (mode === 'deep') {
    return {
      chunkSize: 7600,
      chunkOverlap: 520,
      maxChunks: 12,
      maxSourceChars: 7600 * 13,
      chunkAnalysisMode: 'balanced',
      sectionAware: true,
    };
  }
  return {
    chunkSize: 6400,
    chunkOverlap: 420,
    maxChunks: 8,
    maxSourceChars: 6400 * 9,
    chunkAnalysisMode: 'balanced',
    sectionAware: true,
  };
}

function adaptBigPdfPipelineConfig(baseConfig, fulltextLength, analysisMode, query = '', requestedChunkLimit = 0) {
  const config = { ...(baseConfig || {}) };
  const mode = normalizeAnalysisMode(analysisMode);
  const totalLen = Math.max(0, Number(fulltextLength || 0));
  const requestedLimit = Math.max(0, Number(requestedChunkLimit || 0));
  const queryText = String(query || '').trim();
  const queryComplexity =
    (queryText.length > 160 ? 2 : queryText.length > 90 ? 1 : 0)
    + (/(compare|comparison|critical|critique|benchmark|derive|synthesis|karşılaştır|eleştiri|kritik|sentez|yöntem|method)/i.test(queryText) ? 1 : 0);

  let minChunks;
  let maxChunks;
  let targetChunkSize;
  if (mode === 'fast') {
    minChunks = 2;
    maxChunks = 6;
    targetChunkSize = 5600;
  } else if (mode === 'deep') {
    minChunks = 5;
    maxChunks = 14;
    targetChunkSize = 6200;
  } else {
    minChunks = 3;
    maxChunks = 10;
    targetChunkSize = 6000;
  }

  if (totalLen >= 100000) targetChunkSize = Math.max(4200, targetChunkSize - 800);
  if (totalLen <= 14000) targetChunkSize = Math.max(targetChunkSize, Math.ceil(totalLen / Math.max(1, minChunks)));

  const sourceCap = Math.min(totalLen || config.maxSourceChars, config.maxSourceChars);
  let desiredChunks = Math.ceil(Math.max(1, sourceCap) / Math.max(2400, targetChunkSize));
  desiredChunks += queryComplexity;
  desiredChunks = Math.max(minChunks, Math.min(maxChunks, desiredChunks));

  if (requestedLimit > 0) desiredChunks = Math.min(desiredChunks, requestedLimit);
  config.maxChunks = Math.max(1, desiredChunks);
  config.chunkSize = Math.max(2600, Math.min(8600, Math.round(Math.max(3200, sourceCap / Math.max(1, config.maxChunks)))));
  config.chunkOverlap = Math.max(220, Math.min(900, Math.round(config.chunkSize * 0.08)));

  const dynamicSourceCap = Math.max(
    Number(config.maxSourceChars || 0),
    config.chunkSize * Math.max(4, config.maxChunks + 1)
  );
  config.maxSourceChars = Math.min(
    mode === 'deep' ? 220000 : 170000,
    Math.max(dynamicSourceCap, Number(config.maxSourceChars || 0))
  );

  return config;
}

function zoteroEvidencePromptConfig(analysisMode, documentCount = 1) {
  const mode = normalizeAnalysisMode(analysisMode);
  const docs = Math.max(1, Math.min(4, Number(documentCount || 1)));
  if (mode === 'fast') {
    return {
      chunkSize: 2600,
      chunkOverlap: 140,
      maxChunks: docs >= 3 ? 2 : 3,
      maxInputChars: docs >= 3 ? 9000 : 12000,
      maxExcerptChars: docs >= 3 ? 680 : 860,
      abstractChars: 420,
    };
  }
  if (mode === 'deep') {
    return {
      chunkSize: 3400,
      chunkOverlap: 220,
      maxChunks: docs >= 3 ? 4 : 5,
      maxInputChars: docs >= 3 ? 22000 : 32000,
      maxExcerptChars: docs >= 3 ? 1400 : 1800,
      abstractChars: 760,
    };
  }
  return {
    chunkSize: 3000,
    chunkOverlap: 180,
    maxChunks: docs >= 3 ? 3 : 4,
    maxInputChars: docs >= 3 ? 16000 : 22000,
    maxExcerptChars: docs >= 3 ? 980 : 1300,
    abstractChars: 560,
  };
}

function buildPromptEvidenceExcerpt(fulltext, query, analysisMode = 'balanced', documentCount = 1) {
  const source = String(fulltext || '').trim();
  if (!source) return '';

  const cfg = zoteroEvidencePromptConfig(analysisMode, documentCount);
  const working = source.slice(0, cfg.maxInputChars).trim();
  if (!working) return '';

  const chunks = splitTextForBigPdfPipeline(
    working,
    cfg.chunkSize,
    cfg.chunkOverlap,
    cfg.maxChunks,
    { query, sectionAware: true }
  );

  if (!chunks.length) {
    return compactExternalText(working, cfg.maxExcerptChars);
  }

  const pieces = [];
  let remaining = cfg.maxExcerptChars;
  for (const chunk of chunks) {
    if (remaining < 180) break;
    const sectionTitle = String(chunk.sectionTitle || '').trim();
    const prefix = sectionTitle && sectionTitle.toLowerCase() !== 'body' ? `[${sectionTitle}] ` : '';
    const perChunkCap = Math.min(
      remaining,
      Math.max(220, Math.floor(cfg.maxExcerptChars / Math.max(1, cfg.maxChunks)) + 120)
    );
    const excerpt = compactExternalText(`${prefix}${chunk.text || ''}`, perChunkCap);
    if (!excerpt) continue;
    pieces.push(excerpt);
    remaining -= excerpt.length + 2;
  }

  if (!pieces.length) {
    return compactExternalText(working, cfg.maxExcerptChars);
  }
  return pieces.join('\n');
}

function collectPromptEvidenceItemKeys(reqData = {}) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const key = String(value || '').trim().toUpperCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };

  push(reqData?.itemKey);
  (Array.isArray(reqData?.compareKeys) ? reqData.compareKeys : []).slice(0, 3).forEach(push);
  (Array.isArray(reqData?.contextKeys) ? reqData.contextKeys : []).slice(0, 3).forEach(push);
  return out.slice(0, 4);
}

async function buildAutoZoteroEvidenceContext(reqData, prompt, analysisMode, outputLanguage) {
  const itemKeys = collectPromptEvidenceItemKeys(reqData);
  if (!itemKeys.length) return '';

  const mode = normalizeAnalysisMode(analysisMode);
  const language = normalizeOutputLanguage(outputLanguage);
  const docCount = itemKeys.length;
  const cfg = zoteroEvidencePromptConfig(mode, docCount);
  const lines = [];

  if (language === 'en') {
    lines.push('AUTO ZOTERO EVIDENCE CONTEXT:');
    lines.push('Use the validated Zotero evidence below directly. These snippets were retrieved automatically from Zotero abstracts or PDF full text, including attachment fallback when needed.');
  } else {
    lines.push('OTOMATİK ZOTERO KANIT BAĞLAMI:');
    lines.push('Aşağıdaki doğrulanmış Zotero kanıtlarını doğrudan kullan. Bu parçalar Zotero özetlerinden veya PDF tam metninden otomatik alındı; gerektiğinde ek dosya fallback’i kullanıldı.');
  }

  for (const itemKey of itemKeys) {
    try {
      const item = await fetchItemWithFallback(itemKey, reqData?.itemApiBase || '/api/users/0');
      const title = zoteroItemTitle(item);
      const authors = zoteroCreatorSummary(item);
      const date = zoteroItemDate(item);
      const venue = zoteroVenueSummary(item);
      const doi = zoteroDoi(item);
      const abstract = zoteroAbstract(item);

      let fulltext = '';
      let sourceKey = '';
      try {
        const payload = await fetchFulltextWithAttachmentFallback(itemKey, reqData?.itemApiBase || '/api/users/0');
        fulltext = String(payload?.content || '').trim();
        sourceKey = String(payload?.sourceKey || '').trim();
      } catch {
        fulltext = '';
        sourceKey = '';
      }

      const excerpt = fulltext
        ? buildPromptEvidenceExcerpt(fulltext, prompt, mode, docCount)
        : '';
      const abstractSnippet = abstract ? compactExternalText(abstract, cfg.abstractChars) : '';

      if (!excerpt && !abstractSnippet) continue;

      lines.push('');
      lines.push(`### ${title} (key: ${itemKey})`);
      lines.push(language === 'en' ? `- Authors: ${authors}` : `- Yazarlar: ${authors}`);
      if (date) lines.push(language === 'en' ? `- Date: ${date}` : `- Tarih: ${date}`);
      if (venue) lines.push(language === 'en' ? `- Venue: ${venue}` : `- Yayın: ${venue}`);
      if (doi) lines.push(`- DOI: ${doi}`);
      if (excerpt) {
        const sourceNote = sourceKey && sourceKey !== itemKey
          ? (language === 'en' ? ` (from PDF attachment ${sourceKey})` : ` (PDF eki ${sourceKey} üzerinden)`)
          : '';
        lines.push(language === 'en' ? `- Full-text evidence${sourceNote}:` : `- Tam metin kanıtı${sourceNote}:`);
        lines.push(excerpt);
      } else {
        lines.push(language === 'en' ? '- Abstract evidence:' : '- Özet kanıtı:');
        lines.push(abstractSnippet);
      }
    } catch {
      // Best-effort only.
    }
  }

  return lines.length > 2 ? lines.join('\n').trim() : '';
}

function normalizeBigPdfQuery(reqData, fallbackPrompt, targetLanguage) {
  const query = String(reqData?.bigPdfQuery || '').trim();
  if (query) return query;
  const fallback = String(fallbackPrompt || '').trim();
  if (fallback) return fallback;
  return normalizeOutputLanguage(targetLanguage) === 'en'
    ? 'Analyze the full PDF in detail.'
    : "PDF'nin tamamını ayrıntılı analiz et.";
}

function normalizePipelineChunkLimit(rawLimit) {
  const candidate = String(rawLimit || '').trim().toLowerCase();
  if (!candidate || ['auto', 'default'].includes(candidate)) return 0;
  const parsed = Number(candidate);
  if (!Number.isFinite(parsed) || parsed < 2) return 0;
  return Math.min(16, Math.floor(parsed));
}

function buildBigPdfChunkPrompt(itemTitle, itemKey, userQuery, chunkText, chunkIndex, chunkTotal, targetLanguage, sectionTitle = '') {
  const lang = normalizeOutputLanguage(targetLanguage);
  const section = String(sectionTitle || '').trim() || (lang === 'en' ? 'Body' : 'Gövde');
  if (lang === 'en') {
    return [
      'You are analyzing a large PDF in chunks.',
      `Document: "${itemTitle}" (key: ${itemKey})`,
      `User goal: ${userQuery}`,
      `Chunk: ${chunkIndex}/${chunkTotal}`,
      `Section: ${section}`,
      '',
      'Rules:',
      '- Use ONLY the chunk text below.',
      '- Do not use outside knowledge.',
      '- If information is missing, state it clearly.',
      '- Write only in English, with concise but comprehensive academic style.',
      '- Do not include process narration.',
      '- Do not invent references, DOI/URL, or claims not grounded in this chunk.',
      '',
      'Output format:',
      '1) Chunk focus (1 sentence)',
      '2) Key points (4-6 bullets)',
      '3) Methods/data/findings in this chunk (bullets)',
      '4) Why this chunk matters for the user goal (2-3 bullets)',
      '',
      `Chunk text:\n${chunkText}`,
    ].join('\n');
  }

  return [
    'Büyük bir PDF parça parça analiz ediliyor.',
    `Doküman: "${itemTitle}" (key: ${itemKey})`,
    `Kullanıcı hedefi: ${userQuery}`,
    `Parça: ${chunkIndex}/${chunkTotal}`,
    `Bölüm: ${section}`,
    '',
    'Kurallar:',
    '- SADECE aşağıdaki parça metnini kullan.',
    '- Dış bilgi ekleme.',
    '- Bilgi eksikse açıkça belirt.',
    '- Yalnızca Türkçe yaz; öz fakat kapsayıcı akademik üslup kullan.',
    '- Süreç anlatımı yazma.',
    '- Bu parçada geçmeyen iddia, kaynak, DOI/URL uydurma.',
    '',
    'Çıktı formatı:',
    '1) Parça odağı (1 cümle)',
    '2) Ana noktalar (4-6 madde)',
    '3) Bu parçada geçen yöntem/veri/bulgu (maddeler)',
    '4) Kullanıcı hedefine katkısı (2-3 madde)',
    '',
    `Parça metni:\n${chunkText}`,
  ].join('\n');
}

function buildBigPdfFinalPrompt(itemTitle, itemKey, userQuery, chunkSummaries, targetLanguage) {
  const joined = chunkSummaries.join('\n\n');
  const lang = normalizeOutputLanguage(targetLanguage);
  if (lang === 'en') {
    return [
      `Using the chunk summaries below, produce a single coherent final analysis for "${itemTitle}" (key: ${itemKey}).`,
      `User goal: ${userQuery}`,
      '',
      'Rules:',
      '- Use ONLY the chunk summaries.',
      '- Keep claims grounded; mark missing or uncertain points.',
      '- Write only in English, in concise but comprehensive academic style.',
      '- No process narration and no fabricated references/DOI/URL.',
      '',
      'Citation rule (MANDATORY): Every factual sentence or bullet MUST end with at least one source tag like [Chunk 3].',
      'If multiple chunks support a claim, use multiple tags such as [Chunk 2][Chunk 5].',
      '',
      `Chunk summaries:\n${joined}`,
    ].join('\n');
  }

  return [
    `"${itemTitle}" (key: ${itemKey}) için aşağıdaki parça özetlerini birleştirerek tek bir nihai analiz üret.`,
    `Kullanıcı hedefi: ${userQuery}`,
    '',
    'Kurallar:',
    '- SADECE parça özetlerini kullan.',
    '- İddiaları kaynağa dayandır; eksik/belirsiz noktaları işaretle.',
    '- Yalnızca Türkçe yaz; öz fakat kapsayıcı akademik üslup kullan.',
    '- Süreç anlatımı ve uydurma kaynak/DOI/URL üretme.',
    '',
    'Kaynak etiketi kuralı (ZORUNLU): Her olgusal cümle veya madde sonuna en az bir kaynak etiketi ekle: [Parça 3].',
    'Aynı iddia birden fazla parçaya dayanıyorsa birden çok etiket kullan: [Parça 2][Parça 5].',
    '',
    `Parça özetleri:\n${joined}`,
  ].join('\n');
}

function buildBigPdfMergePrompt(itemTitle, itemKey, userQuery, batchSummaries, batchIndex, batchTotal, targetLanguage) {
  const lang = normalizeOutputLanguage(targetLanguage);
  const joined = (Array.isArray(batchSummaries) ? batchSummaries : []).join('\n\n');
  if (lang === 'en') {
    return [
      `Condense this chunk-summary batch for "${itemTitle}" (key: ${itemKey}).`,
      `User goal: ${userQuery}`,
      `Batch: ${batchIndex}/${batchTotal}`,
      '',
      'Rules:',
      '- Use only the summaries below.',
      '- Keep original evidence tags [Chunk n] exactly; do not invent new chunk ids.',
      '- Preserve key evidence, methods, and limitations.',
      '- Keep concise and structured.',
      '',
      'Output format:',
      '1) Batch highlights (4-8 bullets with [Chunk n])',
      '2) Evidence caveats (1-3 bullets with [Chunk n] when possible)',
      '',
      `Batch summaries:\n${joined}`,
    ].join('\n');
  }
  return [
    `"${itemTitle}" (key: ${itemKey}) için bu parça-özet grubunu yoğunlaştır.`,
    `Kullanıcı hedefi: ${userQuery}`,
    `Grup: ${batchIndex}/${batchTotal}`,
    '',
    'Kurallar:',
    '- Sadece aşağıdaki özetleri kullan.',
    '- Özgün kanıt etiketlerini [Parça n] aynen koru; yeni parça numarası uydurma.',
    '- Temel kanıt, yöntem ve sınırlılıkları koru.',
    '- Kısa ve yapılandırılmış yaz.',
    '',
    'Çıktı formatı:',
    '1) Grup öne çıkanları (4-8 madde, [Parça n] ile)',
    '2) Kanıt sınırlılıkları (1-3 madde, mümkünse [Parça n] ile)',
    '',
    `Grup özetleri:\n${joined}`,
  ].join('\n');
}

function enforceEvidenceAlignment(text, targetLanguage) {
  const content = String(text || '');
  if (!content) return content;

  const lang = normalizeOutputLanguage(targetLanguage);
  const inferenceTag = lang === 'en'
    ? '(Inference: citation unavailable)'
    : '(Çıkarım: kaynak etiketi yok)';
  const citationPattern = /\[(?:Parça|Chunk)\s*\d+\]|\((?:Kaynak|Source|Sources)\s*:\s*[\d,\s]+\)/i;
  const lines = content.split('\n');

  const out = lines.map((line) => {
    const raw = String(line || '');
    const trimmed = raw.trim();
    if (!trimmed) return raw;
    if (citationPattern.test(trimmed)) return raw;
    if (/\b(inference|çıkarım)\b/i.test(trimmed)) return raw;
    if (/^(#{1,6}\s+|sources?\s*:|kaynaklar?\s*:|doi\s*:|url\s*:)/i.test(trimmed)) return raw;

    const isBullet = /^\s*(?:[-*•]|\d+[.)])\s+/.test(trimmed);
    const minLen = isBullet ? 28 : 78;
    if (trimmed.length < minLen) return raw;
    if (/^\s*[A-ZÇĞİÖŞÜa-zçğıöşü][^.!?]{0,64}$/.test(trimmed)) return raw;

    const suffix = /[.!?)]$/.test(trimmed) ? ` ${inferenceTag}` : `. ${inferenceTag}`;
    return `${raw}${suffix}`;
  });

  return out.join('\n');
}

function hasPipelineCitations(text, targetLanguage) {
  const content = String(text || '');
  const lang = normalizeOutputLanguage(targetLanguage);
  if (lang === 'en') {
    return /\[Chunk\s*\d+\]/i.test(content) || /\((Source|Sources)\s*:\s*\d+/i.test(content);
  }
  return /\[Parça\s*\d+\]/i.test(content) || /\(Kaynak\s*:\s*\d+/i.test(content);
}

function formatPipelineCitationsForUsers(text, targetLanguage) {
  const content = String(text || '');
  if (!content) return content;
  const lang = normalizeOutputLanguage(targetLanguage);
  const sourceLabel = lang === 'en' ? 'Sources' : 'Kaynak';
  const normalized = content.replace(/\[(Parça|Chunk)\s*(\d+)\]/gi, '[$1 $2]');

  return normalized.replace(/(?:\[(?:Parça|Chunk)\s*\d+\]\s*)+/gi, (match) => {
    const nums = match.match(/\d+/g) || [];
    const unique = [...new Set(nums)];
    if (!unique.length) return match;
    return `(${sourceLabel}: ${unique.join(', ')})`;
  });
}

function modelCandidates(provider, requestedModel) {
  const requested = String(requestedModel || '').trim();
  const fallbackDefault = defaultModelForProvider(provider);
  const ordered = requested ? [requested, fallbackDefault, ''] : [fallbackDefault, ''];

  if (provider === 'codex') ordered.push('gpt-5-codex', 'gpt-5');
  if (provider === 'gemini') ordered.push('gemini-2.5-flash', 'gemini-2.5-pro');
  if (provider === 'claude') ordered.push('sonnet');

  return [...new Set(ordered.filter((x) => x !== undefined && x !== null))];
}

function maxModelCandidatesForMode(provider, analysisMode) {
  const mode = normalizeAnalysisMode(analysisMode);
  const limits = {
    fast: { claude: 1, codex: 1, gemini: 1 },
    balanced: { claude: 2, codex: 2, gemini: 2 },
    deep: { claude: 3, codex: 3, gemini: 2 },
  };
  return Number(limits[mode]?.[provider] || 1);
}

function attemptTimeoutSeconds(provider, model, analysisMode, variant = 'primary') {
  const mode = normalizeAnalysisMode(analysisMode);
  const normalized = normalizeProvider(provider);
  const table = {
    fast: {
      claude: { primary: 80 },
      codex: { primary: 95, secondary: 80 },
      gemini: { primary: 75, secondary: 75 },
    },
    balanced: {
      claude: { primary: 140 },
      codex: { primary: 170, secondary: 140 },
      gemini: { primary: 115, secondary: 110 },
    },
    deep: {
      claude: { primary: 220 },
      codex: { primary: 240, secondary: 190 },
      gemini: { primary: 185, secondary: 170 },
    },
  };

  let base = Number(table[mode]?.[normalized]?.[variant] || 120);
  const modelName = String(model || '').toLowerCase();
  if (normalized === 'gemini' && modelName.includes('pro')) base += 30;
  if (normalized === 'codex' && mode === 'deep' && modelName.includes('gpt-5')) base += 20;
  if (normalized === 'claude' && mode === 'deep' && modelName.includes('opus')) base += 30;
  return Math.max(40, base);
}

function useSecondaryAttemptVariant(provider, analysisMode) {
  const normalized = normalizeProvider(provider);
  const mode = normalizeAnalysisMode(analysisMode);
  if (normalized === 'codex' || normalized === 'gemini') return mode !== 'fast';
  return false;
}

function resolveZoteroMcpSetup() {
  const bundled = bundledMcpServerSetup();
  if (bundled) return bundled;

  const envCmd = String(process.env.ZOTERO_MCP_COMMAND || '').trim();
  const candidates = [envCmd, defaultZoteroMcpCommand()];
  if (isWin()) candidates.push('zotero-mcp.cmd', 'zotero-mcp.exe', 'zotero-mcp');
  else candidates.push('zotero-mcp');
  const command = resolveCommandFromCandidates(candidates) || 'zotero-mcp';
  return {
    kind: 'external',
    command,
    args: [],
    env: {},
  };
}

async function ensureClaudeMcpConfig(mcpSetup) {
  const command = String(mcpSetup?.command || 'zotero-mcp').trim() || 'zotero-mcp';
  const args = Array.isArray(mcpSetup?.args) ? mcpSetup.args.map((arg) => String(arg)) : [];
  const env = mcpSetup?.env && typeof mcpSetup.env === 'object' ? { ...mcpSetup.env } : {};
  const payload = {
    mcpServers: {
      'zotero-mcp': {
        command,
        args,
        env,
      },
    },
  };
  const current = await readJsonFileWithFallback(CLAUDE_MCP_CONFIG_FILE, CLAUDE_MCP_CONFIG_FILE_LEGACY);
  if (JSON.stringify(current) !== JSON.stringify(payload)) {
    await writeJsonFile(CLAUDE_MCP_CONFIG_FILE, payload);
  }
  return CLAUDE_MCP_CONFIG_FILE;
}

async function ensureGeminiWorkspaceSettings(mcpSetup) {
  const command = String(mcpSetup?.command || 'zotero-mcp').trim() || 'zotero-mcp';
  const args = Array.isArray(mcpSetup?.args) ? mcpSetup.args.map((arg) => String(arg)) : [];
  const env = mcpSetup?.env && typeof mcpSetup.env === 'object' ? { ...mcpSetup.env } : {};
  const current = await readJsonFile(GEMINI_WORKSPACE_SETTINGS_FILE);
  const settings = current && typeof current === 'object' ? { ...current } : {};
  const mcpServers = settings.mcpServers && typeof settings.mcpServers === 'object' ? { ...settings.mcpServers } : {};
  const existing = mcpServers['zotero-mcp'];
  mcpServers['zotero-mcp'] = {
    type: 'stdio',
    command,
    args,
    env,
  };
  settings.mcpServers = mcpServers;

  const mcpCfg = settings.mcp && typeof settings.mcp === 'object' ? { ...settings.mcp } : {};
  const allowed = Array.isArray(mcpCfg.allowed) ? [...mcpCfg.allowed] : [];
  if (!allowed.includes('zotero-mcp')) allowed.push('zotero-mcp');
  mcpCfg.allowed = allowed;
  settings.mcp = mcpCfg;

  if (JSON.stringify(settings) !== JSON.stringify(current || {})) {
    await writeJsonFile(GEMINI_WORKSPACE_SETTINGS_FILE, settings);
  }

  return GEMINI_WORKSPACE_SETTINGS_FILE;
}

async function ensureProviderMcpSetup(provider) {
  const mcpSetup = resolveZoteroMcpSetup();
  const setup = { ...mcpSetup };
  const normalized = normalizeProvider(provider);
  if (normalized === 'claude') {
    setup.claudeConfigPath = await ensureClaudeMcpConfig(mcpSetup);
  } else if (normalized === 'gemini') {
    setup.geminiSettingsPath = await ensureGeminiWorkspaceSettings(mcpSetup);
  } else if (normalized === 'codex') {
    setup.codexInline = true;
  }
  return setup;
}

function createAttemptOutputFile(provider = 'claude') {
  const normalized = normalizeProvider(provider || 'claude');
  const suffix = crypto.randomBytes(4).toString('hex');
  return path.join(RUNTIME_DIR, `.ai-last-message-${normalized}-${Date.now()}-${process.pid}-${suffix}.txt`);
}

async function getCliAttempts(provider, prompt, model, analysisMode = 'balanced') {
  const normalized = normalizeProvider(provider);
  const mode = normalizeAnalysisMode(analysisMode);

  const mcpSetup = await ensureProviderMcpSetup(normalized);
  const mcpCommand = mcpSetup.command || 'zotero-mcp';
  const mcpArgs = Array.isArray(mcpSetup.args) ? mcpSetup.args.map((arg) => String(arg)) : [];
  const mcpEnv = mcpSetup.env && typeof mcpSetup.env === 'object' ? { ...mcpSetup.env } : {};

  const claudeBin = resolveProviderCommand('claude');
  const codexBin = resolveProviderCommand('codex');
  const geminiBin = resolveProviderCommand('gemini');

  const candidates = modelCandidates(normalized, model).slice(0, maxModelCandidatesForMode(normalized, mode));
  const attempts = [];

  if (normalized === 'claude') {
    for (const candidate of candidates) {
      const cmd = [
        claudeBin,
        '-p',
        '--output-format',
        'text',
        '--mcp-config',
        mcpSetup.claudeConfigPath || CLAUDE_MCP_CONFIG_FILE,
        '--strict-mcp-config',
        '--allow-dangerously-skip-permissions',
        '--permission-mode',
        'bypassPermissions',
      ];
      if (candidate) cmd.push('--model', candidate);
      cmd.push(prompt);
      attempts.push({
        name: `claude -p${candidate ? ` --model ${candidate}` : ' (default model)'}`,
        cmd,
        unsetEnv: ['CLAUDECODE'],
        timeout: attemptTimeoutSeconds('claude', candidate, mode, 'primary'),
        cwd: RUNTIME_DIR,
        provider: 'claude',
        model: candidate || '',
      });
    }
    return attempts;
  }

  if (normalized === 'codex') {
    const mcpEscaped = String(mcpCommand || 'zotero-mcp').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const mcpArgsLiteral = JSON.stringify(mcpArgs);
    const mcpOverrides = [
      '-c',
      `mcp_servers.zotero-mcp.command="${mcpEscaped}"`,
      '-c',
      `mcp_servers.zotero-mcp.args=${mcpArgsLiteral}`,
    ];

    for (const candidate of candidates) {
      const outputFilePrimary = createAttemptOutputFile('codex');
      const modelArgs = candidate ? ['-m', candidate] : [];
      attempts.push({
        name: `codex exec (fast)${candidate ? ` -m ${candidate}` : ' (default model)'}`,
        cmd: [
          codexBin,
          'exec',
          '--full-auto',
          '--skip-git-repo-check',
          '-C',
          RUNTIME_DIR,
          '-c',
          'model_reasoning_effort="medium"',
          '-o',
          outputFilePrimary,
          ...mcpOverrides,
          ...modelArgs,
          prompt,
        ],
        timeout: attemptTimeoutSeconds('codex', candidate, mode, 'primary'),
        cwd: RUNTIME_DIR,
        provider: 'codex',
        model: candidate || '',
        outputFile: outputFilePrimary,
        setEnv: mcpEnv,
      });

      if (useSecondaryAttemptVariant('codex', mode)) {
        const outputFileSecondary = createAttemptOutputFile('codex');
        attempts.push({
          name: `codex exec (fallback low-effort)${candidate ? ` -m ${candidate}` : ' (default model)'}`,
          cmd: [
            codexBin,
            'exec',
            '--full-auto',
            '--skip-git-repo-check',
            '-C',
            RUNTIME_DIR,
            '-c',
            'model_reasoning_effort="low"',
            '-o',
            outputFileSecondary,
            ...mcpOverrides,
            ...modelArgs,
            prompt,
          ],
          timeout: attemptTimeoutSeconds('codex', candidate, mode, 'secondary'),
          cwd: RUNTIME_DIR,
          provider: 'codex',
          model: candidate || '',
          outputFile: outputFileSecondary,
          setEnv: mcpEnv,
        });
      }
    }
    return attempts;
  }

  for (const candidate of candidates) {
    const modelArgs = candidate ? ['--model', candidate] : [];
    attempts.push({
      name: `gemini -p + zotero-mcp${candidate ? ` --model ${candidate}` : ' (default model)'}`,
      cmd: [
        geminiBin,
        '-p',
        prompt,
        '--output-format',
        'text',
        '--approval-mode',
        'yolo',
        '--allowed-mcp-server-names',
        'zotero-mcp',
        ...modelArgs,
      ],
      timeout: attemptTimeoutSeconds('gemini', candidate, mode, 'primary'),
      cwd: RUNTIME_DIR,
      provider: 'gemini',
      model: candidate || '',
      setEnv: { NO_BROWSER: '1', ...mcpEnv },
    });

    if (useSecondaryAttemptVariant('gemini', mode)) {
      attempts.push({
        name: `gemini --prompt + zotero-mcp${candidate ? ` --model ${candidate}` : ' (default model)'}`,
        cmd: [
          geminiBin,
          '--prompt',
          prompt,
          '--output-format',
          'text',
          '--approval-mode',
          'yolo',
          '--allowed-mcp-server-names',
          'zotero-mcp',
          ...modelArgs,
        ],
        timeout: attemptTimeoutSeconds('gemini', candidate, mode, 'secondary'),
        cwd: RUNTIME_DIR,
        provider: 'gemini',
        model: candidate || '',
        setEnv: { NO_BROWSER: '1', ...mcpEnv },
      });
    }
  }

  return attempts;
}

async function runCommandAttempt(attempt, { stream = false, onChunk = null, abortSignal = null } = {}) {
  const provider = normalizeProvider(attempt.provider || 'claude');
  const startedAt = Date.now();
  const outputFile = String(attempt.outputFile || '').trim();
  const suppressStreamChunks = Boolean(outputFile);

  const env = { ...process.env };
  for (const key of attempt.unsetEnv || []) {
    delete env[key];
  }
  Object.assign(env, attempt.setEnv || {});
  enrichEnvPathForCli(env);

  const cmd = Array.isArray(attempt.cmd) ? attempt.cmd : [];
  if (!cmd.length) {
    const msg = `${attempt.name || 'attempt'}: invalid command`;
    updateProviderHealth(provider, 'degraded', msg, Date.now() - startedAt);
    providerCircuitOpen(provider, 'error', msg);
    return { ok: false, error: msg };
  }

  if (outputFile) {
    try {
      fs.unlinkSync(outputFile);
    } catch {
      // ignore
    }
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd[0], cmd.slice(1), {
        cwd: attempt.cwd || RUNTIME_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const msg = `${attempt.name}: CLI bulunamadı`;
      updateProviderHealth(provider, 'down', 'CLI not found', Date.now() - startedAt);
      providerCircuitOpen(provider, 'unavailable', msg);
      resolve({ ok: false, error: msg });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let spawnError = null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      const piece = String(chunk || '');
      stdout += piece;
      if (stream && typeof onChunk === 'function' && !suppressStreamChunks) onChunk(piece);
    });

    child.stderr.on('data', (chunk) => {
      const piece = String(chunk || '');
      stderr += piece;
      if (stream && typeof onChunk === 'function' && !suppressStreamChunks) onChunk(piece);
    });

    child.on('error', (e) => {
      spawnError = e;
    });

    const timeoutMs = Math.max(1000, Number(attempt.timeout || 120) * 1000);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // no-op
      }
    }, timeoutMs);

    let abortHandler = null;
    if (abortSignal) {
      abortHandler = () => {
        aborted = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // no-op
        }
      };
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    }

    child.on('close', async (code) => {
      clearTimeout(timer);
      if (abortSignal && abortHandler) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
      const cleanupOutputFile = async () => {
        if (!outputFile) return;
        try {
          await fsp.unlink(outputFile);
        } catch {
          // ignore
        }
      };

      const latencyMs = Date.now() - startedAt;

      if (aborted) {
        await cleanupOutputFile();
        resolve({ ok: false, error: 'Request aborted', aborted: true });
        return;
      }

      if (spawnError && spawnError.code === 'ENOENT') {
        const msg = `${attempt.name}: CLI bulunamadı`;
        updateProviderHealth(provider, 'down', 'CLI not found', latencyMs);
        providerCircuitOpen(provider, 'unavailable', msg);
        await cleanupOutputFile();
        resolve({ ok: false, error: msg });
        return;
      }

      if (timedOut) {
        const msg = `${attempt.name}: zaman aşımı (${attempt.timeout || 120}s)`;
        updateProviderHealth(provider, 'degraded', msg, latencyMs);
        providerCircuitOpen(provider, 'timeout', msg);
        await cleanupOutputFile();
        resolve({ ok: false, error: msg });
        return;
      }

      let fileOut = '';
      if (outputFile) {
        try {
          fileOut = String(await fsp.readFile(outputFile, 'utf-8') || '').trim();
        } catch {
          fileOut = '';
        }
        await cleanupOutputFile();
      }

      const out = String(fileOut || stdout || '').trim();
      const err = String(stderr || '').trim();

      if (code === 0) {
        updateProviderHealth(provider, 'ok', '', latencyMs);
        if (out) {
          resolve({ ok: true, output: out });
          return;
        }
        if (err) {
          resolve({ ok: true, output: err });
          return;
        }
        resolve({ ok: true, output: 'Yanıt boş geldi.' });
        return;
      }

      const rawMsg = err || out || `exit code ${code}`;
      const preferred = parseFirstRelevantError(rawMsg) || `exit code ${code}`;
      const msg = `${attempt.name}: ${preferred}`;
      updateProviderHealth(provider, 'degraded', msg, latencyMs);
      providerCircuitOpen(provider, providerFailureCategory(msg), msg);
      resolve({ ok: false, error: msg });
    });
  });
}

async function executeCliAttempts(attempts, options = {}) {
  const errors = [];
  for (const attempt of attempts) {
    const result = await runCommandAttempt(attempt, {
      stream: false,
      abortSignal: options.abortSignal,
    });
    if (result.aborted) return { output: null, errors, aborted: true };
    if (result.ok) return { output: result.output, errors };
    if (result.error) {
      errors.push(result.error);
      if (isRateLimitError(result.error)) {
        await sleep(Math.max(2000, Math.min(8000, 2000 + errors.length * 1000)));
      }
    }
  }
  return { output: null, errors };
}

async function executeCliAttemptsStream(attempts, options = {}) {
  const errors = [];
  for (let idx = 0; idx < attempts.length; idx += 1) {
    const attempt = attempts[idx];
    if (typeof options.onEvent === 'function') {
      options.onEvent({
        type: 'meta',
        phase: 'attempt_start',
        attempt: attempt.name || `attempt-${idx + 1}`,
        provider: normalizeProvider(attempt.provider || 'claude'),
      });
    }
    if (idx > 0 && typeof options.onEvent === 'function') {
      options.onEvent({ type: 'reset', reason: 'retry' });
    }

    const result = await runCommandAttempt(attempt, {
      stream: true,
      onChunk: options.onChunk,
      abortSignal: options.abortSignal,
    });

    if (result.aborted) return { output: null, errors, aborted: true };
    if (result.ok) return { output: result.output, errors };
    if (result.error) {
      errors.push(result.error);
      if (isRateLimitError(result.error)) {
        const waitSec = Math.max(2, Math.min(8, 2 + errors.length));
        if (typeof options.onEvent === 'function') {
          options.onEvent({ type: 'meta', phase: 'backoff', seconds: waitSec });
        }
        await sleep(waitSec * 1000);
      }
    }
  }
  return { output: null, errors };
}

async function executeWithProviderFallback(prompt, requestedProvider, requestedModel, analysisMode = 'balanced', options = {}) {
  const requested = normalizeProvider(requestedProvider);
  const providers = providerFallbackChainAvailable(requested);
  const allErrors = [];

  for (let providerIdx = 0; providerIdx < providers.length; providerIdx += 1) {
    const provider = providers[providerIdx];
    const circuit = providerCircuitState(provider);
    if (circuit.open) {
      const skipMsg = `circuit açık (${circuit.cooldownSec}s): ${circuit.reason || provider}`;
      allErrors.push(`${provider}: ${skipMsg}`);
      if (typeof options.onEvent === 'function') {
        options.onEvent({
          type: 'meta',
          phase: 'provider_skipped',
          provider,
          reason: 'circuit_open',
          cooldownSec: circuit.cooldownSec,
        });
      }
      continue;
    }

    const model = providerIdx === 0 ? requestedModel : '';
    const attempts = await getCliAttempts(provider, prompt, model, analysisMode);

    if (typeof options.onEvent === 'function') {
      options.onEvent({ type: 'meta', phase: 'provider_start', provider, fallbackIndex: providerIdx });
      if (providerIdx > 0) {
        options.onEvent({ type: 'reset', reason: 'provider_fallback', provider });
      }
    }

    let result;
    if (options.stream) {
      result = await executeCliAttemptsStream(attempts, {
        onChunk: options.onChunk,
        onEvent: options.onEvent,
        abortSignal: options.abortSignal,
      });
    } else {
      result = await executeCliAttempts(attempts, {
        abortSignal: options.abortSignal,
      });
    }

    if (result.aborted) {
      return {
        text: null,
        providerUsed: provider,
        fallbackUsed: providerIdx > 0 || provider !== requested,
        errors: [...allErrors],
        aborted: true,
      };
    }

    if (result.output) {
      return {
        text: result.output,
        providerUsed: provider,
        fallbackUsed: providerIdx > 0 || provider !== requested,
        errors: [...allErrors],
      };
    }

    for (const err of result.errors || []) {
      allErrors.push(`${provider}: ${err}`);
    }
  }

  return {
    text: null,
    providerUsed: requested,
    fallbackUsed: true,
    errors: allErrors,
  };
}

async function applyLanguagePostCheck(text, requestedProvider, requestedModel, targetLanguage, analysisMode = 'balanced') {
  const output = String(text || '');
  const target = normalizeOutputLanguage(targetLanguage);
  if (!output || !target) return { text: output, adjusted: false, errors: [] };
  if (isLanguageCompliant(output, target)) return { text: output, adjusted: false, errors: [] };

  const rewritePrompt = languageRewritePrompt(output, target);
  if (!rewritePrompt) return { text: output, adjusted: false, errors: [] };

  const rewrite = await executeWithProviderFallback(
    rewritePrompt,
    requestedProvider,
    requestedModel,
    analysisMode,
    { stream: false }
  );

  const rewritten = sanitizeProviderOutput(rewrite.text, rewrite.providerUsed || requestedProvider);
  if (rewritten && isLanguageCompliant(rewritten, target)) {
    return {
      text: rewritten,
      adjusted: true,
      errors: rewrite.errors || [],
    };
  }

  let rewriteErrors = [...(rewrite.errors || [])];
  if (target === 'tr') {
    const fallbackSource = rewritten || output;
    const strictPrompt = [
      'Aşağıdaki metni doğal ve akıcı Türkçe ile SON KEZ düzelt.',
      'Anlamı koru, bilgi ekleme/çıkarma yapma.',
      'Türkçe dilbilgisi ve noktalamaya tam uy.',
      'Türkçe karakterleri doğru kullan (ç, ğ, ı, İ, ö, ş, ü).',
      "Süreç anlatımı yazma (ör. 'Yeterli içerik elde ettim', 'Çıktıyı şimdi üretiyorum').",
      '',
      `Metin:\n${fallbackSource}`,
    ].join(' ');

    const second = await executeWithProviderFallback(
      strictPrompt,
      requestedProvider,
      requestedModel,
      analysisMode,
      { stream: false }
    );

    const secondText = sanitizeProviderOutput(second.text, second.providerUsed || requestedProvider);
    if (secondText && isLanguageCompliant(secondText, target)) {
      return {
        text: secondText,
        adjusted: true,
        errors: [...rewriteErrors, ...(second.errors || [])],
      };
    }
    rewriteErrors = [...rewriteErrors, ...(second.errors || [])];
  }

  return { text: output, adjusted: false, errors: rewriteErrors };
}

function decodeHtmlEntities(value) {
  const text = String(value || '');
  if (!text) return '';
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, token) => {
    if (!token) return match;
    if (token[0] === '#') {
      if (token[1] === 'x' || token[1] === 'X') {
        const parsed = Number.parseInt(token.slice(2), 16);
        if (Number.isFinite(parsed) && parsed > 0) return String.fromCodePoint(parsed);
        return match;
      }
      const parsed = Number.parseInt(token.slice(1), 10);
      if (Number.isFinite(parsed) && parsed > 0) return String.fromCodePoint(parsed);
      return match;
    }
    const key = token.toLowerCase();
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : match;
  });
}

function compactExternalText(value, maxLen = 260) {
  let text = String(value || '');
  if (!text) return '';
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeHtmlEntities(text);
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const maxChars = Math.max(60, Number(maxLen || 260));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function extractExternalQueryKeywords(value, limit = 8) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return [];
  const tokens = text.match(/[a-z0-9ğüşöçıİĞÜŞÖÇ]{3,}/gi) || [];
  if (!tokens.length) return [];
  const stopwords = new Set([
    'this', 'that', 'these', 'those', 'with', 'from', 'about', 'paper', 'papers', 'article', 'articles',
    'important', 'other', 'related', 'work', 'works', 'recent', 'latest', 'last', 'year', 'years',
    'what', 'which', 'show', 'find', 'sources', 'source',
    'bu', 'şu', 'konu', 'konuyla', 'konuda', 'ilgili', 'diğer', 'önemli', 'makale', 'makaleler',
    'kaynak', 'kaynaklar', 'neler', 'nedir', 'nedirler', 'son', 'yıl', 'yılda', 'yıldaki', 'için',
    'olarak', 'hakkında', 'üzerine', 've', 'veya',
  ]);

  const out = [];
  const seen = new Set();
  const cap = Math.max(3, Number(limit || 8));
  for (const token of tokens) {
    const clean = String(token || '').trim().toLowerCase();
    if (!clean || stopwords.has(clean) || /^\d+$/.test(clean)) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= cap) break;
  }
  return out;
}

function detectExternalYearFloor(reqData, prompt) {
  const rawMessage = String(reqData?.userMessage || '');
  const text = `${rawMessage}\n${String(prompt || '')}`.toLowerCase();
  const currentYear = new Date().getUTCFullYear();
  let yearsBack = null;

  const trMatch = /son\s+(\d{1,2})\s*y[ıi]l/i.exec(text);
  const enMatch = /last\s+(\d{1,2})\s+years?/i.exec(text);
  const trMonthMatch = /son\s+(\d{1,2})\s*ay/i.exec(text);
  const enMonthMatch = /(last|past)\s+(\d{1,2})\s+months?/i.exec(text);
  if (trMatch) yearsBack = Number(trMatch[1]);
  else if (enMatch) yearsBack = Number(enMatch[1]);
  else if (trMonthMatch) {
    const monthCount = Number(trMonthMatch[1]);
    yearsBack = monthCount <= 12 ? 1 : Math.max(1, Math.round(monthCount / 12));
  } else if (enMonthMatch) {
    const monthCount = Number(enMonthMatch[2]);
    yearsBack = monthCount <= 12 ? 1 : Math.max(1, Math.round(monthCount / 12));
  } else if (/\b(son bir yıl|son 1 yıl|geçen yıl|last year|past year|past 12 months|last 12 months)\b/i.test(text)) {
    yearsBack = 1;
  }

  if (yearsBack === null || !Number.isFinite(yearsBack)) return 0;
  yearsBack = Math.max(1, Math.min(10, Math.floor(yearsBack)));
  if (yearsBack === 1) return Math.max(1900, currentYear - 1);
  return Math.max(1900, currentYear - yearsBack + 1);
}

function buildExternalQueryCandidates(reqData, prompt, primaryQuery) {
  const query = compactExternalText(primaryQuery, 260);
  const selectedTitle = compactExternalText(reqData?.selectedItemTitle || '', 180);
  const rawMessage = String(reqData?.userMessage || '').trim();
  const keywords = extractExternalQueryKeywords(rawMessage, 6);
  const titleKeywords = extractExternalQueryKeywords(selectedTitle, 5);
  const yearFloor = detectExternalYearFloor(reqData, prompt);
  const currentYear = new Date().getUTCFullYear();

  const candidates = [];
  if (query) candidates.push(query);

  if (selectedTitle) {
    candidates.push(`"${selectedTitle}"`);
    candidates.push(`"${selectedTitle}" related work`);
    if (titleKeywords.length) {
      const titleBase = titleKeywords.slice(0, 5).join(' ').trim();
      if (titleBase) candidates.push(`${titleBase} related work`);
    }
    if (keywords.length) candidates.push(`"${selectedTitle}" ${keywords.slice(0, 5).join(' ')}`);
    if (yearFloor) {
      candidates.push(`"${selectedTitle}" ${yearFloor} ${currentYear} recent related work`);
      if (titleKeywords.length) candidates.push(`${titleKeywords.slice(0, 5).join(' ')} ${yearFloor} ${currentYear}`);
    }
  } else if (keywords.length) {
    const base = keywords.slice(0, 6).join(' ').trim();
    if (base) {
      candidates.push(base);
      if (yearFloor) candidates.push(`${base} ${yearFloor} ${currentYear}`);
    }
  } else if (titleKeywords.length) {
    const base = titleKeywords.slice(0, 5).join(' ').trim();
    if (base) {
      candidates.push(base);
      candidates.push(`${base} related work`);
      if (yearFloor) candidates.push(`${base} ${yearFloor} ${currentYear}`);
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const item of candidates) {
    const clean = compactExternalText(item, 260);
    if (!clean) continue;
    const norm = clean.toLowerCase().trim();
    if (seen.has(norm)) continue;
    seen.add(norm);
    deduped.push(clean);
    if (deduped.length >= 4) break;
  }
  return deduped.length ? deduped : (query ? [query] : []);
}

function normalizeExternalSearchQuery(reqData, prompt) {
  const rawMessage = String(reqData?.userMessage || '').trim();
  let selectedTitle = compactExternalText(reqData?.selectedItemTitle || '', 180);

  let cleanedMessage = rawMessage.replace(
    /\b(kaynak bul|find sources|özetle|summarize|notları analiz et|analyze notes|ilgili çalışmalar|related works|eleştirel değerlendirme|critical review)\b/gi,
    ' '
  );
  cleanedMessage = compactExternalText(cleanedMessage, 180).replace(/^[ :;,-]+|[ :;,-]+$/g, '');
  const extracted = extractExternalQueryKeywords(cleanedMessage, 7);
  cleanedMessage = extracted.join(' ').trim();
  if (!cleanedMessage && selectedTitle) {
    cleanedMessage = extractExternalQueryKeywords(selectedTitle, 5).join(' ').trim();
  }

  if (!selectedTitle) {
    const promptText = String(prompt || '');
    const quoted = /["“”']([^"“”']{8,220})["“”']/i.exec(promptText);
    if (quoted) selectedTitle = compactExternalText(quoted[1], 180);
  }

  const parts = [];
  if (selectedTitle) parts.push(`"${selectedTitle}"`);
  if (cleanedMessage && cleanedMessage.toLowerCase() !== selectedTitle.toLowerCase()) parts.push(cleanedMessage);

  let query = parts.join(' ').trim();
  if (!query) query = compactExternalText(prompt, 220);
  if (query.length > 260) query = query.slice(0, 260).trim();
  return query;
}

function externalSeedTerms(reqData, prompt, query) {
  const selectedTitle = compactExternalText(reqData?.selectedItemTitle || '', 180);
  const rawMessage = String(reqData?.userMessage || '').trim();
  const promptHead = String(prompt || '').split('\n\n', 1)[0];

  const terms = [];
  for (const sourceText of [selectedTitle, rawMessage, query, promptHead]) {
    const extracted = extractExternalQueryKeywords(sourceText, 8);
    for (const token of extracted) {
      const clean = String(token || '').trim().toLowerCase();
      if (!clean || terms.includes(clean)) continue;
      terms.push(clean);
      if (terms.length >= 12) return terms;
    }
  }
  return terms;
}

function topicalTermHitsForCandidate(row, seedTerms) {
  if (!row || typeof row !== 'object') return 0;
  const terms = Array.isArray(seedTerms) ? seedTerms : [];
  if (!terms.length) return 0;
  const title = compactExternalText(row.title || '', 320);
  const venue = compactExternalText(row.venue || '', 120);
  const abstract = compactExternalText(row.abstract || '', 360);
  const topics = Array.isArray(row.topics) ? row.topics : [];
  const topicsText = topics.slice(0, 10).map((x) => compactExternalText(x, 50)).filter(Boolean).join(' ');
  const haystack = `${title} ${venue} ${topicsText} ${abstract}`.toLowerCase().trim();
  if (!haystack) return 0;

  let hits = 0;
  for (const token of terms) {
    const term = String(token || '').trim().toLowerCase();
    if (!term || term.length < 3) continue;
    if (haystack.includes(term)) hits += 1;
  }
  return hits;
}

function externalSearchCacheKey(query, language) {
  const normalizedQuery = compactExternalText(query, 260).toLowerCase();
  const lang = normalizeOutputLanguage(language) || 'tr';
  const digest = crypto.createHash('sha256').update(`${lang}|${normalizedQuery}`, 'utf-8').digest('hex').slice(0, 20);
  return `ext:${lang}:${digest}`;
}

function getCachedExternalSearchResult(cacheKey) {
  const entry = EXTERNAL_SEARCH_CACHE.get(cacheKey);
  if (!entry) return null;
  if (Date.now() > Number(entry.expiresAt || 0)) {
    EXTERNAL_SEARCH_CACHE.delete(cacheKey);
    return null;
  }
  return { ...entry };
}

function setCachedExternalSearchResult(cacheKey, payload, ttlSeconds = EXTERNAL_SEARCH_CACHE_TTL_SECONDS) {
  const expiresAt = Date.now() + Math.max(1, Number(ttlSeconds || 1)) * 1000;
  EXTERNAL_SEARCH_CACHE.set(cacheKey, {
    ...payload,
    expiresAt,
    createdAt: Date.now(),
  });
  if (EXTERNAL_SEARCH_CACHE.size > EXTERNAL_SEARCH_CACHE_MAX) {
    const entries = [...EXTERNAL_SEARCH_CACHE.entries()];
    entries.sort((a, b) => Number(a[1].expiresAt || 0) - Number(b[1].expiresAt || 0));
    const toDelete = Math.max(1, entries.length - EXTERNAL_SEARCH_CACHE_MAX);
    for (let i = 0; i < toDelete; i += 1) {
      EXTERNAL_SEARCH_CACHE.delete(entries[i][0]);
    }
  }
}

async function fetchJsonUrl(url, timeoutSec = 8, headers = {}) {
  const timeoutMs = Math.max(2000, Number(timeoutSec || 8) * 1000);
  const { controller, timer } = timeoutSignal(timeoutMs);
  let resp;
  try {
    resp = await fetch(String(url || ''), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Orhon-Zotero-Dashboard/0.0.4',
        ...headers,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${String(raw || resp.statusText || '').slice(0, 200)}`);
  }
  if (!raw || !raw.trim()) return {};
  return JSON.parse(raw);
}

function normalizeExternalDoi(value) {
  let doi = String(value || '').trim();
  if (!doi) return '';
  doi = doi.replace(/^https?:\/\/doi\.org\//i, '');
  return doi.trim().toLowerCase();
}

function isValidExternalDoi(doi) {
  const candidate = normalizeExternalDoi(doi);
  if (!candidate) return false;
  return /^10\.\d{4,9}\/\S+$/i.test(candidate);
}

function normalizeExternalUrl(value) {
  let url = String(value || '').trim();
  if (!url) return '';
  if (/^doi:/i.test(url)) {
    const doiValue = normalizeExternalDoi(url.slice(4));
    return doiValue ? `https://doi.org/${doiValue}` : '';
  }
  if (/^https:\/\/openalex\.org\/W/i.test(url) && !/openalex\.org\/works\//i.test(url)) {
    const workId = url.split('/').pop()?.trim();
    if (workId) return `https://openalex.org/${workId}`;
  }
  if (!/^https?:\/\//i.test(url)) return '';
  return url;
}

function externalUrlHost(value) {
  const url = normalizeExternalUrl(value);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    let host = String(parsed.hostname || '').toLowerCase().trim();
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch {
    return '';
  }
}

function isTrustedAcademicHost(host) {
  const candidate = String(host || '').toLowerCase().trim();
  if (!candidate) return false;
  const trusted = new Set([
    'doi.org',
    'openalex.org',
    'api.openalex.org',
    'semanticscholar.org',
    'api.semanticscholar.org',
    'crossref.org',
    'api.crossref.org',
    'arxiv.org',
    'pubmed.ncbi.nlm.nih.gov',
    'ieeexplore.ieee.org',
    'dl.acm.org',
    'sciencedirect.com',
    'link.springer.com',
    'nature.com',
    'science.org',
    'jstor.org',
    'tandfonline.com',
    'onlinelibrary.wiley.com',
    'cambridge.org',
    'academic.oup.com',
    'frontiersin.org',
    'plos.org',
    'mdpi.com',
  ]);
  if (trusted.has(candidate)) return true;
  for (const domain of trusted) {
    if (candidate.endsWith(`.${domain}`)) return true;
  }
  return false;
}

function verifyExternalCandidate(row) {
  const item = row && typeof row === 'object' ? row : {};
  const title = compactExternalText(item.title || '', 320);
  if (title.length < 8) return [false, {}];

  let yearOk = true;
  const yearRaw = String(item.year || '').trim();
  if (yearRaw) {
    const year = Number(yearRaw);
    const currentYear = new Date().getUTCFullYear() + 1;
    yearOk = Number.isFinite(year) && year >= 1900 && year <= currentYear;
  }
  if (!yearOk) return [false, {}];

  let sources = Array.isArray(item.sources) ? item.sources : [];
  if (!sources.length) {
    const single = String(item.source || '').trim().toLowerCase();
    if (single) sources = [single];
  }
  sources = sources.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  const allowedSources = new Set(['openalex', 'semantic', 'crossref']);
  if (!sources.length || !sources.every((src) => allowedSources.has(src))) return [false, {}];

  const doi = normalizeExternalDoi(item.doi || '');
  const url = normalizeExternalUrl(item.url || '');
  const doiOk = isValidExternalDoi(doi);
  const host = externalUrlHost(url);
  const urlOk = Boolean(host && isTrustedAcademicHost(host));
  if (!doiOk && !urlOk) return [false, {}];

  let verification = 'DOI';
  if (doiOk && urlOk) verification = 'DOI+URL';
  else if (urlOk) verification = 'URL';

  return [true, { doi, url, sources: [...new Set(sources)].sort(), verification }];
}

function normalizeExternalPaper(raw, source, query) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const src = String(source || '').trim().toLowerCase() || 'web';
  const queryTokens = (String(query || '').toLowerCase().match(/[a-z0-9ğüşöçıİĞÜŞÖÇ]{4,}/gi) || [])
    .filter((token) => !['with', 'from', 'that', 'this', 'paper', 'source', 'query', 'için', 'olan', 'gibi', 'veya'].includes(token))
    .slice(0, 10);

  let title = '';
  let year = '';
  let authors = [];
  let venue = '';
  let abstract = '';
  let doi = '';
  let url = '';
  let citations = 0;
  let topics = [];

  if (src === 'openalex') {
    title = compactExternalText(entry.title || '', 320);
    year = String(entry.publication_year || '');
    const authorships = Array.isArray(entry.authorships) ? entry.authorships : [];
    authors = authorships
      .slice(0, 5)
      .map((row) => compactExternalText((row?.author || {}).display_name || '', 80))
      .filter(Boolean);
    venue = compactExternalText(((entry.primary_location || {}).source || {}).display_name || '', 120);
    const ids = entry.ids && typeof entry.ids === 'object' ? entry.ids : {};
    doi = String(ids.doi || '').trim();
    doi = doi.replace(/^https?:\/\/doi\.org\//i, '');
    url = String(entry.id || '').trim();
    citations = Number(entry.cited_by_count || 0) || 0;
    const concepts = Array.isArray(entry.concepts) ? entry.concepts : [];
    topics = concepts
      .slice(0, 6)
      .map((c) => compactExternalText(c?.display_name || '', 50))
      .filter(Boolean);
    abstract = '';
  } else if (src === 'crossref') {
    const titleList = Array.isArray(entry.title) ? entry.title : [];
    title = compactExternalText(titleList[0] || '', 320);
    let yearParts = [null];
    const printParts = (((entry['published-print'] || {})['date-parts']) || []);
    if (Array.isArray(printParts) && Array.isArray(printParts[0])) yearParts = printParts[0];
    if (!yearParts || yearParts[0] === null || yearParts[0] === undefined) {
      const onlineParts = (((entry['published-online'] || {})['date-parts']) || []);
      if (Array.isArray(onlineParts) && Array.isArray(onlineParts[0])) yearParts = onlineParts[0];
    }
    year = String((yearParts || [])[0] || '');
    const rawAuthors = Array.isArray(entry.author) ? entry.author : [];
    authors = rawAuthors.slice(0, 5).map((author) => {
      const given = compactExternalText(author?.given || '', 40);
      const family = compactExternalText(author?.family || '', 40);
      return [given, family].filter(Boolean).join(' ').trim();
    }).filter(Boolean);
    const container = Array.isArray(entry['container-title']) ? entry['container-title'] : [];
    venue = compactExternalText(container[0] || '', 120);
    doi = String(entry.DOI || '').trim();
    url = String(entry.URL || (doi ? `https://doi.org/${doi}` : '')).trim();
    citations = Number(entry['is-referenced-by-count'] || 0) || 0;
    abstract = compactExternalText(entry.abstract || '', 260);
    topics = [];
  } else {
    title = compactExternalText(entry.title || '', 320);
    year = String(entry.year || '');
    const rawAuthors = Array.isArray(entry.authors) ? entry.authors : [];
    authors = rawAuthors.slice(0, 5).map((author) => {
      if (author && typeof author === 'object') return compactExternalText(author.name || '', 80);
      return compactExternalText(author, 80);
    }).filter(Boolean);
    venue = compactExternalText(entry.venue || '', 120);
    abstract = compactExternalText(entry.abstract || '', 260);
    url = String(entry.url || '').trim();
    const externalIds = entry.externalIds && typeof entry.externalIds === 'object' ? entry.externalIds : {};
    doi = String(externalIds.DOI || entry.doi || '').trim();
    citations = Number(entry.citationCount || 0) || 0;
    const fields = Array.isArray(entry.fieldsOfStudy) ? entry.fieldsOfStudy : [];
    topics = fields.slice(0, 6).map((topic) => compactExternalText(topic, 50)).filter(Boolean);
  }

  if (!title) return null;
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const relevanceHits = queryTokens.reduce((acc, token) => (token && title.toLowerCase().includes(token) ? acc + 1 : acc), 0);
  let yearInt = Number(year);
  if (!Number.isFinite(yearInt)) yearInt = 0;
  let recency = 0;
  if (yearInt >= 2023) recency = 8;
  else if (yearInt >= 2018) recency = 5;
  else if (yearInt >= 2010) recency = 2;
  const citationScore = citations > 0 ? Math.min(26, Math.floor(citations / 20)) : 0;
  const sourceBonus = { semantic: 6, openalex: 5, crossref: 3 }[src] || 1;
  const relevanceScore = (relevanceHits * 8) + recency + citationScore + sourceBonus;

  return {
    source: src,
    sources: [src],
    title,
    titleKey: normalizedTitle,
    year,
    authors,
    venue,
    abstract,
    doi: normalizeExternalDoi(doi),
    url: normalizeExternalUrl(url),
    citations,
    topics,
    score: relevanceScore,
  };
}

async function fetchOpenalexCandidates(query, limit = 8) {
  const encoded = encodeURIComponent(String(query || ''));
  const perPage = Math.max(2, Number(limit || 8));
  const url = `https://api.openalex.org/works?search=${encoded}&per-page=${perPage}&sort=relevance_score:desc`;
  const payload = await fetchJsonUrl(url, 6);
  const rows = payload && Array.isArray(payload.results) ? payload.results : [];
  return rows.slice(0, perPage);
}

async function fetchCrossrefCandidates(query, limit = 8) {
  const encoded = encodeURIComponent(String(query || ''));
  const rows = Math.max(2, Number(limit || 8));
  const url = `https://api.crossref.org/works?query.bibliographic=${encoded}&rows=${rows}&sort=relevance&order=desc`;
  const payload = await fetchJsonUrl(url, 6);
  const message = payload && typeof payload.message === 'object' ? payload.message : {};
  const items = Array.isArray(message.items) ? message.items : [];
  return items.slice(0, rows);
}

async function fetchSemanticScholarCandidates(query, limit = 8) {
  const encoded = encodeURIComponent(String(query || ''));
  const capped = Math.max(2, Number(limit || 8));
  const fields = 'title,year,authors,venue,abstract,citationCount,url,externalIds,fieldsOfStudy';
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encoded}&limit=${capped}&fields=${encodeURIComponent(fields)}`;
  const payload = await fetchJsonUrl(url, 6);
  const rows = payload && Array.isArray(payload.data) ? payload.data : [];
  return rows.slice(0, capped);
}

function dedupeAndRankExternalCandidates(rows) {
  const deduped = new Map();
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    let key = String(row.doi || '').trim().toLowerCase();
    if (!key) key = `${String(row.titleKey || '')}:${String(row.year || '')}`;
    if (!key) continue;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, { ...row });
      continue;
    }
    let keep = { ...existing };
    let alt = { ...row };
    if (Number(alt.score || 0) > Number(keep.score || 0)) {
      [keep, alt] = [alt, keep];
    }

    const keepSources = Array.isArray(keep.sources) ? keep.sources : [keep.source || ''];
    const altSources = Array.isArray(alt.sources) ? alt.sources : [alt.source || ''];
    const mergedSources = [...new Set([...keepSources, ...altSources].map((s) => String(s || '').trim().toLowerCase()).filter(Boolean))].sort();
    keep.sources = mergedSources;
    if (mergedSources.length) keep.source = mergedSources[0];

    if (!String(keep.doi || '').trim() && String(alt.doi || '').trim()) keep.doi = alt.doi;
    if (!String(keep.url || '').trim() && String(alt.url || '').trim()) keep.url = alt.url;
    keep.citations = Math.max(Number(keep.citations || 0), Number(alt.citations || 0));

    const keepTopics = Array.isArray(keep.topics) ? keep.topics : [];
    const altTopics = Array.isArray(alt.topics) ? alt.topics : [];
    const topicSet = [];
    const seenTopics = new Set();
    for (const topic of [...keepTopics, ...altTopics]) {
      const clean = compactExternalText(topic, 50);
      if (!clean || seenTopics.has(clean)) continue;
      seenTopics.add(clean);
      topicSet.push(clean);
    }
    keep.topics = topicSet.slice(0, 10);

    const keepAuthors = Array.isArray(keep.authors) ? keep.authors : [];
    const altAuthors = Array.isArray(alt.authors) ? alt.authors : [];
    if (altAuthors.length > keepAuthors.length) keep.authors = altAuthors;

    deduped.set(key, keep);
  }
  return [...deduped.values()].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

function extractExternalTopics(rows, limit = 8) {
  const scores = new Map();
  for (const row of rows || []) {
    const topics = Array.isArray(row?.topics) ? row.topics : [];
    for (const topic of topics.slice(0, 8)) {
      const clean = compactExternalText(topic, 50);
      if (!clean) continue;
      scores.set(clean, Number(scores.get(clean) || 0) + 1);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(3, Number(limit || 8)))
    .map(([name]) => name);
}

async function collectExternalCandidates(query, perSourceLimit = 8) {
  const sources = [
    ['openalex', fetchOpenalexCandidates],
    ['semantic', fetchSemanticScholarCandidates],
    ['crossref', fetchCrossrefCandidates],
  ];

  const jobs = sources.map(async ([sourceName, fetcher]) => {
    try {
      const rows = await fetcher(query, perSourceLimit);
      const normalized = [];
      for (const raw of rows) {
        const item = normalizeExternalPaper(raw, sourceName, query);
        if (item) normalized.push(item);
      }
      return normalized;
    } catch {
      return [];
    }
  });
  const lists = await Promise.all(jobs);
  return lists.flat();
}

async function buildExternalSearchContext(reqData, prompt, targetLanguage = '', onEvent = null) {
  const query = normalizeExternalSearchQuery(reqData, prompt);
  if (!query) {
    return { used: false, query: '', count: 0, topics: [], context: '' };
  }

  const queryCandidates = buildExternalQueryCandidates(reqData, prompt, query);
  const yearFloor = detectExternalYearFloor(reqData, prompt);
  const cacheBasis = queryCandidates.length ? queryCandidates.join(' || ') : query;
  const cacheKey = externalSearchCacheKey(`${cacheBasis}::y${yearFloor || 0}`, targetLanguage);
  const cached = getCachedExternalSearchResult(cacheKey);
  if (cached && typeof cached === 'object') {
    return {
      used: Boolean(cached.count || 0),
      query: String(cached.query || query),
      count: Number(cached.count || 0),
      topics: Array.isArray(cached.topics) ? cached.topics : [],
      context: String(cached.context || ''),
      cached: true,
    };
  }

  if (typeof onEvent === 'function') {
    onEvent({
      type: 'meta',
      phase: 'external_search_start',
      query,
      queryVariants: queryCandidates.slice(0, 4),
      yearFloor: Number(yearFloor || 0),
    });
  }

  const candidates = [];
  const perQueryLimit = queryCandidates.length > 1 ? 6 : 8;
  for (const candidateQuery of queryCandidates.slice(0, 4)) {
    const rows = await collectExternalCandidates(candidateQuery, perQueryLimit);
    candidates.push(...rows);
  }

  const rankedRaw = dedupeAndRankExternalCandidates(candidates).slice(0, 12);
  const verified = [];
  const seedTerms = externalSeedTerms(reqData, prompt, query);
  for (const row of rankedRaw) {
    const [ok, verification] = verifyExternalCandidate(row);
    if (!ok) continue;
    const enriched = { ...row };
    enriched.doi = verification.doi || enriched.doi || '';
    enriched.url = verification.url || enriched.url || '';
    enriched.sources = verification.sources || enriched.sources || [];
    enriched.verification = verification.verification || '';
    const topicHits = topicalTermHitsForCandidate(enriched, seedTerms);
    if (topicHits > 0) {
      enriched.score = Number(enriched.score || 0) + Math.min(18, topicHits * 6);
    }
    enriched._topicHits = Number(topicHits || 0);
    verified.push(enriched);
  }

  verified.sort((a, b) => {
    const ah = Number(a._topicHits || 0);
    const bh = Number(b._topicHits || 0);
    if (ah !== bh) return bh - ah;
    const as = Number(a.score || 0);
    const bs = Number(b.score || 0);
    if (as !== bs) return bs - as;
    return Number(b.citations || 0) - Number(a.citations || 0);
  });

  const relevantVerified = verified.filter((row) => Number(row._topicHits || 0) > 0);
  let ranked = (relevantVerified.length ? relevantVerified : verified).slice(0, 8);
  const verificationRejected = Math.max(0, rankedRaw.length - verified.length);
  let recentRelaxed = false;

  if (yearFloor) {
    const recentRanked = [];
    for (const row of ranked) {
      const rowYear = Number(String(row.year || '').trim());
      if (Number.isFinite(rowYear) && rowYear >= Number(yearFloor)) recentRanked.push(row);
    }
    if (recentRanked.length) ranked = recentRanked.slice(0, 8);
    else if (ranked.length) recentRelaxed = true;
  }

  const topics = extractExternalTopics(ranked, 8);
  const lang = normalizeOutputLanguage(targetLanguage);
  const currentYear = new Date().getUTCFullYear();

  if (!ranked.length) {
    let contextLines;
    if (lang === 'en') {
      contextLines = [
        'WEB SCHOLARLY SEARCH:',
        `- Query: ${query}`,
        '- No fully verified direct record was retrieved in this turn.',
      ];
      if (verificationRejected > 0) {
        contextLines.push('- Retrieved items failed DOI/URL verification.');
      }
      if (yearFloor) contextLines.push(`- Requested time window: ${yearFloor}-${currentYear}.`);
      contextLines.push('- Continue with Zotero context and provide a direct academic synthesis.');
      contextLines.push('- If evidence is limited, mark it as inference and do not invent citations.');
    } else {
      contextLines = [
        'WEB AKADEMİK ARAMA:',
        `- Sorgu: ${query}`,
        '- Bu turda tam doğrulanmış doğrudan kayıt bulunamadı.',
      ];
      if (verificationRejected > 0) {
        contextLines.push('- Gelen kayıtlar DOI/URL doğrulamasını geçemedi.');
      }
      if (yearFloor) contextLines.push(`- İstenen zaman aralığı: ${yearFloor}-${currentYear}.`);
      contextLines.push('- Zotero bağlamıyla devam et ve doğrudan akademik sentez üret.');
      contextLines.push('- Kanıt sınırlıysa bunu çıkarım olarak etiketle; uydurma atıf verme.');
    }
    const context = contextLines.join('\n');
    const payload = { query, count: 0, topics: [], context };
    setCachedExternalSearchResult(cacheKey, payload, EXTERNAL_SEARCH_CACHE_TTL_SECONDS);
    if (typeof onEvent === 'function') {
      onEvent({ type: 'meta', phase: 'external_search_done', count: 0 });
    }
    return { used: false, query, count: 0, topics: [], context, cached: false };
  }

  const lines = [];
  if (lang === 'en') {
    lines.push('WEB SCHOLARLY SEARCH (retrieved live):');
    lines.push(`- Query: ${query}`);
    if (queryCandidates.length > 1) lines.push(`- Query variants used: ${queryCandidates.slice(0, 4).length}`);
    lines.push('- Scope: Academic-only sources (OpenAlex, Semantic Scholar, Crossref)');
    lines.push('- Validation: Each listed item passed DOI/URL verification');
    if (yearFloor) lines.push(`- Requested time window: ${yearFloor}-${currentYear}`);
    if (recentRelaxed) {
      lines.push('- No verified records were found strictly in the requested window; closest verified records are shown.');
    }
    if (topics.length) lines.push(`- Topics: ${topics.slice(0, 8).join(', ')}`);
    lines.push('- Highlighted papers:');
  } else {
    lines.push('WEB AKADEMİK ARAMA (canlı getirildi):');
    lines.push(`- Sorgu: ${query}`);
    if (queryCandidates.length > 1) lines.push(`- Kullanılan sorgu varyantı: ${queryCandidates.slice(0, 4).length}`);
    lines.push('- Kapsam: Yalnız akademik kaynaklar (OpenAlex, Semantic Scholar, Crossref)');
    lines.push('- Doğrulama: Listelenen her kayıt DOI/URL kontrolünden geçti');
    if (yearFloor) lines.push(`- İstenen zaman aralığı: ${yearFloor}-${currentYear}`);
    if (recentRelaxed) lines.push('- İstenen aralıkta doğrulanmış kayıt bulunamadı; en yakın doğrulanmış kayıtlar gösterildi.');
    if (topics.length) lines.push(`- Konular: ${topics.slice(0, 8).join(', ')}`);
    lines.push('- Öne çıkan çalışmalar:');
  }

  ranked.forEach((row, idx) => {
    const title = row.title || '';
    const year = row.year || '-';
    const venue = row.venue || '-';
    const authors = (Array.isArray(row.authors) ? row.authors : []).slice(0, 4).join(', ') || '-';
    const citations = Number(row.citations || 0);
    const doi = row.doi || '';
    const url = row.url || '';
    const abstract = row.abstract || '';
    const sourceList = Array.isArray(row.sources) ? row.sources : [row.source || ''];
    const source = sourceList.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean).join(', ') || '-';
    const verification = String(row.verification || '').trim();

    lines.push(`${idx + 1}) ${title} (${year})`);
    lines.push(`   - Source: ${source}`);
    lines.push(`   - Authors: ${authors}`);
    lines.push(`   - Venue: ${venue}`);
    if (verification) lines.push(`   - Verification: ${verification}`);
    if (citations) lines.push(`   - Citations: ${citations}`);
    if (doi) lines.push(`   - DOI: ${doi}`);
    if (url) lines.push(`   - URL: ${url}`);
    if (abstract) lines.push(`   - Abstract snippet: ${compactExternalText(abstract, 220)}`);
  });

  if (lang === 'en') {
    lines.push('Synthesize a direct academic answer from Zotero context and this list.');
    lines.push('If evidence is limited, explicitly mark inferences and avoid invented citations.');
  } else {
    lines.push('Zotero bağlamı ve bu listeyle doğrudan akademik yanıtı sentezle.');
    lines.push('Kanıt sınırlıysa çıkarımı açıkça işaretle ve uydurma atıf üretme.');
  }

  const context = lines.join('\n').trim();
  const payload = { query, count: ranked.length, topics, context };
  setCachedExternalSearchResult(cacheKey, payload, EXTERNAL_SEARCH_CACHE_TTL_SECONDS);
  if (typeof onEvent === 'function') {
    onEvent({ type: 'meta', phase: 'external_search_done', count: ranked.length, topics: topics.slice(0, 8) });
  }

  return { used: true, query, count: ranked.length, topics, context, cached: false };
}

function normalizeBigPdfRequested(reqData) {
  return toBool(reqData?.bigPdfPipeline);
}

async function executeBigPdfPipeline(reqData, fallbackPrompt, provider, model, analysisMode = 'balanced', outputLanguage = '', options = {}) {
  const itemKey = String(reqData?.itemKey || '').trim();
  if (!itemKey) {
    throw new Error('Büyük PDF pipeline için geçerli itemKey gerekli.');
  }

  const query = normalizeBigPdfQuery(reqData, fallbackPrompt, outputLanguage);
  const requestedMode = normalizeAnalysisMode(analysisMode);
  const requestedChunkLimit = normalizePipelineChunkLimit(reqData?.pipelineChunkLimit || 'auto');
  const baseConfig = bigPdfPipelineConfig(requestedMode);

  let metadata = null;
  let itemBase = '';
  let lastMetadataError = null;

  for (const base of itemApiBaseCandidates(reqData)) {
    try {
      metadata = await fetchZoteroApiJson(`${base}/items/${itemKey}?format=json`, 10000);
      itemBase = base;
      break;
    } catch (e) {
      const msg = String(e.message || '');
      if (msg.includes('Zotero API 404')) {
        lastMetadataError = e;
        continue;
      }
      throw e;
    }
  }

  if (!metadata) {
    if (lastMetadataError) {
      throw new Error("Seçili öğe Zotero API'de bulunamadı (404). Öğeyi yenileyip tekrar deneyin.");
    }
    throw new Error('Seçili öğe için metadata alınamadı.');
  }

  const data = metadata.data && typeof metadata.data === 'object' ? metadata.data : {};
  const itemTitle = String(data.title || itemKey || 'Belgesiz').trim() || itemKey;

  let fulltext = '';
  let fulltextSourceKey = itemKey;
  try {
    const own = await fetchZoteroApiJson(`${itemBase}/items/${itemKey}/fulltext?format=json`, 12000);
    fulltext = extractFulltextContent(own);
    if (fulltext) fulltextSourceKey = itemKey;
  } catch {
    fulltext = '';
  }

  if (!fulltext) {
    try {
      const children = await fetchZoteroApiJson(`${itemBase}/items/${itemKey}/children?format=json`, 10000);
      const list = Array.isArray(children) ? children : [];
      const attachmentKeys = [];
      for (const child of list) {
        if (!child || typeof child !== 'object') continue;
        const childData = child.data && typeof child.data === 'object' ? child.data : {};
        const itemType = String(childData.itemType || '').toLowerCase();
        const contentType = String(childData.contentType || '').toLowerCase();
        if (itemType !== 'attachment' || contentType !== 'application/pdf') continue;
        const key = String(child.key || childData.key || '').trim();
        if (key && !attachmentKeys.includes(key)) attachmentKeys.push(key);
      }

      for (const key of attachmentKeys.slice(0, 6)) {
        try {
          const payload = await fetchZoteroApiJson(`${itemBase}/items/${key}/fulltext?format=json`, 14000);
          const candidate = extractFulltextContent(payload);
          if (candidate) {
            fulltext = candidate;
            fulltextSourceKey = key;
            break;
          }
        } catch {
          // next
        }
      }
    } catch {
      // continue to error
    }
  }

  if (!fulltext) {
    throw new Error('Zotero tam metni bulunamadı. PDF içeriği indekslenmemiş olabilir.');
  }

  const attachmentHash = crypto
    .createHash('sha256')
    .update(fulltext, 'utf-8')
    .digest('hex')
    .slice(0, 24);
  const fulltextLengthBeforeTruncation = fulltext.length;

  const config = adaptBigPdfPipelineConfig(
    baseConfig,
    fulltextLengthBeforeTruncation,
    requestedMode,
    query,
    requestedChunkLimit
  );

  const pipelineCacheKey = buildBigPdfResultCacheKey({
    itemKey,
    attachmentHash: `${fulltextSourceKey}:${attachmentHash}`,
    query,
    analysisMode: requestedMode,
    outputLanguage,
    provider,
    model,
    chunkLimit: requestedChunkLimit || config.maxChunks,
  });
  const cachedPipeline = getCachedBigPdfResult(pipelineCacheKey);
  if (cachedPipeline && typeof cachedPipeline.text === 'string' && cachedPipeline.text.trim()) {
    if (typeof options.onEvent === 'function') {
      options.onEvent({
        type: 'meta',
        phase: 'big_pdf_pipeline_cache_hit',
        itemKey,
        chunkCount: Number(cachedPipeline.chunkCount || 0),
      });
    }
    return {
      text: String(cachedPipeline.text || ''),
      providerUsed: normalizeProvider(cachedPipeline.providerUsed || provider),
      fallbackUsed: Boolean(cachedPipeline.fallbackUsed),
      errors: [],
      pipelineUsed: true,
      pipelineTemplate: 'none',
      pipelineChunkMode: String(cachedPipeline.pipelineChunkMode || ''),
      pipelineFinalMode: String(cachedPipeline.pipelineFinalMode || ''),
      pipelineTruncated: Boolean(cachedPipeline.pipelineTruncated),
      pipelineMapReduceUsed: Boolean(cachedPipeline.pipelineMapReduceUsed),
      cached: true,
    };
  }

  let sourceTruncated = false;
  if (fulltext.length > config.maxSourceChars) {
    fulltext = fulltext.slice(0, config.maxSourceChars).trimEnd();
    sourceTruncated = true;
  }

  let chunkMode = normalizeAnalysisMode(config.chunkAnalysisMode || 'balanced');
  let finalMode = requestedMode;

  if (fulltextLengthBeforeTruncation >= 90000 && (requestedMode === 'balanced' || requestedMode === 'deep')) {
    chunkMode = 'fast';
    finalMode = 'balanced';
  } else if (fulltextLengthBeforeTruncation >= 55000 && requestedMode === 'deep') {
    chunkMode = 'fast';
    finalMode = 'balanced';
  }

  const chunks = splitTextForBigPdfPipeline(
    fulltext,
    config.chunkSize,
    config.chunkOverlap,
    config.maxChunks,
    {
      query,
      sectionAware: config.sectionAware !== false,
    }
  );
  if (!chunks.length) {
    throw new Error('Tam metin parçalara ayrılamadı.');
  }

  if (typeof options.onEvent === 'function') {
    options.onEvent({
      type: 'meta',
      phase: 'big_pdf_pipeline_start',
      itemKey,
      chunkCount: chunks.length,
      analysisMode,
      chunkMode,
      finalMode,
      template: 'none',
      chunkLimit: config.maxChunks,
      sectionAware: config.sectionAware !== false,
      adaptive: true,
    });
  }

  const chunkSummaries = [];
  const allErrors = [];
  let providerUsed = normalizeProvider(provider);
  let fallbackUsed = false;
  const chunkTagLabel = normalizeOutputLanguage(outputLanguage) === 'en' ? 'Chunk' : 'Parça';
  const groupTagLabel = normalizeOutputLanguage(outputLanguage) === 'en' ? 'Group' : 'Grup';
  let mapReduceUsed = false;

  for (let i = 0; i < chunks.length; i += 1) {
    const idx = i + 1;
    if (typeof options.onEvent === 'function') {
      options.onEvent({ type: 'meta', phase: 'big_pdf_pipeline_chunk', index: idx, total: chunks.length });
    }

    const row = chunks[i] && typeof chunks[i] === 'object' ? chunks[i] : { text: String(chunks[i] || ''), sectionTitle: '' };
    const chunkPrompt = buildBigPdfChunkPrompt(
      itemTitle,
      itemKey,
      query,
      String(row.text || ''),
      idx,
      chunks.length,
      outputLanguage,
      row.sectionTitle || ''
    );
    const chunkResult = await executeWithProviderFallback(chunkPrompt, provider, model, chunkMode, {
      stream: false,
      abortSignal: options.abortSignal,
    });

    const chunkTextRaw = sanitizeProviderOutput(chunkResult.text, chunkResult.providerUsed || provider);
    providerUsed = normalizeProvider(chunkResult.providerUsed || providerUsed);
    fallbackUsed = fallbackUsed || Boolean(chunkResult.fallbackUsed);

    if (Array.isArray(chunkResult.errors) && chunkResult.errors.length) {
      for (const err of chunkResult.errors.slice(0, 3)) {
        allErrors.push(`chunk-${idx}: ${err}`);
      }
    }

    let chunkOut = String(chunkTextRaw || '').trim();
    if (!chunkOut) {
      chunkOut = normalizeOutputLanguage(outputLanguage) === 'en'
        ? 'Chunk analysis unavailable due to model/tool error.'
        : 'Parça analizi model/araç hatası nedeniyle üretilemedi.';
    }
    if (chunkOut.length > 1500) {
      chunkOut = `${chunkOut.slice(0, 1500).trimEnd()} ...`;
    }

    const sectionSuffix = String(row.sectionTitle || '').trim();
    const sectionLabel = sectionSuffix
      ? (normalizeOutputLanguage(outputLanguage) === 'en'
        ? ` | Section: ${sectionSuffix}`
        : ` | Bölüm: ${sectionSuffix}`)
      : '';
    chunkSummaries.push(`[${chunkTagLabel} ${idx}/${chunks.length}${sectionLabel}]\n${chunkOut}`);
  }

  let summariesForFinal = [...chunkSummaries];
  if (summariesForFinal.length > 6) {
    mapReduceUsed = true;
    const batchSize = summariesForFinal.length >= 10 ? 4 : 3;
    const totalBatches = Math.ceil(summariesForFinal.length / batchSize);
    const reduced = [];
    if (typeof options.onEvent === 'function') {
      options.onEvent({
        type: 'meta',
        phase: 'big_pdf_pipeline_reduce_start',
        batchSize,
        batchCount: totalBatches,
      });
    }

    for (let b = 0; b < totalBatches; b += 1) {
      const part = summariesForFinal.slice(b * batchSize, (b + 1) * batchSize);
      const mergePrompt = buildBigPdfMergePrompt(
        itemTitle,
        itemKey,
        query,
        part,
        b + 1,
        totalBatches,
        outputLanguage
      );
      const mergeResult = await executeWithProviderFallback(mergePrompt, providerUsed || provider, model, chunkMode, {
        stream: false,
        abortSignal: options.abortSignal,
      });
      let mergedText = sanitizeProviderOutput(mergeResult.text, mergeResult.providerUsed || providerUsed || provider);
      providerUsed = normalizeProvider(mergeResult.providerUsed || providerUsed);
      fallbackUsed = fallbackUsed || Boolean(mergeResult.fallbackUsed);
      if (Array.isArray(mergeResult.errors) && mergeResult.errors.length) {
        for (const err of mergeResult.errors.slice(0, 2)) {
          allErrors.push(`reduce-${b + 1}: ${err}`);
        }
      }
      if (!mergedText) {
        mergedText = part.join('\n\n');
        if (mergedText.length > 1800) mergedText = `${mergedText.slice(0, 1800).trimEnd()} ...`;
      }
      reduced.push(`[${groupTagLabel} ${b + 1}/${totalBatches}]\n${mergedText}`);
    }

    if (reduced.length) summariesForFinal = reduced;
  }

  const finalPrompt = buildBigPdfFinalPrompt(itemTitle, itemKey, query, summariesForFinal, outputLanguage);
  const finalResult = await executeWithProviderFallback(finalPrompt, provider, model, finalMode, {
    stream: false,
    abortSignal: options.abortSignal,
  });

  let finalText = sanitizeProviderOutput(finalResult.text, finalResult.providerUsed || provider);
  providerUsed = normalizeProvider(finalResult.providerUsed || providerUsed);
  fallbackUsed = fallbackUsed || Boolean(finalResult.fallbackUsed);

  if (Array.isArray(finalResult.errors) && finalResult.errors.length) {
    for (const err of finalResult.errors.slice(0, 4)) {
      allErrors.push(`final: ${err}`);
    }
  }

  if (!finalText) {
    finalText = summariesForFinal.join('\n\n');
  }

  if (!hasPipelineCitations(finalText, outputLanguage)) {
    const citationLang = normalizeOutputLanguage(outputLanguage);
    const citePrompt = citationLang === 'en'
      ? [
          'Rewrite the text below by adding citation tags after every factual sentence/bullet.',
          `Use only these tags: [Chunk n], where n is between 1 and ${chunks.length}.`,
          'Do not change meaning.',
          '',
          `Text:\n${finalText}`,
        ].join(' ')
      : [
          'Aşağıdaki metni, her olgusal cümle/madde sonuna kaynak etiketi ekleyerek yeniden yaz.',
          `Sadece şu etiketleri kullan: [Parça n], n değeri 1 ile ${chunks.length} arasında olmalı.`,
          'Anlamı değiştirme.',
          '',
          `Metin:\n${finalText}`,
        ].join(' ');

    const citeResult = await executeWithProviderFallback(citePrompt, providerUsed, model, 'fast', {
      stream: false,
      abortSignal: options.abortSignal,
    });

    const cited = sanitizeProviderOutput(citeResult.text, citeResult.providerUsed || providerUsed);
    if (Array.isArray(citeResult.errors) && citeResult.errors.length) {
      for (const err of citeResult.errors.slice(0, 2)) {
        allErrors.push(`citation-fix: ${err}`);
      }
    }
    if (cited && hasPipelineCitations(cited, outputLanguage)) {
      finalText = cited;
    }
  }

  finalText = enforceEvidenceAlignment(finalText, outputLanguage);

  if (sourceTruncated) {
    const tail = normalizeOutputLanguage(outputLanguage) === 'en'
      ? '\n\nNote: Source text exceeded pipeline limits; only the initial portion was processed.'
      : '\n\nNot: Kaynak metin pipeline limitini aştığı için sadece ilk bölüm işlendi.';
    finalText = `${finalText.trimEnd()}${tail}`;
  }

  finalText = formatPipelineCitationsForUsers(finalText, outputLanguage);

  if (typeof options.onEvent === 'function') {
    options.onEvent({
      type: 'meta',
      phase: 'big_pdf_pipeline_done',
      chunkCount: chunks.length,
      truncated: sourceTruncated,
      chunkMode,
      finalMode,
      template: 'none',
      mapReduceUsed,
    });
  }

  setCachedBigPdfResult(
    pipelineCacheKey,
    {
      text: finalText,
      providerUsed,
      fallbackUsed,
      pipelineChunkMode: chunkMode,
      pipelineFinalMode: finalMode,
      pipelineTruncated: sourceTruncated,
      pipelineMapReduceUsed: mapReduceUsed,
      chunkCount: chunks.length,
    },
    bigPdfResultCacheTtlSeconds(requestedMode)
  );

  return {
    text: finalText,
    providerUsed,
    fallbackUsed,
    errors: allErrors,
    pipelineUsed: true,
    pipelineTemplate: 'none',
    pipelineChunkMode: chunkMode,
    pipelineFinalMode: finalMode,
    pipelineTruncated: sourceTruncated,
    pipelineMapReduceUsed: mapReduceUsed,
    cached: false,
  };
}

function commandProbe(command, args = [], timeoutSec = 4, cwd = RUNTIME_DIR, env = process.env) {
  const probeEnv = { ...env };
  enrichEnvPathForCli(probeEnv);
  const executable = path.isAbsolute(String(command || '')) ? String(command || '') : resolveFromPath(command);
  if (!executable || !fs.existsSync(executable)) {
    return { status: 'down', available: false, detail: 'CLI not found', command: String(command || '') };
  }

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env: probeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let timedOut = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* no-op */ }
    }, Math.max(1000, Number(timeoutSec || 4) * 1000));

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ status: 'degraded', available: true, detail: 'timeout', command: executable });
        return;
      }
      const detail = parseFirstRelevantError(out || err || '').slice(0, 180);
      if (code === 0) {
        resolve({ status: 'ok', available: true, detail: detail || 'ok', command: executable });
        return;
      }
      resolve({
        status: 'degraded',
        available: true,
        detail: detail || `exit code ${code}`,
        command: executable,
      });
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: 'degraded', available: true, detail: String(e.message || e).slice(0, 180), command: executable });
    });
  });
}

async function zoteroDesktopProbe() {
  const startedAt = Date.now();
  try {
    const { controller, timer } = timeoutSignal(3000);
    const resp = await fetch(`${ZOTERO_API}/api/users/0/items?format=json&limit=1`, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) {
      return { status: 'down', detail: `HTTP ${resp.status}`, latencyMs: Date.now() - startedAt };
    }
    await resp.arrayBuffer();
    return { status: 'ok', detail: 'reachable', latencyMs: Date.now() - startedAt };
  } catch (e) {
    return { status: 'down', detail: String(e.message || e).slice(0, 180), latencyMs: Date.now() - startedAt };
  }
}

function formatTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function normalizeRequestPath(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function staticFilePathFromUrl(pathname) {
  if (pathname === '/' || pathname === '') return path.join(DIR, 'index.html');
  const safePath = normalizeRequestPath(pathname).replace(/^\/+/, '');
  const candidate = path.resolve(path.join(DIR, safePath));
  if (isWin()) {
    if (!candidate.toLowerCase().startsWith(DIR.toLowerCase())) return '';
  } else if (!candidate.startsWith(DIR)) {
    return '';
  }
  return candidate;
}

async function serveStatic(req, res, pathname) {
  const filePath = staticFilePathFromUrl(pathname);
  if (!filePath) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  if (stat.isDirectory()) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': String(stat.size),
    'Access-Control-Allow-Origin': '*',
  });

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) sendJson(res, 500, { error: 'File read error' });
    else res.end();
  });
  stream.pipe(res);
}

async function proxyToZotero(req, res) {
  const targetUrl = `${ZOTERO_API}${req.url}`;
  const method = req.method || 'GET';
  const cacheProfile = method === 'GET' ? toolCacheProfileForPath(req.url || '') : null;
  const cacheKey = cacheProfile ? toolCacheKey(req.url || '') : '';

  let bodyBuffer = null;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    clearAllCaches();
    try {
      bodyBuffer = await readRequestBody(req, 16 * 1024 * 1024);
    } catch (e) {
      sendJson(res, 400, { error: String(e.message || e) });
      return;
    }
  }

  if (cacheProfile && cacheKey) {
    const cached = getCachedToolResult(cacheKey);
    if (cached) {
      const headers = {
        'Access-Control-Allow-Origin': '*',
        'X-Zotero-Cache': 'HIT',
        ...(cached.headers || {}),
      };
      const body = Buffer.isBuffer(cached.body) ? cached.body : Buffer.from(cached.body || '');
      res.writeHead(Number(cached.status || 200), headers);
      res.end(body);
      return;
    }
  }

  const headers = {};
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];

  try {
    const timeoutMs = method === 'GET' ? 12000 : 16000;
    const { controller, timer } = timeoutSignal(timeoutMs);
    const resp = await fetch(targetUrl, {
      method,
      headers,
      body: bodyBuffer && bodyBuffer.length ? bodyBuffer : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const responseBody = Buffer.from(await resp.arrayBuffer());
    const passthroughHeaders = {
      'Access-Control-Allow-Origin': '*',
    };
    if (cacheProfile) passthroughHeaders['X-Zotero-Cache'] = 'MISS';

    const forwardHeaders = ['content-type', 'total-results', 'link', 'last-modified-version', 'etag'];
    for (const key of forwardHeaders) {
      const value = resp.headers.get(key);
      if (value) passthroughHeaders[key] = value;
    }

    res.writeHead(resp.status, passthroughHeaders);
    res.end(responseBody);

    if (cacheProfile && cacheKey && resp.status === 200) {
      const cacheHeaders = {};
      for (const key of forwardHeaders) {
        if (passthroughHeaders[key]) cacheHeaders[key] = passthroughHeaders[key];
      }
      setCachedToolResult(
        cacheKey,
        {
          status: Number(resp.status || 200),
          headers: cacheHeaders,
          body: responseBody,
        },
        cacheProfile.ttl
      );
    }
  } catch (e) {
    sendJson(res, 502, { error: String(e.message || e).slice(0, 280) });
  }
}

async function servePdf(req, res, pathname) {
  const relRaw = normalizeRequestPath(pathname.slice('/pdf/'.length));
  const roots = [ZOTERO_STORAGE, ...ZOTERO_STORAGE_CANDIDATES.filter((p) => p !== ZOTERO_STORAGE)];
  const compare = (a, b) => (isWin() ? a.toLowerCase().startsWith(b.toLowerCase()) : a.startsWith(b));

  let fullPath = '';
  for (const root of roots) {
    const rootReal = path.resolve(root);
    const candidate = path.resolve(path.join(rootReal, relRaw));
    if (!compare(candidate, rootReal)) continue;
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) {
        fullPath = candidate;
        break;
      }
    } catch {
      // continue
    }
  }

  if (!fullPath) {
    sendJson(res, 404, { error: 'File not found' });
    return;
  }

  const stat = await fsp.stat(fullPath);
  const totalSize = stat.size;
  const contentType = MIME_TYPES[path.extname(fullPath).toLowerCase()] || 'application/octet-stream';

  if (totalSize <= 0) {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': '0',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': 'inline',
    });
    res.end();
    return;
  }

  const range = String(req.headers.range || '').trim();
  let start = 0;
  let end = totalSize - 1;
  let status = 200;

  if (range.startsWith('bytes=')) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
      res.writeHead(416, {
        'Content-Range': `bytes */${totalSize}`,
        'Access-Control-Allow-Origin': '*',
      });
      res.end();
      return;
    }
    const [, startRaw, endRaw] = m;
    if (!startRaw && !endRaw) {
      res.writeHead(416, {
        'Content-Range': `bytes */${totalSize}`,
        'Access-Control-Allow-Origin': '*',
      });
      res.end();
      return;
    }

    try {
      if (!startRaw) {
        const suffix = Number(endRaw);
        if (suffix > 0) start = Math.max(0, totalSize - suffix);
      } else {
        start = Number(startRaw);
      }
      if (endRaw) end = Number(endRaw);
      else end = totalSize - 1;

      start = Math.max(0, Math.min(start, totalSize - 1));
      end = Math.max(start, Math.min(end, totalSize - 1));
      status = 206;
    } catch {
      res.writeHead(416, {
        'Content-Range': `bytes */${totalSize}`,
        'Access-Control-Allow-Origin': '*',
      });
      res.end();
      return;
    }
  }

  const contentLength = Math.max(0, end - start + 1);
  const headers = {
    'Content-Type': contentType,
    'Content-Length': String(contentLength),
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Content-Disposition': 'inline',
  };
  if (status === 206) {
    headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
  }

  res.writeHead(status, headers);
  const stream = fs.createReadStream(fullPath, { start, end });
  stream.on('error', () => {
    if (!res.headersSent) sendJson(res, 500, { error: 'PDF stream error' });
    else res.end();
  });
  stream.pipe(res);
}

function responseErrorStatus(errors) {
  const list = Array.isArray(errors) ? errors : [];
  if (list.length && list.every((e) => isRateLimitError(e))) return 429;
  if (list.length && list.every((e) => /zaman aşımı|timeout/i.test(String(e || '')))) return 504;
  if (list.length && list.every((e) => /circuit açık/i.test(String(e || '')))) return 503;
  return 500;
}

function bestErrorDetail(errors) {
  const list = (errors || []).slice(0, 6).map((x) => String(x || '').trim()).filter(Boolean);
  return list.length ? list.join('; ') : 'Bilinmeyen hata';
}

async function generateAiResponse(reqData, options = {}) {
  const prompt = String(reqData?.prompt || '').trim();
  if (!prompt) {
    const err = new Error('No prompt provided');
    err.statusCode = 400;
    throw err;
  }

  const provider = normalizeProvider(reqData?.provider || 'claude');
  const model = String(reqData?.model || '').trim();
  const analysisMode = normalizeAnalysisMode(reqData?.analysisMode || 'balanced');
  const outputLanguage = normalizeOutputLanguage(reqData?.language || '');
  const pipelineRequested = normalizeBigPdfRequested(reqData);

  let effectivePrompt = applyTemplateRuleFromRequest(prompt, reqData, outputLanguage);
  if (!pipelineRequested) {
    effectivePrompt = applySourceRoutingRuleFromRequest(effectivePrompt, reqData, outputLanguage);
  } else {
    effectivePrompt = stripPromptDirectiveBlock(effectivePrompt, ['EXTERNAL SOURCE ROUTING:', 'DIŞ KAYNAK YÖNLENDİRME:']);
  }

  let runResult;
  let externalSearchMeta = {
    used: false,
    query: normalizeExternalSearchQuery(reqData, effectivePrompt),
    count: 0,
    topics: [],
  };

  if (normalizeSourceRoutingMode(reqData) && !pipelineRequested) {
    try {
      externalSearchMeta = await buildExternalSearchContext(
        reqData,
        effectivePrompt,
        outputLanguage,
        typeof options.onEvent === 'function' ? options.onEvent : null
      );
      const externalContext = String(externalSearchMeta.context || '').trim();
      if (externalContext) {
        effectivePrompt = `${effectivePrompt}\n\n${externalContext}`;
      }
    } catch (e) {
      externalSearchMeta = {
        used: false,
        query: normalizeExternalSearchQuery(reqData, effectivePrompt),
        count: 0,
        topics: [],
        error: String(e?.message || e || '').slice(0, 200),
      };
    }
  }

  if (!pipelineRequested) {
    try {
      const zoteroEvidenceContext = await buildAutoZoteroEvidenceContext(
        reqData,
        prompt,
        analysisMode,
        outputLanguage
      );
      if (zoteroEvidenceContext) {
        effectivePrompt = `${effectivePrompt}\n\n${zoteroEvidenceContext}`;
      }
    } catch {
      // Best-effort evidence expansion; continue with the original prompt.
    }
  }

  effectivePrompt = applyOutputQualityRule(
    effectivePrompt,
    outputLanguage,
    normalizeSourceRoutingMode(reqData)
  );

  if (!pipelineRequested) {
    runResult = await executeWithProviderFallback(effectivePrompt, provider, model, analysisMode, {
      stream: Boolean(options.stream),
      onChunk: options.onChunk,
      onEvent: options.onEvent,
      abortSignal: options.abortSignal,
    });
  } else {
    runResult = await executeBigPdfPipeline(reqData, prompt, provider, model, analysisMode, outputLanguage, {
      onEvent: options.onEvent,
      abortSignal: options.abortSignal,
    });
  }

  if (runResult.aborted) {
    const err = new Error('Request aborted');
    err.statusCode = 499;
    err.aborted = true;
    throw err;
  }

  let responseText = sanitizeProviderOutput(runResult.text, runResult.providerUsed || provider);
  if (responseText && responseText !== String(runResult.text || '')) {
    if (typeof options.onReplace === 'function') options.onReplace(responseText);
  }

  const errors = Array.isArray(runResult.errors) ? [...runResult.errors] : [];
  const providerUsed = normalizeProvider(runResult.providerUsed || provider);
  const fallbackUsed = Boolean(runResult.fallbackUsed);
  const pipelineUsed = Boolean(runResult.pipelineUsed);
  const pipelineMapReduceUsed = Boolean(runResult.pipelineMapReduceUsed);
  const pipelineCached = Boolean(runResult.cached);

  if (!responseText) {
    const status = responseErrorStatus(errors);
    const detail = bestErrorDetail(errors);
    const payload = {
      error: `${provider} CLI çalıştırılamadı. ${detail}`,
      provider,
      providerUsed,
      fallbackUsed,
      pipelineUsed,
      externalSearchUsed: Boolean(externalSearchMeta.used),
      externalSearchQuery: String(externalSearchMeta.query || ''),
      externalSearchCount: Number(externalSearchMeta.count || 0),
      externalSearchTopics: Array.isArray(externalSearchMeta.topics) ? externalSearchMeta.topics : [],
    };

    if (status === 429) payload.code = 'RATE_LIMIT';
    else if (status === 504) payload.code = 'TIMEOUT';
    else if (status === 503) payload.code = 'CIRCUIT_OPEN';

    const err = new Error(payload.error);
    err.statusCode = status;
    err.payload = payload;
    throw err;
  }

  const languagePost = await applyLanguagePostCheck(
    responseText,
    providerUsed,
    providerUsed === provider ? model : '',
    outputLanguage,
    analysisMode
  );

  responseText = languagePost.text;
  const languageAdjusted = Boolean(languagePost.adjusted);
  if (Array.isArray(languagePost.errors) && languagePost.errors.length) {
    for (const err of languagePost.errors.slice(0, 2)) {
      errors.push(`language-fix: ${err}`);
    }
  }

  if (languageAdjusted && typeof options.onReplace === 'function') {
    options.onReplace(responseText);
  }

  return {
    text: responseText,
    provider,
    providerUsed,
    fallbackUsed,
    languageAdjusted,
    pipelineUsed,
    pipelineTemplate: runResult.pipelineTemplate || '',
    pipelineChunkMode: runResult.pipelineChunkMode || '',
    pipelineFinalMode: runResult.pipelineFinalMode || '',
    pipelineMapReduceUsed,
    externalSearchUsed: Boolean(externalSearchMeta.used),
    externalSearchQuery: String(externalSearchMeta.query || ''),
    externalSearchCount: Number(externalSearchMeta.count || 0),
    externalSearchTopics: Array.isArray(externalSearchMeta.topics) ? externalSearchMeta.topics : [],
    cached: pipelineCached,
    deduped: false,
  };
}

function getOrCreateInflight(key, factory) {
  cleanupInflightRequests();
  const existing = INFLIGHT_AI_REQUESTS.get(key);
  if (existing) {
    return { isLeader: false, promise: existing.promise };
  }
  const entry = {
    createdAt: Date.now(),
    promise: (async () => {
      try {
        return await factory();
      } finally {
        INFLIGHT_AI_REQUESTS.delete(key);
      }
    })(),
  };
  INFLIGHT_AI_REQUESTS.set(key, entry);
  return { isLeader: true, promise: entry.promise };
}

async function handleClaude(req, res) {
  let reqData;
  try {
    const body = await readRequestBody(req);
    reqData = parseJsonBody(body);
  } catch {
    sendJson(res, 400, { error: 'Geçersiz JSON' });
    return;
  }

  const prompt = String(reqData?.prompt || '').trim();
  const provider = normalizeProvider(reqData?.provider || 'claude');
  const model = String(reqData?.model || '').trim();
  const analysisMode = normalizeAnalysisMode(reqData?.analysisMode || 'balanced');

  if (!prompt) {
    sendJson(res, 400, { error: 'No prompt provided' });
    return;
  }

  const cacheKey = buildAiResponseCacheKey(reqData, prompt, provider, model, analysisMode);
  const cached = getCachedAiResponse(cacheKey);
  if (cached) {
    const ttlLeft = Math.max(0, Math.floor((Number(cached.expiresAt || 0) - Date.now()) / 1000));
    sendJson(res, 200, {
      text: cached.text || '',
      provider,
      providerUsed: cached.providerUsed || provider,
      fallbackUsed: Boolean(cached.fallbackUsed),
      languageAdjusted: Boolean(cached.languageAdjusted),
      pipelineUsed: Boolean(cached.pipelineUsed),
      pipelineTemplate: cached.pipelineTemplate || '',
      pipelineChunkMode: cached.pipelineChunkMode || '',
      pipelineFinalMode: cached.pipelineFinalMode || '',
      pipelineMapReduceUsed: Boolean(cached.pipelineMapReduceUsed),
      externalSearchUsed: Boolean(cached.externalSearchUsed),
      externalSearchQuery: String(cached.externalSearchQuery || ''),
      externalSearchCount: Number(cached.externalSearchCount || 0),
      externalSearchTopics: Array.isArray(cached.externalSearchTopics) ? cached.externalSearchTopics : [],
      cached: true,
      cacheTtlSec: ttlLeft,
      deduped: false,
    });
    return;
  }

  const inflightKey = `ai:${cacheKey}`;
  const inflight = getOrCreateInflight(inflightKey, async () => {
    return generateAiResponse(reqData, { stream: false });
  });

  try {
    const payload = await inflight.promise;
    if (payload?.text && payload.text !== 'Yanıt boş geldi.') {
      setCachedAiResponse(cacheKey, payload, aiResponseCacheTtlSeconds(analysisMode));
    }

    sendJson(res, 200, {
      ...payload,
      deduped: !inflight.isLeader,
      cached: false,
    });
  } catch (e) {
    if (e?.aborted) {
      sendJson(res, 499, { error: 'Request aborted', provider });
      return;
    }
    const status = Number(e?.statusCode || 500);
    const payload = e?.payload && typeof e.payload === 'object'
      ? e.payload
      : { error: String(e?.message || 'Bilinmeyen hata'), provider };
    sendJson(res, status, payload);
  }
}

function writeNdjson(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`);
}

async function handleClaudeStream(req, res) {
  let reqData;
  try {
    const body = await readRequestBody(req);
    reqData = parseJsonBody(body);
  } catch {
    sendJson(res, 400, { error: 'Geçersiz JSON' });
    return;
  }

  const prompt = String(reqData?.prompt || '').trim();
  const provider = normalizeProvider(reqData?.provider || 'claude');
  const model = String(reqData?.model || '').trim();
  const analysisMode = normalizeAnalysisMode(reqData?.analysisMode || 'balanced');

  if (!prompt) {
    sendJson(res, 400, { error: 'No prompt provided' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'close',
    'Access-Control-Allow-Origin': '*',
  });

  let streamOpen = true;
  const emit = (payload) => {
    if (!streamOpen) return false;
    try {
      writeNdjson(res, payload);
      return true;
    } catch {
      streamOpen = false;
      return false;
    }
  };

  req.on('close', () => {
    streamOpen = false;
  });

  emit({
    type: 'meta',
    phase: 'start',
    provider,
    fallbackChain: providerFallbackChainAvailable(provider),
  });

  const cacheKey = buildAiResponseCacheKey(reqData, prompt, provider, model, analysisMode);
  const cached = getCachedAiResponse(cacheKey);
  if (cached) {
    const text = String(cached.text || '');
    const ttlLeft = Math.max(0, Math.floor((Number(cached.expiresAt || 0) - Date.now()) / 1000));
    if (text) {
      const step = 180;
      for (let i = 0; i < text.length; i += step) {
        if (!emit({ type: 'chunk', text: text.slice(i, i + step) })) return;
      }
    }
    emit({
      type: 'done',
      text,
      provider,
      providerUsed: cached.providerUsed || provider,
      fallbackUsed: Boolean(cached.fallbackUsed),
      languageAdjusted: Boolean(cached.languageAdjusted),
      pipelineUsed: Boolean(cached.pipelineUsed),
      pipelineTemplate: cached.pipelineTemplate || '',
      pipelineChunkMode: cached.pipelineChunkMode || '',
      pipelineFinalMode: cached.pipelineFinalMode || '',
      pipelineMapReduceUsed: Boolean(cached.pipelineMapReduceUsed),
      externalSearchUsed: Boolean(cached.externalSearchUsed),
      externalSearchQuery: String(cached.externalSearchQuery || ''),
      externalSearchCount: Number(cached.externalSearchCount || 0),
      externalSearchTopics: Array.isArray(cached.externalSearchTopics) ? cached.externalSearchTopics : [],
      cached: true,
      cacheTtlSec: ttlLeft,
      deduped: false,
    });
    res.end();
    return;
  }

  const inflightKey = `ai:${cacheKey}`;
  const inflight = getOrCreateInflight(inflightKey, async () => {
    const streamProvider = { name: provider };
    const streamFilterState = { buffer: '', directMode: false };
    const streamChunks = [];

    const abortController = new AbortController();
    const onClose = () => abortController.abort();
    req.once('close', onClose);

    try {
      const payload = await generateAiResponse(reqData, {
        stream: true,
        abortSignal: abortController.signal,
        onChunk: (chunk) => {
          const providerForChunk = streamProvider.name || provider;
          const filtered = streamNoiseFilterPush(chunk, providerForChunk, streamFilterState);
          if (!filtered) return;
          streamChunks.push(filtered);
          emit({ type: 'chunk', text: filtered });
        },
        onEvent: (eventPayload) => {
          const phase = String(eventPayload?.phase || '').trim().toLowerCase();
          if (phase === 'provider_start' && eventPayload?.provider) {
            streamProvider.name = normalizeProvider(eventPayload.provider);
            streamFilterState.buffer = '';
            streamFilterState.directMode = false;
          }
          if (String(eventPayload?.type || '').toLowerCase() === 'reset') {
            streamChunks.length = 0;
            streamFilterState.buffer = '';
            streamFilterState.directMode = false;
          }
          emit(eventPayload);
        },
        onReplace: (text) => {
          emit({ type: 'replace', text });
        },
      });

      const tail = streamNoiseFilterFlush(streamProvider.name || provider, streamFilterState);
      if (tail) {
        streamChunks.push(tail);
        emit({ type: 'chunk', text: tail });
      }

      let finalText = String(payload.text || '').trim();
      if (!finalText) {
        finalText = sanitizeProviderOutput(streamChunks.join(''), streamProvider.name || provider);
      }

      const finalPayload = {
        ...payload,
        text: finalText,
      };

      if (finalPayload.text && finalPayload.text !== 'Yanıt boş geldi.') {
        setCachedAiResponse(cacheKey, finalPayload, aiResponseCacheTtlSeconds(analysisMode));
      }

      return finalPayload;
    } finally {
      req.removeListener('close', onClose);
    }
  });

  try {
    const payload = await inflight.promise;
    if (!inflight.isLeader) {
      const text = String(payload?.text || '');
      if (text) {
        const step = 180;
        for (let i = 0; i < text.length; i += step) {
          if (!emit({ type: 'chunk', text: text.slice(i, i + step) })) break;
        }
      }
    }

    emit({
      type: 'done',
      ...payload,
      deduped: !inflight.isLeader,
      cached: false,
    });
  } catch (e) {
    if (!streamOpen) return;
    const status = Number(e?.statusCode || 500);
    const payload = e?.payload && typeof e.payload === 'object'
      ? e.payload
      : { error: String(e?.message || 'Bilinmeyen hata'), provider };

    emit({ type: 'error', ...payload, statusCode: status });
    emit({ type: 'done', error: true });
  } finally {
    if (streamOpen) {
      res.end();
    }
  }
}

async function handleAiHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    providers: getProviderHealthSnapshot(),
    fallbackChains: {
      codex: providerFallbackChain('codex'),
      gemini: providerFallbackChain('gemini'),
      claude: providerFallbackChain('claude'),
    },
    activeFallbackChains: {
      codex: providerFallbackChainAvailable('codex'),
      gemini: providerFallbackChainAvailable('gemini'),
      claude: providerFallbackChainAvailable('claude'),
    },
    timestamp: Math.floor(Date.now() / 1000),
  });
}

function internalMcpTokenMatches(req) {
  const provided = String(req.headers['x-zdash-token'] || '').trim();
  return Boolean(provided) && provided === LOCAL_MCP_BRIDGE_TOKEN;
}

async function handleInternalMcpTool(req, res) {
  if (!internalMcpTokenMatches(req)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  let body = {};
  try {
    const raw = await readRequestBody(req, 1024 * 1024);
    body = raw && raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch (e) {
    sendJson(res, 400, { error: `Geçersiz JSON: ${String(e.message || e)}` });
    return;
  }

  const name = String(body?.name || '').trim();
  const args = body?.arguments && typeof body.arguments === 'object' ? body.arguments : {};
  if (!name) {
    sendJson(res, 400, { error: 'Tool name required' });
    return;
  }

  try {
    const result = await invokeInternalMcpTool(name, args);
    sendJson(res, 200, { ok: true, result });
  } catch (e) {
    const text = String(e?.message || e || 'Tool failed');
    sendJson(res, 200, {
      ok: true,
      result: {
        content: [{ type: 'text', text }],
        isError: true,
      },
    });
  }
}

async function handleCliConfigGet(req, res) {
  const overrides = await readCliCommandOverrides();
  sendJson(res, 200, {
    ok: true,
    overrides,
    resolved: {
      claude: resolveProviderCommand('claude'),
      codex: resolveProviderCommand('codex'),
      gemini: resolveProviderCommand('gemini'),
    },
  });
}

async function handleCliConfigPost(req, res) {
  let payload = {};
  try {
    payload = parseJsonBody(await readRequestBody(req, 256 * 1024));
  } catch (e) {
    sendJson(res, 400, { error: `Geçersiz JSON: ${String(e.message || e)}` });
    return;
  }

  const overrides = normalizeCliCommandOverrides(payload);
  await writeJsonFile(CLI_CONFIG_FILE, overrides);
  sendJson(res, 200, {
    ok: true,
    overrides,
    resolved: {
      claude: resolveProviderCommand('claude'),
      codex: resolveProviderCommand('codex'),
      gemini: resolveProviderCommand('gemini'),
    },
  });
}

async function handleSelfCheck(req, res) {
  const zotero = await zoteroDesktopProbe();
  const mcpSetup = resolveZoteroMcpSetup();
  const mcpCommand = String(mcpSetup?.command || 'zotero-mcp').trim() || 'zotero-mcp';
  const mcpArgs = Array.isArray(mcpSetup?.args) ? mcpSetup.args.map((arg) => String(arg)) : [];
  const mcpEnv = mcpSetup?.env && typeof mcpSetup.env === 'object' ? { ...process.env, ...mcpSetup.env } : process.env;

  const mcpProbe = await commandProbe(mcpCommand, [...mcpArgs, '--help'], 5, RUNTIME_DIR, mcpEnv);
  const claudeProbe = await commandProbe(resolveProviderCommand('claude'), ['--version'], 5, RUNTIME_DIR, process.env);
  const codexProbe = await commandProbe(resolveProviderCommand('codex'), ['--version'], 5, RUNTIME_DIR, process.env);
  const geminiProbe = await commandProbe(resolveProviderCommand('gemini'), ['--version'], 5, RUNTIME_DIR, process.env);

  const checks = {
    zoteroDesktop: zotero,
    zoteroMcp: { ...mcpProbe, command: mcpCommand, args: mcpArgs, mode: String(mcpSetup?.kind || 'external') },
    claudeCli: claudeProbe,
    codexCli: codexProbe,
    geminiCli: geminiProbe,
  };

  const zoteroOk = String(checks.zoteroDesktop?.status || '').toLowerCase() === 'ok';
  const mcpOk = String(checks.zoteroMcp?.status || '').toLowerCase() === 'ok';
  const anyCliOk = ['claudeCli', 'codexCli', 'geminiCli'].some((key) => String(checks[key]?.status || '').toLowerCase() === 'ok');

  sendJson(res, 200, {
    ok: zoteroOk && mcpOk && anyCliOk,
    checks,
    timestamp: Math.floor(Date.now() / 1000),
  });
}

async function handleObsidianConfigGet(req, res) {
  const envOverride = normalizeDirectory(process.env.OBSIDIAN_ZOTDASHBOARD_DIR || '');
  const saved = normalizeDirectory((await readJsonFileWithFallback(OBSIDIAN_CONFIG_FILE, OBSIDIAN_CONFIG_FILE_LEGACY)).directory || '');
  const active = getObsidianTargetDir({ directory: saved || envOverride });
  const directory = saved || envOverride;

  sendJson(res, 200, {
    configured: Boolean(directory),
    directory,
    activeDirectory: active,
    configurable: !Boolean(envOverride),
  });
}

async function handleObsidianConfigPost(req, res) {
  let reqData;
  try {
    reqData = parseJsonBody(await readRequestBody(req));
  } catch {
    sendJson(res, 400, { error: 'Geçersiz JSON' });
    return;
  }

  const directory = normalizeDirectory(reqData?.directory || '');
  if (!directory) {
    sendJson(res, 400, { error: 'Klasör yolu boş olamaz' });
    return;
  }

  try {
    await fsp.mkdir(directory, { recursive: true });
  } catch (e) {
    sendJson(res, 400, { error: `Klasör oluşturulamadı: ${String(e.message || e)}` });
    return;
  }

  try {
    await writeJsonFile(OBSIDIAN_CONFIG_FILE, {
      directory,
      updatedAt: formatTimestamp(),
    });
  } catch (e) {
    sendJson(res, 500, { error: `Ayar kaydedilemedi: ${String(e.message || e)}` });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    directory,
    configurable: true,
  });
}

async function handleObsidianSync(req, res) {
  let reqData;
  try {
    reqData = parseJsonBody(await readRequestBody(req, 16 * 1024 * 1024));
  } catch {
    sendJson(res, 400, { error: 'Geçersiz JSON' });
    return;
  }

  const title = String(reqData?.title || 'Makale').trim() || 'Makale';
  const year = String(reqData?.year || 'tarihsiz').trim() || 'tarihsiz';
  const noteContent = String(reqData?.content || '').trim();
  const itemKey = String(reqData?.itemKey || '').trim();
  const provider = String(reqData?.provider || '').trim();
  const language = String(reqData?.language || '').trim();
  const requestedTarget = normalizeDirectory(reqData?.targetDir || '');

  if (!noteContent) {
    sendJson(res, 400, { error: 'Boş not senkronize edilemez' });
    return;
  }

  try {
    const savedConfig = await readJsonFileWithFallback(OBSIDIAN_CONFIG_FILE, OBSIDIAN_CONFIG_FILE_LEGACY);
    const targetDir = requestedTarget || getObsidianTargetDir(savedConfig);
    await fsp.mkdir(targetDir, { recursive: true });

    const filename = `${sanitizeFilename(`${title}-${year}`)}.md`;
    const filePath = path.join(targetDir, filename);

    const markdown = [
      `# ${title} (${year})`,
      '',
      noteContent,
      '',
      '---',
      `- Zotero Key: \`${itemKey || '-'}\``,
      `- AI Provider: \`${provider || '-'}\``,
      `- Language: \`${language || '-'}\``,
      `- Synced At: \`${formatTimestamp()}\``,
      '',
    ].join('\n');

    await fsp.writeFile(filePath, markdown, 'utf-8');

    sendJson(res, 200, {
      ok: true,
      path: filePath,
      file: filename,
    });
  } catch (e) {
    sendJson(res, 500, { error: `Obsidian senkronizasyon hatası: ${String(e.message || e)}` });
  }
}

function addCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Zdash-Token');
}

export function createServer() {
  return http.createServer(async (req, res) => {
  addCorsHeaders(res);

  const method = String(req.method || 'GET').toUpperCase();
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = normalizeRequestPath(url.pathname || '/');

  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    if (pathname.startsWith('/api/')) {
      await proxyToZotero(req, res);
      return;
    }

    if (pathname.startsWith('/pdf/')) {
      await servePdf(req, res, pathname);
      return;
    }

    if (method === 'GET' && pathname === '/ai-health') {
      await handleAiHealth(req, res);
      return;
    }

    if (method === 'GET' && pathname === '/self-check') {
      await handleSelfCheck(req, res);
      return;
    }

    if (method === 'POST' && pathname === '/internal/mcp/tool') {
      await handleInternalMcpTool(req, res);
      return;
    }

    if (method === 'GET' && pathname === '/cli-config') {
      await handleCliConfigGet(req, res);
      return;
    }

    if (method === 'POST' && pathname === '/cli-config') {
      await handleCliConfigPost(req, res);
      return;
    }

    if (method === 'GET' && pathname === '/obsidian-config') {
      await handleObsidianConfigGet(req, res);
      return;
    }

    if (method === 'POST' && pathname === '/obsidian-config') {
      await handleObsidianConfigPost(req, res);
      return;
    }

    if (method === 'POST' && pathname === '/obsidian-sync') {
      await handleObsidianSync(req, res);
      return;
    }

    if (method === 'POST' && pathname === '/claude') {
      await handleClaude(req, res);
      return;
    }

    if (method === 'POST' && pathname === '/claude-stream') {
      await handleClaudeStream(req, res);
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      await serveStatic(req, res, pathname);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    sendJson(res, 500, { error: String(e?.message || e || 'Server error') });
  }
  });
}

export function startServer(port = PORT) {
  enrichEnvPathForCli(process.env);
  const server = createServer();
  server.listen(port, HOST, () => {
    const addr = server.address();
    const actualPort = addr && typeof addr === 'object' ? addr.port : port;
    process.env.ZOTERO_DASHBOARD_BASE_URL = `http://${HOST}:${actualPort}`;
    console.log(`Orhon's Zotero Dashboard (Node) started: http://localhost:${actualPort}`);
    console.log(`Zotero API proxy target: ${ZOTERO_API}`);
    console.log(`Zotero storage: ${ZOTERO_STORAGE}`);
    console.log('If port is busy, stop existing process and run again.');
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startServer(PORT);
}
