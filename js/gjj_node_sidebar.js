import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const TAB_ID = "gjj-node-library";
const DRAG_TYPE = "application/x-gjj-node-type";
const ICON_URL = "./extensions/ComfyUI_GJJ_Nodes/gjj_sidebar_icon.png";
const FLAT_INITIAL_BATCH_SIZE = 24;
const FLAT_STREAM_BATCH_SIZE = 32;

const DISPLAY_CATEGORY_ALIASES = {
    "采样": "模型",
    "测试": "工具",
    "翻译": "文本",
    "分割": "图像",
    "工具": "工具",
    "工作流辅助": "工具",
    "控制网": "图像",
    "列表工具": "逻辑与流程",
    "零依赖": "工具",
    "流程控制": "逻辑与流程",
    "路由": "逻辑与流程",
    "逻辑": "逻辑与流程",
    "逻辑控制": "逻辑与流程",
    "媒体": "工具",
    "模型补丁": "模型",
    "模型测试": "模型",
    "模型加载": "模型",
    "模型优化": "模型",
    "切换器": "逻辑与流程",
    "三维": "三维",
    "实用工具": "工具",
    "视频": "视频",
    "视频工具": "视频",
    "视频模型": "视频",
    "视频生成": "视频",
    "索引": "逻辑与流程",
    "提示词": "文本",
    "条件编码": "文本",
    "图层与区域": "图像",
    "图像": "图像",
    "图像处理": "图像",
    "图像生成": "图像",
    "文本": "文本",
    "文档": "文本",
    "文件工具": "工具",
    "系统工具": "工具",
    "信息查看": "工具",
    "音频": "音频",
    "语音": "音频",
    "预览": "工具",
    "遮罩": "图像",
    "姿态": "图像",
    "LTX": "视频",
    "🎬 音视频处理": "音频",
};

const DISPLAY_CATEGORY_EMOJI = {
    "图像": "🖼️ 图像",
    "视频": "🎬 视频",
    "音频": "🎵 音频",
    "模型": "🧠 模型",
    "文本": "📝 文本",
    "逻辑与流程": "🔀 逻辑与流程",
    "工具": "🛠️ 工具",
    "三维": "🧊 三维",
};

const NODE_ICON_RULES = [
    [/(元数据|metadata)/i, "ℹ️"],
    [/(对比|比较|compare)/i, "🆚"],
    [/(遮罩|蒙版|mask|matting)/i, "🎭"],
    [/(姿势|姿态|pose|dwpose|openpose)/i, "🕺"],
    [/(裁切|裁剪|crop)/i, "✂️"],
    [/(网格|grid)/i, "▦"],
    [/(画布|canvas|绘画|painter)/i, "🎨"],
    [/(结束|end)/i, "⏹️"],
    [/(开始|start)/i, "▶️"],
    [/(循环|loop|重复|repeat)/i, "🔁"],
    [/(整数|数字|number|integer)/i, "🔢"],
    [/(条件|condition)/i, "🔀"],
    [/(FBX|三维|3D|mesh)/i, "🧊"],
    [/(模型|model|lora|vae|clip)/i, "🧠"],
    [/(视频|video|首尾帧|frame)/i, "🎬"],
    [/(音频|语音|audio|voice|tts)/i, "🎵"],
    [/(图像|图片|image)/i, "🖼️"],
    [/(文本|提示词|翻译|text|prompt)/i, "📝"],
];

const DISPLAY_CATEGORY_ORDER = [
    "🧠 模型",
    "🖼️ 图像",
    "🎬 视频",
    "🎵 音频",
    "📝 文本",
    "🔀 逻辑与流程",
    "🛠️ 工具",
    "🧊 三维",
];

const PRIORITY_NODE_TYPES = [
    "GJJ_ModelBundleLoader",
    "GJJ_VideoUniversalModelLoader",
    "GJJ_VideoKijaiModelLoader",
    "GJJ_WorkflowModelStatistics",
];

