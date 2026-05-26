import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const STATUS_WIDGET_NAME = "gjj_standard_status";
const HELP_WIDGET_NAME = "gjj_help_button";
const HELP_WIDGET_TOP = -28;
const HELP_BUTTON_RIGHT = 14;
const HELP_WIDGET_WIDTH = 24;
const HELP_MODEL_KEYWORDS = [
	"模型",
	"UNET",
	"CLIP",
	"VAE",
	"LoRA",
	"LORA",
	"Checkpoint",
	"ControlNet",
	"SAM",
	"RIFE",
	"FlashVSR",
	"CosyVoice",
	"Fish",
	"Ollama",
	"Qwen",
	"ACE",
];
const META_BY_CLASS = new Map();
const FULLY_BYPASS_CLASSES = new Set([
	"GJJ_AnyPreview",
]);
const STATUS_DISABLED_CLASSES = new Set([
	"GJJ_BoolSwitch",
	"GJJ_TemplateParams",
	"GJJ_MultifunctionCalculator",
	"GJJ_AnyPreview",
	"GJJ_AudioSeparator",
	"GJJ_MemoryManager",
	"GJJ_AnimeLineartRealConverter",
	"GJJ_AnimeLineartRealEditor",
	"GJJ_AudioAceMusicGenerator",
	"GJJ_CosyVoice3Generator",
	"GJJ_FishAudioS2Generator",
	"GJJ_FlashVSRVideoUpscaler",
	"GJJ_ImageAnalysis",
	"GJJ_ImageComparer",
	"GJJ_LazyImageStudio",
	"GJJ_LongCatAudioDiTTTS",
	"GJJ_LoraEffectTester",
	"GJJ_LoraFaceMaterialGenerator",
	"GJJ_LTX23ImageToVideo",
	"GJJ_LTX23ImageToVideoMultiRef",
	"GJJ_MultiImageLoader",
	"GJJ_OldPhotoRestorer",
	"GJJ_OllamaDirectoryCaptioner",
	"GJJ_PromptGeneration",
	"GJJ_CharacterMultiViewStudio",
	"GJJ_Qwen2511EditOutpaint",
	"GJJ_RifeVideoInterpolator",
	"GJJ_SeedVR2ImageUpscaler",
	"GJJ_Translation",
	"GJJ_TextInput",
	"GJJ_VideoCombine",
	"GJJ_Wan22FirstLastVideo",
	"GJJ_Wan22RapidAIOMega",
]);
const BOOL_SWITCH_CLASS = "GJJ_BoolSwitch";
const BOOL_SWITCH_WILDCARD_INPUTS = new Set(["on_true", "on_false", "为真时", "为假时"]);
const DEPENDENCY_NOTICE_EVENT = "gjj_dependency_model_notice";

function isBoolSwitchNode(node) {
	return String(node?.comfyClass || node?.type || "") === BOOL_SWITCH_CLASS;
}

function patchBoolSwitchWildcardInputs(node) {
	if (!isBoolSwitchNode(node)) {
		return;
	}
	for (const input of node?.inputs || []) {
		const names = [input?.name, input?.label, input?.localized_name].map((item) => String(item || ""));
		if (!names.some((name) => BOOL_SWITCH_WILDCARD_INPUTS.has(name))) {
			continue;
		}
		// Python 端用 STRING 才能生成文本框；前端这里把插槽改回 *，允许 MODEL / VAE / CLIP / IMAGE / AUDIO 等任意类型接入。
		input.type = "*";
	}
}

const COMMON_NAME_LABELS = {
	system_prompt: "系统提示词",
	user_prompt: "用户提示词",
	prompt_template: "打标提示词",
	ollama_host: "Ollama 完整地址",
	model_keep_alive: "模型处理",
	thinking_mode: "思考模式",
	max_tokens: "最大生成长度",
	target_language: "目标语言",
	text: "文本内容",
	seed: "随机种子",
};

const COMMON_LABELS = new Map([
	["UNET", "UNET 主模型"],
	["🟣 UNET", "🟣 UNET 主模型"],
	["CLIP", "CLIP 编码器"],
	["🟡 CLIP", "🟡 CLIP 编码器"],
	["CLIP 1", "CLIP 编码器 1"],
	["CLIP 2", "CLIP 编码器 2"],
	["VAE", "VAE 解码器"],
	["🔴 VAE", "🔴 VAE 解码器"],
	["CFG", "CFG 引导强度"],
	["Detailer Hook", "细节修复钩子"],
	["Wan Checkpoint", "Wan 基础模型"],
]);

const COMMON_TOOLTIPS = {
	system_prompt: "系统级提示词，会影响模型整体回答风格与约束。",
	user_prompt: "用户提示词，填写本次需要处理的具体内容。",
	prompt_template: "用于生成或打标时的提示模板。",
	ollama_host: "填写完整的本机 Ollama 地址，例如 http://127.0.0.1:11434 。",
	model_keep_alive: "控制任务完成后是否保留模型在内存中。",
	thinking_mode: "控制是否启用模型的思考模式。",
	max_tokens: "限制单次返回的最大生成长度。",
	target_language: "选择需要翻译成的目标语言。",
	text: "填写需要处理或翻译的文本内容。",
	seed: "随机种子，填写固定值可复现结果。",
	"UNET 主模型": "选择要加载的 UNET 主模型。",
	"🟣 UNET 主模型": "选择要加载的 UNET 主模型。",
	"CLIP 编码器": "选择要加载的 CLIP 文本编码器。",
	"🟡 CLIP 编码器": "选择要加载的 CLIP 文本编码器。",
	"CLIP 编码器 1": "选择第一个 CLIP 文本编码器。",
	"CLIP 编码器 2": "选择第二个 CLIP 文本编码器。",
	"VAE 解码器": "选择要加载的 VAE 解码器。",
	"🔴 VAE 解码器": "选择要加载的 VAE 解码器。",
	"CFG 引导强度": "设置提示词引导强度，数值越高越贴近提示词。",
	"细节修复钩子": "可选的细节修复钩子配置。",
	"Wan 基础模型": "选择 Wan 流程使用的基础模型文件。",
};

