import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_ImageComparer"]);
const DOM_WIDGET_NAME = "gjj_image_compare_dom";
const STATE_PROPERTY = "gjj_image_compare_state";
const SLIDER_PROPERTY = "gjj_image_compare_slider";
const LAYOUT_PROPERTY = "gjj_image_compare_layout";
const MIN_WIDTH = 360;
const MIN_NODE_HEIGHT = 180;
const MIN_COMPARE_HEIGHT = 120;
const DEFAULT_ASPECT_RATIO = 1;
const MIN_ASPECT_RATIO = 0.05;
const MAX_ASPECT_RATIO = 20;
const ESTIMATED_WIDGET_SIDE_PADDING = 28;
const SELECTOR_BAR_HEIGHT = 32;
const NODE_CHROME_FALLBACK_HEIGHT = 78;

function isTargetNode(node) {
	return TARGET_NODES.has(node?.comfyClass) || TARGET_NODES.has(node?.type);
}

function imageDataToUrl(data) {
	if (!data?.filename) {
		return "";
	}
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : "";
	return api.apiURL(
		`/view?filename=${encodeURIComponent(data.filename)}&type=${data.type}&subfolder=${encodeURIComponent(data.subfolder || "")}${previewFormat}${randParam}`
	);
}

function requestRedraw(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function finiteNumber(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? number : fallback;
}

function scheduleFrame(callback) {
	if (typeof requestAnimationFrame === "function") {
		requestAnimationFrame(callback);
		return;
	}
	setTimeout(callback, 0);
}

function getPersistedState(node) {
	const state = node?.properties?.[STATE_PROPERTY];
	if (!state || typeof state !== "object") {
		return {};
	}
	return state;
}

function setPersistedState(node, patch) {
	node.properties = node.properties || {};
	node.properties[STATE_PROPERTY] = {
		...getPersistedState(node),
		...patch,
	};
}

function getPersistedLayout(node) {
	const layout = node?.properties?.[LAYOUT_PROPERTY];
	if (!layout || typeof layout !== "object") {
		return {};
	}
	return layout;
}

function setPersistedLayout(node, patch) {
	node.properties = node.properties || {};
	node.properties[LAYOUT_PROPERTY] = {
		...getPersistedLayout(node),
		...patch,
	};
	return node.properties[LAYOUT_PROPERTY];
}

function getSliderRatio(node) {
	const ratio = Number(node?.properties?.[SLIDER_PROPERTY]);
	return Number.isFinite(ratio) ? clamp(ratio, 0, 1) : 0.5;
}

function setSliderRatio(node, ratio) {
	node.properties = node.properties || {};
	node.properties[SLIDER_PROPERTY] = clamp(Number(ratio) || 0.5, 0, 1);
}

function validDimension(width, height) {
	return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

function getImageAspectRatio(node) {
	const layout = getPersistedLayout(node);
	let aspect = finiteNumber(layout.aspect, 0);
	const width = finiteNumber(layout.image_width, 0);
	const height = finiteNumber(layout.image_height, 0);
	if ((!Number.isFinite(aspect) || aspect <= 0) && validDimension(width, height)) {
		aspect = width / height;
	}
	if (!Number.isFinite(aspect) || aspect <= 0) {
		aspect = DEFAULT_ASPECT_RATIO;
	}
	return clamp(aspect, MIN_ASPECT_RATIO, MAX_ASPECT_RATIO);
}

function getSavedNodeWidth(node) {
	const layout = getPersistedLayout(node);
	return Math.max(MIN_WIDTH, finiteNumber(layout.width, finiteNumber(node?.size?.[0], MIN_WIDTH)));
}

function imageSignature(item) {
	return [item?.name || "", item?.url || "", item?.width || "", item?.height || ""].join("|");
}

function normalizeImagesFromOutput(output) {
	if ("images" in (output || {})) {
		return {
			images: (output.images || []).map((item, index) => ({
				name: index === 0 ? "A" : "B",
				selected: true,
				url: imageDataToUrl(item),
				width: finiteNumber(item?.width, 0),
				height: finiteNumber(item?.height, 0),
			})),
		};
	}

	const aImages = output?.a_images || [];
	const bImages = output?.b_images || [];
	const images = [];
	const multiple = aImages.length + bImages.length > 2;

	for (const [index, item] of aImages.entries()) {
		images.push({
			name: aImages.length > 1 || multiple ? `A${index + 1}` : "A",
			selected: index === 0,
			url: imageDataToUrl(item),
			width: finiteNumber(item?.width, 0),
			height: finiteNumber(item?.height, 0),
		});
	}

	for (const [index, item] of bImages.entries()) {
		images.push({
			name: bImages.length > 1 || multiple ? `B${index + 1}` : "B",
			selected: index === 0,
			url: imageDataToUrl(item),
			width: finiteNumber(item?.width, 0),
			height: finiteNumber(item?.height, 0),
		});
	}

	return { images };
}

function coerceImageState(node, payload) {
	let images = [];
	if (Array.isArray(payload)) {
		images = payload.map((item, index) => {
			if (!item || typeof item === "string") {
				return { url: String(item || ""), name: index === 0 ? "A" : "B", selected: true };
			}
			return { ...item };
		});
	} else if (payload?.images) {
		images = payload.images.map((item) => ({ ...item }));
	}

	if (images.length > 2) {
		const hasA = images.some((item) => String(item?.name || "").startsWith("A"));
		const hasB = images.some((item) => String(item?.name || "").startsWith("B"));
		if (!hasA || !hasB) {
			images = [images[0], images[1]].filter(Boolean);
		}
	}

	for (const item of images) {
		item.width = finiteNumber(item?.width, 0);
		item.height = finiteNumber(item?.height, 0);
	}

	const persisted = getPersistedState(node);
	if (persisted?.selectedA || persisted?.selectedB) {
		for (const item of images) {
			item.selected = item.name === persisted.selectedA || item.name === persisted.selectedB;
		}
	}

	let selected = images.filter((item) => item?.selected);
	if (!selected.length && images.length) {
		images[0].selected = true;
	}
	selected = images.filter((item) => item?.selected);
	if (selected.length === 1 && images.length > 1) {
		const second = images.find((item) => !item.selected);
		if (second) {
			second.selected = true;
		}
	}

	return {
		images,
		selected: images.filter((item) => item?.selected).slice(0, 2),
	};
}

function selectedDimensionCandidate(node) {
	const state = getCurrentState(node);
	return state.selected.find((item) => validDimension(item?.width, item?.height))
		|| state.images.find((item) => item?.selected && validDimension(item?.width, item?.height))
		|| state.images.find((item) => validDimension(item?.width, item?.height))
		|| null;
}

function updateAspectFromState(node) {
	const candidate = selectedDimensionCandidate(node);
	if (!candidate) {
		return false;
	}
	const width = finiteNumber(candidate.width, 0);
	const height = finiteNumber(candidate.height, 0);
	if (!validDimension(width, height)) {
		return false;
	}
	const aspect = clamp(width / height, MIN_ASPECT_RATIO, MAX_ASPECT_RATIO);
	const signature = imageSignature(candidate);
	const layout = getPersistedLayout(node);
	const changed = Math.abs(finiteNumber(layout.aspect, 0) - aspect) > 0.0001
		|| finiteNumber(layout.image_width, 0) !== width
		|| finiteNumber(layout.image_height, 0) !== height
		|| layout.image_signature !== signature;
	if (changed) {
		setPersistedLayout(node, {
			aspect,
			image_width: width,
			image_height: height,
			image_signature: signature,
		});
	}
	return changed;
}

function getWidgetWorkWidth(node, widgetWidth = null) {
	const nodeWidth = Math.max(MIN_WIDTH, finiteNumber(widgetWidth, getSavedNodeWidth(node)));
	const measured = finiteNumber(node.__gjjCompareMeasuredWidth, 0);
	const measuredFor = finiteNumber(node.__gjjCompareMeasuredForNodeWidth, 0);
	if (measured > 0 && Math.abs(measuredFor - nodeWidth) <= 2) {
		return Math.max(1, measured);
	}
	return Math.max(1, nodeWidth - ESTIMATED_WIDGET_SIDE_PADDING);
}

function getSelectorBarHeight(node) {
	const state = getCurrentState(node);
	if (state.images.length <= 2) {
		return 0;
	}
	const measured = Math.ceil(finiteNumber(node.__gjjCompareSelectorBar?.getBoundingClientRect?.().height, 0));
	return Math.max(SELECTOR_BAR_HEIGHT, measured || SELECTOR_BAR_HEIGHT);
}

function getCompareAreaHeight(node, widgetWidth = null) {
	const workWidth = getWidgetWorkWidth(node, widgetWidth);
	return Math.max(MIN_COMPARE_HEIGHT, Math.round(workWidth / getImageAspectRatio(node)));
}

function getWidgetHeight(node, widget, widgetWidth = null) {
	return getSelectorBarHeight(node) + getCompareAreaHeight(node, widgetWidth);
}

function syncDomDimensions(node, widgetWidth = null) {
	const container = node.__gjjCompareContainer;
	const compareArea = node.__gjjCompareArea;
	if (!container || !compareArea) {
		return;
	}
	const width = Math.max(MIN_WIDTH, finiteNumber(widgetWidth, getSavedNodeWidth(node)));
	const measured = Math.round(finiteNumber(container.getBoundingClientRect?.().width, 0));
	if (measured > 0) {
		node.__gjjCompareMeasuredWidth = measured;
		node.__gjjCompareMeasuredForNodeWidth = width;
	}
	const selectorHeight = getSelectorBarHeight(node);
	const compareHeight = getCompareAreaHeight(node, width);
	const widgetHeight = selectorHeight + compareHeight;
	container.style.height = `${widgetHeight}px`;
	container.style.minHeight = `${widgetHeight}px`;
	container.style.maxHeight = `${widgetHeight}px`;
	compareArea.style.height = `${compareHeight}px`;
	compareArea.style.minHeight = `${compareHeight}px`;
	compareArea.style.maxHeight = `${compareHeight}px`;
	compareArea.style.flex = `0 0 ${compareHeight}px`;
	compareArea.style.borderRadius = selectorHeight > 0 ? "0 0 6px 6px" : "6px";
}

function getTargetNodeHeight(node, width = null) {
	const nodeWidth = Math.max(MIN_WIDTH, finiteNumber(width, getSavedNodeWidth(node)));
	const originalWidth = finiteNumber(node?.size?.[0], 0);
	if (Array.isArray(node?.size) && Math.abs(originalWidth - nodeWidth) > 1) {
		node.size[0] = nodeWidth;
	}
	let computed = [];
	try {
		computed = node.computeSize?.() || [];
	} finally {
		if (Array.isArray(node?.size) && Math.abs(originalWidth - nodeWidth) > 1) {
			node.size[0] = originalWidth;
		}
	}
	const widgetHeight = getWidgetHeight(node, node.__gjjCompareWidget, nodeWidth);
	return Math.max(
		MIN_NODE_HEIGHT,
		Math.ceil(finiteNumber(computed?.[1], widgetHeight + NODE_CHROME_FALLBACK_HEIGHT))
	);
}

function storeCurrentLayout(node, width = null, height = null) {
	const nodeWidth = Math.max(MIN_WIDTH, finiteNumber(width, finiteNumber(node?.size?.[0], getSavedNodeWidth(node))));
	const nodeHeight = Math.max(MIN_NODE_HEIGHT, finiteNumber(height, getTargetNodeHeight(node, nodeWidth)));
	const widgetHeight = getWidgetHeight(node, node.__gjjCompareWidget, nodeWidth);
	setPersistedLayout(node, {
		width: Math.round(nodeWidth),
		node_height: Math.round(nodeHeight),
		widget_height: Math.round(widgetHeight),
		aspect: getImageAspectRatio(node),
	});
}

function applyCompareLayout(node, options = {}) {
	if (!node) {
		return;
	}
	const restoreWidth = Boolean(options.restoreWidth);
	const savedWidth = finiteNumber(getPersistedLayout(node).width, 0);
	const currentWidth = finiteNumber(node.size?.[0], 0);
	const width = Math.max(MIN_WIDTH, restoreWidth && savedWidth > 0 ? savedWidth : (currentWidth || savedWidth || MIN_WIDTH));
	syncDomDimensions(node, width);
	const height = getTargetNodeHeight(node, width);
	storeCurrentLayout(node, width, height);
	const widthChanged = Math.abs(finiteNumber(node.size?.[0], 0) - width) > 1;
	const heightChanged = Math.abs(finiteNumber(node.size?.[1], 0) - height) > 1;
	if (!node.__gjjCompareSizing && (widthChanged || heightChanged)) {
		node.__gjjCompareSizing = true;
		try {
			node.setSize?.([width, height]);
		} finally {
			scheduleFrame(() => {
				node.__gjjCompareSizing = false;
				syncDomDimensions(node, width);
				const refinedHeight = getTargetNodeHeight(node, width);
				if (Math.abs(finiteNumber(node.size?.[1], 0) - refinedHeight) > 1) {
					scheduleCompareLayout(node);
				}
				requestRedraw(node);
			});
		}
		return;
	}
	const refinedHeight = getTargetNodeHeight(node, width);
	if (Math.abs(finiteNumber(node.size?.[1], 0) - refinedHeight) > 1) {
		scheduleCompareLayout(node);
	}
	requestRedraw(node);
}

function scheduleCompareLayout(node, options = {}) {
	if (!node) {
		return;
	}
	clearTimeout(node.__gjjCompareLayoutTimer);
	node.__gjjCompareLayoutTimer = setTimeout(() => {
		scheduleFrame(() => applyCompareLayout(node, options));
	}, finiteNumber(options.delay, 0));
}

function syncUserWidthFromNode(node) {
	if (!node || node.__gjjCompareSizing) {
		return false;
	}
	const width = Math.max(MIN_WIDTH, finiteNumber(node.size?.[0], 0));
	if (!width) {
		return false;
	}
	const saved = finiteNumber(getPersistedLayout(node).width, 0);
	if (Math.abs(saved - width) <= 1) {
		return false;
	}
	setPersistedLayout(node, { width: Math.round(width) });
	return true;
}

function createButton(label) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.style.cssText = [
		"height:24px",
		"padding:0 10px",
		"border:1px solid #465761",
		"border-radius:4px",
		"background:#1a2328",
		"color:#dce7e2",
		"font-size:11px",
		"font-weight:500",
		"line-height:1",
		"cursor:pointer",
		"transition:all 0.15s ease",
		"box-sizing:border-box",
	].join(";");
	
	// 添加悬停效果
	button.addEventListener("mouseenter", () => {
		button.style.background = "#26343d";
		button.style.borderColor = "#7d96a2";
	});
	button.addEventListener("mouseleave", () => {
		if (!button.style.background.includes("#26343d")) {
			button.style.background = "#1a2328";
			button.style.borderColor = "#465761";
		}
	});
	
	return button;
}

function getCanvasElement() {
	return app.canvas?.canvas || app.canvasEl || document.querySelector("canvas");
}

function updateImageDimensionsForUrl(node, url, width, height) {
	if (!url || !validDimension(width, height)) {
		return false;
	}
	const state = getCurrentState(node);
	let matched = false;
	for (const item of state.images) {
		if (item?.url && (item.url === url || String(url).includes(item.url))) {
			item.width = Math.round(width);
			item.height = Math.round(height);
			matched = true;
		}
	}
	if (matched && updateAspectFromState(node)) {
		scheduleCompareLayout(node);
	}
	return matched;
}

function readLoadedImageDimensions(node, img) {
	const width = finiteNumber(img?.naturalWidth, finiteNumber(img?.width, 0));
	const height = finiteNumber(img?.naturalHeight, finiteNumber(img?.height, 0));
	const url = img?.dataset?.gjjSrc || img?.currentSrc || img?.src || "";
	updateImageDimensionsForUrl(node, url, width, height);
}

function callCanvasMouseMethod(methodName, event) {
	const canvasController = app.canvas;
	const method = canvasController?.[methodName];
	if (typeof method !== "function" || !event) {
		return;
	}
	try {
		const forwarded = {
			type: event.type,
			clientX: event.clientX,
			clientY: event.clientY,
			screenX: event.screenX,
			screenY: event.screenY,
			button: event.button,
			buttons: event.buttons,
			which: typeof event.which === "number" ? event.which : event.button + 1,
			ctrlKey: event.ctrlKey,
			shiftKey: event.shiftKey,
			altKey: event.altKey,
			metaKey: event.metaKey,
			target: getCanvasElement(),
			currentTarget: getCanvasElement(),
			preventDefault() {},
			stopPropagation() {},
		};
		method.call(canvasController, forwarded);
	} catch (error) {
		console.debug?.("GJJ ImageCompare canvas mouse forward failed:", error);
	}
}

function forwardMouseEventToCanvas(event, type = event?.type) {
	const canvas = getCanvasElement();
	if (!canvas || !event || !type) {
		return;
	}
	const forwarded = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		composed: true,
		view: window,
		screenX: event.screenX,
		screenY: event.screenY,
		clientX: event.clientX,
		clientY: event.clientY,
		ctrlKey: event.ctrlKey,
		shiftKey: event.shiftKey,
		altKey: event.altKey,
		metaKey: event.metaKey,
		button: event.button,
		buttons: event.buttons,
		relatedTarget: null,
	});
	canvas.dispatchEvent(forwarded);
}

