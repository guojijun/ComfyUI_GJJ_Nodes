# GJJ_CsvTsvRowIterator

## 📋 概述

读取本地、网络或浏览器选择的 CSV/TSV 文本，按当前行数分列输出，并支持前端自动逐行执行。
**搜索关键词**: csv, tsv, tab, 表格逐行, 分列文本, 逐行递进, CSV分列, TSV分列

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🔧 后端 | `nodes/gjj_csv_tsv_row_iterator.py` | 节点执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_CsvTsvRowIterator` |
| **CATEGORY** | `GJJ/Text` |
| **FUNCTION** | `next_row` |
| **搜索别名** | `csv`, `tsv`, `tab`, `表格逐行`, `分列文本`, `逐行递进`, `CSV分列`, `TSV分列` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `current_row` | `INT` | {
                        "default": 1,
       ... | ✓ | |
| `source_path` | `STRING` | {
                        "default": "",
      ... | ✓ | |
| `timeout_seconds` | `INT` | {"default": 30, "min": 1, "max": 600, "display_... | ✓ | |
| `csv_state` | `STRING` | {
                        "default": json.dumps... | ✓ | |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 当前行数 | `INT` | |
| 总行数 | `INT` | |

## 🏗️ 数据流
```
ComfyUI 图引擎 → [后端节点执行] → 输出
```
