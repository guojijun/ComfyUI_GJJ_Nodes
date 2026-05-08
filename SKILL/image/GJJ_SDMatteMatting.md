# GJJ_SDMatteMatting

## 📋 概述

**功能**: 使用 SDMatte 模型按输入遮罩执行精细抠图，输出透明图、遮罩和遮罩预览图。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_sdmatte_matting.py` | `GJJ_SDMatteMatting` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_SDMatteMatting` |
| **CATEGORY** | `GJJ/图像` |
| **FUNCTION** | `matting` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `IMAGE` | `-` | ✓ |  |
| `model` | `(SDMATTE_MODELS.keys())` | `SDMatte` | ✓ |  |
| `device` | `["Auto` | `Auto` | ✓ |  |
| `process_res` | `INT` | `1024` | ✓ |  |
| `transparent_object` | `BOOLEAN` | `True` | ✓ |  |
| `mask_refine` | `BOOLEAN` | `True` | ✓ |  |
| `sensitivity` | `FLOAT` | `0.9` | ✓ |  |
| `mask_blur` | `INT` | `0` | ✓ |  |
| `mask_offset` | `INT` | `0` | ✓ |  |
| `invert_output` | `BOOLEAN` | `False` | ✓ |  |
| `background` | `["透明` | `透明` | ✓ |  |
| `background_color` | `STRING` | `#222222` | ✓ |  |
| `mask` | `MASK` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 抠图图像 | `IMAGE` | |
| 前景遮罩 | `MASK` | |
| 遮罩预览 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```