import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const NODE_CLASS = "GJJ_Mesh2MotionExplore";
const ROUTE_BASE = "/gjj/mesh2motion";
const POST_MESSAGE_ORIGIN = window.location.origin;
const VIEW_WIDGET = "gjj_mesh2motion_view";
const INTERNAL_WIDGETS = ["image", "video_frames"];
const DEFAULT_RECORDING_PRESET = {
	file: "basic-moves/pan_180_degree.json",
	id: "pan_180_degree",
	label: "180 Degree Pan",
};
const MIN_NODE_WIDTH = 920;
const MIN_PANEL_HEIGHT = 700;
const MIN_NODE_HEIGHT = 940;
const MIN_WIDGET_HEIGHT = 660;
const BOOLEAN_WIDGETS = [
	["show_skeleton", "🦴 显示骨骼", "开启后在 3D 面板中显示角色骨骼辅助线。"],
	["mirror_animations", "🪞 镜像动画", "开启后把当前动画左右镜像显示和输出。"],
	["preview_output", "📐 显示输出取景框", "在 3D 面板中显示最终输出比例的取景提示。"],
	["checker_room", "🏁 棋盘格背景", "开启后在 3D 面板中显示棋盘格背景，便于观察透明区域。"],
];
const SLIDER_WIDGETS = [
	["width", "📏 输出宽度", 128, 4096, 64],
	["height", "📏 输出高度", 128, 4096, 64],
	["fps", "🎞️ 视频帧率", 1, 120, 1],
];
const STATE_KEYS = {
	show_skeleton: "mesh2motion_show_skeleton",
	mirror_animations: "mesh2motion_mirror_animations",
	preview_output: "mesh2motion_preview_output",
	checker_room: "mesh2motion_checker_room",
	width: "mesh2motion_width",
	height: "mesh2motion_height",
	fps: "mesh2motion_fps",
};
const CONTROL_WIDGET_NAMES = ["show_skeleton", "mirror_animations", "preview_output", "checker_room", "width", "height", "fps"];
const HIDDEN_WIDGET_NAMES = new Set([...CONTROL_WIDGET_NAMES, ...INTERNAL_WIDGETS]);
const DEFAULT_STATE = {
	show_skeleton: false,
	mirror_animations: false,
	preview_output: false,
	checker_room: false,
	width: 1024,
	height: 1024,
	fps: 24,
};

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function hideWidget(node, widget) {
	if (!widget) {
		return;
	}
	if (widget.__gjjMesh2MotionHidden) {
		return;
	}
	widget.__gjjMesh2MotionHidden = true;
	widget.hidden = true;
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.serialize = false;
	widget.serializeValue = () => undefined;
	if (widget.options) {
		widget.options.serialize = false;
	}
	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.mouse = () => false;
	widget.y = 0;
	widget.last_y = 0;
	widget.label = "";
	widget.localized_name = "";
	widget.tooltip = "";
	widget.options = widget.options || {};
	widget.options.tooltip = "";
	widget.disabled = true;
	if (widget.element) {
		widget.element.style.display = "none";
		widget.element.style.height = "0px";
		widget.element.style.minHeight = "0px";
		widget.element.style.margin = "0";
		widget.element.style.padding = "0";
	}
	if (widget.inputEl) {
		widget.inputEl.style.display = "none";
		widget.inputEl.style.height = "0px";
		widget.inputEl.style.minHeight = "0px";
		widget.inputEl.style.margin = "0";
		widget.inputEl.style.padding = "0";
	}
}

function getState(node, name) {
	const key = STATE_KEYS[name];
	const props = node?.properties || {};
	if (key in props) {
		return props[key];
	}
	return DEFAULT_STATE[name];
}

function setState(node, name, value) {
	const key = STATE_KEYS[name];
	node.properties = node.properties || {};
	node.properties[key] = value;
}

function hideNativeControls(node) {
	for (const name of CONTROL_WIDGET_NAMES) {
		const widget = getWidget(node, name);
		if (widget) {
			hideWidget(node, widget);
		}
	}
}

