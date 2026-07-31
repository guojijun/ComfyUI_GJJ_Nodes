import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import {
	GJJ_AUDIO_PLAYER_HEIGHT,
	gjjRenderAudioWaveformPreview,
	gjjStyleCompactAudioPlayer,
} from "./gjj_common_media_preview.js";
import { queueOnlyCurrentNode } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_AnyPreview"]);
const INPUT_PREFIX = "any_";
const MIN_VISIBLE_INPUTS = 1;
const ANY_INPUT_TYPE = "*";
const FAST_INPUT_TYPES = "GJJ_BATCH_IMAGE、IMAGE、MASK、STRING、AUDIO、VIDEO";
const FIRST_INPUT_LABEL = "任意对象";
const INPUT_TOOLTIP = `可连接任意类型；${FAST_INPUT_TYPES} 会走专用预览，其它对象会像官方 PreviewAny 一样显示可读值。`;
const PREVIEW_WIDGET_NAME = "gjj_any_preview_text";
const EMPTY_PREVIEW = "执行后在这里预览文本、对象或调试信息";
const MIN_PREVIEW_HEIGHT = 96;
const TEXT_PREVIEW_MAX_LINES = 20;
const TEXT_PREVIEW_LINE_HEIGHT = 1.45;
const IMAGE_PREVIEW_MIN_HEIGHT = 124;
const SINGLE_IMAGE_PREVIEW_HEIGHT = 360;
const MIN_NODE_HEIGHT = 40;
const MIN_WIDTH = 260;
const NODE_BOTTOM_PADDING = 10;
const NATIVE_CANVAS_PREVIEW_WIDGET = "$$canvas-image-preview";
const NATIVE_PREVIEW_CLEANUP_DELAYS = [0, 16, 60, 150, 300, 800, 1600, 3200];
const NATIVE_PREVIEW_WIDGET_PATTERN = /(?:preview|image|images|img|图像|图片|预览)/i;
const LORA_EFFECT_LIVE_TEXT_MAP_KEY = "__gjjLoraEffectTesterLiveTextByNodeId";
const LIVE_PREVIEW_STATE_KEY = "__gjjAnyPreviewLiveState";
const CONNECTION_PREVIEW_MENU_LABEL = "预览结果";
const IMAGE_SEQUENCE_MIN_FRAMES = 16;
const IMAGE_SEQUENCE_PREVIEW_FPS = 12;
const MODE_EDIT = "edit";
const MODE_PREVIEW = "preview";
const DOUBLE_CLICK_MS = 420;
const MODE_PROPERTY = "__gjjAnyPreviewMode";
const TILE_PROPERTY = "__gjjAnyPreviewTileMode";
const WIDTH_PROPERTY = "gjj_any_preview_width";
const HELD_TEXT_PROPERTY = "gjj_any_preview_held_text";
const HELD_IMAGES_PROPERTY = "gjj_any_preview_held_images";
const HELD_MEDIA_PROPERTY = "gjj_any_preview_held_media";
const GJJ_FILE_DRAG_MIME = "application/x-gjj-file-browser-item";
const LAST_LINKS_PROPERTY = "gjj_any_preview_last_upstream_links";
const TEXT_INPUT_SAVED_TEXT_PROPERTY = "gjj_text_input_saved_text";
const MOTION_GUARD_STYLE_ID = "gjj-any-preview-motion-guard-style";
const MOTION_CLASS = "gjj-any-preview-motion";
const MOTION_IDLE_MS = 260;
const MULTI_OBJECT_TILE_MIN_WIDTH = 132;
const MULTI_OBJECT_TILE_GAP = 6;
const LIVE_KIND_LABELS = {
	image: "图片",
	mask: "遮罩",
	text: "文本",
	audio: "音频",
	video: "视频",
	"3d": "3D文件",
	other: "对象",
	mixed: "混合对象",
};
const KIND_TYPE_LABELS = {
	image: "IMAGE",
	mask: "MASK",
	text: "STRING",
	audio: "AUDIO",
	video: "VIDEO",
	"3d": "FILE_3D",
	mixed: "MIXED",
	other: "OBJECT",
};
const KIND_EMOJIS = {
	image: "🖼️",
	mask: "🎭",
	text: "📝",
	audio: "🎧",
	video: "🎬",
	"3d": "🧊",
	mixed: "🧩",
	other: "🧩",
};
const ORDINAL_EMOJIS = ["", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const HOLD_ICON_SVG = `<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M635.172 95.834c-1.998 1.999-3.996 3.999-5.996 5.997l-16.061 16.061-23.229 23.23-27.507 27.506-28.888 28.889-27.376 27.376-22.969 22.97-15.67 15.67c-2.473 2.473-5.002 4.904-7.388 7.462-13.211 14.175-21.229 32.737-22.46 52.078-1.213 19.078 4.198 38.318 15.289 53.899a84.425 84.425 0 0 0 9.07 10.72l31.855 31.869 182.6-182.397 109.26 109.485-182.384 182.374 20.919 20.92 10.193 10.193c5.181 5.182 10.847 9.786 17.141 13.558 16.325 9.776 35.837 13.714 54.68 11.066 17.979-2.523 34.807-11.007 47.594-23.882l5.997-5.996c5.354-5.354 10.706-10.708 16.061-16.061l23.229-23.23a713271.6 713271.6 0 0 0 27.505-27.506l28.891-28.889c9.124-9.126 18.251-18.25 27.375-27.376l22.971-22.97 15.669-15.67c2.472-2.472 4.996-4.904 7.396-7.445 13.269-14.051 21.348-32.522 22.611-51.809 1.252-19.079-4.176-38.311-15.231-53.911a85.416 85.416 0 0 0-9.286-10.995c-1.999-1.999-3.997-3.998-5.998-5.997-5.354-5.353-10.705-10.707-16.061-16.061l-23.229-23.23-27.505-27.506-28.891-28.889-27.374-27.376c-7.656-7.657-15.314-15.313-22.972-22.97l-15.669-15.67c-2.567-2.567-5.091-5.197-7.752-7.669-16.305-15.139-38.344-23.235-60.571-22.292-20.912 0.891-40.991 9.736-55.839 24.474M270.406 460.605l-5.99 5.997c-5.348 5.354-10.696 10.711-16.044 16.064l-23.208 23.239-27.484 27.52a787376.15 787376.15 0 0 0-28.871 28.908l-27.368 27.402-22.978 23.009-15.697 15.715c-2.415 2.419-4.882 4.802-7.231 7.287-13.289 14.056-21.379 32.548-22.674 51.85-1.28 19.061 4.081 38.305 15.116 53.905a84.198 84.198 0 0 0 9.252 10.961l5.99 5.998 16.043 16.064 23.208 23.236c9.162 9.172 18.323 18.348 27.484 27.521 9.624 9.636 19.248 19.271 28.871 28.908l27.369 27.403 22.977 23.007 15.697 15.719c2.417 2.419 4.792 4.895 7.293 7.229 14.189 13.233 32.776 21.258 52.139 22.518 19.101 1.241 38.388-4.114 54.027-15.168a84.46 84.46 0 0 0 10.748-9.034l5.984-5.984 16.032-16.032 23.197-23.196 27.479-27.479c9.625-9.626 19.25-19.251 28.877-28.875l27.392-27.392 23.022-23.024 15.772-15.771c2.31-2.31 4.662-4.584 6.913-6.949 13.354-14.033 21.499-32.532 22.885-51.852 1.37-19.068-3.854-38.374-14.785-54.073a84.293 84.293 0 0 0-9.367-11.228l-32.069-31.851L348.02 784.541 238.536 675.068 420.932 492.47c-6.974-6.975-13.947-13.952-20.922-20.927l-10.196-10.199c-5.894-5.896-12.449-11.012-19.774-15.02-19.235-10.525-42.329-13.024-63.399-7.006-13.644 3.901-26.169 11.292-36.235 21.287" fill="#0071BC"></path><path d="M876.584 751.132c11.711 11.711 11.761 30.69 0.024 42.428-11.712 11.711-30.691 11.712-42.404 0.05l-0.025 0.025-113.25-113.25 0.025-0.025-0.051-0.051c-11.711-11.711-11.786-30.717-0.024-42.479 11.737-11.737 30.742-11.66 42.453 0.051l0.504 0.504 112.24 112.24 0.508 0.507M791.677 836.039c11.711 11.711 11.736 30.715-0.025 42.477-11.685 11.686-30.69 11.712-42.378 0.024l-0.025 0.026-113.25-113.251 0.025-0.025-0.051-0.051c-11.711-11.711-11.736-30.767-0.05-42.453 11.761-11.761 30.792-11.71 42.503 0.001l0.504 0.504 112.24 112.24 0.507 0.508" fill="#00A0E9"></path></svg>`;
const COPY_NODE_ICON_SVG = `<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M744.155429 187.026286a92.891429 92.891429 0 0 1 92.891428 92.891428v614.619429a92.891429 92.891429 0 0 1-92.891428 92.891428H129.462857A92.891429 92.891429 0 0 1 36.571429 894.537143V279.844571c0-51.273143 41.545143-92.891429 92.891428-92.891428h614.692572z m0 74.24H129.462857a18.578286 18.578286 0 0 0-18.578286 18.578285v614.692572c0 10.24 8.265143 18.578286 18.578286 18.578286h614.692572c10.24 0 18.578286-8.265143 18.578285-18.578286V279.844571a18.578286 18.578286 0 0 0-18.578285-18.578285zM894.537143 36.571429c51.346286 0 92.891429 41.545143 92.891428 92.891428v614.692572a92.891429 92.891429 0 0 1-92.891428 92.891428 37.156571 37.156571 0 1 1 0-74.313143c10.24 0 18.578286-8.338286 18.578286-18.578285V129.462857a18.578286 18.578286 0 0 0-18.578286-18.578286H279.844571a18.578286 18.578286 0 0 0-18.578285 18.578286 37.156571 37.156571 0 1 1-74.24 0c0-51.346286 41.545143-92.891429 92.891428-92.891428h614.619429zM436.809143 388.534857c20.48 0 37.083429 16.603429 37.083428 37.083429V550.034286h124.489143a37.156571 37.156571 0 1 1 0 74.313143H473.892571v124.416a37.156571 37.156571 0 1 1-74.24 0l-0.073142-124.416h-124.342858a37.156571 37.156571 0 1 1 0-74.24l124.342858-0.073143v-124.342857c0-20.553143 16.676571-37.156571 37.229714-37.156572z" fill="#257FFF"></path></svg>`;
const CLIPBOARD_ICON_SVG = `<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M515.53 511.994m-495.082 0a495.082 495.082 0 1 0 990.164 0 495.082 495.082 0 1 0-990.164 0Z" fill="#95BAF9"></path><path d="M709.882 128.214H321.176c-85.654 0-155.338 69.686-155.338 155.34v390.382l0.002 0.004v68.488c0 85.654 69.684 155.34 155.338 155.34h388.708c85.654 0 155.338-69.686 155.338-155.34V283.556c0-85.654-69.684-155.342-155.342-155.342z" fill="#0A2BDE"></path><path d="M279.442 233.812h472.18v558.362h-472.18z" fill="#FFFFFF"></path><path d="M324.52 161.624v99.154c0 50.08 40.742 90.822 90.824 90.822H615.72c50.08 0 90.822-40.742 90.822-90.822V161.624H324.52z" fill="#95BAF9"></path><path d="M362.614 401.504h305.836v46.662H362.614zM362.614 511.64h305.836v46.66H362.614zM362.614 621.774h305.836v46.66H362.614z" fill="#95BAF9"></path></svg>`;
let lastPromptId = null;
let motionGuardInstalled = false;
let motionGuardTimer = null;
const liveVirtualPreviewTargets = new Map();

function isTargetNode(node) {
	return TARGET_NODES.has(node?.comfyClass || node?.type);
}

function ordinalEmoji(index) {
	const value = Number(index);
	if (Number.isInteger(value) && value > 0 && value < ORDINAL_EMOJIS.length) {
		return ORDINAL_EMOJIS[value];
	}
	return `${Number.isFinite(value) && value > 0 ? Math.floor(value) : 1}.`;
}

function normalizePreviewTypeLabel(value, fallback = "OBJECT") {
	const text = String(value || "").trim();
	if (!text || text === "*") return fallback;
	const first = text.split(",").map((part) => part.trim()).find((part) => part && part !== "*") || text;
	return first.replace(/^converted-widget:/i, "").trim().toUpperCase() || fallback;
}

function ensureMotionGuardStyle() {
	if (document.getElementById(MOTION_GUARD_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = MOTION_GUARD_STYLE_ID;
	style.textContent = `
.gjj-any-preview-wrap.${MOTION_CLASS} > :not(style) {
	visibility: hidden !important;
}
.gjj-any-preview-wrap.${MOTION_CLASS}::after {
	content: "拖动画布中，已临时暂停大图绘制";
	position: absolute;
	inset: 8px;
	display: flex;
	align-items: center;
	justify-content: center;
	box-sizing: border-box;
	border: 1px dashed rgba(125, 211, 252, .32);
	border-radius: 8px;
	background: rgba(9, 15, 18, .82);
	color: #a8c7d8;
	font: 700 13px/1.4 system-ui, "Microsoft YaHei", sans-serif;
	text-align: center;
	pointer-events: none;
	z-index: 5;
}
`;
	document.head.appendChild(style);
}

function setPreviewMotionMode(active) {
	for (const node of app.graph?._nodes || []) {
		if (!TARGET_NODES.has(node?.comfyClass || node?.type)) continue;
		const wrap = node.__gjjAnyPreviewWrap;
		if (!wrap?.classList) continue;
		wrap.classList.toggle(MOTION_CLASS, Boolean(active));
	}
}

function pulsePreviewMotionMode() {
	ensureMotionGuardStyle();
	setPreviewMotionMode(true);
	clearTimeout(motionGuardTimer);
	motionGuardTimer = setTimeout(() => setPreviewMotionMode(false), MOTION_IDLE_MS);
}

function installCanvasMotionGuard() {
	if (motionGuardInstalled) return;
	const canvasEl = app.canvas?.canvas_mouse || app.canvas?.canvas || document.querySelector("canvas");
	if (!canvasEl?.addEventListener) return;
	motionGuardInstalled = true;
	let pointerDownOnCanvas = false;
	const begin = () => {
		pointerDownOnCanvas = true;
	};
	const move = (event) => {
		if (pointerDownOnCanvas || Number(event?.buttons || 0) !== 0) {
			pulsePreviewMotionMode();
		}
	};
	const end = () => {
		pointerDownOnCanvas = false;
		pulsePreviewMotionMode();
	};
	canvasEl.addEventListener("pointerdown", begin, { passive: true });
	canvasEl.addEventListener("pointermove", move, { passive: true });
	window.addEventListener("pointerup", end, { passive: true });
	canvasEl.addEventListener("wheel", pulsePreviewMotionMode, { passive: true });
}

function previewItemKind(item) {
	return String(item?.source_kind || item?.kind || "").toLowerCase() || "other";
}

function previewItemTypeLabel(item, fallbackKind = "") {
	const kind = previewItemKind(item) || fallbackKind || "other";
	const explicit = item?.type_label || item?.data_type || item?.source_type || item?.type;
	return normalizePreviewTypeLabel(explicit, KIND_TYPE_LABELS[kind] || KIND_TYPE_LABELS.other);
}

function previewItemTypeEmoji(item, fallbackKind = "") {
	const kind = previewItemKind(item) || fallbackKind || "other";
	return String(item?.type_emoji || KIND_EMOJIS[kind] || KIND_EMOJIS.other);
}

function previewItemDisplayTitle(item, index = 0) {
	const ordinal = String(item?.ordinal_emoji || ordinalEmoji(Number(item?.ordinal || index + 1))).trim();
	return `${ordinal} ${previewItemTypeEmoji(item)} ${previewItemTypeLabel(item)}`.trim();
}

function getMode(node) {
	const mode = String(node?.properties?.[MODE_PROPERTY] || MODE_PREVIEW);
	return mode === MODE_PREVIEW ? MODE_PREVIEW : MODE_EDIT;
}

function isTileMode(node) {
	return Boolean(node?.properties?.[TILE_PROPERTY]);
}

function resetPreviewAutoHeight(node) {
	node.__gjjAnyPreviewHeight = MIN_PREVIEW_HEIGHT;
	node.__gjjAnyPreviewCompactTileEntries = 0;
	for (const element of [
		node?.__gjjAnyPreviewContainer,
		node?.__gjjAnyPreviewWrap,
		node?.__gjjAnyPreviewGrid,
	]) {
		if (element) {
			element.style.height = "auto";
		}
	}
	if (node?.__gjjAnyPreviewWrap) {
		node.__gjjAnyPreviewWrap.style.minHeight = "96px";
		node.__gjjAnyPreviewWrap.style.maxHeight = "";
		node.__gjjAnyPreviewWrap.style.overflow = "visible";
	}
}

function setTileMode(node, enabled) {
	node.properties = node.properties || {};
	node.properties[TILE_PROPERTY] = Boolean(enabled);
	resetPreviewAutoHeight(node);
	applyPreviewContent(node);
	updatePreviewActionButtons(node);
	scheduleLayout(node);
	setDirty(node);
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

function closeAnyPreviewImageMenu() {
	document.querySelectorAll(".gjj-any-preview-image-menu").forEach((menu) => menu.remove());
}

function downloadAnyPreviewImage(item) {
	const url = imageDataToUrl(item);
	if (!url) return;
	const link = document.createElement("a");
	link.href = url;
	link.download = String(item?.filename || "gjj-preview-image.png").split(/[\\/]/).pop() || "gjj-preview-image.png";
	link.rel = "noopener";
	document.body.appendChild(link);
	link.click();
	link.remove();
}

function addImageMenuItem(menu, label, callback) {
	const item = document.createElement("button");
	item.type = "button";
	item.textContent = label;
	item.style.cssText = [
		"display:block",
		"width:100%",
		"border:0",
		"background:transparent",
		"color:#e7f3ef",
		"padding:7px 12px",
		"text-align:left",
		"font:12px/1.35 system-ui,\"Microsoft YaHei\",sans-serif",
		"cursor:pointer",
	].join(";");
	item.addEventListener("mouseenter", () => {
		item.style.background = "#23323a";
	});
	item.addEventListener("mouseleave", () => {
		item.style.background = "transparent";
	});
	item.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		closeAnyPreviewImageMenu();
		callback?.();
	});
	menu.appendChild(item);
}

function showAnyPreviewImageMenu(event, item) {
	const url = imageDataToUrl(item);
	if (!url) return;
	event.preventDefault();
	event.stopPropagation();
	closeAnyPreviewImageMenu();

	const menu = document.createElement("div");
	menu.className = "gjj-any-preview-image-menu";
	menu.style.cssText = [
		"position:fixed",
		"z-index:10050",
		"min-width:148px",
		"padding:4px",
		"border:1px solid #3a4d56",
		"border-radius:7px",
		"background:#10191e",
		"box-shadow:0 8px 26px rgba(0,0,0,.36)",
		"box-sizing:border-box",
	].join(";");

	addImageMenuItem(menu, "保存图片", () => downloadAnyPreviewImage(item));
	addImageMenuItem(menu, "新标签打开", () => window.open(url, "_blank", "noopener"));
	addImageMenuItem(menu, "打开所在目录", () => openMediaFolder(item || {}));
	document.body.appendChild(menu);

	const rect = menu.getBoundingClientRect();
	const left = Math.min(event.clientX, window.innerWidth - rect.width - 8);
	const top = Math.min(event.clientY, window.innerHeight - rect.height - 8);
	menu.style.left = `${Math.max(8, left)}px`;
	menu.style.top = `${Math.max(8, top)}px`;

	const dismiss = (dismissEvent) => {
		if (!menu.contains(dismissEvent.target)) {
			closeAnyPreviewImageMenu();
			document.removeEventListener("pointerdown", dismiss, true);
			document.removeEventListener("keydown", dismissKey, true);
		}
	};
	const dismissKey = (keyEvent) => {
		if (keyEvent.key === "Escape") {
			closeAnyPreviewImageMenu();
			document.removeEventListener("pointerdown", dismiss, true);
			document.removeEventListener("keydown", dismissKey, true);
		}
	};
	setTimeout(() => {
		document.addEventListener("pointerdown", dismiss, true);
		document.addEventListener("keydown", dismissKey, true);
	}, 0);
}

function bindAnyPreviewImageContextMenu(image, item) {
	if (!image?.addEventListener || !item) return;
	image.addEventListener("contextmenu", (event) => showAnyPreviewImageMenu(event, item));
}

function withoutNativeImagePreview(message = {}) {
	return { ...(message || {}) };
}

function targetNodeFromExecutedEvent(event) {
	const nodeId = eventNodeId(event);
	if (nodeId == null || nodeId === "") {
		return null;
	}
	const node =
		app.graph?.getNodeById?.(nodeId) ||
		app.graph?.getNodeById?.(Number(nodeId)) ||
		null;
	return isTargetNode(node) ? node : null;
}

function suppressNativeExecutedImages(event) {
	if (event?.type !== "executed" || !event?.detail) {
		return;
	}
	const node = targetNodeFromExecutedEvent(event);
	if (!node) {
		return;
	}
	clearNativeImagePreviewState(node);
	const output = event.detail.output || event.detail;
	if (!output || typeof output !== "object") {
		return;
	}
	// 保留标准 output.images 给 ComfyUI 队列/历史面板使用；节点底部的
	// Vue 原生输出图由 node.hideOutputImages 屏蔽，避免和 GJJ DOM 预览重复。
	if (Array.isArray(output.images) && output.images.length) {
		output.__gjj_queue_images = output.images;
	}
}

function installNativePreviewEventFilter() {
	if (api.__gjjAnyPreviewEventFilterInstalled || typeof api.dispatchEvent !== "function") {
		return;
	}
	const originalDispatchEvent = api.dispatchEvent.bind(api);
	try {
		api.dispatchEvent = function (event) {
			const node = targetNodeFromExecutedEvent(event);
			if (node) {
				clearNativeImagePreviewState(node);
			}
			suppressNativeExecutedImages(event);
			const result = originalDispatchEvent(event);
			if (node) {
				scheduleNativePreviewCleanup(node);
			}
			return result;
		};
		api.__gjjAnyPreviewEventFilterInstalled = true;
	} catch (error) {
		console.warn("[GJJ AnyPreview] 无法安装原生预览事件拦截，改用节点级清理。", error);
	}
}

function compactPreviewText(text) {
	const source = String(text || "").replace(/\s+/g, " ").trim();
	if (!source) {
		return "";
	}
	const parts = [];
	const duration = source.match(/时长[:：]\s*([0-9.]+)\s*秒/);
	const frames = source.match(/帧数[:：]\s*(\d+)/);
	const fps = source.match(/(?:预览帧率|帧率)[:：]\s*([0-9.]+)\s*(?:fps)?/i);
	const size = source.match(/尺寸[:：]\s*(\d+)\s*[x×]\s*(\d+)/i);
	const shape = source.match(/形状[:：]\s*\(([^)]*)\)/);
	if (duration) parts.push(`⏱ ${duration[1]}s`);
	if (frames) parts.push(`🎞 ${frames[1]}帧`);
	if (fps) parts.push(`⚡ ${fps[1]}fps`);
	if (size) {
		parts.push(`📐 ${size[1]}×${size[2]}`);
	} else if (shape) {
		const nums = shape[1]
			.split(",")
			.map((part) => Number.parseInt(part.trim(), 10))
			.filter((value) => Number.isFinite(value));
		if (nums.length >= 4) {
			parts.push(`📐 ${nums[2]}×${nums[1]}`);
		}
	}
	return parts.length ? parts.join(" · ") : source;
}

function mediaEmoji(tagName, item) {
	const filename = String(item?.filename || "").toLowerCase();
	if (item?.is_sequence) {
		return "🎬";
	}
	if (tagName === "audio" || /\.(wav|mp3|flac|ogg|m4a|aac)$/i.test(filename)) {
		return "🎧";
	}
	if (tagName === "video" || /\.(mp4|webm|mov|mkv|avi|gif)$/i.test(filename)) {
		return "🎬";
	}
	return "🖼️";
}

function isSequenceMediaItem(item) {
	return Boolean(item?.is_sequence || (item?.loop && String(item?.format || "").includes("webp")));
}

async function openMediaFolder(item, button) {
	if (!item?.filename && !item?.subfolder) {
		return;
	}
	const params = new URLSearchParams();
	params.set("type", item.type || "temp");
	params.set("subfolder", item.subfolder || "");
	params.set("filename", item.filename || "");
	const oldText = button?.textContent || "📁";
	try {
		if (button) {
			button.disabled = true;
			button.textContent = "…";
		}
		const response = await api.fetchApi(
			`/gjj/any_preview/open_media_folder?${params.toString()}`,
			{ method: "POST" },
		);
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(text || `HTTP ${response.status}`);
		}
	} catch (error) {
		console.warn("[GJJ AnyPreview] 打开所在目录失败:", error);
		if (button) {
			button.title = `打开所在目录失败：${error?.message || error}`;
		}
	} finally {
		if (button) {
			button.disabled = false;
			button.textContent = oldText;
		}
	}
}

