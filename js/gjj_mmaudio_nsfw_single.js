import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET = "GJJ_MMAudioNSFWSingle";
const TOOLBAR_NAME = "gjj_mmaudio_nsfw_toolbar";
const ADVANCED_PROPERTY = "gjj_mmaudio_nsfw_show_advanced";
const MODEL_PANEL_PROPERTY = "gjj_mmaudio_nsfw_show_model_panel";
const VIDEO_PANEL_PROPERTY = "gjj_mmaudio_nsfw_show_video_panel";
const AUDIO_PANEL_PROPERTY = "gjj_mmaudio_nsfw_show_audio_panel";
const VIDEO_EXTENSIONS = ".mp4,.webm,.mov,.mkv,.avi,.m4v,.flv,.wmv,.mpeg,.mpg";
const MODEL_WIDGETS = new Set([
	"mmaudio_model",
	"vae_model",
	"synchformer_model",
	"clip_model",
	"force_offload",
	"base_precision",
	"feature_precision",
]);
const VIDEO_WIDGETS = new Set([
	"force_rate",
	"custom_width",
	"custom_height",
	"frame_load_cap",
	"skip_first_frames",
	"select_every_nth",
	"filename_prefix",
	"format_name",
	"save_output",
	"pix_fmt",
	"crf",
]);
const AUDIO_WIDGETS = new Set([
	"duration_mode",
	"duration",
	"steps",
	"cfg",
	"seed",
	"negative_prompt",
	"mask_away_clip",
]);
const ALWAYS_HIDDEN_WIDGETS = new Set(["video", "translation_enabled", "translation_device", "translation_unload_after_use"]);
const RESTORE_WIDGET_TYPES = {
	video: "text",
	mmaudio_model: "combo",
	vae_model: "combo",
	synchformer_model: "combo",
	clip_model: "combo",
	force_rate: "number",
	custom_width: "number",
	custom_height: "number",
	frame_load_cap: "number",
	skip_first_frames: "number",
	select_every_nth: "number",
	duration_mode: "combo",
	duration: "number",
	steps: "number",
	cfg: "number",
	seed: "number",
	prompt: "text",
	negative_prompt: "text",
	mask_away_clip: "toggle",
	force_offload: "toggle",
	base_precision: "combo",
	feature_precision: "combo",
	filename_prefix: "text",
	format_name: "combo",
	save_output: "toggle",
	pix_fmt: "combo",
	crf: "text",
	translation_enabled: "toggle",
	translation_device: "combo",
	translation_unload_after_use: "toggle",
};

function stopEvent(event) {
	event?.preventDefault?.();
	event?.stopPropagation?.();
}

function markDirty(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function refreshNode(node) {
	if (!node) return;
	if (GJJ_Utils?.refreshNode) {
		GJJ_Utils.refreshNode(node, { minWidth: 0, minHeight: 90 });
		return;
	}
	const size = node.computeSize?.() || node.size || [260, 90];
	node.setSize?.([Math.max(260, size[0] || 260), Math.max(90, size[1] || 90)]);
	markDirty(node);
}

function scheduleRefreshNode(node) {
	if (!node) return;
	if (GJJ_Utils?.scheduleRefreshNode) {
		GJJ_Utils.scheduleRefreshNode(node, { minWidth: 0, minHeight: 90, delay: 0 });
		return;
	}
	requestAnimationFrame?.(() => refreshNode(node));
	setTimeout(() => refreshNode(node), 40);
}

function migrateLegacyAdvancedState(node) {
	if (!node?.properties) return;
	if (node.properties[ADVANCED_PROPERTY] !== true) return;
	if (node.properties[VIDEO_PANEL_PROPERTY] === undefined) {
		node.properties[VIDEO_PANEL_PROPERTY] = true;
	}
	if (node.properties[AUDIO_PANEL_PROPERTY] === undefined) {
		node.properties[AUDIO_PANEL_PROPERTY] = true;
	}
}

function modelPanelOpen(node) {
	return node?.properties?.[MODEL_PANEL_PROPERTY] !== false;
}

function videoPanelOpen(node) {
	return Boolean(node?.properties?.[VIDEO_PANEL_PROPERTY]);
}

function audioPanelOpen(node) {
	return Boolean(node?.properties?.[AUDIO_PANEL_PROPERTY]);
}

function getWidget(node, name) {
	return (node?.widgets || []).find((widget) => String(widget?.name || "") === name) || null;
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) return;
	widget.options ||= {};
	const values = widget.options.values || widget.options.comboValues || widget.values;
	if (Array.isArray(values) && value && !values.includes(value)) {
		values.push(value);
	}
	widget.value = value;
	try {
		widget.callback?.(value, app.canvas, node, app.canvas?.graph_mouse);
	} catch (_) {}
	node.onWidgetChanged?.(name, value, widget, node);
	markDirty(node);
}

