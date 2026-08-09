import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const NODE_NAME = "GJJ_WanAnimate2LongVideoAIO";
const TOOLBAR = "gjj_wan_animate2_toolbar";
const PREVIEW = "gjj_wan_animate2_preview";
const PROGRESS = "gjj_wan_animate2_progress";
const LORA_DATA = "lora_data";
const PARAMS_PROPERTY = "gjj_wan_animate2_named_params";
const KEEP = new Set(["prompt", TOOLBAR, PREVIEW, PROGRESS]);
const GROUPS = {
	size: { title: "📐 尺寸与分段", fields: ["width", "height", "segment_frames", "overlap_frames"] },
	prompt: { title: "📒 提示词", fields: ["negative_prompt", "pose_prompt"] },
	model: { title: "🧠 模型", fields: ["unet_name", "lora_name", "clip_name", "clip_vision_name", "vae_name"] },
	settings: { title: "⚙️ 生成参数", fields: ["steps", "cfg", "seed", "pose_strength", "reference_strength", "filename_prefix", "segment_frames", "overlap_frames", "sampler_name", "scheduler_name"] },
};
const BUTTONS = [
	["video", "🎬", "打开动作视频"], ["image", "👤", "打开人物参考图"], ["link", "🔗", "断开/恢复上游链接"],
	["size", "📐", "尺寸与分段"], ["prompt", "📒", "负向/动作提示词"],
	["model", "🧠", "模型"], ["settings", "⚙️", "生成参数"], ["run", "▶️", "只执行当前节点"],
];

function widget(node, name) {
	return (node.widgets || []).find((item) => String(item?.name || "") === name);
}

function savedLinks(node) {
	return Array.isArray(node?.properties?.gjj_wan_animate2_saved_links) ? node.properties.gjj_wan_animate2_saved_links : [];
}

function inputIndex(node, name) {
	return (node.inputs || []).findIndex((input) => String(input?.name || "") === name);
}

function upstreamLink(node, name) {
	const index = inputIndex(node, name);
	if (index < 0) return null;
	const linkId = node.inputs?.[index]?.link;
	const active = linkId == null ? null : (app.graph?.links?.[linkId] || app.graph?.links?.get?.(linkId));
	if (active) return { inputIndex: index, originId: active.origin_id, originSlot: active.origin_slot };
	return savedLinks(node).find((link) => Number(link?.inputIndex) === index) || null;
}

function hasActiveInputLink(node, name) {
	const index = inputIndex(node, name);
	return index >= 0 && node.inputs?.[index]?.link != null;
}

function upstreamMediaItem(node, kind) {
	const internalName = kind === "video" ? "selected_video_json" : "selected_reference_json";
	try {
		const selected = JSON.parse(String(widget(node, internalName)?.value || "[]"));
		if (Array.isArray(selected) && selected[0]?.filename) return selected[0];
	} catch (_) {}
	const name = kind === "video" ? "action_video" : "reference_image";
	const link = upstreamLink(node, name);
	const origin = link ? app.graph?.getNodeById?.(link.originId) : null;
	if (!origin) return null;
	const nativePreview = (origin.imgs || []).find((item) => String(item?.src || "").trim());
	if (nativePreview?.src) return { preview_url: nativePreview.src, filename: String(nativePreview.name || nativePreview.filename || origin.title || kind), type: "temp" };
	const names = kind === "video" ? ["file", "video", "video_path"] : ["image", "file", "image_path"];
	const source = (origin.widgets || []).find((item) => names.includes(String(item?.name || "").toLowerCase()));
	let path = String(source?.value || "").trim().replace(/\s*\[(?:input|output|temp)\]\s*$/i, "").replaceAll("\\", "/");
	if (!path) return null;
	const parts = path.split("/").filter(Boolean);
	const filename = parts.pop() || path;
	return { filename, subfolder: parts.join("/"), type: "input" };
}

async function chooseInternalMedia(node, kind) {
	const input = document.createElement("input"); input.type = "file"; input.accept = kind === "video" ? "video/*" : "image/*"; input.style.display = "none";
	input.onchange = async () => {
		const file = input.files?.[0];
		if (!file) { input.remove(); return; }
		try {
			const form = new FormData();
			if (kind === "video") form.append("video", file, file.name);
			else { form.append("image", file, file.name); form.append("type", "input"); form.append("overwrite", "true"); }
			const response = await api.fetchApi(kind === "video" ? "/gjj/upload_video" : "/upload/image", { method: "POST", body: form });
			const data = await response.json();
			if (!response.ok) throw new Error(data?.error || `上传失败：${response.status}`);
			const item = kind === "video" ? (Array.isArray(data?.videos) ? data.videos[0] : null) : data;
			if (!item?.filename && !item?.name) throw new Error("上传接口没有返回媒体文件。 ");
			const normalized = { filename: String(item.filename || item.name), subfolder: String(item.subfolder || ""), type: String(item.type || "input") };
			setWidgetValue(node, kind === "video" ? "selected_video_json" : "selected_reference_json", JSON.stringify([normalized]));
			updateResourceButtons(node);
		} catch (error) { alert(error?.message || "媒体上传失败"); }
		finally { input.remove(); }
	};
	document.body.appendChild(input); input.click();
}

function hideMediaTooltip(node) {
	const tooltip = node?.__gjjWanAnimate2MediaTooltip;
	if (!tooltip) return;
	tooltip.querySelector("video")?.pause?.(); tooltip.remove(); node.__gjjWanAnimate2MediaTooltip = null;
}

