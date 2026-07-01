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
const SELECTED_CELL_PROPERTY = "gjj_storyboard_selected_cell_v1";
const SELECTED_CELLS_PROPERTY = "gjj_storyboard_selected_cells_v1";
const SINGLE_CELL_INDEX_INPUT = "single_cell_index";
const SINGLE_CELL_TOTAL_INPUT = "single_cell_total";
const SELECTED_CELL_INDICES_INPUT = "selected_cell_indices";
const FULL_PROMPT_INPUT = "storyboard_full_prompt";
const FORCE_GENERATE_INPUT = "force_generate_all";
const SEED_CONTROL_KEY = "__seed_control_after_generate";
const SEED_CONTROL_VALUES = new Set(["fixed", "increment", "decrement", "randomize"]);
const JS_SAFE_MAX_SEED_VALUE = Number.MAX_SAFE_INTEGER;
const ALWAYS_VISIBLE_WIDGETS = new Set(["prompt"]);
const ALWAYS_HIDDEN_WIDGETS = new Set(["lora_data", SINGLE_CELL_INDEX_INPUT, SINGLE_CELL_TOTAL_INPUT, SELECTED_CELL_INDICES_INPUT, FULL_PROMPT_INPUT, FORCE_GENERATE_INPUT]);
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
const PREVIEW_REFRESH_WIDGETS = new Set(["width", "height", "layout_mode", "gap", "size_alignment"]);
const TEMPLATE_SOURCE_FIELDS = [
	{ name: "prompt", widget: "prompt", label: "提示词", type: "STRING", aliases: ["prompt", "positive", "正向", "提示词"] },
	{ name: "width", widget: "width", label: "宽度", type: "INT", aliases: ["width", "宽", "宽度"] },
	{ name: "height", widget: "height", label: "高度", type: "INT", aliases: ["height", "高", "高度"] },
];
const DEFAULT_LORA_ROW = { enabled: true, name: "", strength: 1.0 };
const QWEN_NEXT_SCENE_LORA = "next-scene_lora-v2-3000.safetensors";

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