function isGjjNodeData(nodeData) {
	return typeof nodeData?.category === "string" && nodeData.category.startsWith("GJJ");
}

function isGjjNode(node) {
	return typeof node?.category === "string" && node.category.startsWith("GJJ")
		|| String(node?.comfyClass || node?.type || "").startsWith("GJJ");
}

function shouldAttachStatus(node) {
	return !STATUS_DISABLED_CLASSES.has(String(node?.comfyClass || node?.type || ""));
}

function shouldBypassNode(node) {
	return FULLY_BYPASS_CLASSES.has(String(node?.comfyClass || node?.type || ""));
}

function disableStatusWidget(node) {
	const state = node?.__gjjStandardStatus;
	if (!state) {
		return;
	}
	state.visible = false;
	state.wrap.style.display = "none";
	state.progress = 0;
	if (state.progressInner) {
		state.progressInner.style.width = "0%";
	}
	if (state.widget) {
		state.widget.computeSize = () => [0, 0];
	}
	refreshNode(node);
}

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function shieldDomWidgetEvents(element) {
	if (!element || element.__gjjStandardEventShield) {
		return;
	}
	if (element.matches?.("input, textarea, select, button, [contenteditable='true']")) {
		return;
	}
	element.__gjjStandardEventShield = true;
	const stopCanvasCapture = (event) => {
		event.stopPropagation();
	};
	for (const eventName of ["pointerdown", "mousedown", "dblclick", "contextmenu", "wheel"]) {
		element.addEventListener(eventName, stopCanvasCapture);
	}
}

function protectDomWidgets(node) {
	for (const widget of node?.widgets || []) {
		const element = widget?.element || widget?.inputEl;
		if (!element || typeof element.addEventListener !== "function") {
			continue;
		}
		const widgetName = String(widget?.name || "");
		const widgetType = String(widget?.type || "");
		if (
			widgetName.startsWith("gjj_")
			|| widgetName.startsWith("GJJ_")
			|| widgetType === "DOM"
			|| widgetType === "HTML"
		) {
			shieldDomWidgetEvents(element);
		}
	}
}

function protectDomWidget(widget) {
	if (!widget) {
		return;
	}
	const element = widget.element || widget.inputEl;
	if (element && typeof element.addEventListener === "function") {
		shieldDomWidgetEvents(element);
	}
}

function patchAddDomWidget(node) {
	if (!node || node.__gjjStandardAddDomWidgetPatched || typeof node.addDOMWidget !== "function") {
		return;
	}
	node.__gjjStandardAddDomWidgetPatched = true;
	const originalAddDOMWidget = node.addDOMWidget;
	node.addDOMWidget = function (...args) {
		const widget = originalAddDOMWidget.apply(this, args);
		protectDomWidget(widget);
		requestAnimationFrame(() => protectDomWidget(widget));
		setTimeout(() => protectDomWidget(widget), 40);
		return widget;
	};
}

