import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_SaveAnyObject"]);
const INPUT_PREFIX = "any_";
const MIN_VISIBLE_INPUTS = 1;
const INPUT_TOOLTIP = "可接任意类型；连接后会自动扩展下一个输入口，执行时按顺序保存。";
const OUTPUT_NAMES = ["保存路径JSON", "首个保存路径", "保存文件数"];
const OUTPUT_TYPES = ["STRING", "STRING", "INT"];
const DEFAULT_PREFIX = "GJJ/工作流";
const LEGACY_DEFAULT_PREFIX = "GJJ/任意对象";
const PREVIEW_WIDGET_NAME = "gjj_save_any_object_preview";
const EMPTY_PREVIEW = "执行后在这里显示保存结果";
const MIN_PREVIEW_HEIGHT = 96;
const MIN_WIDTH = 200;
const MULTI_IMAGE_MIN_WIDTH = 104;
const BUTTON_WIDGET_NAME = "gjj_save_any_object_output_button";
const FOLDER_WIDGET_NAME = "gjj_save_any_object_folder_button";
const FILENAME_VARIABLES_PROPERTY = "gjj_save_any_object_filename_prefix_variables";
const SAVE_FORMAT_CONFIG_WIDGET = "save_format_config";
const SAVE_FORMAT_CONFIG_PROPERTY = "gjj_save_any_object_format_config";
const DEFAULT_SAVE_FORMAT_CONFIG = { image_format: "PNG", audio_format: "WAV" };
const IMAGE_FORMATS = ["PNG", "JPG", "WEBP", "BMP"];
const AUDIO_FORMATS = ["WAV", "MP3"];

function previewDataToUrl(data, includePreviewFormat = true) {
	if (!data?.filename) {
		return "";
	}
	const previewFormat = includePreviewFormat && typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : "";
	return api.apiURL(
		`/view?filename=${encodeURIComponent(data.filename)}&type=${encodeURIComponent(data.type || "output")}&subfolder=${encodeURIComponent(data.subfolder || "")}${previewFormat}${randParam}`
	);
}

function formatInputName(index) {
	return `${INPUT_PREFIX}${String(index).padStart(2, "0")}`;
}

function getInputIndex(name) {
	const text = String(name || "");
	if (!text.startsWith(INPUT_PREFIX)) {
		return Number.MAX_SAFE_INTEGER;
	}
	return Number.parseInt(text.slice(INPUT_PREFIX.length), 10) || Number.MAX_SAFE_INTEGER;
}

function getDynamicInputs(node) {
	return Array.isArray(node?.inputs)
		? node.inputs.filter((input) => String(input?.name || "").startsWith(INPUT_PREFIX)).sort((a, b) => getInputIndex(a?.name) - getInputIndex(b?.name))
		: [];
}

function setDirty(node) {
	GJJ_Utils.refreshNode(node);
}

function scheduleLayout(node) {
	if (!node || node.__gjjSaveAnyObjectLayoutQueued) {
		return;
	}
	node.__gjjSaveAnyObjectLayoutQueued = true;
	requestAnimationFrame(() => {
		node.__gjjSaveAnyObjectLayoutQueued = false;
		const width = Math.max(MIN_WIDTH, Number(node.size?.[0] || MIN_WIDTH));
		const height = Math.max(MIN_PREVIEW_HEIGHT, Number(node.computeSize?.()[1] || node.size?.[1] || MIN_PREVIEW_HEIGHT));
		node.setSize?.([width, height]);
		setDirty(node);
	});
}

function addDynamicInput(node) {
	const nextIndex = getDynamicInputs(node).length + 1;
	node.addInput?.(formatInputName(nextIndex), "*");
}

function removeUnusedInputsFromEnd(node, minInputs = MIN_VISIBLE_INPUTS) {
	const inputs = getDynamicInputs(node);
	for (let index = inputs.length - 1; index >= minInputs; index -= 1) {
		const input = inputs[index];
		if (input?.link) {
			break;
		}
		const slotIndex = node.inputs.indexOf(input);
		if (slotIndex >= 0) {
			node.removeInput?.(slotIndex);
		}
	}
}

function ensureTrailingEmptyInput(node) {
	const inputs = getDynamicInputs(node);
	if (inputs.length === 0) {
		addDynamicInput(node);
		return;
	}
	const lastInput = inputs[inputs.length - 1];
	if (lastInput?.link) {
		addDynamicInput(node);
	}
}

function renameInputsSequentially(node) {
	getDynamicInputs(node).forEach((input, index) => {
		const label = `保存对象 ${index + 1}`;
		input.name = formatInputName(index + 1);
		input.label = label;
		input.localized_name = label;
		input.type = "*";
		input.tooltip = INPUT_TOOLTIP;
	});
}

function normalizeOutputs(node) {
	if (!Array.isArray(node.outputs)) {
		return;
	}
	for (let index = 0; index < OUTPUT_NAMES.length; index += 1) {
		const output = node.outputs[index];
		if (!output) {
			continue;
		}
		output.name = OUTPUT_NAMES[index];
		output.label = OUTPUT_NAMES[index];
		output.localized_name = OUTPUT_NAMES[index];
		output.type = OUTPUT_TYPES[index];
	}
}

function addAllOutputs(node) {
	if (!Array.isArray(node.outputs)) {
		node.outputs = [];
	}
	for (let index = 0; index < OUTPUT_NAMES.length; index += 1) {
		if (!node.outputs[index]) {
			node.addOutput?.(OUTPUT_NAMES[index], OUTPUT_TYPES[index]);
		}
	}
	normalizeOutputs(node);
}

