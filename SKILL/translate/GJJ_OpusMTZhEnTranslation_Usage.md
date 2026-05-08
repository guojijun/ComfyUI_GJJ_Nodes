# GJJ Opus-MT 中英翻译器使用示例

## 模型信息
- **模型名称**: Helsinki-NLP/opus-mt-zh-en
- **模型路径**: ComfyUI/models/translation/opus-mt-zh-en/
- **功能**: 将中文文本翻译为英文文本

## 使用方法

### 1. 基本使用
1. 在节点菜单中找到 "GJJ/翻译" -> "GJJ · 🌐 Opus-MT中英翻译器 🌍"
2. 连接中文文本输入（STRING 类型）
3. 配置参数：
   - **设备选择**: auto (推荐), cpu, gpu
   - **最大长度**: 512 (默认值，可根据需要调整)
   - **批处理大小**: 8 (默认值，影响内存使用)
   - **使用后卸载模型**: 根据显存情况选择
4. 运行工作流获取英文翻译结果

### 2. 模型下载
首次使用时，节点会自动从 Hugging Face 下载模型到 `ComfyUI/models/translation/opus-mt-zh-en/` 目录。

如果网络环境不佳，可以手动下载：
- 访问: https://huggingface.co/Helsinki-NLP/opus-mt-zh-en
- 下载所有文件到 `Comfy UI/models/translation/opus-mt-zh-en/` 目录

### 3. 参数说明

| 参数 | 说明 | 推荐值 |
|------|------|--------|
| 设备选择 | 运行设备 | auto (自动选择 GPU/CPU) |
| 最大长度 | 输入/输出最大 token 数 | 512 |
| 批处理大小 | 同时处理的句子数 | 8 |
| 使用后卸载模型 | 是否释放显存 | 根据需求选择 |

### 4. 注意事项
- 模型专用于**中文到英文**翻译
- 如果需要英文到中文翻译，请使用其他模型
- 首次运行需要下载约 300MB 的模型文件
- 确保已安装 `transformers` 和 `huggingface_hub` 依赖

### 5. 依赖要求
```bash
pip install transformers huggingface_hub
```

> **提示**: GJJ 项目通常已包含这些依赖，如遇问题请检查您的 ComfyUI 环境。