# GJJ 节点错误提示实现规范

## 📋 概述

本文档定义了 GJJ 节点的错误提示标准实现方式，包括后端错误处理和前端展示规范。

**参考节点**：`GJJ_Qwen3ASRTextFormats`（语音识别四文本TTS(Qwen3)）

---

## 🎯 目标

1. **友好的错误提示**：在节点面板内显示详细的错误信息和解决方案
2. **一键复制安装命令**：错误时显示可复制的安装命令按钮
3. **彩色控制台输出**：使用 ANSI 颜色代码美化终端输出
4. **前后端联动**：后端发送事件 → 前端监听并展示

---

## 🏗️ 架构设计

### 前后端数据流

```
后端 (Python)                     前端 (JavaScript)
─────────────                    ──────────────────
1. 运行时检查依赖
2. 发现依赖缺失
3. 控制台彩色打印
4. 发送错误事件 ────────────────>  5. 监听 gjj_node_error 事件
6. 显示红色文本 + 安装命令          6. 更新节点面板 UI
                                  7. 显示"复制安装命令"按钮
                                  8. 用户点击按钮
                                  9. 复制到剪贴板
```

---

##  后端实现规范

### 1. 运行时依赖检查

**位置**：节点函数开头或专用的 `_load_xxx_runtime()` 函数

```python
def _load_xxx_runtime():
    """加载运行时依赖，失败时提供友好提示"""
    try:
        from xxx_package import SomeClass
        return SomeClass
    except Exception as exc:
        # 获取当前 Python 解释器的实际路径
        import sys
        python_executable = sys.executable

        # ANSI 颜色代码（用于控制台彩色输出）
        RED = '\033[91m'
        YELLOW = '\033[93m'
        CYAN = '\033[96m'
        GREEN = '\033[92m'
        RESET = '\033[0m'
        BOLD = '\033[1m'

        # 构建安装命令
        install_cmd = f"{python_executable} -m pip install xxx-package -i https://pypi.tuna.tsinghua.edu.cn/simple"

        # 在控制台打印美观的错误提示
        print(f"\n{RED}{'=' * 80}{RESET}")
        print(f"{RED}{BOLD}  GJJ 节点运行时依赖缺失！{RESET}")
        print(f"{RED}{'=' * 80}{RESET}")
        print(f"{YELLOW}[GJJ] {BOLD}节点:{RESET} {CYAN}节点显示名称{RESET}")
        print(f"{YELLOW}[GJJ] {BOLD}缺失依赖:{RESET} {RED}{BOLD}xxx-package{RESET}")
        print(f"{YELLOW}[GJJ]{RESET} 该节点需要 xxx-package Python 包才能运行。\n")
        print(f"{YELLOW}{BOLD} 快速安装命令:{RESET}")
        print(f"{GREEN}{BOLD}  {install_cmd}{RESET}\n")
        print(f"{YELLOW}{BOLD} 提示:{RESET} 安装后请重启 ComfyUI 服务器")
        print(f"{RED}{'=' * 80}{RESET}\n")

        raise RuntimeError(
            "\n 未找到 xxx-package 运行库。\n"
            "\n"
            "这个 GJJ 节点需要 xxx-package Python 包才能运行。\n"
            "\n"
            " 必需依赖（请安装）：\n"
            "  • xxx-package (功能描述)\n"
            "\n"
            "🔧 快速安装命令（使用实际 Python 路径）：\n"
            f"{install_cmd}\n"
            "\n"
            f"原始导入错误：{exc}\n"
            "\n"
            " 提示：安装后请重启 ComfyUI 服务器。"
        ) from exc
```

### 2. 错误事件发送

**位置**：节点主函数的 `except` 块中

