import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_MultiReplace"]);
const MAX_PAIRS = 20;
const SEARCH_PREFIX = "search_";
const REPLACE_PREFIX = "replace_";
const OPTIONS_WIDGET = "options_json";
const LEGACY_OPTION_WIDGETS = ["case_insensitive", "regex_mode", "replace_all"];
const TOOLBAR_NAME = "gjj_multi_replace_options";
const MIN_WIDTH = 240;
const DEFAULT_OPTIONS = {
	case_insensitive: false,
	regex_mode: false,
	replace_all: true,
};

function pairName(prefix, index) {
	return `${prefix}${String(index).padStart(2, "0")}`;
}

function pairWidgets(node, index) {
	return {
		search: GJJ_Utils.getWidget(node, pairName(SEARCH_PREFIX, index)),
		replace: GJJ_Utils.getWidget(node, pairName(REPLACE_PREFIX, index)),
	};
}

function textValue(widget) {
	return String(widget?.value ?? "").trim();
}

function boolValue(node, name) {
	return Boolean(readOptions(node)[name]);
}

function setBoolValue(node, name, value) {
	const options = readOptions(node);
	options[name] = Boolean(value);
	writeOptions(node, options);
	updateToolbar(node);
	compactNodeSize(node);
}

function readOptions(node) {
	const widget = GJJ_Utils.getWidget(node, OPTIONS_WIDGET);
	let parsed = null;
	try {
		parsed = JSON.parse(String(widget?.value || node?.properties?.gjj_multi_replace_options || "{}"));
	} catch (_) {
		parsed = null;
	}
	const options = { ...DEFAULT_OPTIONS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
	for (const name of LEGACY_OPTION_WIDGETS) {
		const legacy = GJJ_Utils.getWidget(node, name);
		if (legacy && legacy.value !== undefined) {
			options[name] = Boolean(legacy.value);
		}
	}
	return options;
}

function writeOptions(node, options) {
	const normalized = { ...DEFAULT_OPTIONS, ...(options || {}) };
	const text = JSON.stringify(normalized);
	node.properties ||= {};
	node.properties.gjj_multi_replace_options = text;
	const widget = GJJ_Utils.getWidget(node, OPTIONS_WIDGET);
	if (widget) {
		widget.value = text;
		try {
			widget.callback?.(widget.value);
		} catch (_) {
			// ignore
		}
	}
}

function rememberWidget(widget) {
	if (!widget || widget.__gjjMultiReplaceOriginal) {
		return;
	}
	widget.__gjjMultiReplaceOriginal = {
		type: widget.type,
		label: widget.label,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		draw: widget.draw,
		disabled: widget.disabled,
		y: widget.y,
		last_y: widget.last_y,
		size: Array.isArray(widget.size) ? [...widget.size] : widget.size,
	};
}

function hideSoft(widget) {
	if (!widget) {
		return;
	}
	rememberWidget(widget);
	widget.hidden = true;
	widget.disabled = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.label = "";
	widget.options ||= {};
	widget.options.hidden = true;
	widget.options.display = "hidden";
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.last_y = 0;
	widget.y = 0;
	widget.computedHeight = 0;
	widget.margin_top = 0;
	widget.size = [0, 0];
	if (widget.element) {
		widget.element.style.display = "none";
		widget.element.style.height = "0";
		widget.element.style.margin = "0";
		widget.element.style.padding = "0";
	}
	if (widget.inputEl) {
		widget.inputEl.style.display = "none";
		widget.inputEl.style.height = "0";
		widget.inputEl.style.margin = "0";
		widget.inputEl.style.padding = "0";
	}
}

function showSoft(widget, label) {
	if (!widget) {
		return;
	}
	rememberWidget(widget);
	const original = widget.__gjjMultiReplaceOriginal || {};
	widget.hidden = false;
	widget.disabled = Boolean(original.disabled);
	widget.type = original.type || "text";
	widget.label = label || original.label || widget.name;
	widget.options ||= {};
	delete widget.options.hidden;
	if (widget.options.display === "hidden") {
		delete widget.options.display;
	}
	if (typeof original.computeSize === "function") {
		widget.computeSize = original.computeSize;
	} else {
		delete widget.computeSize;
	}
	if (typeof original.getHeight === "function") {
		widget.getHeight = original.getHeight;
	} else {
		delete widget.getHeight;
	}
	if (typeof original.draw === "function") {
		widget.draw = original.draw;
	} else {
		delete widget.draw;
	}
	widget.size = Array.isArray(original.size) ? [...original.size] : original.size;
	delete widget.computedHeight;
	delete widget.margin_top;
	widget.options.display_name = label || widget.options.display_name;
	if (widget.element) {
		widget.element.style.display = "";
		widget.element.style.height = "";
		widget.element.style.margin = "";
		widget.element.style.padding = "";
	}
	if (widget.inputEl) {
		widget.inputEl.style.display = "";
		widget.inputEl.style.height = "";
		widget.inputEl.style.margin = "";
		widget.inputEl.style.padding = "";
	}
}

function patchRuleWidget(node, widget) {
	if (!widget || widget.__gjjMultiReplacePatched) {
		return;
	}
	widget.__gjjMultiReplacePatched = true;
	const originalCallback = widget.callback;
	widget.callback = function (...args) {
		const result = originalCallback?.apply(this, args);
		scheduleStabilize(node);
		return result;
	};
	if (widget.inputEl) {
		widget.inputEl.addEventListener("input", () => scheduleStabilize(node));
		widget.inputEl.addEventListener("change", () => scheduleStabilize(node));
	}
}

function visiblePairCount(node) {
	let lastUsed = 0;
	for (let index = 1; index <= MAX_PAIRS; index += 1) {
		const widgets = pairWidgets(node, index);
		if (textValue(widgets.search) || textValue(widgets.replace)) {
			lastUsed = index;
		}
	}
	return Math.min(MAX_PAIRS, Math.max(1, lastUsed + 1));
}

function cleanupAccidentalBooleanRuleValues(node) {
	if (node.__gjjMultiReplaceBooleanCleanupDone) {
		return;
	}
	for (let index = 1; index <= MAX_PAIRS; index += 1) {
		const { search, replace } = pairWidgets(node, index);
		const searchText = textValue(search);
		const replaceText = textValue(replace).toLowerCase();
		if (!searchText && (replaceText === "true" || replaceText === "false")) {
			replace.value = "";
		}
	}
	node.__gjjMultiReplaceBooleanCleanupDone = true;
}

function updatePairs(node) {
	const visibleCount = visiblePairCount(node);
	for (let index = 1; index <= MAX_PAIRS; index += 1) {
		const { search, replace } = pairWidgets(node, index);
		patchRuleWidget(node, search);
		patchRuleWidget(node, replace);
		if (index <= visibleCount) {
			showSoft(search, `🔎 查找 ${index}`);
			showSoft(replace, `✏️ 替换 ${index}`);
			if (search) {
				search.tooltip = `第 ${index} 组要查找的文本或正则表达式。`;
			}
			if (replace) {
				replace.tooltip = `第 ${index} 组替换成的内容，留空表示删除。`;
			}
		} else {
			hideSoft(search);
			hideSoft(replace);
		}
	}
}

function ruleWidgetIndex(widget) {
	const name = String(widget?.name || "");
	for (const prefix of [SEARCH_PREFIX, REPLACE_PREFIX]) {
		if (name.startsWith(prefix)) {
			return Number.parseInt(name.slice(prefix.length), 10) || 0;
		}
	}
	return 0;
}

function widgetPriority(widget) {
	const name = String(widget?.name || "");
	if (name === TOOLBAR_NAME) {
		return 0;
	}
	if (name.startsWith(SEARCH_PREFIX) || name.startsWith(REPLACE_PREFIX)) {
		const index = ruleWidgetIndex(widget);
		const side = name.startsWith(SEARCH_PREFIX) ? 0 : 1;
		return widget.hidden ? 800 + index * 2 + side : 100 + index * 2 + side;
	}
	if (name === OPTIONS_WIDGET || LEGACY_OPTION_WIDGETS.includes(name)) {
		return 900;
	}
	return widget.hidden ? 950 : 500;
}

function reorderWidgets(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	node.widgets = node.widgets
		.map((widget, index) => ({ widget, index }))
		.sort((a, b) => widgetPriority(a.widget) - widgetPriority(b.widget) || a.index - b.index)
		.map((entry) => entry.widget);
}

function makeButton(label, title, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title;
	button.style.cssText = [
		"border:1px solid #41545c",
		"border-radius:6px",
		"background:#263238",
		"color:#dce7e2",
		"font-size:12px",
		"font-weight:700",
		"height:28px",
		"padding:0 6px",
		"cursor:pointer",
		"white-space:nowrap",
		"min-width:0",
		"overflow:hidden",
		"text-overflow:ellipsis",
		"flex:1 1 0",
	].join(";");
	button.addEventListener("pointerdown", (event) => event.stopPropagation());
	button.addEventListener("mousedown", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.();
	});
	return button;
}

