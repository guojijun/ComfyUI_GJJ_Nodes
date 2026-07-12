import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_RifeVideoInterpolator"]);
const STATUS_WIDGET_NAME = "gjj_rife_vfi_status";
const SCALE_FACTOR_WIDGET = "scale_factor";
const TOOLBAR_WIDGET_NAME = "gjj_rife_vfi_toolbar";
const PANEL_STYLE_ID = "gjj-rife-vfi-panel-style";
const MODEL_WIDGETS = ["model_name"];
const CLASSIC_WIDGETS = ["multiplier", "clear_cache_after_n_frames", "fast_mode", "ensemble", "scale_factor"];
const HDV3_WIDGETS = ["source_fps", "target_fps", "scale_factor", "batch_size", "use_fp16"];
const PARAM_WIDGETS = [...new Set([...MODEL_WIDGETS, ...CLASSIC_WIDGETS, ...HDV3_WIDGETS])];
const FRONTEND_MANAGED_FLAG = "rife_vfi";
const MANAGED_VALUES_PROPERTY = "gjj_rife_vfi_values";
const MEDIA_INPUT = {
	name: "media",
	type: "GJJ_BATCH_IMAGE,IMAGE,VIDEO",
	label: "输入媒体",
	tooltip: "单输入口兼容 GJJ_BATCH_IMAGE、IMAGE、VIDEO。接 VIDEO 时自动读取视频帧并尽量保留音频/源帧率；接普通图片或 GJJ 批量图片时自动整理为插帧帧序列。",
};

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function getWidget(node, name) {
	return node?.widgets?.find((item) => item?.name === name);
}

function selectedModelValue(node) {
	const popupValue = node?.__gjjRifePopups?.model?.controls?.get?.("model_name")?.value;
	const propertyValue = node?.properties?.gjj_rife_vfi_model_name;
	const widgetValue = getWidget(node, "model_name")?.value;
	return String(popupValue || propertyValue || widgetValue || "");
}

function rememberSelectedModel(node, value) {
	if (!node) return;
	node.properties ||= {};
	node.properties.gjj_rife_vfi_model_name = String(value || "");
}

function rememberManagedValue(node, name, value) {
	if (!node || !name) return;
	node.properties ||= {};
	const values = (node.properties[MANAGED_VALUES_PROPERTY] && typeof node.properties[MANAGED_VALUES_PROPERTY] === "object")
		? node.properties[MANAGED_VALUES_PROPERTY]
		: {};
	values[name] = value;
	node.properties[MANAGED_VALUES_PROPERTY] = values;
	if (name === "model_name") rememberSelectedModel(node, value);
}

function managedValue(node, name) {
	const popupValue = node?.__gjjRifePopups?.model?.controls?.get?.(name)?.value
		?? node?.__gjjRifePopups?.classic?.controls?.get?.(name)?.value
		?? node?.__gjjRifePopups?.hdv3?.controls?.get?.(name)?.value;
	const propertyValues = node?.properties?.[MANAGED_VALUES_PROPERTY];
	const propertyValue = propertyValues && typeof propertyValues === "object" ? propertyValues[name] : undefined;
	const widgetValue = getWidget(node, name)?.value;
	return popupValue ?? propertyValue ?? widgetValue;
}

function isHdv3Model(node) {
	const raw = selectedModelValue(node).trim().toLowerCase();
	const normalized = raw.replace(/\\/g, "/");
	const base = normalized.split("/").pop() || normalized;
	return (
		base === "flownet.pkl"
		|| base.startsWith("flownet.pkl")
		|| normalized.includes("flownet.pkl")
		|| normalized.includes("rife_v4.26")
		|| normalized.includes("v4.26")
	);
}

function saveWidgetState(widget) {
	if (!widget || widget.__gjjRifeSavedState) return;
	widget.__gjjRifeSavedState = {
		type: widget.type,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		draw: widget.draw,
		label: widget.label,
		hidden: widget.hidden,
		optionsHidden: widget.options?.hidden,
		optionsDisplay: widget.options?.display,
	};
}

