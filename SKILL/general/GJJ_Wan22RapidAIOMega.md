# GJJ_Wan22RapidAIOMega

## 📋 概述

**功能**: 节点 `GJJ_Wan22RapidAIOMega`

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_wan22_rapid_aio_mega.js` |  |
| 🔧 后端 | `nodes/gjj_wan22_rapid_aio_mega.py` | `GJJ_Wan22RapidAIOMega` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_Wan22RapidAIOMega` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `generate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `positive_prompt` | `STRING` | `DEFAULT_POSITIVE` | ✓ |  |
| `negative_prompt` | `STRING` | `DEFAULT_NEGATIVE` | ✓ |  |
| `checkpoint_name` | `checkpoints` | `default_checkpoint` | ✓ |  |
| `width` | `INT` | `DEFAULT_WIDTH` | ✓ |  |
| `height` | `INT` | `DEFAULT_HEIGHT` | ✓ |  |
| `segment_frames` | `INT` | `DEFAULT_SEGMENT_FRAMES` | ✓ |  |
| `auto_use_first_image_size` | `BOOLEAN` | `True` | ✓ |  |
| `seed` | `INT` | `6456545463455` | ✓ |  |
| `images` | `GJJ_BATCH_IMAGE_TYPE` | `-` |  |  |
| `lora_chain_config` | `LORA_CHAIN_CONFIG` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 视频帧序列 | `GJJ_BATCH_IMAGE` | |
| - | `IMAGE` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.Wan22RapidAIOMega` |
| **目标节点** | `GJJ_Wan22RapidAIOMega` |
| **实现钩子** | `beforeRegisterNodeDef, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```