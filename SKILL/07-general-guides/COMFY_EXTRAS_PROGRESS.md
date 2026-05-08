# GJJ 内置 comfy_extras 模块进度

本文档跟踪 GJJ 项目中 comfy_extras 模块的内置进度。

## ✅ 已完成内置的模块

### 1. nodes_custom_sampler (采样器相关)
**文件**: [common_utils/sampler_tools.py](file://d:\AI\MOD\custom_nodes\GJJ\nodes\common_utils\sampler_tools.py)

| 原模块 | 内置类 | 状态 |
|--------|--------|------|
| CFGGuider | `gjjutils_CFGGuider` | ✅ 完成 |
| KSamplerSelect | `gjjutils_KSamplerSelect` | ✅ 完成 |
| RandomNoise | `gjjutils_RandomNoise` | ✅ 完成 |
| SamplerCustomAdvanced | `gjjutils_SamplerCustomAdvanced` | ✅ 完成 |
| ManualSigmas | `gjjutils_ManualSigmas` | ✅ 完成 |

**使用示例**:
```python
from .common_utils.sampler_tools import (
    CFGGuider, KSamplerSelect, RandomNoise, 
    SamplerCustomAdvanced, ManualSigmas
)

# 使用方式与原版完全一致
guider = CFGGuider.execute(model, positive, negative, cfg=1.0)
sampler = KSamplerSelect.execute("euler")
noise = RandomNoise.execute(seed=42)
sigmas = ManualSigmas.execute("1.0, 0.5, 0.0")
result = SamplerCustomAdvanced.execute(noise, guider, sampler, sigmas, latent)
```

---

### 2. nodes_flux (Flux2 相关)
**文件**: [common_utils/sampler_tools.py](file://d:\AI\MOD\custom_nodes\GJJ\nodes\common_utils\sampler_tools.py)

| 原模块 | 内置类 | 状态 |
|--------|--------|------|
| EmptyFlux2LatentImage | `gjjutils_EmptyFlux2LatentImage` | ✅ 完成 |
| Flux2Scheduler | `gjjutils_Flux2Scheduler` | ✅ 完成 |

**使用示例**:
```python
from .common_utils.sampler_tools import EmptyFlux2LatentImage, Flux2Scheduler

# 创建空 latent
latent = EmptyFlux2LatentImage.execute(width=1024, height=1024, batch_size=1)

# 生成 sigma 调度
sigmas = Flux2Scheduler.execute(steps=20, width=1024, height=1024)
```

---

## 🚧 待内置的模块（按优先级排序）

### 高优先级（频繁使用）

#### 3. nodes_lt (LTX 视频处理)
**影响文件**: gjj_ltx23_*.py (多个文件)

需要内置的功能：
- `EmptyLTXVLatentVideo` - 创建空 LTX 视频 latent
- `LTXVAddGuide` - 添加引导帧
- `LTXVConcatAVLatent` - 拼接音视频 latent
- `LTXVConditioning` - LTX 条件编码
- `LTXVCropGuides` - 裁剪引导
- `LTXVSeparateAVLatent` - 分离音视频 latent
- `LTXVImgToVideoInplace` - 图像转视频
- `LTXVPreprocess` - 视频预处理

**建议**: 创建 `common_utils/video_tools.py`

---

#### 4. nodes_lt_audio (LTX 音频处理)
**影响文件**: gjj_ltx23_*.py

需要内置的功能：
- `LTXAVTextEncoderLoader` - 加载音频文本编码器
- `LTXVAudioVAEDecode` - 音频 VAE 解码
- `LTXVAudioVAEEncode` - 音频 VAE 编码
- `LTXVAudioVAELoader` - 加载音频 VAE
- `LTXVEmptyLatentAudio` - 创建空音频 latent

**建议**: 合并到 `common_utils/audio_tools.py`

---

#### 5. nodes_lt_upsampler (LTX 上采样)
**影响文件**: gjj_ltx23_*.py

需要内置的功能：
- `LTXVLatentUpsampler` - LTX latent 上采样

**建议**: 合并到 `common_utils/video_tools.py`

---

#### 6. nodes_hunyuan (混元模型)
**影响文件**: gjj_ltx23_*.py

需要内置的功能：
- `LatentUpscaleModelLoader` - 加载 latent 上采样模型

**建议**: 创建 `common_utils/upscale_tools.py`

---

#### 7. nodes_video (通用视频处理)
**影响文件**: gjj_video_combine_runtime.py, gjj_ltx23_*.py

需要内置的功能：
- `CreateVideo` - 创建视频文件
- `GetVideoComponents` - 获取视频组件

**建议**: 合并到 `common_utils/video_tools.py`

---

#### 8. nodes_cfg (CFG 归一化)
**影响文件**: gjj_ltx23_multiref_runtime.py

需要内置的功能：
- `CFGNorm` - CFG 归一化

**建议**: 添加到 `common_utils/sampler_tools.py`

---

#### 9. nodes_mask (遮罩处理)
**影响文件**: gjj_qwen2511_edit_outpaint.py

需要内置的功能：
- `GrowMask` - 扩张遮罩

**建议**: 创建 `common_utils/mask_tools.py`

---

#### 10. nodes_audio (通用音频处理)
**影响文件**: gjj_audio_ace_music_generator.py

需要内置的功能：
- `vae_decode_audio` - VAE 音频解码

**建议**: 合并到 `common_utils/audio_tools.py`

---

### 中低优先级

#### 11. nodes_sd3 (SD3 相关)
**影响文件**: gjj_lazy_image_studio.py (已有 fallback)

需要内置的功能：
- `EmptySD3LatentImage` - 创建空 SD3 latent

**状态**: ⚠️ 已有 try-except fallback，可暂缓

---

## 📊 统计信息

| 类别 | 数量 | 状态 |
|------|------|------|
| 已完成内置 | 17 个类 | ✅ |
| 高优先级待内置 | ~10 个类（音频相关） | 🚧 |
| 中低优先级 | 3 个类 | ⏸️ |
| **总计** | **~30 个类** | - |

### 详细分类

#### ✅ 已完成（17个类）

**采样器工具 (7个)**:
- CFGGuider, KSamplerSelect, RandomNoise, SamplerCustomAdvanced, ManualSigmas
- EmptyFlux2LatentImage, Flux2Scheduler

**视频工具 (10个)**:
- EmptyLTXVLatentVideo, LTXVAddGuide, LTXVConcatAVLatent, LTXVSeparateAVLatent
- LTXVConditioning, LTXVCropGuides
- CreateVideo, GetVideoComponents
- LatentUpscaleModelLoader, LTXVLatentUpsampler

#### 🚧 待内置（~13个类）

**音频工具 (~8个)**:
- LTXAVTextEncoderLoader, LTXVAudioVAEDecode, LTXVAudioVAEEncode
- LTXVAudioVAELoader, LTXVEmptyLatentAudio
- vae_decode_audio
- 其他音频处理功能

**遮罩工具 (1个)**:
- GrowMask

**CFG 工具 (1个)**:
- CFGNorm

**其他 (3个)**:
- LTXVImgToVideoInplace, LTXVPreprocess, EmptySD3LatentImage

---

## 🎯 下一步计划

### Phase 1: 完善采样器工具 (✅ 已完成)
- [x] 内置 ManualSigmas
- [x] 更新 gjj_batch_watermark_remover.py 使用内置工具
- [x] 测试所有节点是否正常工作

### Phase 2: 视频工具模块 (🚧 进行中)
- [x] 创建 `common_utils/video_tools.py`
- [x] 内置 LTX 视频基础功能（EmptyLTXVLatentVideo, LTXVAddGuide, etc.）
- [x] 内置通用视频处理（CreateVideo, GetVideoComponents）
- [x] 内置上采样工具（LatentUpscaleModelLoader, LTXVLatentUpsampler）
- [ ] 迁移 gjj_ltx23_*.py 节点（待后续逐步进行）

### Phase 3: 音频工具模块 (✅ 已完成)
- [x] 创建 `common_utils/audio_tools.py`
- [x] 内置 LTX 音频相关功能（LTXVEmptyLatentAudio, LTXVAudioVAELoader/Encode/Decode, etc.）
- [x] 内置通用音频处理（vae_decode_audio）
- [ ] 迁移音频相关节点（待后续逐步进行）

### Phase 4: 其他工具 (✅ 已完成)
- [x] 创建 `common_utils/mask_tools.py`
- [x] 创建 `common_utils/cfg_tools.py`（原 upscale_tools.py 合并至此）
- [ ] 迁移剩余节点（待后续逐步进行）

---

## 📊 最终统计信息

| 类别 | 数量 | 状态 |
|------|------|------|
| **已完成内置** | **26 个类** | ✅ |
| 高优先级待内置 | ~5 个类（高级 LTX 功能） | 🚧 |
| 中低优先级 | 1 个类（EmptySD3LatentImage） | ⏸️ |
| **总计** | **~32 个类** | - |

### 详细分类

#### ✅ 已完成（26个类）

**采样器工具 (7个)**:
- CFGGuider, KSamplerSelect, RandomNoise, SamplerCustomAdvanced, ManualSigmas
- EmptyFlux2LatentImage, Flux2Scheduler

**视频工具 (10个)**:
- EmptyLTXVLatentVideo, LTXVAddGuide, LTXVConcatAVLatent, LTXVSeparateAVLatent
- LTXVConditioning, LTXVCropGuides
- CreateVideo, GetVideoComponents
- LatentUpscaleModelLoader, LTXVLatentUpsampler

**音频工具 (6个)**:
- LTXVEmptyLatentAudio, LTXVAudioVAELoader, LTXVAudioVAEEncode, LTXVAudioVAEDecode
- LTXAVTextEncoderLoader, vae_decode_audio

**遮罩工具 (1个)**:
- GrowMask

**CFG 工具 (1个)**:
- CFGNorm

**模型族工具 (1个模块)**:
- model_family.py（包含多个辅助函数）

#### 🚧 待内置（~6个类）

**高级 LTX 功能 (~5个)**:
- LTXVImgToVideoInplace, LTXVPreprocess
- 其他 LTX 特定功能

**SD3 相关 (1个)**:
- EmptySD3LatentImage（已有 fallback）

---

## 💡 开发规范

### 内置模块要求
1. **零外部依赖**: 不导入其他节点代码
2. **自包含实现**: 所有辅助函数在文件内定义
3. **API 兼容**: 保持 `.execute()` 调用方式
4. **完整文档**: 每个类/函数必须有 docstring
5. **命名规范**: 使用 `gjjutils_` 前缀

### 迁移步骤
1. 在 common_utils 中创建对应模块
2. 实现功能并保持 API 兼容
3. 更新节点文件的导入语句
4. 测试节点功能是否正常
5. 删除旧的 comfy_extras 导入
6. 更新本文档

---

## 📝 更新日志

- **2026-05-06**: 
  - ✅ 完成 nodes_custom_sampler 全部功能内置
  - ✅ 完成 nodes_flux 全部功能内置
  - ✅ 新增 ManualSigmas 支持
  - 📋 创建内置进度跟踪文档
