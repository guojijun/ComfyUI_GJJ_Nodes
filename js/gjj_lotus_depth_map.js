import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODE = "GJJ_LotusDepthMap";
const PANEL_WIDGET = "gjj_lotus_depth_controls_panel";
const MIN_WIDTH = 340;
const SETTINGS_PROP = "gjj_lotus_depth_settings_open";
const HIDDEN_WIDGETS = [
	"unet_name",
	"vae_name",
	"weight_dtype",
	"sampler_name",
	"scheduler",
	"steps",
	"denoise",
	"first_sigma",
	"invert_depth",
	"keep_size",
];
const SETTING_FIELDS = [
	{ name: "unet_name", label: "Lotus模型", kind: "combo" },
	{ name: "vae_name", label: "VAE模型", kind: "combo" },
	{ name: "weight_dtype", label: "UNET精度", kind: "combo" },
	{ name: "sampler_name", label: "采样器", kind: "combo" },
	{ name: "scheduler", label: "调度器", kind: "combo" },
	{ name: "steps", label: "步数", kind: "number", min: 1, max: 10000, step: 1 },
	{ name: "denoise", label: "降噪", kind: "number", min: 0.0001, max: 1, step: 0.01 },
	{ name: "first_sigma", label: "首个Sigma", kind: "number", min: 0, max: 20000, step: 0.001 },
];

function getWidget(node, name) {
	return node?.widgets?.find((item) => item?.name === name);
}

function widgetValue(node, name, fallback = "") {
	const widget = getWidget(node, name);
	return String(widget?.value ?? fallback ?? "");
}

function boolWidgetValue(node, name, fallback = false) {
	const value = getWidget(node, name)?.value;
	if (typeof value === "string") return ["1", "true", "yes", "on", "开启", "启用", "是"].includes(value.trim().toLowerCase());
	if (value == null) return Boolean(fallback);
	return Boolean(value);
}

function comboValues(widget) {
	const raw = widget?.options?.values || widget?.options?.comboValues || widget?.values || [];
	const values = Array.isArray(raw) ? raw.map((item) => String(item?.value ?? item?.name ?? item?.label ?? item ?? "").trim()).filter(Boolean) : [];
	const current = String(widget?.value ?? "").trim();
	return current && !values.includes(current) ? [current, ...values] : values;
}

function coerceWidgetValue(widget, value) {
	if (typeof widget?.value === "number") {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : widget.value;
	}
	if (typeof widget?.value === "boolean") {
		return value === true || String(value).toLowerCase() === "true";
	}
	return String(value ?? "");
}

function setWidgetValue(node, name, value, trigger = true) {
	const widget = getWidget(node, name);
	if (!widget) return;
	const next = coerceWidgetValue(widget, value);
	if (widget.value === next) return;
	widget.value = next;
	if (widget.inputEl) widget.inputEl.value = String(next);
	if (widget.element && "value" in widget.element) widget.element.value = next;
	if (trigger) widget.callback?.(next);
	syncPanel(node);
	refreshNode(node);
}

function safeAssign(widget, key, value) {
	try { widget[key] = value; } catch (_) {}
}

function collapseWidget(widget) {
	if (!widget || widget.__gjjLotusDepthCollapsed) return;
	widget.__gjjLotusDepthCollapsed = true;
	safeAssign(widget, "hidden", true);
	safeAssign(widget, "label", "");
	safeAssign(widget, "size", [0, -4]);
	safeAssign(widget, "height", -4);
	safeAssign(widget, "serialize", true);
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => -4;
	widget.draw = () => {};
	if (widget.options && typeof widget.options === "object") {
		widget.options.hidden = true;
		widget.options.display = "hidden";
	}
}

function collapseNativeWidgets(node) {
	for (const name of HIDDEN_WIDGETS) collapseWidget(getWidget(node, name));
}

function mediaUrl(item) {
	if (!item?.filename) return "";
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = `&rand=${Date.now()}`;
	return `/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "temp")}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`;
}

function flattenItems(value) {
	const result = [];
	const walk = (item) => {
		if (!item) return;
		if (Array.isArray(item)) {
			for (const child of item) walk(child);
			return;
		}
		if (typeof item === "object" && item.filename) result.push(item);
	};
	walk(value);
	return result;
}

