# GJJ 批量多功能综合抠图节点 - 开发指南

## 概述

本文档详细介绍了 `GJJ_ComprehensiveMatting` 节点的依赖管理、模型配置和使用流程，旨在帮助开发者理解和复用相关代码。

---

## 一、依赖管理体系

### 1.1 运行时依赖加载机制

该节点采用**运行时懒加载**模式，所有第三方依赖都在执行时通过 `load_dependency_at_runtime` 函数加载。

#### 核心依赖列表

| 依赖模块 | pip 包名 | 用途 | 加载时机 |
|---------|---------|------|---------|
| `numpy` | numpy | 数值计算、数组操作 | 执行时 |
| `safetensors.torch` | safetensors | 模型权重加载 | 模型加载时 |
| `torchvision.transforms` | torchvision | 图像预处理 | 推理时 |
| `timm` | timm | RMBG2/BiRefNet 模型架构 | 模型加载时 |
| `kornia` | kornia | 图像处理算子 | 模型推理时 |
| `transparent_background` | transparent-background | Inspyrenet 抠图 | Inspyrenet 推理时 |

### 1.2 load_dependency_at_runtime 函数

该函数是 GJJ 节点库提供的公共依赖加载函数，具有以下特性：

#### 函数签名

```python
def load_dependency_at_runtime(
    module_name: str,
    node_name: str,
    package_name: str = None,
    description: str = "",
    extra_packages: list = None
) -> module
```

#### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `module_name` | str | 是 | 要导入的模块名（如 `"numpy"`、`"cv2"`） |
| `node_name` | str | 是 | 节点显示名称（用于错误提示） |
| `package_name` | str | 否 | pip 包名（若与模块名不同时使用） |
| `description` | str | 否 | 依赖用途说明 |
| `extra_packages` | list | 否 | 额外需要安装的包列表 |

#### 使用示例

```python
# 基本用法
np = load_dependency_at_runtime("numpy", "GJJ · 批量多功能综合抠图")

# 模块名与包名不同时
safetensors_torch = load_dependency_at_runtime(
    "safetensors.torch",
    "GJJ · 批量多功能综合抠图",
    "safetensors"  # pip 安装时使用的包名
)

# 带描述信息
Remover = load_dependency_at_runtime(
    "transparent_background",
    "GJJ · 批量多功能综合抠图",
    "transparent-background",
    "该节点需要 transparent-background Python 包才能运行 Inspyrenet 功能"
).Remover
```

#### 错误处理机制

当依赖缺失时，函数会自动：

1. **终端彩色提示**：打印美观的错误信息
2. **生成安装命令**：通过 `get_pip_install_command_text` 生成完整命令
3. **抛出异常**：包含详细错误信息的 `RuntimeError`

#### 终端输出示例

```
================================================================================
  GJJ 节点运行时依赖缺失！
================================================================================
[GJJ] 节点: GJJ · ✂️ 批量多功能综合抠图
[GJJ] 缺失依赖: timm
[GJJ] 该节点需要 timm Python 包才能运行 RMBG2/BiRefNet 模型

[GJJ] 快速安装命令:
& "D:\AI\ComfyUI\python.exe" -m pip install timm -i https://pypi.tuna.tsinghua.edu.cn/simple --ignore-installed --target "D:\AI\ComfyUI\Lib\site-packages"

[GJJ] 提示: 安装后请重启 ComfyUI 服务器
================================================================================
```

### 1.3 get_pip_install_command_text 函数

生成完整的 pip 安装命令，自动适配用户环境。

#### 函数签名

```python
def get_pip_install_command_text(pkg: str) -> str
```

#### 使用示例

```python
install_cmd = get_pip_install_command_text("numpy safetensors torchvision")
# 输出: '& "D:\AI\ComfyUI\python.exe" -m pip install numpy safetensors torchvision -i https://pypi.tuna.tsinghua.edu.cn/simple --ignore-installed --target "D:\AI\ComfyUI\Lib\site-packages"'
```

#### 命令特点

