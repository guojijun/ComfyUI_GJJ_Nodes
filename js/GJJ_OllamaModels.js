import { GJJ_Utils } from "./gjj_utils.js";
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set([
	"GJJ_Translation",
	"GJJ_PromptGeneration",
	"GJJ_ImageAnalysis",
]);
const DEFAULT_SYSTEM_PROMPT = "请根据输入图片或文字反推出适合 AI 绘图的高质量提示词，只输出正面提示词正文。";

const OLLAMA_HOSTS = [
	"http://127.0.0.1:11434",
	"http://localhost:11434",
];
const STATUS_WIDGET_NAME = "gjj_ollama_llm_status";
const DEFAULT_IMAGE_ANALYSIS_USER_PROMPT = "请提炼图片中的主体、环境、风格、镜头、构图、光线、材质与细节，并整理成适合文生图模型直接使用的高质量提示词。";

const NODE_WIDGET_LABELS = {
	GJJ_ImageAnalysis: {
		ollama_host: "Ollama 完整地址",
		model: "Ollama 模型",
		model_keep_alive: "模型处理",
		thinking_mode: "思考模式",
		temperature: "温度",
		max_tokens: "最大生成长度",
		system_prompt: "系统提示词",
		user_prompt: "用户提示词",
	},
	GJJ_PromptGeneration: {
		model: "Ollama 模型",
		model_keep_alive: "模型处理",
		thinking_mode: "思考模式",
		seed: "固定种子",
		temperature: "温度",
		max_tokens: "最大生成长度",
		system_prompt: "系统提示词",
		user_prompt: "用户提示词",
		ollama_host: "Ollama 完整地址",
	},
	GJJ_Translation: {
		text: "原文",
		model: "Ollama 模型",
		target_language: "目标语言",
		model_keep_alive: "模型处理",
		ollama_host: "Ollama 完整地址",
	},
};

function getModelWidget(node) {
	return GJJ_Utils.getWidget(node, "model");
}

function getSystemPromptWidget(node) {
	return GJJ_Utils.getWidget(node, "system_prompt");
}

function setWidgetLabel(widget, label) {
	if (!widget || !label) {
		return;
	}
	widget.label = label;
	widget.localized_name = label;
	if (widget.options && typeof widget.options === "object") {
		widget.options.display_name = label;
	}
}

function normalizeHostText(value) {
	const text = String(value || "").trim();
	if (!text) {
		return "";
	}
	return text.replace(/\/+$/, "").replace(/\/api$/i, "");
}

function buildHostFromWidgets(node) {
	const hostWidget = GJJ_Utils.getWidget(node, "ollama_host");
	if (!hostWidget) {
		return "";
	}

	let host = normalizeHostText(hostWidget.value);
	if (!host) {
		return "";
	}
	if (!/^https?:\/\//i.test(host)) {
		host = `http://${host}`;
	}

	try {
		const parsed = new URL(host);
		if (!parsed.port) {
			parsed.port = "11434";
		}
		return normalizeHostText(parsed.toString());
	} catch {
		return "";
	}
}

function migrateLegacyImageAnalysisNode(node) {
	if (!TARGET_NODES.has(node?.comfyClass)) {
		return;
	}

	for (const [name, label] of Object.entries(NODE_WIDGET_LABELS[node.comfyClass] || {})) {
		setWidgetLabel(GJJ_Utils.getWidget(node, name), label);
	}

	if (node.comfyClass !== "GJJ_ImageAnalysis") {
		return;
	}

	const hostWidget = GJJ_Utils.getWidget(node, "ollama_host");
	const portWidget = GJJ_Utils.getWidget(node, "ollama_port");
	if (hostWidget && portWidget) {
		let host = normalizeHostText(hostWidget.value);
		const portValue = Number.parseInt(String(portWidget.value ?? ""), 10);
		if (host && !/^https?:\/\//i.test(host)) {
			host = `http://${host}`;
		}
		try {
			const parsed = new URL(host || "http://127.0.0.1");
			if (!parsed.port && !Number.isNaN(portValue) && portValue > 0) {
				parsed.port = String(portValue);
			} else if (!parsed.port) {
				parsed.port = "11434";
			}
			hostWidget.value = normalizeHostText(parsed.toString());
			hostWidget.callback?.(hostWidget.value);
		} catch {
			// noop
		}

		const index = node.widgets?.indexOf(portWidget) ?? -1;
		if (index >= 0) {
			node.widgets.splice(index, 1);
		}
	}

	for (const [name, allowed, fallback] of [
		["model_keep_alive", ["保持模型", "卸载模型"], "保持模型"],
		["thinking_mode", ["关闭思考", "开启思考"], "关闭思考"],
	]) {
		const widget = GJJ_Utils.getWidget(node, name);
		if (!widget || allowed.includes(String(widget.value ?? ""))) {
			continue;
		}
		widget.value = fallback;
		widget.callback?.(widget.value);
	}

	for (const [name, fallback] of [
		["temperature", 0.7],
		["max_tokens", 1024],
	]) {
		const widget = GJJ_Utils.getWidget(node, name);
		const value = Number(widget?.value);
		if (widget && !Number.isFinite(value)) {
			widget.value = fallback;
			widget.callback?.(widget.value);
		}
	}

	const systemPromptWidget = GJJ_Utils.getWidget(node, "system_prompt");
	if (systemPromptWidget && (!String(systemPromptWidget.value || "").trim() || Number.isFinite(Number(systemPromptWidget.value)))) {
		systemPromptWidget.value = DEFAULT_SYSTEM_PROMPT;
		systemPromptWidget.callback?.(systemPromptWidget.value);
	}

	const userPromptWidget = GJJ_Utils.getWidget(node, "user_prompt");
	if (userPromptWidget && Number.isFinite(Number(userPromptWidget.value))) {
		userPromptWidget.value = DEFAULT_IMAGE_ANALYSIS_USER_PROMPT;
		userPromptWidget.callback?.(userPromptWidget.value);
	}

	const modelWidget = getModelWidget(node);
	const values = Array.isArray(modelWidget?.options?.values) ? modelWidget.options.values : [];
	if (modelWidget && values.length > 0 && !values.includes(modelWidget.value)) {
		modelWidget.value = values[0];
		modelWidget.callback?.(modelWidget.value);
	}
}

