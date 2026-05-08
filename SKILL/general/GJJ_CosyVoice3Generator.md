# GJJ_CosyVoice3Generator

## 📋 概述

CosyVoice3 一体式语音克隆器。内部自动加载本地 models/cosyvoice 模型，支持零样本复刻、跨语言复刻与指令风格控制。

**显示名称**: GJJ·📢[风格指令]语音克隆器TTS(CosyVoice3)

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🔧 后端 | `nodes/gjj_cosyvoice3_generator.py` | 节点执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_CosyVoice3Generator` |
| **CATEGORY** | `GJJ/Audio` |
| **FUNCTION** | `generate` |
| **OUTPUT_NODE** | `True` |
| **显示名** | `GJJ·📢[风格指令]语音克隆器TTS(CosyVoice3)` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `mode` | `MODE_OPTIONS` | {
					"default": "零样本复刻",
					"display_name":... | ✓ | |
| `example_audio_name` | `example_audios or [MISSING_EXAMPLE_AUDIO]` | {
					"default": example_audios[0] if example_... | ✓ | |
| `model_name` | `available or [DEFAULT_MODEL_NAME]` | {
					"default": default_model,
					"display_... | ✓ | |
| `text` | `STRING` | {
					"default": "你好，这是一段使用 CosyVoice3 生成的语音。"... | ✓ | |
| `speed` | `FLOAT` | {
					"default": 1.0,
					"min": 0.5,
					"m... | ✓ | |
| `reference_text` | `STRING` | {
					"default": DEFAULT_REFERENCE_TEXT,
					... | ✓ | |
| `instruct_text` | `STRING` | {
					"default": "请以自然、清晰、富有感情的语气朗读。",
					"m... | ✓ | |
| `auto_transcribe` | `BOOLEAN` | {
					"default": True,
					"display_name": "自... | ✓ | |
| `text_frontend` | `BOOLEAN` | {
					"default": True,
					"display_name": "启... | ✓ | |
| `seed` | `INT` | {
					"default": 42,
					"min": -1,
					"max... | ✓ | |
| `mp3_filename_prefix` | `STRING` | {
					"default": "audio/GJJ_CosyVoice3",
					... | ✓ | |
| `mp3_quality` | `MP3_QUALITY_OPTIONS` | {
					"default": "320k",
					"display_name": ... | ✓ | |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 语音音频输出 | `AUDIO` | |
|  | `` | |

## 🏗️ 数据流
```
ComfyUI 图引擎 → [后端节点执行] → 输出
```
