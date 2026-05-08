# GuojijunAnyListRepeat

## 📋 概述

**功能**: 把输入对象或列表重复指定次数并输出为列表。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_any_list_tools.py` | `GuojijunAnyListRepeat` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GuojijunAnyListRepeat` |
| **CATEGORY** | `guojijun/内部引用` |
| **FUNCTION** | `repeat` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `any` | `any_type` | `-` | ✓ |  |
| `repeat` | `INT` | `2` | ✓ |  |
| `flatten` | `BOOLEAN` | `True` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 重复列表 | `any_type` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```