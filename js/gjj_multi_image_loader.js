import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_MultiImageLoader"]);
const DATA_WIDGET_NAME = "selected_images";
const GJJ_HELP_WIDGET_NAME = "gjj_help_button";
const SEQUENCE_RANGE_WIDGET_NAME = "sequence_range";
const MAX_OUTPUT_IMAGES = 20;
const MIN_WIDTH = 420;
const MIN_HEIGHT = 220;
const DOM_WIDGET_NAME = "gjj_multi_image_loader_dom";
const IMAGE_API_PATH = "/gjj/input_images";
const UPLOAD_SUBFOLDER = "gjj_multi_image_loader";
const BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE";
const FILE_NAME_COLLATOR = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });

function getDataWidget(node) {
	return node.widgets?.find((widget) => widget?.name === DATA_WIDGET_NAME);
}

function getWidget(node, name) {
	return node.widgets?.find((widget) => widget?.name === name);
}

function hideDataWidget(widget) {
	if (!widget) {
		return;
	}
	widget.serialize = false;
	if (widget.__gjjHidden) {
		widget.computeSize = () => [0, -4];
		widget.draw = () => {};
		if (widget.inputEl) {
			widget.inputEl.style.display = "none";
		}
		if (widget.element) {
			widget.element.style.display = "none";
		}
		if (widget.widget) {
			widget.widget.style.display = "none";
		}
		return;
	}
	widget.__gjjHidden = true;
	widget.__gjjOriginalType = widget.type;
	widget.__gjjOriginalComputeSize = widget.computeSize;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.hidden = true;
	widget.computeSize = () => [0, -4];
	widget.draw = () => {};
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

function removeInternalDataWidget(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	const widget = getDataWidget(node);
	if (!widget) {
		return;
	}
	hideDataWidget(widget);
}

function removeInternalDataInputs(node) {
	if (!Array.isArray(node?.inputs)) {
		return;
	}
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		const label = String(input?.label || input?.localized_name || "");
		if (name !== DATA_WIDGET_NAME && label !== "已选图片") {
			continue;
		}
		if (input?.link != null) {
			node.disconnectInput?.(index);
		}
		node.removeInput?.(index);
	}
}

function normalizeSequenceRangeWidget(node) {
	const widget = getWidget(node, SEQUENCE_RANGE_WIDGET_NAME);
	if (!widget) {
		return null;
	}
	widget.label = "序列范围";
	widget.localized_name = "序列范围";
	widget.tooltip = "可接入 GJJ · 递增数值 的“序列范围”。支持 [1,2] 和闭区间 [1:2]，编号与预览里的图片 1、图片 2 对齐。";
	if (widget.options) {
		widget.options.display_name = "序列范围";
		widget.options.tooltip = widget.tooltip;
	}
	return widget;
}

function reorderWidgets(node) {
	if (!Array.isArray(node?.widgets)) {
		return;
	}
	const ordered = [];
	const used = new Set();
	const pushWidget = (widget) => {
		if (!widget || used.has(widget)) {
			return;
		}
		ordered.push(widget);
		used.add(widget);
	};
	pushWidget(getWidget(node, GJJ_HELP_WIDGET_NAME));
	pushWidget(getDataWidget(node));
	pushWidget(normalizeSequenceRangeWidget(node));
	pushWidget(node.__gjjMultiImageWidget);
	for (const widget of node.widgets) {
		pushWidget(widget);
	}
	node.widgets.splice(0, node.widgets.length, ...ordered);
}

