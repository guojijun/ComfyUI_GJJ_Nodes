import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_AnyPreview"]);
const INPUT_PREFIX = "any_";
const MIN_VISIBLE_INPUTS = 1;
const ANY_INPUT_TYPE = "GJJ_BATCH_IMAGE, IMAGE, MASK,STRING,AUDIO,VIDEO,*";
const FIRST_INPUT_LABEL = "任意对象";
const INPUT_TOOLTIP = "可连接 GJJ_BATCH_IMAGE、IMAGE、MASK、STRING、AUDIO、VIDEO 或任意对象；列表会展开预览。";
const PREVIEW_WIDGET_NAME = "gjj_any_preview_text";
const EMPTY_PREVIEW = "执行后在这里预览文本、对象或调试信息";
const MIN_PREVIEW_HEIGHT = 96;
const IMAGE_PREVIEW_MIN_HEIGHT = 124;
const SINGLE_IMAGE_PREVIEW_HEIGHT = 360;
const MIN_NODE_HEIGHT = 40;
const MIN_WIDTH = 300;
const NODE_BOTTOM_PADDING = 10;
const LORA_EFFECT_LIVE_TEXT_MAP_KEY = "__gjjLoraEffectTesterLiveTextByNodeId";
const LIVE_PREVIEW_STATE_KEY = "__gjjAnyPreviewLiveState";
const IMAGE_SEQUENCE_MIN_FRAMES = 16;
const IMAGE_SEQUENCE_PREVIEW_FPS = 12;
const AUDIO_PLAYER_HEIGHT = 24;
const AUDIO_WAVEFORM_HEIGHT = 72;
const MODE_EDIT = "edit";
const MODE_PREVIEW = "preview";
const DOUBLE_CLICK_MS = 420;
const MODE_PROPERTY = "__gjjAnyPreviewMode";
const LIVE_KIND_LABELS = {
	image: "图片",
	mask: "遮罩",
	text: "文本",
	audio: "音频",
	video: "视频",
	other: "对象",
	mixed: "混合对象",
};
let lastPromptId = null;
let audioWaveformContext = null;
const audioWaveformCache = new Map();
const audioWaveformPeaks = new WeakMap();

function getMode(node) {
	const mode = String(node?.properties?.[MODE_PROPERTY] || MODE_PREVIEW);
	return mode === MODE_PREVIEW ? MODE_PREVIEW : MODE_EDIT;
}

function handlePreviewPointer(node, event) {
	const now = Date.now();
	if (event.type === "mousedown" && now - Number(node.__gjjAnyPreviewLastPointerEvent || 0) < 40) {
		event.stopPropagation();
		return;
	}
	node.__gjjAnyPreviewLastPointerEvent = now;
	const last = Number(node.__gjjAnyPreviewLastPointer || 0);
	node.__gjjAnyPreviewLastPointer = now;
	event.stopPropagation();
	if (event.detail >= 2 || (last > 0 && now - last <= DOUBLE_CLICK_MS)) {
		event.preventDefault();
	}
}

function imageDataToUrl(data) {
	if (!data?.filename) {
		return "";
	}
	const previewFormat =
		typeof app.getPreviewFormatParam === "function"
			? app.getPreviewFormatParam()
			: "";
	const randParam =
		typeof app.getRandParam === "function" ? app.getRandParam() : "";
	return api.apiURL(
		`/view?filename=${encodeURIComponent(data.filename)}&type=${encodeURIComponent(data.type || "temp")}&subfolder=${encodeURIComponent(data.subfolder || "")}${previewFormat}${randParam}`,
	);
}

function compactPreviewText(text) {
	const source = String(text || "").replace(/\s+/g, " ").trim();
	if (!source) {
		return "";
	}
	const parts = [];
	const duration = source.match(/时长[:：]\s*([0-9.]+)\s*秒/);
	const frames = source.match(/帧数[:：]\s*(\d+)/);
	const fps = source.match(/(?:预览帧率|帧率)[:：]\s*([0-9.]+)\s*(?:fps)?/i);
	const size = source.match(/尺寸[:：]\s*(\d+)\s*[x×]\s*(\d+)/i);
	const shape = source.match(/形状[:：]\s*\(([^)]*)\)/);
	if (duration) parts.push(`⏱ ${duration[1]}s`);
	if (frames) parts.push(`🎞 ${frames[1]}帧`);
	if (fps) parts.push(`⚡ ${fps[1]}fps`);
	if (size) {
		parts.push(`📐 ${size[1]}×${size[2]}`);
	} else if (shape) {
		const nums = shape[1]
			.split(",")
			.map((part) => Number.parseInt(part.trim(), 10))
			.filter((value) => Number.isFinite(value));
		if (nums.length >= 4) {
			parts.push(`📐 ${nums[2]}×${nums[1]}`);
		}
	}
	return parts.length ? parts.join(" · ") : source;
}

function mediaEmoji(tagName, item) {
	const filename = String(item?.filename || "").toLowerCase();
	if (item?.is_sequence) {
		return "🎬";
	}
	if (tagName === "audio" || /\.(wav|mp3|flac|ogg|m4a|aac)$/i.test(filename)) {
		return "🎧";
	}
	if (tagName === "video" || /\.(mp4|webm|mov|mkv|avi|gif)$/i.test(filename)) {
		return "🎬";
	}
	return "🖼️";
}

function isSequenceMediaItem(item) {
	return Boolean(item?.is_sequence || (item?.loop && String(item?.format || "").includes("webp")));
}

async function openMediaFolder(item, button) {
	if (!item?.filename && !item?.subfolder) {
		return;
	}
	const params = new URLSearchParams();
	params.set("type", item.type || "temp");
	params.set("subfolder", item.subfolder || "");
	params.set("filename", item.filename || "");
	const oldText = button?.textContent || "📁";
	try {
		if (button) {
			button.disabled = true;
			button.textContent = "…";
		}
		const response = await api.fetchApi(
			`/gjj/any_preview/open_media_folder?${params.toString()}`,
			{ method: "POST" },
		);
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(text || `HTTP ${response.status}`);
		}
	} catch (error) {
		console.warn("[GJJ AnyPreview] 打开所在目录失败:", error);
		if (button) {
			button.title = `打开所在目录失败：${error?.message || error}`;
		}
	} finally {
		if (button) {
			button.disabled = false;
			button.textContent = oldText;
		}
	}
}

function isMediaFileItem(item) {
	return Boolean(item && typeof item === "object" && item.filename);
}

function normalizeMediaPayload(payload) {
	if (!payload) {
		return [];
	}
	if (isMediaFileItem(payload)) {
		return [payload];
	}
	if (!Array.isArray(payload)) {
		return [];
	}
	if (payload.length === 1 && Array.isArray(payload[0])) {
		return normalizeMediaPayload(payload[0]);
	}
	return payload.filter(isMediaFileItem);
}

function firstMediaPayload(...payloads) {
	for (const payload of payloads) {
		const normalized = normalizeMediaPayload(payload);
		if (normalized.length > 0) {
			return normalized;
		}
	}
	return [];
}

function normalizePreviewItemsPayload(payload) {
	if (!payload) {
		return [];
	}
	if (!Array.isArray(payload)) {
		return [];
	}
	const items =
		payload.length === 1 && Array.isArray(payload[0]) ? payload[0] : payload;
	return items.filter((item) => item && typeof item === "object");
}

function formatInputName(index) {
	return `${INPUT_PREFIX}${String(index).padStart(2, "0")}`;
}

function getInputIndex(name) {
	const text = String(name || "");
	if (!text.startsWith(INPUT_PREFIX)) {
		return Number.MAX_SAFE_INTEGER;
	}
	return (
		Number.parseInt(text.slice(INPUT_PREFIX.length), 10) ||
		Number.MAX_SAFE_INTEGER
	);
}

function getInputs(node) {
	return Array.isArray(node?.inputs)
		? [...node.inputs]
				.filter((input) => String(input?.name || "").startsWith(INPUT_PREFIX))
				.sort((a, b) => getInputIndex(a?.name) - getInputIndex(b?.name))
		: [];
}

function migrateLegacyInputs(node) {
	for (const input of node?.inputs || []) {
		if (String(input?.name || "") === "batch_image") {
			input.name = formatInputName(1);
		}
	}
}

function getLinkedOutputInfo(input) {
	const linkId = input?.link;
	if (!linkId || !app.graph?.links) {
		return null;
	}
	const link = app.graph.links[linkId];
	const sourceNode =
		link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	const sourceSlot = sourceNode?.outputs?.[link.origin_slot];
	if (!sourceSlot) {
		return null;
	}
	return {
		type: sourceSlot.type || "*",
		label: sourceSlot.label || sourceSlot.name || sourceSlot.type || "*",
	};
}

function getLinkedSourceInfo(input) {
	const linkId = input?.link;
	if (!linkId || !app.graph?.links) {
		return null;
	}
	const link = app.graph.links[linkId];
	const sourceNode =
		link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	const sourceSlot = sourceNode?.outputs?.[link?.origin_slot];
	if (!sourceNode || !sourceSlot) {
		return null;
	}
	return {
		link,
		sourceNode,
		sourceSlot,
		type: sourceSlot.type || "*",
		label: sourceSlot.label || sourceSlot.name || sourceSlot.type || "*",
	};
}

function eventPromptId(event) {
	return event?.detail?.prompt_id || null;
}

function samePrompt(event) {
	const promptId = eventPromptId(event);
	return !(promptId && lastPromptId && promptId !== lastPromptId);
}

function eventNodeId(event) {
	return String(
		event?.detail?.node_id
			?? event?.detail?.node
			?? event?.detail?.display_node
			?? event?.detail?.nodeId
			?? "",
	);
}

function firstTextPayload(...payloads) {
	for (const payload of payloads) {
		if (payload == null) {
			continue;
		}
		if (typeof payload === "string") {
			const text = payload.trim();
			if (text) return text;
			continue;
		}
		if (Array.isArray(payload)) {
			const queue = [...payload];
			while (queue.length) {
				const item = queue.shift();
				if (Array.isArray(item)) {
					queue.unshift(...item);
				} else if (typeof item === "string") {
					const text = item.trim();
					if (text) return text;
				}
			}
		}
	}
	return "";
}

