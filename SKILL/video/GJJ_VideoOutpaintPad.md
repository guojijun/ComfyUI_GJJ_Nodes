# GJJ_VideoOutpaintPad

## 📋 概述

**功能**: 把输入 VIDEO 拆成帧后做零依赖外扩画布预处理，支持边距扩充和目标比例/尺寸扩充，并自动对齐 LTX 常用倍数。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_video_outpaint_pad.js` |  |
| 🔧 后端 | `nodes/gjj_video_outpaint_pad.py` | `GJJ_VideoOutpaintPad` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_VideoOutpaintPad` |
| **CATEGORY** | `GJJ/视频` |
| **FUNCTION** | `outpaint_video` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `input_video` | `VIDEO` | `-` | ✓ |  |
| `expand_mode` | `EXPAND_MODES` | `MODE_MARGINS` | ✓ |  |
| `fill_mode` | `FILL_MODES` | `FILL_EDGE` | ✓ |  |
| `alignment` | `INT` | `32` | ✓ |  |
| `left` | `INT` | `256` | ✓ |  |
| `right` | `INT` | `256` | ✓ |  |
| `top` | `INT` | `0` | ✓ |  |
| `bottom` | `INT` | `0` | ✓ |  |
| `target_ratio` | `STRING` | `16:9` | ✓ |  |
| `target_width` | `INT` | `1280` | ✓ |  |
| `target_height` | `INT` | `720` | ✓ |  |
| `anchor` | `ANCHORS` | `ANCHOR_CENTER` | ✓ |  |
| `fill_color` | `STRING` | `0` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 外扩视频 | `VIDEO` | |
| 外扩帧序列 | `IMAGE` | |
| 外扩遮罩 | `MASK` | |
| 宽度 | `INT` | |
| 高度 | `INT` | |
| 帧数 | `INT` | |
| 帧率 | `FLOAT` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.VideoOutpaintPad` |
| **目标节点** | `GJJ_VideoOutpaintPad` |
| **实现钩子** | `beforeRegisterNodeDef, setup` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```