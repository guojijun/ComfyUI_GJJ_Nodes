# GJJ_GroupBypasser

## 📋 概述

**功能**: 按分组名称关键词筛选当前工作流中的分组，便于前端面板快速定位和旁路操作。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_group_bypasser.js` |  |
| 🔧 后端 | `nodes/gjj_group_bypasser.py` | `GJJ_GroupBypasser` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_GroupBypasser` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `noop` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `过滤关键词` | `STRING` | `` |  |  |
| `选择模式` | `["单选` | `单选` |  |  |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.GroupBypasser` |
| **目标节点** | `GJJ_GroupBypasser` |
| **实现钩子** | `nodeCreated, beforeRegisterNodeDef, setup` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```