function ensureStatusWidget(node) {
	if (node?.__gjjOllamaStatus) {
		return node.__gjjOllamaStatus;
	}

	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"padding:10px 12px",
		"border:1px solid rgba(92,118,134,0.45)",
		"border-radius:12px",
		"background:linear-gradient(180deg, rgba(22,29,34,0.96), rgba(15,20,24,0.96))",
		"box-sizing:border-box",
	].join(";");

	const text = document.createElement("div");
	text.textContent = "等待执行";
	text.style.cssText = [
		"color:#dfe7ec",
		"font-size:12px",
		"line-height:1.5",
		"white-space:pre-wrap",
		"word-break:break-word",
	].join(";");

	const progressOuter = document.createElement("div");
	progressOuter.style.cssText = [
		"height:7px",
		"border-radius:999px",
		"background:rgba(73,92,106,0.35)",
		"overflow:hidden",
	].join(";");

	const progressInner = document.createElement("div");
	progressInner.style.cssText = [
		"width:0%",
		"height:100%",
		"border-radius:999px",
		"background:linear-gradient(90deg, #36cfc9, #6ea8ff)",
		"transition:width 0.18s ease",
	].join(";");

	progressOuter.appendChild(progressInner);
	wrap.append(text, progressOuter);

	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, wrap, {
		serialize: false,
		hideOnZoom: false,
	});
	node.__gjjOllamaStatus = { widget, wrap, text, progressInner };
	return node.__gjjOllamaStatus;
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

function setStatus(node, detail = {}) {
	const state = ensureStatusWidget(node);
	const text = String(detail?.text || "等待执行");
	const progressValue = Number(detail?.progress);
	const progress = Number.isFinite(progressValue)
		? Math.max(0, Math.min(1, progressValue))
		: (/完成|成功|耗时/.test(text) ? 1 : 0);
	state.text.textContent = text;
	state.progressInner.style.width = `${Math.round(progress * 100)}%`;
	GJJ_Utils.refreshNode(node);
}

function setWidgetOptions(widget, values) {
	if (!widget || !Array.isArray(values) || values.length === 0) {
		return;
	}

	widget.options = widget.options || {};
	widget.options.values = values;

	if (!values.includes(widget.value)) {
		widget.value = values[0];
		widget.callback?.(widget.value);
	}
}

function parseModelSize(modelName) {
	const name = String(modelName || "").trim().toLowerCase();
	if (!name) {
		return Number.POSITIVE_INFINITY;
	}

	const matches = [...name.matchAll(/(?:^|[:/\-_])(?:e)?(\d+(?:\.\d+)?)b(?:$|[:/\-_])/g)];
	if (matches.length === 0) {
		return Number.POSITIVE_INFINITY;
	}

	const sizes = matches
		.map((match) => Number.parseFloat(match[1]))
		.filter((value) => !Number.isNaN(value));
	return sizes.length > 0 ? Math.min(...sizes) : Number.POSITIVE_INFINITY;
}

function sortModels(values) {
	return [...values].sort((a, b) => {
		const sizeDiff = parseModelSize(a) - parseModelSize(b);
		if (sizeDiff !== 0) {
			return sizeDiff;
		}
		return String(a).localeCompare(String(b));
	});
}

