# GJJ_OpusMTZhEnTranslation

## 📋 概述

**功能**: 使用 Helsinki-NLP/opus-mt-zh-en 模型将中文翻译为英文。支持自动下载模型到 models/translation 目录。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_opus_mt_zh_en_translation.py` | `GJJ_OpusMTZhEnTranslation` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_OpusMTZhEnTranslation` |
| **CATEGORY** | `GJJ/翻译` |
| **FUNCTION** | `translate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `chinese_text` | `STRING` | `` | ✓ |  |
| `device` | `["auto` | `auto` | ✓ |  |
| `max_length` | `INT` | `512` | ✓ |  |
| `batch_size` | `INT` | `8` | ✓ |  |
| `unload_after_use` | `BOOLEAN` | `False` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 英文翻译结果 | `STRING` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```