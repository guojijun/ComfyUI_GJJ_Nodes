import { app } from "/scripts/app.js";

const TARGET_NODES = new Set([
	"GJJ_GroupBypasser",
]);
const FILTER_NAME = "过滤关键词";
const MODE_NAME = "选择模式";
const MODE_LABEL = "选择模式";
const MODE_SINGLE = "单选";
const MODE_MULTI = "多选";
const MODE_VALUES = [MODE_SINGLE, MODE_MULTI];
const FILTER_LABEL = "过滤关键词";
const FILTER_PLACEHOLDER = "留空显示全部分组";
const FILTER_TOOLTIP = "输入分组名称中的关键词进行筛选；留空时显示当前工作流中的全部分组。";
const EMPTY_STATE_NAME = "分组状态提示";
const EMPTY_STATE_LABEL = "分组状态提示";
const EMPTY_STATE_TEXT = "当前没有分组，或没有匹配到包含该关键词的分组。";
const EMPTY_STATE_TOOLTIP = "没有可切换的分组时，会在这里显示中文状态提示。";

function ensureNodeState(node) {
	node.properties = node.properties || {};
	if (!Object.prototype.hasOwnProperty.call(node.properties, FILTER_NAME)) {
		node.properties[FILTER_NAME] = "";
	}
	if (!MODE_VALUES.includes(String(node.properties[MODE_NAME] || ""))) {
		node.properties[MODE_NAME] = MODE_SINGLE;
	}
	return node.properties;
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
	const value = String(ensureNodeState(node)[MODE_NAME] || MODE_SINGLE);
	return MODE_VALUES.includes(value) ? value : MODE_SINGLE;
}

function getActiveGroupRefs(node) {
	// 优先读缓存状态，避免 widget.value 延迟导致的状态不一致
	if (node.__gjjActiveGroupRefs instanceof Set) {
		return new Set([...node.__gjjActiveGroupRefs]);
	}

	if (node.__gjjActiveGroupRef) {
		return new Set([node.__gjjActiveGroupRef]);
	}

	// 降级：从 widget.value 读取
	const widgets = getToggleWidgets(node);
	const activeGroups = widgets
		.filter((widget) => widget?.value && widget?.__groupRef)
		.map((widget) => widget.__groupRef);

	return new Set(activeGroups);
}

