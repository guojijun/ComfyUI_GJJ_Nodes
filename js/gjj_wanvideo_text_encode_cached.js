import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { requestPromptTranslation } from "./gjj_common_prompt_translation.js";

const TARGET_NODES = new Set(["GJJ_WanVideoTextEncodeCached"]);
const TRANSLATED_EVENT = "gjj_wanvideo_text_prompt_translated";
const NODE_DISPLAY_NAME = "GJJ · 📝 WanVideo 文本编码（缓存版）";
const DOM_WIDGET = "gjj_wanvideo_text_encode_buttons";

const FIELD = {
	positive: "positive_prompt",
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

function getValue(node, name, fallback = "") {
	const widget = getWidget(node, name);
	return widget ? widget.value : fallback;
}

function setValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) return;
	let next = value;
	if (typeof widget.value === "boolean") next = toBool(value);
	widget.value = next;
	widget.callback?.(next);
	if (widget.inputEl && "value" in widget.inputEl) widget.inputEl.value = next;
	if (widget.element && "value" in widget.element) widget.element.value = next;
	node.properties = node.properties || {};
	node.properties[`gjj_wan_text_value_${name}`] = next;
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
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

function hideWidget(widget) {
	if (!widget) return;
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

function hideControlWidgets(node) {
	for (const name of HIDDEN_FIELDS) hideWidget(getWidget(node, name));
}

function protect(element) {
	if (!element || element.__gjjWanTextProtected) return;
	element.__gjjWanTextProtected = true;
	for (const eventName of ["pointerdown", "mousedown", "dblclick", "wheel", "contextmenu"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
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
			: "开启后负向嵌入会按正向结构零化。";
	}
	if (node.__gjjWanTextTranslateButton) {
		const enabled = toBool(getValue(node, FIELD.translationEnabled, false));
		node.__gjjWanTextTranslateButton.dataset.value = enabled ? "true" : "false";
		node.__gjjWanTextTranslateButton.textContent = enabled ? "✅ 翻译开" : "⬜ 翻译关";
		node.__gjjWanTextTranslateButton.disabled = Boolean(node.__gjjWanTextTranslating);
	}
	if (node.__gjjWanTextTranslationDevice) {
		node.__gjjWanTextTranslationDevice.value = String(getValue(node, FIELD.translationDevice, "auto") || "auto");
	}
	if (node.__gjjWanTextTranslationUnload) {
		const unload = toBool(getValue(node, FIELD.translationUnload, false));
		node.__gjjWanTextTranslationUnload.dataset.value = unload ? "true" : "false";
		node.__gjjWanTextTranslationUnload.textContent = unload ? "✅ 译后卸载" : "⬜ 译后卸载";
	}
	if (node.__gjjWanTextDeviceButton) {
		const device = String(getValue(node, FIELD.device, "gpu") || "gpu");
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
}

async function translatePositive(node) {
	if (node.__gjjWanTextTranslating) return;
	const positive = String(getValue(node, FIELD.positive, "") || "");
	if (!positive.trim()) {
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
			negative: "",
			device: String(getValue(node, FIELD.translationDevice, "auto") || "auto"),
			maxLength: 512,
			batchSize: 8,
			unloadAfterUse: toBool(getValue(node, FIELD.translationUnload, false)),
			nodeName: NODE_DISPLAY_NAME,
		});
		const translatedPositive = String(data.positive ?? data.text ?? "");
		setValue(node, FIELD.positive, translatedPositive);
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
		.gjj-wan-text-row.translate { grid-template-columns:repeat(4,minmax(0,1fr)); }
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
		updateButtons(node);
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
	translateRow.append(zero, translate, translationDevice, translationUnload);

	const encodeRow = document.createElement("div");
	encodeRow.className = "gjj-wan-text-row";
	const deviceButton = createButton("🖥️ 编码GPU", "切换文本编码设备：GPU 更快，CPU 更省显存。", () => {
		const next = String(getValue(node, FIELD.device, "gpu")) === "gpu" ? "cpu" : "gpu";
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
		if (value !== undefined) setValue(node, name, value);
	}
}

function stabilize(node) {
	if (!node) return;
	restoreValues(node);
	ensureDom(node);
	hideControlWidgets(node);
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
	updateButtons(node);
	refreshNode(node);
}

api.addEventListener(TRANSLATED_EVENT, (event) => applyBackendTranslation(event?.detail || {}));

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
			serializedNode.properties = serializedNode.properties || {};
			for (const name of HIDDEN_FIELDS) {
				serializedNode.properties[`gjj_wan_text_value_${name}`] = getValue(this, name, "");
			}
			originalOnSerialize?.apply(this, [serializedNode]);
			serializedNode.properties = serializedNode.properties || {};
			for (const name of HIDDEN_FIELDS) {
				serializedNode.properties[`gjj_wan_text_value_${name}`] = getValue(this, name, "");
			}
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
