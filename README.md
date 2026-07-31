# ComfyUI_GJJ_Nodes

<div align="center">

[![ComfyUI](https://img.shields.io/badge/ComfyUI-Custom%20Nodes-blue?logo=python)](https://github.com/comfyanonymous/ComfyUI)
[![Version](https://img.shields.io/badge/version-1.0.0-blue)](./pyproject.toml)
[![License](https://img.shields.io/badge/License-Personal%20Use%20Only-red)](./LICENSE)
[![Python](https://img.shields.io/badge/Python-3.10%2B-green?logo=python)](https://www.python.org/)
[![GitHub Stars](https://img.shields.io/github/stars/guojijun/ComfyUI_GJJ_Nodes?style=social)](https://github.com/guojijun/ComfyUI_GJJ_Nodes)

**328 个已注册 ComfyUI 自定义节点 | 图像 · 视频 · 音频 · 提示词 · 模型管理 · 工作流辅助**

</div>

---

## 📖 概述 / Overview

ComfyUI_GJJ_Nodes 是个人开发的 ComfyUI 自定义节点合集，当前源码静态注册 328 个唯一节点键，涵盖图像处理、视频生成、音频合成、提示词工程、模型管理、工作流辅助等多个方向。所有节点统一使用 `GJJ ·` 前缀，内置中文工具提示，遵循零外部依赖原则（除 `requirements.txt` 中列出的通用包外，不依赖任何第三方自定义节点包）。

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

## 🆕 近期更新

### LoRA 管理与预览

- 多 LoRA 串联面板支持读取 `presets/gjj_lora_metadata.tsv` 中的标题、触发词、推荐强度、简介和来源信息
- 自动匹配同名本地预览图，在 LoRA 行内显示缩略图，并可打开浮动详情卡查看大图与元数据
- 新增 `LoRA触发词` 输出；当前启用 LoRA 的触发词会按串联顺序自动汇总，并可广播到支持的正向提示词节点
- 优化预览缓存与元数据匹配，兼容 LoRA 子目录、扩展名差异和常见文件名写法

### LTX2.3 多功能视频生成器

- 支持单图、首尾帧、批量图片和多场景分段生成，可直接展开 `GJJ_BATCH_IMAGE` 等批量图片容器
- 新增模型测试面板，可批量选择 LTX 模型或 LoRA，固定当前随机种并逐项加入 ComfyUI 队列
- LoRA 批量测试时自动读取预设触发词并追加到正向提示词；提示词翻译可在节点工具栏中独立开启或关闭
- 测试结果统一保存到 `video/GJJ_LTX模型测试/`，文件名自动包含模型名、模型文件大小和实际耗时，便于横向比较
- 改进节点内视频预览、测试队列状态和多视频结果布局

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
pip install onnx onnxruntime-gpu -i https://pypi.tuna.tsinghua.edu.cn/simple

# Ollama 相关（统一助手、目录图片打标等）
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

🔗 **模型下载地址：** [https://pan.quark.cn/s/4b5a36d50e9c](https://pan.quark.cn/s/4b5a36d50e9c)

#### 各节点所需模型及放置路径一览

下载后将对应模型放入 `ComfyUI/models/` 下的相应子目录：

| 模型目录 | 模型文件 | 使用节点 |
| -------- | -------- | -------- |
| `models/cosyvoice/` | CosyVoice3 全套模型文件 | CosyVoice3 语音克隆 TTS |
| `models/fishaudioS2/` | Fish Audio S2 全套模型 | Fish Audio S2 语音克隆 TTS |
| `models/audiodit/` | LongCat-AudioDiT 模型 | LongCat 语音克隆 TTS |
| `models/ASR/` | Qwen3-ASR 模型 | Qwen3 语音识别与强制对齐 |
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
| `models/translation/` | opus-mt-zh-en.safetensors | 中英翻译节点（旧的 opus-mt-zh-en 多文件目录仍兼容） |
| `models/checkpoints/` | xsarchitectural_v11.ckpt 或其他 SD1.5 底模 | GJJ 涂鸦画板 / 涂鸦 ControlNet 生图 |
| `models/controlnet/SD1.5/` | control_v11p_sd15_scribble_fp16.safetensors | GJJ 涂鸦画板 / 涂鸦 ControlNet 生图 |
| `models/vae/` | vae-ft-mse-840000-ema-pruned.safetensors | GJJ 涂鸦画板 / 涂鸦 ControlNet 生图 |
| `models/upscale_models/` | ESRGAN / RealESRGAN 等超分模型 | 模型图片放大器 |
| `models/upscale_models/` | ltx-2.3-spatial-upscaler-x2 | LTX2.3 潜空间放大 |
| `models/checkpoints/` | LTX / Flux / Wan / SD 等底模 | 各生成/视频节点 |
| `models/checkpoints/` | interiordesignsuperm_v2 等 | ControlNet Preset |
| `models/checkpoints/` | ltx-2.3-22b 系列 | LTX2.3 视频生成 |
| `models/checkpoints/` | wan2.2 系列 | Wan2.2 视频生成 |
| `models/diffusion_models/` | flux-2-klein-4b-fp8.safetensors | 批量水印去除 |
| `models/diffusion_models/` | wan2.2_s2v_14B_fp8_scaled | Wan S2V 检测分支 |
| `models/text_encoders/` | gemma_3_12B_it_fp4_mixed.safetensors | LTX2.3 图片说话 |
| `models/audio_encoders/` 或 `models/wav2vec2/` | wav2vec2_large_english_fp16.safetensors | Wan S2V 音频条件编码；两个目录可互相兼容 |
| `models/loras/LTX/` | ltx-2.3-22b-distilled-lora-384 + AV-LoRA | LTX2.3 口型同步 |
| `models/vae/` | LTX23_video_vae_bf16 / LTX23_audio_vae_bf16 | LTX2.3 音视频链路 |
| `models/GJJ/wav/` | 参考音频文件（默认 .wav，兼容 .mp3） | 语音克隆各节点（参考音色） |
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

## 📋 完整节点清单 / Complete Node List

> 当前源码静态注册 **328 个唯一节点键**。部分节点依赖可选组件；缺少对应依赖时，ComfyUI 会跳过该节点模块，其余节点仍可正常加载。

> 节点显示名称由加载器统一添加 `GJJ ·` 前缀。下表按主要用途归类；跨领域节点只列在最相关的分类中。

<details>
<summary><strong>🔧 工作流辅助与其他（24）</strong></summary>

| 节点名称 | 功能描述 |
| --- | --- |
| GJJ · Differential Diffusion | Differential Diffusion 节点 |
| GJJ · ⏱️ 媒体时长 | 输入 VIDEO 或 AUDIO，输出时长（秒）。 |
| GJJ · ⚡ Latent 智能保存 | GJJ 零依赖智能 Latent 保存节点：输入路径时写硬盘；输入键值时优先写显存缓存，显存不可用时写内存缓存。 |
| GJJ · ⚡ Latent 智能读取 | GJJ 零依赖智能 Latent 读取节点：输入路径时读硬盘；输入键值时先读显存缓存，再读内存缓存。 |
| GJJ · 田字格对齐 (Alt+A) | Tian Align 节点 |
| GJJ · 🌐 360全景浏览器 | 360 度全景图片浏览与截图节点：支持路径或 IMAGE 输入，前端可拖拽视角、滚轮缩放、框选截图，并内置模型放大输出。 |
| GJJ · 🌐 Opus-MT中英翻译器 🌍 | Opus MTZh En Translation 节点 |
| GJJ · 🏛️ 建筑装饰终极放大器 | 将基础超分、建筑装饰细节增强提示词、Ultimate 分块重绘与接缝修复整合成单节点放大流程。 |
| GJJ · 👀 任意对象预览器 | 动态接收任意类型输入的统一预览节点。 |
| GJJ · 💾 Latent 保存到绝对路径 | GJJ 零依赖 Latent 保存节点：按绝对路径保存 .latent，同名文件直接覆盖。 |
| GJJ · 💾 保存任意对象 | 动态接收多个任意输入，根据对象类型自动保存为视频、图片、文本、JSON、Tensor、音频或对象摘要。 |
| GJJ · 📁 内置目录浏览器 | 零依赖目录浏览器：扫描任意本地目录，按过滤与排序结果逐个输出文件；可按文件类型输出 IMAGE/AUDIO/VIDEO/文本，也可只输出路径。 |
| GJJ · 📂 Latent 从绝对路径读取 | GJJ 零依赖 Latent 读取节点：按绝对路径读取 .latent；文件不存在时输出空对象。 |
| GJJ · 📈 Sigmas编辑器 | 可视化自定义Sigmas曲线编辑器。以0到1的数字点组成图表，可增减点、改变曲线方式。 |
| GJJ · 📍 点位编辑器 | 图形化点位编辑器。可在面板上添加前景点、背景点和框选区域，输出坐标、边框、边框遮罩和裁切图。 |
| GJJ · 📐 尺寸获取与运算 | 获取一张或多张图片尺寸，执行长边缩放、短边缩放、旋转和比例预设计算，并输出尺寸统计结果。 |
| GJJ · 📐 节点排列器 | 自动排列和优化 ComfyUI 工作流中的节点布局，支持多种拓扑排序模式。实际排列逻辑在前端 JavaScript 中执行。 |
| GJJ · 🔁 序列自动执行器 | 根据当前数值和总数量，在前端执行完成后自动继续排队，直到序列结束。 |
| GJJ · 🔍 节点定位搜索 | 通过搜索关键词快速定位当前工作流中的指定节点并框选。支持节点类型、标题、ID搜索。 |
| GJJ · 🔤 多功能替换 | 对任意对象中的文本内容执行多组查找替换；字符串、列表、元组、字典会递归处理，非文本对象原样透传。 |
| GJJ · 🕰️ 一键批量修复老照片 | Old Photo Restorer 节点 |
| GJJ · 🖥️ 内存显存管理 | 内存显存管理工具：顶部开关用于数据流经过节点时自动清理；下方按钮直接调用本节点后端动作，不会执行整个工作流。 |
| GJJ · 🧍 NLF姿态一体 | 把 LoadNLFModel、NLFPredict、GJJ_DWPoseEstimator、ConvertOpenPoseKeypointsToDWPose、OnnxDetectionModelLoader、PoseDetectionVit… |
| GJJ · 🧮 多功能计算器 | 动态扩展输入，通过计算器按钮编辑公式，支持数字计算、字符串拼接、自动结果类型，以及用 {输入显示名} 引用已连接输入。 |

</details>

<details>
<summary><strong>🔀 逻辑、路由与流程控制（16）</strong></summary>

| 节点名称 | 功能描述 |
| --- | --- |
| GJJ · . 🟦 布尔切换器（是否判断） | Bool Switch 节点 |
| GJJ · ⚙️ 模板参数输入器 | 通过模板文本自动生成参数输入框和输出口。支持格式：帧率 (frame_rate) [INT,FLOAT]：24.0 # 浮点；也兼容 帧率：24、宽度：832、模式：图生 这类未写括号的常用参数。 |
| GJJ · 📈 样条曲线编辑器 | 零依赖样条曲线编辑器。可在节点面板绘制一条或多条曲线，输出采样坐标、按 Y 值生成的遮罩批次，以及可用于权重调度的浮点序列。 |
| GJJ · 📦 任意批量合并（输出单对象） | 零依赖复刻 easy batchAnything：把多路输入合成一个批量/拼接结果；IMAGE 和 LATENT 会拼 batch，普通对象按原类型逻辑合并。 |
| GJJ · 🔀 Impact条件分支 | 零依赖复刻 ImpactConditionalBranch：按布尔条件只执行并输出被选中的任意输入。 |
| GJJ · 🔀 任意切换器 | 按输入顺序返回第一个非空值的动态切换器，支持任意类型并会自动增减输入插槽。 |
| GJJ · 🔀 节点筛选路由 | 按节点名称关键词筛选当前工作流中的节点，便于前端面板快速定位和启用/禁用操作。 |
| GJJ · 🔁 For循环开始 | For 循环开始节点。默认只显示一组初始值/值输出；值 1 连线后自动扩展值 2。 |
| GJJ · 🔁 高级透传路由 | 高级透传路由：支持任意类型输入输出。默认一组输入/输出，输入连接后输出会跟随输入类型与标签，并自动扩展下一组。 |
| GJJ · 🔎 任意对象索引输出 | Any Index Output 节点 |
| GJJ · 🔘 模板布尔参数 | 模板布尔参数：模板首行可写 #按钮文字，其余行用 名称（key）：真值\|假值 动态生成输出口。 |
| GJJ · 🔚 For循环结束 | For 循环结束节点。接收本轮更新后的 value，并决定是否展开下一轮。 |
| GJJ · 🚦 条件透传 | 条件透传任意对象。前端可用 ⚡ 选择 GJJ_TemplateParams 或 GJJ_SETNODE 的布尔变量；变量为真时透传，为假时提交前临时旁路下游链路。 |
| GJJ · 🧩 模板设置变量 | 根据模板设置动态生成变量输入小圆点，并作为 GJJ 全局变量供变量读取节点使用。格式：中文标签（变量Key）[接口类型]：默认值，例如：宽度（Width）[INT]：640。默认隐藏右侧输出口；需要直接连线时可在节点工具栏点击 🔌 显示输出… |
| GJJ · 🧵 队列循环开始 | 队列循环开始：读取上一轮反馈帧作为本轮输入，配合队列循环结束节点自动排队执行下一轮。 |
| GJJ · 🧷 队列循环结束 | 队列循环结束：保存本轮尾帧，累计输出帧，并在前端执行成功后自动排队下一轮。 |

</details>

<details>
<summary><strong>🖼️ 图像处理（36）</strong></summary>

| 节点名称 | 功能描述 |
| --- | --- |
| GJJ · ℹ️ 图片元数据查看 | 读取图片文件的基础信息、PNG 文本元数据、ComfyUI 工作流和 EXIF 信息。 |
| GJJ · ✂️ 图片可视化区域裁切 | 按 GJJ 区域数据从图片中裁切局部图像。 |
| GJJ · ✂️ 批次尺寸裁剪 | 按批次裁剪图片或视频帧序列：多路统一目标尺寸，每一路独立按短边等比缩放，再居中裁剪长边。 |
| GJJ · ✨ VFX图像效果 | 常用本地图像 VFX：像素化、抖动、故障偏移、半调。 |
| GJJ · ➕ 多图混合相加 | 复刻 KJNodes 的 Image Add Multi：按输入数量把多张 IMAGE 逐张 add/subtract/multiply/difference 混合。 |
| GJJ · 跨视角深度扭曲 | 根据单目深度把图像或视频批次重投影到新的相机视角，洋红色代表遮挡空洞。 |
| GJJ · 🎞️ 批量图片范围截取 | 从图片或遮罩批量中截取指定范围；复刻 KJNodes 的 GetImageRangeFromBatch，零外部依赖。 |
| GJJ · 🎞️ 透明动画导出 | 零依赖复刻 comfyui_fill-nodes 的 FLSaveRGBAAnimatedWebP：输入 RGB 序列和 Alpha 序列，合成为真正的 RGBA 帧后导出 APNG、animated webp、GIF、MOV(ProRes… |
| GJJ · 🎨 颜色匹配 | 零依赖颜色匹配：复刻 KJ ColorMatch 的接口，用本地 torch 实现直方图匹配、Reinhard 和协方差颜色迁移。 |
| GJJ · 🏷️ WD图片标签器 | WDTimm Tagger 节点 |
| GJJ · 🏷️ 工作流标题 | 仅用于画布显示的工作流标题；保留一个默认标题内容输入口，标题宽度跟随节点面板宽度，样式偏好会保存到 presets/gjj_user_settings.json。 |
| GJJ · 🏷️ 本机Ollama目录图片打标器 | 通过浏览器选择任意本地目录，调用本地 Ollama 多模态模型为目录中的图片生成同名 txt 打标文件。适合后续 LoRA 数据预标注。 |
| GJJ · 💙Llama🧠图片反推提示词推理 | 零第三方自定义节点依赖的单节点 LLAMA 助手：从 models/LLM 选择主模型和 mmproj，支持文本、图片、逐帧与视频抽帧推理。 |
| GJJ · 📐 区域框 | 创建一个可传递的矩形区域，并同步输出该区域遮罩。 |
| GJJ · 📐 获取图像尺寸 | 获取图片、批量图片或官方 VIDEO 的首帧宽度和高度。 |
| GJJ · 🔲 图像网格切分 | 把图片按网格切成最多 9 块，可带少量重叠，适合局部处理后重组。 |
| GJJ · 🔲 网格区域选择 | 把画布切成行列网格，按序号输出其中一个区域和完整区域列表 JSON。 |
| GJJ · 🕳️ Lotus深度图 | Lotus Depth Map 节点 |
| GJJ · 🖊️ Canny边缘检测 | 单节点 Canny 边缘检测：有 OpenCV 时自动走快速 Canny；没有 OpenCV 时走 PyTorch 原生零依赖实现，并支持实时进度与间隔预览。 |
| GJJ · 🖌 涂鸦画板 | 内嵌涂鸦画板。可直接在 ComfyUI 节点中画草图、线稿，并内置 Scribble ControlNet 一键原地生图。 |
| GJJ · 🖼️ 千问CLIP图像编码 | Qwen Image Edit Plus 条件编码面板：正负提示词统一编辑，支持外部正向提示词、Opus-MT 中英翻译、条件零化、译后卸载、FluxKontext 推荐分辨率缩放和多参考潜在方法。单图按原生 TextEncodeQwenI… |
| GJJ · 🖼️ 懒人图文集成一键生图 | 懒人图文集成一键生图：支持文生图、图生图，以及多图参考编辑。节点会根据所选 UNET 主关键词自动推荐匹配的文本编码器、VAE、加速 LoRA、NSFW LoRA 与常用采样参数。 |
| GJJ · 🙂 姿态人脸裁剪 | 根据 POSE_KEYPOINT 的人脸关键点生成脸部遮罩，并按遮罩批量裁剪缩放图片。 |
| GJJ · 🧊 透明图片加载 | 加载 input 目录图片，保留 RGBA 并输出 alpha 遮罩。 |
| GJJ · 🧍 人景融合动作版 | Scene Fusion Prep 节点 |
| GJJ · 🧩 VAE 分块解码 | 零外部插件依赖的 VAE 分块解码节点，兼容 VAEUtils_VAEDecodeTiled 的输入和处理行为。 |
| GJJ · 🧩 去背景拼接 | Remove Bg Stitch 节点 |
| GJJ · 🧩 图像网格重组 | 把网格图片块贴回原图尺寸，支持指定替换块与自动缩放。 |
| GJJ · 🧩 图片批次重叠扩展 | 按 KJNodes 的 Image Batch Extend With Overlap 复刻图像批次续接逻辑，用于视频续帧时截取起始帧并把新旧批次按重叠帧合并。 |
| GJJ · 🧩 零依赖图片转SVG | 零依赖图片转 SVG 单节点：可选接入 GJJ_BATCH_IMAGE/IMAGE，也可从顶部按钮上传一个或多个文件；输出 SVG 字符串并在节点内预览。 |
| GJJ · 🧩图片分层PSD图层（Qwen Layered） | Qwen-Image-Layered 图文生图单节点：内部完成模型加载、提示词编码、文生/图生分支、切层解码和零依赖 PSD 写出。 |
| GJJ · 🧪 透明通道工具 | 透明通道处理：绿幕转透明、Alpha转遮罩、移除透明背景。 |
| GJJ · 🧱 区域图层合成 | 把前景图片按指定区域合成到底图上，支持适配方式、透明度和可选遮罩。 |
| GJJ · 🧺 图片批量打包到序列 | 零依赖图片/视频帧批量打包：用预设尺寸和画幅方向统一缩放图片或 VIDEO 帧，也可通过前端 ⚙️ 自定义尺寸 / 比例；可选前置黑帧或白帧。 |
| GJJ · 🧼 批量去水印 | 批量去除水印单节点。借鉴 Flux2 Klein 参考图重绘思路，不依赖 Florence、KJ、CropStitch、WAS 等第三方节点；输入和主输出兼容 GJJ 批量图片与普通 IMAGE 批量。 |
| GJJ · 🪄 图片实时对比处理 | 单节点零依赖图片实时对比处理器。节点面板可打开图片、按分类复选处理项、用滑块调参，并实时显示原图/结果对比。 |

</details>

<details>
<summary><strong>🎨 图像生成与编辑（20）</strong></summary>

| 节点名称 | 功能描述 |
| --- | --- |
| GJJ · Krea2 控制单节点 | 把 Krea2 控制 LoRA 加载、控制图编码和模型应用合并为一个零第三方依赖 GJJ 单节点。 |
| GJJ · 千问2512局部重绘画布 | 仿 GJJ_DoodleCanvas 的交互式单节点局部重绘：节点内载图、画遮罩，按 Qwen Image 2512 + InstantX Inpainting ControlNet 工作流直接生成结果图。 |
| GJJ · 🌈 渐变图生成 | 生成线性或径向渐变图，可作为背景、遮罩参考或 ControlNet 辅助图。 |
| GJJ · 🌐 360全景生成器 | 单节点 360 全景生成：无图时文生 360，有图时图生 360，并自动做中缝修复。 |
| GJJ · 🌫️ 噪声图生成 | 生成随机噪声图片，支持彩色、灰度、均匀和高斯噪声。 |
| GJJ · 🎨 纯色图生成 | 生成指定尺寸的纯色图片和全白遮罩。 |
| GJJ · 🎬 分镜宫格生成器 | 分镜宫格生成器：复用懒人图文集成一键生图流程，正向提示词按场景行首标记、空行或 --- 分段生成，并智能拼接为宫格图。 |
| GJJ · 🔤 文字图生成 | 把文本渲染成图片，可用于标题卡、占位图、字幕图或提示词可视化。 |
| GJJ · 🔳 可视化宫格生成（F2K） | 通用可视化宫格节点。支持导入整张参考板或接入 GJJ_BATCH_IMAGE/IMAGE，按黑色分割线自动切格，2 像素黑线重拼，输出 32 倍数尺寸最终宫格图。 |
| GJJ · 🕳️ 米达斯深度图预处理器 | 复刻米达斯深度图预处理器的 GJJ 零外部自定义节点版本。节点内加载米达斯深度模型，把图片、批量图片或 VIDEO 逐帧转换为深度视频帧序列，并使用 GJJ 公共临时文件缓存生成预览。 |
| GJJ · 🖌️ BrushNet补图 | 综合迁移 BrushNet、PowerPaint、RAUNet、裁切与融合补图功能；模型会在 models 下模糊搜索。 |
| GJJ · 🖼️ 批量扩图工具 | 批量扩图工具。支持 SD1.5 Inpainting、Flux2 Klein、Qwen Image Edit、Flux Fill Dev；支持像素扩图和目标尺寸扩图。 |
| GJJ · 🧊 TripoSplat一键生成 | 单图或批量图片生成 TripoSplat 高斯泼溅，并同时输出 SPZ 文件对象和 GLB 网格。模型按去扩展名、去量化标记规则在 models 子目录中搜索。 |
| GJJ · 🧠 Redux高级条件器 | 内部加载 CLIP Vision 与 Redux 风格模型，将图像风格特征编码后拼接到 conditioning，并支持遮罩与自动裁切。 |
| GJJ · 🧩 多宫格参考图生成器 | 多宫格参考图生成器。支持正向提示词按空行或 --- 分割，多图/视频输入智能拼图，Flux2/f2k 文生图与图生图生成，并输出黑色边框间隔宫格。 |
| GJJ · 🧭 轨迹JSON生成 | 图形化编辑二维轨迹，并输出可直接连接其它节点的 Trajectory JSON 字符串。 |
| GJJ · 🧵 局部重绘拼回 | 把 GJJ 局部重绘裁切输出的重绘图拼回原图。 |
| GJJ · 🩹 LaMa图像修复 | 使用本地 big-lama.pt 对图像中被遮罩标记的区域进行修复，默认模型位置为 models/ckpts/big-lama.pt，适合去物、补边和背景补全。 |
| GJJ · 🩹 SD1.5局部重绘工作流 | 把 sd1.5_inpaint 工作流收口成单节点，内部自动完成 checkpoint 加载、提示词编码、遮罩 VAE 编码、采样和解码。 |
| GJJ · 🩹 应用ControlNet（阿里妈妈） | 合并 ControlNet 模型加载与官方阿里妈妈局部重绘 ControlNet 应用；VAE 与遮罩为可选输入，接入遮罩时按 inpaint ControlNet 逻辑处理，未接入时按普通 ControlNet 应用。 |

</details>

<details>
<summary><strong>✂️ 分割、抠图与遮罩（17）</strong></summary>

| 节点名称 | 功能描述 |
| --- | --- |
| GJJ · ▣ 区域转遮罩 | 按画布尺寸和矩形区域生成遮罩，也可直接接收 GJJ 区域数据。 |
| GJJ · ✂️ SAM3点选分割器 | SAM3 点选分割器。内部自动加载 models/sam3 下的模型，支持前景点、背景点和可选框提示。 |
| GJJ · ✂️批量文本分割器抠图(SAM3) | Batch Text Segmenter 节点 |
| GJJ · 遮罩填洞并填充图像 | 零依赖单节点：先填充遮罩内部闭合空洞，再按 neutral 方式填充图片中的遮罩区域。 |
| GJJ · 🎭 图片转遮罩 | 🎭 将图像转换为遮罩。支持亮度、Alpha通道及RGB单通道转换。 |
| GJJ · 🎭 遮罩描边 | 从遮罩生成内外轮廓线，可用于局部重绘边缘、描边控制或可视化区域边界。 |
| GJJ · 🎭 重复遮罩 | 重复遮罩批次。复刻 Video Helper Suite 的 RepeatMasks / VHS_DuplicateMasks 行为，不依赖 Video Helper Suite。 |
| GJJ · 🎯 点选遮罩队列 | SAM2 Point Mask Editor 节点 |
| GJJ · 📄 文本段落分割 | 零依赖文本段落分割器：按空行、序号、标题、数字、地址或动态端口拆分文本，并输出段落数量与指定段落文本。 |
| GJJ · 📍 SAM3点位收集器 | 在节点面板直接点选前景与背景点位，输出给 SAM3 点选分割器使用。左键添加绿色前景点，右键添加红色背景点。 |
| GJJ · 📝 SAM3文本分割器 | SAM3 文本分割器。输入自然语言描述，例如“人物”“红色汽车”，节点会尝试返回所有匹配目标的遮罩。 |
| GJJ · 🔷 形状遮罩生成 | 零额外依赖形状遮罩生成：复刻 KJNodes CreateShapeMask，可生成圆形、方形、三角形遮罩批次，并按帧递增或递减尺寸。 |
| GJJ · 🖋 钢笔绘制遮罩 | 零依赖钢笔绘制遮罩。支持上游图片、面板打开图片、钢笔贝兹曲线和魔棒选区。 |
| GJJ · 🖼️ SDMatte精细抠图 | 使用 SDMatte 模型按输入遮罩执行精细抠图，输出透明图、遮罩和遮罩预览图。 |
| GJJ · 🟦 SAM3框选收集器 | 在节点面板直接框选正向或反向区域，输出给 SAM3 点选分割器或文本分割器使用。左键拖拽添加正向框，右键拖拽添加反向框。 |
| GJJ · 🧬 遮罩合并 | 合并最多八路遮罩，支持相加、最大值、相交和扣除。 |
| GJJ · 🪶 遮罩扩张羽化 | 对遮罩执行扩张、收缩与模糊，常用于重绘遮罩预处理。 |

</details>

<details>
<summary><strong>🎬 视频生成与模型（75）</strong></summary>

| 节点名称 | 功能描述 |
| --- | --- |
| GJJ · ⚙ VAE 加载器(LTX) | VAELoader 节点 |
| GJJ · ⚙️ SD3采样算法(Wan) | 将“采样算法（SD3）”和“K采样器（高级）”合并到一个紧凑面板。先对模型应用 SD3 shift 采样算法，再执行高级 KSampler。 |
| GJJ · ⚙️ WanVideo编译设置 | GJJ 零依赖复刻 WanVideoTorchCompileSettings：生成 WanVideo 模型加载器可读取的 torch.compile 参数字典。节点只输出配置，不调用 torch.compile。 |
| GJJ · ✂️ LTX导演Guide裁剪 | 移除 LTX Director Guide 为关键帧引导追加的 Latent 帧，并清理条件中的 Guide 元数据。 |
| GJJ · 🌗 LTXV HDR解码后处理 | GJJ 零外部节点依赖版 LTXVHDR Decode Postprocess：解压 LogC3 HDR、生成 SDR 预览，并可尽力保存 EXR。OpenCV EXR 不可用时不会报错中断。 |
| GJJ · 🎙️ LongCat数字人Whisper嵌入 | LongCat Avatar 1.5 Whisper 音频嵌入节点：把 Whisper-large-v3 编码成数字人驱动需要的 MULTITALK_EMBEDS。 |
| GJJ · 🎛️ LTXV多模态引导器 | 零依赖移植 ComfyUI-LTXVideo 的 MultimodalGuider：对 LTXV 音视频 latent 分别执行 CFG、STG、跨模态和跳步引导。 |
| GJJ · 🎛️ LTXV引导参数 | 零依赖移植 ComfyUI-LTXVideo 的 GuiderParameters：为 LTXV 多模态引导器生成视频或音频引导参数。 |
| GJJ · 🎞️ LTXV分块VAE解码 | 零依赖移植 LTXVTiledVAEDecode：对 LTXV latent 做空间分块 VAE 解码，并用重叠权重融合接缝。 |
| GJJ · 🎞️ LTXV图生视频条件 | 零依赖移植 LTXVImgToVideoConditionOnly：把参考图像编码进现有视频 latent 的开头帧，并生成控制强度的 noise_mask。 |
| GJJ · 🎞️ LTX视频采样器 | 把 RandomNoise、CFGGuider、KSamplerSelect、ManualSigmas、LTXVConcatAVLatent、SamplerCustomAdvanced 合并成一个 LTX 视频采样器。 |
| GJJ · 🎞️ WanVideo 视频采样器 v2 | GJJ WanVideo 视频采样器 v2：固定经典插槽版，调用 GJJ 内置 vendored WanVideoWrapper 核心 runtime。 |
| GJJ · 🎞️ WanVideo 解码 | GJJ 零依赖复刻 WanVideoDecode：按 WanVideoWrapper 原版逻辑把 WanVideo latent 解码为 IMAGE。 |
| GJJ · 🎞️ WanVideo编码 | 把 IMAGE 帧序列编码为 WanVideo latent。等价复刻 WanVideoWrapper 的 WanVideo Encode，使用 GJJ 内置 vendor runtime。 |
| GJJ · 🎤 MultiTalk音频条件 | MultiTalk / InfiniteTalk 音频条件节点：内部从 models/wav2vec2 加载本地 Wav2Vec2，无需额外连接 Wav2VecModelLoader。 |
| GJJ · 🎤 Wan MultiTalk长视频I2V | WanVideo MultiTalk / InfiniteTalk 长视频图生视频条件节点。内部调用 GJJ vendor 中的 WanVideoImageToVideoMultiTalk，不依赖外部 WanVideoWrapper 插件。 |
| GJJ · 🎥 Wan相机图生视频 | 把 Wan 相机嵌入和 Wan 相机图生视频编码合并到一个 GJJ 零依赖节点。 |
| GJJ · 🎥 Wan相机控制合成 | 将 ADE_CameraPoseCombo、WanVideoFunCameraEmbeds、CameraPoseVisualizer 合并为一个 GJJ 零依赖单节点：生成 CameraCtrl 姿态、Wan FunCamera 条件，并在… |
| GJJ · 🎧 LTXV音频参考Token | 为 LTXV 音频/口型流程把 audio_latent 转成 ref_audio tokens 写入 conditioning，并输出冻结音频 latent。 |
| GJJ · 🎬 LongCat图文生视频 | 使用已加载的 LongCat-Video 管线进行文生视频或图生视频。 |
| GJJ · 🎬 LTX多图引导 | 复刻 KJNodes 的 LTXVAddGuideMulti：为 LTX 视频 latent 在多个帧位置插入多张引导图像。 |
| GJJ · 🎬 LTX导演时间线 | GJJ 版 LTX Director 2.0.2 可视化时间线编辑器，支持图像、视频、音频、IC-LoRA Motion Guide、Prompt Relay 分段注意力和 Retake 局部重做。 |
| GJJ · 🎬 SCAIL-2 Infinity 长视频单节点 | 零依赖复刻 SCAIL-2 Infinity：在单个节点内部循环构建 SCAIL 条件、采样、VAE 解码与重叠帧拼接，用固定窗口生成由姿态视频长度驱动的长视频。 |
| GJJ · 🎬 SCAIL2 超长视频导演台单节点(一键生成) | 把 SCAIL2 超长视频极简工作流收敛为单节点：两个可选输入口，内部完成视频读取、参考图读取、模型加载、SAM3 彩色遮罩、长视频采样和视频合成。 |
| GJJ · 🎬 Wan SCAIL 视频条件 | 零依赖复刻官方 WanSCAILToVideo：创建 Wan SCAIL/SCAIL-2 视频 latent，并处理姿态视频、彩色身份遮罩、参考图、CLIP视觉条件和上一段帧/Latent续段锚定。 |
| GJJ · 🎬 WanVideo VAE 加载器 | 加载 WanVideo VAE 模型，支持自动检测模型类型（标准/38层/轻量） |
| GJJ · 🎬 WanVideo 模型加载器 | 加载 WanVideo 扩散模型，支持多种精度和量化选项。 |
| GJJ · 🎬 WanVideo双路LoRA | WanVideo High/Low 双路 LoRA 节点。面板内可扩充多组 LoRA 对，High 输入只输出 High 模型，Low 输入只输出 Low 模型。 |
| GJJ · 🎬 Wan三模式视频条件 | 将 EmptyHunyuanLatentVideo、WanImageToVideo、WanFirstLastFrameToVideo 合并为一个 GJJ 零依赖三模式条件节点。面板可在文生视频、图生视频、首尾帧之间切换，并自动隐藏当前模式不… |
| GJJ · 🎬 Wan多合一视频生成器(NSFW) | 将 Wan2.2_Rapid-AIO-Mega 工作流封装为 GJJ 零依赖本地节点。未接图走 T2V，接 1 张图走 I2V，接 2 张图走首尾帧，多张图会按相邻图片自动串接生成整段帧序列。 |
| GJJ · 🎬 Wan空图像条件 | WanVideo T2V 空图像条件的 GJJ 零依赖节点。用于没有参考图时给 WanVideo Sampler 提供 target_shape，也可透传控制条件或首段 latent。 |
| GJJ · 🎬 多帧引导(LTX) | LTX 多参考帧引导。参考图输入由前端动态扩充，num_images 不显示；作用帧和强度使用紧凑中文界面配置；正/反条件可不接；错误打印后透传继续。 |
| GJJ · 🎬多功能视频生成器(LTX2.3) 🧡 | LTX-2.3 清爽版图文/音频视频节点：无输入=T2V；一张图片=I2V；有音频=S2V；音频+图片=数字人；两张图片=首尾帧；多张图片=多图参考；接入 MTV 人声分段列表时，按索引将每段音频与图片队列中的一张图配对生成并合并。 |
| GJJ · 🎬多功能视频生成器(WAN2.2) 🧡 | 将 Wan2.2 视频工作流封装成零外部依赖单节点：未接图走文生视频，1 张图走图生视频，2 张图走首尾帧，多张图按相邻图片循环首尾帧分段生成。 |
| GJJ · 🎭 LongCat数字人生成 | Long Cat Avatar Generator 节点 |
| GJJ · 🎭 Wan IS2V 双说话人 | 零依赖单节点复刻 WanIS2VDualSpeaker：为 Wan 2.2 I2V+S2V graft 模型构建双说话人唇同步条件。 |
| GJJ · 🎭 WanAnimate条件编码 | WanVideo Animate 条件编码的 GJJ 零依赖节点。内部调用 GJJ vendor 中的 WanVideoAnimateEmbeds，不依赖外部 ComfyUI-WanVideoWrapper 插件。 |
| GJJ · 🎮 万相视频控制网（kijai流） | GJJ 零依赖合并版万相视频控制网：节点内从 models/controlnet 搜索并加载 wan2.2-ti2v-5b-controlnet，再把控制帧写入万相视频模型的控制参数。 |
| GJJ · 🎯🗣️ Bernini说话人分段对口型AIO | 零依赖 Bernini 对口型：输入源视频和合成音频；有时间轴时按说话人逐段生成，没有时间轴时按单人整段生成，最后贴回并输出带完整音频的视频。 |
| GJJ · 🎯🧩 SAM3跟踪彩色遮罩一体机 | SAM3 SCAIL2 Track Mask AIO 节点 |
| GJJ · 🏂 可视化运动轨迹（WanMove） | 网站式 WanMove 轨迹可视化生成器。可拖拽起点、终点和贝塞尔控制点，输出轨迹 JSON 与 TRACKS。 |
| GJJ · 🐱 LongCat数字人加载器 | Long Cat Avatar Loader 节点 |
| GJJ · 🐱 LongCat数字人续帧条件 | LongCat Avatar 续帧条件节点：按当前窗口切片音频、复用上一段 latent，并可加入参考 latent 保持数字人一致性。 |
| GJJ · 🐱 LongCat视频加载器 | Long Cat Video Loader 节点 |
| GJJ · 👄 本地口型同步 | Local Lip Sync 节点 |
| GJJ · 👄 视频口型同步（LatentSync） | Latent Sync Node 节点 |
| GJJ · 📝 Wan T5文本编码 | 合并 WanVideo T5 Text Encoder Loader 与 WanVideo TextEncode 的 GJJ 零依赖节点。执行时从 models/text_encoders 加载 T5 文本编码器，并直接输出 WanVide… |
| GJJ · 📝CLIP文本编码(Kijai版WanVideo专用) | 接收 Wan T5 编码器和正向提示词，输出打包好的 WanVideo 文本条件。 |
| GJJ · 📷 多角度相机控制 | 交互式3D相机角度控制节点，通过3D场景调整相机角度，输出多角度提示词和相机信息。支持图片输入在3D场景中预览。 |
| GJJ · 🔍 Wan图像CLIP编码 | WanVideo CLIP Vision 图像条件编码的 GJJ 零依赖节点。内部调用 GJJ vendor 中的 WanVideoClipVisionEncode，不依赖外部 ComfyUI-WanVideoWrapper 插件。 |
| GJJ · 🔗 WanVideo文本条件桥接 | 把 ComfyUI 原生 CONDITIONING 转成 WanVideoWrapper 采样器需要的 WANVIDEOTEXTEMBEDS。 |
| GJJ · 🔗 Wan添加TTM Latent | WanVideo TTM (Time-To-Move) Latent 注入的 GJJ 零依赖节点。将参考 latent 和遮罩注入到图像条件中，供采样器在指定步数范围内使用 TTM 引导。参考：https://github.com/time… |
| GJJ · 🔴🟡🔵智能视频模型加载🎞️Kijai版 | Kijai/WanVideoWrapper 生态模型族预设加载器。输出 WANVIDEOMODEL / WANVAE / WANTEXTENCODER / CLIP_VISION，支持双模型、单模型、预设 LoRA、VACE、Fantasy… |
| GJJ · 🔵🟡🔴 智能视频模型加载🎞️官方流 | 视频通用模型加载器：按官方工作流配置扫描 models 子目录，动态显示模型下拉与输出槽。官方流保留原有加载方式；KJ 流改为 UNET 主模型 + 双 CLIP + LTX23 视频/音频 VAE。 |
| GJJ · 🕳️ 视频深度估计 | Video Depth Anything 节点 |
| GJJ · 🖼️ Wan图生视频编码 | WanVideo 图生视频条件编码的 GJJ 零依赖节点。内部调用 GJJ vendor 中的 WanVideoImageToVideoEncode，不依赖外部 ComfyUI-WanVideoWrapper 插件。 |
| GJJ · 🗓️ WanVideo 调度器 v2 | GJJ WanVideo 调度器 v2：调用 GJJ 内置 vendored WanVideo runtime。 |
| GJJ · 🗣️ FantasyTalking音频条件 | FantasyTalking 音频条件节点：内部从 models/wav2vec2 加载本地 Wav2Vec2，输出可直接连接 GJJ WanVideo Sampler 的 FantasyTalking 条件。 |
| GJJ · 🧍 WanAnimate姿态脸部一体 | Wan Animate Pose Face AIO 节点 |
| GJJ · 🧡【LTX2】归一化注意力引导(NAG) | 🧡【LTX2 归一化注意力引导】- 增强视频生成质量的专业工具 📦 功能说明： 本节点为 LTX2 视频生成模型提供归一化注意力引导（Normalized Attention Guidance, NAG）功能， 通过引入负向引导条件来增强生… |
| GJJ · 🧩 SCAIL-2 彩色遮罩 | 零依赖复刻官方 SCAIL2ColoredMask：把 SAM3 轨迹数据渲染为 SCAIL-2 需要的彩色身份遮罩，并在节点内部预览姿态遮罩和参考图遮罩。 |
| GJJ · 🧩 WanVideo VACE 模型选择 | 选择 VACE 模型，用于不包含 VACE 的主模型。从 diffusion_models 目录加载。 |
| GJJ · 🧪 WanVideo Experimental Args 实验参数 | GJJ 零依赖复刻 WanVideoExperimentalArgs：生成 WanVideo 采样器使用的实验参数，包括多提示词注意力拆分、CFG-Zero*、FreSca、TCFG、RAAG、双向采样和 TSR。 |
| GJJ · 🧬 LTXV IC-LoRA模型加载 | 零依赖移植 LTXICLoRALoaderModelOnly：只给模型加载 IC-LoRA，并输出 latent_downscale_factor 与 factor*32 像素倍数。 |
| GJJ · 🧬 LTX身份迁移 | LTX 身份迁移：把参考图编码为独立参考标记，并用来源相位标记注入 LTX 模型，用于人物身份参考视频生成。 |
| GJJ · 🧬 LTX身份重叠条件 | 为 LTX 模型注入独立的身份参考令牌，支持重叠、时空错位与分层堆叠布局；参考图不是首帧 I2V 条件，并提供实际编码图与裁剪区域预览。 |
| GJJ · 🧬 Wan VACE 编码 | WanVideo VACE 条件编码的 GJJ 零依赖复刻版。节点不导入 ComfyUI-WanVideoWrapper，只使用传入的 Wan VAE 对象完成视频帧、遮罩和参考图编码。 |
| GJJ · 🧭 LTX导演Guide引导 | LTX Director 2.0.2 Guide 引导：支持图像关键帧、IC-LoRA 运动引导、Retake 和分块 VAE 编码。 |
| GJJ · 🧭 LTX稀疏轨迹编辑器 | 一比一复刻 LTX Sparse Track Editor：在参考图上交互编辑稀疏运动轨迹，并输出可给 LTX 轨迹绘制/控制节点使用的 JSON。 |
| GJJ · 🧰 WanVideo 采样扩展参数 | GJJ WanVideo Sampler v2 扩展参数：把高级输入打包后连接到采样器。 |
| GJJ · 🧰 WanVideo增强缓存与SLG | 将 WanVideoEnhanceAVideo、WanVideoEasyCache 和 WanVideoSLG 合并为一个零外部节点依赖的三输出参数节点。 |
| GJJ · 🧱 Wan 分块交换（Kijai流） | WanVideo Block Swap 参数的 GJJ 零依赖复刻版。输出 BLOCKSWAPARGS 字典；可选接入 WANVIDEOMODEL 时，会在节点内复刻 WanVideoSetBlockSwap 逻辑并输出已写入参数的模型。 |
| GJJ · 🧵 LTX稀疏轨迹绘制 | 一比一复刻 LTX Draw Sparse Tracks：把稀疏轨迹 JSON 渲染成 LTX 可用的轨迹图像序列。 |
| GJJ · 🧵 LTX稀疏轨迹绘制 | 一比一复刻 LTX Draw Sparse Tracks：把稀疏轨迹 JSON 渲染成 LTX 可用的轨迹图像序列。 |
| GJJ · 🪄 WanVideo提示词扩展参数 | 生成 WanVideo 提示词扩展参数，可连接到 GJJ · WanVideo 文本编码（缓存版）的提示词扩展参数输入。 |

</details>

<details>
<summary><strong>🎞️ 视频处理与工具（74）</strong></summary>

| 节点名称 | 功能描述 |
| --- | --- |
| GJJ · Bernini S2V条件构建 | 零依赖复刻 Wan Bernini S2V Conditioning：把音频编码输出和 Bernini 上下文 latent 写入 CONDITIONING。 |
| GJJ · Bernini S2V条件构建V2 | Bernini in-context conditioning with masked S2V audio for one or two speakers. |
| GJJ · F2K多功能图片全身动作姿势迁移 | 把 F2K 图片动作姿势迁移工作流封装为 GJJ 零依赖单节点。1口必填，2口选填；模型、提示词与采样参数按工作流固定并自动查找。 |
| GJJ · ProPainter视频修复 | GJJ 零原插件依赖的 ProPainter 视频遮罩修复单节点；输入 IMAGE 帧序列与 MASK，输出修复帧、光流遮罩和膨胀遮罩。 |
| GJJ · ⏱️ Qwen时间戳转PromptRelay | 把 Qwen3-ASR 的 [开始s-结束s] 时间戳表转换为 PromptRelay 可用的 \| 分段局部提示词和逐段帧数。 |
| GJJ · ✂️ 可视化视频分段编辑器 | 视频分段编辑器：加载视频后自动生成分段，可视化编辑起止帧，按帧裁剪并输出多个视频片段。 |
| GJJ · ✂️ 局部重绘裁切 | 根据遮罩自动裁出局部重绘区域，并输出可拼回原图的零依赖 stitcher。 |
| GJJ · ✂️ 批量多功能综合抠图 | Comprehensive Matting 节点 |
| GJJ · ✂️ 视频可视化区域裁切 | 可视化区域裁切：节点内预览源媒体，用控制点设置最小 256 且 64 对齐的裁切框，并按关键帧插值移动裁切位置输出视频帧序列；可设置输出起止帧，尾帧按 8n+1 锁定。 |
| GJJ · 循环开始（内部引用） | For Loop While Start 节点 |
| GJJ · 循环结束（内部引用） | For Loop While End 节点 |
| GJJ · 整数加法（内部引用） | For Loop Int Add 节点 |
| GJJ · 整数小于（内部引用） | For Loop Int Less 节点 |
| GJJ · 视频首尾帧 | Video First Last Frame 节点 |
| GJJ · 🆚 图片对比比较 | 对比两路图片，使用简单滑动分割线查看差异。 |
| GJJ · 🎚️ 图片调色 | 对图片批次执行本地调色：曝光、对比、饱和、鲜艳度、色温、色调、色相、伽马和颗粒。 |
| GJJ · 🎚️ 视频背景音叠加 | 将另一段 AUDIO 叠加到带原音轨的视频中，在节点内预览混音结果；VIDEO 输出口可用但不要求连接。 |
| GJJ · 🎛️ Clown采样器 | 零依赖 Clown 采样器：界面兼容 RES4LYF ClownSampler_Beta，内部映射到当前 ComfyUI 可用的 SAMPLER。 |
| GJJ · 🎛️ ControlNet采样预设器 | 内部加载 checkpoint、编码正反提示词，并根据图像与遮罩生成可直接连接到 KSampler 的模型、条件和 latent。 |
| GJJ · 🎞️ Bernini条件构建 | Bernini Conditioning 节点 |
| GJJ · 🎞️ 任意视频合并 | 动态输入任意数量视频，按输入顺序拼合成一段视频；可删除衔接处重复锚点帧，并在节点和队列里显示预览。 |
| GJJ · 🎞️ 单视频分段队列执行 | 零依赖单视频分段队列：外接 GJJ_BATCH_IMAGE / IMAGE / VIDEO，或在节点内点击 📁 导入视频，按 8N+1 帧数输出当前分段和 1 基分段序号。 |
| GJJ · 🎞️ 时序提示词编码 | 将全局提示词和按时间分段的局部提示词编码为视频时序控制条件，支持 Wan 与 LTX。 |
| GJJ · 🎞️ 最新视频尾帧 | 按文件名前缀查找最新视频，并用 FFmpeg 返回最后若干帧；找不到或读取失败时输出空 IMAGE 批次，不打断工作流。 |
| GJJ · 🎞️ 视频\音频帧数 8n+1 | 输入人声和可选背景声，已满足 8n+1 时原样输出；否则只在末尾补静音到 8n+1；可选接入视频/画面，视频音频会从第一路音频输出对齐后输出。 |
| GJJ · 🎞️ 视频任意帧截图 | 从 VIDEO / IMAGE 批次 / GJJ_BATCH_IMAGE 中按 1 基帧号截取任意帧，并按选择顺序输出为 GJJ_BATCH_IMAGE,IMAGE。 |
| GJJ · 🎞️ 视频信息读取 | 调用 ffprobe 读取视频基本信息。 |
| GJJ · 🎞️ 视频倒数帧 | 从输入视频帧序列中提取倒数第 N 帧，输出同尺寸的单张静态图片。 |
| GJJ · 🎞️ 视频合成器VHS | 将 Video Helper Suite 的 Video Combine 迁移为 GJJ 本地零依赖节点：支持 IMAGE/LATENT 序列输出 GIF、WEBP、PNG 序列和多种 FFmpeg 视频格式，也支持多个官方 VIDEO 顺… |
| GJJ · 🎞️ 视频抽帧 | 用 FFmpeg 抽取视频帧为 IMAGE 批次。 |
| GJJ · 🎞️ 视频提示词中继编码器 | 将全局提示词和多段时序局部提示词编码到 Wan 或 LTX 视频模型中，用于一段视频内按时间切换内容。 |
| GJJ · 🎞️ 视频插帧（GIMM-VFI） | GIMM-VFI 零第三方节点包依赖单节点插帧；模型从 models/interpolation 下模糊搜索。 |
| GJJ · 🎞️ 视频插帧（RIFE） | 将 RIFE VFI 迁移为 GJJ 零依赖单节点：支持图片队列或视频插帧，推荐使用 rife47 与 rife49。 |
| GJJ · 🎞️ 视频组件编码 | 逐帧读取 VIDEO、按比例模式缩放/裁剪/填充，并直接用 VAE 编码为 LATENT，同时输出音频、帧率和帧数。 |
| GJJ · 🎨 色彩平衡 | 调整图像的阴影、中间调和高光的色彩平衡。与 ComfyUI 系统 Color Balance 节点功能一致，支持批量处理。 |
| GJJ · 🎨 颜色适配 | 根据参考图自动调整输入图像的整体色调。复刻 LayerColor: ColorAdapter 的 LAB 色彩迁移逻辑，使用 GJJ 内置零依赖实现。 |
| GJJ · 🎬 视频智能分镜 | 单视频智能分镜：输入 GJJ_BATCH_IMAGE / IMAGE / VIDEO，自动识别镜头边界，用二分法细化切点，输出当前分镜帧和分镜序号。 |
| GJJ · 🎭 HuMo音频条件 | Hu Mo Whisper Embeds 节点 |
| GJJ · 🎭 一键批量换脸 | Face Analysis 节点 |
| GJJ · 🎯 SAM3视频跟踪一体机 | SAM3 Video Track AIO 节点 |
| GJJ · 🎯🙂 SAM3人脸贴回视频 | 输入源视频、处理后的全长脸部裁剪视频和裁剪 JSON，按源帧号把人脸贴回源视频。 |
| GJJ · 🎯🙂 SAM3多人脸裁剪视频 | 输入单个媒体和 GJJ_UniversalTTS 对齐的时间轴文本，固定以 face 作为 SAM3 跟踪目标；按说话人时间段取当前说话人的脸，输出与源视频同帧数的脸部裁剪队列和回贴位置 JSON。 |
| GJJ · 🎯🙂 SAM3说话人分段裁脸 | 按时间轴的第 N 个说话段裁剪单一说话人的脸和对应音频，避免 Bernini 在多人切换处生成滑动中间脸。 |
| GJJ · 🎵 音视频人声、背景音分离(Mel-Band RoFormer) | Audio Separator 节点 |
| GJJ · 👤 主体一键多视图 | Character Multi View Studio 节点 |
| GJJ · 💛Gemma🧠图片反推提示词推理 | Gemma Text Generate 节点 |
| GJJ · 💬 视频字幕添加 | 将 SRT 按时间轴烧录到 VIDEO，生成带描边字幕的视频，并在视频旁保存完全同名的 SRT 文件。 |
| GJJ · 📈 CFG调度浮点列表 | GJJ 零依赖复刻 CreateCFGScheduleFloatList：生成 WanVideo Sampler 可用的逐步 CFG 浮点列表。 |
| GJJ · 📢MMAudio 视频配音单节点 | MMAudio 视频配音单节点：优先使用输入口媒体；未连接时使用 📁 打开的视频文件；本地生成音频并合成视频。 |
| GJJ · 🔀 分组筛选路由 | 按分组名称关键词筛选当前工作流中的分组，便于前端面板快速定位和旁路操作。 |
| GJJ · 🔊 视频提取音频 | 从官方 VIDEO 对象中提取内置音频轨道，输出 AUDIO。 |
| GJJ · 🔊 音视频合并 | 用 FFmpeg 把图片帧、视频路径或同前缀分段视频按序号合并，并可选封入音频。适合长视频分段保存后的最终合并。 |
| GJJ · 🔍 FlashVSR视频超分放大器 | 综合 FlashVSR 与 FlashVSR Ultra-Fast 的 GJJ 零依赖单节点；支持视频直连保留音频，或帧序列超分输出。 |
| GJJ · 🔍 SeedVR2图像视频放大器 | Seed VR2 Image Upscaler 节点 |
| GJJ · 🔍 多功能图片缩放 | GJJ · 🔍 多功能图片缩放 用途： - 单图或 GJJ_BATCH_IMAGE 批量图片缩放。 |
| GJJ · 🔢 视频帧数量\帧率 | 获取图片批次、视频帧序列或 VIDEO 的帧数量，并尽量快速读取原视频帧率。 |
| GJJ · 🔢 递增数值 | 输出一个可链接到多个随机种子或序列切片插槽的数值，并默认在每次生成后按“数量”推进到下一段。 |
| GJJ · 🔲 可视化宫格图片分割器 | 宫格图片分割器 —— 在节点内实时预览并拖拽分割线，自动裁剪每个区块，支持节点内部直接加载图片。 |
| GJJ · 🖼️ Ideogram4文生图 | Ideogram 4 文生图零依赖单节点：内部完成模型加载、提示词编码、Ideogram 调度、双模型 CFG 采样和 VAE 解码。 |
| GJJ · 🖼️ 底模一键生图 | 单节点加载底模 checkpoint 直接出图，内部自动完成提示词编码、latent 创建、采样和 VAE 解码。 |
| GJJ · 😃 人脸细化器 | GJJ 单节点版 FaceDetailer。内部直接加载 ultralytics bbox 人脸检测模型和 SAM 模型，无需额外连接 bbox_detector 或 sam_model 节点。 |
| GJJ · 🚦 条件旁路 | 用可输入公式判断是否放行下游；条件为假时输出 False，供下游条件口跳过执行。 |
| GJJ · 🚦 条件路由切换 | 条件路由切换：公式或变量值等于第几路，就透传第几路输入；变量模式下未选中路会在提交前旁路下游。 |
| GJJ · 🦴 本地DWPose姿态检测 | DWPose Estimator 节点 |
| GJJ · 🧠Bernini多模态视频编辑器（一键生成） | LazyImageStudio 风格 Bernini 一体化节点：三路智能媒体输入，自动识别图片/批量图片/VIDEO，长视频分段生成、逐段节点内预览，最终保留源帧率和音频合成视频。 |
| GJJ · 🧡Ollama🧠图片反推提示词推理 | 统一调用本机 Ollama 完成文本生成、提示词翻译与可选图片理解任务；通过模板按钮快速切换系统提示词。 |
| GJJ · 🧡·🎬 批量多视频加载预览器 | 一次选择多个 input 目录视频，按帧范围、帧率、宽高和格式参数解码为 GJJ 批量图片帧队列。 |
| GJJ · 🧩 图片、视频拼接（简易） | GJJ 零依赖媒体拼接节点：动态接收 GJJ_BATCH_IMAGE、IMAGE、MASK、VIDEO，按方向依次拼接，可选择匹配首图尺寸。 |
| GJJ · 🧩 图片拼版 | 把多路图片或图片批次拼成横排、竖排或自动网格，适合对比图、参考图和结果展示。 |
| GJJ · 🧩 额外模型串联配置 | GJJ 额外模型串联配置节点。用于把 VACE、FantasyTalking、MultiTalk/InfiniteTalk、FantasyPortrait 等 WanVideo 额外模型串成一个 EXTRA_MODEL_CHAIN 输入。 |
| GJJ · 🧭 深度ControlNet生图器 | 将官方 depth_controlnet 工作流封装成简洁单节点。前台只暴露深度图、正向提示词、底模、深度 ControlNet 和随机种子；CLIP、VAE 与采样参数在后台按官方默认流程处理。 |
| GJJ · 🧮 像素完美分辨率 | 按 ControlNet Pixel Perfect 规则，根据原图和生成尺寸计算预处理分辨率。 |
| GJJ · 🧾 CLIP正负提示词编码 | CLIP 编码统一面板：CLIP 输入，正面/负面提示词在一个面板里编辑；内置条件零化与 Opus-MT 中英翻译开关，翻译时保留中文引号中的原文，输出正负 CONDITIONING。 |
| GJJ · 🪄 遮罩扩张模糊 | KJNodes GrowMaskWithBlur 的 GJJ 零依赖复刻版。支持遮罩扩张/收缩、逐帧递增、翻转、填洞、帧间插值、衰减叠加和高斯模糊。 |

</details>

<details>
<summary><strong>🎵 音频与语音（14）</strong></summary>

| 节点名称 | 功能描述 |
| --- | --- |
| GJJ · Universal TTS | 零本地节点依赖的多功能 TTS：统一文本解析、参考音频、队列合成、时间轴输出和依赖提示。 |
| GJJ · ✂️ 可视化音频分段编辑器 | Audio Segment Editor 节点 |
| GJJ · ✂️ 音频裁剪 | 按时间裁剪 AUDIO。 |
| GJJ · ✂️ 音频静音修剪，队列输出 | 零依赖音频静音修剪：按音量阈值压缩长静音，并可按静音边界限制输出最长总时长。 |
| GJJ · 🎚️ Mel-Band RoFormer整段音频响度 | Mel Band Ro Former Sampler 节点 |
| GJJ · 🎚️ 人声背景合并 | 合并人声和背景声，两路自动按最长长度补齐后混合输出。 |
| GJJ · 🎤 语音识别 (SenseVoice) | Sense Voice ASR 节点 |
| GJJ · 🎤 语音识别四文本TTS(Qwen3) | Qwen3 ASRText Formats 节点 |
| GJJ · 🎤 语音识别多语言场景 (Faster Whisper) | Faster Whisper ASR 节点 |
| GJJ · 🎬 MTV音频转提示词 | 将 ACE 音乐音频与歌词 SRT 自动分段，分离人声/伴奏，并用 GJJ_GemmaTextGenerate 逐段生成 MTV 参考画面与 LTX 视频提示词；可从参考图反推并缓存人物特征。 |
| GJJ · 🎵 ACE音乐生成器 | 将 Audio ACE 1.5 两套工作流合并成单节点：优先使用整包 checkpoint，缺失时自动回退到 split 模型组，直接生成音乐音频。 |
| GJJ · 🔊 Edge TTS 零依赖 | Edge TTS 零依赖复刻版：不依赖 edge_tts、torchaudio 或外部 config，直接输出 ComfyUI AUDIO。 |
| GJJ · 🗣️ 说话人隔离（零依赖） | 零依赖说话人分段/隔离节点：不依赖 ComfyUI-Speaker-Isolation、pyannote、Whisper 或 HF Token。可选接入 WHISPER_OUTPUT，将已有识别文本按时间戳对齐到估算的说话人片段。 |
| GJJ · 🥁 音频节拍分析 | 轻量音频节拍分析，不依赖 librosa，输出 BPM 和节拍时间 JSON。 |

</details>

<details>
<summary><strong>📝 文本、提示词与列表（27）</strong></summary>

| 节点名称 | 功能描述 |
| --- | --- |
| GJJ · guojijun · 任意列表重复（内部引用） | 把输入对象或列表重复指定次数并输出为列表。 |
| GJJ · ⚖️ 提示词权重 | 给提示词片段添加常见权重语法，支持单条或多行批量输出。 |
| GJJ · 🎲 批量文本分行队列执行 | 从多行文本或 JSON 数组中按 1 基序号稳定选出一条，并输出合并后的正面提示词、总数、选中文本和当前行数。 |
| GJJ · 👆 任意列表取项 | 从任意列表中按序号取一项，序号支持循环。 |
| GJJ · 👣 批量文本图片前景背景叠加融合 | 将文本或前景图叠加到背景图上，支持批量处理；前景图可使用本地 RMBG1.4 模型自动抠图，并添加阴影、描边。 |
| GJJ · 💾 文本文件保存 | 把文本写入 input/output/temp 或自定义路径，支持覆盖、追加、前插和逗号拼接。 |
| GJJ · 📄 PDF转图片 | 把 PDF 页面渲染为 IMAGE 批次，需要当前环境安装 PyMuPDF。 |
| GJJ · 📄 图片转PDF | 把 IMAGE 批次保存为多页 PDF。 |
| GJJ · 📋 文本指定列提取 | 按行拆分表格式文本，提取指定列，并将该列的所有内容逐条换行输出。 |
| GJJ · 📐 提示词尺寸预设CLIP编码 | 整合提示词输入、尺寸预设、图像尺寸同步与空 Latent 生成，并直接输出可接 KSampler 的正反条件。 |
| GJJ · 📖 文本文件读取 | 从 input/output/temp 或自定义路径读取文本，支持整文件、按行和按逗号输出。 |
| GJJ · 📚 任意列表合并（输出列表口） | 把多路任意输入合并成 ComfyUI 列表口输出，适合批量参数、批量提示词和批量对象整理。 |
| GJJ · 📝 文本合并预览 | 把多路文本按顺序直接拼接，并在节点内提供预览，方便提示词和文案整合。 |
| GJJ · 📝 文本输入、预览(Markdown) | 提供一个可手填或透传外部输入的文本节点，适合作为工作流里的文本源头；前端支持 Markdown 预览模式。 |
| GJJ · 🔀 提示词分组切换 | 在同一个工作流里维护多组提示词文本，并按序号切换输出当前选中的那一组。 |
| GJJ · 🔁 反转任意队列 | 零依赖反转任意队列：列表 1,2,3,4 输出 4,3,2,1；IMAGE/MASK/Tensor 视频帧批次按第 0 维倒序。 |
| GJJ · 🔗 文本分隔合并 | 把文本列表或多路文本按指定分隔符合并，适合把批量提示词片段汇总成一段。 |
| GJJ · 🧩 提示词组合 | 把基础提示词、主体列表和风格列表做排列组合或随机抽样，输出提示词列表。 |
| GJJ · 🧩 模板动态选择 | 模板动态选择节点。点击 ⚙️设置 填写模板库；模板库使用行首《模板名称》模板正文 的格式。 |
| GJJ · 🧬 Embedding提示词 | 生成 embedding 提示词片段，并可附加权重。 |
| GJJ · 🧬 JSON动态解析 | 从外部输入、面板粘贴文本、浏览器打开文件文本或本地文件路径读取 JSON，并按顶层键/项目动态显示输出口。 |
| GJJ · 🧭 Ideogram4提示词画框 | 可视化构建 Ideogram 4 结构化 JSON 提示词。在节点画布中拖拽绘制区域，为每个区域填写类型、描述、文字和颜色，并按 Ideogram 4 提示词工程推荐的字段顺序输出 JSON 字符串。 |
| GJJ · 🧭 时间轴提示词编码 | 带可视化时间轴编辑器的 Prompt Relay 编码节点。 |
| GJJ · 🧰 多功能提示词预设 | 把风格、证件照、主体、环境、随机灵感与多角度提示词整合到一个 GJJ 零依赖节点中，直接输出混合正负提示词。 |
| GJJ · 🧹 任意列表筛选 | 按起止序号和可选布尔列表筛选任意列表。 |
| GJJ · 🧾 CSV/TSV/TXT逐行分列 | 读取本地、网络或浏览器选择的 CSV/TSV/TXT 文本，按当前行数分列输出，并支持前端自动逐行执行。TXT 使用 \|\| 分列，并按 ---、空行、换行的优先级分行。 |
| GJJ · 🧾 模板提示词 | 模板提示词节点。使用 {{参数名}} 声明动态参数；使用 {{参数名(默认值)}} 声明默认值；使用 {{名称:选项1,选项2}} 声明按钮组选项，默认单选，按 Ctrl/Shift 可多选，输出会自动带“名称：”前缀。全角冒号 {{名称：… |

</details>

<details>
<summary><strong>🧠 模型加载、LoRA 与采样（22）</strong></summary>

| 节点名称 | 功能描述 |
| --- | --- |
| GJJ · Boogu图像编辑编码 | GJJ 零依赖 Boogu-Image Edit 条件编码节点。复刻 TextEncodeBooguEdit，图片输入兼容 GJJ_BATCH_IMAGE 和 IMAGE；多路图片会按 image_1 到 image_16 的顺序展开，批量… |
| GJJ · Conditioning Zero Out | Conditioning Zero Out 节点 |
| GJJ · Flux Disable Guidance | Flux Disable Guidance 节点 |
| GJJ · Flux Guidance | Flux Guidance 节点 |
| GJJ · Inpaint Model Conditioning | Inpaint Model Conditioning 节点 |
| GJJ · Krea2图像接地正负面编码 | Krea2 图像编辑语义接地编码：把正面、负面提示词分别与全部参考图一起交给 Qwen3-VL 编码，输出可直接用于 CFG 的正面和负面条件。 |
| GJJ · Krea2图像编辑重平衡 | 零外部节点依赖复刻 Krea 2 Image Edit Rebalance：编码 Krea2 图像编辑提示词并重平衡多模态 CONDITIONING。 |
| GJJ · Krea2身份编辑模型补丁 | 零外部节点依赖的 Krea2 图像编辑模型补丁：递归拆分输入图片、内部加载固定身份编辑 LoRA，并注入多参考图编辑路径。 |
| GJJ · ⚡ Sage注意力补丁 | 零 KJ 依赖复刻 PatchSageAttentionKJ：高模、低模双通道分别输入输出，并设置 SageAttention 注意力覆盖。关闭模式会原样输出输入模型。 |
| GJJ · ⚡ 模型补丁三合一 | 把 SageAttention、FP16 累积设置、LTXV FeedForward 分块合并为一个零 KJ 依赖的 GJJ MODEL 补丁节点。支持高模、低模双通道分别输入输出，第二路可不接。 |
| GJJ · 📝 模型旁注保存 | 为模型同名写入 txt 旁注和 png 封面；不改写 safetensors 本体，避免破坏模型文件。 |
| GJJ · 🔍 模型采样预览覆盖 KJ | 为模型挂载独立的采样过程预览面板，可提高预览分辨率、隐藏默认预览，并为视频 latent 生成动画预览和采样曲线。 |
| GJJ · 🔍 载入模型图片放大器 | Model Upscaler 节点 |
| GJJ · 🔢 工作流模型统计 | 直接扫描当前工作流全部节点使用的模型，按目录显示并检查缺失文件。 |
| GJJ · 🙂 LoRA人脸素材生成器 | 输入同一人物的多张参考图，默认使用 qwen_image_edit_2511 一致性编辑链批量生成可直接用于 LoRA 训练的单人素材。参考图只负责身份、发型和脸部角度，节点会重建近景 / 半身 / 全身构图，并自动输出指定训练模型推荐尺寸… |
| GJJ · 🟡🟠🔴智能批量模型加载🧡图像版 | 按模型族模板加载扩散模型、CLIP、VAE、模型补丁、CLIP视觉模型、ControlNet，并交给 ComfyUI 按实时显存自动完整加载或部分卸载。 |
| GJJ · 🧡·📂 批量多图加载浏览,队列执行 | 一次选择多张 input 目录里的图片，在节点中网格预览并按选择数量同步扩展图片输出接口。可作为主图图片、输入图像、原图来源的默认加载节点。 |
| GJJ · 🧪 LoRA效果测试 | 按过滤后的 LoRA 列表和多选强度逐项输出 LoRA 串联配置、当前名称、列表状态和名称注解图。 |
| GJJ · 🧪 模型效果测试 | 按 checkpoints 或 diffusion_models 的过滤列表逐项输出当前模型、宽度、列表状态和名称注解图。 |
| GJJ · 🧬 多LoRA串联器 | GJJ 多 LoRA 串联加载器。 |
| GJJ · 🧬 额外LoRA串联配置 | GJJ LoRA 串联配置节点。 |
| GJJ · 🧾 模型元数据查看 | 直接读取 safetensors 文件头里的 metadata，不加载模型权重，适合查看 LoRA 触发词和训练信息。 |

</details>

<details>
<summary><strong>🧊 3D 与动画（3）</strong></summary>

| 节点名称 | 功能描述 |
| --- | --- |
| GJJ · FBX姿势工作室（零依赖） | GJJ 零依赖 FBX 姿势工作室：直接载入本地绑定骨骼 FBX，在节点面板中调整骨骼、位置、相机，并输出当前截图。 |
| GJJ · 🎥 TripoSplat渲染序列 | 为 TripoSplat 创建轨道相机并渲染图片/遮罩序列，可选输入图片作为背景板。 |
| GJJ · 🦴 Mesh2Motion 骨骼动画 | GJJ 本地零依赖 Mesh2Motion 单节点：内嵌 3D 骨骼动画编辑器，执行时输出当前截图和相机预设录制的视频。 |

</details>

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
│　　 ├── common_utils/              # 共享工具模块
├── locales/                       # 国际化
│　　 ├── zh/                        # 中文语言包
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