function showMediaTooltip(node, button, kind) {
	const item = upstreamMediaItem(node, kind);
	if (!item?.filename && !item?.preview_url) return;
	hideMediaTooltip(node);
	const tooltip = document.createElement("div");
	tooltip.style.cssText = "position:fixed;z-index:1000002;width:230px;padding:6px;border:1px solid #4b6270;border-radius:8px;background:#0b1216;box-shadow:0 10px 32px rgba(0,0,0,.65);color:#eaf4f7;font:12px system-ui,sans-serif;pointer-events:none;";
	const media = document.createElement(kind === "video" ? "video" : "img");
	media.src = item.preview_url || previewUrl(item); media.style.cssText = "display:block;width:100%;max-height:260px;object-fit:contain;border-radius:5px;background:#05090b;";
	if (kind === "video") { media.muted = true; media.loop = true; media.autoplay = true; media.playsInline = true; media.preload = "metadata"; }
	const caption = document.createElement("div"); caption.textContent = `${item.subfolder ? `${item.subfolder}/` : ""}${item.filename || "上游预览"}`; caption.style.cssText = "margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
	tooltip.append(media, caption); document.body.appendChild(tooltip); node.__gjjWanAnimate2MediaTooltip = tooltip;
	const rect = button.getBoundingClientRect(); const tipRect = tooltip.getBoundingClientRect();
	let left = Math.max(8, Math.min(window.innerWidth - tipRect.width - 8, rect.left + rect.width / 2 - tipRect.width / 2));
	let top = rect.bottom + 7; if (top + tipRect.height > window.innerHeight - 8) top = rect.top - tipRect.height - 7;
	tooltip.style.left = `${left}px`; tooltip.style.top = `${Math.max(8, top)}px`; media.play?.().catch(() => {});
}

function updateResourceButtons(node) {
	for (const [kind, inputName] of [["video", "action_video"], ["image", "reference_image"]]) {
		const button = node.__gjjWanAnimate2Buttons?.[kind]; if (!button) continue;
		const linked = hasActiveInputLink(node, inputName);
		let hasInternal = false;
		try { hasInternal = JSON.parse(String(widget(node, kind === "video" ? "selected_video_json" : "selected_reference_json")?.value || "[]")).some((item) => item?.filename); } catch (_) {}
		button.dataset.linked = linked ? "1" : "0";
		button.style.opacity = linked ? "0.38" : "1";
		button.style.filter = linked ? "grayscale(1)" : "none";
		button.style.cursor = linked ? "not-allowed" : "pointer";
		button.style.background = !linked && hasInternal ? (kind === "video" ? "#193c53" : "#392b57") : "#1c2b32";
		button.style.borderColor = !linked && hasInternal ? (kind === "video" ? "#39a9e0" : "#9a71dd") : "#50636c";
	}
}

function ensureMediaInputsFirst(node) {
	if (!Array.isArray(node.inputs)) return;
	const media = [];
	for (const name of ["reference_image", "action_video"]) {
		const index = node.inputs.findIndex((input) => String(input?.name || "") === name);
		if (index >= 0) media.push(node.inputs.splice(index, 1)[0]);
	}
	node.inputs.unshift(...media);
}

function openUpstreamInput(node, name) {
	const link = upstreamLink(node, name);
	const origin = link ? app.graph?.getNodeById?.(link.originId) : null;
	if (!origin) {
		alert(name === "action_video" ? "请先连接动作视频加载节点。" : "请先连接人物参考图加载节点。");
		return;
	}
	app.canvas?.selectNode?.(origin);
	app.canvas?.centerOnNode?.(origin);
	const upload = (origin.widgets || []).find((item) => String(item?.name || "").toLowerCase() === "upload");
	if (typeof upload?.callback === "function") upload.callback();
}

function toggleUpstreamLinks(node) {
	node.properties ||= {};
	const active = [];
	for (let index = 0; index < (node.inputs || []).length; index += 1) {
		const linkId = node.inputs[index]?.link;
		if (linkId == null) continue;
		const link = app.graph?.links?.[linkId] || app.graph?.links?.get?.(linkId);
		if (link) active.push({ inputIndex: index, originId: link.origin_id, originSlot: link.origin_slot });
	}
	if (active.length) {
		for (const link of active) node.disconnectInput?.(link.inputIndex);
		node.properties.gjj_wan_animate2_saved_links = active;
	} else {
		for (const link of savedLinks(node)) {
			const origin = app.graph?.getNodeById?.(link.originId);
			origin?.connect?.(link.originSlot, node, link.inputIndex);
		}
		node.properties.gjj_wan_animate2_saved_links = [];
	}
	app.graph?.setDirtyCanvas?.(true, true);
	updateResourceButtons(node);
}

function hideWidgets(node) {
	for (const item of node.widgets || []) {
		if (KEEP.has(String(item?.name || ""))) {
			item.hidden = false;
			continue;
		}
		item.hidden = true;
		item.type = "hidden";
		item.serialize = true;
		item.computeSize = () => [0, -4];
	}
	const prompt = widget(node, "prompt");
	if (prompt) {
		prompt.hidden = false;
		prompt.serialize = true;
		prompt.label = "正向提示词";
		prompt.computeSize = (width) => [Math.max(260, Number(width || 260)), 72];
		prompt.getHeight = () => 72;
	}
}

function previewUrl(item) {
	const query = new URLSearchParams({ filename: String(item?.filename || ""), type: String(item?.type || "output") });
	if (item?.subfolder) query.set("subfolder", String(item.subfolder));
	return api.apiURL(`/view?${query.toString()}`);
}

function previewMediaHeight(node, width = null) {
	const item = node?.properties?.gjj_wan_animate2_final_video || {};
	const sourceWidth = Math.max(1, Number(item.width || 16));
	const sourceHeight = Math.max(1, Number(item.height || 9));
	const contentWidth = Math.max(260, Number(width || node?.size?.[0] || 360) - 32);
	return Math.max(120, Math.round(contentWidth * sourceHeight / sourceWidth));
}

function previewPanelHeight(node, width = null) {
	return previewMediaHeight(node, width) + 26;
}

