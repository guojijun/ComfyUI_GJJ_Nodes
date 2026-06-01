import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { requestPromptTranslation } from "./gjj_common_prompt_translation.js";

const NODE_TYPE = "GJJ_TextEncodeQwenImageEditPlus";
const NODE_DISPLAY_NAME = "GJJ · 🖼️ Qwen图像编辑编码面板";
const TRANSLATED_EVENT = "gjj_qwen_image_edit_prompt_translated";

const FIELD = {
	positive: "positive_prompt",
	negative: "negative_prompt",
	zero: "zero_conditioning",
	scale: "apply_kontext_scale",
	methodEnabled: "apply_reference_latents_method",
	device: "translation_device",
	unload: "translation_unload_after_use",
	translate: "translation_enabled",
	method: "reference_latents_method",
};
const ALL_FIELDS = Object.values(FIELD);
const POSITIVE_PROMPT_INPUT = "positive_prompt_input";
const VAE_INPUT = "vae";
const IMAGE_PREFIX = "image_";
const DOM_WIDGET = "gjj_qwen_image_edit_plus_panel";
const SAVED_VALUES_PROPERTY = "gjj_qwen_image_edit_plus_values";
const MIN_IMAGE_INPUTS = 1;
const DEFAULT_WIDTH = 260;
const MIN_HEIGHT = 120;
const PANEL_MIN_HEIGHT = 96;
const PANEL_GAP = 7;
const NODE_BOTTOM_PADDING = 10;
const REFERENCE_METHODS = ["offset", "index", "uxo/uno", "index_timestep_zero"];
const BACKING_FIELD_INPUTS = new Set(ALL_FIELDS);

function isTarget(node) {
	return node?.comfyClass === NODE_TYPE || node?.type === NODE_TYPE;
}

function getWidget(node, name) {
	return node.widgets?.find((w) => w?.name === name);
}

function getValue(node, name, fallback = "") {
	const w = getWidget(node, name);
	return w?.value ?? fallback;
}

function setValue(node, name, value) {
	const w = getWidget(node, name);
	if (!w) return;
	w.value = value;
	w.callback?.(value);
	if (w.inputEl && "value" in w.inputEl) w.inputEl.value = value;
	if (w.element && "value" in w.element) w.element.value = value;
	saveValues(node);
}

function toBool(value) {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	const text = String(value ?? "").trim().toLowerCase();
	return ["1", "true", "yes", "on", "开", "开启", "启用"].includes(text);
}

function collectValues(node) {
	const values = {};
	for (const name of ALL_FIELDS) {
		const widget = getWidget(node, name);
		if (widget) values[name] = widget.value;
	}
	return values;
}

function saveValues(node, serializedNode = null) {
	node.properties = node.properties || {};
	const values = collectValues(node);
	node.properties[SAVED_VALUES_PROPERTY] = { ...values };
	for (const [name, value] of Object.entries(values)) {
		node.properties[`gjj_qwen_image_edit_value_${name}`] = value;
	}
	if (serializedNode) {
		serializedNode.properties = serializedNode.properties || {};
		serializedNode.properties[SAVED_VALUES_PROPERTY] = { ...values };
		for (const [name, value] of Object.entries(values)) {
			serializedNode.properties[`gjj_qwen_image_edit_value_${name}`] = value;
		}
		if (Array.isArray(node.widgets)) {
			serializedNode.widgets_values = Array.isArray(serializedNode.widgets_values)
				? serializedNode.widgets_values
				: [];
			for (const name of ALL_FIELDS) {
				const widget = getWidget(node, name);
				const index = node.widgets.indexOf(widget);
				if (widget && index >= 0) serializedNode.widgets_values[index] = widget.value;
			}
		}
	}
	return values;
}

function restoreValues(node, serializedNode = null) {
	const props = serializedNode?.properties || node.properties || {};
	const saved = props?.[SAVED_VALUES_PROPERTY] || {};
	for (const name of ALL_FIELDS) {
		const widget = getWidget(node, name);
		if (!widget) continue;
		let value = saved[name];
		if (value === undefined) value = props[`gjj_qwen_image_edit_value_${name}`];
		if (value === undefined || value === null) continue;
		widget.value = value;
		if (widget.inputEl && "value" in widget.inputEl) widget.inputEl.value = value;
		if (widget.element && "value" in widget.element) widget.element.value = value;
	}
}

function safeAssign(widget, key, value) {
	try { widget[key] = value; } catch (_) {}
}

function collapseElement(el) {
	if (!el?.style) return;
	el.style.display = "none";
	el.style.pointerEvents = "none";
	el.style.height = "0px";
	el.style.minHeight = "0px";
	el.style.maxHeight = "0px";
	el.style.margin = "0px";
	el.style.padding = "0px";
	el.style.border = "0px";
	el.style.overflow = "hidden";
}

function hideWidget(widget) {
	if (!widget) return;
	safeAssign(widget, "hidden", true);
	safeAssign(widget, "type", `converted-widget:${widget.name || "hidden"}`);
	safeAssign(widget, "label", "");
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	safeAssign(widget, "size", [0, 0]);
	safeAssign(widget, "height", 0);
	safeAssign(widget, "serialize", true);
	if (widget.options && typeof widget.options === "object") {
		widget.options.hidden = true;
		widget.options.display = "hidden";
	}
	collapseElement(widget.inputEl);
	collapseElement(widget.element);
	collapseElement(widget.widget);
}

