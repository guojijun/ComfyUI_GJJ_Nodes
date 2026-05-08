# GJJ_ComprehensiveMatting

## 📋 概述

**功能**: 综合抠图节点：RMBG2、BiRefNet 通用/精细、BEN2、Inspyrenet。模型会在 models 下相关目录模糊搜索。

## 📁 文件映射

| 层级 | 文件 | 说明 |
|------|------|------|
| 🎨 前端 | `js/gjj_comprehensive_matting.js` |  |
| 🔧 后端 | `nodes/gjj_comprehensive_matting.py` | `GJJ_ComprehensiveMatting` 后端执行逻辑 |

## 🔧 后端节点

### 基础信息

| 属性 | 值 |
|------|-----|
| **类名** | `GJJ_ComprehensiveMatting` |
| **CATEGORY** | `GJJ` |
| **FUNCTION** | `remove_background` |

### 输入参数

| 参数名 | 类型 | 默认值 | 必填 | 说明 |
|--------|------|--------|------|------|
| `matting_method` | `METHODS` | `METHOD_RMBG2` | ✓ |  |
| `model_status_json` | `STRING` | `json.dumps(method_status` | ✓ |  |
| `selected_methods_json` | `STRING` | `` | ✓ |  |
| `background` | `["透明` | `透明` | ✓ |  |
| `device` | `["自动` | `自动` | ✓ |  |
| `process_res` | `INT` | `MODEL_INPUT_SIZE` | ✓ |  |
| `threshold` | `FLOAT` | `0.0` | ✓ |  |
| `mask_blur` | `FLOAT` | `0.0` | ✓ |  |
| `invert_output` | `BOOLEAN` | `False` | ✓ |  |
| `inspyrenet_jit` | `BOOLEAN` | `False` | ✓ |  |
| `batch_image` | `GJJ_BATCH_IMAGE_TYPE` | `-` |  |  |
| `image` | `IMAGE` | `-` |  |  |

### 输出

| 输出名 | 类型 | 说明 |
|--------|------|------|
| 综合批量图 | `GJJ_BATCH_IMAGE` | |
| - | `IMAGE` | |

## 🎨 前端扩展

### 注册信息

| 属性 | 值 |
|------|-----|
| **扩展名** | `GJJ.ComprehensiveMatting.Buttons` |
| **目标节点** | `GJJ_ComprehensiveMatting` |
| **实现钩子** | `beforeRegisterNodeDef, setup` |

## 🏗️ 数据流

```text
用户操作 → [前端扩展 UI] → ComfyUI 图引擎 → [后端节点执行] → 输出
         ↑ 参数设置/预览反馈
```