function updatePreview(node) {
	const panel = node.__gjjWanAnimate2PreviewPanel;
	const item = node?.properties?.gjj_wan_animate2_final_video;
	if (!panel) return;
	panel.replaceChildren();
	if (!item?.filename) { panel.style.display = "none"; return; }
	panel.style.display = "block";
	const video = document.createElement("video");
	video.controls = true; video.autoplay = true; video.loop = true; video.muted = true; video.defaultMuted = true; video.playsInline = true; video.preload = "auto"; video.src = previewUrl(item);
	video.style.cssText = `display:block;width:100%;height:${previewMediaHeight(node)}px;object-fit:contain;background:#05090b;border:1px solid #30434d;border-radius:6px;box-sizing:border-box;`;
	video.onloadedmetadata = () => {
		video.muted = true; video.play?.().catch(() => {});
		if (!video.videoWidth || !video.videoHeight) return;
		const current = node.properties?.gjj_wan_animate2_final_video || {};
		if (Number(current.width) === video.videoWidth && Number(current.height) === video.videoHeight) return;
		node.properties.gjj_wan_animate2_final_video = { ...current, width: video.videoWidth, height: video.videoHeight };
		stabilize(node);
	};
	const label = document.createElement("div"); label.textContent = `${item.subfolder ? `${item.subfolder}/` : ""}${item.filename}`; label.style.cssText = "height:22px;line-height:22px;text-align:center;color:#cfe1e8;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
	panel.append(video, label);
}

function addPreview(node) {
	const item = node?.properties?.gjj_wan_animate2_final_video;
	if (!item?.filename || typeof node.addDOMWidget !== "function") return;
	if (node.__gjjWanAnimate2PreviewWidget && (node.widgets || []).includes(node.__gjjWanAnimate2PreviewWidget)) { updatePreview(node); return; }
	const panel = document.createElement("div"); panel.style.cssText = "width:100%;box-sizing:border-box;padding-top:4px;pointer-events:auto;";
	const preview = node.addDOMWidget(PREVIEW, "HTML", panel, { serialize: false, getValue: () => "", setValue: () => {}, getHeight: () => previewPanelHeight(node) });
	preview.serialize = false; preview.computeSize = (width) => [Math.max(300, Number(width || 300)), previewPanelHeight(node, width)]; preview.getHeight = () => previewPanelHeight(node);
	node.__gjjWanAnimate2PreviewWidget = preview; node.__gjjWanAnimate2PreviewPanel = panel;
	const promptIndex = (node.widgets || []).findIndex((item) => item.name === "prompt");
	const previewIndex = node.widgets.indexOf(preview);
	if (promptIndex >= 0 && previewIndex >= 0 && previewIndex !== promptIndex + 1) { node.widgets.splice(previewIndex, 1); node.widgets.splice(promptIndex + 1, 0, preview); }
	updatePreview(node);
}

function addProgress(node) {
	if (node.__gjjWanAnimate2ProgressWidget || typeof node.addDOMWidget !== "function") return;
	const root = document.createElement("div"); root.style.cssText = "height:34px;padding:3px 0 4px;box-sizing:border-box;";
	const text = document.createElement("div"); text.textContent = ""; text.style.cssText = "height:16px;line-height:16px;color:#aebfc6;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
	const track = document.createElement("div"); track.style.cssText = "height:7px;border:1px solid #314750;border-radius:999px;background:#091115;overflow:hidden;";
	const fill = document.createElement("div"); fill.style.cssText = "width:0%;height:100%;border-radius:999px;background:linear-gradient(90deg,#15a9cf,#43dd9b);transition:width .18s ease;";
	track.appendChild(fill); root.append(text, track);
	const progress = node.addDOMWidget(PROGRESS, "HTML", root, { serialize: false, getValue: () => "", setValue: () => {}, getHeight: () => 34 });
	progress.serialize = false; progress.computeSize = (width) => [Math.max(260, Number(width || 260)), 34]; progress.getHeight = () => 34;
	node.__gjjWanAnimate2ProgressWidget = progress; node.__gjjWanAnimate2Progress = { text, fill };
	const promptIndex = (node.widgets || []).findIndex((item) => item.name === "prompt");
	const progressIndex = node.widgets.indexOf(progress);
	if (promptIndex >= 0 && progressIndex >= 0) { node.widgets.splice(progressIndex, 1); node.widgets.splice(promptIndex + 1, 0, progress); }
}

function updateProgress(node, detail) {
	const message = String(detail?.text || "").trim();
	if (!message && !detail?.preview?.filename) return;
	addProgress(node);
	const state = node.__gjjWanAnimate2Progress; if (!state) return;
	const value = Math.max(0, Math.min(1, Number(detail?.progress ?? 0)));
	state.text.textContent = `${message || "预览已更新"}  ${Math.round(value * 100)}%`;
	state.fill.style.width = `${value * 100}%`;
	if (detail?.preview?.filename) {
		node.properties ||= {}; node.properties.gjj_wan_animate2_final_video = { ...detail.preview, transient: true };
		addPreview(node); updatePreview(node);
	}
	stabilize(node);
}

function styleInput(element) {
	element.style.cssText = "width:100%;box-sizing:border-box;background:#172126;color:#edf5f7;border:1px solid #40545e;border-radius:5px;padding:7px 8px;outline:none;";
}

