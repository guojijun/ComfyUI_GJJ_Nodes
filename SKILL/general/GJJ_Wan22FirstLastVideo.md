# GJJ_Wan22FirstLastVideo

## 📋 概述

**功能**: 将 Wan2.2 首尾帧生视频工作流封装成零外部依赖单节点，内部完成双阶段 4 步采样、解码与创建视频。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_wan22_first_last_video.js` |  |
| 🔧 后端 | `nodes/gjj_wan22_first_last_video.py` | `GJJ_Wan22FirstLastVideo` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_Wan22FirstLastVideo` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `generate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `start_image` | `IMAGE` | `-` | ✓ |  |
| `end_image` | `IMAGE` | `-` | ✓ |  |
| `positive_prompt` | `STRING` | `DEFAULT_POSITIVE` | ✓ |  |
| `negative_prompt` | `STRING` | `DEFAULT_NEGATIVE` | ✓ |  |
| `unet_name` | `filtered_unets` | `DEFAULT_UNET if DEFAULT_UNET in filtered_unets else filtered_unets[0]` | ✓ |  |
| `width` | `INT` | `DEFAULT_WIDTH` | ✓ |  |
| `height` | `INT` | `DEFAULT_HEIGHT` | ✓ |  |
| `length` | `INT` | `DEFAULT_LENGTH` | ✓ |  |
| `fps` | `FLOAT` | `DEFAULT_FPS` | ✓ |  |
| `seed` | `INT` | `216136708794704` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 视频生成结果 | `VIDEO` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.Wan22FirstLastVideo` |
| **目标节点** | `GJJ_Wan22FirstLastVideo` |
| **实现钩子** | `beforeRegisterNodeDef` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```