# GJJ_InpaintCrop

## 📋 概述

**功能**: 根据遮罩自动裁出局部重绘区域，并输出可拼回原图的零依赖 stitcher。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_inpaint_crop.py` | `GJJ_InpaintCrop` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_InpaintCrop` |
| **CATEGORY** | `GJJ/Image` |
| **FUNCTION** | `inpaint_crop` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `IMAGE` | `-` | ✓ |  |
| `downscale_algorithm` | `RESIZE_MODES` | `bilinear` | ✓ |  |
| `upscale_algorithm` | `RESIZE_MODES` | `bicubic` | ✓ |  |
| `preresize` | `BOOLEAN` | `False` | ✓ |  |
| `preresize_mode` | `PRERESIZE_MODES` | `PRERESIZE_MIN` | ✓ |  |
| `preresize_min_width` | `INT` | `1024` | ✓ |  |
| `preresize_min_height` | `INT` | `1024` | ✓ |  |
| `preresize_max_width` | `INT` | `MAX_RESOLUTION` | ✓ |  |
| `preresize_max_height` | `INT` | `MAX_RESOLUTION` | ✓ |  |
| `mask_fill_holes` | `BOOLEAN` | `True` | ✓ |  |
| `mask_expand_pixels` | `INT` | `0` | ✓ |  |
| `mask_invert` | `BOOLEAN` | `False` | ✓ |  |
| `mask_blend_pixels` | `INT` | `32` | ✓ |  |
| `mask_hipass_filter` | `FLOAT` | `0.10` | ✓ |  |
| `extend_for_outpainting` | `BOOLEAN` | `False` | ✓ |  |
| `extend_up_factor` | `FLOAT` | `1.0` | ✓ |  |
| `extend_down_factor` | `FLOAT` | `1.0` | ✓ |  |
| `extend_left_factor` | `FLOAT` | `1.0` | ✓ |  |
| `extend_right_factor` | `FLOAT` | `1.0` | ✓ |  |
| `context_from_mask_extend_factor` | `FLOAT` | `1.20` | ✓ |  |
| `output_resize_to_target_size` | `BOOLEAN` | `True` | ✓ |  |
| `output_target_width` | `INT` | `512` | ✓ |  |
| `output_target_height` | `INT` | `512` | ✓ |  |
| `output_padding` | `["0` | `32` | ✓ |  |
| `device_mode` | `DEVICE_MODES` | `DEVICE_GPU` | ✓ |  |
| `mask` | `MASK` | `-` |  |  |
| `optional_context_mask` | `MASK` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 拼回信息 | `STITCHER` | |
| 裁切图片 | `IMAGE` | |
| 裁切遮罩 | `MASK` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```