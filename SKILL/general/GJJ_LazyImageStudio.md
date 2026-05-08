# GJJ_LazyImageStudio

## 📋 概述

**功能**: 懒人图文集成一键生图：支持文生图、图生图，以及多图参考编辑。节点会根据所选 UNET 主关键词自动推荐匹配的文本编码器、VAE、加速 LoRA、NSFW LoRA 与常用采样参数。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_lazy_image_studio.js` |  |
| 🔧 后端 | `nodes/gjj_lazy_image_studio.py` | `GJJ_LazyImageStudio` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_LazyImageStudio` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `create_image` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `prompt` | `STRING` | `` | ✓ |  |
| `negative_prompt` | `STRING` | `` | ✓ |  |
| `main_image_index` | `INT` | `1` | ✓ |  |
| `width` | `INT` | `1024` | ✓ |  |
| `height` | `INT` | `1024` | ✓ |  |
| `batch_size` | `INT` | `1` | ✓ |  |
| `unet_name` | `diffusion_models` | `_preferred_default(
                            diffusion_models` | ✓ |  |
| `unet_dtype` | `UNET_DTYPE_OPTIONS` | `DEFAULT_UNET_DTYPE` | ✓ |  |
| `clip_name1` | `clip_models` | `_preferred_default(clip_models` | ✓ |  |
| `vae_name` | `vae_models` | `_preferred_default(vae_models` | ✓ |  |
| `lora_1_name` | `lora_models` | `_preferred_default(
                            lora_models` | ✓ |  |
| `lora_1_strength` | `FLOAT` | `1.0` | ✓ |  |
| `lora_2_name` | `lora_models` | `_preferred_default(lora_models` | ✓ |  |
| `lora_2_strength` | `FLOAT` | `0.7` | ✓ |  |
| `seed` | `INT` | `0` | ✓ |  |
| `steps` | `INT` | `4` | ✓ |  |
| `cfg` | `FLOAT` | `1.0` | ✓ |  |
| `sampler_name` | `comfy.samplers.KSampler.SAMPLERS` | `euler` | ✓ |  |
| `scheduler` | `comfy.samplers.KSampler.SCHEDULERS` | `beta57` | ✓ |  |
| `denoise` | `FLOAT` | `1.0` | ✓ |  |
| `grow_mask_by` | `INT` | `6` | ✓ |  |
| `*动态输入*` | `Dynamic` | `-` |  | 支持动态数量输入插槽 |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 最终生成图像 | `IMAGE` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `lora_1_name` |
| **目标节点** | `GJJ_LazyImageStudio` |
| **实现钩子** | `beforeRegisterNodeDef, setup, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```