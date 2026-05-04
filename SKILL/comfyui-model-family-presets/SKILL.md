---
name: comfyui-model-family-presets
description: Use when creating or updating GJJ/ComfyUI generation nodes that must auto-match UNET to the correct CLIP type, text encoders, VAE, recommended LoRA, and official default sampler parameters. Prefer this skill when porting official workflows into lazy all-in-one nodes.
---

# ComfyUI Model Family Presets

Use this skill when a GJJ or ComfyUI node needs to infer the correct model bundle from a selected UNET and stay aligned with official workflow defaults.

## Source of truth

Current implementation source:
- `D:\AI\MOD\custom_nodes\GJJ\nodes\lazy_Image_studio.py`

Official workflow references live under:
- `D:\AI\MOD\user\default\workflows\官方工作流`

Official ComfyUI documentation has the highest authority for base behavior and contracts:
- `https://docs.comfy.org/`

If you update a node and the runtime behavior disagrees with this skill, reconcile it against `lazy_Image_studio.py` and the official workflow JSONs.

## Core reuse rules

1. Match the selected UNET against a model family preset first.
2. Derive `clip_type` from the model family, not only from the visible CLIP widget.
3. Auto-pick the recommended text encoders and VAE for the family.
4. If the family has a recommended acceleration LoRA, preload it as the default visible LoRA.
5. If an enabled LoRA name implies step count, override steps automatically.
6. Keep front-end widgets minimal: expose only the optional part of the encoder set when the family has fixed mandatory encoders.
7. Prefer dynamic model discovery over hardcoded root-only filenames. Search the intended model category and its returned subdirectory entries first.
   Unless the user explicitly says otherwise, treat subdirectory-aware fuzzy matching as the default lookup policy for all model categories.
8. Keep model-family wrappers zero-dependency by default.
   - do not rely on third-party custom-node helper functions
   - avoid optional external Python packages unless explicitly approved
   - prefer ComfyUI core, comfy_extras, and GJJ-local helper code only

## Model directory map

Treat these ComfyUI model folders as the default lookup categories:

- `checkpoints/`
  Main Stable Diffusion checkpoint models such as `.ckpt` or `.safetensors`
- `clip/`
  CLIP text-image alignment models
- `clip_vision/`
  CLIP Vision models for image understanding
- `controlnet/`
  ControlNet models
- `loras/`
  LoRA models
- `vae/`
  VAE models
- `unet/`
  UNet models
- `upscale_models/`
  Upscale models
- `embeddings/`
  Textual inversion / embedding models
- `hypernetworks/`
  Hypernetwork models

Important environment note:
- In this machine, `ComfyUI\models` is mapped to `D:\AI\MOD\models`.
- Always treat `folder_paths.models_dir` as the real source of truth for the active model root.
- Do not hardcode `D:\AI\CUI\ComfyUI\models` when implementing lookup logic.

Other runtime-relevant paths to remember:

- `input/`
  Uploaded source images
- `output/`
  Saved generated images
- `custom_nodes/`
  Custom node packages
- `config/`
  Runtime configs
- `user/`
  User config and workflow data
- `extra_model_paths.yaml`
  Extra model roots; treat this as valid path expansion for all model categories when the runtime exposes them through `folder_paths`

## Dynamic lookup rules

When selecting or auto-matching models:

1. Use ComfyUI's runtime category listing first, not manual filesystem scanning, whenever possible.
   Preferred pattern:
   - `folder_paths.get_filename_list(<category>)`
   - `folder_paths.get_full_path(...)`
   - `folder_paths.get_full_path_or_raise(...)`
   - `folder_paths.models_dir`

2. Assume category listings may already include subdirectory-relative entries.
   Examples:
   - `SD1.5\\control_v11p_sd15_scribble_fp16.safetensors`
   - `QWEN\\lighting\\Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors`

3. When resolving defaults, match in this order:
   - exact full entry match
   - basename match across subdirectories
   - longest common continuous filename fragment after removing the model extension
   - first filtered candidate in the intended family only when the node intentionally allows a family fallback

4. Preserve source workflow filenames as lookup seeds.
   Do not manually shorten a source model name before matching.
   Users often rename local files by appending Chinese notes or trigger hints, so compare the extensionless source stem against extensionless local stems in `D:\AI\MOD\models\<category>` through `folder_paths`.
   Prefer the candidate with the longest common continuous fragment, with exact path, exact basename, and full source-stem substring matches outranking partial matches.
   Reject generic short matches such as only `ltx`, `ltx23`, or `ltx2.3`; unresolved defaults should raise a clear Chinese missing-model error instead of silently picking the wrong file.
   When no trustworthy local match exists, keep the source workflow slot and use the original source filename with only the extension removed as the unresolved keyword, for example `VBVR-LTX2.3.safetensors` becomes `VBVR-LTX2.3`.

