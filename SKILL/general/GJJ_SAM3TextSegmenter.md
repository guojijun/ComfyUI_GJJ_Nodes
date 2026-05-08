# GJJ_SAM3TextSegmenter

## 📋 概述

**功能**: SAM3 文本分割器。输入自然语言描述，例如“人物”“红色汽车”，节点会尝试返回所有匹配目标的遮罩。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_sam3_segmenter.py` | `GJJ_SAM3TextSegmenter` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_SAM3TextSegmenter` |
| **CATEGORY** | `GJJ/SAM3` |
| **FUNCTION** | `segment` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `IMAGE` | `-` | ✓ |  |
| `text_prompt` | `STRING` | `person` | ✓ |  |
| `sam3_model` | `available or ["sam3.safetensors"]` | `default_model or "sam3.safetensors` | ✓ |  |
| `precision` | `["auto` | `auto` | ✓ |  |
| `confidence_threshold` | `FLOAT` | `0.2` | ✓ |  |
| `max_detections` | `INT` | `-1` | ✓ |  |
| `positive_boxes` | `SAM3_BOXES_PROMPT` | `-` |  |  |
| `negative_boxes` | `SAM3_BOXES_PROMPT` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 分割结果遮罩 | `MASK` | |
| 分割预览图像 | `IMAGE` | |
| 边框检测信息 | `STRING` | |
| 遮罩评分信息 | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```