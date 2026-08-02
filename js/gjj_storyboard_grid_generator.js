import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";
import { createTemplateSourceButton, updateTemplateSourcePanel } from "./gjj_generation_template_sources.js";
import { getModelFamilyPresets, matchModelFamilyPreset } from "./gjj_model_family_preset_table.js";
import { bindGjjMediaDrag } from "./gjj_media_drag.js";
import { ensureGjjTempImagePreview, gjjTempImageOriginalItem, gjjTempImagePreviewItem, loadGjjPreviewBlobUrl, preloadGjjFullImage } from "./gjj_temp_image_preview.js";
import { gjjCharacterThumbnailPath, gjjSceneThumbnailPath, loadGjjLibraryThumbnailBlobUrl } from "./gjj_library_thumbnails.js";

const TARGET_NODES = new Set(["GJJ_StoryboardGridGenerator"]);
const SETTINGS_OPEN_PROPERTY = "gjj_storyboard_grid_settings_open_v3";
const EXECUTE_BUTTON_NAME = "__gjj_storyboard_execute_button";
const IMAGE_PREVIEW_NAME = "__gjj_storyboard_image_preview";
const PARAM_VALUES_PROPERTY = "gjj_storyboard_grid_param_values_v3";
const SYNCED_PROMPT_PROPERTY = "gjj_storyboard_synced_prompt_v1";
const SELECTED_CELL_PROPERTY = "gjj_storyboard_selected_cell_v1";
const SELECTED_CELLS_PROPERTY = "gjj_storyboard_selected_cells_v1";
const UNET_FILTER_PROPERTY = "gjj_storyboard_unet_filter_v1";
const UNET_FILTER_WIDGET_NAME = "__gjj_storyboard_unet_filter";
const SINGLE_CELL_INDEX_INPUT = "single_cell_index";
const SINGLE_CELL_TOTAL_INPUT = "single_cell_total";
const SELECTED_CELL_INDICES_INPUT = "selected_cell_indices";
const FULL_PROMPT_INPUT = "storyboard_full_prompt";
const FORCE_GENERATE_INPUT = "force_generate_all";
const PREVIEW_IMAGES_INPUT = "storyboard_preview_images";
const STORYBOARD_LORA_NAME = "storyboard_lora_name";
const RECONNECT_LINKS_PROPERTY = "gjj_storyboard_grid_last_upstream_links";
const CACHED_PREVIEW_IMAGES_PROPERTY = "gjj_storyboard_grid_cached_preview_images_v1";
const GRID_CELLS_PROPERTY = "gjj_storyboard_grid_cells_v1";
const DEFAULT_UNET_FILTER = "flux|f2k|edit";
const SEED_CONTROL_KEY = "__seed_control_after_generate";
const SEED_CONTROL_VALUES = new Set(["fixed", "increment", "decrement", "randomize"]);
const JS_SAFE_MAX_SEED_VALUE = Number.MAX_SAFE_INTEGER;
const CHARACTER_REF_PATTERN = /@([0-9A-Za-z\u4e00-\u9fff._-]+)(?:\/([0-9A-Za-z\u4e00-\u9fff._-]+))?/g;
const SCENE_VIEW_REF_PATTERN = /\[\s*([^\[\]/:：]+?)\s*[:：]\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*,\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*,\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*,\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*\]/g;
// Upstream prompt generators and older workflows may use either the camping
// or landscape emoji for a scene reference.  Treat both as the same syntax;
// scene picker replacements are still normalized to the canonical 🏕️ form.
const SCENE_REF_PATTERN = /(?:🏕️?|🏞️?|🌄️?|🌆️?)([0-9A-Za-z\u4e00-\u9fff._-]+)(?:[/\\]([0-9A-Za-z\u4e00-\u9fff._-]+))?|\[([0-9A-Za-z\u4e00-\u9fff._-]+)(?:[/\\]([0-9A-Za-z\u4e00-\u9fff._-]+))?\]/g;
const COSTUME_REF_PATTERN = /(?:💼|👗|📦)([0-9A-Za-z\u4e00-\u9fff._-]+)|\[(?:服装|道具|产品|prop|product|costume)[:：]([0-9A-Za-z\u4e00-\u9fff._-]+)\]/gi;
const ALWAYS_VISIBLE_WIDGETS = new Set(["prompt"]);
const ALWAYS_HIDDEN_WIDGETS = new Set(["unet_name", "lora_data", SINGLE_CELL_INDEX_INPUT, SINGLE_CELL_TOTAL_INPUT, SELECTED_CELL_INDICES_INPUT, FULL_PROMPT_INPUT, FORCE_GENERATE_INPUT, PREVIEW_IMAGES_INPUT]);
const PANEL_SYNC_WIDGETS = [
	"prompt",
	"negative_prompt",
	"main_image_index",
	"width",
	"height",
	"batch_size",
	UNET_FILTER_WIDGET_NAME,
	"unet_name",
	"unet_dtype",
	"clip_name1",
	"vae_name",
	STORYBOARD_LORA_NAME,
	"seed",
	"steps",
	"cfg",
	"sampler_name",
	"scheduler",
	"denoise",
	"grow_mask_by",
	"layout_mode",
	"gap",
	"cell_fit",
	"resize_method",
	"size_alignment",
	"keep_model_loaded",
];
const PREVIEW_REFRESH_WIDGETS = new Set(["width", "height", "layout_mode", "gap", "size_alignment"]);
const CACHE_INVALIDATION_WIDGETS = new Set([
	...PANEL_SYNC_WIDGETS.filter((name) => !["prompt", UNET_FILTER_WIDGET_NAME, "keep_model_loaded"].includes(name)),
	"lora_data",
]);
const CACHE_INVALIDATION_INPUTS = new Set(["prompt", "scene", "reference", "lora_chain_config"]);
const PARAMETER_DIALOG_GROUPS = {
	size: {
		title: "📐 尺寸与宫格",
		widgets: ["width", "height", "layout_mode", "gap", "cell_fit", "resize_method", "size_alignment"],
	},
	model: {
		title: "🧠 模型设置",
		widgets: ["unet_name", "unet_dtype", "clip_name1", "vae_name", STORYBOARD_LORA_NAME, "keep_model_loaded"],
	},
	settings: {
		title: "⚙️ 生成设置",
		widgets: ["negative_prompt", "main_image_index", "batch_size", "seed", "steps", "cfg", "sampler_name", "scheduler", "denoise", "grow_mask_by"],
	},
};
let activeParameterDialog = null;
let activeModelSearchPopup = null;
const TEMPLATE_SOURCE_FIELDS = [
	{ name: "prompt", widget: "prompt", label: "提示词", type: "STRING", aliases: ["prompt", "positive", "正向", "提示词"] },
	{ name: "width", widget: "width", label: "宽度", type: "INT", aliases: ["width", "宽", "宽度"] },
	{ name: "height", widget: "height", label: "高度", type: "INT", aliases: ["height", "高", "高度"] },
];
const DEFAULT_LORA_ROW = { enabled: true, name: "", strength: 1.0 };
const NEXT_SCENE_LORA = "next-scene_lora-v2-3000.safetensors";
const FLUX_STORYBOARD_LORA = "f2k_9B_lcs_consist";
const REQUIRED_LIGHTNING_LORA_ENTRY = "__required_lightning_lora";

function normalizeStoryboardLoraData(value) {
	let rows;
	try {
		rows = JSON.parse(String(value || "[]"));
	} catch {
		rows = [];
	}
	if (!Array.isArray(rows)) rows = [];
	const seen = new Set();
	const configured = rows
		.filter((row) => row && typeof row === "object" && String(row.name || "").trim())
		.map((row) => ({
			...row,
			enabled: row.enabled !== false,
			name: String(row.name || "").trim(),
			strength: normalizeStrength(row.strength, 1.0),
		}))
		.filter((row) => {
			const key = row.name.replace(/\\/g, "/").toLowerCase().split("/").pop();
			if (!key || seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	configured.push({ ...DEFAULT_LORA_ROW });
	return JSON.stringify(configured);
}

function isTarget(node) {
	return TARGET_NODES.has(node?.comfyClass || node?.type);
}

function getWidget(node, name) {
	return GJJ_Utils.getWidget?.(node, name) || node?.widgets?.find((widget) => widget?.name === name);
}

function getInput(node, name) {
	return node?.inputs?.find((input) => String(input?.name || "") === name);
}

function linkedPromptSource(node) {
	const input = getInput(node, "prompt");
	if (input?.link == null) return null;
	const link = getGraphLink(input.link, node?.graph || app.graph);
	if (!link) return null;
	const sourceId = linkOriginId(link);
	const graph = node?.graph || app.graph;
	const sourceNode = graph?.getNodeById?.(sourceId)
		|| graph?._nodes?.find((item) => String(item?.id) === String(sourceId))
		|| null;
	if (!sourceNode) return { node: null, text: "" };
	const liveTextCandidates = [
		sourceNode.__gjjTextInputLiveText,
		sourceNode.__gjjAnyPreviewText,
		sourceNode.__gjjPreviewText,
		sourceNode.__previewText,
	];
	for (const liveText of liveTextCandidates) {
		if (liveText !== undefined && liveText !== null && String(liveText) !== "") {
			return { node: sourceNode, text: String(liveText) };
		}
	}
	const preferredNames = ["text", "prompt", "value"];
	for (const name of preferredNames) {
		const widget = sourceNode.widgets?.find((item) => String(item?.name || "") === name);
		if (widget && typeof widget.value === "string") {
			return { node: sourceNode, text: widget.value };
		}
	}
	return { node: sourceNode, text: "" };
}

function refreshStoryboardsFromPromptSource(sourceNode) {
	setTimeout(() => {
		for (const node of app.graph?._nodes || []) {
			if (!isTarget(node)) continue;
			const linked = linkedPromptSource(node);
			if (!linked?.node || linked.node !== sourceNode) continue;
			const nextPrompt = currentPromptText(node);
			const changed = reconcilePreviewForPromptChange(node, nextPrompt);
			void resolvePromptCharacters(node, nextPrompt);
			if (!changed) drawPromptGridPreview(node);
		}
	}, 0);
}

function observeLinkedPromptSource(node) {
	const sourceNode = linkedPromptSource(node)?.node;
	if (!sourceNode) return;
	for (const widget of sourceNode.widgets || []) {
		if (!["text", "prompt", "value"].includes(String(widget?.name || ""))) continue;
		if (widget.__gjjStoryboardSourceObserved) continue;
		widget.__gjjStoryboardSourceObserved = true;
		const original = widget.callback;
		widget.callback = function (value, ...args) {
			const result = original?.apply(this, [value, ...args]);
			refreshStoryboardsFromPromptSource(sourceNode);
			return result;
		};
	}
	observeLinkedCacheSources(node);
}

function linkedInputSourceNode(node, inputName) {
	const input = getInput(node, inputName);
	if (input?.link == null) return null;
	const link = getGraphLink(input.link, node?.graph || app.graph);
	return getGraphNodeById(linkOriginId(link), node?.graph || app.graph);
}

function refreshStoryboardsFromCacheSource(sourceNode) {
	setTimeout(() => {
		for (const node of app.graph?._nodes || []) {
			if (!isTarget(node)) continue;
			const linkedNames = [...CACHE_INVALIDATION_INPUTS].filter((name) => linkedInputSourceNode(node, name) === sourceNode);
			if (!linkedNames.length) continue;
			const promptLinked = linkedNames.includes("prompt");
			const nextPrompt = currentPromptText(node);
			if (promptLinked) reconcilePreviewForPromptChange(node, nextPrompt);
			if (promptLinked) void resolvePromptCharacters(node, nextPrompt);
			drawPromptGridPreview(node);
		}
	}, 0);
}

function observeLinkedCacheSources(node) {
	for (const inputName of CACHE_INVALIDATION_INPUTS) {
		const sourceNode = linkedInputSourceNode(node, inputName);
		if (!sourceNode || sourceNode.__gjjStoryboardCacheExecutionObserved) continue;
		sourceNode.__gjjStoryboardCacheExecutionObserved = true;
		const originalOnExecuted = sourceNode.onExecuted;
		sourceNode.onExecuted = function (message, ...args) {
			const result = originalOnExecuted?.apply(this, [message, ...args]);
			refreshStoryboardsFromCacheSource(this);
			return result;
		};
	}
}

function getGraphLink(linkId, graph = app.graph) {
	if (linkId == null || !graph) return null;
	if (typeof graph.getLink === "function") {
		const link = graph.getLink(linkId);
		if (link) return link;
	}
	const links = graph.links || graph._links;
	if (!links) return null;
	if (Array.isArray(links)) {
		return links.find((link) => String(link?.id ?? link?.[0]) === String(linkId)) || null;
	}
	if (links instanceof Map) {
		return links.get(linkId) || links.get(String(linkId)) || null;
	}
	return links[linkId] || links[String(linkId)] || null;
}

function linkOriginId(link) {
	return Array.isArray(link) ? link[1] : link?.origin_id;
}

function linkOriginSlot(link) {
	return Number(Array.isArray(link) ? link[2] : link?.origin_slot);
}

function getGraphNodeById(nodeId, graph = app.graph) {
	if (nodeId == null || !graph) return null;
	return graph.getNodeById?.(nodeId)
		|| graph.getNodeById?.(Number(nodeId))
		|| (graph._nodes || []).find((item) => String(item?.id) === String(nodeId))
		|| null;
}

function storyboardLinkMemory(node) {
	const records = node?.properties?.[RECONNECT_LINKS_PROPERTY];
	return Array.isArray(records) ? records.filter((item) => item && item.source_id != null && Number.isFinite(Number(item.source_slot))) : [];
}

function saveStoryboardLinkMemory(node, records) {
	if (!node) return false;
	node.properties ||= {};
	const clean = [];
	const seen = new Set();
	for (const record of records || []) {
		const targetSlot = Number(record?.target_slot);
		const sourceSlot = Number(record?.source_slot);
		if (record?.source_id == null || !Number.isFinite(sourceSlot)) continue;
		const targetInputName = String(record?.target_input_name || "");
		const key = `${targetInputName || targetSlot}:${record.source_id}:${sourceSlot}`;
		if (seen.has(key)) continue;
		seen.add(key);
		clean.push({
			source_id: record.source_id,
			source_slot: sourceSlot,
			source_title: String(record.source_title || ""),
			source_label: String(record.source_label || ""),
			target_input_name: targetInputName,
			target_slot: Number.isFinite(targetSlot) ? targetSlot : null,
		});
	}
	node.properties[RECONNECT_LINKS_PROPERTY] = clean;
	return true;
}

function sourceNodeTitle(node) {
	return String(node?.title || node?.type || node?.comfyClass || "");
}

function sourceOutputLabel(node, slot) {
	const output = node?.outputs?.[Number(slot)];
	return String(output?.label || output?.localized_name || output?.name || "");
}

function storeStoryboardLink(node, input, link, targetSlot = null) {
	if (!node || !input || !link) return false;
	const graph = node?.graph || app.graph;
	const sourceId = linkOriginId(link);
	const sourceSlot = linkOriginSlot(link);
	if (sourceId == null || !Number.isFinite(sourceSlot)) return false;
	const sourceNode = getGraphNodeById(sourceId, graph);
	const slot = Number.isFinite(Number(targetSlot)) ? Number(targetSlot) : node.inputs?.indexOf(input);
	const records = storyboardLinkMemory(node).filter((record) => {
		const sameName = String(record.target_input_name || "") === String(input.name || "");
		const sameSlot = Number(record.target_slot) === Number(slot);
		return !(sameName || sameSlot);
	});
	records.unshift({
		source_id: sourceId,
		source_slot: sourceSlot,
		source_title: sourceNodeTitle(sourceNode),
		source_label: sourceOutputLabel(sourceNode, sourceSlot),
		target_input_name: String(input.name || ""),
		target_slot: Number.isFinite(slot) ? slot : null,
	});
	return saveStoryboardLinkMemory(node, records);
}

function recordCurrentStoryboardLinks(node) {
	let changed = false;
	for (const input of node?.inputs || []) {
		const link = getGraphLink(input?.link, node?.graph || app.graph);
		if (link) changed = storeStoryboardLink(node, input, link, node.inputs?.indexOf(input)) || changed;
	}
	return changed;
}

function recordStoryboardLinkFromConnectionEvent(node, args) {
	const [type, slot, connected, linkInfo] = args || [];
	const isInputEvent =
		type === globalThis.LiteGraph?.INPUT ||
		type === 1 ||
		String(type).toLowerCase() === "input";
	if (!isInputEvent) return false;
	const input = node?.inputs?.[Number(slot)];
	if (!input) return false;
	if (connected) return recordCurrentStoryboardLinks(node);
	return storeStoryboardLink(node, input, linkInfo, slot);
}

function hasLinkedStoryboardInputs(node) {
	return Boolean((node?.inputs || []).some((input) => input?.link != null));
}

function hasStoryboardReconnectTargets(node) {
	return !hasLinkedStoryboardInputs(node) && storyboardLinkMemory(node).length > 0;
}

function settingsOpen(node) {
	return Boolean(node?.properties?.[SETTINGS_OPEN_PROPERTY]);
}

function setWidgetValue(widget, value) {
	if (!widget) return;
	widget.value = value;
	if (widget.inputEl && "value" in widget.inputEl) widget.inputEl.value = value;
	if (widget.element && "value" in widget.element) widget.element.value = value;
	widget.callback?.(value);
}

function widgetOptions(widget) {
	const values = widget?.options?.values;
	if (Array.isArray(values)) return values.map((item) => String(item ?? ""));
	if (values && typeof values === "object") return Object.keys(values);
	return [];
}

function allWidgetOptions(widget) {
	if (!widget) return [];
	const current = widgetOptions(widget);
	if (!Array.isArray(widget.__gjjStoryboardAllValues) || (!widget.__gjjStoryboardAllValues.length && current.length)) {
		widget.__gjjStoryboardAllValues = current;
	} else if (current.length) {
		const merged = [...widget.__gjjStoryboardAllValues];
		for (const value of current) {
			if (!merged.includes(value)) merged.push(value);
		}
		widget.__gjjStoryboardAllValues = merged;
	}
	return widget.__gjjStoryboardAllValues;
}

function resolveWidgetOption(widget, preferred, fallback = "") {
	const target = String(preferred || "").trim();
	if (!target) return fallback;
	const options = widgetOptions(widget);
	if (!options.length) return target;
	const targetKey = target.replace(/\\/g, "/").toLowerCase();
	const targetBase = targetKey.split("/").pop();
	return options.find((item) => item.replace(/\\/g, "/").toLowerCase() === targetKey)
		|| options.find((item) => item.replace(/\\/g, "/").toLowerCase().split("/").pop() === targetBase)
		|| options.find((item) => item.replace(/\\/g, "/").toLowerCase().includes(targetBase))
		|| fallback;
}

function resolveWidgetOptionByKeyword(widget, keyword, fallback = "") {
	const target = String(keyword || "").trim().toLowerCase();
	if (!target) return fallback;
	return widgetOptions(widget).find((item) => item.toLowerCase().includes(target)) || fallback;
}

function textValue(value) {
	return String(value ?? "").trim();
}

function filterTokens(query) {
	return String(query || "")
		.toLowerCase()
		.split(/[|\s,，;；]+/g)
		.map((item) => item.trim())
		.filter(Boolean);
}

function modelMatchesFilter(name, query) {
	const tokens = filterTokens(query);
	if (!tokens.length) return true;
	const text = String(name || "").toLowerCase();
	return tokens.some((token) => text.includes(token));
}

function filteredModelValues(values, query, current = "", keepCurrent = true) {
	const filtered = values.filter((item) => modelMatchesFilter(item, query));
	if (keepCurrent && current && !filtered.includes(current)) return [current, ...filtered];
	return filtered;
}

function unetFilterValue(node) {
	if (node?.properties && Object.prototype.hasOwnProperty.call(node.properties, UNET_FILTER_PROPERTY)) {
		return String(node.properties[UNET_FILTER_PROPERTY] ?? "");
	}
	return DEFAULT_UNET_FILTER;
}

function closeUnetFilterPopup(node) {
	const state = node?.__gjjStoryboardUnetPopup;
	if (!state) return;
	state.cleanup?.();
	state.root?.remove();
	node.__gjjStoryboardUnetPopup = null;
}

function positionPopup(root, event, anchorEl = null) {
	const width = 420;
	const height = Math.min(520, Math.max(280, window.innerHeight - 32));
	const rect = anchorEl?.getBoundingClientRect?.();
	const baseLeft = rect ? rect.left : (event?.clientX ?? 80) - 12;
	const baseTop = rect ? rect.bottom + 6 : (event?.clientY ?? 80) + 8;
	const left = Math.max(8, Math.min(baseLeft, window.innerWidth - width - 8));
	const top = Math.max(8, Math.min(baseTop, window.innerHeight - height - 8));
	root.style.left = `${left}px`;
	root.style.top = `${top}px`;
	root.style.width = `${width}px`;
	root.style.maxHeight = `${height}px`;
}

function openUnetFilterPopup(node, widget, event, anchorEl = null) {
	if (!node || !widget) return true;
	closeUnetFilterPopup(node);
	const allValues = allWidgetOptions(widget);
	if (!allValues.length) return false;
	node.properties ||= {};
	const root = document.createElement("div");
	root.style.cssText = [
		"position:fixed",
		"z-index:100000",
		"display:flex",
		"flex-direction:column",
		"gap:4px",
		"box-sizing:border-box",
		"padding:5px",
		"border:1px solid #3b5560",
		"border-radius:6px",
		"background:#071014",
		"box-shadow:0 12px 36px rgba(0,0,0,.45)",
		"font:12px/1.35 sans-serif",
		"color:#dce7e2",
		"pointer-events:auto",
	].join(";");
	positionPopup(root, event, anchorEl);

	const input = document.createElement("input");
	input.type = "text";
	input.value = unetFilterValue(node);
	input.placeholder = DEFAULT_UNET_FILTER;
	input.title = "过滤主模型列表，支持 | 分隔关键词";
	input.style.cssText = [
		"height:28px",
		"box-sizing:border-box",
		"width:100%",
		"border:1px solid #78909b",
		"border-radius:3px",
		"background:#061014",
		"color:#f1f7f5",
		"padding:0 8px",
		"outline:none",
		"font:13px/28px sans-serif",
	].join(";");

	const list = document.createElement("div");
	list.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:1px",
		"overflow:auto",
		"max-height:460px",
		"border-radius:4px",
	].join(";");

	const chooseValue = (value) => {
		setWidgetValue(widget, value);
		refreshUnetPickerControl(node);
		saveParamValues(node);
		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		closeUnetFilterPopup(node);
	};

	const render = () => {
		const current = String(widget.value || "");
		const values = filteredModelValues(allValues, input.value, current, true);
		list.replaceChildren();
		for (const value of values) {
			const row = document.createElement("button");
			row.type = "button";
			row.textContent = `${value === current ? "✓ " : ""}${value || "未选择"}`;
			row.title = value || "未选择";
			row.style.cssText = [
				"display:block",
				"width:100%",
				"box-sizing:border-box",
				"border:1px solid #253941",
				"border-radius:2px",
				"background:#142329",
				"color:#dce7e2",
				"text-align:left",
				"padding:7px 8px",
				"font:12px/1.35 sans-serif",
				"white-space:normal",
				"word-break:break-word",
				"cursor:pointer",
			].join(";");
			if (value === current) {
				row.style.background = "#174335";
				row.style.borderColor = "#3b7d66";
			}
			row.addEventListener("mouseenter", () => {
				if (value !== current) row.style.background = "#20333b";
			});
			row.addEventListener("mouseleave", () => {
				row.style.background = value === current ? "#174335" : "#142329";
			});
			row.addEventListener("click", (clickEvent) => {
				clickEvent.preventDefault();
				clickEvent.stopPropagation();
				chooseValue(value);
			});
			list.append(row);
		}
		if (!values.length) {
			const empty = document.createElement("div");
			empty.textContent = "没有匹配的主模型";
			empty.style.cssText = "padding:14px 8px;color:#9db0b7;text-align:center;";
			list.append(empty);
		}
	};

	const stop = (popupEvent) => popupEvent.stopPropagation();
	for (const name of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
		root.addEventListener(name, stop);
	}
	input.addEventListener("input", () => {
		node.properties[UNET_FILTER_PROPERTY] = input.value;
		render();
		saveParamValues(node);
		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
	});
	input.addEventListener("keydown", (keyEvent) => {
		keyEvent.stopPropagation();
		if (keyEvent.key === "Escape") {
			keyEvent.preventDefault();
			closeUnetFilterPopup(node);
			return;
		}
		if (keyEvent.key === "Enter") {
			const first = filteredModelValues(allValues, input.value, String(widget.value || ""), true)[0];
			if (first !== undefined) {
				keyEvent.preventDefault();
				chooseValue(first);
			}
		}
	});

	root.append(input, list);
	document.body.append(root);
	render();
	requestAnimationFrame(() => {
		input.focus();
		input.select();
	});
	const onDocumentPointerDown = (docEvent) => {
		if (!root.contains(docEvent.target) && !anchorEl?.contains?.(docEvent.target)) closeUnetFilterPopup(node);
	};
	const onDocumentKeyDown = (docEvent) => {
		if (docEvent.key === "Escape") closeUnetFilterPopup(node);
	};
	const pointerTimer = setTimeout(() => document.addEventListener("pointerdown", onDocumentPointerDown, true), 0);
	document.addEventListener("keydown", onDocumentKeyDown, true);
	node.__gjjStoryboardUnetPopup = {
		root,
		cleanup: () => {
			clearTimeout(pointerTimer);
			document.removeEventListener("pointerdown", onDocumentPointerDown, true);
			document.removeEventListener("keydown", onDocumentKeyDown, true);
		},
	};
	event?.preventDefault?.();
	event?.stopPropagation?.();
	return true;
}

function cacheUnetOptions(node) {
	const widget = getWidget(node, "unet_name");
	if (!widget?.options) return;
	node.properties ||= {};
	if (!Object.prototype.hasOwnProperty.call(node.properties, UNET_FILTER_PROPERTY)) {
		node.properties[UNET_FILTER_PROPERTY] = DEFAULT_UNET_FILTER;
	}
	allWidgetOptions(widget);
}

function refreshUnetPickerControl(node) {
	const button = node?.__gjjStoryboardUnetPickerButton;
	const widget = getWidget(node, "unet_name");
	if (!button || !widget) return;
	const value = String(widget.value || "");
	const text = button.__gjjStoryboardUnetLabel;
	if (text) text.textContent = value || "未选择";
	else button.textContent = value || "未选择";
	button.title = value || "点击选择主模型";
}

function createUnetPickerControl(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:grid",
		"grid-template-columns:92px minmax(0,1fr)",
		"align-items:center",
		"gap:8px",
		"width:100%",
		"box-sizing:border-box",
		"pointer-events:auto",
		"font:12px system-ui,'Microsoft YaHei',sans-serif",
	].join(";");
	const label = document.createElement("div");
	label.textContent = "🟣 UNET 主模型";
	label.style.cssText = "color:#b8c7cf;white-space:nowrap;font-size:12px;";
	const button = document.createElement("button");
	button.type = "button";
	button.style.cssText = [
		"height:32px",
		"min-width:0",
		"width:100%",
		"box-sizing:border-box",
		"border:1px solid #5c6f78",
		"border-radius:8px",
		"background:#33383d",
		"color:#f1f5f5",
		"padding:0 30px 0 12px",
		"text-align:left",
		"font:600 14px system-ui,'Microsoft YaHei',sans-serif",
		"overflow:hidden",
		"text-overflow:ellipsis",
		"white-space:nowrap",
		"cursor:pointer",
		"position:relative",
	].join(";");
	const text = document.createElement("span");
	text.style.cssText = "display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
	const arrow = document.createElement("span");
	arrow.textContent = "⌄";
	arrow.style.cssText = "position:absolute;right:10px;top:5px;color:#cfd8dc;font-size:18px;pointer-events:none;";
	button.append(text, arrow);
	button.__gjjStoryboardUnetLabel = text;
	const stop = (event) => event.stopPropagation();
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
		container.addEventListener(eventName, stop, { passive: eventName === "wheel" });
	}
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const widget = getWidget(node, "unet_name");
		if (!widget) return;
		const state = node.__gjjStoryboardUnetPopup;
		if (state?.root) {
			closeUnetFilterPopup(node);
			return;
		}
		openUnetFilterPopup(node, widget, event, button);
	});
	container.append(label, button);
	node.__gjjStoryboardUnetPickerButton = button;
	setTimeout(() => refreshUnetPickerControl(node), 0);
	return container;
}