function humanizeName(name) {
	return String(name || "")
		.replace(/^_+/, "")
		.replace(/_/g, " ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.trim();
}

function localizeLabel(text, fallbackName = "") {
	const raw = String(text || "").trim();
	if (!raw && fallbackName) {
		const common = COMMON_NAME_LABELS[fallbackName];
		if (common) {
			return common;
		}
		return humanizeName(fallbackName);
	}
	if (/[\u4e00-\u9fff]/.test(raw)) {
		return raw;
	}
	if (COMMON_LABELS.has(raw)) {
		return COMMON_LABELS.get(raw);
	}
	if (fallbackName && COMMON_NAME_LABELS[fallbackName]) {
		return COMMON_NAME_LABELS[fallbackName];
	}
	return raw;
}

function localizeTooltip(text, name = "", label = "") {
	const raw = String(text || "").trim();
	if (raw && /[\u4e00-\u9fff]/.test(raw)) {
		return raw;
	}
	if (COMMON_TOOLTIPS[name]) {
		return COMMON_TOOLTIPS[name];
	}
	const localizedLabel = localizeLabel(label, name);
	if (COMMON_TOOLTIPS[localizedLabel]) {
		return COMMON_TOOLTIPS[localizedLabel];
	}
	return raw;
}

function setWidgetLabel(widget, label) {
	if (!widget || !label) {
		return;
	}
	widget.label = label;
	widget.localized_name = label;
	widget.options = widget.options || {};
	widget.options.display_name = label;
}

function setWidgetTooltip(widget, tooltip) {
	if (!widget || !tooltip) {
		return;
	}
	widget.options = widget.options || {};
	widget.options.tooltip = tooltip;
	widget.tooltip = tooltip;
}

function parseInputMeta(section, meta) {
	for (const [name, config] of Object.entries(section || {})) {
		const options = Array.isArray(config) ? config[1] : null;
		const type = Array.isArray(config) ? config[0] : "";
		if (!options || typeof options !== "object") {
			meta.inputs.set(name, {
				type,
				label: localizeLabel("", name),
				tooltip: "",
			});
			continue;
		}
		meta.inputs.set(name, {
			type,
			label: localizeLabel(options.display_name, name),
			tooltip: localizeTooltip(options.tooltip, name, options.display_name),
		});
	}
}

function buildNodeMeta(nodeData) {
	const meta = {
		name: String(nodeData?.name || ""),
		displayName: localizeLabel(nodeData?.display_name || nodeData?.displayName || nodeData?.name || "", ""),
		category: String(nodeData?.category || ""),
		description: String(nodeData?.description || nodeData?.DESCRIPTION || "").trim(),
		help: nodeData?.help || nodeData?.GJJ_HELP || null,
		inputs: new Map(),
		outputs: [],
	};
	const inputData = nodeData?.input || nodeData?.inputs || {};
	parseInputMeta(inputData.required, meta);
	parseInputMeta(inputData.optional, meta);
	parseInputMeta(inputData.hidden, meta);

	const outputNames = Array.isArray(nodeData?.output_name) ? nodeData.output_name : [];
	const outputTooltips = Array.isArray(nodeData?.output_tooltips) ? nodeData.output_tooltips : [];
	for (let index = 0; index < outputNames.length; index += 1) {
		meta.outputs.push({
			label: localizeLabel(outputNames[index], ""),
			tooltip: localizeTooltip(outputTooltips[index], "", outputNames[index]),
		});
	}
	return meta;
}

function includesAny(text, keywords) {
	const raw = String(text || "").toLowerCase();
	return keywords.some((keyword) => raw.includes(String(keyword).toLowerCase()));
}

function escapeText(text, fallback = "") {
	const raw = String(text ?? fallback ?? "").trim();
	return raw || fallback;
}

function firstWarningLine(text) {
	const line = String(text || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean) || "";
	return line.startsWith("⚠️") ? line : "";
}

function statusCopyText(meta) {
	return String(meta?.help?.copy_text || meta?.help?.install_cmd || meta?.help?.model_download_url || "").trim();
}

function formatHelpText(text, fallback = "") {
	const raw = escapeText(text, fallback);
	if (!raw) {
		return raw;
	}
	const normalized = raw
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/\\n/g, "\n");
	const trimmed = normalized.trim();
	if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
		try {
			return JSON.stringify(JSON.parse(trimmed), null, 2);
		} catch {
			return normalized;
		}
	}
	return normalized;
}

function normalizeComparableHelpText(text) {
	return formatHelpText(text, "")
		.replace(/\s+/g, " ")
		.trim();
}

function shouldShowNoticeSection(descriptionText, noticeText) {
	const notice = normalizeComparableHelpText(noticeText);
	if (!notice) {
		return false;
	}
	const description = normalizeComparableHelpText(descriptionText);
	return description !== notice && !description.startsWith(notice);
}

function initialWarningText(meta) {
	const candidates = [
		meta?.description,
		meta?.help?.notice,
		meta?.help?.warning_message,
	];
	for (const candidate of candidates) {
		const text = firstWarningLine(candidate);
		if (text) {
			return text;
		}
	}
	return "";
}

function modelMetaEntries(meta) {
	const entries = [];
	for (const [name, input] of meta?.inputs || []) {
		const searchable = [name, input?.type, input?.label, input?.tooltip].join(" ");
		if (!includesAny(searchable, HELP_MODEL_KEYWORDS)) {
			continue;
		}
		entries.push({
			name,
			label: escapeText(input?.label, name),
			type: escapeText(input?.type, ""),
			tooltip: escapeText(input?.tooltip, ""),
		});
	}
	return entries;
}

function declaredModelEntries(meta) {
	const declared = meta?.help?.models || meta?.help?.model || meta?.help?.required_models || meta?.help?.requiredModels;
	const normalizeItem = (item, fallbackLabel = "模型") => {
		if (typeof item === "string") {
			const value = item.trim();
			return value ? { label: fallbackLabel, value, tooltip: "" } : null;
		}
		if (!item || typeof item !== "object") {
			return null;
		}
		const label = escapeText(item.label || item.name || item.title || fallbackLabel, fallbackLabel);
		const value = escapeText(item.value || item.path || item.filename || item.file || item.model || "");
		const tooltip = escapeText(item.tooltip || item.description || item.note || "");
		return value ? { label, value, tooltip } : null;
	};
	if (Array.isArray(declared)) {
		return declared.map((item) => normalizeItem(item)).filter(Boolean);
	}
	if (typeof declared === "string" && declared.trim()) {
		return declared.split(/\r?\n/).map((item) => normalizeItem(item)).filter(Boolean);
	}
	if (declared && typeof declared === "object") {
		return Object.entries(declared)
			.map(([label, value]) => {
				if (typeof value === "string") {
					return normalizeItem(value, label);
				}
				return normalizeItem({ label, ...(value || {}) }, label);
			})
			.filter(Boolean);
	}
	return [];
}

function pushUniqueModelEntry(entries, entry) {
	if (!entry?.value) {
		return;
	}
	const key = `${entry.label}\n${entry.value}`;
	if (entries.some((existing) => `${existing.label}\n${existing.value}` === key)) {
		return;
	}
	entries.push(entry);
}

