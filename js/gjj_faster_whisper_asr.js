/**
 * GJJ_FasterWhisperASR 节点前端扩展
 * 完全参考 GJJ_Qwen3ASRTextFormats 实现
 */
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

(function () {
    if (typeof window === "undefined" || typeof window.comfyAPI === "undefined") return;

    const STATUS_WIDGET_NAME = "__gjj_faster_whisper_status";
    const BOOL_WIDGETS = ["segment_by_sentence", "auto_download"];

    function isExecutionOutputNode(node) {
        if (!node) return false;
        if (node === undefined || node === null) return false;
        if (node.comfyClass === "GJJ_FasterWhisperASR") return true;
        if (node.constructor?.nodeData?.output_node === true) return true;
        if (node.nodeData?.output_node === true) return true;
        if (node.flags?.output === true) return true;
        return false;
    }

    async function queueOnlyCurrentNode(node) {
        if (!node || !node.graph) return false;

        const graph = node.graph || app.graph;
        const allNodes = graph?._nodes || app.graph?._nodes || [];

        const savedModes = [];
        const oldSelectedNodes = app.canvas?.selected_nodes;
        const oldSelectedNode = app.canvas?.selected_node;

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
                app.canvas.selected_node = node;
            }

            node.setDirtyCanvas?.(true, true);
            node.graph?.setDirtyCanvas?.(true, true);
            app.graph?.setDirtyCanvas?.(true, true);

            if (typeof app.queuePrompt === "function") {
                await app.queuePrompt(0, 1);
                return true;
            }

            console.warn("[GJJ] app.queuePrompt 不存在，无法只刷新当前节点");
            return false;
        } finally {
            for (const [n, mode] of savedModes) {
                n.mode = mode;
            }

            if (app.canvas) {
                app.canvas.selected_nodes = oldSelectedNodes;
                app.canvas.selected_node = oldSelectedNode;
            }

            node.setDirtyCanvas?.(true, true);
            node.graph?.setDirtyCanvas?.(true, true);
            app.graph?.setDirtyCanvas?.(true, true);
        }
    }

    function setStatus(node, text, progress) {
        const status = node.__gjjFasterWhisperStatus;
        if (!status) return;
        status.label.textContent = text;
        if (progress != null) {
            const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
            status.bar.style.width = `${pct}%`;
        }
    }

    function ensureStatusWidget(node) {
        if (node.__gjjFasterWhisperStatus) {
            return node.__gjjFasterWhisperStatus;
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

        // 第一行：Boolean 按钮
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
                "background: #5aa8ff",
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
                if (btn.__boolValue) {
                    btn.style.background = "#5aa8ff";
                    btn.style.color = "#fff";
                } else {
                    btn.style.background = "#3a3a3a";
                    btn.style.color = "#aaa";
                }

                if (!node.properties) node.properties = {};
                node.properties[config.name] = btn.__boolValue;

                node.setDirtyCanvas?.(true, true);
                node.graph?.setDirtyCanvas?.(true, true);
                node.graph?.change?.();
            });

            btn.addEventListener("mouseenter", () => {
                btn.style.opacity = "0.85";
            });
            btn.addEventListener("mouseleave", () => {
                btn.style.opacity = "1";
            });

            boolBtnRow.appendChild(btn);
            boolButtons[config.name] = btn;
        });

        box.appendChild(boolBtnRow);

        // 第二行：状态栏 + 生成文本按钮
        const statusRow = document.createElement("div");
        statusRow.style.cssText = "display:flex;gap:8px;align-items:center";

        const statusContent = document.createElement("div");
        statusContent.style.cssText = "flex:1;min-width:0";

        const label = document.createElement("div");
        label.textContent = "等待执行";
        label.style.cssText = "margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";

        const track = document.createElement("div");
        track.style.cssText = [
            "height:5px",
            "overflow:hidden",
            "border-radius:999px",
            "background:#27343b",
        ].join(";");
        const bar = document.createElement("div");
        bar.style.cssText = [
            "width:0%",
            "height:100%",
            "border-radius:999px",
            "background:#5aa8ff",
            "transition:width 160ms ease",
        ].join(";");
        track.appendChild(bar);
        statusContent.append(label, track);

        const generateBtn = document.createElement("button");
        generateBtn.textContent = "🎤 生成文本";
        generateBtn.title = "只执行当前节点，生成识别文本";
        generateBtn.style.cssText = [
            "background: #2d5a9e",
            "color: #fff",
            "border: none",
            "border-radius:4px",
            "padding: 4px 12px",
            "cursor: pointer",
            "font-size: 11px",
            "font-weight: bold",
            "white-space: nowrap",
        ].join(";");
        generateBtn.addEventListener("mouseenter", () => generateBtn.style.background = "#3d6aae");
        generateBtn.addEventListener("mouseleave", () => generateBtn.style.background = "#2d5a9e");

        statusRow.append(statusContent, generateBtn);
        box.appendChild(statusRow);

        // 第三行：生成的文本显示区域 + 复制按钮（同一行）
        const textRow = document.createElement("div");
        textRow.style.cssText = "margin-top:8px;display:flex;gap:6px;";

        const textDisplay = document.createElement("div");
        textDisplay.style.cssText = [
            "flex:1",
            "padding:8px",
            "background:#1a2329",
            "border:1px solid #3a4a52",
            "border-radius:4px",
            "font-family:monospace",
            "font-size:11px",
            "max-height:200px",
            "overflow-y:auto",
            "white-space:pre-wrap",
            "word-break:break-word",
            "color:#c8d6e5",
        ].join(";");
        textDisplay.textContent = "（暂无生成文本）";
        textRow.appendChild(textDisplay);

        // 复制按钮（默认隐藏）
        const copyBtn = document.createElement("button");
        copyBtn.textContent = "📋";
        copyBtn.title = "复制生成的文本到剪贴板";
        copyBtn.style.cssText = [
            "display:none",
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
        copyBtn.addEventListener("mouseenter", () => copyBtn.style.background = "#5a6a7a");
        copyBtn.addEventListener("mouseleave", () => copyBtn.style.background = "#4a5a6a");
        textRow.appendChild(copyBtn);

        box.appendChild(textRow);

        // 创建状态对象（在 widget 之前）
        const statusObj = {
            widget: null,
            box,
            label,
            bar,
            generateBtn,
            boolButtons,
            boolBtnRow,
            statusRow,
            textDisplay,
            copyBtn
        };

        const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
            serialize: false,
            hideOnZoom: false,
            getHeight: () => {
                const textHeight = textDisplay?.scrollHeight || 0;
                const baseHeight = 240;
                return Math.max(baseHeight, baseHeight + textHeight - 50);
            },
        });

        statusObj.widget = widget;
        node.__gjjFasterWhisperStatus = statusObj;
        return node.__gjjFasterWhisperStatus;
    }

    function patchNode(node) {
        if (!node || node.__gjjFasterWhisperPatched) {
            return;
        }
        node.__gjjFasterWhisperPatched = true;
        ensureStatusWidget(node);
        setStatus(node, "等待执行");

        // 彻底删除旧的 Boolean widgets
        BOOL_WIDGETS.forEach(widgetName => {
            const widgetIndex = (node.widgets || []).findIndex(w => w.name === widgetName);
            if (widgetIndex !== -1) {
                node.widgets.splice(widgetIndex, 1);
            }
        });

        // 初始化 Boolean 状态
        BOOL_WIDGETS.forEach(widgetName => {
            if (!node.properties) node.properties = {};
            if (node.properties[widgetName] === undefined) {
                node.properties[widgetName] = true;
            }
        });

        // 同步 Boolean 按钮状态
        const status = node.__gjjFasterWhisperStatus;
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

        // 绑定生成文本按钮事件
        if (status?.generateBtn) {
            const oldGenerateBtn = status.generateBtn.cloneNode(true);
            status.generateBtn.parentNode.replaceChild(oldGenerateBtn, status.generateBtn);
            status.generateBtn = oldGenerateBtn;

            status.generateBtn.addEventListener("click", async () => {
                console.log("[GJJ] 生成文本: 只执行当前节点");
                const btn = status.generateBtn;
                const originalText = btn.textContent;

                try {
                    btn.textContent = "⏳ 生成中...";
                    btn.disabled = true;
                    btn.style.cursor = "not-allowed";
                    btn.style.opacity = "0.65";

                    setStatus(node, "正在生成文本...");

                    const ok = await queueOnlyCurrentNode(node);

                    if (!ok) {
                        console.warn("[GJJ] 生成文本失败：queueOnlyCurrentNode 返回 false");
                        setStatus(node, "生成失败");
                    }
                } catch (err) {
                    console.error("[GJJ] 生成文本失败:", err);
                    setStatus(node, "生成失败");
                } finally {
                    setTimeout(() => {
                        btn.textContent = originalText;
                        btn.disabled = false;
                        btn.style.cursor = "pointer";
                        btn.style.opacity = "1";
                    }, 500);
                }
            });
        }

        // 绑定复制按钮事件
        if (status?.copyBtn) {
            const oldCopyBtn = status.copyBtn.cloneNode(true);
            status.copyBtn.parentNode.replaceChild(oldCopyBtn, status.copyBtn);
            status.copyBtn = oldCopyBtn;

            status.copyBtn.addEventListener("click", () => {
                const text = status.textDisplay.textContent;
                if (text && text !== "（暂无生成文本）") {
                    navigator.clipboard.writeText(text).then(() => {
                        const originalText = status.copyBtn.textContent;
                        status.copyBtn.textContent = "✅ 已复制";
                        setTimeout(() => {
                            status.copyBtn.textContent = originalText;
                        }, 1500);
                    }).catch(err => {
                        console.error("[GJJ] 复制失败:", err);
                        alert("复制失败，请手动选择文本复制");
                    });
                } else {
                    alert("暂无文本可复制");
                }
            });
        }
    }

    app.registerExtension({
        name: "GJJ.FasterWhisperASR",
        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData?.name === "GJJ_FasterWhisperASR") {
                const origOnNodeCreated = nodeType.prototype.onNodeCreated;
                nodeType.prototype.onNodeCreated = function () {
                    const result = origOnNodeCreated?.apply(this, arguments);
                    patchNode(this);
                    return result;
                };
            }
        },
        async setup(app) {
            // 监听后端发送的进度事件
            api.addEventListener("gjj_node_progress", (event) => {
                try {
                    const data = event.detail || {};
                    const nodeId = data.node;
                    const text = data.text || "";
                    const progress = data.progress;

                    if (!nodeId) return;

                    const nodes = app.graph?._nodes || [];
                    for (const node of nodes) {
                        if (String(node.id) === String(nodeId)) {
                            const status = node.__gjjFasterWhisperStatus;
                            if (status) {
                                status.label.textContent = text;
                                if (progress != null) {
                                    const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
                                    status.bar.style.width = `${pct}%`;
                                }
                            }
                            break;
                        }
                    }
                } catch (err) {
                    console.error("[GJJ] 处理进度事件失败:", err);
                }
            });

            // 监听后端发送的运行时错误事件（包含安装命令）
            api.addEventListener("gjj_faster_whisper_error", (event) => {
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
                            const status = node.__gjjFasterWhisperStatus;
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
                                    status.copyBtn.style.display = "inline-block";
                                    status.copyBtn.textContent = "📋 复制安装命令";
                                    status.copyBtn.title = "复制安装命令到剪贴板";
                                    status.copyBtn.style.background = "#ff4757";
                                    status.copyBtn.style.color = "#fff";
                                    status.copyBtn.style.position = "relative";
                                    status.copyBtn.style.zIndex = "1000";
                                    status.copyBtn.style.pointerEvents = "auto";
                                    status.copyBtn.style.cursor = "pointer";
                                    status.copyBtn.style.border = "none";
                                    status.copyBtn.style.borderRadius = "4px";
                                    status.copyBtn.style.padding = "4px 8px";
                                    status.copyBtn.style.fontSize = "11px";
                                    status.copyBtn.style.fontWeight = "bold";
                                    status.copyBtn.style.whiteSpace = "nowrap";
                                    status.copyBtn.style.height = "fit-content";

                                    // 更新复制按钮事件，复制安装命令
                                    status.copyBtn.onclick = () => {
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
                                    };

                                    status.copyBtn.onmouseenter = () => {
                                        status.copyBtn.style.background = "#ff5767";
                                    };

                                    status.copyBtn.onmouseleave = () => {
                                        status.copyBtn.style.background = "#ff4757";
                                    };
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

            // 监听后端发送的识别结果事件
            api.addEventListener("gjj_faster_whisper_generated", (event) => {
                try {
                    const data = event.detail || {};
                    const nodeId = data.node;
                    const textList = data.text_list || "";

                    if (!nodeId || !textList) return;

                    // 查找对应的节点
                    const nodes = app.graph?._nodes || [];
                    for (const node of nodes) {
                        if (String(node.id) === String(nodeId)) {
                            const status = node.__gjjFasterWhisperStatus;
                            if (status?.textDisplay) {
                                status.textDisplay.textContent = textList;
                                status.textDisplay.style.color = "#c8d6e5";
                                // 显示复制按钮
                                if (status.copyBtn) {
                                    status.copyBtn.style.display = "block";
                                    status.copyBtn.textContent = "📋";
                                    status.copyBtn.title = "复制生成的文本到剪贴板";
                                    status.copyBtn.style.background = "#4a5a6a";
                                    status.copyBtn.style.color = "#fff";

                                    // 更新复制按钮事件，复制生成的文本
                                    const newCopyBtn = status.copyBtn.cloneNode(true);
                                    status.copyBtn.parentNode.replaceChild(newCopyBtn, status.copyBtn);
                                    status.copyBtn = newCopyBtn;

                                    status.copyBtn.addEventListener("click", () => {
                                        navigator.clipboard.writeText(textList).then(() => {
                                            const originalText = status.copyBtn.textContent;
                                            status.copyBtn.textContent = "✅ 已复制";
                                            setTimeout(() => {
                                                status.copyBtn.textContent = originalText;
                                            }, 1500);
                                        }).catch(err => {
                                            console.error("[GJJ] 复制失败:", err);
                                            alert("复制失败，请手动选择文本复制");
                                        });
                                    });
                                }
                                setStatus(node, "文本已生成");
                            }
                            break;
                        }
                    }
                } catch (err) {
                    console.error("[GJJ] 处理文本生成事件失败:", err);
                }
            });
        },
    });

    if (typeof window !== "undefined") {
        window.__gjjFasterWhisperStatusPatch = patchNode;
    }
})();
