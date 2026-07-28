import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODE = "GJJ_VideoDepthAnything";
const PANEL_WIDGET = "gjj_video_depth_anything_toolbar";
const OUTPUTS_PROPERTY = "gjj_video_depth_outputs_expanded";
const PARAM_WIDGETS = [
	"input_size",
	"max_res",
	"target_fps",
	"model_name",
	"weight_dtype",
	"resize_method",
	"normalization",
	"offload_after",
];
const BOOLEAN_BUTTONS = [
	{ name: "fp32", icon: "🧮", activeTitle: "FP32 推理：已开启", inactiveTitle: "FP32 推理：已关闭（CUDA 使用半精度）" },
	{ name: "invert_depth", icon: "◐", activeTitle: "深度反相：已开启", inactiveTitle: "深度反相：已关闭" },
	{ name: "apply_sky_clip", icon: "☁️", activeTitle: "天空深度裁切：已开启", inactiveTitle: "天空深度裁切：已关闭" },
];
const OPTIONAL_OUTPUTS = [
	{ name: "深度伪彩图", type: "IMAGE" },
	{ name: "深度遮罩", type: "MASK" },
	{ name: "帧率", type: "FLOAT" },
	{ name: "置信度", type: "IMAGE" },
	{ name: "天空遮罩", type: "IMAGE" },
];

let activePopover = null;

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function asBool(value) {
	if (typeof value === "boolean") return value;
	return ["1", "true", "yes", "on", "启用", "开"].includes(String(value ?? "").trim().toLowerCase());
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget || widget.value === value) return;
	widget.value = value;
	widget.callback?.(value);
	node.setDirtyCanvas?.(true, true);
}

function sanitizeWidgetValues(node) {
	const numberDefaults = {
		input_size: { value: 518, min: 196, max: 1024 },
		max_res: { value: 1280, min: 0, max: 4096 },
		target_fps: { value: 24, min: 1, max: 240 },
	};
	for (const [name, rule] of Object.entries(numberDefaults)) {
		const widget = getWidget(node, name);
		const number = Number(widget?.value);
		if (widget && (!Number.isFinite(number) || number < rule.min || number > rule.max)) widget.value = rule.value;
	}
	const comboDefaults = {
		weight_dtype: "default",
		resize_method: "upper_bound_resize",
		normalization: "v2_style",
	};
	for (const [name, fallback] of Object.entries(comboDefaults)) {
		const widget = getWidget(node, name);
		const choices = comboValues(widget);
		if (widget && choices.length && !choices.includes(String(widget.value ?? ""))) widget.value = fallback;
	}
	const modelWidget = getWidget(node, "model_name");
	const modelChoices = comboValues(modelWidget);
	if (modelWidget && modelChoices.length && !modelChoices.includes(String(modelWidget.value ?? ""))) {
		modelWidget.value = modelChoices.includes("depth_anything_3_base.safetensors")
			? "depth_anything_3_base.safetensors"
			: modelChoices.find((name) => /depth[_-]?anything[_-]?3/i.test(name)) || modelChoices[0];
	}
}

function hideWidget(widget) {
	if (!widget || widget.__gjjVideoDepthHidden) return;
	widget.__gjjVideoDepthHidden = true;
	widget.__gjjVideoDepthOriginalType = widget.type;
	widget.hidden = true;
	widget.type = "hidden";
	widget.serialize = true;
	widget.serializeValue = () => widget.value;
	widget.options = { ...(widget.options || {}), hidden: true, display: "hidden", serialize: true };
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.computedHeight = 0;
	widget.margin_top = 0;
	widget.size = [0, 0];
	widget.last_y = 0;
	if (widget.element) widget.element.style.display = "none";
}

function closePopover() {
	activePopover?.remove?.();
	activePopover = null;
}

function protect(element) {
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
}

function createPopover(anchor, title) {
	closePopover();
	const rect = anchor.getBoundingClientRect();
	const popup = document.createElement("div");
	popup.className = "gjj-vda-popover";
	popup.style.left = `${Math.max(8, Math.min(window.innerWidth - 348, rect.left))}px`;
	popup.style.top = `${Math.min(window.innerHeight - 220, rect.bottom + 6)}px`;

	const head = document.createElement("div");
	head.className = "gjj-vda-popover-head";
	const heading = document.createElement("strong");
	heading.textContent = title;
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "×";
	close.title = "关闭";
	close.addEventListener("click", closePopover);
	head.append(heading, close);
	popup.appendChild(head);
	protect(popup);
	document.body.appendChild(popup);
	activePopover = popup;
	return popup;
}

