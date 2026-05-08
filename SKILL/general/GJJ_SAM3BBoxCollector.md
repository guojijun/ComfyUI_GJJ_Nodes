# GJJ_SAM3BBoxCollector

## 📋 概述

**功能**: 在节点面板直接框选正向或反向区域，输出给 SAM3 点选分割器或文本分割器使用。左键拖拽添加正向框，右键拖拽添加反向框。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_sam3_segmenter.py` | `GJJ_SAM3BBoxCollector` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_SAM3BBoxCollector` |
| **CATEGORY** | `GJJ/SAM3` |
| **FUNCTION** | `collect` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `IMAGE` | `-` | ✓ |  |
| `bboxes` | `STRING` | `[]` | ✓ |  |
| `neg_bboxes` | `STRING` | `[]` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 正向框选集 | `SAM3_BOXES_PROMPT` | |
| 反向框选集 | `SAM3_BOXES_PROMPT` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```