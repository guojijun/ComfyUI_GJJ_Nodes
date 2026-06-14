import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const NODE_TYPE = "GJJ_RemoveBgStitch";
const PANEL_WIDGET = "gjj_remove_bg_stitch_panel";
const CONFIG_WIDGET = "layer_config";
const MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO";
const HIDDEN_WIDGETS = new Set([
	CONFIG_WIDGET,
	"background_color",
	"background_fit",
	"device",
	"process_res",
	"threshold",
	"mask_blur",
]);
const HIDDEN_INPUTS = new Set([
	CONFIG_WIDGET,
	"background_color",
	"background_fit",
	"device",
	"process_res",
	"threshold",
	"mask_blur",
]);
const SETTINGS_PROPERTY = "gjj_remove_bg_stitch_settings_open";
const PY_WIDGET_ORDER = [
	"width",
	"height",
	CONFIG_WIDGET,
	"background_color",
	"background_fit",
	"device",
	"process_res",
	"threshold",
	"mask_blur",
];
const PARAM_DEFAULTS = {
	width: 1024,
	height: 1024,
	[CONFIG_WIDGET]: "",
	background_color: "#20262D",
	background_fit: "裁切填满",
	device: "自动",
	process_res: 1024,
	threshold: 0,
	mask_blur: 0,
};

