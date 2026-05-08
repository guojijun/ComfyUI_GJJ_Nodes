# GJJ_ImageToBatchImage

## 📋 概述

**功能**: 把一张或多张普通 IMAGE 打包成 GJJ 专用批量图片类型，便于连接到批量图片专用接口。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_batch_image_bridge.js` |  |
| 🔧 后端 | `nodes/gjj_batch_image_bridge.py` | `GJJ_ImageToBatchImage` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_ImageToBatchImage` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `wrap` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `*动态输入*` | `Dynamic` | `-` |  | 支持动态数量输入插槽 |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 批量图片 | `GJJ_BATCH_IMAGE` | |
| - | `IMAGE` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `Comfy.GJJ.BatchImageBridge` |
| **目标节点** | `GJJ_ImageToBatchImage` |
| **实现钩子** | `beforeRegisterNodeDef, setup` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```