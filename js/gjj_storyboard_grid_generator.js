import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";
import { createTemplateSourceButton, updateTemplateSourcePanel } from "./gjj_generation_template_sources.js";
import { getModelFamilyPresets, matchModelFamilyPreset } from "./gjj_model_family_preset_table.js";

const TARGET_NODES = new Set(["GJJ_StoryboardGridGenerator"]);
const SETTINGS_OPEN_PROPERTY = "gjj_storyboard_grid_settings_open_v3";
const EXECUTE_BUTTON_NAME = "__gjj_storyboard_execute_button";
const IMAGE_PREVIEW_NAME = "__gjj_storyboard_image_preview";
const PARAM_VALUES_PROPERTY = "gjj_storyboard_grid_param_values_v3";
const SEED_CONTROL_KEY = "__seed_control_after_generate";
const SEED_CONTROL_VALUES = new Set(["fixed", "increment", "decrement", "randomize"]);
const JS_SAFE_MAX_SEED_VALUE = Number.MAX_SAFE_INTEGER;
const ALWAYS_VISIBLE_WIDGETS = new Set(["prompt"]);
const ALWAYS_HIDDEN_WIDGETS = new Set(["lora_data"]);
const PANEL_SYNC_WIDGETS = [
	"prompt",
	"negative_prompt",
	"main_image_index",
	"width",
	"height",
	"batch_size",
	"unet_name",
	"unet_dtype",
	"clip_name1",
	"vae_name",
	"seed",
	"steps",
	"cfg",
	"sampler_name",
	"scheduler",
	"denoise",
	"grow_mask_by",
	"layout_mode",
	"gap",
	"cell_fit",
	"resize_method",
	"size_alignment",
];
const TEMPLATE_SOURCE_FIELDS = [
	{ name: "prompt", widget: "prompt", label: "提示词", type: "STRING", aliases: ["prompt", "positive", "正向", "提示词"] },
	{ name: "width", widget: "width", label: "宽度", type: "INT", aliases: ["width", "宽", "宽度"] },
	{ name: "height", widget: "height", label: "高度", type: "INT", aliases: ["height", "高", "高度"] },
];
const DEFAULT_LORA_ROW = { enabled: true, name: "", strength: 1.0 };

function isTarget(node) {
	return TARGET_NODES.has(node?.comfyClass || node?.type);
}

function getWidget(node, name) {
	return GJJ_Utils.getWidget?.(node, name) || node?.widgets?.find((widget) => widget?.name === name);
}

function getInput(node, name) {
	return node?.inputs?.find((input) => String(input?.name || "") === name);
}

function settingsOpen(node) {
	return Boolean(node?.properties?.[SETTINGS_OPEN_PROPERTY]);
}

function setWidgetValue(widget, value) {
	if (!widget) return;
	widget.value = value;
	if (widget.inputEl && "value" in widget.inputEl) widget.inputEl.value = value;
	if (widget.element && "value" in widget.element) widget.element.value = value;
	widget.callback?.(value);
}

function textValue(value) {
	return String(value ?? "").trim();
}

function intValue(value, fallback = 0, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.max(min, Math.min(max, Math.round(number)));
}

function isSeedControlValue(value) {
	return SEED_CONTROL_VALUES.has(textValue(value));
}

function isSeedControlWidget(widget) {
	const name = textValue(widget?.name).toLowerCase();
	if (/(control_after_generate|after_generate|seed.*control|randomize)/.test(name)) {
		return true;
	}
	return isSeedControlValue(widget?.value) && (widget?.hidden || String(widget?.type || "").toLowerCase() === "combo");
}

function findSeedControlWidget(node) {
	if (!Array.isArray(node?.widgets)) return null;
	const seedIndex = node.widgets.findIndex((widget) => widget?.name === "seed");
	const stepsIndex = node.widgets.findIndex((widget) => widget?.name === "steps");
	if (seedIndex >= 0 && stepsIndex > seedIndex + 1) {
		for (let index = seedIndex + 1; index < stepsIndex; index += 1) {
			const widget = node.widgets[index];
			if (isSeedControlWidget(widget) || isSeedControlValue(widget?.value)) {
				return widget;
			}
		}
	}
	return node.widgets.find((widget) => isSeedControlWidget(widget)) || null;
}

