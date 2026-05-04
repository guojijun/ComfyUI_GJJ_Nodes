import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const NODE_CLASS = "GJJ_Mesh2MotionExplore";
const ROUTE_BASE = "/gjj/mesh2motion";
const POST_MESSAGE_ORIGIN = window.location.origin;
const VIEW_WIDGET = "gjj_mesh2motion_view";
const INTERNAL_WIDGETS = ["image", "video_frames"];

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function widgetValue(node, name, fallback = null) {
	const widget = getWidget(node, name);
	return widget ? widget.value : fallback;
}

function refreshNode(node) {
	GJJ_Utils.refreshNode(node);
}

function hideWidget(widget) {
	if (!widget) {
		return;
	}
	widget.type = `converted-widget:${widget.name || "hidden"}`;
	widget.options = widget.options || {};
	widget.options.hidden = true;
	widget.computeSize = () => [0, -4];
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

async function uploadTempImage(dataUrl) {
	const blob = await fetch(dataUrl).then((response) => response.blob());
	const file = new File([blob], `gjj_mesh2motion_${Date.now()}.png`, { type: "image/png" });
	const body = new FormData();
	body.append("image", file);
	body.append("subfolder", "mesh2motion");
	body.append("type", "temp");
	const response = await api.fetchApi("/upload/image", { method: "POST", body });
	if (!response.ok) {
		throw new Error(`上传截图失败：${response.status}`);
	}
	return await response.json();
}

function sendBooleanStates(node) {
	const mappings = [
		["show_skeleton", "mesh2motion:setShowSkeleton"],
		["mirror_animations", "mesh2motion:setMirrorAnimations"],
		["checker_room", "mesh2motion:setCheckerRoom"],
	];
	for (const [widgetName, messageType] of mappings) {
		postToIframe(node, messageType, { value: !!widgetValue(node, widgetName, false) });
	}
}

function sendPreviewState(node) {
	postToIframe(node, "mesh2motion:setPreviewOverlay", {
		active: !!widgetValue(node, "preview_output", false),
		width: Number(widgetValue(node, "width", 1024)) || 1024,
		height: Number(widgetValue(node, "height", 1024)) || 1024,
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

function hookWidgetCallback(node, widgetName, callback) {
	const widget = getWidget(node, widgetName);
	if (!widget || widget.__gjjMesh2MotionHooked) {
		return;
	}
	const original = widget.callback;
	widget.callback = function (...args) {
		const result = original?.apply(this, args);
		callback(widget.value);
		return result;
	};
	widget.__gjjMesh2MotionHooked = true;
}

function hookLiveControls(node) {
	hookWidgetCallback(node, "show_skeleton", (value) => {
		postToIframe(node, "mesh2motion:setShowSkeleton", { value: !!value });
	});
	hookWidgetCallback(node, "mirror_animations", (value) => {
		postToIframe(node, "mesh2motion:setMirrorAnimations", { value: !!value });
		node._gjjMesh2MotionVideoSig = null;
	});
	hookWidgetCallback(node, "checker_room", (value) => {
		postToIframe(node, "mesh2motion:setCheckerRoom", { value: !!value });
		node._gjjMesh2MotionVideoSig = null;
	});
	for (const name of ["preview_output", "width", "height", "fps"]) {
		hookWidgetCallback(node, name, () => {
			sendPreviewState(node);
			node._gjjMesh2MotionVideoSig = null;
		});
	}
}

function computeVideoSignature(node) {
	const presetFile = node.properties?.mesh2motion_camera_preset;
	if (!presetFile) {
		return null;
	}
	const tuningMap = node.properties?.mesh2motion_preset_tuning;
	return JSON.stringify({
		presetFile,
		skeleton: node.properties?.mesh2motion_skeleton ?? null,
		timeline: node.properties?.mesh2motion_timeline ?? null,
		tuning: tuningMap?.[presetFile] ?? null,
		width: widgetValue(node, "width", 1024),
		height: widgetValue(node, "height", 1024),
		fps: widgetValue(node, "fps", 24),
		showSkeleton: !!widgetValue(node, "show_skeleton", false),
		mirror: !!widgetValue(node, "mirror_animations", false),
		checkerRoom: !!widgetValue(node, "checker_room", false),
	});
}

function hookSerialization(node) {
	for (const name of INTERNAL_WIDGETS) {
		hideWidget(getWidget(node, name));
	}

	const imageWidget = getWidget(node, "image");
	if (imageWidget) {
		imageWidget.serializeValue = async () => {
			try {
				setStatus(node, "正在捕获截图...", "busy");
				const dataUrl = await captureFromIframe(node._gjjMesh2MotionIframe);
				const result = await uploadTempImage(dataUrl);
				setStatus(node, "截图已捕获", "ok");
				return `mesh2motion/${result.name} [temp]`;
			} catch (error) {
				console.error("[GJJ Mesh2Motion] 截图捕获失败：", error);
				setStatus(node, `截图捕获失败：${error?.message || error}`, "error");
				return "";
			}
		};
	}

	const videoWidget = getWidget(node, "video_frames");
	if (videoWidget) {
		videoWidget.serializeValue = async () => {
			const presetFile = node.properties?.mesh2motion_camera_preset;
			if (!presetFile) {
				return "";
			}
			const signature = computeVideoSignature(node);
			if (signature && signature === node._gjjMesh2MotionVideoSig && node._gjjMesh2MotionVideoSerialized) {
				return node._gjjMesh2MotionVideoSerialized;
			}
			const fileName = String(presetFile).split("/").pop() || "";
			const presetId = fileName.replace(/\.json$/i, "");
			if (!presetId) {
				return "";
			}
			try {
				setStatus(node, "正在录制相机预设视频...", "busy");
				const result = await captureVideoFromIframe(
					node._gjjMesh2MotionIframe,
					presetId,
					Number(widgetValue(node, "width", 1024)) || 1024,
					Number(widgetValue(node, "height", 1024)) || 1024,
				);
				const serialized = JSON.stringify({ video: result.videoPath, fps: result.fps });
				node._gjjMesh2MotionVideoSig = signature;
				node._gjjMesh2MotionVideoSerialized = serialized;
				setStatus(node, "视频已录制", "ok");
				return serialized;
			} catch (error) {
				console.error("[GJJ Mesh2Motion] 视频捕获失败：", error);
				setStatus(node, `视频捕获失败：${error?.message || error}`, "error");
				return "";
			}
		};
	}
}

function createPanel(node) {
	if (node.__gjjMesh2MotionMounted || typeof node.addDOMWidget !== "function") {
		return;
	}
	node.__gjjMesh2MotionMounted = true;

	const container = document.createElement("div");
	container.className = "gjj-mesh2motion-panel";

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
		getMinHeight: () => 460,
	});

	hookLiveControls(node);
	hookSerialization(node);

	const [width, height] = node.size || [560, 760];
	node.setSize?.([Math.max(width, 560), Math.max(height, 760)]);
	refreshNode(node);
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
	min-height: 460px;
	position: relative;
	overflow: hidden;
	background: #10171b;
	border: 1px solid #314147;
	box-sizing: border-box;
}
.gjj-mesh2motion-frame {
	width: 100%;
	height: 100%;
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
		ensureStyle();
	},

	nodeCreated(node) {
		if (String(node?.constructor?.comfyClass || node?.comfyClass || "") !== NODE_CLASS) {
			return;
		}
		ensureStyle();
		createPanel(node);
	},
});
