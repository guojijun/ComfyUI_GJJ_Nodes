# GJJ_LoraChainConfig

## 📋 概述

**功能**: 只输出多组 LoRA 的串联配置，可直接连到懒人图文集成一键生图等支持 LoRA 串联配置输入的节点。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_multi_lora_chain.js` |  |
| 🔧 后端 | `nodes/gjj_multi_lora_chain.py` | `GJJ_LoraChainConfig` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_LoraChainConfig` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `build_config` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `lora_data` | `STRING` | `[]` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| LoRA串联配置 | `LORA_CHAIN_CONFIG` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `Comfy.GJJ.MultiLoraChain` |
| **目标节点** | `GJJ_MultiLoraChainLoader, GJJ_LoraChainConfig` |
| **实现钩子** | `beforeRegisterNodeDef, setup` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```