function normalizeImages(message = {}) {
	return flattenItems(
		message.preview_items ||
		message.ui?.preview_items ||
		message.images ||
		message.preview_images ||
		message.ui?.images ||
		message.ui?.preview_images,
	);
}

function messageWithoutNativePreview(message = {}) {
	const clean = { ...(message || {}) };
	delete clean.images;
	delete clean.preview_images;
	delete clean.gifs;
	delete clean.animated;

	if (clean.ui && typeof clean.ui === "object") {
		clean.ui = { ...clean.ui };
		delete clean.ui.images;
		delete clean.ui.preview_images;
	}
	if (clean.output && typeof clean.output === "object") {
		clean.output = { ...clean.output };
		delete clean.output.images;
		delete clean.output.preview_images;
	}
	if (clean.results && typeof clean.results === "object") {
		clean.results = { ...clean.results };
		delete clean.results.images;
		delete clean.results.preview_images;
	}
	return clean;
}

function clearNativePreview(node) {
	if (!node) return;
	node.imgs = [];
	node.images = [];
	node.imageIndex = null;
	node.overIndex = null;
	node.animatedImages = [];
	node.preview = null;
	node.previews = null;
	if (node.properties) {
		delete node.properties.image;
		delete node.properties.images;
		delete node.properties.preview;
		delete node.properties.previews;
		delete node.properties.gifs;
		delete node.properties.animated;
	}
	app.graph?.setDirtyCanvas?.(true, true);
	refreshNode(node);
}

function normalizeText(value) {
	if (Array.isArray(value)) return value.map((item) => String(item || "")).filter(Boolean).join("\n");
	return String(value || "");
}

function refreshNode(node) {
	requestAnimationFrame(() => {
		GJJ_Utils.refreshNode(node, { preserveWidth: true, minWidth: MIN_WIDTH, minHeight: 80 });
	});
}

