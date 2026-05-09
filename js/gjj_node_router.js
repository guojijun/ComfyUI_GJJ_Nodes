// GJJ NodeRouter v2.1 - DOM Widget 清理修复（保留container，清空子元素）
import { app } from "/scripts/app.js";

// 目标节点
const TARGET_NODES = new Set(["GJJ_NodeRouter"]);

// 模式常量
const MODE_SINGLE = "单选";
const MODE_MULTI = "多选";
const MODE_VALUES = [MODE_SINGLE, MODE_MULTI];
const MODE_NAME = "选择模式";

// 过滤关键词常量
const FILTER_NAME = "过滤关键词";
const FILTER_LABEL = "过滤关键词";
const FILTER_PLACEHOLDER = "留空显示全部节点";
const FILTER_TOOLTIP = "输入节点名称中的关键词进行筛选；留空时显示当前工作流中的全部节点。";

// 空状态常量
const EMPTY_STATE_NAME = "节点状态提示";
const EMPTY_STATE_LABEL = "节点状态提示";
const EMPTY_STATE_TEXT = "当前没有节点，或没有匹配到包含该关键词的节点。";
const EMPTY_STATE_TOOLTIP = "没有可切换的节点时，会在这里显示中文状态提示。";

// 存储每个节点的状态
const nodeStates = new Map();

function ensureNodeState(node) {
	if (!nodeStates.has(node.id)) {
		nodeStates.set(node.id, {
			[MODE_NAME]: MODE_SINGLE,
			[FILTER_NAME]: "",
			__activeNodeRefs: new Set(),
		});
	}
	return nodeStates.get(node.id);
}

function getNodes() {
	return Array.isArray(app.graph?._nodes) ? [...app.graph._nodes] : [];
}

function getNodeSignature(nodes = getNodes()) {
	return nodes
		.map((node) => {
			const title = String(node?.title || node?.comfyClass || "");
			const left = Number(node?.pos?.[0] || 0);
			const top = Number(node?.pos?.[1] || 0);
			const width = Number(node?.size?.[0] || 0);
			const height = Number(node?.size?.[1] || 0);
			return `${title}|${left},${top}|${width},${height}`;
		})
		.sort()
		.join("||");
}

function sortNodes(nodes) {
	return [...nodes].sort((a, b) => String(a?.title || a?.comfyClass || "").localeCompare(String(b?.title || b?.comfyClass || ""), "zh-Hans-CN"));
}

function getFilterText(node) {
	return String(ensureNodeState(node)[FILTER_NAME] || "").trim().toLowerCase();
}

function getMatchedNodes(node) {
	const filterText = getFilterText(node);
	const nodes = sortNodes(getNodes().filter(n => n !== node));
	if (!filterText) {
		return nodes;
	}

	return nodes.filter((n) => {
		const title = String(n?.title || n?.comfyClass || "").toLowerCase();
		const category = String(n?.constructor?.nodeData?.category || n?.nodeData?.category || "").toLowerCase();
		const comfyClass = String(n?.comfyClass || "").toLowerCase();

		return title.includes(filterText) ||
			   category.includes(filterText) ||
			   comfyClass.includes(filterText);
	});
}

function getToggleWidgets(node) {
	return (node.widgets || []).filter((widget) => widget?.__gjjNodeToggle);
}

function getSelectionMode(node) {
	const state = ensureNodeState(node);
	const value = String(state[MODE_NAME] || MODE_SINGLE);
	return MODE_VALUES.includes(value) ? value : MODE_SINGLE;
}

function updateSelectionMode(node, mode) {
	const state = ensureNodeState(node);
	state[MODE_NAME] = MODE_VALUES.includes(mode) ? mode : MODE_SINGLE;
}

function updateFilterText(node, text) {
	ensureNodeState(node)[FILTER_NAME] = String(text || "");
}

function getActiveNodeRefs(node) {
	const state = ensureNodeState(node);
	return state.__activeNodeRefs || new Set();
}

function setActiveNodeRefs(node, nodes) {
	const state = ensureNodeState(node);
	const nodeList = Array.isArray(nodes) ? nodes.filter(Boolean) : [...(nodes || [])].filter(Boolean);
	state.__activeNodeRefs = new Set(nodeList);
}