function compactMesh2MotionNode(node) {
	if (!node) {
		return;
	}
	hideNativeControls(node);
	node.properties = node.properties || {};
	for (const name of CONTROL_WIDGET_NAMES) {
		const widget = getWidget(node, name);
		if (widget && !(STATE_KEYS[name] in node.properties)) {
			setState(node, name, widget.value);
		}
	}
	for (const name of INTERNAL_WIDGETS) {
		const widget = getWidget(node, name);
		const key = `mesh2motion_${name}`;
		if (widget && !(key in node.properties) && widget.value) {
			node.properties[key] = widget.value;
		}
	}
	GJJ_Utils.removeHiddenInputSockets(node, HIDDEN_WIDGET_NAMES);
	if (Array.isArray(node.widgets)) {
		node.widgets = node.widgets.filter((widget) => !HIDDEN_WIDGET_NAMES.has(String(widget?.name || "")));
	}
	if (Array.isArray(node.widgets_values)) {
		node.widgets_values.length = 0;
	} else {
		node.widgets_values = [];
	}
	GJJ_Utils.reorderWidgets(node, HIDDEN_WIDGET_NAMES);
	refreshNode(node);
}

function setButtonActive(button, active) {
	button.dataset.active = active ? "1" : "0";
	button.style.background = active ? "#4a9eff" : "#22323a";
	button.style.borderColor = active ? "#7bb7ff" : "#40555f";
	button.style.color = active ? "#ffffff" : "#d9e7df";
}

function toggleBooleanState(node, stateName, button) {
	const value = !getState(node, stateName);
	setState(node, stateName, value);
	setButtonActive(button, value);
	if (stateName === "mirror_animations" || stateName === "checker_room") {
		node._gjjMesh2MotionVideoSig = null;
	}
	if (stateName === "preview_output" || stateName === "width" || stateName === "height" || stateName === "fps") {
		sendPreviewState(node);
		node._gjjMesh2MotionVideoSig = null;
	}
	if (stateName === "show_skeleton" || stateName === "mirror_animations" || stateName === "checker_room") {
		postToIframe(node, `mesh2motion:set${stateName === "show_skeleton" ? "ShowSkeleton" : stateName === "mirror_animations" ? "MirrorAnimations" : "CheckerRoom"}`, { value });
	}
	refreshNode(node);
}

function updateSliderState(node, stateName, valueEl, rangeEl) {
	const current = Number(rangeEl.value);
	setState(node, stateName, current);
	valueEl.textContent = String(current);
	if (stateName === "width" || stateName === "height" || stateName === "fps" || stateName === "preview_output") {
		sendPreviewState(node);
		node._gjjMesh2MotionVideoSig = null;
	}
	node._gjjMesh2MotionVideoSig = null;
	refreshNode(node);
}

function createSliderControls(node, container) {
	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:grid",
		"grid-template-columns:repeat(3, minmax(0, 1fr))",
		"gap:8px",
		"padding:0 8px 6px",
	].join(";");

	for (const [stateName, label, min, max, step] of SLIDER_WIDGETS) {
		const box = document.createElement("div");
		box.style.cssText = [
			"display:flex",
			"flex-direction:column",
			"gap:4px",
			"padding:6px 8px",
			"border:1px solid #314147",
			"border-radius:8px",
			"background:#182228",
			"box-sizing:border-box",
			"min-width:0",
		].join(";");

		const top = document.createElement("div");
		top.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;font:700 12px/1.1 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;color:#d9e7df;";

		const title = document.createElement("span");
		title.textContent = label;

		const value = document.createElement("span");
		value.style.cssText = "min-width:44px;text-align:right;color:#8fd0ff;";
		value.textContent = String(Number(getState(node, stateName) ?? min));

		top.appendChild(title);
		top.appendChild(value);

		const range = document.createElement("input");
		range.type = "range";
		range.min = String(min);
		range.max = String(max);
		range.step = String(step);
		range.value = String(Number(getState(node, stateName) ?? min));
		range.style.cssText = "width:100%;margin:0;";
		range.addEventListener("input", () => updateSliderState(node, stateName, value, range));

		box.appendChild(top);
		box.appendChild(range);
		wrap.appendChild(box);
	}

	container.appendChild(wrap);
}