function hideNativeWidgets(node) {
	for (const name of ALL_FIELDS) hideWidget(getWidget(node, name));
}

function protect(el) {
	if (!el || el.__gjjQwenEditProtected) return;
	el.__gjjQwenEditProtected = true;
	for (const ev of ["pointerdown", "mousedown", "dblclick", "wheel", "contextmenu"]) {
		el.addEventListener(ev, (event) => event.stopPropagation());
	}
}

function inputText(input) {
	return [input?.name, input?.display_name, input?.displayName, input?.localized_name, input?.label, input?.type]
		.map((value) => String(value || ""))
		.join(" ");
}

function inputWidgetName(input) {
	return String(input?.widget?.name || input?.widget_name || "");
}

function isBackingFieldInput(input) {
	const name = String(input?.name || "");
	return BACKING_FIELD_INPUTS.has(name) || BACKING_FIELD_INPUTS.has(inputWidgetName(input));
}

function imageIndex(input) {
	const name = String(input?.name || "");
	let match = name.match(/^image_?0*(\d+)$/i);
	if (match) return Number.parseInt(match[1], 10);
	if (/^(main_image|主图)$/i.test(name)) return 1;
	const text = inputText(input);
	if (/(^|\s)主图($|\s)/.test(text)) return 1;
	match = text.match(/参考图\s*([0-9]+)/);
	if (match) return Number.parseInt(match[1], 10) + 1;
	return Number.MAX_SAFE_INTEGER;
}

function isImageInput(input) {
	if (!input) return false;
	const name = String(input.name || "");
	if (/^image_?0*\d+$/i.test(name) || /^(main_image|主图)$/i.test(name)) return true;
	const text = inputText(input);
	return /(^|\s)主图($|\s)/.test(text) || /参考图\s*[0-9]+/.test(text);
}

function imageInputs(node) {
	return Array.isArray(node?.inputs)
		? node.inputs.filter((input) => isImageInput(input)).sort((a, b) => imageIndex(a) - imageIndex(b))
		: [];
}

function inputHasLink(input) {
	return input?.link !== undefined && input?.link !== null;
}

function setImageInputMeta(input, index) {
	const name = `${IMAGE_PREFIX}${String(index).padStart(2, "0")}`;
	const label = index === 1 ? "主图" : `参考图 ${index - 1}`;
	input.name = name;
	input.type = "IMAGE";
	input.shape = input.shape || 7;
	input.label = label;
	input.localized_name = label;
	input.display_name = label;
	input.tooltip = index === 1
		? "主图：默认作为出图主画布；提示词写到图2/图3背景时，会自动改用对应参考图作为主画布。"
		: `参考图 ${index - 1}：参与 Qwen 图像编辑条件编码；提示词指定本图为背景时会自动作为出图主画布。`;
	delete input.widget;
	delete input.widget_name;
}

function removeInput(node, input) {
	const slot = node.inputs?.indexOf(input) ?? -1;
	if (slot < 0) return;
	try { node.disconnectInput?.(slot); } catch (_) {}
	if (typeof node.removeInput === "function") node.removeInput(slot);
	else node.inputs.splice(slot, 1);
}

function trimUnusedImageTail(node) {
	let inputs = imageInputs(node);
	while (inputs.length > MIN_IMAGE_INPUTS) {
		const last = inputs[inputs.length - 1];
		const prev = inputs[inputs.length - 2];
		if (inputHasLink(last) || inputHasLink(prev)) break;
		removeInput(node, last);
		inputs = imageInputs(node);
	}
}

function ensureTrailingImageInput(node) {
	let inputs = imageInputs(node);
	if (!inputs.length) {
		node.addInput?.("image_01", "IMAGE");
		inputs = imageInputs(node);
	}
	const last = inputs[inputs.length - 1];
	if (inputHasLink(last)) {
		node.addInput?.(`${IMAGE_PREFIX}${String(inputs.length + 1).padStart(2, "0")}`, "IMAGE");
	}
}

function removeBackingFieldInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		if (!isBackingFieldInput(input)) continue;
		removeInput(node, input);
	}
}

function preferredFixedInputOrder(name) {
	if (name === "clip") return 0;
	if (name === POSITIVE_PROMPT_INPUT) return 1;
	if (name === VAE_INPUT) return 2;
	return 50;
}

function reorderInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	const images = imageInputs(node);
	const imageSet = new Set(images);
	const fixed = node.inputs
		.filter((input) => input && !imageSet.has(input) && !isBackingFieldInput(input))
		.sort((a, b) => preferredFixedInputOrder(a.name) - preferredFixedInputOrder(b.name));
	node.inputs = [...fixed, ...images];
	refreshInputLinkSlots(node);
}

function refreshInputLinkSlots(node) {
	for (let index = 0; index < (node.inputs || []).length; index++) {
		const input = node.inputs[index];
		if (!inputHasLink(input)) continue;
		const link = app.graph?.links?.[input.link];
		if (!link) continue;
		link.target_id = node.id;
		link.target_slot = index;
		if (input.type) link.type = input.type;
	}
}

