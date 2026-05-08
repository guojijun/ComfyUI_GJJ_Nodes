# GJJ_LoadSAM3DBodyModel

## 📋 概述

**功能**: GJJ 内置 SAM 3D Body 模型加载器，不依赖 ComfyUI-SAM3DBody 自定义节点包。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_sam3d_body.py` | `GJJ_LoadSAM3DBodyModel` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_LoadSAM3DBodyModel` |
| **CATEGORY** | `GJJ/3D` |
| **FUNCTION** | `load_model` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `model_path` | `STRING` | `str(DEFAULT_MODEL_DIR)` | ✓ |  |
| `attn_backend` | `["auto` | `auto` | ✓ |  |
| `precision` | `["auto` | `auto` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| SAM3D模型 | `SAM3D_MODEL` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```