function randomSeedValue() {
	return Math.floor(Math.random() * (JS_SAFE_MAX_SEED_VALUE + 1));
}

function seedControlMode(node) {
	const widgetValue = textValue(findSeedControlWidget(node)?.value);
	if (isSeedControlValue(widgetValue)) return widgetValue;
	const storedValue = textValue(node?.properties?.[PARAM_VALUES_PROPERTY]?.[SEED_CONTROL_KEY]);
	if (isSeedControlValue(storedValue)) return storedValue;
	return "randomize";
}

function applySeedControlBeforeQueue(node) {
	const seedWidget = getWidget(node, "seed");
	if (!seedWidget) return null;
	const now = Date.now();
	if (node.__gjjStoryboardSeedPreparedAt && now - node.__gjjStoryboardSeedPreparedAt < 500) {
		return intValue(seedWidget.value, 0, 0, JS_SAFE_MAX_SEED_VALUE);
	}
	const mode = seedControlMode(node);
	const currentSeed = intValue(seedWidget.value, 0, 0, JS_SAFE_MAX_SEED_VALUE);
	let nextSeed = currentSeed;
	if (mode === "randomize") {
		nextSeed = randomSeedValue();
	} else if (mode === "increment") {
		nextSeed = currentSeed >= JS_SAFE_MAX_SEED_VALUE ? 0 : currentSeed + 1;
	} else if (mode === "decrement") {
		nextSeed = currentSeed <= 0 ? JS_SAFE_MAX_SEED_VALUE : currentSeed - 1;
	} else {
		return currentSeed;
	}
	setWidgetValue(seedWidget, nextSeed);
	node.__gjjStoryboardSeedPreparedAt = now;
	saveParamValues(node);
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	node.graph?.change?.();
	return nextSeed;
}

function syncSeedControlWidget(node) {
	const widget = findSeedControlWidget(node);
	if (!widget || widget.__gjjStoryboardSeedControlHooked) return;
	widget.__gjjStoryboardSeedControlHooked = true;
	const storedValue = textValue(node?.properties?.[PARAM_VALUES_PROPERTY]?.[SEED_CONTROL_KEY]);
	if (isSeedControlValue(storedValue) && widget.value !== storedValue) {
		setWidgetValue(widget, storedValue);
	}
	const originalCallback = widget.callback;
	widget.callback = function (value, ...args) {
		const result = originalCallback?.apply(this, [value, ...args]);
		const mode = textValue(value);
		if (isSeedControlValue(mode)) {
			saveParamValues(node);
		}
		return result;
	};
}

function patchStoryboardSeedIntoPromptData(promptData) {
	const output = promptData?.output || promptData?.prompt;
	if (!output || typeof output !== "object") return promptData;
	const nodes = Array.isArray(app.graph?._nodes) ? app.graph._nodes : [];
	for (const [key, entry] of Object.entries(output)) {
		if (!TARGET_NODES.has(entry?.class_type)) continue;
		const node = nodes.find((item) => String(item?.id) === String(key) && isTarget(item));
		if (!node) continue;
		const seed = applySeedControlBeforeQueue(node);
		if (seed === null || seed === undefined) continue;
		entry.inputs = entry.inputs || {};
		entry.inputs.seed = seed;
		if (promptData?.prompt && promptData.prompt !== promptData.output && promptData.prompt[key]) {
			promptData.prompt[key].inputs = promptData.prompt[key].inputs || {};
			promptData.prompt[key].inputs.seed = seed;
		}
	}
	return promptData;
}

