# GJJ_PromptRelayEncode

## 📋 概述

**功能**: 将全局提示词和按时间分段的局部提示词编码为视频时序控制条件，支持 Wan 与 LTX。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_prompt_relay.py` | `GJJ_PromptRelayEncode` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_PromptRelayEncode` |
| **CATEGORY** | `GJJ/视频/时序提示词` |
| **FUNCTION** | `encode` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `model` | `MODEL` | `-` | ✓ |  |
| `clip` | `CLIP` | `-` | ✓ |  |
| `latent` | `LATENT` | `-` | ✓ |  |
| `global_prompt` | `STRING` | `` | ✓ |  |
| `local_prompts` | `STRING` | `` | ✓ |  |
| `segment_lengths` | `STRING` | `` | ✓ |  |
| `epsilon` | `FLOAT` | `0.001` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 时序控制模型 | `MODEL` | |
| 正向条件 | `CONDITIONING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```