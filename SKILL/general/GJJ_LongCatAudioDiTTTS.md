# GJJ_LongCatAudioDiTTTS

## 📋 概述

LongCat AudioDiT 一体式语音克隆与多说话人 TTS。默认从 models/mp3 选择参考音频；连接音频后按实际音频输入数量自动计算说话人数，并自动保存 MP3 供节点内预览。
**搜索关键词**: LongCat, AudioDiT, TTS, 语音克隆, 多说话人, 文字转语音

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🔧 后端 | `nodes/gjj_longcat_audiodit_tts.py` | 节点执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_LongCatAudioDiTTTS` |
| **CATEGORY** | `GJJ/Audio` |
| **FUNCTION** | `generate` |
| **OUTPUT_NODE** | `True` |
| **搜索别名** | `LongCat`, `AudioDiT`, `TTS`, `语音克隆`, `多说话人`, `文字转语音` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `model_path` | `model_names` | {
                    "default": _pick_default_... | ✓ | |
| `text` | `STRING` | {
                    "multiline": True,
      ... | ✓ | |
| `local_audio_name` | `audio_choices` | {
                    "default": default_audio,... | ✓ | |
| `steps` | `INT` | {
                    "default": 16,
          ... | ✓ | |
| `guidance_strength` | `FLOAT` | {
                    "default": 4.0,
         ... | ✓ | |
| `guidance_method` | `["cfg", "apg"]` | {
                    "default": "apg",
       ... | ✓ | |
| `device` | `["auto", "cuda", "cpu", "mps"]` | {
                    "default": "auto",
      ... | ✓ | |
| `dtype` | `["auto", "bf16", "fp16", "fp32"]` | {
                    "default": "auto",
      ... | ✓ | |
| `attention` | `["auto", "sdpa", "sage_attention", "flash_attention"]` | {
                    "default": "auto",
      ... | ✓ | |
| `seed` | `INT` | {
                    "default": 0,
           ... | ✓ | |
| `pause_after_speaker` | `FLOAT` | {
                    "default": 0.4,
         ... | ✓ | |
| `normalize_reference` | `BOOLEAN` | {
                    "default": True,
        ... | ✓ | |
| `reference_dbfs` | `FLOAT` | {
                    "default": -23.0,
       ... | ✓ | |
| `keep_model_loaded` | `BOOLEAN` | {
                    "default": True,
        ... | ✓ | |
| `mp3_filename_prefix` | `STRING` | {
                    "default": "audio/GJJ_Lon... | ✓ | |
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
