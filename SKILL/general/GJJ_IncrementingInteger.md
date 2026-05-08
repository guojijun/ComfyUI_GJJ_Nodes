# GJJ_IncrementingInteger

## 📋 概述

**功能**: 输出一个可链接到多个随机种子或序列切片插槽的数值，并默认在每次生成后按“数量”推进到下一段。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_incrementing_integer.js` |  |
| 🔧 后端 | `nodes/gjj_incrementing_integer.py` | `GJJ_IncrementingInteger` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_IncrementingInteger` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `output` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `value` | `INT` | `1` | ✓ |  |
| `count` | `INT` | `2` | ✓ |  |
| `wrap_max` | `INT` | `0` | ✓ |  |
| `range_format` | `RANGE_FORMATS` | `RANGE_FORMATS[0]` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 递增数值 | `INT` | |
| 序列范围 | `STRING` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.IncrementingInteger` |
| **目标节点** | `GJJ_IncrementingInteger` |
| **实现钩子** | `nodeCreated, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```