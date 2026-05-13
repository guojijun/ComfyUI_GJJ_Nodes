import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_AnyPreview"]);
const INPUT_PREFIX = "any_";
const MIN_VISIBLE_INPUTS = 1;
const ANY_INPUT_TYPE = "*";
const INPUT_DISPLAY_PREFIX = "输入 ";
const INPUT_TOOLTIP = "可连接任意类型；同类数据会自动合并后预览和输出。";
const PREVIEW_WIDGET_NAME = "gjj_any_preview_text";
const EMPTY_PREVIEW = "执行后在这里预览文本、对象或调试信息";
const MIN_PREVIEW_HEIGHT = 96;
const IMAGE_PREVIEW_MIN_HEIGHT = 124;
const SINGLE_IMAGE_PREVIEW_HEIGHT = 360;
const MIN_NODE_HEIGHT = 40;
const MIN_WIDTH = 300;
const NODE_BOTTOM_PADDING = 10;
const LORA_EFFECT_LIVE_TEXT_MAP_KEY = "__gjjLoraEffectTesterLiveTextByNodeId";
const MODE_EDIT = "edit";
const MODE_PREVIEW = "preview";
const DOUBLE_CLICK_MS = 420;

function getMode(node) {
	const mode = String(node?.properties?.["gjj_any_preview_mode"] || MODE_PREVIEW);
	return mode === MODE_PREVIEW ? MODE_PREVIEW : MODE_EDIT;
}

function setMode(node, mode) {
	node.properties = node.properties || {};
	node.properties["gjj_any_preview_mode"] = mode === MODE_PREVIEW ? MODE_PREVIEW : MODE_EDIT;
}

function enterEditMode(node) {
	setMode(node, MODE_EDIT);
	applyPreviewContent(node);
	setTimeout(() => {
		const editor = node.__gjjAnyPreviewEditor;
		editor?.focus?.();
		editor?.select?.();
	}, 0);
}

function enterPreviewMode(node) {
	setMode(node, MODE_PREVIEW);
	applyPreviewContent(node);
}

function handlePreviewPointer(node, event) {
	const now = Date.now();
	if (event.type === "mousedown" && now - Number(node.__gjjAnyPreviewLastPointerEvent || 0) < 40) {
		event.stopPropagation();
		return;
	}
	node.__gjjAnyPreviewLastPointerEvent = now;
	const last = Number(node.__gjjAnyPreviewLastPointer || 0);
	node.__gjjAnyPreviewLastPointer = now;
	event.stopPropagation();
	if (event.detail >= 2 || (last > 0 && now - last <= DOUBLE_CLICK_MS)) {
		event.preventDefault();
		enterEditMode(node);
	}
}

function imageDataToUrl(data) {
	if (!data?.filename) {
		return "";
	}
	const previewFormat =
		typeof app.getPreviewFormatParam === "function"
			? app.getPreviewFormatParam()
			: "";
	const randParam =
		typeof app.getRandParam === "function" ? app.getRandParam() : "";
	return api.apiURL(
		`/view?filename=${encodeURIComponent(data.filename)}&type=${encodeURIComponent(data.type || "temp")}&subfolder=${encodeURIComponent(data.subfolder || "")}${previewFormat}${randParam}`,
	);
}

function formatInputName(index) {
	return `${INPUT_PREFIX}${String(index).padStart(2, "0")}`;
}

function getInputIndex(name) {
	const text = String(name || "");
	if (!text.startsWith(INPUT_PREFIX)) {
		return Number.MAX_SAFE_INTEGER;
	}
	return (
		Number.parseInt(text.slice(INPUT_PREFIX.length), 10) ||
		Number.MAX_SAFE_INTEGER
	);
}

function getInputs(node) {
	return Array.isArray(node?.inputs)
		? [...node.inputs]
				.filter((input) => String(input?.name || "").startsWith(INPUT_PREFIX))
				.sort((a, b) => getInputIndex(a?.name) - getInputIndex(b?.name))
		: [];
}

function getLinkedOutputInfo(input) {
	const linkId = input?.link;
	if (!linkId || !app.graph?.links) {
		return null;
	}
	const link = app.graph.links[linkId];
	const sourceNode =
		link?.origin_id != null ? app.graph.getNodeById?.(link.origin_id) : null;
	const sourceSlot = sourceNode?.outputs?.[link.origin_slot];
	if (!sourceSlot) {
		return null;
	}
	return {
		type: sourceSlot.type || "*",
		label: sourceSlot.label || sourceSlot.name || sourceSlot.type || "*",
	};
}

