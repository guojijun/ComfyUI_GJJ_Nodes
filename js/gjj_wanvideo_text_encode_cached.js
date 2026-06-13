import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { requestPromptTranslation } from "./gjj_common_prompt_translation.js";

const TARGET_NODES = new Set(["GJJ_WanVideoTextEncodeCached"]);
const TRANSLATED_EVENT = "gjj_wanvideo_text_prompt_translated";
const NODE_DISPLAY_NAME = "GJJ · 📝 WanVideo 文本编码（缓存版）";
const DOM_WIDGET = "gjj_wanvideo_text_encode_buttons";
const POSITIVE_VARIABLE_PROPERTY = "gjj_wan_text_positive_variable";

const FIELD = {
	positive: "positive_prompt",
	negative: "negative_prompt",
	zero: "zero_conditioning",
	forceOffload: "force_offload",
	cache: "use_disk_cache",
	device: "device",
	translationDevice: "translation_device",
	translationUnload: "translation_unload_after_use",
	translationEnabled: "translation_enabled",
};

const HIDDEN_FIELDS = [
	FIELD.zero,
	FIELD.forceOffload,
	FIELD.cache,
	FIELD.device,
	FIELD.translationDevice,
	FIELD.translationUnload,
	FIELD.translationEnabled,
];

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function toBool(value) {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	return ["1", "true", "yes", "on", "开", "开启", "启用"].includes(String(value ?? "").trim().toLowerCase());
}

function normalizeEncodeDevice(value) {
	return String(value || "gpu").trim().toLowerCase() === "cpu" ? "cpu" : "gpu";
}

function normalizeTranslationDevice(value) {
	const device = String(value || "auto").trim().toLowerCase();
	return device === "cpu" || device === "gpu" ? device : "auto";
}

function normalizedValue(name, value) {
	if (name === FIELD.device) return normalizeEncodeDevice(value);
	if (name === FIELD.translationDevice) return normalizeTranslationDevice(value);
	return value;
}

function getValue(node, name, fallback = "") {
	const widget = getWidget(node, name);
	return widget ? widget.value : fallback;
}

function setValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) return;
	let next = normalizedValue(name, value);
	if (name !== FIELD.device && name !== FIELD.translationDevice && typeof widget.value === "boolean") {
		next = toBool(value);
	}
	widget.value = next;
	widget.callback?.(next);
	if (widget.inputEl && "value" in widget.inputEl) widget.inputEl.value = next;
	if (widget.element && "value" in widget.element) widget.element.value = next;
	node.properties = node.properties || {};
	node.properties[`gjj_wan_text_value_${name}`] = next;
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function variableProperty(field) {
	return POSITIVE_VARIABLE_PROPERTY;
}

function selectedVariable(node, field) {
	return String(node?.properties?.[variableProperty(field)] || "").trim();
}

function setSelectedVariable(node, field, name) {
	if (!node) return;
	node.properties = node.properties || {};
	const key = variableProperty(field);
	const value = String(name || "").trim();
	if (value) node.properties[key] = value;
	else delete node.properties[key];
	syncPositiveVariableWidget(node);
	updateVariableButtons(node);
	refreshNode(node);
}

function variableOptions(node) {
	const apiObject = globalThis.GJJ_VariableBroadcast;
	const graph = node?.graph || app.graph;
	return typeof apiObject?.getVisibleSetOptions === "function" ? (apiObject.getVisibleSetOptions(graph) || []) : [];
}

function variableOptionDisplay(option) {
	const value = String(option?.value || "").trim();
	const label = String(option?.label || value).trim();
	const match = label.match(/^[^()（）]+[（(]([^()（）]+?)[\s·]+([^()（）]+?)[）)]$/);
	if (match) return { title: match[2].trim() || value, source: match[1].trim(), value };
	return { title: label || value, source: "", value };
}

function collapseElement(element) {
	if (!element?.style) return;
	element.style.display = "none";
	element.style.pointerEvents = "none";
	element.style.height = "0px";
	element.style.minHeight = "0px";
	element.style.maxHeight = "0px";
	element.style.margin = "0";
	element.style.padding = "0";
	element.style.border = "0";
	element.style.overflow = "hidden";
}

