# GuojijunBatchImagePreview

## 📋 概述

**功能**: guojijun 批量图片类型专用预览节点：接入批量图片队列，直接预览全部图片，并透传为普通 IMAGE batch。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_batch_image_bridge.py` | `GuojijunBatchImagePreview` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GuojijunBatchImagePreview` |
| **CATEGORY** | `guojijun/内部引用` |
| **FUNCTION** | `preview` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `batch_image` | `GJJ_BATCH_IMAGE_TYPE` | `-` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 图像批次 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```