/**
 * GJJ Node Arranger - ComfyUI 节点自动排列工具
 * 支持：
 * 1. 智能自动排列
 * 2. 多种拓扑排序
 * 3. 水平排列
 * 4. 垂直排列
 * 5. 海报式网格预览排版
 * 6. 右键菜单
 * 7. 顶部工具栏
 * 8. 快捷键
 */

import { app } from "/scripts/app.js";

const NODE_NAME = "GJJ_NodeArranger";
const SETTING_CONTEXT_MENU_ENABLED = "GJJ.NodeArranger.Menu.Enabled";
const LEGACY_CONTEXT_MENU_SETTING = "GJJ.NodeArranger.LegacyCanvasMenu.Enabled";

const MOVE_UNIT = 1;

let DEFAULT_SPACING = 26;

const LAYOUT_GAP_STEP = 8;
let LAST_ARRANGE_MODE = "auto";

const MIN_NODE_WIDTH = 80; // 仅保留兼容旧配置；普通排列不再强制修改真实宽度。
const MIN_REROUTE_WIDTH = 24;
const COLLAPSED_NODE_WIDTH = 80;
const COLLAPSED_NODE_HEIGHT = 30;

// 普通排列不再强制修改真实宽度。
// 这里的布局宽度只用于“计算占位”和“防覆盖”；要尽量包含节点真实宽度，避免宽节点盖住邻居。
const MIN_LAYOUT_NODE_WIDTH = 168;
const MAX_LAYOUT_NODE_WIDTH = 1200;
let HORIZONTAL_SAFE_GAP = 28;
let VERTICAL_SAFE_GAP = DEFAULT_SPACING;
const SINGLE_NODE_CONNECTED_ROW_GAP = 5;

// 间距调节：想更松只改上面 3 个值：DEFAULT_SPACING / HORIZONTAL_SAFE_GAP / VERTICAL_SAFE_GAP。
// 节点真实宽度仍保持最小，布局计算会按 MIN_LAYOUT_NODE_WIDTH 预留视觉空间，避免互相覆盖。

// 智能作用范围：
// - 没有选择：作用全部
// - 全部选择：作用全部
// - 只有部分选择：只作用所选
// 兼容新版/旧版 ComfyUI：有的版本 node.selected 不可靠，需要同时读 canvas.selected_nodes。

let LAST_CLICKED_NODE_FOR_GJJ_ARRANGE = null;

function gjjSettingValue(id, fallback = undefined) {
	try {
		const viaGjj = globalThis.GJJ_Settings?.get?.(id, undefined);
		if (viaGjj !== undefined) return viaGjj;
	} catch (_) {}
	try {
		const viaComfy = app?.ui?.settings?.getSettingValue?.(id);
		return viaComfy === undefined ? fallback : viaComfy;
	} catch (_) {
		return fallback;
	}
}

function gjjSettingEnabled(id, fallback = true) {
	return Boolean(gjjSettingValue(id, fallback));
}

function rememberFocusedNodeForArrange(node) {
	LAST_CLICKED_NODE_FOR_GJJ_ARRANGE = isRealNode(node) ? node : null;
}

function getCanvasFocusedNodeForArrange() {
	const canvas = app?.canvas;
	const candidates = [
		canvas?.current_node,
		canvas?.selected_node,
		canvas?.selectedNode,
		canvas?._selected_node,
		LAST_CLICKED_NODE_FOR_GJJ_ARRANGE,
		window?.LiteGraph?.active_canvas?.current_node,
	];

	for (const node of candidates) {
		if (isRealNode(node)) return node;
	}
	return null;
}

function installFocusedNodeTracker() {
	if (window.__gjjNodeArrangerFocusTrackerInstalled) return;
	window.__gjjNodeArrangerFocusTrackerInstalled = true;

	const update = () => {
		const canvas = app?.canvas;
		const node = canvas?.node_over || canvas?.nodeOver || canvas?.mouse_node || canvas?.mouseNode || canvas?._node_over || window?.LiteGraph?.active_canvas?.node_over || getCanvasFocusedNodeForArrange();
		rememberFocusedNodeForArrange(node);
	};

	document.addEventListener("mousedown", update, true);
	document.addEventListener("pointerdown", update, true);
}

function addSelectedNodeCandidate(result, value, key = null) {
	if (!value && key == null) return;

	if (value && typeof value === "object") {
		if (isRealNode(value)) {
			result.add(value);
			return;
		}

		if (value.node && isRealNode(value.node)) {
			result.add(value.node);
			return;
		}

		if (value.id != null) {
			const node = getNodeById(value.id);
			if (node) {
				result.add(node);
				return;
			}
		}
	}

	if (value && value !== true) {
		const node = getNodeById(value);
		if (node) {
			result.add(node);
			return;
		}
	}

	if (key != null) {
		const node = getNodeById(key);
		if (node) result.add(node);
	}
}

function collectSelectedFromValue(result, selected) {
	if (!selected) return;

	if (selected instanceof Set) {
		for (const item of selected) addSelectedNodeCandidate(result, item);
		return;
	}

	if (selected instanceof Map) {
		for (const [key, value] of selected.entries()) addSelectedNodeCandidate(result, value, key);
		return;
	}

	if (Array.isArray(selected)) {
		for (const item of selected) addSelectedNodeCandidate(result, item);
		return;
	}

	if (typeof selected === "object") {
		for (const [key, value] of Object.entries(selected)) {
			addSelectedNodeCandidate(result, value, key);
		}
	}
}

function getCanvasSelectedNodeSet() {
	const result = new Set();
	const canvas = app?.canvas;

	collectSelectedFromValue(result, canvas?.selected_nodes);
	collectSelectedFromValue(result, canvas?.selectedNodes);
	collectSelectedFromValue(result, canvas?.selected_items);
	collectSelectedFromValue(result, canvas?.selectedItems);
	collectSelectedFromValue(result, canvas?.selection);
	collectSelectedFromValue(result, canvas?._selected_nodes);

	try {
		collectSelectedFromValue(result, window?.LiteGraph?.active_canvas?.selected_nodes);
	} catch {}

	return result;
}

function getSelectedNodeSetForScope() {
	const canvasSelected = getCanvasSelectedNodeSet();
	const allNodes = filterValidNodes(getAllGraphNodes(), false);
	const allSet = new Set(allNodes);
	const result = new Set();

	if (canvasSelected.size > 0) {
		for (const node of canvasSelected) {
			if (allSet.has(node)) result.add(node);
		}
		return result;
	}

	for (const node of allNodes) {
		if (node.selected || node.flags?.selected || node.__selected || node.is_selected) {
			result.add(node);
		}
	}

	// 有些 ComfyUI 版本单选节点时不写 node.selected，
	// 但会把当前节点放在 canvas.current_node / selected_node / node_over。
	// 这里作为单节点模式的兜底，恢复“选中单节点按快捷键就有反应”的行为。
	if (result.size === 0) {
		const focused = getCanvasFocusedNodeForArrange();
		if (focused && allSet.has(focused)) result.add(focused);
	}

	return result;
}

function isNodeSelectedForScope(node) {
	if (!node) return false;
	return getSelectedNodeSetForScope().has(node);
}

function getSelectedCountForScope(nodes) {
	const selectedSet = getSelectedNodeSetForScope();
	let count = 0;
	for (const node of filterValidNodes(nodes, false)) {
		if (selectedSet.has(node)) count++;
	}
	return count;
}

function getExplicitSelectedNodeSetForScope() {
	const canvasSelected = getCanvasSelectedNodeSet();
	const allNodes = filterValidNodes(getAllGraphNodes(), false);
	const allSet = new Set(allNodes);
	const result = new Set();

	if (canvasSelected.size > 0) {
		for (const node of canvasSelected) {
			if (allSet.has(node)) result.add(node);
		}
		return result;
	}

	for (const node of allNodes) {
		if (node.selected || node.flags?.selected || node.__selected || node.is_selected) {
			result.add(node);
		}
	}

	return result;
}

function shouldUseSelectedOnly() {
	const nodes = filterValidNodes(getAllGraphNodes(), false);
	if (nodes.length === 0) return false;

	// 这里必须只看“真实选中”，不能用 current_node / node_over / 最近点击节点。
	// 否则没有任何选择时，鼠标悬停节点也会被误判成“部分选择”，
	// 顶部按钮/右键菜单就只作用到一个节点，看起来像“没有反应”。
	const selectedSet = getExplicitSelectedNodeSetForScope();
	let selectedCount = 0;
	for (const node of nodes) {
		if (selectedSet.has(node)) selectedCount++;
	}

	return selectedCount > 0 && selectedCount < nodes.length;
}

function getSmartScopeLabel() {
	return shouldUseSelectedOnly() ? "部分选择：仅作用所选节点" : "未选择或全选：作用全部节点";
}

function roundLayoutGap(value) {
	const gap = Number(value);
	return Number.isFinite(gap) ? Math.round(gap) : 0;
}

function getColumnGap(spacing = DEFAULT_SPACING) {
	return roundLayoutGap(Math.max(HORIZONTAL_SAFE_GAP, spacing));
}

function getRowGap(_spacing = DEFAULT_SPACING) {
	return roundLayoutGap(VERTICAL_SAFE_GAP);
}

function adjustLayoutGap(axis, delta) {
	const d = Math.round(Number(delta) || 0);
	if (axis === "column") {
		DEFAULT_SPACING = roundLayoutGap(DEFAULT_SPACING + d);
		HORIZONTAL_SAFE_GAP = roundLayoutGap(HORIZONTAL_SAFE_GAP + d);
		console.log(`[GJJ_NodeArranger] 列宽/横向间距: ${getColumnGap()}px`);
		return;
	}

	VERTICAL_SAFE_GAP = roundLayoutGap(VERTICAL_SAFE_GAP + d);
	console.log(`[GJJ_NodeArranger] 行高/纵向间距: ${getRowGap()}px`);
}

function rerunLastArrangement() {
	const mode = LAST_ARRANGE_MODE || "auto";
	if (Object.values(TOPO_SORT_MODES).includes(mode)) {
		arrangeTopologicalFromGraph(mode, shouldUseSelectedOnly(), DEFAULT_SPACING);
		return;
	}
	arrangeNodes(mode, DEFAULT_SPACING, 10, 0.5, true, true, shouldUseSelectedOnly());
}

const REROUTE_TYPES = new Set([
	"Reroute",
	"PrimitiveNode",
	"Reroute (rgthree)",
	"ReroutePrimitive",
]);

const SET_NODE_TYPES = new Set(["GJJ_SetNode", "SetNode", "Set"]);
const GET_NODE_TYPES = new Set(["GJJ_GetNode", "GetNode", "Get"]);
const BROADCAST_PROPERTY = "gjj_variable_broadcast_enabled";
const PRIORITY_ARRANGE_NODE_TYPES = ["GJJ_MemoryManager","GJJ_TextInput","GJJ_TemplateParams","LoraChainConfig",	"GJJ_ModelBundleLoader","GJJ_VideoKijaiModelLoader","GJJ_VideoUniversalModelLoader","GJJ_LTXDirector"];
const PRIORITY_ARRANGE_NODE_TYPE_SET = new Set(PRIORITY_ARRANGE_NODE_TYPES);
const PRIORITY_ARRANGE_NODE_RANKS = new Map(PRIORITY_ARRANGE_NODE_TYPES.map((type, index) => [type, index]));
const PRIORITY_ARRANGE_NODE_PATTERNS = [
	/GJJ_TemplateParams|TemplateParams|模板参数输入器|模板参数/i,
	/GJJ_ModelBundleLoader|ModelBundleLoader|智能批量模型加载|模型包加载/i,
	/GJJ_VideoKijaiModelLoader|VideoKijaiModelLoader|Kijai.*模型|视频Kijai模型/i,
	/GJJ_VideoUniversalModelLoader|VideoUniversalModelLoader|视频通用模型|通用模型加载/i,
];

const TOPO_SORT_MODES = {
	TOPO_MAIN_PATH: "topo_main_path",
	TOPO_OUTPUT_ANCHOR: "topo_output_anchor",
	TOPO_COMPACT: "topo_compact",
	TOPO_BRANCH: "topo_branch",
	TOPO_ORIGINAL_Y: "topo_original_y",
};

const TOPO_SORT_MODE_LIST = [
	{
		key: TOPO_SORT_MODES.TOPO_MAIN_PATH,
		label: "🔢 拓扑：主链路",
		title: "输入/源头在左，输出在右；按最长上游路径分层，适合大多数工作流。",
	},
	{
		key: TOPO_SORT_MODES.TOPO_OUTPUT_ANCHOR,
		label: "🎯 拓扑：输出锚定",
		title: "输出节点固定在最右侧，反向整理上游链路，适合以最终输出为中心整理。",
	},
	{
		key: TOPO_SORT_MODES.TOPO_COMPACT,
		label: "🧩 拓扑：紧凑层级",
		title: "减少横向和纵向距离，让工作流更紧凑。",
	},
	{
		key: TOPO_SORT_MODES.TOPO_BRANCH,
		label: "🌿 拓扑：分支优先",
		title: "按分支和出度组织节点，让多分支结构更清楚。",
	},
	{
		key: TOPO_SORT_MODES.TOPO_ORIGINAL_Y,
		label: "↕️ 拓扑：保持上下",
		title: "只按拓扑关系分列，尽量保持原来的上下顺序。",
	},
];

function getTopoModeConfig(sortMode) {
	const mode = String(sortMode || TOPO_SORT_MODES.TOPO_MAIN_PATH);

	const configs = {
		[TOPO_SORT_MODES.TOPO_MAIN_PATH]: {
			name: "拓扑：主链路",
			levelStrategy: "sourceLongest",
			xDirection: "leftToRight",
			sortStrategy: "barycenter",
			colWidth: 16,
			rowGap: 14,
			isolatedSide: "left",
		},
		[TOPO_SORT_MODES.TOPO_OUTPUT_ANCHOR]: {
			name: "拓扑：输出锚定",
			levelStrategy: "sinkLongest",
			xDirection: "rightOutput",
			sortStrategy: "barycenter",
			colWidth: 16,
			rowGap: 14,
			isolatedSide: "left",
		},
		[TOPO_SORT_MODES.TOPO_COMPACT]: {
			name: "拓扑：紧凑层级",
			levelStrategy: "sourceLongest",
			xDirection: "leftToRight",
			sortStrategy: "barycenter",
			colWidth: 16,
			rowGap: 14,
			isolatedSide: "left",
		},
		[TOPO_SORT_MODES.TOPO_BRANCH]: {
			name: "拓扑：分支优先",
			levelStrategy: "sourceLongest",
			xDirection: "leftToRight",
			sortStrategy: "branch",
			colWidth: 16,
			rowGap: 14,
			isolatedSide: "left",
		},
		[TOPO_SORT_MODES.TOPO_ORIGINAL_Y]: {
			name: "拓扑：保持上下",
			levelStrategy: "sourceLongest",
			xDirection: "leftToRight",
			sortStrategy: "originalY",
			colWidth: 16,
			rowGap: 14,
			isolatedSide: "left",
		},
	};

	return configs[mode] || configs[TOPO_SORT_MODES.TOPO_MAIN_PATH];
}

const ARRANGE_MODE_LABELS = {
	auto: "🧭 智能中心扩散",
	horizontal: "➡️ 水平排列",
	vertical: "⬇️ 垂直排列",
	grid: "⊞ 正方形预览排版",
	topological: "🔢 拓扑：主链路",
};

let __gjjArrangeModeToastTimer = null;

function getArrangeModeLabel(mode) {
	const key = String(mode || "auto");
	const topoItem = TOPO_SORT_MODE_LIST.find((item) => item.key === key);
	const topoName = Object.values(TOPO_SORT_MODES).includes(key) ? getTopoModeConfig(key).name : null;
	return topoItem?.label || ARRANGE_MODE_LABELS[key] || topoName || key;
}

function getIsolatedBlockHint(mode) {
	return String(mode || "") === "vertical" ? "孤立节点最后排在左上列" : "孤立节点最后排在左上角";
}

function showArrangeModeToast(mode, selectedOnly = false) {
	try {
		if (typeof document === "undefined" || !document.body) return;

		let toast = document.querySelector("[data-gjj-node-arranger-toast='1']");
		if (!toast) {
			toast = document.createElement("div");
			toast.dataset.gjjNodeArrangerToast = "1";
			toast.style.cssText = [
				"position: fixed",
				"top: 22px",
				"left: 50%",
				"transform: translateX(-50%)",
				"z-index: 999999",
				"max-width: min(720px, calc(100vw - 48px))",
				"padding: 10px 16px",
				"border-radius: 999px",
				"border: 1px solid rgba(113, 203, 255, 0.55)",
				"background: rgba(18, 28, 34, 0.94)",
				"box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35)",
				"color: #e8f6ff",
				"font-size: 13px",
				"font-weight: 600",
				"letter-spacing: 0.02em",
				"line-height: 1.35",
				"pointer-events: none",
				"opacity: 0",
				"transition: opacity 0.22s ease, transform 0.22s ease",
				"white-space: nowrap",
				"text-align: center",
			].join(";");
			document.body.appendChild(toast);
		}

		const scopeText = selectedOnly ? "仅所选节点" : "全部节点";
		toast.textContent = `📐 当前排列：${getArrangeModeLabel(mode)} · ${scopeText} · ${getIsolatedBlockHint(mode)}`;
		toast.style.opacity = "0";
		toast.style.transform = "translateX(-50%) translateY(-6px)";

		clearTimeout(__gjjArrangeModeToastTimer);
		requestAnimationFrame(() => {
			toast.style.opacity = "1";
			toast.style.transform = "translateX(-50%) translateY(0)";
		});

		__gjjArrangeModeToastTimer = setTimeout(() => {
			toast.style.opacity = "0";
			toast.style.transform = "translateX(-50%) translateY(-6px)";
			setTimeout(() => {
				if (toast.parentNode && toast.style.opacity === "0") {
					toast.remove();
				}
			}, 260);
		}, 10000);
	} catch (error) {
		console.warn("[GJJ_NodeArranger] show arrange toast failed:", error);
	}
}

function safeArray(value) {
	return Array.isArray(value) ? value : [];
}

function getStoredNodeWidth(node) {
	return Number(node?.size?.[0] || node?.size?.width || 240);
}

function measureTextWidthForLayout(text) {
	let width = 0;
	for (const ch of String(text || "")) {
		width += /[⺀-鿿]/.test(ch) ? 14 : 8;
	}
	return width;
}

function getNodeTitleForLayout(node) {
	return String(node?.title || node?.name || node?.comfyClass || node?.type || "");
}

function getLongestSlotTextWidth(node) {
	let width = 0;
	for (const input of safeArray(node?.inputs)) {
		width = Math.max(width, measureTextWidthForLayout(input?.label || input?.name || input?.type || ""));
	}
	for (const output of safeArray(node?.outputs)) {
		width = Math.max(width, measureTextWidthForLayout(output?.label || output?.name || output?.type || ""));
	}
	return width;
}

function getNodeWidth(node) {
	if (isRerouteNode(node)) return Math.max(MIN_REROUTE_WIDTH, getStoredNodeWidth(node));

	const storedWidth = getStoredNodeWidth(node);
	const titleWidth = measureTextWidthForLayout(getNodeTitleForLayout(node));
	const slotWidth = getLongestSlotTextWidth(node);
	const estimated = Math.max(
		MIN_LAYOUT_NODE_WIDTH,
		storedWidth,
		titleWidth + 56,
		slotWidth + 96
	);

	// 注意：这里不能再用 340 之类的小上限截断。
	// 宽节点、长文本节点、手动拉宽的节点都必须按真实宽度参与布局，
	// 否则排列时会以为节点很窄，最终互相覆盖。
	return Math.round(Math.min(MAX_LAYOUT_NODE_WIDTH, estimated));
}


function getVisualNodeWidth(node) {
	if (isRerouteNode(node)) return Math.max(MIN_REROUTE_WIDTH, getStoredNodeWidth(node));

	const storedWidth = getStoredNodeWidth(node);
	const titleWidth = measureTextWidthForLayout(getNodeTitleForLayout(node));
	const slotWidth = getLongestSlotTextWidth(node);
	const widgetWidth = Math.max(0, Number(node?.widgets?.length || 0) > 0 ? 24 : 0);

	return Math.round(Math.min(MAX_LAYOUT_NODE_WIDTH, Math.max(
		MIN_LAYOUT_NODE_WIDTH,
		storedWidth,
		titleWidth + 72,
		slotWidth + 112,
		storedWidth + widgetWidth
	)));
}

function getNodeHeight(node) {
	return Number(node?.size?.[1] || node?.size?.height || 120);
}

function readPositionNumber(source, index, key) {
	if (!source || typeof source !== "object") return null;
	const indexed = Number(source[index]);
	if (Number.isFinite(indexed)) return indexed;
	const keyed = Number(source[key]);
	if (Number.isFinite(keyed)) return keyed;
	return null;
}

function readNodePositionNumber(node, index, key) {
	const sources = [
		node?.pos,
		node?.position,
		node?._pos,
		node?.layout?.position,
		node?._layout?.position,
		node?.comfyLayout?.position,
	];

	for (const source of sources) {
		const value = readPositionNumber(source, index, key);
		if (value != null) return value;
	}

	return 0;
}

function getNodeX(node) {
	return readNodePositionNumber(node, 0, "x");
}

function getNodeY(node) {
	return readNodePositionNumber(node, 1, "y");
}

function isPriorityArrangeNode(node) {
	return getPriorityArrangeRank(node) < PRIORITY_ARRANGE_NODE_TYPES.length;
}

function getPriorityRankFromText(value) {
	const text = String(value || "").trim();
	if (!text) return PRIORITY_ARRANGE_NODE_TYPES.length;
	if (PRIORITY_ARRANGE_NODE_TYPE_SET.has(text)) {
		return PRIORITY_ARRANGE_NODE_RANKS.get(text) ?? PRIORITY_ARRANGE_NODE_TYPES.length;
	}
	for (let index = 0; index < PRIORITY_ARRANGE_NODE_TYPES.length; index++) {
		if (text.includes(PRIORITY_ARRANGE_NODE_TYPES[index])) {
			return index;
		}
		const pattern = PRIORITY_ARRANGE_NODE_PATTERNS[index];
		if (pattern?.test(text)) {
			return index;
		}
	}
	return PRIORITY_ARRANGE_NODE_TYPES.length;
}

function getPriorityArrangeRank(node) {
	const values = [
		node?.type,
		node?.comfyClass,
		node?.properties?.["Node name for S&R"],
		node?.properties?.aux_id,
		node?.nodeData?.name,
		node?.constructor?.nodeData?.name,
		node?.constructor?.comfyClass,
		node?.constructor?.type,
		node?.constructor?.title,
		node?.title,
		node?.name,
	].filter((value) => value != null && value !== "").map((value) => String(value).trim());

	let rank = PRIORITY_ARRANGE_NODE_TYPES.length;
	for (const value of values) {
		rank = Math.min(rank, getPriorityRankFromText(value));
	}
	return rank;
}

function compareNodeArrangePriority(a, b) {
	return getPriorityArrangeRank(a) - getPriorityArrangeRank(b);
}

