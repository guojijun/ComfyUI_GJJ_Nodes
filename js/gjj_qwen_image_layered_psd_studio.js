import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const TARGET = "GJJ_QwenImageLayeredPSDStudio";
const PANEL = "__gjj_qwen_layered_panel";
const STATUS_PANEL = "__gjj_qwen_layered_status_panel";
const VALUES_PROPERTY = "gjj_qwen_layered_values";
const IMAGE_LINK_MEMORY_PROPERTY = "gjj_qwen_layered_image_link_memory";
const DEFAULT_ACCEL_LORA = "QWEN\\lighting\\Qwen-Image-Lightning-4steps-V2.0.safetensors";
const BACKEND_WIDGETS = [
	"method",
	"prompt",
	"negative_prompt",
	"size_mode",
	"largest_size",
	"layers",
	"unet_name",
	"clip_name",
	"vae_name",
	"seed",
	"steps",
	"cfg",
	"sampler_name",
	"scheduler",
	"denoise",
	"keep_model_loaded",
	"lora_data",
	"uploaded_image",
	"accel_lora_name",
	"panel_width",
	"panel_height",
];
const LEGACY_BACKEND_WIDGETS = BACKEND_WIDGETS.filter((name) => name !== "size_mode");
const NO_ACCEL_BACKEND_WIDGETS = BACKEND_WIDGETS.filter((name) => name !== "accel_lora_name");
const OLDER_BACKEND_WIDGETS = LEGACY_BACKEND_WIDGETS.filter((name) => name !== "accel_lora_name");
const NO_PANEL_SIZE_BACKEND_WIDGETS = BACKEND_WIDGETS.filter((name) => name !== "panel_width" && name !== "panel_height");
const DEFAULT_VALUES = {
	method: "图生图",
	prompt: "一个人在森林里",
	negative_prompt: "",
	size_mode: "原图尺寸",
	largest_size: 640,
	layers: 6,
	unet_name: "qwen_image_layered_int8_convrot.safetensors",
	clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
	vae_name: "qwen_image_layered_vae.safetensors",
	seed: 0,
	steps: 4,
	cfg: 1,
	sampler_name: "euler",
	scheduler: "simple",
	denoise: 1,
	keep_model_loaded: false,
	lora_data: "[]",
	uploaded_image: "",
	accel_lora_name: DEFAULT_ACCEL_LORA,
	panel_width: 640,
	panel_height: 640,
};
const HIDDEN = new Set([
	"method",
	"negative_prompt",
	"size_mode",
	"largest_size",
	"layers",
	"unet_name",
	"clip_name",
	"vae_name",
	"seed",
	"steps",
	"cfg",
	"sampler_name",
	"scheduler",
	"denoise",
	"keep_model_loaded",
	"lora_data",
	"uploaded_image",
	"accel_lora_name",
	"panel_width",
	"panel_height",
]);

function widget(node, name) {
	return node?.widgets?.find((item) => item?.name === name || item?.options?.name === name) || null;
}

function getValue(node, name, fallback = "") {
	const value = widget(node, name)?.value;
	return value === undefined || value === null || value === "" ? fallback : value;
}

function setValue(node, name, value) {
	node.properties ||= {};
	node.properties[name] = value;
	const w = widget(node, name);
	if (!w) return;
	w.value = value;
	if (w.inputEl) w.inputEl.value = value;
	if (w.element && "value" in w.element) w.element.value = value;
	try { w.callback?.(value); } catch (_) {}
	writeSerializedValues(node);
	if (name === "panel_width" || name === "panel_height") updateSizeModeControls(node);
	refresh(node);
}

function loraDataFromName(name) {
	const text = String(name || "").trim();
	return text ? JSON.stringify([{ enabled: true, name: text, strength: 1.0 }]) : "[]";
}

function loraNameFromData(raw) {
	try {
		const rows = JSON.parse(String(raw || "[]"));
		const first = Array.isArray(rows) ? rows.find((row) => row?.enabled !== false && String(row?.name || "").trim()) : null;
		return first ? String(first.name || "").trim() : "";
	} catch (_) {
		return "";
	}
}

function normalizeValue(name, value, node = null) {
	if (value === undefined || value === null) return DEFAULT_VALUES[name] ?? "";
	if (name === "keep_model_loaded") {
		if (typeof value === "boolean") return value;
		return ["true", "1", "yes", "on"].includes(String(value).trim().toLowerCase());
	}
	if (["largest_size", "layers", "seed", "steps", "panel_width", "panel_height"].includes(name)) {
		const numeric = Number(value);
		const rounded = Number.isFinite(numeric) ? Math.round(numeric) : DEFAULT_VALUES[name];
		if (name === "layers") return Math.min(20, Math.max(2, rounded));
		if (name === "panel_width" || name === "panel_height") {
			const stepped = Math.round(rounded / 32) * 32;
			return Math.min(2048, Math.max(256, stepped));
		}
		return rounded;
	}
	if (["cfg", "denoise"].includes(name)) {
		const numeric = Number(value);
		return Number.isFinite(numeric) ? numeric : DEFAULT_VALUES[name];
	}
	if (name === "method" && !["文生图", "图生图"].includes(String(value))) return DEFAULT_VALUES.method;
	if (name === "size_mode" && !["原图尺寸", "面板尺寸"].includes(String(value))) return DEFAULT_VALUES.size_mode;
	if (name === "lora_data" && (!value || String(value).trim() === "[]")) {
		const loraName = widget(node, "accel_lora_name")?.value || node?.properties?.accel_lora_name;
		return loraDataFromName(loraName || DEFAULT_VALUES.accel_lora_name);
	}
	if (["sampler_name", "scheduler", "unet_name", "clip_name", "vae_name", "accel_lora_name"].includes(name)) {
		const choices = widgetChoices(node, name);
		const text = String(value ?? "");
		if (choices.length && !choices.includes(text)) return choices[0] || DEFAULT_VALUES[name] || "";
		return text || DEFAULT_VALUES[name] || "";
	}
	return String(value ?? DEFAULT_VALUES[name] ?? "");
}

function collectValues(node) {
	const values = {};
	for (const name of BACKEND_WIDGETS) {
		values[name] = normalizeValue(name, widget(node, name)?.value ?? node?.properties?.[name], node);
	}
	if (!String(values.accel_lora_name || "").trim()) {
		values.accel_lora_name = loraNameFromData(values.lora_data) || normalizeValue("accel_lora_name", DEFAULT_VALUES.accel_lora_name, node);
	}
	values.lora_data = loraDataFromName(values.accel_lora_name);
	return values;
}

