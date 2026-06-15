import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_VideoCombine"]);
const VIDEO_UNIVERSAL_LOADER_NODES = new Set(["GJJ_VideoUniversalModelLoader", "GJJ_VideoKijaiModelLoader"]);
const TEMPLATE_PARAMS_NODE = "GJJ_TemplateParams";
const TOOLBAR_WIDGET_NAME = "gjj_video_combine_toolbar";
const PREVIEW_WIDGET_NAME = "gjj_video_combine_preview";
const USER_WIDTH_PROPERTY = "gjj_video_combine_user_width";
const BASIC_SETTINGS_PROPERTY = "gjj_video_combine_show_basic_settings";
const FRAME_RATE_VARIABLE_PROPERTY = "gjj_video_combine_frame_rate_variable";
const AUTO_FILENAME_PREFIX_PROPERTY = "gjj_video_combine_auto_filename_prefix";
const UNIVERSAL_LOADER_METADATA_PROPERTY = "gjj_video_universal_loader_metadata";
const TEMPLATE_PARAMS_VALUES_PROPERTY = "gjj_template_params_values";
const TEMPLATE_PARAMS_SCHEMA_PROPERTY = "gjj_template_params_schema";
const WAN_MODE_PARAM_NAMES = ["wan_mode", "video_mode", "mode", "模式", "视频模式", "生成模式"];
const DEFAULT_FILENAME_PREFIX = "video/GJJ";
const DEFAULT_NODE_WIDTH = 340;
const TOOLBAR_BUTTON_WIDTH = 30;
const TOOLBAR_BUTTON_HEIGHT = 28;
const TOOLBAR_GAP = 5;
const TOOLBAR_PADDING_X = 4;
const TOOLBAR_PADDING_Y = 6;
const TOOLBAR_NODE_GUTTER = 34;
const TOOLBAR_HEIGHT = TOOLBAR_PADDING_Y + TOOLBAR_BUTTON_HEIGHT;
const HIDDEN_PANEL_HEIGHT = 0;
const FRAME_RATE_NOTICE_HEIGHT = 22;
const PREVIEW_MIN_HEIGHT = 120;
const PREVIEW_DEFAULT_ASPECT = 16 / 9;
const PREVIEW_WIDGET_GUTTER = 34;
const PREVIEW_PANEL_VERTICAL_PADDING = 12;
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v"]);
const PRIMARY_INPUT_NAME = "images";
const PRIMARY_INPUT_ALIASES = new Set(["images", "图像"]);
const FRAME_RATE_WIDGET_NAME = "frame_rate";
const FRAME_RATE_SOCKET_TYPE = "INT,FLOAT";
const FINAL_NODE_COLOR = "#0a0a5f";
const FINAL_NODE_BGCOLOR = "#23292b";
const FINAL_NODE_COLOR_PROPERTY = "gjj_video_combine_final_node_color";
const OPTIONAL_INPUTS = [
	{ name: "audio", type: "AUDIO", label: "音频", localized_name: "音频", tooltip: "可选。接入后会在支持的格式里封入音轨，VIDEO 输出也会保留音频。" },
	{ name: "vae", type: "VAE", label: "VAE 解码器", localized_name: "VAE 解码器", tooltip: "仅当上方输入 LATENT 时需要连接。" },

];
const DEFAULT_VISIBLE_INPUTS = new Set(["audio"]);
const OUTPUTS = [
	{ name: "视频", type: "VIDEO", label: "视频", localized_name: "视频" },
	{ name: "主输出文件", type: "STRING", label: "主输出文件", localized_name: "主输出文件" },
	{ name: "输出文件列表JSON", type: "STRING", label: "输出文件列表JSON", localized_name: "输出文件列表JSON" },
];
const BOOLEAN_WIDGETS = [
	{ name: "pingpong", label: "往返播放", icon: "🔁", defaultValue: false, tooltip: "往返播放：正放后再倒放一遍中间帧，适合短动画闭环。" },
	{ name: "save_output", label: "保存到输出目录", icon: "💾", defaultValue: true, tooltip: "保存到输出目录：关闭时写入 ComfyUI temp 目录。" },
	{ name: "use_source_fps", label: "使用源视频帧率", icon: "🎞️", defaultValue: true, tooltip: "使用源视频帧率：接入 VIDEO 时优先使用第一段视频的帧率。" },
	{ name: "delete_tail_frame", label: "删除尾帧", icon: "🧹", defaultValue: false, tooltip: "删除尾帧：合成前移除最后一帧，适合去掉重复尾帧或循环衔接帧。" },
	{ name: "save_metadata", label: "保存元数据", icon: "🧾", defaultValue: true, tooltip: "保存元数据：写入 ComfyUI 工作流元数据；不支持的格式会自动忽略。" },
	{ name: "trim_to_audio", label: "按音频裁切", icon: "✂️", defaultValue: false, tooltip: "按音频裁切：封入音频时按音频长度裁切；关闭时补足音频到视频时长。" },
];
const VALUE_WIDGETS = [
	{
		name: "pix_fmt",
		label: "像素格式",
		icon: "🎨",
		kind: "cycle",
		defaultValue: "auto",
		values: ["auto", "yuv420p", "yuv420p10le", "yuva420p", "p010le", "rgba64le", "bgra", "yuv444p", "yuv444p10le"],
		tooltip: "像素格式：auto 使用当前输出格式预设；点击循环切换常用 pix_fmt。",
	},
	{
		name: "crf",
		label: "CRF 画质",
		icon: "📉",
		kind: "number",
		defaultValue: "-1",
		min: -1,
		max: 100,
		tooltip: "CRF 画质：-1 使用当前格式预设；0-100 覆盖 VHS crf，数值越低质量越高。",
	},
];
const TOOLBAR_WIDGETS = [...BOOLEAN_WIDGETS, ...VALUE_WIDGETS];
const BASIC_SETTING_WIDGETS = [
	{ name: "loop_count", label: "循环次数", type: "number" },
	{ name: "filename_prefix", label: "文件名前缀", type: "text" },
	{ name: "format_name", label: "输出格式", type: "combo" },
];
const BASIC_SETTING_TYPES = new Map(BASIC_SETTING_WIDGETS.map((config) => [config.name, config.type]));

