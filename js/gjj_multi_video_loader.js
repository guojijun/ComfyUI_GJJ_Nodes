import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_MultiVideoLoader"]);
const DATA_PROPERTY = "selected_videos";
const OUTPUTS_PROPERTY = "enabled_outputs";
const TAB_PROPERTY = "active_tab";
const VIDEO_API_PATH = "/gjj/input_videos";
const VIDEO_UPLOAD_API_PATH = "/gjj/upload_video";
const VIDEO_META_API_PATH = "/gjj/video_meta";
const MAX_SELECTED_VIDEOS = 20;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 220;
const DOM_WIDGET_NAME = "gjj_multi_video_loader_dom";
const DOM_VERSION = 8;
const BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE";
const OPTIONAL_INPUT_NAME = "视频帧队列";
const OPTIONAL_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO";
const FILE_NAME_COLLATOR = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });

const PARAM_WIDGET_NAMES = new Set(["frame_rate", "width", "height", "video_format", "start_frame", "end_frame", "frame_stride", "max_frames"]);
const PARAM_WIDGET_LABELS = new Set(["帧率", "宽度", "高度", "视频格式", "起始帧", "结束帧", "抽帧间隔", "最大帧数"]);
const PARAM_WIDGET_ALIASES = new Map([
	["帧率", "frame_rate"],
	["宽度", "width"],
	["高度", "height"],
	["视频格式", "video_format"],
	["起始帧", "start_frame"],
	["结束帧", "end_frame"],
	["抽帧间隔", "frame_stride"],
	["最大帧数", "max_frames"],
]);
const PARAM_DEFS = [
	{ name: "frame_rate", label: "帧率", kind: "number", step: "0.01", min: "1", tip: "最终输出帧率。" },
	{ name: "width", label: "宽度", kind: "number", step: "8", min: "0", tip: "0 表示跟随源视频；只填宽度会按比例计算高度。" },
	{ name: "height", label: "高度", kind: "number", step: "8", min: "0", tip: "0 表示跟随源视频；只填高度会按比例计算宽度。" },
	{ name: "video_format", label: "视频格式", kind: "select", tip: "格式参数命名参考 VHS_VideoCombine。" },
	{ name: "start_frame", label: "起始帧", kind: "number", step: "1", min: "0", tip: "从第几帧开始读取。" },
	{ name: "end_frame", label: "结束帧", kind: "number", step: "1", min: "0", tip: "0 表示读取到末尾或达到最大帧数。" },
	{ name: "frame_stride", label: "抽帧间隔", kind: "number", step: "1", min: "1", tip: "每隔多少帧取一帧。" },
	{ name: "max_frames", label: "最大帧数", kind: "number", step: "1", min: "1", tip: "每个视频最多解码多少帧。" },
];
const FALLBACK_FORMATS = ["video/h264-mp4", "video/webm", "image/gif", "image/webp"];
const TAB_DEFS = [
	{ key: "video", icon: "🎬", label: "视频", tip: "选择、导入、预览视频。" },
	{ key: "params", icon: "⚙️", label: "参数", tip: "显示帧率、尺寸、起止帧、抽帧间隔和最大帧数。" },
	{ key: "outputs", icon: "🔌", label: "输出", tip: "按需扩充输出接口，只保留当前需要的输出口。" },
];

const OUTPUT_DEFS = [
	{ key: "first_frame", name: "首帧预览", type: "IMAGE" },
	{ key: "last_frame", name: "尾帧预览", type: "IMAGE" },
	{ key: "info_json", name: "视频信息JSON", type: "STRING" },
	{ key: "frame_rate", name: "帧率", type: "FLOAT" },
	{ key: "frame_count", name: "输出帧数", type: "INT" },
	{ key: "source_duration", name: "源时长", type: "FLOAT" },
	{ key: "width", name: "宽度", type: "INT" },
	{ key: "height", name: "高度", type: "INT" },
	{ key: "video_format", name: "视频格式", type: "STRING" },
];

function parseJsonArray(rawValue, fallback = []) {
	try {
		const parsed = JSON.parse(String(rawValue || "[]"));
		return Array.isArray(parsed) ? parsed : fallback;
	} catch (error) {
		return fallback;
	}
}

function parseSelection(rawValue) {
	return parseJsonArray(rawValue).filter((item) => item && typeof item === "object");
}

function parseEnabledOutputs(rawValue) {
	const keys = new Set(OUTPUT_DEFS.map((item) => item.key));
	return parseJsonArray(rawValue).filter((key) => keys.has(String(key)));
}

function serializeSelection(selection) {
	return JSON.stringify(
		(selection || []).map((item) => ({
			filename: String(item?.filename || ""),
			subfolder: String(item?.subfolder || ""),
		})),
	);
}

function serializeOutputs(outputs) {
	return JSON.stringify(parseEnabledOutputs(JSON.stringify(outputs || [])));
}

function itemKey(item) {
	return `${String(item?.subfolder || "")}/${String(item?.filename || "")}`;
}

function selectedFromNode(node, serializedNode = null) {
	const propertyValue = String(node?.properties?.[DATA_PROPERTY] || "");
	if (parseSelection(propertyValue).length > 0) {
		return propertyValue;
	}
	const serializedProperty = String(serializedNode?.properties?.[DATA_PROPERTY] || "");
	if (parseSelection(serializedProperty).length > 0) {
		return serializedProperty;
	}
	return propertyValue || serializedProperty || "[]";
}

function outputsFromNode(node, serializedNode = null) {
	const propertyValue = String(node?.properties?.[OUTPUTS_PROPERTY] || "");
	if (parseEnabledOutputs(propertyValue).length > 0) {
		return propertyValue;
	}
	const serializedProperty = String(serializedNode?.properties?.[OUTPUTS_PROPERTY] || "");
	if (parseEnabledOutputs(serializedProperty).length > 0) {
		return serializedProperty;
	}
	return propertyValue || serializedProperty || "[]";
}

