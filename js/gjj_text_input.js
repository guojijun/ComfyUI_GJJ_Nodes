import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_TextInput"]);
const TEXT_WIDGET_NAME = "text";
const DOM_WIDGET_NAME = "gjj_text_input_markdown";
const SAVED_TEXT_PROPERTY = "gjj_text_input_saved_text";
const MODE_PROPERTY = "gjj_text_input_mode";
const WIDTH_PROPERTY = "gjj_text_input_width";
const MODE_EDIT = "edit";
const MODE_PREVIEW = "preview";
const DEFAULT_WIDTH = 320;
const EMPTY_TEXT = "空文本";
const DOUBLE_CLICK_MS = 420;

function getTextWidget(node) {
	return node.widgets?.find((widget) => widget?.name === TEXT_WIDGET_NAME);
}

function getMode(node) {
	const mode = String(node?.properties?.[MODE_PROPERTY] || MODE_PREVIEW);
	return mode === MODE_PREVIEW ? MODE_PREVIEW : MODE_EDIT;
}

function setMode(node, mode) {
	node.properties = node.properties || {};
	node.properties[MODE_PROPERTY] = mode === MODE_PREVIEW ? MODE_PREVIEW : MODE_EDIT;
}

function getCurrentWidth(node) {
	const sizeWidth = Number(node?.size?.[0] || 0);
	const savedWidth = Number(node?.properties?.[WIDTH_PROPERTY] || 0);
	return sizeWidth || savedWidth || DEFAULT_WIDTH;
}

function rememberWidth(node) {
	if (!node) {
		return DEFAULT_WIDTH;
	}
	const width = getCurrentWidth(node);
	node.properties = node.properties || {};
	node.properties[WIDTH_PROPERTY] = width;
	return width;
}

function refreshNode(node) {
	if (!node) {
		return;
	}
	const width = rememberWidth(node);
	const computed = node.computeSize?.([width, node.size?.[1] || 0]) || node.size || [width, 24];
	node.setSize?.([width, Math.max(24, Number(computed?.[1] || 24))]);
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function escapeHtml(text) {
	return String(text || "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("\"", "&quot;")
		.replaceAll("'", "&#39;");
}

function escapeAttribute(text) {
	return escapeHtml(text).replaceAll("`", "&#96;");
}

function stripTrailingUrlPunctuation(url) {
	let clean = String(url || "");
	let tail = "";
	while (/[.,;:!?，。；：！？）)\]\}]+$/.test(clean)) {
		tail = clean.slice(-1) + tail;
		clean = clean.slice(0, -1);
	}
	return [clean, tail];
}

function makeSafeLink(href, label) {
	const safeHref = escapeAttribute(href);
	return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

function renderInlineMarkdown(text) {
	const placeholders = [];
	const stash = (html) => {
		const key = `\u0000GJJ_MD_${placeholders.length}\u0000`;
		placeholders.push(html);
		return key;
	};

	// 关键：先在原始文本里把 Markdown 图片/链接转成占位符，避免后面的裸链接规则
	// 再去扫描已经生成的 <a href="https://...">，导致链接 HTML 被二次替换破坏。
	let source = String(text || "");
	source = source.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt, src) => {
		return stash(`<img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}">`);
	});
	source = source.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
		return stash(makeSafeLink(href, renderInlineMarkdown(label)));
	});

	let output = escapeHtml(source);
	output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
	output = output.replace(/\*\*\*([\s\S]+?)\*\*\*/g, "<strong><em>$1</em></strong>");
	output = output.replace(/___([\s\S]+?)___/g, "<strong><em>$1</em></strong>");
	output = output.replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>");
	output = output.replace(/__([\s\S]+?)__/g, "<strong>$1</strong>");
	output = output.replace(/(^|[^*])\*([^*\s](?:[\s\S]*?[^*\s])?)\*(?!\*)/g, "$1<em>$2</em>");
	output = output.replace(/(^|[\s([{>])_([^_\s][\s\S]*?[^_\s]|\S)_(?=$|[\s.,;:!?，。；：！？)\]}>])/g, "$1<em>$2</em>");
	output = output.replace(/~~([^~]+)~~/g, "<del>$1</del>");
	output = output.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<]+)/g, (_match, prefix, rawUrl) => {
		const [url, tail] = stripTrailingUrlPunctuation(rawUrl);
		const href = url.startsWith("www.") ? `https://${url}` : url;
		return `${prefix}${makeSafeLink(href, escapeHtml(url))}${escapeHtml(tail)}`;
	});

	for (let i = 0; i < placeholders.length; i += 1) {
		output = output.replaceAll(escapeHtml(`\u0000GJJ_MD_${i}\u0000`), placeholders[i]);
	}
	return output;
}