function parsePromptParts(text) {
	const raw = String(text || "").trim();
	if (!raw) return [];
	const sceneLines = [];
	let current = [];
	let matched = false;
	const bracketRe = /^\s*\[\s*([^\[\]\r\n]+?)\s*\]\s*(?:[:：\-—]\s*)?(.*?)\s*$/;
	const sceneRe = /^\s*(?:scene|shot|镜头|分镜)\s*(?:[#:：\-]?\s*[\d一二三四五六七八九十百零〇两]+)?(?:\s*[:：]\s*|\s+)(?:(.*?)\s*(?:[:：]{1,2}|::)\s*)?(.+?)\s*$/i;
	for (const sourceLine of raw.split(/\r?\n/)) {
		const line = sourceLine.trim();
		if (!line) continue;
		const bracketMatch = line.match(bracketRe);
		const match = line.match(sceneRe);
		if (bracketMatch || match) {
			matched = true;
			if (current.length) sceneLines.push(current.join("\n").trim());
			if (bracketMatch) {
				const body = String(bracketMatch[2] || "").trim();
				current = body ? [body] : [];
			} else {
				const label = String(match[1] || "").trim().replace(/^[\s\-—:：]+|[\s\-—:：]+$/g, "");
				const body = String(match[2] || "").trim();
				current = [label ? `${label}，${body}` : body];
			}
		} else if (matched) {
			current.push(line);
		}
	}
	if (current.length) sceneLines.push(current.join("\n").trim());
	if (matched && sceneLines.length) return sceneLines;
	return raw.split(/(?:^\s*---+\s*$)|(?:\n\s*\n+)/m).map((item) => item.trim()).filter(Boolean);
}

function serializePromptParts(parts) {
	return (parts || []).map((item) => String(item || "").trim()).filter(Boolean).join("\n\n---\n\n");
}

function selectedCellIndex(node) {
	const value = Number(node?.properties?.[SELECTED_CELL_PROPERTY] || 1);
	return Math.max(0, Math.min(255, Math.round(value || 1) - 1));
}

function selectedCellIndices(node) {
	const count = Math.max(1, parsePromptParts(getWidget(node, "prompt")?.value || "").length);
	const raw = Array.isArray(node?.properties?.[SELECTED_CELLS_PROPERTY]) ? node.properties[SELECTED_CELLS_PROPERTY] : [];
	const values = raw
		.map((value) => Math.round(Number(value) || 0) - 1)
		.filter((value) => value >= 0 && value < count);
	const unique = [...new Set(values)].sort((left, right) => left - right);
	if (unique.length) return unique;
	return [Math.max(0, Math.min(count - 1, selectedCellIndex(node)))];
}

function setSelectedCellIndex(node, index) {
	node.properties ||= {};
	const count = Math.max(1, parsePromptParts(getWidget(node, "prompt")?.value || "").length);
	const value = Math.max(1, Math.min(count, Math.round(Number(index) || 0) + 1));
	node.properties[SELECTED_CELL_PROPERTY] = value;
	node.properties[SELECTED_CELLS_PROPERTY] = [value];
	node.__gjjStoryboardSelectionAnchor = value - 1;
	updateSelectedPreviewImage(node);
	drawPromptGridPreview(node);
	GJJ_Utils.refreshNode?.(node);
}

function setSelectedCellIndices(node, indices, primaryIndex = null) {
	node.properties ||= {};
	const count = Math.max(1, parsePromptParts(getWidget(node, "prompt")?.value || "").length);
	const normalized = [...new Set((indices || [])
		.map((value) => Math.round(Number(value) || 0))
		.filter((value) => value >= 0 && value < count))]
		.sort((left, right) => left - right);
	const safe = normalized.length ? normalized : [Math.max(0, Math.min(count - 1, selectedCellIndex(node)))];
	const primary = primaryIndex === null ? safe[safe.length - 1] : Math.max(0, Math.min(count - 1, Math.round(Number(primaryIndex) || 0)));
	node.properties[SELECTED_CELL_PROPERTY] = primary + 1;
	node.properties[SELECTED_CELLS_PROPERTY] = safe.map((value) => value + 1);
	node.__gjjStoryboardSelectionAnchor = primary;
	updateSelectedPreviewImage(node);
	drawPromptGridPreview(node);
	GJJ_Utils.refreshNode?.(node);
}

function updateCellSelectionFromEvent(node, index, event) {
	const count = Math.max(1, parsePromptParts(getWidget(node, "prompt")?.value || "").length);
	const safeIndex = Math.max(0, Math.min(count - 1, Math.round(Number(index) || 0)));
	if (event?.shiftKey) {
		const anchor = Number.isInteger(node.__gjjStoryboardSelectionAnchor) ? node.__gjjStoryboardSelectionAnchor : selectedCellIndex(node);
		const start = Math.min(anchor, safeIndex);
		const end = Math.max(anchor, safeIndex);
		const range = [];
		for (let value = start; value <= end; value += 1) range.push(value);
		setSelectedCellIndices(node, range, safeIndex);
		return;
	}
	if (event?.ctrlKey || event?.metaKey) {
		const current = new Set(selectedCellIndices(node));
		if (current.has(safeIndex) && current.size > 1) current.delete(safeIndex);
		else current.add(safeIndex);
		setSelectedCellIndices(node, [...current], safeIndex);
		return;
	}
	setSelectedCellIndex(node, safeIndex);
}

function intValue(value, fallback = 0, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.max(min, Math.min(max, Math.round(number)));
}

function isSeedControlValue(value) {
	return SEED_CONTROL_VALUES.has(textValue(value));
}

function isSeedControlWidget(widget) {
	const name = textValue(widget?.name).toLowerCase();
	if (/(control_after_generate|after_generate|seed.*control|randomize)/.test(name)) {
		return true;
	}
	return isSeedControlValue(widget?.value) && (widget?.hidden || String(widget?.type || "").toLowerCase() === "combo");
}

function findSeedControlWidget(node) {
	if (!Array.isArray(node?.widgets)) return null;
	const seedIndex = node.widgets.findIndex((widget) => widget?.name === "seed");
	const stepsIndex = node.widgets.findIndex((widget) => widget?.name === "steps");
	if (seedIndex >= 0 && stepsIndex > seedIndex + 1) {
		for (let index = seedIndex + 1; index < stepsIndex; index += 1) {
			const widget = node.widgets[index];
			if (isSeedControlWidget(widget) || isSeedControlValue(widget?.value)) {
				return widget;
			}
		}
	}
	return node.widgets.find((widget) => isSeedControlWidget(widget)) || null;
}

function randomSeedValue() {
	return Math.floor(Math.random() * (JS_SAFE_MAX_SEED_VALUE + 1));
}

function seedControlMode(node) {
	const widgetValue = textValue(findSeedControlWidget(node)?.value);
	if (isSeedControlValue(widgetValue)) return widgetValue;
	const storedValue = textValue(node?.properties?.[PARAM_VALUES_PROPERTY]?.[SEED_CONTROL_KEY]);
	if (isSeedControlValue(storedValue)) return storedValue;
	return "fixed";
}

function applySeedControlBeforeQueue(node) {
	const seedWidget = getWidget(node, "seed");
	if (!seedWidget) return null;
	const now = Date.now();
	if (node.__gjjStoryboardSeedPreparedAt && now - node.__gjjStoryboardSeedPreparedAt < 500) {
		if (Number.isInteger(node.__gjjStoryboardPreparedSeed)) return node.__gjjStoryboardPreparedSeed;
		return intValue(seedWidget.value, 0, 0, JS_SAFE_MAX_SEED_VALUE);
	}
	if (node.__gjjStoryboardRandomSeedOnce) {
		const nextSeed = randomSeedValue();
		setWidgetValue(seedWidget, nextSeed);
		node.__gjjStoryboardSeedPreparedAt = now;
		node.__gjjStoryboardPreparedSeed = nextSeed;
		saveParamValues(node);
		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		node.graph?.change?.();
		return nextSeed;
	}
	const currentSeed = intValue(seedWidget.value, 0, 0, JS_SAFE_MAX_SEED_VALUE);
	node.__gjjStoryboardPreparedSeed = currentSeed;
	return currentSeed;
}

function syncSeedControlWidget(node) {
	const widget = findSeedControlWidget(node);
	if (!widget || widget.__gjjStoryboardSeedControlHooked) return;
	widget.__gjjStoryboardSeedControlHooked = true;
	const storedValue = textValue(node?.properties?.[PARAM_VALUES_PROPERTY]?.[SEED_CONTROL_KEY]);
	if (isSeedControlValue(storedValue) && widget.value !== storedValue) {
		setWidgetValue(widget, storedValue);
	}
	const originalCallback = widget.callback;
	widget.callback = function (value, ...args) {
		const result = originalCallback?.apply(this, [value, ...args]);
		const mode = textValue(value);
		if (isSeedControlValue(mode)) {
			saveParamValues(node);
		}
		return result;
	};
}

function patchStoryboardSeedIntoPromptData(promptData) {
	const output = promptData?.output || promptData?.prompt;
	if (!output || typeof output !== "object") return promptData;
	const nodes = Array.isArray(app.graph?._nodes) ? app.graph._nodes : [];
	for (const [key, entry] of Object.entries(output)) {
		if (!TARGET_NODES.has(entry?.class_type)) continue;
		const node = nodes.find((item) => String(item?.id) === String(key) && isTarget(item));
		if (!node) continue;
		const seed = applySeedControlBeforeQueue(node);
		if (seed === null || seed === undefined) continue;
		const singleIndices = Array.isArray(node.__gjjStoryboardSingleCellIndices)
			? node.__gjjStoryboardSingleCellIndices
			: (Number.isInteger(node.__gjjStoryboardSingleCellIndex) ? [node.__gjjStoryboardSingleCellIndex] : []);
		const linkedSource = linkedPromptSource(node);
		const fullPrompt = linkedSource ? linkedSource.text : (getWidget(node, "prompt")?.value || "");
		const parts = singleIndices.length ? parsePromptParts(fullPrompt) : [];
		const clampedIndices = parts.length
			? [...new Set(singleIndices.map((value) => Math.max(0, Math.min(value, parts.length - 1))))].sort((left, right) => left - right)
			: [];
		const applyInputs = (inputs) => {
			inputs.seed = seed;
			inputs[SINGLE_CELL_INDEX_INPUT] = clampedIndices.length ? clampedIndices[0] + 1 : 0;
			inputs[SINGLE_CELL_TOTAL_INPUT] = clampedIndices.length ? parts.length : 0;
			inputs[SELECTED_CELL_INDICES_INPUT] = clampedIndices.length ? JSON.stringify(clampedIndices.map((value) => value + 1)) : "[]";
			// Always carry the current upstream snapshot. The backend uses it when a
			// single/multi-cell request replaces `prompt` with only the selected parts,
			// and the completed previews then synchronize the visible grid table.
			inputs[FULL_PROMPT_INPUT] = fullPrompt;
			inputs[FORCE_GENERATE_INPUT] = node.__gjjStoryboardForceGenerateAll ? "true" : "false";
			inputs[PREVIEW_IMAGES_INPUT] = JSON.stringify(storyboardPreviewImageItems(node));
			if (clampedIndices.length) {
				inputs.prompt = serializePromptParts(clampedIndices.map((value) => parts[value]).filter(Boolean));
			}
		};
		entry.inputs = entry.inputs || {};
		applyInputs(entry.inputs);
		if (promptData?.prompt && promptData.prompt !== promptData.output && promptData.prompt[key]) {
			promptData.prompt[key].inputs = promptData.prompt[key].inputs || {};
			applyInputs(promptData.prompt[key].inputs);
		}
	}
	return promptData;
}

function installStoryboardSeedPromptPatch() {
	if (app.__gjjStoryboardGridSeedPromptPatchInstalled || typeof app.graphToPrompt !== "function") return;
	app.__gjjStoryboardGridSeedPromptPatchInstalled = true;
	const originalGraphToPrompt = app.graphToPrompt.bind(app);
	app.graphToPrompt = async function (...args) {
		const result = await originalGraphToPrompt(...args);
		return patchStoryboardSeedIntoPromptData(result);
	};
}

function normalizeStrength(value, fallback = 1.0) {
	const number = Number(value);
	return Number.isFinite(number) ? number : fallback;
}

function normalizedModelText(value) {
	return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isNextSceneImageEdit(unetName, preset) {
	const text = normalizedModelText(`${unetName || ""} ${preset?.id || ""} ${(preset?.keywords || []).join(" ")}`);
	return (text.includes("qwen") || text.includes("firered")) && text.includes("image") && text.includes("edit");
}

function isFluxStoryboardModel(unetName, preset) {
	const text = normalizedModelText(`${unetName || ""} ${preset?.id || ""} ${(preset?.keywords || []).join(" ")}`);
	return text.includes("flux") || text.includes("f2k") || text.includes("klein");
}

function fireredImageEditFallbackPreset(node, unetName) {
	const text = normalizedModelText(unetName);
	if (!(text.includes("firered") && text.includes("image") && text.includes("edit"))) return null;
	const clipWidget = getWidget(node, "clip_name1");
	const vaeWidget = getWidget(node, "vae_name");
	return {
		id: "firered_image_edit",
		keywords: ["firered", "image", "edit"],
		clipNames: [
			resolveWidgetOptionByKeyword(clipWidget, "qwen_2.5_vl")
				|| resolveWidgetOptionByKeyword(clipWidget, "qwen25vl")
				|| resolveWidgetOptionByKeyword(clipWidget, "qwen")
				|| "qwen_2.5_vl_7b_fp8_scaled.safetensors",
		],
		vaeName: resolveWidgetOptionByKeyword(vaeWidget, "qwen_image_vae")
			|| resolveWidgetOptionByKeyword(vaeWidget, "qwenimagevae")
			|| resolveWidgetOptionByKeyword(vaeWidget, "qwen")
			|| "qwen_image_vae.safetensors",
		lora1: "",
		lora2: "",
	};
}

function resolveLoraOption(widget, preferred) {
	const exact = resolveWidgetOption(widget, preferred, "");
	if (exact) return exact;
	const keywords = String(preferred || "").toLowerCase().split(/[^0-9a-z\u4e00-\u9fff]+/).filter(Boolean);
	if (!keywords.length) return "";
	const matches = widgetOptions(widget).filter((item) => {
		const text = String(item || "").toLowerCase();
		return keywords.every((keyword) => text.includes(keyword));
	});
	return matches.sort((left, right) => left.length - right.length || left.localeCompare(right))[0] || "";
}

function appendLoraRow(rows, name, strength = 1.0, widget = null) {
	const target = widget ? resolveLoraOption(widget, name) : String(name || "").trim();
	if (!target) return;
	const targetBase = target.replace(/\\/g, "/").toLowerCase().split("/").pop();
	const existing = rows.find((row) => {
		const current = String(row?.name || "").replace(/\\/g, "/").toLowerCase();
		return current === target.toLowerCase() || current.split("/").pop() === targetBase;
	});
	if (existing) {
		existing.enabled = true;
		if (!Number(existing.strength)) existing.strength = strength;
		return;
	}
	rows.push({ enabled: true, name: target, strength });
}

function loraBaseKey(name) {
	return String(name || "").replace(/\\/g, "/").toLowerCase().split("/").pop();
}

function isQwenLightningLora(name) {
	const key = loraBaseKey(name);
	return ["qwen", "image", "edit", "lightning"].every((token) => key.includes(token));
}

function isRequiredLightningRow(row) {
	return row?.role === "required_lightning" || isQwenLightningLora(row?.name);
}

function requiredLightningLora(node, optionWidget = null) {
	if (!isNextSceneImageEdit(String(getWidget(node, "unet_name")?.value || ""), null)) return "";
	const configured = storyboardLoraRows(node, false).find((row) => row?.name && isRequiredLightningRow(row));
	if (configured?.name) return String(configured.name);
	return allWidgetOptions(optionWidget || getWidget(node, STORYBOARD_LORA_NAME)).find(isQwenLightningLora) || "";
}

function setRequiredLightningLora(node, name) {
	const rows = storyboardLoraRows(node, false);
	const existing = rows.find(isRequiredLightningRow);
	if (existing) {
		existing.name = String(name || "");
		existing.enabled = Boolean(name);
		existing.strength = normalizeStrength(existing.strength, 1.0);
		existing.role = "required_lightning";
	} else if (name) {
		rows.unshift({ enabled: true, name: String(name), strength: 1.0, role: "required_lightning" });
	}
	setWidgetValue(getWidget(node, "lora_data"), normalizeStoryboardLoraData(JSON.stringify(rows)));
	saveParamValues(node);
}

function presetLoraRows(preset, unetName = "", loraWidget = null) {
	const rows = [];
	const lora1 = resolveLoraOption(loraWidget, preset?.lora1);
	if (lora1) {
		rows.push({
			enabled: preset.lora1AutoEnabled !== false,
			name: lora1,
			strength: normalizeStrength(preset.lora1Strength, 1.0),
		});
	}
	const lora2 = resolveLoraOption(loraWidget, preset?.lora2);
	if (lora2) {
		rows.push({
			enabled: true,
			name: lora2,
			strength: normalizeStrength(preset.lora2Strength, 0.7),
		});
	}
	if (rows.length) rows.push({ ...DEFAULT_LORA_ROW });
	return rows;
}

function setPresetLoraData(node, preset, unetName = "") {
	const widget = getWidget(node, "lora_data");
	if (!widget) return;
	const rows = presetLoraRows(preset, unetName, getWidget(node, STORYBOARD_LORA_NAME));
	setWidgetValue(widget, normalizeStoryboardLoraData(JSON.stringify(rows)));
}

function setStoryboardLoraForModel(node, preset, unetName = "", force = false) {
	const widget = getWidget(node, STORYBOARD_LORA_NAME);
	if (!widget) return;
	const usesNextScene = isNextSceneImageEdit(unetName, preset);
	const current = String(widget.value || "").trim();
	if (usesNextScene) {
		const nextScene = resolveWidgetOptionByKeyword(widget, "next-scene")
			|| resolveWidgetOption(widget, NEXT_SCENE_LORA);
		if (nextScene && (force || !current)) setWidgetValue(widget, nextScene);
		return;
	}
	const usesFluxLora = isFluxStoryboardModel(unetName, preset);
	if (usesFluxLora) {
		const fluxLora = resolveWidgetOptionByKeyword(widget, FLUX_STORYBOARD_LORA)
			|| resolveWidgetOptionByKeyword(widget, "f2k")
			|| resolveWidgetOption(widget, FLUX_STORYBOARD_LORA);
		if (fluxLora && (force || !current)) setWidgetValue(widget, fluxLora);
		return;
	}
	const currentResolved = resolveWidgetOption(widget, current);
	if (force || currentResolved === resolveWidgetOption(widget, NEXT_SCENE_LORA) || currentResolved === resolveWidgetOption(widget, FLUX_STORYBOARD_LORA)) {
		setWidgetValue(widget, "");
	}
}

function hasConfiguredLoraData(node) {
	const text = String(getWidget(node, "lora_data")?.value || "").trim();
	if (!text || text === "[]") return false;
	try {
		const rows = JSON.parse(text);
		return Array.isArray(rows) && rows.some((row) => row && typeof row === "object" && String(row.name || "").trim());
	} catch {
		return true;
	}
}

function rememberWidget(widget) {
	if (!widget || widget.__gjjStoryboardNativeState) return;
	widget.__gjjStoryboardNativeState = {
		type: widget.type,
		hidden: widget.hidden,
		disabled: widget.disabled,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		draw: widget.draw,
		mouse: widget.mouse,
		widgetDisplay: widget.widget?.style?.display || "",
		elementDisplay: widget.element?.style?.display || "",
		inputDisplay: widget.inputEl?.style?.display || "",
	};
}

function setWidgetHidden(widget, hidden) {
	if (!widget) return;
	rememberWidget(widget);
	const state = widget.__gjjStoryboardNativeState || {};
	widget.options ||= {};
	if (!hidden) {
		widget.hidden = false;
		widget.disabled = false;
		widget.serialize = true;
		widget.type = state.type || widget.type || "text";
		if (state.computeSize) widget.computeSize = state.computeSize;
		else delete widget.computeSize;
		if (state.getHeight) widget.getHeight = state.getHeight;
		else delete widget.getHeight;
		if (state.draw) widget.draw = state.draw;
		else delete widget.draw;
		if (state.mouse) widget.mouse = state.mouse;
		else delete widget.mouse;
		delete widget.options.hidden;
		delete widget.options.display;
		if (widget.widget) widget.widget.style.display = state.widgetDisplay || "";
		if (widget.element) widget.element.style.display = state.elementDisplay || "";
		if (widget.inputEl) widget.inputEl.style.display = state.inputDisplay || "";
		return;
	}
	widget.hidden = true;
	widget.disabled = true;
	widget.serialize = true;
	widget.type = "hidden";
	widget.options.hidden = true;
	widget.options.display = "hidden";
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.mouse = () => false;
	if (widget.widget) widget.widget.style.display = "none";
	if (widget.element) widget.element.style.display = "none";
	if (widget.inputEl) widget.inputEl.style.display = "none";
}

function forcePromptWidgetVisible(node) {
	const prompt = getWidget(node, "prompt");
	if (!prompt) return;
	prompt.hidden = false;
	prompt.disabled = false;
	prompt.options ||= {};
	delete prompt.options.hidden;
	delete prompt.options.display;
	prompt.computeSize = (width) => [Math.max(260, Number(width || node?.size?.[0] || 420)), 120];
	prompt.getHeight = () => 120;
	prompt.computedHeight = 120;
	prompt.size = [Math.max(260, Number(node?.size?.[0] || 420)), 120];
	for (const element of [prompt.widget, prompt.element, prompt.inputEl]) {
		if (!element?.style) continue;
		element.style.removeProperty("display");
		element.style.removeProperty("height");
		element.style.removeProperty("margin");
		element.style.removeProperty("padding");
	}
	if (prompt.inputEl?.style) {
		prompt.inputEl.style.minHeight = "108px";
		prompt.inputEl.style.display = "block";
	}
}

function updateSettingsButtonState(node) {
	const button = node?.__gjjStoryboardSettingsButton;
	if (!button) return;
	const open = activeParameterDialog?.node === node && activeParameterDialog?.group === "settings";
	button.classList.toggle("on", open);
	button.style.background = open ? "linear-gradient(135deg, #4b5563, #64748b)" : "linear-gradient(135deg, #1f2933, #374151)";
	button.style.borderColor = open ? "#94a3b8" : "#55636f";
}

function updateModelButtonState(node) {
	const button = node?.__gjjStoryboardModelButton;
	if (!button) return;
	const rawKeepModel = getWidget(node, "keep_model_loaded")?.value;
	const keepModel = rawKeepModel === true || rawKeepModel === 1 || ["true", "1", "on", "yes"].includes(String(rawKeepModel || "").toLowerCase());
	const open = activeParameterDialog?.node === node && activeParameterDialog?.group === "model";
	button.classList.toggle("on", open);
	button.style.background = keepModel
		? (open ? "linear-gradient(135deg, #6d28d9, #8b5cf6)" : "linear-gradient(135deg, #4c1d95, #6d28d9)")
		: (open ? "linear-gradient(135deg, #4b5563, #64748b)" : "linear-gradient(135deg, #1f2933, #374151)");
	button.style.borderColor = keepModel ? "#c4b5fd" : (open ? "#94a3b8" : "#55636f");
	button.style.color = keepModel ? "#f5f3ff" : "#e5edf2";
	button.title = keepModel ? "模型参数 · 保持模型已开启" : "模型参数 · 保持模型已关闭";
}

function orderWidgets(node) {
	if (!Array.isArray(node?.widgets)) return;
	const panelOrder = new Map(PANEL_SYNC_WIDGETS.map((name, index) => [name, index]));
	const rank = (widget) => {
		const name = String(widget?.name || "");
		if (widget === node.__gjjStoryboardExecuteWidget || name === EXECUTE_BUTTON_NAME) return 0;
		if (name === "prompt") return 10;
		if (widget === node.__gjjStoryboardPreviewWidget || name === IMAGE_PREVIEW_NAME) return 100;
		if (ALWAYS_HIDDEN_WIDGETS.has(name) || widget?.hidden) return 900;
		if (panelOrder.has(name)) return 50 + panelOrder.get(name) / 100;
		return 80;
	};
	node.widgets = node.widgets
		.map((widget, index) => ({ widget, index }))
		.sort((left, right) => rank(left.widget) - rank(right.widget) || left.index - right.index)
		.map((item) => item.widget);
}

function applySettingsVisibility(node) {
	if (!node) return;
	for (const name of PANEL_SYNC_WIDGETS) {
		const widget = getWidget(node, name);
		if (!widget || ALWAYS_HIDDEN_WIDGETS.has(name)) continue;
		setWidgetHidden(widget, !ALWAYS_VISIBLE_WIDGETS.has(name));
	}
	for (const name of ALWAYS_HIDDEN_WIDGETS) {
		setWidgetHidden(getWidget(node, name), true);
	}
	updateSettingsButtonState(node);
	updateModelButtonState(node);
	orderWidgets(node);
	updateTemplateSourcePanel(node, TEMPLATE_SOURCE_FIELDS);
	GJJ_Utils.refreshNode?.(node);
}

function setSettingsOpen(node, open) {
	node.properties ||= {};
	node.properties[SETTINGS_OPEN_PROPERTY] = Boolean(open);
	applySettingsVisibility(node);
}

function closeParameterDialog() {
	if (!activeParameterDialog) return;
	closeModelSearchPopup();
	const { root, node, cleanup } = activeParameterDialog;
	cleanup?.();
	root?.remove();
	activeParameterDialog = null;
	for (const button of [
		node?.__gjjStoryboardSizeButton,
		node?.__gjjStoryboardModelButton,
		node?.__gjjStoryboardSettingsButton,
	]) {
		if (!button) continue;
		button.classList.remove("on");
		button.style.background = "linear-gradient(135deg, #1f2933, #374151)";
		button.style.borderColor = "#55636f";
	}
	updateModelButtonState(node);
}

function widgetDisplayLabel(widget, fallback) {
	return String(widget?.label || widget?.options?.display_name || fallback || "").replace(/^[^\p{L}\p{N}]+/u, "").trim() || fallback;
}

function createParameterControl(widget, name) {
	const options = allWidgetOptions(widget);
	const value = widget?.value ?? "";
	let control;
	if (name === "keep_model_loaded") {
		control = document.createElement("button");
		control.type = "button";
		const setState = (enabled) => {
			control.dataset.booleanValue = enabled ? "true" : "false";
			control.setAttribute("aria-pressed", enabled ? "true" : "false");
			control.textContent = enabled ? "已开启" : "已关闭";
			control.style.background = enabled ? "linear-gradient(135deg,#4c1d95,#7c3aed)" : "#111a1f";
			control.style.borderColor = enabled ? "#c4b5fd" : "#3d5059";
			control.style.color = enabled ? "#f5f3ff" : "#b9c9cd";
		};
		const enabled = value === true || value === 1 || ["true", "1", "on", "yes"].includes(String(value || "").toLowerCase());
		control.__gjjSetBooleanState = setState;
		setState(enabled);
		control.addEventListener("click", () => setState(control.dataset.booleanValue !== "true"));
	} else if (options.length) {
		control = document.createElement("select");
		for (const optionValue of options) {
			const option = document.createElement("option");
			option.value = optionValue;
			option.textContent = optionValue || "无";
			control.append(option);
		}
		control.value = String(value);
	} else if (typeof value === "number") {
		control = document.createElement("input");
		control.type = "number";
		control.value = String(value);
		for (const key of ["min", "max", "step"]) {
			const optionValue = widget?.options?.[key];
			if (Number.isFinite(Number(optionValue))) control[key] = String(optionValue);
		}
	} else if (typeof value === "boolean") {
		control = document.createElement("input");
		control.type = "checkbox";
		control.checked = value;
	} else {
		control = document.createElement(name === "negative_prompt" ? "textarea" : "input");
		if (control.tagName === "INPUT") control.type = "text";
		control.value = String(value);
	}
	control.dataset.widgetName = name;
	control.style.cssText = [
		"width:100%",
		"min-width:0",
		"box-sizing:border-box",
		"border:1px solid #3d5059",
		"border-radius:6px",
		"background:#111a1f",
		"color:#eef7f2",
		"padding:6px 8px",
		"font:12px/1.35 sans-serif",
		"outline:none",
		control.tagName === "TEXTAREA" ? "min-height:72px;resize:vertical" : "height:32px",
	].join(";");
	if (control.__gjjSetBooleanState) {
		control.__gjjSetBooleanState(control.dataset.booleanValue === "true");
		control.style.cursor = "pointer";
		control.style.fontWeight = "700";
	}
	return control;
}

function closeModelSearchPopup() {
	if (!activeModelSearchPopup) return;
	activeModelSearchPopup.cleanup?.();
	activeModelSearchPopup.root?.remove();
	activeModelSearchPopup = null;
}

function fuzzyModelOptionMatch(option, query) {
	const source = String(query || "").trim();
	if (!source) return true;
	const normalized = normalizedModelText(option);
	const tokens = [];
	const tokenPattern = /\s*(\(|\)|&&|\|\||\||!|\bAND\b|\bOR\b|\bNOT\b|"[^"]*"|'[^']*'|[^\s()!|&]+)/giy;
	let match;
	while ((match = tokenPattern.exec(source))) {
		let token = match[1];
		if (/^and$/i.test(token) || token === "&&") token = "AND";
		else if (/^or$/i.test(token) || token === "||" || token === "|") token = "OR";
		else if (/^not$/i.test(token) || token === "!") token = "NOT";
		else if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) token = token.slice(1, -1);
		if (token.startsWith("-") && token.length > 1) tokens.push("NOT", token.slice(1));
		else tokens.push(token);
	}
	const expanded = [];
	for (const token of tokens) {
		const previous = expanded.at(-1);
		if (expanded.length && token !== "(" && token !== ")" && token !== "AND" && token !== "OR"
			&& previous !== "(" && previous !== "AND" && previous !== "OR" && previous !== "NOT") expanded.push("AND");
		if (token === "(" && previous && previous !== "(" && previous !== "AND" && previous !== "OR" && previous !== "NOT") expanded.push("AND");
		expanded.push(token);
	}
	let index = 0;
	const primary = () => {
		if (expanded[index] === "(") {
			index += 1;
			const value = orExpression();
			if (expanded[index] === ")") index += 1;
			return value;
		}
		const keyword = normalizedModelText(expanded[index++] || "");
		return keyword ? normalized.includes(keyword) : true;
	};
	const unary = () => expanded[index] === "NOT" ? (index += 1, !unary()) : primary();
	const andExpression = () => {
		let value = unary();
		while (expanded[index] === "AND") { index += 1; value = unary() && value; }
		return value;
	};
	const orExpression = () => {
		let value = andExpression();
		while (expanded[index] === "OR") { index += 1; value = andExpression() || value; }
		return value;
	};
	return orExpression();
}

function createSearchableModelSelect(control) {
	control.style.display = "none";
	const host = document.createElement("div");
	host.style.cssText = "position:relative;width:100%;min-width:0;";
	const button = document.createElement("button");
	button.type = "button";
	button.style.cssText = "width:100%;height:32px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 9px;border:1px solid #3d5059;border-radius:6px;background:#111a1f;color:#eef7f2;font:600 12px sans-serif;cursor:pointer;text-align:left;";
	const valueLabel = document.createElement("span");
	valueLabel.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
	const arrow = document.createElement("span");
	arrow.textContent = "⌄";
	arrow.style.cssText = "flex:0 0 auto;color:#a9bbc0;font-size:15px;";
	button.append(valueLabel, arrow);
	host.append(control, button);

	const refreshLabel = () => {
		valueLabel.textContent = String(control.value || "无");
		button.title = String(control.value || "点击选择模型");
	};
	control.__gjjRefreshSearchPicker = refreshLabel;
	refreshLabel();

	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (activeModelSearchPopup?.anchor === button) {
			closeModelSearchPopup();
			return;
		}
		closeModelSearchPopup();
		const root = document.createElement("div");
		root.style.cssText = "position:fixed;z-index:100002;display:flex;flex-direction:column;gap:6px;padding:7px;border:1px solid #46606a;border-radius:8px;background:#0c1418;box-shadow:0 12px 32px rgba(0,0,0,.55);";
		const search = document.createElement("input");
		search.type = "text";
		search.placeholder = "关键词逻辑过滤，如 qwen AND edit NOT old";
		search.title = "支持 AND/空格、OR/|、NOT/!/-、括号和引号短语";
		search.style.cssText = "width:100%;height:30px;box-sizing:border-box;border:1px solid #5c7079;border-radius:6px;background:#0b1114;color:#f3faf7;padding:4px 8px;font:12px sans-serif;outline:none;";
		const list = document.createElement("div");
		list.style.cssText = "display:flex;flex-direction:column;gap:3px;max-height:240px;overflow:auto;";
		root.append(search, list);
		document.body.append(root);

		const position = () => {
			const rect = button.getBoundingClientRect();
			const width = Math.min(Math.max(300, rect.width), window.innerWidth - 16);
			root.style.width = `${width}px`;
			const measured = root.getBoundingClientRect();
			const openAbove = window.innerHeight - rect.bottom < 220 && rect.top > window.innerHeight - rect.bottom;
			const left = Math.max(8, Math.min(rect.left, window.innerWidth - measured.width - 8));
			const top = openAbove ? rect.top - measured.height - 5 : rect.bottom + 5;
			root.style.left = `${left}px`;
			root.style.top = `${Math.max(8, Math.min(top, window.innerHeight - measured.height - 8))}px`;
		};
		const render = () => {
			const options = [...control.options]
				.map((option) => option.value)
				.filter((option) => fuzzyModelOptionMatch(option, search.value));
			list.replaceChildren();
			if (!options.length) {
				const empty = document.createElement("div");
				empty.textContent = "没有匹配的模型";
				empty.style.cssText = "padding:9px;color:#92a7ad;font:12px sans-serif;";
				list.append(empty);
			}
			for (const optionValue of options) {
				const row = document.createElement("button");
				row.type = "button";
				row.textContent = optionValue || "无";
				const selected = optionValue === control.value;
				row.style.cssText = `min-height:30px;width:100%;padding:5px 8px;border:1px solid ${selected ? "#4fa978" : "#2d4149"};border-radius:5px;background:${selected ? "#164f3b" : "#132027"};color:#e8f2ee;font:12px sans-serif;text-align:left;cursor:pointer;overflow-wrap:anywhere;`;
				row.addEventListener("click", () => {
					control.value = optionValue;
					control.dispatchEvent(new Event("change", { bubbles: true }));
					refreshLabel();
					closeModelSearchPopup();
				});
				list.append(row);
			}
			position();
		};
		search.addEventListener("input", render);
		search.addEventListener("keydown", (keyEvent) => {
			if (keyEvent.key === "Escape") closeModelSearchPopup();
		});
		root.addEventListener("pointerdown", (pointerEvent) => pointerEvent.stopPropagation());
		const outside = (outsideEvent) => {
			if (!root.contains(outsideEvent.target) && !button.contains(outsideEvent.target)) closeModelSearchPopup();
		};
		activeModelSearchPopup = {
			root,
			anchor: button,
			cleanup: () => document.removeEventListener("pointerdown", outside, true),
		};
		setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
		render();
		setTimeout(() => search.focus(), 0);
	});
	return host;
}

