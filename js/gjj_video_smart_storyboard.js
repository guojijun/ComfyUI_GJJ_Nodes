import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_NAME = "GJJ_VideoSmartStoryboard";
const UI_KEY = "gjj_video_smart_storyboard";
const MEDIA_INPUT = "media";
const AUDIO_INPUT = "audio";
const OUTPUT_SCENE_WIDGET = "output_scene";
const SELECTED_VIDEO_WIDGET = "selected_video";
const DOM_WIDGET = "gjj_video_smart_storyboard_controls";
const AUTO_PROP = "gjj_video_smart_storyboard_auto";
const SELECTED_VIDEO_PROP = "selected_video";
const UPLOAD_API = "/gjj/video_smart_storyboard/upload";
const META_API = "/gjj/video_smart_storyboard/meta";
const MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO";
const OUTPUT_MEDIA_TYPE = "VIDEO,GJJ_BATCH_IMAGE,IMAGE";
const AUDIO_INPUT_TYPE = "AUDIO,VIDEO";
const QUEUE_DELAY_MS = 360;
const TOOLBAR_HEIGHT = 48;
const THUMB_W = 72;
const THUMB_H = 58;
const THUMB_GAP = 7;

const OUTPUT_DEFS = [
	{ name: "当前分镜", type: OUTPUT_MEDIA_TYPE, tooltip: "当前分镜优先输出官方 VIDEO，并携带当段源音频；无法创建 VIDEO 时回退为帧序列。" },
	{ name: "当前分镜序号", type: "INT", tooltip: "当前实际输出的 1 基分镜序号。" },
	{ name: "总分镜数", type: "INT", tooltip: "自动检测到的总分镜数。" },
];

let activeAutoNodeId = null;
let autoTimer = null;

function findWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function normalizeSlotName(value) {
	return String(value || "").replace(/^converted-widget:/i, "");
}

function inputMatchesName(input, name) {
	const inputName = normalizeSlotName(input?.name);
	const inputType = normalizeSlotName(input?.type);
	const widgetName = String(input?.widget?.name || input?.widget_name || "");
	return inputName === name || inputType === name || widgetName === name;
}

function findInput(node, name) {
	return node?.inputs?.find((input) => inputMatchesName(input, name));
}

function hasInputLink(node, name) {
	return Boolean(node?.inputs?.some((input) => inputMatchesName(input, name) && input?.link != null));
}

function dirty(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
	app.graph?.change?.();
}

function linkValue(link, key) {
	if (!Array.isArray(link)) return link?.[key];
	const indexes = { id: 0, origin_id: 1, origin_slot: 2, target_id: 3, target_slot: 4, type: 5 };
	return link[indexes[key]];
}

function getGraphLink(graph, linkId) {
	const links = graph?.links || app.graph?.links;
	if (!links || linkId == null) return null;
	if (typeof links.get === "function") {
		return links.get(linkId) || links.get(Number(linkId)) || links.get(String(linkId)) || null;
	}
	if (links[linkId]) return links[linkId];
	if (links[String(linkId)]) return links[String(linkId)];
	if (Array.isArray(links)) return links.find((link) => String(linkValue(link, "id")) === String(linkId)) || null;
	return null;
}

function getGraphNodeById(graph, id) {
	if (id == null) return null;
	const numberId = Number(id);
	return graph?.getNodeById?.(Number.isFinite(numberId) ? numberId : id)
		|| graph?._nodes_by_id?.[id]
		|| graph?._nodes_by_id?.[String(id)]
		|| (graph?._nodes || []).find((node) => String(node?.id) === String(id))
		|| null;
}

function collectUpstreamNodeIds(node) {
	const graph = node?.graph || app.graph;
	const keep = new Set();
	const visit = (current) => {
		if (!Array.isArray(current?.inputs)) return;
		for (const input of current.inputs) {
			const link = getGraphLink(graph, input?.link);
			const originId = linkValue(link, "origin_id");
			if (originId == null) continue;
			const key = String(originId);
			if (keep.has(key)) continue;
			keep.add(key);
			const originNode = getGraphNodeById(graph, originId);
			if (originNode) visit(originNode);
		}
	};
	visit(node);
	return keep;
}

function isExecutionOutputNode(node) {
	return Boolean(node?.constructor?.nodeData?.output_node || node?.nodeData?.output_node || node?.flags?.output || node?.comfyClass === NODE_NAME);
}

function syncNodeWidgetValues(node) {
	if (!Array.isArray(node?.widgets)) return;
	try {
		node.widgets_values = node.widgets.map((widget) => {
			try {
				if (typeof widget?.serializeValue === "function") return widget.serializeValue(node, widget);
			} catch (_) {}
			return widget?.value;
		});
	} catch (_) {}
}