function compareNodePositionOnly(a, b, primary = "y", threshold = 8) {
	const ax = getNodeX(a);
	const bx = getNodeX(b);
	const ay = getNodeY(a);
	const by = getNodeY(b);

	if (primary === "x") {
		if (Math.abs(ax - bx) > threshold) return ax - bx;
		if (Math.abs(ay - by) > threshold) return ay - by;
	} else {
		if (Math.abs(ay - by) > threshold) return ay - by;
		if (Math.abs(ax - bx) > threshold) return ax - bx;
	}

	return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function compareNodesForArrange(a, b, primary = "y", threshold = 8) {
	return compareNodeArrangePriority(a, b) || compareNodePositionOnly(a, b, primary, threshold);
}

function forcePriorityNodesToLeadingLevel(levels, normalNodes, leading = "min") {
	const priorityNodes = filterValidNodes(normalNodes, false).filter(isPriorityArrangeNode);
	if (!priorityNodes.length || !levels?.size) return levels;

	const values = Array.from(levels.values())
		.map((value) => Number(value))
		.filter((value) => Number.isFinite(value));
	if (!values.length) return levels;

	const minLevel = Math.min(...values);
	const maxLevel = Math.max(...values);
	const leadingLevel = leading === "max" ? maxLevel + 1 : minLevel - 1;

	for (const node of priorityNodes) {
		levels.set(node, leadingLevel);
	}
	return levels;
}

function isRerouteNode(node) {
	return !!node && REROUTE_TYPES.has(node.type);
}

function isRealNode(node) {
	return !!node && node.type !== "group";
}

function roundNodePosition(node) {
	if (!node) return;
	setNodePosition(node, getNodeX(node), getNodeY(node));
}

function assignIndexedPosition(target, x, y) {
	if (!target || typeof target !== "object") return false;
	if (typeof target.set === "function") {
		try {
			if (target.set.length >= 2) {
				target.set(x, y);
			} else {
				target.set([x, y]);
			}
			return true;
		} catch (_) {
			try {
				if (target.set.length >= 2) {
					target.set([x, y]);
				} else {
					target.set(x, y);
				}
				return true;
			} catch (_) {}
		}
	}

	if (0 in target || 1 in target || Array.isArray(target)) {
		try {
			target[0] = x;
			target[1] = y;
			return Number(target[0]) === x && Number(target[1]) === y;
		} catch (_) {
			return false;
		}
	}

	if ("x" in target || "y" in target) {
		try {
			target.x = x;
			target.y = y;
			return Number(target.x) === x && Number(target.y) === y;
		} catch (_) {
			return false;
		}
	}

	return false;
}

function assignPrimaryNodePosition(node, x, y) {
	if (!node) return false;
	const oldPos = node.pos;
	try {
		node.pos = [x, y];
		if (Number(node.pos?.[0]) === x && Number(node.pos?.[1]) === y) {
			return true;
		}
	} catch (_) {}

	return assignIndexedPosition(oldPos, x, y) || assignIndexedPosition(node.pos, x, y);
}

function setNodePosition(node, x, y) {
	if (!node) return;
	const nextX = Math.round(Number(x) || 0);
	const nextY = Math.round(Number(y) || 0);
	assignPrimaryNodePosition(node, nextX, nextY);
	assignIndexedPosition(node.position, nextX, nextY);
	assignIndexedPosition(node._pos, nextX, nextY);
	assignIndexedPosition(node.layout?.position, nextX, nextY);
	assignIndexedPosition(node._layout?.position, nextX, nextY);
	assignIndexedPosition(node.comfyLayout?.position, nextX, nextY);
	if (typeof node.setPosition === "function") {
		try {
			if (node.setPosition.length >= 2) {
				node.setPosition(nextX, nextY);
			} else {
				node.setPosition([nextX, nextY]);
			}
		} catch (_) {
			try {
				if (node.setPosition.length >= 2) {
					node.setPosition([nextX, nextY]);
				} else {
					node.setPosition(nextX, nextY);
				}
			} catch (_) {}
		}
	}
	assignPrimaryNodePosition(node, nextX, nextY);
	assignIndexedPosition(node.position, nextX, nextY);
	assignIndexedPosition(node._pos, nextX, nextY);
	assignIndexedPosition(node.layout?.position, nextX, nextY);
	assignIndexedPosition(node._layout?.position, nextX, nextY);
	assignIndexedPosition(node.comfyLayout?.position, nextX, nextY);
}

function markArrangeCanvasDirty(node = null) {
	try { node?.setDirtyCanvas?.(true, true); } catch (_) {}
	try { node?.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
	try { app.canvas?.setDirty?.(true, true); } catch (_) {}
	try { app.canvas && (app.canvas.dirty_canvas = true); } catch (_) {}
	try { app.canvas && (app.canvas.dirty_bgcanvas = true); } catch (_) {}
}

function flushArrangeCanvasDraw() {
	markArrangeCanvasDirty();
	try { app.graph?.afterChange?.(); } catch (_) {}
	try { app.graph?.change?.(); } catch (_) {}
	try { app.canvas?.draw?.(true, true); } catch (_) {}
}

function getLinkByIdForGeometry(linkId) {
	if (linkId == null) return null;
	const links = app?.graph?.links || app?.graph?._links;
	if (links instanceof Map) return links.get(linkId) || links.get(String(linkId)) || null;
	return links?.[linkId] || links?.[String(linkId)] || null;
}

function clearLinkGeometryCache(link) {
	if (!link || typeof link !== "object") return;
	for (const key of [
		"_pos",
		"_path",
		"_points",
		"_last_origin_pos",
		"_last_target_pos",
		"_last_origin_slot",
		"_last_target_slot",
		"_last_origin_id",
		"_last_target_id",
		"_last_time",
		"_lastNodePos",
		"_lastNodeSize",
		"_lastLayout",
	]) {
		try { delete link[key]; } catch (_) {}
	}
}

function clearSlotGeometryCache(slot) {
	if (!slot || typeof slot !== "object") return;
	for (const key of [
		"_pos",
		"_last_pos",
		"_last_node_pos",
		"_last_node_size",
		"_lastLayout",
		"_last_y",
		"_lastY",
	]) {
		try { delete slot[key]; } catch (_) {}
	}
}

function alignLinkEndpoint(link, side, nodeId, slotIndex) {
	if (!link) return;
	if (Array.isArray(link)) {
		if (side === "origin") {
			link[1] = nodeId;
			link[2] = slotIndex;
		} else {
			link[3] = nodeId;
			link[4] = slotIndex;
		}
		return;
	}

	if (side === "origin") {
		link.origin_id = nodeId;
		link.origin_slot = slotIndex;
		link.from_id = nodeId;
		link.from_slot = slotIndex;
	} else {
		link.target_id = nodeId;
		link.target_slot = slotIndex;
		link.to_id = nodeId;
		link.to_slot = slotIndex;
	}
}

function repairGraphLinkSlotAlignment() {
	const nodes = filterValidNodes(getAllGraphNodes(), false);
	for (const node of nodes) {
		for (let slotIndex = 0; slotIndex < safeArray(node.inputs).length; slotIndex++) {
			const linkId = node.inputs[slotIndex]?.link;
			if (linkId == null) continue;
			alignLinkEndpoint(getLinkByIdForGeometry(linkId), "target", node.id, slotIndex);
		}
		for (let slotIndex = 0; slotIndex < safeArray(node.outputs).length; slotIndex++) {
			for (const linkId of safeArray(node.outputs[slotIndex]?.links)) {
				alignLinkEndpoint(getLinkByIdForGeometry(linkId), "origin", node.id, slotIndex);
			}
		}
	}
	return nodes;
}

function resetNodeLinkGeometry(node) {
	if (!node) return;
	for (const input of safeArray(node?.inputs)) clearSlotGeometryCache(input);
	for (const output of safeArray(node?.outputs)) clearSlotGeometryCache(output);
	for (const linkId of [
		...safeArray(node?.inputs).map((input) => input?.link),
		...safeArray(node?.outputs).flatMap((output) => safeArray(output?.links)),
	]) {
		clearLinkGeometryCache(getLinkByIdForGeometry(linkId));
	}
	markArrangeCanvasDirty(node);
}

function uniqueNodes(nodes = []) {
	const result = [];
	const seen = new Set();
	for (const node of safeArray(nodes)) {
		if (!isRealNode(node) || seen.has(node)) continue;
		seen.add(node);
		result.push(node);
	}
	return result;
}

function runRegisteredLayoutStabilizers(nodes = [], phase = "sync") {
	const targetNodes = uniqueNodes(nodes.length ? nodes : getAllGraphNodes());
	const registry = safeArray(globalThis.GJJ_NodeArrangerLayoutStabilizers);
	if (!registry.length || !targetNodes.length) return [];

	const touched = [];
	for (const node of targetNodes) {
		for (const stabilizer of registry) {
			try {
				const matches = typeof stabilizer?.matches === "function"
					? stabilizer.matches(node)
					: false;
				if (!matches || typeof stabilizer?.stabilize !== "function") continue;
				stabilizer.stabilize(node, { phase, source: "GJJ_NodeArranger" });
				touched.push(node);
			} catch (error) {
				console.warn("[GJJ_NodeArranger] layout stabilizer failed:", stabilizer?.id || "unknown", error);
			}
		}
	}
	return uniqueNodes(touched);
}

function commitArrangedNodePositions(nodes = []) {
	const targetNodes = uniqueNodes(nodes.length ? nodes : getAllGraphNodes());
	for (const node of targetNodes) {
		roundNodePosition(node);
		markArrangeCanvasDirty(node);
	}
	flushArrangeCanvasDraw();
	return targetNodes;
}

function rebuildLinkGeometryAfterPositionCommit(nodes = [], phase = "raf") {
	const stabilizedNodes = runRegisteredLayoutStabilizers(nodes, phase);
	const baseNodes = uniqueNodes([...safeArray(nodes), ...stabilizedNodes]);
	for (const node of baseNodes) applyGridPosterSizeLock(node);
	commitArrangedNodePositions(baseNodes);
	for (const node of baseNodes) refreshNodeLayoutForConnections(node);
	for (const node of baseNodes) applyGridPosterSizeLock(node);
	commitArrangedNodePositions(baseNodes);
	const graphNodes = repairGraphLinkSlotAlignment();
	const refreshNodes = uniqueNodes([
		...(graphNodes.length ? graphNodes : baseNodes),
		...baseNodes,
	]);
	for (const node of refreshNodes) resetNodeLinkGeometry(node);
	flushArrangeCanvasDraw();
	return refreshNodes;
}

let __gjjGridPosterFinalizeContext = null;

function setGridPosterFinalizeContext(title, belowNodes, titleGap) {
	__gjjGridPosterFinalizeContext = {
		title: isRealNode(title) ? title : null,
		belowNodes: uniqueNodes(belowNodes),
		titleGap: Math.max(0, Math.round(Number(titleGap) || 0)),
		titleY: isRealNode(title) ? Math.round(getNodeY(title)) : 0,
	};
}

function clearGridPosterFinalizeContext() {
	__gjjGridPosterFinalizeContext = null;
}

function repairFinalLinkGeometry(nodes = []) {
	const targetNodes = uniqueNodes(nodes.length ? nodes : getAllGraphNodes());
	for (const node of targetNodes) applyGridPosterSizeLock(node);
	commitArrangedNodePositions(targetNodes);
	const graphNodes = repairGraphLinkSlotAlignment();
	const refreshNodes = uniqueNodes([
		...(graphNodes.length ? graphNodes : targetNodes),
		...targetNodes,
	]);
	for (const node of refreshNodes) resetNodeLinkGeometry(node);
	flushArrangeCanvasDraw();
	return refreshNodes;
}

function finalizeGridPosterTitleAndLinks(nodes = []) {
	const context = __gjjGridPosterFinalizeContext;
	const seedNodes = uniqueNodes(nodes.length ? nodes : getAllGraphNodes());
	if (!context) return repairFinalLinkGeometry(seedNodes);

	const belowNodes = uniqueNodes(context.belowNodes);
	for (const node of belowNodes) applyGridPosterSizeLock(node);
	let belowBounds = getBoundsForNodes(belowNodes, 0);
	const title = context.title;

	if (title && belowBounds) {
		const titleWidth = Math.max(1, Math.round(belowBounds.width));
		let titleHeight = Math.max(24, Math.round(getNodeHeight(title)));
		if (Math.abs(getNodeWidth(title) - titleWidth) >= 0.5) {
			const currentTitleWidth = Math.max(1, getNodeWidth(title));
			const titleAspect = clampLayoutValue((titleHeight / currentTitleWidth) * 1000, 120, 380) / 1000;
			const estimatedTitleHeight = Math.max(120, Math.round(titleWidth * titleAspect));
			titleHeight = syncGridPosterWorkflowTitleSize(title, titleWidth, estimatedTitleHeight);
		}

		setNodePosition(title, belowBounds.x, context.titleY);
		belowBounds = getBoundsForNodes(belowNodes, 0);
		const targetBelowY = Math.round(context.titleY + titleHeight + context.titleGap);
		if (belowBounds) {
			moveNodesBy(belowNodes, 0, targetBelowY - Math.round(belowBounds.y));
		}
	}

	return repairFinalLinkGeometry([...seedNodes, title, ...belowNodes]);
}

let __gjjArrangeLinkRepairToken = 0;

function scheduleLinkGeometryRebuildAfterPositionCommit(nodes = []) {
	const seedNodes = uniqueNodes(nodes.length ? nodes : getAllGraphNodes());
	const token = ++__gjjArrangeLinkRepairToken;
	const scheduleFrame = (callback) => {
		if (typeof globalThis.requestAnimationFrame === "function") {
			return globalThis.requestAnimationFrame(callback);
		}
		return setTimeout(callback, 0);
	};

	setTimeout(() => {
		scheduleFrame(() => {
			if (token !== __gjjArrangeLinkRepairToken) return;
			const raf1Nodes = rebuildLinkGeometryAfterPositionCommit(seedNodes, "raf1");
			scheduleFrame(() => {
				if (token !== __gjjArrangeLinkRepairToken) return;
				const raf2Nodes = rebuildLinkGeometryAfterPositionCommit(raf1Nodes, "raf2");
				setTimeout(() => {
					if (token !== __gjjArrangeLinkRepairToken) return;
					const settledNodes = rebuildLinkGeometryAfterPositionCommit(raf2Nodes, "settled");
					scheduleFrame(() => {
						if (token !== __gjjArrangeLinkRepairToken) return;
						const finalFrameNodes = finalizeGridPosterTitleAndLinks(settledNodes);
						scheduleFrame(() => {
							if (token !== __gjjArrangeLinkRepairToken) return;
							const finalNodes = finalizeGridPosterTitleAndLinks(finalFrameNodes);
							clearGridPosterSizeLocks(finalNodes);
							clearGridPosterFinalizeContext();
						});
					});
				}, 120);
			});
		});
	}, 0);
}

function currentNodeSizePair(node) {
	const width = Math.max(1, Math.round(Number(node?.size?.[0] || node?.size?.width || getStoredNodeWidth(node) || 240)));
	const height = Math.max(1, Math.round(Number(node?.size?.[1] || node?.size?.height || getNodeHeight(node) || 120)));
	return [width, height];
}

function assignNodeSizePair(node, size) {
	if (!node) return;
	const width = Math.max(1, Math.round(Number(size?.[0] || 1)));
	const height = Math.max(1, Math.round(Number(size?.[1] || 1)));
	if (Array.isArray(node.size)) {
		node.size[0] = width;
		node.size[1] = height;
	} else if (node.size && typeof node.size === "object") {
		node.size[0] = width;
		node.size[1] = height;
		node.size.width = width;
		node.size.height = height;
	} else {
		node.size = [width, height];
	}
}

function refreshNodeLayoutForConnections(node) {
	if (!isRealNode(node)) return;
	const finalSize = currentNodeSizePair(node);
	const lockedWidth = Number(node.__gjjNodeArrangerGridHeroWidth);
	if (Number.isFinite(lockedWidth) && lockedWidth > 0) {
		finalSize[0] = Math.round(lockedWidth);
	}
	const oldFlag = node.__gjjNodeArrangerRefreshingLayout;
	node.__gjjNodeArrangerRefreshingLayout = true;

	try {
		// Some nodes mutate the output array passed to computeSize(). Keep the
		// committed arrangement size immutable while refreshing widget geometry.
		try { node.computeSize?.([...finalSize]); } catch (_) {}
		try { node.onResize?.(finalSize); } catch (_) {}

		if (typeof node.setSize === "function") {
			try { node.setSize(finalSize); } catch (_) {}
		} else {
			assignNodeSizePair(node, finalSize);
			try { node.onResize?.(finalSize); } catch (_) {}
		}

		assignNodeSizePair(node, finalSize);
		try { node.onResize?.(finalSize); } catch (_) {}
	} finally {
		if (oldFlag === undefined) {
			try { delete node.__gjjNodeArrangerRefreshingLayout; } catch (_) {}
		} else {
			node.__gjjNodeArrangerRefreshingLayout = oldFlag;
		}
	}
}

function applyManualResizeStep(node, width, height) {
	if (!node) return;
	const size = [Math.max(1, Math.round(width)), Math.max(1, Math.round(height))];
	if (typeof node.setSize === "function") {
		node.setSize(size);
	} else if (Array.isArray(node.size)) {
		node.size[0] = size[0];
		node.size[1] = size[1];
	} else {
		node.size = size;
	}
	try { node.onResize?.(size); } catch (_) {}
	resetNodeLinkGeometry(node);
}

function setNodeSize(node, width, height = null) {
	if (!node) return;
	const w = Math.max(1, Math.round(Number(width || 1)));
	const currentH = getNodeHeight(node);
	const h = Math.max(1, Math.round(Number(height == null ? currentH : height)));
	const oldW = Math.round(Number(node?.size?.[0] || node?.size?.width || 0));
	const oldH = Math.round(Number(node?.size?.[1] || node?.size?.height || 0));

	if (oldW === w && oldH === h) return;

	applyManualResizeStep(node, w, h);
}

function isNodeCollapsed(node) {
	return !!node?.flags?.collapsed;
}

function collapseNode(node) {
	if (!isRealNode(node)) return;
	if (!isNodeCollapsed(node)) {
		node.__gjjNodeArrangerExpandedWidth = Math.max(1, Math.round(getStoredNodeWidth(node)));
		node.__gjjNodeArrangerExpandedHeight = Math.max(COLLAPSED_NODE_HEIGHT, Math.round(getNodeHeight(node)));
	}
	node.flags = node.flags || {};
	node.flags.collapsed = true;
	// 只有“折叠”动作才缩小真实尺寸。普通排列不再动真实宽度。
	const width = isRerouteNode(node) ? MIN_REROUTE_WIDTH : COLLAPSED_NODE_WIDTH;
	setNodeSize(node, width, COLLAPSED_NODE_HEIGHT);
}

function expandNode(node) {
	if (!isRealNode(node)) return;
	node.flags = node.flags || {};
	node.flags.collapsed = false;
	const width = Math.max(1, Math.round(Number(node.__gjjNodeArrangerExpandedWidth || getStoredNodeWidth(node) || 240)));
	const height = Math.max(80, Math.round(Number(node.__gjjNodeArrangerExpandedHeight || getNodeHeight(node) || 120)));
	setNodeSize(node, width, height);
}

function setAllNodesCollapsed(collapsed = true, selectedOnly = false) {
	const validNodes = getGraphNodesForArrange(selectedOnly);
	if (validNodes.length === 0) return [];

	for (const node of validNodes) {
		if (collapsed) {
			collapseNode(node);
		} else {
			expandNode(node);
		}
	}

	refreshAfterArrange(validNodes);
	fitView(validNodes);
	return validNodes;
}

function toggleAllNodesCollapsed(selectedOnly = false) {
	const validNodes = getGraphNodesForArrange(selectedOnly);
	if (validNodes.length === 0) return [];

	const shouldExpand = validNodes.every((node) => isNodeCollapsed(node));
	for (const node of validNodes) {
		if (shouldExpand) {
			expandNode(node);
		} else {
			collapseNode(node);
		}
	}

	refreshAfterArrange(validNodes);
	fitView(validNodes);
	console.log(`[GJJ_NodeArranger] ${shouldExpand ? "全部打开" : "全部折叠"}`);
	return validNodes;
}

function filterValidNodes(nodes, selectedOnly = false) {
	return safeArray(nodes).filter((node) => {
		if (!isRealNode(node)) return false;
		if (selectedOnly && !isNodeSelectedForScope(node)) return false;
		return true;
	});
}

function showMessage(message) {
	try {
		if (app?.ui?.dialog?.show) {
			app.ui.dialog.show(message);
		} else {
			console.log(`[GJJ_NodeArranger] ${message}`);
		}
	} catch {
		console.log(`[GJJ_NodeArranger] ${message}`);
	}
}

function refreshAfterArrange(nodes = []) {
	const arrangedNodes = filterValidNodes(nodes, false);
	const stabilizedNodes = runRegisteredLayoutStabilizers(arrangedNodes, "sync");
	const committedNodes = commitArrangedNodePositions([
		...arrangedNodes,
		...stabilizedNodes,
	]);

	try {
		scheduleLinkGeometryRebuildAfterPositionCommit(committedNodes);
	} catch (error) {
		console.warn("[GJJ_NodeArranger] refresh failed:", error);
	}
}

async function executeComfyCommand(commandId) {
	const candidates = [
		app?.extensionManager?.command,
		app?.extensionManager?.commands,
		app?.commands,
		app?.commandRegistry,
		app?.ui?.commands,
		window?.app?.extensionManager?.command,
		window?.app?.extensionManager?.commands,
		window?.app?.commands,
		window?.app?.commandRegistry,
	];

	for (const registry of candidates) {
		if (!registry) continue;

		try {
			if (typeof registry.execute === "function") {
				await registry.execute(commandId);
				return true;
			}

			if (typeof registry.run === "function") {
				await registry.run(commandId);
				return true;
			}

			if (typeof registry.invoke === "function") {
				await registry.invoke(commandId);
				return true;
			}

			const command = registry[commandId] || registry.commands?.[commandId] || registry.commandMap?.[commandId];
			if (typeof command === "function") {
				await command();
				return true;
			}

			if (command && typeof command.execute === "function") {
				await command.execute();
				return true;
			}
		} catch (error) {
			if (isComfyCommandMissingError(error)) {
				continue;
			}
			console.warn(`[GJJ_NodeArranger] command ${commandId} failed:`, error);
		}
	}

	return false;
}

function isComfyCommandMissingError(error) {
	const text = String(error?.message || error || "");
	return /command\s+.+\s+not\s+found/i.test(text) || /not\s+found/i.test(text);
}

function dispatchFitViewKey(target) {
	if (!target?.dispatchEvent) return false;

	const base = {
		key: ".",
		code: "Period",
		keyCode: 190,
		which: 190,
		bubbles: true,
		cancelable: true,
		composed: true,
	};

	try {
		target.dispatchEvent(new KeyboardEvent("keydown", base));
		target.dispatchEvent(new KeyboardEvent("keypress", base));
		target.dispatchEvent(new KeyboardEvent("keyup", base));
		return true;
	} catch (error) {
		console.warn("[GJJ_NodeArranger] dispatch fit view shortcut failed:", error);
		return false;
	}
}

function pressFitViewShortcut() {
	const canvasEl = app?.canvas?.canvas || app?.canvas?.canvasEl || app?.canvas?.canvas_element;
	const targets = [
		canvasEl,
		document.activeElement,
		document.body,
		document,
		window,
	].filter(Boolean);

	let ok = false;
	for (const target of targets) {
		ok = dispatchFitViewKey(target) || ok;
	}
	return ok;
}

function runDirectCanvasFit() {
	try {
		const canvas = app?.canvas;
		if (!canvas) return false;

		if (typeof canvas.fitView === "function") {
			canvas.fitView();
			return true;
		}

		if (typeof canvas.fitViewToSelection === "function") {
			canvas.fitViewToSelection();
			return true;
		}

		if (typeof canvas.centerOnNode === "function") {
			const nodes = getAllGraphNodes();
			if (nodes.length) {
				canvas.centerOnNode(nodes[0]);
				return true;
			}
		}
	} catch (error) {
		console.warn("[GJJ_NodeArranger] direct canvas fit failed:", error);
	}

	return false;
}

let __gjjFitViewTimer = null;
let __gjjFitViewRunning = false;
let __gjjFitViewCommandAvailable = true;

function cancelPendingFitView() {
	clearTimeout(__gjjFitViewTimer);
	__gjjFitViewTimer = null;
}

function fitView(nodes = null) {
	try {
		const targetNodes = filterValidNodes(nodes || getAllGraphNodes(), false);
		refreshAfterArrange(targetNodes);

		// 以前连续 50/180/360ms 多次执行会造成视图来回抖动。
		// 这里改成“防抖 + 等画布稳定后只执行一次”。
		cancelPendingFitView();

		__gjjFitViewTimer = setTimeout(() => {
			requestAnimationFrame(() => {
				requestAnimationFrame(async () => {
					if (__gjjFitViewRunning) return;
					__gjjFitViewRunning = true;

					try {
						let ok = false;

						// 优先使用 ComfyUI 自带命令：适应视图到选中节点
						if (__gjjFitViewCommandAvailable) {
							try {
								ok = await executeComfyCommand("Comfy_Canvas_FitView");
								if (!ok) {
									__gjjFitViewCommandAvailable = false;
								}
							} catch (error) {
								if (isComfyCommandMissingError(error)) {
									__gjjFitViewCommandAvailable = false;
								} else {
									console.warn("[GJJ_NodeArranger] Comfy_Canvas_FitView failed:", error);
								}
							}
						}

						// 命令入口不可用时，再走直接 canvas 方法。
						if (!ok) {
							ok = runDirectCanvasFit();
						}

						// 最后兜底只模拟一次系统快捷键「.」，避免多次触发抖动。
						if (!ok) {
							pressFitViewShortcut();
						}

						app?.graph?.setDirtyCanvas?.(true, true);
						app?.canvas?.setDirty?.(true, true);
					} finally {
						__gjjFitViewRunning = false;
					}
				});
			});
		}, 180);
	} catch (error) {
		console.warn("[GJJ_NodeArranger] fit view failed:", error);
		cancelPendingFitView();
		__gjjFitViewTimer = setTimeout(() => pressFitViewShortcut(), 180);
	}
}

function getAllGraphNodes() {
	return safeArray(app?.graph?._nodes);
}

function getLinkById(linkId) {
	if (!app?.graph?.links) return null;
	return app.graph.links[linkId] || null;
}

function getLinkFlag(link, key) {
	if (!link || !key) return undefined;
	if (Array.isArray(link)) return undefined;
	return link[key] ?? link.flags?.[key] ?? link.properties?.[key] ?? link.data?.[key];
}

function isBroadcastArrangeLink(link) {
	if (!link) return false;
	return Boolean(
		getLinkFlag(link, "gjj_broadcast")
		|| getLinkFlag(link, "__gjjBroadcast")
		|| getLinkFlag(link, "is_broadcast")
		|| getLinkFlag(link, "isBroadcast")
		|| getLinkFlag(link, "broadcast")
		|| getLinkFlag(link, "virtual")
		|| getLinkFlag(link, "is_virtual")
		|| getLinkFlag(link, "isVirtual")
		|| getLinkFlag(link, BROADCAST_PROPERTY)
	);
}

function isExternalArrangeLink(link) {
	return Boolean(link) && !isBroadcastArrangeLink(link);
}

function hasExternalInputLink(input) {
	if (input?.link == null) return false;
	return isExternalArrangeLink(getLinkById(input.link));
}

function externalOutputLinkIds(output) {
	return safeArray(output?.links).filter((linkId) => isExternalArrangeLink(getLinkById(linkId)));
}

function getNodeById(id) {
	try {
		return app.graph?.getNodeById?.(id) || null;
	} catch {
		return null;
	}
}

function getGraphNodesForArrange(selectedOnly = false) {
	const graph = app.graph;
	if (!graph || !graph._nodes) {
		console.warn("[GJJ_NodeArranger] No graph found");
		return [];
	}

	const validNodes = filterValidNodes(graph._nodes, selectedOnly);

	return validNodes;
}

function getGlobalLocation(node) {
	if (node?.parent) {
		const parentLoc = getGlobalLocation(node.parent);
		return {
			x: parentLoc.x + getNodeX(node),
			y: parentLoc.y + getNodeY(node),
		};
	}

	return {
		x: getNodeX(node),
		y: getNodeY(node),
	};
}

function getSocketPosition(socket, sockets, totalSize) {
	const connectedSockets = safeArray(sockets).filter((s) => {
		return !!s?.link || (Array.isArray(s?.links) && s.links.length > 0);
	});

	const index = connectedSockets.indexOf(socket);
	if (index < 0 || connectedSockets.length === 0) return totalSize / 2;

	return (index / Math.max(1, connectedSockets.length - 1)) * totalSize;
}

function handleCollision(loc0, loc1, size0, size1, offset, power, dist, onlyY = false) {
	const pos0 = {
		x: loc0.x + size0.width / 2,
		y: loc0.y + size0.height / 2,
	};

	const pos1 = {
		x: loc1.x + size1.width / 2,
		y: loc1.y + size1.height / 2,
	};

	const size = {
		width: (size0.width + size1.width) / 2 + dist,
		height: (size0.height + size1.height) / 2 + dist,
	};

	const delta = {
		x: pos1.x - pos0.x,
		y: pos1.y - pos0.y,
	};

	const inters = {
		x: size.width - Math.abs(delta.x),
		y: size.height - Math.abs(delta.y),
	};

	if (inters.x > 0 && inters.y > 0) {
		if (onlyY || inters.y < inters.x) {
			offset.y += (delta.y > 0 ? -inters.y : inters.y) * 0.5 * power;
		} else {
			offset.x += (delta.x > 0 ? -inters.x : inters.x) * 0.5 * power;
		}
	}
}

function calculateRelaxPosition(node, nodes, relaxPower, distance, clampedPull = true) {
	if (!isRealNode(node) || isRerouteNode(node)) return false;

	const loc = getGlobalLocation(node);
	const width = getNodeWidth(node);
	const height = getNodeHeight(node);

	let targetY = 0;
	let targetXIn = clampedPull ? loc.x : 0;
	let targetXOut = clampedPull ? loc.x : 0;
	let linkCount = 0;
	let hasInput = false;
	let hasOutput = false;

	for (const input of safeArray(node.inputs)) {
		if (!hasExternalInputLink(input)) continue;

		const link = getLinkById(input.link);

		const otherNode = getNodeById(link.origin_id);
		if (!otherNode) continue;

		const otherLoc = getGlobalLocation(otherNode);
		const otherWidth = getNodeWidth(otherNode);
		const otherHeight = getNodeHeight(otherNode);

		const x = otherLoc.x + otherWidth + distance;

		if (clampedPull) {
			targetXIn = hasInput ? Math.max(targetXIn, x) : x;
		} else {
			targetXIn += x;
		}

		targetY += otherLoc.y +
			getSocketPosition(input, node.inputs, height) -
			getSocketPosition(safeArray(otherNode.outputs)[link.from_slot], otherNode.outputs, otherHeight);

		hasInput = true;
		linkCount++;
	}

	for (let i = 0; i < safeArray(node.outputs).length; i++) {
		const output = node.outputs[i];
		const linkIds = externalOutputLinkIds(output);
		if (linkIds.length === 0) continue;

		for (const linkId of linkIds) {
			const link = getLinkById(linkId);

			const otherNode = getNodeById(link.target_id);
			if (!otherNode) continue;

			const otherLoc = getGlobalLocation(otherNode);
			const otherHeight = getNodeHeight(otherNode);

			const x = otherLoc.x - width - distance;

			if (clampedPull) {
				targetXOut = hasOutput ? Math.min(targetXOut, x) : x;
			} else {
				targetXOut += x;
			}

			targetY += otherLoc.y +
				getSocketPosition(output, node.outputs, height) -
				getSocketPosition(safeArray(otherNode.inputs)[link.target_slot], otherNode.inputs, otherHeight);

			hasOutput = true;
			linkCount++;
		}
	}

	if (linkCount <= 0) return false;

	let targetX;

	if (clampedPull) {
		const count = (hasInput ? 1 : 0) + (hasOutput ? 1 : 0);
		targetX = count > 0 ? (
			(targetXIn * (hasInput ? 1 : 0) + targetXOut * (hasOutput ? 1 : 0)) / count
		) : loc.x;
	} else {
		targetX = (targetXIn + targetXOut) / linkCount;
	}

	targetY /= linkCount;

	const offsetX = (targetX - loc.x) * relaxPower;
	const offsetY = (targetY - loc.y) * relaxPower;

	if (Math.abs(offsetX) > MOVE_UNIT || Math.abs(offsetY) > MOVE_UNIT) {
		setNodePosition(
			node,
			getNodeX(node) + Math.round(offsetX),
			getNodeY(node) + Math.round(offsetY)
		);
		return true;
	}

	return false;
}

function avoidCollisions(nodes, distance = 30, power = 0.5, onlyY = false) {
	let moved = false;

	for (const node of nodes) {
		if (!isRealNode(node) || isRerouteNode(node)) continue;

		const loc = getGlobalLocation(node);
		const size = {
			width: getNodeWidth(node),
			height: getNodeHeight(node),
		};
		const offset = { x: 0, y: 0 };

		for (const other of nodes) {
			if (other === node || !isRealNode(other) || isRerouteNode(other)) continue;

			const otherLoc = getGlobalLocation(other);
			const otherSize = {
				width: getNodeWidth(other),
				height: getNodeHeight(other),
			};

			handleCollision(loc, otherLoc, size, otherSize, offset, power, distance, onlyY);
		}

		if (Math.abs(offset.x) > MOVE_UNIT || Math.abs(offset.y) > MOVE_UNIT) {
			setNodePosition(
				node,
				getNodeX(node) + Math.round(offset.x),
				getNodeY(node) + Math.round(offset.y)
			);
			moved = true;
		}
	}

	return moved;
}

function arrangeHorizontal(nodes, spacing = DEFAULT_SPACING) {
	const { connectedNodes, isolatedNodes } = splitNodesByIsolation(nodes);
	let currentX = 0;
	const startY = 0;

	const sorted = [...connectedNodes].sort((a, b) => compareNodesForArrange(a, b, "x"));

	for (const node of sorted) {
		setNodePosition(node, currentX, startY);
		currentX += getNodeWidth(node) + spacing;
	}

	placeStandaloneIsolatedNodes(isolatedNodes, sorted, "row", spacing);
}

function arrangeVertical(nodes, spacing = DEFAULT_SPACING) {
	const { connectedNodes, isolatedNodes } = splitNodesByIsolation(nodes);
	const startX = 0;
	const rowGap = getRowGap(spacing);
	let currentY = 0;

	const sorted = [...connectedNodes].sort((a, b) => compareNodesForArrange(a, b, "y"));

	for (const node of sorted) {
		setNodePosition(node, startX, currentY);
		currentY += getNodeHeight(node) + rowGap;
	}

	placeStandaloneIsolatedNodes(isolatedNodes, sorted, "column", spacing);
}

function getWorkflowSortedNodesForGrid(nodes) {
	const validNodes = filterValidNodes(nodes, false);
	if (validNodes.length === 0) return [];

	const {
		normalNodes,
		rerouteNodes,
		forward,
		backward,
		inDegree,
		outDegree,
	} = buildConnectionGraph(validNodes);

	const isolatedNodes = separateIsolatedNodes(normalNodes, inDegree, outDegree);
	const connectedNodes = normalNodes.filter((node) => !isolatedNodes.includes(node));
	const ordered = [];

	if (connectedNodes.length > 0) {
		const levels = calculateSourceLongestLevels(connectedNodes, backward);
		forcePriorityNodesToLeadingLevel(levels, connectedNodes, "min");
		const layerGroups = groupByLevel(connectedNodes, levels);
		sortLayerGroups(layerGroups, levels, forward, backward, "barycenter");

		const sortedLevels = Array.from(layerGroups.keys()).sort((a, b) => a - b);
		for (const level of sortedLevels) {
			ordered.push(...(layerGroups.get(level) || []));
		}
	}

	// 没有连线的节点放在后面，仍按原来的视觉位置排序，避免突然乱跳。
	isolatedNodes.sort((a, b) => compareNodesForArrange(a, b));
	ordered.push(...isolatedNodes);

	// Reroute 节点通常只是连线辅助，网格模式放到最后，避免打乱主工作流顺序。
	rerouteNodes.sort((a, b) => compareNodesForArrange(a, b));
	ordered.push(...rerouteNodes);

	// 兜底：如果图里全是特殊节点，仍然保持原始位置顺序。
	if (ordered.length === 0) {
		return [...validNodes].sort((a, b) => compareNodesForArrange(a, b));
	}

	return ordered;
}

function getGridCompactColumnGap(spacing = DEFAULT_SPACING) {
	return Math.max(10, Math.round(getColumnGap(spacing) * 0.45));
}

function getGridCompactRowGap(spacing = DEFAULT_SPACING) {
	return Math.max(8, Math.round(getRowGap(spacing) * 0.45));
}

function getGridNodeSearchText(node) {
	return [
		getNodeTypeName(node),
		node?.type,
		node?.comfyClass,
		node?.title,
		node?.name,
		node?.properties?.["Node name for S&R"],
		node?.properties?.aux_id,
		node?.nodeData?.name,
		node?.constructor?.nodeData?.name,
		node?.constructor?.title,
	].filter(Boolean).join(" ").toLowerCase();
}

function isGridTemplateParamsNode(node) {
	const text = getGridNodeSearchText(node);
	return /gjj_templateparams|templateparams|模板参数输入器|模板参数/.test(text);
}

function isGridModelNode(node) {
	const text = getGridNodeSearchText(node);
	return /model.?bundle|model.?loader|checkpoint|unet|clip|vae|lora.?loader|lora.?chain|lorachainconfig|controlnet|ipadapter|memory.?manager|模型包|模型加载|检查点|文本编码|lora串联|lora配置|显存|内存/.test(text);
}

function isGridInputOrModelNode(node, inDegree, outDegree) {
	return isGridTemplateParamsNode(node) || isGridModelNode(node);
}

function isGridOutputNode(node, inDegree, outDegree) {
	const incoming = inDegree.get(node) || 0;
	const outgoing = outDegree.get(node) || 0;
	const text = getGridNodeSearchText(node);
	return (outgoing === 0 && incoming > 0)
		|| /preview|save|output|viewer|display|compare|collage|any.?preview|预览|保存|输出|显示|查看|对比|拼图|结果/.test(text);
}

function isGridPosterTitleNode(node) {
	return /gjj_workflowtitle|workflowtitle|工作流标题/.test(getGridNodeSearchText(node));
}

function isGridPosterAnyPreviewNode(node) {
	return /gjj_anypreview|any.?preview|任意预览/.test(getGridNodeSearchText(node));
}

function isGridPosterVideoCombineNode(node) {
	return /gjj_videocombine|video.?combine|视频合成|合成.*vhs|vhs/.test(getGridNodeSearchText(node));
}

function isGridPosterTextInputNode(node) {
	return /gjj_textinput|textinput|文本输入|备注|说明|markdown/.test(getGridNodeSearchText(node));
}

function isGridPosterHeroOutputNode(node, inDegree, outDegree) {
	if (isGridPosterTextInputNode(node)) return false;
	return isGridPosterAnyPreviewNode(node)
		|| isGridPosterVideoCombineNode(node)
		|| isGridOutputNode(node, inDegree, outDegree);
}

function isGridPosterPreferredPreviewNode(node) {
	if (!node || isGridPosterTextInputNode(node)) return false;
	return isGridPosterAnyPreviewNode(node)
		|| isGridPosterVideoCombineNode(node)
		|| /preview|viewer|display|compare|collage|预览|显示|查看|对比|拼图/.test(getGridNodeSearchText(node));
}

function hasGridRawOutgoingLink(node) {
	return safeArray(node?.outputs).some((output) => externalOutputLinkIds(output).length > 0);
}

function getArrangeLinkSourceNode(link) {
	return link?.origin_id != null ? getNodeById(link.origin_id) : null;
}

function isGridParameterInputSlot(input) {
	return Boolean(input?.widget)
		|| String(input?.type || "").startsWith("converted-widget")
		|| String(input?.widget?.type || "").startsWith("converted-widget")
		|| String(input?.widget?.name || "").trim() !== "";
}

function isGridParameterSourceNode(node) {
	return isGridTemplateParamsNode(node);
}

function hasGridRealUpstreamLink(node) {
	for (const input of safeArray(node?.inputs)) {
		if (input?.link == null) continue;
		const link = getLinkById(input.link);
		if (!isExternalArrangeLink(link)) continue;
		if (isGridParameterInputSlot(input)) continue;
		const source = getArrangeLinkSourceNode(link);
		if (isGridParameterSourceNode(source)) continue;
		return true;
	}
	return false;
}

function isGridPosterSourceOnlyNode(node) {
	return !hasGridRealUpstreamLink(node) && hasGridRawOutgoingLink(node);
}

function isGridPosterFirstColumnNode(node, inDegree, outDegree) {
	return isGridPosterSourceOnlyNode(node)
		&& !isGridTemplateParamsNode(node)
		&& !isGridPosterTitleNode(node);
}

function isGridLocalInputNode(node, inDegree) {
	return (inDegree.get(node) || 0) === 0 && !isGridTemplateParamsNode(node) && !isGridModelNode(node);
}

function compareByGridWorkflowOrder(orderIndex) {
	return (a, b) => {
		const ai = orderIndex.get(a) ?? 999999;
		const bi = orderIndex.get(b) ?? 999999;
		if (ai !== bi) return ai - bi;
		return compareNodesForArrange(a, b);
	};
}

function getClosestDownstreamOrder(node, forward, orderIndex, visited = new Set()) {
	if (!node || visited.has(node)) return null;
	visited.add(node);

	let best = null;
	for (const child of forward.get(node) || []) {
		const childOrder = orderIndex.get(child);
		if (Number.isFinite(childOrder)) {
			best = best == null ? childOrder : Math.min(best, childOrder);
		}
		const nested = getClosestDownstreamOrder(child, forward, orderIndex, new Set(visited));
		if (nested != null) {
			best = best == null ? nested : Math.min(best, nested);
		}
	}
	return best;
}

function getGridLocalityOrder(node, orderIndex, forward, inDegree) {
	const own = orderIndex.get(node) ?? 999999;
	if (isGridLocalInputNode(node, inDegree)) {
		const downstream = getClosestDownstreamOrder(node, forward, orderIndex);
		if (downstream != null) return downstream - 0.35;
	}
	return own;
}

function compareByGridLocalityOrder(orderIndex, forward, inDegree) {
	return (a, b) => {
		const ak = getGridLocalityOrder(a, orderIndex, forward, inDegree);
		const bk = getGridLocalityOrder(b, orderIndex, forward, inDegree);
		if (ak !== bk) return ak - bk;
		return compareByGridWorkflowOrder(orderIndex)(a, b);
	};
}

function compareGridTopLeftNodes(orderIndex) {
	const byWorkflow = compareByGridWorkflowOrder(orderIndex);
	return (a, b) => {
		const aTemplate = isGridTemplateParamsNode(a);
		const bTemplate = isGridTemplateParamsNode(b);
		if (aTemplate !== bTemplate) return aTemplate ? -1 : 1;
		return compareNodeArrangePriority(a, b) || byWorkflow(a, b);
	};
}

function getCompactGridColumnCount(nodeCount) {
	const count = Math.max(1, Number(nodeCount) || 1);
	return Math.max(1, Math.ceil(Math.sqrt(count)));
}

function buildCompactGridCells(inputModelNodes, middleNodes, outputNodes, cols) {
	const cells = [...inputModelNodes, ...middleNodes];
	if (!outputNodes.length) return cells;

	while (cells.length % cols !== 0) cells.push(null);

	for (let start = 0; start < outputNodes.length; start += cols) {
		const row = outputNodes.slice(start, start + cols);
		const leadingBlanks = Math.max(0, cols - row.length);
		for (let i = 0; i < leadingBlanks; i++) cells.push(null);
		cells.push(...row);
	}

	return cells;
}

function arrangeVariableGridCells(cells, cols, x, y, columnGap, rowGap) {
	const colCount = Math.max(1, Math.round(cols));
	const rowCount = Math.max(1, Math.ceil(cells.length / colCount));
	const colWidths = Array(colCount).fill(0);
	const rowHeights = Array(rowCount).fill(0);

	for (let i = 0; i < cells.length; i++) {
		const node = cells[i];
		if (!node) continue;
		const col = i % colCount;
		const row = Math.floor(i / colCount);
		colWidths[col] = Math.max(colWidths[col], Math.round(getNodeWidth(node)));
		rowHeights[row] = Math.max(rowHeights[row], Math.round(getNodeHeight(node)));
	}

	const xByCol = [];
	const yByRow = [];
	let currentX = Math.round(x);
	let currentY = Math.round(y);
	for (let col = 0; col < colCount; col++) {
		xByCol[col] = currentX;
		currentX += colWidths[col] + columnGap;
	}
	for (let row = 0; row < rowCount; row++) {
		yByRow[row] = currentY;
		currentY += rowHeights[row] + rowGap;
	}

	for (let i = 0; i < cells.length; i++) {
		const node = cells[i];
		if (!node) continue;
		const col = i % colCount;
		const row = Math.floor(i / colCount);
		setNodePosition(node, xByCol[col], yByRow[row]);
	}
}

function clampLayoutValue(value, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return min;
	return Math.max(min, Math.min(max, Math.round(n)));
}

function setGridPosterCompactWidth(node, maxWidth = 180, height = null) {
	if (!node || isRerouteNode(node) || isGridPosterTitleNode(node) || isGridPosterAnyPreviewNode(node)) return;
	node.flags = node.flags || {};
	node.flags.collapsed = false;
	const width = clampLayoutValue(Math.min(getStoredNodeWidth(node), maxWidth), 96, maxWidth);
	setNodeSize(node, width, height);
}

function syncGridPosterWorkflowTitleSize(node, width, height) {
	if (!node) return 0;
	setNodeSize(node, width, height);
	const applyConfigWidth = (raw) => {
		if (typeof raw !== "string" || !raw.trim().startsWith("{")) return raw;
		try {
			const config = JSON.parse(raw);
			config.width = Math.round(width);
			return JSON.stringify(config);
		} catch (_) {
			return raw;
		}
	};
	node.properties = node.properties || {};
	for (const key of ["config_json", "gjj_workflow_title_config"]) {
		if (node.properties[key] != null) {
			node.properties[key] = applyConfigWidth(String(node.properties[key]));
		}
	}
	if (Array.isArray(node.widgets_values) && node.widgets_values.length) {
		node.widgets_values[0] = applyConfigWidth(String(node.widgets_values[0]));
	}
	const widget = safeArray(node.widgets).find((item) => item?.name === "config_json");
	if (widget?.value != null) {
		widget.value = applyConfigWidth(String(widget.value));
	}
	if (typeof node.__gjjWorkflowTitleApplyState === "function" && node.__gjjWorkflowTitleState) {
		try {
			node.__gjjWorkflowTitleApplyState({
				...node.__gjjWorkflowTitleState,
				width: Math.round(width),
			});
		} catch (_) {
			node.__gjjWorkflowTitleSize = [Math.round(width), Math.round(height)];
		}
	} else {
		node.__gjjWorkflowTitleSize = [Math.round(width), Math.round(height)];
	}
	return Math.max(24, Math.round(getNodeHeight(node)));
}

function syncGridPosterAnyPreviewSize(node, width, height) {
	if (!node) return;
	setNodeSize(node, width, height);
	node.properties = node.properties || {};
	node.properties.gjj_any_preview_width = Math.round(width);
	node.__gjjAnyPreviewConfiguredWidth = Math.round(width);
	node.__gjjAnyPreviewUserWidth = Math.round(width);
	node.__gjjAnyPreviewHeight = Math.max(96, Math.round(height));
}

function applyGridPosterSizeLock(node) {
	if (!node) return false;
	const width = Math.round(Number(node.__gjjNodeArrangerGridHeroWidth));
	if (!Number.isFinite(width) || width <= 0) return false;
	const height = Math.max(1, Math.round(getNodeHeight(node)));

	if (isGridPosterAnyPreviewNode(node)) {
		syncGridPosterAnyPreviewSize(node, width, height);
	} else {
		if (isGridPosterVideoCombineNode(node)) {
			node.properties = node.properties || {};
			node.properties.gjj_video_combine_user_width = width;
		}
		setNodeSize(node, width, height);
	}
	return true;
}

function clearGridPosterSizeLocks(nodes = []) {
	for (const node of uniqueNodes(nodes)) {
		try { delete node.__gjjNodeArrangerGridHeroWidth; } catch (_) {}
	}
}

function arrangeGridPosterColumn(nodes, x, y, rowGap) {
	let currentY = Math.round(y);
	let maxRight = Math.round(x);
	for (const node of nodes) {
		setNodePosition(node, x, currentY);
		maxRight = Math.max(maxRight, Math.round(x + getNodeWidth(node)));
		currentY += Math.round(getNodeHeight(node)) + rowGap;
	}
	return { x: Math.round(x), y: Math.round(y), width: Math.round(maxRight - x), height: Math.round(currentY - y - rowGap), bottom: Math.round(currentY - rowGap) };
}

function arrangeGridPosterStack(nodes, x, y, width, height, columnGap, rowGap) {
	const list = filterValidNodes(nodes, false);
	if (!list.length) return { width: 0, height: 0 };
	const colGap = Math.max(0, Math.round(columnGap));
	const rGap = Math.max(0, Math.round(rowGap));
	const maxW = Math.max(96, ...list.map((node) => Math.round(getNodeWidth(node))));
	const maxCols = Math.max(1, Math.floor((Math.max(1, width) + colGap) / (maxW + colGap)));
	const cols = Math.max(1, Math.min(maxCols, Math.ceil(Math.sqrt(list.length))));

	const colWidths = Array(cols).fill(maxW);
	const colBottoms = Array(cols).fill(Math.round(y));
	const xByCol = [];
	let currentX = Math.round(x);
	for (let col = 0; col < cols; col++) {
		xByCol[col] = currentX;
		currentX += colWidths[col] + colGap;
	}

	for (const node of list) {
		let targetCol = 0;
		for (let col = 1; col < cols; col++) {
			if (colBottoms[col] < colBottoms[targetCol]) targetCol = col;
		}
		setNodePosition(node, xByCol[targetCol], colBottoms[targetCol]);
		colBottoms[targetCol] += Math.round(getNodeHeight(node)) + rGap;
	}

	const bounds = getBoundsForNodes(list, 0);
	return bounds || { width: 0, height: 0 };
}

function arrangeGridPosterRows(nodes, x, y, width, columnGap, rowGap, maxCols = 3) {
	const list = filterValidNodes(nodes, false);
	if (!list.length) return { width: 0, height: 0, bottom: Math.round(y) };
	const colGap = Math.max(0, Math.round(columnGap));
	const rGap = Math.max(0, Math.round(rowGap));
	const maxW = Math.max(96, ...list.map((node) => Math.round(getNodeWidth(node))));
	const colsByWidth = Math.max(1, Math.floor((Math.max(1, width) + colGap) / (maxW + colGap)));
	const cols = Math.max(1, Math.min(maxCols, colsByWidth, Math.ceil(Math.sqrt(list.length))));
	arrangeVariableGridCells(list, cols, x, y, colGap, rGap);
	const bounds = getBoundsForNodes(list, 0);
	return bounds || { width: 0, height: 0, bottom: Math.round(y) };
}

function arrangeGridPosterHorizontal(nodes, x, y, columnGap) {
	const list = filterValidNodes(nodes, false);
	if (!list.length) return { x: Math.round(x), y: Math.round(y), width: 0, height: 0, right: Math.round(x), bottom: Math.round(y) };
	const gap = Math.max(0, Math.round(columnGap));
	let currentX = Math.round(x);
	let maxBottom = Math.round(y);
	for (const node of list) {
		setNodePosition(node, currentX, y);
		currentX += Math.round(getNodeWidth(node)) + gap;
		maxBottom = Math.max(maxBottom, Math.round(y + getNodeHeight(node)));
	}
	return getBoundsForNodes(list, 0) || { x: Math.round(x), y: Math.round(y), width: 0, height: 0, right: currentX, bottom: maxBottom };
}

function rowWidthForGridPosterNodes(nodes, columnGap) {
	const list = filterValidNodes(nodes, false);
	if (!list.length) return 0;
	const gap = Math.max(0, Math.round(columnGap));
	return list.reduce((sum, node) => sum + Math.round(getNodeWidth(node)), 0) + Math.max(0, list.length - 1) * gap;
}

function arrangeGridPosterBalancedRows(nodes, x, y, targetWidth, columnGap, rowGap) {
	const list = filterValidNodes(nodes, false);
	if (!list.length) return { x: Math.round(x), y: Math.round(y), width: 0, height: 0, right: Math.round(x), bottom: Math.round(y) };
	if (list.length <= 2) return arrangeGridPosterHorizontal(list, x, y, columnGap);

	const singleWidth = rowWidthForGridPosterNodes(list, columnGap);
	const desiredWidth = Math.max(360, Math.round(Number(targetWidth || 0)));
	if (singleWidth <= desiredWidth * 1.18) {
		return arrangeGridPosterHorizontal(list, x, y, columnGap);
	}

	const gap = Math.max(0, Math.round(columnGap));
	let bestScore = Infinity;
	let bestTopIndexes = null;
	const maxMasks = list.length <= 14 ? (1 << list.length) : 0;
	for (let mask = 1; mask < maxMasks - 1; mask++) {
		const topIndexes = [];
		const bottomIndexes = [];
		for (let index = 0; index < list.length; index++) {
			if (mask & (1 << index)) topIndexes.push(index);
			else bottomIndexes.push(index);
		}
		const top = topIndexes.map((index) => list[index]);
		const bottom = bottomIndexes.map((index) => list[index]);
		const topWidth = rowWidthForGridPosterNodes(top, columnGap);
		const bottomWidth = rowWidthForGridPosterNodes(bottom, columnGap);
		const width = Math.max(topWidth, bottomWidth);
		const balancePenalty = Math.abs(topWidth - bottomWidth);
		const targetPenalty = Math.abs(width - desiredWidth);
		const countPenalty = Math.abs(top.length - bottom.length) * gap * 0.4;
		const score = balancePenalty + targetPenalty * 0.35 + countPenalty;
		if (score < bestScore) {
			bestScore = score;
			bestTopIndexes = topIndexes;
		}
	}
	if (!bestTopIndexes) {
		bestTopIndexes = [];
		const rowWidths = [0, 0];
		const sortedIndexes = list
			.map((node, index) => ({ index, width: Math.round(getNodeWidth(node)) }))
			.sort((a, b) => b.width - a.width || a.index - b.index);
		for (const item of sortedIndexes) {
			const row = rowWidths[0] <= rowWidths[1] ? 0 : 1;
			if (row === 0) bestTopIndexes.push(item.index);
			rowWidths[row] += item.width + (rowWidths[row] > 0 ? gap : 0);
		}
		bestTopIndexes.sort((a, b) => a - b);
	}

	const topIndexSet = new Set(bestTopIndexes);
	const top = list.filter((_, index) => topIndexSet.has(index));
	const bottom = list.filter((_, index) => !topIndexSet.has(index));
	const topBounds = arrangeGridPosterHorizontal(top, x, y, columnGap);
	const bottomY = Math.round((topBounds?.bottom || y) + Math.max(0, Math.round(rowGap)));
	arrangeGridPosterHorizontal(bottom, x, bottomY, columnGap);
	return getBoundsForNodes(list, 0) || topBounds;
}

function arrangeGridPosterVerticalMasonry(nodes, x, y, preferredColumns, columnGap, rowGap, alignBottom = false) {
	const list = filterValidNodes(nodes, false);
	if (!list.length) return { x: Math.round(x), y: Math.round(y), width: 0, height: 0, right: Math.round(x), bottom: Math.round(y) };
	const colGap = Math.max(0, Math.round(columnGap));
	const rGap = Math.max(0, Math.round(rowGap));
	const cols = Math.max(1, Math.round(preferredColumns || 1));
	const colWidths = Array(cols).fill(0);
	const nodesByCol = Array.from({ length: cols }, () => []);

	for (let i = 0; i < list.length; i++) {
		const col = i % cols;
		colWidths[col] = Math.max(colWidths[col], Math.round(getNodeWidth(list[i])));
	}

	const xByCol = [];
	let currentX = Math.round(x);
	for (let col = 0; col < cols; col++) {
		xByCol[col] = currentX;
		currentX += colWidths[col] + colGap;
	}

	const colBottoms = Array(cols).fill(Math.round(y));
	for (let i = 0; i < list.length; i++) {
		const node = list[i];
		let targetCol = 0;
		for (let col = 1; col < cols; col++) {
			if (colBottoms[col] < colBottoms[targetCol]) targetCol = col;
		}
		setNodePosition(node, xByCol[targetCol], colBottoms[targetCol]);
		nodesByCol[targetCol].push(node);
		colBottoms[targetCol] += Math.round(getNodeHeight(node)) + rGap;
	}

	if (alignBottom) {
		const actualBottoms = nodesByCol.map((colNodes, col) => colNodes.length ? colBottoms[col] - rGap : Math.round(y));
		const maxBottom = Math.max(...actualBottoms);
		for (let col = 0; col < cols; col++) {
			const delta = maxBottom - actualBottoms[col];
			if (delta <= 0 || !nodesByCol[col].length) continue;
			moveNodesBy(nodesByCol[col], 0, delta);
		}
	}

	return getBoundsForNodes(list, 0) || { x: Math.round(x), y: Math.round(y), width: 0, height: 0, right: currentX, bottom: Math.max(...colBottoms) };
}

function arrangeGridPosterHeroOutputs(heroOutputs, x, y, width, height, rowGap) {
	const list = filterValidNodes(heroOutputs, false);
	if (!list.length) return null;
	const gap = Math.max(0, Math.round(rowGap));
	const count = list.length;
	const availableH = Math.max(240, Math.round(height));
	const singleH = count === 1
		? availableH
		: Math.max(180, Math.floor((availableH - gap * (count - 1)) / count));
	let currentY = Math.round(y);
	for (const node of list) {
		node.__gjjNodeArrangerGridHeroWidth = Math.round(width);
		const nodeH = isGridPosterAnyPreviewNode(node) || isGridPosterVideoCombineNode(node)
			? singleH
			: Math.min(singleH, Math.max(120, getNodeHeight(node)));
		if (isGridPosterAnyPreviewNode(node)) {
			syncGridPosterAnyPreviewSize(node, width, nodeH);
		} else {
			setNodeSize(node, width, nodeH);
		}
		setNodePosition(node, x, currentY);
		currentY += nodeH + gap;
	}
	return getBoundsForNodes(list, 0);
}

function bottomAlignGridPosterGroups(groups) {
	const validGroups = safeArray(groups)
		.map((group) => filterValidNodes(group, false))
		.filter((group) => group.length);
	if (!validGroups.length) return;
	const bounds = validGroups
		.map((group) => ({ group, bounds: getBoundsForNodes(group, 0) }))
		.filter((item) => item.bounds);
	if (!bounds.length) return;
	const maxBottom = Math.max(...bounds.map((item) => item.bounds.bottom));
	for (const item of bounds) {
		const delta = Math.round(maxBottom - item.bounds.bottom);
		if (delta > 0) moveNodesBy(item.group, 0, delta);
	}
}

function arrangePosterGridLayout(nodes, spacing = DEFAULT_SPACING) {
	const validNodes = filterValidNodes(nodes, false);
	if (!validNodes.length) return false;
	clearGridPosterFinalizeContext();
	clearGridPosterSizeLocks(validNodes);

	const {
		normalNodes,
		rerouteNodes,
		forward,
		inDegree,
		outDegree,
	} = buildConnectionGraph(validNodes);
	const workflowOrder = getWorkflowSortedNodesForGrid(validNodes);
	const orderIndex = new Map(workflowOrder.map((node, index) => [node, index]));
	const byWorkflow = compareByGridWorkflowOrder(orderIndex);
	const byLocality = compareByGridLocalityOrder(orderIndex, forward, inDegree);
	const colGap = Math.max(32, getColumnGap(spacing));
	const rowGap = Math.max(24, getRowGap(spacing));
	const regionGap = Math.max(54, colGap * 2);
	const titleNodes = normalNodes.filter(isGridPosterTitleNode).sort(byWorkflow);
	const title = titleNodes[0] || null;

	const titleSet = new Set(titleNodes);
	const allHeroOutputs = normalNodes
		.filter((node) => !titleSet.has(node) && isGridPosterHeroOutputNode(node, inDegree, outDegree))
		.sort(byWorkflow);
	const preferredPreviewOutputs = allHeroOutputs.filter(isGridPosterPreferredPreviewNode);
	const heroCandidates = preferredPreviewOutputs.length ? preferredPreviewOutputs : allHeroOutputs;
	const heroOutputs = heroCandidates.length ? [heroCandidates[heroCandidates.length - 1]] : [];
	const heroSet = new Set(heroOutputs);
	const isolatedSet = new Set(separateIsolatedNodes(normalNodes, inDegree, outDegree));
	const leftCandidates = normalNodes
		.filter((node) => !titleSet.has(node) && !heroSet.has(node))
		.sort(byLocality);
	const firstColumnNodes = leftCandidates
		.filter((node) => isGridPosterFirstColumnNode(node, inDegree, outDegree))
		.sort(compareGridTopLeftNodes(orderIndex));
	const firstColumnSet = new Set(firstColumnNodes);
	const isolatedNodes = leftCandidates
		.filter((node) => !firstColumnSet.has(node) && (isGridTemplateParamsNode(node) || isolatedSet.has(node) || isGridPosterTextInputNode(node)))
		.sort(compareGridTopLeftNodes(orderIndex));
	const isolatedNodeSet = new Set(isolatedNodes);
	const middleNodes = leftCandidates
		.filter((node) => !isolatedNodeSet.has(node) && !firstColumnSet.has(node))
		.sort(byWorkflow);
	const arrangedReroutes = rerouteNodes.sort(byLocality);

	for (const node of firstColumnNodes) {
		setGridPosterCompactWidth(node, 210);
	}
	for (const node of middleNodes) {
		setGridPosterCompactWidth(node, 180);
	}
	for (const node of arrangedReroutes) {
		node.flags = node.flags || {};
		node.flags.collapsed = false;
		setNodeSize(node, MIN_REROUTE_WIDTH, Math.max(COLLAPSED_NODE_HEIGHT, getNodeHeight(node)));
	}

	const mainNodes = [...firstColumnNodes, ...middleNodes, ...arrangedReroutes];
	const secondaryNodes = [...middleNodes, ...arrangedReroutes];
	const firstBounds = arrangeGridPosterColumn(firstColumnNodes, 0, 0, rowGap);
	const secondaryX = firstColumnNodes.length
		? Math.round((firstBounds?.width || 0) + colGap)
		: 0;
	const secondaryColumns = Math.max(1, Math.min(2, Math.ceil(Math.sqrt(secondaryNodes.length || 1))));
	arrangeGridPosterVerticalMasonry(secondaryNodes, secondaryX, 0, secondaryColumns, colGap, rowGap, false);
	const mainInitialBounds = getBoundsForNodes(mainNodes, 0);
	const isolatedTargetWidth = Math.max(360, mainInitialBounds?.width || 0);
	const isolatedBounds = arrangeGridPosterBalancedRows(isolatedNodes, 0, 0, isolatedTargetWidth, colGap, rowGap);
	const mainY = isolatedNodes.length
		? Math.round(isolatedBounds.bottom + rowGap)
		: 0;
	moveNodesBy(mainNodes, 0, mainY);

	const leftBounds = getBoundsForNodes([...isolatedNodes, ...mainNodes], 0);
	const leftWidth = Math.max(240, leftBounds?.width || 0);
	const leftHeight = Math.max(1, Math.round(leftBounds?.height || 540));
	const previewWidth = heroOutputs.length ? Math.round(leftHeight) : 0;
	const previewHeight = heroOutputs.length ? leftHeight : 0;
	const previewX = leftWidth + regionGap;
	const previewY = 0;
	arrangeGridPosterHeroOutputs(heroOutputs, previewX, previewY, previewWidth, previewHeight, rowGap);

	const belowNodes = [...isolatedNodes, ...mainNodes, ...heroOutputs];
	const belowBounds = getBoundsForNodes(belowNodes, 0);
	const titleWidth = Math.max(1, Math.round(belowBounds?.width || previewX + previewWidth));
	const currentTitleWidth = Math.max(1, getNodeWidth(title));
	const currentTitleHeight = Math.max(24, getNodeHeight(title));
	const titleAspect = clampLayoutValue((currentTitleHeight / currentTitleWidth) * 1000, 120, 380) / 1000;
	const estimatedTitleHeight = title ? Math.max(120, Math.round(titleWidth * titleAspect)) : 0;
	const titleGap = title ? regionGap : 0;

	if (title) {
		const titleHeight = syncGridPosterWorkflowTitleSize(title, titleWidth, estimatedTitleHeight);
		setNodePosition(title, 0, 0);
		moveNodesBy(belowNodes, 0, titleHeight + titleGap);
	}
	setGridPosterFinalizeContext(title, belowNodes, titleGap);

	const arrangedNodes = [...titleNodes, ...isolatedNodes, ...firstColumnNodes, ...middleNodes, ...arrangedReroutes, ...heroOutputs];
	refreshAfterArrange(arrangedNodes);
	return true;
}

function arrangeGrid(nodes, spacing = DEFAULT_SPACING) {
	if (nodes.length === 0) return;

	if (arrangePosterGridLayout(nodes, spacing)) {
		return;
	}

	const { connectedNodes, isolatedNodes } = splitNodesByIsolation(nodes);
	const workflowOrder = getWorkflowSortedNodesForGrid(connectedNodes);
	if (workflowOrder.length === 0) {
		placeStandaloneIsolatedNodes(isolatedNodes, [], "row", spacing);
		return;
	}

	const {
		normalNodes,
		rerouteNodes,
		forward,
		inDegree,
		outDegree,
	} = buildConnectionGraph(connectedNodes);
	const connectedSet = new Set(connectedNodes);
	const orderIndex = new Map(workflowOrder.map((node, index) => [node, index]));
	const byWorkflow = compareByGridWorkflowOrder(orderIndex);
	const byLocality = compareByGridLocalityOrder(orderIndex, forward, inDegree);
	const inputModelNodes = [];
	const middleNodes = [];
	const outputNodes = [];

	for (const node of normalNodes.filter((item) => connectedSet.has(item))) {
		if (isGridInputOrModelNode(node, inDegree, outDegree)) {
			inputModelNodes.push(node);
		} else if (isGridOutputNode(node, inDegree, outDegree)) {
			outputNodes.push(node);
		} else {
			middleNodes.push(node);
		}
	}

	inputModelNodes.sort(compareGridTopLeftNodes(orderIndex));
	middleNodes.sort(byLocality);
	outputNodes.sort(byWorkflow);
	if (outputNodes.length > 1) {
		const compactOutputs = outputNodes.splice(0, outputNodes.length - 1);
		middleNodes.push(...compactOutputs);
		middleNodes.sort(byLocality);
	}
	const arrangedReroutes = rerouteNodes.filter((node) => connectedSet.has(node)).sort(byLocality);

	for (const node of middleNodes) {
		if (!isGridLocalInputNode(node, inDegree)) collapseNode(node);
	}

	const arrangedNodes = [...inputModelNodes, ...middleNodes, ...arrangedReroutes, ...outputNodes];
	const cols = getCompactGridColumnCount(arrangedNodes.length);
	const colGap = getGridCompactColumnGap(spacing);
	const rowGap = getGridCompactRowGap(spacing);
	const cells = buildCompactGridCells(inputModelNodes, [...middleNodes, ...arrangedReroutes], outputNodes, cols);

	arrangeVariableGridCells(cells, cols, 0, 0, colGap, rowGap);
	resolveNodeOverlaps(arrangedNodes, Math.max(colGap, rowGap));
	placeStandaloneIsolatedNodes(isolatedNodes, arrangedNodes, "row", spacing);
}

function traceRealSource(nodeId, validSet, visited = new Set()) {
	if (visited.has(nodeId)) return null;
	visited.add(nodeId);

	const node = getNodeById(nodeId);
	if (!node) return null;

	if (!isRerouteNode(node)) {
		return validSet.has(node) ? node : null;
	}

	for (const input of safeArray(node.inputs)) {
		if (!hasExternalInputLink(input)) continue;
		const link = getLinkById(input.link);

		const result = traceRealSource(link.origin_id, validSet, visited);
		if (result) return result;
	}

	return null;
}

function traceRealTargets(nodeId, validSet, visited = new Set()) {
	if (visited.has(nodeId)) return [];
	visited.add(nodeId);

	const node = getNodeById(nodeId);
	if (!node) return [];

	if (!isRerouteNode(node)) {
		return validSet.has(node) ? [node] : [];
	}

	const targets = [];

	for (const output of safeArray(node.outputs)) {
		for (const linkId of externalOutputLinkIds(output)) {
			const link = getLinkById(linkId);

			targets.push(...traceRealTargets(link.target_id, validSet, new Set(visited)));
		}
	}

	return targets;
}

function buildConnectionGraph(nodes) {
	const normalNodes = nodes.filter((node) => !isRerouteNode(node)).sort((a, b) => compareNodesForArrange(a, b));
	const rerouteNodes = nodes.filter((node) => isRerouteNode(node)).sort((a, b) => compareNodesForArrange(a, b));
	const validSet = new Set(normalNodes);

	const forward = new Map();
	const backward = new Map();
	const inDegree = new Map();
	const outDegree = new Map();

	for (const node of normalNodes) {
		forward.set(node, new Set());
		backward.set(node, new Set());
		inDegree.set(node, 0);
		outDegree.set(node, 0);
	}

	for (const node of normalNodes) {
		for (const output of safeArray(node.outputs)) {
			const linkIds = externalOutputLinkIds(output);
			if (linkIds.length === 0) continue;

			for (const linkId of linkIds) {
				const link = getLinkById(linkId);

				const targets = traceRealTargets(link.target_id, validSet);

				for (const target of targets) {
					if (!target || target === node) continue;

					if (!forward.get(node).has(target)) {
						forward.get(node).add(target);
						backward.get(target).add(node);
					}
				}
			}
		}
	}

	for (const node of normalNodes) {
		inDegree.set(node, backward.get(node).size);
		outDegree.set(node, forward.get(node).size);
	}

	return {
		normalNodes,
		rerouteNodes,
		forward,
		backward,
		inDegree,
		outDegree,
	};
}

function calculateSourceLongestLevels(normalNodes, backward) {
	const levels = new Map();

	for (const node of normalNodes) {
		levels.set(node, 0);
	}

	let changed = true;
	let iteration = 0;
	const maxIterations = Math.max(1, normalNodes.length * 2);

	while (changed && iteration < maxIterations) {
		changed = false;
		iteration++;

		for (const node of normalNodes) {
			const parents = Array.from(backward.get(node) || []);
			if (parents.length === 0) continue;

			let maxParentLevel = 0;

			for (const parent of parents) {
				maxParentLevel = Math.max(maxParentLevel, levels.get(parent) || 0);
			}

			const nextLevel = maxParentLevel + 1;

			if ((levels.get(node) || 0) < nextLevel) {
				levels.set(node, nextLevel);
				changed = true;
			}
		}
	}

	return levels;
}

function calculateSinkLongestLevels(normalNodes, forward) {
	const levels = new Map();

	for (const node of normalNodes) {
		levels.set(node, 0);
	}

	let changed = true;
	let iteration = 0;
	const maxIterations = Math.max(1, normalNodes.length * 2);

	while (changed && iteration < maxIterations) {
		changed = false;
		iteration++;

		for (const node of normalNodes) {
			const children = Array.from(forward.get(node) || []);
			if (children.length === 0) continue;

			let maxChildLevel = 0;

			for (const child of children) {
				maxChildLevel = Math.max(maxChildLevel, levels.get(child) || 0);
			}

			const nextLevel = maxChildLevel + 1;

			if ((levels.get(node) || 0) < nextLevel) {
				levels.set(node, nextLevel);
				changed = true;
			}
		}
	}

	return levels;
}

function groupByLevel(normalNodes, levels) {
	const groups = new Map();

	for (const node of normalNodes) {
		const level = Number(levels.get(node) || 0);
		if (!groups.has(level)) groups.set(level, []);
		groups.get(level).push(node);
	}

	return groups;
}

function sortLayersByOriginalY(layerGroups) {
	for (const nodes of layerGroups.values()) {
		nodes.sort((a, b) => compareNodesForArrange(a, b, "y", 1));
	}
}

function sortLayersByBranch(layerGroups, forward, backward) {
	for (const nodes of layerGroups.values()) {
		nodes.sort((a, b) => {
			const priority = compareNodeArrangePriority(a, b);
			if (priority) return priority;

			const aOut = (forward.get(a)?.size || 0);
			const bOut = (forward.get(b)?.size || 0);
			if (aOut !== bOut) return bOut - aOut;

			const aIn = (backward.get(a)?.size || 0);
			const bIn = (backward.get(b)?.size || 0);
			if (aIn !== bIn) return bIn - aIn;

			return compareNodePositionOnly(a, b);
		});
	}
}

function sortLayersByBarycenter(layerGroups, levels, forward, backward) {
	sortLayersByOriginalY(layerGroups);

	const sortedLevels = Array.from(layerGroups.keys()).sort((a, b) => a - b);

	for (let iter = 0; iter < 4; iter++) {
		for (let i = 1; i < sortedLevels.length; i++) {
			const level = sortedLevels[i];
			const nodes = layerGroups.get(level);
			if (!nodes) continue;

			const bary = new Map();

			for (const node of nodes) {
				const parents = Array.from(backward.get(node) || []);

				if (parents.length === 0) {
					bary.set(node, getNodeY(node) / 10000);
					continue;
				}

				let sum = 0;
				let count = 0;

				for (const parent of parents) {
					const parentLevel = levels.get(parent);
					const parentLayer = layerGroups.get(parentLevel);
					if (!parentLayer) continue;

					const index = parentLayer.indexOf(parent);
					if (index >= 0) {
						sum += index;
						count++;
					}
				}

				bary.set(node, count > 0 ? sum / count : getNodeY(node) / 10000);
			}

			nodes.sort((a, b) => compareNodeArrangePriority(a, b) || (bary.get(a) - bary.get(b)) || compareNodePositionOnly(a, b));
		}

		for (let i = sortedLevels.length - 2; i >= 0; i--) {
			const level = sortedLevels[i];
			const nodes = layerGroups.get(level);
			if (!nodes) continue;

			const bary = new Map();

			for (const node of nodes) {
				const children = Array.from(forward.get(node) || []);

				if (children.length === 0) {
					bary.set(node, getNodeY(node) / 10000);
					continue;
				}

				let sum = 0;
				let count = 0;

				for (const child of children) {
					const childLevel = levels.get(child);
					const childLayer = layerGroups.get(childLevel);
					if (!childLayer) continue;

					const index = childLayer.indexOf(child);
					if (index >= 0) {
						sum += index;
						count++;
					}
				}

				bary.set(node, count > 0 ? sum / count : getNodeY(node) / 10000);
			}

			nodes.sort((a, b) => compareNodeArrangePriority(a, b) || (bary.get(a) - bary.get(b)) || compareNodePositionOnly(a, b));
		}
	}
}

function sortLayerGroups(layerGroups, levels, forward, backward, sortStrategy) {
	if (sortStrategy === "originalY") {
		sortLayersByOriginalY(layerGroups);
		return;
	}

	if (sortStrategy === "branch") {
		sortLayersByBranch(layerGroups, forward, backward);
		sortLayersByBarycenter(layerGroups, levels, forward, backward);
		return;
	}

	sortLayersByBarycenter(layerGroups, levels, forward, backward);
}

function getMaxNodeWidthByLevel(layerGroups) {
	const map = new Map();

	for (const [level, nodes] of layerGroups.entries()) {
		let maxWidth = 0;

		for (const node of nodes) {
			maxWidth = Math.max(maxWidth, getNodeWidth(node));
		}

		map.set(level, maxWidth);
	}

	return map;
}

function calculateLevelXPositions(layerGroups, config) {
	const levels = Array.from(layerGroups.keys()).sort((a, b) => a - b);
	const maxWidthByLevel = getMaxNodeWidthByLevel(layerGroups);

	const xByLevel = new Map();
	let currentX = 0;

	for (const level of levels) {
		xByLevel.set(level, currentX);
		const width = maxWidthByLevel.get(level) || 240;
		currentX += width + config.colWidth;
	}

	if (config.xDirection === "rightOutput") {
		const minLevel = Math.min(...levels);
		const maxLevel = Math.max(...levels);
		const normalXByLevel = new Map();

		let x = 0;
		for (let level = maxLevel; level >= minLevel; level--) {
			if (!layerGroups.has(level)) continue;
			normalXByLevel.set(level, x);
			const width = maxWidthByLevel.get(level) || 240;
			x += width + config.colWidth;
		}

		return normalXByLevel;
	}

	return xByLevel;
}

function placeLayeredNodes(layerGroups, xByLevel, config) {
	const levels = Array.from(layerGroups.keys()).sort((a, b) => a - b);

	for (const level of levels) {
		const nodes = layerGroups.get(level) || [];
		const x = xByLevel.get(level) || 0;

		let currentY = 0;

		for (const node of nodes) {
			setNodePosition(node, x, currentY);
			currentY += getNodeHeight(node) + config.rowGap;
		}
	}
}

function separateIsolatedNodes(normalNodes, inDegree, outDegree) {
	return normalNodes.filter((node) => {
		return (inDegree.get(node) || 0) === 0 && (outDegree.get(node) || 0) === 0;
	});
}

function hasDirectLinkWithinNodeSet(node, idSet) {
	if (!node || !idSet?.size) return false;

	for (const input of safeArray(node.inputs)) {
		if (!hasExternalInputLink(input)) continue;
		const link = getLinkById(input.link);
		if (link?.origin_id != null && String(link.origin_id) !== String(node.id) && idSet.has(String(link.origin_id))) {
			return true;
		}
	}

	for (const output of safeArray(node.outputs)) {
		for (const linkId of externalOutputLinkIds(output)) {
			const link = getLinkById(linkId);
			if (link?.target_id != null && String(link.target_id) !== String(node.id) && idSet.has(String(link.target_id))) {
				return true;
			}
		}
	}

	return false;
}

function splitNodesByIsolation(nodes) {
	const validNodes = filterValidNodes(nodes, false);
	if (validNodes.length === 0) {
		return { connectedNodes: [], isolatedNodes: [] };
	}

	const {
		normalNodes,
		rerouteNodes,
		inDegree,
		outDegree,
	} = buildConnectionGraph(validNodes);

	const isolatedSet = new Set(separateIsolatedNodes(normalNodes, inDegree, outDegree));
	const nodeIdSet = new Set(validNodes.map((node) => node?.id).filter((id) => id != null).map(String));

	for (const reroute of rerouteNodes) {
		if (!hasDirectLinkWithinNodeSet(reroute, nodeIdSet)) {
			isolatedSet.add(reroute);
		}
	}

	return {
		connectedNodes: validNodes.filter((node) => !isolatedSet.has(node)).sort((a, b) => compareNodesForArrange(a, b)),
		isolatedNodes: validNodes.filter((node) => isolatedSet.has(node)).sort((a, b) => compareNodesForArrange(a, b)),
	};
}

function sortStandaloneIsolatedNodes(nodes) {
	return [...nodes].sort((a, b) => compareNodesForArrange(a, b));
}

function placeStandaloneIsolatedNodes(isolatedNodes, anchorNodes, orientation = "row", spacing = DEFAULT_SPACING) {
	const isolated = sortStandaloneIsolatedNodes(filterValidNodes(isolatedNodes, false));
	if (!isolated.length) return;

	const anchors = filterValidNodes(anchorNodes, false);
	const colGap = getColumnGap(spacing);
	const rowGap = getRowGap(spacing);
	const mainBounds = getBoundsForNodes(anchors, 0);

	if (orientation === "column") {
		const maxWidth = Math.max(1, ...isolated.map(getNodeWidth));
		const startX = mainBounds ? mainBounds.x - Math.max(0, colGap * 3) - maxWidth : 0;
		let currentY = mainBounds ? mainBounds.y : 0;

		for (const node of isolated) {
			setNodePosition(node, startX, currentY);
			currentY += getNodeHeight(node) + rowGap;
		}
		return;
	}

	let currentX = mainBounds ? mainBounds.x : 0;
	const maxHeight = Math.max(1, ...isolated.map(getNodeHeight));
	const startY = mainBounds ? mainBounds.y - Math.max(0, rowGap * 3) - maxHeight : 0;

	for (const node of isolated) {
		setNodePosition(node, currentX, startY);
		currentX += getNodeWidth(node) + colGap;
	}
}

function placeIsolatedNodes(isolatedNodes, layerGroups, config) {
	if (!isolatedNodes.length) return;

	const allPlaced = [];

	for (const nodes of layerGroups.values()) {
		allPlaced.push(...nodes);
	}

	let minX = 0;
	let maxX = 0;

	if (allPlaced.length > 0) {
		minX = Math.min(...allPlaced.map(getNodeX));
		maxX = Math.max(...allPlaced.map((node) => getNodeX(node) + getNodeWidth(node)));
	}

	const isolatedMaxWidth = Math.max(240, ...isolatedNodes.map(getNodeWidth));
	const isolatedX = config.isolatedSide === "right"
		? maxX + config.colWidth
		: minX - config.colWidth - isolatedMaxWidth;

	let currentY = 0;

	isolatedNodes.sort((a, b) => compareNodesForArrange(a, b));

	for (const node of isolatedNodes) {
		setNodePosition(node, isolatedX, currentY);
		currentY += getNodeHeight(node) + Math.max(0, Math.round(config.rowGap * 0.75));
	}
}

function getNodeCenter(node) {
	return {
		x: getNodeX(node) + getNodeWidth(node) / 2,
		y: getNodeY(node) + getNodeHeight(node) / 2,
	};
}

function placeRerouteNodes(rerouteNodes, normalNodes) {
	if (!rerouteNodes.length) return;

	const validSet = new Set(normalNodes);

	for (const reroute of rerouteNodes) {
		let sourceNode = null;
		let targetNode = null;

		for (const input of safeArray(reroute.inputs)) {
			if (!hasExternalInputLink(input)) continue;

			const link = getLinkById(input.link);

			sourceNode = traceRealSource(link.origin_id, validSet);
			if (sourceNode) break;
		}

		for (const output of safeArray(reroute.outputs)) {
			for (const linkId of externalOutputLinkIds(output)) {
				const link = getLinkById(linkId);

				const targets = traceRealTargets(link.target_id, validSet);
				targetNode = targets[0] || null;
				if (targetNode) break;
			}

			if (targetNode) break;
		}

		if (sourceNode && targetNode) {
			const sourceCenter = getNodeCenter(sourceNode);
			const targetCenter = getNodeCenter(targetNode);
			setNodePosition(
				reroute,
				(sourceCenter.x + targetCenter.x) / 2 - getNodeWidth(reroute) / 2,
				(sourceCenter.y + targetCenter.y) / 2 - getNodeHeight(reroute) / 2
			);
		} else if (sourceNode) {
			setNodePosition(
				reroute,
				getNodeX(sourceNode) + getNodeWidth(sourceNode),
				getNodeY(sourceNode)
			);
		} else if (targetNode) {
			setNodePosition(
				reroute,
				getNodeX(targetNode) - getNodeWidth(reroute),
				getNodeY(targetNode)
			);
		}
	}
}

function getNodeIdentityValues(node) {
	return [
		node?.type,
		node?.comfyClass,
		node?.properties?.["Node name for S&R"],
		node?.constructor?.title,
		node?.title,
		node?.name,
	].filter((value) => value != null && value !== "").map((value) => String(value));
}

function hasExactSetGetType(node, typeSet) {
	for (const value of getNodeIdentityValues(node).slice(0, 3)) {
		if (typeSet.has(value)) return true;
	}
	return false;
}

function hasSetGetTitlePrefix(node, prefix) {
	const pattern = new RegExp(`^${prefix}(?:[_:：-]|$)`, "i");
	for (const value of getNodeIdentityValues(node)) {
		if (pattern.test(String(value || "").trim())) return true;
	}
	return false;
}

function hasSetGetVariableWidget(node) {
	for (const widget of safeArray(node?.widgets)) {
		const label = String(widget?.name || widget?.label || "").toLowerCase();
		if (/constant|variable|变量|名称|name/.test(label)) return true;
	}
	return false;
}

function normalizeSetGetName(value) {
	const text = String(value ?? "").trim();
	if (!text || text === "*" || text === "undefined" || text === "null") return "";
	return text;
}

function getSetGetWidgetName(node) {
	const widgets = safeArray(node?.widgets);
	const preferred = widgets.find((widget) => {
		const label = String(widget?.name || widget?.label || "").toLowerCase();
		return /constant|variable|变量|名称|name/.test(label);
	});

	const ordered = preferred ? [preferred, ...widgets.filter((widget) => widget !== preferred)] : widgets;
	for (const widget of ordered) {
		const value = normalizeSetGetName(widget?.value);
		if (value) return value;
	}
	return "";
}

function parseSetGetNameFromTitle(node) {
	for (const value of getNodeIdentityValues(node)) {
		const match = String(value || "").trim().match(/^(?:set|get)[_:：-]+(.+)$/i);
		const name = normalizeSetGetName(match?.[1]);
		if (name) return name;
	}
	return "";
}

function isSetNodeForArrangement(node) {
	if (hasExactSetGetType(node, SET_NODE_TYPES)) return true;
	return hasSetGetTitlePrefix(node, "Set") && (node?.isVirtualNode || hasSetGetVariableWidget(node));
}

function isGetNodeForArrangement(node) {
	if (hasExactSetGetType(node, GET_NODE_TYPES)) return true;
	return hasSetGetTitlePrefix(node, "Get") && (node?.isVirtualNode || hasSetGetVariableWidget(node));
}

function isSetGetNodeForArrangement(node) {
	return isSetNodeForArrangement(node) || isGetNodeForArrangement(node);
}

function getSetGetVariableName(node) {
	return getSetGetWidgetName(node) || parseSetGetNameFromTitle(node);
}

function getSetGetFamilyKey(node) {
	const type = String(node?.type || node?.comfyClass || node?.properties?.["Node name for S&R"] || "").trim();
	if (type === "GJJ_SetNode" || type === "GJJ_GetNode") return "gjj";
	if (type === "SetNode" || type === "GetNode") return "kjnodes";
	if (type === "Set" || type === "Get") return "generic:set-get";

	const aux = String(node?.properties?.aux_id || node?.constructor?.name || type || "generic").trim().toLowerCase();
	return `generic:${aux || "set-get"}`;
}

function getSetGetPairKey(node) {
	const name = getSetGetVariableName(node);
	return name ? `${getSetGetFamilyKey(node)}\n${name}` : "";
}

function sortByOriginalPosition(nodes) {
	return [...safeArray(nodes)].sort((a, b) => compareNodesForArrange(a, b));
}

function pushUniqueNode(list, seen, node) {
	if (!node || seen.has(node)) return;
	seen.add(node);
	list.push(node);
}

function collectSetGetRows(selectedNodes) {
	const selected = sortByOriginalPosition(selectedNodes).filter(isSetGetNodeForArrangement);
	if (!selected.length) return [];

	const allNodes = filterValidNodes(getAllGraphNodes(), false);
	const settersByName = new Map();
	const gettersByName = new Map();

	for (const node of allNodes) {
		const name = getSetGetVariableName(node);
		if (!name) continue;
		const key = getSetGetPairKey(node);
		if (isSetNodeForArrangement(node)) {
			if (!settersByName.has(key)) settersByName.set(key, []);
			settersByName.get(key).push(node);
		} else if (isGetNodeForArrangement(node)) {
			if (!gettersByName.has(key)) gettersByName.set(key, []);
			gettersByName.get(key).push(node);
		}
	}

	for (const list of settersByName.values()) list.sort((a, b) => getNodeY(a) - getNodeY(b));
	for (const list of gettersByName.values()) list.sort((a, b) => getNodeY(a) - getNodeY(b));

	const rows = [];
	const usedKeys = new Set();

	for (const node of selected) {
		const name = getSetGetVariableName(node);
		const key = getSetGetPairKey(node) || `node:${node.id}`;
		if (usedKeys.has(key)) continue;
		usedKeys.add(key);

		const selectedSameName = name
			? selected.filter((item) => getSetGetPairKey(item) === key)
			: [node];
		const selectedSetters = selectedSameName.filter(isSetNodeForArrangement);
		const selectedGetters = selectedSameName.filter(isGetNodeForArrangement);
		const allSetters = name ? settersByName.get(key) || [] : [];
		const allGetters = name ? gettersByName.get(key) || [] : [];

		const setter = selectedSetters[0] || allSetters[0] || (isSetNodeForArrangement(node) ? node : null);
		let getters = name ? allGetters : selectedGetters;

		if (!name && isGetNodeForArrangement(node)) getters = [node];
		const uniqueGetters = [];
		const seenGetters = new Set();
		for (const getter of sortByOriginalPosition(getters)) {
			pushUniqueNode(uniqueGetters, seenGetters, getter);
		}

		if (!setter && uniqueGetters.length === 0) continue;
		rows.push({
			name,
			setter,
			getters: uniqueGetters,
			selectedNodes: selectedSameName,
		});
	}

	rows.sort((a, b) => {
		const aNodes = [a.setter, ...a.getters, ...a.selectedNodes].filter(Boolean);
		const bNodes = [b.setter, ...b.getters, ...b.selectedNodes].filter(Boolean);
		const ay = Math.min(...aNodes.map(getNodeY));
		const by = Math.min(...bNodes.map(getNodeY));
		if (Math.abs(ay - by) > 8) return ay - by;
		return Math.min(...aNodes.map(getNodeX)) - Math.min(...bNodes.map(getNodeX));
	});

	return rows;
}

function getSelectedSetGetOnlyNodesForBranch(selectedOnly = false) {
	const explicit = Array.from(getExplicitSelectedNodeSetForScope()).filter(isRealNode);
	if (!explicit.length) return [];
	if (!explicit.every(isSetGetNodeForArrangement)) return [];
	if (!selectedOnly) {
		const allNodes = filterValidNodes(getAllGraphNodes(), false);
		if (explicit.length < allNodes.length) return [];
	}
	return explicit;
}

function getLinkedSourceNodes(node) {
	const result = [];
	for (const input of safeArray(node?.inputs)) {
		if (!hasExternalInputLink(input)) continue;
		const link = getLinkById(input.link);
		const source = link?.origin_id != null ? getNodeById(link.origin_id) : null;
		if (source) result.push(source);
	}
	return result;
}

function getLinkedTargetNodes(node) {
	const result = [];
	for (const output of safeArray(node?.outputs)) {
		for (const linkId of externalOutputLinkIds(output)) {
			const link = getLinkById(linkId);
			const target = link?.target_id != null ? getNodeById(link.target_id) : null;
			if (target) result.push(target);
		}
	}
	return result;
}

function collectDirectionalSetGetLevels(seeds, direction, blockedNodes, claimedNodes) {
	const levels = new Map();
	const queue = [];
	const blocked = blockedNodes || new Set();
	const claimed = claimedNodes || new Set();

	function enqueue(node, level) {
		if (!isRealNode(node)) return;
		if (blocked.has(node) || claimed.has(node)) return;
		if (isSetGetNodeForArrangement(node)) return;

		const oldLevel = levels.get(node);
		if (oldLevel != null && oldLevel <= level) return;
		levels.set(node, level);
		queue.push({ node, level });
	}

	for (const seed of safeArray(seeds)) {
		const nextNodes = direction < 0 ? getLinkedSourceNodes(seed) : getLinkedTargetNodes(seed);
		for (const node of nextNodes) enqueue(node, 1);
	}

	while (queue.length > 0) {
		const { node, level } = queue.shift();
		const nextNodes = direction < 0 ? getLinkedSourceNodes(node) : getLinkedTargetNodes(node);
		for (const next of nextNodes) enqueue(next, level + 1);
	}

	return levels;
}

function claimLevelNodes(levels, claimedNodes) {
	const result = new Map();
	for (const [node, level] of levels.entries()) {
		if (claimedNodes.has(node)) continue;
		claimedNodes.add(node);
		result.set(node, level);
	}
	return result;
}

function groupNodesByDistance(levels) {
	const groups = new Map();
	for (const [node, level] of levels.entries()) {
		if (!groups.has(level)) groups.set(level, []);
		groups.get(level).push(node);
	}
	for (const list of groups.values()) {
		const sorted = sortByOriginalPosition(list);
		list.splice(0, list.length, ...sorted);
	}
	return groups;
}

function getStackHeight(nodes, rowGap = DEFAULT_SPACING) {
	const validNodes = filterValidNodes(nodes, false);
	if (!validNodes.length) return 0;
	const gap = Math.max(0, Math.round(rowGap));
	return validNodes.reduce((sum, node) => sum + getNodeHeight(node), 0) + Math.max(0, validNodes.length - 1) * gap;
}

function getStackWidth(nodes) {
	const validNodes = filterValidNodes(nodes, false);
	if (!validNodes.length) return 0;
	return Math.max(...validNodes.map(getNodeWidth));
}

function getMaxGroupedStackHeight(groups, rowGap = DEFAULT_SPACING) {
	let maxHeight = 0;
	for (const nodes of groups.values()) {
		maxHeight = Math.max(maxHeight, getStackHeight(nodes, rowGap));
	}
	return maxHeight;
}

function placeNodeStack(nodes, x, centerY, rowGap = DEFAULT_SPACING) {
	const validNodes = sortByOriginalPosition(filterValidNodes(nodes, false));
	if (!validNodes.length) return;

	const gap = Math.max(0, Math.round(rowGap));
	const totalHeight = getStackHeight(validNodes, gap);
	let y = Math.round(centerY - totalHeight / 2);

	for (const node of validNodes) {
		setNodePosition(node, x, y);
		y += getNodeHeight(node) + gap;
	}
}

function placeGroupedColumnsLeft(groups, anchorX, centerY, columnGap, rowGap) {
	let right = Math.round(anchorX - columnGap);
	const levels = Array.from(groups.keys()).sort((a, b) => a - b);

	for (const level of levels) {
		const nodes = groups.get(level) || [];
		if (!nodes.length) continue;
		const width = getStackWidth(nodes);
		const x = right - width;
		placeNodeStack(nodes, x, centerY, rowGap);
		right = x - columnGap;
	}
}

function placeGroupedColumnsRight(groups, anchorRight, centerY, columnGap, rowGap) {
	let left = Math.round(anchorRight + columnGap);
	const levels = Array.from(groups.keys()).sort((a, b) => a - b);

	for (const level of levels) {
		const nodes = groups.get(level) || [];
		if (!nodes.length) continue;
		placeNodeStack(nodes, left, centerY, rowGap);
		left += getStackWidth(nodes) + columnGap;
	}
}

function arrangeSetGetRows(rows, spacing = DEFAULT_SPACING) {
	const validRows = safeArray(rows).filter((row) => row?.setter || row?.getters?.length);
	if (!validRows.length) return [];

	const rowGap = Math.max(20, getRowGap(spacing));
	const betweenRows = Math.max(96, rowGap * 4);
	const columnGap = Math.max(96, getColumnGap(spacing) * 4);
	const pairGap = Math.max(80, getColumnGap(spacing) * 3);
	const pairNodes = new Set();
	for (const row of validRows) {
		if (row.setter) pairNodes.add(row.setter);
		for (const getter of safeArray(row.getters)) pairNodes.add(getter);
	}

	const claimedBranchNodes = new Set();
	const layoutRows = [];

	for (const row of validRows) {
		const upstreamSeeds = row.setter ? [row.setter] : [];
		const downstreamSeeds = [row.setter, ...safeArray(row.getters)].filter(Boolean);
		const upstreamLevels = claimLevelNodes(
			collectDirectionalSetGetLevels(upstreamSeeds, -1, pairNodes, claimedBranchNodes),
			claimedBranchNodes
		);
		const downstreamLevels = claimLevelNodes(
			collectDirectionalSetGetLevels(downstreamSeeds, 1, pairNodes, claimedBranchNodes),
			claimedBranchNodes
		);
		const upstreamGroups = groupNodesByDistance(upstreamLevels);
		const downstreamGroups = groupNodesByDistance(downstreamLevels);
		const getterHeight = getStackHeight(row.getters, rowGap);
		const pairHeight = Math.max(row.setter ? getNodeHeight(row.setter) : 0, getterHeight);
		const height = Math.max(
			80,
			pairHeight,
			getMaxGroupedStackHeight(upstreamGroups, rowGap),
			getMaxGroupedStackHeight(downstreamGroups, rowGap)
		);

		layoutRows.push({
			...row,
			upstreamGroups,
			downstreamGroups,
			height,
		});
	}

	let currentY = 0;
	const movedNodes = new Set(pairNodes);
	for (const row of layoutRows) {
		const centerY = currentY + row.height / 2;
		const setterWidth = row.setter ? getNodeWidth(row.setter) : 0;
		const getterWidth = getStackWidth(row.getters);
		const setX = 0;
		const getX = row.setter ? setterWidth + pairGap : 0;
		const leftAnchorX = row.setter ? setX : getX;
		const rightAnchor = row.getters?.length
			? getX + getterWidth
			: (row.setter ? setX + setterWidth : getX + getterWidth);

		if (row.setter) {
			setNodePosition(row.setter, setX, centerY - getNodeHeight(row.setter) / 2);
		}
		placeNodeStack(row.getters, getX, centerY, rowGap);
		placeGroupedColumnsLeft(row.upstreamGroups, leftAnchorX, centerY, columnGap, rowGap);
		placeGroupedColumnsRight(row.downstreamGroups, rightAnchor, centerY, columnGap, rowGap);

		for (const nodes of row.upstreamGroups.values()) {
			for (const node of nodes) movedNodes.add(node);
		}
		for (const nodes of row.downstreamGroups.values()) {
			for (const node of nodes) movedNodes.add(node);
		}

		currentY += row.height + betweenRows;
	}

	return Array.from(movedNodes);
}

function finalizeSetGetArrangementPosition(movedNodes, anchorNodes, beforeAnchorBounds, spacing = DEFAULT_SPACING) {
	const moved = filterValidNodes(movedNodes, false);
	if (!moved.length) return;

	const anchors = filterValidNodes(anchorNodes, false).filter((node) => moved.includes(node));
	const gap = Math.max(getColumnGap(spacing), getRowGap(spacing));
	const currentAnchorBounds = getBoundsForNodes(anchors.length ? anchors : moved, gap);
	if (!currentAnchorBounds || !beforeAnchorBounds) return;

	moveNodesBy(
		moved,
		beforeAnchorBounds.x - currentAnchorBounds.x,
		beforeAnchorBounds.y - currentAnchorBounds.y
	);
}

function tryArrangeSelectedSetGetBranch(mode, spacing = DEFAULT_SPACING, selectedOnly = false) {
	const selectedSetGetNodes = getSelectedSetGetOnlyNodesForBranch(selectedOnly);
	if (!selectedSetGetNodes.length) return false;

	const rows = collectSetGetRows(selectedSetGetNodes);
	if (!rows.length) return false;

	const pairedCount = rows.filter((row) => row.setter && row.getters?.length).length;
	const beforeBounds = getBoundsForNodes(selectedSetGetNodes, Math.max(getColumnGap(spacing), getRowGap(spacing)));
	const movedNodes = arrangeSetGetRows(rows, spacing);
	if (!movedNodes.length) return false;

	finalizeSetGetArrangementPosition(movedNodes, selectedSetGetNodes, beforeBounds, spacing);
	refreshAfterArrange(movedNodes);
	cancelPendingFitView();
	console.log(`[GJJ_NodeArranger] Set/Get 变量分支排列完成: rows=${rows.length}, pairs=${pairedCount}, mode=${mode}`);
	return true;
}


function getNodeTypeName(node) {
	return String(node?.comfyClass || node?.type || node?.constructor?.name || "").toLowerCase();
}

function getConnectedInputSlots(node) {
	return safeArray(node.inputs)
		.map((input, index) => ({ input, index }))
		.filter((item) => hasExternalInputLink(item.input));
}

function getConnectedOutputSlots(node) {
	return safeArray(node.outputs)
		.map((output, index) => ({ output, index }))
		.filter((item) => externalOutputLinkIds(item.output).length > 0);
}

function getFirstLinkedSlotIndex(node, backward, forward) {
	let best = 999999;

	for (const { index } of getConnectedInputSlots(node)) {
		best = Math.min(best, index);
	}
	for (const { index } of getConnectedOutputSlots(node)) {
		best = Math.min(best, index);
	}

	if (best !== 999999) return best;

	return (backward.get(node)?.size || 0) * 100 + (forward.get(node)?.size || 0);
}

function sortLayerByInterfaceOrder(nodes, backward, forward) {
	nodes.sort((a, b) => {
		const priority = compareNodeArrangePriority(a, b);
		if (priority) return priority;

		const ai = getFirstLinkedSlotIndex(a, backward, forward);
		const bi = getFirstLinkedSlotIndex(b, backward, forward);
		if (ai !== bi) return ai - bi;

		return compareNodePositionOnly(a, b);
	});
}

function getLayerColumnWidth(nodes) {
	return Math.max(1, ...safeArray(nodes).map((node) => Math.round(getNodeWidth(node))));
}

function getMaxLayerHeight(nodes) {
	return Math.max(1, ...safeArray(nodes).map((node) => Math.round(getNodeHeight(node))));
}

function calculateCompactXPositions(layerGroups, spacing = 0, reverse = false) {
	const levels = Array.from(layerGroups.keys()).sort((a, b) => a - b);
	const orderedLevels = reverse ? [...levels].reverse() : levels;
	const xByLevel = new Map();
	let currentX = 0;

	for (const level of orderedLevels) {
		const layerNodes = layerGroups.get(level) || [];
		xByLevel.set(level, currentX);
		currentX += getLayerColumnWidth(layerNodes) + Math.max(0, Math.round(spacing));
	}

	return xByLevel;
}

function packLayerY(nodes, preferredY, spacing = 0) {
	const gap = Math.max(0, Math.round(spacing));
	const sorted = [...nodes].sort((a, b) => {
		const priority = compareNodeArrangePriority(a, b);
		if (priority) return priority;

		const ay = Number(preferredY.get(a) ?? getNodeY(a));
		const by = Number(preferredY.get(b) ?? getNodeY(b));
		if (ay !== by) return ay - by;

		const ai = getFirstLinkedSlotIndex(a, new Map(), new Map());
		const bi = getFirstLinkedSlotIndex(b, new Map(), new Map());
		if (ai !== bi) return ai - bi;

		return compareNodePositionOnly(a, b);
	});

	let currentY = 0;
	for (const node of sorted) {
		const y = Math.max(Math.round(preferredY.get(node) ?? 0), currentY);
		setNodePosition(node, getNodeX(node), y);
		currentY = y + Math.round(getNodeHeight(node)) + gap;
	}
}

function getConnectedCenterY(node, connectedNodes) {
	if (!connectedNodes || connectedNodes.length === 0) return null;
	let sum = 0;
	let count = 0;
	for (const other of connectedNodes) {
		sum += getNodeY(other) + getNodeHeight(other) / 2;
		count++;
	}
	return count > 0 ? sum / count - getNodeHeight(node) / 2 : null;
}

function arrangeInterfaceAligned(normalNodes, forward, backward, columnGap = 0, rowGap = columnGap) {
	const levels = calculateSinkLongestLevels(normalNodes, forward);
	forcePriorityNodesToLeadingLevel(levels, normalNodes, "max");
	const layerGroups = groupByLevel(normalNodes, levels);

	for (const layer of layerGroups.values()) {
		sortLayerByInterfaceOrder(layer, backward, forward);
	}

	const xByLevel = calculateCompactXPositions(layerGroups, columnGap, true);
	const sortedLevels = Array.from(layerGroups.keys()).sort((a, b) => b - a);

	for (const level of sortedLevels) {
		const layer = layerGroups.get(level) || [];
		let y = 0;
		for (const node of layer) {
			setNodePosition(node, xByLevel.get(level) || 0, y);
			y += Math.round(getNodeHeight(node)) + Math.max(0, Math.round(rowGap));
		}
	}

	for (let iter = 0; iter < 4; iter++) {
		for (const level of sortedLevels) {
			const layer = layerGroups.get(level) || [];
			const preferredY = new Map();

			for (const node of layer) {
				const parents = Array.from(backward.get(node) || []);
				const children = Array.from(forward.get(node) || []);
				const connected = [...parents, ...children].filter((other) => other && getNodeX(other) !== getNodeX(node));
				const centerY = getConnectedCenterY(node, connected);
				preferredY.set(node, centerY == null ? getNodeY(node) : centerY);
			}

			packLayerY(layer, preferredY, rowGap);
		}
	}
}

function classifyNodeBlock(node, inDegree, outDegree) {
	const t = getNodeTypeName(node);

	if (isPriorityArrangeNode(node)) return "00 优先";
	if ((inDegree.get(node) || 0) === 0 && (outDegree.get(node) || 0) > 0) return "01 输入";
	if ((outDegree.get(node) || 0) === 0 && (inDegree.get(node) || 0) > 0) return "02 输出";
	if (/loader|checkpoint|unet|vae|clip|lora|model/.test(t)) return "03 模型";
	if (/sampler|sample|scheduler|ksampler/.test(t)) return "04 采样";
	if (/conditioning|encode|prompt|text|cliptext/.test(t)) return "05 条件";
	if (/image|latent|mask|vae/.test(t)) return "06 图像";
	if (/video|frame|ltx|wan/.test(t)) return "07 视频";
	if (/audio|sound|tts|stt|voice/.test(t)) return "08 音频";
	if (/preview|save|output|viewer/.test(t)) return "09 输出工具";
	return "10 其它";
}

function arrangeNodesInSquareBlock(nodes, x, y, columnGap = 0, rowGap = columnGap) {
	if (!nodes.length) return { width: 0, height: 0 };

	const colGap = Math.max(0, Math.round(columnGap));
	const rGap = Math.max(0, Math.round(rowGap));
	const maxW = getLayerColumnWidth(nodes);
	const maxH = getMaxLayerHeight(nodes);
	const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));

	let maxRight = x;
	let maxBottom = y;

	nodes.sort((a, b) => compareNodesForArrange(a, b, "y", 0));

	for (let i = 0; i < nodes.length; i++) {
		const col = i % cols;
		const row = Math.floor(i / cols);
		const nx = x + col * (maxW + colGap);
		const ny = y + row * (maxH + rGap);
		setNodePosition(nodes[i], nx, ny);
		maxRight = Math.max(maxRight, nx + getNodeWidth(nodes[i]));
		maxBottom = Math.max(maxBottom, ny + getNodeHeight(nodes[i]));
	}

	return {
		width: Math.round(maxRight - x),
		height: Math.round(maxBottom - y),
	};
}