function requestRedraw(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function ensureState(node) {
	node.properties = node.properties || {};
	node.__gjjMultiVideoState = node.__gjjMultiVideoState || {
		options: [],
		formats: [],
		selection: parseSelection(selectedFromNode(node)),
		enabledOutputs: parseEnabledOutputs(outputsFromNode(node)),
		executedFrames: [],
		executedFrameCount: 0,
		sourceFps: 0,
		outputWidth: 0,
		outputHeight: 0,
		videoFormat: "",
		activeTab: String(node.properties?.[TAB_PROPERTY] || "video"),
	};
	return node.__gjjMultiVideoState;
}

function syncProperties(node) {
	const state = ensureState(node);
	node.properties = node.properties || {};
	node.properties[DATA_PROPERTY] = serializeSelection(state.selection);
	node.properties[OUTPUTS_PROPERTY] = serializeOutputs(state.enabledOutputs);
	node.properties[TAB_PROPERTY] = TAB_DEFS.some((tab) => tab.key === state.activeTab) ? state.activeTab : "video";
}

function formatMeta(item) {
	const parts = [];
	const width = Number(item?.width || 0);
	const height = Number(item?.height || 0);
	const fps = Number(item?.fps || 0);
	const frames = Number(item?.frames || 0);
	const duration = Number(item?.duration || 0);
	if (width > 0 && height > 0) parts.push(`${width}×${height}`);
	if (fps > 0) parts.push(`${fps.toFixed(fps >= 10 ? 1 : 2)} FPS`);
	if (frames > 0) parts.push(`${frames} 帧`);
	if (duration > 0) parts.push(`${duration.toFixed(1)} 秒`);
	return parts.join(" · ") || "未读取到媒体信息";
}

async function fetchOptions() {
	try {
		const response = await fetch(api.apiURL(VIDEO_API_PATH));
		if (!response.ok) return { videos: [], formats: [] };
		const data = await response.json();
		return {
			videos: Array.isArray(data?.videos) ? data.videos : [],
			formats: Array.isArray(data?.formats) ? data.formats : [],
		};
	} catch (error) {
		return { videos: [], formats: [] };
	}
}

function inputVideoUrl(item) {
	if (!item?.filename) return "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : "";
	return api.apiURL(`/view?filename=${encodeURIComponent(item.filename)}&type=input&subfolder=${encodeURIComponent(item.subfolder || "")}${randParam}`);
}

function imageDataToUrl(item) {
	if (!item?.filename) return "";
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : "";
	return api.apiURL(`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "temp")}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`);
}

async function fetchMediaMeta(item) {
	if (!item?.filename) return item || null;
	const hasUsableMeta = Number(item.width || 0) > 0 && Number(item.height || 0) > 0 && Number(item.fps || 0) > 0;
	if (hasUsableMeta) return item;
	try {
		const url = api.apiURL(`${VIDEO_META_API_PATH}?filename=${encodeURIComponent(item.filename)}&subfolder=${encodeURIComponent(item.subfolder || "")}`);
		const response = await fetch(url);
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(payload?.error || "解析媒体信息失败");
		return { ...item, ...payload };
	} catch (error) {
		return item;
	}
}

function widgetNames(widget) {
	return [
		widget?.name,
		widget?.label,
		widget?.options?.display_name,
		widget?.options?.displayName,
		widget?.display_name,
		widget?.displayName,
	].filter((value) => value != null).map((value) => String(value));
}

function isNativeParamWidget(widget) {
	if (!widget || widget.name === DOM_WIDGET_NAME) return false;
	const names = widgetNames(widget);
	return names.some((name) => PARAM_WIDGET_NAMES.has(name) || PARAM_WIDGET_LABELS.has(name));
}

function normalizeParamWidgetName(name) {
	const text = String(name || "");
	return PARAM_WIDGET_NAMES.has(text) ? text : (PARAM_WIDGET_ALIASES.get(text) || text);
}

function findWidget(node, name) {
	const wanted = normalizeParamWidgetName(name);
	return (node.widgets || []).find((widget) => {
		if (!widget || widget.name === DOM_WIDGET_NAME) return false;
		const names = widgetNames(widget);
		return names.some((item) => normalizeParamWidgetName(item) === wanted);
	});
}

function hasLinkedInput(node, name) {
	return (node.inputs || []).some((input) => input?.name === name && input.link != null);
}

function setWidgetValue(node, name, value, force = false) {
	if (!force && hasLinkedInput(node, name)) return;
	const widget = findWidget(node, name);
	if (!widget) return;
	widget.value = value;
	widget.callback?.(value, app.canvas, node, app.canvas?.graph_mouse);
}

function guessFormatFromFilename(node, item) {
	const state = ensureState(node);
	const formats = Array.isArray(state.formats) ? state.formats : [];
	const name = String(item?.filename || "").toLowerCase();
	let guessed = "video/h264-mp4";
	if (name.endsWith(".gif")) guessed = "image/gif";
	else if (name.endsWith(".webp")) guessed = "image/webp";
	else if (name.endsWith(".webm")) guessed = "video/webm";
	else if (name.endsWith(".mkv")) guessed = "video/h264-mp4";
	else if (name.endsWith(".mov") || name.endsWith(".m4v") || name.endsWith(".mp4")) guessed = "video/h264-mp4";
	return formats.includes(guessed) ? guessed : (formats[0] || guessed);
}

function getPrimarySelectedItem(node) {
	const state = ensureState(node);
	const optionByKey = new Map((state.options || []).map((item) => [itemKey(item), item]));
	const select = node.__gjjMultiVideoSelect;
	const fromDropdown = select?.value ? optionByKey.get(select.value) : null;
	if (fromDropdown) return fromDropdown;
	return state.selection.length ? (optionByKey.get(itemKey(state.selection[0])) || state.selection[0]) : null;
}

async function applyMediaInfoToPanel(node, force = false, preferredItem = null) {
	let first = preferredItem || getPrimarySelectedItem(node);
	if (!first) {
		setSummary(node, "请先选择或加入一个视频，再提取媒体信息。");
		return false;
	}
	setSummary(node, "正在解析视频参数...");
	first = await fetchMediaMeta(first);
	const state = ensureState(node);
	const key = itemKey(first);
	state.options = (state.options || []).map((item) => itemKey(item) === key ? { ...item, ...first } : item);
	state.selection = (state.selection || []).map((item) => itemKey(item) === key ? { ...item, ...first } : item);
	syncProperties(node);
	const fps = Number(first.fps || 0);
	const width = Number(first.width || 0);
	const height = Number(first.height || 0);
	if (fps > 0) setWidgetValue(node, "frame_rate", Number(fps.toFixed(3)), force);
	if (width > 0) setWidgetValue(node, "width", Math.round(width), force);
	if (height > 0) setWidgetValue(node, "height", Math.round(height), force);
	setWidgetValue(node, "video_format", guessFormatFromFilename(node, first), force);
	setSummary(node, `已提取：${fps > 0 ? fps.toFixed(2) + " FPS" : "帧率未知"}${width > 0 && height > 0 ? `，${width}×${height}` : ""}`);
	renderParamControls(node);
	requestRedraw(node);
	return true;
}

function syncPanelValuesFromSelection(node) {
	applyMediaInfoToPanel(node, false).then(() => {
		renderSelected(node);
		renderParamControls(node);
		scheduleLayout(node);
	});
}

function setSummary(node, text) {
	if (node.__gjjMultiVideoSummary) node.__gjjMultiVideoSummary.textContent = text;
	requestRedraw(node);
}

function buttonStyle(active = false) {
	return [
		"height:24px",
		"min-width:28px",
		"padding:0 8px",
		"box-sizing:border-box",
		`border:1px solid ${active ? "#2ec4b6" : "#465761"}`,
		"border-radius:6px",
		`background:${active ? "#123432" : "#1a2328"}`,
		`color:${active ? "#eafffb" : "#dce7e2"}`,
		"font-size:14px",
		"line-height:22px",
		"cursor:pointer",
		"white-space:nowrap",
		"display:inline-flex",
		"align-items:center",
		"justify-content:center",
	].join(";");
}

function setIconButton(button, icon, title, description) {
	button.textContent = icon;
	button.setAttribute("aria-label", title);
	button.title = `${title}\n${description}`;
}


function tabButtonStyle(active = false) {
	return [
		"height:26px",
		"padding:0 10px",
		`border:1px solid ${active ? "#2ec4b6" : "#465761"}`,
		"border-radius:8px",
		`background:${active ? "#123432" : "#11181c"}`,
		`color:${active ? "#eafffb" : "#dce7e2"}`,
		"font-size:12px",
		"cursor:pointer",
		"display:inline-flex",
		"align-items:center",
		"justify-content:center",
		"gap:4px",
		"white-space:nowrap",
	].join(";");
}

function setActiveTab(node, tabKey) {
	const state = ensureState(node);
	state.activeTab = TAB_DEFS.some((tab) => tab.key === tabKey) ? tabKey : "video";
	syncProperties(node);
	renderTabs(node);
	applyWidgetTabVisibility(node);
	scheduleLayout(node);
}

function renderTabs(node) {
	const state = ensureState(node);
	const tabs = node.__gjjMultiVideoTabs;
	if (!tabs) return;
	tabs.replaceChildren();
	for (const tab of TAB_DEFS) {
		const active = state.activeTab === tab.key;
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = `${tab.icon} ${tab.label}`;
		button.title = tab.tip;
		button.style.cssText = tabButtonStyle(active);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setActiveTab(node, tab.key);
		});
		tabs.appendChild(button);
	}
	if (node.__gjjMultiVideoVideoPanel) node.__gjjMultiVideoVideoPanel.style.display = state.activeTab === "video" ? "flex" : "none";
	if (node.__gjjMultiVideoParamPanel) node.__gjjMultiVideoParamPanel.style.display = state.activeTab === "params" ? "flex" : "none";
	if (node.__gjjMultiVideoOutputPanel) node.__gjjMultiVideoOutputPanel.style.display = state.activeTab === "outputs" ? "flex" : "none";
}