function trimActiveNodesForMode(node) {
	const activeNodes = [...getActiveNodeRefs(node)];
	if (getSelectionMode(node) === MODE_SINGLE && activeNodes.length > 1) {
		setActiveNodeRefs(node, [activeNodes[0]]);
	}
}

function setNodeState(targetNode, isActive, controllerNode) {
	if (targetNode === controllerNode) return;
	targetNode.mode = isActive ? 0 : 2;
}

function releaseManagedNodes(node, nextNodes = []) {
	const nextNodeSet = new Set(nextNodes);
	const previousNodes = Array.isArray(node.__gjjManagedNodes) ? node.__gjjManagedNodes : [];
	previousNodes.forEach((n) => {
		if (!nextNodeSet.has(n)) {
			setNodeState(n, false, node);
		}
	});
	node.__gjjManagedNodes = [...nextNodes];
}

function applyMatchedNodeModes(node, nodes = getMatchedNodes(node)) {
	if (!Array.isArray(nodes) || nodes.length === 0) {
		return;
	}

	trimActiveNodesForMode(node);
	const activeNodes = getActiveNodeRefs(node);
	nodes.forEach((n) => {
		setNodeState(n, activeNodes.has(n), node);
	});
}

function syncFilterToOriginalWidget(node) {
	const filterWidget = (node.widgets || []).find((w) => w?.name === FILTER_NAME && w.type !== "HTML");
	const currentFilter = getFilterText(node);
	if (filterWidget && filterWidget.value !== currentFilter) {
		filterWidget.value = String(currentFilter || "");
		if (filterWidget.inputEl) {
			filterWidget.inputEl.value = String(currentFilter || "");
		}
		filterWidget.callback?.(currentFilter);
	}
}



function hydrateStateFromSerialized(node, serialized) {
	const state = ensureNodeState(node);
	const values = Array.isArray(serialized?.widgets_values) ? serialized.widgets_values : [];

	// 尝试从 properties 恢复，如果没有则从 widgets_values 恢复
	const savedMode = serialized?.properties?.[MODE_NAME];
	if (savedMode && MODE_VALUES.includes(savedMode)) {
		state[MODE_NAME] = savedMode;
	} else if (values.length > 1 && MODE_VALUES.includes(String(values[1]))) {
		state[MODE_NAME] = String(values[1]);
	}

	const savedFilter = serialized?.properties?.[FILTER_NAME];
	if (savedFilter !== undefined) {
		state[FILTER_NAME] = String(savedFilter);
	} else if (values.length > 0) {
		state[FILTER_NAME] = String(values[0] || "");
	}
}


function makeDomWidgetSize(widget, height) {
	widget.serialize = false;
	widget.computeSize = (width) => [Math.max(180, Number(width || 180)), height];
	widget.getHeight = () => height;
	return widget;
}

