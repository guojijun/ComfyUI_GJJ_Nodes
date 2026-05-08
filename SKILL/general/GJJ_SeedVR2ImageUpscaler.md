# GJJ_SeedVR2ImageUpscaler

## 📋 概述

**功能**: 将 SeedVR2 的图像/视频放大整合成单节点；接入视频时会自动提取帧、保留原音频与帧率并重建视频。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_seedvr2_image_upscaler.js` |  |
| 🔧 后端 | `nodes/gjj_seedvr2_image_upscaler.py` | `GJJ_SeedVR2ImageUpscaler` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_SeedVR2ImageUpscaler` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `upscale_image` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `common_video_height` | `COMMON_VIDEO_HEIGHT_OPTIONS` | `1080` | ✓ |  |
| `resolution` | `INT` | `1080` | ✓ |  |
| `max_resolution` | `INT` | `0` | ✓ |  |
| `seed` | `INT` | `42` | ✓ |  |
| `dit_model` | `dit_models` | `DEFAULT_DIT_MODEL` | ✓ |  |
| `vae_model` | `vae_models` | `DEFAULT_VAE_MODEL` | ✓ |  |
| `device` | `devices` | `preferred_device` | ✓ |  |
| `model_offload_device` | `offload_devices` | `none" if "none" in offload_devices else offload_devices[0]` | ✓ |  |
| `tensor_offload_device` | `offload_devices` | `preferred_device if preferred_device in offload_devices else ("cpu" if "cpu" in offload_devices else offload_devices[0])` | ✓ |  |
| `attention_mode` | `["sdpa` | `sdpa` | ✓ |  |
| `blocks_to_swap` | `INT` | `0` | ✓ |  |
| `swap_io_components` | `BOOLEAN` | `False` | ✓ |  |
| `encode_tiled` | `BOOLEAN` | `True` | ✓ |  |
| `encode_tile_size` | `INT` | `512` | ✓ |  |
| `encode_tile_overlap` | `INT` | `128` | ✓ |  |
| `decode_tiled` | `BOOLEAN` | `True` | ✓ |  |
| `decode_tile_size` | `INT` | `512` | ✓ |  |
| `decode_tile_overlap` | `INT` | `128` | ✓ |  |
| `tile_debug` | `["false` | `false` | ✓ |  |
| `color_correction` | `["lab` | `lab` | ✓ |  |
| `input_noise_scale` | `FLOAT` | `0.0` | ✓ |  |
| `latent_noise_scale` | `FLOAT` | `0.0` | ✓ |  |
| `enable_debug` | `BOOLEAN` | `False` | ✓ |  |
| `image` | `IMAGE` | `-` |  |  |
| `video` | `VIDEO` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 放大完成结果 | `any_type` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.SeedVR2ImageUpscaler` |
| **目标节点** | `GJJ_SeedVR2ImageUpscaler` |
| **实现钩子** | `beforeRegisterNodeDef, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```