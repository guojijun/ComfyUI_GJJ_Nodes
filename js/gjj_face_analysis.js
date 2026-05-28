import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";
import { GJJ_STANDARDIZE_NODE } from "./gjj_common_node_standardizer.js";

const NODE_CLASS = "GJJ_FaceAnalysis";
const MIXED_BATCH_IMAGE_TYPE = "GJJ_BATCH_IMAGE,IMAGE";
const PANEL_WIDGET = "gjj_face_analysis_face_picker";
const MIN_WIDTH = 330;

const INPUTS = {
	target: { index: 0, title: "目标脸", widget: "target_faces_index" },
	source: { index: 1, title: "源脸", widget: "source_faces_index" },
};
const EXECUTION_SIGNATURE_WIDGET = "face_picker_signature";
const HIDDEN_INDEX_WIDGETS = ["target_faces_index", "source_faces_index", EXECUTION_SIGNATURE_WIDGET];

GJJ_STANDARDIZE_NODE({
	nodeClass: NODE_CLASS,
	displayName: "GJJ · 🎭 一键批量换脸",
	category: "GJJ/图像",
	description: "使用 InsightFace / ReActor 对目标图和源图执行一键批量换脸，并在公共状态栏显示执行阶段。",
	enableStatus: true,
});

function setTypeColor() {
	if (!window.LiteGraph) return;
	if (!window.LiteGraph.default_connection_color_byType[MIXED_BATCH_IMAGE_TYPE]) {
		window.LiteGraph.default_connection_color_byType[MIXED_BATCH_IMAGE_TYPE] = "#4A90E2";
	}
	if (window.LGraphCanvas && !window.LGraphCanvas.link_type_colors[MIXED_BATCH_IMAGE_TYPE]) {
		window.LGraphCanvas.link_type_colors[MIXED_BATCH_IMAGE_TYPE] = "#4A90E2";
	}
}

function refreshCanvas() {
	app.graph?.setDirtyCanvas?.(true, true);
}

function findWidget(node, name) {
	return (node?.widgets || []).find((widget) => widget?.name === name);
}

function widgetValue(node, name) {
	const value = findWidget(node, name)?.value;
	return value == null ? "" : String(value);
}

function writeWidgetValue(node, name, value) {
	const widget = findWidget(node, name);
	if (!widget) return null;
	const text = String(value);
	widget.value = text;
	if (Array.isArray(node.widgets)) {
		if (!Array.isArray(node.widgets_values)) {
			node.widgets_values = node.widgets.map((item) => item?.value);
		}
		const index = node.widgets?.indexOf(widget) ?? -1;
		if (index >= 0) node.widgets_values[index] = text;
	}
	return widget;
}

function hideWidget(widget) {
	if (!widget || widget.__gjjFaceHidden) return;
	GJJ_Utils.hideWidget(widget);
	widget.__gjjFaceHidden = true;
	widget.serialize = true;
	widget.serializeValue = () => String(widget.value ?? "-");
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.y = 0;
	widget.last_y = 0;
	widget.computedHeight = 0;
	widget.margin_top = 0;
	if (widget.options && typeof widget.options === "object") {
		widget.options.serialize = true;
	}
}

function hideIndexWidgets(node) {
	for (const name of HIDDEN_INDEX_WIDGETS) {
		hideWidget(findWidget(node, name));
	}
	GJJ_Utils.removeHiddenInputSockets?.(node, new Set(HIDDEN_INDEX_WIDGETS));
	GJJ_Utils.refreshNode(node, { preserveWidth: true, minWidth: MIN_WIDTH, minHeight: 80 });
}

function setWidgetValue(node, name, value, options = {}) {
	const widget = writeWidgetValue(node, name, value);
	if (!widget) return;
	const text = String(value);
	if (options.callback !== false && typeof widget.callback === "function") {
		widget.callback(text, app.canvas, node, null);
	}
	if (options.syncSignature !== false && name !== EXECUTION_SIGNATURE_WIDGET) {
		syncExecutionSignature(node);
	}
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	node.graph?.change?.();
	refreshCanvas();
	if (options.render !== false) {
		renderPanel(node);
	}
}

function removeLegacyTargetFaceInput(node) {
	if (!Array.isArray(node?.inputs)) return;
	const index = node.inputs.findIndex((input) => input?.name === "target_face_images");
	if (index < 0) return;
	if (typeof node.removeInput === "function") {
		node.removeInput(index);
	} else {
		node.inputs.splice(index, 1);
	}
}

function labelPrimaryInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	if (node.inputs[0]) node.inputs[0].label = "目标图";
	if (node.inputs[1]) node.inputs[1].label = "源图";
}

function getInputLink(node, inputIndex) {
	const input = node?.inputs?.[inputIndex];
	if (!input?.link || !app.graph?.links) return null;
	return app.graph.links[input.link] || null;
}