function parsePromptParts(text) {
	const raw = String(text || "").trim();
	if (!raw) return [];
	const sceneLines = [];
	let current = [];
	let matched = false;
	const sceneRe = /^\s*(?:scene|shot|镜头|分镜)\s*(?:[#:：\-]?\s*[\d一二三四五六七八九十]+)?(?:\s*[:：]\s*|\s+)(?:(.*?)\s*(?:[:：]{1,2}|::)\s*)?(.+?)\s*$/i;
	for (const sourceLine of raw.split(/\r?\n/)) {
		const line = sourceLine.trim();
		if (!line) continue;
		const match = line.match(sceneRe);
		if (match) {
			matched = true;
			if (current.length) sceneLines.push(current.join("\n").trim());
			const label = String(match[1] || "").trim().replace(/^[\s\-—:：]+|[\s\-—:：]+$/g, "");
			const body = String(match[2] || "").trim();
			current = [label ? `${label}，${body}` : body];
		} else if (matched && current.length) {
			current.push(line);
		}
	}
	if (current.length) sceneLines.push(current.join("\n").trim());
	if (matched && sceneLines.length) return sceneLines;
	return raw.split(/(?:^\s*---+\s*$)|(?:\n\s*\n+)/m).map((item) => item.trim()).filter(Boolean);
}

function serializePromptParts(parts) {
	return (parts || []).map((item) => String(item || "").trim()).filter(Boolean).join("\n\n---\n\n");
}

function selectedCellIndex(node) {
	const value = Number(node?.properties?.[SELECTED_CELL_PROPERTY] || 1);
	return Math.max(0, Math.min(255, Math.round(value || 1) - 1));
}

function selectedCellIndices(node) {
	const count = Math.max(1, parsePromptParts(getWidget(node, "prompt")?.value || "").length);
	const raw = Array.isArray(node?.properties?.[SELECTED_CELLS_PROPERTY]) ? node.properties[SELECTED_CELLS_PROPERTY] : [];
	const values = raw
		.map((value) => Math.round(Number(value) || 0) - 1)
		.filter((value) => value >= 0 && value < count);
	const unique = [...new Set(values)].sort((left, right) => left - right);
	if (unique.length) return unique;
	return [Math.max(0, Math.min(count - 1, selectedCellIndex(node)))];
}

function setSelectedCellIndex(node, index) {
	node.properties ||= {};
	const count = Math.max(1, parsePromptParts(getWidget(node, "prompt")?.value || "").length);
	const value = Math.max(1, Math.min(count, Math.round(Number(index) || 0) + 1));
	node.properties[SELECTED_CELL_PROPERTY] = value;
	node.properties[SELECTED_CELLS_PROPERTY] = [value];
	node.__gjjStoryboardSelectionAnchor = value - 1;
	drawPromptGridPreview(node);
	GJJ_Utils.refreshNode?.(node);
}

function setSelectedCellIndices(node, indices, primaryIndex = null) {
	node.properties ||= {};
	const count = Math.max(1, parsePromptParts(getWidget(node, "prompt")?.value || "").length);
	const normalized = [...new Set((indices || [])
		.map((value) => Math.round(Number(value) || 0))
		.filter((value) => value >= 0 && value < count))]
		.sort((left, right) => left - right);
	const safe = normalized.length ? normalized : [Math.max(0, Math.min(count - 1, selectedCellIndex(node)))];
	const primary = primaryIndex === null ? safe[safe.length - 1] : Math.max(0, Math.min(count - 1, Math.round(Number(primaryIndex) || 0)));
	node.properties[SELECTED_CELL_PROPERTY] = primary + 1;
	node.properties[SELECTED_CELLS_PROPERTY] = safe.map((value) => value + 1);
	node.__gjjStoryboardSelectionAnchor = primary;
	drawPromptGridPreview(node);
	GJJ_Utils.refreshNode?.(node);
}

function updateCellSelectionFromEvent(node, index, event) {
	const count = Math.max(1, parsePromptParts(getWidget(node, "prompt")?.value || "").length);
	const safeIndex = Math.max(0, Math.min(count - 1, Math.round(Number(index) || 0)));
	if (event?.shiftKey) {
		const anchor = Number.isInteger(node.__gjjStoryboardSelectionAnchor) ? node.__gjjStoryboardSelectionAnchor : selectedCellIndex(node);
		const start = Math.min(anchor, safeIndex);
		const end = Math.max(anchor, safeIndex);
		const range = [];
		for (let value = start; value <= end; value += 1) range.push(value);
		setSelectedCellIndices(node, range, safeIndex);
		return;
	}
	if (event?.ctrlKey || event?.metaKey) {
		const current = new Set(selectedCellIndices(node));
		if (current.has(safeIndex) && current.size > 1) current.delete(safeIndex);
		else current.add(safeIndex);
		setSelectedCellIndices(node, [...current], safeIndex);
		return;
	}
	setSelectedCellIndex(node, safeIndex);
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
	return "fixed";
}

function applySeedControlBeforeQueue(node) {
	const seedWidget = getWidget(node, "seed");
	if (!seedWidget) return null;
	const now = Date.now();
	if (node.__gjjStoryboardSeedPreparedAt && now - node.__gjjStoryboardSeedPreparedAt < 500) {
		if (Number.isInteger(node.__gjjStoryboardPreparedSeed)) return node.__gjjStoryboardPreparedSeed;
		return intValue(seedWidget.value, 0, 0, JS_SAFE_MAX_SEED_VALUE);
	}
	if (node.__gjjStoryboardRandomSeedOnce) {
		const nextSeed = randomSeedValue();
		setWidgetValue(seedWidget, nextSeed);
		node.__gjjStoryboardSeedPreparedAt = now;
		node.__gjjStoryboardPreparedSeed = nextSeed;
		saveParamValues(node);
		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		node.graph?.change?.();
		return nextSeed;
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
		node.__gjjStoryboardPreparedSeed = currentSeed;
		return currentSeed;
	}
	setWidgetValue(seedWidget, nextSeed);
	node.__gjjStoryboardSeedPreparedAt = now;
	node.__gjjStoryboardPreparedSeed = nextSeed;
	saveParamValues(node);
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	node.graph?.change?.();
	return nextSeed;
}

function prepareRandomSeedForGenerate(node) {
	node.__gjjStoryboardRandomSeedOnce = true;
	delete node.__gjjStoryboardPreparedSeed;
	delete node.__gjjStoryboardSeedPreparedAt;
	return applySeedControlBeforeQueue(node);
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
		const singleIndices = Array.isArray(node.__gjjStoryboardSingleCellIndices)
			? node.__gjjStoryboardSingleCellIndices
			: (Number.isInteger(node.__gjjStoryboardSingleCellIndex) ? [node.__gjjStoryboardSingleCellIndex] : []);
		const fullPrompt = getWidget(node, "prompt")?.value || "";
		const parts = singleIndices.length ? parsePromptParts(fullPrompt) : [];
		const clampedIndices = parts.length
			? [...new Set(singleIndices.map((value) => Math.max(0, Math.min(value, parts.length - 1))))].sort((left, right) => left - right)
			: [];
		const applyInputs = (inputs) => {
			inputs.seed = seed;
			inputs[SINGLE_CELL_INDEX_INPUT] = clampedIndices.length ? clampedIndices[0] + 1 : 0;
			inputs[SINGLE_CELL_TOTAL_INPUT] = clampedIndices.length ? parts.length : 0;
			inputs[SELECTED_CELL_INDICES_INPUT] = clampedIndices.length ? JSON.stringify(clampedIndices.map((value) => value + 1)) : "[]";
			inputs[FULL_PROMPT_INPUT] = clampedIndices.length ? fullPrompt : "";
			inputs[FORCE_GENERATE_INPUT] = node.__gjjStoryboardForceGenerateAll ? "true" : "false";
			if (clampedIndices.length) {
				inputs.prompt = serializePromptParts(clampedIndices.map((value) => parts[value]).filter(Boolean));
			}
		};
		entry.inputs = entry.inputs || {};
		applyInputs(entry.inputs);
		if (promptData?.prompt && promptData.prompt !== promptData.output && promptData.prompt[key]) {
			promptData.prompt[key].inputs = promptData.prompt[key].inputs || {};
			applyInputs(promptData.prompt[key].inputs);
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

function normalizedModelText(value) {
	return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isQwenImageEdit(unetName, preset) {
	const text = normalizedModelText(`${unetName || ""} ${preset?.id || ""} ${(preset?.keywords || []).join(" ")}`);
	return text.includes("qwen") && text.includes("image") && text.includes("edit");
}

function appendLoraRow(rows, name, strength = 1.0) {
	const target = String(name || "").trim();
	if (!target) return;
	const targetBase = target.replace(/\\/g, "/").toLowerCase().split("/").pop();
	const existing = rows.find((row) => {
		const current = String(row?.name || "").replace(/\\/g, "/").toLowerCase();
		return current === target.toLowerCase() || current.split("/").pop() === targetBase;
	});
	if (existing) {
		existing.enabled = true;
		if (!Number(existing.strength)) existing.strength = strength;
		return;
	}
	rows.push({ enabled: true, name: target, strength });
}

function presetLoraRows(preset, unetName = "") {
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
	if (isQwenImageEdit(unetName, preset)) appendLoraRow(rows, QWEN_NEXT_SCENE_LORA, 1.0);
	if (rows.length) rows.push({ ...DEFAULT_LORA_ROW });
	return rows;
}

function setPresetLoraData(node, preset, unetName = "") {
	const widget = getWidget(node, "lora_data");
	if (!widget) return;
	const rows = presetLoraRows(preset, unetName);
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
		"flex-wrap:wrap",
		"align-items:center",
		"align-content:flex-start",
		"gap:3px",
		"width:100%",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	const sharedButtonStyle = [
		"height:26px",
		"padding:0 7px",
		"border-radius:5px",
		"color:#e5edf2",
		"font-size:11px",
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
		"gap:3px",
		"white-space:nowrap",
		"min-width:0",
	];

	const generateButton = document.createElement("button");
	generateButton.type = "button";
	generateButton.innerHTML = "✨ 全部";
	generateButton.title = "只执行当前分镜宫格节点。";
	generateButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #10b981",
		"background:linear-gradient(135deg, #064e3b, #059669)",
		"color:#a7f3d0",
		"flex:0 0 auto",
	].join(";");

	const singleButton = document.createElement("button");
	singleButton.type = "button";
	singleButton.textContent = "🎯 单格";
	singleButton.title = "只生成当前选中的一个宫格。";
	singleButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #38bdf8",
		"background:linear-gradient(135deg, #0c4a6e, #0284c7)",
		"color:#e0f2fe",
		"flex:0 0 auto",
	].join(";");

	const diceButton = document.createElement("button");
	diceButton.type = "button";
	diceButton.textContent = "🎲";
	diceButton.title = "一次性随机种子：默认固定，点亮后下一次生成临时使用随机 seed。";
	diceButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #64748b",
		"background:linear-gradient(135deg, #26313a, #334155)",
		"color:#e5edf2",
		"flex:0 0 28px",
		"padding:0",
	].join(";");
	node.__gjjStoryboardDiceButton = diceButton;

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
		"flex:0 0 auto",
	].join(";");
	node.__gjjStoryboardSettingsButton = settingsButton;

	function protectEvent(event) {
		event.preventDefault();
		event.stopPropagation();
	}

	function setupButtonHover(button, defaultBg, hoverBg) {
		button.addEventListener("mouseenter", () => {
			if (button === diceButton && node.__gjjStoryboardRandomSeedOnce) return;
			if (button === settingsButton && settingsOpen(node)) return;
			button.style.background = hoverBg;
			button.style.transform = "translateY(-1px)";
		});
		button.addEventListener("mouseleave", () => {
			if (button === diceButton && node.__gjjStoryboardRandomSeedOnce) {
				button.style.transform = "translateY(0)";
				updateDiceButtonState();
				return;
			}
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
		node.__gjjStoryboardForceGenerateAll = true;
		try {
			prepareRandomSeedForGenerate(node);
			updateDiceButtonState();
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
				delete node.__gjjStoryboardForceGenerateAll;
				clearOneShotSeed();
				generateButton.innerHTML = originalText;
				generateButton.disabled = false;
				generateButton.style.opacity = "1";
				generateButton.style.background = "linear-gradient(135deg, #064e3b, #059669)";
				generateButton.style.borderColor = "#10b981";
			}, 1500);
		}
	}

	function updateDiceButtonState() {
		const active = Boolean(node.__gjjStoryboardRandomSeedOnce);
		diceButton.style.background = active ? "linear-gradient(135deg, #854d0e, #ca8a04)" : "linear-gradient(135deg, #26313a, #334155)";
		diceButton.style.borderColor = active ? "#facc15" : "#64748b";
		diceButton.style.color = active ? "#fff7cc" : "#e5edf2";
		diceButton.title = active ? "下一次生成会临时使用随机 seed；生成后自动恢复固定。" : "一次性随机种子：默认固定，点亮后下一次生成临时使用随机 seed。";
	}

	function clearOneShotSeed() {
		delete node.__gjjStoryboardRandomSeedOnce;
		delete node.__gjjStoryboardPreparedSeed;
		delete node.__gjjStoryboardSeedPreparedAt;
		updateDiceButtonState();
	}

	async function handleSingleGenerate(event) {
		protectEvent(event);
		const selectedIndices = selectedCellIndices(node);
		resetLivePreview(node, { onlyIndices: selectedIndices });
		const originalText = singleButton.textContent;
		singleButton.textContent = selectedIndices.length > 1 ? "⏳ 多格" : "⏳ 单格";
		singleButton.disabled = true;
		singleButton.style.opacity = "0.7";
		node.__gjjStoryboardSingleCellIndex = selectedIndices[0];
		node.__gjjStoryboardSingleCellIndices = selectedIndices;
		try {
			prepareRandomSeedForGenerate(node);
			updateDiceButtonState();
			const ok = await queueOnlyCurrentNode(node);
			singleButton.textContent = ok ? (selectedIndices.length > 1 ? "✅ 多格" : "✅ 单格") : "❌ 单格";
		} catch (error) {
			console.error("[GJJ_StoryboardGridGenerator] single cell execute failed:", error);
			singleButton.textContent = "❌ 单格";
		} finally {
			setTimeout(() => {
				delete node.__gjjStoryboardSingleCellIndex;
				delete node.__gjjStoryboardSingleCellIndices;
				clearOneShotSeed();
				singleButton.textContent = originalText;
				singleButton.disabled = false;
				singleButton.style.opacity = "1";
			}, 1200);
		}
	}

	function handleSettings(event) {
		protectEvent(event);
		setSettingsOpen(node, !settingsOpen(node));
	}

	function handleDice(event) {
		protectEvent(event);
		node.__gjjStoryboardRandomSeedOnce = !node.__gjjStoryboardRandomSeedOnce;
		delete node.__gjjStoryboardPreparedSeed;
		delete node.__gjjStoryboardSeedPreparedAt;
		updateDiceButtonState();
	}

	setupButtonHover(generateButton, "linear-gradient(135deg, #064e3b, #059669)", "linear-gradient(135deg, #059669, #10b981)");
	setupButtonHover(singleButton, "linear-gradient(135deg, #0c4a6e, #0284c7)", "linear-gradient(135deg, #0284c7, #38bdf8)");
	setupButtonHover(diceButton, "linear-gradient(135deg, #26313a, #334155)", "linear-gradient(135deg, #475569, #64748b)");
	setupButtonHover(settingsButton, "linear-gradient(135deg, #1f2933, #374151)", "linear-gradient(135deg, #374151, #4b5563)");
	setupButtonEvents(generateButton, handleGenerate);
	setupButtonEvents(singleButton, handleSingleGenerate);
	setupButtonEvents(diceButton, handleDice);
	setupButtonEvents(settingsButton, handleSettings);
	updateSettingsButtonState(node);
	updateDiceButtonState();

	container.appendChild(generateButton);
	container.appendChild(singleButton);
	container.appendChild(diceButton);
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
	status.textContent = "正向提示词按空行、单独一行 --- 或 Scene：镜头 :: 描述 分段；每段生成一张分镜，完成后输出智能宫格图。";
	status.style.cssText = "color:#9fb3b8;font:12px/1.35 sans-serif;white-space:normal;";
	const canvas = document.createElement("canvas");
	canvas.tabIndex = 0;
	canvas.style.cssText = [
		"display:block",
		"width:100%",
		"height:auto",
		"min-height:150px",
		"background:#05080a",
		"border:1px solid #33434a",
		"border-radius:8px",
		"box-sizing:border-box",
		"cursor:pointer",
	].join(";");
	canvas.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const hit = storyboardCellHit(node, event);
		if (hit >= 0) updateCellSelectionFromEvent(node, hit, event);
	});
	canvas.addEventListener("dblclick", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const hit = storyboardCellHit(node, event);
		if (hit < 0) return;
		setSelectedCellIndex(node, hit);
		editStoryboardCellPrompt(node, hit);
	});
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
	container.append(status, canvas, image);
	node.__gjjStoryboardPreviewStatus = status;
	node.__gjjStoryboardGridCanvas = canvas;
	node.__gjjStoryboardPreviewImage = image;
	setTimeout(() => drawPromptGridPreview(node), 0);
	return container;
}