function editorFor(item, forceMultiline = false) {
	const values = item?.options?.values;
	if (String(item?.name || "") === "segment_frames") {
		const wrapper = document.createElement("div"); wrapper.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) 64px;gap:10px;align-items:center;";
		const range = document.createElement("input"); range.type = "range"; range.min = "5"; range.max = "241"; range.step = "4"; range.style.cssText = "width:100%;accent-color:#19b7d0;cursor:pointer;";
		const output = document.createElement("output"); output.style.cssText = "padding:7px 8px;border:1px solid #40545e;border-radius:5px;background:#172126;color:#edf5f7;text-align:center;font-weight:800;";
		const align = (raw) => Math.max(5, Math.min(241, 5 + Math.round((Number(raw || 5) - 5) / 4) * 4));
		const update = (raw) => { const value = align(raw); range.value = String(value); output.value = output.textContent = String(value); };
		Object.defineProperty(wrapper, "value", { get: () => Number(range.value), set: (value) => update(value), configurable: true });
		range.oninput = () => update(range.value); update(item.value ?? 81); wrapper.append(range, output); return wrapper;
	}
	let input;
	if (Array.isArray(values)) {
		input = document.createElement("select");
		for (const value of values) {
			const option = document.createElement("option");
			option.value = String(value); option.textContent = String(value);
			input.appendChild(option);
		}
		input.value = String(item.value ?? "");
	} else if (typeof item?.value === "number") {
		input = document.createElement("input"); input.type = "number";
		for (const key of ["min", "max", "step"]) if (item.options?.[key] != null) input[key] = item.options[key];
		input.value = String(item.value);
	} else if (forceMultiline || item?.options?.multiline) {
		input = document.createElement("textarea"); input.rows = 6; input.value = String(item.value ?? "");
	} else {
		input = document.createElement("input"); input.type = "text"; input.value = String(item?.value ?? "");
	}
	styleInput(input);
	if (input.tagName === "TEXTAREA") { input.style.minHeight = "120px"; input.style.resize = "vertical"; input.style.lineHeight = "1.5"; }
	return input;
}

function setWidgetValue(node, name, value) {
	const item = widget(node, name);
	if (!item) return;
	item.value = value;
	item.callback?.(value);
	item.onChange?.(value);
	app.graph?.setDirtyCanvas?.(true, true);
}

function createSizePanel(node) {
	const host = document.createElement("div");
	const buttonStyle = "min-height:40px;border:1px solid #415861;border-radius:8px;background:#111b20;color:#dbe6e7;font-weight:800;font-size:14px;cursor:pointer;";
	const activate = (button, active, green = false) => {
		button.style.background = active ? (green ? "#12964d" : "#0d8fb0") : "#111b20";
		button.style.borderColor = active ? (green ? "#27dda0" : "#19d8df") : "#415861";
		button.style.color = active ? "#fff" : "#dbe6e7";
	};
	const makeButton = (label, action) => {
		const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.style.cssText = buttonStyle; button.onclick = action; return button;
	};
	const sourceValues = ["首图尺寸", "视频尺寸", "画板尺寸", "百万像素"];
	const tabs = document.createElement("div"); tabs.style.cssText = "display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:4px 0 14px;";
	const sourceButtons = sourceValues.map((value) => makeButton(value, () => { setWidgetValue(node, "size_source", value); sync(); })); tabs.append(...sourceButtons);
	const choiceGroups = [];
	const choiceRow = (name, icon, values) => {
		const row = document.createElement("div"); row.style.cssText = `display:grid;grid-template-columns:42px repeat(${values.length},1fr);gap:8px;margin:8px 0;`;
		const marker = document.createElement("span"); marker.textContent = icon; marker.style.cssText = "display:grid;place-items:center;font-size:20px;";
		const buttons = values.map((value) => makeButton(value, () => { setWidgetValue(node, name, value); sync(); }));
		row.append(marker, ...buttons); choiceGroups.push({ name, values, buttons }); return row;
	};
	const fitRow = choiceRow("resize_fit_mode", "🧲", ["拉伸", "补边", "留边", "裁剪"]);
	const anchorRow = choiceRow("resize_anchor", "📍", ["上", "下", "左", "右", "中"]);
	const ratios = ["21:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"];
	const ratioSources = ["视频", "首图"];
	const ratioRow = document.createElement("div"); ratioRow.style.cssText = "display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:4px;margin:12px 0;";
	const ratioSourceButtons = ratioSources.map((value) => { const button = makeButton(value, () => { setWidgetValue(node, "megapixel_ratio_source", value); sync(); }); button.style.minHeight = "38px"; button.style.fontSize = "11px"; button.style.padding = "4px 1px"; return button; });
	const ratioButtons = ratios.map((ratio) => { const button = makeButton(ratio, () => { setWidgetValue(node, "megapixel_ratio_source", "预设"); setWidgetValue(node, "megapixel_aspect", ratio); sync(); }); button.style.minHeight = "38px"; button.style.fontSize = "11px"; button.style.padding = "4px 1px"; return button; }); ratioRow.append(...ratioSourceButtons, ...ratioButtons);
	const mediaDimensions = {};
	const probeMediaDimensions = (kind) => {
		const item = upstreamMediaItem(node, kind);
		if (!item) { delete mediaDimensions[kind]; return; }
		const media = kind === "video" ? document.createElement("video") : new Image();
		const loaded = () => {
			const width = Number(kind === "video" ? media.videoWidth : media.naturalWidth);
			const height = Number(kind === "video" ? media.videoHeight : media.naturalHeight);
			if (width > 0 && height > 0) { mediaDimensions[kind] = { width, height }; sync(); }
		};
		if (kind === "video") media.onloadedmetadata = loaded; else media.onload = loaded;
		media.src = item.preview_url || previewUrl(item);
	};
	const dimensions = document.createElement("div");
	const dimensionControls = {};
	for (const [name, label] of [["width", "📐 宽度"], ["height", "📏 高度"]]) {
		const row = document.createElement("label"); row.style.cssText = "display:grid;grid-template-columns:70px minmax(0,1fr) 90px;gap:10px;align-items:center;margin:13px 0;font-weight:700;";
		const caption = document.createElement("span"); caption.textContent = label;
		const range = document.createElement("input"); range.type = "range"; range.min = "256"; range.max = "2048"; range.step = "16"; range.style.accentColor = "#19b7d0";
		const number = document.createElement("input"); number.type = "number"; number.min = range.min; number.max = range.max; number.step = range.step; styleInput(number); number.style.textAlign = "center";
		const apply = (raw) => { const next = Math.max(256, Math.min(2048, Math.round(Number(raw || 0) / 16) * 16)); setWidgetValue(node, name, next); sync(); };
		range.oninput = () => apply(range.value); number.onchange = () => apply(number.value); row.append(caption, range, number); dimensions.appendChild(row); dimensionControls[name] = { range, number };
	}
	const mpPanel = document.createElement("div");
	const mpRow = document.createElement("label"); mpRow.style.cssText = "display:grid;grid-template-columns:66px minmax(0,1fr) 90px;gap:10px;align-items:center;margin:16px 0;font-weight:700;";
	const mpLabel = document.createElement("span"); mpLabel.textContent = "📐 MP";
	const mpRange = document.createElement("input"); mpRange.type = "range"; mpRange.min = "0.2"; mpRange.max = "2"; mpRange.step = "0.1"; mpRange.style.accentColor = "#19b7d0";
	const mpNumber = document.createElement("input"); mpNumber.type = "number"; mpNumber.min = mpRange.min; mpNumber.max = mpRange.max; mpNumber.step = mpRange.step; styleInput(mpNumber); mpNumber.style.textAlign = "center";
	const applyMp = (raw) => { const next = Math.round(Math.max(0.2, Math.min(2, Number(raw) || 0.4)) * 10) / 10; setWidgetValue(node, "megapixels", next); sync(); };
	mpRange.oninput = () => applyMp(mpRange.value); mpNumber.onchange = () => applyMp(mpNumber.value); mpRow.append(mpLabel, mpRange, mpNumber); mpPanel.append(ratioRow, mpRow);
	const result = document.createElement("div"); result.style.cssText = "padding:10px;border:1px solid #31535b;border-radius:7px;background:#091215;color:#8fe1d5;text-align:center;font-weight:900;font-size:15px;";
	const sync = () => {
		const source = String(widget(node, "size_source")?.value || "画板尺寸"); sourceButtons.forEach((button, index) => activate(button, sourceValues[index] === source, true));
		for (const group of choiceGroups) group.buttons.forEach((button, index) => activate(button, String(widget(node, group.name)?.value || group.values[0]) === group.values[index]));
		const aspect = String(widget(node, "megapixel_aspect")?.value || "16:9");
		const ratioSource = String(widget(node, "megapixel_ratio_source")?.value || "预设");
		ratioSourceButtons.forEach((button, index) => activate(button, ratioSources[index] === ratioSource));
		ratioButtons.forEach((button, index) => activate(button, ratioSource === "预设" && ratios[index] === aspect));
		const mp = Math.max(0.2, Math.min(2, Number(widget(node, "megapixels")?.value || 0.4))); mpRange.value = mpNumber.value = String(mp);
		for (const [name, controls] of Object.entries(dimensionControls)) controls.range.value = controls.number.value = String(widget(node, name)?.value || (name === "width" ? 832 : 480));
		dimensions.style.display = source === "画板尺寸" ? "" : "none"; mpPanel.style.display = source === "百万像素" ? "" : "none";
		let width = Number(widget(node, "width")?.value || 832), height = Number(widget(node, "height")?.value || 480);
		if (source === "百万像素") {
			let [rw, rh] = aspect.split(":").map(Number);
			const selectedDimensions = ratioSource === "视频" ? mediaDimensions.video : ratioSource === "首图" ? mediaDimensions.image : null;
			if (selectedDimensions) { rw = selectedDimensions.width; rh = selectedDimensions.height; }
			const pixels = mp * 1024 * 1024; width = Math.max(256, Math.min(2048, Math.round(Math.sqrt(pixels * rw / rh) / 16) * 16)); height = Math.max(256, Math.min(2048, Math.round(Math.sqrt(pixels * rh / rw) / 16) * 16));
		}
		result.textContent = source === "首图尺寸" ? "实际尺寸：跟随人物参考图" : source === "视频尺寸" ? "实际尺寸：跟随动作视频" : `实际尺寸：${width} × ${height}`;
	};
	host.append(tabs, fitRow, anchorRow, dimensions, mpPanel, result); sync(); probeMediaDimensions("video"); probeMediaDimensions("image"); return host;
}

