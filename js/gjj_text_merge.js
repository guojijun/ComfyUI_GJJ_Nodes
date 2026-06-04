import { app } from "/scripts/app.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_TextMerge"]);
const MAX_TEXT_INPUTS = 32;
const TEXT_INPUT_PREFIX = "text_";
const PREVIEW_WIDGET_NAME = "gjj_text_merge_preview";
const EMPTY_PREVIEW = "执行后在这里预览合并结果";
const TEMPLATE_WIDGET_NAME = "template_text";
const SELECTED_TEMPLATE_WIDGET_NAME = "selected_template";
const DEFAULT_TEMPLATE_TEXT = `【默认】You are a helpful assistant. #默认值
【T2I】You are a helpful assistant specialized in text-to-image generation.#文本到图片
【T2V】You are a helpful assistant specialized in text-to-video generation.#文本到视频
【I2I】You are a helpful assistant specialized in image editing.#图片到图片
【R2I】You are a helpful assistant specialized in subject-to-image generation.#参考主体到图片
【I2V】You are a helpful assistant specialized in image-to-video generation.#图片到视频
【V2V】You are a helpful assistant specialized in video editing.#视频到视频
【R2V】You are a helpful assistant specialized in subject-to-video generation.#参考主体到视频
【VI2V】You are a helpful assistant specialized in video editing on content propagation.#视频指令到视频
【RV2V】You are a helpful assistant specialized in video editing with reference.#参考视频到视频
【ADS2V】You are a helpful assistant specialized in ads insertion.#广告插入到视频
【VRC2V】You are a helpful assistant for editing. You may need to adjust the subject's action or position.#视频区域控制到视频
【MV2V】You are a helpful assistant for editing. You might need to adjust the video's style, lighting, colors, textures, and the subject's pose or action.#多维编辑到视频`;

function isTextInput(input) {
	return /^text_\d+$/.test(String(input?.name || ""));
}

function getInputIndex(name) {
	const match = String(name || "").match(/^text_(\d+)$/);
	return match ? Number.parseInt(match[1], 10) : Number.POSITIVE_INFINITY;
}

function sortTextInputs(inputs) {
	return [...inputs].sort((a, b) => getInputIndex(a?.name) - getInputIndex(b?.name));
}

function getTextInputs(node) {
	return sortTextInputs((node.inputs || []).filter(isTextInput));
}

function getTextInput(node, index) {
	const name = `${TEXT_INPUT_PREFIX}${index}`;
	return (node.inputs || []).find((input) => input?.name === name);
}

function isConnected(input) {
	return input?.link != null || (Array.isArray(input?.links) && input.links.length > 0);
}

function buildInputOptions(index) {
	return {
		label: `文本 ${index}`,
		tooltip: `第 ${index} 路文本输入；未连接或内容为空时会自动跳过。`,
	};
}

function ensureTextInput(node, index) {
	const name = `${TEXT_INPUT_PREFIX}${index}`;
	let input = getTextInput(node, index);
	if (!input) {
		input = node.addInput(name, "STRING", buildInputOptions(index));
	}

	input.label = `文本 ${index}`;
	input.localized_name = `文本 ${index}`;
	input.tooltip = `第 ${index} 路文本输入；未连接或内容为空时会自动跳过。`;
	return input;
}

function removeTextInput(node, index) {
	const name = `${TEXT_INPUT_PREFIX}${index}`;
	const slot = (node.inputs || []).findIndex((input) => input?.name === name);
	if (slot >= 0) {
		node.removeInput(slot);
	}
}

function hideWidget(widget) {
	if (!widget) {
		return;
	}
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.hidden = true;
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => -4;
	widget.draw = () => {};
	widget.label = "";
	widget.y = 0;
	widget.last_y = 0;
	widget.size = [0, -4];
	if (widget.options && typeof widget.options === "object") {
		widget.options.hidden = true;
		widget.options.display = "hidden";
	}
	if (widget.inputEl) {
		widget.inputEl.style.display = "none";
		widget.inputEl.style.height = "0px";
		widget.inputEl.style.margin = "0px";
		widget.inputEl.style.padding = "0px";
	}
	if (widget.element) {
		widget.element.style.display = "none";
		widget.element.style.height = "0px";
		widget.element.style.margin = "0px";
		widget.element.style.padding = "0px";
	}
	if (widget.widget) {
		widget.widget.style.display = "none";
		widget.widget.style.height = "0px";
		widget.widget.style.margin = "0px";
		widget.widget.style.padding = "0px";
	}
}