function hideWidgetCompletely(widget) {
	if (!widget) return;
	if (!widget.__gjjOriginalHiddenPatch) {
		widget.__gjjOriginalHiddenPatch = {
			type: widget.type,
			draw: widget.draw,
			computeSize: widget.computeSize,
			label: widget.label,
		};
	}

	// 完整隐藏原生 Python widget：只设 hidden=true 不够，LiteGraph 仍可能用
	// last_y / computedHeight / size 参与布局，从而在底部挤出空行。
	widget.type = "hidden";
	widget.hidden = true;
	widget.disabled = true;
	widget.advanced = true;
	widget.serialize = true;
	widget.options = widget.options || {};
	widget.options.hidden = true;
	widget.options.display = "hidden";
	widget.options.widget = "hidden";
	widget.options.forceInput = false;
	widget.computeSize = () => [0, 0];
	widget.draw = () => {};
	widget.label = "";
	widget.last_y = 0;
	widget.computedHeight = 0;
	widget.margin_top = 0;
	widget.size = [0, 0];

	for (const key of ["inputEl", "element", "widget"]) {
		const element = widget[key];
		if (!element?.style) continue;
		element.style.display = "none";
		element.style.height = "0";
		element.style.minHeight = "0";
		element.style.maxHeight = "0";
		element.style.margin = "0";
		element.style.padding = "0";
		element.style.border = "0";
		element.style.overflow = "hidden";
	}
}