function applyInputMeta(node) {
	for (const input of node.inputs || []) {
		if (input.name === "clip") {
			input.label = "CLIP";
			input.localized_name = "CLIP";
			input.type = "CLIP";
			input.tooltip = "接入 Qwen Image Edit 使用的 CLIP / 文本编码器。";
		} else if (input.name === POSITIVE_PROMPT_INPUT) {
			input.label = "正向提示词";
			input.localized_name = "正向提示词";
			input.type = "STRING";
			input.tooltip = "外部正向提示词；连接后优先使用上游文本。";
		} else if (input.name === VAE_INPUT) {
			input.label = "VAE";
			input.localized_name = "VAE";
			input.type = "VAE";
			input.tooltip = "可选。连接后会写入 Qwen 图像编辑参考 latent。";
		}
	}
	imageInputs(node).forEach((input, index) => setImageInputMeta(input, index + 1));
}

function applyOutputMeta(node) {
	const names = [
		["主图", "IMAGE", "出图主画布。默认第 1 张；提示词指定图2/图3背景时会自动输出对应图片。"],
		["正向条件", "CONDITIONING", "Qwen Image Edit Plus 正向 CONDITIONING；多图时可选择是否写入多参考潜在方法。"],
		["负向条件", "CONDITIONING", "负向为空时按原版空负向编码；只有负向有内容且开启零化时才为全零条件。"],
	];
	while ((node.outputs || []).length > names.length) {
		const index = node.outputs.length - 1;
		try { node.disconnectOutput?.(index); } catch (_) {}
		try { node.removeOutput?.(index); }
		catch (_) { node.outputs.splice(index, 1); }
	}
	for (let i = 0; i < names.length; i += 1) {
		const output = node.outputs?.[i];
		if (!output) continue;
		const [name, type, tooltip] = names[i];
		output.name = name;
		output.label = name;
		output.localized_name = name;
		output.type = type;
		output.tooltip = tooltip;
	}
	refreshOutputLinkTypes(node);
}

function refreshOutputLinkTypes(node) {
	for (let index = 0; index < (node.outputs || []).length; index++) {
		const output = node.outputs[index];
		const links = Array.isArray(output?.links) ? output.links : [];
		for (const linkId of links) {
			const link = app.graph?.links?.[linkId];
			if (!link) continue;
			link.origin_id = node.id;
			link.origin_slot = index;
			if (output.type) link.type = output.type;
		}
	}
}

function getPositivePromptInputIndex(node) {
	return (node.inputs || []).findIndex((input) => {
		const text = inputText(input);
		return text.includes(POSITIVE_PROMPT_INPUT) || text.includes("正向提示词");
	});
}

function isPositivePromptConnected(node) {
	const index = getPositivePromptInputIndex(node);
	return index >= 0 && inputHasLink(node.inputs?.[index]);
}

function normalizeKey(text) {
	return String(text || "").trim().toLowerCase();
}

function readLinkedStringValue(source, output) {
	if (!source) return "";
	const candidateNames = [
		output?.widget?.name,
		output?.name,
		output?.label,
		output?.localized_name,
		output?.display_name,
		"text",
		"文本",
		"prompt",
		"提示词",
		"positive",
		"positive_prompt",
		"string",
		"STRING",
	].filter(Boolean);
	const widgets = Array.isArray(source.widgets) ? source.widgets : [];
	for (const name of candidateNames) {
		const target = normalizeKey(name);
		const widget = widgets.find((w) => normalizeKey(w?.name) === target || normalizeKey(w?.label) === target);
		if (widget && typeof widget.value === "string") return widget.value;
	}
	for (const name of candidateNames) {
		const target = normalizeKey(name);
		const widget = widgets.find((w) => {
			const nameText = normalizeKey(w?.name);
			const labelText = normalizeKey(w?.label);
			return (
				(nameText && (nameText.includes(target) || target.includes(nameText)))
				|| (labelText && (labelText.includes(target) || target.includes(labelText)))
			);
		});
		if (widget && typeof widget.value === "string") return widget.value;
	}
	for (const widget of widgets) {
		if (typeof widget?.value === "string" && widget.value.trim()) return widget.value;
	}
	const props = source.properties || {};
	for (const name of candidateNames) {
		if (typeof props[name] === "string") return props[name];
	}
	return "";
}

function getLinkedPositiveInfo(node) {
	const index = getPositivePromptInputIndex(node);
	const input = node.inputs?.[index];
	if (!inputHasLink(input)) return null;
	const link = app.graph?.links?.[input.link];
	const source = app.graph?.getNodeById?.(link?.origin_id) || app.graph?._nodes?.find((item) => String(item?.id) === String(link?.origin_id));
	const output = source?.outputs?.[link?.origin_slot];
	return {
		text: readLinkedStringValue(source, output),
		sourceId: link?.origin_id,
		sourceSlot: link?.origin_slot,
		linkId: input.link,
	};
}

function isTranslationEnabled(node) {
	return toBool(getValue(node, FIELD.translate, false));
}

function setTranslationEnabled(node, enabled) {
	setValue(node, FIELD.translate, Boolean(enabled));
}

function setStatus(node, text) {
	if (!node.__gjjQwenEditStatus) return;
	node.__gjjQwenEditStatus.textContent = String(text || "");
	node.__gjjQwenEditStatus.style.display = text ? "block" : "none";
	clearTimeout(node.__gjjQwenEditStatusTimer);
	if (text) {
		node.__gjjQwenEditStatusTimer = setTimeout(() => {
			if (node.__gjjQwenEditStatus) {
				node.__gjjQwenEditStatus.textContent = "";
				node.__gjjQwenEditStatus.style.display = "none";
			}
		}, 3600);
	}
}