5. Avoid root-only assumptions.
   If the preferred default is `control_v11f1p_sd15_depth_fp16.safetensors`, allow it to resolve to a subdirectory entry whose basename matches.

6. Prefer filtered lists for user-facing dropdowns when only some models are known-good.
   This is especially useful for packaged workflow nodes where most unrelated checkpoints will fail.

7. If filesystem fallback is necessary, include subdirectories recursively and normalize:
   - case-insensitive
   - ignore `\\ / _ - .` when doing fuzzy family matching
   - prefer only the roots surfaced by ComfyUI runtime mapping (`folder_paths`, `extra_model_paths.yaml`)
   - do not hardcode arbitrary local absolute paths if the environment uses mapped model roots

8. Keep visible widgets minimal.
   Internal mandatory pairings like fixed CLIP encoders should stay inside the node unless the user explicitly needs to override them.

9. Some categories such as `ipadapter` are not core-default categories.
   - If a vendored runtime depends on a custom model category, register that category against `os.path.join(folder_paths.models_dir, "<category>")`
   - This allows mapped roots (like `D:\AI\MOD\models`) to work automatically without hardcoded absolute paths

## Step override rules

- If an enabled LoRA name contains `8step`, force `steps = 8`.
- If an enabled LoRA name contains `4step`, force `steps = 4`.
- Treat `Flux2TurboComfyv2` as an 8-step acceleration LoRA even though the filename does not literally contain `8step`.
- If a family defines `base_steps` and no acceleration LoRA is enabled, fall back to `base_steps`.

## CLIP exposure rules

- Qwen Image / HiDream / Ovis / OmniGen2 / Flux2 families usually have fixed encoder sets and should be auto-matched internally.
- Flux1 dual-encoder families should expose only the variable T5 choice on the panel.
  Internal fixed encoder: `clip_l.safetensors`
  User-visible optional encoder: one of the recommended `t5xxl*` variants.

## Model family references

Read [references/model-families.md](references/model-families.md) when you need the concrete UNET-to-CLIP/VAE/LoRA/default-parameter mapping.

## Known strong edit families

Treat these as strong image-editing families first, not generic text-to-image defaults:
- `qwen_image_edit`
- `qwen_image_edit_2511`
- `realfire`

When building a node for character editing, outfit replacement, pose-conditioned redesign, or multi-view character turnarounds, prefer these families over generic text-to-image checkpoints.

If `realfire` is present locally but its exact filenames or official workflow defaults are not yet captured, keep it classified as a strong edit model family and fill in the concrete UNET/CLIP/VAE/default-parameter mapping once the local filenames or workflow JSON are available.

## Implementation guidance for GJJ nodes

- Prefer reusing or porting these helpers from `lazy_Image_studio.py` instead of rewriting ad-hoc matching logic:
  - `match_model_family`
  - `resolve_clip_type`
  - `resolve_clip_names_for_preset`
  - `_resolve_effective_steps`
- Prefer this lookup shape when a default model may be inside a subdirectory:
  - list category entries dynamically
  - resolve exact name first
  - then resolve by basename
  - only then fall back to the first safe filtered candidate
- For all model categories, treat basename match across subdirectories as the normal fallback, not a special case.
  If the user says “模型都是用子目录模糊查找”, implement that as the default lookup rule.
- Keep Chinese tooltips on user-facing inputs, but model family ids and filenames should stay literal.
- When a node wraps an official workflow, preserve the official sampler/scheduler/CFG defaults unless the user explicitly asks to change them.

## Validation checklist

- Selecting a UNET auto-fills the intended CLIP/VAE pair for that family.
- Fixed encoder families do not expose redundant CLIP widgets.
- Flux1 families expose only the optional T5 selector.
- Acceleration LoRA toggles change `steps` as expected.
- Defaults match the corresponding official workflow JSON or the current `lazy_Image_studio.py` preset table.

## Multi-angle edit LoRA rule

When a node uses a dedicated multi-angle / multi-view edit LoRA such as `qwen-image-edit-2511-multiple-angles-lora`:
- allow the frontend to stay in Chinese, but translate recognized view prompts into the LoRA's expected trigger form internally

