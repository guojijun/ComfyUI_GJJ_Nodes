# GJJ_InpaintCrop

## 📋 概述

根据遮罩自动裁出局部重绘区域，并输出可拼回原图的零依赖 stitcher。
**搜索关键词**: Inpaint Crop, inpaint crop, 局部重绘裁切, 重绘裁切, 裁切拼回

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🔧 后端 | `nodes/gjj_inpaint_crop.py` | 节点执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_InpaintCrop` |
| **CATEGORY** | `GJJ/Image` |
| **FUNCTION** | `inpaint_crop` |
| **搜索别名** | `Inpaint Crop`, `inpaint crop`, `局部重绘裁切`, `重绘裁切`, `裁切拼回` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `IMAGE` | {"display_name": "图片", "tooltip": "需要局部重绘的原始图片。"} | ✓ | |
| `downscale_algorithm` | `RESIZE_MODES` | {"default": "bilinear", "display_name": "缩小时算法"... | ✓ | |
| `upscale_algorithm` | `RESIZE_MODES` | {"default": "bicubic", "display_name": "放大时算法",... | ✓ | |
| `preresize` | `BOOLEAN` | {"default": False, "display_name": "预缩放原图", "to... | ✓ | |
| `preresize_mode` | `PRERESIZE_MODES` | {"default": PRERESIZE_MIN, "display_name": "预缩放... | ✓ | |
| `preresize_min_width` | `INT` | {"default": 1024, "min": 0, "max": MAX_RESOLUTI... | ✓ | |
| `preresize_min_height` | `INT` | {"default": 1024, "min": 0, "max": MAX_RESOLUTI... | ✓ | |
| `preresize_max_width` | `INT` | {"default": MAX_RESOLUTION, "min": 0, "max": MA... | ✓ | |
| `preresize_max_height` | `INT` | {"default": MAX_RESOLUTION, "min": 0, "max": MA... | ✓ | |
| `mask_fill_holes` | `BOOLEAN` | {"default": True, "display_name": "填补遮罩空洞", "to... | ✓ | |
| `mask_expand_pixels` | `INT` | {"default": 0, "min": 0, "max": MAX_RESOLUTION,... | ✓ | |
| `mask_invert` | `BOOLEAN` | {"default": False, "display_name": "反转遮罩", "too... | ✓ | |
| `mask_blend_pixels` | `INT` | {"default": 32, "min": 0, "max": 256, "step": 1... | ✓ | |
| `mask_hipass_filter` | `FLOAT` | {"default": 0.10, "min": 0.0, "max": 1.0, "step... | ✓ | |
| `extend_for_outpainting` | `BOOLEAN` | {"default": False, "display_name": "扩画模式", "too... | ✓ | |
| `extend_up_factor` | `FLOAT` | {"default": 1.0, "min": 0.01, "max": 100.0, "st... | ✓ | |
| `extend_down_factor` | `FLOAT` | {"default": 1.0, "min": 0.01, "max": 100.0, "st... | ✓ | |
| `extend_left_factor` | `FLOAT` | {"default": 1.0, "min": 0.01, "max": 100.0, "st... | ✓ | |
| `extend_right_factor` | `FLOAT` | {"default": 1.0, "min": 0.01, "max": 100.0, "st... | ✓ | |
| `context_from_mask_extend_factor` | `FLOAT` | {"default": 1.20, "min": 1.0, "max": 100.0, "st... | ✓ | |
| `output_resize_to_target_size` | `BOOLEAN` | {"default": True, "display_name": "输出到目标尺寸", "t... | ✓ | |
| `output_target_width` | `INT` | {"default": 512, "min": 64, "max": MAX_RESOLUTI... | ✓ | |
| `output_target_height` | `INT` | {"default": 512, "min": 64, "max": MAX_RESOLUTI... | ✓ | |
| `output_padding` | `["0", "8", "16", "32", "64", "128", "256", "512"]` | {"default": "32", "display_name": "尺寸对齐倍数", "to... | ✓ | |
| `device_mode` | `DEVICE_MODES` | {"default": DEVICE_GPU, "display_name": "运行设备",... | ✓ | |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 拼回信息 | `STITCHER` | |
| 裁切图片 | `IMAGE` | |
| 裁切遮罩 | `MASK` | |

## 🏗️ 数据流
```
ComfyUI 图引擎 → [后端节点执行] → 输出
```