function updateButtons(node) {
	const zero = toBool(getValue(node, FIELD.zero, false));
	const hasNegativePrompt = String(getValue(node, FIELD.negative, "") || "").trim().length > 0;
	if (node.__gjjQwenEditZeroButton) {
		node.__gjjQwenEditZeroButton.dataset.value = zero ? "true" : "false";
		node.__gjjQwenEditZeroButton.textContent = zero ? "✅ 条件零化" : "⬜ 条件零化";
		node.__gjjQwenEditZeroButton.title = zero
			? (hasNegativePrompt
				? "已开启：负向有内容，执行时按正向条件结构 zero_out。"
				: "已开启：单图负向为空仍按原生空负向编码；多图 FireRed/Lazy 模式会 zero_out。")
			: "关闭后会按负向文本编码；单图负向为空按原生空负向，多图 FireRed/Lazy 模式为空会自动 zero_out。";
	}
	const scale = toBool(getValue(node, FIELD.scale, true));
	if (node.__gjjQwenEditScaleButton) {
		node.__gjjQwenEditScaleButton.dataset.value = scale ? "true" : "false";
		node.__gjjQwenEditScaleButton.textContent = scale ? "✅ Kontext缩放" : "⬜ Kontext缩放";
		node.__gjjQwenEditScaleButton.title = scale
			? "缩放出图主画布；提示词写到图2背景时，会自动缩放图2。"
			: "关闭后出图主画布按原始尺寸参与编码并输出。";
	}
	const enabled = isTranslationEnabled(node);
	if (node.__gjjQwenEditTranslateButton) {
		node.__gjjQwenEditTranslateButton.dataset.value = enabled ? "true" : "false";
		node.__gjjQwenEditTranslateButton.textContent = enabled ? "✅ 翻译开" : "⬜ 翻译关";
		node.__gjjQwenEditTranslateButton.disabled = Boolean(node.__gjjQwenEditTranslating);
	}
	if (node.__gjjQwenEditUnloadButton) {
		const unload = toBool(getValue(node, FIELD.unload, false));
		node.__gjjQwenEditUnloadButton.dataset.value = unload ? "true" : "false";
		node.__gjjQwenEditUnloadButton.textContent = unload ? "✅ 卸载" : "⬜ 卸载";
	}
	if (node.__gjjQwenEditDeviceSelect) node.__gjjQwenEditDeviceSelect.value = String(getValue(node, FIELD.device, "auto") || "auto");
	const methodEnabled = toBool(getValue(node, FIELD.methodEnabled, true));
	if (node.__gjjQwenEditMethodToggle) {
		node.__gjjQwenEditMethodToggle.dataset.value = methodEnabled ? "true" : "false";
		node.__gjjQwenEditMethodToggle.textContent = methodEnabled ? "✅" : "⬜";
		node.__gjjQwenEditMethodToggle.title = methodEnabled
			? "已开启：执行时写入 FluxKontext 多参考潜在方法。"
			: "已关闭：执行时不写入参考潜在方法，正负条件保持 Qwen 原始编码。";
	}
	if (node.__gjjQwenEditMethodSelect) {
		node.__gjjQwenEditMethodSelect.value = String(getValue(node, FIELD.method, "index_timestep_zero") || "index_timestep_zero");
		node.__gjjQwenEditMethodSelect.disabled = !methodEnabled;
		node.__gjjQwenEditMethodSelect.style.opacity = methodEnabled ? "1" : "0.55";
		node.__gjjQwenEditMethodSelect.title = methodEnabled
			? "等价于 FluxKontext多参考潜在方法，会直接写入正负条件。"
			: "当前开关已关闭，执行时不会写入参考潜在方法。";
	}
}

function syncDomFromWidgets(node) {
	const positiveConnected = isPositivePromptConnected(node);
	const translationEnabled = isTranslationEnabled(node);
	const linkedPositive = positiveConnected ? getLinkedPositiveInfo(node) : null;
	if (positiveConnected && !translationEnabled && String(getValue(node, FIELD.positive, "") || "")) {
		setValue(node, FIELD.positive, "");
	}
	if (node.__gjjQwenEditPositive) {
		const nextPositive = positiveConnected
			? (translationEnabled ? String(getValue(node, FIELD.positive, "") || "") : "")
			: String(getValue(node, FIELD.positive, ""));
		if (node.__gjjQwenEditPositive.value !== nextPositive) node.__gjjQwenEditPositive.value = nextPositive;
		node.__gjjQwenEditPositive.readOnly = positiveConnected;
		node.__gjjQwenEditPositive.placeholder = positiveConnected
			? (translationEnabled ? "这里显示上游正向提示词的译文" : "已连接外部正向提示词，开启翻译后这里显示译文")
			: "输入 Qwen 图像编辑指令，可写中文后开启翻译";
		node.__gjjQwenEditPositive.classList.toggle("external", positiveConnected);
	}
	if (node.__gjjQwenEditNegative && node.__gjjQwenEditNegative.value !== String(getValue(node, FIELD.negative, ""))) {
		node.__gjjQwenEditNegative.value = String(getValue(node, FIELD.negative, ""));
	}
	const zero = toBool(getValue(node, FIELD.zero, false));
	if (node.__gjjQwenEditNegativeLabel) node.__gjjQwenEditNegativeLabel.style.display = zero ? "none" : "";
	if (node.__gjjQwenEditNegative) node.__gjjQwenEditNegative.style.display = zero ? "none" : "";
	updateButtons(node);
	updateExternalWatcher(node, positiveConnected && translationEnabled);
	if (positiveConnected && translationEnabled && linkedPositive?.text?.trim()) {
		queueExternalTranslationIfChanged(node, 180);
	}
	scheduleRefresh(node);
}

