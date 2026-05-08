# GJJ_OllamaDirectoryCaptioner

## 📋 概述

**功能**: 通过浏览器选择任意本地目录，调用本地 Ollama 多模态模型为目录中的图片生成同名 txt 打标文件。适合后续 LoRA 数据预标注。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_ollama_directory_captioner.js` |  |
| 🔧 后端 | `nodes/gjj_ollama_directory_captioner.py` | `GJJ_OllamaDirectoryCaptioner` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_OllamaDirectoryCaptioner` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `get_summary` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `ollama_host` | `STRING` | `DEFAULT_OLLAMA_HOST` | ✓ |  |
| `ollama_model` | `()` | `DEFAULT_OLLAMA_MODEL` | ✓ |  |
| `prompt_template` | `STRING` | `DEFAULT_PROMPT` | ✓ |  |
| `overwrite_existing` | `BOOLEAN` | `False` | ✓ |  |
| `include_subdirectories` | `BOOLEAN` | `True` | ✓ |  |
| `selected_directory` | `STRING` | `` | ✓ |  |
| `last_summary` | `STRING` | `等待执行` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 打标结果摘要 | `STRING` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.OllamaDirectoryCaptioner` |
| **目标节点** | `GJJ_OllamaDirectoryCaptioner` |
| **实现钩子** | `beforeRegisterNodeDef` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```