function selectAllNodes(node) {
	const matchedNodes = getMatchedNodes(node);
	setActiveNodeRefs(node, matchedNodes);
	syncNodeButtonStates(node, new Set(matchedNodes));
	applyMatchedNodeModes(node);
	updateMasterToggleButton(node);
	node.graph?.change?.();
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function deselectAllNodes(node) {
	setActiveNodeRefs(node, []);
	syncNodeButtonStates(node, new Set());
	applyMatchedNodeModes(node);
	updateMasterToggleButton(node);
	node.graph?.change?.();
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function isAllNodesSelected(node) {
	const matchedNodes = getMatchedNodes(node);
	if (matchedNodes.length === 0) return false;
	const activeNodes = getActiveNodeRefs(node);
	return matchedNodes.every(n => activeNodes.has(n));
}

function updateMasterToggleButton(node) {
	const toggleBtn = node.__gjjMasterToggleBtn;
	if (!toggleBtn) return;

	const allSelected = isAllNodesSelected(node);
	toggleBtn.textContent = allSelected ? "🟢" : "🔴";
	toggleBtn.title = allSelected ? "点击全部启用" : "点击全部禁用";
	toggleBtn.style.background = allSelected ? "#3d7c47" : "#8b2a2a";
}

function updateMasterToggleVisibility(node) {
	const toggleBtn = node.__gjjMasterToggleBtn;
	if (!toggleBtn) return;

	toggleBtn.style.display = getSelectionMode(node) === MODE_MULTI ? "block" : "none";
}

// 使用并排切换按钮替代下拉框（类似ReActor的OFF/ON）
function buildModeControls(node) {
	const state = ensureNodeState(node);
	const currentMode = state[MODE_NAME];

	// 创建模式切换按钮容器
	const container = document.createElement("div");
	container.className = "gjj-mode-toggle-container";
	container.style.cssText = [
		"box-sizing:border-box",
		"width:100%",
		"display:flex",
		"gap:4px",
		"padding:4px 0",
		"margin:0",
	].join(";");

	// 创建两个按钮：单选和多选
	MODE_VALUES.forEach((modeValue) => {
		const isActive = modeValue === currentMode;
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = modeValue;
		button.className = isActive ? "gjj-mode-btn gjj-mode-btn-active" : "gjj-mode-btn";
		button.style.cssText = [
			"flex:1",
			"height:32px",
			"padding:6px 12px",
			"border:1px solid #3b5560",
			"border-radius:6px",
			"background:#2a3f4a",
			"color:#edf6fa",
			"font:700 13px sans-serif",
			"cursor:pointer",
			"transition:all 0.2s ease",
			isActive ? "background:#2d5a9e;border-color:#5aa8ff;color:#fff" : "",
		].join(";");

		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();

			// 更新模式
			updateSelectionMode(node, modeValue);

			// 处理单选模式下的节点状态
			let activeNodes = getActiveNodeRefs(node);
			if (modeValue === MODE_SINGLE && activeNodes.size > 1) {
				const firstNode = [...activeNodes][0];
				activeNodes = new Set(firstNode ? [firstNode] : []);
			}
			setActiveNodeRefs(node, activeNodes);

			// 同步所有节点按钮状态
			syncNodeButtonStates(node, activeNodes);
			applyMatchedNodeModes(node);

			// 更新按钮样式
			container.querySelectorAll(".gjj-mode-btn").forEach(btn => {
				const btnMode = btn.textContent;
				const isBtnActive = btnMode === modeValue;
				btn.className = isBtnActive ? "gjj-mode-btn gjj-mode-btn-active" : "gjj-mode-btn";
				btn.style.background = isBtnActive ? "#2d5a9e" : "#2a3f4a";
				btn.style.borderColor = isBtnActive ? "#5aa8ff" : "#3b5560";
				btn.style.color = isBtnActive ? "#fff" : "#edf6fa";
			});

			// 更新主切换按钮的可见性
			updateMasterToggleVisibility(node);

			node.graph?.change?.();
			node.setDirtyCanvas?.(true, true);
			app.graph?.setDirtyCanvas?.(true, true);
		});

		container.appendChild(button);
	});

	// 创建主切换按钮（与模式按钮同一行）
	const masterToggleBtn = document.createElement("button");
	masterToggleBtn.type = "button";
	masterToggleBtn.className = "gjj-master-toggle-btn";
	const allSelected = isAllNodesSelected(node);
	masterToggleBtn.textContent = allSelected ? "🟢" : "🔴";
	masterToggleBtn.title = allSelected ? "点击全部启用" : "点击全部禁用";
	masterToggleBtn.style.cssText = [
		"height:32px",
		"width:40px",
		"padding:0",
		"border:1px solid #3b5560",
		"border-radius:6px",
		"background:" + (allSelected ? "#3d7c47" : "#8b2a2a"),
		"color:#fff",
		"font:700 16px sans-serif",
		"cursor:pointer",
		"transition:all 0.2s ease",
		"display:" + (currentMode === MODE_MULTI ? "block" : "none"),
	].join(";");

	masterToggleBtn.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();

		if (isAllNodesSelected(node)) {
			deselectAllNodes(node);
		} else {
			selectAllNodes(node);
		}
	});

	node.__gjjMasterToggleBtn = masterToggleBtn;
	container.appendChild(masterToggleBtn);

	// 添加DOM Widget（使用 _UI 后缀避免与 Python 后端的 widget 名称冲突）
	const modeWidget = node.addDOMWidget(MODE_NAME + "_UI", "HTML", container, {
		serialize: false,
		hideOnZoom: false,
	});

	modeWidget.value = currentMode;
	modeWidget.__gjjModeToggle = true;

	return modeWidget;
}

