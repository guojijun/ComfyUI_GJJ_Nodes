# GJJ_AudioAceMusicGenerator

## 📋 概述

**功能**: 将 Audio ACE 1.5 两套工作流合并成单节点：优先使用整包 checkpoint，缺失时自动回退到 split 模型组，直接生成音乐音频。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_audio_ace_music_generator.js` |  |
| 🔧 后端 | `nodes/gjj_audio_ace_music_generator.py` | `GJJ_AudioAceMusicGenerator` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_AudioAceMusicGenerator` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `generate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `model_name` | `models` | `DEFAULT_CHECKPOINT if DEFAULT_CHECKPOINT in models else models[0]` | ✓ |  |
| `tags` | `STRING` | `DEFAULT_TAGS` | ✓ |  |
| `lyrics` | `STRING` | `DEFAULT_LYRICS` | ✓ |  |
| `duration` | `FLOAT` | `DEFAULT_DURATION` | ✓ |  |
| `bpm` | `INT` | `DEFAULT_BPM` | ✓ |  |
| `timesignature` | `["2` | `DEFAULT_TIMESIGNATURE` | ✓ |  |
| `language` | `["en` | `DEFAULT_LANGUAGE` | ✓ |  |
| `keyscale` | `{root}` | `DEFAULT_KEYSCALE` | ✓ |  |
| `seed` | `INT` | `31` | ✓ |  |
| `lyrics_strength` | `FLOAT` | `1.0` |  |  |
| `generate_audio_codes` | `BOOLEAN` | `True` |  |  |
| `cfg_scale` | `FLOAT` | `2.0` |  |  |
| `temperature` | `FLOAT` | `0.85` |  |  |
| `top_p` | `FLOAT` | `0.9` |  |  |
| `top_k` | `INT` | `0` |  |  |
| `min_p` | `FLOAT` | `0.0` |  |  |
| `shift` | `FLOAT` | `DEFAULT_SHIFT` |  |  |
| `steps` | `INT` | `DEFAULT_STEPS` |  |  |
| `cfg` | `FLOAT` | `DEFAULT_CFG` |  |  |
| `sampler_name` | `comfy.samplers.KSampler.SAMPLERS` | `DEFAULT_SAMPLER` |  |  |
| `scheduler` | `comfy.samplers.KSampler.SCHEDULERS` | `DEFAULT_SCHEDULER` |  |  |
| `denoise` | `FLOAT` | `DEFAULT_DENOISE` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 音乐音频输出 | `AUDIO` | |
| 音乐结果摘要 | `STRING` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.AudioAceMusicGenerator` |
| **目标节点** | `GJJ_AudioAceMusicGenerator` |
| **实现钩子** | `beforeRegisterNodeDef` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```