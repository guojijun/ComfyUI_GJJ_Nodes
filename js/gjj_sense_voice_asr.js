/**
 * GJJ_SenseVoiceASR 节点前端扩展
 */
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

(function () {
    if (typeof window === "undefined" || typeof window.comfyAPI === "undefined") return;

    const STATUS_WIDGET_NAME = "__gjj_sense_voice_status";
    const EMPTY_TEXT = "（暂无生成文本）";

    function isExecutionOutputNode(node) {
        if (!node) return false;
        if (node === undefined || node === null) return false;
        if (node.comfyClass === "GJJ_SenseVoiceASR") return true;
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
        const status = node.__gjjSenseVoiceStatus;
        if (!status) return;
        status.label.textContent = text;
        if (progress != null) {
            const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
            status.bar.style.width = `${pct}%`;
        }
    }

    function bindGeneratedTextCopyButton(status) {
        if (!status?.copyBtn) return;
        const oldCopyBtn = status.copyBtn.cloneNode(true);
        status.copyBtn.parentNode.replaceChild(oldCopyBtn, status.copyBtn);
        status.copyBtn = oldCopyBtn;
        status.copyBtn.textContent = "📋";
        status.copyBtn.title = "复制生成的文本到剪贴板";
        status.copyBtn.style.display = "none";
        status.copyBtn.style.background = "#4a5a6a";
        status.copyBtn.style.color = "#fff";
        status.copyBtn.addEventListener("mouseenter", () => status.copyBtn.style.background = "#5a6a7a");
        status.copyBtn.addEventListener("mouseleave", () => status.copyBtn.style.background = "#4a5a6a");
        status.copyBtn.addEventListener("click", () => {
            const text = status.textDisplay?.textContent;
            if (text && text !== EMPTY_TEXT) {
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

    function ensureStatusWidget(node) {
        if (node.__gjjSenseVoiceStatus) {
            return node.__gjjSenseVoiceStatus;
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

        // 状态栏 + 生成文本按钮
        const statusRow = document.createElement("div");
        statusRow.style.cssText = "display:flex;gap:8px;align-items:center;position:relative;z-index:999";

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
            "position: relative",
            "z-index: 1000",
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

        // 生成的文本显示区域 + 复制按钮
        const textRow = document.createElement("div");
        textRow.style.cssText = "margin-top:8px;display:flex;gap:6px;position:relative;z-index:999";

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
        textDisplay.textContent = EMPTY_TEXT;
        textRow.appendChild(textDisplay);

        // 复制按钮
        const copyBtn = document.createElement("button");
        copyBtn.textContent = "📋";
        copyBtn.title = "复制生成的文本到剪贴板";
        copyBtn.style.cssText = [
            "display:none",
            "position: relative",
            "z-index: 1000",
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

        const statusObj = {
            widget: null,
            box,
            label,
            bar,
            generateBtn,
            textDisplay,
            copyBtn
        };

        const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
            serialize: false,
            hideOnZoom: false,
            getHeight: () => {
                const textHeight = textDisplay?.scrollHeight || 0;
                const baseHeight = 200;
                return Math.max(baseHeight, baseHeight + textHeight - 50);
            },
        });

        statusObj.widget = widget;
        node.__gjjSenseVoiceStatus = statusObj;
        return node.__gjjSenseVoiceStatus;
    }

    function patchNode(node) {
        if (!node || node.__gjjSenseVoicePatched) {
            return;
        }
        node.__gjjSenseVoicePatched = true;
        ensureStatusWidget(node);
        setStatus(node, "等待执行");

        const status = node.__gjjSenseVoiceStatus;

        // 绑定生成文本按钮事件
        if (status?.generateBtn) {
            const oldGenerateBtn = status.generateBtn.cloneNode(true);
            status.generateBtn.parentNode.replaceChild(oldGenerateBtn, status.generateBtn);
            status.generateBtn = oldGenerateBtn;

            status.generateBtn.addEventListener("click", async () => {
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
            bindGeneratedTextCopyButton(status);
        }
    }

    app.registerExtension({
        name: "GJJ.SenseVoiceASR",
        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData?.name === "GJJ_SenseVoiceASR") {
                const origOnNodeCreated = nodeType.prototype.onNodeCreated;
                nodeType.prototype.onNodeCreated = function () {
                    const result = origOnNodeCreated?.apply(this, arguments);
                    patchNode(this);
                    return result;
                };
            }
        },
        async setup(app) {
            // 监听文本生成完成事件
            api.addEventListener("gjj_sense_voice_generated", (event) => {
                try {
                    const data = event.detail || {};
                    const nodeId = data.node;
                    const textList = data.text_list || "";

                    if (!nodeId || !textList) return;

                    const nodes = app.graph?._nodes || [];
                    for (const node of nodes) {
                        if (String(node.id) === String(nodeId)) {
                            const status = node.__gjjSenseVoiceStatus;
                            if (status?.textDisplay) {
                                status.textDisplay.textContent = textList;
                                status.textDisplay.style.color = "#c8d6e5";
                                bindGeneratedTextCopyButton(status);
                                status.copyBtn.style.display = "block";
                                setStatus(node, "文本已生成");
                            }
                            break;
                        }
                    }
                } catch (err) {
                    console.error("[GJJ] 处理文本生成事件失败:", err);
                }
            });

            // 监听错误事件（包含安装命令）
            api.addEventListener("gjj_sense_voice_error", (event) => {
                try {
                    const data = event.detail || {};
                    const nodeId = data.node;
                    const errorMessage = data.error || "";

                    if (!nodeId || !errorMessage) return;

                    const nodes = app.graph?._nodes || [];
                    for (const node of nodes) {
                        if (String(node.id) === String(nodeId)) {
                            const status = node.__gjjSenseVoiceStatus;
                            if (status?.textDisplay) {
                                status.textDisplay.textContent = `❌ 执行失败：\n\n${errorMessage}`;
                                status.textDisplay.style.color = "#ffb86b";
                                status.copyBtn.style.display = "none";
                                setStatus(node, "执行失败");
                            }
                            break;
                        }
                    }
                } catch (err) {
                    console.error("[GJJ] 处理错误事件失败:", err);
                }
            });

            // 监听进度事件
            api.addEventListener("gjj_node_progress", (event) => {
                try {
                    const data = event.detail || {};
                    const nodeId = data.node;
                    const text = data.text || "";
                    const progress = data.progress;

                    if (!nodeId || !text) return;

                    const nodes = app.graph?._nodes || [];
                    for (const node of nodes) {
                        if (String(node.id) === String(nodeId)) {
                            const status = node.__gjjSenseVoiceStatus;
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
        },
    });

    if (typeof window !== "undefined") {
        window.__gjjSenseVoiceStatusPatch = patchNode;
    }
})();
