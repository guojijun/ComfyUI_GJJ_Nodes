# GJJ_GridRegionSelector

## 📋 概述

**功能**: 把画布切成行列网格，按序号输出其中一个区域和完整区域列表 JSON。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_region_layer_tools.py` | `GJJ_GridRegionSelector` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_GridRegionSelector` |
| **CATEGORY** | `GJJ/Layer` |
| **FUNCTION** | `select` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `canvas_width` | `INT` | `1024` | ✓ |  |
| `canvas_height` | `INT` | `1024` | ✓ |  |
| `rows` | `INT` | `2` | ✓ |  |
| `cols` | `INT` | `2` | ✓ |  |
| `index` | `INT` | `1` | ✓ |  |
| `gap` | `INT` | `0` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 选中区域 | `REGION_TYPE` | |
| 选中遮罩 | `MASK` | |
| 区域列表JSON | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```