```python
def generate(self, ..., unique_id=None, extra_pnginfo=None):
    try:
        # 节点执行逻辑...
        pass
    except Exception as exc:
        _send_status(unique_id, f"执行失败：{exc}", 1.0)

        # 如果原始错误包含详细安装命令（来自 _load_xxx_runtime），则保留它
        if isinstance(exc, RuntimeError) and "未找到 xxx-package 运行库" in str(exc):
            # 提取安装命令
            error_str = str(exc)
            install_command = ""
            # 尝试从错误信息中提取安装命令（包含 pip install 的行）
            import re
            match = re.search(r'(.+?python\.exe.*?pip install xxx-package.*?)\n', error_str)
            if match:
                install_command = match.group(1).strip()

            # 发送错误事件到前端
            try:
                from server import PromptServer
                PromptServer.instance.send_sync("gjj_node_error", {
                    "node": str(unique_id),
                    "error": error_str,
                    "install_command": install_command,
                })
            except Exception:
                pass

            # 抛出简洁的错误信息（在默认错误区域显示）
            raise RuntimeError("运行时依赖缺失：xxx-package。详细信息请查看节点前端面板。") from exc
        else:
            # 其他错误使用标准格式
            raise RuntimeError(
                f" 节点执行失败\n"
                f"参数：xxx\n\n"
                f"详细错误：{exc}"
            ) from exc
```

### 3. 错误事件命名规范

| 事件名称 | 格式 | 示例 |
|---------|------|------|
| 进度事件 | `gjj_node_progress` | 通用事件 |
| 完成事件 | `gjj_node_completed` | 通用事件 |
| 错误事件 | `gjj_{node_type}_error` | `gjj_qwen3_error`、`gjj_faster_whisper_error` |
| 生成事件 | `gjj_{node_type}_generated` | `gjj_qwen3_text_generated`、`gjj_faster_whisper_generated` |

**推荐**：使用节点类型作为前缀，如 `gjj_qwen3_error`、`gjj_fish_audio_error`

---

## 🎨 前端实现规范

### 1. 状态栏创建

**位置**：`ensureStatusWidget()` 函数中

```javascript
function ensureStatusWidget(node) {
    if (node.__gjjNodeStatus) {
        return node.__gjjNodeStatus;
    }
    
    const box = document.createElement("div");
    box.style.cssText = [
        "padding:6px 10px",
        "border:1px solid #41535b",
        "border-radius:8px",
        "background:#121a1f",
        "color:#dce7e2",
        "font-size:12px",
        "line-height:1.35",
        "white-space:pre-wrap",
        "word-break:break-word",
    ].join(";");

    // 状态栏内容...
    
    const widget = node.addDOMWidget?.("status_display", "Status Display", box, {
        serialize: false,
        hideOnZoom: false,
        getHeight: () => 240, // 根据内容动态调整
    });

    node.__gjjNodeStatus = { widget, box, textDisplay, copyBtn, ... };
    return node.__gjjNodeStatus;
}
```

### 2. 错误事件监听

**位置**：`app.registerExtension` 的 `setup()` 方法中

```javascript
app.registerExtension({
    name: "GJJ.YourNodeName",
    async setup(app) {
        // 监听后端发送的运行时错误事件（包含安装命令）
        api.addEventListener("gjj_node_error", (event) => {
            try {
                const data = event.detail || {};
                const nodeId = data.node;
                const errorMessage = data.error || "";
                const installCommand = data.install_command || "";

                if (!nodeId || !errorMessage) return;

                // 查找对应的节点
                const nodes = app.graph?._nodes || [];
                for (const node of nodes) {
                    if (String(node.id) === String(nodeId)) {
                        const status = node.__gjjNodeStatus;
                        if (status?.textDisplay) {
                            // 显示错误信息
                            let displayText = `❌ 执行失败：\n\n${errorMessage}`;

                            // 如果有安装命令，添加提示
                            if (installCommand) {
                                displayText += `\n\n🔧 快速安装命令（点击按钮复制）：`;
                            }

                            status.textDisplay.textContent = displayText;
                            status.textDisplay.style.color = "#ff6b6b";

                            // 显示复制按钮
                            if (status.copyBtn) {
                                status.copyBtn.style.display = "block";
                                status.copyBtn.textContent = "📋 复制安装命令";
                                status.copyBtn.title = "复制安装命令到剪贴板";
                                status.copyBtn.style.background = "#ff4757";
                                status.copyBtn.style.color = "#fff";

                                // 更新复制按钮事件，复制安装命令
                                const newCopyBtn = status.copyBtn.cloneNode(true);
                                status.copyBtn.parentNode.replaceChild(newCopyBtn, status.copyBtn);
                                status.copyBtn = newCopyBtn;

                                status.copyBtn.addEventListener("click", () => {
                                    if (installCommand) {
                                        navigator.clipboard.writeText(installCommand).then(() => {
                                            const originalText = status.copyBtn.textContent;
                                            status.copyBtn.textContent = "✅ 已复制";
                                            status.copyBtn.style.background = "#2ed573";
                                            setTimeout(() => {
                                                status.copyBtn.textContent = originalText;
                                                status.copyBtn.style.background = "#ff4757";
                                            }, 1500);
                                        }).catch(err => {
                                            console.error("[GJJ] 复制失败:", err);
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
    },
});
```