function inferMediaKind(items, fallback = "video") {
	const first = Array.isArray(items) ? items.find(isMediaFileItem) : null;
	const explicit = String(first?.media_type || first?.type_name || "").toLowerCase();
	if (explicit.includes("audio")) return "audio";
	if (explicit.includes("image")) return "image";
	if (explicit.includes("video")) return "video";
	const filename = String(first?.filename || "").toLowerCase();
	if (/\.(wav|mp3|flac|ogg|m4a|aac)$/i.test(filename)) return "audio";
	if (/\.(png|jpe?g|webp|bmp|gif)$/i.test(filename) && !/\.(gif)$/i.test(filename)) return "image";
	if (/\.(mp4|webm|mov|mkv|avi|gif)$/i.test(filename)) return "video";
	return fallback;
}

function itemWithoutLiveFields(item) {
	const { __arrivalOrder: _arrivalOrder, __inputOrder: _inputOrder, ...rest } = item;
	return rest;
}

function ensureLivePreviewState(node) {
	if (!node[LIVE_PREVIEW_STATE_KEY]) {
		node[LIVE_PREVIEW_STATE_KEY] = {
			counter: 0,
			itemsByInput: Object.create(null),
		};
	}
	return node[LIVE_PREVIEW_STATE_KEY];
}

function resetLivePreviewState(node) {
	if (!node) {
		return;
	}
	node[LIVE_PREVIEW_STATE_KEY] = {
		counter: 0,
		itemsByInput: Object.create(null),
	};
}

function buildLivePreviewItems(event, input, inputOrder, sourceInfo) {
	const detail = event?.detail || {};
	const output = detail.output || detail || {};
	const previewItems = normalizePreviewItemsPayload(output.preview_items);
	if (previewItems.length) {
		return previewItems.map((item, index) => ({
			...item,
			title:
				item.title ||
				`项目 ${inputOrder + 1}.${index + 1} · ${
					LIVE_KIND_LABELS[item.kind] || "对象"
				}`,
		}));
	}

	const previewMedia = firstMediaPayload(
		output.preview_media,
		output.preview_video,
		output.gifs,
		output.animated,
	);
	const previewMediaKind = inferMediaKind(previewMedia, "video");
	let images = firstMediaPayload(output.preview_images, output.images);
	let audio = firstMediaPayload(output.preview_audio, output.audio);
	let video = [];
	if (previewMediaKind === "image") {
		images = images.length ? images : previewMedia;
	} else if (previewMediaKind === "audio") {
		audio = audio.length ? audio : previewMedia;
	} else {
		video = previewMedia;
	}
	if (!video.length) {
		video = firstMediaPayload(output.video, output.videos);
	}

	const text = firstTextPayload(
		output.preview_text,
		output.text,
		output.string,
		output.status,
	);
	const explicitKind = firstTextPayload(output.preview_kind).toLowerCase();
	let kind = explicitKind;
	if (!LIVE_KIND_LABELS[kind]) {
		if (video.length) kind = "video";
		else if (audio.length) kind = "audio";
		else if (images.length) kind = "image";
		else if (text) kind = "text";
		else kind = "other";
	}
	if (!video.length && !audio.length && !images.length && !text) {
		return [];
	}

	const sourceLabel = String(sourceInfo?.label || input?.label || input?.name || "").trim();
	const label = LIVE_KIND_LABELS[kind] || sourceLabel || "对象";
	const title = `项目 ${inputOrder + 1} · ${label}`;
	const item = {
		kind,
		source_kind: kind,
		title,
		text,
	};
	if (images.length) item.images = images;
	if (audio.length) item.audio = audio;
	if (video.length) item.video = video;
	return [item];
}

function applyLivePreviewItems(node, input, inputOrder, items) {
	if (!node || !items.length) {
		return;
	}
	const state = ensureLivePreviewState(node);
	const key = String(input?.name || inputOrder);
	state.itemsByInput[key] = items.map((item, index) => ({
		...item,
		__inputOrder: inputOrder,
		__arrivalOrder: ++state.counter + index / 1000,
	}));
	const previewItems = Object.values(state.itemsByInput)
		.flat()
		.sort((a, b) => {
			const arrival = Number(a.__arrivalOrder || 0) - Number(b.__arrivalOrder || 0);
			if (arrival !== 0) return arrival;
			return Number(a.__inputOrder || 0) - Number(b.__inputOrder || 0);
		})
		.map(itemWithoutLiveFields);

	node.__gjjAnyPreviewKind = "mixed";
	node.__gjjAnyPreviewText = previewItems.length
		? `已按进入顺序刷新 ${previewItems.length} 个预览项目`
		: "";
	node.__gjjAnyPreviewItems = previewItems;
	node.__gjjAnyPreviewImages = [];
	node.__gjjAnyPreviewAudio = [];
	node.__gjjAnyPreviewVideo = [];
	node.imgs = [];
	node.images = [];
	node.preview = null;
	ensurePreviewWidget(node);
	applyPreviewContent(node);
	updateLayout(node);
	scheduleLayout(node);
	setDirty(node);
}

function livePreviewItemsByArrival(node) {
	const state = node?.[LIVE_PREVIEW_STATE_KEY];
	if (!state?.itemsByInput) {
		return [];
	}
	return Object.values(state.itemsByInput)
		.flat()
		.sort((a, b) => {
			const arrival = Number(a.__arrivalOrder || 0) - Number(b.__arrivalOrder || 0);
			if (arrival !== 0) return arrival;
			return Number(a.__inputOrder || 0) - Number(b.__inputOrder || 0);
		});
}

function reorderPreviewItemsByLiveOrder(node, items) {
	if (!Array.isArray(items) || !items.length) {
		return items;
	}
	const liveItems = livePreviewItemsByArrival(node);
	if (!liveItems.length || liveItems.length !== items.length) {
		return items;
	}
	const used = new Set();
	const reordered = [];
	for (const liveItem of liveItems) {
		const index = Number(liveItem.__inputOrder);
		if (!Number.isInteger(index) || index < 0 || index >= items.length || used.has(index)) {
			return items;
		}
		used.add(index);
		reordered.push(items[index]);
	}
	return reordered.length === items.length ? reordered : items;
}

function refreshLivePreviewFromExecuted(event) {
	if (!samePrompt(event)) {
		return;
	}
	const sourceId = eventNodeId(event);
	if (!sourceId) {
		return;
	}
	for (const node of app.graph?._nodes || []) {
		if (!TARGET_NODES.has(node?.comfyClass) || String(node.id) === String(sourceId)) {
			continue;
		}
		const inputs = getInputs(node);
		for (const [inputOrder, input] of inputs.entries()) {
			if (!input?.link) {
				continue;
			}
			const sourceInfo = getLinkedSourceInfo(input);
			if (String(sourceInfo?.sourceNode?.id || "") !== String(sourceId)) {
				continue;
			}
			const items = buildLivePreviewItems(event, input, inputOrder, sourceInfo);
			applyLivePreviewItems(node, input, inputOrder, items);
		}
	}
}

