import { GJJ_Utils } from "./gjj_utils.js";
import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_SizeMath"]);
const IMAGE_PREFIX = "image_";
const MAX_IMAGES = 12;
const ASPECT_RATIO_WIDGET = "aspect_ratio";
const WIDTH_WIDGET = "width";
const HEIGHT_WIDGET = "height";
const MODE_WIDGET = "size_mode";
const EDGE_WIDGET = "edge_length";
const ROTATION_WIDGET = "rotation_mode";
const ALIGN_WIDGET = "align_multiple";
const OUTPUT_MODE_WIDGET = "output_size_mode";
const DEFAULT_ALIGN_MULTIPLE = 32;
const LANDSCAPE_RATIOS = ["1:1", "4:3", "3:2", "16:9", "21:9", "5:4"];
const PORTRAIT_RATIOS = ["1:1", "3:4", "2:3", "9:16", "9:21", "4:5"];
const SIZE_PRESETS = [480, 512, 640, 768, 832, 896, 1024, 1152, 1216, 1280, 1344, 1536, 1728, 2048];
const MODEL_PRESETS = [
	{ label: "Qwen 1328", width: 1328, height: 1328, ratio: "1:1", title: "Qwen Image / 2512 常用官方尺寸" },
	{ label: "Edit 1024", width: 1024, height: 1024, ratio: "1:1", title: "Qwen Image Edit / 2511 常用官方尺寸" },
	{ label: "Layered 640", width: 640, height: 640, ratio: "1:1", title: "Qwen Layered 常用官方尺寸" },
	{ label: "Z-Image 1024", width: 1024, height: 1024, ratio: "1:1", title: "Z-Image / Z-Image Turbo 官方尺寸" },
	{ label: "Flux 1024", width: 1024, height: 1024, ratio: "1:1", title: "Flux / Flux2 常用官方尺寸" },
	{ label: "HiDream 1024", width: 1024, height: 1024, ratio: "1:1", title: "HiDream 官方尺寸" },
];

function getInput(node, name) {
	return node.inputs?.find((input) => input?.name === name);
}

function formatName(prefix, index) {
	return `${prefix}${String(index).padStart(2, "0")}`;
}

function getIndex(name, prefix) {
	const text = String(name || "");
	if (!text.startsWith(prefix)) {
		return Number.MAX_SAFE_INTEGER;
	}
	return Number.parseInt(text.slice(prefix.length), 10) || Number.MAX_SAFE_INTEGER;
}

function getImageInputs(node) {
	return (node.inputs || [])
		.filter((input) => String(input?.name || "").startsWith(IMAGE_PREFIX))
		.sort((a, b) => getIndex(a?.name, IMAGE_PREFIX) - getIndex(b?.name, IMAGE_PREFIX));
}

function getLinkedImageCount(node) {
	return getImageInputs(node).filter((input) => imageHasLink(input)).length;
}

function getImageLinkSignature(node) {
	return getImageInputs(node)
		.map((input) => `${input?.name || ""}:${input?.link || 0}`)
		.join("|");
}

function setWidgetValue(widget, value) {
	if (!widget) {
		return;
	}
	const resolved = typeof value === "number" ? value : (Number.isFinite(Number(value)) ? Number(value) : value);
	widget.value = resolved;
	if (widget.inputEl) {
		widget.inputEl.value = String(resolved);
	}
	if (widget.element && "value" in widget.element) {
		widget.element.value = String(resolved);
	}
}

function roundToMultiple(value, multiple, minimum = multiple) {
	const safeMultiple = Math.max(1, Number.parseInt(multiple, 10) || 1);
	const safeMinimum = Math.max(safeMultiple, Number.parseInt(minimum, 10) || safeMultiple);
	return Math.max(safeMinimum, Math.round(Number(value || 0) / safeMultiple) * safeMultiple);
}

function normalizePositiveInt(value, minimum = 1) {
	return Math.max(minimum, Number.parseInt(value, 10) || minimum);
}

