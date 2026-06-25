import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_TYPE = "GJJ_PanoramaBrowser";
const PANEL_WIDGET = "gjj_panorama_browser_panel";
const STYLE_ID = "gjj-panorama-browser-style";
const DEFAULT_HEIGHT = 360;
const MIN_VIEWER_HEIGHT = 80;
const PANEL_CHROME_HEIGHT = 70;
const DEFAULT_PANEL_HEIGHT = DEFAULT_HEIGHT + PANEL_CHROME_HEIGHT;
const MIN_PANEL_HEIGHT = MIN_VIEWER_HEIGHT + PANEL_CHROME_HEIGHT;
const PANEL_HEIGHT_PROPERTY = "gjj_panorama_panel_height";
const EXECUTED_IMAGE_CACHE = new Map();
const HIDDEN_WIDGETS = new Set([
	"image_path",
	"prefer_connected_image",
	"enable_upscale",
	"upscale_model_name",
	"max_output_edge",
	"viewer_height",
	"screenshot_data",
]);

function widget(node, name) {
	return (node.widgets || []).find((item) => item?.name === name) || null;
}

function hideWidget(item) {
	if (!item || item.__gjjPanoramaHidden) return;
	item.__gjjPanoramaOriginal = {
		type: item.type,
		computeSize: item.computeSize,
		draw: item.draw,
		mouse: item.mouse,
		getHeight: item.getHeight,
	};
	item.hidden = true;
	item.disabled = true;
	item.options = item.options || {};
	item.options.hidden = true;
	item.options.display = "hidden";
	item.type = `converted-widget:${item.name || "hidden"}`;
	item.draw = () => {};
	item.mouse = () => false;
	item.computeSize = () => [0, -4];
	item.getHeight = () => 0;
	item.__gjjPanoramaHidden = true;
}

function setWidgetValue(node, name, value) {
	const item = widget(node, name);
	if (!item) return;
	item.value = value;
	if (Array.isArray(node.widgets_values)) {
		const index = node.widgets?.indexOf(item) ?? -1;
		if (index >= 0) node.widgets_values[index] = value;
	}
	try { item.callback?.(value); } catch (_) {}
	app.graph?.setDirtyCanvas?.(true, true);
}

function getWidgetValue(node, name, fallback = "") {
	return widget(node, name)?.value ?? fallback;
}

function widgetIndex(node, name) {
	const item = widget(node, name);
	return item && Array.isArray(node?.widgets) ? node.widgets.indexOf(item) : -1;
}

function serializedWidgetValue(node, serializedNode, name) {
	const index = widgetIndex(node, name);
	if (Array.isArray(serializedNode?.widgets_values) && index >= 0 && index < serializedNode.widgets_values.length) {
		return serializedNode.widgets_values[index];
	}
	if (serializedNode?.widgets_values && typeof serializedNode.widgets_values === "object") {
		return serializedNode.widgets_values[name];
	}
	return undefined;
}

function clearSerializedScreenshotData(node, serializedNode) {
	if (!serializedNode) return;
	const value = String(serializedWidgetValue(node, serializedNode, "screenshot_data") || "");
	if (value && !value.startsWith("data:image/")) return;
	const index = widgetIndex(node, "screenshot_data");
	if (Array.isArray(serializedNode.widgets_values) && index >= 0 && index < serializedNode.widgets_values.length) {
		serializedNode.widgets_values[index] = "";
	}
	if (serializedNode.widgets_values && typeof serializedNode.widgets_values === "object" && !Array.isArray(serializedNode.widgets_values)) {
		serializedNode.widgets_values.screenshot_data = "";
	}
	if (serializedNode.properties && typeof serializedNode.properties === "object") {
		delete serializedNode.properties.screenshot_data;
	}
}

function imageDataToUrl(data) {
	if (!data?.filename) return "";
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	return api.apiURL(
		`/view?filename=${encodeURIComponent(data.filename)}&type=${encodeURIComponent(data.type || "temp")}&subfolder=${encodeURIComponent(data.subfolder || "")}${previewFormat}${randParam}`,
	);
}

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function normalizeNodeId(value) {
	if (value === undefined || value === null || value === "") return "";
	return String(value);
}

function eventNodeId(event) {
	const detail = event?.detail || {};
	return normalizeNodeId(detail?.node ?? detail?.node_id ?? detail?.display_node);
}

function graphLinkById(linkId) {
	if (linkId === undefined || linkId === null) return null;
	if (Array.isArray(linkId)) return linkId;
	const links = app.graph?.links;
	if (!links) return null;
	if (typeof links.get === "function") return links.get(linkId) || links.get(String(linkId)) || null;
	if (Array.isArray(links)) {
		return links.find((link) => normalizeLinkId(link) === normalizeNodeId(linkId)) || null;
	}
	return links[linkId] || links[String(linkId)] || null;
}

