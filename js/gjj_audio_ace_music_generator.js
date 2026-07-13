import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_AudioAceMusicGenerator"]);
const STATUS_WIDGET_NAME = "gjj_audio_ace_music_status";
const AUDIO_WIDGET_NAME = "gjj_audio_ace_music_audio";
const COMPACT_PANEL_HEIGHT = 40;
const COMPACT_NODE_HEIGHT = 260;
const PARAM_ORDER = [
	"model_name",
	"tags",
	"lyrics",
	"duration",
	"bpm",
	"timesignature",
	"language",
	"keyscale",
	"seed",
	"lyrics_strength",
	"generate_audio_codes",
	"cfg_scale",
	"temperature",
	"top_p",
	"top_k",
	"min_p",
	"shift",
	"steps",
	"cfg",
	"sampler_name",
	"scheduler",
	"denoise",
	"clip_1_name",
	"clip_2_name",
	"vae_name",
	"model_test_mode",
];
const HIDDEN_HOME_WIDGETS = new Set([
	"model_name",
	"duration",
	"bpm",
	"timesignature",
	"language",
	"keyscale",
	"seed",
	"lyrics_strength",
	"generate_audio_codes",
	"cfg_scale",
	"temperature",
	"top_p",
	"top_k",
	"min_p",
	"shift",
	"steps",
	"cfg",
	"sampler_name",
	"scheduler",
	"denoise",
	"clip_1_name",
	"clip_2_name",
	"vae_name",
	"model_test_mode",
]);
const PANEL_GROUPS = {
	seed: { title: "🎲 种子", names: ["seed"] },
	music: { title: "🌐 音乐结构", names: ["bpm", "timesignature", "language", "keyscale"] },
	text: { title: "🪄 文本采样", names: ["lyrics_strength", "cfg_scale", "temperature", "top_p", "top_k", "min_p"] },
	model: { title: "🧠 模型相关", names: ["shift", "generate_audio_codes"] },
	generate: { title: "⚡ 生成参数", names: ["duration", "steps", "cfg", "sampler_name", "scheduler", "denoise"] },
	other: { title: "⚙️ 其它参数", names: ["generate_audio_codes"] },
};

function isExecutionOutputNode(node) {
	if (!node) return false;
	if (node === undefined || node === null) return false;
	if (node.comfyClass === "GJJ_AudioAceMusicGenerator") return true;
	if (node.constructor?.nodeData?.output_node === true) return true;
	if (node.nodeData?.output_node === true) return true;
	if (node.flags?.output === true) return true;
	return false;
}

async function queueOnlyCurrentNode(node) {
	if (!node || !node.graph) return false;

	const graph = node.graph || app.graph;
	const allNodes = graph?._nodes || app.graph?._nodes || [];

	const savedModes = [];
	const oldSelectedNodes = app.canvas?.selected_nodes;
	const oldSelectedNode = app.canvas?.selected_node;

	try {
		for (const n of allNodes) {
			if (!n || n === node) continue;
			if (isExecutionOutputNode(n)) {
				savedModes.push([n, n.mode]);
				n.mode = 2;
			}
		}

		if (app.canvas) {
			app.canvas.selected_nodes = {};
			app.canvas.selected_nodes[node.id] = node;
			app.canvas.selected_node = node;
		}

		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);

		if (typeof app.queuePrompt === "function") {
			await app.queuePrompt(0, 1);
			return true;
		}

		console.warn("[GJJ] app.queuePrompt 不存在，无法只刷新当前节点");
		return false;
	} finally {
		for (const [n, mode] of savedModes) {
			n.mode = mode;
		}

		if (app.canvas) {
			app.canvas.selected_nodes = oldSelectedNodes;
			app.canvas.selected_node = oldSelectedNode;
		}

		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	}
}

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function orderedParamValues(node) {
	return PARAM_ORDER.map((name) => getWidget(node, name)?.value);
}

function syncOrderedWidgetValues(node) {
	if (!node) return;
	node.widgets_values = orderedParamValues(node);
}

function applyOrderedWidgetValues(node, values) {
	if (!node || !Array.isArray(values)) return;
	for (let index = 0; index < PARAM_ORDER.length; index += 1) {
		if (index >= values.length) break;
		const widget = getWidget(node, PARAM_ORDER[index]);
		if (!widget) continue;
		widget.value = values[index];
		try {
			widget.callback?.(widget.value);
		} catch (_) {}
	}
	syncOrderedWidgetValues(node);
}

