# GJJLoraFaceMaterialGenerator

## 📋 概述

**功能**: 节点 `GJJLoraFaceMaterialGenerator`

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_lora_face_material_generator.py` | `GJJLoraFaceMaterialGenerator` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJLoraFaceMaterialGenerator` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `generate_materials` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `model_preset` | `(MODEL_PRESETS.keys())` | `Qwen` | ✓ |  |
| `material_template` | `MATERIAL_TEMPLATE_OPTIONS` | `训练二十图` | ✓ |  |
| `base_prompt` | `STRING` | `真实摄影，单人，人物一致性训练素材，不同服装，不同背景，不同光线，适合 LoRA 训练。` | ✓ |  |
| `caption_tag` | `STRING` | `` | ✓ |  |
| `negative_prompt` | `STRING` | `` | ✓ |  |
| `custom_action_prompts` | `STRING` | `\n".join(TRAINING_20_LINES)` | ✓ |  |
| `unet_name` | `unet_models` | `_default_unet_name(unet_models)` | ✓ |  |
| `custom_width` | `INT` | `1024` | ✓ |  |
| `custom_height` | `INT` | `1024` | ✓ |  |
| `seed` | `INT` | `DEFAULT_SEED` | ✓ |  |
| `save_directory` | `STRING` | `` | ✓ |  |
| `reference_batch` | `GJJ_BATCH_IMAGE_TYPE` | `-` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 训练素材队列 | `GJJ_BATCH_IMAGE_TYPE` | |
| 素材拼接预览 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```