function applyValues(node, values) {
	if (!values || typeof values !== "object") return;
	node.__gjjLayeredRestoring = true;
	try {
		const normalized = { ...values };
		if (!String(normalized.accel_lora_name || "").trim()) {
			normalized.accel_lora_name = loraNameFromData(normalized.lora_data) || DEFAULT_VALUES.accel_lora_name;
		}
		if (!Number.isFinite(Number(normalized.panel_width))) normalized.panel_width = normalized.largest_size || DEFAULT_VALUES.panel_width;
		if (!Number.isFinite(Number(normalized.panel_height))) normalized.panel_height = normalized.largest_size || DEFAULT_VALUES.panel_height;
		normalized.lora_data = loraDataFromName(normalized.accel_lora_name);
		for (const name of BACKEND_WIDGETS) {
			const w = widget(node, name);
			if (!w) continue;
			const next = normalizeValue(name, normalized[name], node);
			w.value = next;
			if (w.inputEl && "value" in w.inputEl) w.inputEl.value = next;
			if (w.element && "value" in w.element) w.element.value = next;
		}
		node.properties ||= {};
		node.properties[VALUES_PROPERTY] = { ...collectValues(node) };
	} finally {
		node.__gjjLayeredRestoring = false;
	}
}

function isNumberLike(value) {
	return typeof value !== "boolean" && String(value ?? "").trim() !== "" && Number.isFinite(Number(value));
}

function isBooleanLike(value) {
	if (typeof value === "boolean") return true;
	return ["true", "false", "1", "0", "yes", "no", "on", "off"].includes(String(value ?? "").trim().toLowerCase());
}

function scoreSerializedValues(values, order) {
	let score = 0;
	const at = (name) => values[order.indexOf(name)];
	if (["文生图", "图生图"].includes(String(at("method")))) score += 8;
	if (!order.includes("size_mode") || ["原图尺寸", "面板尺寸"].includes(String(at("size_mode")))) score += 8;
	for (const name of ["largest_size", "layers", "seed", "steps", "cfg", "denoise", "panel_width", "panel_height"]) {
		if (isNumberLike(at(name))) score += 3;
	}
	if (isBooleanLike(at("keep_model_loaded"))) score += 3;
	for (const name of ["unet_name", "clip_name", "vae_name"]) {
		const text = String(at(name) ?? "");
		if (/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i.test(text)) score += 3;
	}
	if (/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i.test(String(at("accel_lora_name") ?? ""))) score += 3;
	return score;
}

function removeIndexes(values, indexes) {
	const blocked = new Set(indexes);
	return values.filter((_value, index) => !blocked.has(index));
}

function bestSerializedCandidate(raw) {
	const candidates = [
		raw.slice(),
		removeIndexes(raw, [1]),
		removeIndexes(raw, [1, 3]),
		raw.filter((value) => value !== undefined && value !== null),
	];
	let best = { values: raw.slice(), order: raw.length >= BACKEND_WIDGETS.length ? BACKEND_WIDGETS : LEGACY_BACKEND_WIDGETS, score: -1 };
	for (const values of candidates) {
		for (const order of [BACKEND_WIDGETS, NO_PANEL_SIZE_BACKEND_WIDGETS, NO_ACCEL_BACKEND_WIDGETS, LEGACY_BACKEND_WIDGETS, OLDER_BACKEND_WIDGETS]) {
			if (values.length < order.length) continue;
			const score = scoreSerializedValues(values, order) - Math.abs(values.length - order.length);
			if (score > best.score) best = { values, order, score };
		}
	}
	return best;
}

function valuesFromSerialized(serializedNode) {
	const stored = serializedNode?.properties?.[VALUES_PROPERTY];
	if (stored && typeof stored === "object" && !Array.isArray(stored)) return stored;
	const raw = Array.isArray(serializedNode?.widgets_values) ? serializedNode.widgets_values : [];
	if (!raw.length) return null;
	const candidate = bestSerializedCandidate(raw);
	const order = candidate.order;
	const source = candidate.values;
	const values = { ...DEFAULT_VALUES };
	for (let index = 0; index < Math.min(order.length, source.length); index += 1) {
		values[order[index]] = source[index];
	}
	if (!order.includes("panel_width")) values.panel_width = values.largest_size || DEFAULT_VALUES.panel_width;
	if (!order.includes("panel_height")) values.panel_height = values.largest_size || DEFAULT_VALUES.panel_height;
	return values;
}

function writeSerializedValues(node, serializedNode = null) {
	if (!node || node.__gjjLayeredRestoring) return;
	const values = collectValues(node);
	node.properties ||= {};
	node.properties[VALUES_PROPERTY] = { ...values };
	const ordered = BACKEND_WIDGETS.map((name) => values[name]);
	node.widgets_values = ordered.slice();
	if (serializedNode) {
		serializedNode.properties ||= {};
		serializedNode.properties[VALUES_PROPERTY] = { ...values };
		serializedNode.widgets_values = ordered;
	}
}

