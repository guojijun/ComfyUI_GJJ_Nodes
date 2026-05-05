# ComfyUI_GJJ_Nodes

个人开发的 ComfyUI 自定义节点合集，涵盖图像、视频、音频、提示词、模型管理、工作流辅助等多个方向。

## 功能特点

- **单文件部署，零额外依赖** — 除 `requirements.txt` 中列出的通用包外，不依赖任何第三方自定义节点包
- **内置中文工具提示** — 所有节点参数均提供中文说明，降低使用门槛
- **子目录感知的模型查找** — 自动递归搜索模型子目录，支持最长公共片段匹配和扩展名剥离
- **动态输入/输出插槽** — 采用 AnySwitch 稳定化模式，插槽变更后保持连线不丢失
- **1-based 用户编号** — 所有面向用户的插槽编号从 1 开始，符合直觉
- **自定义预览支持** — 多种输出格式（图片、音频、视频）的专用预览节点
- **丰富的格式预设** — 内置视频格式、提示词风格等预设，开箱即用
- **前端 JS 独立封装** — 每个节点的前端逻辑放在独立 JS 文件中，便于维护

## 安装方法

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

### 可选依赖

部分节点需要额外安装：

```bash
pip install -r requirements-optional.txt   # 可选功能
pip install -r requirements-accelerate.txt # 推理加速
```

## 模型下载

部分节点需要配套模型才能运行，模型文件请从以下地址下载：