function isMediaFileItem(item) {
	return Boolean(item && typeof item === "object" && item.filename);
}

function normalizeMediaPayload(payload) {
	if (!payload) {
		return [];
	}
	if (isMediaFileItem(payload)) {
		return [payload];
	}
	if (!Array.isArray(payload)) {
		return [];
	}
	if (payload.length === 1 && Array.isArray(payload[0])) {
		return normalizeMediaPayload(payload[0]);
	}
	return payload.filter(isMediaFileItem);
}

function firstMediaPayload(...payloads) {
	for (const payload of payloads) {
		const normalized = normalizeMediaPayload(payload);
		if (normalized.length > 0) {
			return normalized;
		}
	}
	return [];
}

function sequenceFramePayload(item) {
	return normalizeMediaPayload(item?.sequence_frames || item?.frame_images || item?.frames);
}

function tileImagePayload(item) {
	if (isSequenceMediaItem(item)) {
		return sequenceFramePayload(item);
	}
	return item ? [item] : [];
}

function countTileImages(images) {
	return normalizeMediaPayload(images).reduce(
		(total, image) => total + tileImagePayload(image).length,
		0,
	);
}

function tileImageEntriesFromImages(images, baseLabel = "") {
	const entries = [];
	for (const image of normalizeMediaPayload(images)) {
		const tileImages = tileImagePayload(image);
		for (const [index, tileImage] of tileImages.entries()) {
			entries.push({
				item: tileImage,
				label: baseLabel || (tileImages.length > 1 ? `${index + 1}` : ""),
			});
		}
	}
	return entries;
}

function sourceLooksAudio(sourceInfo) {
	const text = `${sourceInfo?.type || ""} ${sourceInfo?.label || ""}`.toUpperCase();
	return text.includes("AUDIO");
}

function previewItemHasPlayableAudio(item) {
	return normalizeMediaPayload(item?.audio).length > 0;
}

function normalizePreviewItemsPayload(payload) {
	if (!payload) {
		return [];
	}
	if (!Array.isArray(payload)) {
		return [];
	}
	const items =
		payload.length === 1 && Array.isArray(payload[0]) ? payload[0] : payload;
	return items.filter((item) => item && typeof item === "object");
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
		|| graph._nodes?.find((node) => String(node?.id) === String(id))
		|| null;
}

function linkOriginId(link) {
	return Array.isArray(link) ? link[1] : link?.origin_id;
}

function linkOriginSlot(link) {
	return Number(Array.isArray(link) ? link[2] : link?.origin_slot);
}

function migrateLegacyInputs(node) {
	for (const input of node?.inputs || []) {
		if (String(input?.name || "") === "batch_image") {
			input.name = formatInputName(1);
		}
	}
}

function getLinkedOutputInfo(input) {
	const linkId = input?.link;
	if (linkId == null) {
		return null;
	}
	const link = getGraphLink(linkId);
	const sourceNode = getGraphNodeById(linkOriginId(link));
	const sourceSlot = sourceNode?.outputs?.[linkOriginSlot(link)];
	if (!sourceSlot) {
		return null;
	}
	return {
		type: sourceSlot.type || "*",
		label: sourceSlot.label || sourceSlot.name || sourceSlot.type || "*",
	};
}

function getLinkedSourceInfo(input) {
	const linkId = input?.link;
	if (linkId == null) {
		return null;
	}
	const link = getGraphLink(linkId);
	const sourceNode = getGraphNodeById(linkOriginId(link));
	const sourceSlot = sourceNode?.outputs?.[linkOriginSlot(link)];
	if (!sourceNode || !sourceSlot) {
		return null;
	}
	return {
		link,
		sourceNode,
		sourceSlot,
		type: sourceSlot.type || "*",
		label: sourceSlot.label || sourceSlot.name || sourceSlot.type || "*",
	};
}

function linkTargetSlot(link) {
	return Number(Array.isArray(link) ? link[4] : link?.target_slot);
}

function sourceNodeTitle(node) {
	return String(node?.title || node?.comfyClass || node?.type || `节点 ${node?.id ?? ""}`).trim();
}

function sourceOutputLabel(node, slot) {
	const output = node?.outputs?.[Number(slot)];
	return String(output?.label || output?.name || output?.type || `输出 ${Number(slot) + 1}`);
}