function removeAllOutputs(node) {
	if (!Array.isArray(node.outputs)) {
		return;
	}
	for (let index = node.outputs.length - 1; index >= 0; index -= 1) {
		node.removeOutput?.(index);
	}
}

function sanitizePathPart(value) {
	return String(value || "")
		.replace(/[<>:"|?*\x00-\x1f]/g, "_")
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^[\s/.]+|[\s/.]+$/g, "");
}

function normalizePrefix(value) {
	return sanitizePathPart(value).replace(/^\/+|\/+$/g, "");
}

function cleanWorkflowName(value) {
	let text = String(value || "").trim();
	if (!text) {
		return "";
	}
	text = text.replace(/^ComfyUI\s*[-|–—]\s*/i, "");
	text = text.replace(/\\/g, "/").split("/").filter(Boolean).pop() || text;
	text = text.replace(/\.(json|workflow)$/i, "");
	const clean = sanitizePathPart(text);
	return /^(comfyui|untitled|未命名)$/i.test(clean) ? "" : clean;
}

function workflowNameFromValue(value, depth = 0) {
	if (depth > 4 || value == null) {
		return "";
	}
	if (typeof value === "string") {
		return cleanWorkflowName(value);
	}
	if (typeof value !== "object") {
		return "";
	}
	const nameKeys = ["workflow_name", "workflowName", "name", "title", "filename", "file", "path", "workflow_path", "workflowPath"];
	for (const key of nameKeys) {
		if (!(key in value)) {
			continue;
		}
		const name = workflowNameFromValue(value[key], depth + 1);
		if (name) {
			return name;
		}
	}
	const nestedKeys = ["workflow", "extra", "metadata", "config", "app", "info", "activeWorkflow"];
	for (const key of nestedKeys) {
		const nested = value[key];
		if (nested && typeof nested === "object") {
			const name = workflowNameFromValue(nested, depth + 1);
			if (name) {
				return name;
			}
		}
	}
	return "";
}

function currentWorkflowName(node) {
	const graph = node?.graph || app.graph;
	const candidates = [
		graph,
		graph?.extra,
		graph?._extra,
		graph?.config,
		graph?._config,
		app.workflowManager?.activeWorkflow,
		app.workflowManager?.activeWorkflowInfo,
		app.workflowManager?.currentWorkflow,
		app.workflowManager?.workflow,
		app.workflowManager?.filename,
		app.workflowManager?.path,
		app.ui?.lastWorkflowName,
		app.ui?.workflowName,
		app.ui?.currentWorkflowName,
		document?.title,
	];
	for (const candidate of candidates) {
		const name = workflowNameFromValue(candidate);
		if (name) {
			return name;
		}
	}
	return "";
}

function workflowPrefix(node) {
	const name = currentWorkflowName(node);
	return name ? `GJJ/${name}` : DEFAULT_PREFIX;
}

function getWidget(node, name) {
	return Array.isArray(node?.widgets)
		? node.widgets.find((widget) => String(widget?.name || "") === name)
		: null;
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) {
		return false;
	}
	widget.value = value;
	const index = Array.isArray(node?.widgets) ? node.widgets.indexOf(widget) : -1;
	if (index >= 0) {
		node.widgets_values ||= [];
		node.widgets_values[index] = value;
	}
	widget.callback?.(value, app.canvas, node, app.canvas?.graph_mouse);
	node.onWidgetChanged?.(name, value, widget, node);
	setDirty(node);
	return true;
}

function normalizeSaveFormatConfig(value) {
	let parsed = {};
	if (typeof value === "string" && value.trim()) {
		try {
			parsed = JSON.parse(value);
		} catch (_) {
			parsed = {};
		}
	} else if (value && typeof value === "object") {
		parsed = value;
	}
	const image = String(parsed.image_format || DEFAULT_SAVE_FORMAT_CONFIG.image_format).trim().toUpperCase();
	const audio = String(parsed.audio_format || DEFAULT_SAVE_FORMAT_CONFIG.audio_format).trim().toUpperCase();
	return {
		image_format: IMAGE_FORMATS.includes(image) ? image : DEFAULT_SAVE_FORMAT_CONFIG.image_format,
		audio_format: AUDIO_FORMATS.includes(audio) ? audio : DEFAULT_SAVE_FORMAT_CONFIG.audio_format,
	};
}

function saveFormatConfig(node) {
	const widgetText = String(getWidget(node, SAVE_FORMAT_CONFIG_WIDGET)?.value || "").trim();
	const propertyValue = node?.properties?.[SAVE_FORMAT_CONFIG_PROPERTY];
	return normalizeSaveFormatConfig(widgetText || propertyValue || DEFAULT_SAVE_FORMAT_CONFIG);
}

function applySaveFormatConfig(node, config) {
	const normalized = normalizeSaveFormatConfig(config);
	node.properties ||= {};
	node.properties[SAVE_FORMAT_CONFIG_PROPERTY] = normalized;
	setWidgetValue(node, SAVE_FORMAT_CONFIG_WIDGET, JSON.stringify(normalized));
	updateButtonState(node);
	return normalized;
}

function syncSaveFormatConfig(node) {
	const widget = getWidget(node, SAVE_FORMAT_CONFIG_WIDGET);
	if (widget) {
		widget.hidden = true;
		widget.type = "hidden";
		widget.computeSize = () => [0, -4];
	}
	applySaveFormatConfig(node, saveFormatConfig(node));
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

function stopCanvasEvent(event) {
	event?.stopPropagation?.();
}

function protectButton(button) {
	if (!button) {
		return;
	}
	button.type = "button";
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu"]) {
		button.addEventListener(eventName, stopCanvasEvent);
	}
}