function modelKey(value) {
	return String(value || "").toLowerCase().replace(/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i, "").replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function widgetChoices(node, name) {
	const w = widget(node, name);
	const values = w?.options?.values || w?.options?.items || w?.values || w?.options;
	return Array.isArray(values) ? values.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function pickChoice(node, name, keywords, fallback) {
	const keys = keywords.map(modelKey).filter(Boolean);
	const choices = widgetChoices(node, name);
	const filtered = choices
		.filter((item) => keys.every((key) => modelKey(item).includes(key)))
		.sort(modelChoiceRank);
	if (fallback && !filtered.includes(fallback)) filtered.push(fallback);
	return filtered[0] || fallback || "";
}

function modelChoiceRank(left, right) {
	const rank = (value) => {
		const text = String(value || "").toLowerCase();
		if (text.endsWith(".safetensors")) return 0;
		if (text.endsWith(".gguf")) return 1;
		return 2;
	};
	return rank(left) - rank(right) || String(left || "").localeCompare(String(right || ""));
}

function normalizeModelWidgets(node) {
	const specs = [
		{ name: "unet_name", keywords: ["qwen", "layer"], fallback: "qwen_image_layered_int8_convrot.safetensors" },
		{ name: "clip_name", keywords: ["qwen_2.5_vl_7b"], fallback: "qwen_2.5_vl_7b_fp8_scaled.safetensors" },
		{ name: "vae_name", keywords: ["qwen", "layer", "vae"], fallback: "qwen_image_layered_vae.safetensors" },
		{ name: "accel_lora_name", keywords: ["qwen", "image", "lightning"], fallback: DEFAULT_ACCEL_LORA },
	];
	for (const spec of specs) {
		const current = String(getValue(node, spec.name, "") || "");
		const key = modelKey(current);
		const valid = spec.keywords.every((item) => key.includes(modelKey(item)));
		if (!valid) {
			const next = pickChoice(node, spec.name, spec.keywords, spec.fallback);
			if (next) setValue(node, spec.name, next);
		}
	}
	const loraName = String(getValue(node, "accel_lora_name", "") || "").trim();
	if (loraName) setValue(node, "lora_data", loraDataFromName(loraName));
}

function hideWidget(w) {
	if (!w || w.__gjjLayeredHidden) return;
	w.type = "hidden";
	w.hidden = true;
	w.computeSize = () => [0, -4];
	w.serialize = true;
	w.__gjjLayeredHidden = true;
}

function refresh(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function apiViewUrl(ref, rand = true) {
	if (!ref?.filename) return "";
	const suffix = rand ? `&rand=${Date.now()}` : "";
	return `/api/view?filename=${encodeURIComponent(ref.filename)}&type=${encodeURIComponent(ref.type || "temp")}&subfolder=${encodeURIComponent(ref.subfolder || "")}${suffix}`;
}

function uploadedImageRef(node) {
	const filename = String(getValue(node, "uploaded_image", "") || "").trim();
	return filename ? { filename, type: "input", subfolder: "" } : null;
}

function imageInputIndex(node) {
	return Array.isArray(node?.inputs) ? node.inputs.findIndex((item) => String(item?.name || "") === "image") : -1;
}

function graphLinkById(graph, linkId) {
	if (linkId == null || !graph) return null;
	if (typeof graph.getLink === "function") {
		const link = graph.getLink(linkId);
		if (link) return link;
	}
	const links = graph.links || graph._links;
	if (links instanceof Map) return links.get(linkId) || links.get(String(linkId)) || null;
	if (Array.isArray(links)) return links.find((link) => String(link?.id ?? link?.[0]) === String(linkId)) || null;
	return links?.[linkId] || links?.[String(linkId)] || null;
}

function imageInputLink(node) {
	const index = imageInputIndex(node);
	const input = index >= 0 ? node.inputs[index] : null;
	const linkId = Array.isArray(input?.link) ? input.link[0] : input?.link;
	const link = graphLinkById(node?.graph || app.graph, linkId);
	return { index, input, linkId, link };
}

function imageLinkMemory(node) {
	node.properties ||= {};
	const memory = node.properties[IMAGE_LINK_MEMORY_PROPERTY];
	if (memory && typeof memory === "object" && !Array.isArray(memory)) return memory;
	node.properties[IMAGE_LINK_MEMORY_PROPERTY] = {};
	return node.properties[IMAGE_LINK_MEMORY_PROPERTY];
}

function hasRememberedImageLink(node) {
	const memory = imageLinkMemory(node);
	return memory.origin_id != null && Number.isFinite(Number(memory.origin_slot));
}

function rememberAndDisconnectImageLink(node) {
	const { index, input, link } = imageInputLink(node);
	if (index < 0 || !input || !link) return false;
	const memory = imageLinkMemory(node);
	memory.origin_id = link.origin_id ?? link.source_id ?? link[1];
	memory.origin_slot = link.origin_slot ?? link.source_slot ?? link[2];
	memory.target_slot = index;
	memory.type = link.type || input.type || "IMAGE";
	try {
		node.disconnectInput?.(index);
	} catch (_) {
		try { (node.graph || app.graph)?.removeLink?.(input.link); } catch (error) { console.warn("[GJJ] disconnect image link failed:", error); }
	}
	return true;
}

function reconnectRememberedImageLink(node) {
	const memory = imageLinkMemory(node);
	const source = app.graph?.getNodeById?.(memory.origin_id);
	const sourceSlot = Number(memory.origin_slot);
	const targetSlot = imageInputIndex(node);
	if (!source || !source.outputs?.[sourceSlot] || targetSlot < 0) {
		node.properties[IMAGE_LINK_MEMORY_PROPERTY] = {};
		return false;
	}
	try {
		if (node.inputs?.[targetSlot]?.link != null) node.disconnectInput?.(targetSlot);
		source.connect(sourceSlot, node, targetSlot);
		return true;
	} catch (error) {
		console.warn("[GJJ] reconnect image link failed:", error);
		return false;
	}
}

function toggleImageLink(node) {
	const changed = hasExternalImageInput(node)
		? rememberAndDisconnectImageLink(node)
		: reconnectRememberedImageLink(node);
	if (!changed) return;
	node.graph?.change?.();
	refresh(node);
	updateImageButton(node);
	updateImageLinkButton(node);
	syncAutoMethod(node);
}

function stopCanvas(event) {
	event.stopPropagation();
}

function isInteractiveElement(element) {
	const tag = String(element?.tagName || "").toLowerCase();
	return tag === "button" || tag === "input" || tag === "textarea" || tag === "select" || Boolean(element?.isContentEditable);
}

function protectContainerEvent(event) {
	if (isInteractiveElement(event.target)) return;
	event.stopPropagation();
}

function protect(element) {
	for (const name of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "keydown", "keyup"]) {
		element.addEventListener(name, protectContainerEvent, true);
	}
	element.addEventListener("wheel", protectContainerEvent, { passive: true });
}

function button(label, title, onClick) {
	const el = document.createElement("button");
	el.type = "button";
	el.textContent = label;
	el.title = title;
	el.style.cssText = [
		"height:32px",
		"min-width:34px",
		"border:1px solid #4b616b",
		"border-radius:6px",
		"background:#182329",
		"color:#edf7f3",
		"cursor:pointer",
		"font-size:15px",
		"font-weight:700",
		"line-height:1",
		"padding:0 8px",
		"box-sizing:border-box",
		"pointer-events:auto",
	].join(";");
	el.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
	el.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.(event, el);
	}, true);
	return el;
}

function toolbarIconButton(el) {
	el.style.width = "42px";
	el.style.minWidth = "42px";
	el.style.height = "34px";
	el.style.padding = "0";
	el.style.fontSize = "24px";
	el.style.lineHeight = "1";
	el.style.display = "inline-flex";
	el.style.alignItems = "center";
	el.style.justifyContent = "center";
	return el;
}

function field(label, child) {
	const wrap = document.createElement("label");
	wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;min-width:0;color:#b8c9c8;font-size:11px;";
	const span = document.createElement("span");
	span.textContent = label;
	span.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
	wrap.append(span, child);
	return wrap;
}

function input(node, name, type = "text") {
	const el = document.createElement(type === "textarea" ? "textarea" : "input");
	if (type !== "textarea") el.type = type;
	el.value = getValue(node, name, "");
	el.style.cssText = [
		"width:100%",
		"box-sizing:border-box",
		"border:1px solid #39515a",
		"border-radius:6px",
		"background:#10181d",
		"color:#edf7f3",
		"padding:7px 8px",
		"font-size:12px",
		"resize:vertical",
		"min-height:" + (type === "textarea" ? "96px" : "30px"),
	].join(";");
	el.addEventListener("input", () => setValue(node, name, type === "number" ? Number(el.value) : el.value));
	el.addEventListener("keydown", stopCanvas, true);
	el.addEventListener("pointerdown", stopCanvas, true);
	return el;
}

