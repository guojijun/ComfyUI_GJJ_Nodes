# GJJ_LTX23ImageToVideoMultiRef

## 📋 概述

**功能**: LTX-2.3 图文生视频多图参考器：0 图走文生视频，1 图走图生视频，多图可整体参考生成，也可按相邻两图分段执行并逐段保存预览；接入驱动音频后自动切到数字人流程，整段音频会直接决定总帧数，建议先用短音频测试；LoRA 统一通过 LoRA串联配置接入。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_ltx23_multiref_image_to_video.js` |  |
| 🔧 后端 | `nodes/gjj_ltx23_multiref_image_to_video.py` | `GJJ_LTX23ImageToVideoMultiRef` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_LTX23ImageToVideoMultiRef` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `generate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `positive_prompt` | `STRING` | `DEFAULT_PROMPT` | ✓ |  |
| `negative_prompt` | `STRING` | `DEFAULT_NEGATIVE_PROMPT` | ✓ |  |
| `segment_seconds` | `FLOAT` | `DEFAULT_SEGMENT_SECONDS` | ✓ |  |
| `width` | `INT` | `DEFAULT_WIDTH` | ✓ |  |
| `height` | `INT` | `DEFAULT_HEIGHT` | ✓ |  |
| `fps` | `INT` | `DEFAULT_FPS` | ✓ |  |
| `seed` | `INT` | `DEFAULT_SEED` | ✓ |  |
| `denoise_strength` | `FLOAT` | `DEFAULT_DENOISE_STRENGTH` | ✓ |  |
| `transition_enabled` | `BOOLEAN` | `False` | ✓ |  |
| `transition_curve` | `TRANSITION_CURVES` | `TRANSITION_CURVES[0]` | ✓ |  |
| `transition_early_tail_ratio` | `FLOAT` | `DEFAULT_TRANSITION_EARLY_TAIL_RATIO` | ✓ |  |
| `transition_implicit_guide_count` | `INT` | `DEFAULT_TRANSITION_IMPLICIT_GUIDE_COUNT` | ✓ |  |
| `transition_implicit_guide_strength` | `FLOAT` | `DEFAULT_TRANSITION_IMPLICIT_GUIDE_STRENGTH` | ✓ |  |
| `transition_early_tail_strength` | `FLOAT` | `DEFAULT_TRANSITION_EARLY_TAIL_STRENGTH` | ✓ |  |
| `transition_final_guide_strength` | `FLOAT` | `DEFAULT_TRANSITION_FINAL_GUIDE_STRENGTH` | ✓ |  |
| `segmented_execution` | `BOOLEAN` | `False` | ✓ |  |
| `segment_save_preset` | `SEGMENT_SAVE_PRESETS` | `SEGMENT_SAVE_PRESETS[0]` | ✓ |  |
| `segment_video_format` | `()` | `DEFAULT_SEGMENT_VIDEO_FORMAT` | ✓ |  |
| `*动态输入*` | `Dynamic` | `-` |  | 支持动态数量输入插槽 |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 视频生成结果 | `VIDEO` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.LTX23ImageToVideoMultiRef` |
| **目标节点** | `GJJ_LTX23ImageToVideoMultiRef, GJJ_LTX23WorkflowMultiImageReference, GJJ_LTX23WorkflowDigitalHumanMultiRef, GJJ_LTX23WorkflowFourPanel, GJJ_LTX23WorkflowAllReference` |
| **实现钩子** | `beforeRegisterNodeDef, setup, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```