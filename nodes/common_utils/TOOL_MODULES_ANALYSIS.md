# GJJ 工具模块迁移分析报告

## 📅 分析日期
2026-05-06

## 🎯 分析目标

识别 nodes 目录中非节点文件（没有 NODE_CLASS_MAPPINGS），评估是否应该迁移到 `common_utils/` 目录。

---

## 📊 发现的工具模块（20个）

### ✅ 已迁移到 common_utils 的模块

| 文件名 | 状态 | 说明 |
|--------|------|------|
| model_family.py | ✅ 已迁移 | 模型族匹配工具 |
| sampler_tools.py | ✅ 已迁移 | 采样器工具 |
| video_tools.py | ✅ 已迁移 | 视频工具 |
| audio_tools.py | ✅ 已迁移 | 音频工具 |
| mask_tools.py | ✅ 已迁移 | 遮罩工具 |
| cfg_tools.py | ✅ 已迁移 | CFG 工具 |

---

### 📁 仍在 nodes 目录的工具模块（14个）

#### 🔴 高优先级 - 被广泛引用的通用工具

##### 1. gjj_batch_image_type.py
**引用次数：** 20次  
**内容：** 定义 `GJJ_BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE"`  
**建议：** ✅ **迁移到 common_utils/types.py**

**理由：**
- 被 20 个节点引用，使用频率极高
- 是类型定义，属于基础设施
- 应该集中管理所有类型定义

**迁移方案：**
```python
# common_utils/types.py
from __future__ import annotations

# 批次图像类型标识
GJJ_BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE"

# 未来可以添加更多类型定义
GJJ_VIDEO_TYPE = "GJJ_VIDEO"
GJJ_AUDIO_TYPE = "GJJ_AUDIO"
```

---

##### 2. gjj_model_name_resolver.py
**引用次数：** 5次  
**内容：** 模型名称解析和匹配工具  
**引用文件：**
- gjj_ltx23_image_to_video.py
- gjj_ltx23_multiref_runtime.py
- gjj_ltx23_workflow_suite.py
- gjj_multi_lora_chain.py

**建议：** ✅ **迁移到 common_utils/model_tools.py**

**理由：**
- 通用的模型名称解析逻辑
- 与 model_family.py 功能相关，可以合并
- 被多个工作流节点使用

---

##### 3. gjj_model_family_preset_table.py
**引用次数：** 2次  
**内容：** 模型族预设表加载和匹配  
**引用文件：**
- gjj_flux1_dual_clip_loader.py
- gjj_qwen2511_edit_outpaint.py (通过 gjj_lazy_image_studio)

**建议：** ✅ **合并到 common_utils/model_family.py**

**理由：**
- 与现有的 model_family.py 功能高度相关
- 应该统一管理模型族相关功能

---

#### 🟡 中优先级 - 特定领域的运行时工具

##### 4. gjj_ltx23_multiref_runtime.py
**引用次数：** 4次  
**内容：** LTX23 多参考视频生成的运行时辅助函数  
**引用文件：**
- gjj_ltx23_first_last_outfit.py
- gjj_ltx23_image_to_video.py
- gjj_ltx23_multiref_image_to_video.py