function slider(node, name, min, max, step = 1) {
	const wrap = document.createElement("div");
	wrap.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) 34px;gap:8px;align-items:center;";
	const range = document.createElement("input");
	range.type = "range";
	range.min = String(min);
	range.max = String(max);
	range.step = String(step);
	range.value = String(normalizeValue(name, getValue(node, name, DEFAULT_VALUES[name]), node));
	range.style.cssText = "width:100%;accent-color:#46b895;";
	const value = document.createElement("input");
	value.type = "number";
	value.min = String(min);
	value.max = String(max);
	value.step = String(step);
	value.value = range.value;
	value.style.cssText = [
		"width:48px",
		"box-sizing:border-box",
		"border:0",
		"background:transparent",
		"color:#edf7f3",
		"padding:0",
		"text-align:right",
		"font-size:12px",
		"font-weight:700",
		"font-variant-numeric:tabular-nums",
	].join(";");
	const commit = (raw) => {
		const next = normalizeValue(name, Number(raw), node);
		range.value = String(next);
		value.value = String(next);
		setValue(node, name, next);
	};
	range.addEventListener("input", () => commit(range.value));
	value.addEventListener("change", () => commit(value.value));
	value.addEventListener("blur", () => commit(value.value));
	value.addEventListener("keydown", (event) => {
		stopCanvas(event);
		if (event.key === "Enter") {
			event.preventDefault();
			commit(value.value);
			value.blur();
		}
	}, true);
	range.addEventListener("keydown", stopCanvas, true);
	range.addEventListener("pointerdown", stopCanvas, true);
	value.addEventListener("pointerdown", stopCanvas, true);
	wrap.append(range, value);
	return wrap;
}

function select(node, name) {
	const w = widget(node, name);
	const el = document.createElement("select");
	const values = Array.isArray(w?.options?.values) ? w.options.values : [];
	for (const value of values) {
		const option = document.createElement("option");
		option.value = String(value);
		option.textContent = String(value);
		el.appendChild(option);
	}
	el.value = String(getValue(node, name, values[0] || ""));
	el.style.cssText = "width:100%;box-sizing:border-box;border:1px solid #39515a;border-radius:6px;background:#10181d;color:#edf7f3;padding:6px 8px;font-size:12px;";
	el.addEventListener("change", () => setValue(node, name, el.value));
	el.addEventListener("pointerdown", stopCanvas, true);
	return el;
}

function panelStyle(width = 520) {
	return [
		"position:fixed",
		"z-index:100000",
		`width:min(${width}px, calc(100vw - 28px))`,
		"max-height:min(680px, calc(100vh - 32px))",
		"overflow:auto",
		"display:none",
		"flex-direction:column",
		"gap:9px",
		"padding:10px",
		"box-sizing:border-box",
		"border:1px solid #41535b",
		"border-radius:8px",
		"background:#10171b",
		"color:#dce7e2",
		"box-shadow:0 16px 42px rgba(0,0,0,.45)",
		"pointer-events:auto",
	].join(";");
}

function ensureFloating(node, key, title, width, build) {
	if (node[key]) return node[key];
	const panel = document.createElement("div");
	panel.style.cssText = panelStyle(width);
	protect(panel);
	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;position:sticky;top:0;background:#10171b;padding-bottom:4px;z-index:1;";
	const titleEl = document.createElement("div");
	titleEl.textContent = title;
	titleEl.style.cssText = "font-size:13px;font-weight:700;color:#f2faf7;";
	const close = button("×", "关闭", () => closeFloating(node));
	close.style.width = "28px";
	close.style.minWidth = "28px";
	header.append(titleEl, close);
	const body = document.createElement("div");
	body.style.cssText = "display:flex;flex-direction:column;gap:8px;";
	build(body);
	panel.append(header, body);
	document.body.appendChild(panel);
	node[key] = panel;
	return panel;
}

function positionFloating(node, panel, anchor) {
	const rect = anchor?.getBoundingClientRect?.();
	const vw = Math.max(320, window.innerWidth || 320);
	const vh = Math.max(240, window.innerHeight || 240);
	const left = Math.max(12, Math.min(Math.floor(rect?.left || 12), vw - Math.ceil(panel.getBoundingClientRect().width || 520) - 12));
	const top = Math.max(12, Math.min(Math.ceil(rect?.bottom || 12) + 6, vh - 120));
	panel.style.left = `${left}px`;
	panel.style.top = `${top}px`;
}

function hoverPreview(node) {
	if (node.__gjjLayeredHoverPreview) return node.__gjjLayeredHoverPreview;
	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"position:fixed",
		"z-index:100000",
		"display:none",
		"pointer-events:none",
		"width:180px",
		"max-height:220px",
		"padding:4px",
		"border:1px solid #5f7f89",
		"border-radius:7px",
		"background:#0b1418",
		"box-shadow:0 10px 28px rgba(0,0,0,.45)",
	].join(";");
	const img = document.createElement("img");
	img.style.cssText = "display:block;width:100%;max-height:210px;object-fit:contain;border-radius:5px;";
	wrap.appendChild(img);
	document.body.appendChild(wrap);
	node.__gjjLayeredHoverPreview = wrap;
	return wrap;
}

function showHoverPreview(node, ref, event) {
	if (!ref?.filename) return;
	const wrap = hoverPreview(node);
	const img = wrap.querySelector("img");
	img.src = apiViewUrl(ref, false);
	wrap.style.display = "block";
	moveHoverPreview(node, event);
}

function moveHoverPreview(node, event) {
	const wrap = node.__gjjLayeredHoverPreview;
	if (!wrap || wrap.style.display === "none") return;
	const vw = Math.max(320, window.innerWidth || 320);
	const vh = Math.max(240, window.innerHeight || 240);
	const rect = wrap.getBoundingClientRect();
	const left = Math.min(Math.max(8, Number(event?.clientX || 0) + 14), vw - Math.max(190, rect.width) - 8);
	const top = Math.min(Math.max(8, Number(event?.clientY || 0) + 14), vh - Math.max(180, rect.height) - 8);
	wrap.style.left = `${left}px`;
	wrap.style.top = `${top}px`;
}

function hideHoverPreview(node) {
	if (node.__gjjLayeredHoverPreview) node.__gjjLayeredHoverPreview.style.display = "none";
}

function bindHoverPreview(node, element, refGetter) {
	element.addEventListener("mouseenter", (event) => showHoverPreview(node, refGetter(), event));
	element.addEventListener("mousemove", (event) => moveHoverPreview(node, event));
	element.addEventListener("mouseleave", () => hideHoverPreview(node));
}

function closeFloating(node, except = null) {
	for (const key of ["__gjjLayeredModelPanel", "__gjjLayeredSizePanel", "__gjjLayeredSettingsPanel"]) {
		if (key !== except && node?.[key]) node[key].style.display = "none";
	}
}

function toggleFloating(node, key, anchor, title, width, build) {
	const panel = ensureFloating(node, key, title, width, build);
	const open = panel.style.display !== "none";
	closeFloating(node, key);
	if (open) {
		panel.style.display = "none";
		return;
	}
	panel.style.display = "flex";
	positionFloating(node, panel, anchor);
}

