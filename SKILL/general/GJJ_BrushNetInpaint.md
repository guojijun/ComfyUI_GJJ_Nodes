# GJJ_BrushNetInpaint

## 📋 概述

**功能**: 综合迁移 BrushNet、PowerPaint、RAUNet、裁切与融合补图功能；模型会在 models 下模糊搜索。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_brushnet_inpaint.py` | `GJJ_BrushNetInpaint` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_BrushNetInpaint` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `run` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `mode` | `MODES` | `MODE_BRUSHNET` | ✓ |  |
| `dtype` | `["float16` | `float16` | ✓ |  |
| `scale` | `FLOAT` | `1.0` | ✓ |  |
| `start_at` | `INT` | `0` | ✓ |  |
| `end_at` | `INT` | `10000` | ✓ |  |
| `powerpaint_fitting` | `FLOAT` | `1.0` | ✓ |  |
| `save_memory` | `["none` | `none` | ✓ |  |
| `cut_width` | `INT` | `512` | ✓ |  |
| `cut_height` | `INT` | `512` | ✓ |  |
| `blend_kernel` | `INT` | `11` | ✓ |  |
| `blend_sigma` | `FLOAT` | `10.0` | ✓ |  |
| `raunet_du_start` | `INT` | `0` | ✓ |  |
| `raunet_du_end` | `INT` | `4` | ✓ |  |
| `raunet_xa_start` | `INT` | `4` | ✓ |  |
| `raunet_xa_end` | `INT` | `10` | ✓ |  |
| `model` | `MODEL` | `-` |  |  |
| `vae` | `VAE` | `-` |  |  |
| `image` | `IMAGE` | `-` |  |  |
| `mask` | `MASK` | `-` |  |  |
| `positive` | `CONDITIONING` | `-` |  |  |
| `negative` | `CONDITIONING` | `-` |  |  |
| `inpaint_image` | `IMAGE` | `-` |  |  |
| `origin` | `VECTOR` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 模型 | `MODEL` | |
| 正向条件 | `CONDITIONING` | |
| 反向条件 | `CONDITIONING` | |
| 潜空间 | `LATENT` | |
| 图像 | `IMAGE` | |
| 遮罩 | `MASK` | |
| 裁切原点 | `VECTOR` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```