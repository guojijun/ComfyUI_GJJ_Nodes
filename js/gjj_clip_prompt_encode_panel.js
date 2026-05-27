import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_CLIPPromptEncodePanel"]);
const TRANSLATE_API = "/gjj/clip_prompt_translate";
const TRANSLATED_EVENT = "gjj_clip_prompt_translated";

const FIELD = {
	positive: "positive_text",
	negative: "negative_text",
	zero: "zero_conditioning",
	device: "translation_device",
	unload: "translation_unload_after_use",
	translate: "translation_enabled",
};
const POSITIVE_PROMPT_INPUT = "positive_prompt_input";

const DOM_WIDGET = "gjj_clip_prompt_encode_panel";
const SAVED_VALUES_PROPERTY = "gjj_clip_prompt_encode_panel_values";
const ALL_FIELDS = Object.values(FIELD);

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
		const w = getWidget(node, name);
		if (w) values[name] = w.value;
	}
	return values;
}

function saveValues(node, serializedNode = null) {
	node.properties = node.properties || {};
	const values = collectValues(node);
	node.properties[SAVED_VALUES_PROPERTY] = { ...values };
	for (const [name, value] of Object.entries(values)) {
		node.properties[`gjj_clip_prompt_value_${name}`] = value;
	}

	if (serializedNode) {
		serializedNode.properties = serializedNode.properties || {};
		serializedNode.properties[SAVED_VALUES_PROPERTY] = { ...values };
		for (const [name, value] of Object.entries(values)) {
			serializedNode.properties[`gjj_clip_prompt_value_${name}`] = value;
		}
		if (Array.isArray(node.widgets)) {
			serializedNode.widgets_values = Array.isArray(serializedNode.widgets_values)
				? serializedNode.widgets_values
				: [];
			for (const name of ALL_FIELDS) {
				const w = getWidget(node, name);
				const index = node.widgets.indexOf(w);
				if (w && index >= 0) serializedNode.widgets_values[index] = w.value;
			}
		}
	}
	return values;
}

function restoreValues(node, serializedNode = null) {
	const props = serializedNode?.properties || node.properties || {};
	const saved = props?.[SAVED_VALUES_PROPERTY] || {};
	for (const name of ALL_FIELDS) {
		const w = getWidget(node, name);
		if (!w) continue;
		let value = saved[name];
		if (value === undefined) value = props[`gjj_clip_prompt_value_${name}`];
		if (value === undefined || value === null) continue;
		w.value = value;
		if (w.inputEl && "value" in w.inputEl) w.inputEl.value = value;
		if (w.element && "value" in w.element) w.element.value = value;
	}
}

