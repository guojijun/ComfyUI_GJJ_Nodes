# GJJ_LoadImageWithAlpha

## 📋 概述

**功能**: 加载 input 目录图片，保留 RGBA 并输出 alpha 遮罩。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_alpha_tools.py` | `GJJ_LoadImageWithAlpha` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_LoadImageWithAlpha` |
| **CATEGORY** | `GJJ/图像` |
| **FUNCTION** | `load` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `()` | `-` | ✓ |  |
| `mask_mode` | `["透明为白` | `透明为白` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| RGBA图像 | `IMAGE` | |
| Alpha遮罩 | `MASK` | |
| 图片路径 | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```