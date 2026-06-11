import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const NODE_TYPE = "GJJ_SAM3VideoTrackAIO";
const MAX_ROUTES = 8;
const MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO";
const OUTPUT_TYPE = "SAM3_TRACK_DATA";

function mediaName(index) {
	return `media_${String(index).padStart(2, "0")}`;
}

function mediaLabel(index) {
	return `图片/视频 ${index}`;
}

function outputLabel(index) {
	return `跟踪数据 ${index}`;
}

function routeIndexFromName(name) {
	const match = String(name || "").match(/^media_(\d+)$/);
	return match ? Number.parseInt(match[1], 10) : 0;
}

function getRouteInputs(node) {
	return Array.isArray(node?.inputs)
		? node.inputs
			.filter((input) => routeIndexFromName(input?.name) > 0)
			.sort((a, b) => routeIndexFromName(a?.name) - routeIndexFromName(b?.name))
		: [];
}

function normalizeRouteInput(input, index) {
	input.name = mediaName(index);
	input.label = mediaLabel(index);
	input.localized_name = input.label;
	input.type = MEDIA_TYPE;
	input.tooltip = `${input.label}，支持 GJJ_BATCH_IMAGE、普通 IMAGE batch 和官方 VIDEO。每一路独立执行跟踪。`;
}

function normalizeRouteOutput(output, index) {
	output.name = outputLabel(index);
	output.label = outputLabel(index);
	output.localized_name = output.label;
	output.type = OUTPUT_TYPE;
	output.tooltip = "SAM3 3.1 视频跟踪数据，可接官方 SAM3 Track Preview / Track To Mask。";
}

function addRouteInput(node, index) {
	node.addInput?.(mediaName(index), MEDIA_TYPE);
	const input = node.inputs?.[node.inputs.length - 1];
	if (input) {
		normalizeRouteInput(input, index);
	}
}

function ensureRouteOutput(node, index) {
	while ((node.outputs?.length || 0) < index) {
		node.addOutput?.(outputLabel((node.outputs?.length || 0) + 1), OUTPUT_TYPE);
	}
	const output = node.outputs?.[index - 1];
	if (output) {
		normalizeRouteOutput(output, index);
	}
}

function removeRouteOutput(node, index) {
	const slot = index - 1;
	if (slot >= 0 && slot < (node.outputs?.length || 0)) {
		node.removeOutput?.(slot);
	}
}

function stabilize(node) {
	if (!node) {
		return;
	}

	const routeInputs = getRouteInputs(node);
	if (!routeInputs.length) {
		addRouteInput(node, 1);
	}

	getRouteInputs(node).forEach((input, offset) => normalizeRouteInput(input, offset + 1));

	let visibleCount = 1;
	for (const input of getRouteInputs(node)) {
		const index = routeIndexFromName(input.name);
		if (input.link != null) {
			visibleCount = Math.min(MAX_ROUTES, Math.max(visibleCount, index + 1));
		}
	}

	for (let index = MAX_ROUTES; index >= 2; index -= 1) {
		const input = getRouteInputs(node).find((item) => routeIndexFromName(item.name) === index);
		if (!input) {
			continue;
		}
		if (index > visibleCount && input.link == null) {
			const slot = node.inputs.indexOf(input);
			if (slot >= 0) {
				node.removeInput?.(slot);
			}
		}
	}

	for (let index = 1; index <= visibleCount; index += 1) {
		if (!getRouteInputs(node).some((input) => routeIndexFromName(input.name) === index)) {
			addRouteInput(node, index);
		}
		ensureRouteOutput(node, index);
	}

	while ((node.outputs?.length || 0) > visibleCount) {
		const last = node.outputs[node.outputs.length - 1];
		if (Array.isArray(last?.links) && last.links.length > 0) {
			break;
		}
		removeRouteOutput(node, node.outputs.length);
	}

	getRouteInputs(node).forEach((input, offset) => normalizeRouteInput(input, offset + 1));
	(node.outputs || []).forEach((output, offset) => normalizeRouteOutput(output, offset + 1));
	globalThis.GJJApplyTypeColorsToNode?.(node);
	GJJ_Utils.refreshNode(node);
}

function schedule(node) {
	clearTimeout(node.__gjjSam31TrackTimer);
	node.__gjjSam31TrackTimer = setTimeout(() => stabilize(node), 32);
}

app.registerExtension({
	name: "GJJ.SAM3VideoTrackAIO",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) {
			return;
		}

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = onNodeCreated?.apply(this, args);
			setTimeout(() => stabilize(this), 0);
			return result;
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = onConfigure?.apply(this, args);
			setTimeout(() => stabilize(this), 0);
			return result;
		};

		const onConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = onConnectionsChange?.apply(this, args);
			schedule(this);
			return result;
		};
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === NODE_TYPE) {
				stabilize(node);
			}
		}
	},
});
