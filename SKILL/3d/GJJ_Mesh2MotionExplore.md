# GJJ_Mesh2MotionExplore

## 📋 概述

**功能**: 节点 `GJJ_Mesh2MotionExplore`

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_mesh2motion_explore.py` | `GJJ_Mesh2MotionExplore` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_Mesh2MotionExplore` |
| **CATEGORY** | `GJJ/3D` |
| **FUNCTION** | `execute` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `show_skeleton` | `BOOLEAN` | `False` | ✓ |  |
| `mirror_animations` | `BOOLEAN` | `False` | ✓ |  |
| `preview_output` | `BOOLEAN` | `False` | ✓ |  |
| `checker_room` | `BOOLEAN` | `False` | ✓ |  |
| `width` | `INT` | `1024` | ✓ |  |
| `height` | `INT` | `1024` | ✓ |  |
| `fps` | `INT` | `24` | ✓ |  |
| `image` | `STRING` | `` | ✓ |  |
| `video_frames` | `STRING` | `` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 截图图像 | `IMAGE` | |
| 动画视频 | `VIDEO` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```