function closeVariablePicker(node) {
	node?.__gjjSaveAnyObjectVariablePicker?.remove?.();
	node.__gjjSaveAnyObjectVariablePicker = null;
	updateButtonState(node);
}

function closeFormatPicker(node) {
	node?.__gjjSaveAnyObjectFormatPicker?.remove?.();
	node.__gjjSaveAnyObjectFormatPicker = null;
	updateButtonState(node);
}

function createFormatButton(node, kind, value) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = value;
	button.style.cssText = [
		"padding:5px 8px",
		"border:1px solid #33434a",
		"border-radius:6px",
		"background:#172127",
		"color:#d9e4df",
		"cursor:pointer",
		"font-size:12px",
	].join(";");
	const refresh = () => {
		const config = saveFormatConfig(node);
		const active = (kind === "image" ? config.image_format : config.audio_format) === value;
		button.style.background = active ? "#1f6b43" : "#172127";
		button.style.borderColor = active ? "#65c783" : "#33434a";
	};
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const config = saveFormatConfig(node);
		if (kind === "image") config.image_format = value;
		else config.audio_format = value;
		applySaveFormatConfig(node, config);
		const picker = node.__gjjSaveAnyObjectFormatPicker;
		picker?.querySelectorAll?.("button[data-format-kind]")?.forEach((item) => item.__refresh?.());
	});
	button.dataset.formatKind = kind;
	button.__refresh = refresh;
	refresh();
	return button;
}

function openFormatPicker(node, anchor) {
	closeVariablePicker(node);
	if (node.__gjjSaveAnyObjectFormatPicker) {
		closeFormatPicker(node);
		return;
	}
	const rect = anchor?.getBoundingClientRect?.() || { left: 0, bottom: 0 };
	const popup = document.createElement("div");
	popup.style.cssText = [
		"position:fixed",
		`left:${Math.max(8, rect.left)}px`,
		`top:${Math.max(8, rect.bottom + 6)}px`,
		"z-index:10000",
		"width:220px",
		"padding:10px",
		"box-sizing:border-box",
		"border:1px solid #33434a",
		"border-radius:8px",
		"background:#0f1418",
		"box-shadow:0 12px 32px rgba(0,0,0,0.35)",
		"color:#d9e4df",
		"font:12px/1.45 sans-serif",
	].join(";");
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "wheel"]) {
		popup.addEventListener(eventName, (event) => event.stopPropagation());
	}
	const title = document.createElement("div");
	title.textContent = "默认保存格式";
	title.style.cssText = "font-weight:700;margin-bottom:8px;color:#e8f1ed;";
	popup.appendChild(title);
	const addGroup = (label, kind, values) => {
		const groupLabel = document.createElement("div");
		groupLabel.textContent = label;
		groupLabel.style.cssText = "margin:8px 0 5px;color:#9fb3b8;";
		const row = document.createElement("div");
		row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;";
		for (const value of values) row.appendChild(createFormatButton(node, kind, value));
		popup.appendChild(groupLabel);
		popup.appendChild(row);
	};
	addGroup("图片", "image", IMAGE_FORMATS);
	addGroup("音频", "audio", AUDIO_FORMATS);
	const note = document.createElement("div");
	note.textContent = "MP3 需要 ffmpeg；不可用时自动回退 WAV。";
	note.style.cssText = "margin-top:8px;color:#8ea0a8;";
	popup.appendChild(note);
	document.body.appendChild(popup);
	node.__gjjSaveAnyObjectFormatPicker = popup;
	const closeOnOutside = (event) => {
		if (!popup.contains(event.target) && event.target !== anchor) {
			document.removeEventListener("pointerdown", closeOnOutside, true);
			closeFormatPicker(node);
		}
	};
	setTimeout(() => document.addEventListener("pointerdown", closeOnOutside, true), 0);
	updateButtonState(node);
}

function insertFilenameVariables(node, variableNames) {
	const names = (Array.isArray(variableNames) ? variableNames : [variableNames])
		.map((item) => String(item || "").trim())
		.filter(Boolean);
	if (!names.length) return;
	const widget = getWidget(node, "filename_prefix");
	const current = String(widget?.value || DEFAULT_PREFIX);
	const tokens = names.map((name) => `{${name}}`).filter((token) => !current.includes(token));
	if (!tokens.length) return;
	const separator = current.endsWith("/") || current.endsWith("_") || !current ? "" : "_";
	const next = `${current}${separator}${tokens.join("_")}`;
	setWidgetValue(node, "filename_prefix", next);
}

function removeFilenameVariables(node, variableNames) {
	const names = (Array.isArray(variableNames) ? variableNames : [variableNames])
		.map((item) => String(item || "").trim())
		.filter(Boolean);
	const widget = getWidget(node, "filename_prefix");
	if (!widget || !names.length) return;
	const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const pattern = new RegExp(`(?:^|_)?\\{(?:${escaped.join("|")})\\}`, "g");
	let next = String(widget.value || "").replace(pattern, "");
	next = next.replace(/_{2,}/g, "_").replace(/\/_/g, "/").replace(/^_+|_+$/g, "");
	setWidgetValue(node, "filename_prefix", next || DEFAULT_PREFIX);
}

