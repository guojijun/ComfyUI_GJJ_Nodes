# GJJ_VideoFramesLoader

## 📋 概述

**功能**: 用 FFmpeg 抽取视频帧为 IMAGE 批次。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_ffmpeg_tools.py` | `GJJ_VideoFramesLoader` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_VideoFramesLoader` |
| **CATEGORY** | `GJJ/视频` |
| **FUNCTION** | `load` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `video_path` | `STRING` | `` | ✓ |  |
| `frame_interval` | `INT` | `1` | ✓ |  |
| `max_frames` | `INT` | `0` | ✓ |  |
| `ffmpeg_path` | `STRING` | `ffmpeg` | ✓ |  |
| `ffprobe_path` | `STRING` | `ffprobe` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 视频帧 | `IMAGE` | |
| 原始帧率 | `FLOAT` | |
| 输出帧率 | `FLOAT` | |
| 总帧数 | `INT` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```