## LTX transition LoRA rule

For LTX 2.3 transition workflows, the transition LoRA `ltx2.3-transition-转场-强度1-触发词-zhuanchang.safetensors` must be treated as a trigger LoRA:
- effective LoRA strength should be `1.0`
- the positive prompt must include the literal trigger word `zhuanchang`
- GJJ wrapper nodes may auto-inject `zhuanchang` when an enabled LTX transition LoRA is detected, and should report that in the node status so the user knows why the prompt changed

## LTX multi-reference latent anchoring

For LTX multi-reference image-to-video wrappers, KJNodes' `LTXVImgToVideoInplaceKJ` pattern is useful: encode each reference image into the video latent at its target frame and update the latent `noise_mask` from the reference strength.
- Prefer inlining the small equivalent logic inside GJJ instead of importing `comfyui-kjnodes`, so the GJJ node pack remains portable.
- Keep `LTXVAddGuide` or equivalent guide conditioning active; latent inplace anchoring is an additional stability layer, not a replacement for time guide conditioning.
- Apply the anchoring at both low-resolution stage setup and high-resolution stage setup when the workflow has two sampling stages.
- prefer an internal trigger format like `<sks> front-right quarter view eye-level shot wide shot`
- dedupe view jobs by a full signature of `view + camera angle + framing + outfit`, not by a coarse `45 degree` bucket
- distinguish at least:
  - `front`
  - `front_right`
  - `right`
  - `back_right`
  - `back`
  - `back_left`
  - `left`
  - `front_left`
- keep `换装` or alternate outfit as a separate signature dimension so outfit variants are not mistakenly removed as duplicates

## Action-reference mode rule

For character edit / multi-view nodes that accept both a main character image and a pose-action reference image:
- when an action reference image is connected, switch to action-reference mode
- in action-reference mode, do not let action text override pose control
- prefer a direct English control instruction such as:
  `Make the person in Picture 1 adopt the pose, body direction, camera angle, framing, and composition of Picture 2. Preserve the identity, face, hairstyle, clothing details, and overall style of Picture 1.`
- if a multi-angle LoRA conflicts with the action reference, disable that LoRA for the run
- do not dedupe away jobs that have distinct action reference images; treat each referenced action image as a unique generation job even if the text is blank or similar

## Qwen multi-image edit main-image rule

For Qwen multi-image edit workflows such as `qwen_image_edit_2511`:
- when there is both a character identity image and an action / pose reference image,
  the action reference image should be the main VL image / main reference latent input for pose control
- the character image should remain as the identity-consistency reference, not the main pose-driving image
- if these roles are reversed, pose transfer will look weak or fail, while identity may dominate too strongly
- remember this especially for character multiview nodes: action image drives pose, camera, and composition; character image preserves identity, face, hairstyle, clothing details, and style consistency

## Qwen dual-reference implementation note

For `qwen_image_edit_2511` style character editing:
- feed both identity image and pose/action image into VL
- feed both images into reference latents
- choose the action image as `ref_main_image` / main latent output
- keep the identity image as the secondary reference latent for face, hairstyle, clothing, and style consistency
- this matches the `full_refs_cond` style workflow used by `QwenEditConfigPreparer` + `TextEncodeQwenImageEditPlusCustom`
- do not reuse generic helper limits like `MAX_IMAGES = 8` for action-image collection in multiview wrappers; collect action references independently

## Character multiview wrapper rules

For packaged character multiview nodes built on top of `qwen_image_edit_2511`:
- if action reference images are connected, generate one job per action image directly
- do not let blank or repeated action text collapse those jobs
- do not count the main identity image as one of the action-reference slots
- if the UI exposes `动作图 1..9`, the backend collector must independently read all 9 action-image kwargs instead of reusing a generic `collect_image_pairs()` helper that was written for another node
- when composing the final sheet, prefer height-fit + horizontal centering inside each cell so heads and feet are not cropped by aggressive fill logic
- when progress text is available, surface at least:
  - detected action reference count
  - actual generation job count
  - final collage image count

## Small-helper dependency rule

When a GJJ packaged node only needs a tiny helper such as `conditioning_set_values`:
- prefer inlining a local private helper inside the node file instead of depending on external utility modules
- do this especially when the external helper is not guaranteed to exist in every runtime or custom-node environment
- validate the node again with `python -m py_compile` after removing the dependency