function setDirty(node) {
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function measureHeight(node) {
	const container = node?.__gjjAnyPreviewContainer;
	if (!container) {
		return MIN_NODE_HEIGHT;
	}
	const contentHeight = Math.ceil(
		container.scrollHeight || container.offsetHeight || MIN_NODE_HEIGHT,
	);
	return Math.max(MIN_NODE_HEIGHT, contentHeight + 12);
}

function getWidgetTopOffset(node) {
	const widget = node?.__gjjAnyPreviewWidget;
	return Math.max(
		0,
		Number(widget?.y || 0),
		Number(widget?.last_y || 0),
	);
}

function refreshLayout(node) {
	const width = Math.max(MIN_WIDTH, Number(node.size?.[0] || MIN_WIDTH));
	const height = Math.max(
		MIN_NODE_HEIGHT,
		Number(node.size?.[1] || MIN_NODE_HEIGHT),
	);
	if ((node.size?.[0] || 0) !== width || (node.size?.[1] || 0) !== height) {
		node.setSize?.([width, height]);
	}
	setDirty(node);
}

function estimateImagePreviewHeight(node) {
	const images = Array.isArray(node?.__gjjAnyPreviewImages)
		? node.__gjjAnyPreviewImages
		: [];
	const count = Math.max(1, images.length || 1);

	const nodeWidth = Math.max(MIN_WIDTH, Number(node?.size?.[0] || MIN_WIDTH));
	// 减去 padding 和 border
	const contentWidth = Math.max(220, nodeWidth - 36);

	if (count === 1) {
		// 单图模式：根据宽度动态计算高度，保持图片比例
		// 使用默认宽高比 4:3
		const aspectRatio = 4 / 3;
		const imageHeight = contentWidth / aspectRatio;
		return Math.max(MIN_PREVIEW_HEIGHT, imageHeight + 18);
	}

	// 多图模式：动态计算列数
	const minCardWidth = 140;
	const gap = 8;
	const columns = Math.min(
		count,
		Math.max(1, Math.floor((contentWidth + gap) / (minCardWidth + gap))),
	);

	const rows = Math.max(1, Math.ceil(count / columns));

	// 正方形卡片，高度等于宽度
	const actualCardWidth = (contentWidth - (columns - 1) * gap) / columns;
	const cardHeight = actualCardWidth; // 正方形，高度=宽度

	// 计算总高度：行数 * 卡片高度 + 间距
	const totalGap = (rows - 1) * gap;
	return Math.max(
		MIN_PREVIEW_HEIGHT,
		rows * cardHeight + totalGap + 18,
	);
}

function shouldUseEstimatedImageLayout(node) {
	if (String(node?.__gjjAnyPreviewKind || "") !== "image") {
		return false;
	}
	if (Array.isArray(node?.__gjjAnyPreviewItems) && node.__gjjAnyPreviewItems.length > 0) {
		return false;
	}
	const images = Array.isArray(node?.__gjjAnyPreviewImages)
		? node.__gjjAnyPreviewImages
		: [];
	return !images.some(isSequenceMediaItem) && images.length < IMAGE_SEQUENCE_MIN_FRAMES;
}

function getWidgetHeight(node, widget) {
	if (shouldUseEstimatedImageLayout(node)) {
		return estimateImagePreviewHeight(node);
	}
	const nodeHeight = Math.max(
		MIN_NODE_HEIGHT,
		Number(node?.size?.[1] || MIN_NODE_HEIGHT),
	);
	const topOffset = Math.max(0, getWidgetTopOffset(node), Number(widget?.y || 0), Number(widget?.last_y || 0));
	const availableHeight = nodeHeight - topOffset - NODE_BOTTOM_PADDING;
	return Math.max(
		MIN_PREVIEW_HEIGHT,
		node?.__gjjAnyPreviewHeight || availableHeight,
	);
}

function updateLayout(node) {
	if (!node) {
		return;
	}

	const topOffset = getWidgetTopOffset(node);
	const useEstimatedImageLayout = shouldUseEstimatedImageLayout(node);
	const container = node.__gjjAnyPreviewContainer;
	const previewWrap = node.__gjjAnyPreviewWrap;
	if (!useEstimatedImageLayout && container && previewWrap) {
		container.style.height = "auto";
		previewWrap.style.height = "auto";
		previewWrap.style.overflow = "visible";
	}
	const previewHeight = useEstimatedImageLayout
		? estimateImagePreviewHeight(node)
		: measureHeight(node);
	const height = Math.max(
		MIN_NODE_HEIGHT,
		topOffset + previewHeight + NODE_BOTTOM_PADDING,
	);

	// 关键修复：强制更新节点大小，即使高度减少
	const currentHeight = Number(node.size?.[1] || MIN_NODE_HEIGHT);
	if (height !== currentHeight) {
		node.setSize?.([node.size?.[0], height]);

		// 同步更新 DOM 容器高度
		if (container && previewWrap) {
			const availableHeight = height - topOffset - NODE_BOTTOM_PADDING;
			if (useEstimatedImageLayout) {
				container.style.height = `${Math.max(MIN_PREVIEW_HEIGHT, availableHeight)}px`;
				previewWrap.style.height = `${Math.max(MIN_PREVIEW_HEIGHT, availableHeight)}px`;
			} else {
				container.style.height = "auto";
				previewWrap.style.height = "auto";
				previewWrap.style.minHeight = "96px";
			}
		}

		setDirty(node);
	}
}

function scheduleLayout(node) {
	if (!node || node.__gjjAnyPreviewLayoutQueued) {
		return;
	}
	node.__gjjAnyPreviewLayoutQueued = true;
	requestAnimationFrame(() => {
		node.__gjjAnyPreviewLayoutQueued = false;
		updateLayout(node);
	});
}

function ensureOutput(node) {
	if (!Array.isArray(node.outputs) || node.outputs.length === 0) {
		node.addOutput?.("预览结果", "*");
	}
}

function addDynamicInput(node, type = "*") {
	const nextIndex = getInputs(node).length + 1;
	node.addInput(formatInputName(nextIndex), ANY_INPUT_TYPE);
}

function ensureTrailingEmptyInput(node) {
	const inputs = getInputs(node);
	if (inputs.length === 0) {
		addDynamicInput(node);
		return;
	}
	const lastInput = inputs[inputs.length - 1];
	if (lastInput?.link) {
		addDynamicInput(node, lastInput.type || "*");
	}
}

function removeUnusedInputsFromEnd(node, minInputs = MIN_VISIBLE_INPUTS) {
	const inputs = getInputs(node);
	for (let index = inputs.length - 1; index >= minInputs; index -= 1) {
		const input = inputs[index];
		if (input?.link) {
			break;
		}
		const slotIndex = node.inputs.indexOf(input);
		if (slotIndex >= 0) {
			node.removeInput(slotIndex);
		}
	}
}

function renameInputsSequentially(node) {
	getInputs(node).forEach((input, index) => {
		input.name = formatInputName(index + 1);
		input.label = index === 0 ? FIRST_INPUT_LABEL : `${FIRST_INPUT_LABEL} ${index + 1}`;
		input.localized_name = input.label;
		input.tooltip = INPUT_TOOLTIP;
	});
}

function resolveOutputMode(node) {
	const infos = getInputs(node)
		.filter((input) => input?.link)
		.map((input) => getLinkedOutputInfo(input))
		.filter(Boolean);

	if (!infos.length) {
		const kind = String(node?.__gjjAnyPreviewKind || "").trim();
		if (kind === "image") {
			return {
				type: "IMAGE",
				name: "图片输出",
				tooltip: "合并后的图片批次输出。",
			};
		}
		if (kind === "text") {
			return {
				type: "STRING",
				name: "文本输出",
				tooltip: "合并后的文本输出。",
			};
		}
		return { type: "*", name: "预览结果", tooltip: "合并后的任意对象输出。" };
	}

	const types = [...new Set(infos.map((info) => String(info.type || "*")))];
	if (types.length === 1) {
		const type = types[0];
		if (type === "IMAGE") {
			return {
				type: "IMAGE",
				name: "图片输出",
				tooltip: "合并后的图片批次输出。",
			};
		}
		if (type === "STRING") {
			return {
				type: "STRING",
				name: "文本输出",
				tooltip: "合并后的文本输出。",
			};
		}
		return { type, name: "对象输出", tooltip: "合并后的对象输出。" };
	}

	return {
		type: "*",
		name: "预览结果",
		tooltip: "混合类型输入会输出合并后的任意对象。",
	};
}

function escapeHtml(text) {
	return String(text || "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function escapeAttribute(text) {
	return escapeHtml(text).replaceAll("`", "&#96;");
}

function renderInlineMarkdown(text) {
	let output = escapeHtml(text);
	// 转义 || 防止被误解释为表格分隔符或其他特殊语法
	output = output.replace(/\|\|/g, "&#124;&#124;");
	// 原有规则
	output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
	output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	output = output.replace(/__([^_]+)__/g, "<strong>$1</strong>");
	output = output.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
	output = output.replace(/(^|[^_])_([^_]+)_(?!_)/g, "$1<em>$2</em>");
	// 新增规则
	output = output.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt, src) => {
		const safeSrc = escapeAttribute(src);
		return `<img src="${safeSrc}" alt="${escapeAttribute(alt)}">`;
	});
	output = output.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
		const safeHref = escapeAttribute(href);
		return `<a href="${safeHref}" target="_blank" rel="noreferrer">${label}</a>`;
	});
	output = output.replace(/~~([^~]+)~~/g, "<del>$1</del>");
	output = output.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<]+)/g, (_match, prefix, url) => {
		const href = url.startsWith("www.") ? `https://${url}` : url;
		return `${prefix}<a href="${escapeAttribute(href)}" target="_blank" rel="noreferrer">${url}</a>`;
	});
	return output;
}

function renderMarkdown(text) {
	const source = String(text || "")
		.replace(/\r\n/g, "\n")
		.trim();
	if (!source) {
		return `<p class="gjj-text-input-empty">${EMPTY_PREVIEW}</p>`;
	}

	const lines = source.split("\n");
	const parts = [];
	const paragraph = [];
	const list = { ordered: false, items: [] };

	const flushParagraph = () => {
		if (!paragraph.length) {
			return;
		}
		parts.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
		paragraph.length = 0;
	};

	const flushList = () => {
		if (!list.items.length) {
			return;
		}
		const tag = list.ordered ? "ol" : "ul";
		parts.push(`<${tag}>${list.items.join("")}</${tag}>`);
		list.items.length = 0;
		list.ordered = false;
	};

	for (const line of lines) {
		const trimmed = line.trim();

		// 处理空行 - 刷新所有缓冲区
		if (!trimmed) {
			flushParagraph();
			flushList();
			continue;
		}

		// 处理标题
		const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
		if (headingMatch) {
			flushParagraph();
			flushList();
			const level = headingMatch[1].length;
			parts.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
			continue;
		}

		// 处理分隔线
		if (/^[-*_]{3,}$/.test(trimmed)) {
			flushParagraph();
			flushList();
			parts.push("<hr>");
			continue;
		}

		// 处理引用块
		const quoteMatch = trimmed.match(/^>\s?(.+)$/);
		if (quoteMatch) {
			flushParagraph();
			flushList();
			parts.push(`<blockquote>${renderInlineMarkdown(quoteMatch[1])}</blockquote>`);
			continue;
		}

		// 处理无序列表
		const unorderedMatch = trimmed.match(/^[-*+]\s+(.+)$/);
		// 处理有序列表
		const orderedMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);

		if (unorderedMatch || orderedMatch) {
			flushParagraph();
			const ordered = Boolean(orderedMatch);
			if (list.items.length && list.ordered !== ordered) {
				flushList();
			}
			list.ordered = ordered;
			list.items.push(`<li>${renderInlineMarkdown((orderedMatch || unorderedMatch)[1])}</li>`);
			continue;
		}

		// 普通段落内容
		paragraph.push(line);
	}

	// 刷新所有缓冲区
	flushParagraph();
	flushList();

	return parts.join("");
}

function clampTextPreviewLines(body) {
	for (const element of body.querySelectorAll(
		"p, li, h1, h2, h3, h4, h5, h6",
	)) {
		element.title = element.textContent || "";
		element.style.maxWidth = "100%";
		element.style.display = "block";
	}
	for (const element of body.querySelectorAll("ul, ol")) {
		element.style.maxWidth = "100%";
		element.style.overflow = "hidden";
	}
}

function hideWidget(widget) {
	if (!widget) {
		return;
	}
	widget.type = "hidden";
	widget.hidden = true;
	widget.computeSize = () => [0, 0];
	widget.draw = () => {};
	widget.label = "";
	if (widget.inputEl) {
		widget.inputEl.style.display = "none";
	}
	if (widget.element) {
		widget.element.style.display = "none";
	}
}

