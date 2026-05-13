/**
 * GJJ Node Arranger - ComfyUI 节点自动排列工具
 * 支持：
 * 1. 智能自动排列
 * 2. 多种拓扑排序
 * 3. 水平排列
 * 4. 垂直排列
 * 5. 网格排列
 * 6. 右键菜单
 * 7. 顶部工具栏
 * 8. 快捷键
 */

import { app } from "/scripts/app.js";

const NODE_NAME = "GJJ_NodeArranger";

const MOVE_UNIT = 1;

let DEFAULT_SPACING = 26;

const LAYOUT_GAP_STEP = 8;
const MIN_LAYOUT_GAP = 0;
const MAX_LAYOUT_GAP = 240;
let LAST_ARRANGE_MODE = "auto";

const MIN_NODE_WIDTH = 80;
const MIN_REROUTE_WIDTH = 24;
const COLLAPSED_NODE_WIDTH = 80;
const COLLAPSED_NODE_HEIGHT = 30;

// 节点本身仍然压到最低宽度，但排列时用一个“视觉宽度”防止标题/接口文字互相覆盖。
const MIN_LAYOUT_NODE_WIDTH = 168;
const MAX_LAYOUT_NODE_WIDTH = 340;
let HORIZONTAL_SAFE_GAP = 28;
let VERTICAL_SAFE_GAP = 18;

// 间距调节：想更松只改上面 3 个值：DEFAULT_SPACING / HORIZONTAL_SAFE_GAP / VERTICAL_SAFE_GAP。
// 节点真实宽度仍保持最小，布局计算会按 MIN_LAYOUT_NODE_WIDTH 预留视觉空间，避免互相覆盖。

// 智能作用范围：
// - 没有选择：作用全部
// - 全部选择：作用全部
// - 只有部分选择：只作用所选
function shouldUseSelectedOnly() {
	const nodes = filterValidNodes(getAllGraphNodes(), false);
	if (nodes.length === 0) return false;

	const selectedCount = nodes.reduce((count, node) => count + (node.selected ? 1 : 0), 0);
	return selectedCount > 0 && selectedCount < nodes.length;
}

function getSmartScopeLabel() {
	return shouldUseSelectedOnly() ? "部分选择：仅作用所选节点" : "未选择或全选：作用全部节点";
}

function clampInteger(value, min, max) {
	return Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
}

function getColumnGap(spacing = DEFAULT_SPACING) {
	return clampInteger(Math.max(HORIZONTAL_SAFE_GAP, spacing), MIN_LAYOUT_GAP, MAX_LAYOUT_GAP);
}

function getRowGap(spacing = DEFAULT_SPACING) {
	return clampInteger(Math.max(VERTICAL_SAFE_GAP, spacing), MIN_LAYOUT_GAP, MAX_LAYOUT_GAP);
}

function adjustLayoutGap(axis, delta) {
	const d = Math.round(Number(delta) || 0);
	if (axis === "column") {
		DEFAULT_SPACING = clampInteger(DEFAULT_SPACING + d, MIN_LAYOUT_GAP, MAX_LAYOUT_GAP);
		HORIZONTAL_SAFE_GAP = clampInteger(HORIZONTAL_SAFE_GAP + d, MIN_LAYOUT_GAP, MAX_LAYOUT_GAP);
		console.log(`[GJJ_NodeArranger] 列宽/横向间距: ${getColumnGap()}px`);
		return;
	}

	VERTICAL_SAFE_GAP = clampInteger(VERTICAL_SAFE_GAP + d, MIN_LAYOUT_GAP, MAX_LAYOUT_GAP);
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

	const titleWidth = measureTextWidthForLayout(getNodeTitleForLayout(node));
	const slotWidth = getLongestSlotTextWidth(node);
	const estimated = Math.max(
		MIN_LAYOUT_NODE_WIDTH,
		getStoredNodeWidth(node),
		titleWidth + 44,
		slotWidth + 72
	);

	return Math.min(MAX_LAYOUT_NODE_WIDTH, Math.round(estimated));
}