function createBooleanControls(node, container) {
	const wrap = document.createElement("div");
	wrap.style.cssText = [
		"display:grid",
		"grid-template-columns:repeat(4, minmax(0, 1fr))",
		"gap:6px",
		"padding:8px 8px 4px",
	].join(";");

	for (const [stateName, label, tooltip] of BOOLEAN_WIDGETS) {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = label;
			button.setAttribute("aria-label", tooltip);
			button.style.cssText = [
			"height:30px",
			"padding:0 10px",
			"border:1px solid #40555f",
			"border-radius:8px",
			"font:700 12px/1.1 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
			"cursor:pointer",
			"white-space:nowrap",
			"overflow:hidden",
			"text-overflow:ellipsis",
		].join(";");
		setButtonActive(button, !!getState(node, stateName));
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			toggleBooleanState(node, stateName, button);
		});
		wrap.appendChild(button);
	}

	container.appendChild(wrap);
}

function setStatus(node, text, tone = "idle") {
	const status = node?.__gjjMesh2MotionStatus;
	if (!status) {
		return;
	}
	status.textContent = text;
	status.dataset.tone = tone;
}

function postToIframe(node, type, data = {}) {
	const iframe = node?._gjjMesh2MotionIframe;
	if (!iframe?.contentWindow || !node?._gjjMesh2MotionReady) {
		return;
	}
	iframe.contentWindow.postMessage({ type, data }, POST_MESSAGE_ORIGIN);
}

function captureFromIframe(iframe) {
	return new Promise((resolve, reject) => {
		if (!iframe?.contentWindow) {
			reject(new Error("Mesh2Motion 面板尚未加载完成"));
			return;
		}
		const timeout = setTimeout(() => {
			window.removeEventListener("message", handler);
			reject(new Error("截图捕获超时"));
		}, 15000);
		const handler = (event) => {
			if (event.origin !== POST_MESSAGE_ORIGIN || event.source !== iframe.contentWindow) {
				return;
			}
			if (event.data?.type === "mesh2motion:captureResult") {
				clearTimeout(timeout);
				window.removeEventListener("message", handler);
				resolve(event.data.data);
			}
		};
		window.addEventListener("message", handler);
		iframe.contentWindow.postMessage({ type: "mesh2motion:capture" }, POST_MESSAGE_ORIGIN);
	});
}

function captureVideoFromIframe(iframe, presetName, width, height) {
	return new Promise((resolve, reject) => {
		if (!iframe?.contentWindow) {
			reject(new Error("Mesh2Motion 面板尚未加载完成"));
			return;
		}
		const timeout = setTimeout(() => {
			window.removeEventListener("message", handler);
			reject(new Error("视频捕获超时"));
		}, 120000);
		const handler = (event) => {
			if (event.origin !== POST_MESSAGE_ORIGIN || event.source !== iframe.contentWindow) {
				return;
			}
			if (event.data?.type === "mesh2motion:captureVideoResult") {
				clearTimeout(timeout);
				window.removeEventListener("message", handler);
				const result = event.data.data || {};
				if (result.error) {
					reject(new Error(result.error));
					return;
				}
				resolve({ videoPath: result.videoPath, fps: result.fps });
			}
		};
		window.addEventListener("message", handler);
		iframe.contentWindow.postMessage({
			type: "mesh2motion:captureVideoFrames",
			data: { presetName, width, height },
		}, POST_MESSAGE_ORIGIN);
	});
}

function presetIdFromFile(presetFile) {
	const fileName = String(presetFile || "").split("/").pop() || "";
	return fileName.replace(/\.json$/i, "");
}

