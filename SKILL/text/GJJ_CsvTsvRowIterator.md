# GJJ_CsvTsvRowIterator

## 📋 概述

**功能**: 读取本地、网络或浏览器选择的 CSV/TSV 文本，按当前行数分列输出，并支持前端自动逐行执行。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_csv_tsv_row_iterator.js` |  |
| 🔧 后端 | `nodes/gjj_csv_tsv_row_iterator.py` | `GJJ_CsvTsvRowIterator` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_CsvTsvRowIterator` |
| **CATEGORY** | `GJJ/Text` |
| **FUNCTION** | `next_row` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `current_row` | `INT` | `1` | ✓ |  |
| `source_path` | `STRING` | `` | ✓ |  |
| `timeout_seconds` | `INT` | `30` | ✓ |  |
| `csv_state` | `STRING` | `json.dumps(DEFAULT_STATE` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 当前行数 | `INT` | |
| 总行数 | `INT` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `Comfy.GJJ.CsvTsvRowIterator` |
| **目标节点** | `GJJ_CsvTsvRowIterator` |
| **实现钩子** | `nodeCreated, beforeRegisterNodeDef, setup, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```