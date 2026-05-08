# GJJ_GradientImage

## 📋 概述

**功能**: 生成线性或径向渐变图，可作为背景、遮罩参考或 ControlNet 辅助图。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_local_image_tools.py` | `GJJ_GradientImage` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_GradientImage` |
| **CATEGORY** | `GJJ/Image` |
| **FUNCTION** | `make` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `width` | `INT` | `1024` | ✓ |  |
| `height` | `INT` | `1024` | ✓ |  |
| `start_color` | `STRING` | `#000000` | ✓ |  |
| `end_color` | `STRING` | `#FFFFFF` | ✓ |  |
| `direction` | `["左到右` | `左到右` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 渐变图像 | `IMAGE` | |
| 全图遮罩 | `MASK` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```