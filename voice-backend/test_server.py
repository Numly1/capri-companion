import http.client
import io
import json
import tempfile
import threading
import unittest
import types
from unittest.mock import Mock, patch
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

from server import VoiceService, ThreadingHTTPServer, handler_for


class MissingReferenceTests(unittest.TestCase):
    def test_missing_reference_does_not_load_model(self):
        with tempfile.TemporaryDirectory() as directory:
            service = VoiceService(Path(directory) / "missing.wav", Path(directory), "cpu", 2)
            with self.assertRaises(FileNotFoundError):
                service.synthesize("Привет")
            self.assertIsNone(service.model)
            self.assertFalse(service.health()["referenceAvailable"])

    def test_rejects_invalid_text_before_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            service = VoiceService(Path(directory) / "missing.wav", Path(directory), "cpu", 2)
            for text in [None, 12, "", "  ", "я" * 1201]:
                with self.assertRaises(ValueError):
                    service.synthesize(text)
            self.assertIsNone(service.model)

    def test_failed_load_can_retry_without_resetting_interop_threads(self):
        torch = types.ModuleType("torch")
        torch.set_num_threads = Mock()
        torch.set_num_interop_threads = Mock()
        tts_module = types.ModuleType("chatterbox.mtl_tts")
        attempts = []

        class TTS:
            @staticmethod
            def from_pretrained(device, t3_model):
                attempts.append((device, t3_model))
                if len(attempts) == 1:
                    raise OSError("transient model download failure")
                return object()

        tts_module.ChatterboxMultilingualTTS = TTS
        with tempfile.TemporaryDirectory() as directory, patch.dict("sys.modules", {
            "torch": torch, "chatterbox.mtl_tts": tts_module,
        }):
            service = VoiceService(Path(directory) / "missing.wav", Path(directory), "cpu", 2)
            with self.assertRaises(OSError):
                service._load()
            self.assertEqual(service.state, "error")
            service._load()
            self.assertEqual(service.state, "ready")
            self.assertIsNone(service.last_error)
            self.assertEqual(len(attempts), 2)
            torch.set_num_interop_threads.assert_called_once_with(1)


class FakeService:
    last_error = None

    def health(self):
        return {"ok": True, "state": "unloaded", "referenceAvailable": False}

    def synthesize(self, text, voice):
        if voice != "capri" or not isinstance(text, str):
            raise ValueError()
        if text == "missing":
            raise FileNotFoundError()
        return b"RIFF-test-audio-WAVE"


class CacheTests(unittest.TestCase):
    @staticmethod
    def wav():
        audio = bytearray(48)
        audio[:4] = b"RIFF"
        audio[8:12] = b"WAVE"
        return bytes(audio)

    def test_cached_voice_works_without_model_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "reference.wav"
            reference.write_bytes(self.wav())
            service = VoiceService(reference, Path(directory), "cpu", 2)
            cache = service._cache_file("Мы рядом, чум.")
            service._write_cache(cache, self.wav())
            with patch.object(service, "_load", side_effect=AssertionError("cache must not load model")):
                self.assertEqual(service.synthesize("Мы рядом, чум."), self.wav())
            self.assertIsNone(service.model)
            self.assertEqual(service.state, "cached")
            self.assertTrue(service.health()["ok"])

    def test_reference_and_text_changes_do_not_reuse_another_voice(self):
        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "reference.wav"
            reference.write_bytes(self.wav())
            service = VoiceService(reference, Path(directory), "cpu", 2)
            first = service._cache_file("Привет")
            self.assertNotEqual(first, service._cache_file("Пока"))
            reference.write_bytes(self.wav() + b"changed")
            self.assertNotEqual(first, service._cache_file("Привет"))
            self.assertNotIn("Привет", first.name)

    def test_invalid_cached_audio_is_ignored_and_cache_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "voice-cache" / "a.wav"
            file.parent.mkdir()
            file.write_bytes(b"not-wave" * 8)
            self.assertIsNone(VoiceService._read_cache(file))
            for index in range(127):
                (file.parent / f"{index}.wav").write_bytes(self.wav())
            extra = file.parent / "extra.wav"
            VoiceService._write_cache(extra, self.wav())
            self.assertFalse(extra.exists())


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(FakeService()))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, method, path, data=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        body = None if data is None else json.dumps(data, ensure_ascii=False).encode("utf-8")
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, response.getheader("Content-Type"), response.read()
        connection.close()
        return result

    def test_health_and_audio_contract_without_text_logs(self):
        logs = io.StringIO()
        with redirect_stdout(logs), redirect_stderr(logs):
            status, content_type, body = self.request("GET", "/health")
            self.assertEqual(status, 200)
            self.assertFalse(json.loads(body)["referenceAvailable"])
            status, content_type, body = self.request("POST", "/tts", {"text": "Приватный текст", "voice": "capri"})
            self.assertEqual((status, content_type), (200, "audio/wav"))
            self.assertTrue(body.startswith(b"RIFF"))
        self.assertEqual(logs.getvalue(), "")

    def test_browser_origins_rejected(self):
        self.assertEqual(self.request("GET", "/health", headers={"Origin": "https://example.com"})[0], 403)
        self.assertEqual(self.request("GET", "/health", headers={"Host": "example.com"})[0], 403)

    def test_missing_reference_and_invalid_request_errors(self):
        status, _, body = self.request("POST", "/tts", {"text": "missing"})
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["code"], "reference_missing")
        self.assertEqual(self.request("POST", "/tts", {"text": 4})[0], 400)
        self.assertEqual(self.request("POST", "/tts", ["x"])[0], 400)


if __name__ == "__main__":
    unittest.main()
