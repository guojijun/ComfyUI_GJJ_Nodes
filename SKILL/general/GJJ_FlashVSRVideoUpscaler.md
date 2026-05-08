# GJJ_FlashVSRVideoUpscaler

## 📋 概述

**功能**: 综合 FlashVSR 与 FlashVSR Ultra-Fast 的 GJJ 零依赖单节点；支持视频直连保留音频，或帧序列超分输出。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_flashvsr_video_upscaler.js` |  |
| 🔧 后端 | `nodes/gjj_flashvsr_video_upscaler.py` | `GJJ_FlashVSRVideoUpscaler` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_FlashVSRVideoUpscaler` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `upscale` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `preset` | `PRESETS` | `PRESET_BALANCED` | ✓ |  |
| `model_layout` | `MODEL_LAYOUTS` | `DEFAULT_MODEL_LAYOUT` | ✓ |  |
| `scale` | `INT` | `2` | ✓ |  |
| `mode` | `MODE_CHOICES` | `tiny` | ✓ |  |
| `enable_tiling` | `BOOLEAN` | `True` | ✓ |  |
| `tile_size` | `INT` | `256` | ✓ |  |
| `tile_overlap` | `INT` | `32` | ✓ |  |
| `color_fix` | `BOOLEAN` | `True` | ✓ |  |
| `tiled_vae` | `BOOLEAN` | `True` | ✓ |  |
| `unload_dit` | `BOOLEAN` | `False` | ✓ |  |
| `force_offload` | `BOOLEAN` | `True` | ✓ |  |
| `sparse_ratio` | `FLOAT` | `2.0` | ✓ |  |
| `kv_ratio` | `FLOAT` | `2.0` | ✓ |  |
| `local_range` | `[9` | `11` | ✓ |  |
| `attention_mode` | `ATTENTION_CHOICES` | `ATTENTION_COMPAT` | ✓ |  |
| `precision` | `["bf16` | `bf16` | ✓ |  |
| `device` | `devices` | `default_device` | ✓ |  |
| `seed` | `INT` | `1` | ✓ |  |
| `auto_download` | `BOOLEAN` | `False` | ✓ |  |
| `*动态输入*` | `Dynamic` | `-` |  | 支持动态数量输入插槽 |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 超分结果 | `any_type` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.FlashVSRVideoUpscaler` |
| **目标节点** | `GJJ_FlashVSRVideoUpscaler` |
| **实现钩子** | `beforeRegisterNodeDef, setup, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```