function modelSpecsFromNodeData(nodeData) {
	const sections = nodeData?.input || nodeData?.inputs || {};
	const result = new Map();
	for (const sectionName of ["required", "optional"]) {
		const section = sections?.[sectionName] || {};
		for (const [name, definition] of Object.entries(section)) {
			const options = Array.isArray(definition) ? (definition[1] || {}) : (definition || {});
			const folder = String(options.gjj_model_folder || options.model_folder || "").replace(/^models[\\/]/i, "");
			if (!folder) continue;
			result.set(name, {
				folder,
				defaultModel: String(options.gjj_default_model || options.default || ""),
				label: String(options.display_name || name),
				keywords: Array.isArray(options.gjj_model_keywords) ? options.gjj_model_keywords.map(String) : [],
				icon: String(options.gjj_model_icon || "🟣"),
			});
		}
	}
	return result;
}

function parameterSpecsFromNodeData(nodeData) {
	const sections = nodeData?.input || nodeData?.inputs || {};
	const result = new Map();
	for (const sectionName of ["required", "optional"]) {
		for (const [name, definition] of Object.entries(sections?.[sectionName] || {})) {
			if (!Array.isArray(definition)) continue;
			const type = definition[0];
			const options = definition[1] || {};
			const choices = Array.isArray(type) ? type.map(String) : [];
			const fallback = options.default !== undefined ? options.default : (choices[0] ?? undefined);
			result.set(name, { type, choices, fallback });
		}
	}
	return result;
}