function installStoryboardSeedPromptPatch() {
	if (app.__gjjStoryboardGridSeedPromptPatchInstalled || typeof app.graphToPrompt !== "function") return;
	app.__gjjStoryboardGridSeedPromptPatchInstalled = true;
	const originalGraphToPrompt = app.graphToPrompt.bind(app);
	app.graphToPrompt = async function (...args) {
		const result = await originalGraphToPrompt(...args);
		return patchStoryboardSeedIntoPromptData(result);
	};
}

function normalizeStrength(value, fallback = 1.0) {
	const number = Number(value);
	return Number.isFinite(number) ? number : fallback;
}

function presetLoraRows(preset) {
	const rows = [];
	if (preset?.lora1 && String(preset.lora1).trim()) {
		rows.push({
			enabled: preset.lora1AutoEnabled !== false,
			name: String(preset.lora1),
			strength: normalizeStrength(preset.lora1Strength, 1.0),
		});
	}
	if (preset?.lora2 && String(preset.lora2).trim()) {
		rows.push({
			enabled: true,
			name: String(preset.lora2),
			strength: normalizeStrength(preset.lora2Strength, 0.7),
		});
	}
	if (rows.length) rows.push({ ...DEFAULT_LORA_ROW });
	return rows;
}

function setPresetLoraData(node, preset) {
	const widget = getWidget(node, "lora_data");
	if (!widget) return;
	const rows = presetLoraRows(preset);
	setWidgetValue(widget, JSON.stringify(rows.length ? rows : []));
}

function hasConfiguredLoraData(node) {
	const text = String(getWidget(node, "lora_data")?.value || "").trim();
	if (!text || text === "[]") return false;
	try {
		const rows = JSON.parse(text);
		return Array.isArray(rows) && rows.some((row) => row && typeof row === "object" && String(row.name || "").trim());
	} catch {
		return true;
	}
}

function rememberWidget(widget) {
	if (!widget || widget.__gjjStoryboardNativeState) return;
	widget.__gjjStoryboardNativeState = {
		type: widget.type,
		hidden: widget.hidden,
		disabled: widget.disabled,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		draw: widget.draw,
		mouse: widget.mouse,
		widgetDisplay: widget.widget?.style?.display || "",
		elementDisplay: widget.element?.style?.display || "",
		inputDisplay: widget.inputEl?.style?.display || "",
	};
}

function setWidgetHidden(widget, hidden) {
	if (!widget) return;
	rememberWidget(widget);
	const state = widget.__gjjStoryboardNativeState || {};
	widget.options ||= {};
	if (!hidden) {
		widget.hidden = false;
		widget.disabled = false;
		widget.serialize = true;
		widget.type = state.type || widget.type || "text";
		if (state.computeSize) widget.computeSize = state.computeSize;
		else delete widget.computeSize;
		if (state.getHeight) widget.getHeight = state.getHeight;
		else delete widget.getHeight;
		if (state.draw) widget.draw = state.draw;
		else delete widget.draw;
		if (state.mouse) widget.mouse = state.mouse;
		else delete widget.mouse;
		delete widget.options.hidden;
		delete widget.options.display;
		if (widget.widget) widget.widget.style.display = state.widgetDisplay || "";
		if (widget.element) widget.element.style.display = state.elementDisplay || "";
		if (widget.inputEl) widget.inputEl.style.display = state.inputDisplay || "";
		return;
	}
	widget.hidden = true;
	widget.disabled = true;
	widget.serialize = true;
	widget.type = "hidden";
	widget.options.hidden = true;
	widget.options.display = "hidden";
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.mouse = () => false;
	if (widget.widget) widget.widget.style.display = "none";
	if (widget.element) widget.element.style.display = "none";
	if (widget.inputEl) widget.inputEl.style.display = "none";
}

