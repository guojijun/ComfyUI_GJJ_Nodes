import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const NODE_TYPE = "GJJ_OllamaAssistant";
const PANEL_WIDGET = "gjj_ollama_assistant_panel";
const TEMPLATE_WIDGET = "system_prompt_templates";
const OUTPUT_RULE_WIDGET = "system_prompt_output_rule";
const HIDDEN_WIDGETS = new Set([
	"ollama_host",
	"model",
	"model_keep_alive",
	"thinking_mode",
	"temperature",
	"max_tokens",
	"system_prompt",
	TEMPLATE_WIDGET,
	OUTPUT_RULE_WIDGET,
	"user_prompt",
]);
const DEFAULT_TEMPLATE_TEXT = [
	"【🧡图片反推】准确识别参考图片中的主体、人物外貌、服装、动作、场景结构、镜头构图、光线、色调、材质和关键细节，整理为可直接用于图像或视频生成的连贯画面描述。",
	"",
	"【🎬分镜延展】基于参考图片或输入描述生成连续分镜内容，保持人物身份、核心服装、场景和整体色调一致，同时推动镜头、构图、动作、表情与环境变化，使相邻画面自然衔接且具有叙事进展。",
	"",
	"【🌏中译英】将输入内容精准翻译为英文，保持原有语序结构、提示词权重符号、专有名词和画面语义；使用适合 AI 图像与视频生成的自然英文表达。",
].join("\n");
const DEFAULT_OUTPUT_RULE = "只输出结果文字，不输出解释、分析过程、标题、Markdown 代码块或提示性前缀。";

function widget(node, name) {
	return GJJ_Utils.getWidget(node, name);
}

function widgetValue(node, name, fallback = "") {
	return widget(node, name)?.value ?? fallback;
}

function protect(element) {
	if (!element || element.__gjjOllamaAssistantProtected) {
		return element;
	}
	element.__gjjOllamaAssistantProtected = true;
	for (const eventName of ["pointerdown", "mousedown", "dblclick", "contextmenu", "wheel"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
	return element;
}

function markChanged(node) {
	node.graph?.change?.();
	GJJ_Utils.dirtyCanvas(node);
}

function setWidgetValue(node, name, value) {
	const target = widget(node, name);
	if (!target) {
		return;
	}
	target.value = value;
	if (target.inputEl && "value" in target.inputEl) {
		target.inputEl.value = value;
	}
	if (target.element && "value" in target.element) {
		target.element.value = value;
	}
	target.callback?.(value, app.canvas, node, undefined, target);
	markChanged(node);
}

function splitTemplateBlocks(rawText) {
	const blocks = [];
	let current = [];
	for (const line of String(rawText || "").replace(/\r\n/g, "\n").split("\n")) {
		if (/^\s*-{3,}\s*$/.test(line) || (!line.trim() && current.some((item) => item.trim()))) {
			blocks.push(current.join("\n").trim());
			current = [];
			continue;
		}
		if (!line.trim() && !current.length) {
			continue;
		}
		current.push(line);
	}
	if (current.some((item) => item.trim())) {
		blocks.push(current.join("\n").trim());
	}
	return blocks.filter(Boolean);
}

function parseTemplateText(rawText) {
	const blocks = splitTemplateBlocks(rawText || DEFAULT_TEMPLATE_TEXT);
	const templates = [];
	for (let index = 0; index < blocks.length; index += 1) {
		const block = blocks[index];
		const match = block.match(/^【([^】]+)】\s*([\s\S]*)$/);
		const title = String(match?.[1] || `模板${index + 1}`).trim();
		const text = String(match?.[2] || block).trim();
		if (!title || !text) {
			continue;
		}
		templates.push({
			key: `${index}:${title}`,
			title,
			text,
		});
	}
	return templates.length ? templates : parseTemplateText(DEFAULT_TEMPLATE_TEXT);
}

function readTemplateConfig(node) {
	const rawTemplates = String(widgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE_TEXT) || DEFAULT_TEMPLATE_TEXT);
	const outputRule = String(widgetValue(node, OUTPUT_RULE_WIDGET, DEFAULT_OUTPUT_RULE) || "").trim();
	const templates = parseTemplateText(rawTemplates);
	return {
		outputRule,
		templates,
		signature: JSON.stringify([rawTemplates, outputRule]),
	};
}

function templatePrompt(config, item) {
	if (!item?.text) {
		return "";
	}
	const outputRule = String(config?.outputRule || "").trim();
	return [item.text.trim(), outputRule].filter(Boolean).join("\n");
}

function resizeNode(node) {
	GJJ_Utils.scheduleRefreshNode(node, {
		minWidth: 470,
		minHeight: 92,
		preserveWidth: true,
	});
}

function hideBackerWidgets(node) {
	for (const name of HIDDEN_WIDGETS) {
		GJJ_Utils.hideWidget(widget(node, name));
	}
	GJJ_Utils.removeHiddenInputSockets(node, HIDDEN_WIDGETS);
	GJJ_Utils.reorderWidgets(node, HIDDEN_WIDGETS);
}

function button(label, title, handler) {
	const element = document.createElement("button");
	element.type = "button";
	element.className = "gjj-ia-button";
	element.textContent = label;
	element.title = title;
	protect(element);
	element.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		handler();
	});
	return element;
}

