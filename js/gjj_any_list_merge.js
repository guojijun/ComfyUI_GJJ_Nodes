import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const NODE_NAME = "GJJ_AnyListMerge";
const TARGET_NODES = new Set([NODE_NAME]);
const INPUT_PREFIX = "any_";
const MIN_VISIBLE_INPUTS = 1;
const OUTPUT_NAME = "列表输出（逐项列表口）";
const INPUT_TOOLTIP = "动态任意输入；连接最后一个输入口后会自动新增下一路。";
const OUTPUT_TOOLTIP = "合并后的 ComfyUI 列表口输出；下游会按列表逐项接收。";
const PANEL_WIDGET = "gjj_any_list_merge_buttons";
const GRAPH_PROMPT_PATCH_FLAG = "__gjjAnyListMergeGraphToPromptPatched";

const BOOLEAN_FIELDS = [
	{
		name: "flatten",
		label: "展开列表",
		title: "开启后，输入本身是列表时会展开后再合并。",
	},
	{
		name: "skip_empty",
		label: "跳过空值",
		title: "开启后会跳过未连接或为空的输入。",
	},
];

function formatInputName(index) {
	return `${INPUT_PREFIX}${index}`;
}

function inputIndex(input) {
	const text = String(input?.name || "");
	if (!text.startsWith(INPUT_PREFIX)) return Number.MAX_SAFE_INTEGER;
	const value = Number.parseInt(text.slice(INPUT_PREFIX.length), 10);
	return Number.isFinite(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER;
}

function sortedInputs(node) {
	return [...(node?.inputs || [])]
		.filter((input) => String(input?.name || "").startsWith(INPUT_PREFIX))
		.sort((a, b) => inputIndex(a) - inputIndex(b));
}

function linkById(id) {
	return id != null ? app.graph?.links?.[id] : null;
}

function isLiveLink(id) {
	return id != null && !!linkById(id);
}

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function asBool(value) {
	return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function markDirty(node) {
	node?.setDirtyCanvas?.(true, true);
	node?.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function writeWidgetValue(node, widget, value) {
	if (!widget) return;
	const next = Boolean(value);
	widget.value = next;
	widget.callback?.(next);
	const index = Array.isArray(node?.widgets) ? node.widgets.indexOf(widget) : -1;
	if (index >= 0) {
		node.widgets_values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
		node.widgets_values[index] = next;
	}
}

function hideBooleanWidgets(node) {
	for (const field of BOOLEAN_FIELDS) {
		const widget = getWidget(node, field.name);
		if (!widget) continue;
		GJJ_Utils.hideWidget(widget);
		widget.serialize = true;
		widget.options = { ...(widget.options || {}), hidden: true, display: "hidden" };
	}
}

function protect(element) {
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
	element.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
}

function disconnectInput(node, slotIndex) {
	try {
		node.disconnectInput?.(slotIndex);
	} catch (_) {}
}

function sanitizeStaleLinks(node) {
	for (const [slot, input] of (node.inputs || []).entries()) {
		if (input?.link != null && !isLiveLink(input.link)) {
			disconnectInput(node, slot);
			input.link = null;
		}
	}
	for (const output of node.outputs || []) {
		if (!Array.isArray(output?.links)) continue;
		output.links = output.links.filter((id) => isLiveLink(id));
	}
}

function ensureOutput(node) {
	if (!Array.isArray(node.outputs)) node.outputs = [];
	if (!node.outputs[0]) {
		node.addOutput?.(OUTPUT_NAME, "*");
	}
	while ((node.outputs?.length || 0) > 1) {
		node.removeOutput?.(node.outputs.length - 1);
	}
	const output = node.outputs?.[0];
	if (!output) return;
	output.name = OUTPUT_NAME;
	output.label = OUTPUT_NAME;
	output.localized_name = OUTPUT_NAME;
	output.tooltip = OUTPUT_TOOLTIP;
}

function addDynamicInput(node, type = "*") {
	const nextIndex = sortedInputs(node).length + 1;
	node.addInput?.(formatInputName(nextIndex), type || "*");
}

function compactDynamicInputs(node) {
	const dynamic = sortedInputs(node);
	let linkedCount = 0;
	for (const input of dynamic) {
		if (isLiveLink(input?.link)) linkedCount += 1;
	}
	let keptEmpty = false;
	for (let index = dynamic.length - 1; index >= 0; index -= 1) {
		const input = dynamic[index];
		if (isLiveLink(input?.link)) continue;
		if (!keptEmpty && linkedCount === 0 && index === 0) {
			keptEmpty = true;
			continue;
		}
		if (!keptEmpty && index === dynamic.length - 1) {
			keptEmpty = true;
			continue;
		}
		const slotIndex = node.inputs?.indexOf(input) ?? -1;
		if (slotIndex >= 0) {
			disconnectInput(node, slotIndex);
			node.removeInput?.(slotIndex);
		}
	}
}

function ensureTrailingEmptyInput(node, fallbackType = "*") {
	const inputs = sortedInputs(node);
	if (inputs.length === 0) {
		addDynamicInput(node, fallbackType);
		return;
	}
	const last = inputs[inputs.length - 1];
	if (isLiveLink(last?.link)) {
		addDynamicInput(node, last.type || fallbackType || "*");
	}
}

function orderInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	const dynamic = sortedInputs(node).sort((a, b) => {
		const aLinked = isLiveLink(a?.link) ? 0 : 1;
		const bLinked = isLiveLink(b?.link) ? 0 : 1;
		return aLinked - bLinked || inputIndex(a) - inputIndex(b);
	});
	const fixed = node.inputs.filter((input) => !String(input?.name || "").startsWith(INPUT_PREFIX));
	node.inputs.splice(0, node.inputs.length, ...fixed, ...dynamic);
}

function applyInputMeta(node) {
	sortedInputs(node).forEach((input, index) => {
		input.name = formatInputName(index + 1);
		input.label = `任意输入 ${index + 1}`;
		input.localized_name = input.label;
		input.tooltip = INPUT_TOOLTIP;
		input.type = input.type || "*";
	});
}

function updateButtonState(node, name) {
	const button = node?.__gjjAnyListMergeButtons?.get(name);
	const widget = getWidget(node, name);
	if (!button || !widget) return;
	const enabled = asBool(widget.value);
	button.dataset.value = enabled ? "true" : "false";
	button.classList.toggle("on", enabled);
	button.setAttribute("aria-pressed", String(enabled));
}

function syncButtons(node) {
	hideBooleanWidgets(node);
	for (const field of BOOLEAN_FIELDS) {
		updateButtonState(node, field.name);
	}
	GJJ_Utils.refreshNode(node);
}

function toggleField(node, name) {
	const widget = getWidget(node, name);
	if (!widget) return;
	writeWidgetValue(node, widget, !asBool(widget.value));
	updateButtonState(node, name);
	markDirty(node);
}

function panelHeight(node) {
	const root = node?.__gjjAnyListMergePanel;
	return Math.max(30, Math.ceil(root?.scrollHeight || root?.offsetHeight || 30));
}

function createPanel(node) {
	if (!node || node.__gjjAnyListMergePanelWidget || typeof node.addDOMWidget !== "function") return;
	const root = document.createElement("div");
	root.className = "gjj-anylist-merge-panel";
	protect(root);

	const row = document.createElement("div");
	row.className = "gjj-anylist-merge-row";
	root.appendChild(row);

	node.__gjjAnyListMergeButtons = new Map();
	for (const field of BOOLEAN_FIELDS) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "gjj-anylist-merge-toggle";
		button.textContent = field.label;
		button.title = field.title;
		button.setAttribute("aria-label", field.label);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			toggleField(node, field.name);
			GJJ_Utils.refreshNode(node);
		});
		node.__gjjAnyListMergeButtons.set(field.name, button);
		row.appendChild(button);
	}

	const widget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, { serialize: false, hideOnZoom: false });
	widget.serialize = false;
	widget.options = { ...(widget.options || {}), serialize: false };
	widget.computeSize = (width) => [Math.round(Number(width || node.size?.[0] || 240)), panelHeight(node)];
	widget.getHeight = () => panelHeight(node);
	node.__gjjAnyListMergePanel = root;
	node.__gjjAnyListMergePanelWidget = widget;
}