function injectStyles() {
	if (document.getElementById("gjj-remove-bg-stitch-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-remove-bg-stitch-style";
	style.textContent = `
.gjj-rbs-root{width:100%;box-sizing:border-box;color:#dce7e2;font:12px/1.35 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none;}
.gjj-rbs-buttons{display:flex;gap:6px;align-items:center;width:100%;box-sizing:border-box;overflow:hidden;white-space:nowrap;padding:2px 0 4px;}
.gjj-rbs-btn{height:27px;min-width:0;flex:1 1 0;border:1px solid #3f525a;border-radius:6px;background:#172229;color:#dce8ec;font:700 12px/25px system-ui,sans-serif;cursor:pointer;padding:0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gjj-rbs-btn:hover{background:#21313a;border-color:#55707a;}
.gjj-rbs-btn.on{background:#24452d;border-color:#6aa56f;color:#eaffed;}
.gjj-rbs-settings{display:none;grid-template-columns:minmax(76px,.42fr) minmax(120px,1fr);gap:6px 8px;padding:5px 0 6px;box-sizing:border-box;width:100%;}
.gjj-rbs-settings.open{display:grid;}
.gjj-rbs-label{height:26px;line-height:26px;color:#aebdc2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gjj-rbs-field{height:26px;width:100%;min-width:0;box-sizing:border-box;border:1px solid #3f4d54;border-radius:5px;background:#10171b;color:#dce8ec;padding:0 8px;font:12px/24px system-ui,sans-serif;outline:none;}
.gjj-rbs-field:disabled{background:#111519;border-color:#323b40;color:#76858c;opacity:.72;}
.gjj-rbs-stage-wrap{width:100%;box-sizing:border-box;padding-top:5px;}
.gjj-rbs-stage{position:relative;width:100%;overflow:hidden;border:1px solid #33454d;border-radius:7px;background:#081015;box-sizing:border-box;touch-action:none;}
.gjj-rbs-stage-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;}
.gjj-rbs-object{position:absolute;display:block;transform:translate(-50%,-50%);transform-origin:center center;cursor:grab;filter:drop-shadow(0 4px 9px rgba(0,0,0,.34));touch-action:none;}
.gjj-rbs-object.selected{outline:2px solid #72d2c6;outline-offset:2px;border-radius:3px;}
.gjj-rbs-layer-list{display:flex;flex-direction:column;gap:5px;padding-top:6px;width:100%;box-sizing:border-box;}
.gjj-rbs-layer{display:grid;grid-template-columns:minmax(58px,.42fr) minmax(96px,1fr) 42px;gap:6px;align-items:center;min-width:0;border:1px solid #2f424a;border-radius:7px;background:#10181d;padding:5px 6px;box-sizing:border-box;}
.gjj-rbs-layer.selected{border-color:#6aaeb0;background:#12242a;}
.gjj-rbs-layer-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c9d8dc;font-weight:700;}
.gjj-rbs-range{width:100%;min-width:0;}
.gjj-rbs-value{text-align:right;color:#9fb1b8;font-size:11px;white-space:nowrap;}
`;
	document.head.appendChild(style);
}

function widget(node, name) {
	return GJJ_Utils.getWidget(node, name);
}

function input(node, name) {
	return node?.inputs?.find((item) => item?.name === name || String(item?.type || "") === `converted-widget:${name}`);
}

function isLinked(slot) {
	return slot?.link != null || (Array.isArray(slot?.links) && slot.links.length > 0);
}

function viewUrl(item) {
	if (!item?.filename) return "";
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	return api.apiURL(`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "temp")}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`);
}

function parsePayload(message) {
	const direct = Array.isArray(message?.gjj_remove_bg_stitch) ? message.gjj_remove_bg_stitch[0] : message?.gjj_remove_bg_stitch;
	if (direct?.canvas) return direct;
	const nested = Array.isArray(message?.ui?.gjj_remove_bg_stitch) ? message.ui.gjj_remove_bg_stitch[0] : message?.ui?.gjj_remove_bg_stitch;
	return nested?.canvas ? nested : null;
}

function defaultLayer(index, count) {
	return {
		id: `layer_${String(index + 1).padStart(2, "0")}`,
		x: count <= 1 ? 0.5 : (index + 1) / (count + 1),
		y: 0.56,
		scale: 1,
		opacity: 1,
		z: index,
	};
}

function parseLayerConfig(node) {
	try {
		const raw = widget(node, CONFIG_WIDGET)?.value || node?.properties?.[CONFIG_WIDGET] || "";
		const parsed = JSON.parse(String(raw || "{}"));
		const layers = Array.isArray(parsed?.layers) ? parsed.layers : [];
		return { version: 1, layers: layers.filter((item) => item && typeof item === "object") };
	} catch (_) {
		return { version: 1, layers: [] };
	}
}

function writeLayerConfig(node, config) {
	const layers = Array.isArray(config?.layers) ? config.layers : [];
	const serialized = JSON.stringify({ version: 1, layers });
	const item = widget(node, CONFIG_WIDGET);
	if (item) item.value = serialized;
	node.properties ||= {};
	node.properties[CONFIG_WIDGET] = serialized;
	node.graph?.change?.();
	node.setDirtyCanvas?.(true, true);
}

function getLayerMap(node, payload) {
	const config = parseLayerConfig(node);
	const map = new Map();
	for (const layer of config.layers) {
		if (!layer?.id) continue;
		map.set(String(layer.id), {
			id: String(layer.id),
			x: finite(layer.x, 0.5),
			y: finite(layer.y, 0.56),
			scale: finite(layer.scale, 1),
			opacity: finite(layer.opacity, 1),
			z: finite(layer.z, map.size),
		});
	}
	const objects = Array.isArray(payload?.objects) ? payload.objects : [];
	for (const [index, object] of objects.entries()) {
		const id = String(object?.id || defaultLayer(index, objects.length).id);
		if (!map.has(id)) {
			map.set(id, {
				id,
				x: finite(object?.x, defaultLayer(index, objects.length).x),
				y: finite(object?.y, defaultLayer(index, objects.length).y),
				scale: finite(object?.scale, 1),
				opacity: finite(object?.opacity, 1),
				z: finite(object?.z, index),
			});
		}
	}
	return map;
}

function currentConfigFromMap(map) {
	return { version: 1, layers: Array.from(map.values()).map((item) => ({
		id: item.id,
		x: clamp(item.x, -1, 2),
		y: clamp(item.y, -1, 2),
		scale: clamp(item.scale, 0.02, 6),
		opacity: clamp(item.opacity, 0, 1),
		z: finite(item.z, 0),
	})) };
}

function finite(value, fallback) {
	const number = Number(value);
	return Number.isFinite(number) ? number : fallback;
}

function clamp(value, lower, upper) {
	return Math.max(lower, Math.min(upper, value));
}

function setWidgetValue(node, name, value) {
	const item = widget(node, name);
	if (item) {
		item.value = value;
		try { item.callback?.(value, app.canvas, node, undefined, item); } catch (_) {}
	}
	node.properties ||= {};
	node.properties[name] = value;
	node.graph?.change?.();
	node.setDirtyCanvas?.(true, true);
}

function controlStyleButton(button, active = false) {
	button.className = `gjj-rbs-btn${active ? " on" : ""}`;
}

function makeButton(label, title) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title || label;
	controlStyleButton(button);
	button.addEventListener("pointerdown", (event) => event.stopPropagation());
	button.addEventListener("mousedown", (event) => event.stopPropagation());
	return button;
}

function makeSettingsField(node, name) {
	const item = widget(node, name);
	const values = item?.options?.values;
	if (Array.isArray(values)) {
		const select = document.createElement("select");
		select.className = "gjj-rbs-field";
		for (const value of values) {
			const option = document.createElement("option");
			option.value = String(value);
			option.textContent = String(value);
			select.appendChild(option);
		}
		const defaultValue = normalizeFieldValue(name, item?.value);
		select.value = String(defaultValue ?? values[0] ?? "");
		if (item && item.value == null) {
			try { setWidgetValue(node, name, defaultValue); } catch (_) {}
		}
		select.addEventListener("change", () => setWidgetValue(node, name, select.value));
		return select;
	}
	const field = document.createElement("input");
	field.className = "gjj-rbs-field";
	field.type = name === "background_color" ? "color" : (typeof item?.value === "number" ? "number" : "text");
	const defaultValue = normalizeFieldValue(name, item?.value);
	field.value = String(defaultValue);
	if (item && item.value == null) {
		try { setWidgetValue(node, name, defaultValue); } catch (_) {}
	}
	if (field.type === "number") {
		const options = item?.options || {};
		if (options.min != null) field.min = String(options.min);
		if (options.max != null) field.max = String(options.max);
		if (options.step != null) field.step = String(options.step);
	}
	field.addEventListener("input", () => {
		const value = field.type === "number" ? Number(field.value) : field.value;
		setWidgetValue(node, name, Number.isNaN(value) ? 0 : value);
	});
	field.addEventListener("change", () => {
		if (name === "width" || name === "height") {
			refreshSize(node);
		}
	});
	return field;
}

function normalizeFieldValue(name, value) {
	if (name === "width" || name === "height") {
		const num = Number(value);
		return Number.isFinite(num) && num >= 16 ? Math.round(num) : 1024;
	}
	if (name === "background_color") {
		const text = String(value || "").trim();
		return /^#[0-9a-fA-F]{6}$/.test(text) ? text : "#20262D";
	}
	if (name === "background_fit") {
		return value ?? "裁切填满";
	}
	if (name === "device") {
		return value ?? "自动";
	}
	if (name === "process_res") {
		const num = Number(value);
		return Number.isFinite(num) ? num : 1024;
	}
	if (name === "threshold") {
		const num = Number(value);
		return Number.isFinite(num) ? num : 0.0;
	}
	if (name === "mask_blur") {
		const num = Number(value);
		return Number.isFinite(num) ? num : 0.0;
	}
	return value ?? "";
}

function settingsOpen(node) {
	const value = node?.properties?.[SETTINGS_PROPERTY];
	return value === true || value === "true" || value === 1 || value === "1";
}

function setSettingsOpen(node, open) {
	node.properties ||= {};
	node.properties[SETTINGS_PROPERTY] = Boolean(open);
	if (node.__gjjRemoveBgUI?.settings) {
		node.__gjjRemoveBgUI.settings.classList.toggle("open", Boolean(open));
	}
	if (node.__gjjRemoveBgUI?.settingsButton) {
		controlStyleButton(node.__gjjRemoveBgUI.settingsButton, Boolean(open));
	}
	refreshSize(node);
}

function makeSettings(node) {
	const panel = document.createElement("div");
	panel.className = `gjj-rbs-settings${settingsOpen(node) ? " open" : ""}`;
	panel.addEventListener("pointerdown", (event) => event.stopPropagation());
	panel.addEventListener("mousedown", (event) => event.stopPropagation());
	const fields = [
		["background_color", "背景颜色"],
		["background_fit", "背景适配"],
		["device", "设备"],
		["process_res", "抠图分辨率"],
		["threshold", "遮罩阈值"],
		["mask_blur", "遮罩羽化"],
	];
	for (const [name, labelText] of fields) {
		const label = document.createElement("div");
		label.className = "gjj-rbs-label";
		label.textContent = labelText;
		const field = makeSettingsField(node, name);
		field.dataset.widgetName = name;
		panel.appendChild(label);
		panel.appendChild(field);
	}
	return panel;
}

function updateSettingsFields(node) {
	const ui = node.__gjjRemoveBgUI;
	if (!ui?.root) return;
	for (const field of ui.root.querySelectorAll("[data-widget-name]")) {
		const name = field.dataset.widgetName;
		const item = widget(node, name);
		if (!item) continue;
		if (document.activeElement !== field) {
			const normalizedValue = normalizeFieldValue(name, item.value);
			field.value = String(normalizedValue);
			if (item.value == null) {
				try { setWidgetValue(node, name, normalizedValue); } catch (_) {}
			}
		}
	}
}

function makePanel(node) {
	const root = document.createElement("div");
	root.className = "gjj-rbs-root";
	root.addEventListener("pointerdown", (event) => event.stopPropagation());
	root.addEventListener("mousedown", (event) => event.stopPropagation());

	const buttons = document.createElement("div");
	buttons.className = "gjj-rbs-buttons";
	const refreshButton = makeButton("🔄 刷新", "重新执行当前节点并更新预览。");
	refreshButton.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		await runCurrentNode(node, refreshButton);
	});
	const resetButton = makeButton("↺ 居中", "重置对象位置和大小。");
	resetButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		resetLayers(node);
	});
	const settingsButton = makeButton("⚙ 设置", "打开参数设置。");
	settingsButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setSettingsOpen(node, !settingsOpen(node));
	});
	buttons.append(refreshButton, resetButton, settingsButton);

	const settings = makeSettings(node);
	root.append(buttons, settings);
	node.__gjjRemoveBgUI = {
		root,
		buttons,
		refreshButton,
		resetButton,
		settingsButton,
		settings,
		stageWrap: null,
		layerList: null,
	};
	controlStyleButton(settingsButton, settingsOpen(node));
	return root;
}

