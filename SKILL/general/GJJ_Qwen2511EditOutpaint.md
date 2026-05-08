# GJJ_Qwen2511EditOutpaint

## 📋 概述

**功能**: 通用外扩图片填充编辑器。默认使用 GJJ 专用批量图片口；接入 GJJ 多图片加载预览器 的“批量图片”输出时会优先按原始选图逐张外扩。普通 IMAGE 如需接入，请先经过批量图片包装器。默认按目标尺寸、原图占比和扩图方向自动计算扩边，也可切回传统四边像素扩图。节点会根据预设表自动匹配 UNET 对应的 CLIP、VAE、LoRA 与采样参数，并按模型族分流到 Qwen 外扩链、Flux Fill 外扩链或通用 Inpaint 外扩链。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_qwen2511_edit_outpaint.js` |  |
| 🔧 后端 | `nodes/gjj_qwen2511_edit_outpaint.py` | `GJJ_Qwen2511EditOutpaint` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_Qwen2511EditOutpaint` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `generate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `GJJ_BATCH_IMAGE_TYPE` | `-` | ✓ |  |
| `prompt` | `STRING` | `DEFAULT_PROMPT` | ✓ |  |
| `unet_name` | `unet_models` | `_resolve_name(DEFAULT_UNET` | ✓ |  |
| `layout_mode` | `LAYOUT_MODE_OPTIONS` | `DEFAULT_LAYOUT_MODE` | ✓ |  |
| `target_width` | `INT` | `DEFAULT_TARGET_WIDTH` | ✓ |  |
| `target_height` | `INT` | `DEFAULT_TARGET_HEIGHT` | ✓ |  |
| `expand_method` | `EXPAND_METHOD_OPTIONS` | `DEFAULT_EXPAND_METHOD` | ✓ |  |
| `original_ratio` | `FLOAT` | `DEFAULT_ORIGINAL_RATIO` | ✓ |  |
| `expand_direction` | `EXPAND_DIRECTION_OPTIONS` | `DEFAULT_EXPAND_DIRECTION` | ✓ |  |
| `left` | `INT` | `DEFAULT_LEFT` | ✓ |  |
| `top` | `INT` | `DEFAULT_TOP` | ✓ |  |
| `right` | `INT` | `DEFAULT_RIGHT` | ✓ |  |
| `bottom` | `INT` | `DEFAULT_BOTTOM` | ✓ |  |
| `feathering` | `INT` | `DEFAULT_FEATHERING` | ✓ |  |
| `seed` | `INT` | `326477531988575` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 批量图片 | `GJJ_BATCH_IMAGE` | |
| - | `IMAGE` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.Qwen2511EditOutpaint` |
| **目标节点** | `GJJ_Qwen2511EditOutpaint` |
| **实现钩子** | `beforeRegisterNodeDef, setup` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```