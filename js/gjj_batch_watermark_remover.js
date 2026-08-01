import { app } from "/scripts/app.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";
import { gjjRenderMediaPreview } from "./gjj_common_media_preview.js";

const TARGET_NODE = "GJJ_BatchWatermarkRemover";
const TOOLBAR_WIDGET = "gjj_watermark_toolbar";
const PREVIEW_WIDGET = "gjj_watermark_preview";
const WMR_NODES = new Set();
let outsideClickReady = false;
const GROUPS = [
	{
		key: "size",
		emoji: "📐",
		title: "尺寸",
		fields: ["working_megapixels", "output_size_mode", "scale_method"],
	},
	{
		key: "model",
		emoji: "🧠",
		title: "模型",
		fields: [],
	},
	{
		key: "prompt",
		emoji: "📒",
		title: "提示词",
		fields: ["prompt", "negative_prompt"],
	},
	{
		key: "sampling",
		emoji: "⚙️",
		title: "采样",
		fields: ["steps", "cfg", "seed"],
	},
	{
		key: "save",
		emoji: "💾",
		title: "保存",
		fields: ["auto_save", "filename_prefix", "filename_regex"],
	},
];

function injectStyle() {
	if (document.getElementById("gjj-watermark-remover-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-watermark-remover-style";
	style.textContent = `
		.gjj-wmr-toolbar{display:flex;gap:7px;align-items:center;justify-content:center;width:100%;height:38px;padding:2px 4px;box-sizing:border-box}
		.gjj-wmr-tool{width:42px;height:32px;border:1px solid #425661;border-radius:9px;background:#172229;color:#eefaff;font-size:18px;cursor:pointer;transition:.14s}
		.gjj-wmr-tool:hover,.gjj-wmr-tool.on{background:#244653;border-color:#63d3c5;box-shadow:0 0 0 1px #63d3c555}
		.gjj-wmr-tool.keep-on{background:linear-gradient(135deg,#115e59,#047857);border-color:#5eead4;box-shadow:0 0 0 1px #2dd4bf66,0 0 14px #14b8a633}
		.gjj-wmr-tool.keep-off{background:linear-gradient(135deg,#351b22,#54232c);border-color:#89515c;box-shadow:none}
		.gjj-wmr-float{position:fixed;z-index:100000;width:min(440px,calc(100vw - 28px));max-height:min(72vh,640px);overflow:auto;padding:14px;border:1px solid #45616b;border-radius:13px;background:#101a20;color:#dcecf1;box-shadow:0 18px 55px #000b;font:13px/1.4 Arial,sans-serif;box-sizing:border-box}
		.gjj-wmr-float.model-keep-on{background:linear-gradient(155deg,#102923,#101a20 55%);border-color:#5eead4;box-shadow:0 18px 55px #000b,0 0 0 1px #2dd4bf44}
		.gjj-wmr-float.model-keep-off{background:linear-gradient(155deg,#29171b,#101a20 55%);border-color:#89515c}
		.gjj-wmr-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:11px;font-size:15px;font-weight:700}
		.gjj-wmr-close{border:0;background:transparent;color:#9fb0b7;font-size:20px;cursor:pointer}
		.gjj-wmr-row{display:grid;grid-template-columns:128px minmax(0,1fr);gap:9px;align-items:center;margin:9px 0}
		.gjj-wmr-row label{color:#b9cbd1}
		.gjj-wmr-row input,.gjj-wmr-row select,.gjj-wmr-row textarea{width:100%;min-width:0;padding:7px 8px;border:1px solid #334b55;border-radius:7px;background:#0b1419;color:#e8f4f7;box-sizing:border-box}
		.gjj-wmr-row textarea{min-height:62px;resize:vertical}
		.gjj-wmr-row input[type=checkbox]{width:18px;height:18px;justify-self:start}
		.gjj-wmr-keep{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px;padding:10px 12px;border:1px solid #3d5962;border-radius:9px;background:#0b141988}
		.gjj-wmr-keep button{min-width:92px;padding:7px 11px;border:1px solid #64748b;border-radius:8px;background:#27333b;color:#e5eef2;font-weight:700;cursor:pointer}
		.gjj-wmr-keep button.on{background:#047857;border-color:#5eead4;color:#ecfdf5}
		.gjj-wmr-preview{display:none;width:100%;min-width:0;padding:4px;box-sizing:border-box;pointer-events:auto}
	`;
	document.head.appendChild(style);
}

function widget(node, name) {
	return node?.widgets?.find((item) => item?.name === name) || null;
}

function hideNativeWidget(item) {
	if (!item || item.name === TOOLBAR_WIDGET || item.name === PREVIEW_WIDGET) return;
	item.options ||= {};
	item.hidden = true;
	item.type = "hidden";
	item.options.hidden = true;
	item.options.display = "hidden";
	item.computeSize = () => [0, -4];
	item.getHeight = () => 0;
	item.draw = () => {};
	item.mouse = () => false;
	if (item.widget) item.widget.style.display = "none";
	if (item.element) item.element.style.display = "none";
	if (item.inputEl) item.inputEl.style.display = "none";
}

function previewImagesFromMessage(message) {
	const candidates = [
		message?.preview_images,
		message?.ui?.preview_images,
		message?.output?.preview_images,
		message?.results?.preview_images,
	];
	for (const value of candidates) {
		if (Array.isArray(value) && value.some((item) => item?.filename)) {
			return value.filter((item) => item?.filename);
		}
	}
	return [];
}

function previewHeight(node) {
	const count = Number(node?.__gjjWmrPreviewItems?.length || 0);
	if (!count) return 0;
	return count === 1 ? 286 : Math.min(500, Math.ceil(count / 2) * 152 + 8);
}

function refreshPreviewLayout(node) {
	const state = node?.__gjjWmrPreview;
	if (!state) return;
	state.widget.computeSize = (width) => [Math.max(190, Number(width || node.size?.[0] || 240) - 20), previewHeight(node)];
	state.widget.getHeight = () => previewHeight(node);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
	requestAnimationFrame(() => {
		const computed = node.computeSize?.();
		if (!Array.isArray(computed)) return;
		const width = Math.max(230, Number(node.size?.[0] || computed[0] || 230));
		node.setSize?.([width, Math.max(92, Number(computed[1] || 92))]);
	});
}

function renderPreview(node, items) {
	const state = node?.__gjjWmrPreview;
	if (!state) return;
	const images = Array.isArray(items) ? items.filter((item) => item?.filename) : [];
	node.__gjjWmrPreviewItems = images;
	if (!images.length) {
		state.root.replaceChildren();
		state.root.style.display = "none";
		refreshPreviewLayout(node);
		return;
	}
	state.root.style.display = "block";
	gjjRenderMediaPreview(state.root, images, {
		forceGrid: images.length > 1,
		enableAnyPreviewDrag: true,
		singleMinHeight: 188,
		singleMaxHeight: 248,
		tileMinWidth: 116,
		tileMinHeight: 118,
		showGridKindBadge: false,
		onLayout: () => refreshPreviewLayout(node),
	});
	refreshPreviewLayout(node);
}

function ensurePreview(node) {
	if (node.__gjjWmrPreview) return node.__gjjWmrPreview;
	const root = document.createElement("div");
	root.className = "gjj-wmr-preview";
	const previewWidget = node.addDOMWidget(PREVIEW_WIDGET, "div", root, { serialize: false, hideOnZoom: false });
	previewWidget.serialize = false;
	previewWidget.options ||= {};
	previewWidget.options.serialize = false;
	node.__gjjWmrPreview = { root, widget: previewWidget };
	refreshPreviewLayout(node);
	return node.__gjjWmrPreview;
}

function setWidgetValue(node, item, value) {
	if (!item) return;
	item.value = value;
	item.callback?.(value, app.canvas, node, app.canvas?.graph_mouse, {});
	node.graph?.setDirtyCanvas?.(true, true);
}

function keepModelEnabled(node) {
	return Boolean(widget(node, "keep_model")?.value);
}

function refreshKeepModelState(node) {
	const enabled = keepModelEnabled(node);
	const button = node?.__gjjWmrButtons?.get("model");
	button?.classList.toggle("keep-on", enabled);
	button?.classList.toggle("keep-off", !enabled);
	if (button) button.title = enabled ? "模型；保持模型已开启" : "模型；保持模型已关闭";
	const panel = node?.__gjjWmrPanel;
	if (panel && node.__gjjWmrActive === "model") {
		panel.classList.toggle("model-keep-on", enabled);
		panel.classList.toggle("model-keep-off", !enabled);
	}
	const toggle = node?.__gjjWmrKeepToggle;
	if (toggle) {
		toggle.classList.toggle("on", enabled);
		toggle.textContent = enabled ? "保持：开" : "保持：关";
		toggle.title = enabled ? "执行结束后保持模型；点击关闭" : "执行结束后释放模型；点击开启";
	}
}

function appendKeepModelToggle(node, panel) {
	const item = widget(node, "keep_model");
	if (!item) return;
	const row = document.createElement("div");
	row.className = "gjj-wmr-keep";
	const label = document.createElement("span");
	label.textContent = "保持模型";
	label.title = String(item?.options?.tooltip || "");
	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.onclick = () => {
		setWidgetValue(node, item, !keepModelEnabled(node));
		refreshKeepModelState(node);
	};
	row.append(label, toggle);
	panel.appendChild(row);
	node.__gjjWmrKeepToggle = toggle;
	refreshKeepModelState(node);
}

function fieldLabel(item) {
	return String(item?.label || item?.options?.display_name || item?.name || "");
}

function comboValues(item) {
	const values = item?.options?.values;
	return typeof values === "function" ? values() : (Array.isArray(values) ? values : []);
}

function modelTreeEntries(node) {
	const definitions = [
		{
			widget: "unet_name",
			label: "Flux2 Klein UNET 主模型",
			folder: "models/diffusion_models",
			icon: "🟣",
			description: "去水印重绘主模型。过滤词由当前模型名称自动生成。",
		},
		{
			widget: "clip_name",
			label: "Qwen 文本编码器",
			folder: "models/text_encoders",
			icon: "🟡",
			description: "与主模型配套的文本编码器。过滤词由当前模型名称去除路径、扩展名和量化标记后自动生成。",
		},
		{
			widget: "vae_name",
			label: "Flux2 VAE",
			folder: "models/vae",
			icon: "🔴",
			description: "用于编码输入参考图并解码去水印结果。过滤词由当前模型名称自动生成。",
		},
	];
	return definitions.map((entry) => {
		const item = widget(node, entry.widget);
		const models = comboValues(item).filter((name) => !String(name || "").trim().startsWith("缺失："));
		const defaultModel = String(item?.options?.gjj_default_model || item?.options?.default || "").trim();
		return {
			...entry,
			models,
			defaultModel,
			fallback: defaultModel,
			missingDefault: models.length === 0,
			autoSelect: true,
		};
	});
}

function appendModelTree(node, panel) {
	const title = document.createElement("div");
	title.textContent = "模型树";
	title.style.cssText = "margin:12px 0 7px;color:#9fd4c3;font-weight:800";
	const tree = GJJ_Utils.createModelTreeView({
		node,
		entries: modelTreeEntries(node),
		refresh: () => node.graph?.setDirtyCanvas?.(true, true),
		onApply: () => node.graph?.setDirtyCanvas?.(true, true),
	});
	tree.style.maxHeight = "330px";
	panel.append(title, tree);
}

function makeControl(node, item) {
	const values = comboValues(item);
	let control;
	if (values.length) {
		control = document.createElement("select");
		for (const value of values) {
			const option = document.createElement("option");
			option.value = String(value);
			option.textContent = String(value);
			control.appendChild(option);
		}
		control.value = String(item.value ?? "");
		control.addEventListener("change", () => setWidgetValue(node, item, control.value));
	} else if (typeof item.value === "boolean") {
		control = document.createElement("input");
		control.type = "checkbox";
		control.checked = Boolean(item.value);
		control.addEventListener("change", () => setWidgetValue(node, item, control.checked));
	} else if (typeof item.value === "number") {
		control = document.createElement("input");
		control.type = "number";
		if (Number.isFinite(Number(item.options?.min))) control.min = String(item.options.min);
		if (Number.isFinite(Number(item.options?.max))) control.max = String(item.options.max);
		if (Number.isFinite(Number(item.options?.step))) control.step = String(item.options.step);
		control.value = String(item.value);
		control.addEventListener("change", () => setWidgetValue(node, item, Number(control.value)));
	} else {
		control = document.createElement(item.name?.includes("prompt") ? "textarea" : "input");
		if (control.tagName === "INPUT") control.type = "text";
		control.value = String(item.value ?? "");
		control.addEventListener("change", () => setWidgetValue(node, item, control.value));
	}
	control.title = String(item?.options?.tooltip || "");
	return control;
}

function closePanel(node) {
	node.__gjjWmrPanel?.remove();
	node.__gjjWmrPanel = null;
	node.__gjjWmrActive = "";
	node.__gjjWmrKeepToggle = null;
	for (const button of node.__gjjWmrButtons?.values?.() || []) button.classList.remove("on");
}

function ensureOutsideClickHandler() {
	if (outsideClickReady) return;
	outsideClickReady = true;
	window.addEventListener("pointerdown", (event) => {
		const target = event.target;
		for (const node of WMR_NODES) {
			if (!node?.__gjjWmrPanel) continue;
			if (node.__gjjWmrPanel.contains(target)) continue;
			const clickedTool = [...(node.__gjjWmrButtons?.values?.() || [])].some((button) => button.contains(target));
			if (!clickedTool) closePanel(node);
		}
	}, true);
}

function positionPanel(node, panel, group) {
	const button = node?.__gjjWmrButtons?.get(group?.key);
	const rect = button?.getBoundingClientRect?.();
	let left = Number(rect?.left || 14);
	const top = Number(rect?.bottom || 14) + 8;
	left = Math.max(14, Math.min(left, window.innerWidth - Math.min(440, window.innerWidth - 28) - 14));
	panel.style.left = `${Math.round(left)}px`;
	panel.style.top = `${Math.round(top)}px`;
	panel.style.maxHeight = `${Math.max(120, window.innerHeight - top - 14)}px`;
}

function openPanel(node, group) {
	if (node.__gjjWmrActive === group.key) {
		closePanel(node);
		return;
	}
	closePanel(node);
	const panel = document.createElement("div");
	panel.className = "gjj-wmr-float";
	const head = document.createElement("div");
	head.className = "gjj-wmr-head";
	head.innerHTML = `<span>${group.emoji} ${group.title}</span>`;
	const close = document.createElement("button");
	close.className = "gjj-wmr-close";
	close.textContent = "×";
	close.onclick = () => closePanel(node);
	head.appendChild(close);
	panel.appendChild(head);
	if (group.key === "model") appendKeepModelToggle(node, panel);
	for (const name of group.fields) {
		const item = widget(node, name);
		if (!item) continue;
		const row = document.createElement("div");
		row.className = "gjj-wmr-row";
		const label = document.createElement("label");
		label.textContent = fieldLabel(item);
		row.append(label, makeControl(node, item));
		panel.appendChild(row);
	}
	if (group.key === "model") appendModelTree(node, panel);
	document.body.appendChild(panel);
	node.__gjjWmrPanel = panel;
	node.__gjjWmrActive = group.key;
	node.__gjjWmrButtons?.get(group.key)?.classList.add("on");
	positionPanel(node, panel, group);
	refreshKeepModelState(node);
}

function setupNode(node) {
	if (node.__gjjWmrReady) return;
	node.__gjjWmrReady = true;
	WMR_NODES.add(node);
	ensureOutsideClickHandler();
	injectStyle();
	for (const item of node.widgets || []) hideNativeWidget(item);

	const toolbar = document.createElement("div");
	toolbar.className = "gjj-wmr-toolbar";
	node.__gjjWmrButtons = new Map();
	const runButton = document.createElement("button");
	runButton.className = "gjj-wmr-tool";
	runButton.textContent = "▶️";
	runButton.title = "只执行当前批量去水印节点";
	runButton.onclick = async (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (runButton.disabled) return;
		runButton.disabled = true;
		try {
			await queueOnlyCurrentNode(node);
		} finally {
			runButton.disabled = false;
		}
	};
	for (const group of GROUPS) {
		const button = document.createElement("button");
		button.className = "gjj-wmr-tool";
		button.textContent = group.emoji;
		button.title = group.title;
		button.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			openPanel(node, group);
		};
		node.__gjjWmrButtons.set(group.key, button);
		toolbar.appendChild(button);
	}
	refreshKeepModelState(node);
	toolbar.appendChild(runButton);
	const domWidget = node.addDOMWidget(TOOLBAR_WIDGET, "div", toolbar, { serialize: false });
	domWidget.computeSize = (width) => [Math.max(250, Number(width || node.size?.[0] || 270) - 20), 42];
	node.size = [Math.max(270, Number(node.size?.[0] || 270)), Math.max(92, Number(node.computeSize?.()?.[1] || 92))];
	ensurePreview(node);

	const previousRemoved = node.onRemoved;
	node.onRemoved = function (...args) {
		closePanel(this);
		WMR_NODES.delete(this);
		return previousRemoved?.apply(this, args);
	};
}

app.registerExtension({
	name: "GJJ.BatchWatermarkRemover.CompactPanels",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_NODE) return;
		const previousCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = previousCreated?.apply(this, args);
			queueMicrotask(() => setupNode(this));
			return result;
		};
		const previousConfigured = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = previousConfigured?.apply(this, args);
			queueMicrotask(() => {
				for (const item of this.widgets || []) hideNativeWidget(item);
				refreshKeepModelState(this);
			});
			return result;
		};
		const previousExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = previousExecuted?.apply(this, arguments);
			ensurePreview(this);
			renderPreview(this, previewImagesFromMessage(message));
			return result;
		};
	},
});