async function queueOnlyCurrentNode(node) {
	if (!node || !node.graph) return false;
	const graph = node.graph || app.graph;
	const allNodes = graph?._nodes || app.graph?._nodes || [];
	const upstreamNodeIds = collectUpstreamNodeIds(node);
	const savedModes = [];
	const oldSelectedNodes = app.canvas?.selected_nodes;
	const oldSelectedNode = app.canvas?.selected_node;

	try {
		for (const item of allNodes) {
			if (!item || item === node) continue;
			if (upstreamNodeIds.has(String(item.id))) continue;
			if (isExecutionOutputNode(item)) {
				savedModes.push([item, item.mode]);
				item.mode = 2;
			}
		}
		if (app.canvas) {
			app.canvas.selected_nodes = {};
			app.canvas.selected_nodes[node.id] = node;
			app.canvas.selected_node = node;
		}
		restorePropertiesToWidgets(node);
		syncNodeWidgetValues(node);
		dirty(node);
		if (typeof app.queuePrompt === "function") {
			await app.queuePrompt(0, 1);
			return true;
		}
		return false;
	} finally {
		for (const [item, mode] of savedModes) item.mode = mode;
		if (app.canvas) {
			app.canvas.selected_nodes = oldSelectedNodes;
			app.canvas.selected_node = oldSelectedNode;
		}
		dirty(node);
	}
}

function normalizeSceneIndex(value) {
	const number = Number.parseInt(String(value ?? "").trim(), 10);
	return Number.isFinite(number) ? Math.max(1, number) : 1;
}

function currentOutputScene(node, data = null) {
	const widget = findWidget(node, OUTPUT_SCENE_WIDGET);
	const raw = widget?.value ?? node?.properties?.[OUTPUT_SCENE_WIDGET] ?? data?.current_scene ?? data?.requested_scene ?? 1;
	const current = normalizeSceneIndex(raw);
	const total = Number(data?.total_scenes || 0);
	return total > 0 ? Math.min(current, total) : current;
}

function setWidgetValue(node, name, value) {
	const widget = findWidget(node, name);
	if (!widget) return false;
	const fixed = name === OUTPUT_SCENE_WIDGET ? normalizeSceneIndex(value) : value;
	widget.value = fixed;
	node.properties ||= {};
	node.properties[name] = fixed;
	widget.callback?.call(widget, fixed);
	syncNodeWidgetValues(node);
	dirty(node);
	return true;
}

function removeInputAt(node, index) {
	if (!Array.isArray(node?.inputs) || index < 0 || index >= node.inputs.length) return;
	if (node.inputs[index]?.link != null) {
		try { node.disconnectInput?.(index); } catch (_) {}
	}
	try { node.removeInput?.(index); } catch (_) { node.inputs.splice(index, 1); }
}

function removeOutputAt(node, index) {
	if (!Array.isArray(node?.outputs) || index < 0 || index >= node.outputs.length) return;
	try { node.disconnectOutput?.(index); } catch (_) {}
	try { node.removeOutput?.(index); } catch (_) { node.outputs.splice(index, 1); }
}

function repairInputLinkSlots(node) {
	const graphLinks = node?.graph?.links || app.graph?.links;
	if (!graphLinks || !Array.isArray(node?.inputs)) return;
	node.inputs.forEach((input, index) => {
		if (input?.link == null) return;
		const link = graphLinks[input.link];
		if (!link) return;
		if (Array.isArray(link)) {
			link[3] = node.id;
			link[4] = index;
		} else {
			link.target_id = node.id;
			link.target_slot = index;
		}
	});
}

function hideWidget(widget) {
	if (!widget) return;
	if (!widget.__gjjSmartStoryboardHidden) {
		widget.__gjjSmartStoryboardHidden = true;
		widget.__gjjOriginalType = widget.type;
		widget.__gjjOriginalComputeSize = widget.computeSize;
		widget.__gjjOriginalGetHeight = widget.getHeight;
		widget.__gjjOriginalDraw = widget.draw;
		widget.__gjjOriginalMouse = widget.mouse;
	}
	widget.serialize = true;
	widget.hidden = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.mouse = () => false;
	widget.y = -10000;
	widget.last_y = -10000;
	widget.options ||= {};
	widget.options.hidden = true;
	widget.options.display = "hidden";
	if (widget.element) widget.element.style.display = "none";
	if (widget.inputEl) widget.inputEl.style.display = "none";
}

function removeSelectedVideoInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		if (!inputMatchesName(input, SELECTED_VIDEO_WIDGET)) continue;
		removeInputAt(node, index);
	}
}

