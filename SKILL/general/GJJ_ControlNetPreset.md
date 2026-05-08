# GJJ_ControlNetPreset

## 📋 概述

**功能**: 内部加载 checkpoint、编码正反提示词，并根据图像与遮罩生成可直接连接到 KSampler 的模型、条件和 latent。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_controlnet_preset.js` |  |
| 🔧 后端 | `nodes/gjj_controlnet_preset.py` | `GJJ_ControlNetPreset` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_ControlNetPreset` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `build` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `ckpt_name` | `checkpoints` | `_preferred_default(checkpoints` | ✓ |  |
| `positive` | `STRING` | `` | ✓ |  |
| `negative` | `STRING` | `` | ✓ |  |
| `latent_width` | `INT` | `1024` | ✓ |  |
| `latent_height` | `INT` | `1024` | ✓ |  |
| `grow_mask_by` | `INT` | `6` | ✓ |  |
| `image` | `IMAGE` | `-` |  |  |
| `mask` | `MASK` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 采样模型输出 | `MODEL` | |
| 正向条件输出 | `CONDITIONING` | |
| 反向条件输出 | `CONDITIONING` | |
| 潜空间输出 | `LATENT` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.ControlNetPreset` |
| **目标节点** | `GJJ_ControlNetPreset` |
| **实现钩子** | `nodeCreated` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```