function arrangeTypeBlocksSquare(normalNodes, inDegree, outDegree, columnGap = 0, rowGap = columnGap) {
	const colGap = Math.max(0, Math.round(columnGap));
	const rGap = Math.max(0, Math.round(rowGap));
	const blocks = new Map();

	for (const node of normalNodes) {
		const key = classifyNodeBlock(node, inDegree, outDegree);
		if (!blocks.has(key)) blocks.set(key, []);
		blocks.get(key).push(node);
	}

	const entries = Array.from(blocks.entries()).sort((a, b) => a[0].localeCompare(b[0], "zh-Hans-CN"));
	const blockCount = entries.length;
	const blockCols = Math.max(1, Math.ceil(Math.sqrt(blockCount)));

	const measured = entries.map(([key, list]) => {
		const cols = Math.max(1, Math.ceil(Math.sqrt(list.length)));
		const rows = Math.ceil(list.length / cols);
		const maxW = getLayerColumnWidth(list);
		const maxH = getMaxLayerHeight(list);
		return {
			key,
			list,
			width: cols * maxW + Math.max(0, cols - 1) * colGap,
			height: rows * maxH + Math.max(0, rows - 1) * rGap,
		};
	});

	const cellW = Math.max(1, ...measured.map((item) => item.width));
	const cellH = Math.max(1, ...measured.map((item) => item.height));

	for (let i = 0; i < measured.length; i++) {
		const item = measured[i];
		const col = i % blockCols;
		const row = Math.floor(i / blockCols);
		const x = col * (cellW + colGap);
		const y = row * (cellH + rGap);
		arrangeNodesInSquareBlock(item.list, x, y, colGap, rGap);
	}
}

