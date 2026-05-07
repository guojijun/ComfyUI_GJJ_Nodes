# ComfyUI_GJJ_Nodes

<div align="center">

[![ComfyUI](https://img.shields.io/badge/ComfyUI-Custom%20Nodes-blue?logo=python)](https://github.com/comfyanonymous/ComfyUI)
[![License](https://img.shields.io/badge/License-Personal%20Use%20Only-red)](./LICENSE)
[![Python](https://img.shields.io/badge/Python-3.10%2B-green?logo=python)](https://www.python.org/)
[![GitHub Stars](https://img.shields.io/github/stars/guojijun/ComfyUI_GJJ_Nodes?style=social)](https://github.com/guojijun/ComfyUI_GJJ_Nodes)

**200+ ComfyUI 自定义节点合集 | 图像 · 视频 · 音频 · 提示词 · 模型管理 · 工作流辅助**

</div>

---

## 📖 概述 / Overview

ComfyUI_GJJ_Nodes 是个人开发的 ComfyUI 自定义节点合集，涵盖图像处理、视频生成、音频合成、提示词工程、模型管理、工作流辅助等多个方向。所有节点统一使用 `GJJ ·` 前缀，内置中文工具提示，遵循零外部依赖原则（除 `requirements.txt` 中列出的通用包外，不依赖任何第三方自定义节点包）。

---

## ✨ 核心特性

- **单文件部署，零额外依赖** — 不依赖任何第三方自定义节点包
- **内置中文工具提示** — 所有节点参数均提供中文说明，降低使用门槛
- **子目录感知的模型查找** — 自动递归搜索模型子目录，支持最长公共片段匹配和扩展名剥离
- **动态输入/输出插槽** — 采用 AnySwitch 稳定化模式，插槽变更后保持连线不丢失
- **1-based 用户编号** — 所有面向用户的插槽编号从 1 开始，符合直觉
- **自定义预览支持** — 多种输出格式（图片、音频、视频）的专用预览节点
- **丰富的格式预设** — 内置视频格式、提示词风格等预设，开箱即用
- **前端 JS 独立封装** — 每个节点的前端逻辑放在独立 JS 文件中，便于维护

---

## 📦 安装 / Installation

### 方式一：Git 克隆（推荐）

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/guojijun/ComfyUI_GJJ_Nodes.git
cd ComfyUI_GJJ_Nodes
pip install -r requirements.txt
```

### 方式二：下载 ZIP

1. 从 [Releases](https://github.com/guojijun/ComfyUI_GJJ_Nodes/releases) 或 Code → Download ZIP 下载压缩包
2. 解压到 `ComfyUI/custom_nodes/ComfyUI_GJJ_Nodes`
3. 在该目录下运行 `pip install -r requirements.txt`

### 国内镜像加速安装（推荐）

如果下载速度慢，可使用国内 pip 镜像源：

```bash
# 清华镜像（推荐）
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

# 阿里云镜像
pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple

# 腾讯云镜像
pip install -r requirements.txt -i https://mirrors.cloud.tencent.com/pypi/simple

# 可选依赖（同样使用镜像）
pip install -r requirements-optional.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
pip install -r requirements-accelerate.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

部分节点还需要额外手动安装的包（部分已集成在 requirements 中）：

```bash
# 人脸分析 / 换脸
pip install insightface onnxruntime-gpu -i https://pypi.tuna.tsinghua.edu.cn/simple

# Ollama 相关（提示词生成、图片分析等）
pip install ollama -i https://pypi.tuna.tsinghua.edu.cn/simple

# 翻译
pip install transformers sentencepiece -i https://pypi.tuna.tsinghua.edu.cn/simple

# RIFE 视频插帧
pip install pillow -i https://pypi.tuna.tsinghua.edu.cn/simple
```

### 可选依赖

```bash
pip install -r requirements-optional.txt   # 可选功能
pip install -r requirements-accelerate.txt # 推理加速
```

### 📥 模型下载

部分节点需要配套模型才能运行。所有模型文件请从以下地址统一下载：

🔗 **模型下载地址：** [https://pan.quark.cn/s/6ec846f1f58d](https://pan.quark.cn/s/6ec846f1f58d)

#### 各节点所需模型及放置路径一览

下载后将对应模型放入 `ComfyUI/models/` 下的相应子目录：

| 模型目录 | 模型文件 | 使用节点 |
| -------- | -------- | -------- |
| `models/cosyvoice/` | CosyVoice3 全套模型文件 | CosyVoice3 语音克隆 TTS |
| `models/fishaudioS2/` | Fish Audio S2 全套模型 | Fish Audio S2 语音克隆 TTS |
| `models/audiodit/` | LongCat-AudioDiT 模型 | LongCat 语音克隆 TTS |
| `models/Qwen3-ASR/` | Qwen3-ASR 模型 | Qwen3 语音识别与强制对齐 |
| `models/FlashVSR/` | FlashVSR / Ultra-Fast 模型 | FlashVSR 视频超分放大器 |
| `models/sam3/` | sam3.safetensors | SAM3 点选/文本/批量分割器 |
| `models/sam2/` | sam2_hiera_base_plus.safetensors 等 | SEM2 点选分割器 |
| `models/sams/` | SAM 模型（sam_vit_b 等） | Face Detailer 细分/SAM Mask |
| `models/sam3dbody/` | model.safetensors + assets/mhr_model.pt | SAM3D Body 人体网格恢复 |
| `models/insightface/` | buffalo_l 模型 + inswapper_128.onnx | 人脸分析/换脸 |
| `models/ultralytics/bbox/` | 人脸/目标检测 bbox 模型 | Face Detailer / BBox 检测 |
| `models/latentsync/` | latentsync_unet.pt + whisper/tiny.pt | LatentSync 口型同步 |
| `models/checkpoints/LatentSync-1.6/` | UNet / VAE / Whisper | Local LipSync 视频分支 |
| `models/ckpts/` | big-lama.pt | LaMa 图像修复（去物补边） |
| `models/translation/` | opus-mt-zh-en 模型 | 中英翻译节点 |
| `models/upscale_models/` | ESRGAN / RealESRGAN 等超分模型 | 模型图片放大器 |
| `models/upscale_models/` | ltx-2.3-spatial-upscaler-x2 | LTX2.3 潜空间放大 |
| `models/checkpoints/` | LTX / Flux / Wan / SD 等底模 | 各生成/视频节点 |
| `models/checkpoints/` | interiordesignsuperm_v2 等 | ControlNet Preset |
| `models/checkpoints/` | ltx-2.3-22b 系列 | LTX2.3 视频生成 |
| `models/checkpoints/` | wan2.2 系列 | Wan2.2 视频生成 |
| `models/diffusion_models/` | flux-2-klein-4b-fp8.safetensors | 批量水印去除 |
| `models/diffusion_models/` | wan2.2_s2v_14B_fp8_scaled | Wan S2V 检测分支 |
| `models/text_encoders/` | gemma_3_12B_it_fp4_mixed.safetensors | LTX2.3 图片说话 |
| `models/audio_encoders/` | wav2vec2_large_english_fp16.safetensors | Wan S2V 音频条件编码 |
| `models/loras/LTX/` | ltx-2.3-22b-distilled-lora-384 + AV-LoRA | LTX2.3 口型同步 |
| `models/vae/` | LTX23_video_vae_bf16 / LTX23_audio_vae_bf16 | LTX2.3 音视频链路 |
| `models/mp3/` | 参考音频文件（.mp3 / .wav） | 语音克隆各节点（参考音色） |
| `models/fonts/` | 字体文件（.ttf / .otf） | Text Overlay 文字叠加 |

> **提示：** 大部分节点在运行时会自动在 `ComfyUI/models/` 下递归搜索模型，面板中也会显示对应的中文 tooltip 提示所需路径。

---

## 🚀 快速开始 / Quick Start

1. 安装完成后重启 ComfyUI
2. 在节点菜单中搜索 `GJJ` 即可找到所有节点
3. 所有节点统一使用 `GJJ ·` 前缀命名
4. 悬停参数标签可查看中文提示
5. 大部分节点支持右键菜单中的快捷操作
6. 详细用法参考 `examples/` 目录中的工作流示例

---

## 📋 节点列表 / Node List

### 🔧 工作流辅助

| 节点名称 | 功能描述 |
| -------- | -------- |
| GJJ · Any Switch | 按输入顺序返回第一个非空值的动态切换器，支持任意类型并会自动增减输入插槽 |
| GJJ · Any Preview | 动态接收任意类型输入的统一预览节点，支持图片网格、Markdown 文本和音频播放 |
| GJJ · 分组筛选路由 | 按分组名称关键词筛选当前工作流中的分组，便于前端面板快速定位和旁路操作 |
| GJJ · Sequence Auto Executor | 根据当前数值和总数量，在前端执行完成后自动继续排队，直到序列结束 |
| GJJ · Incrementing Integer | 输出可链接到多个随机种子的数值，默认在每次生成后按数量推进到下一段 |
| GJJ · Multifunction Calculator | 动态扩展数值输入，通过计算器按钮编辑公式，支持加减乘除和常用数学函数 |
| GJJ · Save Any Object | 动态接收多个任意输入，根据对象类型自动保存为视频、图片、文本、JSON 等 |
| GJJ · Size Math | 获取图片尺寸，执行长边缩放、旋转和比例预设计算并输出统计结果 |
| GJJ · Text Input | 可手填或透传外部输入的文本节点，前端支持 Markdown 预览模式 |
| GJJ · Text Merge | 把多路文本按顺序直接拼接并在节点内提供预览 |
| GJJ · Text Join With Delimiter | 把文本列表或多路文本按指定分隔符合并 |
| GJJ · Text Image | 把文本渲染成图片，可用于标题卡、占位图或提示词可视化 |
| GJJ · Solid Color Image | 生成指定尺寸的纯色图片和全白遮罩 |
| GJJ · Noise Image | 生成随机噪声图片，支持彩色、灰度、均匀和高斯噪声 |
| GJJ · Gradient Image | 生成线性或径向渐变图，可作为背景或 ControlNet 辅助图 |
| GJJ · Text Overlay | 将随机或指定文本绘制到透明图层上，可与背景图合成 |
| GJJ · Alpha Tools | 透明通道处理：绿幕转透明、Alpha 转遮罩、移除透明背景 |
| GJJ · Image Metadata Viewer | 读取图片文件基础信息、PNG 文本元数据、ComfyUI 工作流和 EXIF 信息 |
| GJJ · Safetensors Metadata Viewer | 直接读取 safetensors 文件头的 metadata，无需加载模型权重 |
| GJJ · Safetensors Metadata Writer | 为模型写入同名 txt 旁注和 png 封面 |

### 🖼️ 图像处理

| 节点名称 | 功能描述 |
| -------- | -------- |
| GJJ · Image Adjuster | 对图片批次执行本地调色：曝光、对比、饱和、鲜艳度、色温等 |
| GJJ · Image Comparer | 对比两路图片，使用滑动分割线查看差异 |
| GJJ · Image Collage | 把多路图片拼成横排、竖排或自动网格 |
| GJJ · Image Stacker | 把 2-4 张图片横向或纵向拼接 |
| GJJ · Image Splitter | 宫格图片分割器，拖拽分割线自动裁剪 |
| GJJ · Image Grid Splitter | 把图片按网格切成最多 9 块，适合局部处理后重组 |
| GJJ · Image Grid Reassembler | 把网格图片块贴回原图尺寸 |
| GJJ · Multi Image Loader | 一次选择多张 input 目录图片，同步扩展图片输出接口 |
| GJJ · Load Image With Alpha | 加载图片保留 RGBA 并输出 alpha 遮罩 |
| GJJ · Batch Watermark Remover | 批量去除水印，借鉴 Flux2 Klein 参考图重绘思路 |
| GJJ · Inpaint Crop | 根据遮罩自动裁出局部重绘区域，零依赖 stitcher |
| GJJ · Inpaint Stitch | 把局部重绘裁切输出的重绘图拼回原图 |
| GJJ · LaMa Inpaint | 使用本地 big-lama.pt 进行修复，适合去物和背景补全 |
| GJJ · Old Photo Restorer | 将 qwen_image_edit_2511 老照片修复工作流封装为单节点 |
| GJJ · Qwen2511 Edit Outpaint | 通用外扩图片填充编辑器 |
| GJJ · Ultimate Architecture Upscaler | 超分、建筑细节增强、分块重绘与接缝修复整合 |
| GJJ · Model Upscaler | 使用 upscale_models 中的单图超分模型放大图像 |
| GJJ · Seed VR2 Image Upscaler | 将 SeedVR2 的图像/视频放大整合成单节点 |
| GJJ · Image Analysis | 调用本地 Ollama 多模态模型分析图片内容 |

### 🎬 视频处理

| 节点名称 | 功能描述 |
| -------- | -------- |
| GJJ · Video Combine | 零依赖视频合成节点，支持 IMAGE/LATENT 序列输出多种格式 |
| GJJ · Video Segment Editor | 可视化视频分段编辑器，拖拽调整起止时间，批量裁剪输出 |
| GJJ · Video Reverse Frame | 从输入视频帧序列中提取倒数第 N 帧 |
| GJJ · Video Outpaint Pad | 把 VIDEO 拆成帧后做零依赖外扩画布预处理 |
| GJJ · Video Frames Loader | 用 FFmpeg 抽取视频帧为 IMAGE 批次 |
| GJJ · Multi Video Loader | 一次选择多个视频，按帧范围和间隔解码 |
| GJJ · Video Info | 调用 ffprobe 读取视频基本信息 |
| GJJ · FFmpeg Mux Audio Video | 用 FFmpeg 把图片帧或视频路径与音频合并为 MP4 |
| GJJ · Rife Video Interpolator | 零依赖视频插帧节点 |
| GJJ · Flash VSR Video Upscaler | 综合 FlashVSR 与 FlashVSR Ultra-Fast 的零依赖视频超分 |
| GJJ · LTX23 Image To Video | LTX-2.3 图生/文生视频节点 |
| GJJ · LTX23 Image To Video Multi Ref | LTX-2.3 多图参考器 |
| GJJ · LTX23 First Last Outfit | LTX-2.3 首尾帧变装转场一体化节点 |
| GJJ · LTX First Last Frame | 为 LTX 视频潜空间添加首帧和尾帧引导 |
| GJJ · Wan22 First Last Video | Wan2.2 首尾帧生视频节点 |
| GJJ · Wan22 Rapid AIO Mega | Wan2.2 Rapid-AIO-Mega 一站式节点 |
| GJJ · Local Lip Sync | 零 API 口型同步节点 |
| Latent Sync | 通过音频同步视频唇形 |

### 🎵 音频处理

| 节点名称 | 功能描述 |
| -------- | -------- |
| GJJ · Audio Ace Music Generator | Audio ACE 1.5 音乐生成节点 |
| GJJ · Cosy Voice3 Generator | CosyVoice3 一体式语音克隆器 |
| GJJ · Fish Audio S2 Generator | Fish Audio S2 一体式 TTS |
| GJJ · Long Cat Audio Di T TTS | LongCat AudioDiT 一体式语音克隆与多说话人 TTS |
| GJJ · Audio Segment Editor | 音频分段编辑器，可视化编辑起止时间 |
| GJJ · Audio Beat Analyzer | 轻量音频节拍分析，输出 BPM 和节拍时间 JSON |
| GJJ · Audio Crop | 按时间裁剪 AUDIO |
| GJJ · Audio Tools | 音频处理工具集 |
| GJJ · Qwen3 ASR Text Formats | Qwen3-ASR 一体式语音识别与强制对齐 |

### 📝 提示词与文本

| 节点名称 | 功能描述 |
| -------- | -------- |
| GJJ · Prompt Generation | 调用本地 Ollama 模型生成提示词 |
| GJJ · Prompt Preset Studio | 整合风格、证件照、主体与多角度提示词 |
| GJJ · Prompt Size Preset | 整合提示词输入、尺寸预设与空 Latent 生成 |
| GJJ · Prompt Weight | 给提示词片段添加常见权重语法 |
| GJJ · Prompt Combination | 把提示词做排列组合或随机抽样 |
| GJJ · 提示词分组切换 | 在同一工作流里维护多组提示词文本 |
| GJJ · Embedding Prompt | 生成 embedding 提示词片段并可附加权重 |
| GJJ · Csv Tsv Row Iterator | 读取 CSV/TSV 文本按行分列输出 |
| GJJ · Translation | 调用本地 Ollama 进行中英提示词翻译 |
| GJJ · Ollama Directory Captioner | 通过浏览器选择目录，调用 Ollama 生成打标文件 |
| GJJ · Prompt Relay Timeline | 带可视化时间轴编辑器的 Prompt Relay 编码节点 |
| GJJ · Prompt Relay Encode | 将全局提示词和局部提示词编码为视频时序控制条件 |
| GJJ · Batch Text Segmenter | 零依赖批量 SAM3 文本分割器 |

### 🧠 模型加载与管理

| 节点名称 | 功能描述 |
| -------- | -------- |
| GJJ · Model Bundle Loader | 一次性加载 UNET、CLIP、VAE |
| GJJ · Flux1 Dual CLIP Loader | 为 Flux 1 系列一次性加载 UNET、双 CLIP 和 VAE |
| GJJ · Checkpoint Direct Generator | 单节点加载底模 checkpoint 直接出图 |
| GJJ · Multi Lora Chain | 按配置顺序串联加载多组 LoRA |
| GJJ · Lora Chain Config | 输出多组 LoRA 串联配置 |
| GJJ · Lora Effect Tester | 按过滤后的 LoRA 列表和多选强度逐项输出 |
| GJJ · Model Family Preset Table | 模型族预设节点 |
| GJJ · Brush Net Inpaint | 综合 BrushNet、PowerPaint、RAUNet 的正向填充 |

### ✂️ 分割与抠图

| 节点名称 | 功能描述 |
| -------- | -------- |
| GJJ · SAM3 Point Collector | 在节点面板直接点选前景与背景点位 |
| GJJ · SAM3 BBox Collector | 在节点面板直接框选正向或反向区域 |
| GJJ · SAM3 Point Segmenter | SAM3 点选分割器 |
| GJJ · SAM3 Text Segmenter | SAM3 文本分割器，输入自然语言返回遮罩 |
| GJJ · SEM2 Point Segmenter | SEM2 点选分割、遮罩膨胀、块化预览收成单节点 |
| GJJ · Comprehensive Matting | 综合抠图：RMBG2、BiRefNet、BEN2、Inspyrenet 等 |
| GJJ · Face Detailer | 单节点版 FaceDetailer |
| GJJ · BBox Detector Loader | 加载人脸或目标检测模型 |
| GJJ · Detect SEGS | 使用 BBox 检测器识别目标区域 |
| GJJ · Make SAM Mask | 基于 SAM 模型生成精细局部遮罩 |

### 🎭 遮罩与区域

| 节点名称 | 功能描述 |
| -------- | -------- |
| GJJ · Mask Grow Blur | 对遮罩执行扩张、收缩与模糊 |
| GJJ · Mask Merge | 合并最多八路遮罩 |
| GJJ · Mask Outline | 从遮罩生成内外轮廓线 |
| GJJ · Area To Mask | 按画布尺寸和矩形区域生成遮罩 |
| GJJ · Region Box | 创建可传递的矩形区域 |
| GJJ · Region Crop | 按区域数据从图片中裁切局部图像 |
| GJJ · Region Composite | 把前景图片按指定区域合成到底图 |
| GJJ · Grid Region Selector | 把画布切成行列网格 |
| GJJ · Points Editor | 图形化点位编辑器 |

### 🎨 生成与编辑

| 节点名称 | 功能描述 |
| -------- | -------- |
| GJJ · Control Net Preset | 内部加载 checkpoint，生成可直连 KSampler 的模型和条件 |
| GJJ · Depth Control Net Generator | depth_controlnet 工作流封装 |
| GJJ · Scribble Control Net Generator | scribble_controlnet 工作流封装 |
| GJJ · SD15 Inpaint Workflow | sd1.5_inpaint 工作流封装 |
| GJJ · Flux Fill Dev Outpaint | flux_fill_dev_outpaint 工作流封装 |
| GJJ · Redux Advanced | CLIP Vision 与 Redux 风格模型 |
| GJJ · Lazy Image Studio | 懒人图文集成一键生图 |
| GJJ · Character Multi View Studio | 主体一键多视图 |
| GJJ · Lora Face Material Generator | 批量生成 LoRA 训练素材 |
| GJJ · Mesh2Motion Explore | 零依赖 Mesh2Motion 单节点，内嵌 3D 骨骼动画编辑器 |

---

## 📁 项目结构

```
ComfyUI_GJJ_Nodes/
├── __init__.py                    # 入口：注册节点、帮助 API
├── .editorconfig                  # 编辑器配置
├── .gitignore                     # Git 忽略规则
├── README.md                      # 项目说明
├── requirements.txt               # 核心依赖
├── requirements-optional.txt      # 可选依赖
├── requirements-accelerate.txt    # 推理加速依赖
├── js/                            # 前端 JS（每个节点独立文件）
├── nodes/                         # 后端 Python（每个节点独立文件）
│   └── common_utils/              # 共享工具模块
├── locales/                       # 国际化
│   └── zh/                        # 中文语言包
├── examples/                      # 工作流 JSON 示例
├── presets/                       # 预设文件
├── utils/                         # 通用工具脚本
└── web/                           # Web 资源
```

> **注意：** 仓库中包含 `SKILL/`（开发文档）、`docs/`（使用指南）、`memory/`（开发记忆）等目录，这些目录已通过 `.gitignore` 排除，不会提交到远程仓库。如需查阅，请联系作者获取。

---

## 📖 文档

开发和架构文档存放于 `SKILL/` 目录（本地知识库，已 gitignore）：

- **SKILL_INDEX.md** — 完整文档索引，包含所有节点的架构说明和开发指南
- **GJJ_CODING_CONVENTIONS.md** — 编码规范
- **SKILL/10-node-architecture/** — 每个节点的前后端架构文档
- **SKILL/11-dev-tools/** — 开发/测试工具

使用指南：

- **docs/** — 功能使用说明（通过 `.gitignore` 排除，按需获取）
- **examples/** — 工作流 JSON 示例文件

---

## ⚠️ 许可证

本项目仅限个人学习使用，**禁止任何形式的商业用途**。

---

## 🙏 致谢

感谢 ComfyUI 社区及其所有贡献者。

---

**作者：** [guojijun](https://github.com/guojijun)