function storyboardGridGeometry(count, width, height) {
	count = Math.max(1, Number(count) || 1);
	const layouts = {
		1: [1, 1],
		2: [2, 1],
		3: [3, 1],
		4: [2, 2],
		5: [3, 2],
		6: [3, 2],
		7: [4, 2],
		8: [4, 2],
		9: [3, 3],
		10: [5, 2],
		11: [4, 3],
		12: [4, 3],
	};
	let [cols, rows] = layouts[count] || [Math.ceil(Math.sqrt(count)), Math.ceil(count / Math.ceil(Math.sqrt(count)))];
	const cellW = Math.floor(width / cols);
	const cellH = Math.floor(height / rows);
	const rects = [];
	for (let index = 0; index < count; index += 1) {
		const col = index % cols;
		const row = Math.floor(index / cols);
		rects.push({ left: col * cellW, top: row * cellH, right: col * cellW + cellW, bottom: row * cellH + cellH, index });
	}
	return { cols, rows, rects };
}

function wrapCanvasText(ctx, text, maxWidth, maxLines) {
	const lines = [];
	let current = "";
	for (const char of String(text || "")) {
		const next = current + char;
		if (current && ctx.measureText(next).width > maxWidth) {
			lines.push(current);
			current = char;
			if (lines.length >= maxLines) break;
		} else {
			current = next;
		}
	}
	if (current && lines.length < maxLines) lines.push(current);
	if (lines.length === maxLines) lines[lines.length - 1] = `${lines[lines.length - 1].replace(/\s+$/g, "")}...`;
	return lines;
}

