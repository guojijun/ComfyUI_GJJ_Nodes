# GJJ_BatchImageToImage

## 📋 概述

**功能**: 把 GJJ 专用批量图片类型还原为普通 IMAGE，便于接到通用节点。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_batch_image_bridge.py` | `GJJ_BatchImageToImage` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_BatchImageToImage` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `unwrap` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `batch_image` | `GJJ_BATCH_IMAGE_TYPE` | `-` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 图像输出 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```