function collectRootsForNode(node, backward, rootSet, visited = new Set()) {
	if (!node || visited.has(node)) return [];
	visited.add(node);

	if (rootSet.has(node)) return [node];

	const parents = Array.from(backward.get(node) || []);
	let roots = [];
	for (const parent of parents) {
		roots.push(...collectRootsForNode(parent, backward, rootSet, new Set(visited)));
	}

	return Array.from(new Set(roots));
}

function arrangeInputTopBranches(normalNodes, forward, backward, inDegree, outDegree, columnGap = 0, rowGap = columnGap) {
	const colGap = Math.max(0, Math.round(columnGap));
	const rGap = Math.max(0, Math.round(rowGap));
	const roots = normalNodes
		.filter((node) => isPriorityArrangeNode(node) || (inDegree.get(node) || 0) === 0)
		.sort((a, b) => compareNodeArrangePriority(a, b)
			|| (getFirstLinkedSlotIndex(a, backward, forward) - getFirstLinkedSlotIndex(b, backward, forward))
			|| compareNodePositionOnly(a, b));

	if (roots.length === 0) {
		arrangeInterfaceAligned(normalNodes, forward, backward, columnGap, rowGap);
		return;
	}

	const rootSet = new Set(roots);
	const levels = calculateSourceLongestLevels(normalNodes, backward);
	const branchMap = new Map();
	for (const root of roots) branchMap.set(root, []);

	for (const node of normalNodes) {
		const rootsForNode = collectRootsForNode(node, backward, rootSet);
		const owner = rootsForNode[0] || roots[0];
		branchMap.get(owner).push(node);
	}

	let currentX = 0;
	const rootCenters = new Map();

	for (const root of roots) {
		const branchNodes = branchMap.get(root) || [root];
		const maxW = getLayerColumnWidth(branchNodes);
		const rootX = currentX + Math.round((maxW - getNodeWidth(root)) / 2);
		setNodePosition(root, rootX, 0);
		rootCenters.set(root, currentX + Math.round(maxW / 2));
		currentX += maxW + colGap;
	}

	for (const root of roots) {
		const branchNodes = (branchMap.get(root) || []).filter((node) => node !== root);
		const byLevel = new Map();

		for (const node of branchNodes) {
			const level = Math.max(1, Number(levels.get(node) || 1));
			if (!byLevel.has(level)) byLevel.set(level, []);
			byLevel.get(level).push(node);
		}

		const centerX = rootCenters.get(root) || 0;
		let currentY = getNodeHeight(root) + rGap;
		const levelKeys = Array.from(byLevel.keys()).sort((a, b) => a - b);

		for (const level of levelKeys) {
			const layer = byLevel.get(level) || [];
			sortLayerByInterfaceOrder(layer, backward, forward);
			let layerY = currentY;
			const layerW = getLayerColumnWidth(layer);
			const cols = Math.max(1, Math.ceil(Math.sqrt(layer.length)));
			const rows = Math.ceil(layer.length / cols);
			const startX = centerX - Math.round((cols * layerW + Math.max(0, cols - 1) * colGap) / 2);

			for (let i = 0; i < layer.length; i++) {
				const col = i % cols;
				const row = Math.floor(i / cols);
				const node = layer[i];
				setNodePosition(node, startX + col * (layerW + colGap), layerY + row * (getMaxLayerHeight(layer) + rGap));
			}

			currentY += rows * getMaxLayerHeight(layer) + Math.max(0, rows - 1) * rGap + rGap;
		}
	}
}

