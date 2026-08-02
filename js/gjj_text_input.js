import { app } from "/scripts/app.js";
import { queueOnlyCurrentNode } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_TextInput"]);
const TEXT_WIDGET_NAME = "text";
const TEXT_INPUT_NAME = "text_in";
const DOM_WIDGET_NAME = "gjj_text_input_markdown";
const SAVED_TEXT_PROPERTY = "gjj_text_input_saved_text";
const MODE_PROPERTY = "gjj_text_input_mode";
const WIDTH_PROPERTY = "gjj_text_input_width";
const HEIGHT_PROPERTY = "gjj_text_input_height";
const LAST_LINK_PROPERTY = "gjj_text_input_last_upstream_link";
const MODE_EDIT = "edit";
const MODE_PREVIEW = "preview";
const DEFAULT_NODE_WIDTH = 160;
const MIN_NODE_WIDTH = 160;
const WIDTH_GRID = 5;
const MIN_WIDGET_HEIGHT = 0;
const MIN_EDITOR_HEIGHT = 32;
// 不对用户高度设置 GJJ 下限；仅保留 ComfyUI 画布自身的结构限制。
const MIN_NODE_HEIGHT = 0;
const NODE_CHROME_HEIGHT = 52;
const HEIGHT_RESIZE_HANDLE_SIZE = 12;
const EMPTY_TEXT = "空文本";
const WAITING_UPSTREAM_TEXT = "等待执行后预览上游文本";
const DOUBLE_CLICK_MS = 420;
const HOLD_ICON_SVG = `<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M635.172 95.834c-1.998 1.999-3.996 3.999-5.996 5.997l-16.061 16.061-23.229 23.23-27.507 27.506-28.888 28.889-27.376 27.376-22.969 22.97-15.67 15.67c-2.473 2.473-5.002 4.904-7.388 7.462-13.211 14.175-21.229 32.737-22.46 52.078-1.213 19.078 4.198 38.318 15.289 53.899a84.425 84.425 0 0 0 9.07 10.72l31.855 31.869 182.6-182.397 109.26 109.485-182.384 182.374 20.919 20.92 10.193 10.193c5.181 5.182 10.847 9.786 17.141 13.558 16.325 9.776 35.837 13.714 54.68 11.066 17.979-2.523 34.807-11.007 47.594-23.882l5.997-5.996c5.354-5.354 10.706-10.708 16.061-16.061l23.229-23.23a713271.6 713271.6 0 0 0 27.505-27.506l28.891-28.889c9.124-9.126 18.251-18.25 27.375-27.376l22.971-22.97 15.669-15.67c2.472-2.472 4.996-4.904 7.396-7.445 13.269-14.051 21.348-32.522 22.611-51.809 1.252-19.079-4.176-38.311-15.231-53.911a85.416 85.416 0 0 0-9.286-10.995c-1.999-1.999-3.997-3.998-5.998-5.997-5.354-5.353-10.705-10.707-16.061-16.061l-23.229-23.23-27.505-27.506-28.891-28.889-27.374-27.376c-7.656-7.657-15.314-15.313-22.972-22.97l-15.669-15.67c-2.567-2.567-5.091-5.197-7.752-7.669-16.305-15.139-38.344-23.235-60.571-22.292-20.912 0.891-40.991 9.736-55.839 24.474M270.406 460.605l-5.99 5.997c-5.348 5.354-10.696 10.711-16.044 16.064l-23.208 23.239-27.484 27.52a787376.15 787376.15 0 0 0-28.871 28.908l-27.368 27.402-22.978 23.009-15.697 15.715c-2.415 2.419-4.882 4.802-7.231 7.287-13.289 14.056-21.379 32.548-22.674 51.85-1.28 19.061 4.081 38.305 15.116 53.905a84.198 84.198 0 0 0 9.252 10.961l5.99 5.998 16.043 16.064 23.208 23.236c9.162 9.172 18.323 18.348 27.484 27.521 9.624 9.636 19.248 19.271 28.871 28.908l27.369 27.403 22.977 23.007 15.697 15.719c2.417 2.419 4.792 4.895 7.293 7.229 14.189 13.233 32.776 21.258 52.139 22.518 19.101 1.241 38.388-4.114 54.027-15.168a84.46 84.46 0 0 0 10.748-9.034l5.984-5.984 16.032-16.032 23.197-23.196 27.479-27.479c9.625-9.626 19.25-19.251 28.877-28.875l27.392-27.392 23.022-23.024 15.772-15.771c2.31-2.31 4.662-4.584 6.913-6.949 13.354-14.033 21.499-32.532 22.885-51.852 1.37-19.068-3.854-38.374-14.785-54.073a84.293 84.293 0 0 0-9.367-11.228l-32.069-31.851L348.02 784.541 238.536 675.068 420.932 492.47c-6.974-6.975-13.947-13.952-20.922-20.927l-10.196-10.199c-5.894-5.896-12.449-11.012-19.774-15.02-19.235-10.525-42.329-13.024-63.399-7.006-13.644 3.901-26.169 11.292-36.235 21.287" fill="#0071BC"></path><path d="M876.584 751.132c11.711 11.711 11.761 30.69 0.024 42.428-11.712 11.711-30.691 11.712-42.404 0.05l-0.025 0.025-113.25-113.25 0.025-0.025-0.051-0.051c-11.711-11.711-11.786-30.717-0.024-42.479 11.737-11.737 30.742-11.66 42.453 0.051l0.504 0.504 112.24 112.24 0.508 0.507M791.677 836.039c11.711 11.711 11.736 30.715-0.025 42.477-11.685 11.686-30.69 11.712-42.378 0.024l-0.025 0.026-113.25-113.251 0.025-0.025-0.051-0.051c-11.711-11.711-11.736-30.767-0.05-42.453 11.761-11.761 30.792-11.71 42.503 0.001l0.504 0.504 112.24 112.24 0.507 0.508" fill="#00A0E9"></path></svg>`;
const COPY_NODE_ICON_SVG = `<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M744.155429 187.026286a92.891429 92.891429 0 0 1 92.891428 92.891428v614.619429a92.891429 92.891429 0 0 1-92.891428 92.891428H129.462857A92.891429 92.891429 0 0 1 36.571429 894.537143V279.844571c0-51.273143 41.545143-92.891429 92.891428-92.891428h614.692572z m0 74.24H129.462857a18.578286 18.578286 0 0 0-18.578286 18.578285v614.692572c0 10.24 8.265143 18.578286 18.578286 18.578286h614.692572c10.24 0 18.578286-8.265143 18.578285-18.578286V279.844571a18.578286 18.578286 0 0 0-18.578285-18.578285zM894.537143 36.571429c51.346286 0 92.891429 41.545143 92.891428 92.891428v614.692572a92.891429 92.891429 0 0 1-92.891428 92.891428 37.156571 37.156571 0 1 1 0-74.313143c10.24 0 18.578286-8.338286 18.578286-18.578285V129.462857a18.578286 18.578286 0 0 0-18.578286-18.578286H279.844571a18.578286 18.578286 0 0 0-18.578285 18.578286 37.156571 37.156571 0 1 1-74.24 0c0-51.346286 41.545143-92.891429 92.891428-92.891428h614.619429zM436.809143 388.534857c20.48 0 37.083429 16.603429 37.083428 37.083429V550.034286h124.489143a37.156571 37.156571 0 1 1 0 74.313143H473.892571v124.416a37.156571 37.156571 0 1 1-74.24 0l-0.073142-124.416h-124.342858a37.156571 37.156571 0 1 1 0-74.24l124.342858-0.073143v-124.342857c0-20.553143 16.676571-37.156571 37.229714-37.156572z" fill="#257FFF"></path></svg>`;
const CLIPBOARD_ICON_SVG = `<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M515.53 511.994m-495.082 0a495.082 495.082 0 1 0 990.164 0 495.082 495.082 0 1 0-990.164 0Z" fill="#95BAF9"></path><path d="M709.882 128.214H321.176c-85.654 0-155.338 69.686-155.338 155.34v390.382l0.002 0.004v68.488c0 85.654 69.684 155.34 155.338 155.34h388.708c85.654 0 155.338-69.686 155.338-155.34V283.556c0-85.654-69.684-155.342-155.342-155.342z" fill="#0A2BDE"></path><path d="M279.442 233.812h472.18v558.362h-472.18z" fill="#FFFFFF"></path><path d="M324.52 161.624v99.154c0 50.08 40.742 90.822 90.824 90.822H615.72c50.08 0 90.822-40.742 90.822-90.822V161.624H324.52z" fill="#95BAF9"></path><path d="M362.614 401.504h305.836v46.662H362.614zM362.614 511.64h305.836v46.66H362.614zM362.614 621.774h305.836v46.66H362.614z" fill="#95BAF9"></path></svg>`;

