import { GJJ_Utils } from "./gjj_utils.js";
import { app } from "../../scripts/app.js";

const NODE_NAME = "GJJ_ImageStacker";
const OPTIONAL_IMAGE_NAMES = ["image3", "image4"];
const OPTIONAL_IMAGE_LABELS = {
	image3: "图像3",
	image4: "图像4",
};
const OPTIONAL_IMAGE_TOOLTIPS = {
	image3: "可选第三张图。",
	image4: "可选第四张图。",
};

function inputIndex(node, name) {
	return (node.inputs || []).findIndex((input) => input?.name === name);
}

function inputByName(node, name) {
	const index = inputIndex(node, name);
	return index >= 0 ? node.inputs[index] : null;
}

function hasLink(input) {
	return Boolean(input?.link != null);
}

function removeInputByName(node, name) {
	const index = inputIndex(node, name);
	if (index < 0) {
		return false;
	}
	if (typeof node.disconnectInput === "function") {
		try {
			node.disconnectInput(index);
		} catch (error) {
			// Removing the slot below is enough if the link is already gone.
		}
	}
	if (typeof node.removeInput === "function") {
		node.removeInput(index);
	} else {
		node.inputs.splice(index, 1);
	}
	return true;
}

function ensureOptionalInput(node, name) {
	let input = inputByName(node, name);
	if (input) {
		input.type = "IMAGE";
		input.label = OPTIONAL_IMAGE_LABELS[name];
		input.localized_name = OPTIONAL_IMAGE_LABELS[name];
		input.tooltip = OPTIONAL_IMAGE_TOOLTIPS[name];
		return input;
	}
	node.addInput?.(OPTIONAL_IMAGE_LABELS[name], "IMAGE");
	input = node.inputs?.[node.inputs.length - 1];
	if (input) {
		input.name = name;
		input.label = OPTIONAL_IMAGE_LABELS[name];
		input.localized_name = OPTIONAL_IMAGE_LABELS[name];
		input.tooltip = OPTIONAL_IMAGE_TOOLTIPS[name];
	}
	return input;
}

function reorderInputs(node) {
	if (!Array.isArray(node.inputs)) {
		return;
	}
	const order = ["image1", "image2", "image3", "image4"];
	const fixedTail = ["direction"];
	const byName = new Map(node.inputs.map((input) => [input?.name, input]));
	const ordered = [];
	for (const name of order) {
		if (byName.has(name)) {
			ordered.push(byName.get(name));
			byName.delete(name);
		}
	}
	for (const input of node.inputs) {
		if (!input || order.includes(input.name) || fixedTail.includes(input.name)) {
			continue;
		}
		ordered.push(input);
		byName.delete(input.name);
	}
	for (const name of fixedTail) {
		if (byName.has(name)) {
			ordered.push(byName.get(name));
			byName.delete(name);
		}
	}
	node.inputs = ordered;
}

function stabilize(node) {
	if (!node || node.comfyClass !== NODE_NAME || node.__gjjImageStackerStabilizing) {
		return;
	}
	node.__gjjImageStackerStabilizing = true;
	try {
		const image3 = inputByName(node, "image3");
		const image4 = inputByName(node, "image4");
		const image3Connected = hasLink(image3);
		const image4Connected = hasLink(image4);

		if (image3Connected || image4Connected) {
			ensureOptionalInput(node, "image3");
		} else {
			ensureOptionalInput(node, "image3");
			removeInputByName(node, "image4");
		}

		if (image3Connected || image4Connected) {
			ensureOptionalInput(node, "image4");
		}
		if (!image4Connected && !image3Connected) {
			removeInputByName(node, "image4");
		}

		reorderInputs(node);
		if (typeof node.computeSize === "function") {
			const size = node.computeSize();
			if (Array.isArray(size)) {
				node.size = [Math.max(node.size?.[0] || 220, size[0] || 220), Math.max(120, size[1] || 120)];
			}
		}
		node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
		app.graph?.change?.();
	} finally {
		node.__gjjImageStackerStabilizing = false;
	}
}

function scheduleStabilize(node) {
	setTimeout(() => stabilize(node), 0);
	setTimeout(() => stabilize(node), 80);
}

app.registerExtension({
	name: "GJJ.ImageStacker.DynamicOptionalInputs",
	nodeCreated(node) {
		if (node.comfyClass === NODE_NAME) {
			scheduleStabilize(node);
		}
	},
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleStabilize(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			scheduleStabilize(this);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this);
			return result;
		};
	},
});