function renderStoryboardModelTree(node, controls, host) {
	const definitions = [
		{ name: "unet_name", label: "UNET 主模型", folder: "models/diffusion_models", icon: "🟣" },
		{ name: "clip_name1", label: "CLIP 编码器", folder: "models/text_encoders", icon: "🟡" },
		{ name: "vae_name", label: "VAE 解码器", folder: "models/vae", icon: "🔴" },
		{ name: STORYBOARD_LORA_NAME, label: "Next-Scene LoRA", folder: "models/loras", icon: "🟢" },
	];
	if (isNextSceneImageEdit(String(getWidget(node, "unet_name")?.value || ""), null)) {
		definitions.push({ name: REQUIRED_LIGHTNING_LORA_ENTRY, label: "Lightning LoRA", folder: "models/loras", icon: "⚡" });
	}
	const entries = definitions.map((definition) => {
		const isLightning = definition.name === REQUIRED_LIGHTNING_LORA_ENTRY;
		const entry = isLightning ? controls.get(STORYBOARD_LORA_NAME) : controls.get(definition.name);
		const values = allWidgetOptions(entry?.widget);
		const lightningValue = isLightning ? requiredLightningLora(node, entry?.widget) : "";
		const defaultModel = isLightning
			? lightningValue
			: String(entry?.widget?.options?.gjj_default_model || entry?.widget?.options?.default || "");
		const proxyWidget = {
			value: isLightning ? lightningValue : (entry?.widget?.value ?? entry?.control?.value ?? ""),
			options: { values },
			callback: (value) => {
				if (isLightning) {
					setRequiredLightningLora(node, value);
					return;
				}
				if (entry?.widget) {
					entry.widget.value = value;
					entry.widget.callback?.(value);
				}
				if (entry?.control) {
					if (entry.control.tagName === "SELECT" && ![...entry.control.options].some((option) => option.value === value)) {
						const option = document.createElement("option");
						option.value = value;
						option.textContent = value;
						entry.control.appendChild(option);
					}
					entry.control.value = value;
					entry.control.dispatchEvent(new Event("change", { bubbles: true }));
				}
			},
		};
		return {
			...definition,
			models: values,
			defaultModel,
			fallback: defaultModel,
			autoSelect: true,
			getWidget: () => proxyWidget,
		};
	});
	const tree = GJJ_Utils.createModelTreeView({
		node,
		entries,
		refresh: () => GJJ_Utils.refreshNode?.(node),
		onApply: () => queueMicrotask(() => renderStoryboardModelTree(node, controls, host)),
	});
	tree.style.gridColumn = "1 / -1";
	tree.style.maxHeight = "360px";
	const slots = renderStoryboardLoraSlots(node, controls, host);
	host.replaceChildren(tree, slots);
}

function storyboardLoraRows(node, hideRequired = true) {
	const widget = getWidget(node, "lora_data");
	const normalized = normalizeStoryboardLoraData(widget?.value);
	try {
		const rows = JSON.parse(normalized);
		if (!hideRequired) return rows;
		const required = new Set([loraBaseKey(getWidget(node, STORYBOARD_LORA_NAME)?.value)]);
		for (const row of rows) {
			if (isRequiredLightningRow(row)) required.add(loraBaseKey(row.name));
		}
		return rows.filter((row) => {
			if (!row?.name) return true;
			return !required.has(loraBaseKey(row.name));
		});
	} catch {
		return [{ ...DEFAULT_LORA_ROW }];
	}
}

function renderStoryboardLoraSlots(node, controls, host) {
	const wrapper = document.createElement("div");
	wrapper.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid #2b3d44;";
	const title = document.createElement("div");
	title.textContent = "🔗 可选 LoRA 插槽";
	title.style.cssText = "color:#c9d8dc;font:700 12px sans-serif;";
	wrapper.append(title);
	const rows = storyboardLoraRows(node);
	const optionWidget = controls.get(STORYBOARD_LORA_NAME)?.widget || getWidget(node, STORYBOARD_LORA_NAME);
	const options = [...new Set(["", ...allWidgetOptions(optionWidget).filter((value) => String(value || "").trim())])];
	rows.forEach((row, index) => {
		const line = document.createElement("div");
		line.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) 82px;gap:6px;align-items:center;";
		const picker = document.createElement("button");
		picker.type = "button";
		picker.textContent = row.name || "＋ 空 LoRA 插槽";
		picker.title = row.name || "选择 LoRA；弹出列表可按关键词二次过滤并查看介绍。";
		picker.style.cssText = "min-width:0;height:30px;border:1px solid #415761;border-radius:6px;background:#111c21;color:#e9f4ef;padding:0 7px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;";
		const strength = document.createElement("input");
		strength.type = "number";
		strength.step = "0.05";
		strength.value = String(normalizeStrength(row.strength, 1.0));
		strength.disabled = !row.name;
		strength.title = row.name ? "LoRA 强度" : "选择 LoRA 后可设置强度";
		strength.style.cssText = "width:100%;box-sizing:border-box;height:30px;border:1px solid #415761;border-radius:6px;background:#111c21;color:#e9f4ef;padding:0 7px;";
		const commit = (nextName = row.name, nextStrength = strength.value) => {
			const currentRows = storyboardLoraRows(node);
			while (currentRows.length <= index) currentRows.push({ ...DEFAULT_LORA_ROW });
			currentRows[index] = {
				enabled: Boolean(nextName),
				name: String(nextName || ""),
				strength: normalizeStrength(nextStrength, 1.0),
			};
			setWidgetValue(getWidget(node, "lora_data"), normalizeStoryboardLoraData(JSON.stringify(currentRows)));
			saveParamValues(node);
			renderStoryboardModelTree(node, controls, host);
		};
		picker.addEventListener("click", async (event) => {
			event.preventDefault();
			event.stopPropagation();
			const pickerApi = globalThis.GJJ_LoraPicker;
			if (!pickerApi?.open) {
				console.warn("[GJJ_StoryboardGridGenerator] LoRA 选择器尚未加载");
				return;
			}
			await pickerApi.open({
				anchorEl: picker,
				options: row.name && !options.includes(row.name) ? [...options, row.name] : options,
				selectedValue: row.name || "",
				searchValue: "",
				onSelect: (value) => commit(value, strength.value),
			});
		});
		strength.addEventListener("change", () => commit());
		line.append(picker, strength);
		wrapper.append(line);
	});
	return wrapper;
}