function createNumberField(node, name, label) {
	const widget = getWidget(node, name);
	const row = document.createElement("label");
	row.className = "gjj-vda-field";
	const text = document.createElement("span");
	text.textContent = label;
	const input = document.createElement("input");
	input.type = "number";
	input.value = String(widget?.value ?? "");
	input.min = String(widget?.options?.min ?? "");
	input.max = String(widget?.options?.max ?? "");
	input.step = String(widget?.options?.step ?? 1);
	input.addEventListener("input", () => {
		const number = Number(input.value);
		if (Number.isFinite(number)) setWidgetValue(node, name, number);
	});
	row.append(text, input);
	return row;
}

function comboValues(widget) {
	const values = widget?.options?.values ?? widget?.options?.values_list ?? widget?.options?.items ?? [];
	return Array.isArray(values) ? values.map(String) : [];
}

function createSelectField(node, name, label) {
	const widget = getWidget(node, name);
	const row = document.createElement("label");
	row.className = "gjj-vda-field";
	const text = document.createElement("span");
	text.textContent = label;
	const select = document.createElement("select");
	for (const value of comboValues(widget)) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value;
		select.appendChild(option);
	}
	select.value = String(widget?.value ?? "");
	select.addEventListener("change", () => setWidgetValue(node, name, select.value));
	row.append(text, select);
	return row;
}

function openModelPanel(node, anchor) {
	const popup = createPopover(anchor, "🧠 Video Depth Anything 模型");
	const popupWidth = Math.min(560, window.innerWidth - 24);
	const anchorRect = anchor.getBoundingClientRect();
	popup.style.width = `${popupWidth}px`;
	popup.style.left = `${Math.max(12, Math.min(window.innerWidth - popupWidth - 12, anchorRect.left))}px`;
	const keepButton = document.createElement("button");
	keepButton.type = "button";
	keepButton.className = "gjj-vda-keep-toggle";
	const refreshKeepButton = () => {
		const keep = !asBool(getWidget(node, "offload_after")?.value);
		keepButton.classList.toggle("active", keep);
		keepButton.textContent = keep ? "🧠 保持模型：开启" : "🧠 保持模型：关闭";
		keepButton.title = keep
			? "执行完成后保留模型缓存，重复运行无需重新加载。"
			: "执行完成后卸载模型并清理显存。";
	};
	keepButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const keep = !asBool(getWidget(node, "offload_after")?.value);
		setWidgetValue(node, "offload_after", keep);
		refreshKeepButton();
		refreshToolbar(node);
	});
	refreshKeepButton();
	const tree = GJJ_Utils.createModelTreeView({
		node,
		entries: [
			{
				widget: "model_name",
				label: "Depth Anything 3",
				folder: "models/geometry_estimation",
				icon: "🔵",
				anyKeywords: ["depth_anything_3", "depthanything3"],
				fallback: String(getWidget(node, "model_name")?.value || "depth_anything_3_base.safetensors"),
				autoSelect: true,
				description: "Depth Anything 3 模型；从 models/geometry_estimation 读取 safetensors。",
			},
		],
		refresh: () => node.setDirtyCanvas?.(true, true),
		onApply: () => node.setDirtyCanvas?.(true, true),
	});
	tree.style.maxHeight = "320px";
	const device = document.createElement("div");
	device.className = "gjj-vda-note";
	device.textContent = "运行设备：自动跟随 ComfyUI 当前模型设备";
	popup.append(
		keepButton,
		tree,
		createSelectField(node, "weight_dtype", "权重精度"),
		createNumberField(node, "input_size", "模型输入尺寸"),
		device
	);
}

function openSettingsPanel(node, anchor) {
	const popup = createPopover(anchor, "⚙️ 视频深度参数");
	popup.append(
		createNumberField(node, "max_res", "最大输出边"),
		createNumberField(node, "target_fps", "输出帧率"),
		createSelectField(node, "resize_method", "缩放方式"),
		createSelectField(node, "normalization", "深度归一化")
	);
}

function outputsExpanded(node) {
	return Boolean(node?.properties?.[OUTPUTS_PROPERTY]);
}

