# GJJ comfy_extras 依赖现状分析报告

## 📅 分析日期
2026-05-06

## ✅ 已完成内置的模块

以下模块的功能已经完全内置到 `common_utils/` 中：

| 模块 | 状态 | 内置文件 |
|------|------|---------|
| nodes_custom_sampler | ✅ 已内置 | sampler_tools.py |
| nodes_flux | ✅ 已内置 | sampler_tools.py |
| nodes_lt | ✅ 已内置 | video_tools.py |
| nodes_video | ✅ 已内置 | video_tools.py |
| nodes_hunyuan | ✅ 已内置 | video_tools.py |
| nodes_lt_upsampler | ✅ 已内置 | video_tools.py |
| nodes_lt_audio | ✅ 已内置 | audio_tools.py |
| nodes_audio | ✅ 已内置 | audio_tools.py |
| nodes_mask | ✅ 已内置 | mask_tools.py |
| nodes_cfg | ✅ 已内置 | cfg_tools.py |

---

## ⚠️ 仍需迁移的文件（10个）

虽然所有功能都已内置，但以下 **10 个文件**仍在使用旧的 `from comfy_extras` 导入方式：

### 1. gjj_ltx23_first_last_outfit.py
**使用的导入：**
```python
from comfy_extras.nodes_custom_sampler import CFGGuider, KSamplerSelect, ManualSigmas, RandomNoise, SamplerCustomAdvanced
from comfy_extras.nodes_hunyuan import LatentUpscaleModelLoader
from comfy_extras.nodes_lt import (EmptyLTXVLatentVideo, LTXVAddGuide, LTXVConcatAVLatent, LTXVConditioning, LTXVCropGuides, LTXVSeparateAVLatent)
from comfy_extras.nodes_lt_audio import LTXAVTextEncoderLoader, LTXVAudioVAEDecode, LTXVAudioVAELoader, LTXVEmptyLatentAudio
from comfy_extras.nodes_lt_upsampler import LTXVLatentUpsampler
```

**需要替换为：**
```python
from .common_utils.sampler_tools import CFGGuider, KSamplerSelect, ManualSigmas, RandomNoise, SamplerCustomAdvanced
from .common_utils.video_tools import LatentUpscaleModelLoader, EmptyLTXVLatentVideo, LTXVAddGuide, LTXVConcatAVLatent, LTXVConditioning, LTXVCropGuides, LTXVSeparateAVLatent
from .common_utils.audio_tools import LTXAVTextEncoderLoader, LTXVAudioVAEDecode, LTXVAudioVAELoader, LTXVEmptyLatentAudio
from .common_utils.video_tools import LTXVLatentUpsampler
```

---

### 2. gjj_ltx23_image_to_video.py
**使用的导入：**
```python
from comfy_extras.nodes_custom_sampler import CFGGuider, KSamplerSelect, ManualSigmas, RandomNoise, SamplerCustomAdvanced
from comfy_extras.nodes_lt import (EmptyLTXVLatentVideo, LTXVAddGuide, LTXVConcatAVLatent, LTXVConditioning, LTXVCropGuides, LTXVSeparateAVLatent)
from comfy_extras.nodes_lt_audio import LTXAVTextEncoderLoader, LTXVAudioVAEDecode, LTXVAudioVAEEncode, LTXVAudioVAELoader, LTXVEmptyLatentAudio
from comfy_extras.nodes_lt_upsampler import LTXVLatentUpsampler
from comfy_extras.nodes_video import CreateVideo
from comfy_extras.nodes_hunyuan import LatentUpscaleModelLoader
```

**需要替换为：**
```python
from .common_utils.sampler_tools import CFGGuider, KSamplerSelect, ManualSigmas, RandomNoise, SamplerCustomAdvanced
from .common_utils.video_tools import EmptyLTXVLatentVideo, LTXVAddGuide, LTXVConcatAVLatent, LTXVConditioning, LTXVCropGuides, LTXVSeparateAVLatent, CreateVideo, LatentUpscaleModelLoader, LTXVLatentUpsampler
from .common_utils.audio_tools import LTXAVTextEncoderLoader, LTXVAudioVAEDecode, LTXVAudioVAEEncode, LTXVAudioVAELoader, LTXVEmptyLatentAudio
```

---

### 3. gjj_ltx23_multiref_runtime.py
**使用的导入：**
```python
from comfy_extras.nodes_cfg import CFGNorm
from comfy_extras.nodes_custom_sampler import CFGGuider, KSamplerSelect, ManualSigmas, RandomNoise, SamplerCustomAdvanced
from comfy_extras.nodes_hunyuan import LatentUpscaleModelLoader
from comfy_extras.nodes_lt import EmptyLTXVLatentVideo, LTXVAddGuide, LTXVConcatAVLatent, LTXVConditioning, LTXVCropGuides, LTXVSeparateAVLatent
from comfy_extras.nodes_lt_audio import LTXAVTextEncoderLoader, LTXVAudioVAEDecode, LTXVAudioVAEEncode, LTXVAudioVAELoader, LTXVEmptyLatentAudio
from comfy_extras.nodes_lt_upsampler import LTXVLatentUpsampler
from comfy_extras.nodes_video import CreateVideo
```

