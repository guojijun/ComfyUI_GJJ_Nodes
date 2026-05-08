# GJJ_TextFileReader

## 📋 概述

**功能**: 从 input/output/temp 或自定义路径读取文本，支持整文件、按行和按逗号输出。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_text_file_io.py` | `GJJ_TextFileReader` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_TextFileReader` |
| **CATEGORY** | `GJJ/Text` |
| **FUNCTION** | `read` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `directory` | `["输入目录` | `输入目录` | ✓ |  |
| `relative_path` | `STRING` | `prompts.txt` | ✓ |  |
| `custom_path` | `STRING` | `` | ✓ |  |
| `encoding` | `STRING` | `utf-8` | ✓ |  |
| `split_mode` | `["整文件` | `按行` | ✓ |  |
| `index` | `INT` | `0` | ✓ |  |
| `wrap` | `BOOLEAN` | `True` | ✓ |  |
| `skip_empty` | `BOOLEAN` | `True` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 文本输出 | `STRING` | |
| 文件路径 | `STRING` | |
| 条目数量 | `INT` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```