function setOutputsExpanded(node, expanded) {
	node.properties = node.properties || {};
	if (!expanded) {
		const linked = (node.outputs || []).slice(1).some((output) => Array.isArray(output?.links) && output.links.length);
		if (linked) return;
		while ((node.outputs || []).length > 1) node.removeOutput?.(node.outputs.length - 1);
	} else {
		for (let index = Math.max(0, (node.outputs || []).length - 1); index < OPTIONAL_OUTPUTS.length; index++) {
			const output = OPTIONAL_OUTPUTS[index];
			node.addOutput?.(output.name, output.type);
		}
	}
	node.properties[OUTPUTS_PROPERTY] = Boolean(expanded);
	const button = node.__gjjVideoDepthPlugButton;
	if (button) {
		button.classList.toggle("active", Boolean(expanded));
		button.title = expanded
			? "隐藏其他输出接口（存在连线时不会隐藏）"
			: "显示伪彩、遮罩、帧率、置信度和天空遮罩输出";
	}
	node.setDirtyCanvas?.(true, true);
}

function refreshToolbar(node) {
	for (const item of BOOLEAN_BUTTONS) {
		const button = node.__gjjVideoDepthButtons?.[item.name];
		if (!button) continue;
		const active = asBool(getWidget(node, item.name)?.value);
		button.classList.toggle("active", active);
		button.textContent = item.icon;
		button.title = active ? item.activeTitle : item.inactiveTitle;
	}
	const keepModel = !asBool(getWidget(node, "offload_after")?.value);
	const modelButton = node.__gjjVideoDepthModelButton;
	if (modelButton) {
		modelButton.classList.toggle("active", keepModel);
		modelButton.title = keepModel ? "模型设置 · 当前保持模型" : "模型设置 · 当前完成后卸载";
	}
}

function toolbarHeight(width) {
	const buttonCount = BOOLEAN_BUTTONS.length + 3;
	const available = Math.max(36, Number(width || 300) - 4);
	const perRow = Math.max(1, Math.floor((available + 4) / 40));
	const rows = Math.ceil(buttonCount / perRow);
	return rows * 30 + Math.max(0, rows - 1) * 4 + 6;
}

