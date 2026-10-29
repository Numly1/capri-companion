"""Local-only transcription helper for the supplied reference WAV; no cloud/API keys."""
import argparse
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('input', type=Path)
parser.add_argument('--runtime', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--language', choices=['en', 'ru'], default='en')
args = parser.parse_args()
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN'] = '1'
from faster_whisper import WhisperModel
model = WhisperModel('base', device='cpu', compute_type='int8', cpu_threads=2,
                     download_root=str(args.runtime / 'asr-models'), local_files_only=True)
segments, info = model.transcribe(str(args.input), language=args.language, beam_size=5, vad_filter=False)
transcript = ' '.join(segment.text.strip() for segment in segments)
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(transcript, 'utf-8')
print(json.dumps({'ok': True, 'language': info.language, 'characters': len(transcript)}))