function expandElement(element) {
	if (!element?.style) return;
	element.style.display = "";
	element.style.pointerEvents = "";
	element.style.height = "";
	element.style.minHeight = "";
	element.style.maxHeight = "";
	element.style.margin = "";
	element.style.padding = "";
	element.style.border = "";
	element.style.overflow = "";
}

function hideWidget(widget) {
	if (!widget) return;
	if (!widget.__gjjWanTextOriginal) {
		widget.__gjjWanTextOriginal = {
			type: widget.type,
			label: widget.label,
			computeSize: widget.computeSize,
			getHeight: widget.getHeight,
			draw: widget.draw,
			y: widget.y,
			last_y: widget.last_y,
			hidden: widget.hidden,
			optionsHidden: widget.options?.hidden,
			optionsDisplay: widget.options?.display,
		};
	}
	widget.hidden = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.label = "";
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.y = 0;
	widget.last_y = 0;
	widget.serialize = true;
	widget.options = widget.options || {};
	widget.options.hidden = true;
	widget.options.display = "hidden";
	collapseElement(widget.inputEl);
	collapseElement(widget.element);
	collapseElement(widget.widget);
}

function showWidget(widget) {
	if (!widget) return;
	const original = widget.__gjjWanTextOriginal || {};
	widget.hidden = false;
	widget.type = original.type || (String(widget.type || "").replace(/^converted-widget:/, "") || "text");
	widget.label = original.label || widget.options?.display_name || widget.name || "";
	if (original.computeSize) widget.computeSize = original.computeSize;
	else delete widget.computeSize;
	if (original.getHeight) widget.getHeight = original.getHeight;
	else delete widget.getHeight;
	if (original.draw) widget.draw = original.draw;
	else delete widget.draw;
	if (original.y !== undefined) widget.y = original.y;
	if (original.last_y !== undefined) widget.last_y = original.last_y;
	widget.serialize = true;
	widget.options = widget.options || {};
	if (original.optionsHidden === undefined) delete widget.options.hidden;
	else widget.options.hidden = original.optionsHidden;
	if (original.optionsDisplay === undefined) delete widget.options.display;
	else widget.options.display = original.optionsDisplay;
	expandElement(widget.inputEl);
	expandElement(widget.element);
	expandElement(widget.widget);
}

function hideControlWidgets(node) {
	for (const name of HIDDEN_FIELDS) hideWidget(getWidget(node, name));
}

function updateNegativeVisibility(node) {
	const widget = getWidget(node, FIELD.negative);
	if (!widget) return;
	if (toBool(getValue(node, FIELD.zero, false))) hideWidget(widget);
	else showWidget(widget);
}

function syncPositiveVariableWidget(node) {
	const widget = getWidget(node, FIELD.positive);
	if (!widget) return;
	const selected = Boolean(selectedVariable(node, FIELD.positive));
	const placeholder = selected ? "已选择正向提示词变量，执行时从变量读取" : "";
	if (selected && String(widget.value || "")) {
		widget.value = "";
		if (widget.inputEl && "value" in widget.inputEl) widget.inputEl.value = "";
		if (widget.element && "value" in widget.element) widget.element.value = "";
	}
	widget.disabled = selected;
	widget.readOnly = selected;
	widget.options = widget.options || {};
	widget.options.placeholder = placeholder;
	for (const element of [widget.inputEl, widget.element, widget.widget]) {
		if (!element) continue;
		if ("disabled" in element) element.disabled = selected;
		if ("readOnly" in element) element.readOnly = selected;
		if ("placeholder" in element) element.placeholder = placeholder;
		if (element.style) {
			element.style.opacity = selected ? "0.72" : "";
			element.style.cursor = selected ? "not-allowed" : "";
		}
	}
}

function normalizeHiddenWidgetValues(node) {
	for (const name of [FIELD.device, FIELD.translationDevice]) {
		const widget = getWidget(node, name);
		if (!widget) continue;
		setValue(node, name, normalizedValue(name, widget.value));
	}
}