function hideLegacyPreviewWidgets(node) {
	(node.widgets || []).forEach((widget) => {
		if (widget === node.__gjjAnyPreviewWidget) {
			return;
		}
		const name = String(widget?.name || "");
		const label = String(widget?.label || "");
		if (
			name === PREVIEW_WIDGET_NAME ||
			name.includes("preview") ||
			label.includes("预览") ||
			label.includes("Preview")
		) {
			hideWidget(widget);
		}
	});
}

function appendImagePreviewCards(node, parent, images) {
	const imageGrid = document.createElement("div");
	imageGrid.style.cssText = [
		"display:grid",
		"grid-template-columns:repeat(auto-fill, minmax(110px, 1fr))",
		"gap:8px",
		"width:100%",
	].join(";");

	for (const [index, item] of images.entries()) {
		const card = document.createElement("div");
		card.style.cssText = [
			"position:relative",
			"aspect-ratio:1/1",
			"overflow:hidden",
			"border-radius:7px",
			"background:#0c1114",
			"cursor:pointer",
		].join(";");

		const image = document.createElement("img");
		image.src = imageDataToUrl(item);
		image.draggable = false;
		image.style.cssText = [
			"width:100%",
			"height:100%",
			"object-fit:cover",
			"display:block",
		].join(";");
		image.onload = () => scheduleLayout(node);
		image.onerror = () => scheduleLayout(node);

		const badge = document.createElement("div");
		badge.textContent = `${index + 1}`;
		badge.style.cssText = [
			"position:absolute",
			"top:5px",
			"left:5px",
			"min-width:20px",
			"height:20px",
			"padding:0 5px",
			"border-radius:10px",
			"background:rgba(0, 0, 0, 0.55)",
			"color:#fff",
			"font-size:10px",
			"display:flex",
			"align-items:center",
			"justify-content:center",
			"pointer-events:none",
		].join(";");

		card.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();

			const overlay = document.createElement("div");
			overlay.style.cssText = [
				"position:fixed",
				"inset:0",
				"background:rgba(0, 0, 0, 0.9)",
				"z-index:10000",
				"display:flex",
				"align-items:center",
				"justify-content:center",
				"cursor:zoom-out",
			].join(";");

			const previewImg = document.createElement("img");
			previewImg.src = imageDataToUrl(item);
			previewImg.style.cssText = [
				"max-width:90%",
				"max-height:90%",
				"object-fit:contain",
				"border-radius:8px",
			].join(";");

			overlay.appendChild(previewImg);
			overlay.addEventListener("click", () => overlay.remove());
			document.body.appendChild(overlay);
		});

		card.appendChild(image);
		card.appendChild(badge);
		imageGrid.appendChild(card);
	}

	parent.appendChild(imageGrid);
}

function clearImageSequenceTimers(node) {
	for (const timer of node?.__gjjAnyPreviewSequenceTimers || []) {
		clearInterval(timer);
	}
	if (node) {
		node.__gjjAnyPreviewSequenceTimers = [];
	}
}

function appendCompactMediaInfo(node, parent, tagName, item, description = "") {
	const row = document.createElement("div");
	row.style.cssText = [
		"display:grid",
		"grid-template-columns:auto minmax(0, 1fr) auto",
		"align-items:start",
		"column-gap:6px",
		"row-gap:4px",
		"flex:1 1 0",
		"gap:6px",
		"min-width:0",
		"width:100%",
		"max-width:100%",
		"box-sizing:border-box",
		"font-size:12px",
		"line-height:1.35",
		"color:#cfe0dc",
	].join(";");

	const icon = document.createElement("span");
	icon.textContent = mediaEmoji(tagName, item);
	icon.style.cssText = "line-height:1.35";

	const textWrap = document.createElement("span");
	textWrap.style.cssText = [
		"min-width:0",
		"max-width:100%",
		"display:block",
		"white-space:normal",
		"overflow-wrap:anywhere",
		"word-break:break-word",
	].join(";");

	const filename = document.createElement("span");
	filename.textContent = item?.filename || (tagName === "video" ? "视频" : "音频");
	filename.title = filename.textContent;
	filename.style.cssText = [
		"display:inline",
		"min-width:0",
		"white-space:normal",
		"overflow-wrap:anywhere",
		"word-break:break-word",
		"font-weight:600",
		"color:#e7f3ef",
	].join(";");

	const metaText = compactPreviewText(description);
	const meta = document.createElement("span");
	meta.textContent = metaText ? ` · ${metaText}` : "";
	meta.title = String(description || metaText || "");
	meta.style.cssText = [
		"display:inline",
		"white-space:normal",
		"overflow-wrap:anywhere",
		"word-break:break-word",
		"color:#aebfbb",
	].join(";");

	const folder = document.createElement("button");
	folder.type = "button";
	folder.textContent = "📁";
	folder.title = "打开所在目录";
	folder.style.cssText = [
		"flex:0 0 auto",
		"border:1px solid #34464e",
		"border-radius:5px",
		"background:#182329",
		"color:#e7f3ef",
		"width:24px",
		"height:22px",
		"padding:0",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"font-size:12px",
		"cursor:pointer",
	].join(";");
	folder.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openMediaFolder(item || {}, folder);
	});

	textWrap.append(filename, meta);
	row.append(icon, textWrap, folder);
	parent.appendChild(row);
}

function styleCompactAudioPlayer(player) {
	if (!player) return;
	player.style.cssText = [
		"width:100%",
		`height:${AUDIO_PLAYER_HEIGHT}px`,
		`min-height:${AUDIO_PLAYER_HEIGHT}px`,
		`max-height:${AUDIO_PLAYER_HEIGHT}px`,
		"display:block",
		"border-radius:5px",
		"overflow:hidden",
	].join(";");
}

function getAudioWaveformContext() {
	if (audioWaveformContext) return audioWaveformContext;
	const AudioContextClass = window.AudioContext || window.webkitAudioContext;
	if (!AudioContextClass) return null;
	audioWaveformContext = new AudioContextClass();
	return audioWaveformContext;
}

function decodeAudioForWaveform(audioUrl) {
	const key = String(audioUrl || "");
	if (!key) return Promise.reject(new Error("音频地址为空"));
	if (audioWaveformCache.has(key)) return audioWaveformCache.get(key);
	const promise = fetch(key)
		.then((response) => {
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return response.arrayBuffer();
		})
		.then((buffer) => {
			const context = getAudioWaveformContext();
			if (!context) throw new Error("当前浏览器不支持 AudioContext");
			return context.decodeAudioData(buffer.slice(0));
		})
		.catch((error) => {
			audioWaveformCache.delete(key);
			throw error;
		});
	audioWaveformCache.set(key, promise);
	if (audioWaveformCache.size > 24) {
		const firstKey = audioWaveformCache.keys().next().value;
		audioWaveformCache.delete(firstKey);
	}
	return promise;
}

function resizeWaveformCanvas(canvas) {
	const ratio = Math.max(1, window.devicePixelRatio || 1);
	const width = Math.max(240, Math.floor(canvas.clientWidth || canvas.parentElement?.clientWidth || 300));
	const height = Math.max(40, Math.floor(canvas.clientHeight || AUDIO_WAVEFORM_HEIGHT));
	const pixelWidth = Math.floor(width * ratio);
	const pixelHeight = Math.floor(height * ratio);
	if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
		canvas.width = pixelWidth;
		canvas.height = pixelHeight;
	}
	const ctx = canvas.getContext("2d");
	if (ctx) ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
	return { width, height, ctx };
}

function drawWaveformPlaceholder(canvas, text = "正在读取波形...") {
	const { width, height, ctx } = resizeWaveformCanvas(canvas);
	if (!ctx) return;
	ctx.clearRect(0, 0, width, height);
	ctx.fillStyle = "#0a1115";
	ctx.fillRect(0, 0, width, height);
	ctx.strokeStyle = "rgba(255,255,255,0.07)";
	ctx.beginPath();
	ctx.moveTo(0, height / 2);
	ctx.lineTo(width, height / 2);
	ctx.stroke();
	ctx.fillStyle = "#8ea0a8";
	ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
	ctx.textBaseline = "middle";
	ctx.fillText(text, 12, height / 2);
}

function getWaveformPeaks(audioBuffer, columns) {
	const key = Math.max(1, Math.floor(columns || 1));
	let byWidth = audioWaveformPeaks.get(audioBuffer);
	if (!byWidth) {
		byWidth = new Map();
		audioWaveformPeaks.set(audioBuffer, byWidth);
	}
	if (byWidth.has(key)) return byWidth.get(key);

	const channelCount = Math.max(1, Math.min(2, audioBuffer.numberOfChannels || 1));
	const length = audioBuffer.length || 0;
	const samplesPerColumn = Math.max(1, Math.floor(length / key));
	const peaks = new Float32Array(key);
	for (let x = 0; x < key; x += 1) {
		const start = x * samplesPerColumn;
		const end = Math.min(length, start + samplesPerColumn);
		let peak = 0;
		for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
			const data = audioBuffer.getChannelData(channelIndex);
			for (let i = start; i < end; i += 1) {
				const value = Math.abs(data[i] || 0);
				if (value > peak) peak = value;
			}
		}
		peaks[x] = peak;
	}
	byWidth.set(key, peaks);
	if (byWidth.size > 8) {
		const firstKey = byWidth.keys().next().value;
		byWidth.delete(firstKey);
	}
	return peaks;
}

