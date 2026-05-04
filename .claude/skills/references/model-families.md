# Model Family Presets

These are the currently accepted family mappings derived from `D:\AI\MOD\custom_nodes\GJJ\nodes\lazy_Image_studio.py`.

## Shared lookup policy

For all families below, model resolution should prefer dynamic ComfyUI category lookup instead of hardcoded root-only filenames.

Preferred resolution order:
- exact category entry match
- basename match across subdirectory entries
- first safe filtered candidate in the intended family

Relevant runtime categories:
- `checkpoints`
- `clip`
- `clip_vision`
- `controlnet`
- `loras`
- `vae`
- `unet`
- `upscale_models`
- `embeddings`
- `hypernetworks`

Important note:
- category listings returned by `folder_paths.get_filename_list(...)` may already include subdirectory-relative paths
- these should be treated as first-class valid model names, not flattened away

## Qwen Image Edit 2511

- Keywords: `qwen_image_edit_2511`
- CLIP type: `qwen_image`
- CLIP: `qwen_2.5_vl_7b_fp8_scaled.safetensors`
- VAE: `qwen_image_vae.safetensors`
- LoRA 1: `QWEN\lighting\Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` at `1.0`
- LoRA 2: `QWEN\qwen-edit-remove-clothes_NSFW.safetensors` at `0.0`
- Defaults: `steps=4`, `cfg=1.0`, `sampler=euler`, `scheduler=simple`, `denoise=1.0`
- Extras: `model_sampling=aura`, `shift=3.1`, `cfg_norm_strength=1.0`, supports multi-image edit

## RealFire

- Classification: strong image-editing family
- Intended use: high-strength image editing, character redesign, clothing replacement, strong guided transformation
- Priority: treat closer to `qwen_image_edit` than to generic text-to-image families when deciding which models are suitable for image-edit nodes
- Current status: local exact filenames, encoder pairing, VAE pairing, and official default sampler parameters are not yet captured in this reference
- Action when details become available: add the concrete UNET keyword match, CLIP type, text encoder set, VAE, recommended LoRA, and official default `steps/cfg/sampler/scheduler/denoise`

## Qwen Image Edit

- Keywords: `qwen_image_edit`
- CLIP type: `qwen_image`
- CLIP: `qwen_2.5_vl_7b_fp8_scaled.safetensors`
- VAE: `qwen_image_vae.safetensors`
- LoRA 1: `QWEN\lighting\Qwen-Image-Lightning-4steps-V1.0.safetensors` at `1.0`
- LoRA 2: `QWEN\qwen-edit-remove-clothes_NSFW.safetensors` at `0.7`
- Defaults: `steps=4`, `cfg=1.0`, `sampler=euler`, `scheduler=simple`, `denoise=1.0`
- Extras: `model_sampling=aura`, `shift=3.0`, `cfg_norm_strength=1.0`, supports multi-image edit

## Qwen Image 2512

- Keywords: `qwen_image_2512`
- CLIP type: `qwen_image`
- CLIP: `qwen_2.5_vl_7b_fp8_scaled.safetensors`
- VAE: `qwen_image_vae.safetensors`
- LoRA 1: `QWEN\lighting\Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors` at `1.0`
- Defaults: `steps=4`, `cfg=2.5`, `sampler=euler`, `scheduler=simple`, `denoise=1.0`
- Extras: `model_sampling=aura`, `shift=3.1`, `cfg_norm_strength=1.0`

## Qwen Image

- Keywords: `qwen_image_distill`, `qwen_image_fp8`, `qwen_image_bf16`, `qwen_image_`
- CLIP type: `qwen_image`
- CLIP: `qwen_2.5_vl_7b_fp8_scaled.safetensors`
- VAE: `qwen_image_vae.safetensors`
- LoRA 1: `QWEN\Qwen-Image-Lightning-8steps-V1.0.safetensors` at `1.0`
- Defaults: `steps=8`, `cfg=2.5`, `sampler=euler`, `scheduler=simple`, `denoise=1.0`
- Extras: `model_sampling=aura`, `shift=3.1`, `cfg_norm_strength=1.0`

## Qwen Image Layered

- Keywords: `qwen_image_layered`
- CLIP type: `qwen_image`
- CLIP: `qwen_2.5_vl_7b_fp8_scaled.safetensors`
- VAE: `qwen_image_layered_vae.safetensors`
- Defaults: `steps=50`, `cfg=4.0`, `sampler=euler`, `scheduler=simple`, `denoise=1.0`, `width=640`, `height=640`

## Lotus Depth

- Keywords: `lotus-depth-`
- CLIP type: `qwen_image`
- CLIP: `qwen_2.5_vl_7b_fp8_scaled.safetensors`
- VAE: `lvae-ft-mse-840000-ema-pruned.safetensors`
- LoRA 1: `qwen_image_union_diffsynth_lora.safetensors` at `1.0`
- Defaults: `steps=20`, `cfg=1.0`, `sampler=euler`, `scheduler=beta57`, `denoise=1.0`

## Flux2 Klein 9B

