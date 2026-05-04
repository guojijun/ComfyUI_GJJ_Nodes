import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_MultiVideoLoader"]);
const DATA_PROPERTY = "selected_videos";
const VIDEO_API_PATH = "/gjj/input_videos";
const VIDEO_UPLOAD_API_PATH = "/gjj/upload_video";
const MAX_SELECTED_VIDEOS = 20;
const MIN_WIDTH = 460;
const MIN_HEIGHT = 260;
const DOM_WIDGET_NAME = "gjj_multi_video_loader_dom";
const BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE";
const FILE_NAME_COLLATOR = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });

function parseSelection(rawValue) {
	try {
		const parsed = JSON.parse(String(rawValue || "[]"));
		return Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		return [];
	}
}

function serializeSelection(selection) {
	return JSON.stringify(
		(selection || []).map((item) => ({
			filename: String(item?.filename || ""),
			subfolder: String(item?.subfolder || ""),
		})),
	);
}

function itemKey(item) {
	return `${String(item?.subfolder || "")}/${String(item?.filename || "")}`;
}

function selectedFromNode(node, serializedNode = null) {
	const propertyValue = String(node?.properties?.[DATA_PROPERTY] || "");
	if (parseSelection(propertyValue).length > 0) {
		return propertyValue;
	}
	const serializedProperty = String(serializedNode?.properties?.[DATA_PROPERTY] || "");
	if (parseSelection(serializedProperty).length > 0) {
		return serializedProperty;
	}
	return propertyValue || serializedProperty || "[]";
}

function requestRedraw(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function ensureState(node) {
	node.properties = node.properties || {};
	node.__gjjMultiVideoState = node.__gjjMultiVideoState || {
		options: [],
		selection: parseSelection(selectedFromNode(node)),
		executedFrames: [],
		executedFrameCount: 0,
		sourceFps: 0,
	};
	return node.__gjjMultiVideoState;
}

function syncSelection(node) {
	const state = ensureState(node);
	node.properties = node.properties || {};
	node.properties[DATA_PROPERTY] = serializeSelection(state.selection);
}

function formatMeta(item) {
	const parts = [];
	const width = Number(item?.width || 0);
	const height = Number(item?.height || 0);
	const fps = Number(item?.fps || 0);
	const frames = Number(item?.frames || 0);
	const duration = Number(item?.duration || 0);
	if (width > 0 && height > 0) {
		parts.push(`${width}×${height}`);
	}
	if (fps > 0) {
		parts.push(`${fps.toFixed(fps >= 10 ? 1 : 2)} FPS`);
	}
	if (frames > 0) {
		parts.push(`${frames} 帧`);
	}
	if (duration > 0) {
		parts.push(`${duration.toFixed(1)} 秒`);
	}
	return parts.join(" · ") || "未读取到媒体信息";
}

async function fetchOptions() {
	try {
		const response = await fetch(api.apiURL(VIDEO_API_PATH));
		if (!response.ok) {
			return [];
		}
		const data = await response.json();
		return Array.isArray(data?.videos) ? data.videos : [];
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
	setSummary(node, `正在导入 ${list.length} 个视频...`);

	const uploaded = [];
	for (const file of list) {
		const formData = new FormData();
		formData.append("video", file, file.name);
		const response = await fetch(api.apiURL(VIDEO_UPLOAD_API_PATH), {
			method: "POST",
			body: formData,
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) {
			throw new Error(payload?.error || `上传失败：${file.name}`);
		}
		for (const item of payload?.videos || []) {
			uploaded.push(item);
		}
	}

	await refreshOptions(node);
	for (const item of uploaded) {
		if (state.selection.length >= MAX_SELECTED_VIDEOS) {
			break;
		}
		if (!state.selection.some((selected) => itemKey(selected) === itemKey(item))) {
			state.selection.push(item);
		}
	}
	syncSelection(node);
	renderSelected(node);
	renderBrowser(node);
	updateSummary(node);
	scheduleLayout(node);
}

function isSelected(state, item) {
	return state.selection.some((selected) => itemKey(selected) === itemKey(item));
}

function toggleSelection(node, item) {
	const state = ensureState(node);
	const existingIndex = state.selection.findIndex((selected) => itemKey(selected) === itemKey(item));
	if (existingIndex >= 0) {
		state.selection.splice(existingIndex, 1);
	} else if (state.selection.length < MAX_SELECTED_VIDEOS) {
		state.selection.push(item);
	}
	syncSelection(node);
	renderSelected(node);
	renderBrowser(node);
	updateSummary(node);
	scheduleLayout(node);
}

function setSummary(node, text) {
	if (node.__gjjMultiVideoSummary) {
		node.__gjjMultiVideoSummary.textContent = text;
	}
	requestRedraw(node);
}

function buttonStyle() {
	return [
		"height:24px",
		"padding:0 10px",
		"border:1px solid #465761",
		"border-radius:6px",
		"background:#1a2328",
		"color:#dce7e2",
		"font-size:11px",
		"cursor:pointer",
	].join(";");
}

function makeCard(node, item, options = {}) {
	const state = ensureState(node);
	const selected = isSelected(state, item);
	const card = document.createElement("button");
	card.type = "button";
	card.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:4px",
		"align-items:stretch",
		"text-align:left",
		"width:100%",
		"padding:7px",
		`border:1px solid ${selected ? "#2ec4b6" : "#33434a"}`,
		"border-radius:8px",
		`background:${selected ? "#102827" : "#12191d"}`,
		"color:#dce7e2",
		"cursor:pointer",
		"box-sizing:border-box",
	].join(";");

	const title = document.createElement("div");
	title.textContent = String(item?.label || item?.filename || "未命名视频");
	title.style.cssText = "font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";

	const meta = document.createElement("div");
	meta.textContent = formatMeta(item);
	meta.style.cssText = "font-size:10px;color:#8ea0a8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";

	const tag = document.createElement("div");
	tag.textContent = selected ? "已选择" : (options.selectedList ? "点击移除" : "点击选择");
	tag.style.cssText = "font-size:10px;color:#2ec4b6;";

	card.appendChild(title);
	card.appendChild(meta);
	card.appendChild(tag);
	card.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		toggleSelection(node, item);
	});
	return card;
}