function flushParagraph(parts, lines) {
	if (!lines.length) {
		return;
	}
	parts.push(`<p>${lines.map(renderInlineMarkdown).join("<br>")}</p>`);
	lines.length = 0;
}

function flushList(parts, list) {
	if (!list.items.length) {
		return;
	}
	const tag = list.ordered ? "ol" : "ul";
	parts.push(`<${tag}>${list.items.join("")}</${tag}>`);
	list.items.length = 0;
	list.ordered = false;
}

function renderMarkdownTable(lines) {
	if (lines.length < 2 || !/^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[1])) {
		return "";
	}
	const parseRow = (line) => String(line)
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
	const headers = parseRow(lines[0]);
	const rows = lines.slice(2).map(parseRow);
	const head = headers.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("");
	const body = rows
		.map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`)
		.join("");
	return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderMarkdown(text) {
	const source = String(text || "").replace(/\r\n/g, "\n").trim();
	if (!source) {
		return `<p class="gjj-text-input-empty">${EMPTY_TEXT}</p>`;
	}

	const lines = source.split("\n");
	const parts = [];
	const paragraph = [];
	const list = { ordered: false, items: [] };
	let inCode = false;
	let codeLines = [];
	let tableLines = [];

	const flushTable = () => {
		if (!tableLines.length) {
			return false;
		}
		const html = renderMarkdownTable(tableLines);
		if (html) {
			flushParagraph(parts, paragraph);
			flushList(parts, list);
			parts.push(html);
			tableLines = [];
			return true;
		}
		paragraph.push(...tableLines);
		tableLines = [];
		return false;
	};

	for (const line of lines) {
		const trimmed = line.trim();
		const codeFence = trimmed.match(/^(```|~~~)/);
		if (codeFence) {
			if (inCode) {
				parts.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
				codeLines = [];
				inCode = false;
			} else {
				flushTable();
				flushParagraph(parts, paragraph);
				flushList(parts, list);
				inCode = true;
			}
			continue;
		}

		if (inCode) {
			codeLines.push(line);
			continue;
		}

		if (!trimmed) {
			flushTable();
			flushParagraph(parts, paragraph);
			flushList(parts, list);
			continue;
		}

		if (trimmed.includes("|")) {
			tableLines.push(line);
			if (tableLines.length === 1) {
				continue;
			}
			if (renderMarkdownTable(tableLines)) {
				continue;
			}
			paragraph.push(...tableLines);
			tableLines = [];
			continue;
		} else {
			flushTable();
		}

		const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
		if (headingMatch) {
			flushTable();
			flushParagraph(parts, paragraph);
			flushList(parts, list);
			const level = headingMatch[1].length;
			parts.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
			continue;
		}

		if (/^[-*_]{3,}$/.test(trimmed)) {
			flushTable();
			flushParagraph(parts, paragraph);
			flushList(parts, list);
			parts.push("<hr>");
			continue;
		}

		const quoteMatch = trimmed.match(/^>\s?(.+)$/);
		if (quoteMatch) {
			flushTable();
			flushParagraph(parts, paragraph);
			flushList(parts, list);
			parts.push(`<blockquote>${renderInlineMarkdown(quoteMatch[1])}</blockquote>`);
			continue;
		}

		const unorderedMatch = trimmed.match(/^[-*+]\s+(.+)$/);
		const orderedMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
		if (unorderedMatch || orderedMatch) {
			flushTable();
			flushParagraph(parts, paragraph);
			const ordered = Boolean(orderedMatch);
			if (list.items.length && list.ordered !== ordered) {
				flushList(parts, list);
			}
			list.ordered = ordered;
			let itemText = (orderedMatch || unorderedMatch)[1];
			const taskMatch = itemText.match(/^\[([ xX])\]\s+(.+)$/);
			if (taskMatch) {
				const checked = taskMatch[1].toLowerCase() === "x" ? " checked" : "";
				itemText = `<input type="checkbox" disabled${checked}> ${renderInlineMarkdown(taskMatch[2])}`;
			} else {
				itemText = renderInlineMarkdown(itemText);
			}
			list.items.push(`<li>${itemText}</li>`);
			continue;
		}

		paragraph.push(line);
	}

	if (inCode) {
		parts.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
	}
	flushTable();
	flushParagraph(parts, paragraph);
	flushList(parts, list);
	return parts.join("");
}

