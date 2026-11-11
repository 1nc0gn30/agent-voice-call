"""HTTP Server & Voice Call REST Gateway.

100% Python Standard Library — Zero External Dependencies.
Serves mobile-optimized Live Call Cockpit and handles speech REST APIs on port 8114.
"""

from __future__ import annotations

import base64
import http.server
import json
import logging
import mimetypes
import os
import socketserver
import time
import urllib.parse
from pathlib import Path
from typing import Any, Dict, Optional

from .call_engine import CallManager
from .tts_bridge import VOICES, is_kokoro_online, synthesize_speech_wav


def _safe_rel(raw: str) -> str:
    """Request path -> safe relative path inside a static dir; '' (index) if it
    tries to climb out with '..' or is absolute. Raw request paths are not normalised."""
    from urllib.parse import unquote
    rel = unquote(str(raw or "")).replace("\\", "/").lstrip("/")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts) or ":" in (parts[0] if parts else ""):
        return ""
    return "/".join(parts)


def _is_local_origin(origin) -> bool:
    """Browser Origin check. No Origin header = non-browser client (CLI/agent): allowed.
    Otherwise only http(s)://localhost / 127.0.0.1 / [::1] pages may call this API, so a
    random website can't drive the local server from the user's browser (CSRF)."""
    if not origin:
        return True
    from urllib.parse import urlparse
    try:
        u = urlparse(origin)
    except ValueError:
        return False
    return u.scheme in ("http", "https") and u.hostname in ("localhost", "127.0.0.1", "::1")


def _cors_origin(handler) -> str:
    origin = handler.headers.get("Origin")
    return origin if origin and _is_local_origin(origin) else "http://127.0.0.1"


logger = logging.getLogger("agent_voice_call.server")

PUBLIC_DIR = Path(__file__).resolve().parent.parent.parent / "public"


