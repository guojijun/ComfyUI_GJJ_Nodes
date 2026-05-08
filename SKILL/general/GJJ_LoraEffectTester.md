# GJJ_LoraEffectTester

## 📋 概述

**功能**: 按过滤后的 LoRA 列表和多选强度逐项输出 LoRA 串联配置、当前名称、列表状态和名称注解图。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_lora_effect_tester.js` |  |
| 🔧 后端 | `nodes/gjj_lora_effect_tester.py` | `GJJ_LoraEffectTester` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_LoraEffectTester` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `build` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `current_index` | `INT` | `1` | ✓ |  |
| `label_width` | `INT` | `1024` | ✓ |  |
| `label_height` | `INT` | `96` | ✓ |  |
| `font_size` | `INT` | `28` | ✓ |  |
| `STRING` | `` | `-` | ✓ |  |
| `default` | `json.dumps(DEFAULT_STATE` | `-` | ✓ |  |
| `display_name` | `测试状态` | `-` | ✓ |  |
| `tooltip` | `前端面板维护的 JSON 状态；包含过滤词、强度、通过/失败记录和自动执行开关。` | `-` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 当前LoRA串联配置 | `LORA_CHAIN_CONFIG` | |
| 当前LoRA名称 | `STRING` | |
| 过滤LoRA列表 | `STRING` | |
| LoRA名称注解图 | `IMAGE` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.LoraEffectTester.CleanRewrite` |
| **目标节点** | `GJJ_LoraEffectTester` |
| **实现钩子** | `nodeCreated, beforeRegisterNodeDef, setup, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```