import { app } from "/scripts/app.js";

const NODE_TYPE = "GJJ_LTXVAddGuideMulti";
const IMAGE_PREFIX = "image_";
const SETTINGS_WIDGET = "guide_settings_json";
const COUNT_WIDGET = "guide_count";
const PANEL_WIDGET = "gjj_ltxv_add_guide_multi_panel";
const MIN_GUIDES = 1;
const MAX_GUIDES = 20;

function clampGuideCount(value) {
	const raw = Number(value ?? MIN_GUIDES);
	return Math.max(MIN_GUIDES, Math.min(MAX_GUIDES, Number.isFinite(raw) ? Math.round(raw) : MIN_GUIDES));
}

function guideIndex(name) {
	const match = String(name || "").match(/^image_(\d+)$/);
	return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function getImageInputs(node) {
	return Array.isArray(node?.inputs)
		? node.inputs.filter((input) => /^image_\d+$/.test(String(input?.name || ""))).sort((a, b) => guideIndex(a.name) - guideIndex(b.name))
		: [];
}

function getCountWidget(node) {
	return node.widgets?.find?.((item) => item?.name === COUNT_WIDGET);
}

function getSettingsWidget(node) {
	return node.widgets?.find?.((item) => item?.name === SETTINGS_WIDGET);
}

function getGuideCount(node) {
	return clampGuideCount(getCountWidget(node)?.value);
}

function parseSettings(node) {
	const widget = getSettingsWidget(node);
	try {
		const data = JSON.parse(String(widget?.value || "{}"));
		return data && typeof data === "object" && !Array.isArray(data) ? data : {};
	} catch (_) {
		return {};
	}
}

function writeSettings(node, settings) {
	const widget = getSettingsWidget(node);
	if (!widget) return;
	const count = getGuideCount(node);
	const clean = {};
	for (let index = 1; index <= count; index += 1) {
		const row = settings[String(index)] || {};
		const frame = Number(row.frame_idx ?? 0);
		const strength = Number(row.strength ?? 1);
		clean[String(index)] = {
			frame_idx: Number.isFinite(frame) ? Math.round(frame) : 0,
			strength: Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 1,
		};
	}
	widget.value = JSON.stringify(clean);
	if (Array.isArray(node.widgets_values) && Array.isArray(node.widgets)) {
		const widgetIndex = node.widgets.indexOf(widget);
		if (widgetIndex >= 0) node.widgets_values[widgetIndex] = widget.value;
	}
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function setImageInputMeta(input, index) {
	input.name = `${IMAGE_PREFIX}${index}`;
	input.type = "IMAGE";
	input.label = `引导图像 ${index}`;
	input.localized_name = input.label;
	input.tooltip = `第 ${index} 张要插入到 LTX 视频 latent 的引导图像。`;
}

function ensureImageInputs(node) {
	const targetCount = getGuideCount(node);
	let inputs = getImageInputs(node);

	for (let index = inputs.length + 1; index <= targetCount; index += 1) {
		node.addInput?.(`${IMAGE_PREFIX}${index}`, "IMAGE");
	}

	inputs = getImageInputs(node);
	for (let index = inputs.length; index > targetCount; index -= 1) {
		const input = inputs[index - 1];
		const slot = node.inputs?.indexOf(input) ?? -1;
		if (slot >= 0) {
			try { node.disconnectInput?.(slot); } catch (_) {}
			try { node.removeInput?.(slot); } catch (_) { node.inputs.splice(slot, 1); }
		}
	}

	getImageInputs(node).forEach((input, zeroIndex) => setImageInputMeta(input, zeroIndex + 1));
}

function hideSettingsWidget(node) {
	const widget = getSettingsWidget(node);
	if (!widget || widget.__gjjHidden) return;
	widget.__gjjHidden = true;
	widget.type = "hidden";
	widget.options ||= {};
	widget.options.serialize = true;
	widget.computeSize = () => [0, -4];
	widget.draw = () => {};
}

function patchCountWidget(node) {
	const widget = getCountWidget(node);
	if (!widget || widget.__gjjGuideCountPatched) return;
	widget.__gjjGuideCountPatched = true;
	widget.label = "引导数量";
	widget.localized_name = "引导数量";
	widget.options ||= {};
	widget.options.display_name = "引导数量";
	widget.options.tooltip = "需要使用的引导图像数量；改变后会自动增减 IMAGE 输入和参数行。";
	const originalCallback = widget.callback;
	widget.callback = function (...args) {
		widget.value = clampGuideCount(widget.value);
		const result = originalCallback?.apply(this, args);
		setTimeout(() => stabilize(node), 0);
		return result;
	};
}

function createNumberInput(value, min, max, step, onChange) {
	const input = document.createElement("input");
	input.type = "number";
	input.value = String(value);
	input.min = String(min);
	input.max = String(max);
	input.step = String(step);
	input.addEventListener("input", () => onChange(Number(input.value)));
	return input;
}

function renderPanel(node, root) {
	const count = getGuideCount(node);
	const settings = parseSettings(node);
	root.textContent = "";
	root.className = "gjj-ltxv-guide-panel";

	for (let index = 1; index <= count; index += 1) {
		const key = String(index);
		const rowData = settings[key] || {};
		const row = document.createElement("div");
		row.className = "gjj-ltxv-guide-row";

		const title = document.createElement("span");
		title.className = "gjj-ltxv-guide-title";
		title.textContent = `图像 ${index}`;

		const frameWrap = document.createElement("label");
		frameWrap.textContent = "帧";
		const frameInput = createNumberInput(rowData.frame_idx ?? 0, -9999, 9999, 1, (value) => {
			const current = parseSettings(node);
			current[key] ||= {};
			current[key].frame_idx = Number.isFinite(value) ? Math.round(value) : 0;
			writeSettings(node, current);
		});
		frameWrap.appendChild(frameInput);

		const strengthWrap = document.createElement("label");
		strengthWrap.textContent = "强度";
		const strengthInput = createNumberInput(rowData.strength ?? 1, 0, 1, 0.01, (value) => {
			const current = parseSettings(node);
			current[key] ||= {};
			current[key].strength = Number.isFinite(value) ? value : 1;
			writeSettings(node, current);
		});
		strengthWrap.appendChild(strengthInput);

		row.append(title, frameWrap, strengthWrap);
		root.appendChild(row);
	}
}

function ensurePanel(node) {
	let widget = node.widgets?.find?.((item) => item?.name === PANEL_WIDGET);
	if (!widget) {
		const root = document.createElement("div");
		widget = node.addDOMWidget?.(PANEL_WIDGET, "gjj_ltxv_guide_panel", root, {
			serialize: false,
			hideOnZoom: false,
		});
		if (!widget) {
			widget = node.addWidget?.("text", PANEL_WIDGET, "", () => {}, { serialize: false });
			widget.computeSize = () => [node.size?.[0] || 320, 0];
			return;
		}
		widget.root = root;
	}
	if (widget.root) renderPanel(node, widget.root);
}

function injectStyle() {
	if (document.getElementById("gjj-ltxv-add-guide-multi-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-ltxv-add-guide-multi-style";
	style.textContent = `
		.gjj-ltxv-guide-panel {
			box-sizing: border-box;
			width: 100%;
			padding: 6px 8px 2px;
			color: #dbe7ee;
			font: 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		}
		.gjj-ltxv-guide-row {
			display: grid;
			grid-template-columns: 62px minmax(0, 1fr) minmax(0, 1fr);
			gap: 8px;
			align-items: center;
			margin: 4px 0;
		}
		.gjj-ltxv-guide-title {
			color: #b9c8d3;
			font-weight: 700;
			white-space: nowrap;
		}
		.gjj-ltxv-guide-row label {
			display: flex;
			align-items: center;
			gap: 5px;
			color: #9fb0bd;
			white-space: nowrap;
		}
		.gjj-ltxv-guide-row input {
			box-sizing: border-box;
			min-width: 0;
			width: 100%;
			height: 26px;
			border: 1px solid #324652;
			border-radius: 6px;
			background: #101820;
			color: #f4f8fb;
			padding: 2px 6px;
			outline: none;
		}
		.gjj-ltxv-guide-row input:focus {
			border-color: #38c7e8;
			box-shadow: 0 0 0 1px rgba(56, 199, 232, 0.35);
		}
	`;
	document.head.appendChild(style);
}

function stabilize(node) {
	if (!node || (node.comfyClass !== NODE_TYPE && node.type !== NODE_TYPE)) return;
	injectStyle();
	patchCountWidget(node);
	hideSettingsWidget(node);
	ensureImageInputs(node);
	const settings = parseSettings(node);
	writeSettings(node, settings);
	ensurePanel(node);
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

app.registerExtension({
	name: "GJJ.LTXVAddGuideMulti.DynamicPanel",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			setTimeout(() => stabilize(this), 0);
			setTimeout(() => stabilize(this), 120);
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			setTimeout(() => stabilize(this), 0);
			setTimeout(() => stabilize(this), 120);
			return result;
		};
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === NODE_TYPE || node?.type === NODE_TYPE) {
				stabilize(node);
			}
		}
	},
});
