# GJJ_CharacterMultiViewStudio

## 📋 概述

**功能**: 节点 `GJJ_CharacterMultiViewStudio`

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_character_multiview_studio.js` |  |
| 🔧 后端 | `nodes/gjj_character_multiview_studio.py` | `GJJ_CharacterMultiViewStudio` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_CharacterMultiViewStudio` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `generate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `main_image` | `IMAGE` | `-` | ✓ |  |
| `base_prompt` | `STRING` | `DEFAULT_EXTRA_PROMPT` | ✓ |  |
| `negative_prompt` | `STRING` | `DEFAULT_NEGATIVE_PROMPT` | ✓ |  |
| `action_prompts` | `STRING` | `\n".join(DEFAULT_ACTION_LINES)` | ✓ |  |
| `unet_name` | `unet_models` | `DEFAULT_UNET_NAME if DEFAULT_UNET_NAME in unet_models else unet_models[0]` | ✓ |  |
| `lora_1_name` | `lora_models` | `_pick_available_name(default_preset.get("lora_1_name` | ✓ |  |
| `lora_1_strength` | `FLOAT` | `float(default_preset.get("lora_1_strength` | ✓ |  |
| `lora_2_name` | `lora_models` | `_pick_available_lora_name(
							lora_models` | ✓ |  |
| `lora_2_strength` | `FLOAT` | `1.0` | ✓ |  |
| `seed` | `INT` | `DEFAULT_SEED` | ✓ |  |
| `save_each_image` | `BOOLEAN` | `True` | ✓ |  |
| `*动态输入*` | `Dynamic` | `-` |  | 支持动态数量输入插槽 |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 多视图拼接图 | `IMAGE` | |
| 单图批量图片 | `GJJ_BATCH_IMAGE_TYPE` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `多视图拼接图` |
| **目标节点** | `GJJ_CharacterMultiViewStudio` |
| **实现钩子** | `nodeCreated, setup` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```