### 3. 复制按钮实现

**功能**：一键复制安装命令到剪贴板

```javascript
// 复制按钮点击事件
status.copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(installCommand).then(() => {
        // 复制成功：显示"已复制"并变绿
        const originalText = status.copyBtn.textContent;
        status.copyBtn.textContent = "✅ 已复制";
        status.copyBtn.style.background = "#2ed573";
        
        // 1.5 秒后恢复
        setTimeout(() => {
            status.copyBtn.textContent = originalText;
            status.copyBtn.style.background = "#ff4757";
        }, 1500);
    }).catch(err => {
        console.error("[GJJ] 复制失败:", err);
        alert("复制失败，请手动选择安装命令复制");
    });
});
```

---

## 📊 完整实现检查清单

### 后端 (Python)

- [ ] ✅ 创建 `_load_xxx_runtime()` 函数
- [ ] ✅ 控制台彩色输出（ANSI 颜色代码）
- [ ] ✅ 使用实际 Python 路径构建安装命令
- [ ] ✅ 使用国内镜像源（清华源）
- [ ] ✅ 抛出包含详细信息的 `RuntimeError`
- [ ] ✅ 主函数 `except` 块捕获错误
- [ ] ✅ 提取安装命令（正则匹配）
- [ ] ✅ 发送 `gjj_node_error` 事件到前端
- [ ] ✅ 重新抛出简洁错误信息

### 前端 (JavaScript)

- [ ] ✅ 创建 `ensureStatusWidget()` 函数
- [ ] ✅ 添加文本显示区域
- [ ] ✅ 添加复制按钮（默认隐藏）
- [ ] ✅ 监听 `gjj_node_error` 事件
- [ ] ✅ 解析错误数据和安装命令
- [ ] ✅ 显示错误信息（红色文本）
- [ ] ✅ 显示复制按钮并更新样式
- [ ] ✅ 实现复制功能（`navigator.clipboard`）
- [ ] ✅ 复制成功后显示反馈（变绿）

---

##  UI 样式规范

### 错误显示区域

```css
/* 容器 */
padding: 6px 10px;
border: 1px solid #41535b;
border-radius: 8px;
background: #121a1f;
color: #dce7e2;

/* 错误文本 */
color: #ff6b6b;  /* 红色 */
white-space: pre-wrap;
word-break: break-word;

/* 复制按钮（错误状态） */
background: #ff4757;  /* 红色 */
color: #fff;

/* 复制按钮（成功状态） */
background: #2ed573;  /* 绿色 */
```

### 文本格式

```
❌ 执行失败：

未找到 qwen-asr 运行库。

这个 GJJ 节点不依赖原 Comfyui_SynVow_Qwen3ASR 插件，
但 Qwen3-ASR 模型本身需要 qwen-asr Python 包。

 必需依赖（请安装）：
 • qwen-asr (Qwen3-ASR 语音识别运行库)

🔧 快速安装命令（使用实际 Python 路径）：
D:\AI\CUI\python_embeded\python.exe -m pip install qwen-asr -i https://pypi.tuna.tsinghua.edu.cn/simple

原始导入错误：No module named 'qwen_asr'

 提示：安装后请重启 ComfyUI 服务器。

🔧 快速安装命令（点击按钮复制）：
```

---

## 📚 参考实现

| 节点 | 后端文件 | 前端文件 |
|------|---------|---------|
| Qwen3 ASR | `nodes/gjj_qwen3_asr_text_formats.py` | `js/gjj_qwen3_asr_text_formats.js` |
| Faster Whisper ASR | `nodes/gjj_faster_whisper_asr.py` | `js/gjj_faster_whisper_asr.js` |
| FishAudioS2 | `nodes/gjj_fish_audio_s2_generator.py` | `js/gjj_fish_audio_s2_generator.js` |

---

## ⚠️ 注意事项

