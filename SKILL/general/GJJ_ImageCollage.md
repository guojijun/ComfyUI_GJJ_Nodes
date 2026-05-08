# GJJ_ImageCollage

## 📋 概述

把多路图片或图片批次拼成横排、竖排或自动网格，适合对比图、参考图和结果展示。
**搜索关键词**: collage, layout, grid, 拼版, 拼图, 对比图, 图片布局

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_image_collage.js` | 加载工作流时自动初始化节点状态；自动管理动态输入/输出插槽 |
| 🔧 后端 | `nodes/gjj_image_collage.py` | 节点执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_ImageCollage` |
| **CATEGORY** | `GJJ/Image` |
| **FUNCTION** | `collage` |
| **搜索别名** | `collage`, `layout`, `grid`, `拼版`, `拼图`, `对比图`, `图片布局` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `layout` | `["自动网格", "横向排列", "纵向排列"]` | {"default": "自动网格", "display_name": "布局方式", "to... | ✓ | |
| `cell_mode` | `["按最长边", "固定宽高"]` | {"default": "按最长边", "display_name": "单格尺寸模式", "... | ✓ | |
| `cell_size` | `INT` | {"default": 512, "min": 16, "max": 4096, "step"... | ✓ | |
| `cell_width` | `INT` | {"default": 512, "min": 16, "max": 4096, "step"... | ✓ | |
| `cell_height` | `INT` | {"default": 512, "min": 16, "max": 4096, "step"... | ✓ | |
| `fit_mode` | `["等比留边", "裁切填满", "拉伸填满"]` | {"default": "等比留边", "display_name": "图片适配", "to... | ✓ | |
| `gap` | `INT` | {"default": 8, "min": 0, "max": 256, "step": 1,... | ✓ | |
| `background` | `STRING` | {"default": "#111820", "display_name": "背景颜色", ... | ✓ | |
| `labels` | `STRING` | {"default": "", "multiline": True, "display_nam... | ✓ | |
| `font_size` | `INT` | {"default": 28, "min": 8, "max": 160, "step": 1... | ✓ | |
| `label_align` | `["左对齐", "居中", "右对齐"]` | {"default": "左对齐", "display_name": "标签对齐", "too... | ✓ | |
| `label_color` | `STRING` | {"default": "#FFFFFF", "display_name": "标签颜色", ... | ✓ | |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 拼版图像 | `IMAGE` | |
|  | `` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `Comfy.GJJ.ImageCollage` |
| **目标节点** | `GJJ_ImageCollage` |
| **实现钩子** | `beforeRegisterNodeDef`, `setup` |

### 前端功能

加载工作流时自动初始化节点状态；自动管理动态输入/输出插槽

## 🏗️ 数据流
```
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```