function getAlignMultiple(node, fallback = DEFAULT_ALIGN_MULTIPLE) {
	return normalizePositiveInt(GJJ_Utils.getWidget(node, ALIGN_WIDGET)?.value ?? fallback, 1);
}

function roundToNodeMultiple(node, value, minimum = null) {
	const multiple = getAlignMultiple(node);
	return roundToMultiple(value, multiple, minimum == null ? multiple : minimum);
}

function parseRatio(ratioText) {
	const [rawWidth = "1", rawHeight = "1"] = String(ratioText || "1:1").split(":");
	return {
		widthRatio: Math.max(1, Number.parseInt(rawWidth, 10) || 1),
		heightRatio: Math.max(1, Number.parseInt(rawHeight, 10) || 1),
	};
}

function currentSize(node) {
	return {
		width: normalizePositiveInt(GJJ_Utils.getWidget(node, WIDTH_WIDGET)?.value, 1),
		height: normalizePositiveInt(GJJ_Utils.getWidget(node, HEIGHT_WIDGET)?.value, 1),
	};
}

function scaleFromEdge(width, height, edge, byLongEdge) {
	const safeWidth = Math.max(1, Number.parseInt(width, 10) || 1);
	const safeHeight = Math.max(1, Number.parseInt(height, 10) || 1);
	const safeEdge = Math.max(1, Number.parseInt(edge, 10) || 1);
	const baseEdge = byLongEdge ? Math.max(safeWidth, safeHeight) : Math.min(safeWidth, safeHeight);
	if (baseEdge <= 0) {
		return { width: safeEdge, height: safeEdge };
	}
	const factor = safeEdge / baseEdge;
	return {
		width: Math.max(1, Math.round(safeWidth * factor)),
		height: Math.max(1, Math.round(safeHeight * factor)),
	};
}

function rotateSize(width, height, rotationMode) {
	const text = String(rotationMode || "");
	if (text.includes("90") && !text.includes("180")) {
		return { width: height, height: width };
	}
	return { width, height };
}

function alignSize(width, height, multiple) {
	const safeMultiple = Math.max(1, Number.parseInt(multiple, 10) || 1);
	if (safeMultiple === 1) {
		return {
			width: Math.max(1, Number.parseInt(width, 10) || 1),
			height: Math.max(1, Number.parseInt(height, 10) || 1),
		};
	}
	return {
		width: Math.max(safeMultiple, Math.round((Number(width) || 0) / safeMultiple) * safeMultiple),
		height: Math.max(safeMultiple, Math.round((Number(height) || 0) / safeMultiple) * safeMultiple),
	};
}

function getBaseSize(node) {
	if (node.__gjjSizeMathBaseWidth > 0 && node.__gjjSizeMathBaseHeight > 0) {
		return {
			width: node.__gjjSizeMathBaseWidth,
			height: node.__gjjSizeMathBaseHeight,
		};
	}
	return currentSize(node);
}

function computeResolvedSize(node, baseWidth, baseHeight) {
	const mode = String(GJJ_Utils.getWidget(node, MODE_WIDGET)?.value || "直接指定");
	const edgeLength = GJJ_Utils.getWidget(node, EDGE_WIDGET)?.value;
	const rotationMode = GJJ_Utils.getWidget(node, ROTATION_WIDGET)?.value;
	const alignMultiple = getAlignMultiple(node);

	let resolved =
		mode === "按长边缩放"
			? scaleFromEdge(baseWidth, baseHeight, edgeLength, true)
			: mode === "按短边缩放"
				? scaleFromEdge(baseWidth, baseHeight, edgeLength, false)
				: { width: baseWidth, height: baseHeight };

	resolved = rotateSize(resolved.width, resolved.height, rotationMode);
	resolved = alignSize(resolved.width, resolved.height, alignMultiple);
	return resolved;
}