1. **事件命名**：使用节点特定前缀避免冲突，如 `gjj_qwen3_error`
2. **安装命令提取**：使用正则 `(.+?python\.exe.*?pip install xxx.*?)\n` 提取
3. **剪贴板 API**：使用 `navigator.clipboard.writeText()`，需要 HTTPS 或 localhost
4. **错误处理**：后端和前端都要有 `try-catch`，避免未捕获异常
5. **用户体验**：复制成功后显示"✅ 已复制"，1.5 秒后恢复
6. **控制台输出**：后端使用 ANSI 颜色代码美化，方便开发者调试

---

##  快速实现模板

### Python 后端模板

```python
def _load_xxx_runtime():
    try:
        from xxx_package import SomeClass
        return SomeClass
    except Exception as exc:
        import sys
        python_executable = sys.executable
        RED, YELLOW, CYAN, GREEN, RESET, BOLD = '\033[91m', '\033[93m', '\033[96m', '\033[92m', '\033[0m', '\033[1m'
        
        install_cmd = f"{python_executable} -m pip install xxx-package -i https://pypi.tuna.tsinghua.edu.cn/simple"
        
        print(f"\n{RED}{'=' * 80}{RESET}")
        print(f"{RED}{BOLD}  GJJ 节点运行时依赖缺失！{RESET}")
        print(f"{RED}{'=' * 80}{RESET}")
        print(f"{YELLOW}[GJJ] {BOLD}节点:{RESET} {CYAN}节点名称{RESET}")
        print(f"{YELLOW}[GJJ]{RESET} 需要 xxx-package\n")
        print(f"{YELLOW}{BOLD} 快速安装命令:{RESET}")
        print(f"{GREEN}{BOLD}  {install_cmd}{RESET}\n")
        print(f"{RED}{'=' * 80}{RESET}\n")
        
        raise RuntimeError(f"未找到 xxx-package 运行库。\n🔧 安装命令：{install_cmd}\n原始错误：{exc}") from exc

# 在主函数中
except Exception as exc:
    if isinstance(exc, RuntimeError) and "未找到 xxx-package 运行库" in str(exc):
        error_str = str(exc)
        import re
        match = re.search(r'(.+?python\.exe.*?pip install xxx-package.*?)\n', error_str)
        install_command = match.group(1).strip() if match else ""
        
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("gjj_xxx_error", {
                "node": str(unique_id),
                "error": error_str,
                "install_command": install_command,
            })
        except Exception:
            pass
        raise RuntimeError("运行时依赖缺失：xxx-package。详细信息请查看节点前端面板。") from exc
```

### JavaScript 前端模板

```javascript
api.addEventListener("gjj_xxx_error", (event) => {
    const data = event.detail || {};
    const nodeId = data.node;
    const errorMessage = data.error || "";
    const installCommand = data.install_command || "";

    if (!nodeId || !errorMessage) return;

    const nodes = app.graph?._nodes || [];
    for (const node of nodes) {
        if (String(node.id) === String(nodeId)) {
            const status = node.__gjjNodeStatus;
            if (status?.textDisplay) {
                let displayText = `❌ 执行失败：\n\n${errorMessage}`;
                if (installCommand) {
                    displayText += `\n\n🔧 快速安装命令（点击按钮复制）：`;
                }
                status.textDisplay.textContent = displayText;
                status.textDisplay.style.color = "#ff6b6b";

                if (status.copyBtn) {
                    status.copyBtn.style.display = "block";
                    status.copyBtn.textContent = " 复制安装命令";
                    status.copyBtn.style.background = "#ff4757";
                    
                    const newCopyBtn = status.copyBtn.cloneNode(true);
                    status.copyBtn.parentNode.replaceChild(newCopyBtn, status.copyBtn);
                    status.copyBtn = newCopyBtn;

                    status.copyBtn.addEventListener("click", () => {
                        navigator.clipboard.writeText(installCommand).then(() => {
                            status.copyBtn.textContent = "✅ 已复制";
                            status.copyBtn.style.background = "#2ed573";
                            setTimeout(() => {
                                status.copyBtn.textContent = "📋 复制安装命令";
                                status.copyBtn.style.background = "#ff4757";
                            }, 1500);
                        });
                    });
                }
            }
            break;
        }
    }
});
```

---

##  更新记录

| 日期 | 版本 | 更新内容 |
|------|------|---------|
| 2026-05-07 | 1.0 | 初始版本，基于 Qwen3 ASR 节点实现 |