function clampParameterDialogPosition(root, left, top) {
	const margin = 8;
	const rect = root.getBoundingClientRect();
	return {
		left: Math.max(margin, Math.min(Number(left) || margin, window.innerWidth - rect.width - margin)),
		top: Math.max(margin, Math.min(Number(top) || margin, window.innerHeight - Math.min(rect.height, window.innerHeight - margin * 2) - margin)),
	};
}

function nodeScreenRect(node) {
	const canvasElement = app.canvas?.canvas;
	const canvasRect = canvasElement?.getBoundingClientRect?.();
	const dragScale = app.canvas?.ds;
	if (canvasElement && canvasRect && typeof dragScale?.convertCanvasToOffset === "function" && node?.pos && node?.size) {
		const topLeft = dragScale.convertCanvasToOffset([Number(node.pos[0]), Number(node.pos[1])]);
		const bottomRight = dragScale.convertCanvasToOffset([
			Number(node.pos[0]) + Number(node.size[0] || 0),
			Number(node.pos[1]) + Number(node.size[1] || 0),
		]);
		return {
			left: canvasRect.left + Number(topLeft[0] || 0),
			top: canvasRect.top + Number(topLeft[1] || 0),
			width: Number(bottomRight[0] || 0) - Number(topLeft[0] || 0),
			height: Number(bottomRight[1] || 0) - Number(topLeft[1] || 0),
		};
	}
	const scale = Number(app.canvas?.ds?.scale) || 1;
	const offset = app.canvas?.ds?.offset || [0, 0];
	if (!canvasElement || !canvasRect || !Array.isArray(node?.pos) || !Array.isArray(node?.size)) return null;
	return {
		left: canvasRect.left + (Number(node.pos[0]) + Number(offset[0] || 0)) * scale,
		top: canvasRect.top + (Number(node.pos[1]) + Number(offset[1] || 0)) * scale,
		width: Number(node.size[0] || 0) * scale,
		height: Number(node.size[1] || 0) * scale,
	};
}

function positionParameterDialog(node, root, anchorButton = null) {
	const remembered = node?.__gjjStoryboardParameterDialogPosition;
	const nodeRect = nodeScreenRect(node);
	const anchorRect = anchorButton?.getBoundingClientRect?.();
	const initialLeft = anchorRect?.left ?? remembered?.left ?? nodeRect?.left ?? 18;
	const initialTop = anchorRect?.bottom != null
		? anchorRect.bottom + 8
		: (remembered?.top ?? ((nodeRect?.top || 18) + (nodeRect?.height || 0) + 8));
	if (anchorRect?.bottom != null) {
		root.style.maxHeight = `${Math.max(96, window.innerHeight - initialTop - 8)}px`;
	}
	const position = clampParameterDialogPosition(root, initialLeft, initialTop);
	root.style.left = `${position.left}px`;
	root.style.top = `${position.top}px`;
}

function makeParameterDialogDraggable(node, root, header) {
	header.style.cursor = "move";
	header.addEventListener("pointerdown", (event) => {
		if (event.button !== 0 || event.target?.closest?.("button")) return;
		event.preventDefault();
		const startRect = root.getBoundingClientRect();
		const startX = event.clientX;
		const startY = event.clientY;
		header.setPointerCapture?.(event.pointerId);

		const move = (moveEvent) => {
			const position = clampParameterDialogPosition(
				root,
				startRect.left + moveEvent.clientX - startX,
				startRect.top + moveEvent.clientY - startY,
			);
			root.style.left = `${position.left}px`;
			root.style.top = `${position.top}px`;
		};
		const finish = (upEvent) => {
			header.releasePointerCapture?.(upEvent.pointerId);
			header.removeEventListener("pointermove", move);
			header.removeEventListener("pointerup", finish);
			header.removeEventListener("pointercancel", finish);
			const finalRect = root.getBoundingClientRect();
			node.__gjjStoryboardParameterDialogPosition = { left: finalRect.left, top: finalRect.top };
		};
		header.addEventListener("pointermove", move);
		header.addEventListener("pointerup", finish);
		header.addEventListener("pointercancel", finish);
	});
}

function openParameterDialog(node, groupName) {
	const group = PARAMETER_DIALOG_GROUPS[groupName];
	if (!group) return;
	closeParameterDialog();

	const root = document.createElement("div");
	root.style.cssText = [
		"position:fixed",
		"left:18px",
		"top:18px",
		"z-index:100000",
		"width:min(520px,calc(100vw - 36px))",
		"max-height:calc(100vh - 36px)",
		"display:flex",
		"flex-direction:column",
		"overflow:hidden",
		"border:1px solid #415761",
		"border-radius:10px",
		"background:#0c1418",
		"box-shadow:0 20px 60px rgba(0,0,0,.62)",
	].join(";");

	const header = document.createElement("div");
	header.style.cssText = "display:flex;flex:0 0 auto;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2c3d44;background:#111c21;";
	const title = document.createElement("strong");
	title.textContent = group.title;
	title.style.cssText = "flex:1;color:#edf7f2;font:700 14px sans-serif;";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.textContent = "取消";
	const confirm = document.createElement("button");
	confirm.type = "button";
	confirm.textContent = "确定";
	for (const button of [cancel, confirm]) {
		button.style.cssText = "height:28px;padding:0 12px;border:1px solid #4b6069;border-radius:6px;background:#1a272d;color:#eef7f2;font:700 12px sans-serif;cursor:pointer;";
	}
	confirm.style.background = "#086c4a";
	confirm.style.borderColor = "#10b981";
	header.append(title, cancel, confirm);

	const body = document.createElement("div");
	body.style.cssText = "display:grid;min-height:0;grid-template-columns:minmax(110px,150px) minmax(0,1fr);gap:9px 12px;overflow:auto;padding:12px;";
	const controls = new Map();
	const modelTreeHost = document.createElement("div");
	modelTreeHost.style.cssText = "display:block;grid-column:1/-1;min-width:0;";
	for (const name of group.widgets) {
		const widget = getWidget(node, name);
		if (!widget) continue;
		const label = document.createElement("label");
		label.textContent = widgetDisplayLabel(widget, name);
		label.style.cssText = "align-self:center;color:#b9c9cd;font:12px/1.3 sans-serif;";
		const control = createParameterControl(widget, name);
		controls.set(name, { widget, control });
		if (groupName === "model" && ["unet_name", "clip_name1", "vae_name", STORYBOARD_LORA_NAME].includes(name)) {
			continue;
		}
		body.append(label, control);
	}
	if (groupName === "model") {
		body.prepend(modelTreeHost);
		const unetControl = controls.get("unet_name")?.control;
		unetControl?.addEventListener("change", () => renderStoryboardModelTree(node, controls, modelTreeHost));
		renderStoryboardModelTree(node, controls, modelTreeHost);
	}
	if (!controls.size) {
		const empty = document.createElement("div");
		empty.textContent = "当前没有可配置参数。";
		empty.style.cssText = "grid-column:1/-1;color:#9fb3b8;padding:14px;";
		body.append(empty);
	}

	cancel.addEventListener("click", closeParameterDialog);
	confirm.addEventListener("click", () => {
		node.__gjjStoryboardApplyingParameterDialog = true;
		try {
			for (const { widget, control } of controls.values()) {
				let value = control.dataset.booleanValue !== undefined
					? control.dataset.booleanValue === "true"
					: (control.type === "checkbox" ? control.checked : control.value);
				if (typeof widget.value === "number") value = Number(value);
				setWidgetValue(widget, value);
			}
		} finally {
			delete node.__gjjStoryboardApplyingParameterDialog;
		}
		saveParamValues(node);
		drawPromptGridPreview(node);
		closeParameterDialog();
		GJJ_Utils.refreshNode?.(node);
	});
	root.append(header, body);
	const activeButton = groupName === "size"
		? node.__gjjStoryboardSizeButton
		: groupName === "model"
			? node.__gjjStoryboardModelButton
			: node.__gjjStoryboardSettingsButton;
	document.body.append(root);
	positionParameterDialog(node, root, activeButton);
	makeParameterDialogDraggable(node, root, header);
	const reposition = () => positionParameterDialog(node, root, activeButton);
	window.addEventListener("resize", reposition);
	activeParameterDialog = {
		root,
		node,
		group: groupName,
		cleanup: () => window.removeEventListener("resize", reposition),
	};

	if (activeButton) {
		activeButton.classList.add("on");
		activeButton.style.background = "linear-gradient(135deg, #4b5563, #64748b)";
		activeButton.style.borderColor = "#94a3b8";
	}
	updateModelButtonState(node);
}

function updateReconnectButton(node) {
	const button = node?.__gjjStoryboardReconnectButton;
	if (!button) return;
	const records = storyboardLinkMemory(node);
	const linked = hasLinkedStoryboardInputs(node);
	const visible = linked || records.length > 0;
	button.style.display = visible ? "" : "none";
	const first = records[0];
	const label = first ? [first.source_title, first.source_label].filter(Boolean).join(" · ") : "";
	if (linked) {
		button.title = records.length > 1
			? `当前已有上游连接；点击记住并断开 ${records.length} 个连接`
			: (label ? `当前已连接：${label}；点击记住并断开` : "当前已有上游连接；点击记住并断开");
	} else {
		button.title = records.length > 1
			? `重新连接 ${records.length} 个上游`
			: (label ? `重新连接：${label}` : "重新连接上游");
	}
	button.dataset.originalTitle = button.title;
}

function flashReconnectButton(node, text, ok = true) {
	const button = node?.__gjjStoryboardReconnectButton;
	if (!button) return;
	clearTimeout(button.__gjjStoryboardReconnectFlashTimer);
	button.textContent = text;
	button.style.background = ok ? "linear-gradient(135deg, #064e3b, #059669)" : "linear-gradient(135deg, #7f1d1d, #dc2626)";
	button.style.borderColor = ok ? "#10b981" : "#ef4444";
	button.__gjjStoryboardReconnectFlashTimer = setTimeout(() => {
		button.textContent = "🔗";
		button.style.background = "linear-gradient(135deg, #26313a, #334155)";
		button.style.borderColor = "#64748b";
		button.__gjjStoryboardReconnectFlashTimer = null;
		updateReconnectButton(node);
	}, 1200);
}

function reconnectStoryboardLinks(node) {
	const graph = node?.graph || app.graph;
	const records = storyboardLinkMemory(node);
	if (!records.length) {
		flashReconnectButton(node, "无", false);
		return false;
	}
	let connected = 0;
	let missing = 0;
	for (const record of records) {
		const sourceNode = getGraphNodeById(record.source_id, graph);
		const sourceSlot = Number(record.source_slot);
		if (!sourceNode || !sourceNode.outputs?.[sourceSlot]) {
			missing += 1;
			continue;
		}
		const byName = (node.inputs || []).find((input) => String(input?.name || "") === String(record.target_input_name || ""));
		const targetSlot = byName ? node.inputs.indexOf(byName) : Number(record.target_slot);
		const input = node.inputs?.[targetSlot];
		if (!input || !Number.isFinite(targetSlot)) {
			missing += 1;
			continue;
		}
		if (input.link != null) {
			try { node.disconnectInput?.(targetSlot); } catch (_) {}
		}
		try {
			sourceNode.connect(sourceSlot, node, targetSlot);
			connected += 1;
		} catch (error) {
			console.warn("[GJJ_StoryboardGridGenerator] reconnect upstream failed", error);
			missing += 1;
		}
	}
	if (connected > 0) {
		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		node.graph?.change?.();
		updateReconnectButton(node);
		flashReconnectButton(node, missing ? `${connected}` : "已连");
		return true;
	}
	flashReconnectButton(node, "丢失", false);
	return false;
}

function disconnectStoryboardLinks(node) {
	if (!Array.isArray(node?.inputs)) {
		flashReconnectButton(node, "无", false);
		return false;
	}
	recordCurrentStoryboardLinks(node);
	let disconnected = 0;
	for (const [index, input] of node.inputs.entries()) {
		if (input?.link == null) continue;
		try {
			if (typeof node.disconnectInput === "function") {
				node.disconnectInput(index);
			} else {
				(node?.graph || app.graph)?.removeLink?.(input.link);
			}
			disconnected += 1;
		} catch (error) {
			console.warn("[GJJ_StoryboardGridGenerator] disconnect upstream failed", error);
		}
	}
	if (disconnected > 0) {
		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		node.graph?.change?.();
		updateReconnectButton(node);
		flashReconnectButton(node, disconnected > 1 ? `${disconnected}` : "已断");
		return true;
	}
	flashReconnectButton(node, "无", false);
	return false;
}

function toggleStoryboardLinks(node) {
	if (hasLinkedStoryboardInputs(node)) {
		return disconnectStoryboardLinks(node);
	}
	return reconnectStoryboardLinks(node);
}

function createButtons(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:row",
		"flex-wrap:wrap",
		"align-items:center",
		"align-content:flex-start",
		"gap:3px",
		"width:100%",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	const sharedButtonStyle = [
		"height:26px",
		"padding:0 7px",
		"border-radius:5px",
		"color:#e5edf2",
		"font-size:11px",
		"font-weight:700",
		"cursor:pointer",
		"transition:all 0.15s ease",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1001",
		"pointer-events:auto",
		"user-select:none",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"gap:3px",
		"white-space:nowrap",
		"min-width:0",
	];

	const generateButton = document.createElement("button");
	generateButton.type = "button";
	generateButton.innerHTML = "✨ 全部";
	generateButton.title = "只执行当前分镜宫格节点。";
	generateButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #10b981",
		"background:linear-gradient(135deg, #064e3b, #059669)",
		"color:#a7f3d0",
		"flex:0 0 auto",
	].join(";");

	const singleButton = document.createElement("button");
	singleButton.type = "button";
	singleButton.textContent = "🎯 单格";
	singleButton.title = "只生成当前选中的一个宫格。";
	singleButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #38bdf8",
		"background:linear-gradient(135deg, #0c4a6e, #0284c7)",
		"color:#e0f2fe",
		"flex:0 0 auto",
	].join(";");

	const diceButton = document.createElement("button");
	diceButton.type = "button";
	diceButton.textContent = "🎲";
	diceButton.title = "一次性随机种子：默认固定，点亮后下一次生成临时使用随机 seed。";
	diceButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #64748b",
		"background:linear-gradient(135deg, #26313a, #334155)",
		"color:#e5edf2",
		"flex:0 0 28px",
		"padding:0",
	].join(";");
	node.__gjjStoryboardDiceButton = diceButton;

	const completeRefButton = document.createElement("button");
	completeRefButton.type = "button";
	completeRefButton.textContent = "🔄";
	completeRefButton.title = "检查所有宫格，把纯人物/场景名字补齐为角色库/场景库引用语法。";
	completeRefButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #64748b",
		"background:linear-gradient(135deg, #26313a, #334155)",
		"color:#e5edf2",
		"flex:0 0 28px",
		"padding:0",
	].join(";");
	node.__gjjStoryboardCompleteRefButton = completeRefButton;

	const reconnectButton = document.createElement("button");
	reconnectButton.type = "button";
	reconnectButton.textContent = "🔗";
	reconnectButton.title = "重新连接上游";
	reconnectButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #64748b",
		"background:linear-gradient(135deg, #26313a, #334155)",
		"color:#e5edf2",
		"flex:0 0 28px",
		"padding:0",
		"display:none",
	].join(";");
	node.__gjjStoryboardReconnectButton = reconnectButton;

	const templateButton = createTemplateSourceButton(node, TEMPLATE_SOURCE_FIELDS, sharedButtonStyle);

	const sizeButton = document.createElement("button");
	sizeButton.type = "button";
	sizeButton.textContent = "📐";
	sizeButton.title = "尺寸与宫格参数";
	sizeButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #55636f",
		"background:linear-gradient(135deg, #1f2933, #374151)",
		"color:#e5edf2",
		"flex:0 0 30px",
		"padding:0",
	].join(";");
	node.__gjjStoryboardSizeButton = sizeButton;

	const modelButton = document.createElement("button");
	modelButton.type = "button";
	modelButton.textContent = "🧠";
	modelButton.title = "模型参数";
	modelButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #55636f",
		"background:linear-gradient(135deg, #1f2933, #374151)",
		"color:#e5edf2",
		"flex:0 0 30px",
		"padding:0",
	].join(";");
	node.__gjjStoryboardModelButton = modelButton;

	const settingsButton = document.createElement("button");
	settingsButton.type = "button";
	settingsButton.textContent = "⚙️";
	settingsButton.title = "其他生成参数";
	settingsButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #55636f",
		"background:linear-gradient(135deg, #1f2933, #374151)",
		"color:#e5edf2",
		"flex:0 0 30px",
		"padding:0",
	].join(";");
	node.__gjjStoryboardSettingsButton = settingsButton;

	function protectEvent(event) {
		event.preventDefault();
		event.stopPropagation();
	}

	function setupButtonHover(button, defaultBg, hoverBg) {
		button.addEventListener("mouseenter", () => {
			if (button === diceButton && node.__gjjStoryboardRandomSeedOnce) return;
			if (button === completeRefButton && button.__gjjStoryboardCompleteRefFlashTimer) return;
			if (button === reconnectButton && button.__gjjStoryboardReconnectFlashTimer) return;
			if (button.classList.contains("on")) return;
			button.style.background = hoverBg;
			button.style.transform = "translateY(-1px)";
		});
		button.addEventListener("mouseleave", () => {
			if (button === diceButton && node.__gjjStoryboardRandomSeedOnce) {
				button.style.transform = "translateY(0)";
				updateDiceButtonState();
				return;
			}
			if (button === completeRefButton && button.__gjjStoryboardCompleteRefFlashTimer) {
				button.style.transform = "translateY(0)";
				return;
			}
			if (button === reconnectButton && button.__gjjStoryboardReconnectFlashTimer) {
				button.style.transform = "translateY(0)";
				return;
			}
			if (button.classList.contains("on")) {
				button.style.transform = "translateY(0)";
				return;
			}
			button.style.background = defaultBg;
			button.style.transform = "translateY(0)";
		});
	}

	function setupButtonEvents(button, handler) {
		let lastHandledAt = 0;
		const wrapped = (event) => {
			const now = Date.now();
			protectEvent(event);
			if (now - lastHandledAt < 250) return;
			lastHandledAt = now;
			handler(event);
		};
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
			button.addEventListener(eventName, protectEvent, true);
			container.addEventListener(eventName, protectEvent, true);
		}
		button.addEventListener("pointerup", wrapped, true);
		button.addEventListener("click", wrapped, true);
	}

	async function handleGenerate(event) {
		protectEvent(event);
		const effectivePrompt = currentPromptText(node);
		reconcilePreviewForPromptChange(node, effectivePrompt);
		drawPromptGridPreview(node);
		const originalText = generateButton.innerHTML;
		generateButton.innerHTML = "⏳ 解析人物";
		generateButton.disabled = true;
		generateButton.style.opacity = "0.7";
		if (node.__gjjStoryboardPreviewStatus) {
			node.__gjjStoryboardPreviewStatus.textContent = `已建立 ${Math.max(1, parsePromptParts(effectivePrompt).length)} 个提示词宫格 · 正在解析人物...`;
		}
		await resolvePromptCharacters(node, effectivePrompt);
		generateButton.innerHTML = "⏳ 执行中";
		const promptCount = Math.max(1, parsePromptParts(effectivePrompt).length);
		const generatedCount = storyboardPreviewImageItems(node).length;
		node.__gjjStoryboardForceGenerateAll = Boolean(node.__gjjStoryboardPromptChangedSinceGenerate)
			|| generatedCount >= promptCount;
		try {
			updateDiceButtonState();
			const ok = await queueOnlyCurrentNode(node);
			if (ok && currentPromptText(node) === effectivePrompt) {
				node.__gjjStoryboardPromptChangedSinceGenerate = false;
			}
			generateButton.innerHTML = ok ? "✅ 执行中" : "❌ 执行失败";
			generateButton.style.background = ok
				? "linear-gradient(135deg, #064e3b, #059669)"
				: "linear-gradient(135deg, #7f1d1d, #dc2626)";
			generateButton.style.borderColor = ok ? "#10b981" : "#ef4444";
		} catch (error) {
			console.error("[GJJ_StoryboardGridGenerator] execute failed:", error);
			generateButton.innerHTML = "❌ 错误";
			generateButton.style.background = "linear-gradient(135deg, #7f1d1d, #dc2626)";
			generateButton.style.borderColor = "#ef4444";
		} finally {
			setTimeout(() => {
				delete node.__gjjStoryboardForceGenerateAll;
				clearOneShotSeed();
				generateButton.innerHTML = originalText;
				generateButton.disabled = false;
				generateButton.style.opacity = "1";
				generateButton.style.background = "linear-gradient(135deg, #064e3b, #059669)";
				generateButton.style.borderColor = "#10b981";
			}, 1500);
		}
	}

	function updateDiceButtonState() {
		const active = Boolean(node.__gjjStoryboardRandomSeedOnce);
		diceButton.style.background = active ? "linear-gradient(135deg, #854d0e, #ca8a04)" : "linear-gradient(135deg, #26313a, #334155)";
		diceButton.style.borderColor = active ? "#facc15" : "#64748b";
		diceButton.style.color = active ? "#fff7cc" : "#e5edf2";
		diceButton.title = active ? "下一次生成会临时使用随机 seed；生成后自动恢复固定。" : "一次性随机种子：默认固定，点亮后下一次生成临时使用随机 seed。";
	}

	function clearOneShotSeed() {
		delete node.__gjjStoryboardRandomSeedOnce;
		delete node.__gjjStoryboardPreparedSeed;
		delete node.__gjjStoryboardSeedPreparedAt;
		updateDiceButtonState();
	}

	async function handleSingleGenerate(event) {
		protectEvent(event);
		const selectedIndices = selectedCellIndices(node);
		const effectivePrompt = currentPromptText(node);
		reconcilePreviewForPromptChange(node, effectivePrompt);
		drawPromptGridPreview(node);
		const originalText = singleButton.textContent;
		singleButton.textContent = "⏳ 解析人物";
		singleButton.disabled = true;
		singleButton.style.opacity = "0.7";
		if (node.__gjjStoryboardPreviewStatus) {
			node.__gjjStoryboardPreviewStatus.textContent = `已建立 ${Math.max(1, parsePromptParts(effectivePrompt).length)} 个提示词宫格 · 正在解析人物...`;
		}
		await resolvePromptCharacters(node, effectivePrompt);
		singleButton.textContent = selectedIndices.length > 1 ? "⏳ 多格" : "⏳ 单格";
		node.__gjjStoryboardSingleCellIndex = selectedIndices[0];
		node.__gjjStoryboardSingleCellIndices = selectedIndices;
		try {
			updateDiceButtonState();
			const ok = await queueOnlyCurrentNode(node);
			singleButton.textContent = ok ? (selectedIndices.length > 1 ? "✅ 多格" : "✅ 单格") : "❌ 单格";
		} catch (error) {
			console.error("[GJJ_StoryboardGridGenerator] single cell execute failed:", error);
			singleButton.textContent = "❌ 单格";
		} finally {
			setTimeout(() => {
				delete node.__gjjStoryboardSingleCellIndex;
				delete node.__gjjStoryboardSingleCellIndices;
				clearOneShotSeed();
				singleButton.textContent = originalText;
				singleButton.disabled = false;
				singleButton.style.opacity = "1";
			}, 1200);
		}
	}

	function handleSettings(event) {
		protectEvent(event);
		openParameterDialog(node, "settings");
	}

	function handleModels(event) {
		protectEvent(event);
		openParameterDialog(node, "model");
	}

	function handleSize(event) {
		protectEvent(event);
		openParameterDialog(node, "size");
	}

	function handleDice(event) {
		protectEvent(event);
		node.__gjjStoryboardRandomSeedOnce = !node.__gjjStoryboardRandomSeedOnce;
		delete node.__gjjStoryboardPreparedSeed;
		delete node.__gjjStoryboardSeedPreparedAt;
		updateDiceButtonState();
	}

	function handleReconnect(event) {
		protectEvent(event);
		toggleStoryboardLinks(node);
	}

	function flashCompleteRefButton(text, ok = true) {
		clearTimeout(completeRefButton.__gjjStoryboardCompleteRefFlashTimer);
		completeRefButton.textContent = text;
		completeRefButton.style.background = ok ? "linear-gradient(135deg, #064e3b, #059669)" : "linear-gradient(135deg, #7f1d1d, #dc2626)";
		completeRefButton.style.borderColor = ok ? "#10b981" : "#ef4444";
		completeRefButton.__gjjStoryboardCompleteRefFlashTimer = setTimeout(() => {
			completeRefButton.textContent = "🔄";
			completeRefButton.style.background = "linear-gradient(135deg, #26313a, #334155)";
			completeRefButton.style.borderColor = "#64748b";
			completeRefButton.__gjjStoryboardCompleteRefFlashTimer = null;
		}, 1200);
	}

	function handleCompleteReferences(event) {
		protectEvent(event);
		const count = completeStoryboardReferenceSyntax(node, completeRefButton);
		flashCompleteRefButton(count > 0 ? `${count}` : "无", count > 0);
	}

	setupButtonHover(generateButton, "linear-gradient(135deg, #064e3b, #059669)", "linear-gradient(135deg, #059669, #10b981)");
	setupButtonHover(singleButton, "linear-gradient(135deg, #0c4a6e, #0284c7)", "linear-gradient(135deg, #0284c7, #38bdf8)");
	setupButtonHover(diceButton, "linear-gradient(135deg, #26313a, #334155)", "linear-gradient(135deg, #475569, #64748b)");
	setupButtonHover(completeRefButton, "linear-gradient(135deg, #26313a, #334155)", "linear-gradient(135deg, #475569, #64748b)");
	setupButtonHover(reconnectButton, "linear-gradient(135deg, #26313a, #334155)", "linear-gradient(135deg, #475569, #64748b)");
	setupButtonHover(sizeButton, "linear-gradient(135deg, #1f2933, #374151)", "linear-gradient(135deg, #374151, #4b5563)");
	setupButtonHover(modelButton, "linear-gradient(135deg, #1f2933, #374151)", "linear-gradient(135deg, #374151, #4b5563)");
	setupButtonHover(settingsButton, "linear-gradient(135deg, #1f2933, #374151)", "linear-gradient(135deg, #374151, #4b5563)");
	setupButtonEvents(generateButton, handleGenerate);
	setupButtonEvents(singleButton, handleSingleGenerate);
	setupButtonEvents(diceButton, handleDice);
	setupButtonEvents(completeRefButton, handleCompleteReferences);
	setupButtonEvents(reconnectButton, handleReconnect);
	setupButtonEvents(sizeButton, handleSize);
	setupButtonEvents(modelButton, handleModels);
	setupButtonEvents(settingsButton, handleSettings);
	updateSettingsButtonState(node);
	updateModelButtonState(node);
	updateDiceButtonState();
	updateReconnectButton(node);

	container.appendChild(generateButton);
	container.appendChild(singleButton);
	container.appendChild(diceButton);
	container.appendChild(completeRefButton);
	container.appendChild(reconnectButton);
	container.appendChild(templateButton);
	container.appendChild(sizeButton);
	container.appendChild(modelButton);
	container.appendChild(settingsButton);
	return container;
}