function parseAnnotatedUploadPath(value, fallbackType = "temp") {
	const raw = String(value || "").trim();
	const match = raw.match(/\s*\[(input|output|temp)\]\s*$/i);
	const type = match?.[1]?.toLowerCase() || fallbackType;
	const clean = raw.replace(/\s*\[(?:input|output|temp)\]\s*$/i, "").trim().replace(/\\/g, "/");
	const parts = clean.split("/").filter(Boolean);
	const name = parts.pop() || clean;
	return {
		name,
		subfolder: parts.join("/"),
		type,
		raw,
	};
}

function waitForCameraPreset(node, presetFile, timeoutMs = 2500) {
	return new Promise((resolve) => {
		const iframe = node?._gjjMesh2MotionIframe;
		if (!iframe?.contentWindow) {
			resolve(false);
			return;
		}
		const wanted = String(presetFile || "");
		const timeout = setTimeout(() => {
			window.removeEventListener("message", handler);
			resolve(false);
		}, timeoutMs);
		const handler = (event) => {
			if (event.origin !== POST_MESSAGE_ORIGIN || event.source !== iframe.contentWindow) {
				return;
			}
			if (event.data?.type === "mesh2motion:cameraPresetChanged" && event.data?.data?.value === wanted) {
				clearTimeout(timeout);
				window.removeEventListener("message", handler);
				resolve(true);
			}
		};
		window.addEventListener("message", handler);
		iframe.contentWindow.postMessage({
			type: "mesh2motion:restoreCameraPreset",
			data: { value: wanted },
		}, POST_MESSAGE_ORIGIN);
	});
}

async function ensureRecordingPreset(node) {
	const current = node?.properties?.mesh2motion_camera_preset;
	if (current && current !== "__free__") {
		return { file: current, id: presetIdFromFile(current) };
	}
	setStatus(node, `未选择相机预设，使用默认 ${DEFAULT_RECORDING_PRESET.label} 录制...`, "busy");
	node.properties = node.properties || {};
	node.properties.mesh2motion_camera_preset = DEFAULT_RECORDING_PRESET.file;
	await waitForCameraPreset(node, DEFAULT_RECORDING_PRESET.file);
	return { file: DEFAULT_RECORDING_PRESET.file, id: DEFAULT_RECORDING_PRESET.id };
}

async function syncCaptureStateToBackend(node, state) {
	const response = await api.fetchApi(`${ROUTE_BASE}/capture-state`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			node_id: String(node?.id ?? ""),
			state,
		}),
	});
	if (!response.ok) {
		throw new Error(`保存 Mesh2Motion 捕获状态失败：${response.status}`);
	}
}

async function uploadTempImage(dataUrl) {
	const blob = await fetch(dataUrl).then((response) => response.blob());
	const file = new File([blob], `gjj_mesh2motion_${Date.now()}.png`, { type: "image/png" });
	const body = new FormData();
	body.append("image", file);
	body.append("subfolder", "mesh2motion");
	body.append("type", "input");
	body.append("overwrite", "true");
	const response = await api.fetchApi("/upload/image", { method: "POST", body });
	if (!response.ok) {
		throw new Error(`上传截图失败：${response.status}`);
	}
	const result = await response.json();
	return { name: result.name, subfolder: "mesh2motion", type: "input" };
}

function sendBooleanStates(node) {
	const mappings = [
		["show_skeleton", "mesh2motion:setShowSkeleton"],
		["mirror_animations", "mesh2motion:setMirrorAnimations"],
		["checker_room", "mesh2motion:setCheckerRoom"],
	];
	for (const [stateName, messageType] of mappings) {
		postToIframe(node, messageType, { value: !!getState(node, stateName) });
	}
}

function sendPreviewState(node) {
	postToIframe(node, "mesh2motion:setPreviewOverlay", {
		active: !!getState(node, "preview_output"),
		width: Number(getState(node, "width")) || 1024,
		height: Number(getState(node, "height")) || 1024,
	});
}