function getNodeHeight(node) {
	return Number(node?.size?.[1] || node?.size?.height || 120);
}

function getNodeX(node) {
	return Number(node?.pos?.[0] || 0);
}

function getNodeY(node) {
	return Number(node?.pos?.[1] || 0);
}

function isRerouteNode(node) {
	return !!node && REROUTE_TYPES.has(node.type);
}

function isRealNode(node) {
	return !!node && node.type !== "group";
}

function roundNodePosition(node) {
	if (!node || !Array.isArray(node.pos)) return;
	node.pos[0] = Math.round(node.pos[0]);
	node.pos[1] = Math.round(node.pos[1]);
}

function setNodePosition(node, x, y) {
	node.pos = [Math.round(x), Math.round(y)];
}

function setNodeSize(node, width, height = null) {
	if (!node) return;
	const w = Math.max(1, Math.round(Number(width || 1)));
	const currentH = getNodeHeight(node);
	const h = Math.max(1, Math.round(Number(height == null ? currentH : height)));

	if (Array.isArray(node.size)) {
		node.size[0] = w;
		node.size[1] = h;
	} else {
		node.size = [w, h];
	}
}

function shrinkNodeWidth(node) {
	if (!isRealNode(node)) return;
	const width = isRerouteNode(node) ? MIN_REROUTE_WIDTH : MIN_NODE_WIDTH;
	setNodeSize(node, width, null);
}

function shrinkNodeWidths(nodes) {
	for (const node of filterValidNodes(nodes, false)) {
		shrinkNodeWidth(node);
	}
}

function isNodeCollapsed(node) {
	return !!node?.flags?.collapsed;
}

function collapseNode(node) {
	if (!isRealNode(node)) return;
	if (!isNodeCollapsed(node)) {
		node.__gjjNodeArrangerExpandedHeight = Math.max(COLLAPSED_NODE_HEIGHT, Math.round(getNodeHeight(node)));
	}
	node.flags = node.flags || {};
	node.flags.collapsed = true;
	const width = isRerouteNode(node) ? MIN_REROUTE_WIDTH : COLLAPSED_NODE_WIDTH;
	setNodeSize(node, width, COLLAPSED_NODE_HEIGHT);
}

function expandNode(node) {
	if (!isRealNode(node)) return;
	node.flags = node.flags || {};
	node.flags.collapsed = false;
	const width = isRerouteNode(node) ? MIN_REROUTE_WIDTH : MIN_NODE_WIDTH;
	const height = Math.max(80, Math.round(Number(node.__gjjNodeArrangerExpandedHeight || 0)));
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
		if (selectedOnly && !node.selected) return false;
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
	for (const node of nodes) {
		roundNodePosition(node);
	}

	try {
		if (app.graph?.setDirtyCanvas) {
			app.graph.setDirtyCanvas(true, true);
		} else if (app.canvas?.setDirty) {
			app.canvas.setDirty(true, true);
		}
	} catch (error) {
		console.warn("[GJJ_NodeArranger] refresh failed:", error);
	}
}

function fitView(nodes = null) {
	try {
		const targetNodes = filterValidNodes(nodes || getAllGraphNodes(), false);
		refreshAfterArrange(targetNodes);

		// 不再临时改 selected，避免鼠标悬停/重绘时触发布局或选中状态异常。
		// 优先尝试 ComfyUI/LiteGraph 自带的全局适配视图能力。
		if (app.canvas?.fitView && typeof app.canvas.fitView === "function") {
			app.canvas.fitView();
			return;
		}

		// 退回到 ComfyUI 的“适配视图”快捷键。这里不修改任何节点状态。
		const keyEvent = new KeyboardEvent("keydown", {
			key: ".",
			code: "Period",
			keyCode: 190,
			which: 190,
			bubbles: true,
			cancelable: true,
		});
		document.dispatchEvent(keyEvent);
	} catch (error) {
		console.warn("[GJJ_NodeArranger] fit view failed:", error);
	}
}