function getTextValue(node) {
	return String(getTextWidget(node)?.value ?? "");
}

function getDomWidget(node) {
	return node.widgets?.find((widget) => widget?.name === DOM_WIDGET_NAME);
}

function setTextValue(node, value) {
	const widget = getTextWidget(node);
	if (!widget) {
		return;
	}
	const nextValue = String(value ?? "");
	widget.value = nextValue;
	if (widget.inputEl) {
		widget.inputEl.value = nextValue;
	}
	if (widget.element && "value" in widget.element) {
		widget.element.value = nextValue;
	}
	widget.callback?.(nextValue);
}

function syncSavedValue(node) {
	const value = getTextValue(node);
	const domWidget = getDomWidget(node);
	if (domWidget) {
		domWidget.value = value;
	}
	node.properties = node.properties || {};
	node.properties[SAVED_TEXT_PROPERTY] = value;
	return value;
}

function restoreSavedValue(node, serializedNode = null) {
	const textWidget = getTextWidget(node);
	if (!textWidget || String(textWidget.value ?? "") !== "") {
		syncSavedValue(node);
		return;
	}
	const values = Array.isArray(serializedNode?.widgets_values)
		? serializedNode.widgets_values
		: (Array.isArray(node.widgets_values) ? node.widgets_values : []);
	const savedFromTextWidget = Array.isArray(serializedNode?.widgets)
		? (() => {
			const index = serializedNode.widgets.findIndex((widget) => widget?.name === TEXT_WIDGET_NAME);
			return index >= 0 ? values[index] : undefined;
		})()
		: undefined;
	const savedFromValues = values.find((item) => typeof item === "string" && item !== "");
	const savedValue = node.properties?.[SAVED_TEXT_PROPERTY] ?? savedFromTextWidget ?? savedFromValues;
	if (savedValue !== undefined && savedValue !== null) {
		setTextValue(node, savedValue);
	}
	syncSavedValue(node);
}

function safeAssignWidgetProperty(widget, key, value) {
	if (!widget) {
		return;
	}
	let target = widget;
	while (target) {
		const descriptor = Object.getOwnPropertyDescriptor(target, key);
		if (descriptor) {
			if (descriptor.set || descriptor.writable) {
				try { widget[key] = value; } catch (_) {}
			}
			return;
		}
		target = Object.getPrototypeOf(target);
	}
	try { widget[key] = value; } catch (_) {}
}

