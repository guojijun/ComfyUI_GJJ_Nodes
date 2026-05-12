/**
 * GJJ Node Arranger - ComfyUI 节点自动排列工具
 * v2.0.0 - Topological Sort (Longest Main Path Branch Layering)
 * 基于 Blender NodeRelax 插件的算法，适配 ComfyUI 环境
 * 支持右键菜单、顶部工具栏和快捷键
 */

import { app } from "/scripts/app.js";

const NODE_NAME = "GJJ_NodeArranger";

// 移动单位常量
const MOVE_UNIT = 1;

// 拓扑排序模式（已废弃）
// let topoSortMode = 0;

/**
 * 获取节点的全局位置（考虑父节点）
 */
function getGlobalLocation(node) {
	if (node.parent) {
		const parentLoc = getGlobalLocation(node.parent);
		return {
			x: parentLoc.x + node.pos[0],
			y: parentLoc.y + node.pos[1]
		};
	}
	return { x: node.pos[0], y: node.pos[1] };
}

/**
 * 计算节点尺寸
 */
function getNodeSize(node) {
	return {
		width: node.size[0],
		height: node.size[1]
	};
}

/**
 * 碰撞检测和处理
 */
function handleCollision(loc0, loc1, size0, size1, offset, power, dist, onlyY = false) {
	const pos0 = {
		x: loc0.x + size0.width / 2,
		y: loc0.y + size0.height / 2 - size0.height
	};

	const pos1 = {
		x: loc1.x + size1.width / 2,
		y: loc1.y + size1.height / 2 - size1.height
	};

	const size = {
		width: (size0.width + size1.width) / 2 + dist,
		height: (size0.height + size1.height) / 2 + dist
	};

	const delta = {
		x: pos1.x - pos0.x,
		y: pos1.y - pos0.y
	};

	const inters = {
		x: size.width - Math.abs(delta.x),
		y: size.height - Math.abs(delta.y)
	};

	if (inters.x > 0 && inters.y > 0) {
		if (inters.y < inters.x || onlyY) {
			offset.y += (delta.y > 0 ? -inters.y : inters.y) / 2 * power;
		} else {
			offset.x += (delta.x > 0 ? -inters.x : inters.x) / 2 * power;
		}
	}
}

/**
 * 计算节点的松弛位置
 */
function calculateRelaxPosition(node, nodes, influence, relaxPower, distance, clampedPull) {
	if (node.type === "group") return false;

	const loc = getGlobalLocation(node);
	const size = getNodeSize(node);
	const offset = { x: 0, y: 0 };

	let tarY = 0;
	let tarXIn = clampedPull ? loc.x : 0;
	let linkCount = 0;
	let hasInput = false;

	// 处理输入连接
	for (const input of node.inputs || []) {
		if (!input.link) continue;

		const link = app.graph.links[input.link];
		if (!link) continue;

		const otherNode = app.graph.getNodeById(link.origin_id);
		if (!otherNode) continue;

		const otherLoc = getGlobalLocation(otherNode);
		const otherSize = getNodeSize(otherNode);

		const x = otherLoc.x + otherSize.width + distance;

		if (clampedPull) {
			tarXIn = hasInput ? Math.max(tarXIn, x) : x;
		} else {
			tarXIn += x;
		}

		hasInput = true;
		tarY += otherLoc.y + getSocketPosition(input, node.inputs, size.height) -
				getSocketPosition(link.from_slot, otherNode.outputs, otherSize.height);
		linkCount++;
	}

	let tarXOut = clampedPull ? loc.x : 0;
	let hasOutput = false;

	// 处理输出连接
	for (let i = 0; i < (node.outputs?.length || 0); i++) {
		const output = node.outputs[i];
		if (!output.links || output.links.length === 0) continue;

		for (const linkId of output.links) {
			const link = app.graph.links[linkId];
			if (!link) continue;

			const otherNode = app.graph.getNodeById(link.target_id);
			if (!otherNode) continue;

			const otherLoc = getGlobalLocation(otherNode);
			const otherSize = getNodeSize(otherNode);

			const x = otherLoc.x - size.width - distance;

			if (clampedPull) {
				tarXOut = hasOutput ? Math.min(tarXOut, x) : x;
			} else {
				tarXOut += x;
			}

			hasOutput = true;
			tarY += otherLoc.y + getSocketPosition(output, node.outputs, size.height) -
					getSocketPosition(link.target_slot, otherNode.inputs, otherSize.height);
			linkCount++;
		}
	}

	if (linkCount > 0) {
		let tarX;
		if (clampedPull) {
			tarX = (tarXIn * (hasInput ? 1 : 0) + tarXOut * (hasOutput ? 1 : 0)) /
				   ((hasInput ? 1 : 0) + (hasOutput ? 1 : 0));
		} else {
			tarX = (tarXIn + tarXOut) / linkCount;
		}

		tarY /= linkCount;

		offset.x += (tarX - loc.x) * relaxPower;
		offset.y += (tarY - loc.y) * relaxPower;
	}

	if (Math.abs(offset.x) > MOVE_UNIT || Math.abs(offset.y) > MOVE_UNIT) {
		node.pos[0] += Math.round(offset.x * influence);
		node.pos[1] += Math.round(offset.y * influence);
		return true;
	}

	return false;
}

/**
 * 获取插槽位置比例
 */
function getSocketPosition(socket, sockets, totalSize) {
	const connectedSockets = sockets.filter(s => s.link || (s.links && s.links.length > 0));
	const index = connectedSockets.indexOf(socket);
	if (index === -1) return totalSize / 2;
	return (index / connectedSockets.length) * totalSize;
}

/**
 * 计算 Y 轴碰撞避免
 */
function calculateCollisionY(node, nodes, collidePower, collideDist) {
	if (node.type === "group") return false;

	const loc = getGlobalLocation(node);
	const size = getNodeSize(node);
	const offset = { x: 0, y: 0 };

	for (const other of nodes) {
		if (other === node || other.type === "group") continue;

		const otherLoc = getGlobalLocation(other);
		const otherSize = getNodeSize(other);

		handleCollision(loc, otherLoc, size, otherSize, offset, 1, collideDist, true);
	}

	if (Math.abs(offset.y) > MOVE_UNIT) {
		node.pos[1] += Math.round(offset.y * collidePower);
		return true;
	}

	return false;
}

