# GJJ_LocalLipSync

## 📋 概述

**功能**: GJJ 内部本地零 API 口型同步：图片+音频使用 GJJ 已有 LTX2.3 功能，视频+音频使用 GJJ 内部 LatentSync 或 LatentSync 功能；只引用 ComfyUI 官方能力和 GJJ 包内功能，不依赖其它自定义节点。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_local_lipsync.js` |  |
| 🔧 后端 | `nodes/gjj_local_lipsync.py` | `GJJ_LocalLipSync` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_LocalLipSync` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `generate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `mode` | `[MODE_AUTO` | `MODE_AUTO` | ✓ |  |
| `positive_prompt` | `STRING` | `DEFAULT_PROMPT` | ✓ |  |
| `negative_prompt` | `STRING` | `DEFAULT_NEGATIVE` | ✓ |  |
| `width` | `INT` | `1280` | ✓ |  |
| `height` | `INT` | `736` | ✓ |  |
| `fps` | `INT` | `25` | ✓ |  |
| `seed` | `INT` | `483811081311996` | ✓ |  |
| `max_seconds` | `FLOAT` | `12.0` | ✓ |  |
| `inference_steps` | `INT` | `20` | ✓ |  |
| `guidance_scale` | `FLOAT` | `1.5` | ✓ |  |
| `chunk_frames` | `INT` | `80` | ✓ |  |
| `input_media` | `any_type` | `-` |  |  |
| `input_audio` | `AUDIO` | `-` |  |  |
| `relay_prompt_input` | `STRING` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 视频 | `VIDEO` | |
| 状态 | `STRING` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.LocalLipSync` |
| **目标节点** | `GJJ_LocalLipSync` |
| **实现钩子** | `beforeRegisterNodeDef, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```