async function runCurrentNode(node, button = null) {
	if (!isLinked(input(node, "foreground"))) return false;
	const oldText = button?.textContent;
	if (button) {
		button.disabled = true;
		button.textContent = "刷新中";
	}
	try {
		return await queueOnlyCurrentNode(node);
	} catch (error) {
		console.warn("[GJJ] 去背景拼接刷新失败：", error);
		return false;
	} finally {
		if (button) {
			button.disabled = false;
			button.textContent = oldText || "🔄 刷新";
		}
	}
}

function resetLayers(node) {
	const payload = node.__gjjRemoveBgPayload;
	const objects = Array.isArray(payload?.objects) ? payload.objects : [];
	const layers = objects.map((_, index) => defaultLayer(index, objects.length));
	writeLayerConfig(node, { version: 1, layers });
	renderPayload(node);
}

function ensurePreviewContainers(node) {
	const ui = node.__gjjRemoveBgUI;
	if (!ui?.root) return null;
	if (!ui.stageWrap) {
		const stageWrap = document.createElement("div");
		stageWrap.className = "gjj-rbs-stage-wrap";
		const stage = document.createElement("div");
		stage.className = "gjj-rbs-stage";
		stageWrap.appendChild(stage);
		const layerList = document.createElement("div");
		layerList.className = "gjj-rbs-layer-list";
		stageWrap.appendChild(layerList);
		ui.root.appendChild(stageWrap);
		ui.stageWrap = stageWrap;
		ui.stage = stage;
		ui.layerList = layerList;
	}
	return ui;
}

