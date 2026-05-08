# GJJ_ImagesToPDF

## 📋 概述

**功能**: 把 IMAGE 批次保存为多页 PDF。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_pdf_tools.py` | `GJJ_ImagesToPDF` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_ImagesToPDF` |
| **CATEGORY** | `GJJ/PDF` |
| **FUNCTION** | `save` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `images` | `IMAGE` | `-` | ✓ |  |
| `filename_prefix` | `STRING` | `GJJ/pdf/images` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| PDF路径 | `STRING` | |
| 页数 | `INT` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```