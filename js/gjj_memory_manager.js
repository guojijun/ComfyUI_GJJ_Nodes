import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_TYPE = "GJJ_MemoryManager";

const ACTION_PROP = "action";
const AUTO_CLEAN_MEMORY_PROP = "auto_clean_memory";
const AUTO_CLEAN_GPU_PROP = "auto_clean_gpu";

const ACTION_REFRESH = "refresh";
const ACTION_CLEAN_MEMORY = "clean_memory";
const ACTION_CLEAN_GPU = "clean_gpu";
const ACTION_CLEAN_ALL = "clean_all";

const MIN_NODE_WIDTH = 240;
const MIN_NODE_HEIGHT = 382;
const PANEL_HEIGHT = 288;
const POLL_INTERVAL_MS = 2000;

function ensureStyles() {
    if (document.getElementById("gjj-memory-manager-styles-v3")) return;

    const style = document.createElement("style");
    style.id = "gjj-memory-manager-styles-v3";
    style.textContent = `
        .gjj-memory-panel {
            box-sizing: border-box;
            width: 100%;
            height: ${PANEL_HEIGHT}px;
            padding: 10px;
            border: 1px solid rgba(137, 165, 190, 0.45);
            border-radius: 10px;
            background: rgba(13, 26, 31, 0.96);
            color: #e8f2f4;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            user-select: none;
            overflow: hidden;
        }
        .gjj-memory-top-row,
        .gjj-memory-action-row {
            display: grid;
            gap: 8px;
        }
        .gjj-memory-top-row {
            grid-template-columns: 1fr 1fr;
            margin-bottom: 10px;
        }
        .gjj-memory-action-row {
            grid-template-columns: repeat(4, minmax(0, 1fr));
            margin-top: 10px;
        }
        .gjj-memory-btn {
            border: 0;
            border-radius: 6px;
            color: #ffffff;
            font-weight: 800;
            cursor: pointer;
            transition: transform 0.12s ease, opacity 0.12s ease, filter 0.12s ease, box-shadow 0.12s ease;
            box-shadow: 0 1px 0 rgba(255,255,255,0.08) inset, 0 6px 12px rgba(0,0,0,0.16);
            white-space: pre-line;
            line-height: 1.15;
            overflow: hidden;
        }
        .gjj-memory-btn:hover {
            filter: brightness(1.08);
            transform: translateY(-1px);
        }
        .gjj-memory-btn:active {
            transform: translateY(0px) scale(0.98);
        }
        .gjj-memory-top-btn {
            min-height: 36px;
            padding: 6px 8px;
            opacity: 0.46;
            background: #35454e;
            font-size: 14px;
        }
        .gjj-memory-top-btn.active.memory {
            opacity: 1;
            background: linear-gradient(135deg, #24b66f, #1f9f62);
        }
        .gjj-memory-top-btn.active.gpu {
            opacity: 1;
            background: linear-gradient(135deg, #8d5cff, #7444df);
        }
        .gjj-memory-action-btn {
            height: 86px;
            padding: 7px 4px;
            font-size: 14px;
            writing-mode: vertical-rl;
            text-orientation: upright;
            white-space: nowrap;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .gjj-memory-action-refresh { background: #4ea5ff; }
        .gjj-memory-action-ram { background: #25a96b; }
        .gjj-memory-action-gpu { background: #8358f5; }
        .gjj-memory-action-all { background: #ff666b; }
        .gjj-memory-section-title {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 8px;
            margin: 0 4px 6px;
            min-height: 16px;
        }
        .gjj-memory-updated {
            color: #9aaeb7;
            font-size: 12px;
            font-weight: 600;
            flex: 0 0 auto;
        }
        .gjj-memory-message {
            height: 34px;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
            color: #adbbc3;
            font-weight: 800;
            line-height: 1.38;
            padding: 4px 8px;
            white-space: pre-line;
            overflow: hidden;
        }
        .gjj-memory-message.is-empty {
            display: none;
            height: 0;
            padding: 0;
        }
        .gjj-memory-stats {
            height: 112px;
            margin-top: 8px;
            padding: 8px 10px;
            border-radius: 8px;
            background: rgba(255,255,255,0.04);
            color: #c9d6dc;
            font-size: 12px;
            line-height: 1.25;
            overflow: hidden;
        }
        .gjj-memory-meter {
            margin-bottom: 8px;
        }
        .gjj-memory-meter:last-child {
            margin-bottom: 0;
        }
        .gjj-memory-meter-head {
            display: flex;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 4px;
            color: #d7e4e9;
            font-weight: 800;
            white-space: nowrap;
        }
        .gjj-memory-meter-title {
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .gjj-memory-meter-percent {
            flex: 0 0 auto;
            color: #f1f6f8;
        }
        .gjj-memory-meter-track {
            height: 10px;
            border-radius: 999px;
            background: rgba(0,0,0,0.32);
            border: 1px solid rgba(255,255,255,0.06);
            overflow: hidden;
        }
        .gjj-memory-meter-fill {
            height: 100%;
            width: 0%;
            border-radius: inherit;
            transition: width 0.25s ease;
        }
        .gjj-memory-meter.memory .gjj-memory-meter-fill {
            background: linear-gradient(90deg, #26b56f, #65d68e);
        }
        .gjj-memory-meter.gpu .gjj-memory-meter-fill {
            background: linear-gradient(90deg, #7b55f1, #ad7cff);
        }
        .gjj-memory-meter-detail {
            margin-top: 3px;
            color: #9fb0b8;
            font-size: 11px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .gjj-memory-meter-error {
            padding: 7px 8px;
            border-radius: 7px;
            background: rgba(255,255,255,0.04);
            color: #c8d4da;
            font-weight: 700;
        }
        .gjj-memory-sep {
            height: 1px;
            margin: 10px 0 8px;
            background: rgba(137, 165, 190, 0.22);
        }
    `;
    document.head.appendChild(style);
}