function rectForNode(node, gap = DEFAULT_SPACING) {
	const g = Math.max(0, Math.round(gap));
	return {
		x: getNodeX(node),
		y: getNodeY(node),
		w: Math.max(getNodeWidth(node), getVisualNodeWidth(node)),
		h: getNodeHeight(node),
		right: getNodeX(node) + Math.max(getNodeWidth(node), getVisualNodeWidth(node)) + g,
		bottom: getNodeY(node) + getNodeHeight(node) + g,
	};
}

function resolveNodeOverlaps(nodes, spacing = DEFAULT_SPACING) {
	const validNodes = filterValidNodes(nodes, false).filter((node) => !isRerouteNode(node));
	const gap = Math.max(0, Math.round(spacing));
	let changed = false;

	for (let iter = 0; iter < 12; iter++) {
		changed = false;
		validNodes.sort((a, b) => compareNodesForArrange(a, b, "y", 0));

		for (let i = 0; i < validNodes.length; i++) {
			const a = validNodes[i];
			const ar = rectForNode(a, gap);

			for (let j = i + 1; j < validNodes.length; j++) {
				const b = validNodes[j];
				const br = rectForNode(b, gap);

				const overlapX = ar.x < br.right && ar.right > br.x;
				const overlapY = ar.y < br.bottom && ar.bottom > br.y;
				if (!overlapX || !overlapY) continue;

				// 优先向下错开，保持整体横向紧凑；只有同一行邻列压住时才右移。
				const sameRow = Math.abs(getNodeY(a) - getNodeY(b)) <= gap;
				if (sameRow && getNodeX(b) > getNodeX(a)) {
					setNodePosition(b, ar.right, getNodeY(b));
				} else {
					setNodePosition(b, getNodeX(b), ar.bottom);
				}
				changed = true;
			}
		}

		if (!changed) break;
	}
}

function normalizeArrangementOrigin(nodes) {
	const validNodes = filterValidNodes(nodes, false);
	if (!validNodes.length) return;

	const minX = Math.min(...validNodes.map(getNodeX));
	const minY = Math.min(...validNodes.map(getNodeY));

	for (const node of validNodes) {
		setNodePosition(node, getNodeX(node) - minX, getNodeY(node) - minY);
	}
}


function getBoundsForNodes(nodes, gap = 0) {
	const validNodes = filterValidNodes(nodes, false);
	if (!validNodes.length) return null;

	const g = Math.max(0, Math.round(gap));
	const minX = Math.min(...validNodes.map(getNodeX));
	const minY = Math.min(...validNodes.map(getNodeY));
	const maxX = Math.max(...validNodes.map((node) => getNodeX(node) + getNodeWidth(node) + g));
	const maxY = Math.max(...validNodes.map((node) => getNodeY(node) + getNodeHeight(node) + g));

	return {
		x: Math.round(minX),
		y: Math.round(minY),
		width: Math.round(maxX - minX),
		height: Math.round(maxY - minY),
		right: Math.round(maxX),
		bottom: Math.round(maxY),
	};
}

function isPartialArrangementScope(nodes) {
	const allNodes = filterValidNodes(getAllGraphNodes(), false);
	const targetNodes = filterValidNodes(nodes, false);
	return targetNodes.length > 0 && targetNodes.length < allNodes.length;
}

