# GJJ_QwenTimestampToPromptRelay

## 📋 概述

**功能**: 把 Qwen3-ASR 的 [开始s-结束s] 时间戳表转换为 PromptRelay 可用的 | 分段局部提示词和逐段帧数。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_qwen_timestamp_to_prompt_relay.py` | `GJJ_QwenTimestampToPromptRelay` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_QwenTimestampToPromptRelay` |
| **CATEGORY** | `GJJ/视频` |
| **FUNCTION** | `convert` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `timestamp_table` | `STRING` | `-` | ✓ |  |
| `fps` | `FLOAT` | `25.0` | ✓ |  |
| `speech_template` | `STRING` | `DEFAULT_SPEECH_TEMPLATE` | ✓ |  |
| `gap_prompt` | `STRING` | `DEFAULT_GAP_PROMPT` | ✓ |  |
| `min_gap_seconds` | `FLOAT` | `0.08` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 局部提示词 | `STRING` | |
| 分段帧数 | `STRING` | |
| 调试预览 | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```