function isTargetNode(node) {
    return String(node?.comfyClass || node?.type || "") === NODE_TYPE;
}

function ensureProps(node) {
    node.properties = node.properties || {};
    if (!Object.prototype.hasOwnProperty.call(node.properties, ACTION_PROP)) {
        node.properties[ACTION_PROP] = ACTION_REFRESH;
    }
    if (!Object.prototype.hasOwnProperty.call(node.properties, AUTO_CLEAN_MEMORY_PROP)) {
        node.properties[AUTO_CLEAN_MEMORY_PROP] = false;
    }
    if (!Object.prototype.hasOwnProperty.call(node.properties, AUTO_CLEAN_GPU_PROP)) {
        node.properties[AUTO_CLEAN_GPU_PROP] = false;
    }
    return node.properties;
}

function markDirty(node) {
    try {
        node.setDirtyCanvas?.(true, true);
        node.graph?.setDirtyCanvas?.(true, true);
        app.graph?.setDirtyCanvas?.(true, true);
        node.graph?.change?.();
    } catch {}
}

function enforceMinNodeSize(node) {
    if (!node || !Array.isArray(node.size)) return;

    let changed = false;
    if (Number(node.size[0] || 0) < MIN_NODE_WIDTH) {
        node.size[0] = MIN_NODE_WIDTH;
        changed = true;
    }
    if (Number(node.size[1] || 0) < MIN_NODE_HEIGHT) {
        node.size[1] = MIN_NODE_HEIGHT;
        changed = true;
    }

    if (changed) markDirty(node);
}

async function fetchJson(url, options = {}) {
    const fetcher = api?.fetchApi ? api.fetchApi.bind(api) : fetch;
    const response = await fetcher(url, options);
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
    }
    return await response.json();
}

async function requestStats(node) {
    const id = encodeURIComponent(String(node?.id ?? ""));
    return await fetchJson(`/gjj_memory_manager/stats?node=${id}`);
}

async function requestAction(node, action) {
    return await fetchJson("/gjj_memory_manager/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node: String(node?.id ?? ""), action }),
    });
}

function makeTopToggleButton(node, label, propName, icon, className) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `gjj-memory-btn gjj-memory-top-btn ${className}`;

    const sync = () => {
        const props = ensureProps(node);
        const active = !!props[propName];
        btn.className = `gjj-memory-btn gjj-memory-top-btn ${className}${active ? " active" : ""}`;
        btn.textContent = `${icon} ${label}`;
        btn.title = active
            ? `已开启：数据流过此节点时自动清理${label}`
            : `已关闭：数据流过此节点时不自动清理${label}`;
    };

    btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        const props = ensureProps(node);
        props[propName] = !props[propName];
        props[ACTION_PROP] = ACTION_REFRESH;
        sync();
        markDirty(node);
    });

    sync();
    return btn;
}