class VoiceCallHandler(http.server.BaseHTTPRequestHandler):
    """Processes live call audio turns, token validation, and web cockpit requests."""

    server: VoiceCallServer

    def log_message(self, format: str, *args: Any) -> None:
        pass  # Quiet logs

    def do_OPTIONS(self) -> None:
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", _cors_origin(self))
        self.send_header("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # 1. Health Endpoint
        if path in ("/health", "/status", "/api/stats"):
            self._send_json({
                "status": "healthy",
                "service": "agent-voice-call",
                "port": self.server.server_port,
                "active_sessions": len([s for s in self.server.manager.sessions.values() if s.status == "ACTIVE"]),
                "kokoro_online": is_kokoro_online(),
                "available_voices": list(VOICES.keys()),
            })
            return

        # 2. Session Validation Endpoint (Auto-provisions if missing or expired)
        if path == "/api/call/session":
            token = query.get("token", [""])[0]
            session = self.server.manager.validate_token(token) if token else None
            if not session:
                # Auto-provision web session so call never fails with 401
                session_id, token = self.server.manager.create_call_token(channel="web", voice="azoth")
                session = self.server.manager.validate_token(token)
            self._send_json({
                "session_id": session.session_id,
                "token": session.token,
                "voice": session.voice,
                "channel": session.channel,
                "status": session.status,
                "turn_count": len(session.turns),
            })
            return

        # 3. Welcome / Audio Test Greeting Endpoint
        if path == "/api/call/welcome":
            voice = query.get("voice", ["azoth"])[0]
            v_info = VOICES.get(voice, VOICES["azoth"])
            v_name = v_info["label"]
            text = f"Live on the line. {v_name} is listening."
            audio_wav = synthesize_speech_wav(text, voice_name=voice)
            audio_b64 = base64.b64encode(audio_wav).decode("ascii") if audio_wav else None
            self._send_json({
                "text": text,
                "voice": voice,
                "audio_base64": audio_b64,
                "audio_mime": "audio/wav",
            })
            return

        # 3. Available Voices Directory
        if path == "/api/voices":
            self._send_json({"voices": VOICES})
            return

        # 4. Mobile Call Cockpit
        if path in ("/", "/call", "/index.html"):
            index_file = PUBLIC_DIR / "index.html"
            if index_file.exists():
                self._serve_file(index_file, "text/html; charset=utf-8")
                return

        # 5. Static Assets
        safe_path = _safe_rel(path)
        target_file = PUBLIC_DIR / safe_path
        if target_file.exists() and target_file.is_file():
            mime, _ = mimetypes.guess_type(str(target_file))
            self._serve_file(target_file, mime or "application/octet-stream")
            return

        self._send_json({"error": "not_found"}, code=404)

    def do_POST(self) -> None:
        if not _is_local_origin(self.headers.get("Origin")):
            _body = b'{"error": "cross-origin request blocked"}'
            self.send_response(403)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(_body)))
            self.end_headers()
            self.wfile.write(_body)
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        content_length = int(self.headers.get("Content-Length", 0))
        body_bytes = self.rfile.read(content_length) if content_length > 0 else b""
        payload = {}
        if body_bytes:
            try:
                payload = json.loads(body_bytes.decode("utf-8", errors="replace"))
            except Exception:
                payload = {}

        # 1. Create Call Session Token (Triggered by Signal / SimpleX / Web)
        if path == "/api/call/create":
            channel = payload.get("channel", "signal")
            voice = payload.get("voice", "azoth")
            session_id, token = self.server.manager.create_call_token(channel=channel, voice=voice)

            # Secure HTTPS URL for mobile browser microphone permissions
            tailscale_domain = os.environ.get("ZOTH_TAILSCALE_DOMAIN", "zothos.local")
            tailscale_ip = os.environ.get("ZOTH_TAILSCALE_IP", "127.0.0.1")
            call_url = f"https://{tailscale_domain}/call?token={token}"
            fallback_url = f"http://{tailscale_ip}:{self.server.server_port}/call?token={token}"

            self._send_json({
                "status": "created",
                "session_id": session_id,
                "token": token,
                "call_url": call_url,
                "fallback_url": fallback_url,
                "voice": voice,
            })
            return

        # 2. Process Spoken Utterance
        if path == "/api/call/speak":
            token = payload.get("token") or self.headers.get("X-Call-Token")
            user_text = payload.get("text", "").strip()
            requested_voice = payload.get("voice", "").strip()

            session = self.server.manager.validate_token(token) if token else None
            if not session:
                # Auto-recover session so spoken utterance is never dropped
                session_id, token = self.server.manager.create_call_token(channel="web", voice=requested_voice or "azoth")
                session = self.server.manager.validate_token(token)
            elif requested_voice and requested_voice in VOICES:
                session.voice = requested_voice

            if not user_text:
                self._send_json({"error": "text_required"}, code=400)
                return

            reply_text, audio_wav, latency_ms = self.server.manager.process_utterance(session, user_text)

            audio_b64 = base64.b64encode(audio_wav).decode("ascii") if audio_wav else None

            self._send_json({
                "session_id": session.session_id,
                "user_text": user_text,
                "reply_text": reply_text,
                "latency_ms": latency_ms,
                "voice": session.voice,
                "audio_base64": audio_b64,
                "audio_mime": "audio/wav",
            })
            return

        # 3. End Call Session
        if path == "/api/call/end":
            token = payload.get("token") or self.headers.get("X-Call-Token")
            if not token:
                self._send_json({"error": "token_required"}, code=401)
                return

            session = self.server.manager.validate_token(token)
            if not session:
                self._send_json({"error": "invalid_or_expired_token"}, code=401)
                return

            summary = self.server.manager.end_call_session(session)
            self._send_json({
                "status": "ended",
                "summary": summary,
            })
            return

        self._send_json({"error": "not_found"}, code=404)

    def _send_json(self, data: Dict[str, Any], code: int = 200) -> None:
        body = json.dumps(data, indent=2).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", _cors_origin(self))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_file(self, path: Path, mime: str) -> None:
        try:
            with open(path, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Access-Control-Allow-Origin", _cors_origin(self))
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            self._send_json({"error": f"Failed reading file: {e}"}, code=500)


class VoiceCallServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """Threaded HTTP Server for live call station."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, host: str, port: int, manager: CallManager):
        self.manager = manager
        super().__init__((host, port), VoiceCallHandler)