function updateResolvedSizePreview(node) {
	if (!node || node.__gjjSizeMathSyncing) {
		return;
	}
	const base = getBaseSize(node);
	const resolved = computeResolvedSize(node, base.width, base.height);
	node.__gjjSizeMathSyncing = true;
	try {
		applySize(node, resolved.width, resolved.height);
		const matchedRatio = guessRatioFromSize(node, resolved.width, resolved.height);
		if (matchedRatio) {
			setWidgetValue(GJJ_Utils.getWidget(node, ASPECT_RATIO_WIDGET), matchedRatio);
		}
	} finally {
		node.__gjjSizeMathSyncing = false;
	}
	updateRatioButtonsVisual(node);
	GJJ_Utils.refreshNode(node);
}

function computeSizeFromShortEdge(node, ratioText, shortEdge) {
	const { widthRatio, heightRatio } = parseRatio(ratioText);
	const alignMultiple = getAlignMultiple(node);
	const safeShortEdge = roundToMultiple(shortEdge, alignMultiple, alignMultiple);
	if (widthRatio >= heightRatio) {
		return {
			width: roundToMultiple(safeShortEdge * widthRatio / heightRatio, alignMultiple, alignMultiple),
			height: safeShortEdge,
		};
	}
	return {
		width: safeShortEdge,
		height: roundToMultiple(safeShortEdge * heightRatio / widthRatio, alignMultiple, alignMultiple),
	};
}

function applySize(node, width, height) {
	setWidgetValue(GJJ_Utils.getWidget(node, WIDTH_WIDGET), roundToNodeMultiple(node, width));
	setWidgetValue(GJJ_Utils.getWidget(node, HEIGHT_WIDGET), roundToNodeMultiple(node, height));
}

function applyShortEdgePreset(node, shortEdge) {
	const ratio = GJJ_Utils.getWidget(node, ASPECT_RATIO_WIDGET)?.value || "1:1";
	const size = computeSizeFromShortEdge(node, ratio, shortEdge);
	node.__gjjSizeMathSyncing = true;
	try {
		setWidgetValue(GJJ_Utils.getWidget(node, MODE_WIDGET), "直接指定");
		setWidgetValue(GJJ_Utils.getWidget(node, EDGE_WIDGET), roundToNodeMultiple(node, shortEdge));
		applySize(node, size.width, size.height);
	} finally {
		node.__gjjSizeMathSyncing = false;
	}
	GJJ_Utils.refreshNode(node);
}

function switchOrientation(node, toLandscape) {
	const ratioWidget = GJJ_Utils.getWidget(node, ASPECT_RATIO_WIDGET);
	const ratio = String(ratioWidget?.value || "1:1");
	const [a = "1", b = "1"] = ratio.split(":");
	const nextRatio = toLandscape
		? `${Math.max(+a || 1, +b || 1)}:${Math.min(+a || 1, +b || 1)}`
		: `${Math.min(+a || 1, +b || 1)}:${Math.max(+a || 1, +b || 1)}`;
	const shortEdge = Math.min(currentSize(node).width, currentSize(node).height);

	node.__gjjSizeMathSyncing = true;
	try {
		setWidgetValue(ratioWidget, nextRatio);
		const size = computeSizeFromShortEdge(node, nextRatio, shortEdge);
		setWidgetValue(GJJ_Utils.getWidget(node, MODE_WIDGET), "直接指定");
		applySize(node, size.width, size.height);
	} finally {
		node.__gjjSizeMathSyncing = false;
	}
	updateRatioButtonsVisual(node);
	GJJ_Utils.refreshNode(node);
}

function guessRatioFromSize(node, width, height) {
	const safeWidth = Math.max(1, Number.parseInt(width, 10) || 1);
	const safeHeight = Math.max(1, Number.parseInt(height, 10) || 1);
	const candidates = [...new Set([...LANDSCAPE_RATIOS, ...PORTRAIT_RATIOS])];
	for (const ratio of candidates) {
		const size = computeSizeFromShortEdge(node, ratio, Math.min(safeWidth, safeHeight));
		if (size.width === roundToNodeMultiple(node, safeWidth) && size.height === roundToNodeMultiple(node, safeHeight)) {
			return ratio;
		}
	}
	return null;
}