function setWidgetVisible(node, widget, visible) {
	if (!widget) return;
	saveWidgetState(widget);
	widget.__gjjRifeManagedWidget = true;
	if (visible) {
		const saved = widget.__gjjRifeSavedState || {};
		widget.__gjjRifeManagedHidden = false;
		widget.__gjjUtilsHidden = false;
		widget.hidden = false;
		widget.type = saved.type || widget.type;
		if (saved.computeSize) widget.computeSize = saved.computeSize;
		else delete widget.computeSize;
		if (saved.getHeight) widget.getHeight = saved.getHeight;
		else delete widget.getHeight;
		if (saved.draw) widget.draw = saved.draw;
		else delete widget.draw;
		widget.label = saved.label ?? widget.label;
		widget.options ||= {};
		delete widget.options.hidden;
		if (saved.optionsDisplay === undefined || saved.optionsDisplay === "hidden") delete widget.options.display;
		else widget.options.display = saved.optionsDisplay;
		if (widget.element) widget.element.style.display = "";
		if (widget.inputEl) widget.inputEl.style.display = "";
	} else {
		widget.__gjjRifeManagedHidden = true;
		widget.hidden = true;
		widget.computeSize = () => [0, 0];
		widget.getHeight = () => 0;
		widget.draw = () => {};
		widget.label = "";
		widget.y = 0;
		widget.last_y = 0;
		widget.computedHeight = 0;
		widget.margin_top = 0;
		widget.size = [0, 0];
		widget.options ||= {};
		widget.options.hidden = true;
		widget.options.display = "hidden";
		if (widget.element) widget.element.style.display = "none";
		if (widget.inputEl) widget.inputEl.style.display = "none";
	}
	refreshNode(node);
}

function readManagedWidgetNames(nodeData) {
	const names = new Set();
	const required = nodeData?.input?.required || nodeData?.inputs?.required || {};
	for (const [name, spec] of Object.entries(required)) {
		const options = Array.isArray(spec) ? spec[1] : null;
		if (options?.gjj_frontend_managed === FRONTEND_MANAGED_FLAG) {
			names.add(name);
		}
	}
	if (!names.size) {
		for (const name of PARAM_WIDGETS) names.add(name);
	}
	return names;
}

function tagDeclaredManagedWidgets(node, nodeData) {
	const managed = node.__gjjRifeManagedWidgetNames || readManagedWidgetNames(nodeData);
	node.__gjjRifeManagedWidgetNames = managed;
	for (const name of managed) {
		const widget = getWidget(node, name);
		if (!widget) continue;
		widget.__gjjRifeManagedWidget = true;
	}
}

function getLink(node, linkId) {
	const links = node?.graph?.links || app.graph?.links;
	if (linkId == null || !links) return null;
	if (Array.isArray(links)) return links.find((link) => String(Array.isArray(link) ? link[0] : link?.id) === String(linkId)) || null;
	return links[linkId] || links[String(linkId)] || null;
}

function inputLinked(node, input) {
	if (!input) return false;
	const link = Array.isArray(input.link) ? input.link[0] : input.link;
	return link != null && !!getLink(node, link);
}

function setInputSlotOnLink(link, node, slot) {
	if (!link || !node) return;
	if (Array.isArray(link)) {
		link[3] = node.id;
		link[4] = slot;
		if (MEDIA_INPUT.type) link[5] = MEDIA_INPUT.type;
		return;
	}
	link.target_id = node.id;
	link.target_slot = slot;
	link.type = MEDIA_INPUT.type;
}

function repairInputLinks(node) {
	if (!Array.isArray(node?.inputs)) return;
	for (let index = 0; index < node.inputs.length; index++) {
		const input = node.inputs[index];
		const linkId = Array.isArray(input?.link) ? input.link[0] : input?.link;
		const link = getLink(node, linkId);
		if (link) setInputSlotOnLink(link, node, index);
	}
}

function applyMediaInput(input) {
	if (!input) return;
	input.name = MEDIA_INPUT.name;
	input.type = MEDIA_INPUT.type;
	input.label = MEDIA_INPUT.label;
	input.localized_name = MEDIA_INPUT.label;
	input.display_name = MEDIA_INPUT.label;
	input.tooltip = MEDIA_INPUT.tooltip;
}