function getFixedNodesForPartialScope(nodes) {
	const targetSet = new Set(filterValidNodes(nodes, false));
	return filterValidNodes(getAllGraphNodes(), false).filter((node) => !targetSet.has(node));
}

function moveNodesBy(nodes, dx, dy) {
	const x = Math.round(Number(dx) || 0);
	const y = Math.round(Number(dy) || 0);
	if (x === 0 && y === 0) return;
	for (const node of filterValidNodes(nodes, false)) {
		setNodePosition(node, getNodeX(node) + x, getNodeY(node) + y);
	}
}

function getPartialScopeBaseline(targetNodes, fixedNodes, fallbackBounds, gap = DEFAULT_SPACING) {
	const targetSet = new Set(filterValidNodes(targetNodes, false));
	const fixedSet = new Set(filterValidNodes(fixedNodes, false));
	const candidatesX = [];
	const candidatesY = [];
	const g = Math.max(0, Math.round(gap));

	for (const node of targetSet) {
		for (const input of safeArray(node.inputs)) {
			if (!hasExternalInputLink(input)) continue;
			const link = getLinkById(input.link);
			const source = link?.origin_id != null ? getNodeById(link.origin_id) : null;
			if (!source || !fixedSet.has(source)) continue;

			candidatesX.push(getNodeX(source) + getNodeWidth(source) + g - getNodeX(node));
			candidatesY.push(getNodeY(source) + getNodeHeight(source) / 2 - getNodeHeight(node) / 2 - getNodeY(node));
		}

		for (const output of safeArray(node.outputs)) {
			for (const linkId of externalOutputLinkIds(output)) {
				const link = getLinkById(linkId);
				const target = link?.target_id != null ? getNodeById(link.target_id) : null;
				if (!target || !fixedSet.has(target)) continue;

				candidatesX.push(getNodeX(target) - getNodeWidth(node) - g - getNodeX(node));
				candidatesY.push(getNodeY(target) + getNodeHeight(target) / 2 - getNodeHeight(node) / 2 - getNodeY(node));
			}
		}
	}

	if (candidatesX.length > 0) {
		const avgX = candidatesX.reduce((sum, value) => sum + value, 0) / candidatesX.length;
		const avgY = candidatesY.reduce((sum, value) => sum + value, 0) / Math.max(1, candidatesY.length);
		return { dx: Math.round(avgX), dy: Math.round(avgY) };
	}

	const current = getBoundsForNodes(targetNodes, gap);
	if (!current || !fallbackBounds) return { dx: 0, dy: 0 };
	return {
		dx: Math.round(fallbackBounds.x - current.x),
		dy: Math.round(fallbackBounds.y - current.y),
	};
}

function boundsOverlap(a, b) {
	return !!a && !!b && a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
}

function avoidFixedNodeOverlaps(targetNodes, fixedNodes, gap = DEFAULT_SPACING) {
	const target = filterValidNodes(targetNodes, false);
	const fixed = filterValidNodes(fixedNodes, false);
	if (!target.length || !fixed.length) return;

	const g = Math.max(0, Math.round(gap));
	for (let iter = 0; iter < 24; iter++) {
		const targetBounds = getBoundsForNodes(target, g);
		let moved = false;

		for (const fixedNode of fixed) {
			const fixedBounds = getBoundsForNodes([fixedNode], g);
			if (!boundsOverlap(targetBounds, fixedBounds)) continue;

			const pushRight = fixedBounds.right - targetBounds.x + g;
			const pushDown = fixedBounds.bottom - targetBounds.y + g;
			if (Math.abs(pushRight) <= Math.abs(pushDown)) {
				moveNodesBy(target, pushRight, 0);
			} else {
				moveNodesBy(target, 0, pushDown);
			}
			moved = true;
			break;
		}

		if (!moved) break;
	}
}

function finalizeArrangementPosition(targetNodes, beforeBounds, columnGap = DEFAULT_SPACING, rowGap = columnGap) {
	const targets = filterValidNodes(targetNodes, false);
	if (!targets.length) return;

	const partial = isPartialArrangementScope(targets);
	const fixedNodes = partial ? getFixedNodesForPartialScope(targets) : [];
	const gap = Math.max(getColumnGap(columnGap), getRowGap(rowGap));

	normalizeArrangementOrigin(targets);

	if (partial) {
		const baseline = getPartialScopeBaseline(targets, fixedNodes, beforeBounds, gap);
		moveNodesBy(targets, baseline.dx, baseline.dy);
		avoidFixedNodeOverlaps(targets, fixedNodes, gap);
	}
}


function getSelectedGraphNodes() {
	return filterValidNodes(getAllGraphNodes(), false).filter((node) => isNodeSelectedForScope(node));
}

function collectAnchorNeighborhood(anchor) {
	const allNodes = filterValidNodes(getAllGraphNodes(), false);
	const allSet = new Set(allNodes);
	const result = new Set();
	const upVisited = new Set();
	const downVisited = new Set();

	function addNode(node) {
		if (node && allSet.has(node)) result.add(node);
	}

	function walkUp(node) {
		if (!node || upVisited.has(node.id)) return;
		upVisited.add(node.id);
		addNode(node);

		for (const input of safeArray(node.inputs)) {
			if (!hasExternalInputLink(input)) continue;
			const link = getLinkById(input.link);
			const source = link?.origin_id != null ? getNodeById(link.origin_id) : null;
			if (!source || !allSet.has(source)) continue;
			walkUp(source);
		}
	}

	function walkDown(node) {
		if (!node || downVisited.has(node.id)) return;
		downVisited.add(node.id);
		addNode(node);

		for (const output of safeArray(node.outputs)) {
			for (const linkId of externalOutputLinkIds(output)) {
				const link = getLinkById(linkId);
				const target = link?.target_id != null ? getNodeById(link.target_id) : null;
				if (!target || !allSet.has(target)) continue;
				walkDown(target);
			}
		}
	}

	walkUp(anchor);
	walkDown(anchor);
	addNode(anchor);

	return Array.from(result);
}

function getRealAnchorForCenteredLayout(anchor, normalNodes, forward, backward) {
	if (!anchor) return null;
	if (!isRerouteNode(anchor) && normalNodes.includes(anchor)) return anchor;

	const normalSet = new Set(normalNodes);
	let best = null;
	let bestDistance = 999999;
	const queue = [{ node: anchor, distance: 0 }];
	const visited = new Set();

	while (queue.length > 0) {
		const { node, distance } = queue.shift();
		if (!node || visited.has(node.id)) continue;
		visited.add(node.id);

		if (!isRerouteNode(node) && normalSet.has(node) && distance < bestDistance) {
			best = node;
			bestDistance = distance;
			continue;
		}

		for (const input of safeArray(node.inputs)) {
			if (!hasExternalInputLink(input)) continue;
			const link = getLinkById(input.link);
			const source = link?.origin_id != null ? getNodeById(link.origin_id) : null;
			if (source) queue.push({ node: source, distance: distance + 1 });
		}

		for (const output of safeArray(node.outputs)) {
			for (const linkId of externalOutputLinkIds(output)) {
				const link = getLinkById(linkId);
				const target = link?.target_id != null ? getNodeById(link.target_id) : null;
				if (target) queue.push({ node: target, distance: distance + 1 });
			}
		}
	}

	return best || normalNodes[0] || null;
}

function calculateSignedLevelsFromAnchor(anchor, normalNodes, forward, backward) {
	const normalSet = new Set(normalNodes);
	const upDistance = new Map();
	const downDistance = new Map();

	function bfs(start, directionMap, resultMap) {
		const queue = [{ node: start, distance: 0 }];
		const visited = new Set();
		while (queue.length > 0) {
			const { node, distance } = queue.shift();
			if (!node || visited.has(node)) continue;
			visited.add(node);
			if (normalSet.has(node)) resultMap.set(node, distance);

			const nextNodes = Array.from(directionMap.get(node) || []);
			for (const next of nextNodes) {
				if (normalSet.has(next) && !visited.has(next)) {
					queue.push({ node: next, distance: distance + 1 });
				}
			}
		}
	}

	bfs(anchor, backward, upDistance);
	bfs(anchor, forward, downDistance);

	const levels = new Map();
	for (const node of normalNodes) {
		if (node === anchor) {
			levels.set(node, 0);
			continue;
		}

		const up = upDistance.has(node) ? upDistance.get(node) : null;
		const down = downDistance.has(node) ? downDistance.get(node) : null;

		if (up != null && down != null) {
			levels.set(node, up <= down ? -up : down);
		} else if (up != null) {
			levels.set(node, -up);
		} else if (down != null) {
			levels.set(node, down);
		} else {
			levels.set(node, 0);
		}
	}

	return levels;
}

function getSlotOrderRelativeToAnchor(node, anchor, forward, backward) {
	let best = 999999;

	for (let i = 0; i < safeArray(anchor?.inputs).length; i++) {
		const input = anchor.inputs[i];
		if (!hasExternalInputLink(input)) continue;
		const link = getLinkById(input.link);
		const source = link?.origin_id != null ? getNodeById(link.origin_id) : null;
		if (source === node || backward.get(anchor)?.has(node)) best = Math.min(best, i);
	}

	for (let i = 0; i < safeArray(anchor?.outputs).length; i++) {
		const output = anchor.outputs[i];
		for (const linkId of externalOutputLinkIds(output)) {
			const link = getLinkById(linkId);
			const target = link?.target_id != null ? getNodeById(link.target_id) : null;
			if (target === node || forward.get(anchor)?.has(node)) best = Math.min(best, i);
		}
	}

	return best === 999999 ? getFirstLinkedSlotIndex(node, backward, forward) : best;
}

function sortCenteredLayer(nodes, level, anchor, forward, backward) {
	nodes.sort((a, b) => {
		const priority = compareNodeArrangePriority(a, b);
		if (priority) return priority;

		const ao = Math.abs(level) === 1 ? getSlotOrderRelativeToAnchor(a, anchor, forward, backward) : getFirstLinkedSlotIndex(a, backward, forward);
		const bo = Math.abs(level) === 1 ? getSlotOrderRelativeToAnchor(b, anchor, forward, backward) : getFirstLinkedSlotIndex(b, backward, forward);
		if (ao !== bo) return ao - bo;

		return compareNodePositionOnly(a, b);
	});
}

function placeCenteredLayer(nodes, x, centerY, rowGap = DEFAULT_SPACING) {
	const gap = Math.max(0, Math.round(rowGap));
	const totalHeight = nodes.reduce((sum, node) => sum + Math.round(getNodeHeight(node)), 0) + Math.max(0, nodes.length - 1) * gap;
	let y = Math.round(centerY - totalHeight / 2);

	for (const node of nodes) {
		setNodePosition(node, x, y);
		y += Math.round(getNodeHeight(node)) + gap;
	}
}

function getAnchorInputOrder(parentNode, childNode) {
	let best = 999999;
	const childSet = new Set([childNode]);
	for (let i = 0; i < safeArray(parentNode?.inputs).length; i++) {
		const input = parentNode.inputs[i];
		if (!hasExternalInputLink(input)) continue;
		const link = getLinkById(input.link);
		const source = traceRealSource(link.origin_id, childSet);
		if (source === childNode) best = Math.min(best, i);
	}
	return best;
}

function getAnchorOutputOrder(parentNode, childNode) {
	let best = 999999;
	const childSet = new Set([childNode]);
	for (let i = 0; i < safeArray(parentNode?.outputs).length; i++) {
		const output = parentNode.outputs[i];
		for (const linkId of externalOutputLinkIds(output)) {
			const link = getLinkById(linkId);
			const targets = traceRealTargets(link.target_id, childSet);
			if (targets.includes(childNode)) {
				best = Math.min(best, i * 1000 + Number(link?.target_slot || 0));
			}
		}
	}
	return best;
}

function getInterfaceOrder(parentNode, childNode, direction) {
	return direction < 0
		? getAnchorInputOrder(parentNode, childNode)
		: getAnchorOutputOrder(parentNode, childNode);
}

function sortNodesByInterfaceFromParent(parentNode, nodes, direction) {
	nodes.sort((a, b) => {
		const priority = compareNodeArrangePriority(a, b);
		if (priority) return priority;

		const ao = getInterfaceOrder(parentNode, a, direction);
		const bo = getInterfaceOrder(parentNode, b, direction);
		if (ao !== bo) return ao - bo;

		const ai = getFirstLinkedSlotIndex(a, new Map(), new Map());
		const bi = getFirstLinkedSlotIndex(b, new Map(), new Map());
		if (ai !== bi) return ai - bi;

		return compareNodePositionOnly(a, b);
	});
}

function getRadialChildOffsets(count, gap) {
	const n = Math.max(1, Math.round(count || 1));
	const g = Math.max(1, Math.round(gap || 1));
	if (n === 1) return [0];
	return Array.from({ length: n }, (_, i) => Math.round((i - (n - 1) / 2) * g));
}

function addCandidatePosition(candidateMap, node, x, y, weight = 1) {
	if (!node) return;
	const w = Math.max(1, Number(weight) || 1);
	if (!candidateMap.has(node)) candidateMap.set(node, { x: 0, y: 0, weight: 0 });
	const c = candidateMap.get(node);
	c.x += Number(x || 0) * w;
	c.y += Number(y || 0) * w;
	c.weight += w;
}

function getLevelNodesByDepth(levels, depth, direction) {
	const wanted = Math.round(depth) * Math.sign(direction || 1);
	return Array.from(levels.entries())
		.filter(([node, level]) => Number(level || 0) === wanted)
		.map(([node]) => node);
}

function separateLevelNodes(nodes, positions, minGap) {
	const sorted = [...nodes].sort((a, b) => {
		const priority = compareNodeArrangePriority(a, b);
		if (priority) return priority;

		const ay = positions.get(a)?.y ?? getNodeY(a);
		const by = positions.get(b)?.y ?? getNodeY(b);
		if (ay !== by) return ay - by;
		return compareNodePositionOnly(a, b);
	});

	let lastBottom = -Infinity;
	for (const node of sorted) {
		const pos = positions.get(node);
		if (!pos) continue;
		const h = getNodeHeight(node);
		const top = pos.y - h / 2;
		const minTop = lastBottom + minGap;
		if (top < minTop) {
			pos.y += minTop - top;
		}
		lastBottom = pos.y + h / 2;
	}
}

function buildDirectionalRadialPositions(anchor, normalNodes, forward, backward, levels, spacing = DEFAULT_SPACING, rowGapOverride = null) {
	// 单节点模式：不再依赖“层级一次性分组”，改成从锚点开始沿连线递归展开。
	// 这样上游的上游、下游的下游会一直排到尽头，不会因为层级判断漏掉而留在原地。
	const positions = new Map();
	const normalSet = new Set(normalNodes);
	const anchorCenter = {
		x: getNodeX(anchor) + getNodeWidth(anchor) / 2,
		y: getNodeY(anchor) + getNodeHeight(anchor) / 2,
	};

	positions.set(anchor, anchorCenter);

	const maxHeight = Math.max(80, ...normalNodes.map(getNodeHeight));
	const columnGap = getColumnGap(spacing);
	const rowGap = rowGapOverride == null ? getRowGap(spacing) : Math.max(0, Math.round(Number(rowGapOverride) || 0));
	const connectedColumnGap = Math.max(6, Math.round(Math.abs(columnGap) * 0.35));
	const rowGapMagnitude = Math.max(1, Math.abs(rowGap));
	const branchGapBase = Math.round(maxHeight + rowGapMagnitude);
	const levelMinGap = rowGapMagnitude;

	// 一个节点可能通过交叉线同时能从两边到达。保留离锚点更近的那次，避免被远层覆盖。
	const assigned = new Map([[anchor, { depth: 0, direction: 0 }]]);

	function getNextNodes(parent, direction) {
		const nextSet = direction < 0 ? backward.get(parent) : forward.get(parent);
		return Array.from(nextSet || []).filter((node) => normalSet.has(node) && node !== anchor);
	}

	function shouldAssign(node, depth, direction) {
		const old = assigned.get(node);
		if (!old) return true;
		if (depth < old.depth) return true;
		// 同等距离时，保留已经在同方向的结果，避免左右来回跳。
		return false;
	}

	function assignNode(node, depth, direction, center) {
		if (!shouldAssign(node, depth, direction)) return false;
		assigned.set(node, { depth, direction });
		positions.set(node, {
			x: Math.round(center.x),
			y: Math.round(center.y),
		});
		return true;
	}

	function getTightConnectedStep(parent, child, depthScale = 1) {
		const visualParentHalf = Math.max(getNodeWidth(parent), getVisualNodeWidth(parent)) / 2;
		const visualChildHalf = Math.max(getNodeWidth(child), getVisualNodeWidth(child)) / 2;
		return Math.round((visualParentHalf + visualChildHalf + connectedColumnGap) * depthScale);
	}

	function expandDirection(direction) {
		const queue = [{ node: anchor, depth: 0 }];
		const expanded = new Set();

		while (queue.length > 0) {
			const item = queue.shift();
			const parent = item.node;
			const depth = item.depth;
			const key = `${direction}:${parent?.id}`;
			if (!parent || expanded.has(key)) continue;
			expanded.add(key);

			const parentPos = positions.get(parent);
			if (!parentPos) continue;

			let children = getNextNodes(parent, direction).filter((node) => {
				const old = assigned.get(node);
				return !old || depth + 1 < old.depth;
			});

			if (!children.length) continue;
			sortNodesByInterfaceFromParent(parent, children, direction);

			const depthScale = 1 + Math.min(0.18, depth * 0.04);
			const branchGap = Math.round(branchGapBase * depthScale);
			const offsets = getRadialChildOffsets(children.length, branchGap);

			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				const stepX = getTightConnectedStep(parent, child, depthScale);

				const childCenter = {
					x: parentPos.x + direction * stepX,
					y: parentPos.y + offsets[i],
				};

				if (assignNode(child, depth + 1, direction, childCenter)) {
					queue.push({ node: child, depth: depth + 1 });
				}
			}
		}
	}

	expandDirection(-1);
	expandDirection(1);

	// 第一轮只会沿“锚点可直接递归到的主方向”展开。
	// 但真实工作流里经常有“反向支线”：例如某个右侧下游节点又接了一个额外上游，
	// 这个额外上游不是从锚点左侧递归过来的，却与已放置节点有连线。
	// 这里继续从所有已放置节点出发，按正向/反向连接把剩余连通节点吸附到对应父节点旁边，
	// 直到整个连通分量都被放置，避免大量节点留在原地。
	function attachRemainingConnectedNodes() {
		let changed = true;
		let guard = 0;
		const maxGuard = Math.max(1, normalNodes.length + 4);

		while (changed && guard < maxGuard) {
			changed = false;
			guard++;

			const candidateMap = new Map();
			const candidateInfo = new Map();
			const placedNodes = Array.from(positions.keys());

			for (const parent of placedNodes) {
				const parentPos = positions.get(parent);
				if (!parentPos) continue;

				const parentInfo = assigned.get(parent) || { depth: 0, direction: 0 };
				const parentDepth = Math.max(0, Number(parentInfo.depth || 0));

				for (const direction of [-1, 1]) {
					let children = getNextNodes(parent, direction).filter((node) => {
						return normalSet.has(node) && node !== anchor && !positions.has(node);
					});

					if (!children.length) continue;
					sortNodesByInterfaceFromParent(parent, children, direction);

					const nextDepth = parentDepth + 1;
					const depthScale = 1 + Math.min(0.22, nextDepth * 0.04);
					const branchGap = Math.round(branchGapBase * depthScale);
					const offsets = getRadialChildOffsets(children.length, branchGap);

					for (let i = 0; i < children.length; i++) {
						const child = children[i];
						const stepX = getTightConnectedStep(parent, child, depthScale);

						const x = parentPos.x + direction * stepX;
						const y = parentPos.y + offsets[i];
						const weight = 1 / Math.max(1, nextDepth);
						addCandidatePosition(candidateMap, child, x, y, weight);

						const oldInfo = candidateInfo.get(child);
						if (!oldInfo || nextDepth < oldInfo.depth) {
							candidateInfo.set(child, {
								depth: nextDepth,
								direction,
							});
						}
					}
				}
			}

			for (const [node, c] of candidateMap.entries()) {
				if (!c || c.weight <= 0 || positions.has(node)) continue;
				const info = candidateInfo.get(node) || { depth: guard, direction: 0 };
				assigned.set(node, info);
				positions.set(node, {
					x: Math.round(c.x / c.weight),
					y: Math.round(c.y / c.weight),
				});
				changed = true;
			}
		}
	}

	attachRemainingConnectedNodes();

	// 每一列单独做一次竖向分离，避免同层节点互相贴住。
	const maxDepth = Math.max(0, ...Array.from(assigned.values()).map((item) => Number(item.depth || 0)));
	for (const direction of [-1, 1]) {
		for (let depth = 1; depth <= maxDepth; depth++) {
			const layerNodes = Array.from(assigned.entries())
				.filter(([node, item]) => node !== anchor && item.depth === depth && item.direction === direction)
				.map(([node]) => node);
			separateLevelNodes(layerNodes, positions, levelMinGap);
		}
	}

	return positions;
}

function getBoundsForPositionMap(positions, gap = 0) {
	const entries = Array.from(positions?.entries?.() || []).filter(([node, center]) => {
		return isRealNode(node) && center && Number.isFinite(Number(center.x)) && Number.isFinite(Number(center.y));
	});
	if (!entries.length) return null;

	const g = Math.max(0, Math.round(gap));
	const minX = Math.min(...entries.map(([node, center]) => center.x - getNodeWidth(node) / 2));
	const minY = Math.min(...entries.map(([node, center]) => center.y - getNodeHeight(node) / 2));
	const maxX = Math.max(...entries.map(([node, center]) => center.x + getNodeWidth(node) / 2 + g));
	const maxY = Math.max(...entries.map(([node, center]) => center.y + getNodeHeight(node) / 2 + g));

	return {
		x: Math.round(minX),
		y: Math.round(minY),
		width: Math.round(maxX - minX),
		height: Math.round(maxY - minY),
		right: Math.round(maxX),
		bottom: Math.round(maxY),
	};
}

function placeDisconnectedNodesAroundAnchor(anchor, floatingNodes, positions, spacing = DEFAULT_SPACING, mode = "auto") {
	if (!floatingNodes.length) return;

	const center = positions.get(anchor) || {
		x: getNodeX(anchor) + getNodeWidth(anchor) / 2,
		y: getNodeY(anchor) + getNodeHeight(anchor) / 2,
	};
	const bounds = getBoundsForPositionMap(positions, Math.max(getColumnGap(spacing), getRowGap(spacing)));
	const colGap = getColumnGap(spacing);
	const rowGap = getRowGap(spacing);

	floatingNodes.sort((a, b) => {
		const priority = compareNodeArrangePriority(a, b);
		if (priority) return priority;

		const ta = String(a?.type || a?.comfyClass || "");
		const tb = String(b?.type || b?.comfyClass || "");
		if (ta !== tb) return ta.localeCompare(tb, "zh-Hans-CN");
		return compareNodePositionOnly(a, b);
	});

	if (String(mode || "") === "vertical") {
		const maxWidth = Math.max(MIN_LAYOUT_NODE_WIDTH, ...floatingNodes.map(getNodeWidth));
		const startX = Math.round((bounds ? bounds.x : center.x) - Math.max(Math.abs(colGap) * 8, 280) - maxWidth / 2);
		let currentTop = bounds ? bounds.y : Math.round(center.y);

		for (const node of floatingNodes) {
			const height = getNodeHeight(node);
			positions.set(node, {
				x: startX,
				y: currentTop + height / 2,
			});
			currentTop += height + rowGap;
		}
		return;
	}

	const floatingGap = Math.max(Math.abs(colGap) * 2, 72);
	const totalWidth = floatingNodes.reduce((sum, node) => sum + getNodeWidth(node), 0) + Math.max(0, floatingNodes.length - 1) * floatingGap;
	const baseCenterX = bounds ? bounds.x + bounds.width / 2 : center.x;
	let currentLeft = Math.round(baseCenterX - totalWidth / 2);
	const maxHeight = Math.max(1, ...floatingNodes.map(getNodeHeight));
	const startY = Math.round((bounds ? bounds.y : center.y) - Math.max(Math.abs(rowGap) * 10, 320) - maxHeight);

	for (const node of floatingNodes) {
		const width = getNodeWidth(node);
		positions.set(node, {
			x: currentLeft + width / 2,
			y: startY + getNodeHeight(node) / 2,
		});
		currentLeft += width + floatingGap;
	}
}

function arrangeCenteredAroundAnchor(anchor, spacing = DEFAULT_SPACING, mode = "auto") {
	if (!anchor) return false;

	// 单节点选择：以所选节点视觉中心为基准，所有节点都参与。
	// 与锚点有连线关系的节点按工作流方向递归放射展开：
	// 上游向左，下游向右；每一层都按父节点接口顺序分散对齐父节点中心，直到尽头。
	const targetNodes = filterValidNodes(getAllGraphNodes(), false);
	if (!targetNodes.length) return false;

	const originalAnchorCenter = {
		x: getNodeX(anchor) + getNodeWidth(anchor) / 2,
		y: getNodeY(anchor) + getNodeHeight(anchor) / 2,
	};

	const {
		normalNodes,
		rerouteNodes,
		forward,
		backward,
	} = buildConnectionGraph(targetNodes);

	const realAnchor = getRealAnchorForCenteredLayout(anchor, normalNodes, forward, backward);
	if (!realAnchor) {
		refreshAfterArrange(targetNodes);
		fitView(targetNodes);
		return true;
	}

	const levels = calculateSignedLevelsFromAnchor(realAnchor, normalNodes, forward, backward);
	const positions = buildDirectionalRadialPositions(realAnchor, normalNodes, forward, backward, levels, spacing, SINGLE_NODE_CONNECTED_ROW_GAP);
	const positionedSet = new Set(positions.keys());
	const floatingNodes = normalNodes.filter((node) => !positionedSet.has(node));
	placeDisconnectedNodesAroundAnchor(realAnchor, floatingNodes, positions, spacing, mode);

	for (const [node, center] of positions.entries()) {
		setNodePosition(
			node,
			center.x - getNodeWidth(node) / 2,
			center.y - getNodeHeight(node) / 2
		);
	}

	placeRerouteNodes(rerouteNodes, normalNodes);

	const gap = SINGLE_NODE_CONNECTED_ROW_GAP;
	let newAnchorCenter = {
		x: getNodeX(anchor) + getNodeWidth(anchor) / 2,
		y: getNodeY(anchor) + getNodeHeight(anchor) / 2,
	};
	moveNodesBy(targetNodes, originalAnchorCenter.x - newAnchorCenter.x, originalAnchorCenter.y - newAnchorCenter.y);

	resolveNodeOverlaps(normalNodes, gap);
	placeRerouteNodes(rerouteNodes, normalNodes);

	newAnchorCenter = {
		x: getNodeX(anchor) + getNodeWidth(anchor) / 2,
		y: getNodeY(anchor) + getNodeHeight(anchor) / 2,
	};
	moveNodesBy(targetNodes, originalAnchorCenter.x - newAnchorCenter.x, originalAnchorCenter.y - newAnchorCenter.y);

	refreshAfterArrange(targetNodes);
	// 单节点中心放射模式：不要自动适配视图。
	// 否则视角会被拉走，用户会找不到作为基准的源节点。
	console.log(`[GJJ_NodeArranger] 单节点连线放射排列完成: ${getNodeTitleForLayout(anchor)}, mode=${mode}, nodes=${targetNodes.length}`);
	return true;
}

