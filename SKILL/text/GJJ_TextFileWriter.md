# GJJ_TextFileWriter

## 📋 概述

**功能**: 把文本写入 input/output/temp 或自定义路径，支持覆盖、追加、前插和逗号拼接。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_text_file_io.py` | `GJJ_TextFileWriter` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_TextFileWriter` |
| **CATEGORY** | `GJJ/Text` |
| **FUNCTION** | `write` |
| **OUTPUT_NODE** | ✅ True |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `content` | `STRING` | `` | ✓ |  |
| `directory` | `["输入目录` | `输出目录` | ✓ |  |
| `relative_path` | `STRING` | `GJJ/text_output.txt` | ✓ |  |
| `custom_path` | `STRING` | `` | ✓ |  |
| `encoding` | `STRING` | `utf-8` | ✓ |  |
| `mode` | `["覆盖文件` | `覆盖文件` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 保存路径 | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```