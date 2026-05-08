# LatentSync 模型设置指南

## 概述

GJJ的LatentSync节点用于将音频与视频同步，以实现唇形同步效果。此节点需要预先下载模型文件到指定位置。

## 模型下载

### 1. 创建模型目录

在ComfyUI根目录下的`models`文件夹中创建`latentsync`目录结构：

```
ComfyUI/
├── models/
│   └── latentsync/
│       ├── latentsync_unet.pt
│       └── whisper/
│           └── tiny.pt
```

### 2. 下载模型文件

需要下载以下两个文件：

1. **latentsync_unet.pt**
   - 来源: [https://huggingface.co/chunyu-li/LatentSync/resolve/main/latentsync_unet.pt](https://huggingface.co/chunyu-li/LatentSync/resolve/main/latentsync_unet.pt)
   - 大小: 约975MB
   - 存放位置: `ComfyUI/models/latentsync/latentsync_unet.pt`

2. **whisper/tiny.pt** 
   - 来源: [https://huggingface.co/chunyu-li/LatentSync/resolve/main/whisper/tiny.pt](https://huggingface.co/chunyu-li/LatentSync/resolve/main/whisper/tiny.pt)
   - 大小: 约75MB
   - 存放位置: `ComfyUI/models/latentsync/whisper/tiny.pt`

### 3. 下载方法

#### 方法一：浏览器直接下载

直接点击上面的链接，在浏览器中下载文件，然后移动到相应目录。

#### 方法二：使用wget或curl

```bash
# 创建目录
mkdir -p ComfyUI/models/latentsync/whisper

# 下载模型
cd ComfyUI/models/latentsync
wget https://huggingface.co/chunyu-li/LatentSync/resolve/main/latentsync_unet.pt
cd whisper
wget https://huggingface.co/chunyu-li/LatentSync/resolve/main/whisper/tiny.pt
```

#### 方法三：使用Git LFS (推荐)

如果你安装了Git LFS，可以使用以下命令：

```bash
# 安装Git LFS (如果尚未安装)
git lfs install

# 下载特定文件
git lfs pull --include="latentsync_unet.pt" https://huggingface.co/chunyu-li/LatentSync
git lfs pull --include="whisper/tiny.pt" https://huggingface.co/chunyu-li/LatentSync
```

## 使用方法

1. 确保模型文件已正确放置在上述目录中
2. 重启ComfyUI
3. 在工作流中使用"GJJ · LatentSync 视频音频同步"节点
4. 连接视频路径、音频文件和种子值
5. 运行工作流

## 注意事项

- 由于网络限制，从Hugging Face下载可能较慢或失败，请耐心等待
- 确保有足够的磁盘空间存储模型文件（总共约1GB）
- 模型文件只需下载一次，之后可重复使用
- 如果遇到连接问题，可尝试使用代理或VPN

## 故障排除

### 错误："未找到模型文件..."

确认模型文件路径是否正确，文件名是否完全匹配。

### 错误："FFmpeg未找到"

确保系统已安装FFmpeg，可以从 [https://ffmpeg.org](https://ffmpeg.org) 下载并添加到系统PATH。

### 处理速度慢

此节点依赖于外部工具进行视频处理，处理时间取决于视频长度和系统性能。

## 参考

- 原始项目: [https://github.com/bytedance/LatentSync](https://github.com/bytedance/LatentSync)
- 模型来源: [https://huggingface.co/chunyu-li/LatentSync](https://huggingface.co/chunyu-li/LatentSync)