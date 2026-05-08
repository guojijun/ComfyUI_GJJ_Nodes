# GJJ_ImageAnalysis

## 📋 概述

**功能**: 调用本地 Ollama 多模态模型分析图片内容，并整理成适合文生图使用的反推提示词。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_image_analysis.py` | `GJJ_ImageAnalysis` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_ImageAnalysis` |
| **CATEGORY** | `GJJ/LLM` |
| **FUNCTION** | `analyze` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `ollama_host` | `STRING` | `DEFAULT_OLLAMA_HOST` | ✓ |  |
| `model` | `model_options` | `DEFAULT_IMAGE_ANALYSIS_MODEL` | ✓ |  |
| `model_keep_alive` | `["保持模型` | `保持模型` | ✓ |  |
| `thinking_mode` | `["关闭思考` | `关闭思考` | ✓ |  |
| `temperature` | `FLOAT` | `DEFAULT_TEMPERATURE` | ✓ |  |
| `max_tokens` | `INT` | `DEFAULT_MAX_TOKENS` | ✓ |  |
| `system_prompt` | `STRING` | `DEFAULT_IMAGE_ANALYSIS_SYSTEM_PROMPT` | ✓ |  |
| `user_prompt` | `STRING` | `DEFAULT_USER_PROMPT` | ✓ |  |
| `image` | `IMAGE` | `-` |  |  |
| `batch_image` | `GJJ_BATCH_IMAGE_TYPE` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 图像分析提示 | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```