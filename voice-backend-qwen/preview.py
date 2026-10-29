"""Isolated, opt-in Qwen3-TTS voice experiment. Never changes the desktop app's voice."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--reference', type=Path)
    parser.add_argument('--reference-text', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--download-only', action='store_true')
    parser.add_argument('--model', choices=['0.6B', '1.7B'], default='0.6B')
    args = parser.parse_args()
    runtime = args.runtime.resolve()
    runtime.mkdir(parents=True, exist_ok=True)
    for name, folder in {'HF_HOME': 'hf-cache', 'TORCH_HOME': 'torch-cache',
                         'NUMBA_CACHE_DIR': 'numba-cache', 'XDG_CACHE_HOME': 'cache'}.items():
        os.environ[name] = str(runtime / folder)
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN'] = '1'
    os.environ['DO_NOT_TRACK'] = '1'
    os.environ['OMP_NUM_THREADS'] = '2'
    os.environ['MKL_NUM_THREADS'] = '2'
    from huggingface_hub import HfApi, snapshot_download
    model_id = f'Qwen/Qwen3-TTS-12Hz-{args.model}-Base'
    revision_file = runtime / ('model-revision.json' if args.model == '0.6B' else 'model-revision-1.7B.json')
    if revision_file.is_file():
        revision = json.loads(revision_file.read_text('utf-8'))['revision']
    else:
        revision = HfApi().model_info(model_id, token=False).sha
        revision_file.write_text(json.dumps({'model': model_id, 'revision': revision}, indent=2), 'utf-8')
    model_path = snapshot_download(model_id, revision=revision, token=False,
                                   allow_patterns=['*.json', '*.safetensors', '*.txt', '*.model', '*.npz'],
                                   max_workers=3)
    print(json.dumps({'downloaded': True, 'model': model_id, 'revision': revision}), flush=True)
    if args.download_only:
        return
    if not args.reference or not args.reference.is_file() or not args.output:
        parser.error('Reference audio and output path are required.')
    import numpy as np
    import soundfile as sf
    import torch
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    torch.manual_seed(42)
    from qwen_tts import Qwen3TTSModel
    started = time.perf_counter()
    model = Qwen3TTSModel.from_pretrained(model_path, device_map='cpu', dtype=torch.float32,
                                         attn_implementation='sdpa', local_files_only=True)
    loaded = time.perf_counter()
    transcript = args.reference_text.read_text('utf-8').strip() if args.reference_text else None
    wavs, sample_rate = model.generate_voice_clone(
        text='Мы рядом. Продолжай, художница.', language='Russian',
        ref_audio=str(args.reference.resolve()), ref_text=transcript,
        x_vector_only_mode=not bool(transcript), non_streaming_mode=True,
        max_new_tokens=192, temperature=0.75,
    )
    generated = time.perf_counter()
    wave = np.asarray(wavs[0], dtype=np.float32)
    if wave.ndim != 1 or len(wave) < sample_rate // 2 or not np.isfinite(wave).all():
        raise RuntimeError('Generated audio is invalid.')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(args.output, wave, sample_rate, subtype='PCM_16')
    report = {'ok': True, 'model': model_id, 'revision': revision, 'device': 'cpu', 'threads': 2,
              'loadSeconds': round(loaded - started, 2), 'generationSeconds': round(generated - loaded, 2),
              'sampleRate': sample_rate, 'audioSeconds': round(len(wave) / sample_rate, 2),
              'rms': round(float(np.sqrt(np.mean(wave ** 2))), 6), 'bytes': args.output.stat().st_size,
              'referenceSHA256': hashlib.sha256(args.reference.read_bytes()).hexdigest(),
              'referenceTextUsed': bool(transcript), 'similarity': 'not-assessed-by-human'}
    args.output.with_suffix('.json').write_text(json.dumps(report, indent=2), 'utf-8')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