function makeActionButton(node, label, action, icon, className, statusEl) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `gjj-memory-btn gjj-memory-action-btn ${className}`;
    btn.textContent = `${icon}${label}`;
    btn.title = `只执行本节点后端动作：${label}。不会提交整个工作流。`;

    btn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();

        try {
            setStatusMessage(statusEl, "正在处理...");
            const props = ensureProps(node);
            props[ACTION_PROP] = ACTION_REFRESH; // 避免手动动作残留到后续正常队列。
            markDirty(node);

            const detail = await requestAction(node, action);
            updateStatsForNode(node, detail);
        } catch (error) {
            console.warn("[GJJ_MemoryManager] action failed:", error);
            setStatusMessage(statusEl, `执行失败：${error.message || error}`);
        }
    });

    return btn;
}

function clampPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function makeMeterHtml(kind, title, percent, detail) {
    const p = clampPercent(percent);
    return `
        <div class="gjj-memory-meter ${kind}">
            <div class="gjj-memory-meter-head">
                <span class="gjj-memory-meter-title">${escapeHtml(title)}</span>
                <span class="gjj-memory-meter-percent">${p.toFixed(1)}%</span>
            </div>
            <div class="gjj-memory-meter-track">
                <div class="gjj-memory-meter-fill" style="width:${p}%"></div>
            </div>
            <div class="gjj-memory-meter-detail">${escapeHtml(detail)}</div>
        </div>
    `;
}

function makeErrorHtml(text) {
    return `<div class="gjj-memory-meter-error">${escapeHtml(text)}</div>`;
}

function renderStatsHtml(detail) {
    const parts = [];
    const memory = detail?.memory;

    if (!memory) {
        parts.push(makeErrorHtml("内存：暂无数据"));
    } else if (memory.error) {
        parts.push(makeErrorHtml(`内存：${memory.error}`));
    } else {
        parts.push(makeMeterHtml(
            "memory",
            "内存 RAM",
            memory.percent,
            `已用 ${memory.used}/${memory.total}${memory.unit} · 可用 ${memory.available}${memory.unit}`
        ));
    }

    const gpu = Array.isArray(detail?.gpu) ? detail.gpu : [];
    const firstGpu = gpu.find((item) => item && !item.error) || gpu[0];
    if (!firstGpu) {
        parts.push(makeErrorHtml("显存：暂无数据"));
    } else if (firstGpu.error) {
        parts.push(makeErrorHtml(`显存：${firstGpu.error}`));
    } else {
        const name = firstGpu.name ? `${firstGpu.device} · ${firstGpu.name}` : firstGpu.device;
        parts.push(makeMeterHtml(
            "gpu",
            "显存 VRAM",
            firstGpu.percent,
            `${name} · 已占 ${firstGpu.cached}/${firstGpu.total}${firstGpu.unit} · 可用 ${firstGpu.available}${firstGpu.unit}`
        ));
    }

    return parts.join("");
}

function setStatusMessage(element, text) {
    if (!element) return;
    const value = String(text || "").trim();
    element.textContent = value;
    element.classList.toggle("is-empty", !value);
}

