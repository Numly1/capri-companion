import hashlib
import http.client
import io
import json
import tempfile
import threading
import unittest
import wave
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from server import LocalServer, MODEL, PREVIEW_TEXT, PROFILE, REVISION, VoiceService, handler_for, valid_audio


def wav_bytes():
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(b"\x01\x02" * 100)
    return output.getvalue()


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.reference = self.directory / "reference.audio"
        self.reference.write_bytes(wav_bytes())
        self.service = VoiceService(self.reference, self.directory / "runtime", offline=True)

    def tearDown(self):
        self.temporary.cleanup()

    def test_health_requires_no_model_or_network_and_reference_is_opaque(self):
        health = self.service.health()
        self.assertEqual(health["model"], PROFILE)
        self.assertEqual(health["modelRevision"], REVISION)
        self.assertEqual(health["referenceSHA256"], hashlib.sha256(self.reference.read_bytes()).hexdigest())
        self.assertIsNone(self.service.model)
        self.assertNotIn(str(self.reference), json.dumps(health))

    def test_cache_is_bound_to_text_reference_and_model_parameters(self):
        first = self.service.cache_file("Привет")
        self.assertEqual(first, self.service.cache_file("  Привет  "))
        self.assertNotEqual(first, self.service.cache_file("Пока"))
        self.assertNotIn("Привет", first.name)
        self.reference.write_bytes(wav_bytes() + b"changed")
        self.assertNotEqual(first, self.service.cache_file("Привет"))
        self.assertEqual(self.service.parameters(PREVIEW_TEXT)["maxNewTokens"], 192)
        self.assertLessEqual(self.service.parameters("x" * 400)["maxNewTokens"], 512)

    def test_cached_reply_never_loads_torch_or_model(self):
        file = self.directory / "preview.wav"
        file.write_bytes(wav_bytes())
        self.service.seed_preview(file)
        self.service._load = lambda: self.fail("cache hit must not load the model")
        self.assertEqual(self.service.synthesize(PREVIEW_TEXT), wav_bytes())
        self.assertEqual(self.service.state, "cached")
        self.assertIsNone(self.service.model)

    def test_invalid_cached_wav_is_ignored_and_cache_is_bounded(self):
        self.assertFalse(valid_audio(b"not wav"))
        self.assertFalse(valid_audio(b"RIFF" + b"\0" * 50))
        file = self.service.cache_file("Привет")
        file.parent.mkdir()
        file.write_bytes(b"invalid" * 10)
        self.assertIsNone(self.service.read_cache(file))
        for index in range(127):
            (file.parent / f"{index}.wav").write_bytes(wav_bytes())
        extra = file.parent / "extra.wav"
        self.assertFalse(self.service.write_cache(extra, wav_bytes()))
        self.assertFalse(extra.exists())

    def test_manifest_seeds_only_matching_reference_and_verified_audio(self):
        audio = self.directory / "one.wav"
        audio.write_bytes(wav_bytes())
        file = self.directory / "manifest.json"
        data = {"model": MODEL, "revision": REVISION, "language": "ru",
                "referenceSHA256": self.service.health()["referenceSHA256"],
                "clips": {"Привет": audio.name},
                "audio": [{"file": audio.name, "sha256": hashlib.sha256(audio.read_bytes()).hexdigest()}]}
        file.write_text(json.dumps(data), "utf-8")
        self.assertEqual(self.service.seed_manifest(file), 1)
        self.assertEqual(self.service.synthesize("Привет"), wav_bytes())
        data["referenceSHA256"] = "wrong"
        file.write_text(json.dumps(data), "utf-8")
        with self.assertRaisesRegex(ValueError, "manifest_identity"):
            self.service.seed_manifest(file)
        data["referenceSHA256"] = self.service.health()["referenceSHA256"]
        data["clips"] = {"Пока": "../outside.wav"}
        file.write_text(json.dumps(data), "utf-8")
        with self.assertRaisesRegex(ValueError, "manifest_path"):
            self.service.seed_manifest(file)

    def test_validation_and_busy_errors_do_not_start_inference(self):
        self.service._load = lambda: self.fail("invalid request must not load model")
        for text in [None, "", "   ", "x" * 401, 42]:
            with self.assertRaises(ValueError):
                self.service.synthesize(text)
        with self.assertRaises(ValueError):
            self.service.synthesize("Привет", "unknown")
        self.service.lock.acquire()
        try:
            with self.assertRaises(BlockingIOError):
                self.service.synthesize("Привет")
        finally:
            self.service.lock.release()
        self.reference.unlink()
        with self.assertRaises(FileNotFoundError):
            self.service.synthesize("Привет")


class FakeService:
    last_error = "Generic failure"

    def health(self):
        return {"ok": True, "model": PROFILE, "state": "cached"}

    def synthesize(self, text, voice="capri"):
        if text == "missing":
            raise FileNotFoundError()
        if text == "busy":
            raise BlockingIOError()
        if text == "failure":
            raise RuntimeError("private diagnostic must not escape")
        if not isinstance(text, str) or not 1 <= len(text) <= 400 or voice != "capri":
            raise ValueError()
        return wav_bytes()


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = LocalServer(("127.0.0.1", 0), handler_for(FakeService()))
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

    def test_health_and_wav_contract_without_text_logs(self):
        logs = io.StringIO()
        with redirect_stdout(logs), redirect_stderr(logs):
            status, _, body = self.request("GET", "/health")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["model"], PROFILE)
            status, content_type, body = self.request("POST", "/tts", {"text": "Приватная реплика"})
            self.assertEqual((status, content_type), (200, "audio/wav"))
            self.assertTrue(valid_audio(body))
        self.assertEqual(logs.getvalue(), "")

    def test_browsers_and_remote_hosts_cannot_use_the_local_service(self):
        self.assertEqual(self.request("GET", "/health", headers={"Origin": "https://example.com"})[0], 403)
        self.assertEqual(self.request("POST", "/tts", {"text": "Привет"}, headers={"Host": "example.com"})[0], 403)

    def test_error_statuses_are_bounded_and_sanitized(self):
        self.assertEqual(self.request("POST", "/tts", {"text": "missing"})[0], 503)
        self.assertEqual(self.request("POST", "/tts", {"text": "busy"})[0], 409)
        self.assertEqual(self.request("POST", "/tts", {"text": 42})[0], 400)
        self.assertEqual(self.request("POST", "/tts", ["invalid"])[0], 400)
        self.assertEqual(self.request("POST", "/tts", {"text": "x" * 13000})[0], 413)
        _, _, body = self.request("POST", "/tts", {"text": "failure"})
        self.assertNotIn(b"private diagnostic", body)


if __name__ == "__main__":
    unittest.main()