function forceHideNativeParamWidgets(node) {
	if (!node?.widgets) return;
	for (const widget of node.widgets) {
		if (!isNativeParamWidget(widget)) continue;
		hideWidgetCompletely(widget);
	}
	requestRedraw(node);
}

function getParamOptions(node, name) {
	const widget = findWidget(node, name);
	if (Array.isArray(widget?.options?.values)) return widget.options.values;
	if (Array.isArray(widget?.options)) return widget.options;
	if (name === "video_format") {
		const formats = ensureState(node).formats || [];
		return formats.length ? formats : FALLBACK_FORMATS;
	}
	return [];
}

function getWidgetValue(node, name) {
	return findWidget(node, name)?.value;
}

function makeParamControl(node, def) {
	const row = document.createElement("label");
	row.style.cssText = "display:grid;grid-template-columns:72px minmax(0,1fr);gap:8px;align-items:center;font-size:11px;color:#dce7e2;";
	row.title = def.tip || "";
	const label = document.createElement("span");
	label.textContent = def.label;
	label.style.cssText = "white-space:nowrap;color:#aebbc2;";
	let input;
	if (def.kind === "select") {
		input = document.createElement("select");
		input.style.cssText = "width:100%;min-width:0;height:26px;border:1px solid #465761;border-radius:7px;background:#11181c;color:#dce7e2;font-size:11px;padding:0 6px;box-sizing:border-box;";
	} else {
		input = document.createElement("input");
		input.type = "number";
		input.step = def.step || "1";
		input.min = def.min || "0";
		input.style.cssText = "width:100%;min-width:0;height:26px;border:1px solid #465761;border-radius:7px;background:#11181c;color:#dce7e2;font-size:11px;padding:0 7px;box-sizing:border-box;";
	}
	input.dataset.widgetName = def.name;
	input.addEventListener("pointerdown", (event) => event.stopPropagation());
	input.addEventListener("change", (event) => {
		event.stopPropagation();
		let value = input.value;
		if (def.kind !== "select") value = def.step === "0.01" ? Number.parseFloat(value || "0") : Number.parseInt(value || "0", 10);
		setWidgetValue(node, def.name, Number.isNaN(value) ? 0 : value);
		renderParamControls(node);
	});
	row.appendChild(label);
	row.appendChild(input);
	return row;
}

function renderParamControls(node) {
	const box = node.__gjjMultiVideoParamControls;
	if (!box) return;
	if (!box.__built) {
		box.replaceChildren();
		for (const def of PARAM_DEFS) box.appendChild(makeParamControl(node, def));
		box.__built = true;
	}
	for (const def of PARAM_DEFS) {
		const input = box.querySelector(`[data-widget-name="${def.name}"]`);
		if (!input) continue;
		const linked = hasLinkedInput(node, def.name);
		input.disabled = linked;
		input.title = linked ? `${def.label} 已连接外部输入，面板内不可覆盖。` : (def.tip || "");
		if (def.kind === "select") {
			const current = String(getWidgetValue(node, def.name) ?? "");
			const options = getParamOptions(node, def.name);
			input.replaceChildren();
			for (const value of options) {
				const option = document.createElement("option");
				option.value = String(value);
				option.textContent = String(value);
				input.appendChild(option);
			}
			input.value = current;
		} else {
			input.value = String(getWidgetValue(node, def.name) ?? 0);
		}
	}
}

function applyWidgetTabVisibility(node) {
	forceHideNativeParamWidgets(node);
	renderParamControls(node);
}

function isSelected(state, item) {
	return state.selection.some((selected) => itemKey(selected) === itemKey(item));
}

function addSelection(node, item) {
	const state = ensureState(node);
	if (!item?.filename || isSelected(state, item) || state.selection.length >= MAX_SELECTED_VIDEOS) return;
	state.selection.push(item);
	syncProperties(node);
	syncPanelValuesFromSelection(node);
	renderAll(node);
}

function removeSelection(node, item) {
	const state = ensureState(node);
	state.selection = state.selection.filter((selected) => itemKey(selected) !== itemKey(item));
	syncProperties(node);
	syncPanelValuesFromSelection(node);
	renderAll(node);
}

function toggleOutput(node, key) {
	const state = ensureState(node);
	if (state.enabledOutputs.includes(key)) {
		state.enabledOutputs = state.enabledOutputs.filter((item) => item !== key);
	} else {
		state.enabledOutputs.push(key);
	}
	syncProperties(node);
	applyDynamicOutputs(node);
	renderOutputButtons(node);
	requestRedraw(node);
}