function updateRatioButtonsVisual(node) {
	const ratio = String(GJJ_Utils.getWidget(node, ASPECT_RATIO_WIDGET)?.value || "1:1");
	const buttons = node.__gjjSizeMathRatioButtons || [];
	for (const button of buttons) {
		const isActive = button.dataset.ratio === ratio;
		button.style.background = isActive ? "#27404a" : "#172026";
		button.style.borderColor = isActive ? "#6a8b97" : "#41535b";
	}
}

function addImageInput(node) {
	const inputs = getImageInputs(node);
	const lastIndex = inputs.length ? getIndex(inputs[inputs.length - 1]?.name, IMAGE_PREFIX) : 0;
	const nextIndex = Math.max(1, lastIndex + 1);
	if (nextIndex > MAX_IMAGES) {
		return;
	}
	node.addInput(formatName(IMAGE_PREFIX, nextIndex), "IMAGE");
}

function imageHasLink(input) {
	return Boolean(input?.link);
}

function removeLegacyImageInputs(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		if (name === "width_input" || name === "height_input") {
			node.removeInput(index);
			continue;
		}
		if (input?.type === "IMAGE" && !name.startsWith(IMAGE_PREFIX)) {
			node.removeInput(index);
		}
	}
}

function ensureTrailingEmptyImage(node) {
	const inputs = getImageInputs(node);
	if (inputs.length === 0) {
		addImageInput(node);
		return;
	}
	const last = inputs[inputs.length - 1];
	if (imageHasLink(last) && inputs.length < MAX_IMAGES) {
		addImageInput(node);
	}
}

function trimTrailingUnusedImages(node) {
	const inputs = getImageInputs(node);
	let removable = 0;
	for (let index = inputs.length - 1; index >= 1; index -= 1) {
		if (imageHasLink(inputs[index])) {
			break;
		}
		removable += 1;
	}
	for (let i = 0; i < removable; i += 1) {
		const currentInputs = getImageInputs(node);
		const target = currentInputs[currentInputs.length - 1];
		const inputIndex = node.inputs.indexOf(target);
		if (inputIndex >= 0) {
			node.removeInput(inputIndex);
		}
	}
}

function renameImages(node) {
	getImageInputs(node).forEach((input, zeroIndex) => {
		const index = zeroIndex + 1;
		input.name = formatName(IMAGE_PREFIX, index);
		input.label = `图片 ${index}`;
		input.localized_name = `图片 ${index}`;
		input.tooltip = "多张图片会自动扩展输入插槽，并参与尺寸统计运算。";
	});
}

function syncImageInputs(node) {
	removeLegacyImageInputs(node);
	trimTrailingUnusedImages(node);
	ensureTrailingEmptyImage(node);
	renameImages(node);
}

function configureOutput(output, name, type, tooltip) {
	if (!output) {
		return;
	}
	output.name = name;
	output.label = name;
	output.localized_name = name;
	output.type = type;
	output.tooltip = tooltip;
	output.hidden = false;
}

