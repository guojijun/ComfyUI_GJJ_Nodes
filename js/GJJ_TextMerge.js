import { GJJ_Utils } from "./gjj_utils.js";
import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_TextMerge"]);
const MAX_TEXT_INPUTS = 32;
const TEXT_INPUT_PREFIX = "text_";
const PREVIEW_WIDGET_NAME = "gjj_text_merge_preview";
const PREVIEW_MODE_PROPERTY = "gjj_text_merge_preview_mode";
const MARKDOWN_MODE = "markdown";
const RAW_MODE = "previewMode";
const EMPTY_PREVIEW = "执行后在这里预览合并结果";

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
	widget.type = "hidden";
	widget.hidden = true;
	widget.computeSize = () => [0, 0];
	widget.draw = () => {};
	widget.label = "";
	if (widget.inputEl) {
		widget.inputEl.style.display = "none";
	}
	if (widget.element) {
		widget.element.style.display = "none";
	}
	if (widget.widget) {
		widget.widget.style.display = "none";
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

function getPreviewMode(node) {
	const value = String(node?.properties?.[PREVIEW_MODE_PROPERTY] || "").trim();
	return value === RAW_MODE ? RAW_MODE : MARKDOWN_MODE;
}

function setPreviewMode(node, mode) {
	node.properties = node.properties || {};
	node.properties[PREVIEW_MODE_PROPERTY] = mode === RAW_MODE ? RAW_MODE : MARKDOWN_MODE;
}

function getPreviewText(node) {
	return String(node?.__gjjPreviewText || "").trim();
}

function applyPreviewContent(node) {
	if (!node?.__gjjPreviewBody || !node?.__gjjPreviewToggle) {
		return;
	}

	const mode = getPreviewMode(node);
	const text = getPreviewText(node);
	const resolvedText = text || EMPTY_PREVIEW;

	node.__gjjPreviewToggle.textContent = mode === MARKDOWN_MODE ? "Markdown" : "previewMode";

	if (mode === MARKDOWN_MODE) {
		node.__gjjPreviewContainer.style.gap = "4px";
		node.__gjjPreviewBody.style.whiteSpace = "normal";
		node.__gjjPreviewBody.style.minHeight = "0";
		node.__gjjPreviewBody.style.maxHeight = "none";
		node.__gjjPreviewBody.style.overflow = "visible";
		node.__gjjPreviewBody.style.padding = "0";
		node.__gjjPreviewBody.style.border = "none";
		node.__gjjPreviewBody.style.borderRadius = "0";
		node.__gjjPreviewBody.style.background = "transparent";
		node.__gjjPreviewBody.innerHTML = renderMarkdown(resolvedText);
	} else {
		node.__gjjPreviewContainer.style.gap = "6px";
		node.__gjjPreviewBody.style.whiteSpace = "pre-wrap";
		node.__gjjPreviewBody.style.minHeight = "52px";
		node.__gjjPreviewBody.style.maxHeight = "180px";
		node.__gjjPreviewBody.style.overflow = "auto";
		node.__gjjPreviewBody.style.padding = "8px 10px";
		node.__gjjPreviewBody.style.border = "1px solid #3c4c54";
		node.__gjjPreviewBody.style.borderRadius = "8px";
		node.__gjjPreviewBody.style.background = "#172026";
		node.__gjjPreviewBody.textContent = resolvedText;
	}

	requestAnimationFrame(() => refreshLayout(node));
}

function ensurePreviewWidget(node) {
	hideLegacyPreviewWidgets(node);
	if (node.__gjjPreviewContainer) {
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
		"justify-content:flex-end",
		"align-items:center",
	].join(";");

	const toggleButton = document.createElement("button");
	toggleButton.type = "button";
	toggleButton.style.cssText = [
		"padding:2px 8px",
		"height:24px",
		"border:1px solid #465761",
		"border-radius:6px",
		"background:#1a2328",
		"color:#dce7e2",
		"font-size:11px",
		"line-height:1",
		"cursor:pointer",
	].join(";");

	const body = document.createElement("div");
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
	].join(";");

	body.classList.add("gjj-text-merge-preview-body");

	toggleButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const nextMode = getPreviewMode(node) === MARKDOWN_MODE ? RAW_MODE : MARKDOWN_MODE;
		setPreviewMode(node, nextMode);
		applyPreviewContent(node);
		refreshLayout(node);
	});

	container.addEventListener("mousedown", (event) => event.stopPropagation());
	container.addEventListener("pointerdown", (event) => event.stopPropagation());

	toolbar.appendChild(toggleButton);
	container.appendChild(toolbar);
	container.appendChild(body);

	node.__gjjPreviewContainer = container;
	node.__gjjPreviewToggle = toggleButton;
	node.__gjjPreviewBody = body;
	node.__gjjPreviewWidget = node.addDOMWidget(PREVIEW_WIDGET_NAME, "HTML", container, { serialize: false });
	applyPreviewContent(node);
	return container;
}

function updatePreview(node, text) {
	node.__gjjPreviewText = String(text || "");
	ensurePreviewWidget(node);
	applyPreviewContent(node);
}

function refreshLayout(node) {
	node.setSize?.([node.size?.[0] || node.computeSize?.()?.[0] || 300, node.computeSize?.()?.[1] || node.size?.[1] || 80]);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
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
			setPreviewMode(this, getPreviewMode(this));
			ensurePreviewWidget(this);
			setTimeout(() => syncDynamicInputs(this), 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setPreviewMode(this, getPreviewMode(this));
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
			updatePreview(this, message?.text?.[0] || "");
			return result;
		};
	},

	async nodeCreated(node) {
		if (!TARGET_NODES.has(node?.comfyClass)) {
			return;
		}

		setPreviewMode(node, getPreviewMode(node));
		ensurePreviewWidget(node);
		setTimeout(() => syncDynamicInputs(node), 0);
	},
});
