# GJJ 公共工具函数模块

本目录包含所有跨节点复用的公共工具函数。

## 📋 核心原则

1. **统一存放**：所有公共函数必须放在此目录下
2. **零依赖**：严禁导入其他节点代码（`from .gjj_xxx import ...`）
3. **自包含**：所有辅助函数必须在当前文件内定义
4. **命名规范**：所有公共函数使用 `gjjutils_` 前缀
5. **灵活性**：函数设计避免硬编码，提供可配置参数

## 📁 目录结构

```
common_utils/
├── __init__.py          # 导出所有公共函数
├── model_family.py      # 模型族相关工具
├── sampler_tools.py     # 内置采样器工具（替代 comfy_extras.nodes_custom_sampler, nodes_flux）
├── video_tools.py       # 内置视频工具（替代 comfy_extras.nodes_lt, nodes_video, nodes_hunyuan）
├── audio_tools.py       # 内置音频工具（替代 comfy_extras.nodes_lt_audio, nodes_audio）
├── mask_tools.py        # 内置遮罩工具（替代 comfy_extras.nodes_mask）
├── cfg_tools.py         # 内置 CFG 工具（替代 comfy_extras.nodes_cfg）
└── README.md            # 使用文档
```

## 🛠️ 可用函数

### 模型族工具 (model_family.py)

#### 1. gjjutils_model_family_match_preset

根据 UNET 名称匹配对应的模型族预设。

**基本用法：**
```python
from .common_utils.model_family import gjjutils_model_family_match_preset

# 自动匹配预设
preset = gjjutils_model_family_match_preset("flux-2-klein-9b-nvfp4.safetensors")
print(preset["clip_type"])  # "flux2"
print(preset["steps"])      # 20
```

**高级用法 - 自定义预设列表：**
```python
# 使用自定义预设列表
custom_presets = [
    {
        "keywords": ["my-custom-model"],
        "clip_type": "custom_type",
        "steps": 30,
        "cfg": 7.5,
    }
]
preset = gjjutils_model_family_match_preset(
    "my-custom-model-v1",
    presets=custom_presets
)
```

**高级用法 - 自定义默认配置：**
```python
# 未匹配时使用自定义默认配置
default_config = {
    "clip_type": "fallback_type",
    "steps": 50,
    "cfg": 10.0,
}
preset = gjjutils_model_family_match_preset(
    "unknown-model",
    default_preset=default_config
)
```

---

#### 2. gjjutils_model_family_resolve_clip_type

根据 UNET 和 CLIP 名称智能推断 CLIP 类型。

**基本用法：**
```python
from .common_utils.model_family import gjjutils_model_family_resolve_clip_type

# 自动推断
clip_type = gjjutils_model_family_resolve_clip_type(
    unet_name="flux-2-klein-9b.safetensors",
    clip_names=["qwen_3_8b.safetensors"]
)
print(clip_type)  # "flux2"
```

**高级用法 - 自定义关键词：**
```python
# 添加自定义关键词映射
custom_keywords = [
    (("my-special-model", "special-v2"), "my_custom_type"),
]

clip_type = gjjutils_model_family_resolve_clip_type(
    unet_name="my-special-model-v2.safetensors",
    clip_names=[],
    custom_keywords=custom_keywords
)
print(clip_type)  # "my_custom_type"
```

**高级用法 - 用户指定优先级：**
```python
# 用户手动指定的类型优先级最高
clip_type = gjjutils_model_family_resolve_clip_type(
    unet_name="flux-2-klein.safetensors",
    clip_names=[],
    preferred_type="force_flux1"  # 强制使用 flux1
)
print(clip_type)  # "force_flux1"
```

---

#### 3. gjjutils_model_family_get_flux_clip_candidates

获取 Flux 模型的可选 CLIP 候选列表。

**基本用法：**
```python
from .common_utils.model_family import gjjutils_model_family_get_flux_clip_candidates

# 标准 T5 系列优先级
candidates = gjjutils_model_family_get_flux_clip_candidates(
    clip_models=["t5xxl_fp16.safetensors", "other-clip.safetensors"]
)
print(candidates)  # ["t5xxl_fp16.safetensors"]
```

