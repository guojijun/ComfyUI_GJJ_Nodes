import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const NODE_NAME = "GJJ_Bernini13BLongVideoWatermarkRemover";
const NODE_NAMES = new Set([NODE_NAME, "GJJ_Bernini13BVideoReferenceUpscaler"]);
const MEDIA_INPUT = "media";
const REFERENCE_INPUT = "reference_resources";
const SELECTED_VIDEO = "selected_video";
const PANEL_WIDGET = "gjj_bernini13b_watermark_panel";
const PREVIEW_WIDGET = "gjj_bernini13b_watermark_preview";
const UPLOAD_API = "/gjj/video_segment_queue/upload";
const REMEMBERED_LINK = "gjj_bernini13b_remembered_media_link";
const REF_LINKS_PROP = "gjj_bernini13b_reference_virtual_media_links";
const REMEMBERED_REF_LINKS_PROP = "gjj_bernini13b_remembered_reference_virtual_media_links";
const MINIMAX_NODE = "GJJ_MiniMaxH3Studio";
const MINIMAX_REF_LINKS_PROP = "gjj_minimax_h3_reference_media_2_virtual_links";
const MAX_REFERENCE_MEDIA = 15;
const NODES = new Set();
let outsideReady = false;
let canvasPatched = false;
let graphToPromptPatched = false;

const GROUPS = [
	{ key: "model", icon: "🧠", title: "模型", fields: ["keep_model", "pre_cleanup_resources", "enable_pre_upscale", "highres_lora_strength"] },
	{ key: "prompt", icon: "📒", title: "提示词", fields: ["prompt", "negative_prompt", "reference_max_size"] },
	{ key: "sampling", icon: "⚙️", title: "采样设置", fields: ["steps", "cfg", "seed", "sampler_name", "scheduler", "denoise", "filename_prefix", "format_name", "noise_seed", "noise_strength", "normalize_noise"] },
	{ key: "timing", icon: "⏰", title: "时间与分段", fields: ["enable_segmentation", "segment_duration", "segment_frames", "frame_rate"] },
];

function widget(node, name) { return node?.widgets?.find((item) => item?.name === name); }
function value(node, name, fallback = null) { return widget(node, name)?.value ?? fallback; }
function mediaInputIndex(node) { return node?.inputs?.findIndex((item) => item?.name === MEDIA_INPUT) ?? -1; }
function mediaLinked(node) { const i = mediaInputIndex(node); return i >= 0 && node.inputs[i]?.link != null; }
function dirty(node) { node?.setDirtyCanvas?.(true, true); app.graph?.setDirtyCanvas?.(true, true); app.graph?.change?.(); }
function isReferenceUpscaler(node) { return String(node?.comfyClass || node?.type || node?.constructor?.nodeData?.name || "") === "GJJ_Bernini13BVideoReferenceUpscaler"; }
function isMiniMaxStudio(node) { return String(node?.comfyClass || node?.type || node?.constructor?.nodeData?.name || "") === MINIMAX_NODE; }
function isMultiReferenceTarget(node) { return isReferenceUpscaler(node) || isMiniMaxStudio(node); }
function referenceConfig(node) {
	return isMiniMaxStudio(node)
		? { input: "reference_media_2", property: MINIMAX_REF_LINKS_PROP, transport: "reference_media_2_" }
		: { input: REFERENCE_INPUT, property: REF_LINKS_PROP, transport: "reference_media_" };
}
function referenceInputIndex(node) { const name = referenceConfig(node).input; return node?.inputs?.findIndex((item) => item?.name === name) ?? -1; }
function referenceDot(node) { const index = referenceInputIndex(node); if (index < 0) return null; const point = connectionPosition(node, true, index); return { x: point[0], y: point[1] }; }

function hideWidget(item) {
	if (!item || item.name === PANEL_WIDGET || item.name === PREVIEW_WIDGET) return;
	item.options ||= {};
	item.hidden = true;
	item.type = `converted-widget:${item.name || "hidden"}`;
	item.options.hidden = true;
	item.options.display = "hidden";
	item.computeSize = () => [0, 0];
	item.getHeight = () => 0;
	item.draw = () => {};
	item.mouse = () => false;
}

function setValue(node, name, value) {
	const item = widget(node, name);
	if (!item) return;
	item.value = value;
	item.callback?.(value, app.canvas, node);
	if (name === "keep_model") syncKeepModelButton(node);
	if (name === "enable_segmentation") syncSegmentationButton(node);
	dirty(node);
}

function syncKeepModelButton(node) {
	const button = node?.__gjjB13GroupButtons?.get?.("model");
	if (!button) return;
	const enabled = Boolean(value(node, "keep_model", false));
	button.classList.toggle("kept", enabled);
	button.title = enabled ? "模型（保持模型已开启）" : "模型（保持模型已关闭）";
}

function syncSegmentationButton(node) {
	const button = node?.__gjjB13GroupButtons?.get?.("timing");
	if (!button || !widget(node, "enable_segmentation")) return;
	const enabled = Boolean(value(node, "enable_segmentation", false));
	button.classList.toggle("segmented", enabled);
	button.title = enabled ? "时间与分段（分段已开启）" : "时间与分段（分段已关闭）";
}

function protect(element) {
	for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "keydown"]) {
		element.addEventListener(type, (event) => event.stopPropagation());
	}
}