function createImagePreview(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
	].join(";");
	const status = document.createElement("div");
	status.textContent = "正向提示词按空行、单独一行 --- 或 Scene：镜头 :: 描述 分段；每段生成一张分镜，完成后输出智能宫格图。";
	status.style.cssText = "color:#9fb3b8;font:12px/1.35 sans-serif;white-space:normal;";
	const canvas = document.createElement("canvas");
	canvas.tabIndex = 0;
	canvas.style.cssText = [
		"display:block",
		"width:100%",
		"height:auto",
		"min-height:150px",
		"background:#05080a",
		"border:1px solid #33434a",
		"border-radius:8px",
		"box-sizing:border-box",
		"cursor:pointer",
	].join(";");
	canvas.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const iconHit = storyboardReferenceIconHit(node, event);
		if (iconHit?.icon) {
			setSelectedCellIndex(node, iconHit.icon.cellIndex ?? selectedCellIndex(node));
			openReferencePicker(node, iconHit.icon, event);
			return;
		}
		const hit = storyboardCellHit(node, event);
		if (hit >= 0) updateCellSelectionFromEvent(node, hit, event);
	});
	canvas.addEventListener("mousemove", (event) => {
		canvas.style.cursor = storyboardReferenceIconHit(node, event) ? "pointer" : "pointer";
	});
	canvas.addEventListener("pointerdown", (event) => {
		const hit = storyboardCellHit(node, event);
		if (hit >= 0 && node.__gjjStoryboardCellPreviewItems?.[hit]?.filename) setSelectedCellIndex(node, hit);
	});
	canvas.addEventListener("dblclick", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (storyboardReferenceIconHit(node, event)) return;
		const hit = storyboardCellHit(node, event);
		if (hit < 0) return;
		setSelectedCellIndex(node, hit);
		editStoryboardCellPrompt(node, hit);
	});
	const image = document.createElement("img");
	image.alt = "Storyboard preview";
	image.setAttribute("aria-label", "当前宫格缩略大图，点击查看原图，也可拖到画布或任意对象预览器");
	image.style.cssText = [
		"display:none",
		"width:100%",
		"max-height:260px",
		"object-fit:contain",
		"background:#0f1418",
		"border:1px solid #33434a",
		"border-radius:8px",
		"box-sizing:border-box",
		"cursor:zoom-in",
	].join(";");
	image.addEventListener("load", () => GJJ_Utils.refreshNode?.(node));
	image.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const selected = selectedCellIndex(node);
		const item = node.__gjjStoryboardCellPreviewItems?.[selected];
		if (item?.filename) openStoryboardFullImage(item, selected + 1);
	});
	image.addEventListener("pointerenter", () => {
		const item = node.__gjjStoryboardCellPreviewItems?.[selectedCellIndex(node)];
		if (item?.filename) void preloadStoryboardFullImage(item);
	}, { passive: true });
	bindGjjMediaDrag(image, () => node.__gjjStoryboardCellPreviewItems?.[selectedCellIndex(node)] || null);
	bindGjjMediaDrag(canvas, () => node.__gjjStoryboardCellPreviewItems?.[selectedCellIndex(node)] || null);
	container.append(status, canvas, image);
	node.__gjjStoryboardPreviewStatus = status;
	node.__gjjStoryboardGridCanvas = canvas;
	node.__gjjStoryboardPreviewImage = image;
	setTimeout(() => drawPromptGridPreview(node), 0);
	for (const delay of [350, 1200, 2600]) setTimeout(() => drawPromptGridPreview(node), delay);
	return container;
}

function storyboardGridGeometry(count, width, height) {
	count = Math.max(1, Number(count) || 1);
	const layouts = {
		1: [1, 1],
		2: [2, 1],
		3: [3, 1],
		4: [2, 2],
		5: [3, 2],
		6: [3, 2],
		7: [4, 2],
		8: [4, 2],
		9: [3, 3],
		10: [5, 2],
		11: [4, 3],
		12: [4, 3],
	};
	let [cols, rows] = layouts[count] || [Math.ceil(Math.sqrt(count)), Math.ceil(count / Math.ceil(Math.sqrt(count)))];
	const cellW = Math.floor(width / cols);
	const cellH = Math.floor(height / rows);
	const rects = [];
	for (let index = 0; index < count; index += 1) {
		const col = index % cols;
		const row = Math.floor(index / cols);
		rects.push({ left: col * cellW, top: row * cellH, right: col * cellW + cellW, bottom: row * cellH + cellH, index });
	}
	return { cols, rows, rects };
}

function wrapCanvasText(ctx, text, maxWidth, maxLines) {
	const lines = [];
	let current = "";
	let truncated = false;
	for (const char of String(text || "")) {
		const next = current + char;
		if (current && ctx.measureText(next).width > maxWidth) {
			lines.push(current);
			current = char;
			if (lines.length >= maxLines) {
				truncated = true;
				break;
			}
		} else {
			current = next;
		}
	}
	if (current && lines.length < maxLines) lines.push(current);
	if (truncated && lines.length === maxLines) lines[lines.length - 1] = `${lines[lines.length - 1].replace(/\s+$/g, "")}……`;
	return lines;
}

function apiMediaUrl(url) {
	const text = String(url || "").trim();
	if (!text) return "";
	if (/^(?:https?:|data:|blob:)/i.test(text)) return text;
	return api?.apiURL ? api.apiURL(text) : text;
}

function refKey(value) {
	return String(value || "")
		.trim()
		.replace(/^@/, "")
		.replace(/\\/g, "/")
		.toLowerCase();
}

function itemAliasKeys(item) {
	const values = [item?.reference_name, item?.name, item?.id, item?._folder_id, ...(Array.isArray(item?.tags) ? item.tags : [])];
	return values.map(refKey).filter(Boolean);
}

function findLibraryItem(items, name) {
	const key = refKey(name);
	if (!key) return null;
	return (items || []).find((item) => itemAliasKeys(item).includes(key))
		|| (items || []).find((item) => itemAliasKeys(item).some((alias) => alias.includes(key) || key.includes(alias)))
		|| null;
}

function findExactLibraryItem(items, name) {
	const key = refKey(name);
	if (!key) return null;
	return (items || []).find((item) => itemAliasKeys(item).includes(key)) || null;
}

function referenceDisplayName(item) {
	return String(item?.name || item?.id || item?._folder_id || "").trim();
}

function referenceAliases(item) {
	const values = [item?.reference_name, item?.name, item?.id, item?._folder_id, ...(Array.isArray(item?.tags) ? item.tags : [])];
	const result = [];
	const seen = new Set();
	for (const value of values) {
		const text = String(value || "").trim();
		const key = refKey(text);
		if (!text || !key || seen.has(key)) continue;
		seen.add(key);
		result.push(text);
	}
	return result;
}

