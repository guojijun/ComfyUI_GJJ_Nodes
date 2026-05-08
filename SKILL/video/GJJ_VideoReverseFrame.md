# GJJ_VideoReverseFrame

## 📋 概述

**功能**: 从输入视频帧序列中提取倒数第 N 帧，输出同尺寸的单张静态图片。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_video_reverse_frame.py` | `GJJ_VideoReverseFrame` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_VideoReverseFrame` |
| **CATEGORY** | `GJJ/Video` |
| **FUNCTION** | `extract` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `video_frames` | `IMAGE` | `-` | ✓ |  |
| `nth_from_end` | `INT` | `1` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 静态图片 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```