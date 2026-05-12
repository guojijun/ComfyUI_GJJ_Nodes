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

const DEFAULT_SPACING = 100;

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
			colWidth: 450,
			rowGap: 160,
			isolatedSide: "left",
		},
		[TOPO_SORT_MODES.TOPO_OUTPUT_ANCHOR]: {
			name: "拓扑：输出锚定",
			levelStrategy: "sinkLongest",
			xDirection: "rightOutput",
			sortStrategy: "barycenter",
			colWidth: 450,
			rowGap: 160,
			isolatedSide: "left",
		},
		[TOPO_SORT_MODES.TOPO_COMPACT]: {
			name: "拓扑：紧凑层级",
			levelStrategy: "sourceLongest",
			xDirection: "leftToRight",
			sortStrategy: "barycenter",
			colWidth: 360,
			rowGap: 90,
			isolatedSide: "left",
		},
		[TOPO_SORT_MODES.TOPO_BRANCH]: {
			name: "拓扑：分支优先",
			levelStrategy: "sourceLongest",
			xDirection: "leftToRight",
			sortStrategy: "branch",
			colWidth: 450,
			rowGap: 150,
			isolatedSide: "left",
		},
		[TOPO_SORT_MODES.TOPO_ORIGINAL_Y]: {
			name: "拓扑：保持上下",
			levelStrategy: "sourceLongest",
			xDirection: "leftToRight",
			sortStrategy: "originalY",
			colWidth: 450,
			rowGap: 150,
			isolatedSide: "left",
		},
	};

	return configs[mode] || configs[TOPO_SORT_MODES.TOPO_MAIN_PATH];
}

function safeArray(value) {
	return Array.isArray(value) ? value : [];
}

function getNodeWidth(node) {
	return Number(node?.size?.[0] || node?.size?.width || 240);
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

function fitView() {
	try {
		if (app.canvas?.fitViewToSelection) {
			app.canvas.fitViewToSelection();
			return;
		}

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

	if (validNodes.length === 0) {
		showMessage(selectedOnly ? "没有选中的可排列节点" : "没有可排列的节点");
	}

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

function avoidCollisions(nodes, distance = 100, power = 0.5, onlyY = false) {
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
		currentY += getNodeHeight(node) + Math.max(80, config.rowGap * 0.75);
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
				getNodeX(sourceNode) + getNodeWidth(sourceNode) + 120,
				getNodeY(sourceNode)
			);
		} else if (targetNode) {
			setNodePosition(
				reroute,
				getNodeX(targetNode) - 160,
				getNodeY(targetNode)
			);
		}
	}
}

async function arrangeTopological(nodes, spacing = DEFAULT_SPACING, sortMode = TOPO_SORT_MODES.TOPO_MAIN_PATH) {
	const validNodes = filterValidNodes(nodes, false);
	const config = getTopoModeConfig(sortMode);

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
		return;
	}

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
		colWidth: Math.max(120, config.colWidth + spacing - DEFAULT_SPACING),
	});

	placeLayeredNodes(layerGroups, xByLevel, {
		...config,
		rowGap: Math.max(40, config.rowGap + spacing - DEFAULT_SPACING),
	});

	placeIsolatedNodes(isolatedNodes, layerGroups, config);
	placeRerouteNodes(rerouteNodes, normalNodes);

	refreshAfterArrange(validNodes);
	fitView();

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
	fitView();

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

	console.log(`[GJJ_NodeArranger] arrangeNodes mode=${mode}, nodes=${validNodes.length}`);

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

	refreshAfterArrange(validNodes);
	fitView();
}

function arrangeTopologicalFromGraph(sortMode = TOPO_SORT_MODES.TOPO_MAIN_PATH, selectedOnly = false, spacing = DEFAULT_SPACING) {
	const validNodes = getGraphNodesForArrange(selectedOnly);
	if (validNodes.length === 0) return;
	return arrangeTopological(validNodes, spacing, sortMode);
}