function installStyles() {
	if (document.getElementById("gjj-video-depth-anything-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-video-depth-anything-style";
	style.textContent = `
		.gjj-vda-toolbar{display:flex;flex-wrap:wrap;gap:4px;align-items:center;align-content:flex-start;width:100%;padding:3px 2px;box-sizing:border-box;pointer-events:auto;user-select:none;cursor:default}
		.gjj-vda-toolbar *{pointer-events:auto}
		.gjj-vda-button{height:30px;width:36px;min-width:36px;padding:0;border:1px solid #44555e;border-radius:7px;background:#202a2f;color:#dce7eb;font-size:17px;font-weight:700;cursor:pointer}
		.gjj-vda-button:hover{filter:brightness(1.18)}
		.gjj-vda-button.active{background:#175c47;border-color:#35d09a;color:#eafff7;box-shadow:0 0 0 1px #35d09a44 inset}
		.gjj-vda-button.panel{width:36px;min-width:36px;padding:0;font-size:17px}
		.gjj-vda-keep-toggle{width:100%;height:32px;margin-bottom:8px;border:1px solid #4b5c65;border-radius:7px;background:#202a2f;color:#dce7eb;font-weight:800;cursor:pointer;pointer-events:auto}
		.gjj-vda-keep-toggle.active{background:#175c47;border-color:#35d09a;color:#eafff7;box-shadow:0 0 0 1px #35d09a44 inset}
		.gjj-vda-popover{position:fixed;z-index:100000;width:340px;padding:10px;border:1px solid #51636d;border-radius:10px;background:#121a1e;color:#e5edf0;box-shadow:0 14px 42px #000b;box-sizing:border-box}
		.gjj-vda-popover-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
		.gjj-vda-popover-head button{width:28px;height:26px;border:1px solid #46565f;border-radius:6px;background:#202a2f;color:#e5edf0;cursor:pointer}
		.gjj-vda-field{display:grid;grid-template-columns:120px minmax(0,1fr);gap:8px;align-items:center;margin-top:8px}
		.gjj-vda-field input,.gjj-vda-field select{min-width:0;height:30px;padding:0 8px;border:1px solid #40515a;border-radius:6px;background:#0f171b;color:#eef6f8}
		.gjj-vda-model-path{display:grid;gap:5px}
		.gjj-vda-model-path span,.gjj-vda-note{color:#aebdc4;font-size:12px}
		.gjj-vda-model-path code{overflow-wrap:anywhere;padding:7px;border-radius:6px;background:#0d1417;color:#9ee8ca}
		.gjj-vda-note{margin-top:8px}
	`;
	document.head.appendChild(style);
}

function setupNode(node) {
	if (node.__gjjVideoDepthReady) return;
	node.__gjjVideoDepthReady = true;
	installStyles();

	for (const name of [...PARAM_WIDGETS, ...BOOLEAN_BUTTONS.map((item) => item.name)]) hideWidget(getWidget(node, name));
	sanitizeWidgetValues(node);

	const toolbar = document.createElement("div");
	toolbar.className = "gjj-vda-toolbar";
	node.__gjjVideoDepthButtons = {};
	for (const item of BOOLEAN_BUTTONS) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "gjj-vda-button";
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setWidgetValue(node, item.name, !asBool(getWidget(node, item.name)?.value));
			refreshToolbar(node);
		});
		node.__gjjVideoDepthButtons[item.name] = button;
		toolbar.appendChild(button);
	}
	const plugButton = document.createElement("button");
	plugButton.type = "button";
	plugButton.className = "gjj-vda-button";
	plugButton.textContent = "🔌";
	plugButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setOutputsExpanded(node, !outputsExpanded(node));
	});
	node.__gjjVideoDepthPlugButton = plugButton;
	toolbar.appendChild(plugButton);
	const modelButton = document.createElement("button");
	modelButton.type = "button";
	modelButton.className = "gjj-vda-button panel";
	modelButton.textContent = "🧠";
	modelButton.title = "模型设置";
	modelButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openModelPanel(node, modelButton);
	});
	node.__gjjVideoDepthModelButton = modelButton;
	const settingsButton = document.createElement("button");
	settingsButton.type = "button";
	settingsButton.className = "gjj-vda-button panel";
	settingsButton.textContent = "⚙️";
	settingsButton.title = "其他参数";
	settingsButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openSettingsPanel(node, settingsButton);
	});
	toolbar.append(modelButton, settingsButton);
	protect(toolbar);
	const panel = node.addDOMWidget(PANEL_WIDGET, "HTML", toolbar, { serialize: false, hideOnZoom: false });
	panel.serialize = false;
	panel.computeSize = (width) => {
		const resolvedWidth = Number(width || node.size?.[0] || 300);
		return [resolvedWidth, toolbarHeight(resolvedWidth)];
	};
	panel.getHeight = () => toolbarHeight(node.size?.[0] || 300);
	if (panel.element?.style) panel.element.style.pointerEvents = "auto";
	if (panel && Array.isArray(node.widgets)) {
		for (const widget of node.widgets) {
			if (!widget?.__gjjVideoDepthHidden) continue;
			widget.last_y = 0;
			widget.computedHeight = 0;
			widget.margin_top = 0;
			widget.size = [0, 0];
		}
	}
	refreshToolbar(node);
	setOutputsExpanded(node, outputsExpanded(node));
	requestAnimationFrame(() => {
		node.setSize?.([Math.max(300, node.size?.[0] || 0), 150]);
		node.setDirtyCanvas?.(true, true);
	});
}

if (!window.__gjjVideoDepthAnythingCloseBound) {
	window.__gjjVideoDepthAnythingCloseBound = true;
	document.addEventListener("pointerdown", (event) => {
		if (activePopover && !activePopover.contains(event.target)) closePopover();
	});
}

app.registerExtension({
	name: "GJJ.VideoDepthAnything.Toolbar",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_NODE) return;
		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const result = originalCreated?.apply(this, arguments);
			this.properties = this.properties || {};
			this.properties[OUTPUTS_PROPERTY] = false;
			setupNode(this);
			return result;
		};
		const originalConfigured = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function () {
			const serialized = arguments[0];
			const result = originalConfigured?.apply(this, arguments);
			this.properties = this.properties || {};
			if (serialized?.properties?.[OUTPUTS_PROPERTY] !== undefined) {
				this.properties[OUTPUTS_PROPERTY] = Boolean(serialized.properties[OUTPUTS_PROPERTY]);
			} else {
				this.properties[OUTPUTS_PROPERTY] = (this.outputs || []).length > 1;
			}
			requestAnimationFrame(() => {
				setupNode(this);
				sanitizeWidgetValues(this);
				refreshToolbar(this);
				setOutputsExpanded(this, outputsExpanded(this));
			});
			return result;
		};
		const originalRemoved = nodeType.prototype.onRemoved;
		nodeType.prototype.onRemoved = function () {
			closePopover();
			return originalRemoved?.apply(this, arguments);
		};
	},
});