function updateSettingsButtonState(node) {
	const button = node?.__gjjStoryboardSettingsButton;
	if (!button) return;
	const open = settingsOpen(node);
	button.textContent = open ? "⚙️收起" : "⚙️设置";
	button.title = open ? "收起更多设置，只保留正向提示词。" : "展开更多设置，显示反向提示词、模型、尺寸、采样和宫格参数。";
	button.classList.toggle("on", open);
	button.style.background = open ? "linear-gradient(135deg, #4b5563, #64748b)" : "linear-gradient(135deg, #1f2933, #374151)";
	button.style.borderColor = open ? "#94a3b8" : "#55636f";
	button.style.color = open ? "#ffffff" : "#e5edf2";
}

function orderWidgets(node) {
	if (!Array.isArray(node?.widgets)) return;
	const rank = (widget) => {
		const name = String(widget?.name || "");
		if (widget === node.__gjjStoryboardExecuteWidget || name === EXECUTE_BUTTON_NAME) return 0;
		if (name === "prompt") return 10;
		if (widget === node.__gjjStoryboardPreviewWidget || name === IMAGE_PREVIEW_NAME) return 100;
		if (ALWAYS_HIDDEN_WIDGETS.has(name) || widget?.hidden) return 900;
		return 50;
	};
	node.widgets = node.widgets
		.map((widget, index) => ({ widget, index }))
		.sort((left, right) => rank(left.widget) - rank(right.widget) || left.index - right.index)
		.map((item) => item.widget);
}

function applySettingsVisibility(node) {
	if (!node) return;
	const open = settingsOpen(node);
	for (const name of PANEL_SYNC_WIDGETS) {
		const widget = getWidget(node, name);
		if (!widget || ALWAYS_HIDDEN_WIDGETS.has(name)) continue;
		setWidgetHidden(widget, !open && !ALWAYS_VISIBLE_WIDGETS.has(name));
	}
	for (const name of ALWAYS_HIDDEN_WIDGETS) {
		setWidgetHidden(getWidget(node, name), true);
	}
	updateSettingsButtonState(node);
	orderWidgets(node);
	updateTemplateSourcePanel(node, TEMPLATE_SOURCE_FIELDS);
	GJJ_Utils.refreshNode?.(node);
}

function setSettingsOpen(node, open) {
	node.properties ||= {};
	node.properties[SETTINGS_OPEN_PROPERTY] = Boolean(open);
	applySettingsVisibility(node);
}