function stabilizeMediaInput(node) {
	if (!Array.isArray(node?.inputs)) return;
	const isMedia = (input) => {
		const text = [input?.name, input?.label, input?.localized_name, input?.display_name].map((item) => String(item || "")).join(" ");
		return /\bmedia\b|输入媒体|input_video|输入视频|input_frames|输入帧序列/i.test(text);
	};
	const candidates = node.inputs.filter(isMedia);
	let picked = candidates.find((input) => inputLinked(node, input))
		|| node.inputs.find((input) => String(input?.name || "") === MEDIA_INPUT.name)
		|| candidates[0]
		|| null;
	if (!picked) {
		node.addInput?.(MEDIA_INPUT.name, MEDIA_INPUT.type);
		picked = node.inputs[node.inputs.length - 1];
	}
	applyMediaInput(picked);
	for (let index = node.inputs.length - 1; index >= 0; index--) {
		const input = node.inputs[index];
		if (input === picked || !isMedia(input)) continue;
		try { node.removeInput?.(index); } catch (_) { node.inputs.splice(index, 1); }
	}
	const others = node.inputs.filter((input) => input !== picked);
	node.inputs = [picked, ...others];
	repairInputLinks(node);
	refreshNode(node);
}

function ensureStatusWidget(node) {
	if (node.__gjjRifeVfiStatus) {
		return node.__gjjRifeVfiStatus;
	}
	const box = document.createElement("div");
	box.textContent = "等待执行";
	box.style.cssText = [
		"min-height:24px",
		"padding:6px 10px",
		"border:1px solid #41535b",
		"border-radius:10px",
		"background:#121a1f",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.35",
		"white-space:pre-wrap",
		"word-break:break-word",
	].join(";");
	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
		hideOnZoom: false,
		getHeight: () => 42,
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(260, Number(width || node.size?.[0] || 260)), node.__gjjRifeStatusOpen ? 42 : 0];
	}
	node.__gjjRifeVfiStatus = { widget, box };
	box.style.display = "none";
	return node.__gjjRifeVfiStatus;
}

function setStatus(node, text) {
	const box = node?.__gjjRifeVfiStatus?.box;
	const popupStatus = node?.__gjjRifePopups?.statusText;
	const value = String(text || "等待执行");
	if (box) box.textContent = value;
	if (popupStatus) popupStatus.textContent = value;
	refreshNode(node);
}

function normalizeScaleFactorWidget(node) {
	const widget = node?.widgets?.find((item) => item?.name === SCALE_FACTOR_WIDGET);
	if (!widget) return;
	const value = Number.parseFloat(String(widget.value ?? 1).trim());
	widget.value = Number.isFinite(value) ? value : 1.0;
	if (Array.isArray(widget.options?.values)) {
		widget.options.values = [0.25, 0.5, 1.0, 2.0, 4.0];
	}
	if (widget.inputEl) widget.inputEl.value = String(widget.value);
}

function activeParamGroup(node) {
	return String(node?.properties?.gjj_rife_vfi_panel || "");
}

function setActiveParamGroup(node, group) {
	node.properties ||= {};
	node.properties.gjj_rife_vfi_panel = activeParamGroup(node) === group ? "" : group;
	applyPanelState(node);
}

function protect(element) {
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "click", "wheel"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
}