🔗 **模型下载地址：** [https://pan.quark.cn/s/6ec846f1f58d](https://pan.quark.cn/s/6ec846f1f58d)

下载后将对应模型放入 `ComfyUI/models/` 下的相应子目录即可，具体路径参考各节点参数中的中文提示。

## 节点列表

### 工作流辅助

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
| GJJ · Text Overlay | 将随机或指定文本绘制到透明图层上，可与背景图合成，适合标题和水印 |
| GJJ · Alpha Tools | 透明通道处理：绿幕转透明、Alpha 转遮罩、移除透明背景 |
| GJJ · Image Metadata Viewer | 读取图片文件基础信息、PNG 文本元数据、ComfyUI 工作流和 EXIF 信息 |
| GJJ · Safetensors Metadata Viewer | 直接读取 safetensors 文件头的 metadata，无需加载模型权重 |
| GJJ · Safetensors Metadata Writer | 为模型写入同名 txt 旁注和 png 封面，不改写 safetensors 本体 |

### 图像处理

| 节点名称 | 功能描述 |
| -------- | -------- |
| GJJ · Image Adjuster | 对图片批次执行本地调色：曝光、对比、饱和、鲜艳度、色温、色调、色相、伽马和颗粒 |
| GJJ · Image Comparer | 对比两路图片，使用滑动分割线查看差异 |
| GJJ · Image Collage | 把多路图片拼成横排、竖排或自动网格，适合对比图和结果展示 |
| GJJ · Image Stacker | 把 2-4 张图片横向或纵向拼接 |
| GJJ · Image Splitter | 宫格图片分割器，节点内实时预览并拖拽分割线自动裁剪每个区块 |
| GJJ · Image Grid Splitter | 把图片按网格切成最多 9 块，可带少量重叠，适合局部处理后重组 |
| GJJ · Image Grid Reassembler | 把网格图片块贴回原图尺寸，支持指定替换块与自动缩放 |
| GJJ · Image To Batch Image | 把普通 IMAGE 打包成 GJJ 专用批量图片类型 |
| GJJ · Batch Image To Image | 把 GJJ 专用批量图片类型还原为普通 IMAGE |
| GJJ · Multi Image Loader | 一次选择多张 input 目录图片，按选择数量同步扩展图片输出接口 |
| GJJ · Load Image With Alpha | 加载 input 目录图片，保留 RGBA 并输出 alpha 遮罩 |
| GJJ · Batch Watermark Remover | 批量去除水印，借鉴 Flux2 Klein 参考图重绘思路，不依赖第三方节点 |
| GJJ · Inpaint Crop | 根据遮罩自动裁出局部重绘区域，输出可拼回原图的零依赖 stitcher |
| GJJ · Inpaint Stitch | 把局部重绘裁切输出的重绘图拼回原图 |
| GJJ · LaMa Inpaint | 使用本地 big-lama.pt 对遮罩标记区域进行修复，适合去物和背景补全 |
| GJJ · Old Photo Restorer | 将 qwen_image_edit_2511 老照片修复工作流封装为单节点 |
| GJJ · Qwen2511 Edit Outpaint | 通用外扩图片填充编辑器，默认使用 GJJ 专用批量图片口 |
| GJJ · Ultimate Architecture Upscaler | 将超分、建筑细节增强、分块重绘与接缝修复整合成单节点放大流程 |
| GJJ · Model Upscaler | 使用 models/upscale_models 中的单图超分模型放大图像 |
| GJJ · Seed VR2 Image Upscaler | 将 SeedVR2 的图像/视频放大整合成单节点，接入视频时自动保留音频 |
| GJJ · PDF To Images | 把 PDF 页面渲染为 IMAGE 批次 |
| GJJ · Images To PDF | 把 IMAGE 批次保存为多页 PDF |
| GJJ · VFX Effects | 常用本地图像 VFX：像素化、抖动、故障偏移、半调 |
| GJJ · Image Analysis | 调用本地 Ollama 多模态模型分析图片内容，输出反推提示词 |

### 视频处理

| 节点名称 | 功能描述 |
| -------- | -------- |
| GJJ · Video Combine | 零依赖视频合成节点，支持 IMAGE/LATENT 序列输出 GIF、WEBP、PNG 和多种视频格式 |
| GJJ · Video Segment Editor | 可视化视频分段编辑器，自动生成分段并拖拽调整起止时间，批量裁剪输出多个视频片段 |
| GJJ · Video Reverse Frame | 从输入视频帧序列中提取倒数第 N 帧，输出同尺寸单张静态图片 |
| GJJ · Video Outpaint Pad | 把 VIDEO 拆成帧后做零依赖外扩画布预处理，支持边距和目标比例扩充 |
| GJJ · Video Frames Loader | 用 FFmpeg 抽取视频帧为 IMAGE 批次 |
| GJJ · Multi Video Loader | 一次选择多个 input 目录视频，按帧范围和抽帧间隔解码为批量图片帧队列 |
| GJJ · Video Info | 调用 ffprobe 读取视频基本信息 |
| GJJ · FFmpeg Mux Audio Video | 用 FFmpeg 把图片帧或视频路径与音频合并为 MP4 |
| GJJ · Rife Video Interpolator | 零依赖视频插帧节点，支持图片队列或视频插帧，推荐 rife47 与 rife49 |
| GJJ · Flash VSR Video Upscaler | 综合 FlashVSR 与 FlashVSR Ultra-Fast 的零依赖视频超分单节点 |
| GJJ · LTX23 Image To Video | LTX-2.3 图生/文生视频节点，接入音频时自动对齐时长 |
| GJJ · LTX23 Image To Video Multi Ref | LTX-2.3 多图参考器，支持 0 图文生视频和多图整体参考生成 |
| GJJ · LTX23 First Last Outfit | LTX-2.3 首尾帧变装转场一体化节点 |
| GJJ · LTX First Last Frame | 为 LTX 视频潜空间添加首帧和尾帧引导 |
| GJJ · LTX23 Anime2Real Workflow | LTX2.3 动漫转写实视频预设节点 |
| GJJ · LTX23 Anime Real Switch Workflow | LTX2.3 动漫/写实互转视频预设节点 |
| GJJ · LTX23 Edit Anything Workflow | LTX2.3 视频任意编辑预设节点 |
| GJJ · LTX23 Inpaint Workflow | LTX2.3 视频 inpaint 预设节点 |
| GJJ · LTX23 Masked Ref Inpaint Workflow | LTX2.3 参考物体遮罩重绘预设节点 |
| GJJ · LTX23 Workflow Multi Image Reference | LTX-2.3 图生视频多图参考版预设节点 |
| GJJ · LTX23 Workflow Digital Human Multi Ref | LTX-2.3 数字人多图参考版预设节点 |
| GJJ · LTX23 Workflow All Reference | LTX2.3 全能参考 / 多关键帧工作流预设节点 |
| GJJ · LTX23 Workflow Four Panel | LTX2.3 四宫格工作流预设节点 |
| GJJ · LTX23 Workflow Prompt Relay Talking Head | LTX2.3 数字人 Prompt Relay 高动作遵从工作流预设节点 |
| GJJ · Wan22 First Last Video | Wan2.2 首尾帧生视频节点，内部完成双阶段 4 步采样与解码 |
| GJJ · Wan22 Rapid AIO Mega | Wan2.2 Rapid-AIO-Mega 一站式节点，支持 T2V/I2V/首尾帧/多图串接 |
| GJJ · Local Lip Sync | 零 API 口型同步节点，图片+音频走 LTX2.3，视频+音频走 LatentSync |
| Latent Sync | 通过音频同步视频唇形，需预下载模型到 ComfyUI/models/latentsync |

### 音频处理

| 节点名称 | 功能描述 |
| -------- | -------- |
| GJJ · Audio Ace Music Generator | Audio ACE 1.5 音乐生成节点，优先使用整包 checkpoint 直接生成音乐音频 |
| GJJ · Cosy Voice3 Generator | CosyVoice3 一体式语音克隆器，支持零样本复刻、跨语言复刻与指令风格控制 |
| GJJ · Fish Audio S2 Generator | Fish Audio S2 一体式 TTS，支持单人语音克隆和多说话人语音克隆 |
| GJJ · Long Cat Audio Di T TTS | LongCat AudioDiT 一体式语音克隆与多说话人 TTS |
| GJJ · Audio Segment Editor | 音频分段编辑器，可视化编辑起止时间，按时间段裁剪并输出多个音频片段 |
| GJJ · Audio Beat Analyzer | 轻量音频节拍分析，不依赖 librosa，输出 BPM 和节拍时间 JSON |
| GJJ · Audio Crop | 按时间裁剪 AUDIO |
| GJJ · Audio Tools | 音频处理工具集 |
| GJJ · Qwen3 ASR Text Formats | Qwen3-ASR 一体式语音识别与强制对齐，输出时间戳表和分段文本 |
| GJJ · Qwen Timestamp To Prompt Relay | 把 Qwen3-ASR 时间戳表转换为 PromptRelay 可用的分段局部提示词 |

### 提示词与文本

| 节点名称 | 功能描述 |
| -------- | -------- |
| GJJ · Prompt Generation | 调用本地 Ollama 模型生成提示词或文本内容 |
| GJJ · Prompt Preset Studio | 整合风格、证件照、主体、环境与多角度提示词，输出混合正负提示词 |
| GJJ · Prompt Size Preset | 整合提示词输入、尺寸预设、图像尺寸同步与空 Latent 生成 |
| GJJ · Prompt Weight | 给提示词片段添加常见权重语法，支持单条或多行批量输出 |
| GJJ · Prompt Combination | 把基础提示词、主体列表和风格列表做排列组合或随机抽样 |
| GJJ · 提示词分组切换 | 在同一工作流里维护多组提示词文本，按序号切换输出当前选中组 |
| GJJ · Text Random Line | 从多行文本或 JSON 数组中按序号稳定选出一条 |
| GJJ · Text File Reader | 从 input/output/temp 或自定义路径读取文本，支持整文件、按行和按逗号输出 |
| GJJ · Text File Writer | 把文本写入 input/output/temp 或自定义路径，支持覆盖、追加和逗号拼接 |
| GJJ · Embedding Prompt | 生成 embedding 提示词片段，并可附加权重 |
| GJJ · Csv Tsv Row Iterator | 读取 CSV/TSV 文本按行分列输出，支持前端自动逐行执行 |
| GJJ · Translation | 调用本地 Ollama 进行中英提示词翻译，保持 AI 绘画术语和权重符号不变 |
| GJJ · Ollama Directory Captioner | 通过浏览器选择本地目录，调用 Ollama 为图片生成同名 txt 打标文件 |
| GJJ · Prompt Relay Timeline | 带可视化时间轴编辑器的 Prompt Relay 编码节点 |
| GJJ · Prompt Relay Encode | 将全局提示词和按时间分段的局部提示词编码为视频时序控制条件 |
| GJJ · Prompt Relay Encoder | 将全局和多段时序局部提示词编码到 Wan 或 LTX 视频模型中 |
| GJJ · Batch Text Segmenter | 零依赖批量 SAM3 文本分割器，按图文序号匹配图片输出 RGBA 透明裁剪 |

### 模型加载与管理

| 节点名称 | 功能描述 |
| -------- | -------- |
| GJJ · Model Bundle Loader | 一次性加载 UNET、CLIP、VAE，附带常用步数和降噪参数输出 |
| GJJ · Flux1 Dual CLIP Loader | 为 Flux 1 系列模型一次性加载 UNET、双 CLIP 和 VAE |
| GJJ · Checkpoint Direct Generator | 单节点加载底模 checkpoint 直接出图，内部自动完成编码、采样和 VAE 解码 |
| GJJ · Multi Lora Chain | 按配置顺序串联加载多组 LoRA |
| GJJ · Lora Chain Config | 输出多组 LoRA 串联配置，可连到支持串联配置输入的节点 |
| GJJ · Lora Effect Tester | 按过滤后的 LoRA 列表和多选强度逐项输出配置、名称和注解图 |
| GJJ · Model Family Preset Table | 模型族预设节点 |
| GJJ · Brush Net Inpaint | 综合 BrushNet、PowerPaint、RAUNet 模型的正向填充与重绘 |

### 分割与抠图

| 节点名称 | 功能描述 |
| -------- | -------- |
| GJJ · SAM3 Point Collector | 在节点面板直接点选前景与背景点位 |
| GJJ · SAM3 BBox Collector | 在节点面板直接框选正向或反向区域 |
| GJJ · SAM3 Point Segmenter | SAM3 点选分割器，内部自动加载 models/sam3 模型 |
| GJJ · SAM3 Text Segmenter | SAM3 文本分割器，输入自然语言描述返回匹配目标的遮罩 |
| GJJ · SEM2 Point Segmenter | SEM2 点选分割、遮罩膨胀、块化和预览收成单节点 |
| GJJ · SAM3D Body Process | 内置 SAM 3D Body 单图人体网格恢复 |
| GJJ · SAM3D Mesh Sequence From Video | 内置 SAM3D Body 视频帧转人体网格序列 |
| GJJ · Comprehensive Matting | 综合抠图：RMBG2、BiRefNet、BEN2、Inspyrenet 等 |
| GJJ · SDMatte Matting | 使用 SDMatte 模型按遮罩执行精细抠图，输出透明图和遮罩 |
| GJJ · Face Detailer | 单节点版 FaceDetailer，内部直接加载人脸检测和 SAM 模型 |
| GJJ · BBox Detector Loader | 加载人脸或目标检测模型 |
| GJJ · Detect SEGS | 使用 BBox 检测器识别目标区域并转换成 SEGS |
| GJJ · Make SAM Mask | 基于 SAM 模型生成精细局部遮罩 |
| GJJ · Detailer For Each | 对每个 SEGS 区域进行局部重绘和细化 |
| GJJ · SEGS Bitwise And Mask | 将 SEGS 与遮罩做按位相交 |
| GJJ · SEGS To Mask | 把多个 SEGS 区域合并成统一遮罩 |

### 遮罩与区域

| 节点名称 | 功能描述 |
| -------- | -------- |
| GJJ · Mask Grow Blur | 对遮罩执行扩张、收缩与模糊 |
| GJJ · Mask Merge | 合并最多八路遮罩，支持相加、最大值、相交和扣除 |
| GJJ · Mask Outline | 从遮罩生成内外轮廓线 |
| GJJ · Area To Mask | 按画布尺寸和矩形区域生成遮罩 |
| GJJ · Region Box | 创建可传递的矩形区域，同步输出区域遮罩 |
| GJJ · Region Crop | 按区域数据从图片中裁切局部图像 |
| GJJ · Region Composite | 把前景图片按指定区域合成到底图上 |
| GJJ · Grid Region Selector | 把画布切成行列网格，按序号输出区域 |
| GJJ · Points Editor | 图形化点位编辑器，输出坐标、边框、遮罩和裁切图 |

### 生成与编辑

| 节点名称 | 功能描述 |
| -------- | -------- |
| GJJ · Control Net Preset | 内部加载 checkpoint、编码提示词，生成可直连 KSampler 的模型和条件 |
| GJJ · Depth Control Net Generator | 将官方 depth_controlnet 工作流封装成简洁单节点 |
| GJJ · Scribble Control Net Generator | 将官方 scribble_controlnet 工作流封装成简洁单节点 |
| GJJ · SD15 Inpaint Workflow | 把 sd1.5_inpaint 工作流收口成单节点 |
| GJJ · Flux Fill Dev Outpaint | 将 flux_fill_dev_outpaint 工作流封装成简洁单节点 |
| GJJ · Redux Advanced | 内部加载 CLIP Vision 与 Redux 风格模型，将图像风格编码拼接到 conditioning |
| GJJ · Lazy Image Studio | 懒人图文集成一键生图，自动推荐匹配的编码器和常用采样参数 |
| GJJ · Character Multi View Studio | 主体一键多视图，自动匹配 qwen_image_edit_2511 模型族并拼接多视图图板 |
| GJJ · Lora Face Material Generator | 输入多张参考图，批量生成可直接用于 LoRA 训练的单人素材 |
| GJJ · Mesh2Motion Explore | 零依赖 Mesh2Motion 单节点，内嵌 3D 骨骼动画编辑器 |

## 使用说明

1. 安装完成后重启 ComfyUI，在节点菜单中搜索 `GJJ` 即可找到所有节点
2. 所有 GJJ 节点统一使用 `GJJ ·` 前缀命名，方便在节点列表中快速识别
3. 大部分节点支持右键菜单中的快捷操作，悬停参数标签可查看中文提示
4. 详细用法参考 `examples/` 目录中的工作流示例

## 许可证

本项目仅限个人学习使用，**禁止任何形式的商业用途**。

## 致谢

感谢 ComfyUI 社区及其所有贡献者。

---

**作者：** [guojijun](https://github.com/guojijun)
