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
const UNET_DTYPE_WIDGET = "unet_dtype";
const CLIP_DTYPE_WIDGET = "clip_dtype";
const VAE_DTYPE_WIDGET = "vae_dtype";
const STEPS_WIDGET = "steps";
const CFG_WIDGET = "cfg";
const DENOISE_WIDGET = "denoise";
const PANEL_WIDGET = "gjj_model_bundle_loader_panel";
const MODEL_WIDGETS = [
	UNET_WIDGET,
	UNET_DTYPE_WIDGET,
	CLIP_NAME_WIDGET,
	CLIP_TYPE_WIDGET,
	CLIP_DTYPE_WIDGET,
	VAE_NAME_WIDGET,
	VAE_DTYPE_WIDGET,
];

function getWidget(node, name) {
	return node.widgets?.find((w) => w.name === name);
}

function setWidgetValue(widget, value) {
	if (!widget) return;
	if (widget.value === value) return;
	widget.value = value;
	widget.callback?.(value);
}

function valuesOf(widget) {
	return Array.isArray(widget?.options?.values) ? widget.options.values.map(String) : [];
}

function lower(value) {
	return String(value || "").replaceAll("\\", "/").toLowerCase();
}

function stemOf(value) {
	return lower(value).split("/").pop().replace(/\.(safetensors|ckpt|pt|pth|bin|sft)$/i, "");
}

function shortMatch(query, values, fallback = "") {
	const q = stemOf(query);
	if (!q) return fallback || values?.[0] || "";
	const ranked = (values || []).map(String).map((value) => {
		const text = lower(value);
		const filename = text.split("/").pop();
		const stem = stemOf(filename);
		let bucket = 999;
		if (filename === `${q}.safetensors`) bucket = 0;
		else if (stem === q) bucket = 1;
		else if (filename.startsWith(`${q}.`)) bucket = 2;
		else if (stem.startsWith(q)) bucket = 3;
		else if (stem.includes(q)) bucket = 4;
		else if (text.includes(q)) bucket = 5;
		return { value, bucket, filenameLength: filename.length, textLength: text.length, text };
	}).filter((item) => item.bucket < 999);
	ranked.sort((a, b) =>
		a.bucket - b.bucket
		|| a.filenameLength - b.filenameLength
		|| a.textLength - b.textLength
		|| a.text.localeCompare(b.text, "zh-Hans-CN")
	);
	return ranked[0]?.value || fallback || values?.[0] || "";
}

function sortOptionsShortest(values) {
	return (values || []).map(String).slice().sort((a, b) => {
		const af = lower(a).split("/").pop();
		const bf = lower(b).split("/").pop();
		if (af.length !== bf.length) return af.length - bf.length;
		return lower(a).localeCompare(lower(b), "zh-Hans-CN");
	});
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
		const match = shortMatch(preset.vaeName, available, available[0]);
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
			const match = shortMatch(recStem, available, "");
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

function protect(el) {
	el?.addEventListener?.("pointerdown", (event) => event.stopPropagation());
	el?.addEventListener?.("mousedown", (event) => event.stopPropagation());
	el?.addEventListener?.("click", (event) => event.stopPropagation());
}

function hideNativeModelWidgets(node) {
	for (const name of MODEL_WIDGETS) {
		const widget = getWidget(node, name);
		if (!widget) continue;
		if (!widget.__gjjBundleOriginals) {
			widget.__gjjBundleOriginals = {
				type: widget.type,
				draw: widget.draw,
				computeSize: widget.computeSize,
				getHeight: widget.getHeight,
				mouse: widget.mouse,
				y: widget.y,
				last_y: widget.last_y,
			};
		}
		widget.hidden = true;
		widget.disabled = true;
		widget.type = `converted-widget:${widget.name || "hidden"}`;
		widget.options = widget.options || {};
		widget.options.hidden = true;
		widget.options.display = "hidden";
		widget.computeSize = () => [0, 0];
		widget.getHeight = () => 0;
		widget.draw = () => {};
		widget.mouse = () => false;
		widget.y = -10000;
		widget.last_y = -10000;
		widget.computedHeight = 0;
		widget.size = [0, 0];
		for (const el of [widget.element, widget.inputEl, widget.widget]) {
			if (!el?.style) continue;
			el.style.display = "none";
			el.style.height = "0";
			el.style.margin = "0";
			el.style.padding = "0";
		}
	}
}

function syncSelect(select, widget) {
	if (!select || !widget) return;
	select.value = String(widget.value ?? "");
}

function makeSelect(node, widgetName, options = null) {
	const widget = getWidget(node, widgetName);
	const select = document.createElement("select");
	select.className = "gjj-bundle-select";
	select.dataset.widgetName = widgetName;
	const values = options || valuesOf(widget);
	select.replaceChildren();
	for (const value of values) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value;
		select.appendChild(option);
	}
	select.value = String(widget?.value ?? values[0] ?? "");
	select.title = select.value;
	select.addEventListener("change", () => {
		setWidgetValue(widget, select.value);
		select.title = select.value;
		if (widgetName === UNET_WIDGET) applyPreset(node);
		refreshPanel(node);
	});
	protect(select);
	return select;
}

