import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET = "GJJ_UltimateArchitectureUpscaler";
const GROUPS = [
	{ icon: "📝", title: "提示词设置", fields: ["detail_preset", "positive", "negative"] },
	{ icon: "🔍", title: "基础放大设置", fields: ["enable_upscale_model", "upscale_model_name", "size_mode", "upscale_by", "target_width", "target_height"] },
	{ icon: "🎛️", title: "采样重绘设置", fields: ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise", "mode_type"] },
	{ icon: "🧩", title: "分块处理设置", fields: ["tile_width", "tile_height", "mask_blur", "tile_padding", "force_uniform_tiles", "tiled_decode", "tile_batch_size"] },
	{ icon: "🩹", title: "接缝修复设置", fields: ["seam_fix_mode", "seam_fix_denoise", "seam_fix_width", "seam_fix_mask_blur", "seam_fix_padding"] },
];
const ALL_FIELDS = new Set(GROUPS.flatMap((group) => group.fields));

function widget(node, name) {
	return GJJ_Utils.getWidget?.(node, name) || node?.widgets?.find((item) => item?.name === name);
}

function hideBackendWidget(item) {
	if (!item) return;
	item.__gjjUtilsHidden = true;
	item.hidden = true;
	item.disabled = true;
	item.type = `converted-widget:${item.name || "hidden"}`;
	item.options ||= {};
	item.options.hidden = true;
	item.options.display = "hidden";
	item.computeSize = () => [0, 0];
	item.getHeight = () => 0;
	item.computeLayoutSize = () => ({ minHeight: 0, minWidth: 0 });
	item.draw = () => {};
	item.drawWidget = () => {};
	item.mouse = () => false;
	item.label = "";
	item.localized_name = "";
	item.last_y = 0;
	item.computedHeight = 0;
	item.margin_top = 0;
	item.size = [0, 0];
	for (const element of [item.widget, item.element, item.inputEl]) {
		if (!element?.style) continue;
		element.style.display = "none";
		element.style.height = "0";
		element.style.margin = "0";
		element.style.padding = "0";
	}
}

function setValue(node, item, value) {
	if (!item) return;
	let next = value;
	if (typeof item.value === "number") next = Number(value);
	if (typeof item.value === "boolean") next = Boolean(value);
	item.value = next;
	const index = node.widgets?.indexOf(item) ?? -1;
	if (Array.isArray(node.widgets_values) && index >= 0) node.widgets_values[index] = next;
	try { item.callback?.(next); } catch (_) {}
	node.graph && (node.graph._version += 1);
	app.graph?.setDirtyCanvas?.(true, true);
}

function choices(item) {
	const values = item?.options?.values || item?.options?.comboValues || item?.values || [];
	return Array.isArray(values) ? values : [];
}

function makeInput(node, item) {
	const values = choices(item);
	let control;
	if (typeof item.value === "boolean") {
		control = document.createElement("input");
		control.type = "checkbox";
		control.checked = Boolean(item.value);
		control.addEventListener("change", () => setValue(node, item, control.checked));
		control.style.cssText = "width:18px;height:18px;accent-color:#5ea98a;cursor:pointer";
		return control;
	}
	if (values.length) {
		control = document.createElement("select");
		for (const value of values) {
			const option = document.createElement("option");
			option.value = String(value);
			option.textContent = String(value);
			control.appendChild(option);
		}
		control.value = String(item.value ?? values[0] ?? "");
	} else if (typeof item.value === "number") {
		control = document.createElement("input");
		control.type = "number";
		control.value = String(item.value ?? 0);
		if (Number.isFinite(item.options?.min)) control.min = String(item.options.min);
		if (Number.isFinite(item.options?.max)) control.max = String(item.options.max);
		if (Number.isFinite(item.options?.step)) control.step = String(item.options.step);
	} else {
		control = document.createElement(item.options?.multiline ? "textarea" : "input");
		if (control.tagName === "TEXTAREA") control.rows = 4;
		else control.type = "text";
		control.value = String(item.value ?? "");
	}
	control.style.cssText = "box-sizing:border-box;width:100%;min-height:32px;border:1px solid #42545e;border-radius:6px;background:#202b31;color:#f2f7f8;padding:6px 8px;outline:none;resize:vertical";
	control.addEventListener("input", () => setValue(node, item, control.value));
	control.addEventListener("change", () => setValue(node, item, control.value));
	return control;
}

function closePanel(node) {
	node?.__gjjArchitectureFloatingPanel?.remove?.();
	delete node.__gjjArchitectureFloatingPanel;
	delete node.__gjjArchitectureOpenGroup;
	for (const button of node?.__gjjArchitectureButtons || []) button.classList.remove("active");
}

function positionBelow(panel, anchor) {
	const anchorRect = anchor?.getBoundingClientRect?.();
	if (!anchorRect) return;
	const padding = 10;
	const top = anchorRect.bottom + 6;
	const width = panel.getBoundingClientRect?.().width || panel.offsetWidth || 440;
	const left = Math.max(padding, Math.min(anchorRect.left, window.innerWidth - width - padding));
	panel.style.left = `${Math.round(left)}px`;
	panel.style.top = `${Math.round(top)}px`;
	panel.style.maxHeight = `${Math.max(120, window.innerHeight - top - padding)}px`;
}

function openGroup(node, group, anchor) {
	if (node.__gjjArchitectureOpenGroup === group.title) {
		closePanel(node);
		return;
	}
	closePanel(node);
	const panel = document.createElement("div");
	panel.style.cssText = "position:fixed;z-index:100003;width:min(460px,calc(100vw - 20px));overflow:auto;box-sizing:border-box;border:1px solid #52636d;border-radius:10px;background:#111a1f;color:#e8f0f2;box-shadow:0 16px 48px rgba(0,0,0,.62);padding:12px;font:12px system-ui,'Microsoft YaHei',sans-serif";
	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px";
	const title = document.createElement("strong");
	title.textContent = `${group.icon} ${group.title}`;
	title.style.fontSize = "14px";
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "×";
	close.title = "关闭";
	close.style.cssText = "width:27px;height:25px;border:1px solid #52636d;border-radius:6px;background:#25323a;color:#fff;cursor:pointer";
	close.onclick = () => closePanel(node);
	header.append(title, close);
	panel.appendChild(header);

	for (const name of group.fields) {
		const item = widget(node, name);
		if (!item) continue;
		const row = document.createElement("label");
		row.style.cssText = "display:grid;grid-template-columns:130px minmax(0,1fr);gap:10px;align-items:center;margin:8px 0";
		const label = document.createElement("span");
		label.textContent = String(item.options?.display_name || item.name || name);
		label.title = String(item.options?.tooltip || item.tooltip || "");
		label.style.cssText = "color:#c8d4d8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
		const control = makeInput(node, item);
		control.title = label.title;
		row.append(label, control);
		panel.appendChild(row);
	}
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel", "keydown"]) {
		panel.addEventListener(eventName, (event) => event.stopPropagation());
	}
	document.body.appendChild(panel);
	positionBelow(panel, anchor);
	node.__gjjArchitectureFloatingPanel = panel;
	node.__gjjArchitectureOpenGroup = group.title;
	anchor.classList.add("active");
}

