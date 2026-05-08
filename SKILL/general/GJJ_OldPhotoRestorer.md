# GJJ_OldPhotoRestorer

## 📋 概述

**功能**: 将 qwen_image_edit_2511 老照片修复工作流封装为单节点。前台只暴露输入图像、修复提示词、UNET 与种子，后台自动匹配 CLIP、VAE、双加速 LoRA，并显示中文进度。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_old_photo_restorer.js` |  |
| 🔧 后端 | `nodes/gjj_old_photo_restorer.py` | `GJJ_OldPhotoRestorer` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_OldPhotoRestorer` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `restore` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `IMAGE` | `-` | ✓ |  |
| `prompt` | `STRING` | `DEFAULT_PROMPT` | ✓ |  |
| `unet_name` | `unet_models` | `_resolve_basename_match(DEFAULT_UNET` | ✓ |  |
| `seed` | `INT` | `1091911236774418` | ✓ |  |
| `enable_upscale` | `BOOLEAN` | `True` | ✓ |  |
| `upscale_model_name` | `upscale_models or [DEFAULT_UPSCALE_MODEL]` | `_resolve_basename_match(DEFAULT_UPSCALE_MODEL` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 修复增强图像 | `IMAGE` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.OldPhotoRestorer` |
| **目标节点** | `GJJ_OldPhotoRestorer` |
| **实现钩子** | `beforeRegisterNodeDef` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```