function filenameVariableTokens(node) {
	const widget = getWidget(node, "filename_prefix");
	const text = String(widget?.value || "");
	return [...text.matchAll(/\{([^{}]+)\}/g)].map((match) => String(match[1] || "").trim()).filter(Boolean);
}

function selectedFilenameVariables(node) {
	const saved = Array.isArray(node?.properties?.[FILENAME_VARIABLES_PROPERTY])
		? node.properties[FILENAME_VARIABLES_PROPERTY]
		: [];
	return [...new Set([...saved, ...filenameVariableTokens(node)].map((item) => String(item || "").trim()).filter(Boolean))];
}

function setSelectedFilenameVariables(node, names) {
	node.properties ||= {};
	const values = [...new Set((Array.isArray(names) ? names : []).map((item) => String(item || "").trim()).filter(Boolean))];
	if (values.length) node.properties[FILENAME_VARIABLES_PROPERTY] = values;
	else delete node.properties[FILENAME_VARIABLES_PROPERTY];
	updateButtonState(node);
	setDirty(node);
}

function openVariablePicker(node, anchorButton) {
	closeVariablePicker(node);
	const options = variableOptions(node);
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
	const rect = anchorButton?.getBoundingClientRect?.() || { left: 24, bottom: 80 };
	popup.style.left = `${Math.round(Math.max(12, Math.min(window.innerWidth - 440, rect.left || 24)))}px`;
	popup.style.top = `${Math.round(Math.max(12, Math.min(window.innerHeight - 520, (rect.bottom || 80) + 6)))}px`;

	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;gap:8px;";
	const title = document.createElement("div");
	title.textContent = "⚡ 插入文件名变量";
	title.style.cssText = "font-weight:800;flex:1 1 auto;";
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "关闭";
	const clear = document.createElement("button");
	clear.type = "button";
	clear.textContent = "清空";
	const confirm = document.createElement("button");
	confirm.type = "button";
	confirm.textContent = "确定";
	for (const button of [clear, confirm, close]) {
		button.style.cssText = "height:28px;border:1px solid #44565f;border-radius:7px;background:#202b31;color:#dce7e2;cursor:pointer;padding:0 8px;font-size:12px;font-weight:650;";
		protectButton(button);
	}
	clear.style.background = "#26343a";
	confirm.style.background = "#1f6b43";
	header.append(title, clear, confirm, close);
	popup.appendChild(header);

	const search = document.createElement("input");
	search.placeholder = "搜索变量，点击多选，确定后插入 {变量名}";
	search.style.cssText = "height:30px;border:1px solid #3f5b66;border-radius:7px;background:#071015;color:#dce7e2;padding:0 10px;outline:none;";
	popup.appendChild(search);
	const list = document.createElement("div");
	list.style.cssText = "overflow:auto;display:flex;flex-direction:column;gap:5px;max-height:340px;padding-right:2px;";
	popup.appendChild(list);
	const selected = new Set(selectedFilenameVariables(node));

	function render() {
		const needle = String(search.value || "").trim().toLowerCase();
		list.textContent = "";
		for (const option of options) {
			const parts = variableOptionDisplay(option);
			if (!parts.value) continue;
			if (needle && !`${parts.title} ${parts.source} ${parts.value} ${option.label || ""}`.toLowerCase().includes(needle)) continue;
			const isSelected = selected.has(parts.value);
			const item = document.createElement("button");
			item.type = "button";
			item.style.cssText = [
				"display:flex",
				"align-items:center",
				"gap:8px",
				"text-align:left",
				`border:1px solid ${isSelected ? "#68d18d" : "transparent"}`,
				"border-radius:7px",
				"padding:8px 10px",
				`background:${isSelected ? "#245c3d" : "transparent"}`,
				`color:${isSelected ? "#ffffff" : "#dce7e2"}`,
				"cursor:pointer",
				`box-shadow:${isSelected ? "0 0 0 1px rgba(104,209,141,.25) inset" : "none"}`,
			].join(";");
			const mark = document.createElement("span");
			mark.textContent = "⚡";
			mark.style.cssText = `width:18px;color:${isSelected ? "#b7ffd0" : "#6f8790"};font-weight:900;`;
			const text = document.createElement("span");
			const titleLine = document.createElement("b");
			titleLine.textContent = parts.title;
			const detailLine = document.createElement("span");
			detailLine.style.cssText = "color:#8fa3ad";
			detailLine.textContent = `${parts.source ? `${parts.source} · ` : ""}{${parts.value}}`;
			text.append(titleLine, document.createElement("br"), detailLine);
			item.append(mark, text);
			protectButton(item);
			item.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (selected.has(parts.value)) selected.delete(parts.value);
				else selected.add(parts.value);
				render();
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

	confirm.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const values = [...selected];
		setSelectedFilenameVariables(node, values);
		insertFilenameVariables(node, values);
		closeVariablePicker(node);
	});
	clear.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const values = selectedFilenameVariables(node);
		selected.clear();
		setSelectedFilenameVariables(node, []);
		removeFilenameVariables(node, values);
		render();
	});
	close.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		closeVariablePicker(node);
	});
	search.addEventListener("input", render);
	search.addEventListener("mousedown", stopCanvasEvent);
	popup.addEventListener("mousedown", stopCanvasEvent);
	document.body.appendChild(popup);
	node.__gjjSaveAnyObjectVariablePicker = popup;
	render();
	setTimeout(() => search.focus(), 0);
}

function getLinkedSourceNode(input) {
	const linkId = input?.link;
	if (!linkId || !app.graph?.links) {
		return null;
	}
	const link = app.graph.links[linkId];
	return link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
}