function restoreNamedParameters(node, saved = null) {
	const specs = node.__gjjWanAnimate2ParameterSpecs instanceof Map ? node.__gjjWanAnimate2ParameterSpecs : new Map();
	const values = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
	for (const [name, spec] of specs) {
		const item = widget(node, name);
		if (!item) continue;
		let next = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : item.value;
		const numeric = spec.type === "INT" || spec.type === "FLOAT";
		if (numeric && !Number.isFinite(Number(next))) next = spec.fallback;
		else if (!numeric && (next === undefined || next === null)) next = spec.fallback;
		else if (spec.choices.length && !spec.choices.includes(String(next)) && !node.__gjjWanAnimate2ModelSpecs?.has?.(name)) next = spec.fallback;
		if (next === undefined) continue;
		item.value = numeric ? Number(next) : next;
	}
}

function namedParameters(node) {
	const result = {};
	const specs = node.__gjjWanAnimate2ParameterSpecs instanceof Map ? node.__gjjWanAnimate2ParameterSpecs : new Map();
	for (const name of specs.keys()) {
		const item = widget(node, name);
		if (item) result[name] = item.value;
	}
	return result;
}

function modelTreeEntries(node, group) {
	const specs = node.__gjjWanAnimate2ModelSpecs instanceof Map ? node.__gjjWanAnimate2ModelSpecs : new Map();
	return group.fields.map((name) => widget(node, name)).filter((item) => item).map((item) => {
		const options = item.options || {};
		const spec = specs.get(item.name) || {};
		const folder = String(spec.folder || options.gjj_model_folder || options.model_folder || "").replace(/^models[\\/]/i, "");
		const defaultModel = String(spec.defaultModel || options.gjj_default_model || options.default || item.value || "");
		return {
			widget: item.name,
			label: spec.label || item.label || item.name,
			folder: `models/${folder}`,
			models: Array.isArray(options.values) ? options.values : [],
			defaultModel,
			fallback: defaultModel,
			keywords: spec.keywords || [],
			icon: spec.icon || "🟣",
			autoSelect: true,
			floatingChoices: false,
			description: folder ? `候选模型来自 models/${folder}。` : "候选模型来自当前控件。",
		};
	});
}

function openDialog(node, group) {
	const overlay = document.createElement("div");
	overlay.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center;padding:20px;";
	const panel = document.createElement("div");
	panel.style.cssText = "width:min(620px,calc(100vw - 40px));max-height:calc(100vh - 50px);overflow:auto;background:#10191e;color:#e7f1f4;border:1px solid #40545e;border-radius:9px;padding:16px;box-shadow:0 18px 60px rgba(0,0,0,.5);";
	const title = document.createElement("div"); title.textContent = group.title; title.style.cssText = "font-size:17px;font-weight:700;margin-bottom:14px;";
	const grid = document.createElement("div"); grid.style.cssText = "display:grid;grid-template-columns:130px 1fr;gap:10px 12px;align-items:center;";
	const editors = [];
	if (group === GROUPS.size) {
		grid.style.display = "block";
		grid.appendChild(createSizePanel(node));
	} else if (group === GROUPS.model) {
		title.textContent = "🧠 所有模型树";
		const optimizationRow = document.createElement("div"); optimizationRow.style.cssText = "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:12px;";
		for (const [name, label] of [["preclean_resources", "预清理资源"], ["cache_clip", "缓存CLIP"], ["tiled_decode", "分块解码"]]) {
			const button = document.createElement("button"); button.type = "button"; button.style.cssText = "min-height:38px;border:1px solid #415861;border-radius:7px;color:#fff;font-weight:800;cursor:pointer;";
			const refresh = () => { const enabled = widget(node, name)?.value !== false; button.textContent = `${enabled ? "✓" : "○"} ${label}`; button.style.background = enabled ? "#0d8f70" : "#172126"; button.style.borderColor = enabled ? "#35d8ae" : "#415861"; };
			button.onclick = () => { setWidgetValue(node, name, widget(node, name)?.value === false); refresh(); }; refresh(); optimizationRow.appendChild(button);
		}
		const tree = GJJ_Utils.createModelTreeView({
			node,
			entries: modelTreeEntries(node, group),
			refresh: () => GJJ_Utils.refreshNode(node),
			onApply: () => GJJ_Utils.refreshNode(node),
		});
		tree.style.maxHeight = "min(520px,calc(100vh - 160px))";
		grid.style.display = "block";
		grid.append(optimizationRow, tree, createLoraPanel(node));
	} else {
		for (const name of group.fields) {
			const item = widget(node, name); if (!item) continue;
			const label = document.createElement("label"); label.textContent = item.label || name;
			const input = editorFor(item, group === GROUPS.prompt); editors.push([item, input]); grid.append(label, input);
		}
	}
	const actions = document.createElement("div"); actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:16px;";
	const cancel = document.createElement("button"); cancel.textContent = group === GROUPS.model ? "关闭" : "取消";
	const save = document.createElement("button"); save.textContent = "确定";
	for (const button of [cancel, save]) button.style.cssText = "border:1px solid #526975;border-radius:5px;background:#263943;color:white;padding:7px 16px;cursor:pointer;";
	const close = () => overlay.remove(); cancel.onclick = close; overlay.onclick = (event) => { if (event.target === overlay) close(); };
	save.onclick = () => {
		for (const [item, input] of editors) {
			let value = input.value;
			if (typeof item.value === "number") value = Number(value);
			item.value = value; item.callback?.(value); item.onChange?.(value);
		}
		app.graph?.setDirtyCanvas?.(true, true); close();
	};
	actions.append(cancel);
	if (group !== GROUPS.model) actions.append(save);
	panel.append(title, grid, actions); overlay.appendChild(panel); document.body.appendChild(overlay);
}