const DEFAULT_USE_COLORS = [
    { threshold: 10, color: "#60ce7f" },
    { threshold: 20, color: "#3b6cdc" },
    { threshold: 30, color: "#9c00ff" },
    { threshold: 50, color: "#fffc00" },
    { threshold: 100, color: "#cda56d" },
];

const state = {
    root: null,
    query: "",
    expanded: new Set(),
    help: {},
    usageLoaded: false,
    renderRevision: 0,
    usage: {
        sort_mode: "category",
        use_colors_enabled: true,
        use_colors: DEFAULT_USE_COLORS.map((item) => ({ ...item })),
        nodes: {},
    },
};

function sanitizeUsage(value) {
    const usage = value && typeof value === "object" ? value : {};
    return {
        sort_mode: ["category", "frequency", "recent", "name"].includes(usage.sort_mode) ? usage.sort_mode : "category",
        use_colors_enabled: usage.use_colors_enabled !== false,
        use_colors: Array.isArray(usage.use_colors) && usage.use_colors.length
            ? usage.use_colors
            : DEFAULT_USE_COLORS.map((item) => ({ ...item })),
        nodes: usage.nodes && typeof usage.nodes === "object" ? usage.nodes : {},
    };
}

async function loadUsage() {
    try {
        const response = await api.fetchApi("/gjj/node_usage", { cache: "no-store" });
        const data = await response.json();
        if (response.ok && data?.ok) state.usage = sanitizeUsage(data.usage);
    } catch (error) {
        console.warn("[GJJ Node Sidebar] 节点使用频率读取失败", error);
    } finally {
        state.usageLoaded = true;
        renderList();
        updateToolbar();
    }
}

