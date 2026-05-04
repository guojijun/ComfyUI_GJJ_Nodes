import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";
import {
	getCachedModelFamilyPresets,
	getModelFamilyPresets,
	matchModelFamilyPreset,
} from "./gjj_model_family_preset_table.js";

const TARGET_NODE = "GJJ_ModelBundleLoader";
const UNET_WIDGET = "unet_name";
const CLIP_NAME_WIDGET = "clip_name";
const CLIP_TYPE_WIDGET = "clip_type";
const VAE_NAME_WIDGET = "vae_name";
const STEPS_WIDGET = "steps";
const CFG_WIDGET = "cfg";
const DENOISE_WIDGET = "denoise";

function getWidget(node, name) {
	return node.widgets?.find((w) => w.name === name);
}

function setWidgetValue(widget, value) {
	if (!widget) return;
	if (widget.value === value) return;
	widget.value = value;
	widget.callback?.(value);
}

// 把推荐值插入到下拉选项第一项，使其可选
function ensureOptionAvailable(widget, value) {
	if (!widget?.options?.values || !value) return;
	const vals = widget.options.values;
	if (vals.includes(value)) return;
	widget.options.values = [value, ...vals];
}

function applyPreset(node) {
	const unetWidget = getWidget(node, UNET_WIDGET);
	if (!unetWidget?.value) return;

	const preset = matchModelFamilyPreset(unetWidget.value);
	if (!preset) return;

	// VAE（模糊匹配：推荐名包含在可用列表中则选中）
	const vaeWidget = getWidget(node, VAE_NAME_WIDGET);
	if (vaeWidget && preset.vaeName) {
		const available = vaeWidget.options?.values || [];
		const match = available.find((f) =>
			String(f).toLowerCase().includes(String(preset.vaeName).toLowerCase().replace(".safetensors", ""))
		) || available[0];
		if (match) {
			ensureOptionAvailable(vaeWidget, match);
			setWidgetValue(vaeWidget, match);
		}
	}

	// CLIP（取推荐名列表的第一个可用项）
	const clipWidget = getWidget(node, CLIP_NAME_WIDGET);
	if (clipWidget && Array.isArray(preset.clipNames) && preset.clipNames.length) {
		const available = clipWidget.options?.values || [];
		// 遍历推荐的 clip 名，找可用列表中最匹配的
		for (const recName of preset.clipNames) {
			const recStem = String(recName).toLowerCase().replace(".safetensors", "");
			const match = available.find((f) =>
				String(f).toLowerCase().includes(recStem)
			);
			if (match) {
				ensureOptionAvailable(clipWidget, match);
				setWidgetValue(clipWidget, match);
				break;
			}
		}
	}

	// CLIP 类型
	if (preset.clipType) {
		const clipTypeWidget = getWidget(node, CLIP_TYPE_WIDGET);
		setWidgetValue(clipTypeWidget, preset.clipType);
	}

	// 采样参数
	if (preset.steps != null) setWidgetValue(getWidget(node, STEPS_WIDGET), preset.steps);
	if (preset.cfg != null) setWidgetValue(getWidget(node, CFG_WIDGET), preset.cfg);
	if (preset.denoise != null) setWidgetValue(getWidget(node, DENOISE_WIDGET), preset.denoise);
}

function hookUnetWidget(node) {
	const widget = getWidget(node, UNET_WIDGET);
	if (!widget || widget.__gjjBundleHooked) return;
	widget.__gjjBundleHooked = true;

	const originalCallback = widget.callback;
	widget.callback = function (value, ...args) {
		const result = originalCallback?.apply(this, [value, ...args]);
		applyPreset(node);
		return result;
	};
}

function stabilizeNode(node) {
	hookUnetWidget(node);
	GJJ_Utils.refreshNode(node);
}

app.registerExtension({
	name: "Comfy.GJJ.ModelBundleLoader",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_NODE) return;
		await getModelFamilyPresets();

		const origCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = origCreated?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const origConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = origConfigure?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};
	},

	nodeCreated(node) {
		if (node.comfyClass !== TARGET_NODE) return;
		stabilizeNode(node);
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === TARGET_NODE) {
				stabilizeNode(node);
			}
		}
	},
});