function protect(element) {
	if (!element || element.__gjjWanTextProtected) return;
	element.__gjjWanTextProtected = true;
	for (const eventName of ["pointerdown", "mousedown", "dblclick", "wheel", "contextmenu"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
}

function updateVariableButton(node, field, button) {
	if (!button) return;
	const name = selectedVariable(node, field);
	const option = variableOptions(node).find((item) => item.value === name);
	const display = variableOptionDisplay(option || { value: name, label: name });
	button.dataset.value = name ? "true" : "false";
	button.textContent = "⚡";
	button.title = name
		? `正向提示词变量：${display.title || name}\n来源：${display.source || "变量"}\n手动连接正向提示词输入口时，手动连线优先。`
		: "从 GJJ_TemplateParams 或 GJJ_SetNode 选择正向提示词变量";
	button.setAttribute("aria-pressed", name ? "true" : "false");
}

function updateVariableButtons(node) {
	updateVariableButton(node, FIELD.positive, node?.__gjjWanTextPositiveVariableButton);
}

function closeVariablePicker(node) {
	node?.__gjjWanTextVariablePicker?.remove?.();
	node.__gjjWanTextVariablePicker = null;
}

function openVariablePicker(node, field) {
	closeVariablePicker(node);
	const options = variableOptions(node);
	const current = selectedVariable(node, field);
	const label = "正向";
	const popup = document.createElement("div");
	popup.style.cssText = [
		"position:fixed",
		"z-index:10050",
		"width:min(440px,calc(100vw - 28px))",
		"max-height:min(520px,calc(100vh - 40px))",
		"overflow:hidden",
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"padding:10px",
		"border:1px solid #486575",
		"border-radius:8px",
		"background:#08151a",
		"box-shadow:0 18px 46px rgba(0,0,0,.55)",
		"color:#dce7e2",
		"font:12px system-ui,'Microsoft YaHei',sans-serif",
	].join(";");
	const sourceButton = node.__gjjWanTextPositiveVariableButton;
	const rect = sourceButton?.getBoundingClientRect?.() || { left: 24, bottom: 80 };
	popup.style.left = `${Math.round(Math.max(12, Math.min(window.innerWidth - 460, rect.left || 24)))}px`;
	popup.style.top = `${Math.round(Math.max(12, Math.min(window.innerHeight - 540, (rect.bottom || 80) + 6)))}px`;

	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;gap:8px;";
	const title = document.createElement("div");
	title.textContent = `⚡ 选择${label}提示词变量`;
	title.style.cssText = "font-weight:800;flex:1 1 auto;";
	const clear = document.createElement("button");
	clear.type = "button";
	clear.textContent = "清空";
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "关闭";
	for (const button of [clear, close]) {
		button.style.cssText = "height:28px;border:1px solid #44565f;border-radius:7px;background:#202b31;color:#dce7e2;cursor:pointer;padding:0 8px;font-size:12px;font-weight:650;";
		protect(button);
	}
	header.append(title, clear, close);
	popup.appendChild(header);

	const search = document.createElement("input");
	search.placeholder = "搜索变量，点击选择";
	search.style.cssText = "height:30px;border:1px solid #3f5b66;border-radius:7px;background:#071015;color:#dce7e2;padding:0 10px;outline:none;";
	popup.appendChild(search);
	const list = document.createElement("div");
	list.style.cssText = "overflow:auto;display:flex;flex-direction:column;gap:5px;max-height:360px;padding-right:2px;";
	popup.appendChild(list);

	function render() {
		const needle = String(search.value || "").trim().toLowerCase();
		list.textContent = "";
		for (const option of options) {
			const parts = variableOptionDisplay(option);
			if (!parts.value) continue;
			if (needle && !`${parts.title} ${parts.source} ${parts.value} ${option.label || ""}`.toLowerCase().includes(needle)) continue;
			const item = document.createElement("button");
			item.type = "button";
			item.style.cssText = [
				"display:flex",
				"align-items:center",
				"gap:8px",
				"text-align:left",
				"border:0",
				"border-radius:7px",
				"padding:8px 10px",
				"background:" + (current === parts.value ? "#234a37" : "transparent"),
				"color:#dce7e2",
				"cursor:pointer",
			].join(";");
			const mark = document.createElement("span");
			mark.textContent = current === parts.value ? "✓" : "";
			mark.style.cssText = "width:16px;color:#7de39b;font-weight:900;";
			const text = document.createElement("span");
			text.innerHTML = `<b>${parts.title}</b><br><span style="color:#8fa3ad">${parts.source ? `${parts.source} · ` : ""}${parts.value}</span>`;
			item.append(mark, text);
			item.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
			item.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				setSelectedVariable(node, field, parts.value);
				closeVariablePicker(node);
			});
			list.appendChild(item);
		}
		if (!list.children.length) {
			const empty = document.createElement("div");
			empty.textContent = options.length ? "没有匹配的变量" : "当前工作流没有可选变量";
			empty.style.cssText = "padding:14px 10px;color:#9aaab2;text-align:center;";
			list.appendChild(empty);
		}
	}
	clear.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setSelectedVariable(node, field, "");
		closeVariablePicker(node);
	});
	close.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		closeVariablePicker(node);
	});
	search.addEventListener("input", render);
	protect(search);
	protect(popup);
	document.body.appendChild(popup);
	node.__gjjWanTextVariablePicker = popup;
	render();
	setTimeout(() => search.focus(), 0);
}

