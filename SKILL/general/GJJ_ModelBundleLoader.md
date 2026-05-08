# GJJ_ModelBundleLoader

## 📋 概述

**功能**: 一次性加载 UNET、CLIP、VAE，并附带常用的步数、CFG、降噪参数输出，便于快速搭建基础采样链路。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_model_bundle_loader.js` |  |
| 🔧 后端 | `nodes/gjj_model_bundle_loader.py` | `GJJ_ModelBundleLoader` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_ModelBundleLoader` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `load_models` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `unet_name` | `unet_models` | `_default_value(unet_models)` | ✓ |  |
| `unet_dtype` | `UNET_DTYPE_OPTIONS` | `default` | ✓ |  |
| `clip_name` | `clip_models` | `_default_value(clip_models)` | ✓ |  |
| `clip_type` | `CLIP_TYPE_OPTIONS` | `stable_diffusion` | ✓ |  |
| `clip_dtype` | `CLIP_DTYPE_OPTIONS` | `default` | ✓ |  |
| `vae_name` | `vae_models` | `_default_value(vae_models)` | ✓ |  |
| `vae_dtype` | `VAE_DTYPE_OPTIONS` | `default` | ✓ |  |
| `steps` | `INT` | `20` | ✓ |  |
| `cfg` | `FLOAT` | `1.0` | ✓ |  |
| `denoise` | `FLOAT` | `1.0` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 扩散模型输出 | `MODEL` | |
| 文本编码输出 | `CLIP` | |
| 图像解码输出 | `VAE` | |
| 推荐采样步数 | `INT` | |
| 推荐引导强度 | `FLOAT` | |
| 推荐降噪强度 | `FLOAT` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `Comfy.GJJ.ModelBundleLoader` |
| **目标节点** | `GJJ_ModelBundleLoader` |
| **实现钩子** | `nodeCreated, beforeRegisterNodeDef, setup` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```