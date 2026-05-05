import { app } from "/scripts/app.js";

const TARGET_NODES = new Set([
	"GJJ_GroupBypasser",
]);
const FILTER_NAME = "filter_keyword";
const MODE_NAME = "selection_mode";
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
	if (typeof node.addDOMWidget !== "function") {
		for (const value of MODE_VALUES) {
			const active = value === getSelectionMode(node);
			const button = node.addWidget("button", `${active ? "●" : "○"} ${value}`, "", () => {
				updateSelectionMode(node, value);
				rebuildUI(node);
			});
			button.serialize = false;
		}
		return null;
	}

	const wrap = document.createElement("div");
	wrap.className = "gjj-mode-button-row";
	wrap.style.cssText = "box-sizing:border-box;width:100%;display:flex;gap:8px;padding:2px 0 6px";

	// 注入模式按钮样式
	ensureModeButtonStyles();

	// 保存当前激活的模式值，用于样式设置
	const currentMode = getSelectionMode(node);

	// 初始化模式按钮引用数组
	node.__gjjModeButtons = [];

	for (const value of MODE_VALUES) {
		const active = value === currentMode;
		const button = document.createElement("button");
		button.type = "button";
		button.className = "gjj-mode-button";
		button.textContent = value;
		button.title = value === MODE_SINGLE ? "单选：启用一个分组时会自动旁路其它匹配分组。" : "多选：可以同时启用多个匹配分组。";

		// 保存模式值引用
		button.__gjjModeValue = value;
		updateModeButtonClass(button, active);

		// 保存按钮引用
		node.__gjjModeButtons.push(button);

		button.addEventListener("pointerdown", (event) => event.stopPropagation());
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

			// 同步模式按钮和分组按钮状态，不调用 rebuildUI
			syncModeButtonStates(node);
			syncGroupButtonStates(node, activeGroups);

			// 应用分组启用/旁路状态
			applyMatchedGroupModes(node);

			node.graph?.change?.();
			node.setDirtyCanvas?.(true, true);
			app.graph?.setDirtyCanvas?.(true, true);
		});
		wrap.appendChild(button);
	}
	return makeDomWidgetSize(node.addDOMWidget("选择模式", "HTML", wrap, {
		serialize: false,
		hideOnZoom: false,
	}), 38);
}

function ensureModeButtonStyles() {
	const styleId = "gjj-mode-button-styles";
	if (document.getElementById(styleId)) {
		return;
	}

	const style = document.createElement("style");
	style.id = styleId;
	style.textContent = `
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
	createModeButtonRow(node);
}

function createGroupButtonWidget(node, group, isActive) {
	const title = String(group?.title || "未命名分组");

	const wrap = document.createElement("div");
	wrap.className = "gjj-group-bypasser-row";
	wrap.style.cssText = "box-sizing:border-box;width:100%;display:flex;padding:2px 0 4px";

	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-group-button";
	button.textContent = `${isActive ? "✅ " : "❌ "}${title}`;
	button.title = `切换分组"${title}"的启用状态；单选模式下互斥，多选模式下可同时启用多个分组。`;

	updateButtonClass(button, isActive);

	wrap.appendChild(button);

	const domWidget = makeDomWidgetSize(node.addDOMWidget(title, "HTML", wrap, {
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

	button.addEventListener("pointerdown", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		toggle();
	});

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
			rebuildUI(node);
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
			widget.element.remove();
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