/**
 * 通用节点计算函数
 */
function calculateNodePosition(node, nodes, influence, slideVec, relaxPower, collidePower, collideDist, pullNonSiblings) {
	if (node.type === "group") return false;

	const loc = getGlobalLocation(node);
	const size = getNodeSize(node);
	const offset = { x: slideVec.x || 0, y: slideVec.y || 0 };

	// 松弛计算
	if (relaxPower > 0) {
		calculateRelaxPosition(node, nodes, 1, relaxPower, collideDist, !pullNonSiblings);
	}

	// 碰撞检测
	if (collidePower > 0) {
		for (const other of nodes) {
			if (other === node || other.type === "group") continue;

			const otherLoc = getGlobalLocation(other);
			const otherSize = getNodeSize(other);

			handleCollision(loc, otherLoc, size, otherSize, offset, collidePower, collideDist);
		}
	}

	if (Math.abs(offset.x) > MOVE_UNIT || Math.abs(offset.y) > MOVE_UNIT) {
		node.pos[0] += Math.round(offset.x * influence);
		node.pos[1] += Math.round(offset.y * influence);
		return true;
	}

	return false;
}

/**
 * 过滤有效节点
 */
function filterValidNodes(nodes, selectedOnly) {
	return nodes.filter(node => {
		if (node.type === "group") return false;
		if (selectedOnly && !node.selected) return false;
		return true;
	});
}

/**
 * 水平排列
 */
function arrangeHorizontal(nodes, spacing) {
	let currentX = 0;
	const startY = 0;

	for (const node of nodes) {
		node.pos = [Math.round(currentX), Math.round(startY)];
		currentX += node.size[0] + spacing;
	}
}

/**
 * 垂直排列
 */
function arrangeVertical(nodes, spacing) {
	const startX = 0;
	let currentY = 0;

	for (const node of nodes) {
		node.pos = [Math.round(startX), Math.round(currentY)];
		currentY += node.size[1] + spacing;
	}
}

/**
 * 网格排列
 */
function arrangeGrid(nodes, spacing) {
	const cols = Math.ceil(Math.sqrt(nodes.length));
	let col = 0;
	let row = 0;
	let maxWidth = 0;

	// 计算最大宽度
	for (const node of nodes) {
		maxWidth = Math.max(maxWidth, node.size[0]);
	}

	for (const node of nodes) {
		node.pos = [Math.round(col * (maxWidth + spacing)), Math.round(row * (node.size[1] + spacing))];

		col++;
		if (col >= cols) {
			col = 0;
			row++;
		}
	}
}

/**
 * 计算节点的最终层级（只正向计算，不反向修正）
 * 反向修正会导致所有节点被拉回同一列，所以去掉
 * @param {Array} nodes - 所有节点
 * @param {Map} nodeDependents - 下游节点映射
 * @returns {Map} node -> finalLevel
 */
function calculateFinalLevels(nodes, nodeDependents) {
	const levels = new Map();
	const nodeDependencies = new Map();

	for (const node of nodes) {
		levels.set(node, 0);
		nodeDependencies.set(node, new Set());
	}

	// 构建依赖关系
	for (const node of nodes) {
		for (const input of node.inputs || []) {
			if (!input.link) continue;
			const link = app.graph.links[input.link];
			if (!link) continue;
			const sourceNode = app.graph.getNodeById(link.origin_id);
			if (sourceNode && nodes.includes(sourceNode)) {
				nodeDependencies.get(node).add(sourceNode);
			}
		}
	}

	// 正向迭代：节点层级 = 所有上游节点的层级最大值 + 1
	let updated = true;
	let iterations = 0;
	const maxIterations = 100;

	while (updated && iterations < maxIterations) {
		updated = false;
		iterations++;

		for (const node of nodes) {
			const deps = nodeDependencies.get(node);
			if (deps.size === 0) continue;

			let maxDepLevel = -1;
			for (const dep of deps) {
				maxDepLevel = Math.max(maxDepLevel, levels.get(dep));
			}

			const newLevel = maxDepLevel + 1;
			if (levels.get(node) < newLevel) {
				levels.set(node, newLevel);
				updated = true;
			}
		}
	}

	console.log(`[GJJ_NodeArranger] Levels calculated: max level = ${Math.max(...Array.from(levels.values()))}`);
	return levels;
}

/**
 * 拓扑排序（严格层级 + 交叉最小化算法）
 * 核心逻辑：
 * 1. 计算每个节点的严格拓扑层级（最长路径）
 * 2. 按层级分组，同层级节点在同一列
 * 3. 使用重心启发式算法最小化连线交叉
 * 4. 并行分支垂直对齐，逻辑分组聚集
 * 5. 坐标四舍五入为整数
 * 6. Reroute 节点保持原位
 */