function row(labelText, modelSelect, dtypeSelect = null) {
	const item = document.createElement("div");
	item.className = `gjj-bundle-row${dtypeSelect ? "" : " no-dtype"}`;
	const label = document.createElement("div");
	label.className = "gjj-bundle-label";
	label.textContent = labelText;
	item.append(label, modelSelect);
	if (dtypeSelect) item.append(dtypeSelect);
	return item;
}

function clipRow(node) {
	const item = document.createElement("div");
	item.className = "gjj-bundle-row clip-row";
	const label = document.createElement("div");
	label.className = "gjj-bundle-label";
	label.textContent = "🟡 CLIP参数";
	item.append(
		label,
		makeSelect(node, CLIP_NAME_WIDGET, sortOptionsShortest(valuesOf(getWidget(node, CLIP_NAME_WIDGET)))),
		makeSelect(node, CLIP_TYPE_WIDGET),
		makeSelect(node, CLIP_DTYPE_WIDGET),
	);
	return item;
}

function panelHeight() {
	return 98;
}

function buildPanel(node) {
	const wrap = document.createElement("div");
	wrap.className = "gjj-bundle-panel";
	const style = document.createElement("style");
	style.textContent = `
		.gjj-bundle-panel { box-sizing:border-box; display:flex; flex-direction:column; gap:4px; padding:0 16px 0 0; margin-left:-10px; }
		.gjj-bundle-panel * { box-sizing:border-box; }
		.gjj-bundle-row { display:grid; grid-template-columns:96px minmax(0,1fr) 86px; gap:6px; align-items:center; min-width:0; }
		.gjj-bundle-row.clip-row { grid-template-columns:96px minmax(0,1.25fr) minmax(108px,.68fr) 86px; }
		.gjj-bundle-row.no-dtype { grid-template-columns:96px minmax(0,1fr); }
		.gjj-bundle-label { color:#c4d0d3; font-size:12px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
		.gjj-bundle-select {
			width:100%; min-width:0; height:28px; padding:3px 8px; border:1px solid #344b54; border-radius:7px;
			background:#263036; color:#f2f5f5; outline:none; font-size:12px;
		}
		.gjj-bundle-select:focus { border-color:#5b8d9a; background:#1d2b31; }
	`;
	wrap.appendChild(style);
	wrap.append(
		row("🟣 UNET模型", makeSelect(node, UNET_WIDGET, sortOptionsShortest(valuesOf(getWidget(node, UNET_WIDGET)))), makeSelect(node, UNET_DTYPE_WIDGET)),
		clipRow(node),
		row("🔴 VAE", makeSelect(node, VAE_NAME_WIDGET, sortOptionsShortest(valuesOf(getWidget(node, VAE_NAME_WIDGET)))), makeSelect(node, VAE_DTYPE_WIDGET)),
	);
	return wrap;
}

function ensurePanel(node) {
	if (node.__gjjBundlePanelWidget || typeof node.addDOMWidget !== "function") return;
	const panel = buildPanel(node);
	node.__gjjBundlePanel = panel;
	const widget = node.addDOMWidget(PANEL_WIDGET, "HTML", panel, { serialize: false, hideOnZoom: false });
	widget.computeSize = (width) => [Math.max(560, Number(width || node.size?.[0] || 600)), panelHeight()];
	widget.getHeight = () => panelHeight();
	node.__gjjBundlePanelWidget = widget;
	const index = node.widgets?.indexOf(widget);
	if (index > 0) {
		node.widgets.splice(index, 1);
		node.widgets.unshift(widget);
	}
}

function refreshPanel(node) {
	if (!node?.__gjjBundlePanel) return;
	for (const select of node.__gjjBundlePanel.querySelectorAll("select")) {
		const name = select.dataset?.widgetName;
		if (name) syncSelect(select, getWidget(node, name));
	}
	shrinkNodeToContent(node);
}

function shrinkNodeToContent(node) {
	if (!node) return;
	requestAnimationFrame(() => {
		const computed = node.computeSize?.() || node.size || [600, 160];
		const width = Math.max(600, Number(node.size?.[0] || computed[0] || 600));
		const height = Math.max(150, Number(computed[1] || 150));
		node.setSize?.([width, height]);
		node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	});
}

function frontLoraInput(node) {
	if (!Array.isArray(node.inputs)) return;
	const index = node.inputs.findIndex((input) => String(input?.name || "").includes("lora_chain_config") || String(input?.type || "").includes("LORA_CHAIN_CONFIG") || String(input?.localized_name || "").includes("LoRA"));
	if (index > 0) {
		const [input] = node.inputs.splice(index, 1);
		node.inputs.unshift(input);
	}
}

function hookUnetWidget(node) {
	const widget = getWidget(node, UNET_WIDGET);
	if (!widget || widget.__gjjBundleHooked) return;
	widget.__gjjBundleHooked = true;

	const originalCallback = widget.callback;
	widget.callback = function (value, ...args) {
		const result = originalCallback?.apply(this, [value, ...args]);
		applyPreset(node);
		setTimeout(() => refreshPanel(node), 0);
		return result;
	};
}

function stabilizeNode(node) {
	frontLoraInput(node);
	hideNativeModelWidgets(node);
	ensurePanel(node);
	hookUnetWidget(node);
	shrinkNodeToContent(node);
	setTimeout(() => {
		hideNativeModelWidgets(node);
		shrinkNodeToContent(node);
	}, 80);
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