function drawImageCover(ctx, image, left, top, width, height, bleedScale = 1) {
	const sourceW = Math.max(1, image.naturalWidth || image.width || 1);
	const sourceH = Math.max(1, image.naturalHeight || image.height || 1);
	const scale = Math.max(width / sourceW, height / sourceH) * Math.max(1, Number(bleedScale) || 1);
	const drawW = sourceW * scale;
	const drawH = sourceH * scale;
	const drawX = left + (width - drawW) / 2;
	const drawY = top + (height - drawH) / 2;
	ctx.save();
	ctx.beginPath();
	ctx.rect(left, top, width, height);
	ctx.clip();
	ctx.drawImage(image, drawX, drawY, drawW, drawH);
	ctx.restore();
}

function drawPromptGridPreview(node) {
	const canvas = node?.__gjjStoryboardGridCanvas;
	if (!canvas) return;
	const parts = parsePromptParts(getWidget(node, "prompt")?.value || "");
	const count = Math.max(1, parts.length);
	const outputW = Math.max(320, Number(node.size?.[0] || 520) - 24);
	const targetW = Math.max(64, Number(getWidget(node, "width")?.value || 1024) || 1024);
	const targetH = Math.max(64, Number(getWidget(node, "height")?.value || 1024) || 1024);
	const gap = Math.max(0, Number(getWidget(node, "gap")?.value || 8) || 0);
	const layoutProbe = storyboardGridGeometry(count, 1000, 1000);
	const finalAspect = Math.max(
		0.15,
		((targetW * layoutProbe.cols) + gap * (layoutProbe.cols + 1)) / Math.max(1, (targetH * layoutProbe.rows) + gap * (layoutProbe.rows + 1)),
	);
	const outputH = Math.max(150, Math.round(outputW / finalAspect));
	if (canvas.width !== outputW || canvas.height !== outputH) {
		canvas.width = outputW;
		canvas.height = outputH;
	}
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#05080a";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	const { rects } = storyboardGridGeometry(count, canvas.width, canvas.height);
	node.__gjjStoryboardGridRects = rects;
	const selected = selectedCellIndex(node);
	const selectedSet = new Set(selectedCellIndices(node));
	for (const rect of rects) {
		const width = rect.right - rect.left;
		const height = rect.bottom - rect.top;
		const isSelected = selectedSet.has(rect.index);
		ctx.fillStyle = "#e8efec";
		ctx.fillRect(rect.left + 2, rect.top + 2, Math.max(1, width - 4), Math.max(1, height - 4));
		ctx.strokeStyle = isSelected ? "#38bdf8" : "#000000";
		ctx.lineWidth = isSelected ? 3 : 2;
		ctx.strokeRect(rect.left + 1, rect.top + 1, Math.max(1, width - 2), Math.max(1, height - 2));
		const text = parts[rect.index] || `宫格 ${rect.index + 1}`;
		ctx.fillStyle = "#102027";
		ctx.font = "700 12px sans-serif";
		const pad = Math.max(7, Math.min(12, Math.floor(Math.min(width, height) / 14)));
		ctx.fillText(`宫格 ${rect.index + 1}`, rect.left + pad, rect.top + pad + 12);
		ctx.fillStyle = "#40515a";
		ctx.font = "11px sans-serif";
		const lines = wrapCanvasText(ctx, text, Math.max(30, width - pad * 2), Math.max(2, Math.floor((height - pad * 2 - 22) / 14)));
		for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
			ctx.fillText(lines[lineIndex], rect.left + pad, rect.top + pad + 30 + lineIndex * 14);
		}
	}
	const previewUrls = node.__gjjStoryboardCellPreviewUrls || [];
	for (const rect of rects) {
		const url = previewUrls[rect.index];
		if (!url) continue;
		const cached = node.__gjjStoryboardCellPreviewImages?.[rect.index];
		if (cached?.complete && cached.naturalWidth > 0) {
			drawImageCover(ctx, cached, rect.left + 2, rect.top + 2, Math.max(1, rect.right - rect.left - 4), Math.max(1, rect.bottom - rect.top - 4), 1.05);
		}
	}
	for (const rect of rects) {
		const isSelected = selectedSet.has(rect.index);
		ctx.strokeStyle = isSelected ? "#38bdf8" : "#000000";
		ctx.lineWidth = isSelected ? 3 : 2;
		ctx.strokeRect(rect.left + 1, rect.top + 1, Math.max(1, rect.right - rect.left - 2), Math.max(1, rect.bottom - rect.top - 2));
		if (isSelected && rect.index !== selected) {
			ctx.fillStyle = "rgba(56,189,248,.9)";
			ctx.beginPath();
			ctx.arc(rect.right - 14, rect.top + 14, 7, 0, Math.PI * 2);
			ctx.fill();
		}
	}
	const status = node.__gjjStoryboardPreviewStatus;
	if (status) {
		const selectedText = selectedSet.size > 1
			? [...selectedSet].map((value) => value + 1).join("、")
			: `${selected + 1}`;
		status.textContent = `预览 ${count} 个等宽等高宫格 · Ctrl/Shift 多选 · 当前 ${selectedText}`;
	}
	GJJ_Utils.refreshNode?.(node);
}