function requestRedraw(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function markGraphChanged(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
	app.graph?.change?.();
}

function serializeSelection(selection) {
	return JSON.stringify(
		(selection || []).map((item) => ({
			filename: String(item?.filename || ""),
			subfolder: String(item?.subfolder || ""),
		})),
	);
}

function parseSelection(rawValue) {
	try {
		const parsed = JSON.parse(String(rawValue || "[]"));
		return Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		return [];
	}
}

function serializedSelectionFromNode(node, serializedNode = null) {
	const propertyValue = String(node?.properties?.[DATA_WIDGET_NAME] || "");
	const widgetValue = String(getDataWidget(node)?.value || "");
	if (parseSelection(propertyValue).length > 0) {
		return propertyValue;
	}
	if (parseSelection(widgetValue).length > 0) {
		return widgetValue;
	}
	const serializedValues = Array.isArray(serializedNode?.widgets_values) ? serializedNode.widgets_values : [];
	for (const value of serializedValues) {
		const text = String(value || "");
		if (parseSelection(text).length > 0) {
			return text;
		}
	}
	return propertyValue || widgetValue || "[]";
}

function imageDataToUrl(item) {
	if (!item?.filename) {
		return "";
	}
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : "";
	return api.apiURL(
		`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "input")}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`,
	);
}

function ensureState(node) {
	node.properties = node.properties || {};
	node.__gjjMultiImageState = node.__gjjMultiImageState || {
		options: [],
		selection: parseSelection(serializedSelectionFromNode(node)),
		externalCount: 0,
		executedImages: [],
		mergedCount: 0,
	};
	return node.__gjjMultiImageState;
}

async function fetchOptions() {
	try {
		const response = await fetch(IMAGE_API_PATH);
		if (!response.ok) {
			return [];
		}
		const data = await response.json();
		return Array.isArray(data?.images) ? data.images : [];
	} catch (error) {
		return [];
	}
}

async function uploadFiles(node, files) {
	const list = Array.from(files || [])
		.filter((file) => file instanceof File)
		.sort((a, b) => FILE_NAME_COLLATOR.compare(a.name || "", b.name || ""));
	if (!list.length) {
		return;
	}
	const state = ensureState(node);
	const uploaded = [];
	if (node.__gjjMultiImageSummary) {
		node.__gjjMultiImageSummary.textContent = `正在导入 ${list.length} 张...`;
	}
	for (const file of list) {
		const formData = new FormData();
		formData.append("image", file, file.name);
		formData.append("type", "input");
		formData.append("subfolder", UPLOAD_SUBFOLDER);
		const response = await fetch(api.apiURL("/upload/image"), {
			method: "POST",
			body: formData,
		});
		if (!response.ok) {
			throw new Error(`上传失败：${file.name}`);
		}
		const payload = await response.json();
		uploaded.push({
			filename: payload?.name || file.name,
			subfolder: payload?.subfolder || UPLOAD_SUBFOLDER,
		});
	}
	await refreshOptions(node);
	for (const item of uploaded) {
		const alreadySelected = state.selection.some((selected) => selected.filename === item.filename && selected.subfolder === item.subfolder);
		// 移除20张限制，允许上传并选择任意数量的图片
		if (!alreadySelected) {
			state.selection.push(item);
		}
	}
	syncDataWidget(node);
	ensureOutputs(node, state.selection.length);
	renderBrowser(node);
	renderPreview(node);
	updateSummary(node);
	scheduleLayout(node);
}

function syncDataWidget(node) {
	const state = ensureState(node);
	const serialized = serializeSelection(state.selection);
	node.properties = node.properties || {};
	node.properties[DATA_WIDGET_NAME] = serialized;
	const widget = getDataWidget(node);
	if (widget) {
		widget.value = serialized;
		widget.callback?.(serialized, app.canvas, node, undefined, widget);
	}
	globalThis.GJJLazyImageStudioSyncBatchSources?.(node);
	markGraphChanged(node);
}

function hasExternalImageLink(node) {
	return Array.isArray(node?.inputs) && node.inputs.some((input) => input?.name === "input_images" && !!input?.link);
}

function ensureOutputs(node, count) {
	const imageCount = Math.max(0, Number(count || 0));

	// 当超过20张时，只显示批量图片队列接口
	// 当20张以内时，显示批量队列 + 单图输出接口
	const showIndividualOutputs = imageCount <= MAX_OUTPUT_IMAGES;
	const visibleCount = showIndividualOutputs ? (imageCount + 1) : 1;

	while ((node.outputs?.length || 0) < visibleCount) {
		const outputIndex = node.outputs?.length || 0;
		if (outputIndex === 0) {
			node.addOutput?.("批量图片队列", BATCH_IMAGE_TYPE);
			continue;
		}
		node.addOutput?.(`图片 ${outputIndex}`, "IMAGE");
	}
	while ((node.outputs?.length || 0) > visibleCount) {
		const lastIndex = node.outputs.length - 1;
		const output = node.outputs[lastIndex];
		if (lastIndex === 0) {
			break;
		}
		if (Array.isArray(output?.links) && output.links.length > 0) {
			break;
		}
		node.removeOutput?.(lastIndex);
	}
	(node.outputs || []).forEach((output, index) => {
		if (index === 0) {
			output.name = "批量图片队列";
			output.label = output.name;
			output.localized_name = output.name;
			output.type = BATCH_IMAGE_TYPE;
			if (imageCount > MAX_OUTPUT_IMAGES) {
				output.tooltip = `已选择 ${imageCount} 张图片（超过20张限制），仅支持批量图片队列输出。`;
			} else {
				output.tooltip = "将所有已选图片按顺序打包成一个 GJJ 专用批量图片队列输出。";
			}
			return;
		}
		output.name = `图片 ${index}`;
		output.label = output.name;
		output.localized_name = output.name;
		output.type = "IMAGE";
		output.tooltip = `第 ${index} 张已选图片的单独输出。`;
	});
	globalThis.GJJApplyTypeColorsToNode?.(node);
}

function isSelected(state, item) {
	return state.selection.some((selected) => selected.filename === item.filename && selected.subfolder === item.subfolder);
}

function toggleSelection(node, item) {
	const state = ensureState(node);
	const existingIndex = state.selection.findIndex((selected) => selected.filename === item.filename && selected.subfolder === item.subfolder);
	if (existingIndex >= 0) {
		state.selection.splice(existingIndex, 1);
	} else {
		// 移除20张限制，允许选择任意数量的图片
		state.selection.push(item);
	}
	syncDataWidget(node);
	ensureOutputs(node, state.selection.length);
	renderBrowser(node);
	renderPreview(node);
	updateSummary(node);
	scheduleLayout(node);
}

function renderBrowser(node) {
	return;
}

function renderPreview(node) {
	const state = ensureState(node);
	const grid = node.__gjjMultiImageGrid;
	const empty = node.__gjjMultiImageEmpty;
	if (!grid || !empty) {
		return;
	}
	grid.replaceChildren();
	const executedItems = Array.isArray(state.executedImages) ? state.executedImages : [];
	const hasExternalPreview = Number(state.externalCount || 0) > 0 && executedItems.length > 0;
	const items = hasExternalPreview ? executedItems : (state.selection || []);
	empty.style.display = items.length > 0 ? "none" : "flex";

	// 存储节点引用以便后续调用
	const nodeRef = node;

	for (const [index, item] of items.entries()) {
		const card = document.createElement("div");
		card.className = "gjj-image-card";
		card.style.cssText = [
			"position:relative",
			"width:100%",
			"aspect-ratio:1/1",
			"overflow:hidden",
			"border-radius:6px",
			"cursor:pointer",
			"transition:transform 0.2s ease",
		].join(";");

		// 鼠标悬停效果
		card.addEventListener("mouseenter", () => {
			card.style.transform = "scale(1.05)";
		});
		card.addEventListener("mouseleave", () => {
			card.style.transform = "scale(1)";
		});

		// 图片元素
		const image = document.createElement("img");
		image.src = imageDataToUrl(item);
		image.draggable = false;
		image.className = "gjj-image-preview";
		image.style.cssText = [
			"width:100%",
			"height:100%",
			"object-fit:cover",
			"display:block",
		].join(";");

		// 左上角：图片序号
		const indexBadge = document.createElement("div");
		indexBadge.className = "gjj-image-index-badge";
		indexBadge.textContent = index + 1;
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
		sizeBadge.className = "gjj-image-size-badge";
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

		// 设置尺寸文字
		if (item.width && item.height) {
			sizeBadge.textContent = `${item.width}×${item.height}`;
		} else if (item.image) {
			sizeBadge.textContent = "外部输入";
		} else {
			sizeBadge.textContent = "加载中...";
			// 图片加载完成后更新尺寸
			image.onload = () => {
				sizeBadge.textContent = `${image.naturalWidth}×${image.naturalHeight}`;
				scheduleLayout(nodeRef);
			};
		}
		// 图片加载失败标记
		image.onerror = () => {
			sizeBadge.textContent = "加载失败";
			// 标记为错误图片
			item._error = true;
			card.style.opacity = "0.5";
			card.style.filter = "grayscale(0.8)";
			scheduleLayout(nodeRef);
		};

		// 右下角：删除按钮
		const deleteBtn = document.createElement("button");
		deleteBtn.className = "gjj-image-delete-btn";
		deleteBtn.innerHTML = "×";
		deleteBtn.style.cssText = [
			"position:absolute",
			"bottom:6px",
			"right:6px",
			"width:28px",
			"height:28px",
			"border-radius:50%",
			"border:none",
			"background:rgba(220, 53, 69, 0.8)",
			"backdrop-filter:blur(4px)",
			"color:#fff",
			"font-size:18px",
			"font-weight:bold",
			"line-height:1",
			"cursor:pointer",
			"transition:all 0.2s ease",
			"pointer-events:auto",
			"z-index:3",
			"display:flex",
			"align-items:center",
			"justify-content:center",
		].join(";");

		// 删除按钮悬停效果
		deleteBtn.addEventListener("mouseenter", () => {
			deleteBtn.style.background = "rgba(220, 53, 69, 1)";
			deleteBtn.style.transform = "scale(1.1)";
		});
		deleteBtn.addEventListener("mouseleave", () => {
			deleteBtn.style.background = "rgba(220, 53, 69, 0.8)";
			deleteBtn.style.transform = "scale(1)";
		});

		// 删除按钮点击事件
		deleteBtn.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			toggleSelection(nodeRef, item);
		});

		// 点击图片放大查看
		card.addEventListener("click", (event) => {
			// 如果点击的是删除按钮，不触发放大
			if (event.target === deleteBtn || deleteBtn.contains(event.target)) {
				return;
			}
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

			const closeHint = document.createElement("div");
			closeHint.textContent = "滚轮缩放 · 双击重置 · 点击关闭";
			closeHint.style.cssText = [
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

			overlay.appendChild(previewImg);
			overlay.appendChild(closeHint);
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
		card.appendChild(deleteBtn);
		grid.appendChild(card);
	}
}

function updateSummary(node) {
	const state = ensureState(node);
	const selectedCount = Number(state.selection?.length || 0);
	const externalCount = Number(state.externalCount || 0);
	const mergedCount = Number(state.mergedCount || 0);
	if (node.__gjjMultiImageSummary) {
		if (externalCount > 0 || selectedCount > 0) {
			const parts = [];
			if (externalCount > 0) {
				parts.push(`外部 ${externalCount} 张`);
			}
			if (selectedCount > 0) {
				parts.push(`已选 ${selectedCount} 张`);
			}
			// 当超过20张时，显示实际总数，不再限制为MAX_OUTPUT_IMAGES
			const total = mergedCount > 0 ? mergedCount : (externalCount + selectedCount);
			if (total > MAX_OUTPUT_IMAGES) {
				node.__gjjMultiImageSummary.textContent = `${parts.join(" + ")}，共 ${total} 张（仅批量队列输出）`;
			} else {
				node.__gjjMultiImageSummary.textContent = `${parts.join(" + ")}，共 ${total} / ${MAX_OUTPUT_IMAGES} 张`;
			}
			return;
		}
		node.__gjjMultiImageSummary.textContent = '点击"浏览图片"导入，或外部连接 GJJ 批量图片队列';
	}
}

function clearErrorImages(node) {
	const state = ensureState(node);
	const beforeCount = state.selection.length;
	state.selection = state.selection.filter((item) => !item._error);
	const removedCount = beforeCount - state.selection.length;
	if (removedCount > 0) {
		syncDataWidget(node);
		ensureOutputs(node, state.selection.length);
		renderPreview(node);
		updateSummary(node);
		scheduleLayout(node);
	}
}

function clearAllImages(node) {
	const state = ensureState(node);
	if (state.selection.length === 0) {
		return;
	}
	state.selection = [];
	syncDataWidget(node);
	ensureOutputs(node, 0);
	renderPreview(node);
	updateSummary(node);
	scheduleLayout(node);
}

function measureHeight(node) {
	const container = node.__gjjMultiImageContainer;
	if (!container) {
		return MIN_HEIGHT;
	}
	const contentHeight = Math.ceil(container.scrollHeight || container.offsetHeight || MIN_HEIGHT);
	return Math.max(MIN_HEIGHT, contentHeight + 8);
}

function updateLayout(node) {
	updateSummary(node);
	// 只更新高度，保留用户设置的宽度
	const height = measureHeight(node);
	node.setSize?.([node.size?.[0], height]);
	if (node.__gjjMultiImageWidget) {
		node.__gjjMultiImageWidget.last_y = 0;
	}
	requestRedraw(node);
}

function scheduleLayout(node) {
	if (!node || node.__gjjMultiImageLayoutQueued) {
		return;
	}
	node.__gjjMultiImageLayoutQueued = true;
	requestAnimationFrame(() => {
		node.__gjjMultiImageLayoutQueued = false;
		updateLayout(node);
	});
}

async function refreshOptions(node) {
	const state = ensureState(node);
	state.options = await fetchOptions();
	renderBrowser(node);
	renderPreview(node);
	updateSummary(node);
	scheduleLayout(node);
}

function buildDom(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"width:100%",
		"height:auto",
		"min-height:unset",
		"box-sizing:border-box",
		"padding:4px 0 0 0",
	].join(";");

	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:0 2px;";

	const browseButton = document.createElement("button");
	browseButton.type = "button";
	browseButton.textContent = " 浏览图片";
	browseButton.title = "打开系统图片选择器；可用 Shift 或 Ctrl 一次选择多张图片。";
	browseButton.style.cssText = [
		"height:26px",
		"padding:0 10px",
		"border:1px solid #465761",
		"border-radius:6px",
		"background:#1a2328",
		"color:#dce7e2",
		"font-size:11px",
		"cursor:pointer",
		"transition:all 0.2s ease",
	].join(";");

	const refreshButton = document.createElement("button");
	refreshButton.type = "button";
	refreshButton.textContent = "🔄 刷新";
	refreshButton.title = "刷新图片列表";
	refreshButton.style.cssText = browseButton.style.cssText;
	refreshButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		refreshOptions(node);
	});

	// 清理错误图片按钮
	const clearErrorButton = document.createElement("button");
	clearErrorButton.type = "button";
	clearErrorButton.textContent = "🗑️ 清理错误";
	clearErrorButton.title = "清理加载失败的图片";
	clearErrorButton.style.cssText = browseButton.style.cssText;
	clearErrorButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		clearErrorImages(node);
	});

	// 清空所有图片按钮
	const clearAllButton = document.createElement("button");
	clearAllButton.type = "button";
	clearAllButton.textContent = "🧹 清空";
	clearAllButton.title = "清空所有已选图片";
	clearAllButton.style.cssText = browseButton.style.cssText;
	clearAllButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		clearAllImages(node);
	});

	// 按钮悬停效果
	[browseButton, refreshButton, clearErrorButton, clearAllButton].forEach(btn => {
		btn.addEventListener("mouseenter", () => {
			btn.style.background = "#243039";
			btn.style.borderColor = "#567080";
		});
		btn.addEventListener("mouseleave", () => {
			btn.style.background = "#1a2328";
			btn.style.borderColor = "#465761";
		});
	});

	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = "image/*";
	fileInput.multiple = true;
	fileInput.style.display = "none";
	fileInput.addEventListener("click", (event) => {
		event.stopPropagation();
	});
	fileInput.addEventListener("change", async (event) => {
		event.stopPropagation();
		const files = Array.from(event.target?.files || []);
		fileInput.value = "";
		if (!files.length) {
			return;
		}
		try {
			await uploadFiles(node, files);
		} catch (error) {
			if (node.__gjjMultiImageSummary) {
				node.__gjjMultiImageSummary.textContent = error?.message || "导入图片失败";
			}
			requestRedraw(node);
		}
	});
	browseButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		fileInput.click();
	});

	const summary = document.createElement("div");
	summary.style.cssText = [
		"font-size:11px",
		"color:#dce7e2",
		"padding:2px 8px",
		"background:rgba(0, 0, 0, 0.3)",
		"border-radius:4px",
		"flex:1",
		"min-width:120px",
	].join(";");

	toolbar.appendChild(browseButton);
	toolbar.appendChild(refreshButton);
	toolbar.appendChild(clearErrorButton);
	toolbar.appendChild(clearAllButton);
	toolbar.appendChild(summary);

	const previewWrap = document.createElement("div");
	previewWrap.style.cssText = [
		"position:relative",
		"border:1px solid #33434a",
		"border-radius:8px",
		"background:#0f1418",
		"padding:6px",
		"box-sizing:border-box",
		"overflow-y:auto",
		"overflow-x:hidden",
		"min-height:160px",
		"max-height:480px",
	].join(";");

	const empty = document.createElement("div");
	empty.textContent = '点击"浏览图片"导入，或外部连接 GJJ 批量图片队列';
	empty.style.cssText = [
		"position:absolute",
		"inset:0",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"padding:12px",
		"font-size:12px",
		"color:#8ea0a8",
		"text-align:center",
		"pointer-events:none",
	].join(";");

	const grid = document.createElement("div");
	grid.style.cssText = [
		"display:grid",
		"grid-template-columns:repeat(auto-fill, minmax(140px, 1fr))",
		"gap:8px",
		"padding:4px",
	].join(";");

	previewWrap.appendChild(grid);
	previewWrap.appendChild(empty);

	container.appendChild(toolbar);
	container.appendChild(previewWrap);
	container.appendChild(fileInput);

	node.__gjjMultiImageContainer = container;
	node.__gjjMultiImageBrowseButton = browseButton;
	node.__gjjMultiImageSummary = summary;
	node.__gjjMultiImageGrid = grid;
	node.__gjjMultiImageEmpty = empty;
	return container;
}