function textField(type, title) {
	const element = document.createElement("input");
	element.type = type;
	element.title = title;
	element.className = "gjj-ia-input";
	element.autocomplete = "off";
	protect(element);
	return element;
}

function labelledField(label, control) {
	const line = document.createElement("label");
	line.className = "gjj-ia-field";
	const name = document.createElement("span");
	name.textContent = label;
	name.className = "gjj-ia-label";
	line.append(name, control);
	return line;
}

function syncInputValue(control, value) {
	if (document.activeElement !== control && control.value !== String(value ?? "")) {
		control.value = String(value ?? "");
	}
}

function modelChoices(node) {
	const modelWidget = widget(node, "model");
	let values = modelWidget?.options?.values;
	if (typeof values === "function") {
		try {
			values = values();
		} catch (_) {
			values = [];
		}
	}
	values = Array.isArray(values) ? values.map((value) => String(value || "").trim()).filter(Boolean) : [];
	const selected = String(modelWidget?.value || "").trim();
	if (selected && !values.includes(selected)) {
		values.unshift(selected);
	}
	return values;
}

function renderModelButtons(node) {
	const state = node.__gjjOllamaAssistantPanel;
	if (!state) {
		return;
	}
	const selected = String(widgetValue(node, "model", ""));
	const values = modelChoices(node);
	const signature = JSON.stringify([selected, values]);
	if (state.modelSignature === signature) {
		return;
	}
	state.modelSignature = signature;
	state.models.replaceChildren();
	if (!values.length) {
		const empty = document.createElement("span");
		empty.className = "gjj-ia-empty";
		empty.textContent = "未发现 Ollama 模型，请检查地址后刷新。";
		state.models.appendChild(empty);
		return;
	}
	for (const name of values) {
		const choice = button(`🤖 ${name}`, `使用 Ollama 模型：${name}`, () => {
			setWidgetValue(node, "model", name);
			renderModelButtons(node);
			syncPanel(node);
		});
		choice.classList.toggle("active", name === selected);
		state.models.appendChild(choice);
	}
}

function renderTemplateButtons(node, config) {
	const state = node.__gjjOllamaAssistantPanel;
	if (!state || state.templateSignature === config.signature) {
		return;
	}
	state.templateSignature = config.signature;
	state.templateConfig = config;
	state.templates.replaceChildren();
	state.templateButtons = new Map();
	for (const item of config.templates) {
		const label = String(item.title || item.key || "模板").replace(/\s+/g, "");
		const choice = button(label, `设置系统提示词模板：${label}`, () => {
			setWidgetValue(node, "system_prompt", templatePrompt(config, item));
			syncPanel(node);
		});
		state.templateButtons.set(item.key, { button: choice, item });
		state.templates.appendChild(choice);
	}
}