async function arrangeTopological(nodes, spacing = DEFAULT_SPACING, sortMode = TOPO_SORT_MODES.TOPO_MAIN_PATH) {
	const validNodes = filterValidNodes(nodes, false);
	const beforeBounds = getBoundsForNodes(validNodes, Math.max(getColumnGap(spacing), getRowGap(spacing)));
	const config = getTopoModeConfig(sortMode);
	const colGap = getColumnGap(spacing);
	const rowGap = getRowGap(spacing);
	const gap = Math.max(colGap, rowGap);

	console.log(`[GJJ_NodeArranger] Starting ${config.name}, nodes=${validNodes.length}`);

	if (validNodes.length === 0) {
		showMessage("没有可排列的节点");
		return;
	}

	const {
		normalNodes,
		rerouteNodes,
		forward,
		backward,
		inDegree,
		outDegree,
	} = buildConnectionGraph(validNodes);

	if (normalNodes.length === 0) {
		placeRerouteNodes(rerouteNodes, []);
		refreshAfterArrange(validNodes);
		fitView(validNodes);
		return;
	}

	const isolatedNodes = separateIsolatedNodes(normalNodes, inDegree, outDegree);
	const isolatedSet = new Set(isolatedNodes);
	const connectedNormalNodes = normalNodes.filter((node) => !isolatedSet.has(node));

	if (connectedNormalNodes.length > 0 && sortMode === TOPO_SORT_MODES.TOPO_MAIN_PATH) {
		// 1. 主链路：以输出锚定为蓝本，按接口顺序计算 Y 轴顺序，
		//    上游/下游尽量按连接节点中心对齐。
		arrangeInterfaceAligned(connectedNormalNodes, forward, backward, colGap, rowGap);
	} else if (connectedNormalNodes.length > 0 && sortMode === TOPO_SORT_MODES.TOPO_COMPACT) {
		// 2. 紧凑层级：输入、输出和其它节点按类型分块，整体尽量形成方形区域。
		arrangeTypeBlocksSquare(connectedNormalNodes, inDegree, outDegree, colGap, rowGap);
	} else if (connectedNormalNodes.length > 0 && sortMode === TOPO_SORT_MODES.TOPO_BRANCH) {
		// 3. 分支优先：输入放第一行，下游放下方并尽量与输入中心对齐。
		arrangeInputTopBranches(connectedNormalNodes, forward, backward, inDegree, outDegree, colGap, rowGap);
	} else if (connectedNormalNodes.length > 0) {
		let levels;

		if (config.levelStrategy === "sinkLongest") {
			levels = calculateSinkLongestLevels(connectedNormalNodes, forward);
			forcePriorityNodesToLeadingLevel(levels, connectedNormalNodes, "max");
		} else {
			levels = calculateSourceLongestLevels(connectedNormalNodes, backward);
			forcePriorityNodesToLeadingLevel(levels, connectedNormalNodes, "min");
		}

		const layerGroups = groupByLevel(connectedNormalNodes, levels);
		sortLayerGroups(layerGroups, levels, forward, backward, config.sortStrategy);

		const xByLevel = calculateLevelXPositions(layerGroups, {
			...config,
			colWidth: Math.max(HORIZONTAL_SAFE_GAP, config.colWidth + colGap),
		});

		placeLayeredNodes(layerGroups, xByLevel, {
			...config,
			rowGap: Math.max(VERTICAL_SAFE_GAP, config.rowGap + rowGap),
		});
	}

	if (colGap >= 0 && rowGap >= 0) {
		resolveNodeOverlaps(connectedNormalNodes, gap);
	}
	placeStandaloneIsolatedNodes(isolatedNodes, connectedNormalNodes, "row", spacing);
	placeRerouteNodes(rerouteNodes, normalNodes);
	finalizeArrangementPosition(validNodes, beforeBounds, colGap, rowGap);
	refreshAfterArrange(validNodes);
	fitView(validNodes);

	await new Promise((resolve) => setTimeout(resolve, 0));

	console.log(`[GJJ_NodeArranger] ${config.name} completed`);
}

async function applyRelax(nodes, iterations = 10, relaxPower = 0.5, spacing = DEFAULT_SPACING, collisionAvoidance = true) {
	const validNodes = filterValidNodes(nodes, false);

	for (let iter = 0; iter < iterations; iter++) {
		let moved = false;

		for (const node of validNodes) {
			if (calculateRelaxPosition(node, validNodes, relaxPower, spacing, true)) {
				moved = true;
			}
		}

		if (collisionAvoidance) {
			moved = avoidCollisions(validNodes, spacing, 0.45, false) || moved;
		}

		if (iter % 3 === 2) {
			refreshAfterArrange(validNodes);
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		if (!moved) break;
	}

	refreshAfterArrange(validNodes);
}

function getSmartFocusNodes(normalNodes, inDegree, outDegree) {
	const connectedNodes = normalNodes.filter((node) => {
		return (inDegree.get(node) || 0) > 0 || (outDegree.get(node) || 0) > 0;
	});
	if (!connectedNodes.length) return [];

	const outputs = connectedNodes
		.filter((node) => (outDegree.get(node) || 0) === 0 && (inDegree.get(node) || 0) > 0)
		.sort((a, b) => {
			return compareNodesForArrange(a, b);
		});

	const maxOut = Math.max(0, ...connectedNodes.map((node) => outDegree.get(node) || 0));
	const hubs = maxOut > 0
		? connectedNodes
			.filter((node) => (outDegree.get(node) || 0) === maxOut)
			.sort((a, b) => {
				const priority = compareNodeArrangePriority(a, b);
				if (priority) return priority;

				const bd = (outDegree.get(b) || 0) - (outDegree.get(a) || 0);
				if (bd !== 0) return bd;
				const bi = (inDegree.get(b) || 0) - (inDegree.get(a) || 0);
				if (bi !== 0) return bi;
				return compareNodePositionOnly(a, b);
			})
		: [];

	const result = [];
	const seen = new Set();
	for (const node of [...outputs, ...hubs]) {
		if (!node || seen.has(node)) continue;
		seen.add(node);
		result.push(node);
	}

	return result.length ? result : [connectedNodes[0]];
}

function calculateSmartFocusData(normalNodes, focusNodes, forward, backward) {
	const normalSet = new Set(normalNodes);
	const distance = new Map();
	const owner = new Map();
	const queue = [];

	for (let i = 0; i < focusNodes.length; i++) {
		const node = focusNodes[i];
		if (!normalSet.has(node)) continue;
		distance.set(node, 0);
		owner.set(node, i);
		queue.push(node);
	}

	while (queue.length > 0) {
		const node = queue.shift();
		const d = distance.get(node) || 0;
		const neighbors = [
			...Array.from(backward.get(node) || []),
			...Array.from(forward.get(node) || []),
		].filter((item) => normalSet.has(item));

		neighbors.sort((a, b) => {
			const priority = compareNodeArrangePriority(a, b);
			if (priority) return priority;

			const ai = getFirstLinkedSlotIndex(a, backward, forward);
			const bi = getFirstLinkedSlotIndex(b, backward, forward);
			if (ai !== bi) return ai - bi;
			const ay = getNodeY(a);
			const by = getNodeY(b);
			if (ay !== by) return ay - by;
			return compareNodePositionOnly(a, b);
		});

		for (const next of neighbors) {
			if (distance.has(next)) continue;
			distance.set(next, d + 1);
			owner.set(next, owner.get(node) || 0);
			queue.push(next);
		}
	}

	return { distance, owner };
}

function calculateSmartYHints(normalNodes, focusNodes, forward, backward, spacing = DEFAULT_SPACING) {
	const { distance, owner } = calculateSmartFocusData(normalNodes, focusNodes, forward, backward);
	const rowGapMagnitude = Math.abs(getRowGap(spacing));
	const focusGap = roundLayoutGap(rowGapMagnitude * 7);
	const yHints = new Map();
	const focusIndex = new Map();

	for (let i = 0; i < focusNodes.length; i++) {
		focusIndex.set(focusNodes[i], i);
	}

	const avgOriginalY = normalNodes.reduce((sum, node) => sum + getNodeY(node), 0) / Math.max(1, normalNodes.length);
	const focusCount = Math.max(1, focusNodes.length);

	for (const node of normalNodes) {
		const ownerIndex = owner.has(node) ? owner.get(node) : Math.floor(focusCount / 2);
		const baseY = (ownerIndex - (focusCount - 1) / 2) * focusGap;
		const dist = distance.has(node) ? distance.get(node) : focusCount;
		const originalBias = Math.max(-focusGap * 0.45, Math.min(focusGap * 0.45, (getNodeY(node) - avgOriginalY) * 0.18));
		const focusBias = focusIndex.has(node) ? 0 : Math.min(focusGap * 0.5, dist * rowGapMagnitude * 0.35);
		yHints.set(node, baseY + originalBias + focusBias);
	}

	for (let iter = 0; iter < 5; iter++) {
		const nextHints = new Map(yHints);

		for (const node of normalNodes) {
			if (focusIndex.has(node)) continue;
			const neighbors = [
				...Array.from(backward.get(node) || []),
				...Array.from(forward.get(node) || []),
			].filter((item) => yHints.has(item));
			if (!neighbors.length) continue;

			const avg = neighbors.reduce((sum, item) => sum + (yHints.get(item) || 0), 0) / neighbors.length;
			const old = yHints.get(node) || 0;
			nextHints.set(node, old * 0.35 + avg * 0.65);
		}

		for (const [node, value] of nextHints.entries()) {
			yHints.set(node, value);
		}
	}

	return yHints;
}

function sortSmartPortSiblings(anchor, nodes, direction, forward, backward) {
	return [...nodes].sort((a, b) => {
		const priority = compareNodeArrangePriority(a, b);
		if (priority) return priority;

		const ao = getInterfaceOrder(anchor, a, direction);
		const bo = getInterfaceOrder(anchor, b, direction);
		if (ao !== bo) return ao - bo;

		const ay = Number(getNodeY(a) || 0);
		const by = Number(getNodeY(b) || 0);
		if (ay !== by) return ay - by;

		const ai = getFirstLinkedSlotIndex(a, backward, forward);
		const bi = getFirstLinkedSlotIndex(b, backward, forward);
		if (ai !== bi) return ai - bi;

		return compareNodePositionOnly(a, b);
	});
}

function getSmartPortOrderHint(node, yHints, forward, backward, spacing = DEFAULT_SPACING) {
	const branchStep = Math.max(24, Math.abs(getRowGap(spacing)) * 2);
	const signals = [];

	for (const parent of Array.from(backward.get(node) || [])) {
		const siblings = sortSmartPortSiblings(parent, Array.from(forward.get(parent) || []), 1, forward, backward);
		if (siblings.length <= 1) continue;

		const index = siblings.indexOf(node);
		if (index < 0) continue;

		const baseY = Number(yHints.get(parent) ?? getNodeY(parent) ?? 0);
		signals.push(baseY + (index - (siblings.length - 1) / 2) * branchStep);
	}

	for (const child of Array.from(forward.get(node) || [])) {
		const siblings = sortSmartPortSiblings(child, Array.from(backward.get(child) || []), -1, forward, backward);
		if (siblings.length <= 1) continue;

		const index = siblings.indexOf(node);
		if (index < 0) continue;

		const baseY = Number(yHints.get(child) ?? getNodeY(child) ?? 0);
		signals.push(baseY + (index - (siblings.length - 1) / 2) * branchStep);
	}

	if (!signals.length) return null;
	return signals.reduce((sum, value) => sum + value, 0) / signals.length;
}

function getSmartPortSortKey(node, forward, backward) {
	const signals = [];

	for (const child of Array.from(forward.get(node) || [])) {
		const siblings = sortSmartPortSiblings(child, Array.from(backward.get(child) || []), -1, forward, backward);
		const index = siblings.indexOf(node);
		if (siblings.length > 1 && index >= 0) {
			signals.push(index * 1000 + getInterfaceOrder(child, node, -1));
		}
	}

	for (const parent of Array.from(backward.get(node) || [])) {
		const siblings = sortSmartPortSiblings(parent, Array.from(forward.get(parent) || []), 1, forward, backward);
		const index = siblings.indexOf(node);
		if (siblings.length > 1 && index >= 0) {
			signals.push(index * 1000 + getInterfaceOrder(parent, node, 1));
		}
	}

	if (!signals.length) return null;
	return signals.reduce((sum, value) => sum + value, 0) / signals.length;
}

function applySmartPortOrderHints(normalNodes, yHints, forward, backward, spacing = DEFAULT_SPACING) {
	for (let iter = 0; iter < 6; iter++) {
		const nextHints = new Map(yHints);

		for (const node of normalNodes) {
			const portHint = getSmartPortOrderHint(node, yHints, forward, backward, spacing);
			if (portHint == null) continue;

			const old = Number(yHints.get(node) ?? getNodeY(node) ?? 0);
			nextHints.set(node, old * 0.06 + portHint * 0.94);
		}

		for (const [node, value] of nextHints.entries()) {
			yHints.set(node, value);
		}
	}

	return yHints;
}

function getSmartColumnGap(spacing = DEFAULT_SPACING) {
	return roundLayoutGap(getColumnGap(spacing) * 1.75);
}

function calculateSmartXPositions(layerGroups, spacing = DEFAULT_SPACING) {
	const levels = Array.from(layerGroups.keys()).sort((a, b) => a - b);
	const maxWidthByLevel = getMaxNodeWidthByLevel(layerGroups);
	const xByLevel = new Map();
	const colGap = getSmartColumnGap(spacing);
	let currentX = 0;

	for (const level of levels) {
		xByLevel.set(level, currentX);
		currentX += (maxWidthByLevel.get(level) || MIN_LAYOUT_NODE_WIDTH) + colGap;
	}

	return xByLevel;
}

function sortSmartLayer(nodes, yHints, forward, backward, inDegree, outDegree) {
	nodes.sort((a, b) => {
		const priority = compareNodeArrangePriority(a, b);
		if (priority) return priority;

		const pa = getSmartPortSortKey(a, forward, backward);
		const pb = getSmartPortSortKey(b, forward, backward);
		if (pa != null && pb != null && Math.abs(pa - pb) > 1) return pa - pb;
		if (pa != null && pb == null) return -1;
		if (pa == null && pb != null) return 1;

		const ay = Number(yHints.get(a) ?? getNodeY(a));
		const by = Number(yHints.get(b) ?? getNodeY(b));
		if (Math.abs(ay - by) > 1) return ay - by;

		const degreeA = (inDegree.get(a) || 0) + (outDegree.get(a) || 0);
		const degreeB = (inDegree.get(b) || 0) + (outDegree.get(b) || 0);
		if (degreeA !== degreeB) return degreeB - degreeA;

		const ai = getFirstLinkedSlotIndex(a, backward, forward);
		const bi = getFirstLinkedSlotIndex(b, backward, forward);
		if (ai !== bi) return ai - bi;

		const oy = getNodeY(a) - getNodeY(b);
		if (Math.abs(oy) > 8) return oy;
		return compareNodePositionOnly(a, b);
	});
}

function placeSmartLayeredNodes(layerGroups, xByLevel, yHints, forward, backward, inDegree, outDegree, spacing = DEFAULT_SPACING) {
	const levels = Array.from(layerGroups.keys()).sort((a, b) => a - b);
	const rowGap = roundLayoutGap(getRowGap(spacing) * 4);

	for (const level of levels) {
		const layer = layerGroups.get(level) || [];
		if (!layer.length) continue;

		sortSmartLayer(layer, yHints, forward, backward, inDegree, outDegree);
		const x = xByLevel.get(level) || 0;
		let lastBottom = -Infinity;

		for (const node of layer) {
			const preferredTop = Math.round((yHints.get(node) || 0) - getNodeHeight(node) / 2);
			const y = Math.max(preferredTop, lastBottom + rowGap);
			setNodePosition(node, x, y);
			lastBottom = y + getNodeHeight(node);
		}

		const bounds = getBoundsForNodes(layer, 0);
		if (bounds) {
			const centerOffset = Math.round(bounds.y + bounds.height / 2);
			moveNodesBy(layer, 0, -centerOffset);
		}
	}
}

function getPureSerialOrder(normalNodes, forward, inDegree, outDegree) {
	if (normalNodes.length <= 1) return normalNodes.length ? [...normalNodes] : null;

	for (const node of normalNodes) {
		if ((inDegree.get(node) || 0) > 1 || (outDegree.get(node) || 0) > 1) {
			return null;
		}
	}

	const sources = normalNodes.filter((node) => (inDegree.get(node) || 0) === 0);
	const sinks = normalNodes.filter((node) => (outDegree.get(node) || 0) === 0);
	if (sources.length !== 1 || sinks.length !== 1) return null;

	const order = [];
	const visited = new Set();
	let current = sources[0];

	while (current && !visited.has(current)) {
		order.push(current);
		visited.add(current);
		const nextNodes = Array.from(forward.get(current) || []).filter((node) => !visited.has(node));
		current = nextNodes[0] || null;
	}

	return order.length === normalNodes.length ? order : null;
}

function arrangeSmartSerialChain(order, spacing = DEFAULT_SPACING) {
	const rowGap = roundLayoutGap(getRowGap(spacing) * 5);
	const xDrift = roundLayoutGap(getColumnGap(spacing) * 2);
	let x = 0;
	let y = 0;

	for (const node of order) {
		setNodePosition(node, x, y);
		x += xDrift;
		y += getNodeHeight(node) + rowGap;
	}
}

function enforceUpstreamLeftOfDownstream(normalNodes, forward, spacing = DEFAULT_SPACING, compact = false) {
	const nodes = filterValidNodes(normalNodes, false);
	if (!nodes.length) return;

	const minGap = compact ? getColumnGap(spacing) : getSmartColumnGap(spacing);
	for (let iter = 0; iter < nodes.length + 4; iter++) {
		let changed = false;

		for (const upstream of nodes) {
			for (const downstream of Array.from(forward.get(upstream) || [])) {
				if (!downstream) continue;
				if (isPriorityArrangeNode(downstream)) continue;
				const requestedX = compact
					? getNodeX(upstream) + minGap
					: getNodeX(upstream) + getNodeWidth(upstream) + minGap;
				const minX = Math.max(getNodeX(upstream) + 1, requestedX);
				if (getNodeX(downstream) < minX) {
					setNodePosition(downstream, minX, getNodeY(downstream));
					changed = true;
				}
			}
		}

		if (!changed) break;
	}
}

function collectSmartConnectedComponents(normalNodes, forward, backward, inDegree, outDegree) {
	const normalSet = new Set(normalNodes);
	const visited = new Set();
	const components = [];

	for (const start of normalNodes) {
		if (!start || visited.has(start)) continue;

		const component = [];
		const queue = [start];
		visited.add(start);

		while (queue.length > 0) {
			const node = queue.shift();
			component.push(node);

			const neighbors = [
				...Array.from(forward.get(node) || []),
				...Array.from(backward.get(node) || []),
			].filter((item) => normalSet.has(item));

			for (const next of neighbors) {
				if (visited.has(next)) continue;
				visited.add(next);
				queue.push(next);
			}
		}

		components.push(component);
	}

	components.sort((a, b) => {
		const aPriority = a.some(isPriorityArrangeNode) ? 0 : 1;
		const bPriority = b.some(isPriorityArrangeNode) ? 0 : 1;
		if (aPriority !== bPriority) return aPriority - bPriority;

		const aMaxOut = Math.max(0, ...a.map((node) => outDegree.get(node) || 0));
		const bMaxOut = Math.max(0, ...b.map((node) => outDegree.get(node) || 0));
		if (aMaxOut !== bMaxOut) return bMaxOut - aMaxOut;

		const aOutputs = a.filter((node) => (outDegree.get(node) || 0) === 0 && (inDegree.get(node) || 0) > 0).length;
		const bOutputs = b.filter((node) => (outDegree.get(node) || 0) === 0 && (inDegree.get(node) || 0) > 0).length;
		if (aOutputs !== bOutputs) return bOutputs - aOutputs;

		const aEdges = a.reduce((sum, node) => sum + (outDegree.get(node) || 0), 0);
		const bEdges = b.reduce((sum, node) => sum + (outDegree.get(node) || 0), 0);
		if (aEdges !== bEdges) return bEdges - aEdges;
		if (a.length !== b.length) return b.length - a.length;

		return Math.min(...a.map(getNodeY)) - Math.min(...b.map(getNodeY));
	});

	return components;
}

function moveSmartComponentTo(component, x, y) {
	const bounds = getBoundsForNodes(component, 0);
	if (!bounds) return;
	moveNodesBy(component, Math.round(x - bounds.x), Math.round(y - bounds.y));
}

function placeSmartComponentsAroundCenter(components, spacing = DEFAULT_SPACING) {
	if (!components.length) return;

	const horizontalGap = Math.max(0, roundLayoutGap(getColumnGap(spacing) * 10));
	const verticalGap = Math.max(0, roundLayoutGap(getRowGap(spacing) * 10));
	moveSmartComponentTo(components[0], 0, 0);

	const sides = ["left", "right", "top", "bottom"];
	for (let i = 1; i < components.length; i++) {
		const component = components[i];
		const componentBounds = getBoundsForNodes(component, 0);
		const placedBounds = getBoundsForNodes(components.slice(0, i).flat(), 0);
		if (!componentBounds || !placedBounds) continue;

		const side = sides[(i - 1) % sides.length];
		const centerX = placedBounds.x + placedBounds.width / 2;
		const centerY = placedBounds.y + placedBounds.height / 2;
		let x = componentBounds.x;
		let y = componentBounds.y;

		if (side === "left") {
			x = placedBounds.x - horizontalGap - componentBounds.width;
			y = centerY - componentBounds.height / 2;
		} else if (side === "right") {
			x = placedBounds.right + horizontalGap;
			y = centerY - componentBounds.height / 2;
		} else if (side === "top") {
			x = centerX - componentBounds.width / 2;
			y = placedBounds.y - verticalGap - componentBounds.height;
		} else {
			x = centerX - componentBounds.width / 2;
			y = placedBounds.bottom + verticalGap;
		}

		moveSmartComponentTo(component, x, y);
	}
}

function arrangeSmartCentered(normalNodes, forward, backward, inDegree, outDegree, spacing = DEFAULT_SPACING) {
	const serialOrder = getPureSerialOrder(normalNodes, forward, inDegree, outDegree);
	if (serialOrder && !serialOrder.some(isPriorityArrangeNode)) {
		arrangeSmartSerialChain(serialOrder, spacing);
		return "serial";
	}

	const levels = calculateSourceLongestLevels(normalNodes, backward);
	forcePriorityNodesToLeadingLevel(levels, normalNodes, "min");
	const layerGroups = groupByLevel(normalNodes, levels);
	const focusNodes = getSmartFocusNodes(normalNodes, inDegree, outDegree);
	const yHints = calculateSmartYHints(normalNodes, focusNodes, forward, backward, spacing);
	applySmartPortOrderHints(normalNodes, yHints, forward, backward, spacing);
	const xByLevel = calculateSmartXPositions(layerGroups, spacing);

	placeSmartLayeredNodes(layerGroups, xByLevel, yHints, forward, backward, inDegree, outDegree, spacing);
	return "radial";
}

async function arrangeAuto(nodes, spacing = DEFAULT_SPACING, iterations = 10, relaxPower = 0.5, collisionAvoidance = true, respectConnections = true) {
	console.log("[GJJ_NodeArranger] Starting auto arrangement");

	const validNodes = filterValidNodes(nodes, false);
	const beforeBounds = getBoundsForNodes(validNodes, Math.max(getColumnGap(spacing), getRowGap(spacing)));

	if (!respectConnections) {
		await applyRelax(nodes, iterations, relaxPower, spacing, collisionAvoidance);
		refreshAfterArrange(nodes);
		fitView(nodes);
		console.log("[GJJ_NodeArranger] Auto arrangement completed");
		return;
	}

	const { connectedNodes, isolatedNodes } = splitNodesByIsolation(validNodes);
	const {
		normalNodes,
		rerouteNodes,
		forward,
		backward,
		inDegree,
		outDegree,
	} = buildConnectionGraph(connectedNodes);

	if (normalNodes.length > 0) {
		const components = collectSmartConnectedComponents(normalNodes, forward, backward, inDegree, outDegree);

		for (const component of components) {
			const smartMode = arrangeSmartCentered(component, forward, backward, inDegree, outDegree, spacing);
			enforceUpstreamLeftOfDownstream(component, forward, spacing, smartMode === "serial");

			if (collisionAvoidance && smartMode !== "serial" && getColumnGap(spacing) >= 0 && getRowGap(spacing) >= 0) {
				resolveNodeOverlaps(component, Math.max(getColumnGap(spacing), getRowGap(spacing)));
				enforceUpstreamLeftOfDownstream(component, forward, spacing);
			}
		}

		placeSmartComponentsAroundCenter(components, spacing);
		placeRerouteNodes(rerouteNodes, normalNodes);
	}

	placeStandaloneIsolatedNodes(isolatedNodes, normalNodes, "row", spacing);
	finalizeArrangementPosition(validNodes, beforeBounds, getColumnGap(spacing), getRowGap(spacing));
	refreshAfterArrange(validNodes);
	fitView(validNodes);

	await new Promise((resolve) => setTimeout(resolve, 0));

	console.log("[GJJ_NodeArranger] Auto arrangement completed");
}

async function arrangeNodes(
	mode = "auto",
	spacing = DEFAULT_SPACING,
	iterations = 10,
	relaxPower = 0.5,
	collisionAvoidance = true,
	respectConnections = true,
	selectedOnly = false
) {
	const validNodes = getGraphNodesForArrange(selectedOnly);
	if (validNodes.length === 0) return;

	LAST_ARRANGE_MODE = mode;
	showArrangeModeToast(mode, selectedOnly);
	if (tryArrangeSelectedSetGetBranch(mode, spacing, selectedOnly)) {
		return;
	}
	const selectedNodes = getSelectedGraphNodes();
	const anchorNode = selectedOnly && selectedNodes.length === 1
		? selectedNodes[0]
		: (selectedOnly && validNodes.length === 1 ? validNodes[0] : null);
	if (anchorNode) {
		LAST_ARRANGE_MODE = mode;
		console.log(`[GJJ_NodeArranger] 单节点模式: ${getNodeTitleForLayout(anchorNode)}, mode=${mode}`);
		arrangeCenteredAroundAnchor(anchorNode, spacing, mode);
		return;
	}

	const beforeBounds = getBoundsForNodes(validNodes, Math.max(getColumnGap(spacing), getRowGap(spacing)));
	console.log(`[GJJ_NodeArranger] arrangeNodes mode=${mode}, nodes=${validNodes.length}, scope=${selectedOnly ? "selected" : "all"}`);

	switch (mode) {
		case "horizontal":
			arrangeHorizontal(validNodes, spacing);
			break;

		case "vertical":
			arrangeVertical(validNodes, spacing);
			break;

		case "grid":
			arrangeGrid(validNodes, spacing);
			break;

		case TOPO_SORT_MODES.TOPO_MAIN_PATH:
		case TOPO_SORT_MODES.TOPO_OUTPUT_ANCHOR:
		case TOPO_SORT_MODES.TOPO_COMPACT:
		case TOPO_SORT_MODES.TOPO_BRANCH:
		case TOPO_SORT_MODES.TOPO_ORIGINAL_Y:
			await arrangeTopological(validNodes, spacing, mode);
			break;

		case "topological":
			await arrangeTopological(validNodes, spacing, TOPO_SORT_MODES.TOPO_MAIN_PATH);
			break;

		case "auto":
		default:
			await arrangeAuto(validNodes, spacing, iterations, relaxPower, collisionAvoidance, respectConnections);
			break;
	}

	if (["horizontal", "vertical", "grid"].includes(mode)) {
		finalizeArrangementPosition(validNodes, beforeBounds, getColumnGap(spacing), getRowGap(spacing));
	}

	refreshAfterArrange(validNodes);
	fitView(validNodes);
}

function arrangeTopologicalFromGraph(sortMode = TOPO_SORT_MODES.TOPO_MAIN_PATH, selectedOnly = false, spacing = DEFAULT_SPACING) {
	const validNodes = getGraphNodesForArrange(selectedOnly);
	if (validNodes.length === 0) return;
	LAST_ARRANGE_MODE = sortMode;
	showArrangeModeToast(sortMode, selectedOnly);
	if (tryArrangeSelectedSetGetBranch(sortMode, spacing, selectedOnly)) {
		return true;
	}
	const selectedNodes = getSelectedGraphNodes();
	const anchorNode = selectedOnly && selectedNodes.length === 1
		? selectedNodes[0]
		: (selectedOnly && validNodes.length === 1 ? validNodes[0] : null);
	if (anchorNode) {
		LAST_ARRANGE_MODE = sortMode;
		console.log(`[GJJ_NodeArranger] 单节点拓扑模式: ${getNodeTitleForLayout(anchorNode)}, mode=${sortMode}`);
		return arrangeCenteredAroundAnchor(anchorNode, spacing, sortMode);
	}
	return arrangeTopological(validNodes, spacing, sortMode);
}

const LAYOUT_ARRANGE_ACTIONS = new Set([
	"auto",
	"horizontal",
	"vertical",
	"grid",
	TOPO_SORT_MODES.TOPO_MAIN_PATH,
	TOPO_SORT_MODES.TOPO_OUTPUT_ANCHOR,
	TOPO_SORT_MODES.TOPO_COMPACT,
	TOPO_SORT_MODES.TOPO_BRANCH,
	TOPO_SORT_MODES.TOPO_ORIGINAL_Y,
]);

function getEffectiveArrangeSpacing(spacing) {
	const value = Number(spacing);
	return Number.isFinite(value) ? value : DEFAULT_SPACING;
}

function isLayoutArrangeAction(action) {
	return LAYOUT_ARRANGE_ACTIONS.has(action);
}

function captureArrangementPositionSnapshot(nodes = []) {
	const snapshot = new Map();
	for (const node of uniqueNodes(filterValidNodes(nodes, false))) {
		snapshot.set(node, {
			x: getNodeX(node),
			y: getNodeY(node),
		});
	}
	return snapshot;
}

function getArrangementMovementStats(snapshot, nodes = [], threshold = 1) {
	const targetNodes = uniqueNodes(filterValidNodes(nodes, false));
	let movedCount = 0;
	let totalDistance = 0;
	let maxDistance = 0;

	for (const node of targetNodes) {
		const before = snapshot.get(node);
		if (!before) {
			movedCount++;
			continue;
		}
		const dx = Math.abs(getNodeX(node) - before.x);
		const dy = Math.abs(getNodeY(node) - before.y);
		const distance = dx + dy;
		if (dx > threshold || dy > threshold) {
			movedCount++;
			totalDistance += distance;
			maxDistance = Math.max(maxDistance, distance);
		}
	}

	return {
		nodeCount: targetNodes.length,
		movedCount,
		totalDistance,
		maxDistance,
	};
}

function arrangementProducedMeaningfulMovement(stats) {
	if (!stats || stats.nodeCount <= 1) return Boolean(stats?.movedCount);
	const minimumMoved = Math.max(2, Math.ceil(stats.nodeCount * 0.1));
	return stats.movedCount >= minimumMoved && stats.totalDistance >= minimumMoved * 8;
}

function beginArrangeGraphChange() {
	const graphs = new Set([app.graph, app.canvas?.graph].filter(Boolean));
	for (const graph of graphs) {
		try { graph.beforeChange?.(); } catch (_) {}
	}
}

function finishArrangeGraphChange() {
	const graphs = new Set([app.graph, app.canvas?.graph].filter(Boolean));
	for (const graph of graphs) {
		try { graph.afterChange?.(); } catch (_) {}
		try { graph.change?.(); } catch (_) {}
	}
	flushArrangeCanvasDraw();
}

function waitForArrangementTick() {
	return new Promise((resolve) => {
		const done = () => setTimeout(resolve, 0);
		if (typeof globalThis.requestAnimationFrame === "function") {
			globalThis.requestAnimationFrame(done);
		} else {
			done();
		}
	});
}

function arrangeFallbackLayered(validNodes, spacing = DEFAULT_SPACING, sortMode = TOPO_SORT_MODES.TOPO_MAIN_PATH) {
	const {
		normalNodes,
		rerouteNodes,
		forward,
		backward,
		inDegree,
		outDegree,
	} = buildConnectionGraph(validNodes);

	if (normalNodes.length === 0) {
		placeRerouteNodes(rerouteNodes, []);
		return;
	}

	const colGap = getColumnGap(spacing);
	const rowGap = getRowGap(spacing);
	const gap = Math.max(colGap, rowGap);
	const isolatedNodes = separateIsolatedNodes(normalNodes, inDegree, outDegree);
	const isolatedSet = new Set(isolatedNodes);
	const connectedNormalNodes = normalNodes.filter((node) => !isolatedSet.has(node));

	if (connectedNormalNodes.length > 0) {
		const useSinkLevels = sortMode === TOPO_SORT_MODES.TOPO_OUTPUT_ANCHOR;
		const levels = useSinkLevels
			? calculateSinkLongestLevels(connectedNormalNodes, forward)
			: calculateSourceLongestLevels(connectedNormalNodes, backward);
		forcePriorityNodesToLeadingLevel(levels, connectedNormalNodes, useSinkLevels ? "max" : "min");

		const layerGroups = groupByLevel(connectedNormalNodes, levels);
		const sortStrategy = sortMode === TOPO_SORT_MODES.TOPO_BRANCH
			? "branch"
			: (sortMode === TOPO_SORT_MODES.TOPO_ORIGINAL_Y ? "originalY" : "barycenter");
		sortLayerGroups(layerGroups, levels, forward, backward, sortStrategy);

		const config = getTopoModeConfig(sortMode);
		const xByLevel = calculateLevelXPositions(layerGroups, {
			...config,
			colWidth: Math.max(HORIZONTAL_SAFE_GAP, (Number(config.colWidth) || 0) + colGap),
		});
		placeLayeredNodes(layerGroups, xByLevel, {
			...config,
			rowGap: Math.max(VERTICAL_SAFE_GAP, (Number(config.rowGap) || 0) + rowGap),
		});

		if (colGap >= 0 && rowGap >= 0) {
			resolveNodeOverlaps(connectedNormalNodes, gap);
		}
	}

	placeStandaloneIsolatedNodes(
		isolatedNodes,
		connectedNormalNodes,
		sortMode === TOPO_SORT_MODES.TOPO_BRANCH ? "column" : "row",
		spacing
	);
	placeRerouteNodes(rerouteNodes, normalNodes);
}

function runForcedArrangeFallback(action, nodes = [], spacing = DEFAULT_SPACING) {
	const validNodes = filterValidNodes(nodes, false);
	if (validNodes.length === 0) return [];

	const beforeBounds = getBoundsForNodes(validNodes, Math.max(getColumnGap(spacing), getRowGap(spacing)));

	switch (action) {
		case "horizontal":
			arrangeHorizontal(validNodes, spacing);
			break;
		case "vertical":
			arrangeVertical(validNodes, spacing);
			break;
		case "grid":
			arrangeGrid(validNodes, spacing);
			break;
		case "auto":
			arrangeFallbackLayered(validNodes, spacing, TOPO_SORT_MODES.TOPO_MAIN_PATH);
			break;
		case TOPO_SORT_MODES.TOPO_MAIN_PATH:
		case TOPO_SORT_MODES.TOPO_OUTPUT_ANCHOR:
		case TOPO_SORT_MODES.TOPO_COMPACT:
		case TOPO_SORT_MODES.TOPO_BRANCH:
		case TOPO_SORT_MODES.TOPO_ORIGINAL_Y:
			arrangeFallbackLayered(validNodes, spacing, action);
			break;
		default:
			return [];
	}

	finalizeArrangementPosition(validNodes, beforeBounds, getColumnGap(spacing), getRowGap(spacing));
	refreshAfterArrange(validNodes);
	fitView(validNodes);
	return validNodes;
}

function runBaseArrangeAction(action, spacing = DEFAULT_SPACING, selectedOnly = false) {
	switch (action) {
		case "auto":
		case "horizontal":
		case "vertical":
		case "grid":
			return arrangeNodes(action, spacing, 10, 0.5, true, true, selectedOnly);
		case TOPO_SORT_MODES.TOPO_MAIN_PATH:
		case TOPO_SORT_MODES.TOPO_OUTPUT_ANCHOR:
		case TOPO_SORT_MODES.TOPO_COMPACT:
		case TOPO_SORT_MODES.TOPO_BRANCH:
		case TOPO_SORT_MODES.TOPO_ORIGINAL_Y:
			return arrangeTopologicalFromGraph(action, selectedOnly, spacing);
		case "collapse":
			return setAllNodesCollapsed(true, selectedOnly);
		case "expand":
			return setAllNodesCollapsed(false, selectedOnly);
		case "toggle-collapse":
			return toggleAllNodesCollapsed(selectedOnly);
		default:
			return undefined;
	}
}

async function runLayoutArrangeAction(action, spacing = DEFAULT_SPACING, selectedOnly = false, options = {}) {
	const validNodes = getGraphNodesForArrange(selectedOnly);
	if (action !== "grid") {
		clearGridPosterSizeLocks(validNodes);
		clearGridPosterFinalizeContext();
	}
	const beforeSnapshot = captureArrangementPositionSnapshot(validNodes);
	let result;

	beginArrangeGraphChange();
	try {
		result = await runBaseArrangeAction(action, spacing, selectedOnly);
	} catch (error) {
		console.warn(`[GJJ_NodeArranger] 排列执行失败，尝试强制重排：${action}`, error);
	} finally {
		finishArrangeGraphChange();
	}

	await waitForArrangementTick();

	const currentNodes = getGraphNodesForArrange(selectedOnly);
	const movement = getArrangementMovementStats(beforeSnapshot, currentNodes);
	const shouldForce = options.forceIfUnchanged !== false
		&& currentNodes.length > 1
		&& !arrangementProducedMeaningfulMovement(movement);

	if (shouldForce) {
		console.warn(
			`[GJJ_NodeArranger] ${action} 有效位移不足，执行强制可见重排`,
			`moved=${movement.movedCount}/${movement.nodeCount}`,
			`distance=${movement.totalDistance}`
		);
		beginArrangeGraphChange();
		try {
			result = runForcedArrangeFallback(action, currentNodes, spacing) || result;
		} finally {
			finishArrangeGraphChange();
		}
		await waitForArrangementTick();
	}

	return result;
}

function runArrangeAction(action, spacing = DEFAULT_SPACING, options = {}) {
	const selectedOnly = typeof options?.selectedOnly === "boolean"
		? options.selectedOnly
		: shouldUseSelectedOnly();
	const effectiveSpacing = getEffectiveArrangeSpacing(spacing);
	if (isLayoutArrangeAction(action)) {
		return runLayoutArrangeAction(action, effectiveSpacing, selectedOnly, options);
	}
	return runBaseArrangeAction(action, effectiveSpacing, selectedOnly);
}

function createMenuCallback(mode) {
	return () => runArrangeAction(mode, DEFAULT_SPACING);
}

function addContextMenuItems() {
	if (!app.canvas || app.canvas.__gjjNodeArrangerMenuPatched) return;
	if (!gjjSettingEnabled(LEGACY_CONTEXT_MENU_SETTING, false)) return;

	const originalGetCanvasMenuOptions = app.canvas.getCanvasMenuOptions;

	app.canvas.getCanvasMenuOptions = function (...args) {
		const options = originalGetCanvasMenuOptions
			? originalGetCanvasMenuOptions.apply(this, args)
			: [];

		if (!gjjSettingEnabled(SETTING_CONTEXT_MENU_ENABLED, true)) {
			return options;
		}

		options.push(null);

		options.push({
			content: "📐 GJJ 节点排列",
			has_submenu: true,
			submenu: {
				options: [
					{
						content: "🔄 智能自动排列",
						callback: createMenuCallback("auto"),
					},
					null,
					{
						content: "🔢 拓扑排序：主链路",
						callback: createMenuCallback(TOPO_SORT_MODES.TOPO_MAIN_PATH),
					},
					{
						content: "🎯 拓扑排序：输出锚定",
						callback: createMenuCallback(TOPO_SORT_MODES.TOPO_OUTPUT_ANCHOR),
					},
					{
						content: "🧩 拓扑排序：紧凑层级",
						callback: createMenuCallback(TOPO_SORT_MODES.TOPO_COMPACT),
					},
					{
						content: "🌿 拓扑排序：分支优先",
						callback: createMenuCallback(TOPO_SORT_MODES.TOPO_BRANCH),
					},
					{
						content: "📦 全部折叠",
						callback: createMenuCallback("collapse"),
					},
					{
						content: "📭 全部打开",
						callback: createMenuCallback("expand"),
					},
					{
						content: "🔁 全部折叠 / 全部打开",
						callback: createMenuCallback("toggle-collapse"),
					},
					{
						content: "↕️ 拓扑排序：保持上下",
						callback: createMenuCallback(TOPO_SORT_MODES.TOPO_ORIGINAL_Y),
					},
					null,
					{
						content: "➡️ 水平排列",
						callback: createMenuCallback("horizontal"),
					},
					{
						content: "⬇️ 垂直排列",
						callback: createMenuCallback("vertical"),
					},
					{
						content: "⊞ 正方形预览排版",
						callback: createMenuCallback("grid"),
					},
				],
			},
		});

		return options;
	};

	app.canvas.__gjjNodeArrangerMenuPatched = true;
}

function buttonStyle() {
	return [
		"padding: 6px 12px",
		"border-radius: 4px",
		"border: 1px solid #41535b",
		"background: #1a252b",
		"color: #dce7e2",
		"cursor: pointer",
		"font-size: 12px",
		"line-height: 1.2",
		"transition: all 0.2s",
	].join(";");
}

function installHoverStyle(el) {
	el.addEventListener("mouseenter", () => {
		el.style.background = "#2a353b";
	});
	el.addEventListener("mouseleave", () => {
		el.style.background = "#1a252b";
	});
}

function addTopBarButtons() {
	setTimeout(() => {
		if (document.querySelector("[data-gjj-node-arranger-toolbar='1']")) return;

		let toolbar = document.querySelector(".comfy-menu-extra-buttons");

		if (!toolbar) {
			toolbar = document.createElement("div");
			toolbar.className = "comfy-menu-extra-buttons";
			toolbar.style.cssText = [
				"display: flex",
				"gap: 8px",
				"padding: 8px",
				"flex-wrap: wrap",
				"align-items: center",
			].join(";");

			const menu = document.querySelector(".comfy-menu");
			if (menu) {
				menu.appendChild(toolbar);
			} else {
				document.body.appendChild(toolbar);
			}
		}

		const group = document.createElement("div");
		group.dataset.gjjNodeArrangerToolbar = "1";
		group.style.cssText = [
			"display: flex",
			"gap: 6px",
			"align-items: center",
			"flex-wrap: wrap",
		].join(";");
		const runTopbarAction = (action) => runArrangeAction(action, DEFAULT_SPACING, { selectedOnly: false });

		const arrangeBtn = document.createElement("button");
		arrangeBtn.textContent = "📐 排列节点";
		arrangeBtn.title = "智能排列全部节点";
		arrangeBtn.style.cssText = buttonStyle();
		installHoverStyle(arrangeBtn);
		arrangeBtn.addEventListener("click", () => {
			runTopbarAction("auto");
		});
		group.appendChild(arrangeBtn);

		const topoBtn = document.createElement("button");
		topoBtn.textContent = "🔢 拓扑排序";
		topoBtn.title = "默认使用拓扑主链路排列全部节点";
		topoBtn.style.cssText = buttonStyle();
		installHoverStyle(topoBtn);
		topoBtn.addEventListener("click", () => {
			runTopbarAction(TOPO_SORT_MODES.TOPO_MAIN_PATH);
		});
		group.appendChild(topoBtn);

		const topoSelect = document.createElement("select");
		topoSelect.title = "选择拓扑排序方式，切换后会立即执行";
		topoSelect.style.cssText = [
			"padding: 6px 8px",
			"border-radius: 4px",
			"border: 1px solid #41535b",
			"background: #1a252b",
			"color: #dce7e2",
			"cursor: pointer",
			"font-size: 12px",
			"max-width: 150px",
		].join(";");

		for (const item of TOPO_SORT_MODE_LIST) {
			const option = document.createElement("option");
			option.value = item.key;
			option.textContent = item.label.replace(/^\S+\s*/, "");
			option.title = item.title;
			topoSelect.appendChild(option);
		}

		topoSelect.addEventListener("change", () => {
			runTopbarAction(topoSelect.value);
		});

		group.appendChild(topoSelect);

		const allActionsSelect = document.createElement("select");
		allActionsSelect.title = "全部排列、折叠和打开动作，始终作用全部节点";
		allActionsSelect.style.cssText = topoSelect.style.cssText;
		const allActions = [
			["", "📋 全部动作"],
			["auto", "🔄 智能自动排列"],
			[TOPO_SORT_MODES.TOPO_MAIN_PATH, "🔢 拓扑：主链路"],
			[TOPO_SORT_MODES.TOPO_OUTPUT_ANCHOR, "🎯 拓扑：输出锚定"],
			[TOPO_SORT_MODES.TOPO_COMPACT, "🧩 拓扑：紧凑层级"],
			[TOPO_SORT_MODES.TOPO_BRANCH, "🌿 拓扑：分支优先"],
			[TOPO_SORT_MODES.TOPO_ORIGINAL_Y, "↕️ 拓扑：保持上下"],
			["horizontal", "➡️ 水平排列"],
			["vertical", "⬇️ 垂直排列"],
			["grid", "⊞ 正方形预览排版"],
			["collapse", "📦 全部折叠"],
			["expand", "📭 全部打开"],
			["toggle-collapse", "🔁 折叠 / 打开切换"],
		];
		for (const [value, label] of allActions) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = label;
			allActionsSelect.appendChild(option);
		}
		allActionsSelect.addEventListener("change", () => {
			const action = allActionsSelect.value;
			allActionsSelect.value = "";
			if (action) runTopbarAction(action);
		});
		group.appendChild(allActionsSelect);

		const collapseBtn = document.createElement("button");
		collapseBtn.textContent = "📦 折叠/打开";
		collapseBtn.title = "折叠/打开全部节点";
		collapseBtn.style.cssText = buttonStyle();
		installHoverStyle(collapseBtn);
		collapseBtn.addEventListener("click", () => {
			runTopbarAction("toggle-collapse");
		});
		group.appendChild(collapseBtn);

		toolbar.appendChild(group);

	}, 1000);
}

