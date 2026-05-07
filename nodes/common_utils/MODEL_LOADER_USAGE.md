# LTX 和 WAN 模型族专用加载器

为不同模型族提供专门的模型加载逻辑，处理特殊的配套机制。

## 模型族特性

### LTX 2.3：双 VAE 架构
- **视频 VAE**：用于视频帧的编解码
- **音频 VAE**：用于音频波形的编解码
- 两个 VAE 都必须加载，缺一不可

### WAN 2.2：双 UNET 架构
- **主 UNET**：负责主要推理任务
- **辅助 UNET**：负责辅助功能（如条件控制）
- 两个 UNET 必须配合使用

## 使用示例

### 加载 LTX 2.3 模型

```python
from .common_utils.model_loader import gjjutils_load_ltx23_models

# 简单用法（使用默认候选列表）
ltx_models = gjjutils_load_ltx23_models()

# 自定义候选列表
ltx_models = gjjutils_load_ltx23_models(
    ckpt_candidates=("my-custom-ckpt.safetensors",),
    video_vae_candidates=("my-video-vae.safetensors",),
    audio_vae_candidates=("my-audio-vae.safetensors",),
    text_encoder_candidates=("my-text-encoder.safetensors",),
)

# 访问加载的模型
model = ltx_models["model"]              # 主模型对象
clip = ltx_models["clip"]                # CLIP 对象
video_vae = ltx_models["video_vae_obj"]  # 视频 VAE 对象
audio_vae = ltx_models["audio_vae_obj"]  # 音频 VAE 对象

# 访问文件名
print(ltx_models["ckpt"])         # "ltx-2.3-22b-dev-fp8.safetensors"
print(ltx_models["video_vae"])    # "LTX23_video_vae_bf16.safetensors"
print(ltx_models["audio_vae"])    # "LTX23_audio_vae_bf16.safetensors"
```

### 加载 WAN 2.2 模型

```python
from .common_utils.model_loader import gjjutils_load_wan22_models

# 加载 WAN 2.2 模型
wan_models = gjjutils_load_wan22_models()

# 访问加载的模型
model = wan_models["model"]              # 主模型对象
clip_obj = wan_models["clip_obj"]        # CLIP 对象
vae_obj = wan_models["vae_obj"]          # VAE 对象
main_unet = wan_models["main_unet_obj"]  # 主 UNET 对象
aux_unet = wan_models["aux_unet_obj"]    # 辅助 UNET 对象
```

### 自动检测模型族

```python
from .common_utils.model_loader import gjjutils_detect_model_family, gjjutils_get_model_loader

# 检测模型族
ckpt_name = "ltx-2.3-22b-dev-fp8.safetensors"
family = gjjutils_detect_model_family(ckpt_name)
print(family)  # "ltx"

# 获取对应的加载器
loader = gjjutils_get_model_loader(family)
if loader:
    models = loader()  # 自动调用对应的加载函数
```

## API 参考

### gjjutils_load_ltx23_models()

加载 LTX 2.3 模型族的所有必需模型。

**参数**：
- `ckpt_candidates`: 主检查点候选列表（默认：`DEFAULT_LTX23_CKPT_CANDIDATES`）
- `video_vae_candidates`: 视频 VAE 候选列表（默认：`DEFAULT_LTX23_VIDEO_VAE_CANDIDATES`）
- `audio_vae_candidates`: 音频 VAE 候选列表（默认：`DEFAULT_LTX23_AUDIO_VAE_CANDIDATES`）
- `text_encoder_candidates`: 文本编码器候选列表（默认：`DEFAULT_LTX23_TEXT_ENCODER_CANDIDATES`）

**返回值**：
```python
{
    "ckpt": str,              # 主检查点文件名
    "video_vae": str,         # 视频 VAE 文件名
    "audio_vae": str,         # 音频 VAE 文件名
    "text_encoder": str,      # 文本编码器文件名
    "model": object,          # 加载的模型对象
    "clip": object,           # 加载的 CLIP 对象
    "video_vae_obj": object,  # 视频 VAE 对象
    "audio_vae_obj": object,  # 音频 VAE 对象
}
```