async function arrangeTopological(nodes, spacing = 100) {
	console.log("[GJJ_NodeArranger] Starting topological sort (strict layers with crossing minimization)");

	const COL_WIDTH = 450;
	const ROW_HEIGHT = 160; // 增加行高，减少连线交叉
	const BASE_Y = 0;

	// 分离 Reroute 节点和普通节点
	const rerouteTypes = ['Reroute', 'PrimitiveNode', 'Reroute (rgthree)'];
	const normalNodes = nodes.filter(n => !rerouteTypes.includes(n.type));
	const rerouteNodes = nodes.filter(n => rerouteTypes.includes(n.type));

	console.log(`[GJJ_NodeArranger] Total: ${nodes.length}, Normal: ${normalNodes.length}, Reroute: ${rerouteNodes.length}`);

	if (normalNodes.length === 0) {
		console.log("[GJJ_NodeArranger] No normal nodes to arrange");
		return;
	}

	// 步骤1：构建邻接表和反向邻接表（仅普通节点）
	const forwardEdges = new Map(); // node -> [targetNodes]
	const backwardEdges = new Map(); // node -> [sourceNodes]
	const inDegree = new Map();
	const outDegree = new Map();

	for (const node of normalNodes) {
		forwardEdges.set(node, []);
		backwardEdges.set(node, []);
		inDegree.set(node, 0);
		outDegree.set(node, 0);
	}

	// 辅助函数：穿透 Reroute 找到真正的连接节点
	function findRealSource(nodeId, visited = new Set()) {
		if (visited.has(nodeId)) return null;
		visited.add(nodeId);

		const node = app.graph.getNodeById(nodeId);
		if (!node) return null;

		if (!rerouteTypes.includes(node.type)) {
			return node; // 找到真实节点
		}

		// 是 Reroute，继续向前追踪
		for (const input of node.inputs || []) {
			if (input.link) {
				const link = app.graph.links[input.link];
				if (link) {
					const result = findRealSource(link.origin_id, visited);
					if (result) return result;
				}
			}
		}
		return null;
	}

	function findRealTargets(nodeId, visited = new Set()) {
		if (visited.has(nodeId)) return [];
		visited.add(nodeId);

		const node = app.graph.getNodeById(nodeId);
		if (!node) return [];

		if (!rerouteTypes.includes(node.type)) {
			return [node]; // 找到真实节点
		}

		// 是 Reroute，继续向后追踪
		const targets = [];
		for (const output of node.outputs || []) {
			if (output.links && output.links.length > 0) {
				for (const linkId of output.links) {
					const link = app.graph.links[linkId];
					if (link) {
						const results = findRealTargets(link.target_id, visited);
						targets.push(...results);
					}
				}
			}
		}
		return targets;
	}

	for (const node of normalNodes) {
		for (let i = 0; i < (node.outputs?.length || 0); i++) {
			const output = node.outputs[i];
			if (!output.links || output.links.length === 0) continue;

			for (const linkId of output.links) {
				const link = app.graph.links[linkId];
				if (!link) continue;

				// 穿透 Reroute 找到真正的目标节点
				const realTargets = findRealTargets(link.target_id);
				for (const targetNode of realTargets) {
					if (targetNode && normalNodes.includes(targetNode) && targetNode !== node) {
						forwardEdges.get(node).push(targetNode);
						backwardEdges.get(targetNode).push(node);
						inDegree.set(targetNode, inDegree.get(targetNode) + 1);
						outDegree.set(node, outDegree.get(node) + 1);
					}
				}
			}
		}
	}

	// 步骤2：从输出节点倒序计算拓扑层级（反向最长路径算法）
	const levels = new Map();
	const layerGroups = new Map(); // level -> [nodes]

	// 初始化所有节点层级为 0
	for (const node of normalNodes) {
		levels.set(node, 0);
	}

	// 识别输出节点（出度为 0 的终端节点）
	const outputNodes = normalNodes.filter(node => outDegree.get(node) === 0);
	console.log(`[GJJ_NodeArranger] Found ${outputNodes.length} output nodes`);

	// 从输出节点开始，反向传播层级
	let updated = true;
	let iterations = 0;
	while (updated && iterations < normalNodes.length) {
		updated = false;
		iterations++;

		for (const node of normalNodes) {
			const targets = forwardEdges.get(node);
			if (targets.length === 0) continue;

			let maxTargetLevel = -1;
			for (const target of targets) {
				maxTargetLevel = Math.max(maxTargetLevel, levels.get(target));
			}

			const newLevel = maxTargetLevel + 1;
			if (levels.get(node) < newLevel) {
				levels.set(node, newLevel);
				updated = true;
			}
		}
	}

	console.log(`[GJJ_NodeArranger] Calculated levels: max level = ${Math.max(...Array.from(levels.values()))}, iterations = ${iterations}`);

	// 按层级分组
	for (const [node, level] of levels) {
		if (!layerGroups.has(level)) {
			layerGroups.set(level, []);
		}
		layerGroups.get(level).push(node);
	}

	// 步骤3：使用重心启发式算法最小化交叉（迭代优化）
	function minimizeCrossings() {
		// 先按原始位置排序
		for (const [level, layerNodes] of layerGroups) {
			layerNodes.sort((a, b) => a.pos[1] - b.pos[1]);
		}

		// 迭代优化 3 次
		for (let iter = 0; iter < 3; iter++) {
			// 从上游到下游优化（高层级到低层级）
			const sortedLevels = Array.from(layerGroups.keys()).sort((a, b) => b - a);
			for (let i = 1; i < sortedLevels.length; i++) {
				const level = sortedLevels[i];
				if (!layerGroups.has(level)) continue;

				const layerNodes = layerGroups.get(level);

				// 计算每个节点的重心位置（基于上游节点）
				const barycenters = new Map();
				for (const node of layerNodes) {
					const sources = backwardEdges.get(node);
					if (sources.length === 0) {
						barycenters.set(node, node.pos[1]); // 保持原始位置
					} else {
						let sum = 0;
						for (const source of sources) {
							const sourceLevel = levels.get(source);
							if (layerGroups.has(sourceLevel)) {
								const sourceNodes = layerGroups.get(sourceLevel);
								const sourceIndex = sourceNodes.indexOf(source);
								sum += sourceIndex;
							}
						}
						barycenters.set(node, sum / sources.length);
					}
				}

				// 按重心排序
				layerNodes.sort((a, b) => barycenters.get(a) - barycenters.get(b));
			}

			// 从下游到上游优化（低层级到高层级）
			for (let i = sortedLevels.length - 2; i >= 0; i--) {
				const level = sortedLevels[i];
				if (!layerGroups.has(level)) continue;

				const layerNodes = layerGroups.get(level);

				const barycenters = new Map();
				for (const node of layerNodes) {
					const targets = forwardEdges.get(node);
					if (targets.length === 0) {
						barycenters.set(node, node.pos[1]);
					} else {
						let sum = 0;
						for (const target of targets) {
							const targetLevel = levels.get(target);
							if (layerGroups.has(targetLevel)) {
								const targetNodes = layerGroups.get(targetLevel);
								const targetIndex = targetNodes.indexOf(target);
								sum += targetIndex;
							}
						}
						barycenters.set(node, sum / targets.length);
					}
				}

				layerNodes.sort((a, b) => barycenters.get(a) - barycenters.get(b));
			}
		}
	}

	minimizeCrossings();
	console.log("[GJJ_NodeArranger] Crossing minimization completed");

	// 步骤4：计算最终位置
	// 反向层级：输出节点 level=0 在最右，上游节点 level 越大越靠左
	const minLevel = Math.min(...Array.from(layerGroups.keys()));
	const maxLevel = Math.max(...Array.from(layerGroups.keys()));

	console.log(`[GJJ_NodeArranger] Level range: ${minLevel} to ${maxLevel} (maxLevel=furthest upstream)`);

	for (let level = maxLevel; level >= minLevel; level--) {
		if (!layerGroups.has(level)) continue;

		const layerNodes = layerGroups.get(level);
		// 反转 X 轴：maxLevel 在最左 (X=0)，level 0 在最右
		const x = (maxLevel - level) * COL_WIDTH;

		// Y 轴从上到下排列
		let currentY = 0;
		for (const node of layerNodes) {
			node.pos = [Math.round(x), Math.round(currentY)];
			currentY += node.size[1] + ROW_HEIGHT;
		}

		console.log(`[GJJ_NodeArranger] Level ${level} (${layerNodes.length} nodes) at X=${x}`);
	}

	// 步骤5：处理孤立节点（没有连接的节点）
	const isolatedNodes = normalNodes.filter(node =>
		inDegree.get(node) === 0 && outDegree.get(node) === 0
	);

	if (isolatedNodes.length > 0) {
		console.log(`[GJJ_NodeArranger] Found ${isolatedNodes.length} isolated nodes`);
		const isolatedX = -(COL_WIDTH * 2);
		let isolatedY = 0;

		// 按原始 Y 坐标排序
		isolatedNodes.sort((a, b) => a.pos[1] - b.pos[1]);

		for (const node of isolatedNodes) {
			node.pos = [Math.round(isolatedX), Math.round(isolatedY)];
			isolatedY += node.size[1] + 120;
		}
	}

	console.log(`[GJJ_NodeArranger] Placed ${normalNodes.length} nodes in ${maxLevel - minLevel + 1} layers`);

	// 步骤6：定位 Reroute 节点到其连接的两个节点中间
	if (rerouteNodes.length > 0) {
		console.log(`[GJJ_NodeArranger] Positioning ${rerouteNodes.length} reroute nodes`);
		for (const reroute of rerouteNodes) {
			// 找到 Reroute 的输入源
			let sourceNode = null;
			for (const input of reroute.inputs || []) {
				if (input.link) {
					const link = app.graph.links[input.link];
					if (link) {
						sourceNode = app.graph.getNodeById(link.origin_id);
						break;
					}
				}
			}

			// 找到 Reroute 的输出目标
			let targetNode = null;
			for (const output of reroute.outputs || []) {
				if (output.links && output.links.length > 0) {
					const link = app.graph.links[output.links[0]];
					if (link) {
						targetNode = app.graph.getNodeById(link.target_id);
						break;
					}
				}
			}

			// 如果找到了源和目标节点，放置在它们中间
			if (sourceNode && targetNode) {
				const midX = (sourceNode.pos[0] + targetNode.pos[0]) / 2;
				const midY = (sourceNode.pos[1] + targetNode.pos[1]) / 2;
				reroute.pos = [Math.round(midX), Math.round(midY)];
			} else if (sourceNode) {
				// 只有源节点，放在源节点右侧
				reroute.pos = [Math.round(sourceNode.pos[0] + COL_WIDTH / 2), Math.round(sourceNode.pos[1])];
			} else if (targetNode) {
				// 只有目标节点，放在目标节点左侧
				reroute.pos = [Math.round(targetNode.pos[0] - COL_WIDTH / 2), Math.round(targetNode.pos[1])];
			}
		}
	}

	// 执行适应视图（Fit View）- 让所有节点都在可视范围内
	try {
		if (app.canvas && typeof app.canvas.fitViewToSelection === 'function') {
			app.canvas.fitViewToSelection();
			console.log('[GJJ_NodeArranger] Fit view using fitViewToSelection API');
		} else {
			const keyEvent = new KeyboardEvent('keydown', {
				key: '.',
				code: 'Period',
				keyCode: 190,
				which: 190,
				bubbles: true,
				cancelable: true
			});
			document.dispatchEvent(keyEvent);
			console.log('[GJJ_NodeArranger] Fit view by simulating period key press');
		}
	} catch (error) {
		console.warn('[GJJ_NodeArranger] Failed to fit view:', error);
	}

	// 实时刷新画布
	app.graph.setDirtyCanvas(true, true);
	await new Promise(resolve => setTimeout(resolve, 0));

	console.log("[GJJ_NodeArranger] Topological sort completed");
}



