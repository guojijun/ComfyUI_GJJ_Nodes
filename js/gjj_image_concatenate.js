import { app } from "/scripts/app.js";

const NODE_TYPE = "GJJ_ImageConcanate";
const MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,MASK,VIDEO";
const INPUT_PREFIX = "media_";
const PANEL_WIDGET = "gjj_image_concatenate_buttons";

const DIRECTIONS = [
	{ value: "up", icon: "⬆", title: "向上拼接" },
	{ value: "down", icon: "⬇", title: "向下拼接" },
	{ value: "left", icon: "⬅", title: "向左拼接" },
	{ value: "right", icon: "➡", title: "向右拼接" },
];

function inputName(index) {
	return `${INPUT_PREFIX}${String(index).padStart(2, "0")}`;
}

function inputIndex(name) {
	const match = String(name || "").match(/^media_(\d+)$/);
	return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function mediaInputs(node) {
	return Array.isArray(node?.inputs)
		? node.inputs.filter((input) => String(input?.name || "").startsWith(INPUT_PREFIX)).sort((a, b) => inputIndex(a.name) - inputIndex(b.name))
		: [];
}

function setDirty(node) {
	node?.setDirtyCanvas?.(true, true);
	node?.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function widgetByName(node, name) {
	return node?.widgets?.find?.((widget) => widget?.name === name);
}

function hideNativeWidget(widget) {
	if (!widget || widget.__gjjImageConcatHidden) return;
	widget.__gjjImageConcatHidden = true;
	widget.__gjjSavedType = widget.type;
	widget.__gjjSavedComputeSize = widget.computeSize;
	widget.__gjjSavedGetHeight = widget.getHeight;
	widget.__gjjSavedDraw = widget.draw;
	widget.hidden = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.options ||= {};
	widget.options.hidden = true;
	widget.options.display = "hidden";
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.y = -10000;
	widget.last_y = -10000;
}

function setWidgetValue(node, name, value) {
	const widget = widgetByName(node, name);
	if (!widget) return;
	widget.value = value;
	widget.callback?.(value, app.canvas, node, app.canvas?.graph_mouse);
}

function boolValue(node) {
	return Boolean(widgetByName(node, "match_image_size")?.value);
}

function directionValue(node) {
	const value = String(widgetByName(node, "direction")?.value || "right");
	return DIRECTIONS.some((item) => item.value === value) ? value : "right";
}

function buttonStyle(button) {
	button.style.border = "1px solid #3E4D54";
	button.style.borderRadius = "6px";
	button.style.background = "#172229";
	button.style.color = "#EAF7EE";
	button.style.fontSize = "16px";
	button.style.fontWeight = "700";
	button.style.lineHeight = "1";
	button.style.minWidth = "34px";
	button.style.height = "30px";
	button.style.padding = "0 8px";
	button.style.cursor = "pointer";
	button.style.boxSizing = "border-box";
}

function activeButton(button, active) {
	button.style.background = active ? "#245B44" : "#172229";
	button.style.borderColor = active ? "#5BD18C" : "#3E4D54";
	button.style.boxShadow = active ? "0 0 0 1px rgba(91,209,140,.28) inset" : "none";
}

function refreshButtons(node) {
	const panel = node.__gjjImageConcatPanel;
	if (!panel) return;
	const direction = directionValue(node);
	const match = boolValue(node);
	for (const button of panel.querySelectorAll("[data-direction]")) {
		activeButton(button, button.dataset.direction === direction);
	}
	const matchButton = panel.querySelector("[data-match]");
	if (matchButton) {
		activeButton(matchButton, match);
		matchButton.title = match ? "匹配首图尺寸：开" : "匹配首图尺寸：关";
	}
}

function createPanel(node) {
	if (node.__gjjImageConcatPanel || typeof node.addDOMWidget !== "function") return;
	hideNativeWidget(widgetByName(node, "direction"));
	hideNativeWidget(widgetByName(node, "match_image_size"));

	const root = document.createElement("div");
	root.style.display = "flex";
	root.style.alignItems = "center";
	root.style.gap = "6px";
	root.style.padding = "4px 0 2px";
	root.style.width = "100%";
	root.style.boxSizing = "border-box";

	const directionRow = document.createElement("div");
	directionRow.style.display = "flex";
	directionRow.style.gap = "4px";
	directionRow.style.flexWrap = "nowrap";

	for (const item of DIRECTIONS) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = item.icon;
		button.title = item.title;
		button.dataset.direction = item.value;
		buttonStyle(button);
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setWidgetValue(node, "direction", item.value);
			refreshButtons(node);
			setDirty(node);
		});
		directionRow.appendChild(button);
	}

	const matchButton = document.createElement("button");
	matchButton.type = "button";
	matchButton.textContent = "✳️";
	matchButton.dataset.match = "1";
	buttonStyle(matchButton);
	matchButton.style.marginLeft = "6px";
	matchButton.addEventListener("pointerdown", (event) => event.stopPropagation());
	matchButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setWidgetValue(node, "match_image_size", !boolValue(node));
		refreshButtons(node);
		setDirty(node);
	});

	root.appendChild(directionRow);
	root.appendChild(matchButton);
	node.__gjjImageConcatPanel = root;

	const domWidget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, { serialize: false, hideOnZoom: false });
	domWidget.computeSize = (width) => [Math.round(width || node.size?.[0] || 180), 38];
	domWidget.getHeight = () => 38;
	refreshButtons(node);
}