function makeSelectedCard(node, item) {
	const wrap = document.createElement("div");
	wrap.title = `${String(item?.label || item?.filename || "未命名视频")}\n${formatMeta(item)}`;
	wrap.style.cssText = [
		"position:relative",
		"display:flex",
		"min-width:0",
		"padding:6px",
		"border:1px solid #33434a",
		"border-radius:8px",
		"background:#12191d",
		"box-sizing:border-box",
	].join(";");

	const video = document.createElement("video");
	video.src = inputVideoUrl(item);
	video.muted = true;
	video.controls = false;
	video.preload = "metadata";
	video.playsInline = true;
	video.style.cssText = "width:100%;height:104px;object-fit:contain;background:#05080a;border-radius:6px;display:block;";
	video.addEventListener("mouseenter", () => video.play?.().catch(() => {}));
	video.addEventListener("mouseleave", () => { video.pause?.(); video.currentTime = 0; });

	const removeButton = document.createElement("button");
	removeButton.type = "button";
	setIconButton(removeButton, "🗑️", "移除", "从已选视频中移除此项，不删除 input 目录里的源文件。");
	removeButton.style.cssText = [
		"position:absolute",
		"top:9px",
		"right:9px",
		"width:26px",
		"height:26px",
		"padding:0",
		"border:1px solid rgba(255,255,255,.35)",
		"border-radius:999px",
		"background:rgba(0,0,0,.58)",
		"color:#fff",
		"font-size:14px",
		"line-height:24px",
		"cursor:pointer",
		"display:flex",
		"align-items:center",
		"justify-content:center",
	].join(";");
	removeButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		removeSelection(node, item);
	});

	const extractButton = document.createElement("button");
	extractButton.type = "button";
	setIconButton(extractButton, "🧾", "覆盖面板参数", "读取这个视频的帧率、宽度、高度和格式，并覆盖到参数面板。外部连接的参数不会被覆盖。");
	extractButton.style.cssText = removeButton.style.cssText.replace("top:9px", "top:40px");
	extractButton.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		await applyMediaInfoToPanel(node, true, item);
		renderSelected(node);
		renderParamControls(node);
		scheduleLayout(node);
	});

	wrap.appendChild(video);
	wrap.appendChild(removeButton);
	wrap.appendChild(extractButton);
	return wrap;
}

function renderVideoDropdown(node) {
	const state = ensureState(node);
	const select = node.__gjjMultiVideoSelect;
	if (!select) return;
	const current = select.value;
	select.replaceChildren();
	const placeholder = document.createElement("option");
	placeholder.value = "";
	placeholder.textContent = state.options.length ? "选择 input 视频..." : "没有可选视频";
	select.appendChild(placeholder);
	const selectedKeys = new Set(state.selection.map(itemKey));
	for (const item of state.options || []) {
		const option = document.createElement("option");
		option.value = itemKey(item);
		option.textContent = `${selectedKeys.has(itemKey(item)) ? "✓ " : ""}${item.label || item.filename}`;
		select.appendChild(option);
	}
	select.value = current && [...select.options].some((option) => option.value === current) ? current : "";
}

function removeElementRef(node, key) {
	const element = node?.[key];
	if (element?.parentElement) element.parentElement.removeChild(element);
	node[key] = null;
}

function ensureLazyGrid(node, wrapKey, gridKey, gridStyle) {
	const container = node.__gjjMultiVideoVideoPanel || node.__gjjMultiVideoContainer;
	if (!container) return null;
	let wrap = node[wrapKey];
	let grid = node[gridKey];
	if (!wrap || !grid) {
		wrap = document.createElement("div");
		wrap.style.cssText = "display:grid;box-sizing:border-box;";
		grid = document.createElement("div");
		grid.style.cssText = gridStyle;
		wrap.appendChild(grid);
		container.appendChild(wrap);
		node[wrapKey] = wrap;
		node[gridKey] = grid;
	}
	return grid;
}

function renderSelected(node) {
	const state = ensureState(node);
	if (!state.selection.length) {
		removeElementRef(node, "__gjjMultiVideoSelectedWrap");
		node.__gjjMultiVideoSelected = null;
		return;
	}
	const list = ensureLazyGrid(
		node,
		"__gjjMultiVideoSelectedWrap",
		"__gjjMultiVideoSelected",
		"display:grid;grid-template-columns:repeat(auto-fill, minmax(150px, 1fr));gap:6px;"
	);
	if (!list) return;
	list.replaceChildren();
	const optionByKey = new Map((state.options || []).map((item) => [itemKey(item), item]));
	for (const item of state.selection) {
		list.appendChild(makeSelectedCard(node, optionByKey.get(itemKey(item)) || item));
	}
}

function renderExecutedPreview(node) {
	const state = ensureState(node);
	const items = Array.isArray(state.executedFrames) ? state.executedFrames : [];
	if (!items.length) {
		removeElementRef(node, "__gjjMultiVideoPreviewWrap");
		node.__gjjMultiVideoPreviewGrid = null;
		return;
	}
	const grid = ensureLazyGrid(
		node,
		"__gjjMultiVideoPreviewWrap",
		"__gjjMultiVideoPreviewGrid",
		"display:grid;grid-template-columns:repeat(auto-fill, minmax(88px, 1fr));gap:6px;"
	);
	if (!grid) return;
	grid.replaceChildren();
	for (const item of items) {
		const image = document.createElement("img");
		image.src = imageDataToUrl(item);
		image.draggable = false;
		image.style.cssText = "width:100%;height:72px;object-fit:contain;background:#0c1114;border-radius:6px;display:block;";
		grid.appendChild(image);
	}
}

function renderOutputButtons(node) {
	const state = ensureState(node);
	const wrap = node.__gjjMultiVideoOutputButtons;
	if (!wrap) return;
	wrap.replaceChildren();
	for (const def of OUTPUT_DEFS) {
		const active = state.enabledOutputs.includes(def.key);
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = active ? `✓ ${def.name}` : def.name;
		button.title = `点击${active ? "隐藏" : "显示"}输出口：${def.name}`;
		button.style.cssText = buttonStyle(active);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			toggleOutput(node, def.key);
		});
		wrap.appendChild(button);
	}
}

