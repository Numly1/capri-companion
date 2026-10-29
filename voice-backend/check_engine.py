"""Download the public V3 weights and benchmark a generic Russian voice, not Capri."""
import argparse
import json
import time
from pathlib import Path

from server import VoiceService


def main():
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, default=root / ".tools" / "capri-voice")
    parser.add_argument("--output", type=Path,
                        default=root / ".tools" / "capri-voice" / "generic-ru-check.wav")
    args = parser.parse_args()
    service = VoiceService(root / "voice-reference" / "capri-reference.wav",
                           args.runtime, "cpu", 2)
    started = time.perf_counter()
    service._load()
    loaded = time.perf_counter()
    import soundfile as sf
    audio = service.model.generate("Привет. Я рядом.", language_id="ru", cfg_weight=0.0)
    generated = time.perf_counter()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(args.output, audio.squeeze(0).cpu().numpy(), service.model.sr,
             subtype="PCM_16")
    report = {"ok": True, "voice": "generic-model-default-not-capri", "device": service.device,
              "loadSeconds": round(loaded - started, 2),
              "generationSeconds": round(generated - loaded, 2),
              "audioSeconds": round(audio.shape[-1] / service.model.sr, 2),
              "bytes": args.output.stat().st_size}
    args.output.with_suffix(".json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