function drawDecodedWaveform(canvas, audioBuffer, player = null) {
	const { width, height, ctx } = resizeWaveformCanvas(canvas);
	if (!ctx || !audioBuffer) return;
	const center = Math.round(height / 2);
	const usableHeight = Math.max(16, height - 18);
	const amp = usableHeight / 2;
	const columns = Math.max(1, Math.floor(width));
	const peaks = getWaveformPeaks(audioBuffer, columns);

	ctx.clearRect(0, 0, width, height);
	ctx.fillStyle = "#081015";
	ctx.fillRect(0, 0, width, height);

	ctx.strokeStyle = "rgba(255,255,255,0.06)";
	ctx.lineWidth = 1;
	for (let i = 1; i < 4; i += 1) {
		const y = Math.round((height * i) / 4);
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(width, y);
		ctx.stroke();
	}

	const gradient = ctx.createLinearGradient(0, 0, width, 0);
	gradient.addColorStop(0, "#77d4c4");
	gradient.addColorStop(0.55, "#b7e28b");
	gradient.addColorStop(1, "#f1ca73");
	ctx.strokeStyle = gradient;
	ctx.lineWidth = 1;

	for (let x = 0; x < columns; x += 1) {
		const peak = peaks[x] || 0;
		const bar = Math.max(1, Math.min(amp, peak * amp));
		ctx.beginPath();
		ctx.moveTo(x + 0.5, center - bar);
		ctx.lineTo(x + 0.5, center + bar);
		ctx.stroke();
	}

	if (player && Number.isFinite(player.duration) && player.duration > 0) {
		const progress = Math.max(0, Math.min(1, Number(player.currentTime || 0) / player.duration));
		const cursorX = Math.round(progress * width) + 0.5;
		ctx.strokeStyle = "#ffffff";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(cursorX, 5);
		ctx.lineTo(cursorX, height - 5);
		ctx.stroke();
	}
}

function appendAudioWaveform(node, parent, audioUrl, player) {
	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"position:relative",
		"width:100%",
		`height:${AUDIO_WAVEFORM_HEIGHT}px`,
		"border:1px solid #263a42",
		"border-radius:7px",
		"background:#081015",
		"overflow:hidden",
		"box-sizing:border-box",
		"cursor:pointer",
	].join(";");

	const canvas = document.createElement("canvas");
	canvas.style.cssText = [
		"width:100%",
		`height:${AUDIO_WAVEFORM_HEIGHT}px`,
		"display:block",
	].join(";");
	wrap.appendChild(canvas);
	parent.appendChild(wrap);

	let decodedBuffer = null;
	const redraw = () => {
		if (decodedBuffer) drawDecodedWaveform(canvas, decodedBuffer, player);
		else drawWaveformPlaceholder(canvas);
	};

	drawWaveformPlaceholder(canvas);
	decodeAudioForWaveform(audioUrl)
		.then((audioBuffer) => {
			decodedBuffer = audioBuffer;
			drawDecodedWaveform(canvas, decodedBuffer, player);
			scheduleLayout(node);
		})
		.catch((error) => {
			console.warn("[GJJ AnyPreview] 绘制音频波形失败:", error);
			drawWaveformPlaceholder(canvas, "波形解码失败，仍可使用下方播放条");
			scheduleLayout(node);
		});

	if (player) {
		player.addEventListener("timeupdate", redraw);
		player.addEventListener("seeked", redraw);
		player.addEventListener("loadedmetadata", redraw);
	}
	wrap.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (!player || !decodedBuffer || !Number.isFinite(player.duration) || player.duration <= 0) return;
		const rect = wrap.getBoundingClientRect();
		const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
		player.currentTime = ratio * player.duration;
		drawDecodedWaveform(canvas, decodedBuffer, player);
	});
	if (window.ResizeObserver) {
		const observer = new ResizeObserver(redraw);
		observer.observe(wrap);
	}
	requestAnimationFrame(redraw);
}

function appendAnimatedSequenceImage(node, parent, item, description = "") {
	if (!item) {
		return;
	}
	const mediaCard = document.createElement("div");
	mediaCard.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"width:100%",
		"box-sizing:border-box",
	].join(";");

	const stage = document.createElement("div");
	stage.style.cssText = [
		"position:relative",
		"width:100%",
		"aspect-ratio:16/9",
		"min-height:160px",
		"max-height:360px",
		"overflow:hidden",
		"border-radius:6px",
		"background:#0c1114",
	].join(";");

	const image = document.createElement("img");
	image.src = imageDataToUrl(item);
	image.draggable = false;
	image.style.cssText = [
		"width:100%",
		"height:100%",
		"object-fit:contain",
		"display:block",
	].join(";");
	image.onload = () => scheduleLayout(node);
	image.onerror = () => scheduleLayout(node);

	stage.appendChild(image);
	mediaCard.appendChild(stage);
	appendCompactMediaInfo(node, mediaCard, "video", item, description);
	parent.appendChild(mediaCard);
}

function appendImageSequencePlayer(node, parent, images, description = "") {
	const frames = normalizeMediaPayload(images);
	if (!frames.length) {
		return;
	}
	const playerCard = document.createElement("div");
	playerCard.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"width:100%",
		"box-sizing:border-box",
	].join(";");

	const stage = document.createElement("div");
	stage.style.cssText = [
		"position:relative",
		"width:100%",
		"aspect-ratio:16/9",
		"min-height:160px",
		"max-height:360px",
		"overflow:hidden",
		"border-radius:6px",
		"background:#0c1114",
	].join(";");

	const image = document.createElement("img");
	image.draggable = false;
	image.src = imageDataToUrl(frames[0]);
	image.style.cssText = [
		"width:100%",
		"height:100%",
		"object-fit:contain",
		"display:block",
	].join(";");
	image.onload = () => scheduleLayout(node);

	const badge = document.createElement("div");
	badge.textContent = `1/${frames.length}`;
	badge.style.cssText = [
		"position:absolute",
		"right:8px",
		"top:8px",
		"padding:3px 7px",
		"border-radius:999px",
		"background:rgba(0,0,0,.58)",
		"color:#fff",
		"font-size:11px",
		"line-height:1.2",
		"pointer-events:none",
	].join(";");

	const toolbar = document.createElement("div");
	toolbar.style.cssText = [
		"display:flex",
		"align-items:center",
		"gap:8px",
		"font-size:12px",
		"color:#dce7e2",
	].join(";");

	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.textContent = "暂停";
	toggle.title = "播放/暂停动态序列预览";
	toggle.style.cssText = [
		"border:1px solid #3a4d56",
		"border-radius:6px",
		"background:#182329",
		"color:#e7f3ef",
		"padding:4px 9px",
		"font-size:12px",
		"cursor:pointer",
	].join(";");

	let frameIndex = 0;
	let playing = true;
	const renderFrame = () => {
		const frame = frames[frameIndex % frames.length];
		image.src = imageDataToUrl(frame);
		badge.textContent = `${frameIndex + 1}/${frames.length}`;
	};
	const timer = setInterval(() => {
		if (!document.body.contains(playerCard)) {
			clearInterval(timer);
			return;
		}
		if (!playing) {
			return;
		}
		frameIndex = (frameIndex + 1) % frames.length;
		renderFrame();
	}, Math.max(80, Math.round(1000 / IMAGE_SEQUENCE_PREVIEW_FPS)));
	if (!Array.isArray(node.__gjjAnyPreviewSequenceTimers)) {
		node.__gjjAnyPreviewSequenceTimers = [];
	}
	node.__gjjAnyPreviewSequenceTimers.push(timer);

	toggle.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		playing = !playing;
		toggle.textContent = playing ? "暂停" : "播放";
	});

	const sequenceDescription =
		description || `帧数: ${frames.length}, 预览帧率: ${IMAGE_SEQUENCE_PREVIEW_FPS}fps`;

	stage.append(image, badge);
	toolbar.append(toggle);
	appendCompactMediaInfo(node, toolbar, "video", frames[0], sequenceDescription);
	playerCard.append(stage, toolbar);
	parent.appendChild(playerCard);
}

function appendMediaPlayers(node, parent, tagName, mediaItems, description = "") {
	for (const item of mediaItems) {
		const mediaCard = document.createElement("div");
		mediaCard.style.cssText = [
			"display:flex",
			"flex-direction:column",
			"gap:8px",
			"width:100%",
		].join(";");

		const player = document.createElement(tagName);
		player.controls = true;
		player.src = imageDataToUrl(item);
		player.preload = "metadata";
		const shouldAutoLoop = tagName === "video" && Boolean(item?.is_sequence || item?.loop || item?.autoplay);
		if (shouldAutoLoop) {
			player.loop = true;
			player.autoplay = true;
			player.muted = true;
			player.playsInline = true;
		}
		player.style.cssText =
			tagName === "video"
				? [
						"width:100%",
						"max-height:320px",
						"object-fit:contain",
						"background:#0c1114",
						"border-radius:6px",
				  ].join(";")
				: "";
		if (tagName === "audio") {
			styleCompactAudioPlayer(player);
		}
		player.addEventListener("loadedmetadata", () => scheduleLayout(node));
		if (shouldAutoLoop) {
			player.addEventListener("canplay", () => {
				const promise = player.play?.();
				if (promise?.catch) {
					promise.catch(() => {});
				}
			}, { once: true });
		}

		if (tagName === "audio") {
			appendAudioWaveform(node, mediaCard, player.src, player);
		}
		mediaCard.appendChild(player);
		appendCompactMediaInfo(node, mediaCard, tagName, item, description);
		parent.appendChild(mediaCard);
	}
}