function currentModelEntries(node, meta) {
	const metaByName = new Map(modelMetaEntries(meta).map((entry) => [String(entry.name), entry]));
	const entries = declaredModelEntries(meta);
	for (const widget of node?.widgets || []) {
		const widgetName = String(widget?.name || "");
		const widgetLabel = escapeText(widget?.label || widget?.options?.display_name || "", widgetName);
		const tooltip = escapeText(widget?.tooltip || widget?.options?.tooltip || "");
		const searchable = [widgetName, widgetLabel, tooltip].join(" ");
		const widgetValue = escapeText(widget?.value, "");
		if (!metaByName.has(widgetName) && !includesAny(searchable, HELP_MODEL_KEYWORDS)) {
			continue;
		}
		if (!widgetValue) {
			metaByName.delete(widgetName);
			continue;
		}
		const inputMeta = metaByName.get(widgetName) || {};
		pushUniqueModelEntry(entries, {
			label: escapeText(inputMeta.label || widgetLabel, widgetName),
			value: widgetValue,
			tooltip: escapeText(inputMeta.tooltip || tooltip, ""),
		});
		metaByName.delete(widgetName);
	}
	for (const input of node?.inputs || []) {
		const inputName = String(input?.name || "");
		const inputMeta = metaByName.get(inputName);
		if (!inputMeta) {
			continue;
		}
		pushUniqueModelEntry(entries, {
			label: inputMeta.label,
			value: input?.link ? "已连接外部输入" : "外部输入口",
			tooltip: inputMeta.tooltip,
		});
		metaByName.delete(inputName);
	}
	for (const inputMeta of metaByName.values()) {
		pushUniqueModelEntry(entries, {
			label: inputMeta.label,
			value: inputMeta.type || "未声明",
			tooltip: inputMeta.tooltip,
		});
	}
	return entries;
}

function dependencyEntries(meta) {
	const declared = meta?.help?.dependencies || meta?.help?.depends || meta?.help?.dependency;
	if (Array.isArray(declared) && declared.length) {
		return declared.map((item) => String(item || "").trim()).filter(Boolean);
	}
	if (typeof declared === "string" && declared.trim()) {
		return declared.split(/\r?\n|[,，]/).map((item) => item.trim()).filter(Boolean);
	}

	const text = [
		meta?.name,
		meta?.displayName,
		meta?.description,
		...[...(meta?.inputs?.values?.() || [])].map((input) => `${input?.label || ""} ${input?.tooltip || ""}`),
	].join(" ");
	const inferred = [];
	const patterns = [
		["Ollama", /ollama/i],
		["huggingface_hub（自动下载模型时需要）", /hugging\s*face|huggingface|自动下载/i],
		["transformers / tokenizers（大语言、语音或 ASR 模型常用）", /qwen|asr|tokenizer|transformer/i],
		["vendored 运行时（随 GJJ/vendor 打包）", /vendored|内置|零依赖|迁移/i],
		["ffmpeg（视频/音频封装时需要）", /视频|音频|fps|mp4|webm|ffmpeg/i],
	];
	for (const [label, pattern] of patterns) {
		if (pattern.test(text)) {
			inferred.push(label);
		}
	}
	return inferred;
}

function createHelpSection(title, content) {
	const section = document.createElement("section");
	section.className = "gjj-help-section";
	const heading = document.createElement("h3");
	heading.textContent = title;
	section.appendChild(heading);
	if (typeof content === "string") {
		const paragraph = document.createElement("p");
		paragraph.textContent = content;
		section.appendChild(paragraph);
	} else if (content) {
		section.appendChild(content);
	}
	return section;
}

function createHelpList(items, emptyText) {
	if (!items.length) {
		const empty = document.createElement("p");
		empty.className = "gjj-help-empty";
		empty.textContent = emptyText;
		return empty;
	}
	const list = document.createElement("div");
	list.className = "gjj-help-list";
	for (const item of items) {
		const row = document.createElement("div");
		row.className = "gjj-help-row";
		if (typeof item === "string") {
			row.textContent = item;
		} else {
			const label = document.createElement("div");
			label.className = "gjj-help-row-label";
			label.textContent = item.label || "模型";
			const value = document.createElement("div");
			value.className = "gjj-help-row-value";
			value.textContent = formatHelpText(item.value, "未选择");
			row.append(label, value);
			if (item.tooltip) {
				const tip = document.createElement("div");
				tip.className = "gjj-help-row-tip";
				tip.textContent = formatHelpText(item.tooltip);
				row.appendChild(tip);
			}
		}
		list.appendChild(row);
	}
	return list;
}

