#!/usr/bin/env python3
"""
Orhon's Zotero Dashboard Server
Serves dashboard, proxies Zotero API, serves PDFs, runs AI CLIs for analysis.
Usage: python3 serve.py
Then open http://localhost:8080
"""
import http.server
import urllib.request
import urllib.error
import urllib.parse
import json
import html
import os
import re
import hashlib
import subprocess
import mimetypes
import threading
import shutil
import time
import queue
import select
import glob
import codecs
from datetime import datetime
from urllib.parse import unquote

try:
    import pty
except ImportError:
    pty = None


def detect_zotero_storage_candidates():
    env_dir = str(os.environ.get("ZOTERO_STORAGE_DIR", "")).strip()
    candidates = [env_dir, "~/Zotero/storage"]
    if os.name == "nt":
        appdata = str(os.environ.get("APPDATA", "")).strip()
        if appdata:
            profile_glob = os.path.join(appdata, "Zotero", "Zotero", "Profiles", "*", "zotero", "storage")
            candidates.extend(glob.glob(profile_glob))
        user_profile = str(os.environ.get("USERPROFILE", "")).strip()
        if user_profile:
            candidates.append(os.path.join(user_profile, "Zotero", "storage"))

    normalized = []
    seen = set()
    for candidate in candidates:
        expanded = os.path.abspath(os.path.expanduser(str(candidate or "").strip()))
        if not expanded:
            continue
        lowered = expanded.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        normalized.append(expanded)
    return normalized or [os.path.abspath(os.path.expanduser("~/Zotero/storage"))]


def detect_zotero_storage_dir():
    for candidate in detect_zotero_storage_candidates():
        if os.path.isdir(candidate):
            return candidate
    return detect_zotero_storage_candidates()[0]


def default_zotero_mcp_command():
    if os.name == "nt":
        return "zotero-mcp.cmd"
    return os.path.expanduser("~/.local/bin/zotero-mcp")


PORT = 8080
ZOTERO_API = "http://localhost:23119"
ZOTERO_STORAGE = detect_zotero_storage_dir()
ZOTERO_STORAGE_CANDIDATES = detect_zotero_storage_candidates()
DIR = os.path.dirname(os.path.abspath(__file__))
OBSIDIAN_CONFIG_FILE = os.path.join(DIR, ".obsidian-config.json")
CLAUDE_MCP_CONFIG_FILE = os.path.join(DIR, ".mcp-zotero.json")
GEMINI_WORKSPACE_DIR = os.path.join(DIR, ".gemini")
GEMINI_WORKSPACE_SETTINGS_FILE = os.path.join(GEMINI_WORKSPACE_DIR, "settings.json")
ZOTERO_MCP_COMMAND_DEFAULT = default_zotero_mcp_command()

# In-memory TTL caches for faster repeated analysis and Zotero item lookups.
AI_RESPONSE_CACHE = {}
AI_RESPONSE_CACHE_LOCK = threading.Lock()
AI_RESPONSE_CACHE_MAX_ENTRIES = 800
AI_RESPONSE_CACHE_TTL_SECONDS = {
    "fast": 10 * 60,
    "balanced": 20 * 60,
    "deep": 30 * 60,
}

EXTERNAL_SEARCH_CACHE = {}
EXTERNAL_SEARCH_CACHE_LOCK = threading.Lock()
EXTERNAL_SEARCH_CACHE_MAX_ENTRIES = 600
EXTERNAL_SEARCH_CACHE_TTL_SECONDS = 20 * 60

TOOL_RESULT_CACHE = {}
TOOL_RESULT_CACHE_LOCK = threading.Lock()
TOOL_RESULT_CACHE_MAX_ENTRIES = 1200
TOOL_RESULT_CACHE_TTL_SECONDS = {
    "metadata": 15 * 60,
    "fulltext": 10 * 60,
    "notes": 10 * 60,
}

INFLIGHT_AI_REQUESTS = {}
INFLIGHT_AI_REQUESTS_LOCK = threading.Lock()
INFLIGHT_WAIT_TIMEOUT_SECONDS = 420

PROVIDER_HEALTH = {
    "claude": {"status": "unknown", "lastError": "", "lastSuccessAt": 0.0, "lastCheckedAt": 0.0, "latencyMs": 0},
    "codex": {"status": "unknown", "lastError": "", "lastSuccessAt": 0.0, "lastCheckedAt": 0.0, "latencyMs": 0},
    "gemini": {"status": "unknown", "lastError": "", "lastSuccessAt": 0.0, "lastCheckedAt": 0.0, "latencyMs": 0},
}
PROVIDER_HEALTH_LOCK = threading.Lock()

PROVIDER_CIRCUIT = {
    "claude": {"openUntil": 0.0, "reason": "", "category": "", "openedAt": 0.0},
    "codex": {"openUntil": 0.0, "reason": "", "category": "", "openedAt": 0.0},
    "gemini": {"openUntil": 0.0, "reason": "", "category": "", "openedAt": 0.0},
}
PROVIDER_CIRCUIT_LOCK = threading.Lock()
PROVIDER_CIRCUIT_COOLDOWN_SECONDS = {
    "rate_limit": 300,
    "timeout": 180,
    "unavailable": 240,
    "error": 120,
}
try:
    MAX_SERVER_WORKERS = max(4, int(str(os.environ.get("SERVER_MAX_WORKERS", "24")).strip() or "24"))