function refreshNode(node) {
	if (!node) return;
	const currentWidth = validNodeWidth(node.size?.[0]) ?? preferredNodeWidth(node);
	const computed = typeof node.computeSize === "function" ? node.computeSize() : node.size;
	const height = Math.max(80, Math.round(Number(computed?.[1] || node.size?.[1] || 80)));
	const currentHeight = Math.round(Number(node.size?.[1] || 0));
	if (Math.round(Number(node.size?.[0] || 0)) !== currentWidth || currentHeight !== height) {
		node.__gjjVideoCombineInternalResize = true;
		try {
			node.setSize?.([currentWidth, height]);
		} finally {
			node.__gjjVideoCombineInternalResize = false;
		}
	}
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function validNodeWidth(value) {
	const width = Number(value);
	return Number.isFinite(width) && width > 0 ? Math.round(width) : null;
}

function rememberNodeWidth(node, value = null) {
	if (!node) {
		return null;
	}
	const width = validNodeWidth(value ?? node.size?.[0]);
	if (width == null) {
		return null;
	}
	node.properties ||= {};
	node.properties[USER_WIDTH_PROPERTY] = Math.round(width * 100) / 100;
	return node.properties[USER_WIDTH_PROPERTY];
}

function storedNodeWidth(node) {
	return validNodeWidth(node?.properties?.[USER_WIDTH_PROPERTY]);
}

function preferredNodeWidth(node, explicit = null) {
	return validNodeWidth(explicit)
		?? validNodeWidth(node?.size?.[0])
		?? storedNodeWidth(node)
		?? DEFAULT_NODE_WIDTH;
}

function toolbarButtonCount() {
	return BOOLEAN_WIDGETS.length + VALUE_WIDGETS.length + 3;
}

function getToolbarHeight(node, explicitWidth = null) {
	const width = preferredNodeWidth(node, explicitWidth);
	const availableWidth = Math.max(
		TOOLBAR_BUTTON_WIDTH,
		width - TOOLBAR_NODE_GUTTER - TOOLBAR_PADDING_X,
	);
	const buttonsPerRow = Math.max(
		1,
		Math.floor((availableWidth + TOOLBAR_GAP) / (TOOLBAR_BUTTON_WIDTH + TOOLBAR_GAP)),
	);
	const rows = Math.max(1, Math.ceil(toolbarButtonCount() / buttonsPerRow));
	return TOOLBAR_PADDING_Y + (rows * TOOLBAR_BUTTON_HEIGHT) + ((rows - 1) * TOOLBAR_GAP);
}

function initializeNodeWidth(node) {
	if (!storedNodeWidth(node)) {
		rememberNodeWidth(node, node?.size?.[0]);
	}
	return preferredNodeWidth(node);
}

function setNodeHeightPreservingUserWidth(node, height) {
	if (!node) {
		return;
	}
	const width = validNodeWidth(node.size?.[0]) ?? preferredNodeWidth(node);
	const nextHeight = Math.max(80, Math.round(Number(height || node.size?.[1] || 80)));
	if (Math.abs(Number(node.size?.[0] || 0) - width) <= 1 && Math.abs(Number(node.size?.[1] || 0) - nextHeight) <= 1) {
		return;
	}
	node.__gjjVideoCombineInternalResize = true;
	try {
		node.setSize?.([width, nextHeight]);
	} finally {
		node.__gjjVideoCombineInternalResize = false;
	}
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function removeLegacyVideoInputs(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		if (!String(input?.name || "").startsWith("video_")) {
			continue;
		}
		if (input?.link != null) {
			node.disconnectInput?.(index);
		}
		node.removeInput?.(index);
	}
}

function injectToolbarStyle() {
	if (document.getElementById("gjj-video-combine-style")) {
		return;
	}
	const style = document.createElement("style");
	style.id = "gjj-video-combine-style";
	style.textContent = `
		.gjj-video-combine-toolbar {
			display: flex;
			flex-wrap: wrap;
			align-content: flex-start;
			align-items: center;
			gap: 5px;
			padding: 4px 2px 2px;
			box-sizing: border-box;
			width: 100%;
			overflow: visible;
		}
		.gjj-video-combine-toolbar button {
			flex: 0 0 30px;
			width: 30px;
			min-width: 30px;
			height: 28px;
			border: 1px solid #41535b;
			border-radius: 6px;
			background: #172026;
			color: #dce7e2;
			font-size: 15px;
			font-weight: 700;
			cursor: pointer;
			white-space: nowrap;
			overflow: hidden;
			text-align: center;
			line-height: 1;
		}
		.gjj-video-combine-toolbar button:hover {
			background: #20313a;
			border-color: #55707d;
		}
		.gjj-video-combine-toolbar button:disabled,
		.gjj-video-combine-toolbar button.disabled {
			background: #151a1d;
			border-color: #344047;
			color: #667780;
			opacity: .62;
			cursor: not-allowed;
		}
		.gjj-video-combine-toolbar button:disabled:hover,
		.gjj-video-combine-toolbar button.disabled:hover {
			background: #151a1d;
			border-color: #344047;
		}
		.gjj-video-combine-toolbar button.on {
			background: #1f4b37;
			border-color: #57a773;
			color: #ffffff;
		}
		.gjj-video-combine-toolbar button.more-on {
			background: #274665;
			border-color: #5fa8ff;
			color: #ffffff;
		}
	`;
	document.head.appendChild(style);
}

function getWidget(node, name) {
	return (node?.widgets || []).find((widget) => String(widget?.name || "") === name) || null;
}

function selectedFrameRateVariable(node) {
	return String(node?.properties?.[FRAME_RATE_VARIABLE_PROPERTY] || "").trim();
}

function setSelectedFrameRateVariable(node, name) {
	if (!node) return;
	node.properties ||= {};
	const value = String(name || "").trim();
	if (value) node.properties[FRAME_RATE_VARIABLE_PROPERTY] = value;
	else delete node.properties[FRAME_RATE_VARIABLE_PROPERTY];
	applySlotVisibility(node);
	updateToolbar(node);
	updateFrameRateControlState(node);
	refreshNode(node);
}

function variableOptions(node) {
	const apiObject = globalThis.GJJ_VariableBroadcast;
	const graph = node?.graph || app.graph;
	return typeof apiObject?.getVisibleSetOptions === "function" ? (apiObject.getVisibleSetOptions(graph) || []) : [];
}

function variableOptionDisplay(option) {
	const value = String(option?.value || "").trim();
	const label = String(option?.label || value).trim();
	const match = label.match(/^[^()（）]+[（(]([^()（）]+?)[\s·]+([^()（）]+?)[）)]$/);
	if (match) return { title: match[2].trim() || value, source: match[1].trim(), value };
	return { title: label || value, source: "", value };
}

function selectedFrameRateVariableDisplay(node) {
	const selectedVariable = selectedFrameRateVariable(node);
	const option = variableOptions(node).find((item) => item.value === selectedVariable);
	return variableOptionDisplay(option || { value: selectedVariable, label: selectedVariable });
}

function getFrameRateSourceState(node) {
	const external = frameRateInputHasManualLink(node);
	const variable = selectedFrameRateVariable(node);
	const display = selectedFrameRateVariableDisplay(node);
	if (external) {
		return {
			active: true,
			external: true,
			variable,
			title: "帧率由外部连接控制",
			body: variable
				? `面板帧率已停用；当前 frame_rate 连线优先，已选变量「${display.title || variable}」暂不生效。`
				: "面板帧率已停用；断开 frame_rate 连接后可恢复手动输入或选择变量。",
		};
	}
	if (variable) {
		return {
			active: true,
			external: false,
			variable,
			title: "帧率由变量控制",
			body: `面板帧率已停用；执行时读取变量「${display.title || variable}」。点击 ⚡ 可清空变量。`,
		};
	}
	return {
		active: false,
		external: false,
		variable: "",
		title: "",
		body: "",
	};
}

function isToolbarControlWidgetName(name) {
	return TOOLBAR_WIDGETS.some((config) => config.name === String(name || ""));
}

function isPrimaryInputName(name) {
	return PRIMARY_INPUT_ALIASES.has(String(name || ""));
}

function isFrameRateSlot(slot) {
	const name = String(slot?.name || "");
	const widgetName = String(slot?.widget?.name || "");
	return name === FRAME_RATE_WIDGET_NAME || widgetName === FRAME_RATE_WIDGET_NAME;
}

function normalizeSlotCopy(copy) {
	if (isPrimaryInputName(copy?.name)) {
		copy.name = PRIMARY_INPUT_NAME;
		copy.type = "GJJ_BATCH_IMAGE,IMAGE";
		copy.label = "图像";
		copy.localized_name = "图像";
		copy.tooltip = "支持 GJJ_BATCH_IMAGE、IMAGE batch、LATENT、官方 VIDEO 或 VIDEO 序列；接 VIDEO 时自动走视频合并。";
		delete copy.widget;
	}
	if (isFrameRateSlot(copy)) {
		copy.name = FRAME_RATE_WIDGET_NAME;
		copy.type = FRAME_RATE_SOCKET_TYPE;
		copy.label = "帧率";
		copy.localized_name = "帧率";
		copy.tooltip = "输出动画或视频的帧率。可连接 INT 或 FLOAT，执行时会统一按浮点数计算。";
		copy.widget = { name: FRAME_RATE_WIDGET_NAME };
	}
	const optional = OPTIONAL_INPUTS.find((item) => item.name === String(copy?.name || ""));
	if (optional) {
		copy.name = optional.name;
		copy.type = optional.type;
		copy.label = optional.label;
		copy.localized_name = optional.localized_name;
		copy.tooltip = optional.tooltip;
		delete copy.widget;
	}
	return copy;
}

function cloneSlot(slot) {
	const copy = {};
	for (const [key, value] of Object.entries(slot || {})) {
		if (key === "_node" || key === "node" || key === "graph") {
			continue;
		}
		if (key === "widget") {
			copy.widget = value?.name ? { name: value.name } : value;
			continue;
		}
		if (key === "links") {
			copy.links = Array.isArray(value) ? [...value] : (value ?? null);
			continue;
		}
		copy[key] = value;
	}
	return normalizeSlotCopy(copy);
}

function readBoolWidget(node, name) {
	const widget = getWidget(node, name);
	return Boolean(widget?.value);
}

function writeWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) {
		return;
	}
	widget.value = value;
	const index = Array.isArray(node?.widgets) ? node.widgets.indexOf(widget) : -1;
	if (index >= 0) {
		node.widgets_values ||= [];
		node.widgets_values[index] = value;
	}
	node.properties ||= {};
	node.properties[name] = value;
	widget.callback?.(widget.value, app.canvas, node, app.canvas?.graph_mouse);
	node.onWidgetChanged?.(name, value, widget, node);
	refreshNode(node);
}

function writeBoolWidget(node, name, value) {
	writeWidgetValue(node, name, Boolean(value));
}

function isEmptyWidgetValue(value) {
	return value == null || String(value).trim() === "";
}

function repairToolbarWidgetDefaults(node) {
	for (const config of TOOLBAR_WIDGETS) {
		const widget = getWidget(node, config.name);
		if (!widget || !isEmptyWidgetValue(widget.value)) {
			continue;
		}
		writeWidgetValue(node, config.name, config.defaultValue);
	}
}

function comboValues(widget) {
	const raw = widget?.options?.values || widget?.options?.comboValues || widget?.values;
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.map((item) => String(item?.value ?? item?.name ?? item?.label ?? item ?? "")).filter(Boolean);
}

function cycleValueWidget(node, config) {
	const widget = getWidget(node, config.name);
	if (!widget) {
		return;
	}
	const values = comboValues(widget).length ? comboValues(widget) : config.values;
	if (!values.length) {
		return;
	}
	const current = String(widget.value ?? config.defaultValue ?? values[0]);
	const index = values.indexOf(current);
	const next = values[(index + 1) % values.length] || values[0];
	writeWidgetValue(node, config.name, next);
	updateToolbar(node);
}

function promptNumberWidget(node, config) {
	const widget = getWidget(node, config.name);
	if (!widget) {
		return;
	}
	const current = Number(widget.value ?? config.defaultValue ?? 0);
	const raw = window.prompt(`${config.label}\n${config.tooltip || ""}`, Number.isFinite(current) ? String(current) : String(config.defaultValue ?? 0));
	if (raw == null) {
		return;
	}
	const next = Math.round(Number(raw));
	if (!Number.isFinite(next)) {
		return;
	}
	const min = Number.isFinite(Number(config.min)) ? Number(config.min) : next;
	const max = Number.isFinite(Number(config.max)) ? Number(config.max) : next;
	const clamped = Math.min(max, Math.max(min, next));
	writeWidgetValue(node, config.name, String(clamped));
	updateToolbar(node);
}