function writePromptInputsFromWidgets(node, promptData) {
	const promptNode = promptData?.prompt?.[String(node?.id)] || promptData?.prompt?.[node?.id];
	if (!promptNode?.inputs) return;
	for (const name of PARAM_ORDER) {
		const widget = getWidget(node, name);
		if (widget) {
			promptNode.inputs[name] = widget.value;
		}
	}
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) return;
	widget.value = value;
	try {
		widget.callback?.(value);
	} catch (_) {}
	if (Array.isArray(node.widgets_values)) {
		const index = PARAM_ORDER.indexOf(name);
		if (index >= 0) {
			node.widgets_values[index] = value;
		}
	}
	syncOrderedWidgetValues(node);
	node.graph && (node.graph._version += 1);
	refreshNode(node);
}

function hideHomeWidgets(node) {
	for (const name of HIDDEN_HOME_WIDGETS) {
		GJJ_Utils.hideWidget(getWidget(node, name));
	}
}

function restoreParameterWidgetOrder(node) {
	if (!node || !Array.isArray(node.widgets)) return;
	const ordered = [];
	const used = new Set();
	for (const name of PARAM_ORDER) {
		const widget = getWidget(node, name);
		if (widget && !used.has(widget)) {
			ordered.push(widget);
			used.add(widget);
		}
	}
	for (const widget of node.widgets) {
		if (!used.has(widget)) {
			ordered.push(widget);
			used.add(widget);
		}
	}
	node.widgets = ordered;
}

function placeToolbarFirst(node) {
	const status = node?.__gjjAudioAceMusicStatus?.widget;
	if (!status || !Array.isArray(node.widgets)) return;
	const rest = node.widgets.filter((widget) => widget !== status);
	node.widgets = [status, ...rest];
}

function scheduleToolbarFirst(node) {
	const move = () => {
		placeToolbarFirst(node);
		refreshNode(node);
	};
	requestAnimationFrame?.(move);
	setTimeout(move, 0);
}

function ensureCompactSize(node) {
	if (!node) return;
	const width = Math.max(360, Number(node.size?.[0] || 360));
	node.setSize?.([width, COMPACT_NODE_HEIGHT]);
	node.size = [width, COMPACT_NODE_HEIGHT];
	refreshNode(node);
}

function scheduleCompactSize(node) {
	ensureCompactSize(node);
	requestAnimationFrame?.(() => ensureCompactSize(node));
	setTimeout(() => ensureCompactSize(node), 0);
}

function patchPromptData(promptData) {
	const nodes = app.graph?._nodes || [];
	for (const node of nodes) {
		if (!node || !TARGET_NODES.has(String(node.comfyClass || node.type || ""))) continue;
		syncOrderedWidgetValues(node);
		writePromptInputsFromWidgets(node, promptData);
	}
	return promptData;
}

function installGraphToPromptPatch() {
	if (app.__gjjAudioAceMusicGraphToPromptPatched || typeof app.graphToPrompt !== "function") {
		return;
	}
	app.__gjjAudioAceMusicGraphToPromptPatched = true;
	const originalGraphToPrompt = app.graphToPrompt.bind(app);
	app.graphToPrompt = async function (...args) {
		const result = await originalGraphToPrompt(...args);
		return patchPromptData(result);
	};
}

function protectPanelEvents(element) {
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "keydown", "keyup"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
	element.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
}

function floatingPanelStyle() {
	return [
		"position:fixed",
		"z-index:900",
		"width:min(440px, calc(100vw - 28px))",
		"max-height:min(520px, calc(100vh - 32px))",
		"overflow:auto",
		"display:none",
		"flex-direction:column",
		"gap:8px",
		"padding:10px",
		"box-sizing:border-box",
		"border:1px solid #41535b",
		"border-radius:8px",
		"background:#10171b",
		"color:#dce7e2",
		"box-shadow:0 16px 42px rgba(0,0,0,.45)",
		"pointer-events:auto",
	].join(";");
}