function inputLinked(node, name) {
	return (node?.inputs || []).some((input) => String(input?.name || "") === name && input?.link != null);
}

function uploadUrl(path) {
	try {
		return api?.apiURL ? api.apiURL(path) : path;
	} catch (_) {
		return path;
	}
}

function normalizeUploadFilename(data, file) {
	const filename = data?.name || data?.filename || data?.file || file?.name;
	const subfolder = data?.subfolder || "";
	return subfolder ? `${subfolder}/${filename}` : filename;
}

async function uploadVideoToInput(file) {
	const endpoints = ["/upload/image", "/api/upload/image"];
	let lastError = null;
	for (const endpoint of endpoints) {
		const form = new FormData();
		form.append("image", file, file.name);
		form.append("type", "input");
		form.append("overwrite", "true");
		try {
			const response = await fetch(uploadUrl(endpoint), { method: "POST", body: form });
			if (!response.ok) {
				lastError = new Error(`HTTP ${response.status}`);
				continue;
			}
			const data = await response.json().catch(() => ({}));
			return normalizeUploadFilename(data, file);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError || new Error("上传失败");
}

function flashButton(button, text, ok = true) {
	if (!button) return;
	const oldText = button.textContent;
	const oldTitle = button.title;
	button.textContent = text;
	button.classList.toggle("gjj-ok", ok);
	button.classList.toggle("gjj-error", !ok);
	clearTimeout(button.__gjjFlashTimer);
	button.__gjjFlashTimer = setTimeout(() => {
		button.textContent = oldText;
		button.title = oldTitle;
		button.classList.remove("gjj-ok", "gjj-error", "gjj-busy");
	}, 1200);
}

function openVideoPicker(node) {
	if (inputLinked(node, "source_media")) {
		return;
	}
	const input = document.createElement("input");
	input.type = "file";
	input.accept = VIDEO_EXTENSIONS;
	input.style.display = "none";
	input.addEventListener("change", async () => {
		const file = input.files?.[0];
		input.remove();
		if (!file) return;
		const button = node.__gjjMMAudioToolbarButtons?.open;
		const oldText = button?.textContent || "📁";
		try {
			if (button) {
				button.textContent = "⏳";
				button.classList.add("gjj-busy");
			}
			setWidgetValue(node, "video", file.name);
			const uploadedName = await uploadVideoToInput(file);
			setWidgetValue(node, "video", uploadedName);
			flashButton(button, "✅", true);
		} catch (error) {
			console.warn("[GJJ_MMAudioNSFWSingle] 上传视频失败，已保留同名 input 文件名：", error);
			if (button) button.textContent = oldText;
			flashButton(button, "📁", true);
			if (button) {
				button.title = `已使用文件名：${file.name}。如果该文件不在 ComfyUI/input 目录，请移动到 input 后再运行。`;
			}
		}
	}, { once: true });
	document.body.appendChild(input);
	input.click();
}

function randomizeSeed(node) {
	const value = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
	setWidgetValue(node, "seed", value);
	flashButton(node.__gjjMMAudioToolbarButtons?.seed, "✅", true);
}

function toggleSaveOutput(node) {
	const widget = getWidget(node, "save_output");
	setWidgetValue(node, "save_output", !widget?.value);
	updateToolbar(node);
}

function toggleTranslation(node) {
	const widget = getWidget(node, "translation_enabled");
	setWidgetValue(node, "translation_enabled", !widget?.value);
	updateToolbar(node);
}

function toggleModelPanel(node) {
	setPanelOpen(node, MODEL_PANEL_PROPERTY, !modelPanelOpen(node));
}

function toggleVideoPanel(node) {
	setPanelOpen(node, VIDEO_PANEL_PROPERTY, !videoPanelOpen(node));
}

function toggleAudioPanel(node) {
	setPanelOpen(node, AUDIO_PANEL_PROPERTY, !audioPanelOpen(node));
}

function makeButton(label, title, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title;
	button.addEventListener("pointerdown", stopEvent);
	button.addEventListener("mousedown", stopEvent);
	button.addEventListener("mouseup", stopEvent);
	button.addEventListener("click", (event) => {
		stopEvent(event);
		onClick?.();
	});
	return button;
}

function ensureStyle() {
	if (document.getElementById("gjj-mmaudio-nsfw-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-mmaudio-nsfw-style";
	style.textContent = `
		.gjj-mmaudio-nsfw-toolbar {
			display: flex;
			gap: 6px;
			align-items: center;
			padding: 3px 0 2px;
			overflow: hidden;
		}
		.gjj-mmaudio-nsfw-toolbar button {
			width: 32px;
			min-width: 32px;
			height: 28px;
			border: 1px solid #43535b;
			border-radius: 6px;
			background: #172026;
			color: #edf7f4;
			font-size: 15px;
			font-weight: 800;
			line-height: 1;
			cursor: pointer;
		}
		.gjj-mmaudio-nsfw-toolbar button:hover {
			background: #22323a;
			border-color: #62808c;
		}
		.gjj-mmaudio-nsfw-toolbar button:disabled,
		.gjj-mmaudio-nsfw-toolbar button.gjj-disabled {
			background: #151a1d;
			border-color: #334047;
			color: #667780;
			cursor: not-allowed;
			opacity: .58;
		}
		.gjj-mmaudio-nsfw-toolbar button:disabled:hover,
		.gjj-mmaudio-nsfw-toolbar button.gjj-disabled:hover {
			background: #151a1d;
			border-color: #334047;
		}
		.gjj-mmaudio-nsfw-toolbar button.gjj-active,
		.gjj-mmaudio-nsfw-toolbar button.gjj-ok {
			background: #1f4b37;
			border-color: #57a773;
		}
		.gjj-mmaudio-nsfw-toolbar button.gjj-error {
			background: #4b2424;
			border-color: #c95d5d;
		}
		.gjj-mmaudio-nsfw-toolbar button.gjj-busy {
			background: #4b3f1f;
			border-color: #c7a84a;
		}
	`;
	document.head.appendChild(style);
}

function updateToolbar(node) {
	const buttons = node?.__gjjMMAudioToolbarButtons;
	if (!buttons) return;
	const externalMedia = inputLinked(node, "source_media");
	buttons.open.disabled = externalMedia;
	buttons.open.classList.toggle("gjj-disabled", externalMedia);
	buttons.open.title = externalMedia
		? "媒体输入口已有连接，当前优先使用输入口，📁 已禁用。"
		: "打开视频：选择本机视频，保存到 ComfyUI/input，并写入隐藏的视频文件字段。";
	buttons.save.classList.toggle("gjj-active", !!getWidget(node, "save_output")?.value);
	buttons.save.title = getWidget(node, "save_output")?.value
		? "保存位置：输出目录。点击切换到临时目录。"
		: "保存位置：临时目录。点击切换到输出目录。";
	if (buttons.translate) {
		buttons.translate.classList.toggle("gjj-active", !!getWidget(node, "translation_enabled")?.value);
		buttons.translate.title = getWidget(node, "translation_enabled")?.value
			? "提示词翻译：开启。执行时使用 translation\\opus-mt-zh-en.safetensors 把正向提示词翻译为英文。"
			: "提示词翻译：关闭。点击开启 🌏 翻译正向提示词。";
	}
	buttons.model?.classList.toggle("gjj-active", modelPanelOpen(node));
	if (buttons.model) {
		buttons.model.title = modelPanelOpen(node)
			? "模型参数：显示。点击收起模型选择。"
			: "模型参数：隐藏。点击显示模型选择。";
	}
	buttons.video?.classList.toggle("gjj-active", videoPanelOpen(node));
	if (buttons.video) {
		buttons.video.title = videoPanelOpen(node)
			? "视频参数：显示。点击收起视频读取和输出设置。"
			: "视频参数：隐藏。点击显示视频读取和输出设置。";
	}
	buttons.audio?.classList.toggle("gjj-active", audioPanelOpen(node));
	if (buttons.audio) {
		buttons.audio.title = audioPanelOpen(node)
			? "配音参数：显示。点击收起采样和反向提示词设置。"
			: "配音参数：隐藏。点击显示采样和反向提示词设置。";
	}
}

function rememberWidgetState(widget) {
	if (!widget || widget.__gjjMMAudioVisibilityState) {
		return;
	}
	widget.options = widget.options || {};
	widget.__gjjMMAudioOriginalState = {
		type: widget.type,
		hidden: widget.hidden,
		disabled: widget.disabled,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		draw: widget.draw,
		mouse: widget.mouse,
		label: widget.label,
		localized_name: widget.localized_name,
		optionsHidden: widget.options.hidden,
		optionsDisplay: widget.options.display,
		widgetDisplay: widget.widget?.style?.display || "",
		elementDisplay: widget.element?.style?.display || "",
		inputDisplay: widget.inputEl?.style?.display || "",
	};
	widget.__gjjMMAudioVisibilityState = widget.__gjjMMAudioOriginalState;
}

function setWidgetHidden(widget, hidden) {
	if (!widget) {
		return;
	}
	rememberWidgetState(widget);
	widget.options = widget.options || {};
	const state = widget.__gjjMMAudioVisibilityState || {};
	if (hidden) {
		widget.hidden = true;
		widget.disabled = true;
		widget.type = "hidden";
		widget.options.hidden = true;
		widget.options.display = "hidden";
		widget.computeSize = () => [0, -4];
		widget.getHeight = () => 0;
		widget.draw = () => {};
		widget.mouse = () => false;
		widget.label = "";
		widget.localized_name = "";
		widget.last_y = 0;
		widget.computedHeight = 0;
		widget.margin_top = 0;
		if (widget.widget) widget.widget.style.display = "none";
		if (widget.element) widget.element.style.display = "none";
		if (widget.inputEl) widget.inputEl.style.display = "none";
		return;
	}
	widget.hidden = false;
	widget.disabled = false;
	const stateLooksHidden = state.type === "hidden" || state.optionsHidden === true || state.optionsDisplay === "hidden";
	widget.type = state.type && state.type !== "hidden" ? state.type : (RESTORE_WIDGET_TYPES[widget.name] || state.type || "text");
	if (!stateLooksHidden && state.computeSize) widget.computeSize = state.computeSize;
	else delete widget.computeSize;
	if (!stateLooksHidden && state.getHeight) widget.getHeight = state.getHeight;
	else delete widget.getHeight;
	if (!stateLooksHidden && state.draw) widget.draw = state.draw;
	else delete widget.draw;
	if (!stateLooksHidden && state.mouse) widget.mouse = state.mouse;
	else delete widget.mouse;
	if (!stateLooksHidden || state.label) widget.label = state.label ?? widget.label;
	if (!stateLooksHidden || state.localized_name) widget.localized_name = state.localized_name ?? widget.localized_name;
	delete widget.options.hidden;
	delete widget.options.display;
	if (widget.widget) widget.widget.style.display = "";
	if (widget.element) widget.element.style.display = "";
	if (widget.inputEl) widget.inputEl.style.display = "";
}

function applyPanelVisibility(node) {
	if (!node || !Array.isArray(node.widgets)) {
		return;
	}
	node.properties = node.properties || {};
	migrateLegacyAdvancedState(node);
	const showModel = modelPanelOpen(node);
	const showVideo = videoPanelOpen(node);
	const showAudio = audioPanelOpen(node);
	for (const widget of node.widgets) {
		if (!widget.__gjjMMAudioVisibilityState) {
			rememberWidgetState(widget);
		}
	}
	for (const widget of node?.widgets || []) {
		const name = String(widget?.name || "");
		if (ALWAYS_HIDDEN_WIDGETS.has(name)) {
			setWidgetHidden(widget, true);
		} else if (MODEL_WIDGETS.has(name)) {
			setWidgetHidden(widget, !showModel);
		} else if (VIDEO_WIDGETS.has(name)) {
			setWidgetHidden(widget, !showVideo);
		} else if (AUDIO_WIDGETS.has(name)) {
			setWidgetHidden(widget, !showAudio);
		}
	}
	updateToolbar(node);
	refreshNode(node);
}

function setPanelOpen(node, property, open) {
	if (!node) {
		return;
	}
	node.properties = node.properties || {};
	node.properties[property] = Boolean(open);
	if (property === VIDEO_PANEL_PROPERTY || property === AUDIO_PANEL_PROPERTY) {
		node.properties[ADVANCED_PROPERTY] = Boolean(node.properties[VIDEO_PANEL_PROPERTY] || node.properties[AUDIO_PANEL_PROPERTY]);
	}
	applyPanelVisibility(node);
}

function moveToolbarToTop(node) {
	const toolbar = node?.__gjjMMAudioToolbarWidget;
	if (!toolbar || !Array.isArray(node.widgets)) {
		return;
	}
	const index = node.widgets.indexOf(toolbar);
	if (index > 0) {
		node.widgets.splice(index, 1);
		node.widgets.unshift(toolbar);
	}
}

function schedulePanelVisibility(node) {
	for (const delay of [0, 30, 120, 300]) {
		setTimeout(() => applyPanelVisibility(node), delay);
	}
}

function ensureToolbar(node) {
	if (!node || node.__gjjMMAudioToolbarWidget) {
		moveToolbarToTop(node);
		updateToolbar(node);
		return;
	}
	ensureStyle();
	const row = document.createElement("div");
	row.className = "gjj-mmaudio-nsfw-toolbar";
	const open = makeButton("📁", "打开视频：选择本机视频，保存到 ComfyUI/input，并写入隐藏的视频文件字段。", () => openVideoPicker(node));
	const seed = makeButton("🎲", "随机种子。", () => randomizeSeed(node));
	const save = makeButton("💾", "切换保存到输出目录/临时目录。", () => toggleSaveOutput(node));
	const translate = makeButton("🌏", "提示词翻译：关闭。点击开启 🌏 翻译正向提示词。", () => toggleTranslation(node));
	const model = makeButton("🧠", "模型参数：显示。点击收起模型选择。", () => toggleModelPanel(node));
	const video = makeButton("🎬", "视频参数：点击显示视频读取和输出设置。", () => toggleVideoPanel(node));
	const audio = makeButton("🔊", "配音参数：点击显示采样和反向提示词设置。", () => toggleAudioPanel(node));
	row.append(open, seed, save, translate, model, video, audio);
	node.__gjjMMAudioToolbarButtons = { open, seed, save, translate, model, video, audio };
	const widget = node.addDOMWidget?.(TOOLBAR_NAME, "HTML", row, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => 34,
	});
	if (widget) {
		widget.serialize = false;
		widget.options ||= {};
		widget.options.serialize = false;
		widget.computeSize = (width) => [Math.max(260, width || 260), 34];
		node.__gjjMMAudioToolbarWidget = widget;
		moveToolbarToTop(node);
	} else {
		const fallback = node.addWidget?.("button", "📁 🎲 💾 🌏 🧠 🎬 🔊", null, () => openVideoPicker(node), { serialize: false });
		if (fallback) {
			fallback.serialize = false;
			fallback.options ||= {};
			fallback.options.serialize = false;
			node.__gjjMMAudioToolbarWidget = fallback;
			moveToolbarToTop(node);
		}
	}
	moveToolbarToTop(node);
	updateToolbar(node);
}

function patchNode(node) {
	if (!node) return;
	ensureToolbar(node);
	moveToolbarToTop(node);
	applyPanelVisibility(node);
	updateToolbar(node);
	schedulePanelVisibility(node);
}

app.registerExtension({
	name: "GJJ.MMAudioNSFWSingle",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (String(nodeData?.name || "") !== TARGET) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			ensureToolbar(this);
			schedulePanelVisibility(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			ensureToolbar(this);
			schedulePanelVisibility(this);
			return result;
		};

		const originalOnWidgetChanged = nodeType.prototype.onWidgetChanged;
		nodeType.prototype.onWidgetChanged = function (...args) {
			const result = originalOnWidgetChanged?.apply(this, args);
			updateToolbar(this);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			updateToolbar(this);
			return result;
		};
	},
	setup() {
		for (const node of app.graph?._nodes || []) {
			if (String(node?.comfyClass || node?.type || "") === TARGET) {
				patchNode(node);
			}
		}
	},
});
