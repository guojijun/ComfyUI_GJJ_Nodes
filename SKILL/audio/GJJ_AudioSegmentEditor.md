# GJJ_AudioSegmentEditor

## 📋 概述

**功能**: 节点 `GJJ_AudioSegmentEditor`

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_audio_timestamp_editor.py` | `GJJ_AudioSegmentEditor` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_AudioSegmentEditor` |
| **CATEGORY** | `GJJ/音频` |
| **FUNCTION** | `edit_segments` |
| **OUTPUT_NODE** | ✅ True |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```