function renderBrowser(node) {
	const state = ensureState(node);
	const list = node.__gjjMultiVideoBrowser;
	const empty = node.__gjjMultiVideoBrowserEmpty;
	if (!list || !empty) {
		return;
	}
	list.replaceChildren();
	const selectedKeys = new Set(state.selection.map(itemKey));
	const options = (state.options || []).filter((item) => !selectedKeys.has(itemKey(item)));
	empty.style.display = options.length > 0 ? "none" : "flex";
	for (const item of options) {
		list.appendChild(makeCard(node, item));
	}
}

function renderSelected(node) {
	const state = ensureState(node);
	const list = node.__gjjMultiVideoSelected;
	const empty = node.__gjjMultiVideoSelectedEmpty;
	if (!list || !empty) {
		return;
	}
	list.replaceChildren();
	empty.style.display = state.selection.length > 0 ? "none" : "flex";
	const optionByKey = new Map((state.options || []).map((item) => [itemKey(item), item]));
	for (const item of state.selection) {
		list.appendChild(makeCard(node, optionByKey.get(itemKey(item)) || item, { selectedList: true }));
	}
}

function imageDataToUrl(item) {
	if (!item?.filename) {
		return "";
	}
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : "";
	return api.apiURL(`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "temp")}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`);
}

function renderExecutedPreview(node) {
	const state = ensureState(node);
	const grid = node.__gjjMultiVideoPreviewGrid;
	const empty = node.__gjjMultiVideoPreviewEmpty;
	if (!grid || !empty) {
		return;
	}
	grid.replaceChildren();
	const items = Array.isArray(state.executedFrames) ? state.executedFrames : [];
	empty.style.display = items.length > 0 ? "none" : "flex";
	for (const [index, item] of items.entries()) {
		const wrap = document.createElement("div");
		wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;min-width:0;";
		const image = document.createElement("img");
		image.src = imageDataToUrl(item);
		image.draggable = false;
		image.style.cssText = "width:100%;height:82px;object-fit:contain;background:#0c1114;border-radius:6px;";
		const caption = document.createElement("div");
		caption.textContent = `预览帧 ${index + 1}`;
		caption.style.cssText = "font-size:10px;color:#8ea0a8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
		wrap.appendChild(image);
		wrap.appendChild(caption);
		grid.appendChild(wrap);
	}
}