function collapseElement(el) {
	if (!el?.style) {
		return;
	}
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

function restoreElement(el) {
	if (!el?.style) {
		return;
	}
	el.style.display = "";
	el.style.pointerEvents = "";
	el.style.height = "";
	el.style.minHeight = "";
	el.style.maxHeight = "";
	el.style.margin = "";
	el.style.padding = "";
	el.style.border = "";
	el.style.overflow = "";
}

function setWidgetVisible(widget, visible) {
	if (!widget) {
		return;
	}
	if (!widget.__gjjTextInputOriginals) {
		widget.__gjjTextInputOriginals = {
			computeSize: widget.computeSize,
			draw: widget.draw,
			getHeight: widget.getHeight,
			hidden: widget.hidden,
			label: widget.label,
			type: widget.type,
			y: widget.y,
			last_y: widget.last_y,
			serialize: widget.serialize,
		};
	}
	if (visible) {
		const originals = widget.__gjjTextInputOriginals;
		safeAssignWidgetProperty(widget, "hidden", originals.hidden || false);
		widget.computeSize = originals.computeSize;
		widget.draw = originals.draw;
		widget.getHeight = originals.getHeight;
		safeAssignWidgetProperty(widget, "type", originals.type);
		safeAssignWidgetProperty(widget, "label", originals.label);
		safeAssignWidgetProperty(widget, "y", originals.y);
		safeAssignWidgetProperty(widget, "last_y", originals.last_y);
		safeAssignWidgetProperty(widget, "serialize", originals.serialize);
		restoreElement(widget.inputEl);
		restoreElement(widget.element);
		restoreElement(widget.widget);
		return;
	}

	// 完整隐藏：不能只设 hidden，也不能写 height/margin/padding 这些只读 getter。
	// ComfyUI/LiteGraph 会给每个 widget 额外叠加一点间距，
	// 所以隐藏 widget 不能返回 [0, 0]，否则仍会挤出一行空白。
	// 用 -4 抵消默认 widget 间距，同时清掉 y/last_y/size。
	safeAssignWidgetProperty(widget, "hidden", true);
	safeAssignWidgetProperty(widget, "type", `converted-widget:${widget.name || "hidden"}`);
	safeAssignWidgetProperty(widget, "label", "");
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => -4;
	widget.draw = () => {};
	safeAssignWidgetProperty(widget, "y", 0);
	safeAssignWidgetProperty(widget, "last_y", 0);
	safeAssignWidgetProperty(widget, "size", [0, -4]);
	safeAssignWidgetProperty(widget, "height", -4);
	// 仍然保留 widget 本体，避免影响 prompt 序列化；只是不参与面板布局。
	safeAssignWidgetProperty(widget, "serialize", true);
	if (widget.options && typeof widget.options === "object") {
		widget.options.hidden = true;
		widget.options.display = "hidden";
	}
	collapseElement(widget.inputEl);
	collapseElement(widget.element);
	collapseElement(widget.widget);
}

function collapseNativeTextWidget(node) {
	setWidgetVisible(getTextWidget(node), false);
}

function applyMode(node) {
	const mode = getMode(node);
	const preview = mode === MODE_PREVIEW;
	collapseNativeTextWidget(node);

	if (node.__gjjTextInputPreviewBody) {
		node.__gjjTextInputPreviewBody.style.display = preview ? "block" : "none";
		node.__gjjTextInputPreviewBody.innerHTML = renderMarkdown(getTextValue(node));
	}
	if (node.__gjjTextInputEditor) {
		node.__gjjTextInputEditor.style.display = preview ? "none" : "block";
		if (node.__gjjTextInputEditor.value !== getTextValue(node)) {
			node.__gjjTextInputEditor.value = getTextValue(node);
		}
		node.__gjjTextInputEditor.style.height = "auto";
		node.__gjjTextInputEditor.style.height = `${Math.max(120, node.__gjjTextInputEditor.scrollHeight || 120)}px`;
	}
	if (node.__gjjTextInputWidget) {
		node.__gjjTextInputWidget.computeSize = (width) => [
			Number(width || getCurrentWidth(node)) || DEFAULT_WIDTH,
			Math.max(24, Math.ceil(node.__gjjTextInputContainer?.scrollHeight || 24)),
		];
	}
	refreshNode(node);
}

function disableStandardStatus(node) {
	const state = node?.__gjjStandardStatus;
	if (!state) {
		return;
	}
	state.visible = false;
	if (state.wrap) {
		state.wrap.style.display = "none";
	}
	if (state.widget) {
		state.widget.hidden = true;
		state.widget.computeSize = () => [0, -4];
		state.widget.getHeight = () => -4;
		state.widget.draw = () => {};
	}
}

function enterEditMode(node) {
	setMode(node, MODE_EDIT);
	applyMode(node);
	setTimeout(() => {
		const input = node.__gjjTextInputEditor;
		input?.focus?.();
		input?.select?.();
	}, 0);
}

function handlePreviewPointer(node, event) {
	if (handleMarkdownLinkEvent(event)) {
		return;
	}
	const now = Date.now();
	if (event.type === "mousedown" && now - Number(node.__gjjTextInputLastPointerEvent || 0) < 40) {
		event.stopPropagation();
		return;
	}
	node.__gjjTextInputLastPointerEvent = now;
	const last = Number(node.__gjjTextInputLastPointer || 0);
	node.__gjjTextInputLastPointer = now;
	event.stopPropagation();
	if (event.detail >= 2 || (last > 0 && now - last <= DOUBLE_CLICK_MS)) {
		event.preventDefault();
		enterEditMode(node);
	}
}

function enterPreviewMode(node) {
	setMode(node, MODE_PREVIEW);
	applyMode(node);
}


function findLinkTarget(event) {
	const target = event?.target;
	return target?.closest?.("a[href]") || null;
}

function handleMarkdownLinkEvent(event) {
	const link = findLinkTarget(event);
	if (!link) {
		return false;
	}
	event.stopPropagation();
	return true;
}

function openMarkdownLink(event) {
	const link = findLinkTarget(event);
	if (!link) {
		return false;
	}
	event.preventDefault();
	event.stopPropagation();
	if (typeof event.stopImmediatePropagation === "function") {
		event.stopImmediatePropagation();
	}

	const now = Date.now();
	if (now - Number(link.__gjjTextInputLastOpen || 0) < 500) {
		return true;
	}
	link.__gjjTextInputLastOpen = now;

	const href = link.href || link.getAttribute("href") || "";
	if (href) {
		window.open(href, "_blank", "noopener,noreferrer");
	}
	return true;
}

function bindTextWidget(node) {
	const widget = getTextWidget(node);
	if (!widget || widget.__gjjTextInputMarkdownBound) {
		return;
	}
	widget.__gjjTextInputMarkdownBound = true;

	const originalCallback = widget.callback;
	widget.callback = function (...args) {
		const result = originalCallback?.apply(this, args);
		syncSavedValue(node);
		applyMode(node);
		return result;
	};

	const input = widget.inputEl || widget.element?.querySelector?.("textarea,input");
	if (input) {
		input.addEventListener("input", () => {
			syncSavedValue(node);
			applyMode(node);
		});
		input.addEventListener("change", () => {
			syncSavedValue(node);
			applyMode(node);
		});
		input.addEventListener("blur", () => enterPreviewMode(node));
		input.addEventListener("keydown", (event) => {
			if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key === "Enter")) {
				event.preventDefault();
				input.blur();
			}
		});
	}
}