function addToolbar(node) {
	if (widget(node, TOOLBAR) || typeof node.addDOMWidget !== "function") return;
	const row = document.createElement("div"); row.style.cssText = "height:36px;display:flex;align-items:center;gap:4px;padding-top:2px;box-sizing:border-box;";
	node.__gjjWanAnimate2Buttons = {};
	for (const [key, icon, title] of BUTTONS) {
		const button = document.createElement("button"); button.textContent = icon; button.title = title;
		node.__gjjWanAnimate2Buttons[key] = button;
		button.style.cssText = "width:32px;height:30px;border:1px solid #50636c;border-radius:6px;background:#1c2b32;color:white;cursor:pointer;font-size:17px;";
		button.onclick = async (event) => {
			event.preventDefault(); event.stopPropagation();
			if ((key === "video" || key === "image") && button.dataset.linked === "1") return;
			if (key === "video") chooseInternalMedia(node, "video");
			else if (key === "image") chooseInternalMedia(node, "image");
			else if (key === "link") toggleUpstreamLinks(node);
			else if (key === "run") {
				try {
					const queued = await queueOnlyCurrentNode(node);
					if (!queued) throw new Error("当前 ComfyUI 前端不支持单节点执行");
				} catch (error) {
					console.error("[GJJ Wan Animate2 AIO] 执行当前节点失败：", error);
					alert(`执行当前节点失败：${error?.message || error}`);
				}
			}
			else openDialog(node, GROUPS[key]);
		};
		if (key === "video" || key === "image") {
			button.addEventListener("pointerenter", () => showMediaTooltip(node, button, key));
			button.addEventListener("pointerleave", () => hideMediaTooltip(node));
			button.addEventListener("pointerdown", () => hideMediaTooltip(node));
		}
		row.appendChild(button);
	}
	const toolbar = node.addDOMWidget(TOOLBAR, "HTML", row, { serialize: false, getValue: () => "", setValue: () => {}, getHeight: () => 36 });
	toolbar.serialize = false; toolbar.computeSize = (width) => [Math.max(260, Number(width || 260)), 36]; toolbar.getHeight = () => 36;
	const promptIndex = (node.widgets || []).findIndex((item) => item.name === "prompt");
	const toolbarIndex = node.widgets.indexOf(toolbar);
	if (promptIndex >= 0 && toolbarIndex > promptIndex) { node.widgets.splice(toolbarIndex, 1); node.widgets.splice(promptIndex, 0, toolbar); }
	updateResourceButtons(node);
}

function readLoraRows(node) {
	try {
		const rows = JSON.parse(String(widget(node, LORA_DATA)?.value || "[]"));
		return Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object").map((row) => ({
			name: String(row.name || ""),
			enabled: row.enabled !== false,
			strength: Number.isFinite(Number(row.strength)) ? Number(row.strength) : 1,
		})) : [];
	} catch (_) {
		return [];
	}
}

function normalizeLoraRows(rows) {
	const result = rows.filter((row, index) => String(row?.name || "").trim() || index === rows.length - 1);
	while (result.length > 1 && !String(result.at(-1)?.name || "").trim() && !String(result.at(-2)?.name || "").trim()) result.pop();
	if (!result.length || String(result.at(-1)?.name || "").trim()) result.push({ name: "", enabled: true, strength: 1 });
	return result;
}

function saveLoraRows(node) {
	const rows = normalizeLoraRows(node.__gjjWanAnimate2LoraRows || []);
	node.__gjjWanAnimate2LoraRows = rows;
	setWidgetValue(node, LORA_DATA, JSON.stringify(rows));
	app.graph?.setDirtyCanvas?.(true, true);
}

function renderLoraPanel(node, host = node.__gjjWanAnimate2LoraHost) {
	if (!host) return;
	node.__gjjWanAnimate2LoraRows = normalizeLoraRows(node.__gjjWanAnimate2LoraRows || readLoraRows(node));
	const rows = node.__gjjWanAnimate2LoraRows;
	const filter = String(node.__gjjWanAnimate2LoraFilter || "").trim().toLowerCase();
	const sourceWidget = widget(node, "lora_name");
	const choices = Array.isArray(sourceWidget?.options?.values) ? sourceWidget.options.values.map(String) : [];
	const visibleChoices = choices.filter((name) => !filter || name.toLowerCase().includes(filter));
	const rowsHost = host.querySelector(".gjj-wa2-lora-rows");
	rowsHost.replaceChildren();
	rows.forEach((row, index) => {
		const line = document.createElement("div");
		line.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) auto 74px;gap:7px;align-items:center;padding:7px;border:1px solid #3c5059;border-radius:8px;background:#162127;";
		const select = document.createElement("select");
		select.style.cssText = "min-width:0;width:100%;height:30px;border:1px solid #48606b;border-radius:6px;background:#10191e;color:#e8f2f4;padding:0 7px;";
		const empty = document.createElement("option"); empty.value = ""; empty.textContent = "未选择"; select.appendChild(empty);
		const optionNames = row.name && !visibleChoices.includes(row.name) ? [row.name, ...visibleChoices] : visibleChoices;
		for (const name of optionNames) { const option = document.createElement("option"); option.value = name; option.textContent = name; select.appendChild(option); }
		select.value = row.name;
		const enabled = document.createElement("label"); enabled.style.cssText = "display:flex;align-items:center;gap:3px;white-space:nowrap;font-size:12px;";
		const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = row.enabled !== false; enabled.append(checkbox, document.createTextNode("启用"));
		const strength = document.createElement("input"); strength.type = "number"; strength.step = "0.05"; strength.value = String(row.strength); strength.title = "LoRA 模型强度"; strength.style.cssText = "width:74px;height:30px;box-sizing:border-box;border:1px solid #48606b;border-radius:6px;background:#10191e;color:#e8f2f4;text-align:center;";
		select.onchange = () => { row.name = select.value; saveLoraRows(node); renderLoraPanel(node, host); };
		checkbox.onchange = () => { row.enabled = checkbox.checked; saveLoraRows(node); };
		strength.onchange = () => { row.strength = Number.isFinite(Number(strength.value)) ? Number(strength.value) : 1; strength.value = String(row.strength); saveLoraRows(node); };
		for (const control of [select, checkbox, strength]) for (const eventName of ["pointerdown", "mousedown", "keydown"]) control.addEventListener(eventName, (event) => event.stopPropagation());
		line.append(select, enabled, strength); rowsHost.appendChild(line);
	});
	saveLoraRows(node);
}

