import { app } from "/scripts/app.js";

// 目标节点
const TARGET_NODES = new Set(["GJJ_GroupBypasser"]);

// 模式常量
const MODE_SINGLE = "单选";
const MODE_MULTI = "多选";
const MODE_VALUES = [MODE_SINGLE, MODE_MULTI];
const MODE_NAME = "选择模式";

// 过滤关键词常量
const FILTER_NAME = "过滤关键词";
const FILTER_LABEL = "过滤关键词";
const FILTER_PLACEHOLDER = "留空显示全部分组";
const FILTER_TOOLTIP = "输入分组名称中的关键词进行筛选；留空时显示当前工作流中的全部分组。";

// 空状态常量
const EMPTY_STATE_NAME = "分组状态提示";
const EMPTY_STATE_LABEL = "分组状态提示";
const EMPTY_STATE_TEXT = "当前没有分组，或没有匹配到包含该关键词的分组。";
const EMPTY_STATE_TOOLTIP = "没有可切换的分组时，会在这里显示中文状态提示。";

// 存储每个节点的状态
const nodeStates = new Map();

function ensureNodeState(node) {
	if (!nodeStates.has(node.id)) {
		nodeStates.set(node.id, {
			[MODE_NAME]: MODE_SINGLE,
			[FILTER_NAME]: "",
			__activeGroupRefs: new Set(),
		});
	}
	return nodeStates.get(node.id);
}

function getGroups() {
	return Array.isArray(app.graph?._groups) ? [...app.graph._groups] : [];
}

function getGroupSignature(groups = getGroups()) {
	return groups
		.map((group) => {
			const title = String(group?.title || "");
			const left = Number(group?.pos?.[0] || 0);
			const top = Number(group?.pos?.[1] || 0);
			const width = Number(group?.size?.[0] || 0);
			const height = Number(group?.size?.[1] || 0);
			const nodeCount = Array.isArray(group?._nodes) ? group._nodes.length : 0;
			return `${title}|${left},${top}|${width},${height}|${nodeCount}`;
		})
		.sort()
		.join("||");
}

function sortGroups(groups) {
	return [...groups].sort((a, b) => String(a?.title || "").localeCompare(String(b?.title || ""), "zh-Hans-CN"));
}

function getFilterText(node) {
	return String(ensureNodeState(node)[FILTER_NAME] || "").trim().toLowerCase();
}

function getMatchedGroups(node) {
	const filterText = getFilterText(node);
	const groups = sortGroups(getGroups());
	if (!filterText) {
		return groups;
	}

	return groups.filter((group) => String(group?.title || "").toLowerCase().includes(filterText));
}

function getToggleWidgets(node) {
	return (node.widgets || []).filter((widget) => widget?.__gjjGroupToggle);
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

function getActiveGroupRefs(node) {
	const state = ensureNodeState(node);
	return state.__activeGroupRefs || new Set();
}

function setActiveGroupRefs(node, groups) {
	const state = ensureNodeState(node);
	const groupList = Array.isArray(groups) ? groups.filter(Boolean) : [...(groups || [])].filter(Boolean);
	state.__activeGroupRefs = new Set(groupList);
}

function trimActiveGroupsForMode(node) {
	const activeGroups = [...getActiveGroupRefs(node)];
	if (getSelectionMode(node) === MODE_SINGLE && activeGroups.length > 1) {
		setActiveGroupRefs(node, [activeGroups[0]]);
	}
}

function setGroupState(group, isActive, controllerNode) {
	group?.recomputeInsideNodes?.();
	const nodes = Array.isArray(group?._nodes) ? group._nodes : [];
	nodes.forEach((item) => {
		if (item === controllerNode) return;
		item.mode = isActive ? 0 : 4;
	});
}

function releaseManagedGroups(node, nextGroups = []) {
	const nextGroupSet = new Set(nextGroups);
	const previousGroups = Array.isArray(node.__gjjManagedGroups) ? node.__gjjManagedGroups : [];
	previousGroups.forEach((group) => {
		if (!nextGroupSet.has(group)) {
			setGroupState(group, false);
		}
	});
	node.__gjjManagedGroups = [...nextGroups];
}

function applyMatchedGroupModes(node, groups = getMatchedGroups(node)) {
	if (!Array.isArray(groups) || groups.length === 0) {
		return;
	}

	trimActiveGroupsForMode(node);
	const activeGroups = getActiveGroupRefs(node);
	groups.forEach((group) => {
		setGroupState(group, activeGroups.has(group), node);
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
		"gap:0",
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
			"background:#20323a",
			"color:#edf6fa",
			"font:700 13px sans-serif",
			"cursor:pointer",
			"transition:all 0.2s ease",
			isActive ? "background:#1f6b43;border-color:#48ad73;color:#fff" : "",
		].join(";");
		
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			
			// 更新模式
			updateSelectionMode(node, modeValue);
			
			// 处理单选模式下的分组状态
			let activeGroups = getActiveGroupRefs(node);
			if (modeValue === MODE_SINGLE && activeGroups.size > 1) {
				const firstGroup = [...activeGroups][0];
				activeGroups = new Set(firstGroup ? [firstGroup] : []);
			}
			setActiveGroupRefs(node, activeGroups);
			
			// 同步所有分组按钮状态
			syncGroupButtonStates(node, activeGroups);
			applyMatchedGroupModes(node);
			
			// 更新按钮样式
			container.querySelectorAll(".gjj-mode-btn").forEach(btn => {
				const btnMode = btn.textContent;
				const isBtnActive = btnMode === modeValue;
				btn.className = isBtnActive ? "gjj-mode-btn gjj-mode-btn-active" : "gjj-mode-btn";
				btn.style.background = isBtnActive ? "#1f6b43" : "#20323a";
				btn.style.borderColor = isBtnActive ? "#48ad73" : "#3b5560";
				btn.style.color = isBtnActive ? "#fff" : "#edf6fa";
			});
			
			node.graph?.change?.();
			node.setDirtyCanvas?.(true, true);
			app.graph?.setDirtyCanvas?.(true, true);
		});
		
		container.appendChild(button);
	});
	
	// 添加DOM Widget
	const modeWidget = node.addDOMWidget(MODE_NAME, "HTML", container, {
		serialize: false,
		hideOnZoom: false,
	});
	
	modeWidget.value = currentMode;
	modeWidget.__gjjModeToggle = true;
	
	return modeWidget;
}