function hideLegacyPreviewWidgets(node) {
	(node.widgets || []).forEach((widget) => {
		if (widget === node.__gjjPreviewWidget) {
			return;
		}
		if (widget?.name === PREVIEW_WIDGET_NAME || widget?.label === "合并预览" || widget?.label === "预览") {
			hideWidget(widget);
		}
	});
}

function findWidget(node, name) {
	return (node?.widgets || []).find((widget) => String(widget?.name || "") === name);
}

function hideTemplateWidgets(node) {
	for (const name of [TEMPLATE_WIDGET_NAME, SELECTED_TEMPLATE_WIDGET_NAME]) {
		hideWidget(findWidget(node, name));
	}
}

function getWidgetValue(node, name, fallback = "") {
	const widget = findWidget(node, name);
	return widget?.value == null || widget.value === "" ? fallback : String(widget.value);
}

function setWidgetValue(node, name, value) {
	const widget = findWidget(node, name);
	if (!widget) return;
	widget.value = String(value ?? "");
	try { widget.callback?.(widget.value, app.canvas, node, app.canvas?.graph_mouse); } catch (_) {}
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function parseTemplateLine(line) {
	const text = String(line || "").trim();
	if (!text.startsWith("【") || !text.includes("】")) return null;
	const end = text.indexOf("】");
	const label = text.slice(1, end).trim();
	if (!label) return null;
	let rest = text.slice(end + 1);
	let tooltip = "";
	const hashIndex = rest.lastIndexOf("#");
	if (hashIndex >= 0) {
		tooltip = rest.slice(hashIndex + 1).trim();
		rest = rest.slice(0, hashIndex);
	}
	const placement = rest.startsWith("⬛") ? "suffix" : "prefix";
	if (placement === "suffix") rest = rest.slice(1);
	const content = rest.trim();
	if (!content) return null;
	return { label, content, tooltip, placement };
}

function parseTemplates(text) {
	const source = String(text || DEFAULT_TEMPLATE_TEXT).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return source.split("\n").map(parseTemplateLine).filter(Boolean);
}

function getTemplates(node) {
	return parseTemplates(getWidgetValue(node, TEMPLATE_WIDGET_NAME, DEFAULT_TEMPLATE_TEXT));
}

function getSelectedTemplateLabel(node) {
	return getWidgetValue(node, SELECTED_TEMPLATE_WIDGET_NAME, "默认").trim() || "默认";
}

function setSelectedTemplate(node, label) {
	setWidgetValue(node, SELECTED_TEMPLATE_WIDGET_NAME, label || "默认");
	refreshTemplateButtons(node);
}

function selectedTemplateEntry(node) {
	const templates = getTemplates(node);
	const selected = getSelectedTemplateLabel(node);
	return templates.find((entry) => entry.label === selected) || templates[0] || null;
}

function applyTemplateToText(node, text) {
	const entry = selectedTemplateEntry(node);
	const base = String(text || "").trim();
	if (!entry?.content) return base;
	if (!base) return entry.content;
	return entry.placement === "suffix" ? `${base}\n\n${entry.content}` : `${entry.content}\n\n${base}`;
}

function escapeHtml(text) {
	return String(text || "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("\"", "&quot;")
		.replaceAll("'", "&#39;");
}

function renderInlineMarkdown(text) {
	let output = escapeHtml(text);
	output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
	output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	output = output.replace(/__([^_]+)__/g, "<strong>$1</strong>");
	output = output.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
	output = output.replace(/(^|[^_])_([^_]+)_(?!_)/g, "$1<em>$2</em>");
	return output;
}

function renderMarkdown(text) {
	const source = String(text || "").replace(/\r\n/g, "\n").trim();
	if (!source) {
		return escapeHtml(EMPTY_PREVIEW);
	}

	const lines = source.split("\n");
	const parts = [];
	let listItems = [];

	const flushList = () => {
		if (!listItems.length) {
			return;
		}
		parts.push(`<ul>${listItems.join("")}</ul>`);
		listItems = [];
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			flushList();
			continue;
		}

		const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
		if (headingMatch) {
			flushList();
			const level = headingMatch[1].length;
			parts.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
			continue;
		}

		const listMatch = trimmed.match(/^[-*+]\s+(.+)$/);
		if (listMatch) {
			listItems.push(`<li>${renderInlineMarkdown(listMatch[1])}</li>`);
			continue;
		}

		flushList();
		parts.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
	}

	flushList();
	return parts.join("");
}