function syncOutputs(node) {
	if (!node) {
		return;
	}

	const outputs = Array.isArray(node.outputs) ? node.outputs : [];
	while (outputs.length > 4) {
		node.removeOutput(outputs.length - 1);
	}

	if (outputs.length < 2) {
		while ((node.outputs || []).length < 2) {
			node.addOutput("宽度", "INT");
		}
	}

	configureOutput(node.outputs?.[0], "宽度", "INT", "根据输出尺寸模式最终决定的宽度。");
	configureOutput(node.outputs?.[1], "高度", "INT", "根据输出尺寸模式最终决定的高度。");

	const showMultiImages = getLinkedImageCount(node) >= 2;
	if (showMultiImages) {
		if ((node.outputs || []).length < 3) {
			node.addOutput("最大图片", "IMAGE");
		}
		if ((node.outputs || []).length < 4) {
			node.addOutput("最小图片", "IMAGE");
		}
		configureOutput(node.outputs?.[2], "最大图片", "IMAGE", "输入图片中面积最大的图片。");
		configureOutput(node.outputs?.[3], "最小图片", "IMAGE", "输入图片中面积最小的图片。");
	} else {
		while ((node.outputs || []).length > 2) {
			node.removeOutput((node.outputs || []).length - 1);
		}
	}
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}
	syncImageInputs(node);
	syncOutputs(node);
	ensurePresetToolbar(node);
	node.__gjjSizeMathLinkSignature = getImageLinkSignature(node);
	GJJ_Utils.refreshNode(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjSizeMathTimer);
	node.__gjjSizeMathTimer = setTimeout(() => {
		stabilizeNode(node);
		trySyncPrimaryImageSize(node);
	}, ms);
}