function getTextWidget(node) {
	return node.widgets?.find((widget) => widget?.name === TEXT_WIDGET_NAME);
}

function getInputByName(node, name) {
	return node?.inputs?.find((input) => String(input?.name || "") === name || String(input?.widget?.name || "") === name);
}

function hasLinkedTextInput(node) {
	return getInputByName(node, TEXT_INPUT_NAME)?.link != null;
}

function getGraphLink(linkId, graph = app.graph) {
	if (linkId == null || !graph) {
		return null;
	}
	if (typeof graph.getLink === "function") {
		const link = graph.getLink(linkId);
		if (link) return link;
	}
	const links = graph.links || graph._links;
	if (!links) {
		return null;
	}
	if (Array.isArray(links)) {
		return links.find((link) => String(link?.id ?? link?.[0]) === String(linkId)) || null;
	}
	if (links instanceof Map) {
		return links.get(linkId) || links.get(String(linkId)) || null;
	}
	return links[linkId] || links[String(linkId)] || null;
}

function getGraphNodeById(id, graph = app.graph) {
	if (id == null || !graph) {
		return null;
	}
	return graph.getNodeById?.(id)
		|| graph.getNodeById?.(Number(id))
		|| graph._nodes_by_id?.[id]
		|| graph._nodes_by_id?.[String(id)]
		|| graph._nodes?.find((item) => String(item?.id) === String(id))
		|| null;
}

function linkOriginId(link) {
	return Array.isArray(link) ? link[1] : link?.origin_id;
}

function linkOriginSlot(link) {
	return Number(Array.isArray(link) ? link[2] : link?.origin_slot);
}

function linkTargetSlot(link) {
	return Number(Array.isArray(link) ? link[4] : link?.target_slot);
}

function outputLabel(node, slot) {
	const output = node?.outputs?.[Number(slot)];
	return String(output?.label || output?.name || output?.type || `输出 ${Number(slot) + 1}`);
}

function sourceNodeTitle(node) {
	return String(node?.title || node?.comfyClass || node?.type || `节点 ${node?.id ?? ""}`).trim();
}

function storeLastTextInputLink(node, link, targetSlot = null) {
	if (!node || !link) {
		return false;
	}
	const sourceId = linkOriginId(link);
	const sourceSlot = linkOriginSlot(link);
	if (sourceId == null || !Number.isFinite(sourceSlot)) {
		return false;
	}
	const sourceNode = getGraphNodeById(sourceId, node.graph || app.graph);
	const slot = Number.isFinite(Number(targetSlot)) ? Number(targetSlot) : linkTargetSlot(link);
	node.properties = node.properties || {};
	node.properties[LAST_LINK_PROPERTY] = {
		source_id: sourceId,
		source_slot: sourceSlot,
		source_label: outputLabel(sourceNode, sourceSlot),
		source_title: sourceNodeTitle(sourceNode),
		target_input_name: TEXT_INPUT_NAME,
		target_slot: Number.isFinite(slot) ? slot : (node.inputs || []).findIndex((input) => input === getInputByName(node, TEXT_INPUT_NAME)),
	};
	updateReconnectButton(node);
	return true;
}

