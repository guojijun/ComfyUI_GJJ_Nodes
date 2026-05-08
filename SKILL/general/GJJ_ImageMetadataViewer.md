# GJJ_ImageMetadataViewer

## 📋 概述

**功能**: 读取图片文件的基础信息、PNG 文本元数据、ComfyUI 工作流和 EXIF 信息。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_metadata_viewer.py` | `GJJ_ImageMetadataViewer` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_ImageMetadataViewer` |
| **CATEGORY** | `GJJ/Info` |
| **FUNCTION** | `read` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image_path` | `STRING` | `` | ✓ |  |
| `info_type` | `["摘要` | `摘要` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 信息文本 | `STRING` | |
| 工作流JSON | `STRING` | |
| 节点列表 | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```