# GJJ_LTX23WorkflowFourPanel

## 📋 概述

GJJ GJJ_LTX23WorkflowFourPanel 节点

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_ltx23_multiref_image_to_video.js` | 提供 DOM Widget 自定义控制面板；加载工作流时初始化节点 UI 状态；自动管理动态输入/输出插槽 |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.LTX23ImageToVideoMultiRef` |
| **目标节点** | `GJJ_LTX23ImageToVideoMultiRef`, `GJJ_LTX23WorkflowMultiImageReference`, `GJJ_LTX23WorkflowDigitalHumanMultiRef`, `GJJ_LTX23WorkflowFourPanel`, `GJJ_LTX23WorkflowAllReference` |
| **实现钩子** | `beforeRegisterNodeDef`, `setup` |

### 前端功能

提供 DOM Widget 自定义控制面板；加载工作流时初始化节点 UI 状态；自动管理动态输入/输出插槽

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```
