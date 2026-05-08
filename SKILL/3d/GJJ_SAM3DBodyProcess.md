# GJJ_SAM3DBodyProcess

## 📋 概述

**功能**: GJJ 内置 SAM 3D Body 单图人体网格恢复节点。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_sam3d_body.py` | `GJJ_SAM3DBodyProcess` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_SAM3DBodyProcess` |
| **CATEGORY** | `GJJ/3D` |
| **FUNCTION** | `process` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `model` | `SAM3D_MODEL` | `-` | ✓ |  |
| `image` | `IMAGE` | `-` | ✓ |  |
| `bbox_threshold` | `FLOAT` | `0.8` | ✓ |  |
| `inference_type` | `["full` | `full` | ✓ |  |
| `mask` | `MASK` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 网格数据 | `SAM3D_OUTPUT` | |
| 骨架数据 | `SKELETON` | |
| 调试图 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```