function setButtonState(button, active) {
	if (!button) {
		return;
	}
	button.dataset.active = active ? "1" : "0";
	button.style.background = active ? "#256d46" : "#263238";
	button.style.borderColor = active ? "#55c982" : "#41545c";
	button.style.color = active ? "#f5fff8" : "#dce7e2";
	button.style.boxShadow = active ? "0 0 0 1px rgba(85, 201, 130, 0.2) inset" : "none";
}

function ensureToolbar(node) {
	if (node.__gjjMultiReplaceToolbar) {
		return;
	}

	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"gap:5px",
		"align-items:center",
		"width:100%",
		"box-sizing:border-box",
		"padding:2px 0 4px",
		"overflow:hidden",
	].join(";");

	const caseButton = makeButton("🔤 大小写", "开启后忽略英文大小写", () => {
		setBoolValue(node, "case_insensitive", !boolValue(node, "case_insensitive"));
	});
	const regexButton = makeButton("🧩 正则", "开启后按正则表达式查找", () => {
		setBoolValue(node, "regex_mode", !boolValue(node, "regex_mode"));
	});
	const allButton = makeButton("🔁 全部", "开启后替换所有匹配；关闭后每组只替换第一个匹配", () => {
		setBoolValue(node, "replace_all", !boolValue(node, "replace_all"));
	});

	container.appendChild(caseButton);
	container.appendChild(regexButton);
	container.appendChild(allButton);

	const widget = node.addDOMWidget?.(TOOLBAR_NAME, TOOLBAR_NAME, container, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => 34,
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(MIN_WIDTH, Number(width || MIN_WIDTH)), 34];
		widget.draw = () => {};
		node.__gjjMultiReplaceToolbarWidget = widget;
		if (Array.isArray(node.widgets)) {
			const index = node.widgets.indexOf(widget);
			if (index > 0) {
				node.widgets.splice(index, 1);
				node.widgets.unshift(widget);
			}
		}
	}

	node.__gjjMultiReplaceToolbar = {
		container,
		caseButton,
		regexButton,
		allButton,
	};
	updateToolbar(node);
}

