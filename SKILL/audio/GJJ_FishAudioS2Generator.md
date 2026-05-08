# GJJ_FishAudioS2Generator

## 📋 概述

**功能**: Fish Audio S2 一体式 TTS、单人语音克隆和多说话人语音克隆节点。内置 Fish Speech 运行时源码，不依赖原 ComfyUI-fish-audio-s2 节点包。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_fish_audio_s2_generator.js` |  |
| 🔧 后端 | `nodes/gjj_fish_audio_s2_generator.py` | `GJJ_FishAudioS2Generator` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_FishAudioS2Generator` |
| **CATEGORY** | `GJJ/Audio` |
| **FUNCTION** | `generate` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `mode` | `MODES` | `单人克隆` | ✓ |  |
| `model_path` | `model_names` | `_pick_default_model(model_names)` | ✓ |  |
| `text` | `STRING` | `你好！[excited] 这是 Fish Audio S2 的语音克隆测试。` | ✓ |  |
| `default_reference_text` | `STRING` | `DEFAULT_REFERENCE_TEXT` | ✓ |  |
| `local_audio_name` | `audio_choices` | `default_audio` | ✓ |  |
| `language` | `LANGUAGES` | `auto` | ✓ |  |
| `device` | `["auto` | `auto` | ✓ |  |
| `precision` | `["auto` | `auto` | ✓ |  |
| `attention` | `["auto` | `auto` | ✓ |  |
| `max_new_tokens` | `INT` | `0` | ✓ |  |
| `chunk_length` | `INT` | `200` | ✓ |  |
| `temperature` | `FLOAT` | `0.7` | ✓ |  |
| `top_p` | `FLOAT` | `0.7` | ✓ |  |
| `repetition_penalty` | `FLOAT` | `1.2` | ✓ |  |
| `seed` | `INT` | `42` | ✓ |  |
| `pause_after_speaker` | `FLOAT` | `0.4` | ✓ |  |
| `keep_model_loaded` | `BOOLEAN` | `True` | ✓ |  |
| `offload_to_cpu` | `BOOLEAN` | `False` | ✓ |  |
| `compile_model` | `BOOLEAN` | `False` | ✓ |  |
| `mp3_filename_prefix` | `STRING` | `audio/GJJ_FishAudioS2` | ✓ |  |
| `mp3_quality` | `MP3_QUALITY_OPTIONS` | `320k` | ✓ |  |
| `*动态输入*` | `Dynamic` | `-` |  | 支持动态数量输入插槽 |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 合成音频 | `AUDIO` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `Comfy.GJJ.FishAudioS2Generator` |
| **目标节点** | `GJJ_FishAudioS2Generator` |
| **实现钩子** | `beforeRegisterNodeDef, setup, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```