function setActiveGroupRefs(node, groups) {
	const groupList = Array.isArray(groups) ? groups.filter(Boolean) : [...(groups || [])].filter(Boolean);
	node.__gjjActiveGroupRefs = new Set(groupList);
	node.__gjjActiveGroupRef = groupList[0] || null;
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

function updateFilterText(node, value) {
	ensureNodeState(node)[FILTER_NAME] = String(value || "");
}

function syncFilterToOriginalWidget(node) {
	const currentValue = getFilterText(node);
	const widgets = (node.widgets || []).filter((w) => w?.name === FILTER_NAME);
	
	// 如果有多个同名 widget（DOM widget + Python widget），确保它们值一致
	if (widgets.length > 1) {
		for (const widget of widgets) {
			if (widget.value !== currentValue) {
				widget.value = currentValue;
				if (widget.inputEl) {
					widget.inputEl.value = currentValue;
				}
			}
		}
	}
}

function enforceWidgetZIndex(node) {
	// 遍历所有 DOM widget，确保它们的容器有正确的 z-index
	const widgets = Array.isArray(node.widgets) ? node.widgets : [];
	let zIndexCounter = 10000;
	
	for (const widget of widgets) {
		if (widget?.element instanceof HTMLElement) {
			const element = widget.element;
			
			// 提升容器本身的 z-index
			element.style.setProperty("z-index", String(zIndexCounter), "important");
			element.style.setProperty("position", "relative", "important");
			element.style.setProperty("pointer-events", "auto", "important");
			
			// 提升容器内所有子元素的 z-index
			const buttons = element.querySelectorAll("button");
			buttons.forEach((btn, index) => {
				btn.style.setProperty("z-index", String(zIndexCounter + 1), "important");
				btn.style.setProperty("position", "relative", "important");
				btn.style.setProperty("pointer-events", "auto", "important");
			});
			
			zIndexCounter += 10; // 每个 widget 递增，避免冲突
		}
	}
}

function updateSelectionMode(node, value) {
	const mode = MODE_VALUES.includes(String(value || "")) ? String(value) : MODE_SINGLE;
	ensureNodeState(node)[MODE_NAME] = mode;

	const widget = (node.widgets || []).find((item) => item?.name === MODE_NAME);
	if (widget) {
		widget.value = mode;
		if (widget.inputEl) {
			widget.inputEl.value = mode;
		}
	}

	node.graph?.change?.();
}

function hydrateStateFromSerialized(node, serialized) {
	const props = ensureNodeState(node);
	const values = Array.isArray(serialized?.widgets_values) ? serialized.widgets_values : [];
	if (!Object.prototype.hasOwnProperty.call(serialized?.properties || {}, FILTER_NAME) && values.length > 0) {
		props[FILTER_NAME] = String(values[0] || "");
	}
	if (!Object.prototype.hasOwnProperty.call(serialized?.properties || {}, MODE_NAME) && MODE_VALUES.includes(String(values[1] || ""))) {
		props[MODE_NAME] = String(values[1]);
	}
}


function makeDomWidgetSize(widget, height) {
	widget.serialize = false;
	widget.computeSize = (width) => [Math.max(180, Number(width || 180)), height];
	widget.getHeight = () => height;
	return widget;
}

function createModeButtonRow(node) {
	// 新方案：直接将按钮注入到节点的 header 区域，避开 DOM widget 的问题
	ensureModeButtonStyles();
	
	// 查找或创建 header 容器
	let headerContainer = node.__gjjModeHeaderContainer;
	if (!headerContainer || !headerContainer.parentNode) {
		// 创建新的 header 容器
		headerContainer = document.createElement("div");
		headerContainer.id = `gjj-mode-header-${node.id}`;
		headerContainer.className = "gjj-mode-header-container";
		headerContainer.style.cssText = [
			"display:flex",
			"gap:8px",
			"padding:8px 12px",
			"margin:0",
			"background:#1a2b35",
			"border-bottom:1px solid #2a3f4d",
			"position:relative",
			"z-index:100",
		].join(";");
		
		// 保存到节点引用，避免重复创建
		node.__gjjModeHeaderContainer = headerContainer;
		
		// 将容器插入到节点的 DOM 结构中
		// 尝试插入到 node.badges 或 node.title 之后
		setTimeout(() => {
			const nodeElement = document.querySelector(`[data-node-id="${node.id}"]`);
			if (nodeElement) {
				// 找到 title 区域
				const titleElement = nodeElement.querySelector(".node-title") || nodeElement.querySelector("header");
				if (titleElement && titleElement.parentNode) {
					// 插入到 title 之后
					titleElement.parentNode.insertBefore(headerContainer, titleElement.nextSibling);
				} else if (nodeElement.firstChild) {
					// 如果没有 title，插入到最前面
					nodeElement.insertBefore(headerContainer, nodeElement.firstChild);
				} else {
					nodeElement.appendChild(headerContainer);
				}
			}
		}, 10);
	}
	
	// 清空旧按钮
	headerContainer.innerHTML = "";
	
	// 初始化模式按钮引用数组
	node.__gjjModeButtons = [];
	
	const currentMode = getSelectionMode(node);
	
	for (const value of MODE_VALUES) {
		const active = value === currentMode;
		const button = document.createElement("button");
		button.type = "button";
		button.className = "gjj-mode-button";
		button.textContent = value;
		button.title = value === MODE_SINGLE ? "单选：启用一个分组时会自动旁路其它匹配分组。" : "多选：可以同时启用多个匹配分组。";
		button.dataset.mode = value;
		button.__gjjModeValue = value;
		
		updateModeButtonClass(button, active);
		node.__gjjModeButtons.push(button);
		
		// 只绑定 click 事件，不绑定 pointerdown
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			
			// 更新模式
			updateSelectionMode(node, value);
			
			// 处理单选模式下的分组状态
			let activeGroups = getActiveGroupRefs(node);
			if (value === MODE_SINGLE && activeGroups.size > 1) {
				const firstGroup = [...activeGroups][0];
				activeGroups = new Set(firstGroup ? [firstGroup] : []);
			}
			setActiveGroupRefs(node, activeGroups);
			
			// 同步状态
			syncModeButtonStates(node);
			syncGroupButtonStates(node, activeGroups);
			applyMatchedGroupModes(node);
			
			node.graph?.change?.();
			node.setDirtyCanvas?.(true, true);
			app.graph?.setDirtyCanvas?.(true, true);
		});
		
		headerContainer.appendChild(button);
	}
	
	// 返回 null，因为我们不再使用 DOM widget
	return null;
}