/**
 * 自动排列（基于拓扑层级 + 最近原则）
 * 核心逻辑：
 * 1. 正向计算层级，保留多分支的跨列特性
 * 2. 保留 Reroute 节点（锚点）在原位，不移动
 * 3. 其他节点按层级排列，考虑原始位置（最近原则）
 */
async function arrangeAuto(nodes, spacing, iterations, relaxPower, collisionAvoidance, respectConnections) {
	console.log("[GJJ_NodeArranger] Starting topology-based arrangement with nearest principle");

	// 过滤掉 Reroute 节点（锚点），不移动它们
	const rerouteTypes = ['Reroute', 'PrimitiveNode', 'Reroute (rgthree)'];
	const normalNodes = nodes.filter(n => !rerouteTypes.includes(n.type));
	const rerouteNodes = nodes.filter(n => rerouteTypes.includes(n.type));

	console.log(`[GJJ_NodeArranger] Total nodes: ${nodes.length}, Normal: ${normalNodes.length}, Reroute: ${rerouteNodes.length}`);

	// 步骤1：构建节点之间的依赖关系（只针对普通节点）
	const nodeDependencies = new Map();
	const nodeDependents = new Map();
	const isolatedNodes = []; // 孤立节点（既无输入也无输出）
	const sourceNodes = [];   // 数据源节点（只有输出，没有输入）

	for (const node of normalNodes) {
		nodeDependencies.set(node, new Set());
		nodeDependents.set(node, []);
	}

	// 辅助函数：递归追踪通过 Reroute 节点的连接
	function traceConnectionThroughReroute(nodeId, direction, visited = new Set()) {
		if (visited.has(nodeId)) {
			console.log(`[GJJ_NodeArranger] ️ Loop detected at node ${nodeId}`);
			return { type: 'loop', node: null };
		}
		visited.add(nodeId);

		const currentNode = app.graph.getNodeById(nodeId);
		if (!currentNode) {
			console.log(`[GJJ_NodeArranger] ⚠️ Node ${nodeId} not found`);
			return { type: 'invalid', node: null };
		}

		// 如果不是 Reroute 类型，直接返回
		if (!rerouteTypes.includes(currentNode.type)) {
			return { type: 'normal', node: currentNode };
		}

		console.log(`[GJJ_NodeArranger] Tracing through Reroute node: "${currentNode.title}" (${currentNode.type})`);

		// 是 Reroute 节点，继续追踪
		if (direction === 'forward') {
			// 向前追踪：查找 Reroute 的输出连接
			for (const output of currentNode.outputs || []) {
				if (output.links && output.links.length > 0) {
					for (const linkId of output.links) {
						const link = app.graph.links[linkId];
						if (link) {
							const result = traceConnectionThroughReroute(link.target_id, 'forward', new Set(visited));
							if (result.type === 'normal') return result;
						}
					}
				}
			}
		} else {
			// 向后追踪：查找 Reroute 的输入连接
			for (const input of currentNode.inputs || []) {
				if (input.link) {
					const link = app.graph.links[input.link];
					if (link) {
						const result = traceConnectionThroughReroute(link.origin_id, 'backward', new Set(visited));
						if (result.type === 'normal') return result;
					}
				}
			}
		}

		console.log(`[GJJ_NodeArranger] ⚠️ Dead end at Reroute node: "${currentNode.title}"`);
		return { type: 'dead-end', node: null };
	}

	// 分析连接关系
	for (const node of normalNodes) {
		let hasInput = false;
		let hasOutput = false;

		// 添加详细调试：VAE相关类型节点
		const isDebugNode = node.type === 'VAELoader' || node.type === 'VAEDecode' || node.type === 'VAEEncode' || node.title?.includes('VAE');

		// 检查输入连接（包括通过 Reroute 的间接连接）
		if (isDebugNode) {
			console.log(`[GJJ_NodeArranger] 🔍 DEBUG: Checking inputs for "${node.title}" (type: ${node.type})`);
			console.log(`[GJJ_NodeArranger] 🔍 DEBUG: inputs.length = ${node.inputs?.length || 0}`);
		}

		for (let i = 0; i < (node.inputs?.length || 0); i++) {
			const input = node.inputs[i];

			if (isDebugNode) {
				console.log(`[GJJ_NodeArranger]  DEBUG: Input ${i}: has link = ${!!input.link}, link_id = ${input.link || 'none'}`);
			}

			if (!input.link) continue;
			const link = app.graph.links[input.link];
			if (!link) continue;

			if (isDebugNode) {
				console.log(`[GJJ_NodeArranger]  DEBUG: Input link ${input.link}: origin_id = ${link.origin_id}`);
			}

			// 追踪连接，可能经过 Reroute 节点
			const result = traceConnectionThroughReroute(link.origin_id, 'backward');

			if (isDebugNode) {
				console.log(`[GJJ_NodeArranger]  DEBUG: Input trace result: type=${result.type}, node_title=${result.node?.title || 'null'}, inNormalNodes=${result.node ? normalNodes.includes(result.node) : 'N/A'}`);
			}

			if (result.type === 'normal' && result.node && normalNodes.includes(result.node)) {
				nodeDependencies.get(node).add(result.node);
				nodeDependents.get(result.node).push(node);
				hasInput = true;
			}
		}

		// 检查输出连接（包括通过 Reroute 的间接连接）
		if (isDebugNode) {
			console.log(`[GJJ_NodeArranger] 🔍 DEBUG: Checking outputs for "${node.title}" (type: ${node.type})`);
			console.log(`[GJJ_NodeArranger] 🔍 DEBUG: outputs.length = ${node.outputs?.length || 0}`);
		}

		for (let i = 0; i < (node.outputs?.length || 0); i++) {
			const output = node.outputs[i];

			if (isDebugNode) {
				console.log(`[GJJ_NodeArranger] 🔍 DEBUG: Output ${i}: has links = ${!!output.links}, count = ${output.links?.length || 0}`);
				console.log(`[GJJ_NodeArranger] 🔍 DEBUG: Output ${i}: link_ids = ${JSON.stringify(output.links || [])}`);
			}

			if (!output.links || output.links.length === 0) continue;

			for (const linkId of output.links) {
				const link = app.graph.links[linkId];

				if (isDebugNode) {
					console.log(`[GJJ_NodeArranger]  DEBUG: Link ${linkId}: ${link ? `target_id=${link.target_id}` : 'NOT FOUND in graph.links'}`);
				}

				if (!link) continue;

				// 追踪连接，可能经过 Reroute 节点
				const result = traceConnectionThroughReroute(link.target_id, 'forward');

				if (isDebugNode) {
					console.log(`[GJJ_NodeArranger]  DEBUG: Trace result: type=${result.type}, node_title=${result.node?.title || 'null'}, node_type=${result.node?.type || 'null'}, inNormalNodes=${result.node ? normalNodes.includes(result.node) : 'N/A'}`);
				}

				if (result.type === 'normal' && result.node && normalNodes.includes(result.node)) {
					hasOutput = true;
					if (isDebugNode) console.log(`[GJJ_NodeArranger] 🔍 DEBUG: ✅ Found valid output connection!`);
					break;
				} else if (result.type === 'dead-end') {
					if (isDebugNode) console.log(`[GJJ_NodeArranger]  DEBUG: ⚠️ Dead end trace from "${node.title}" output ${i}`);
				}
			}
			if (hasOutput) break;
		}

		// 分类节点
		if (!hasInput && !hasOutput) {
			// 孤立节点：既无输入也无输出
			isolatedNodes.push(node);
			console.log(`[GJJ_NodeArranger] ️ Isolated node: "${node.title}" (type: ${node.type})`);
		} else if (!hasInput && hasOutput) {
			// 数据源节点：只有输出，没有输入（如 Load Image、Checkpoint 等）
			sourceNodes.push(node);
			console.log(`[GJJ_NodeArranger] ✅ Source node: "${node.title}" (type: ${node.type})`);
		} else if (hasInput && !hasOutput) {
			console.log(`[GJJ_NodeArranger]  Output node: "${node.title}" (type: ${node.type})`);
		} else {
			console.log(`[GJJ_NodeArranger] 🔀 Middle node: "${node.title}" (type: ${node.type})`);
		}
	}

	// 步骤2：正向计算层级（只针对非孤立、非数据源的节点）
	const middleNodes = normalNodes.filter(n => !isolatedNodes.includes(n) && !sourceNodes.includes(n));
	const levels = calculateFinalLevels(middleNodes, nodeDependents);

	// 步骤3：按层级分组
	const layerGroups = new Map();
	for (const [node, level] of levels) {
		if (!layerGroups.has(level)) {
			layerGroups.set(level, []);
		}
		layerGroups.get(level).push(node);
	}

	// 步骤4：对每层内的节点进行排序（最近原则：按原始 X 坐标排序）
	for (const [level, layerNodes] of layerGroups) {
		layerNodes.sort((a, b) => {
			// 按原始 X 坐标升序，保持相对位置
			return a.pos[0] - b.pos[0];
		});
	}

	// 步骤5：计算每个节点的位置
	const COL_WIDTH = 450;
	const ROW_HEIGHT = 200;
	const ISOLATED_ROW_HEIGHT = 120; // 孤立节点间距更小

	// 处理孤立节点：计算孤立节点自己的最大宽度，避免遮挡
	if (isolatedNodes.length > 0) {
		// 计算孤立节点自己的最大宽度
		let isolatedMaxWidth = 0;
		for (const node of isolatedNodes) {
			isolatedMaxWidth = Math.max(isolatedMaxWidth, node.size[0]);
		}

		// 放在更靠左的位置，远离数据源节点（-COL_WIDTH）和第一列（0）
		// 使用 3 倍 COL_WIDTH 的间距
		const isolatedX = -(COL_WIDTH * 3 + isolatedMaxWidth);
		let currentY = 0;

		// 按原始 Y 坐标排序
		isolatedNodes.sort((a, b) => a.pos[1] - b.pos[1]);

		for (const node of isolatedNodes) {
			node.pos = [Math.round(isolatedX), Math.round(currentY)];
			currentY += node.size[1] + ISOLATED_ROW_HEIGHT;
		}

		console.log(`[GJJ_NodeArranger] Placed ${isolatedNodes.length} isolated nodes at X=${isolatedX} (isolatedMaxWidth=${isolatedMaxWidth})`);
	}

	// 处理数据源节点：放在 -COL_WIDTH 的位置（输出节点的前一列）
	if (sourceNodes.length > 0) {
		const sourceX = -COL_WIDTH;
		let currentY = 0;

		// 按原始 Y 坐标排序
		sourceNodes.sort((a, b) => a.pos[1] - b.pos[1]);

		for (const node of sourceNodes) {
			node.pos = [Math.round(sourceX), Math.round(currentY)];
			currentY += node.size[1] + ROW_HEIGHT;
		}

		console.log(`[GJJ_NodeArranger] Placed ${sourceNodes.length} source nodes at X=${sourceX}`);
	}

	// 找到最小层级作为起始列（从 0 开始）
	const minLevel = levels.size > 0 ? Math.min(...Array.from(levels.values())) : 0;
	const levelOffset = 0; // 不添加偏移，直接排列

	// 直接按层级从左到右排列，不添加额外的偏移
	// 数据源节点在 -COL_WIDTH，层级 0 的节点在 0，依次向右排列
	console.log(`[GJJ_NodeArranger] Min level: ${minLevel}, arranging from X=0`);

	for (const [level, layerNodes] of layerGroups) {
		// 计算该列的 X 坐标（应用偏移）
		const adjustedLevel = level - minLevel + levelOffset;
		const x = adjustedLevel * COL_WIDTH;

		// Y 轴从上到下依次分配固定步距
		let currentY = 0;
		for (const node of layerNodes) {
			node.pos = [Math.round(x), Math.round(currentY)];
			currentY += node.size[1] + ROW_HEIGHT;
		}
	}

	// Reroute 节点保持原位不动
	console.log(`[GJJ_NodeArranger] Kept ${rerouteNodes.length} reroute nodes in place`);

	// 执行适应视图（Fit View）- 让所有节点都在可视范围内
	try {
		// 方法1: 直接调用 canvas 的 fitViewToSelection 方法（如果存在）
		if (app.canvas && typeof app.canvas.fitViewToSelection === 'function') {
			app.canvas.fitViewToSelection();
			console.log('[GJJ_NodeArranger] Fit view using fitViewToSelection API');
		}
		// 方法2: 模拟按下 '.' 键事件
		else {
			const keyEvent = new KeyboardEvent('keydown', {
				key: '.',
				code: 'Period',
				keyCode: 190,
				which: 190,
				bubbles: true,
				cancelable: true
			});
			document.dispatchEvent(keyEvent);
			console.log('[GJJ_NodeArranger] Fit view by simulating period key press');
		}
	} catch (error) {
		console.warn('[GJJ_NodeArranger] Failed to fit view:', error);
	}

	// 实时刷新画布
	app.graph.setDirtyCanvas(true, true);
	await new Promise(resolve => setTimeout(resolve, 0));

	console.log("[GJJ_NodeArranger] Arrangement completed");
}