function updateSummary(node) {
	const state = ensureState(node);
	const selectedCount = Number(state.selection?.length || 0);
	const frameCount = Number(state.executedFrameCount || 0);
	if (!node.__gjjMultiVideoSummary) return;
	if (frameCount > 0) {
		const fps = Number(state.sourceFps || 0);
		const wh = state.outputWidth > 0 && state.outputHeight > 0 ? `，${state.outputWidth}×${state.outputHeight}` : "";
		node.__gjjMultiVideoSummary.textContent = `已选 ${selectedCount} 个，输出 ${frameCount} 帧${wh}${fps > 0 ? `，源帧率 ${fps.toFixed(2)}` : ""}`;
		return;
	}
	node.__gjjMultiVideoSummary.textContent = selectedCount > 0
		? `已选 ${selectedCount} / ${MAX_SELECTED_VIDEOS} 个视频`
		: "从下拉框选择 input 视频，或点击导入视频";
}

function visibleChildrenHeight(element) {
	if (!element) return 0;
	const style = getComputedStyle(element);
	if (style.display === "none") return 0;
	const children = Array.from(element.children || []).filter((child) => getComputedStyle(child).display !== "none");
	if (!children.length) return Math.ceil(element.offsetHeight || 0);
	let total = 0;
	for (const child of children) total += Math.ceil(child.offsetHeight || child.scrollHeight || 0);
	const gap = Number.parseFloat(style.rowGap || style.gap || "0") || 0;
	if (children.length > 1) total += gap * (children.length - 1);
	const pt = Number.parseFloat(style.paddingTop || "0") || 0;
	const pb = Number.parseFloat(style.paddingBottom || "0") || 0;
	return Math.ceil(total + pt + pb);
}

function measureHeight(node) {
	const container = node.__gjjMultiVideoContainer;
	if (!container) return MIN_HEIGHT;
	const contentHeight = visibleChildrenHeight(container);
	return Math.max(MIN_HEIGHT, contentHeight + 12);
}

function updateLayout(node) {
	updateSummary(node);
	const width = Math.max(MIN_WIDTH, Number(node.size?.[0] || MIN_WIDTH));
	const height = measureHeight(node);
	node.setSize?.([width, height]);
	if (node.__gjjMultiVideoWidget) node.__gjjMultiVideoWidget.last_y = 0;
	requestRedraw(node);
}

function scheduleLayout(node) {
	if (!node || node.__gjjMultiVideoLayoutQueued) return;
	node.__gjjMultiVideoLayoutQueued = true;
	requestAnimationFrame(() => {
		node.__gjjMultiVideoLayoutQueued = false;
		updateLayout(node);
	});
}

function renderAll(node) {
	renderTabs(node);
	applyWidgetTabVisibility(node);
	renderVideoDropdown(node);
	renderSelected(node);
	renderExecutedPreview(node);
	renderOutputButtons(node);
	updateSummary(node);
	scheduleLayout(node);
}

async function refreshOptions(node) {
	const state = ensureState(node);
	const payload = await fetchOptions();
	state.options = payload.videos;
	state.formats = payload.formats;
	renderAll(node);
}

async function uploadFiles(node, files) {
	const list = Array.from(files || [])
		.filter((file) => file instanceof File)
		.sort((a, b) => FILE_NAME_COLLATOR.compare(a.name || "", b.name || ""));
	if (!list.length) return;
	const state = ensureState(node);
	setSummary(node, `正在导入 ${list.length} 个视频...`);

	const uploaded = [];
	for (const file of list) {
		const formData = new FormData();
		formData.append("video", file, file.name);
		const response = await fetch(api.apiURL(VIDEO_UPLOAD_API_PATH), { method: "POST", body: formData });
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(payload?.error || `上传失败：${file.name}`);
		for (const item of payload?.videos || []) uploaded.push(item);
	}

	await refreshOptions(node);
	const optionByKey = new Map((state.options || []).map((item) => [itemKey(item), item]));
	for (const item of uploaded) {
		if (state.selection.length >= MAX_SELECTED_VIDEOS) break;
		const full = optionByKey.get(itemKey(item)) || item;
		if (!state.selection.some((selected) => itemKey(selected) === itemKey(full))) state.selection.push(full);
	}
	syncProperties(node);
	syncPanelValuesFromSelection(node);
	renderAll(node);
}

