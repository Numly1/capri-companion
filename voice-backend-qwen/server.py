"""Persistent local Qwen voice output. No API keys or request-text logs."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import threading
import uuid
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
REVISION = "fd4b254389122332181a7c3db7f27e918eec64e3"
PROFILE = "qwen3-tts-1.7b-capri"
PREVIEW_TEXT = "Мы рядом. Продолжай, художница."
MAX_TEXT = 400
MAX_AUDIO = 8 * 1024**2
MAX_CACHE = 128 * 1024**2


def valid_audio(audio: bytes) -> bool:
    if not 44 <= len(audio) <= MAX_AUDIO:
        return False
    try:
        with wave.open(io.BytesIO(audio), "rb") as wav:
            return (wav.getnchannels() == 1 and wav.getsampwidth() == 2
                    and wav.getframerate() == 24000 and wav.getnframes() > 0
                    and wav.getcomptype() == "NONE")
    except (EOFError, wave.Error):
        return False


class VoiceService:
    def __init__(self, reference: Path, runtime: Path, device="cpu", threads=2, offline=False):
        self.reference = reference.resolve()
        self.runtime = runtime.resolve()
        self.device = device
        self.threads = threads
        self.offline = offline
        self.model = None
        self.prompt = None
        self.prompt_reference_hash = None
        self.reference_signature = None
        self.reference_hash = None
        self.threads_configured = False
        self.lock = threading.Lock()
        self.state = "unloaded"
        self.last_error = None
        self.runtime.mkdir(parents=True, exist_ok=True)
        for name, directory in {"HF_HOME": "hf-cache", "TORCH_HOME": "torch-cache",
                                "NUMBA_CACHE_DIR": "numba-cache", "XDG_CACHE_HOME": "cache"}.items():
            os.environ[name] = str(self.runtime / directory)
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
        os.environ["DO_NOT_TRACK"] = "1"
        os.environ["OMP_NUM_THREADS"] = str(threads)
        os.environ["MKL_NUM_THREADS"] = str(threads)
        if offline:
            os.environ["HF_HUB_OFFLINE"] = "1"
            os.environ["TRANSFORMERS_OFFLINE"] = "1"

    def _reference_hash(self):
        stat = self.reference.stat()
        if not 44 <= stat.st_size <= 20 * 1024**2:
            raise ValueError("reference_size")
        signature = (stat.st_mtime_ns, stat.st_size, stat.st_ino)
        if signature != self.reference_signature:
            self.reference_hash = hashlib.sha256(self.reference.read_bytes()).hexdigest()
            self.reference_signature = signature
        return self.reference_hash

    def health(self):
        try:
            reference_hash = self._reference_hash()
        except (OSError, ValueError):
            reference_hash = None
        return {"ok": self.state != "error", "state": self.state, "model": PROFILE,
                "modelRevision": REVISION, "device": self.device, "language": "ru",
                "referenceAvailable": reference_hash is not None, "referenceSHA256": reference_hash,
                "cacheAvailable": (self.runtime / "voice-cache").is_dir(),
                "maxTextCharacters": MAX_TEXT, "error": self.last_error}

    @staticmethod
    def parameters(text):
        return {"language": "Russian", "xVectorOnly": True, "nonStreaming": True,
                "temperature": 0.75, "seed": 42,
                "maxNewTokens": max(192, min(512, len(text) * 2))}

    def cache_file(self, text):
        data = {"model": MODEL, "revision": REVISION, "reference": self._reference_hash(),
                "text": text.strip(), "parameters": self.parameters(text.strip())}
        key = hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
        return self.runtime / "voice-cache" / (key + ".wav")

    @staticmethod
    def read_cache(file):
        try:
            if not 44 <= file.stat().st_size <= MAX_AUDIO:
                return None
            audio = file.read_bytes()
            return audio if valid_audio(audio) else None
        except OSError:
            return None

    @staticmethod
    def write_cache(file, audio):
        if not valid_audio(audio):
            raise ValueError("invalid_audio")
        file.parent.mkdir(parents=True, exist_ok=True)
        entries = list(file.parent.glob("*.wav"))
        if not file.exists() and (len(entries) >= 128 or sum(p.stat().st_size for p in entries) + len(audio) > MAX_CACHE):
            return False
        temporary = file.with_suffix("." + uuid.uuid4().hex + ".tmp")
        try:
            temporary.write_bytes(audio)
            os.replace(temporary, file)
        finally:
            if temporary.exists():
                temporary.unlink()
        return True

    def seed_preview(self, file):
        audio = file.read_bytes()
        if not self.write_cache(self.cache_file(PREVIEW_TEXT), audio):
            raise ValueError("cache_full")
        self.state = "cached" if self.model is None else "ready"
        return 1

    def seed_manifest(self, file):
        manifest = json.loads(file.read_text("utf-8-sig"))
        if (manifest.get("model") != MODEL or manifest.get("revision") != REVISION
                or manifest.get("referenceSHA256") != self._reference_hash()
                or manifest.get("language") != "ru"):
            raise ValueError("manifest_identity")
        clips = manifest.get("clips")
        if not isinstance(clips, dict) or len(clips) > 128:
            raise ValueError("manifest_clips")
        metadata = {entry.get("file"): entry for entry in manifest.get("audio", []) if isinstance(entry, dict)}
        base = file.resolve().parent
        count = 0
        for text, name in clips.items():
            if not isinstance(text, str) or not 1 <= len(text.strip()) <= 96 or not isinstance(name, str):
                raise ValueError("manifest_clip")
            source = (base / name).resolve()
            if source.parent != base:
                raise ValueError("manifest_path")
            audio = source.read_bytes()
            entry = metadata.get(name)
            if entry and entry.get("sha256") != hashlib.sha256(audio).hexdigest():
                raise ValueError("manifest_hash")
            if self.write_cache(self.cache_file(text), audio):
                count += 1
        self.state = "cached" if self.model is None else "ready"
        return count

    def download(self):
        from huggingface_hub import snapshot_download
        return snapshot_download(MODEL, revision=REVISION, token=False,
                                 allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model", "*.npz"],
                                 local_files_only=self.offline, max_workers=3)

    def _load(self):
        if self.model is not None:
            return
        self.state = "loading"
        try:
            import torch
            from qwen_tts import Qwen3TTSModel
            if not self.threads_configured:
                torch.set_num_threads(self.threads)
                torch.set_num_interop_threads(1)
                self.threads_configured = True
            model_path = self.download()
            # CPU leaves the game's video memory alone; no GPU/driver configuration is changed.
            self.model = Qwen3TTSModel.from_pretrained(model_path, device_map="cpu", dtype=torch.float32,
                                                      attn_implementation="sdpa", local_files_only=True)
            self.state = "ready"
            self.last_error = None
        except Exception:
            self.state = "error"
            self.last_error = "Не удалось загрузить установленную модель голоса Капри."
            raise

    def synthesize(self, text, voice="capri"):
        if voice != "capri" or not isinstance(text, str) or not 1 <= len(text.strip()) <= MAX_TEXT:
            raise ValueError("invalid_request")
        if not self.reference.is_file():
            raise FileNotFoundError("reference_missing")
        if not self.lock.acquire(blocking=False):
            raise BlockingIOError("voice_busy")
        try:
            text = text.strip()
            cache = self.cache_file(text)
            cached = self.read_cache(cache)
            if cached is not None:
                self.state = "ready" if self.model is not None else "cached"
                self.last_error = None
                return cached
            self._load()
            import numpy as np
            import soundfile as sf
            import torch
            self.state = "speaking"
            torch.manual_seed(42)
            if self.prompt is None or self.prompt_reference_hash != self.reference_hash:
                self.prompt = self.model.create_voice_clone_prompt(ref_audio=str(self.reference),
                                                                   ref_text=None, x_vector_only_mode=True)
                self.prompt_reference_hash = self.reference_hash
            wavs, rate = self.model.generate_voice_clone(
                text=text, language="Russian", voice_clone_prompt=self.prompt,
                non_streaming_mode=True, temperature=0.75,
                max_new_tokens=self.parameters(text)["maxNewTokens"])
            audio = np.asarray(wavs[0], dtype=np.float32)
            if rate != 24000 or audio.ndim != 1 or not len(audio) or not np.isfinite(audio).all():
                raise ValueError("invalid_audio")
            output = io.BytesIO()
            sf.write(output, audio, rate, format="WAV", subtype="PCM_16")
            result = output.getvalue()
            if not valid_audio(result):
                raise ValueError("invalid_audio")
            try:
                self.write_cache(cache, result)
            except OSError:
                pass
            self.state = "ready"
            self.last_error = None
            return result
        except Exception:
            self.state = "error"
            self.last_error = "Не удалось подготовить реплику голосом Капри."
            raise
        finally:
            self.lock.release()


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, *_args):
        pass  # No HTTP/body/stack dumps or request text in logs.


def handler_for(service):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_args):
            pass

        def respond(self, status, data, content_type="application/json; charset=utf-8"):
            if not isinstance(data, bytes):
                data = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass

        def allowed(self):
            host = self.headers.get("Host", "").split(":", 1)[0]
            return host in {"127.0.0.1", "localhost"} and not self.headers.get("Origin")

        def do_GET(self):
            if not self.allowed():
                return self.respond(403, {"ok": False, "code": "local_only"})
            if self.path == "/health":
                return self.respond(200, service.health())
            self.respond(404, {"ok": False, "code": "not_found"})

        def do_POST(self):
            if not self.allowed():
                return self.respond(403, {"ok": False, "code": "local_only"})
            if self.path != "/tts":
                return self.respond(404, {"ok": False, "code": "not_found"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 12000:
                    return self.respond(413, {"ok": False, "code": "request_size"})
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError("invalid_request")
                audio = service.synthesize(data.get("text"), data.get("voice", "capri"))
                self.respond(200, audio, "audio/wav")
            except (ValueError, TypeError, json.JSONDecodeError):
                self.respond(400, {"ok": False, "code": "invalid_request", "maxTextCharacters": MAX_TEXT})
            except FileNotFoundError:
                self.respond(503, {"ok": False, "code": "reference_missing"})
            except BlockingIOError:
                self.respond(409, {"ok": False, "code": "voice_busy"})
            except Exception:
                self.respond(503, {"ok": False, "code": "synthesis_failed", "message": service.last_error})
    return Handler


def main():
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, default=root / ".tools" / "capri-qwen-voice")
    parser.add_argument("--reference", type=Path, default=Path(os.environ.get("APPDATA", str(root))) / "CapriCompanion" / "capri-approved-reference.audio")
    parser.add_argument("--device", choices=["cpu"], default="cpu")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--port", type=int, default=8795)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--download-only", action="store_true")
    parser.add_argument("--seed-preview", type=Path)
    parser.add_argument("--seed-manifest", type=Path)
    parser.add_argument("--seed-only", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.threads <= 8 or not 1024 <= args.port <= 65535:
        parser.error("Invalid thread count or port")
    service = VoiceService(args.reference, args.runtime, args.device, args.threads, args.offline)
    if args.download_only:
        service.download()
        print(json.dumps({"ok": True, "downloaded": True, "model": MODEL, "revision": REVISION}))
        return
    seeded = 0
    if args.seed_preview:
        seeded += service.seed_preview(args.seed_preview)
    if args.seed_manifest:
        seeded += service.seed_manifest(args.seed_manifest)
    if args.seed_only:
        print(json.dumps({"ok": True, "seeded": seeded, "model": PROFILE}))
        return
    server = LocalServer(("127.0.0.1", args.port), handler_for(service))
    print(json.dumps({"ok": True, "url": f"http://127.0.0.1:{args.port}", "model": PROFILE,
                      "state": service.state}), flush=True)
    server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