function createGroupButtonWidget(node, group, isActive) {
	const title = String(group?.title || "未命名分组");

	// 创建独立的专用容器，避免与其他元素冲突
	const container = document.createElement("div");
	container.id = `gjj-group-${node.id}-${group.id}`;
	container.className = "gjj-group-bypasser-row";
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
	button.className = "gjj-group-button";
	button.textContent = `${isActive ? "✅ " : "❌ "}${title}`;
	button.title = `切换分组"${title}"的启用状态；单选模式下互斥，多选模式下可同时启用多个分组。`;
	button.dataset.groupId = group.id; // 使用 data 属性存储分组 ID

	updateButtonClass(button, isActive);

	container.appendChild(button);

	const domWidget = makeDomWidgetSize(node.addDOMWidget(title, "HTML", container, {
		serialize: false,
		hideOnZoom: false,
	}), 36);

	domWidget.value = Boolean(isActive);
	domWidget.__gjjGroupToggle = true;
	domWidget.__groupRef = group;
	domWidget.__buttonEl = button;

	const toggle = () => {
		const activeGroups = getActiveGroupRefs(node);
		const isCurrentlyActive = activeGroups.has(group);
		const newState = !isCurrentlyActive;

		if (newState) {
			if (getSelectionMode(node) === MODE_SINGLE) {
				activeGroups.clear();
			}
			activeGroups.add(group);
		} else {
			activeGroups.delete(group);
		}

		setActiveGroupRefs(node, activeGroups);
		domWidget.value = newState;
		syncGroupButtonStates(node, activeGroups);
		applyMatchedGroupModes(node);

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

function addGroupToggle(node, group, isActive) {
	return createGroupButtonWidget(node, group, isActive);
}

function refreshNodeSize(node) {
	node.size = [node.size[0], node.computeSize()[1]];
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function rebuildUI(node) {
	const previousActiveGroups = getActiveGroupRefs(node);

	clearNodeWidgets(node);

	buildModeControls(node);
	buildFilterWidget(node);
	
	// 确保关键词值同步到原始 Python widget
	syncFilterToOriginalWidget(node);

	const matchedGroups = getMatchedGroups(node);
	releaseManagedGroups(node, matchedGroups);
	if (matchedGroups.length === 0) {
		setActiveGroupRefs(node, []);
		addEmptyState(node);
		node.__gjjGroupSignature = getGroupSignature();
		refreshNodeSize(node);
		return;
	}

	let restoredActiveGroups = matchedGroups.filter((group) => previousActiveGroups.has(group));
	if (getSelectionMode(node) === MODE_SINGLE) {
		restoredActiveGroups = restoredActiveGroups.slice(0, 1);
	}
	setActiveGroupRefs(node, restoredActiveGroups);

	matchedGroups.forEach((group) => {
		const isActive = restoredActiveGroups.includes(group);
		addGroupToggle(node, group, isActive);
	});

	node.__gjjGroupSignature = getGroupSignature();
	applyMatchedGroupModes(node, matchedGroups);
	refreshNodeSize(node);
}

function refreshAllGroupBypassers() {
	(app.graph?._nodes || []).forEach((node) => {
		if (TARGET_NODES.has(node?.comfyClass)) {
			rebuildUI(node);
		}
	});
}

app.registerExtension({
	name: "GJJ.GroupBypasser",

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

		// onSerialize：选择模式存到 properties（不再依赖隐藏 combo widget）
		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function(serializedNode) {
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			serializedNode.properties = serializedNode.properties || {};
			serializedNode.properties[MODE_NAME] = ensureNodeState(this)[MODE_NAME];
			return result;
		};

		nodeType.prototype.onConfigure = function(serialized) {
			if (originalOnConfigure) {
				originalOnConfigure.call(this, serialized);
			}
			hydrateStateFromSerialized(this, serialized);
		};

		const originalOnExecutionStart = nodeType.prototype.onExecutionStart;

		nodeType.prototype.onExecutionStart = function() {
			if (originalOnExecutionStart) {
				originalOnExecutionStart.call(this);
			}
			applyMatchedGroupModes(this);
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
		const originalAddGroup = app.graph?.addGroup;
		if (originalAddGroup) {
			app.graph.addGroup = function(...args) {
				const result = originalAddGroup.apply(this, args);
				refreshAllGroupBypassers();
				return result;
			};
		}

		let rebuildTimer = null;
		const scheduleRebuild = () => {
			if (rebuildTimer) {
				clearTimeout(rebuildTimer);
			}
			rebuildTimer = setTimeout(() => {
				refreshAllGroupBypassers();
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

		const originalOnGroupAdd = app.graph?.onGroupAdd;
		app.graph.onGroupAdd = function(group) {
			if (originalOnGroupAdd) {
				originalOnGroupAdd.call(this, group);
			}
			scheduleRebuild();
		};

		const originalOnGroupRemove = app.graph?.onGroupRemove;
		app.graph.onGroupRemove = function(group) {
			if (originalOnGroupRemove) {
				originalOnGroupRemove.call(this, group);
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
			// 清理事件监听器，避免内存泄漏
			const element = widget.element;
			
			// 如果元素有 cloneNode 方法，可以用它来清除所有事件监听器
			if (typeof element.cloneNode === "function") {
				const cleanElement = element.cloneNode(true);
				if (element.parentNode) {
					element.parentNode.replaceChild(cleanElement, element);
				}
			} else {
				element.remove();
			}
		}
		
		// 清理自定义属性引用
		if (widget.__buttonEl) {
			widget.__buttonEl = null;
		}
		if (widget.__groupRef) {
			widget.__groupRef = null;
		}
	}

	node.widgets = [];
}

function syncGroupButtonStates(node, activeGroups = getActiveGroupRefs(node)) {
	getToggleWidgets(node).forEach((widget) => {
		if (!widget.__buttonEl || !widget.__groupRef) {
			return;
		}

		const isActive = activeGroups.has(widget.__groupRef);
		const title = String(widget.__groupRef?.title || "未命名分组");

		widget.value = isActive;
		widget.__buttonEl.textContent = `${isActive ? "✅ " : "❌ "}${title}`;
		updateButtonClass(widget.__buttonEl, isActive);
	});
}

function ensureGroupButtonStyles(container) {
	const styleId = "gjj-group-bypasser-styles";
	const existingStyle = document.getElementById(styleId);
	if (existingStyle) {
		return;
	}

	const style = document.createElement("style");
	style.id = styleId;

	style.textContent = `
		.gjj-group-bypasser-row {
			position: relative !important;
			z-index: 9998 !important;
			pointer-events: auto !important;
		}
		.gjj-group-button {
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
		.gjj-group-button:hover {
			background: #2a4a55 !important;
			border-color: #4a6b78 !important;
		}
		.gjj-group-button.gjj-active {
			background: #1f6b43 !important;
			border-color: #48ad73 !important;
			color: #fff !important;
		}
	`;
	document.head.appendChild(style);
}

if (document.head) {
	ensureGroupButtonStyles(document.body);
} else {
	document.addEventListener("DOMContentLoaded", () => {
		ensureGroupButtonStyles(document.body);
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