function createFloatingPanel(node, key) {
	const config = PANEL_GROUPS[key];
	if (!config) return null;
	const panel = document.createElement("div");
	panel.className = `gjj-audio-ace-floating-panel gjj-audio-ace-${key}-panel`;
	panel.style.cssText = floatingPanelStyle();
	protectPanelEvents(panel);

	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;position:sticky;top:0;background:#10171b;padding-bottom:4px;z-index:1";
	const title = document.createElement("div");
	title.textContent = config.title;
	title.style.cssText = "font-size:13px;font-weight:700;color:#f2faf7";
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "×";
	close.title = "关闭";
	close.style.cssText = "width:26px;height:24px;border:1px solid #41535b;border-radius:6px;background:#1a2328;color:#dce7e2;cursor:pointer";
	close.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setPanelOpen(node, key, false);
	});
	header.append(title, close);

	const body = document.createElement("div");
	body.style.cssText = "display:flex;flex-direction:column;gap:8px";
	panel.append(header, body);
	document.body.appendChild(panel);
	return { panel, body, key };
}

function widgetLabel(widget, fallback) {
	return String(widget?.options?.display_name || widget?.label || widget?.localized_name || widget?.name || fallback || "");
}

function widgetChoices(widget) {
	const values = widget?.options?.values || widget?.options?.items || widget?.values;
	return Array.isArray(values) ? values : [];
}

function modelWidgetChoices(node, name) {
	return widgetChoices(getWidget(node, name)).map((item) => String(item || "").trim()).filter(Boolean);
}

function aceMainModelTreeEntries(node) {
	const mainChoices = modelWidgetChoices(node, "model_name");
	return [
		{
			widget: "model_name",
			label: "ACE 主模型 / UNET",
			folder: "diffusion_models",
			icon: "🟣",
			models: mainChoices,
			keywords: ["ace", "step"],
			fallback: getWidget(node, "model_name")?.value || "未找到 ACE/Step 主模型",
			description: "ACE 主模型；.safetensors 与 .gguf 写入同一个 model_name，二者互斥。GGUF 执行时走 GJJ 内置 GGUF UNET 加载器。",
		},
		{
			widget: "clip_1_name",
			label: "CLIP 1",
			folder: "text_encoders",
			icon: "🟡",
			models: modelWidgetChoices(node, "clip_1_name"),
			anyKeywords: ["ace", "qwen"],
			fallback: getWidget(node, "clip_1_name")?.value || "qwen_0.6b_ace15.safetensors",
			description: "ACE 文本编码器 1。",
		},
		{
			widget: "clip_2_name",
			label: "CLIP 2",
			folder: "text_encoders",
			icon: "🟡",
			models: modelWidgetChoices(node, "clip_2_name"),
			anyKeywords: ["ace", "qwen"],
			fallback: getWidget(node, "clip_2_name")?.value || "qwen_1.7b_ace15.safetensors",
			description: "ACE 文本编码器 2。",
		},
		{
			widget: "vae_name",
			label: "VAE",
			folder: "vae",
			icon: "🔴",
			models: modelWidgetChoices(node, "vae_name"),
			anyKeywords: ["ace", "vae"],
			fallback: getWidget(node, "vae_name")?.value || "ace_1.5_vae.safetensors",
			description: "ACE 音频 VAE。",
		},
	];
}

function createFloatingControl(node, name) {
	const widget = getWidget(node, name);
	if (!widget) return null;
	const row = document.createElement("label");
	row.dataset.widgetName = name;
	row.style.cssText = "display:grid;grid-template-columns:112px minmax(0,1fr);align-items:center;gap:8px";

	const label = document.createElement("span");
	label.textContent = widgetLabel(widget, name);
	label.title = widget?.options?.tooltip || "";
	label.style.cssText = "font-size:12px;color:#aebfbd;line-height:1.25";

	let input;
	const choices = widgetChoices(widget);
	if (choices.length) {
		input = document.createElement("select");
		for (const value of choices) {
			const option = document.createElement("option");
			option.value = String(value);
			option.textContent = String(value);
			input.appendChild(option);
		}
	} else if (typeof widget.value === "boolean") {
		input = document.createElement("input");
		input.type = "checkbox";
	} else {
		input = document.createElement("input");
		input.type = typeof widget.value === "number" ? "number" : "text";
		if (input.type === "number") {
			if (widget.options?.min != null) input.min = String(widget.options.min);
			if (widget.options?.max != null) input.max = String(widget.options.max);
			if (widget.options?.step != null) input.step = String(widget.options.step);
		}
	}
	input.title = widget?.options?.tooltip || "";
	input.style.cssText = [
		"box-sizing:border-box",
		"width:100%",
		"min-height:28px",
		"border:1px solid rgba(255,255,255,.1)",
		"border-radius:6px",
		"background:#2d3034",
		"color:#eef5f1",
		"font:12px/1.35 sans-serif",
		"padding:5px 7px",
		"outline:none",
	].join(";");

	const readInputValue = () => {
		if (input.type === "checkbox") return input.checked;
		if (input.type === "number") return Number(input.value);
		return input.value;
	};
	const refresh = () => {
		if (input.type === "checkbox") input.checked = !!widget.value;
		else input.value = widget.value ?? "";
	};
	input.addEventListener("input", () => setWidgetValue(node, name, readInputValue()));
	input.addEventListener("change", () => setWidgetValue(node, name, readInputValue()));
	row.__gjjRefresh = refresh;
	row.append(label, input);
	refresh();
	return row;
}

