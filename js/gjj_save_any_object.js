import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_SaveAnyObject"]);
const INPUT_PREFIX = "any_";
const MIN_VISIBLE_INPUTS = 1;
const INPUT_TOOLTIP = "可接任意类型；连接后会自动扩展下一个输入口，执行时按顺序保存。";
const OUTPUT_NAMES = ["保存路径JSON", "首个保存路径", "保存文件数"];
const OUTPUT_TYPES = ["STRING", "STRING", "INT"];
const DEFAULT_PREFIX = "GJJ/任意对象";
const PREVIEW_WIDGET_NAME = "gjj_save_any_object_preview";
const EMPTY_PREVIEW = "执行后在这里显示保存结果";
const MIN_PREVIEW_HEIGHT = 116;
const MIN_WIDTH = 320;
const MULTI_IMAGE_HEIGHT = 108;
const SINGLE_IMAGE_MIN_HEIGHT = 220;
const SINGLE_IMAGE_MAX_HEIGHT = 620;
const MEDIA_PREVIEW_HEIGHT = 220;

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

function sanitizePathPart(value) {
	return String(value || "")
		.replace(/[<>:"|?*\x00-\x1f]/g, "_")
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^[\s/.]+|[\s/.]+$/g, "");
}

function getWidget(node, name) {
	return Array.isArray(node?.widgets)
		? node.widgets.find((widget) => String(widget?.name || "") === name)
		: null;
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
	const sourcePrefix = firstSourcePrefix(node);
	if (!sourcePrefix) {
		return;
	}
	const current = String(widget.value || "").trim();
	const canAutoUpdate = !current || current === DEFAULT_PREFIX || current === node.__gjjSaveAnyObjectAutoPrefix;
	if (!canAutoUpdate) {
		return;
	}
	widget.value = sourcePrefix;
	node.__gjjSaveAnyObjectAutoPrefix = sourcePrefix;
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
	imageGrid.style.gridTemplateColumns = singleImage ? "minmax(0, 1fr)" : "repeat(auto-fill, minmax(120px, 1fr))";
	imageGrid.replaceChildren();
	mediaGrid.replaceChildren();

	for (const [index, item] of images.entries()) {
		const imageWidth = Math.max(1, Number(item?.width || 0));
		const imageHeight = Math.max(1, Number(item?.height || 0));
		const aspect = imageWidth > 0 && imageHeight > 0 ? imageHeight / imageWidth : 1;
		const nodeWidth = Math.max(MIN_WIDTH, Number(node.size?.[0] || MIN_WIDTH));
		const previewWidth = Math.max(220, nodeWidth - 42);
		const previewHeight = singleImage
			? Math.min(SINGLE_IMAGE_MAX_HEIGHT, Math.max(SINGLE_IMAGE_MIN_HEIGHT, Math.round(previewWidth * aspect)))
			: MULTI_IMAGE_HEIGHT;
		const card = document.createElement("div");
		card.style.cssText = [
			"display:flex",
			"flex-direction:column",
			"gap:6px",
			"padding:6px",
			"border:1px solid #33434a",
			"border-radius:8px",
			"background:#12191d",
			"min-width:0",
			"box-sizing:border-box",
			"overflow:hidden",
			singleImage ? "width:100%" : "",
		].filter(Boolean).join(";");

		const image = document.createElement("img");
		image.src = previewDataToUrl(item);
		image.draggable = false;
		image.title = String(item.path || item.filename || "");
		image.style.cssText = [
			"width:100%",
			`height:${previewHeight}px`,
			"object-fit:contain",
			"background:#0c1114",
			"border-radius:6px",
			"display:block",
		].join(";");
		image.onload = () => scheduleLayout(node);
		image.onerror = () => scheduleLayout(node);

		const caption = document.createElement("div");
		caption.textContent = `图片 ${index + 1}`;
		caption.style.cssText = "font-size:11px;color:#dce7e2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";

		card.appendChild(image);
		card.appendChild(caption);
		imageGrid.appendChild(card);
	}

	for (const [index, item] of media.entries()) {
		const mediaType = String(item?.media_type || "");
		const url = previewDataToUrl(item, false);
		if (!url) {
			continue;
		}
		const card = document.createElement("div");
		card.style.cssText = [
			"display:flex",
			"flex-direction:column",
			"gap:6px",
			"padding:6px",
			"border:1px solid #33434a",
			"border-radius:8px",
			"background:#12191d",
			"min-width:0",
			"box-sizing:border-box",
			"overflow:hidden",
		].join(";");

		const control = mediaType === "audio" ? document.createElement("audio") : document.createElement("video");
		control.controls = true;
		control.preload = "metadata";
		control.src = url;
		control.title = String(item.path || item.filename || "");
		if (control.tagName === "VIDEO") {
			control.muted = true;
			control.loop = true;
			control.playsInline = true;
			control.style.cssText = [
				"width:100%",
				`height:${MEDIA_PREVIEW_HEIGHT}px`,
				"object-fit:contain",
				"background:#050708",
				"border-radius:6px",
				"display:block",
			].join(";");
			control.onloadedmetadata = () => scheduleLayout(node);
			control.onerror = () => scheduleLayout(node);
		} else {
			control.style.cssText = [
				"width:100%",
				"height:36px",
				"display:block",
			].join(";");
		}

		const caption = document.createElement("div");
		caption.textContent = `${mediaType === "audio" ? "音频" : "视频"} ${index + 1}`;
		caption.style.cssText = "font-size:11px;color:#dce7e2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";

		card.appendChild(control);
		card.appendChild(caption);
		mediaGrid.appendChild(card);
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

function ensurePreviewWidget(node) {
	if (node.__gjjSaveAnyObjectPreviewContainer) {
		applyPreviewContent(node);
		return;
	}

	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"width:100%",
		"box-sizing:border-box",
		"margin-top:4px",
		"border:1px solid #33434a",
		"border-radius:8px",
		"background:#0f1418",
		"padding:8px",
		"color:#d9e4df",
		"font-size:12px",
		"line-height:1.45",
		"user-select:text",
		"pointer-events:auto",
	].join(";");

	const imageGrid = document.createElement("div");
	imageGrid.style.cssText = [
		"display:none",
		"grid-template-columns:repeat(auto-fill, minmax(120px, 1fr))",
		"gap:8px",
		"width:100%",
	].join(";");

	const mediaGrid = document.createElement("div");
	mediaGrid.style.cssText = [
		"display:none",
		"grid-template-columns:minmax(0, 1fr)",
		"gap:8px",
		"width:100%",
	].join(";");

	const textBlock = document.createElement("pre");
	textBlock.style.cssText = [
		"display:none",
		"margin:0",
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
		"min-height:64px",
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
	normalizeOutputs(node);
	maybeUpdateFilenamePrefix(node);
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
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
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
			const signature = inputSignature(this);
			if (signature !== this.__gjjSaveAnyObjectInputSignature) {
				this.__gjjSaveAnyObjectInputSignature = signature;
				scheduleStabilize(this);
			}
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			const count = Number(message?.saved_count?.[0] || 0);
			const firstPath = String(message?.first_path?.[0] || "");
			this.__gjjSaveAnyObjectPreviewImages = Array.isArray(message?.preview_images) ? message.preview_images : [];
			this.__gjjSaveAnyObjectPreviewMedia = Array.isArray(message?.preview_media) ? message.preview_media : [];
			this.__gjjSaveAnyObjectPreviewText = String(message?.preview_text?.[0] || "");
			this.title = count > 0 ? `GJJ · 💾 保存任意对象 (${count})` : "GJJ · 💾 保存任意对象";
			if (firstPath) {
				this.__gjjSaveAnyObjectLastPath = firstPath;
			}
			ensurePreviewWidget(this);
			setDirty(this);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				stabilizeNode(node);
			}
		}
	},
});