**高级用法 - 自定义优先级：**
```python
# 自定义优先级列表
priority = [
    "custom-t5-v2.safetensors",
    "backup-t5.safetensors",
    "fallback-t5.safetensors",
]

candidates = gjjutils_model_family_get_flux_clip_candidates(
    clip_models=available_clips,
    default_name="preferred-t5.safetensors",
    priority_list=priority
)
```

---

#### 4. gjjutils_model_family_resolve_clip_names

从预设中解析并匹配可用的 CLIP 模型名称列表。

**基本用法：**
```python
from .common_utils.model_family import gjjutils_model_family_resolve_clip_names

clip_names = gjjutils_model_family_resolve_clip_names(
    preset=model_preset,
    clip_models=available_clips,
    exposed_clip_name="user-selected-clip.safetensors"
)
```

**高级用法 - 自定义匹配器：**
```python
# 自定义名称匹配逻辑
def strict_matcher(requested, available, fallback):
    """严格精确匹配"""
    if requested in available:
        return requested
    return ""

clip_names = gjjutils_model_family_resolve_clip_names(
    preset=model_preset,
    clip_models=available_clips,
    name_matcher=strict_matcher
)
```

---

#### 5. gjjutils_model_family_pick_lora_name

从可用 LoRA 列表中选择最匹配的名称。

**基本用法（灵活匹配）：**
```python
from .common_utils.model_family import gjjutils_model_family_pick_lora_name

# 支持部分包含匹配
lora_name = gjjutils_model_family_pick_lora_name(
    requested="lightning-lora.safetensors",
    available=["my-lightning-lora-v2.safetensors", "other.safetensors"]
)
print(lora_name)  # "my-lightning-lora-v2.safetensors"
```

**高级用法 - 不同匹配模式：**
```python
# 精确匹配模式
lora_name = gjjutils_model_family_pick_lora_name(
    requested="exact-name.safetensors",
    available=["exact-name.safetensors", "partial-match.safetensors"],
    match_mode="exact"
)
# 结果："exact-name.safetensors"

# Basename 匹配模式
lora_name = gjjutils_model_family_pick_lora_name(
    requested="models/lora.safetensors",
    available=["subdir/lora.safetensors"],
    match_mode="basename"
)
# 结果："subdir/lora.safetensors"

# 灵活匹配模式（默认）
lora_name = gjjutils_model_family_pick_lora_name(
    requested="lightning",
    available=["fast-lightning-v2.safetensors"],
    match_mode="flexible"
)
# 结果："fast-lightning-v2.safetensors"
```

---

#### 6. gjjutils_model_family_pick_model_name

从可用模型列表中选择最匹配的名称。

**基本用法：**
```python
from .common_utils.model_family import gjjutils_model_family_pick_model_name

# Basename 匹配（默认）
vae_name = gjjutils_model_family_pick_model_name(
    requested="flux2-vae.safetensors",
    available=["models/vae/flux2-vae.safetensors"]
)
print(vae_name)  # "models/vae/flux2-vae.safetensors"
```

**高级用法 - 不同匹配策略：**
```python
# 精确匹配
model_name = gjjutils_model_family_pick_model_name(
    requested="exact-path/model.safetensors",
    available=["exact-path/model.safetensors"],
    match_strategy="exact"
)

# 规范化匹配（去除所有特殊字符后比较）
model_name = gjjutils_model_family_pick_model_name(
    requested="my_model_v1",
    available=["my-model-v1.safetensors"],
    match_strategy="canonical"
)
# 结果："my-model-v1.safetensors"（因为规范化后都是 "mymodelv1"）
```

---

### 内置采样器工具 (sampler_tools.py)

这些工具将 `comfy_extras` 中的节点功能内置，避免外部依赖。

#### 1. EmptyFlux2LatentImage

创建空的 Flux2 latent 图像。