/**
 * Blender NodeRelax 松弛功能
 * 基于连接关系的力导向布局算法
 */
async function applyRelax(nodes, iterations, relaxPower, collideDist, pullNonSiblings) {
	console.log(`[GJJ_NodeArranger] Starting relax: ${iterations} iterations, power=${relaxPower}`);

	for (let iter = 0; iter < iterations; iter++) {
		let movedCount = 0;

		for (const node of nodes) {
			if (node.type === "group") continue;

			if (calculateRelaxPosition(node, nodes, 1, relaxPower, collideDist, !pullNonSiblings)) {
				movedCount++;
			}
		}

		// 每 3 次迭代让出主线程并刷新画布，避免卡死
		if (iter % 3 === 2) {
			app.graph.setDirtyCanvas(true, true);
			await new Promise(resolve => setTimeout(resolve, 0));
		}

		// 如果几乎没有节点移动，提前结束
		if (movedCount < 2) {
			console.log(`[GJJ_NodeArranger] Converged after ${iter + 1} iterations (${movedCount} nodes moved)`);
			break;
		}
	}

	refreshAfterArrange(nodes);
	console.log(`[GJJ_NodeArranger] Relaxation completed`);
}

/**
 * 排列后刷新画布
 * 参考 ComfyUI 自带 Arrange 的实现方式
 */
