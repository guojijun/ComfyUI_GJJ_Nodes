import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { queueOnlyCurrentNode } from "./gjj_utils.js";

(function () {
    const NODE_CLASS_NAME = "GJJ_MemoryManager";
    const STATUS_WIDGET_NAME = "__gjj_memory_manager_status";

    function setStatus(node, text) {
        const s = node.__gjjMemoryStatus;
        if (!s) return;
        s.statusLabel.textContent = text;
    }

    function updateStatsDisplay(node, data) {
        const s = node.__gjjMemoryStatus;
        if (!s) return;

        const memory = data.memory || {};
        const gpu_list = data.gpu || [];

        let html = `<div style="margin-bottom:12px;">`;
        html += `<div style="font-weight:bold;color:#5aa8ff;margin-bottom:3px;">💾 系统内存</div>`;

        if (memory.error) {
            html += `<div style="color:#ff6b6b;font-size:12px;">${memory.error}</div>`;
        } else {
            const usedGB = memory.used || 0;
            const totalGB = memory.total || 1;
            const percent = memory.percent || 0;

            html += `<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
                <span>已使用: ${usedGB} GB</span>
                <span>可用: ${memory.available || 0} GB</span>
            </div>`;
            html += `<div style="height:8px;border-radius:4px;background:#27343b;overflow:hidden;">
                <div style="height:100%;border-radius:4px;background:${percent > 90 ? '#ff6b6b' : percent > 70 ? '#ffa502' : '#5aa8ff'};width:${percent}%;transition:width 0.3s;"></div>
            </div>`;
            html += `<div style="text-align:right;font-size:12px;color:#888;margin-top:2px;">${percent}%</div>`;
        }
        html += `</div>`;

        html += `<div>`;
        html += `<div style="font-weight:bold;color:#a855f7;margin-bottom:3px;">🎮 GPU 显存</div>`;

        if (gpu_list.length === 0) {
            html += `<div style="color:#aaa;font-size:11px;">未检测到GPU信息</div>`;
        } else {
            gpu_list.forEach((gpu, idx) => {
                if (gpu.error) {
                    html += `<div style="color:#ff6b6b;font-size:12px;margin-bottom:4px;">${gpu.error}</div>`;
                } else {
                    const usedGB = gpu.cached || gpu.allocated || 0;
                    const totalGB = gpu.total || 1;
                    const percent = gpu.percent || 0;

                    html += `<div style="margin-bottom:8px;padding:6px;background:#1a2329;border-radius:4px;">`;
                    html += `<div style="font-size:11px;color:#888;margin-bottom:4px;">${gpu.name || `GPU ${idx}`}</div>`;
                    html += `<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
                        <span>已分配: ${gpu.allocated || 0} GB</span>
                        <span>可用: ${gpu.available || 0} GB</span>
                    </div>`;
                    html += `<div style="height:6px;border-radius:3px;background:#27343b;overflow:hidden;">
                        <div style="height:100%;border-radius:3px;background:${percent > 90 ? '#ff6b6b' : percent > 70 ? '#ffa502' : '#a855f7'};width:${percent}%;transition:width 0.3s;"></div>
                    </div>`;
                    html += `<div style="text-align:right;font-size:10px;color:#888;margin-top:2px;">缓存: ${gpu.cached || 0} GB (${percent}%)</div>`;
                    html += `</div>`;
                }
            });
        }
        html += `</div>`;

        s.statsDisplay.innerHTML = html;

        const timestamp = new Date().toLocaleTimeString();
        s.lastUpdate.textContent = `最后更新: ${timestamp}`;
    }

    function ensureStatusWidget(node) {
        if (node.__gjjMemoryStatus) return node.__gjjMemoryStatus;

        const box = document.createElement("div");
        box.style.cssText = "padding:10px;border:1px solid #41535b;border-radius:8px;background:#121a1f;color:#dce7e2";

        const headerRow = document.createElement("div");
        headerRow.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:12px";

        const title = document.createElement("div");
        title.textContent = "🖥️ 资源监控";
        title.style.cssText = "font-weight:bold;font-size:14px";
        headerRow.appendChild(title);

        const lastUpdate = document.createElement("div");
        lastUpdate.textContent = "最后更新: --:--:--";
        lastUpdate.style.cssText = "font-size:11px;color:#888";
        headerRow.appendChild(lastUpdate);
        box.appendChild(headerRow);

        const statsDisplay = document.createElement("div");
        statsDisplay.innerHTML = `<div style="color:#aaa;font-size:12px;text-align:center;padding:20px;">点击「刷新状态」获取内存/显存信息</div>`;
        box.appendChild(statsDisplay);

        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;flex-direction:row;gap:4px;margin-top:12px;width:100%";

        const refreshBtn = document.createElement("button");
        refreshBtn.textContent = "🔄刷新状态";
        refreshBtn.style.cssText = "flex:1;height:60px;background:#5aa8ff;color:#fff;border:none;border-radius:4px;padding:4px;cursor:pointer;font-size:9px;font-weight:bold;transition:all 0.2s;display:flex;align-items:center;justify-content:center;writing-mode:vertical-rl;text-orientation:mixed;-webkit-writing-mode:vertical-rl;-ms-writing-mode:tb-rl";

        refreshBtn.addEventListener("click", async () => {
            node.properties = node.properties || {};
            node.properties.action = "refresh";
            node.setDirtyCanvas?.(true, true);
            node.graph?.change?.();

            await executeNode(node, refreshBtn);
        });

        btnRow.appendChild(refreshBtn);

        const cleanMemBtn = document.createElement("button");
        cleanMemBtn.textContent = "🧹清理内存";
        cleanMemBtn.style.cssText = "flex:1;height:60px;background:#2d9a5e;color:#fff;border:none;border-radius:4px;padding:4px;cursor:pointer;font-size:9px;font-weight:bold;transition:all 0.2s;display:flex;align-items:center;justify-content:center;writing-mode:vertical-rl;text-orientation:mixed;-webkit-writing-mode:vertical-rl;-ms-writing-mode:tb-rl";

        cleanMemBtn.addEventListener("click", async () => {
            node.properties = node.properties || {};
            node.properties.action = "clean_memory";
            node.setDirtyCanvas?.(true, true);
            node.graph?.change?.();

            await executeNode(node, cleanMemBtn);
        });

        btnRow.appendChild(cleanMemBtn);

        const cleanGpuBtn = document.createElement("button");
        cleanGpuBtn.textContent = "🎮清理显存";
        cleanGpuBtn.style.cssText = "flex:1;height:60px;background:#8b5cf6;color:#fff;border:none;border-radius:4px;padding:4px;cursor:pointer;font-size:9px;font-weight:bold;transition:all 0.2s;display:flex;align-items:center;justify-content:center;writing-mode:vertical-rl;text-orientation:mixed;-webkit-writing-mode:vertical-rl;-ms-writing-mode:tb-rl";

        cleanGpuBtn.addEventListener("click", async () => {
            node.properties = node.properties || {};
            node.properties.action = "clean_gpu";
            node.setDirtyCanvas?.(true, true);
            node.graph?.change?.();

            await executeNode(node, cleanGpuBtn);
        });

        btnRow.appendChild(cleanGpuBtn);

        const cleanAllBtn = document.createElement("button");
        cleanAllBtn.textContent = "🔥一键清理";
        cleanAllBtn.style.cssText = "flex:1;height:60px;background:#ff6b6b;color:#fff;border:none;border-radius:4px;padding:4px;cursor:pointer;font-size:9px;font-weight:bold;transition:all 0.2s;display:flex;align-items:center;justify-content:center;writing-mode:vertical-rl;text-orientation:mixed;-webkit-writing-mode:vertical-rl;-ms-writing-mode:tb-rl";

        cleanAllBtn.addEventListener("click", async () => {
            node.properties = node.properties || {};
            node.properties.action = "clean_all";
            node.setDirtyCanvas?.(true, true);
            node.graph?.change?.();

            await executeNode(node, cleanAllBtn);
        });

        btnRow.appendChild(cleanAllBtn);
        box.appendChild(btnRow);

        const statusRow = document.createElement("div");
        statusRow.style.cssText = "margin-top:8px;padding-top:8px;border-top:1px solid #27343b";

        const statusLabel = document.createElement("div");
        statusLabel.textContent = "状态: 等待操作";
        statusLabel.style.cssText = "font-size:11px;color:#888";
        statusRow.appendChild(statusLabel);
        box.appendChild(statusRow);

        const statusObj = {
            statusLabel,
            statsDisplay,
            lastUpdate,
            refreshBtn,
            cleanMemBtn,
            cleanGpuBtn,
            cleanAllBtn
        };

        const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
            serialize: false,
            hideOnZoom: false,
            getHeight: () => 280,
        });

        statusObj.widget = widget;
        node.__gjjMemoryStatus = statusObj;

        return statusObj;
    }

    async function executeNode(node, btn) {
        const origText = btn.textContent;
        const origBg = btn.style.background;

        try {
            btn.textContent = "⏳ 处理中...";
            btn.disabled = true;
            btn.style.cursor = "not-allowed";
            btn.style.opacity = "0.65";

            setStatus(node, "正在处理...");

            await queueOnlyCurrentNode(node);
        } catch (e) {
            console.error("[GJJ] 执行失败:", e);
            setStatus(node, "执行失败");
        } finally {
            setTimeout(() => {
                btn.textContent = origText;
                btn.disabled = false;
                btn.style.cursor = "pointer";
                btn.style.opacity = "1";
                btn.style.background = origBg;
            }, 500);
        }
    }

    function patchNode(node) {
        if (!node || node.__gjjMemoryManagerPatched) return;
        node.__gjjMemoryManagerPatched = true;

        ensureStatusWidget(node);
        setStatus(node, "等待操作");
    }

    app.registerExtension({
        name: `GJJ.${NODE_CLASS_NAME}`,

        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData?.name === NODE_CLASS_NAME) {
                const orig = nodeType.prototype.onNodeCreated;
                nodeType.prototype.onNodeCreated = function () {
                    const r = orig?.apply(this, arguments);
                    patchNode(this);
                    return r;
                };
            }
        },

        async setup() {
            api.addEventListener("gjj_memory_manager_stats", (event) => {
                try {
                    const d = event.detail || {};
                    const nodeId = d.node;

                    if (!nodeId) return;

                    for (const node of app.graph?._nodes || []) {
                        if (String(node.id) === String(nodeId)) {
                            updateStatsDisplay(node, d);
                            setStatus(node, "已更新");
                            break;
                        }
                    }
                } catch (err) {
                    console.error("[GJJ] 处理统计事件失败:", err);
                }
            });
        },
    });
})();