function scheduleSize(node) {
	clearTimeout(node.__gjjLayeredSizeTimer);
	node.__gjjLayeredSizeTimer = setTimeout(() => {
		const root = node.__gjjLayeredPanel;
		if (!root) return;
		const width = Math.max(390, Number(node.size?.[0] || 430));
		const promptHeight = Math.max(72, Number(widget(node, "prompt")?.__gjjLayeredPromptHeight || 88));
		const panelHeight = Math.max(42, Math.ceil(root.scrollHeight || 42) + 8);
		const statusPanel = node.__gjjLayeredStatusPanel;
		const hasStatus = node.__gjjLayeredProgress?.style?.display === "block" || node.__gjjLayeredPreviewHost?.style?.display === "flex";
		const statusHeight = hasStatus ? Math.ceil(statusPanel?.scrollHeight || 0) + 8 : 0;
		const chromeAndPorts = 90;
		const height = Math.max(
			220,
			Math.ceil(chromeAndPorts + panelHeight + promptHeight + statusHeight)
		);
		node.setSize?.([width, height]);
		refresh(node);
	}, 30);
}

function configureNativePromptWidget(node) {
	const promptWidget = widget(node, "prompt");
	if (!promptWidget) return;
	promptWidget.hidden = false;
	promptWidget.__gjjLayeredHidden = false;
	promptWidget.__gjjLayeredPromptHeight = 88;
	if (promptWidget.type === "hidden") promptWidget.type = "customtext";
	promptWidget.computeSize = (width) => [Math.max(120, Number(width || node.size?.[0] || 390)), 88];
	promptWidget.getHeight = () => 88;
}

function updateKeepButton(node) {
	const active = Boolean(getValue(node, "keep_model_loaded", false));
	const keep = node.__gjjLayeredKeepButton;
	if (keep) {
		keep.textContent = active ? "📌 保持模型：开" : "📍 保持模型：关";
		keep.style.background = active ? "#1d6b58" : "#182329";
		keep.style.borderColor = active ? "#46b895" : "#4b616b";
		keep.style.color = active ? "#ecfdf5" : "#edf7f3";
	}
	const model = node.__gjjLayeredModelButton;
	if (model) {
		model.style.background = active ? "#1d6b58" : "#182329";
		model.style.borderColor = active ? "#46b895" : "#4b616b";
		model.title = active ? "模型参数；保持模型已开启" : "模型参数；保持模型已关闭";
	}
}

function updateImageButton(node) {
	const btn = node.__gjjLayeredImageButton;
	if (!btn) return;
	const active = hasReferenceImage(node);
	const external = hasExternalImageInput(node);
	btn.disabled = external;
	btn.style.background = active ? "#1d6b58" : "#182329";
	btn.style.borderColor = active ? "#46b895" : "#4b616b";
	btn.style.opacity = external ? "0.45" : "1";
	btn.style.cursor = external ? "not-allowed" : "pointer";
	btn.title = external ? "已连接外部原图，外部输入优先；按钮选择已禁用" : (active ? "已选择原图；点击重新选择图片" : "未检测到原图；点击选择图片");
}

function updateImageLinkButton(node) {
	const btn = node.__gjjLayeredImageLinkButton;
	if (!btn) return;
	const external = hasExternalImageInput(node);
	const remembered = hasRememberedImageLink(node);
	btn.style.display = external || remembered ? "flex" : "none";
	btn.style.background = external ? "#1d6b58" : "#563a12";
	btn.style.borderColor = external ? "#46b895" : "#d59a35";
	btn.title = external ? "记住上游原图并断开链接" : "恢复记住的上游原图链接";
	btn.textContent = "🔗";
}

function renderChosenImage(node, ref) {
	updateImageButton(node);
	updateImageLinkButton(node);
	scheduleSize(node);
}

function hasReferenceImage(node) {
	return Boolean(hasExternalImageInput(node) || String(getValue(node, "uploaded_image", "") || "").trim());
}

function hasExternalImageInput(node) {
	const imageInput = Array.isArray(node?.inputs) ? node.inputs.find((item) => item?.name === "image") : null;
	return imageInput?.link != null;
}

function syncAutoMethod(node) {
	setValue(node, "method", hasReferenceImage(node) ? "图生图" : "文生图");
}

async function chooseImage(node) {
	if (hasExternalImageInput(node)) {
		updateImageButton(node);
		return;
	}
	if (!node.__gjjLayeredFileInput) {
		const file = document.createElement("input");
		file.type = "file";
		file.accept = "image/png,image/jpeg,image/webp,image/bmp";
		file.style.display = "none";
		file.addEventListener("change", async () => {
			const chosen = file.files?.[0];
			if (!chosen) return;
			const form = new FormData();
			form.append("image", chosen);
			form.append("type", "input");
			form.append("subfolder", "");
			form.append("overwrite", "true");
			const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				console.warn("[GJJ] Qwen Layered 图片上传失败:", response.status, data);
				return;
			}
			const filename = data.name || data.image || data.filename || "";
			if (!filename) return;
			setValue(node, "uploaded_image", filename);
			syncAutoMethod(node);
			renderChosenImage(node, { filename });
		});
		document.body.appendChild(file);
		node.__gjjLayeredFileInput = file;
	}
	node.__gjjLayeredFileInput.value = "";
	node.__gjjLayeredFileInput.click();
}

