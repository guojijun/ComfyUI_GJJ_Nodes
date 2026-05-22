import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_WanVideoSamplerV2"]);
const LEGACY_CONTROL_VALUES = new Set(["fixed", "increment", "decrement", "randomize"]);
const VALUE_FIELDS = [
	"steps",
	"cfg",
	"shift",
	"seed",
	"force_offload",
	"scheduler",
	"riflex_freq_index",
	"denoise_strength",
	"batched_cfg",
	"rope_function",
	"start_step",
	"end_step",
	"add_noise_to_samples",
];

const SERIALIZED_FIELDS = [
	"steps",
	"cfg",
	"shift",
	"seed",
	"control_after_generate",
	"force_offload",
	"scheduler",
	"riflex_freq_index",
	"denoise_strength",
	"batched_cfg",
	"rope_function",
	"start_step",
	"end_step",
	"add_noise_to_samples",
];

const NATIVE_WIDGET_NAMES = new Set(SERIALIZED_FIELDS);

function isLegacyShiftedValues(values) {
	return Array.isArray(values) &&
		values.length >= 16 &&
		values[0] === "" &&
		LEGACY_CONTROL_VALUES.has(values[5]) &&
		values[6] === "" &&
		typeof values[7] === "string";
}

function normalizeLegacyValues(values) {
	if (!isLegacyShiftedValues(values)) return null;
	return {
		steps: values[1],
		cfg: values[2],
		shift: values[3],
		seed: values[4],
		control_after_generate: values[5],
		force_offload: true,
		scheduler: values[7],
		riflex_freq_index: values[8],
		denoise_strength: values[9],
		batched_cfg: values[10],
		rope_function: values[11],
		start_step: values[12],
		end_step: values[13],
		add_noise_to_samples: values[14],
	};
}

function getWidget(node, name) {
	return (node.widgets || []).find((widget) => widget?.name === name);
}

function setWidgetValue(widget, value) {
	if (!widget) return false;
	const changed = widget.value !== value;
	widget.value = value;
	widget.callback?.(value);
	if (widget.inputEl && "value" in widget.inputEl) widget.inputEl.value = value;
	if (widget.element && "value" in widget.element) widget.element.value = value;
	return changed;
}

function applyValues(node, values) {
	if (!values || typeof values !== "object") return false;
	let changed = false;
	for (const name of SERIALIZED_FIELDS) {
		const widget = getWidget(node, name);
		if (!widget || !(name in values)) continue;
		if (setWidgetValue(widget, values[name])) changed = true;
	}
	return changed;
}

function valuesToSerializedArray(values) {
	return SERIALIZED_FIELDS.map((name) => values?.[name]);
}

function normalizeNode(node, serializedNode = null) {
	if (!node) return;
	const sourceValues = serializedNode?.widgets_values || node.widgets_values;
	const normalized = normalizeLegacyValues(sourceValues);
	if (!normalized) return;
	node.properties = node.properties || {};
	node.properties.gjj_wanvideo_sampler_v2_widget_migrated = true;
	applyValues(node, normalized);
	node.widgets_values = valuesToSerializedArray(normalized);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function normalizeSerialized(node, serializedNode) {
	if (!serializedNode) return;
	const normalized = normalizeLegacyValues(serializedNode.widgets_values);
	if (normalized) serializedNode.widgets_values = valuesToSerializedArray(normalized);
	serializedNode.widgets_values = Array.isArray(serializedNode.widgets_values)
		? serializedNode.widgets_values
		: [];
	for (let index = 0; index < SERIALIZED_FIELDS.length; index += 1) {
		const name = SERIALIZED_FIELDS[index];
		const widget = getWidget(node, name);
		if (widget) serializedNode.widgets_values[index] = widget.value;
	}
}

app.registerExtension({
	name: "Comfy.GJJ.WanVideoSamplerV2Compat",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const normalized = normalizeLegacyValues(serializedNode?.widgets_values);
			if (normalized) {
				serializedNode.widgets_values = valuesToSerializedArray(normalized);
			}
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			if (normalized) {
				this.properties = this.properties || {};
				this.properties.gjj_wanvideo_sampler_v2_widget_migrated = true;
				applyValues(this, normalized);
				this.widgets_values = valuesToSerializedArray(normalized);
				this.setDirtyCanvas?.(true, true);
				app.graph?.setDirtyCanvas?.(true, true);
			} else {
				normalizeNode(this, serializedNode);
			}
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			originalOnSerialize?.apply(this, [serializedNode]);
			normalizeSerialized(this, serializedNode);
		};
	},

	nodeCreated(node) {
		if (TARGET_NODES.has(node?.comfyClass)) normalizeNode(node);
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) normalizeNode(node);
		}
	},
});