**基本用法：**
```python
from .common_utils.sampler_tools import EmptyFlux2LatentImage

# 创建 1024x1024 的空 latent，批次大小为 1
latent = EmptyFlux2LatentImage.execute(width=1024, height=1024, batch_size=1)
print(latent["samples"].shape)  # [1, 32, 128, 128]
```

---

#### 2. Flux2Scheduler

生成 Flux2 专用的 sigma 调度。

**基本用法：**
```python
from .common_utils.sampler_tools import Flux2Scheduler

# 生成 20 步的 sigma 调度
sigmas = Flux2Scheduler.execute(steps=20, width=1024, height=1024)
print(sigmas.shape)  # [21]
```

---

#### 3. RandomNoise

生成随机噪声。

**基本用法：**
```python
from .common_utils.sampler_tools import RandomNoise

# 生成随机噪声生成器
noise = RandomNoise.execute(seed=42)
print(noise.keys())  # ['noise']
```

---

#### 4. KSamplerSelect

选择采样器。

**基本用法：**
```python
from .common_utils.sampler_tools import KSamplerSelect

# 选择 euler 采样器
sampler = KSamplerSelect.execute(sampler_name="euler")
print(sampler.keys())  # ['sampler']
```

---

#### 5. CFGGuider

创建 CFG 引导器。

**基本用法：**
```python
from .common_utils.sampler_tools import CFGGuider

# 创建 CFG 引导器
guider = CFGGuider.execute(
    model=model,
    positive=positive_conditioning,
    negative=negative_conditioning,
    cfg=1.0
)
print(guider.keys())  # ['guider']
```

---

#### 6. SamplerCustomAdvanced

高级自定义采样器执行。

**完整工作流示例：**
```python
from .common_utils.sampler_tools import (
    EmptyFlux2LatentImage,
    Flux2Scheduler,
    RandomNoise,
    KSamplerSelect,
    CFGGuider,
    SamplerCustomAdvanced,
)

# 1. 创建空 latent
latent = EmptyFlux2LatentImage.execute(width=1024, height=1024, batch_size=1)

# 2. 生成 sigma 调度
sigmas = Flux2Scheduler.execute(steps=20, width=1024, height=1024)

# 3. 生成噪声
noise = RandomNoise.execute(seed=42)

# 4. 选择采样器
sampler = KSamplerSelect.execute(sampler_name="euler")

# 5. 创建 CFG 引导器
guider = CFGGuider.execute(model, positive, negative, cfg=1.0)

# 6. 执行采样
result = SamplerCustomAdvanced.execute(
    noise_dict=noise,
    guider_dict=guider,
    sampler_dict=sampler,
    sigmas=sigmas,
    latent_image=latent
)

sampled_latent = result["output"]
```

---

### 内置视频工具 (video_tools.py)

这些工具将 `comfy_extras.nodes_lt`、`nodes_video`、`nodes_hunyuan` 中的视频相关节点功能内置。

#### 1. EmptyLTXVLatentVideo

创建空的 LTX 视频 latent。

**基本用法：**
```python
from .common_utils.video_tools import EmptyLTXVLatentVideo

# 创建 1024x576，97 帧的视频 latent
latent = EmptyLTXVLatentVideo.execute(
    width=1024,
    height=576,
    length=97,
    batch_size=1
)
print(latent["samples"].shape)  # [1, 128, 13, 18, 32]
```

---

#### 2. LTXVAddGuide

向视频添加引导帧（首尾帧或关键帧）。

**基本用法：**
```python
from .common_utils.video_tools import LTXVAddGuide

# 添加首帧引导
result = LTXVAddGuide.execute(
    frames=97,
    start_frame=0,
    latent=video_latent,
    image=first_frame_image,
    strength=1.0
)
updated_latent = result["samples"]
guide_info = result["guide"]
```

---

#### 3. LTXVConcatAVLatent / LTXVSeparateAVLatent

拼接和分离音视频 latent。

**基本用法：**
```python
from .common_utils.video_tools import LTXVConcatAVLatent, LTXVSeparateAVLatent

# 拼接音视频
combined = LTXVConcatAVLatent.execute(video_latent, audio_latent)

# 分离音视频
separated = LTXVSeparateAVLatent.execute(combined, video_channels=128)
video_only = separated["video"]
audio_only = separated["audio"]
```

