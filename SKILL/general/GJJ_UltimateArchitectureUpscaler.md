# GJJ_UltimateArchitectureUpscaler

## 📋 概述

**功能**: 将基础超分、建筑装饰细节增强提示词、Ultimate 分块重绘与接缝修复整合成单节点放大流程。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_ultimate_architecture_upscaler.py` | `GJJ_UltimateArchitectureUpscaler` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_UltimateArchitectureUpscaler` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `upscale` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `IMAGE` | `-` | ✓ |  |
| `model` | `MODEL` | `-` | ✓ |  |
| `clip` | `CLIP` | `-` | ✓ |  |
| `vae` | `VAE` | `-` | ✓ |  |
| `detail_preset` | `DETAIL_PRESET_OPTIONS` | `室内硬装` | ✓ |  |
| `positive` | `STRING` | `` | ✓ |  |
| `negative` | `STRING` | `DEFAULT_NEGATIVE_PROMPT` | ✓ |  |
| `enable_upscale_model` | `BOOLEAN` | `True` | ✓ |  |
| `upscale_model_name` | `upscale_models` | `_preferred_default(upscale_models` | ✓ |  |
| `size_mode` | `SIZE_MODE_OPTIONS` | `按倍率` | ✓ |  |
| `upscale_by` | `FLOAT` | `2.0` | ✓ |  |
| `target_width` | `INT` | `2048` | ✓ |  |
| `target_height` | `INT` | `2048` | ✓ |  |
| `seed` | `INT` | `0` | ✓ |  |
| `steps` | `INT` | `20` | ✓ |  |
| `cfg` | `FLOAT` | `7.0` | ✓ |  |
| `sampler_name` | `comfy.samplers.KSampler.SAMPLERS` | `-` | ✓ |  |
| `scheduler` | `comfy.samplers.KSampler.SCHEDULERS` | `-` | ✓ |  |
| `denoise` | `FLOAT` | `0.28` | ✓ |  |
| `mode_type` | `(MODE_OPTIONS.keys())` | `Chess` | ✓ |  |
| `tile_width` | `INT` | `1024` | ✓ |  |
| `tile_height` | `INT` | `1024` | ✓ |  |
| `mask_blur` | `INT` | `8` | ✓ |  |
| `tile_padding` | `INT` | `32` | ✓ |  |
| `seam_fix_mode` | `(SEAM_FIX_OPTIONS.keys())` | `Half Tile` | ✓ |  |
| `seam_fix_denoise` | `FLOAT` | `0.35` | ✓ |  |
| `seam_fix_width` | `INT` | `64` | ✓ |  |
| `seam_fix_mask_blur` | `INT` | `4` | ✓ |  |
| `seam_fix_padding` | `INT` | `16` | ✓ |  |
| `force_uniform_tiles` | `BOOLEAN` | `True` | ✓ |  |
| `tiled_decode` | `BOOLEAN` | `False` | ✓ |  |
| `tile_batch_size` | `INT` | `1` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 基础放大结果 | `IMAGE` | |
| 终极放大结果 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```