function ensureHelpStyles() {
	if (document.getElementById("gjj-help-styles")) {
		return;
	}
	const style = document.createElement("style");
	style.id = "gjj-help-styles";
	style.textContent = `
		.gjj-help-overlay {
			position: fixed;
			inset: 0;
			z-index: 100000;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 24px;
			background: rgba(4, 8, 10, 0.62);
			box-sizing: border-box;
		}
		.gjj-help-dialog {
			width: min(720px, calc(100vw - 48px));
			max-height: min(760px, calc(100vh - 48px));
			display: flex;
			flex-direction: column;
			border: 1px solid rgba(113, 137, 148, 0.55);
			border-radius: 10px;
			background: #11191d;
			color: #e6f0eb;
			box-shadow: 0 22px 64px rgba(0, 0, 0, 0.48);
			overflow: hidden;
			font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		}
		.gjj-help-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 12px;
			padding: 14px 16px;
			background: #1b252b;
			border-bottom: 1px solid rgba(113, 137, 148, 0.36);
		}
		.gjj-help-title {
			min-width: 0;
			font-size: 15px;
			font-weight: 650;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.gjj-help-close {
			width: 28px;
			height: 28px;
			border: 1px solid rgba(170, 190, 198, 0.34);
			border-radius: 6px;
			background: rgba(255, 255, 255, 0.06);
			color: #e6f0eb;
			font-size: 18px;
			line-height: 24px;
			cursor: pointer;
		}
		.gjj-help-body {
			padding: 14px 16px 16px;
			overflow: auto;
		}
		.gjj-help-section + .gjj-help-section {
			margin-top: 14px;
		}
		.gjj-help-section h3 {
			margin: 0 0 8px;
			font-size: 13px;
			color: #98d6d1;
		}
		.gjj-help-section p {
			margin: 0;
			font-size: 13px;
			line-height: 1.58;
			color: #d7e3e6;
			white-space: pre-wrap;
		}
		.gjj-help-list {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}
		.gjj-help-row {
			padding: 9px 10px;
			border: 1px solid rgba(113, 137, 148, 0.28);
			border-radius: 8px;
			background: rgba(255, 255, 255, 0.035);
			font-size: 13px;
			line-height: 1.45;
		}
		.gjj-help-row-label {
			color: #f0f7f4;
			font-weight: 620;
		}
		.gjj-help-row-value {
			margin-top: 3px;
			color: #f3d58b;
			word-break: break-word;
			white-space: pre-wrap;
		}
		.gjj-help-row-tip {
			margin-top: 5px;
			color: #aebfc5;
			word-break: break-word;
			white-space: pre-wrap;
		}
		.gjj-help-empty {
			color: #aebfc5 !important;
		}
	`;
	document.head.appendChild(style);
}

function showHelpDialog(node) {
	const meta = META_BY_CLASS.get(String(node?.comfyClass || "")) || {};
	ensureHelpStyles();
	document.querySelector(".gjj-help-overlay")?.remove();

	const overlay = document.createElement("div");
	overlay.className = "gjj-help-overlay";
	const dialog = document.createElement("div");
	dialog.className = "gjj-help-dialog";
	const header = document.createElement("div");
	header.className = "gjj-help-header";
	const title = document.createElement("div");
	title.className = "gjj-help-title";
	title.textContent = `${node?.title || meta.displayName || meta.name || "GJJ 节点"} · 帮助`;
	const close = document.createElement("button");
	close.className = "gjj-help-close";
	close.type = "button";
	close.textContent = "×";
	close.title = "关闭";
	header.append(title, close);

	const body = document.createElement("div");
	body.className = "gjj-help-body";
	const descriptionText = formatHelpText(meta.description, "这个节点暂未提供功能说明。");
	const noticeText = formatHelpText(meta?.help?.notice || "");
	body.appendChild(createHelpSection("功能", descriptionText));
	if (shouldShowNoticeSection(descriptionText, noticeText)) {
		body.appendChild(createHelpSection("说明", noticeText));
	}
	if (meta?.help?.install_cmd) {
		body.appendChild(createHelpSection("安装命令", formatHelpText(meta.help.install_cmd)));
	}

	// 创建用到的模型内容
	const modelEntries = currentModelEntries(node, meta);
	let modelContent;
	if (Array.isArray(modelEntries) && modelEntries.length > 0) {
		modelContent = createHelpList(modelEntries, "未从当前节点面板识别到模型选择项或模型输入口。");
	} else {
		const empty = document.createElement("p");
		empty.className = "gjj-help-empty";
		empty.textContent = "未从当前节点面板识别到模型选择项或模型输入口。";
		modelContent = empty;
	}

	body.appendChild(createHelpSection("用到的模型", modelContent));
	body.appendChild(createHelpSection("依赖", createHelpList(
		dependencyEntries(meta),
		"未声明额外依赖；按 GJJ 与 ComfyUI 基础环境运行。"
	)));

	dialog.append(header, body);
	overlay.appendChild(dialog);
	document.body.appendChild(overlay);

	const remove = () => overlay.remove();
	close.addEventListener("click", remove);
	overlay.addEventListener("pointerdown", (event) => {
		if (event.target === overlay) {
			remove();
		}
	});
	const keyHandler = (event) => {
		if (event.key === "Escape") {
			remove();
			window.removeEventListener("keydown", keyHandler);
		}
	};
	window.addEventListener("keydown", keyHandler);
}

async function loadBackendHelpMetadata() {
	try {
		const response = await api.fetchApi("/gjj/node_help");
		if (!response?.ok) {
			return;
		}
		const payload = await response.json();
		for (const [className, helpData] of Object.entries(payload || {})) {
			const meta = META_BY_CLASS.get(String(className));
			if (!meta) {
				META_BY_CLASS.set(String(className), {
					name: String(className),
					displayName: localizeLabel(className, ""),
					category: "GJJ",
					description: String(helpData?.description || "").trim(),
					help: helpData?.help || null,
					inputs: new Map(),
					outputs: [],
				});
				continue;
			}
			if (!meta.description && helpData?.description) {
				meta.description = String(helpData.description || "").trim();
			}
			if (!meta.help && helpData?.help) {
				meta.help = helpData.help;
			}
		}
	} catch (error) {
		console.warn("[GJJ] 节点帮助信息加载失败", error);
	}
}

function refreshGjjNodesAfterHelpLoad() {
	for (const node of app.graph?._nodes || []) {
		if (!isGjjNode(node)) {
			continue;
		}
		patchNode(node);
		applyNodeMetadata(node);
		if (shouldAttachStatus(node)) {
			const meta = META_BY_CLASS.get(String(node?.comfyClass || ""));
			const warningText = initialWarningText(meta);
			if (warningText) {
				updateStatus(node, {
					text: warningText,
					progress: 0,
					copy_text: statusCopyText(meta),
					copy_label: meta?.help?.copy_label || "",
				}, { visible: true });
			}
		}
	}
}

