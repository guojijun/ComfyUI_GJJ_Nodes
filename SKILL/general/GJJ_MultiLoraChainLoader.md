# GJJ_MultiLoraChainLoader

## 📋 概述

GJJ GJJ_MultiLoraChainLoader 节点

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_multi_lora_chain.js` | 提供 DOM Widget 自定义控制面板 |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `Comfy.GJJ.MultiLoraChain` |
| **目标节点** | `GJJ_MultiLoraChainLoader`, `GJJ_LoraChainConfig` |
| **实现钩子** | `beforeRegisterNodeDef` |

### 前端功能

提供 DOM Widget 自定义控制面板

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```