function forwardWheelEventToCanvas(event) {
	const canvas = getCanvasElement();
	if (!canvas || !event) {
		return;
	}
	const forwarded = new WheelEvent("wheel", {
		bubbles: true,
		cancelable: true,
		composed: true,
		view: window,
		screenX: event.screenX,
		screenY: event.screenY,
		clientX: event.clientX,
		clientY: event.clientY,
		deltaX: event.deltaX,
		deltaY: event.deltaY,
		deltaZ: event.deltaZ,
		deltaMode: event.deltaMode,
		ctrlKey: event.ctrlKey,
		shiftKey: event.shiftKey,
		altKey: event.altKey,
		metaKey: event.metaKey,
	});
	canvas.dispatchEvent(forwarded);
}

function buildCompareDom(node) {
	const container = document.createElement("div");
	container.className = "gjj-image-compare";
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:0",
		"width:100%",
		"height:100%",
		"min-height:0",
		"box-sizing:border-box",
		"padding:0",
		"margin:0",
		"cursor:default",
		"position:relative",
	].join(";");

	const selectorBar = document.createElement("div");
	selectorBar.style.cssText = [
		"display:none",
		"flex-wrap:wrap",
		"gap:4px",
		"align-items:center",
		"padding:2px 4px",
		"min-height:28px",
		"background:#0f1418",
		"border:1px solid #2a3a42",
		"border-bottom:none",
		"border-radius:6px 6px 0 0",
	].join(";");

	const compareArea = document.createElement("div");
	compareArea.style.cssText = [
		"position:relative",
		"width:100%",
		"flex:1 1 auto",
		"min-height:0",
		"overflow:hidden",
		"border:1px solid #2a3a42",
		"border-radius:0 0 6px 6px",
		"background:#0a0f12",
		"user-select:none",
		"touch-action:none",
		"cursor:default",
	].join(";");

	const emptyState = document.createElement("div");
	emptyState.textContent = "执行后在这里滑动对比两张图片";
	emptyState.style.cssText = [
		"position:absolute",
		"inset:0",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"padding:12px",
		"color:#8ea0a8",
		"font-size:12px",
		"text-align:center",
		"pointer-events:none",
	].join(";");

	const baseImage = document.createElement("img");
	baseImage.draggable = false;
	baseImage.style.cssText = [
		"position:absolute",
		"inset:0",
		"width:100%",
		"height:100%",
		"object-fit:contain",
		"pointer-events:none",
	].join(";");

	const overlayImage = document.createElement("img");
	overlayImage.draggable = false;
	overlayImage.style.cssText = [
		"position:absolute",
		"inset:0",
		"width:100%",
		"height:100%",
		"object-fit:contain",
		"clip-path:inset(0 50% 0 0)",
		"pointer-events:none",
	].join(";");

	baseImage.addEventListener("load", () => readLoadedImageDimensions(node, baseImage));
	overlayImage.addEventListener("load", () => readLoadedImageDimensions(node, overlayImage));

	const divider = document.createElement("div");
	divider.style.cssText = [
		"position:absolute",
		"top:0",
		"bottom:0",
		"left:50%",
		"width:0.1px",
		"margin-left:-1px",
		"background:rgba(255,255,255,0.3)",
		"box-shadow:none",
		"pointer-events:none",
	].join(";");

	const handle = document.createElement("div");
	handle.style.cssText = [
		"position:absolute",
		"top:50%",
		"left:50%",
		"width:2px",
		"height:2px",
		"margin-left:1px",
		"margin-top:1px",
		"border:none",
		"border-radius:0",
		"background:transparent",
		"box-sizing:border-box",
		"pointer-events:none",
	].join(";");

	compareArea.appendChild(baseImage);
	compareArea.appendChild(overlayImage);
	compareArea.appendChild(divider);
	compareArea.appendChild(handle);
	compareArea.appendChild(emptyState);

	container.appendChild(selectorBar);
	container.appendChild(compareArea);

	const stopEvent = (event) => {
		event.preventDefault();
		event.stopPropagation();
	};

	const isPrimaryPointer = (event) => {
		if (!event) {
			return false;
		}
		if (typeof event.button === "number") {
			return event.button === 0;
		}
		return true;
	};

	const isMiddlePointerActive = (event) => {
		const buttons = Number(event?.buttons || 0);
		return (buttons & 4) === 4;
	};

	let forwardingMiddleDrag = false;
	let compareAreaPointerEvents = "";

	const forwardMiddleDrag = (event) => {
		callCanvasMouseMethod("processMouseMove", event);
		forwardMouseEventToCanvas(event);
	};

	const onWindowMiddleMove = (event) => {
		if (!forwardingMiddleDrag) {
			return;
		}
		forwardMiddleDrag(event);
	};

	const onWindowMiddleUp = (event) => {
		if (!forwardingMiddleDrag) {
			return;
		}
		callCanvasMouseMethod("processMouseUp", event);
		forwardMiddleDrag(event);
		forwardingMiddleDrag = false;
		compareArea.style.pointerEvents = compareAreaPointerEvents;
		window.removeEventListener("mousemove", onWindowMiddleMove, true);
		window.removeEventListener("mouseup", onWindowMiddleUp, true);
	};

	const setRatioFromEvent = (event) => {
		const rect = compareArea.getBoundingClientRect();
		if (!rect.width) {
			return;
		}
		const clientX = typeof event.clientX === "number" ? event.clientX : rect.left + rect.width / 2;
		const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
		setSliderRatio(node, ratio);
		renderCompare(node);
	};

	compareArea.addEventListener("pointerdown", (event) => {
		if (!isPrimaryPointer(event)) {
			return;
		}
		stopEvent(event);
		compareArea.setPointerCapture?.(event.pointerId);
		setRatioFromEvent(event);
	});
	compareArea.addEventListener("pointermove", (event) => {
		if (isMiddlePointerActive(event)) {
			return;
		}
		if ((Number(event?.buttons || 0) & 1) !== 1) {
			return;
		}
		stopEvent(event);
		setRatioFromEvent(event);
	});
	compareArea.addEventListener("pointerenter", (event) => {
		if (isMiddlePointerActive(event)) {
			return;
		}
		setRatioFromEvent(event);
	});
	compareArea.addEventListener(
		"wheel",
		(event) => {
			forwardWheelEventToCanvas(event);
		},
		{ passive: true },
	);
	compareArea.addEventListener("mousedown", (event) => {
		if (event.button === 1) {
			event.preventDefault();
			event.stopPropagation();
			forwardingMiddleDrag = true;
			compareAreaPointerEvents = compareArea.style.pointerEvents;
			compareArea.style.pointerEvents = "none";
			callCanvasMouseMethod("processMouseDown", event);
			forwardMouseEventToCanvas(event);
			window.addEventListener("mousemove", onWindowMiddleMove, true);
			window.addEventListener("mouseup", onWindowMiddleUp, true);
			return;
		}
		if (!isPrimaryPointer(event)) {
			return;
		}
		stopEvent(event);
	});
	compareArea.addEventListener("auxclick", (event) => {
		if (event.button === 1) {
			event.preventDefault();
			event.stopPropagation();
		}
	});
	compareArea.addEventListener("click", (event) => {
		if (!isPrimaryPointer(event)) {
			return;
		}
		stopEvent(event);
	});

	node.__gjjCompareContainer = container;
	node.__gjjCompareSelectorBar = selectorBar;
	node.__gjjCompareArea = compareArea;
	node.__gjjCompareBaseImage = baseImage;
	node.__gjjCompareOverlayImage = overlayImage;
	node.__gjjCompareDivider = divider;
	node.__gjjCompareHandle = handle;
	node.__gjjCompareEmpty = emptyState;

	return container;
}

