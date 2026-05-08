# GJJ_BatchTextSegmenter

## 📋 概述

**功能**: GJJ 零依赖批量 SAM3 文本分割器：输入 GJJ_BATCH_IMAGE 和分号分段文本，按图文序号或顺序匹配图片，调用本地 models/sam3 模型输出 RGBA 透明裁剪批量图。无联网、无第三方自定义节点依赖；无法识别时只在面板显示警告并跳过。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_batch_text_segmenter.js` |  |
| 🔧 后端 | `nodes/gjj_batch_text_segmenter.py` | `GJJ_BatchTextSegmenter` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_BatchTextSegmenter` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `segment` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `GJJ_BATCH_IMAGE_TYPE` | `-` | ✓ |  |
| `text_prompt` | `STRING` | `DEFAULT_PROMPT` | ✓ |  |
| `sam3_model` | `available_models or [DEFAULT_SAM3_MODEL]` | `default_model` | ✓ |  |
| `precision` | `["auto` | `auto` | ✓ |  |
| `confidence_threshold` | `FLOAT` | `0.2` | ✓ |  |
| `max_detections` | `INT` | `-1` | ✓ |  |
| `canvas_mode` | `["紧凑裁剪` | `紧凑裁剪` | ✓ |  |
| `warning_panel` | `STRING` | `DEFAULT_WARNING` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| RGBA批量裁剪图 | `GJJ_BATCH_IMAGE` | |
| - | `IMAGE` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.BatchTextSegmenter` |
| **目标节点** | `GJJ_BatchTextSegmenter` |
| **实现钩子** | `nodeCreated, beforeRegisterNodeDef, setup` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```