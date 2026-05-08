# GJJ_FasterWhisperASR 节点改造总结

## 🎯 改造目标

将 Faster Whisper ASR 节点改造成类似 **Qwen3 ASR** 的自包含 UI 模式，所有操作在节点内部完成。

---

## ✨ 改造内容

### 1. 后端改造 (`nodes/gjj_faster_whisper_asr.py`)

#### 1.1 输入参数调整
- ✅ **移除 `required` 参数**：所有参数改为 `optional`
- ✅ **添加 `example_audio`**：从 `models/mp3` 目录加载示例音频列表
- ✅ **添加 `hidden` 参数**：`unique_id` 和 `extra_pnginfo`（用于读取 properties）
- ✅ **移除 `auto_download` 布尔参数**：改为从 `properties` 读取

#### 1.2 示例音频支持
```python
# 读取 models/mp3 列表
mp3_dir = os.path.join(folder_paths.models_dir, "mp3")
audio_choices = [""]  # 空选项
if os.path.isdir(mp3_dir):
    for f in sorted(os.listdir(mp3_dir)):
        if f.lower().endswith((".mp3", ".wav", ".flac", ".m4a")):
            audio_choices.append(f)
```

#### 1.3 Properties 读取
```python
# 从 properties 读取 Boolean 值（通过 extra_pnginfo + unique_id）
props = {}
if extra_pnginfo and isinstance(extra_pnginfo, dict):
    workflow = extra_pnginfo.get("workflow", {})
    if isinstance(workflow, dict):
        nodes = workflow.get("nodes", [])
        for n in nodes:
            if str(n.get("id")) == str(unique_id):
                props = n.get("properties", {}) or {}
                break

auto_download = bool(props.get("auto_download", True))
```

#### 1.4 示例音频加载
```python
if audio is None and example_audio != "[无示例音频]":
    mp3_dir = os.path.join(folder_paths.models_dir, "mp3")
    audio_path = os.path.join(mp3_dir, example_audio)
    if os.path.exists(audio_path):
        import soundfile as sf
        audio_np, sample_rate = sf.read(audio_path, always_2d=True)
        # 转换为 torch tensor
        waveform = torch.from_numpy(audio_np.T).float()
        audio = {"waveform": waveform.unsqueeze(0), "sample_rate": int(sample_rate)}
```

#### 1.5 事件发送
- ✅ **文本生成完成事件**：`gjj_faster_whisper_generated`
- ✅ **运行时错误事件**：`gjj_faster_whisper_error`

```python
# 发送文本生成完成事件到前端
PromptServer.instance.send_sync("gjj_faster_whisper_generated", {
    "node": str(unique_id),
    "text_list": full_text,
})

# 发送错误事件到前端
PromptServer.instance.send_sync("gjj_faster_whisper_error", {
    "node": str(unique_id),
    "error": error_msg,
    "install_command": install_command,
})
```

#### 1.6 CUDA 错误自动降级
```python
if ("CUDA error" in error_msg or "cuda" in error_msg.lower()) and torch.cuda.is_available():
    # 自动切换到 CPU 模式
    device = "cpu"
    compute_type = "int8"
    model = WhisperModel(model_path, device=device, compute_type=compute_type)
```

---

### 2. 前端改造 (`js/gjj_faster_whisper_asr.js`)

#### 2.1 布尔按钮化
- ✅ 移除旧的 Boolean widget
- ✅ 在节点内部创建按钮行
- ✅ 按钮状态同步到 `node.properties`

```javascript
const boolConfigs = [
    { name: "auto_download", label: "⬇️ 自动下载", default: true },
];

boolConfigs.forEach(config => {
    const btn = document.createElement("button");
    btn.textContent = config.label;
    btn.__boolValue = config.default;
    
    btn.addEventListener("click", () => {
        btn.__boolValue = !btn.__boolValue;
        node.properties[config.name] = btn.__boolValue;
        // 更新按钮样式...
    });
});
```

#### 2.2 生成文本按钮
- ✅ 添加【 生成文本】按钮
- ✅ 点击后只执行当前节点（不执行下游节点）
- ✅ 按钮状态管理（生成中/空闲）