- Keywords: `flux-2-klein-9b`, `flux-2-klein-base-9b`
- CLIP type: `flux2`
- CLIP: `qwen_3_8b_fp8mixed.safetensors`
- VAE: `flux2-vae.safetensors`
- Defaults: `steps=20`, `cfg=1.0`, `sampler=euler`, `scheduler=beta57`, `denoise=0.75`

## Flux2 Klein 4B

- Keywords: `flux-2-klein-base-4b`, `flux-2-klein-4b`
- CLIP type: `flux2`
- CLIP: `qwen_3_4b.safetensors`
- VAE: `flux2-vae.safetensors`
- Defaults: `steps=20`, `cfg=1.0`, `sampler=euler`, `scheduler=beta57`, `denoise=0.75`

## Flux2 Dev

- Keywords: `flux2_dev`
- CLIP type: `flux2`
- CLIP: `mistral_3_small_flux2_bf16.safetensors`
- VAE: `full_encoder_small_decoder.safetensors`
- LoRA 1: `Flux2\Flux2TurboComfyv2.safetensors` at `1.0`
- Defaults with turbo LoRA: `steps=8`, `cfg=1.0`, `sampler=euler`, `scheduler=beta57`, `denoise=0.75`
- Base steps without acceleration LoRA: `20`

## Flux1 families

Common rules:
- CLIP type: `flux`
- Fixed internal encoder: `clip_l.safetensors`
- User-visible optional encoder should default to the recommended T5 variant for the family
- VAE: `ae.safetensors`

Families:
- `flux1-krea-dev` -> optional T5 default `t5xxl_fp8_e4m3fn.safetensors`
- `flux1-dev-kontext` -> optional T5 default `t5xxl_fp8_e4m3fn_scaled.safetensors`
- `flux1-fill-dev` -> optional T5 default `t5xxl_fp16.safetensors`
- `flux1-canny-dev` -> optional T5 default `t5xxl_fp16.safetensors`
- `flux1-schnell` -> optional T5 default `t5xxl_fp8_e4m3fn.safetensors`, `steps=8`
- `flux1-dev` -> optional T5 default `t5xxl_fp16.safetensors`, LoRA 1 default `flux1-depth-dev-lora.safetensors` at `1.0`

Default sampler block for Flux1 families unless overridden:
- `steps=20`, `cfg=1.0`, `sampler=euler`, `scheduler=normal`, `denoise=0.75`

## Z-Image

- CLIP type: `lumina2`
- CLIP: `qwen_3_4b.safetensors`
- VAE: `ae.safetensors`

Variants:
- `z_image_turbo` -> `steps=8`, `cfg=1.0`, `sampler=res_multistep`, `scheduler=simple`, `denoise=1.0`, `model_sampling=aura`, `shift=3.0`
- `z_image` -> `steps=25`, `cfg=4.0`, `sampler=res_multistep`, `scheduler=simple`, `denoise=1.0`, `model_sampling=aura`, `shift=3.0`

## NewBie

- Keywords: `newbie-image-exp0.1`
- CLIP type: `newbie`
- CLIPs: `gemma_3_4b_it_bf16.safetensors`, `jina_clip_v2_bf16.safetensors`
- VAE: `ae.safetensors`
- Defaults: `steps=20`, `cfg=1.0`, `sampler=euler`, `scheduler=beta57`, `denoise=1.0`

## Ovis

- Keywords: `ovis_image`
- CLIP type: `ovis`
- CLIP: `ovis_2.5.safetensors`
- VAE: `ae.safetensors`
- Defaults: `steps=20`, `cfg=1.0`, `sampler=euler`, `scheduler=beta57`, `denoise=1.0`

## HiDream

Shared encoders:
- `clip_l_hidream.safetensors`
- `clip_g_hidream.safetensors`
- `t5xxl_fp8_e4m3fn_scaled.safetensors`
- `llama_3.1_8b_instruct_fp8_scaled.safetensors`
- CLIP type: `hidream`
- VAE: `ae.safetensors`

Variants:
- `hidream_i1_full` -> `steps=50`, `cfg=5.0`, `sampler=uni_pc`, `scheduler=simple`, `denoise=1.0`, `model_sampling=sd3`, `shift=3.0`
- `hidream_i1_dev` -> `steps=28`, `cfg=1.0`, `sampler=lcm`, `scheduler=normal`, `denoise=1.0`, `model_sampling=sd3`, `shift=6.0`
- `hidream_i1_fast` -> `steps=16`, `cfg=1.0`, `sampler=lcm`, `scheduler=normal`, `denoise=1.0`, `model_sampling=sd3`, `shift=3.0`
- `hidream_e1` -> `steps=28`, `cfg=1.0`, `sampler=lcm`, `scheduler=normal`, `denoise=1.0`, `model_sampling=sd3`, `shift=6.0`

## OmniGen2

- Keywords: `omnigen2`
- CLIP type: `omnigen2`
- CLIP: `qwen_2.5_vl_fp16.safetensors`
- VAE: `ae.safetensors`
- Defaults: `steps=20`, `cfg=1.0`, `sampler=euler`, `scheduler=beta57`, `denoise=1.0`
