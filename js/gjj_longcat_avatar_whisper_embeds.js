import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_LongCatAvatarWhisperEmbeds"]);
const AUDIO_PREFIX = "audio_";
const AUDIO_TYPE = "AUDIO";
const MASK_NAME = "ref_target_masks";
const MASK_TYPE = "MASK";
const LEGACY_WHISPER_INPUT = "whisper_model";

function audioIndex(input) {
	const match = String(input?.name || "").match(/^audio_(\d+)$/);
	return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function audioInputs(node) {
	return (node.inputs || [])
		.filter((input) => /^audio_\d+$/.test(String(input?.name || "")))
		.sort((a, b) => audioIndex(a) - audioIndex(b));
}

function removeInputObject(node, input) {
	const index = node.inputs?.indexOf(input) ?? -1;
	if (index >= 0) node.removeInput?.(index);
}

function ensureMaskInput(node) {
	let input = (node.inputs || []).find((item) => item?.name === MASK_NAME);
	if (!input) {
		node.addInput?.(MASK_NAME, MASK_TYPE);
		input = (node.inputs || []).find((item) => item?.name === MASK_NAME);
	}
	if (input) {
		input.name = MASK_NAME;
		input.label = "说话人目标遮罩";
		input.localized_name = "说话人目标遮罩";
		input.type = MASK_TYPE;
		input.tooltip = "可选：每个说话人的语义遮罩，传给后续 LongCat Avatar 条件。";
	}
	return input;
}

function addAudioInput(node) {
	const nextIndex = audioInputs(node).length + 1;
	node.addInput?.(`${AUDIO_PREFIX}${nextIndex}`, AUDIO_TYPE);
}

function trimTrailingAudioInputs(node) {
	const inputs = audioInputs(node);
	for (let index = inputs.length - 1; index >= 1; index -= 1) {
		const input = inputs[index];
		if (input?.link) break;
		removeInputObject(node, input);
	}
}

function ensureTrailingAudioInput(node) {
	const inputs = audioInputs(node);
	if (!inputs.length) {
		addAudioInput(node);
		return;
	}
	const last = inputs[inputs.length - 1];
	if (last?.link) addAudioInput(node);
}

function renameAudioInputs(node) {
	audioInputs(node).forEach((input, index) => {
		const n = index + 1;
		input.name = `${AUDIO_PREFIX}${n}`;
		input.label = `音频${n}`;
		input.localized_name = `音频${n}`;
		input.type = AUDIO_TYPE;
		input.tooltip = n === 1 ? "主音频输入。连接后会自动扩充下一路音频。" : `可选第 ${n} 路音频。`;
	});
}

function reorderInputs(node) {
	const mask = (node.inputs || []).find((input) => input?.name === MASK_NAME);
	const audios = audioInputs(node);
	const others = (node.inputs || []).filter((input) => input && input !== mask && !audios.includes(input));
	const nextInputs = [mask, ...audios, ...others].filter(Boolean);
	const currentInputs = node.inputs || [];
	const unchanged = nextInputs.length === currentInputs.length && nextInputs.every((input, index) => input === currentInputs[index]);
	if (unchanged) return;

	node.inputs = nextInputs;
	const graph = node.graph || app.graph;
	for (let index = 0; index < node.inputs.length; index++) {
		const input = node.inputs[index];
		const linkId = input?.link;
		if (linkId == null || !graph?.links) continue;
		const link = graph.links[linkId];
		if (link) {
			link.target_slot = index;
			link.target_id = node.id;
		}
	}
}

function removeLegacyInputs(node) {
	for (const input of [...(node.inputs || [])]) {
		if (input?.name === LEGACY_WHISPER_INPUT) removeInputObject(node, input);
	}
}

function setDirty(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function stabilizeNode(node) {
	if (!node) return;
	removeLegacyInputs(node);
	ensureMaskInput(node);
	trimTrailingAudioInputs(node);
	ensureTrailingAudioInput(node);
	renameAudioInputs(node);
	reorderInputs(node);
	setDirty(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjLongCatWhisperTimer);
	node.__gjjLongCatWhisperTimer = setTimeout(() => stabilizeNode(node), ms);
}

function linkSignature(node) {
	return (node.inputs || []).map((input) => `${input?.name}:${input?.link ?? ""}`).join("|");
}

app.registerExtension({
	name: "Comfy.GJJ.LongCatAvatarWhisperEmbeds",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleStabilize(this, 0);
			setTimeout(() => stabilizeNode(this), 80);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			scheduleStabilize(this, 0);
			setTimeout(() => stabilizeNode(this), 80);
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
			const signature = linkSignature(this);
			if (signature !== this.__gjjLongCatWhisperSignature) {
				this.__gjjLongCatWhisperSignature = signature;
				scheduleStabilize(this, 16);
			}
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) stabilizeNode(node);
		}
	},
});