function injectStyle() {
	if (document.getElementById("gjj-bernini13b-wmr-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-bernini13b-wmr-style";
	style.textContent = `
		.gjj-b13-wmr{display:flex;flex-direction:column;gap:6px;width:100%;padding:2px 4px;box-sizing:border-box;color:#dcebed;font:12px/1.35 sans-serif}
		.gjj-b13-tools{display:flex;align-items:center;justify-content:center;gap:6px}.gjj-b13-tools button{width:40px;height:31px;border:1px solid #40545d;border-radius:8px;background:#172229;color:#eefaff;font-size:17px;cursor:pointer}.gjj-b13-tools button:disabled{filter:grayscale(1);opacity:.34;cursor:not-allowed}.gjj-b13-tools button.on{background:#205045;border-color:#5eead4}.gjj-b13-tools button.kept{background:#205045;border-color:#5eead4;box-shadow:inset 0 0 0 1px #5eead433}.gjj-b13-tools button.segmented{background:#594316;border-color:#f4b740;box-shadow:inset 0 0 0 1px #f4b74033}.gjj-b13-tools .link{display:none;background:#2b4052;border-color:#65a8d5}.gjj-b13-tools .link.show{display:block}.gjj-b13-tools .link.detached{background:#5a3d19;border-color:#e5a54b}
		.gjj-b13-status{padding:5px 8px;border:1px solid #30464e;border-radius:6px;background:#0d171b;color:#a9bdc4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.gjj-b13-popup{position:fixed;z-index:100005;width:min(450px,calc(100vw - 28px));max-height:calc(100vh - 28px);overflow:auto;padding:12px;border:1px solid #49616a;border-radius:11px;background:#10191e;color:#deeaed;box-shadow:0 18px 55px #000b;font:12px/1.4 sans-serif;box-sizing:border-box}.gjj-b13-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px;font-weight:800;font-size:14px}.gjj-b13-head button{border:0;background:transparent;color:#aabac0;font-size:20px;cursor:pointer}.gjj-b13-row{display:grid;grid-template-columns:128px minmax(0,1fr);gap:8px;align-items:center;margin:8px 0}.gjj-b13-row input,.gjj-b13-row textarea,.gjj-b13-row select{width:100%;box-sizing:border-box;padding:6px 7px;border:1px solid #344a53;border-radius:6px;background:#0b1418;color:#e7f0f2}.gjj-b13-row textarea{min-height:76px;resize:vertical}.gjj-b13-row input[type=checkbox]{width:18px}
		.gjj-b13-toggle{width:100%;min-height:32px;border:1px solid #40545d;border-radius:7px;background:#142128;color:#b9c9cd;cursor:pointer;font-weight:800}.gjj-b13-toggle.on{border-color:#5eead4;background:#205045;color:#fff}
		.gjj-b13-toggle-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin:8px 0 10px}.gjj-b13-toggle-cell{display:flex;min-width:0}.gjj-b13-toggle-cell .gjj-b13-toggle{min-height:38px;padding:5px 7px;line-height:1.25;white-space:normal}
		.gjj-b13-slider{display:grid;grid-template-columns:minmax(0,1fr) 42px;gap:7px;align-items:center}.gjj-b13-slider input{padding:0}.gjj-b13-slider output{text-align:right;color:#d9f7f2;font-weight:800}.gjj-b13-slider.disabled{opacity:.38;filter:grayscale(1)}
		.gjj-b13-preview{display:none;width:100%;box-sizing:border-box;padding:4px}.gjj-b13-preview-title{margin:3px 2px 6px;color:#9fb8c0;font-weight:700}
	`;
	document.head.appendChild(style);
}

function closePopup(node) {
	node.__gjjB13Popup?.remove();
	node.__gjjB13Popup = null;
	node.__gjjB13Active = "";
	for (const button of node.__gjjB13GroupButtons?.values?.() || []) button.classList.remove("on");
}

function outsideHandler() {
	if (outsideReady) return;
	outsideReady = true;
	window.addEventListener("pointerdown", (event) => {
		for (const node of NODES) {
			if (!node.__gjjB13Popup || node.__gjjB13Popup.contains(event.target) || node.__gjjB13Root?.contains(event.target)) continue;
			closePopup(node);
		}
	}, true);
}

function control(node, name, onDynamicChange = null, labelText = "") {
	const item = widget(node, name);
	if (!item) return null;
	const values = typeof item.options?.values === "function" ? item.options.values() : item.options?.values;
	let element;
	if (Array.isArray(values)) {
		element = document.createElement("select");
		for (const value of values) { const option = document.createElement("option"); option.value = value; option.textContent = value; element.appendChild(option); }
		element.value = String(item.value ?? "");
		element.onchange = () => setValue(node, name, element.value);
	} else if (typeof item.value === "boolean") {
		if (["keep_model", "pre_cleanup_resources", "enable_pre_upscale", "enable_segmentation"].includes(name)) {
			element = document.createElement("button"); element.type = "button"; element.className = "gjj-b13-toggle";
			const refresh = () => {
				const enabled = Boolean(value(node, name, false));
				element.classList.toggle("on", enabled);
				element.textContent = labelText || name;
			};
			element.onclick = () => {
				setValue(node, name, !Boolean(value(node, name, false)));
				refresh();
				if (["enable_pre_upscale", "enable_segmentation"].includes(name)) onDynamicChange?.();
			};
			refresh();
		} else {
			element = document.createElement("input"); element.type = "checkbox"; element.checked = item.value;
			element.onchange = () => setValue(node, name, element.checked);
		}
	} else if (typeof item.value === "number") {
		const slider = name === "segment_duration" || item.options?.gjj_panel_control === "slider";
		const numberInput = document.createElement("input"); numberInput.type = slider ? "range" : "number"; numberInput.value = item.value;
		if (item.options?.min != null) numberInput.min = item.options.min; if (item.options?.max != null) numberInput.max = item.options.max; if (item.options?.step != null) numberInput.step = item.options.step;
		if (name === "segment_duration") {
			numberInput.min = "5";
			numberInput.max = "121";
			numberInput.step = "4";
			numberInput.value = String(Math.max(5, Math.min(121, 5 + Math.round((Number(numberInput.value || 121) - 5) / 4) * 4)));
		}
		if (slider) {
			element = document.createElement("div"); element.className = "gjj-b13-slider";
			const output = document.createElement("output"); output.textContent = String(numberInput.value);
			if (name === "segment_duration" && !Boolean(value(node, "enable_segmentation", false))) {
				numberInput.disabled = true;
				element.classList.add("disabled");
			}
			const updateSlider = () => {
				let nextValue = Number(numberInput.value);
				if (name === "segment_duration") {
					nextValue = Math.max(5, Math.min(121, 5 + Math.round((nextValue - 5) / 4) * 4));
					numberInput.value = String(nextValue);
				}
				output.textContent = String(nextValue);
				setValue(node, name, nextValue);
			};
			numberInput.oninput = updateSlider; numberInput.onchange = updateSlider; element.append(numberInput, output);
		} else {
			element = numberInput;
			element.onchange = () => setValue(node, name, Number(element.value));
		}
	} else {
		element = document.createElement(name.includes("prompt") ? "textarea" : "input"); element.value = String(item.value ?? "");
		element.onchange = () => setValue(node, name, element.value);
	}
	return element;
}

function modelEntries(node) {
	const entries = [
		["model_name", "Bernini 1.3B 模型", "models/diffusion_models", "🟣"],
		["clip_name", "UMT5 XXL", "models/text_encoders", "🟡"],
		["vae_name", "Wan VAE", "models/vae", "🔴"],
	];
	if (widget(node, "highres_lora_name")) {
		entries.push(["highres_lora_name", "HighResFix LoRA", "models/loras", "🟢"]);
	}
	if (Boolean(value(node, "enable_pre_upscale", false))) {
		entries.push(["upscale_model_name", "预放大模型", "models/upscale_models", "🔍"]);
	}
	return entries.map(([name, label, folder, icon]) => {
		const item = widget(node, name);
		const values = typeof item?.options?.values === "function" ? item.options.values() : item?.options?.values;
		const models = (Array.isArray(values) ? values : []).filter((value) => !String(value).startsWith("缺失："));
		const defaultModel = String(item?.options?.gjj_default_model || "");
		return { widget: name, label, folder, icon, models, defaultModel, fallback: defaultModel, missingDefault: models.length === 0, autoSelect: true };
	});
}

function openPopup(node, group, anchor) {
	if (node.__gjjB13Active === group.key) { closePopup(node); return; }
	closePopup(node);
	const popup = document.createElement("div"); popup.className = "gjj-b13-popup"; protect(popup);
	const head = document.createElement("div"); head.className = "gjj-b13-head"; head.innerHTML = `<span>${group.icon} ${group.title}</span>`;
	const x = document.createElement("button"); x.textContent = "×"; x.onclick = () => closePopup(node); head.appendChild(x); popup.appendChild(head);
	const toggleNames = group.key === "model"
		? new Set(["keep_model", "pre_cleanup_resources", "enable_pre_upscale"])
		: (group.key === "timing" && widget(node, "enable_segmentation") ? new Set(["enable_segmentation"]) : new Set());
	const toggleRow = toggleNames.size ? document.createElement("div") : null;
	if (toggleRow) toggleRow.className = "gjj-b13-toggle-row";
	if (toggleRow && group.key === "timing") toggleRow.style.gridTemplateColumns = "1fr";
	if (toggleRow) popup.appendChild(toggleRow);
	for (const name of group.fields) {
		const reopen = () => setTimeout(() => { closePopup(node); openPopup(node, group, anchor); }, 0);
		const item = widget(node, name);
		const displayName = item?.options?.display_name || name;
		const input = control(node, name, reopen, toggleNames.has(name) ? displayName : "");
		if (!item || !input) continue;
		if (toggleNames.has(name)) {
			const cell = document.createElement("div"); cell.className = "gjj-b13-toggle-cell"; cell.appendChild(input); toggleRow.appendChild(cell);
			continue;
		}
		const row = document.createElement("label"); row.className = "gjj-b13-row"; const label = document.createElement("span"); label.textContent = item.options?.display_name || name; row.append(label, input); popup.appendChild(row);
	}
	if (group.key === "model") popup.appendChild(GJJ_Utils.createModelTreeView({ node, entries: modelEntries(node), refresh: () => dirty(node), onApply: () => dirty(node) }));
	document.body.appendChild(popup); node.__gjjB13Popup = popup; node.__gjjB13Active = group.key; node.__gjjB13GroupButtons.get(group.key)?.classList.add("on");
	const rect = anchor.getBoundingClientRect(); let left = Math.min(rect.left, window.innerWidth - Math.min(450, window.innerWidth - 28) - 14); left = Math.max(14, left);
	popup.style.left = `${left}px`; popup.style.top = `${rect.bottom + 7}px`; popup.style.maxHeight = `${Math.max(120, window.innerHeight - rect.bottom - 21)}px`;
}

function rememberAndDisconnect(node) {
	node.properties ||= {};
	const index = mediaInputIndex(node);
	if (index >= 0) {
		const linkId = node.inputs[index]?.link; const link = app.graph?.links?.[linkId];
		if (link) node.properties[REMEMBERED_LINK] = { origin_id: link.origin_id, origin_slot: link.origin_slot };
		if (linkId != null) node.disconnectInput?.(index);
	}
	const referenceLinks = normalizeReferenceLinks(node, false);
	if (referenceLinks.length) {
		node.properties[REMEMBERED_REF_LINKS_PROP] = referenceLinks.map((item) => ({ ...item }));
		node.properties[REF_LINKS_PROP] = [];
	}
	syncLinkState(node); dirty(node);
}

function restoreRemembered(node) {
	const saved = node.properties?.[REMEMBERED_LINK]; const index = mediaInputIndex(node);
	const origin = app.graph?.getNodeById?.(saved?.origin_id);
	if (saved && index >= 0 && origin?.connect) origin.connect(saved.origin_slot, node, index);
	const rememberedReferences = node.properties?.[REMEMBERED_REF_LINKS_PROP];
	if (Array.isArray(rememberedReferences)) node.properties[REF_LINKS_PROP] = rememberedReferences.map((item) => ({ ...item }));
	normalizeReferenceLinks(node);
	syncLinkState(node); dirty(node);
}

function syncLinkState(node) {
	const sourceLinked = mediaLinked(node);
	const linked = sourceLinked || (isReferenceUpscaler(node) && normalizeReferenceLinks(node).length > 0);
	const remembered = Boolean(node.properties?.[REMEMBERED_LINK]) || (Array.isArray(node.properties?.[REMEMBERED_REF_LINKS_PROP]) && node.properties[REMEMBERED_REF_LINKS_PROP].length > 0);
	if (node.__gjjB13Folder) { node.__gjjB13Folder.disabled = sourceLinked; node.__gjjB13Folder.title = sourceLinked ? "已有 VIDEO/IMAGE 链接，内部视频选择已禁用" : "打开本地视频"; }
	if (node.__gjjB13Link) { node.__gjjB13Link.classList.toggle("show", linked || remembered); node.__gjjB13Link.classList.toggle("detached", !linked && remembered); node.__gjjB13Link.title = linked ? "断开并记住全部上游接口" : "恢复记住的全部上游接口"; }
}

function ensureReferenceLinks(node) {
	node.properties ||= {};
	const property = referenceConfig(node).property;
	if (!Array.isArray(node.properties[property])) node.properties[property] = [];
	return node.properties[property];
}

function normalizeReferenceLinks(node, removeMissing = true) {
	const links = ensureReferenceLinks(node);
	const seen = new Set();
	const kept = [];
	for (const link of links) {
		const sourceId = Number(link?.source_id);
		const sourceSlot = Number(link?.source_slot) || 0;
		if (!Number.isFinite(sourceId)) continue;
		const source = app.graph?.getNodeById?.(sourceId);
		if (removeMissing && !source) continue;
		const key = `${sourceId}:${sourceSlot}`;
		if (seen.has(key)) continue;
		seen.add(key);
		kept.push({ source_id: sourceId, source_slot: sourceSlot, source_type: String(link?.source_type || "*"), order: kept.length + 1 });
		if (kept.length >= MAX_REFERENCE_MEDIA) break;
	}
	node.properties[referenceConfig(node).property] = kept;
	return kept;
}

function slotType(slot) {
	return String(slot?.type || slot?.datatype || slot?.label || "").toUpperCase();
}

function isReferenceMediaType(type, allowAudio = false) {
	const value = String(type || "").toUpperCase();
	return value.includes("IMAGE") || value.includes("VIDEO") || value.includes("GJJ_BATCH_IMAGE") || (allowAudio && value.includes("AUDIO")) || value === "*";
}

function connectionPosition(node, isInput, slotIndex) {
	const normalize = (point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]) ? [point[0], point[1]] : null;
	const modern = isInput ? normalize(node?.getInputPos?.(slotIndex)) : normalize(node?.getOutputPos?.(slotIndex));
	if (modern) return modern;
	const out = [0, 0];
	try {
		const legacy = normalize(node?.getConnectionPos?.(isInput, slotIndex, out)) || normalize(out);
		if (legacy) return legacy;
	} catch (_) {}
	const y = Number(node?.pos?.[1] || 0) + 40 + Math.max(0, slotIndex) * 20;
	return isInput ? [Number(node?.pos?.[0] || 0), y] : [Number(node?.pos?.[0] || 0) + Number(node?.size?.[0] || 160), y];
}

function graphPosition(canvas, event) {
	try { canvas?.adjustMouseEvent?.(event); } catch (_) {}
	if (Array.isArray(canvas?.graph_mouse)) return [canvas.graph_mouse[0], canvas.graph_mouse[1]];
	if (Number.isFinite(event?.canvasX) && Number.isFinite(event?.canvasY)) return [event.canvasX, event.canvasY];
	const rect = canvas?.canvas?.getBoundingClientRect?.();
	const scale = canvas?.ds?.scale || 1;
	const offset = canvas?.ds?.offset || [0, 0];
	if (rect && Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) return [(event.clientX - rect.left) / scale - offset[0], (event.clientY - rect.top) / scale - offset[1]];
	return [0, 0];
}

function clientPosition(canvas, point) {
	const rect = canvas?.canvas?.getBoundingClientRect?.();
	if (!rect) return null;
	const scale = canvas?.ds?.scale || 1;
	const offset = canvas?.ds?.offset || [0, 0];
	return { x: rect.left + (point[0] + offset[0]) * scale, y: rect.top + (point[1] + offset[1]) * scale };
}

function connectingOutput(canvas) {
	const node = canvas?.connecting_node || canvas?.connectingNode;
	if (!node) return null;
	const raw = canvas.connecting_output ?? canvas.connecting_slot ?? canvas.connecting_output_slot;
	if (raw == null && canvas.connecting_input) return null;
	const index = typeof raw === "number" ? raw : Number(raw?.slot_index ?? raw?.slot ?? 0);
	const output = node.outputs?.[Number.isFinite(index) ? index : 0] || raw || {};
	return { sourceNode: node, sourceSlot: Number.isFinite(index) ? index : 0, sourceType: slotType(output) };
}

function clearConnecting(canvas) {
	canvas.connecting_node = null;
	canvas.connecting_output = null;
	canvas.connecting_slot = null;
	canvas.connecting_pos = null;
	canvas.connecting_input = null;
}

function referenceMediaKind(sourceType, sourceNode = null) {
	const value = String(sourceType || "").toUpperCase();
	if (value.includes("VIDEO")) return "video";
	if (value.includes("IMAGE") || value.includes("GJJ_BATCH_IMAGE")) return "image";
	const name = String(sourceNode?.comfyClass || sourceNode?.type || "").toLowerCase();
	if (name.includes("video")) return "video";
	return "image";
}

function addReferenceVirtualLink(targetNode, sourceNode, sourceSlot, sourceType) {
	if (!isMultiReferenceTarget(targetNode) || !sourceNode || !isReferenceMediaType(sourceType, isMiniMaxStudio(targetNode))) return false;
	const links = normalizeReferenceLinks(targetNode, false);
	if (links.length >= MAX_REFERENCE_MEDIA) return false;
	if (links.some((link) => Number(link.source_id) === Number(sourceNode.id) && Number(link.source_slot) === Number(sourceSlot))) return false;
	links.push({ source_id: Number(sourceNode.id), source_slot: Number(sourceSlot) || 0, source_type: String(sourceType || "*"), media_type: referenceMediaKind(sourceType, sourceNode), order: links.length + 1 });
	normalizeReferenceLinks(targetNode, false);
	if (isReferenceUpscaler(targetNode)) syncLinkState(targetNode);
	dirty(targetNode);
	return true;
}

function removeReferenceVirtualLink(node, index) {
	const links = ensureReferenceLinks(node);
	if (index < 0 || index >= links.length) return false;
	links.splice(index, 1);
	normalizeReferenceLinks(node, false);
	if (isReferenceUpscaler(node)) syncLinkState(node);
	dirty(node);
	return true;
}

function cubicPoint(start, end, t) {
	const cp1 = [start[0] + 80, start[1]];
	const cp2 = [end[0] - 80, end[1]];
	const mt = 1 - t;
	return [
		mt * mt * mt * start[0] + 3 * mt * mt * t * cp1[0] + 3 * mt * t * t * cp2[0] + t * t * t * end[0],
		mt * mt * mt * start[1] + 3 * mt * mt * t * cp1[1] + 3 * mt * t * t * cp2[1] + t * t * t * end[1],
	];
}

function referenceLinkGeometry(targetNode, link) {
	const sourceNode = targetNode.graph?.getNodeById?.(Number(link.source_id)) || app.graph?.getNodeById?.(Number(link.source_id));
	const dot = referenceDot(targetNode);
	if (!sourceNode || !dot) return null;
	const source = connectionPosition(sourceNode, false, Number(link.source_slot) || 0);
	const target = [dot.x, dot.y];
	return { sourceNode, source, target, mid: cubicPoint(source, target, 0.5) };
}

function referenceLinkColor(canvas, link) {
	const colors = globalThis.LGraphCanvas?.link_type_colors || {};
	const type = String(link?.source_type || "");
	const fallback = String(link?.media_type || "image") === "video" ? "#5aa9f0" : "#83d18a";
	return colors[type] || colors[type.toUpperCase()] || colors[type.toLowerCase()] || fallback || canvas?.default_link_color || globalThis.LiteGraph?.LINK_COLOR || "#9A9";
}

function drawReferenceLinks(canvas, ctx) {
	const graph = canvas?.graph || app.graph;
	if (!graph?._nodes || canvas.links_render_mode === globalThis.LiteGraph?.HIDDEN_LINK) return;
	for (const node of graph._nodes) {
		if (!isMultiReferenceTarget(node)) continue;
		for (const link of normalizeReferenceLinks(node)) {
			const geometry = referenceLinkGeometry(node, link);
			if (!geometry) continue;
			const color = referenceLinkColor(canvas, link);
			const width = canvas.connections_width || 3;
			ctx.save();
			ctx.beginPath();
			ctx.moveTo(geometry.source[0], geometry.source[1]);
			ctx.bezierCurveTo(geometry.source[0] + 80, geometry.source[1], geometry.target[0] - 80, geometry.target[1], geometry.target[0], geometry.target[1]);
			ctx.lineWidth = width + 4;
			ctx.strokeStyle = canvas.render_connections_border !== false && !canvas.low_quality ? "rgba(0,0,0,.5)" : "transparent";
			if (ctx.strokeStyle !== "transparent") ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(geometry.source[0], geometry.source[1]);
			ctx.bezierCurveTo(geometry.source[0] + 80, geometry.source[1], geometry.target[0] - 80, geometry.target[1], geometry.target[0], geometry.target[1]);
			ctx.lineWidth = width;
			ctx.strokeStyle = color;
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(geometry.mid[0], geometry.mid[1], 10, 0, Math.PI * 2);
			ctx.fillStyle = color;
			ctx.fill();
			ctx.lineWidth = 2;
			ctx.strokeStyle = "rgba(255,255,255,.9)";
			ctx.stroke();
			ctx.fillStyle = "#fff";
			ctx.font = "bold 14px sans-serif";
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillText(String(link.order || 1), geometry.mid[0], geometry.mid[1] + 0.5);
			ctx.restore();
		}
	}
}

function hitReferenceLinks(graph, x, y) {
	let best = null;
	for (const node of graph?._nodes || []) {
		if (!isMultiReferenceTarget(node)) continue;
		normalizeReferenceLinks(node).forEach((link, index) => {
			const geometry = referenceLinkGeometry(node, link);
			if (!geometry) return;
			const distance = Math.hypot(x - geometry.mid[0], y - geometry.mid[1]);
			if (distance <= 18 && (!best || distance < best.distance)) best = { node, index, point: geometry.mid, distance };
		});
	}
	return best;
}

function openReferenceLinkMenu(canvas, hit, event) {
	const anchor = clientPosition(canvas, hit.point) || { x: event?.clientX || 0, y: event?.clientY || 0 };
	const menuEvent = typeof PointerEvent === "function"
		? new PointerEvent("pointerdown", { clientX: anchor.x + 8, clientY: anchor.y + 8, bubbles: true, cancelable: true })
		: new MouseEvent("mousedown", { clientX: anchor.x + 8, clientY: anchor.y + 8, bubbles: true, cancelable: true });
	if (!globalThis.LiteGraph?.ContextMenu) {
		removeReferenceVirtualLink(hit.node, hit.index);
		return;
	}
	let menu = null;
	menu = new globalThis.LiteGraph.ContextMenu([{ content: "删除", callback: () => { removeReferenceVirtualLink(hit.node, hit.index); menu?.close?.(); menu?.remove?.(); } }], { event: menuEvent });
}

function patchReferenceCanvas() {
	const canvas = app.canvas;
	if (!canvas || canvasPatched || typeof canvas.drawConnections !== "function") return;
	canvasPatched = true;
	const originalDraw = canvas.drawConnections;
	canvas.drawConnections = function drawConnectionsWithGjjReferenceLinks(ctx) {
		const result = originalDraw?.apply(this, arguments);
		const connectionContext = ctx || this.bgctx || this.ctx;
		const onConnectionLayer = connectionContext?.canvas === this?.bgcanvas || connectionContext === this?.bgctx || !this?.bgcanvas;
		if (connectionContext && onConnectionLayer) drawReferenceLinks(this, connectionContext);
		return result;
	};
	const originalDown = canvas.processMouseDown;
	canvas.processMouseDown = function processMouseDownWithGjjReferenceLinks(event) {
		const [x, y] = graphPosition(this, event);
		const hit = hitReferenceLinks(this.graph || app.graph, x, y);
		if (hit) {
			openReferenceLinkMenu(this, hit, event);
			event?.preventDefault?.();
			event?.stopImmediatePropagation?.();
			return true;
		}
		return originalDown?.apply(this, arguments);
	};
	const originalUp = canvas.processMouseUp;
	canvas.processMouseUp = function processMouseUpWithGjjReferenceLinks(event) {
		const output = connectingOutput(this);
		const [x, y] = graphPosition(this, event);
		const target = (this.graph || app.graph)?._nodes?.find((node) => isMultiReferenceTarget(node) && (() => {
			const dot = referenceDot(node);
			return dot && Math.hypot(x - dot.x, y - dot.y) <= 18;
		})());
		if (output && target && addReferenceVirtualLink(target, output.sourceNode, output.sourceSlot, output.sourceType)) {
			clearConnecting(this);
			this.graph?.setDirtyCanvas?.(true, true);
			event?.preventDefault?.();
			event?.stopImmediatePropagation?.();
			return true;
		}
		return originalUp?.apply(this, arguments);
	};
}

function patchReferenceGraphToPrompt() {
	if (graphToPromptPatched || typeof app.graphToPrompt !== "function") return;
	graphToPromptPatched = true;
	const original = app.graphToPrompt;
	app.graphToPrompt = async function graphToPromptWithGjjReferenceMedia() {
		const promptData = await original.apply(this, arguments);
		const output = promptData?.output || {};
		for (const node of app.graph?._nodes || []) {
			if (!isMultiReferenceTarget(node)) continue;
			absorbNativeReferenceLink(node);
			const promptNode = output[String(node.id)];
			if (!promptNode) continue;
			promptNode.inputs ||= {};
			const config = referenceConfig(node);
			delete promptNode.inputs[config.input];
			for (let index = 1; index <= MAX_REFERENCE_MEDIA; index += 1) delete promptNode.inputs[`${config.transport}${index}`];
			const links = normalizeReferenceLinks(node).filter((link) => Boolean(output[String(link.source_id)]));
			links.forEach((link, index) => {
				promptNode.inputs[`${config.transport}${index + 1}`] = [String(link.source_id), Number(link.source_slot) || 0];
			});
		}
		return promptData;
	};
}

function pruneReferenceTransportInputs(nodeData) {
	const optional = nodeData?.input?.optional;
	if (!optional) return;
	if (nodeData?.name === "GJJ_Bernini13BVideoReferenceUpscaler") {
		for (const name of Object.keys(optional)) if (/^reference_media_\d+$/.test(name)) delete optional[name];
	} else if (nodeData?.name === MINIMAX_NODE) {
		delete optional.reference_media_3;
		for (const name of Object.keys(optional)) if (/^reference_media_2_\d+$/.test(name)) delete optional[name];
	}
}

function absorbNativeReferenceLink(node) {
	if (!isMultiReferenceTarget(node) || node.__gjjB13AbsorbingReferenceLink) return false;
	const inputIndex = referenceInputIndex(node);
	if (inputIndex < 0) return false;
	const input = node.inputs?.[inputIndex];
	const linkId = input?.link;
	if (linkId == null) return false;
	const link = app.graph?.links?.[linkId];
	const sourceNode = app.graph?.getNodeById?.(link?.origin_id);
	const sourceSlot = Number(link?.origin_slot) || 0;
	const sourceType = slotType(sourceNode?.outputs?.[sourceSlot]) || String(link?.type || "*");
	node.__gjjB13AbsorbingReferenceLink = true;
	try {
		if (sourceNode && addReferenceVirtualLink(node, sourceNode, sourceSlot, sourceType)) {
			node.disconnectInput?.(inputIndex);
			if (node.inputs?.[inputIndex]) node.inputs[inputIndex].link = null;
			dirty(node);
			return true;
		}
	} finally {
		node.__gjjB13AbsorbingReferenceLink = false;
	}
	return false;
}

async function upload(node, file) {
	const form = new FormData(); form.append("video", file, file.name || "video.mp4");
	const response = await fetch(api.apiURL(UPLOAD_API), { method: "POST", body: form }); const data = await response.json().catch(() => ({}));
	if (!response.ok || data?.ok === false) throw new Error(data?.error || "视频导入失败");
	setValue(node, SELECTED_VIDEO, JSON.stringify(data.video || {})); node.__gjjB13Status.textContent = `内部视频：${data.video?.filename || file.name}`;
	addSegmentPreview(node, [data.video || {}], 1, 1, "source_video");
}

function selectedVideoItem(node) {
	const raw = widget(node, SELECTED_VIDEO)?.value;
	if (!raw) return null;
	try {
		const value = typeof raw === "string" ? JSON.parse(raw) : raw;
		return value?.filename ? value : null;
	} catch (_) {
		const normalized = String(raw).replaceAll("\\", "/");
		const parts = normalized.split("/").filter(Boolean);
		return parts.length ? { filename: parts.pop(), subfolder: parts.join("/"), type: "input" } : null;
	}
}

function ensurePreview(node) {
	if (node.__gjjB13Preview) return;
	const root = document.createElement("div");
	root.style.cssText = "display:none;width:100%;height:0;margin:0;padding:0;border:0;overflow:hidden;background:#000;box-sizing:border-box;line-height:0;";
	const video = document.createElement("video");
	video.style.cssText = "display:block;width:100%;height:100%;margin:0;padding:0;border:0;object-fit:contain;background:#000;";
	video.muted = true;
	video.defaultMuted = true;
	video.setAttribute("muted", "");
	video.loop = true;
	video.autoplay = true;
	video.playsInline = true;
	video.preload = "auto";
	video.controls = true;
	root.appendChild(video);
	protect(root);
	const state = { root, video, item: null, visible: false, height: 0 };
	const previewWidget = node.addDOMWidget(PREVIEW_WIDGET, "HTML", root, { serialize: false, hideOnZoom: false });
	previewWidget.serialize = false;
	previewWidget.computeSize = (width) => {
		const contentWidth = Math.max(270, Number(width || node.size?.[0] || 330) - 20);
		if (!state.visible) return [contentWidth, 0];
		const sourceWidth = Math.max(1, Number(state.item?.width || video.videoWidth || 1));
		const sourceHeight = Math.max(1, Number(state.item?.height || video.videoHeight || 1));
		state.height = Math.max(80, Math.round(contentWidth * sourceHeight / sourceWidth));
		root.style.height = `${state.height}px`;
		return [contentWidth, state.height];
	};
	previewWidget.getHeight = () => state.visible ? state.height : 0;
	state.widget = previewWidget;
	node.__gjjB13Preview = state;
}

function addSegmentPreview(node, images, segment, total, label = "segment_video") {
	ensurePreview(node); const state = node.__gjjB13Preview; const item = Array.isArray(images) ? images[0] : null; if (!item?.filename) return;
	state.item = item;
	state.visible = true;
	state.root.style.display = "block";
	const url = api.apiURL(`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "temp")}&subfolder=${encodeURIComponent(item.subfolder || "")}&rand=${Date.now()}`);
	state.video.pause?.();
	state.video.src = url;
	state.video.load?.();
	const startPlayback = () => {
		const playback = state.video.play?.();
		if (playback?.catch) playback.catch(() => {});
		resize(node);
	};
	state.video.addEventListener("loadeddata", startPlayback, { once: true });
	state.video.addEventListener("canplay", startPlayback, { once: true });
	resize(node);
}

function resize(node) { requestAnimationFrame(() => { const size = node.computeSize?.(); if (Array.isArray(size)) node.setSize?.([Math.max(330, Number(node.size?.[0] || 330)), Math.max(110, Number(size[1] || 110))]); dirty(node); }); }

function setup(node) {
	if (node.__gjjB13Ready) return; node.__gjjB13Ready = true; NODES.add(node); injectStyle(); outsideHandler();
	patchReferenceCanvas();
	patchReferenceGraphToPrompt();
	if (isReferenceUpscaler(node)) normalizeReferenceLinks(node);
	for (const item of node.widgets || []) hideWidget(item);
	const root = document.createElement("div"); root.className = "gjj-b13-wmr"; protect(root); node.__gjjB13Root = root;
	const tools = document.createElement("div"); tools.className = "gjj-b13-tools"; const file = document.createElement("input"); file.type = "file"; file.accept = "video/*,.mp4,.mov,.m4v,.webm,.avi,.mkv,.wmv,.flv,.mpeg,.mpg"; file.style.display = "none";
	const folder = document.createElement("button"); folder.textContent = "📁"; folder.onclick = () => { if (!folder.disabled) file.click(); }; node.__gjjB13Folder = folder; tools.appendChild(folder);
	const link = document.createElement("button"); link.textContent = "🔗"; link.className = "link"; link.onclick = () => (mediaLinked(node) || (isReferenceUpscaler(node) && normalizeReferenceLinks(node).length > 0)) ? rememberAndDisconnect(node) : restoreRemembered(node); node.__gjjB13Link = link; tools.appendChild(link);
	node.__gjjB13GroupButtons = new Map(); for (const group of GROUPS) { const button = document.createElement("button"); button.textContent = group.icon; button.title = group.title; button.onclick = () => openPopup(node, group, button); node.__gjjB13GroupButtons.set(group.key, button); tools.appendChild(button); }
	syncKeepModelButton(node);
	syncSegmentationButton(node);
	const run = document.createElement("button"); run.textContent = "▶️"; run.title = "只运行当前节点"; run.onclick = async () => { run.disabled = true; try { await queueOnlyCurrentNode(node); } finally { run.disabled = false; } }; tools.appendChild(run);
	const status = document.createElement("div"); status.className = "gjj-b13-status"; status.textContent = "请选择或连接视频"; node.__gjjB13Status = status; root.append(tools, status, file);
	file.onchange = async () => { const picked = file.files?.[0]; if (!picked) return; try { status.textContent = "正在导入视频..."; await upload(node, picked); } catch (error) { status.textContent = error?.message || "导入失败"; } finally { file.value = ""; } };
	const dom = node.addDOMWidget(PANEL_WIDGET, "HTML", root, { serialize: false, hideOnZoom: false }); dom.computeSize = (width) => [Math.max(310, Number(width || 330) - 20), 76]; ensurePreview(node); syncLinkState(node); node.setSize?.([Math.max(330, Number(node.size?.[0] || 330)), 120]);
	const selectedItem = selectedVideoItem(node); if (selectedItem && !mediaLinked(node)) queueMicrotask(() => addSegmentPreview(node, [selectedItem], 1, 1, "source_video"));
	if (isReferenceUpscaler(node)) queueMicrotask(() => absorbNativeReferenceLink(node));
	const oldConnections = node.onConnectionsChange; node.onConnectionsChange = function (...args) {
		const result = oldConnections?.apply(this, args);
		queueMicrotask(() => {
			absorbNativeReferenceLink(this);
			syncLinkState(this);
		});
		return result;
	};
	const oldRemoved = node.onRemoved; node.onRemoved = function (...args) { NODES.delete(this); closePopup(this); const preview = this.__gjjB13Preview; preview?.video?.pause?.(); if (preview?.video) preview.video.src = ""; return oldRemoved?.apply(this, args); };
}

app.registerExtension({
	name: "GJJ.Bernini13BLongVideoWatermarkRemover",
	beforeRegisterNodeDef(nodeType, nodeData) {
		pruneReferenceTransportInputs(nodeData);
		if (nodeData?.name === MINIMAX_NODE) {
			patchReferenceCanvas();
			patchReferenceGraphToPrompt();
			const created = nodeType.prototype.onNodeCreated;
			nodeType.prototype.onNodeCreated = function (...args) { const result = created?.apply(this, args); queueMicrotask(() => { patchReferenceCanvas(); patchReferenceGraphToPrompt(); normalizeReferenceLinks(this); absorbNativeReferenceLink(this); }); return result; };
			const configured = nodeType.prototype.onConfigure;
			nodeType.prototype.onConfigure = function (...args) { const result = configured?.apply(this, args); queueMicrotask(() => { normalizeReferenceLinks(this); absorbNativeReferenceLink(this); }); return result; };
			const connections = nodeType.prototype.onConnectionsChange;
			nodeType.prototype.onConnectionsChange = function (...args) { const result = connections?.apply(this, args); queueMicrotask(() => absorbNativeReferenceLink(this)); return result; };
			return;
		}
		if (!NODE_NAMES.has(nodeData?.name)) return;
		const created = nodeType.prototype.onNodeCreated; nodeType.prototype.onNodeCreated = function (...args) { const result = created?.apply(this, args); queueMicrotask(() => setup(this)); return result; };
		const configured = nodeType.prototype.onConfigure; nodeType.prototype.onConfigure = function (...args) { const result = configured?.apply(this, args); queueMicrotask(() => { if (isReferenceUpscaler(this)) normalizeReferenceLinks(this); for (const item of this.widgets || []) hideWidget(item); syncLinkState(this); syncKeepModelButton(this); syncSegmentationButton(this); }); return result; };
		const executed = nodeType.prototype.onExecuted; nodeType.prototype.onExecuted = function (message) { const result = executed?.apply(this, arguments); const images = message?.gjj_images || message?.ui?.gjj_images; if (images) addSegmentPreview(this, images, message?.segment_count?.[0] || 1, message?.segment_count?.[0] || 1, message?.preview_label?.[0] || "final_video"); return result; };
	},
});

api.addEventListener("gjj_bernini_segment_preview", (event) => {
	const detail = event.detail || {}; for (const node of NODES) if (String(node.id) === String(detail.node)) addSegmentPreview(node, detail.images, detail.segment, detail.total, detail.label);
});

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event.detail || {}; for (const node of NODES) if (String(node.id) === String(detail.node) && node.__gjjB13Status) node.__gjjB13Status.textContent = String(detail.text || "");
});
