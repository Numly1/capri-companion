# Voice module sources

The scripts in this folder are the local HTTP adapter, launcher and installer for Capri Companion. The archive does not contain the upstream model implementation, Python runtime, model weights, API keys or voice recordings. The installer fetches dependencies from their official distribution sources.

- [Chatterbox](https://github.com/resemble-ai/chatterbox), Resemble AI, MIT. Pinned source: `5de7a54aa4e5e2baadb0182dde554908b48b85c2`; [license](https://github.com/resemble-ai/chatterbox/blob/5de7a54aa4e5e2baadb0182dde554908b48b85c2/LICENSE).
- [PerTh](https://github.com/resemble-ai/Perth), Resemble AI, MIT. Pinned source: `ff1c8ac55a976971245cdd53c18d6131ca00d993`; [license](https://github.com/resemble-ai/Perth/blob/ff1c8ac55a976971245cdd53c18d6131ca00d993/LICENSE).
- [Public model weights](https://huggingface.co/ResembleAI/chatterbox) from Resemble AI. Tested model snapshot: `5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18`. Multilingual V3 uses `t3_mtl23ls_v3.safetensors`. The standard PerTh watermark is preserved.
- [uv 0.13.6](https://github.com/astral-sh/uv/releases/tag/0.13.6), Astral, MIT/Apache-2.0. Installer verifies the official Windows x64 archive SHA-256: `a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f`.
- [Python Standalone Builds](https://github.com/astral-sh/python-build-standalone) supplies the private Python selected through uv. No system Python or PATH changes are needed.

The pinned dependency list is `requirements.lock`; the installed packages retain their own licenses and notices. Rights in a supplied character voice recording remain with their respective holders. No Capri reference recording is included.