function getSourceNodeName(sourceNode) {
	const title = sourceNode?.title || sourceNode?.properties?.title || sourceNode?.type || sourceNode?.comfyClass || "";
	return sanitizePathPart(title);
}

function firstSourcePrefix(node) {
	for (const input of getDynamicInputs(node)) {
		const sourceName = getSourceNodeName(getLinkedSourceNode(input));
		if (sourceName) {
			return `GJJ/${sourceName}`;
		}
	}
	return "";
}

function maybeUpdateFilenamePrefix(node) {
	const widget = getWidget(node, "filename_prefix");
	if (!widget) {
		return;
	}
	const nextPrefix = workflowPrefix(node);
	const sourcePrefix = firstSourcePrefix(node);
	const current = String(widget.value || "").trim();
	const autoPrefixes = new Set([
		"",
		normalizePrefix(DEFAULT_PREFIX),
		normalizePrefix(LEGACY_DEFAULT_PREFIX),
		"工作流",
		"任意对象",
		normalizePrefix(node.__gjjSaveAnyObjectAutoPrefix || ""),
		normalizePrefix(sourcePrefix || ""),
	]);
	const canAutoUpdate = autoPrefixes.has(normalizePrefix(current));
	if (!canAutoUpdate) {
		return;
	}
	if (current !== nextPrefix) {
		widget.value = nextPrefix;
		widget.callback?.(nextPrefix, app.canvas, node, app.canvas?.graph_mouse);
	}
	node.__gjjSaveAnyObjectAutoPrefix = nextPrefix;
}

async function openOutputFolder(node, button) {
	const prefixWidget = getWidget(node, "filename_prefix");
	const prefix = prefixWidget ? String(prefixWidget.value || DEFAULT_PREFIX).trim() : DEFAULT_PREFIX;
	const parts = prefix.split("/").filter((p) => p && p !== "." && p !== "..");
	const folderPath = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
	const oldText = button?.textContent || "📁";
	try {
		if (button) {
			button.disabled = true;
			button.textContent = "...";
		}
		const response = await api.fetchApi(`/gjj/open_folder?path=${encodeURIComponent(folderPath)}`, { method: "POST" });
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(text || `HTTP ${response.status}`);
		}
		if (button) {
			button.title = "已打开保存文件夹";
		}
	} catch (error) {
		console.warn("[GJJ SaveAnyObject] 打开保存文件夹失败:", error);
		if (button) {
			button.title = `打开保存文件夹失败：${error?.message || error}`;
		}
	} finally {
		if (button) {
			button.disabled = false;
			button.textContent = oldText;
		}
	}
}

function buildPreviewText(text) {
	const value = String(text || "").trim();
	return value || EMPTY_PREVIEW;
}

function applyPreviewContent(node) {
	const container = node.__gjjSaveAnyObjectPreviewContainer;
	const imageGrid = node.__gjjSaveAnyObjectImageGrid;
	const mediaGrid = node.__gjjSaveAnyObjectMediaGrid;
	const textBlock = node.__gjjSaveAnyObjectTextBlock;
	const empty = node.__gjjSaveAnyObjectEmpty;
	if (!container || !imageGrid || !mediaGrid || !textBlock || !empty) {
		return;
	}

	const images = Array.isArray(node.__gjjSaveAnyObjectPreviewImages) ? node.__gjjSaveAnyObjectPreviewImages : [];
	const media = Array.isArray(node.__gjjSaveAnyObjectPreviewMedia) ? node.__gjjSaveAnyObjectPreviewMedia : [];
	const text = buildPreviewText(node.__gjjSaveAnyObjectPreviewText);
	const hasImages = images.length > 0;
	const hasMedia = media.length > 0;
	const hasText = text !== EMPTY_PREVIEW;
	const singleImage = images.length === 1;

	imageGrid.style.display = hasImages ? "grid" : "none";
	mediaGrid.style.display = hasMedia ? "grid" : "none";
	textBlock.style.display = hasText ? "block" : "none";
	empty.style.display = hasImages || hasMedia || hasText ? "none" : "flex";
	imageGrid.style.gridTemplateColumns = singleImage ? "minmax(0, 1fr)" : `repeat(auto-fill, minmax(${MULTI_IMAGE_MIN_WIDTH}px, 1fr))`;
	imageGrid.replaceChildren();
	mediaGrid.replaceChildren();

	for (const [index, item] of images.entries()) {
		const imageWidth = Math.max(1, Number(item?.width || 0));
		const imageHeight = Math.max(1, Number(item?.height || 0));
		const image = document.createElement("img");
		image.src = previewDataToUrl(item);
		image.draggable = false;
		image.alt = `图片 ${index + 1}`;
		image.title = String(item.path || item.filename || `图片 ${index + 1}`);
		image.style.cssText = [
			"width:100%",
			"height:auto",
			`aspect-ratio:${imageWidth} / ${imageHeight}`,
			"object-fit:contain",
			"background:#0c1114",
			"border:1px solid #2b3940",
			"border-radius:6px",
			"display:block",
			"box-sizing:border-box",
			"min-width:0",
		].join(";");
		image.onload = () => scheduleLayout(node);
		image.onerror = () => scheduleLayout(node);
		imageGrid.appendChild(image);
	}

	for (const [index, item] of media.entries()) {
		const mediaType = String(item?.media_type || "");
		const url = previewDataToUrl(item, false);
		if (!url) {
			continue;
		}
		const control = mediaType === "audio" ? document.createElement("audio") : document.createElement("video");
		control.controls = true;
		control.preload = mediaType === "audio" ? "metadata" : "auto";
		control.src = url;
		control.title = String(item.path || item.filename || `${mediaType === "audio" ? "音频" : "视频"} ${index + 1}`);
		if (control.tagName === "VIDEO") {
			control.autoplay = true;
			control.muted = true;
			control.defaultMuted = true;
			control.loop = true;
			control.playsInline = true;
			control.setAttribute("muted", "");
			control.setAttribute("playsinline", "");
			control.style.cssText = [
				"width:100%",
				"height:auto",
				"aspect-ratio:16 / 9",
				"object-fit:contain",
				"background:#050708",
				"border:1px solid #2b3940",
				"border-radius:6px",
				"display:block",
				"box-sizing:border-box",
				"min-width:0",
			].join(";");
			const playVideo = () => control.play?.().catch(() => {});
			control.onloadedmetadata = () => {
				const width = Math.max(1, Number(control.videoWidth || 0));
				const height = Math.max(1, Number(control.videoHeight || 0));
				if (width && height) {
					control.style.aspectRatio = `${width} / ${height}`;
				}
				scheduleLayout(node);
				playVideo();
			};
			control.oncanplay = playVideo;
			setTimeout(playVideo, 0);
			control.onerror = () => scheduleLayout(node);
		} else {
			control.style.cssText = [
				"width:100%",
				"height:36px",
				"display:block",
				"box-sizing:border-box",
			].join(";");
		}
		mediaGrid.appendChild(control);
	}

	textBlock.textContent = text;
	requestAnimationFrame(() => {
		node.__gjjSaveAnyObjectPreviewHeight = Math.max(
			MIN_PREVIEW_HEIGHT,
			Math.ceil(container.scrollHeight || container.offsetHeight || MIN_PREVIEW_HEIGHT),
		);
		scheduleLayout(node);
	});
}