function refreshNode(node) {
	if (!node) return;
	const width = Math.max(360, Number(node.size?.[0] || 420));
	const height = Math.max(120, Number(node.computeSize?.()[1] || node.size?.[1] || 120));
	node.size = [width, height];
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function setStatus(node, text) {
	if (!node.__gjjWanTextStatus) return;
	node.__gjjWanTextStatus.textContent = String(text || "");
	clearTimeout(node.__gjjWanTextStatusTimer);
	if (text) {
		node.__gjjWanTextStatusTimer = setTimeout(() => {
			if (node.__gjjWanTextStatus) node.__gjjWanTextStatus.textContent = "";
		}, 3500);
	}
}

function updateButtons(node) {
	if (node.__gjjWanTextZeroButton) {
		const zero = toBool(getValue(node, FIELD.zero, false));
		node.__gjjWanTextZeroButton.dataset.value = zero ? "true" : "false";
		node.__gjjWanTextZeroButton.textContent = zero ? "✅ 条件零化" : "⬜ 条件零化";
		node.__gjjWanTextZeroButton.title = zero
			? "已开启：正向正常编码，负向嵌入按正向结构生成全零张量。"
			: "当前会显示并编码负向提示词；开启后隐藏负向提示词并按正向结构零化。";
	}
	if (node.__gjjWanTextTranslateButton) {
		const enabled = toBool(getValue(node, FIELD.translationEnabled, false));
		node.__gjjWanTextTranslateButton.dataset.value = enabled ? "true" : "false";
		node.__gjjWanTextTranslateButton.textContent = enabled ? "✅ 翻译开" : "⬜ 翻译关";
		node.__gjjWanTextTranslateButton.disabled = Boolean(node.__gjjWanTextTranslating);
	}
	if (node.__gjjWanTextTranslationDevice) {
		node.__gjjWanTextTranslationDevice.value = normalizeTranslationDevice(getValue(node, FIELD.translationDevice, "auto"));
	}
	if (node.__gjjWanTextTranslationUnload) {
		const unload = toBool(getValue(node, FIELD.translationUnload, false));
		node.__gjjWanTextTranslationUnload.dataset.value = unload ? "true" : "false";
		node.__gjjWanTextTranslationUnload.textContent = unload ? "✅ 译后卸载" : "⬜ 译后卸载";
	}
	if (node.__gjjWanTextDeviceButton) {
		const device = normalizeEncodeDevice(getValue(node, FIELD.device, "gpu"));
		node.__gjjWanTextDeviceButton.dataset.value = device;
		node.__gjjWanTextDeviceButton.textContent = device === "cpu" ? "🧮 编码CPU" : "🖥️ 编码GPU";
	}
	if (node.__gjjWanTextOffloadButton) {
		const offload = toBool(getValue(node, FIELD.forceOffload, false));
		node.__gjjWanTextOffloadButton.dataset.value = offload ? "true" : "false";
		node.__gjjWanTextOffloadButton.textContent = offload ? "✅ 卸载T5" : "📌 T5常驻";
	}
	if (node.__gjjWanTextCacheButton) {
		const cache = toBool(getValue(node, FIELD.cache, true));
		node.__gjjWanTextCacheButton.dataset.value = cache ? "true" : "false";
		node.__gjjWanTextCacheButton.textContent = cache ? "✅ 磁盘缓存" : "⬜ 磁盘缓存";
	}
	updateVariableButtons(node);
}

async function translatePositive(node) {
	if (node.__gjjWanTextTranslating) return;
	const positive = String(getValue(node, FIELD.positive, "") || "");
	const negative = String(getValue(node, FIELD.negative, "") || "");
	if (!positive.trim() && !negative.trim()) {
		setStatus(node, "没有需要翻译的内容");
		return;
	}
	node.__gjjWanTextTranslating = true;
	updateButtons(node);
	setStatus(node, "正在翻译...");
	try {
		const data = await requestPromptTranslation({
			node,
			positive,
			negative,
			device: normalizeTranslationDevice(getValue(node, FIELD.translationDevice, "auto")),
			maxLength: 512,
			batchSize: 8,
			unloadAfterUse: toBool(getValue(node, FIELD.translationUnload, false)),
			nodeName: NODE_DISPLAY_NAME,
		});
		const translatedPositive = String(data.positive ?? data.text ?? "");
		const translatedNegative = String(data.negative ?? "");
		setValue(node, FIELD.positive, translatedPositive);
		if (translatedNegative || negative) setValue(node, FIELD.negative, translatedNegative);
		setStatus(node, "翻译完成");
	} catch (error) {
		console.error("[GJJ WanVideo Text Encode] 翻译失败", error);
		setStatus(node, `翻译失败：${error?.message || error}`);
	} finally {
		node.__gjjWanTextTranslating = false;
		updateButtons(node);
		refreshNode(node);
	}
}

function createButton(text, title, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "gjj-wan-text-btn";
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

function buildDom(node) {
	const container = document.createElement("div");
	container.className = "gjj-wan-text-buttons";

	const style = document.createElement("style");
	style.textContent = `
		.gjj-wan-text-buttons * { box-sizing:border-box; }
		.gjj-wan-text-buttons { display:flex; flex-direction:column; gap:6px; width:100%; padding:0 0 4px; }
		.gjj-wan-text-row { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; min-width:0; }
		.gjj-wan-text-row.translate { grid-template-columns:repeat(5,minmax(0,1fr)); }
		.gjj-wan-text-btn, .gjj-wan-text-select {
			height:28px; min-width:0; border:1px solid #3d515a; border-radius:7px; background:#202a30; color:#dce7e2;
			padding:3px 7px; font-size:12px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
		}
		.gjj-wan-text-btn:hover { background:#2a3941; }
		.gjj-wan-text-btn[data-value="true"], .gjj-wan-text-btn[data-value="gpu"] { border-color:#4f8f7a; background:#20362f; color:#dff8ea; }
		.gjj-wan-text-btn[data-value="cpu"] { border-color:#697066; background:#313528; color:#f0ebcf; }
		.gjj-wan-text-btn:disabled { opacity:.55; cursor:default; }
		.gjj-wan-text-status { color:#8ea0a8; font-size:11px; min-height:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	`;

	const translateRow = document.createElement("div");
	translateRow.className = "gjj-wan-text-row translate";
	const zero = createButton("⬜ 条件零化", "开启后负向嵌入按正向结构全零。", () => {
		setValue(node, FIELD.zero, !toBool(getValue(node, FIELD.zero, false)));
		updateNegativeVisibility(node);
		updateButtons(node);
		refreshNode(node);
	});
	const translate = createButton("⬜ 翻译关", "点击切换翻译开关，并立即翻译当前正向提示词。", () => {
		const next = !toBool(getValue(node, FIELD.translationEnabled, false));
		setValue(node, FIELD.translationEnabled, next);
		updateButtons(node);
		if (next) translatePositive(node);
		else setStatus(node, "翻译已关闭");
	});
	const translationDevice = document.createElement("select");
	translationDevice.className = "gjj-wan-text-select";
	for (const value of ["auto", "cpu", "gpu"]) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value;
		translationDevice.appendChild(option);
	}
	translationDevice.title = "翻译设备";
	translationDevice.addEventListener("change", () => setValue(node, FIELD.translationDevice, translationDevice.value));
	protect(translationDevice);
	const translationUnload = createButton("⬜ 译后卸载", "翻译完成后是否卸载 Opus-MT 模型。", () => {
		setValue(node, FIELD.translationUnload, !toBool(getValue(node, FIELD.translationUnload, false)));
		updateButtons(node);
	});
	const positiveVariable = createButton("⚡", "从 GJJ_TemplateParams 选择正向提示词变量。", () => openVariablePicker(node, FIELD.positive));
	translateRow.append(zero, translate, positiveVariable, translationDevice, translationUnload);

	const encodeRow = document.createElement("div");
	encodeRow.className = "gjj-wan-text-row";
	const deviceButton = createButton("🖥️ 编码GPU", "切换文本编码设备：GPU 更快，CPU 更省显存。", () => {
		const next = normalizeEncodeDevice(getValue(node, FIELD.device, "gpu")) === "gpu" ? "cpu" : "gpu";
		setValue(node, FIELD.device, next);
		updateButtons(node);
	});
	const offloadButton = createButton("📌 T5常驻", "切换编码后是否卸载 T5。", () => {
		setValue(node, FIELD.forceOffload, !toBool(getValue(node, FIELD.forceOffload, false)));
		updateButtons(node);
	});
	const cacheButton = createButton("✅ 磁盘缓存", "切换文本嵌入磁盘缓存。", () => {
		setValue(node, FIELD.cache, !toBool(getValue(node, FIELD.cache, true)));
		updateButtons(node);
	});
	encodeRow.append(deviceButton, offloadButton, cacheButton);

	const status = document.createElement("div");
	status.className = "gjj-wan-text-status";

	container.append(style, translateRow, encodeRow, status);
	container.addEventListener("pointerdown", (event) => event.stopPropagation());
	container.addEventListener("mousedown", (event) => event.stopPropagation());
	container.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

	node.__gjjWanTextTranslateButton = translate;
	node.__gjjWanTextZeroButton = zero;
	node.__gjjWanTextPositiveVariableButton = positiveVariable;
	node.__gjjWanTextTranslationDevice = translationDevice;
	node.__gjjWanTextTranslationUnload = translationUnload;
	node.__gjjWanTextDeviceButton = deviceButton;
	node.__gjjWanTextOffloadButton = offloadButton;
	node.__gjjWanTextCacheButton = cacheButton;
	node.__gjjWanTextStatus = status;
	updateButtons(node);
	return container;
}

function ensureDom(node) {
	if (node.__gjjWanTextWidget) return;
	const container = buildDom(node);
	const widget = node.addDOMWidget?.(DOM_WIDGET, "HTML", container, {
		serialize: false,
		hideOnZoom: false,
	});
	if (!widget) return;
	widget.computeSize = (width) => [Math.max(360, Number(width || node.size?.[0] || 420)), Math.max(70, Math.ceil(container.scrollHeight || 70))];
	widget.getHeight = () => Math.max(70, Math.ceil(container.scrollHeight || 70));
	node.__gjjWanTextWidget = widget;
	if (Array.isArray(node.widgets)) {
		const index = node.widgets.indexOf(widget);
		if (index > 0) {
			node.widgets.splice(index, 1);
			node.widgets.unshift(widget);
		}
	}
}

function restoreValues(node, serializedNode = null) {
	const props = serializedNode?.properties || node.properties || {};
	for (const name of HIDDEN_FIELDS) {
		const value = props[`gjj_wan_text_value_${name}`];
		if (value !== undefined) setValue(node, name, normalizedValue(name, value));
	}
	for (const key of [POSITIVE_VARIABLE_PROPERTY]) {
		if (props[key] !== undefined) {
			node.properties = node.properties || {};
			const value = String(props[key] || "").trim();
			if (value) node.properties[key] = value;
			else delete node.properties[key];
		}
	}
}

function stabilize(node) {
	if (!node) return;
	restoreValues(node);
	normalizeHiddenWidgetValues(node);
	ensureDom(node);
	hideControlWidgets(node);
	updateNegativeVisibility(node);
	syncPositiveVariableWidget(node);
	updateButtons(node);
	refreshNode(node);
}

function schedule(node, ms = 0) {
	clearTimeout(node.__gjjWanTextTimer);
	node.__gjjWanTextTimer = setTimeout(() => stabilize(node), ms);
}

function applyBackendTranslation(detail) {
	const node = app.graph?._nodes?.find((item) => String(item?.id) === String(detail?.node));
	if (!node || !TARGET_NODES.has(String(node.comfyClass || node.type || ""))) return;
	if (typeof detail?.positive === "string") {
		setValue(node, FIELD.positive, detail.positive);
		setStatus(node, "正向提示词已翻译回填");
	}
	if (typeof detail?.negative === "string") {
		setValue(node, FIELD.negative, detail.negative);
		setStatus(node, "提示词已翻译回填");
	}
	updateNegativeVisibility(node);
	updateButtons(node);
	refreshNode(node);
}

api.addEventListener(TRANSLATED_EVENT, (event) => applyBackendTranslation(event?.detail || {}));

function findWanTextNodeForPromptId(graph, promptId) {
	const id = String(promptId || "");
	const nodes = graph?._nodes || [];
	const parts = id.split(":").filter(Boolean);
	const tail = parts.length ? parts[parts.length - 1] : id;
	return nodes.find((node) => String(node?.id) === id)
		|| nodes.find((node) => String(node?.id) === tail);
}

function resolveSelectedVariable(node, field) {
	const name = selectedVariable(node, field);
	const resolver = globalThis.GJJ_VariableBroadcast?.resolveVariableBroadcastSource;
	if (!name || typeof resolver !== "function") return null;
	return resolver(node?.graph || app.graph, name);
}

function patchWanTextVariablePrompt(promptResult, graph) {
	const output = promptResult?.output;
	if (!output) return promptResult;
	for (const [nodeId, nodeInfo] of Object.entries(output)) {
		const node = findWanTextNodeForPromptId(graph, nodeId);
		if (!node || !TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) continue;
		nodeInfo.inputs = nodeInfo.inputs || {};
		if (!selectedVariable(node, FIELD.positive)) continue;
		const resolved = resolveSelectedVariable(node, FIELD.positive);
		if (!Array.isArray(resolved) || resolved.length !== 2 || String(resolved[0]) === String(node.id)) continue;
		nodeInfo.inputs[FIELD.positive] = [String(resolved[0]), Number(resolved[1] || 0)];
	}
	return promptResult;
}

function installVariablePromptPatch() {
	if (!api.__gjjWanTextVariableQueuePatchInstalled && typeof api.queuePrompt === "function") {
		api.__gjjWanTextVariableQueuePatchInstalled = true;
		const originalQueuePrompt = api.queuePrompt.bind(api);
		api.queuePrompt = async function (...args) {
			patchWanTextVariablePrompt(args[1], app.rootGraph || app.graph);
			return originalQueuePrompt(...args);
		};
	}
}

app.registerExtension({
	name: "Comfy.GJJ.WanVideoTextEncodeCachedButtons",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) return;

		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (type, name, value, callback, options, ...rest) {
			const widget = originalAddWidget?.apply(this, [type, name, value, callback, options, ...rest]);
			if (HIDDEN_FIELDS.includes(name)) hideWidget(widget);
			return widget;
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
			normalizeHiddenWidgetValues(this);
			serializedNode.properties = serializedNode.properties || {};
			for (const name of HIDDEN_FIELDS) {
				serializedNode.properties[`gjj_wan_text_value_${name}`] = normalizedValue(name, getValue(this, name, ""));
			}
			for (const key of [POSITIVE_VARIABLE_PROPERTY]) {
				const value = String(this.properties?.[key] || "").trim();
				if (value) serializedNode.properties[key] = value;
				else delete serializedNode.properties[key];
			}
			originalOnSerialize?.apply(this, [serializedNode]);
			normalizeHiddenWidgetValues(this);
			serializedNode.properties = serializedNode.properties || {};
			for (const name of HIDDEN_FIELDS) {
				serializedNode.properties[`gjj_wan_text_value_${name}`] = normalizedValue(name, getValue(this, name, ""));
			}
			for (const key of [POSITIVE_VARIABLE_PROPERTY]) {
				const value = String(this.properties?.[key] || "").trim();
				if (value) serializedNode.properties[key] = value;
				else delete serializedNode.properties[key];
			}
		};
	},

	nodeCreated(node) {
		if (TARGET_NODES.has(node?.comfyClass)) schedule(node, 0);
	},

	setup() {
		installVariablePromptPatch();
		if (!window.__gjjWanTextTemplateParamsListener) {
			window.__gjjWanTextTemplateParamsListener = true;
			window.addEventListener("gjj-template-params-updated", () => {
				for (const node of app.graph?._nodes || []) {
					if (TARGET_NODES.has(node?.comfyClass) && selectedVariable(node, FIELD.positive)) schedule(node, 80);
				}
			});
		}
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) stabilize(node);
		}
	},
});