function restoreIframeState(node) {
	const iframe = node?._gjjMesh2MotionIframe;
	if (!iframe?.contentWindow) {
		return;
	}
	const props = node.properties || {};
	const restoreMessages = [
		["mesh2motion_skeleton", "mesh2motion:restoreSkeleton", "value"],
		["mesh2motion_camera_preset", "mesh2motion:restoreCameraPreset", "value"],
		["mesh2motion_timeline_zoom", "mesh2motion:restoreTimelineZoom", "value"],
		["mesh2motion_preset_tuning", "mesh2motion:restorePresetTuning", "map"],
		["mesh2motion_panel_state", "mesh2motion:restorePanelState", "state"],
	];
	for (const [propName, messageType, dataKey] of restoreMessages) {
		if (propName in props) {
			iframe.contentWindow.postMessage({
				type: messageType,
				data: { [dataKey]: props[propName] },
			}, POST_MESSAGE_ORIGIN);
		}
	}
	if (props.mesh2motion_timeline) {
		node._gjjMesh2MotionPendingTimeline = props.mesh2motion_timeline;
	}
	sendBooleanStates(node);
	sendPreviewState(node);
}

function handleIframeMessage(node, iframe, event) {
	if (event.origin !== POST_MESSAGE_ORIGIN || event.source !== iframe.contentWindow) {
		return;
	}
	const data = event.data?.data;
	switch (event.data?.type) {
		case "mesh2motion:ready":
			node._gjjMesh2MotionReady = true;
			setStatus(node, "Mesh2Motion 已就绪", "ok");
			restoreIframeState(node);
			break;
		case "mesh2motion:animationsReady":
			if (node._gjjMesh2MotionPendingTimeline) {
				iframe.contentWindow?.postMessage({
					type: "mesh2motion:restoreTimeline",
					data: node._gjjMesh2MotionPendingTimeline,
				}, POST_MESSAGE_ORIGIN);
				node._gjjMesh2MotionPendingTimeline = null;
			}
			break;
		case "mesh2motion:timelineState":
			if (data) {
				node.properties = node.properties || {};
				node.properties.mesh2motion_timeline = data;
			}
			break;
		case "mesh2motion:skeletonChanged":
			if (data?.value) {
				node.properties = node.properties || {};
				node.properties.mesh2motion_skeleton = data.value;
			}
			break;
		case "mesh2motion:cameraPresetChanged":
			if (data && "value" in data) {
				node.properties = node.properties || {};
				node.properties.mesh2motion_camera_preset = data.value;
				node._gjjMesh2MotionVideoSig = null;
				node._gjjMesh2MotionVideoSerialized = "";
			}
			break;
		case "mesh2motion:timelineZoomChanged":
			if (typeof data?.value === "number") {
				node.properties = node.properties || {};
				node.properties.mesh2motion_timeline_zoom = data.value;
			}
			break;
		case "mesh2motion:presetTuningChanged":
			if (data?.map) {
				node.properties = node.properties || {};
				node.properties.mesh2motion_preset_tuning = data.map;
				node._gjjMesh2MotionVideoSig = null;
				node._gjjMesh2MotionVideoSerialized = "";
			}
			break;
		case "mesh2motion:panelStateChanged":
			if (data?.state) {
				node.properties = node.properties || {};
				node.properties.mesh2motion_panel_state = data.state;
			}
			break;
		case "mesh2motion:error":
			setStatus(node, `Mesh2Motion 错误：${data?.message || "未知错误"}`, "error");
			break;
		default:
			break;
	}
}

function hookLiveControls(node) {
	return;
}