function ensureFloatingPanels(node) {
	node.__gjjAudioAcePanels ||= {};
	for (const key of Object.keys(PANEL_GROUPS)) {
		if (!node.__gjjAudioAcePanels[key]) {
			node.__gjjAudioAcePanels[key] = createFloatingPanel(node, key);
		}
	}
	return node.__gjjAudioAcePanels;
}

function panelOpenKey(node) {
	return String(node?.properties?.gjj_audio_ace_open_panel || "");
}

function setPanelOpen(node, key, open) {
	node.properties ||= {};
	node.properties.gjj_audio_ace_open_panel = open ? key : "";
	syncFloatingPanels(node);
}

function positionFloatingPanel(node, panel, anchor) {
	if (!panel) return;
	const rect = anchor?.getBoundingClientRect?.();
	const width = Math.min(440, Math.max(320, window.innerWidth - 28));
	const left = Math.min(window.innerWidth - width - 14, Math.max(14, rect?.left || 80));
	const top = Math.min(window.innerHeight - 120, Math.max(14, (rect?.bottom || 80) + 6));
	panel.style.width = `${width}px`;
	panel.style.left = `${Math.round(left)}px`;
	panel.style.top = `${Math.round(top)}px`;
}

function renderPanelControls(node, panelInfo, names) {
	if (!panelInfo?.body) return;
	panelInfo.body.replaceChildren();
	for (const name of names) {
		const control = createFloatingControl(node, name);
		if (!control) continue;
		control.__gjjRefresh?.();
		panelInfo.body.appendChild(control);
	}
}

function renderModelPanelControls(node, panelInfo) {
	if (!panelInfo?.body) return;
	panelInfo.body.replaceChildren();
	const tree = GJJ_Utils.createModelTreeView({
		node,
		entries: aceMainModelTreeEntries(node),
		refresh: () => {
			syncOrderedWidgetValues(node);
			refreshNode(node);
			syncFloatingPanels(node);
		},
		onApply: () => {
			syncOrderedWidgetValues(node);
			refreshNode(node);
		},
	});
	tree.style.maxHeight = "360px";
	panelInfo.body.appendChild(tree);
	for (const name of PANEL_GROUPS.model.names) {
		const control = createFloatingControl(node, name);
		if (!control) continue;
		control.__gjjRefresh?.();
		panelInfo.body.appendChild(control);
	}
}

function syncFloatingPanels(node) {
	const panels = ensureFloatingPanels(node);
	const openKey = panelOpenKey(node);
	for (const [key, panelInfo] of Object.entries(panels)) {
		if (!panelInfo) continue;
		if (key === "model") renderModelPanelControls(node, panelInfo);
		else renderPanelControls(node, panelInfo, PANEL_GROUPS[key]?.names || []);
		const open = key === openKey;
		panelInfo.panel.style.display = open ? "flex" : "none";
		if (open) {
			positionFloatingPanel(node, panelInfo.panel, node.__gjjAudioAceButtons?.[key]);
		}
	}
}

function positionOpenFloatingPanels(node) {
	const panels = node?.__gjjAudioAcePanels;
	const openKey = panelOpenKey(node);
	const panelInfo = panels?.[openKey];
	if (!panelInfo?.panel || panelInfo.panel.style.display === "none") return;
	positionFloatingPanel(node, panelInfo.panel, node.__gjjAudioAceButtons?.[openKey]);
}

function positionAllOpenFloatingPanels() {
	for (const node of app.graph?._nodes || []) {
		if (TARGET_NODES.has(String(node?.comfyClass || node?.type || ""))) {
			positionOpenFloatingPanels(node);
		}
	}
}

function removeFloatingPanels(node) {
	for (const panelInfo of Object.values(node?.__gjjAudioAcePanels || {})) {
		panelInfo?.panel?.remove?.();
	}
	node.__gjjAudioAcePanels = {};
}