function anyPreviewLinkMemory(node) {
	const value = node?.properties?.[LAST_LINKS_PROPERTY];
	return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function saveAnyPreviewLinkMemory(node, records) {
	if (!node) {
		return;
	}
	node.properties = node.properties || {};
	node.properties[LAST_LINKS_PROPERTY] = records;
	updateReconnectButton(node);
}

function upsertAnyPreviewLinkMemory(node, record) {
	if (!node || !record?.target_input_name || record.source_id == null) {
		return false;
	}
	const records = anyPreviewLinkMemory(node).filter(
		(item) => String(item.target_input_name || "") !== String(record.target_input_name || ""),
	);
	records.push(record);
	records.sort((left, right) => getInputIndex(left.target_input_name) - getInputIndex(right.target_input_name));
	saveAnyPreviewLinkMemory(node, records);
	return true;
}

function storeAnyPreviewLink(node, input, link, targetSlot = null) {
	if (!node || !input || !link) {
		return false;
	}
	const sourceId = linkOriginId(link);
	const sourceSlot = linkOriginSlot(link);
	if (sourceId == null || !Number.isFinite(sourceSlot)) {
		return false;
	}
	const graph = node.graph || app.graph;
	const sourceNode = getGraphNodeById(sourceId, graph);
	const slot = Number.isFinite(Number(targetSlot)) ? Number(targetSlot) : linkTargetSlot(link);
	return upsertAnyPreviewLinkMemory(node, {
		source_id: sourceId,
		source_slot: sourceSlot,
		source_title: sourceNodeTitle(sourceNode),
		source_label: sourceOutputLabel(sourceNode, sourceSlot),
		target_input_name: String(input.name || ""),
		target_slot: Number.isFinite(slot) ? slot : node.inputs?.indexOf(input),
	});
}

function recordCurrentAnyPreviewLinks(node) {
	let changed = false;
	for (const input of getInputs(node)) {
		const link = getGraphLink(input?.link, node?.graph || app.graph);
		if (link) {
			changed = storeAnyPreviewLink(node, input, link, node.inputs?.indexOf(input)) || changed;
		}
	}
	return changed;
}

function recordAnyPreviewLinkFromConnectionEvent(node, args) {
	const [type, slot, connected, linkInfo] = args || [];
	const isInputEvent =
		type === globalThis.LiteGraph?.INPUT ||
		type === 1 ||
		String(type).toLowerCase() === "input";
	if (!isInputEvent) {
		return false;
	}
	const input = node?.inputs?.[Number(slot)];
	if (!input || !String(input.name || "").startsWith(INPUT_PREFIX)) {
		return false;
	}
	if (connected) {
		return recordCurrentAnyPreviewLinks(node);
	}
	return storeAnyPreviewLink(node, input, linkInfo, slot);
}

function hasReconnectTargets(node) {
	if (hasLinkedInputs(node)) {
		return false;
	}
	return anyPreviewLinkMemory(node).some((record) => record.source_id != null && Number.isFinite(Number(record.source_slot)));
}

function updateReconnectButton(node) {
	const button = node?.__gjjAnyPreviewReconnectButton;
	if (!button) {
		return;
	}
	const records = anyPreviewLinkMemory(node);
	const visible = hasReconnectTargets(node);
	button.style.display = visible ? "" : "none";
	const first = records[0];
	const label = first ? [first.source_title, first.source_label].filter(Boolean).join(" · ") : "";
	button.title = records.length > 1
		? `重新连接 ${records.length} 个上游`
		: (label ? `重新连接：${label}` : "重新连接上游");
	button.dataset.originalTitle = button.title;
}

function eventPromptId(event) {
	return event?.detail?.prompt_id || null;
}

function samePrompt(event) {
	const promptId = eventPromptId(event);
	return !(promptId && lastPromptId && promptId !== lastPromptId);
}

function eventNodeId(event) {
	return String(
		event?.detail?.node_id
			?? event?.detail?.node
			?? event?.detail?.display_node
			?? event?.detail?.nodeId
			?? "",
	);
}

function firstTextPayload(...payloads) {
	for (const payload of payloads) {
		if (payload == null) {
			continue;
		}
		if (typeof payload === "string") {
			const text = payload.trim();
			if (text) return text;
			continue;
		}
		if (Array.isArray(payload)) {
			const queue = [...payload];
			while (queue.length) {
				const item = queue.shift();
				if (Array.isArray(item)) {
					queue.unshift(...item);
				} else if (typeof item === "string") {
					const text = item.trim();
					if (text) return text;
				}
			}
		}
	}
	return "";
}

function inferMediaKind(items, fallback = "video") {
	const first = Array.isArray(items) ? items.find(isMediaFileItem) : null;
	const explicit = String(first?.media_type || first?.type_name || "").toLowerCase();
	if (explicit.includes("audio")) return "audio";
	if (explicit.includes("image")) return "image";
	if (explicit.includes("video")) return "video";
	const filename = String(first?.filename || "").toLowerCase();
	if (/\.(wav|mp3|flac|ogg|m4a|aac)$/i.test(filename)) return "audio";
	if (/\.(png|jpe?g|webp|bmp|gif)$/i.test(filename) && !/\.(gif)$/i.test(filename)) return "image";
	if (/\.(mp4|webm|mov|mkv|avi|gif)$/i.test(filename)) return "video";
	return fallback;
}

function itemWithoutLiveFields(item) {
	const { __arrivalOrder: _arrivalOrder, __inputOrder: _inputOrder, ...rest } = item;
	return rest;
}

function ensureLivePreviewState(node) {
	if (!node[LIVE_PREVIEW_STATE_KEY]) {
		node[LIVE_PREVIEW_STATE_KEY] = {
			counter: 0,
			itemsByInput: Object.create(null),
		};
	}
	return node[LIVE_PREVIEW_STATE_KEY];
}

function resetLivePreviewState(node) {
	if (!node) {
		return;
	}
	node[LIVE_PREVIEW_STATE_KEY] = {
		counter: 0,
		itemsByInput: Object.create(null),
	};
}

function findPromptNodeInfo(promptResult, node) {
	const output = promptResult?.output;
	if (!output || !node) {
		return null;
	}
	const id = String(node.id);
	if (output[id]) {
		return { id, info: output[id] };
	}
	for (const [nodeId, nodeInfo] of Object.entries(output)) {
		const tail = String(nodeId).split(":").filter(Boolean).pop();
		if (tail === id) {
			return { id: nodeId, info: nodeInfo };
		}
	}
	return null;
}

function virtualPreviewId(node, input, inputOrder) {
	return `${node.id}:gjj_any_live:${String(input?.name || inputOrder)}`;
}

function patchLiveVirtualPreviewPrompt(promptResult, graph = app.graph) {
	const output = promptResult?.output;
	if (!output || !graph?._nodes) {
		return promptResult;
	}
	liveVirtualPreviewTargets.clear();
	for (const node of graph._nodes) {
		if (!isTargetNode(node)) {
			continue;
		}
		const promptEntry = findPromptNodeInfo(promptResult, node);
		if (!promptEntry?.info?.inputs) {
			continue;
		}
		const linkedInputs = getInputs(node)
			.map((input, inputOrder) => ({ input, inputOrder, linkValue: promptEntry.info.inputs[input?.name] }))
			.filter((item) => Array.isArray(item.linkValue) && item.linkValue.length >= 2);
		if (linkedInputs.length < 2) {
			continue;
		}
		for (const item of linkedInputs) {
			const id = virtualPreviewId(node, item.input, item.inputOrder);
			if (output[id]) {
				continue;
			}
			output[id] = {
				class_type: TARGET_NODES.values().next().value,
				inputs: {
					any_01: item.linkValue,
				},
				_meta: {
					title: `GJJ AnyPreview 实时预览 ${item.inputOrder + 1}`,
				},
			};
			liveVirtualPreviewTargets.set(String(id), {
				nodeId: String(node.id),
				inputName: String(item.input?.name || ""),
				inputOrder: item.inputOrder,
			});
		}
	}
	return promptResult;
}

function patchHeldTextPassthroughPrompt(promptResult, graph = app.graph) {
	const output = promptResult?.output;
	if (!output || !graph?._nodes) {
		return promptResult;
	}
	for (const node of graph._nodes) {
		if (!isTargetNode(node)) {
			continue;
		}
		const heldText = heldTextFromProperties(node).trim();
		if (!heldText || hasLinkedInputs(node)) {
			continue;
		}
		const promptEntry = findPromptNodeInfo(promptResult, node);
		if (!promptEntry?.info) {
			continue;
		}
		promptEntry.info.inputs = promptEntry.info.inputs || {};
		promptEntry.info.inputs.any_01 = heldText;
	}
	return promptResult;
}

function installLiveVirtualPreviewPromptPatch() {
	if (app.__gjjAnyPreviewLiveVirtualPromptPatchInstalled || typeof app.graphToPrompt !== "function") {
		return;
	}
	app.__gjjAnyPreviewLiveVirtualPromptPatchInstalled = true;
	const originalGraphToPrompt = app.graphToPrompt.bind(app);
	app.graphToPrompt = async function (...args) {
		const result = await originalGraphToPrompt(...args);
		const graph = args[0] || this.rootGraph || this.graph || app.rootGraph || app.graph;
		return patchLiveVirtualPreviewPrompt(patchHeldTextPassthroughPrompt(result, graph), graph);
	};
}

function buildLivePreviewItems(event, input, inputOrder, sourceInfo) {
	const detail = event?.detail || {};
	const output = detail.output || detail || {};
	const sourceIsAudio = sourceLooksAudio(sourceInfo);
	const previewItems = normalizePreviewItemsPayload(output.preview_items);
	if (previewItems.length) {
		const mapped = previewItems.map((item, index) => {
			const normalized = {
				...item,
				ordinal: item.ordinal || inputOrder + index + 1,
				source_type: item.source_type || sourceInfo?.type || item.type_label,
			};
			return {
				...normalized,
				title: previewItemDisplayTitle(normalized, inputOrder + index),
			};
		});
		return sourceIsAudio ? mapped.filter(previewItemHasPlayableAudio) : mapped;
	}

	const previewMedia = firstMediaPayload(
		output.preview_media,
		output.preview_video,
		output.gifs,
		output.animated,
	);
	const previewMediaKind = inferMediaKind(previewMedia, "video");
	let images = firstMediaPayload(output.preview_images, output.images);
	let audio = firstMediaPayload(output.preview_audio, output.audio);
	let files = firstMediaPayload(output.preview_files, output.files);
	let video = [];
	if (previewMediaKind === "image") {
		images = images.length ? images : previewMedia;
	} else if (previewMediaKind === "audio") {
		audio = audio.length ? audio : previewMedia;
	} else {
		video = previewMedia;
	}
	if (!video.length) {
		video = firstMediaPayload(output.video, output.videos);
	}

	const text = firstTextPayload(
		output.preview_text,
		output.text,
		output.string,
		output.status,
	);
	const explicitKind = firstTextPayload(output.preview_kind).toLowerCase();
	let kind = explicitKind;
	if (!LIVE_KIND_LABELS[kind]) {
		if (video.length) kind = "video";
		else if (audio.length) kind = "audio";
		else if (files.length) kind = "3d";
		else if (images.length) kind = "image";
		else if (text) kind = "text";
		else kind = "other";
	}
	if (!video.length && !audio.length && !images.length && !files.length && !text) {
		return [];
	}
	if (sourceIsAudio && !audio.length) {
		return [];
	}

	const sourceType = normalizePreviewTypeLabel(sourceInfo?.type, KIND_TYPE_LABELS[kind] || KIND_TYPE_LABELS.other);
	const item = {
		kind,
		source_kind: kind,
		source_type: sourceType,
		type_label: sourceType,
		type_emoji: KIND_EMOJIS[kind] || KIND_EMOJIS.other,
		ordinal: inputOrder + 1,
		ordinal_emoji: ordinalEmoji(inputOrder + 1),
		title: "",
		text,
	};
	item.title = previewItemDisplayTitle(item, inputOrder);
	if (images.length) item.images = images;
	if (audio.length) item.audio = audio;
	if (video.length) item.video = video;
	if (files.length) item.files = files;
	return [item];
}

function retitleLiveItemsForInput(items, inputOrder) {
	return (Array.isArray(items) ? items : []).map((item, index) => {
		const normalized = {
			...item,
			ordinal: inputOrder + index + 1,
			ordinal_emoji: ordinalEmoji(inputOrder + index + 1),
		};
		return {
			...normalized,
			title: previewItemDisplayTitle(normalized, inputOrder + index),
		};
	});
}

function linkedInputEntries(node) {
	return getInputs(node)
		.map((input, inputOrder) => ({ input, inputOrder }))
		.filter(({ input }) => input?.link != null);
}

function applyExecutedMessageAsLiveInput(node, message) {
	const linked = linkedInputEntries(node);
	if (linked.length < 2) {
		return false;
	}
	const entry = linked.find(({ input }) => {
		const state = node?.[LIVE_PREVIEW_STATE_KEY];
		return !state?.itemsByInput?.[String(input?.name || "")];
	}) || linked[0];
	const sourceInfo = getLinkedSourceInfo(entry.input) || {
		type: entry.input?.type || "*",
		label: entry.input?.label || entry.input?.name || "*",
	};
	const syntheticEvent = { detail: { output: message || {} } };
	const items = buildLivePreviewItems(syntheticEvent, entry.input, entry.inputOrder, sourceInfo);
	if (!items.length) {
		return false;
	}
	applyLivePreviewItems(node, entry.input, entry.inputOrder, retitleLiveItemsForInput(items, entry.inputOrder));
	return true;
}

function applyLivePreviewItems(node, input, inputOrder, items) {
	if (!node) {
		return;
	}
	const state = ensureLivePreviewState(node);
	const key = String(input?.name || inputOrder);
	if (!items.length) {
		delete state.itemsByInput[key];
	} else {
		state.itemsByInput[key] = items.map((item, index) => ({
			...item,
			__inputOrder: inputOrder,
			__arrivalOrder: ++state.counter + index / 1000,
		}));
	}
	const previewItems = Object.values(state.itemsByInput)
		.flat()
		.sort((a, b) => {
			const arrival = Number(a.__arrivalOrder || 0) - Number(b.__arrivalOrder || 0);
			if (arrival !== 0) return arrival;
			return Number(a.__inputOrder || 0) - Number(b.__inputOrder || 0);
		})
		.map(itemWithoutLiveFields);
	if (!previewItems.length) {
		if (node.__gjjAnyPreviewLiveOnly) {
			node.__gjjAnyPreviewKind = "";
			node.__gjjAnyPreviewText = "";
			node.__gjjAnyPreviewItems = [];
			ensurePreviewWidget(node);
			applyPreviewContent(node);
			updateLayout(node);
			scheduleLayout(node);
			setDirty(node);
		}
		return;
	}

	node.__gjjAnyPreviewKind = "mixed";
	node.__gjjAnyPreviewLiveOnly = true;
	node.__gjjAnyPreviewText = previewItems.length
		? `已按进入顺序刷新 ${previewItems.length} 个预览项目`
		: "";
	node.__gjjAnyPreviewItems = previewItems;
	node.__gjjAnyPreviewImages = [];
	node.__gjjAnyPreviewAudio = [];
	node.__gjjAnyPreviewVideo = [];
	clearNativeImagePreviewState(node);
	ensurePreviewWidget(node);
	applyPreviewContent(node);
	rememberCurrentPreviewAsHeld(node, false);
	updateLayout(node);
	scheduleLayout(node);
	setDirty(node);
}

function livePreviewItemsByArrival(node) {
	const state = node?.[LIVE_PREVIEW_STATE_KEY];
	if (!state?.itemsByInput) {
		return [];
	}
	return Object.values(state.itemsByInput)
		.flat()
		.sort((a, b) => {
			const arrival = Number(a.__arrivalOrder || 0) - Number(b.__arrivalOrder || 0);
			if (arrival !== 0) return arrival;
			return Number(a.__inputOrder || 0) - Number(b.__inputOrder || 0);
		});
}

function reorderPreviewItemsByLiveOrder(node, items) {
	if (!Array.isArray(items) || !items.length) {
		return items;
	}
	const liveItems = livePreviewItemsByArrival(node);
	if (!liveItems.length || liveItems.length !== items.length) {
		return items;
	}
	const used = new Set();
	const reordered = [];
	for (const liveItem of liveItems) {
		const index = Number(liveItem.__inputOrder);
		if (!Number.isInteger(index) || index < 0 || index >= items.length || used.has(index)) {
			return items;
		}
		used.add(index);
		reordered.push(items[index]);
	}
	return reordered.length === items.length ? reordered : items;
}

function refreshLivePreviewFromExecuted(event) {
	if (!samePrompt(event)) {
		return;
	}
	const sourceId = eventNodeId(event);
	if (!sourceId) {
		return;
	}
	const virtualTarget = liveVirtualPreviewTargets.get(String(sourceId));
	if (virtualTarget) {
		const target = getGraphNodeById(virtualTarget.nodeId);
		if (!target) {
			return;
		}
		const input = getInputs(target).find((item) => String(item?.name || "") === virtualTarget.inputName);
		if (!input) {
			return;
		}
		const sourceInfo = getLinkedSourceInfo(input) || {
			type: input.type || "*",
			label: input.label || input.name || "*",
		};
		const items = buildLivePreviewItems(event, input, virtualTarget.inputOrder, sourceInfo);
		applyLivePreviewItems(target, input, virtualTarget.inputOrder, retitleLiveItemsForInput(items, virtualTarget.inputOrder));
		return;
	}
	const sourceNode = getGraphNodeById(sourceId);
	if (isTargetNode(sourceNode)) {
		return;
	}
	for (const node of app.graph?._nodes || []) {
		if (!isTargetNode(node) || String(node.id) === String(sourceId)) {
			continue;
		}
		const inputs = getInputs(node);
		for (const [inputOrder, input] of inputs.entries()) {
			if (!input?.link) {
				continue;
			}
			const sourceInfo = getLinkedSourceInfo(input);
			if (String(sourceInfo?.sourceNode?.id || "") !== String(sourceId)) {
				continue;
			}
			const items = buildLivePreviewItems(event, input, inputOrder, sourceInfo);
			applyLivePreviewItems(node, input, inputOrder, items);
		}
	}
}

function setDirty(node) {
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function currentNodeWidth(node) {
	const width = Number(node?.size?.[0]);
	return Number.isFinite(width) && width > 0 ? width : 0;
}

function rememberNodeWidth(node, width = currentNodeWidth(node)) {
	if (!node || !Number.isFinite(Number(width)) || Number(width) <= 0) {
		return;
	}
	node.properties = node.properties || {};
	const nextWidth = Math.max(MIN_WIDTH, Number(width));
	node.properties[WIDTH_PROPERTY] = nextWidth;
	node.__gjjAnyPreviewUserWidth = nextWidth;
}

function serializedNodeWidth(serializedNode) {
	const size = serializedNode?.size;
	if (Array.isArray(size)) {
		const width = Number(size[0]);
		if (Number.isFinite(width) && width > 0) return width;
	}
	const propertyWidth = Number(serializedNode?.properties?.[WIDTH_PROPERTY]);
	return Number.isFinite(propertyWidth) && propertyWidth > 0 ? propertyWidth : 0;
}

function storedNodeWidth(node) {
	for (const value of [
		node?.__gjjAnyPreviewUserWidth,
		node?.properties?.[WIDTH_PROPERTY],
		node?.__gjjAnyPreviewConfiguredWidth,
	]) {
		const width = Number(value);
		if (Number.isFinite(width) && width > 0) {
			return Math.max(MIN_WIDTH, width);
		}
	}
	return 0;
}

function preferredNodeWidth(node) {
	return Math.max(MIN_WIDTH, currentNodeWidth(node), storedNodeWidth(node));
}

function setNodeSizeInternal(node, width, height) {
	if (!node || typeof node.setSize !== "function") {
		return;
	}
	const token = Number(node.__gjjAnyPreviewInternalResizeToken || 0) + 1;
	node.__gjjAnyPreviewInternalResizeToken = token;
	node.__gjjAnyPreviewInternalResize = true;
	node.setSize([width, height]);
	requestAnimationFrame(() => {
		if (node.__gjjAnyPreviewInternalResizeToken === token) {
			node.__gjjAnyPreviewInternalResize = false;
		}
	});
}

function snapNodeHeight(height) {
	const numericHeight = Number(height);
	if (!Number.isFinite(numericHeight)) {
		return MIN_NODE_HEIGHT;
	}
	return Math.max(MIN_NODE_HEIGHT, Math.ceil(numericHeight / 2) * 2);
}

function restoreConfiguredWidth(node) {
	const width = Number(node?.__gjjAnyPreviewConfiguredWidth || node?.properties?.[WIDTH_PROPERTY] || 0);
	const currentWidth = currentNodeWidth(node);
	if (!node || !Number.isFinite(width) || width <= 0 || !currentWidth || Math.abs(currentWidth - width) < 0.5) {
		return;
	}
	const height = Math.max(MIN_NODE_HEIGHT, Number(node.size?.[1] || MIN_NODE_HEIGHT));
	setNodeSizeInternal(node, Math.max(MIN_WIDTH, width), height);
}

function setNodeHeightFromContent(node, height) {
	const width = preferredNodeWidth(node);
	if (!node || !width || !Number.isFinite(Number(height))) {
		return false;
	}
	const nextHeight = snapNodeHeight(height);
	const currentWidth = currentNodeWidth(node);
	const currentHeight = Number(node.size?.[1] || MIN_NODE_HEIGHT);
	if (
		Math.abs(nextHeight - currentHeight) < 0.5 &&
		(!currentWidth || Math.abs(width - currentWidth) < 0.5)
	) {
		return false;
	}
	setNodeSizeInternal(node, width, nextHeight);
	return true;
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

function getWidgetTopOffset(node) {
	const widget = node?.__gjjAnyPreviewWidget;
	return Math.max(
		0,
		Number(widget?.y || 0),
		Number(widget?.last_y || 0),
	);
}

function refreshLayout(node) {
	const height = Math.max(
		MIN_NODE_HEIGHT,
		Number(node.size?.[1] || MIN_NODE_HEIGHT),
	);
	setNodeHeightFromContent(node, height);
	setDirty(node);
}

function mediaItemDimensions(item) {
	const width = Number(item?.width || item?.preview_width || item?.w);
	const height = Number(item?.height || item?.preview_height || item?.h);
	return {
		width: Number.isFinite(width) && width > 0 ? width : 0,
		height: Number.isFinite(height) && height > 0 ? height : 0,
	};
}

function mediaItemAspectRatio(item, fallback = 1) {
	const { width, height } = mediaItemDimensions(item);
	if (width > 0 && height > 0) {
		return Math.max(0.1, Math.min(10, width / height));
	}
	return fallback;
}

function mediaItemAspectRatioCss(item, fallback = "1 / 1") {
	const { width, height } = mediaItemDimensions(item);
	return width > 0 && height > 0 ? `${width} / ${height}` : fallback;
}

function estimateImagePreviewHeight(node) {
	const images = Array.isArray(node?.__gjjAnyPreviewImages)
		? node.__gjjAnyPreviewImages
		: [];
	const count = Math.max(1, images.length || 1);

	const nodeWidth = preferredNodeWidth(node);
	// 减去 padding 和 border
	const contentWidth = Math.max(220, nodeWidth - 36);

	if (count === 1) {
		// 单图模式：根据真实宽高比动态计算高度，避免 DOM 内部再出现纵向滚动条。
		const aspectRatio = mediaItemAspectRatio(images[0], 1);
		const imageHeight = contentWidth / aspectRatio;
		return Math.max(IMAGE_PREVIEW_MIN_HEIGHT, imageHeight + 24);
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

function shouldUseEstimatedImageLayout(node) {
	if (String(node?.__gjjAnyPreviewKind || "") !== "image") {
		return false;
	}
	if (Array.isArray(node?.__gjjAnyPreviewItems) && node.__gjjAnyPreviewItems.length > 0) {
		return false;
	}
	const images = Array.isArray(node?.__gjjAnyPreviewImages)
		? node.__gjjAnyPreviewImages
		: [];
	return !images.some(isSequenceMediaItem) && images.length < IMAGE_SEQUENCE_MIN_FRAMES;
}

function hasPreviewItems(node) {
	return Array.isArray(node?.__gjjAnyPreviewItems) && node.__gjjAnyPreviewItems.length > 0;
}

function hasCompactTilePreview(node) {
	const images = Array.isArray(node?.__gjjAnyPreviewImages)
		? node.__gjjAnyPreviewImages
		: [];
	return (
		String(node?.__gjjAnyPreviewKind || "") === "image" &&
		isTileMode(node) &&
		tileImageEntriesFromImages(images).length > 1
	);
}

function previewContentWidth(node) {
	const container = node?.__gjjAnyPreviewContainer;
	const rawWidth = Number(container?.clientWidth || container?.offsetWidth || currentNodeWidth(node) || preferredNodeWidth(node));
	return Math.max(1, Math.round(rawWidth - 20));
}

function compactTileEntryCount(node) {
	const explicit = Number(node?.__gjjAnyPreviewCompactTileEntries || 0);
	if (Number.isFinite(explicit) && explicit > 1) {
		return Math.floor(explicit);
	}
	if (hasCompactTilePreview(node)) {
		const images = Array.isArray(node?.__gjjAnyPreviewImages)
			? node.__gjjAnyPreviewImages
			: [];
		return tileImageEntriesFromImages(images).length;
	}
	return 0;
}

function isCompactTileGrid(node) {
	return compactTileEntryCount(node) > 1;
}

function compactTileChildHeight(node) {
	const grid = node?.__gjjAnyPreviewGrid;
	const children = Array.from(grid?.children || []).filter((child) => child?.style?.display !== "none");
	if (!children.length) {
		return 0;
	}
	let top = Infinity;
	let bottom = 0;
	for (const child of children) {
		const childTop = Number(child.offsetTop || 0);
		const childHeight = Number(child.offsetHeight || 0);
		if (!Number.isFinite(childHeight) || childHeight <= 0) {
			continue;
		}
		top = Math.min(top, childTop);
		bottom = Math.max(bottom, childTop + childHeight);
	}
	return Number.isFinite(top) && bottom > top ? Math.ceil(bottom - top) : 0;
}

function compactTileChromeHeight(node) {
	const copyBar = node?.__gjjAnyPreviewCopyBar;
	const copyBarHeight =
		copyBar && copyBar.style.display !== "none"
			? Number(copyBar.offsetHeight || 0) + 6
			: 0;
	return copyBarHeight + 16;
}

function estimateCompactTileHeight(node) {
	const count = compactTileEntryCount(node);
	if (count <= 1) {
		return MIN_PREVIEW_HEIGHT;
	}
	const childHeight = compactTileChildHeight(node);
	if (childHeight > 0) {
		return Math.max(MIN_PREVIEW_HEIGHT, childHeight + compactTileChromeHeight(node));
	}
	const contentWidth = previewContentWidth(node);
	const tileWidth = 96;
	const gap = 2;
	const columns = Math.max(1, Math.min(count, Math.floor((contentWidth + gap) / (tileWidth + gap))));
	const rows = Math.max(1, Math.ceil(count / columns));
	return Math.max(
		MIN_PREVIEW_HEIGHT,
		rows * tileWidth + (rows - 1) * gap + compactTileChromeHeight(node),
	);
}

function clampCompactTileDomHeight(node, height = null) {
	if (!isCompactTileGrid(node) && !hasCompactTilePreview(node)) {
		return;
	}
	const nextHeight = Math.max(MIN_PREVIEW_HEIGHT, Math.ceil(Number(height || estimateCompactTileHeight(node)) || MIN_PREVIEW_HEIGHT));
	const container = node?.__gjjAnyPreviewContainer;
	const previewWrap = node?.__gjjAnyPreviewWrap;
	if (container) {
		container.style.height = `${nextHeight}px`;
		container.style.minHeight = "0";
		container.style.overflow = "visible";
	}
	if (previewWrap) {
		previewWrap.style.height = `${nextHeight}px`;
		previewWrap.style.minHeight = "0";
		previewWrap.style.maxHeight = `${nextHeight}px`;
		previewWrap.style.overflow = "visible";
	}
}

function estimatePreviewItemsHeight(node) {
	const count = Array.isArray(node?.__gjjAnyPreviewItems) ? node.__gjjAnyPreviewItems.length : 0;
	if (!count) {
		return MIN_PREVIEW_HEIGHT;
	}
	const contentWidth = previewContentWidth(node);
	const columns = Math.min(
		count,
		Math.max(1, Math.floor((contentWidth + MULTI_OBJECT_TILE_GAP) / (MULTI_OBJECT_TILE_MIN_WIDTH + MULTI_OBJECT_TILE_GAP))),
	);
	const rows = Math.max(1, Math.ceil(count / columns));
	const tileWidth = Math.max(
		124,
		Math.floor((contentWidth - (columns - 1) * MULTI_OBJECT_TILE_GAP) / columns),
	);
	return Math.max(
		MIN_PREVIEW_HEIGHT,
		rows * tileWidth + (rows - 1) * MULTI_OBJECT_TILE_GAP + 18,
	);
}

function measurePreviewItemsHeight(node) {
	const container = node?.__gjjAnyPreviewContainer;
	const previewWrap = node?.__gjjAnyPreviewWrap;
	const grid = node?.__gjjAnyPreviewGrid;
	if (!container || !grid) {
		return estimatePreviewItemsHeight(node);
	}
	if (previewWrap) {
		previewWrap.style.height = "auto";
		previewWrap.style.minHeight = "96px";
		previewWrap.style.overflow = "visible";
	}
	container.style.height = "auto";
	container.style.minHeight = `${MIN_PREVIEW_HEIGHT}px`;
	grid.style.height = "auto";
	grid.style.minHeight = "0";
	if (isCompactTileGrid(node)) {
		const compactHeight = estimateCompactTileHeight(node);
		clampCompactTileDomHeight(node, compactHeight);
		return compactHeight;
	}
	const copyBar = node?.__gjjAnyPreviewCopyBar;
	const copyBarHeight =
		copyBar && copyBar.style.display !== "none"
			? Number(copyBar.offsetHeight || 0) + 6
			: 0;
	const measured = Number(grid.scrollHeight || 0) + copyBarHeight + 16;
	const estimated = estimatePreviewItemsHeight(node);
	const safeMeasured = measured > estimated * 1.35 + 80 ? estimated : measured;
	return Math.max(MIN_PREVIEW_HEIGHT, Math.ceil(safeMeasured || estimated));
}

function getWidgetHeight(node, widget) {
	if (shouldUseEstimatedImageLayout(node)) {
		return estimateImagePreviewHeight(node);
	}
	if (hasPreviewItems(node)) {
		return measurePreviewItemsHeight(node);
	}
	if (hasCompactTilePreview(node) || isCompactTileGrid(node)) {
		return measurePreviewItemsHeight(node);
	}
	const nodeHeight = Math.max(
		MIN_NODE_HEIGHT,
		Number(node?.size?.[1] || MIN_NODE_HEIGHT),
	);
	const topOffset = Math.max(0, getWidgetTopOffset(node), Number(widget?.y || 0), Number(widget?.last_y || 0));
	const availableHeight = nodeHeight - topOffset - NODE_BOTTOM_PADDING;
	return Math.max(
		MIN_PREVIEW_HEIGHT,
		node?.__gjjAnyPreviewHeight || availableHeight,
	);
}

function updateLayout(node) {
	if (!node) {
		return;
	}

	const topOffset = getWidgetTopOffset(node);
	const useEstimatedImageLayout = shouldUseEstimatedImageLayout(node);
	const useCompactTileLayout = hasCompactTilePreview(node) || isCompactTileGrid(node);
	const container = node.__gjjAnyPreviewContainer;
	const previewWrap = node.__gjjAnyPreviewWrap;
	if (!useEstimatedImageLayout && !useCompactTileLayout && container && previewWrap) {
		container.style.height = "auto";
		previewWrap.style.height = "auto";
		previewWrap.style.maxHeight = "";
		previewWrap.style.overflow = "visible";
	}
	const previewHeight = useEstimatedImageLayout
		? estimateImagePreviewHeight(node)
		: hasPreviewItems(node) || useCompactTileLayout
			? measurePreviewItemsHeight(node)
		: measureHeight(node);
	const height = Math.max(
		MIN_NODE_HEIGHT,
		topOffset + previewHeight + NODE_BOTTOM_PADDING,
	);
	if (container && previewWrap) {
		const availableHeight = height - topOffset - NODE_BOTTOM_PADDING;
		if (useEstimatedImageLayout) {
			container.style.height = `${Math.max(MIN_PREVIEW_HEIGHT, availableHeight)}px`;
			previewWrap.style.height = `${Math.max(MIN_PREVIEW_HEIGHT, availableHeight)}px`;
			previewWrap.style.maxHeight = "";
			previewWrap.style.overflow = "visible";
		} else if (useCompactTileLayout) {
			clampCompactTileDomHeight(node, availableHeight);
		} else {
			container.style.height = "auto";
			container.style.minHeight = `${MIN_PREVIEW_HEIGHT}px`;
			previewWrap.style.height = "auto";
			previewWrap.style.minHeight = "96px";
			previewWrap.style.maxHeight = "";
			previewWrap.style.overflow = "visible";
		}
	}

	// 只同步内部计算出的高度；如果宽度发生布局漂移，则恢复到已保存的节点宽度。
	const currentWidth = currentNodeWidth(node);
	const nextWidth = preferredNodeWidth(node);
	const currentHeight = Number(node.size?.[1] || MIN_NODE_HEIGHT);
	if (
		Math.abs(height - currentHeight) >= 0.5 ||
		(currentWidth && Math.abs(nextWidth - currentWidth) >= 0.5)
	) {
		setNodeHeightFromContent(node, height);
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
		node.addOutput?.("透传输出", "*");
	}
}

function addDynamicInput(node) {
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
		addDynamicInput(node);
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
		input.label = index === 0 ? FIRST_INPUT_LABEL : `${FIRST_INPUT_LABEL} ${index + 1}`;
		input.localized_name = input.label;
		input.tooltip = INPUT_TOOLTIP;
	});
}

function resolveOutputMode(node) {
	const linkedInputs = getInputs(node).filter((input) => input?.link);
	const firstLinked = linkedInputs[0];
	const info = firstLinked ? getLinkedOutputInfo(firstLinked) : null;
	if (linkedInputs.length > 1) {
		return {
			type: "*",
			name: "透传输出",
			tooltip: "多口输入时按端口顺序包装成列表序列传给下游。",
		};
	}
	return {
		type: info?.type || "*",
		name: "透传输出",
		tooltip: "单口输入原样透传；预览区会照常显示输入对象。",
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
	// 非表格段落里的 || 只按普通文本显示；表格行会在 renderMarkdown 里先拆分。
	output = output.replace(/\|\|/g, "&#124;&#124;");
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

function renderTableCell(tag, value) {
	return `<${tag}>${renderInlineMarkdown(value)}</${tag}>`;
}

function renderDoublePipeTable(rows) {
	const parsedRows = rows
		.map(splitDoublePipeTableRow)
		.filter((cells) => cells.length >= 2);
	if (!parsedRows.length) {
		return "";
	}

	const header = parsedRows[0];
	const bodyRows = parsedRows
		.slice(1)
		.filter((cells) => !isMarkdownTableSeparatorRow(cells));
	const columnCount = Math.max(
		header.length,
		...bodyRows.map((cells) => cells.length),
	);
	const padCells = (cells) => {
		const padded = cells.slice(0, columnCount);
		while (padded.length < columnCount) {
			padded.push("");
		}
		return padded;
	};

	const headHtml = `<thead><tr>${padCells(header).map((cell) => renderTableCell("th", cell)).join("")}</tr></thead>`;
	const bodyHtml = bodyRows.length
		? `<tbody>${bodyRows.map((cells) => `<tr>${padCells(cells).map((cell) => renderTableCell("td", cell)).join("")}</tr>`).join("")}</tbody>`
		: "";
	return `<div class="gjj-any-preview-table-scroll"><table>${headHtml}${bodyHtml}</table></div>`;
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
	const table = { rows: [] };

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

	const flushTable = () => {
		if (!table.rows.length) {
			return;
		}
		parts.push(renderDoublePipeTable(table.rows));
		table.rows.length = 0;
	};

	for (const line of lines) {
		const trimmed = line.trim();

		// 处理空行 - 刷新所有缓冲区
		if (!trimmed) {
			flushParagraph();
			flushList();
			flushTable();
			continue;
		}

		// 处理双竖线表格：序号||生成图片提示词||变装提示词
		if (isDoublePipeTableLine(trimmed)) {
			flushParagraph();
			flushList();
			table.rows.push(trimmed);
			continue;
		}

		flushTable();

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
	flushTable();

	return parts.join("");
}

async function copyTextToClipboard(text) {
	const value = String(text || "");
	if (!value) return false;
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(value);
			return true;
		}
	} catch (_) {
		// 继续走 textarea 回退方案。
	}
	const textarea = document.createElement("textarea");
	textarea.value = value;
	textarea.style.cssText = [
		"position:fixed",
		"left:-9999px",
		"top:0",
		"opacity:0",
	].join(";");
	document.body.appendChild(textarea);
	textarea.focus();
	textarea.select();
	let copied = false;
	try {
		copied = !!document.execCommand("copy");
	} catch (_) {
		copied = false;
	}
	textarea.remove();
	return copied;
}

function setupIconButton(button, label, svg) {
	button.innerHTML = svg;
	button.title = label;
	button.setAttribute("aria-label", label);
	button.dataset.originalTitle = label;
}

function flashActionButton(button, text, ok = true) {
	if (!button) return;
	const originalTitle = button.dataset.originalTitle || button.title || "";
	button.dataset.originalTitle = originalTitle;
	clearTimeout(button.__gjjAnyPreviewFlashTimer);
	button.title = text;
	button.style.background = ok ? "#143126" : "#351d1d";
	button.style.borderColor = ok ? "#66d19e" : "#c95d5d";
	button.__gjjAnyPreviewFlashTimer = setTimeout(() => {
		button.title = button.dataset.originalTitle || originalTitle;
		button.style.background = "";
		button.style.borderColor = "";
		button.__gjjAnyPreviewFlashTimer = null;
	}, 1100);
}

function previewItemTextForCopy(item, index = 0) {
	const lines = [];
	const title = String(item?.title || previewItemDisplayTitle(item, index)).trim();
	if (title) lines.push(title);
	const text = String(item?.text || "").trim();
	if (text) lines.push(text);
	for (const [label, payload] of [
		["图片", item?.images],
		["音频", item?.audio],
		["视频", item?.video],
		["文件", item?.files],
	]) {
		const files = normalizeMediaPayload(payload)
			.map((entry) => entry?.filename || entry?.name || entry?.url || "")
			.filter(Boolean);
		if (files.length) {
			lines.push(`${label}: ${files.join(", ")}`);
		}
	}
	return lines.join("\n");
}

function currentPreviewTextForCopy(node) {
	const items = Array.isArray(node?.__gjjAnyPreviewItems) ? node.__gjjAnyPreviewItems : [];
	if (items.length) {
		return items.map(previewItemTextForCopy).filter(Boolean).join("\n\n");
	}
	return String(node?.__gjjAnyPreviewText || "").trim();
}

function hasCurrentPreviewContent(node) {
	if (!hasLinkedInputs(node)) {
		return false;
	}
	if (String(node?.__gjjAnyPreviewText || "").trim()) return true;
	if (Array.isArray(node?.__gjjAnyPreviewItems) && node.__gjjAnyPreviewItems.length) return true;
	if (currentPreviewImages(node).length) return true;
	if (Array.isArray(node?.__gjjAnyPreviewAudio) && node.__gjjAnyPreviewAudio.length) return true;
	if (Array.isArray(node?.__gjjAnyPreviewVideo) && node.__gjjAnyPreviewVideo.length) return true;
	if (Array.isArray(node?.__gjjAnyPreviewFiles) && node.__gjjAnyPreviewFiles.length) return true;
	return false;
}

function previewTileCandidateCount(node) {
	const items = Array.isArray(node?.__gjjAnyPreviewItems) ? node.__gjjAnyPreviewItems : [];
	if (items.length) {
		return items.reduce((total, item) => total + countTileImages(item?.images), 0);
	}
	return countTileImages(currentPreviewImages(node));
}

function updatePreviewActionButtons(node) {
	const copyBar = node?.__gjjAnyPreviewCopyBar;
	if (!copyBar) return;
	const hasContent = hasCurrentPreviewContent(node);
	const reconnect = hasReconnectTargets(node);
	copyBar.style.display = hasContent || reconnect ? "flex" : "none";
	updateReconnectButton(node);
	const tileButton = node.__gjjAnyPreviewTileButton;
	const canTile = previewTileCandidateCount(node) > 1;
	if (tileButton) {
		tileButton.style.display = hasContent && canTile ? "" : "none";
		tileButton.textContent = isTileMode(node) ? "列表" : "平铺";
		tileButton.title = isTileMode(node) ? "切回列表预览" : "切换为紧凑平铺预览";
		tileButton.dataset.originalTitle = tileButton.title;
	}
	if (!hasContent) {
		for (const button of [
			node.__gjjAnyPreviewHoldButton,
			node.__gjjAnyPreviewRunButton,
			node.__gjjAnyPreviewTileButton,
			node.__gjjAnyPreviewCopyNodeButton,
			node.__gjjAnyPreviewCopyClipboardButton,
		]) {
			if (button) button.style.display = "none";
		}
		return;
	}
	const text = currentPreviewTextForCopy(node);
	const hasText = Boolean(text.trim());
	const hasImages = currentPreviewImages(node).length > 0;
	for (const button of [node.__gjjAnyPreviewHoldButton, node.__gjjAnyPreviewRunButton]) {
		if (button) button.style.display = "";
	}
	if (node.__gjjAnyPreviewCopyNodeButton) {
		node.__gjjAnyPreviewCopyNodeButton.style.display = hasImages || hasText ? "" : "none";
		node.__gjjAnyPreviewCopyNodeButton.title = hasImages
			? "复制节点：在当前节点旁边新建 GJJ_AnyPreview，并把图片复制到 input 后保存到工作流"
			: "复制节点：在当前节点旁边新建 GJJ_TextInput，并填入当前预览文本";
		node.__gjjAnyPreviewCopyNodeButton.dataset.originalTitle = node.__gjjAnyPreviewCopyNodeButton.title;
	}
	if (node.__gjjAnyPreviewCopyClipboardButton) {
		node.__gjjAnyPreviewCopyClipboardButton.style.display = hasText ? "" : "none";
	}
	if (node.__gjjAnyPreviewHoldButton) {
		node.__gjjAnyPreviewHoldButton.title = hasImages
			? "保持图片预览并断开链接"
			: "保持文本并断开链接";
		node.__gjjAnyPreviewHoldButton.dataset.originalTitle = node.__gjjAnyPreviewHoldButton.title;
	}
}

function setTextInputNodeValue(node, text) {
	const value = String(text ?? "");
	const widget = node?.widgets?.find((item) => item?.name === "text");
	if (widget) {
		widget.value = value;
		if (widget.inputEl) widget.inputEl.value = value;
		if (widget.element && "value" in widget.element) widget.element.value = value;
		widget.callback?.(value);
	}
	node.properties = node.properties || {};
	node.properties[TEXT_INPUT_SAVED_TEXT_PROPERTY] = value;
}

function nodeRect(node, fallbackWidth = MIN_WIDTH, fallbackHeight = 120) {
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

function nextAnyPreviewCopyPosition(sourceNode, copyNode, graph) {
	const source = nodeRect(sourceNode);
	const copy = nodeRect(copyNode, MIN_WIDTH, Math.max(120, source.height));
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

async function copyImagesToInput(images) {
	const response = await api.fetchApi("/gjj/any_preview/copy_media_to_input", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			images: images.map((item) => ({ ...item })),
		}),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok || !Array.isArray(data?.images) || !data.images.length) {
		throw new Error(data?.error || "复制图片失败");
	}
	return normalizeMediaPayload(data.images);
}

async function copyMediaToInput(items) {
	const response = await api.fetchApi("/gjj/any_preview/copy_media_to_input", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			media: items.map((item) => ({ ...item })),
		}),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok || !Array.isArray(data?.media) || !data.media.length) {
		throw new Error(data?.error || "复制媒体失败");
	}
	return normalizeMediaPayload(data.media);
}

function imageFilesFromDropEvent(event) {
	const files = Array.from(event?.dataTransfer?.files || []);
	return files.filter((file) => String(file?.type || "").startsWith("image/") || /\.(png|jpe?g|webp|bmp|gif)$/i.test(file?.name || ""));
}

function fileBrowserDropPayload(event) {
	const transfer = event?.dataTransfer;
	if (!transfer) return null;
	const raw = transfer.getData?.(GJJ_FILE_DRAG_MIME) || "";
	if (!raw) return null;
	try {
		const payload = JSON.parse(raw);
		const path = String(payload?.path || "").trim();
		if (!path) return null;
		return { path, name: String(payload?.name || "") };
	} catch (_) {
		return null;
	}
}

function hasFileBrowserDrop(event) {
	return Array.from(event?.dataTransfer?.types || []).includes(GJJ_FILE_DRAG_MIME) || Boolean(fileBrowserDropPayload(event));
}

async function uploadDroppedImagesToTemp(files) {
	const form = new FormData();
	for (const file of files) {
		form.append("images", file, file.name || "image.png");
	}
	const response = await api.fetchApi("/gjj/any_preview/upload_temp_image", {
		method: "POST",
		body: form,
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok || !Array.isArray(data?.images) || !data.images.length) {
		throw new Error(data?.error || "图片上传失败");
	}
	return normalizeMediaPayload(data.images);
}

async function importLocalFileFromBrowserNode(node, payload) {
	if (!node || !payload?.path) return;
	setDropTargetActive(node, true, "导入文件中...");
	try {
		const response = await api.fetchApi("/gjj/any_preview/import_local_file", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: payload.path }),
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok || !data?.kind) throw new Error(data?.error || "导入文件失败");
		node.properties = node.properties || {};
		disconnectLinkedInputs(node);
		delete node.properties[HELD_TEXT_PROPERTY];
		delete node.properties[HELD_IMAGES_PROPERTY];
		delete node.properties[HELD_MEDIA_PROPERTY];
		resetLivePreviewState(node);
		const items = normalizeMediaPayload(data.items);
		if (data.kind === "text") {
			node.properties[HELD_TEXT_PROPERTY] = String(data.text || payload.path);
		} else if (data.kind === "image") {
			node.properties[HELD_IMAGES_PROPERTY] = items.map((item) => ({ ...item }));
		} else if (["audio", "video", "3d"].includes(String(data.kind))) {
			node.properties[HELD_MEDIA_PROPERTY] = {
				kind: String(data.kind),
				items: items.map((item) => ({ ...item })),
				text: String(data.text || payload.path),
			};
		} else {
			node.properties[HELD_TEXT_PROPERTY] = String(data.text || payload.path);
		}
		applyHeldPreview(node);
		scheduleStabilize(node, 0);
		setDirty(node);
	} catch (error) {
		console.warn("[GJJ_AnyPreview] import local file failed", error);
		setDropTargetActive(node, true, error?.message || "导入失败");
		setTimeout(() => setDropTargetActive(node, false), 1400);
		return;
	}
	setDropTargetActive(node, false);
}

function anyPreviewNodeAtClientPoint(clientX, clientY) {
	const nodes = Array.isArray(app.graph?._nodes) ? app.graph._nodes : [];
	for (let index = nodes.length - 1; index >= 0; index -= 1) {
		const node = nodes[index];
		if (node?.comfyClass !== "GJJ_AnyPreview") continue;
		const elements = [
			node.__gjjAnyPreviewWrap,
			node.__gjjAnyPreviewContainer,
			node.__gjjAnyPreviewBody,
			node.__gjjAnyPreviewGrid,
			node.__gjjAnyPreviewEmpty,
		].filter(Boolean);
		for (const element of elements) {
			const rect = element.getBoundingClientRect?.();
			if (!rect) continue;
			if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
				return node;
			}
		}
	}
	return null;
}