function protectExistingReferences(text) {
	const source = String(text || "");
	const ranges = [];
	for (const pattern of [CHARACTER_REF_PATTERN, SCENE_VIEW_REF_PATTERN, SCENE_REF_PATTERN]) {
		pattern.lastIndex = 0;
		for (const match of source.matchAll(pattern)) {
			ranges.push({ start: match.index || 0, end: (match.index || 0) + match[0].length });
		}
	}
	ranges.sort((left, right) => left.start - right.start || right.end - left.end);
	const merged = [];
	for (const range of ranges) {
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end) {
			last.end = Math.max(last.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	const tokens = [];
	let cursor = 0;
	let output = "";
	for (const range of merged) {
		output += source.slice(cursor, range.start);
		const token = `__GJJ_REF_${tokens.length}__`;
		tokens.push(source.slice(range.start, range.end));
		output += token;
		cursor = range.end;
	}
	output += source.slice(cursor);
	return { text: output, tokens };
}

function restoreExistingReferences(text, tokens) {
	let output = String(text || "");
	for (const [index, value] of (tokens || []).entries()) {
		output = output.replaceAll(`__GJJ_REF_${index}__`, value);
	}
	return output;
}

function isAsciiWordChar(char) {
	return /[0-9A-Za-z_]/.test(char || "");
}

function isInsideReferenceSyntax(source, index) {
	const before = String(source || "").slice(0, Math.max(0, index));
	const lastAt = before.lastIndexOf("@");
	if (lastAt >= 0 && !/[\s,，;；。.!！?？()[\]{}<>《》"'“”‘’]/.test(before.slice(lastAt + 1))) {
		return true;
	}
	const lastOpen = before.lastIndexOf("[");
	const lastClose = before.lastIndexOf("]");
	return lastOpen > lastClose;
}

function replacePlainAlias(text, alias, referenceText) {
	const source = String(text || "");
	const target = String(alias || "").trim();
	const replacement = String(referenceText || "").trim();
	if (!target || !replacement) return { text: source, count: 0 };
	let output = "";
	let cursor = 0;
	let count = 0;
	const asciiEdge = /^[0-9A-Za-z_]+$/.test(target);
	while (cursor < source.length) {
		const index = source.indexOf(target, cursor);
		if (index < 0) {
			output += source.slice(cursor);
			break;
		}
		const before = source[index - 1] || "";
		const after = source[index + target.length] || "";
		const alreadyPrefixed = before === "@" || before === "/" || before === ":" || before === "：";
		const asciiBlocked = asciiEdge && (isAsciiWordChar(before) || isAsciiWordChar(after));
		if (alreadyPrefixed || asciiBlocked || isInsideReferenceSyntax(source, index)) {
			output += source.slice(cursor, index + target.length);
			cursor = index + target.length;
			continue;
		}
		output += source.slice(cursor, index) + replacement;
		cursor = index + target.length;
		count += 1;
	}
	return { text: output, count };
}

function referenceSyntaxCandidates() {
	const characters = globalThis.GJJ_CharacterLibrary?.characters || [];
	const scenes = globalThis.GJJ_SceneLibrary?.scenes || [];
	const aliasKinds = new Map();
	const raw = [];
	for (const character of characters) {
		const ref = globalThis.GJJ_CharacterLibrary?.referenceText?.(character)
			|| `@${characterReferenceName(character, character?.id)}`;
		for (const alias of referenceAliases(character)) {
			raw.push({ alias, ref, kind: "character", label: referenceDisplayName(character) });
			const key = refKey(alias);
			aliasKinds.set(key, (aliasKinds.get(key) || new Set()).add("character"));
		}
	}
	for (const scene of scenes) {
		const ref = globalThis.GJJ_SceneLibrary?.referenceText?.(scene)
			|| `🏕️${referenceDisplayName(scene)}`;
		for (const alias of referenceAliases(scene)) {
			raw.push({ alias, ref, kind: "scene", label: referenceDisplayName(scene) });
			const key = refKey(alias);
			aliasKinds.set(key, (aliasKinds.get(key) || new Set()).add("scene"));
		}
	}
	const seen = new Set();
	return raw
		.filter((item) => {
			const key = refKey(item.alias);
			if (!key || seen.has(`${item.kind}:${key}`)) return false;
			seen.add(`${item.kind}:${key}`);
			const kinds = aliasKinds.get(key);
			return !kinds || kinds.size === 1;
		})
		.sort((left, right) => String(right.alias).length - String(left.alias).length);
}

function completeReferenceSyntaxInText(text, candidates) {
	const protectedRefs = protectExistingReferences(text);
	let working = protectedRefs.text;
	let count = 0;
	for (const candidate of candidates) {
		const result = replacePlainAlias(working, candidate.alias, candidate.ref);
		working = result.text;
		count += result.count;
	}
	return { text: restoreExistingReferences(working, protectedRefs.tokens), count };
}

function completeStoryboardReferenceSyntax(node, button = null) {
	const widget = getWidget(node, "prompt");
	if (!widget) return 0;
	const parts = parsePromptParts(widget.value || "");
	if (!parts.length) return 0;
	const candidates = referenceSyntaxCandidates();
	if (!candidates.length) return 0;
	let changed = 0;
	const nextParts = parts.map((part) => {
		const result = completeReferenceSyntaxInText(part, candidates);
		changed += result.count;
		return result.text;
	});
	if (changed <= 0) return 0;
	setWidgetValue(widget, serializePromptParts(nextParts));
	saveParamValues(node);
	drawPromptGridPreview(node);
	GJJ_Utils.refreshNode?.(node);
	return changed;
}

function splitCharacterViewSuffix(name, characterItems = null) {
	const text = String(name || "").trim();
	if (!text) return ["", ""];
	const characters = characterItems || globalThis.GJJ_CharacterLibrary?.characters || [];
	const exact = findExactLibraryItem(characters, text);
	if (exact) return [text, ""];
	const textKey = refKey(text);
	const prefixMatches = [];
	for (const character of characters) {
		for (const aliasKey of itemAliasKeys(character)) {
			if (aliasKey && textKey.startsWith(aliasKey)) {
				prefixMatches.push({ character, aliasKey });
			}
		}
	}
	if (prefixMatches.length) {
		prefixMatches.sort((left, right) => right.aliasKey.length - left.aliasKey.length);
		const best = prefixMatches[0];
		const remainder = textKey.slice(best.aliasKey.length);
		const suffixView = /^[a-g](?:$|[^0-9a-z._-])/i.test(remainder) ? remainder[0].toLowerCase() : "";
		return [characterReferenceName(best.character, best.character?.id), suffixView];
	}
	const match = text.match(/^(.+?)([a-gA-G])$/);
	if (!match) return [text, ""];
	const base = match[1].trim();
	return findExactLibraryItem(characters, base) ? [base, match[2].toLowerCase()] : [text, ""];
}

function sceneCoverUrl(scene) {
	return gjjSceneThumbnailPath(scene);
}

function itemCoverUrl(item) {
	return item?.cover || (item?.assets || []).find((asset) => asset?.preview_url)?.preview_url || "";
}

function characterCoverUrl(character) {
	return gjjCharacterThumbnailPath(character);
}

function addUniqueReferenceIcon(icons, kind, name, url = "", fallback = "") {
	const key = `${kind}:${refKey(name)}`;
	if (!name) return null;
	const existing = icons.find((item) => item.key === key);
	if (existing) return existing;
	const item = { key, kind, name, url: apiMediaUrl(url), fallback };
	icons.push(item);
	return item;
}

function characterReferenceName(character, fallback = "") {
	return String(character?.reference_name || character?.name || character?.id || fallback || "").replace(/^\s*(?:♀️|♂️|♀|♂)\s*/, "").trim();
}

function storyboardCharacterItems(node) {
	const libraryItems = globalThis.GJJ_CharacterLibrary?.characters || [];
	const resolvedItems = [...(node?.__gjjStoryboardResolvedCharacters?.values?.() || [])].filter(Boolean);
	const result = [];
	const seen = new Set();
	for (const item of [...resolvedItems, ...libraryItems]) {
		const key = refKey(item?.id || item?.name || item?._folder_id);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(item);
	}
	return result;
}

async function resolvePromptCharacters(node, promptText, attempt = 0) {
	if (!isTarget(node)) return;
	const resolve = globalThis.GJJ_CharacterLibrary?.resolve;
	if (typeof resolve !== "function") {
		if (attempt >= 20) return;
		await new Promise((done) => setTimeout(done, 120));
		return resolvePromptCharacters(node, promptText, attempt + 1);
	}
	const token = Number(node.__gjjStoryboardCharacterResolveToken || 0) + 1;
	node.__gjjStoryboardCharacterResolveToken = token;
	const names = [];
	const seen = new Set();
	CHARACTER_REF_PATTERN.lastIndex = 0;
	for (const match of String(promptText || "").matchAll(CHARACTER_REF_PATTERN)) {
		const rawName = String(match[1] || "").trim();
		const key = refKey(rawName);
		if (!rawName || !key || seen.has(key)) continue;
		seen.add(key);
		names.push(rawName);
	}
	const entries = await Promise.all(names.map(async (rawName) => {
		try {
			const result = await resolve(rawName);
			return [refKey(rawName), result?.character || null];
		} catch (_) {
			const libraryMatch = splitCharacterViewSuffix(rawName, globalThis.GJJ_CharacterLibrary?.characters || []);
			if (libraryMatch[0] && refKey(libraryMatch[0]) !== refKey(rawName)) {
				try {
					const result = await resolve(libraryMatch[0]);
					return [refKey(rawName), result?.character || null];
				} catch (_) {}
			}
			const suffix = rawName.match(/^(.+?)[a-gA-G]$/);
			if (!suffix) return [refKey(rawName), null];
			try {
				const result = await resolve(suffix[1]);
				return [refKey(rawName), result?.character || null];
			} catch (_) {
				return [refKey(rawName), null];
			}
		}
	}));
	if (node.__gjjStoryboardCharacterResolveToken !== token) return;
	node.__gjjStoryboardResolvedCharacters = new Map(entries);
	node.__gjjStoryboardReferenceIconImages?.clear?.();
	drawPromptGridPreview(node);
}

function currentPromptText(node) {
	const persistedCellPrompt = () => {
		const cells = parseGridCells(node?.properties?.[GRID_CELLS_PROPERTY]);
		if (!cells.length || !cells.some((cell) => String(cell?.prompt || "").trim())) return "";
		return serializePromptParts(cells.map((cell) => String(cell?.prompt || "")));
	};
	const linkedSource = linkedPromptSource(node);
	if (linkedSource) {
		const linkedText = String(linkedSource.text || "");
		if (linkedText) {
			syncPromptSnapshot(node, linkedText);
			return linkedText;
		}
		const snapshot = String(node?.properties?.[SYNCED_PROMPT_PROPERTY] || "");
		if (snapshot) return snapshot;
		const persisted = persistedCellPrompt();
		if (persisted) return persisted;
		const actualParts = node?.__gjjStoryboardActualPromptParts || [];
		if (actualParts.some((part) => typeof part === "string" && part.trim())) {
			return serializePromptParts(actualParts.map((part) => String(part || "")));
		}
	}
	const widgetText = String(getWidget(node, "prompt")?.value || "");
	return widgetText || persistedCellPrompt();
}

function syncPromptSnapshot(node, promptText) {
	const text = String(promptText ?? "");
	if (!text) return;
	const widget = getWidget(node, "prompt");
	if (widget && String(widget.value || "") !== text) {
		widget.value = text;
		if (widget.inputEl) widget.inputEl.value = text;
		if (widget.element && "value" in widget.element) widget.element.value = text;
	}
	node.properties ||= {};
	node.properties[SYNCED_PROMPT_PROPERTY] = text;
	node.properties[PARAM_VALUES_PROPERTY] ||= {};
	node.properties[PARAM_VALUES_PROPERTY].prompt = text;
}

function reconcilePreviewForPromptChange(node, nextText) {
	const normalized = String(nextText ?? "");
	const previous = node.__gjjStoryboardLastEffectivePromptText;
	node.__gjjStoryboardLastEffectivePromptText = normalized;
	if (node.__gjjStoryboardRestoringPreviewCache) return false;
	if (previous === undefined || previous === normalized) return false;
	const previousParts = parsePromptParts(previous);
	const nextParts = parsePromptParts(normalized);
	const changedIndices = [];
	const count = Math.max(previousParts.length, nextParts.length);
	for (let index = 0; index < count; index += 1) {
		if (String(previousParts[index] || "") !== String(nextParts[index] || "")) {
			changedIndices.push(index);
		}
	}
	if (!changedIndices.length) return false;
	invalidateStoryboardGeneratedCache(node, changedIndices, nextParts.length);
	const cells = storyboardGridCells(node, normalized);
	for (const index of changedIndices) {
		if (!cells[index]) continue;
		const refs = promptCellReferences(nextParts[index]);
		cells[index].prompt = String(nextParts[index] || "");
		cells[index].seed = cellSeed(node, index + 1);
		cells[index].characters = refs.characters;
		cells[index].scenes = refs.scenes;
		cells[index].image = null;
	}
	saveGridCells(node, cells, true);
	node.__gjjStoryboardActualPromptTotal = nextParts.length;
	node.__gjjStoryboardResolvedCharacters = new Map();
	node.__gjjStoryboardReferenceIconImages?.clear?.();
	closeReferencePicker(node);
	drawPromptGridPreview(node);
	return true;
}

function invalidateStoryboardGeneratedCache(node, changedIndices = null, nextCount = 0) {
	if (!node) return;
	node.__gjjStoryboardPreviewRestoreToken = Symbol("storyboard-preview-invalidated");
	const changed = Array.isArray(changedIndices) ? new Set(changedIndices) : null;
	if (!changed) {
		node.__gjjStoryboardCellPreviewUrls = [];
		node.__gjjStoryboardCellPreviewImages = [];
		node.__gjjStoryboardCellPreviewItems = [];
		node.__gjjStoryboardActualPromptParts = [];
	} else {
		for (const index of changed) {
			if (node.__gjjStoryboardCellPreviewUrls) node.__gjjStoryboardCellPreviewUrls[index] = "";
			if (node.__gjjStoryboardCellPreviewImages) node.__gjjStoryboardCellPreviewImages[index] = null;
			if (node.__gjjStoryboardCellPreviewItems) node.__gjjStoryboardCellPreviewItems[index] = null;
			if (node.__gjjStoryboardActualPromptParts) node.__gjjStoryboardActualPromptParts[index] = undefined;
		}
		for (const key of ["__gjjStoryboardCellPreviewUrls", "__gjjStoryboardCellPreviewImages", "__gjjStoryboardCellPreviewItems", "__gjjStoryboardActualPromptParts"]) {
			if (Array.isArray(node[key])) node[key].length = Math.max(0, nextCount);
		}
	}
	node.__gjjStoryboardPromptChangedSinceGenerate = true;
	node.properties ||= {};
	const cells = storyboardGridCells(node);
	for (const cell of cells) {
		const index = cell.index - 1;
		if (!changed || index >= nextCount || changed.has(index)) cell.image = null;
	}
	saveGridCells(node, cells);
}

function promptReferenceIcons(promptText, node = null) {
	const text = String(promptText || "");
	const icons = [];
	const scenes = globalThis.GJJ_SceneLibrary?.scenes || [];
	const characters = storyboardCharacterItems(node);
	const costumes = globalThis.GJJ_CostumeLibrary?.items || [];
	for (const match of text.matchAll(SCENE_VIEW_REF_PATTERN)) {
		const rawName = String(match[1] || "").trim();
		const scene = findLibraryItem(scenes, rawName) || { id: rawName, name: rawName, annotations: [] };
		const icon = addUniqueReferenceIcon(icons, "scene", scene.name || scene.id || rawName, sceneCoverUrl(scene), "🏞");
		if (icon) icon.source = { pattern: match[0], scene, place: "" };
	}
	for (const match of text.matchAll(SCENE_REF_PATTERN)) {
		const rawName = match[1] || match[3] || "";
		if (!rawName || rawName === "场景" || /[:：]/.test(rawName)) continue;
		const scene = findLibraryItem(scenes, rawName) || { id: rawName, name: rawName, annotations: [] };
		const place = match[2] || match[4] || "";
		const icon = addUniqueReferenceIcon(icons, "scene", scene.name || scene.id || rawName, sceneCoverUrl(scene), "🏞");
		if (icon) icon.source = { pattern: match[0], scene, place };
	}
	for (const match of text.matchAll(CHARACTER_REF_PATTERN)) {
		const [name, suffixView] = splitCharacterViewSuffix(match[1] || "", characters);
		const character = findExactLibraryItem(characters, name);
		if (character) {
			const icon = addUniqueReferenceIcon(icons, "character", character.name || character.id || name, characterCoverUrl(character), "👤");
			if (icon) icon.source = { pattern: match[0], character, view: match[2] || suffixView || "" };
			continue;
		}
		const costume = findLibraryItem(costumes, match[1] || "");
		if (costume) addUniqueReferenceIcon(icons, "costume", costume.name || costume.id || match[1], itemCoverUrl(costume), costume.category === "product" ? "📦" : (costume.category === "prop" ? "🎒" : "👗"));
	}
	for (const match of text.matchAll(COSTUME_REF_PATTERN)) {
		const rawName = match[1] || match[2] || "";
		const costume = findLibraryItem(costumes, rawName);
		if (costume) addUniqueReferenceIcon(icons, "costume", costume.name || costume.id || rawName, itemCoverUrl(costume), costume.category === "product" ? "📦" : (costume.category === "prop" ? "🎒" : "👗"));
	}
	return icons.slice(0, 5);
}

function referenceIconImage(node, url) {
	if (!url) return null;
	node.__gjjStoryboardReferenceIconImages ||= new Map();
	const cache = node.__gjjStoryboardReferenceIconImages;
	if (cache.has(url)) return cache.get(url);
	const image = new Image();
	image.crossOrigin = "anonymous";
	image.loading = "eager";
	image.fetchPriority = "high";
	image.decoding = "sync";
	image.onload = () => drawPromptGridPreview(node);
	image.onerror = () => drawPromptGridPreview(node);
	const kind = String(url).includes("/scene_library/") ? "scene" : "character";
	const id = decodeURIComponent(String(url).split("/").pop()?.replace(/\.(?:png|jpg)(?:\?.*)?$/i, "") || "");
	void loadGjjLibraryThumbnailBlobUrl(api, kind, id).then((blobUrl) => {
		image.src = blobUrl || url;
	});
	cache.set(url, image);
	return image;
}

function drawReferenceIcons(ctx, node, icons, left, top, width, height) {
	if (!icons.length) return;
	const size = Math.max(18, Math.min(26, Math.floor(Math.min(width, height) / 5)));
	const gap = 4;
	let x = left + gap;
	const y = top + gap;
	for (const icon of icons) {
		if (x + size > left + width - gap) break;
		node.__gjjStoryboardReferenceIconRects ||= [];
		node.__gjjStoryboardReferenceIconRects.push({ left: x, top: y, right: x + size, bottom: y + size, icon });
		ctx.save();
		ctx.fillStyle = "rgba(0,0,0,.52)";
		ctx.strokeStyle = icon.kind === "scene" ? "rgba(56,189,248,.9)" : (icon.kind === "character" ? "rgba(250,204,21,.9)" : "rgba(167,139,250,.9)");
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.roundRect?.(x, y, size, size, 5);
		if (!ctx.roundRect) ctx.rect(x, y, size, size);
		ctx.fill();
		ctx.stroke();
		const image = referenceIconImage(node, icon.url);
		if (image?.complete && image.naturalWidth > 0) {
			drawImageCover(ctx, image, x + 2, y + 2, size - 4, size - 4, 1);
		} else {
			ctx.fillStyle = "rgba(255,255,255,.92)";
			ctx.font = `${Math.max(12, size - 8)}px sans-serif`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillText(icon.fallback || "✓", x + size / 2, y + size / 2 + 0.5);
		}
		ctx.restore();
		x += size + gap;
	}
}

function storyboardReferenceIconHit(node, event) {
	const canvas = node?.__gjjStoryboardGridCanvas;
	const rect = canvas?.getBoundingClientRect?.();
	if (!canvas || !rect) return null;
	const x = (event.clientX - rect.left) * (canvas.width / Math.max(1, rect.width));
	const y = (event.clientY - rect.top) * (canvas.height / Math.max(1, rect.height));
	return (node.__gjjStoryboardReferenceIconRects || []).find((item) => x >= item.left && x <= item.right && y >= item.top && y <= item.bottom) || null;
}

function drawPromptOverlay(ctx, text, left, top, width, height) {
	const pad = Math.max(5, Math.min(9, Math.floor(Math.min(width, height) / 18)));
	const fontSize = Math.max(10, Math.min(13, Math.floor(height / 8)));
	ctx.save();
	ctx.font = `700 ${fontSize}px sans-serif`;
	const lines = wrapCanvasText(ctx, text, Math.max(24, width - pad * 2), 2);
	if (!lines.length) {
		ctx.restore();
		return;
	}
	const lineH = Math.round(fontSize * 1.28);
	const boxH = pad * 2 + lineH * lines.length;
	const y = Math.max(top, top + height - boxH);
	ctx.fillStyle = "rgba(0, 0, 0, .46)";
	ctx.fillRect(left, y, width, boxH);
	ctx.fillStyle = "rgba(255, 255, 255, .88)";
	ctx.textBaseline = "top";
	for (let index = 0; index < lines.length; index += 1) {
		ctx.fillText(lines[index], left + pad, y + pad + index * lineH);
	}
	ctx.restore();
}

function updateSelectedPreviewImage(node) {
	const image = node?.__gjjStoryboardPreviewImage;
	if (!image) return;
	const selected = selectedCellIndex(node);
	const url = node.__gjjStoryboardCellPreviewUrls?.[selected] || "";
	if (!url) {
		image.removeAttribute("src");
		image.removeAttribute("data-gjj-storyboard-cell");
		image.style.display = "none";
		return;
	}
	if ((image.getAttribute("src") || "") !== url) image.src = url;
	image.dataset.gjjStoryboardCell = String(selected + 1);
	image.title = `宫格 ${selected + 1} · 点击查看原图 · 可拖到空白画布或任意对象预览器`;
	image.style.display = "block";
}

function replaceCurrentCellReference(node, icon, nextText) {
	if (!icon?.source?.pattern || !nextText) return;
	const parts = parsePromptParts(getWidget(node, "prompt")?.value || "");
	const index = selectedCellIndex(node);
	if (!parts[index]) return;
	if (icon.kind === "character" && icon.source?.character) {
		let replaced = false;
		const target = icon.source.character;
		parts[index] = parts[index].replace(CHARACTER_REF_PATTERN, (match, rawName) => {
			const rawText = String(rawName || "");
			const [name] = splitCharacterViewSuffix(rawText);
			const character = findExactLibraryItem(globalThis.GJJ_CharacterLibrary?.characters || [], name);
			if (character !== target) return match;
			if (replaced) return "";
			replaced = true;
			const suffix = refKey(rawText).startsWith(refKey(name))
				? rawText.slice(String(name || "").length)
				: "";
			return `${nextText}${suffix}`;
		}).replace(/[ \t]{2,}/g, " ").replace(/\s+([,，.。;；!！?？])/g, "$1").trim();
		if (!replaced) parts[index] = parts[index].replace(icon.source.pattern, nextText);
	} else {
		parts[index] = parts[index].replace(icon.source.pattern, nextText);
	}
	setWidgetValue(getWidget(node, "prompt"), serializePromptParts(parts));
	saveParamValues(node);
	drawPromptGridPreview(node);
}

function closeReferencePicker(node) {
	const popup = node?.__gjjStoryboardReferencePicker;
	if (!popup) return;
	popup.cleanup?.();
	popup.root?.remove();
	node.__gjjStoryboardReferencePicker = null;
}

function referenceOptionPreviewUrl(option) {
	return option.url ? apiMediaUrl(option.url) : "";
}

function characterViewReference(character, view) {
	const name = characterReferenceName(character, character?.id);
	const label = String(view?.label || view?.id || "").trim();
	return label ? `@${name}/${label}` : `@${name}`;
}

function sceneViewReference(scene, mark = null) {
	const name = String(scene?.name || scene?.id || "").trim();
	const keyword = String(mark?.keyword || "").trim();
	return keyword ? `🏕️${name}/${keyword}` : `🏕️${name}`;
}

function referencePickerOptions(icon) {
	if (icon.kind === "character") {
		const character = icon.source?.character;
		const views = Array.isArray(character?.views) ? character.views : [];
		const explicitView = refKey(icon.source?.view || "");
		const options = views.map((view) => {
			const label = String(view?.label || view?.id || "视图").trim();
			const value = characterViewReference(character, view);
			const labelKey = refKey(label);
			return {
				label,
				url: view.url || character.cover || "",
				value,
				selected: (explicitView && labelKey === explicitView) || refKey(value) === refKey(icon.source?.pattern || ""),
			};
		});
		if (options.length && !options.some((option) => option.selected)) options[0].selected = true;
		return options;
	}
	if (icon.kind === "scene") {
		const scene = icon.source?.scene;
		const cover = sceneCoverUrl(scene);
		const options = [{ label: "整个场景", url: cover, value: sceneViewReference(scene) }];
		for (const mark of scene?.annotations || []) {
			options.push({ label: mark.keyword || "标注点", url: cover, value: sceneViewReference(scene, mark) });
		}
		return options;
	}
	return [];
}

function selectedReferenceValues(options) {
	return (options || []).filter((option) => option?.selected).map((option) => option.value).filter(Boolean);
}

function openReferencePicker(node, icon, event) {
	closeReferencePicker(node);
	const options = referencePickerOptions(icon);
	if (!options.length) return;
	const isMulti = icon.kind === "character";
	const root = document.createElement("div");
	root.style.cssText = [
		"position:fixed",
		"z-index:100000",
		`width:${isMulti ? 270 : 240}px`,
		"max-height:360px",
		"overflow:auto",
		"box-sizing:border-box",
		"padding:6px",
		"border:1px solid #3b5560",
		"border-radius:7px",
		"background:#071014",
		"box-shadow:0 12px 36px rgba(0,0,0,.45)",
		"display:flex",
		"flex-direction:column",
		"gap:4px",
	].join(";");
	const popupWidth = isMulti ? 278 : 248;
	const left = Math.max(8, Math.min(event.clientX + 8, window.innerWidth - popupWidth));
	const top = Math.max(8, Math.min(event.clientY + 8, window.innerHeight - 368));
	root.style.left = `${left}px`;
	root.style.top = `${top}px`;
	let hoverPreview = null;
	const closeHoverPreview = () => {
		hoverPreview?.remove();
		hoverPreview = null;
	};
	const positionHoverPreview = (pointerEvent) => {
		if (!hoverPreview) return;
		const width = Number(hoverPreview.__gjjPreviewWidth || 220);
		const height = Number(hoverPreview.__gjjPreviewHeight || 300);
		const x = Math.max(8, Math.min((pointerEvent?.clientX ?? left) + 14, window.innerWidth - width - 8));
		const y = Math.max(8, Math.min((pointerEvent?.clientY ?? top) + 14, window.innerHeight - height - 8));
		hoverPreview.style.left = `${x}px`;
		hoverPreview.style.top = `${y}px`;
	};
	const openHoverPreview = (option, pointerEvent) => {
		const url = referenceOptionPreviewUrl(option);
		if (!url) return;
		closeHoverPreview();
		const wrap = document.createElement("div");
		wrap.style.cssText = [
			"position:fixed",
			"z-index:100001",
			"width:220px",
			"max-width:min(260px, 38vw)",
			"max-height:min(360px, 58vh)",
			"padding:6px",
			"border:1px solid #4d6a73",
			"border-radius:7px",
			"background:#071014",
			"box-shadow:0 14px 38px rgba(0,0,0,.5)",
			"pointer-events:none",
			"box-sizing:border-box",
		].join(";");
		const img = document.createElement("img");
		img.src = url;
		img.alt = option.label || "preview";
		img.style.cssText = "display:block;width:100%;height:auto;max-height:330px;object-fit:contain;border-radius:5px;background:#0b1519;";
		const caption = document.createElement("div");
		caption.textContent = option.label || "";
		caption.style.cssText = "padding-top:5px;color:#dce7e2;font:700 12px/1.3 sans-serif;white-space:normal;word-break:break-word;";
		wrap.append(img, caption);
		document.body.append(wrap);
		hoverPreview = wrap;
		requestAnimationFrame(() => {
			const rect = wrap.getBoundingClientRect();
			wrap.__gjjPreviewWidth = rect.width || 220;
			wrap.__gjjPreviewHeight = rect.height || 300;
			positionHoverPreview(pointerEvent);
		});
		positionHoverPreview(pointerEvent);
	};
	const refreshRows = () => {
		for (const row of root.querySelectorAll("[data-gjj-ref-option]")) {
			const index = Number(row.dataset.gjjRefOption || 0);
			const option = options[index];
			const active = Boolean(option?.selected);
			row.style.background = active ? "#1b3a32" : "#142329";
			row.style.borderColor = active ? "#65d189" : "#253941";
			const check = row.querySelector("[data-gjj-ref-check]");
			if (check) check.textContent = active ? "✓" : "";
		}
	};
	if (isMulti) {
		const head = document.createElement("div");
		head.style.cssText = "display:flex;align-items:center;gap:6px;color:#b8c7cf;font:700 12px/1.3 sans-serif;padding:1px 2px 4px;";
		const title = document.createElement("div");
		title.textContent = "选择角色视图";
		title.title = "默认单选；按住 Ctrl 或 Alt 点击可多选，再点确定应用。";
		title.style.cssText = "flex:1 1 auto;";
		const apply = document.createElement("button");
		apply.type = "button";
		apply.textContent = "确定";
		apply.title = "应用当前勾选的多个视图；普通点击选项会直接单选应用。";
		apply.style.cssText = "height:24px;border:1px solid #4f8f6f;border-radius:5px;background:#1d5d39;color:#fff;font:700 12px sans-serif;cursor:pointer;padding:0 8px;";
		apply.addEventListener("click", (clickEvent) => {
			clickEvent.preventDefault();
			clickEvent.stopPropagation();
			const values = selectedReferenceValues(options);
			if (values.length) replaceCurrentCellReference(node, icon, values.join(" "));
			closeReferencePicker(node);
		});
		head.append(title, apply);
		root.append(head);
	}
	for (const option of options) {
		const optionIndex = options.indexOf(option);
		const button = document.createElement("button");
		button.type = "button";
		button.dataset.gjjRefOption = String(optionIndex);
		button.style.cssText = [
			"display:grid",
			`grid-template-columns:34px 1fr${isMulti ? " 20px" : ""}`,
			"align-items:center",
			"gap:7px",
			"width:100%",
			"min-height:38px",
			"border:1px solid #253941",
			"border-radius:5px",
			"background:#142329",
			"color:#dce7e2",
			"text-align:left",
			"padding:4px",
			"cursor:pointer",
			"font:12px/1.25 sans-serif",
		].join(";");
		const preview = document.createElement("div");
		preview.style.cssText = "width:32px;height:32px;border-radius:4px;background:#0b1519;overflow:hidden;display:flex;align-items:center;justify-content:center;";
		const url = referenceOptionPreviewUrl(option);
		if (url) {
			const img = document.createElement("img");
			img.src = url;
			img.style.cssText = "width:100%;height:100%;object-fit:cover;";
			preview.append(img);
		} else {
			preview.textContent = icon.fallback || "✓";
		}
		const label = document.createElement("div");
		label.textContent = option.label || option.value;
		label.style.cssText = "min-width:0;white-space:normal;word-break:break-word;";
		button.append(preview, label);
		if (isMulti) {
			const check = document.createElement("div");
			check.dataset.gjjRefCheck = "1";
			check.style.cssText = "width:18px;height:18px;border:1px solid #54717a;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#d9ffe8;font:900 13px sans-serif;";
			button.append(check);
		}
		button.addEventListener("mouseenter", (hoverEvent) => {
			if (!isMulti || !option.selected) button.style.background = "#20333b";
			openHoverPreview(option, hoverEvent);
		});
		button.addEventListener("mousemove", positionHoverPreview);
		button.addEventListener("mouseleave", () => {
			closeHoverPreview();
			refreshRows();
		});
		button.addEventListener("click", (clickEvent) => {
			clickEvent.preventDefault();
			clickEvent.stopPropagation();
			if (isMulti && (clickEvent.ctrlKey || clickEvent.altKey)) {
				option.selected = !option.selected;
				if (!selectedReferenceValues(options).length) option.selected = true;
				refreshRows();
			} else {
				replaceCurrentCellReference(node, icon, option.value);
				closeReferencePicker(node);
			}
		});
		root.append(button);
	}
	refreshRows();
	const stop = (popupEvent) => popupEvent.stopPropagation();
	for (const name of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) root.addEventListener(name, stop);
	document.body.append(root);
	const onPointerDown = (docEvent) => {
		if (!root.contains(docEvent.target)) closeReferencePicker(node);
	};
	const onKeyDown = (docEvent) => {
		if (docEvent.key === "Escape") closeReferencePicker(node);
	};
	const timer = setTimeout(() => document.addEventListener("pointerdown", onPointerDown, true), 0);
	document.addEventListener("keydown", onKeyDown, true);
	node.__gjjStoryboardReferencePicker = {
		root,
		cleanup: () => {
			closeHoverPreview();
			clearTimeout(timer);
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown, true);
		},
	};
}

function drawImageCover(ctx, image, left, top, width, height, bleedScale = 1) {
	const sourceW = Math.max(1, image.naturalWidth || image.width || 1);
	const sourceH = Math.max(1, image.naturalHeight || image.height || 1);
	const scale = Math.max(width / sourceW, height / sourceH) * Math.max(1, Number(bleedScale) || 1);
	const drawW = sourceW * scale;
	const drawH = sourceH * scale;
	const drawX = left + (width - drawW) / 2;
	const drawY = top + (height - drawH) / 2;
	ctx.save();
	ctx.beginPath();
	ctx.rect(left, top, width, height);
	ctx.clip();
	ctx.drawImage(image, drawX, drawY, drawW, drawH);
	ctx.restore();
}

function drawPromptGridPreview(node) {
	const canvas = node?.__gjjStoryboardGridCanvas;
	if (!canvas) return;
	const parts = parsePromptParts(currentPromptText(node));
	const count = Math.max(1, parts.length, Number(node.__gjjStoryboardActualPromptTotal || 0));
	const outputW = Math.max(320, Number(node.size?.[0] || 520) - 24);
	const targetW = Math.max(64, Number(getWidget(node, "width")?.value || 1024) || 1024);
	const targetH = Math.max(64, Number(getWidget(node, "height")?.value || 1024) || 1024);
	const gap = Math.max(0, Number(getWidget(node, "gap")?.value || 8) || 0);
	const layoutProbe = storyboardGridGeometry(count, 1000, 1000);
	const finalAspect = Math.max(
		0.15,
		((targetW * layoutProbe.cols) + gap * (layoutProbe.cols + 1)) / Math.max(1, (targetH * layoutProbe.rows) + gap * (layoutProbe.rows + 1)),
	);
	const outputH = Math.max(150, Math.round(outputW / finalAspect));
	if (canvas.width !== outputW || canvas.height !== outputH) {
		canvas.width = outputW;
		canvas.height = outputH;
	}
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#05080a";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	const { rects } = storyboardGridGeometry(count, canvas.width, canvas.height);
	node.__gjjStoryboardGridRects = rects;
	node.__gjjStoryboardReferenceIconRects = [];
	const selected = selectedCellIndex(node);
	const selectedSet = new Set(selectedCellIndices(node));
	for (const rect of rects) {
		const width = rect.right - rect.left;
		const height = rect.bottom - rect.top;
		const isSelected = selectedSet.has(rect.index);
		ctx.fillStyle = "#e8efec";
		ctx.fillRect(rect.left + 2, rect.top + 2, Math.max(1, width - 4), Math.max(1, height - 4));
		ctx.strokeStyle = isSelected ? "#38bdf8" : "#000000";
		ctx.lineWidth = isSelected ? 3 : 2;
		ctx.strokeRect(rect.left + 1, rect.top + 1, Math.max(1, width - 2), Math.max(1, height - 2));
	}
	const previewUrls = node.__gjjStoryboardCellPreviewUrls || [];
	for (const rect of rects) {
		const url = previewUrls[rect.index];
		if (!url) continue;
		const cached = node.__gjjStoryboardCellPreviewImages?.[rect.index];
		if (cached?.complete && cached.naturalWidth > 0) {
			drawImageCover(ctx, cached, rect.left + 2, rect.top + 2, Math.max(1, rect.right - rect.left - 4), Math.max(1, rect.bottom - rect.top - 4), 1.05);
		}
	}
	for (const rect of rects) {
		const text = parts[rect.index] ?? `宫格 ${rect.index + 1}`;
		const icons = promptReferenceIcons(text, node).map((icon) => ({ ...icon, cellIndex: rect.index }));
		drawReferenceIcons(
			ctx,
			node,
			icons,
			rect.left + 2,
			rect.top + 2,
			Math.max(1, rect.right - rect.left - 4),
			Math.max(1, rect.bottom - rect.top - 4),
		);
		drawPromptOverlay(ctx, text, rect.left + 2, rect.top + 2, Math.max(1, rect.right - rect.left - 4), Math.max(1, rect.bottom - rect.top - 4));
	}
	for (const rect of rects) {
		const isSelected = selectedSet.has(rect.index);
		ctx.strokeStyle = isSelected ? "#38bdf8" : "#000000";
		ctx.lineWidth = isSelected ? 3 : 2;
		ctx.strokeRect(rect.left + 1, rect.top + 1, Math.max(1, rect.right - rect.left - 2), Math.max(1, rect.bottom - rect.top - 2));
		if (isSelected && rect.index !== selected) {
			ctx.fillStyle = "rgba(56,189,248,.9)";
			ctx.beginPath();
			ctx.arc(rect.right - 14, rect.top + 14, 7, 0, Math.PI * 2);
			ctx.fill();
		}
	}
	updateSelectedPreviewImage(node);
	const status = node.__gjjStoryboardPreviewStatus;
	if (status) {
		const selectedText = selectedSet.size > 1
			? [...selectedSet].map((value) => value + 1).join("、")
			: `${selected + 1}`;
		status.textContent = `预览 ${count} 个等宽等高宫格 · Ctrl/Shift 多选 · 当前 ${selectedText}`;
	}
	GJJ_Utils.refreshNode?.(node);
}

function storyboardCellHit(node, event) {
	const canvas = node?.__gjjStoryboardGridCanvas;
	const rect = canvas?.getBoundingClientRect?.();
	if (!canvas || !rect) return -1;
	const x = (event.clientX - rect.left) * (canvas.width / Math.max(1, rect.width));
	const y = (event.clientY - rect.top) * (canvas.height / Math.max(1, rect.height));
	const hit = (node.__gjjStoryboardGridRects || []).find((item) => x >= item.left && x <= item.right && y >= item.top && y <= item.bottom);
	return hit ? hit.index : -1;
}

function editStoryboardCellPrompt(node, index) {
	const linkedSource = linkedPromptSource(node);
	const effectivePrompt = currentPromptText(node);
	const parts = parsePromptParts(effectivePrompt);
	while (parts.length <= index) parts.push("");
	const sourceNode = linkedSource?.node || null;
	const sourceType = String(sourceNode?.comfyClass || sourceNode?.type || "");
	const sourceHasUpstream = sourceNode?.inputs?.some((input) => input?.link != null) || false;
	const sourceWidget = sourceType === "GJJ_TextInput" && !sourceHasUpstream
		? sourceNode?.widgets?.find((widget) => widget?.name === "text")
		: null;
	const editable = !linkedSource || Boolean(sourceWidget);
	const overlay = document.createElement("div");
	overlay.style.cssText = "position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.38);";
	const box = document.createElement("div");
	box.style.cssText = "width:min(560px,calc(100vw - 32px));background:#0c1215;border:1px solid #34444b;border-radius:8px;padding:10px;box-shadow:0 18px 48px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:8px;";
	const title = document.createElement("div");
	title.textContent = linkedSource
		? `宫格 ${index + 1} 提示词 · ${editable ? "编辑上游文本" : "上游输出只读"}`
		: `宫格 ${index + 1} 提示词`;
	title.style.cssText = "color:#e8f1ed;font:700 13px sans-serif;";
	const area = document.createElement("textarea");
	area.value = parts[index] || "";
	const initialEditorValue = area.value;
	area.readOnly = !editable;
	area.style.cssText = "min-height:150px;resize:vertical;background:#111a1f;color:#e8f1ed;border:1px solid #34444b;border-radius:6px;padding:8px;font:13px/1.35 sans-serif;outline:none;";
	const actions = document.createElement("div");
	actions.style.cssText = "display:flex;justify-content:flex-end;gap:6px;";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.textContent = "取消";
	const save = document.createElement("button");
	save.type = "button";
	save.textContent = "保存";
	for (const btn of [cancel, save]) {
		btn.style.cssText = "height:28px;border:1px solid #38464d;border-radius:6px;background:#121a1f;color:#eef7f2;padding:0 12px;cursor:pointer;";
	}
	cancel.onclick = () => overlay.remove();
	if (!editable) {
		save.disabled = true;
		save.style.opacity = "0.45";
		save.style.cursor = "not-allowed";
	}
	save.onclick = () => {
		if (!editable) return;
		if (area.value === initialEditorValue) {
			overlay.remove();
			return;
		}
		parts[index] = area.value.trim();
		const serialized = serializePromptParts(parts);
		if (sourceWidget) {
			setWidgetValue(sourceWidget, serialized);
			sourceNode?.graph?.change?.();
			sourceNode?.setDirtyCanvas?.(true, true);
		} else {
			setWidgetValue(getWidget(node, "prompt"), serialized);
			saveParamValues(node);
		}
		reconcilePreviewForPromptChange(node, serialized);
		void resolvePromptCharacters(node, serialized);
		drawPromptGridPreview(node);
		overlay.remove();
	};
	actions.append(cancel, save);
	box.append(title, area, actions);
	overlay.appendChild(box);
	overlay.addEventListener("pointerdown", (event) => {
		event.stopPropagation();
		if (event.target === overlay) overlay.remove();
	});
	document.body.appendChild(overlay);
	setTimeout(() => area.focus(), 0);
}

function previewImageUrl(item, useThumbnail = false, cacheBust = "") {
	if (!item?.filename && !item?.original_filename) return "";
	const target = useThumbnail ? gjjTempImagePreviewItem(item) : gjjTempImageOriginalItem(item);
	const filename = String(target?.filename || "");
	const type = String(target?.type || "temp");
	const subfolder = String(target?.subfolder || "");
	const bust = cacheBust ? `&gjj_repair=${encodeURIComponent(cacheBust)}` : "";
	const path = `/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}${bust}`;
	return api?.apiURL ? api.apiURL(path) : path;
}

function preloadStoryboardFullImage(item) {
	const url = previewImageUrl(item, false);
	return preloadGjjFullImage(url, "high");
}

function openStoryboardFullImage(item, cellNumber = 1) {
	const originalUrl = previewImageUrl(item, false);
	if (!originalUrl) return;
	const thumbnailUrl = previewImageUrl(item, true);
	const displayNumber = Math.max(1, Number(cellNumber) || 1);
	const overlay = document.createElement("div");
	overlay.style.cssText = [
		"position:fixed",
		"inset:0",
		"z-index:100000",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"overflow:hidden",
		"background:rgba(0,0,0,.92)",
		"backdrop-filter:blur(8px)",
		"cursor:zoom-out",
	].join(";");

	const image = document.createElement("img");
	image.alt = `宫格 ${displayNumber} 原图`;
	image.dataset.gjjStoryboardFullTarget = originalUrl;
	image.style.cssText = [
		"max-width:94vw",
		"max-height:94vh",
		"object-fit:contain",
		"border-radius:8px",
		"box-shadow:0 14px 48px rgba(0,0,0,.55)",
		"transform-origin:center center",
		"transition:transform .08s ease",
		"cursor:grab",
	].join(";");
	image.src = thumbnailUrl || originalUrl;
	bindGjjMediaDrag(image, () => item);

	const hint = document.createElement("div");
	hint.style.cssText = [
		"position:absolute",
		"left:50%",
		"bottom:18px",
		"transform:translateX(-50%)",
		"padding:5px 10px",
		"border-radius:999px",
		"background:rgba(0,0,0,.55)",
		"color:#fff",
		"font:12px/1.3 system-ui,'Microsoft YaHei',sans-serif",
		"white-space:nowrap",
		"pointer-events:none",
	].join(";");
	hint.textContent = `宫格 ${displayNumber} · 正在载入原图…`;

	let scale = 1;
	const applyScale = () => {
		image.style.transform = `scale(${scale})`;
		if (image.dataset.gjjStoryboardFullReady === "true") {
			hint.textContent = scale === 1
				? `宫格 ${displayNumber} · 原图 · 滚轮缩放 · 点击关闭`
				: `宫格 ${displayNumber} · 原图缩放 ${Math.round(scale * 100)}% · 点击关闭`;
		}
	};
	image.addEventListener("load", () => {
		if (image.dataset.gjjStoryboardLoadingOriginal !== "true") return;
		if (image.getAttribute("src") !== originalUrl) return;
		delete image.dataset.gjjStoryboardLoadingOriginal;
		image.dataset.gjjStoryboardFullReady = "true";
		applyScale();
	});
	image.addEventListener("error", () => {
		if (image.dataset.gjjStoryboardLoadingOriginal !== "true") return;
		delete image.dataset.gjjStoryboardLoadingOriginal;
		hint.textContent = `宫格 ${displayNumber} · 原图载入失败`;
		if (thumbnailUrl && thumbnailUrl !== originalUrl) image.src = thumbnailUrl;
	});
	overlay.addEventListener("wheel", (event) => {
		event.preventDefault();
		event.stopPropagation();
		scale = Math.max(0.1, Math.min(10, scale * (event.deltaY > 0 ? 0.9 : 1.1)));
		applyScale();
	}, { passive: false });
	const close = () => {
		document.removeEventListener("keydown", onKeyDown, true);
		overlay.remove();
	};
	const onKeyDown = (event) => {
		if (event.key === "Escape") close();
	};
	overlay.addEventListener("click", close);
	image.addEventListener("click", close);
	document.addEventListener("keydown", onKeyDown, true);
	overlay.append(image, hint);
	document.body.appendChild(overlay);
	const revealOriginal = () => {
		if (!image.isConnected || image.dataset.gjjStoryboardFullTarget !== originalUrl) return;
		image.dataset.gjjStoryboardLoadingOriginal = "true";
		image.src = originalUrl;
	};
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(revealOriginal);
	else setTimeout(revealOriginal, 0);
	void preloadStoryboardFullImage(item).then((entry) => {
		if (!image.isConnected || image.dataset.gjjStoryboardFullTarget !== originalUrl) return;
		if (!entry) {
			if (image.dataset.gjjStoryboardFullReady !== "true") {
				hint.textContent = `宫格 ${displayNumber} · 原图载入失败 · 点击关闭`;
			}
			return;
		}
		delete image.dataset.gjjStoryboardLoadingOriginal;
		image.dataset.gjjStoryboardFullReady = "true";
		if (image.getAttribute("src") !== originalUrl) image.src = originalUrl;
		applyScale();
	});
}

function loadStoryboardPreviewImage(item) {
	return new Promise(async (resolve) => {
		if (!item?.filename) {
			resolve(null);
			return;
		}
		const image = new Image();
		image.loading = "eager";
		image.fetchPriority = "high";
		image.decoding = "sync";
		const originalUrl = previewImageUrl(item, false);
		const thumbnailUrl = previewImageUrl(item, true);
		let usingOriginal = !thumbnailUrl || thumbnailUrl === originalUrl;
		let repairAttempted = false;
		image.onload = () => resolve({ item, image, url: image.src });
		image.onerror = () => {
			if (!usingOriginal && !repairAttempted) {
				repairAttempted = true;
				void ensureGjjTempImagePreview(api, item).then((repaired) => {
					if (repaired) image.src = previewImageUrl({ ...item, ...repaired }, true, Date.now());
					else {
						usingOriginal = true;
						image.src = originalUrl;
					}
				});
				return;
			}
			if (!usingOriginal && originalUrl) {
				usingOriginal = true;
				image.src = originalUrl;
				return;
			}
			resolve(null);
		};
		const requestedUrl = thumbnailUrl || originalUrl;
		const blobUrl = await loadGjjPreviewBlobUrl(requestedUrl);
		image.src = blobUrl || requestedUrl;
	});
}

function storyboardPreviewImageItems(node) {
	const tableItems = parseGridCells(node?.properties?.[GRID_CELLS_PROPERTY])
		.filter((cell) => cell.image?.filename)
		.map((cell) => ({ index: cell.index, ...normalizedCellImage(cell.image) }));
	if (tableItems.length) return tableItems;
	const items = node?.__gjjStoryboardCellPreviewItems || [];
	const fromItems = items
		.map((item, index) => {
			const original = gjjTempImageOriginalItem(item);
			const preview = gjjTempImagePreviewItem(item);
			return {
				index: index + 1,
				filename: String(item?.filename || ""),
				subfolder: String(item?.subfolder || ""),
				type: String(item?.type || "temp"),
				preview_filename: String(item?.preview_filename || preview?.filename || ""),
				preview_subfolder: String(item?.preview_subfolder ?? preview?.subfolder ?? item?.subfolder ?? ""),
				preview_type: String(item?.preview_type || preview?.type || item?.type || "temp"),
				preview_width: Number(item?.preview_width || 0),
				preview_height: Number(item?.preview_height || 0),
				original_filename: String(original?.filename || item?.filename || ""),
				original_subfolder: String(original?.subfolder ?? item?.subfolder ?? ""),
				original_type: String(original?.type || item?.type || "temp"),
				cache_signature: String(item?.cache_signature || ""),
			};
		})
		.filter((item) => item.filename);
	if (fromItems.length) return fromItems;
	const urls = node?.__gjjStoryboardCellPreviewUrls || [];
	return urls.map((url, index) => {
		try {
			const parsed = new URL(String(url || ""), window.location.href);
			return {
				index: index + 1,
				filename: parsed.searchParams.get("filename") || "",
				subfolder: parsed.searchParams.get("subfolder") || "",
				type: parsed.searchParams.get("type") || "temp",
				preview_filename: "",
				original_filename: "",
				original_subfolder: "",
				original_type: "temp",
				cache_signature: "",
			};
		} catch (_) {
			return { index: index + 1, filename: "", subfolder: "", type: "temp" };
		}
	}).filter((item) => item.filename);
}

function parseStoryboardPreviewImageItems(value) {
	if (Array.isArray(value)) return value;
	try {
		const parsed = JSON.parse(String(value || "[]"));
		return Array.isArray(parsed) ? parsed : [];
	} catch (_) {
		return [];
	}
}

function promptCellReferences(promptText) {
	const text = String(promptText || "");
	const characters = [];
	const scenes = [];
	const add = (target, value) => {
		const normalized = String(value || "").trim();
		if (normalized && !target.includes(normalized)) target.push(normalized);
	};
	const characterItems = storyboardCharacterItems(null);
	for (const match of text.matchAll(CHARACTER_REF_PATTERN)) {
		const [name] = splitCharacterViewSuffix(match[1], characterItems);
		add(characters, name || match[1]);
	}
	for (const match of text.matchAll(SCENE_REF_PATTERN)) add(scenes, match[1] || match[3]);
	return { characters, scenes };
}

function normalizedCellImage(item) {
	if (!item?.filename) return null;
	const original = gjjTempImageOriginalItem(item);
	const preview = gjjTempImagePreviewItem(item);
	return {
		filename: String(item.filename || ""),
		subfolder: String(item.subfolder || ""),
		type: String(item.type || "temp"),
		original_filename: String(original?.filename || item.filename || ""),
		original_subfolder: String(original?.subfolder ?? item.subfolder ?? ""),
		original_type: String(original?.type || item.type || "temp"),
		preview_filename: String(item.preview_filename || preview?.filename || ""),
		preview_subfolder: String(item.preview_subfolder ?? preview?.subfolder ?? item.subfolder ?? ""),
		preview_type: String(item.preview_type || preview?.type || item.type || "temp"),
		preview_width: Number(item.preview_width || 0),
		preview_height: Number(item.preview_height || 0),
		cache_signature: String(item.cache_signature || ""),
	};
}

function parseGridCells(value) {
	let cells = value;
	if (!Array.isArray(cells)) {
		try { cells = JSON.parse(String(value || "[]")); } catch (_) { cells = []; }
	}
	return Array.isArray(cells) ? cells.filter((cell) => cell && Number(cell.index) > 0) : [];
}

function cellSeed(node, index) {
	const base = intValue(node?.__gjjStoryboardPreparedSeed ?? getWidget(node, "seed")?.value, 0, 0, JS_SAFE_MAX_SEED_VALUE);
	return Math.min(JS_SAFE_MAX_SEED_VALUE, base + Math.max(0, Number(index) - 1));
}

function storyboardGridCells(node, promptText = currentPromptText(node), legacyImages = null) {
	node.properties ||= {};
	const parts = parsePromptParts(promptText);
	const existing = parseGridCells(node.properties[GRID_CELLS_PROPERTY]);
	const legacy = legacyImages || parseStoryboardPreviewImageItems(node.properties[CACHED_PREVIEW_IMAGES_PROPERTY]);
	const cells = parts.map((prompt, offset) => {
		const index = offset + 1;
		const previous = existing.find((cell) => Number(cell.index) === index) || {};
		const refs = promptCellReferences(prompt);
		return {
			index,
			prompt: String(prompt || ""),
			seed: Number.isFinite(Number(previous.seed)) ? Number(previous.seed) : cellSeed(node, index),
			characters: refs.characters,
			scenes: refs.scenes,
			image: normalizedCellImage(previous.image || legacy.find((item) => Number(item.index) === index)),
		};
	});
	node.properties[GRID_CELLS_PROPERTY] = cells;
	return cells;
}

function saveGridCells(node, cells, markDirty = false) {
	node.properties ||= {};
	const normalized = parseGridCells(cells).map((cell) => ({ ...cell, image: normalizedCellImage(cell.image) }));
	node.properties[GRID_CELLS_PROPERTY] = normalized;
	const images = normalized.filter((cell) => cell.image?.filename).map((cell) => ({ index: cell.index, ...cell.image }));
	if (images.length) node.properties[CACHED_PREVIEW_IMAGES_PROPERTY] = images;
	else delete node.properties[CACHED_PREVIEW_IMAGES_PROPERTY];
	const cacheWidget = getWidget(node, PREVIEW_IMAGES_INPUT);
	if (cacheWidget) cacheWidget.value = JSON.stringify(images);
	if (markDirty) {
		node.graph?.change?.();
		node.setDirtyCanvas?.(true, true);
	}
	return normalized;
}

function clearGridCellsFrom(node, startIndex, promptText = currentPromptText(node)) {
	const cells = storyboardGridCells(node, promptText);
	const start = Math.max(1, Number(startIndex) || 1);
	for (const cell of cells) {
		if (cell.index >= start) cell.image = null;
	}
	saveGridCells(node, cells, true);
	return cells;
}

function recoverGridImagesFromWorkflow(node, expectedCount) {
	const graph = node?.graph || app.graph;
	for (const candidate of graph?._nodes || []) {
		if (candidate === node) continue;
		const held = candidate?.properties?.gjj_any_preview_held_images;
		const containers = Array.isArray(held) ? held : [held];
		for (const container of containers) {
			const frames = Array.isArray(container?.sequence_frames) ? container.sequence_frames : [];
			if (frames.length !== expectedCount) continue;
			return frames.map((frame, offset) => ({
				index: offset + 1,
				...normalizedCellImage({
					...frame,
					filename: String(frame.original_filename || frame.filename || ""),
					subfolder: "GJJ/PreviewCache",
					type: "output",
					original_subfolder: "GJJ/PreviewCache",
					original_type: "output",
					preview_subfolder: "GJJ/PreviewCache",
					preview_type: "output",
				}),
			}));
		}
	}
	return [];
}

function cacheStoryboardPreviewImages(node, markDirty = false, preserveExisting = false) {
	if (!node) return [];
	node.properties ||= {};
	const runtimeItems = storyboardPreviewImageItems(node);
	const existingItems = parseStoryboardPreviewImageItems(node.properties[CACHED_PREVIEW_IMAGES_PROPERTY]);
	const items = runtimeItems.length ? runtimeItems : (preserveExisting ? existingItems : []);
	const cells = storyboardGridCells(node, currentPromptText(node), items);
	for (const item of items) {
		const cell = cells.find((entry) => entry.index === Number(item.index));
		if (cell) cell.image = normalizedCellImage(item);
	}
	saveGridCells(node, cells, markDirty);
	const cacheWidget = getWidget(node, PREVIEW_IMAGES_INPUT);
	if (cacheWidget) cacheWidget.value = JSON.stringify(items);
	return items;
}

async function restoreCachedStoryboardPreviewImages(node, cachedItems) {
	const items = Array.isArray(cachedItems) ? cachedItems : [];
	const normalized = items.map((item) => ({
		index: Math.max(1, Math.round(Number(item?.index) || 1)),
		filename: String(item?.filename || ""),
		subfolder: String(item?.subfolder || ""),
		type: String(item?.type || "temp"),
		preview_filename: String(item?.preview_filename || ""),
		preview_subfolder: String(item?.preview_subfolder ?? item?.subfolder ?? ""),
		preview_type: String(item?.preview_type || item?.type || "temp"),
		preview_width: Number(item?.preview_width || 0),
		preview_height: Number(item?.preview_height || 0),
		original_filename: String(item?.original_filename || item?.filename || ""),
		original_subfolder: String(item?.original_subfolder ?? item?.subfolder ?? ""),
		original_type: String(item?.original_type || item?.type || "temp"),
		cache_signature: String(item?.cache_signature || ""),
	})).filter((item) => item.filename);
	if (!normalized.length) {
		return;
	}
	const restoreToken = Symbol("storyboard-preview-restore");
	node.__gjjStoryboardPreviewRestoreToken = restoreToken;
	node.__gjjStoryboardRestoringPreviewCache = true;
	node.__gjjStoryboardCellPreviewUrls = [];
	node.__gjjStoryboardCellPreviewImages = [];
	node.__gjjStoryboardCellPreviewItems = normalized.map((item) => ({ ...item }));
	const restored = [];
	const restoreBatchSize = 4;
	for (let start = 0; start < normalized.length; start += restoreBatchSize) {
		if (node.__gjjStoryboardPreviewRestoreToken !== restoreToken) {
			delete node.__gjjStoryboardRestoringPreviewCache;
			return;
		}
		const batch = normalized.slice(start, start + restoreBatchSize);
		const entries = await Promise.all(batch.map(async (item) => {
			const entry = await loadStoryboardPreviewImage(item);
			if (!entry || node.__gjjStoryboardPreviewRestoreToken !== restoreToken) return null;
			const index = entry.item.index - 1;
			node.__gjjStoryboardCellPreviewUrls[index] = entry.url;
			node.__gjjStoryboardCellPreviewImages[index] = entry.image;
			return entry;
		}));
		restored.push(...entries);
		const loadedCount = node.__gjjStoryboardCellPreviewImages.filter(Boolean).length;
		if (node.__gjjStoryboardPreviewStatus) {
			node.__gjjStoryboardPreviewStatus.textContent = `已恢复 ${loadedCount}/${normalized.length} 张宫格缓存图片`;
		}
		drawPromptGridPreview(node);
		updateSelectedPreviewImage(node);
		GJJ_Utils.refreshNode?.(node);
	}
	if (node.__gjjStoryboardPreviewRestoreToken !== restoreToken) {
		delete node.__gjjStoryboardRestoringPreviewCache;
		return;
	}
	delete node.__gjjStoryboardRestoringPreviewCache;
	const validItems = restored.filter(Boolean).map((entry) => entry.item);
	cacheStoryboardPreviewImages(node, false, true);
	const status = node.__gjjStoryboardPreviewStatus;
	if (status) status.textContent = `已恢复 ${validItems.length}/${normalized.length} 张宫格缓存图片`;
	drawPromptGridPreview(node);
	updateSelectedPreviewImage(node);
	GJJ_Utils.refreshNode?.(node);
}

function updateLivePreview(node, detail) {
	if (!isTarget(node)) return;
	if (!node.__gjjStoryboardPreviewWidget && typeof node.addDOMWidget === "function") {
		node.__gjjStoryboardPreviewWidget = node.addDOMWidget(IMAGE_PREVIEW_NAME, "HTML", createImagePreview(node), { serialize: false });
	}
	const status = node.__gjjStoryboardPreviewStatus;
	const image = node.__gjjStoryboardPreviewImage;
	const index = Number(detail?.index || 0);
	const total = Number(detail?.total || 0);
	if (total > 0) node.__gjjStoryboardActualPromptTotal = total;
	if (index > 0 && typeof detail?.prompt === "string") {
		node.__gjjStoryboardActualPromptParts ||= [];
		node.__gjjStoryboardActualPromptParts[index - 1] = detail.prompt;
		const completedParts = node.__gjjStoryboardActualPromptParts.slice(0, total);
		if (total > 0 && completedParts.length === total && completedParts.every((part) => typeof part === "string")) {
			syncPromptSnapshot(node, serializePromptParts(completedParts));
		}
	}
	if (status) {
		status.textContent = total > 0 ? `已生成 ${index}/${total}` : "已生成预览";
	}
	const item = detail?.image;
	if (item?.filename && index > 0) {
		const cells = storyboardGridCells(node);
		const cell = cells[index - 1];
		if (cell) {
			const refs = promptCellReferences(detail?.prompt ?? cell.prompt);
			cell.prompt = String(detail?.prompt ?? cell.prompt ?? "");
			cell.seed = cellSeed(node, index);
			cell.characters = refs.characters;
			cell.scenes = refs.scenes;
			cell.image = normalizedCellImage(item);
			saveGridCells(node, cells, true);
		}
		node.__gjjStoryboardCellPreviewUrls ||= [];
		node.__gjjStoryboardCellPreviewImages ||= [];
		node.__gjjStoryboardCellPreviewItems ||= [];
		node.__gjjStoryboardCellPreviewItems[index - 1] = item;
		void loadStoryboardPreviewImage(item).then((entry) => {
			if (!entry || node.__gjjStoryboardCellPreviewItems?.[index - 1] !== item) return;
			node.__gjjStoryboardCellPreviewUrls[index - 1] = entry.url;
			node.__gjjStoryboardCellPreviewImages[index - 1] = entry.image;
			drawPromptGridPreview(node);
		});
	}
	drawPromptGridPreview(node);
	updateSelectedPreviewImage(node);
	GJJ_Utils.refreshNode?.(node);
}

function resetLivePreview(node, options = {}) {
	const status = node?.__gjjStoryboardPreviewStatus;
	const image = node?.__gjjStoryboardPreviewImage;
	if (status) {
		status.textContent = "等待生成预览...";
	}
	if (image) {
		image.removeAttribute("src");
		image.style.display = "none";
	}
	const onlyIndices = Array.isArray(options.onlyIndices)
		? options.onlyIndices
		: (Number.isInteger(options.onlyIndex) ? [options.onlyIndex] : []);
	if (onlyIndices.length) {
		const cells = storyboardGridCells(node);
		node.__gjjStoryboardCellPreviewUrls ||= [];
		node.__gjjStoryboardCellPreviewImages ||= [];
		node.__gjjStoryboardCellPreviewItems ||= [];
		for (const index of onlyIndices) {
			node.__gjjStoryboardCellPreviewUrls[index] = "";
			node.__gjjStoryboardCellPreviewImages[index] = null;
			node.__gjjStoryboardCellPreviewItems[index] = null;
			if (node.__gjjStoryboardActualPromptParts) node.__gjjStoryboardActualPromptParts[index] = undefined;
			if (cells[index]) cells[index].image = null;
		}
		saveGridCells(node, cells, true);
	} else {
		node.__gjjStoryboardCellPreviewUrls = [];
		node.__gjjStoryboardCellPreviewImages = [];
		node.__gjjStoryboardCellPreviewItems = [];
		node.__gjjStoryboardActualPromptParts = [];
		node.__gjjStoryboardActualPromptTotal = 0;
		const cells = storyboardGridCells(node);
		for (const cell of cells) cell.image = null;
		saveGridCells(node, cells, true);
	}
	drawPromptGridPreview(node);
	GJJ_Utils.refreshNode?.(node);
}

function configureInputs(node) {
	const scene = getInput(node, "scene");
	if (scene) {
		scene.type = "GJJ_BATCH_IMAGE,IMAGE";
		scene.label = "场景";
		scene.localized_name = "场景";
		scene.tooltip = "接收上游素材/背景作为参考图参与生成；不会启用自动局部蒙版。";
	}
	const reference = getInput(node, "reference");
	if (reference) {
		reference.type = "GJJ_BATCH_IMAGE,IMAGE";
		reference.label = "参考图";
		reference.localized_name = "参考图";
		reference.tooltip = "接收上游素材/背景作为参考图参与生成；不会启用自动局部蒙版。";
	}
}

async function applyModelFamilyPreset(node, force = false) {
	const unetWidget = getWidget(node, "unet_name");
	if (!unetWidget || node.__gjjStoryboardApplyingPreset) return;
	cacheUnetOptions(node);
	const unetName = String(unetWidget.value || "").trim();
	if (!unetName) return;
	node.properties ||= {};
	if (!force && node.properties.__gjjStoryboardLastPresetUnet === unetName && hasConfiguredLoraData(node)) return;
	node.__gjjStoryboardApplyingPreset = true;
	try {
		const presets = await getModelFamilyPresets();
		const preset = matchModelFamilyPreset(unetName, presets) || fireredImageEditFallbackPreset(node, unetName);
		node.properties.__gjjStoryboardLastPresetUnet = unetName;
		if (!preset) {
			setPresetLoraData(node, null, unetName);
			setStoryboardLoraForModel(node, null, unetName, force);
			return;
		}
		const updates = {
			clip_name1: (preset.clipNames || [])[0] || "",
			vae_name: preset.vaeName || "",
			steps: Number.isFinite(preset.steps) ? Number(preset.steps) : undefined,
			cfg: Number.isFinite(preset.cfg) ? Number(preset.cfg) : undefined,
			sampler_name: preset.sampler || "",
			scheduler: preset.scheduler || "",
			denoise: Number.isFinite(preset.denoise) ? Number(preset.denoise) : undefined,
		};
		for (const [name, value] of Object.entries(updates)) {
			if (value === undefined || value === null || value === "") continue;
			if (getInput(node, name)?.link != null) continue;
			setWidgetValue(getWidget(node, name), value);
		}
		setPresetLoraData(node, preset, unetName);
		setStoryboardLoraForModel(node, preset, unetName, force);
		GJJ_Utils.refreshNode?.(node);
	} finally {
		node.__gjjStoryboardApplyingPreset = false;
	}
}

function hookUnetWidget(node) {
	const widget = getWidget(node, "unet_name");
	if (!widget || widget.__gjjStoryboardPresetHooked) return;
	widget.__gjjStoryboardPresetHooked = true;
	allWidgetOptions(widget);
	cacheUnetOptions(node);
	const original = widget.callback;
	widget.callback = function (value, ...args) {
		const result = original?.apply(this, [value, ...args]);
		refreshUnetPickerControl(node);
		if (!node.__gjjStoryboardApplyingParameterDialog) {
			setTimeout(() => applyModelFamilyPreset(node, true), 0);
		}
		return result;
	};
}

function hookPromptWidget(node) {
	const widget = getWidget(node, "prompt");
	if (!widget || widget.__gjjStoryboardPromptGridHooked) return;
	widget.__gjjStoryboardPromptGridHooked = true;
	const original = widget.callback;
	widget.callback = function (value, ...args) {
		const result = original?.apply(this, [value, ...args]);
		const nextPrompt = currentPromptText(node);
		if (node.__gjjStoryboardRestoringParams) {
			node.__gjjStoryboardLastEffectivePromptText = nextPrompt;
			void resolvePromptCharacters(node, nextPrompt);
			setTimeout(() => drawPromptGridPreview(node), 0);
			return result;
		}
		const changed = reconcilePreviewForPromptChange(node, nextPrompt);
		void resolvePromptCharacters(node, nextPrompt);
		if (!changed) setTimeout(() => drawPromptGridPreview(node), 0);
		return result;
	};
}

function hookLoraDataWidget(node) {
	const widget = getWidget(node, "lora_data");
	if (!widget || widget.__gjjStoryboardTrailingSlotHooked) return;
	widget.__gjjStoryboardTrailingSlotHooked = true;
	const original = widget.callback;
	widget.callback = function (value, ...args) {
		const normalized = normalizeStoryboardLoraData(value);
		if (String(widget.value || "") !== normalized) widget.value = normalized;
		return original?.apply(this, [normalized, ...args]);
	};
	const normalized = normalizeStoryboardLoraData(widget.value);
	if (String(widget.value || "") !== normalized) setWidgetValue(widget, normalized);
}

function hookPreviewRefreshWidgets(node) {
	for (const name of CACHE_INVALIDATION_WIDGETS) {
		const widget = getWidget(node, name);
		if (!widget || widget.__gjjStoryboardPreviewRefreshHooked) continue;
		widget.__gjjStoryboardPreviewRefreshHooked = true;
		widget.__gjjStoryboardLastCacheValue = JSON.stringify(widget.value ?? null);
		const original = widget.callback;
		widget.callback = function (value, ...args) {
			const result = original?.apply(this, [value, ...args]);
			const nextValue = JSON.stringify(widget.value ?? value ?? null);
			const changed = widget.__gjjStoryboardLastCacheValue !== nextValue;
			widget.__gjjStoryboardLastCacheValue = nextValue;
			saveParamValues(node);
			if (changed && name === "seed" && !node.__gjjStoryboardRestoringParams) {
				const cells = storyboardGridCells(node);
				const activeSingleIndices = Array.isArray(node.__gjjStoryboardSingleCellIndices)
					? new Set(node.__gjjStoryboardSingleCellIndices)
					: (Number.isInteger(node.__gjjStoryboardSingleCellIndex) ? new Set([node.__gjjStoryboardSingleCellIndex]) : null);
				const changedSeedIndices = cells
					.map((cell, index) => (
						(!activeSingleIndices || activeSingleIndices.has(index))
						&& Number(cell.seed) !== cellSeed(node, cell.index)
					) ? index : -1)
					.filter((index) => index >= 0);
				if (changedSeedIndices.length) {
					for (const index of changedSeedIndices) {
						cells[index].seed = cellSeed(node, cells[index].index);
						cells[index].image = null;
					}
					saveGridCells(node, cells, true);
					invalidateStoryboardGeneratedCache(node, changedSeedIndices, cells.length);
				}
			}
			if (changed || PREVIEW_REFRESH_WIDGETS.has(name)) {
				setTimeout(() => drawPromptGridPreview(node), 0);
			}
			return result;
		};
	}
}

function saveParamValues(node) {
	const values = {};
	for (const name of PANEL_SYNC_WIDGETS) {
		const widget = getWidget(node, name);
		if (widget) values[name] = widget.value;
	}
	values[SEED_CONTROL_KEY] = seedControlMode(node);
	const loraData = getWidget(node, "lora_data");
	if (loraData) {
		const normalized = normalizeStoryboardLoraData(loraData.value);
		if (String(loraData.value || "") !== normalized) loraData.value = normalized;
		values.lora_data = normalized;
	}
	node.properties ||= {};
	node.properties[PARAM_VALUES_PROPERTY] = values;
	return values;
}

function restoreParamValues(node, values) {
	if (!values || typeof values !== "object") return;
	for (const name of PANEL_SYNC_WIDGETS) {
		if (!Object.prototype.hasOwnProperty.call(values, name)) continue;
		setWidgetValue(getWidget(node, name), values[name]);
	}
	if (Object.prototype.hasOwnProperty.call(values, "lora_data")) {
		setWidgetValue(getWidget(node, "lora_data"), normalizeStoryboardLoraData(values.lora_data));
	}
	if (Object.prototype.hasOwnProperty.call(values, SEED_CONTROL_KEY)) {
		const widget = findSeedControlWidget(node);
		const mode = textValue(values[SEED_CONTROL_KEY]);
		if (widget && isSeedControlValue(mode)) setWidgetValue(widget, mode);
	}
}

function patchNode(node) {
	if (!isTarget(node)) return;
	configureInputs(node);
	hookUnetWidget(node);
	hookPromptWidget(node);
	hookLoraDataWidget(node);
	hookPreviewRefreshWidgets(node);
	syncSeedControlWidget(node);
	if (!node.__gjjStoryboardExecuteWidget && typeof node.addDOMWidget === "function") {
		node.__gjjStoryboardExecuteWidget = node.addDOMWidget(EXECUTE_BUTTON_NAME, "HTML", createButtons(node), { serialize: false });
	}
	if (!node.__gjjStoryboardUnetPickerWidget && typeof node.addDOMWidget === "function") {
		node.__gjjStoryboardUnetPickerWidget = node.addDOMWidget(UNET_FILTER_WIDGET_NAME, "HTML", createUnetPickerControl(node), { serialize: false });
	}
	if (!node.__gjjStoryboardPreviewWidget && typeof node.addDOMWidget === "function") {
		node.__gjjStoryboardPreviewWidget = node.addDOMWidget(IMAGE_PREVIEW_NAME, "HTML", createImagePreview(node), { serialize: false });
	}
	applySettingsVisibility(node);
	forcePromptWidgetVisible(node);
	setWidgetHidden(getWidget(node, "unet_name"), true);
	cacheUnetOptions(node);
	refreshUnetPickerControl(node);
	updateTemplateSourcePanel(node, TEMPLATE_SOURCE_FIELDS);
	void applyModelFamilyPreset(node, false);
	recordCurrentStoryboardLinks(node);
	updateReconnectButton(node);
	observeLinkedPromptSource(node);
	observeLinkedCacheSources(node);
	const effectivePrompt = currentPromptText(node);
	if (node.__gjjStoryboardLastEffectivePromptText === undefined) {
		node.__gjjStoryboardLastEffectivePromptText = effectivePrompt;
	}
	void resolvePromptCharacters(node, effectivePrompt);
	if (!parseGridCells(node?.properties?.[GRID_CELLS_PROPERTY]).some((cell) => cell.image?.filename)) {
		const recoveredImages = recoverGridImagesFromWorkflow(node, parsePromptParts(effectivePrompt).length);
		if (recoveredImages.length) {
			const recoveredCells = storyboardGridCells(node, effectivePrompt, recoveredImages);
			for (const item of recoveredImages) {
				if (recoveredCells[item.index - 1]) recoveredCells[item.index - 1].image = normalizedCellImage(item);
			}
			saveGridCells(node, recoveredCells, true);
		}
	}
	// onNodeCreated is deferred until after LiteGraph's initial onConfigure call.
	// Restore persisted previews here as well so a browser refresh cannot miss the
	// per-instance onConfigure wrapper installed below.
	if (!node.__gjjStoryboardInitialPreviewRestoreStarted) {
		const tableCachedImages = parseGridCells(node?.properties?.[GRID_CELLS_PROPERTY]).filter((cell) => cell.image?.filename).map((cell) => ({ index: cell.index, ...cell.image }));
		const propertyCachedImages = tableCachedImages.length ? tableCachedImages : parseStoryboardPreviewImageItems(node?.properties?.[CACHED_PREVIEW_IMAGES_PROPERTY]);
		const widgetCachedImages = parseStoryboardPreviewImageItems(getWidget(node, PREVIEW_IMAGES_INPUT)?.value);
		const cachedImages = propertyCachedImages.length ? propertyCachedImages : widgetCachedImages;
		if (cachedImages.length) {
			node.__gjjStoryboardInitialPreviewRestoreStarted = true;
			void restoreCachedStoryboardPreviewImages(node, cachedImages);
		}
	}
	if (node.__gjjStoryboardPatched) return;
	node.__gjjStoryboardPatched = true;

	const originalOnConnectionsChange = node.onConnectionsChange;
	node.onConnectionsChange = function (...args) {
		const result = originalOnConnectionsChange?.apply(this, args);
		recordStoryboardLinkFromConnectionEvent(this, args);
		updateReconnectButton(this);
		observeLinkedPromptSource(this);
		observeLinkedCacheSources(this);
		const nextPrompt = currentPromptText(this);
		// LiteGraph may emit transient disconnect/reconnect callbacks while another
		// node is queued or the graph is refreshed.  A connection event alone must
		// never discard generated storyboards; only an effective prompt text change
		// is a valid cache-invalidation signal.
		reconcilePreviewForPromptChange(this, nextPrompt);
		void resolvePromptCharacters(this, nextPrompt);
		drawPromptGridPreview(this);
		return result;
	};

	const originalOnSerialize = node.onSerialize;
	node.onSerialize = function (serializedNode, ...args) {
		const result = originalOnSerialize?.apply(this, [serializedNode, ...args]);
		serializedNode.properties ||= {};
		serializedNode.properties[PARAM_VALUES_PROPERTY] = saveParamValues(this);
		// During workflow serialization the DOM/runtime image arrays can briefly be
		// empty. Preserve the already saved manifest instead of erasing it.
		const cachedImages = cacheStoryboardPreviewImages(this, false, true);
		const cells = saveGridCells(this, storyboardGridCells(this));
		serializedNode.properties[GRID_CELLS_PROPERTY] = cells;
		if (cachedImages.length) serializedNode.properties[CACHED_PREVIEW_IMAGES_PROPERTY] = cachedImages;
		else delete serializedNode.properties[CACHED_PREVIEW_IMAGES_PROPERTY];
		return result;
	};

	const originalOnConfigure = node.onConfigure;
	node.onConfigure = function (serializedNode, ...args) {
		const values = serializedNode?.properties?.[PARAM_VALUES_PROPERTY];
		const serializedCells = parseGridCells(serializedNode?.properties?.[GRID_CELLS_PROPERTY]);
		const serializedCellPrompt = serializedCells.length
			? serializePromptParts(serializedCells.map((cell) => String(cell?.prompt || "")))
			: "";
		const tableCachedImages = serializedCells.filter((cell) => cell.image?.filename).map((cell) => ({ index: cell.index, ...cell.image }));
		const propertyCachedImages = tableCachedImages.length ? tableCachedImages : parseStoryboardPreviewImageItems(serializedNode?.properties?.[CACHED_PREVIEW_IMAGES_PROPERTY]);
		const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
		setTimeout(() => {
			if (serializedCells.length) {
				this.properties ||= {};
				this.properties[GRID_CELLS_PROPERTY] = serializedCells;
				// The upstream node/link can still be unavailable during workflow load.
				// Use the persisted per-cell prompt table as the cache comparison baseline
				// so that a transient empty prompt cannot invalidate every stored image.
				this.__gjjStoryboardLastEffectivePromptText = serializedCellPrompt;
			}
			this.__gjjStoryboardRestoringParams = true;
			try {
				restoreParamValues(this, values);
			} finally {
				delete this.__gjjStoryboardRestoringParams;
			}
			patchNode(this);
			const widgetCachedImages = parseStoryboardPreviewImageItems(getWidget(this, PREVIEW_IMAGES_INPUT)?.value);
			const cachedImages = propertyCachedImages.length ? propertyCachedImages : widgetCachedImages;
			if (cachedImages.length) {
				this.__gjjStoryboardInitialPreviewRestoreStarted = true;
				void restoreCachedStoryboardPreviewImages(this, cachedImages);
			}
		}, 0);
		return result;
	};
}

api.addEventListener("gjj_storyboard_grid_preview", (event) => {
	const detail = event?.detail || {};
	const nodeId = String(detail.node || "");
	for (const node of app.graph?._nodes || []) {
		if (isTarget(node) && String(node.id) === nodeId) {
			updateLivePreview(node, detail);
		}
	}
});

globalThis.addEventListener("gjj_character_library_updated", () => {
	for (const node of app.graph?._nodes || []) {
		if (!isTarget(node)) continue;
		node.__gjjStoryboardResolvedCharacters = new Map();
		node.__gjjStoryboardReferenceIconImages?.clear?.();
		closeReferencePicker(node);
		void resolvePromptCharacters(node, currentPromptText(node));
		drawPromptGridPreview(node);
	}
});

globalThis.addEventListener("gjj_scene_library_updated", () => {
	for (const node of app.graph?._nodes || []) {
		if (!isTarget(node)) continue;
		node.__gjjStoryboardReferenceIconImages?.clear?.();
		closeReferencePicker(node);
		void resolvePromptCharacters(node, currentPromptText(node));
		drawPromptGridPreview(node);
	}
});

app.registerExtension({
	name: "GJJ.StoryboardGridGenerator",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name) || nodeType.prototype.__gjjStoryboardPrototypePatched) return;
		nodeType.prototype.__gjjStoryboardPrototypePatched = true;
		nodeData.output_preview = false;
		if (Array.isArray(nodeData.outputs)) {
			for (const output of nodeData.outputs) output.preview = false;
		}

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			setTimeout(() => patchNode(this), 0);
			return result;
		};
	},
	async nodeCreated(node) {
		patchNode(node);
	},
	setup() {
		installStoryboardSeedPromptPatch();
		for (const node of app.graph?._nodes || []) {
			patchNode(node);
		}
	},
});