function createButtons(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:row",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	const sharedButtonStyle = [
		"height:32px",
		"padding:0 10px",
		"border-radius:6px",
		"color:#e5edf2",
		"font-size:12px",
		"font-weight:700",
		"cursor:pointer",
		"transition:all 0.15s ease",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1001",
		"pointer-events:auto",
		"user-select:none",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"gap:4px",
		"white-space:nowrap",
		"min-width:0",
	];

	const generateButton = document.createElement("button");
	generateButton.type = "button";
	generateButton.innerHTML = "✨ 生成图片";
	generateButton.title = "只执行当前分镜宫格节点。";
	generateButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #10b981",
		"background:linear-gradient(135deg, #064e3b, #059669)",
		"color:#a7f3d0",
		"flex:1",
	].join(";");

	const templateButton = createTemplateSourceButton(node, TEMPLATE_SOURCE_FIELDS, sharedButtonStyle);

	const settingsButton = document.createElement("button");
	settingsButton.type = "button";
	settingsButton.textContent = "⚙️设置";
	settingsButton.title = "展开更多设置";
	settingsButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #55636f",
		"background:linear-gradient(135deg, #1f2933, #374151)",
		"color:#e5edf2",
		"flex:0 0 74px",
	].join(";");
	node.__gjjStoryboardSettingsButton = settingsButton;

	function protectEvent(event) {
		event.preventDefault();
		event.stopPropagation();
	}

	function setupButtonHover(button, defaultBg, hoverBg) {
		button.addEventListener("mouseenter", () => {
			if (button === settingsButton && settingsOpen(node)) return;
			button.style.background = hoverBg;
			button.style.transform = "translateY(-1px)";
		});
		button.addEventListener("mouseleave", () => {
			if (button === settingsButton && settingsOpen(node)) {
				button.style.transform = "translateY(0)";
				updateSettingsButtonState(node);
				return;
			}
			button.style.background = defaultBg;
			button.style.transform = "translateY(0)";
		});
	}

	function setupButtonEvents(button, handler) {
		let lastHandledAt = 0;
		const wrapped = (event) => {
			const now = Date.now();
			protectEvent(event);
			if (now - lastHandledAt < 250) return;
			lastHandledAt = now;
			handler(event);
		};
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
			button.addEventListener(eventName, protectEvent, true);
			container.addEventListener(eventName, protectEvent, true);
		}
		button.addEventListener("pointerup", wrapped, true);
		button.addEventListener("click", wrapped, true);
	}

	async function handleGenerate(event) {
		protectEvent(event);
		resetLivePreview(node);
		const originalText = generateButton.innerHTML;
		generateButton.innerHTML = "⏳ 执行中";
		generateButton.disabled = true;
		generateButton.style.opacity = "0.7";
		try {
			applySeedControlBeforeQueue(node);
			const ok = await queueOnlyCurrentNode(node);
			generateButton.innerHTML = ok ? "✅ 执行中" : "❌ 执行失败";
			generateButton.style.background = ok
				? "linear-gradient(135deg, #064e3b, #059669)"
				: "linear-gradient(135deg, #7f1d1d, #dc2626)";
			generateButton.style.borderColor = ok ? "#10b981" : "#ef4444";
		} catch (error) {
			console.error("[GJJ_StoryboardGridGenerator] execute failed:", error);
			generateButton.innerHTML = "❌ 错误";
			generateButton.style.background = "linear-gradient(135deg, #7f1d1d, #dc2626)";
			generateButton.style.borderColor = "#ef4444";
		} finally {
			setTimeout(() => {
				generateButton.innerHTML = originalText;
				generateButton.disabled = false;
				generateButton.style.opacity = "1";
				generateButton.style.background = "linear-gradient(135deg, #064e3b, #059669)";
				generateButton.style.borderColor = "#10b981";
			}, 1500);
		}
	}

	function handleSettings(event) {
		protectEvent(event);
		setSettingsOpen(node, !settingsOpen(node));
	}

	setupButtonHover(generateButton, "linear-gradient(135deg, #064e3b, #059669)", "linear-gradient(135deg, #059669, #10b981)");
	setupButtonHover(settingsButton, "linear-gradient(135deg, #1f2933, #374151)", "linear-gradient(135deg, #374151, #4b5563)");
	setupButtonEvents(generateButton, handleGenerate);
	setupButtonEvents(settingsButton, handleSettings);
	updateSettingsButtonState(node);

	container.appendChild(generateButton);
	container.appendChild(templateButton);
	container.appendChild(settingsButton);
	return container;
}

function createImagePreview(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
	].join(";");
	const status = document.createElement("div");
	status.textContent = "正向提示词按空行或单独一行 --- 分段；每段生成一张分镜，完成后输出智能宫格图。";
	status.style.cssText = "color:#9fb3b8;font:12px/1.35 sans-serif;white-space:normal;";
	const image = document.createElement("img");
	image.alt = "Storyboard preview";
	image.style.cssText = [
		"display:none",
		"width:100%",
		"max-height:260px",
		"object-fit:contain",
		"background:#0f1418",
		"border:1px solid #33434a",
		"border-radius:8px",
		"box-sizing:border-box",
	].join(";");
	image.addEventListener("load", () => GJJ_Utils.refreshNode?.(node));
	container.append(status, image);
	node.__gjjStoryboardPreviewStatus = status;
	node.__gjjStoryboardPreviewImage = image;
	return container;
}

function previewImageUrl(item) {
	if (!item?.filename) return "";
	const path = `/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "temp")}&subfolder=${encodeURIComponent(item.subfolder || "")}&rand=${Date.now()}`;
	return api?.apiURL ? api.apiURL(path) : path;
}