function canvasPointFromClient(clientX, clientY) {
	const event = { clientX: Number(clientX), clientY: Number(clientY) };
	if (app.canvas?.convertEventToCanvasOffset) {
		try {
			const point = app.canvas.convertEventToCanvasOffset(event);
			if (Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])) {
				return [Math.round(point[0]), Math.round(point[1])];
			}
		} catch (_) {}
	}
	const canvas = app.canvas?.canvas;
	const rect = canvas?.getBoundingClientRect?.();
	const ds = app.canvas?.ds;
	if (rect && ds) {
		const scale = Number(ds.scale || 1);
		const offset = Array.isArray(ds.offset) ? ds.offset : [0, 0];
		return [
			Math.round((Number(clientX) - rect.left) / Math.max(0.01, scale) - Number(offset[0] || 0)),
			Math.round((Number(clientY) - rect.top) / Math.max(0.01, scale) - Number(offset[1] || 0)),
		];
	}
	return [Number(app.canvas?.graph_mouse?.[0] || 0), Number(app.canvas?.graph_mouse?.[1] || 0)];
}

function createAnyPreviewAtClientPoint(clientX, clientY) {
	const graph = app.canvas?.graph || app.graph;
	const node = globalThis.LiteGraph?.createNode?.("GJJ_AnyPreview");
	if (!graph || !node) return null;
	const [x, y] = canvasPointFromClient(clientX, clientY);
	const width = Number(node.size?.[0] || MIN_WIDTH);
	node.pos = [Math.round(x - width / 2), Math.round(y - 40)];
	graph.add(node);
	stabilizeNode(node);
	graph.change?.();
	graph.setDirtyCanvas?.(true, true);
	app.canvas?.setDirty?.(true, true);
	return node;
}

globalThis.__gjjAnyPreviewImportLocalFileAtPoint = async function (payload, clientX, clientY) {
	const node = anyPreviewNodeAtClientPoint(Number(clientX), Number(clientY)) || createAnyPreviewAtClientPoint(clientX, clientY);
	if (!node) return false;
	await importLocalFileFromBrowserNode(node, payload);
	return true;
};

function installAnyPreviewCanvasDropTarget() {
	if (document.__gjjAnyPreviewCanvasDropTargetInstalled) return;
	document.__gjjAnyPreviewCanvasDropTargetInstalled = true;
	document.addEventListener("dragover", (event) => {
		if (!hasFileBrowserDrop(event)) return;
		if (event.target?.closest?.(".gjj-file-browser")) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
	});
	document.addEventListener("drop", (event) => {
		const payload = fileBrowserDropPayload(event);
		if (!payload) return;
		if (event.target?.closest?.(".gjj-file-browser")) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		Promise.resolve(globalThis.__gjjAnyPreviewImportLocalFileAtPoint(payload, event.clientX, event.clientY)).catch((error) => {
			console.warn("[GJJ_AnyPreview] canvas file browser drop failed", error);
		});
	});
}

installAnyPreviewCanvasDropTarget();

function setDropTargetActive(node, active, text = "") {
	const wrap = node?.__gjjAnyPreviewWrap;
	if (!wrap) {
		return;
	}
	wrap.dataset.gjjAnyPreviewDragActive = active ? "true" : "false";
	if (node.__gjjAnyPreviewDropHint) {
		node.__gjjAnyPreviewDropHint.textContent = text || "松开导入图片";
		node.__gjjAnyPreviewDropHint.style.display = active ? "flex" : "none";
	}
}

async function importDroppedImages(node, files) {
	if (!node || !files.length) {
		return;
	}
	setDropTargetActive(node, true, "上传中...");
	try {
		const images = await uploadDroppedImagesToTemp(files);
		node.properties = node.properties || {};
		disconnectLinkedInputs(node);
		node.properties[HELD_IMAGES_PROPERTY] = images.map((item) => ({ ...item }));
		delete node.properties[HELD_TEXT_PROPERTY];
		delete node.properties[HELD_MEDIA_PROPERTY];
		resetLivePreviewState(node);
		applyHeldImagePreview(node);
		scheduleStabilize(node, 0);
		setDirty(node);
	} catch (error) {
		console.warn("[GJJ_AnyPreview] drop image upload failed", error);
		setDropTargetActive(node, true, error?.message || "上传失败");
		setTimeout(() => setDropTargetActive(node, false), 1200);
		return;
	}
	setDropTargetActive(node, false);
}

function installAnyPreviewDropTarget(node, elements) {
	if (!node || node.__gjjAnyPreviewDropInstalled) {
		return;
	}
	node.__gjjAnyPreviewDropInstalled = true;
	const targets = elements.filter(Boolean);
	let dragDepth = 0;
	const stopIfSupported = (event) => {
		const hasBrowserFile = hasFileBrowserDrop(event);
		const hasImage = imageFilesFromDropEvent(event).length > 0 || Array.from(event?.dataTransfer?.items || []).some((item) => String(item?.type || "").startsWith("image/"));
		if (!hasBrowserFile && !hasImage) {
			return false;
		}
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = "copy";
		return true;
	};
	for (const target of targets) {
		target.addEventListener("dragenter", (event) => {
			if (!stopIfSupported(event)) return;
			dragDepth += 1;
			setDropTargetActive(node, true, hasFileBrowserDrop(event) ? "松开导入文件" : "松开导入图片");
		});
		target.addEventListener("dragover", (event) => {
			stopIfSupported(event);
		});
		target.addEventListener("dragleave", (event) => {
			if (!stopIfSupported(event)) return;
			dragDepth = Math.max(0, dragDepth - 1);
			if (!dragDepth) {
				setDropTargetActive(node, false);
			}
		});
		target.addEventListener("drop", (event) => {
			if (!stopIfSupported(event)) return;
			dragDepth = 0;
			const browserPayload = fileBrowserDropPayload(event);
			if (browserPayload) {
				void importLocalFileFromBrowserNode(node, browserPayload);
				return;
			}
			const files = imageFilesFromDropEvent(event);
			if (!files.length) {
				setDropTargetActive(node, false);
				return;
			}
			void importDroppedImages(node, files);
		});
	}
}

async function copyPreviewToAnyPreviewNode(node) {
	const button = node?.__gjjAnyPreviewCopyNodeButton;
	const images = currentPreviewImages(node);
	const media = images.length ? { kind: "image", items: images } : currentPreviewMedia(node);
	if (!media.items.length) {
		flashActionButton(button, "无媒体", false);
		return;
	}
	const graph = node?.graph || app.graph;
	const copyNode = globalThis.LiteGraph?.createNode?.("GJJ_AnyPreview");
	if (!copyNode || !graph?.add) {
		flashActionButton(button, "创建失败", false);
		return;
	}
	try {
		flashActionButton(button, "复制中...");
		const inputItems = media.kind === "image"
			? await copyImagesToInput(media.items)
			: await copyMediaToInput(media.items);
		graph.add(copyNode);
		copyNode.pos = nextAnyPreviewCopyPosition(node, copyNode, graph);
		copyNode.properties = copyNode.properties || {};
		if (media.kind === "image") {
			copyNode.properties[HELD_IMAGES_PROPERTY] = inputItems.map((item) => ({ ...item }));
			delete copyNode.properties[HELD_MEDIA_PROPERTY];
			delete copyNode.properties[HELD_TEXT_PROPERTY];
		} else {
			copyNode.properties[HELD_MEDIA_PROPERTY] = {
				kind: media.kind,
				items: inputItems.map((item) => ({ ...item })),
				text: String(node.__gjjAnyPreviewText || "").trim(),
			};
			delete copyNode.properties[HELD_IMAGES_PROPERTY];
			delete copyNode.properties[HELD_TEXT_PROPERTY];
		}
		resetLivePreviewState(copyNode);
		applyHeldPreview(copyNode);
		scheduleStabilize(copyNode, 0);
		app.canvas?.selectNode?.(copyNode, false);
		copyNode.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
		flashActionButton(button, "已创建");
	} catch (error) {
		console.warn("[GJJ_AnyPreview] create GJJ_AnyPreview copy failed", error);
		try {
			graph.remove?.(copyNode);
		} catch (_) {
			// Ignore cleanup failure.
		}
		flashActionButton(button, error?.message || "创建失败", false);
	}
}

async function copyPreviewToNode(node) {
	const media = currentPreviewMedia(node);
	if (currentPreviewImages(node).length || media.items.length) {
		await copyPreviewToAnyPreviewNode(node);
		return;
	}
	const button = node?.__gjjAnyPreviewCopyNodeButton;
	const text = currentPreviewTextForCopy(node);
	if (!text.trim()) {
		flashActionButton(button, "无文本", false);
		return;
	}
	const graph = node?.graph || app.graph;
	const copyNode = globalThis.LiteGraph?.createNode?.("GJJ_TextInput");
	if (!copyNode || !graph?.add) {
		flashActionButton(button, "创建失败", false);
		return;
	}
	try {
		graph.add(copyNode);
		copyNode.pos = nextAnyPreviewCopyPosition(node, copyNode, graph);
		setTextInputNodeValue(copyNode, text);
		app.canvas?.selectNode?.(copyNode, false);
		copyNode.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
		flashActionButton(button, "已创建");
	} catch (error) {
		console.warn("[GJJ_AnyPreview] create GJJ_TextInput copy failed", error);
		try {
			graph.remove?.(copyNode);
		} catch (_) {
			// Ignore cleanup failure.
		}
		flashActionButton(button, "创建失败", false);
	}
}

async function copyPreviewText(node) {
	const text = currentPreviewTextForCopy(node);
	const button = node?.__gjjAnyPreviewCopyClipboardButton;
	const ok = await copyTextToClipboard(text);
	flashActionButton(button, ok ? "已复制到剪贴板" : "复制失败", ok);
	if (!ok) {
		window.prompt("复制预览文本", text);
	}
}

async function runCurrentAnyPreviewNode(node) {
	const button = node?.__gjjAnyPreviewRunButton;
	try {
		const queued = await queueOnlyCurrentNode(node);
		flashActionButton(button, queued ? "已运行当前节点" : "运行失败", Boolean(queued));
	} catch (error) {
		console.warn("[GJJ_AnyPreview] run current node failed", error);
		flashActionButton(button, "运行失败", false);
	}
}

function heldTextFromProperties(node) {
	const value = node?.properties?.[HELD_TEXT_PROPERTY];
	return typeof value === "string" ? value : "";
}

function heldImagesFromProperties(node) {
	return normalizeMediaPayload(node?.properties?.[HELD_IMAGES_PROPERTY]);
}