function buildDom(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:0",
		"width:100%",
		"box-sizing:border-box",
		"padding:0",
	].join(";");

	const previewBody = document.createElement("div");
	previewBody.className = "comfy-markdown-content gjj-text-input-markdown-body";
	previewBody.title = "双击编辑";
	previewBody.style.cssText = [
		"display:block",
		"min-height:0",
		"max-height:none",
		"overflow:visible",
		"padding:0",
		"border:0",
		"border-radius:0",
		"background:transparent",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.55",
		"word-break:break-word",
		"box-sizing:border-box",
		"cursor:text",
		"pointer-events:auto",
	].join(";");

	const editor = document.createElement("textarea");
	editor.className = "gjj-text-input-editor";
	editor.value = getTextValue(node);
	editor.placeholder = "请输入文本";
	editor.spellcheck = false;
	editor.style.cssText = [
		"display:none",
		"width:100%",
		"min-height:120px",
		"height:auto",
		"resize:vertical",
		"box-sizing:border-box",
		"padding:8px 10px",
		"border:1px solid #44565f",
		"border-radius:6px",
		"outline:none",
		"background:#071012",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.55",
		"font-family:ui-monospace, SFMono-Regular, Consolas, monospace",
		"white-space:pre-wrap",
		"overflow:auto",
	].join(";");

	const style = document.createElement("style");
	style.textContent = `
		.gjj-text-input-markdown-body h1,
		.gjj-text-input-markdown-body h2,
		.gjj-text-input-markdown-body h3,
		.gjj-text-input-markdown-body h4,
		.gjj-text-input-markdown-body h5,
		.gjj-text-input-markdown-body h6 {
			margin: 0.35em 0 0.45em;
			color: #f4fbf7;
			line-height: 1.25;
			font-weight: 700;
		}
		.gjj-text-input-markdown-body h1 { font-size: 26px; }
		.gjj-text-input-markdown-body h2 { font-size: 21px; }
		.gjj-text-input-markdown-body h3 { font-size: 17px; }
		.gjj-text-input-markdown-body h4 { font-size: 14px; }
		.gjj-text-input-markdown-body h5,
		.gjj-text-input-markdown-body h6 { font-size: 12px; }
		.gjj-text-input-markdown-body p { margin: 0 0 0.7em; }
		.gjj-text-input-markdown-body ul,
		.gjj-text-input-markdown-body ol { margin: 0 0 0.75em 1.3em; padding: 0; }
		.gjj-text-input-markdown-body li { margin: 0.18em 0; }
		.gjj-text-input-markdown-body > :first-child { margin-top: 0; }
		.gjj-text-input-markdown-body > :last-child { margin-bottom: 0; }
		.gjj-text-input-markdown-body li input[type="checkbox"] {
			margin: 0 5px 0 0;
			vertical-align: -2px;
		}
		.gjj-text-input-markdown-body blockquote {
			margin: 0 0 0.75em;
			padding: 6px 10px;
			border-left: 3px solid #5fbcc4;
			background: #162329;
			color: #c7d7d5;
		}
		.gjj-text-input-markdown-body pre {
			margin: 0 0 0.75em;
			padding: 8px 10px;
			overflow: auto;
			border-radius: 6px;
			background: #090f12;
			border: 1px solid #2d3b42;
		}
		.gjj-text-input-markdown-body code {
			padding: 1px 4px;
			border-radius: 4px;
			background: #0b1115;
			color: #b8f3e9;
			font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
			font-size: 11px;
		}
		.gjj-text-input-markdown-body pre code { padding: 0; background: transparent; }
		.gjj-text-input-markdown-body table {
			width: 100%;
			border-collapse: collapse;
			margin: 0 0 0.75em;
			font-size: 11px;
		}
		.gjj-text-input-markdown-body th,
		.gjj-text-input-markdown-body td {
			border: 1px solid #34464e;
			padding: 5px 7px;
			text-align: left;
		}
		.gjj-text-input-markdown-body th { background: #1b2930; }
		.gjj-text-input-markdown-body a { color: #7dd3fc; text-decoration: underline; cursor: pointer; pointer-events: auto; }
		.gjj-text-input-markdown-body a:hover { text-decoration: underline; }
		.gjj-text-input-markdown-body img {
			max-width: 100%;
			max-height: 240px;
			object-fit: contain;
			border-radius: 6px;
			display: block;
			margin: 4px 0 8px;
		}
		.gjj-text-input-markdown-body hr {
			border: none;
			border-top: 1px solid #34464e;
			margin: 10px 0;
		}
		.gjj-text-input-empty { color: #8ea0a8; }
	`;

	// 链接事件必须在捕获阶段先截住，否则 ComfyUI 画布/节点拖拽事件会吃掉点击。
	// 关键：pointerdown 直接打开链接，不再等 click；ComfyUI 的节点拖拽逻辑有时会吞掉 click，
	// 所以之前会出现“单击没反应，双击才打开”。
	previewBody.addEventListener("pointerdown", (event) => {
		if (findLinkTarget(event)) {
			openMarkdownLink(event);
		}
	}, true);
	previewBody.addEventListener("mousedown", (event) => {
		if (findLinkTarget(event)) {
			handleMarkdownLinkEvent(event);
		}
	}, true);
	previewBody.addEventListener("click", (event) => {
		if (findLinkTarget(event)) {
			openMarkdownLink(event);
		}
	}, true);

	container.addEventListener("pointerdown", (event) => handlePreviewPointer(node, event));
	container.addEventListener("mousedown", (event) => handlePreviewPointer(node, event));
	container.addEventListener("dblclick", (event) => {
		event.preventDefault();
		event.stopPropagation();
		enterEditMode(node);
	});
	previewBody.addEventListener("pointerdown", (event) => handlePreviewPointer(node, event));
	previewBody.addEventListener("mousedown", (event) => handlePreviewPointer(node, event));
	previewBody.addEventListener("dblclick", (event) => {
		event.preventDefault();
		event.stopPropagation();
		enterEditMode(node);
	});
	previewBody.addEventListener("click", (event) => {
		openMarkdownLink(event);
	});
	editor.addEventListener("pointerdown", (event) => event.stopPropagation());
	editor.addEventListener("mousedown", (event) => event.stopPropagation());
	editor.addEventListener("dblclick", (event) => event.stopPropagation());
	editor.addEventListener("input", () => {
		setTextValue(node, editor.value);
		syncSavedValue(node);
		editor.style.height = "auto";
		editor.style.height = `${Math.max(120, editor.scrollHeight || 120)}px`;
		refreshNode(node);
	});
	editor.addEventListener("change", () => {
		setTextValue(node, editor.value);
		syncSavedValue(node);
		refreshNode(node);
	});
	editor.addEventListener("keydown", (event) => {
		if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key === "Enter")) {
			event.preventDefault();
			editor.blur();
		}
	});
	editor.addEventListener("blur", () => {
		setTextValue(node, editor.value);
		syncSavedValue(node);
		enterPreviewMode(node);
	});

	container.append(style, previewBody, editor);

	node.__gjjTextInputContainer = container;
	node.__gjjTextInputPreviewBody = previewBody;
	node.__gjjTextInputEditor = editor;
	return container;
}

