import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const NODE_TYPE = "GJJ_MiniMaxH3Studio";
const PANEL_WIDGET = "__gjj_minimax_h3_panel";
const RESULT_WIDGET = "__gjj_minimax_h3_result";
const STYLE_ID = "gjj-minimax-h3-studio-style";
const MEDIA_INPUTS = ["reference_media", "reference_media_2"];
const LINK_MEMORY_PROPERTY = "gjj_minimax_h3_media_links";
const PROMPT_BACKUP_PROPERTY = "gjj_minimax_h3_prompt";
const SETTINGS_BACKUP_PROPERTY = "gjj_minimax_h3_settings";
const SETTINGS_SCHEMA_PROPERTY = "gjj_minimax_h3_settings_schema";
const SETTINGS_SCHEMA_VERSION = 2;
const UPLOAD_ROUTE = "/gjj/minimax_h3_studio/upload";
const HIDDEN = new Set([
	"width", "height", "duration", "frame_rate", "steps", "seed", "randomize_seed",
	"sampler_name", "scheduler", "denoise", "ref_image_size", "filename_prefix", "format_name",
	"fl_model", "ref_model", "clip_name", "video_vae_name", "audio_vae_name", "keep_model",
	"use_source_size",
	"size_mode", "resize_fit_mode", "resize_anchor",
	"internal_media_json",
]);
const POPUP_GROUPS = {
	params: [["生成参数", ["duration", "frame_rate", "steps", "seed", "sampler_name", "scheduler", "denoise", "ref_image_size"]], ["输出", ["filename_prefix", "format_name"]]],
	size: [["画面尺寸", ["width", "height"]]],
};