function ensureDomWidget(node) {
	if (node.__gjjMultiImageWidget) {
		return node.__gjjMultiImageWidget;
	}
	const container = buildDom(node);
	const widget = node.addDOMWidget(DOM_WIDGET_NAME, "HTML", container, { serialize: false, hideOnZoom: false });
	widget.computeSize = (width) => [
		Math.max(MIN_WIDTH, Number(width || MIN_WIDTH)),
		Math.max(MIN_HEIGHT, measureHeight(node)),
	];
	widget.draw = () => {};
	node.__gjjMultiImageWidget = widget;
	reorderWidgets(node);
	return widget;
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}
	removeInternalDataInputs(node);
	removeInternalDataWidget(node);
	ensureDomWidget(node);
	reorderWidgets(node);
	const state = ensureState(node);
	syncDataWidget(node);
	ensureOutputs(node, Math.min(MAX_OUTPUT_IMAGES, Number(state.selection.length || 0) + Number(state.externalCount || 0)));
	renderBrowser(node);
	renderPreview(node);
	updateSummary(node);
	scheduleLayout(node);
}

function scheduleStabilize(node, ms = 32) {
	if (!node) {
		return;
	}
	clearTimeout(node.__gjjMultiImageStabilizeTimer);
	node.__gjjMultiImageStabilizeTimer = setTimeout(() => stabilizeNode(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.MultiImageLoader",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleStabilize(this, 0);
			refreshOptions(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			const state = ensureState(this);
			state.selection = parseSelection(serializedSelectionFromNode(this, args[0]));
			state.externalCount = 0;
			state.executedImages = [];
			state.mergedCount = state.selection.length;
			syncDataWidget(this);
			scheduleStabilize(this, 0);
			refreshOptions(this);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			syncDataWidget(this);
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			const serialized = serializeSelection(ensureState(this).selection);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[DATA_WIDGET_NAME] = serialized;
				if (Array.isArray(serializedNode.widgets_values) && Array.isArray(this.widgets)) {
					const widgetIndex = this.widgets.findIndex((widget) => widget?.name === DATA_WIDGET_NAME);
					if (widgetIndex >= 0) {
						serializedNode.widgets_values[widgetIndex] = serialized;
					}
				}
			}
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			const state = ensureState(this);
			state.executedImages = Array.isArray(message?.preview_images) ? message.preview_images : [];
			state.externalCount = Number(message?.external_image_count?.[0] || 0);
			state.mergedCount = Number(message?.merged_image_count?.[0] || 0);
			scheduleStabilize(this, 0);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			const state = ensureState(this);
			if (!hasExternalImageLink(this)) {
				state.externalCount = 0;
				state.executedImages = [];
				state.mergedCount = state.selection.length;
			}
			scheduleStabilize(this);
			return result;
		};
	},

	setup() {
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass)) {
				stabilizeNode(node);
				refreshOptions(node);
			}
		}
	},
});