### gjjutils_load_wan22_models()

加载 WAN 2.2 模型族的所有必需模型。

**参数**：
- `ckpt_candidates`: 主检查点候选列表
- `main_unet_candidates`: 主 UNET 候选列表
- `aux_unet_candidates`: 辅助 UNET 候选列表
- `clip_candidates`: CLIP 候选列表
- `vae_candidates`: VAE 候选列表

**返回值**：
```python
{
    "ckpt": str,              # 主检查点文件名
    "main_unet": str,         # 主 UNET 文件名
    "aux_unet": str,          # 辅助 UNET 文件名
    "clip": str,              # CLIP 文件名
    "vae": str,               # VAE 文件名
    "model": object,          # 加载的模型对象
    "clip_obj": object,       # CLIP 对象
    "vae_obj": object,        # VAE 对象
    "main_unet_obj": object,  # 主 UNET 对象
    "aux_unet_obj": object,   # 辅助 UNET 对象
}
```

### gjjutils_detect_model_family()

根据检查点文件名检测模型族。

**参数**：
- `ckpt_name`: 检查点文件名

**返回值**：
- `"ltx"`: LTX 模型族
- `"wan"`: WAN 模型族
- `"flux"`: Flux 模型族
- 其他或 `None`: 未识别的模型族

### gjjutils_get_model_loader()

根据模型族标识获取对应的加载器函数。

**参数**：
- `model_family`: 模型族标识（"ltx", "wan", etc.）

**返回值**：
- 对应的加载器函数，未找到返回 `None`

## 迁移指南

### 从旧代码迁移

如果你的节点之前使用手动加载逻辑：

**旧代码**：
```python
resolved_ckpt = _pick_first_candidate("checkpoints", DEFAULT_CKPT_CANDIDATES, "LTX 主模型")
resolved_video_vae = _pick_first_candidate("vae", DEFAULT_VIDEO_VAE_CANDIDATES, "LTX 视频 VAE")
resolved_audio_vae = _pick_first_candidate("vae", DEFAULT_AUDIO_VAE_CANDIDATES, "LTX 音频 VAE")
model, _, _ = CheckpointLoaderSimple().load_checkpoint(resolved_ckpt)
clip = LTXAVTextEncoderLoader.execute(resolved_text_encoder, resolved_ckpt, "default")[0]
video_vae = _load_vae(resolved_video_vae)
audio_vae = _load_vae(resolved_audio_vae)
```

**新代码**：
```python
from .common_utils.model_loader import gjjutils_load_ltx23_models

ltx_models = gjjutils_load_ltx23_models()
model = ltx_models["model"]
clip = ltx_models["clip"]
video_vae = ltx_models["video_vae_obj"]
audio_vae = ltx_models["audio_vae_obj"]
```

### 优势

1. **代码简化**：从 7 行减少到 4 行
2. **容错增强**：自动处理候选文件查找和回退逻辑
3. **维护统一**：所有 LTX/WAN 节点使用相同的加载逻辑
4. **错误提示**：提供清晰的中文错误信息

## 注意事项

1. **模型文件路径**：确保模型文件放置在正确的 ComfyUI 目录下
   - 检查点：`ComfyUI/models/checkpoints/`
   - VAE：`ComfyUI/models/vae/`
   - 文本编码器：`ComfyUI/models/text_encoders/`
   - UNET：`ComfyUI/models/diffusion_models/`

2. **候选列表优先级**：加载器会按候选列表顺序查找，找到第一个可用文件即停止

3. **错误处理**：如果所有候选文件都不存在，会抛出 `FileNotFoundError`，包含清晰的中文提示

4. **扩展性**：可以为其他模型族（如 Flux、HiDream 等）添加类似的专用加载器
