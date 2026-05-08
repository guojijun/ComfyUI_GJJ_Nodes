# GJJ_MultifunctionCalculator

## 📋 概述

**功能**: 动态扩展数值输入，通过计算器按钮编辑公式，支持加减乘除、取余、整除、幂、括号和常用数学函数。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_multifunction_calculator.js` |  |
| 🔧 后端 | `nodes/gjj_multifunction_calculator.py` | `GJJ_MultifunctionCalculator` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_MultifunctionCalculator` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `calculate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `formula` | `STRING` | `x1 + x2` | ✓ |  |
| `*动态输入*` | `Dynamic` | `-` |  | 支持动态数量输入插槽 |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 浮点结果 | `FLOAT` | |
| 整数结果 | `INT` | |
| 公式文本 | `STRING` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.MultifunctionCalculator` |
| **目标节点** | `GJJ_MultifunctionCalculator` |
| **实现钩子** | `nodeCreated, beforeRegisterNodeDef, setup` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```