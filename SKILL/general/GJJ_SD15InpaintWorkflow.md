# GJJ_SD15InpaintWorkflow

## 📋 概述

**功能**: 把 sd1.5_inpaint 工作流收口成单节点，内部自动完成 checkpoint 加载、提示词编码、遮罩 VAE 编码、采样和解码。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/-` | 无前端文件 |
| 🔧 后端 | `nodes/gjj_sd15_inpaint_workflow.py` | `GJJ_SD15InpaintWorkflow` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_SD15InpaintWorkflow` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `generate` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `image` | `IMAGE` | `-` | ✓ |  |
| `mask` | `MASK` | `-` | ✓ |  |
| `ckpt_name` | `checkpoints` | `_preferred_default(checkpoints` | ✓ |  |
| `positive` | `STRING` | `DEFAULT_POSITIVE` | ✓ |  |
| `negative` | `STRING` | `DEFAULT_NEGATIVE` | ✓ |  |
| `seed` | `INT` | `DEFAULT_SEED` | ✓ |  |
| `steps` | `INT` | `DEFAULT_STEPS` | ✓ |  |
| `cfg` | `FLOAT` | `DEFAULT_CFG` | ✓ |  |
| `sampler_name` | `samplers` | `_preferred_default(samplers` | ✓ |  |
| `scheduler` | `schedulers` | `_preferred_default(schedulers` | ✓ |  |
| `denoise` | `FLOAT` | `DEFAULT_DENOISE` | ✓ |  |
| `grow_mask_by` | `INT` | `DEFAULT_GROW_MASK_BY` | ✓ |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 重绘结果图像 | `IMAGE` | |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```