function updateExternalWatcher(node, active) {
	if (!active) {
		clearInterval(node.__gjjQwenEditExternalWatchTimer);
		node.__gjjQwenEditExternalWatchTimer = null;
		node.__gjjQwenEditPendingExternalSourceText = "";
		return;
	}
	if (node.__gjjQwenEditExternalWatchTimer) return;
	node.__gjjQwenEditExternalWatchTimer = setInterval(() => {
		const exists = app.graph?._nodes?.includes(node);
		if (!exists || !isPositivePromptConnected(node) || !isTranslationEnabled(node)) {
			updateExternalWatcher(node, false);
			return;
		}
		queueExternalTranslationIfChanged(node, 80);
	}, 900);
}

function queueExternalTranslationIfChanged(node, ms = 160) {
	const linked = getLinkedPositiveInfo(node);
	const text = String(linked?.text || "");
	if (
		text.trim()
		&& text !== node.__gjjQwenEditLastExternalSourceText
		&& text !== node.__gjjQwenEditPendingExternalSourceText
		&& !node.__gjjQwenEditTranslating
	) {
		node.__gjjQwenEditPendingExternalSourceText = text;
		scheduleTranslate(node, ms, { includeNegative: false, externalOnly: true });
	}
}

function scheduleTranslate(node, ms = 0, options = {}) {
	clearTimeout(node.__gjjQwenEditTranslateTimer);
	node.__gjjQwenEditTranslateTimer = setTimeout(() => translatePrompts(node, options), ms);
}

async function translatePrompts(node, options = {}) {
	if (node.__gjjQwenEditTranslating) return;
	clearTimeout(node.__gjjQwenEditTranslateTimer);
	const positiveConnected = isPositivePromptConnected(node);
	const translationEnabled = isTranslationEnabled(node);
	const linkedPositive = positiveConnected ? getLinkedPositiveInfo(node) : null;
	const useExternalPositive = Boolean(positiveConnected && translationEnabled && linkedPositive?.text?.trim());
	const positive = useExternalPositive
		? String(linkedPositive.text || "")
		: (positiveConnected ? "" : String(node.__gjjQwenEditPositive?.value ?? ""));
	const includeNegative = options.includeNegative !== false;
	const negative = includeNegative ? String(node.__gjjQwenEditNegative?.value ?? "") : "";
	const device = String(getValue(node, FIELD.device, "auto") || "auto");
	const unload = toBool(getValue(node, FIELD.unload, false));

	if (!positive.trim() && !negative.trim()) {
		setStatus(node, positiveConnected && translationEnabled ? "未读取到上游文本，执行时会翻译回填" : "没有需要翻译的内容");
		return;
	}

	setStatus(node, "正在翻译...");
	node.__gjjQwenEditTranslating = true;
	updateButtons(node);
	try {
		const data = await requestPromptTranslation({
			node,
			positive,
			negative,
			device,
			maxLength: 512,
			batchSize: 8,
			unloadAfterUse: unload,
			nodeName: NODE_DISPLAY_NAME,
		});
		if (useExternalPositive) {
			const translatedPositive = String(data.positive ?? "");
			node.__gjjQwenEditLastExternalSourceText = String(linkedPositive?.text || "");
			node.__gjjQwenEditPendingExternalSourceText = "";
			if (node.__gjjQwenEditPositive) node.__gjjQwenEditPositive.value = translatedPositive;
			setValue(node, FIELD.positive, translatedPositive);
		} else if (!positiveConnected) {
			const translatedPositive = String(data.positive ?? "");
			if (node.__gjjQwenEditPositive) node.__gjjQwenEditPositive.value = translatedPositive;
			setValue(node, FIELD.positive, translatedPositive);
		}
		if (includeNegative) {
			const translatedNegative = String(data.negative ?? "");
			if (node.__gjjQwenEditNegative) node.__gjjQwenEditNegative.value = translatedNegative;
			setValue(node, FIELD.negative, translatedNegative);
		}
		setStatus(node, useExternalPositive ? "上游正向提示词已翻译" : "翻译完成");
		syncDomFromWidgets(node);
	} catch (error) {
		console.error("[GJJ Qwen Image Edit Plus] 翻译失败", error);
		setStatus(node, `翻译失败：${error?.message || error}`);
	} finally {
		node.__gjjQwenEditTranslating = false;
		updateButtons(node);
	}
}

function buildButton(text, title, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-qwen-edit-btn";
	button.textContent = text;
	button.title = title;
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.();
	});
	protect(button);
	return button;
}