function setDirty(node) {
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function measureHeight(node) {
	const container = node?.__gjjAnyPreviewContainer;
	if (!container) {
		return MIN_NODE_HEIGHT;
	}
	const contentHeight = Math.ceil(
		container.scrollHeight || container.offsetHeight || MIN_NODE_HEIGHT,
	);
	return Math.max(MIN_NODE_HEIGHT, contentHeight + 12);
}

function refreshLayout(node) {
	const width = Math.max(MIN_WIDTH, Number(node.size?.[0] || MIN_WIDTH));
	const height = Math.max(
		MIN_NODE_HEIGHT,
		Number(node.size?.[1] || MIN_NODE_HEIGHT),
	);
	if ((node.size?.[0] || 0) !== width || (node.size?.[1] || 0) !== height) {
		node.setSize?.([width, height]);
	}
	setDirty(node);
}

function estimateImagePreviewHeight(node) {
	const images = Array.isArray(node?.__gjjAnyPreviewImages)
		? node.__gjjAnyPreviewImages
		: [];
	const count = Math.max(1, images.length || 1);

	const nodeWidth = Math.max(MIN_WIDTH, Number(node?.size?.[0] || MIN_WIDTH));
	// 减去 padding 和 border
	const contentWidth = Math.max(220, nodeWidth - 36);

	if (count === 1) {
		// 单图模式：根据宽度动态计算高度，保持图片比例
		// 使用默认宽高比 4:3
		const aspectRatio = 4 / 3;
		const imageHeight = contentWidth / aspectRatio;
		return Math.max(MIN_PREVIEW_HEIGHT, imageHeight + 18);
	}

	// 多图模式：动态计算列数
	const minCardWidth = 140;
	const gap = 8;
	const columns = Math.min(
		count,
		Math.max(1, Math.floor((contentWidth + gap) / (minCardWidth + gap))),
	);

	const rows = Math.max(1, Math.ceil(count / columns));

	// 正方形卡片，高度等于宽度
	const actualCardWidth = (contentWidth - (columns - 1) * gap) / columns;
	const cardHeight = actualCardWidth; // 正方形，高度=宽度

	// 计算总高度：行数 * 卡片高度 + 间距
	const totalGap = (rows - 1) * gap;
	return Math.max(
		MIN_PREVIEW_HEIGHT,
		rows * cardHeight + totalGap + 18,
	);
}

function getWidgetHeight(node, widget) {
	if (String(node?.__gjjAnyPreviewKind || "") === "image") {
		return estimateImagePreviewHeight(node);
	}
	const nodeHeight = Math.max(
		MIN_NODE_HEIGHT,
		Number(node?.size?.[1] || MIN_NODE_HEIGHT),
	);
	const topOffset = Math.max(
		0,
		Number(widget?.y || 0),
		Number(widget?.last_y || 0),
	);
	const availableHeight = nodeHeight - topOffset - NODE_BOTTOM_PADDING;
	return Math.max(MIN_PREVIEW_HEIGHT, availableHeight);
}

function updateLayout(node) {
	if (!node) {
		return;
	}

	const kind = String(node.__gjjAnyPreviewKind || "");

	// 根据内容类型计算所需高度
	let height;
	if (kind === "image") {
		// 图片预览：根据宽度动态计算高度，不设下限（允许高度减少）
		const estimated = estimateImagePreviewHeight(node);
		height = Math.max(MIN_NODE_HEIGHT, estimated + 36);
	} else {
		// 非图片预览：测量内容高度
		height = measureHeight(node);
	}

	// 关键修复：强制更新节点大小，即使高度减少
	const currentHeight = Number(node.size?.[1] || MIN_NODE_HEIGHT);
	if (height !== currentHeight) {
		node.setSize?.([node.size?.[0], height]);

		// 同步更新 DOM 容器高度
		const container = node.__gjjAnyPreviewContainer;
		const previewWrap = node.__gjjAnyPreviewWrap;
		if (container && previewWrap) {
			const widget = node.__gjjAnyPreviewWidget;
			const topOffset = Math.max(
				0,
				Number(widget?.y || 0),
				Number(widget?.last_y || 0),
			);
			const availableHeight = height - topOffset - NODE_BOTTOM_PADDING;
			container.style.height = `${Math.max(MIN_PREVIEW_HEIGHT, availableHeight)}px`;
			previewWrap.style.height = `${Math.max(MIN_PREVIEW_HEIGHT, availableHeight)}px`;
		}

		setDirty(node);
	}
}

function scheduleLayout(node) {
	if (!node || node.__gjjAnyPreviewLayoutQueued) {
		return;
	}
	node.__gjjAnyPreviewLayoutQueued = true;
	requestAnimationFrame(() => {
		node.__gjjAnyPreviewLayoutQueued = false;
		updateLayout(node);
	});
}

function ensureOutput(node) {
	if (!Array.isArray(node.outputs) || node.outputs.length === 0) {
		node.addOutput?.("预览结果", "*");
	}
}

function addDynamicInput(node, type = "*") {
	const nextIndex = getInputs(node).length + 1;
	node.addInput(formatInputName(nextIndex), ANY_INPUT_TYPE);
}

function ensureTrailingEmptyInput(node) {
	const inputs = getInputs(node);
	if (inputs.length === 0) {
		addDynamicInput(node);
		return;
	}
	const lastInput = inputs[inputs.length - 1];
	if (lastInput?.link) {
		addDynamicInput(node, lastInput.type || "*");
	}
}

function removeUnusedInputsFromEnd(node, minInputs = MIN_VISIBLE_INPUTS) {
	const inputs = getInputs(node);
	for (let index = inputs.length - 1; index >= minInputs; index -= 1) {
		const input = inputs[index];
		if (input?.link) {
			break;
		}
		const slotIndex = node.inputs.indexOf(input);
		if (slotIndex >= 0) {
			node.removeInput(slotIndex);
		}
	}
}

function renameInputsSequentially(node) {
	getInputs(node).forEach((input, index) => {
		input.name = formatInputName(index + 1);
		input.label = `${INPUT_DISPLAY_PREFIX}${index + 1}`;
		input.localized_name = input.label;
		input.tooltip = INPUT_TOOLTIP;
	});
}

function resolveOutputMode(node) {
	const infos = getInputs(node)
		.filter((input) => input?.link)
		.map((input) => getLinkedOutputInfo(input))
		.filter(Boolean);

	if (!infos.length) {
		const kind = String(node?.__gjjAnyPreviewKind || "").trim();
		if (kind === "image") {
			return {
				type: "IMAGE",
				name: "图片输出",
				tooltip: "合并后的图片批次输出。",
			};
		}
		if (kind === "text") {
			return {
				type: "STRING",
				name: "文本输出",
				tooltip: "合并后的文本输出。",
			};
		}
		return { type: "*", name: "预览结果", tooltip: "合并后的任意对象输出。" };
	}

	const types = [...new Set(infos.map((info) => String(info.type || "*")))];
	if (types.length === 1) {
		const type = types[0];
		if (type === "IMAGE") {
			return {
				type: "IMAGE",
				name: "图片输出",
				tooltip: "合并后的图片批次输出。",
			};
		}
		if (type === "STRING") {
			return {
				type: "STRING",
				name: "文本输出",
				tooltip: "合并后的文本输出。",
			};
		}
		return { type, name: "对象输出", tooltip: "合并后的对象输出。" };
	}

	return {
		type: "*",
		name: "预览结果",
		tooltip: "混合类型输入会输出合并后的任意对象。",
	};
}

function escapeHtml(text) {
	return String(text || "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function escapeAttribute(text) {
	return escapeHtml(text).replaceAll("`", "&#96;");
}

function renderInlineMarkdown(text) {
	let output = escapeHtml(text);
	// 原有规则
	output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
	output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	output = output.replace(/__([^_]+)__/g, "<strong>$1</strong>");
	output = output.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
	output = output.replace(/(^|[^_])_([^_]+)_(?!_)/g, "$1<em>$2</em>");
	// 新增规则
	output = output.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt, src) => {
		const safeSrc = escapeAttribute(src);
		return `<img src="${safeSrc}" alt="${escapeAttribute(alt)}">`;
	});
	output = output.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
		const safeHref = escapeAttribute(href);
		return `<a href="${safeHref}" target="_blank" rel="noreferrer">${label}</a>`;
	});
	output = output.replace(/~~([^~]+)~~/g, "<del>$1</del>");
	output = output.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<]+)/g, (_match, prefix, url) => {
		const href = url.startsWith("www.") ? `https://${url}` : url;
		return `${prefix}<a href="${escapeAttribute(href)}" target="_blank" rel="noreferrer">${url}</a>`;
	});
	return output;
}