function widget(node, name) { return GJJ_Utils.getWidget(node, name); }
function value(node, name, fallback = "") { return widget(node, name)?.value ?? fallback; }
function setValue(node, name, next) {
	const target = widget(node, name); if (!target) return;
	target.value = next; target.callback?.(next); app.graph?.setDirtyCanvas?.(true, true);
}
function inputDefinition(node, name) {
	const input = node?.constructor?.nodeData?.input || node?.constructor?.nodeData?.inputs || node?.nodeData?.input || {};
	for (const group of [input?.required, input?.optional]) if (Array.isArray(group?.[name])) return group[name];
	return null;
}
function declaredDefault(node, name) {
	const definition = inputDefinition(node, name); const options = definition?.[1] || {}; const target = widget(node, name); const items = choices(target);
	if (Object.prototype.hasOwnProperty.call(options, "default")) return options.default;
	if (items.length) return items[0];
	const type = definition?.[0]; if (type === "BOOLEAN") return false; if (type === "INT" || type === "FLOAT") return 0; return "";
}
function normalizedSettingValue(node, name, current) {
	const definition = inputDefinition(node, name); if (!definition) return current; const type = definition[0]; const options = definition[1] || {}; const items = choices(widget(node, name)); const fallback = declaredDefault(node, name);
	if (items.length) return items.map(String).includes(String(current)) ? current : fallback;
	if (type === "BOOLEAN") return typeof current === "boolean" ? current : fallback;
	if (type === "INT" || type === "FLOAT") { const number = Number(current); if (!Number.isFinite(number) || (options.min != null && number < Number(options.min)) || (options.max != null && number > Number(options.max))) return fallback; return type === "INT" ? Math.round(number) : number; }
	if (type === "STRING") return typeof current === "string" ? current : fallback;
	return current;
}
function repairSerializedSettings(node) {
	for (const name of persistedWidgetNames(node)) { const target = widget(node, name); if (!target) continue; const next = normalizedSettingValue(node, name, target.value); if (next !== target.value) setValue(node, name, next); }
	const internal = widget(node, "internal_media_json"); if (internal) { try { const parsed = JSON.parse(String(internal.value || "[]")); if (!Array.isArray(parsed)) throw new Error(); } catch (_) { setValue(node, "internal_media_json", "[]"); } }
}
function protect(element) {
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel", "keydown", "contextmenu"]) element.addEventListener(eventName, (event) => event.stopPropagation());
}
function installStyle() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style"); style.id = STYLE_ID;
	style.textContent = `
	.gjj-mh3-root{font:12px/1.3 system-ui;color:#dcebed;background:#10191d;border-radius:8px;padding:8px;display:grid;gap:7px}
	.gjj-mh3-toolbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;align-content:flex-start;max-width:100%}.gjj-mh3-btn{height:32px;min-width:40px;flex:0 0 auto;border:1px solid #42747d;border-radius:6px;background:#173038;color:#dff;cursor:pointer;font-weight:700}.gjj-mh3-btn:hover{filter:brightness(1.18)}.gjj-mh3-btn.active{background:#175f4d;border-color:#55d2a2}.gjj-mh3-run{min-width:40px;background:#168953;border-color:#39d789;color:white;font-weight:900}
	.gjj-mh3-folder.loaded{background:#17614e;border-color:#55d2a2}.gjj-mh3-folder:disabled{opacity:.4;cursor:not-allowed}.gjj-mh3-link{display:none}.gjj-mh3-link.show{display:block}.gjj-mh3-link.detached{background:#6b5420;border-color:#d5a83c}
	.gjj-mh3-media-tip{position:fixed;z-index:100006;width:min(440px,calc(100vw - 24px));max-height:min(520px,calc(100vh - 24px));overflow:auto;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:9px;border:1px solid #4e7d86;border-radius:9px;background:#0d161a;color:#dcebed;box-shadow:0 14px 45px #000c}.gjj-mh3-media-card{min-width:0;border:1px solid #304e55;border-radius:7px;background:#111d21;padding:6px;display:grid;gap:5px}.gjj-mh3-media-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#a9c7cc}.gjj-mh3-media-card img,.gjj-mh3-media-card video{display:block;width:100%;max-height:190px;object-fit:contain;background:#000;border-radius:4px}.gjj-mh3-media-card audio{width:100%;height:34px}.gjj-mh3-media-text{max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:#dce7e2;font:11px/1.4 ui-monospace,monospace}
	.gjj-mh3-label{display:flex;align-items:center;gap:6px;color:#ffd27d;font-weight:700}.gjj-mh3-mode{margin-left:auto;color:#7ed9d3;font-weight:600}
	.gjj-mh3-prompt{box-sizing:border-box;width:100%;height:72px;min-height:58px;resize:vertical;border:1px solid #31535b;border-radius:6px;background:#091215;color:#f0f8f8;padding:7px;font:12px/1.35 ui-monospace,monospace}
	.gjj-mh3-status{height:16px;color:#8faeb4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
	.gjj-mh3-pop{position:fixed;z-index:100000;width:min(560px,calc(100vw - 28px));max-height:calc(100vh - 40px);overflow:auto;display:none;background:#101a1e;color:#e2f0f1;border:1px solid #4e7d86;border-radius:10px;box-shadow:0 14px 45px #000b;padding:10px}.gjj-mh3-pop.open{display:block}.gjj-mh3-pophead{display:flex;justify-content:space-between;align-items:center;font-weight:800;margin-bottom:8px}.gjj-mh3-close{border:1px solid #40717a;border-radius:5px;background:#173038;color:#dff;padding:5px 12px;cursor:pointer}.gjj-mh3-section{border-top:1px solid #29434a;padding-top:8px;margin-top:8px}.gjj-mh3-title{color:#7ed9d3;font-weight:800;margin-bottom:7px}.gjj-mh3-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.gjj-mh3-field{display:grid;gap:3px;color:#9eb8bd}.gjj-mh3-field.wide{grid-column:1/-1}.gjj-mh3-control{box-sizing:border-box;width:100%;min-width:0;background:#0b1316;color:#e8f5f5;border:1px solid #304e55;border-radius:5px;padding:6px}.gjj-mh3-toggle.active{background:#17614e;color:#fff}
	.gjj-mh3-size-tabs,.gjj-mh3-ratios{display:grid;gap:8px}.gjj-mh3-size-tabs{grid-template-columns:1fr 1fr;margin:8px 0 14px}.gjj-mh3-ratios{grid-template-columns:repeat(5,1fr);margin-bottom:15px}.gjj-mh3-size-choice{min-height:40px;border:1px solid #415861;border-radius:8px;background:#111b20;color:#dbe6e7;font-weight:800;font-size:14px;cursor:pointer}.gjj-mh3-size-choice.active{border-color:#19d8df;background:#0d8fb0;color:#fff}.gjj-mh3-size-tabs .gjj-mh3-size-choice.active{background:#12964d;border-color:#27dda0}.gjj-mh3-choice-row{display:grid;grid-template-columns:42px repeat(var(--count),1fr);gap:8px;margin:8px 0}.gjj-mh3-choice-icon{display:grid;place-items:center;font-size:20px}.gjj-mh3-slider-row{display:grid;grid-template-columns:62px minmax(0,1fr) 90px;gap:10px;align-items:center;margin:13px 0;color:#c9d7da;font-weight:700}.gjj-mh3-slider-row input[type=range]{width:100%;accent-color:#19b7d0}.gjj-mh3-size-number{width:100%;box-sizing:border-box;border:1px solid #415861;border-radius:7px;background:#111b20;color:#eaf5f6;padding:8px;text-align:center;font-weight:800}.gjj-mh3-size-disabled{opacity:.42}.gjj-mh3-preview{display:none;width:100%;margin-top:4px;background:#000;border-radius:6px;overflow:hidden}.gjj-mh3-preview video{display:block;width:100%;height:100%;object-fit:contain;background:#000}`;
	document.head.appendChild(style);
}
function hideBackendWidgets(node) {
	for (const name of HIDDEN) {
		const target = widget(node, name); if (!target) continue;
		GJJ_Utils.hideWidget(target); target.hidden = true; target.computeSize = () => [0, 0]; target.getHeight = () => 0; target.draw = () => {}; target.last_y = 0; target.computedHeight = 0; target.size = [0, 0];
		target.options ||= {}; target.options.hidden = true; target.options.display = "hidden";
		for (const element of [target.element, target.inputEl, target.widget]) if (element?.style) { element.style.display = "none"; element.style.height = "0"; element.style.margin = "0"; element.style.padding = "0"; }
	}
}
function choices(target) {
	let items = target?.options?.values || target?.options?.items || target?.values;
	if (typeof items === "function") try { items = items(); } catch (_) { items = []; }
	return Array.isArray(items) ? items : [];
}
function widgetDefinitionOptions(node, target) {
	const fieldName = String(target?.name || target?.options?.name || "").trim();
	const definition = inputDefinition(node, fieldName); return definition?.[1] && typeof definition[1] === "object" ? definition[1] : {};
}
function looksLikeModelChoice(target) {
	return choices(target).some((item) => /\.(?:safetensors|ckpt|pt|pth|bin|gguf)(?:$|[?#])/i.test(String(item || "")));
}
function inferredModelFolder(fieldName) {
	const key = String(fieldName || "").toLowerCase();
	if (key.includes("vae")) return "vae";
	if (key.includes("clip") || key.includes("text_encoder")) return "text_encoders";
	if (key.includes("lora")) return "loras";
	if (key.includes("control")) return "controlnet";
	return "diffusion_models";
}
function inferredModelIcon(folder) {
	return folder === "vae" ? "🔴" : (folder === "text_encoders" ? "🟡" : (folder === "loras" ? "🟢" : "🟣"));
}
function declaredKeywords(...values) {
	for (const value of values) {
		if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
		if (typeof value === "string" && value.trim()) return value.split(/[\s,，|]+/).map((item) => item.trim()).filter(Boolean);
	}
	return [];
}
function makeControl(node, name) {
	const target = widget(node, name); if (!target) return null;
	let control; const items = choices(target);
	if (typeof target.value === "boolean") {
		control = document.createElement("button"); control.type = "button"; control.className = "gjj-mh3-control gjj-mh3-toggle";
		const sync = () => { control.textContent = target.value ? "开启" : "关闭"; control.classList.toggle("active", Boolean(target.value)); };
		control.addEventListener("click", () => { setValue(node, name, !Boolean(target.value)); sync(); }); sync();
	} else if (items.length) {
		control = document.createElement("select");
		for (const item of items) { const option = document.createElement("option"); option.value = String(item); option.textContent = String(item); control.appendChild(option); }
		control.value = String(target.value ?? ""); control.addEventListener("change", () => setValue(node, name, control.value));
	} else {
		control = document.createElement("input"); control.type = typeof target.value === "number" ? "number" : "text"; control.value = String(target.value ?? "");
		if (control.type === "number") { for (const attr of ["min", "max", "step"]) if (target.options?.[attr] != null) control[attr] = String(target.options[attr]); }
		control.addEventListener("change", () => setValue(node, name, typeof target.value === "number" ? Number(control.value) : control.value));
	}
	control.classList.add("gjj-mh3-control"); protect(control); return control;
}
function modelTreeEntries(node) {
	return (node.widgets || []).filter((target) => {
		const declared = widgetDefinitionOptions(node, target);
		return Boolean(String(target?.options?.gjj_model_folder || declared?.gjj_model_folder || "").trim()) || looksLikeModelChoice(target);
	}).map((target) => {
		const fieldName = String(target.name || target.options?.name || "").trim();
		const declared = widgetDefinitionOptions(node, target);
		const folder = String(target?.options?.gjj_model_folder || declared?.gjj_model_folder || inferredModelFolder(fieldName)).trim();
		const defaultModel = String(target?.options?.gjj_default_model || declared?.gjj_default_model || target?.options?.default || declared?.default || target?.value || "").trim();
		return {
			widget: fieldName,
			folder,
			icon: String(target.options?.gjj_model_icon || declared?.gjj_model_icon || inferredModelIcon(folder)),
			label: String(target?.options?.display_name || declared?.display_name || target?.label || fieldName),
			models: choices(target),
			keywords: declaredKeywords(target.options?.gjj_model_keywords, declared?.gjj_model_keywords),
			defaultModel,
			fallback: defaultModel,
			autoSelect: true,
			floatingChoices: false,
			description: `候选项来自 models/${folder}；过滤词由当前模型的文件名自动提取。`,
		};
	});
}
function renderModelTree(node, host) {
	const tree = GJJ_Utils.createModelTreeView({
		node,
		entries: modelTreeEntries(node),
		refresh: () => GJJ_Utils.refreshNode?.(node),
		onApply: () => queueMicrotask(() => renderModelTree(node, host)),
	});
	tree.style.maxHeight = "min(460px,calc(100vh - 180px))";
	host.replaceChildren(tree);
}
function createSizePanel(node) {
	const host = document.createElement("div");
	const tabs = document.createElement("div"); tabs.className = "gjj-mh3-size-tabs";
	const sourceButton = document.createElement("button"); sourceButton.type = "button"; sourceButton.className = "gjj-mh3-size-choice"; sourceButton.textContent = "首图尺寸";
	const panelButton = document.createElement("button"); panelButton.type = "button"; panelButton.className = "gjj-mh3-size-choice"; panelButton.textContent = "画板尺寸";
	tabs.append(sourceButton, panelButton);
	const choiceControls = new Map();
	const makeChoiceRow = (name, icon, values) => {
		const row = document.createElement("div"); row.className = "gjj-mh3-choice-row"; row.style.setProperty("--count", String(values.length));
		const iconCell = document.createElement("span"); iconCell.className = "gjj-mh3-choice-icon"; iconCell.textContent = icon; row.appendChild(iconCell);
		const buttons = values.map((item) => { const button = document.createElement("button"); button.type = "button"; button.className = "gjj-mh3-size-choice"; button.textContent = item; button.addEventListener("click", () => { setValue(node, name, item); sync(); }); row.appendChild(button); return button; });
		choiceControls.set(name, { values, buttons }); return row;
	};
	const modeRow = makeChoiceRow("size_mode", "📐", ["宽高", "等比", "长边", "像素"]);
	const fitRow = makeChoiceRow("resize_fit_mode", "🧲", ["拉伸", "补边", "留边", "裁剪"]);
	const anchorRow = makeChoiceRow("resize_anchor", "📍", ["上", "下", "左", "右", "中"]);
	const dimensions = document.createElement("div");
	const controls = {};
	for (const [name, icon, label] of [["width", "📐", "宽度"], ["height", "📏", "高度"]]) {
		const target = widget(node, name); const row = document.createElement("label"); row.className = "gjj-mh3-slider-row";
		const caption = document.createElement("span"); caption.textContent = `${icon} ${label}`;
		const range = document.createElement("input"); range.type = "range"; range.min = String(target?.options?.min ?? 352); range.max = String(target?.options?.max ?? 1920); range.step = String(target?.options?.step ?? 32);
		const number = document.createElement("input"); number.type = "number"; number.className = "gjj-mh3-size-number"; number.min = range.min; number.max = range.max; number.step = range.step;
		const apply = (raw) => { const min = Number(range.min); const max = Number(range.max); const step = Number(range.step) || 1; const next = Math.max(min, Math.min(max, Math.round(Number(raw) / step) * step)); setValue(node, name, next); range.value = String(next); number.value = String(next); sync(); };
		range.addEventListener("input", () => apply(range.value)); number.addEventListener("change", () => apply(number.value)); row.append(caption, range, number); dimensions.appendChild(row); controls[name] = { range, number };
	}
	const sync = () => {
		const source = Boolean(value(node, "use_source_size", true)); sourceButton.classList.toggle("active", source); panelButton.classList.toggle("active", !source); dimensions.classList.toggle("gjj-mh3-size-disabled", source);
		for (const control of Object.values(controls)) { control.range.disabled = source; control.number.disabled = source; }
		for (const [name, group] of choiceControls) group.buttons.forEach((button, index) => button.classList.toggle("active", String(value(node, name, group.values[0])) === group.values[index]));
		controls.width.range.value = controls.width.number.value = String(value(node, "width", 864)); controls.height.range.value = controls.height.number.value = String(value(node, "height", 480));
	};
	sourceButton.addEventListener("click", () => { setValue(node, "use_source_size", true); sync(); }); panelButton.addEventListener("click", () => { setValue(node, "use_source_size", false); sync(); });
	for (const element of [sourceButton, panelButton, ...Array.from(choiceControls.values()).flatMap((item) => item.buttons), ...Object.values(controls).flatMap((item) => [item.range, item.number])]) protect(element);
	host.append(tabs, modeRow, fitRow, anchorRow, dimensions); host.__gjjSync = sync; sync(); return host;
}
function popup(node, key, title) {
	const root = document.createElement("div"); root.className = "gjj-mh3-pop"; root.dataset.popup = key; protect(root);
	const head = document.createElement("div"); head.className = "gjj-mh3-pophead"; const caption = document.createElement("span"); caption.textContent = title;
	const close = document.createElement("button"); close.className = "gjj-mh3-close"; close.textContent = key === "size" ? "×" : "确定"; close.addEventListener("click", () => closePopups(node)); head.append(caption, close); root.append(head);
	if (key === "size") {
		const sizePanel = createSizePanel(node); root.appendChild(sizePanel); root.__gjjSizePanel = sizePanel;
		document.body.appendChild(root);
		return root;
	}
	if (key === "model") {
		const treeHost = document.createElement("div");
		root.appendChild(treeHost);
		renderModelTree(node, treeHost);
		const keepSection = document.createElement("section"); keepSection.className = "gjj-mh3-section";
		const keepGrid = document.createElement("div"); keepGrid.className = "gjj-mh3-grid";
		const keepControl = makeControl(node, "keep_model");
		if (keepControl) { const row = document.createElement("label"); row.className = "gjj-mh3-field wide"; const label = document.createElement("span"); label.textContent = widget(node, "keep_model")?.options?.display_name || "保持模型"; row.append(label, keepControl); keepGrid.append(row); }
		keepSection.appendChild(keepGrid); root.appendChild(keepSection);
		root.__gjjModelTreeHost = treeHost;
		document.body.appendChild(root);
		return root;
	}
	for (const [sectionTitle, names] of POPUP_GROUPS[key] || []) {
		const section = document.createElement("section"); section.className = "gjj-mh3-section"; const heading = document.createElement("div"); heading.className = "gjj-mh3-title"; heading.textContent = sectionTitle;
		const grid = document.createElement("div"); grid.className = "gjj-mh3-grid";
		for (const name of names) { const control = makeControl(node, name); if (!control) continue; const row = document.createElement("label"); row.className = "gjj-mh3-field"; if (["filename_prefix", "format_name"].includes(name)) row.classList.add("wide"); const label = document.createElement("span"); label.textContent = widget(node, name)?.options?.display_name || widget(node, name)?.label || name; row.append(label, control); grid.append(row); }
		section.append(heading, grid); root.append(section);
	}
	document.body.appendChild(root); return root;
}
function closePopups(node) { for (const item of Object.values(node.__gjjMiniMaxPanel?.popups || {})) item.classList.remove("open"); for (const item of Object.values(node.__gjjMiniMaxPanel?.buttons || {})) item.classList.remove("active"); }
function openPopup(node, key, anchor) {
	const panel = node.__gjjMiniMaxPanel; const target = panel?.popups?.[key]; if (!target) return;
	const wasOpen = target.classList.contains("open"); closePopups(node); if (wasOpen) return;
	if (key === "size") target.__gjjSizePanel?.__gjjSync?.();
	if (key === "model" && target.__gjjModelTreeHost) renderModelTree(node, target.__gjjModelTreeHost);
	const rect = anchor.getBoundingClientRect(); const width = Math.min(560, window.innerWidth - 28); target.style.width = `${width}px`; target.style.left = `${Math.max(14, Math.min(window.innerWidth - width - 14, rect.left))}px`; target.style.top = `${Math.max(14, Math.min(window.innerHeight - 300, rect.bottom + 7))}px`; target.classList.add("open"); anchor.classList.add("active");
}
function makeButton(text, title, className = "") { const button = document.createElement("button"); button.type = "button"; button.className = `gjj-mh3-btn ${className}`; button.textContent = text; button.title = title; protect(button); return button; }
function firstPreviewItem(...values) {
	for (const value of values) {
		if (!value) continue;
		if (Array.isArray(value)) { const nested = firstPreviewItem(...value); if (nested) return nested; }
		else if (typeof value === "object" && value.filename) return value;
	}
	return null;
}
function previewItemFromPath(rawPath) {
	const clean = String(Array.isArray(rawPath) ? rawPath[0] : rawPath || "").replaceAll("\\", "/"); if (!clean) return null;
	const filename = clean.split("/").pop(); if (!filename) return null;
	const marker = clean.toLowerCase().lastIndexOf("/output/"); const subfolder = marker >= 0 ? clean.slice(marker + 8, clean.length - filename.length).replace(/^\/+|\/+$/g, "") : "";
	return { filename, subfolder, type: "output" };
}
function renderResultPreview(node, message = {}) {
	const state = node.__gjjMiniMaxPanel; if (!state?.preview || !state?.video) return;
	const output = message?.output && typeof message.output === "object" ? message.output : message;
	const item = firstPreviewItem(output.preview_media, output.preview_video, output.gifs, output.animated, output.videos, output.video) || previewItemFromPath(output.output_path);
	if (!item) return;
	const query = `/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "output")}&subfolder=${encodeURIComponent(item.subfolder || "")}&rand=${Date.now()}`;
	state.video.src = api.apiURL(query); state.preview.style.display = "block"; state.video.load(); const play = state.video.play?.(); play?.catch?.(() => {});
	const resize = () => { const contentWidth = Math.max(1, Number(state.preview.clientWidth || state.resultRoot?.clientWidth || node.size?.[0] - 36 || 1)); const mediaHeight = Math.max(1, Math.round(contentWidth * Number(state.video.videoHeight || 9) / Math.max(1, Number(state.video.videoWidth || 16)))); state.preview.style.height = `${mediaHeight}px`; fitPanel(node); };
	state.video.onloadedmetadata = resize; state.previewObserver?.disconnect?.(); let lastWidth = 0; state.previewObserver = new ResizeObserver((entries) => { const width = Math.round(entries[0]?.contentRect?.width || 0); if (width > 0 && width !== lastWidth) { lastWidth = width; resize(); } }); state.previewObserver.observe(state.preview); setTimeout(resize, 50);
}
function mediaInput(node, name) { return (node.inputs || []).find((item) => String(item?.name || "") === name); }
function activeMediaLinks(node) { return MEDIA_INPUTS.some((name) => mediaInput(node, name)?.link != null); }
function linkMemory(node) { node.properties ||= {}; node.properties[LINK_MEMORY_PROPERTY] ||= {}; return node.properties[LINK_MEMORY_PROPERTY]; }
function hasRememberedLinks(node) { return Object.values(linkMemory(node)).some((item) => item && typeof item === "object"); }
function toggleMediaLinks(node) {
	const memory = linkMemory(node);
	if (activeMediaLinks(node)) {
		for (const name of MEDIA_INPUTS) { const input = mediaInput(node, name); const link = app.graph?.links?.[input?.link]; if (!input || !link) continue; memory[name] = { origin_id: link.origin_id, origin_slot: link.origin_slot }; const index = node.inputs.indexOf(input); node.disconnectInput?.(index); }
	} else {
		for (const name of MEDIA_INPUTS) { const record = memory[name]; const target = mediaInput(node, name); const source = app.graph?.getNodeById?.(record?.origin_id); if (!record || !target || !source?.connect) continue; source.connect(Number(record.origin_slot), node, node.inputs.indexOf(target)); }
	}
	node.graph?.change?.(); syncMediaToolbar(node); app.graph?.setDirtyCanvas?.(true, true);
}
function internalMediaItems(node) { try { const result = JSON.parse(String(value(node, "internal_media_json", "[]"))); return Array.isArray(result) ? result : []; } catch (_) { return []; } }
function internalMediaUrl(item) {
	return api.apiURL(`/view?filename=${encodeURIComponent(item?.filename || "")}&type=${encodeURIComponent(item?.type || "input")}&subfolder=${encodeURIComponent(item?.subfolder || "")}&rand=${Date.now()}`);
}
function closeMediaTooltip(node) { clearTimeout(node.__gjjMiniMaxTipTimer); node.__gjjMiniMaxPanel?.tooltip?.remove?.(); if (node.__gjjMiniMaxPanel) node.__gjjMiniMaxPanel.tooltip = null; }
function scheduleMediaTooltipClose(node) { clearTimeout(node.__gjjMiniMaxTipTimer); node.__gjjMiniMaxTipTimer = setTimeout(() => closeMediaTooltip(node), 140); }
function showMediaTooltip(node) {
	const panel = node.__gjjMiniMaxPanel; const items = internalMediaItems(node); if (!panel || !items.length || activeMediaLinks(node)) return;
	closeMediaTooltip(node); const tip = document.createElement("div"); tip.className = "gjj-mh3-media-tip"; protect(tip);
	for (const item of items) {
		const card = document.createElement("div"); card.className = "gjj-mh3-media-card"; const name = document.createElement("div"); name.className = "gjj-mh3-media-name"; name.textContent = item.original_name || item.filename || "素材"; name.title = name.textContent;
		const type = String(item.media_type || ""); let media;
		if (type === "image") { media = document.createElement("img"); media.loading = "lazy"; media.src = internalMediaUrl(item); }
		else if (type === "video") { media = document.createElement("video"); media.src = internalMediaUrl(item); media.muted = true; media.loop = true; media.playsInline = true; media.preload = "metadata"; media.controls = true; }
		else if (type === "audio") { media = document.createElement("audio"); media.src = internalMediaUrl(item); media.preload = "metadata"; media.controls = true; }
		else { media = document.createElement("div"); media.className = "gjj-mh3-media-text"; media.textContent = item.preview_text || "文本素材"; }
		card.append(name, media); tip.appendChild(card);
	}
	document.body.appendChild(tip); const rect = panel.folder.getBoundingClientRect(); const tipRect = tip.getBoundingClientRect(); tip.style.left = `${Math.max(12, Math.min(window.innerWidth - tipRect.width - 12, rect.left))}px`; tip.style.top = `${Math.max(12, Math.min(window.innerHeight - tipRect.height - 12, rect.bottom + 7))}px`;
	tip.addEventListener("mouseenter", () => clearTimeout(node.__gjjMiniMaxTipTimer)); tip.addEventListener("mouseleave", () => scheduleMediaTooltipClose(node)); panel.tooltip = tip;
}
function syncMediaToolbar(node) {
	const panel = node.__gjjMiniMaxPanel; if (!panel) return;
	const linked = activeMediaLinks(node); const remembered = hasRememberedLinks(node); const loaded = internalMediaItems(node).length > 0;
	panel.folder.disabled = linked; panel.folder.classList.toggle("loaded", loaded && !linked); panel.folder.title = linked ? "外部媒体入口已连接，内部媒体选择已禁用" : (loaded ? `已载入 ${internalMediaItems(node).length} 个内部文件` : "打开图片、文本、音频或视频");
	panel.link.classList.toggle("show", linked || remembered); panel.link.classList.toggle("detached", !linked && remembered); panel.link.title = linked ? "记录上游接口并断开链接" : "恢复记录的上游接口";
}
async function uploadInternalMedia(node, files) {
	const form = new FormData(); for (const file of files) form.append("media", file, file.name);
	const response = await fetch(api.apiURL(UPLOAD_ROUTE), { method: "POST", body: form }); const data = await response.json().catch(() => ({}));
	if (!response.ok || data?.ok === false) throw new Error(data?.error || "媒体上传失败");
	setValue(node, "internal_media_json", JSON.stringify(data.items || [])); if (node.__gjjMiniMaxPanel) node.__gjjMiniMaxPanel.status.textContent = `已载入 ${(data.items || []).length} 个内部文件`; syncMediaToolbar(node);
}
function cleanup(node) { closePopups(node); closeMediaTooltip(node); node.__gjjMiniMaxPanel?.previewObserver?.disconnect?.(); for (const item of Object.values(node.__gjjMiniMaxPanel?.popups || {})) item.remove(); node.__gjjMiniMaxPanel = null; }
function arrangePanelWidgets(node, toolbarWidget, resultWidget) {
	if (!Array.isArray(node.widgets)) return;
	const backendOrder = persistedWidgetNames(node); const backendSet = new Set(backendOrder); const widgetMap = new Map();
	for (const item of node.widgets) {
		const name = String(item?.name || ""); if (backendSet.has(name) && !widgetMap.has(name)) widgetMap.set(name, item);
		else if (item !== toolbarWidget && item !== resultWidget) { item.serialize = false; item.options ||= {}; item.options.serialize = false; }
	}
	const canonical = backendOrder.map((name) => widgetMap.get(name)).filter(Boolean); const promptIndex = canonical.findIndex((item) => item.name === "prompt");
	if (promptIndex < 0) return; canonical.splice(promptIndex, 0, toolbarWidget); canonical.splice(promptIndex + 2, 0, resultWidget); node.widgets = canonical;
}
function persistedWidgetNames(node) {
	const optional = node?.constructor?.nodeData?.input?.optional || node?.constructor?.nodeData?.inputs?.optional || node?.nodeData?.input?.optional || {};
	return Object.keys(optional).filter((name) => Boolean(widget(node, name)) && name !== PANEL_WIDGET && name !== RESULT_WIDGET);
}
function writeSettingsBackup(node) {
	node.properties ||= {};
	// ⚠️ 改为合并模式：先继承已有 backup，再用当前 widget 值更新。
	// 原因：如果 widget.value 因时机问题（如 ComfyUI 尚未恢复 widgets_values、
	// DOM 未同步等）为空或默认值，完全覆盖会丢失用户之前保存的正确值。
	const oldBackup = (node.properties[SETTINGS_BACKUP_PROPERTY] && typeof node.properties[SETTINGS_BACKUP_PROPERTY] === "object" && !Array.isArray(node.properties[SETTINGS_BACKUP_PROPERTY]))
		? { ...node.properties[SETTINGS_BACKUP_PROPERTY] }
		: {};
	const backup = { ...oldBackup };
	for (const name of persistedWidgetNames(node)) {
		const target = widget(node, name);
		if (!target) continue;
		const currentValue = target.value;
		// prompt 特殊保护：如果当前 widget 值为空但旧 backup 有值，保留旧值
		// 防止 ComfyUI 恢复时序问题导致 prompt 被空值覆盖
		if (name === "prompt") {
			const oldVal = oldBackup[name];
			if ((currentValue == null || String(currentValue).trim() === "") && oldVal != null && String(oldVal).trim() !== "") {
				backup[name] = oldVal;
				continue;
			}
		}
		backup[name] = currentValue;
	}
	node.properties[SETTINGS_BACKUP_PROPERTY] = backup;
	node.properties[PROMPT_BACKUP_PROPERTY] = String(backup.prompt || "");
	return backup;
}
function ensureSettingsPersistence(node) {
	node.properties ||= {}; let backup = node.properties[SETTINGS_BACKUP_PROPERTY]; const currentSchema = Number(node.properties[SETTINGS_SCHEMA_PROPERTY] || 0);
	if (currentSchema !== SETTINGS_SCHEMA_VERSION || !backup || typeof backup !== "object" || Array.isArray(backup)) {
		const legacyPrompt = String(node.properties[PROMPT_BACKUP_PROPERTY] || "");
		const oldBackup = (backup && typeof backup === "object" && !Array.isArray(backup)) ? { ...backup } : {};
		backup = {};
		for (const name of persistedWidgetNames(node)) {
			// 升级 schema 时优先保留：旧 backup(按名称) > 当前 widget.value(原生加载的可能错位值) > declaredDefault
			// 这样即使跨版本升级也能最大程度保留用户已保存的参数
			const candidate = Object.prototype.hasOwnProperty.call(oldBackup, name)
				? oldBackup[name]
				: (widget(node, name)?.value ?? declaredDefault(node, name));
			backup[name] = declaredDefault(node, name); // 先占位默认值，防止类型错误
			backup[name] = normalizedSettingValue(node, name, candidate);
		}
		if (legacyPrompt) backup.prompt = legacyPrompt;
		node.properties[SETTINGS_BACKUP_PROPERTY] = backup; node.properties[SETTINGS_SCHEMA_PROPERTY] = SETTINGS_SCHEMA_VERSION;
	}
	for (const name of persistedWidgetNames(node)) {
		const target = widget(node, name); if (!target) continue;
		// ✅ 必须保持 serialize=true：ComfyUI 构造 prompt.inputs 时会遍历 widget，
		// 只有 serialize=true 的 widget 才会按名称进入 prompt 发送给后端执行。
		// 解决错位的策略：onConfigure 时先用原生 widgets_values(可能错位) 恢复，
		// 然后立刻用 properties 按名称覆盖 widget.value，保证结果始终正确。
		target.serialize = true;
		target.options ||= {}; target.options.serialize = true;

		// ⚠️ prompt 特殊处理：优先从 PROMPT_BACKUP_PROPERTY 恢复
		// PROMPT_BACKUP_PROPERTY 是独立的、始终同步的 prompt 备份，
		// 比 SETTINGS_BACKUP_PROPERTY.prompt 更可靠（不会被合并逻辑意外清空）
		if (name === "prompt") {
			const promptBackup = String(node.properties[PROMPT_BACKUP_PROPERTY] || "");
			if (promptBackup) {
				backup.prompt = promptBackup;
			} else if (!Object.prototype.hasOwnProperty.call(backup, "prompt")) {
				backup.prompt = String(target.value ?? "");
			}
		}

		// ⚠️ 强制按名称从 backup 覆盖 widget.value，无论原生 widgets_values 是否错位。
		// 这是修复「重启 ComfyUI 参数错位」的核心：原生按索引、GJJ 按名称双轨并行，
		// 但名称映射的优先级始终高于索引数组。
		if (Object.prototype.hasOwnProperty.call(backup, name)) {
			target.value = normalizedSettingValue(node, name, backup[name]);
		} else {
			backup[name] = normalizedSettingValue(node, name, target.value);
		}
		if (!target.__gjjSettingsPersistence) {
			const original = target.callback;
			target.callback = function (nextValue, ...args) {
				node.properties ||= {}; node.properties[SETTINGS_BACKUP_PROPERTY] ||= {};
				const finalValue = (nextValue != null) ? nextValue : target.value;
				node.properties[SETTINGS_BACKUP_PROPERTY][name] = finalValue;
				if (name === "prompt") node.properties[PROMPT_BACKUP_PROPERTY] = String(finalValue ?? "");
				return original?.call(this, nextValue, ...args);
			};
			target.__gjjSettingsPersistence = true;
		}
	}
	node.properties[PROMPT_BACKUP_PROPERTY] = String(backup.prompt || "");
}
function fitPanel(node) {
	if (node.__gjjMiniMaxFitting) return;
	node.__gjjMiniMaxFitting = true;
	requestAnimationFrame(() => {
		try {
			const width = Math.max(280, Number(node.size?.[0] || 420));
			if (Array.isArray(node.size)) node.size[1] = 1;
			const computed = node.computeSize?.(); const height = Math.max(140, Number(computed?.[1] || 140));
			node.setSize?.([width, height]); app.graph?.setDirtyCanvas?.(true, true);
		} finally { node.__gjjMiniMaxFitting = false; }
	});
}
function createPanel(node) {
	if (node.__gjjMiniMaxPanel) return; installStyle();
	const root = document.createElement("div"); root.className = "gjj-mh3-root"; protect(root);
	const toolbar = document.createElement("div"); toolbar.className = "gjj-mh3-toolbar";
	const folder = makeButton("📁", "打开图片、文本、音频或视频", "gjj-mh3-folder"); const link = makeButton("🔗", "记录并断开/恢复上游媒体接口", "gjj-mh3-link");
	const file = document.createElement("input"); file.type = "file"; file.multiple = true; file.accept = "image/*,text/plain,.txt,.md,.prompt,audio/*,video/*"; file.style.display = "none"; root.appendChild(file);
	const run = makeButton("▶️", "运行当前 MiniMax H3 节点", "gjj-mh3-run");
	const size = makeButton("📐", "尺寸参数"); const seed = makeButton("🎲", "随机种子"); const model = makeButton("🧠", "模型参数"); const settings = makeButton("⚙", "生成参数");
	toolbar.append(folder, link, size, seed, model, settings, run);
	const resultRoot = document.createElement("div"); resultRoot.className = "gjj-mh3-root"; protect(resultRoot);
	const status = document.createElement("div"); status.className = "gjj-mh3-status"; status.textContent = "无输入 T2V｜单图 I2V｜多媒体 Ref2V";
	const preview = document.createElement("div"); preview.className = "gjj-mh3-preview"; const video = document.createElement("video"); video.controls = true; video.loop = true; video.playsInline = true; video.preload = "metadata"; preview.appendChild(video); protect(preview);
	root.append(toolbar); resultRoot.append(status, preview);
	const dom = node.addDOMWidget(PANEL_WIDGET, "div", root, { serialize: false, hideOnZoom: false }); dom.serialize = false; dom.options ||= {}; dom.options.serialize = false; dom.computeSize = () => [Math.max(0, Number(node.size?.[0] || 0) - 20), Math.max(40, Number(root.scrollHeight || 40))];
	const resultDom = node.addDOMWidget(RESULT_WIDGET, "div", resultRoot, { serialize: false, hideOnZoom: false }); resultDom.serialize = false; resultDom.options ||= {}; resultDom.options.serialize = false; resultDom.computeSize = () => { const hasPreview = preview.style.display !== "none" && Boolean(video.getAttribute("src")); const height = hasPreview ? Number(resultRoot.scrollHeight || 24) : Number(status.offsetHeight || 16) + 16; return [Math.max(0, Number(node.size?.[0] || 0) - 20), Math.max(24, height)]; };
	arrangePanelWidgets(node, dom, resultDom);
	const panel = node.__gjjMiniMaxPanel = { root, resultRoot, status, preview, video, folder, link, buttons: { size, seed, model, settings }, popups: {} };
	panel.popups.params = popup(node, "params", "生成参数"); panel.popups.size = popup(node, "size", "📐 尺寸"); panel.popups.model = popup(node, "model", "模型参数");
	run.addEventListener("click", async () => { closePopups(node); status.textContent = "正在提交当前节点…"; await queueOnlyCurrentNode(node); });
	folder.addEventListener("click", () => { if (!folder.disabled) file.click(); }); file.addEventListener("change", async () => { const files = Array.from(file.files || []); file.value = ""; if (!files.length) return; try { status.textContent = "正在载入媒体…"; await uploadInternalMedia(node, files); } catch (error) { status.textContent = `载入失败：${error?.message || error}`; } });
	folder.addEventListener("mouseenter", () => showMediaTooltip(node)); folder.addEventListener("mouseleave", () => scheduleMediaTooltipClose(node));
	link.addEventListener("click", () => toggleMediaLinks(node));
	size.addEventListener("click", () => openPopup(node, "size", size)); model.addEventListener("click", () => openPopup(node, "model", model)); settings.addEventListener("click", () => openPopup(node, "params", settings));
	const syncSeed = () => { const enabled = Boolean(value(node, "randomize_seed", true)); seed.classList.toggle("active", enabled); seed.title = enabled ? "随机种子已开启" : "随机种子已关闭"; }; seed.addEventListener("click", () => { setValue(node, "randomize_seed", !Boolean(value(node, "randomize_seed", true))); syncSeed(); }); syncSeed(); syncMediaToolbar(node); fitPanel(node);
}
// ⚠️ 关键修复：hook prompt widget 的 DOM 事件，实时同步到 properties
// 原因：ComfyUI 原生 multiline STRING widget 用户输入时只更新 widget.value，
// 不会触发 widget.callback，导致 ensureSettingsPersistence 中的 callback hook 永远不执行，
// properties[SETTINGS_BACKUP_PROPERTY].prompt 不会被实时更新。
// 虽然 onSerialize 时 writeSettingsBackup 会从 widget.value 读取，
// 但如果存在时序问题（如 ComfyUI 延迟恢复），prompt 值就会丢失。
// 通过 hook DOM input 事件，确保每次用户输入都实时更新 properties。
function hookPromptWidget(node) {
	const target = widget(node, "prompt");
	if (!target || target.__gjjPromptHooked) return;
	target.__gjjPromptHooked = true;

	// 实时同步函数：从 DOM/widget 读取最新值并写入 properties
	const syncToProperties = (rawValue) => {
		const finalValue = (rawValue != null) ? String(rawValue) : String(target.value ?? "");
		node.properties ||= {};
		node.properties[SETTINGS_BACKUP_PROPERTY] ||= {};
		node.properties[SETTINGS_BACKUP_PROPERTY].prompt = finalValue;
		node.properties[PROMPT_BACKUP_PROPERTY] = finalValue;
	};

	// hook DOM 元素的 input/change/blur 事件
	// ComfyUI STRING multiline widget 的 DOM 元素通常在 inputEl（textarea）或 element 上
	const elements = [target.inputEl, target.element].filter(Boolean);
	for (const el of elements) {
		if (el.addEventListener) {
			el.addEventListener("input", () => syncToProperties(el.value));
			el.addEventListener("change", () => syncToProperties(el.value));
			el.addEventListener("blur", () => syncToProperties(el.value));
		}
	}

	// 同时保留 callback hook（覆盖式更新，防止重复 hook）
	const originalCallback = target.callback;
	target.callback = function (nextValue, ...args) {
		syncToProperties(nextValue);
		return originalCallback?.call(this, nextValue, ...args);
	};
}
function stabilizeLogic(node) {
	// ⚠️ 纯逻辑（无 DOM 依赖）：必须同步执行，确保原生 widgets_values 错位后立刻被按名称覆盖
	if (String(node?.comfyClass || node?.type || "") !== NODE_TYPE) return;
	node.color = "#2b727e"; node.bgcolor = "#11191d"; node.boxcolor = "#6eb6c0";
	ensureSettingsPersistence(node);
	repairSerializedSettings(node);
	// ⚠️ 不再调用 writeSettingsBackup！
	// 原因：stabilizeLogic 在 onConfigure 中同步执行，此时 ComfyUI 可能尚未恢复
	// widgets_values，widget.value 可能是默认空值。如果此时调用 writeSettingsBackup，
	// 会用空值覆盖 properties 中之前保存的正确值（特别是 prompt 会被清空）。
	// writeSettingsBackup 只在 onSerialize（保存工作流）时调用即可。
}
function stabilizeUI(node) {
	// DOM 相关：依赖 widget/节点已挂载到画布，允许延后执行
	if (String(node?.comfyClass || node?.type || "") !== NODE_TYPE) return;
	hideBackendWidgets(node);
	createPanel(node);
	hookPromptWidget(node);   // ⚠️ 关键：hook prompt DOM 事件，实时同步到 properties
	syncMediaToolbar(node);
	fitPanel(node);
}
function stabilize(node) {
	stabilizeLogic(node);
	stabilizeUI(node);
}
app.registerExtension({
	name: "Comfy.GJJ.MiniMaxH3Studio",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;
		const created = nodeType.prototype.onNodeCreated; nodeType.prototype.onNodeCreated = function (...args) {
			const result = created?.apply(this, args);
			// ✅ 新节点创建：先同步执行参数逻辑（确保 writeSettingsBackup 写入正确的初始 properties）
			stabilizeLogic(this);
			// DOM 面板允许延后，确保节点已加入画布、尺寸可计算
			setTimeout(() => stabilizeUI(this), 0);
			setTimeout(() => stabilizeUI(this), 100);
			return result;
		};
		const configured = nodeType.prototype.onConfigure; nodeType.prototype.onConfigure = function (...args) {
			// ⚠️ 关键修复：onConfigure 是 ComfyUI 反序列化工作流的入口。
			// 执行顺序：ComfyUI 先按索引把 widgets_values 赋给 node.widgets[i].value（可能错位）
			//           → 调用 onConfigure → 我们立即同步调用 stabilizeLogic，它会用
			//             node.properties[SETTINGS_BACKUP_PROPERTY] 按名称覆盖所有 widget.value，
			//             从而彻底消除原生按索引恢复造成的错位。
			const result = configured?.apply(this, args);
			stabilizeLogic(this);          // 参数修复：同步执行、立即生效、不能延后
			// ⚠️ 延迟多次恢复：某些 ComfyUI 版本会在 onConfigure 之后继续恢复 widget 值
			// （如异步 DOM widget 同步），可能覆盖我们的恢复结果。
			// 通过多次延迟执行 stabilizeLogic，确保最终值始终来自 properties（按名称）。
			setTimeout(() => { stabilizeLogic(this); stabilizeUI(this); }, 0);
			setTimeout(() => { stabilizeLogic(this); stabilizeUI(this); }, 50);
			setTimeout(() => { stabilizeLogic(this); stabilizeUI(this); }, 200);
			return result;
		};
		const connections = nodeType.prototype.onConnectionsChange; nodeType.prototype.onConnectionsChange = function (...args) {
			const result = connections?.apply(this, args);
			// 仅媒体连接变化，参数值不变，所以只需要刷新 UI 即可
			setTimeout(() => { stabilizeLogic(this); stabilizeUI(this); }, 0);
			return result;
		};
		const removed = nodeType.prototype.onRemoved; nodeType.prototype.onRemoved = function (...args) { cleanup(this); return removed?.apply(this, args); };
		const serialized = nodeType.prototype.onSerialize; nodeType.prototype.onSerialize = function (data) {
			// ✅ 保存时：先同步刷新一次 properties backup（按名称），确保 data.properties 中
			// 的 SETTINGS_BACKUP_PROPERTY 是完整且按名称映射的，与节点类型解耦。
			const backup = writeSettingsBackup(this);
			this.properties[SETTINGS_SCHEMA_PROPERTY] = SETTINGS_SCHEMA_VERSION;
			const result = serialized?.apply(this, arguments);
			data.properties ||= {};
			data.properties[SETTINGS_BACKUP_PROPERTY] = backup;
			data.properties[PROMPT_BACKUP_PROPERTY] = String(backup.prompt || "");
			data.properties[SETTINGS_SCHEMA_PROPERTY] = SETTINGS_SCHEMA_VERSION;
			return result;
		};
		const executed = nodeType.prototype.onExecuted; nodeType.prototype.onExecuted = function (message) { const result = executed?.apply(this, arguments); if (this.__gjjMiniMaxPanel) this.__gjjMiniMaxPanel.status.textContent = `${message?.mode?.[0] || "视频"} 已完成`; renderResultPreview(this, message); return result; };
	},
	setup() {
		api.addEventListener("gjj_node_progress", (event) => { const detail = event?.detail || {}; for (const node of app.graph?._nodes || []) if (String(node?.comfyClass) === NODE_TYPE && String(node.id) === String(detail.node) && node.__gjjMiniMaxPanel) { node.__gjjMiniMaxPanel.status.textContent = String(detail.text || "处理中…"); if (detail.preview_media || detail.preview_video || detail.gifs || detail.animated || detail.videos || detail.video || detail.output_path) renderResultPreview(node, detail); } });
		window.addEventListener("pointerdown", (event) => { if (event.target?.closest?.(".gjj-mh3-pop,.gjj-mh3-btn")) return; for (const node of app.graph?._nodes || []) if (String(node?.comfyClass) === NODE_TYPE) closePopups(node); }, true);
	},
});