function normalizeLinkId(link) {
	return normalizeNodeId(Array.isArray(link) ? link[0] : (link?.id ?? link?.link_id));
}

function linkOriginId(link) {
	return Array.isArray(link)
		? link[1]
		: (link?.origin_id ?? link?.from_id ?? link?.source_id);
}

function linkOriginSlot(link) {
	return Number(Array.isArray(link)
		? link[2]
		: (link?.origin_slot ?? link?.from_slot ?? link?.source_slot ?? 0));
}

function normalizeImageItem(item) {
	if (!item) return null;
	if (typeof item === "string") return { filename: item, type: "temp", subfolder: "" };
	if (item.src) return { url: item.src };
	if (item.url) return item;
	if (item.filename) return item;
	return null;
}

function collectImagePayloads(...payloads) {
	const result = [];
	const queue = [...payloads];
	const seen = new Set();
	while (queue.length) {
		const item = queue.shift();
		if (!item) continue;
		if (Array.isArray(item)) {
			queue.unshift(...item);
			continue;
		}
		if (typeof item !== "object") continue;
		if (seen.has(item)) continue;
		seen.add(item);
		const normalized = normalizeImageItem(item);
		if (normalized) {
			result.push(normalized);
			continue;
		}
		for (const key of [
			"images",
			"preview_images",
			"__gjj_queue_images",
			"preview_media",
			"preview_image",
			"image",
			"result",
			"ui",
			"output",
			"outputs",
			"panorama_source",
			"panorama_upscaled",
			"panorama_screenshot",
		]) {
			if (item[key]) queue.push(item[key]);
		}
	}
	return result;
}

function collectExecutedImages(output) {
	return collectImagePayloads(output);
}

function rememberExecutedImages(event) {
	const nodeId = eventNodeId(event);
	if (!nodeId) return [];
	const detail = event?.detail || {};
	const images = collectImagePayloads(
		detail.output,
		detail.outputs,
		detail.ui,
		detail.result,
		detail[nodeId],
		detail.output?.[nodeId],
		detail.outputs?.[nodeId],
	);
	if (images.length) EXECUTED_IMAGE_CACHE.set(nodeId, images);
	return images;
}

function ensureStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
.gjj-panorama-root{box-sizing:border-box;width:100%;color:#dce8ea;font:12px/1.35 system-ui,"Microsoft YaHei",sans-serif;user-select:none}
.gjj-panorama-toolbar{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-bottom:7px}
.gjj-panorama-toolbar button,.gjj-panorama-settings button{height:28px;border:1px solid rgba(142,171,184,.36);border-radius:6px;background:#24343b;color:#eef7f8;font-weight:800;cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.gjj-panorama-toolbar button:hover,.gjj-panorama-settings button:hover{background:#31505c}
.gjj-panorama-toolbar button.is-on{background:#2d6f58;border-color:rgba(91,215,164,.72)}
.gjj-panorama-view{position:relative;width:100%;height:var(--gjj-panorama-height,360px);border:1px solid rgba(142,171,184,.38);border-radius:8px;background:#071014;overflow:hidden;cursor:grab;touch-action:none}
.gjj-panorama-view:active{cursor:grabbing}
.gjj-panorama-view canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.gjj-panorama-selection{position:absolute;border:1px solid rgba(102,232,190,.95);background:rgba(60,201,160,.18);box-shadow:0 0 0 9999px rgba(0,0,0,.20);pointer-events:none;display:none}
.gjj-panorama-status{box-sizing:border-box;min-height:24px;margin-top:6px;padding:5px 7px;border-radius:6px;background:rgba(255,255,255,.045);color:#aebfc5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gjj-panorama-settings{display:none;margin-bottom:7px;padding:8px;border:1px solid rgba(142,171,184,.28);border-radius:8px;background:rgba(255,255,255,.035)}
.gjj-panorama-settings.is-open{display:block}
.gjj-panorama-field{display:grid;grid-template-columns:82px minmax(0,1fr);gap:7px;align-items:center;margin-bottom:6px}
.gjj-panorama-field:last-child{margin-bottom:0}
.gjj-panorama-field label{color:#b6c8ce;font-weight:800;white-space:nowrap}
.gjj-panorama-field input,.gjj-panorama-field select{box-sizing:border-box;width:100%;height:26px;border:1px solid rgba(142,171,184,.32);border-radius:6px;background:#101a1f;color:#e7f1f3;padding:0 7px;min-width:0}
.gjj-panorama-field input[type="checkbox"]{width:18px;height:18px}
.gjj-panorama-file{display:none}
`;
	document.head.appendChild(style);
}

function loadImage(url) {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.crossOrigin = "anonymous";
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("图片加载失败"));
		image.src = url;
	});
}

function createRenderer(canvas, status) {
	const ctx = canvas.getContext("2d", { willReadFrequently: false });
	const sampleCanvas = document.createElement("canvas");
	const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
	const state = {
		imageData: null,
		yaw: 0,
		pitch: 0,
		fov: Math.PI / 2.2,
		lastX: 0,
		lastY: 0,
		dirty: true,
		renderScale: 1,
		captureScale: 3,
	};
	function setStatus(text) {
		if (status) status.textContent = text || "";
	}
	function resizeBacking() {
		const rect = canvas.getBoundingClientRect();
		const width = Math.max(160, Math.round(rect.width * state.renderScale));
		const height = Math.max(90, Math.round(rect.height * state.renderScale));
		if (canvas.width !== width || canvas.height !== height) {
			canvas.width = width;
			canvas.height = height;
			state.dirty = true;
		}
	}
	function paintProjection(targetCtx, width, height) {
		if (!state.imageData) {
			targetCtx.fillStyle = "#071014";
			targetCtx.fillRect(0, 0, width, height);
			targetCtx.fillStyle = "#8fa5ad";
			targetCtx.font = "700 13px system-ui";
			targetCtx.textAlign = "center";
			targetCtx.fillText("选择或连接全景图后预览", width / 2, height / 2);
			return;
		}
		const out = targetCtx.createImageData(width, height);
		const dst = out.data;
		const src = state.imageData.data;
		const sw = state.imageData.width;
		const sh = state.imageData.height;
		const aspect = width / Math.max(1, height);
		const tanFov = Math.tan(state.fov / 2);
		const cy = Math.cos(state.yaw);
		const sy = Math.sin(state.yaw);
		const cp = Math.cos(state.pitch);
		const sp = Math.sin(state.pitch);
		for (let y = 0; y < height; y++) {
			const py = (1 - (y + 0.5) / height * 2) * tanFov;
			for (let x = 0; x < width; x++) {
				const px = (((x + 0.5) / width) * 2 - 1) * tanFov * aspect;
				let dx = px, dy = py, dz = -1;
				const invLen = 1 / Math.hypot(dx, dy, dz);
				dx *= invLen; dy *= invLen; dz *= invLen;
				const dy2 = dy * cp - dz * sp;
				const dz2 = dy * sp + dz * cp;
				const dx3 = dx * cy + dz2 * sy;
				const dz3 = -dx * sy + dz2 * cy;
				const lon = Math.atan2(dx3, -dz3);
				const lat = Math.asin(clamp(dy2, -1, 1));
				let u = (lon / (Math.PI * 2) + 0.5) * sw;
				let v = (0.5 - lat / Math.PI) * sh;
				u = ((u % sw) + sw) % sw;
				v = clamp(v, 0, sh - 1);
				const si = (Math.floor(v) * sw + Math.floor(u)) * 4;
				const di = (y * width + x) * 4;
				dst[di] = src[si];
				dst[di + 1] = src[si + 1];
				dst[di + 2] = src[si + 2];
				dst[di + 3] = 255;
			}
		}
		targetCtx.putImageData(out, 0, 0);
	}
	function render() {
		resizeBacking();
		if (!state.dirty) return;
		state.dirty = false;
		paintProjection(ctx, canvas.width, canvas.height);
		setStatus(`视角 ${Math.round(state.yaw * 180 / Math.PI)}° / ${Math.round(state.pitch * 180 / Math.PI)}°，视角缩放 ${Math.round((Math.PI / state.fov) * 36)}%`);
	}
	async function setImageUrl(url, label = "") {
		setStatus("正在加载全景图...");
		const image = await loadImage(url);
		const maxSource = 4096;
		const scale = Math.min(1, maxSource / Math.max(image.width, image.height));
		sampleCanvas.width = Math.max(1, Math.round(image.width * scale));
		sampleCanvas.height = Math.max(1, Math.round(image.height * scale));
		sampleCtx.drawImage(image, 0, 0, sampleCanvas.width, sampleCanvas.height);
		state.imageData = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
		state.dirty = true;
		render();
		setStatus(`${label || "已加载"} ${image.width} x ${image.height}`);
	}
	function nudge(dx, dy) {
		state.yaw += dx;
		state.pitch = clamp(state.pitch + dy, -Math.PI / 2 + 0.03, Math.PI / 2 - 0.03);
		state.dirty = true;
		render();
	}
	function zoom(delta) {
		state.fov = clamp(state.fov * (delta > 0 ? 1.08 : 0.92), Math.PI / 8, Math.PI * 0.92);
		state.dirty = true;
		render();
	}
	function reset() {
		state.yaw = 0;
		state.pitch = 0;
		state.fov = Math.PI / 2.2;
		state.dirty = true;
		render();
	}
	function screenshotDataUrl(rectCss = null) {
		const cssWidth = Math.max(1, Math.round(canvas.clientWidth || canvas.width));
		const cssHeight = Math.max(1, Math.round(canvas.clientHeight || canvas.height));
		const captureScale = clamp(Number(state.captureScale || 3), 1, 6);
		const full = document.createElement("canvas");
		full.width = Math.max(1, Math.round(cssWidth * captureScale));
		full.height = Math.max(1, Math.round(cssHeight * captureScale));
		paintProjection(full.getContext("2d"), full.width, full.height);
		const sx = rectCss ? Math.round(rectCss.x * captureScale) : 0;
		const sy = rectCss ? Math.round(rectCss.y * captureScale) : 0;
		const sw = rectCss ? Math.round(rectCss.w * captureScale) : full.width;
		const sh = rectCss ? Math.round(rectCss.h * captureScale) : full.height;
		const out = document.createElement("canvas");
		out.width = Math.max(1, sw);
		out.height = Math.max(1, sh);
		out.getContext("2d").drawImage(full, sx, sy, sw, sh, 0, 0, out.width, out.height);
		state.dirty = true;
		render();
		return out.toDataURL("image/png");
	}
	return { state, render, setImageUrl, nudge, zoom, reset, screenshotDataUrl };
}

function settingsHeight(ui) {
	const settings = ui?.settings;
	if (!settings?.classList?.contains("is-open")) return 0;
	return Math.max(0, Math.ceil(settings.scrollHeight || settings.offsetHeight || 0));
}

function storedPanelHeight(node, ui) {
	const props = node.properties || (node.properties = {});
	const raw = Number(props[PANEL_HEIGHT_PROPERTY] ?? DEFAULT_PANEL_HEIGHT);
	return Math.max(MIN_PANEL_HEIGHT, Math.round(Number.isFinite(raw) ? raw : DEFAULT_PANEL_HEIGHT));
}

function setStoredPanelHeight(node, ui, height) {
	const value = Math.max(MIN_PANEL_HEIGHT, Math.round(Number(height) || DEFAULT_PANEL_HEIGHT));
	node.properties = node.properties || {};
	const current = Math.round(Number(node.properties[PANEL_HEIGHT_PROPERTY] ?? DEFAULT_PANEL_HEIGHT));
	if (current === value) return value;
	node.properties[PANEL_HEIGHT_PROPERTY] = value;
	setWidgetValue(node, "viewer_height", Math.max(MIN_VIEWER_HEIGHT, value - settingsHeight(ui) - PANEL_CHROME_HEIGHT));
	return value;
}

function panelHeightForNode(node, ui) {
	return storedPanelHeight(node, ui);
}

function widgetTopOffset(ui) {
	const widget = ui?.domWidget;
	const raw = Number(widget?.last_y ?? widget?.y ?? 0);
	return Math.max(0, Math.round(Number.isFinite(raw) ? raw : 0));
}

function viewerHeightForNode(node, ui) {
	return Math.max(MIN_VIEWER_HEIGHT, Math.round(panelHeightForNode(node, ui) - settingsHeight(ui) - PANEL_CHROME_HEIGHT));
}

function updatePanelHeightFromNodeSize(node, ui) {
	const totalHeight = Math.round(Number(node?.size?.[1] || 0));
	if (!totalHeight) return panelHeightForNode(node, ui);
	return setStoredPanelHeight(node, ui, totalHeight - widgetTopOffset(ui));
}

function localNodePos(node, pos, event) {
	if (Array.isArray(pos)) return [Number(pos[0]), Number(pos[1])];
	if (pos && typeof pos.x === "number" && typeof pos.y === "number") return [Number(pos.x), Number(pos.y)];
	if (event && typeof event.canvasX === "number" && typeof event.canvasY === "number") {
		return [event.canvasX - Number(node?.pos?.[0] || 0), event.canvasY - Number(node?.pos?.[1] || 0)];
	}
	if (event && app.canvas?.convertEventToCanvasOffset) {
		const converted = app.canvas.convertEventToCanvasOffset(event);
		if (Array.isArray(converted)) {
			return [Number(converted[0]) - Number(node?.pos?.[0] || 0), Number(converted[1]) - Number(node?.pos?.[1] || 0)];
		}
	}
	return [NaN, NaN];
}

function isResizeHandleHit(node, pos, event) {
	if (!node?.size) return false;
	const [x, y] = localNodePos(node, pos, event);
	if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
	const width = Number(node.size[0] || 0);
	const height = Number(node.size[1] || 0);
	return x >= width - 24 && y >= height - 24;
}

function refreshNodeSize(node) {
	const ui = node?.__gjjPanoramaUI;
	if (!ui || !ui.root) return;
	
	const viewerHeight = viewerHeightForNode(node, ui);
	ui.root.style.setProperty("--gjj-panorama-height", `${viewerHeight}px`);
	ui.renderer.state.dirty = true;
	ui.renderer.render();
}

async function loadPathPreview(node, ui) {
	const path = String(getWidgetValue(node, "image_path", "") || "").trim();
	if (!path) {
		ui.status.textContent = "请先选择全景图，或连接上游 IMAGE。";
		return;
	}
	const response = await fetch(api.apiURL(`/gjj/panorama_browser/preview?path=${encodeURIComponent(path)}`));
	const data = await response.json().catch(() => null);
	if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
	await ui.renderer.setImageUrl(imageDataToUrl(data.image), "已载入");
}

function normalizeUploadFilename(data, file, requestedSubfolder = "") {
	const filename = String(data?.name || data?.filename || data?.file || file?.name || "").replace(/\\/g, "/");
	if (!filename) return "";
	if (filename.includes("/")) return filename;
	const subfolder = String(data?.subfolder ?? requestedSubfolder ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return subfolder ? `${subfolder}/${filename}` : filename;
}

async function uploadChosenFile(node, ui, file) {
	if (!file) return;
	const formData = new FormData();
	formData.append("image", file, file.name);
	formData.append("type", "input");
	formData.append("overwrite", "true");
	const response = api?.fetchApi
		? await api.fetchApi("/upload/image", { method: "POST", body: formData })
		: await fetch(api.apiURL("/upload/image"), { method: "POST", body: formData });
	if (!response?.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`上传失败：HTTP ${response?.status || "?"}${detail ? ` ${detail}` : ""}`);
	}
	const data = await response.json().catch(() => ({}));
	const filename = normalizeUploadFilename(data, file);
	if (!filename) throw new Error("上传成功但没有返回文件名。");
	setWidgetValue(node, "image_path", filename);
	setWidgetValue(node, "prefer_connected_image", false);
	await ui.renderer.setImageUrl(imageDataToUrl({ filename, type: "input", subfolder: "" }), "已选择");
}

async function saveScreenshotToInput(node, dataUrl) {
	const response = await fetch(api.apiURL("/gjj/panorama_browser/screenshot"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ data: dataUrl }),
	});
	const data = await response.json().catch(() => null);
	if (!response.ok || !data?.ok || !data?.image?.image_path) {
		throw new Error(data?.error || `截图保存失败：HTTP ${response.status}`);
	}
	setWidgetValue(node, "screenshot_data", `file:${data.image.image_path}`);
	return data.image;
}

function outputSlotImages(node, slotIndex) {
	const output = node?.outputs?.[Number(slotIndex || 0)] || null;
	return collectImagePayloads(output, output?.widget, output?.value);
}

function nodeDomImages(node) {
	return collectImagePayloads(
		Array.isArray(node?.imgs) ? node.imgs : [],
		node?.image,
		node?.preview,
		Array.isArray(node?.images) ? node.images : [],
		Array.isArray(node?.__outputImages) ? node.__outputImages : [],
		node?.__cachedOutput,
		node?.__lastOutput,
		node?.__lastExecutedOutput,
	);
}

function upstreamImageItem(node) {
	const input = (node.inputs || []).find((item) => item?.name === "image");
	const link = graphLinkById(input?.link);
	const originId = normalizeNodeId(linkOriginId(link));
	const originSlot = linkOriginSlot(link);
	const origin = originId
		? app.graph?.getNodeById?.(originId) || app.graph?.getNodeById?.(Number(originId))
		: null;
	if (!origin && !originId) return null;
	const candidates = [
		origin?.imgs?.[originSlot],
		origin?.imgs?.[0],
		origin?.images?.[originSlot],
		origin?.images?.[0],
		origin?.__outputImages?.[originSlot],
		origin?.__outputImages?.[0],
		outputSlotImages(origin, originSlot),
		nodeDomImages(origin),
	];
	const nodeImages = collectImagePayloads(candidates);
	if (nodeImages.length && originId) EXECUTED_IMAGE_CACHE.set(originId, nodeImages);
	const cached = EXECUTED_IMAGE_CACHE.get(originId);
	if (Array.isArray(cached) && cached.length) {
		return cached[originSlot] || cached[0] || null;
	}
	if (nodeImages.length) return nodeImages[originSlot] || nodeImages[0] || null;
	return null;
}

function panoramaUsesSource(node, sourceNodeId) {
	const input = (node.inputs || []).find((item) => item?.name === "image");
	const link = graphLinkById(input?.link);
	return normalizeNodeId(linkOriginId(link)) === normalizeNodeId(sourceNodeId);
}

async function refreshFromUpstream(node, ui, force = false) {
	if (!force && !Boolean(getWidgetValue(node, "prefer_connected_image", true))) return false;
	const item = upstreamImageItem(node);
	if (!item) return false;
	const key = item.url || `${item.type || "temp"}|${item.subfolder || ""}|${item.filename || ""}`;
	if (!force && key === ui.lastUpstreamKey) return true;
	ui.lastUpstreamKey = key;
	await ui.renderer.setImageUrl(item.url || imageDataToUrl(item), "上游已更新");
	return true;
}

function makeField(label, control) {
	const row = document.createElement("div");
	row.className = "gjj-panorama-field";
	const text = document.createElement("label");
	text.textContent = label;
	row.append(text, control);
	return row;
}

function createSettings(node, ui) {
	const settings = document.createElement("div");
	settings.className = "gjj-panorama-settings";

	const pathInput = document.createElement("input");
	pathInput.value = String(getWidgetValue(node, "image_path", "") || "");
	pathInput.placeholder = "input/ 或 output/ 图片名，也可绝对路径";
	pathInput.addEventListener("change", () => {
		setWidgetValue(node, "image_path", pathInput.value);
		setWidgetValue(node, "prefer_connected_image", false);
		loadPathPreview(node, ui).catch((error) => { ui.status.textContent = `加载失败：${error?.message || error}`; });
	});

	const preferInput = document.createElement("input");
	preferInput.type = "checkbox";
	preferInput.checked = Boolean(getWidgetValue(node, "prefer_connected_image", true));
	preferInput.addEventListener("change", () => {
		setWidgetValue(node, "prefer_connected_image", preferInput.checked);
		refreshFromUpstream(node, ui, true).catch(() => {});
	});

	const upscaleInput = document.createElement("input");
	upscaleInput.type = "checkbox";
	upscaleInput.checked = Boolean(getWidgetValue(node, "enable_upscale", true));
	upscaleInput.addEventListener("change", () => setWidgetValue(node, "enable_upscale", upscaleInput.checked));

	const modelSelect = document.createElement("select");
	const modelWidget = widget(node, "upscale_model_name");
	const values = modelWidget?.options?.values || modelWidget?.options?.items || [];
	for (const value of values) {
		const option = document.createElement("option");
		option.value = String(value);
		option.textContent = String(value || "无模型");
		modelSelect.appendChild(option);
	}
	modelSelect.value = String(getWidgetValue(node, "upscale_model_name", "") || "");
	modelSelect.addEventListener("change", () => setWidgetValue(node, "upscale_model_name", modelSelect.value));

	const edgeInput = document.createElement("input");
	edgeInput.type = "number";
	edgeInput.min = "512";
	edgeInput.max = "32768";
	edgeInput.step = "64";
	edgeInput.value = String(getWidgetValue(node, "max_output_edge", 8192) || 8192);
	edgeInput.addEventListener("change", () => setWidgetValue(node, "max_output_edge", Number(edgeInput.value) || 8192));

	settings.append(
		makeField("路径", pathInput),
		makeField("上游优先", preferInput),
		makeField("模型放大", upscaleInput),
		makeField("放大模型", modelSelect),
		makeField("最大边长", edgeInput),
	);
	return { settings, syncPath: () => { pathInput.value = String(getWidgetValue(node, "image_path", "") || ""); } };
}

function createPanel(node) {
	ensureStyles();
	for (const item of node.widgets || []) if (HIDDEN_WIDGETS.has(item?.name)) hideWidget(item);

	const root = document.createElement("div");
	root.className = "gjj-panorama-root";
	const toolbar = document.createElement("div");
	toolbar.className = "gjj-panorama-toolbar";
	const view = document.createElement("div");
	view.className = "gjj-panorama-view";
	const canvas = document.createElement("canvas");
	const selection = document.createElement("div");
	selection.className = "gjj-panorama-selection";
	const status = document.createElement("div");
	status.className = "gjj-panorama-status";
	const fileInput = document.createElement("input");
	fileInput.className = "gjj-panorama-file";
	fileInput.type = "file";
	fileInput.accept = "image/png,image/jpeg,image/webp,image/bmp,image/tiff";
	status.textContent = "选择或连接全景图后预览。";
	view.append(canvas, selection);
	root.append(toolbar);

	const ui = {
		root, toolbar, view, canvas, selection, status, fileInput,
		renderer: createRenderer(canvas, status),
		selectMode: false,
		selectStart: null,
		lastUpstreamKey: "",
	};
	node.__gjjPanoramaUI = ui;
	const settings = createSettings(node, ui);
	ui.settings = settings.settings;
	root.append(settings.settings, view, status, fileInput);

	function addButton(label, handler) {
		const button = document.createElement("button");
		button.textContent = label;
		button.title = label;
		for (const eventName of ["pointerdown", "mousedown", "wheel"]) {
			button.addEventListener(eventName, (event) => event.stopPropagation(), { passive: false });
		}
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			handler(button);
		});
		toolbar.appendChild(button);
		return button;
	}

	addButton("📁", () => fileInput.click());
	addButton("✂️", (button) => {
		ui.selectMode = !ui.selectMode;
		button.classList.toggle("is-on", ui.selectMode);
		status.textContent = ui.selectMode ? "拖拽框选当前视角截图。" : "已退出框选。";
	});
	addButton("📸", async () => {
		try {
			const image = await saveScreenshotToInput(node, ui.renderer.screenshotDataUrl());
			status.textContent = `已保存截图 ${image.width} x ${image.height} 到 input，执行后输出放大图。`;
		} catch (error) {
			status.textContent = `截图失败：${error?.message || error}`;
		}
	});
	addButton("⚙️", (button) => {
		settings.settings.classList.toggle("is-open");
		button.classList.toggle("is-on", settings.settings.classList.contains("is-open"));
		refreshNodeSize(node);
	});
	addButton("←", () => ui.renderer.nudge(-0.16, 0));
	addButton("→", () => ui.renderer.nudge(0.16, 0));
	addButton("↑", () => ui.renderer.nudge(0, 0.12));
	addButton("↓", () => ui.renderer.nudge(0, -0.12));

	fileInput.addEventListener("change", async () => {
		try {
			await uploadChosenFile(node, ui, fileInput.files?.[0]);
			settings.syncPath();
		} catch (error) {
			status.textContent = `选择失败：${error?.message || error}`;
		} finally {
			fileInput.value = "";
		}
	});

	let dragging = false;
	function stopCanvasEvent(event) {
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation?.();
	}
	view.addEventListener("pointerdown", (event) => {
		stopCanvasEvent(event);
		const rect = view.getBoundingClientRect();
		if (ui.selectMode) {
			ui.selectStart = { x: event.clientX - rect.left, y: event.clientY - rect.top };
			Object.assign(selection.style, { display: "block", left: `${ui.selectStart.x}px`, top: `${ui.selectStart.y}px`, width: "1px", height: "1px" });
			return;
		}
		dragging = true;
		ui.renderer.state.lastX = event.clientX;
		ui.renderer.state.lastY = event.clientY;
		view.setPointerCapture?.(event.pointerId);
	}, true);
	view.addEventListener("pointermove", (event) => {
		stopCanvasEvent(event);
		const rect = view.getBoundingClientRect();
		if (ui.selectMode && ui.selectStart) {
			const x = event.clientX - rect.left;
			const y = event.clientY - rect.top;
			const left = Math.min(ui.selectStart.x, x);
			const top = Math.min(ui.selectStart.y, y);
			Object.assign(selection.style, { left: `${left}px`, top: `${top}px`, width: `${Math.abs(x - ui.selectStart.x)}px`, height: `${Math.abs(y - ui.selectStart.y)}px` });
			return;
		}
		if (!dragging) return;
		const dx = event.clientX - ui.renderer.state.lastX;
		const dy = event.clientY - ui.renderer.state.lastY;
		ui.renderer.state.lastX = event.clientX;
		ui.renderer.state.lastY = event.clientY;
		ui.renderer.nudge(-dx * 0.006, dy * 0.006);
	}, true);
	view.addEventListener("pointerup", (event) => {
		stopCanvasEvent(event);
		if (ui.selectMode && ui.selectStart) {
			const rect = view.getBoundingClientRect();
			const x = event.clientX - rect.left;
			const y = event.clientY - rect.top;
			const left = clamp(Math.min(ui.selectStart.x, x), 0, rect.width);
			const top = clamp(Math.min(ui.selectStart.y, y), 0, rect.height);
			const width = clamp(Math.abs(x - ui.selectStart.x), 1, rect.width - left);
			const height = clamp(Math.abs(y - ui.selectStart.y), 1, rect.height - top);
			if (width > 4 && height > 4) {
				saveScreenshotToInput(node, ui.renderer.screenshotDataUrl({ x: left, y: top, w: width, h: height }))
					.then((image) => {
						status.textContent = `已保存框选 ${image.width} x ${image.height} 到 input，执行后输出放大图。`;
					})
					.catch((error) => {
						status.textContent = `框选保存失败：${error?.message || error}`;
					});
			}
			selection.style.display = "none";
			ui.selectStart = null;
			return;
		}
		dragging = false;
	}, true);
	view.addEventListener("pointerleave", () => {
		dragging = false;
		if (ui.selectStart) {
			ui.selectStart = null;
			selection.style.display = "none";
		}
	});
	view.addEventListener("wheel", (event) => {
		stopCanvasEvent(event);
		ui.renderer.zoom(event.deltaY);
	}, { capture: true, passive: false });

	const domWidget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, { serialize: false, hideOnZoom: false });
	ui.domWidget = domWidget;
	domWidget.computeSize = (width) => {
		const currentWidth = Math.round(width || node.size?.[0] || 420);
		return [currentWidth, panelHeightForNode(node, ui)];
	};
	domWidget.getHeight = () => panelHeightForNode(node, ui);
	setStoredPanelHeight(node, ui, panelHeightForNode(node, ui));
	refreshNodeSize(node);
	setTimeout(() => refreshFromUpstream(node, ui, true).catch(() => {}), 80);
	setTimeout(() => {
		for (const item of node.widgets || []) if (HIDDEN_WIDGETS.has(item?.name)) hideWidget(item);
		updatePanelHeightFromNodeSize(node, ui);
		refreshNodeSize(node);
	}, 120);
	return ui;
}

function isTarget(node) {
	return (node?.comfyClass || node?.type) === NODE_TYPE;
}

function refreshAllPanoramaNodes(force = false) {
	for (const node of app.graph?._nodes || []) {
		if (!isTarget(node) || !node.__gjjPanoramaUI) continue;
		refreshFromUpstream(node, node.__gjjPanoramaUI, force).catch(() => {});
	}
}

function refreshPanoramaNodesForSource(sourceNodeId) {
	for (const node of app.graph?._nodes || []) {
		if (!isTarget(node) || !node.__gjjPanoramaUI || !panoramaUsesSource(node, sourceNodeId)) continue;
		refreshFromUpstream(node, node.__gjjPanoramaUI, true).catch(() => {});
	}
}

async function refreshTargetNodeFromExecuted(nodeId, images) {
	const node = nodeId
		? app.graph?.getNodeById?.(nodeId) || app.graph?.getNodeById?.(Number(nodeId))
		: null;
	if (!isTarget(node) || !node.__gjjPanoramaUI || !Array.isArray(images) || !images.length) return;
	const ui = node.__gjjPanoramaUI;
	const item = images[0];
	const key = item.url || `${item.type || "temp"}|${item.subfolder || ""}|${item.filename || ""}`;
	ui.lastUpstreamKey = key;
	await ui.renderer.setImageUrl(item.url || imageDataToUrl(item), "上游已更新");
}

app.registerExtension({
	name: "GJJ.PanoramaBrowser",
	nodeCreated(node) {
		if (!isTarget(node)) return;
		if (!node.__gjjPanoramaUI && typeof node.addDOMWidget === "function") createPanel(node);
	},
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			const ui = this.__gjjPanoramaUI || createPanel(this);
			for (const item of this.widgets || []) if (HIDDEN_WIDGETS.has(item?.name)) hideWidget(item);
			setTimeout(() => {
				for (const item of this.widgets || []) if (HIDDEN_WIDGETS.has(item?.name)) hideWidget(item);
				refreshFromUpstream(this, ui, true).catch(() => {});
				updatePanelHeightFromNodeSize(this, ui);
				refreshNodeSize(this);
			}, 80);
			return result;
		};
		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			const result = originalOnSerialize?.apply(this, arguments);
			clearSerializedScreenshotData(this, serializedNode);
			return result;
		};
		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (this.__gjjPanoramaUI) {
				const canvasResizingThis = app.canvas?.resizing_node === this || app.canvas?.resizing_node?.node === this;
				if (this.__gjjPanoramaManualResize || canvasResizingThis) {
					updatePanelHeightFromNodeSize(this, this.__gjjPanoramaUI);
				}
				refreshNodeSize(this);
			}
			return result;
		};
		const originalOnMouseDown = nodeType.prototype.onMouseDown;
		nodeType.prototype.onMouseDown = function (event, pos, canvas) {
			if (this.__gjjPanoramaUI && isResizeHandleHit(this, pos, event)) {
				this.__gjjPanoramaManualResize = true;
				const clearManualResize = () => {
					this.__gjjPanoramaManualResize = false;
					window.removeEventListener("pointerup", clearManualResize, true);
					window.removeEventListener("mouseup", clearManualResize, true);
				};
				window.addEventListener("pointerup", clearManualResize, true);
				window.addEventListener("mouseup", clearManualResize, true);
			}
			return originalOnMouseDown?.apply(this, arguments);
		};
		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			const ui = this.__gjjPanoramaUI || createPanel(this);
			setTimeout(() => refreshFromUpstream(this, ui, true).catch(() => {}), 50);
			return result;
		};
	},
});

api.addEventListener("executed", (event) => {
	const nodeId = eventNodeId(event);
	const images = rememberExecutedImages(event);
	setTimeout(() => {
		refreshTargetNodeFromExecuted(nodeId, images).catch(() => {});
		if (nodeId) refreshPanoramaNodesForSource(nodeId);
		refreshAllPanoramaNodes(false);
	}, 60);
});
