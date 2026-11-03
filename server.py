#!/usr/bin/env python3
"""Root launcher for Agent Voice Call server.

Engineered by 1nc0gn30 (@1nc0gn30) • NullAI Platform.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Add src to sys.path
SRC_DIR = Path(__file__).resolve().parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from agent_voice_call.cli import cmd_serve


def main():
    parser = argparse.ArgumentParser(description="Agent Voice Call Station Server")
    parser.add_argument("--port", type=int, default=8114, help="Port to bind (default: 8114)")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind (default: 127.0.0.1)")
    args = parser.parse_args()
    cmd_serve(args)


if __name__ == "__main__":
    main()
