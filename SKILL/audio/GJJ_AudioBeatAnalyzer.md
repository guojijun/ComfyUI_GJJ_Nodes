# GJJ_AudioBeatAnalyzer

## 📋 概述

**功能**: 轻量音频节拍分析，不依赖 librosa，输出 BPM 和节拍时间 JSON。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_audio_tools.py` | `GJJ_AudioBeatAnalyzer` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_AudioBeatAnalyzer` |
| **CATEGORY** | `GJJ/音频` |
| **FUNCTION** | `analyze` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `audio` | `AUDIO` | `-` | ✓ |  |
| `sensitivity` | `FLOAT` | `1.35` | ✓ |  |
| `min_bpm` | `FLOAT` | `60.0` | ✓ |  |
| `max_bpm` | `FLOAT` | `180.0` | ✓ |  |
| `offset_ms` | `INT` | `0` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 音频 | `AUDIO` | |
| BPM | `FLOAT` | |
| 节拍JSON | `STRING` | |
| 节拍预览 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```