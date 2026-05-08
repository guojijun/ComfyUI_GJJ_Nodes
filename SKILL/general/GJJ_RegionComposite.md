# GJJ_RegionComposite

## 📋 概述

**功能**: 把前景图片按指定区域合成到底图上，支持适配方式、透明度和可选遮罩。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_region_layer_tools.py` | `GJJ_RegionComposite` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_RegionComposite` |
| **CATEGORY** | `GJJ/Layer` |
| **FUNCTION** | `composite` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `base_image` | `IMAGE` | `-` | ✓ |  |
| `overlay_image` | `IMAGE` | `-` | ✓ |  |
| `region` | `REGION_TYPE` | `-` | ✓ |  |
| `fit_mode` | `["等比留边` | `等比留边` | ✓ |  |
| `opacity` | `FLOAT` | `1.0` | ✓ |  |
| `canvas_width` | `INT` | `0` | ✓ |  |
| `canvas_height` | `INT` | `0` | ✓ |  |
| `overlay_mask` | `MASK` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 合成图像 | `IMAGE` | |
| 合成区域遮罩 | `MASK` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```