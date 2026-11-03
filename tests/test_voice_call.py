"""Unit Tests for agent-voice-call.

Zero External Dependencies — 100% Python Standard Library.
"""

from __future__ import annotations

import json
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

from agent_voice_call.call_engine import CallManager, CallSession, CallTurn
from agent_voice_call.server import VoiceCallServer
from agent_voice_call.tts_bridge import VOICES, convert_wav_to_opus_ogg, is_kokoro_online


class TestTTSBridge(unittest.TestCase):
    """Test TTS voice bridge configuration and fallbacks."""

    def test_voices_registry(self):
        self.assertIn("azoth", VOICES)
        self.assertIn("ghostbyte", VOICES)
        self.assertIn("athena", VOICES)
        self.assertEqual(VOICES["azoth"]["id"], "am_michael")

    def test_kokoro_status_check(self):
        # Should return boolean without crashing
        status = is_kokoro_online(timeout=0.2)
        self.assertIsInstance(status, bool)

    def test_convert_wav_fallback_without_crash(self):
        dummy_wav = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00"
        result = convert_wav_to_opus_ogg(dummy_wav)
        self.assertIsNotNone(result)

    def test_synthesize_speech_wav_live(self):
        from agent_voice_call.tts_bridge import synthesize_speech_wav
        wav = synthesize_speech_wav("Hello from sovereign test suite.", voice_name="azoth")
        self.assertIsNotNone(wav)
        self.assertTrue(len(wav) > 100)
        self.assertTrue(wav.startswith(b"RIFF"))

    def test_generate_voice_file_live(self):
        import os
        from agent_voice_call.tts_bridge import generate_voice_file
        path = generate_voice_file("Test voice note.", voice_name="azoth", out_format="ogg")
        self.assertIsNotNone(path)
        self.assertTrue(os.path.exists(path))
        self.assertTrue(os.path.getsize(path) > 100)
        try:
            os.remove(path)
        except OSError:
            pass


class TestCallEngine(unittest.TestCase):
    """Test call session management and conversation turns."""

    def setUp(self):
        self.manager = CallManager()

    def test_create_and_validate_session(self):
        session_id, token = self.manager.create_call_token(channel="signal", voice="azoth")
        self.assertTrue(session_id.startswith("call_"))
        self.assertTrue(len(token) > 10)

        session = self.manager.validate_token(token)
        self.assertIsNotNone(session)
        self.assertEqual(session.session_id, session_id)
        self.assertEqual(session.channel, "signal")
        self.assertEqual(session.voice, "azoth")
        self.assertEqual(session.status, "ACTIVE")

    def test_invalid_token(self):
        session = self.manager.validate_token("nonexistent-token")
        self.assertIsNone(session)

    @patch("agent_voice_call.call_engine.synthesize_speech_wav")
    def test_process_utterance(self, mock_tts):
        mock_tts.return_value = b"fake-wav-bytes"
        session_id, token = self.manager.create_call_token(channel="simplex", voice="athena")
        session = self.manager.validate_token(token)

        reply, audio, latency = self.manager.process_utterance(session, "Hello agent")
        self.assertIsInstance(reply, str)
        self.assertTrue(len(reply) > 0)
        self.assertEqual(audio, b"fake-wav-bytes")
        self.assertGreaterEqual(latency, 0.0)
        self.assertEqual(len(session.turns), 2)  # 1 user + 1 agent

    @patch("agent_voice_call.call_engine.threading.Thread")
    def test_end_call_session(self, mock_thread):
        session_id, token = self.manager.create_call_token(channel="web", voice="ghostbyte")
        session = self.manager.validate_token(token)
        session.turns.append(CallTurn(role="user", text="Test debrief", timestamp="00:00:00"))

        summary = self.manager.end_call_session(session)
        self.assertEqual(session.status, "ENDED")
        self.assertEqual(summary["session_id"], session_id)
        self.assertEqual(summary["total_turns"], 1)
        self.assertEqual(summary["voice"], "ghostbyte")


class TestVoiceServer(unittest.TestCase):
    """Test HTTP endpoints for live call cockpit and API."""

    @classmethod
    def setUpClass(cls):
        cls.manager = CallManager()
        # Bind to ephemeral test port so it never collides with running services
        cls.server = VoiceCallServer("127.0.0.1", 0, cls.manager)
        cls.port = cls.server.server_port
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_health_endpoint(self):
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=2.0) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(data["status"], "healthy")
            self.assertEqual(data["service"], "agent-voice-call")

    def test_voices_endpoint(self):
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/voices", timeout=2.0) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertIn("voices", data)
            self.assertIn("azoth", data["voices"])

    def test_create_call_api(self):
        import urllib.request
        payload = json.dumps({"channel": "signal", "voice": "mercury"}).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/call/create",
            data=payload,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(data["status"], "created")
            self.assertIn("token", data)
            self.assertIn("call_url", data)


if __name__ == "__main__":
    unittest.main()
