# 批量去水印节点修复经验总结

## 问题背景

`GJJ · 🧼 批量去水印` 节点在文件结构调整后出现多个错误：
1. **初始报错**：`RuntimeError: 未找到VAE模型：flux2-vae.safetensors`（模型实际存在）
2. **第一次修复后**：节点显示为"缺失"状态
3. **第二次修复后**：运行时错误 `name '_append_reference_latent' is not defined`

## 根本原因分析

### 1. 违反编码规范 - 使用内部函数

**错误做法**：
```python
from .gjj_lazy_image_studio import (
    _safe_filename_list,      # ❌ 内部函数（下划线前缀）
    _pick_available_name,     # ❌ 内部函数
)
```

**问题**：
- 以下划线开头的函数是模块内部实现，不应被外部直接导入
- 这些函数可能依赖特定的上下文或状态，跨模块使用会导致不可预测的行为

### 2. 遗漏的函数引用

在修复过程中只更新了部分代码，遗漏了：
- `INPUT_TYPES` 方法中的 `_pick_available_name` 调用
- 执行逻辑中的 `_encode_text`、`_zero_out`、`_append_reference_latent` 调用

### 3. 未遵循公共工具规范

项目规范要求所有通用逻辑必须放在 `nodes/common_utils/` 目录中，但最初直接在节点文件中实现了这些函数。

## 正确的修复方案

### 步骤 1：使用专用的公共列表函数

**修改前**：
```python
from .gjj_lazy_image_studio import _safe_filename_list

def _resolve_from_category(category: str, requested: str, label: str) -> str:
    available = _safe_filename_list(category) or [DEFAULT_VAE]
```

**修改后**：
```python
from .gjj_model_bundle_loader import (
    list_vae_models,
    list_unet_models,
    list_clip_models,
)

def _resolve_from_category(category: str, requested: str, label: str) -> str:
    if category == "vae":
        available = list_vae_models() or [DEFAULT_VAE]
    elif category == "diffusion_models":
        available = list_unet_models() or [DEFAULT_UNET]
    elif category == "text_encoders":
        available = list_clip_models() or [DEFAULT_CLIP]
```

### 步骤 2：创建 Flux2 专用公共工具模块

**新建文件**：`nodes/common_utils/flux2_tools.py`

```python
"""
Flux2 参考图工作流辅助函数

提供 Flux2 模型特有的条件编码和参考 latent 附加功能。
"""

import torch


def gjjutils_encode_text(clip, text: str):
    """编码文本条件"""
    tokens = clip.tokenize(str(text or ""))
    return clip.encode_from_tokens_scheduled(tokens)


def gjjutils_zero_out_conditioning(conditioning):
    """将条件归零（用于反向提示词为空时）"""
    result = []
    for item in conditioning:
        payload = item[1].copy()
        pooled_output = payload.get("pooled_output")
        if pooled_output is not None:
            payload["pooled_output"] = torch.zeros_like(pooled_output)
        result.append([torch.zeros_like(item[0]), payload])
    return result


def gjjutils_append_reference_latent(conditioning, reference_latent):
    """附加参考 latent 到条件（Flux2 参考图工作流的核心功能）"""
    import node_helpers
    return node_helpers.conditioning_set_values(
        conditioning, {"reference_latents": [reference_latent]}, append=True
    )
```

### 步骤 3：统一使用公共工具函数

**修改前**：
```python
from .common_utils.text_tools import gjjutils_pick_available_name

positive = _append_reference_latent(_encode_text(clip, prompt), reference_latent)
negative_base = _encode_text(clip, negative_prompt) if ... else _zero_out(...)
```

**修改后**：
```python
from .common_utils.flux2_tools import (
    gjjutils_append_reference_latent,
    gjjutils_encode_text,
    gjjutils_zero_out_conditioning,
)
from .common_utils.text_tools import gjjutils_pick_available_name

positive = gjjutils_append_reference_latent(gjjutils_encode_text(clip, prompt), reference_latent)
negative_base = gjjutils_encode_text(clip, negative_prompt) if ... else gjjutils_zero_out_conditioning(...)
```

## 关键教训

### 1. 严格遵守编码规范

- ✅ **必须**先阅读 `SKILL/GJJ_CODING_CONVENTIONS.md`
- ✅ **禁止**从其他节点文件导入内部函数（下划线前缀）
- ✅ **优先**使用 `common_utils/` 中的公共函数
- ✅ 所有面向用户的文本必须是中文

### 2. 完整性检查

修复时必须全面搜索所有相关函数调用：
```bash
# 搜索所有可能的内部函数引用
grep_code(regex="_pick_available_name|_safe_filename_list|_encode_text|_zero_out|_append_reference")
```

### 3. 公共工具提取原则

当发现多个节点需要相同逻辑时：
1. 在 `nodes/common_utils/` 创建新模块
2. 函数命名遵循 `gjjutils_<功能描述>` 格式
3. 添加完整的 docstring 说明
4. 在使用处通过 import 引入

### 4. ComfyUI 节点加载机制

- 节点显示"缺失"通常是因为模块导入时抛出异常
- 查看 ComfyUI 控制台日志定位具体错误：`[ERROR] An error occurred while retrieving information for the 'XXX' node`
- 常见错误类型：
  - `NameError`: 函数未定义或未导入
  - `ImportError`: 模块路径错误
  - `AttributeError`: 访问不存在的属性

## 相关文件清单

### 新增文件
- `nodes/common_utils/flux2_tools.py` - Flux2 专用工具函数

### 修改文件
- `nodes/gjj_batch_watermark_remover.py` - 批量去水印节点主文件

### 依赖的公共模块
- `nodes/common_utils/text_tools.py` - 文本处理工具（`gjjutils_pick_available_name`）
- `nodes/gjj_model_bundle_loader.py` - 模型列表函数（`list_vae_models` 等）
- `nodes/gjj_lazy_image_studio.py` - 参考源（仅读取，不导入内部函数）

## 验证步骤

1. **重启 ComfyUI**
2. 确认节点不再显示为"缺失"
3. 测试 VAE 模型列表是否正常显示
4. 执行一次完整的去水印流程
5. 检查控制台是否有新的错误日志

## 预防措施

### 开发前的检查清单

- [ ] 已阅读 `GJJ_CODING_CONVENTIONS.md`
- [ ] 确认所需功能是否已在 `common_utils/` 中存在
- [ ] 如需新增公共函数，先在 `common_utils/` 创建模块
- [ ] 避免从其他节点文件导入任何以下划线开头的函数
- [ ] 使用 `grep_code` 全面搜索相关函数名，确保无遗漏

### 代码审查要点

- [ ] 所有 import 语句都来自 `common_utils/` 或 ComfyUI 内置模块
- [ ] 没有直接使用下划线前缀的内部函数
- [ ] 新增的公共函数有完整的 docstring
- [ ] 函数命名符合 `gjjutils_<功能>` 规范