function computeVideoSignature(node) {
	const presetFile = node.properties?.mesh2motion_camera_preset || DEFAULT_RECORDING_PRESET.file;
	const tuningMap = node.properties?.mesh2motion_preset_tuning;
	return JSON.stringify({
		presetFile,
		skeleton: node.properties?.mesh2motion_skeleton ?? null,
		timeline: node.properties?.mesh2motion_timeline ?? null,
		tuning: tuningMap?.[presetFile] ?? null,
		width: Number(getState(node, "width")) || 1024,
		height: Number(getState(node, "height")) || 1024,
		fps: Number(getState(node, "fps")) || 24,
		showSkeleton: !!getState(node, "show_skeleton"),
		mirror: !!getState(node, "mirror_animations"),
		checkerRoom: !!getState(node, "checker_room"),
	});
}

function hookSerialization(node) {
	// 不再依赖 hidden widget 的 serializeValue，改为在执行前捕获数据。
	const captureData = async () => {
		let captureState = null;
		try {
			console.log("[GJJ Mesh2Motion] ⚡ 开始捕获数据...");
			captureState = {
				image: null,
				video: null,
				signature: computeVideoSignature(node),
			};
			
			// 捕获截图
			setStatus(node, "正在捕获截图...", "busy");
			const dataUrl = await captureFromIframe(node._gjjMesh2MotionIframe);
			console.log("[GJJ Mesh2Motion] 截图 dataUrl 长度:", dataUrl?.length);
			const imageResult = await uploadTempImage(dataUrl);
			console.log("[GJJ Mesh2Motion] 上传结果:", imageResult);
			
			node.properties = node.properties || {};
			captureState.image = {
				name: imageResult.name,
				subfolder: imageResult.subfolder,
				type: imageResult.type,
			};
			node.properties.mesh2motion_image = JSON.stringify(captureState.image);
			setStatus(node, "截图已捕获", "ok");
			
			// 如果有相机预设，捕获视频
			node.properties.mesh2motion_video = "";
			const recordingPreset = await ensureRecordingPreset(node);
			if (recordingPreset?.id) {
				const presetId = recordingPreset.id;
				if (presetId) {
					setStatus(node, "正在录制相机预设视频...", "busy");
					const videoResult = await captureVideoFromIframe(
						node._gjjMesh2MotionIframe,
						presetId,
						Number(getState(node, "width")) || 1024,
						Number(getState(node, "height")) || 1024,
					);
					captureState.video = {
						video: parseAnnotatedUploadPath(videoResult.videoPath, "temp"),
						fps: videoResult.fps,
					};
					node.properties.mesh2motion_video = JSON.stringify(captureState.video);
					setStatus(node, "视频已录制", "ok");
				}
			}
			await syncCaptureStateToBackend(node, captureState);
			console.log("[GJJ Mesh2Motion] ✅ 数据捕获完成，已保存到 properties 与 Python 缓存");
			console.log("[GJJ Mesh2Motion] properties 内容:", JSON.stringify(node.properties));
			return true;
		} catch (error) {
			console.error("[GJJ Mesh2Motion] 捕获失败：", error);
			if (captureState?.image) {
				try {
					await syncCaptureStateToBackend(node, captureState);
				} catch (syncError) {
					console.warn("[GJJ Mesh2Motion] 同步部分捕获状态失败：", syncError);
				}
			}
			setStatus(node, `捕获失败：${error?.message || error}`, "error");
			return false;
		}
	};
	
	// 存储捕获函数供外部调用
	node._gjjMesh2MotionCapture = captureData;
	
	// 隐藏内部 widget（如果存在）
	for (const name of INTERNAL_WIDGETS) {
		const widget = getWidget(node, name);
		if (widget) {
			hideWidget(node, widget);
		}
	}

	const originalOnSerialize = node.onSerialize;
	node.onSerialize = function (serializedNode) {
		originalOnSerialize?.apply(this, [serializedNode]);
		const props = this.properties || {};
		if (serializedNode) {
			serializedNode.properties = serializedNode.properties || {};
			for (const [key, value] of Object.entries(props)) {
				if (String(key).startsWith("mesh2motion_")) {
					serializedNode.properties[key] = value;
				}
			}
			for (const [stateName, stateKey] of Object.entries(STATE_KEYS)) {
				serializedNode.properties[stateKey] = getState(this, stateName);
			}
			if (Array.isArray(serializedNode.widgets_values)) {
				serializedNode.widgets_values.length = 0;
			} else {
				serializedNode.widgets_values = [];
			}
		}
		if (Array.isArray(this.widgets_values)) {
			this.widgets_values.length = 0;
		} else {
			this.widgets_values = [];
		}
	};
}

