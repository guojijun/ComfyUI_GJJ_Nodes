# GJJ 节点开发完整规范

> **定位**：综合速查手册，覆盖开发同类 GJJ 节点所需的所有规范要点。  
> **参考节点**：`GJJ · 📢语音识别四文本TTS(Qwen3)` (`GJJ_Qwen3ASRTextFormats`)  
> **适用场景**：开发带 UI 交互（Boolean 按钮、生成按钮、一键复制、状态栏）的 GJJ 节点。

---

## 目录

1. [命名与目录规范](#1-命名与目录规范)
2. [节点安全注册方案](#2-节点安全注册方案)
3. [运行时依赖加载与友好提示](#3-运行时依赖加载与友好提示)
4. [Boolean 按钮做成一排方案](#4-boolean-按钮做成一排方案)
5. [节点内部添加【生成】按钮](#5-节点内部添加生成按钮)
6. [节点内部生成数据可一键复制](#6-节点内部生成数据可一键复制)
7. [示例列表安全载入](#7-示例列表安全载入)
8. [缺失模型或依赖时友好解决方案](#8-缺失模型或依赖时友好解决方案)

---

## 1. 命名与目录规范

### 1.1 目录结构

```
custom_nodes/GJJ/
├── nodes/                          # 后端 Python 节点
│   ├── __init__.py                 # 统一注册入口
│   ├── common_utils/               # 公共工具模块
│   │   ├── __init__.py
│   │   ├── dependency_checker.py   # 依赖检查工具
│   │   └── ...
│   └── gjj_<功能名>.py            # 具体节点文件（蛇形命名）
├── js/                             # 前端 JavaScript
│   └── gjj_<功能名>.js            # 具体节点前端文件
├── SKILL/                          # 文档
└── presets/                        # 预设配置
```

### 1.2 文件命名规则

- **Python 后端**：`gjj_` 前缀 + 小写蛇形命名（`gjj_qwen3_asr_text_formats.py`）
- **JavaScript 前端**：与后端同名，`.js` 扩展名（`gjj_qwen3_asr_text_formats.js`）
- **节点类名**：PascalCase（`GJJ_Qwen3ASRTextFormats`）

### 1.3 显示名称规则

**前台节点**（用户可见）：
- `NODE_DISPLAY_NAME_MAPPINGS` 写为 `"📢 语音识别四文本TTS(Qwen3)"` — **不要**加 `GJJ ·` 前缀
- `__init__.py` 的 `_normalize_display_name()` 会自动添加 `GJJ · ` 前缀
- 最终显示：`GJJ · 📢 语音识别四文本TTS(Qwen3)`

**后台/引用节点**（内部使用）：
- 使用 `guojijun_` 前缀命名类
- 显示名格式：`guojijun · <名称>（内部引用）`

```python
# ✅ 正确示例 — 前台节点
from nodes.GJJ import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

NODE_CLASS_MAPPINGS = {"GJJ_Qwen3ASRTextFormats": GJJ_Qwen3ASRTextFormats,}
NODE_DISPLAY_NAME_MAPPINGS = {"GJJ_Qwen3ASRTextFormats": "📢 语音识别四文本TTS(Qwen3)",}
    # ─── 注意：不要加 GJJ · 前缀 ───

# ✅ 正确示例 — 后台节点
NODE_DISPLAY_NAME_MAPPINGS = {"guojijun_qwen3_runtime": "Qwen3 运行时（内部引用）,}
```
### 1.4 分类设置
```python
class GJJ_Qwen3ASRTextFormats: CATEGORY = "GJJ/Audio"  # 格式：GJJ/<功能分类>
```
### 1.5 中文要求

**所有面向用户的文字必须是中文**：
- `RETURN_NAMES`（输出名）
- `OUTPUT_TOOLTIPS`（输出提示）
- widget 的 `display_name`、`tooltip`
- 前端按钮、标签、占位文本、提示信息

```python
RETURN_NAMES = ("时间戳表", "分段文本", "开始时间列表", "结束时间列表")
```

---

## 2. 节点安全注册方案

### 2.1 核心机制（`nodes/__init__.py` 自动处理）

GJJ 的 `__init__.py` 已实现统一的安全注册：

1. **逐模块安全导入**：`_safe_import_node_module()` 用 try/except 包裹每个模块
2. **依赖缺失跳过**：某个节点缺依赖时，只跳过该节点，不影响其他 GJJ 节点
3. **彩色控制台提示**：ANSI 颜色输出缺失依赖和安装命令
4. **可选节点白名单**：`OPTIONAL_NODE_MODULES` 集合中的节点允许单独跳过

### 2.2 在节点模块中注册

```python
# nodes/gjj_my_node.py

import os,sys,folder_paths
from server import PromptServer

# ═══════════════════════════════════════════════
# 1. 运行时依赖加载（懒加载模式）
# ═══════════════════════════════════════════════
_DEPS = {}

def _load_my_runtime():
    """运行时懒加载依赖库"""
    if _DEPS.get("_my_runtime_loaded"):
        return _DEPS
    
    python_exe = sys.executable
    
    try:
        import some_library  # noqa: F401
        _DEPS["_my_runtime_loaded"] = True
    except ImportError as exc:
        from .common_utils.dependency_checker import print_runtime_dependency_error, get_pip_install_command_text
        install_cmd = get_pip_install_command_text("some_library")
        print_runtime_dependency_error(
            node_name="我的节点",
            dependency_name="some_library",
            install_command=install_cmd,
            description="该节点需要 some_library Python 包才能运行",
            extra_info=f"原始导入错误：{exc}",
        )
        raise RuntimeError(f"运行时依赖缺失：some_library。详细信息请查看控制台。") from exc
    
    return _DEPS

# ═══════════════════════════════════════════════
# 2. 节点类定义
# ═══════════════════════════════════════════════
class GJJ_MyNode:
    CATEGORY = "GJJ/MyCategory"
    FUNCTION = "execute"
    OUTPUT_NODE = True
    
    # ... 节点实现 ...
    
    def execute(self, unique_id=None, extra_pnginfo=None, **kwargs):
        _load_my_runtime()  # 运行时检查依赖
        # ... 业务逻辑 ...

# ═══════════════════════════════════════════════
# 3. 注册到全局映射
# ═══════════════════════════════════════════════
NODE_CLASS_MAPPINGS = {
    "GJJ_MyNode": GJJ_MyNode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "GJJ_MyNode": "🔧 我的节点",   # 不含 GJJ · 前缀
}
```

### 2.3 主题色统一

由 `__init__.py` 自动设置，节点无需自行处理：

```python
# __init__.py 自动执行（节点无需关心）
setattr(node_cls, "NODE_COLOR", "#1B252B")       # Header 深色
setattr(node_cls, "BACKGROUND_COLOR", "#141B1F")  # Panel 深色
setattr(node_cls, "COLOR", "#1B252B")
setattr(node_cls, "BGCOLOR", "#141B1F")
setattr(node_cls, "BOX_COLOR", "#3E4D54")         # Outline
```

---

## 3. 运行时依赖加载与友好提示

### 3.1 懒加载模式

不在模块顶层 import，而在执行时加载：

```python
_DEPS = {}

def _load_my_runtime():
    """运行时懒加载依赖库"""
    if _DEPS.get("_loaded"):
        return _DEPS
    
    python_exe = sys.executable
    
    try:
        import soundfile  # noqa: F401
        import transformers  # noqa: F401
    except ImportError as exc:
        from .common_utils.dependency_checker import print_runtime_dependency_error, get_pip_install_command_text
        install_cmd = get_pip_install_command_text("soundfile transformers")
        print_runtime_dependency_error(
            node_name="📢 语音识别四文本TTS(Qwen3)",
            dependency_name="soundfile / transformers",
            install_command=install_cmd,
            description="该节点需要 soundfile 和 transformers 才能运行",
            extra_info=f"原始导入错误：{exc}",
        )
        raise RuntimeError("运行时依赖缺失：soundfile、transformers。详细信息请查看控制台。") from exc
    
    _DEPS["_loaded"] = True
    return _DEPS
``


### 3.2 时机：在 `execute()` / `generate()` 开头调用

```python
def execute(self, audio, unique_id=None, extra_pnginfo=None, **kwargs):
    _load_my_runtime()  # ⬅ 在函数体第一行调用
    # ... 后续业务逻辑 ...
```

### 3.3 公共函数 `print_runtime_dependency_error`

位置：`nodes/common_utils/dependency_checker.py`

```python
from .common_utils.dependency_checker import print_runtime_dependency_error, get_pip_install_command_text

print_runtime_dependency_error(
    node_name="📢 语音识别四文本TTS(Qwen3)",  # 节点名称
    dependency_name="qwen-asr",                # 缺失的依赖名
    install_command=get_pip_install_command_text("qwen-asr"),
    description="该节点需要 qwen-asr Python 包才能运行",
    extra_info=f"原始导入错误：{exc}",
)
```

### 3.4 公共函数 `get_pip_install_command_text`

位置：`nodes/common_utils/dependency_checker.py`

生成依赖安装命令文本（使用用户指定的完整 Python 路径和清华源）：

```python
from .common_utils.dependency_checker import get_pip_install_command_text

# 单个依赖
install_cmd = get_pip_install_command_text("imageio")
# 返回: & "C:\AI\CUI77\python.exe" -m pip install imageio -i https://pypi.tuna.tsinghua.edu.cn/simple --ignore-installed --target "C:\AI\CUI77\Lib\site-packages"

# 多个依赖
install_cmd = get_pip_install_command_text("imageio imageio-ffmpeg")
```

**特点**：
- 使用 `sys.executable` 获取实际 Python 路径
- 使用清华镜像源
- 添加 `--target` 参数安装到正确的 `Lib/site-packages` 目录
- 使用 `&` 前缀（PowerShell 风格），可直接复制到终端执行

### 3.6 控制台输出效果

```
================================================================================
  GJJ 节点运行时依赖缺失！
================================================================================
[GJJ] 节点: 📢 语音识别四文本TTS(Qwen3)
[GJJ] 该节点需要 qwen-asr Python 包才能运行

[GJJ] 快速安装命令:
  python.exe -m pip install qwen-asr -i https://pypi.tuna.tsinghua.edu.cn/simple

[GJJ] 提示: 安装完成后请重启 ComfyUI 服务器
================================================================================
```

### 3.7 关键点

- **必须**使用 `get_pip_install_command_text()` 生成安装命令（自动使用 `sys.executable`）
- **必须**使用清华镜像源（`-i https://pypi.tuna.tsinghua.edu.cn/simple`）
- **必须**添加 `--target` 参数安装到正确的 `Lib/site-packages` 目录
- **必须**在函数签名中包含 `unique_id` 和 `extra_pnginfo`
- 控制台错误由 `print_runtime_dependency_error` 统一格式打印
- 前端错误通过 `PromptServer` 事件推送（见第 8 章）

---

## 4. Boolean 按钮做成一排方案

### 4.1 核心思路：`node.properties` 方案

**不使用 widget 传递 Boolean 状态**，改用 `node.properties`：

- 前端按钮点击 → 直接写入 `node.properties`
- `node.properties` 自动序列化到工作流 JSON
- 后端通过 `extra_pnginfo` + `unique_id` 从 workflow 读取
- **不创建任何隐藏 widget，不会产生空行**

### 4.2 后端实现

#### 4.2.1 INPUT_TYPES：不定义 Boolean 参数

```python
@classmethod
def INPUT_TYPES(cls):
    return {
        "required": {
            "audio": ("AUDIO",),
            # ... 其他参数 ...
            # ⚠️ 不要在这里定义 segment_by_sentence、auto_download 等 Boolean 参数
        },
        "optional": {
            # ⚠️ 也不在这里定义 Boolean 参数
        },
        "hidden": {
            "unique_id": "UNIQUE_ID",        # ✅ 必须定义
            "extra_pnginfo": "EXTRA_PNGINFO", # ✅ 必须定义
        },
    }
```

#### 4.2.2 execute()：从 extra_pnginfo 读取 properties

```python
def execute(self, audio, unique_id=None, extra_pnginfo=None, **kwargs):
    # 从 properties 读取 Boolean 值
    props = {}
    try:
        if extra_pnginfo and isinstance(extra_pnginfo, dict):
            workflow = extra_pnginfo.get("workflow", {})
            if isinstance(workflow, dict):
                nodes = workflow.get("nodes", [])
                if isinstance(nodes, list):
                    uid = str(unique_id)
                    for n in nodes:
                        if isinstance(n, dict) and str(n.get("id")) == uid:
                            props = n.get("properties", {}) or {}
                            break
    except Exception:
        props = {}
    
    segment_by_sentence = bool(props.get("segment_by_sentence", True))
    auto_download = bool(props.get("auto_download", True))
    
    # 使用解析后的 Boolean 值
    # ...
```

**关键点**：
- `execute()` 签名中**不要**有 Boolean 参数（如 `segment_by_sentence`、`auto_download`）
- 必须包含 `unique_id=None` 和 `extra_pnginfo=None`
- 使用 `**kwargs` 接收其他未命名参数

### 4.3 前端实现

#### 4.3.1 彻底删除旧的 Boolean widgets

```javascript
const BOOL_WIDGETS = ["segment_by_sentence", "auto_download"];

function patchNode(node) {
    // 彻底删除旧的 Boolean widgets（处理从工作流加载的旧数据）
    BOOL_WIDGETS.forEach(widgetName => {
        const widgetIndex = (node.widgets || []).findIndex(w => w.name === widgetName);
        if (widgetIndex !== -1) {
            node.widgets.splice(widgetIndex, 1);  // ⬅ 从数组中删除，不是隐藏
        }
    });
    
    // 初始化 Boolean 状态
    BOOL_WIDGETS.forEach(widgetName => {
        if (!node.properties) node.properties = {};
        if (node.properties[widgetName] === undefined) {
            node.properties[widgetName] = true;  // 默认值
        }
    });
}
```

#### 4.3.2 创建 Boolean 按钮排

```javascript
const boolBtnRow = document.createElement("div");
boolBtnRow.style.cssText = "display:flex;gap:6px;margin-bottom:8px";

const boolButtons = {};
const boolConfigs = [
    { name: "segment_by_sentence", label: "📝 按句分段", default: true },
    { name: "auto_download", label: "⬇️ 自动下载", default: true },
];

boolConfigs.forEach(config => {
    const btn = document.createElement("button");
    btn.textContent = config.label;
    btn.title = config.name;
    btn.style.cssText = [
        "flex: 1",
        "background: #5aa8ff",    // 开启状态：蓝色
        "color: #fff",
        "border: none",
        "border-radius:4px",
        "padding: 4px 8px",
        "cursor: pointer",
        "font-size: 11px",
        "font-weight: bold",
        "transition: all 0.2s",
    ].join(";");

    btn.__boolValue = config.default;

    btn.addEventListener("click", () => {
        btn.__boolValue = !btn.__boolValue;
        // 切换样式
        if (btn.__boolValue) {
            btn.style.background = "#5aa8ff";   // 开启：蓝色
            btn.style.color = "#fff";
        } else {
            btn.style.background = "#3a3a3a";   // 关闭：灰色
            btn.style.color = "#aaa";
        }
        
        // 保存到 node.properties
        if (!node.properties) node.properties = {};
        node.properties[config.name] = btn.__boolValue;
        
        // 通知 ComfyUI 节点已更改
        node.setDirtyCanvas?.(true, true);
        node.graph?.setDirtyCanvas?.(true, true);
        node.graph?.change?.();
    });
    
    // 鼠标悬停效果
    btn.addEventListener("mouseenter", () => { btn.style.opacity = "0.85"; });
    btn.addEventListener("mouseleave", () => { btn.style.opacity = "1"; });
    
    boolBtnRow.appendChild(btn);
    boolButtons[config.name] = btn;
});
```

#### 4.3.3 从 properties 恢复按钮状态

```javascript
// 同步 Boolean 按钮状态（从 properties 初始化）
const status = node.__gjjMyStatus;
if (status?.boolButtons) {
    Object.entries(status.boolButtons).forEach(([name, btn]) => {
        const value = node.properties?.[name] ?? btn.__boolValue;
        btn.__boolValue = value;
        if (btn.__boolValue) {
            btn.style.background = "#5aa8ff";
            btn.style.color = "#fff";
        } else {
            btn.style.background = "#3a3a3a";
            btn.style.color = "#aaa";
        }
    });
}
```

### 4.4 数据流

```
用户点击按钮
    ↓
更新 btn.__boolValue + 样式
    ↓
保存到 node.properties
    ↓
ComfyUI 序列化 node.properties 到工作流 JSON
    ↓
后端通过 extra_pnginfo 获取 workflow
    ↓
通过 unique_id 找到当前节点 → 读取 properties
    ↓
获取 Boolean 值 → 执行逻辑
```

### 4.5 常见坑

| 坑 | 原因 | 解决 |
|----|------|------|
| `TypeError: missing required positional arguments` | 后端函数签名中仍有 Boolean 参数 | 从签名中移除 Boolean 参数，用 `**kwargs` |
| 控件还在（未隐藏） | 旧数据重建了 widget | 用 `splice()` 删除数组元素 |
| 空行出现 | 试图隐藏 widget 而非删除 | `splice()` 删除，不要 `hidden = true` |
| 按钮无法点击 | 隐藏 widget 遮挡 DOM | 本方案无隐藏 widget，不存在此问题 |

---

## 5. 节点内部添加【生成】按钮

### 5.1 功能说明

【生成】按钮仅需执行当前节点，不触发整个工作流队列。

### 5.2 核心实现：`queueOnlyCurrentNode()`

```javascript
function isExecutionOutputNode(node) {
    if (!node) return false;
    if (node.comfyClass === "GJJ_MyNode") return true;  // ⬅ 你的节点类名
    if (node.constructor?.nodeData?.output_node === true) return true;
    if (node.nodeData?.output_node === true) return true;
    if (node.flags?.output === true) return true;
    return false;
}

async function queueOnlyCurrentNode(node) {
    if (!node || !node.graph) return false;
    
    const graph = node.graph || app.graph;
    const allNodes = graph?._nodes || app.graph?._nodes || [];
    
    // 保存并临时禁用其他 OUTPUT_NODE 节点
    const savedModes = [];
    try {
        for (const n of allNodes) {
            if (!n || n === node) continue;
            if (isExecutionOutputNode(n)) {
                savedModes.push([n, n.mode]);
                n.mode = 2;  // ⬅ 临时禁用以阻止执行
            }
        }
        
        // 只选中当前节点
        if (app.canvas) {
            app.canvas.selected_nodes = {};
            app.canvas.selected_nodes[node.id] = node;
            app.canvas.selected_node = node;
        }
        
        node.setDirtyCanvas?.(true, true);
        
        if (typeof app.queuePrompt === "function") {
            await app.queuePrompt(0, 1);  // ⬅ 只执行 1 个节点
            return true;
        }
        return false;
    } finally {
        // 恢复所有被禁用的节点
        for (const [n, mode] of savedModes) {
            n.mode = mode;
        }
        
        if (app.canvas) {
            app.canvas.selected_nodes = {};
        }
        
        node.setDirtyCanvas?.(true, true);
    }
}
```

### 5.3 按钮绑定与防重复点击

```javascript
status.generateBtn.addEventListener("click", async () => {
    const btn = status.generateBtn;
    const originalText = btn.textContent;
    
    try {
        // 按钮状态切换（防重复点击）
        btn.textContent = "⏳ 生成中...";
        btn.disabled = true;
        btn.style.cursor = "not-allowed";
        btn.style.opacity = "0.65";
        
        setStatus(node, "正在生成文本...");
        
        const ok = await queueOnlyCurrentNode(node);
        if (!ok) {
            setStatus(node, "生成失败");
        }
    } catch (err) {
        console.error("[GJJ] 生成失败:", err);
        setStatus(node, "生成失败");
    } finally {
        // 延迟恢复按钮（避免过快点击）
        setTimeout(() => {
            btn.textContent = originalText;
            btn.disabled = false;
            btn.style.cursor = "pointer";
            btn.style.opacity = "1";
        }, 500);
    }
});
```

### 5.4 关键点

- 函数放在 `finally` 中恢复状态，确保即使出错也能恢复
- 按钮需延迟恢复（至少 500ms），防止连续点击
- `app.queuePrompt(0, 1)` 的第二个参数 `1` 表示只执行 1 个节点

---

## 6. 节点内部生成数据可一键复制

### 6.1 前端实现

#### 6.1.1 复制按钮（默认隐藏）

```javascript
const copyBtn = document.createElement("button");
copyBtn.textContent = "📋";
copyBtn.title = "复制生成的文本到剪贴板";
copyBtn.style.cssText = [
    "display:none",           // ⬅ 默认隐藏，有内容时才显示
    "background:#4a5a6a",
    "color:#fff",
    "border:none",
    "border-radius:4px",
    "padding:4px 8px",
    "cursor:pointer",
    "font-size:11px",
    "font-weight:bold",
    "white-space:nowrap",
    "height:fit-content",
].join(";");

copyBtn.addEventListener("click", () => {
    const text = status.textDisplay.textContent;
    if (text && text !== "（暂无生成文本）") {
        navigator.clipboard.writeText(text).then(() => {
            const originalText = copyBtn.textContent;
            copyBtn.textContent = "✅ 已复制";     // ⬅ 成功反馈
            setTimeout(() => {
                copyBtn.textContent = originalText;  // ⬅ 1.5秒后恢复
            }, 1500);
        }).catch(err => {
            console.error("[GJJ] 复制失败:", err);
            alert("复制失败，请手动选择文本复制");  // ⬅ 降级方案
        });
    } else {
        alert("暂无文本可复制");
    }
});
```

#### 6.1.2 数据到达时显示复制按钮

```javascript
// 在事件监听器中
api.addEventListener("gjj_my_node_data_ready", (event) => {
    const data = event.detail || {};
    const nodeId = data.node;
    const text = data.text || "";
    
    for (const node of app.graph?._nodes || []) {
        if (String(node.id) === String(nodeId)) {
            const status = node.__gjjMyStatus;
            if (status?.textDisplay) {
                status.textDisplay.textContent = text;
                status.textDisplay.style.color = "#c8d6e5";
                // ⬅ 显示复制按钮
                if (status.copyBtn) {
                    status.copyBtn.style.display = "block";
                    status.copyBtn.textContent = "📋";
                    status.copyBtn.style.background = "#4a5a6a";
                }
            }
            break;
        }
    }
});
```

### 6.2 复制按钮的两种模式

**正常模式**（数据生成成功）：
- 背景色 `#4a5a6a`（中性灰色）
- 文字 `📋`
- 点击后变 `✅ 已复制`，1.5 秒恢复

**错误模式**（安装命令复制）：
- 背景色 `#ff4757`（红色）
- 文字 `📋 复制安装命令`
- 点击后变 `✅ 已复制` + 背景色 `#2ed573`（绿色），1.5 秒恢复

### 6.3 状态栏设计

```javascript
// 状态栏 DOM 结构
box.appendChild(boolBtnRow);    // 第1行：Boolean 按钮排
box.appendChild(statusRow);     // 第2行：状态栏 + 生成按钮
box.appendChild(textRow);       // 第3行：文本显示区 + 复制按钮
```

---

## 7. 示例列表安全载入

### 7.1 后端实现

#### 7.1.1 INPUT_TYPES 中动态生成示例列表

```python
@classmethod
def INPUT_TYPES(cls):
    # 扫描示例音频目录
    example_dir = os.path.join(folder_paths.base_path, "custom_nodes", "GJJ", "models", "mp3")
    example_files = []
    
    if os.path.isdir(example_dir):
        try:
            for f in sorted(os.listdir(example_dir)):
                if f.lower().endswith(('.wav', '.mp3', '.flac', '.ogg', '.m4a')):
                    example_files.append(f)
        except Exception:
            pass
    
    # 空列表时添加占位符
    if not example_files:
        example_files = ["[无示例音频]"]
    
    return {
        "required": {
            "audio": ("AUDIO",),
            "example_audio": (example_files, {   # ⬅ 示例列表下拉
                "default": example_files[0],
                "display_name": "示例音频",
                "tooltip": "选择示例音频文件（位于 models/mp3 目录）",
            }),
            # ...
        },
    }
```

#### 7.1.2 execute() 中安全加载示例

```python
def execute(self, audio, example_audio=None, **kwargs):
    # 如果选择了示例音频，加载它
    if example_audio and example_audio != "[无示例音频]":
        try:
            example_path = os.path.join(
                folder_paths.base_path, "custom_nodes", "GJJ", "models", "mp3", example_audio
            )
            if os.path.isfile(example_path):
                import soundfile as sf
                waveform, sample_rate = sf.read(example_path)
                audio = {"waveform": waveform, "sample_rate": sample_rate}
        except Exception as e:
            print(f"[GJJ] 加载示例音频失败: {e}")
            # 继续使用传入的 audio 参数
    
    # 后续逻辑...
```

### 7.2 关键点

- 扫描目录时用 `try/except` 包裹，容错
- 空列表时添加 `"[无示例音频]"` 占位符
- 加载示例文件时有异常保护
- 示例目录放在 `custom_nodes/GJJ/models/` 下

---

## 8. 缺失模型或依赖时友好解决方案

### 8.1 三层错误处理机制

| 层级 | 时机 | 处理方式 |
|------|------|---------|
| 1️⃣ 启动时 | `__init__.py` 导入模块 | ANSI 彩色控制台 + 跳过节点 |
| 2️⃣ 执行时 | 节点 `execute()` 开头 | `print_runtime_dependency_error` + 抛出 RuntimeError |
| 3️⃣ 前端展示 | 后端通过事件推送 | 前端监听，DOM 展示错误 + 复制安装命令按钮 |

### 8.2 后端：通过 PromptServer 发送事件给前端

```python
from server import PromptServer

def _send_error_to_frontend(self, error_message: str, install_command: str = ""):
    """将错误信息和安装命令发送给前端"""
    try:
        PromptServer.instance.send_sync("gjj_my_node_error", {
            "node": self.unique_id,
            "error": error_message,
            "install_command": install_command,
        })
    except Exception:
        pass
```

### 8.3 后端：CUDA 错误自动检测与降级提示

```python
def execute(self, audio, unique_id=None, extra_pnginfo=None, **kwargs):
    try:
        _load_my_runtime()
        
        # 尝试 CUDA 推理...
        result = model.generate(audio, device="cuda")
        
    except (ImportError, ModuleNotFoundError) as exc:
        from .common_utils.dependency_checker import get_pip_install_command_text
        missing_pkg = _extract_missing_package(str(exc))
        install_cmd = get_pip_install_command_text(missing_pkg)
        
        _send_error_to_frontend(
            error_message=f"缺少 Python 依赖：{missing_pkg}",
            install_command=install_cmd,
        )
        raise RuntimeError(f"运行时依赖缺失：{missing_pkg}。详细信息请查看控制台。") from exc
        
    except RuntimeError as e:
        error_str = str(e)
        if "CUDA" in error_str or "cuda" in error_str.lower():
            # 自动检测 CUDA 错误，提示降级到 CPU
            _send_error_to_frontend(
                error_message=f"CUDA 错误，请尝试在启动参数中添加 '--cpu' 或设置 CUDA_VISIBLE_DEVICES=''",
            )
        raise
        
    except Exception as e:
        error_str = str(e)
        _send_error_to_frontend(error_message=error_str)
        raise
```

### 8.4 后端：模型扫描与自动发现

```python
def _scan_models(model_dir, extensions=(".pt", ".safetensors", ".bin", ".pth")):
    """扫描目录下的模型文件"""
    models = []
    if os.path.isdir(model_dir):
        try:
            for f in sorted(os.listdir(model_dir)):
                if any(f.lower().endswith(ext) for ext in extensions):
                    models.append(f)
        except Exception:
            pass
    return models

@classmethod
def INPUT_TYPES(cls):
    # 扫描 ComfyUI models 目录
    asr_dir = os.path.join(folder_paths.models_dir, "Qwen3-ASR")
    asr_models = _scan_models(asr_dir)
    if not asr_models:
        asr_models = ["[未找到 Qwen3-ASR 模型]"]
    
    return {
        "required": {
            "asr_model_name": (asr_models, {
                "default": asr_models[0],
                "display_name": "ASR 模型",
            }),
            # ...
        },
    }
```

### 8.5 前端：监听错误事件并展示

```javascript
api.addEventListener("gjj_my_node_error", (event) => {
    try {
        const data = event.detail || {};
        const nodeId = data.node;
        const errorMessage = data.error || "";
        const installCommand = data.install_command || "";
        
        if (!nodeId || !errorMessage) return;
        
        for (const node of app.graph?._nodes || []) {
            if (String(node.id) === String(nodeId)) {
                const status = node.__gjjMyStatus;
                if (status?.textDisplay) {
                    let displayText = `❌ 执行失败：\n\n${errorMessage}`;
                    
                    if (installCommand) {
                        displayText += `\n\n🔧 快速安装命令（点击按钮复制）：`;
                    }
                    
                    status.textDisplay.textContent = displayText;
                    status.textDisplay.style.color = "#ff6b6b";  // 红色错误提示
                    
                    // 显示复制按钮，变红色
                    if (status.copyBtn) {
                        status.copyBtn.style.display = "block";
                        status.copyBtn.textContent = "📋 复制安装命令";
                        status.copyBtn.style.background = "#ff4757";
                        status.copyBtn.style.color = "#fff";
                        
                        // 重新绑定事件：复制安装命令
                        const newCopyBtn = status.copyBtn.cloneNode(true);
                        status.copyBtn.parentNode.replaceChild(newCopyBtn, status.copyBtn);
                        status.copyBtn = newCopyBtn;
                        
                        status.copyBtn.addEventListener("click", () => {
                            if (installCommand) {
                                navigator.clipboard.writeText(installCommand).then(() => {
                                    status.copyBtn.textContent = "✅ 已复制";
                                    status.copyBtn.style.background = "#2ed573";
                                    setTimeout(() => {
                                        status.copyBtn.textContent = "📋 复制安装命令";
                                        status.copyBtn.style.background = "#ff4757";
                                    }, 1500);
                                }).catch(err => {
                                    alert("复制失败，请手动选择安装命令复制");
                                });
                            }
                        });
                    }
                    
                    setStatus(node, "执行失败");
                }
                break;
            }
        }
    } catch (err) {
        console.error("[GJJ] 处理错误事件失败:", err);
    }
});
```

### 8.6 前端：进度事件监听

```javascript
api.addEventListener("gjj_node_progress", (event) => {
    const detail = event?.detail || {};
    const targetId = String(detail?.node || "");
    for (const node of app.graph?._nodes || []) {
        if (String(node.id) === targetId) {
            const status = node.__gjjMyStatus;
            if (status) {
                status.label.textContent = detail.text || "执行中...";
                if (detail.progress != null) {
                    const pct = Math.round(detail.progress * 100);
                    status.bar.style.width = `${pct}%`;
                }
            }
        }
    }
});
```

### 8.7 完整错误处理流程图

```
节点执行
    ├── ImportError → 提取包名 → 生成安装命令
    │                    ↓
    │              print_runtime_dependency_error (控制台彩色)
    │                    ↓
    │              PromptServer.send_sync (推给前端)
    │                    ↓
    │              前端展示错误 + 红色复制按钮
    │
    ├── RuntimeError (CUDA) → 自动检测 → 提示 CPU 降级
    │
    └── 其他 Exception → 通用错误信息 → 前端展示
```

---

## 附录 A：节点完整模板

### A.1 后端 Python 模板

```python
"""
GJJ_MyNode 节点 — 功能简述
"""
import os
import sys
import folder_paths
from server import PromptServer


# ═══ 运行时依赖加载 ═══
_DEPS = {}

def _load_my_runtime():
    if _DEPS.get("_loaded"):
        return _DEPS
    python_exe = sys.executable
    try:
        import some_lib  # noqa: F401
    except ImportError as exc:
        from .common_utils.dependency_checker import print_runtime_dependency_error, get_pip_install_command_text
        install_cmd = get_pip_install_command_text("some_lib")
        print_runtime_dependency_error(
            node_name="我的节点",
            dependency_name="some_lib",
            install_command=install_cmd,
            description="该节点需要 some_lib 才能运行",
            extra_info=f"原始错误：{exc}",
        )
        raise RuntimeError("运行时依赖缺失：some_lib") from exc
    _DEPS["_loaded"] = True
    return _DEPS


# ═══ 辅助函数 ═══
def _send_error(node_id, error_msg, install_cmd=""):
    try:
        PromptServer.instance.send_sync("gjj_my_node_error", {
            "node": node_id, "error": error_msg, "install_command": install_cmd,
        })
    except Exception:
        pass

def _extract_missing_package(error_str):
    import re
    match = re.search(r"No module named ['\"]([^'\"]+)['\"]", error_str)
    return match.group(1).split(".")[0] if match else "未知包"


# ═══ 节点类 ═══
class GJJ_MyNode:
    CATEGORY = "GJJ/MyCategory"
    FUNCTION = "execute"
    OUTPUT_NODE = True
    
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("输出文本",)
    OUTPUT_TOOLTIPS = ("处理后的文本结果",)
    
    @classmethod
    def INPUT_TYPES(cls):
        # 扫描示例文件
        example_dir = os.path.join(folder_paths.base_path, "custom_nodes", "GJJ", "models", "examples")
        examples = []
        if os.path.isdir(example_dir):
            try:
                examples = sorted([f for f in os.listdir(example_dir) if f.endswith(".txt")])
            except Exception:
                pass
        if not examples:
            examples = ["[无示例文件]"]
        
        return {
            "required": {
                "input_text": ("STRING", {"multiline": True, "display_name": "输入文本"}),
                "example_file": (examples, {"default": examples[0], "display_name": "示例文件"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }
    
    def execute(self, input_text, example_file=None, unique_id=None, extra_pnginfo=None, **kwargs):
        # 1. 依赖检查
        _load_my_runtime()
        
        # 2. 读取 properties 中的 Boolean 值
        props = {}
        try:
            workflow = (extra_pnginfo or {}).get("workflow", {})
            nodes = workflow.get("nodes", []) if isinstance(workflow, dict) else []
            for n in nodes:
                if isinstance(n, dict) and str(n.get("id")) == str(unique_id):
                    props = n.get("properties", {}) or {}
                    break
        except Exception:
            pass
        
        enable_feature = bool(props.get("enable_feature", True))
        
        # 3. 发送进度
        def _progress(text, progress):
            try:
                PromptServer.instance.send_sync("gjj_node_progress", {
                    "node": unique_id, "text": text, "progress": progress,
                })
            except Exception:
                pass
        
        _progress("开始处理...", 0.0)
        
        # 4. 业务逻辑
        try:
            result = f"处理完成：{input_text[:50]}..." if enable_feature else input_text
            
            _progress("完成", 1.0)
            
            # 5. 发送结果给前端
            try:
                PromptServer.instance.send_sync("gjj_my_node_data_ready", {
                    "node": unique_id, "text": result,
                })
            except Exception:
                pass
            
            return (result,)
            
        except (ImportError, ModuleNotFoundError) as exc:
            from .common_utils.dependency_checker import get_pip_install_command_text
            pkg = _extract_missing_package(str(exc))
            install_cmd = get_pip_install_command_text(pkg)
            _send_error(str(unique_id), f"缺少依赖：{pkg}", install_cmd)
            raise
        
        except Exception as e:
            _send_error(str(unique_id), str(e))
            raise


# ═══ 注册 ═══
NODE_CLASS_MAPPINGS = {"GJJ_MyNode": GJJ_MyNode}
NODE_DISPLAY_NAME_MAPPINGS = {"GJJ_MyNode": "🔧 我的节点"}
```

### A.2 前端 JavaScript 模板

```javascript
/**
 * GJJ_MyNode 节点前端扩展
 * - Boolean 按钮（node.properties 方案）
 * - 【生成】按钮（queueOnlyCurrentNode）
 * - 状态栏 + 一键复制 + 错误展示
 */
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

(function () {
    const STATUS_WIDGET_NAME = "__gjj_my_node_status";
    const BOOL_WIDGETS = ["enable_feature"];
    
    function isExecutionOutputNode(node) {
        if (!node) return false;
        if (node.comfyClass === "GJJ_MyNode") return true;
        if (node.constructor?.nodeData?.output_node === true) return true;
        if (node.nodeData?.output_node === true) return true;
        if (node.flags?.output === true) return true;
        return false;
    }
    
    async function queueOnlyCurrentNode(node) {
        if (!node || !node.graph) return false;
        const graph = node.graph || app.graph;
        const allNodes = graph?._nodes || [];
        const savedModes = [];
        try {
            for (const n of allNodes) {
                if (!n || n === node) continue;
                if (isExecutionOutputNode(n)) {
                    savedModes.push([n, n.mode]);
                    n.mode = 2;
                }
            }
            if (app.canvas) {
                app.canvas.selected_nodes = {};
                app.canvas.selected_nodes[node.id] = node;
            }
            if (typeof app.queuePrompt === "function") {
                await app.queuePrompt(0, 1);
                return true;
            }
            return false;
        } finally {
            for (const [n, mode] of savedModes) n.mode = mode;
            if (app.canvas) app.canvas.selected_nodes = {};
        }
    }
    
    function setStatus(node, text, progress) {
        const s = node.__gjjMyStatus;
        if (!s) return;
        s.label.textContent = text;
        if (progress != null) s.bar.style.width = `${Math.round(progress * 100)}%`;
    }
    
    function ensureStatusWidget(node) {
        if (node.__gjjMyStatus) return node.__gjjMyStatus;
        
        const box = document.createElement("div");
        box.style.cssText = "padding:6px 10px;border:1px solid #41535b;border-radius:8px;background:#121a1f;color:#dce7e2;font-size:12px";
        
        // 第1行：Boolean 按钮排
        const boolBtnRow = document.createElement("div");
        boolBtnRow.style.cssText = "display:flex;gap:6px;margin-bottom:8px";
        const boolButtons = {};
        [{ name: "enable_feature", label: "🔧 启用功能", default: true }].forEach(cfg => {
            const btn = document.createElement("button");
            btn.textContent = cfg.label;
            btn.__boolValue = cfg.default;
            btn.style.cssText = "flex:1;background:#5aa8ff;color:#fff;border:none;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:11px;font-weight:bold";
            btn.addEventListener("click", () => {
                btn.__boolValue = !btn.__boolValue;
                btn.style.background = btn.__boolValue ? "#5aa8ff" : "#3a3a3a";
                btn.style.color = btn.__boolValue ? "#fff" : "#aaa";
                if (!node.properties) node.properties = {};
                node.properties[cfg.name] = btn.__boolValue;
                node.setDirtyCanvas?.(true, true);
                node.graph?.change?.();
            });
            boolBtnRow.appendChild(btn);
            boolButtons[cfg.name] = btn;
        });
        box.appendChild(boolBtnRow);
        
        // 第2行：状态栏 + 生成按钮
        const statusRow = document.createElement("div");
        statusRow.style.cssText = "display:flex;gap:8px;align-items:center";
        const statusContent = document.createElement("div");
        statusContent.style.cssText = "flex:1";
        const label = document.createElement("div");
        label.textContent = "等待执行";
        label.style.cssText = "margin-bottom:4px";
        const track = document.createElement("div");
        track.style.cssText = "height:5px;overflow:hidden;border-radius:999px;background:#27343b";
        const bar = document.createElement("div");
        bar.style.cssText = "width:0%;height:100%;border-radius:999px;background:#5aa8ff;transition:width 160ms ease";
        track.appendChild(bar);
        statusContent.append(label, track);
        const genBtn = document.createElement("button");
        genBtn.textContent = "🚀 生成";
        genBtn.style.cssText = "background:#2d5a9e;color:#fff;border:none;border-radius:4px;padding:4px 12px;cursor:pointer;font-size:11px;font-weight:bold;white-space:nowrap";
        genBtn.addEventListener("click", async () => {
            const origText = genBtn.textContent;
            try {
                genBtn.textContent = "⏳ 生成中...";
                genBtn.disabled = true;
                setStatus(node, "正在生成...");
                await queueOnlyCurrentNode(node);
            } catch (e) { console.error(e); }
            finally {
                setTimeout(() => { genBtn.textContent = origText; genBtn.disabled = false; }, 500);
            }
        });
        statusRow.append(statusContent, genBtn);
        box.appendChild(statusRow);
        
        // 第3行：文本显示区 + 复制按钮
        const textRow = document.createElement("div");
        textRow.style.cssText = "margin-top:8px;display:flex;gap:6px";
        const textDisplay = document.createElement("div");
        textDisplay.style.cssText = "flex:1;padding:8px;background:#1a2329;border:1px solid #3a4a52;border-radius:4px;font-family:monospace;font-size:11px;max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;color:#c8d6e5";
        textDisplay.textContent = "（暂无生成数据）";
        textRow.appendChild(textDisplay);
        const copyBtn = document.createElement("button");
        copyBtn.textContent = "📋";
        copyBtn.style.cssText = "display:none;background:#4a5a6a;color:#fff;border:none;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:11px;font-weight:bold;white-space:nowrap;height:fit-content";
        copyBtn.addEventListener("click", () => {
            const t = textDisplay.textContent;
            if (t && t !== "（暂无生成数据）") {
                navigator.clipboard.writeText(t).then(() => {
                    copyBtn.textContent = "✅ 已复制";
                    setTimeout(() => { copyBtn.textContent = "📋"; }, 1500);
                }).catch(() => alert("复制失败"));
            }
        });
        textRow.appendChild(copyBtn);
        box.appendChild(textRow);
        
        const statusObj = { label, bar, generateBtn: genBtn, boolButtons, textDisplay, copyBtn };
        const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
            serialize: false, hideOnZoom: false,
            getHeight: () => 240,
        });
        statusObj.widget = widget;
        node.__gjjMyStatus = statusObj;
        return statusObj;
    }
    
    function patchNode(node) {
        if (!node || node.__gjjMyNodePatched) return;
        node.__gjjMyNodePatched = true;
        ensureStatusWidget(node);
        setStatus(node, "等待执行");
        
        // 删除旧 Boolean widgets
        BOOL_WIDGETS.forEach(name => {
            const idx = (node.widgets || []).findIndex(w => w.name === name);
            if (idx !== -1) node.widgets.splice(idx, 1);
        });
        
        // 初始化 properties
        BOOL_WIDGETS.forEach(name => {
            if (!node.properties) node.properties = {};
            if (node.properties[name] === undefined) node.properties[name] = true;
        });
        
        // 恢复 Boolean 按钮状态
        const s = node.__gjjMyStatus;
        if (s?.boolButtons) {
            Object.entries(s.boolButtons).forEach(([name, btn]) => {
                const v = node.properties?.[name] ?? btn.__boolValue;
                btn.__boolValue = v;
                btn.style.background = v ? "#5aa8ff" : "#3a3a3a";
                btn.style.color = v ? "#fff" : "#aaa";
            });
        }
    }
    
    app.registerExtension({
        name: "GJJ.MyNode",
        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData?.name === "GJJ_MyNode") {
                const orig = nodeType.prototype.onNodeCreated;
                nodeType.prototype.onNodeCreated = function () {
                    const r = orig?.apply(this, arguments);
                    patchNode(this);
                    return r;
                };
            }
        },
        async setup() {
            // 数据就绪事件
            api.addEventListener("gjj_my_node_data_ready", (event) => {
                const d = event.detail || {};
                for (const node of app.graph?._nodes || []) {
                    if (String(node.id) === String(d.node)) {
                        const s = node.__gjjMyStatus;
                        if (s?.textDisplay) {
                            s.textDisplay.textContent = d.text || "";
                            s.textDisplay.style.color = "#c8d6e5";
                            if (s.copyBtn) s.copyBtn.style.display = "block";
                        }
                    }
                }
            });
            
            // 错误事件
            api.addEventListener("gjj_my_node_error", (event) => {
                const d = event.detail || {};
                for (const node of app.graph?._nodes || []) {
                    if (String(node.id) === String(d.node)) {
                        const s = node.__gjjMyStatus;
                        if (s?.textDisplay) {
                            s.textDisplay.textContent = `❌ ${d.error || ""}`;
                            s.textDisplay.style.color = "#ff6b6b";
                            if (s.copyBtn && d.install_command) {
                                s.copyBtn.style.display = "block";
                                s.copyBtn.textContent = "📋 复制安装命令";
                                s.copyBtn.style.background = "#ff4757";
                                const newBtn = s.copyBtn.cloneNode(true);
                                s.copyBtn.parentNode.replaceChild(newBtn, s.copyBtn);
                                s.copyBtn = newBtn;
                                s.copyBtn.addEventListener("click", () => {
                                    navigator.clipboard.writeText(d.install_command).then(() => {
                                        s.copyBtn.textContent = "✅ 已复制";
                                        s.copyBtn.style.background = "#2ed573";
                                    });
                                });
                            }
                        }
                    }
                }
            });
        },
    });
})();
```

---

## 附录 B：关键检查清单

开发 GJJ 节点时请逐项确认：

- [ ] 文件命名：`gjj_<snake_case>.py` + `gjj_<snake_case>.js`
- [ ] 类名 PascalCase，`CATEGORY` 为 `"GJJ/<分类>"`
- [ ] `NODE_DISPLAY_NAME_MAPPINGS` 不含 `GJJ ·` 前缀（格式：`"emoji 中文"`）
- [ ] 所有面向用户文字为中文
- [ ] 运行时依赖用懒加载（`_load_xxx_runtime()`）模式
- [ ] 使用 `sys.executable` + 清华镜像源生成安装命令
- [ ] Boolean 参数用 `node.properties` 方案，不在 `INPUT_TYPES` 中定义
- [ ] `execute()` 签名中包含 `unique_id=None, extra_pnginfo=None, **kwargs`
- [ ] 前端用 `splice()` 删除旧 Boolean widget
- [ ] 生成按钮用 `queueOnlyCurrentNode()` + 防重复点击
- [ ] 复制按钮使用 `navigator.clipboard` + 反馈提示
- [ ] 错误通过 `PromptServer.send_sync` 推给前端
- [ ] 前端监听自定义事件处理错误和进度
- [ ] 示例列表有空值保护（`"[无示例]"` 占位符）
- [ ] 模型扫描在 `INPUT_TYPES` 中动态完成

---

> **参考节点源码**：`nodes/gjj_qwen3_asr_text_formats.py` + `js/gjj_qwen3_asr_text_formats.js`  
> **相关文档**：`SKILL/07-general-guides/error_presentation_spec.md`、`SKILL/general/comfyui_boolean_to_button_no_empty_lines.md`
