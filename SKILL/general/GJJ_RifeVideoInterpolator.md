# GJJ_RifeVideoInterpolator

## 📋 概述

**功能**: 将 RIFE VFI 迁移为 GJJ 零依赖单节点：支持图片队列或视频插帧，推荐使用 rife47 与 rife49。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_rife_video_interpolator.js` |  |
| 🔧 后端 | `nodes/gjj_rife_video_interpolator.py` | `GJJ_RifeVideoInterpolator` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_RifeVideoInterpolator` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `interpolate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `model_name` | `model_choices` | `default_model` | ✓ |  |
| `multiplier` | `INT` | `2` | ✓ |  |
| `clear_cache_after_n_frames` | `INT` | `10` | ✓ |  |
| `fast_mode` | `BOOLEAN` | `True` | ✓ |  |
| `ensemble` | `BOOLEAN` | `True` | ✓ |  |
| `scale_factor` | `[0.25` | `1.0` | ✓ |  |
| `input_video` | `VIDEO` | `-` |  |  |
| `input_frames` | `IMAGE` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 插帧完成结果 | `any_type` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.RifeVideoInterpolator` |
| **目标节点** | `GJJ_RifeVideoInterpolator` |
| **实现钩子** | `beforeRegisterNodeDef` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```