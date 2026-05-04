# ComfyUI-LatentSyncEnhanced

An enhanced lip-sync node for ComfyUI, built on top of [ByteDance LatentSync 1.6](https://github.com/bytedance/LatentSync).

Improvements over the original wrapper:

| Feature | Original | Enhanced |
|---------|----------|----------|
| Frame with no face | ❌ Crashes | ✅ Warning + pass-through |
| All frames have no face | ❌ Crashes | ✅ Warning + return original video |
| Model path | Node's own `checkpoints/` symlink | ✅ ComfyUI standard `models/checkpoints/LatentSync-1.6/` |
| OOM on long videos | ❌ Possible | ✅ Configurable `chunk_frames` (default 80, safe for 24 GB VRAM) |

---

## Prerequisites

This node is **fully self-contained** — no other custom nodes are required.
The `latentsync` inference library is bundled directly inside this package.

---

## Model Download & Storage

### Required model files

| File | Size | Purpose |
|------|------|---------|
| `latentsync_unet.pt` | ~4.8 GB | Main lip-sync UNet |
| `whisper/tiny.pt` | ~72 MB | Audio feature extractor |
| `vae/` (directory) | ~320 MB | VAE encoder/decoder |

### Where to place them

All model files go inside ComfyUI's standard **checkpoints** folder, under a subdirectory named `LatentSync-1.6`:

```
ComfyUI/
└── models/
    └── checkpoints/
        └── LatentSync-1.6/          ← create this folder
            ├── latentsync_unet.pt
            ├── whisper/
            │   └── tiny.pt
            └── vae/
                ├── config.json
                └── diffusion_pytorch_model.safetensors
```

### Download from Hugging Face

```bash
# Option 1 – huggingface-cli (recommended)
pip install huggingface_hub
huggingface-cli download ByteDance/LatentSync-1.6 \
    latentsync_unet.pt \
    whisper/tiny.pt \
    vae/config.json \
    vae/diffusion_pytorch_model.safetensors \
    --local-dir ComfyUI/models/checkpoints/LatentSync-1.6

# Option 2 – manual download
# Visit: https://huggingface.co/ByteDance/LatentSync-1.6
# Download the files above and place them as shown.
```

---

## Node Inputs

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `images` | IMAGE | — | Input video frames |
| `audio` | AUDIO | — | Input audio (any sample rate, auto-resampled to 16 kHz) |
| `seed` | INT | 1247 | Random seed for reproducibility |
| `lips_expression` | FLOAT | 1.5 | Lip movement strength (guidance scale). Range: 1.0–3.0 |
| `inference_steps` | INT | 20 | Diffusion denoising steps. More = slower but higher quality |
| `chunk_frames` | INT | 80 | Frames per processing segment. **Reduce if you hit OOM.** |

### chunk_frames guide (VRAM)

| VRAM | Recommended `chunk_frames` |
|------|---------------------------|
| 24 GB | 80 (default) |
| 16 GB | 48 |
| 12 GB | 32 |
| 8 GB | 16 |

---

## Node Outputs

| Output | Type | Description |
|--------|------|-------------|
| `images` | IMAGE | Lip-synced video frames |
| `audio` | AUDIO | Input audio resampled to 16 kHz |

---

## How no-face frames are handled

- **Some frames have no face**: those frames are passed through unchanged (original pixels). Surrounding frames' face-alignment data is used as nearest-neighbour fallback for the diffusion input so the audio sequence stays intact.
- **All frames have no face**: a warning is printed and the original video is returned as-is (no lip-sync applied, no crash).

---

## Video length vs audio length

Handled automatically inside the pipeline:

| Situation | Behaviour |
|-----------|-----------|
| Audio longer than video | Video is **ping-pong looped** to match audio length |
| Video longer than audio | Video is **trimmed** to audio length |

---

## License

Apache 2.0 — same as the underlying LatentSync model.