function renderPayload(node) {
	const payload = node.__gjjRemoveBgPayload;
	if (!payload?.canvas || !Array.isArray(payload.objects)) return;
	const ui = ensurePreviewContainers(node);
	if (!ui) return;
	const canvasW = Math.max(1, Number(payload.canvas.width || 1));
	const canvasH = Math.max(1, Number(payload.canvas.height || 1));
	ui.stage.style.aspectRatio = `${Math.round(canvasW)} / ${Math.round(canvasH)}`;
	ui.stage.replaceChildren();
	const bg = document.createElement("img");
	bg.className = "gjj-rbs-stage-bg";
	bg.src = viewUrl(payload.background);
	ui.stage.appendChild(bg);

	const layerMap = getLayerMap(node, payload);
	const selected = node.__gjjRemoveBgSelected || payload.objects[0]?.id || "";
	node.__gjjRemoveBgSelected = selected;

	const orderedObjects = [...payload.objects].sort((a, b) => {
		const layerA = layerMap.get(String(a?.id || ""));
		const layerB = layerMap.get(String(b?.id || ""));
		return finite(layerA?.z, 0) - finite(layerB?.z, 0);
	});
	for (const object of orderedObjects) {
		const id = String(object.id || "");
		const layer = layerMap.get(id) || {};
		const image = document.createElement("img");
		image.className = `gjj-rbs-object${id === selected ? " selected" : ""}`;
		image.dataset.layerId = id;
		image.src = viewUrl(object);
		positionObject(image, object, layer, canvasW, canvasH);
		bindObjectDrag(node, image, object, layerMap);
		ui.stage.appendChild(image);
	}
	renderLayerList(node, layerMap);
	refreshSize(node);
}

function positionObject(element, object, layer, canvasW, canvasH) {
	const x = clamp(finite(layer.x, object.x || 0.5), -1, 2);
	const y = clamp(finite(layer.y, object.y || 0.56), -1, 2);
	const scale = clamp(finite(layer.scale, object.scale || 1), 0.02, 6);
	const baseW = Math.max(1, Number(object.base_width || object.display_width || object.width || 1));
	const baseH = Math.max(1, Number(object.base_height || object.display_height || object.height || 1));
	element.style.left = `${x * 100}%`;
	element.style.top = `${y * 100}%`;
	element.style.width = `${(baseW * scale / canvasW) * 100}%`;
	element.style.height = `${(baseH * scale / canvasH) * 100}%`;
	element.style.opacity = String(clamp(finite(layer.opacity, 1), 0, 1));
	element.style.zIndex = String(Math.round(finite(layer.z, 0)));
}

