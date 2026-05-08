# ComfyUI 节点音频加载最佳实践

## 问题背景

在开发 ComfyUI 音频处理节点时，经常需要加载本地音频文件。不同用户有不同的音频格式（WAV、MP3、WMA、FLAC 等），而不同的 Python 库对音频格式的支持程度不同：

- **soundfile**：支持 WAV、FLAC、OGG 等，速度快但不支持 WMA
- **torchaudio**：支持 MP3、WAV 等，但存在 DLL 兼容性问题
- **PyAV**：通过 FFmpeg 支持几乎所有格式，包括 WMA
- **librosa**：支持多种格式但速度较慢

## 解决方案

采用**多方式回退策略**，按优先级依次尝试不同的音频加载库：

### 实现代码

```python
def _read_audio_file(path: str) -> tuple[np.ndarray, int]:
    """读取音频文件，支持多种加载方式，逐级回退"""
    errors = []
    
    # 方式1: 尝试 soundfile（支持 WAV、FLAC、OGG 等）
    try:
        import soundfile as sf
        audio_np, sample_rate = sf.read(path, always_2d=True)
        if audio_np.size > 0:
            return audio_np.astype(np.float32, copy=False), int(sample_rate)
    except Exception as e:
        errors.append(f"soundfile: {e}")
    
    # 方式2: 尝试 torchaudio（支持 MP3、WAV 等）
    try:
        import torchaudio
        waveform, sr = torchaudio.load(path)
        audio_np = waveform.numpy()
        # torchaudio 返回 (channels, samples)，需要转为 (samples, channels)
        if audio_np.ndim == 2:
            audio_np = audio_np.T
        else:
            audio_np = audio_np.reshape(-1, 1)
        return audio_np.astype(np.float32, copy=False), int(sr)
    except Exception as e:
        errors.append(f"torchaudio: {e}")
    
    # 方式3: 尝试 PyAV（通过 FFmpeg 支持几乎所有格式，包括 WMA）
    try:
        audio_np, sample_rate = _decode_audio_with_av(path)
        if audio_np.size > 0:
            return audio_np, sample_rate
    except Exception as e:
        errors.append(f"PyAV: {e}")
    
    # 方式4: 尝试 librosa（支持多种格式，但速度较慢）
    try:
        import librosa
        audio_np, sr = librosa.load(path, sr=None, mono=False)
        if audio_np.ndim == 1:
            audio_np = audio_np.reshape(-1, 1)
        else:
            audio_np = audio_np.T
        return audio_np.astype(np.float32, copy=False), int(sr)
    except Exception as e:
        errors.append(f"librosa: {e}")
    
    # 所有方式都失败
    raise RuntimeError(
        f"无法解码音频文件：{path}\n"
        f"尝试的所有方法均失败：\n" + "\n".join(f"  - {err}" for err in errors)
    )


def _decode_audio_with_av(source_path: str) -> tuple[np.ndarray, int]:
    """使用 PyAV 解码音频文件（支持 WMA 等格式）"""
    import av

    with av.open(source_path) as container:
        if not container.streams.audio:
            raise RuntimeError("文件中没有可解码的音频流。")
        stream = container.streams.audio[0]
        sample_rate = int(stream.codec_context.sample_rate or 0)
        chunks: list[np.ndarray] = []
        for frame in container.decode(stream):
            if not sample_rate:
                sample_rate = int(frame.sample_rate or 0)
            chunk = frame.to_ndarray()
            if chunk.ndim == 1:
                chunk = chunk[:, None]
            elif chunk.shape[0] <= 8:
                chunk = chunk.T
            if chunk.dtype.kind in {"i", "u"}:
                chunk = chunk.astype(np.float32) / float(np.iinfo(chunk.dtype).max)
            else:
                chunk = chunk.astype(np.float32, copy=False)
            chunks.append(chunk)
        if not chunks:
            raise RuntimeError("音频文件没有有效采样。")
        audio_np = np.concatenate(chunks, axis=0)
        return audio_np.astype(np.float32, copy=False), sample_rate
```

### 使用示例

```python
# 在节点函数中调用
if audio is None and example_audio != "[无示例音频]":
    mp3_dir = os.path.join(folder_paths.models_dir, "mp3")
    audio_path = os.path.join(mp3_dir, example_audio)
    if os.path.exists(audio_path):
        try:
            # 使用多方式回退策略加载音频
            audio_np, sample_rate = _read_audio_file(audio_path)
            # 转换为 torch tensor
            if audio_np.ndim == 1:
                audio_np = audio_np.reshape(1, -1)
            else:
                audio_np = audio_np.T  # (samples, channels) -> (channels, samples)
            waveform = torch.from_numpy(audio_np).float()
            audio = {"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate}
        except Exception as e:
            raise RuntimeError(f"加载示例音频失败: {e}")
```

## 关键要点

### 1. 加载顺序的重要性

- **soundfile** 优先：速度最快，支持常见格式
- **torchaudio** 其次：PyTorch 原生，但可能有 DLL 问题
- **PyAV** 第三：通过 FFmpeg 支持 WMA 等特殊格式
- **librosa** 最后：万能但速度慢

### 2. 音频数据维度转换

不同库返回的音频数据格式不同：

- **soundfile**：`(samples, channels)` - 需要转置为 `(channels, samples)`
- **torchaudio**：`(channels, samples)` - 直接使用
- **PyAV**：`(samples, channels)` - 需要转置
- **librosa**：`(samples,)` 或 `(samples, channels)` - 需要统一

### 3. 错误信息收集

使用 `errors` 列表收集每种方法的失败原因，最终统一显示，方便用户排查问题：

```python
raise RuntimeError(
    f"无法解码音频文件：{path}\n"
    f"尝试的所有方法均失败：\n" + "\n".join(f"  - {err}" for err in errors)
)
```

## 常见问题

### Q1: 为什么会出现 "无法定位程序输入点" 的 DLL 错误？

**原因**：torchaudio 版本与 PyTorch 版本不兼容。

**解决**：通过多方式回退策略，即使 torchaudio 失败也能继续尝试其他方法。

### Q2: 如何支持 WMA 格式？

**解决**：使用 PyAV（依赖 FFmpeg）解码 WMA 文件。确保已安装 `av` 包：

```bash
pip install av
```

### Q3: 单声道和多声道如何处理？

**解决**：统一转换为 `(channels, samples)` 格式：

```python
if audio_np.ndim == 1:
    audio_np = audio_np.reshape(1, -1)  # 单声道
else:
    audio_np = audio_np.T  # 多声道转置
```

## 参考实现

- **FishAudioS2 节点**：`/nodes/gjj_fish_audio_s2_generator.py` - 使用 soundfile + PyAV
- **Qwen3 ASR 节点**：`/nodes/gjj_qwen3_asr_text_formats.py` - 使用 4 种方式回退

## 依赖要求

确保以下库已安装（至少一个）：

```
soundfile
torchaudio
av (PyAV)
librosa
```

通常 ComfyUI 环境中已包含这些库，但建议优先使用 soundfile 和 PyAV。