- 使用 `sys.executable` 获取当前 Python 解释器路径
- 添加清华镜像源加速下载
- 使用 `--target` 参数安装到正确目录
- 添加 `--ignore-installed` 避免版本冲突

---

## 二、模型配置体系

### 2.1 GJJ_HELP 结构

`GJJ_HELP` 是节点的帮助信息字典，供帮助文件生成器调用。

#### 结构定义

```python
GJJ_HELP = {
    "models": [
        {
            "label": "模型标签",      # 带 emoji 的显示名称
            "value": "模型路径",      # 推荐路径
            "tooltip": "说明文字"     # 详细说明
        }
    ],
    "dependencies": [
        "依赖说明1",
        "依赖说明2",
        ...
    ]
}
```

#### 本节点的 GJJ_HELP 配置

```python
GJJ_HELP = {
    "models": [
        {
            "label": "🟣RMBG2 模型",
            "value": "📁models/rmbg/rmbg-2.0.safetensors",
            "tooltip": "📘RMBG2 抠图模型；会在 models 目录下搜索 rmbg2 或 rmbg-2 相关文件。",
        },
        {
            "label": "🟢BiRefNet 通用模型",
            "value": "📁models/birefnet/general.safetensors",
            "tooltip": "📘BiRefNet 通用分割模型；会搜索包含 general 的 birefnet 模型文件。",
        },
        {
            "label": "🟢BiRefNet 精细模型",
            "value": "📁models/birefnet/matting.safetensors",
            "tooltip": "📘BiRefNet 精细抠图模型；会搜索包含 matting 的 birefnet 模型文件。",
        },
        {
            "label": "🟡BEN2 模型",
            "value": "📁models/ben2/ben2_base.pth",
            "tooltip": "📘BEN2 抠图模型；会搜索 ben2 相关的 pth 文件，需要同时存在 BEN2.py 代码文件。",
        },
        {
            "label": "🔵InSPyReNet 模型",
            "value": "📁models/inspyrenet/inspyrenet.pth",
            "tooltip": "📘InSPyReNet 抠图模型；会搜索 inspyrenet 或 isnet 相关的 pth/pt 文件。",
        },
    ],
    "dependencies": [
        "numpy（数值计算）",
        "safetensors（模型权重加载）",
        "torchvision（图像变换）",
        "timm（RMBG2/BiRefNet 模型架构）",
        "kornia（RMBG2/BiRefNet 图像处理）",
        "transparent-background（Inspyrenet 运行时依赖）",
    ],
}
```

### 2.2 模型搜索机制

节点采用**模糊搜索**策略定位模型文件：

#### 搜索流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    模型搜索流程                                 │
├─────────────────────────────────────────────────────────────────┤
│  1. 确定搜索模式（根据抠图方式）                                │
│         ↓                                                      │
│  2. 遍历候选模型根目录                                          │
│         ↓                                                      │
│  3. 递归搜索所有文件                                            │
│         ↓                                                      │
│  4. 根据评分规则计算匹配度                                      │
│         ↓                                                      │
│  5. 选择评分最高的文件                                          │
│         ↓                                                      │
│  6. 返回模型路径                                                │
└─────────────────────────────────────────────────────────────────┘
```

#### 评分规则

| 匹配类型 | 分值 | 说明 |
|---------|------|------|
| 精确文件名匹配 | +120 | 文件名完全匹配（不含扩展名） |
| 名称包含关键词 | +60 ~ +56 | 根据关键词位置递减 |
| 路径包含关键词 | +20 ~ +16 | 根据关键词位置递减 |
| 路径包含 `/rmbg/` | +10 | 额外加分 |
| 路径包含 `/birefnet/` | +10 | 额外加分 |
| 路径包含 `/ben` | +8 | 额外加分 |
| 路径或名称包含 `inspyrenet` | +8 | 额外加分 |

#### 搜索根目录

```python
def _candidate_model_roots() -> list[Path]:
    roots = [
        Path(__file__).resolve().parents[3] / "models",  # 从当前文件向上查找
        Path(folder_paths.models_dir)                     # ComfyUI 内置模型目录
    ]
    return unique_roots  # 去重后的目录列表
