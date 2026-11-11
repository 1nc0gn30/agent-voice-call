"""CLI Interface for Agent Voice Call Station.

100% Python Standard Library — Zero External Dependencies.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import urllib.error
import urllib.request
from typing import List, Optional

from .call_engine import CallManager
from .server import VoiceCallServer
from .tts_bridge import VOICES, is_kokoro_online


def _default_bind_host() -> str:
    """Bind address: localhost unless explicitly opted in via $ZOTH_BIND_HOST or
    $HOST (IP literal only; zsh sets HOST to the hostname) or --host."""
    import ipaddress
    for var in ("ZOTH_BIND_HOST", "HOST"):
        val = os.environ.get(var, "").strip()
        if val == "localhost":
            return "127.0.0.1"
        if val:
            try:
                ipaddress.ip_address(val)
                return val
            except ValueError:
                pass
    return "127.0.0.1"


logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] (VoiceCall) %(message)s",
)
logger = logging.getLogger("agent_voice_call.cli")


def cmd_serve(args: argparse.Namespace) -> int:
    """Start the live voice calling station HTTP server."""
    manager = CallManager()
    server = VoiceCallServer(args.host, args.port, manager)

    kokoro_status = "● ONLINE (:9394)" if is_kokoro_online() else "○ OFFLINE (Check kokoro-voice.service)"
    
    tailscale_ip = os.environ.get("ZOTH_TAILSCALE_IP", "<tailscale-ip>")

    print("\n" + "=" * 70)
    print("  ZOTH AGENT LIVE VOICE CALL STATION • PORT 8114")
    print("=" * 70)
    print(f"  • Web Call Cockpit:   http://{args.host}:{args.port}/call")
    print(f"  • Tailscale Network:  http://{tailscale_ip}:{args.port}/call")
    print(f"  • Kokoro Voice Engine: {kokoro_status}")
    print(f"  • Available Voices:   {', '.join(VOICES.keys())}")
    print("=" * 70 + "\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down voice call station...")
        server.server_close()
    return 0


def cmd_call(args: argparse.Namespace) -> int:
    """Generate a 1-click live voice call link for Signal or SimpleX."""
    url = f"http://127.0.0.1:{args.port}/api/call/create"
    data = json.dumps({"channel": args.channel, "voice": args.voice}).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})

    try:
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            res = json.loads(resp.read().decode("utf-8"))
            print(f"Session ID: {res['session_id']}")
            print(f"Call URL:   {res['call_url']}")
            return 0
    except Exception as e:
        print(f"Error creating call link: {e}")
        return 1


def cmd_status(host: str = "127.0.0.1", port: int = 8114, as_json: bool = False) -> int:
    url = f"http://{host}:{port}/health"
    live_info = None
    try:
        with urllib.request.urlopen(url, timeout=2.0) as resp:
            live_info = json.loads(resp.read().decode("utf-8"))
    except Exception:
        pass

    data = {
        "status": "online" if live_info else "standby",
        "service": "agent-voice-call",
        "version": "2.5.0",
        "port": port,
        "kokoro_online": is_kokoro_online(),
        "available_voices": list(VOICES.keys()),
        "license": "100% Free & Open Access (Zero Paywalls)",
        "daemon": live_info,
    }

    if as_json:
        print(json.dumps(data, indent=2))
        return 0

    print("\n" + "=" * 70)
    print("  ZOTH AGENT LIVE VOICE CALL STATION v2.5.0 • PORT 8114")
    print("=" * 70)
    state_color = "\033[38;5;48mONLINE\033[0m" if live_info else "\033[38;5;208mSTANDBY\033[0m"
    print(f"  • Daemon Status:     {state_color} ({url})")
    print(f"  • Kokoro Engine:     {'● ONLINE' if data['kokoro_online'] else '○ OFFLINE'}")
    print(f"  • Available Voices:  {', '.join(data['available_voices'])}")
    print(f"  • Access Guarantee:  100% Free & Open Access (Zero Paywalls)")
    print("=" * 70 + "\n")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="agent-voice-call", description="Zoth Sovereign Live Voice Calling Station")
    parser.add_argument("-v", "--version", action="version", version="agent-voice-call 2.5.0")
    parser.add_argument("--status", action="store_true", help="Print local service status and configuration")
    parser.add_argument("--json", action="store_true", help="Output status/telemetry as JSON")
    parser.add_argument("--host", default=_default_bind_host(), help="Host interface (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8114, help="Port to bind/check (default: 8114)")

    subparsers = parser.add_subparsers(dest="command")

    # Status command
    status_p = subparsers.add_parser("status", help="Inspect status of running voice call daemon")
    status_p.add_argument("--host", default="127.0.0.1")
    status_p.add_argument("--port", type=int, default=8114)
    status_p.add_argument("--json", action="store_true", help="Emit raw stats as JSON")

    # Serve command
    serve_p = subparsers.add_parser("serve", help="Run the live voice call server")
    serve_p.add_argument("--host", default=_default_bind_host(), help="Host interface")
    serve_p.add_argument("--port", type=int, default=8114, help="Port to bind (default: 8114)")

    # Call command
    call_p = subparsers.add_parser("call", help="Generate a live call URL")
    call_p.add_argument("--channel", default="signal", choices=["signal", "simplex", "web"])
    call_p.add_argument("--voice", default="azoth", choices=list(VOICES.keys()))
    call_p.add_argument("--port", type=int, default=8114)

    args = parser.parse_args(argv)

    if getattr(args, "status", False) or (getattr(args, "json", False) and not args.command):
        return cmd_status(host=args.host, port=args.port, as_json=True if getattr(args, "json", False) else False)

    if args.command == "status":
        return cmd_status(host=args.host, port=args.port, as_json=args.json)
    elif args.command == "serve":
        return cmd_serve(args)
    elif args.command == "call":
        return cmd_call(args)
    else:
        return cmd_status(host=args.host, port=args.port, as_json=False)


if __name__ == "__main__":
    sys.exit(main())
