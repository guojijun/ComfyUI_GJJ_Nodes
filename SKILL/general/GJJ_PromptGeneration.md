# GJJ_PromptGeneration

## 📋 概述

**功能**: 调用本地 Ollama 模型生成提示词或文本内容，适合快速草拟文生图提示词与创作方向。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_prompt_generation.py` | `GJJ_PromptGeneration` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_PromptGeneration` |
| **CATEGORY** | `GJJ/LLM` |
| **FUNCTION** | `generate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `model` | `model_options` | `default_model` | ✓ |  |
| `model_keep_alive` | `["保持模型` | `保持模型` | ✓ |  |
| `thinking_mode` | `["关闭思考` | `关闭思考` | ✓ |  |
| `seed` | `INT` | `0` | ✓ |  |
| `temperature` | `FLOAT` | `0.7` | ✓ |  |
| `max_tokens` | `INT` | `512` | ✓ |  |
| `system_prompt` | `STRING` | `DEFAULT_SYSTEM_PROMPT` | ✓ |  |
| `user_prompt` | `STRING` | `` | ✓ |  |
| `ollama_host` | `STRING` | `DEFAULT_OLLAMA_HOST` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 提示生成结果 | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```