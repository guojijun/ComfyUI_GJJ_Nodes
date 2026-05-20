import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_CLIPPromptEncodePanel"]);
const TRANSLATE_API = "/gjj/clip_prompt_translate";

const FIELD = {
	positive: "positive_text",
	negative: "negative_text",
	zero: "zero_conditioning",
	device: "translation_device",
	unload: "translation_unload_after_use",
};

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
	if (node.__gjjClipPositive && node.__gjjClipPositive.value !== String(getValue(node, FIELD.positive, ""))) {
		node.__gjjClipPositive.value = String(getValue(node, FIELD.positive, ""));
	}
	if (node.__gjjClipNegative && node.__gjjClipNegative.value !== String(getValue(node, FIELD.negative, ""))) {
		node.__gjjClipNegative.value = String(getValue(node, FIELD.negative, ""));
	}
	const zero = Boolean(getValue(node, FIELD.zero, false));
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
		const unload = Boolean(getValue(node, FIELD.unload, false));
		node.__gjjClipUnload.dataset.value = unload ? "true" : "false";
		node.__gjjClipUnload.textContent = unload ? "✅ 卸载" : "⬜ 卸载";
	}
}

async function translatePrompts(node) {
	const positive = String(node.__gjjClipPositive?.value ?? "");
	const negative = String(node.__gjjClipNegative?.value ?? "");
	const device = String(getValue(node, FIELD.device, "auto") || "auto");
	const unload = Boolean(getValue(node, FIELD.unload, false));

	if (!positive.trim() && !negative.trim()) {
		setStatus(node, "没有需要翻译的内容");
		return;
	}

	setStatus(node, "正在翻译...");
	if (node.__gjjClipTranslateButton) node.__gjjClipTranslateButton.disabled = true;

	try {
		const response = await fetch(TRANSLATE_API, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				positive,
				negative,
				device,
				max_length: 512,
				batch_size: 8,
				unload_after_use: unload,
			}),
		});
		const data = await response.json();
		if (!response.ok || !data?.ok) {
			throw new Error(data?.error || `HTTP ${response.status}`);
		}
		node.__gjjClipPositive.value = String(data.positive ?? "");
		node.__gjjClipNegative.value = String(data.negative ?? "");
		setValue(node, FIELD.positive, node.__gjjClipPositive.value);
		setValue(node, FIELD.negative, node.__gjjClipNegative.value);
		setStatus(node, "翻译完成");
		refreshNode(node);
	} catch (error) {
		console.error("[GJJ CLIP Prompt Encode] 翻译失败", error);
		setStatus(node, `翻译失败：${error?.message || error}`);
	} finally {
		if (node.__gjjClipTranslateButton) node.__gjjClipTranslateButton.disabled = false;
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
		setValue(node, FIELD.zero, !Boolean(getValue(node, FIELD.zero, false)));
		syncDomFromWidgets(node);
		refreshNode(node);
	});
	protect(zero);

	const translate = document.createElement("button");
	translate.type = "button";
	translate.className = "gjj-clip-prompt-btn";
	translate.textContent = "🌐 翻译";
	translate.title = "使用 GJJ_OpusMTZhEnTranslation / Opus-MT zh-en 接口把正负提示词翻译为英文";
	translate.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		translatePrompts(node);
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
		setValue(node, FIELD.unload, !Boolean(getValue(node, FIELD.unload, false)));
		syncDomFromWidgets(node);
	});
	protect(unload);

	const status = document.createElement("span");
	status.className = "gjj-clip-prompt-status";

	toolbar.append(zero, translate, device, unload, status);

	const positiveLabel = document.createElement("div");
	positiveLabel.className = "gjj-clip-prompt-label";
	positiveLabel.textContent = "正面提示词";
	const positive = createTextarea(node, FIELD.positive, "输入正面提示词，可写中文后点击翻译");

	const negativeLabel = document.createElement("div");
	negativeLabel.className = "gjj-clip-prompt-label";
	negativeLabel.textContent = "负面提示词";
	const negative = createTextarea(node, FIELD.negative, "输入负面提示词，可写中文后点击翻译");

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
