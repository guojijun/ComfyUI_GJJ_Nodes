# GJJ_MultiVideoLoader

## 📋 概述

**功能**: 一次选择多个 input 目录视频，按帧范围和抽帧间隔解码为 GJJ 批量图片帧队列，可直接连接 GJJ 视频合成器、插帧器或放大器。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_multi_video_loader.js` |  |
| 🔧 后端 | `nodes/gjj_multi_video_loader.py` | `GJJ_MultiVideoLoader` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_MultiVideoLoader` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `load_videos` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `start_frame` | `INT` | `0` | ✓ |  |
| `end_frame` | `INT` | `0` | ✓ |  |
| `frame_stride` | `INT` | `1` | ✓ |  |
| `max_frames` | `INT` | `240` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 视频帧队列 | `GJJ_BATCH_IMAGE_TYPE` | |
| 首帧预览 | `IMAGE` | |
| 尾帧预览 | `IMAGE` | |
| 视频信息JSON | `STRING` | |
| 源帧率 | `FLOAT` | |
| 输出帧数 | `INT` | |
| 源时长 | `FLOAT` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `Comfy.GJJ.MultiVideoLoader` |
| **目标节点** | `GJJ_MultiVideoLoader` |
| **实现钩子** | `beforeRegisterNodeDef, setup` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```