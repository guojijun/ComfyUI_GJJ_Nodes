# GJJ_ScribbleControlNetGenerator

## 📋 概述

**功能**: 节点 `GJJ_ScribbleControlNetGenerator`

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_scribble_controlnet_generator.py` | `GJJ_ScribbleControlNetGenerator` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_ScribbleControlNetGenerator` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `generate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `IMAGE` | `-` | ✓ |  |
| `positive_prompt` | `STRING` | `DEFAULT_POSITIVE` | ✓ |  |
| `ckpt_name` | `checkpoints` | `DEFAULT_CHECKPOINT if DEFAULT_CHECKPOINT in checkpoints else checkpoints[0]` | ✓ |  |
| `controlnet_name` | `controlnets` | `_resolve_default_name(controlnets` | ✓ |  |
| `seed` | `INT` | `240272355371031` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 涂鸦生图结果 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```