function ensureOutputSceneWidget(node) {
	const widget = findWidget(node, OUTPUT_SCENE_WIDGET);
	if (!widget) return;
	widget.name = OUTPUT_SCENE_WIDGET;
	widget.label = "输出分镜";
	widget.localized_name = "输出分镜";
	widget.display_name = "输出分镜";
	widget.tooltip = "要输出的 1 基分镜序号；可直接输入，也可连接左侧输入口。";
	widget.options ||= {};
	widget.options.min = 1;
	widget.options.step = 1;
	widget.options.display_name = "输出分镜";
	widget.options.tooltip = widget.tooltip;
	if (!widget.__gjjSmartStoryboardPatched) {
		const originalCallback = widget.callback;
		widget.__gjjSmartStoryboardOwner = node;
		widget.callback = function (value, ...args) {
			const fixed = normalizeSceneIndex(value);
			if (fixed !== value) this.value = fixed;
			const result = originalCallback?.call(this, fixed, ...args);
			const owner = this.__gjjSmartStoryboardOwner;
			if (owner?.comfyClass === NODE_NAME) {
				owner.properties ||= {};
				owner.properties[OUTPUT_SCENE_WIDGET] = fixed;
				renderControls(owner);
			}
			return result;
		};
		widget.__gjjSmartStoryboardPatched = true;
	}
	widget.__gjjSmartStoryboardOwner = node;
}

function ensureWidgetInput(node) {
	let input = findInput(node, OUTPUT_SCENE_WIDGET);
	if (!input) {
		node.addInput?.(OUTPUT_SCENE_WIDGET, "INT");
		input = node.inputs?.[node.inputs.length - 1] || null;
	}
	if (!input) return null;
	input.name = OUTPUT_SCENE_WIDGET;
	input.type = "INT";
	input.label = "输出分镜";
	input.localized_name = "输出分镜";
	input.display_name = "输出分镜";
	input.tooltip = "连接后由外部 INT 控制输出分镜；连接时自动队列会停止。";
	input.widget = { name: OUTPUT_SCENE_WIDGET };
	input.forceInput = false;
	input.hidden = false;
	input.visible = true;
	return input;
}

function ensureAudioInput(node) {
	let input = findInput(node, AUDIO_INPUT);
	if (!input) {
		node.addInput?.(AUDIO_INPUT, AUDIO_INPUT_TYPE);
		input = node.inputs?.[node.inputs.length - 1] || null;
	}
	if (!input) return null;
	input.name = AUDIO_INPUT;
	input.type = AUDIO_INPUT_TYPE;
	input.label = "音频";
	input.localized_name = "音频";
	input.display_name = "音频";
	input.tooltip = "可选。可连接 AUDIO 或 VIDEO；连接后按当前分镜范围裁切并封入输出 VIDEO。";
	input.forceInput = false;
	input.hidden = false;
	input.visible = true;
	delete input.widget;
	return input;
}

function ensureInputShape(node) {
	if (!Array.isArray(node?.inputs)) return;
	let media = findInput(node, MEDIA_INPUT);
	if (!media) {
		node.addInput?.(MEDIA_INPUT, MEDIA_INPUT_TYPE);
		media = node.inputs?.[node.inputs.length - 1] || null;
	}
	if (media) {
		media.name = MEDIA_INPUT;
		media.type = MEDIA_INPUT_TYPE;
		media.label = "输入视频/帧队列";
		media.localized_name = media.label;
		media.display_name = media.label;
		media.tooltip = "支持 GJJ_BATCH_IMAGE、IMAGE 批次和官方 VIDEO；连接后优先使用外接输入。";
	}
	ensureOutputSceneWidget(node);
	const audioInput = ensureAudioInput(node);
	const sceneInput = ensureWidgetInput(node);
	removeSelectedVideoInputs(node);
	for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
		const input = node.inputs[index];
		if (input === media || input === sceneInput || input === audioInput) continue;
		if (inputMatchesName(input, OUTPUT_SCENE_WIDGET)) removeInputAt(node, index);
		if (inputMatchesName(input, AUDIO_INPUT)) removeInputAt(node, index);
	}
	const otherInputs = node.inputs.filter((input) => input !== media && input !== sceneInput && input !== audioInput);
	const next = [media, audioInput, sceneInput, ...otherInputs].filter(Boolean);
	if (next.length === node.inputs.length && next.some((input, index) => input !== node.inputs[index])) {
		node.inputs = next;
		repairInputLinkSlots(node);
	}
}

function ensureOutputShape(node) {
	if (!Array.isArray(node?.outputs)) return;
	while (node.outputs.length > OUTPUT_DEFS.length) removeOutputAt(node, node.outputs.length - 1);
	while (node.outputs.length < OUTPUT_DEFS.length) {
		const def = OUTPUT_DEFS[node.outputs.length];
		node.addOutput?.(def.name, def.type);
	}
	node.outputs.forEach((output, index) => {
		const def = OUTPUT_DEFS[index];
		if (!def) return;
		output.name = def.name;
		output.label = def.name;
		output.localized_name = def.name;
		output.type = def.type;
		output.tooltip = def.tooltip;
	});
	globalThis.GJJApplyTypeColorsToNode?.(node);
}

function restorePropertiesToWidgets(node) {
	node.properties ||= {};
	const widget = findWidget(node, OUTPUT_SCENE_WIDGET);
	const value = normalizeSceneIndex(node.properties[OUTPUT_SCENE_WIDGET] ?? widget?.value ?? 1);
	node.properties[OUTPUT_SCENE_WIDGET] = value;
	if (widget) widget.value = value;
	const selectedWidget = findWidget(node, SELECTED_VIDEO_WIDGET);
	const selected = String(node.properties[SELECTED_VIDEO_PROP] ?? selectedWidget?.value ?? "");
	node.properties[SELECTED_VIDEO_PROP] = selected;
	if (selectedWidget) selectedWidget.value = selected;
}