function updateSummary(node) {
	const state = ensureState(node);
	const selectedCount = Number(state.selection?.length || 0);
	const frameCount = Number(state.executedFrameCount || 0);
	if (node.__gjjMultiVideoSummary) {
		if (frameCount > 0) {
			const fps = Number(state.sourceFps || 0);
			node.__gjjMultiVideoSummary.textContent = `已选 ${selectedCount} 个，输出 ${frameCount} 帧${fps > 0 ? `，源帧率 ${fps.toFixed(2)}` : ""}`;
			return;
		}
		node.__gjjMultiVideoSummary.textContent = selectedCount > 0
			? `已选 ${selectedCount} / ${MAX_SELECTED_VIDEOS} 个视频`
			: "点击“导入视频”或从 input 视频列表选择";
	}
}

function measureHeight(node) {
	const container = node.__gjjMultiVideoContainer;
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
	if (node.__gjjMultiVideoWidget) {
		node.__gjjMultiVideoWidget.last_y = 0;
	}
	requestRedraw(node);
}

function scheduleLayout(node) {
	if (!node || node.__gjjMultiVideoLayoutQueued) {
		return;
	}
	node.__gjjMultiVideoLayoutQueued = true;
	requestAnimationFrame(() => {
		node.__gjjMultiVideoLayoutQueued = false;
		updateLayout(node);
	});
}

async function refreshOptions(node) {
	const state = ensureState(node);
	state.options = await fetchOptions();
	renderSelected(node);
	renderBrowser(node);
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
		"box-sizing:border-box",
		"padding:6px 0 0 0",
	].join(";");

	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;";

	const uploadButton = document.createElement("button");
	uploadButton.type = "button";
	uploadButton.textContent = "导入视频";
	uploadButton.style.cssText = buttonStyle();

	const refreshButton = document.createElement("button");
	refreshButton.type = "button";
	refreshButton.textContent = "刷新列表";
	refreshButton.style.cssText = buttonStyle();
	refreshButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		refreshOptions(node);
	});

	const clearButton = document.createElement("button");
	clearButton.type = "button";
	clearButton.textContent = "清空选择";
	clearButton.style.cssText = buttonStyle();
	clearButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const state = ensureState(node);
		state.selection = [];
		state.executedFrames = [];
		state.executedFrameCount = 0;
		syncSelection(node);
		renderSelected(node);
		renderBrowser(node);
		renderExecutedPreview(node);
		updateSummary(node);
		scheduleLayout(node);
	});

	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = "video/*,.gif,.mkv,.webm,.mov,.m4v,.avi,.wmv,.flv";
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
			setSummary(node, error?.message || "导入视频失败");
		}
	});
	uploadButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		fileInput.click();
	});

	const summary = document.createElement("div");
	summary.style.cssText = "font-size:11px;color:#dce7e2;";

	toolbar.appendChild(uploadButton);
	toolbar.appendChild(refreshButton);
	toolbar.appendChild(clearButton);
	toolbar.appendChild(summary);

	const selectedWrap = document.createElement("div");
	selectedWrap.style.cssText = "display:flex;flex-direction:column;gap:6px;border:1px solid #33434a;border-radius:10px;background:#0f1418;padding:8px;box-sizing:border-box;";
	const selectedTitle = document.createElement("div");
	selectedTitle.textContent = "已选视频";
	selectedTitle.style.cssText = "font-size:11px;color:#dce7e2;font-weight:600;";
	const selectedList = document.createElement("div");
	selectedList.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill, minmax(180px, 1fr));gap:6px;";
	const selectedEmpty = document.createElement("div");
	selectedEmpty.textContent = "尚未选择视频";
	selectedEmpty.style.cssText = "display:flex;align-items:center;justify-content:center;min-height:42px;font-size:12px;color:#8ea0a8;";
	selectedWrap.appendChild(selectedTitle);
	selectedWrap.appendChild(selectedList);
	selectedWrap.appendChild(selectedEmpty);

	const browserWrap = document.createElement("div");
	browserWrap.style.cssText = "display:flex;flex-direction:column;gap:6px;border:1px solid #33434a;border-radius:10px;background:#0f1418;padding:8px;box-sizing:border-box;";
	const browserTitle = document.createElement("div");
	browserTitle.textContent = "input 视频列表";
	browserTitle.style.cssText = "font-size:11px;color:#dce7e2;font-weight:600;";
	const browserList = document.createElement("div");
	browserList.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill, minmax(180px, 1fr));gap:6px;max-height:210px;overflow:auto;";
	const browserEmpty = document.createElement("div");
	browserEmpty.textContent = "没有可选视频，或已全部加入选择";
	browserEmpty.style.cssText = "display:flex;align-items:center;justify-content:center;min-height:42px;font-size:12px;color:#8ea0a8;";
	browserWrap.appendChild(browserTitle);
	browserWrap.appendChild(browserList);
	browserWrap.appendChild(browserEmpty);

	const previewWrap = document.createElement("div");
	previewWrap.style.cssText = "display:flex;flex-direction:column;gap:6px;border:1px solid #33434a;border-radius:10px;background:#0f1418;padding:8px;box-sizing:border-box;";
	const previewTitle = document.createElement("div");
	previewTitle.textContent = "执行后帧预览";
	previewTitle.style.cssText = "font-size:11px;color:#dce7e2;font-weight:600;";
	const previewGrid = document.createElement("div");
	previewGrid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill, minmax(96px, 1fr));gap:6px;";
	const previewEmpty = document.createElement("div");
	previewEmpty.textContent = "运行节点后显示抽样帧";
	previewEmpty.style.cssText = "display:flex;align-items:center;justify-content:center;min-height:48px;font-size:12px;color:#8ea0a8;";
	previewWrap.appendChild(previewTitle);
	previewWrap.appendChild(previewGrid);
	previewWrap.appendChild(previewEmpty);

	container.appendChild(toolbar);
	container.appendChild(selectedWrap);
	container.appendChild(browserWrap);
	container.appendChild(previewWrap);
	container.appendChild(fileInput);

	node.__gjjMultiVideoContainer = container;
	node.__gjjMultiVideoSummary = summary;
	node.__gjjMultiVideoSelected = selectedList;
	node.__gjjMultiVideoSelectedEmpty = selectedEmpty;
	node.__gjjMultiVideoBrowser = browserList;
	node.__gjjMultiVideoBrowserEmpty = browserEmpty;
	node.__gjjMultiVideoPreviewGrid = previewGrid;
	node.__gjjMultiVideoPreviewEmpty = previewEmpty;
	return container;
}