function installWindowPositionHandlers() {
	if (app.__gjjAudioAceWindowHandlersInstalled || typeof window === "undefined") return;
	app.__gjjAudioAceWindowHandlersInstalled = true;
	window.addEventListener("resize", positionAllOpenFloatingPanels);
	window.addEventListener("scroll", positionAllOpenFloatingPanels, true);
}

function createIconButton({ icon, title, color = "#293340", onClick }) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = icon;
	button.title = title;
	button.style.cssText = [
		"width:28px",
		"height:28px",
		"border:1px solid rgba(255,255,255,.12)",
		"border-radius:6px",
		`background:${color}`,
		"color:#fff",
		"display:inline-flex",
		"align-items:center",
		"justify-content:center",
		"font-size:14px",
		"line-height:1",
		"cursor:pointer",
		"padding:0",
		"box-shadow:inset 0 1px 0 rgba(255,255,255,.08)",
	].join(";");
	button.addEventListener("mouseenter", () => {
		button.style.filter = "brightness(1.15)";
	});
	button.addEventListener("mouseleave", () => {
		button.style.filter = "";
	});
	if (onClick) {
		button.addEventListener("click", onClick);
	}
	return button;
}

function createButton(text, title, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = text;
	button.title = title || "";
	button.style.cssText = [
		"height:28px",
		"border:1px solid #40535d",
		"border-radius:6px",
		"background:#1b252b",
		"color:#edf7f4",
		"font:700 12px/1 sans-serif",
		"padding:0 10px",
		"cursor:pointer",
		"white-space:nowrap",
	].join(";");
	if (onClick) {
		button.addEventListener("click", onClick);
	}
	return button;
}

function selectedModelChoices(dialog) {
	return [...dialog.querySelectorAll("input[data-model-choice]:checked")].map((input) => input.value);
}

function applyModelTestFilter(dialog, value) {
	const terms = String(value || "").toLowerCase().split(/\s+/).filter(Boolean);
	for (const row of dialog.querySelectorAll("[data-model-row]")) {
		const text = String(row.dataset.modelRow || "").toLowerCase();
		row.style.display = terms.every((term) => text.includes(term)) ? "flex" : "none";
	}
}

async function queueModelTestBatch(node, models, dialog) {
	const modelWidget = getWidget(node, "model_name");
	if (!modelWidget || !models.length) return;
	const original = modelWidget.value;
	const originalTestMode = getWidget(node, "model_test_mode")?.value;
	const runButton = dialog?.querySelector("[data-model-test-run]");
	try {
		if (runButton) {
			runButton.disabled = true;
			runButton.style.opacity = "0.6";
		}
		for (let index = 0; index < models.length; index += 1) {
			const model = models[index];
			setWidgetValue(node, "model_name", model);
			setWidgetValue(node, "model_test_mode", true);
			setStatus(node, `模型测试 ${index + 1}/${models.length}: ${model}`);
			await queueOnlyCurrentNode(node);
		}
		setStatus(node, `已加入模型测试队列：${models.length} 个`);
	} catch (error) {
		console.error("[GJJ] 模型测试排队失败:", error);
		setStatus(node, "模型测试排队失败");
	} finally {
		setWidgetValue(node, "model_name", original);
		setWidgetValue(node, "model_test_mode", Boolean(originalTestMode));
		dialog?.remove?.();
	}
}

