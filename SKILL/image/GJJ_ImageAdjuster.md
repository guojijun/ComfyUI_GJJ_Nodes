# GJJ_ImageAdjuster

## 📋 概述

**功能**: 对图片批次执行本地调色：曝光、对比、饱和、鲜艳度、色温、色调、色相、伽马和颗粒。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_image_adjuster.py` | `GJJ_ImageAdjuster` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_ImageAdjuster` |
| **CATEGORY** | `GJJ/Image` |
| **FUNCTION** | `adjust` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `IMAGE` | `-` | ✓ |  |
| `exposure` | `FLOAT` | `0.0` | ✓ |  |
| `contrast` | `FLOAT` | `0.0` | ✓ |  |
| `saturation` | `FLOAT` | `0.0` | ✓ |  |
| `vibrance` | `FLOAT` | `0.0` | ✓ |  |
| `temperature` | `FLOAT` | `0.0` | ✓ |  |
| `tint` | `FLOAT` | `0.0` | ✓ |  |
| `hue_shift` | `FLOAT` | `0.0` | ✓ |  |
| `gamma` | `FLOAT` | `1.0` | ✓ |  |
| `grain` | `FLOAT` | `0.0` | ✓ |  |
| `grain_mode` | `["胶片均匀颗粒` | `胶片均匀颗粒` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 调色图像 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```