function getPreviewText(node) {
	return String(node?.__gjjPreviewText || "").trim();
}

function applyPreviewContent(node) {
	if (!node?.__gjjPreviewBody) {
		return;
	}

	const text = getPreviewText(node);
	const resolvedText = text || EMPTY_PREVIEW;

	node.__gjjPreviewContainer.style.gap = "8px";
	node.__gjjPreviewBody.style.whiteSpace = "normal";
	node.__gjjPreviewBody.style.minHeight = "0";
	node.__gjjPreviewBody.style.maxHeight = "none";
	node.__gjjPreviewBody.style.overflow = "visible";
	node.__gjjPreviewBody.style.padding = "0";
	node.__gjjPreviewBody.style.border = "none";
	node.__gjjPreviewBody.style.borderRadius = "0";
	node.__gjjPreviewBody.style.background = "transparent";
	node.__gjjPreviewBody.innerHTML = renderMarkdown(resolvedText);

	requestAnimationFrame(() => refreshLayout(node));
}

function templateButtonStyle(active = false, suffix = false) {
	return [
		"padding:2px 7px",
		"height:24px",
		"border:1px solid " + (active ? "#39d6a4" : "#465761"),
		"border-radius:6px",
		"background:" + (active ? "#15352d" : "#1a2328"),
		"color:" + (active ? "#d9fff2" : "#dce7e2"),
		"font-size:11px",
		"line-height:1",
		"cursor:pointer",
		"white-space:nowrap",
		suffix ? "box-shadow:inset 0 -2px 0 rgba(110,130,255,.75)" : "",
	].filter(Boolean).join(";");
}

function refreshTemplateButtons(node) {
	const wrap = node?.__gjjTemplateButtons;
	if (!wrap) return;
	const selected = getSelectedTemplateLabel(node);
	wrap.replaceChildren();
	for (const entry of getTemplates(node)) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = entry.label;
		button.title = entry.tooltip || (entry.placement === "suffix" ? "追加到输入文本后面" : "添加到输入文本前面");
		button.style.cssText = templateButtonStyle(entry.label === selected, entry.placement === "suffix");
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setSelectedTemplate(node, entry.label);
			const baseText = String(node.__gjjBasePreviewText || "").trim();
			if (baseText) {
				node.__gjjPreviewText = applyTemplateToText(node, baseText);
				applyPreviewContent(node);
			}
		});
		wrap.appendChild(button);
	}
}