function getCurrentState(node) {
	if (!node.__gjjCompareState) {
		node.__gjjCompareState = { images: [], selected: [] };
	}
	return node.__gjjCompareState;
}

function setSelectedPair(node, nextPair) {
	const state = getCurrentState(node);
	const names = nextPair.map((item) => item?.name).filter(Boolean);
	for (const image of state.images) {
		image.selected = names.includes(image.name);
	}
	state.selected = state.images.filter((item) => item.selected).slice(0, 2);
	setPersistedState(node, {
		selectedA: state.selected[0]?.name || "",
		selectedB: state.selected[1]?.name || "",
	});
	renderCompare(node);
}

function onSelectionDown(node, imageData) {
	const state = getCurrentState(node);
	const selected = [...state.selected];
	if (String(imageData?.name || "").startsWith("A")) {
		selected[0] = imageData;
	} else if (String(imageData?.name || "").startsWith("B")) {
		selected[1] = imageData;
	} else if (selected.length < 2) {
		selected.push(imageData);
	} else {
		selected[1] = imageData;
	}
	setSelectedPair(node, selected.filter(Boolean));
}

function updateSelectorBar(node) {
	const selectorBar = node.__gjjCompareSelectorBar;
	const state = getCurrentState(node);
	if (!selectorBar) {
		return;
	}

	selectorBar.replaceChildren();
	if (state.images.length <= 2) {
		selectorBar.style.display = "none";
		syncDomDimensions(node);
		return;
	}

	selectorBar.style.display = "flex";
	
	// 添加分组标签
	let lastGroup = "";
	for (const item of state.images) {
		const currentGroup = String(item?.name || "").startsWith("A") ? "A" : "B";
		
		// 如果是新组的开始，添加分隔符
		if (currentGroup !== lastGroup && lastGroup !== "") {
			const separator = document.createElement("div");
			separator.style.cssText = [
				"width:1px",
				"height:16px",
				"background:#2a3a42",
				"margin:0 4px",
			].join(";");
			selectorBar.appendChild(separator);
		}
		lastGroup = currentGroup;
		
		const button = createButton(item.name);
		// 选中状态样式
		if (item.selected) {
			button.style.background = "#1f6b43";
			button.style.borderColor = "#48ad73";
			button.style.color = "#ffffff";
		} else {
			button.style.background = "#1a2328";
			button.style.borderColor = "#465761";
			button.style.color = "#dce7e2";
		}
		
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			onSelectionDown(node, item);
		});
		
		selectorBar.appendChild(button);
	}
	syncDomDimensions(node);
}

