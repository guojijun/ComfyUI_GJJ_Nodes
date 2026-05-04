import { GJJ_Utils } from "./gjj_utils.js";
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
	const widgets = getToggleWidgets(node);
	const activeGroups = widgets.filter((widget) => widget?.value && widget?.__groupRef).map((widget) => widget.__groupRef);
	if (activeGroups.length) {
		return new Set(activeGroups);
	}
	if (node.__gjjActiveGroupRefs instanceof Set) {
		return new Set([...node.__gjjActiveGroupRefs]);
	}
	if (node.__gjjActiveGroupRef) {
		return new Set([node.__gjjActiveGroupRef]);
	}
	return new Set();
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

function setGroupState(group, isActive) {
	group?.recomputeInsideNodes?.();
	const nodes = Array.isArray(group?._nodes) ? group._nodes : [];
	nodes.forEach((item) => {
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
		setGroupState(group, activeGroups.has(group));
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
	trimActiveGroupsForMode(node);
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

function hideWidget(widget) {
	if (!widget || widget.__gjjGroupBypasserHidden) {
		return;
	}
	widget.__gjjGroupBypasserHidden = true;
	widget.__gjjOriginalType = widget.type;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.hidden = true;
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.y = -10000;
	widget.last_y = -10000;
	if (widget.inputEl) {
		widget.inputEl.style.display = "none";
	}
	if (widget.element) {
		widget.element.style.display = "none";
	}
}

function stylePanelButton(button, active) {
	button.type = "button";
	button.style.cssText = [
		"flex:1 1 0",
		"height:30px",
		"min-width:0",
		"padding:5px 8px",
		"border-radius:5px",
		`border:1px solid ${active ? "#48ad73" : "#3b5560"}`,
		`background:${active ? "#1f6b43" : "#20323a"}`,
		"color:#fff",
		"font:700 12px sans-serif",
		"cursor:pointer",
	].join(";");
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
	wrap.style.cssText = "box-sizing:border-box;width:100%;display:flex;gap:8px;padding:2px 0 6px";
	for (const value of MODE_VALUES) {
		const active = value === getSelectionMode(node);
		const button = document.createElement("button");
		button.textContent = value;
		button.title = value === MODE_SINGLE ? "单选：启用一个分组时会自动旁路其它匹配分组。" : "多选：可以同时启用多个匹配分组。";
		stylePanelButton(button, active);
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			updateSelectionMode(node, value);
			rebuildUI(node);
		});
		wrap.appendChild(button);
	}
	return makeDomWidgetSize(node.addDOMWidget("选择模式", "HTML", wrap, {
		serialize: false,
		hideOnZoom: false,
	}), 38);
}

function buildModeControls(node) {
	const mode = getSelectionMode(node);
	const hidden = node.addWidget(
		"combo",
		MODE_LABEL,
		mode,
		(newValue) => {
			updateSelectionMode(node, newValue);
			rebuildUI(node);
		},
		{ values: MODE_VALUES },
	);
	hidden.name = MODE_NAME;
	hidden.label = MODE_LABEL;
	hidden.tooltip = "单选互斥；多选允许同时启用多个匹配分组。";
	hideWidget(hidden);

	createModeButtonRow(node);
}

function createGroupButtonWidget(node, group, isActive) {
	const title = String(group?.title || "未命名分组");
	const widget = {
		value: Boolean(isActive),
	};
	const toggle = () => {
		const nextValue = !widget.value;
		const activeGroups = getActiveGroupRefs(node);
		if (nextValue) {
			if (getSelectionMode(node) === MODE_SINGLE) {
				getToggleWidgets(node).forEach((item) => {
					item.value = item === widget;
				});
				activeGroups.clear();
			}
			activeGroups.add(group);
			widget.value = true;
		} else {
			activeGroups.delete(group);
			widget.value = false;
		}

		setActiveGroupRefs(node, activeGroups);
		applyMatchedGroupModes(node);
		rebuildUI(node);
	};

	if (typeof node.addDOMWidget === "function") {
		const wrap = document.createElement("div");
		wrap.style.cssText = "box-sizing:border-box;width:100%;display:flex;padding:2px 0 4px";
		const button = document.createElement("button");
		button.textContent = title;
		button.title = `切换分组“${title}”的启用状态；单选模式下互斥，多选模式下可同时启用多个分组。`;
		stylePanelButton(button, Boolean(isActive));
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			toggle();
		});
		wrap.appendChild(button);
		const domWidget = makeDomWidgetSize(node.addDOMWidget(title, "HTML", wrap, {
			serialize: false,
			hideOnZoom: false,
		}), 36);
		domWidget.value = Boolean(isActive);
		domWidget.__gjjGroupToggle = true;
		domWidget.__groupRef = group;
		return domWidget;
	}

	const fallback = node.addWidget("button", title, "", toggle);
	fallback.value = Boolean(isActive);
	fallback.serialize = false;
	fallback.__gjjGroupToggle = true;
	fallback.__groupRef = group;
	return fallback;
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
	node.widgets = [];

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
		addGroupToggle(node, group, restoredActiveGroups.includes(group));
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
	name: "Comfy.GJJ.GroupBypasser",

	setup() {
		const oldAdd = app.canvas.onGroupAdded;
		app.canvas.onGroupAdded = (...args) => {
			const result = oldAdd?.apply(app.canvas, args);
			refreshAllGroupBypassers();
			return result;
		};

		const oldRemove = app.canvas.onGroupRemoved;
		app.canvas.onGroupRemoved = (...args) => {
			const result = oldRemove?.apply(app.canvas, args);
			refreshAllGroupBypassers();
			return result;
		};
	},

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			ensureNodeState(this);
			setTimeout(() => rebuildUI(this), 50);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			hydrateStateFromSerialized(this, args[0]);
			setTimeout(() => rebuildUI(this), 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			const result = originalOnSerialize?.apply(this, [serializedNode, ...args]);
			serializedNode.properties = serializedNode.properties || {};
			serializedNode.properties[FILTER_NAME] = String(ensureNodeState(this)[FILTER_NAME] || "");
			serializedNode.properties[MODE_NAME] = getSelectionMode(this);
			return result;
		};

		const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			const result = originalOnDrawBackground?.apply(this, args);
			const signature = getGroupSignature();
			if (this.__gjjGroupSignature !== signature) {
				this.__gjjGroupSignature = signature;
				rebuildUI(this);
			}
			return result;
		};
	},
});
