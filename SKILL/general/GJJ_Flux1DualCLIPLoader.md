# GJJ_Flux1DualCLIPLoader

## 📋 概述

**功能**: 为 Flux 1 系列模型一次性加载 UNET、双 CLIP 和 VAE，适合作为 Flux 1 工作流的基础模型入口。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_flux1_dual_clip_loader.py` | `GJJ_Flux1DualCLIPLoader` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_Flux1DualCLIPLoader` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `load_models` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `unet_name` | `unet_models` | `default_unet` | ✓ |  |
| `unet_dtype` | `UNET_DTYPE_OPTIONS` | `fp8_e4m3fn` | ✓ |  |
| `clip_name1` | `clip_models` | `_preferred_default(clip_models` | ✓ |  |
| `clip_name2` | `clip_models` | `_preferred_default(clip_models` | ✓ |  |
| `clip_device` | `["default` | `default` | ✓ |  |
| `vae_name` | `vae_models` | `_preferred_default(vae_models` | ✓ |  |
| `vae_dtype` | `VAE_DTYPE_OPTIONS` | `default` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 扩散模型输出 | `MODEL` | |
| 文本编码输出 | `CLIP` | |
| 图像解码输出 | `VAE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```