function updateLivePreview(node, detail) {
	if (!isTarget(node)) return;
	if (!node.__gjjStoryboardPreviewWidget && typeof node.addDOMWidget === "function") {
		node.__gjjStoryboardPreviewWidget = node.addDOMWidget(IMAGE_PREVIEW_NAME, "HTML", createImagePreview(node), { serialize: false });
	}
	const status = node.__gjjStoryboardPreviewStatus;
	const image = node.__gjjStoryboardPreviewImage;
	const index = Number(detail?.index || 0);
	const total = Number(detail?.total || 0);
	if (status) {
		status.textContent = total > 0 ? `已生成 ${index}/${total}` : "已生成预览";
	}
	const url = previewImageUrl(detail?.image);
	if (image && url) {
		image.src = url;
		image.style.display = "block";
	}
	GJJ_Utils.refreshNode?.(node);
}

function resetLivePreview(node) {
	const status = node?.__gjjStoryboardPreviewStatus;
	const image = node?.__gjjStoryboardPreviewImage;
	if (status) {
		status.textContent = "等待生成预览...";
	}
	if (image) {
		image.removeAttribute("src");
		image.style.display = "none";
	}
	GJJ_Utils.refreshNode?.(node);
}

function configureInputs(node) {
	const scene = getInput(node, "scene");
	if (scene) {
		scene.type = "GJJ_BATCH_IMAGE,IMAGE";
		scene.label = "场景";
		scene.localized_name = "场景";
		scene.tooltip = "接收上游素材/背景作为参考图参与生成；不会启用自动局部蒙版。";
	}
	const reference = getInput(node, "reference");
	if (reference) {
		reference.type = "GJJ_BATCH_IMAGE,IMAGE";
		reference.label = "参考图";
		reference.localized_name = "参考图";
		reference.tooltip = "接收上游素材/背景作为参考图参与生成；不会启用自动局部蒙版。";
	}
}

async function applyModelFamilyPreset(node, force = false) {
	const unetWidget = getWidget(node, "unet_name");
	if (!unetWidget || node.__gjjStoryboardApplyingPreset) return;
	const unetName = String(unetWidget.value || "").trim();
	if (!unetName) return;
	node.properties ||= {};
	if (!force && node.properties.__gjjStoryboardLastPresetUnet === unetName && hasConfiguredLoraData(node)) return;
	node.__gjjStoryboardApplyingPreset = true;
	try {
		const presets = await getModelFamilyPresets();
		const preset = matchModelFamilyPreset(unetName, presets);
		node.properties.__gjjStoryboardLastPresetUnet = unetName;
		if (!preset) {
			setPresetLoraData(node, null);
			return;
		}
		const updates = {
			clip_name1: (preset.clipNames || [])[0] || "",
			vae_name: preset.vaeName || "",
			steps: Number.isFinite(preset.steps) ? Number(preset.steps) : undefined,
			cfg: Number.isFinite(preset.cfg) ? Number(preset.cfg) : undefined,
			sampler_name: preset.sampler || "",
			scheduler: preset.scheduler || "",
			denoise: Number.isFinite(preset.denoise) ? Number(preset.denoise) : undefined,
			width: Number.isFinite(preset.width) ? Number(preset.width) : undefined,
			height: Number.isFinite(preset.height) ? Number(preset.height) : undefined,
		};
		for (const [name, value] of Object.entries(updates)) {
			if (value === undefined || value === null || value === "") continue;
			if (getInput(node, name)?.link != null) continue;
			setWidgetValue(getWidget(node, name), value);
		}
		setPresetLoraData(node, preset);
		GJJ_Utils.refreshNode?.(node);
	} finally {
		node.__gjjStoryboardApplyingPreset = false;
	}
}

function hookUnetWidget(node) {
	const widget = getWidget(node, "unet_name");
	if (!widget || widget.__gjjStoryboardPresetHooked) return;
	widget.__gjjStoryboardPresetHooked = true;
	const original = widget.callback;
	widget.callback = function (value, ...args) {
		const result = original?.apply(this, [value, ...args]);
		setTimeout(() => applyModelFamilyPreset(node, true), 0);
		return result;
	};
}