async function uploadImageBlob(blob, filename) {
	const form = new FormData();
	const safeName = String(filename || "gjj_layered_source.png").replace(/[\\/:*?"<>|]+/g, "_");
	form.append("image", new File([blob], safeName, { type: blob.type || "image/png" }));
	form.append("type", "input");
	form.append("subfolder", "");
	form.append("overwrite", "true");
	const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data?.error || `图层上传失败：${response.status}`);
	const uploaded = data.name || data.image || data.filename || "";
	if (!uploaded) throw new Error("图层上传后没有返回文件名。");
	return uploaded;
}

async function decomposeLayerAgain(node, ref, index, buttonEl) {
	if (!ref?.filename || node.__gjjLayeredDecomposing) return;
	node.__gjjLayeredDecomposing = true;
	const oldLabel = buttonEl?.textContent;
	const baseRefs = Array.isArray(node.__gjjLayeredLastRefs) && node.__gjjLayeredLastRefs.length
		? node.__gjjLayeredLastRefs.slice()
		: [];
	const previousUploadedImage = String(getValue(node, "uploaded_image", "") || "");
	try {
		if (buttonEl) buttonEl.textContent = "...";
		renderProgress(node, `准备分解第 ${index + 1} 层并嵌回原图层...`);
		const response = await fetch(apiViewUrl(ref, false), { cache: "no-store" });
		if (!response.ok) throw new Error(`读取图层失败：${response.status}`);
		const blob = await response.blob();
		const uploaded = await uploadImageBlob(blob, `gjj_layer_${index + 1}.png`);
		node.__gjjLayeredReplaceRequest = {
			index,
			baseRefs,
			previousUploadedImage,
		};
		setValue(node, "uploaded_image", uploaded);
		syncAutoMethod(node);
		renderChosenImage(node, { filename: uploaded });
		renderProgress(node, `第 ${index + 1} 层已作为临时原图，开始分解...`);
		await queueOnlyCurrentNode?.(node);
	} catch (error) {
		node.__gjjLayeredReplaceRequest = null;
		console.warn("[GJJ] Qwen Layered 再次分解失败:", error);
		renderProgress(node, error?.message || "再次分解失败。");
	} finally {
		if (buttonEl && oldLabel != null) buttonEl.textContent = oldLabel;
		node.__gjjLayeredDecomposing = false;
	}
}

function buildModelPanel(node, body) {
	const sourceRow = document.createElement("div");
	sourceRow.style.cssText = "display:flex;align-items:center;gap:8px;color:#cfe1dc;font-size:12px;font-weight:700;";
	const label = document.createElement("span");
	label.textContent = "🧠 模型来源";
	const keep = button("📍 保持模型：关", "保持模型开关", () => {
		setValue(node, "keep_model_loaded", !Boolean(getValue(node, "keep_model_loaded", false)));
		updateKeepButton(node);
	});
	keep.style.minWidth = "132px";
	keep.style.marginLeft = "auto";
	node.__gjjLayeredKeepButton = keep;
	sourceRow.append(label, keep);
	const tree = GJJ_Utils.createModelTreeView({
		node,
		entries: [
			{
				folder: "diffusion_models",
				widget: "unet_name",
				icon: "🟣",
				label: "UNET 主模型",
				keywords: ["qwen", "layer"],
				fallback: "qwen_image_layered_int8_convrot.safetensors",
				description: "Qwen-Image-Layered 主扩散模型，放在 models/diffusion_models。",
			},
			{
				folder: "text_encoders",
				widget: "clip_name",
				icon: "🟡",
				label: "文本编码器",
				keywords: ["qwen_2.5_vl_7b"],
				fallback: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
				description: "Qwen Image 文本编码器，放在 models/text_encoders。",
			},
			{
				folder: "vae",
				widget: "vae_name",
				icon: "🔴",
				label: "VAE",
				keywords: ["qwen", "layer"],
				fallback: "qwen_image_layered_vae.safetensors",
				description: "Qwen-Image-Layered VAE，放在 models/vae。",
			},
			{
				folder: "loras",
				widget: "accel_lora_name",
				icon: "🟠",
				label: "加速 LoRA",
				keywords: ["qwen", "image", "lightning"],
				fallback: DEFAULT_ACCEL_LORA,
				description: "Qwen Image Lightning 加速 LoRA，放在 models/loras。此项为必选，会自动写入 LoRA 配置。",
				onApply: (value) => setValue(node, "lora_data", loraDataFromName(value)),
			},
		],
		refresh: () => {
			scheduleSize(node);
			refresh(node);
		},
	});
	tree.style.maxHeight = "420px";
	body.append(sourceRow, tree);
	updateKeepButton(node);
}

function buildSizePanel(node, body) {
	const modeRow = document.createElement("div");
	modeRow.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:8px;";
	const sourceBtn = button("原图尺寸", "使用原图尺寸", () => {
		setValue(node, "size_mode", "原图尺寸");
		updateSizeModeControls(node);
	});
	const panelBtn = button("面板尺寸", "使用面板尺寸", () => {
		setValue(node, "size_mode", "面板尺寸");
		updateSizeModeControls(node);
	});
	sourceBtn.dataset.sizeModeButton = "原图尺寸";
	panelBtn.dataset.sizeModeButton = "面板尺寸";
	sourceBtn.style.width = "100%";
	panelBtn.style.width = "100%";
	modeRow.append(sourceBtn, panelBtn);

	const grid = document.createElement("div");
	grid.style.cssText = "display:grid;grid-template-columns:1fr;gap:8px;";
	const sizeGrid = document.createElement("div");
	sizeGrid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:8px;";
	sizeGrid.dataset.panelSizeControl = "1";
	sizeGrid.append(
		field("宽度", slider(node, "panel_width", 256, 2048, 32)),
		field("高度", slider(node, "panel_height", 256, 2048, 32))
	);
	grid.append(
		sizeGrid,
		field("图层数", slider(node, "layers", 2, 20, 1)),
		field("种子", input(node, "seed", "number"))
	);
	body.append(modeRow, grid);
	updateSizeModeControls(node);
}

function updateSizeModeControls(node) {
	const mode = String(getValue(node, "size_mode", "原图尺寸") || "原图尺寸");
	const sizeBtn = node.__gjjLayeredSizeButton;
	if (sizeBtn) {
		const sourceMode = mode === "原图尺寸";
		sizeBtn.style.background = sourceMode ? "#174337" : "#563a12";
		sizeBtn.style.borderColor = sourceMode ? "#46b895" : "#d59a35";
		const width = Number(getValue(node, "panel_width", 640) || 640);
		const height = Number(getValue(node, "panel_height", 640) || 640);
		sizeBtn.title = sourceMode ? "尺寸：原图尺寸" : `尺寸：面板尺寸 ${width}×${height}`;
	}
	const panel = node.__gjjLayeredSizePanel;
	for (const btn of panel?.querySelectorAll?.("[data-size-mode-button]") || []) {
		const active = btn.dataset.sizeModeButton === mode;
		btn.style.background = active ? "#1d6b58" : "#182329";
		btn.style.borderColor = active ? "#46b895" : "#4b616b";
		btn.style.color = active ? "#ecfdf5" : "#edf7f3";
	}
	const disablePanelSize = mode === "原图尺寸";
	for (const wrap of panel?.querySelectorAll?.("[data-panel-size-control]") || []) {
		wrap.style.opacity = disablePanelSize ? "0.45" : "1";
		for (const control of wrap.querySelectorAll("input,select,textarea,button")) {
			control.disabled = disablePanelSize;
			control.style.cursor = disablePanelSize ? "not-allowed" : "";
		}
	}
}

function buildSettingsPanel(node, body) {
	const grid = document.createElement("div");
	grid.style.cssText = "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;";
	grid.append(
		field("步数", input(node, "steps", "number")),
		field("CFG", input(node, "cfg", "number")),
		field("降噪", input(node, "denoise", "number")),
		field("采样器", select(node, "sampler_name")),
		field("调度器", select(node, "scheduler"))
	);
	body.append(field("负面提示词", input(node, "negative_prompt", "textarea")), grid);
}

function renderProgress(node, text) {
	const root = node.__gjjLayeredProgress;
	if (!root) return;
	const clean = String(text || "").trim();
	if (!clean) {
		root.style.display = "none";
		scheduleSize(node);
		return;
	}
	root.textContent = clean;
	root.style.display = "block";
	scheduleSize(node);
	if (/完成|失败|执行失败/.test(clean)) {
		clearTimeout(node.__gjjLayeredProgressHideTimer);
		node.__gjjLayeredProgressHideTimer = setTimeout(() => {
			root.style.display = "none";
			scheduleSize(node);
		}, 1800);
	}
}

function renderPreview(node, refs = []) {
	const host = node.__gjjLayeredPreviewHost;
	if (!host) return;
	host.innerHTML = "";
	if (!Array.isArray(refs) || refs.length === 0) {
		host.style.display = "none";
		scheduleSize(node);
		return;
	}
	host.style.display = "flex";
	if (!Array.isArray(node.__gjjLayeredVisibleLayers) || node.__gjjLayeredVisibleLayers.length !== refs.length) {
		node.__gjjLayeredVisibleLayers = refs.map(() => true);
	}
	const title = document.createElement("div");
	title.textContent = `图层预览：${refs.length} 层`;
	title.style.cssText = "font-size:12px;color:#d9e9e4;font-weight:700;";
	const controls = document.createElement("div");
	controls.style.cssText = "display:flex;flex-wrap:wrap;gap:5px;align-items:center;";
	refs.forEach((_ref, index) => {
		const layerNumber = index + 1;
		const layerButton = button(layerLabel(layerNumber), `显示/隐藏图层 ${layerNumber}；Alt 点击独显/恢复；Ctrl 点击再次分解`, (event, buttonEl) => {
			if (event?.ctrlKey || event?.metaKey) {
				decomposeLayerAgain(node, refs[index], index, buttonEl);
				return;
			}
			const visible = node.__gjjLayeredVisibleLayers[index] !== false;
			const visibleCount = node.__gjjLayeredVisibleLayers.filter((item) => item !== false).length;
			if (event?.altKey) {
				const onlyThisLayer = visible && visibleCount === 1;
				node.__gjjLayeredVisibleLayers = refs.map((_item, layerIndex) => onlyThisLayer || layerIndex === index);
			} else {
				node.__gjjLayeredVisibleLayers[index] = !visible;
			}
			renderPreview(node, refs);
		});
		bindHoverPreview(node, layerButton, () => refs[index]);
		const visible = node.__gjjLayeredVisibleLayers[index] !== false;
		layerButton.style.width = "34px";
		layerButton.style.minWidth = "34px";
		layerButton.style.height = "28px";
		layerButton.style.padding = "0";
		layerButton.style.fontSize = "12px";
		layerButton.style.fontWeight = "700";
		layerButton.style.fontVariantNumeric = "tabular-nums";
		layerButton.style.opacity = visible ? "1" : "0.38";
		layerButton.style.background = visible ? "#174337" : "#182329";
		layerButton.style.borderColor = visible ? "#46b895" : "#4b616b";
		controls.appendChild(layerButton);
	});
	const stage = document.createElement("div");
	stage.style.cssText = [
		"position:relative",
		"width:100%",
		"aspect-ratio:1/1",
		"min-height:220px",
		"background:linear-gradient(45deg,#152026 25%,#1d2a31 25%,#1d2a31 50%,#152026 50%,#152026 75%,#1d2a31 75%)",
		"background-size:24px 24px",
		"overflow:hidden",
	].join(";");
	refs.forEach((ref, index) => {
		if (node.__gjjLayeredVisibleLayers[index] === false) return;
		const img = document.createElement("img");
		img.src = apiViewUrl(ref);
		img.title = `Layer ${index + 1}`;
		img.style.cssText = [
			"position:absolute",
			"inset:0",
			"width:100%",
			"height:100%",
			"object-fit:contain",
			"opacity:1",
		].join(";");
		stage.appendChild(img);
	});
	host.append(title, controls, stage);
	scheduleSize(node);
}

function layerLabel(number) {
	const emojis = ["", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
	return number >= 1 && number <= 9 ? emojis[number] : String(number);
}

function createPanel(node) {
	const root = document.createElement("div");
	root.style.cssText = "display:flex;flex-direction:column;gap:8px;width:100%;box-sizing:border-box;padding:2px 0;color:#edf7f3;font-family:system-ui,sans-serif;pointer-events:auto;";
	protect(root);

	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;";
	const imageButton = toolbarIconButton(button("📁", "未检测到原图；点击选择图片", () => chooseImage(node)));
	node.__gjjLayeredImageButton = imageButton;
	bindHoverPreview(node, imageButton, () => uploadedImageRef(node));
	const imageLinkButton = toolbarIconButton(button("🔗", "记住并断开/恢复外部原图链接", () => toggleImageLink(node)));
	imageLinkButton.style.display = "none";
	node.__gjjLayeredImageLinkButton = imageLinkButton;

	const run = toolbarIconButton(button("▶️", "生成当前节点", async (_event, btn) => {
		if (node.__gjjLayeredRandomSeed) setValue(node, "seed", Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
		syncAutoMethod(node);
		btn.textContent = "▶️";
		renderProgress(node, "提交生成...");
		try {
			await queueOnlyCurrentNode?.(node);
		} finally {
			setTimeout(() => { btn.textContent = "▶️"; }, 500);
		}
	}));
	const random = toolbarIconButton(button("🎲", "随机种子开关", (_event, btn) => {
		node.__gjjLayeredRandomSeed = !node.__gjjLayeredRandomSeed;
		btn.style.background = node.__gjjLayeredRandomSeed ? "#79520f" : "#182329";
	}));
	const modelButton = toolbarIconButton(button("🧠", "模型参数；保持模型已关闭", (_event, anchor) => toggleFloating(node, "__gjjLayeredModelPanel", anchor, "🧠 模型参数", 560, (body) => buildModelPanel(node, body))));
	node.__gjjLayeredModelButton = modelButton;
	const sizeButton = toolbarIconButton(button("📐", "尺寸：原图尺寸", (_event, anchor) => toggleFloating(node, "__gjjLayeredSizePanel", anchor, "📐 尺寸与图层", 420, (body) => buildSizePanel(node, body))));
	node.__gjjLayeredSizeButton = sizeButton;
	const settingsButton = toolbarIconButton(button("⚙️", "其它参数", (_event, anchor) => toggleFloating(node, "__gjjLayeredSettingsPanel", anchor, "⚙️ 采样与负面", 520, (body) => buildSettingsPanel(node, body))));

	toolbar.append(
		imageButton,
		imageLinkButton,
		modelButton,
		sizeButton,
		settingsButton,
		random,
		run
	);

	root.append(toolbar);
	node.__gjjLayeredPanel = root;
	syncAutoMethod(node);
	updateKeepButton(node);
	updateImageButton(node);
	updateImageLinkButton(node);
	updateSizeModeControls(node);
	return root;
}

function createStatusPanel(node) {
	const root = document.createElement("div");
	root.style.cssText = "display:flex;flex-direction:column;gap:7px;width:100%;box-sizing:border-box;padding:2px 0;color:#edf7f3;font-family:system-ui,sans-serif;pointer-events:auto;";
	protect(root);

	const progress = document.createElement("div");
	progress.style.cssText = "display:none;padding:6px 8px;border:1px solid #37525c;border-radius:6px;background:#10181d;color:#a7f3d0;font-size:12px;";
	node.__gjjLayeredProgress = progress;

	const preview = document.createElement("div");
	preview.style.cssText = "display:none;flex-direction:column;gap:7px;";
	node.__gjjLayeredPreviewHost = preview;

	root.append(progress, preview);
	node.__gjjLayeredStatusPanel = root;
	renderPreview(node, node.__gjjLayeredLastRefs || []);
	return root;
}

function install(node) {
	if (!node || node.__gjjLayeredInstalled) return;
	node.__gjjLayeredInstalled = true;
	normalizeModelWidgets(node);
	for (const w of node.widgets || []) {
		if (HIDDEN.has(w?.name)) hideWidget(w);
	}
	configureNativePromptWidget(node);
	const panel = createPanel(node);
	const statusPanel = createStatusPanel(node);
	const domWidget = node.addDOMWidget(PANEL, "HTML", panel, { serialize: false });
	domWidget.computeSize = () => [Math.max(390, Number(node.size?.[0] || 430)), Math.max(42, panel.scrollHeight + 8)];
	domWidget.getHeight = () => Math.max(42, panel.scrollHeight + 8);
	const statusWidget = node.addDOMWidget(STATUS_PANEL, "HTML", statusPanel, { serialize: false });
	const hasStatusContent = () => node.__gjjLayeredProgress?.style?.display === "block" || node.__gjjLayeredPreviewHost?.style?.display === "flex";
	statusWidget.computeSize = () => [Math.max(390, Number(node.size?.[0] || 430)), hasStatusContent() ? Math.max(1, statusPanel.scrollHeight + 8) : 0];
	statusWidget.getHeight = () => hasStatusContent() ? Math.max(1, statusPanel.scrollHeight + 8) : 0;
	const panelIndex = node.widgets?.indexOf(domWidget) ?? -1;
	const promptIndex = node.widgets?.findIndex((item) => item?.name === "prompt") ?? -1;
	if (panelIndex >= 0 && promptIndex >= 0 && panelIndex !== promptIndex - 1) {
		node.widgets.splice(panelIndex, 1);
		const nextPromptIndex = node.widgets.findIndex((item) => item?.name === "prompt");
		node.widgets.splice(Math.max(0, nextPromptIndex), 0, domWidget);
	}
	const statusIndex = node.widgets?.indexOf(statusWidget) ?? -1;
	const finalPromptIndex = node.widgets?.findIndex((item) => item?.name === "prompt") ?? -1;
	if (statusIndex >= 0 && finalPromptIndex >= 0 && statusIndex !== finalPromptIndex + 1) {
		node.widgets.splice(statusIndex, 1);
		const nextFinalPromptIndex = node.widgets.findIndex((item) => item?.name === "prompt");
		node.widgets.splice(Math.max(0, nextFinalPromptIndex + 1), 0, statusWidget);
	}
	scheduleSize(node);
	setTimeout(() => scheduleSize(node), 80);
	setTimeout(() => scheduleSize(node), 240);
}

function nodeById(id) {
	return app.graph?.getNodeById?.(Number(id)) || app.graph?._nodes?.find((item) => String(item?.id) === String(id));
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const node = nodeById(detail.node || detail.node_id);
	if (!node || (node.comfyClass || node.type) !== TARGET) return;
	renderProgress(node, detail.text || detail.message || "");
});

app.registerExtension({
	name: "Comfy.GJJ.QwenImageLayeredPSDStudio",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			setTimeout(() => {
				install(this);
				writeSerializedValues(this);
			}, 0);
			return result;
		};

		const originalConfigured = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const storedValues = valuesFromSerialized(serializedNode);
			const result = originalConfigured?.apply(this, [serializedNode, ...args]);
			setTimeout(() => {
				applyValues(this, storedValues || collectValues(this));
				normalizeModelWidgets(this);
				install(this);
				writeSerializedValues(this);
			}, 0);
			setTimeout(() => {
				applyValues(this, storedValues || collectValues(this));
				normalizeModelWidgets(this);
				configureNativePromptWidget(this);
				writeSerializedValues(this);
				scheduleSize(this);
			}, 80);
			return result;
		};

		const originalSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			const result = originalSerialize?.apply(this, [serializedNode, ...args]);
			writeSerializedValues(this, serializedNode);
			return result;
		};

		const originalRemoved = nodeType.prototype.onRemoved;
		nodeType.prototype.onRemoved = function (...args) {
			closeFloating(this);
			for (const key of ["__gjjLayeredModelPanel", "__gjjLayeredSizePanel", "__gjjLayeredSettingsPanel", "__gjjLayeredFileInput", "__gjjLayeredHoverPreview"]) {
				this[key]?.remove?.();
				this[key] = null;
			}
			return originalRemoved?.apply(this, args);
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			setTimeout(() => {
				syncAutoMethod(this);
				updateImageButton(this);
				updateImageLinkButton(this);
				scheduleSize(this);
			}, 0);
			return result;
		};

		nodeType.prototype.onDrawForeground = function () {
			for (const [key, anchor] of [
				["__gjjLayeredModelPanel", null],
				["__gjjLayeredSizePanel", null],
				["__gjjLayeredSettingsPanel", null],
			]) {
				if (this[key]?.style?.display === "flex") positionFloating(this, this[key], anchor || this.__gjjLayeredPanel);
			}
			return undefined;
		};

		nodeType.prototype.onExecuted = function (message) {
			const refs = message?.gjj_layer_images || message?.ui?.gjj_layer_images || message?.images || message?.ui?.images || [];
			const replace = this.__gjjLayeredReplaceRequest;
			if (replace && Array.isArray(replace.baseRefs)) {
				const insert = Array.isArray(refs) ? refs : [];
				const before = replace.baseRefs.slice(0, replace.index);
				const after = replace.baseRefs.slice(replace.index + 1);
				const merged = [...before, ...insert, ...after];
				this.__gjjLayeredLastRefs = merged;
				this.__gjjLayeredVisibleLayers = merged.map(() => true);
				this.__gjjLayeredReplaceRequest = null;
				setValue(this, "uploaded_image", replace.previousUploadedImage || "");
				syncAutoMethod(this);
				renderChosenImage(this, uploadedImageRef(this));
				renderProgress(this, `已将第 ${replace.index + 1} 层替换为 ${insert.length} 个透明子图层。`);
				renderPreview(this, merged);
				return undefined;
			}
			this.__gjjLayeredLastRefs = refs;
			renderPreview(this, refs);
			return undefined;
		};
	},
});