function ensurePanelStyle() {
	if (document.getElementById(PANEL_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = PANEL_STYLE_ID;
	style.textContent = `
		.gjj-rife-popover{position:fixed;z-index:100000;display:none;flex-direction:column;gap:9px;width:min(420px,calc(100vw - 28px));max-height:calc(100vh - 28px);overflow:auto;padding:9px;border:1px solid #45606a;border-radius:8px;background:#10191e;color:#dce7e9;box-shadow:0 12px 32px rgba(0,0,0,.45);font:12px/1.4 system-ui,'Microsoft YaHei',sans-serif;box-sizing:border-box}
		.gjj-rife-popover.open{display:flex}.gjj-rife-pop-head{position:sticky;top:-9px;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:28px;margin:-9px -9px 0;padding:8px 9px 6px;border-bottom:1px solid #263842;background:#10191e}.gjj-rife-pop-title{font-weight:800;color:#d8f5f3}.gjj-rife-close{min-height:24px;padding:0 10px;border:1px solid #24c68b;border-radius:6px;background:#1d3d34;color:#eafff7;cursor:pointer}
		.gjj-rife-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:7px}.gjj-rife-field{display:flex;align-items:center;gap:8px;min-width:0}.gjj-rife-field>span{flex:0 0 104px;color:#aebbc0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gjj-rife-control{flex:1;min-width:0;width:100%;border:1px solid #40515a;border-radius:5px;background:#0e1519;color:#eaf2f3;padding:5px 7px;box-sizing:border-box}
		select.gjj-rife-control{border-color:#3c7f91;background:#122932;color:#f0fbff;font-weight:650;cursor:pointer}.gjj-rife-bool-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.gjj-rife-bool{min-height:28px;min-width:72px;padding:0 9px;border:1px solid #40515a;border-radius:6px;background:#152026;color:#b9c8cc;font-weight:750;cursor:pointer}.gjj-rife-bool.active{border-color:#24c68b;background:#164d3c;color:#eafff7}.gjj-rife-status{min-height:54px;padding:8px 10px;border:1px solid #41535b;border-radius:7px;background:#121a1f;color:#dce7e2;white-space:pre-wrap;word-break:break-word}
	`;
	(document.head || document.body || document.documentElement).appendChild(style);
}

function widgetLabel(widget, fallback) {
	return String(widget?.options?.display_name || widget?.label || fallback || widget?.name || "");
}

function popupWidgetLabel(widget, fallback, group) {
	if (group === "hdv3" && widget?.name === SCALE_FACTOR_WIDGET) return "scale";
	return widgetLabel(widget, fallback);
}

function widgetTooltip(widget) {
	return String(widget?.options?.tooltip || widget?.tooltip || "");
}

function setWidgetValue(node, widget, value) {
	if (!widget) return;
	widget.value = value;
	rememberManagedValue(node, widget.name, value);
	if (widget.inputEl) widget.inputEl.value = String(value);
	try { widget.callback?.call(widget, value, node, widget); } catch (_) {}
	refreshNode(node);
	updatePopupControls(node);
}

function makeControl(node, name) {
	const widget = getWidget(node, name);
	if (!widget) return null;
	const type = String(widget.type || widget.options?.type || "").toLowerCase();
	const values = Array.isArray(widget.options?.values) ? widget.options.values : null;
	if (values?.length) {
		const select = document.createElement("select");
		select.className = "gjj-rife-control";
		for (const value of values) {
			const option = document.createElement("option");
			option.value = String(value);
			option.textContent = String(value);
			select.appendChild(option);
		}
		select.value = String(widget.value ?? values[0]);
		select.title = widgetTooltip(widget);
		select.addEventListener("change", () => setWidgetValue(node, widget, select.value));
		protect(select);
		return select;
	}
	if (type.includes("boolean") || typeof widget.value === "boolean") {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "gjj-rife-bool";
		button.dataset.booleanControl = "true";
		button.dataset.widgetName = name;
		button.title = widgetTooltip(widget);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setWidgetValue(node, widget, !Boolean(widget.value));
		});
		protect(button);
		return button;
	}
	const input = document.createElement("input");
	input.className = "gjj-rife-control";
	input.dataset.widgetName = name;
	input.title = widgetTooltip(widget);
	if (type.includes("int") || type.includes("float") || typeof widget.value === "number") {
		input.type = "number";
		if (widget.options?.min != null) input.min = String(widget.options.min);
		if (widget.options?.max != null) input.max = String(widget.options.max);
		if (widget.options?.step != null) input.step = String(widget.options.step);
		input.value = String(widget.value ?? 0);
		input.addEventListener("change", () => {
			const number = type.includes("int") ? Number.parseInt(input.value, 10) : Number.parseFloat(input.value);
			setWidgetValue(node, widget, Number.isFinite(number) ? number : widget.value);
		});
	} else {
		input.type = "text";
		input.value = String(widget.value ?? "");
		input.addEventListener("change", () => setWidgetValue(node, widget, input.value));
	}
	protect(input);
	return input;
}