---

#### 4. LTXVConditioning / LTXVCropGuides

LTX 条件编码处理和裁剪。

**基本用法：**
```python
from .common_utils.video_tools import LTXVConditioning, LTXVCropGuides

# 处理条件编码
positive, negative = LTXVConditioning.execute(positive_cond, negative_cond)

# 裁剪引导条件
positive, negative = LTXVCropGuides.execute(
    positive_cond,
    negative_cond,
    frame_rate=25.0,
    total_frames=97
)
```

---

#### 5. LatentUpscaleModelLoader / LTXVLatentUpsampler

加载上采样模型并执行上采样。

**基本用法：**
```python
from .common_utils.video_tools import LatentUpscaleModelLoader, LTXVLatentUpsampler

# 加载上采样模型
upscale_model = LatentUpscaleModelLoader.execute("ltx-2.3-spatial-upscaler-x2-1.1.safetensors")

# 执行上采样（2倍）
upsampled = LTXVLatentUpsampler.execute(
    upscale_model=upscale_model,
    latent=video_latent,
    scale_factor=2.0
)
```

---

### 内置音频工具 (audio_tools.py)

这些工具将 `comfy_extras.nodes_lt_audio`、`nodes_audio` 中的音频相关节点功能内置。

#### 1. LTXVEmptyLatentAudio

创建空的音频 latent。

**基本用法：**
```python
from .common_utils.audio_tools import LTXVEmptyLatentAudio

# 创建批次大小为 1，长度为 1000 帧的音频 latent
latent = LTXVEmptyLatentAudio.execute(batch_size=1, length=1000)
print(latent["samples"].shape)  # [1, 64, 1000]
```

---

#### 2. LTXVAudioVAELoader / LTXVAudioVAEEncode / LTXVAudioVAEDecode

音频 VAE 加载、编码和解码。

**基本用法：**
```python
from .common_utils.audio_tools import (
    LTXVAudioVAELoader,
    LTXVAudioVAEEncode,
    LTXVAudioVAEDecode,
)

# 加载音频 VAE
vae = LTXVAudioVAELoader.execute("LTX23_audio_vae_bf16.safetensors")

# 编码音频波形到 latent
encoded = LTXVAudioVAEEncode.execute(vae=vae, audio=audio_waveform)

# 解码 latent 到音频波形
decoded = LTXVAudioVAEDecode.execute(vae=vae, samples=encoded)
```

---

#### 3. LTXAVTextEncoderLoader

加载音频文本编码器。

**基本用法：**
```python
from .common_utils.audio_tools import LTXAVTextEncoderLoader

# 加载文本编码器
text_encoder = LTXAVTextEncoderLoader.execute("gemma_3_12B_it_fp8_scaled.safetensors")
```

---

### 内置遮罩工具 (mask_tools.py)

这些工具将 `comfy_extras.nodes_mask` 中的遮罩相关节点功能内置。

#### 1. GrowMask

扩张或收缩遮罩。

**基本用法：**
```python
from .common_utils.mask_tools import GrowMask

# 扩张遮罩 5 像素，使用圆角
expanded = GrowMask.execute(mask=input_mask, expand=5, tapered_corners=True)

# 收缩遮罩 3 像素
contracted = GrowMask.execute(mask=input_mask, expand=-3, tapered_corners=False)
```

---

### 内置 CFG 工具 (cfg_tools.py)

这些工具将 `comfy_extras.nodes_cfg` 中的 CFG 相关节点功能内置。

#### 1. CFGNorm

CFG 归一化处理。

**基本用法：**
```python
from .common_utils.cfg_tools import CFGNorm

# 执行 CFG 归一化
model_norm, positive_norm, negative_norm = CFGNorm.execute(
    model=model,
    positive=positive_cond,
    negative=negative_cond,
    cfg=1.0
)
```

---

## 💡 最佳实践

### 1. 在节点中使用公共函数