function createTextarea(node, name, placeholder) {
	const area = document.createElement("textarea");
	area.className = "gjj-qwen-edit-textarea";
	area.value = String(getValue(node, name, ""));
	area.placeholder = placeholder;
	area.rows = 2;
	area.spellcheck = false;
	protect(area);
	area.addEventListener("input", () => {
		if (name === FIELD.positive && isPositivePromptConnected(node)) {
			area.value = isTranslationEnabled(node) ? String(getValue(node, FIELD.positive, "") || "") : "";
			setStatus(node, "已连接外部正向提示词，此处只显示译文");
			return;
		}
		setValue(node, name, area.value);
		scheduleRefresh(node);
	});
	return area;
}

function buildDom(node) {
	const container = document.createElement("div");
	container.className = "gjj-qwen-edit-panel";
	container.style.cssText = "display:flex;flex-direction:column;gap:7px;width:100%;box-sizing:border-box;padding:0;";

	const style = document.createElement("style");
	style.textContent = `
		.gjj-qwen-edit-panel * { box-sizing:border-box; }
		.gjj-qwen-edit-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:6px; width:100%; min-width:0; overflow:visible; }
		.gjj-qwen-edit-btn, .gjj-qwen-edit-select {
			height:28px; border:1px solid #3d515a; border-radius:7px; background:#202a30; color:#dce7e2;
			flex:1 1 auto; min-width:0; max-width:100%; padding:3px 8px; font-size:12px; cursor:pointer; white-space:nowrap;
			overflow:hidden; text-overflow:ellipsis;
		}
		.gjj-qwen-edit-btn:hover { background:#2a3941; }
		.gjj-qwen-edit-btn[data-value="true"] { border-color:#4f8f7a; background:#20362f; color:#dff8ea; }
		.gjj-qwen-edit-btn:disabled { opacity:.55; cursor:default; }
		.gjj-qwen-edit-select { min-width:0; cursor:pointer; }
		.gjj-qwen-edit-label { color:#b9c8cc; font-size:12px; display:flex; align-items:center; justify-content:space-between; }
		.gjj-qwen-edit-textarea {
			width:100%; min-height:48px; resize:vertical; padding:7px 8px; border:1px solid #33464e;
			border-radius:8px; outline:none; background:#10181c; color:#f1f5f5;
			font:12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
		}
		.gjj-qwen-edit-textarea:focus { border-color:#6aa6b8; background:#111d22; }
		.gjj-qwen-edit-textarea.external { border-color:#4b5860; background:#101417; color:#8ea0a8; opacity:.78; }
		.gjj-qwen-edit-status { display:none; flex:1 1 100%; min-width:0; color:#8ea0a8; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		.gjj-qwen-edit-method-row { display:grid; grid-template-columns:30px minmax(0,82px) minmax(0,1fr); align-items:center; gap:7px; }
		.gjj-qwen-edit-method-row .gjj-qwen-edit-label { justify-content:flex-start; }
		.gjj-qwen-edit-method-row .gjj-qwen-edit-select { width:100%; height:30px; }
		.gjj-qwen-edit-method-toggle { width:30px; padding:0; text-align:center; }
	`;

	const toolbar = document.createElement("div");
	toolbar.className = "gjj-qwen-edit-toolbar";

	const zero = buildButton("⬜ 条件零化", "开启后负向按正向条件结构 zero_out；单图负向为空按原生空负向，多图 FireRed/Lazy 模式为空会自动 zero_out。", () => {
		setValue(node, FIELD.zero, !toBool(getValue(node, FIELD.zero, false)));
		syncDomFromWidgets(node);
	});
	const scale = buildButton("✅ Kontext缩放", "缩放出图主画布；写图2背景时会自动缩放图2。", () => {
		setValue(node, FIELD.scale, !toBool(getValue(node, FIELD.scale, true)));
		syncDomFromWidgets(node);
	});
	const translate = buildButton("⬜ 翻译关", "点击开启翻译，并立即翻译当前面板文本。", () => {
		const nextEnabled = !isTranslationEnabled(node);
		setTranslationEnabled(node, nextEnabled);
		syncDomFromWidgets(node);
		if (nextEnabled) {
			translatePrompts(node, { includeNegative: true });
		} else {
			if (isPositivePromptConnected(node)) {
				node.__gjjQwenEditLastExternalSourceText = "";
				setValue(node, FIELD.positive, "");
			}
			setStatus(node, "翻译已关闭");
			syncDomFromWidgets(node);
		}
	});

	const device = document.createElement("select");
	device.className = "gjj-qwen-edit-select";
	for (const value of ["auto", "cpu", "gpu"]) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value;
		device.appendChild(option);
	}
	device.value = String(getValue(node, FIELD.device, "auto") || "auto");
	device.title = "翻译设备";
	device.addEventListener("change", () => setValue(node, FIELD.device, device.value));
	protect(device);

	const unload = buildButton("⬜ 卸载", "翻译完成后是否卸载 Opus-MT 模型。", () => {
		setValue(node, FIELD.unload, !toBool(getValue(node, FIELD.unload, false)));
		syncDomFromWidgets(node);
	});
	const status = document.createElement("span");
	status.className = "gjj-qwen-edit-status";
	toolbar.append(zero, scale, translate, device, unload, status);

	const positiveLabel = document.createElement("div");
	positiveLabel.className = "gjj-qwen-edit-label";
	positiveLabel.textContent = "正向提示词";
	const positive = createTextarea(node, FIELD.positive, "输入 Qwen 图像编辑指令，可写中文后开启翻译");

	const negativeLabel = document.createElement("div");
	negativeLabel.className = "gjj-qwen-edit-label";
	negativeLabel.textContent = "负向提示词";
	const negative = createTextarea(node, FIELD.negative, "可记录负向提示词，开启翻译时会一并翻译");

	const methodRow = document.createElement("div");
	methodRow.className = "gjj-qwen-edit-method-row";
	const methodToggle = buildButton("✅", "开启/关闭 FluxKontext 多参考潜在方法写入。", () => {
		const next = !toBool(getValue(node, FIELD.methodEnabled, true));
		setValue(node, FIELD.methodEnabled, next);
		setStatus(node, next ? "参考潜在方法已开启" : "参考潜在方法已关闭");
		syncDomFromWidgets(node);
	});
	methodToggle.classList.add("gjj-qwen-edit-method-toggle");
	const methodLabel = document.createElement("div");
	methodLabel.className = "gjj-qwen-edit-label";
	methodLabel.textContent = "参考潜在方法";
	const method = document.createElement("select");
	method.className = "gjj-qwen-edit-select";
	method.title = "等价于 FluxKontext多参考潜在方法，会直接写入正负条件。";
	for (const value of REFERENCE_METHODS) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value;
		method.appendChild(option);
	}
	method.value = String(getValue(node, FIELD.method, "index_timestep_zero") || "index_timestep_zero");
	method.addEventListener("change", () => {
		setValue(node, FIELD.method, method.value);
		setStatus(node, `参考潜在方法：${method.value}`);
	});
	protect(method);
	methodRow.append(methodToggle, methodLabel, method);

	container.append(style, toolbar, positiveLabel, positive, negativeLabel, negative, methodRow);
	container.addEventListener("pointerdown", (event) => event.stopPropagation());
	container.addEventListener("mousedown", (event) => event.stopPropagation());
	container.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

	node.__gjjQwenEditContainer = container;
	node.__gjjQwenEditPositive = positive;
	node.__gjjQwenEditNegativeLabel = negativeLabel;
	node.__gjjQwenEditNegative = negative;
	node.__gjjQwenEditZeroButton = zero;
	node.__gjjQwenEditScaleButton = scale;
	node.__gjjQwenEditTranslateButton = translate;
	node.__gjjQwenEditDeviceSelect = device;
	node.__gjjQwenEditUnloadButton = unload;
	node.__gjjQwenEditStatus = status;
	node.__gjjQwenEditMethodToggle = methodToggle;
	node.__gjjQwenEditMethodSelect = method;

	syncDomFromWidgets(node);
	return container;
}

