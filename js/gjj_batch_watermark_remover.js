import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODE = "GJJ_BatchWatermarkRemover";
const TOOLBAR_WIDGET = "gjj_watermark_toolbar";
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
		title: "模型与提示词",
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
		.gjj-wmr-float{position:fixed;z-index:100000;width:min(440px,calc(100vw - 28px));max-height:min(72vh,640px);overflow:auto;padding:14px;border:1px solid #45616b;border-radius:13px;background:#101a20;color:#dcecf1;box-shadow:0 18px 55px #000b;font:13px/1.4 Arial,sans-serif;box-sizing:border-box}
		.gjj-wmr-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:11px;font-size:15px;font-weight:700}
		.gjj-wmr-close{border:0;background:transparent;color:#9fb0b7;font-size:20px;cursor:pointer}
		.gjj-wmr-row{display:grid;grid-template-columns:128px minmax(0,1fr);gap:9px;align-items:center;margin:9px 0}
		.gjj-wmr-row label{color:#b9cbd1}
		.gjj-wmr-row input,.gjj-wmr-row select,.gjj-wmr-row textarea{width:100%;min-width:0;padding:7px 8px;border:1px solid #334b55;border-radius:7px;background:#0b1419;color:#e8f4f7;box-sizing:border-box}
		.gjj-wmr-row textarea{min-height:62px;resize:vertical}
		.gjj-wmr-row input[type=checkbox]{width:18px;height:18px;justify-self:start}
	`;
	document.head.appendChild(style);
}

function widget(node, name) {
	return node?.widgets?.find((item) => item?.name === name) || null;
}

function hideNativeWidget(item) {
	if (!item || item.name === TOOLBAR_WIDGET) return;
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

function setWidgetValue(node, item, value) {
	if (!item) return;
	item.value = value;
	item.callback?.(value, app.canvas, node, app.canvas?.graph_mouse, {});
	node.graph?.setDirtyCanvas?.(true, true);
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
			anyKeywords: ["flux-2-klein-4b", "flux-2-klein-9b"],
			description: "去水印重绘主模型；4B 与 9B 必须搭配对应的 Qwen 文本编码器。",
		},
		{
			widget: "clip_name",
			label: "Qwen 文本编码器",
			folder: "models/text_encoders",
			icon: "🟡",
			anyKeywords: ["qwen_3_4b", "qwen_3_8b"],
			description: "4B UNET 使用 qwen_3_4b，9B UNET 使用 qwen_3_8b。",
		},
		{
			widget: "vae_name",
			label: "Flux2 VAE",
			folder: "models/vae",
			icon: "🔴",
			anyKeywords: ["flux2-vae"],
			description: "用于编码输入参考图并解码去水印结果。",
		},
	];
	return definitions.map((entry) => {
		const item = widget(node, entry.widget);
		return {
			...entry,
			models: comboValues(item),
			fallback: String(item?.value || "未找到可用模型"),
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
	for (const button of node.__gjjWmrButtons?.values?.() || []) button.classList.remove("on");
}

function positionPanel(node, panel) {
	const canvas = app.canvas?.canvas;
	const rect = canvas?.getBoundingClientRect?.();
	const scale = Number(app.canvas?.ds?.scale || 1);
	const offset = app.canvas?.ds?.offset || [0, 0];
	const graphX = Number(node?.pos?.[0] || 0);
	const graphY = Number(node?.pos?.[1] || 0);
	let left = (rect?.left || 0) + (graphX + Number(offset[0] || 0)) * scale + Number(node?.size?.[0] || 260) * scale + 12;
	let top = (rect?.top || 0) + (graphY + Number(offset[1] || 0)) * scale;
	left = Math.max(14, Math.min(left, window.innerWidth - Math.min(440, window.innerWidth - 28) - 14));
	top = Math.max(14, Math.min(top, window.innerHeight - Math.min(420, window.innerHeight - 28) - 14));
	panel.style.left = `${Math.round(left)}px`;
	panel.style.top = `${Math.round(top)}px`;
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
	positionPanel(node, panel);
}

function setupNode(node) {
	if (node.__gjjWmrReady) return;
	node.__gjjWmrReady = true;
	injectStyle();
	for (const item of node.widgets || []) hideNativeWidget(item);

	const toolbar = document.createElement("div");
	toolbar.className = "gjj-wmr-toolbar";
	node.__gjjWmrButtons = new Map();
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
	const domWidget = node.addDOMWidget(TOOLBAR_WIDGET, "div", toolbar, { serialize: false });
	domWidget.computeSize = (width) => [Math.max(190, Number(width || node.size?.[0] || 240) - 20), 42];
	node.size = [Math.max(230, Number(node.size?.[0] || 230)), Math.max(92, Number(node.computeSize?.()?.[1] || 92))];

	const previousRemoved = node.onRemoved;
	node.onRemoved = function (...args) {
		closePanel(this);
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
			});
			return result;
		};
	},
});