function safeAssign(w, key, value) {
	try { w[key] = value; } catch (_) {}
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

function hideWidget(w) {
	if (!w) return;
	safeAssign(w, "hidden", true);
	safeAssign(w, "type", `converted-widget:${w.name || "hidden"}`);
	safeAssign(w, "label", "");
	w.computeSize = () => [0, -4];
	w.getHeight = () => -4;
	w.draw = () => {};
	safeAssign(w, "y", 0);
	safeAssign(w, "last_y", 0);
	safeAssign(w, "size", [0, -4]);
	safeAssign(w, "height", -4);
	safeAssign(w, "serialize", true);
	if (w.options && typeof w.options === "object") {
		w.options.hidden = true;
		w.options.display = "hidden";
	}
	collapseElement(w.inputEl);
	collapseElement(w.element);
	collapseElement(w.widget);
}

function hideNativeWidgets(node) {
	for (const name of ALL_FIELDS) hideWidget(getWidget(node, name));
}

function protect(el) {
	if (!el || el.__gjjClipPromptProtected) return;
	el.__gjjClipPromptProtected = true;
	for (const ev of ["pointerdown", "mousedown", "dblclick", "wheel", "contextmenu"]) {
		el.addEventListener(ev, (event) => event.stopPropagation());
	}
}

function inputText(input) {
	return [input?.name, input?.display_name, input?.displayName, input?.localized_name, input?.label, input?.type]
		.map((value) => String(value || ""))
		.join(" ");
}

function getInputIndex(node, predicate) {
	return (node.inputs || []).findIndex((input) => predicate(input));
}

function inputHasLink(input) {
	return input?.link !== undefined && input?.link !== null;
}

function getPositivePromptInputIndex(node) {
	return getInputIndex(node, (input) => {
		const text = inputText(input);
		return text.includes(POSITIVE_PROMPT_INPUT) || text.includes("正向提示词");
	});
}

function isLegacyPositiveInput(input) {
	const text = inputText(input);
	if (text.includes(POSITIVE_PROMPT_INPUT) || text.includes("正向提示词")) return false;
	return text.includes(FIELD.positive) || text.includes(`converted-widget:${FIELD.positive}`) || text.includes("正面提示词");
}

function getLegacyPositiveInputIndex(node) {
	return getInputIndex(node, isLegacyPositiveInput);
}

function moveLegacyPositiveLink(node) {
	const targetIndex = getPositivePromptInputIndex(node);
	const legacyIndex = getLegacyPositiveInputIndex(node);
	if (targetIndex < 0 || legacyIndex < 0 || targetIndex === legacyIndex) return;
	const target = node.inputs?.[targetIndex];
	const legacy = node.inputs?.[legacyIndex];
	if (!legacy || !inputHasLink(legacy) || inputHasLink(target)) return;
	const linkId = legacy.link;
	legacy.link = null;
	target.link = linkId;
	const link = app.graph?.links?.[linkId];
	if (link) {
		link.target_id = node.id;
		link.target_slot = targetIndex;
		link.type = target.type || link.type || "STRING";
	}
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

function cleanupLegacyPositiveInputs(node) {
	for (let index = (node.inputs || []).length - 1; index >= 0; index--) {
		const input = node.inputs[index];
		if (!input || !isLegacyPositiveInput(input)) continue;
		if (inputHasLink(input)) continue;
		try {
			if (typeof node.removeInput === "function") node.removeInput(index);
			else node.inputs?.splice?.(index, 1);
		} catch (_) {
			node.inputs?.splice?.(index, 1);
		}
	}
	refreshInputLinkSlots(node);
}

function isPositivePromptConnected(node) {
	moveLegacyPositiveLink(node);
	cleanupLegacyPositiveInputs(node);
	const index = getPositivePromptInputIndex(node);
	return index >= 0 && inputHasLink(node.inputs?.[index]);
}

function getLinkedPositiveInfo(node) {
	moveLegacyPositiveLink(node);
	cleanupLegacyPositiveInputs(node);
	const index = getPositivePromptInputIndex(node);
	const input = node.inputs?.[index];
	if (!inputHasLink(input)) return null;
	const link = app.graph?.links?.[input.link];
	const source = app.graph?.getNodeById?.(link?.origin_id) || app.graph?._nodes?.find((item) => String(item?.id) === String(link?.origin_id));
	const output = source?.outputs?.[link?.origin_slot];
	const text = readLinkedStringValue(source, output);
	return {
		text,
		sourceId: link?.origin_id,
		sourceSlot: link?.origin_slot,
		linkId: input.link,
	};
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
		"positive_text",
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

function isTranslationEnabled(node) {
	return toBool(getValue(node, FIELD.translate, false));
}

function setTranslationEnabled(node, enabled) {
	setValue(node, FIELD.translate, Boolean(enabled));
}

function applyDependencyNotice(node, report) {
	if (!report || !globalThis.GJJ_CommonDependencyModelNotice?.applyNotice) return;
	globalThis.GJJ_CommonDependencyModelNotice.applyNotice(node, {
		warning_message: report.warning_message || "⚠️缺失运行依赖，点击❓按钮了解详情。",
		panel_message: report.panel_message || report.help_message || report.warning_message || "",
		install_command: report.install_cmd || "",
		optional_install_command: report.optional_install_cmd || "",
		copy_text: report.copy_text || report.install_cmd || report.optional_install_cmd || report.model_download_url || "",
		copy_label: report.copy_label || "",
		model_download_url: report.model_download_url || "",
		notice_level: report.notice_level || "error",
	}, { detailed: true });
}

function updateTranslateButton(node) {
	const button = node.__gjjClipTranslateButton;
	if (!button) return;
	const enabled = isTranslationEnabled(node);
	button.dataset.value = enabled ? "true" : "false";
	button.textContent = enabled ? "✅ 翻译开" : "⬜ 翻译关";
	button.title = enabled
		? "翻译已开启：连接上游正向提示词时，本面板显示译文；再次点击关闭。中文引号“”内不翻译。"
		: "点击开启翻译，并立即翻译当前面板文本；中文引号“”内不翻译。";
	button.disabled = Boolean(node.__gjjClipTranslating);
}

function updateExternalWatcher(node, active) {
	if (!active) {
		clearInterval(node.__gjjClipExternalWatchTimer);
		node.__gjjClipExternalWatchTimer = null;
		node.__gjjClipPendingExternalSourceText = "";
		return;
	}
	if (node.__gjjClipExternalWatchTimer) return;
	node.__gjjClipExternalWatchTimer = setInterval(() => {
		const exists = app.graph?._nodes?.includes(node);
		if (!exists || !isPositivePromptConnected(node) || !isTranslationEnabled(node)) {
			updateExternalWatcher(node, false);
			return;
		}
		queueExternalTranslationIfChanged(node, 80);
	}, 900);
}

function queueExternalTranslationIfChanged(node, ms = 180) {
	const linked = getLinkedPositiveInfo(node);
	const text = String(linked?.text || "");
	if (
		text.trim()
		&& text !== node.__gjjClipLastExternalSourceText
		&& text !== node.__gjjClipPendingExternalSourceText
		&& !node.__gjjClipTranslating
	) {
		node.__gjjClipPendingExternalSourceText = text;
		scheduleTranslate(node, ms, { includeNegative: false, externalOnly: true });
	}
}

function refreshNode(node) {
	if (!node) return;
	const width = Math.max(360, Number(node.size?.[0] || 460));
	const height = Math.max(180, Math.ceil(node.__gjjClipPromptContainer?.scrollHeight || node.size?.[1] || 180) + 10);
	if (!node.__gjjClipPromptSizing && (Math.abs(Number(node.size?.[1] || 0) - height) > 1 || Math.abs(Number(node.size?.[0] || 0) - width) > 1)) {
		node.__gjjClipPromptSizing = true;
		try { node.setSize?.([width, height]); }
		finally { requestAnimationFrame(() => { node.__gjjClipPromptSizing = false; }); }
	}
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function syncDomFromWidgets(node) {
	const positiveConnected = isPositivePromptConnected(node);
	const translationEnabled = isTranslationEnabled(node);
	const linkedPositive = positiveConnected ? getLinkedPositiveInfo(node) : null;
	if (positiveConnected && !translationEnabled && String(getValue(node, FIELD.positive, "") || "")) {
		setValue(node, FIELD.positive, "");
	}
	if (node.__gjjClipPositive) {
		const nextPositive = positiveConnected
			? (translationEnabled ? String(getValue(node, FIELD.positive, "") || "") : "")
			: String(getValue(node, FIELD.positive, ""));
		if (node.__gjjClipPositive.value !== nextPositive) node.__gjjClipPositive.value = nextPositive;
		node.__gjjClipPositive.disabled = false;
		node.__gjjClipPositive.readOnly = positiveConnected;
		node.__gjjClipPositive.placeholder = positiveConnected
			? (translationEnabled ? "翻译开关已开启：这里显示上游正向提示词的译文" : "已连接外部正向提示词，开启翻译后这里显示译文")
			: "输入正面提示词，可写中文后开启翻译";
		node.__gjjClipPositive.title = positiveConnected
			? (translationEnabled ? "当前使用左侧“正向提示词”输入口；此处只显示翻译后的文本。" : "当前使用左侧“正向提示词”输入口的外部文本。")
			: "中文引号“”内的内容会保持原文。";
		node.__gjjClipPositive.classList.toggle("external", positiveConnected);
	}
	if (node.__gjjClipNegative && node.__gjjClipNegative.value !== String(getValue(node, FIELD.negative, ""))) {
		node.__gjjClipNegative.value = String(getValue(node, FIELD.negative, ""));
	}
	const zero = toBool(getValue(node, FIELD.zero, false));
	if (node.__gjjClipZeroButton) {
		node.__gjjClipZeroButton.dataset.value = zero ? "true" : "false";
		node.__gjjClipZeroButton.textContent = zero ? "✅ 条件零化" : "⬜ 条件零化";
		node.__gjjClipZeroButton.title = zero
			? "已开启条件零化：正向正常编码，负向使用正向条件结构生成全零 CONDITIONING"
			: "开启后隐藏负向提示词；负向输出会由正向编码结果 zero_out 得到";
	}
	if (node.__gjjClipNegativeLabel) node.__gjjClipNegativeLabel.style.display = zero ? "none" : "";
	if (node.__gjjClipNegative) node.__gjjClipNegative.style.display = zero ? "none" : "";
	if (node.__gjjClipDevice) node.__gjjClipDevice.value = String(getValue(node, FIELD.device, "auto") || "auto");
	if (node.__gjjClipUnload) {
		const unload = toBool(getValue(node, FIELD.unload, false));
		node.__gjjClipUnload.dataset.value = unload ? "true" : "false";
		node.__gjjClipUnload.textContent = unload ? "✅ 卸载" : "⬜ 卸载";
	}
	updateTranslateButton(node);
	updateExternalWatcher(node, positiveConnected && translationEnabled);

	if (positiveConnected && translationEnabled && linkedPositive?.text?.trim()) queueExternalTranslationIfChanged(node, 180);
}

function scheduleTranslate(node, ms = 0, options = {}) {
	clearTimeout(node.__gjjClipTranslateTimer);
	node.__gjjClipTranslateTimer = setTimeout(() => translatePrompts(node, options), ms);
}

async function translatePrompts(node, options = {}) {
	if (node.__gjjClipTranslating) return;
	clearTimeout(node.__gjjClipTranslateTimer);
	const positiveConnected = isPositivePromptConnected(node);
	const translationEnabled = isTranslationEnabled(node);
	const linkedPositive = positiveConnected ? getLinkedPositiveInfo(node) : null;
	const useExternalPositive = Boolean(positiveConnected && translationEnabled && linkedPositive?.text?.trim());
	const positive = useExternalPositive
		? String(linkedPositive.text || "")
		: (positiveConnected ? "" : String(node.__gjjClipPositive?.value ?? ""));
	const includeNegative = options.includeNegative !== false;
	const negative = includeNegative ? String(node.__gjjClipNegative?.value ?? "") : "";
	const device = String(getValue(node, FIELD.device, "auto") || "auto");
	const unload = toBool(getValue(node, FIELD.unload, false));

	if (!positive.trim() && !negative.trim()) {
		setStatus(node, positiveConnected && translationEnabled ? "未读取到上游文本，执行时会翻译回填" : "没有需要翻译的内容");
		return;
	}

	setStatus(node, "正在翻译...");
	node.__gjjClipTranslating = true;
	updateTranslateButton(node);

	try {
		const response = await fetch(TRANSLATE_API, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				node: String(node?.id ?? ""),
				positive,
				negative,
				device,
				max_length: 512,
				batch_size: 8,
				unload_after_use: unload,
			}),
		});
		const data = await response.json();
		if (data?.report) applyDependencyNotice(node, data.report);
		if (!response.ok || !data?.ok) {
			throw new Error(data?.error || `HTTP ${response.status}`);
		}
		if (useExternalPositive) {
			const translatedPositive = String(data.positive ?? "");
			node.__gjjClipLastExternalSourceText = String(linkedPositive?.text || "");
			node.__gjjClipPendingExternalSourceText = "";
			if (node.__gjjClipPositive) node.__gjjClipPositive.value = translatedPositive;
			setValue(node, FIELD.positive, translatedPositive);
		} else if (!positiveConnected) {
			const translatedPositive = String(data.positive ?? "");
			if (node.__gjjClipPositive) node.__gjjClipPositive.value = translatedPositive;
			setValue(node, FIELD.positive, translatedPositive);
		}
		if (includeNegative) {
			const translatedNegative = String(data.negative ?? "");
			if (node.__gjjClipNegative) node.__gjjClipNegative.value = translatedNegative;
			setValue(node, FIELD.negative, translatedNegative);
		}
		setStatus(node, useExternalPositive ? "上游正向提示词已翻译" : "翻译完成");
		syncDomFromWidgets(node);
		refreshNode(node);
	} catch (error) {
		console.error("[GJJ CLIP Prompt Encode] 翻译失败", error);
		setStatus(node, `翻译失败：${error?.message || error}`);
	} finally {
		node.__gjjClipTranslating = false;
		updateTranslateButton(node);
	}
}

function setStatus(node, text) {
	if (!node.__gjjClipStatus) return;
	node.__gjjClipStatus.textContent = String(text || "");
	clearTimeout(node.__gjjClipStatusTimer);
	if (text) {
		node.__gjjClipStatusTimer = setTimeout(() => {
			if (node.__gjjClipStatus) node.__gjjClipStatus.textContent = "";
		}, 3500);
	}
}

function createTextarea(node, name, placeholder) {
	const area = document.createElement("textarea");
	area.className = "gjj-clip-prompt-textarea";
	area.value = String(getValue(node, name, ""));
	area.placeholder = placeholder;
	area.spellcheck = false;
	protect(area);
	area.addEventListener("input", () => {
		if (name === FIELD.positive && isPositivePromptConnected(node)) {
			if (isTranslationEnabled(node)) {
				area.value = String(getValue(node, FIELD.positive, "") || "");
				setStatus(node, "已连接上游正向提示词，此处只显示译文");
			} else {
				area.value = "";
				setValue(node, FIELD.positive, "");
				setStatus(node, "已连接外部正向提示词，面板正向提示词保持清空");
			}
			return;
		}
		setValue(node, name, area.value);
		area.style.height = "auto";
		area.style.height = `${Math.max(78, area.scrollHeight || 78)}px`;
		refreshNode(node);
	});
	return area;
}

function buildDom(node) {
	const container = document.createElement("div");
	container.className = "gjj-clip-prompt-panel";
	container.style.cssText = "display:flex;flex-direction:column;gap:7px;width:100%;box-sizing:border-box;padding:0;";

	const style = document.createElement("style");
	style.textContent = `
		.gjj-clip-prompt-panel * { box-sizing:border-box; }
		.gjj-clip-prompt-toolbar { display:flex; align-items:center; gap:6px; }
		.gjj-clip-prompt-btn, .gjj-clip-prompt-select {
			height:28px; border:1px solid #3d515a; border-radius:7px; background:#202a30; color:#dce7e2;
			padding:3px 8px; font-size:12px; cursor:pointer; white-space:nowrap;
		}
		.gjj-clip-prompt-btn:hover { background:#2a3941; }
		.gjj-clip-prompt-btn[data-value="true"] { border-color:#4f8f7a; background:#20362f; color:#dff8ea; }
		.gjj-clip-prompt-btn:disabled { opacity:0.55; cursor:default; }
		.gjj-clip-prompt-select { min-width:74px; cursor:pointer; }
		.gjj-clip-prompt-label { color:#b9c8cc; font-size:12px; display:flex; align-items:center; justify-content:space-between; }
		.gjj-clip-prompt-textarea {
			width:100%; min-height:78px; resize:vertical; padding:7px 8px; border:1px solid #33464e;
			border-radius:8px; outline:none; background:#10181c; color:#f1f5f5;
			font:12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
		}
		.gjj-clip-prompt-textarea:focus { border-color:#6aa6b8; background:#111d22; }
		.gjj-clip-prompt-textarea.external { border-color:#4b5860; background:#101417; color:#8ea0a8; opacity:.78; }
		.gjj-clip-prompt-status { flex:1; min-width:0; color:#8ea0a8; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	`;

	const toolbar = document.createElement("div");
	toolbar.className = "gjj-clip-prompt-toolbar";

	const zero = document.createElement("button");
	zero.type = "button";
	zero.className = "gjj-clip-prompt-btn";
	zero.title = "开启后隐藏负向提示词；正向正常编码，负向由正向条件 zero_out 得到";
	zero.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setValue(node, FIELD.zero, !toBool(getValue(node, FIELD.zero, false)));
		syncDomFromWidgets(node);
		refreshNode(node);
	});
	protect(zero);

	const translate = document.createElement("button");
	translate.type = "button";
	translate.className = "gjj-clip-prompt-btn";
	translate.textContent = "⬜ 翻译关";
	translate.title = "点击开启翻译，并立即翻译当前面板文本；中文引号“”内不翻译";
	translate.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const nextEnabled = !isTranslationEnabled(node);
		setTranslationEnabled(node, nextEnabled);
		syncDomFromWidgets(node);
		if (nextEnabled) {
			translatePrompts(node, { includeNegative: true });
		} else {
			if (isPositivePromptConnected(node)) {
				node.__gjjClipLastExternalSourceText = "";
				setValue(node, FIELD.positive, "");
			}
			setStatus(node, "翻译已关闭");
			syncDomFromWidgets(node);
			refreshNode(node);
		}
	});
	protect(translate);

	const device = document.createElement("select");
	device.className = "gjj-clip-prompt-select";
	for (const value of ["auto", "cpu", "gpu"]) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value;
		device.appendChild(option);
	}
	device.value = String(getValue(node, FIELD.device, "auto") || "auto");
	device.title = "翻译设备";
	device.addEventListener("change", () => {
		setValue(node, FIELD.device, device.value);
	});
	protect(device);

	const unload = document.createElement("button");
	unload.type = "button";
	unload.className = "gjj-clip-prompt-btn";
	unload.title = "翻译完成后是否卸载 Opus-MT 模型";
	unload.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setValue(node, FIELD.unload, !toBool(getValue(node, FIELD.unload, false)));
		syncDomFromWidgets(node);
	});
	protect(unload);

	const status = document.createElement("span");
	status.className = "gjj-clip-prompt-status";

	toolbar.append(zero, translate, device, unload, status);

	const positiveLabel = document.createElement("div");
	positiveLabel.className = "gjj-clip-prompt-label";
	positiveLabel.textContent = "正面提示词";
	const positive = createTextarea(node, FIELD.positive, "输入正面提示词，可写中文后开启翻译");

	const negativeLabel = document.createElement("div");
	negativeLabel.className = "gjj-clip-prompt-label";
	negativeLabel.textContent = "负面提示词";
	const negative = createTextarea(node, FIELD.negative, "输入负面提示词，可写中文后开启翻译");

	container.append(style, toolbar, positiveLabel, positive, negativeLabel, negative);
	container.addEventListener("pointerdown", (event) => event.stopPropagation());
	container.addEventListener("mousedown", (event) => event.stopPropagation());
	container.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

	node.__gjjClipPromptContainer = container;
	node.__gjjClipPositiveLabel = positiveLabel;
	node.__gjjClipPositive = positive;
	node.__gjjClipNegativeLabel = negativeLabel;
	node.__gjjClipNegative = negative;
	node.__gjjClipZeroButton = zero;
	node.__gjjClipTranslateButton = translate;
	node.__gjjClipDevice = device;
	node.__gjjClipUnload = unload;
	node.__gjjClipStatus = status;

	syncDomFromWidgets(node);
	return container;
}

