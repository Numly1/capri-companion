"""Import a supplied speech clip as a mono PCM WAV without uploading it anywhere."""
import argparse
import json
import os
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    root = Path(__file__).resolve().parent.parent
    parser.add_argument("input", type=Path)
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--seconds", type=float, default=10.0)
    parser.add_argument("--output", type=Path,
                        default=Path(os.environ.get("APPDATA", str(root))) / "CapriCompanion" / "voice-reference.audio")
    args = parser.parse_args()
    if not 0 <= args.start or not 3 <= args.seconds <= 15:
        parser.error("Use a nonnegative start and a 3-15 second clean speech segment.")
    if not args.input.is_file() or args.input.stat().st_size > 100 * 1024**2:
        parser.error("Input must be an existing audio file smaller than 100 MiB.")
    if args.input.resolve() == args.output.resolve():
        parser.error("Input and output must differ; keep the original clip.")
    import numpy as np
    import soundfile as sf
    info = sf.info(args.input)
    frames = int(args.seconds * info.samplerate)
    start = int(args.start * info.samplerate)
    audio, rate = sf.read(args.input, start=start, frames=frames, always_2d=True)
    audio = audio.mean(axis=1)
    if len(audio) < 3 * rate or np.max(np.abs(audio)) < 0.005:
        parser.error("The selected segment is too short or silent.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(".tmp.wav")
    sf.write(temporary, audio, rate, format="WAV", subtype="PCM_16")
    os.replace(temporary, args.output)
    print(json.dumps({"ok": True, "seconds": round(len(audio) / rate, 2),
                      "sampleRate": rate, "channels": 1, "path": str(args.output)}))


if __name__ == "__main__":
    main()
