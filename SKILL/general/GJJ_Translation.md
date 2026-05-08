# GJJ_Translation

## 📋 概述

**功能**: 调用本地 Ollama 模型进行中英提示词翻译，并尽量保持 AI 绘画术语、权重符号和原始结构不变。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_translation.py` | `GJJ_Translation` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_Translation` |
| **CATEGORY** | `GJJ/LLM` |
| **FUNCTION** | `translate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `text` | `STRING` | `` | ✓ |  |
| `model` | `model_options` | `default_model` | ✓ |  |
| `target_language` | `["Chinese` | `English` | ✓ |  |
| `model_keep_alive` | `["保持模型` | `保持模型` | ✓ |  |
| `ollama_host` | `STRING` | `DEFAULT_OLLAMA_HOST` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 翻译输出文本 | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```