# GJJ_SAM3PointCollector

## 📋 概述

**功能**: 在节点面板直接点选前景与背景点位，输出给 SAM3 点选分割器使用。左键添加绿色前景点，右键添加红色背景点。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_sam3_segmenter.py` | `GJJ_SAM3PointCollector` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_SAM3PointCollector` |
| **CATEGORY** | `GJJ/SAM3` |
| **FUNCTION** | `collect` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `IMAGE` | `-` | ✓ |  |
| `points_store` | `STRING` | `{}` | ✓ |  |
| `coordinates` | `STRING` | `[]` | ✓ |  |
| `neg_coordinates` | `STRING` | `[]` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 前景点集合 | `SAM3_POINTS_PROMPT` | |
| 背景点集合 | `SAM3_POINTS_PROMPT` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```