function createPanel(node) {
	if (node.__gjjMesh2MotionMounted || typeof node.addDOMWidget !== "function") {
		return;
	}
	node.__gjjMesh2MotionMounted = true;

	const container = document.createElement("div");
	container.className = "gjj-mesh2motion-panel";
	container.style.display = "flex";
	container.style.flexDirection = "column";
	createBooleanControls(node, container);
	createSliderControls(node, container);

	// 添加捕获按钮
	const buttonRow = document.createElement("div");
	buttonRow.style.cssText = "display:flex;gap:8px;padding:4px 8px 8px;background:#1a2328;";
	
	const captureBtn = document.createElement("button");
	captureBtn.textContent = "📸 捕获并执行";
	captureBtn.style.cssText = "flex:1;padding:8px 12px;background:#4a9eff;color:white;border:none;border-radius:6px;cursor:pointer;font-size:13px;";
	captureBtn.onclick = async () => {
		if (node._gjjMesh2MotionCapture) {
			const ok = await node._gjjMesh2MotionCapture();
			if (!ok) {
				return;
			}
			// 等待 properties 被序列化
			await new Promise(resolve => setTimeout(resolve, 200));
			// 强制刷新节点状态
			refreshNode(node);
			// 等待 UI 更新
			await new Promise(resolve => setTimeout(resolve, 100));
			// 触发 ComfyUI 执行
			app.queuePrompt(0, 1);
		}
	};
	
	const refreshBtn = document.createElement("button");
	refreshBtn.textContent = "🔄 刷新";
	refreshBtn.style.cssText = "padding:8px 12px;background:#314147;color:white;border:none;border-radius:6px;cursor:pointer;font-size:13px;";
	refreshBtn.onclick = () => {
		if (node._gjjMesh2MotionIframe) {
			node._gjjMesh2MotionIframe.src = node._gjjMesh2MotionIframe.src;
		}
	};
	
	buttonRow.appendChild(captureBtn);
	buttonRow.appendChild(refreshBtn);
	container.appendChild(buttonRow);

	const iframe = document.createElement("iframe");
	iframe.className = "gjj-mesh2motion-frame";
	iframe.src = `${ROUTE_BASE}/index-comfyui.html?comfyui=true&theme=dark`;
	iframe.allow = "cross-origin-isolated";
	container.appendChild(iframe);

	const status = document.createElement("div");
	status.className = "gjj-mesh2motion-status";
	status.dataset.tone = "idle";
	status.textContent = "Mesh2Motion 加载中...";
	container.appendChild(status);

	node._gjjMesh2MotionIframe = iframe;
	node._gjjMesh2MotionReady = false;
	node.__gjjMesh2MotionStatus = status;

	const messageHandler = (event) => handleIframeMessage(node, iframe, event);
	window.addEventListener("message", messageHandler);
	const originalOnRemoved = node.onRemoved;
	node.onRemoved = function (...args) {
		window.removeEventListener("message", messageHandler);
		return originalOnRemoved?.apply(this, args);
	};

	node.addDOMWidget(VIEW_WIDGET, "HTML", container, {
		hideOnZoom: false,
		serialize: false,
		getMinHeight: () => MIN_WIDGET_HEIGHT,
	});

	compactMesh2MotionNode(node);
	requestAnimationFrame(() => {
		compactMesh2MotionNode(node);
		requestAnimationFrame(() => {
			compactMesh2MotionNode(node);
		});
	});

	hookSerialization(node);

	const [width, height] = node.size || [MIN_NODE_WIDTH, MIN_NODE_HEIGHT];
	node.minWidth = Math.max(node.minWidth || 0, MIN_NODE_WIDTH);
	node.setSize?.([Math.max(width, MIN_NODE_WIDTH), Math.max(height, MIN_NODE_HEIGHT)]);
	refreshNode(node);
}