function parseSelectedVideo(rawValue) {
	try {
		const parsed = JSON.parse(String(rawValue || ""));
		const item = Array.isArray(parsed) ? parsed[0] : parsed;
		return item && typeof item === "object" && item.filename ? item : null;
	} catch (_) {
		return null;
	}
}

function selectedVideoFromNode(node, serializedNode = null) {
	const propValue = String(node?.properties?.[SELECTED_VIDEO_PROP] || "");
	if (parseSelectedVideo(propValue)) return propValue;
	const widgetValue = String(findWidget(node, SELECTED_VIDEO_WIDGET)?.value || "");
	if (parseSelectedVideo(widgetValue)) return widgetValue;
	const serializedProp = String(serializedNode?.properties?.[SELECTED_VIDEO_PROP] || "");
	if (parseSelectedVideo(serializedProp)) return serializedProp;
	return propValue || widgetValue || serializedProp || "";
}

function videoLabel(item) {
	if (!item?.filename) return "";
	const subfolder = String(item.subfolder || "");
	return subfolder ? `${subfolder}/${item.filename}` : String(item.filename);
}

function formatMeta(item) {
	const parts = [];
	const width = Number(item?.width || 0);
	const height = Number(item?.height || 0);
	const frames = Number(item?.frames || 0);
	const fps = Number(item?.fps || 0);
	if (width > 0 && height > 0) parts.push(`${width}x${height}`);
	if (frames > 0) parts.push(`${frames} 帧`);
	if (fps > 0) parts.push(`${fps.toFixed(fps >= 10 ? 1 : 2)} FPS`);
	return parts.join(" · ");
}

async function fetchMeta(item) {
	if (!item?.filename) return item;
	try {
		const url = api.apiURL(`${META_API}?filename=${encodeURIComponent(item.filename)}&subfolder=${encodeURIComponent(item.subfolder || "")}`);
		const response = await fetch(url, { cache: "no-store" });
		const data = await response.json().catch(() => ({}));
		if (!response.ok || data?.ok === false) throw new Error(data?.error || "读取视频信息失败");
		return { ...item, ...(data.video || {}) };
	} catch (_) {
		return item;
	}
}

function syncSelectedVideo(node, item) {
	const value = item?.filename ? JSON.stringify(item) : "";
	node.properties ||= {};
	node.properties[SELECTED_VIDEO_PROP] = value;
	setWidgetValue(node, SELECTED_VIDEO_WIDGET, value);
	const state = ensureState(node);
	state.selectedVideo = item?.filename ? item : null;
	state.lastData = null;
	state.refreshing = false;
	state.stopReason = "";
	renderControls(node);
}

async function uploadVideo(node, file) {
	const state = ensureState(node);
	state.uploading = true;
	state.refreshing = false;
	state.lastData = null;
	state.stopReason = "";
	renderControls(node);
	try {
		const formData = new FormData();
		formData.append("video", file, file.name || "video.mp4");
		const response = await fetch(api.apiURL(UPLOAD_API), { method: "POST", body: formData });
		const data = await response.json().catch(() => ({}));
		if (!response.ok || data?.ok === false) throw new Error(data?.error || `上传失败：HTTP ${response.status}`);
		const item = await fetchMeta(data.video || {});
		syncSelectedVideo(node, item);
	} catch (error) {
		state.lastData = null;
		state.stopReason = error?.message || "视频打开失败";
		renderControls(node);
	} finally {
		state.uploading = false;
		renderControls(node);
	}
}

function isAutoEnabled(node) {
	return Boolean(node?.properties?.[AUTO_PROP]);
}

function setAutoEnabled(node, enabled) {
	node.properties ||= {};
	node.properties[AUTO_PROP] = Boolean(enabled);
	if (enabled) activeAutoNodeId = String(node.id);
	else if (activeAutoNodeId === String(node.id)) activeAutoNodeId = null;
	renderControls(node);
	dirty(node);
}

function stopLoop(node) {
	if (autoTimer) {
		clearTimeout(autoTimer);
		autoTimer = null;
	}
	if (node) setAutoEnabled(node, false);
}

function stopAllAutoQueues(reason = "已停止所有 GJJ 自动排队") {
	if (autoTimer) {
		clearTimeout(autoTimer);
		autoTimer = null;
	}
	for (const node of app.graph?._nodes || []) {
		if (node?.comfyClass === NODE_NAME) {
			node.properties ||= {};
			node.properties[AUTO_PROP] = false;
			const state = ensureState(node);
			state.stopReason = reason;
			renderControls(node);
		}
	}
	activeAutoNodeId = null;
}