function ensureStyles() {
	if (document.getElementById("gjj-lotus-depth-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-lotus-depth-style";
	style.textContent = `
		.gjj-lotus-depth-panel{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:7px;padding:8px;border:1px solid #304954;border-radius:8px;background:#10191d;color:#dce8e5;font:12px/1.4 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;}
		.gjj-lotus-depth-toolbar{display:grid;grid-template-columns:1fr 1fr auto;gap:6px;align-items:center;}
		.gjj-lotus-depth-button{height:26px;padding:0 8px;border:1px solid #38545f;border-radius:6px;background:#26343a;color:#dce8e5;font:700 12px/1 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;cursor:pointer;white-space:nowrap;}
		.gjj-lotus-depth-button:hover{border-color:#5d8793;background:#30434a;}
		.gjj-lotus-depth-button.on{border-color:#54c985;background:#1f6040;color:#ecfff3;}
		.gjj-lotus-depth-settings{display:none;grid-template-columns:72px minmax(0,1fr);gap:6px 8px;align-items:center;padding-top:7px;border-top:1px solid #263b42;}
		.gjj-lotus-depth-settings.open{display:grid;}
		.gjj-lotus-depth-label{color:#aebfc5;font-size:12px;white-space:nowrap;}
		.gjj-lotus-depth-input{box-sizing:border-box;width:100%;min-width:0;height:26px;border:1px solid #314a54;border-radius:6px;background:#202b31;color:#e8f3ef;padding:0 8px;font:12px/1.2 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;}
		.gjj-lotus-depth-input:focus{outline:none;border-color:#5ab0c4;background:#22343c;}
		.gjj-lotus-depth-preview{display:flex;flex-direction:column;gap:7px;padding-top:7px;border-top:1px solid #263b42;}
		.gjj-lotus-depth-summary{color:#9fb1b5;white-space:pre-wrap;overflow-wrap:anywhere;}
		.gjj-lotus-depth-stage{display:block;}
		.gjj-lotus-depth-card{position:relative;min-height:120px;border:1px solid #2e424a;border-radius:7px;overflow:hidden;background:#071014;}
		.gjj-lotus-depth-card img{display:block;width:100%;max-height:310px;object-fit:contain;background:#05090c;cursor:zoom-in;}
		.gjj-lotus-depth-badge{position:absolute;left:6px;top:6px;padding:2px 6px;border-radius:999px;background:rgba(4,8,10,.62);color:#eef7f2;font-size:11px;text-shadow:0 1px 2px rgba(0,0,0,.4);}
		.gjj-lotus-depth-counter{position:absolute;right:7px;bottom:7px;padding:2px 6px;border-radius:999px;background:rgba(4,8,10,.66);color:#f0faf6;font-size:11px;font-weight:800;text-shadow:0 1px 2px rgba(0,0,0,.42);}
		.gjj-lotus-depth-nav{position:absolute;top:50%;transform:translateY(-50%);width:26px;height:38px;border:1px solid rgba(180,210,218,.34);border-radius:7px;background:rgba(5,10,13,.58);color:#f4fbf8;font-size:20px;line-height:1;cursor:pointer;}
		.gjj-lotus-depth-nav:hover{background:rgba(28,48,56,.82);border-color:#79a9b5;}
		.gjj-lotus-depth-prev{left:7px;}
		.gjj-lotus-depth-next{right:7px;}
		.gjj-lotus-depth-lightbox{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.78);cursor:zoom-out;box-sizing:border-box;}
		.gjj-lotus-depth-lightbox img{display:block;max-width:96vw;max-height:92vh;object-fit:contain;border:1px solid rgba(210,230,235,.34);border-radius:8px;background:#05090c;box-shadow:0 18px 64px rgba(0,0,0,.55);}
		.gjj-lotus-depth-lightbox-caption{position:fixed;left:24px;right:24px;bottom:16px;color:#d8e8e5;text-align:center;font:12px/1.4 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;text-shadow:0 1px 3px rgba(0,0,0,.8);pointer-events:none;}
	`;
	document.head.appendChild(style);
}

function ensurePanel(node) {
	if (node.__gjjLotusDepthPanel) return node.__gjjLotusDepthPanel;
	if (!node || typeof node.addDOMWidget !== "function") return null;
	ensureStyles();
	collapseNativeWidgets(node);

	const root = document.createElement("div");
	root.className = "gjj-lotus-depth-panel";
	root.addEventListener("pointerdown", (event) => event.stopPropagation());
	root.addEventListener("mousedown", (event) => event.stopPropagation());
	root.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

	const toolbar = document.createElement("div");
	toolbar.className = "gjj-lotus-depth-toolbar";

	const invertButton = document.createElement("button");
	invertButton.type = "button";
	invertButton.className = "gjj-lotus-depth-button";
	invertButton.title = "切换是否执行官方 ImageInvert。";

	const sizeButton = document.createElement("button");
	sizeButton.type = "button";
	sizeButton.className = "gjj-lotus-depth-button";
	sizeButton.title = "切换是否把深度图缩放回输入图片尺寸。";

	const settingsButton = document.createElement("button");
	settingsButton.type = "button";
	settingsButton.className = "gjj-lotus-depth-button";
	settingsButton.textContent = "⚙设置";
	settingsButton.title = "展开或收起模型与采样参数。";

	toolbar.append(invertButton, sizeButton, settingsButton);

	const settings = document.createElement("div");
	settings.className = "gjj-lotus-depth-settings";
	for (const field of SETTING_FIELDS) {
		const label = document.createElement("label");
		label.className = "gjj-lotus-depth-label";
		label.textContent = field.label;
		label.htmlFor = `gjj-lotus-depth-${field.name}`;

		const widget = getWidget(node, field.name);
		let input;
		if (field.kind === "combo") {
			input = document.createElement("select");
			for (const value of comboValues(widget)) {
				const option = document.createElement("option");
				option.value = value;
				option.textContent = value || "未选择";
				input.appendChild(option);
			}
		} else {
			input = document.createElement("input");
			input.type = "number";
			if (field.min != null) input.min = String(field.min);
			if (field.max != null) input.max = String(field.max);
			if (field.step != null) input.step = String(field.step);
		}
		input.id = `gjj-lotus-depth-${field.name}`;
		input.className = "gjj-lotus-depth-input";
		input.dataset.widget = field.name;
		input.addEventListener("change", () => setWidgetValue(node, field.name, input.value));
		settings.append(label, input);
	}

	root.append(toolbar, settings);

	const widget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
	});
	if (widget) {
		widget.serialize = false;
		widget.options = widget.options || {};
		widget.options.serialize = false;
		widget.computeSize = (width) => [Math.max(MIN_WIDTH, Number(width || node.size?.[0] || 430)), Math.max(48, Math.ceil(root.scrollHeight || 48))];
		widget.getHeight = () => Math.max(48, Math.ceil(root.scrollHeight || 48));
	}

	node.__gjjLotusDepthRoot = root;
	node.__gjjLotusDepthPanel = { root, toolbar, invertButton, sizeButton, settingsButton, settings, widget };

	invertButton.addEventListener("click", () => setWidgetValue(node, "invert_depth", !boolWidgetValue(node, "invert_depth", true)));
	sizeButton.addEventListener("click", () => setWidgetValue(node, "keep_size", !boolWidgetValue(node, "keep_size", true)));
	settingsButton.addEventListener("click", () => {
		node.properties = node.properties || {};
		node.properties[SETTINGS_PROP] = !Boolean(node.properties[SETTINGS_PROP]);
		syncPanel(node);
		refreshNode(node);
	});

	attachHelpModelProvider(node);
	syncPanel(node);
	refreshNode(node);
	return node.__gjjLotusDepthPanel;
}

