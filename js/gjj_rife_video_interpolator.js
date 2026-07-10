import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_RifeVideoInterpolator"]);
const STATUS_WIDGET_NAME = "gjj_rife_vfi_status";
const SCALE_FACTOR_WIDGET = "scale_factor";
const TOOLBAR_WIDGET_NAME = "gjj_rife_vfi_toolbar";
const MODEL_WIDGETS = ["model_name"];
const CLASSIC_WIDGETS = ["multiplier", "clear_cache_after_n_frames", "fast_mode", "ensemble", "scale_factor"];
const HDV3_WIDGETS = ["source_fps", "target_fps", "batch_size", "use_fp16", "scale_factor"];
const PARAM_WIDGETS = [...new Set([...MODEL_WIDGETS, ...CLASSIC_WIDGETS, ...HDV3_WIDGETS])];
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

function isHdv3Model(node) {
	const value = String(getWidget(node, "model_name")?.value || "").toLowerCase();
	return value.endsWith("flownet.pkl") || value.includes("v4.26");
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
	};
}

function setWidgetVisible(node, widget, visible) {
	if (!widget) return;
	saveWidgetState(widget);
	if (visible) {
		const saved = widget.__gjjRifeSavedState || {};
		widget.hidden = saved.hidden ?? false;
		widget.type = saved.type || widget.type;
		if (saved.computeSize) widget.computeSize = saved.computeSize;
		else delete widget.computeSize;
		if (saved.getHeight) widget.getHeight = saved.getHeight;
		else delete widget.getHeight;
		if (saved.draw) widget.draw = saved.draw;
		else delete widget.draw;
		widget.label = saved.label ?? widget.label;
		if (widget.element) widget.element.style.display = "";
		if (widget.inputEl) widget.inputEl.style.display = "";
	} else {
		widget.hidden = true;
		widget.type = `converted-widget:${widget.name || "hidden"}`;
		widget.computeSize = () => [0, 0];
		widget.getHeight = () => 0;
		widget.draw = () => {};
		widget.label = "";
		widget.last_y = 0;
		widget.computedHeight = 0;
		widget.margin_top = 0;
		widget.size = [0, 0];
		if (widget.element) widget.element.style.display = "none";
		if (widget.inputEl) widget.inputEl.style.display = "none";
	}
	refreshNode(node);
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
	if (!box) {
		return;
	}
	box.textContent = String(text || "等待执行");
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
		classic: button("⚙️", "倍率参数", () => setActiveParamGroup(node, "classic")),
		hdv3: button("🧪", "RIFEInterpolation 参数", () => setActiveParamGroup(node, "hdv3")),
		status: button("📊", "执行状态", () => setActiveParamGroup(node, "status")),
	};
	row.append(buttons.model, buttons.classic, buttons.hdv3, buttons.status);
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
	const group = activeParamGroup(node);
	const hdv3 = isHdv3Model(node);
	for (const name of PARAM_WIDGETS) {
		let visible = false;
		if (group === "model") visible = MODEL_WIDGETS.includes(name);
		else if (group === "classic") visible = !hdv3 && CLASSIC_WIDGETS.includes(name);
		else if (group === "hdv3") visible = hdv3 && HDV3_WIDGETS.includes(name);
		setWidgetVisible(node, getWidget(node, name), visible);
	}
	const toolbar = ensureToolbar(node);
	setButtonActive(toolbar?.buttons?.model, group === "model");
	setButtonActive(toolbar?.buttons?.classic, group === "classic" && !hdv3, hdv3);
	setButtonActive(toolbar?.buttons?.hdv3, group === "hdv3" && hdv3, !hdv3);
	setButtonActive(toolbar?.buttons?.status, group === "status");
	const status = ensureStatusWidget(node);
	node.__gjjRifeStatusOpen = group === "status";
	if (status?.box) status.box.style.display = node.__gjjRifeStatusOpen ? "block" : "none";
	refreshNode(node);
}

function patchModelWidget(node) {
	const widget = getWidget(node, "model_name");
	if (!widget || widget.__gjjRifeModelPatched) return;
	widget.__gjjRifeModelPatched = true;
	const originalCallback = widget.callback;
	widget.callback = function (...args) {
		const result = originalCallback?.apply(this, args);
		if (isHdv3Model(node) && activeParamGroup(node) === "classic") {
			node.properties.gjj_rife_vfi_panel = "hdv3";
		}
		if (!isHdv3Model(node) && activeParamGroup(node) === "hdv3") {
			node.properties.gjj_rife_vfi_panel = "classic";
		}
		applyPanelState(node);
		return result;
	};
}

function patchNode(node) {
	if (!node) {
		return;
	}
	if (!node.__gjjRifeVfiPatched) {
		node.__gjjRifeVfiPatched = true;
		ensureToolbar(node);
		ensureStatusWidget(node);
		setStatus(node, "等待执行");
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
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			patchNode(this);
			normalizeScaleFactorWidget(this);
			setTimeout(() => stabilizeMediaInput(this), 0);
			return result;
		};
	},
});