function moveHelpWidgetToFront(node, widget) {
	// Keep the help DOM widget out of the serialized widget prefix.
	// ComfyUI restores widgets_values by widget index; moving this serialize:false
	// decoration to index 0 shifts saved workflow parameters on reload.
	if (!node?.widgets || !widget) return;
}

function removeLegacyHelpWidget(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	for (let index = node.widgets.length - 1; index >= 0; index -= 1) {
		if (String(node.widgets[index]?.name || "") === HELP_WIDGET_NAME) {
			node.widgets.splice(index, 1);
		}
	}
}

function updateHelpWidgetPosition(node) {
	const state = node?.__gjjHelpWidgetState;
	if (!state?.button) {
		return;
	}
	const width = Math.max(160, Number(node?.size?.[0] || 160));
	const x = Math.max(34, width - HELP_WIDGET_WIDTH - HELP_BUTTON_RIGHT);
	const lastY = Number(state.widget?.last_y);
	const y = Number(state.widget?.y);
	const widgetY = Number.isFinite(lastY) && lastY !== 0
		? lastY
		: (Number.isFinite(y) ? y : 0);
	state.button.style.left = `${Math.round(x)}px`;
	// 锚定在标题栏区域，避免正文面板高度变化时跟着下移。
	state.button.style.top = `${Math.round(HELP_WIDGET_TOP - widgetY)}px`;
	state.button.style.transform = "none";
}

function scheduleHelpWidgetPositionUpdate(node) {
	updateHelpWidgetPosition(node);
	requestAnimationFrame(() => updateHelpWidgetPosition(node));
	setTimeout(() => updateHelpWidgetPosition(node), 40);
	setTimeout(() => updateHelpWidgetPosition(node), 120);
}

function isHelpButtonGloballyEnabled() {
	return window.__gjjSettings?.["GJJ_HelpButton"] !== false;
}

function ensureHelpWidget(node) {
		if (!isHelpButtonGloballyEnabled()) return;
	if (node?.__gjjHelpWidget) {
		moveHelpWidgetToFront(node, node.__gjjHelpWidget);
		scheduleHelpWidgetPositionUpdate(node);
		return node.__gjjHelpWidget;
	}

	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"position:relative",
		"width:100%",
		"height:0",
		"overflow:visible",
		"pointer-events:none",
		"box-sizing:border-box",
	].join(";");

	const button = document.createElement("button");
	button.type = "button";
	button.textContent = "❓";
	button.title = "查看这个节点的功能、模型和依赖";
	button.style.cssText = [
		"position:absolute",
		"left:calc(100% - 38px)",
		`top:${HELP_WIDGET_TOP}px`,
		"transform:none",
		`width:${HELP_WIDGET_WIDTH}px`,
		"height:18px",
		"padding:0",
		"border:1px solid rgba(152,214,209,0.45)",
		"border-radius:5px",
		"background:#26343b",
		"color:#e6f0eb",
		"font-size:12px",
		"line-height:16px",
		"cursor:pointer",
		"pointer-events:auto",
		"box-sizing:border-box",
	].join(";");
	button.addEventListener("pointerdown", (event) => event.stopPropagation());
	button.addEventListener("mousedown", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		showHelpDialog(node);
	});
	wrap.appendChild(button);

	let widget = node.addDOMWidget?.(HELP_WIDGET_NAME, HELP_WIDGET_NAME, wrap, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => 0,
	});
	if (widget) {
		widget.computeSize = () => [0, -4];
	}

	if (!widget && typeof node.addWidget === "function") {
		widget = node.addWidget("button", "❓", "", () => showHelpDialog(node), {
			serialize: false,
		});
		widget.computeSize = () => [32, 18];
	}

	node.__gjjHelpWidget = widget || { element: wrap };
	node.__gjjHelpWidgetState = { wrap, button, widget };
	moveHelpWidgetToFront(node, widget);
	scheduleHelpWidgetPositionUpdate(node);
	refreshNode(node);
	return node.__gjjHelpWidget;
}

function applyWidgetMetadata(node) {
	const meta = META_BY_CLASS.get(String(node?.comfyClass || ""));
	for (const widget of node?.widgets || []) {
		if (!widget || String(widget.name || "") === STATUS_WIDGET_NAME || String(widget.name || "").startsWith("gjj_")) {
			continue;
		}
		const widgetMeta = meta?.inputs?.get(String(widget.name || ""));
		const label = widgetMeta?.label
			|| localizeLabel(widget.options?.display_name || widget.label || "", String(widget.name || ""));
		const tooltip = widgetMeta?.tooltip
			|| localizeTooltip(widget.options?.tooltip || "", String(widget.name || ""), label);
		if (label) {
			setWidgetLabel(widget, label);
		}
		if (tooltip) {
			setWidgetTooltip(widget, tooltip);
		}
	}
}

