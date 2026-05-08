# GJJ_AudioTimestampEditor

## 📋 概述

GJJ GJJ_AudioTimestampEditor 节点

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_audio_timestamp_editor.js` | 提供 DOM Widget 自定义控制面板；加载工作流时初始化节点 UI 状态 |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.AudioSegmentEditor` |
| **目标节点** | `GJJ_AudioTimestampEditor` |
| **实现钩子** | `beforeRegisterNodeDef`, `setup` |

### 前端功能

提供 DOM Widget 自定义控制面板；加载工作流时初始化节点 UI 状态

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```
