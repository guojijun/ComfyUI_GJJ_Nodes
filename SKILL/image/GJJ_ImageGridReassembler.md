# GJJ_ImageGridReassembler

## 📋 概述

**功能**: 把网格图片块贴回原图尺寸，支持指定替换块与自动缩放。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_image_grid_tools.py` | `GJJ_ImageGridReassembler` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_ImageGridReassembler` |
| **CATEGORY** | `GJJ/图像` |
| **FUNCTION** | `reassemble` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `original` | `IMAGE` | `-` | ✓ |  |
| `rows` | `INT` | `1` | ✓ |  |
| `columns` | `INT` | `1` | ✓ |  |
| `replacement_index` | `INT` | `0` | ✓ |  |
| `overlap` | `INT` | `2` | ✓ |  |
| `auto_resize` | `BOOLEAN` | `True` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 重组图像 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```