function syncPanel(node) {
	const state = node.__gjjOllamaAssistantPanel;
	if (!state) {
		return;
	}
	const thinking = String(widgetValue(node, "thinking_mode", "关闭思考")) === "开启思考";
	const unload = String(widgetValue(node, "model_keep_alive", "保持模型")) === "卸载模型";
	state.thinking.textContent = thinking ? "💭 思考 开" : "💭 思考 关";
	state.thinking.classList.toggle("active", thinking);
	state.keepAlive.textContent = unload ? "🧹 用后卸载" : "🧠 模型常驻";
	state.keepAlive.classList.toggle("active", !unload);
	state.settingsButton.textContent = state.expanded ? "⚙️ 收起" : "⚙️ 设置";
	state.settingsButton.classList.toggle("active", state.expanded);
	state.settings.style.display = state.expanded ? "flex" : "none";

	syncInputValue(state.host, widgetValue(node, "ollama_host", "http://127.0.0.1:11434"));
	syncInputValue(state.temperature, widgetValue(node, "temperature", 0.7));
	syncInputValue(state.maxTokens, widgetValue(node, "max_tokens", 1024));
	syncInputValue(state.systemPrompt, widgetValue(node, "system_prompt", ""));
	syncInputValue(state.templateEditor, widgetValue(node, TEMPLATE_WIDGET, DEFAULT_TEMPLATE_TEXT));
	syncInputValue(state.outputRule, widgetValue(node, OUTPUT_RULE_WIDGET, DEFAULT_OUTPUT_RULE));
	syncInputValue(state.userPrompt, widgetValue(node, "user_prompt", ""));

	const templateConfig = readTemplateConfig(node);
	renderTemplateButtons(node, templateConfig);
	const currentPrompt = String(widgetValue(node, "system_prompt", ""));
	for (const entry of state.templateButtons?.values?.() || []) {
		entry.button.classList.toggle("active", currentPrompt === templatePrompt(state.templateConfig, entry.item));
	}
	renderModelButtons(node);
	resizeNode(node);
}

