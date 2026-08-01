import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const NODE_NAME = "GJJ_Bernini13BLongVideoWatermarkRemover";
const MEDIA_INPUT = "media";
const SELECTED_VIDEO = "selected_video";
const PANEL_WIDGET = "gjj_bernini13b_watermark_panel";
const PREVIEW_WIDGET = "gjj_bernini13b_watermark_preview";
const UPLOAD_API = "/gjj/video_segment_queue/upload";
const REMEMBERED_LINK = "gjj_bernini13b_remembered_media_link";
const NODES = new Set();
let outsideReady = false;

const GROUPS = [
	{ key: "model", icon: "🧠", title: "模型", fields: ["keep_model"] },
	{ key: "prompt", icon: "📒", title: "提示词", fields: ["prompt", "negative_prompt"] },
	{ key: "sampling", icon: "⚙️", title: "分段与采样", fields: ["segment_frames", "steps", "cfg", "seed", "sampler_name", "scheduler", "denoise", "frame_rate", "filename_prefix", "format_name"] },
];

function widget(node, name) { return node?.widgets?.find((item) => item?.name === name); }
function mediaInputIndex(node) { return node?.inputs?.findIndex((item) => item?.name === MEDIA_INPUT) ?? -1; }
function mediaLinked(node) { const i = mediaInputIndex(node); return i >= 0 && node.inputs[i]?.link != null; }
function dirty(node) { node?.setDirtyCanvas?.(true, true); app.graph?.setDirtyCanvas?.(true, true); app.graph?.change?.(); }

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
	dirty(node);
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
		.gjj-b13-tools{display:flex;align-items:center;justify-content:center;gap:6px}.gjj-b13-tools button{width:40px;height:31px;border:1px solid #40545d;border-radius:8px;background:#172229;color:#eefaff;font-size:17px;cursor:pointer}.gjj-b13-tools button:disabled{filter:grayscale(1);opacity:.34;cursor:not-allowed}.gjj-b13-tools button.on{background:#205045;border-color:#5eead4}.gjj-b13-tools .link{display:none;background:#2b4052;border-color:#65a8d5}.gjj-b13-tools .link.show{display:block}.gjj-b13-tools .link.detached{background:#5a3d19;border-color:#e5a54b}
		.gjj-b13-status{padding:5px 8px;border:1px solid #30464e;border-radius:6px;background:#0d171b;color:#a9bdc4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.gjj-b13-popup{position:fixed;z-index:100005;width:min(450px,calc(100vw - 28px));max-height:calc(100vh - 28px);overflow:auto;padding:12px;border:1px solid #49616a;border-radius:11px;background:#10191e;color:#deeaed;box-shadow:0 18px 55px #000b;font:12px/1.4 sans-serif;box-sizing:border-box}.gjj-b13-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px;font-weight:800;font-size:14px}.gjj-b13-head button{border:0;background:transparent;color:#aabac0;font-size:20px;cursor:pointer}.gjj-b13-row{display:grid;grid-template-columns:128px minmax(0,1fr);gap:8px;align-items:center;margin:8px 0}.gjj-b13-row input,.gjj-b13-row textarea,.gjj-b13-row select{width:100%;box-sizing:border-box;padding:6px 7px;border:1px solid #344a53;border-radius:6px;background:#0b1418;color:#e7f0f2}.gjj-b13-row textarea{min-height:76px;resize:vertical}.gjj-b13-row input[type=checkbox]{width:18px}
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

function control(node, name) {
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
		element = document.createElement("input"); element.type = "checkbox"; element.checked = item.value;
		element.onchange = () => setValue(node, name, element.checked);
	} else if (typeof item.value === "number") {
		element = document.createElement("input"); element.type = "number"; element.value = item.value;
		if (item.options?.min != null) element.min = item.options.min; if (item.options?.max != null) element.max = item.options.max; if (item.options?.step != null) element.step = item.options.step;
		element.onchange = () => setValue(node, name, Number(element.value));
	} else {
		element = document.createElement(name.includes("prompt") ? "textarea" : "input"); element.value = String(item.value ?? "");
		element.onchange = () => setValue(node, name, element.value);
	}
	return element;
}

function modelEntries(node) {
	return [
		["model_name", "Bernini 1.3B 模型", "models/diffusion_models", "🟣"],
		["clip_name", "UMT5 XXL", "models/text_encoders", "🟡"],
		["vae_name", "Wan VAE", "models/vae", "🔴"],
	].map(([name, label, folder, icon]) => {
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
	for (const name of group.fields) {
		const item = widget(node, name); const input = control(node, name); if (!item || !input) continue;
		const row = document.createElement("label"); row.className = "gjj-b13-row"; const label = document.createElement("span"); label.textContent = item.options?.display_name || name; row.append(label, input); popup.appendChild(row);
	}
	if (group.key === "model") popup.appendChild(GJJ_Utils.createModelTreeView({ node, entries: modelEntries(node), refresh: () => dirty(node), onApply: () => dirty(node) }));
	document.body.appendChild(popup); node.__gjjB13Popup = popup; node.__gjjB13Active = group.key; node.__gjjB13GroupButtons.get(group.key)?.classList.add("on");
	const rect = anchor.getBoundingClientRect(); let left = Math.min(rect.left, window.innerWidth - Math.min(450, window.innerWidth - 28) - 14); left = Math.max(14, left);
	popup.style.left = `${left}px`; popup.style.top = `${rect.bottom + 7}px`; popup.style.maxHeight = `${Math.max(120, window.innerHeight - rect.bottom - 21)}px`;
}

function rememberAndDisconnect(node) {
	const index = mediaInputIndex(node); if (index < 0) return;
	const linkId = node.inputs[index]?.link; const link = app.graph?.links?.[linkId];
	if (link) { node.properties ||= {}; node.properties[REMEMBERED_LINK] = { origin_id: link.origin_id, origin_slot: link.origin_slot }; }
	node.disconnectInput?.(index); syncLinkState(node); dirty(node);
}

function restoreRemembered(node) {
	const saved = node.properties?.[REMEMBERED_LINK]; const index = mediaInputIndex(node); if (!saved || index < 0) return;
	const origin = app.graph?.getNodeById?.(saved.origin_id); if (!origin?.connect) return;
	origin.connect(saved.origin_slot, node, index); syncLinkState(node); dirty(node);
}

function syncLinkState(node) {
	const linked = mediaLinked(node); const remembered = Boolean(node.properties?.[REMEMBERED_LINK]);
	if (node.__gjjB13Folder) { node.__gjjB13Folder.disabled = linked; node.__gjjB13Folder.title = linked ? "已有 VIDEO/IMAGE 链接，内部视频选择已禁用" : "打开本地视频"; }
	if (node.__gjjB13Link) { node.__gjjB13Link.classList.toggle("show", linked || remembered); node.__gjjB13Link.classList.toggle("detached", !linked && remembered); node.__gjjB13Link.title = linked ? "断开并记住上游接口" : "恢复记住的上游接口"; }
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
	for (const item of node.widgets || []) hideWidget(item);
	const root = document.createElement("div"); root.className = "gjj-b13-wmr"; protect(root); node.__gjjB13Root = root;
	const tools = document.createElement("div"); tools.className = "gjj-b13-tools"; const file = document.createElement("input"); file.type = "file"; file.accept = "video/*,.mp4,.mov,.m4v,.webm,.avi,.mkv,.wmv,.flv,.mpeg,.mpg"; file.style.display = "none";
	const folder = document.createElement("button"); folder.textContent = "📁"; folder.onclick = () => { if (!folder.disabled) file.click(); }; node.__gjjB13Folder = folder; tools.appendChild(folder);
	const link = document.createElement("button"); link.textContent = "🔗"; link.className = "link"; link.onclick = () => mediaLinked(node) ? rememberAndDisconnect(node) : restoreRemembered(node); node.__gjjB13Link = link; tools.appendChild(link);
	node.__gjjB13GroupButtons = new Map(); for (const group of GROUPS) { const button = document.createElement("button"); button.textContent = group.icon; button.title = group.title; button.onclick = () => openPopup(node, group, button); node.__gjjB13GroupButtons.set(group.key, button); tools.appendChild(button); }
	const run = document.createElement("button"); run.textContent = "▶️"; run.title = "只运行当前节点"; run.onclick = async () => { run.disabled = true; try { await queueOnlyCurrentNode(node); } finally { run.disabled = false; } }; tools.appendChild(run);
	const status = document.createElement("div"); status.className = "gjj-b13-status"; status.textContent = "请选择或连接视频"; node.__gjjB13Status = status; root.append(tools, status, file);
	file.onchange = async () => { const picked = file.files?.[0]; if (!picked) return; try { status.textContent = "正在导入视频..."; await upload(node, picked); } catch (error) { status.textContent = error?.message || "导入失败"; } finally { file.value = ""; } };
	const dom = node.addDOMWidget(PANEL_WIDGET, "HTML", root, { serialize: false, hideOnZoom: false }); dom.computeSize = (width) => [Math.max(310, Number(width || 330) - 20), 76]; ensurePreview(node); syncLinkState(node); node.setSize?.([Math.max(330, Number(node.size?.[0] || 330)), 120]);
	const selectedItem = selectedVideoItem(node); if (selectedItem && !mediaLinked(node)) queueMicrotask(() => addSegmentPreview(node, [selectedItem], 1, 1, "source_video"));
	const oldConnections = node.onConnectionsChange; node.onConnectionsChange = function (...args) { const result = oldConnections?.apply(this, args); queueMicrotask(() => syncLinkState(this)); return result; };
	const oldRemoved = node.onRemoved; node.onRemoved = function (...args) { NODES.delete(this); closePopup(this); const preview = this.__gjjB13Preview; preview?.video?.pause?.(); if (preview?.video) preview.video.src = ""; return oldRemoved?.apply(this, args); };
}

app.registerExtension({
	name: "GJJ.Bernini13BLongVideoWatermarkRemover",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) return;
		const created = nodeType.prototype.onNodeCreated; nodeType.prototype.onNodeCreated = function (...args) { const result = created?.apply(this, args); queueMicrotask(() => setup(this)); return result; };
		const configured = nodeType.prototype.onConfigure; nodeType.prototype.onConfigure = function (...args) { const result = configured?.apply(this, args); queueMicrotask(() => { for (const item of this.widgets || []) hideWidget(item); syncLinkState(this); }); return result; };
		const executed = nodeType.prototype.onExecuted; nodeType.prototype.onExecuted = function (message) { const result = executed?.apply(this, arguments); const images = message?.gjj_images || message?.ui?.gjj_images; if (images) addSegmentPreview(this, images, message?.segment_count?.[0] || 1, message?.segment_count?.[0] || 1, message?.preview_label?.[0] || "final_video"); return result; };
	},
});

api.addEventListener("gjj_bernini_segment_preview", (event) => {
	const detail = event.detail || {}; for (const node of NODES) if (String(node.id) === String(detail.node)) addSegmentPreview(node, detail.images, detail.segment, detail.total, detail.label);
});

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event.detail || {}; for (const node of NODES) if (String(node.id) === String(detail.node) && node.__gjjB13Status) node.__gjjB13Status.textContent = String(detail.text || "");
});
