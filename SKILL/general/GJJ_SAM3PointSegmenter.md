# GJJ_SAM3PointSegmenter

## 📋 概述

**功能**: SAM3 点选分割器。内部自动加载 models/sam3 下的模型，支持前景点、背景点和可选框提示。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_sam3_segmenter.py` | `GJJ_SAM3PointSegmenter` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_SAM3PointSegmenter` |
| **CATEGORY** | `GJJ/SAM3` |
| **FUNCTION** | `segment` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `IMAGE` | `-` | ✓ |  |
| `sam3_model` | `available or ["sam3.safetensors"]` | `default_model or "sam3.safetensors` | ✓ |  |
| `precision` | `["auto` | `auto` | ✓ |  |
| `refinement_iterations` | `INT` | `0` | ✓ |  |
| `use_multimask` | `BOOLEAN` | `True` | ✓ |  |
| `output_best_mask` | `BOOLEAN` | `True` | ✓ |  |
| `positive_points` | `SAM3_POINTS_PROMPT` | `-` |  |  |
| `negative_points` | `SAM3_POINTS_PROMPT` | `-` |  |  |
| `positive_boxes` | `SAM3_BOXES_PROMPT` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 分割结果遮罩 | `MASK` | |
| 分割结果概率 | `MASK` | |
| 分割预览图像 | `IMAGE` | |
| 边框检测信息 | `STRING` | |
| 遮罩评分信息 | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```