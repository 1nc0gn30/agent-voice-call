"""Make the src/ layout importable when running `pytest tests/` from the repo root."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