**建议：** ⚠️ **保留在 nodes 或移至 nodes/ltx_runtime/**

**理由：**
- 包含大量 LTX 特定的复杂逻辑（~1652行）
- 主要是内部辅助函数，不是通用工具
- 可以考虑创建子目录 `nodes/ltx_runtime/`

---

##### 5. gjj_video_combine_runtime.py
**引用次数：** 4次  
**内容：** 视频合并的运行时辅助函数  
**引用文件：**
- gjj_any_preview.py
- gjj_ltx23_multiref_image_to_video.py
- gjj_ltx23_multiref_runtime.py

**建议：** ⚠️ **部分功能已内置，保留剩余部分**

**理由：**
- CreateVideo 已迁移到 video_tools.py
- 但包含大量视频编码/合并的复杂逻辑
- 可以考虑将通用部分提取到 common_utils

---

##### 6. gjj_face_detailer_runtime.py
**引用次数：** 2次  
**内容：** 人脸细节增强的运行时工具  
**引用文件：**
- gjj_impact_face_detailer_bridge.py

**建议：** ⚠️ **保留在 nodes 或移至 nodes/face_runtime/**

**理由：**
- 人脸处理的专用逻辑
- 依赖 ultralytics 等第三方库
- 不适合放入通用工具

---

##### 7. gjj_ultimate_runtime.py / gjj_ultimate_utils.py / gjj_ultimate_crop_patch.py
**引用次数：** 各 1-2次  
**内容：** Ultimate Architecture Upscaler 的运行时工具  
**引用文件：**
- gjj_ultimate_architecture_upscaler.py

**建议：** ⚠️ **保留在 nodes 或移至 nodes/ultimate_runtime/**

**理由：**
- 特定功能的运行时支持
- 不被其他节点广泛使用

---

#### 🟢 低优先级 - 特定功能的加载器和缓存

##### 8. gjj_cosyvoice3_runtime.py
**引用次数：** 1次  
**内容：** CosyVoice3 语音合成的运行时工具  
**引用文件：** gjj_cosyvoice3_generator.py

**建议：** ❌ **保留在原位**

**理由：**
- 仅被一个节点使用
- 功能高度专用化

---

##### 9. gjj_fish_audio_s2_loader.py / gjj_fish_audio_s2_model_cache.py
**引用次数：** 各 2次  
**内容：** Fish Audio S2 模型加载和缓存  
**引用文件：**
- gjj_fish_audio_s2_generator.py
- gjj_fish_audio_s2_loader.py (相互引用)

**建议：** ❌ **保留在原位**

**理由：**
- 仅用于 Fish Audio 功能
- 缓存逻辑与加载器紧密耦合

---

##### 10. gjj_flashvsr_runtime.py
**引用次数：** 1次  
**内容：** FlashVSR 视频超分辨率运行时  
**引用文件：** gjj_flashvsr_video_upscaler.py

**建议：** ❌ **保留在原位**

---

##### 11. gjj_longcat_audiodit_loader.py / gjj_longcat_audiodit_model_cache.py
**引用次数：** 各 2次  
**内容：** LongCat AudioDIT 加载和缓存  
**引用文件：**
- gjj_longcat_audiodit_tts.py
- gjj_longcat_audiodit_loader.py

**建议：** ❌ **保留在原位**

---

##### 12. gjj_rife_runtime.py
**引用次数：** 1次  
**内容：** RIFE 视频插帧运行时  
**引用文件：** gjj_rife_video_interpolator.py

**建议：** ❌ **保留在原位**

---

##### 13. gjj_sam3_runtime.py
**引用次数：** 1次  
**内容：** SAM3 分割运行时  
**引用文件：** gjj_batch_text_segmenter.py

**建议：** ❌ **保留在原位**

---

##### 14. gjj_ultralytics_runtime.py
**引用次数：** 1次  
**内容：** Ultralytics 模型运行时  
**引用文件：** gjj_face_detailer_runtime.py

**建议：** ❌ **保留在原位**

---

##### 15. gjj_ollama_common.py
**引用次数：** 2次  
**内容：** Ollama API 通用工具  
**引用文件：**
- gjj_image_analysis.py
- gjj_translation.py

**建议：** ⚠️ **可考虑迁移到 common_utils/api_tools.py**

**理由：**
- 通用的 API 调用工具
- 可能被其他功能复用

---

##### 16. gjj_impact_face_detailer_bridge.py
**引用次数：** 2次  
**内容：** Impact Face Detailer 桥接层  
**引用文件：**
- gjj_face_detailer.py
- gjj_face_detailer_modules.py

**建议：** ❌ **保留在原位**

**理由：**
- 专用的桥接代码
- 仅用于 face detailer 功能

---

## 📋 迁移建议总结

### ✅ 建议迁移（3个）

| 文件 | 目标位置 | 优先级 | 原因 |
|------|---------|--------|------|
| gjj_batch_image_type.py | common_utils/types.py | 🔴 高 | 被20个节点引用，基础类型定义 |
| gjj_model_name_resolver.py | common_utils/model_tools.py | 🔴 高 | 通用模型名称解析 |
| gjj_model_family_preset_table.py | 合并到 common_utils/model_family.py | 🔴 高 | 与现有功能相关 |

### ⚠️ 可选迁移（3个）

| 文件 | 目标位置 | 优先级 | 原因 |
|------|---------|--------|------|
| gjj_ollama_common.py | common_utils/api_tools.py | 🟡 中 | 通用 API 工具 |
| gjj_ltx23_multiref_runtime.py | nodes/ltx_runtime/ | 🟡 中 | 创建子目录组织 |
| gjj_video_combine_runtime.py | 部分提取到 common_utils | 🟡 中 | 提取通用视频工具 |

### ❌ 不建议迁移（8个）

这些文件都是特定功能的运行时支持，不具有通用性：
- gjj_cosyvoice3_runtime.py
- gjj_fish_audio_s2_loader.py
- gjj_fish_audio_s2_model_cache.py
- gjj_flashvsr_runtime.py
- gjj_longcat_audiodit_loader.py
- gjj_longcat_audiodit_model_cache.py
- gjj_rife_runtime.py
- gjj_sam3_runtime.py
- gjj_ultralytics_runtime.py
- gjj_face_detailer_runtime.py
- gjj_ultimate_runtime.py
- gjj_ultimate_utils.py
- gjj_ultimate_crop_patch.py
- gjj_impact_face_detailer_bridge.py

---

## 🚀 推荐的迁移计划

### Phase 9: 迁移通用工具模块（预计 1周）

#### 步骤 1: 创建 types.py
```python
# common_utils/types.py
"""GJJ 类型定义模块。

集中管理所有自定义类型标识。
"""
from __future__ import annotations

# 批次图像类型
GJJ_BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE"

# 未来扩展
# GJJ_VIDEO_TYPE = "GJJ_VIDEO"
# GJJ_AUDIO_TYPE = "GJJ_AUDIO"
```

#### 步骤 2: 创建 model_tools.py
将 gjj_model_name_resolver.py 的内容迁移过来，并与 model_family.py 整合。

#### 步骤 3: 合并 preset_table
将 gjj_model_family_preset_table.py 的功能合并到 model_family.py。

#### 步骤 4: 更新所有引用
批量更新 20+ 个文件的导入语句。

---

## 📊 预期收益

完成迁移后：

✅ **更清晰的架构**：通用工具集中在 common_utils  
✅ **更好的可维护性**：相关功能放在一起  
✅ **减少重复代码**：避免多个文件定义相同类型  
✅ **提升可发现性**：开发者更容易找到需要的工具  

---

## 📝 下一步行动

1. **立即执行**：迁移 gjj_batch_image_type.py → common_utils/types.py
2. **短期计划**：整合模型相关工具到 common_utils/model_family.py
3. **中期计划**：评估是否创建子目录组织大型 runtime 模块

**是否开始执行迁移？** 🚀