function saveParamValues(node) {
	const values = {};
	for (const name of PANEL_SYNC_WIDGETS) {
		const widget = getWidget(node, name);
		if (widget) values[name] = widget.value;
	}
	values[SEED_CONTROL_KEY] = seedControlMode(node);
	const loraData = getWidget(node, "lora_data");
	if (loraData) values.lora_data = loraData.value;
	node.properties ||= {};
	node.properties[PARAM_VALUES_PROPERTY] = values;
	return values;
}

function restoreParamValues(node, values) {
	if (!values || typeof values !== "object") return;
	for (const name of PANEL_SYNC_WIDGETS) {
		if (!Object.prototype.hasOwnProperty.call(values, name)) continue;
		setWidgetValue(getWidget(node, name), values[name]);
	}
	if (Object.prototype.hasOwnProperty.call(values, "lora_data")) {
		setWidgetValue(getWidget(node, "lora_data"), values.lora_data);
	}
	if (Object.prototype.hasOwnProperty.call(values, SEED_CONTROL_KEY)) {
		const widget = findSeedControlWidget(node);
		const mode = textValue(values[SEED_CONTROL_KEY]);
		if (widget && isSeedControlValue(mode)) setWidgetValue(widget, mode);
	}
}

function patchNode(node) {
	if (!isTarget(node)) return;
	configureInputs(node);
	hookUnetWidget(node);
	syncSeedControlWidget(node);
	if (!node.__gjjStoryboardExecuteWidget && typeof node.addDOMWidget === "function") {
		node.__gjjStoryboardExecuteWidget = node.addDOMWidget(EXECUTE_BUTTON_NAME, "HTML", createButtons(node), { serialize: false });
	}
	if (!node.__gjjStoryboardPreviewWidget && typeof node.addDOMWidget === "function") {
		node.__gjjStoryboardPreviewWidget = node.addDOMWidget(IMAGE_PREVIEW_NAME, "HTML", createImagePreview(node), { serialize: false });
	}
	applySettingsVisibility(node);
	updateTemplateSourcePanel(node, TEMPLATE_SOURCE_FIELDS);
	void applyModelFamilyPreset(node, false);
	if (node.__gjjStoryboardPatched) return;
	node.__gjjStoryboardPatched = true;

	const originalOnSerialize = node.onSerialize;
	node.onSerialize = function (serializedNode, ...args) {
		const result = originalOnSerialize?.apply(this, [serializedNode, ...args]);
		serializedNode.properties ||= {};
		serializedNode.properties[PARAM_VALUES_PROPERTY] = saveParamValues(this);
		return result;
	};

	const originalOnConfigure = node.onConfigure;
	node.onConfigure = function (serializedNode, ...args) {
		const values = serializedNode?.properties?.[PARAM_VALUES_PROPERTY];
		const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
		setTimeout(() => {
			restoreParamValues(this, values);
			patchNode(this);
		}, 0);
		return result;
	};
}

api.addEventListener("gjj_storyboard_grid_preview", (event) => {
	const detail = event?.detail || {};
	const nodeId = String(detail.node || "");
	for (const node of app.graph?._nodes || []) {
		if (isTarget(node) && String(node.id) === nodeId) {
			updateLivePreview(node, detail);
		}
	}
});

app.registerExtension({
	name: "GJJ.StoryboardGridGenerator",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name) || nodeType.prototype.__gjjStoryboardPrototypePatched) return;
		nodeType.prototype.__gjjStoryboardPrototypePatched = true;
		nodeData.output_preview = false;
		if (Array.isArray(nodeData.outputs)) {
			for (const output of nodeData.outputs) output.preview = false;
		}

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			setTimeout(() => patchNode(this), 0);
			return result;
		};
	},
	async nodeCreated(node) {
		patchNode(node);
	},
	setup() {
		installStoryboardSeedPromptPatch();
		for (const node of app.graph?._nodes || []) {
			patchNode(node);
		}
	},
});