function buildSettings(node) {
	const settings = document.createElement("div");
	settings.className = "gjj-ia-settings";

	const host = textField("text", "本机 Ollama 服务地址");
	host.placeholder = "http://127.0.0.1:11434";
	host.addEventListener("change", () => {
		setWidgetValue(node, "ollama_host", host.value.trim());
		setTimeout(() => renderModelButtons(node), 1200);
	});

	const numeric = document.createElement("div");
	numeric.className = "gjj-ia-numeric";
	const temperature = textField("number", "数值越低越稳定，越高越发散");
	temperature.min = "0";
	temperature.max = "2";
	temperature.step = "0.1";
	temperature.addEventListener("change", () => {
		const value = Math.max(0, Math.min(2, Number(temperature.value) || 0));
		setWidgetValue(node, "temperature", value);
		syncPanel(node);
	});
	const maxTokens = textField("number", "最多返回的 token 数量");
	maxTokens.min = "16";
	maxTokens.max = "8192";
	maxTokens.step = "1";
	maxTokens.addEventListener("change", () => {
		const value = Math.max(16, Math.min(8192, Math.round(Number(maxTokens.value) || 1024)));
		setWidgetValue(node, "max_tokens", value);
		syncPanel(node);
	});
	numeric.append(labelledField("🌡 温度", temperature), labelledField("📏 最大长度", maxTokens));

	const modelTitle = document.createElement("div");
	modelTitle.className = "gjj-ia-subtitle";
	modelTitle.textContent = "🤖 Ollama 模型";
	const refresh = button("🔄 刷新模型", "按照当前 Ollama 地址重新获取模型列表", () => {
		setWidgetValue(node, "ollama_host", String(widgetValue(node, "ollama_host", "")).trim());
		setTimeout(() => renderModelButtons(node), 120);
		setTimeout(() => renderModelButtons(node), 1200);
	});
	modelTitle.appendChild(refresh);
	const models = document.createElement("div");
	models.className = "gjj-ia-models";

	const systemPrompt = document.createElement("textarea");
	systemPrompt.className = "gjj-ia-textarea";
	systemPrompt.placeholder = "点击上方模板按钮自动写入，或在这里自定义系统提示词。";
	protect(systemPrompt);
	systemPrompt.addEventListener("input", () => {
		setWidgetValue(node, "system_prompt", systemPrompt.value);
		syncPanel(node);
	});

	const templateEditor = document.createElement("textarea");
	templateEditor.className = "gjj-ia-textarea templates";
	templateEditor.placeholder = "每块一个按钮：\n【🧡图片反推】系统提示词正文\n\n【🎬分镜延展】系统提示词正文\n---\n【🌏中译英】系统提示词正文";
	protect(templateEditor);
	templateEditor.addEventListener("input", () => {
		setWidgetValue(node, TEMPLATE_WIDGET, templateEditor.value);
		syncPanel(node);
	});

	const outputRule = document.createElement("textarea");
	outputRule.className = "gjj-ia-textarea rule";
	outputRule.placeholder = "点击模板按钮时追加到系统提示词正文之后，可留空。";
	protect(outputRule);
	outputRule.addEventListener("input", () => {
		setWidgetValue(node, OUTPUT_RULE_WIDGET, outputRule.value);
		syncPanel(node);
	});

	const userPrompt = document.createElement("textarea");
	userPrompt.className = "gjj-ia-textarea small";
	userPrompt.placeholder = "输入需要生成或翻译的文本；只做图片理解时可留空。";
	protect(userPrompt);
	userPrompt.addEventListener("input", () => {
		setWidgetValue(node, "user_prompt", userPrompt.value);
	});

	settings.append(
		labelledField("🔌 Ollama 地址", host),
		numeric,
		modelTitle,
		models,
		labelledField("🧩 系统提示词模板", templateEditor),
		labelledField("🚫 输出约束", outputRule),
		labelledField("🧾 当前系统提示词", systemPrompt),
	);

	return { settings, host, temperature, maxTokens, models, systemPrompt, templateEditor, outputRule, userPrompt };
}