function getAllGraphNodes() {
	return safeArray(app?.graph?._nodes);
}

function getLinkById(linkId) {
	if (!app?.graph?.links) return null;
	return app.graph.links[linkId] || null;
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
		if (!input?.link) continue;

		const link = getLinkById(input.link);
		if (!link) continue;

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
		if (!Array.isArray(output?.links) || output.links.length === 0) continue;

		for (const linkId of output.links) {
			const link = getLinkById(linkId);
			if (!link) continue;

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
		node.pos[0] += Math.round(offsetX);
		node.pos[1] += Math.round(offsetY);
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
			node.pos[0] += Math.round(offset.x);
			node.pos[1] += Math.round(offset.y);
			moved = true;
		}
	}

	return moved;
}

function arrangeHorizontal(nodes, spacing = DEFAULT_SPACING) {
	let currentX = 0;
	const startY = 0;

	const sorted = [...nodes].sort((a, b) => getNodeX(a) - getNodeX(b));

	for (const node of sorted) {
		setNodePosition(node, currentX, startY);
		currentX += getNodeWidth(node) + spacing;
	}
}

function arrangeVertical(nodes, spacing = DEFAULT_SPACING) {
	const startX = 0;
	let currentY = 0;

	const sorted = [...nodes].sort((a, b) => getNodeY(a) - getNodeY(b));

	for (const node of sorted) {
		setNodePosition(node, startX, currentY);
		currentY += getNodeHeight(node) + spacing;
	}
}

function arrangeGrid(nodes, spacing = DEFAULT_SPACING) {
	if (nodes.length === 0) return;

	const sorted = [...nodes].sort((a, b) => {
		const dy = getNodeY(a) - getNodeY(b);
		if (Math.abs(dy) > 50) return dy;
		return getNodeX(a) - getNodeX(b);
	});

	const cols = Math.ceil(Math.sqrt(sorted.length));
	const maxWidth = Math.max(...sorted.map(getNodeWidth));
	const maxHeight = Math.max(...sorted.map(getNodeHeight));

	let col = 0;
	let row = 0;

	for (const node of sorted) {
		setNodePosition(node, col * (maxWidth + spacing), row * (maxHeight + spacing));

		col++;
		if (col >= cols) {
			col = 0;
			row++;
		}
	}
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
		if (!input?.link) continue;
		const link = getLinkById(input.link);
		if (!link) continue;

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
		if (!Array.isArray(output?.links)) continue;

		for (const linkId of output.links) {
			const link = getLinkById(linkId);
			if (!link) continue;

			targets.push(...traceRealTargets(link.target_id, validSet, new Set(visited)));
		}
	}

	return targets;
}

function buildConnectionGraph(nodes) {
	const normalNodes = nodes.filter((node) => !isRerouteNode(node));
	const rerouteNodes = nodes.filter((node) => isRerouteNode(node));
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
			if (!Array.isArray(output?.links) || output.links.length === 0) continue;

			for (const linkId of output.links) {
				const link = getLinkById(linkId);
				if (!link) continue;

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
		nodes.sort((a, b) => {
			const dy = getNodeY(a) - getNodeY(b);
			if (Math.abs(dy) > 1) return dy;
			return getNodeX(a) - getNodeX(b);
		});
	}
}