function renderMarkdown(text) {
	const source = String(text || "")
		.replace(/\r\n/g, "\n")
		.trim();
	if (!source) {
		return `<p class="gjj-text-input-empty">${EMPTY_PREVIEW}</p>`;
	}

	const lines = source.split("\n");
	const parts = [];
	const paragraph = [];
	const list = { ordered: false, items: [] };

	const flushParagraph = () => {
		if (!paragraph.length) {
			return;
		}
		parts.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
		paragraph.length = 0;
	};

	const flushList = () => {
		if (!list.items.length) {
			return;
		}
		const tag = list.ordered ? "ol" : "ul";
		parts.push(`<${tag}>${list.items.join("")}</${tag}>`);
		list.items.length = 0;
		list.ordered = false;
	};

	for (const line of lines) {
		const trimmed = line.trim();

		// 处理空行 - 刷新所有缓冲区
		if (!trimmed) {
			flushParagraph();
			flushList();
			continue;
		}

		// 处理标题
		const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
		if (headingMatch) {
			flushParagraph();
			flushList();
			const level = headingMatch[1].length;
			parts.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
			continue;
		}

		// 处理分隔线
		if (/^[-*_]{3,}$/.test(trimmed)) {
			flushParagraph();
			flushList();
			parts.push("<hr>");
			continue;
		}

		// 处理引用块
		const quoteMatch = trimmed.match(/^>\s?(.+)$/);
		if (quoteMatch) {
			flushParagraph();
			flushList();
			parts.push(`<blockquote>${renderInlineMarkdown(quoteMatch[1])}</blockquote>`);
			continue;
		}

		// 处理无序列表
		const unorderedMatch = trimmed.match(/^[-*+]\s+(.+)$/);
		// 处理有序列表
		const orderedMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);

		if (unorderedMatch || orderedMatch) {
			flushParagraph();
			const ordered = Boolean(orderedMatch);
			if (list.items.length && list.ordered !== ordered) {
				flushList();
			}
			list.ordered = ordered;
			list.items.push(`<li>${renderInlineMarkdown((orderedMatch || unorderedMatch)[1])}</li>`);
			continue;
		}

		// 普通段落内容
		paragraph.push(line);
	}

	// 刷新所有缓冲区
	flushParagraph();
	flushList();

	return parts.join("");
}