function removeFailedHeldImage(node, failedItem) {
	if (!node || !failedItem) {
		return false;
	}
	const failedUrl = imageDataToUrl(failedItem);
	const keepItem = (item) => imageDataToUrl(item) !== failedUrl;
	const heldImages = heldImagesFromProperties(node);
	const nextHeldImages = heldImages.filter(keepItem);
	const removedHeldImage = nextHeldImages.length !== heldImages.length;
	if (removedHeldImage) {
		node.properties = node.properties || {};
		if (nextHeldImages.length) {
			node.properties[HELD_IMAGES_PROPERTY] = nextHeldImages.map((item) => ({ ...item }));
		} else {
			delete node.properties[HELD_IMAGES_PROPERTY];
		}
	}
	if (Array.isArray(node.__gjjAnyPreviewImages)) {
		node.__gjjAnyPreviewImages = node.__gjjAnyPreviewImages.filter(keepItem);
	}
	if (Array.isArray(node.__gjjAnyPreviewItems)) {
		node.__gjjAnyPreviewItems = node.__gjjAnyPreviewItems
			.map((item) => ({
				...item,
				images: normalizeMediaPayload(item?.images).filter(keepItem),
			}))
			.filter((item) => item.images.length || item.text || item.audio || item.video || item.files);
	}
	if (removedHeldImage) {
		setDirty(node);
	}
	return removedHeldImage;
}

function heldMediaFromProperties(node) {
	const media = node?.properties?.[HELD_MEDIA_PROPERTY];
	if (!media || typeof media !== "object") {
		return { kind: "", items: [], text: "" };
	}
	const kind = String(media.kind || "").trim().toLowerCase();
	if (!["audio", "video", "3d"].includes(kind)) {
		return { kind: "", items: [], text: "" };
	}
	const items = normalizeMediaPayload(media.items);
	if (!items.length) {
		return { kind: "", items: [], text: "" };
	}
	return {
		kind,
		items,
		text: String(media.text || "").trim(),
	};
}

function hasHeldPreviewProperties(node) {
	return (
		heldImagesFromProperties(node).length > 0
		|| Boolean(heldMediaFromProperties(node).items.length)
		|| Boolean(heldTextFromProperties(node).trim())
	);
}

function imagesFromPreviewItems(items) {
	const result = [];
	for (const item of Array.isArray(items) ? items : []) {
		for (const image of normalizeMediaPayload(item?.images)) {
			result.push(image);
		}
	}
	return result;
}

function currentPreviewImages(node) {
	const images = normalizeMediaPayload(node?.__gjjAnyPreviewImages);
	if (images.length) return images;
	return imagesFromPreviewItems(node?.__gjjAnyPreviewItems);
}

function mediaFromPreviewItems(items, key) {
	const result = [];
	for (const item of Array.isArray(items) ? items : []) {
		for (const media of normalizeMediaPayload(item?.[key])) {
			result.push(media);
		}
	}
	return result;
}

function currentPreviewMedia(node) {
	const explicitKind = String(node?.__gjjAnyPreviewKind || "").trim();
	const audio = normalizeMediaPayload(node?.__gjjAnyPreviewAudio);
	const video = normalizeMediaPayload(node?.__gjjAnyPreviewVideo);
	const files = normalizeMediaPayload(node?.__gjjAnyPreviewFiles);
	if (explicitKind === "audio") {
		return { kind: explicitKind, items: audio.length ? audio : mediaFromPreviewItems(node?.__gjjAnyPreviewItems, "audio") };
	}
	if (explicitKind === "video") {
		return { kind: explicitKind, items: video.length ? video : mediaFromPreviewItems(node?.__gjjAnyPreviewItems, "video") };
	}
	if (explicitKind === "3d") {
		return { kind: explicitKind, items: files.length ? files : mediaFromPreviewItems(node?.__gjjAnyPreviewItems, "files") };
	}
	if (video.length) return { kind: "video", items: video };
	if (audio.length) return { kind: "audio", items: audio };
	if (files.length) return { kind: "3d", items: files };
	const itemVideo = mediaFromPreviewItems(node?.__gjjAnyPreviewItems, "video");
	if (itemVideo.length) return { kind: "video", items: itemVideo };
	const itemAudio = mediaFromPreviewItems(node?.__gjjAnyPreviewItems, "audio");
	if (itemAudio.length) return { kind: "audio", items: itemAudio };
	const itemFiles = mediaFromPreviewItems(node?.__gjjAnyPreviewItems, "files");
	if (itemFiles.length) return { kind: "3d", items: itemFiles };
	return { kind: "", items: [] };
}

function hasLinkedInputs(node) {
	return Array.isArray(node?.inputs) && node.inputs.some((input) => input?.link != null);
}

function applyHeldTextPreview(node) {
	const text = heldTextFromProperties(node).trim();
	if (!node || !text) {
		return false;
	}
	node.__gjjAnyPreviewKind = "text";
	node.__gjjAnyPreviewLiveOnly = false;
	node.__gjjAnyPreviewText = text;
	node.__gjjAnyPreviewItems = [];
	node.__gjjAnyPreviewImages = [];
	node.__gjjAnyPreviewAudio = [];
	node.__gjjAnyPreviewVideo = [];
	node.__gjjAnyPreviewFiles = [];
	clearNativeImagePreviewState(node);
	ensurePreviewWidget(node);
	applyPreviewContent(node);
	updateLayout(node);
	scheduleLayout(node);
	return true;
}

function applyHeldImagePreview(node) {
	const images = heldImagesFromProperties(node);
	if (!node || !images.length) {
		return false;
	}
	node.__gjjAnyPreviewKind = "image";
	node.__gjjAnyPreviewLiveOnly = false;
	node.__gjjAnyPreviewText = "";
	node.__gjjAnyPreviewItems = [];
	node.__gjjAnyPreviewImages = images;
	node.__gjjAnyPreviewAudio = [];
	node.__gjjAnyPreviewVideo = [];
	node.__gjjAnyPreviewFiles = [];
	clearNativeImagePreviewState(node);
	ensurePreviewWidget(node);
	applyPreviewContent(node);
	updateLayout(node);
	scheduleLayout(node);
	return true;
}

function applyHeldMediaPreview(node) {
	const { kind, items, text } = heldMediaFromProperties(node);
	if (!node || !kind || !items.length) {
		return false;
	}
	node.__gjjAnyPreviewKind = kind;
	node.__gjjAnyPreviewLiveOnly = false;
	node.__gjjAnyPreviewText = text;
	node.__gjjAnyPreviewItems = [];
	node.__gjjAnyPreviewImages = [];
	node.__gjjAnyPreviewAudio = kind === "audio" ? items : [];
	node.__gjjAnyPreviewVideo = kind === "video" ? items : [];
	node.__gjjAnyPreviewFiles = kind === "3d" ? items : [];
	clearNativeImagePreviewState(node);
	ensurePreviewWidget(node);
	applyPreviewContent(node);
	updateLayout(node);
	scheduleLayout(node);
	return true;
}

function applyHeldPreview(node) {
	return applyHeldImagePreview(node) || applyHeldMediaPreview(node) || applyHeldTextPreview(node);
}

function restoreHeldPreviewForNode(node) {
	if (!isTargetNode(node) || !hasHeldPreviewProperties(node)) {
		return false;
	}
	return applyHeldPreview(node);
}

function restoreHeldPreviews() {
	for (const node of app.graph?._nodes || []) {
		restoreHeldPreviewForNode(node);
	}
}

function installHeldPreviewRestoreEvents() {
	if (globalThis.__gjjAnyPreviewHeldRestoreEventsInstalled) {
		return;
	}
	globalThis.__gjjAnyPreviewHeldRestoreEventsInstalled = true;
	const restoreSoon = () => {
		requestAnimationFrame(() => restoreHeldPreviews());
		setTimeout(() => restoreHeldPreviews(), 120);
	};
	globalThis.addEventListener?.("focus", restoreSoon);
	globalThis.addEventListener?.("pageshow", restoreSoon);
	document?.addEventListener?.("visibilitychange", () => {
		if (!document.hidden) restoreSoon();
	});
}

function disconnectLinkedInputs(node) {
	if (!Array.isArray(node?.inputs)) {
		return 0;
	}
	recordCurrentAnyPreviewLinks(node);
	let count = 0;
	for (const [index, input] of node.inputs.entries()) {
		if (input?.link == null) {
			continue;
		}
		if (typeof node.disconnectInput === "function") {
			node.disconnectInput(index);
		} else {
			app.graph?.removeLink?.(input.link);
		}
		count += 1;
	}
	return count;
}

function ensureReconnectInput(node, record) {
	const name = String(record?.target_input_name || "");
	const desiredIndex = getInputIndex(name);
	if (Number.isFinite(desiredIndex) && desiredIndex !== Number.MAX_SAFE_INTEGER) {
		while (getInputs(node).length < desiredIndex) {
			addDynamicInput(node);
		}
		renameInputsSequentially(node);
		const byName = getInputs(node).find((input) => String(input.name || "") === name);
		if (byName) {
			return byName;
		}
	}
	const empty = getInputs(node).find((input) => input?.link == null);
	if (empty) {
		return empty;
	}
	addDynamicInput(node);
	renameInputsSequentially(node);
	return getInputs(node).find((input) => input?.link == null) || getInputs(node).at(-1) || null;
}

function reconnectAnyPreviewLinks(node) {
	const button = node?.__gjjAnyPreviewReconnectButton;
	const graph = node?.graph || app.graph;
	const records = anyPreviewLinkMemory(node);
	if (!records.length) {
		flashActionButton(button, "无记录", false);
		return false;
	}
	let connected = 0;
	let missing = 0;
	for (const record of records) {
		const sourceNode = getGraphNodeById(record.source_id, graph);
		const sourceSlot = Number(record.source_slot);
		if (!sourceNode || !sourceNode.outputs?.[sourceSlot]) {
			missing += 1;
			continue;
		}
		const input = ensureReconnectInput(node, record);
		const targetSlot = node?.inputs?.indexOf(input);
		if (!input || targetSlot < 0) {
			missing += 1;
			continue;
		}
		if (input.link != null) {
			try { node.disconnectInput?.(targetSlot); } catch (_) {}
		}
		try {
			sourceNode.connect(sourceSlot, node, targetSlot);
			connected += 1;
		} catch (error) {
			console.warn("[GJJ_AnyPreview] reconnect upstream failed", error);
			missing += 1;
		}
	}
	ensureTrailingEmptyInput(node);
	renameInputsSequentially(node);
	resetLivePreviewState(node);
	scheduleStabilize(node, 0);
	setDirty(node);
	if (connected > 0) {
		flashActionButton(button, missing ? `已连接 ${connected} 个` : "已连接");
		return true;
	}
	flashActionButton(button, "来源不存在", false);
	return false;
}

function flashHoldButton(button, ok) {
	if (!button) return;
	flashActionButton(button, ok ? "已保持" : "无内容", ok);
}

function holdCurrentTextPreview(node) {
	const button = node?.__gjjAnyPreviewHoldButton;
	const text = String(node?.__gjjAnyPreviewText || "").trim();
	if (!node || !text) {
		flashHoldButton(button, false);
		return false;
	}
	node.properties = node.properties || {};
	node.properties[HELD_TEXT_PROPERTY] = text;
	delete node.properties[HELD_IMAGES_PROPERTY];
	delete node.properties[HELD_MEDIA_PROPERTY];
	disconnectLinkedInputs(node);
	resetLivePreviewState(node);
	applyHeldTextPreview(node);
	scheduleStabilize(node, 0);
	setDirty(node);
	flashHoldButton(button, true);
	return true;
}

function holdCurrentImagePreview(node) {
	const button = node?.__gjjAnyPreviewHoldButton;
	const images = currentPreviewImages(node);
	if (!node || !images.length) {
		flashHoldButton(button, false);
		return false;
	}
	node.properties = node.properties || {};
	node.properties[HELD_IMAGES_PROPERTY] = images.map((item) => ({ ...item }));
	delete node.properties[HELD_TEXT_PROPERTY];
	delete node.properties[HELD_MEDIA_PROPERTY];
	disconnectLinkedInputs(node);
	resetLivePreviewState(node);
	applyHeldImagePreview(node);
	scheduleStabilize(node, 0);
	setDirty(node);
	flashHoldButton(button, true);
	return true;
}

function holdCurrentMediaPreview(node) {
	const button = node?.__gjjAnyPreviewHoldButton;
	const { kind, items } = currentPreviewMedia(node);
	if (!node || !kind || !items.length) {
		flashHoldButton(button, false);
		return false;
	}
	node.properties = node.properties || {};
	node.properties[HELD_MEDIA_PROPERTY] = {
		kind,
		items: items.map((item) => ({ ...item })),
		text: String(node.__gjjAnyPreviewText || "").trim(),
	};
	delete node.properties[HELD_TEXT_PROPERTY];
	delete node.properties[HELD_IMAGES_PROPERTY];
	disconnectLinkedInputs(node);
	resetLivePreviewState(node);
	applyHeldMediaPreview(node);
	scheduleStabilize(node, 0);
	setDirty(node);
	flashHoldButton(button, true);
	return true;
}

function rememberCurrentMediaPreview(node) {
	const { kind, items } = currentPreviewMedia(node);
	if (!node || !kind || !items.length) {
		return false;
	}
	node.properties = node.properties || {};
	node.properties[HELD_MEDIA_PROPERTY] = {
		kind,
		items: items.map((item) => ({ ...item })),
		text: String(node.__gjjAnyPreviewText || "").trim(),
	};
	delete node.properties[HELD_TEXT_PROPERTY];
	delete node.properties[HELD_IMAGES_PROPERTY];
	setDirty(node);
	return true;
}

function rememberCurrentPreviewAsHeld(node, markDirty = true) {
	if (!node) {
		return false;
	}
	const images = currentPreviewImages(node);
	if (images.length) {
		node.properties = node.properties || {};
		node.properties[HELD_IMAGES_PROPERTY] = images.map((item) => ({ ...item }));
		delete node.properties[HELD_TEXT_PROPERTY];
		delete node.properties[HELD_MEDIA_PROPERTY];
		if (markDirty) setDirty(node);
		return true;
	}
	const { kind, items } = currentPreviewMedia(node);
	if (kind && items.length) {
		node.properties = node.properties || {};
		node.properties[HELD_MEDIA_PROPERTY] = {
			kind,
			items: items.map((item) => ({ ...item })),
			text: String(node.__gjjAnyPreviewText || "").trim(),
		};
		delete node.properties[HELD_TEXT_PROPERTY];
		delete node.properties[HELD_IMAGES_PROPERTY];
		if (markDirty) setDirty(node);
		return true;
	}
	const text = String(node.__gjjAnyPreviewText || "").trim();
	if (text) {
		node.properties = node.properties || {};
		node.properties[HELD_TEXT_PROPERTY] = text;
		delete node.properties[HELD_IMAGES_PROPERTY];
		delete node.properties[HELD_MEDIA_PROPERTY];
		if (markDirty) setDirty(node);
		return true;
	}
	return false;
}

function holdCurrentPreview(node) {
	if (String(node?.__gjjAnyPreviewKind || "") === "image" && currentPreviewImages(node).length) {
		return holdCurrentImagePreview(node);
	}
	const { kind, items } = currentPreviewMedia(node);
	if (kind && items.length) {
		return holdCurrentMediaPreview(node);
	}
	return holdCurrentTextPreview(node);
}

function clampTextPreviewLines(body) {
	if (!body) {
		return;
	}
	body.style.lineHeight = String(TEXT_PREVIEW_LINE_HEIGHT);
	body.style.maxHeight = `${TEXT_PREVIEW_MAX_LINES * TEXT_PREVIEW_LINE_HEIGHT}em`;
	body.style.overflowY = "auto";
	body.style.overflowX = "hidden";
	body.style.paddingRight = "4px";
	body.style.overscrollBehavior = "contain";
	body.dataset.gjjMaxVisibleLines = String(TEXT_PREVIEW_MAX_LINES);
	for (const element of body.querySelectorAll(
		"p, li, h1, h2, h3, h4, h5, h6, th, td",
	)) {
		element.title = element.textContent || "";
		element.style.maxWidth = "100%";
		if (!["TH", "TD"].includes(element.tagName)) {
			element.style.display = "block";
		}
	}
	for (const element of body.querySelectorAll("ul, ol")) {
		element.style.maxWidth = "100%";
		element.style.overflow = "hidden";
	}
	for (const element of body.querySelectorAll("table")) {
		element.style.maxWidth = "100%";
	}
}

function resetTextPreviewScroll(body) {
	if (!body) {
		return;
	}
	body.style.maxHeight = "";
	body.style.overflowY = "visible";
	body.style.overflowX = "";
	body.style.paddingRight = "";
	body.style.overscrollBehavior = "";
	delete body.dataset.gjjMaxVisibleLines;
}

function handleScrollableTextWheel(event) {
	const element = event.currentTarget;
	if (!element || element.scrollHeight <= element.clientHeight + 1) {
		return;
	}
	const delta = Number(event.deltaY || 0);
	const atTop = element.scrollTop <= 0;
	const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
	if ((delta < 0 && atTop) || (delta > 0 && atBottom)) {
		return;
	}
	event.stopPropagation();
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

function suppressNativePreviewWidget(widget) {
	hideWidget(widget);
	widget.serialize = false;
	widget.serializeValue = () => undefined;
	widget.computeLayoutSize = () => ({ minHeight: 0, minWidth: 0 });
	widget.computeSize = () => [0, 0];
	widget.drawWidget = () => {};
	widget.draw = () => {};
	return widget;
}

function detachWidgetElement(widget) {
	for (const key of ["element", "inputEl", "container", "dom", "root"]) {
		const element = widget?.[key];
		if (element?.style) {
			element.style.display = "none";
		}
		if (typeof element?.remove === "function") {
			element.remove();
		}
	}
}

function isNativePreviewWidget(node, widget) {
	if (!widget || widget === node?.__gjjAnyPreviewWidget) {
		return false;
	}
	const name = String(widget?.name || "");
	if (name === PREVIEW_WIDGET_NAME) {
		return false;
	}
	if (name === NATIVE_CANVAS_PREVIEW_WIDGET) {
		return true;
	}
	const label = String(widget?.label || "");
	const type = String(widget?.type || "");
	const optionsType = String(widget?.options?.type || "");
	const optionsName = String(widget?.options?.name || "");
	const constructorName = String(widget?.constructor?.name || "");
	const text = `${name} ${label} ${type} ${optionsType} ${optionsName} ${constructorName}`;
	if (NATIVE_PREVIEW_WIDGET_PATTERN.test(text)) {
		return true;
	}
	for (const key of ["element", "inputEl", "container", "dom", "root"]) {
		const element = widget?.[key];
		if (
			typeof element?.querySelector === "function" &&
			element.querySelector("img, canvas, video")
		) {
			return true;
		}
	}
	return false;
}

function hideLegacyPreviewWidgets(node) {
	const widgets = node?.widgets;
	if (!Array.isArray(widgets)) {
		return false;
	}
	let changed = false;
	for (let index = widgets.length - 1; index >= 0; index--) {
		const widget = widgets[index];
		if (!isNativePreviewWidget(node, widget)) {
			continue;
		}
		hideWidget(widget);
		detachWidgetElement(widget);
		widgets.splice(index, 1);
		changed = true;
	}
	return changed;
}

function nativePreviewEmptyArray(node, key) {
	if (!node.__gjjAnyPreviewNativeEmptyArrays) {
		Object.defineProperty(node, "__gjjAnyPreviewNativeEmptyArrays", {
			configurable: true,
			enumerable: false,
			writable: true,
			value: Object.create(null),
		});
	}
	if (!Array.isArray(node.__gjjAnyPreviewNativeEmptyArrays[key])) {
		node.__gjjAnyPreviewNativeEmptyArrays[key] = [];
	}
	node.__gjjAnyPreviewNativeEmptyArrays[key].length = 0;
	return node.__gjjAnyPreviewNativeEmptyArrays[key];
}

function defineSuppressedNativePreviewProperty(node, key, emptyValue) {
	const descriptor = Object.getOwnPropertyDescriptor(node, key);
	if (descriptor?.get?.__gjjSuppressNativePreview) {
		return;
	}
	const getter = function () {
		return Array.isArray(emptyValue)
			? nativePreviewEmptyArray(this, key)
			: emptyValue;
	};
	getter.__gjjSuppressNativePreview = true;
	try {
		Object.defineProperty(node, key, {
			configurable: true,
			enumerable: false,
			get: getter,
			set() {
				if (Array.isArray(emptyValue)) {
					nativePreviewEmptyArray(this, key);
				}
			},
		});
	} catch (_error) {
		try {
			node[key] = Array.isArray(emptyValue) ? [] : emptyValue;
		} catch (_fallbackError) {
			// 忽略不可写属性，后续绘制阶段还会再次清理。
		}
	}
}

function restoreSuppressedNativePreviewDataProperty(node, key) {
	const descriptor = Object.getOwnPropertyDescriptor(node, key);
	if (!descriptor?.get?.__gjjSuppressNativePreview) {
		return;
	}
	try {
		delete node[key];
		node[key] = [];
	} catch (_) {}
}

function suppressNativePreviewProperties(node) {
	if (!node) {
		return;
	}
	restoreSuppressedNativePreviewDataProperty(node, "imgs");
	restoreSuppressedNativePreviewDataProperty(node, "images");
	defineSuppressedNativePreviewProperty(node, "hideOutputImages", true);
	defineSuppressedNativePreviewProperty(node, "imageRects", []);
	defineSuppressedNativePreviewProperty(node, "preview", null);
	defineSuppressedNativePreviewProperty(node, "imageIndex", null);
	defineSuppressedNativePreviewProperty(node, "overIndex", null);
}

function clearNativeImagePreviewState(node) {
	if (!node) {
		return;
	}
	suppressNativePreviewProperties(node);
	node.preview = null;
	node.imageRects = [];
	node.imageIndex = null;
	node.overIndex = null;
	if (node.constructor?.nodeData) {
		node.constructor.nodeData.output_preview = false;
	}
	node.hideOutputImages = true;
	hideLegacyPreviewWidgets(node);
}

function scheduleNativePreviewCleanup(node) {
	requestAnimationFrame(() => {
		clearNativeImagePreviewState(node);
		updateLayout(node);
		setDirty(node);
		for (const delay of NATIVE_PREVIEW_CLEANUP_DELAYS) {
			setTimeout(() => {
				clearNativeImagePreviewState(node);
				updateLayout(node);
				setDirty(node);
			}, delay);
		}
	});
}

function shouldSuppressNativePreview(node) {
	const kind = String(node?.__gjjAnyPreviewKind || "");
	return kind === "image" || Array.isArray(node?.__gjjAnyPreviewImages);
}

function appendImagePreviewCards(node, parent, images) {
	const imageGrid = document.createElement("div");
	imageGrid.style.cssText = [
		"display:grid",
		"grid-template-columns:repeat(auto-fill, minmax(110px, 1fr))",
		"gap:8px",
		"width:100%",
	].join(";");

	for (const [index, item] of images.entries()) {
		const card = document.createElement("div");
		card.style.cssText = [
			"position:relative",
			"aspect-ratio:1/1",
			"overflow:hidden",
			"border-radius:7px",
			"background:#0c1114",
			"cursor:pointer",
		].join(";");

		const image = document.createElement("img");
		image.src = imageDataToUrl(item);
		image.draggable = false;
		image.style.cssText = [
			"width:100%",
			"height:100%",
			"object-fit:cover",
			"display:block",
		].join(";");
		image.onload = () => scheduleLayout(node);
		image.onerror = () => scheduleLayout(node);
		bindAnyPreviewImageContextMenu(image, item);

		const badge = document.createElement("div");
		badge.textContent = `${index + 1}`;
		badge.style.cssText = [
			"position:absolute",
			"top:5px",
			"left:5px",
			"min-width:20px",
			"height:20px",
			"padding:0 5px",
			"border-radius:10px",
			"background:rgba(0, 0, 0, 0.55)",
			"color:#fff",
			"font-size:10px",
			"display:flex",
			"align-items:center",
			"justify-content:center",
			"pointer-events:none",
		].join(";");

		card.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();

			const overlay = document.createElement("div");
			overlay.style.cssText = [
				"position:fixed",
				"inset:0",
				"background:rgba(0, 0, 0, 0.9)",
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
			].join(";");
			bindAnyPreviewImageContextMenu(previewImg, item);

			overlay.appendChild(previewImg);
			const hint = document.createElement("div");
			hint.style.cssText = [
				"position:absolute",
				"bottom:20px",
				"left:50%",
				"transform:translateX(-50%)",
				"color:#fff",
				"font-size:13px",
				"opacity:0.66",
				"pointer-events:none",
				"white-space:nowrap",
			].join(";");
			overlay.appendChild(hint);
			bindZoomableImageOverlay(overlay, previewImg, hint);
			overlay.addEventListener("click", () => overlay.remove());
			document.body.appendChild(overlay);
		});

		card.appendChild(image);
		card.appendChild(badge);
		imageGrid.appendChild(card);
	}

	parent.appendChild(imageGrid);
}