function getBasicSettingsOpen(node) {
	return Boolean(node?.properties?.[BASIC_SETTINGS_PROPERTY]);
}

function setBasicSettingsOpen(node, value) {
	node.properties ||= {};
	node.properties[BASIC_SETTINGS_PROPERTY] = Boolean(value);
	updateToolbar(node);
	applyBasicSettingsVisibility(node);
	resizeNodeToContent(node);
	refreshNode(node);
}

function getMoreOpen(node) {
	return Boolean(node?.properties?.gjj_video_combine_show_more);
}

function setMoreOpen(node, value) {
	node.properties ||= {};
	node.properties.gjj_video_combine_show_more = Boolean(value);
	updateToolbar(node);
	applySlotVisibility(node);
	refreshNode(node);
}

function makeToolbarButton(label, title, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title;
	button.addEventListener("pointerdown", (event) => event.stopPropagation());
	button.addEventListener("mousedown", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.();
	});
	return button;
}

function closeFrameRateVariablePicker(node) {
	node?.__gjjVideoCombineFrameRatePicker?.remove?.();
	node.__gjjVideoCombineFrameRatePicker = null;
}

function openFrameRateVariablePicker(node) {
	closeFrameRateVariablePicker(node);
	const options = variableOptions(node);
	const current = selectedFrameRateVariable(node);
	const popup = document.createElement("div");
	popup.style.cssText = [
		"position:fixed",
		"z-index:10050",
		"width:min(420px,calc(100vw - 28px))",
		"max-height:min(500px,calc(100vh - 40px))",
		"overflow:hidden",
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"padding:10px",
		"border:1px solid #486575",
		"border-radius:8px",
		"background:#08151a",
		"box-shadow:0 18px 46px rgba(0,0,0,.55)",
		"color:#dce7e2",
		"font:12px system-ui,'Microsoft YaHei',sans-serif",
	].join(";");
	const rect = node.__gjjVideoCombineToolbar?.buttons?.frameRateVariable?.getBoundingClientRect?.() || { left: 24, bottom: 80 };
	popup.style.left = `${Math.round(Math.max(12, Math.min(window.innerWidth - 440, rect.left || 24)))}px`;
	popup.style.top = `${Math.round(Math.max(12, Math.min(window.innerHeight - 520, (rect.bottom || 80) + 6)))}px`;

	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;gap:8px;";
	const title = document.createElement("div");
	title.textContent = "⚡ 选择帧率变量";
	title.style.cssText = "font-weight:800;flex:1 1 auto;";
	const clear = document.createElement("button");
	clear.type = "button";
	clear.textContent = "清空";
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "关闭";
	for (const button of [clear, close]) {
		button.style.cssText = "height:28px;border:1px solid #44565f;border-radius:7px;background:#202b31;color:#dce7e2;cursor:pointer;padding:0 8px;font-size:12px;font-weight:650;";
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("mousedown", (event) => event.stopPropagation());
	}
	header.append(title, clear, close);
	popup.appendChild(header);

	const search = document.createElement("input");
	search.placeholder = "搜索变量，建议选择 INT/FLOAT 帧率";
	search.style.cssText = "height:30px;border:1px solid #3f5b66;border-radius:7px;background:#071015;color:#dce7e2;padding:0 10px;outline:none;";
	popup.appendChild(search);
	const list = document.createElement("div");
	list.style.cssText = "overflow:auto;display:flex;flex-direction:column;gap:5px;max-height:340px;padding-right:2px;";
	popup.appendChild(list);

	function render() {
		const needle = String(search.value || "").trim().toLowerCase();
		list.textContent = "";
		for (const option of options) {
			const parts = variableOptionDisplay(option);
			if (!parts.value) continue;
			if (needle && !`${parts.title} ${parts.source} ${parts.value} ${option.label || ""}`.toLowerCase().includes(needle)) continue;
			const item = document.createElement("button");
			item.type = "button";
			item.style.cssText = [
				"display:flex",
				"align-items:center",
				"gap:8px",
				"text-align:left",
				"border:0",
				"border-radius:7px",
				"padding:8px 10px",
				"background:" + (current === parts.value ? "#234a37" : "transparent"),
				"color:#dce7e2",
				"cursor:pointer",
			].join(";");
			const mark = document.createElement("span");
			mark.textContent = current === parts.value ? "✓" : "";
			mark.style.cssText = "width:16px;color:#7de39b;font-weight:900;";
			const text = document.createElement("span");
			text.innerHTML = `<b>${parts.title}</b><br><span style="color:#8fa3ad">${parts.source ? `${parts.source} · ` : ""}${parts.value}</span>`;
			item.append(mark, text);
			item.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
			item.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				setSelectedFrameRateVariable(node, parts.value);
				closeFrameRateVariablePicker(node);
			});
			list.appendChild(item);
		}
		if (!list.children.length) {
			const empty = document.createElement("div");
			empty.textContent = options.length ? "没有匹配的变量" : "当前工作流没有可选变量";
			empty.style.cssText = "padding:14px 10px;color:#9aaab2;text-align:center;";
			list.appendChild(empty);
		}
	}
	clear.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setSelectedFrameRateVariable(node, "");
		closeFrameRateVariablePicker(node);
	});
	close.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		closeFrameRateVariablePicker(node);
	});
	search.addEventListener("input", render);
	search.addEventListener("mousedown", (event) => event.stopPropagation());
	popup.addEventListener("mousedown", (event) => event.stopPropagation());
	document.body.appendChild(popup);
	node.__gjjVideoCombineFrameRatePicker = popup;
	render();
	setTimeout(() => search.focus(), 0);
}

function ensureToolbarWidget(node) {
	if (node.__gjjVideoCombineToolbar) {
		return node.__gjjVideoCombineToolbar;
	}
	injectToolbarStyle();
	const wrap = document.createElement("div");
	wrap.className = "gjj-video-combine-toolbar";

	const buttons = {};
	for (const config of BOOLEAN_WIDGETS) {
		buttons[config.name] = makeToolbarButton(config.icon, config.label, () => {
			writeBoolWidget(node, config.name, !readBoolWidget(node, config.name));
			updateToolbar(node);
		});
		wrap.appendChild(buttons[config.name]);
	}
	for (const config of VALUE_WIDGETS) {
		buttons[config.name] = makeToolbarButton(config.icon, config.label, () => {
			if (config.kind === "cycle") {
				cycleValueWidget(node, config);
			} else if (config.kind === "number") {
				promptNumberWidget(node, config);
			}
		});
		wrap.appendChild(buttons[config.name]);
	}

	buttons.frameRateVariable = makeToolbarButton("⚡", "从 GJJ 变量选择帧率；手动连接 frame_rate 口时，手动连线优先。", () => {
		openFrameRateVariablePicker(node);
	});
	wrap.appendChild(buttons.frameRateVariable);

	buttons.basic = makeToolbarButton("⚙️", "显示/隐藏循环次数、文件名前缀、输出格式。", () => {
		setBasicSettingsOpen(node, !getBasicSettingsOpen(node));
	});
	wrap.appendChild(buttons.basic);

	buttons.more = makeToolbarButton("接口", "显示/隐藏其它输入输出口；默认保留【图像】和【音频】输入口。", () => {
		setMoreOpen(node, !getMoreOpen(node));
	});
	wrap.appendChild(buttons.more);

	const widget = node.addDOMWidget?.(TOOLBAR_WIDGET_NAME, TOOLBAR_WIDGET_NAME, wrap, {
		hideOnZoom: false,
		getHeight: () => getToolbarHeight(node),
	});
	if (widget) {
		widget.getHeight = () => getToolbarHeight(node);
		widget.computeSize = (width) => [
			validNodeWidth(width) ?? validNodeWidth(node.size?.[0]) ?? preferredNodeWidth(node),
			getToolbarHeight(node, width),
		];
	}
	node.__gjjVideoCombineToolbar = { widget, wrap, buttons };
	updateToolbar(node);
	return node.__gjjVideoCombineToolbar;
}