function createNodeButtonWidget(node, targetNode, isActive) {
	const title = String(targetNode?.title || targetNode?.comfyClass || "未命名节点");

	// 创建独立的专用容器，避免与其他元素冲突
	const container = document.createElement("div");
	container.id = `gjj-node-${node.id}-${targetNode.id}`;
	container.className = "gjj-node-router-row";
	container.style.cssText = [
		"box-sizing:border-box",
		"width:100%",
		"display:flex",
		"padding:3px 0 5px",
		"margin:0",
		"position:relative",
		"z-index:9998",
		"pointer-events:auto",
	].join(";");

	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-node-button";
	button.textContent = `${isActive ? "✅ " : "❌ "}${title}`;
	button.title = `切换节点"${title}"的启用状态；单选模式下互斥，多选模式下可同时启用多个节点。`;
	button.dataset.nodeId = targetNode.id; // 使用 data 属性存储节点 ID

	updateButtonClass(button, isActive);

	container.appendChild(button);

	const domWidget = makeDomWidgetSize(node.addDOMWidget(title, "HTML", container, {
		serialize: false,
		hideOnZoom: false,
	}), 36);

	domWidget.value = Boolean(isActive);
	domWidget.__gjjNodeToggle = true;
	domWidget.__nodeRef = targetNode;
	domWidget.__buttonEl = button;

	const toggle = () => {
		const activeNodes = getActiveNodeRefs(node);
		const isCurrentlyActive = activeNodes.has(targetNode);
		const newState = !isCurrentlyActive;

		if (newState) {
			if (getSelectionMode(node) === MODE_SINGLE) {
				activeNodes.clear();
			}
			activeNodes.add(targetNode);
		} else {
			activeNodes.delete(targetNode);
		}

		setActiveNodeRefs(node, activeNodes);
		domWidget.value = newState;
		syncNodeButtonStates(node, activeNodes);
		applyMatchedNodeModes(node);
		updateMasterToggleButton(node);

		node.graph?.change?.();
		node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	};

	// 使用事件委托，只绑定一次click事件
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		toggle();
	});

	// 保护 DOM widget 不被 Canvas 事件捕获
	if (container && typeof container.addEventListener === "function") {
		const stopCanvasCapture = (event) => {
			event.stopPropagation();
		};
		for (const eventName of ["pointerdown", "mousedown", "dblclick", "contextmenu", "wheel"]) {
			container.addEventListener(eventName, stopCanvasCapture);
		}
	}

	return domWidget;
}

function buildFilterWidget(node) {
	const value = ensureNodeState(node)[FILTER_NAME] || "";
	const widget = node.addWidget(
		"text",
		FILTER_LABEL,
		value,
		(newValue) => {
			updateFilterText(node, newValue);

			// 同步到原始的 Python widget（如果存在）
			const originalWidget = (node.widgets || []).find((w) => w?.name === FILTER_NAME && w !== widget);
			if (originalWidget) {
				originalWidget.value = String(newValue || "");
				if (originalWidget.inputEl) {
					originalWidget.inputEl.value = String(newValue || "");
				}
				originalWidget.callback?.(newValue);
			}

			// 使用setTimeout确保DOM更新完成后再重建UI
			setTimeout(() => {
				rebuildUI(node);
				refreshNodeSize(node);
			}, 10);
		},
		{ placeholder: FILTER_PLACEHOLDER },
	);
	widget.name = FILTER_NAME;
	widget.label = FILTER_LABEL;
	widget.tooltip = FILTER_TOOLTIP;
	return widget;
}

function addEmptyState(node) {
	const widget = node.addWidget(
		"text",
		EMPTY_STATE_LABEL,
		EMPTY_STATE_TEXT,
		() => {},
		{ multiline: true },
	);
	widget.name = EMPTY_STATE_NAME;
	widget.label = EMPTY_STATE_LABEL;
	widget.tooltip = EMPTY_STATE_TOOLTIP;
	widget.disabled = true;
	widget.serialize = false;
	if (widget.inputEl) {
		widget.inputEl.readOnly = true;
	}
	return widget;
}

