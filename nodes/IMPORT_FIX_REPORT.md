# 导入错误修复报告

## 📅 修复日期
2026-05-06

## 🎯 问题描述

ComfyUI 启动时出现以下导入错误：

### 错误 1: `No module named 'common_utils'`
```python
File "gjj_any_preview.py", line 12, in <module>
    from common_utils.types import GJJ_BATCH_IMAGE_TYPE
ModuleNotFoundError: No module named 'common_utils'
```

**原因**: 使用了绝对导入而非相对导入。在 Python 包中，应该使用相对导入（带前导点号）。

### 错误 2: `cannot import name '_canonical_model_text'`
```python
File "gjj_character_multiview_studio.py", line 19, in <module>
    from .gjj_lazy_image_studio import (
        ...
        _canonical_model_text,
        _normalize_text,
        ...
    )
ImportError: cannot import name '_canonical_model_text' from 'gjj_lazy_image_studio'
```

**原因**: [_canonical_model_text](file://d:\AI\MOD\custom_nodes\GJJ\nodes\common_utils\model_family.py#L769-L771) 和 [_normalize_text](file://d:\AI\MOD\custom_nodes\GJJ\nodes\common_utils\model_family.py#L764-L766) 等文本处理函数已从 [gjj_lazy_image_studio.py](file://d:\AI\MOD\custom_nodes\GJJ\nodes\gjj_lazy_image_studio.py) 迁移到 [common_utils/text_tools.py](file://d:\AI\MOD\custom_nodes\GJJ\nodes\common_utils\text_tools.py)，但多个节点仍在从旧位置导入。

---

## ✅ 修复的文件

### 1. gjj_any_preview.py
**修复内容**: 
```python
# 修复前
from common_utils.types import GJJ_BATCH_IMAGE_TYPE

# 修复后
from .common_utils.types import GJJ_BATCH_IMAGE_TYPE
```

**说明**: 将绝对导入改为相对导入，符合 Python 包规范。

---

### 2. gjj_character_multiview_studio.py
**修复内容**:
```python
# 修复前
from .gjj_lazy_image_studio import (
    ...
    _canonical_model_text,
    _normalize_text,
    _pick_available_name,
    ...
)

# 修复后
from .common_utils.text_tools import (
    gjjutils_canonical_model_text as _canonical_model_text,
    gjjutils_normalize_text as _normalize_text,
    gjjutils_pick_available_name as _pick_available_name,
)
from .gjj_lazy_image_studio import (
    ...
    # 移除已迁移的函数
)
```

**说明**: 从 [common_utils/text_tools](file://d:\AI\MOD\custom_nodes\GJJ\nodes\common_utils\text_tools.py) 导入文本处理函数，并使用别名保持代码兼容性。

---

### 3. gjj_old_photo_restorer.py
**修复内容**:
```python
# 修复前
from .gjj_lazy_image_studio import (
    ...
    _normalize_text,
    _pick_available_name,
    ...
)

# 修复后
from .common_utils.text_tools import (
    gjjutils_normalize_text as _normalize_text,
    gjjutils_pick_available_name as _pick_available_name,
)
from .gjj_lazy_image_studio import (
    ...
    # 移除已迁移的函数
)
```

---

### 4. gjj_qwen2511_edit_outpaint.py
**修复内容**:
```python
# 修复前
from .gjj_lazy_image_studio import (
    ...
    _normalize_text,
    _pick_available_name,
    ...
)

# 修复后
from .common_utils.text_tools import (
    gjjutils_normalize_text as _normalize_text,
    gjjutils_pick_available_name as _pick_available_name,
)
from .gjj_lazy_image_studio import (
    ...
    # 移除已迁移的函数
)
```

---

## 📊 修复统计

| 文件 | 修复类型 | 状态 |
|------|---------|------|
| [gjj_any_preview.py](file://d:\AI\MOD\custom_nodes\GJJ\nodes\gjj_any_preview.py) | 相对导入修正 | ✅ 完成 |
| [gjj_character_multiview_studio.py](file://d:\AI\MOD\custom_nodes\GJJ\nodes\gjj_character_multiview_studio.py) | 函数迁移适配 | ✅ 完成 |
| [gjj_old_photo_restorer.py](file://d:\AI\MOD\custom_nodes\GJJ\nodes\gjj_old_photo_restorer.py) | 函数迁移适配 | ✅ 完成 |
| [gjj_qwen2511_edit_outpaint.py](file://d:\AI\MOD\custom_nodes\GJJ\nodes\gjj_qwen2511_edit_outpaint.py) | 函数迁移适配 | ✅ 完成 |

**总计**: 4 个文件修复完成

---

## 🔧 技术细节

### 相对导入规范

在 Python 包结构中，同一包内的模块相互导入应使用**相对导入**：

```python
# ❌ 错误：绝对导入（会导致 ModuleNotFoundError）
from common_utils.types import GJJ_BATCH_IMAGE_TYPE

# ✅ 正确：相对导入
from .common_utils.types import GJJ_BATCH_IMAGE_TYPE
```

**原因**: 
- ComfyUI 通过 `importlib.import_module("." + n, __name__)` 加载节点模块
- 这种加载方式要求包内导入使用相对路径
- 绝对导入会尝试从 Python 全局路径查找，导致找不到模块

### 函数迁移适配模式

当公共函数从节点文件迁移到 `common_utils` 时，采用**别名导入**保持兼容性：

```python
# 从 common_utils 导入并创建别名
from .common_utils.text_tools import (
    gjjutils_canonical_model_text as _canonical_model_text,
    gjjutils_normalize_text as _normalize_text,
)

# 原有代码无需修改，仍可使用 _canonical_model_text()
canonical = _canonical_model_text(unet_name)
```

**优势**:
- ✅ 无需修改大量现有代码
- ✅ 保持函数命名一致性（私有函数以 `_` 开头）
- ✅ 集中管理公共函数，便于维护

---

## 📝 相关文档

- [common_utils/text_tools.py](file://d:\AI\MOD\custom_nodes\GJJ\nodes\common_utils\text_tools.py) - 文本处理工具模块
- [common_utils/README.md](file://d:\AI\MOD\custom_nodes\GJJ\nodes\common_utils\README.md) - 公共工具模块使用指南
- [common_utils/MIGRATION_COMPLETE.md](file://d:\AI\MOD\custom_nodes\GJJ\nodes\common_utils\MIGRATION_COMPLETE.md) - 迁移完成报告

---

## ✨ 总结

✅ **已完成**:
- 修复 4 个节点的导入错误
- 统一使用相对导入规范
- 适配文本处理函数迁移
- 所有文件语法验证通过

✅ **符合规范**:
- 遵循 Python 包导入最佳实践
- 使用 `gjjutils_` 前缀的公共函数
- 通过别名保持代码兼容性
- 零外部依赖，自包含实现

**现在所有导入错误已修复，ComfyUI 应能正常加载这些节点！** 🎊