function updateToolbar(node) {
	const toolbar = node?.__gjjVideoCombineToolbar;
	if (!toolbar) {
		return;
	}
	for (const config of BOOLEAN_WIDGETS) {
		const button = toolbar.buttons[config.name];
		const on = readBoolWidget(node, config.name);
		if (!button) {
			continue;
		}
		button.textContent = config.icon || "⚙️";
		button.classList.toggle("on", on);
		button.title = `${config.tooltip || config.label}\n当前：${on ? "开启" : "关闭"}`;
		button.setAttribute("aria-label", config.label);
		button.setAttribute("aria-pressed", on ? "true" : "false");
	}
	for (const config of VALUE_WIDGETS) {
		const button = toolbar.buttons[config.name];
		const widget = getWidget(node, config.name);
		if (!button || !widget) {
			continue;
		}
		const value = widget.value ?? config.defaultValue;
		const isDefault = String(value) === String(config.defaultValue);
		button.textContent = config.icon || "⚙️";
		button.classList.toggle("on", !isDefault);
		button.title = `${config.tooltip || config.label}\n当前：${String(value)}`;
		button.setAttribute("aria-label", config.label);
		button.setAttribute("aria-pressed", !isDefault ? "true" : "false");
	}
	const selectedVariable = selectedFrameRateVariable(node);
	if (toolbar.buttons.frameRateVariable) {
		const state = getFrameRateSourceState(node);
		const display = selectedFrameRateVariableDisplay(node);
		toolbar.buttons.frameRateVariable.textContent = "⚡";
		toolbar.buttons.frameRateVariable.classList.toggle("on", Boolean(selectedVariable));
		toolbar.buttons.frameRateVariable.classList.toggle("disabled", Boolean(state.external));
		toolbar.buttons.frameRateVariable.disabled = Boolean(state.external);
		toolbar.buttons.frameRateVariable.title = state.external
			? "frame_rate 已连接外部输入，外部连接优先；断开连接后可选择帧率变量。"
			: selectedVariable
				? `帧率变量：${display.title || selectedVariable}\n来源：${display.source || "变量"}\n当前会覆盖面板帧率；手动连接 frame_rate 口时手动连线优先。`
			: "从 GJJ_TemplateParams 或 GJJ_SetNode 选择帧率变量。";
		toolbar.buttons.frameRateVariable.setAttribute("aria-label", "选择帧率变量");
		toolbar.buttons.frameRateVariable.setAttribute("aria-pressed", selectedVariable ? "true" : "false");
		toolbar.buttons.frameRateVariable.setAttribute("aria-disabled", state.external ? "true" : "false");
	}
	const basicOpen = getBasicSettingsOpen(node);
	if (toolbar.buttons.basic) {
		toolbar.buttons.basic.textContent = "⚙️";
		toolbar.buttons.basic.classList.toggle("on", basicOpen);
		toolbar.buttons.basic.title = basicOpen
			? "当前显示循环次数、文件名前缀、输出格式；点击后隐藏。"
			: "当前隐藏循环次数、文件名前缀、输出格式；点击后显示。";
		toolbar.buttons.basic.setAttribute("aria-label", "显示/隐藏基础设置");
		toolbar.buttons.basic.setAttribute("aria-pressed", basicOpen ? "true" : "false");
	}
	const moreOpen = getMoreOpen(node);
	toolbar.buttons.more.textContent = "🔌";
	toolbar.buttons.more.classList.toggle("more-on", moreOpen);
	toolbar.buttons.more.title = moreOpen
		? "当前显示 VAE 和输出口；点击后只保留【图像】和【音频】输入口。"
		: "当前隐藏 VAE 和输出口；点击后显示 VAE 和输出口。";
	toolbar.buttons.more.setAttribute("aria-label", "显示/隐藏接口");
	toolbar.buttons.more.setAttribute("aria-pressed", moreOpen ? "true" : "false");
	updateFrameRateControlState(node);
}

function hideNativeToolbarWidgets(node) {
	for (const config of TOOLBAR_WIDGETS) {
		const widget = getWidget(node, config.name);
		if (!widget) {
			continue;
		}
		GJJ_Utils.hideWidget(widget);
		if (widget.options && typeof widget.options === "object") {
			widget.options.hidden = true;
			widget.options.display = "hidden";
		}
	}
}

function rememberFrameRateWidgetOriginal(widget) {
	if (!widget || widget.__gjjVideoCombineFrameRateOriginal) {
		return;
	}
	widget.__gjjVideoCombineFrameRateOriginal = {
		type: widget.type,
		label: widget.label,
		hidden: widget.hidden,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		disabled: widget.disabled,
		readOnly: widget.readOnly,
		draw: widget.draw,
		mouse: widget.mouse,
		last_y: widget.last_y,
		computedHeight: widget.computedHeight,
		marginTop: widget.margin_top,
		size: Array.isArray(widget.size) ? [...widget.size] : widget.size,
		optionsHidden: widget.options?.hidden,
		optionsDisplay: widget.options?.display,
		optionsDisabled: widget.options?.disabled,
		optionsReadOnly: widget.options?.readOnly,
		elementDisplay: widget.element?.style?.display,
		elementHeight: widget.element?.style?.height,
		elementMargin: widget.element?.style?.margin,
		elementPadding: widget.element?.style?.padding,
		elementOpacity: widget.element?.style?.opacity,
		elementFilter: widget.element?.style?.filter,
		inputDisplay: widget.inputEl?.style?.display,
		inputHeight: widget.inputEl?.style?.height,
		inputMargin: widget.inputEl?.style?.margin,
		inputPadding: widget.inputEl?.style?.padding,
		inputDisabled: widget.inputEl?.disabled,
		inputReadOnly: widget.inputEl?.readOnly,
		inputOpacity: widget.inputEl?.style?.opacity,
		inputFilter: widget.inputEl?.style?.filter,
	};
}

function restoreFrameRateWidgetOriginal(widget) {
	if (!widget) {
		return;
	}
	rememberFrameRateWidgetOriginal(widget);
	const original = widget.__gjjVideoCombineFrameRateOriginal || {};
	widget.type = original.type || "number";
	widget.label = original.label ?? widget.label ?? "帧率";
	widget.hidden = Boolean(original.hidden);
	if (original.computeSize !== undefined) widget.computeSize = original.computeSize; else delete widget.computeSize;
	if (original.getHeight !== undefined) widget.getHeight = original.getHeight; else delete widget.getHeight;
	if (original.draw !== undefined) widget.draw = original.draw; else delete widget.draw;
	if (original.mouse !== undefined) widget.mouse = original.mouse; else delete widget.mouse;
	if (original.last_y !== undefined) widget.last_y = original.last_y; else delete widget.last_y;
	if (original.computedHeight !== undefined) widget.computedHeight = original.computedHeight; else delete widget.computedHeight;
	if (original.marginTop !== undefined) widget.margin_top = original.marginTop; else delete widget.margin_top;
	if (original.size !== undefined) widget.size = Array.isArray(original.size) ? [...original.size] : original.size;
	widget.options ||= {};
	if (original.optionsHidden !== undefined) widget.options.hidden = original.optionsHidden; else delete widget.options.hidden;
	if (original.optionsDisplay !== undefined) widget.options.display = original.optionsDisplay; else delete widget.options.display;
	if (widget.element) {
		widget.element.style.display = original.elementDisplay ?? "";
		widget.element.style.height = original.elementHeight ?? "";
		widget.element.style.margin = original.elementMargin ?? "";
		widget.element.style.padding = original.elementPadding ?? "";
	}
	if (widget.inputEl) {
		widget.inputEl.style.display = original.inputDisplay ?? "";
		widget.inputEl.style.height = original.inputHeight ?? "";
		widget.inputEl.style.margin = original.inputMargin ?? "";
		widget.inputEl.style.padding = original.inputPadding ?? "";
	}
	delete widget.__gjjVideoCombineFrameRateHidden;
	delete widget.__gjjUtilsHidden;
}

function setFrameRateWidgetHidden(node, hidden) {
	const widget = getWidget(node, FRAME_RATE_WIDGET_NAME);
	if (!widget) {
		return false;
	}
	rememberFrameRateWidgetOriginal(widget);
	const wasHidden = Boolean(widget.__gjjVideoCombineFrameRateHidden);
	if (!hidden) {
		if (wasHidden) {
			restoreFrameRateWidgetOriginal(widget);
		}
		return wasHidden;
	}
	if (wasHidden) {
		return false;
	}
	widget.__gjjVideoCombineFrameRateHidden = true;
	widget.hidden = true;
	widget.type = `converted-widget:${FRAME_RATE_WIDGET_NAME}`;
	widget.label = "";
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.mouse = () => false;
	widget.last_y = 0;
	widget.computedHeight = 0;
	widget.margin_top = 0;
	widget.size = [0, 0];
	widget.options ||= {};
	widget.options.hidden = true;
	widget.options.display = "hidden";
	if (widget.element) {
		widget.element.style.display = "none";
		widget.element.style.height = "0";
		widget.element.style.margin = "0";
		widget.element.style.padding = "0";
	}
	if (widget.inputEl) {
		widget.inputEl.style.display = "none";
		widget.inputEl.style.height = "0";
		widget.inputEl.style.margin = "0";
		widget.inputEl.style.padding = "0";
	}
	return true;
}

function setFrameRateWidgetDisabled(node, disabled, title = "") {
	const widget = getWidget(node, FRAME_RATE_WIDGET_NAME);
	if (!widget) {
		return;
	}
	rememberFrameRateWidgetOriginal(widget);
	const original = widget.__gjjVideoCombineFrameRateOriginal || {};
	widget.options ||= {};
	if (disabled) {
		widget.disabled = true;
		widget.readOnly = true;
		widget.options.disabled = true;
		widget.options.readOnly = true;
		if (widget.__gjjVideoCombineFrameRateHidden) {
			widget.__gjjVideoCombineFrameRateDisabled = true;
			widget.__gjjVideoCombineFrameRateDisabledTitle = title;
			if (widget.element) widget.element.title = title;
			if (widget.inputEl) widget.inputEl.title = title;
			return;
		}
		if (typeof original.draw === "function") {
			widget.draw = function (ctx, nodeRef, widgetWidth, widgetY, height) {
				const previousAlpha = ctx.globalAlpha;
				ctx.globalAlpha = Math.min(previousAlpha, 0.52);
				try {
					return original.draw.call(this, ctx, nodeRef, widgetWidth, widgetY, height);
				} finally {
					ctx.globalAlpha = previousAlpha;
				}
			};
		}
		widget.mouse = () => false;
		widget.__gjjVideoCombineFrameRateDisabled = true;
		widget.__gjjVideoCombineFrameRateDisabledTitle = title;
		if (widget.element) {
			widget.element.style.opacity = ".58";
			widget.element.style.filter = "grayscale(1)";
			widget.element.title = title;
		}
		if (widget.inputEl) {
			widget.inputEl.disabled = true;
			widget.inputEl.readOnly = true;
			widget.inputEl.style.opacity = ".58";
			widget.inputEl.style.filter = "grayscale(1)";
			widget.inputEl.title = title;
		}
		return;
	}

	widget.disabled = Boolean(original.disabled);
	widget.readOnly = Boolean(original.readOnly);
	if (original.draw !== undefined) widget.draw = original.draw; else delete widget.draw;
	if (original.mouse !== undefined) widget.mouse = original.mouse; else delete widget.mouse;
	if (original.optionsDisabled !== undefined) widget.options.disabled = original.optionsDisabled; else delete widget.options.disabled;
	if (original.optionsReadOnly !== undefined) widget.options.readOnly = original.optionsReadOnly; else delete widget.options.readOnly;
	delete widget.__gjjVideoCombineFrameRateDisabled;
	delete widget.__gjjVideoCombineFrameRateDisabledTitle;
	if (widget.element) {
		widget.element.style.opacity = original.elementOpacity ?? "";
		widget.element.style.filter = original.elementFilter ?? "";
		widget.element.title = "";
	}
	if (widget.inputEl) {
		widget.inputEl.disabled = Boolean(original.inputDisabled);
		widget.inputEl.readOnly = Boolean(original.inputReadOnly);
		widget.inputEl.style.opacity = original.inputOpacity ?? "";
		widget.inputEl.style.filter = original.inputFilter ?? "";
		widget.inputEl.title = "";
	}
}