function ensureDom(node) {
	if (!node || node.__gjjTextInputWidget) {
		return;
	}
	const container = buildDom(node);
	const widget = node.addDOMWidget?.(DOM_WIDGET_NAME, "HTML", container, {
		serialize: true,
		hideOnZoom: false,
	});
	if (widget) {
		widget.value = getTextValue(node);
		widget.computeSize = (width) => [Number(width || getCurrentWidth(node)) || DEFAULT_WIDTH, 24];
		node.__gjjTextInputWidget = widget;
	}
	if (Array.isArray(node.widgets)) {
		const domIndex = node.widgets.indexOf(widget);
		const textIndex = node.widgets.findIndex((candidate) => candidate?.name === TEXT_WIDGET_NAME);
		if (domIndex >= 0 && textIndex >= 0 && domIndex > textIndex) {
			node.widgets.splice(domIndex, 1);
			node.widgets.splice(textIndex, 0, widget);
		}
	}
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}
	ensureDom(node);
	bindTextWidget(node);
	disableStandardStatus(node);
	restoreSavedValue(node);
	if (!node.properties?.[MODE_PROPERTY]) {
		setMode(node, MODE_PREVIEW);
	}
	applyMode(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjTextInputTimer);
	node.__gjjTextInputTimer = setTimeout(() => stabilizeNode(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.TextInput",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		const originalAddWidget = nodeType.prototype.addWidget;
		nodeType.prototype.addWidget = function (type, name, value, callback, options, ...rest) {
			const widget = originalAddWidget?.apply(this, [type, name, value, callback, options, ...rest]);
			if (name === TEXT_WIDGET_NAME) {
				collapseNativeTextWidget(this);
			}
			return widget;
		};

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			const serializedWidth = Number(serializedNode?.size?.[0] || 0);
			const savedWidth = Number(serializedNode?.properties?.[WIDTH_PROPERTY] || this.properties?.[WIDTH_PROPERTY] || 0);
			const width = serializedWidth || savedWidth;
			if (width > 0) {
				this.properties = this.properties || {};
				this.properties[WIDTH_PROPERTY] = width;
				if (Array.isArray(this.size) && !Number(this.size[0] || 0)) {
					this.size[0] = width;
				}
			}
			restoreSavedValue(this, serializedNode);
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			rememberWidth(this);
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnDblClick = nodeType.prototype.onDblClick;
		nodeType.prototype.onDblClick = function (...args) {
			enterEditMode(this);
			const result = originalOnDblClick?.apply(this, args);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			const value = syncSavedValue(this);
			rememberWidth(this);
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[SAVED_TEXT_PROPERTY] = value;
				serializedNode.properties[WIDTH_PROPERTY] = getCurrentWidth(this);
				if (Array.isArray(serializedNode.widgets_values) && Array.isArray(this.widgets)) {
					const domIndex = this.widgets.findIndex((widget) => widget?.name === DOM_WIDGET_NAME);
					const textIndex = this.widgets.findIndex((widget) => widget?.name === TEXT_WIDGET_NAME);
					if (domIndex >= 0) {
						serializedNode.widgets_values[domIndex] = value;
					}
					if (textIndex >= 0) {
						serializedNode.widgets_values[textIndex] = value;
					}
				}
			}
			return result;
		};
	},

	nodeCreated(node) {
		if (TARGET_NODES.has(node?.comfyClass)) {
			scheduleStabilize(node, 0);
		}
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				stabilizeNode(node);
			}
		}
	},
});
