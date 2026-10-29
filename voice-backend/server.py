"""Local, persistent Capri voice synthesis. No API keys and no text request logs."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class VoiceService:
    def __init__(self, reference: Path, runtime: Path, device: str, threads: int):
        self.reference = reference.resolve()
        self.runtime = runtime.resolve()
        self.requested_device = device
        self.device = "unselected"
        self.threads = threads
        self.model = None
        self.reference_signature = None
        self.cache_reference_signature = None
        self.cache_reference_hash = None
        self.threads_configured = False
        self.lock = threading.Lock()
        self.state = "unloaded"
        self.last_error = None
        self.runtime.mkdir(parents=True, exist_ok=True)
        # Keep all downloaded weights/caches inside the isolated runtime.
        for name, directory in {
            "HF_HOME": "hf-cache",
            "TORCH_HOME": "torch-cache",
            "NUMBA_CACHE_DIR": "numba-cache",
            "XDG_CACHE_HOME": "cache",
            "PKUSEG_HOME": "pkuseg-cache",
        }.items():
            os.environ[name] = str(self.runtime / directory)
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
        os.environ["DO_NOT_TRACK"] = "1"

    def health(self):
        return {
            "ok": self.state != "error",
            "state": self.state,
            "model": "chatterbox-multilingual-v3",
            "device": self.device,
            "referenceAvailable": self.reference.is_file(),
            "language": "ru",
            "error": self.last_error,
            "cacheAvailable": (self.runtime / "voice-cache").is_dir(),
        }

    def _cache_file(self, text: str) -> Path:
        stat = self.reference.stat()
        signature = (stat.st_mtime_ns, stat.st_size)
        if signature != self.cache_reference_signature:
            if stat.st_size > 20 * 1024**2:
                raise ValueError("reference_size")
            self.cache_reference_hash = hashlib.sha256(self.reference.read_bytes()).hexdigest()
            self.cache_reference_signature = signature
        content = json.dumps({"reference": self.cache_reference_hash,
                              "text": text.strip(), "language": "ru",
                              "engine": "chatterbox-v3-perth1.1", "cfg": 0.0,
                              "exaggeration": 0.5}, ensure_ascii=False, sort_keys=True)
        key = hashlib.sha256(content.encode("utf-8")).hexdigest()
        return self.runtime / "voice-cache" / (key + ".wav")

    @staticmethod
    def _read_cache(file: Path):
        try:
            if not 44 <= file.stat().st_size <= 8 * 1024**2:
                return None
            audio = file.read_bytes()
            if audio[:4] == b"RIFF" and audio[8:12] == b"WAVE":
                return audio
        except OSError:
            pass
        return None

    @staticmethod
    def _write_cache(file: Path, audio: bytes):
        # Only bounded generated WAVs, with opaque names; no request text is logged.
        # Keep at most 128 entries / 128 MiB, without deleting existing user data.
        if len(audio) > 8 * 1024**2:
            return
        file.parent.mkdir(parents=True, exist_ok=True)
        entries = list(file.parent.glob("*.wav"))
        if len(entries) >= 128 or sum(p.stat().st_size for p in entries) + len(audio) > 128 * 1024**2:
            return
        temporary = file.with_suffix("." + uuid.uuid4().hex + ".tmp")
        try:
            temporary.write_bytes(audio)
            os.replace(temporary, file)
        finally:
            if temporary.exists():
                temporary.unlink()

    def _load(self):
        if self.model is not None:
            return
        self.state = "loading"
        try:
            import torch
            import inspect
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS

            if "t3_model" not in inspect.signature(ChatterboxMultilingualTTS.from_pretrained).parameters:
                raise RuntimeError("chatterbox_v3_source_required")
            if not self.threads_configured:
                torch.set_num_threads(self.threads)
                torch.set_num_interop_threads(1)
                self.threads_configured = True
            self.device = self.requested_device
            if self.device == "auto":
                # The game keeps its GPU memory. Prefer CPU unless ample memory is free.
                free = torch.cuda.mem_get_info()[0] if torch.cuda.is_available() else 0
                self.device = "cuda" if free >= 6 * 1024**3 else "cpu"
            if self.device == "cuda":
                if not torch.cuda.is_available():
                    raise RuntimeError("cuda_unavailable")
                if torch.cuda.mem_get_info()[0] < 6 * 1024**3:
                    raise RuntimeError("cuda_memory_busy")
            self.model = ChatterboxMultilingualTTS.from_pretrained(
                device=self.device, t3_model="v3"
            )
            self.state = "ready"
            self.last_error = None
        except Exception:
            self.state = "error"
            self.last_error = "Не удалось загрузить локальную модель голоса."
            raise

    def synthesize(self, text: str, voice: str = "capri") -> bytes:
        if voice != "capri":
            raise ValueError("unknown_voice")
        if not isinstance(text, str) or not text.strip() or len(text) > 1200:
            raise ValueError("invalid_text")
        if not self.reference.is_file():
            raise FileNotFoundError("reference_missing")
        if not self.lock.acquire(blocking=False):
            raise BlockingIOError("voice_busy")
        try:
            cache_file = self._cache_file(text)
            cached = self._read_cache(cache_file)
            if cached is not None:
                self.last_error = None
                self.state = "ready" if self.model is not None else "cached"
                return cached
            self._load()
            import soundfile as sf

            self.state = "speaking"
            reference_stat = self.reference.stat()
            signature = (reference_stat.st_mtime_ns, reference_stat.st_size)
            prompt_path = str(self.reference) if signature != self.reference_signature else None
            wav = self.model.generate(
                text.strip(),
                language_id="ru",
                audio_prompt_path=prompt_path,
                cfg_weight=0.0,
                exaggeration=0.5,
            )
            audio = io.BytesIO()
            sf.write(audio, wav.squeeze(0).cpu().numpy(), self.model.sr,
                     format="WAV", subtype="PCM_16")
            self.reference_signature = signature
            self.state = "ready"
            self.last_error = None
            result = audio.getvalue()
            try:
                self._write_cache(cache_file, result)
            except OSError:
                pass  # A full/unwritable cache must not discard successfully synthesized speech.
            return result
        except Exception:
            self.state = "error"
            self.last_error = "Не удалось озвучить ответ локальным голосом."
            raise
        finally:
            self.lock.release()


def handler_for(service: VoiceService):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def respond(self, status: int, payload: bytes, content_type: str):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(payload)

        def json_response(self, status: int, data):
            self.respond(status, json.dumps(data, ensure_ascii=False).encode("utf-8"),
                         "application/json; charset=utf-8")

        def allowed(self):
            # Only the desktop main process calls this endpoint, without a browser Origin.
            host = self.headers.get("Host", "").split(":", 1)[0]
            return host in {"127.0.0.1", "localhost"} and not self.headers.get("Origin")

        def do_GET(self):
            if not self.allowed():
                return self.json_response(403, {"ok": False, "code": "local_only"})
            if self.path == "/health":
                return self.json_response(200, service.health())
            self.json_response(404, {"ok": False, "code": "not_found"})

        def do_POST(self):
            if not self.allowed():
                return self.json_response(403, {"ok": False, "code": "local_only"})
            if self.path != "/tts":
                return self.json_response(404, {"ok": False, "code": "not_found"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 12000:
                    return self.json_response(413, {"ok": False, "code": "request_size"})
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError("invalid_request")
                wav = service.synthesize(data.get("text"), data.get("voice", "capri"))
                self.respond(200, wav, "audio/wav")
            except (ValueError, TypeError, json.JSONDecodeError):
                self.json_response(400, {"ok": False, "code": "invalid_request"})
            except FileNotFoundError:
                self.json_response(503, {"ok": False, "code": "reference_missing"})
            except BlockingIOError:
                self.json_response(409, {"ok": False, "code": "voice_busy"})
            except Exception:
                self.json_response(503, {"ok": False, "code": "synthesis_failed",
                                         "message": service.last_error})
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    root = Path(__file__).resolve().parent.parent
    default_reference = Path(os.environ.get("APPDATA", str(root))) / "CapriCompanion" / "voice-reference.audio"
    parser.add_argument("--reference", type=Path, default=default_reference)
    parser.add_argument("--runtime", type=Path, default=root / ".tools" / "capri-voice")
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--port", type=int, default=8794)
    parser.add_argument("--synthesize", type=Path, help="Write one test WAV and exit.")
    parser.add_argument("--warmup", action="store_true", help="Load model weights before serving.")
    parser.add_argument("--offline", action="store_true", help="Use downloaded model files without network access.")
    parser.add_argument("--text", default="Ну что, продолжаем? Я рядом.")
    args = parser.parse_args()
    if not 1 <= args.threads <= 8 or not 1024 <= args.port <= 65535:
        parser.error("Invalid thread count or port")
    if args.offline:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
    service = VoiceService(args.reference, args.runtime, args.device, args.threads)
    if args.warmup:
        service._load()
    if args.synthesize:
        result = service.synthesize(args.text)
        args.synthesize.parent.mkdir(parents=True, exist_ok=True)
        args.synthesize.write_bytes(result)
        print(json.dumps({"ok": True, "bytes": len(result), "device": service.device}))
        return
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(service))
    print(json.dumps({"ok": True, "url": f"http://127.0.0.1:{args.port}",
                      "state": "unloaded"}), flush=True)
    server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
