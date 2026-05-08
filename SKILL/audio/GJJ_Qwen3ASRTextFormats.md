# GJJ_Qwen3ASRTextFormats

## 📋 概述

**功能**: Qwen3-ASR 一体式语音识别与强制对齐节点。输入 ComfyUI 音频，输出时间戳表、分段文本、开始时间和结束时间四种文本。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_qwen3_asr_text_formats.py` | `GJJ_Qwen3ASRTextFormats` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_Qwen3ASRTextFormats` |
| **CATEGORY** | `GJJ/Audio` |
| **FUNCTION** | `transcribe_and_align` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `audio` | `AUDIO` | `-` | ✓ |  |
| `asr_model_name` | `asr_models` | `Qwen3-ASR-1.7B" if "Qwen3-ASR-1.7B" in asr_models else asr_models[0]` | ✓ |  |
| `aligner_model_name` | `aligner_models` | `Qwen3-ForcedAligner-0.6B" if "Qwen3-ForcedAligner-0.6B" in aligner_models else aligner_models[0]` | ✓ |  |
| `asr_language` | `ASR_LANGUAGES` | `Auto` | ✓ |  |
| `align_language` | `[ALIGN_AUTO] + ALIGN_LANGUAGES` | `ALIGN_AUTO` | ✓ |  |
| `segment_by_sentence` | `BOOLEAN` | `True` | ✓ |  |
| `context` | `STRING` | `` |  |  |
| `auto_download` | `BOOLEAN` | `True` |  |  |
| `precision` | `PRECISION_OPTIONS` | `自动` |  |  |
| `max_inference_batch_size` | `INT` | `32` |  |  |
| `max_new_tokens` | `INT` | `512` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 时间戳表 | `STRING` | |
| 分段文本 | `STRING` | |
| 开始时间列表 | `STRING` | |
| 结束时间列表 | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```