function buildParamPopup(node, group, title, names) {
	const popup = document.createElement("div");
	popup.className = "gjj-rife-popover";
	popup.dataset.group = group;
	protect(popup);
	const header = document.createElement("div");
	header.className = "gjj-rife-pop-head";
	const caption = document.createElement("div");
	caption.className = "gjj-rife-pop-title";
	caption.textContent = title;
	const close = document.createElement("button");
	close.type = "button";
	close.className = "gjj-rife-close";
	close.textContent = "确定";
	close.title = `关闭${title}`;
	close.addEventListener("click", () => setActiveParamGroup(node, ""));
	header.append(caption, close);
	const grid = document.createElement("div");
	grid.className = "gjj-rife-grid";
	let booleanRow = null;
	const controls = new Map();
	for (const name of names) {
		const widget = getWidget(node, name);
		const control = makeControl(node, name);
		if (!widget || !control) continue;
		controls.set(name, control);
		if (control.dataset?.booleanControl === "true") {
			control.dataset.label = popupWidgetLabel(widget, name, group);
			if (!booleanRow) {
				booleanRow = document.createElement("div");
				booleanRow.className = "gjj-rife-bool-row";
				grid.appendChild(booleanRow);
			}
			booleanRow.appendChild(control);
			continue;
		}
		const row = document.createElement("label");
		row.className = "gjj-rife-field";
		const label = document.createElement("span");
		label.textContent = popupWidgetLabel(widget, name, group);
		row.append(label, control);
		grid.appendChild(row);
	}
	popup.append(header, grid);
	document.body.appendChild(popup);
	return { popup, controls };
}

function buildStatusPopup(node) {
	const popup = document.createElement("div");
	popup.className = "gjj-rife-popover";
	popup.dataset.group = "status";
	protect(popup);
	const header = document.createElement("div");
	header.className = "gjj-rife-pop-head";
	const caption = document.createElement("div");
	caption.className = "gjj-rife-pop-title";
	caption.textContent = "执行状态";
	const close = document.createElement("button");
	close.type = "button";
	close.className = "gjj-rife-close";
	close.textContent = "确定";
	close.title = "关闭执行状态";
	close.addEventListener("click", () => setActiveParamGroup(node, ""));
	header.append(caption, close);
	const statusText = document.createElement("div");
	statusText.className = "gjj-rife-status";
	statusText.textContent = node?.__gjjRifeVfiStatus?.box?.textContent || "等待执行";
	popup.append(header, statusText);
	document.body.appendChild(popup);
	return { popup, statusText };
}

function ensurePopups(node) {
	if (node.__gjjRifePopups) return node.__gjjRifePopups;
	ensurePanelStyle();
	node.__gjjRifePopups = {
		model: buildParamPopup(node, "model", "模型", MODEL_WIDGETS),
		classic: buildParamPopup(node, "classic", "倍率参数", CLASSIC_WIDGETS),
		hdv3: buildParamPopup(node, "hdv3", "RIFEInterpolation 参数", HDV3_WIDGETS),
	};
	const status = buildStatusPopup(node);
	node.__gjjRifePopups.status = status;
	node.__gjjRifePopups.statusText = status.statusText;
	return node.__gjjRifePopups;
}

function positionPopup(popup, anchor) {
	if (!popup || !anchor) return;
	const rect = anchor.getBoundingClientRect?.();
	const viewportWidth = Math.max(320, window.innerWidth || 720);
	const viewportHeight = Math.max(240, window.innerHeight || 540);
	const popupWidth = Math.min(420, Math.max(320, viewportWidth - 28));
	const left = Math.min(viewportWidth - popupWidth - 14, Math.max(14, rect?.left || 80));
	const top = Math.min(viewportHeight - 120, Math.max(14, (rect?.bottom || 80) + 6));
	popup.style.width = `${Math.round(popupWidth)}px`;
	popup.style.maxHeight = `${Math.round(Math.max(180, viewportHeight - top - 20))}px`;
	popup.style.left = `${Math.round(left)}px`;
	popup.style.top = `${Math.round(top)}px`;
}

function updatePopupControls(node) {
	const popups = node?.__gjjRifePopups;
	if (!popups) return;
	for (const state of [popups.model, popups.classic, popups.hdv3]) {
		for (const [name, control] of state?.controls || []) {
			const widget = getWidget(node, name);
			if (!widget || !control) continue;
			if (control.dataset?.booleanControl === "true") {
				control.classList.toggle("active", Boolean(widget.value));
				control.textContent = `${control.dataset.label || widgetLabel(widget, name)}：${widget.value ? "开" : "关"}`;
			} else if (control.tagName === "SELECT") {
				control.value = String(widget.value ?? "");
			} else {
				control.value = String(widget.value ?? "");
			}
		}
	}
}