function refreshAfterArrange(nodes) {
	// 关键修复：调用 graph.setDirtyCanvas 而不是 canvas.setDirty
	// 这是 ComfyUI-NodeAligner 和 comfyui-custom-scripts 的实现方式
	if (app.graph && app.graph.setDirtyCanvas) {
		app.graph.setDirtyCanvas(true, true);
	} else if (app.canvas) {
		// 备用方案
		app.canvas.setDirty(true, true);
	}
}

/**
 * 主要的节点排列函数
 */
async function arrangeNodes(mode = "auto", spacing = 100, iterations = 10,
                           relaxPower = 0.5, collisionAvoidance = true,
                           respectConnections = true, selectedOnly = false) {
	const graph = app.graph;
	if (!graph || !graph._nodes) {
		console.warn("[GJJ_NodeArranger] No graph found");
		return;
	}

	const nodes = graph._nodes;
	const validNodes = filterValidNodes(nodes, selectedOnly);

	if (validNodes.length === 0) {
		console.log("[GJJ_NodeArranger] No nodes to arrange");
		app.ui.dialog.show("没有可排列的节点");
		return;
	}

	console.log(`[GJJ_NodeArranger] Starting arrangement for ${validNodes.length} nodes`);

	// 根据不同的模式执行不同的排列策略
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
		case "auto":
		default:
			await arrangeAuto(validNodes, spacing, iterations, relaxPower, collisionAvoidance, respectConnections);
			break;
	}

	refreshAfterArrange(validNodes);

	console.log("[GJJ_NodeArranger] Arrangement completed");
}

