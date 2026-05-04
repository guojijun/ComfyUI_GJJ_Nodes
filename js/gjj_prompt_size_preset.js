import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set([
	"GJJ_PromptSizePreset",
]);
const ASPECT_RATIO_WIDGET = "aspect_ratio";
const WIDTH_WIDGET = "empty_latent_width";
const HEIGHT_WIDGET = "empty_latent_height";
const BATCH_WIDGET = "batch_size";
const IMAGE_INPUT_NAME = "image_size_source";
const LANDSCAPE_RATIOS = ["1:1", "4:3", "3:2", "16:9", "21:9", "5:4"];
const PORTRAIT_RATIOS = ["1:1", "3:4", "2:3", "9:16", "9:21", "4:5"];
const SIZE_ROWS = [
	[512, 640, 768, 832, 896, 1024],
	[1152, 1216, 1280, 1344, 1536, 1728],
];

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function getInput(node, name) {
	return node.inputs?.find((input) => input?.name === name);
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

function setWidgetValue(widget, value) {
	if (!widget) {
		return;
	}
	widget.value = value;
	widget.callback?.(value);
}

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function roundToMultipleOfEight(value) {
	return Math.max(16, Math.round(Number(value || 0) / 8) * 8);
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
		width: Math.max(16, Number.parseInt(getWidget(node, WIDTH_WIDGET)?.value, 10) || 16),
		height: Math.max(16, Number.parseInt(getWidget(node, HEIGHT_WIDGET)?.value, 10) || 16),
	};
}

function computeSizeFromShortEdge(ratioText, shortEdge) {
	const { widthRatio, heightRatio } = parseRatio(ratioText);
	const safeShortEdge = Math.max(16, Number.parseInt(shortEdge, 10) || 16);
	if (widthRatio >= heightRatio) {
		return {
			width: roundToMultipleOfEight(safeShortEdge * widthRatio / heightRatio),
			height: roundToMultipleOfEight(safeShortEdge),
		};
	}
	return {
		width: roundToMultipleOfEight(safeShortEdge),
		height: roundToMultipleOfEight(safeShortEdge * heightRatio / widthRatio),
	};
}

function applySize(node, width, height) {
	setWidgetValue(getWidget(node, WIDTH_WIDGET), roundToMultipleOfEight(width));
	setWidgetValue(getWidget(node, HEIGHT_WIDGET), roundToMultipleOfEight(height));
}

function syncSizeFromRatioAndShortEdge(node, shortEdge) {
	const ratio = getWidget(node, ASPECT_RATIO_WIDGET)?.value || "1:1";
	const safeShortEdge = shortEdge ?? Math.min(currentSize(node).width, currentSize(node).height);
	const size = computeSizeFromShortEdge(ratio, safeShortEdge);
	applySize(node, size.width, size.height);
}

function applyShortEdgePreset(node, shortEdge) {
	node.__gjjPresetSyncing = true;
	try {
		syncSizeFromRatioAndShortEdge(node, shortEdge);
	} finally {
		node.__gjjPresetSyncing = false;
	}
	refreshNode(node);
}

function switchOrientation(node, toLandscape) {
	const { width, height } = currentSize(node);
	const longEdge = Math.max(width, height);
	const shortEdge = Math.min(width, height);
	node.__gjjPresetSyncing = true;
	try {
		if (toLandscape) {
			applySize(node, longEdge, shortEdge);
		} else {
			applySize(node, shortEdge, longEdge);
		}
	} finally {
		node.__gjjPresetSyncing = false;
	}
	refreshNode(node);
}

function guessRatioFromSize(width, height) {
	const safeWidth = Math.max(1, Number.parseInt(width, 10) || 1);
	const safeHeight = Math.max(1, Number.parseInt(height, 10) || 1);
	const candidates = [...new Set([...LANDSCAPE_RATIOS, ...PORTRAIT_RATIOS])];
	for (const ratio of candidates) {
		const size = computeSizeFromShortEdge(ratio, Math.min(safeWidth, safeHeight));
		if (size.width === safeWidth && size.height === safeHeight) {
			return ratio;
		}
	}
	return null;
}