function renderPreviewItems(node, items) {
	const container = node.__gjjAnyPreviewContainer;
	const body = node.__gjjAnyPreviewBody;
	const grid = node.__gjjAnyPreviewGrid;
	const empty = node.__gjjAnyPreviewEmpty;
	const previewWrap = node.__gjjAnyPreviewWrap;
	const editor = node.__gjjAnyPreviewEditor;
	if (!container || !body || !grid || !empty) {
		return;
	}

	body.style.display = "none";
	if (editor) editor.style.display = "none";
	empty.style.display = "none";
	container.style.height = "auto";
	container.style.minHeight = `${MIN_PREVIEW_HEIGHT}px`;
	if (previewWrap) {
		previewWrap.style.overflow = "visible";
		previewWrap.style.height = "auto";
		previewWrap.style.minHeight = "96px";
	}

	grid.style.display = "flex";
	grid.style.flexDirection = "column";
	grid.style.gridTemplateColumns = "1fr";
	grid.style.gap = "8px";
	grid.style.height = "auto";
	grid.style.alignItems = "stretch";
	clearImageSequenceTimers(node);
	grid.replaceChildren();

	for (const [index, item] of items.entries()) {
		const card = document.createElement("div");
		card.style.cssText = [
			"display:flex",
			"flex-direction:column",
			"gap:8px",
			"padding:10px",
			"border:1px solid #33434a",
			"border-radius:8px",
			"background:#12191d",
			"box-sizing:border-box",
		].join(";");

		const title = document.createElement("div");
		title.textContent = item.title || `项目 ${index + 1}`;
		title.style.cssText = [
			"font-size:12px",
			"font-weight:700",
			"color:#e7f3ef",
			"line-height:1.3",
		].join(";");
		card.appendChild(title);

		const images = normalizeMediaPayload(item.images);
		const audio = normalizeMediaPayload(item.audio);
		const video = normalizeMediaPayload(item.video);
		const text = String(item.text || "").trim();
		const sequenceImage = images.find(isSequenceMediaItem);
		let renderedEmojiSummary = false;
		if (sequenceImage && !audio.length && !video.length) {
			appendAnimatedSequenceImage(node, card, sequenceImage, text);
			renderedEmojiSummary = true;
		} else if (images.length >= IMAGE_SEQUENCE_MIN_FRAMES && !audio.length && !video.length) {
			appendImageSequencePlayer(node, card, images, text);
			renderedEmojiSummary = true;
		} else if (images.length) {
			appendImagePreviewCards(node, card, images);
		}
		if (audio.length) {
			appendMediaPlayers(node, card, "audio", audio, text);
		}
		if (video.length) {
			appendMediaPlayers(node, card, "video", video, text);
		}

		if (text && !audio.length && !video.length && images.length < IMAGE_SEQUENCE_MIN_FRAMES && !renderedEmojiSummary) {
			const textBlock = document.createElement("div");
			textBlock.className = "gjj-text-input-markdown-body";
			textBlock.innerHTML = renderMarkdown(text);
			textBlock.style.cssText = [
				"background:transparent",
				"color:#d9e4df",
				"font-size:12px",
				"line-height:1.45",
				"white-space:normal",
				"overflow:visible",
				"user-select:text",
				"-webkit-user-select:text",
			].join(";");
			clampTextPreviewLines(textBlock);
			card.appendChild(textBlock);
		}

		grid.appendChild(card);
	}
}

function applyPreviewContent(node) {
	const container = node.__gjjAnyPreviewContainer;
	const body = node.__gjjAnyPreviewBody;
	const grid = node.__gjjAnyPreviewGrid;
	const empty = node.__gjjAnyPreviewEmpty;
	const previewWrap = node.__gjjAnyPreviewWrap;
	const editor = node.__gjjAnyPreviewEditor;
	if (!container || !body || !grid || !empty) {
		return;
	}

	const kind = String(node.__gjjAnyPreviewKind || "").trim();
	const text = String(node.__gjjAnyPreviewText || "").trim() || EMPTY_PREVIEW;
	const images = Array.isArray(node.__gjjAnyPreviewImages)
		? node.__gjjAnyPreviewImages
		: [];
	const audio = Array.isArray(node.__gjjAnyPreviewAudio)
		? node.__gjjAnyPreviewAudio
		: [];
	const video = Array.isArray(node.__gjjAnyPreviewVideo)
		? node.__gjjAnyPreviewVideo
		: [];
	const previewItems = Array.isArray(node.__gjjAnyPreviewItems)
		? node.__gjjAnyPreviewItems
		: [];
	const showImage = kind === "image" && images.length > 0;
	const showAudio = kind === "audio" && audio.length > 0;
	const showVideo = kind === "video" && video.length > 0;
	const hasText = Boolean(String(node.__gjjAnyPreviewText || "").trim());
	const isTextOnly = !showImage && !showAudio && !showVideo && hasText;
	const mode = isTextOnly ? getMode(node) : MODE_PREVIEW;

	const availableHeight = getWidgetHeight(node, node.__gjjAnyPreviewWidget);

	const isMediaPreview = showImage || showAudio || showVideo;
	const useEstimatedImageLayout = showImage && shouldUseEstimatedImageLayout(node);

	grid.style.display = isMediaPreview ? (showImage ? "grid" : "flex") : "none";
	grid.style.flexDirection = "";

	if (previewItems.length > 0) {
		renderPreviewItems(node, previewItems);
		requestAnimationFrame(() => {
			const height = Math.max(
				MIN_PREVIEW_HEIGHT,
				Math.ceil(
					container.scrollHeight ||
						container.offsetHeight ||
						MIN_PREVIEW_HEIGHT,
				),
			);
			if (node.__gjjAnyPreviewHeight !== height) {
				node.__gjjAnyPreviewHeight = height;
			}
			scheduleLayout(node);
		});
		return;
	}

	if (showImage) {
		body.style.display = "none";
		if (editor) editor.style.display = "none";
	} else if ((showAudio || showVideo) && hasText) {
		body.style.display = mode === MODE_PREVIEW ? "block" : "none";
		if (editor) editor.style.display = mode === MODE_EDIT ? "block" : "none";
	} else if (!isMediaPreview && hasText) {
		body.style.display = mode === MODE_PREVIEW ? "block" : "none";
		if (editor) editor.style.display = mode === MODE_EDIT ? "block" : "none";
	} else {
		body.style.display = "none";
		if (editor) editor.style.display = "none";
	}

	empty.style.display = (!isMediaPreview && !hasText) ? "flex" : "none";

	container.style.height = "auto";
	container.style.minHeight = `${MIN_PREVIEW_HEIGHT}px`;

	if (previewWrap) {
		previewWrap.style.overflow = useEstimatedImageLayout ? "auto" : "visible";
		previewWrap.style.height = useEstimatedImageLayout ? `${availableHeight}px` : "auto";
		previewWrap.style.minHeight = useEstimatedImageLayout ? `${availableHeight}px` : "96px";
	}

	const sequenceImage = images.find(isSequenceMediaItem);
	if (showImage && sequenceImage) {
		clearImageSequenceTimers(node);
		grid.style.display = "flex";
		grid.style.flexDirection = "column";
		grid.style.gridTemplateColumns = "1fr";
		grid.style.gap = "8px";
		grid.style.height = "auto";
		grid.style.alignItems = "stretch";
		grid.replaceChildren();
		appendAnimatedSequenceImage(node, grid, sequenceImage, hasText ? text : "");
		body.style.display = "none";
	} else if (showImage && images.length >= IMAGE_SEQUENCE_MIN_FRAMES) {
		clearImageSequenceTimers(node);
		grid.style.display = "flex";
		grid.style.flexDirection = "column";
		grid.style.gridTemplateColumns = "1fr";
		grid.style.gap = "8px";
		grid.style.height = "auto";
		grid.style.alignItems = "stretch";
		grid.replaceChildren();
		appendImageSequencePlayer(node, grid, images, hasText ? text : "");
		body.style.display = "none";
	} else if (showImage) {
		const isSingleImage = images.length === 1;

		// 单图和多图使用不同的样式
		grid.style.gridTemplateColumns = isSingleImage
			? "repeat(1, minmax(0, 1fr))"
			: "repeat(auto-fill, minmax(140px, 1fr))";
		grid.style.gap = "8px";
		grid.style.height = "auto";
		grid.style.alignItems = "start";
		grid.replaceChildren();

		for (const [index, item] of images.entries()) {
			const card = document.createElement("div");
			card.style.cssText = [
				"position:relative",
				"width:100%",
				"aspect-ratio:1/1",
				"overflow:hidden",
				"border-radius:6px",
				"cursor:pointer",
				"transition:transform 0.2s ease",
				"background:#12191d",
			].join(";");

			// 鼠标悬停效果
			card.addEventListener("mouseenter", () => {
				card.style.transform = "scale(1.05)";
			});
			card.addEventListener("mouseleave", () => {
				card.style.transform = "scale(1)";
			});

			// 图片元素 - 使用object-fit:cover撑满画布
			const image = document.createElement("img");
			image.src = imageDataToUrl(item);
			image.draggable = false;
			image.style.cssText = [
				"width:100%",
				"height:100%",
				"object-fit:cover",
				"display:block",
			].join(";");

			// 图片加载完成后更新尺寸
			image.onload = () => {
				if (sizeBadge) {
					sizeBadge.textContent = `${image.naturalWidth}×${image.naturalHeight}`;
				}
				scheduleLayout(node);
			};
			image.onerror = () => {
				if (sizeBadge) {
					sizeBadge.textContent = "加载失败";
				}
				scheduleLayout(node);
			};

			// 左上角：图片序号
			const indexBadge = document.createElement("div");
			indexBadge.textContent = `${index + 1}`;
			indexBadge.style.cssText = [
				"position:absolute",
				"top:6px",
				"left:6px",
				"min-width:24px",
				"height:24px",
				"padding:0 6px",
				"border-radius:12px",
				"background:rgba(0, 0, 0, 0.5)",
				"backdrop-filter:blur(4px)",
				"color:#fff",
				"font-size:11px",
				"font-weight:bold",
				"display:flex",
				"align-items:center",
				"justify-content:center",
				"pointer-events:none",
				"z-index:2",
			].join(";");

			// 右上角：图片尺寸
			const sizeBadge = document.createElement("div");
			sizeBadge.style.cssText = [
				"position:absolute",
				"top:6px",
				"right:6px",
				"padding:2px 8px",
				"border-radius:4px",
				"background:rgba(0, 0, 0, 0.5)",
				"backdrop-filter:blur(4px)",
				"color:#fff",
				"font-size:10px",
				"pointer-events:none",
				"z-index:2",
				"white-space:nowrap",
			].join(";");

			// 初始显示加载中
			sizeBadge.textContent = "加载中...";

			// 点击图片放大查看（带滚轮缩放）
			card.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();

				// 创建全屏预览
				const overlay = document.createElement("div");
				overlay.style.cssText = [
					"position:fixed",
					"inset:0",
					"background:rgba(0, 0, 0, 0.9)",
					"backdrop-filter:blur(10px)",
					"z-index:10000",
					"display:flex",
					"align-items:center",
					"justify-content:center",
					"cursor:zoom-out",
				].join(";");

				const previewImg = document.createElement("img");
				previewImg.src = imageDataToUrl(item);
				previewImg.style.cssText = [
					"max-width:90%",
					"max-height:90%",
					"object-fit:contain",
					"border-radius:8px",
					"box-shadow:0 0 40px rgba(0, 0, 0, 0.5)",
					"transition:transform 0.1s ease",
					"cursor:grab",
				].join(";");

				// 滚轮缩放功能
				let currentScale = 1;
				const minScale = 0.1;
				const maxScale = 10;

				overlay.addEventListener("wheel", (e) => {
					e.preventDefault();
					e.stopPropagation();

					const delta = e.deltaY > 0 ? -0.1 : 0.1;
					currentScale = Math.max(minScale, Math.min(maxScale, currentScale + delta));
					previewImg.style.transform = `scale(${currentScale})`;
				});

				// 双击重置缩放
				previewImg.addEventListener("dblclick", (e) => {
					e.stopPropagation();
					currentScale = 1;
					previewImg.style.transform = `scale(${currentScale})`;
				});

				// 提示文字
				const hint = document.createElement("div");
				hint.style.cssText = [
					"position:absolute",
					"bottom:20px",
					"left:50%",
					"transform:translateX(-50%)",
					"color:#fff",
					"font-size:13px",
					"opacity:0.6",
					"pointer-events:none",
					"white-space:nowrap",
				].join(";");
				hint.textContent = "滚轮缩放 · 双击重置 · 点击关闭";

				overlay.appendChild(previewImg);
				overlay.appendChild(hint);
				document.body.appendChild(overlay);

				// 点击关闭
				overlay.addEventListener("click", () => {
					overlay.remove();
				});
			});

			// 组装卡片
			card.appendChild(image);
			card.appendChild(indexBadge);
			card.appendChild(sizeBadge);
			grid.appendChild(card);
		}
		// 图片预览分支结束，body 已在前置逻辑中隐藏
	} else if (showAudio) {
		// 音频预览：播放器下方用一行紧凑信息展示文件和元数据。
		grid.style.gridTemplateColumns = "1fr";
		grid.style.height = "auto";
		grid.style.alignItems = "center";
		grid.replaceChildren();

		const audioItem = audio[0];
		const audioUrl = imageDataToUrl(audioItem);

		const audioCard = document.createElement("div");
		audioCard.style.cssText = [
			"display:flex",
			"flex-direction:column",
			"gap:10px",
			"padding:12px",
			"border:1px solid #33434a",
			"border-radius:8px",
			"background:#12191d",
			"width:100%",
			"box-sizing:border-box",
		].join(";");

		const audioPlayer = document.createElement("audio");
		audioPlayer.controls = true;
		audioPlayer.src = audioUrl;
		audioPlayer.preload = "metadata";
		styleCompactAudioPlayer(audioPlayer);

		appendAudioWaveform(node, audioCard, audioUrl, audioPlayer);
		audioCard.appendChild(audioPlayer);
		appendCompactMediaInfo(node, audioCard, "audio", audioItem, hasText ? text : "");
		grid.appendChild(audioCard);
		body.style.display = "none";
	} else if (showVideo) {
		// 视频预览：播放器下方用一行紧凑信息展示文件和元数据。
		grid.style.gridTemplateColumns = "1fr";
		grid.style.height = "auto";
		grid.style.alignItems = "center";
		grid.replaceChildren();

		const videoItem = video[0];
		const videoUrl = imageDataToUrl(videoItem);

		const videoCard = document.createElement("div");
		videoCard.style.cssText = [
			"display:flex",
			"flex-direction:column",
			"gap:10px",
			"padding:12px",
			"border:1px solid #33434a",
			"border-radius:8px",
			"background:#12191d",
			"width:100%",
			"box-sizing:border-box",
		].join(";");

		const videoPlayer = document.createElement("video");
		videoPlayer.controls = true;
		videoPlayer.src = videoUrl;
		videoPlayer.preload = "metadata";
		videoPlayer.style.cssText = [
			"width:100%",
			"max-height:320px",
			"object-fit:contain",
			"background:#0c1114",
			"border-radius:6px",
		].join(";");

		videoCard.appendChild(videoPlayer);
		appendCompactMediaInfo(node, videoCard, "video", videoItem, hasText ? text : "");
		grid.appendChild(videoCard);
		body.style.display = "none";
	} else {
		grid.style.gridTemplateColumns = "repeat(auto-fit, minmax(140px, 1fr))";
		grid.style.height = "";
		grid.style.alignItems = "";

		if (!showImage && !showAudio && !showVideo && hasText) {
			body.innerHTML = renderMarkdown(text);
			clampTextPreviewLines(body);
			body.title = "双击复制";

			const handleDblClick = (e) => {
				if (e.target.closest("a, img, pre, code")) {
					return;
				}
				navigator.clipboard
					.writeText(String(node.__gjjAnyPreviewText || ""))
					.then(() => {
						const originalBackgroundColor = body.style.backgroundColor;
						body.style.backgroundColor = "#4a7a4a";
						setTimeout(() => {
							body.style.backgroundColor = originalBackgroundColor || "transparent";
						}, 200);
					})
					.catch((err) => {
						console.error("无法复制到剪贴板:", err);
						try {
							const textArea = document.createElement("textarea");
							textArea.value = String(node.__gjjAnyPreviewText || "");
							textArea.style.position = "fixed";
							textArea.style.left = "-999999px";
							textArea.style.top = "-999999px";
							document.body.appendChild(textArea);
							textArea.focus();
							textArea.select();
							const successful = document.execCommand("copy");
							document.body.removeChild(textArea);
							if (successful) {
								const originalBackgroundColor = body.style.backgroundColor;
								body.style.backgroundColor = "#4a7a4a";
								setTimeout(() => {
									body.style.backgroundColor = originalBackgroundColor || "transparent";
								}, 200);
							}
						} catch (error) {
							console.error("降级复制方法失败:", error);
						}
					});
			};

			if (body.__gjjDblClickHandler) {
				body.removeEventListener("dblclick", body.__gjjDblClickHandler);
				body.removeEventListener("pointerdown", body.__gjjPointerHandler);
				body.removeEventListener("mousedown", body.__gjjPointerHandler);
			}
			body.__gjjDblClickHandler = handleDblClick;
			const pointerHandler = (e) => handlePreviewPointer(node, e);
			body.__gjjPointerHandler = pointerHandler;
			body.addEventListener("dblclick", handleDblClick);
			body.addEventListener("pointerdown", pointerHandler);
			body.addEventListener("mousedown", pointerHandler);
			body.style.cursor = "pointer";
		} else {
			body.innerHTML = renderMarkdown(text);
			clampTextPreviewLines(body);
		}
	}

	requestAnimationFrame(() => {
		const height = useEstimatedImageLayout
			? availableHeight
			: Math.max(
					MIN_PREVIEW_HEIGHT,
					Math.ceil(
						container.scrollHeight ||
							container.offsetHeight ||
							MIN_PREVIEW_HEIGHT,
					),
			  );
		if (node.__gjjAnyPreviewHeight !== height) {
			node.__gjjAnyPreviewHeight = height;
		}
		scheduleLayout(node);
	});
}