```

---

## 三、抠图方式支持

### 3.1 支持的抠图方式

| 方式 | 标识符 | 模型要求 | 特点 |
|------|--------|---------|------|
| RMBG2 | `RMBG2` | rmbg2 或 rmbg-2 相关文件 | 通用抠图，效果均衡 |
| BiRefNet 通用 | `BiRefNet 通用` | 包含 general 的 birefnet 模型 | 通用分割，适用场景广 |
| BiRefNet 精细 | `BiRefNet 精细` | 包含 matting 的 birefnet 模型 | 精细抠图，边缘处理好 |
| BEN2 | `BEN2` | ben2 相关 pth 文件 + BEN2.py | 高质量抠图 |
| Inspyrenet | `Inspyrenet` | inspyrenet 或 isnet 相关文件 | 实时抠图，效果好 |

### 3.2 多路选择机制

节点支持**多选抠图方式**，通过 `selected_methods_json` 参数控制：

```python
# 解析多选配置
def _parse_selected_methods(raw_value: str, fallback: str) -> list[str]:
    # JSON 数组格式: '["RMBG2", "BiRefNet 通用"]'
    # 或逗号分隔: 'RMBG2, BiRefNet 通用'
    ...
```

---

## 四、完整执行流程

### 4.1 节点执行流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    节点执行流程                                 │
├─────────────────────────────────────────────────────────────────┤
│  1. 依赖检查（load_dependency_at_runtime）                      │
│         ↓                                                      │
│  2. 解析选中的抠图方式                                          │
│         ↓                                                      │
│  3. 选择计算设备（GPU/CPU）                                     │
│         ↓                                                      │
│  4. 收集输入图片                                                │
│         ↓                                                      │
│  5. 遍历选中的抠图方式                                          │
│         ├─ 加载模型                                             │
│         ├─ 执行推理                                             │
│         ├─ 后处理遮罩（阈值、模糊、反转）                         │
│         └─ 合成输出图片                                         │
│         ↓                                                      │
│  6. 合并所有路线结果                                            │
│         ↓                                                      │
│  7. 返回批量图片张量                                            │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 核心执行代码

```python
def remove_background(
    self,
    matting_method: str = METHOD_RMBG2,
    selected_methods_json: str = "",
    background: str = "透明",
    device: str = "自动",
    process_res: int = MODEL_INPUT_SIZE,
    threshold: float = 0.0,
    mask_blur: float = 0.0,
    invert_output: bool = False,
    ...
):
    # 1. 加载运行时依赖
    load_dependency_at_runtime("numpy", "GJJ · ✂️ 批量多功能综合抠图")
    load_dependency_at_runtime("safetensors.torch", "GJJ · ✂️ 批量多功能综合抠图", "safetensors")
    load_dependency_at_runtime("torchvision", "GJJ · ✂️ 批量多功能综合抠图")
    load_dependency_at_runtime("timm", "GJJ · ✂️ 批量多功能综合抠图")
    load_dependency_at_runtime("kornia", "GJJ · ✂️ 批量多功能综合抠图")

    # 2. 解析选中的抠图方式
    selected_methods = _recover_selected_methods(
        selected_methods_json, matting_method, extra_pnginfo, unique_id
    )

    # 3. 选择设备
    target_device = _select_device(device)

    # 4. 收集图片
    pil_images = _collect_input_images(batch_image, image)

    # 5. 遍历处理
    for method in METHODS:
        if method not in selected_methods:
            continue
        
        # 加载模型并执行推理
        if method == METHOD_RMBG2:
            model = _load_rmbg2_model(weight_path, route_device)
            masks = _run_torch_mask_model(model, pil_images, route_device, process_res)
        # ... 其他方式
        
        # 后处理
        mask = _postprocess_mask(mask, threshold, mask_blur, invert_output)
        
        # 合成结果
        image_tensor, mask_tensor = _finish_outputs(final_rgba, final_masks, background)

    # 6. 合并结果
    combined_batch = torch.cat(combined_batches, dim=0)
    return (combined_batch,)