function moveWidgetAfter(node, widgetName, afterName) {
	if (!Array.isArray(node.widgets)) {
		return;
	}
	const targetIndex = node.widgets.findIndex((w) => String(w?.name || "") === widgetName);
	const afterIndex = node.widgets.findIndex((w) => String(w?.name || "") === afterName);
	if (targetIndex < 0 || afterIndex < 0 || targetIndex === afterIndex + 1) {
		return;
	}
	const [widget] = node.widgets.splice(targetIndex, 1);
	const newAfterIndex = node.widgets.findIndex((w) => String(w?.name || "") === afterName);
	node.widgets.splice(newAfterIndex + 1, 0, widget);
}

function ensureButtonWidget(node) {
	if (node.__gjjSaveAnyObjectButtonContainer) {
		updateButtonState(node);
		moveWidgetAfter(node, BUTTON_WIDGET_NAME, "filename_prefix");
		return;
	}

	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"gap:8px",
		"width:100%",
		"box-sizing:border-box",
	].join(";");
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu"]) {
		container.addEventListener(eventName, stopCanvasEvent);
	}

	const outputButton = document.createElement("button");
	outputButton.style.cssText = [
		"flex:1",
		"padding:6px 12px",
		"background:#2a3a42",
		"color:#d9e4df",
		"border:1px solid #33434a",
		"border-radius:6px",
		"cursor:pointer",
		"font-size:12px",
		"font-weight:500",
		"transition:background 0.15s",
	].join(";");
	outputButton.onmouseover = () => { outputButton.style.background = "#3a4a52"; };
	outputButton.onmouseout = () => { outputButton.style.background = "#2a3a42"; };
	protectButton(outputButton);
	outputButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		node.__gjjSaveAnyObjectHasOutput = !node.__gjjSaveAnyObjectHasOutput;
		if (node.__gjjSaveAnyObjectHasOutput) {
			addAllOutputs(node);
			ensurePreviewWidget(node);
		} else {
			removeAllOutputs(node);
			removePreviewWidget(node);
		}
		updateButtonState(node);
		setDirty(node);
	});

	const folderButton = document.createElement("button");
	folderButton.textContent = "📁";
	folderButton.title = "打开保存文件夹";
	folderButton.style.cssText = [
		"padding:6px 12px",
		"background:#2a3a42",
		"color:#d9e4df",
		"border:1px solid #33434a",
		"border-radius:6px",
		"cursor:pointer",
		"font-size:14px",
		"transition:background 0.15s",
	].join(";");
	folderButton.onmouseover = () => { folderButton.style.background = "#3a4a52"; };
	folderButton.onmouseout = () => { folderButton.style.background = "#2a3a42"; };
	protectButton(folderButton);
	folderButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openOutputFolder(node, folderButton);
	});

	const variableButton = document.createElement("button");
	variableButton.textContent = "⚡";
	variableButton.title = "选择 GJJ_SETNODE / 模板参数变量，插入到文件名前缀";
	variableButton.style.cssText = folderButton.style.cssText;
	variableButton.onmouseover = () => { variableButton.style.background = "#3a4a52"; };
	variableButton.onmouseout = () => updateButtonState(node);
	protectButton(variableButton);
	variableButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openVariablePicker(node, variableButton);
	});

	const formatButton = document.createElement("button");
	formatButton.textContent = "⚙️";
	formatButton.title = "设置默认保存格式";
	formatButton.style.cssText = folderButton.style.cssText;
	formatButton.onmouseover = () => { formatButton.style.background = "#3a4a52"; };
	formatButton.onmouseout = () => updateButtonState(node);
	protectButton(formatButton);
	formatButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openFormatPicker(node, formatButton);
	});

	container.appendChild(outputButton);
	container.appendChild(variableButton);
	container.appendChild(formatButton);
	container.appendChild(folderButton);

	const widget = node.addDOMWidget?.(BUTTON_WIDGET_NAME, "操作按钮", container, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => 32,
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(MIN_WIDTH, Number(width || MIN_WIDTH)), 32];
		widget.draw = () => {};
		node.__gjjSaveAnyObjectButtonWidget = widget;
	}

	moveWidgetAfter(node, BUTTON_WIDGET_NAME, "filename_prefix");

	node.__gjjSaveAnyObjectButtonContainer = container;
	node.__gjjSaveAnyObjectButton = outputButton;
	node.__gjjSaveAnyObjectVariableButton = variableButton;
	node.__gjjSaveAnyObjectFormatButton = formatButton;
	node.__gjjSaveAnyObjectFolderButton = folderButton;
	updateButtonState(node);
}