function measurePanelHeight(node) {
	const container = node?.__gjjQwenEditContainer;
	if (!container) return PANEL_MIN_HEIGHT;
	const children = Array.from(container.children || []).filter((child) => {
		if (!child || String(child.tagName || "").toLowerCase() === "style") return false;
		const style = getComputedStyle(child);
		return style.display !== "none" && style.visibility !== "hidden";
	});
	const childrenHeight = children.reduce((total, child) => {
		const rectHeight = Number(child.getBoundingClientRect?.().height || 0);
		const height = Math.ceil(rectHeight || child.offsetHeight || child.scrollHeight || 0);
		return total + height;
	}, 0);
	const gapHeight = Math.max(0, children.length - 1) * PANEL_GAP;
	const height = Math.ceil(childrenHeight + gapHeight || container.scrollHeight || container.offsetHeight || PANEL_MIN_HEIGHT);
	const normalized = Math.max(PANEL_MIN_HEIGHT, height);
	if (node) node.__gjjQwenEditPanelHeight = normalized;
	return normalized;
}

function visibleInputCount(node) {
	return (node?.inputs || []).filter((input) => input && input.type !== "hidden" && !isBackingFieldInput(input)).length;
}

function panelWidgetTop(node) {
	const widget = node?.__gjjQwenEditWidget;
	const candidates = [
		Number(widget?.last_y),
		Number(widget?.y),
		Number(node?.__gjjQwenEditLastWidgetTop),
	];
	for (const value of candidates) {
		if (Number.isFinite(value) && value > 0) {
			node.__gjjQwenEditLastWidgetTop = value;
			return value;
		}
	}
	const fallback = 32 + Math.max(1, visibleInputCount(node)) * 20 + 8;
	if (node) node.__gjjQwenEditLastWidgetTop = fallback;
	return fallback;
}

function desiredNodeSize(node) {
	const currentWidth = Number(node?.size?.[0]);
	const width = Number.isFinite(currentWidth) && currentWidth > 0 ? currentWidth : DEFAULT_WIDTH;
	const height = Math.ceil(panelWidgetTop(node) + measurePanelHeight(node) + NODE_BOTTOM_PADDING);
	return [width, Math.max(MIN_HEIGHT, height)];
}