function getLinkedSourceNode(node, inputIndex) {
	const link = getInputLink(node, inputIndex);
	const sourceId = link?.origin_id ?? link?.source_id ?? link?.from_id;
	if (sourceId == null) return null;
	return app.graph?.getNodeById?.(sourceId) || null;
}

function parseViewUrl(src) {
	if (!src) return null;
	try {
		const url = new URL(src, window.location.href);
		const filename = url.searchParams.get("filename");
		if (!filename) return null;
		return {
			filename,
			subfolder: url.searchParams.get("subfolder") || "",
			type: url.searchParams.get("type") || "temp",
		};
	} catch {
		return null;
	}
}

function splitComfyFilename(value) {
	const text = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
	if (!text) return null;
	const parts = text.split("/");
	const filename = parts.pop();
	return {
		filename,
		subfolder: parts.join("/"),
		type: "input",
	};
}

function normalizeInfo(item, defaultType = "input") {
	if (!item?.filename && !item?.data_url) return null;
	return {
		filename: String(item.filename || "linked-preview.png"),
		subfolder: String(item.subfolder || ""),
		type: String(item.type || defaultType),
		mtime_ns: item.mtime_ns == null ? undefined : Number(item.mtime_ns),
		size_bytes: item.size_bytes == null ? undefined : Number(item.size_bytes),
		width: item.width == null ? undefined : Number(item.width),
		height: item.height == null ? undefined : Number(item.height),
		data_url: item.data_url ? String(item.data_url) : undefined,
	};
}

