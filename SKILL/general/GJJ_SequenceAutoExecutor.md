# GJJ_SequenceAutoExecutor

## 📋 概述

**功能**: 根据当前数值和总数量，在前端执行完成后自动继续排队，直到序列结束。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_sequence_auto_executor.js` |  |
| 🔧 后端 | `nodes/gjj_sequence_auto_executor.py` | `GJJ_SequenceAutoExecutor` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_SequenceAutoExecutor` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `check` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `enabled` | `BOOLEAN` | `False` | ✓ |  |
| `current_value` | `INT` | `1` | ✓ |  |
| `total_count` | `INT` | `1` | ✓ |  |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.SequenceAutoExecutor` |
| **目标节点** | `GJJ_SequenceAutoExecutor` |
| **实现钩子** | `nodeCreated, beforeRegisterNodeDef, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```