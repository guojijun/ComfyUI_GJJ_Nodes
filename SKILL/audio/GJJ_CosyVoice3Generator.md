# GJJ_CosyVoice3Generator

## 📋 概述

**功能**: CosyVoice3 一体式语音克隆器。内部自动加载本地 models/cosyvoice 模型，支持零样本复刻、跨语言复刻与指令风格控制。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_cosyvoice3_generator.js` |  |
| 🔧 后端 | `nodes/gjj_cosyvoice3_generator.py` | `GJJ_CosyVoice3Generator` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_CosyVoice3Generator` |
| **CATEGORY** | `GJJ/Audio` |
| **FUNCTION** | `generate` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `mode` | `MODE_OPTIONS` | `零样本复刻` | ✓ |  |
| `example_audio_name` | `example_audios or [MISSING_EXAMPLE_AUDIO]` | `example_audios[0] if example_audios else MISSING_EXAMPLE_AUDIO` | ✓ |  |
| `model_name` | `available or [DEFAULT_MODEL_NAME]` | `default_model` | ✓ |  |
| `text` | `STRING` | `你好，这是一段使用 CosyVoice3 生成的语音。` | ✓ |  |
| `speed` | `FLOAT` | `1.0` | ✓ |  |
| `reference_text` | `STRING` | `DEFAULT_REFERENCE_TEXT` | ✓ |  |
| `instruct_text` | `STRING` | `请以自然、清晰、富有感情的语气朗读。` | ✓ |  |
| `auto_transcribe` | `BOOLEAN` | `True` | ✓ |  |
| `text_frontend` | `BOOLEAN` | `True` | ✓ |  |
| `seed` | `INT` | `42` | ✓ |  |
| `mp3_filename_prefix` | `STRING` | `audio/GJJ_CosyVoice3` | ✓ |  |
| `mp3_quality` | `MP3_QUALITY_OPTIONS` | `320k` | ✓ |  |
| `reference_audio` | `AUDIO` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 语音音频输出 | `AUDIO` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.CosyVoice3Generator` |
| **目标节点** | `GJJ_CosyVoice3Generator` |
| **实现钩子** | `beforeRegisterNodeDef` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```