function trimUnusedTail(node) {
	const inputs = mediaInputs(node);
	for (let index = inputs.length - 1; index >= 1; index -= 1) {
		const input = inputs[index];
		if (input?.link) break;
		const slot = node.inputs.indexOf(input);
		if (slot >= 0) {
			try { node.disconnectInput?.(slot); } catch (_) {}
			node.removeInput?.(slot);
		}
	}
}

function ensureTrailingInput(node) {
	const inputs = mediaInputs(node);
	if (!inputs.length || inputs[inputs.length - 1]?.link) {
		node.addInput?.(inputName(inputs.length + 1), MEDIA_TYPE);
	}
}

function labelInputs(node) {
	mediaInputs(node).forEach((input, zeroIndex) => {
		const index = zeroIndex + 1;
		input.name = inputName(index);
		input.type = MEDIA_TYPE;
		input.label = `媒体 ${index}`;
		input.localized_name = input.label;
		input.tooltip = `第 ${index} 个拼接媒体，支持 GJJ_BATCH_IMAGE、IMAGE、MASK、VIDEO；连接最后一个口后会自动扩展。`;
	});
}

function stabilize(node) {
	if (!node || (node.comfyClass !== NODE_TYPE && node.type !== NODE_TYPE)) return;
	createPanel(node);
	hideNativeWidget(widgetByName(node, "direction"));
	hideNativeWidget(widgetByName(node, "match_image_size"));
	trimUnusedTail(node);
	ensureTrailingInput(node);
	labelInputs(node);
	refreshButtons(node);
	setDirty(node);
}

function schedule(node, delay = 32) {
	clearTimeout(node.__gjjImageConcatTimer);
	node.__gjjImageConcatTimer = setTimeout(() => stabilize(node), delay);
}

app.registerExtension({
	name: "GJJ.ImageConcanate.DynamicInputs",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			setTimeout(() => stabilize(this), 0);
			setTimeout(() => stabilize(this), 80);
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			setTimeout(() => stabilize(this), 0);
			setTimeout(() => stabilize(this), 80);
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			schedule(this);
			return result;
		};

		const originalDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			const result = originalDrawBackground?.apply(this, args);
			const signature = mediaInputs(this).map((input) => `${input.name}:${input.link || ""}`).join("|");
			if (signature !== this.__gjjImageConcatSignature) {
				this.__gjjImageConcatSignature = signature;
				schedule(this, 16);
			}
			return result;
		};
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === NODE_TYPE || node?.type === NODE_TYPE) {
				stabilize(node);
			}
		}
	},
});