function openModelTestDialog(node) {
	document.querySelector(".gjj-audio-ace-model-test-dialog")?.remove?.();
	const choices = modelWidgetChoices(node, "model_name");
	const current = String(getWidget(node, "model_name")?.value || "");
	const overlay = document.createElement("div");
	overlay.className = "gjj-audio-ace-model-test-dialog";
	overlay.style.cssText = [
		"position:fixed",
		"inset:0",
		"z-index:1100",
		"background:rgba(0,0,0,.35)",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"padding:18px",
		"box-sizing:border-box",
	].join(";");
	protectPanelEvents(overlay);

	const panel = document.createElement("div");
	panel.style.cssText = [
		"width:min(720px, calc(100vw - 36px))",
		"max-height:min(620px, calc(100vh - 36px))",
		"display:flex",
		"flex-direction:column",
		"gap:10px",
		"border:1px solid #41535b",
		"border-radius:8px",
		"background:#10171b",
		"color:#dce7e2",
		"box-shadow:0 18px 48px rgba(0,0,0,.48)",
		"padding:12px",
		"box-sizing:border-box",
	].join(";");

	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px";
	const title = document.createElement("div");
	title.textContent = "🧪 模型测试";
	title.style.cssText = "font-size:14px;font-weight:800;color:#f2fbff";
	const close = createIconButton({ icon: "×", title: "关闭", color: "#1b252b", onClick: () => overlay.remove() });
	header.append(title, close);

	const controls = document.createElement("div");
	controls.style.cssText = "display:flex;gap:8px;align-items:center";
	const filter = document.createElement("input");
	filter.placeholder = "关键词过滤，支持空格 AND";
	filter.style.cssText = [
		"flex:1",
		"height:30px",
		"box-sizing:border-box",
		"border:1px solid #40535d",
		"border-radius:6px",
		"background:#0d1418",
		"color:#edf7f4",
		"padding:0 10px",
		"outline:none",
	].join(";");
	filter.addEventListener("input", () => applyModelTestFilter(overlay, filter.value));
	const selectAll = createButton("全选", "选择当前过滤结果", () => {
		for (const row of overlay.querySelectorAll("[data-model-row]")) {
			if (row.style.display === "none") continue;
			const input = row.querySelector("input[data-model-choice]");
			if (input) input.checked = true;
		}
	});
	const clear = createButton("清空", "清空选择", () => {
		for (const input of overlay.querySelectorAll("input[data-model-choice]")) {
			input.checked = false;
		}
	});
	controls.append(filter, selectAll, clear);

	const list = document.createElement("div");
	list.style.cssText = [
		"min-height:140px",
		"max-height:390px",
		"overflow:auto",
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"border:1px solid #263b43",
		"border-radius:8px",
		"padding:8px",
		"background:#0b1418",
	].join(";");
	for (const name of choices) {
		const row = document.createElement("label");
		row.dataset.modelRow = name;
		row.style.cssText = "display:flex;align-items:center;gap:8px;min-height:28px;padding:4px 6px;border-radius:6px;background:#132329;color:#ecf7f3;font:12px/1.3 monospace";
		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.value = name;
		checkbox.dataset.modelChoice = "1";
		checkbox.checked = name === current;
		const text = document.createElement("span");
		text.textContent = name;
		text.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
		row.append(checkbox, text);
		list.appendChild(row);
	}

	const footer = document.createElement("div");
	footer.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px";
	const note = document.createElement("div");
	note.textContent = "使用当前歌词、音乐标签和采样参数，逐个主模型加入队列。";
	note.style.cssText = "font-size:12px;color:#9eb2b4;min-width:0";
	const run = createButton("加入队列", "按选择的模型逐个生成音乐", () => {
		const models = selectedModelChoices(overlay);
		if (!models.length) {
			setStatus(node, "模型测试：未选择模型");
			return;
		}
		queueModelTestBatch(node, models, overlay);
	});
	run.dataset.modelTestRun = "1";
	footer.append(note, run);

	panel.append(header, controls, list, footer);
	overlay.appendChild(panel);
	document.body.appendChild(overlay);
	filter.focus();
}

function progressFromText(text) {
	const value = String(text || "");
	if (value.includes("完成")) return 100;
	if (value.includes("解码")) return 83;
	if (value.includes("采样")) return 66;
	if (value.includes("构建")) return 50;
	if (value.includes("编码")) return 33;
	if (value.includes("加载")) return 16;
	if (value.includes("失败")) return 100;
	return 0;
}

function normalizeProgress(progress, fallback) {
	const value = Number(progress);
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return value <= 1 ? value * 100 : value;
}