function showTemplateSettings(node, anchorEl) {
	hideTemplateWidgets(node);
	if (node.__gjjTemplateSettingsPanel) {
		node.__gjjTemplateSettingsPanel.remove();
		node.__gjjTemplateSettingsPanel = null;
		return;
	}

	const panel = document.createElement("div");
	panel.style.cssText = [
		"position:fixed",
		"z-index:9999",
		"width:min(560px, calc(100vw - 24px))",
		"max-height:min(72vh, 620px)",
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"padding:10px",
		"border:1px solid #465761",
		"border-radius:10px",
		"background:#11181c",
		"box-shadow:0 12px 36px rgba(0,0,0,.55)",
		"box-sizing:border-box",
	].join(";");

	const title = document.createElement("div");
	title.textContent = "模板设置";
	title.style.cssText = "color:#dce7e2;font-size:12px;font-weight:700;";

	const textarea = document.createElement("textarea");
	textarea.value = getWidgetValue(node, TEMPLATE_WIDGET_NAME, DEFAULT_TEMPLATE_TEXT);
	textarea.spellcheck = false;
	textarea.style.cssText = [
		"width:100%",
		"min-height:260px",
		"resize:vertical",
		"border:1px solid #33434a",
		"border-radius:8px",
		"background:#172026",
		"color:#dce7e2",
		"font:12px/1.45 Consolas, 'Microsoft YaHei', monospace",
		"padding:8px",
		"box-sizing:border-box",
	].join(";");

	const actions = document.createElement("div");
	actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";

	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.textContent = "取消";
	cancel.style.cssText = templateButtonStyle(false);

	const ok = document.createElement("button");
	ok.type = "button";
	ok.textContent = "确定";
	ok.style.cssText = templateButtonStyle(true);

	const close = () => {
		panel.remove();
		node.__gjjTemplateSettingsPanel = null;
	};
	cancel.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		close();
	});
	ok.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setWidgetValue(node, TEMPLATE_WIDGET_NAME, textarea.value || DEFAULT_TEMPLATE_TEXT);
		const templates = getTemplates(node);
		if (!templates.some((entry) => entry.label === getSelectedTemplateLabel(node)) && templates[0]) {
			setWidgetValue(node, SELECTED_TEMPLATE_WIDGET_NAME, templates[0].label);
		}
		refreshTemplateButtons(node);
		const baseText = String(node.__gjjBasePreviewText || "").trim();
		if (baseText) {
			node.__gjjPreviewText = applyTemplateToText(node, baseText);
			applyPreviewContent(node);
		}
		close();
	});

	panel.addEventListener("mousedown", (event) => event.stopPropagation());
	panel.addEventListener("pointerdown", (event) => event.stopPropagation());
	textarea.addEventListener("pointerdown", (event) => event.stopPropagation());

	actions.appendChild(cancel);
	actions.appendChild(ok);
	panel.appendChild(title);
	panel.appendChild(textarea);
	panel.appendChild(actions);
	document.body.appendChild(panel);

	const rect = anchorEl?.getBoundingClientRect?.() || { left: 12, bottom: 12 };
	const panelRect = panel.getBoundingClientRect();
	let left = Math.min(Math.max(8, rect.left), window.innerWidth - panelRect.width - 8);
	let top = Math.min(rect.bottom + 6, window.innerHeight - panelRect.height - 8);
	panel.style.left = `${left}px`;
	panel.style.top = `${Math.max(8, top)}px`;
	node.__gjjTemplateSettingsPanel = panel;
	textarea.focus();
}

async function copyPreviewText(node) {
	const text = String(node?.__gjjPreviewText || "");
	if (!text) return;
	try {
		await navigator.clipboard?.writeText(text);
	} catch (_) {
		const textarea = document.createElement("textarea");
		textarea.value = text;
		textarea.style.position = "fixed";
		textarea.style.left = "-9999px";
		document.body.appendChild(textarea);
		textarea.focus();
		textarea.select();
		try { document.execCommand("copy"); } catch (_) {}
		textarea.remove();
	}
	if (node.__gjjCopyNoticeTimer) clearTimeout(node.__gjjCopyNoticeTimer);
	const oldTitle = node.__gjjPreviewBody?.title || "";
	if (node.__gjjPreviewBody) node.__gjjPreviewBody.title = "已复制文本";
	node.__gjjCopyNoticeTimer = setTimeout(() => {
		if (node.__gjjPreviewBody) node.__gjjPreviewBody.title = oldTitle || "双击复制文本";
	}, 900);
}