function registerGlobalStop() {
	const root = globalThis;
	if (!root.GJJ_AutoQueueStopHandlers) root.GJJ_AutoQueueStopHandlers = new Set();
	root.GJJ_AutoQueueStopHandlers.add(stopAllAutoQueues);
	const previous = root.GJJ_StopAllAutoQueues;
	root.GJJ_StopAllAutoQueues = (reason = "已停止所有 GJJ 自动排队") => {
		for (const handler of Array.from(root.GJJ_AutoQueueStopHandlers || [])) {
			try { handler(reason); } catch (error) { console.warn("[GJJ] 停止自动排队失败", error); }
		}
		if (typeof previous === "function" && previous !== root.GJJ_StopAllAutoQueues) {
			try { previous(reason); } catch (_) {}
		}
		return true;
	};
}

function ensureState(node) {
	node.__gjjSmartStoryboardState ||= {
		selectedVideo: parseSelectedVideo(selectedVideoFromNode(node)),
		uploading: false,
		refreshing: false,
		lastData: null,
		stopReason: "",
	};
	return node.__gjjSmartStoryboardState;
}

async function refreshPreview(node) {
	const state = ensureState(node);
	if (state.uploading || state.refreshing) return false;
	const selected = state.selectedVideo || parseSelectedVideo(selectedVideoFromNode(node));
	if (!hasInputLink(node, MEDIA_INPUT) && !selected) {
		state.stopReason = "请先点击 📁 打开视频，或连接外接视频/帧队列。";
		renderControls(node);
		return false;
	}
	stopLoop(node);
	state.refreshing = true;
	state.lastData = null;
	state.stopReason = "";
	renderControls(node);
	try {
		const ok = await queueOnlyCurrentNode(node);
		if (!ok) throw new Error("预览队列启动失败");
		state.stopReason = "正在执行当前节点，完成后显示分镜首帧。";
		renderControls(node);
		return true;
	} catch (error) {
		state.refreshing = false;
		state.stopReason = error?.message || "预览生成失败";
		renderControls(node);
		return false;
	}
}

function ensureStyles(root) {
	if (root.__gjjSmartStoryboardStyles) return;
	root.__gjjSmartStoryboardStyles = true;
	const style = document.createElement("style");
	style.textContent = `
		.gjj-smart-storyboard{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:5px;padding:1px 2px 0;color:#dce7e2;font:12px/1.35 sans-serif}
		.gjj-smart-storyboard .toolbar{display:flex;gap:5px;align-items:center;min-width:0}
		.gjj-smart-storyboard button{height:26px;min-width:54px;background:#1b252b;border:1px solid #40535d;border-radius:5px;color:#f2fbff;padding:2px 7px;font:700 12px sans-serif;cursor:pointer;white-space:nowrap}
		.gjj-smart-storyboard button.icon{width:30px;min-width:30px;padding:2px 0;font-size:14px}
		.gjj-smart-storyboard button:disabled{opacity:.55;cursor:default}
		.gjj-smart-storyboard button.on{background:#1f6b43;border-color:#4db376;color:#fff;box-shadow:0 0 0 1px rgba(77,179,118,.28) inset}
		.gjj-smart-storyboard .summary{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b9c8ce;background:rgba(0,0,0,.24);border:1px solid rgba(255,255,255,.06);border-radius:5px;padding:4px 7px}
		.gjj-smart-storyboard .status{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8fa7b1;font-size:11px;padding:0 2px}
		.gjj-smart-storyboard .thumbs{display:none;flex-wrap:wrap;gap:${THUMB_GAP}px;width:100%;align-items:flex-start}
		.gjj-smart-storyboard .tile{position:relative;width:${THUMB_W}px;height:${THUMB_H}px;border:1px solid #32454d;border-radius:5px;overflow:hidden;background:#071014;cursor:pointer;padding:0}
		.gjj-smart-storyboard .tile.active{border-color:#86f5ad;box-shadow:0 0 0 2px rgba(134,245,173,.68),0 0 12px rgba(90,220,135,.35)}
		.gjj-smart-storyboard .tile img{display:block;width:100%;height:100%;object-fit:cover}
		.gjj-smart-storyboard .tile span{position:absolute;left:4px;top:4px;min-width:17px;height:17px;border-radius:5px;background:rgba(0,0,0,.62);color:#fff;font:700 11px/17px sans-serif;text-align:center;padding:0 4px;pointer-events:none}
		.gjj-smart-storyboard .tile.active span{background:rgba(31,137,78,.9)}
	`;
	root.appendChild(style);
}

function makeButton(text, title) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = text;
	button.title = title;
	return button;
}