/**
 * 添加右键菜单项
 */
function addContextMenuItems() {
	const originalGetCanvasMenuOptions = app.canvas.getCanvasMenuOptions;

	app.canvas.getCanvasMenuOptions = function() {
		const options = originalGetCanvasMenuOptions.apply(this, arguments);

		// 添加分隔线
		options.push(null);

		// 添加节点排列子菜单
		options.push({
			content: "📐 GJJ 节点排列",
			has_submenu: true,
			submenu: {
				options: [
					{
						content: "🔄 智能自动排列",
						callback: () => {
							arrangeNodes("auto", 100, 10, 0.5, true, true, false);
						}
					},
					{
						content: "🔢 拓扑排序",
						callback: () => {
							const graph = app.graph;
							if (!graph || !graph._nodes) {
								console.warn("[GJJ_NodeArranger] No graph found");
								return;
							}
							const nodes = graph._nodes;
							const validNodes = filterValidNodes(nodes, false);
							if (validNodes.length === 0) {
								console.log("[GJJ_NodeArranger] No nodes to arrange");
								app.ui.dialog.show("没有可排列的节点");
								return;
							}
							arrangeTopological(validNodes, 100);
						}
					},
					null, // 分隔线
					{
						content: "➡️ 水平排列",
						callback: () => {
							arrangeNodes("horizontal", 100);
						}
					},
					{
						content: "⬇️ 垂直排列",
						callback: () => {
							arrangeNodes("vertical", 100);
						}
					},
					{
						content: "⊞ 网格排列",
						callback: () => {
							arrangeNodes("grid", 100);
						}
					},

				]
			}
		});

		return options;
	};
}

/**
 * 添加顶部工具栏按钮
 */
function addTopBarButtons() {
	// 等待 DOM 加载完成
	setTimeout(() => {
		// 查找或创建工具栏容器
		let toolbar = document.querySelector(".comfy-menu-extra-buttons");
		if (!toolbar) {
			toolbar = document.createElement("div");
			toolbar.className = "comfy-menu-extra-buttons";
			toolbar.style.cssText = [
				"display: flex",
				"gap: 8px",
				"padding: 8px",
				"flex-wrap: wrap"
			].join(";");

			// 插入到合适的位置
			const menu = document.querySelector(".comfy-menu");
			if (menu) {
				menu.appendChild(toolbar);
			}
		}

		// 创建排列按钮
		const arrangeBtn = document.createElement("button");
		arrangeBtn.textContent = "📐 排列节点";
		arrangeBtn.title = "智能排列工作流中的节点";
		arrangeBtn.style.cssText = [
			"padding: 6px 12px",
			"border-radius: 4px",
			"border: 1px solid #41535b",
			"background: #1a252b",
			"color: #dce7e2",
			"cursor: pointer",
			"font-size: 12px",
			"transition: all 0.2s"
		].join(";");

		arrangeBtn.addEventListener("mouseenter", () => {
			arrangeBtn.style.background = "#2a353b";
		});
		arrangeBtn.addEventListener("mouseleave", () => {
			arrangeBtn.style.background = "#1a252b";
		});

		arrangeBtn.addEventListener("click", () => {
			arrangeNodes("auto", 100, 10, 0.5, true, true, false);
		});

		toolbar.appendChild(arrangeBtn);

		// 创建拓扑排序按钮
		const topoBtn = document.createElement("button");
		topoBtn.textContent = "🔢 拓扑排序";
		topoBtn.title = "基于最长主链路的拓扑排序排列节点";
		topoBtn.style.cssText = [
			"padding: 6px 12px",
			"border-radius: 4px",
			"border: 1px solid #41535b",
			"background: #1a252b",
			"color: #dce7e2",
			"cursor: pointer",
			"font-size: 12px",
			"transition: all 0.2s"
		].join(";");

		topoBtn.addEventListener("mouseenter", () => {
			topoBtn.style.background = "#2a353b";
		});
		topoBtn.addEventListener("mouseleave", () => {
			topoBtn.style.background = "#1a252b";
		});

		topoBtn.addEventListener("click", () => {
			const graph = app.graph;
			if (!graph || !graph._nodes) {
				console.warn("[GJJ_NodeArranger] No graph found");
				return;
			}
			const nodes = graph._nodes;
			const validNodes = filterValidNodes(nodes, false);
			if (validNodes.length === 0) {
				console.log("[GJJ_NodeArranger] No nodes to arrange");
				app.ui.dialog.show("没有可排列的节点");
				return;
			}
			arrangeTopological(validNodes, 100);
		});

		toolbar.appendChild(topoBtn);

		console.log("[GJJ_NodeArranger] Top bar buttons added (Arrange + Topological Sort)");
	}, 1000);
}

