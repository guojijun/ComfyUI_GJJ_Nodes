# GJJ_FFmpegMuxAudioVideo

## 📋 概述

**功能**: 用 FFmpeg 把图片帧或视频路径与音频合并为 MP4。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_ffmpeg_tools.py` | `GJJ_FFmpegMuxAudioVideo` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_FFmpegMuxAudioVideo` |
| **CATEGORY** | `GJJ/视频` |
| **FUNCTION** | `mux` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `fps` | `FLOAT` | `30.0` | ✓ |  |
| `filename_prefix` | `STRING` | `GJJ/ffmpeg/mux` | ✓ |  |
| `ffmpeg_path` | `STRING` | `ffmpeg` | ✓ |  |
| `ffprobe_path` | `STRING` | `ffprobe` | ✓ |  |
| `images` | `IMAGE` | `-` |  |  |
| `audio` | `AUDIO` | `-` |  |  |
| `video_path` | `STRING` | `` |  |  |
| `audio_path` | `STRING` | `` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 输出视频路径 | `STRING` | |
| 视频时长 | `FLOAT` | |
| 总帧数 | `INT` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```