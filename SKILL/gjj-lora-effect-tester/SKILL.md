---
name: gjj-lora-effect-tester
description: Use when editing or rewriting the GJJ LoRA effect tester node in ComfyUI, especially when the node outputs LORA_CHAIN_CONFIG plus live text status, filters LoRA lists, runs auto queues, or marks pass/fail results for each LoRA.
---

# GJJ LoRA Effect Tester

Use this skill when working on `GJJ · 🧪 LoRA效果测试` or related GJJ LoRA batch-test nodes.

## Core Contract

- Keep the execution payload separate from display text.
- Output `LORA_CHAIN_CONFIG` with raw subdirectory-relative filenames and numeric strengths only:

```json
[{"enabled": true, "name": "SDXL\\644.safetensors", "strength": 1.0}]
```

- Never include `✅`, `❌`, `(1.00)` display prefixes, extensionless names, or slash-to-underscore names in the actual LoRA config.
- Use display labels only for text/list/annotation outputs:

```text
✅ (1.00)SDXL_644
❌ (0.75)Flux1_some_lora
```

- Use one serialized state widget, for example `test_state`, instead of many hidden widgets such as `auto_execute`, `skip_errors`, `filter_keywords`, `strength_values`, `passed_items`, `failed_items`, and `refresh_token`.
- If backend input contract changes, old workflows can retain stale `widgets_values`; instruct the user to delete and re-add the node once after restart.

## State And UI

- Store filter text, selected strengths, pass/fail keys, auto-run, skip-errors, and refresh token inside `test_state`.
- Keep current index default at `1`.
- Do not rely on `control_after_generate` for current index; let frontend update index after each result.
- On filter, refresh, or strength change:
  - reload or recompute the filtered LoRA pool,
  - reset current index to `1`,
  - clear pass/fail lists,
  - write backing state and `widgets_values`,
  - push fresh live text to linked preview nodes.
- Empty filter means all LoRAs.
- Support fuzzy filter syntax:
  - `&`, `+`, `＋` mean all groups must match,
  - comma, Chinese comma, semicolon, pipe, or ideographic comma mean any keyword inside that group may match.

## Hidden Widgets

- Hide only true backing state widgets.
- For hidden widgets, set `hidden`, `computeSize`, `getHeight`, `draw`, and offscreen `y`.
- Remove converted input sockets for hidden/obsolete widgets.
- Do not leave empty layout gaps.
- Do not reorder visible widgets just to solve stale state; reduce state surface instead.

## Success And Failure

- Track only nodes connected to the `LORA_CHAIN_CONFIG` output as test consumers.
- Mark `✅` when the connected generation consumer reports `executed`.
- Mark `❌` when that consumer errors or emits a matching `gjj_lora_failed`.
- If the consumer already succeeded, later unrelated errors from save/collage/preview/side branches must not change the LoRA from `✅` to `❌`.
- When skip-errors is enabled, advance to the next item after marking `❌`.
- Treat Comfy log warnings like `lora key not loaded:` as test failures when the purpose is compatibility testing.
- Do not infer failure from global `execution_error` alone unless it is from the current consumer or the consumer result is unknown.

## Live Preview

- Keep linked `GJJ_AnyPreview` text live for:
  - current raw config,
  - current display name,
  - filtered status list,
  - total count.
- Push live text after filter, refresh, strength change, pass/fail mark, and index advance.
- The preview list may contain `✅`/`❌`; the raw config preview must not.

## Validation

- Run frontend syntax validation:

```powershell
node --check .\js\GJJ_LoraEffectTester.js
```

- Run backend syntax validation:

```powershell
python -m py_compile .\nodes\gjj_lora_effect_tester.py .\nodes\multi_lora_chain.py .\nodes\checkpoint_direct_generator.py
```

- In ComfyUI, verify with `GJJ_AnyPreview` that output `0` is raw JSON and output `2` is the status list before testing auto-run.