function ensureModeButtonStyles() {
	const styleId = "gjj-mode-button-styles";
	if (document.getElementById(styleId)) {
		return;
	}

	const style = document.createElement("style");
	style.id = styleId;
	style.textContent = `
		.gjj-mode-header-container {
			position: relative !important;
			z-index: 100 !important;
			pointer-events: auto !important;
		}
		.gjj-mode-button {
			flex: 1 1 0;
			height: 30px;
			min-width: 0;
			padding: 5px 8px;
			border-radius: 5px;
			border: 1px solid #3b5560;
			background: #20323a;
			color: #edf6fa;
			font: 700 12px sans-serif;
			cursor: pointer;
			outline: none;
			transition: all 0.2s ease;
			position: relative;
			z-index: 101;
			pointer-events: auto;
		}
		.gjj-mode-button:hover {
			background: #2a4a55 !important;
			border-color: #4a6b78 !important;
		}
		.gjj-mode-button.on {
			background: #1f6b43 !important;
			border-color: #48ad73 !important;
			color: #fff !important;
		}
	`;
	document.head.appendChild(style);
}

function buildModeControls(node) {
	ensureNodeState(node);
	// createModeButtonRow 现在直接操作 DOM，不再返回 widget
	createModeButtonRow(node);
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

	// 使用事件委托，避免重复绑定
	// 只阻止事件冒泡，不阻止默认行为（避免阻止 click 事件）
	button.addEventListener("pointerdown", (event) => {
		event.stopPropagation();
		// 注意：不要调用 preventDefault()，否则会阻止后续的 click 事件
	});
	
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
	
	// 强制提升所有 DOM widget 容器的层级
	enforceWidgetZIndex(node);

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
	
	// 清理节点上的自定义引用
	if (node.__gjjModeButtons) {
		node.__gjjModeButtons = null;
	}

	// 注意：不要清理 __gjjModeHeaderContainer，因为 rebuildUI 时会复用
	// 我们只需要清空它的 innerHTML，而不是移除 DOM 元素
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

function updateModeButtonClass(button, isActive) {
	button.classList.toggle("on", isActive);

	if (isActive) {
		button.style.setProperty("background", "#1f6b43", "important");
		button.style.setProperty("border-color", "#48ad73", "important");
		button.style.setProperty("color", "#fff", "important");
	} else {
		button.style.setProperty("background", "#20323a", "important");
		button.style.setProperty("border-color", "#3b5560", "important");
		button.style.setProperty("color", "#edf6fa", "important");
	}
}

function syncModeButtonStates(node) {
	const mode = getSelectionMode(node);
	const buttons = Array.isArray(node.__gjjModeButtons) ? node.__gjjModeButtons : [];

	buttons.forEach((button) => {
		const value = button.__gjjModeValue;
		updateModeButtonClass(button, value === mode);
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