function bindObjectDrag(node, element, object, layerMap) {
	element.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		event.stopPropagation();
		node.__gjjRemoveBgSelected = String(object.id || "");
		promoteLayer(layerMap, node.__gjjRemoveBgSelected);
		writeLayerConfig(node, currentConfigFromMap(layerMap));
		updateObjectElements(node, layerMap);
		renderLayerList(node, layerMap);
		element.setPointerCapture?.(event.pointerId);
		element.style.cursor = "grabbing";
		const move = (moveEvent) => {
			moveEvent.preventDefault();
			moveEvent.stopPropagation();
			const rect = node.__gjjRemoveBgUI?.stage?.getBoundingClientRect();
			if (!rect || !rect.width || !rect.height) return;
			const layer = layerMap.get(String(object.id || ""));
			if (!layer) return;
			layer.x = clamp((moveEvent.clientX - rect.left) / rect.width, -1, 2);
			layer.y = clamp((moveEvent.clientY - rect.top) / rect.height, -1, 2);
			writeLayerConfig(node, currentConfigFromMap(layerMap));
			updateObjectElements(node, layerMap);
		};
		const up = (upEvent) => {
			upEvent.preventDefault();
			upEvent.stopPropagation();
			element.style.cursor = "grab";
			element.releasePointerCapture?.(event.pointerId);
			element.removeEventListener("pointermove", move);
			element.removeEventListener("pointerup", up);
			element.removeEventListener("pointercancel", up);
			renderLayerList(node, layerMap);
		};
		element.addEventListener("pointermove", move);
		element.addEventListener("pointerup", up);
		element.addEventListener("pointercancel", up);
	});
}

function promoteLayer(layerMap, selectedId) {
	const ordered = Array.from(layerMap.values()).sort((a, b) => finite(a.z, 0) - finite(b.z, 0));
	const selected = layerMap.get(String(selectedId || ""));
	if (!selected) return;
	const withoutSelected = ordered.filter((item) => item.id !== selected.id);
	withoutSelected.forEach((item, index) => { item.z = index; });
	selected.z = withoutSelected.length;
}

function updateObjectElements(node, layerMap) {
	const payload = node.__gjjRemoveBgPayload;
	const stage = node.__gjjRemoveBgUI?.stage;
	if (!payload?.canvas || !stage) return;
	const canvasW = Math.max(1, Number(payload.canvas.width || 1));
	const canvasH = Math.max(1, Number(payload.canvas.height || 1));
	for (const element of stage.querySelectorAll(".gjj-rbs-object")) {
		const id = String(element.dataset.layerId || "");
		const object = payload.objects?.find((item) => String(item.id || "") === id);
		const layer = layerMap.get(id);
		if (!object || !layer) continue;
		element.classList.toggle("selected", node.__gjjRemoveBgSelected === id);
		positionObject(element, object, layer, canvasW, canvasH);
	}
}

function renderLayerList(node, layerMap) {
	const ui = node.__gjjRemoveBgUI;
	const payload = node.__gjjRemoveBgPayload;
	if (!ui?.layerList || !payload?.objects) return;
	ui.layerList.replaceChildren();
	const selectedId = String(node.__gjjRemoveBgSelected || payload.objects[0]?.id || "");
	const object = payload.objects.find((item) => String(item?.id || "") === selectedId) || payload.objects[0];
	if (!object) return;
	const id = String(object.id || "");
	const layer = layerMap.get(id);
	if (!layer) return;
	node.__gjjRemoveBgSelected = id;

	const row = document.createElement("div");
	row.className = "gjj-rbs-layer selected";
	row.addEventListener("pointerdown", (event) => event.stopPropagation());
	row.addEventListener("mousedown", (event) => event.stopPropagation());
	const name = document.createElement("div");
	name.className = "gjj-rbs-layer-name";
	name.textContent = object.label || id;
	const range = document.createElement("input");
	range.className = "gjj-rbs-range";
	range.type = "range";
	range.min = "0.05";
	range.max = "3";
	range.step = "0.01";
	range.value = String(clamp(finite(layer.scale, 1), 0.05, 3));
	const value = document.createElement("div");
	value.className = "gjj-rbs-value";
	value.textContent = `${Math.round(Number(range.value) * 100)}%`;
	range.addEventListener("input", (event) => {
		event.preventDefault();
		event.stopPropagation();
		layer.scale = Number(range.value);
		value.textContent = `${Math.round(layer.scale * 100)}%`;
		writeLayerConfig(node, currentConfigFromMap(layerMap));
		updateObjectElements(node, layerMap);
	});
	row.append(name, range, value);
	ui.layerList.appendChild(row);
}