function updateButtonState(node) {
	const button = node.__gjjSaveAnyObjectButton;
	if (!button) {
		return;
	}
	if (node.__gjjSaveAnyObjectHasOutput) {
		button.textContent = "🔌";
		button.style.background = "#3a4a52";
	} else {
		button.textContent = "🔌";
		button.style.background = "#2a3a42";
	}
	const variableButton = node.__gjjSaveAnyObjectVariableButton;
	if (variableButton) {
		const hasVariables = selectedFilenameVariables(node).length > 0 || Boolean(node.__gjjSaveAnyObjectVariablePicker);
		variableButton.style.background = hasVariables ? "#1f6b43" : "#2a3a42";
		variableButton.style.borderColor = hasVariables ? "#65c783" : "#33434a";
		variableButton.title = hasVariables
			? `文件名变量：${selectedFilenameVariables(node).map((item) => `{${item}}`).join(" ")}`
			: "选择 GJJ_SETNODE / 模板参数变量，插入到文件名前缀";
	}
	const formatButton = node.__gjjSaveAnyObjectFormatButton;
	if (formatButton) {
		const config = saveFormatConfig(node);
		const active = config.image_format !== DEFAULT_SAVE_FORMAT_CONFIG.image_format || config.audio_format !== DEFAULT_SAVE_FORMAT_CONFIG.audio_format || Boolean(node.__gjjSaveAnyObjectFormatPicker);
		formatButton.style.background = active ? "#1f4f6b" : "#2a3a42";
		formatButton.style.borderColor = active ? "#65a8c7" : "#33434a";
		formatButton.title = `默认保存格式：图片 ${config.image_format}，音频 ${config.audio_format}`;
	}
}

function removePreviewWidget(node) {
	if (!node.__gjjSaveAnyObjectPreviewContainer) {
		return;
	}
	const widgetIndex = Array.isArray(node.widgets) ? node.widgets.indexOf(node.__gjjSaveAnyObjectPreviewWidget) : -1;
	if (widgetIndex >= 0) {
		node.widgets.splice(widgetIndex, 1);
	}
	node.__gjjSaveAnyObjectPreviewContainer = null;
	node.__gjjSaveAnyObjectImageGrid = null;
	node.__gjjSaveAnyObjectMediaGrid = null;
	node.__gjjSaveAnyObjectTextBlock = null;
	node.__gjjSaveAnyObjectEmpty = null;
	node.__gjjSaveAnyObjectPreviewWidget = null;
	node.__gjjSaveAnyObjectPreviewHeight = null;
}

function ensurePreviewWidget(node) {
	if (node.__gjjSaveAnyObjectPreviewContainer) {
		applyPreviewContent(node);
		return;
	}

	if (!node.__gjjSaveAnyObjectHasOutput) {
		return;
	}

	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"width:100%",
		"box-sizing:border-box",
		"margin-top:2px",
		"padding:0",
		"color:#d9e4df",
		"font-size:16px",
		"line-height:1.45",
		"user-select:text",
		"pointer-events:auto",
	].join(";");

	const imageGrid = document.createElement("div");
	imageGrid.style.cssText = [
		"display:none",
		`grid-template-columns:repeat(auto-fill, minmax(${MULTI_IMAGE_MIN_WIDTH}px, 1fr))`,
		"gap:4px",
		"width:100%",
		"align-items:start",
	].join(";");

	const mediaGrid = document.createElement("div");
	mediaGrid.style.cssText = [
		"display:none",
		"grid-template-columns:minmax(0, 1fr)",
		"width:100%",
		"align-items:start",
	].join(";");

	const textBlock = document.createElement("pre");
	textBlock.style.cssText = [
		"display:none",
		"margin:0",
		"border:1px solid #2b3940",
		"border-radius:6px",
		"background:#0f1418",
		"white-space:pre-wrap",
		"overflow-wrap:anywhere",
		"font:12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace",
		"color:#d9e4df",
	].join(";");

	const empty = document.createElement("div");
	empty.textContent = EMPTY_PREVIEW;
	empty.style.cssText = [
		"display:flex",
		"align-items:center",
		"min-height:40px",
		"color:#8ea0a8",
	].join(";");

	const stopCanvasCapture = (event) => event.stopPropagation();
	for (const eventName of ["mousedown", "pointerdown", "dblclick", "mousemove", "pointermove", "mouseup", "pointerup"]) {
		container.addEventListener(eventName, stopCanvasCapture);
	}

	container.appendChild(mediaGrid);
	container.appendChild(imageGrid);
	container.appendChild(textBlock);
	container.appendChild(empty);

	const widget = node.addDOMWidget?.(PREVIEW_WIDGET_NAME, "保存预览", container, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => Math.max(MIN_PREVIEW_HEIGHT, node.__gjjSaveAnyObjectPreviewHeight || MIN_PREVIEW_HEIGHT),
	});
	if (widget) {
		widget.computeSize = (width) => [
			Math.max(MIN_WIDTH, Number(width || MIN_WIDTH)),
			Math.max(MIN_PREVIEW_HEIGHT, node.__gjjSaveAnyObjectPreviewHeight || MIN_PREVIEW_HEIGHT),
		];
		widget.draw = () => {};
		node.__gjjSaveAnyObjectPreviewWidget = widget;
	}

	node.__gjjSaveAnyObjectPreviewContainer = container;
	node.__gjjSaveAnyObjectImageGrid = imageGrid;
	node.__gjjSaveAnyObjectMediaGrid = mediaGrid;
	node.__gjjSaveAnyObjectTextBlock = textBlock;
	node.__gjjSaveAnyObjectEmpty = empty;
	applyPreviewContent(node);
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}
	removeUnusedInputsFromEnd(node, MIN_VISIBLE_INPUTS);
	ensureTrailingEmptyInput(node);
	renameInputsSequentially(node);
	if (node.__gjjSaveAnyObjectHasOutput) {
		addAllOutputs(node);
	} else {
		removeAllOutputs(node);
	}
	maybeUpdateFilenamePrefix(node);
	syncSaveFormatConfig(node);
	ensureButtonWidget(node);
	ensurePreviewWidget(node);
	setDirty(node);
}