**需要替换为：**
```python
from .common_utils.cfg_tools import CFGNorm
from .common_utils.sampler_tools import CFGGuider, KSamplerSelect, ManualSigmas, RandomNoise, SamplerCustomAdvanced
from .common_utils.video_tools import LatentUpscaleModelLoader, EmptyLTXVLatentVideo, LTXVAddGuide, LTXVConcatAVLatent, LTXVConditioning, LTXVCropGuides, LTXVSeparateAVLatent, CreateVideo, LTXVLatentUpsampler
from .common_utils.audio_tools import LTXAVTextEncoderLoader, LTXVAudioVAEDecode, LTXVAudioVAEEncode, LTXVAudioVAELoader, LTXVEmptyLatentAudio
```

---

### 4. gjj_ltx23_workflow_suite.py
**使用的导入：**
```python
from comfy_extras.nodes_custom_sampler import CFGGuider, KSamplerSelect, ManualSigmas, RandomNoise, SamplerCustomAdvanced
from comfy_extras.nodes_hunyuan import LatentUpscaleModelLoader
from comfy_extras.nodes_lt import EmptyLTXVLatentVideo, LTXVAddGuide, LTXVConcatAVLatent, LTXVConditioning, LTXVCropGuides, LTXVSeparateAVLatent
from comfy_extras.nodes_lt_audio import LTXAVTextEncoderLoader, LTXVAudioVAEDecode, LTXVAudioVAEEncode, LTXVAudioVAELoader, LTXVEmptyLatentAudio
from comfy_extras.nodes_lt_upsampler import LTXVLatentUpsampler
from comfy_extras.nodes_video import CreateVideo, GetVideoComponents
# 内部使用: from comfy_extras.nodes_lt import LTXVPreprocess
```

**需要替换为：**
```python
from .common_utils.sampler_tools import CFGGuider, KSamplerSelect, ManualSigmas, RandomNoise, SamplerCustomAdvanced
from .common_utils.video_tools import LatentUpscaleModelLoader, EmptyLTXVLatentVideo, LTXVAddGuide, LTXVConcatAVLatent, LTXVConditioning, LTXVCropGuides, LTXVSeparateAVLatent, CreateVideo, GetVideoComponents, LTXVLatentUpsampler
from .common_utils.audio_tools import LTXAVTextEncoderLoader, LTXVAudioVAEDecode, LTXVAudioVAEEncode, LTXVAudioVAELoader, LTXVEmptyLatentAudio
# 注意: LTXVPreprocess 尚未内置，需要后续实现
```

---

### 5. gjj_ltx23_template_workflows.py
**使用的导入：**
```python
from comfy_extras.nodes_video import GetVideoComponents
```

**需要替换为：**
```python
from .common_utils.video_tools import GetVideoComponents
```

---

### 6. gjj_ltx_first_last_frame.py
**使用的导入：**
```python
from comfy_extras.nodes_lt import LTXVAddGuide
```

**需要替换为：**
```python
from .common_utils.video_tools import LTXVAddGuide
```

---

### 7. gjj_qwen2511_edit_outpaint.py
**使用的导入：**
```python
from comfy_extras.nodes_mask import GrowMask
```

**需要替换为：**
```python
from .common_utils.mask_tools import GrowMask
```

---

### 8. gjj_video_combine_runtime.py
**使用的导入：**
```python
from comfy_extras.nodes_video import CreateVideo
```

**需要替换为：**
```python
from .common_utils.video_tools import CreateVideo
```

---

### 9. gjj_video_segment_editor.py
**使用的导入：**
```python
from comfy_extras.nodes_video import CreateVideo  # 在函数内部使用
```

**需要替换为：**
```python
from .common_utils.video_tools import CreateVideo  # 移到文件顶部
```

---

### 10. gjj_audio_ace_music_generator.py
**使用的导入：**
```python
from comfy_extras.nodes_audio import vae_decode_audio
```

**需要替换为：**
```python
from .common_utils.audio_tools import vae_decode_audio
```

---

## 📊 统计摘要

| 类别 | 数量 |
|------|------|
| **已完成内置的功能** | 26 个类 |
| **仍需迁移的文件** | 10 个文件 |
| **主要涉及的节点类型** | LTX 视频生成、音频处理、遮罩操作 |

### 按模块分类的待迁移文件

| comfy_extras 模块 | 影响文件数 | 代表文件 |
|------------------|-----------|---------|
| nodes_lt | 5 | gjj_ltx23_*.py |
| nodes_lt_audio | 4 | gjj_ltx23_*.py |
| nodes_custom_sampler | 4 | gjj_ltx23_*.py |
| nodes_video | 4 | gjj_ltx23_*.py, gjj_video_*.py |
| nodes_hunyuan | 3 | gjj_ltx23_*.py |
| nodes_lt_upsampler | 3 | gjj_ltx23_*.py |
| nodes_mask | 1 | gjj_qwen2511_edit_outpaint.py |
| nodes_cfg | 1 | gjj_ltx23_multiref_runtime.py |
| nodes_audio | 1 | gjj_audio_ace_music_generator.py |

