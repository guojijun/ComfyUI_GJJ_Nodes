# GJJ_PromptSizePreset

## 📋 概述

**功能**: 整合提示词输入、尺寸预设、图像尺寸同步与空 Latent 生成，并直接输出可接 KSampler 的正反条件。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_prompt_size_preset.js` |  |
| 🔧 后端 | `nodes/gjj_prompt_size_preset.py` | `GJJ_PromptSizePreset` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_PromptSizePreset` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `preset` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `aspect_ratio` | `ASPECT_RATIO_OPTIONS` | `1:1` | ✓ |  |
| `empty_latent_width` | `INT` | `1024` | ✓ |  |
| `empty_latent_height` | `INT` | `1024` | ✓ |  |
| `positive` | `STRING` | `` | ✓ |  |
| `negative` | `STRING` | `DEFAULT_NEGATIVE_PROMPT` | ✓ |  |
| `batch_size` | `INT` | `1` | ✓ |  |
| `clip` | `CLIP` | `-` | ✓ |  |
| `image_size_source` | `IMAGE` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 正向条件输出 | `CONDITIONING` | |
| 反向条件输出 | `CONDITIONING` | |
| 空白潜空间 | `LATENT` | |
| 推荐生成宽度 | `INT` | |
| 推荐生成高度 | `INT` | |
| 推荐生成批次 | `INT` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `Comfy.GJJ.PromptSizePreset` |
| **目标节点** | `GJJ_PromptSizePreset` |
| **实现钩子** | `beforeRegisterNodeDef, setup, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```