function createPanel(node) {
	if (node.__gjjOllamaAssistantPanel || typeof node.addDOMWidget !== "function") {
		return;
	}
	const root = document.createElement("div");
	root.className = "gjj-ia-panel";
	protect(root);
	const style = document.createElement("style");
	style.textContent = `
		.gjj-ia-panel, .gjj-ia-panel * { box-sizing:border-box; }
		.gjj-ia-panel { display:flex; flex-direction:column; gap:7px; width:100%; padding:2px 0 4px; color:#dce6e8; font:12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
		.gjj-ia-toolbar { display:flex; flex-wrap:nowrap; align-items:center; gap:5px; overflow-x:auto; padding:0 0 3px; scrollbar-width:thin; }
		.gjj-ia-templates { display:contents; }
		.gjj-ia-button { flex:0 0 auto; height:27px; padding:0 9px; border:1px solid #3d5159; border-radius:6px; background:#172127; color:#dbe6e9; font:700 12px/25px system-ui, sans-serif; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:220px; }
		.gjj-ia-button:hover { background:#24333b; border-color:#5f8590; }
		.gjj-ia-button.active { background:#24452d; border-color:#65a271; color:#ebffee; }
		.gjj-ia-settings { display:none; flex-direction:column; gap:7px; padding:8px; border:1px solid rgba(73,93,101,.7); border-radius:9px; background:rgba(15,22,26,.88); }
		.gjj-ia-field { display:flex; flex-direction:column; gap:4px; min-width:0; }
		.gjj-ia-label, .gjj-ia-subtitle { color:#aebfc4; font-weight:700; font-size:11px; letter-spacing:.02em; }
		.gjj-ia-input, .gjj-ia-textarea { width:100%; border:1px solid #334850; border-radius:6px; background:#10181c; color:#eef5f5; padding:5px 7px; outline:none; font:12px/1.4 system-ui, sans-serif; }
		.gjj-ia-input { height:29px; }
		.gjj-ia-input:focus, .gjj-ia-textarea:focus { border-color:#6a9dae; background:#111e23; }
		.gjj-ia-numeric { display:grid; grid-template-columns:1fr 1fr; gap:7px; }
		.gjj-ia-subtitle { display:flex; justify-content:space-between; align-items:center; margin-top:2px; }
		.gjj-ia-subtitle .gjj-ia-button { height:24px; font-size:11px; line-height:22px; }
		.gjj-ia-models { display:flex; flex-wrap:wrap; gap:5px; min-height:28px; }
		.gjj-ia-models .gjj-ia-button { max-width:100%; font-weight:500; }
		.gjj-ia-empty { color:#8b9ba1; font-size:11px; padding:5px 0; }
		.gjj-ia-textarea { min-height:86px; resize:vertical; font-family:ui-monospace, SFMono-Regular, Consolas, monospace; }
		.gjj-ia-textarea.small { min-height:60px; }
		.gjj-ia-textarea.rule { min-height:48px; }
		.gjj-ia-textarea.templates { min-height:118px; }
	`;
	const toolbar = document.createElement("div");
	toolbar.className = "gjj-ia-toolbar";
	const templates = document.createElement("div");
	templates.className = "gjj-ia-templates";
	const thinking = button("💭 思考 关", "切换模型思考模式", () => {
		const value = String(widgetValue(node, "thinking_mode", "关闭思考")) === "开启思考" ? "关闭思考" : "开启思考";
		setWidgetValue(node, "thinking_mode", value);
		syncPanel(node);
	});
	const keepAlive = button("🧠 模型常驻", "切换任务完成后是否卸载模型", () => {
		const value = String(widgetValue(node, "model_keep_alive", "保持模型")) === "保持模型" ? "卸载模型" : "保持模型";
		setWidgetValue(node, "model_keep_alive", value);
		syncPanel(node);
	});
	const settingsButton = button("⚙ 设置", "展开 Ollama 地址、模型、参数和提示词设置", () => {
		node.__gjjOllamaAssistantPanel.expanded = !node.__gjjOllamaAssistantPanel.expanded;
		syncPanel(node);
	});
	toolbar.append(templates, thinking, keepAlive, settingsButton);

	const settingsState = buildSettings(node);
	const instruction = labelledField("📝 指令 / 原文", settingsState.userPrompt);
	root.append(style, toolbar, instruction, settingsState.settings);

	const domWidget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
	});
	domWidget.computeSize = (width) => [
		Math.max(470, Number(width || node.size?.[0] || 470)),
		Math.max(35, Math.ceil(root.scrollHeight || 35)),
	];
	node.__gjjOllamaAssistantPanel = {
		root,
		domWidget,
		templates,
		templateButtons: new Map(),
		thinking,
		keepAlive,
		settingsButton,
		expanded: false,
		...settingsState,
	};

	const index = node.widgets?.indexOf(domWidget) ?? -1;
	if (index > 0) {
		node.widgets.splice(index, 1);
		node.widgets.unshift(domWidget);
	}
	syncPanel(node);
	setTimeout(() => syncPanel(node), 120);
	setTimeout(() => syncPanel(node), 1200);
}

function stabilize(node) {
	if (!node || String(node.comfyClass || node.type || "") !== NODE_TYPE) {
		return;
	}
	hideBackerWidgets(node);
	createPanel(node);
	syncPanel(node);
}

function schedule(node, delay = 0) {
	setTimeout(() => stabilize(node), delay);
}

app.registerExtension({
	name: "GJJ.OllamaAssistant.Panel",

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) {
			return;
		}
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			schedule(this);
			schedule(this, 80);
			schedule(this, 1250);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			schedule(this);
			schedule(this, 80);
			return result;
		};
	},

	nodeCreated(node) {
		if (String(node?.comfyClass || node?.type || "") === NODE_TYPE) {
			schedule(node);
		}
	},
});