function appendPreviewOverlay(parent, title = "", detail = "") {
	const parts = [title, compactPreviewText(detail)].filter((part) => String(part || "").trim());
	if (!parts.length) return;
	const overlay = document.createElement("div");
	overlay.textContent = parts.join(" · ");
	overlay.title = parts.join("\n");
	overlay.style.cssText = [
		"position:absolute",
		"left:5px",
		"right:5px",
		"top:5px",
		"z-index:5",
		"padding:3px 6px",
		"border-radius:6px",
		"background:rgba(0,0,0,.45)",
		"backdrop-filter:blur(4px)",
		"color:#fff",
		"font-size:10px",
		"line-height:1.25",
		"font-weight:650",
		"pointer-events:none",
		"overflow:hidden",
		"display:-webkit-box",
		"-webkit-line-clamp:2",
		"-webkit-box-orient:vertical",
	].join(";");
	parent.appendChild(overlay);
}

function bindZoomableImageOverlay(overlay, previewImg, hint = null) {
	let currentScale = 1;
	const minScale = 0.1;
	const maxScale = 10;
	const applyScale = () => {
		previewImg.style.transform = `scale(${currentScale})`;
		if (hint) {
			hint.textContent = currentScale === 1
				? "滚轮缩放 · 双击重置 · 点击关闭"
				: `缩放 ${Math.round(currentScale * 100)}% · 双击重置 · 点击关闭`;
		}
	};
	previewImg.style.transformOrigin = "center center";
	previewImg.style.transition = "transform 0.08s ease";
	previewImg.style.cursor = "grab";
	overlay.addEventListener("wheel", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const step = event.deltaY > 0 ? 0.9 : 1.1;
		currentScale = Math.max(minScale, Math.min(maxScale, currentScale * step));
		applyScale();
	}, { passive: false });
	previewImg.addEventListener("dblclick", (event) => {
		event.preventDefault();
		event.stopPropagation();
		currentScale = 1;
		applyScale();
	});
	applyScale();
}

function pixelTextFromMediaItem(item) {
	const width = Number(item?.width || item?.preview_width || item?.w);
	const height = Number(item?.height || item?.preview_height || item?.h);
	if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
		return `${Math.round(width)}×${Math.round(height)}`;
	}
	return "";
}

function pixelTextFromText(text) {
	const source = String(text || "");
	const sizeMatch = source.match(/(?:尺寸|size|分辨率)[:：]?\s*(\d+)\s*[x×]\s*(\d+)/i);
	if (sizeMatch) return `${sizeMatch[1]}×${sizeMatch[2]}`;
	const shapeMatch = source.match(/shape=\(([^)]*)\)/i);
	if (!shapeMatch) return "";
	const nums = shapeMatch[1]
		.split(",")
		.map((part) => Number.parseInt(part.trim(), 10))
		.filter((value) => Number.isFinite(value) && value > 0);
	if (nums.length >= 4 && [1, 3, 4].includes(nums[1])) return `${nums[3]}×${nums[2]}`;
	if (nums.length >= 4 && [1, 3, 4].includes(nums[3])) return `${nums[2]}×${nums[1]}`;
	if (nums.length >= 3 && [1, 3, 4].includes(nums[2])) return `${nums[1]}×${nums[0]}`;
	if (nums.length >= 3) return `${nums[2]}×${nums[1]}`;
	if (nums.length >= 2) return `${nums[1]}×${nums[0]}`;
	return "";
}

function previewItemOverlayTitle(item, images, audio, video, text, index = 0) {
	const title = previewItemDisplayTitle(item, index);
	if (images.length) {
		const pixels = pixelTextFromMediaItem(images[0]) || pixelTextFromText(text) || pixelTextFromText(item?.title);
		return pixels ? `${title} · ${pixels}` : title;
	}
	if (video.length) {
		const pixels = pixelTextFromMediaItem(video[0]) || pixelTextFromText(text) || pixelTextFromText(item?.title);
		return pixels ? `${title} · ${pixels}` : title;
	}
	if (audio.length) return title;
	return title;
}

function makeTilePageButton(label, title, side) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title;
	button.style.cssText = [
		"position:absolute",
		`${side}:6px`,
		"top:50%",
		"z-index:8",
		"width:24px",
		"height:32px",
		"transform:translateY(-50%)",
		"border:1px solid rgba(255,255,255,.24)",
		"border-radius:999px",
		"background:rgba(0,0,0,.48)",
		"backdrop-filter:blur(4px)",
		"color:#fff",
		"font-size:18px",
		"line-height:1",
		"font-weight:800",
		"cursor:pointer",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"padding:0",
	].join(";");
	const stop = (event) => {
		event.preventDefault();
		event.stopPropagation();
	};
	for (const eventName of ["pointerdown", "mousedown", "dblclick", "wheel", "contextmenu"]) {
		button.addEventListener(eventName, stop);
	}
	return button;
}

function appendPreviewTileImage(node, parent, item, badgeText = "", imageItems = null) {
	if (!item) return;
	const frames = normalizeMediaPayload(imageItems);
	const pageItems = frames.length ? frames : [item];
	let currentIndex = 0;
	const currentItem = () => pageItems[Math.max(0, Math.min(pageItems.length - 1, currentIndex))] || item;
	const image = document.createElement("img");
	image.draggable = false;
	image.style.cssText = [
		"width:100%",
		"height:100%",
		"object-fit:cover",
		"display:block",
	].join(";");
	image.onload = () => scheduleLayout(node);
	image.onerror = () => scheduleLayout(node);
	image.addEventListener("contextmenu", (event) => showAnyPreviewImageMenu(event, currentItem()));
	parent.appendChild(image);

	const badge = document.createElement("div");
	badge.style.cssText = [
		"position:absolute",
		"right:5px",
		"bottom:5px",
		"z-index:6",
		"padding:2px 6px",
		"border-radius:999px",
		"background:rgba(0,0,0,.56)",
		"color:#fff",
		"font-size:10px",
		"font-weight:700",
		"pointer-events:none",
	].join(";");
	if (badgeText || pageItems.length > 1) parent.appendChild(badge);

	const renderPage = () => {
		const activeItem = currentItem();
		image.src = imageDataToUrl(activeItem);
		if (badge.parentElement) {
			badge.textContent = pageItems.length > 1 ? `${currentIndex + 1}/${pageItems.length}` : badgeText;
		}
	};

	if (pageItems.length > 1) {
		const prev = makeTilePageButton("‹", "上一张图片", "left");
		const next = makeTilePageButton("›", "下一张图片", "right");
		const turnPage = (delta) => {
			currentIndex = (currentIndex + delta + pageItems.length) % pageItems.length;
			renderPage();
		};
		prev.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			turnPage(-1);
		});
		next.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			turnPage(1);
		});
		parent.append(prev, next);
	}
	renderPage();

	parent.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		let overlayIndex = currentIndex;
		const overlay = document.createElement("div");
		overlay.style.cssText = [
			"position:fixed",
			"inset:0",
			"background:rgba(0,0,0,.9)",
			"z-index:10000",
			"display:flex",
			"align-items:center",
			"justify-content:center",
			"cursor:zoom-out",
		].join(";");
		const previewImg = document.createElement("img");
		previewImg.style.cssText = [
			"max-width:92%",
			"max-height:92%",
			"object-fit:contain",
			"border-radius:8px",
		].join(";");
		previewImg.addEventListener("contextmenu", (contextEvent) => {
			showAnyPreviewImageMenu(contextEvent, pageItems[overlayIndex] || currentItem());
		});
		const hint = document.createElement("div");
		hint.style.cssText = [
			"position:absolute",
			"bottom:20px",
			"left:50%",
			"transform:translateX(-50%)",
			"color:#fff",
			"font-size:13px",
			"opacity:0.66",
			"pointer-events:none",
			"white-space:nowrap",
		].join(";");
		const renderOverlayPage = () => {
			previewImg.src = imageDataToUrl(pageItems[overlayIndex] || currentItem());
		};
		renderOverlayPage();
		overlay.appendChild(previewImg);
		overlay.appendChild(hint);
		bindZoomableImageOverlay(overlay, previewImg, hint);
		if (pageItems.length > 1) {
			const prev = makeTilePageButton("‹", "上一张图片", "left");
			const next = makeTilePageButton("›", "下一张图片", "right");
			prev.style.left = "22px";
			prev.style.width = "36px";
			prev.style.height = "48px";
			prev.style.fontSize = "28px";
			next.style.right = "22px";
			next.style.width = "36px";
			next.style.height = "48px";
			next.style.fontSize = "28px";
			const pageHint = document.createElement("div");
			pageHint.style.cssText = [
				"position:absolute",
				"right:22px",
				"bottom:18px",
				"z-index:8",
				"padding:4px 8px",
				"border-radius:999px",
				"background:rgba(0,0,0,.52)",
				"color:#fff",
				"font-size:12px",
				"font-weight:700",
				"pointer-events:none",
			].join(";");
			const setOverlayPage = (delta) => {
				overlayIndex = (overlayIndex + delta + pageItems.length) % pageItems.length;
				renderOverlayPage();
				pageHint.textContent = `${overlayIndex + 1}/${pageItems.length}`;
			};
			pageHint.textContent = `${overlayIndex + 1}/${pageItems.length}`;
			prev.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				setOverlayPage(-1);
			});
			next.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				setOverlayPage(1);
			});
			overlay.append(prev, next, pageHint);
		}
		overlay.addEventListener("click", () => overlay.remove());
		document.body.appendChild(overlay);
	});
}

function renderCompactImageTiles(node, grid, entries) {
	const container = node?.__gjjAnyPreviewContainer;
	const previewWrap = node?.__gjjAnyPreviewWrap;
	node.__gjjAnyPreviewCompactTileEntries = Array.isArray(entries) ? entries.length : 0;
	if (container) {
		container.style.height = "auto";
		container.style.minHeight = `${MIN_PREVIEW_HEIGHT}px`;
	}
	if (previewWrap) {
		previewWrap.style.height = "auto";
		previewWrap.style.minHeight = "96px";
		previewWrap.style.overflow = "visible";
	}
	const images = entries
		.map((entry) => ({
			item: entry?.item || entry,
			label: String(entry?.label || ""),
		}))
		.filter((entry) => entry.item);
	grid.style.display = "flex";
	grid.style.flexDirection = "row";
	grid.style.flexWrap = "wrap";
	grid.style.gridTemplateColumns = "";
	grid.style.gap = "2px";
	grid.style.height = "auto";
	grid.style.minHeight = "0";
	grid.style.alignItems = "flex-start";
	grid.replaceChildren();
	for (const [index, entry] of images.entries()) {
		const card = document.createElement("div");
		card.style.cssText = [
			"position:relative",
			"width:96px",
			`aspect-ratio:${mediaItemAspectRatioCss(entry.item)}`,
			"min-height:54px",
			"max-height:124px",
			"overflow:hidden",
			"border:none",
			"border-radius:0",
			"background:transparent",
			"box-sizing:border-box",
			"cursor:pointer",
			"flex:0 0 auto",
		].join(";");
		appendPreviewTileImage(node, card, entry.item, entry.label || `${index + 1}`);
		grid.appendChild(card);
	}
	node.__gjjAnyPreviewHeight = estimateCompactTileHeight(node);
	clampCompactTileDomHeight(node, node.__gjjAnyPreviewHeight);
	requestAnimationFrame(() => {
		node.__gjjAnyPreviewHeight = estimateCompactTileHeight(node);
		clampCompactTileDomHeight(node, node.__gjjAnyPreviewHeight);
		scheduleLayout(node);
	});
}

function protectTextareaEvents(textarea) {
	const stop = (event) => event.stopPropagation();
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "keydown", "keyup", "contextmenu"]) {
		textarea.addEventListener(eventName, stop);
	}
}

function createPreviewTextarea(text, compact = false) {
	const textarea = document.createElement("textarea");
	textarea.value = String(text || "");
	textarea.readOnly = true;
	textarea.spellcheck = false;
	textarea.wrap = "soft";
	textarea.style.cssText = [
		"width:100%",
		compact ? "height:100%" : "height:160px",
		compact ? "min-height:100%" : "min-height:120px",
		"box-sizing:border-box",
		compact ? "padding:28px 8px 8px" : "padding:8px 9px",
		"border:1px solid #2d434b",
		"border-radius:7px",
		"outline:none",
		"background:#0d1519",
		"color:#d9e4df",
		`font:${compact ? "11px" : "12px"}/1.4 ui-monospace,SFMono-Regular,Consolas,monospace`,
		"overflow:auto",
		"white-space:pre-wrap",
		"resize:both",
		"user-select:text",
		"-webkit-user-select:text",
		"cursor:text",
	].join(";");
	protectTextareaEvents(textarea);
	return textarea;
}

function appendPreviewTileText(parent, text) {
	parent.appendChild(createPreviewTextarea(text, true));
}

function renderStandaloneTextarea(node, body, text) {
	if (body.__gjjDblClickHandler) {
		body.removeEventListener("dblclick", body.__gjjDblClickHandler);
		body.removeEventListener("pointerdown", body.__gjjPointerHandler);
		body.removeEventListener("mousedown", body.__gjjPointerHandler);
		delete body.__gjjDblClickHandler;
		delete body.__gjjPointerHandler;
	}
	body.replaceChildren();
	body.style.display = "block";
	body.style.cursor = "text";
	body.style.overflow = "visible";
	body.style.userSelect = "text";
	body.style.webkitUserSelect = "text";
	const textarea = createPreviewTextarea(text, false);
	const lineCount = String(text || "").split("\n").length;
	textarea.style.height = `${Math.max(130, Math.min(360, lineCount * 18 + 28))}px`;
	textarea.addEventListener("mouseup", () => scheduleLayout(node));
	body.appendChild(textarea);
}

function appendPreviewTileMedia(node, parent, tagName, item) {
	if (!item) return;
	const player = document.createElement(tagName);
	player.controls = tagName !== "video";
	player.src = imageDataToUrl(item);
	player.preload = "metadata";
	if (tagName === "video") {
		player.muted = true;
		player.loop = true;
		player.playsInline = true;
		player.autoplay = Boolean(item?.is_sequence || item?.loop || item?.autoplay);
		player.style.cssText = [
			"width:100%",
			"height:100%",
			"object-fit:cover",
			"display:block",
			"background:#0c1114",
		].join(";");
		player.addEventListener("canplay", () => {
			const promise = player.play?.();
			if (promise?.catch) promise.catch(() => {});
		}, { once: true });
	} else {
		const waveform = appendAudioWaveform(node, parent, player.src, player);
		if (waveform?.wrap) {
			waveform.wrap.style.cssText = [
				"position:absolute",
				"inset:0",
				"width:100%",
				"height:100%",
				"border:0",
				"border-radius:0",
				"background:#0d1519",
				"overflow:hidden",
				"box-sizing:border-box",
				"cursor:pointer",
			].join(";");
		}
		player.style.cssText = [
			"position:absolute",
			"left:7px",
			"right:7px",
			"bottom:7px",
			"z-index:4",
			"width:calc(100% - 14px)",
			`height:${GJJ_AUDIO_PLAYER_HEIGHT}px`,
		].join(";");
	}
	player.addEventListener("loadedmetadata", () => scheduleLayout(node));
	parent.appendChild(player);
}

function clearImageSequenceTimers(node) {
	for (const timer of node?.__gjjAnyPreviewSequenceTimers || []) {
		clearInterval(timer);
	}
	if (node) {
		node.__gjjAnyPreviewSequenceTimers = [];
	}
}

function appendCompactMediaInfo(node, parent, tagName, item, description = "") {
	const row = document.createElement("div");
	row.style.cssText = [
		"display:grid",
		"grid-template-columns:auto minmax(0, 1fr) auto",
		"align-items:start",
		"column-gap:6px",
		"row-gap:4px",
		"flex:1 1 0",
		"gap:6px",
		"min-width:0",
		"width:100%",
		"max-width:100%",
		"box-sizing:border-box",
		"font-size:12px",
		"line-height:1.35",
		"color:#cfe0dc",
	].join(";");

	const icon = document.createElement("span");
	icon.textContent = mediaEmoji(tagName, item);
	icon.style.cssText = "line-height:1.35";

	const textWrap = document.createElement("span");
	textWrap.style.cssText = [
		"min-width:0",
		"max-width:100%",
		"display:block",
		"white-space:normal",
		"overflow-wrap:anywhere",
		"word-break:break-word",
	].join(";");

	const filename = document.createElement("span");
	filename.textContent = item?.filename || (tagName === "video" ? "视频" : "音频");
	filename.title = filename.textContent;
	filename.style.cssText = [
		"display:inline",
		"min-width:0",
		"white-space:normal",
		"overflow-wrap:anywhere",
		"word-break:break-word",
		"font-weight:600",
		"color:#e7f3ef",
	].join(";");

	const metaText = compactPreviewText(description);
	const meta = document.createElement("span");
	meta.textContent = metaText ? ` · ${metaText}` : "";
	meta.title = String(description || metaText || "");
	meta.style.cssText = [
		"display:inline",
		"white-space:normal",
		"overflow-wrap:anywhere",
		"word-break:break-word",
		"color:#aebfbb",
	].join(";");

	const folder = document.createElement("button");
	folder.type = "button";
	folder.textContent = "📁";
	folder.title = "打开所在目录";
	folder.style.cssText = [
		"flex:0 0 auto",
		"border:1px solid #34464e",
		"border-radius:5px",
		"background:#182329",
		"color:#e7f3ef",
		"width:24px",
		"height:22px",
		"padding:0",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"font-size:12px",
		"cursor:pointer",
	].join(";");
	folder.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openMediaFolder(item || {}, folder);
	});

	textWrap.append(filename, meta);
	row.append(icon, textWrap, folder);
	parent.appendChild(row);
}

function styleCompactAudioPlayer(player) {
	gjjStyleCompactAudioPlayer(player);
}

function appendAudioWaveform(node, parent, audioUrl, player) {
	return gjjRenderAudioWaveformPreview(parent, audioUrl, player, {
		onLayout: () => scheduleLayout(node),
		loggerPrefix: "[GJJ AnyPreview]",
	});
}

function appendAnimatedSequenceImage(node, parent, item, description = "") {
	if (!item) {
		return;
	}
	const mediaCard = document.createElement("div");
	mediaCard.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"width:100%",
		"box-sizing:border-box",
	].join(";");

	const stage = document.createElement("div");
	stage.style.cssText = [
		"position:relative",
		"width:100%",
		"aspect-ratio:16/9",
		"min-height:160px",
		"max-height:360px",
		"overflow:hidden",
		"border-radius:6px",
		"background:#0c1114",
	].join(";");

	const image = document.createElement("img");
	image.src = imageDataToUrl(item);
	image.draggable = false;
	image.style.cssText = [
		"width:100%",
		"height:100%",
		"object-fit:contain",
		"display:block",
	].join(";");
	image.onload = () => scheduleLayout(node);
	image.onerror = () => scheduleLayout(node);
	bindAnyPreviewImageContextMenu(image, item);

	stage.appendChild(image);
	mediaCard.appendChild(stage);
	appendCompactMediaInfo(node, mediaCard, "video", item, description);
	parent.appendChild(mediaCard);
}