function updateRatioButtonsVisual(node) {
	const ratio = String(getWidget(node, ASPECT_RATIO_WIDGET)?.value || "1:1");
	const buttons = node.__gjjPromptSizeRatioButtons || [];
	for (const button of buttons) {
		const isActive = button.dataset.ratio === ratio;
		button.style.background = isActive ? "#27404a" : "#172026";
		button.style.borderColor = isActive ? "#6a8b97" : "#41535b";
	}
}

function patchSourceImageNode(sourceNode) {
	if (!sourceNode || sourceNode.__gjjPromptSizeSourcePatched) {
		return;
	}
	if (!["LoadImage", "LoadImageOutput"].includes(sourceNode.comfyClass)) {
		return;
	}

	const imageWidget = getWidget(sourceNode, "image");
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
					const input = getInput(node, IMAGE_INPUT_NAME);
					const linkId = input?.link;
					const link = linkId && app.graph?.links ? app.graph.links[linkId] : null;
					if (link?.origin_id === sourceNode.id) {
						trySyncImageInputSize(node);
					}
				}
			}
		}, 0);
		return result;
	};

	sourceNode.__gjjPromptSizeSourcePatched = true;
}

async function loadImageDimensionsFromSourceNode(sourceNode) {
	if (!sourceNode) {
		return null;
	}

	patchSourceImageNode(sourceNode);
	const imageWidget = getWidget(sourceNode, "image");
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

async function trySyncImageInputSize(node) {
	const input = getInput(node, IMAGE_INPUT_NAME);
	const linkId = input?.link;
	if (!linkId || !app.graph?.links) {
		return;
	}

	const link = app.graph.links[linkId];
	const sourceNode = link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	const size = await loadImageDimensionsFromSourceNode(sourceNode);
	if (!size) {
		return;
	}

	node.__gjjPresetSyncing = true;
	try {
		applySize(node, size.width, size.height);
		const matchedRatio = guessRatioFromSize(size.width, size.height);
		if (matchedRatio) {
			setWidgetValue(getWidget(node, ASPECT_RATIO_WIDGET), matchedRatio);
		}
	} finally {
		node.__gjjPresetSyncing = false;
	}
	updateRatioButtonsVisual(node);
	refreshNode(node);
}

function patchWidgetCallbacks(node) {
	if (!node || node.__gjjPromptSizePatched) {
		return;
	}

	const ratioWidget = getWidget(node, ASPECT_RATIO_WIDGET);
	if (!ratioWidget) {
		return;
	}

	const originalRatioCallback = ratioWidget.callback;
	ratioWidget.callback = function (value, ...args) {
		const result = typeof originalRatioCallback === "function"
			? originalRatioCallback.call(this, value, ...args)
			: undefined;
		updateRatioButtonsVisual(node);
		if (!node.__gjjPresetSyncing) {
			node.__gjjPresetSyncing = true;
			try {
				syncSizeFromRatioAndShortEdge(node);
			} finally {
				node.__gjjPresetSyncing = false;
			}
			refreshNode(node);
		}
		return result;
	};

	node.__gjjPromptSizePatched = true;
}

function createRow() {
	const row = document.createElement("div");
	row.style.cssText = [
		"display:flex",
		"flex-wrap:nowrap",
		"gap:6px",
		"align-items:center",
		"overflow:hidden",
	].join(";");
	return row;
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
		"border-radius:7px",
		"padding:3px 8px",
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
	hideWidget(getWidget(node, ASPECT_RATIO_WIDGET));
	if (node.__gjjPromptSizeToolbar) {
		updateRatioButtonsVisual(node);
		return;
	}

	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"padding:4px 0 2px",
	].join(";");

	const landscapeRow = createRow();
	const landscapeButton = createButton("横向", "将当前长边设置为宽度", () => {
		switchOrientation(node, true);
	});
	landscapeRow.appendChild(landscapeButton);
	for (const ratio of LANDSCAPE_RATIOS) {
		const button = createButton(ratio, `切换到 ${ratio} 比例`, () => {
			node.__gjjPresetSyncing = true;
			try {
				setWidgetValue(getWidget(node, ASPECT_RATIO_WIDGET), ratio);
				syncSizeFromRatioAndShortEdge(node);
			} finally {
				node.__gjjPresetSyncing = false;
			}
			updateRatioButtonsVisual(node);
			refreshNode(node);
		});
		button.dataset.ratio = ratio;
		landscapeRow.appendChild(button);
		node.__gjjPromptSizeRatioButtons = node.__gjjPromptSizeRatioButtons || [];
		node.__gjjPromptSizeRatioButtons.push(button);
	}
	container.appendChild(landscapeRow);

	const portraitRow = createRow();
	const portraitButton = createButton("纵向", "将当前长边设置为高度", () => {
		switchOrientation(node, false);
	});
	portraitRow.appendChild(portraitButton);
	for (const ratio of PORTRAIT_RATIOS) {
		const button = createButton(ratio, `切换到 ${ratio} 比例`, () => {
			node.__gjjPresetSyncing = true;
			try {
				setWidgetValue(getWidget(node, ASPECT_RATIO_WIDGET), ratio);
				syncSizeFromRatioAndShortEdge(node);
			} finally {
				node.__gjjPresetSyncing = false;
			}
			updateRatioButtonsVisual(node);
			refreshNode(node);
		});
		button.dataset.ratio = ratio;
		portraitRow.appendChild(button);
		node.__gjjPromptSizeRatioButtons = node.__gjjPromptSizeRatioButtons || [];
		node.__gjjPromptSizeRatioButtons.push(button);
	}
	container.appendChild(portraitRow);

	for (const sizes of SIZE_ROWS) {
		const row = createRow();
		for (const size of sizes) {
			const button = createButton(String(size), `按当前比例计算短边 ${size}`, () => {
				applyShortEdgePreset(node, size);
			});
			row.appendChild(button);
		}
		container.appendChild(row);
	}

	node.__gjjPromptSizeToolbar = container;
	node.addDOMWidget("尺寸快捷", "HTML", container, { serialize: false });
	updateRatioButtonsVisual(node);
	refreshNode(node);
}