function recordCurrentTextInputLink(node) {
	const input = getInputByName(node, TEXT_INPUT_NAME);
	const link = getGraphLink(input?.link, node?.graph || app.graph);
	if (!link) {
		return false;
	}
	return storeLastTextInputLink(node, link, node.inputs?.indexOf(input));
}

function recordTextInputLinkFromConnectionEvent(node, args) {
	const [type, slot, connected, linkInfo] = args || [];
	const input = getInputByName(node, TEXT_INPUT_NAME);
	const inputSlot = node?.inputs?.indexOf(input);
	const isInputEvent =
		type === globalThis.LiteGraph?.INPUT ||
		type === 1 ||
		String(type).toLowerCase() === "input";
	if (!isInputEvent || Number(slot) !== Number(inputSlot)) {
		return false;
	}
	if (connected) {
		return recordCurrentTextInputLink(node);
	}
	return storeLastTextInputLink(node, linkInfo, inputSlot);
}

function lastTextInputLink(node) {
	const memory = node?.properties?.[LAST_LINK_PROPERTY];
	return memory && typeof memory === "object" ? memory : null;
}

function hasReconnectTarget(node) {
	const memory = lastTextInputLink(node);
	return Boolean(memory && memory.source_id != null && Number.isFinite(Number(memory.source_slot)) && !hasLinkedTextInput(node));
}

function updateReconnectButton(node) {
	const button = node?.__gjjTextInputReconnectButton;
	if (!button) {
		return;
	}
	const memory = lastTextInputLink(node);
	const visible = hasReconnectTarget(node);
	button.style.display = visible ? "" : "none";
	if (memory) {
		const source = [memory.source_title, memory.source_label].filter(Boolean).join(" · ");
		button.title = source ? `重新连接：${source}` : "重新连接上游";
		button.dataset.originalTitle = button.title;
	}
}

function getPreviewText(node) {
	const liveText = node?.__gjjTextInputLiveText;
	if (hasLinkedTextInput(node) && liveText !== undefined && liveText !== null && String(liveText) !== "") {
		return String(liveText);
	}
	if (hasLinkedTextInput(node)) {
		return preserveSavedTextValue(node);
	}
	return getTextValue(node);
}

function hasReadyLinkedPreviewText(node) {
	if (!hasLinkedTextInput(node)) {
		return false;
	}
	const text = String(getPreviewText(node) ?? "");
	return text !== "";
}

function getMode(node) {
	const mode = String(node?.properties?.[MODE_PROPERTY] || MODE_PREVIEW);
	return mode === MODE_PREVIEW ? MODE_PREVIEW : MODE_EDIT;
}

function setMode(node, mode) {
	node.properties = node.properties || {};
	node.properties[MODE_PROPERTY] = mode === MODE_PREVIEW ? MODE_PREVIEW : MODE_EDIT;
}

function normalizeWidth(value, fallback = 0) {
	const width = Number(value || 0);
	if (!Number.isFinite(width) || width < MIN_NODE_WIDTH) {
		return fallback;
	}
	return Math.round(width / WIDTH_GRID) * WIDTH_GRID;
}

function ensureStableWidth(node, fallback = DEFAULT_NODE_WIDTH, preferCurrent = false) {
	if (!node) {
		return fallback;
	}
	const sizeWidth = normalizeWidth(node.size?.[0]);
	const savedWidth = normalizeWidth(node.properties?.[WIDTH_PROPERTY]);
	const width = preferCurrent
		? (sizeWidth || savedWidth || fallback)
		: Math.max(sizeWidth, savedWidth, fallback);
	node.properties = node.properties || {};
	node.properties[WIDTH_PROPERTY] = width;
	node.min_width = Math.max(Number(node.min_width || 0), MIN_NODE_WIDTH);
	if (Array.isArray(node.size) && normalizeWidth(node.size[0]) !== width) {
		node.size[0] = width;
	}
	return width;
}

function getCurrentWidth(node) {
	if (!node) {
		return DEFAULT_NODE_WIDTH;
	}
	const sizeWidth = normalizeWidth(node.size?.[0]);
	const savedWidth = normalizeWidth(node.properties?.[WIDTH_PROPERTY]);
	return sizeWidth || savedWidth || DEFAULT_NODE_WIDTH;
}

function rememberWidth(node, preferCurrent = false) {
	if (!node) {
		return 0;
	}
	const width = ensureStableWidth(node, getCurrentWidth(node), preferCurrent);
	return width;
}

function effectiveWidgetWidth(node, width = 0) {
	return Math.max(MIN_NODE_WIDTH, normalizeWidth(width) || getCurrentWidth(node));
}

function syncEditorHeight(editor) {
	if (!editor) {
		return MIN_EDITOR_HEIGHT;
	}
	editor.style.height = "100%";
	return Math.max(MIN_EDITOR_HEIGHT, Math.ceil(editor.clientHeight || MIN_EDITOR_HEIGHT));
}

function normalizeHeight(value, fallback = MIN_NODE_HEIGHT) {
	const height = Number(value);
	return Number.isFinite(height) ? Math.max(MIN_NODE_HEIGHT, height) : fallback;
}