function updateFrameRateNotice(node) {
	const panel = node?.__gjjVideoCombineStatus;
	if (!panel?.frameRateNotice) {
		return false;
	}
	const state = getFrameRateSourceState(node);
	const { wrap, title, body } = panel.frameRateNotice;
	const wasVisible = Boolean(wrap.__gjjVideoCombineVisible);
	wrap.__gjjVideoCombineVisible = Boolean(state.active);
	wrap.style.display = state.active ? "block" : "none";
	const text = state.title && state.body ? `${state.title}：${state.body}` : (state.title || state.body || "");
	title.textContent = text;
	body.textContent = "";
	wrap.title = state.body;
	return wasVisible !== Boolean(state.active);
}

function updateFrameRateControlState(node) {
	const state = getFrameRateSourceState(node);
	const title = state.body || "";
	const hiddenChanged = setFrameRateWidgetHidden(node, Boolean(state.variable && !state.external));
	setFrameRateWidgetDisabled(node, state.active, title);
	const noticeChanged = updateFrameRateNotice(node);
	if (node?.__gjjVideoCombineStatus) {
		const mode = node.__gjjVideoCombinePanelMode || "hidden";
		if (noticeChanged || hiddenChanged) {
			setPanelMode(node, mode);
		}
	}
	if (hiddenChanged) {
		resizeNodeToContent(node);
	}
}

function rememberBasicWidgetOriginal(widget) {
	if (!widget || widget.__gjjVideoCombineBasicOriginal) {
		return;
	}
	widget.__gjjVideoCombineBasicOriginal = {
		type: widget.type,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		draw: widget.draw,
		mouse: widget.mouse,
		hidden: widget.hidden,
		disabled: widget.disabled,
		y: widget.y,
		last_y: widget.last_y,
		optionsHidden: widget.options?.hidden,
		optionsDisplay: widget.options?.display,
		elementDisplay: widget.element?.style?.display,
		inputDisplay: widget.inputEl?.style?.display,
	};
}

function setBasicWidgetVisible(widget, visible) {
	if (!widget) {
		return;
	}
	rememberBasicWidgetOriginal(widget);
	const original = widget.__gjjVideoCombineBasicOriginal || {};
	const originalWasHidden = original.hidden === true
		|| original.optionsHidden === true
		|| original.optionsDisplay === "hidden";
	widget.__gjjVideoCombineBasicHidden = !visible;
	widget.options ||= {};
	if (visible) {
		const fallbackType = BASIC_SETTING_TYPES.get(String(widget.name || ""));
		if (fallbackType) {
			widget.type = fallbackType;
		} else if (original.type && !String(original.type).startsWith("converted-widget:")) {
			widget.type = original.type;
		}
		widget.hidden = false;
		widget.disabled = false;
		if (!originalWasHidden && original.computeSize !== undefined) widget.computeSize = original.computeSize; else delete widget.computeSize;
		if (!originalWasHidden && original.getHeight !== undefined) widget.getHeight = original.getHeight; else delete widget.getHeight;
		if (!originalWasHidden && original.draw !== undefined) widget.draw = original.draw; else delete widget.draw;
		if (!originalWasHidden && original.mouse !== undefined) widget.mouse = original.mouse; else delete widget.mouse;
		widget.y = Number.isFinite(Number(original.y)) && Number(original.y) > -1000 ? original.y : 0;
		widget.last_y = Number.isFinite(Number(original.last_y)) && Number(original.last_y) > -1000 ? original.last_y : 0;
		delete widget.computedHeight;
		widget.options.hidden = false;
		delete widget.options.display;
		if (widget.element) widget.element.style.display = originalWasHidden ? "" : (original.elementDisplay ?? "");
		if (widget.inputEl) widget.inputEl.style.display = originalWasHidden ? "" : (original.inputDisplay ?? "");
	} else {
		widget.hidden = true;
		widget.disabled = true;
		widget.computeSize = () => [0, 0];
		widget.getHeight = () => 0;
		widget.draw = () => {};
		widget.mouse = () => false;
		widget.computedHeight = 0;
		widget.y = -100000;
		widget.last_y = -100000;
		widget.options.hidden = true;
		widget.options.display = "hidden";
		if (widget.element) widget.element.style.display = "none";
		if (widget.inputEl) widget.inputEl.style.display = "none";
	}
}

function applyBasicSettingsVisibility(node) {
	const visible = getBasicSettingsOpen(node);
	for (const config of BASIC_SETTING_WIDGETS) {
		setBasicWidgetVisible(getWidget(node, config.name), visible);
	}
}

function slotHasLink(slot, isOutput) {
	if (!slot) {
		return false;
	}
	if (isOutput) {
		return Array.isArray(slot.links) ? slot.links.length > 0 : slot.links != null;
	}
	return slot.link != null;
}

function findGraphLink(graphLinks, linkId) {
	if (!graphLinks || linkId == null) return null;
	if (Array.isArray(graphLinks)) {
		return graphLinks.find((item) => String(Array.isArray(item) ? item[0] : item?.id) === String(linkId)) || null;
	}
	return graphLinks[linkId] || null;
}

function syncVisibleSlotLinks(node) {
	const graphLinks = node?.graph?.links || app.graph?.links || {};
	for (const [index, input] of (node?.inputs || []).entries()) {
		const linkId = input?.link;
		if (linkId == null) {
			continue;
		}
		const link = findGraphLink(graphLinks, linkId);
		if (link) {
			if (Array.isArray(link)) {
				link[3] = node.id;
				link[4] = index;
			} else {
				link.target_id = node.id;
				link.target_slot = index;
			}
		}
	}
	for (const [index, output] of (node?.outputs || []).entries()) {
		for (const linkId of output?.links || []) {
			const link = findGraphLink(graphLinks, linkId);
			if (link) {
				if (Array.isArray(link)) {
					link[1] = node.id;
					link[2] = index;
				} else {
					link.origin_id = node.id;
					link.origin_slot = index;
				}
			}
		}
	}
}

function applySlotVisibility(node) {
	const moreOpen = getMoreOpen(node);
	captureFullSlots(node);
	if (Array.isArray(node?.inputs)) {
		const fullInputs = getFullInputs(node);
		const visibleInputs = [];
		const hideFrameRateForVariable = Boolean(selectedFrameRateVariable(node)) && !frameRateInputHasManualLink(node);
		for (const input of fullInputs) {
			const name = String(input?.name || "");
			const isPrimary = isPrimaryInputName(name);
			const isWidgetInput = !!input?.widget && !isToolbarControlWidgetName(input?.widget?.name || name);
			if (isPrimary) {
				const primary = cloneSlot(input);
				primary.name = PRIMARY_INPUT_NAME;
				primary.type = "GJJ_BATCH_IMAGE,IMAGE";
				primary.label = "图像";
				primary.localized_name = "图像";
				visibleInputs.push(primary);
			} else if (hideFrameRateForVariable && isFrameRateSlot(input)) {
				continue;
			} else if (isWidgetInput || DEFAULT_VISIBLE_INPUTS.has(name) || moreOpen || slotHasLink(input, false)) {
				visibleInputs.push(cloneSlot(input));
			}
		}
		node.inputs = visibleInputs.map((slot, index) => ({ ...slot, slot_index: index }));
	}
	if (Array.isArray(node?.outputs)) {
		const fullOutputs = getFullOutputs(node);
		const visibleOutputs = [];
		for (const output of fullOutputs) {
			if (moreOpen || slotHasLink(output, true)) {
				visibleOutputs.push(cloneSlot(output));
			}
		}
		node.outputs = visibleOutputs.map((slot, index) => ({ ...slot, slot_index: index }));
	}
	syncVisibleSlotLinks(node);
	refreshNode(node);
}

function captureFullSlots(node) {
	if (!node) {
		return;
	}
	if (!node.__gjjVideoCombineFullInputs && Array.isArray(node.inputs)) {
		node.__gjjVideoCombineFullInputs = node.inputs.map(cloneSlot);
	}
	if (!node.__gjjVideoCombineFullOutputs && Array.isArray(node.outputs)) {
		node.__gjjVideoCombineFullOutputs = node.outputs.map(cloneSlot);
	}
}