function setImageSource(image, url) {
	const nextUrl = String(url || "");
	if (image.dataset.gjjSrc === nextUrl) {
		return;
	}
	image.dataset.gjjSrc = nextUrl;
	image.src = nextUrl;
}

function renderCompare(node) {
	const state = getCurrentState(node);
	const selectedA = state.selected[0];
	const selectedB = state.selected[1];
	const ratio = getSliderRatio(node);
	const percent = `${ratio * 100}%`;

	if (!node.__gjjCompareContainer) {
		return;
	}

	updateSelectorBar(node);
	const aspectChanged = updateAspectFromState(node);

	setImageSource(node.__gjjCompareBaseImage, selectedA?.url || selectedB?.url || "");
	node.__gjjCompareBaseImage.style.display = selectedA || selectedB ? "block" : "none";
	setImageSource(node.__gjjCompareOverlayImage, selectedB?.url || "");
	node.__gjjCompareOverlayImage.style.display = selectedB ? "block" : "none";
	node.__gjjCompareDivider.style.display = selectedB ? "block" : "none";
	node.__gjjCompareHandle.style.display = selectedB ? "block" : "none";
	node.__gjjCompareEmpty.style.display = selectedA || selectedB ? "none" : "flex";

	node.__gjjCompareOverlayImage.style.clipPath = `inset(0 ${100 - ratio * 100}% 0 0)`;
	node.__gjjCompareDivider.style.left = percent;
	node.__gjjCompareHandle.style.left = percent;
	syncDomDimensions(node);
	if (aspectChanged) {
		scheduleCompareLayout(node);
	}
	if (node.__gjjCompareBaseImage.complete) readLoadedImageDimensions(node, node.__gjjCompareBaseImage);
	if (node.__gjjCompareOverlayImage.complete) readLoadedImageDimensions(node, node.__gjjCompareOverlayImage);
}