function appendImageSequencePlayer(node, parent, images, description = "") {
	const frames = normalizeMediaPayload(images);
	if (!frames.length) {
		return;
	}
	const playerCard = document.createElement("div");
	playerCard.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"width:100%",
		"box-sizing:border-box",
	].join(";");

	const stage = document.createElement("div");
	stage.style.cssText = [
		"position:relative",
		"width:100%",
		"aspect-ratio:16/9",
		"min-height:160px",
		"max-height:360px",
		"overflow:hidden",
		"border-radius:6px",
		"background:#0c1114",
	].join(";");

	const image = document.createElement("img");
	image.draggable = false;
	image.src = imageDataToUrl(frames[0]);
	image.style.cssText = [
		"width:100%",
		"height:100%",
		"object-fit:contain",
		"display:block",
	].join(";");
	image.onload = () => scheduleLayout(node);
	image.addEventListener("contextmenu", (event) => showAnyPreviewImageMenu(event, frames[frameIndex % frames.length]));

	const badge = document.createElement("div");
	badge.textContent = `1/${frames.length}`;
	badge.style.cssText = [
		"position:absolute",
		"right:8px",
		"top:8px",
		"padding:3px 7px",
		"border-radius:999px",
		"background:rgba(0,0,0,.58)",
		"color:#fff",
		"font-size:11px",
		"line-height:1.2",
		"pointer-events:none",
	].join(";");

	const toolbar = document.createElement("div");
	toolbar.style.cssText = [
		"display:flex",
		"align-items:center",
		"gap:8px",
		"font-size:12px",
		"color:#dce7e2",
	].join(";");

	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.textContent = "暂停";
	toggle.title = "播放/暂停动态序列预览";
	toggle.style.cssText = [
		"border:1px solid #3a4d56",
		"border-radius:6px",
		"background:#182329",
		"color:#e7f3ef",
		"padding:4px 9px",
		"font-size:12px",
		"cursor:pointer",
	].join(";");

	let frameIndex = 0;
	let playing = true;
	const renderFrame = () => {
		const frame = frames[frameIndex % frames.length];
		image.src = imageDataToUrl(frame);
		badge.textContent = `${frameIndex + 1}/${frames.length}`;
	};
	const timer = setInterval(() => {
		if (!document.body.contains(playerCard)) {
			clearInterval(timer);
			return;
		}
		if (!playing) {
			return;
		}
		frameIndex = (frameIndex + 1) % frames.length;
		renderFrame();
	}, Math.max(80, Math.round(1000 / IMAGE_SEQUENCE_PREVIEW_FPS)));
	if (!Array.isArray(node.__gjjAnyPreviewSequenceTimers)) {
		node.__gjjAnyPreviewSequenceTimers = [];
	}
	node.__gjjAnyPreviewSequenceTimers.push(timer);

	toggle.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		playing = !playing;
		toggle.textContent = playing ? "暂停" : "播放";
	});

	const sequenceDescription =
		description || `帧数: ${frames.length}, 预览帧率: ${IMAGE_SEQUENCE_PREVIEW_FPS}fps`;

	stage.append(image, badge);
	toolbar.append(toggle);
	appendCompactMediaInfo(node, toolbar, "video", frames[0], sequenceDescription);
	playerCard.append(stage, toolbar);
	parent.appendChild(playerCard);
}

function appendMediaPlayers(node, parent, tagName, mediaItems, description = "") {
	for (const item of mediaItems) {
		const mediaCard = document.createElement("div");
		mediaCard.style.cssText = [
			"display:flex",
			"flex-direction:column",
			"gap:8px",
			"width:100%",
		].join(";");

		const player = document.createElement(tagName);
		player.controls = true;
		player.src = imageDataToUrl(item);
		player.preload = "metadata";
		const shouldAutoLoop = tagName === "video" && Boolean(item?.is_sequence || item?.loop || item?.autoplay);
		if (shouldAutoLoop) {
			player.loop = true;
			player.autoplay = true;
			player.muted = true;
			player.playsInline = true;
		}
		player.style.cssText =
			tagName === "video"
				? [
						"width:100%",
						"max-height:320px",
						"object-fit:contain",
						"background:#0c1114",
						"border-radius:6px",
				  ].join(";")
				: "";
		if (tagName === "audio") {
			styleCompactAudioPlayer(player);
		}
		player.addEventListener("loadedmetadata", () => scheduleLayout(node));
		if (shouldAutoLoop) {
			player.addEventListener("canplay", () => {
				const promise = player.play?.();
				if (promise?.catch) {
					promise.catch(() => {});
				}
			}, { once: true });
		}

		if (tagName === "audio") {
			appendAudioWaveform(node, mediaCard, player.src, player);
		}
		mediaCard.appendChild(player);
		appendCompactMediaInfo(node, mediaCard, tagName, item, description);
		parent.appendChild(mediaCard);
	}
}