function cleanupPopups(node) {
	const popups = node?.__gjjRifePopups;
	if (!popups) return;
	for (const state of [popups.model, popups.classic, popups.hdv3, popups.status]) {
		try { state?.popup?.remove?.(); } catch (_) {}
	}
	node.__gjjRifePopups = null;
}

function promptOutput(promptResult) {
	return promptResult?.output || promptResult?.prompt?.output || promptResult?.prompt || promptResult;
}

function findPromptNodeInfo(promptResult, node) {
	const output = promptOutput(promptResult);
	if (!output || !node) return null;
	return output[String(node.id)] || output[node.id] || null;
}

function coercePromptValue(node, name, value) {
	const widget = getWidget(node, name);
	const type = String(widget?.type || widget?.options?.type || "").toLowerCase();
	if (type.includes("boolean") || typeof widget?.value === "boolean") return Boolean(value);
	if (type.includes("int")) {
		const number = Number.parseInt(String(value), 10);
		return Number.isFinite(number) ? number : widget?.value;
	}
	if (type.includes("float") || typeof widget?.value === "number") {
		const number = Number.parseFloat(String(value));
		return Number.isFinite(number) ? number : widget?.value;
	}
	return value;
}

function patchRifePromptInputs(promptResult, graph = app.graph) {
	const nodes = graph?._nodes || [];
	for (const node of nodes) {
		if (!TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) continue;
		const nodeInfo = findPromptNodeInfo(promptResult, node);
		if (!nodeInfo) continue;
		nodeInfo.inputs ||= {};
		for (const name of PARAM_WIDGETS) {
			const value = managedValue(node, name);
			if (value !== undefined) {
				nodeInfo.inputs[name] = coercePromptValue(node, name, value);
			}
		}
	}
	return promptResult;
}

function installPromptPatch() {
	if (!api.__gjjRifePromptPatchInstalled && typeof api.queuePrompt === "function") {
		api.__gjjRifePromptPatchInstalled = true;
		const originalQueuePrompt = api.queuePrompt.bind(api);
		api.queuePrompt = async function (number, promptData, ...args) {
			patchRifePromptInputs(promptData, app.rootGraph || app.graph);
			return originalQueuePrompt(number, promptData, ...args);
		};
	}
	if (!app.__gjjRifeGraphPromptPatchInstalled && typeof app.graphToPrompt === "function") {
		app.__gjjRifeGraphPromptPatchInstalled = true;
		const originalGraphToPrompt = app.graphToPrompt.bind(app);
		app.graphToPrompt = async function (...args) {
			const result = await originalGraphToPrompt(...args);
			return patchRifePromptInputs(result, app.rootGraph || app.graph);
		};
	}
}

function button(label, title, onClick) {
	const item = document.createElement("button");
	item.type = "button";
	item.textContent = label;
	item.title = title;
	item.style.cssText = [
		"height:28px",
		"min-width:34px",
		"padding:0 8px",
		"border:1px solid #3b5560",
		"border-radius:7px",
		"background:#18252b",
		"color:#edf6fa",
		"font-size:15px",
		"line-height:1",
		"cursor:pointer",
		"user-select:none",
	].join(";");
	item.addEventListener("pointerdown", (event) => event.stopPropagation());
	item.addEventListener("mousedown", (event) => event.stopPropagation());
	item.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.();
	});
	return item;
}

function ensureToolbar(node) {
	if (node.__gjjRifeToolbar || typeof node.addDOMWidget !== "function") return node.__gjjRifeToolbar;
	const row = document.createElement("div");
	row.style.cssText = [
		"display:flex",
		"align-items:center",
		"gap:6px",
		"padding:4px 0",
		"box-sizing:border-box",
		"width:100%",
	].join(";");
	const buttons = {
		model: button("🎞️", "模型", () => setActiveParamGroup(node, "model")),
		classic: button("⚙️", "参数", () => setActiveParamGroup(node, "classic")),
		status: button("📊", "执行状态", () => setActiveParamGroup(node, "status")),
	};
	row.append(buttons.model, buttons.classic, buttons.status);
	const widget = node.addDOMWidget(TOOLBAR_WIDGET_NAME, "HTML", row, { serialize: false, hideOnZoom: false });
	widget.computeSize = (width) => [Math.max(260, Number(width || node.size?.[0] || 260)), 36];
	node.__gjjRifeToolbar = { row, buttons, widget };
	return node.__gjjRifeToolbar;
}