function updateCompareState(node, payload) {
	node.__gjjCompareState = coerceImageState(node, payload);
	const state = getCurrentState(node);
	updateAspectFromState(node);
	setPersistedState(node, {
		selectedA: state.selected[0]?.name || "",
		selectedB: state.selected[1]?.name || "",
	});
	renderCompare(node);
	scheduleCompareLayout(node);
}

function ensureCompareWidget(node) {
	if (node.__gjjCompareWidget) {
		return node.__gjjCompareWidget;
	}

	const container = buildCompareDom(node);
	const widget = node.addDOMWidget(DOM_WIDGET_NAME, "HTML", container, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => getWidgetHeight(node, node.__gjjCompareWidget || widget, node.size?.[0]),
	});
	widget.getHeight = () => getWidgetHeight(node, widget, node.size?.[0]);
	widget.computeSize = (width) => [
		Math.max(MIN_WIDTH, finiteNumber(width, getSavedNodeWidth(node))),
		getWidgetHeight(node, widget, width),
	];
	widget.serialize = false;
	widget.options = widget.options || {};
	widget.options.serialize = false;
	widget.options.hideOnZoom = false;
	node.__gjjCompareWidget = widget;
	return widget;
}

function patchNode(node) {
	setSliderRatio(node, getSliderRatio(node));
	ensureCompareWidget(node);
	scheduleFrame(() => {
		renderCompare(node);
		scheduleCompareLayout(node);
	});
}

