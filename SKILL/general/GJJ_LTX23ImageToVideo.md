# GJJ_LTX23ImageToVideo

## 📋 概述

**功能**: 将 LTX-2.3 图生/文生视频工作流封装成零外部依赖单节点：接入图像时走图生视频；接入音频时切换到数字人音频驱动流程，时长按音频自动对齐。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_ltx23_image_to_video.js` |  |
| 🔧 后端 | `nodes/gjj_ltx23_image_to_video.py` | `GJJ_LTX23ImageToVideo` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_LTX23ImageToVideo` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `generate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `positive_prompt` | `STRING` | `DEFAULT_PROMPT` | ✓ |  |
| `negative_prompt` | `STRING` | `DEFAULT_NEGATIVE` | ✓ |  |
| `ckpt_name` | `filtered_ckpts` | `DEFAULT_CKPT if DEFAULT_CKPT in filtered_ckpts else filtered_ckpts[0]` | ✓ |  |
| `lora_name_1` | `lora_choices` | `default_lora_1` | ✓ |  |
| `lora_strength_1` | `FLOAT` | `DEFAULT_DISTILLED_LORA_STRENGTH` | ✓ |  |
| `lora_name_2` | `lora_choices` | `default_lora_2` | ✓ |  |
| `lora_strength_2` | `FLOAT` | `DEFAULT_GYDBOY_LORA_STRENGTH` | ✓ |  |
| `width` | `INT` | `DEFAULT_WIDTH` | ✓ |  |
| `height` | `INT` | `DEFAULT_HEIGHT` | ✓ |  |
| `frame_count` | `INT` | `DEFAULT_FRAME_COUNT` | ✓ |  |
| `fps` | `INT` | `DEFAULT_FPS` | ✓ |  |
| `seed` | `INT` | `DEFAULT_SEED` | ✓ |  |
| `auto_use_first_image_size` | `BOOLEAN` | `True` | ✓ |  |
| `relay_local_prompts` | `STRING` | `` | ✓ |  |
| `relay_segment_lengths` | `STRING` | `` | ✓ |  |
| `relay_epsilon` | `FLOAT` | `DEFAULT_RELAY_EPSILON` | ✓ |  |
| `input_image` | `IMAGE` | `-` |  |  |
| `input_audio` | `AUDIO` | `-` |  |  |
| `relay_prompt_input` | `STRING` | `-` |  |  |
| `lora_chain_config` | `LORA_CHAIN_CONFIG` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 视频生成结果 | `VIDEO` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.LTX23ImageToVideo` |
| **目标节点** | `GJJ_LTX23ImageToVideo` |
| **实现钩子** | `beforeRegisterNodeDef` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```