function updateToolbar(node) {
	const toolbar = node.__gjjMultiReplaceToolbar;
	if (!toolbar) {
		return;
	}
	setButtonState(toolbar.caseButton, boolValue(node, "case_insensitive"));
	setButtonState(toolbar.regexButton, boolValue(node, "regex_mode"));
	setButtonState(toolbar.allButton, boolValue(node, "replace_all"));
}

function hideOptionWidgets(node) {
	hideSoft(GJJ_Utils.getWidget(node, OPTIONS_WIDGET));
	for (const name of LEGACY_OPTION_WIDGETS) {
		GJJ_Utils.hideWidget(GJJ_Utils.getWidget(node, name));
	}
}

function compactNodeSize(node) {
	requestAnimationFrame(() => {
		const computed = node.computeSize?.() || [];
		const currentWidth = Number(node.size?.[0] || MIN_WIDTH);
		const width = Math.max(MIN_WIDTH, currentWidth || Number(computed[0] || 0));
		const height = Math.max(120, Number(computed[1] || 0));
		node.setSize?.([width, height]);
		GJJ_Utils.dirtyCanvas(node);
	});
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}
	ensureToolbar(node);
	writeOptions(node, readOptions(node));
	cleanupAccidentalBooleanRuleValues(node);
	hideOptionWidgets(node);
	updatePairs(node);
	updateToolbar(node);
	reorderWidgets(node);

	for (const output of node.outputs || []) {
		output.type = "*";
		output.name = "替换结果";
		output.label = "替换结果";
		output.localized_name = "替换结果";
		output.tooltip = "替换后的对象。";
	}

	compactNodeSize(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjMultiReplaceTimer);
	node.__gjjMultiReplaceTimer = setTimeout(() => stabilizeNode(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.MultiReplace",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			setTimeout(() => stabilizeNode(this), 120);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			setTimeout(() => stabilizeNode(this), 120);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				stabilizeNode(node);
			}
		}
	},
});