function getUserHeight(node, fallback = MIN_NODE_HEIGHT) {
	const currentHeight = normalizeHeight(node?.size?.[1], NaN);
	if (Number.isFinite(currentHeight)) return currentHeight;
	return normalizeHeight(node?.properties?.[HEIGHT_PROPERTY], fallback);
}

function applyUserSize(node, width, height, rememberHeight = true) {
	if (!node) return;
	const nextWidth = Math.max(MIN_NODE_WIDTH, normalizeWidth(width) || getCurrentWidth(node));
	const nextHeight = normalizeHeight(height, getUserHeight(node));
	if (!Array.isArray(node.size)) node.size = [nextWidth, nextHeight];
	node.size[0] = nextWidth;
	node.size[1] = nextHeight;
	if (rememberHeight) {
		node.properties = node.properties || {};
		node.properties[HEIGHT_PROPERTY] = nextHeight;
	}
	applyViewportHeight(node, [nextWidth, nextHeight]);
}

function applyViewportHeight(node, size = null) {
	const nodeHeight = normalizeHeight(size?.[1], getUserHeight(node));
	const height = Math.max(MIN_WIDGET_HEIGHT, nodeHeight - NODE_CHROME_HEIGHT);
	const element = node?.__gjjTextInputWidget?.element || node?.__gjjTextInputContainer;
	if (element?.style) element.style.height = `${height}px`;
	if (node?.__gjjTextInputContainer?.style) node.__gjjTextInputContainer.style.height = `${height}px`;
	return height;
}

function installHeightResizeHandle(node, container) {
	if (!node || !container || node.__gjjTextInputHeightResizeHandle) return;
	const handle = document.createElement("div");
	handle.className = "gjj-text-input-height-resize-handle";
	handle.title = "拖动调整节点高度";
	handle.style.cssText = [
		"position:absolute",
		"left:0",
		"right:0",
		"bottom:0",
		`height:${HEIGHT_RESIZE_HANDLE_SIZE}px`,
		"z-index:20",
		"cursor:ns-resize",
		"pointer-events:auto",
		"touch-action:none",
		"background:linear-gradient(to bottom,transparent 4px,rgba(111,151,160,.55) 5px,transparent 6px)",
	].join(";");
	handle.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const startY = Number(event.clientY || 0);
		const startHeight = Math.max(MIN_NODE_HEIGHT, Number(node.size?.[1] || MIN_NODE_HEIGHT));
		const pointerId = event.pointerId;
		handle.setPointerCapture?.(pointerId);
		const move = (moveEvent) => {
			moveEvent.preventDefault();
			moveEvent.stopPropagation();
			const scale = Math.max(0.05, Number(app.canvas?.ds?.scale || 1));
			const nextHeight = Math.max(
				MIN_NODE_HEIGHT,
				Math.round(startHeight + (Number(moveEvent.clientY || startY) - startY) / scale),
			);
			// 不调用 LiteGraph.setSize：它会按 DOM 内容高度重新夹紧，导致只能拉长不能缩短。
			applyUserSize(node, getCurrentWidth(node), nextHeight);
			node.setDirtyCanvas?.(true, true);
			app.graph?.setDirtyCanvas?.(true, true);
		};
		const finish = () => {
			handle.releasePointerCapture?.(pointerId);
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", finish);
			handle.removeEventListener("pointercancel", finish);
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", finish);
		handle.addEventListener("pointercancel", finish);
	});
	container.appendChild(handle);
	node.__gjjTextInputHeightResizeHandle = handle;
}

function enableManualHeightResize(node) {
	if (!node) return;
	node.resizable = true;
	node.min_size = [MIN_NODE_WIDTH, MIN_NODE_HEIGHT];
	node.min_width = MIN_NODE_WIDTH;
	node.min_height = MIN_NODE_HEIGHT;
	if (!node.__gjjTextInputComputeSizePatched) {
		node.__gjjTextInputComputeSizePatched = true;
		node.__gjjTextInputOriginalComputeSize = node.computeSize;
		node.computeSize = function () {
			return [MIN_NODE_WIDTH, MIN_NODE_HEIGHT];
		};
	}
	const widget = node.__gjjTextInputWidget;
	if (widget) {
		widget.computedHeight = MIN_WIDGET_HEIGHT;
		widget.getMinHeight = () => 1;
		widget.computeSize = (width) => [effectiveWidgetWidth(node, width), MIN_WIDGET_HEIGHT];
		widget.getHeight = () => MIN_WIDGET_HEIGHT;
		if (widget.options && typeof widget.options === "object") {
			widget.options.getMinHeight = () => 1;
		}
	}
}

function refreshNode(node) {
	if (!node) {
		return;
	}
	const width = rememberWidth(node);
	const nextWidth = Math.max(MIN_NODE_WIDTH, width);
	const nextHeight = getUserHeight(node);
	// 绝不调用 setSize/computeSize；二者都会让 DOM 内容重新参与最小高度计算。
	applyUserSize(node, nextWidth, nextHeight, false);
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

function splitDoublePipeTableRow(line) {
	let text = String(line || "").trim();
	if (!text.includes("||")) {
		return [];
	}
	if (text.startsWith("||")) {
		text = text.slice(2);
	}
	if (text.endsWith("||")) {
		text = text.slice(0, -2);
	}
	return text.split("||").map((cell) => cell.trim());
}

function isDoublePipeTableLine(line) {
	const cells = splitDoublePipeTableRow(line);
	return cells.length >= 2 && cells.some((cell) => cell.length > 0);
}

function isMarkdownTableSeparatorRow(cells) {
	return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(String(cell || "").replace(/\s+/g, "")));
}

