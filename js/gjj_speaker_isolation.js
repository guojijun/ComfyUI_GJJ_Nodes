import { app } from "/scripts/app.js";

const TARGET_NODE = "GJJ_SpeakerIsolation";
const OUTPUT_SCHEMA_VERSION = 2;
const INPUT_LABELS = {
	audio: "音频/视频",
	whisper_output: "识别时间戳",
};
const WIDGET_LABELS = {
	speaker_count: "说话人数/下限",
	speaker_index: "选择说话人",
	silence_thresh_db: "静音阈值dB",
	min_segment_s: "最短片段秒",
	merge_gap_s: "合并间隔秒",
	merge_consecutive_speaker: "合并连续同说话人",
	diarization_mode: "识别模式",
	campplus_model: "说话人声纹模型",
	model_device: "模型设备",
	max_speaker_count: "自动人数上限",
	speech_segmentation: "语音分段方式",
};
const OUTPUT_DEFS = [
	{ name: "选中说话人音频", type: "AUDIO" },
	{ name: "说话人文本", type: "STRING" },
	{ name: "说话人JSON", type: "STRING" },
	{ name: "说话人数", type: "INT" },
	{ name: "SRT字幕", type: "STRING" },
];

function isLegacyLayout(node) {
	const outputs = Array.isArray(node?.outputs) ? node.outputs : [];
	if (outputs.length > OUTPUT_DEFS.length) return true;
	const names = outputs.map((output) => String(output?.name || output?.label || ""));
	return names.some((name) => name.includes("原位音频") || name.includes("拼接音频"));
}

function setOutputDefinition(output, definition) {
	if (!output || !definition) return;
	output.name = definition.name;
	output.label = definition.name;
	output.localized_name = definition.name;
	output.type = definition.type;
}

function localizeNode(node) {
	if (!node || String(node.comfyClass || node.type || "") !== TARGET_NODE) return;
	for (const input of node.inputs || []) {
		const label = INPUT_LABELS[input.name];
		if (label) input.localized_name = label;
	}
	for (const widget of node.widgets || []) {
		const label = WIDGET_LABELS[widget.name];
		if (label) widget.label = label;
	}
}

function migrateLegacyOutputs(node) {
	if (!node) return;
	node.properties ||= {};

	if (isLegacyLayout(node)) {
		// 旧 0 号口是“原位音频”，旧 1 号口才是需要保留的拼接音频。
		// 删除 0 号口后 LiteGraph 会同步迁移其余连线的 origin_slot。
		if ((node.outputs?.length || 0) >= 7) {
			node.removeOutput?.(0);
		}
		while ((node.outputs?.length || 0) > 4) {
			node.removeOutput?.(node.outputs.length - 1);
		}
	}

	while ((node.outputs?.length || 0) < OUTPUT_DEFS.length) {
		const definition = OUTPUT_DEFS[node.outputs?.length || 0];
		node.addOutput?.(definition.name, definition.type);
	}
	while ((node.outputs?.length || 0) > OUTPUT_DEFS.length) {
		node.removeOutput?.(node.outputs.length - 1);
	}
	OUTPUT_DEFS.forEach((definition, index) => setOutputDefinition(node.outputs?.[index], definition));
	localizeNode(node);
	node.properties.gjj_speaker_output_schema = OUTPUT_SCHEMA_VERSION;
	node.setDirtyCanvas?.(true, true);
}

function scheduleMigration(node) {
	setTimeout(() => migrateLegacyOutputs(node), 0);
	setTimeout(() => migrateLegacyOutputs(node), 100);
}

app.registerExtension({
	name: "Comfy.GJJ.SpeakerIsolationOutputMigration",

	nodeCreated(node) {
		if (String(node?.comfyClass || node?.type || "") === TARGET_NODE) {
			scheduleMigration(node);
		}
	},

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (String(nodeData?.name || "") !== TARGET_NODE) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleMigration(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			scheduleMigration(this);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (String(node?.comfyClass || node?.type || "") === TARGET_NODE) {
				scheduleMigration(node);
			}
		}
	},
});