function getFullInputs(node) {
	const current = Array.isArray(node?.inputs) ? node.inputs : [];
	const base = Array.isArray(node?.__gjjVideoCombineFullInputs)
		? node.__gjjVideoCombineFullInputs
		: current;
	const byName = new Map();
	for (const slot of base) {
		const key = isPrimaryInputName(slot?.name) ? PRIMARY_INPUT_NAME : String(slot?.name || "");
		byName.set(key, cloneSlot(slot));
	}
	for (const slot of current) {
		const name = isPrimaryInputName(slot?.name) ? PRIMARY_INPUT_NAME : String(slot?.name || "");
		if (!name) {
			continue;
		}
		const saved = byName.get(name) || {};
		byName.set(name, { ...saved, ...cloneSlot(slot) });
	}
	if (!byName.has(PRIMARY_INPUT_NAME)) {
		byName.set(PRIMARY_INPUT_NAME, {
			name: PRIMARY_INPUT_NAME,
			type: "GJJ_BATCH_IMAGE,IMAGE",
			label: "图像",
			localized_name: "图像",
			link: null,
		});
	}
	for (const fallback of OPTIONAL_INPUTS) {
		if (!byName.has(fallback.name)) {
			byName.set(fallback.name, { ...fallback, link: null });
		}
	}
	const ordered = [
		byName.get(PRIMARY_INPUT_NAME),
		...Array.from(byName.values()).filter((slot) => {
			const name = String(slot?.name || "");
			return !isPrimaryInputName(name)
				&& !OPTIONAL_INPUTS.some((optional) => optional.name === name)
				&& !!slot?.widget
				&& !isToolbarControlWidgetName(slot?.widget?.name || name);
		}),
		...OPTIONAL_INPUTS.map((slot) => byName.get(slot.name)),
	].filter(Boolean);
	node.__gjjVideoCombineFullInputs = ordered.map((slot, index) => ({ ...cloneSlot(slot), slot_index: index }));
	return ordered;
}

function getFullOutputs(node) {
	const current = Array.isArray(node?.outputs) ? node.outputs : [];
	const base = Array.isArray(node?.__gjjVideoCombineFullOutputs)
		? node.__gjjVideoCombineFullOutputs
		: current;
	const byName = new Map();
	for (const slot of base) {
		byName.set(String(slot?.name || ""), cloneSlot(slot));
	}
	for (const slot of current) {
		const name = String(slot?.name || "");
		if (!name) {
			continue;
		}
		const saved = byName.get(name) || {};
		byName.set(name, { ...saved, ...cloneSlot(slot) });
	}
	for (const fallback of OUTPUTS) {
		if (!byName.has(fallback.name)) {
			byName.set(fallback.name, { ...fallback, links: null });
		}
	}
	const ordered = OUTPUTS.map((slot) => byName.get(slot.name)).filter(Boolean);
	node.__gjjVideoCombineFullOutputs = ordered.map((slot, index) => ({ ...cloneSlot(slot), slot_index: index }));
	return ordered;
}

function ensurePanelWidget(node) {
	if (node.__gjjVideoCombineStatus) {
		return node.__gjjVideoCombineStatus;
	}
	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:none",
		"flex-direction:column",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
		"min-height:0",
		"padding:0",
	].join(";");

	const notice = document.createElement("div");
	notice.style.cssText = [
		"display:none",
		"width:100%",
		"box-sizing:border-box",
		"padding:0 4px 4px",
		"color:#8fa0a8",
		"font:12px system-ui,'Microsoft YaHei',sans-serif",
		"line-height:18px",
		"white-space:nowrap",
		"overflow:hidden",
		"text-overflow:ellipsis",
	].join(";");
	const noticeIcon = document.createElement("div");
	noticeIcon.textContent = "ℹ";
	noticeIcon.style.cssText = "display:none;";
	const noticeText = document.createElement("div");
	noticeText.style.cssText = "min-width:0;";
	const noticeTitle = document.createElement("div");
	noticeTitle.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
	const noticeBody = document.createElement("div");
	noticeBody.style.cssText = "display:none;";
	noticeText.append(noticeTitle, noticeBody);
	notice.append(noticeIcon, noticeText);

	const previewCard = document.createElement("div");
	previewCard.style.cssText = [
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"width:100%",
		"box-sizing:border-box",
		"border:1px solid #25333b",
		"border-radius:10px",
		"overflow:hidden",
		"background:#0d1418",
		"position:relative",
	].join(";");

	const empty = document.createElement("div");
	empty.textContent = "执行后在这里预览视频或动图";
	empty.style.cssText = [
		"padding:12px",
		"color:#7f97a2",
		"font-size:12px",
		"line-height:1.5",
		"text-align:center",
		"pointer-events:none",
	].join(";");

	const video = document.createElement("video");
	video.controls = true;
	video.muted = true;
	video.loop = true;
	video.playsInline = true;
	video.preload = "metadata";
	video.style.cssText = [
		"display:none",
		"width:100%",
		"height:100%",
		"object-fit:contain",
		"background:#000",
	].join(";");

	const image = document.createElement("img");
	image.alt = "视频预览";
	image.style.cssText = [
		"display:none",
		"width:100%",
		"height:100%",
		"object-fit:contain",
		"background:#0d1418",
	].join(";");

	previewCard.append(empty, video, image);
	wrap.append(notice, previewCard);

	const widget = node.addDOMWidget?.(PREVIEW_WIDGET_NAME, PREVIEW_WIDGET_NAME, wrap, {
		hideOnZoom: false,
		getHeight: () => getPanelHeight(node),
	});
	if (widget) {
		widget.computeSize = (width) => [
			validNodeWidth(width) ?? validNodeWidth(node.size?.[0]) ?? preferredNodeWidth(node),
			Math.round(getPanelHeight(node, width)),
		];
	}
	node.__gjjVideoCombineStatus = {
		widget,
		wrap,
		previewCard,
		empty,
		video,
		image,
		frameRateNotice: { wrap: notice, title: noticeTitle, body: noticeBody },
	};
	const updateLoadedAspect = (width, height) => {
		if (setPreviewAspect(node, width, height)) {
			updatePreviewLayout(node);
			resizeNodeToContent(node);
		}
	};
	video.addEventListener("loadedmetadata", () => updateLoadedAspect(video.videoWidth, video.videoHeight));
	image.addEventListener("load", () => updateLoadedAspect(image.naturalWidth, image.naturalHeight));
	updatePreviewLayout(node);
	setPanelMode(node, node.__gjjVideoCombinePanelMode || "hidden");
	return node.__gjjVideoCombineStatus;
}

function getPreviewAspect(node) {
	const aspect = Number(node?.__gjjVideoCombinePreviewAspect || node?.properties?.gjj_video_combine_preview_aspect || PREVIEW_DEFAULT_ASPECT);
	return Number.isFinite(aspect) && aspect > 0 ? aspect : PREVIEW_DEFAULT_ASPECT;
}

function setPreviewAspect(node, width, height) {
	const w = Number(width);
	const h = Number(height);
	if (!node || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
		return false;
	}
	const next = Math.max(0.05, Math.min(20, w / h));
	if (Math.abs(Number(node.__gjjVideoCombinePreviewAspect || 0) - next) < 0.001) {
		return false;
	}
	node.__gjjVideoCombinePreviewAspect = next;
	node.properties ||= {};
	node.properties.gjj_video_combine_preview_aspect = next;
	return true;
}

function getPreviewContentWidth(node, nodeWidth = null) {
	const width = preferredNodeWidth(node, nodeWidth);
	return Math.max(1, width - PREVIEW_WIDGET_GUTTER);
}

function getPreviewCardHeight(node, nodeWidth = null) {
	return Math.max(PREVIEW_MIN_HEIGHT, Math.round(getPreviewContentWidth(node, nodeWidth) / getPreviewAspect(node)));
}

function updatePreviewLayout(node, nodeWidth = null) {
	const state = node?.__gjjVideoCombineStatus;
	if (!state) {
		return;
	}
	const width = preferredNodeWidth(node, nodeWidth);
	const contentWidth = getPreviewContentWidth(node, width);
	const height = getPreviewCardHeight(node, width);
	state.wrap.style.width = `${contentWidth}px`;
	state.previewCard.style.height = `${height}px`;
	state.previewCard.style.aspectRatio = String(getPreviewAspect(node));
	if (state.widget) {
		const panelHeight = getPanelHeight(node, width);
		state.widget.getHeight = () => getPanelHeight(node);
		state.widget.computedHeight = panelHeight;
	}
}

function getPanelHeight(node, nodeWidth = null) {
	const mode = String(node?.__gjjVideoCombinePanelMode || "hidden");
	const noticeVisible = Boolean(node?.__gjjVideoCombineStatus?.frameRateNotice?.wrap?.__gjjVideoCombineVisible);
	const noticeHeight = noticeVisible ? FRAME_RATE_NOTICE_HEIGHT : 0;
	if (mode === "preview") {
		return noticeHeight + getPreviewCardHeight(node, nodeWidth) + PREVIEW_PANEL_VERTICAL_PADDING;
	}
	return noticeHeight || HIDDEN_PANEL_HEIGHT;
}