function scheduleStabilize(node, ms = 32) {
	if (!node) {
		return;
	}
	clearTimeout(node.__gjjSaveAnyObjectTimer);
	node.__gjjSaveAnyObjectTimer = setTimeout(() => stabilizeNode(node), ms);
}

function inputSignature(node) {
	return getDynamicInputs(node).map((input) => `${input.name}:${input.link || ""}`).join("|");
}

app.registerExtension({
	name: "Comfy.GJJ.SaveAnyObject",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			this.__gjjSaveAnyObjectHasOutput = false;
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			const serializedNode = args?.[0];
			const props = serializedNode?.properties || this.properties || {};
			if (Array.isArray(props[FILENAME_VARIABLES_PROPERTY])) {
				this.properties ||= {};
				this.properties[FILENAME_VARIABLES_PROPERTY] = props[FILENAME_VARIABLES_PROPERTY].map((item) => String(item || "").trim()).filter(Boolean);
			}
			this.properties ||= {};
			this.properties[SAVE_FORMAT_CONFIG_PROPERTY] = normalizeSaveFormatConfig(props[SAVE_FORMAT_CONFIG_PROPERTY] || props[SAVE_FORMAT_CONFIG_WIDGET]);
			if (this.__gjjSaveAnyObjectHasOutput === undefined) {
				this.__gjjSaveAnyObjectHasOutput = false;
			}
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			const result = originalOnSerialize?.apply(this, [serializedNode, ...args]);
			if (serializedNode && typeof serializedNode === "object") {
				serializedNode.properties ||= {};
				const filenameVariables = selectedFilenameVariables(this);
				if (filenameVariables.length) {
					serializedNode.properties[FILENAME_VARIABLES_PROPERTY] = filenameVariables;
				} else {
					delete serializedNode.properties[FILENAME_VARIABLES_PROPERTY];
				}
				serializedNode.properties[SAVE_FORMAT_CONFIG_PROPERTY] = saveFormatConfig(this);
			}
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this);
			return result;
		};

		const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			const result = originalOnDrawBackground?.apply(this, args);
			const signature = `${inputSignature(this)}|${workflowPrefix(this)}`;
			if (signature !== this.__gjjSaveAnyObjectInputSignature) {
				this.__gjjSaveAnyObjectInputSignature = signature;
				scheduleStabilize(this);
			}
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const cleanMessage = { ...(message || {}) };

			// 后端保留这些标准字段给 ComfyUI 任务队列/历史记录显示缩略图；
			// 本节点面板使用自定义 DOM 预览，这里交给原生 onExecuted 前先删掉，避免重复预览。
			delete cleanMessage.images;
			delete cleanMessage.gifs;
			delete cleanMessage.animated;
			delete cleanMessage.audio;
			delete cleanMessage.text;

			const result = originalOnExecuted?.apply(this, [cleanMessage]);
			const count = Number(message?.saved_count?.[0] || 0);
			const firstPath = String(message?.first_path?.[0] || "");
			this.__gjjSaveAnyObjectPreviewImages = Array.isArray(message?.preview_images) ? message.preview_images : [];
			this.__gjjSaveAnyObjectPreviewMedia = Array.isArray(message?.preview_media) ? message.preview_media : [];
			this.__gjjSaveAnyObjectPreviewText = String(message?.preview_text?.[0] || "");
			this.title = count > 0 ? `GJJ · 💾 保存任意对象 (${count})` : "GJJ · 💾 保存任意对象";
			if (firstPath) {
				this.__gjjSaveAnyObjectLastPath = firstPath;
			}
			if (count > 0) {
				this.__gjjSaveAnyObjectHasOutput = true;
			}
			ensureButtonWidget(this);
			ensurePreviewWidget(this);
			setDirty(this);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				if (node.__gjjSaveAnyObjectHasOutput === undefined) {
					node.__gjjSaveAnyObjectHasOutput = false;
				}
				stabilizeNode(node);
			}
		}
	},
});
