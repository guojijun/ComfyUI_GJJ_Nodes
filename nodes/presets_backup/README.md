# GJJ 模型管理系统使用指南

## 📋 概述

GJJ 项目现在采用 **TSV 文件 + 公共函数** 的方式统一管理所有模型，实现：
- ✅ 去扩展名、去量化参数的关键词存储
- ✅ 模糊搜索（支持子目录）
- ✅ 统一维护，方便扩展
- ✅ 零硬编码，易于复用

---

## 📁 文件结构

```
nodes/
├── presets/
│   └── model_keywords.tsv          # 模型关键词索引表
└── common_utils/
    ├── model_manager.py             # 模型管理工具模块
    ├── text_tools.py                # 文本处理工具
    └── __init__.py                  # 导出所有公共函数
```

---

## 📊 TSV 文件格式

### 字段说明

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `id` | string | 唯一标识符（小写，连字符分隔） | `flux-dev` |
| `category` | string | 模型类别 | `unet/clip/vae/lora/controlnet/upscaler` |
| `keywords` | string | 搜索关键词（`\|` 分隔） | `flux1\|flux-dev\|flux dev` |
| `display_name` | string | 显示名称 | `Flux Dev` |
| `description` | string | 描述信息 | `Flux 开发版主扩散模型` |
| `tags` | string | 标签（`\|` 分隔） | `flux\|text-to-image` |
| `priority` | int | 优先级（0-100） | `100` |

### 规范化规则

1. **去除扩展名**：`.safetensors`, `.ckpt`, `.pth`, `.pt`, `.bin`, `.gguf`, `.onnx`
2. **去除量化参数**：`_fp8`, `_fp16`, `_bf16`, `_fp4`, `_nvfp4`, `_e4m3fn`, `_scaled`, `_turbo` 等
3. **统一格式**：小写字母 + 连字符

### 示例

```tsv
# 原始文件名
ltx-2.3-22b-distilled_transformer_only_fp8_input_scaled_v3.safetensors

# 规范化后 ID
ltx-2.3-22b-distilled-transformer-only

# 关键词
ltx|2.3|22b|distilled|transformer|only
```

---

## 🔧 公共函数 API

### 1. 加载模型关键词索引

```python
from .common_utils import gjjutils_load_model_keywords

# 加载所有模型信息（带缓存）
models = gjjutils_load_model_keywords()

# 返回示例
[
    {
        "id": "flux-dev",
        "category": "unet",
        "keywords": ["flux1", "flux-dev", "flux dev"],
        "display_name": "Flux Dev",
        "description": "Flux 开发版主扩散模型",
        "tags": ["flux", "text-to-image"],
        "priority": 100
    },
    ...
]
```

### 2. 模糊搜索模型

```python
from .common_utils import gjjutils_search_models

# 搜索 flux 相关模型
results = gjjutils_search_models("flux")
# 返回: [Flux Dev, Flux Schnell, Flux Fill, ...]

# 按类别过滤
clips = gjjutils_search_models("clip", category="clip")

# 限制结果数量并设置最小优先级
top_wan = gjjutils_search_models("wan", min_priority=90, limit=5)
```

### 3. 在 ComfyUI 文件夹中查找模型

```python
from .common_utils import gjjutils_find_model_in_folders

# 在 checkpoints 中查找 flux 模型（支持子目录）
model_path = gjjutils_find_model_in_folders("flux", "checkpoints")
# 返回: "flux-dev.safetensors" 或 "subdir/flux-model.ckpt"

# 在 loras 中查找 LTX LoRA
lora_path = gjjutils_find_model_in_folders("ltx", "loras")
```

### 4. 获取指定类别的可用模型

```python
from .common_utils import gjjutils_get_available_models_by_category

# 获取所有 CLIP 模型
clips = gjjutils_get_available_models_by_category("clip", "clip")
# 返回: ["clip_l.safetensors", "t5xxl_fp16.safetensors", ...]

# 自动推断文件夹类型
vaes = gjjutils_get_available_models_by_category("vae")
```