function setButtonActive(button, active, disabled = false) {
	if (!button) return;
	button.disabled = disabled;
	button.style.opacity = disabled ? "0.42" : "1";
	button.style.background = active ? "#1f6b43" : "#18252b";
	button.style.borderColor = active ? "#48ad73" : "#3b5560";
}

function applyPanelState(node) {
	let group = activeParamGroup(node);
	const hdv3 = isHdv3Model(node);
	if (group === "hdv3") {
		group = "classic";
		node.properties ||= {};
		node.properties.gjj_rife_vfi_panel = "classic";
	}
	if (group && !["model", "classic", "status"].includes(group)) {
		group = "";
		node.properties ||= {};
		node.properties.gjj_rife_vfi_panel = "";
	}
	const popupGroup = group === "classic" && hdv3 ? "hdv3" : group;
	for (const name of PARAM_WIDGETS) {
		setWidgetVisible(node, getWidget(node, name), false);
	}
	const toolbar = ensureToolbar(node);
	if (toolbar?.buttons?.classic) {
		toolbar.buttons.classic.title = hdv3 ? "RIFEInterpolation：源帧率 / 目标帧率" : "倍数参数";
	}
	setButtonActive(toolbar?.buttons?.model, group === "model");
	setButtonActive(toolbar?.buttons?.classic, group === "classic");
	setButtonActive(toolbar?.buttons?.status, group === "status");
	const status = ensureStatusWidget(node);
	node.__gjjRifeStatusOpen = false;
	if (status?.box) status.box.style.display = "none";
	const popups = ensurePopups(node);
	for (const [name, state] of Object.entries(popups)) {
		const popup = state?.popup;
		if (!popup) continue;
		popup.classList.toggle("open", name === popupGroup);
	}
	if (popupGroup && popups[popupGroup]?.popup) {
		const anchor = toolbar?.buttons?.[group];
		positionPopup(popups[popupGroup].popup, anchor);
	}
	updatePopupControls(node);
	refreshNode(node);
}

function patchModelWidget(node) {
	const widget = getWidget(node, "model_name");
	if (!widget || widget.__gjjRifeModelPatched) return;
	widget.__gjjRifeModelPatched = true;
	const originalCallback = widget.callback;
	widget.callback = function (...args) {
		const result = originalCallback?.apply(this, args);
		applyPanelState(node);
		return result;
	};
}

function patchNode(node, nodeData = null) {
	if (!node) {
		return;
	}
	if (!node.__gjjRifeVfiPatched) {
		node.__gjjRifeVfiPatched = true;
		ensureToolbar(node);
		ensureStatusWidget(node);
		setStatus(node, "等待执行");
	}
	tagDeclaredManagedWidgets(node, nodeData);
	for (const name of PARAM_WIDGETS) {
		const value = managedValue(node, name);
		if (value !== undefined) rememberManagedValue(node, name, value);
	}
	stabilizeMediaInput(node);
	normalizeScaleFactorWidget(node);
	patchModelWidget(node);
	applyPanelState(node);
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	ensureStatusWidget(targetNode);
	setStatus(targetNode, detail.text || "处理中...");
});

app.registerExtension({
	name: "GJJ.RifeVideoInterpolator",
	beforeRegisterNodeDef(nodeType, nodeData) {
		installPromptPatch();
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}
		const originalComputeSize = nodeType.prototype.computeSize;
		nodeType.prototype.computeSize = function (...args) {
			if (!Array.isArray(this.widgets) || !this.widgets.some((widget) => widget?.__gjjRifeManagedHidden)) {
				return originalComputeSize?.apply(this, args);
			}
			const widgets = this.widgets;
			this.widgets = widgets.filter((widget) => !widget?.__gjjRifeManagedHidden);
			try {
				return originalComputeSize?.apply(this, args);
			} finally {
				this.widgets = widgets;
			}
		};

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this, nodeData);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			patchNode(this, nodeData);
			normalizeScaleFactorWidget(this);
			setTimeout(() => stabilizeMediaInput(this), 0);
			return result;
		};

		const originalOnRemoved = nodeType.prototype.onRemoved;
		nodeType.prototype.onRemoved = function (...args) {
			cleanupPopups(this);
			return originalOnRemoved?.apply(this, args);
		};
	},
});
