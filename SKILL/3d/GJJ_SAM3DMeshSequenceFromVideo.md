# GJJ_SAM3DMeshSequenceFromVideo

## 📋 概述

**功能**: GJJ 内置 SAM3D Body 视频帧转人体网格序列节点，兼容 SAM3D From Video JK 的输出格式。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_sam3d_body.py` | `GJJ_SAM3DMeshSequenceFromVideo` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_SAM3DMeshSequenceFromVideo` |
| **CATEGORY** | `GJJ/3D` |
| **FUNCTION** | `generate_from_video_frames` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `model` | `SAM3D_MODEL` | `-` | ✓ |  |
| `image` | `IMAGE` | `-` | ✓ |  |
| `output_filename` | `STRING` | `mesh_sequence` | ✓ |  |
| `bbox_threshold` | `FLOAT` | `0.8` | ✓ |  |
| `inference_type` | `["full` | `full` | ✓ |  |
| `fps` | `FLOAT` | `30.0` | ✓ |  |
| `smoothing` | `BOOLEAN` | `True` | ✓ |  |
| `smoothing_window` | `INT` | `5` | ✓ |  |
| `coordinate_transform` | `["rotate_z_180` | `rotate_z_180` | ✓ |  |
| `mask` | `MASK` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| SMPL序列文件 | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```