function storyboardCellHit(node, event) {
	const canvas = node?.__gjjStoryboardGridCanvas;
	const rect = canvas?.getBoundingClientRect?.();
	if (!canvas || !rect) return -1;
	const x = (event.clientX - rect.left) * (canvas.width / Math.max(1, rect.width));
	const y = (event.clientY - rect.top) * (canvas.height / Math.max(1, rect.height));
	const hit = (node.__gjjStoryboardGridRects || []).find((item) => x >= item.left && x <= item.right && y >= item.top && y <= item.bottom);
	return hit ? hit.index : -1;
}

function editStoryboardCellPrompt(node, index) {
	const parts = parsePromptParts(getWidget(node, "prompt")?.value || "");
	while (parts.length <= index) parts.push("");
	const overlay = document.createElement("div");
	overlay.style.cssText = "position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.38);";
	const box = document.createElement("div");
	box.style.cssText = "width:min(560px,calc(100vw - 32px));background:#0c1215;border:1px solid #34444b;border-radius:8px;padding:10px;box-shadow:0 18px 48px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:8px;";
	const title = document.createElement("div");
	title.textContent = `宫格 ${index + 1} 提示词`;
	title.style.cssText = "color:#e8f1ed;font:700 13px sans-serif;";
	const area = document.createElement("textarea");
	area.value = parts[index] || "";
	area.style.cssText = "min-height:150px;resize:vertical;background:#111a1f;color:#e8f1ed;border:1px solid #34444b;border-radius:6px;padding:8px;font:13px/1.35 sans-serif;outline:none;";
	const actions = document.createElement("div");
	actions.style.cssText = "display:flex;justify-content:flex-end;gap:6px;";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.textContent = "取消";
	const save = document.createElement("button");
	save.type = "button";
	save.textContent = "保存";
	for (const btn of [cancel, save]) {
		btn.style.cssText = "height:28px;border:1px solid #38464d;border-radius:6px;background:#121a1f;color:#eef7f2;padding:0 12px;cursor:pointer;";
	}
	cancel.onclick = () => overlay.remove();
	save.onclick = () => {
		parts[index] = area.value.trim();
		setWidgetValue(getWidget(node, "prompt"), serializePromptParts(parts));
		saveParamValues(node);
		drawPromptGridPreview(node);
		overlay.remove();
	};
	actions.append(cancel, save);
	box.append(title, area, actions);
	overlay.appendChild(box);
	overlay.addEventListener("pointerdown", (event) => {
		event.stopPropagation();
		if (event.target === overlay) overlay.remove();
	});
	document.body.appendChild(overlay);
	setTimeout(() => area.focus(), 0);
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
	if (url && index > 0) {
		node.__gjjStoryboardCellPreviewUrls ||= [];
		node.__gjjStoryboardCellPreviewImages ||= [];
		node.__gjjStoryboardCellPreviewUrls[index - 1] = url;
		const cellImage = new Image();
		cellImage.onload = () => drawPromptGridPreview(node);
		cellImage.src = url;
		node.__gjjStoryboardCellPreviewImages[index - 1] = cellImage;
	}
	if (image && url) {
		image.src = url;
		image.style.display = "block";
	}
	drawPromptGridPreview(node);
	GJJ_Utils.refreshNode?.(node);
}