function buildControls(node) {
	const container = document.createElement("div");
	container.className = "gjj-smart-storyboard";
	ensureStyles(container);

	const toolbar = document.createElement("div");
	toolbar.className = "toolbar";
	const browseButton = makeButton("📁", "打开视频：选择一个视频并写入本节点。外接输入连接时仍优先使用外接输入。");
	browseButton.className = "icon";
	const refreshButton = makeButton("🔄", "生成预览：只执行当前节点，并刷新每个分镜首帧。");
	refreshButton.className = "icon";
	const resetButton = makeButton("初始化", "把输出分镜重置为 1，并停止自动队列。");
	const autoButton = makeButton("自动队列", "未连接外部输出分镜时，从当前分镜开始执行，并自动排队到最后一段。");
	const summary = document.createElement("div");
	summary.className = "summary";
	const status = document.createElement("div");
	status.className = "status";
	const thumbs = document.createElement("div");
	thumbs.className = "thumbs";
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "video/*,.mp4,.mov,.m4v,.webm,.avi,.mkv,.wmv,.flv,.mpeg,.mpg,.gif";
	input.style.display = "none";

	for (const eventName of ["mousedown", "pointerdown", "click", "dblclick", "wheel"]) {
		container.addEventListener(eventName, (event) => event.stopPropagation());
	}

	browseButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		input.click();
	});
	refreshButton.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		await refreshPreview(node);
	});
	resetButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		stopLoop(node);
		setWidgetValue(node, OUTPUT_SCENE_WIDGET, 1);
	});

	autoButton.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (hasInputLink(node, OUTPUT_SCENE_WIDGET)) {
			stopLoop(node);
			return;
		}
		if (isAutoEnabled(node)) {
			stopLoop(node);
			return;
		}
		setAutoEnabled(node, true);
		try {
			await app.queuePrompt(0);
		} catch (_) {
			stopLoop(node);
		}
	});
	input.addEventListener("click", (event) => event.stopPropagation());
	input.addEventListener("change", async (event) => {
		event.stopPropagation();
		const file = Array.from(event.target?.files || [])[0];
		input.value = "";
		if (file) await uploadVideo(node, file);
	});

	toolbar.append(browseButton, refreshButton, resetButton, autoButton, summary);
	container.append(toolbar, status, input, thumbs);
	node.__gjjSmartStoryboardElements = { container, browseButton, refreshButton, resetButton, autoButton, summary, status, input, thumbs };
	return container;
}

function previewHeight(node) {
	const state = ensureState(node);
	const scenes = Array.isArray(state.lastData?.scenes) ? state.lastData.scenes : [];
	if (!scenes.length) return 0;
	const width = Math.max(1, Math.round(Number(node.size?.[0] || 260) - 12));
	const cols = Math.max(1, Math.floor((width + THUMB_GAP) / (THUMB_W + THUMB_GAP)));
	const rows = Math.ceil(scenes.length / cols);
	return rows * THUMB_H + Math.max(0, rows - 1) * THUMB_GAP;
}

function panelHeight(node) {
	const preview = previewHeight(node);
	return TOOLBAR_HEIGHT + (preview > 0 ? preview + 4 : 0);
}

function scheduleNodeResize(node) {
	if (!node) return;
	cancelAnimationFrame(node.__gjjSmartStoryboardResizeFrame);
	node.__gjjSmartStoryboardResizeFrame = requestAnimationFrame(() => {
		const width = Math.round(Number(node.size?.[0] || 260));
		const computed = node.computeSize?.();
		const height = Math.round(Number(computed?.[1] || node.size?.[1] || panelHeight(node) + 80));
		node.setSize?.([width, height]);
		node.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	});
}

function sceneTitle(scene) {
	const index = Number(scene?.index || 0);
	const start = Number(scene?.start_frame || 0);
	const end = Number(scene?.end_frame || 0);
	const length = Number(scene?.length || 0);
	return `分镜 ${index} · 帧 ${start}-${end} · ${length} 帧`;
}

function renderThumbnails(node, data) {
	const elements = node.__gjjSmartStoryboardElements;
	if (!elements?.thumbs) return;
	const scenes = Array.isArray(data?.scenes) ? data.scenes : [];
	if (!scenes.length) {
		elements.thumbs.replaceChildren();
		elements.thumbs.style.display = "none";
		scheduleNodeResize(node);
		return;
	}
	const current = currentOutputScene(node, data);
	const fragment = document.createDocumentFragment();
	for (const scene of scenes) {
		if (!scene?.thumb) continue;
		const tile = document.createElement("button");
		tile.type = "button";
		tile.className = "tile";
		tile.classList.toggle("active", Number(scene.index) === current);
		tile.setAttribute("aria-pressed", Number(scene.index) === current ? "true" : "false");
		tile.title = sceneTitle(scene);
		const img = document.createElement("img");
		img.src = scene.thumb;
		img.alt = `分镜 ${scene.index}`;
		const badge = document.createElement("span");
		badge.textContent = String(scene.index || "");
		tile.append(img, badge);
		tile.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setWidgetValue(node, OUTPUT_SCENE_WIDGET, scene.index);
			renderControls(node);
		});
		fragment.appendChild(tile);
	}
	elements.thumbs.replaceChildren(fragment);
	elements.thumbs.style.display = elements.thumbs.childElementCount ? "flex" : "none";
	scheduleNodeResize(node);
}

