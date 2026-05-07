/**
 * GJJ_Qwen3ASRTextFormats 节点前端扩展
 * - 将 Boolean 控件改为按钮（按句分段、自动下载模型）
 * - 添加状态栏和生成文本按钮
 * - 显示生成的多行文本，支持一键复制
 */
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

(function () {
    if (typeof window === "undefined" || typeof window.comfyAPI === "undefined") return;

    const STATUS_WIDGET_NAME = "__gjj_qwen3_asr_status";
    const BOOL_WIDGETS = ["segment_by_sentence", "auto_download"];

    function isExecutionOutputNode(node) {
        if (!node) return false;
        if (node === undefined || node === null) return false;
        if (node.comfyClass === "GJJ_Qwen3ASRTextFormats") return true;
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
        const status = node.__gjjQwen3Status;
        if (!status) return;
        status.label.textContent = text;
        if (progress != null) {
            const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
            status.bar.style.width = `${pct}%`;
        }
    }

    function ensureStatusWidget(node) {
        if (node.__gjjQwen3Status) {
            return node.__gjjQwen3Status;
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
                // 根据文本内容动态计算高度
                const textHeight = textDisplay?.scrollHeight || 0;
                const baseHeight = 240; // 基础高度（按钮、标签等）
                return Math.max(baseHeight, baseHeight + textHeight - 50);
            },
        });

        statusObj.widget = widget;
        node.__gjjQwen3Status = statusObj;
        return node.__gjjQwen3Status;
    }

    function patchNode(node) {
        if (!node || node.__gjjQwen3Patched) {
            return;
        }
        node.__gjjQwen3Patched = true;
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
        const status = node.__gjjQwen3Status;
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
            // 移除旧的事件监听器
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
            // 移除旧的事件监听器
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
        name: "GJJ.Qwen3ASRTextFormats",
        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData?.name === "GJJ_Qwen3ASRTextFormats") {
                const origOnNodeCreated = nodeType.prototype.onNodeCreated;
                nodeType.prototype.onNodeCreated = function () {
                    const result = origOnNodeCreated?.apply(this, arguments);
                    patchNode(this);
                    return result;
                };
            }
        },
        async setup(app) {
            // 监听后端发送的文本生成完成事件
            api.addEventListener("gjj_qwen3_text_generated", (event) => {
                try {
                    const data = event.detail || {};
                    const nodeId = data.node;
                    const textList = data.text_list || "";

                    if (!nodeId || !textList) return;

                    // 查找对应的节点
                    const nodes = app.graph?._nodes || [];
                    for (const node of nodes) {
                        if (String(node.id) === String(nodeId)) {
                            const status = node.__gjjQwen3Status;
                            if (status?.textDisplay) {
                                status.textDisplay.textContent = textList;
                                // 显示复制按钮
                                if (status.copyBtn) {
                                    status.copyBtn.style.display = "block";
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
        window.__gjjQwen3ASRStatusPatch = patchNode;
    }
})();