function syncPanel(node) {
	const panel = node?.__gjjLotusDepthPanel;
	if (!panel) return;
	const invertOn = boolWidgetValue(node, "invert_depth", true);
	const sizeOn = boolWidgetValue(node, "keep_size", true);
	panel.invertButton.textContent = invertOn ? "反相 开" : "反相 关";
	panel.sizeButton.textContent = sizeOn ? "源尺寸 开" : "源尺寸 关";
	panel.invertButton.classList.toggle("on", invertOn);
	panel.sizeButton.classList.toggle("on", sizeOn);

	const settingsOpen = Boolean(node?.properties?.[SETTINGS_PROP]);
	panel.settings.classList.toggle("open", settingsOpen);
	panel.settingsButton.classList.toggle("on", settingsOpen);
	for (const input of panel.settings.querySelectorAll("[data-widget]")) {
		const name = input.dataset.widget;
		const widget = getWidget(node, name);
		if (!widget) continue;
		if (input.tagName === "SELECT") {
			const values = comboValues(widget);
			const currentOptions = [...input.options].map((option) => option.value);
			if (values.join("\u0001") !== currentOptions.join("\u0001")) {
				input.replaceChildren();
				for (const value of values) {
					const option = document.createElement("option");
					option.value = value;
					option.textContent = value || "未选择";
					input.appendChild(option);
				}
			}
		}
		input.value = String(widget.value ?? "");
	}
}

function ensurePreview(panel) {
	if (panel.preview) return panel.preview;
	const preview = document.createElement("div");
	preview.className = "gjj-lotus-depth-preview";
	const summary = document.createElement("div");
	summary.className = "gjj-lotus-depth-summary";
	const stage = document.createElement("div");
	stage.className = "gjj-lotus-depth-stage";
	preview.append(summary, stage);
	panel.root.appendChild(preview);
	panel.preview = { wrap: preview, summary, stage };
	return panel.preview;
}

function clearPreview(panel) {
	if (!panel?.preview) return;
	panel.preview.wrap.remove();
	panel.preview = null;
}

function openLightbox(src, caption) {
	if (!src) return;
	document.querySelector(".gjj-lotus-depth-lightbox")?.remove();
	const overlay = document.createElement("div");
	overlay.className = "gjj-lotus-depth-lightbox";
	const img = document.createElement("img");
	img.src = src;
	img.alt = caption || "Lotus深度图";
	const label = document.createElement("div");
	label.className = "gjj-lotus-depth-lightbox-caption";
	label.textContent = "点击任意位置关闭";
	overlay.append(img, label);
	const close = () => {
		document.removeEventListener("keydown", onKeyDown);
		overlay.remove();
	};
	const onKeyDown = (event) => {
		if (event.key === "Escape") close();
	};
	overlay.addEventListener("click", close);
	document.addEventListener("keydown", onKeyDown);
	document.body.appendChild(overlay);
}

