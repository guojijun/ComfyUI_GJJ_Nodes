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
		if (!alreadySelected && state.selection.length < MAX_OUTPUT_IMAGES) {
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
	const imageCount = Math.max(0, Math.min(MAX_OUTPUT_IMAGES, Number(count || 0)));
	const visibleCount = imageCount + 1;
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
			output.tooltip = "将所有已选图片按顺序打包成一个 GJJ 专用批量图片队列输出。";
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
	} else if (state.selection.length < MAX_OUTPUT_IMAGES) {
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
	for (const [index, item] of items.entries()) {
		const card = document.createElement("div");
		card.style.cssText = [
			"display:flex",
			"flex-direction:column",
			"gap:6px",
			"padding:6px",
			"border:1px solid #33434a",
			"border-radius:8px",
			"background:#12191d",
			"min-width:0",
			"position:relative",
			"cursor:pointer",
		].join(";");

		const image = document.createElement("img");
		image.src = imageDataToUrl(item);
		image.draggable = false;
		image.style.cssText = [
			"width:100%",
			"height:108px",
			"object-fit:contain",
			"background:#0c1114",
			"border-radius:6px",
		].join(";");

		const caption = document.createElement("div");
		caption.textContent = hasExternalPreview && index < Number(state.externalCount || 0)
			? `导入图片 ${index + 1}`
			: `图片 ${index + 1}`;
		caption.style.cssText = "font-size:11px;color:#dce7e2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";

		const meta = document.createElement("div");
		meta.textContent = "读取尺寸中...";
		meta.style.cssText = "font-size:10px;color:#8ea0a8;";

		if (item.width && item.height) {
			meta.textContent = `${item.width} × ${item.height}`;
		} else if (item.image) {
			meta.textContent = "外部输入";
		} else {
			image.onload = () => {
				meta.textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
				scheduleLayout(node);
			};
		}
		image.onerror = () => {
			meta.textContent = "尺寸读取失败";
			scheduleLayout(node);
		};

		const removeHint = document.createElement("div");
		removeHint.textContent = hasExternalPreview && index < Number(state.externalCount || 0) ? "外部导入" : "点击移除";
		removeHint.style.cssText = "position:absolute;top:8px;right:8px;padding:1px 6px;border-radius:999px;background:#243039;color:#dce7e2;font-size:10px;pointer-events:none;";

		if (!hasExternalPreview || index >= Number(state.externalCount || 0)) {
			card.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				toggleSelection(node, item);
			});
		}

		card.appendChild(image);
		card.appendChild(caption);
		card.appendChild(meta);
		card.appendChild(removeHint);
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
			const total = mergedCount > 0 ? mergedCount : Math.min(MAX_OUTPUT_IMAGES, externalCount + selectedCount);
			node.__gjjMultiImageSummary.textContent = `${parts.join(" + ")}，共 ${total} / ${MAX_OUTPUT_IMAGES} 张`;
			return;
		}
		node.__gjjMultiImageSummary.textContent = "点击“浏览图片”导入，或外部连接 GJJ 批量图片队列";
	}
}

function measureHeight(node) {
	const container = node.__gjjMultiImageContainer;
	if (!container) {
		return MIN_HEIGHT;
	}
	const contentHeight = Math.ceil(container.scrollHeight || container.offsetHeight || MIN_HEIGHT);
	return Math.max(MIN_HEIGHT, contentHeight + 12);
}

function updateLayout(node) {
	updateSummary(node);
	const width = Math.max(MIN_WIDTH, Number(node.size?.[0] || MIN_WIDTH));
	const height = measureHeight(node);
	node.setSize?.([width, height]);
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
		"gap:8px",
		"width:100%",
		"height:auto",
		"min-height:unset",
		"box-sizing:border-box",
		"padding:6px 0 0 0",
	].join(";");

	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;";

	const browseButton = document.createElement("button");
	browseButton.type = "button";
	browseButton.textContent = "浏览图片";
	browseButton.title = "打开系统图片选择器；可用 Shift 或 Ctrl 一次选择多张图片。";
	browseButton.style.cssText = [
		"height:24px",
		"padding:0 10px",
		"border:1px solid #465761",
		"border-radius:6px",
		"background:#1a2328",
		"color:#dce7e2",
		"font-size:11px",
		"cursor:pointer",
	].join(";");

	const refreshButton = document.createElement("button");
	refreshButton.type = "button";
	refreshButton.textContent = "刷新列表";
	refreshButton.style.cssText = browseButton.style.cssText;
	refreshButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		refreshOptions(node);
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
	summary.style.cssText = "font-size:11px;color:#dce7e2;";

	toolbar.appendChild(browseButton);
	toolbar.appendChild(refreshButton);
	toolbar.appendChild(summary);

	const previewWrap = document.createElement("div");
	previewWrap.style.cssText = [
		"position:relative",
		"border:1px solid #33434a",
		"border-radius:10px",
		"background:#0f1418",
		"padding:8px",
		"box-sizing:border-box",
		"overflow:auto",
		"min-height:124px",
	].join(";");

	const empty = document.createElement("div");
	empty.textContent = "先点击“浏览图片”导入；可按 Shift/Ctrl 多选，点图片可移除";
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
		"grid-template-columns:repeat(auto-fill, minmax(120px, 1fr))",
		"gap:8px",
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
