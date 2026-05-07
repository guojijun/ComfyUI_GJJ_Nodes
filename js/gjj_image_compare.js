import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_ImageComparer"]);
const DOM_WIDGET_NAME = "gjj_image_compare_dom";
const STATE_PROPERTY = "gjj_image_compare_state";
const SLIDER_PROPERTY = "gjj_image_compare_slider";
const MIN_WIDTH = 360;
const MIN_HEIGHT = 180;
const NODE_BOTTOM_PADDING = 10;

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

function getSliderRatio(node) {
	const ratio = Number(node?.properties?.[SLIDER_PROPERTY]);
	return Number.isFinite(ratio) ? clamp(ratio, 0, 1) : 0.5;
}

function setSliderRatio(node, ratio) {
	node.properties = node.properties || {};
	node.properties[SLIDER_PROPERTY] = clamp(Number(ratio) || 0.5, 0, 1);
}

function normalizeImagesFromOutput(output) {
	if ("images" in (output || {})) {
		return {
			images: (output.images || []).map((item, index) => ({
				name: index === 0 ? "A" : "B",
				selected: true,
				url: imageDataToUrl(item),
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
		});
	}

	for (const [index, item] of bImages.entries()) {
		images.push({
			name: bImages.length > 1 || multiple ? `B${index + 1}` : "B",
			selected: index === 0,
			url: imageDataToUrl(item),
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

function refreshLayout(node) {
	const width = Math.max(MIN_WIDTH, Number(node.size?.[0] || MIN_WIDTH));
	const height = Math.max(MIN_HEIGHT, Number(node.size?.[1] || MIN_HEIGHT));
	if ((node.size?.[0] || 0) !== width || (node.size?.[1] || 0) !== height) {
		node.setSize?.([width, height]);
	}
	requestRedraw(node);
}

function getWidgetHeight(node, widget) {
	// 让DOM Widget靠顶部，充分利用可用高度
	const nodeHeight = Math.max(MIN_HEIGHT, Number(node?.size?.[1] || MIN_HEIGHT));
	
	// 减去底部padding
	const availableHeight = nodeHeight - NODE_BOTTOM_PADDING;
	
	// 如果有选择按钮栏，减去其高度
	const state = getCurrentState(node);
	const hasSelectorBar = state.images.length > 2;
	const selectorBarHeight = hasSelectorBar ? 32 : 0;
	
	return Math.max(180, availableHeight - selectorBarHeight);
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

	node.__gjjCompareBaseImage.src = selectedA?.url || selectedB?.url || "";
	node.__gjjCompareBaseImage.style.display = selectedA || selectedB ? "block" : "none";
	node.__gjjCompareOverlayImage.src = selectedB?.url || "";
	node.__gjjCompareOverlayImage.style.display = selectedB ? "block" : "none";
	node.__gjjCompareDivider.style.display = selectedB ? "block" : "none";
	node.__gjjCompareHandle.style.display = selectedB ? "block" : "none";
	node.__gjjCompareEmpty.style.display = selectedA || selectedB ? "none" : "flex";

	node.__gjjCompareOverlayImage.style.clipPath = `inset(0 ${100 - ratio * 100}% 0 0)`;
	node.__gjjCompareDivider.style.left = percent;
	node.__gjjCompareHandle.style.left = percent;
}

function updateCompareState(node, payload) {
	node.__gjjCompareState = coerceImageState(node, payload);
	const state = getCurrentState(node);
	setPersistedState(node, {
		selectedA: state.selected[0]?.name || "",
		selectedB: state.selected[1]?.name || "",
	});
	renderCompare(node);
}

function ensureCompareWidget(node) {
	if (node.__gjjCompareWidget) {
		return node.__gjjCompareWidget;
	}

	const container = buildCompareDom(node);
	const widget = node.addDOMWidget(DOM_WIDGET_NAME, "HTML", container, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => getWidgetHeight(node, node.__gjjCompareWidget || widget),
	});
	widget.getHeight = () => getWidgetHeight(node, widget);
	widget.computeSize = (width) => [
		Math.max(MIN_WIDTH, Number(width || MIN_WIDTH)),
		MIN_HEIGHT,
	];
	node.__gjjCompareWidget = widget;
	return widget;
}

function patchNode(node) {
	setSliderRatio(node, getSliderRatio(node));
	ensureCompareWidget(node);
	requestAnimationFrame(() => {
		renderCompare(node);
		refreshLayout(node);
	});
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
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			patchNode(this);
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
		if (!TARGET_NODES.has(node?.comfyClass)) {
			return;
		}
		patchNode(node);
	},
});