const SHORTCUT_ARRANGE_MODES = [
	["auto", "智能排列"],
	[TOPO_SORT_MODES.TOPO_MAIN_PATH, "拓扑：主链路"],
	[TOPO_SORT_MODES.TOPO_OUTPUT_ANCHOR, "拓扑：输出锚定"],
	[TOPO_SORT_MODES.TOPO_COMPACT, "拓扑：紧凑层级"],
	[TOPO_SORT_MODES.TOPO_BRANCH, "拓扑：分支优先"],
	[TOPO_SORT_MODES.TOPO_ORIGINAL_Y, "拓扑：保持上下"],
	["horizontal", "水平排列"],
	["vertical", "垂直排列"],
	["grid", "正方形预览排版"],
];
let shortcutArrangeModeIndex = 0;

function runNextShortcutArrangement() {
	const [mode, name] = SHORTCUT_ARRANGE_MODES[shortcutArrangeModeIndex];
	console.log(`[GJJ_NodeArranger] 快捷键循环模式：${name}`);
	runArrangeAction(mode, DEFAULT_SPACING);
	shortcutArrangeModeIndex = (shortcutArrangeModeIndex + 1) % SHORTCUT_ARRANGE_MODES.length;
}

function adjustGapAndRerun(axis, delta) {
	adjustLayoutGap(axis, delta);
	rerunLastArrangement();
}

function patchGraphSerializeIntegerPosition() {
	if (!app.graph || app.graph.__gjjNodeArrangerSerializePatched) return;
	if (typeof app.graph.serialize !== "function") return;

	const originalSerialize = app.graph.serialize.bind(app.graph);

	app.graph.serialize = function (...args) {
		const data = originalSerialize(...args);

		if (Array.isArray(data?.nodes)) {
			for (const node of data.nodes) {
				if (Array.isArray(node.pos)) {
					node.pos = [
						Math.round(Number(node.pos[0] || 0)),
						Math.round(Number(node.pos[1] || 0)),
					];
				}

				if (Array.isArray(node.size)) {
					node.size = [
						Math.round(Number(node.size[0] || 0)),
						Math.round(Number(node.size[1] || 0)),
					];
				}
			}
		}

		if (Array.isArray(data?.extra?.ds?.offset)) {
			data.extra.ds.offset = [
				Math.round(Number(data.extra.ds.offset[0] || 0)),
				Math.round(Number(data.extra.ds.offset[1] || 0)),
			];
		}

		return data;
	};

	app.graph.__gjjNodeArrangerSerializePatched = true;
}

function addButtonToArrangerNode(node) {
	setTimeout(() => {
		if (!node || node.__gjjNodeArrangerButtonAdded) return;

		const btn = document.createElement("button");
		btn.textContent = "📐 立即排列";
		btn.title = "执行智能排列";
		btn.style.cssText = [
			"width: 100%",
			"padding: 8px",
			"margin-top: 8px",
			"border-radius: 4px",
			"border: 1px solid #41535b",
			"background: #5aa8ff",
			"color: #fff",
			"cursor: pointer",
			"font-size: 12px",
			"font-weight: bold",
			"transition: all 0.2s",
		].join(";");

		btn.addEventListener("click", () => {
			runArrangeAction("auto");
		});

		btn.addEventListener("mouseenter", () => {
			btn.style.opacity = "0.85";
		});

		btn.addEventListener("mouseleave", () => {
			btn.style.opacity = "1";
		});

		const widgetElement = node.widgets?.[0]?.element;

		if (widgetElement?.parentNode) {
			widgetElement.parentNode.appendChild(btn);
			node.__gjjNodeArrangerButtonAdded = true;
		}
	}, 100);
}

app.registerExtension({
	name: "Comfy.GJJ.NodeArranger",
	commands: [
		{ id: "GJJ.NodeArranger.SmartCycle", label: "GJJ：智能/循环排列节点", function: runNextShortcutArrangement },
		{ id: "GJJ.NodeArranger.TopoMain", label: "GJJ：按主链路拓扑排列节点", function: () => runArrangeAction(TOPO_SORT_MODES.TOPO_MAIN_PATH) },
		{ id: "GJJ.NodeArranger.Horizontal", label: "GJJ：水平排列节点", function: () => runArrangeAction("horizontal") },
		{ id: "GJJ.NodeArranger.Grid", label: "GJJ：正方形预览排版", function: () => runArrangeAction("grid") },
		{ id: "GJJ.NodeArranger.ToggleCollapse", label: "GJJ：折叠/展开选中节点", function: () => runArrangeAction("toggle-collapse") },
		{ id: "GJJ.NodeArranger.GapLeft", label: "GJJ：减小水平排列间距", function: () => adjustGapAndRerun("column", -LAYOUT_GAP_STEP) },
		{ id: "GJJ.NodeArranger.GapRight", label: "GJJ：增大水平排列间距", function: () => adjustGapAndRerun("column", LAYOUT_GAP_STEP) },
		{ id: "GJJ.NodeArranger.GapUp", label: "GJJ：减小垂直排列间距", function: () => adjustGapAndRerun("row", -LAYOUT_GAP_STEP) },
		{ id: "GJJ.NodeArranger.GapDown", label: "GJJ：增大垂直排列间距", function: () => adjustGapAndRerun("row", LAYOUT_GAP_STEP) },
	],
	keybindings: [
		{ commandId: "GJJ.NodeArranger.SmartCycle", combo: { key: "a", ctrl: true, shift: true }, targetElementId: "graph-canvas" },
		{ commandId: "GJJ.NodeArranger.TopoMain", combo: { key: "t", ctrl: true, shift: true }, targetElementId: "graph-canvas" },
		{ commandId: "GJJ.NodeArranger.Horizontal", combo: { key: "h", ctrl: true, shift: true }, targetElementId: "graph-canvas" },
		{ commandId: "GJJ.NodeArranger.Grid", combo: { key: "g", ctrl: true, shift: true }, targetElementId: "graph-canvas" },
		{ commandId: "GJJ.NodeArranger.ToggleCollapse", combo: { key: "a", ctrl: true, alt: true }, targetElementId: "graph-canvas" },
		{ commandId: "GJJ.NodeArranger.GapLeft", combo: { key: "ArrowLeft", alt: true }, targetElementId: "graph-canvas" },
		{ commandId: "GJJ.NodeArranger.GapRight", combo: { key: "ArrowRight", alt: true }, targetElementId: "graph-canvas" },
		{ commandId: "GJJ.NodeArranger.GapUp", combo: { key: "ArrowUp", alt: true }, targetElementId: "graph-canvas" },
		{ commandId: "GJJ.NodeArranger.GapDown", combo: { key: "ArrowDown", alt: true }, targetElementId: "graph-canvas" },
	],

	async setup() {
		installFocusedNodeTracker();

		window.GJJ_NodeArranger = {
			arrangeNodes,
			runArrangeAction,

			arrangeAuto: (spacing = DEFAULT_SPACING, iterations = 10, relaxPower = 0.5) => {
				return arrangeNodes("auto", spacing, iterations, relaxPower, true, true, shouldUseSelectedOnly());
			},

			arrangeHorizontal: (spacing = DEFAULT_SPACING) => {
				return arrangeNodes("horizontal", spacing, 10, 0.5, true, true, shouldUseSelectedOnly());
			},

			arrangeVertical: (spacing = DEFAULT_SPACING) => {
				return arrangeNodes("vertical", spacing, 10, 0.5, true, true, shouldUseSelectedOnly());
			},

			arrangeGrid: (spacing = DEFAULT_SPACING) => {
				return arrangeNodes("grid", spacing, 10, 0.5, true, true, shouldUseSelectedOnly());
			},

			arrangeTopological: (spacing = DEFAULT_SPACING, sortMode = TOPO_SORT_MODES.TOPO_MAIN_PATH) => {
				return arrangeTopologicalFromGraph(sortMode, shouldUseSelectedOnly(), spacing);
			},

			arrangeTopoMainPath: (spacing = DEFAULT_SPACING) => {
				return arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_MAIN_PATH, shouldUseSelectedOnly(), spacing);
			},

			arrangeTopoOutputAnchor: (spacing = DEFAULT_SPACING) => {
				return arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_OUTPUT_ANCHOR, shouldUseSelectedOnly(), spacing);
			},

			arrangeTopoCompact: (spacing = DEFAULT_SPACING) => {
				return arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_COMPACT, shouldUseSelectedOnly(), spacing);
			},

			arrangeTopoBranch: (spacing = DEFAULT_SPACING) => {
				return arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_BRANCH, shouldUseSelectedOnly(), spacing);
			},

			collapseAllNodes: () => {
				return setAllNodesCollapsed(true, shouldUseSelectedOnly());
			},

			expandAllNodes: () => {
				return setAllNodesCollapsed(false, shouldUseSelectedOnly());
			},

			toggleAllNodesCollapsed: () => {
				return toggleAllNodesCollapsed(shouldUseSelectedOnly());
			},

			arrangeTopoOriginalY: (spacing = DEFAULT_SPACING) => {
				return arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_ORIGINAL_Y, shouldUseSelectedOnly(), spacing);
			},

			TOPO_SORT_MODES,
			TOPO_SORT_MODE_LIST,
		};

		addContextMenuItems();
		addTopBarButtons();
		patchGraphSerializeIntegerPosition();
	},

	async nodeCreated(node) {
		if (node?.comfyClass === NODE_NAME || node?.type === NODE_NAME) {
			addButtonToArrangerNode(node);
		}
	},
});