function refreshNode(node) {
	if (!node) return;
	const [width, height] = desiredNodeSize(node);
	if (!node.__gjjQwenEditSizing && (Math.abs(Number(node.size?.[0] || 0) - width) > 4 || Math.abs(Number(node.size?.[1] || 0) - height) > 4)) {
		node.__gjjQwenEditSizing = true;
		try {
			if (typeof node.setSize === "function") node.setSize([width, height]);
			else node.size = [width, height];
		}
		finally { requestAnimationFrame(() => { node.__gjjQwenEditSizing = false; }); }
	}
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function scheduleRefresh(node, ms = 0) {
	clearTimeout(node.__gjjQwenEditRefreshTimer);
	node.__gjjQwenEditRefreshTimer = setTimeout(() => {
		requestAnimationFrame(() => {
			refreshNode(node);
			requestAnimationFrame(() => refreshNode(node));
		});
	}, ms);
}

function ensureDom(node) {
	if (node.__gjjQwenEditWidget) return;
	const container = buildDom(node);
	const domWidget = node.addDOMWidget?.(DOM_WIDGET, "HTML", container, {
		serialize: false,
		hideOnZoom: false,
	});
	if (domWidget) {
		domWidget.computeSize = (width) => [
			Math.max(1, Number(width || node.size?.[0] || DEFAULT_WIDTH)),
			measurePanelHeight(node),
		];
		node.__gjjQwenEditWidget = domWidget;
		if (Array.isArray(node.widgets)) {
			const index = node.widgets.indexOf(domWidget);
			if (index > 0) {
				node.widgets.splice(index, 1);
				node.widgets.unshift(domWidget);
			}
		}
	}
}

function stabilize(node) {
	if (!isTarget(node)) return;
	restoreValues(node);
	ensureDom(node);
	hideNativeWidgets(node);
	removeBackingFieldInputs(node);
	trimUnusedImageTail(node);
	ensureTrailingImageInput(node);
	applyInputMeta(node);
	reorderInputs(node);
	applyOutputMeta(node);
	syncDomFromWidgets(node);
	const signature = imageInputs(node).map((input) => `${input.name}:${input.link ?? ""}`).join("|");
	node.__gjjQwenEditImageSignature = signature;
	scheduleRefresh(node, 0);
}

function scheduleStabilize(node, ms = 32) {
	if (!isTarget(node)) return;
	clearTimeout(node.__gjjQwenEditStabilizeTimer);
	node.__gjjQwenEditStabilizeTimer = setTimeout(() => stabilize(node), ms);
}

function currentImageSignature(node) {
	return imageInputs(node).map((input) => `${input.name}:${input.link ?? ""}`).join("|");
}

function applyBackendTranslation(detail) {
	const node = app.graph?._nodes?.find((item) => String(item?.id) === String(detail?.node));
	if (!node || !isTarget(node) || !isTranslationEnabled(node)) return;
	if (typeof detail?.positive === "string") {
		const linked = getLinkedPositiveInfo(node);
		if (linked?.text) node.__gjjQwenEditLastExternalSourceText = linked.text;
		node.__gjjQwenEditPendingExternalSourceText = "";
		if (node.__gjjQwenEditPositive) node.__gjjQwenEditPositive.value = detail.positive;
		setValue(node, FIELD.positive, detail.positive);
	}
	if (typeof detail?.negative === "string") {
		if (node.__gjjQwenEditNegative) node.__gjjQwenEditNegative.value = detail.negative;
		setValue(node, FIELD.negative, detail.negative);
	}
	setStatus(node, "提示词已翻译回填");
	syncDomFromWidgets(node);
	scheduleRefresh(node);
}

api.addEventListener(TRANSLATED_EVENT, (event) => applyBackendTranslation(event?.detail || {}));

app.registerExtension({
	name: "Comfy.GJJ.QwenImageEditPlusPanel",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;

		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (type, name, value, callback, options, ...rest) {
			const widget = originalAddWidget?.apply(this, [type, name, value, callback, options, ...rest]);
			if (ALL_FIELDS.includes(name)) hideWidget(widget);
			return widget;
		};

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			scheduleStabilize(this, 0);
			scheduleStabilize(this, 80);
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalConfigure?.apply(this, [serializedNode, ...args]);
			restoreValues(this, serializedNode);
			scheduleStabilize(this, 0);
			scheduleStabilize(this, 80);
			return result;
		};

		const originalSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			saveValues(this, serializedNode);
			originalSerialize?.apply(this, [serializedNode]);
			saveValues(this, serializedNode);
		};

		const originalResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalResize?.apply(this, args);
			if (!this.__gjjQwenEditSizing) scheduleRefresh(this);
			return result;
		};

		const originalDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			const result = originalDrawBackground?.apply(this, args);
			const widgetTop = Math.max(
				0,
				Number(this.__gjjQwenEditWidget?.last_y || 0),
				Number(this.__gjjQwenEditWidget?.y || 0),
			);
			if (widgetTop > 0 && Math.abs(widgetTop - Number(this.__gjjQwenEditLastWidgetTop || 0)) > 1) {
				this.__gjjQwenEditLastWidgetTop = widgetTop;
				scheduleRefresh(this, 0);
			}
			const signature = currentImageSignature(this);
			if (signature !== this.__gjjQwenEditImageSignature) {
				this.__gjjQwenEditImageSignature = signature;
				scheduleStabilize(this, 0);
			}
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			scheduleStabilize(this, 0);
			return result;
		};
	},
	nodeCreated(node) {
		if (isTarget(node)) scheduleStabilize(node, 0);
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (isTarget(node)) scheduleStabilize(node, 0);
		}
	},
});