function hideWidget(widget) {
	if (!widget || widget.__gjjHidden) {
		return;
	}
	widget.__gjjHidden = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
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

function getPrimaryLinkedImageInput(node) {
	return getImageInputs(node).find((input) => input?.link) || null;
}

function patchSourceImageNode(sourceNode) {
	if (!sourceNode || sourceNode.__gjjSizeMathSourcePatched) {
		return;
	}
	if (!["LoadImage", "LoadImageOutput"].includes(sourceNode.comfyClass)) {
		return;
	}

	const imageWidget = GJJ_Utils.getWidget(sourceNode, "image");
	if (!imageWidget) {
		return;
	}

	const originalCallback = imageWidget.callback;
	imageWidget.callback = function (value, ...args) {
		const result = typeof originalCallback === "function"
			? originalCallback.call(this, value, ...args)
			: undefined;
		setTimeout(() => {
			for (const node of app.graph?._nodes || []) {
				if (TARGET_NODES.has(node?.comfyClass)) {
					trySyncPrimaryImageSize(node);
				}
			}
		}, 0);
		return result;
	};

	sourceNode.__gjjSizeMathSourcePatched = true;
}

async function loadImageDimensionsFromSourceNode(sourceNode) {
	if (!sourceNode) {
		return null;
	}
	patchSourceImageNode(sourceNode);
	const imageWidget = GJJ_Utils.getWidget(sourceNode, "image");
	const filename = String(imageWidget?.value || "").trim();
	if (!filename) {
		return null;
	}

	let viewType = null;
	if (sourceNode.comfyClass === "LoadImage") {
		viewType = "input";
	} else if (sourceNode.comfyClass === "LoadImageOutput") {
		viewType = "output";
	} else {
		return null;
	}

	const url = `/api/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(viewType)}&rand=${Date.now()}`;
	return new Promise((resolve) => {
		const image = new Image();
		image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
		image.onerror = () => resolve(null);
		image.src = url;
	});
}

async function trySyncPrimaryImageSize(node) {
	const primaryInput = getPrimaryLinkedImageInput(node);
	if (!primaryInput?.link || !app.graph?.links) {
		node.__gjjSizeMathBaseWidth = null;
		node.__gjjSizeMathBaseHeight = null;
		return;
	}
	const link = app.graph.links[primaryInput.link];
	const sourceNode = link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	const size = await loadImageDimensionsFromSourceNode(sourceNode);
	if (!size) {
		return;
	}

	node.__gjjSizeMathSyncing = true;
	try {
		node.__gjjSizeMathBaseWidth = size.width;
		node.__gjjSizeMathBaseHeight = size.height;
		setWidgetValue(GJJ_Utils.getWidget(node, EDGE_WIDGET), normalizePositiveInt(Math.min(size.width, size.height), 1));
		const mode = String(GJJ_Utils.getWidget(node, MODE_WIDGET)?.value || "直接指定");
		const resolved = computeResolvedSize(node, size.width, size.height);
		applySize(node, resolved.width, resolved.height);
		const matchedRatio = guessRatioFromSize(
			node,
			mode === "直接指定" ? size.width : resolved.width,
			mode === "直接指定" ? size.height : resolved.height,
		);
		if (matchedRatio) {
			setWidgetValue(GJJ_Utils.getWidget(node, ASPECT_RATIO_WIDGET), matchedRatio);
		}
	} finally {
		node.__gjjSizeMathSyncing = false;
	}
	updateRatioButtonsVisual(node);
	GJJ_Utils.refreshNode(node);
}

function patchWidgetCallbacks(node) {
	if (!node || node.__gjjSizeMathPatched) {
		return;
	}

	const ratioWidget = GJJ_Utils.getWidget(node, ASPECT_RATIO_WIDGET);
	const widthWidget = GJJ_Utils.getWidget(node, WIDTH_WIDGET);
	const heightWidget = GJJ_Utils.getWidget(node, HEIGHT_WIDGET);
	const modeWidget = GJJ_Utils.getWidget(node, MODE_WIDGET);
	const edgeWidget = GJJ_Utils.getWidget(node, EDGE_WIDGET);
	const rotationWidget = GJJ_Utils.getWidget(node, ROTATION_WIDGET);
	const alignWidget = GJJ_Utils.getWidget(node, ALIGN_WIDGET);
	if (!ratioWidget || !widthWidget || !heightWidget || !modeWidget || !edgeWidget || !rotationWidget || !alignWidget) {
		return;
	}

	const originalRatioCallback = ratioWidget.callback;
	ratioWidget.callback = function (value, ...args) {
		const result = typeof originalRatioCallback === "function"
			? originalRatioCallback.call(this, value, ...args)
			: undefined;
		updateRatioButtonsVisual(node);
		return result;
	};

	for (const widget of [widthWidget, heightWidget]) {
		const originalCallback = widget.callback;
		widget.callback = function (value, ...args) {
			const result = typeof originalCallback === "function"
				? originalCallback.call(this, value, ...args)
				: undefined;
			const typedValue = Number.parseInt(value, 10);
			if (!Number.isNaN(typedValue) && this.value !== typedValue) {
				setWidgetValue(this, typedValue);
			}
			if (!node.__gjjSizeMathSyncing) {
				if (!getPrimaryLinkedImageInput(node)?.link) {
					node.__gjjSizeMathBaseWidth = Number.parseInt(GJJ_Utils.getWidget(node, WIDTH_WIDGET)?.value, 10) || 0;
					node.__gjjSizeMathBaseHeight = Number.parseInt(GJJ_Utils.getWidget(node, HEIGHT_WIDGET)?.value, 10) || 0;
				}
				const ratio = guessRatioFromSize(
					node,
					GJJ_Utils.getWidget(node, WIDTH_WIDGET)?.value,
					GJJ_Utils.getWidget(node, HEIGHT_WIDGET)?.value,
				);
				if (ratio) {
					node.__gjjSizeMathSyncing = true;
					try {
						setWidgetValue(GJJ_Utils.getWidget(node, ASPECT_RATIO_WIDGET), ratio);
					} finally {
						node.__gjjSizeMathSyncing = false;
					}
					updateRatioButtonsVisual(node);
				}
			}
			return result;
		};
	}

	for (const widget of [modeWidget, edgeWidget, rotationWidget, alignWidget]) {
		const originalCallback = widget.callback;
		widget.callback = function (value, ...args) {
			const result = typeof originalCallback === "function"
				? originalCallback.call(this, value, ...args)
				: undefined;
			updateResolvedSizePreview(node);
			return result;
		};
	}

	node.__gjjSizeMathPatched = true;
}

function patchExecutionSync(node) {
	if (node.__gjjSizeMathExecutionPatched) {
		return;
	}
	const originalExecuted = node.onExecuted;
	node.onExecuted = function (message) {
		const result = typeof originalExecuted === "function" ? originalExecuted.call(this, message) : undefined;
		if (message?.resolved_width?.[0] != null && message?.resolved_height?.[0] != null) {
			node.__gjjSizeMathSyncing = true;
			try {
				if (message?.source_width?.[0] != null && message?.source_height?.[0] != null) {
					node.__gjjSizeMathBaseWidth = message.source_width[0];
					node.__gjjSizeMathBaseHeight = message.source_height[0];
				}
				setWidgetValue(GJJ_Utils.getWidget(node, WIDTH_WIDGET), message.resolved_width[0]);
				setWidgetValue(GJJ_Utils.getWidget(node, HEIGHT_WIDGET), message.resolved_height[0]);
				if (message.short_edge?.[0] != null) {
					setWidgetValue(GJJ_Utils.getWidget(node, EDGE_WIDGET), normalizePositiveInt(message.short_edge[0], 1));
				}
				if (message.aspect_ratio?.[0]) {
					setWidgetValue(GJJ_Utils.getWidget(node, ASPECT_RATIO_WIDGET), message.aspect_ratio[0]);
				}
			} finally {
				node.__gjjSizeMathSyncing = false;
			}
			updateRatioButtonsVisual(node);
			GJJ_Utils.refreshNode(node);
		}
		return result;
	};
	node.__gjjSizeMathExecutionPatched = true;
}

function createRow() {
	const row = document.createElement("div");
	row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;overflow:visible;";
	return row;
}

function measureToolbar(node) {
	const container = node?.__gjjSizeMathToolbar?.element || node?.__gjjSizeMathToolbar;
	const widget = node?.__gjjSizeMathToolbar;
	if (!container || !widget) {
		return;
	}
	requestAnimationFrame(() => {
		const height = Math.max(92, Math.ceil(container.scrollHeight || container.offsetHeight || 92));
		if (node.__gjjSizeMathToolbarHeight !== height) {
			node.__gjjSizeMathToolbarHeight = height;
			GJJ_Utils.refreshNode(node);
		}
	});
}

function createButton(label, title, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title;
	button.style.cssText = [
		"border:1px solid #41535b",
		"background:#172026",
		"color:#dce7e2",
		"border-radius:9px",
		"padding:3px 10px",
		"font-size:11px",
		"line-height:1.2",
		"cursor:pointer",
		"white-space:nowrap",
		"flex:0 0 auto",
	].join(";");
	button.addEventListener("mousedown", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.(event);
	});
	return button;
}