function stabilizeNode(node) {
	compactMesh2MotionNode(node);
	requestAnimationFrame(() => {
		compactMesh2MotionNode(node);
	});
}

const STYLE_ID = "gjj-mesh2motion-style";
function ensureStyle() {
	if (document.getElementById(STYLE_ID)) {
		return;
	}
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
	.gjj-mesh2motion-panel {
		width: 100%;
		height: 100%;
		min-height: ${MIN_PANEL_HEIGHT}px;
		position: relative;
		overflow: hidden;
		background: #10171b;
	border: 1px solid #314147;
	box-sizing: border-box;
}
	.gjj-mesh2motion-frame {
		width: 100%;
		flex: 1 1 auto;
		min-height: 0;
		height: auto;
		border: 0;
		display: block;
		background: #10171b;
	}
.gjj-mesh2motion-status {
	position: absolute;
	left: 10px;
	right: 10px;
	bottom: 10px;
	pointer-events: none;
	padding: 6px 9px;
	border-radius: 6px;
	background: rgba(11, 17, 20, 0.82);
	color: #d9e7df;
	font: 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	border: 1px solid rgba(124, 150, 143, 0.35);
}
.gjj-mesh2motion-status[data-tone="ok"] {
	border-color: rgba(79, 183, 126, 0.55);
}
.gjj-mesh2motion-status[data-tone="busy"] {
	border-color: rgba(91, 165, 255, 0.7);
}
.gjj-mesh2motion-status[data-tone="error"] {
	border-color: rgba(255, 102, 102, 0.8);
	color: #ffd6d6;
}
`;
	document.head.appendChild(style);
}

app.registerExtension({
	name: "GJJ.Mesh2MotionExplore",

	setup() {
		console.log("[GJJ Mesh2Motion] 🚀 扩展已注册");
		ensureStyle();
	},

	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_CLASS) {
			return;
		}
		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			requestAnimationFrame(() => {
				stabilizeNode(this);
				setTimeout(() => compactMesh2MotionNode(this), 0);
				setTimeout(() => compactMesh2MotionNode(this), 120);
			});
			return result;
		};
		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			requestAnimationFrame(() => {
				stabilizeNode(this);
				setTimeout(() => compactMesh2MotionNode(this), 0);
				setTimeout(() => compactMesh2MotionNode(this), 120);
			});
			return result;
		};
	},

	nodeCreated(node) {
		const nodeClass = String(node?.constructor?.comfyClass || node?.comfyClass || "");
		console.log(`[GJJ Mesh2Motion] nodeCreated 触发，节点类: ${nodeClass}`);
		
		if (nodeClass !== NODE_CLASS) {
			return;
		}
		
		console.log(`[GJJ Mesh2Motion] ✅ 匹配到目标节点，开始创建面板`);
		ensureStyle();

		// 检查 mesh2motion 资源是否存在
		const checkResource = async () => {
			try {
				const response = await api.fetchApi(`${ROUTE_BASE}/index-comfyui.html`);
				if (response.status !== 200) {
					console.warn("[GJJ Mesh2Motion] ⚠️ Mesh2Motion 资源未找到！");
					console.warn("🌏模型下载：https://pan.quark.cn/s/6ec846f1f58d");
				}
			} catch (error) {
				console.warn("[GJJ Mesh2Motion] ⚠️ Mesh2Motion 资源未找到！");
				console.warn("🌏模型下载：https://pan.quark.cn/s/6ec846f1f58d");
			}
		};

		checkResource();
		createPanel(node);
		compactMesh2MotionNode(node);
		setTimeout(() => compactMesh2MotionNode(node), 0);
		setTimeout(() => compactMesh2MotionNode(node), 120);
	},
	});