function createMenuCallback(mode) {
	return () => {
		arrangeNodes(mode, DEFAULT_SPACING, 10, 0.5, true, true, false);
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
						callback: () => arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_MAIN_PATH, false, DEFAULT_SPACING),
					},
					{
						content: "🎯 拓扑排序：输出锚定",
						callback: () => arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_OUTPUT_ANCHOR, false, DEFAULT_SPACING),
					},
					{
						content: "🧩 拓扑排序：紧凑层级",
						callback: () => arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_COMPACT, false, DEFAULT_SPACING),
					},
					{
						content: "🌿 拓扑排序：分支优先",
						callback: () => arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_BRANCH, false, DEFAULT_SPACING),
					},
					{
						content: "↕️ 拓扑排序：保持上下",
						callback: () => arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_ORIGINAL_Y, false, DEFAULT_SPACING),
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
					null,
					{
						content: "✅ 仅选中：拓扑主链路",
						callback: () => arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_MAIN_PATH, true, DEFAULT_SPACING),
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
		arrangeBtn.title = "智能排列工作流中的节点";
		arrangeBtn.style.cssText = buttonStyle();
		installHoverStyle(arrangeBtn);
		arrangeBtn.addEventListener("click", () => {
			arrangeNodes("auto", DEFAULT_SPACING, 10, 0.5, true, true, false);
		});
		group.appendChild(arrangeBtn);

		const topoBtn = document.createElement("button");
		topoBtn.textContent = "🔢 拓扑排序";
		topoBtn.title = "默认使用：拓扑主链路";
		topoBtn.style.cssText = buttonStyle();
		installHoverStyle(topoBtn);
		topoBtn.addEventListener("click", () => {
			arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_MAIN_PATH, false, DEFAULT_SPACING);
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
			arrangeTopologicalFromGraph(topoSelect.value, false, DEFAULT_SPACING);
		});

		group.appendChild(topoSelect);

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

		if (event.ctrlKey && event.shiftKey && key === "a") {
			event.preventDefault();

			const mode = arrangeModes[arrangeModeIndex];
			const name = modeNames[arrangeModeIndex];

			console.log(`[GJJ_NodeArranger] 快捷键循环模式：${name}`);

			arrangeNodes(mode, DEFAULT_SPACING, 10, 0.5, true, true, false);

			arrangeModeIndex = (arrangeModeIndex + 1) % arrangeModes.length;
			return;
		}

		if (event.ctrlKey && event.shiftKey && key === "t") {
			event.preventDefault();
			arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_MAIN_PATH, false, DEFAULT_SPACING);
			return;
		}

		if (event.ctrlKey && event.shiftKey && key === "h") {
			event.preventDefault();
			arrangeNodes("horizontal", DEFAULT_SPACING);
			return;
		}

		if (event.ctrlKey && event.shiftKey && key === "v") {
			event.preventDefault();
			arrangeNodes("vertical", DEFAULT_SPACING);
			return;
		}

		if (event.ctrlKey && event.shiftKey && key === "g") {
			event.preventDefault();
			arrangeNodes("grid", DEFAULT_SPACING);
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
			arrangeNodes("auto", DEFAULT_SPACING, 10, 0.5, true, true, false);
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
				return arrangeNodes("auto", spacing, iterations, relaxPower, true, true, false);
			},

			arrangeHorizontal: (spacing = DEFAULT_SPACING) => {
				return arrangeNodes("horizontal", spacing, 10, 0.5, true, true, false);
			},

			arrangeVertical: (spacing = DEFAULT_SPACING) => {
				return arrangeNodes("vertical", spacing, 10, 0.5, true, true, false);
			},

			arrangeGrid: (spacing = DEFAULT_SPACING) => {
				return arrangeNodes("grid", spacing, 10, 0.5, true, true, false);
			},

			arrangeTopological: (spacing = DEFAULT_SPACING, sortMode = TOPO_SORT_MODES.TOPO_MAIN_PATH) => {
				return arrangeTopologicalFromGraph(sortMode, false, spacing);
			},

			arrangeTopoMainPath: (spacing = DEFAULT_SPACING) => {
				return arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_MAIN_PATH, false, spacing);
			},

			arrangeTopoOutputAnchor: (spacing = DEFAULT_SPACING) => {
				return arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_OUTPUT_ANCHOR, false, spacing);
			},

			arrangeTopoCompact: (spacing = DEFAULT_SPACING) => {
				return arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_COMPACT, false, spacing);
			},

			arrangeTopoBranch: (spacing = DEFAULT_SPACING) => {
				return arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_BRANCH, false, spacing);
			},

			arrangeTopoOriginalY: (spacing = DEFAULT_SPACING) => {
				return arrangeTopologicalFromGraph(TOPO_SORT_MODES.TOPO_ORIGINAL_Y, false, spacing);
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
		console.log("  Ctrl+Shift+T: 拓扑主链路");
		console.log("  Ctrl+Shift+H: 水平排列");
		console.log("  Ctrl+Shift+V: 垂直排列");
		console.log("  Ctrl+Shift+G: 网格排列");
	},

	async nodeCreated(node) {
		if (node?.comfyClass === NODE_NAME || node?.type === NODE_NAME) {
			console.log("[GJJ_NodeArranger] Node created");
			addButtonToArrangerNode(node);
		}
	},
});
