# Sources for the optional approved voice module

- [Official Qwen3-TTS code](https://github.com/QwenLM/Qwen3-TTS)
- [Official Qwen3-TTS-12Hz-1.7B-Base model](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base)
- Model revision: `fd4b254389122332181a7c3db7f27e918eec64e3`.
- Model license: Apache 2.0, as declared in the official model card. The installer downloads the original weights; this small module archive does not contain them.
- [uv official release 0.13.6](https://github.com/astral-sh/uv/releases/tag/0.13.6). The Windows x64 ZIP is checked against SHA256 `a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f` before extraction.
- Private Python version: 3.11.18, installed by uv with `--no-bin --no-registry`.

Voice reference comes from the user's supplied video. The user confirmed the selected source fragment and approved the latest generated speaker-only sample as closer to the intended voice. Earlier Chatterbox and Qwen 0.6B samples were rejected and are not activated by this module.

No voice reference, user API key, model weights, cache audio or personal settings are included by these installer scripts. The application supplies the approved reference locally. The model's output is synthetic; similarity still depends on the reference and generated text.
