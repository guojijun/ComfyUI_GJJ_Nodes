# GJJ_FishAudioS2Generator

## 📋 概述

Fish Audio S2 一体式 TTS、单人语音克隆和多说话人语音克隆节点。内置 Fish Speech 运行时源码，不依赖原 ComfyUI-fish-audio-s2 节点包。
**搜索关键词**: Fish Audio, Fish S2, TTS, 语音克隆, 多说话人, 文字转语音

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🔧 后端 | `nodes/gjj_fish_audio_s2_generator.py` | 节点执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_FishAudioS2Generator` |
| **CATEGORY** | `GJJ/Audio` |
| **FUNCTION** | `generate` |
| **OUTPUT_NODE** | `True` |
| **搜索别名** | `Fish Audio`, `Fish S2`, `TTS`, `语音克隆`, `多说话人`, `文字转语音` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `mode` | `MODES` | {
                    "default": "单人克隆",
      ... | ✓ | |
| `model_path` | `model_names` | {
                    "default": _pick_default_... | ✓ | |
| `text` | `STRING` | {
                    "multiline": True,
      ... | ✓ | |
| `default_reference_text` | `STRING` | {
                    "multiline": True,
      ... | ✓ | |
| `local_audio_name` | `audio_choices` | {
                    "default": default_audio,... | ✓ | |
| `language` | `LANGUAGES` | {
                    "default": "auto",
      ... | ✓ | |
| `device` | `["auto", "cuda", "cpu", "mps"]` | {
                    "default": "auto",
      ... | ✓ | |
| `precision` | `["auto", "bfloat16", "float16", "float32"]` | {
                    "default": "auto",
      ... | ✓ | |
| `attention` | `["auto", "sdpa", "sage_attention", "flash_attention"]` | {
                    "default": "auto",
      ... | ✓ | |
| `max_new_tokens` | `INT` | {
                    "default": 0,
           ... | ✓ | |
| `chunk_length` | `INT` | {
                    "default": 200,
         ... | ✓ | |
| `temperature` | `FLOAT` | {
                    "default": 0.7,
         ... | ✓ | |
| `top_p` | `FLOAT` | {
                    "default": 0.7,
         ... | ✓ | |
| `repetition_penalty` | `FLOAT` | {
                    "default": 1.2,
         ... | ✓ | |
| `seed` | `INT` | {
                    "default": 42,
          ... | ✓ | |
| `pause_after_speaker` | `FLOAT` | {
                    "default": 0.4,
         ... | ✓ | |
| `keep_model_loaded` | `BOOLEAN` | {
                    "default": True,
        ... | ✓ | |
| `offload_to_cpu` | `BOOLEAN` | {
                    "default": False,
       ... | ✓ | |
| `compile_model` | `BOOLEAN` | {
                    "default": False,
       ... | ✓ | |
| `mp3_filename_prefix` | `STRING` | {
                    "default": "audio/GJJ_Fis... | ✓ | |
| `mp3_quality` | `MP3_QUALITY_OPTIONS` | {
                    "default": "320k",
      ... | ✓ | |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 合成音频 | `AUDIO` | |
|  | `` | |

## 🏗️ 数据流
```
ComfyUI 图引擎 → [后端节点执行] → 输出
```