function renderSequenceImage(node, preview, images) {
	const total = images.length;
	let index = Number(preview.index || 0);
	if (!Number.isFinite(index)) index = 0;
	index = Math.max(0, Math.min(total - 1, Math.floor(index)));
	preview.index = index;
	const item = images[index];
	const src = mediaUrl(item);
	preview.stage.replaceChildren();

	const card = document.createElement("div");
	card.className = "gjj-lotus-depth-card";
	const img = document.createElement("img");
	img.alt = `Lotus深度图 ${index + 1}`;
	img.src = src;
	img.title = item.filename || img.alt;
	img.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openLightbox(src, img.alt);
	});

	const badge = document.createElement("div");
	badge.className = "gjj-lotus-depth-badge";
	badge.textContent = "深度图";
	const counter = document.createElement("div");
	counter.className = "gjj-lotus-depth-counter";
	counter.textContent = `${index + 1}/${total}`;
	card.append(img, badge, counter);

	if (total > 1) {
		const prev = document.createElement("button");
		prev.type = "button";
		prev.className = "gjj-lotus-depth-nav gjj-lotus-depth-prev";
		prev.textContent = "‹";
		prev.title = "上一张";
		const next = document.createElement("button");
		next.type = "button";
		next.className = "gjj-lotus-depth-nav gjj-lotus-depth-next";
		next.textContent = "›";
		next.title = "下一张";
		prev.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			preview.index = (index - 1 + total) % total;
			renderSequenceImage(node, preview, images);
			refreshNode(node);
		});
		next.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			preview.index = (index + 1) % total;
			renderSequenceImage(node, preview, images);
			refreshNode(node);
		});
		card.append(prev, next);
	}

	preview.stage.appendChild(card);
}

function renderPreview(node, message = {}) {
	const panel = ensurePanel(node);
	if (!panel) return;
	const images = normalizeImages(message);
	const text = normalizeText(message.preview_text || message.text || message.ui?.preview_text || "");

	if (!images.length) {
		clearPreview(panel);
		refreshNode(node);
		return;
	}

	const preview = ensurePreview(panel);
	const signature = images.map((item) => `${item.type || ""}/${item.subfolder || ""}/${item.filename || ""}`).join("|");
	if (preview.signature !== signature) {
		preview.signature = signature;
		preview.index = 0;
	}
	preview.summary.textContent = text || `已生成 ${images.length} 张深度图`;
	renderSequenceImage(node, preview, images);
	refreshNode(node);
}

function attachHelpModelProvider(node) {
	if (!node || node.__gjjLotusDepthHelpAttached) return;
	node.__gjjLotusDepthHelpAttached = true;
	node.__gjjHelpModelEntries = () => [
		{
			label: "Lotus Depth UNET",
			kind: "diffusion",
			folder: "diffusion_models",
			value: widgetValue(node, "unet_name", "lotus-depth-d-v1-1.safetensors"),
		},
		{
			label: "VAE",
			kind: "vae",
			folder: "vae",
			value: widgetValue(node, "vae_name", "vae-ft-mse-840000-ema-pruned.safetensors"),
		},
	];
	node.__gjjHelpModelTreeEntries = node.__gjjHelpModelEntries;
}

function patchNode(node) {
	if (!node || node.__gjjLotusDepthPatched) return;
	node.__gjjLotusDepthPatched = true;
	collapseNativeWidgets(node);
	ensurePanel(node);
	setTimeout(() => {
		collapseNativeWidgets(node);
		syncPanel(node);
		refreshNode(node);
	}, 0);
	const originalOnExecuted = node.onExecuted;
	node.onExecuted = function (message, ...rest) {
		const cleanMessage = messageWithoutNativePreview(message || {});
		const result = originalOnExecuted?.apply(this, [cleanMessage, ...rest]);
		renderPreview(this, message || {});
		clearNativePreview(this);
		requestAnimationFrame(() => clearNativePreview(this));
		setTimeout(() => clearNativePreview(this), 80);
		setTimeout(() => clearNativePreview(this), 240);
		return result;
	};
	const originalOnResize = node.onResize;
	node.onResize = function (...args) {
		const result = originalOnResize?.apply(this, args);
		syncPanel(this);
		refreshNode(this);
		return result;
	};
}

app.registerExtension({
	name: "GJJ.LotusDepthMapPreview",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_NODE) return;
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this);
			return result;
		};
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			patchNode(this);
			return result;
		};
	},

	nodeCreated(node) {
		if (node?.comfyClass === TARGET_NODE || node?.type === TARGET_NODE) patchNode(node);
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === TARGET_NODE || node?.type === TARGET_NODE) patchNode(node);
		}
	},
});