function ensurePresetToolbar(node) {
	if (!node) {
		return;
	}

	patchWidgetCallbacks(node);
	patchExecutionSync(node);
	hideWidget(GJJ_Utils.getWidget(node, ASPECT_RATIO_WIDGET));
	if (node.__gjjSizeMathToolbar) {
		updateRatioButtonsVisual(node);
		measureToolbar(node);
		return;
	}

	const container = document.createElement("div");
	container.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:4px 0 2px;";

	const landscapeRow = createRow();
	landscapeRow.appendChild(createButton("横向", "切换成横向比例", () => switchOrientation(node, true)));
	for (const ratio of LANDSCAPE_RATIOS) {
		const button = createButton(ratio, `切换到 ${ratio} 比例`, () => {
			node.__gjjSizeMathSyncing = true;
			try {
				setWidgetValue(GJJ_Utils.getWidget(node, ASPECT_RATIO_WIDGET), ratio);
			} finally {
				node.__gjjSizeMathSyncing = false;
			}
			applyShortEdgePreset(node, Math.min(currentSize(node).width, currentSize(node).height));
			updateRatioButtonsVisual(node);
		});
		button.dataset.ratio = ratio;
		landscapeRow.appendChild(button);
		node.__gjjSizeMathRatioButtons = node.__gjjSizeMathRatioButtons || [];
		node.__gjjSizeMathRatioButtons.push(button);
	}
	container.appendChild(landscapeRow);

	const portraitRow = createRow();
	portraitRow.appendChild(createButton("纵向", "切换成纵向比例", () => switchOrientation(node, false)));
	for (const ratio of PORTRAIT_RATIOS) {
		const button = createButton(ratio, `切换到 ${ratio} 比例`, () => {
			node.__gjjSizeMathSyncing = true;
			try {
				setWidgetValue(GJJ_Utils.getWidget(node, ASPECT_RATIO_WIDGET), ratio);
			} finally {
				node.__gjjSizeMathSyncing = false;
			}
			applyShortEdgePreset(node, Math.min(currentSize(node).width, currentSize(node).height));
			updateRatioButtonsVisual(node);
		});
		button.dataset.ratio = ratio;
		portraitRow.appendChild(button);
		node.__gjjSizeMathRatioButtons = node.__gjjSizeMathRatioButtons || [];
		node.__gjjSizeMathRatioButtons.push(button);
	}
	container.appendChild(portraitRow);

	const sizeRow = createRow();
	for (const shortEdge of SIZE_PRESETS) {
		sizeRow.appendChild(createButton(String(shortEdge), `按当前比例设置短边 ${shortEdge}`, () => {
			applyShortEdgePreset(node, shortEdge);
		}));
	}
	container.appendChild(sizeRow);

	const modelRow = createRow();
	for (const preset of MODEL_PRESETS) {
		modelRow.appendChild(createButton(preset.label, preset.title, () => {
			node.__gjjSizeMathSyncing = true;
			try {
				setWidgetValue(GJJ_Utils.getWidget(node, ASPECT_RATIO_WIDGET), preset.ratio);
				setWidgetValue(GJJ_Utils.getWidget(node, MODE_WIDGET), "直接指定");
				setWidgetValue(GJJ_Utils.getWidget(node, EDGE_WIDGET), normalizePositiveInt(Math.min(preset.width, preset.height), 1));
				setWidgetValue(GJJ_Utils.getWidget(node, OUTPUT_MODE_WIDGET), "当前尺寸");
				applySize(node, preset.width, preset.height);
			} finally {
				node.__gjjSizeMathSyncing = false;
			}
			updateRatioButtonsVisual(node);
			GJJ_Utils.refreshNode(node);
		}));
	}
	container.appendChild(modelRow);

	const widget = node.addDOMWidget?.("gjj_size_math_toolbar", "size_math_toolbar", container, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => Math.max(92, node.__gjjSizeMathToolbarHeight || 92),
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(280, width || 280), Math.max(92, node.__gjjSizeMathToolbarHeight || 92)];
	}

	node.__gjjSizeMathToolbar = widget || { element: container };
	updateRatioButtonsVisual(node);
	measureToolbar(node);
	GJJ_Utils.refreshNode(node);
}

app.registerExtension({
	name: "GJJ.SizeMath",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => {
				stabilizeNode(this);

				GJJ_Utils.refreshNode(this);				trySyncPrimaryImageSize(this);
			}, 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => {
				stabilizeNode(this);

				GJJ_Utils.refreshNode(this);				trySyncPrimaryImageSize(this);
			}, 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = typeof originalOnConnectionsChange === "function"
				? originalOnConnectionsChange.apply(this, args)
				: undefined;
			scheduleStabilize(this);
			return result;
		};

		const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			const signature = getImageLinkSignature(this);
			if (signature !== this.__gjjSizeMathLinkSignature) {
				scheduleStabilize(this, 0);
			}
			return typeof originalOnDrawBackground === "function"
				? originalOnDrawBackground.apply(this, args)
				: undefined;
		};
	},
	nodeCreated(node) {
		if (!TARGET_NODES.has(node?.comfyClass)) {
			return;
		}
		setTimeout(() => {
			stabilizeNode(node);
			trySyncPrimaryImageSize(node);
		}, 0);
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				stabilizeNode(node);
			}
		}
	},
});
