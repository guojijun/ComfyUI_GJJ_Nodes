# GJJ_SEM2PointSegmenter

## 📋 概述

**功能**: 将工作流中的 SEM2 点选分割、遮罩膨胀、块化和预览收成单节点。连接首帧图像后执行一次即可在面板点击人物，输出角色遮罩与预览图。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_sem2_point_segmenter.js` |  |
| 🔧 后端 | `nodes/gjj_sem2_point_segmenter.py` | `GJJ_SEM2PointSegmenter` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_SEM2PointSegmenter` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `segment` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `IMAGE` | `-` | ✓ |  |
| `sam2_model` | `available or ["sam2_hiera_base_plus.safetensors"]` | `default_model or "sam2_hiera_base_plus.safetensors` | ✓ |  |
| `expand` | `INT` | `10` | ✓ |  |
| `block_size` | `INT` | `32` | ✓ |  |
| `positive_points` | `STRING` | `[]` | ✓ |  |
| `negative_points` | `STRING` | `[]` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 角色分割遮罩 | `MASK` | |
| 分割预览图像 | `IMAGE` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.SEM2PointSegmenter` |
| **目标节点** | `GJJ_SEM2PointSegmenter` |
| **实现钩子** | `beforeRegisterNodeDef` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```