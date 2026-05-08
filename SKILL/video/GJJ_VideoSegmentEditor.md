# GJJ_VideoSegmentEditor

## 📋 概述

**功能**: 节点 `GJJ_VideoSegmentEditor`

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_video_segment_editor.js` |  |
| 🔧 后端 | `nodes/gjj_video_segment_editor.py` | `GJJ_VideoSegmentEditor` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_VideoSegmentEditor` |
| **CATEGORY** | `GJJ/视频` |
| **FUNCTION** | `edit_segments` |
| **OUTPUT_NODE** | ✅ True |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `` |
| **目标节点** | `GJJ_VideoSegmentEditor` |
| **实现钩子** | `beforeRegisterNodeDef` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```