```

---

## 五、错误处理机制

### 5.1 依赖缺失处理

当依赖缺失时，`load_dependency_at_runtime` 会抛出包含详细信息的异常：

```python
# 异常信息结构
error_detail = f"""
未找到 {module_name} 运行库。

这个 GJJ 节点需要 {module_name} Python 包才能运行。

必需依赖（请安装）：
  • {pip_package} ({description or 'Python 包'})

🔧 快速安装命令（使用实际 Python 路径）：
{install_cmd}

原始导入错误：{exc}

提示：安装后请重启 ComfyUI 服务器。
"""
```

### 5.2 模型缺失处理

```python
def _find_model_file(display_name, include_sets, exts, excludes=()):
    candidates = []
    # ... 搜索逻辑 ...
    
    if candidates:
        return candidates[0][1]
    
    raise RuntimeError(
        f"未找到 {display_name} 模型文件。已在 models 目录下相关目录模糊搜索。"
    )
```

---

## 六、代码复用指南

### 6.1 创建类似节点的步骤

1. **导入公共工具函数**

```python
from .common_utils.dependency_checker import (
    load_dependency_at_runtime,
    get_pip_install_command_text,
)
```

2. **定义依赖列表**

```python
REQUIRED_DEPENDENCIES = [
    {"module": "numpy", "package": None, "description": "数值计算"},
    {"module": "torchvision", "package": None, "description": "图像变换"},
]
```

3. **在执行函数中加载依赖**

```python
def execute(self, ...):
    for dep in REQUIRED_DEPENDENCIES:
        load_dependency_at_runtime(
            module_name=dep["module"],
            node_name="GJJ · 你的节点名称",
            package_name=dep["package"],
            description=dep["description"]
        )
    # ... 业务逻辑 ...
```

4. **配置 GJJ_HELP**

```python
GJJ_HELP = {
    "models": [...],
    "dependencies": [...]
}
```

### 6.2 最佳实践

1. **不要在模块顶层导入第三方依赖**，避免节点注册失败
2. **使用 `load_dependency_at_runtime` 统一处理**，确保错误提示一致
3. **提供清晰的模型路径提示**，帮助用户正确放置模型文件
4. **在 DESCRIPTION 中说明依赖**，让用户提前了解需求

---

## 七、配置示例

### 7.1 模型目录结构推荐

```
models/
├── rmbg/
│   └── rmbg-2.0.safetensors
├── birefnet/
│   ├── general.safetensors
│   └── matting.safetensors
├── ben2/
│   ├── ben2_base.pth
│   └── BEN2.py
└── inspyrenet/
    └── inspyrenet.pth
```

### 7.2 安装命令

```powershell
# 安装所有必需依赖
& "D:\AI\ComfyUI\python.exe" -m pip install numpy safetensors torchvision timm kornia transparent-background -i https://pypi.tuna.tsinghua.edu.cn/simple --ignore-installed --target "D:\AI\ComfyUI\Lib\site-packages"
```

---

## 八、故障排除

### 8.1 常见问题

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| 依赖缺失报错 | 未安装必需的 Python 包 | 运行安装命令 |
| 模型未找到 | 模型文件路径不正确 | 按推荐结构放置模型 |
| CUDA 不可用 | 未安装 CUDA 或显卡驱动 | 安装 CUDA Toolkit |
| 内存不足 | GPU 显存不够 | 降低处理分辨率或使用 CPU |

### 8.2 调试技巧

1. **查看终端输出**：依赖缺失时会有详细的彩色错误提示
2. **检查模型路径**：确认模型文件存在于正确目录
3. **验证依赖安装**：运行 `pip list | findstr 包名` 确认安装状态

---

## 九、版本历史

| 版本 | 日期 | 更新内容 |
|------|------|---------|
| 1.0 | 2024-01-01 | 初始版本 |
| 1.1 | 2024-03-15 | 添加运行时依赖加载 |
| 1.2 | 2024-06-20 | 支持多选抠图方式 |
| 1.3 | 2024-09-10 | 优化模型搜索机制 |

---

**文档版本**: 1.3  
**最后更新**: 2026-05-16  
**适用节点**: GJJ_ComprehensiveMatting
