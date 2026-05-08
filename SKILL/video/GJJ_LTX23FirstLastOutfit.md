# GJJ_LTX23FirstLastOutfit

## 📋 概述

**功能**: LTX-2.3 首尾帧变装转场一体化节点：输入首帧和尾帧，内部完成 LTX guide、过渡 LoRA、两段采样、latent 放大和视频输出，不依赖 KJ/VHS/ComfyMath 等外部自定义节点。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_ltx23_first_last_outfit.js` |  |
| 🔧 后端 | `nodes/gjj_ltx23_first_last_outfit.py` | `GJJ_LTX23FirstLastOutfit` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_LTX23FirstLastOutfit` |
| **CATEGORY** | `GJJ/视频` |
| **FUNCTION** | `generate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `positive_prompt` | `STRING` | `DEFAULT_PROMPT` | ✓ |  |
| `negative_prompt` | `STRING` | `DEFAULT_NEGATIVE` | ✓ |  |
| `ckpt_name` | `ckpts` | `default_ckpt` | ✓ |  |
| `transition_lora` | `lora_choices` | `AUTO_LORA` | ✓ |  |
| `transition_lora_strength` | `FLOAT` | `DEFAULT_TRANSITION_LORA_STRENGTH` | ✓ |  |
| `refocus_lora` | `lora_choices` | `DISABLE_LORA` | ✓ |  |
| `refocus_lora_strength` | `FLOAT` | `DEFAULT_REFOCUS_LORA_STRENGTH` | ✓ |  |
| `detailer_lora` | `lora_choices` | `DISABLE_LORA` | ✓ |  |
| `detailer_lora_strength` | `FLOAT` | `DEFAULT_DETAILER_LORA_STRENGTH` | ✓ |  |
| `base_width` | `INT` | `DEFAULT_BASE_WIDTH` | ✓ |  |
| `base_height` | `INT` | `DEFAULT_BASE_HEIGHT` | ✓ |  |
| `frame_count` | `INT` | `DEFAULT_FRAME_COUNT` | ✓ |  |
| `fps` | `INT` | `DEFAULT_FPS` | ✓ |  |
| `stage1_seed` | `INT` | `DEFAULT_STAGE1_SEED` | ✓ |  |
| `stage2_seed` | `INT` | `DEFAULT_STAGE2_SEED` | ✓ |  |
| `first_strength` | `FLOAT` | `DEFAULT_GUIDE_STRENGTH` | ✓ |  |
| `last_strength` | `FLOAT` | `DEFAULT_GUIDE_STRENGTH` | ✓ |  |
| `double_latent_upscale` | `BOOLEAN` | `True` | ✓ |  |
| `decode_generated_audio` | `BOOLEAN` | `True` | ✓ |  |
| `image_queue` | `{GJJ_BATCH_IMAGE_TYPE}` | `-` |  |  |
| `first_image` | `IMAGE` | `-` |  |  |
| `last_image` | `IMAGE` | `-` |  |  |
| `lora_chain_config` | `LORA_CHAIN_CONFIG` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 视频生成结果 | `VIDEO` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.LTX23FirstLastOutfit` |
| **目标节点** | `GJJ_LTX23FirstLastOutfit` |
| **实现钩子** | `beforeRegisterNodeDef, setup, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```