function renderControls(node) {
	const state = ensureState(node);
	const elements = node.__gjjSmartStoryboardElements;
	if (!elements) return;
	const selected = state.selectedVideo || parseSelectedVideo(selectedVideoFromNode(node));
	state.selectedVideo = selected;
	const externalMedia = hasInputLink(node, MEDIA_INPUT);
	const externalScene = hasInputLink(node, OUTPUT_SCENE_WIDGET);
	const auto = isAutoEnabled(node) && !externalScene;
	const data = state.lastData || {};

	elements.browseButton.disabled = state.uploading || state.refreshing;
	elements.browseButton.textContent = state.uploading ? "..." : "📁";
	if (elements.refreshButton) {
		const canRefresh = !state.uploading && !state.refreshing && (externalMedia || selected);
		elements.refreshButton.disabled = !canRefresh;
		elements.refreshButton.textContent = state.refreshing ? "..." : "🔄";
		elements.refreshButton.title = state.refreshing
			? "正在生成预览。"
			: (canRefresh ? "生成预览：只执行当前节点，并刷新每个分镜首帧。" : "请先打开视频，或连接外接视频/帧队列。");
	}
	elements.autoButton.classList.toggle("on", auto);
	elements.autoButton.textContent = externalScene ? "外部控制" : (auto ? "停止" : "自动队列");
	elements.autoButton.title = externalScene
		? "输出分镜已连接外部输入，自动队列不可用。"
		: (auto ? "停止自动队列。" : "从当前输出分镜开始，自动排队到最后一段。");
	elements.autoButton.style.opacity = externalScene ? "0.72" : "1";

	if (state.refreshing) {
		if (data.total_scenes) {
			elements.summary.textContent = `${data.source || "输入"} · 正在更新预览`;
		} else if (externalMedia) {
			elements.summary.textContent = "正在生成预览...";
		} else if (selected) {
			const meta = formatMeta(selected);
			elements.summary.textContent = meta ? `${videoLabel(selected)} · ${meta}` : videoLabel(selected);
		} else {
			elements.summary.textContent = "等待输入";
		}
		elements.status.textContent = state.stopReason || "正在执行当前节点，完成后显示分镜首帧。";
	} else if (data.total_scenes) {
		const mode = data.output_as_video ? (data.has_audio ? "VIDEO+音频" : "VIDEO") : "帧批次";
		elements.summary.textContent = `${data.source || "输入"} · ${currentOutputScene(node, data)}/${data.total_scenes} · ${mode}`;
		elements.status.textContent = data.status || data.range_text || "";
	} else if (externalMedia) {
		elements.summary.textContent = "外接输入优先";
		elements.status.textContent = "执行后显示分镜首帧。";
	} else if (state.uploading) {
		elements.summary.textContent = "正在打开视频...";
		elements.status.textContent = "视频会保存到 ComfyUI input 目录。";
	} else if (selected) {
		const meta = formatMeta(selected);
		elements.summary.textContent = meta ? `${videoLabel(selected)} · ${meta}` : videoLabel(selected);
		elements.status.textContent = state.stopReason || "执行后显示分镜首帧。";
	} else {
		elements.summary.textContent = "点击 📁 打开视频，或连接外接视频/帧队列";
		elements.status.textContent = state.stopReason || "外接输入连接时会优先使用外接输入。";
	}
	renderThumbnails(node, data);
}

function ensureDomWidget(node) {
	if (node.__gjjSmartStoryboardWidget) {
		renderControls(node);
		return;
	}
	const container = buildControls(node);
	const widget = node.addDOMWidget(DOM_WIDGET, "HTML", container, { serialize: false, hideOnZoom: false });
	widget.computeSize = (width) => [Math.round(Number(width || node.size?.[0] || 260)), panelHeight(node)];
	widget.getHeight = () => panelHeight(node);
	widget.draw = () => {};
	node.__gjjSmartStoryboardWidget = widget;
	reorderWidgets(node);
	renderControls(node);
}

function reorderWidgets(node) {
	if (!Array.isArray(node?.widgets)) return;
	const priority = (widget) => {
		const name = String(widget?.name || "");
		if (name === DOM_WIDGET) return 10;
		if (name === OUTPUT_SCENE_WIDGET) return 20;
		if (name === SELECTED_VIDEO_WIDGET) return 90;
		return 50;
	};
	node.widgets = node.widgets
		.map((widget, index) => ({ widget, index }))
		.sort((a, b) => priority(a.widget) - priority(b.widget) || a.index - b.index)
		.map((entry) => entry.widget);
}

function stabilizeNode(node) {
	if (!node || node.comfyClass !== NODE_NAME) return;
	restorePropertiesToWidgets(node);
	hideWidget(findWidget(node, SELECTED_VIDEO_WIDGET));
	ensureInputShape(node);
	ensureOutputShape(node);
	ensureDomWidget(node);
	reorderWidgets(node);
	if (hasInputLink(node, OUTPUT_SCENE_WIDGET) && isAutoEnabled(node)) stopLoop(node);
	renderControls(node);
	dirty(node);
}

