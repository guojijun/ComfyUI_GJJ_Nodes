# GJJ_BatchWatermarkRemover

## 📋 概述

**功能**: 批量去除水印单节点。借鉴 Flux2 Klein 参考图重绘思路，不依赖 Florence、KJ、CropStitch、WAS 等第三方节点；输入和主输出均为 GJJ 专用批量图片。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_batch_watermark_remover.py` | `GJJ_BatchWatermarkRemover` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_BatchWatermarkRemover` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `remove` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `GJJ_BATCH_IMAGE_TYPE` | `-` | ✓ |  |
| `prompt` | `STRING` | `DEFAULT_PROMPT` | ✓ |  |
| `negative_prompt` | `STRING` | `DEFAULT_NEGATIVE` | ✓ |  |
| `unet_name` | `unet_models` | `gjjutils_pick_available_name(DEFAULT_UNET` | ✓ |  |
| `clip_name` | `clip_models` | `gjjutils_pick_available_name(DEFAULT_CLIP` | ✓ |  |
| `vae_name` | `vae_models` | `gjjutils_pick_available_name(DEFAULT_VAE` | ✓ |  |
| `working_megapixels` | `FLOAT` | `1.0` | ✓ |  |
| `output_size_mode` | `SIZE_MODES` | `保持输入尺寸` | ✓ |  |
| `scale_method` | `UPSCALE_METHODS` | `nearest-exact` | ✓ |  |
| `steps` | `INT` | `4` | ✓ |  |
| `cfg` | `FLOAT` | `1.0` | ✓ |  |
| `seed` | `INT` | `352628917855609` | ✓ |  |
| `auto_save` | `BOOLEAN` | `False` | ✓ |  |
| `filename_prefix` | `STRING` | `DEFAULT_FILENAME_PREFIX` | ✓ |  |
| `filename_regex` | `STRING` | `` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 批量图片 | `GJJ_BATCH_IMAGE_TYPE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```