function ensureStatusWidget(node) {
	if (node.__gjjAudioAceMusicStatus) {
		return node.__gjjAudioAceMusicStatus;
	}
	const box = document.createElement("div");
	box.style.cssText = [
		"box-sizing:border-box",
		"padding:4px 8px 6px",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.35",
	].join(";");

	const statusRow = document.createElement("div");
	statusRow.style.cssText = "display:flex;gap:5px;align-items:center;min-width:0;margin-bottom:6px;overflow:hidden";

	const statusContent = document.createElement("div");
	statusContent.style.cssText = "flex:1;min-width:0;display:flex;align-items:center;gap:5px";

	const label = document.createElement("div");
	label.textContent = "等待执行";
	label.title = "等待执行";
	label.style.cssText = "display:none";

	const track = document.createElement("div");
	track.style.cssText = [
		"height:4px",
		"overflow:hidden",
		"border-radius:999px",
		"background:#253038",
		"flex:1",
		"min-width:26px",
	].join(";");
	const bar = document.createElement("div");
	bar.style.cssText = [
		"width:0%",
		"height:100%",
		"border-radius:999px",
		"background:#5aa8ff",
		"transition:width 160ms ease",
	].join(";");
	track.appendChild(bar);
	statusContent.append(track, label);

	const generateBtn = createIconButton({ icon: "▶️", title: "只执行当前节点，生成音乐", color: "#16845a" });
	const testBtn = createIconButton({ icon: "🧪", title: "模型测试：多选模型并用当前参数生成", color: "#355f76" });
	const buttons = {};
	const panelButton = (key, icon, title, color) => {
		const button = createIconButton({
			icon,
			title,
			color,
			onClick: () => setPanelOpen(node, key, panelOpenKey(node) !== key),
		});
		buttons[key] = button;
		return button;
	};
	statusRow.append(
		createIconButton({ icon: "🔄", title: "刷新节点", color: "#315db9", onClick: () => refreshNode(node) }),
		panelButton("seed", "🎲", "种子", "#4a4f5c"),
		panelButton("music", "🌐", "音乐结构", "#16728d"),
		panelButton("text", "🪄", "文本采样", "#a65f00"),
		panelButton("generate", "⚡", "生成参数", "#72500f"),
		panelButton("model", "🧠", "模型相关", "#4d3d83"),
		panelButton("other", "⚙️", "其它参数", "#3d4251"),
		generateBtn,
		testBtn,
		statusContent,
	);

	box.append(statusRow);

	const widget = node.addDOMWidget?.(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => COMPACT_PANEL_HEIGHT,
	});
	if (widget) {
		widget.computeSize = (width) => [Math.max(320, Number(width || node.size?.[0] || 360)), COMPACT_PANEL_HEIGHT];
	}

	node.__gjjAudioAceButtons = buttons;
	node.__gjjAudioAceMusicStatus = { widget, box, label, bar, generateBtn, testBtn };
	return node.__gjjAudioAceMusicStatus;
}

function setStatus(node, text, progress = null) {
	const status = node?.__gjjAudioAceMusicStatus;
	if (!status) {
		return;
	}
	const message = String(text || "等待执行");
	status.label.textContent = message;
	status.label.title = message;
	const percent = normalizeProgress(progress, progressFromText(message));
	status.bar.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
	refreshNode(node);
}

function buildViewUrl(item) {
	const params = new URLSearchParams();
	params.set("filename", item.filename || "");
	params.set("type", item.type || "output");
	if (item.subfolder) {
		params.set("subfolder", item.subfolder);
	}
	params.set("rand", String(Date.now()));
	return `/view?${params.toString()}`;
}

function ensureAudioWidget(node) {
	if (node.__gjjAudioAceMusicAudio) {
		return node.__gjjAudioAceMusicAudio;
	}
	const box = document.createElement("div");
	box.style.cssText = [
		"display:none",
		"padding:8px 10px",
		"border:1px solid #41535b",
		"border-radius:8px",
		"background:#22282d",
	].join(";");
	const audio = document.createElement("audio");
	audio.controls = true;
	audio.preload = "metadata";
	audio.style.cssText = "display:block;width:100%;height:34px";
	const row = document.createElement("div");
	row.style.cssText = "display:flex;justify-content:flex-end;gap:10px;margin-top:6px;font-size:12px";
	const openLink = document.createElement("a");
	openLink.textContent = "打开";
	openLink.target = "_blank";
	openLink.rel = "noopener";
	openLink.style.cssText = "color:#9ecbff;text-decoration:none";
	const downloadLink = document.createElement("a");
	downloadLink.textContent = "下载";
	downloadLink.download = "";
	downloadLink.style.cssText = "color:#9ecbff;text-decoration:none";
	row.append(openLink, downloadLink);
	box.append(audio, row);
	const widget = node.addDOMWidget?.(AUDIO_WIDGET_NAME, AUDIO_WIDGET_NAME, box, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => (box.style.display === "none" ? 0 : 92),
	});
	node.__gjjAudioAceMusicAudio = { widget, box, audio, openLink, downloadLink };
	return node.__gjjAudioAceMusicAudio;
}

function extractAudioItem(message) {
	const audioList = message?.audio;
	if (!Array.isArray(audioList) || !audioList.length) {
		return null;
	}
	const first = audioList[0];
	if (typeof first === "string") {
		return { filename: first, type: "output" };
	}
	if (first && typeof first === "object" && first.filename) {
		return first;
	}
	return null;
}

