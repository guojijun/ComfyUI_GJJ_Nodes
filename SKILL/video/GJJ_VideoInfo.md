# GJJ_VideoInfo

## 📋 概述

**功能**: 调用 ffprobe 读取视频基本信息。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_ffmpeg_tools.py` | `GJJ_VideoInfo` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_VideoInfo` |
| **CATEGORY** | `GJJ/视频` |
| **FUNCTION** | `probe` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `video_path` | `STRING` | `` | ✓ |  |
| `ffprobe_path` | `STRING` | `ffprobe` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 文件名 | `STRING` | |
| 宽度 | `INT` | |
| 高度 | `INT` | |
| 帧率 | `FLOAT` | |
| 总帧数 | `INT` | |
| 时长秒 | `FLOAT` | |
| 完整JSON | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```