function ensureDomWidget(node) {
	if (node.__gjjMultiVideoWidget) {
		return node.__gjjMultiVideoWidget;
	}
	const container = buildDom(node);
	const widget = node.addDOMWidget(DOM_WIDGET_NAME, "HTML", container, { serialize: false, hideOnZoom: false });
	widget.computeSize = (width) => [
		Math.max(MIN_WIDTH, Number(width || MIN_WIDTH)),
		Math.max(MIN_HEIGHT, measureHeight(node)),
	];
	widget.draw = () => {};
	node.__gjjMultiVideoWidget = widget;
	return widget;
}

function normalizeOutputs(node) {
	const outputs = node.outputs || [];
	const names = ["视频帧队列", "首帧预览", "尾帧预览", "视频信息JSON", "源帧率", "输出帧数", "源时长"];
	const types = [BATCH_IMAGE_TYPE, "IMAGE", "IMAGE", "STRING", "FLOAT", "INT", "FLOAT"];
	outputs.forEach((output, index) => {
		if (names[index]) {
			output.name = names[index];
			output.label = names[index];
			output.localized_name = names[index];
			output.type = types[index] || output.type;
		}
	});
	globalThis.GJJApplyTypeColorsToNode?.(node);
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}
	ensureDomWidget(node);
	syncSelection(node);
	normalizeOutputs(node);
	renderSelected(node);
	renderBrowser(node);
	renderExecutedPreview(node);
	updateSummary(node);
	scheduleLayout(node);
}

function scheduleStabilize(node, ms = 32) {
	if (!node) {
		return;
	}
	clearTimeout(node.__gjjMultiVideoStabilizeTimer);
	node.__gjjMultiVideoStabilizeTimer = setTimeout(() => stabilizeNode(node), ms);
}

app.registerExtension({
	name: "Comfy.GJJ.MultiVideoLoader",

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
			state.selection = parseSelection(selectedFromNode(this, args[0]));
			state.executedFrames = [];
			state.executedFrameCount = 0;
			state.sourceFps = 0;
			syncSelection(this);
			scheduleStabilize(this, 0);
			refreshOptions(this);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			syncSelection(this);
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				serializedNode.properties = serializedNode.properties || {};
				serializedNode.properties[DATA_PROPERTY] = serializeSelection(ensureState(this).selection);
			}
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			const state = ensureState(this);
			state.executedFrames = Array.isArray(message?.preview_images) ? message.preview_images : [];
			state.executedFrameCount = Number(message?.frame_count?.[0] || 0);
			state.sourceFps = Number(message?.source_fps?.[0] || 0);
			scheduleStabilize(this, 0);
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
