import { GJJ_Utils } from "./gjj_utils.js";
import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_ImageCollage"]);
const BATCH_INPUT_NAME = "batch_image";
const BATCH_INPUT_TYPE = "GJJ_BATCH_IMAGE";
const IMAGE_PREFIX = "image_";
const MIN_VISIBLE_INPUTS = 1;
const IMAGE_TOOLTIP = "单张图片输入；连接最后一个图片口后会自动新增下一个。支持普通 IMAGE batch。";
const BATCH_TOOLTIP = "可直接接入 GJJ 专用批量图片队列；会按批次顺序参与拼版。";

function formatImageName(index) {
	return `${IMAGE_PREFIX}${String(index).padStart(2, "0")}`;
}

function getImageIndex(name) {
	const text = String(name || "");
	if (!text.startsWith(IMAGE_PREFIX)) {
		return Number.MAX_SAFE_INTEGER;
	}
	return Number.parseInt(text.slice(IMAGE_PREFIX.length), 10) || Number.MAX_SAFE_INTEGER;
}

function getImageInputs(node) {
	return Array.isArray(node?.inputs)
		? node.inputs
			.filter((input) => String(input?.name || "").startsWith(IMAGE_PREFIX))
			.sort((a, b) => getImageIndex(a?.name) - getImageIndex(b?.name))
		: [];
}

function getBatchInput(node) {
	return Array.isArray(node?.inputs)
		? node.inputs.find((input) => input?.name === BATCH_INPUT_NAME)
		: null;
}

function ensureBatchInput(node) {
	const input = getBatchInput(node);
	if (!input) {
		node.addInput?.(BATCH_INPUT_NAME, BATCH_INPUT_TYPE);
	}
	const batch = getBatchInput(node);
	if (batch) {
		batch.name = BATCH_INPUT_NAME;
		batch.type = BATCH_INPUT_TYPE;
		batch.label = "批量图片";
		batch.localized_name = "批量图片";
		batch.tooltip = BATCH_TOOLTIP;
	}
}

function addImageInput(node) {
	const nextIndex = getImageInputs(node).length + 1;
	node.addInput?.(formatImageName(nextIndex), "IMAGE");
}

function removeUnusedInputsFromEnd(node) {
	const inputs = getImageInputs(node);
	for (let index = inputs.length - 1; index >= MIN_VISIBLE_INPUTS; index -= 1) {
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

function ensureTrailingEmptyInput(node) {
	const inputs = getImageInputs(node);
	if (inputs.length === 0) {
		addImageInput(node);
		return;
	}
	if (inputs[inputs.length - 1]?.link) {
		addImageInput(node);
	}
}

function renameInputsSequentially(node) {
	getImageInputs(node).forEach((input, index) => {
		const number = index + 1;
		input.name = formatImageName(number);
		input.type = "IMAGE";
		input.label = `图片 ${number}`;
		input.localized_name = input.label;
		input.tooltip = IMAGE_TOOLTIP;
	});
}

function orderInputs(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	const batch = getBatchInput(node);
	if (!batch) {
		return;
	}
	const firstImageIndex = node.inputs.findIndex((input) => String(input?.name || "").startsWith(IMAGE_PREFIX));
	const batchIndex = node.inputs.indexOf(batch);
	if (firstImageIndex >= 0 && batchIndex > firstImageIndex) {
		node.inputs.splice(batchIndex, 1);
		node.inputs.splice(firstImageIndex, 0, batch);
	}
}

function inputLinkSignature(node) {
	return (node?.inputs || [])
		.map((input) => `${input?.name || ""}:${input?.link ?? ""}`)
		.join("|");
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}
	ensureBatchInput(node);
	removeUnusedInputsFromEnd(node);
	ensureTrailingEmptyInput(node);
	renameInputsSequentially(node);
	orderInputs(node);
	node.__gjjImageCollageLinkSignature = inputLinkSignature(node);
	GJJ_Utils.refreshNode(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjImageCollageTimer);
	node.__gjjImageCollageTimer = setTimeout(() => stabilizeNode(node), ms);
}

GJJ_Utils.registerDynamicSlotExtension("Comfy.GJJ.ImageCollage", TARGET_NODES, stabilizeNode, scheduleStabilize);