function dedupeInfos(infos) {
	const seen = new Set();
	const out = [];
	for (const raw of infos || []) {
		const info = normalizeInfo(raw);
		if (!info) continue;
		const key = `${info.type}\0${info.subfolder}\0${info.filename}\0${info.mtime_ns ?? ""}\0${info.size_bytes ?? ""}\0${info.data_url ? info.data_url.slice(0, 96) : ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(info);
	}
	return out;
}

function imageInfosFromWidget(sourceNode) {
	const fileWidget = sourceNode?.widgets?.find((widget) =>
		["image", "file", "filename"].includes(String(widget?.name || "")),
	);
	const value = fileWidget?.value;
	if (!value) return [];
	const info = splitComfyFilename(value);
	if (!info) return [];
	if (sourceNode?.comfyClass === "LoadImageOutput") {
		info.type = "output";
	}
	return [info];
}

function listFromPossiblePayload(payload) {
	if (Array.isArray(payload)) return payload;
	if (Array.isArray(payload?.selection)) return payload.selection;
	if (Array.isArray(payload?.selected)) return payload.selected;
	if (Array.isArray(payload?.images)) return payload.images;
	if (Array.isArray(payload?.items)) return payload.items;
	return [];
}

function imageInfosFromGjjMultiImage(sourceNode) {
	const selection = sourceNode?.__gjjMultiImageState?.selection;
	if (Array.isArray(selection) && selection.length) {
		return selection.map((item) => normalizeInfo(item)).filter(Boolean);
	}

	const dataWidget = sourceNode?.widgets?.find((widget) => widget?.name === "selected_images");
	const serialized = dataWidget?.value || sourceNode?.properties?.selected_images;
	if (!serialized) return [];
	try {
		const parsed = JSON.parse(String(serialized));
		return listFromPossiblePayload(parsed).map((item) => normalizeInfo(item)).filter(Boolean);
	} catch {
		return [];
	}
}

function imageInfosFromPreview(sourceNode) {
	let canvasDataUrl = "";
	try {
		canvasDataUrl = sourceNode?.canvas?.toDataURL?.("image/png") || "";
	} catch {
		canvasDataUrl = "";
	}
	const srcs = [
		...(Array.isArray(sourceNode?.imgs) ? sourceNode.imgs.map((img) => img?.src) : []),
		sourceNode?.image?.src,
		sourceNode?.preview?.src,
		canvasDataUrl,
	].filter(Boolean);

	const infos = [];
	for (const src of srcs) {
		const viewInfo = parseViewUrl(src);
		if (viewInfo) {
			infos.push(viewInfo);
		} else if (typeof src === "string" && src.startsWith("data:image/")) {
			infos.push({ data_url: src, filename: "linked-preview.png", type: "data" });
		}
	}
	return infos;
}

async function imageInfosFromImageElements(sourceNode) {
	const srcs = [
		...(Array.isArray(sourceNode?.imgs) ? sourceNode.imgs.map((img) => img?.src) : []),
		sourceNode?.image?.src,
		sourceNode?.preview?.src,
	].filter((src) => src && !String(src).startsWith("data:image/"));

	const infos = [];
	for (const src of srcs) {
		try {
			const response = await fetch(src);
			if (!response.ok) continue;
			const blob = await response.blob();
			if (!String(blob.type || "").startsWith("image/")) continue;
			const dataUrl = await new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(reader.result);
				reader.onerror = () => reject(reader.error);
				reader.readAsDataURL(blob);
			});
			infos.push({ data_url: String(dataUrl), filename: "linked-preview.png", type: "data" });
		} catch {
			// Ignore stale preview URLs.
		}
	}
	return infos;
}

async function linkedImageInfos(node, inputIndex) {
	const sourceNode = getLinkedSourceNode(node, inputIndex);
	if (!sourceNode) return [];
	const direct = dedupeInfos([
		...imageInfosFromGjjMultiImage(sourceNode),
		...imageInfosFromWidget(sourceNode),
		...imageInfosFromPreview(sourceNode),
	]);
	if (direct.length) return direct;
	return dedupeInfos(await imageInfosFromImageElements(sourceNode));
}

function infoSignature(info, faceModel) {
	if (!info) return "";
	return JSON.stringify({
		filename: info.filename || "",
		subfolder: info.subfolder || "",
		type: info.type || "",
		mtime: info.mtime_ns ?? "",
		size: info.size_bytes ?? "",
		width: info.width ?? "",
		height: info.height ?? "",
		data: info.data_url ? String(info.data_url).slice(0, 80) : "",
		faceModel: faceModel || "",
	});
}

function bothImageInputsLinked(node) {
	return !!(getInputLink(node, INPUTS.target.index) && getInputLink(node, INPUTS.source.index));
}

function anyImageInputLinked(node) {
	return !!(getInputLink(node, INPUTS.target.index) || getInputLink(node, INPUTS.source.index));
}

function buildExecutionSignature(node) {
	const inputSignatures = node.__gjjFaceInputSignatures || {};
	const targetState = sideState(node, "target");
	const sourceState = sideState(node, "source");
	return JSON.stringify({
		targetInput: inputSignatures.target || targetState.signature || "",
		sourceInput: inputSignatures.source || sourceState.signature || "",
		targetDetected: targetState.images?.map((item) => item.signature || "") || [],
		sourceDetected: sourceState.images?.map((item) => item.signature || "") || [],
		targetFaces: widgetValue(node, INPUTS.target.widget),
		sourceFaces: widgetValue(node, INPUTS.source.widget),
		faceModel: widgetValue(node, "face_model"),
		swapModel: widgetValue(node, "swap_model"),
		restoreModel: widgetValue(node, "face_restore_model"),
	});
}

function syncExecutionSignature(node) {
	const widget = findWidget(node, EXECUTION_SIGNATURE_WIDGET);
	if (!widget) return;
	const text = buildExecutionSignature(node);
	if (String(widget.value ?? "") === text) return;
	writeWidgetValue(node, EXECUTION_SIGNATURE_WIDGET, text);
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	node.graph?.change?.();
	refreshCanvas();
}

function flushHiddenWidgetValues(node, serializedNode = null) {
	syncExecutionSignature(node);
	if (!Array.isArray(node?.widgets)) return;
	if (!Array.isArray(node.widgets_values)) {
		node.widgets_values = [];
	}
	const targetValues = serializedNode
		? (serializedNode.widgets_values = Array.isArray(serializedNode.widgets_values) ? serializedNode.widgets_values : [])
		: null;
	for (const name of HIDDEN_INDEX_WIDGETS) {
		const widget = findWidget(node, name);
		const index = node.widgets.indexOf(widget);
		if (!widget || index < 0) continue;
		const value = typeof widget.serializeValue === "function" ? widget.serializeValue(node, widget) : widget.value;
		node.widgets_values[index] = value;
		if (targetValues) targetValues[index] = value;
	}
	if (serializedNode) {
		serializedNode.properties ||= {};
		serializedNode.properties.gjj_face_picker_signature = widgetValue(node, EXECUTION_SIGNATURE_WIDGET);
	}
}

function parseSelectionGroups(value, imageCount) {
	const text = String(value || "").trim();
	const rawParts = text.includes("|") ? text.split("|") : [text];
	const groups = [];
	for (let imageIndex = 0; imageIndex < Math.max(1, imageCount); imageIndex += 1) {
		const raw = rawParts.length === 1 ? rawParts[0] : (rawParts[imageIndex] ?? "");
		const part = String(raw || "").trim();
		const set = new Set();
		if (part && part !== "-" && part !== "无") {
			for (const token of part.replace(/，/g, ",").split(",")) {
				const index = Number.parseInt(token.trim(), 10);
				if (Number.isInteger(index) && index >= 0) set.add(index);
			}
		}
		groups.push(set);
	}
	return groups;
}

function faceKey(imageIndex, faceIndex) {
	return `${Number(imageIndex || 0)}:${Number(faceIndex || 0)}`;
}

function parseOrderedFaceEntries(value, imageCount) {
	const text = String(value || "").trim();
	if (!text || text === "-" || text === "无") return [];
	if (text.includes(":")) {
		const entries = [];
		const seen = new Set();
		for (const token of text.replace(/[|；;\n\r]/g, ",").replace(/，/g, ",").split(",")) {
			const [imagePart, facePart] = token.split(":");
			const imageIndex = Number.parseInt(String(imagePart || "").trim(), 10);
			const faceIndex = Number.parseInt(String(facePart || "").trim(), 10);
			if (!Number.isInteger(imageIndex) || !Number.isInteger(faceIndex)) continue;
			if (imageIndex < 0 || faceIndex < 0 || imageIndex >= Math.max(1, imageCount)) continue;
			const key = faceKey(imageIndex, faceIndex);
			if (seen.has(key)) continue;
			seen.add(key);
			entries.push({ imageIndex, faceIndex });
		}
		return entries;
	}

	const entries = [];
	const groups = parseSelectionGroups(text, imageCount);
	for (let imageIndex = 0; imageIndex < Math.max(1, imageCount); imageIndex += 1) {
		for (const faceIndex of Array.from(groups[imageIndex] || []).sort((a, b) => a - b)) {
			entries.push({ imageIndex, faceIndex });
		}
	}
	return entries;
}

function formatOrderedFaceEntries(entries) {
	const seen = new Set();
	const parts = [];
	for (const entry of entries || []) {
		const imageIndex = Number(entry?.imageIndex);
		const faceIndex = Number(entry?.faceIndex);
		if (!Number.isInteger(imageIndex) || !Number.isInteger(faceIndex) || imageIndex < 0 || faceIndex < 0) continue;
		const key = faceKey(imageIndex, faceIndex);
		if (seen.has(key)) continue;
		seen.add(key);
		parts.push(key);
	}
	return parts.length ? parts.join(",") : "-";
}

function formatSelectionGroups(groups, imageCount) {
	const parts = [];
	for (let imageIndex = 0; imageIndex < Math.max(1, imageCount); imageIndex += 1) {
		const values = Array.from(groups[imageIndex] || [])
			.filter((value) => Number.isInteger(value) && value >= 0)
			.sort((a, b) => a - b);
		parts.push(values.length ? values.join(",") : "-");
	}
	return imageCount <= 1 ? parts[0] : parts.join("|");
}

function toggleFace(node, side, imageIndex, faceIndex) {
	const cfg = INPUTS[side];
	const state = sideState(node, side);
	const imageCount = Math.max(1, state.images.length || 1);
	const entries = parseOrderedFaceEntries(widgetValue(node, cfg.widget), imageCount);
	const key = faceKey(imageIndex, faceIndex);
	const existingIndex = entries.findIndex((entry) => faceKey(entry.imageIndex, entry.faceIndex) === key);
	if (existingIndex >= 0) {
		entries.splice(existingIndex, 1);
	} else {
		entries.push({ imageIndex, faceIndex });
	}
	setWidgetValue(node, cfg.widget, formatOrderedFaceEntries(entries));
}

function moveOrderedFace(node, side, fromKey, toKey) {
	if (!fromKey || !toKey || fromKey === toKey) return;
	const cfg = INPUTS[side];
	if (!cfg) return;
	const state = sideState(node, side);
	const imageCount = Math.max(1, state.images.length || 1);
	const entries = parseOrderedFaceEntries(widgetValue(node, cfg.widget), imageCount);
	const fromIndex = entries.findIndex((entry) => faceKey(entry.imageIndex, entry.faceIndex) === fromKey);
	const toIndex = entries.findIndex((entry) => faceKey(entry.imageIndex, entry.faceIndex) === toKey);
	if (fromIndex < 0 || toIndex < 0) return;
	const [moved] = entries.splice(fromIndex, 1);
	entries.splice(toIndex, 0, moved);
	setWidgetValue(node, cfg.widget, formatOrderedFaceEntries(entries));
}

function clearSideCache(node, side, clearSelection = false) {
	const cfg = INPUTS[side];
	const state = sideState(node, side);
	state.images = [];
	state.status = "";
	state.signature = "";
	state.loading = false;
	state.error = "";
	if (clearSelection) {
		setWidgetValue(node, cfg.widget, "-");
	}
}

function pruneSelectionToDetected(node, side, images) {
	const cfg = INPUTS[side];
	const imageCount = Math.max(1, images.length || 1);
	const validKeys = new Set();
	for (let imageIndex = 0; imageIndex < imageCount; imageIndex += 1) {
		for (const face of images[imageIndex]?.faces || []) {
			validKeys.add(faceKey(imageIndex, Number(face.index || 0)));
		}
	}
	const entries = parseOrderedFaceEntries(widgetValue(node, cfg.widget), imageCount);
	const next = entries.filter((entry) => validKeys.has(faceKey(entry.imageIndex, entry.faceIndex)));
	if (next.length !== entries.length) {
		setWidgetValue(node, cfg.widget, formatOrderedFaceEntries(next));
	}
}

function buildPanel(node) {
	const root = document.createElement("div");
	root.className = "gjj-face-picker";
	root.innerHTML = `
		<style>
			.gjj-face-picker {
				box-sizing: border-box;
				width: 100%;
				padding: 3px 0 0;
				color: #d8e8ef;
				font: 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			}
			.gjj-face-picker[hidden] { display: none !important; }
			.gjj-face-grid {
				display: grid;
				grid-template-columns: 1fr 1fr;
				gap: 6px;
			}
			.gjj-face-section {
				min-width: 0;
				border: 1px solid rgba(90, 128, 142, 0.42);
				background: rgba(8, 17, 20, 0.52);
				border-radius: 6px;
				padding: 6px;
			}
			.gjj-face-head,
			.gjj-face-image-head {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 6px;
				color: #f3fbff;
				font-weight: 700;
			}
			.gjj-face-head { margin-bottom: 5px; }
			.gjj-face-image-head {
				margin: 5px 0 4px;
				color: #9fc6d1;
				font-size: 11px;
			}
			.gjj-face-status,
			.gjj-face-image-status {
				min-width: 0;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
				color: #8fb0bc;
				font-size: 11px;
				font-weight: 600;
			}
			.gjj-face-list {
				display: flex;
				flex-direction: column;
				gap: 5px;
			}
			.gjj-face-buttons {
				display: grid;
				grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
				gap: 7px;
			}
			.gjj-face-btn {
				min-width: 0;
				aspect-ratio: 1 / 1;
				border: 1px solid rgba(110, 154, 168, 0.36);
				border-radius: 6px;
				background: #111a20;
				color: #dcecf1;
				cursor: pointer;
				font-weight: 700;
				padding: 0;
				position: relative;
				overflow: hidden;
				display: block;
				transition: transform 0.15s ease, opacity 0.15s ease, outline 0.15s ease;
			}
			.gjj-face-btn:hover {
				border-color: #71c7ff;
				background: #27343a;
				transform: scale(1.025);
			}
			.gjj-face-btn.on {
				border-color: #49d17d;
				box-shadow: 0 0 0 1px rgba(73, 209, 125, 0.38) inset;
				background: #183427;
				color: #eafff1;
			}
			.gjj-face-btn img {
				width: 100%;
				height: 100%;
				object-fit: cover;
				display: block;
				user-select: none;
			}
			.gjj-face-btn span {
				position: absolute;
				left: 6px;
				top: 6px;
				min-width: 22px;
				height: 22px;
				padding: 0 6px;
				border-radius: 12px;
				background: rgba(0,0,0,0.56);
				backdrop-filter: blur(4px);
				color: #fff;
				font-size: 10px;
				font-weight: 800;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				pointer-events: none;
				z-index: 2;
			}
			.gjj-face-btn .gjj-face-order {
				left: auto;
				right: 6px;
				background: rgba(24, 112, 71, 0.72);
			}
			.gjj-face-empty {
				color: #7896a0;
				font-size: 11px;
				padding: 3px 0;
			}
			.gjj-face-refresh {
				width: 20px;
				height: 20px;
				padding: 0;
				border-radius: 5px;
				border: 1px solid rgba(110, 154, 168, 0.4);
				background: #253238;
				color: #dcecf1;
				cursor: pointer;
				font-size: 12px;
				line-height: 18px;
			}
			.gjj-face-refresh:hover { border-color: #71c7ff; }
		</style>
		<div class="gjj-face-grid">
			<div class="gjj-face-section" data-side="target">
				<div class="gjj-face-head"><span>目标脸</span><span class="gjj-face-status"></span><button class="gjj-face-refresh" data-side="target" type="button" title="重新识别目标图">↻</button></div>
				<div class="gjj-face-list"></div>
			</div>
			<div class="gjj-face-section" data-side="source">
				<div class="gjj-face-head"><span>源脸</span><span class="gjj-face-status"></span><button class="gjj-face-refresh" data-side="source" type="button" title="重新识别源图">↻</button></div>
				<div class="gjj-face-list"></div>
			</div>
		</div>
	`;
	root.querySelectorAll(".gjj-face-refresh").forEach((button) => {
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			const side = button.dataset.side;
			scheduleDetection(node, 0, true, side ? [side] : null);
		});
	});
	node.__gjjFacePanelRoot = root;
	return root;
}

function ensurePanel(node) {
	if (node.__gjjFacePanelWidget) return node.__gjjFacePanelWidget;
	if (typeof node.addDOMWidget !== "function") return null;
	const root = buildPanel(node);
	const widget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, { serialize: false, hideOnZoom: false });
	widget.serialize = false;
	widget.computeSize = (width) => [Math.max(MIN_WIDTH, Number(width || MIN_WIDTH)), panelHeight(node)];
	widget.getHeight = () => panelHeight(node);
	widget.draw = () => {};
	node.__gjjFacePanelWidget = widget;
	return widget;
}

function panelHeight(node) {
	const root = node?.__gjjFacePanelRoot;
	if (!root || root.hidden) return 0;
	return Math.max(74, Math.ceil(root.scrollHeight || root.getBoundingClientRect?.().height || 74) + 4);
}

function resizeToContent(node) {
	if (!node) return;
	clearTimeout(node.__gjjFaceResizeTimer);
	node.__gjjFaceResizeTimer = setTimeout(() => {
		requestAnimationFrame(() => {
			const width = Math.max(MIN_WIDTH, Number(node.size?.[0] || MIN_WIDTH));
			const computed = typeof node.computeSize === "function" ? node.computeSize() : node.size;
			const height = Math.max(80, Number(computed?.[1] || 80));
			node.setSize?.([width, height]);
			refreshCanvas();
		});
	}, 30);
}

function sideState(node, side) {
	node.__gjjFaceDetectState ||= {};
	node.__gjjFaceDetectState[side] ||= { images: [], status: "", signature: "", loading: false, error: "" };
	return node.__gjjFaceDetectState[side];
}

function renderFaceList(node, side) {
	const root = node.__gjjFacePanelRoot;
	if (!root) return;
	const section = root.querySelector(`[data-side="${side}"]`);
	const list = section?.querySelector(".gjj-face-list");
	const status = section?.querySelector(".gjj-face-status");
	if (!section || !list || !status) return;

	const cfg = INPUTS[side];
	const state = sideState(node, side);
	const images = Array.isArray(state.images) ? state.images : [];
	const imageCount = Math.max(1, images.length || 1);
	const orderedEntries = parseOrderedFaceEntries(widgetValue(node, cfg.widget), imageCount);
	const orderMap = new Map();
	if (side === "target") {
		const perImageCounts = new Map();
		for (const entry of orderedEntries) {
			const imageIndex = Number(entry.imageIndex || 0);
			const orderIndex = Number(perImageCounts.get(imageIndex) || 0);
			orderMap.set(faceKey(imageIndex, entry.faceIndex), orderIndex);
			perImageCounts.set(imageIndex, orderIndex + 1);
		}
	} else {
		for (const [index, entry] of orderedEntries.entries()) {
			orderMap.set(faceKey(entry.imageIndex, entry.faceIndex), index);
		}
	}

	list.replaceChildren();
	status.textContent = state.status || "";

	if (!images.length) {
		const empty = document.createElement("div");
		empty.className = "gjj-face-empty";
		empty.textContent = state.loading ? "识别中" : "等待图片";
		list.appendChild(empty);
		return;
	}

	for (const imageState of images) {
		const imageIndex = Number(imageState.imageIndex || 0);
		const group = document.createElement("div");
		group.className = "gjj-face-image-group";

		const head = document.createElement("div");
		head.className = "gjj-face-image-head";
		const title = document.createElement("span");
		title.textContent = images.length > 1 ? `图 ${imageIndex + 1}` : "当前图";
		const imageStatus = document.createElement("span");
		imageStatus.className = "gjj-face-image-status";
		imageStatus.textContent = imageState.status || "";
		head.append(title, imageStatus);
		group.appendChild(head);

		const buttons = document.createElement("div");
		buttons.className = "gjj-face-buttons";
		for (const face of imageState.faces || []) {
			const faceIndex = Number(face.index || 0);
			const key = faceKey(imageIndex, faceIndex);
			const orderIndex = orderMap.get(key);
			const isSelected = Number.isInteger(orderIndex);
			const card = document.createElement("div");
			card.className = `gjj-face-btn ${isSelected ? "on" : ""}`;
			card.role = "button";
			card.tabIndex = 0;
			card.title = `${cfg.title} · 图 ${imageIndex + 1} · 脸 ${faceIndex + 1}`;
			card.addEventListener("pointerdown", (event) => event.stopPropagation());
			if (isSelected) {
				card.draggable = true;
				card.style.cursor = "grab";
				card.title += " · 拖动可调整替换顺序";
				card.addEventListener("dragstart", (event) => {
					event.stopPropagation();
					card.style.opacity = "0.45";
					event.dataTransfer?.setData("text/plain", key);
					event.dataTransfer?.setData("application/x-gjj-face-key", key);
					event.dataTransfer.effectAllowed = "move";
				});
				card.addEventListener("dragend", () => {
					card.style.opacity = "1";
					card.style.outline = "none";
				});
				card.addEventListener("dragover", (event) => {
					event.preventDefault();
					event.stopPropagation();
					event.dataTransfer.dropEffect = "move";
					card.style.outline = "2px solid rgba(100, 190, 255, 0.85)";
				});
				card.addEventListener("dragleave", () => {
					card.style.outline = "none";
				});
				card.addEventListener("drop", (event) => {
					event.preventDefault();
					event.stopPropagation();
					card.style.outline = "none";
					const fromKey = event.dataTransfer?.getData("application/x-gjj-face-key") || event.dataTransfer?.getData("text/plain");
					moveOrderedFace(node, side, fromKey, key);
				});
			}
			const img = document.createElement("img");
			img.src = face.thumbnail;
			img.alt = card.title;
			img.draggable = false;
			const label = document.createElement("span");
			const faceLabel = images.length > 1 ? `${imageIndex + 1}.${faceIndex + 1}` : String(faceIndex + 1);
			label.textContent = faceLabel;
			card.append(img, label);
			if (isSelected) {
				const orderBadge = document.createElement("span");
				orderBadge.className = "gjj-face-order";
				orderBadge.textContent = orderIndex + 1;
				card.appendChild(orderBadge);
			}
			card.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				toggleFace(node, side, imageIndex, faceIndex);
			});
			card.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				event.stopPropagation();
				toggleFace(node, side, imageIndex, faceIndex);
			});
			buttons.appendChild(card);
		}
		if (!buttons.children.length) {
			const empty = document.createElement("div");
			empty.className = "gjj-face-empty";
			empty.textContent = imageState.status || "未识别到人脸";
			buttons.appendChild(empty);
		}
		group.appendChild(buttons);
		list.appendChild(group);
	}
}

function renderPanel(node) {
	const widget = ensurePanel(node);
	const root = node.__gjjFacePanelRoot;
	if (!widget || !root) return;

	root.hidden = !anyImageInputLinked(node);
	if (root.hidden) {
		resizeToContent(node);
		return;
	}
	renderFaceList(node, "target");
	renderFaceList(node, "source");
	widget.computedHeight = panelHeight(node);
	resizeToContent(node);
}

async function detectImage(info, faceModel, imageIndex) {
	try {
		const response = await fetch(api.apiURL("/gjj/face_analysis/detect_faces"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ image: info, face_model: faceModel }),
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok || payload?.ok === false) {
			throw new Error(payload?.error || `HTTP ${response.status}`);
		}
		const faces = Array.isArray(payload.faces) ? payload.faces : [];
		return {
			info,
			imageIndex,
			faces,
			status: faces.length ? `${faces.length} 张` : "0 张",
			signature: infoSignature(info, faceModel),
		};
	} catch (error) {
		console.warn("[GJJ FaceAnalysis] 人脸识别失败:", error);
		return {
			info,
			imageIndex,
			faces: [],
			status: "失败",
			error: error?.message || String(error),
			signature: infoSignature(info, faceModel),
		};
	}
}

async function detectSide(node, side, force = false) {
	const cfg = INPUTS[side];
	const state = sideState(node, side);
	const infos = await linkedImageInfos(node, cfg.index);
	if (!infos.length) {
		clearSideCache(node, side, true);
		state.status = getInputLink(node, cfg.index) ? "无图" : "";
		syncExecutionSignature(node);
		renderPanel(node);
		return;
	}

	const faceModel = widgetValue(node, "face_model");
	const signature = infos.map((info) => infoSignature(info, faceModel)).join("||");
	if (!force && signature && signature === state.signature && state.images.length === infos.length) {
		renderPanel(node);
		return;
	}

	state.loading = true;
	state.status = "识别中";
	state.error = "";
	state.images = infos.map((info, imageIndex) => ({
		info,
		imageIndex,
		faces: [],
		status: "识别中",
		signature: infoSignature(info, faceModel),
	}));
	renderPanel(node);

	try {
		const detected = await Promise.all(infos.map((info, imageIndex) => detectImage(info, faceModel, imageIndex)));
		const faceCount = detected.reduce((total, item) => total + Number(item.faces?.length || 0), 0);
		state.images = detected;
		state.status = `${detected.length} 图 / ${faceCount} 脸`;
		state.signature = signature;
		pruneSelectionToDetected(node, side, detected);
		syncExecutionSignature(node);
	} finally {
		state.loading = false;
		renderPanel(node);
	}
}

function scheduleDetection(node, delay = 220, force = false, sides = null) {
	if (!node) return;
	const targetSides = (Array.isArray(sides) && sides.length ? sides : Object.keys(INPUTS))
		.filter((side) => INPUTS[side]);
	node.__gjjFacePendingSides ||= new Set();
	for (const side of targetSides) node.__gjjFacePendingSides.add(side);
	clearTimeout(node.__gjjFaceDetectTimer);
	node.__gjjFaceDetectTimer = setTimeout(async () => {
		const pendingSides = Array.from(node.__gjjFacePendingSides || []);
		node.__gjjFacePendingSides = new Set();
		renderPanel(node);
		await Promise.all(pendingSides.map((side) => detectSide(node, side, force)));
	}, delay);
}

async function computeSideInputSignature(node, side) {
	const cfg = INPUTS[side];
	const link = getInputLink(node, cfg.index);
	const sourceNode = getLinkedSourceNode(node, cfg.index);
	if (!link || !sourceNode) return "";

	const infos = await linkedImageInfos(node, cfg.index);
	const faceModel = widgetValue(node, "face_model");
	return JSON.stringify({
		link: inputLinkId(node, cfg.index),
		sourceId: String(sourceNode.id ?? ""),
		sourceType: String(sourceNode.comfyClass || sourceNode.type || ""),
		originSlot: String(link.origin_slot ?? link.source_slot ?? link.from_slot ?? ""),
		faceModel,
		infos: infos.map((info) => ({
			filename: info.filename || "",
			subfolder: info.subfolder || "",
			type: info.type || "",
			mtime: info.mtime_ns ?? "",
			size: info.size_bytes ?? "",
			width: info.width ?? "",
			height: info.height ?? "",
			data: info.data_url ? String(info.data_url).slice(0, 160) : "",
		})),
	});
}

function inputLinkId(node, inputIndex) {
	return String(node?.inputs?.[inputIndex]?.link ?? "");
}

function startInputWatcher(node) {
	if (node.__gjjFaceInputWatcher) return;
	node.__gjjFaceInputSignatures ||= {};
	node.__gjjFaceInputWatcher = window.setInterval(async () => {
		if (!app.graph?._nodes?.includes(node)) {
			window.clearInterval(node.__gjjFaceInputWatcher);
			node.__gjjFaceInputWatcher = null;
			return;
		}
		if (node.__gjjFaceWatcherBusy) return;
		node.__gjjFaceWatcherBusy = true;
		try {
			const changedSides = [];
			for (const side of Object.keys(INPUTS)) {
				if (!getInputLink(node, INPUTS[side].index)) {
					if (node.__gjjFaceInputSignatures[side]) {
						node.__gjjFaceInputSignatures[side] = "";
						clearSideCache(node, side, true);
						changedSides.push(side);
					}
					continue;
				}
				const signature = await computeSideInputSignature(node, side);
				const previous = node.__gjjFaceInputSignatures[side];
				if (previous == null) {
					node.__gjjFaceInputSignatures[side] = signature;
					continue;
				}
				if (signature !== previous) {
					node.__gjjFaceInputSignatures[side] = signature;
					clearSideCache(node, side, true);
					changedSides.push(side);
				}
			}
			if (changedSides.length) {
				syncExecutionSignature(node);
				renderPanel(node);
				scheduleDetection(node, 40, true, changedSides);
			}
		} finally {
			node.__gjjFaceWatcherBusy = false;
		}
	}, 650);
}

function patchWidgetCallbacks(node) {
	if (node.__gjjFaceWidgetCallbacksPatched) return;
	node.__gjjFaceWidgetCallbacksPatched = true;
	for (const name of ["face_model", ...HIDDEN_INDEX_WIDGETS]) {
		const widget = findWidget(node, name);
		if (!widget) continue;
		const original = widget.callback;
		widget.callback = function (...args) {
			const result = original?.apply(this, args);
			if (name === "face_model") {
				scheduleDetection(node, 160, true);
			} else {
				renderPanel(node);
			}
			return result;
		};
	}
}

function normalizeInitialPickerValues(node) {
	for (const side of Object.keys(INPUTS)) {
		const cfg = INPUTS[side];
		const widget = findWidget(node, cfg.widget);
		if (!widget || widget.__gjjFaceInitialValueNormalized) continue;
		widget.__gjjFaceInitialValueNormalized = true;
		if (String(widget.value ?? "").trim() === "0") {
			setWidgetValue(node, cfg.widget, "-", { callback: false, syncSignature: false, render: false });
		}
	}
}

function patchNode(node) {
	if (!node || node.comfyClass !== NODE_CLASS) return;
	removeLegacyTargetFaceInput(node);
	labelPrimaryInputs(node);
	hideIndexWidgets(node);
	normalizeInitialPickerValues(node);
	ensurePanel(node);
	patchWidgetCallbacks(node);
	syncExecutionSignature(node);
	renderPanel(node);
	scheduleDetection(node, 120);
	startInputWatcher(node);
}

app.registerExtension({
	name: "GJJ.FaceAnalysis",

	setup() {
		setTypeColor();
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === NODE_CLASS) patchNode(node);
		}
	},

	nodeCreated(node) {
		if (node.comfyClass !== NODE_CLASS) return;
		patchNode(node);
	},

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (String(nodeData?.name || "") !== NODE_CLASS) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			patchNode(this);
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			requestAnimationFrame(() => patchNode(this));
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			removeLegacyTargetFaceInput(this);
			labelPrimaryInputs(this);
			hideIndexWidgets(this);
			const slotType = args[0];
			const slotIndex = Number(args[1]);
			const isInput = window.LiteGraph
				? slotType === window.LiteGraph.INPUT
				: slotType === 1 || String(slotType).toLowerCase() === "input";
			if (isInput && slotIndex === INPUTS.target.index) {
				scheduleDetection(this, 180, true, ["target"]);
			} else if (isInput && slotIndex === INPUTS.source.index) {
				scheduleDetection(this, 180, true, ["source"]);
			} else if (isInput) {
				scheduleDetection(this, 180, true);
			} else {
				renderPanel(this);
			}
			return result;
		};

		const originalSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			const result = originalSerialize?.apply(this, [serializedNode, ...args]);
			flushHiddenWidgetValues(this, serializedNode);
			return result;
		};
	},
});
