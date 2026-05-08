# GJJ_FaceDetailer

## 📋 概述

**功能**: 节点 `GJJ_FaceDetailer`

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_face_detailer.py` | `GJJ_FaceDetailer` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_FaceDetailer` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `detail_faces` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `IMAGE` | `-` | ✓ |  |
| `model` | `MODEL` | `-` | ✓ |  |
| `clip` | `CLIP` | `-` | ✓ |  |
| `vae` | `VAE` | `-` | ✓ |  |
| `positive` | `CONDITIONING` | `-` | ✓ |  |
| `negative` | `CONDITIONING` | `-` | ✓ |  |
| `bbox_model_name` | `bbox_models` | `_default_value(bbox_models)` | ✓ |  |
| `sam_model_name` | `sam_models` | `none` | ✓ |  |
| `sam_device_mode` | `SAM_DEVICE_MODES` | `AUTO` | ✓ |  |
| `guide_size` | `FLOAT` | `512` | ✓ |  |
| `guide_size_for` | `BOOLEAN` | `True` | ✓ |  |
| `max_size` | `FLOAT` | `1024` | ✓ |  |
| `seed` | `INT` | `0` | ✓ |  |
| `steps` | `INT` | `20` | ✓ |  |
| `cfg` | `FLOAT` | `8.0` | ✓ |  |
| `sampler_name` | `comfy.samplers.KSampler.SAMPLERS` | `-` | ✓ |  |
| `scheduler` | `()` | `normal` | ✓ |  |
| `denoise` | `FLOAT` | `0.5` | ✓ |  |
| `feather` | `INT` | `5` | ✓ |  |
| `noise_mask` | `BOOLEAN` | `True` | ✓ |  |
| `force_inpaint` | `BOOLEAN` | `True` | ✓ |  |
| `bbox_threshold` | `FLOAT` | `0.5` | ✓ |  |
| `bbox_dilation` | `INT` | `10` | ✓ |  |
| `bbox_crop_factor` | `FLOAT` | `3.0` | ✓ |  |
| `sam_detection_hint` | `SAM_DETECTION_HINTS` | `center-1` | ✓ |  |
| `sam_dilation` | `INT` | `0` | ✓ |  |
| `sam_threshold` | `FLOAT` | `0.93` | ✓ |  |
| `sam_bbox_expansion` | `INT` | `0` | ✓ |  |
| `sam_mask_hint_threshold` | `FLOAT` | `0.7` | ✓ |  |
| `sam_mask_hint_use_negative` | `SAM_NEGATIVE_HINT_OPTIONS` | `False` | ✓ |  |
| `drop_size` | `INT` | `10` | ✓ |  |
| `wildcard` | `STRING` | `` | ✓ |  |
| `cycle` | `INT` | `1` | ✓ |  |
| `detailer_hook` | `DETAILER_HOOK` | `-` |  |  |
| `inpaint_model` | `BOOLEAN` | `False` |  |  |
| `noise_mask_feather` | `INT` | `20` |  |  |
| `scheduler_func_opt` | `SCHEDULER_FUNC` | `-` |  |  |
| `tiled_encode` | `BOOLEAN` | `False` |  |  |
| `tiled_decode` | `BOOLEAN` | `False` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 细化输出图像 | `IMAGE` | |
| 裁切细化图像 | `IMAGE` | |
| 透明裁切图像 | `IMAGE` | |
| 细化区域遮罩 | `MASK` | |
| 控制预览图像 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```