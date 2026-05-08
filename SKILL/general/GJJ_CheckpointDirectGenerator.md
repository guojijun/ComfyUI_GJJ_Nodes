# GJJ_CheckpointDirectGenerator

## 📋 概述

**功能**: 单节点加载底模 checkpoint 直接出图，内部自动完成提示词编码、latent 创建、采样和 VAE 解码。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_checkpoint_direct_generator.py` | `GJJ_CheckpointDirectGenerator` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_CheckpointDirectGenerator` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `generate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `ckpt_name` | `checkpoints` | `_preferred_default(checkpoints` | ✓ |  |
| `positive` | `STRING` | `DEFAULT_POSITIVE` | ✓ |  |
| `negative` | `STRING` | `DEFAULT_NEGATIVE` | ✓ |  |
| `width` | `INT` | `DEFAULT_WIDTH` | ✓ |  |
| `height` | `INT` | `DEFAULT_HEIGHT` | ✓ |  |
| `batch_size` | `INT` | `DEFAULT_BATCH_SIZE` | ✓ |  |
| `seed` | `INT` | `DEFAULT_SEED` | ✓ |  |
| `steps` | `INT` | `DEFAULT_STEPS` | ✓ |  |
| `cfg` | `FLOAT` | `DEFAULT_CFG` | ✓ |  |
| `sampler_name` | `samplers` | `_preferred_default(samplers` | ✓ |  |
| `scheduler` | `schedulers` | `_preferred_default(schedulers` | ✓ |  |
| `lora_chain_config` | `LORA_CHAIN_CONFIG` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 生成图像 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```