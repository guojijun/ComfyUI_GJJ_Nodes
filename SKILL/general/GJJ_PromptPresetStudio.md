# GJJ_PromptPresetStudio

## 📋 概述

**功能**: 把风格、证件照、主体、环境、随机灵感与多角度提示词整合到一个 GJJ 零依赖节点中，直接输出混合正负提示词。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_prompt_preset_studio.js` |  |
| 🔧 后端 | `nodes/gjj_prompt_preset_studio.py` | `GJJ_PromptPresetStudio` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_PromptPresetStudio` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `build` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `正向基础词` | `STRING` | `` | ✓ |  |
| `反向基础词` | `STRING` | `` | ✓ |  |
| `通用反向预设` | `NEGATIVE_PRESET_OPTIONS` | `通用写实` | ✓ |  |
| `随机种子` | `INT` | `0` | ✓ |  |
| `default` | `{` | `-` | ✓ |  |
| `multiline` | `False` | `-` | ✓ |  |
| `display_name` | `配置存储` | `-` | ✓ |  |
| `tooltip` | `内部使用的动态面板配置 JSON。` | `-` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 混合正向提示词 | `STRING` | |
| 混合反向提示词 | `STRING` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `Comfy.GJJ.PromptPresetStudio` |
| **目标节点** | `GJJ_PromptPresetStudio` |
| **实现钩子** | `nodeCreated, beforeRegisterNodeDef, setup, init` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```