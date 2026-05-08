# GJJ_InpaintStitch

## 📋 概述

把 GJJ 局部重绘裁切输出的重绘图拼回原图。
**搜索关键词**: Inpaint Stitch, inpaint stitch, 局部重绘拼回, 拼回原图

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🔧 后端 | `nodes/gjj_inpaint_crop.py` | 节点执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_InpaintStitch` |
| **CATEGORY** | `GJJ/Image` |
| **FUNCTION** | `inpaint_stitch` |
| **搜索别名** | `Inpaint Stitch`, `inpaint stitch`, `局部重绘拼回`, `拼回原图` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `stitcher` | `STITCHER` | {"display_name": "拼回信息", "tooltip": "连接 GJJ 局部重... | ✓ | |
| `inpainted_image` | `IMAGE` | {"display_name": "重绘图片", "tooltip": "已经完成重绘的裁切图... | ✓ | |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 拼回图片 | `IMAGE` | |
|  | `` | |

## 🏗️ 数据流
```
ComfyUI 图引擎 → [后端节点执行] → 输出
```
