# GJJ_SafetensorsMetadataWriter

## 📋 概述

**功能**: 为模型同名写入 txt 旁注和 png 封面；不改写 safetensors 本体，避免破坏模型文件。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_metadata_viewer.py` | `GJJ_SafetensorsMetadataWriter` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_SafetensorsMetadataWriter` |
| **CATEGORY** | `GJJ/Info` |
| **FUNCTION** | `write` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `model_path` | `STRING` | `` | ✓ |  |
| `note_text` | `STRING` | `` | ✓ |  |
| `write_note` | `BOOLEAN` | `True` | ✓ |  |
| `cover_image` | `IMAGE` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 模型路径 | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```