### 5. 构建 UI 选择列表

```python
from .common_utils import gjjutils_build_model_choices

# 构建下拉菜单选项
choices = gjjutils_build_model_choices("flux", "unet")
# 返回: ["Auto", "Disable", "flux-dev.safetensors", ...]
```

---

## 💡 使用场景示例

### 场景 1：替换硬编码的模型名称

**修改前：**
```python
DEFAULT_CKPT = "ltx-2.3-22b-distilled_transformer_only_fp8_input_scaled_v3.safetensors"
```

**修改后：**
```python
from .common_utils import gjjutils_find_model_in_folders

# 自动查找匹配的模型（支持子目录）
DEFAULT_CKPT = gjjutils_find_model_in_folders("ltx-2.3-22b-distilled", "checkpoints")
```

### 场景 2：动态生成模型选择列表

```python
from .common_utils import gjjutils_build_model_choices

class GJJModelSelector:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_name": (gjjutils_build_model_choices("ltx", "unet"),),
            }
        }
```

### 场景 3：模糊匹配用户输入

```python
from .common_utils import gjjutils_search_models

def resolve_model(user_input: str) -> str:
    """根据用户输入解析模型名称。"""
    results = gjjutils_search_models(user_input, limit=1)
    if results:
        return results[0]["id"]
    return user_input  #  fallback
```

---

## 🎯 最佳实践

### 1. 添加新模型

在 `presets/model_keywords.tsv` 末尾添加一行：

```tsv
my-new-model	unet	my|new|model	My New Model	我的新模型	unet|custom	80
```

### 2. 更新现有模型

直接编辑 TSV 文件，修改对应字段即可。

### 3. 删除模型

从 TSV 文件中删除对应行。

### 4. 分类建议

- **unet**: 主扩散模型、Transformer 模型
- **clip**: 文本编码器、视觉编码器、语言模型
- **vae**: VAE 编解码器、自动编码器
- **lora**: LoRA 适配器
- **controlnet**: ControlNet 控制网
- **upscaler**: 超分模型
- **audio**: 音频处理模型
- **embedding**: 嵌入向量

---

## 🚀 优势总结

| 特性 | 传统方式 | TSV 管理方式 |
|------|---------|-------------|
| **维护性** | 分散在各节点文件中 | 集中在一个 TSV 文件 |
| **扩展性** | 需修改多个文件 | 只需添加一行 TSV |
| **搜索能力** | 精确匹配 | 模糊搜索 + 关键词匹配 |
| **子目录支持** | 需手动遍历 | 自动支持 |
| **去量化参数** | 硬编码多个变体 | 自动规范化 |
| **优先级控制** | 无 | 支持优先级排序 |
| **类别过滤** | 需手动实现 | 内置支持 |

---

## 📝 注意事项

1. **TSV 文件编码**：必须使用 `UTF-8` 编码
2. **分隔符**：使用 Tab (`\t`) 分隔字段
3. **关键词分隔**：使用竖线 (`|`) 分隔多个关键词
4. **注释行**：以 `#` 开头的行会被忽略
5. **缓存机制**：`gjjutils_load_model_keywords()` 使用 `@lru_cache`，修改 TSV 后需重启 ComfyUI

---

## 🔗 相关文件

- [model_keywords.tsv](file://d:\AI\MOD\custom_nodes\GJJ\nodes\presets\model_keywords.tsv) - 模型关键词索引表
- [model_manager.py](file://d:\AI\MOD\custom_nodes\GJJ\nodes\common_utils\model_manager.py) - 模型管理工具模块
- [text_tools.py](file://d:\AI\MOD\custom_nodes\GJJ\nodes\common_utils\text_tools.py) - 文本处理工具
- [__init__.py](file://d:\AI\MOD\custom_nodes\GJJ\nodes\common_utils\__init__.py) - 公共函数导出