function resizeNodeToContent(node) {
	if (!node) {
		return;
	}
	if (node.__gjjVideoCombineResizePending) {
		return;
	}
	node.__gjjVideoCombineResizePending = true;
	requestAnimationFrame(() => {
		node.__gjjVideoCombineResizePending = false;
		updatePreviewLayout(node);
		const computed = typeof node.computeSize === "function" ? node.computeSize() : node.size;
		const height = Math.max(80, Math.round(Number(computed?.[1] || node.size?.[1] || 80)));
		setNodeHeightPreservingUserWidth(node, height);
	});
}

function setPanelMode(node, mode) {
	const state = node?.__gjjVideoCombineStatus;
	if (!state) {
		return;
	}
	const nextMode = ["hidden", "preview"].includes(mode) ? mode : "hidden";
	const sameMode = node.__gjjVideoCombinePanelMode === nextMode;
	node.__gjjVideoCombinePanelMode = nextMode;
	const noticeVisible = Boolean(state.frameRateNotice?.wrap?.__gjjVideoCombineVisible);
	state.wrap.style.display = noticeVisible || nextMode === "preview" ? "flex" : "none";
	state.previewCard.style.display = nextMode === "preview" ? "flex" : "none";
	if (state.widget) {
		state.widget.getHeight = () => getPanelHeight(node);
		state.widget.computedHeight = getPanelHeight(node);
	}
	updatePreviewLayout(node);
	if (!sameMode) {
		refreshNode(node);
	}
	resizeNodeToContent(node);
}

function buildViewUrl(item) {
	if (!item?.filename) {
		return "";
	}
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	return api.apiURL(
		`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "temp")}&subfolder=${encodeURIComponent(item.subfolder || "")}${randParam}`,
	);
}

function isVideoPreview(item, detail = {}) {
	const explicitFlag = Array.isArray(detail?.preview_is_video) ? detail.preview_is_video[0] : detail?.preview_is_video;
	if (explicitFlag != null) {
		return Boolean(explicitFlag);
	}
	const filename = String(item?.filename || "");
	const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
	return VIDEO_EXTENSIONS.has(ext);
}

function clearNativePreview(node) {
	if (!node) {
		return;
	}

	// 清理 ComfyUI / LiteGraph 原生图片预览缓存
	node.imgs = [];
	node.imageIndex = null;
	node.overIndex = null;

	// 清理可能存在的动态图 / 视频预览缓存
	node.animatedImages = [];
	node.videoContainer = null;
	node.preview = null;
	node.previews = null;

	// 部分版本会挂在 properties 里
	if (node.properties) {
		delete node.properties.image;
		delete node.properties.images;
		delete node.properties.preview;
		delete node.properties.previews;
		delete node.properties.gifs;
		delete node.properties.animated;
	}

	app.graph?.setDirtyCanvas?.(true, true);
	refreshNode(node);
}
function setPreview(node, detail = {}) {
	const state = node?.__gjjVideoCombineStatus;
	if (!state) {
		return;
	}
	const item = Array.isArray(detail?.preview_media) ? detail.preview_media[0] : null;
	const url = buildViewUrl(item);
	const shouldUseVideo = !!url && isVideoPreview(item, detail);
	const detailWidth = Array.isArray(detail?.preview_width) ? detail.preview_width[0] : detail?.preview_width;
	const detailHeight = Array.isArray(detail?.preview_height) ? detail.preview_height[0] : detail?.preview_height;

	state.video.pause?.();
	state.video.removeAttribute("src");
	state.video.load?.();
	state.image.removeAttribute("src");

	if (!url) {
		state.empty.style.display = "flex";
		state.video.style.display = "none";
		state.image.style.display = "none";
		state.empty.textContent = "执行后在这里预览视频或动图";
		setPanelMode(node, "hidden");
		refreshNode(node);
		return;
	}

	setPreviewAspect(node, item?.width ?? detailWidth, item?.height ?? detailHeight);
	updatePreviewLayout(node);
	setPanelMode(node, "preview");
	if (shouldUseVideo) {
		state.empty.style.display = "none";
		state.image.style.display = "none";
		state.video.style.display = "block";
		state.video.src = url;
		state.video.load?.();
		const autoplayPromise = state.video.play?.();
		if (autoplayPromise?.catch) {
			autoplayPromise.catch(() => {});
		}
	} else {
		state.empty.style.display = "none";
		state.video.style.display = "none";
		state.image.style.display = "block";
		state.image.src = url;
	}
	refreshNode(node);
}

function applyFinalNodeColor(node) {
	if (!node) {
		return;
	}
	node.properties ||= {};
	if (node.properties[FINAL_NODE_COLOR_PROPERTY] !== true) {
		node.color = FINAL_NODE_COLOR;
		node.bgcolor = FINAL_NODE_BGCOLOR;
		node.properties[FINAL_NODE_COLOR_PROPERTY] = true;
	}
}

function patchNode(node) {
	if (!node) {
		return;
	}
	node.__gjjVideoCombinePatched = true;
	applyFinalNodeColor(node);
	initializeNodeWidth(node);
	removeLegacyVideoInputs(node);
	repairToolbarWidgetDefaults(node);
	hideNativeToolbarWidgets(node);
	ensureToolbarWidget(node);
	applyBasicSettingsVisibility(node);
	ensurePanelWidget(node);
	applySlotVisibility(node);
	updateFrameRateControlState(node);
	clearNativePreview(node);
	updatePreviewLayout(node);
	if (!Array.isArray(node.size) || node.size.length < 2) {
		setNodeHeightPreservingUserWidth(node, Math.max(80, getPanelHeight(node) + getToolbarHeight(node) + 8));
	} else {
		setNodeHeightPreservingUserWidth(node, Number(node.size[1] || 80));
	}
	if (!node.__gjjVideoCombinePanelMode) {
		setPanelMode(node, "hidden");
	}
}

function findVideoCombineNodeForPromptId(graph, promptId) {
	const id = String(promptId || "");
	const nodes = graph?._nodes || [];
	const parts = id.split(":").filter(Boolean);
	const tail = parts.length ? parts[parts.length - 1] : id;
	return nodes.find((node) => String(node?.id) === id)
		|| nodes.find((node) => String(node?.id) === tail);
}

function nodeClassName(node) {
	return String(node?.comfyClass || node?.type || "");
}

function graphNodeById(graph, id) {
	const text = String(id ?? "");
	return (graph?._nodes || []).find((node) => String(node?.id) === text) || null;
}

function graphLinkById(graph, linkId) {
	const links = graph?.links || app.graph?.links || {};
	if (links?.[linkId]) return links[linkId];
	if (Array.isArray(links)) return links.find((link) => String(link?.id) === String(linkId)) || null;
	return null;
}

function upstreamNodes(root, graph = app.graph) {
	const result = [];
	const queue = [root];
	const seen = new Set([String(root?.id ?? "")]);
	while (queue.length) {
		const node = queue.shift();
		for (const input of Array.isArray(node?.inputs) ? node.inputs : []) {
			if (input?.link == null) continue;
			const link = graphLinkById(graph, input.link);
			const origin = graphNodeById(graph, link?.origin_id);
			if (!origin) continue;
			const key = String(origin.id);
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(origin);
			queue.push(origin);
		}
	}
	return result;
}

function findUniversalLoaderForCombine(node, graph = app.graph) {
	const upstream = upstreamNodes(node, graph);
	const linked = upstream.find((candidate) => VIDEO_UNIVERSAL_LOADER_NODES.has(nodeClassName(candidate)));
	if (linked) return linked;
	const allLoaders = (graph?._nodes || []).filter((candidate) => VIDEO_UNIVERSAL_LOADER_NODES.has(nodeClassName(candidate)));
	return allLoaders.length === 1 ? allLoaders[0] : null;
}

function safePrefixPart(value) {
	const text = String(value || "")
		.replace(/[^\p{L}\p{N}\u4e00-\u9fff._-]+/gu, "_")
		.replace(/_{2,}/g, "_")
		.replace(/^[._-]+|[._-]+$/g, "");
	return text.slice(0, 72).replace(/[._-]+$/g, "") || "";
}

function safeJsonParse(text, fallback = null) {
	try {
		const parsed = JSON.parse(String(text || ""));
		return parsed ?? fallback;
	} catch (_) {
		return fallback;
	}
}

function getNodeWidgetValue(node, name, fallback = "") {
	const widget = (node?.widgets || []).find((item) => String(item?.name || "") === name);
	return widget?.value ?? fallback;
}

function loaderPresetPrefixPart(loader) {
	const props = loader?.properties || {};
	const metadata = props[UNIVERSAL_LOADER_METADATA_PROPERTY] || {};
	const configWidget = getWidget(loader, "config");
	const preset = String(metadata.config_label || metadata.config_key || configWidget?.value || "").trim();
	return safePrefixPart(preset);
}

function templateParamsState(templateNode) {
	const props = templateNode?.properties || {};
	const values = safeJsonParse(
		getNodeWidgetValue(templateNode, "values_json", props[TEMPLATE_PARAMS_VALUES_PROPERTY] || "{}"),
		{},
	) || {};
	const schema = safeJsonParse(
		getNodeWidgetValue(templateNode, "schema_json", props[TEMPLATE_PARAMS_SCHEMA_PROPERTY] || "[]"),
		[],
	) || [];
	const entries = new Map();
	const addEntry = (key, value) => {
		const cleanKey = String(key || "").trim();
		if (!cleanKey) return;
		entries.set(cleanKey, value);
		entries.set(cleanKey.toLowerCase(), value);
	};
	if (Array.isArray(schema)) {
		for (const field of schema) {
			if (!field || typeof field !== "object") continue;
			const key = String(field.key || "").trim();
			const label = String(field.label || "").trim();
			const value = values[key] ?? values[label] ?? field.default ?? "";
			addEntry(key, value);
			addEntry(label, value);
		}
	}
	for (const [key, value] of Object.entries(values || {})) {
		addEntry(key, value);
	}
	return entries;
}

