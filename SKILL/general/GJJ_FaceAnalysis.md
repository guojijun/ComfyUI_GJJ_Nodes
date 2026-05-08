# GJJ_FaceAnalysis

## 📋 概述

**功能**: 节点 `GJJ_FaceAnalysis`

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_face_analysis.py` | `GJJ_FaceAnalysis` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_FaceAnalysis` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `swap_faces` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `target_image` | `GJJ_BATCH_IMAGE` | `-` | ✓ |  |
| `source_image` | `GJJ_BATCH_IMAGE` | `-` | ✓ |  |
| `face_model` | `available_models` | `available_models[0] if available_models and available_models[0] != "无可用模型" else "无可用模型` |  |  |
| `swap_model` | `["inswapper_128.onnx` | `inswapper_128.onnx` |  |  |
| `face_detection` | `["YOLOv5n` | `YOLOv5n` |  |  |
| `target_faces_index` | `STRING` | `0` |  |  |
| `source_faces_index` | `STRING` | `0` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 换脸结果 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```