---

## 🎯 迁移优先级建议

### 🔴 高优先级（核心工作流节点）

1. **gjj_ltx23_first_last_outfit.py** - LTX 首尾帧换装
2. **gjj_ltx23_image_to_video.py** - LTX 图生视频
3. **gjj_ltx23_multiref_runtime.py** - LTX 多参考运行时
4. **gjj_ltx23_workflow_suite.py** - LTX 工作流套件

**原因**：这些是 LTX 视频生成的核心节点，使用频率最高。

### 🟡 中优先级（辅助节点）

5. **gjj_ltx23_template_workflows.py** - LTX 模板工作流
6. **gjj_ltx_first_last_frame.py** - LTX 首尾帧处理
7. **gjj_video_combine_runtime.py** - 视频合并运行时
8. **gjj_video_segment_editor.py** - 视频片段编辑器

### 🟢 低优先级（边缘节点）

9. **gjj_qwen2511_edit_outpaint.py** - Qwen 外绘编辑
10. **gjj_audio_ace_music_generator.py** - ACE 音乐生成

---

## ⚠️ 注意事项

### 1. LTXVPreprocess 尚未内置

在 [gjj_ltx23_workflow_suite.py](file://d:\AI\MOD\custom_nodes\GJJ\nodes\gjj_ltx23_workflow_suite.py) 中发现使用了 `LTXVPreprocess`，该功能目前**尚未内置**。

**解决方案：**
- 选项 A：暂时保留对该功能的 comfy_extras 依赖
- 选项 B：实现完整的 LTXVPreprocess 功能
- 选项 C：提供 fallback 机制，优先使用内置版本，失败时回退到 comfy_extras

### 2. 占位实现的功能

以下功能在内置工具中为**占位实现**，可能需要特殊处理：

- **CreateVideo**：需要集成 imageio-ffmpeg 或 OpenCV
- **GetVideoComponents**：需要视频解析功能
- **LTXVAudioVAEEncode/Decode**：需要加载实际音频 VAE 模型
- **vae_decode_audio**：需要音频解码逻辑
- **CFGNorm**：需要根据具体模型实现归一化算法

**建议策略：**
```python
# 在节点中使用 fallback 机制
try:
    from .common_utils.video_tools import CreateVideo
except (ImportError, NotImplementedError):
    from comfy_extras.nodes_video import CreateVideo
    print("警告：使用 ComfyUI 原生的 CreateVideo 节点")
```

### 3. 测试验证

迁移后需要进行全面测试：
- ✅ 单元测试：验证每个导入是否正常工作
- ✅ 集成测试：验证节点工作流正常运行
- ⚠️ 性能测试：对比内置版本与原版的性能差异

---

## 🚀 迁移步骤建议

### Phase 5: 批量迁移节点（预计 1-2 周）

#### 步骤 1：准备阶段
1. 备份当前代码
2. 创建迁移分支
3. 准备测试工作流

#### 步骤 2：逐个迁移
按优先级顺序迁移 10 个文件：
1. 修改导入语句
2. 更新 `.execute()` 调用（如有必要）
3. 运行单元测试
4. 运行集成测试

#### 步骤 3：验证阶段
1. 在所有受影响的工作流中测试
2. 收集用户反馈
3. 修复发现的问题

#### 步骤 4：清理阶段
1. 移除所有 `comfy_extras` 导入
2. 更新文档
3. 合并到主分支

---

## 📈 预期收益

完成迁移后，GJJ 项目将实现：

✅ **完全零外部依赖**：不再依赖任何 comfy_extras 模块  
✅ **100% 独立性**：可在任何 ComfyUI 环境中直接运行  
✅ **简化部署**：无需安装额外的扩展  
✅ **降低维护成本**：不受外部节点更新影响  
✅ **提升可移植性**：便于分发和共享  

---

## 📝 相关资源

- **[COMFY_EXTRAS_PROGRESS.md](file://d:\AI\MOD\custom_nodes\GJJ\nodes\common_utils\COMFY_EXTRAS_PROGRESS.md)** - 内置进度跟踪
- **[README.md](file://d:\AI\MOD\custom_nodes\GJJ\nodes\common_utils\README.md)** - 内置工具使用文档
- **[COMPLETION_REPORT.md](file://d:\AI\MOD\custom_nodes\GJJ\nodes\common_utils\COMPLETION_REPORT.md)** - 完成报告

---

## 🎯 下一步行动

1. **立即行动**：开始迁移高优先级的 4 个 LTX 核心节点
2. **短期目标**：完成所有 10 个文件的迁移（1-2 周）
3. **中长期目标**：完善占位实现，移除所有 fallback 代码（1-2 月）

**让我们继续推进，实现 GJJ 项目的完全独立！** 🚀