function buildCandidateHosts(node) {
	const customHost = buildHostFromWidgets(node);
	if (customHost) {
		return [customHost];
	}
	return [...OLLAMA_HOSTS];
}

async function fetchModels(node) {
	for (const host of buildCandidateHosts(node)) {
		try {
			const response = await fetch(`${host}/api/tags`);
			if (!response.ok) {
				continue;
			}
			const data = await response.json();
			const models = Array.isArray(data?.models) ? data.models : [];
			const names = [];
			for (const item of models) {
				const name = String(item?.name || item?.model || "").trim();
				if (name && !names.includes(name)) {
					names.push(name);
				}
			}
			if (names.length > 0) {
				return sortModels(names);
			}
		} catch (error) {
			// noop: try next host
		}
	}
	return [];
}

async function refreshNodeModels(node) {
	const widget = getModelWidget(node);
	if (!widget) {
		return;
	}

	const names = await fetchModels(node);
	if (names.length === 0) {
		return;
	}

	setWidgetOptions(widget, names);
	node.setDirtyCanvas?.(true, true);
	app.graph.setDirtyCanvas(true, true);
}

function applyDefaultSystemPrompt(node) {
	const widget = getSystemPromptWidget(node);
	if (!widget) {
		return;
	}

	if (!String(widget.value || "").trim()) {
		widget.value = DEFAULT_SYSTEM_PROMPT;
		widget.callback?.(widget.value);
	}
}

function bindHostRefresh(node) {
	for (const widgetName of ["ollama_host"]) {
		const widget = GJJ_Utils.getWidget(node, widgetName);
		if (!widget || widget.__gjjOllamaModelsBound) {
			continue;
		}
		widget.__gjjOllamaModelsBound = true;
		const originalCallback = widget.callback;
		widget.callback = function (...args) {
			const result = originalCallback?.apply(this, args);
			setTimeout(() => refreshNodeModels(node), 10);
			return result;
		};
	}
}

function patchNode(node) {
	if (!node || !TARGET_NODES.has(node.comfyClass)) {
		return;
	}
	migrateLegacyImageAnalysisNode(node);
	applyDefaultSystemPrompt(node);
	ensureStatusWidget(node);
	bindHostRefresh(node);

	if (node.__gjjOllamaPatched) {
		if (!node.__gjjOllamaStatus?.text?.textContent) {
			setStatus(node, { text: "等待执行", progress: 0 });
		}
		return;
	}

	const originalOnConfigure = node.onConfigure;
	node.onConfigure = function (...args) {
		const result = originalOnConfigure?.apply(this, args);
		setTimeout(() => {
			migrateLegacyImageAnalysisNode(this);
			applyDefaultSystemPrompt(this);
			ensureStatusWidget(this);
			bindHostRefresh(this);
			if (!this.__gjjOllamaStatus?.text?.textContent) {
				setStatus(this, { text: "等待执行", progress: 0 });
			}
		}, 0);
		return result;
	};

	const originalOnExecuted = node.onExecuted;
	node.onExecuted = function (message) {
		const result = originalOnExecuted?.apply(this, arguments);
		ensureStatusWidget(this);
		const startedAt = Number(this.__gjjOllamaStartedAt || 0);
		const elapsedText = startedAt > 0 ? `，耗时 ${formatElapsed(performance.now() - startedAt)}` : "";
		this.__gjjOllamaStartedAt = 0;
		setStatus(this, { text: `执行完成${elapsedText}`, progress: 1 });
		return result;
	};

	setStatus(node, { text: "等待执行", progress: 0 });
	node.__gjjOllamaPatched = true;
}

app.registerExtension({
	name: "Comfy.GJJ.OllamaModels",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this);
			setTimeout(() => refreshNodeModels(this), 50);
			setTimeout(() => refreshNodeModels(this), 1000);
			return result;
		};
	},

	async nodeCreated(node) {
		if (TARGET_NODES.has(node?.comfyClass)) {
			patchNode(node);
			setTimeout(() => refreshNodeModels(node), 50);
		}
	},

	setup() {
		api.addEventListener("executing", ({ detail }) => {
			for (const node of app.graph?._nodes || []) {
				if (!TARGET_NODES.has(node?.comfyClass)) {
					continue;
				}
				if (detail === node.id) {
					patchNode(node);
					node.__gjjOllamaStartedAt = performance.now();
					setStatus(node, { text: "开始执行...", progress: 0.03 });
				}
			}
		});

		api.addEventListener("gjj_node_progress", (event) => {
			const detail = event?.detail || {};
			const nodeId = String(detail.node || "");
			for (const node of app.graph?._nodes || []) {
				if (!TARGET_NODES.has(node?.comfyClass)) {
					continue;
				}
				if (String(node.id) === nodeId) {
					patchNode(node);
					setStatus(node, detail);
				}
			}
		});

		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				patchNode(node);
			}
		}
	},
});