function refreshSize(node) {
	const ui = node.__gjjRemoveBgUI;
	if (!ui?.root) return;
	updateSettingsFields(node);
	const dimensionHeight = ["width", "height"].reduce((total, name) => {
		const item = widget(node, name);
		if (!item || item.hidden) return total;
		try {
			return total + Math.max(24, Math.round(Number(item.getHeight?.() || item.computeSize?.(node.size?.[0])?.[1] || 28)));
		} catch (_) {
			return total + 28;
		}
	}, 0);
	const height = Math.max(66, Math.ceil(ui.root.scrollHeight || ui.root.offsetHeight || 66) + dimensionHeight + 8);
	const width = Math.round(Number(node.size?.[0] || 360));
	node.__gjjRemoveBgHeight = height;
	node.setSize?.([width, height]);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function restoreDimensionWidget(node, name, label) {
	const item = widget(node, name);
	if (!item) return null;
	item.hidden = false;
	item.disabled = false;
	item.type = "number";
	item.label = label;
	item.localized_name = label;
	item.options ||= {};
	delete item.options.hidden;
	delete item.options.display;
	item.options.display_name = label;
	if (item.__gjjUtilsHidden) {
		item.__gjjUtilsHidden = false;
		delete item.computeSize;
		delete item.getHeight;
		delete item.draw;
	}
	item.y = Number.isFinite(Number(item.y)) ? Math.max(0, Number(item.y)) : 0;
	item.last_y = Number.isFinite(Number(item.last_y)) ? Math.max(0, Number(item.last_y)) : 0;
	if (item.element?.style) {
		item.element.style.display = "";
		item.element.style.height = "";
		item.element.style.margin = "";
		item.element.style.padding = "";
	}
	if (item.inputEl?.style) {
		item.inputEl.style.display = "";
		item.inputEl.style.height = "";
		item.inputEl.style.margin = "";
		item.inputEl.style.padding = "";
	}
	return item;
}

function hideNativeWidgets(node) {
	for (const name of HIDDEN_WIDGETS) {
		GJJ_Utils.hideWidget(widget(node, name));
	}
	GJJ_Utils.removeHiddenInputSockets(node, HIDDEN_INPUTS);
	GJJ_Utils.reorderWidgets(node, HIDDEN_WIDGETS);
}

function ensureMediaInput(node, name, label) {
	let slot = input(node, name);
	if (!slot) {
		node.addInput?.(name, MEDIA_TYPE);
		slot = input(node, name);
	}
	if (slot) {
		slot.name = name;
		slot.type = MEDIA_TYPE;
		slot.label = label;
		slot.localized_name = label;
	}
	return slot;
}

function ensureDimensionInput(node, name, label) {
	const nativeWidget = restoreDimensionWidget(node, name, label);
	let slot = input(node, name);
	if (!slot) {
		node.addInput?.(name, "INT");
		slot = input(node, name);
	}
	if (slot) {
		slot.name = name;
		slot.type = "INT";
		slot.label = label;
		slot.localized_name = label;
		slot.widget = { name };
		slot.forceInput = false;
	}
	return { slot, nativeWidget };
}

function normalizeInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	const fg = ensureMediaInput(node, "foreground", "前景");
	const bg = ensureMediaInput(node, "background", "背景");
	const width = ensureDimensionInput(node, "width", "宽度");
	const height = ensureDimensionInput(node, "height", "高度");
	const ordered = [fg, bg, width.slot, height.slot].filter(Boolean);
	const orderedNames = new Set(["foreground", "background", "width", "height"]);
	const rest = node.inputs.filter((slot) => {
		if (ordered.includes(slot)) return false;
		const name = String(slot?.name || "");
		const converted = String(slot?.type || "").replace(/^converted-widget:/, "");
		return !orderedNames.has(name) && !orderedNames.has(converted);
	});
	node.inputs = [...ordered, ...rest];
	node.__gjjRemoveBgInputOrder = inputOrderSignature(node);
	globalThis.GJJApplyTypeColorsToNode?.(node);
}

function inputOrderSignature(node) {
	return (node?.inputs || []).map((slot) => `${slot?.name || ""}:${slot?.type || ""}`).join("|");
}