function getLoraEffectLiveText(node) {
	if (!node) {
		return null;
	}
	const sourceId = node.__gjjLoraEffectLiveSourceId;
	const outputIndex = Number(node.__gjjLoraEffectLiveOutputIndex ?? 2);
	const sourceNode =
		sourceId != null ? app.graph?.getNodeById?.(sourceId) : null;
	const liveTextByNodeId = globalThis[LORA_EFFECT_LIVE_TEXT_MAP_KEY] || {};
	if (sourceNode) {
		const links = Array.isArray(sourceNode?.outputs?.[outputIndex]?.links)
			? sourceNode.outputs[outputIndex].links
			: [];
		const stillLinked = links.some(
			(linkId) => app.graph?.links?.[linkId]?.target_id === node.id,
		);
		if (stillLinked) {
			const sourceTexts =
				sourceNode.__gjjLoraEffectLiveTexts ||
				liveTextByNodeId[String(sourceNode.id)] ||
				{};
			const text =
				sourceTexts[String(outputIndex)] ?? node.__gjjLoraEffectLiveText;
			if (text !== undefined) {
				node.__gjjLoraEffectLiveText = String(text || "");
				return String(text || "");
			}
		}
		delete node.__gjjLoraEffectLiveText;
		delete node.__gjjLoraEffectLiveSourceId;
		delete node.__gjjLoraEffectLiveOutputIndex;
	}
	for (const input of getInputs(node)) {
		const link = input?.link ? app.graph?.links?.[input.link] : null;
		const origin =
			link?.origin_id != null ? app.graph?.getNodeById?.(link.origin_id) : null;
		if (origin?.comfyClass !== "GJJ_LoraEffectTester") {
			continue;
		}
		const originSlot = Number(link?.origin_slot ?? 2);
		const originTexts =
			origin.__gjjLoraEffectLiveTexts ||
			liveTextByNodeId[String(origin.id)] ||
			{};
		const text = originTexts[String(originSlot)];
		if (text !== undefined) {
			node.__gjjLoraEffectLiveText = String(text || "");
			node.__gjjLoraEffectLiveSourceId = origin.id;
			node.__gjjLoraEffectLiveOutputIndex = originSlot;
			return String(text || "");
		}
	}
	return null;
}