async function postUsage(payload) {
    try {
        const response = await api.fetchApi("/gjj/node_usage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok || !data?.ok) throw new Error(data?.error || "保存失败");
        state.usage = sanitizeUsage(data.usage);
        renderList();
        updateToolbar();
        return true;
    } catch (error) {
        console.warn("[GJJ Node Sidebar] 节点使用频率保存失败", error);
        return false;
    }
}

function usageFor(type) {
    const item = state.usage.nodes?.[type];
    return {
        use_count: Math.max(0, Number(item?.use_count) || 0),
        last_used: Math.max(0, Number(item?.last_used) || 0),
    };
}

function usageColor(count) {
    if (state.usage.use_colors_enabled === false) return "";
    let color = "";
    let bestThreshold = -1;
    for (const item of state.usage.use_colors || DEFAULT_USE_COLORS) {
        const threshold = Number(item?.threshold);
        if (count > threshold && threshold > bestThreshold) {
            bestThreshold = threshold;
            color = String(item?.color || "");
        }
    }
    return color;
}

function compareNodes(a, b) {
    if (state.usage.sort_mode === "category") {
        const aPriority = PRIORITY_NODE_TYPES.indexOf(a.type);
        const bPriority = PRIORITY_NODE_TYPES.indexOf(b.type);
        if (aPriority !== -1 || bPriority !== -1) {
            return (aPriority === -1 ? Number.MAX_SAFE_INTEGER : aPriority)
                - (bPriority === -1 ? Number.MAX_SAFE_INTEGER : bPriority);
        }
    }
    const aUsage = usageFor(a.type);
    const bUsage = usageFor(b.type);
    if (state.usage.sort_mode === "recent" && bUsage.last_used !== aUsage.last_used) {
        return bUsage.last_used - aUsage.last_used;
    }
    if (state.usage.sort_mode === "frequency") {
        if (bUsage.use_count !== aUsage.use_count) return bUsage.use_count - aUsage.use_count;
        if (bUsage.last_used !== aUsage.last_used) return bUsage.last_used - aUsage.last_used;
    }
    return a.title.localeCompare(b.title, "zh-CN");
}

async function loadNodeHelp() {
    try {
        const response = await api.fetchApi("/gjj/node_help");
        if (!response?.ok) return;
        const payload = await response.json();
        state.help = payload && typeof payload === "object" ? payload : {};
        if (state.root) renderList();
    } catch (error) {
        console.warn("[GJJ Node Sidebar] 节点详细介绍读取失败", error);
    }
}

function textList(value) {
    if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
    const text = String(value || "").trim();
    return text ? [text] : [];
}

function nodeTooltip(node) {
    const backend = state.help?.[node.type] || {};
    const help = backend.help && typeof backend.help === "object" ? backend.help : {};
    const description = String(backend.description || node.description || "").trim();
    const notices = textList(help.notice);
    const dependencies = textList(help.dependencies);
    const lines = [node.title];
    if (description) lines.push("", description);
    if (notices.length) lines.push("", "使用提示：", ...notices.map((item) => `• ${item}`));
    if (dependencies.length) lines.push("", "依赖：", ...dependencies.map((item) => `• ${item}`));
    lines.push("", `分类：${node.category}`, `节点类型：${node.type}`, "", "点击添加，或拖到画布");
    return lines.join("\n");
}

function nodeCategoryIcon(node) {
    const category = String(node?.category || "").replace(/^GJJ\/?/, "");
    const originalTopLevel = category.split("/")[0] || "工具";
    const normalized = DISPLAY_CATEGORY_ALIASES[originalTopLevel] || originalTopLevel;
    return {
        "图像": "🖼️",
        "视频": "🎬",
        "音频": "🎵",
        "模型": "🧠",
        "文本": "📝",
        "逻辑与流程": "🔀",
        "工具": "🛠️",
        "三维": "🧊",
    }[normalized] || "🧩";
}

function nodeDisplayParts(node) {
    const title = String(node?.title || node?.type || "");
    const existing = title.match(/\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?/u);
    if (existing) {
        return {
            icon: existing[0],
            title: title.replace(existing[0], "").replace(/\s{2,}/g, " ").trim(),
        };
    }
    const searchable = `${title} ${node?.type || ""}`;
    const matched = NODE_ICON_RULES.find(([pattern]) => pattern.test(searchable));
    return { icon: matched?.[1] || nodeCategoryIcon(node), title };
}

function injectStyles() {
    if (document.getElementById("gjj-node-sidebar-styles")) return;
    const style = document.createElement("style");
    style.id = "gjj-node-sidebar-styles";
    style.textContent = `
        .gjj-node-library-tab-button .side-bar-button-icon,
        .gjj-node-library-tab-button .gjj-sidebar-button-icon {
            width: 20px !important;
            height: 20px !important;
            min-width: 20px !important;
            min-height: 20px !important;
            padding: 0 !important;
            position: relative !important;
            overflow: hidden !important;
            color: transparent !important;
            background: none !important;
            border-radius: 4px;
        }
        .gjj-node-library-tab-button .gjj-sidebar-icon-image {
            display: block !important;
            position: absolute;
            left: -16px;
            top: -10px;
            width: 40px !important;
            height: 36px !important;
            max-width: none !important;
            max-height: none !important;
        }
        .gjj-node-sidebar {
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
            min-height: 0;
            color: var(--fg-color);
            background: var(--comfy-menu-bg);
            font: 13px/1.4 Arial, sans-serif;
        }
        .gjj-node-sidebar-host {
            box-sizing: border-box;
            height: 100%;
            min-height: 0;
            overflow: hidden !important;
        }
        .gjj-node-sidebar__fixed {
            position: sticky;
            top: 0;
            z-index: 3;
            flex: 0 0 auto;
            background: var(--comfy-menu-bg);
        }
        .gjj-node-sidebar__header {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 12px 12px 8px;
            font-size: 15px;
            font-weight: 700;
        }
        .gjj-node-sidebar__logo {
            width: 28px;
            height: 28px;
            flex: 0 0 auto;
            object-fit: contain;
            border-radius: 6px;
        }
        .gjj-node-sidebar__search {
            box-sizing: border-box;
            width: calc(100% - 24px);
            margin: 0 12px 10px;
            padding: 8px 10px;
            border: 1px solid var(--border-color);
            border-radius: 7px;
            outline: none;
            color: var(--input-text);
            background: var(--comfy-input-bg);
        }
        .gjj-node-sidebar__search:focus {
            border-color: #35d700;
            box-shadow: 0 0 0 1px rgba(53, 215, 0, .25);
        }
        .gjj-node-sidebar__toolbar {
            display: flex;
            flex: 0 0 auto;
            align-items: center;
            gap: 5px;
            padding: 0 12px 9px;
        }
        .gjj-node-sidebar__tool {
            display: grid;
            place-items: center;
            width: 30px;
            height: 28px;
            padding: 0;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            color: var(--fg-color);
            background: var(--comfy-input-bg);
            cursor: pointer;
        }
        .gjj-node-sidebar__tool:hover,
        .gjj-node-sidebar__tool.active {
            border-color: #35d700;
            background: rgba(53, 215, 0, .13);
        }
        .gjj-node-sidebar__tool-separator {
            width: 1px;
            height: 20px;
            margin: 0 2px;
            background: var(--border-color);
        }
        .gjj-node-sidebar__list {
            flex: 1 1 auto;
            min-height: 0;
            overflow: auto;
            overscroll-behavior: contain;
            padding: 0 7px 12px;
        }
        .gjj-node-sidebar__folder,
        .gjj-node-sidebar__node {
            display: flex;
            align-items: center;
            width: 100%;
            box-sizing: border-box;
            border: 0;
            border-radius: 5px;
            color: inherit;
            background: transparent;
            text-align: left;
            cursor: pointer;
            user-select: none;
        }
        .gjj-node-sidebar__folder {
            gap: 7px;
            padding: 7px 8px;
            font-weight: 600;
        }
        .gjj-node-sidebar__node {
            gap: 8px;
            padding: 6px 8px 6px 24px;
        }
        .gjj-node-sidebar__folder:hover,
        .gjj-node-sidebar__node:hover {
            background: var(--comfy-menu-secondary-bg);
        }
        .gjj-node-sidebar__arrow {
            width: 12px;
            color: var(--descrip-text);
        }
        .gjj-node-sidebar__folder-icon {
            color: #35d700;
        }
        .gjj-node-sidebar__node-icon {
            display: inline-grid;
            place-items: center;
            width: 20px;
            min-width: 20px;
            height: 20px;
            font-size: 14px;
            line-height: 1;
            filter: saturate(.9);
        }
        .gjj-node-sidebar__node-name {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .gjj-node-sidebar__use-count {
            flex: 0 0 auto;
            margin-left: auto;
            padding-left: 8px;
            color: var(--descrip-text);
            font-size: 11px;
        }
        .gjj-node-sidebar__empty {
            padding: 18px 12px;
            color: var(--descrip-text);
            text-align: center;
        }
        .gjj-usage-settings-overlay {
            position: fixed;
            inset: 0;
            z-index: 10020;
            display: grid;
            place-items: center;
            background: rgba(0, 0, 0, .55);
        }
        .gjj-usage-settings {
            width: min(360px, calc(100vw - 32px));
            padding: 16px;
            border: 1px solid var(--border-color);
            border-radius: 10px;
            color: var(--fg-color);
            background: var(--comfy-menu-bg);
            box-shadow: 0 12px 40px rgba(0, 0, 0, .45);
        }
        .gjj-usage-settings h3 { margin: 0 0 14px; }
        .gjj-usage-settings__toggle,
        .gjj-usage-settings__row,
        .gjj-usage-settings__actions {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .gjj-usage-settings__toggle { margin-bottom: 12px; }
        .gjj-usage-settings__row { margin: 7px 0; }
        .gjj-usage-settings__row input[type="number"] { width: 72px; }
        .gjj-usage-settings__actions {
            justify-content: flex-end;
            margin-top: 15px;
        }
        .gjj-usage-settings button {
            padding: 6px 12px;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            color: var(--fg-color);
            background: var(--comfy-input-bg);
            cursor: pointer;
        }
    `;
    document.head.appendChild(style);
}

function getGjjNodes() {
    const registered = globalThis.LiteGraph?.registered_node_types || {};
    return Object.entries(registered)
        .map(([type, NodeClass]) => ({
            type,
            title: NodeClass?.title || type,
            category: String(NodeClass?.category || ""),
            description: String(NodeClass?.description || NodeClass?.nodeData?.description || "").trim(),
        }))
        .filter((node) => node.category === "GJJ" || node.category.startsWith("GJJ/"))
        .sort(compareNodes);
}

function groupNodes(nodes) {
    const groups = new Map();
    for (const node of nodes) {
        const category = node.category.replace(/^GJJ\/?/, "") || "其他";
        const originalTopLevel = category.split("/")[0] || "其他";
        const normalizedCategory = DISPLAY_CATEGORY_ALIASES[originalTopLevel] || originalTopLevel;
        const displayCategory = DISPLAY_CATEGORY_EMOJI[normalizedCategory] || normalizedCategory;
        if (!groups.has(displayCategory)) groups.set(displayCategory, []);
        groups.get(displayCategory).push(node);
    }
    return [...groups.entries()].sort(([a], [b]) => {
        const aIndex = DISPLAY_CATEGORY_ORDER.indexOf(a);
        const bIndex = DISPLAY_CATEGORY_ORDER.indexOf(b);
        if (aIndex !== -1 || bIndex !== -1) {
            return (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex)
                - (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex);
        }
        return a.localeCompare(b, "zh-CN");
    });
}

function canvasPositionFromEvent(event) {
    if (app.canvas?.convertEventToCanvasOffset) {
        return app.canvas.convertEventToCanvasOffset(event);
    }
    const canvas = app.canvas?.canvas;
    const rect = canvas?.getBoundingClientRect?.();
    const scale = app.canvas?.ds?.scale || 1;
    const offset = app.canvas?.ds?.offset || [0, 0];
    return [
        ((event.clientX - (rect?.left || 0)) / scale) - offset[0],
        ((event.clientY - (rect?.top || 0)) / scale) - offset[1],
    ];
}

function createNode(type, position) {
    const node = globalThis.LiteGraph?.createNode(type);
    if (!node || !app.graph) return false;
    node.pos = position || app.canvas?.graph_mouse || [100, 100];
    app.graph.add(node);
    app.canvas?.selectNode?.(node);
    app.canvas?.setDirty?.(true, true);
    recordNodeUse(type);
    return true;
}

function recordNodeUse(type) {
    const current = usageFor(type);
    state.usage.nodes[type] = {
        use_count: current.use_count + 1,
        last_used: Date.now(),
    };
    renderList();
    void postUsage({ action: "record", node_type: type });
}

function renderList() {
    const list = state.root?.querySelector(".gjj-node-sidebar__list");
    if (!list) return;
    const renderRevision = ++state.renderRevision;

    const query = state.query.trim().toLocaleLowerCase();
    const nodes = getGjjNodes().filter((node) => (
        !query
        || node.title.toLocaleLowerCase().includes(query)
        || node.type.toLocaleLowerCase().includes(query)
        || node.category.toLocaleLowerCase().includes(query)
        || node.description.toLocaleLowerCase().includes(query)
        || String(state.help?.[node.type]?.description || "").toLocaleLowerCase().includes(query)
    ));
    list.replaceChildren();

    if (!nodes.length) {
        const empty = document.createElement("div");
        empty.className = "gjj-node-sidebar__empty";
        empty.textContent = "没有找到 GJJ 节点";
        list.appendChild(empty);
        return;
    }

    const appendNode = (node, target = list) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "gjj-node-sidebar__node";
        const use = usageFor(node.type);
        const color = usageColor(use.use_count);
        const display = nodeDisplayParts(node);
        item.innerHTML = `
            <span class="gjj-node-sidebar__node-icon" aria-hidden="true"></span>
            <span class="gjj-node-sidebar__node-name"></span>
            ${use.use_count > 0 ? `<span class="gjj-node-sidebar__use-count">🔥 ${use.use_count}</span>` : ""}
        `;
        item.querySelector(".gjj-node-sidebar__node-icon").textContent = display.icon;
        const name = item.querySelector(".gjj-node-sidebar__node-name");
        name.textContent = display.title;
        if (color) name.style.color = color;
        item.title = `${nodeTooltip(node)}\n使用次数：${use.use_count}\n右键可清空该节点频率`;
        item.draggable = true;
        item.addEventListener("click", () => createNode(node.type));
        item.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            if (use.use_count > 0 && confirm(`清空“${node.title}”的使用频率吗？`)) {
                void postUsage({ action: "clear", node_type: node.type });
            }
        });
        item.addEventListener("dragstart", (event) => {
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData(DRAG_TYPE, node.type);
            event.dataTransfer.setData("text/plain", node.type);
        });
        target.appendChild(item);
    };

    if (state.usage.sort_mode !== "category") {
        let nextIndex = 0;
        const status = document.createElement("div");
        status.className = "gjj-node-sidebar__empty";

        const appendBatch = (batchSize) => {
            if (renderRevision !== state.renderRevision || !list.isConnected) return;
            const fragment = document.createDocumentFragment();
            const end = Math.min(nodes.length, nextIndex + batchSize);
            while (nextIndex < end) appendNode(nodes[nextIndex++], fragment);
            list.insertBefore(fragment, status.isConnected ? status : null);

            if (nextIndex >= nodes.length) {
                status.remove();
                return;
            }
            status.textContent = `正在加载节点… ${nextIndex}/${nodes.length}`;
            if (!status.isConnected) list.appendChild(status);
            requestAnimationFrame(() => appendBatch(FLAT_STREAM_BATCH_SIZE));
        };

        appendBatch(FLAT_INITIAL_BATCH_SIZE);
        return;
    }

    for (const [category, categoryNodes] of groupNodes(nodes)) {
        const expanded = query || state.expanded.has(category);
        const folder = document.createElement("button");
        folder.type = "button";
        folder.className = "gjj-node-sidebar__folder";
        folder.innerHTML = `
            <span class="gjj-node-sidebar__arrow">${expanded ? "⌄" : "›"}</span>
            <span class="gjj-node-sidebar__folder-icon">□</span>
            <span>${category}</span>
            <span style="margin-left:auto;color:var(--descrip-text);font-weight:400">${categoryNodes.length}</span>
        `;
        folder.addEventListener("click", () => {
            if (state.expanded.has(category)) state.expanded.delete(category);
            else state.expanded.add(category);
            renderList();
        });
        list.appendChild(folder);

        if (!expanded) continue;
        categoryNodes.forEach(appendNode);
    }
}