function inputOrderNeedsFix(node) {
	const names = (node?.inputs || []).map((slot) => String(slot?.name || ""));
	const expected = ["foreground", "background", "width", "height"];
	return expected.some((name, index) => names[index] !== name);
}

function normalizeOutputs(node) {
	if (!Array.isArray(node?.outputs)) return;
	while (node.outputs.length > 2) node.removeOutput?.(node.outputs.length - 1);
	if (!node.outputs[0]) node.addOutput?.("单张合成图像", "IMAGE");
	if (!node.outputs[1]) node.addOutput?.("合成遮罩", "MASK");
	node.outputs[0].name = "单张合成图像";
	node.outputs[0].label = "单张合成图像";
	node.outputs[0].localized_name = "单张合成图像";
	node.outputs[0].type = "IMAGE";
	node.outputs[1].name = "合成遮罩";
	node.outputs[1].label = "合成遮罩";
	node.outputs[1].localized_name = "合成遮罩";
	node.outputs[1].type = "MASK";
}

function validParamValue(name, value) {
	if (name === "width" || name === "height") {
		const number = Number(value);
		return Number.isFinite(number) && number >= 16 ? Math.round(number) : PARAM_DEFAULTS[name];
	}
	if (name === CONFIG_WIDGET) {
		const text = String(value ?? "");
		try {
			if (text) {
				const parsed = JSON.parse(text);
				if (!parsed || (typeof parsed !== "object")) return "";
			}
			return text;
		} catch (_) {
			return "";
		}
	}
	if (name === "background_color") {
		const text = String(value || "");
		return /^#[0-9a-fA-F]{6}$/.test(text) ? text : PARAM_DEFAULTS[name];
	}
	if (name === "background_fit") {
		return ["裁切填满", "等比留边", "拉伸填满"].includes(value) ? value : PARAM_DEFAULTS[name];
	}
	if (name === "device") {
		return ["自动", "GPU", "CPU"].includes(value) ? value : PARAM_DEFAULTS[name];
	}
	if (name === "process_res") {
		const number = Number(value);
		return Number.isFinite(number) && number >= 64 && number <= 4096 ? Math.round(number) : PARAM_DEFAULTS[name];
	}
	if (name === "threshold") {
		const number = Number(value);
		return Number.isFinite(number) && number >= 0 && number <= 1 ? number : PARAM_DEFAULTS[name];
	}
	if (name === "mask_blur") {
		const number = Number(value);
		return Number.isFinite(number) && number >= 0 && number <= 64 ? number : PARAM_DEFAULTS[name];
	}
	return value ?? PARAM_DEFAULTS[name];
}

function canonicalPropertyValues(properties = {}) {
	return PY_WIDGET_ORDER.map((name) => validParamValue(name, properties?.[name]));
}

function prepareSerializedParameters(serializedNode) {
	if (!serializedNode) return;
	serializedNode.properties ||= {};
	const raw = Array.isArray(serializedNode.widgets_values) ? serializedNode.widgets_values : [];
	for (let index = 0; index < PY_WIDGET_ORDER.length; index++) {
		const name = PY_WIDGET_ORDER[index];
		if (serializedNode.properties[name] == null) {
			serializedNode.properties[name] = validParamValue(name, raw[index]);
		} else {
			serializedNode.properties[name] = validParamValue(name, serializedNode.properties[name]);
		}
	}
	serializedNode.widgets_values = canonicalPropertyValues(serializedNode.properties);
}

function restorePropertiesToWidgets(node) {
	node.properties ||= {};
	for (const name of PY_WIDGET_ORDER) {
		const item = widget(node, name);
		const value = validParamValue(name, node.properties[name] ?? item?.value);
		node.properties[name] = value;
		if (item) item.value = value;
	}
}

function putPythonWidgetsFirst(node) {
	if (!Array.isArray(node?.widgets)) return;
	const byName = new Map(node.widgets.map((item) => [String(item?.name || ""), item]));
	const pythonWidgets = PY_WIDGET_ORDER.map((name) => byName.get(name)).filter(Boolean);
	const pythonSet = new Set(pythonWidgets);
	node.widgets = [...pythonWidgets, ...node.widgets.filter((item) => !pythonSet.has(item))];
}

function orderVisibleWidgets(node) {
	if (!Array.isArray(node?.widgets)) return;
	const panel = node.widgets.find((item) => item?.name === PANEL_WIDGET);
	const dimensions = ["width", "height"].map((name) => widget(node, name)).filter(Boolean);
	const visibleSet = new Set([panel, ...dimensions].filter(Boolean));
	const otherVisible = node.widgets.filter((item) => {
		if (visibleSet.has(item)) return false;
		return !HIDDEN_WIDGETS.has(String(item?.name || ""));
	});
	const hidden = node.widgets.filter((item) => HIDDEN_WIDGETS.has(String(item?.name || "")));
	node.widgets = [...otherVisible, ...(panel ? [panel] : []), ...dimensions, ...hidden];
}