function buildDom(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"width:100%",
		"height:auto",
		"box-sizing:border-box",
		"padding:6px 0 0 0",
	].join(";");

	const tabs = document.createElement("div");
	tabs.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;border:1px solid #33434a;border-radius:10px;background:#0f1418;padding:6px;box-sizing:border-box;";

	const videoPanel = document.createElement("div");
	videoPanel.style.cssText = "display:flex;flex-direction:column;gap:8px;";

	const paramPanel = document.createElement("div");
	paramPanel.style.cssText = "display:none;flex-direction:column;gap:7px;border:1px solid #33434a;border-radius:10px;background:#0f1418;padding:8px;box-sizing:border-box;";
	const paramControls = document.createElement("div");
	paramControls.style.cssText = "display:flex;flex-direction:column;gap:7px;";
	paramPanel.appendChild(paramControls);

	const outputPanel = document.createElement("div");
	outputPanel.style.cssText = "display:none;flex-direction:column;gap:8px;";

	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-width:0;";

	const select = document.createElement("select");
	select.style.cssText = [
		"height:24px",
		"width:100%",
		"min-width:0",
		"max-width:100%",
		"flex:1 1 100%",
		"border:1px solid #465761",
		"border-radius:6px",
		"background:#11181c",
		"color:#dce7e2",
		"font-size:11px",
		"padding:0 8px",
		"box-sizing:border-box",
	].join(";");
	select.addEventListener("pointerdown", (event) => event.stopPropagation());
	select.addEventListener("change", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const state = ensureState(node);
		const selected = (state.options || []).find((item) => itemKey(item) === select.value);
		if (selected) addSelection(node, selected);
		select.value = "";
	});

	const uploadButton = document.createElement("button");
	uploadButton.type = "button";
	setIconButton(uploadButton, "📥", "导入视频", "从本地选择一个或多个视频，复制到 ComfyUI input/gjj_multi_video_loader 后自动加入。");
	uploadButton.style.cssText = buttonStyle(false);

	const refreshButton = document.createElement("button");
	refreshButton.type = "button";
	setIconButton(refreshButton, "🔄", "刷新", "重新扫描 ComfyUI input 目录中的视频文件，并更新下拉列表。");
	refreshButton.style.cssText = buttonStyle(false);
	refreshButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		refreshOptions(node);
	});

	const extractInfoButton = document.createElement("button");
	extractInfoButton.type = "button";
	setIconButton(extractInfoButton, "🧾", "提取信息到面板", "读取当前下拉或首个已选视频的帧率、宽度、高度和格式，并覆盖面板参数。优先使用后端扫描到的媒体信息。");
	extractInfoButton.style.cssText = buttonStyle(false);
	extractInfoButton.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		await applyMediaInfoToPanel(node, true);
		renderSelected(node);
		scheduleLayout(node);
	});

	const clearButton = document.createElement("button");
	clearButton.type = "button";
	setIconButton(clearButton, "🧹", "清空", "清空当前已选视频和执行后的预览缓存。不会删除 input 目录里的视频文件。");
	clearButton.style.cssText = buttonStyle(false);
	clearButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const state = ensureState(node);
		state.selection = [];
		state.executedFrames = [];
		state.executedFrameCount = 0;
		syncProperties(node);
		renderAll(node);
	});

	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = "video/*,.gif,.mkv,.webm,.mov,.m4v,.avi,.wmv,.flv";
	fileInput.multiple = true;
	fileInput.style.display = "none";
	fileInput.addEventListener("click", (event) => event.stopPropagation());
	fileInput.addEventListener("change", async (event) => {
		event.stopPropagation();
		const files = Array.from(event.target?.files || []);
		fileInput.value = "";
		if (!files.length) return;
		try {
			await uploadFiles(node, files);
		} catch (error) {
			setSummary(node, error?.message || "导入视频失败");
		}
	});
	uploadButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		fileInput.click();
	});

	const summary = document.createElement("div");
	summary.style.cssText = "font-size:11px;color:#dce7e2;flex:1 1 100%;";

	toolbar.appendChild(select);
	toolbar.appendChild(uploadButton);
	toolbar.appendChild(refreshButton);
	toolbar.appendChild(extractInfoButton);
	toolbar.appendChild(clearButton);
	toolbar.appendChild(summary);

	const outputWrap = document.createElement("div");
	outputWrap.style.cssText = "display:flex;flex-direction:column;gap:6px;border:1px solid #33434a;border-radius:10px;background:#0f1418;padding:8px;box-sizing:border-box;";
	const outputTitle = document.createElement("div");
	outputTitle.textContent = "扩充输出口（第一个“视频帧队列”始终保留）";
	outputTitle.style.cssText = "font-size:11px;color:#dce7e2;font-weight:600;";
	const outputButtons = document.createElement("div");
	outputButtons.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;";
	outputWrap.appendChild(outputTitle);
	outputWrap.appendChild(outputButtons);

	videoPanel.appendChild(toolbar);
	outputPanel.appendChild(outputWrap);
	container.appendChild(tabs);
	container.appendChild(videoPanel);
	container.appendChild(paramPanel);
	container.appendChild(outputPanel);
	container.appendChild(fileInput);

	node.__gjjMultiVideoContainer = container;
	node.__gjjMultiVideoTabs = tabs;
	node.__gjjMultiVideoVideoPanel = videoPanel;
	node.__gjjMultiVideoParamPanel = paramPanel;
	node.__gjjMultiVideoOutputPanel = outputPanel;
	node.__gjjMultiVideoSelect = select;
	node.__gjjMultiVideoSummary = summary;
	node.__gjjMultiVideoOutputButtons = outputButtons;
	node.__gjjMultiVideoParamControls = paramControls;
	node.__gjjMultiVideoSelectedWrap = null;
	node.__gjjMultiVideoSelected = null;
	node.__gjjMultiVideoPreviewWrap = null;
	node.__gjjMultiVideoPreviewGrid = null;
	node.__gjjMultiVideoFileInput = fileInput;
	return container;
}

function destroyDomWidget(node) {
	if (!node) return;
	const widget = node.__gjjMultiVideoWidget;
	if (widget && Array.isArray(node.widgets)) {
		const index = node.widgets.indexOf(widget);
		if (index >= 0) node.widgets.splice(index, 1);
	}
	node.__gjjMultiVideoContainer?.remove?.();
	node.__gjjMultiVideoWidget = null;
	node.__gjjMultiVideoContainer = null;
	node.__gjjMultiVideoTabs = null;
	node.__gjjMultiVideoVideoPanel = null;
	node.__gjjMultiVideoParamPanel = null;
	node.__gjjMultiVideoOutputPanel = null;
	node.__gjjMultiVideoSelect = null;
	node.__gjjMultiVideoSummary = null;
	node.__gjjMultiVideoOutputButtons = null;
	node.__gjjMultiVideoParamControls = null;
	node.__gjjMultiVideoSelectedWrap = null;
	node.__gjjMultiVideoSelected = null;
	node.__gjjMultiVideoPreviewWrap = null;
	node.__gjjMultiVideoPreviewGrid = null;
	node.__gjjMultiVideoFileInput = null;
}