function addNodeToggle(node, targetNode, isActive) {
	return createNodeButtonWidget(node, targetNode, isActive);
}

function refreshNodeSize(node) {
	node.size = [node.size[0], node.computeSize()[1]];
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function rebuildUI(node) {
	const previousActiveNodes = getActiveNodeRefs(node);

	clearNodeWidgets(node);

	buildModeControls(node);
	buildFilterWidget(node);

	// 确保关键词值同步到原始 Python widget
	syncFilterToOriginalWidget(node);

	const matchedNodes = getMatchedNodes(node);
	releaseManagedNodes(node, matchedNodes);
	if (matchedNodes.length === 0) {
		setActiveNodeRefs(node, []);
		addEmptyState(node);
		node.__gjjNodeSignature = getNodeSignature();
		refreshNodeSize(node);
		return;
	}

	let restoredActiveNodes = matchedNodes.filter((n) => previousActiveNodes.has(n));
	if (getSelectionMode(node) === MODE_SINGLE) {
		restoredActiveNodes = restoredActiveNodes.slice(0, 1);
	}
	setActiveNodeRefs(node, restoredActiveNodes);

	matchedNodes.forEach((n) => {
		const isActive = restoredActiveNodes.includes(n);
		addNodeToggle(node, n, isActive);
	});

	node.__gjjNodeSignature = getNodeSignature();
	applyMatchedNodeModes(node, matchedNodes);
	refreshNodeSize(node);
}

function refreshAllNodeRouters() {
	(app.graph?._nodes || []).forEach((node) => {
		if (TARGET_NODES.has(node?.comfyClass)) {
			rebuildUI(node);
		}
	});
}

app.registerExtension({
	name: "GJJ.NodeRouter",

	nodeCreated(node, app) {
		if (!TARGET_NODES.has(node.comfyClass)) {
			return;
		}

		requestAnimationFrame(() => {
			rebuildUI(node);
			// 添加帮助按钮
			if (typeof window.__gjjEnsureHelpWidget === "function") {
				window.__gjjEnsureHelpWidget(node);
			}
		});
	},

	async beforeRegisterNodeDef(nodeType, nodeData, app) {
		if (!TARGET_NODES.has(nodeData.name)) {
			return;
		}

		const originalOnConfigure = nodeType.prototype.onConfigure;

		// onSerialize：选择模式和过滤关键词存到 properties（不再依赖隐藏 combo widget）
		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function(serializedNode) {
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			serializedNode.properties = serializedNode.properties || {};
			serializedNode.properties[MODE_NAME] = ensureNodeState(this)[MODE_NAME];
			serializedNode.properties[FILTER_NAME] = ensureNodeState(this)[FILTER_NAME];
			return result;
		};

		nodeType.prototype.onConfigure = function(serialized) {
			if (originalOnConfigure) {
				originalOnConfigure.call(this, serialized);
			}
			hydrateStateFromSerialized(this, serialized);
			// 使用 requestAnimationFrame 确保 app.graph._nodes 已初始化后再重建 UI
			requestAnimationFrame(() => {
				rebuildUI(this);
			});
		};

		const originalOnExecutionStart = nodeType.prototype.onExecutionStart;

		nodeType.prototype.onExecutionStart = function() {
			if (originalOnExecutionStart) {
				originalOnExecutionStart.call(this);
			}
			applyMatchedNodeModes(this);
		};

		// Hook addDOMWidget to protect DOM widgets
		const originalAddDOMWidget = nodeType.prototype.addDOMWidget;
		if (originalAddDOMWidget) {
			nodeType.prototype.addDOMWidget = function(...args) {
				const widget = originalAddDOMWidget.apply(this, args);
				// 保护DOM widget不被Canvas事件捕获
				if (widget?.element && typeof widget.element.addEventListener === "function") {
					const stopCanvasCapture = (event) => {
						event.stopPropagation();
					};
					for (const eventName of ["pointerdown", "mousedown", "dblclick", "contextmenu", "wheel"]) {
						widget.element.addEventListener(eventName, stopCanvasCapture);
					}
				}
				return widget;
			};
		}
	},

	async setup() {
		const originalAddNode = app.graph?.addNode;
		if (originalAddNode) {
			app.graph.addNode = function(...args) {
				const result = originalAddNode.apply(this, args);
				refreshAllNodeRouters();
				return result;
			};
		}

		let rebuildTimer = null;
		const scheduleRebuild = () => {
			if (rebuildTimer) {
				clearTimeout(rebuildTimer);
			}
			rebuildTimer = setTimeout(() => {
				refreshAllNodeRouters();
				rebuildTimer = null;
			}, 100);
		};

		const originalOnNodeMoved = app.graph?.onNodeMoved;
		app.graph.onNodeMoved = function(node) {
			if (originalOnNodeMoved) {
				originalOnNodeMoved.call(this, node);
			}
			scheduleRebuild();
		};

		const originalOnNodeAdded = app.graph?.onNodeAdded;
		app.graph.onNodeAdded = function(node) {
			if (originalOnNodeAdded) {
				originalOnNodeAdded.call(this, node);
			}
			scheduleRebuild();
		};

		const originalOnNodeRemoved = app.graph?.onNodeRemoved;
		app.graph.onNodeRemoved = function(node) {
			if (originalOnNodeRemoved) {
				originalOnNodeRemoved.call(this, node);
			}
			scheduleRebuild();
		};
	}
});

function clearNodeWidgets(node) {
	const widgets = Array.isArray(node.widgets) ? node.widgets : [];

	for (const widget of widgets) {
		if (widget?.inputEl instanceof HTMLElement) {
			widget.inputEl.remove();
		}

		if (widget?.element instanceof HTMLElement) {
			// 清空 container 的所有子元素，保留 container 本身
			while (widget.element.firstChild) {
				widget.element.removeChild(widget.element.firstChild);
			}
		}

		// 清理自定义属性引用
		if (widget.__buttonEl) {
			widget.__buttonEl = null;
		}
		if (widget.__nodeRef) {
			widget.__nodeRef = null;
		}
	}

	node.widgets = [];
}

function syncNodeButtonStates(node, activeNodes = getActiveNodeRefs(node)) {
	getToggleWidgets(node).forEach((widget) => {
		if (!widget.__buttonEl || !widget.__nodeRef) {
			return;
		}

		const isActive = activeNodes.has(widget.__nodeRef);
		const title = String(widget.__nodeRef?.title || widget.__nodeRef?.comfyClass || "未命名节点");

		widget.value = isActive;
		widget.__buttonEl.textContent = `${isActive ? "✅ " : "❌ "}${title}`;
		updateButtonClass(widget.__buttonEl, isActive);
	});
}

function ensureNodeButtonStyles(container) {
	const styleId = "gjj-node-router-styles";
	const existingStyle = document.getElementById(styleId);
	if (existingStyle) {
		return;
	}

	const style = document.createElement("style");
	style.id = styleId;

	style.textContent = `
		.gjj-node-router-row {
			position: relative !important;
			z-index: 9998 !important;
			pointer-events: auto !important;
		}
		.gjj-node-button {
			flex: 1 1 0 !important;
			height: 30px !important;
			min-width: 0 !important;
			padding: 5px 8px !important;
			border-radius: 5px !important;
			border: 1px solid #3b5560 !important;
			background: #20323a !important;
			color: #edf6fa !important;
			font: 700 12px sans-serif !important;
			cursor: pointer !important;
			outline: none !important;
			-webkit-appearance: none !important;
			-moz-appearance: none !important;
			appearance: none !important;
			box-shadow: none !important;
			position: relative !important;
			z-index: 9999 !important;
			pointer-events: auto !important;
		}
		.gjj-node-button:hover {
			background: #2a4a55 !important;
			border-color: #4a6b78 !important;
		}
		.gjj-node-button.gjj-active {
			background: #1f6b43 !important;
			border-color: #48ad73 !important;
			color: #fff !important;
		}
	`;
	document.head.appendChild(style);
}

if (document.head) {
	ensureNodeButtonStyles(document.body);
} else {
	document.addEventListener("DOMContentLoaded", () => {
		ensureNodeButtonStyles(document.body);
	});
}

function updateButtonClass(button, isActive) {
	if (!button) {
		return;
	}

	if (isActive) {
		button.classList.add("gjj-active");
	} else {
		button.classList.remove("gjj-active");
	}
}
