# GJJ_VideoCombine

## 📋 概述

**功能**: 节点 `GJJ_VideoCombine`

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_video_combine.js` |  |
| 🔧 后端 | `nodes/gjj_video_combine.py` | `GJJ_VideoCombine` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_VideoCombine` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `combine` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `images` | `image_or_latent` | `-` | ✓ |  |
| `frame_rate` | `float_or_int` | `DEFAULT_FRAME_RATE` | ✓ |  |
| `loop_count` | `INT` | `0` | ✓ |  |
| `filename_prefix` | `STRING` | `DEFAULT_FILENAME_PREFIX` | ✓ |  |
| `format_name` | `supported_formats` | `default_format` | ✓ |  |
| `pingpong` | `BOOLEAN` | `False` | ✓ |  |
| `save_output` | `BOOLEAN` | `True` | ✓ |  |
| `use_source_fps` | `BOOLEAN` | `True` | ✓ |  |
| `audio` | `AUDIO` | `-` |  |  |
| `vae` | `VAE` | `-` |  |  |
| `format_overrides_json` | `STRING` | `` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 视频 | `VIDEO` | |
| 主输出文件 | `STRING` | |
| 输出文件列表JSON | `STRING` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.VideoCombine` |
| **目标节点** | `GJJ_VideoCombine` |
| **实现钩子** | `beforeRegisterNodeDef, setup, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```