function ensureDomWidget(node) {
	if (node.__gjjMultiVideoWidget && node.__gjjMultiVideoDomVersion === DOM_VERSION) return node.__gjjMultiVideoWidget;
	if (node.__gjjMultiVideoWidget) destroyDomWidget(node);
	const container = buildDom(node);
	const widget = node.addDOMWidget(DOM_WIDGET_NAME, "HTML", container, { serialize: false, hideOnZoom: false });
	widget.computeSize = (width) => [Math.max(MIN_WIDTH, Number(width || MIN_WIDTH)), Math.max(MIN_HEIGHT, measureHeight(node))];
	widget.draw = () => {};
	node.__gjjMultiVideoWidget = widget;
	node.__gjjMultiVideoDomVersion = DOM_VERSION;
	return widget;
}


function ensureOptionalInput(node) {
	if (!node) return;
	let input = (node.inputs || []).find((item) => item?.name === OPTIONAL_INPUT_NAME);
	if (!input) {
		node.addInput?.(OPTIONAL_INPUT_NAME, OPTIONAL_INPUT_TYPE);
		input = (node.inputs || []).find((item) => item?.name === OPTIONAL_INPUT_NAME);
	}
	if (input) {
		input.name = OPTIONAL_INPUT_NAME;
		input.label = OPTIONAL_INPUT_NAME;
		input.localized_name = OPTIONAL_INPUT_NAME;
		input.type = OPTIONAL_INPUT_TYPE;
	}
}

function moveDomWidgetToTop(node) {
	const widget = node?.__gjjMultiVideoWidget;
	if (!widget || !Array.isArray(node.widgets)) return;
	const index = node.widgets.indexOf(widget);
	if (index > 0) {
		node.widgets.splice(index, 1);
		node.widgets.unshift(widget);
	}
}

function applyDynamicOutputs(node) {
	if (!node) return;
	const state = ensureState(node);
	const firstName = "视频帧队列";
	if (!node.outputs || node.outputs.length === 0) node.addOutput?.(firstName, BATCH_IMAGE_TYPE);
	while ((node.outputs || []).length > 1) node.removeOutput?.(1);
	if (node.outputs?.[0]) {
		node.outputs[0].name = firstName;
		node.outputs[0].label = firstName;
		node.outputs[0].localized_name = firstName;
		node.outputs[0].type = BATCH_IMAGE_TYPE;
	}
	for (const key of state.enabledOutputs) {
		const def = OUTPUT_DEFS.find((item) => item.key === key);
		if (!def) continue;
		node.addOutput?.(def.name, def.type);
		const output = node.outputs?.[node.outputs.length - 1];
		if (output) {
			output.name = def.name;
			output.label = def.name;
			output.localized_name = def.name;
			output.type = def.type;
			output.__gjj_key = def.key;
		}
	}
	globalThis.GJJApplyTypeColorsToNode?.(node);
}

function stabilizeNode(node) {
	if (!node) return;
	forceHideNativeParamWidgets(node);
	ensureDomWidget(node);
	forceHideNativeParamWidgets(node);
	moveDomWidgetToTop(node);
	ensureOptionalInput(node);
	syncProperties(node);
	applyDynamicOutputs(node);
	renderAll(node);
	forceHideNativeParamWidgets(node);
}

function scheduleStabilize(node, ms = 32) {
	if (!node) return;
	clearTimeout(node.__gjjMultiVideoStabilizeTimer);
	node.__gjjMultiVideoStabilizeTimer = setTimeout(() => stabilizeNode(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.MultiVideoLoader.Optimized",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalAddWidget = nodeType.prototype.addWidget;
		if (originalAddWidget && !nodeType.prototype.__gjjMultiVideoAddWidgetPatched) {
			nodeType.prototype.addWidget = function (...args) {
				const widget = originalAddWidget.apply(this, args);
				const argName = String(args?.[1] || args?.[0] || "");
				if (isNativeParamWidget(widget) || PARAM_WIDGET_NAMES.has(argName) || PARAM_WIDGET_LABELS.has(argName)) {
					hideWidgetCompletely(widget);
					setTimeout(() => hideWidgetCompletely(widget), 0);
				}
				return widget;
			};
			nodeType.prototype.__gjjMultiVideoAddWidgetPatched = true;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleStabilize(this, 0);
			refreshOptions(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			const state = ensureState(this);
			state.selection = parseSelection(selectedFromNode(this, args[0]));
			state.enabledOutputs = parseEnabledOutputs(outputsFromNode(this, args[0]));
			state.activeTab = String(args[0]?.properties?.[TAB_PROPERTY] || this.properties?.[TAB_PROPERTY] || "video");
			if (!TAB_DEFS.some((tab) => tab.key === state.activeTab)) state.activeTab = "video";
			state.executedFrames = [];
			state.executedFrameCount = 0;
			state.sourceFps = 0;
			syncProperties(this);
			scheduleStabilize(this, 0);
			refreshOptions(this);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			syncProperties(this);
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[DATA_PROPERTY] = serializeSelection(ensureState(this).selection);
				serializedNode.properties[OUTPUTS_PROPERTY] = serializeOutputs(ensureState(this).enabledOutputs);
			}
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			const state = ensureState(this);
			state.executedFrames = Array.isArray(message?.preview_images) ? message.preview_images : [];
			state.executedFrameCount = Number(message?.frame_count?.[0] || 0);
			state.sourceFps = Number(message?.source_fps?.[0] || 0);
			state.outputWidth = Number(message?.width?.[0] || 0);
			state.outputHeight = Number(message?.height?.[0] || 0);
			state.videoFormat = String(message?.video_format?.[0] || "");
			scheduleStabilize(this, 0);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				stabilizeNode(node);
				refreshOptions(node);
			}
		}
	},
});