function ensureStyles() {
	if (document.getElementById("gjj-any-list-merge-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-any-list-merge-style";
	style.textContent = `
		.gjj-anylist-merge-panel {
			box-sizing: border-box;
			width: 100%;
			padding: 4px 0 2px;
			font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		}
		.gjj-anylist-merge-row {
			display: flex;
			align-items: center;
			gap: 6px;
			width: 100%;
			min-width: 0;
		}
		.gjj-anylist-merge-toggle {
			box-sizing: border-box;
			flex: 1 1 0;
			min-width: 0;
			height: 24px;
			padding: 0 8px;
			border: 1px solid #41535b;
			border-radius: 6px;
			background: #1b252b;
			color: #d7e1e4;
			cursor: pointer;
			font: 700 12px/20px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			letter-spacing: 0;
			text-align: center;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.gjj-anylist-merge-toggle:hover {
			border-color: #6aa6b8;
			background: #263843;
		}
		.gjj-anylist-merge-toggle.on,
		.gjj-anylist-merge-toggle[data-value="true"] {
			border-color: #69b980;
			background: #20362f;
			color: #ecfff1;
		}
	`;
	document.head.appendChild(style);
}

function linkSignature(node) {
	const ins = (node.inputs || []).map((input) => `${input.name}:${input.link ?? ""}`).join("|");
	const outs = (node.outputs || []).map((output) => `${output.name}:${(output.links || []).join(",")}`).join("|");
	const widgets = BOOLEAN_FIELDS.map((field) => `${field.name}:${getWidget(node, field.name)?.value}`).join("|");
	return `${ins}=>${outs}::${widgets}`;
}

function stabilizeNode(node) {
	if (!node || !TARGET_NODES.has(node.comfyClass || node.type)) return;
	ensureStyles();
	createPanel(node);
	hideBooleanWidgets(node);
	sanitizeStaleLinks(node);
	ensureOutput(node);
	compactDynamicInputs(node);
	ensureTrailingEmptyInput(node);
	orderInputs(node);
	applyInputMeta(node);
	syncButtons(node);
	node.__gjjAnyListMergeLinkSignature = linkSignature(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjAnyListMergeTimer);
	node.__gjjAnyListMergeTimer = setTimeout(() => stabilizeNode(node), ms);
}

function stabilizeAllNodes() {
	for (const node of app.graph?._nodes || []) {
		if (TARGET_NODES.has(node?.comfyClass || node?.type)) {
			stabilizeNode(node);
		}
	}
}

function patchGraphToPrompt() {
	if (app[GRAPH_PROMPT_PATCH_FLAG] || typeof app.graphToPrompt !== "function") return;
	app[GRAPH_PROMPT_PATCH_FLAG] = true;
	const original = app.graphToPrompt.bind(app);
	app.graphToPrompt = async function (...args) {
		stabilizeAllNodes();
		return original(...args);
	};
}

app.registerExtension({
	name: "Comfy.GJJ.AnyListMergeDynamic",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (type, name, value, callback, options, ...rest) {
			const widget = originalAddWidget?.apply(this, [type, name, value, callback, options, ...rest]);
			if (BOOLEAN_FIELDS.some((field) => field.name === name)) {
				GJJ_Utils.hideWidget(widget);
			}
			return widget;
		};

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			setTimeout(() => stabilizeNode(this), 150);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			setTimeout(() => stabilizeNode(this), 150);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			stabilizeNode(this);
			originalOnSerialize?.apply(this, [serializedNode, ...args]);
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this);
			return result;
		};

		const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			const result = originalOnDrawBackground?.apply(this, args);
			const signature = linkSignature(this);
			if (signature !== this.__gjjAnyListMergeLinkSignature) {
				scheduleStabilize(this, 16);
			}
			return result;
		};
	},

	setup() {
		patchGraphToPrompt();
		stabilizeAllNodes();
		setTimeout(stabilizeAllNodes, 500);
	},
});
