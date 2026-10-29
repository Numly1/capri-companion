"""Prepare small, finite Russian clips using the user-approved voice settings."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import time
from pathlib import Path

MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
REVISION = "fd4b254389122332181a7c3db7f27e918eec64e3"
CLIPS = [
    ("Мы рядом, чум.", "ambient-01.wav"),
    ("Сигнал стабильный. Продолжаем.", "ambient-02.wav"),
    ("Небольшой перерыв не помешает.", "ambient-03.wav"),
    ("Этот глич был намеренным.", "ambient-04.wav"),
]
PREVIEW_TEXT = "Мы рядом. Продолжай, художница."


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    root = Path(__file__).resolve().parent.parent
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--reference", type=Path, default=root / "voice-reference" / "capri-reference-en-alternative.wav")
    parser.add_argument("--preview", type=Path, default=root / "voice-reference" / "capri-ru-qwen-speaker-only.wav")
    parser.add_argument("--output", type=Path, default=root / "app" / "assets" / "companion-voice")
    args = parser.parse_args()
    runtime = args.runtime.resolve()
    for name, folder in {"HF_HOME": "hf-cache", "TORCH_HOME": "torch-cache", "NUMBA_CACHE_DIR": "numba-cache", "XDG_CACHE_HOME": "cache"}.items():
        os.environ[name] = str(runtime / folder)
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                      HF_HUB_DISABLE_IMPLICIT_TOKEN="1", DO_NOT_TRACK="1", OMP_NUM_THREADS="2", MKL_NUM_THREADS="2")
    if not args.reference.is_file() or not args.preview.is_file():
        parser.error("The confirmed reference and approved preview are required.")
    from huggingface_hub import snapshot_download
    model_path = snapshot_download(MODEL, revision=REVISION, token=False, local_files_only=True)
    import numpy as np
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    started = time.perf_counter()
    model = Qwen3TTSModel.from_pretrained(model_path, device_map="cpu", dtype=torch.float32,
                                         attn_implementation="sdpa", local_files_only=True)
    load_seconds = time.perf_counter() - started
    args.output.mkdir(parents=True, exist_ok=True)
    entries = {}
    metadata = []

    def measure(file, generation_seconds=None):
        wave, rate = sf.read(file, dtype="float32", always_2d=True)
        duration = len(wave) / rate
        rms = float(np.sqrt(np.mean(wave ** 2)))
        if rate != 24000 or wave.shape[1] != 1 or not .4 <= duration <= 20 or not np.isfinite(wave).all() or rms < .005:
            raise RuntimeError("Prepared audio failed format, duration or signal checks.")
        header = file.read_bytes()
        if header[:4] != b"RIFF" or header[8:12] != b"WAVE":
            raise RuntimeError("Prepared audio has no PCM WAV header.")
        result = {"file": file.name, "sampleRate": rate, "channels": 1, "seconds": round(duration, 3),
                  "rms": round(rms, 6), "bytes": file.stat().st_size,
                  "sha256": hashlib.sha256(header).hexdigest()}
        if generation_seconds is not None:
            result["generationSeconds"] = round(generation_seconds, 2)
        return result

    preview = args.output / "preview.wav"
    shutil.copyfile(args.preview, preview)
    metadata.append(measure(preview))
    entries[PREVIEW_TEXT] = preview.name
    reference_copy = args.output / "reference.wav"
    shutil.copyfile(args.reference, reference_copy)
    reference_metadata = {**measure(reference_copy), "role": "reference-only"}
    for text, filename in CLIPS:
        torch.manual_seed(42)
        clip_started = time.perf_counter()
        waves, rate = model.generate_voice_clone(
            text=text, language="Russian", ref_audio=str(args.reference.resolve()), ref_text=None,
            x_vector_only_mode=True, non_streaming_mode=True, max_new_tokens=192, temperature=.75)
        wave = np.asarray(waves[0], dtype=np.float32)
        file = args.output / filename
        sf.write(file, wave, rate, subtype="PCM_16")
        item = measure(file, time.perf_counter() - clip_started)
        metadata.append(item)
        entries[text] = filename
        print(json.dumps({"ok": True, **item}), flush=True)
    manifest = {"version": 1, "model": MODEL, "revision": REVISION, "language": "ru",
                "referenceSHA256": hashlib.sha256(args.reference.read_bytes()).hexdigest(),
                "generation": {"speakerOnly": True, "referenceText": False, "temperature": .75, "seed": 42},
                "referenceFile": reference_copy.name, "reference": reference_metadata,
                "loadSeconds": round(load_seconds, 2), "clips": entries, "audio": metadata,
                "similarity": "preview-approved-by-user; generated-clips-not-separately-reviewed"}
    (args.output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8")
    print(json.dumps({"ok": True, "clips": len(entries), "bytes": sum(item["bytes"] for item in metadata)}), flush=True)


if __name__ == "__main__":
    main()