function updateToolbar() {
    const toolbar = state.root?.querySelector(".gjj-node-sidebar__toolbar");
    if (!toolbar) return;
    for (const button of toolbar.querySelectorAll("[data-sort]")) {
        button.classList.toggle("active", button.dataset.sort === state.usage.sort_mode);
    }
}

function showUsageSettings() {
    if (document.querySelector(".gjj-usage-settings-overlay")) return;
    const overlay = document.createElement("div");
    overlay.className = "gjj-usage-settings-overlay";
    const colors = state.usage.use_colors || DEFAULT_USE_COLORS;
    overlay.innerHTML = `
        <div class="gjj-usage-settings">
            <h3>节点使用频率设置</h3>
            <label class="gjj-usage-settings__toggle">
                <input type="checkbox" data-role="enabled" ${state.usage.use_colors_enabled !== false ? "checked" : ""}>
                <span>根据使用频率变色</span>
            </label>
            ${colors.map((item, index) => `
                <label class="gjj-usage-settings__row">
                    <span>${index + 1}</span>
                    <input type="color" data-color="${index}" value="${item.color}">
                    <span>超过</span>
                    <input type="number" data-threshold="${index}" min="0" step="1" value="${item.threshold}">
                    <span>次</span>
                </label>
            `).join("")}
            <div class="gjj-usage-settings__actions">
                <button type="button" data-role="reset">恢复默认</button>
                <button type="button" data-role="cancel">取消</button>
                <button type="button" data-role="save">保存</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay || event.target.closest("[data-role='cancel']")) overlay.remove();
    });
    overlay.querySelector("[data-role='reset']").addEventListener("click", () => {
        DEFAULT_USE_COLORS.forEach((item, index) => {
            const color = overlay.querySelector(`[data-color="${index}"]`);
            const threshold = overlay.querySelector(`[data-threshold="${index}"]`);
            if (color) color.value = item.color;
            if (threshold) threshold.value = item.threshold;
        });
        overlay.querySelector("[data-role='enabled']").checked = true;
    });
    overlay.querySelector("[data-role='save']").addEventListener("click", async () => {
        const useColors = colors.map((_, index) => ({
            threshold: Math.max(0, Number(overlay.querySelector(`[data-threshold="${index}"]`)?.value) || 0),
            color: overlay.querySelector(`[data-color="${index}"]`)?.value || DEFAULT_USE_COLORS[index]?.color || "#ffffff",
        }));
        const saved = await postUsage({
            action: "settings",
            use_colors_enabled: overlay.querySelector("[data-role='enabled']").checked,
            use_colors: useColors,
        });
        if (saved) overlay.remove();
    });
}

function renderPanel(element) {
    state.root = element;
    element.classList.add("gjj-node-sidebar-host");
    element.replaceChildren();
    element.innerHTML = `
        <section class="gjj-node-sidebar">
            <div class="gjj-node-sidebar__fixed">
                <header class="gjj-node-sidebar__header">
                    <img class="gjj-node-sidebar__logo" src="${ICON_URL}" alt="">
                    <span>GJJ 节点</span>
                </header>
                <nav class="gjj-node-sidebar__toolbar" aria-label="节点排序工具栏">
                    <button class="gjj-node-sidebar__tool" type="button" data-sort="category" title="按分类显示">🗂️</button>
                    <button class="gjj-node-sidebar__tool" type="button" data-sort="frequency" title="按使用频率排序">🔥</button>
                    <button class="gjj-node-sidebar__tool" type="button" data-sort="recent" title="按最近使用排序">🕒</button>
                    <button class="gjj-node-sidebar__tool" type="button" data-sort="name" title="按名称排序">🔤</button>
                    <span class="gjj-node-sidebar__tool-separator"></span>
                    <button class="gjj-node-sidebar__tool" type="button" data-action="settings" title="频率颜色设置">⚙️</button>
                    <button class="gjj-node-sidebar__tool" type="button" data-action="clear" title="清空全部使用频率">🗑️</button>
                </nav>
                <input class="gjj-node-sidebar__search" type="search" placeholder="搜索 GJJ 节点…" autocomplete="off">
            </div>
            <div class="gjj-node-sidebar__list"></div>
        </section>
    `;
    const search = element.querySelector(".gjj-node-sidebar__search");
    search.value = state.query;
    search.addEventListener("input", () => {
        state.query = search.value;
        renderList();
    });
    for (const button of element.querySelectorAll("[data-sort]")) {
        button.addEventListener("click", () => {
            state.usage.sort_mode = button.dataset.sort;
            renderList();
            updateToolbar();
            void postUsage({ action: "settings", sort_mode: button.dataset.sort });
        });
    }
    element.querySelector("[data-action='settings']").addEventListener("click", showUsageSettings);
    element.querySelector("[data-action='clear']").addEventListener("click", () => {
        const hasUsage = Object.values(state.usage.nodes || {}).some((item) => Number(item?.use_count) > 0);
        if (hasUsage && confirm("确定清空全部 GJJ 节点的使用频率记录吗？")) {
            void postUsage({ action: "clear" });
        }
    });
    renderList();
    updateToolbar();
    if (!state.usageLoaded) void loadUsage();
}

function findNativeNodesButton() {
    const direct = document.querySelector(
        ".node-library-tab-button, .nodes-tab-button, [data-tab-id='node-library'], [data-tab-id='nodes']"
    );
    if (direct) return direct;
    const sidebar = document.querySelector(".sidebar-item-group");
    return [...(sidebar?.querySelectorAll("button") || [])].find((button) => {
        const label = `${button.title || ""} ${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.trim();
        return /^(节点|nodes?|node library)$/i.test(label);
    }) || null;
}