function clampTextPreviewLines(body) {
	for (const element of body.querySelectorAll(
		"p, li, h1, h2, h3, h4, h5, h6",
	)) {
		element.title = element.textContent || "";
		element.style.maxWidth = "100%";
		element.style.display = "block";
	}
	for (const element of body.querySelectorAll("ul, ol")) {
		element.style.maxWidth = "100%";
		element.style.overflow = "hidden";
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
}

function hideLegacyPreviewWidgets(node) {
	(node.widgets || []).forEach((widget) => {
		if (widget === node.__gjjAnyPreviewWidget) {
			return;
		}
		const name = String(widget?.name || "");
		const label = String(widget?.label || "");
		if (
			name === PREVIEW_WIDGET_NAME ||
			name.includes("preview") ||
			label.includes("预览") ||
			label.includes("Preview")
		) {
			hideWidget(widget);
		}
	});
}

function applyPreviewContent(node) {
	const container = node.__gjjAnyPreviewContainer;
	const body = node.__gjjAnyPreviewBody;
	const grid = node.__gjjAnyPreviewGrid;
	const empty = node.__gjjAnyPreviewEmpty;
	const previewWrap = node.__gjjAnyPreviewWrap;
	const editor = node.__gjjAnyPreviewEditor;
	if (!container || !body || !grid || !empty) {
		return;
	}

	const kind = String(node.__gjjAnyPreviewKind || "").trim();
	const text = String(node.__gjjAnyPreviewText || "").trim() || EMPTY_PREVIEW;
	const images = Array.isArray(node.__gjjAnyPreviewImages)
		? node.__gjjAnyPreviewImages
		: [];
	const audio = Array.isArray(node.__gjjAnyPreviewAudio)
		? node.__gjjAnyPreviewAudio
		: [];
	const video = Array.isArray(node.__gjjAnyPreviewVideo)
		? node.__gjjAnyPreviewVideo
		: [];
	const showImage = kind === "image" && images.length > 0;
	const showAudio = kind === "audio" && audio.length > 0;
	const showVideo = kind === "video" && video.length > 0;
	const hasText = Boolean(String(node.__gjjAnyPreviewText || "").trim());
	const isTextOnly = !showImage && !showAudio && !showVideo && hasText;
	const mode = isTextOnly ? getMode(node) : MODE_PREVIEW;

	const availableHeight = getWidgetHeight(node, node.__gjjAnyPreviewWidget);

	const isMediaPreview = showImage || showAudio || showVideo;

	grid.style.display = isMediaPreview ? (showImage ? "grid" : "flex") : "none";

	if (showImage) {
		body.style.display = "none";
		if (editor) editor.style.display = "none";
	} else if ((showAudio || showVideo) && hasText) {
		body.style.display = mode === MODE_PREVIEW ? "block" : "none";
		if (editor) editor.style.display = mode === MODE_EDIT ? "block" : "none";
	} else if (!isMediaPreview && hasText) {
		body.style.display = mode === MODE_PREVIEW ? "block" : "none";
		if (editor) editor.style.display = mode === MODE_EDIT ? "block" : "none";
	} else {
		body.style.display = "none";
		if (editor) editor.style.display = "none";
	}

	empty.style.display = (!isMediaPreview && !hasText) ? "flex" : "none";

	container.style.height = "auto";
	container.style.minHeight = `${MIN_PREVIEW_HEIGHT}px`;

	if (previewWrap) {
		previewWrap.style.overflow = showImage ? "auto" : "visible";
		previewWrap.style.height = showImage ? `${availableHeight}px` : "auto";
		previewWrap.style.minHeight = showImage ? `${availableHeight}px` : "96px";
	}

	if (showImage) {
		const isSingleImage = images.length === 1;

		// 单图和多图使用不同的样式
		grid.style.gridTemplateColumns = isSingleImage
			? "repeat(1, minmax(0, 1fr))"
			: "repeat(auto-fill, minmax(140px, 1fr))";
		grid.style.gap = "8px";
		grid.style.height = "auto";
		grid.style.alignItems = "start";
		grid.replaceChildren();

		for (const [index, item] of images.entries()) {
			const card = document.createElement("div");
			card.style.cssText = [
				"position:relative",
				"width:100%",
				"aspect-ratio:1/1",
				"overflow:hidden",
				"border-radius:6px",
				"cursor:pointer",
				"transition:transform 0.2s ease",
				"background:#12191d",
			].join(";");

			// 鼠标悬停效果
			card.addEventListener("mouseenter", () => {
				card.style.transform = "scale(1.05)";
			});
			card.addEventListener("mouseleave", () => {
				card.style.transform = "scale(1)";
			});

			// 图片元素 - 使用object-fit:cover撑满画布
			const image = document.createElement("img");
			image.src = imageDataToUrl(item);
			image.draggable = false;
			image.style.cssText = [
				"width:100%",
				"height:100%",
				"object-fit:cover",
				"display:block",
			].join(";");

			// 图片加载完成后更新尺寸
			image.onload = () => {
				if (sizeBadge) {
					sizeBadge.textContent = `${image.naturalWidth}×${image.naturalHeight}`;
				}
				scheduleLayout(node);
			};
			image.onerror = () => {
				if (sizeBadge) {
					sizeBadge.textContent = "加载失败";
				}
				scheduleLayout(node);
			};

			// 左上角：图片序号
			const indexBadge = document.createElement("div");
			indexBadge.textContent = `${index + 1}`;
			indexBadge.style.cssText = [
				"position:absolute",
				"top:6px",
				"left:6px",
				"min-width:24px",
				"height:24px",
				"padding:0 6px",
				"border-radius:12px",
				"background:rgba(0, 0, 0, 0.5)",
				"backdrop-filter:blur(4px)",
				"color:#fff",
				"font-size:11px",
				"font-weight:bold",
				"display:flex",
				"align-items:center",
				"justify-content:center",
				"pointer-events:none",
				"z-index:2",
			].join(";");

			// 右上角：图片尺寸
			const sizeBadge = document.createElement("div");
			sizeBadge.style.cssText = [
				"position:absolute",
				"top:6px",
				"right:6px",
				"padding:2px 8px",
				"border-radius:4px",
				"background:rgba(0, 0, 0, 0.5)",
				"backdrop-filter:blur(4px)",
				"color:#fff",
				"font-size:10px",
				"pointer-events:none",
				"z-index:2",
				"white-space:nowrap",
			].join(";");

			// 初始显示加载中
			sizeBadge.textContent = "加载中...";

			// 点击图片放大查看（带滚轮缩放）
			card.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();

				// 创建全屏预览
				const overlay = document.createElement("div");
				overlay.style.cssText = [
					"position:fixed",
					"inset:0",
					"background:rgba(0, 0, 0, 0.9)",
					"backdrop-filter:blur(10px)",
					"z-index:10000",
					"display:flex",
					"align-items:center",
					"justify-content:center",
					"cursor:zoom-out",
				].join(";");

				const previewImg = document.createElement("img");
				previewImg.src = imageDataToUrl(item);
				previewImg.style.cssText = [
					"max-width:90%",
					"max-height:90%",
					"object-fit:contain",
					"border-radius:8px",
					"box-shadow:0 0 40px rgba(0, 0, 0, 0.5)",
					"transition:transform 0.1s ease",
					"cursor:grab",
				].join(";");

				// 滚轮缩放功能
				let currentScale = 1;
				const minScale = 0.1;
				const maxScale = 10;

				overlay.addEventListener("wheel", (e) => {
					e.preventDefault();
					e.stopPropagation();

					const delta = e.deltaY > 0 ? -0.1 : 0.1;
					currentScale = Math.max(minScale, Math.min(maxScale, currentScale + delta));
					previewImg.style.transform = `scale(${currentScale})`;
				});

				// 双击重置缩放
				previewImg.addEventListener("dblclick", (e) => {
					e.stopPropagation();
					currentScale = 1;
					previewImg.style.transform = `scale(${currentScale})`;
				});

				// 提示文字
				const hint = document.createElement("div");
				hint.style.cssText = [
					"position:absolute",
					"bottom:20px",
					"left:50%",
					"transform:translateX(-50%)",
					"color:#fff",
					"font-size:13px",
					"opacity:0.6",
					"pointer-events:none",
					"white-space:nowrap",
				].join(";");
				hint.textContent = "滚轮缩放 · 双击重置 · 点击关闭";

				overlay.appendChild(previewImg);
				overlay.appendChild(hint);
				document.body.appendChild(overlay);

				// 点击关闭
				overlay.addEventListener("click", () => {
					overlay.remove();
				});
			});

			// 组装卡片
			card.appendChild(image);
			card.appendChild(indexBadge);
			card.appendChild(sizeBadge);
			grid.appendChild(card);
		}
		// 图片预览分支结束，body 已在前置逻辑中隐藏
	} else if (showAudio) {
		// 新增：音频预览 - 同时显示播放器和简介文本
		console.log("[GJJ AnyPreview] === 音频预览开始 ===");
		console.log("[GJJ AnyPreview] kind:", kind);
		console.log("[GJJ AnyPreview] showAudio:", showAudio);
		console.log("[GJJ AnyPreview] hasText:", hasText);
		console.log("[GJJ AnyPreview] audio数组:", audio);
		console.log("[GJJ AnyPreview] audio数组长度:", audio.length);
		console.log("[GJJ AnyPreview] node.__gjjAnyPreviewAudio:", node.__gjjAnyPreviewAudio);

		if (audio.length === 0) {
			console.error("[GJJ AnyPreview] 错误：audio数组为空！");
		}

		grid.style.gridTemplateColumns = "1fr";
		grid.style.height = "auto";
		grid.style.alignItems = "center";
		grid.replaceChildren();

		const audioItem = audio[0];
		console.log("[GJJ AnyPreview] audioItem:", audioItem);
		console.log("[GJJ AnyPreview] audioItem.filename:", audioItem?.filename);
		console.log("[GJJ AnyPreview] audioItem.type:", audioItem?.type);

		const audioUrl = imageDataToUrl(audioItem);
		console.log("[GJJ AnyPreview] 生成的audioUrl:", audioUrl);

		const audioCard = document.createElement("div");
		audioCard.style.cssText = [
			"display:flex",
			"flex-direction:column",
			"gap:10px",
			"padding:12px",
			"border:1px solid #33434a",
			"border-radius:8px",
			"background:#12191d",
			"width:100%",
			"box-sizing:border-box",
		].join(";");

		const audioPlayer = document.createElement("audio");
		audioPlayer.controls = true;
		audioPlayer.src = audioUrl;
		audioPlayer.preload = "metadata";
		audioPlayer.style.cssText = [
			"width:100%",
			"height:40px",
		].join(";");

		const audioLabel = document.createElement("div");
		audioLabel.textContent = audioItem.filename || "音频";
		audioLabel.style.cssText = [
			"font-size:12px",
			"color:#dce7e2",
			"text-align:center",
			"overflow:hidden",
			"text-overflow:ellipsis",
			"white-space:nowrap",
		].join(";");

		audioCard.appendChild(audioPlayer);
		audioCard.appendChild(audioLabel);
		grid.appendChild(audioCard);

		// 显示音频简介文本
		if (hasText) {
			body.innerHTML = renderMarkdown(text);
			body.style.display = "block";
		}
	} else if (showVideo) {
		// 视频预览：显示播放器。简介文本由 body 负责显示（如果存在）
		grid.style.gridTemplateColumns = "1fr";
		grid.style.height = "auto";
		grid.style.alignItems = "center";
		grid.replaceChildren();

		const videoItem = video[0];
		const videoUrl = imageDataToUrl(videoItem);

		const videoCard = document.createElement("div");
		videoCard.style.cssText = [
			"display:flex",
			"flex-direction:column",
			"gap:10px",
			"padding:12px",
			"border:1px solid #33434a",
			"border-radius:8px",
			"background:#12191d",
			"width:100%",
			"box-sizing:border-box",
		].join(";");

		const videoPlayer = document.createElement("video");
		videoPlayer.controls = true;
		videoPlayer.src = videoUrl;
		videoPlayer.preload = "metadata";
		videoPlayer.style.cssText = [
			"width:100%",
			"max-height:320px",
			"object-fit:contain",
			"background:#0c1114",
			"border-radius:6px",
		].join(";");

		const videoLabel = document.createElement("div");
		videoLabel.textContent = videoItem.filename || "视频";
		videoLabel.style.cssText = [
			"font-size:12px",
			"color:#dce7e2",
			"text-align:center",
			"overflow:hidden",
			"text-overflow:ellipsis",
			"white-space:nowrap",
		].join(";");

		videoCard.appendChild(videoPlayer);
		videoCard.appendChild(videoLabel);
		grid.appendChild(videoCard);

		// 显示视频简介文本
		if (hasText) {
			body.innerHTML = renderMarkdown(text);
			body.style.display = "block";
		}
	} else {
		grid.style.gridTemplateColumns = "repeat(auto-fit, minmax(140px, 1fr))";
		grid.style.height = "";
		grid.style.alignItems = "";

		if (!showImage && !showAudio && !showVideo && hasText) {
			body.innerHTML = renderMarkdown(text);
			clampTextPreviewLines(body);
			body.title = "双击编辑";

			const handleDblClick = (e) => {
				if (e.target.closest("a, img, pre, code")) {
					return;
				}
				enterEditMode(node);
			};

			if (body.__gjjDblClickHandler) {
				body.removeEventListener("dblclick", body.__gjjDblClickHandler);
				body.removeEventListener("pointerdown", body.__gjjPointerHandler);
				body.removeEventListener("mousedown", body.__gjjPointerHandler);
			}
			body.__gjjDblClickHandler = handleDblClick;
			const pointerHandler = (e) => handlePreviewPointer(node, e);
			body.__gjjPointerHandler = pointerHandler;
			body.addEventListener("dblclick", handleDblClick);
			body.addEventListener("pointerdown", pointerHandler);
			body.addEventListener("mousedown", pointerHandler);
			body.style.cursor = "pointer";
		} else {
			body.innerHTML = renderMarkdown(text);
			clampTextPreviewLines(body);
		}
	}

	if (editor && mode === MODE_EDIT) {
		editor.value = String(node.__gjjAnyPreviewText || "");
		editor.style.height = "auto";
		editor.style.height = `${Math.max(120, editor.scrollHeight || 120)}px`;
	}

	requestAnimationFrame(() => {
		const height = showImage
			? availableHeight
			: Math.max(
					MIN_PREVIEW_HEIGHT,
					Math.ceil(
						container.scrollHeight ||
							container.offsetHeight ||
							MIN_PREVIEW_HEIGHT,
					),
				);
		if (node.__gjjAnyPreviewHeight !== height) {
			node.__gjjAnyPreviewHeight = height;
		}
		scheduleLayout(node);
	});
}

