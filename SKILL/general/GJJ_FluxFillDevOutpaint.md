# GJJ_FluxFillDevOutpaint

## 📋 概述

**功能**: 节点 `GJJ_FluxFillDevOutpaint`

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_flux_fill_dev_outpaint.py` | `GJJ_FluxFillDevOutpaint` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_FluxFillDevOutpaint` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `outpaint` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `IMAGE` | `-` | ✓ |  |
| `positive_prompt` | `STRING` | `DEFAULT_POSITIVE` | ✓ |  |
| `unet_name` | `unet_models` | `DEFAULT_UNET if DEFAULT_UNET in unet_models else unet_models[0]` | ✓ |  |
| `left` | `INT` | `400` | ✓ |  |
| `top` | `INT` | `0` | ✓ |  |
| `right` | `INT` | `400` | ✓ |  |
| `bottom` | `INT` | `400` | ✓ |  |
| `feathering` | `INT` | `24` | ✓ |  |
| `seed` | `INT` | `50915499055174` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 外扩生成图像 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```