# GJJ_SafetensorsMetadataViewer

## 📋 概述

**功能**: 直接读取 safetensors 文件头里的 metadata，不加载模型权重，适合查看 LoRA 触发词和训练信息。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_metadata_viewer.py` | `GJJ_SafetensorsMetadataViewer` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_SafetensorsMetadataViewer` |
| **CATEGORY** | `GJJ/Info` |
| **FUNCTION** | `read` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `model_path` | `STRING` | `` | ✓ |  |
| `include_tensor_keys` | `BOOLEAN` | `False` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 元数据JSON | `STRING` | |
| 触发词 | `STRING` | |
| 旁注文本 | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```