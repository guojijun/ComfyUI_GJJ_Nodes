# GJJ_ReduxAdvanced

## 📋 概述

**功能**: 内部加载 CLIP Vision 与 Redux 风格模型，将图像风格特征编码后拼接到 conditioning，并支持遮罩与自动裁切。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_redux_advanced.py` | `GJJ_ReduxAdvanced` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_ReduxAdvanced` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `apply_redux` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `conditioning` | `CONDITIONING` | `-` | ✓ |  |
| `image` | `IMAGE` | `-` | ✓ |  |
| `clip_vision_name` | `clip_vision_models` | `_preferred_default(clip_vision_models` | ✓ |  |
| `style_model_name` | `style_models` | `_preferred_default(style_models` | ✓ |  |
| `downsampling_factor` | `FLOAT` | `3.0` | ✓ |  |
| `downsampling_function` | `DOWN_SAMPLE_MODES` | `area` | ✓ |  |
| `mode` | `IMAGE_MODES` | `center crop (square)` | ✓ |  |
| `weight` | `FLOAT` | `1.0` | ✓ |  |
| `mask` | `MASK` | `-` |  |  |
| `autocrop_margin` | `FLOAT` | `0.1` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 重绘条件输出 | `CONDITIONING` | |
| 重绘图像输出 | `IMAGE` | |
| 重绘遮罩输出 | `MASK` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```