function getLoraEffectLiveText(node) {
	if (!node) {
		return null;
	}
	const sourceId = node.__gjjLoraEffectLiveSourceId;
	const outputIndex = Number(node.__gjjLoraEffectLiveOutputIndex ?? 2);
	const sourceNode =
		sourceId != null ? app.graph?.getNodeById?.(sourceId) : null;
	const liveTextByNodeId = globalThis[LORA_EFFECT_LIVE_TEXT_MAP_KEY] || {};
	if (sourceNode) {
		const links = Array.isArray(sourceNode?.outputs?.[outputIndex]?.links)
			? sourceNode.outputs[outputIndex].links
			: [];
		const stillLinked = links.some(
			(linkId) => app.graph?.links?.[linkId]?.target_id === node.id,
		);
		if (stillLinked) {
			const sourceTexts =
				sourceNode.__gjjLoraEffectLiveTexts ||
				liveTextByNodeId[String(sourceNode.id)] ||
				{};
			const text =
				sourceTexts[String(outputIndex)] ?? node.__gjjLoraEffectLiveText;
			if (text !== undefined) {
				node.__gjjLoraEffectLiveText = String(text || "");
				return String(text || "");
			}
		}
		delete node.__gjjLoraEffectLiveText;
		delete node.__gjjLoraEffectLiveSourceId;
		delete node.__gjjLoraEffectLiveOutputIndex;
	}
	for (const input of getInputs(node)) {
		const link = input?.link ? app.graph?.links?.[input.link] : null;
		const origin =
			link?.origin_id != null ? app.graph?.getNodeById?.(link.origin_id) : null;
		if (origin?.comfyClass !== "GJJ_LoraEffectTester") {
			continue;
		}
		const originSlot = Number(link?.origin_slot ?? 2);
		const originTexts =
			origin.__gjjLoraEffectLiveTexts ||
			liveTextByNodeId[String(origin.id)] ||
			{};
		const text = originTexts[String(originSlot)];
		if (text !== undefined) {
			node.__gjjLoraEffectLiveText = String(text || "");
			node.__gjjLoraEffectLiveSourceId = origin.id;
			node.__gjjLoraEffectLiveOutputIndex = originSlot;
			return String(text || "");
		}
	}
	return null;
}

