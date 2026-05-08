# GJJ_TextOverlay

## 📋 概述

**功能**: 将文本或 RGBA 水印叠加到背景图上，支持批量处理。覆盖文本可设置透明度。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_text_overlay.py` | `GJJ_TextOverlay` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_TextOverlay` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `run` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `background_image` | `MIXED_BATCH_IMAGE_TYPE` | `-` | ✓ |  |
| `texts` | `STRING` | `` |  |  |
| `watermark_image` | `MIXED_BATCH_IMAGE_TYPE` | `-` |  |  |
| `watermark_mask` | `MASK` | `-` |  |  |
| `split_char` | `STRING` | `_` |  |  |
| `indexes` | `STRING` | `1` |  |  |
| `text_opacity` | `FLOAT` | `1.0` |  |  |
| `watermark_opacity` | `FLOAT` | `1.0` |  |  |
| `watermark_width` | `FLOAT` | `1.0` |  |  |
| `direction` | `["横向` | `横向` |  |  |
| `spacing` | `FLOAT` | `0` |  |  |
| `seed` | `INT` | `0` |  |  |
| `strip_empty` | `BOOLEAN` | `True` |  |  |
| `font_path` | `()` | `simhei.ttf` |  |  |
| `font_size` | `INT` | `48` |  |  |
| `x` | `FLOAT` | `0.5` |  |  |
| `y` | `FLOAT` | `0.5` |  |  |
| `color_hex` | `STRING` | `#FFD700` |  |  |
| `stroke_color_hex` | `STRING` | `#000000` |  |  |
| `use_stroke` | `BOOLEAN` | `True` |  |  |
| `stroke_width` | `INT` | `2` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 叠加后图像 | `MIXED_BATCH_IMAGE_TYPE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```