function restoreLayoutFromSerialized(node, serializedNode) {
	node.properties = node.properties || {};
	const props = serializedNode?.properties || node.properties || {};
	const savedLayout = props[LAYOUT_PROPERTY];
	if (savedLayout && typeof savedLayout === "object") {
		node.properties[LAYOUT_PROPERTY] = { ...savedLayout };
	}
	const layout = getPersistedLayout(node);
	const serializedWidth = finiteNumber(serializedNode?.size?.[0], 0);
	const serializedHeight = finiteNumber(serializedNode?.size?.[1], 0);
	if (finiteNumber(layout.width, 0) <= 0 && serializedWidth > 0) {
		setPersistedLayout(node, { width: serializedWidth });
	}
	if (finiteNumber(layout.node_height, 0) <= 0 && serializedHeight > 0) {
		setPersistedLayout(node, { node_height: serializedHeight });
	}
	const width = getSavedNodeWidth(node);
	if (Array.isArray(node.size)) {
		node.size[0] = width;
		if (serializedHeight > 0) {
			node.size[1] = Math.max(MIN_NODE_HEIGHT, serializedHeight);
		}
	}
}

function serializeLayout(node, serializedNode) {
	if (!serializedNode) {
		return;
	}
	const width = Math.max(MIN_WIDTH, finiteNumber(node?.size?.[0], getSavedNodeWidth(node)));
	const height = getTargetNodeHeight(node, width);
	storeCurrentLayout(node, width, height);
	serializedNode.properties = serializedNode.properties || {};
	serializedNode.properties[LAYOUT_PROPERTY] = { ...getPersistedLayout(node) };
	serializedNode.properties[SLIDER_PROPERTY] = getSliderRatio(node);
	serializedNode.properties[STATE_PROPERTY] = { ...getPersistedState(node) };
	serializedNode.size = [width, height];
}

app.registerExtension({
	name: "GJJ.ImageCompare",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			patchNode(this);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			restoreLayoutFromSerialized(this, serializedNode);
			patchNode(this);
			scheduleCompareLayout(this, { restoreWidth: true });
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			serializeLayout(this, serializedNode);
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (!this.__gjjCompareSizing) {
				syncUserWidthFromNode(this);
				scheduleCompareLayout(this);
			}
			return result;
		};

		const originalOnDrawForeground = nodeType.prototype.onDrawForeground;
		nodeType.prototype.onDrawForeground = function (...args) {
			const result = originalOnDrawForeground?.apply(this, args);
			if (syncUserWidthFromNode(this)) {
				scheduleCompareLayout(this);
			}
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, arguments);
			patchNode(this);
			updateCompareState(this, normalizeImagesFromOutput(message || {}));
			return result;
		};

	},

	async nodeCreated(node) {
		if (!isTargetNode(node)) {
			return;
		}
		patchNode(node);
	},
});