function renderPreviewItems(node, items) {
	const container = node.__gjjAnyPreviewContainer;
	const body = node.__gjjAnyPreviewBody;
	const grid = node.__gjjAnyPreviewGrid;
	const empty = node.__gjjAnyPreviewEmpty;
	const previewWrap = node.__gjjAnyPreviewWrap;
	const copyBar = node.__gjjAnyPreviewCopyBar;
	const editor = node.__gjjAnyPreviewEditor;
	if (!container || !body || !grid || !empty) {
		return;
	}

	body.style.display = "none";
	if (copyBar) copyBar.style.display = "none";
	if (editor) editor.style.display = "none";
	empty.style.display = "none";
	node.__gjjAnyPreviewCompactTileEntries = 0;
	container.style.height = "auto";
	container.style.minHeight = `${MIN_PREVIEW_HEIGHT}px`;
	if (previewWrap) {
		previewWrap.style.overflow = "visible";
		previewWrap.style.height = "auto";
		previewWrap.style.minHeight = "96px";
		previewWrap.style.maxHeight = "";
		previewWrap.style.border = "1px solid #33434a";
		previewWrap.style.background = "#0f1418";
		previewWrap.style.padding = "8px";
	}

	grid.style.display = "grid";
	grid.style.flexDirection = "";
	grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${MULTI_OBJECT_TILE_MIN_WIDTH}px, 1fr))`;
	grid.style.gap = `${MULTI_OBJECT_TILE_GAP}px`;
	grid.style.height = "auto";
	grid.style.alignItems = "start";
	clearImageSequenceTimers(node);
	grid.replaceChildren();

	if (isTileMode(node)) {
		const imageEntries = [];
		for (const [index, item] of items.entries()) {
			for (const entry of tileImageEntriesFromImages(item.images)) {
				imageEntries.push({
					...entry,
					sourceTitle: previewItemDisplayTitle(item, index),
				});
			}
		}
		if (imageEntries.length > 1) {
			renderCompactImageTiles(node, grid, imageEntries);
			return;
		}
	}

	for (const [index, item] of items.entries()) {
		const card = document.createElement("div");
		card.style.cssText = [
			"position:relative",
			"aspect-ratio:1/1",
			"min-height:124px",
			"overflow:hidden",
			"border:1px solid #33434a",
			"border-radius:7px",
			"background:#0c1114",
			"box-sizing:border-box",
			"cursor:pointer",
		].join(";");

		const images = normalizeMediaPayload(item.images);
		const audio = normalizeMediaPayload(item.audio);
		const video = normalizeMediaPayload(item.video);
		const files = normalizeMediaPayload(item.files);
		const text = String(item.text || "").trim();
		const title = previewItemDisplayTitle(item, index);
		const sequenceImage = images.find(isSequenceMediaItem);
		if (sequenceImage && !audio.length && !video.length) {
			appendPreviewTileImage(node, card, sequenceImage, "序列");
		} else if (images.length >= IMAGE_SEQUENCE_MIN_FRAMES && !audio.length && !video.length) {
			appendPreviewTileImage(node, card, images[0], `${images.length}帧`, images);
		} else if (images.length) {
			appendPreviewTileImage(node, card, images[0], images.length > 1 ? `1/${images.length}` : "", images);
		}
		if (audio.length) {
			appendPreviewTileMedia(node, card, "audio", audio[0]);
		}
		if (video.length) {
			appendPreviewTileMedia(node, card, "video", video[0]);
		}
		if (files.length) {
			const file = files[0] || {};
			appendPreviewTileText(card, `🧊 ${file.filename || "3D文件"}\n格式: ${file.format || "3d"}`);
		}

		if (!images.length && !audio.length && !video.length && !files.length) {
			card.style.cursor = "text";
			appendPreviewTileText(card, text || title);
		}
		if (images.length || audio.length || video.length || files.length) {
			appendPreviewOverlay(card, previewItemOverlayTitle(item, images, audio, video, text, index), "");
		} else {
			appendPreviewOverlay(card, title, "");
		}

		grid.appendChild(card);
	}
	node.__gjjAnyPreviewHeight = measurePreviewItemsHeight(node);
}

function applyPreviewContent(node) {
	const container = node.__gjjAnyPreviewContainer;
	const body = node.__gjjAnyPreviewBody;
	const grid = node.__gjjAnyPreviewGrid;
	const empty = node.__gjjAnyPreviewEmpty;
	const previewWrap = node.__gjjAnyPreviewWrap;
	const copyBar = node.__gjjAnyPreviewCopyBar;
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
	const files = Array.isArray(node.__gjjAnyPreviewFiles)
		? node.__gjjAnyPreviewFiles
		: [];
	const previewItems = Array.isArray(node.__gjjAnyPreviewItems)
		? node.__gjjAnyPreviewItems
		: [];
	const showImage = kind === "image" && images.length > 0;
	const showAudio = kind === "audio" && audio.length > 0;
	const showVideo = kind === "video" && video.length > 0;
	const showFiles = kind === "3d" && files.length > 0;
	const hasText = Boolean(String(node.__gjjAnyPreviewText || "").trim());
	const mode = MODE_PREVIEW;

	const availableHeight = getWidgetHeight(node, node.__gjjAnyPreviewWidget);

	const isMediaPreview = showImage || showAudio || showVideo || showFiles;
	const useEstimatedImageLayout = showImage && shouldUseEstimatedImageLayout(node) && !isTileMode(node);

	grid.style.display = isMediaPreview ? (showImage ? "grid" : "flex") : "none";
	grid.style.flexDirection = "";

	if (previewItems.length > 0) {
		renderPreviewItems(node, previewItems);
		updatePreviewActionButtons(node);
		requestAnimationFrame(() => {
			const height = Math.max(
				MIN_PREVIEW_HEIGHT,
				measurePreviewItemsHeight(node),
			);
			if (node.__gjjAnyPreviewHeight !== height) {
				node.__gjjAnyPreviewHeight = height;
			}
			scheduleLayout(node);
		});
		return;
	}

	if (showImage) {
		body.style.display = "none";
		if (editor) editor.style.display = "none";
	} else if ((showAudio || showVideo || showFiles) && hasText) {
		body.style.display = mode === MODE_PREVIEW ? "block" : "none";
		if (editor) editor.style.display = mode === MODE_EDIT ? "block" : "none";
	} else if (!isMediaPreview && hasText) {
		body.style.display = mode === MODE_PREVIEW ? "block" : "none";
		if (editor) editor.style.display = mode === MODE_EDIT ? "block" : "none";
	} else {
		body.style.display = "none";
		if (editor) editor.style.display = "none";
	}

	const isEmptyPreview = !isMediaPreview && !hasText;
	empty.style.display = isEmptyPreview ? "flex" : "none";

	container.style.height = "auto";
	container.style.minHeight = isEmptyPreview ? "0" : `${MIN_PREVIEW_HEIGHT}px`;

	if (previewWrap) {
		previewWrap.style.overflow = "visible";
		previewWrap.style.height = useEstimatedImageLayout ? `${availableHeight}px` : "auto";
		previewWrap.style.minHeight = isEmptyPreview ? "24px" : (useEstimatedImageLayout ? `${availableHeight}px` : "96px");
		previewWrap.style.maxHeight = "";
		previewWrap.style.border = isEmptyPreview ? "none" : "1px solid #33434a";
		previewWrap.style.background = isEmptyPreview ? "transparent" : "#0f1418";
		previewWrap.style.padding = isEmptyPreview ? "0" : "8px";
	}

	const sequenceImage = images.find(isSequenceMediaItem);
	const tileImageEntries = showImage && isTileMode(node) ? tileImageEntriesFromImages(images) : [];
	if (showImage && isTileMode(node) && tileImageEntries.length > 1) {
		clearImageSequenceTimers(node);
		body.style.display = "none";
		renderCompactImageTiles(node, grid, tileImageEntries);
	} else if (showImage && sequenceImage) {
		node.__gjjAnyPreviewCompactTileEntries = 0;
		clearImageSequenceTimers(node);
		grid.style.display = "flex";
		grid.style.flexDirection = "column";
		grid.style.gridTemplateColumns = "1fr";
		grid.style.gap = "8px";
		grid.style.height = "auto";
		grid.style.alignItems = "stretch";
		grid.replaceChildren();
		appendAnimatedSequenceImage(node, grid, sequenceImage, hasText ? text : "");
		body.style.display = "none";
	} else if (showImage && images.length >= IMAGE_SEQUENCE_MIN_FRAMES) {
		node.__gjjAnyPreviewCompactTileEntries = 0;
		clearImageSequenceTimers(node);
		grid.style.display = "flex";
		grid.style.flexDirection = "column";
		grid.style.gridTemplateColumns = "1fr";
		grid.style.gap = "8px";
		grid.style.height = "auto";
		grid.style.alignItems = "stretch";
		grid.replaceChildren();
		appendImageSequencePlayer(node, grid, images, hasText ? text : "");
		body.style.display = "none";
	} else if (showImage) {
		node.__gjjAnyPreviewCompactTileEntries = 0;
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
				`aspect-ratio:${isSingleImage ? mediaItemAspectRatioCss(item) : "1 / 1"}`,
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

			// 单图保持完整宽高比，多图缩略卡片继续铺满画布。
			const image = document.createElement("img");
			image.src = imageDataToUrl(item);
			image.draggable = false;
			image.style.cssText = [
				"width:100%",
				"height:100%",
				`object-fit:${isSingleImage ? "contain" : "cover"}`,
				"display:block",
			].join(";");

			// 图片加载完成后更新尺寸
			image.onload = () => {
				if (sizeBadge) {
					sizeBadge.textContent = `${image.naturalWidth}×${image.naturalHeight}`;
				}
				if (isSingleImage && image.naturalWidth > 0 && image.naturalHeight > 0) {
					item.width = item.width || image.naturalWidth;
					item.height = item.height || image.naturalHeight;
					card.style.aspectRatio = `${item.width} / ${item.height}`;
				}
				scheduleLayout(node);
			};
			image.onerror = () => {
				removeFailedHeldImage(node, item);
				card.remove();
				if (!grid.children.length) {
					node.__gjjAnyPreviewKind = "";
					node.__gjjAnyPreviewImages = [];
					applyPreviewContent(node);
				}
				scheduleLayout(node);
			};
			bindAnyPreviewImageContextMenu(image, item);

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
				bindAnyPreviewImageContextMenu(previewImg, item);

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
				bindZoomableImageOverlay(overlay, previewImg, hint);
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
		node.__gjjAnyPreviewCompactTileEntries = 0;
		// 音频预览：播放器下方用一行紧凑信息展示文件和元数据。
		grid.style.gridTemplateColumns = "1fr";
		grid.style.height = "auto";
		grid.style.alignItems = "center";
		grid.replaceChildren();

		const audioItem = audio[0];
		const audioUrl = imageDataToUrl(audioItem);

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
		styleCompactAudioPlayer(audioPlayer);

		appendAudioWaveform(node, audioCard, audioUrl, audioPlayer);
		audioCard.appendChild(audioPlayer);
		appendCompactMediaInfo(node, audioCard, "audio", audioItem, hasText ? text : "");
		grid.appendChild(audioCard);
		body.style.display = "none";
	} else if (showVideo) {
		node.__gjjAnyPreviewCompactTileEntries = 0;
		// 视频预览：播放器下方用一行紧凑信息展示文件和元数据。
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

		videoCard.appendChild(videoPlayer);
		appendCompactMediaInfo(node, videoCard, "video", videoItem, hasText ? text : "");
		grid.appendChild(videoCard);
		body.style.display = "none";
	} else if (showFiles) {
		node.__gjjAnyPreviewCompactTileEntries = 0;
		grid.style.gridTemplateColumns = "1fr";
		grid.style.height = "auto";
		grid.style.alignItems = "center";
		grid.replaceChildren();

		const fileItem = files[0] || {};
		const fileCard = document.createElement("div");
		fileCard.style.cssText = [
			"display:flex",
			"flex-direction:column",
			"gap:8px",
			"padding:12px",
			"border:1px solid #33434a",
			"border-radius:8px",
			"background:#12191d",
			"width:100%",
			"box-sizing:border-box",
			"color:#d7e5e7",
			"font-size:12px",
		].join(";");
		appendPreviewTileText(fileCard, `🧊 ${fileItem.filename || "3D文件"}\n格式: ${fileItem.format || "3d"}`);
		appendCompactMediaInfo(node, fileCard, "3d", fileItem, hasText ? text : "");
		grid.appendChild(fileCard);
		body.style.display = "none";
	} else {
		node.__gjjAnyPreviewCompactTileEntries = 0;
		grid.style.gridTemplateColumns = "repeat(auto-fit, minmax(140px, 1fr))";
		grid.style.height = "";
		grid.style.alignItems = "";

		body.innerHTML = renderMarkdown(node.__gjjAnyPreviewText || text);
		clampTextPreviewLines(body);
	}

	if (copyBar) {
		updatePreviewActionButtons(node);
	}

	requestAnimationFrame(() => {
		const height = useEstimatedImageLayout
			? availableHeight
			: showImage && isTileMode(node) && tileImageEntries.length > 1
				? measurePreviewItemsHeight(node)
				: Math.max(
						MIN_PREVIEW_HEIGHT,
						Math.ceil(
							grid.scrollHeight ||
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
	clearNativeImagePreviewState(node);
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
		"min-width:0",
		"max-width:100%",
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
		`line-height:${TEXT_PREVIEW_LINE_HEIGHT}`,
		"min-width:0",
		"max-width:100%",
		"white-space:normal",
		"overflow:visible",
		"user-select:text",
		"-webkit-user-select:text",
		"pointer-events:auto",
		"cursor:text",
	].join(";");
	body.addEventListener("wheel", handleScrollableTextWheel, { passive: false });

	const copyBar = document.createElement("div");
	copyBar.style.cssText = [
		"display:none",
		"align-items:center",
		"justify-content:flex-end",
		"gap:6px",
		"width:100%",
		"min-width:0",
		"order:1",
	].join(";");

	const buttonStyle = [
		"width:24px",
		"height:24px",
		"padding:3px",
		"border:1px solid #3a4f58",
		"border-radius:5px",
		"background:#10191e",
		"color:#cdd9d7",
		"display:inline-flex",
		"align-items:center",
		"justify-content:center",
		"cursor:pointer",
		"user-select:none",
		"-webkit-user-select:none",
		"transition:background .12s ease,border-color .12s ease,filter .12s ease",
	].join(";");

	const holdButton = document.createElement("button");
	holdButton.type = "button";
	holdButton.style.cssText = buttonStyle;
	setupIconButton(holdButton, "保持文本并断开链接", HOLD_ICON_SVG);
	const reconnectButton = document.createElement("button");
	reconnectButton.type = "button";
	reconnectButton.style.cssText = `${buttonStyle};display:none`;
	reconnectButton.textContent = "🔗";
	reconnectButton.title = "重新连接上游";
	reconnectButton.setAttribute("aria-label", reconnectButton.title);
	reconnectButton.dataset.originalTitle = reconnectButton.title;
	const runButton = document.createElement("button");
	runButton.type = "button";
	runButton.style.cssText = buttonStyle;
	runButton.textContent = "▶";
	runButton.title = "运行当前 GJJ_AnyPreview 节点";
	runButton.setAttribute("aria-label", runButton.title);
	runButton.dataset.originalTitle = runButton.title;
	const tileButton = document.createElement("button");
	tileButton.type = "button";
	tileButton.style.cssText = `${buttonStyle};width:auto;min-width:42px;padding:3px 8px;font-size:11px;font-weight:700;display:none`;
	tileButton.textContent = "平铺";
	tileButton.title = "切换为紧凑平铺预览";
	tileButton.setAttribute("aria-label", tileButton.title);
	tileButton.dataset.originalTitle = tileButton.title;
	const copyNodeButton = document.createElement("button");
	copyNodeButton.type = "button";
	copyNodeButton.style.cssText = buttonStyle;
	setupIconButton(copyNodeButton, "复制节点：在当前节点旁边新建预览节点或文本节点", COPY_NODE_ICON_SVG);
	const copyClipboardButton = document.createElement("button");
	copyClipboardButton.type = "button";
	copyClipboardButton.style.cssText = buttonStyle;
	setupIconButton(copyClipboardButton, "复制到剪贴板", CLIPBOARD_ICON_SVG);

	for (const button of [holdButton, reconnectButton, runButton, tileButton, copyNodeButton, copyClipboardButton]) {
		button.className = "gjj-any-preview-action-icon";
		button.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			event.stopPropagation();
		});
		button.addEventListener("mousedown", (event) => {
			event.preventDefault();
			event.stopPropagation();
		});
		button.addEventListener("dblclick", (event) => {
			event.preventDefault();
			event.stopPropagation();
		});
		button.addEventListener("mouseenter", () => {
			if (!button.__gjjAnyPreviewFlashTimer) {
				button.style.filter = "brightness(1.12)";
			}
		});
		button.addEventListener("mouseleave", () => {
			button.style.filter = "";
		});
	}
	holdButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		holdCurrentPreview(node);
	});
	reconnectButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		reconnectAnyPreviewLinks(node);
	});
	runButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		runCurrentAnyPreviewNode(node);
	});
	tileButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		setTileMode(node, !isTileMode(node));
	});
	copyNodeButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		copyPreviewToNode(node);
	});
	copyClipboardButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		copyPreviewText(node);
	});
	copyBar.appendChild(holdButton);
	copyBar.appendChild(reconnectButton);
	copyBar.appendChild(runButton);
	copyBar.appendChild(tileButton);
	copyBar.appendChild(copyNodeButton);
	copyBar.appendChild(copyClipboardButton);

	const previewWrap = document.createElement("div");
	previewWrap.className = "gjj-any-preview-wrap";
	previewWrap.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"position:relative",
		"width:100%",
		"min-width:0",
		"max-width:100%",
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
	].join(";");

	// 添加Markdown预览的CSS样式
	const style = document.createElement("style");
	style.textContent = `
		.gjj-any-preview-action-icon svg {
			width: 16px;
			height: 16px;
			display: block;
		}
		.gjj-any-preview-action-icon:hover {
			border-color: #5f8fa0;
			background: #16242a;
		}
		.gjj-any-preview-wrap[data-gjj-any-preview-drag-active="true"] {
			border-color: #38bdf8 !important;
			box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.28), inset 0 0 0 1px rgba(56, 189, 248, 0.2);
		}
		.gjj-any-preview-drop-hint {
			position:absolute;
			inset:8px;
			z-index:5;
			display:none;
			align-items:center;
			justify-content:center;
			border:1px dashed #67e8f9;
			border-radius:8px;
			background:rgba(8, 20, 24, 0.78);
			color:#e0faff;
			font-size:13px;
			font-weight:700;
			pointer-events:none;
		}
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
			margin: 0;
			font-size: 11px;
		}
		.gjj-text-input-markdown-body th,
		.gjj-text-input-markdown-body td {
			border: 1px solid #34464e;
			padding: 5px 7px;
			text-align: left;
			vertical-align: top;
			overflow-wrap: anywhere;
			word-break: break-word;
		}
		.gjj-text-input-markdown-body th { background: #1b2930; }
		.gjj-text-input-markdown-body .gjj-any-preview-table-scroll {
			width: 100%;
			max-width: 100%;
			overflow-x: auto;
			margin: 0 0 0.75em;
		}
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
		.gjj-text-input-markdown-body[data-gjj-max-visible-lines] {
			scrollbar-width: thin;
			scrollbar-color: #52656d #10181c;
		}
	`;
	previewWrap.appendChild(style);
	previewWrap.appendChild(copyBar);
	previewWrap.appendChild(body);

	const grid = document.createElement("div");
	grid.style.cssText = [
		"display:none",
		"grid-template-columns:repeat(auto-fit, minmax(140px, 1fr))",
		"gap:1px",
		"width:100%",
		"min-width:0",
		"max-width:100%",
		"order:1",
	].join(";");
	previewWrap.appendChild(grid);

	const empty = document.createElement("div");
	empty.style.cssText = [
		"display:flex",
		"align-items:center",
		"justify-content:flex-start",
		"min-height:28px",
		"color:#8ea0a8",
		"font-size:12px",
	].join(";");
	const emptyRunButton = document.createElement("button");
	emptyRunButton.type = "button";
	emptyRunButton.textContent = "▶";
	emptyRunButton.title = "运行当前 GJJ_AnyPreview 节点";
	emptyRunButton.setAttribute("aria-label", emptyRunButton.title);
	emptyRunButton.style.cssText = [
		"width:24px",
		"height:24px",
		"padding:0",
		"border:1px solid #3a4f58",
		"border-radius:5px",
		"background:#10191e",
		"color:#cdd9d7",
		"display:inline-flex",
		"align-items:center",
		"justify-content:center",
		"cursor:pointer",
		"font-size:13px",
		"line-height:1",
	].join(";");
	for (const eventName of ["pointerdown", "mousedown", "dblclick", "wheel", "contextmenu"]) {
		emptyRunButton.addEventListener(eventName, (event) => {
			event.preventDefault();
			event.stopPropagation();
		});
	}
	emptyRunButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		runCurrentAnyPreviewNode(node);
	});
	empty.appendChild(emptyRunButton);
	previewWrap.appendChild(empty);

	const dropHint = document.createElement("div");
	dropHint.className = "gjj-any-preview-drop-hint";
	dropHint.textContent = "松开导入图片";
	previewWrap.appendChild(dropHint);

	body.style.order = "2";
	container.appendChild(previewWrap);

	const widget = node.addDOMWidget?.(
		PREVIEW_WIDGET_NAME,
		PREVIEW_WIDGET_NAME,
		container,
		{
			serialize: false,
			hideOnZoom: false,
			getHeight: () =>
				shouldUseEstimatedImageLayout(node)
					? getWidgetHeight(node, node.__gjjAnyPreviewWidget || widget)
					: hasPreviewItems(node) || hasCompactTilePreview(node) || isCompactTileGrid(node)
						? measurePreviewItemsHeight(node)
					: Math.max(
							MIN_PREVIEW_HEIGHT,
							node.__gjjAnyPreviewHeight || MIN_PREVIEW_HEIGHT,
						),
		},
	);
	if (widget) {
		widget.computeSize = (width) => [
			Math.max(MIN_WIDTH, Number(width) || preferredNodeWidth(node)),
			shouldUseEstimatedImageLayout(node)
				? estimateImagePreviewHeight(node)
				: hasPreviewItems(node) || hasCompactTilePreview(node) || isCompactTileGrid(node)
					? measurePreviewItemsHeight(node)
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
	node.__gjjAnyPreviewCopyBar = copyBar;
	node.__gjjAnyPreviewHoldButton = holdButton;
	node.__gjjAnyPreviewReconnectButton = reconnectButton;
	node.__gjjAnyPreviewRunButton = runButton;
	node.__gjjAnyPreviewTileButton = tileButton;
	node.__gjjAnyPreviewEmptyRunButton = emptyRunButton;
	node.__gjjAnyPreviewCopyNodeButton = copyNodeButton;
	node.__gjjAnyPreviewCopyClipboardButton = copyClipboardButton;
	node.__gjjAnyPreviewBody = body;
	node.__gjjAnyPreviewGrid = grid;
	node.__gjjAnyPreviewEmpty = empty;
	node.__gjjAnyPreviewDropHint = dropHint;
	installAnyPreviewDropTarget(node, [container, previewWrap, body, grid, empty]);
	applyPreviewContent(node);
	scheduleLayout(node);
}

function stabilizeNode(node) {
	if (!node) {
		return;
	}

	migrateLegacyInputs(node);
	ensureOutput(node);
	recordCurrentAnyPreviewLinks(node);
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

function slotIndex(node, slot, isOutput) {
	if (!node || slot == null) return -1;
	if (typeof slot === "number") return slot;
	if (typeof slot === "string") {
		const found = isOutput
			? node.findOutputSlot?.(slot, false)
			: node.findInputSlot?.(slot, false);
		return Number.isInteger(found) ? found : -1;
	}
	if (typeof slot === "object") {
		const slots = isOutput ? node.outputs : node.inputs;
		const index = slots?.indexOf?.(slot);
		if (Number.isInteger(index) && index >= 0) return index;
		const found = isOutput
			? node.findOutputSlot?.(slot.name, false)
			: node.findInputSlot?.(slot.name, false);
		return Number.isInteger(found) ? found : -1;
	}
	return -1;
}

function centerPreviewNodeAtPointer(node, event) {
	const x = Number(event?.canvasX);
	const y = Number(event?.canvasY);
	if (!Number.isFinite(x) || !Number.isFinite(y)) return;
	const width = Number(node?.size?.[0] || MIN_WIDTH);
	const height = Number(node?.size?.[1] || MIN_PREVIEW_HEIGHT);
	node.pos = [Math.round(x - width / 2), Math.round(y - Math.min(80, height / 2))];
}

function graphNodeById(graph, id) {
	if (!graph || id == null) return null;
	return graph.getNodeById?.(id) || graph._nodes_by_id?.[id] || graph._nodes?.find?.((node) => String(node.id) === String(id)) || null;
}

function linkById(graph, id) {
	if (!graph || id == null) return null;
	const links = graph.links;
	if (links instanceof Map) return links.get(id) || links.get(String(id)) || null;
	if (links && typeof links === "object") return links[id] || links[String(id)] || null;
	return null;
}

function connectionFromMenuOptions(opts = {}) {
	const graph = app.canvas?.graph || app.graph;
	const direct = {
		source: opts.nodeFrom,
		target: opts.nodeTo,
		sourceSlot: slotIndex(opts.nodeFrom, opts.slotFrom, true),
		targetSlot: slotIndex(opts.nodeTo, opts.slotTo, false),
	};
	if (direct.source && direct.target && direct.sourceSlot >= 0 && direct.targetSlot >= 0) {
		return direct;
	}

	const link = (typeof opts.link === "object" && opts.link) || linkById(graph, opts.afterRerouteId ?? opts.linkId ?? opts.link_id ?? opts.link?.id);
	if (!link) return direct;
	const source = graphNodeById(graph, link.origin_id ?? link.originId ?? link.source_id ?? link.sourceId);
	const target = graphNodeById(graph, link.target_id ?? link.targetId);
	return {
		source,
		target,
		sourceSlot: Number(link.origin_slot ?? link.originSlot ?? link.source_slot ?? link.sourceSlot),
		targetSlot: Number(link.target_slot ?? link.targetSlot),
		link,
	};
}

function insertAnyPreviewOnConnection(opts = {}) {
	const graph = app.canvas?.graph || app.graph;
	const connection = connectionFromMenuOptions(opts);
	const source = connection.source;
	const target = connection.target;
	const sourceSlot = connection.sourceSlot;
	const targetSlot = connection.targetSlot;
	const preview = globalThis.LiteGraph?.createNode?.("GJJ_AnyPreview");
	if (!graph || !source || !target || sourceSlot < 0 || targetSlot < 0 || !preview) {
		console.warn("[GJJ AnyPreview] 无法在连线中插入预览节点", opts);
		return false;
	}

	centerPreviewNodeAtPointer(preview, opts.e);
	graph.add(preview);

	const targetInput = target.inputs?.[targetSlot];
	if (targetInput?.link != null) {
		if (typeof target.disconnectInput === "function") {
			target.disconnectInput(targetSlot);
		} else {
			graph.removeLink?.(targetInput.link);
		}
	}

	source.connect(sourceSlot, preview, 0);
	preview.connect(0, target, targetSlot);
	stabilizeNode(preview);
	graph.change?.();
	graph.setDirtyCanvas?.(true, true);
	app.canvas?.setDirty?.(true, true);
	return true;
}

function closeLiteGraphMenus() {
	for (const menu of document.querySelectorAll(".litecontextmenu")) {
		menu.remove();
	}
}

function installConnectionPreviewMenuDomFallback(opts = {}) {
	setTimeout(() => {
		const menus = Array.from(document.querySelectorAll(".litecontextmenu"));
		const menu = menus.at(-1);
		if (!menu || menu.__gjjAnyPreviewInjected) return;
		const entries = Array.from(menu.children || []);
		if (entries.some((entry) => String(entry.textContent || "").trim() === CONNECTION_PREVIEW_MENU_LABEL)) return;
		const rerouteEntry = entries.find((entry) => String(entry.textContent || "").trim() === "Add Reroute");
		if (!rerouteEntry) return;

		const previewEntry = rerouteEntry.cloneNode(false);
		previewEntry.textContent = CONNECTION_PREVIEW_MENU_LABEL;
		previewEntry.dataset.gjjAnyPreviewMenu = "true";
		const activate = (event) => {
			event.preventDefault();
			event.stopPropagation();
			insertAnyPreviewOnConnection(opts);
			closeLiteGraphMenus();
		};
		previewEntry.addEventListener("pointerdown", activate);
		previewEntry.addEventListener("mousedown", activate);
		previewEntry.addEventListener("click", activate);
		rerouteEntry.insertAdjacentElement("afterend", previewEntry);
		menu.__gjjAnyPreviewInjected = true;
	}, 0);
}

function installConnectionPreviewMenu() {
	const canvas = app.canvas;
	if (!canvas || canvas.__gjjAnyPreviewConnectionMenuPatched) return;
	const originalShowConnectionMenu = canvas.showConnectionMenu?.bind(canvas);
	if (typeof originalShowConnectionMenu !== "function") return;

	canvas.__gjjAnyPreviewConnectionMenuPatched = true;
	canvas.showConnectionMenu = function (optPass) {
		const opts = optPass || {};
		const connection = connectionFromMenuOptions(opts);
		const canInsert = connection.source && connection.target && connection.sourceSlot >= 0 && connection.targetSlot >= 0;
		if (!canInsert) return originalShowConnectionMenu(optPass);
		installConnectionPreviewMenuDomFallback(opts);

		const OriginalContextMenu = globalThis.LiteGraph?.ContextMenu;
		if (typeof OriginalContextMenu !== "function") return originalShowConnectionMenu(optPass);

		let interceptActive = true;
		globalThis.LiteGraph.ContextMenu = function (options, menuOptions = {}) {
			globalThis.LiteGraph.ContextMenu = OriginalContextMenu;
			if (!interceptActive || !Array.isArray(options)) {
				return new OriginalContextMenu(options, menuOptions);
			}
			interceptActive = false;

			const rerouteIndex = options.indexOf("Add Reroute");
			if (rerouteIndex >= 0 && !options.includes(CONNECTION_PREVIEW_MENU_LABEL)) {
				options.splice(rerouteIndex + 1, 0, CONNECTION_PREVIEW_MENU_LABEL);
			}

			const originalCallback = menuOptions.callback;
			menuOptions.callback = function (value, callbackOptions, event) {
				if (value === CONNECTION_PREVIEW_MENU_LABEL) {
					insertAnyPreviewOnConnection(opts);
					return;
				}
				return originalCallback?.call(this, value, callbackOptions, event);
			};

			return new OriginalContextMenu(options, menuOptions);
		};
		globalThis.LiteGraph.ContextMenu.prototype = OriginalContextMenu.prototype;

		try {
			return originalShowConnectionMenu(optPass);
		} finally {
			globalThis.LiteGraph.ContextMenu = OriginalContextMenu;
			interceptActive = false;
		}
	};
}

installNativePreviewEventFilter();
ensureMotionGuardStyle();

app.registerExtension({
	name: "Comfy.GJJ.AnyPreview.AudioLiveMediaGuard",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		nodeData.output_preview = false;
		nodeType.prototype.hideOutputImages = true;
		if (Array.isArray(nodeData.outputs)) {
			for (const output of nodeData.outputs) {
				output.preview = false;
			}
		}

		const originalAddCustomWidget = nodeType.prototype.addCustomWidget;
		nodeType.prototype.addCustomWidget = function (widget, ...args) {
			if (isNativePreviewWidget(this, widget)) {
				return suppressNativePreviewWidget(widget);
			}
			return typeof originalAddCustomWidget === "function"
				? originalAddCustomWidget.call(this, widget, ...args)
				: widget;
		};

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			clearNativeImagePreviewState(this);
			resetLivePreviewState(this);
			setTimeout(() => stabilizeNode(this), 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const configuredWidth = serializedNodeWidth(serializedNode);
			if (configuredWidth > 0) {
				this.__gjjAnyPreviewConfiguredWidth = configuredWidth;
				rememberNodeWidth(this, configuredWidth);
			}
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			if (configuredWidth > 0) {
				this.__gjjAnyPreviewConfiguredWidth = configuredWidth;
				rememberNodeWidth(this, configuredWidth);
				restoreConfiguredWidth(this);
			}
			clearNativeImagePreviewState(this);
			resetLivePreviewState(this);
			if (hasHeldPreviewProperties(this)) {
				applyHeldPreview(this);
			}
			setTimeout(() => {
				restoreConfiguredWidth(this);
				if (hasHeldPreviewProperties(this)) {
					applyHeldPreview(this);
				}
				stabilizeNode(this);
			}, 0);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode, ...args) {
			serializedNode = serializedNode || {};
			if (!this.__gjjAnyPreviewInternalResize) {
				rememberNodeWidth(this);
			}
			const result = originalOnSerialize?.apply(this, [serializedNode, ...args]);
			serializedNode.properties = serializedNode.properties || {};
			serializedNode.properties[WIDTH_PROPERTY] = preferredNodeWidth(this) || serializedNode.properties[WIDTH_PROPERTY];
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const [, , connected] = args || [];
			if (!connected) {
				rememberCurrentPreviewAsHeld(this);
			}
			recordAnyPreviewLinkFromConnectionEvent(this, args);
			const result = originalOnConnectionsChange?.apply(this, args);
			recordCurrentAnyPreviewLinks(this);
			if (!hasLinkedInputs(this)) {
				rememberCurrentPreviewAsHeld(this);
			}
			resetLivePreviewState(this);
			if (!hasLinkedInputs(this)) {
				applyHeldPreview(this);
			}
			scheduleStabilize(this);
			return result;
		};

		const originalOnDrawBackground = nodeType.prototype.onDrawBackground;
		nodeType.prototype.onDrawBackground = function (...args) {
			if (shouldSuppressNativePreview(this)) {
				clearNativeImagePreviewState(this);
				const sizeSignature = `${Math.round(this.size?.[0] || 0)}x${Math.round(this.size?.[1] || 0)}`;
				if (this.__gjjAnyPreviewSizeSignature !== sizeSignature) {
					this.__gjjAnyPreviewSizeSignature = sizeSignature;
					// 只更新高度，不重新渲染内容，避免无限循环
					updateLayout(this);
				}
			}
			const result = typeof originalOnDrawBackground === "function"
				? originalOnDrawBackground.apply(this, args)
				: undefined;
			if (shouldSuppressNativePreview(this)) {
				clearNativeImagePreviewState(this);
			}
			return result;
		};

		const originalOnDrawForeground = nodeType.prototype.onDrawForeground;
		nodeType.prototype.onDrawForeground = function (...args) {
			if (shouldSuppressNativePreview(this)) {
				clearNativeImagePreviewState(this);
			}
			const result = typeof originalOnDrawForeground === "function"
				? originalOnDrawForeground.apply(this, args)
				: undefined;
			if (shouldSuppressNativePreview(this)) {
				clearNativeImagePreviewState(this);
			}
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = typeof originalOnResize === "function"
				? originalOnResize.apply(this, args)
				: undefined;
			if (!this.__gjjAnyPreviewInternalResize) {
				rememberNodeWidth(this);
			}
			// 用户手动调整宽度后，只按当前宽度重新计算高度，不反向改宽度。
			if (hasPreviewItems(this) || hasCompactTilePreview(this)) {
				requestAnimationFrame(() => {
					applyPreviewContent(this);
					updateLayout(this);
				});
			} else {
				scheduleLayout(this);
			}
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			clearNativeImagePreviewState(this);
			const result =
				typeof originalOnExecuted === "function"
					? originalOnExecuted.call(this, withoutNativeImagePreview(message || {}))
					: undefined;
			clearNativeImagePreviewState(this);
			if (applyExecutedMessageAsLiveInput(this, message || {})) {
				clearNativeImagePreviewState(this);
				scheduleNativePreviewCleanup(this);
				scheduleStabilize(this, 0);
				return result;
			}
			const liveText = getLoraEffectLiveText(this);
			this.__gjjAnyPreviewKind =
				liveText !== null ? "text" : message?.preview_kind?.[0] || "";
			this.__gjjAnyPreviewLiveOnly = false;
			this.__gjjAnyPreviewText =
				liveText !== null ? liveText : message?.preview_text?.[0] || "";
			const previewItems =
				liveText !== null ? [] : normalizePreviewItemsPayload(message?.preview_items);
			this.__gjjAnyPreviewItems =
				liveText !== null
					? []
					: reorderPreviewItemsByLiveOrder(this, previewItems);
			this.__gjjAnyPreviewImages =
				liveText !== null
					? []
					: firstMediaPayload(message?.preview_images, message?.images, message?.__gjj_queue_images);
			// 同时兼容本节点 preview_audio 和 ComfyUI 原生 audio 字段。
			this.__gjjAnyPreviewAudio =
				liveText !== null
					? []
					: firstMediaPayload(message?.preview_audio, message?.audio);
			// 修复：视频数据是元组，需要取第一个元素
			this.__gjjAnyPreviewVideo =
				liveText !== null
					? []
					: firstMediaPayload(
						message?.preview_video,
						message?.preview_media,
						message?.animated,
						message?.gifs,
					);
			this.__gjjAnyPreviewFiles =
				liveText !== null
					? []
					: firstMediaPayload(message?.preview_files, message?.files);
			if (!hasLinkedInputs(this) && hasHeldPreviewProperties(this)) {
				resetLivePreviewState(this);
				applyHeldPreview(this);
				clearNativeImagePreviewState(this);
				scheduleNativePreviewCleanup(this);
				scheduleStabilize(this, 0);
				return result;
			}
			resetLivePreviewState(this);
			clearNativeImagePreviewState(this);
			const textLineCount = String(this.__gjjAnyPreviewText || "").split(/\r?\n/).length;
			const visibleTextLines = Math.min(TEXT_PREVIEW_MAX_LINES, Math.max(1, textLineCount));
			this.__gjjAnyPreviewHeight = Math.max(
				MIN_PREVIEW_HEIGHT,
				Math.ceil(visibleTextLines * 12 * TEXT_PREVIEW_LINE_HEIGHT + 38),
			);
			requestAnimationFrame(() => {
				clearNativeImagePreviewState(this);
				applyPreviewContent(this);
				rememberCurrentPreviewAsHeld(this, false);
				clearNativeImagePreviewState(this);
				updateLayout(this);
				scheduleNativePreviewCleanup(this);
				scheduleStabilize(this, 0);
			});
			return result;
		};
	},

	onNodeOutputsUpdated() {
		for (const node of app.graph?._nodes || []) {
			if (isTargetNode(node)) {
				clearNativeImagePreviewState(node);
				scheduleNativePreviewCleanup(node);
			}
		}
	},

	setup() {
		installConnectionPreviewMenu();
		installCanvasMotionGuard();
		installLiveVirtualPreviewPromptPatch();
		installHeldPreviewRestoreEvents();
		for (const node of app.graph?._nodes || []) {
			if (isTargetNode(node)) {
				resetLivePreviewState(node);
				restoreHeldPreviewForNode(node);
				stabilizeNode(node);
			}
		}
	},
});

api.addEventListener("execution_start", (event) => {
	lastPromptId = eventPromptId(event);
});

api.addEventListener("executed", refreshLivePreviewFromExecuted);