app.registerExtension({
	name: "Comfy.GJJ.PromptSizePreset",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => ensurePresetToolbar(this), 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => ensurePresetToolbar(this), 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			setTimeout(() => {
				ensurePresetToolbar(this);
				trySyncImageInputSize(this);
			}, 0);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, arguments);
			const width = Number.parseInt(message?.resolved_width?.[0], 10);
			const height = Number.parseInt(message?.resolved_height?.[0], 10);
			const batchSize = Number.parseInt(message?.resolved_batch_size?.[0], 10);
			const aspectRatio = String(message?.aspect_ratio?.[0] || "");
			if (Number.isFinite(width) && Number.isFinite(height)) {
				this.__gjjPresetSyncing = true;
				try {
					applySize(this, width, height);
					if (Number.isFinite(batchSize)) {
						setWidgetValue(getWidget(this, BATCH_WIDGET), batchSize);
					}
					if (aspectRatio && getWidget(this, ASPECT_RATIO_WIDGET)) {
						setWidgetValue(getWidget(this, ASPECT_RATIO_WIDGET), aspectRatio);
					}
				} finally {
					this.__gjjPresetSyncing = false;
				}
				updateRatioButtonsVisual(this);
				refreshNode(this);
			}
			return result;
		};
	},

	setup() {
		const refreshAll = () => {
			for (const node of app.graph?._nodes || []) {
				if (TARGET_NODES.has(node?.comfyClass)) {
					ensurePresetToolbar(node);
					trySyncImageInputSize(node);
				}
			}
		};

		const originalGraphConfigured = app.graph.onConfigure;
		app.graph.onConfigure = function (...args) {
			const result = originalGraphConfigured?.apply(this, args);
			setTimeout(refreshAll, 0);
			return result;
		};
	},
});
