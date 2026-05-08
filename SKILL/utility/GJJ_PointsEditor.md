# GJJ_PointsEditor

## 📋 概述

**功能**: 图形化点位编辑器。可在面板上添加前景点、背景点和框选区域，输出坐标、边框、边框遮罩和裁切图。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_points_editor.py` | `GJJ_PointsEditor` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_PointsEditor` |
| **CATEGORY** | `GJJ/工具` |
| **FUNCTION** | `pointdata` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `points_store` | `STRING` | `{}` | ✓ |  |
| `coordinates` | `STRING` | `[]` | ✓ |  |
| `neg_coordinates` | `STRING` | `[]` | ✓ |  |
| `bbox_store` | `STRING` | `[]` | ✓ |  |
| `bboxes` | `STRING` | `[]` | ✓ |  |
| `bbox_format` | `["xyxy` | `xyxy` | ✓ |  |
| `width` | `INT` | `512` | ✓ |  |
| `height` | `INT` | `512` | ✓ |  |
| `normalize` | `BOOLEAN` | `False` | ✓ |  |
| `bg_image` | `IMAGE` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 前景点坐标 | `STRING` | |
| 背景点坐标 | `STRING` | |
| 框选范围信息 | `BBOX` | |
| 框选遮罩图像 | `MASK` | |
| 首个裁切图像 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```