function ensurePreviewWidget(node) {
	hideLegacyPreviewWidgets(node);
	if (node.__gjjAnyPreviewContainer) {
		applyPreviewContent(node);
		scheduleLayout(node);
		return;
	}

	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
		"margin-top:4px",
		"user-select:text",
		"-webkit-user-select:text",
		"pointer-events:auto",
		"cursor:text",
	].join(";");

	const body = document.createElement("div");
	body.className = "gjj-text-input-markdown-body";
	body.style.cssText = [
		"background:transparent",
		"color:#d9e4df",
		"font-size:12px",
		"line-height:1.45",
		"white-space:normal",
		"overflow:visible",
		"user-select:text",
		"-webkit-user-select:text",
		"pointer-events:auto",
		"cursor:text",
	].join(";");

	const editor = document.createElement("textarea");
	editor.className = "gjj-any-preview-editor";
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

	const previewWrap = document.createElement("div");
	previewWrap.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"position:relative",
		"border:1px solid #33434a",
		"border-radius:10px",
		"background:#0f1418",
		"padding:8px",
		"box-sizing:border-box",
		"overflow:visible",
		"min-height:96px",
		"user-select:text",
		"-webkit-user-select:text",
		"pointer-events:auto",
		"cursor:text",
	].join("");

	// 添加Markdown预览的CSS样式
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
		.gjj-text-input-markdown-body a { color: #7dd3fc; text-decoration: none; }
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
	previewWrap.appendChild(style);

	previewWrap.appendChild(body);
	previewWrap.appendChild(editor);

	const grid = document.createElement("div");
	grid.style.cssText = [
		"display:none",
		"grid-template-columns:repeat(auto-fit, minmax(140px, 1fr))",
		"gap:1px",
		"width:100%",
		"order:1", // 播放器显示在前面
	].join(";");
	previewWrap.appendChild(grid);

	const empty = document.createElement("div");
	empty.textContent = EMPTY_PREVIEW;
	empty.style.cssText = [
		"display:flex",
		"align-items:center",
		"justify-content:flex-start",
		"min-height:56px",
		"color:#8ea0a8",
		"font-size:12px",
	].join(";");
	previewWrap.appendChild(empty);

	body.style.order = "2";
	editor.style.order = "3";
	container.appendChild(previewWrap);

	editor.addEventListener("input", () => {
		node.__gjjAnyPreviewText = editor.value;
		editor.style.height = "auto";
		editor.style.height = `${Math.max(120, editor.scrollHeight || 120)}px`;
		scheduleLayout(node);
	});

	editor.addEventListener("keydown", (event) => {
		if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key === "Enter")) {
			event.preventDefault();
			editor.blur();
		}
	});

	editor.addEventListener("blur", () => {
		node.__gjjAnyPreviewText = editor.value;
		enterPreviewMode(node);
	});

	editor.addEventListener("pointerdown", (event) => event.stopPropagation());
	editor.addEventListener("mousedown", (event) => event.stopPropagation());
	editor.addEventListener("dblclick", (event) => event.stopPropagation());

	const widget = node.addDOMWidget?.(
		PREVIEW_WIDGET_NAME,
		PREVIEW_WIDGET_NAME,
		container,
		{
			serialize: false,
			hideOnZoom: false,
			getHeight: () =>
				String(node.__gjjAnyPreviewKind || "") === "image"
					? getWidgetHeight(node, node.__gjjAnyPreviewWidget || widget)
					: Math.max(
							MIN_PREVIEW_HEIGHT,
							node.__gjjAnyPreviewHeight || MIN_PREVIEW_HEIGHT,
						),
		},
	);
	if (widget) {
		widget.computeSize = (width) => [
			Math.max(MIN_WIDTH, Number(width || MIN_WIDTH)),
			String(node.__gjjAnyPreviewKind || "") === "image"
				? estimateImagePreviewHeight(node)
				: Math.max(MIN_NODE_HEIGHT, measureHeight(node)),
		];
		widget.draw = () => {};
		node.__gjjAnyPreviewWidget = widget;
		if (Array.isArray(node.widgets)) {
			const idx = node.widgets.indexOf(widget);
			if (idx > 0) {
				node.widgets.splice(idx, 1);
				node.widgets.unshift(widget);
			}
		}
	}

	node.__gjjAnyPreviewContainer = container;
	node.__gjjAnyPreviewWrap = previewWrap;
	node.__gjjAnyPreviewBody = body;
	node.__gjjAnyPreviewEditor = editor;
	node.__gjjAnyPreviewGrid = grid;
	node.__gjjAnyPreviewEmpty = empty;
	applyPreviewContent(node);
	scheduleLayout(node);
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}

	ensureOutput(node);
	removeUnusedInputsFromEnd(node, MIN_VISIBLE_INPUTS);
	ensureTrailingEmptyInput(node);
	renameInputsSequentially(node);

	const resolved = resolveOutputMode(node);
	for (const input of getInputs(node)) {
		input.type = ANY_INPUT_TYPE;
	}
	for (const output of node.outputs || []) {
		output.type = resolved.type || "*";
		output.name = resolved.name;
		output.label = resolved.name;
		output.localized_name = resolved.name;
		output.tooltip = resolved.tooltip;
	}

	ensurePreviewWidget(node);
	scheduleLayout(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjAnyPreviewTimer);
	node.__gjjAnyPreviewTimer = setTimeout(() => stabilizeNode(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.AnyPreview",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleStabilize(this);
			return result;
		};

		const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			if (String(this.__gjjAnyPreviewKind || "") === "image") {
				this.imgs = [];
				this.images = [];
				this.preview = null;
				const sizeSignature = `${Math.round(this.size?.[0] || 0)}x${Math.round(this.size?.[1] || 0)}`;
				if (this.__gjjAnyPreviewSizeSignature !== sizeSignature) {
					this.__gjjAnyPreviewSizeSignature = sizeSignature;
					// 只更新高度，不重新渲染内容，避免无限循环
					updateLayout(this);
				}
			}
			return typeof originalOnDrawBackground === "function"
				? originalOnDrawBackground.apply(this, args)
				: undefined;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = typeof originalOnResize === "function"
				? originalOnResize.apply(this, args)
				: undefined;
			// 用户手动调整宽度后，立即重新计算高度
			scheduleLayout(this);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			// 调试：打印onExecuted收到的完整message
			console.log("========== [GJJ onExecuted] 收到的message ==========");
			console.log("[GJJ onExecuted] message:", message);
			console.log("[GJJ onExecuted] message.preview_kind:", message?.preview_kind);
			console.log("[GJJ onExecuted] message.preview_audio:", message?.preview_audio);
			console.log("[GJJ onExecuted] message.preview_video:", message?.preview_video);
			console.log("[GJJ onExecuted] message.preview_images:", message?.preview_images);
			console.log("[GJJ onExecuted] message.preview_text:", message?.preview_text);
			console.log("======================================================");

			const result =
				typeof originalOnExecuted === "function"
					? originalOnExecuted.call(this, message)
					: undefined;
			const liveText = getLoraEffectLiveText(this);
			this.__gjjAnyPreviewKind =
				liveText !== null ? "text" : message?.preview_kind?.[0] || "";
			this.__gjjAnyPreviewText =
				liveText !== null ? liveText : message?.preview_text?.[0] || "";
			this.__gjjAnyPreviewImages =
				liveText !== null
					? []
					: Array.isArray(message?.preview_images)
						? message.preview_images
						: [];
			// 修复：音频数据是元组，需要取第一个元素
			this.__gjjAnyPreviewAudio =
				liveText !== null
					? []
					: Array.isArray(message?.preview_audio?.[0])
						? message.preview_audio[0]
						: [];
			// 修复：视频数据是元组，需要取第一个元素
			this.__gjjAnyPreviewVideo =
				liveText !== null
					? []
					: Array.isArray(message?.preview_video?.[0])
						? message.preview_video[0]
						: [];
			this.imgs = [];
			this.images = [];
			this.preview = null;
			this.__gjjAnyPreviewHeight = Math.min(
				280,
				Math.max(
					MIN_PREVIEW_HEIGHT,
					String(this.__gjjAnyPreviewText || "").split("\n").length * 20,
				),
			);
			requestAnimationFrame(() => {
				applyPreviewContent(this);
				updateLayout(this);
				scheduleStabilize(this, 0);
			});
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				stabilizeNode(node);
			}
		}
	},
});