function createLoraPanel(node) {
	const host = document.createElement("div"); host.style.cssText = "display:flex;flex-direction:column;gap:7px;padding:5px 0;box-sizing:border-box;color:#e8f2f4;";
	const title = document.createElement("div"); title.textContent = "🧩 LoRA"; title.style.cssText = "font-weight:800;border-top:1px solid #30444d;margin-top:14px;padding-top:12px;";
	const filter = document.createElement("input"); filter.placeholder = "全局过滤 LoRA"; filter.style.cssText = "width:100%;height:30px;box-sizing:border-box;border:1px solid #48606b;border-radius:6px;background:#10191e;color:#e8f2f4;padding:0 8px;";
	const rows = document.createElement("div"); rows.className = "gjj-wa2-lora-rows"; rows.style.cssText = "display:flex;flex-direction:column;gap:7px;";
	filter.oninput = () => { node.__gjjWanAnimate2LoraFilter = filter.value; renderLoraPanel(node); };
	for (const eventName of ["pointerdown", "mousedown", "click", "keydown", "wheel"]) host.addEventListener(eventName, (event) => event.stopPropagation());
	host.append(title, filter, rows); node.__gjjWanAnimate2LoraHost = host;
	renderLoraPanel(node, host);
	return host;
}

function currentModelEntries(node) {
	const specs = node.__gjjWanAnimate2ModelSpecs instanceof Map ? node.__gjjWanAnimate2ModelSpecs : new Map();
	const entries = [];
	for (const [name, spec] of specs) {
		const value = String(widget(node, name)?.value || "").trim();
		if (value) entries.push({ kind: spec.folder === "loras" ? "loras" : inferModelKind(spec.folder), value, folder: spec.folder });
	}
	for (const row of normalizeLoraRows(node.__gjjWanAnimate2LoraRows || readLoraRows(node))) {
		if (row.enabled !== false && String(row.name || "").trim()) entries.push({ kind: "loras", value: row.name, folder: "loras" });
	}
	return entries;
}

function inferModelKind(folder) {
	return ({ diffusion_models: "diffusion", text_encoders: "clip", clip_vision: "clip_vision", vae: "vae", loras: "loras" })[String(folder || "").toLowerCase()] || "auto";
}

function stabilize(node) {
	ensureMediaInputsFirst(node); addToolbar(node); addPreview(node); hideWidgets(node);
	updateResourceButtons(node);
	const width = Math.max(360, Number(node.size?.[0] || 360));
	const progressHeight = node.__gjjWanAnimate2ProgressWidget ? 34 : 0;
	const height = 180 + progressHeight + (node?.properties?.gjj_wan_animate2_final_video?.filename ? previewPanelHeight(node, width) : 0);
	node.__gjjWanAnimate2Sizing = true;
	node.setSize?.([width, height]); node.size = [width, height];
	node.__gjjWanAnimate2Sizing = false;
	app.graph?.setDirtyCanvas?.(true, true);
}

app.registerExtension({
	name: "Comfy.GJJ.WanAnimate2LongVideoAIO.CompactPanel",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME || nodeType.prototype.__gjjWanAnimate2Compact) return;
		nodeType.prototype.__gjjWanAnimate2Compact = true;
		const modelSpecs = modelSpecsFromNodeData(nodeData);
		const parameterSpecs = parameterSpecsFromNodeData(nodeData);
		const created = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) { const result = created?.apply(this, args); this.__gjjWanAnimate2ModelSpecs = modelSpecs; this.__gjjWanAnimate2ParameterSpecs = parameterSpecs; this.__gjjHelpModelEntries = () => currentModelEntries(this); restoreNamedParameters(this); setTimeout(() => stabilize(this), 0); setTimeout(() => stabilize(this), 150); return result; };
		const configured = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) { const result = configured?.apply(this, args); this.__gjjWanAnimate2ModelSpecs = modelSpecs; this.__gjjWanAnimate2ParameterSpecs = parameterSpecs; this.__gjjHelpModelEntries = () => currentModelEntries(this); restoreNamedParameters(this, args[0]?.properties?.[PARAMS_PROPERTY]); this.__gjjWanAnimate2LoraRows = readLoraRows(this); setTimeout(() => stabilize(this), 0); return result; };
		const connections = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) { const result = connections?.apply(this, args); setTimeout(() => updateResourceButtons(this), 0); return result; };
		const resized = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (size, ...args) {
			const result = resized?.apply(this, [size, ...args]);
			const width = Math.round(Number(size?.[0] || this.size?.[0] || 0));
			if (!this.__gjjWanAnimate2Sizing && width > 0 && width !== this.__gjjWanAnimate2LastWidth) {
				this.__gjjWanAnimate2LastWidth = width;
				setTimeout(() => { updatePreview(this); stabilize(this); }, 0);
			}
			return result;
		};
		const serialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (data) { const result = serialize?.apply(this, [data]); data.properties ||= {}; data.properties[PARAMS_PROPERTY] = namedParameters(this); if (data.properties.gjj_wan_animate2_final_video?.transient) delete data.properties.gjj_wan_animate2_final_video; return result; };
		const executed = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...args) {
			const ui = message?.ui || message || {};
			const items = Array.isArray(ui.preview_media) ? ui.preview_media : [];
			if (items.length && items[items.length - 1]?.filename) {
				this.properties ||= {};
				this.properties.gjj_wan_animate2_final_video = { ...items[items.length - 1] };
				addPreview(this); stabilize(this);
			}
			return executed?.apply(this, [message, ...args]);
		};
	},
});

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	for (const node of app.graph?._nodes || []) {
		if (String(node?.comfyClass || node?.type) === NODE_NAME && String(node.id) === String(detail.node)) updateProgress(node, detail);
	}
});