function applySlotMetadata(node) {
	const meta = META_BY_CLASS.get(String(node?.comfyClass || ""));
	for (const input of node?.inputs || []) {
		const inputMeta = meta?.inputs?.get(String(input?.name || ""));
		const label = inputMeta?.label || localizeLabel(input?.localized_name || input?.label || "", String(input?.name || ""));
		const tooltip = inputMeta?.tooltip || localizeTooltip(input?.tooltip || "", String(input?.name || ""), label);
		if (label && label !== input?.name) {
			input.label = label;
			input.localized_name = label;
		}
		if (tooltip) {
			input.tooltip = tooltip;
		}
	}
	for (let index = 0; index < (node?.outputs || []).length; index += 1) {
		const output = node.outputs[index];
		const outputMeta = meta?.outputs?.[index];
		const label = outputMeta?.label || localizeLabel(output?.localized_name || output?.label || "", String(output?.name || ""));
		const tooltip = outputMeta?.tooltip || localizeTooltip(output?.tooltip || "", String(output?.name || ""), label);
		if (label && label !== output?.name) {
			output.label = label;
			output.localized_name = label;
		}
		if (tooltip) {
			output.tooltip = tooltip;
		}
	}
}

function ensureStatusWidget(node) {
	if (!shouldAttachStatus(node)) {
		return null;
	}
	if (node?.__gjjStandardStatus) {
		return node.__gjjStandardStatus;
	}

	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:none",
		"flex-direction:column",
		"gap:5px",
		"padding:6px 9px",
		"margin-top:2px",
		"border:1px solid rgba(78,99,110,0.45)",
		"border-radius:10px",
		"background:rgba(16,23,28,0.94)",
		"box-sizing:border-box",
	].join(";");

	const text = document.createElement("div");
	text.textContent = "等待执行";
	text.style.cssText = [
		"color:#d9e4e8",
		"font-size:12px",
		"line-height:1.35",
		"white-space:pre-wrap",
		"word-break:break-word",
	].join(";");

	const copyBtn = document.createElement("button");
	copyBtn.type = "button";
	GJJ_Utils.applyDependencyCopyButton(copyBtn, { visible: false });

	const progressOuter = document.createElement("div");
	progressOuter.style.cssText = [
		"height:6px",
		"border-radius:999px",
		"overflow:hidden",
		"background:rgba(69,86,96,0.35)",
	].join(";");

	const progressInner = document.createElement("div");
	progressInner.style.cssText = [
		"width:0%",
		"height:100%",
		"border-radius:999px",
		"background:linear-gradient(90deg,#4fd1c5,#7aa7ff)",
		"transition:width 0.18s ease",
	].join(";");

	progressOuter.appendChild(progressInner);
	wrap.append(text, copyBtn, progressOuter);

	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, wrap, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => node?.__gjjStandardStatus?.visible ? 78 : 0,
	});

	node.__gjjStandardStatus = {
		widget,
		wrap,
		text,
		progressInner,
		copyBtn,
		visible: false,
		progress: 0,
	};
	if (widget) {
		widget.mouse = function (event) {
			const type = String(event?.type || "");
			if (!["pointerdown", "mousedown", "click"].includes(type)) {
				return false;
			}
			return false;
		};
	}
	return node.__gjjStandardStatus;
}

function parseProgress(detail = {}, fallback = 0) {
	if (Number.isFinite(detail?.progress)) {
		return Math.max(0, Math.min(1, Number(detail.progress)));
	}
	const text = String(detail?.text || "");
	const match = text.match(/(\d+)\s*\/\s*(\d+)/);
	if (match) {
		const current = Math.max(0, Number(match[1] || 0));
		const total = Math.max(1, Number(match[2] || 1));
		return Math.max(0, Math.min(1, current / total));
	}
	if (/完成|成功|失败|耗时/.test(text)) {
		return 1;
	}
	return Math.max(0, Math.min(1, Number(fallback) || 0));
}

function formatElapsed(ms) {
	const seconds = Math.max(0, Number(ms || 0)) / 1000;
	if (seconds < 10) {
		return `${seconds.toFixed(2)}秒`;
	}
	if (seconds < 60) {
		return `${seconds.toFixed(1)}秒`;
	}
	const minutes = Math.floor(seconds / 60);
	return `${minutes}分${(seconds % 60).toFixed(1)}秒`;
}

function updateStatus(node, detail = {}, options = {}) {
	const state = ensureStatusWidget(node);
	if (!state) {
		return;
	}
	const visible = options.visible !== false;
	const text = String(detail?.text || "等待执行");
	const progress = parseProgress(detail, state.progress);
	const copyText = String(detail?.copy_text || detail?.install_command || detail?.model_download_url || options.copyText || "").trim();
	const copyLabel = String(detail?.copy_label || options.copyLabel || "").trim();
	state.visible = visible;
	state.wrap.style.display = visible ? "flex" : "none";
	state.text.textContent = text;
	state.progress = progress;
	state.progressInner.style.width = `${Math.round(progress * 100)}%`;
	if (state.copyBtn) {
		state.copyBtn.__gjj_copy_text = copyText;
		state.copyBtn.__gjj_install_cmd = copyText;
		GJJ_Utils.applyDependencyCopyButton(state.copyBtn, {
			copyText,
			copyLabel,
			visible: !!copyText,
		});
	}
	refreshNode(node);
}

function applyNodeMetadata(node) {
	if (!isGjjNode(node)) {
		return;
	}
	applyWidgetMetadata(node);
	applySlotMetadata(node);
	patchBoolSwitchWildcardInputs(node);
	protectDomWidgets(node);
	scheduleHelpWidgetPositionUpdate(node);
}

function seedInitialStatus(node) {
	if (!shouldAttachStatus(node) || node?.__gjjStandardStatus?.visible) {
		return;
	}
	const meta = META_BY_CLASS.get(String(node?.comfyClass || ""));
	const warningText = initialWarningText(meta);
	if (!warningText) {
		return;
	}
	updateStatus(node, { text: warningText, progress: 0, copy_text: statusCopyText(meta), copy_label: meta?.help?.copy_label || "" }, { visible: true });
}