function renderDoublePipeTable(rows) {
	const parsedRows = rows
		.map(splitDoublePipeTableRow)
		.filter((cells) => cells.length >= 2);
	if (!parsedRows.length) {
		return "";
	}
	const header = parsedRows[0];
	const bodyRows = parsedRows.slice(1).filter((cells) => !isMarkdownTableSeparatorRow(cells));
	const columnCount = Math.max(header.length, ...bodyRows.map((cells) => cells.length));
	const padCells = (cells) => {
		const padded = cells.slice(0, columnCount);
		while (padded.length < columnCount) padded.push("");
		return padded;
	};
	const head = padCells(header).map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("");
	const body = bodyRows
		.map((row) => `<tr>${padCells(row).map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`)
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
	let doublePipeTableLines = [];

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

	const flushDoublePipeTable = () => {
		if (!doublePipeTableLines.length) {
			return;
		}
		flushParagraph(parts, paragraph);
		flushList(parts, list);
		parts.push(renderDoublePipeTable(doublePipeTableLines));
		doublePipeTableLines = [];
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
				flushDoublePipeTable();
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
			flushDoublePipeTable();
			flushTable();
			flushParagraph(parts, paragraph);
			flushList(parts, list);
			continue;
		}

		if (isDoublePipeTableLine(trimmed)) {
			flushTable();
			flushParagraph(parts, paragraph);
			flushList(parts, list);
			doublePipeTableLines.push(trimmed);
			continue;
		}

		flushDoublePipeTable();

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
	flushDoublePipeTable();
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

function isTransientPreviewText(value) {
	return String(value ?? "") === WAITING_UPSTREAM_TEXT;
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
	if (isTransientPreviewText(value)) {
		return preserveSavedTextValue(node);
	}
	const domWidget = getDomWidget(node);
	if (domWidget) {
		domWidget.value = value;
	}
	node.properties = node.properties || {};
	node.properties[SAVED_TEXT_PROPERTY] = value;
	return value;
}

function preserveSavedTextValue(node) {
	const propertyValue = node?.properties?.[SAVED_TEXT_PROPERTY];
	const currentValue = getTextValue(node);
	const hasPropertyValue = propertyValue !== undefined && propertyValue !== null;
	const value = hasPropertyValue && !isTransientPreviewText(propertyValue)
		? String(propertyValue)
		: (!isTransientPreviewText(currentValue) ? String(currentValue ?? "") : "");
	const domWidget = getDomWidget(node);
	if (domWidget) {
		domWidget.value = value;
	}
	node.properties = node.properties || {};
	node.properties[SAVED_TEXT_PROPERTY] = value;
	return value;
}

function persistUpstreamText(node, value) {
	const nextValue = String(value ?? "");
	if (!node || !nextValue || isTransientPreviewText(nextValue)) return false;
	const previousValue = String(node?.properties?.[SAVED_TEXT_PROPERTY] ?? getTextValue(node) ?? "");
	node.__gjjTextInputLiveText = nextValue;
	if (previousValue === nextValue && getTextValue(node) === nextValue) return false;
	setTextValue(node, nextValue);
	syncSavedValue(node);
	node.graph?.change?.();
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
	return true;
}

function setupIconButton(button, label, svg) {
	button.innerHTML = svg;
	button.title = label;
	button.setAttribute("aria-label", label);
	button.dataset.originalTitle = label;
}

async function writeClipboardText(text) {
	const value = String(text ?? "");
	if (navigator?.clipboard?.writeText) {
		await navigator.clipboard.writeText(value);
		return true;
	}
	const textarea = document.createElement("textarea");
	textarea.value = value;
	textarea.setAttribute("readonly", "readonly");
	textarea.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
	document.body.appendChild(textarea);
	textarea.select();
	const ok = document.execCommand?.("copy");
	textarea.remove();
	if (!ok) {
		throw new Error("copy failed");
	}
	return true;
}

function flashButton(button, text, ok = true) {
	if (!button) {
		return;
	}
	const originalTitle = button.dataset.originalTitle || button.title || "";
	button.dataset.originalTitle = originalTitle;
	button.title = text;
	button.style.borderColor = ok ? "#66d19e" : "#c95d5d";
	button.style.background = ok ? "#143126" : "#351d1d";
	clearTimeout(button.__gjjTextInputFlashTimer);
	button.__gjjTextInputFlashTimer = setTimeout(() => {
		button.title = button.dataset.originalTitle || originalTitle;
		button.style.borderColor = "";
		button.style.background = "";
	}, 900);
}

function nodeRect(node, fallbackWidth = 260, fallbackHeight = 120) {
	const x = Number(node?.pos?.[0] || 0);
	const y = Number(node?.pos?.[1] || 0);
	const width = Number(node?.size?.[0] || fallbackWidth);
	const height = Number(node?.size?.[1] || fallbackHeight);
	return { x, y, width, height };
}

function rectsOverlap(a, b, padding = 4) {
	return !(
		a.x + a.width + padding <= b.x
		|| b.x + b.width + padding <= a.x
		|| a.y + a.height + padding <= b.y
		|| b.y + b.height + padding <= a.y
	);
}

function nextTextCopyPosition(sourceNode, copyNode, graph) {
	const source = nodeRect(sourceNode);
	const copy = nodeRect(copyNode, 260, Math.max(120, source.height));
	const x = source.x;
	const step = Math.max(copy.height, source.height, 120) - 5;
	let y = source.y - step;
	const nodes = Array.isArray(graph?._nodes) ? graph._nodes : [];
	for (let attempt = 0; attempt < 80; attempt += 1) {
		const candidate = { x, y, width: copy.width, height: copy.height };
		const occupied = nodes.some((item) => item !== copyNode && rectsOverlap(candidate, nodeRect(item)));
		if (!occupied) {
			return [x, y];
		}
		y -= step;
	}
	return [x, source.y - step];
}

function copyCurrentPreviewToNode(node) {
	const button = node?.__gjjTextInputCopyNodeButton;
	if (!hasReadyLinkedPreviewText(node)) {
		flashButton(button, "无内容", false);
		return;
	}
	const graph = node?.graph || app.graph;
	const liteGraph = globalThis.LiteGraph;
	const type = String(node?.type || node?.comfyClass || "GJJ_TextInput");
	const copyNode = liteGraph?.createNode?.(type) || liteGraph?.createNode?.("GJJ_TextInput");
	if (!copyNode || !graph?.add) {
		flashButton(button, "创建失败", false);
		return;
	}
	const text = getPreviewText(node);
	try {
		graph.add(copyNode);
		copyNode.pos = nextTextCopyPosition(node, copyNode, graph);
		setTextValue(copyNode, text);
		syncSavedValue(copyNode);
		setMode(copyNode, MODE_PREVIEW);
		copyNode.__gjjTextInputLiveText = null;
		scheduleStabilize(copyNode, 0);
		app.canvas?.selectNode?.(copyNode, false);
		refreshNode(copyNode);
		flashButton(button, "已创建");
	} catch (error) {
		console.warn("[GJJ_TextInput] create text copy node failed", error);
		try {
			graph.remove?.(copyNode);
		} catch (_) {
			// Ignore cleanup failure; the user can still delete the partial node.
		}
		flashButton(button, "创建失败", false);
	}
}

async function copyCurrentPreviewToClipboard(node) {
	const button = node?.__gjjTextInputCopyClipboardButton;
	if (!hasReadyLinkedPreviewText(node)) {
		flashButton(button, "无内容", false);
		return;
	}
	try {
		await writeClipboardText(getPreviewText(node));
		flashButton(button, "已复制到剪贴板");
	} catch (error) {
		console.warn("[GJJ_TextInput] copy to clipboard failed", error);
		flashButton(button, "复制失败", false);
	}
}

async function runCurrentTextInputNode(node) {
	const button = node?.__gjjTextInputRunButton;
	try {
		const queued = await queueOnlyCurrentNode(node);
		flashButton(button, queued ? "已运行当前节点" : "运行失败", Boolean(queued));
	} catch (error) {
		console.warn("[GJJ_TextInput] run current node failed", error);
		flashButton(button, "运行失败", false);
	}
}

function disconnectTextInput(node) {
	recordCurrentTextInputLink(node);
	const input = getInputByName(node, TEXT_INPUT_NAME);
	if (!input) {
		return;
	}
	const index = node.inputs?.indexOf(input) ?? -1;
	if (index >= 0 && typeof node.disconnectInput === "function") {
		node.disconnectInput(index);
		return;
	}
	const linkId = input.link;
	if (linkId != null && app.graph?.removeLink) {
		app.graph.removeLink(linkId);
		input.link = null;
	}
}

function reconnectTextInput(node) {
	const button = node?.__gjjTextInputReconnectButton;
	const memory = lastTextInputLink(node);
	if (!memory) {
		flashButton(button, "无记录", false);
		return false;
	}
	const graph = node?.graph || app.graph;
	const sourceNode = getGraphNodeById(memory.source_id, graph);
	const sourceSlot = Number(memory.source_slot);
	if (!sourceNode || !sourceNode.outputs?.[sourceSlot]) {
		flashButton(button, "来源不存在", false);
		return false;
	}
	const input = getInputByName(node, TEXT_INPUT_NAME);
	const targetSlot = node?.inputs?.indexOf(input);
	if (!input || targetSlot < 0) {
		flashButton(button, "接口不存在", false);
		return false;
	}
	if (input.link != null) {
		disconnectTextInput(node);
	}
	const savedText = preserveSavedTextValue(node);
	try {
		sourceNode.connect(sourceSlot, node, targetSlot);
		node.properties = node.properties || {};
		node.properties[SAVED_TEXT_PROPERTY] = savedText;
		node.__gjjTextInputLiveText = null;
		enterPreviewMode(node);
		scheduleStabilize(node, 0);
		refreshNode(node);
		flashButton(button, "已连接");
		return true;
	} catch (error) {
		console.warn("[GJJ_TextInput] reconnect upstream failed", error);
		flashButton(button, "连接失败", false);
		return false;
	}
}

function holdCurrentPreviewText(node) {
	if (!hasReadyLinkedPreviewText(node)) {
		flashButton(node?.__gjjTextInputHoldButton, "无内容", false);
		return;
	}
	const text = getPreviewText(node);
	setTextValue(node, text);
	syncSavedValue(node);
	node.__gjjTextInputLiveText = null;
	disconnectTextInput(node);
	enterPreviewMode(node);
	flashButton(node.__gjjTextInputHoldButton, "已保持");
	refreshNode(node);
}

function restoreSavedValue(node, serializedNode = null) {
	const textWidget = getTextWidget(node);
	const widgetValue = String(textWidget?.value ?? "");
	if (!textWidget || (widgetValue !== "" && !isTransientPreviewText(widgetValue))) {
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
	const savedFromValues = values.find((item) => typeof item === "string" && item !== "" && !isTransientPreviewText(item));
	const savedValue = [
		node.properties?.[SAVED_TEXT_PROPERTY],
		savedFromTextWidget,
		savedFromValues,
	].find((item) => item !== undefined && item !== null && !isTransientPreviewText(item));
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
		node.__gjjTextInputPreviewBody.innerHTML = renderMarkdown(getPreviewText(node));
	}
	if (node.__gjjTextInputActionBar) {
		const hasReadyText = hasReadyLinkedPreviewText(node);
		node.__gjjTextInputActionBar.style.display = preview && (hasReadyText || hasReconnectTarget(node)) ? "flex" : "none";
		updateReconnectButton(node);
		for (const button of [
			node.__gjjTextInputHoldButton,
			node.__gjjTextInputRunButton,
			node.__gjjTextInputCopyNodeButton,
			node.__gjjTextInputCopyClipboardButton,
		]) {
			if (button) button.style.display = hasReadyText ? "" : "none";
		}
	}
	if (node.__gjjTextInputEditor) {
		node.__gjjTextInputEditor.style.display = preview ? "none" : "block";
		const editorText = getMode(node) === MODE_EDIT ? getPreviewText(node) : getTextValue(node);
		if (node.__gjjTextInputEditor.value !== editorText) {
			node.__gjjTextInputEditor.value = editorText;
		}
		syncEditorHeight(node.__gjjTextInputEditor);
	}
	if (node.__gjjTextInputWidget) {
		node.__gjjTextInputWidget.computeSize = (width) => [
			effectiveWidgetWidth(node, width),
			MIN_WIDGET_HEIGHT,
		];
		node.__gjjTextInputWidget.getHeight = () => MIN_WIDGET_HEIGHT;
	}
	enableManualHeightResize(node);
	applyViewportHeight(node);
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
	node.__gjjTextInputEditingLinkedPreview = hasLinkedTextInput(node);
	node.__gjjTextInputEditInitialValue = getPreviewText(node);
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

function firstPreviewText(message) {
	const values = [
		message?.preview_text,
		message?.text,
		message?.ui?.preview_text,
	];
	for (const value of values) {
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item !== undefined && item !== null) return String(item);
			}
		} else if (value !== undefined && value !== null) {
			return String(value);
		}
	}
	return "";
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
		"position:relative",
		"gap:0",
		"width:100%",
		"height:100%",
		"min-height:0",
		"overflow:hidden",
		"box-sizing:border-box",
		`padding:0 0 ${HEIGHT_RESIZE_HANDLE_SIZE}px`,
	].join(";");

	const previewBody = document.createElement("div");
	previewBody.className = "comfy-markdown-content gjj-text-input-markdown-body";
	previewBody.title = "双击编辑";
	previewBody.style.cssText = [
		"display:block",
		"flex:1 1 auto",
		"min-height:0",
		"max-height:100%",
		"overflow:auto",
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
		"flex:1 1 auto",
		"width:100%",
		"min-height:0",
		"height:100%",
		"resize:none",
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

	const actionBar = document.createElement("div");
	actionBar.className = "gjj-text-input-action-bar";
	actionBar.style.cssText = [
		"display:none",
		"justify-content:flex-end",
		"align-items:center",
		"gap:6px",
		"margin:0 0 6px",
		"pointer-events:auto",
	].join(";");

	const holdButton = document.createElement("button");
	holdButton.type = "button";
	holdButton.className = "gjj-text-input-action-button";
	setupIconButton(holdButton, "保持文本并断开链接", HOLD_ICON_SVG);

	const reconnectButton = document.createElement("button");
	reconnectButton.type = "button";
	reconnectButton.className = "gjj-text-input-action-button";
	reconnectButton.textContent = "🔗";
	reconnectButton.title = "重新连接上游";
	reconnectButton.setAttribute("aria-label", reconnectButton.title);
	reconnectButton.dataset.originalTitle = reconnectButton.title;
	reconnectButton.style.display = "none";

	const runButton = document.createElement("button");
	runButton.type = "button";
	runButton.className = "gjj-text-input-action-button";
	runButton.textContent = "▶";
	runButton.title = "运行当前 GJJ_TextInput 节点";
	runButton.setAttribute("aria-label", "运行当前 GJJ_TextInput 节点");
	runButton.dataset.originalTitle = runButton.title;

	const copyNodeButton = document.createElement("button");
	copyNodeButton.type = "button";
	copyNodeButton.className = "gjj-text-input-action-button";
	setupIconButton(copyNodeButton, "复制节点：在当前节点旁边新建 GJJ_TextInput，并填入当前上游文本", COPY_NODE_ICON_SVG);

	const copyClipboardButton = document.createElement("button");
	copyClipboardButton.type = "button";
	copyClipboardButton.className = "gjj-text-input-action-button";
	setupIconButton(copyClipboardButton, "复制到剪贴板", CLIPBOARD_ICON_SVG);

	actionBar.append(holdButton, reconnectButton, runButton, copyNodeButton, copyClipboardButton);

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
		.gjj-text-input-action-button {
			width: 24px;
			height: 24px;
			padding: 3px;
			border: 1px solid #3a4f58;
			border-radius: 5px;
			background: #10191e;
			color: #cdd9d7;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			cursor: pointer;
		}
		.gjj-text-input-action-button svg {
			width: 16px;
			height: 16px;
			display: block;
		}
		.gjj-text-input-action-button:hover {
			border-color: #5f8fa0;
			background: #16242a;
		}
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
		if (!node.__gjjTextInputEditingLinkedPreview) {
			setTextValue(node, editor.value);
			syncSavedValue(node);
		}
		syncEditorHeight(editor);
		refreshNode(node);
	});
	editor.addEventListener("change", () => {
		if (!node.__gjjTextInputEditingLinkedPreview) {
			setTextValue(node, editor.value);
			syncSavedValue(node);
		}
		refreshNode(node);
	});
	editor.addEventListener("keydown", (event) => {
		if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key === "Enter")) {
			event.preventDefault();
			editor.blur();
		}
	});
	editor.addEventListener("blur", () => {
		const editedLinkedPreview = Boolean(node.__gjjTextInputEditingLinkedPreview);
		const changed = String(editor.value ?? "") !== String(node.__gjjTextInputEditInitialValue ?? "");
		if (!editedLinkedPreview || changed) {
			setTextValue(node, editor.value);
			syncSavedValue(node);
			if (editedLinkedPreview) {
				node.__gjjTextInputLiveText = null;
			}
		}
		node.__gjjTextInputEditingLinkedPreview = false;
		node.__gjjTextInputEditInitialValue = "";
		enterPreviewMode(node);
	});
	for (const button of [holdButton, reconnectButton, runButton, copyNodeButton, copyClipboardButton]) {
		button.addEventListener("pointerdown", (event) => event.stopPropagation());
		button.addEventListener("mousedown", (event) => event.stopPropagation());
		button.addEventListener("dblclick", (event) => event.stopPropagation());
	}
	holdButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		holdCurrentPreviewText(node);
	});
	reconnectButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		reconnectTextInput(node);
	});
	runButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		runCurrentTextInputNode(node);
	});
	copyNodeButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		copyCurrentPreviewToNode(node);
	});
	copyClipboardButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		copyCurrentPreviewToClipboard(node);
	});

	container.append(style, actionBar, previewBody, editor);
	installHeightResizeHandle(node, container);

	node.__gjjTextInputContainer = container;
	node.__gjjTextInputActionBar = actionBar;
	node.__gjjTextInputHoldButton = holdButton;
	node.__gjjTextInputReconnectButton = reconnectButton;
	node.__gjjTextInputRunButton = runButton;
	node.__gjjTextInputCopyNodeButton = copyNodeButton;
	node.__gjjTextInputCopyClipboardButton = copyClipboardButton;
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
		widget.computeSize = (width) => [effectiveWidgetWidth(node, width), MIN_WIDGET_HEIGHT];
		widget.getHeight = () => MIN_WIDGET_HEIGHT;
		node.__gjjTextInputWidget = widget;
		enableManualHeightResize(node);
		applyViewportHeight(node);
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
	enableManualHeightResize(node);
	ensureStableWidth(node);
	ensureDom(node);
	enableManualHeightResize(node);
	recordCurrentTextInputLink(node);
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

		const originalSetSize = nodeType.prototype.setSize;
		nodeType.prototype.setSize = function (size, ...args) {
			if (!Array.isArray(size)) {
				return originalSetSize?.apply(this, [size, ...args]);
			}
			const requestedWidth = Number(size[0]);
			const requestedHeight = normalizeHeight(size[1], getUserHeight(this));
			const result = originalSetSize?.apply(this, [size, ...args]);
			// LiteGraph/DOM widget 可以修改传入数组或按内容夹紧；最后无条件恢复用户请求高度。
			applyUserSize(this, requestedWidth, requestedHeight, !this.__gjjTextInputInternalResize);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const serializedHeight = Math.max(
				MIN_NODE_HEIGHT,
				Number(serializedNode?.properties?.[HEIGHT_PROPERTY] ?? serializedNode?.size?.[1] ?? MIN_NODE_HEIGHT),
			);
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			const serializedWidth = normalizeWidth(serializedNode?.size?.[0]);
			const savedWidth = normalizeWidth(serializedNode?.properties?.[WIDTH_PROPERTY] || this.properties?.[WIDTH_PROPERTY]);
			ensureStableWidth(this, serializedWidth || savedWidth || DEFAULT_NODE_WIDTH);
			this.properties = this.properties || {};
			this.properties[HEIGHT_PROPERTY] = serializedHeight;
			applyUserSize(this, serializedWidth || savedWidth || DEFAULT_NODE_WIDTH, serializedHeight);
			restoreSavedValue(this, serializedNode);
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const requestedSize = Array.isArray(args[0]) ? [...args[0]] : [...(this.size || [DEFAULT_NODE_WIDTH, MIN_NODE_HEIGHT])];
			const requestedHeight = normalizeHeight(requestedSize[1], getUserHeight(this));
			const result = originalOnResize?.apply(this, args);
			if (this.__gjjTextInputInternalResize) {
				return result;
			}
			applyUserSize(this, requestedSize[0], requestedHeight);
			rememberWidth(this, true);
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnDblClick = nodeType.prototype.onDblClick;
		nodeType.prototype.onDblClick = function (...args) {
			enterEditMode(this);
			const result = originalOnDblClick?.apply(this, args);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...args) {
			const result = originalOnExecuted?.apply(this, [message, ...args]);
			if (hasLinkedTextInput(this)) {
				const upstreamText = firstPreviewText(message);
				if (!persistUpstreamText(this, upstreamText)) {
					this.__gjjTextInputLiveText = preserveSavedTextValue(this);
				}
			} else {
				this.__gjjTextInputLiveText = null;
			}
			enterPreviewMode(this);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			recordTextInputLinkFromConnectionEvent(this, args);
			const result = originalOnConnectionsChange?.apply(this, args);
			recordCurrentTextInputLink(this);
			if (!hasLinkedTextInput(this)) {
				this.__gjjTextInputLiveText = null;
			}
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			const value = hasLinkedTextInput(this)
				? preserveSavedTextValue(this)
				: syncSavedValue(this);
			const width = rememberWidth(this);
			refreshNode(this);
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[SAVED_TEXT_PROPERTY] = value;
				const propertyWidth = normalizeWidth(getCurrentWidth(this) || width);
				if (propertyWidth > 0) {
					serializedNode.properties[WIDTH_PROPERTY] = propertyWidth;
				}
				const propertyHeight = Math.max(
					MIN_NODE_HEIGHT,
					Number(this.properties?.[HEIGHT_PROPERTY] ?? this.size?.[1] ?? MIN_NODE_HEIGHT),
				);
				serializedNode.properties[HEIGHT_PROPERTY] = propertyHeight;
				if (Array.isArray(serializedNode.size)) {
					const savedWidth = propertyWidth || normalizeWidth(serializedNode.size[0]);
					if (savedWidth > 0) {
						serializedNode.size[0] = savedWidth;
					}
					serializedNode.size[1] = propertyHeight;
				}
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