function scheduleStabilize(node, ms = 32) {
	if (!node || node.comfyClass !== NODE_NAME) return;
	clearTimeout(node.__gjjSmartStoryboardTimer);
	node.__gjjSmartStoryboardTimer = setTimeout(() => stabilizeNode(node), ms);
}

function queueNext(node, data) {
	if (!node || !isAutoEnabled(node) || hasInputLink(node, OUTPUT_SCENE_WIDGET) || data?.external_controlled) {
		if (node) stopLoop(node);
		return;
	}
	const total = Number(data?.total_scenes || 0);
	const current = Number(data?.current_scene || findWidget(node, OUTPUT_SCENE_WIDGET)?.value || 1);
	if (!Number.isFinite(total) || total <= 0 || current >= total) {
		stopLoop(node);
		return;
	}
	setWidgetValue(node, OUTPUT_SCENE_WIDGET, current + 1);
	autoTimer = setTimeout(async () => {
		autoTimer = null;
		if (!isAutoEnabled(node) || hasInputLink(node, OUTPUT_SCENE_WIDGET)) {
			stopLoop(node);
			return;
		}
		try {
			await app.queuePrompt(0);
		} catch (_) {
			stopLoop(node);
		}
	}, QUEUE_DELAY_MS);
}

function activeAutoNode() {
	if (!activeAutoNodeId) return null;
	return app.graph?.getNodeById?.(Number(activeAutoNodeId)) || app.graph?._nodes_by_id?.[activeAutoNodeId] || null;
}

function clearRefreshingNodes(reason = "") {
	for (const node of app.graph?._nodes || []) {
		if (node?.comfyClass !== NODE_NAME) continue;
		const state = ensureState(node);
		if (!state.refreshing) continue;
		state.refreshing = false;
		if (reason) state.stopReason = reason;
		renderControls(node);
	}
}

api.addEventListener("execution_error", () => {
	const node = activeAutoNode();
	if (node) stopLoop(node);
	clearRefreshingNodes("预览生成失败。");
});

api.addEventListener("execution_interrupted", () => {
	const node = activeAutoNode();
	if (node) stopLoop(node);
	clearRefreshingNodes("预览已中断。");
});

api.addEventListener("execution_success", () => {
	clearRefreshingNodes();
	const node = activeAutoNode();
	if (!node || node.comfyClass !== NODE_NAME) return;
	setTimeout(() => {
		const data = ensureState(node).lastData;
		if (data) queueNext(node, data);
	}, 0);
});

app.registerExtension({
	name: "GJJ.VideoSmartStoryboard",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			scheduleStabilize(this, 0);
			setTimeout(() => stabilizeNode(this), 80);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			this.properties ||= {};
			Object.assign(this.properties, args[0]?.properties || {});
			restorePropertiesToWidgets(this);
			const state = ensureState(this);
			state.selectedVideo = parseSelectedVideo(selectedVideoFromNode(this, args[0]));
			if (state.selectedVideo) syncSelectedVideo(this, state.selectedVideo);
			scheduleStabilize(this, 0);
			setTimeout(() => stabilizeNode(this), 80);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			this.properties ||= {};
			const selected = selectedVideoFromNode(this);
			this.properties[SELECTED_VIDEO_PROP] = selected;
			const widget = findWidget(this, OUTPUT_SCENE_WIDGET);
			if (widget) this.properties[OUTPUT_SCENE_WIDGET] = normalizeSceneIndex(widget.value);
			const selectedWidget = findWidget(this, SELECTED_VIDEO_WIDGET);
			if (selectedWidget) selectedWidget.value = selected;
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			if (serializedNode) {
				serializedNode.properties ||= {};
				Object.assign(serializedNode.properties, this.properties);
				serializedNode.properties[AUTO_PROP] = Boolean(this.properties[AUTO_PROP]);
				serializedNode.properties[SELECTED_VIDEO_PROP] = selected;
			}
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			const data = Array.isArray(message?.[UI_KEY]) ? message[UI_KEY][0] : null;
			const state = ensureState(this);
			state.refreshing = false;
			if (data) {
				state.lastData = data;
				state.stopReason = "";
				if (hasInputLink(this, OUTPUT_SCENE_WIDGET)) {
					setWidgetValue(this, OUTPUT_SCENE_WIDGET, Math.max(1, Number(data.current_scene || 1)));
					stopLoop(this);
				}
			}
			renderControls(this);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			if (hasInputLink(this, OUTPUT_SCENE_WIDGET)) stopLoop(this);
			scheduleStabilize(this);
			setTimeout(() => stabilizeNode(this), 80);
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (size, ...args) {
			const result = originalOnResize?.apply(this, [size, ...args]);
			const width = Math.round(Number(size?.[0] || this.size?.[0] || 0));
			if (width > 0 && width !== this.__gjjSmartStoryboardLastWidth) {
				this.__gjjSmartStoryboardLastWidth = width;
				scheduleNodeResize(this);
			}
			return result;
		};
	},
	setup() {
		registerGlobalStop();
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === NODE_NAME) scheduleStabilize(node, 0);
		}
	},
});