function ensurePreviewWidget(node) {
	hideLegacyPreviewWidgets(node);
	if (node.__gjjAnyPreviewContainer) {
		applyPreviewContent(node);
		scheduleLayout(node);
		return;
	}

	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
		"margin-top:4px",
		"user-select:text",
		"-webkit-user-select:text",
		"pointer-events:auto",
		"cursor:text",
	].join(";");

	const body = document.createElement("div");
	body.className = "gjj-text-input-markdown-body";
	body.style.cssText = [
		"background:transparent",
		"color:#d9e4df",
		"font-size:12px",
		"line-height:1.45",
		"white-space:normal",
		"overflow:visible",
		"user-select:text",
		"-webkit-user-select:text",
		"pointer-events:auto",
		"cursor:text",
	].join(";");

	const previewWrap = document.createElement("div");
	previewWrap.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"position:relative",
		"border:1px solid #33434a",
		"border-radius:10px",
		"background:#0f1418",
		"padding:8px",
		"box-sizing:border-box",
		"overflow:visible",
		"min-height:96px",
		"user-select:text",
		"-webkit-user-select:text",
		"pointer-events:auto",
		"cursor:text",
	].join(";");

	// 添加Markdown预览的CSS样式
	const style = document.createElement("style");
	style.textContent = `
		.gjj-text-input-markdown-body h1,
		.gjj-text-input-markdown-body h2,
		.gjj-text-input-markdown-body h3,
		.gjj-text-input-markdown-body h4,
		.gjj-text-input-markdown-body h5,
		.gjj-text-input-markdown-body h6 {
			margin: 0.35em 0 0.45em;
			color: #f4fbf7;
			line-height: 1.25;
			font-weight: 700;
		}
		.gjj-text-input-markdown-body h1 { font-size: 26px; }
		.gjj-text-input-markdown-body h2 { font-size: 21px; }
		.gjj-text-input-markdown-body h3 { font-size: 17px; }
		.gjj-text-input-markdown-body h4 { font-size: 14px; }
		.gjj-text-input-markdown-body h5,
		.gjj-text-input-markdown-body h6 { font-size: 12px; }
		.gjj-text-input-markdown-body p { margin: 0 0 0.7em; }
		.gjj-text-input-markdown-body ul,
		.gjj-text-input-markdown-body ol { margin: 0 0 0.75em 1.3em; padding: 0; }
		.gjj-text-input-markdown-body li { margin: 0.18em 0; }
		.gjj-text-input-markdown-body > :first-child { margin-top: 0; }
		.gjj-text-input-markdown-body > :last-child { margin-bottom: 0; }
		.gjj-text-input-markdown-body li input[type="checkbox"] {
			margin: 0 5px 0 0;
			vertical-align: -2px;
		}
		.gjj-text-input-markdown-body blockquote {
			margin: 0 0 0.75em;
			padding: 6px 10px;
			border-left: 3px solid #5fbcc4;
			background: #162329;
			color: #c7d7d5;
		}
		.gjj-text-input-markdown-body pre {
			margin: 0 0 0.75em;
			padding: 8px 10px;
			overflow: auto;
			border-radius: 6px;
			background: #090f12;
			border: 1px solid #2d3b42;
		}
		.gjj-text-input-markdown-body code {
			padding: 1px 4px;
			border-radius: 4px;
			background: #0b1115;
			color: #b8f3e9;
			font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
			font-size: 11px;
		}
		.gjj-text-input-markdown-body pre code { padding: 0; background: transparent; }
		.gjj-text-input-markdown-body table {
			width: 100%;
			border-collapse: collapse;
			margin: 0 0 0.75em;
			font-size: 11px;
		}
		.gjj-text-input-markdown-body th,
		.gjj-text-input-markdown-body td {
			border: 1px solid #34464e;
			padding: 5px 7px;
			text-align: left;
		}
		.gjj-text-input-markdown-body th { background: #1b2930; }
		.gjj-text-input-markdown-body a { color: #7dd3fc; text-decoration: none; }
		.gjj-text-input-markdown-body a:hover { text-decoration: underline; }
		.gjj-text-input-markdown-body img {
			max-width: 100%;
			max-height: 240px;
			object-fit: contain;
			border-radius: 6px;
			display: block;
			margin: 4px 0 8px;
		}
		.gjj-text-input-markdown-body hr {
			border: none;
			border-top: 1px solid #34464e;
			margin: 10px 0;
		}
		.gjj-text-input-empty { color: #8ea0a8; }
	`;
	previewWrap.appendChild(style);
	previewWrap.appendChild(body);

	const grid = document.createElement("div");
	grid.style.cssText = [
		"display:none",
		"grid-template-columns:repeat(auto-fit, minmax(140px, 1fr))",
		"gap:1px",
		"width:100%",
		"order:1",
	].join(";");
	previewWrap.appendChild(grid);

	const empty = document.createElement("div");
	empty.textContent = EMPTY_PREVIEW;
	empty.style.cssText = [
		"display:flex",
		"align-items:center",
		"justify-content:flex-start",
		"min-height:56px",
		"color:#8ea0a8",
		"font-size:12px",
	].join(";");
	previewWrap.appendChild(empty);

	body.style.order = "2";
	container.appendChild(previewWrap);

	const widget = node.addDOMWidget?.(
		PREVIEW_WIDGET_NAME,
		PREVIEW_WIDGET_NAME,
		container,
		{
			serialize: false,
			hideOnZoom: false,
			getHeight: () =>
				shouldUseEstimatedImageLayout(node)
					? getWidgetHeight(node, node.__gjjAnyPreviewWidget || widget)
					: Math.max(
							MIN_PREVIEW_HEIGHT,
							node.__gjjAnyPreviewHeight || MIN_PREVIEW_HEIGHT,
						),
		},
	);
	if (widget) {
		widget.computeSize = (width) => [
			Math.max(MIN_WIDTH, Number(width || MIN_WIDTH)),
			shouldUseEstimatedImageLayout(node)
				? estimateImagePreviewHeight(node)
				: Math.max(MIN_NODE_HEIGHT, measureHeight(node)),
		];
		widget.draw = () => {};
		node.__gjjAnyPreviewWidget = widget;
		if (Array.isArray(node.widgets)) {
			const idx = node.widgets.indexOf(widget);
			if (idx > 0) {
				node.widgets.splice(idx, 1);
				node.widgets.unshift(widget);
			}
		}
	}

	node.__gjjAnyPreviewContainer = container;
	node.__gjjAnyPreviewWrap = previewWrap;
	node.__gjjAnyPreviewBody = body;
	node.__gjjAnyPreviewGrid = grid;
	node.__gjjAnyPreviewEmpty = empty;
	applyPreviewContent(node);
	scheduleLayout(node);
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}

	migrateLegacyInputs(node);
	ensureOutput(node);
	removeUnusedInputsFromEnd(node, MIN_VISIBLE_INPUTS);
	ensureTrailingEmptyInput(node);
	renameInputsSequentially(node);

	const resolved = resolveOutputMode(node);
	for (const input of getInputs(node)) {
		input.type = ANY_INPUT_TYPE;
	}
	for (const output of node.outputs || []) {
		output.type = resolved.type || "*";
		output.name = resolved.name;
		output.label = resolved.name;
		output.localized_name = resolved.name;
		output.tooltip = resolved.tooltip;
	}

	ensurePreviewWidget(node);
	scheduleLayout(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjAnyPreviewTimer);
	node.__gjjAnyPreviewTimer = setTimeout(() => stabilizeNode(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.AnyPreview",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			resetLivePreviewState(this);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			resetLivePreviewState(this);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			resetLivePreviewState(this);
			scheduleStabilize(this);
			return result;
		};

		const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			if (String(this.__gjjAnyPreviewKind || "") === "image") {
				this.imgs = [];
				this.images = [];
				this.preview = null;
				const sizeSignature = `${Math.round(this.size?.[0] || 0)}x${Math.round(this.size?.[1] || 0)}`;
				if (this.__gjjAnyPreviewSizeSignature !== sizeSignature) {
					this.__gjjAnyPreviewSizeSignature = sizeSignature;
					// 只更新高度，不重新渲染内容，避免无限循环
					updateLayout(this);
				}
			}
			return typeof originalOnDrawBackground === "function"
				? originalOnDrawBackground.apply(this, args)
				: undefined;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = typeof originalOnResize === "function"
				? originalOnResize.apply(this, args)
				: undefined;
			// 用户手动调整宽度后，立即重新计算高度
			scheduleLayout(this);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result =
				typeof originalOnExecuted === "function"
					? originalOnExecuted.call(this, message)
					: undefined;
			const liveText = getLoraEffectLiveText(this);
			this.__gjjAnyPreviewKind =
				liveText !== null ? "text" : message?.preview_kind?.[0] || "";
			this.__gjjAnyPreviewText =
				liveText !== null ? liveText : message?.preview_text?.[0] || "";
			const previewItems =
				liveText !== null ? [] : normalizePreviewItemsPayload(message?.preview_items);
			this.__gjjAnyPreviewItems =
				liveText !== null
					? []
					: reorderPreviewItemsByLiveOrder(this, previewItems);
			this.__gjjAnyPreviewImages =
				liveText !== null
					? []
					: Array.isArray(message?.preview_images)
						? message.preview_images
						: [];
			// 同时兼容本节点 preview_audio 和 ComfyUI 原生 audio 字段。
			this.__gjjAnyPreviewAudio =
				liveText !== null
					? []
					: firstMediaPayload(message?.preview_audio, message?.audio);
			// 修复：视频数据是元组，需要取第一个元素
			this.__gjjAnyPreviewVideo =
				liveText !== null
					? []
					: Array.isArray(message?.preview_video?.[0])
						? message.preview_video[0]
						: [];
			resetLivePreviewState(this);
			this.imgs = [];
			this.images = [];
			this.preview = null;
			this.__gjjAnyPreviewHeight = Math.min(
				280,
				Math.max(
					MIN_PREVIEW_HEIGHT,
					String(this.__gjjAnyPreviewText || "").split("\n").length * 20,
				),
			);
			requestAnimationFrame(() => {
				applyPreviewContent(this);
				updateLayout(this);
				scheduleStabilize(this, 0);
			});
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				resetLivePreviewState(node);
				stabilizeNode(node);
			}
		}
	},
});

api.addEventListener("execution_start", (event) => {
	lastPromptId = eventPromptId(event);
	for (const node of app.graph?._nodes || []) {
		if (TARGET_NODES.has(node?.comfyClass)) {
			resetLivePreviewState(node);
		}
	}
});

api.addEventListener("executed", refreshLivePreviewFromExecuted);