function placeButtonBelowNodes() {
    const button = document.querySelector(".gjj-node-library-tab-button");
    const nativeNodes = findNativeNodesButton();
    if (!button || !nativeNodes || !nativeNodes.parentElement) return false;
    if (nativeNodes.nextElementSibling !== button) {
        nativeNodes.parentElement.insertBefore(button, nativeNodes.nextElementSibling);
    }
    return true;
}

function replaceSidebarIcon() {
    const button = document.querySelector(".gjj-node-library-tab-button");
    if (!button) return false;
    const icon = button.querySelector(".side-bar-button-icon")
        || button.querySelector("[class*='side-bar'][class*='icon']")
        || button.querySelector("i");
    if (!icon) return false;
    icon.classList.add("gjj-sidebar-button-icon");
    icon.replaceChildren();
    const image = document.createElement("img");
    image.className = "gjj-sidebar-icon-image";
    image.src = ICON_URL;
    image.alt = "";
    icon.appendChild(image);
    return true;
}

function decorateAndPlaceButton() {
    injectStyles();
    const iconReady = replaceSidebarIcon();
    const positionReady = placeButtonBelowNodes();
    if (iconReady && positionReady) return;
    const sidebar = document.querySelector(".sidebar-item-group");
    if (!sidebar) {
        setTimeout(decorateAndPlaceButton, 200);
        return;
    }
    const observer = new MutationObserver(() => {
        const iconDone = replaceSidebarIcon();
        const positionDone = placeButtonBelowNodes();
        if (iconDone && positionDone) observer.disconnect();
    });
    observer.observe(sidebar, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 8000);
}

function installCanvasDrop() {
    document.addEventListener("dragover", (event) => {
        if (event.dataTransfer?.types?.includes(DRAG_TYPE)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
        }
    });
    document.addEventListener("drop", (event) => {
        const type = event.dataTransfer?.getData(DRAG_TYPE);
        if (!type) return;
        const canvas = app.canvas?.canvas;
        if (canvas && event.target !== canvas) return;
        event.preventDefault();
        event.stopPropagation();
        createNode(type, canvasPositionFromEvent(event));
    }, true);
}

app.registerExtension({
    name: "GJJ.NodeSidebar",
    async setup() {
        injectStyles();
        installCanvasDrop();
        loadNodeHelp();
        const waitForSidebar = () => {
            if (!app.extensionManager?.registerSidebarTab) {
                setTimeout(waitForSidebar, 100);
                return;
            }
            app.extensionManager.registerSidebarTab({
                id: TAB_ID,
                icon: "icon-[lucide--box]",
                title: "GJJ",
                tooltip: "GJJ",
                type: "custom",
                render: renderPanel,
            });
            decorateAndPlaceButton();
        };
        waitForSidebar();
    },
});