function mountPanel(node) {
	injectStyles();
	if (!node.__gjjRemoveBgPanelWidget) {
		const root = makePanel(node);
		const panel = node.addDOMWidget?.(PANEL_WIDGET, "HTML", root, {
			serialize: false,
			hideOnZoom: false,
			getHeight: () => node.__gjjRemoveBgHeight || Math.max(66, root.scrollHeight || root.offsetHeight || 66),
		});
		if (panel) {
			panel.serialize = false;
			panel.options ||= {};
			panel.options.serialize = false;
			panel.value = undefined;
			panel.computeSize = (width) => [Math.round(Number(width || node.size?.[0] || 360)), node.__gjjRemoveBgHeight || Math.max(66, root.scrollHeight || root.offsetHeight || 66)];
		}
		node.__gjjRemoveBgPanelWidget = panel || { element: root };
	} else if (node.__gjjRemoveBgUI?.settingsButton) {
		controlStyleButton(node.__gjjRemoveBgUI.settingsButton, settingsOpen(node));
	}
	refreshSize(node);
}

function stabilize(node) {
	if (!node) return;
	node.properties ||= {};
	restorePropertiesToWidgets(node);
	hideNativeWidgets(node);
	normalizeInputs(node);
	normalizeOutputs(node);
	mountPanel(node);
	orderVisibleWidgets(node);
	updateSettingsFields(node);
	if (node.__gjjRemoveBgPayload) renderPayload(node);
	refreshSize(node);
}

function scheduleAutoRefresh(node) {
	clearTimeout(node.__gjjRemoveBgAutoTimer);
	node.__gjjRemoveBgAutoTimer = setTimeout(() => {
		if (isLinked(input(node, "foreground"))) runCurrentNode(node);
	}, 260);
}

app.registerExtension({
	name: "GJJ.RemoveBgStitch",
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
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			prepareSerializedParameters(serializedNode);
			putPythonWidgetsFirst(this);
			const result = originalConfigure?.apply(this, [serializedNode, ...args]);
			this.properties ||= {};
			Object.assign(this.properties, serializedNode?.properties || {});
			restorePropertiesToWidgets(this);
			stabilize(this);
			setTimeout(() => stabilize(this), 0);
			setTimeout(() => stabilize(this), 80);
			return result;
		};

		const originalSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			const result = originalSerialize?.apply(this, [serializedNode]);
			this.properties ||= {};
			for (const name of PY_WIDGET_ORDER) {
				const item = widget(this, name);
				if (item) this.properties[name] = validParamValue(name, item.value);
			}
			this.properties[CONFIG_WIDGET] = widget(this, CONFIG_WIDGET)?.value || this.properties[CONFIG_WIDGET] || "";
			this.properties[SETTINGS_PROPERTY] = settingsOpen(this);
			if (serializedNode) {
				serializedNode.properties ||= {};
				Object.assign(serializedNode.properties, this.properties);
				serializedNode.widgets_values = canonicalPropertyValues(this.properties);
			}
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			setTimeout(() => {
				stabilize(this);
				updateSettingsFields(this);
			}, 0);
			const slotIndex = Number(args[1]);
			const slot = Array.isArray(this.inputs) ? this.inputs[slotIndex] : null;
			if (slot?.name === "foreground" || slot?.name === "background") {
				scheduleAutoRefresh(this);
			}
			return result;
		};

		const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			const result = originalOnDrawBackground?.apply(this, args);
			const signature = inputOrderSignature(this);
			if (signature !== this.__gjjRemoveBgInputOrder || inputOrderNeedsFix(this)) {
				this.__gjjRemoveBgInputOrder = signature;
				setTimeout(() => stabilize(this), 0);
			}
			return result;
		};

		const originalExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...args) {
			const result = originalExecuted?.apply(this, [message, ...args]);
			const payload = parsePayload(message);
			if (payload) {
				this.__gjjRemoveBgPayload = payload;
				if (payload.layer_config) writeLayerConfig(this, payload.layer_config);
				renderPayload(this);
			}
			setTimeout(() => stabilize(this), 0);
			return result;
		};
	},
	nodeCreated(node) {
		if (node?.comfyClass === NODE_TYPE) setTimeout(() => stabilize(node), 0);
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === NODE_TYPE) stabilize(node);
		}
	},
});