```python
# 节点文件：nodes/my_custom_node.py
from .common_utils.model_family import (
    gjjutils_model_family_match_preset,
    gjjutils_model_family_resolve_clip_type,
)
from .common_utils.sampler_tools import (
    EmptyFlux2LatentImage,
    Flux2Scheduler,
    RandomNoise,
    KSamplerSelect,
    CFGGuider,
    SamplerCustomAdvanced,
)

class MyCustomNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "unet_name": ("STRING", {"default": "flux-2-klein.safetensors"}),
            }
        }
    
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "generate"
    
    def generate(self, unet_name):
        # ✅ 使用公共函数
        preset = gjjutils_model_family_match_preset(unet_name)
        clip_type = gjjutils_model_family_resolve_clip_type(
            unet_name,
            preset.get("clip_names", [])
        )
        
        # ✅ 使用内置采样器
        latent = EmptyFlux2LatentImage.execute(1024, 1024, 1)
        sigmas = Flux2Scheduler.execute(20, 1024, 1024)
        noise = RandomNoise.execute(42)
        sampler = KSamplerSelect.execute("euler")
        guider = CFGGuider.execute(model, positive, negative, 1.0)
        result = SamplerCustomAdvanced.execute(noise, guider, sampler, sigmas, latent)
        
        return (decoded_image,)
```

### 2. 扩展自定义功能

```python
# 创建自定义预设系统
from .common_utils.model_family import (
    gjjutils_model_family_match_preset,
    MODEL_FAMILY_PRESETS,
)

# 合并自定义预设
custom_presets = [
    {
        "id": "my_project",
        "keywords": ["project-x"],
        "clip_type": "custom",
        "steps": 40,
    }
]

all_presets = custom_presets + MODEL_FAMILY_PRESETS

# 使用合并后的预设
preset = gjjutils_model_family_match_preset(
    "project-x-model",
    presets=all_presets
)
```

### 3. 错误处理

```python
from .common_utils.model_family import gjjutils_model_family_pick_lora_name

try:
    lora_name = gjjutils_model_family_pick_lora_name(
        requested="important-lora.safetensors",
        available=[],
        fallback="safe-default.safetensors"
    )
    
    if not lora_name:
        print("警告：未找到合适的 LoRA，跳过加载")
    else:
        print(f"使用 LoRA: {lora_name}")
        
except Exception as e:
    print(f"LoRA 选择失败: {e}")
```

---

## ⚠️ 注意事项

1. **禁止循环依赖**：公共函数模块不能导入任何节点代码
2. **保持向后兼容**：新增参数应提供默认值，避免破坏现有调用
3. **文档完整性**：每个公共函数必须有清晰的 docstring 和使用示例
4. **测试覆盖**：修改公共函数后，确保所有依赖节点正常工作
5. **内置采样器**：使用 `sampler_tools` 替代 `comfy_extras` 依赖，确保节点独立性

---

## 📝 更新日志

- **2026-05-06 (Phase 4)**: 
  - ✅ 完成 Phase 1-4 所有计划任务
  - ✅ 新增视频工具模块（video_tools.py）：内置 LTX 视频、通用视频处理、上采样工具（10个类）
  - ✅ 新增音频工具模块（audio_tools.py）：内置 LTX 音频编解码、文本编码器（6个类）
  - ✅ 新增遮罩工具模块（mask_tools.py）：内置 GrowMask（1个类）
  - ✅ 新增 CFG 工具模块（cfg_tools.py）：内置 CFGNorm（1个类）
  - ✅ 更新 gjj_batch_watermark_remover.py 使用内置工具
  - ✅ 总计完成 26 个类的内置，大幅减少外部依赖

- **2026-05-06 (Phase 2-3)**: 
  - ✅ 新增内置采样器工具（sampler_tools.py）：替代 comfy_extras.nodes_custom_sampler, nodes_flux（7个类）
  - ✅ 支持 ManualSigmas 手动 Sigma 调度
  - ✅ 提供完整的 Flux2 参考工作流示例

- **2026-05-06 (Phase 1)**: 
  - 初始版本，提供模型族相关工具函数（model_family.py）
  - 支持灵活的预设匹配和多种名称匹配模式
