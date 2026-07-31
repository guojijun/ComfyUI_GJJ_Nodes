import { app } from "../../../scripts/app.js";

const TAB_ID = "gjj-node-library";
const DRAG_TYPE = "application/x-gjj-node-type";
const ICON_URL = "./extensions/ComfyUI_GJJ_Nodes/gjj_sidebar_icon.png";

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

const state = {
    root: null,
    query: "",
    expanded: new Set(),
};

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
        .gjj-node-sidebar__list {
            min-height: 0;
            overflow: auto;
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
            padding: 6px 8px 6px 34px;
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
        .gjj-node-sidebar__node::before {
            content: "";
            width: 6px;
            height: 6px;
            margin-right: 9px;
            border: 1px solid #35d700;
            border-radius: 50%;
        }
        .gjj-node-sidebar__empty {
            padding: 18px 12px;
            color: var(--descrip-text);
            text-align: center;
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
        }))
        .filter((node) => node.category === "GJJ" || node.category.startsWith("GJJ/"))
        .sort((a, b) => {
            const aPriority = PRIORITY_NODE_TYPES.indexOf(a.type);
            const bPriority = PRIORITY_NODE_TYPES.indexOf(b.type);
            if (aPriority !== -1 || bPriority !== -1) {
                return (aPriority === -1 ? Number.MAX_SAFE_INTEGER : aPriority)
                    - (bPriority === -1 ? Number.MAX_SAFE_INTEGER : bPriority);
            }
            return a.title.localeCompare(b.title, "zh-CN");
        });
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
    return true;
}

function renderList() {
    const list = state.root?.querySelector(".gjj-node-sidebar__list");
    if (!list) return;

    const query = state.query.trim().toLocaleLowerCase();
    const nodes = getGjjNodes().filter((node) => (
        !query
        || node.title.toLocaleLowerCase().includes(query)
        || node.type.toLocaleLowerCase().includes(query)
        || node.category.toLocaleLowerCase().includes(query)
    ));
    const groups = groupNodes(nodes);
    list.replaceChildren();

    if (!groups.length) {
        const empty = document.createElement("div");
        empty.className = "gjj-node-sidebar__empty";
        empty.textContent = "没有找到 GJJ 节点";
        list.appendChild(empty);
        return;
    }

    for (const [category, categoryNodes] of groups) {
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
        for (const node of categoryNodes) {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "gjj-node-sidebar__node";
            item.textContent = node.title;
            item.title = `${node.title}\n${node.category}\n点击添加，或拖到画布`;
            item.draggable = true;
            item.addEventListener("click", () => createNode(node.type));
            item.addEventListener("dragstart", (event) => {
                event.dataTransfer.effectAllowed = "copy";
                event.dataTransfer.setData(DRAG_TYPE, node.type);
                event.dataTransfer.setData("text/plain", node.type);
            });
            list.appendChild(item);
        }
    }
}

function renderPanel(element) {
    state.root = element;
    element.replaceChildren();
    element.innerHTML = `
        <section class="gjj-node-sidebar">
            <header class="gjj-node-sidebar__header">
                <img class="gjj-node-sidebar__logo" src="${ICON_URL}" alt="">
                <span>GJJ 节点</span>
            </header>
            <input class="gjj-node-sidebar__search" type="search" placeholder="搜索 GJJ 节点…" autocomplete="off">
            <div class="gjj-node-sidebar__list"></div>
        </section>
    `;
    const search = element.querySelector(".gjj-node-sidebar__search");
    search.value = state.query;
    search.addEventListener("input", () => {
        state.query = search.value;
        renderList();
    });
    renderList();
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