/**
 * 注册键盘快捷键
 */
function registerKeyboardShortcuts() {
	// 排列模式循环状态
	let arrangeModeIndex = 0;
	const arrangeModes = ["auto", "topological", "horizontal", "vertical", "grid"];
	const modeNames = ["智能排列", "拓扑排序", "水平排列", "垂直排列", "网格排列"];

	document.addEventListener("keydown", (event) => {
		// Ctrl+Shift+A: 循环切换排列模式
		if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a") {
			event.preventDefault();
			const graph = app.graph;
			if (!graph || !graph._nodes) {
				console.warn("[GJJ_NodeArranger] No graph found");
				return;
			}
			const nodes = graph._nodes;
			const validNodes = filterValidNodes(nodes, false);
			if (validNodes.length === 0) {
				console.log("[GJJ_NodeArranger] No nodes to arrange");
				app.ui.dialog.show("没有可排列的节点");
				return;
			}

			const mode = arrangeModes[arrangeModeIndex];
			console.log(`[GJJ_NodeArranger] ${modeNames[arrangeModeIndex]} (${mode})`);

			(async () => {
				try {
					switch (mode) {
						case "auto":
							await arrangeNodes("auto", 100, 10, 0.5, true, true, false);
							break;
						case "topological":
							await arrangeTopological(validNodes, 100);
							break;
						case "horizontal":
							arrangeNodes("horizontal", 100);
							break;
						case "vertical":
							arrangeNodes("vertical", 100);
							break;
						case "grid":
							arrangeNodes("grid", 100);
							break;
					}
				} catch (error) {
					console.error("[GJJ_NodeArranger] ERROR:", error);
				}
			})();

			// 切换到下一个模式
			arrangeModeIndex = (arrangeModeIndex + 1) % arrangeModes.length;
		}

		// Ctrl+Shift+H: 水平排列
		if (event.ctrlKey && event.shiftKey && event.key === "H") {
			event.preventDefault();
			arrangeNodes("horizontal", 100);
		}

		// Ctrl+Shift+V: 垂直排列
		if (event.ctrlKey && event.shiftKey && event.key === "V") {
			event.preventDefault();
			arrangeNodes("vertical", 100);
		}

		// Ctrl+Shift+G: 网格排列
		if (event.ctrlKey && event.shiftKey && event.key === "G") {
			event.preventDefault();
			arrangeNodes("grid", 100);
		}
	});
}

/**
 * 注册 ComfyUI 扩展
 */
app.registerExtension({
	name: "Comfy.GJJ.NodeArranger",

	async setup() {
		// 注册全局函数，供其他代码调用
		window.GJJ_NodeArranger = {
			arrangeNodes,
			arrangeHorizontal: (spacing = 100) => arrangeNodes("horizontal", spacing),
			arrangeVertical: (spacing = 100) => arrangeNodes("vertical", spacing),
			arrangeGrid: (spacing = 100) => arrangeNodes("grid", spacing),
			arrangeAuto: (spacing = 100, iterations = 10, relaxPower = 0.5) =>
				arrangeNodes("auto", spacing, iterations, relaxPower),
			arrangeTopological: (spacing = 100) => arrangeTopological(app.graph._nodes || [], spacing)
		};

		// 添加右键菜单
		addContextMenuItems();

		// 添加顶部工具栏按钮
		addTopBarButtons();

		// 注册键盘快捷键
		registerKeyboardShortcuts();

		// 拦截工作流保存，确保所有坐标和尺寸为整数
		const originalSerialize = app.graph.serialize.bind(app.graph);
		app.graph.serialize = function() {
			const data = originalSerialize();

			// 取整所有节点的 pos 和 size
			if (data.nodes) {
				for (const node of data.nodes) {
					if (node.pos && Array.isArray(node.pos)) {
						node.pos = [Math.round(node.pos[0]), Math.round(node.pos[1])];
					}
					if (node.size && Array.isArray(node.size)) {
						node.size = [Math.round(node.size[0]), Math.round(node.size[1])];
					}
				}
			}

			// 取整画布偏移和缩放
			if (data.extra?.ds) {
				if (data.extra.ds.offset) {
					data.extra.ds.offset = [Math.round(data.extra.ds.offset[0]), Math.round(data.extra.ds.offset[1])];
				}
				// scale 保持原样（缩放比例可以是小数）
			}

			return data;
		};

		console.log("[GJJ_NodeArranger] Extension loaded successfully");
		console.log("[GJJ_NodeArranger] Shortcuts: Ctrl+Shift+A (循环切换: 智能/拓扑/水平/垂直/网格), Ctrl+Shift+H/V/G (直接排列)");
	},

	async nodeCreated(node) {
		if (node.comfyClass === NODE_NAME) {
			// 节点创建时的初始化
			console.log("[GJJ_NodeArranger] Node created");

			// 在节点上添加一个快捷按钮
			setTimeout(() => {
				const arrangeBtn = document.createElement("button");
				arrangeBtn.textContent = "📐 立即排列";
				arrangeBtn.style.cssText = [
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
					"transition: all 0.2s"
				].join(";");

				arrangeBtn.addEventListener("click", () => {
					arrangeNodes("auto", 100, 10, 0.5, true, true, false);
				});

				arrangeBtn.addEventListener("mouseenter", () => {
					arrangeBtn.style.opacity = "0.85";
				});
				arrangeBtn.addEventListener("mouseleave", () => {
					arrangeBtn.style.opacity = "1";
				});

				// 将按钮添加到节点元素中
				if (node.widgets?.[0]?.element) {
					node.widgets[0].element.parentNode.appendChild(arrangeBtn);
				}
			}, 100);
		}
	}
});