function resetLivePreview(node, options = {}) {
	const status = node?.__gjjStoryboardPreviewStatus;
	const image = node?.__gjjStoryboardPreviewImage;
	if (status) {
		status.textContent = "等待生成预览...";
	}
	if (image) {
		image.removeAttribute("src");
		image.style.display = "none";
	}
	const onlyIndices = Array.isArray(options.onlyIndices)
		? options.onlyIndices
		: (Number.isInteger(options.onlyIndex) ? [options.onlyIndex] : []);
	if (onlyIndices.length) {
		node.__gjjStoryboardCellPreviewUrls ||= [];
		node.__gjjStoryboardCellPreviewImages ||= [];
		for (const index of onlyIndices) {
			node.__gjjStoryboardCellPreviewUrls[index] = "";
			node.__gjjStoryboardCellPreviewImages[index] = null;
		}
	} else {
		node.__gjjStoryboardCellPreviewUrls = [];
		node.__gjjStoryboardCellPreviewImages = [];
	}
	drawPromptGridPreview(node);
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
			setPresetLoraData(node, null, unetName);
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
		};
		for (const [name, value] of Object.entries(updates)) {
			if (value === undefined || value === null || value === "") continue;
			if (getInput(node, name)?.link != null) continue;
			setWidgetValue(getWidget(node, name), value);
		}
		setPresetLoraData(node, preset, unetName);
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

function hookPromptWidget(node) {
	const widget = getWidget(node, "prompt");
	if (!widget || widget.__gjjStoryboardPromptGridHooked) return;
	widget.__gjjStoryboardPromptGridHooked = true;
	const original = widget.callback;
	widget.callback = function (value, ...args) {
		const result = original?.apply(this, [value, ...args]);
		setTimeout(() => drawPromptGridPreview(node), 0);
		return result;
	};
}

function hookPreviewRefreshWidgets(node) {
	for (const name of PREVIEW_REFRESH_WIDGETS) {
		const widget = getWidget(node, name);
		if (!widget || widget.__gjjStoryboardPreviewRefreshHooked) continue;
		widget.__gjjStoryboardPreviewRefreshHooked = true;
		const original = widget.callback;
		widget.callback = function (value, ...args) {
			const result = original?.apply(this, [value, ...args]);
			saveParamValues(node);
			setTimeout(() => drawPromptGridPreview(node), 0);
			return result;
		};
	}
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
	hookPromptWidget(node);
	hookPreviewRefreshWidgets(node);
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