function sortLayersByBranch(layerGroups, forward, backward) {
	for (const nodes of layerGroups.values()) {
		nodes.sort((a, b) => {
			const aOut = (forward.get(a)?.size || 0);
			const bOut = (forward.get(b)?.size || 0);
			if (aOut !== bOut) return bOut - aOut;

			const aIn = (backward.get(a)?.size || 0);
			const bIn = (backward.get(b)?.size || 0);
			if (aIn !== bIn) return bIn - aIn;

			return getNodeY(a) - getNodeY(b);
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

			nodes.sort((a, b) => bary.get(a) - bary.get(b));
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

			nodes.sort((a, b) => bary.get(a) - bary.get(b));
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

	isolatedNodes.sort((a, b) => getNodeY(a) - getNodeY(b));

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
			if (!input?.link) continue;

			const link = getLinkById(input.link);
			if (!link) continue;

			sourceNode = traceRealSource(link.origin_id, validSet);
			if (sourceNode) break;
		}

		for (const output of safeArray(reroute.outputs)) {
			if (!Array.isArray(output?.links)) continue;

			for (const linkId of output.links) {
				const link = getLinkById(linkId);
				if (!link) continue;

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


function getNodeTypeName(node) {
	return String(node?.comfyClass || node?.type || node?.constructor?.name || "").toLowerCase();
}

function getConnectedInputSlots(node) {
	return safeArray(node.inputs)
		.map((input, index) => ({ input, index }))
		.filter((item) => !!item.input?.link);
}

function getConnectedOutputSlots(node) {
	return safeArray(node.outputs)
		.map((output, index) => ({ output, index }))
		.filter((item) => Array.isArray(item.output?.links) && item.output.links.length > 0);
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
		const ai = getFirstLinkedSlotIndex(a, backward, forward);
		const bi = getFirstLinkedSlotIndex(b, backward, forward);
		if (ai !== bi) return ai - bi;

		const ay = getNodeY(a);
		const by = getNodeY(b);
		if (ay !== by) return ay - by;

		return getNodeX(a) - getNodeX(b);
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
		const ay = Number(preferredY.get(a) ?? getNodeY(a));
		const by = Number(preferredY.get(b) ?? getNodeY(b));
		if (ay !== by) return ay - by;
		return getFirstLinkedSlotIndex(a, new Map(), new Map()) - getFirstLinkedSlotIndex(b, new Map(), new Map());
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

	nodes.sort((a, b) => {
		const dy = getNodeY(a) - getNodeY(b);
		if (dy !== 0) return dy;
		return getNodeX(a) - getNodeX(b);
	});

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
		.filter((node) => (inDegree.get(node) || 0) === 0)
		.sort((a, b) => getFirstLinkedSlotIndex(a, backward, forward) - getFirstLinkedSlotIndex(b, backward, forward));

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
		w: getNodeWidth(node),
		h: getNodeHeight(node),
		right: getNodeX(node) + getNodeWidth(node) + g,
		bottom: getNodeY(node) + getNodeHeight(node) + g,
	};
}

function resolveNodeOverlaps(nodes, spacing = DEFAULT_SPACING) {
	const validNodes = filterValidNodes(nodes, false).filter((node) => !isRerouteNode(node));
	const gap = Math.max(0, Math.round(spacing));
	let changed = false;

	for (let iter = 0; iter < 12; iter++) {
		changed = false;
		validNodes.sort((a, b) => {
			const dy = getNodeY(a) - getNodeY(b);
			if (dy !== 0) return dy;
			return getNodeX(a) - getNodeX(b);
		});

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
			if (!input?.link) continue;
			const link = getLinkById(input.link);
			const source = link?.origin_id != null ? getNodeById(link.origin_id) : null;
			if (!source || !fixedSet.has(source)) continue;

			candidatesX.push(getNodeX(source) + getNodeWidth(source) + g - getNodeX(node));
			candidatesY.push(getNodeY(source) + getNodeHeight(source) / 2 - getNodeHeight(node) / 2 - getNodeY(node));
		}

		for (const output of safeArray(node.outputs)) {
			for (const linkId of safeArray(output?.links)) {
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

async function arrangeTopological(nodes, spacing = DEFAULT_SPACING, sortMode = TOPO_SORT_MODES.TOPO_MAIN_PATH) {
	const validNodes = filterValidNodes(nodes, false);
	const beforeBounds = getBoundsForNodes(validNodes, Math.max(getColumnGap(spacing), getRowGap(spacing)));
	shrinkNodeWidths(validNodes);
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

	if (sortMode === TOPO_SORT_MODES.TOPO_MAIN_PATH) {
		// 1. 主链路：以输出锚定为蓝本，按接口顺序计算 Y 轴顺序，
		//    上游/下游尽量按连接节点中心对齐。
		arrangeInterfaceAligned(normalNodes, forward, backward, colGap, rowGap);
	} else if (sortMode === TOPO_SORT_MODES.TOPO_COMPACT) {
		// 2. 紧凑层级：输入、输出和其它节点按类型分块，整体尽量形成方形区域。
		arrangeTypeBlocksSquare(normalNodes, inDegree, outDegree, colGap, rowGap);
	} else if (sortMode === TOPO_SORT_MODES.TOPO_BRANCH) {
		// 3. 分支优先：输入放第一行，下游放下方并尽量与输入中心对齐。
		arrangeInputTopBranches(normalNodes, forward, backward, inDegree, outDegree, colGap, rowGap);
	} else {
		const isolatedNodes = separateIsolatedNodes(normalNodes, inDegree, outDegree);
		const connectedNodes = normalNodes.filter((node) => !isolatedNodes.includes(node));

		let levels;

		if (config.levelStrategy === "sinkLongest") {
			levels = calculateSinkLongestLevels(connectedNodes, forward);
		} else {
			levels = calculateSourceLongestLevels(connectedNodes, backward);
		}

		const layerGroups = groupByLevel(connectedNodes, levels);
		sortLayerGroups(layerGroups, levels, forward, backward, config.sortStrategy);

		const xByLevel = calculateLevelXPositions(layerGroups, {
			...config,
			colWidth: Math.max(HORIZONTAL_SAFE_GAP, config.colWidth + colGap),
		});

		placeLayeredNodes(layerGroups, xByLevel, {
			...config,
			rowGap: Math.max(VERTICAL_SAFE_GAP, config.rowGap + rowGap),
		});

		placeIsolatedNodes(isolatedNodes, layerGroups, {
			...config,
			colWidth: Math.max(HORIZONTAL_SAFE_GAP, config.colWidth + colGap),
			rowGap: Math.max(VERTICAL_SAFE_GAP, config.rowGap + rowGap),
		});
	}

	resolveNodeOverlaps(normalNodes, gap);
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

async function arrangeAuto(nodes, spacing = DEFAULT_SPACING, iterations = 10, relaxPower = 0.5, collisionAvoidance = true, respectConnections = true) {
	console.log("[GJJ_NodeArranger] Starting auto arrangement");

	if (respectConnections) {
		await arrangeTopological(nodes, spacing, TOPO_SORT_MODES.TOPO_MAIN_PATH);
		await applyRelax(nodes, Math.max(2, Math.floor(iterations / 2)), relaxPower * 0.35, spacing, collisionAvoidance);
	} else {
		await applyRelax(nodes, iterations, relaxPower, spacing, collisionAvoidance);
	}

	refreshAfterArrange(nodes);
	fitView(nodes);

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
	const beforeBounds = getBoundsForNodes(validNodes, Math.max(getColumnGap(spacing), getRowGap(spacing)));
	shrinkNodeWidths(validNodes);
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
	return arrangeTopological(validNodes, spacing, sortMode);
}

function createMenuCallback(mode) {
	return () => {
		arrangeNodes(mode, DEFAULT_SPACING, 10, 0.5, true, true, shouldUseSelectedOnly());
	};
}

function addContextMenuItems() {
	if (!app.canvas || app.canvas.__gjjNodeArrangerMenuPatched) return;

	const originalGetCanvasMenuOptions = app.canvas.getCanvasMenuOptions;

	app.canvas.getCanvasMenuOptions = function (...args) {
		const options = originalGetCanvasMenuOptions
			? originalGetCanvasMenuOptions.apply(this, args)
			: [];

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
						callback: () => arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_MAIN_PATH, shouldUseSelectedOnly(), DEFAULT_SPACING),
					},
					{
						content: "🎯 拓扑排序：输出锚定",
						callback: () => arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_OUTPUT_ANCHOR, shouldUseSelectedOnly(), DEFAULT_SPACING),
					},
					{
						content: "🧩 拓扑排序：紧凑层级",
						callback: () => arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_COMPACT, shouldUseSelectedOnly(), DEFAULT_SPACING),
					},
					{
						content: "🌿 拓扑排序：分支优先",
						callback: () => arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_BRANCH, shouldUseSelectedOnly(), DEFAULT_SPACING),
					},
					{
						content: "📦 全部折叠 / 全部打开",
						callback: () => toggleAllNodesCollapsed(shouldUseSelectedOnly()),
					},
					{
						content: "↕️ 拓扑排序：保持上下",
						callback: () => arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_ORIGINAL_Y, shouldUseSelectedOnly(), DEFAULT_SPACING),
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
						content: "⊞ 网格排列",
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

		const arrangeBtn = document.createElement("button");
		arrangeBtn.textContent = "📐 排列节点";
		arrangeBtn.title = "智能排列；部分选择时只排列所选，未选择或全选时排列全部";
		arrangeBtn.style.cssText = buttonStyle();
		installHoverStyle(arrangeBtn);
		arrangeBtn.addEventListener("click", () => {
			arrangeNodes("auto", DEFAULT_SPACING, 10, 0.5, true, true, shouldUseSelectedOnly());
		});
		group.appendChild(arrangeBtn);

		const topoBtn = document.createElement("button");
		topoBtn.textContent = "🔢 拓扑排序";
		topoBtn.title = "默认使用：拓扑主链路；部分选择时只排列所选";
		topoBtn.style.cssText = buttonStyle();
		installHoverStyle(topoBtn);
		topoBtn.addEventListener("click", () => {
			arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_MAIN_PATH, shouldUseSelectedOnly(), DEFAULT_SPACING);
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
			arrangeTopologicalFromGraph(topoSelect.value, shouldUseSelectedOnly(), DEFAULT_SPACING);
		});

		group.appendChild(topoSelect);

		const collapseBtn = document.createElement("button");
		collapseBtn.textContent = "📦 折叠/打开";
		collapseBtn.title = "折叠/打开；部分选择时只作用所选，未选择或全选时作用全部";
		collapseBtn.style.cssText = buttonStyle();
		installHoverStyle(collapseBtn);
		collapseBtn.addEventListener("click", () => {
			toggleAllNodesCollapsed(shouldUseSelectedOnly());
		});
		group.appendChild(collapseBtn);

		toolbar.appendChild(group);

		console.log("[GJJ_NodeArranger] Top bar buttons added");
	}, 1000);
}

function registerKeyboardShortcuts() {
	if (window.__gjjNodeArrangerShortcutsRegistered) return;
	window.__gjjNodeArrangerShortcutsRegistered = true;

	let arrangeModeIndex = 0;

	const arrangeModes = [
		"auto",
		TOPO_SORT_MODES.TOPO_MAIN_PATH,
		TOPO_SORT_MODES.TOPO_OUTPUT_ANCHOR,
		TOPO_SORT_MODES.TOPO_COMPACT,
		TOPO_SORT_MODES.TOPO_BRANCH,
		TOPO_SORT_MODES.TOPO_ORIGINAL_Y,
		"horizontal",
		"vertical",
		"grid",
	];

	const modeNames = [
		"智能排列",
		"拓扑：主链路",
		"拓扑：输出锚定",
		"拓扑：紧凑层级",
		"拓扑：分支优先",
		"拓扑：保持上下",
		"水平排列",
		"垂直排列",
		"网格排列",
	];

	document.addEventListener("keydown", (event) => {
		const key = String(event.key || "").toLowerCase();

		if (event.altKey && !event.ctrlKey && !event.shiftKey && ["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key)) {
			event.preventDefault();
			event.stopPropagation();

			if (key === "arrowleft") adjustLayoutGap("column", -LAYOUT_GAP_STEP);
			if (key === "arrowright") adjustLayoutGap("column", LAYOUT_GAP_STEP);
			if (key === "arrowup") adjustLayoutGap("row", -LAYOUT_GAP_STEP);
			if (key === "arrowdown") adjustLayoutGap("row", LAYOUT_GAP_STEP);

			rerunLastArrangement();
			return;
		}

		if (event.ctrlKey && event.altKey && key === "a") {
			event.preventDefault();
			toggleAllNodesCollapsed(shouldUseSelectedOnly());
			return;
		}

		if (event.ctrlKey && event.shiftKey && !event.altKey && key === "a") {
			event.preventDefault();

			const mode = arrangeModes[arrangeModeIndex];
			const name = modeNames[arrangeModeIndex];

			console.log(`[GJJ_NodeArranger] 快捷键循环模式：${name}`);

			arrangeNodes(mode, DEFAULT_SPACING, 10, 0.5, true, true, shouldUseSelectedOnly());

			arrangeModeIndex = (arrangeModeIndex + 1) % arrangeModes.length;
			return;
		}

		if (event.ctrlKey && event.shiftKey && key === "t") {
			event.preventDefault();
			arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_MAIN_PATH, shouldUseSelectedOnly(), DEFAULT_SPACING);
			return;
		}

		if (event.ctrlKey && event.shiftKey && key === "h") {
			event.preventDefault();
			arrangeNodes("horizontal", DEFAULT_SPACING, 10, 0.5, true, true, shouldUseSelectedOnly());
			return;
		}

		if (event.ctrlKey && event.shiftKey && key === "v") {
			event.preventDefault();
			arrangeNodes("vertical", DEFAULT_SPACING, 10, 0.5, true, true, shouldUseSelectedOnly());
			return;
		}

		if (event.ctrlKey && event.shiftKey && key === "g") {
			event.preventDefault();
			arrangeNodes("grid", DEFAULT_SPACING, 10, 0.5, true, true, shouldUseSelectedOnly());
		}
	});
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
			arrangeNodes("auto", DEFAULT_SPACING, 10, 0.5, true, true, shouldUseSelectedOnly());
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

	async setup() {
		window.GJJ_NodeArranger = {
			arrangeNodes,

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
		registerKeyboardShortcuts();
		patchGraphSerializeIntegerPosition();

		console.log("[GJJ_NodeArranger] Extension loaded successfully");
		console.log("[GJJ_NodeArranger] Shortcuts:");
		console.log("  Ctrl+Shift+A: 循环切换排列模式");
		console.log("  Ctrl+Alt+A: 全部折叠 / 全部打开（智能范围：部分选择时只折叠/打开所选）");
		console.log("  Ctrl+Shift+T: 拓扑主链路");
		console.log("  Ctrl+Shift+H: 水平排列");
		console.log("  Ctrl+Shift+V: 垂直排列");
		console.log("  Ctrl+Shift+G: 网格排列");
		console.log("  Alt+←/→: 减少/增加列宽和横向间距");
		console.log("  Alt+↑/↓: 减少/增加行高和纵向间距");
		console.log("  Ctrl+Alt+A: 全部折叠 / 全部打开");
	},

	async nodeCreated(node) {
		if (node?.comfyClass === NODE_NAME || node?.type === NODE_NAME) {
			console.log("[GJJ_NodeArranger] Node created");
			addButtonToArrangerNode(node);
		}
	},
});