function ensurePreviewWidget(node) {
	hideLegacyPreviewWidgets(node);
	hideTemplateWidgets(node);
	if (node.__gjjPreviewContainer) {
		refreshTemplateButtons(node);
		applyPreviewContent(node);
		return node.__gjjPreviewContainer;
	}

	const container = document.createElement("div");
	container.className = "gjj-text-merge-preview";
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
		"margin-top:4px",
	].join(";");

	const toolbar = document.createElement("div");
	toolbar.style.cssText = [
		"display:flex",
		"justify-content:flex-start",
		"align-items:center",
		"gap:6px",
		"flex-wrap:wrap",
		"width:100%",
		"box-sizing:border-box",
	].join(";");

	const leftTools = document.createElement("div");
	leftTools.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;width:100%;box-sizing:border-box;";

	const settingsButton = document.createElement("button");
	settingsButton.type = "button";
	settingsButton.textContent = "⚙️设置";
	settingsButton.title = "编辑模板。格式：【按钮文字】模板内容#提示；【按钮文字】⬛模板内容#提示 表示追加到输入文本后面。";
	settingsButton.style.cssText = templateButtonStyle(false);

	const templateButtons = document.createElement("div");
	templateButtons.style.cssText = "display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-width:0;";

	const body = document.createElement("div");
	body.className = "comfy-markdown-content gjj-text-merge-preview-body";
	body.style.cssText = [
		"min-height:0",
		"max-height:none",
		"overflow:visible",
		"padding:0",
		"border:none",
		"border-radius:0",
		"background:transparent",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.5",
		"word-break:break-word",
		"cursor:copy",
	].join(";");

	body.title = "双击复制文本";
	body.addEventListener("dblclick", (event) => {
		event.preventDefault();
		event.stopPropagation();
		copyPreviewText(node);
	});

	container.addEventListener("mousedown", (event) => event.stopPropagation());
	container.addEventListener("pointerdown", (event) => event.stopPropagation());

	settingsButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		showTemplateSettings(node, settingsButton);
	});

	leftTools.appendChild(settingsButton);
	leftTools.appendChild(templateButtons);
	toolbar.appendChild(leftTools);
	container.appendChild(toolbar);
	container.appendChild(body);

	node.__gjjPreviewContainer = container;
	node.__gjjPreviewBody = body;
	node.__gjjTemplateButtons = templateButtons;
	node.__gjjPreviewWidget = node.addDOMWidget(PREVIEW_WIDGET_NAME, "HTML", container, { serialize: false });
	node.__gjjPreviewWidget.computeSize = (width) => [
		Math.max(1, Number(width || node.size?.[0] || 1)),
		Math.max(24, Math.ceil(container.scrollHeight || container.offsetHeight || 24)),
	];
	node.__gjjPreviewWidget.getHeight = () => Math.max(24, Math.ceil(container.scrollHeight || container.offsetHeight || 24));
	refreshTemplateButtons(node);
	applyPreviewContent(node);
	return container;
}

function updatePreview(node, text, baseText = null) {
	if (baseText !== null && baseText !== undefined) {
		node.__gjjBasePreviewText = String(baseText || "");
	}
	node.__gjjPreviewText = String(text || "");
	ensurePreviewWidget(node);
	applyPreviewContent(node);
}

function refreshLayout(node) {
	if (node?.__gjjPreviewWidget && node.__gjjPreviewContainer) {
		node.__gjjPreviewWidget.computeSize = (width) => [
			Math.max(1, Number(width || node.size?.[0] || 1)),
			Math.max(24, Math.ceil(node.__gjjPreviewContainer.scrollHeight || node.__gjjPreviewContainer.offsetHeight || 24)),
		];
		node.__gjjPreviewWidget.getHeight = () => Math.max(24, Math.ceil(node.__gjjPreviewContainer.scrollHeight || node.__gjjPreviewContainer.offsetHeight || 24));
	}
	GJJ_Utils.refreshNode(node);
}

function syncDynamicInputs(node) {
	const existingInputs = getTextInputs(node);
	const connectedIndices = existingInputs
		.filter(isConnected)
		.map((input) => getInputIndex(input?.name))
		.filter((index) => Number.isFinite(index));

	const highestConnected = connectedIndices.length > 0 ? Math.max(...connectedIndices) : 0;
	const desiredCount = Math.min(MAX_TEXT_INPUTS, Math.max(1, highestConnected + 1));

	for (let index = 1; index <= desiredCount; index += 1) {
		ensureTextInput(node, index);
	}

	for (let index = MAX_TEXT_INPUTS; index > desiredCount; index -= 1) {
		const input = getTextInput(node, index);
		if (input && !isConnected(input)) {
			removeTextInput(node, index);
		}
	}

	refreshLayout(node);
}

app.registerExtension({
	name: "Comfy.GJJ.TextMerge",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			ensurePreviewWidget(this);
			setTimeout(() => syncDynamicInputs(this), 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			ensurePreviewWidget(this);
			setTimeout(() => syncDynamicInputs(this), 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			setTimeout(() => syncDynamicInputs(this), 0);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, arguments);
			if (message?.selected_template?.[0]) {
				setWidgetValue(this, SELECTED_TEMPLATE_WIDGET_NAME, message.selected_template[0]);
			}
			updatePreview(this, message?.text?.[0] || "", message?.base_text?.[0] ?? null);
			return result;
		};
	},

	async nodeCreated(node) {
		if (!TARGET_NODES.has(node?.comfyClass)) {
			return;
		}

		ensurePreviewWidget(node);
		setTimeout(() => syncDynamicInputs(node), 0);
	},
});