function createPanel(node) {
    ensureStyles();
    ensureProps(node);

    const panel = document.createElement("div");
    panel.className = "gjj-memory-panel";

    const topRow = document.createElement("div");
    topRow.className = "gjj-memory-top-row";
    topRow.appendChild(makeTopToggleButton(node, "内存", AUTO_CLEAN_MEMORY_PROP, "🧹", "memory"));
    topRow.appendChild(makeTopToggleButton(node, "显存", AUTO_CLEAN_GPU_PROP, "🎮", "gpu"));
    panel.appendChild(topRow);

    const title = document.createElement("div");
    title.className = "gjj-memory-section-title";
    title.innerHTML = `<span class="gjj-memory-updated">最后更新: --:--:--</span>`;
    panel.appendChild(title);

    const message = document.createElement("div");
    message.className = "gjj-memory-message";
    setStatusMessage(message, "正在获取资源状态...");
    panel.appendChild(message);

    const stats = document.createElement("div");
    stats.className = "gjj-memory-stats";
    stats.innerHTML = renderStatsHtml({});
    panel.appendChild(stats);

    const sep = document.createElement("div");
    sep.className = "gjj-memory-sep";
    panel.appendChild(sep);

    const actionRow = document.createElement("div");
    actionRow.className = "gjj-memory-action-row";
    actionRow.appendChild(makeActionButton(node, "刷新", ACTION_REFRESH, "🔄", "gjj-memory-action-refresh", message));
    actionRow.appendChild(makeActionButton(node, "清理内存", ACTION_CLEAN_MEMORY, "🧹", "gjj-memory-action-ram", message));
    actionRow.appendChild(makeActionButton(node, "清理显存", ACTION_CLEAN_GPU, "🎮", "gjj-memory-action-gpu", message));
    actionRow.appendChild(makeActionButton(node, "一键清理", ACTION_CLEAN_ALL, "🧨", "gjj-memory-action-all", message));
    panel.appendChild(actionRow);

    node.__gjjMemoryPanel = panel;
    node.__gjjMemoryMessage = message;
    node.__gjjMemoryStats = stats;
    node.__gjjMemoryUpdated = title.querySelector(".gjj-memory-updated");

    return panel;
}

function startPolling(node) {
    if (node.__gjjMemoryPollTimer) return;

    const tick = async () => {
        try {
            const nodes = app.graph?._nodes || [];
            if (!nodes.includes(node)) {
                clearInterval(node.__gjjMemoryPollTimer);
                node.__gjjMemoryPollTimer = null;
                return;
            }
            const detail = await requestStats(node);
            updateStatsForNode(node, detail, true);
        } catch (error) {
            if (node.__gjjMemoryMessage) {
                setStatusMessage(node.__gjjMemoryMessage, `状态更新失败：${error.message || error}`);
            }
        }
    };

    node.__gjjMemoryPollTimer = setInterval(tick, POLL_INTERVAL_MS);
    setTimeout(tick, 300);
}

function installPanel(node) {
    if (!isTargetNode(node)) return;
    if (node.__gjjMemoryPanelInstalled) return;
    node.__gjjMemoryPanelInstalled = true;

    const panel = createPanel(node);

    if (typeof node.addDOMWidget === "function") {
        node.addDOMWidget("gjj_memory_manager_panel", "div", panel, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => PANEL_HEIGHT,
            getMaxHeight: () => PANEL_HEIGHT,
        });
    } else if (typeof node.addWidget === "function") {
        node.addWidget("text", "GJJ 内存显存管理", "", () => {}, { serialize: false });
    }

    enforceMinNodeSize(node);

    const oldOnResize = node.onResize;
    node.onResize = function (...args) {
        const result = oldOnResize?.apply(this, args);
        enforceMinNodeSize(this);
        return result;
    };

    startPolling(node);
    markDirty(node);
}

function updateStatsForNode(node, detail, keepCurrentMessage = false) {
    if (!node || !node.__gjjMemoryPanel) return;

    const message = detail?.message || "已更新";
    if (node.__gjjMemoryMessage && !keepCurrentMessage) {
        setStatusMessage(node.__gjjMemoryMessage, message === "已更新" ? "" : message);
    } else if (node.__gjjMemoryMessage && node.__gjjMemoryMessage.textContent === "正在获取资源状态...") {
        setStatusMessage(node.__gjjMemoryMessage, message === "已更新" ? "" : message);
    }

    if (node.__gjjMemoryStats) {
        node.__gjjMemoryStats.innerHTML = renderStatsHtml(detail);
    }

    if (node.__gjjMemoryUpdated) {
        const d = new Date((detail?.timestamp || Date.now() / 1000) * 1000);
        node.__gjjMemoryUpdated.textContent = `最后更新: ${d.toLocaleTimeString()}`;
    }
}

api.addEventListener("gjj_memory_manager_stats", (event) => {
    const detail = event.detail || {};
    const id = String(detail.node ?? "");
    const node = app.graph?.getNodeById?.(id) || app.graph?._nodes?.find((n) => String(n.id) === id);
    updateStatsForNode(node, detail, false);
});

app.registerExtension({
    name: "GJJ.MemoryManager.Panel.V3",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = onNodeCreated?.apply(this, args);
            installPanel(this);
            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const result = onConfigure?.apply(this, args);
            ensureProps(this);
            requestAnimationFrame(() => installPanel(this));
            return result;
        };
    },
});