function ensureDom(node) {
	if (node.__gjjClipPromptWidget) return;
	const container = buildDom(node);
	const domWidget = node.addDOMWidget?.(DOM_WIDGET, "HTML", container, {
		serialize: false,
		hideOnZoom: false,
	});
	if (domWidget) {
		domWidget.computeSize = (width) => [Math.max(360, Number(width || node.size?.[0] || 460)), Math.max(120, Math.ceil(container.scrollHeight || 120))];
		node.__gjjClipPromptWidget = domWidget;
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
	if (!node) return;
	restoreValues(node);
	ensureDom(node);
	hideNativeWidgets(node);
	syncDomFromWidgets(node);
	refreshNode(node);
}

function schedule(node, ms = 0) {
	clearTimeout(node.__gjjClipPromptTimer);
	node.__gjjClipPromptTimer = setTimeout(() => stabilize(node), ms);
}

function applyBackendTranslation(detail) {
	const node = app.graph?._nodes?.find((item) => String(item?.id) === String(detail?.node));
	if (!node || !TARGET_NODES.has(String(node.comfyClass || node.type || "")) || !isTranslationEnabled(node)) return;
	if (typeof detail?.positive !== "string") return;
	const linked = getLinkedPositiveInfo(node);
	if (linked?.text) node.__gjjClipLastExternalSourceText = linked.text;
	node.__gjjClipPendingExternalSourceText = "";
	if (node.__gjjClipPositive) node.__gjjClipPositive.value = detail.positive;
	setValue(node, FIELD.positive, detail.positive);
	setStatus(node, "上游正向提示词已翻译回填");
	syncDomFromWidgets(node);
	refreshNode(node);
}

api.addEventListener(TRANSLATED_EVENT, (event) => applyBackendTranslation(event?.detail || {}));

app.registerExtension({
	name: "Comfy.GJJ.CLIPPromptEncodePanel",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (type, name, value, callback, options, ...rest) {
			const w = originalAddWidget?.apply(this, [type, name, value, callback, options, ...rest]);
			if (ALL_FIELDS.includes(name)) hideWidget(w);
			return w;
		};

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			schedule(this, 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			restoreValues(this, serializedNode);
			schedule(this, 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			saveValues(this, serializedNode);
			originalOnSerialize?.apply(this, [serializedNode]);
			saveValues(this, serializedNode);
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (!this.__gjjClipPromptSizing) refreshNode(this);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			schedule(this, 0);
			return result;
		};
	},

	nodeCreated(node) {
		if (TARGET_NODES.has(node?.comfyClass)) schedule(node, 0);
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) stabilize(node);
		}
	},
});