```javascript
generateBtn.addEventListener("click", async () => {
    btn.textContent = "⏳ 生成中...";
    btn.disabled = true;
    
    const ok = await queueOnlyCurrentNode(node);
    
    setTimeout(() => {
        btn.textContent = "🎤 生成文本";
        btn.disabled = false;
    }, 500);
});
```

#### 2.3 文本显示与复制
- ✅ 节点内部显示生成的文本
- ✅ 一键复制按钮（默认隐藏，生成后显示）
- ✅ 错误时显示安装命令并提供复制

```javascript
// 文本显示区域
const textDisplay = document.createElement("div");
textDisplay.style.cssText = `
    flex:1;
    padding:8px;
    background:#1a2329;
    border:1px solid #3a4a52;
    max-height:200px;
    overflow-y:auto;
`;

// 复制按钮
copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(status.textDisplay.textContent);
    status.copyBtn.textContent = "✅ 已复制";
    setTimeout(() => {
        status.copyBtn.textContent = "📋";
    }, 1500);
});
```

#### 2.4 错误处理
- ✅ 监听后端错误事件
- ✅ 显示错误信息和安装命令
- ✅ 一键复制安装命令

```javascript
api.addEventListener("gjj_faster_whisper_error", (event) => {
    const data = event.detail;
    status.textDisplay.textContent = `❌ 执行失败：\n\n${data.error}`;
    
    if (data.install_command) {
        status.copyBtn.textContent = "📋 复制安装命令";
        status.copyBtn.style.background = "#ff4757";
    }
});
```

#### 2.5 进度显示
- ✅ 实时显示识别进度
- ✅ 进度条动画
- ✅ 状态文本更新

```javascript
api.addEventListener("gjj_node_progress", (event) => {
    const data = event.detail;
    status.label.textContent = data.text;
    status.bar.style.width = `${Math.round(data.progress * 100)}%`;
});
```

---

## 📊 对比分析

| 功能 | Qwen3 ASR | Faster Whisper ASR |
|------|-----------|-------------------|
| **示例音频** | ✅ models/mp3 | ✅ models/mp3 |
| **布尔按钮化** | ✅ 2 个按钮 | ✅ 1 个按钮（自动下载） |
| **生成文本按钮** | ✅  生成文本 | ✅ 🎤 生成文本 |
| **文本显示** | ✅ 节点内部 | ✅ 节点内部 |
| **一键复制** | ✅ 📋 | ✅ 📋 |
| **错误提示** | ✅ 红色文本 + 安装命令 | ✅ 红色文本 + 安装命令 |
| **CUDA 降级** | ✅ 自动切换 CPU | ✅ 自动切换 CPU |
| **进度显示** | ✅ 进度条 | ✅ 进度条 |
| **Properties 读取** | ✅ extra_pnginfo | ✅ extra_pnginfo |
| **事件发送** | ✅ gjj_qwen3_* | ✅ gjj_faster_whisper_* |

---

## 🔧 使用方式

### 方式 1：使用示例音频
1. 将音频文件放入 `ComfyUI/models/mp3/` 目录
2. 在节点中选择示例音频
3. 点击【🎤 生成文本】按钮
4. 等待识别完成，文本显示在节点内部
5. 点击【📋】复制文本

### 方式 2：连接音频输入
1. 连接 Load Audio 节点的输出
2. 点击运行按钮或【🎤 生成文本】
3. 等待识别完成

---

## 📦 依赖要求

**Python 依赖**：
```bash
pip install faster-whisper soundfile huggingface_hub
```

**模型目录**：`models/faster-whisper/`

**可用模型**：
- `tiny` (约 75MB, 最快，精度最低)
- `base` (约 150MB, 快速，精度较低)
- `small` (约 480MB, 平衡速度和精度)
- `medium` (约 1.5GB, 较慢，精度高)
- `large-v3` (约 3GB, 最慢，精度最高，推荐)

---

## ✅ 改造完成

现在 Faster Whisper ASR 节点已经和 Qwen3 ASR 节点一样，具备：
- ✅ 节点内部载入示例音频列表
- ✅ 节点内部布尔按钮（自动下载模型）
- ✅ 节点内部添加【生成文本】按钮
- ✅ 节点内部生成数据，可一键复制
- ✅ 缺失模型或依赖时给出友好解决方案
- ✅ CUDA 错误自动降级到 CPU

用户可以完全在节点内部完成所有操作，无需外部依赖！🎉