function findTemplateParamsNode(node, graph = app.graph) {
	const upstream = upstreamNodes(node, graph);
	const linked = upstream.find((candidate) => nodeClassName(candidate) === TEMPLATE_PARAMS_NODE);
	if (linked) return linked;
	const nodes = (graph?._nodes || []).filter((candidate) => nodeClassName(candidate) === TEMPLATE_PARAMS_NODE);
	return nodes.length ? nodes[0] : null;
}

function wanModePrefixPart(node, graph = app.graph) {
	const templateNode = findTemplateParamsNode(node, graph);
	if (!templateNode) return "";
	const entries = templateParamsState(templateNode);
	for (const name of WAN_MODE_PARAM_NAMES) {
		const key = String(name || "");
		const value = entries.get(key) ?? entries.get(key.toLowerCase());
		const text = String(value ?? "").trim();
		if (text) return safePrefixPart(text);
	}
	return "";
}

function autoFilenamePrefixForNode(node, graph = app.graph) {
	const loader = findUniversalLoaderForCombine(node, graph);
	if (!loader) return "";
	const preset = loaderPresetPrefixPart(loader);
	const wanMode = wanModePrefixPart(node, graph);
	const body = [preset, wanMode].filter(Boolean).join("_");
	return body ? `video/${body}` : "";
}

function shouldUseAutoFilenamePrefix(node, nextPrefix) {
	const widget = getWidget(node, "filename_prefix");
	const current = String(widget?.value ?? "").trim();
	const lastAuto = String(node?.properties?.[AUTO_FILENAME_PREFIX_PROPERTY] || "").trim();
	return Boolean(nextPrefix) && (!current || current === DEFAULT_FILENAME_PREFIX || (!!lastAuto && current === lastAuto));
}

function filenamePrefixInputHasManualLink(node) {
	const candidates = [
		...(Array.isArray(node?.inputs) ? node.inputs : []),
		...(Array.isArray(node?.__gjjVideoCombineFullInputs) ? node.__gjjVideoCombineFullInputs : []),
	];
	return candidates.some((input) => String(input?.name || "") === "filename_prefix" && input?.link != null);
}

function applyAutoFilenamePrefix(node, graph = app.graph, promptNodeInfo = null) {
	if (filenamePrefixInputHasManualLink(node)) return "";
	const nextPrefix = autoFilenamePrefixForNode(node, graph);
	if (!shouldUseAutoFilenamePrefix(node, nextPrefix)) return "";
	node.properties ||= {};
	node.properties[AUTO_FILENAME_PREFIX_PROPERTY] = nextPrefix;
	writeWidgetValue(node, "filename_prefix", nextPrefix);
	if (promptNodeInfo) {
		promptNodeInfo.inputs ||= {};
		promptNodeInfo.inputs.filename_prefix = nextPrefix;
	}
	return nextPrefix;
}

function frameRateInputHasManualLink(node) {
	const candidates = [
		...(Array.isArray(node?.inputs) ? node.inputs : []),
		...(Array.isArray(node?.__gjjVideoCombineFullInputs) ? node.__gjjVideoCombineFullInputs : []),
	];
	return candidates.some((input) => isFrameRateSlot(input) && input?.link != null);
}

function resolveSelectedFrameRateVariable(node) {
	const name = selectedFrameRateVariable(node);
	const resolver = globalThis.GJJ_VariableBroadcast?.resolveVariableBroadcastSource;
	if (!name || typeof resolver !== "function") return null;
	return resolver(node?.graph || app.graph, name);
}

function patchVideoCombineFrameRatePrompt(promptResult, graph) {
	const output = promptResult?.output;
	if (!output) return promptResult;
	for (const [nodeId, nodeInfo] of Object.entries(output)) {
		const node = findVideoCombineNodeForPromptId(graph, nodeId);
		if (!node || !TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) continue;
		applyAutoFilenamePrefix(node, graph, nodeInfo);
		if (!selectedFrameRateVariable(node) || frameRateInputHasManualLink(node)) continue;
		const resolved = resolveSelectedFrameRateVariable(node);
		if (!Array.isArray(resolved) || resolved.length !== 2 || String(resolved[0]) === String(node.id)) continue;
		nodeInfo.inputs = nodeInfo.inputs || {};
		nodeInfo.inputs[FRAME_RATE_WIDGET_NAME] = [String(resolved[0]), Number(resolved[1] || 0)];
	}
	return promptResult;
}

function installFrameRateVariablePromptPatch() {
	if (!api.__gjjVideoCombineFrameRateVariableQueuePatchInstalled && typeof api.queuePrompt === "function") {
		api.__gjjVideoCombineFrameRateVariableQueuePatchInstalled = true;
		const originalQueuePrompt = api.queuePrompt.bind(api);
		api.queuePrompt = async function (...args) {
			patchVideoCombineFrameRatePrompt(args[1], app.rootGraph || app.graph);
			return originalQueuePrompt(...args);
		};
	}
}

app.registerExtension({
	name: "GJJ.VideoCombine",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}

		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (type, name, value, callback, options, ...rest) {
			const widget = originalAddWidget?.apply(this, [type, name, value, callback, options, ...rest]);
			if (isToolbarControlWidgetName(name)) {
				GJJ_Utils.hideWidget(widget);
			}
			return widget;
		};

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			const serializedNode = args?.[0];
			const props = serializedNode?.properties || this.properties || {};
			if (props[FRAME_RATE_VARIABLE_PROPERTY] !== undefined) {
				this.properties ||= {};
				this.properties[FRAME_RATE_VARIABLE_PROPERTY] = String(props[FRAME_RATE_VARIABLE_PROPERTY] || "");
			}
			patchNode(this);
			clearNativePreview(this);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			requestAnimationFrame(() => {
				applyAutoFilenamePrefix(this, app.rootGraph || app.graph);
				applySlotVisibility(this);
				updateToolbar(this);
			});
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			const resizeValue = args?.[0];
			const resizeWidth = validNodeWidth(
				Array.isArray(resizeValue)
					? resizeValue[0]
					: resizeValue?.width ?? this.size?.[0],
			);
			if (!this.__gjjVideoCombineInternalResize) {
				rememberNodeWidth(this, resizeWidth ?? this.size?.[0]);
			}
			updatePreviewLayout(this, resizeWidth);
			if (!this.__gjjVideoCombineInternalResize || this.__gjjVideoCombinePanelMode === "preview") {
				resizeNodeToContent(this);
			}
			requestAnimationFrame(() => {
				const currentWidth = validNodeWidth(this.size?.[0]) ?? resizeWidth;
				if (!this.__gjjVideoCombineInternalResize) {
					rememberNodeWidth(this, currentWidth);
				}
				updatePreviewLayout(this, currentWidth);
				if (this.__gjjVideoCombinePanelMode === "preview") {
					resizeNodeToContent(this);
				}
			});
			return result;
		};

		const originalOnDrawForeground = nodeType.prototype.onDrawForeground;
		nodeType.prototype.onDrawForeground = function (...args) {
			const result = originalOnDrawForeground?.apply(this, args);
			if (this.__gjjVideoCombinePanelMode === "preview") {
				const width = validNodeWidth(this.size?.[0]) ?? preferredNodeWidth(this);
				if (this.__gjjVideoCombinePreviewLayoutWidth !== width) {
					this.__gjjVideoCombinePreviewLayoutWidth = width;
					rememberNodeWidth(this, width);
					updatePreviewLayout(this, width);
					resizeNodeToContent(this);
				}
			}
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			applySlotVisibility(this);
			const result = originalOnSerialize?.apply(this, [serializedNode, ...args]);
			rememberNodeWidth(this, this.size?.[0]);
			if (serializedNode && typeof serializedNode === "object") {
				serializedNode.properties ||= {};
				serializedNode.properties[USER_WIDTH_PROPERTY] = this.properties?.[USER_WIDTH_PROPERTY] ?? preferredNodeWidth(this);
				if (this.properties?.[AUTO_FILENAME_PREFIX_PROPERTY]) {
					serializedNode.properties[AUTO_FILENAME_PREFIX_PROPERTY] = this.properties[AUTO_FILENAME_PREFIX_PROPERTY];
				}
				if (selectedFrameRateVariable(this)) {
					serializedNode.properties[FRAME_RATE_VARIABLE_PROPERTY] = selectedFrameRateVariable(this);
				} else {
					delete serializedNode.properties[FRAME_RATE_VARIABLE_PROPERTY];
				}
			}
			return result;
		};

		nodeType.prototype.onExecuted = function (message) {
			patchNode(this);

			// 只使用本扩展的 DOM 视频预览，不再调用 ComfyUI 原生 onExecuted 预览。
			setPreview(this, message || {});
			clearNativePreview(this);

			// 有些版本会在 onExecuted 之后异步回填原生预览，延迟再清一次。
			requestAnimationFrame(() => clearNativePreview(this));
			setTimeout(() => clearNativePreview(this), 80);
			setTimeout(() => clearNativePreview(this), 240);

			return undefined;
		};
	},

	setup() {
		installFrameRateVariablePromptPatch();
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
				patchNode(node);
				applyAutoFilenamePrefix(node, app.rootGraph || app.graph);
				clearNativePreview(node);
			}
		}
	},
});