except Exception:
    MAX_SERVER_WORKERS = 24

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path.startswith('/api/'):
            self.proxy_to_zotero(method='GET')
        elif path.startswith('/pdf/'):
            self.serve_pdf()
        elif path == '/ai-health':
            self.get_ai_health()
        elif path == '/self-check':
            self.get_self_check()
        elif path == '/obsidian-config':
            self.get_obsidian_config()
        else:
            super().do_GET()

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        if path == '/claude':
            self.run_claude()
        elif path == '/claude-stream':
            self.run_claude_stream()
        elif path == '/obsidian-sync':
            self.run_obsidian_sync()
        elif path == '/obsidian-config':
            self.set_obsidian_config()
        elif path.startswith('/api/'):
            self.proxy_to_zotero(method='POST')
        else:
            self.send_error(404)

    def do_PUT(self):
        if self.path.startswith('/api/'):
            self.proxy_to_zotero(method='PUT')
        else:
            self.send_error(404)

    def do_PATCH(self):
        if self.path.startswith('/api/'):
            self.proxy_to_zotero(method='PATCH')
        else:
            self.send_error(404)

    def do_DELETE(self):
        if self.path.startswith('/api/'):
            self.proxy_to_zotero(method='DELETE')
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def proxy_to_zotero(self, method='GET'):
        url = f"{ZOTERO_API}{self.path}"
        try:
            body = None
            if method in {'POST', 'PUT', 'PATCH'}:
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length) if content_length > 0 else None

            if method in {'POST', 'PUT', 'PATCH', 'DELETE'}:
                # Any write operation can invalidate both tool-level and AI response caches.
                self.clear_all_caches()

            cache_profile = None
            cache_key = None
            if method == 'GET':
                cache_profile = self.tool_cache_profile_for_path(self.path)
                if cache_profile:
                    cache_key = self.tool_cache_key(self.path)
                    cached = self.get_cached_tool_result(cache_key)
                    if cached:
                        self.send_response(int(cached.get("status", 200)))
                        for header, value in (cached.get("headers", {}) or {}).items():
                            if value:
                                self.send_header(header, value)
                        self.send_header('Access-Control-Allow-Origin', '*')
                        self.send_header('X-Zotero-Cache', 'HIT')
                        self.end_headers()
                        self.wfile.write(cached.get("body", b""))
                        return

            req = urllib.request.Request(url, data=body, method=method)
            content_type = self.headers.get('Content-Type')
            if content_type:
                req.add_header('Content-Type', content_type)

            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read()
                self.send_response(resp.status)
                forwarded_headers = {}
                for header in ['Content-Type', 'Total-Results', 'Link', 'Last-Modified-Version', 'ETag']:
                    val = resp.getheader(header)
                    if val:
                        forwarded_headers[header] = val
                        self.send_header(header, val)
                self.send_header('Access-Control-Allow-Origin', '*')
                if cache_profile:
                    self.send_header('X-Zotero-Cache', 'MISS')
                self.end_headers()
                self.wfile.write(body)

                if cache_profile and cache_key and resp.status == 200:
                    self.set_cached_tool_result(
                        cache_key,
                        {
                            "status": resp.status,
                            "headers": forwarded_headers,
                            "body": body,
                        },
                        cache_profile.get("ttl", 300),
                    )
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            self.send_header('Content-Type', e.headers.get('Content-Type', 'application/json'))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body or json.dumps({"error": str(e)}).encode())
        except urllib.error.URLError as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def send_json(self, status, payload):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

    def resolve_command_from_candidates(self, candidates):
        for candidate in candidates:
            command = str(candidate or "").strip()
            if not command:
                continue
            if os.path.isabs(command):
                if os.path.exists(command):
                    return command
                continue
            resolved = shutil.which(command)
            if resolved:
                return resolved
        return ""

    def provider_command_candidates(self, provider):
        normalized = self.normalize_provider(provider)
        env_key = {
            "claude": "CLAUDE_COMMAND",
            "codex": "CODEX_COMMAND",
            "gemini": "GEMINI_COMMAND",
        }.get(normalized, "")
        env_cmd = str(os.environ.get(env_key, "")).strip() if env_key else ""
        candidates = [env_cmd]

        if normalized == "claude":
            if os.name == "nt":
                local_app_data = str(os.environ.get("LOCALAPPDATA", "")).strip()
                if local_app_data:
                    candidates.extend(
                        [
                            os.path.join(local_app_data, "Programs", "Claude", "claude.exe"),
                            os.path.join(local_app_data, "Programs", "Claude", "claude.cmd"),
                        ]
                    )
                candidates.extend(["claude.cmd", "claude.exe", "claude"])
            else:
                candidates.extend([os.path.expanduser("~/.local/bin/claude"), "claude"])
            return candidates

        if normalized == "codex":
            if os.name == "nt":
                candidates.extend(["codex.cmd", "codex.exe", "codex"])
            else:
                candidates.append("codex")
            return candidates

        if normalized == "gemini":
            if os.name == "nt":
                candidates.extend(["gemini.cmd", "gemini.exe", "gemini"])
            else:
                candidates.append("gemini")
            return candidates

        return candidates

    def resolve_provider_command(self, provider):
        normalized = self.normalize_provider(provider)
        resolved = self.resolve_command_from_candidates(self.provider_command_candidates(normalized))
        if resolved:
            return resolved
        return {"claude": "claude", "codex": "codex", "gemini": "gemini"}.get(normalized, "claude")

    def provider_binary_available(self, provider):
        provider = self.normalize_provider(provider)
        return bool(self.resolve_command_from_candidates(self.provider_command_candidates(provider)))

    def update_provider_health(self, provider, status, error="", latency_ms=0):
        provider = self.normalize_provider(provider)
        now = time.time()
        with PROVIDER_HEALTH_LOCK:
            state = PROVIDER_HEALTH.get(provider, {}).copy()
            state["status"] = str(status or "unknown")
            state["lastCheckedAt"] = now
            state["latencyMs"] = int(latency_ms or 0)
            if error:
                state["lastError"] = str(error)[:320]
            elif state["status"] == "ok":
                state["lastError"] = ""
            if state["status"] == "ok":
                state["lastSuccessAt"] = now
            PROVIDER_HEALTH[provider] = state
        if str(status or "").lower() == "ok":
            self.provider_circuit_close(provider)

    def provider_circuit_state(self, provider):
        provider = self.normalize_provider(provider)
        now = time.time()
        with PROVIDER_CIRCUIT_LOCK:
            state = PROVIDER_CIRCUIT.get(provider, {}).copy()
        open_until = float(state.get("openUntil", 0.0))
        cooldown = max(0, int(open_until - now))
        return {
            "open": cooldown > 0,
            "cooldownSec": cooldown,
            "openUntil": open_until,
            "reason": str(state.get("reason", "")),
            "category": str(state.get("category", "")),
            "openedAt": float(state.get("openedAt", 0.0)),
        }

    def provider_circuit_close(self, provider):
        provider = self.normalize_provider(provider)
        with PROVIDER_CIRCUIT_LOCK:
            state = PROVIDER_CIRCUIT.get(provider, {}).copy()
            state["openUntil"] = 0.0
            state["reason"] = ""
            state["category"] = ""
            state["openedAt"] = 0.0
            PROVIDER_CIRCUIT[provider] = state

    def provider_circuit_open(self, provider, category, reason):
        provider = self.normalize_provider(provider)
        normalized_category = str(category or "error").strip().lower()
        if normalized_category not in PROVIDER_CIRCUIT_COOLDOWN_SECONDS:
            normalized_category = "error"
        cooldown = int(PROVIDER_CIRCUIT_COOLDOWN_SECONDS.get(normalized_category, 120))
        now = time.time()
        with PROVIDER_CIRCUIT_LOCK:
            state = PROVIDER_CIRCUIT.get(provider, {}).copy()
            prev_until = float(state.get("openUntil", 0.0))
            state["openUntil"] = max(prev_until, now + cooldown)
            state["reason"] = str(reason or "")[:320]
            state["category"] = normalized_category
            state["openedAt"] = now
            PROVIDER_CIRCUIT[provider] = state

    def provider_failure_category(self, message):
        normalized = str(message or "").lower()
        if self.is_rate_limit_error(normalized):
            return "rate_limit"
        if "zaman aşımı" in normalized or "timeout" in normalized:
            return "timeout"
        if "cli bulunamadı" in normalized or "not found" in normalized:
            return "unavailable"
        return "error"

    def get_provider_health_snapshot(self):
        snapshot = {}
        now = time.time()
        allowed_statuses = {"ok", "degraded", "cooldown", "down", "unknown"}
        with PROVIDER_HEALTH_LOCK:
            for provider in ("claude", "codex", "gemini"):
                state = PROVIDER_HEALTH.get(provider, {}).copy()
                available = self.provider_binary_available(provider)
                status = str(state.get("status") or "unknown").strip().lower()
                if status not in allowed_statuses:
                    status = "unknown"
                state["status"] = status
                normalized_from_unknown = False
                if status == "unknown":
                    state["lastCheckedAt"] = now
                    if available:
                        # If CLI exists but no request has run yet, show as healthy/ready
                        # instead of "unknown" so UI status is immediately meaningful.
                        state["status"] = "ok"
                        state["lastError"] = ""
                    else:
                        state["status"] = "down"
                        state["lastError"] = "CLI not found"
                    normalized_from_unknown = True
                circuit = self.provider_circuit_state(provider)
                state["cooldownSec"] = circuit["cooldownSec"]
                state["cooldownReason"] = circuit.get("reason", "")
                if circuit["open"] and state.get("status") != "down":
                    state["status"] = "cooldown"
                    if not state.get("lastError"):
                        state["lastError"] = circuit.get("reason") or "Circuit breaker open"
                state["available"] = available
                snapshot[provider] = state
                if normalized_from_unknown:
                    # Persist once to avoid changing timestamps on every poll,
                    # which causes unnecessary UI re-renders.
                    PROVIDER_HEALTH[provider] = state.copy()
        return snapshot

    def get_ai_health(self):
        self.send_json(
            200,
            {
                "ok": True,
                "providers": self.get_provider_health_snapshot(),
                "fallbackChains": {
                    "codex": self.provider_fallback_chain("codex"),
                    "gemini": self.provider_fallback_chain("gemini"),
                    "claude": self.provider_fallback_chain("claude"),
                },
                "activeFallbackChains": {
                    "codex": self.provider_fallback_chain_available("codex"),
                    "gemini": self.provider_fallback_chain_available("gemini"),
                    "claude": self.provider_fallback_chain_available("claude"),
                },
                "timestamp": int(time.time()),
            },
        )

    def provider_fallback_chain(self, requested_provider):
        requested = self.normalize_provider(requested_provider)
        priority = ["codex", "gemini", "claude"]
        rest = [p for p in priority if p != requested]
        return [requested] + rest

    def provider_fallback_chain_available(self, requested_provider):
        ordered = self.provider_fallback_chain(requested_provider)
        available = [provider for provider in ordered if not self.provider_circuit_state(provider)["open"]]
        if not available:
            return ordered[:1]
        return available

    def command_probe(self, command, args=None, timeout=4, cwd=None, env=None):
        args = list(args or [])
        executable = command
        if not os.path.isabs(str(command or "")):
            executable = shutil.which(str(command or ""))
        if not executable or not os.path.exists(executable):
            return {
                "status": "down",
                "available": False,
                "detail": "CLI not found",
                "command": str(command or ""),
            }
        try:
            result = subprocess.run(
                [executable] + args,
                capture_output=True,
                text=True,
                timeout=max(1, int(timeout or 4)),
                cwd=cwd or DIR,
                env=env,
            )
            out = (result.stdout or "").strip()
            err = (result.stderr or "").strip()
            first_line = (out or err or "").splitlines()
            detail = first_line[0][:180] if first_line else ""
            if result.returncode == 0:
                return {
                    "status": "ok",
                    "available": True,
                    "detail": detail or "ok",
                    "command": executable,
                }
            return {
                "status": "degraded",
                "available": True,
                "detail": detail or f"exit code {result.returncode}",
                "command": executable,
            }
        except subprocess.TimeoutExpired:
            return {
                "status": "degraded",
                "available": True,
                "detail": "timeout",
                "command": executable,
            }
        except Exception as e:
            return {
                "status": "degraded",
                "available": True,
                "detail": str(e)[:180],
                "command": executable,
            }

    def zotero_desktop_probe(self):
        started = time.time()
        probe_url = f"{ZOTERO_API}/api/users/0/items?format=json&limit=1"
        try:
            with urllib.request.urlopen(probe_url, timeout=3) as resp:
                _ = resp.read(80)
            return {
                "status": "ok",
                "detail": "reachable",
                "latencyMs": int((time.time() - started) * 1000),
            }
        except Exception as e:
            return {
                "status": "down",
                "detail": str(e)[:180],
                "latencyMs": int((time.time() - started) * 1000),
            }

    def get_self_check(self):
        zotero = self.zotero_desktop_probe()
        mcp_command = self.resolve_zotero_mcp_command()
        mcp_probe = self.command_probe(mcp_command, args=["--help"], timeout=5, cwd=DIR)
        claude_probe = self.command_probe(self.resolve_provider_command("claude"), args=["--version"], timeout=5, cwd=DIR)
        codex_probe = self.command_probe(self.resolve_provider_command("codex"), args=["--version"], timeout=5, cwd=DIR)
        gemini_probe = self.command_probe(self.resolve_provider_command("gemini"), args=["--version"], timeout=5, cwd=DIR)

        checks = {
            "zoteroDesktop": zotero,
            "zoteroMcp": {**mcp_probe, "command": mcp_command},
            "claudeCli": claude_probe,
            "codexCli": codex_probe,
            "geminiCli": gemini_probe,
        }
        zotero_ok = str(checks["zoteroDesktop"].get("status", "")).lower() == "ok"
        mcp_ok = str(checks["zoteroMcp"].get("status", "")).lower() == "ok"
        any_cli_ok = any(
            str(checks[cli].get("status", "")).lower() == "ok"
            for cli in ("claudeCli", "codexCli", "geminiCli")
        )
        is_ok = zotero_ok and mcp_ok and any_cli_ok
        self.send_json(
            200,
            {
                "ok": is_ok,
                "checks": checks,
                "timestamp": int(time.time()),
            },
        )

    def inflight_acquire(self, inflight_key):
        now = time.time()
        with INFLIGHT_AI_REQUESTS_LOCK:
            stale_keys = []
            for key, entry in INFLIGHT_AI_REQUESTS.items():
                created_at = float(entry.get("created_at", 0))
                finished_at = float(entry.get("finished_at", 0))
                done = bool(entry.get("done"))
                if done and now - finished_at > 30:
                    stale_keys.append(key)
                elif not done and now - created_at > INFLIGHT_WAIT_TIMEOUT_SECONDS * 2:
                    stale_keys.append(key)
            for key in stale_keys:
                INFLIGHT_AI_REQUESTS.pop(key, None)

            existing = INFLIGHT_AI_REQUESTS.get(inflight_key)
            if existing:
                return False, existing

            entry = {
                "event": threading.Event(),
                "done": False,
                "status": 0,
                "payload": {},
                "created_at": now,
                "finished_at": 0.0,
            }
            INFLIGHT_AI_REQUESTS[inflight_key] = entry
            return True, entry

    def inflight_complete(self, inflight_key, entry, status, payload):
        entry["status"] = int(status or 500)
        entry["payload"] = dict(payload or {})
        entry["done"] = True
        entry["finished_at"] = time.time()
        entry["event"].set()
        with INFLIGHT_AI_REQUESTS_LOCK:
            if INFLIGHT_AI_REQUESTS.get(inflight_key) is entry:
                INFLIGHT_AI_REQUESTS.pop(inflight_key, None)

    def inflight_wait_for_result(self, entry):
        event = entry.get("event")
        if not event:
            return None
        if not event.wait(INFLIGHT_WAIT_TIMEOUT_SECONDS):
            return None
        return {
            "status": int(entry.get("status", 500)),
            "payload": dict(entry.get("payload", {})),
        }

    def read_obsidian_config(self):
        try:
            with open(OBSIDIAN_CONFIG_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except FileNotFoundError:
            return {}
        except Exception:
            return {}
        return {}

    def write_obsidian_config(self, directory):
        payload = {
            "directory": directory,
            "updatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        with open(OBSIDIAN_CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)

    def normalize_directory(self, raw):
        path = str(raw or "").strip()
        if not path:
            return ""
        return os.path.abspath(os.path.expanduser(path))

    def get_obsidian_config(self):
        env_override = self.normalize_directory(os.environ.get("OBSIDIAN_ZOTDASHBOARD_DIR", ""))
        saved = self.normalize_directory(self.read_obsidian_config().get("directory", ""))
        active = self.get_obsidian_target_dir()
        directory = saved or env_override

        self.send_json(
            200,
            {
                "configured": bool(directory),
                "directory": directory,
                "activeDirectory": active,
                "configurable": not bool(env_override),
            },
        )

    def set_obsidian_config(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        try:
            req_data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json(400, {"error": "Geçersiz JSON"})
            return

        directory = self.normalize_directory(req_data.get("directory", ""))
        if not directory:
            self.send_json(400, {"error": "Klasör yolu boş olamaz"})
            return

        try:
            os.makedirs(directory, exist_ok=True)
        except Exception as e:
            self.send_json(400, {"error": f"Klasör oluşturulamadı: {e}"})
            return

        try:
            self.write_obsidian_config(directory)
        except Exception as e:
            self.send_json(500, {"error": f"Ayar kaydedilemedi: {e}"})
            return

        self.send_json(
            200,
            {
                "ok": True,
                "directory": directory,
                "configurable": True,
            },
        )

    def get_obsidian_target_dir(self):
        saved = self.normalize_directory(self.read_obsidian_config().get("directory", ""))
        if saved:
            return saved

        custom = self.normalize_directory(os.environ.get("OBSIDIAN_ZOTDASHBOARD_DIR", ""))
        if custom:
            return custom

        candidates = [
            "~/Documents/Obsidian/ZotDashboard",
            "~/Obsidian/ZotDashboard",
            "~/Documents/ZotDashboard",
        ]
        for path in candidates:
            expanded = os.path.expanduser(path)
            if os.path.isdir(expanded):
                return expanded

        return self.normalize_directory("~/Documents/Obsidian/ZotDashboard")

    def sanitize_filename(self, raw):
        name = str(raw or "").strip()
        if not name:
            name = "ai-note"

        name = re.sub(r'[\\/:*?"<>|]+', '-', name)
        name = re.sub(r'\s+', ' ', name).strip(" .")
        if len(name) > 150:
            name = name[:150].rstrip()
        return name or "ai-note"

    def run_obsidian_sync(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        try:
            req_data = json.loads(body)
        except json.JSONDecodeError:
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Geçersiz JSON"}).encode())
            return

        title = str(req_data.get("title", "Makale")).strip() or "Makale"
        year = str(req_data.get("year", "tarihsiz")).strip() or "tarihsiz"
        note_content = str(req_data.get("content", "")).strip()
        item_key = str(req_data.get("itemKey", "")).strip()
        provider = str(req_data.get("provider", "")).strip()
        language = str(req_data.get("language", "")).strip()
        requested_target = self.normalize_directory(req_data.get("targetDir", ""))

        if not note_content:
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Boş not senkronize edilemez"}).encode())
            return

        try:
            target_dir = requested_target or self.get_obsidian_target_dir()
            os.makedirs(target_dir, exist_ok=True)

            filename = self.sanitize_filename(f"{title}-{year}") + ".md"
            file_path = os.path.join(target_dir, filename)

            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            markdown = (
                f"# {title} ({year})\n\n"
                f"{note_content}\n\n"
                f"---\n"
                f"- Zotero Key: `{item_key or '-'}`\n"
                f"- AI Provider: `{provider or '-'}`\n"
                f"- Language: `{language or '-'}`\n"
                f"- Synced At: `{timestamp}`\n"
            )

            with open(file_path, "w", encoding="utf-8") as f:
                f.write(markdown)

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "ok": True,
                        "path": file_path,
                        "file": filename,
                    }
                ).encode()
            )
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"Obsidian senkronizasyon hatası: {e}"}).encode())

    def serve_pdf(self):
        path_parts = unquote(self.path[5:])
        resolved_path = ""
        roots = [ZOTERO_STORAGE] + [root for root in ZOTERO_STORAGE_CANDIDATES if root != ZOTERO_STORAGE]
        for root in roots:
            root_real = os.path.realpath(root)
            candidate = os.path.realpath(os.path.join(root_real, path_parts))
            if not candidate.startswith(root_real):
                continue
            if os.path.isfile(candidate):
                resolved_path = candidate
                break
        if not resolved_path:
            self.send_error(404, "File not found")
            return
        full_path = resolved_path
        content_type, _ = mimetypes.guess_type(full_path)
        content_type = content_type or 'application/octet-stream'
        try:
            file_size = os.path.getsize(full_path)
            if file_size <= 0:
                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', '0')
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Disposition', 'inline')
                self.end_headers()
                return
            range_header = str(self.headers.get('Range', '') or '').strip()

            start = 0
            end = max(0, file_size - 1)
            status = 200

            if range_header.startswith("bytes="):
                m = re.match(r"^bytes=(\d*)-(\d*)$", range_header)
                if m:
                    start_raw, end_raw = m.group(1), m.group(2)
                    if start_raw == "" and end_raw == "":
                        m = None
                    else:
                        try:
                            if start_raw == "":
                                # Suffix range: bytes=-N
                                suffix = int(end_raw)
                                if suffix > 0:
                                    start = max(0, file_size - suffix)
                            else:
                                start = int(start_raw)
                            if end_raw != "":
                                end = int(end_raw)
                            else:
                                end = file_size - 1
                            start = max(0, min(start, file_size - 1))
                            end = max(start, min(end, file_size - 1))
                            status = 206
                        except Exception:
                            m = None
                if not m:
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{file_size}')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    return

            content_length = max(0, (end - start) + 1)
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(content_length))
            self.send_header('Accept-Ranges', 'bytes')
            if status == 206:
                self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Disposition', 'inline')
            self.end_headers()

            chunk_size = 64 * 1024
            remaining = content_length
            with open(full_path, 'rb') as f:
                f.seek(start)
                while remaining > 0:
                    data = f.read(min(chunk_size, remaining))
                    if not data:
                        break
                    try:
                        self.wfile.write(data)
                    except (BrokenPipeError, ConnectionResetError):
                        break
                    remaining -= len(data)
        except Exception as e:
            self.send_error(500, str(e))

    def read_json_file(self, file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def write_json_file(self, file_path, payload):
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)

    def normalize_analysis_mode(self, analysis_mode):
        normalized = str(analysis_mode or "").strip().lower()
        if normalized not in {"fast", "balanced", "deep"}:
            return "balanced"
        return normalized

    def normalize_output_language(self, raw_language):
        normalized = str(raw_language or "").strip().lower()
        if normalized in {"tr", "turkish", "türkçe"}:
            return "tr"
        if normalized in {"en", "english"}:
            return "en"
        return ""

    def language_compliance_score(self, text, target_language):
        content = str(text or "").strip()
        if not content:
            return 1.0

        tokens = re.findall(r"[A-Za-zÇĞİÖŞÜçğıöşü']+", content.lower())
        if len(tokens) < 6:
            return 1.0

        english_markers = {
            "the", "and", "for", "with", "this", "that", "is", "are", "of", "to", "in", "on",
            "from", "by", "paper", "study", "analysis", "summary", "method", "findings",
        }
        turkish_markers = {
            "ve", "ile", "için", "bu", "şu", "olarak", "gibi", "bir", "da", "de", "ama",
            "ancak", "çalışma", "analiz", "özet", "yöntem", "bulgu", "sonuç",
        }

        en_hits = sum(1 for token in tokens if token in english_markers)
        tr_hits = sum(1 for token in tokens if token in turkish_markers)
        tr_char_hits = len(re.findall(r"[çğıöşüÇĞİÖŞÜ]", content))

        if target_language == "tr":
            score = (tr_hits + min(8, tr_char_hits)) / max(1, en_hits + tr_hits + 1)
            if en_hits > tr_hits * 2 + 3:
                score *= 0.55
            return max(0.0, min(1.0, score))
        if target_language == "en":
            score = (en_hits + 1) / max(1, en_hits + tr_hits + tr_char_hits + 1)
            if tr_hits > en_hits * 2 + 3:
                score *= 0.55
            return max(0.0, min(1.0, score))
        return 1.0

    def is_language_compliant(self, text, target_language):
        target = self.normalize_output_language(target_language)
        if not target:
            return True
        threshold = 0.60
        if target == "tr":
            threshold = 0.68
        return self.language_compliance_score(text, target) >= threshold

    def language_rewrite_prompt(self, text, target_language):
        target = self.normalize_output_language(target_language)
        content = str(text or "").strip()
        if not target or not content:
            return ""
        if target == "en":
            return (
                "Rewrite the text below strictly in natural English. "
                "Preserve meaning exactly, keep factual content unchanged, do not add new information, "
                "do not remove important details, and avoid Turkish words unless they are unavoidable proper nouns. "
                "Keep an academic, concise, and comprehensive tone.\n\n"
                "Do not include process narration such as 'I now have enough content' or 'I will now produce the output'.\n\n"
                f"Text:\n{content}"
            )
        return (
            "Aşağıdaki metni sadece doğal Türkçe ile yeniden yaz. "
            "Anlamı birebir koru, olgusal içeriği değiştirme, yeni bilgi ekleme, önemli ayrıntıları silme, "
            "zorunlu özel adlar dışında yabancı kelime kullanma. "
            "Akademik, öz ve kapsayıcı bir üslup kullan. "
            "Türkçe karakterleri doğru kullan (ç, ğ, ı, İ, ö, ş, ü). "
            "Yana not/süreç cümlesi yazma (ör. 'Yeterli içerik elde ettim', 'Çıktıyı şimdi üretiyorum').\n\n"
            f"Metin:\n{content}"
        )

    def normalize_process_meta_candidate(self, text):
        candidate = str(text or "").strip().lower()
        if not candidate:
            return ""
        candidate = re.sub(r"^[\s\-*#>\u2022\"'`“”‘’\(\)\[\]\{\}:;,.!?]+", "", candidate)
        candidate = re.sub(r"[\s\"'`“”‘’\(\)\[\]\{\}:;,.!?]+$", "", candidate)
        return candidate.strip()

    def process_meta_prefixes(self):
        return [
            "yeterli içerik elde ettim",
            "yeterli bağlam elde ettim",
            "çıktıyı şimdi üretiyorum",
            "çıktıyı şimdi hazırlıyorum",
            "şimdi çıktıyı üretiyorum",
            "şimdi çıktıyı hazırlıyorum",
            "şu anda zotero kütüphanenizdeki veritabanı durumunu kontrol ediyor",
            "şu anda zotero kütüphanesindeki veritabanı durumunu kontrol ediyor",
            "zotero kütüphanenizdeki veritabanı durumunu kontrol ediyor",
            "zotero kütüphanenizdeki çalışmayla ilişkili kaynakları belirliyorum",
            "zotero kütüphanenizdeki kaynakları belirliyorum",
            "zotero kütüphanenizde semantik arama yapıyorum",
            "zotero kütüphanenizdeki",
            "i am checking your zotero library",
            "i am searching your zotero library",
            "currently checking your zotero library",
            "currently searching your zotero library",
            "i am running semantic search",
            "currently running semantic search",
            "i now have enough content",
            "i now have enough context",
            "i will now produce the output",
            "i will now generate the output",
            "now generating the output",
            "now producing the output",
        ]

    def is_process_meta_line(self, text):
        candidate = self.normalize_process_meta_candidate(text)
        if not candidate:
            return False

        if any(candidate.startswith(prefix) for prefix in self.process_meta_prefixes()):
            return True

        patterns = [
            r"^yeterli .* (elde ettim|topladım)",
            r"^çıktıyı şimdi .*",
            r"^şimdi .*çıktı.*",
            r"^(şu anda|şimdi)\b.*\b(kontrol ediyor(?:um)?|inceliyor(?:um)?|tarıyor(?:um)?|arıyor(?:um)?|belirliyor(?:um)?|tespit ediyor(?:um)?|doğruluyor(?:um)?|derliyor(?:um)?|topluyor(?:um)?|hazırlıyor(?:um)?)\b",
            r"^zotero\b.*\b(veritabanı durumunu kontrol ediyor(?:um)?|semantik arama yapıyor(?:um)?|arama yapıyor(?:um)?|kaynakları belirliyor(?:um)?)\b",
            r"^zotero\b.*\btespit etmek için\b.*\bsemantik arama yapıyor(?:um)?\b",
            r"^i (now )?(have|got) enough (content|context)",
            r"^i will now (produce|generate|prepare) (the )?output",
            r"^now (producing|generating|preparing) (the )?output",
            r"^i(?:'m| am|’m)\b.*\b(checking|searching|scanning|identifying|retrieving|looking up|reviewing|analyzing|compiling)\b",
            r"^currently\b.*\b(checking|searching|scanning|identifying|retrieving|looking up|reviewing|analyzing|compiling)\b",
            r"^to\b.*\b(i(?:'m| am|’m)|currently)\b.*\b(searching|checking|scanning|identifying|retrieving)\b",
        ]
        return any(re.search(pattern, candidate) for pattern in patterns)

    def is_process_meta_prefix(self, text):
        candidate = self.normalize_process_meta_candidate(text)
        if not candidate:
            return False
        prefixes = self.process_meta_prefixes()
        return any(prefix.startswith(candidate) or candidate.startswith(prefix) for prefix in prefixes)

    def sanitize_provider_output(self, text, provider):
        content = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
        if not content:
            return ""

        normalized_provider = self.normalize_provider(provider)
        lines = content.split("\n")
        cleaned_lines = []
        blank_run = 0

        gemini_noise = [
            r"^yolo mode is enabled",
            r"^loaded cached credentials",
            r"^server 'zotero-mcp' supports tool updates",
            r"^mcp startup:",
            r"^mcp:\s",
        ]
        codex_noise = [
            r"^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}.*\bwarn\b",
            r"^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}.*\berror\b",
            r"^openai codex v",
            r"^tokens used$",
            r"^\d{1,3}(,\d{3})+$",
            r"^thinking$",
            r"^codex$",
            r"^user$",
            r"^workdir:",
            r"^model:",
            r"^provider:",
            r"^approval:",
            r"^sandbox:",
            r"^reasoning effort:",
            r"^reasoning summaries:",
            r"^session id:",
            r"^-{3,}$",
        ]

        for raw_line in lines:
            check_line = str(raw_line or "").strip()
            if not check_line:
                blank_run += 1
                if cleaned_lines and blank_run <= 2:
                    cleaned_lines.append("")
                continue

            blank_run = 0
            if self.is_process_meta_line(check_line):
                continue
            lowered = check_line.lower()
            if normalized_provider == "gemini":
                if any(re.search(pattern, lowered) for pattern in gemini_noise):
                    continue
            if normalized_provider == "codex":
                if any(re.search(pattern, lowered) for pattern in codex_noise):
                    continue
            cleaned_lines.append(str(raw_line).rstrip())

        cleaned = "\n".join(cleaned_lines).strip()
        return cleaned

    def provider_noise_prefixes(self, provider):
        normalized_provider = self.normalize_provider(provider)
        if normalized_provider == "gemini":
            return [
                "yolo mode is enabled",
                "loaded cached credentials",
                "server 'zotero-mcp' supports tool updates",
                "mcp startup:",
                "mcp:",
            ]
        if normalized_provider == "codex":
            return [
                "openai codex v",
                "tokens used",
                "thinking",
                "codex",
                "user",
                "workdir:",
                "model:",
                "provider:",
                "approval:",
                "sandbox:",
                "reasoning effort:",
                "reasoning summaries:",
                "session id:",
                "--------",
            ]
        return []

    def is_noise_output_line(self, line, provider):
        candidate = str(line or "").strip()
        if not candidate:
            return False
        if self.is_process_meta_line(candidate):
            return True
        lowered = candidate.lower()
        normalized_provider = self.normalize_provider(provider)

        if normalized_provider == "gemini":
            patterns = [
                r"^yolo mode is enabled",
                r"^loaded cached credentials",
                r"^server 'zotero-mcp' supports tool updates",
                r"^mcp startup:",
                r"^mcp:\s*",
            ]
            return any(re.search(pattern, lowered) for pattern in patterns)

        if normalized_provider == "codex":
            patterns = [
                r"^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}.*\bwarn\b",
                r"^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}.*\berror\b",
                r"^openai codex v",
                r"^tokens used$",
                r"^\d{1,3}(,\d{3})+$",
                r"^thinking$",
                r"^codex$",
                r"^user$",
                r"^workdir:",
                r"^model:",
                r"^provider:",
                r"^approval:",
                r"^sandbox:",
                r"^reasoning effort:",
                r"^reasoning summaries:",
                r"^session id:",
                r"^-{3,}$",
                r"^mcp:",
                r"^mcp startup:",
            ]
            return any(re.search(pattern, lowered) for pattern in patterns)

        return False

    def is_noise_output_prefix(self, text, provider):
        candidate = str(text or "").strip().lower()
        if not candidate:
            return False
        if self.is_process_meta_prefix(candidate):
            return True
        prefixes = self.provider_noise_prefixes(provider)
        return any(prefix.startswith(candidate) or candidate.startswith(prefix) for prefix in prefixes)

    def stream_noise_filter_push(self, chunk, provider, state):
        payload = str(chunk or "")
        if not payload:
            return ""

        state["buffer"] = state.get("buffer", "") + payload
        emitted = []
        direct_mode = bool(state.get("direct_mode", False))

        while "\n" in state["buffer"]:
            line, rest = state["buffer"].split("\n", 1)
            state["buffer"] = rest
            if self.is_noise_output_line(line, provider):
                continue
            direct_mode = True
            emitted.append(line + "\n")

        remainder = state.get("buffer", "")
        if remainder:
            if direct_mode:
                if not self.is_noise_output_line(remainder, provider):
                    emitted.append(remainder)
                state["buffer"] = ""
            elif len(remainder) >= 28 and (not self.is_noise_output_prefix(remainder, provider)):
                emitted.append(remainder)
                state["buffer"] = ""
                direct_mode = True

        state["direct_mode"] = direct_mode
        return "".join(emitted)

    def stream_noise_filter_flush(self, provider, state):
        tail = str(state.get("buffer", "") or "")
        state["buffer"] = ""
        state["direct_mode"] = False
        if not tail:
            return ""
        if self.is_noise_output_line(tail, provider):
            return ""
        return tail

    def stream_write_jsonl(self, payload):
        packet = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        self.wfile.write(packet)
        self.wfile.flush()

    def chunk_text_for_stream(self, text, chunk_size=180):
        content = str(text or "")
        if not content:
            return []
        chunks = []
        cursor = 0
        size = max(32, int(chunk_size or 180))
        while cursor < len(content):
            next_cursor = min(len(content), cursor + size)
            chunks.append(content[cursor:next_cursor])
            cursor = next_cursor
        return chunks

    def cache_get(self, cache, lock, key):
        now = time.time()
        with lock:
            entry = cache.get(key)
            if not isinstance(entry, dict):
                return None
            if float(entry.get("expires_at", 0)) <= now:
                cache.pop(key, None)
                return None
            return dict(entry)

    def cache_set(self, cache, lock, key, payload, ttl_seconds, max_entries):
        now = time.time()
        expires_at = now + max(1, int(ttl_seconds or 1))
        record = dict(payload or {})
        record["created_at"] = now
        record["expires_at"] = expires_at

        with lock:
            cache[key] = record

            if len(cache) <= max_entries:
                return

            expired_keys = [k for k, v in cache.items() if float(v.get("expires_at", 0)) <= now]
            for expired_key in expired_keys:
                cache.pop(expired_key, None)

            if len(cache) <= max_entries:
                return

            ordered = sorted(cache.keys(), key=lambda k: float(cache[k].get("created_at", 0)))
            to_trim = len(cache) - max_entries
            for old_key in ordered[:to_trim]:
                cache.pop(old_key, None)

    def clear_all_caches(self):
        with TOOL_RESULT_CACHE_LOCK:
            TOOL_RESULT_CACHE.clear()
        with AI_RESPONSE_CACHE_LOCK:
            AI_RESPONSE_CACHE.clear()
        with EXTERNAL_SEARCH_CACHE_LOCK:
            EXTERNAL_SEARCH_CACHE.clear()

    def tool_cache_profile_for_path(self, path):
        raw = str(path or "")
        path_only = raw.split("?", 1)[0]
        patterns = [
            (r"^/api/(users|groups)/\d+/items/[A-Z0-9]{8}/fulltext$", "fulltext"),
            (r"^/api/(users|groups)/\d+/items/[A-Z0-9]{8}/children$", "notes"),
            (r"^/api/(users|groups)/\d+/items/[A-Z0-9]{8}$", "metadata"),
        ]
        for pattern, kind in patterns:
            if re.match(pattern, path_only, flags=re.IGNORECASE):
                return {"kind": kind, "ttl": TOOL_RESULT_CACHE_TTL_SECONDS.get(kind, 5 * 60)}
        return None

    def tool_cache_key(self, path):
        return f"GET|{str(path or '')}"

    def get_cached_tool_result(self, cache_key):
        return self.cache_get(TOOL_RESULT_CACHE, TOOL_RESULT_CACHE_LOCK, cache_key)

    def set_cached_tool_result(self, cache_key, payload, ttl_seconds):
        self.cache_set(
            TOOL_RESULT_CACHE,
            TOOL_RESULT_CACHE_LOCK,
            cache_key,
            payload,
            ttl_seconds,
            TOOL_RESULT_CACHE_MAX_ENTRIES,
        )

    def get_cached_external_search_result(self, cache_key):
        return self.cache_get(EXTERNAL_SEARCH_CACHE, EXTERNAL_SEARCH_CACHE_LOCK, cache_key)

    def set_cached_external_search_result(self, cache_key, payload, ttl_seconds=EXTERNAL_SEARCH_CACHE_TTL_SECONDS):
        self.cache_set(
            EXTERNAL_SEARCH_CACHE,
            EXTERNAL_SEARCH_CACHE_LOCK,
            cache_key,
            payload,
            ttl_seconds,
            EXTERNAL_SEARCH_CACHE_MAX_ENTRIES,
        )

    def normalize_item_key(self, raw_key):
        candidate = str(raw_key or "").strip().upper()
        if re.fullmatch(r"[A-Z0-9]{8}", candidate):
            return candidate
        return ""

    def normalize_item_api_base(self, raw_base):
        candidate = str(raw_base or "").strip()
        if not candidate:
            return "/api/users/0"

        if candidate.startswith("http://") or candidate.startswith("https://"):
            try:
                parsed = urllib.parse.urlparse(candidate)
                candidate = parsed.path or ""
            except Exception:
                candidate = ""

        candidate = candidate.rstrip("/")
        candidate = re.sub(r"(/items/.*)$", "", candidate, flags=re.IGNORECASE)
        if re.fullmatch(r"/api/(users|groups)/\d+", candidate):
            return candidate
        if re.fullmatch(r"/(users|groups)/\d+", candidate):
            return f"/api{candidate}"
        return "/api/users/0"

    def should_fallback_from_pipeline_error(self, error):
        message = str(error or "").lower()
        if not message:
            return False
        keywords = [
            "tam metni bulunamadı",
            "fulltext",
            "full text",
            "indekslenmemiş",
            "zotero api 404",
            "not found",
        ]
        return any(token in message for token in keywords)

    def item_api_base_candidates(self, req_data):
        provided = self.normalize_item_api_base((req_data or {}).get("itemApiBase", ""))
        candidates = [provided]
        if provided != "/api/users/0":
            candidates.append("/api/users/0")
        deduped = []
        for base in candidates:
            if base and base not in deduped:
                deduped.append(base)
        return deduped

    def as_bool(self, value):
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        normalized = str(value or "").strip().lower()
        return normalized in {"1", "true", "yes", "on", "evet"}

    def normalize_source_routing_mode(self, req_data):
        data = req_data or {}
        return self.as_bool(data.get("sourceRoutingMode", False)) or self.as_bool(data.get("forceSourceRouting", False))

    def compact_external_text(self, value, max_len=260):
        text = str(value or "")
        if not text:
            return ""
        text = re.sub(r"<[^>]+>", " ", text)
        text = html.unescape(text)
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        text = re.sub(r"\s+", " ", text).strip()
        if not text:
            return ""
        max_chars = max(60, int(max_len or 260))
        if len(text) <= max_chars:
            return text
        return f"{text[:max_chars - 1].rstrip()}…"

    def extract_external_query_keywords(self, value, limit=8):
        text = str(value or "").strip().lower()
        if not text:
            return []
        tokens = re.findall(r"[a-zA-Z0-9ğüşöçıİĞÜŞÖÇ]{3,}", text)
        if not tokens:
            return []
        stopwords = {
            "this", "that", "these", "those", "with", "from", "about", "paper", "papers", "article", "articles",
            "important", "other", "related", "work", "works", "recent", "latest", "last", "year", "years",
            "what", "which", "show", "find", "sources", "source",
            "bu", "şu", "konu", "konuyla", "konuda", "ilgili", "diğer", "önemli", "makale", "makaleler",
            "kaynak", "kaynaklar", "neler", "nedir", "nedirler", "son", "yıl", "yılda", "yıldaki", "için",
            "olarak", "hakkında", "üzerine", "ve", "veya",
        }
        result = []
        seen = set()
        for token in tokens:
            clean = token.strip().lower()
            if not clean or clean in stopwords:
                continue
            if clean.isdigit():
                continue
            if clean in seen:
                continue
            seen.add(clean)
            result.append(clean)
            if len(result) >= max(3, int(limit or 8)):
                break
        return result

    def detect_external_year_floor(self, req_data, prompt):
        data = req_data or {}
        raw_message = str(data.get("userMessage", "") or "")
        text = f"{raw_message}\n{str(prompt or '')}".lower()
        current_year = datetime.utcnow().year
        years_back = None

        tr_match = re.search(r"son\s+(\d{1,2})\s*y[ıi]l", text, flags=re.IGNORECASE)
        en_match = re.search(r"last\s+(\d{1,2})\s+years?", text, flags=re.IGNORECASE)
        tr_month_match = re.search(r"son\s+(\d{1,2})\s*ay", text, flags=re.IGNORECASE)
        en_month_match = re.search(r"(last|past)\s+(\d{1,2})\s+months?", text, flags=re.IGNORECASE)
        if tr_match:
            years_back = int(tr_match.group(1))
        elif en_match:
            years_back = int(en_match.group(1))
        elif tr_month_match:
            month_count = int(tr_month_match.group(1))
            years_back = 1 if month_count <= 12 else max(1, int(round(month_count / 12.0)))
        elif en_month_match:
            month_count = int(en_month_match.group(2))
            years_back = 1 if month_count <= 12 else max(1, int(round(month_count / 12.0)))
        elif re.search(r"\b(son bir yıl|son 1 yıl|geçen yıl|last year|past year|past 12 months|last 12 months)\b", text, flags=re.IGNORECASE):
            years_back = 1

        if years_back is None:
            return 0
        years_back = max(1, min(10, int(years_back)))
        if years_back == 1:
            return max(1900, current_year - 1)
        return max(1900, current_year - years_back + 1)

    def build_external_query_candidates(self, req_data, prompt, primary_query):
        query = self.compact_external_text(primary_query, max_len=260)
        data = req_data or {}
        selected_title = self.compact_external_text(data.get("selectedItemTitle", ""), max_len=180)
        raw_message = str(data.get("userMessage", "") or "").strip()
        keywords = self.extract_external_query_keywords(raw_message, limit=6)
        title_keywords = self.extract_external_query_keywords(selected_title, limit=5)
        year_floor = self.detect_external_year_floor(req_data, prompt)
        current_year = datetime.utcnow().year

        candidates = []
        if query:
            candidates.append(query)
        if selected_title:
            candidates.append(f"\"{selected_title}\"")
            candidates.append(f"\"{selected_title}\" related work")
            if title_keywords:
                title_base = " ".join(title_keywords[:5]).strip()
                if title_base:
                    candidates.append(f"{title_base} related work")
            if keywords:
                candidates.append(f"\"{selected_title}\" {' '.join(keywords[:5])}")
            if year_floor:
                candidates.append(f"\"{selected_title}\" {year_floor} {current_year} recent related work")
                if title_keywords:
                    candidates.append(f"{' '.join(title_keywords[:5])} {year_floor} {current_year}")
        elif keywords:
            base = " ".join(keywords[:6]).strip()
            if base:
                candidates.append(base)
                if year_floor:
                    candidates.append(f"{base} {year_floor} {current_year}")
        elif title_keywords:
            base = " ".join(title_keywords[:5]).strip()
            if base:
                candidates.append(base)
                candidates.append(f"{base} related work")
                if year_floor:
                    candidates.append(f"{base} {year_floor} {current_year}")

        deduped = []
        seen = set()
        for item in candidates:
            clean = self.compact_external_text(item, max_len=260)
            if not clean:
                continue
            norm = clean.lower().strip()
            if norm in seen:
                continue
            seen.add(norm)
            deduped.append(clean)
            if len(deduped) >= 4:
                break
        return deduped or ([query] if query else [])

    def normalize_external_search_query(self, req_data, prompt):
        data = req_data or {}
        raw_message = str(data.get("userMessage", "") or "").strip()
        selected_title = self.compact_external_text(data.get("selectedItemTitle", ""), max_len=180)

        cleaned_message = re.sub(
            r"\b(kaynak bul|find sources|özetle|summarize|notları analiz et|analyze notes|ilgili çalışmalar|related works|eleştirel değerlendirme|critical review)\b",
            " ",
            raw_message,
            flags=re.IGNORECASE,
        )
        cleaned_message = self.compact_external_text(cleaned_message, max_len=180).strip(" :;,-")
        extracted = self.extract_external_query_keywords(cleaned_message, limit=7)
        cleaned_message = " ".join(extracted).strip()
        if not cleaned_message and selected_title:
            title_keywords = self.extract_external_query_keywords(selected_title, limit=5)
            cleaned_message = " ".join(title_keywords).strip()

        if not selected_title:
            prompt_text = str(prompt or "")
            quoted = re.search(r"[\"“”']([^\"“”']{8,220})[\"“”']", prompt_text)
            if quoted:
                selected_title = self.compact_external_text(quoted.group(1), max_len=180)

        parts = []
        if selected_title:
            parts.append(f"\"{selected_title}\"")
        if cleaned_message and cleaned_message.lower() != selected_title.lower():
            parts.append(cleaned_message)

        query = " ".join([part for part in parts if part]).strip()
        if not query:
            fallback = self.compact_external_text(prompt, max_len=220)
            query = fallback
        if len(query) > 260:
            query = query[:260].strip()
        return query

    def external_seed_terms(self, req_data, prompt, query):
        data = req_data or {}
        selected_title = self.compact_external_text(data.get("selectedItemTitle", ""), max_len=180)
        raw_message = str(data.get("userMessage", "") or "").strip()
        prompt_head = str(prompt or "").split("\n\n", 1)[0]

        terms = []
        for source_text in [selected_title, raw_message, query, prompt_head]:
            extracted = self.extract_external_query_keywords(source_text, limit=8)
            for token in extracted:
                clean = str(token or "").strip().lower()
                if not clean or clean in terms:
                    continue
                terms.append(clean)
                if len(terms) >= 12:
                    return terms
        return terms

    def topical_term_hits_for_candidate(self, row, seed_terms):
        if not isinstance(row, dict):
            return 0
        terms = seed_terms if isinstance(seed_terms, list) else []
        if not terms:
            return 0
        title = self.compact_external_text(row.get("title", ""), max_len=320)
        venue = self.compact_external_text(row.get("venue", ""), max_len=120)
        abstract = self.compact_external_text(row.get("abstract", ""), max_len=360)
        topics = row.get("topics") if isinstance(row.get("topics"), list) else []
        topics_text = " ".join(self.compact_external_text(topic, max_len=50) for topic in topics[:10] if topic)
        haystack = f"{title} {venue} {topics_text} {abstract}".lower()
        if not haystack.strip():
            return 0

        hits = 0
        for token in terms:
            term = str(token or "").strip().lower()
            if not term or len(term) < 3:
                continue
            if term in haystack:
                hits += 1
        return hits

    def external_search_cache_key(self, query, language):
        normalized_query = self.compact_external_text(query, max_len=260).lower()
        lang = self.normalize_output_language(language) or "tr"
        digest = hashlib.sha256(f"{lang}|{normalized_query}".encode("utf-8")).hexdigest()[:20]
        return f"ext:{lang}:{digest}"

    def fetch_json_url(self, url, timeout=8, headers=None):
        req = urllib.request.Request(
            str(url or ""),
            headers={
                "Accept": "application/json",
                "User-Agent": "Orhon-Zotero-Dashboard/0.0.4",
                **(headers or {}),
            },
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=max(2, int(timeout or 8))) as resp:
            raw = resp.read().decode("utf-8", errors="replace").strip()
            if not raw:
                return {}
            return json.loads(raw)

    def normalize_external_doi(self, value):
        doi = str(value or "").strip()
        if not doi:
            return ""
        doi = doi.replace("https://doi.org/", "").replace("http://doi.org/", "")
        return doi.strip().lower()

    def is_valid_external_doi(self, doi):
        candidate = self.normalize_external_doi(doi)
        if not candidate:
            return False
        return bool(re.match(r"^10\.\d{4,9}/\S+$", candidate, flags=re.IGNORECASE))

    def normalize_external_url(self, value):
        url = str(value or "").strip()
        if not url:
            return ""
        if url.startswith("doi:"):
            doi_value = self.normalize_external_doi(url.split("doi:", 1)[1])
            if doi_value:
                return f"https://doi.org/{doi_value}"
            return ""
        if url.startswith("https://openalex.org/W") and "openalex.org/works/" not in url.lower():
            work_id = url.rsplit("/", 1)[-1].strip()
            if work_id:
                return f"https://openalex.org/{work_id}"
        if not re.match(r"^https?://", url, flags=re.IGNORECASE):
            return ""
        return url

    def external_url_host(self, value):
        url = self.normalize_external_url(value)
        if not url:
            return ""
        try:
            parsed = urllib.parse.urlparse(url)
            host = str(parsed.netloc or "").lower().strip()
            if host.startswith("www."):
                host = host[4:]
            return host
        except Exception:
            return ""

    def is_trusted_academic_host(self, host):
        candidate = str(host or "").lower().strip()
        if not candidate:
            return False
        trusted_hosts = {
            "doi.org",
            "openalex.org",
            "api.openalex.org",
            "semanticscholar.org",
            "api.semanticscholar.org",
            "crossref.org",
            "api.crossref.org",
            "arxiv.org",
            "pubmed.ncbi.nlm.nih.gov",
            "ieeexplore.ieee.org",
            "dl.acm.org",
            "sciencedirect.com",
            "link.springer.com",
            "nature.com",
            "science.org",
            "jstor.org",
            "tandfonline.com",
            "onlinelibrary.wiley.com",
            "cambridge.org",
            "academic.oup.com",
            "frontiersin.org",
            "plos.org",
            "mdpi.com",
        }
        if candidate in trusted_hosts:
            return True
        return any(candidate.endswith(f".{domain}") for domain in trusted_hosts)

    def verify_external_candidate(self, row):
        item = row if isinstance(row, dict) else {}
        title = self.compact_external_text(item.get("title", ""), max_len=320)
        if len(title) < 8:
            return False, {}

        year_raw = str(item.get("year") or "").strip()
        year_ok = True
        if year_raw:
            try:
                year_int = int(year_raw)
                current_year = datetime.utcnow().year + 1
                year_ok = 1900 <= year_int <= current_year
            except Exception:
                year_ok = False
        if not year_ok:
            return False, {}

        sources = item.get("sources")
        if not isinstance(sources, list) or not sources:
            single_source = str(item.get("source", "")).strip().lower()
            sources = [single_source] if single_source else []
        sources = [str(src or "").strip().lower() for src in sources if str(src or "").strip()]
        allowed_sources = {"openalex", "semantic", "crossref"}
        if not sources or not all(src in allowed_sources for src in sources):
            return False, {}

        doi = self.normalize_external_doi(item.get("doi", ""))
        url = self.normalize_external_url(item.get("url", ""))
        doi_ok = self.is_valid_external_doi(doi)
        host = self.external_url_host(url)
        url_ok = bool(host and self.is_trusted_academic_host(host))
        if not (doi_ok or url_ok):
            return False, {}

        verification = "DOI" if doi_ok else "URL"
        if doi_ok and url_ok:
            verification = "DOI+URL"
        return True, {
            "doi": doi,
            "url": url,
            "sources": sorted(set(sources)),
            "verification": verification,
        }

    def normalize_external_paper(self, raw, source, query):
        entry = raw if isinstance(raw, dict) else {}
        src = str(source or "").strip().lower() or "web"
        query_tokens = [
            token for token in re.findall(r"[a-zA-Z0-9ğüşöçıİĞÜŞÖÇ]{4,}", str(query or "").lower())
            if token not in {"with", "from", "that", "this", "paper", "source", "query", "için", "olan", "gibi", "veya"}
        ][:10]

        title = ""
        year = ""
        authors = []
        venue = ""
        abstract = ""
        doi = ""
        url = ""
        citations = 0
        topics = []

        if src == "openalex":
            title = self.compact_external_text(entry.get("title", ""), max_len=320)
            year = str(entry.get("publication_year") or "")
            authorships = entry.get("authorships") if isinstance(entry.get("authorships"), list) else []
            for row in authorships[:5]:
                author = row.get("author") if isinstance(row, dict) else {}
                name = self.compact_external_text((author or {}).get("display_name", ""), max_len=80)
                if name:
                    authors.append(name)
            primary_location = entry.get("primary_location") if isinstance(entry.get("primary_location"), dict) else {}
            source_obj = primary_location.get("source") if isinstance(primary_location.get("source"), dict) else {}
            venue = self.compact_external_text(source_obj.get("display_name", ""), max_len=120)
            ids = entry.get("ids") if isinstance(entry.get("ids"), dict) else {}
            doi = str(ids.get("doi") or "").strip()
            if doi.lower().startswith("https://doi.org/"):
                doi = doi.split("doi.org/", 1)[1]
            url = str(entry.get("id") or "").strip()
            citations = int(entry.get("cited_by_count") or 0)
            concepts = entry.get("concepts") if isinstance(entry.get("concepts"), list) else []
            topics = [self.compact_external_text((concept or {}).get("display_name", ""), max_len=50) for concept in concepts[:6]]
            topics = [topic for topic in topics if topic]
            abstract = ""
        elif src == "crossref":
            title_list = entry.get("title") if isinstance(entry.get("title"), list) else []
            title = self.compact_external_text(title_list[0] if title_list else "", max_len=320)
            year_parts = [None]
            published_print = entry.get("published-print") if isinstance(entry.get("published-print"), dict) else {}
            print_parts = published_print.get("date-parts") if isinstance(published_print.get("date-parts"), list) else []
            if print_parts and isinstance(print_parts[0], list):
                year_parts = print_parts[0]
            if not year_parts or year_parts[0] is None:
                published_online = entry.get("published-online") if isinstance(entry.get("published-online"), dict) else {}
                online_parts = published_online.get("date-parts") if isinstance(published_online.get("date-parts"), list) else []
                if online_parts and isinstance(online_parts[0], list):
                    year_parts = online_parts[0]
            year = str(year_parts[0] or "")
            raw_authors = entry.get("author") if isinstance(entry.get("author"), list) else []
            for author in raw_authors[:5]:
                given = self.compact_external_text((author or {}).get("given", ""), max_len=40)
                family = self.compact_external_text((author or {}).get("family", ""), max_len=40)
                full_name = " ".join([part for part in [given, family] if part]).strip()
                if full_name:
                    authors.append(full_name)
            container = entry.get("container-title") if isinstance(entry.get("container-title"), list) else []
            venue = self.compact_external_text(container[0] if container else "", max_len=120)
            doi = str(entry.get("DOI") or "").strip()
            url = str(entry.get("URL") or (f"https://doi.org/{doi}" if doi else "")).strip()
            citations = int(entry.get("is-referenced-by-count") or 0)
            abstract = self.compact_external_text(entry.get("abstract", ""), max_len=260)
            topics = []
        else:
            title = self.compact_external_text(entry.get("title", ""), max_len=320)
            year = str(entry.get("year") or "")
            raw_authors = entry.get("authors") if isinstance(entry.get("authors"), list) else []
            for author in raw_authors[:5]:
                if isinstance(author, dict):
                    name = self.compact_external_text(author.get("name", ""), max_len=80)
                else:
                    name = self.compact_external_text(author, max_len=80)
                if name:
                    authors.append(name)
            venue = self.compact_external_text(entry.get("venue", ""), max_len=120)
            abstract = self.compact_external_text(entry.get("abstract", ""), max_len=260)
            url = str(entry.get("url") or "").strip()
            external_ids = entry.get("externalIds") if isinstance(entry.get("externalIds"), dict) else {}
            doi = str(external_ids.get("DOI") or entry.get("doi") or "").strip()
            citations = int(entry.get("citationCount") or 0)
            fields = entry.get("fieldsOfStudy") if isinstance(entry.get("fieldsOfStudy"), list) else []
            topics = [self.compact_external_text(topic, max_len=50) for topic in fields[:6] if topic]

        if not title:
            return None

        normalized_title = re.sub(r"[^a-z0-9]+", "", title.lower())
        relevance_hits = sum(1 for token in query_tokens if token and token in title.lower())
        year_int = 0
        try:
            year_int = int(year)
        except Exception:
            year_int = 0
        recency = 0
        if year_int >= 2023:
            recency = 8
        elif year_int >= 2018:
            recency = 5
        elif year_int >= 2010:
            recency = 2
        citation_score = min(26, int(citations / 20)) if citations > 0 else 0
        source_bonus = {"semantic": 6, "openalex": 5, "crossref": 3}.get(src, 1)
        relevance_score = (relevance_hits * 8) + recency + citation_score + source_bonus

        normalized_doi = self.normalize_external_doi(doi)
        normalized_url = self.normalize_external_url(url)
        return {
            "source": src,
            "sources": [src],
            "title": title,
            "titleKey": normalized_title,
            "year": year,
            "authors": authors,
            "venue": venue,
            "abstract": abstract,
            "doi": normalized_doi,
            "url": normalized_url,
            "citations": citations,
            "topics": [topic for topic in topics if topic],
            "score": relevance_score,
        }

    def fetch_openalex_candidates(self, query, limit=8):
        encoded_query = urllib.parse.quote_plus(str(query or ""))
        url = f"https://api.openalex.org/works?search={encoded_query}&per-page={max(2, int(limit or 8))}&sort=relevance_score:desc"
        payload = self.fetch_json_url(url, timeout=6)
        rows = payload.get("results") if isinstance(payload, dict) else []
        if not isinstance(rows, list):
            return []
        return rows[:max(2, int(limit or 8))]

    def fetch_crossref_candidates(self, query, limit=8):
        encoded_query = urllib.parse.quote_plus(str(query or ""))
        url = (
            "https://api.crossref.org/works?"
            f"query.bibliographic={encoded_query}&rows={max(2, int(limit or 8))}&sort=relevance&order=desc"
        )
        payload = self.fetch_json_url(url, timeout=6)
        message = payload.get("message") if isinstance(payload, dict) else {}
        rows = message.get("items") if isinstance(message, dict) else []
        if not isinstance(rows, list):
            return []
        return rows[:max(2, int(limit or 8))]

    def fetch_semantic_scholar_candidates(self, query, limit=8):
        encoded_query = urllib.parse.quote_plus(str(query or ""))
        fields = "title,year,authors,venue,abstract,citationCount,url,externalIds,fieldsOfStudy"
        url = (
            "https://api.semanticscholar.org/graph/v1/paper/search?"
            f"query={encoded_query}&limit={max(2, int(limit or 8))}&fields={urllib.parse.quote_plus(fields)}"
        )
        payload = self.fetch_json_url(url, timeout=6)
        rows = payload.get("data") if isinstance(payload, dict) else []
        if not isinstance(rows, list):
            return []
        return rows[:max(2, int(limit or 8))]

    def dedupe_and_rank_external_candidates(self, rows):
        deduped = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            key = str(row.get("doi") or "").strip().lower()
            if not key:
                key = f"{row.get('titleKey', '')}:{row.get('year', '')}"
            if not key:
                continue
            existing = deduped.get(key)
            if existing is None:
                deduped[key] = dict(row)
                continue
            keep = dict(existing)
            alt = dict(row)
            if float(alt.get("score", 0)) > float(keep.get("score", 0)):
                keep, alt = alt, keep

            keep_sources = keep.get("sources") if isinstance(keep.get("sources"), list) else [keep.get("source", "")]
            alt_sources = alt.get("sources") if isinstance(alt.get("sources"), list) else [alt.get("source", "")]
            merged_sources = sorted(
                set(
                    str(src or "").strip().lower()
                    for src in [*keep_sources, *alt_sources]
                    if str(src or "").strip()
                )
            )
            keep["sources"] = merged_sources
            if merged_sources:
                keep["source"] = merged_sources[0]

            if not str(keep.get("doi", "")).strip() and str(alt.get("doi", "")).strip():
                keep["doi"] = alt.get("doi", "")
            if not str(keep.get("url", "")).strip() and str(alt.get("url", "")).strip():
                keep["url"] = alt.get("url", "")
            keep["citations"] = max(int(keep.get("citations") or 0), int(alt.get("citations") or 0))

            keep_topics = keep.get("topics") if isinstance(keep.get("topics"), list) else []
            alt_topics = alt.get("topics") if isinstance(alt.get("topics"), list) else []
            topic_set = []
            seen_topics = set()
            for topic in [*keep_topics, *alt_topics]:
                clean = self.compact_external_text(topic, max_len=50)
                if not clean or clean in seen_topics:
                    continue
                seen_topics.add(clean)
                topic_set.append(clean)
            keep["topics"] = topic_set[:10]

            keep_authors = keep.get("authors") if isinstance(keep.get("authors"), list) else []
            alt_authors = alt.get("authors") if isinstance(alt.get("authors"), list) else []
            if len(alt_authors) > len(keep_authors):
                keep["authors"] = alt_authors
            deduped[key] = keep
        ranked = sorted(deduped.values(), key=lambda item: float(item.get("score", 0)), reverse=True)
        return ranked

    def extract_external_topics(self, rows, limit=8):
        scores = {}
        for row in rows:
            topics = row.get("topics") if isinstance(row, dict) else []
            if not isinstance(topics, list):
                continue
            for topic in topics[:8]:
                clean = self.compact_external_text(topic, max_len=50)
                if not clean:
                    continue
                scores[clean] = scores.get(clean, 0) + 1
        ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
        return [name for name, _ in ranked[:max(3, int(limit or 8))]]

    def collect_external_candidates(self, query, per_source_limit=8):
        sources = [
            ("openalex", self.fetch_openalex_candidates),
            ("semantic", self.fetch_semantic_scholar_candidates),
            ("crossref", self.fetch_crossref_candidates),
        ]
        collected = []
        lock = threading.Lock()

        def run_source(source_name, fetcher):
            try:
                rows = fetcher(query, limit=per_source_limit)
            except Exception:
                rows = []
            normalized = []
            for raw in rows:
                item = self.normalize_external_paper(raw, source_name, query)
                if item:
                    normalized.append(item)
            if not normalized:
                return
            with lock:
                collected.extend(normalized)

        threads = []
        for source_name, fetcher in sources:
            thread = threading.Thread(target=run_source, args=(source_name, fetcher), daemon=True)
            thread.start()
            threads.append(thread)
        for thread in threads:
            thread.join(timeout=6.5)
        return collected

    def build_external_search_context(self, req_data, prompt, target_language="", on_event=None):
        query = self.normalize_external_search_query(req_data, prompt)
        if not query:
            return {"used": False, "query": "", "count": 0, "topics": [], "context": ""}
        query_candidates = self.build_external_query_candidates(req_data, prompt, query)
        year_floor = self.detect_external_year_floor(req_data, prompt)
        cache_basis = " || ".join(query_candidates) if query_candidates else query
        cache_key = self.external_search_cache_key(f"{cache_basis}::y{year_floor or 0}", target_language)
        cached = self.get_cached_external_search_result(cache_key)
        if cached and isinstance(cached, dict):
            return {
                "used": bool(cached.get("count", 0)),
                "query": str(cached.get("query", query)),
                "count": int(cached.get("count", 0)),
                "topics": list(cached.get("topics", []) or []),
                "context": str(cached.get("context", "")),
                "cached": True,
            }

        if on_event:
            on_event(
                {
                    "type": "meta",
                    "phase": "external_search_start",
                    "query": query,
                    "queryVariants": query_candidates[:4],
                    "yearFloor": int(year_floor or 0),
                }
            )

        candidates = []
        per_query_limit = 6 if len(query_candidates) > 1 else 8
        for candidate_query in query_candidates[:4]:
            candidates.extend(self.collect_external_candidates(candidate_query, per_source_limit=per_query_limit))
        ranked_raw = self.dedupe_and_rank_external_candidates(candidates)[:12]
        verified = []
        seed_terms = self.external_seed_terms(req_data, prompt, query)
        for row in ranked_raw:
            ok, verification = self.verify_external_candidate(row)
            if not ok:
                continue
            enriched = dict(row)
            enriched["doi"] = verification.get("doi", enriched.get("doi", ""))
            enriched["url"] = verification.get("url", enriched.get("url", ""))
            enriched["sources"] = verification.get("sources", enriched.get("sources", []))
            enriched["verification"] = verification.get("verification", "")
            topic_hits = self.topical_term_hits_for_candidate(enriched, seed_terms)
            if topic_hits > 0:
                enriched["score"] = float(enriched.get("score", 0)) + min(18, topic_hits * 6)
            enriched["_topicHits"] = int(topic_hits)
            verified.append(enriched)
        verified.sort(
            key=lambda item: (
                int(item.get("_topicHits", 0)),
                float(item.get("score", 0)),
                int(item.get("citations", 0)),
            ),
            reverse=True,
        )

        relevant_verified = [row for row in verified if int(row.get("_topicHits", 0)) > 0]
        ranked = relevant_verified[:8] if relevant_verified else verified[:8]
        verification_rejected = max(0, len(ranked_raw) - len(verified))
        recent_relaxed = False
        if year_floor:
            recent_ranked = []
            for row in ranked:
                try:
                    row_year = int(str(row.get("year") or "").strip())
                except Exception:
                    row_year = 0
                if row_year >= int(year_floor):
                    recent_ranked.append(row)
            if recent_ranked:
                ranked = recent_ranked[:8]
            elif ranked:
                recent_relaxed = True
        topics = self.extract_external_topics(ranked, limit=8)
        lang = self.normalize_output_language(target_language)

        if not ranked:
            if lang == "en":
                context_lines = [
                    "WEB SCHOLARLY SEARCH:",
                    f"- Query: {query}",
                    "- No fully verified direct record was retrieved in this turn.",
                ]
                if verification_rejected > 0:
                    context_lines.append("- Retrieved items failed DOI/URL verification.")
                if year_floor:
                    context_lines.append(f"- Requested time window: {year_floor}-{datetime.utcnow().year}.")
                context_lines.append("- Continue with Zotero context and provide a direct academic synthesis.")
                context_lines.append("- If evidence is limited, mark it as inference and do not invent citations.")
                context = "\n".join(context_lines)
            else:
                context_lines = [
                    "WEB AKADEMİK ARAMA:",
                    f"- Sorgu: {query}",
                    "- Bu turda tam doğrulanmış doğrudan kayıt bulunamadı.",
                ]
                if verification_rejected > 0:
                    context_lines.append("- Gelen kayıtlar DOI/URL doğrulamasını geçemedi.")
                if year_floor:
                    context_lines.append(f"- İstenen zaman aralığı: {year_floor}-{datetime.utcnow().year}.")
                context_lines.append("- Zotero bağlamıyla devam et ve doğrudan akademik sentez üret.")
                context_lines.append("- Kanıt sınırlıysa bunu çıkarım olarak etiketle; uydurma atıf verme.")
                context = "\n".join(context_lines)
            payload = {"query": query, "count": 0, "topics": [], "context": context}
            self.set_cached_external_search_result(cache_key, payload, EXTERNAL_SEARCH_CACHE_TTL_SECONDS)
            if on_event:
                on_event({"type": "meta", "phase": "external_search_done", "count": 0})
            return {"used": False, "query": query, "count": 0, "topics": [], "context": context, "cached": False}

        lines = []
        if lang == "en":
            lines.append("WEB SCHOLARLY SEARCH (retrieved live):")
            lines.append(f"- Query: {query}")
            if len(query_candidates) > 1:
                lines.append(f"- Query variants used: {len(query_candidates[:4])}")
            lines.append("- Scope: Academic-only sources (OpenAlex, Semantic Scholar, Crossref)")
            lines.append("- Validation: Each listed item passed DOI/URL verification")
            if year_floor:
                lines.append(f"- Requested time window: {year_floor}-{datetime.utcnow().year}")
            if recent_relaxed:
                lines.append("- No verified records were found strictly in the requested window; closest verified records are shown.")
            if topics:
                lines.append(f"- Topics: {', '.join(topics[:8])}")
            lines.append("- Highlighted papers:")
        else:
            lines.append("WEB AKADEMİK ARAMA (canlı getirildi):")
            lines.append(f"- Sorgu: {query}")
            if len(query_candidates) > 1:
                lines.append(f"- Kullanılan sorgu varyantı: {len(query_candidates[:4])}")
            lines.append("- Kapsam: Yalnız akademik kaynaklar (OpenAlex, Semantic Scholar, Crossref)")
            lines.append("- Doğrulama: Listelenen her kayıt DOI/URL kontrolünden geçti")
            if year_floor:
                lines.append(f"- İstenen zaman aralığı: {year_floor}-{datetime.utcnow().year}")
            if recent_relaxed:
                lines.append("- İstenen aralıkta doğrulanmış kayıt bulunamadı; en yakın doğrulanmış kayıtlar gösterildi.")
            if topics:
                lines.append(f"- Konular: {', '.join(topics[:8])}")
            lines.append("- Öne çıkan çalışmalar:")

        for idx, row in enumerate(ranked, start=1):
            title = row.get("title", "")
            year = row.get("year", "") or "-"
            venue = row.get("venue", "") or "-"
            authors = ", ".join((row.get("authors") or [])[:4]) or "-"
            citations = row.get("citations", 0)
            doi = row.get("doi", "")
            url = row.get("url", "")
            abstract = row.get("abstract", "")
            source_list = row.get("sources") if isinstance(row.get("sources"), list) else [row.get("source", "")]
            source = ", ".join(str(src or "").upper() for src in source_list if str(src or "").strip()) or "-"
            verification = str(row.get("verification", "")).strip()

            lines.append(f"{idx}) {title} ({year})")
            lines.append(f"   - Source: {source}")
            lines.append(f"   - Authors: {authors}")
            lines.append(f"   - Venue: {venue}")
            if verification:
                lines.append(f"   - Verification: {verification}")
            if citations:
                lines.append(f"   - Citations: {citations}")
            if doi:
                lines.append(f"   - DOI: {doi}")
            if url:
                lines.append(f"   - URL: {url}")
            if abstract:
                lines.append(f"   - Abstract snippet: {self.compact_external_text(abstract, max_len=220)}")

        if lang == "en":
            lines.append("Synthesize a direct academic answer from Zotero context and this list.")
            lines.append("If evidence is limited, explicitly mark inferences and avoid invented citations.")
        else:
            lines.append("Zotero bağlamı ve bu listeyle doğrudan akademik yanıtı sentezle.")
            lines.append("Kanıt sınırlıysa çıkarımı açıkça işaretle ve uydurma atıf üretme.")

        context = "\n".join(lines).strip()
        payload = {
            "query": query,
            "count": len(ranked),
            "topics": topics,
            "context": context,
        }
        self.set_cached_external_search_result(cache_key, payload, EXTERNAL_SEARCH_CACHE_TTL_SECONDS)
        if on_event:
            on_event({"type": "meta", "phase": "external_search_done", "count": len(ranked), "topics": topics[:8]})
        return {"used": True, "query": query, "count": len(ranked), "topics": topics, "context": context, "cached": False}

    def is_big_pdf_pipeline_requested(self, req_data):
        return self.as_bool((req_data or {}).get("bigPdfPipeline", False))

    def normalize_big_pdf_query(self, req_data, fallback_prompt="", target_language=""):
        query = str((req_data or {}).get("bigPdfQuery", "")).strip()
        if query:
            return query
        prompt_fallback = str(fallback_prompt or "").strip()
        if prompt_fallback:
            return prompt_fallback
        if self.normalize_output_language(target_language) == "en":
            return "Analyze the full PDF in detail."
        return "PDF'nin tamamını ayrıntılı analiz et."

    def normalize_pipeline_template(self, raw_template):
        allowed = {"none", "study", "presentation", "review", "thesis_notes", "policy_brief"}
        candidate = str(raw_template or "").strip().lower()
        return candidate if candidate in allowed else "none"

    def strip_prompt_directive_block(self, prompt, headers):
        text = str(prompt or "")
        if not text:
            return ""
        header_tokens = [str(header or "").strip() for header in (headers or []) if str(header or "").strip()]
        if not header_tokens:
            return text.strip()
        pattern = re.compile(
            r"(?:^|\n)(?:" + "|".join(re.escape(token) for token in header_tokens) + r")\s*",
            flags=re.IGNORECASE,
        )
        cut_idx = -1
        for match in pattern.finditer(text):
            cut_idx = match.start()
        if cut_idx < 0:
            return text.strip()
        return text[:cut_idx].rstrip()

    def apply_template_rule_from_request(self, prompt, req_data, target_language):
        headers = ["OUTPUT TEMPLATE:", "ÇIKTI ŞABLONU:"]
        base = self.strip_prompt_directive_block(prompt, headers)
        return base

    def output_quality_instruction(self, target_language, require_verified_sources=False):
        lang = self.normalize_output_language(target_language)
        if lang == "en":
            lines = [
                "Write strictly in the selected language; do not mix languages.",
                "Use concise but comprehensive academic style (neutral, technical, clear).",
                "No process narration, no filler, no hidden chain-of-thought.",
                "Do not invent claims, references, DOI, URL, datasets, or quotations.",
                "If evidence is uncertain or missing, label it explicitly as inference/limitation.",
            ]
            if require_verified_sources:
                lines.append(
                    "When external sources are used, cite only verified records and provide a short source list: Title — Year — DOI/URL."
                )
            return "\n".join(f"- {line}" for line in lines)

        lines = [
            "Yalnızca seçili dilde yaz; dil karıştırma.",
            "Öz fakat kapsayıcı, akademik üslup kullan (tarafsız, teknik, açık).",
            "Süreç anlatımı, dolgu cümlesi ve iç düşünme metni yazma.",
            "İddia, kaynak, DOI, URL, veri seti veya alıntı uydurma.",
            "Kanıt eksikse bunu açıkça çıkarım/sınırlılık olarak etiketle.",
        ]
        if require_verified_sources:
            lines.append(
                "Dış kaynak kullanılıyorsa yalnız doğrulanmış kayıtları kullan; kısa kaynak listesi ver: Başlık — Yıl — DOI/URL."
            )
        return "\n".join(f"- {line}" for line in lines)

    def apply_output_quality_rule(self, prompt, target_language, require_verified_sources=False):
        headers = ["OUTPUT QUALITY:", "ÇIKTI KALİTESİ:"]
        base = self.strip_prompt_directive_block(prompt, headers)
        lang = self.normalize_output_language(target_language)
        header = "OUTPUT QUALITY:" if lang == "en" else "ÇIKTI KALİTESİ:"
        rules = self.output_quality_instruction(target_language, require_verified_sources=require_verified_sources)
        return f"{base}\n\n{header}\n{rules}".strip()

    def source_routing_instruction(self, target_language):
        lang = self.normalize_output_language(target_language)
        if lang == "en":
            return (
                "Run external scholarly lookup automatically based on the current request when Zotero context is not enough.\n"
                "Do not output search-plan/query-suggestion sections unless the user explicitly asks for queries.\n"
                "Use only academic sources and verify each cited item before presenting it.\n"
                "If external evidence is limited, continue with an academic synthesis using Zotero context and clearly label inferences.\n"
                "Return a direct evidence-based answer and include a short source list (title, year, DOI/URL)."
            )
        return (
            "Zotero bağlamı yetmezse mevcut isteğe göre dış akademik aramayı otomatik çalıştır.\n"
            "Kullanıcı açıkça istemedikçe arama planı/sorgu önerisi bölümü üretme.\n"
            "Yalnız akademik kaynak kullan ve sunmadan önce her kaynağı doğrula.\n"
            "Dış kanıt sınırlıysa Zotero bağlamıyla akademik bir sentezle devam et ve çıkarımı açıkça etiketle.\n"
            "Kanıta dayalı doğrudan yanıt ver ve kısa kaynak listesi ekle (başlık, yıl, DOI/URL)."
        )

    def apply_source_routing_rule_from_request(self, prompt, req_data, target_language):
        headers = ["EXTERNAL SOURCE ROUTING:", "DIŞ KAYNAK YÖNLENDİRME:"]
        base = self.strip_prompt_directive_block(prompt, headers)
        if not self.normalize_source_routing_mode(req_data):
            return base
        lang = self.normalize_output_language(target_language)
        header = "EXTERNAL SOURCE ROUTING:" if lang == "en" else "DIŞ KAYNAK YÖNLENDİRME:"
        instruction = self.source_routing_instruction(target_language)
        return f"{base}\n\n{header}\n- {instruction}".strip()

    def normalize_pipeline_chunk_limit(self, raw_limit):
        candidate = str(raw_limit or "").strip().lower()
        if candidate in {"", "auto", "default"}:
            return 0
        try:
            parsed = int(candidate)
        except Exception:
            return 0
        if parsed < 2:
            return 0
        return min(16, parsed)

    def has_pipeline_citations(self, text, target_language):
        content = str(text or "")
        lang = self.normalize_output_language(target_language)
        if lang == "en":
            return bool(
                re.search(r"\[Chunk\s*\d+\]", content, flags=re.IGNORECASE)
                or re.search(r"\((Source|Sources)\s*:\s*\d+", content, flags=re.IGNORECASE)
            )
        return bool(
            re.search(r"\[Parça\s*\d+\]", content, flags=re.IGNORECASE)
            or re.search(r"\(Kaynak\s*:\s*\d+", content, flags=re.IGNORECASE)
        )

    def format_pipeline_citations_for_users(self, text, target_language):
        content = str(text or "")
        if not content:
            return content

        lang = self.normalize_output_language(target_language)
        source_label = "Sources" if lang == "en" else "Kaynak"

        # Normalize bracket tags such as [Parça6] or [Chunk6] into a consistent form.
        normalized = re.sub(r"\[(Parça|Chunk)\s*(\d+)\]", r"[\1 \2]", content, flags=re.IGNORECASE)

        # Convert dense tag chains like [Parça 2][Parça 5] into a reader-friendly source note.
        chain_pattern = re.compile(r"(?:\[(?:Parça|Chunk)\s*\d+\]\s*)+", flags=re.IGNORECASE)

        def replace_chain(match):
            raw = match.group(0)
            nums = re.findall(r"\d+", raw)
            ordered_unique = []
            seen = set()
            for num in nums:
                if num in seen:
                    continue
                seen.add(num)
                ordered_unique.append(num)
            if not ordered_unique:
                return raw
            return f"({source_label}: {', '.join(ordered_unique)})"

        return chain_pattern.sub(replace_chain, normalized)

    def big_pdf_pipeline_config(self, analysis_mode):
        mode = self.normalize_analysis_mode(analysis_mode)
        if mode == "fast":
            return {
                "chunk_size": 5200,
                "chunk_overlap": 320,
                "max_chunks": 4,
                "max_source_chars": 5200 * 5,
                "chunk_analysis_mode": "fast",
            }
        if mode == "deep":
            return {
                "chunk_size": 7600,
                "chunk_overlap": 520,
                "max_chunks": 12,
                "max_source_chars": 7600 * 13,
                "chunk_analysis_mode": "balanced",
            }
        return {
            "chunk_size": 6400,
            "chunk_overlap": 420,
            "max_chunks": 8,
            "max_source_chars": 6400 * 9,
            "chunk_analysis_mode": "balanced",
        }

    def pipeline_template_instruction(self, template, target_language):
        lang = self.normalize_output_language(target_language)
        normalized = self.normalize_pipeline_template(template)
        if normalized == "none":
            return ""
        if lang == "en":
            mapping = {
                "study": (
                    "Template: STUDY NOTE.\n"
                    "Sections: (1) Structured summary, (2) Concepts and definitions, (3) Method and evidence, "
                    "(4) Key findings, (5) Limits, (6) Exam/study checklist."
                ),
                "presentation": (
                    "Template: PRESENTATION.\n"
                    "Sections: (1) Slide-by-slide outline (8-12 slides), (2) Speaker notes, "
                    "(3) Visual suggestions per slide, (4) Q&A prep."
                ),
                "review": (
                    "Template: PEER REVIEW.\n"
                    "Sections: (1) Summary for editor, (2) Major comments, (3) Minor comments, "
                    "(4) Recommendation with justification."
                ),
                "thesis_notes": (
                    "Template: RESEARCH NOTES.\n"
                    "Sections: (1) Literature placement, (2) Reusable argument blocks, (3) Methods relevance, "
                    "(4) Citation-ready notes, (5) Research gap map."
                ),
                "policy_brief": (
                    "Template: POLICY BRIEF.\n"
                    "Sections: (1) Problem framing, (2) Evidence highlights, (3) Policy options, "
                    "(4) Risks and tradeoffs, (5) Action roadmap."
                ),
            }
            return mapping.get(normalized, mapping["study"])

        mapping = {
            "study": (
                "Şablon: ÇALIŞMA NOTU.\n"
                "Bölümler: (1) Yapılandırılmış özet, (2) Kavramlar ve tanımlar, (3) Yöntem ve kanıt, "
                "(4) Temel bulgular, (5) Sınırlılıklar, (6) Sınav/çalışma kontrol listesi."
            ),
            "presentation": (
                "Şablon: SUNUM.\n"
                "Bölümler: (1) 8-12 slaytlık akış planı, (2) Konuşmacı notları, "
                "(3) Slayt başına görsel önerisi, (4) Soru-cevap hazırlığı."
            ),
            "review": (
                "Şablon: HAKEM DEĞERLENDİRMESİ.\n"
                "Bölümler: (1) Editöre kısa özet, (2) Majör yorumlar, (3) Minör yorumlar, "
                "(4) Gerekçeli karar önerisi."
            ),
            "thesis_notes": (
                "Şablon: ARAŞTIRMA NOTLARI.\n"
                "Bölümler: (1) Literatürde konumlandırma, (2) Yeniden kullanılabilir argüman blokları, "
                "(3) Yöntem uygunluğu, (4) Atıfa hazır notlar, (5) Araştırma boşluk haritası."
            ),
            "policy_brief": (
                "Şablon: POLİTİKA ÖZETİ.\n"
                "Bölümler: (1) Sorun çerçevesi, (2) Kanıt özeti, (3) Politika seçenekleri, "
                "(4) Riskler ve ödünleşimler, (5) Eylem yol haritası."
            ),
        }
        return mapping.get(normalized, mapping["study"])

    def fetch_zotero_api_json(self, path, timeout=12):
        normalized_path = str(path or "").strip()
        if not normalized_path:
            raise ValueError("Zotero API path is empty")
        if not normalized_path.startswith("/"):
            normalized_path = "/" + normalized_path

        cache_profile = self.tool_cache_profile_for_path(normalized_path)
        cache_key = self.tool_cache_key(normalized_path)
        if cache_profile:
            cached = self.get_cached_tool_result(cache_key)
            if cached:
                raw_body = cached.get("body", b"")
                if isinstance(raw_body, str):
                    raw_body = raw_body.encode("utf-8")
                payload = raw_body.decode("utf-8", errors="replace").strip()
                return json.loads(payload) if payload else {}

        url = f"{ZOTERO_API}{normalized_path}"
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=max(3, int(timeout or 12))) as resp:
                raw = resp.read()
                body_text = raw.decode("utf-8", errors="replace").strip()
                data = json.loads(body_text) if body_text else {}
                if cache_profile and int(resp.status) == 200:
                    headers = {}
                    for header in ["Content-Type", "Total-Results", "Link", "Last-Modified-Version", "ETag"]:
                        val = resp.getheader(header)
                        if val:
                            headers[header] = val
                    self.set_cached_tool_result(
                        cache_key,
                        {
                            "status": int(resp.status),
                            "headers": headers,
                            "body": raw,
                        },
                        cache_profile.get("ttl", 300),
                    )
                return data
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                raw = e.read()
                text = raw.decode("utf-8", errors="replace").strip()
                if text:
                    try:
                        parsed = json.loads(text)
                        detail = str(parsed.get("error") or parsed.get("message") or "")
                    except Exception:
                        detail = text
            except Exception:
                detail = ""
            raise ValueError(f"Zotero API {e.code}: {detail or normalized_path}")
        except urllib.error.URLError as e:
            raise ValueError(f"Zotero API erişilemedi: {e}")

    def extract_fulltext_content(self, payload):
        candidates = []

        def collect(node):
            if isinstance(node, str):
                candidates.append(node)
                return
            if isinstance(node, dict):
                for key in ("content", "fulltext", "fullText", "text", "body", "value"):
                    value = node.get(key)
                    if isinstance(value, str):
                        candidates.append(value)
                for key in ("data", "result", "payload"):
                    nested = node.get(key)
                    if isinstance(nested, (dict, list, str)):
                        collect(nested)
                return
            if isinstance(node, list):
                for item in node[:20]:
                    collect(item)

        collect(payload)
        if not candidates:
            return ""

        best = max(candidates, key=lambda value: len(str(value or "")))
        text = str(best or "").replace("\r\n", "\n").replace("\r", "\n")
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()

    def split_text_for_big_pdf_pipeline(self, text, chunk_size, overlap, max_chunks):
        content = str(text or "").strip()
        if not content:
            return []

        size = max(1200, int(chunk_size or 6400))
        overlap_len = max(0, min(int(overlap or 0), size // 3))
        max_chunk_count = max(1, int(max_chunks or 8))

        chunks = []
        cursor = 0
        total_len = len(content)
        while cursor < total_len and len(chunks) < max_chunk_count:
            end = min(total_len, cursor + size)
            if end < total_len:
                para_break = content.rfind("\n\n", cursor + int(size * 0.55), end)
                sentence_break = content.rfind(". ", cursor + int(size * 0.6), end)
                split_point = max(para_break, sentence_break)
                if split_point > cursor + int(size * 0.5):
                    if split_point == sentence_break:
                        end = split_point + 1
                    else:
                        end = split_point

            chunk = content[cursor:end].strip()
            if chunk:
                chunks.append(chunk)
            if end >= total_len:
                break
            cursor = max(cursor + 1, end - overlap_len)

        return chunks

    def build_big_pdf_chunk_prompt(self, item_title, item_key, user_query, chunk_text, chunk_index, chunk_total, target_language):
        lang = self.normalize_output_language(target_language)
        if lang == "en":
            return (
                f'You are analyzing a large PDF in chunks.\n'
                f'Document: "{item_title}" (key: {item_key})\n'
                f'User goal: {user_query}\n'
                f'Chunk: {chunk_index}/{chunk_total}\n\n'
                "Rules:\n"
                "- Use ONLY the chunk text below.\n"
                "- Do not use outside knowledge.\n"
                "- If information is missing, state it clearly.\n"
                "- Write only in English, with concise but comprehensive academic style.\n"
                "- Do not include process narration.\n"
                "- Do not invent references, DOI/URL, or claims not grounded in this chunk.\n\n"
                "Output format:\n"
                "1) Chunk focus (1 sentence)\n"
                "2) Key points (4-6 bullets)\n"
                "3) Methods/data/findings in this chunk (bullets)\n"
                "4) Why this chunk matters for the user goal (2-3 bullets)\n\n"
                f"Chunk text:\n{chunk_text}"
            )
        return (
            f'Büyük bir PDF parça parça analiz ediliyor.\n'
            f'Doküman: "{item_title}" (key: {item_key})\n'
            f'Kullanıcı hedefi: {user_query}\n'
            f'Parça: {chunk_index}/{chunk_total}\n\n'
            "Kurallar:\n"
            "- SADECE aşağıdaki parça metnini kullan.\n"
            "- Dış bilgi ekleme.\n"
            "- Bilgi eksikse açıkça belirt.\n"
            "- Yalnızca Türkçe yaz; öz fakat kapsayıcı akademik üslup kullan.\n"
            "- Süreç anlatımı yazma.\n"
            "- Bu parçada geçmeyen iddia, kaynak, DOI/URL uydurma.\n\n"
            "Çıktı formatı:\n"
            "1) Parça odağı (1 cümle)\n"
            "2) Ana noktalar (4-6 madde)\n"
            "3) Bu parçada geçen yöntem/veri/bulgu (maddeler)\n"
            "4) Kullanıcı hedefine katkısı (2-3 madde)\n\n"
            f"Parça metni:\n{chunk_text}"
        )

    def build_big_pdf_final_prompt(self, item_title, item_key, user_query, chunk_summaries, target_language, template="study"):
        lang = self.normalize_output_language(target_language)
        joined = "\n\n".join(chunk_summaries)
        template_instruction = self.pipeline_template_instruction(template, target_language)
        if lang == "en":
            return (
                f'Using the chunk summaries below, produce a single coherent final analysis for "{item_title}" (key: {item_key}).\n'
                f'User goal: {user_query}\n\n'
                "Rules:\n"
                "- Use ONLY the chunk summaries.\n"
                "- Keep claims grounded; mark missing or uncertain points.\n"
                "- Write only in English, in concise but comprehensive academic style.\n"
                "- No process narration and no fabricated references/DOI/URL.\n\n"
                f"{template_instruction}\n\n"
                "Citation rule (MANDATORY): Every factual sentence or bullet MUST end with at least one source tag like [Chunk 3].\n"
                "If multiple chunks support a claim, use multiple tags such as [Chunk 2][Chunk 5].\n\n"
                f"Chunk summaries:\n{joined}"
            )
        return (
            f'"{item_title}" (key: {item_key}) için aşağıdaki parça özetlerini birleştirerek tek bir nihai analiz üret.\n'
            f'Kullanıcı hedefi: {user_query}\n\n'
            "Kurallar:\n"
            "- SADECE parça özetlerini kullan.\n"
            "- İddiaları kaynağa dayandır; eksik/belirsiz noktaları işaretle.\n"
            "- Yalnızca Türkçe yaz; öz fakat kapsayıcı akademik üslup kullan.\n"
            "- Süreç anlatımı ve uydurma kaynak/DOI/URL üretme.\n\n"
            f"{template_instruction}\n\n"
            "Kaynak etiketi kuralı (ZORUNLU): Her olgusal cümle veya madde sonuna en az bir kaynak etiketi ekle: [Parça 3].\n"
            "Aynı iddia birden fazla parçaya dayanıyorsa birden çok etiket kullan: [Parça 2][Parça 5].\n\n"
            f"Parça özetleri:\n{joined}"
        )

    def execute_big_pdf_pipeline(self, req_data, fallback_prompt, provider, model, analysis_mode="balanced", output_language="", on_event=None):
        item_key = self.normalize_item_key((req_data or {}).get("itemKey", ""))
        if not item_key:
            raise ValueError("Büyük PDF pipeline için geçerli itemKey gerekli.")

        config = self.big_pdf_pipeline_config(analysis_mode) or {
            "chunk_size": 6400,
            "chunk_overlap": 420,
            "max_chunks": 8,
            "max_source_chars": 6400 * 9,
            "chunk_analysis_mode": "balanced",
        }
        pipeline_template = "none"
        requested_chunk_limit = self.normalize_pipeline_chunk_limit((req_data or {}).get("pipelineChunkLimit", "auto"))
        if requested_chunk_limit > 0:
            config["max_chunks"] = requested_chunk_limit
        query = self.normalize_big_pdf_query(req_data, fallback_prompt=fallback_prompt, target_language=output_language)

        base_candidates = self.item_api_base_candidates(req_data)
        metadata = None
        item_base = ""
        last_metadata_err = None
        for base in base_candidates:
            try:
                metadata = self.fetch_zotero_api_json(f"{base}/items/{item_key}?format=json", timeout=10)
                item_base = base
                break
            except ValueError as e:
                if "Zotero API 404" in str(e or ""):
                    last_metadata_err = e
                    continue
                raise
        if metadata is None:
            if last_metadata_err:
                raise ValueError(
                    "Seçili öğe Zotero API'de bulunamadı (404). Öğeyi yenileyip tekrar deneyin."
                ) from last_metadata_err
            raise ValueError("Seçili öğe için metadata alınamadı.")
        item_title = (
            str((metadata or {}).get("data", {}).get("title", "")).strip()
            or f"Item {item_key}"
        )
        fulltext = ""
        try:
            fulltext_payload = self.fetch_zotero_api_json(f"{item_base}/items/{item_key}/fulltext?format=json", timeout=14)
            fulltext = self.extract_fulltext_content(fulltext_payload)
        except ValueError as e:
            err_msg = str(e or "")
            if "Zotero API 404" not in err_msg:
                raise

        # Many libraries expose fulltext at PDF attachment level, not parent item level.
        if not fulltext:
            attachment_keys = []
            try:
                children = self.fetch_zotero_api_json(f"{item_base}/items/{item_key}/children?format=json", timeout=10)
                if isinstance(children, list):
                    for child in children:
                        if not isinstance(child, dict):
                            continue
                        data = child.get("data", {}) if isinstance(child.get("data"), dict) else {}
                        item_type = str(data.get("itemType", "")).strip().lower()
                        content_type = str(data.get("contentType", "")).strip().lower()
                        if item_type != "attachment" or content_type != "application/pdf":
                            continue
                        att_key = self.normalize_item_key(child.get("key") or data.get("key"))
                        if att_key and att_key not in attachment_keys:
                            attachment_keys.append(att_key)
            except ValueError:
                attachment_keys = []

            for attachment_key in attachment_keys[:6]:
                try:
                    attachment_fulltext_payload = self.fetch_zotero_api_json(
                        f"{item_base}/items/{attachment_key}/fulltext?format=json",
                        timeout=14,
                    )
                    candidate_text = self.extract_fulltext_content(attachment_fulltext_payload)
                    if candidate_text:
                        fulltext = candidate_text
                        break
                except ValueError:
                    continue

        if not fulltext:
            raise ValueError("Zotero tam metni bulunamadı. PDF içeriği indekslenmemiş olabilir.")

        source_truncated = False
        max_source_chars = int(config.get("max_source_chars", 50000))
        if len(fulltext) > max_source_chars:
            fulltext = fulltext[:max_source_chars].rstrip()
            source_truncated = True

        requested_mode = self.normalize_analysis_mode(analysis_mode)
        chunk_mode = self.normalize_analysis_mode(config.get("chunk_analysis_mode", "balanced"))
        final_mode = requested_mode

        # Smart speed/cost policy for very long documents: fast chunk pass + balanced synthesis.
        if len(fulltext) >= 90000 and requested_mode in {"balanced", "deep"}:
            chunk_mode = "fast"
            final_mode = "balanced"
        elif len(fulltext) >= 55000 and requested_mode == "deep":
            chunk_mode = "fast"
            final_mode = "balanced"

        chunks = self.split_text_for_big_pdf_pipeline(
            fulltext,
            config.get("chunk_size", 6400),
            config.get("chunk_overlap", 420),
            config.get("max_chunks", 8),
        )
        if not chunks:
            raise ValueError("Tam metin parçalara ayrılamadı.")

        chunk_summaries = []
        all_errors = []
        provider_used = self.normalize_provider(provider)
        fallback_used = False
        chunk_tag_label = "Chunk" if self.normalize_output_language(output_language) == "en" else "Parça"

        if on_event:
            on_event(
                {
                    "type": "meta",
                    "phase": "big_pdf_pipeline_start",
                    "itemKey": item_key,
                    "chunkCount": len(chunks),
                    "analysisMode": analysis_mode,
                    "chunkMode": chunk_mode,
                    "finalMode": final_mode,
                    "template": pipeline_template,
                    "chunkLimit": int(config.get("max_chunks", 0)),
                }
            )

        for idx, chunk_text in enumerate(chunks, start=1):
            if on_event:
                on_event(
                    {
                        "type": "meta",
                        "phase": "big_pdf_pipeline_chunk",
                        "index": idx,
                        "total": len(chunks),
                    }
                )

            chunk_prompt = self.build_big_pdf_chunk_prompt(
                item_title,
                item_key,
                query,
                chunk_text,
                idx,
                len(chunks),
                output_language,
            )

            chunk_result = self.execute_with_provider_fallback(
                chunk_prompt,
                provider,
                model,
                analysis_mode=chunk_mode,
                stream=False,
            )
            chunk_text_out = self.sanitize_provider_output(
                chunk_result.get("text"),
                chunk_result.get("providerUsed", provider),
            )
            provider_used = self.normalize_provider(chunk_result.get("providerUsed", provider_used))
            fallback_used = fallback_used or bool(chunk_result.get("fallbackUsed", False))

            errors = chunk_result.get("errors", [])
            if errors:
                all_errors.extend([f"chunk-{idx}: {err}" for err in errors[:3]])

            if not chunk_text_out:
                chunk_text_out = (
                    "Chunk analysis unavailable due to model/tool error."
                    if self.normalize_output_language(output_language) == "en"
                    else "Parça analizi model/araç hatası nedeniyle üretilemedi."
                )
            chunk_text_out = chunk_text_out.strip()
            if len(chunk_text_out) > 1500:
                chunk_text_out = chunk_text_out[:1500].rstrip() + " ..."
            chunk_summaries.append(f"[{chunk_tag_label} {idx}/{len(chunks)}]\n{chunk_text_out}")

        final_prompt = self.build_big_pdf_final_prompt(
            item_title,
            item_key,
            query,
            chunk_summaries,
            output_language,
            template=pipeline_template,
        )
        final_result = self.execute_with_provider_fallback(
            final_prompt,
            provider,
            model,
            analysis_mode=final_mode,
            stream=False,
        )
        final_text = self.sanitize_provider_output(
            final_result.get("text"),
            final_result.get("providerUsed", provider),
        )
        provider_used = self.normalize_provider(final_result.get("providerUsed", provider_used))
        fallback_used = fallback_used or bool(final_result.get("fallbackUsed", False))
        final_errors = final_result.get("errors", [])
        if final_errors:
            all_errors.extend([f"final: {err}" for err in final_errors[:4]])

        if not final_text:
            final_text = "\n\n".join(chunk_summaries)

        if not self.has_pipeline_citations(final_text, output_language):
            citation_lang = self.normalize_output_language(output_language)
            cite_rewrite_prompt = (
                "Rewrite the text below by adding citation tags after every factual sentence/bullet. "
                "Use only these tags: [Chunk n], where n is between 1 and {nmax}. "
                "Do not change meaning.\n\nText:\n{body}"
            ) if citation_lang == "en" else (
                "Aşağıdaki metni, her olgusal cümle/madde sonuna kaynak etiketi ekleyerek yeniden yaz. "
                "Sadece şu etiketleri kullan: [Parça n], n değeri 1 ile {nmax} arasında olmalı. "
                "Anlamı değiştirme.\n\nMetin:\n{body}"
            )
            rewrite_prompt = cite_rewrite_prompt.format(nmax=len(chunks), body=final_text)
            cite_result = self.execute_with_provider_fallback(
                rewrite_prompt,
                provider_used,
                model if provider_used == provider else "",
                analysis_mode="fast",
                stream=False,
            )
            cited = self.sanitize_provider_output(cite_result.get("text"), cite_result.get("providerUsed", provider_used))
            cite_errors = cite_result.get("errors", [])
            if cite_errors:
                all_errors.extend([f"citation-fix: {err}" for err in cite_errors[:2]])
            if cited and self.has_pipeline_citations(cited, output_language):
                final_text = cited

        if source_truncated:
            tail_note = (
                "\n\nNote: Source text exceeded pipeline limits; only the initial portion was processed."
                if self.normalize_output_language(output_language) == "en"
                else "\n\nNot: Kaynak metin pipeline limitini aştığı için sadece ilk bölüm işlendi."
            )
            final_text = f"{final_text.rstrip()}{tail_note}"

        final_text = self.format_pipeline_citations_for_users(final_text, output_language)

        if on_event:
            on_event(
                {
                    "type": "meta",
                    "phase": "big_pdf_pipeline_done",
                    "chunkCount": len(chunks),
                    "truncated": source_truncated,
                    "chunkMode": chunk_mode,
                    "finalMode": final_mode,
                    "template": pipeline_template,
                }
            )

        return {
            "text": final_text,
            "providerUsed": provider_used,
            "fallbackUsed": fallback_used,
            "errors": all_errors,
            "pipelineUsed": True,
            "pipelineChunks": len(chunks),
            "pipelineTruncated": source_truncated,
            "pipelineTemplate": pipeline_template,
            "pipelineChunkMode": chunk_mode,
            "pipelineFinalMode": final_mode,
        }

    def build_ai_cache_scope(self, req_data, prompt):
        item_key = self.normalize_item_key((req_data or {}).get("itemKey", ""))

        compare_keys = []
        raw_compare = (req_data or {}).get("compareKeys", [])
        if isinstance(raw_compare, list):
            for raw_key in raw_compare[:6]:
                normalized = self.normalize_item_key(raw_key)
                if normalized:
                    compare_keys.append(normalized)
        compare_keys = sorted(set(compare_keys))

        if compare_keys:
            return f"cmp:{','.join(compare_keys)}"
        if item_key:
            return f"itm:{item_key}"

        inferred_keys = []
        for key in re.findall(r"\bkey:\s*([A-Z0-9]{8})\b", str(prompt or ""), flags=re.IGNORECASE):
            normalized = self.normalize_item_key(key)
            if normalized:
                inferred_keys.append(normalized)
        inferred_keys = sorted(set(inferred_keys))

        if len(inferred_keys) > 1:
            return f"cmp:{','.join(inferred_keys[:6])}"
        if len(inferred_keys) == 1:
            return f"itm:{inferred_keys[0]}"
        return "global"

    def build_ai_response_cache_key(self, req_data, prompt, provider, model, analysis_mode):
        scope = self.build_ai_cache_scope(req_data, prompt)
        base_token = self.normalize_item_api_base((req_data or {}).get("itemApiBase", "")).replace("/api/", "").replace("/", "-")
        mode_token = self.normalize_analysis_mode(analysis_mode)
        provider_token = self.normalize_provider(provider)
        model_token = str(model or "").strip().lower() or "default"
        prompt_hash = hashlib.sha256(str(prompt or "").encode("utf-8")).hexdigest()[:24]
        source_routing = self.normalize_source_routing_mode(req_data)
        source_query = self.normalize_external_search_query(req_data, prompt) if source_routing else ""
        source_token = "sr0"
        if source_routing:
            source_hash = hashlib.sha256(source_query.encode("utf-8")).hexdigest()[:12] if source_query else "empty"
            source_token = f"sr1:{source_hash}"
        template_token = "tpl:none"
        if self.is_big_pdf_pipeline_requested(req_data):
            template = "none"
            chunk_limit = self.normalize_pipeline_chunk_limit((req_data or {}).get("pipelineChunkLimit", "auto"))
            pipeline_token = f"bp2:{template}:{chunk_limit or 'auto'}"
        else:
            pipeline_token = "std"
        return f"{scope}|{base_token}|{provider_token}|{model_token}|{mode_token}|{pipeline_token}|{template_token}|{source_token}|{prompt_hash}"

    def ai_response_cache_ttl_seconds(self, analysis_mode):
        mode = self.normalize_analysis_mode(analysis_mode)
        return AI_RESPONSE_CACHE_TTL_SECONDS.get(mode, AI_RESPONSE_CACHE_TTL_SECONDS["balanced"])

    def get_cached_ai_response(self, cache_key):
        return self.cache_get(AI_RESPONSE_CACHE, AI_RESPONSE_CACHE_LOCK, cache_key)

    def set_cached_ai_response(self, cache_key, payload, ttl_seconds):
        self.cache_set(
            AI_RESPONSE_CACHE,
            AI_RESPONSE_CACHE_LOCK,
            cache_key,
            payload,
            ttl_seconds,
            AI_RESPONSE_CACHE_MAX_ENTRIES,
        )

    def resolve_zotero_mcp_command(self):
        env_cmd = str(os.environ.get("ZOTERO_MCP_COMMAND", "")).strip()
        candidates = [env_cmd, ZOTERO_MCP_COMMAND_DEFAULT]
        if os.name == "nt":
            candidates.extend(["zotero-mcp.cmd", "zotero-mcp.exe", "zotero-mcp"])
        else:
            candidates.append("zotero-mcp")
        resolved = self.resolve_command_from_candidates(candidates)
        if resolved:
            return resolved
        return "zotero-mcp"

    def ensure_claude_mcp_config(self, mcp_command):
        payload = {
            "mcpServers": {
                "zotero-mcp": {
                    "command": mcp_command,
                    "args": [],
                    "env": {},
                }
            }
        }
        current = self.read_json_file(CLAUDE_MCP_CONFIG_FILE)
        if current != payload:
            self.write_json_file(CLAUDE_MCP_CONFIG_FILE, payload)
        return CLAUDE_MCP_CONFIG_FILE

    def ensure_gemini_workspace_settings(self, mcp_command):
        current = self.read_json_file(GEMINI_WORKSPACE_SETTINGS_FILE)
        settings = dict(current) if isinstance(current, dict) else {}

        mcp_servers = settings.get("mcpServers")
        if not isinstance(mcp_servers, dict):
            mcp_servers = {}

        existing = mcp_servers.get("zotero-mcp")
        existing_env = existing.get("env") if isinstance(existing, dict) and isinstance(existing.get("env"), dict) else {}
        mcp_servers["zotero-mcp"] = {
            "type": "stdio",
            "command": mcp_command,
            "args": [],
            "env": existing_env,
        }
        settings["mcpServers"] = mcp_servers

        mcp_cfg = settings.get("mcp")
        if not isinstance(mcp_cfg, dict):
            mcp_cfg = {}
        allowed = mcp_cfg.get("allowed")
        if not isinstance(allowed, list):
            allowed = []
        if "zotero-mcp" not in allowed:
            allowed.append("zotero-mcp")
        mcp_cfg["allowed"] = allowed
        settings["mcp"] = mcp_cfg

        if settings != current:
            self.write_json_file(GEMINI_WORKSPACE_SETTINGS_FILE, settings)
        return GEMINI_WORKSPACE_SETTINGS_FILE

    def ensure_provider_mcp_setup(self, provider):
        mcp_command = self.resolve_zotero_mcp_command()
        setup = {"command": mcp_command}
        if provider == "claude":
            setup["claude_config_path"] = self.ensure_claude_mcp_config(mcp_command)
        elif provider == "gemini":
            setup["gemini_settings_path"] = self.ensure_gemini_workspace_settings(mcp_command)
        elif provider == "codex":
            # Codex receives MCP server via -c overrides per command attempt.
            setup["codex_inline"] = True
        return setup

    def normalize_provider(self, provider):
        normalized = str(provider or "").strip().lower()
        if normalized not in {"claude", "codex", "gemini"}:
            return "claude"
        return normalized

    def default_model_for_provider(self, provider):
        defaults = {
            "claude": "sonnet",
            "codex": "gpt-5-codex",
            "gemini": "gemini-2.5-flash",
        }
        return defaults.get(provider, "")

    def model_candidates(self, provider, requested_model):
        requested = str(requested_model or "").strip()
        fallback_default = self.default_model_for_provider(provider)
        candidates = []
        ordered = [requested, fallback_default, ""] if requested else [fallback_default, ""]
        if provider == "codex":
            ordered.extend(["gpt-5-codex", "gpt-5"])
        elif provider == "gemini":
            ordered.extend(["gemini-2.5-flash", "gemini-2.5-pro"])
        elif provider == "claude":
            ordered.extend(["sonnet"])
        for value in ordered:
            if value not in candidates:
                candidates.append(value)
        return candidates

    def is_rate_limit_error(self, message):
        normalized = str(message or "").lower()
        tokens = [
            "status 429",
            "too many requests",
            "rate limit",
            "quota",
            "resource_exhausted",
            "retrying with backoff",
            "exceeded your current quota",
        ]
        return any(token in normalized for token in tokens)

    def max_model_candidates_for_mode(self, provider, analysis_mode):
        mode = self.normalize_analysis_mode(analysis_mode)
        limits = {
            "fast": {"claude": 1, "codex": 1, "gemini": 1},
            "balanced": {"claude": 2, "codex": 2, "gemini": 2},
            "deep": {"claude": 3, "codex": 3, "gemini": 2},
        }
        return int(limits.get(mode, limits["balanced"]).get(provider, 1))

    def attempt_timeout_seconds(self, provider, model, analysis_mode, variant="primary"):
        mode = self.normalize_analysis_mode(analysis_mode)
        provider = self.normalize_provider(provider)
        table = {
            "fast": {
                "claude": {"primary": 80},
                "codex": {"primary": 95, "secondary": 80},
                "gemini": {"primary": 75, "secondary": 75},
            },
            "balanced": {
                "claude": {"primary": 140},
                "codex": {"primary": 170, "secondary": 140},
                "gemini": {"primary": 115, "secondary": 110},
            },
            "deep": {
                "claude": {"primary": 220},
                "codex": {"primary": 240, "secondary": 190},
                "gemini": {"primary": 185, "secondary": 170},
            },
        }
        base = int(table.get(mode, table["balanced"]).get(provider, {}).get(variant, 120))
        model_name = str(model or "").lower()
        if provider == "gemini" and "pro" in model_name:
            base += 30
        if provider == "codex" and mode == "deep" and ("gpt-5" in model_name):
            base += 20
        if provider == "claude" and mode == "deep" and ("opus" in model_name):
            base += 30
        return max(40, base)

    def use_secondary_attempt_variant(self, provider, analysis_mode):
        mode = self.normalize_analysis_mode(analysis_mode)
        provider = self.normalize_provider(provider)
        if provider in {"codex", "gemini"}:
            return mode != "fast"
        return False

    def attempt_prefers_pty(self, attempt):
        provider = self.normalize_provider(attempt.get("provider", "claude"))
        return provider == "gemini"

    def get_cli_attempts(self, provider, prompt, model, analysis_mode="balanced"):
        provider = self.normalize_provider(provider)
        mode = self.normalize_analysis_mode(analysis_mode)
        mcp_setup = self.ensure_provider_mcp_setup(provider)
        mcp_command = mcp_setup.get("command", "zotero-mcp")
        claude_bin = self.resolve_provider_command("claude")
        codex_bin = self.resolve_provider_command("codex")
        gemini_bin = self.resolve_provider_command("gemini")

        model_candidates = self.model_candidates(provider, model)[: self.max_model_candidates_for_mode(provider, mode)]
        attempts = []
        if provider == "claude":
            for candidate in model_candidates:
                model_suffix = f" --model {candidate}" if candidate else " (default model)"
                cmd = [
                    claude_bin,
                    "-p",
                    "--output-format",
                    "text",
                    "--mcp-config",
                    mcp_setup.get("claude_config_path", CLAUDE_MCP_CONFIG_FILE),
                    "--strict-mcp-config",
                    "--allow-dangerously-skip-permissions",
                    "--permission-mode",
                    "bypassPermissions",
                ]
                if candidate:
                    cmd.extend(["--model", candidate])
                cmd.append(prompt)
                attempts.append(
                    {
                        "name": f"claude -p{model_suffix}",
                        "cmd": cmd,
                        "unset_env": ["CLAUDECODE"],
                        "timeout": self.attempt_timeout_seconds(provider, candidate, mode, "primary"),
                        "cwd": DIR,
                        "provider": "claude",
                        "model": candidate or "",
                    }
                )
            return attempts

        if provider == "codex":
            codex_models = model_candidates
            codex_mcp_command = str(mcp_command or "zotero-mcp").replace("\\", "\\\\").replace('"', '\\"')
            codex_mcp_overrides = [
                "-c",
                f'mcp_servers.zotero-mcp.command="{codex_mcp_command}"',
                "-c",
                "mcp_servers.zotero-mcp.args=[]",
            ]
            for candidate in codex_models:
                model_args = ["-m", candidate] if candidate else []
                model_suffix = f" -m {candidate}" if candidate else " (default model)"
                attempts.append(
                    {
                        "name": f"codex exec (fast){model_suffix}",
                        "cmd": [
                            codex_bin,
                            "exec",
                            "--full-auto",
                            "--skip-git-repo-check",
                            "-C",
                            DIR,
                            "-c",
                            'model_reasoning_effort="medium"',
                        ]
                        + codex_mcp_overrides
                        + model_args
                        + [prompt],
                        "timeout": self.attempt_timeout_seconds(provider, candidate, mode, "primary"),
                        "cwd": DIR,
                        "provider": "codex",
                        "model": candidate or "",
                    }
                )
                if self.use_secondary_attempt_variant(provider, mode):
                    attempts.append(
                        {
                            "name": f"codex exec (fallback low-effort){model_suffix}",
                            "cmd": [
                                codex_bin,
                                "exec",
                                "--full-auto",
                                "--skip-git-repo-check",
                                "-C",
                                DIR,
                                "-c",
                                'model_reasoning_effort="low"',
                            ]
                            + codex_mcp_overrides
                            + model_args
                            + [prompt],
                            "timeout": self.attempt_timeout_seconds(provider, candidate, mode, "secondary"),
                            "cwd": DIR,
                            "provider": "codex",
                            "model": candidate or "",
                        }
                    )
            return attempts

        # gemini
        for candidate in model_candidates:
            model_args = ["--model", candidate] if candidate else []
            model_suffix = f" --model {candidate}" if candidate else " (default model)"
            attempts.append(
                {
                    "name": f"gemini -p + zotero-mcp{model_suffix}",
                    "cmd": [
                        gemini_bin,
                        "-p",
                        prompt,
                        "--output-format",
                        "text",
                        "--approval-mode",
                        "yolo",
                        "--allowed-mcp-server-names",
                        "zotero-mcp",
                    ]
                    + model_args,
                    "timeout": self.attempt_timeout_seconds(provider, candidate, mode, "primary"),
                    "cwd": DIR,
                    "set_env": {
                        "NO_BROWSER": "1",
                    },
                    "provider": "gemini",
                    "model": candidate or "",
                }
            )
            if self.use_secondary_attempt_variant(provider, mode):
                attempts.append(
                    {
                        "name": f"gemini --prompt + zotero-mcp{model_suffix}",
                        "cmd": [
                            gemini_bin,
                            "--prompt",
                            prompt,
                            "--output-format",
                            "text",
                            "--approval-mode",
                            "yolo",
                            "--allowed-mcp-server-names",
                            "zotero-mcp",
                        ]
                        + model_args,
                        "timeout": self.attempt_timeout_seconds(provider, candidate, mode, "secondary"),
                        "cwd": DIR,
                        "set_env": {
                            "NO_BROWSER": "1",
                        },
                        "provider": "gemini",
                        "model": candidate or "",
                    }
                )
        return attempts

    def execute_cli_attempts(self, attempts):
        errors = []
        for attempt in attempts:
            env = os.environ.copy()
            for k in attempt.get("unset_env", []):
                env.pop(k, None)
            for k, v in (attempt.get("set_env", {}) or {}).items():
                env[str(k)] = str(v)

            provider = self.normalize_provider(attempt.get("provider", "claude"))
            started_at = time.time()

            try:
                result = subprocess.run(
                    attempt["cmd"],
                    capture_output=True,
                    text=True,
                    timeout=attempt.get("timeout", 120),
                    cwd=attempt.get("cwd", DIR),
                    env=env
                )
            except FileNotFoundError:
                errors.append(f"{attempt['name']}: CLI bulunamadı")
                self.update_provider_health(provider, "down", "CLI not found")
                self.provider_circuit_open(provider, "unavailable", "CLI not found")
                continue
            except subprocess.TimeoutExpired:
                timeout_s = attempt.get("timeout", 120)
                msg = f"{attempt['name']}: zaman aşımı ({timeout_s}s)"
                errors.append(msg)
                self.update_provider_health(provider, "degraded", msg, int((time.time() - started_at) * 1000))
                self.provider_circuit_open(provider, "timeout", msg)
                continue

            out = (result.stdout or "").strip()
            err = (result.stderr or "").strip()
            if result.returncode == 0:
                if out:
                    self.update_provider_health(provider, "ok", "", int((time.time() - started_at) * 1000))
                    return out, errors
                if err:
                    # Some CLIs print normal output to stderr even on success.
                    self.update_provider_health(provider, "ok", "", int((time.time() - started_at) * 1000))
                    return err, errors
                self.update_provider_health(provider, "ok", "", int((time.time() - started_at) * 1000))
                return "Yanıt boş geldi.", errors

            raw_msg = err or out or f"exit code {result.returncode}"
            lines = [ln.strip() for ln in raw_msg.splitlines() if ln.strip()]
            if lines:
                preferred = next(
                    (
                        ln for ln in lines
                        if any(token in ln.lower() for token in ["error", "failed", "hata", "timeout", "quota"])
                    ),
                    lines[0],
                )
            else:
                preferred = f"exit code {result.returncode}"

            msg = " ".join(preferred.split())
            if len(msg) > 320:
                msg = msg[:320] + "..."
            errors.append(f"{attempt['name']}: {msg}")
            self.update_provider_health(provider, "degraded", msg, int((time.time() - started_at) * 1000))
            self.provider_circuit_open(provider, self.provider_failure_category(msg), msg)
            if self.is_rate_limit_error(msg):
                # Short exponential-ish pause to give quota/backoff errors a chance to recover.
                wait_s = max(2, min(8, 2 + len(errors)))
                time.sleep(wait_s)

        return None, errors

    def execute_single_attempt_stream(self, attempt, on_chunk=None):
        env = os.environ.copy()
        for k in attempt.get("unset_env", []):
            env.pop(k, None)
        for k, v in (attempt.get("set_env", {}) or {}).items():
            env[str(k)] = str(v)

        provider = self.normalize_provider(attempt.get("provider", "claude"))
        started_at = time.time()
        timeout_s = attempt.get("timeout", 120)
        prefer_pty = self.attempt_prefers_pty(attempt)

        if prefer_pty and os.name == "posix" and pty is not None:
            master_fd = None
            proc = None
            merged_parts = []
            decoder = codecs.getincrementaldecoder("utf-8")("replace")
            timed_out = False
            try:
                master_fd, slave_fd = pty.openpty()
                try:
                    proc = subprocess.Popen(
                        attempt["cmd"],
                        stdin=subprocess.DEVNULL,
                        stdout=slave_fd,
                        stderr=slave_fd,
                        cwd=attempt.get("cwd", DIR),
                        env=env,
                    )
                finally:
                    os.close(slave_fd)
            except FileNotFoundError:
                msg = f"{attempt['name']}: CLI bulunamadı"
                self.update_provider_health(provider, "down", "CLI not found")
                self.provider_circuit_open(provider, "unavailable", "CLI not found")
                if master_fd is not None:
                    try:
                        os.close(master_fd)
                    except OSError:
                        pass
                return None, msg
            except Exception:
                # PTY path failed unexpectedly; continue with pipe-based fallback below.
                if master_fd is not None:
                    try:
                        os.close(master_fd)
                    except OSError:
                        pass
                proc = None

            if proc is not None and master_fd is not None:
                deadline = time.time() + timeout_s
                while True:
                    if proc.poll() is not None:
                        break
                    now = time.time()
                    if now > deadline:
                        timed_out = True
                        proc.kill()
                        break
                    wait_for = min(0.2, max(0.02, deadline - now))
                    try:
                        ready, _, _ = select.select([master_fd], [], [], wait_for)
                    except Exception:
                        ready = []
                    if not ready:
                        continue
                    try:
                        data = os.read(master_fd, 4096)
                    except OSError:
                        break
                    if not data:
                        continue
                    piece = decoder.decode(data)
                    if piece:
                        merged_parts.append(piece)
                        if on_chunk:
                            on_chunk(piece)

                # Drain remaining bytes quickly after process exit/kill.
                for _ in range(4):
                    try:
                        ready, _, _ = select.select([master_fd], [], [], 0)
                    except Exception:
                        ready = []
                    if not ready:
                        break
                    try:
                        data = os.read(master_fd, 4096)
                    except OSError:
                        break
                    if not data:
                        break
                    piece = decoder.decode(data)
                    if piece:
                        merged_parts.append(piece)
                        if on_chunk:
                            on_chunk(piece)

                tail = decoder.decode(b"", final=True)
                if tail:
                    merged_parts.append(tail)
                    if on_chunk:
                        on_chunk(tail)

                try:
                    os.close(master_fd)
                except OSError:
                    pass

                try:
                    return_code = proc.wait(timeout=1)
                except Exception:
                    return_code = proc.poll()

                merged = "".join(merged_parts).strip()
                latency_ms = int((time.time() - started_at) * 1000)

                if timed_out:
                    msg = f"{attempt['name']}: zaman aşımı ({timeout_s}s)"
                    self.update_provider_health(provider, "degraded", msg, latency_ms)
                    self.provider_circuit_open(provider, "timeout", msg)
                    return None, msg

                if return_code == 0:
                    self.update_provider_health(provider, "ok", "", latency_ms)
                    if merged:
                        return merged, None
                    return "Yanıt boş geldi.", None

                raw_msg = merged or f"exit code {return_code}"
                lines = [ln.strip() for ln in raw_msg.splitlines() if ln.strip()]
                preferred = lines[0] if lines else f"exit code {return_code}"
                msg = " ".join(preferred.split())
                if len(msg) > 320:
                    msg = msg[:320] + "..."
                final_msg = f"{attempt['name']}: {msg}"
                self.update_provider_health(provider, "degraded", final_msg, latency_ms)
                self.provider_circuit_open(provider, self.provider_failure_category(final_msg), final_msg)
                return None, final_msg

        q = queue.Queue()
        stdout_parts = []
        stderr_parts = []

        try:
            proc = subprocess.Popen(
                attempt["cmd"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                cwd=attempt.get("cwd", DIR),
                env=env,
            )
        except FileNotFoundError:
            msg = f"{attempt['name']}: CLI bulunamadı"
            self.update_provider_health(provider, "down", "CLI not found")
            self.provider_circuit_open(provider, "unavailable", "CLI not found")
            return None, msg

        def reader(pipe, source):
            try:
                while True:
                    chunk = pipe.read(256)
                    if not chunk:
                        break
                    q.put((source, chunk))
            finally:
                q.put((source, None))

        threads = []
        for source, pipe in (("stdout", proc.stdout), ("stderr", proc.stderr)):
            t = threading.Thread(target=reader, args=(pipe, source), daemon=True)
            t.start()
            threads.append(t)

        finished_pipes = set()
        timed_out = False
        deadline = time.time() + timeout_s

        while len(finished_pipes) < 2:
            if time.time() > deadline and proc.poll() is None:
                timed_out = True
                proc.kill()
                break
            try:
                source, chunk = q.get(timeout=0.1)
            except queue.Empty:
                continue
            if chunk is None:
                finished_pipes.add(source)
                continue
            if source == "stdout":
                stdout_parts.append(chunk)
                if on_chunk:
                    on_chunk(chunk)
            else:
                stderr_parts.append(chunk)
                if on_chunk:
                    on_chunk(chunk)

        for t in threads:
            t.join(timeout=0.2)

        return_code = proc.poll()
        out = "".join(stdout_parts).strip()
        err = "".join(stderr_parts).strip()
        latency_ms = int((time.time() - started_at) * 1000)

        if timed_out:
            msg = f"{attempt['name']}: zaman aşımı ({timeout_s}s)"
            self.update_provider_health(provider, "degraded", msg, latency_ms)
            self.provider_circuit_open(provider, "timeout", msg)
            return None, msg

        if return_code == 0:
            self.update_provider_health(provider, "ok", "", latency_ms)
            if out:
                return out, None
            if err:
                return err, None
            return "Yanıt boş geldi.", None

        raw_msg = err or out or f"exit code {return_code}"
        lines = [ln.strip() for ln in raw_msg.splitlines() if ln.strip()]
        preferred = lines[0] if lines else f"exit code {return_code}"
        msg = " ".join(preferred.split())
        if len(msg) > 320:
            msg = msg[:320] + "..."
        final_msg = f"{attempt['name']}: {msg}"
        self.update_provider_health(provider, "degraded", final_msg, latency_ms)
        self.provider_circuit_open(provider, self.provider_failure_category(final_msg), final_msg)
        return None, final_msg

    def execute_cli_attempts_stream(self, attempts, on_chunk=None, on_event=None):
        errors = []
        for idx, attempt in enumerate(attempts):
            if on_event:
                on_event(
                    {
                        "type": "meta",
                        "phase": "attempt_start",
                        "attempt": attempt.get("name", f"attempt-{idx + 1}"),
                        "provider": self.normalize_provider(attempt.get("provider", "claude")),
                    }
                )
            if idx > 0 and on_event:
                on_event({"type": "reset", "reason": "retry"})

            response, error = self.execute_single_attempt_stream(attempt, on_chunk=on_chunk)
            if response:
                return response, errors
            if error:
                errors.append(error)
                if self.is_rate_limit_error(error):
                    wait_s = max(2, min(8, 2 + len(errors)))
                    if on_event:
                        on_event({"type": "meta", "phase": "backoff", "seconds": wait_s})
                    time.sleep(wait_s)
        return None, errors

    def execute_with_provider_fallback(self, prompt, requested_provider, requested_model, analysis_mode="balanced", stream=False, on_chunk=None, on_event=None):
        requested = self.normalize_provider(requested_provider)
        providers = self.provider_fallback_chain_available(requested)
        all_errors = []
        for provider_idx, provider in enumerate(providers):
            circuit_state = self.provider_circuit_state(provider)
            if circuit_state["open"]:
                skip_msg = f"circuit açık ({circuit_state['cooldownSec']}s): {circuit_state.get('reason') or provider}"
                all_errors.append(f"{provider}: {skip_msg}")
                if on_event:
                    on_event(
                        {
                            "type": "meta",
                            "phase": "provider_skipped",
                            "provider": provider,
                            "reason": "circuit_open",
                            "cooldownSec": circuit_state["cooldownSec"],
                        }
                    )
                continue

            model = requested_model if provider_idx == 0 else ""
            attempts = self.get_cli_attempts(provider, prompt, model, analysis_mode=analysis_mode)
            if on_event:
                on_event(
                    {
                        "type": "meta",
                        "phase": "provider_start",
                        "provider": provider,
                        "fallbackIndex": provider_idx,
                    }
                )
                if provider_idx > 0:
                    on_event({"type": "reset", "reason": "provider_fallback", "provider": provider})

            if stream:
                response, errors = self.execute_cli_attempts_stream(attempts, on_chunk=on_chunk, on_event=on_event)
            else:
                response, errors = self.execute_cli_attempts(attempts)

            if response:
                return {
                    "text": response,
                    "providerUsed": provider,
                    "fallbackUsed": (provider_idx > 0) or (provider != requested),
                    "errors": all_errors,
                }

            all_errors.extend([f"{provider}: {err}" for err in errors])

        return {
            "text": None,
            "providerUsed": requested,
            "fallbackUsed": True,
            "errors": all_errors,
        }

    def apply_language_post_check(self, text, requested_provider, requested_model, target_language, analysis_mode="balanced"):
        output = str(text or "")
        target = self.normalize_output_language(target_language)
        if not output or not target:
            return output, False, []
        if self.is_language_compliant(output, target):
            return output, False, []

        rewrite_prompt = self.language_rewrite_prompt(output, target)
        if not rewrite_prompt:
            return output, False, []

        rewrite_result = self.execute_with_provider_fallback(
            rewrite_prompt,
            requested_provider,
            requested_model,
            analysis_mode=analysis_mode,
            stream=False,
        )
        rewritten = self.sanitize_provider_output(
            rewrite_result.get("text"),
            rewrite_result.get("providerUsed", requested_provider),
        )
        if rewritten and self.is_language_compliant(rewritten, target):
            return rewritten, True, rewrite_result.get("errors", [])

        rewrite_errors = list(rewrite_result.get("errors", []) or [])
        if target == "tr":
            fallback_source = rewritten or output
            strict_prompt = (
                "Aşağıdaki metni doğal ve akıcı Türkçe ile SON KEZ düzelt. "
                "Anlamı koru, bilgi ekleme/çıkarma yapma. "
                "Türkçe dilbilgisi ve noktalamaya tam uy. "
                "Türkçe karakterleri doğru kullan (ç, ğ, ı, İ, ö, ş, ü). "
                "Süreç anlatımı yazma (ör. 'Yeterli içerik elde ettim', 'Çıktıyı şimdi üretiyorum').\n\n"
                f"Metin:\n{fallback_source}"
            )
            second_result = self.execute_with_provider_fallback(
                strict_prompt,
                requested_provider,
                requested_model,
                analysis_mode=analysis_mode,
                stream=False,
            )
            second_rewritten = self.sanitize_provider_output(
                second_result.get("text"),
                second_result.get("providerUsed", requested_provider),
            )
            if second_rewritten and self.is_language_compliant(second_rewritten, target):
                combined_errors = rewrite_errors + list(second_result.get("errors", []) or [])
                return second_rewritten, True, combined_errors
            rewrite_errors = rewrite_errors + list(second_result.get("errors", []) or [])

        return output, False, rewrite_errors

    def run_claude(self):
        """Run selected AI CLI with the user's prompt."""
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        try:
            req_data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json(400, {"error": "Geçersiz JSON"})
            return

        prompt = req_data.get("prompt", "")
        provider = self.normalize_provider(req_data.get("provider", "claude"))
        model = str(req_data.get("model", "")).strip()
        analysis_mode = self.normalize_analysis_mode(req_data.get("analysisMode", "balanced"))
        output_language = self.normalize_output_language(req_data.get("language", ""))
        pipeline_requested = self.is_big_pdf_pipeline_requested(req_data)

        if not prompt:
            self.send_json(400, {"error": "No prompt provided"})
            return

        cache_key = self.build_ai_response_cache_key(req_data, prompt, provider, model, analysis_mode)
        cached = self.get_cached_ai_response(cache_key)
        if cached:
            ttl_left = max(0, int(float(cached.get("expires_at", 0)) - time.time()))
            self.send_json(
                200,
                {
                    "text": cached.get("text", ""),
                    "provider": provider,
                    "providerUsed": cached.get("providerUsed", provider),
                    "fallbackUsed": bool(cached.get("fallbackUsed", False)),
                    "languageAdjusted": bool(cached.get("languageAdjusted", False)),
                    "pipelineUsed": bool(cached.get("pipelineUsed", False)),
                    "pipelineTemplate": cached.get("pipelineTemplate", ""),
                    "pipelineChunkMode": cached.get("pipelineChunkMode", ""),
                    "pipelineFinalMode": cached.get("pipelineFinalMode", ""),
                    "externalSearchUsed": bool(cached.get("externalSearchUsed", False)),
                    "externalSearchQuery": str(cached.get("externalSearchQuery", "")),
                    "externalSearchCount": int(cached.get("externalSearchCount", 0)),
                    "externalSearchTopics": list(cached.get("externalSearchTopics", []) or []),
                    "cached": True,
                    "cacheTtlSec": ttl_left,
                    "deduped": False,
                },
            )
            return

        inflight_key = f"ai:{cache_key}"
        is_leader, inflight_entry = self.inflight_acquire(inflight_key)
        if not is_leader:
            waited = self.inflight_wait_for_result(inflight_entry)
            if not waited:
                self.send_json(
                    504,
                    {
                        "error": "Aynı istek için bekleme zaman aşımına uğradı.",
                        "provider": provider,
                        "code": "INFLIGHT_TIMEOUT",
                    },
                )
                return
            payload = dict(waited.get("payload", {}))
            payload["deduped"] = True
            self.send_json(int(waited.get("status", 500)), payload)
            return

        status = 500
        payload = {"error": "Bilinmeyen hata", "provider": provider}
        try:
            effective_prompt = self.apply_template_rule_from_request(prompt, req_data, output_language)
            if not pipeline_requested:
                effective_prompt = self.apply_source_routing_rule_from_request(effective_prompt, req_data, output_language)
            else:
                effective_prompt = self.strip_prompt_directive_block(
                    effective_prompt,
                    ["EXTERNAL SOURCE ROUTING:", "DIŞ KAYNAK YÖNLENDİRME:"],
                )
            external_search_meta = {
                "used": False,
                "query": "",
                "count": 0,
                "topics": [],
            }
            if self.normalize_source_routing_mode(req_data) and not pipeline_requested:
                try:
                    external_search_meta = self.build_external_search_context(req_data, effective_prompt, output_language)
                    external_context = str(external_search_meta.get("context") or "").strip()
                    if external_context:
                        effective_prompt = f"{effective_prompt}\n\n{external_context}"
                except Exception as e:
                    external_search_meta = {
                        "used": False,
                        "query": self.normalize_external_search_query(req_data, effective_prompt),
                        "count": 0,
                        "topics": [],
                        "error": str(e)[:200],
                    }
            effective_prompt = self.apply_output_quality_rule(
                effective_prompt,
                output_language,
                require_verified_sources=self.normalize_source_routing_mode(req_data),
            )

            if not pipeline_requested:
                run_result = self.execute_with_provider_fallback(
                    effective_prompt,
                    provider,
                    model,
                    analysis_mode=analysis_mode,
                    stream=False,
                )
            else:
                try:
                    run_result = self.execute_big_pdf_pipeline(
                        req_data,
                        fallback_prompt=prompt,
                        provider=provider,
                        model=model,
                        analysis_mode=analysis_mode,
                        output_language=output_language,
                    )
                except ValueError as e:
                    if not self.should_fallback_from_pipeline_error(e):
                        raise
                    run_result = self.execute_with_provider_fallback(
                        effective_prompt,
                        provider,
                        model,
                        analysis_mode=analysis_mode,
                        stream=False,
                    )
                    run_result["pipelineUsed"] = False
                    existing_errors = list(run_result.get("errors", []) or [])
                    existing_errors.append(f"pipeline-fallback: {str(e)}")
                    run_result["errors"] = existing_errors
            response_text = run_result.get("text")
            errors = run_result.get("errors", [])
            provider_used = self.normalize_provider(run_result.get("providerUsed", provider))
            fallback_used = bool(run_result.get("fallbackUsed", False))
            pipeline_used = bool(run_result.get("pipelineUsed", False))
            response_text = self.sanitize_provider_output(response_text, provider_used)

            if not response_text:
                if errors and all(self.is_rate_limit_error(e) for e in errors):
                    status = 429
                elif errors and all(("zaman aşımı" in e.lower() or "timeout" in e.lower()) for e in errors):
                    status = 504
                elif errors and all("circuit açık" in e.lower() for e in errors):
                    status = 503
                detail = "; ".join(errors[:6]) if errors else "Bilinmeyen hata"
                payload = {
                    "error": f"{provider} CLI çalıştırılamadı. {detail}",
                    "provider": provider,
                    "providerUsed": provider_used,
                    "fallbackUsed": fallback_used,
                    "pipelineUsed": pipeline_used,
                    "externalSearchUsed": bool(external_search_meta.get("used", False)),
                    "externalSearchQuery": str(external_search_meta.get("query", "")),
                    "externalSearchCount": int(external_search_meta.get("count", 0)),
                    "externalSearchTopics": list(external_search_meta.get("topics", []) or []),
                }
                if status == 429:
                    payload["code"] = "RATE_LIMIT"
                    payload["suggestedModel"] = self.default_model_for_provider(provider)
                    payload["suggestion"] = (
                        "429 (rate limit/quota) alındı. Modeli daha hafif bir seçeneğe çekin veya birkaç dakika sonra tekrar deneyin."
                    )
                elif status == 504 and provider == "codex":
                    payload["code"] = "TIMEOUT"
                    payload["suggestedModel"] = self.default_model_for_provider(provider)
                    payload["suggestion"] = (
                        "Codex zaman aşımına uğradı. Varsayılan olarak daha hızlı profil denendi; modeli gpt-5-codex seçip tekrar deneyin."
                    )
                elif status == 503:
                    payload["code"] = "CIRCUIT_OPEN"
                    payload["suggestion"] = (
                        "Sağlayıcılar kısa süreli bekleme modunda. 2-5 dakika sonra tekrar deneyin."
                    )
                self.inflight_complete(inflight_key, inflight_entry, status, payload)
                self.send_json(status, payload)
                return

            adjusted_text, language_adjusted, language_errors = self.apply_language_post_check(
                response_text,
                provider_used,
                model if provider_used == provider else "",
                output_language,
                analysis_mode=analysis_mode,
            )
            response_text = adjusted_text
            if language_errors:
                errors = errors + [f"language-fix: {err}" for err in language_errors[:2]]

            if response_text and response_text != "Yanıt boş geldi.":
                self.set_cached_ai_response(
                    cache_key,
                    {
                        "text": response_text,
                        "provider": provider,
                        "providerUsed": provider_used,
                        "fallbackUsed": fallback_used,
                        "languageAdjusted": language_adjusted,
                        "pipelineUsed": pipeline_used,
                        "pipelineTemplate": run_result.get("pipelineTemplate", ""),
                        "pipelineChunkMode": run_result.get("pipelineChunkMode", ""),
                        "pipelineFinalMode": run_result.get("pipelineFinalMode", ""),
                        "externalSearchUsed": bool(external_search_meta.get("used", False)),
                        "externalSearchQuery": str(external_search_meta.get("query", "")),
                        "externalSearchCount": int(external_search_meta.get("count", 0)),
                        "externalSearchTopics": list(external_search_meta.get("topics", []) or []),
                    },
                    self.ai_response_cache_ttl_seconds(analysis_mode),
                )

            status = 200
            payload = {
                "text": response_text,
                "provider": provider,
                "providerUsed": provider_used,
                "fallbackUsed": fallback_used,
                "languageAdjusted": language_adjusted,
                "pipelineUsed": pipeline_used,
                "pipelineTemplate": run_result.get("pipelineTemplate", ""),
                "pipelineChunkMode": run_result.get("pipelineChunkMode", ""),
                "pipelineFinalMode": run_result.get("pipelineFinalMode", ""),
                "externalSearchUsed": bool(external_search_meta.get("used", False)),
                "externalSearchQuery": str(external_search_meta.get("query", "")),
                "externalSearchCount": int(external_search_meta.get("count", 0)),
                "externalSearchTopics": list(external_search_meta.get("topics", []) or []),
                "cached": False,
                "deduped": False,
            }
            self.inflight_complete(inflight_key, inflight_entry, status, payload)
            self.send_json(status, payload)
        except Exception as e:
            status = 500
            payload = {"error": str(e), "provider": provider}
            self.inflight_complete(inflight_key, inflight_entry, status, payload)
            self.send_json(status, payload)

    def run_claude_stream(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        try:
            req_data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json(400, {"error": "Geçersiz JSON"})
            return

        prompt = req_data.get("prompt", "")
        provider = self.normalize_provider(req_data.get("provider", "claude"))
        model = str(req_data.get("model", "")).strip()
        analysis_mode = self.normalize_analysis_mode(req_data.get("analysisMode", "balanced"))
        output_language = self.normalize_output_language(req_data.get("language", ""))
        pipeline_requested = self.is_big_pdf_pipeline_requested(req_data)

        if not prompt:
            self.send_json(400, {"error": "No prompt provided"})
            return

        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache, no-transform')
        self.send_header('Connection', 'close')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

        stream_open = True

        def emit(payload):
            nonlocal stream_open
            if not stream_open:
                return False
            try:
                self.stream_write_jsonl(payload)
                return True
            except (BrokenPipeError, ConnectionResetError):
                stream_open = False
                return False
            except Exception:
                stream_open = False
                return False

        emit(
            {
                "type": "meta",
                "phase": "start",
                "provider": provider,
                "fallbackChain": self.provider_fallback_chain_available(provider),
            }
        )

        cache_key = self.build_ai_response_cache_key(req_data, prompt, provider, model, analysis_mode)
        cached = self.get_cached_ai_response(cache_key)
        if cached:
            text = cached.get("text", "")
            ttl_left = max(0, int(float(cached.get("expires_at", 0)) - time.time()))
            for chunk in self.chunk_text_for_stream(text):
                if not emit({"type": "chunk", "text": chunk}):
                    return
            emit(
                {
                    "type": "done",
                    "text": text,
                    "provider": provider,
                    "providerUsed": cached.get("providerUsed", provider),
                    "fallbackUsed": bool(cached.get("fallbackUsed", False)),
                    "languageAdjusted": bool(cached.get("languageAdjusted", False)),
                    "pipelineUsed": bool(cached.get("pipelineUsed", False)),
                    "pipelineTemplate": cached.get("pipelineTemplate", ""),
                    "pipelineChunkMode": cached.get("pipelineChunkMode", ""),
                    "pipelineFinalMode": cached.get("pipelineFinalMode", ""),
                    "externalSearchUsed": bool(cached.get("externalSearchUsed", False)),
                    "externalSearchQuery": str(cached.get("externalSearchQuery", "")),
                    "externalSearchCount": int(cached.get("externalSearchCount", 0)),
                    "externalSearchTopics": list(cached.get("externalSearchTopics", []) or []),
                    "cached": True,
                    "cacheTtlSec": ttl_left,
                    "deduped": False,
                }
            )
            return

        inflight_key = f"ai:{cache_key}"
        is_leader, inflight_entry = self.inflight_acquire(inflight_key)
        if not is_leader:
            waited = self.inflight_wait_for_result(inflight_entry)
            if not waited:
                emit(
                    {
                        "type": "error",
                        "error": "Aynı istek için bekleme zaman aşımına uğradı.",
                        "provider": provider,
                        "code": "INFLIGHT_TIMEOUT",
                    }
                )
                emit({"type": "done", "error": True})
                return
            status_code = int(waited.get("status", 500))
            payload = dict(waited.get("payload", {}))
            if status_code >= 400 or payload.get("error"):
                error_payload = dict(payload)
                error_payload["type"] = "error"
                error_payload["deduped"] = True
                emit(error_payload)
                emit({"type": "done", "error": True, "deduped": True})
                return
            text = payload.get("text", "")
            if text:
                for chunk in self.chunk_text_for_stream(text):
                    if not emit({"type": "chunk", "text": chunk}):
                        return
            payload["type"] = "done"
            payload["deduped"] = True
            emit(payload)
            return

        status = 500
        payload = {"error": "Bilinmeyen hata", "provider": provider}
        stream_chunks = []
        stream_provider = {"name": provider}
        stream_filter_state = {"buffer": "", "direct_mode": False}
        effective_prompt = self.apply_template_rule_from_request(prompt, req_data, output_language)
        if not pipeline_requested:
            effective_prompt = self.apply_source_routing_rule_from_request(effective_prompt, req_data, output_language)
        else:
            effective_prompt = self.strip_prompt_directive_block(
                effective_prompt,
                ["EXTERNAL SOURCE ROUTING:", "DIŞ KAYNAK YÖNLENDİRME:"],
            )
        external_search_meta = {
            "used": False,
            "query": "",
            "count": 0,
            "topics": [],
        }

        def on_chunk(chunk):
            content = str(chunk or "")
            if not content:
                return
            provider_for_chunk = stream_provider.get("name", provider)
            filtered = self.stream_noise_filter_push(content, provider_for_chunk, stream_filter_state)
            if not filtered:
                return
            stream_chunks.append(filtered)
            emit({"type": "chunk", "text": filtered})

        def on_event(event_payload):
            phase = str((event_payload or {}).get("phase", "")).strip().lower()
            if phase == "provider_start":
                stream_provider["name"] = self.normalize_provider((event_payload or {}).get("provider", provider))
                stream_filter_state["buffer"] = ""
                stream_filter_state["direct_mode"] = False
            if str((event_payload or {}).get("type", "")).strip().lower() == "reset":
                stream_chunks.clear()
                stream_filter_state["buffer"] = ""
                stream_filter_state["direct_mode"] = False
            emit(event_payload)

        try:
            if self.normalize_source_routing_mode(req_data) and not pipeline_requested:
                try:
                    external_search_meta = self.build_external_search_context(
                        req_data,
                        effective_prompt,
                        output_language,
                        on_event=on_event,
                    )
                    external_context = str(external_search_meta.get("context") or "").strip()
                    if external_context:
                        effective_prompt = f"{effective_prompt}\n\n{external_context}"
                except Exception as e:
                    external_search_meta = {
                        "used": False,
                        "query": self.normalize_external_search_query(req_data, effective_prompt),
                        "count": 0,
                        "topics": [],
                        "error": str(e)[:200],
                    }
            effective_prompt = self.apply_output_quality_rule(
                effective_prompt,
                output_language,
                require_verified_sources=self.normalize_source_routing_mode(req_data),
            )

            if not pipeline_requested:
                run_result = self.execute_with_provider_fallback(
                    effective_prompt,
                    provider,
                    model,
                    analysis_mode=analysis_mode,
                    stream=True,
                    on_chunk=on_chunk,
                    on_event=on_event,
                )
            else:
                try:
                    run_result = self.execute_big_pdf_pipeline(
                        req_data,
                        fallback_prompt=prompt,
                        provider=provider,
                        model=model,
                        analysis_mode=analysis_mode,
                        output_language=output_language,
                        on_event=on_event,
                    )
                except ValueError as e:
                    if not self.should_fallback_from_pipeline_error(e):
                        raise
                    on_event(
                        {
                            "type": "meta",
                            "phase": "pipeline_fallback",
                            "message": str(e),
                        }
                    )
                    run_result = self.execute_with_provider_fallback(
                        effective_prompt,
                        provider,
                        model,
                        analysis_mode=analysis_mode,
                        stream=True,
                        on_chunk=on_chunk,
                        on_event=on_event,
                    )
                    run_result["pipelineUsed"] = False
                    existing_errors = list(run_result.get("errors", []) or [])
                    existing_errors.append(f"pipeline-fallback: {str(e)}")
                    run_result["errors"] = existing_errors
            tail = self.stream_noise_filter_flush(stream_provider.get("name", provider), stream_filter_state)
            if tail:
                stream_chunks.append(tail)
                emit({"type": "chunk", "text": tail})
            raw_response_text = run_result.get("text") or "".join(stream_chunks).strip()
            errors = run_result.get("errors", [])
            provider_used = self.normalize_provider(run_result.get("providerUsed", provider))
            fallback_used = bool(run_result.get("fallbackUsed", False))
            pipeline_used = bool(run_result.get("pipelineUsed", False))
            response_text = self.sanitize_provider_output(raw_response_text, provider_used)
            if response_text and response_text != raw_response_text:
                emit({"type": "replace", "text": response_text})

            if not response_text:
                if errors and all(self.is_rate_limit_error(e) for e in errors):
                    status = 429
                elif errors and all(("zaman aşımı" in e.lower() or "timeout" in e.lower()) for e in errors):
                    status = 504
                elif errors and all("circuit açık" in e.lower() for e in errors):
                    status = 503
                detail = "; ".join(errors[:6]) if errors else "Bilinmeyen hata"
                payload = {
                    "error": f"{provider} CLI çalıştırılamadı. {detail}",
                    "provider": provider,
                    "providerUsed": provider_used,
                    "fallbackUsed": fallback_used,
                    "pipelineUsed": pipeline_used,
                    "externalSearchUsed": bool(external_search_meta.get("used", False)),
                    "externalSearchQuery": str(external_search_meta.get("query", "")),
                    "externalSearchCount": int(external_search_meta.get("count", 0)),
                    "externalSearchTopics": list(external_search_meta.get("topics", []) or []),
                }
                if status == 429:
                    payload["code"] = "RATE_LIMIT"
                elif status == 504:
                    payload["code"] = "TIMEOUT"
                elif status == 503:
                    payload["code"] = "CIRCUIT_OPEN"
                self.inflight_complete(inflight_key, inflight_entry, status, payload)
                emit({"type": "error", **payload})
                emit({"type": "done", "error": True})
                return

            adjusted_text, language_adjusted, language_errors = self.apply_language_post_check(
                response_text,
                provider_used,
                model if provider_used == provider else "",
                output_language,
                analysis_mode=analysis_mode,
            )
            response_text = adjusted_text
            if language_errors:
                errors = errors + [f"language-fix: {err}" for err in language_errors[:2]]
            if language_adjusted:
                emit({"type": "replace", "text": response_text})

            if response_text and response_text != "Yanıt boş geldi.":
                self.set_cached_ai_response(
                    cache_key,
                    {
                        "text": response_text,
                        "provider": provider,
                        "providerUsed": provider_used,
                        "fallbackUsed": fallback_used,
                        "languageAdjusted": language_adjusted,
                        "pipelineUsed": pipeline_used,
                        "pipelineTemplate": run_result.get("pipelineTemplate", ""),
                        "pipelineChunkMode": run_result.get("pipelineChunkMode", ""),
                        "pipelineFinalMode": run_result.get("pipelineFinalMode", ""),
                        "externalSearchUsed": bool(external_search_meta.get("used", False)),
                        "externalSearchQuery": str(external_search_meta.get("query", "")),
                        "externalSearchCount": int(external_search_meta.get("count", 0)),
                        "externalSearchTopics": list(external_search_meta.get("topics", []) or []),
                    },
                    self.ai_response_cache_ttl_seconds(analysis_mode),
                )

            status = 200
            payload = {
                "text": response_text,
                "provider": provider,
                "providerUsed": provider_used,
                "fallbackUsed": fallback_used,
                "languageAdjusted": language_adjusted,
                "pipelineUsed": pipeline_used,
                "pipelineTemplate": run_result.get("pipelineTemplate", ""),
                "pipelineChunkMode": run_result.get("pipelineChunkMode", ""),
                "pipelineFinalMode": run_result.get("pipelineFinalMode", ""),
                "externalSearchUsed": bool(external_search_meta.get("used", False)),
                "externalSearchQuery": str(external_search_meta.get("query", "")),
                "externalSearchCount": int(external_search_meta.get("count", 0)),
                "externalSearchTopics": list(external_search_meta.get("topics", []) or []),
                "cached": False,
                "deduped": False,
            }
            self.inflight_complete(inflight_key, inflight_entry, status, payload)
            emit({"type": "done", **payload})
        except Exception as e:
            payload = {"error": str(e), "provider": provider}
            self.inflight_complete(inflight_key, inflight_entry, 500, payload)
            emit({"type": "error", **payload})
            emit({"type": "done", "error": True})

    def log_message(self, format, *args):
        msg = str(args[0]) if args else ''
        if '/api/' in msg or '/pdf/' in msg:
            return
        super().log_message(format, *args)

class ThreadedHTTPServer(http.server.HTTPServer):
    """Handle each request in a separate thread so long Claude calls don't block."""
    allow_reuse_address = True
    request_queue_size = 128

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._worker_semaphore = threading.BoundedSemaphore(MAX_SERVER_WORKERS)

    def process_request(self, request, client_address):
        self._worker_semaphore.acquire()
        thread = threading.Thread(target=self._handle, args=(request, client_address))
        thread.daemon = True
        try:
            thread.start()
        except Exception:
            self._worker_semaphore.release()
            raise

    def _handle(self, request, client_address):
        try:
            self.finish_request(request, client_address)
        except Exception:
            self.handle_error(request, client_address)
        finally:
            self.shutdown_request(request)
            self._worker_semaphore.release()

if __name__ == '__main__':
    print(f"  Orhon'un Zotero Paneli / Orhon's Zotero Dashboard")
    print(f"  http://localhost:{PORT}")
    print(f"  Zotero API proxy: /api/...")
    print(f"  PDF viewer: /pdf/...")
    print(f"  AI CLIs: claude / codex / gemini")
    print(f"  Press Ctrl+C to stop\n")
    try:
        server = ThreadedHTTPServer(('', PORT), Handler)
    except OSError as e:
        print(f"Server start failed on port {PORT}: {e}")
        print("If the port is busy, close the existing process and run again.")
        raise
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()
