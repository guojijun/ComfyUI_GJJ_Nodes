# GJJ_LongCatAudioDiTTTS

## 📋 概述

**功能**: LongCat AudioDiT 一体式语音克隆与多说话人 TTS。默认从 models/mp3 选择参考音频；连接音频后按实际音频输入数量自动计算说话人数，并自动保存 MP3 供节点内预览。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_longcat_audiodit_tts.js` |  |
| 🔧 后端 | `nodes/gjj_longcat_audiodit_tts.py` | `GJJ_LongCatAudioDiTTTS` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_LongCatAudioDiTTTS` |
| **CATEGORY** | `GJJ/Audio` |
| **FUNCTION** | `generate` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `model_path` | `model_names` | `_pick_default_model(model_names)` | ✓ |  |
| `text` | `STRING` | `[speaker_1]: 最近字母圈怎么样？\n[speaker_2]: 你说的是什么字母？\n[speaker_1]: AI！人工智能！\n[speaker_2]: 哦，我以为你说的是SM？哈哈……` | ✓ |  |
| `local_audio_name` | `audio_choices` | `default_audio` | ✓ |  |
| `steps` | `INT` | `16` | ✓ |  |
| `guidance_strength` | `FLOAT` | `4.0` | ✓ |  |
| `guidance_method` | `["cfg` | `apg` | ✓ |  |
| `device` | `["auto` | `auto` | ✓ |  |
| `dtype` | `["auto` | `auto` | ✓ |  |
| `attention` | `["auto` | `auto` | ✓ |  |
| `seed` | `INT` | `0` | ✓ |  |
| `pause_after_speaker` | `FLOAT` | `0.4` | ✓ |  |
| `normalize_reference` | `BOOLEAN` | `True` | ✓ |  |
| `reference_dbfs` | `FLOAT` | `-23.0` | ✓ |  |
| `keep_model_loaded` | `BOOLEAN` | `True` | ✓ |  |
| `mp3_filename_prefix` | `STRING` | `audio/GJJ_LongCat` | ✓ |  |
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
| **扩展名** | `Comfy.GJJ.LongCatAudioDiTTTS` |
| **目标节点** | `GJJ_LongCatAudioDiTTTS` |
| **实现钩子** | `beforeRegisterNodeDef, setup, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```