function setAudioPreview(node, message) {
	const item = extractAudioItem(message);
	if (!item) {
		return;
	}
	const audioWidget = ensureAudioWidget(node);
	const url = buildViewUrl(item);
	audioWidget.audio.src = url;
	audioWidget.openLink.href = url;
	audioWidget.downloadLink.href = url;
	audioWidget.downloadLink.download = item.filename || "GJJ_ACEMusic.mp3";
	audioWidget.box.style.display = "block";
	refreshNode(node);
}

function patchNode(node) {
	if (!node || node.__gjjAudioAceMusicPatched) {
		return;
	}
	node.__gjjAudioAceMusicPatched = true;
	ensureStatusWidget(node);
	ensureAudioWidget(node);
	syncOrderedWidgetValues(node);
	hideHomeWidgets(node);
	ensureFloatingPanels(node);
	syncFloatingPanels(node);
	setStatus(node, "等待执行");

	scheduleCompactSize(node);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);

	const status = node.__gjjAudioAceMusicStatus;
	if (status?.generateBtn) {
		status.generateBtn.addEventListener("click", async () => {
			console.log("[GJJ] 生成音乐: 只执行当前节点");
			const btn = status.generateBtn;
			const originalText = btn.textContent;

			try {
				btn.textContent = "⏳";
				btn.title = "生成中...";
				btn.disabled = true;
				btn.style.cursor = "not-allowed";
				btn.style.opacity = "0.65";

				setStatus(node, "正在生成音乐...");
				setWidgetValue(node, "model_test_mode", false);

				const ok = await queueOnlyCurrentNode(node);

				if (!ok) {
					console.warn("[GJJ] 生成音乐失败：queueOnlyCurrentNode 返回 false");
					setStatus(node, "生成失败");
				}
			} catch (err) {
				console.error("[GJJ] 生成音乐失败:", err);
				setStatus(node, "生成失败");
			} finally {
				setTimeout(() => {
					btn.textContent = originalText;
					btn.title = "只执行当前节点，生成音乐";
					btn.disabled = false;
					btn.style.cursor = "pointer";
					btn.style.opacity = "1";
				}, 500);
			}
		});
	}
	if (status?.testBtn) {
		status.testBtn.addEventListener("click", () => {
			openModelTestDialog(node);
		});
	}
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	ensureStatusWidget(targetNode);
	setStatus(targetNode, detail.text || "处理中...");
});

api.addEventListener("gjj_node_audio", (event) => {
	const detail = event?.detail || {};
	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode || !TARGET_NODES.has(String(targetNode.comfyClass || targetNode.type || ""))) {
		return;
	}
	setAudioPreview(targetNode, detail);
});

app.registerExtension({
	name: "GJJ.AudioAceMusicGenerator",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(String(nodeData?.name || ""))) {
			return;
		}
		installGraphToPromptPatch();
		installWindowPositionHandlers();

		const originalComputeSize = nodeType.prototype.computeSize;
		nodeType.prototype.computeSize = function (out) {
			const size = originalComputeSize?.apply(this, arguments) || [this.size?.[0] || 360, COMPACT_NODE_HEIGHT];
			size[0] = Math.max(360, Number(size[0] || this.size?.[0] || 360));
			size[1] = COMPACT_NODE_HEIGHT;
			return size;
		};

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this);
			scheduleToolbarFirst(this);
			return result;
		};

		const originalOnDrawForeground = nodeType.prototype.onDrawForeground;
		nodeType.prototype.onDrawForeground = function (...args) {
			const result = originalOnDrawForeground?.apply(this, args);
			positionOpenFloatingPanels(this);
			return result;
		};

		const originalOnRemoved = nodeType.prototype.onRemoved;
		nodeType.prototype.onRemoved = function (...args) {
			removeFloatingPanels(this);
			return originalOnRemoved?.apply(this, args);
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			restoreParameterWidgetOrder(this);
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			if (Array.isArray(serializedNode?.widgets_values)) {
				applyOrderedWidgetValues(this, serializedNode.widgets_values);
			} else {
				syncOrderedWidgetValues(this);
			}
			patchNode(this);
			scheduleToolbarFirst(this);
			scheduleCompactSize(this);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (data) {
			const result = originalOnSerialize?.apply(this, arguments);
			syncOrderedWidgetValues(this);
			if (data) {
				data.widgets_values = orderedParamValues(this);
			}
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			if (message?.audio && Array.isArray(message.audio) && message.audio.length > 0) {
				setAudioPreview(this, message);
			}
			return result;
		};
	},
});