function patchNode(node) {
	if (!isGjjNode(node)) {
		return;
	}
	patchAddDomWidget(node);
	const bypass = shouldBypassNode(node);
	if (bypass) {
		disableStatusWidget(node);
	}
	applyNodeMetadata(node);
	// FULLY_BYPASS_CLASSES 中的节点跳过 DOM widget 帮助按钮，使用 getTitleButtons API
	if (!bypass) {
		ensureHelpWidget(node);
	}
	if (!bypass && shouldAttachStatus(node)) {
		ensureStatusWidget(node);
	} else {
		disableStatusWidget(node);
	}

	if (node.__gjjStandardized) {
		return;
	}

	const originalOnConfigure = node.onConfigure;
	node.onConfigure = function (...args) {
		const result = originalOnConfigure?.apply(this, args);
		setTimeout(() => {
			applyNodeMetadata(this);
			protectDomWidgets(this);
			ensureHelpWidget(this);
			if (!shouldBypassNode(this) && shouldAttachStatus(this)) {
				ensureStatusWidget(this);
			}
			if (!shouldBypassNode(this) && shouldAttachStatus(this) && !this.__gjjStandardStatus?.visible) {
				updateStatus(this, {}, { visible: false });
			}
		}, 0);
		return result;
	};

	const originalOnConnectionsChange = node.onConnectionsChange;
	node.onConnectionsChange = function (...args) {
		const result = originalOnConnectionsChange?.apply(this, args);
		setTimeout(() => {
			applyNodeMetadata(this);
			protectDomWidgets(this);
			scheduleHelpWidgetPositionUpdate(this);
		}, 0);
		return result;
	};

	const originalOnExecuted = node.onExecuted;
	node.onExecuted = function (message) {
		const result = originalOnExecuted?.apply(this, arguments);
		if (shouldAttachStatus(this)) {
			const startedAt = Number(this.__gjjStandardStartedAt || 0);
			const elapsedText = startedAt > 0 ? `，耗时 ${formatElapsed(performance.now() - startedAt)}` : "";
			this.__gjjStandardStartedAt = 0;
			updateStatus(this, { text: `执行完成${elapsedText}`, progress: 1 }, { visible: true });
		}
		return result;
	};

	const originalOnResize = node.onResize;
	node.onResize = function (...args) {
		const result = originalOnResize?.apply(this, args);
		scheduleHelpWidgetPositionUpdate(this);
		return result;
	};

	node.__gjjStandardized = true;
	protectDomWidgets(node);
	requestAnimationFrame(() => protectDomWidgets(node));
	setTimeout(() => protectDomWidgets(node), 80);
	if (!shouldBypassNode(node) && shouldAttachStatus(node)) {
		updateStatus(node, {}, { visible: false });
		setTimeout(() => seedInitialStatus(node), 0);
	}
}

async function loadGjjSettings() {
	try {
		const resp = await api.fetchApi("/api/settings");
		if (resp?.ok) {
			window.__gjjSettings = await resp.json();
		}
	} catch (_) {}
}

app.registerExtension({
	name: "Comfy.GJJ.NodeStandardizer",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!isGjjNodeData(nodeData)) {
			return;
		}
		if (FULLY_BYPASS_CLASSES.has(String(nodeData?.name || ""))) {
			return;
		}

		META_BY_CLASS.set(String(nodeData?.name || ""), buildNodeMeta(nodeData));

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this);
			setTimeout(() => applyNodeMetadata(this), 0);
			return result;
		};
	},

	nodeCreated(node) {
		if (isGjjNode(node)) {
			patchNode(node);
		}
	},

	setup() {
			loadGjjSettings();
			loadBackendHelpMetadata().then(() => refreshGjjNodesAfterHelpLoad());

		api.addEventListener("executing", ({ detail }) => {
			const targetId = String(detail ?? "");
			for (const node of app.graph?._nodes || []) {
				if (!isGjjNode(node)) {
					continue;
				}
				if (String(node.id) === targetId) {
					patchNode(node);
					if (shouldAttachStatus(node)) {
						node.__gjjStandardStartedAt = performance.now();
						updateStatus(node, { text: "开始执行...", progress: 0.03 }, { visible: true });
					}
				}
			}
		});

		api.addEventListener("gjj_node_progress", (event) => {
			const detail = event?.detail || {};
			const targetId = String(detail?.node || "");
			for (const node of app.graph?._nodes || []) {
				if (!isGjjNode(node)) {
					continue;
				}
				if (String(node.id) === targetId) {
					patchNode(node);
					if (shouldAttachStatus(node)) {
						updateStatus(node, detail, { visible: true });
					}
				}
			}
		});

		api.addEventListener(DEPENDENCY_NOTICE_EVENT, (event) => {
			const detail = event?.detail || {};
			const targetId = String(detail?.node || "");
			for (const node of app.graph?._nodes || []) {
				if (!isGjjNode(node)) {
					continue;
				}
				if (targetId && String(node.id) !== targetId) {
					continue;
				}
				patchNode(node);
				applyNodeMetadata(node);
				updateStatus(node, {
					text: detail?.panel_message || detail?.warning_message || detail?.error || "",
					progress: 0,
					copy_text: detail?.copy_text || detail?.install_command || detail?.model_download_url || "",
					copy_label: detail?.copy_label || "",
				}, { visible: true });
				if (targetId) {
					break;
				}
			}
		});

		for (const node of app.graph?._nodes || []) {
			if (isGjjNode(node)) {
				patchNode(node);
			}
		}
	},
});
