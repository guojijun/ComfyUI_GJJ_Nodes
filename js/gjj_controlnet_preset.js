import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_ControlNetPreset"]);
const WIDTH_WIDGET = "latent_width";
const HEIGHT_WIDGET = "latent_height";
const IMAGE_INPUT_NAME = "image";

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function getInput(node, name) {
	return node.inputs?.find((input) => input?.name === name);
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

function applySize(node, width, height) {
	setWidgetValue(getWidget(node, WIDTH_WIDGET), roundToMultipleOfEight(width));
	setWidgetValue(getWidget(node, HEIGHT_WIDGET), roundToMultipleOfEight(height));
}

function patchSourceImageNode(sourceNode) {
	if (!sourceNode || sourceNode.__gjjControlPresetSourcePatched) {
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

	sourceNode.__gjjControlPresetSourcePatched = true;
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

	applySize(node, size.width, size.height);
	refreshNode(node);
}

function patchNode(node) {
	if (!node || node.__gjjControlPresetPatched) {
		return;
	}

	const originalConnectionsChange = node.onConnectionsChange;
	node.onConnectionsChange = function (...args) {
		const result = typeof originalConnectionsChange === "function"
			? originalConnectionsChange.apply(this, args)
			: undefined;
		setTimeout(() => {
			trySyncImageInputSize(this);
		}, 0);
		return result;
	};

	const originalExecuted = node.onExecuted;
	node.onExecuted = function (message) {
		const result = typeof originalExecuted === "function"
			? originalExecuted.apply(this, arguments)
			: undefined;
		const width = message?.resolved_width?.[0];
		const height = message?.resolved_height?.[0];
		if (width && height) {
			applySize(this, width, height);
			refreshNode(this);
		}
		return result;
	};

	node.__gjjControlPresetPatched = true;
	setTimeout(() => {
		trySyncImageInputSize(node);
	}, 0);
}

app.registerExtension({
	name: "GJJ.ControlNetPreset",
	async nodeCreated(node) {
		if (!TARGET_NODES.has(node?.comfyClass)) {
			return;
		}
		patchNode(node);
	},
});