function makeButton(node, group) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = group.icon;
	button.title = group.title;
	button.style.cssText = "width:32px;min-width:32px;max-width:32px;height:28px;flex:0 0 32px;padding:0;border:1px solid #465862;border-radius:6px;background:#202a30;color:#e8f0f2;font-size:14px;cursor:pointer";
	button.addEventListener("click", () => openGroup(node, group, button));
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
		button.addEventListener(eventName, (event) => event.stopPropagation());
	}
	return button;
}

function stabilize(node) {
	for (const name of ALL_FIELDS) hideBackendWidget(widget(node, name));
	GJJ_Utils.removeHiddenInputSockets?.(node, ALL_FIELDS);
	if (!node.__gjjArchitectureToolbar && typeof node.addDOMWidget === "function") {
		const toolbar = document.createElement("div");
		toolbar.style.cssText = "box-sizing:border-box;width:100%;height:32px;display:flex;align-items:center;justify-content:flex-end;gap:5px;padding:0 2px";
		const buttons = GROUPS.map((group) => makeButton(node, group));
		toolbar.append(...buttons);
		const domWidget = node.addDOMWidget("gjj_建筑放大工具栏", "工具栏", toolbar, { serialize: false, hideOnZoom: false });
		domWidget.serialize = false;
		domWidget.computeSize = (width) => [Math.max(230, Number(width || node.size?.[0] || 280)), 32];
		node.__gjjArchitectureToolbar = domWidget;
		node.__gjjArchitectureButtons = buttons;
	}
	GJJ_Utils.refreshNode?.(node, { minWidth: 280, minHeight: 110 });
	app.graph?.setDirtyCanvas?.(true, true);
}

function schedule(node) {
	for (const delay of [0, 40, 120, 300]) setTimeout(() => stabilize(node), delay);
}

app.registerExtension({
	name: "GJJ.建筑终极放大浮动参数",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET) return;
		const created = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const result = created?.apply(this, arguments);
			schedule(this);
			return result;
		};
		const configured = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function () {
			const result = configured?.apply(this, arguments);
			schedule(this);
			return result;
		};
		const removed = nodeType.prototype.onRemoved;
		nodeType.prototype.onRemoved = function () {
			closePanel(this);
			return removed?.apply(this, arguments);
		};
	},
});

