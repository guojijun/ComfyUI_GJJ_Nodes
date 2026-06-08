// GJJ Checkpoint Direct Generator - 前端增强
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const TARGET_NODE = "GJJ_CheckpointDirectGenerator";
const STATUS_WIDGET = "gjj_checkpoint_status";
const EXECUTE_BUTTON_NAME = "gjj_execute_button";
const IMAGE_PREVIEW_NAME = "gjj_image_preview";
const SETTINGS_OPEN_PROPERTY = "gjj_checkpoint_settings_open";
const ALWAYS_VISIBLE_WIDGETS = new Set(["prompt", "positive"]);
const INTERNAL_WIDGETS = new Set([STATUS_WIDGET, EXECUTE_BUTTON_NAME, IMAGE_PREVIEW_NAME]);
const PANEL_SYNC_WIDGETS = [
	"prompt",
	"positive",
	"ckpt_name",
	"negative_prompt",
	"negative",
	"width",
	"height",
	"batch_size",
	"seed",
	"steps",
	"cfg",
	"sampler_name",
	"scheduler",
	"denoise",
];
const RESTORE_WIDGET_TYPES = {
	prompt: "text",
	positive: "text",
	ckpt_name: "combo",
	negative_prompt: "text",
	negative: "text",
	width: "number",
	height: "number",
	batch_size: "number",
	seed: "number",
	steps: "number",
	cfg: "number",
	sampler_name: "combo",
	scheduler: "combo",
	denoise: "number",
};

function getWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name) || null;
}

function settingsOpen(node) {
	return Boolean(node?.properties?.[SETTINGS_OPEN_PROPERTY]);
}

function rememberWidgetState(widget) {
	if (!widget || widget.__gjjCheckpointVisibilityState) {
		return;
	}
	widget.options = widget.options || {};
	widget.__gjjCheckpointVisibilityState = {
		type: widget.type,
		hidden: widget.hidden,
		disabled: widget.disabled,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		draw: widget.draw,
		mouse: widget.mouse,
		label: widget.label,
		localized_name: widget.localized_name,
		optionsHidden: widget.options.hidden,
		optionsDisplay: widget.options.display,
		widgetDisplay: widget.widget?.style?.display || "",
		elementDisplay: widget.element?.style?.display || "",
		inputDisplay: widget.inputEl?.style?.display || "",
	};
}

function setWidgetHidden(widget, hidden) {
	if (!widget) {
		return;
	}
	rememberWidgetState(widget);
	widget.options = widget.options || {};
	const state = widget.__gjjCheckpointVisibilityState || {};
	if (hidden) {
		widget.hidden = true;
		widget.disabled = true;
		widget.type = "hidden";
		widget.options.hidden = true;
		widget.options.display = "hidden";
		widget.computeSize = () => [0, -4];
		widget.getHeight = () => 0;
		widget.draw = () => {};
		widget.mouse = () => false;
		widget.label = "";
		widget.localized_name = "";
		widget.last_y = 0;
		widget.computedHeight = 0;
		widget.margin_top = 0;
		if (widget.widget) widget.widget.style.display = "none";
		if (widget.element) widget.element.style.display = "none";
		if (widget.inputEl) widget.inputEl.style.display = "none";
		return;
	}
	widget.hidden = Boolean(state.hidden);
	widget.disabled = Boolean(state.disabled);
	widget.type = state.type && state.type !== "hidden" ? state.type : (RESTORE_WIDGET_TYPES[widget.name] || state.type || "text");
	if (state.computeSize) widget.computeSize = state.computeSize;
	else delete widget.computeSize;
	if (state.getHeight) widget.getHeight = state.getHeight;
	else delete widget.getHeight;
	if (state.draw) widget.draw = state.draw;
	else delete widget.draw;
	if (state.mouse) widget.mouse = state.mouse;
	else delete widget.mouse;
	widget.label = state.label ?? widget.label;
	widget.localized_name = state.localized_name ?? widget.localized_name;
	if (state.optionsHidden === undefined) delete widget.options.hidden;
	else widget.options.hidden = state.optionsHidden;
	if (state.optionsDisplay === undefined) delete widget.options.display;
	else widget.options.display = state.optionsDisplay;
	if (widget.widget) widget.widget.style.display = state.widgetDisplay || "";
	if (widget.element) widget.element.style.display = state.elementDisplay || "";
	if (widget.inputEl) widget.inputEl.style.display = state.inputDisplay || "";
}

function updateSettingsButtonState(node) {
	const button = node?.__gjjCheckpointSettingsButton;
	if (!button) {
		return;
	}
	const open = settingsOpen(node);
	button.textContent = open ? "⚙️收起" : "⚙️设置";
	button.title = open ? "收起更多设置，只保留正向提示词。" : "展开更多设置，显示底模、反向提示词、尺寸、采样和图生图参数。";
	button.classList.toggle("on", open);
	button.style.background = open ? "linear-gradient(135deg, #4b5563, #64748b)" : "linear-gradient(135deg, #1f2933, #374151)";
	button.style.borderColor = open ? "#94a3b8" : "#55636f";
	button.style.color = open ? "#ffffff" : "#e5edf2";
}

function applySettingsVisibility(node) {
	if (!node || !Array.isArray(node.widgets)) {
		return;
	}
	node.properties = node.properties || {};
	const open = settingsOpen(node);
	for (const name of PANEL_SYNC_WIDGETS) {
		if (INTERNAL_WIDGETS.has(name)) {
			continue;
		}
		const widget = getWidget(node, name);
		setWidgetHidden(widget, !open && !ALWAYS_VISIBLE_WIDGETS.has(name));
	}
	updateSettingsButtonState(node);
	GJJ_Utils.refreshNode(node, { minWidth: 300, minHeight: 90 });
}

function scheduleCheckpointRefresh(node) {
	GJJ_Utils.scheduleRefreshNode?.(node, { minWidth: 300, minHeight: 90, delay: 0 });
}

function setSettingsOpen(node, open) {
	if (!node) {
		return;
	}
	node.properties = node.properties || {};
	node.properties[SETTINGS_OPEN_PROPERTY] = Boolean(open);
	applySettingsVisibility(node);
}

function scheduleSettingsVisibility(node) {
	for (const delay of [0, 30, 120, 300]) {
		setTimeout(() => applySettingsVisibility(node), delay);
	}
}

function widgetValue(node, name) {
	const widget = getWidget(node, name);
	const clean = (value) => {
		if (value == null) {
			return "";
		}
		if (typeof value === "object") {
			return String(value.value ?? value.name ?? value.content ?? value.label ?? "").trim();
		}
		return String(value).trim();
	};
	const values = Array.isArray(widget?.options?.values) ? widget.options.values : [];
	let value = clean(widget?.value);
	if (/^\d+$/.test(value) && values[Number(value)] != null) {
		value = clean(values[Number(value)]);
	}
	if (value) {
		return value;
	}
	return clean(values[0]);
}

function inputLinked(node, name) {
	const input = node?.inputs?.find((item) => String(item?.name || "") === name);
	return Boolean(input?.link != null);
}

function installModelHelpProvider(node) {
	if (!node || node.__gjjCheckpointModelHelpProviderInstalled) {
		return;
	}
	node.__gjjCheckpointModelHelpProviderInstalled = true;
	node.__gjjHelpModelTreeEntries = function () {
		const entries = [];
		const checkpoint = widgetValue(this, "ckpt_name");
		if (checkpoint) {
			entries.push({
				label: "🎨 底模模型",
				value: checkpoint,
				folder: "checkpoints",
				kind: "checkpoint_model",
				name: "ckpt_name",
				tooltip: "调用方法：节点内部走 ComfyUI CheckpointLoaderSimple 加载底模，并拆出 MODEL / CLIP / VAE。",
			});
		}
		if (inputLinked(this, "lora_chain_config")) {
			entries.push({
				label: "🔗 LoRA串联配置",
				value: "已连接外部输入",
				folder: "loras",
				kind: "loras",
				name: "lora_chain_config",
				tooltip: "调用方法：执行时读取 GJJ · LoRA串联配置，按顺序把 LoRA 应用到底模 MODEL 与 CLIP。",
			});
		}
		return entries;
	};
}

function ensureStatusWidget(node) {
	if (node.__gjjCheckpointStatus) {
		return node.__gjjCheckpointStatus;
	}
	// 使用 DOM widget 而不是 canvas 绘制
	const container = document.createElement("div");
	container.style.cssText = [
		"width:100%",
		"box-sizing:border-box",
		"position:relative",
		"z-index:999",
	].join(";");

	const statusBox = document.createElement("div");
	statusBox.style.cssText = [
		"padding:8px 12px",
		"border:1px solid #31464f",
		"border-radius:10px",
		"background:#0f1a1f",
		"color:#dce7e2",
		"font-size:12px",
		"line-height:1.4",
		"white-space:nowrap",
		"overflow:hidden",
		"text-overflow:ellipsis",
	].join(";");

	const label = document.createElement("div");
	label.textContent = "等待执行";
	label.style.cssText = "margin-bottom:0px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";

	const track = document.createElement("div");
	track.style.cssText = [
		"height:7px",
		"overflow:hidden",
		"border-radius:999px",
		"background:#1a262c",
	].join(";");

	const bar = document.createElement("div");
	bar.style.cssText = [
		"width:8%",
		"height:100%",
		"border-radius:999px",
		"background:linear-gradient(90deg, #36cfc9, #6ea8ff)",
		"transition:width 0.16s ease",
	].join(";");

	track.appendChild(bar);
	statusBox.append(label, track);
	container.appendChild(statusBox);

	// 创建 DOM widget
	const widget = node.addDOMWidget(STATUS_WIDGET, "HTML", container, {
		serialize: false,
	});

	node.__gjjCheckpointStatus = { widget, label, bar };
	return node.__gjjCheckpointStatus;
}

function parseProgress(text) {
	const value = String(text || "");
	const match = value.match(/(\d+)\s*\/\s*(\d+)/);
	if (match) {
		const current = Math.max(0, Number(match[1] || 0));
		const total = Math.max(1, Number(match[2] || 1));
		return Math.max(0, Math.min(100, (current / total) * 100));
	}
	if (value.includes("完成") || value.includes("失败")) {
		return 100;
	}
	return 8;
}

function setStatus(node, text) {
	const state = ensureStatusWidget(node);
	const statusText = String(text || "等待执行");

	// 更新 DOM 元素
	state.label.textContent = statusText;
	const progress = parseProgress(statusText);
	state.bar.style.width = `${Math.max(4, progress)}%`;

	// 刷新节点尺寸
	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function createExecuteButton(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:row",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1000",
		"pointer-events:auto",
	].join(";");

	const sharedButtonStyle = [
		"height:32px",
		"padding:0 12px",
		"border-radius:6px",
		"font-size:12px",
		"font-weight:600",
		"cursor:pointer",
		"transition:all 0.15s ease",
		"box-sizing:border-box",
		"position:relative",
		"z-index:1001",
		"pointer-events:auto",
		"user-select:none",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"gap:5px",
		"white-space:nowrap",
		"min-width:0",
	];

	const executeButton = document.createElement("button");
	executeButton.type = "button";
	executeButton.innerHTML = "🚀 生成图片";
	executeButton.title = "只执行当前节点，无需连接其他节点";
	executeButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #10b981",
		"background:linear-gradient(135deg, #064e3b, #059669)",
		"color:#a7f3d0",
		"flex:1",
	].join(";");

	const settingsButton = document.createElement("button");
	settingsButton.type = "button";
	settingsButton.textContent = "⚙️设置";
	settingsButton.title = "展开更多设置";
	settingsButton.style.cssText = [
		...sharedButtonStyle,
		"border:1px solid #55636f",
		"background:linear-gradient(135deg, #1f2933, #374151)",
		"color:#e5edf2",
		"flex:0 0 74px",
	].join(";");
	node.__gjjCheckpointSettingsButton = settingsButton;

	function setupButtonHover(btn, defaultBg, hoverBg) {
		btn.addEventListener("mouseenter", () => {
			if (btn === settingsButton && settingsOpen(node)) {
				return;
			}
			btn.style.background = hoverBg;
			btn.style.transform = "translateY(-1px)";
		});
		btn.addEventListener("mouseleave", () => {
			if (btn === settingsButton && settingsOpen(node)) {
				btn.style.transform = "translateY(0)";
				updateSettingsButtonState(node);
				return;
			}
			btn.style.background = defaultBg;
			btn.style.transform = "translateY(0)";
		});
		btn.addEventListener("mousedown", () => {
			btn.style.transform = "translateY(0) scale(0.98)";
		});
		btn.addEventListener("mouseup", () => {
			btn.style.transform = "translateY(-1px)";
		});
	}

	function protectEvent(event) {
		event.preventDefault();
		event.stopPropagation();
	}

	function setupButtonEvents(btn, handler) {
		let lastHandledAt = 0;
		const wrappedHandler = (event) => {
			const now = Date.now();
			if (now - lastHandledAt < 250) {
				protectEvent(event);
				return;
			}
			lastHandledAt = now;
			handler(event);
		};
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
			btn.addEventListener(eventName, protectEvent, true);
			container.addEventListener(eventName, protectEvent, true);
		}
		btn.addEventListener("pointerup", wrappedHandler, true);
		btn.addEventListener("click", wrappedHandler, true);
	}

	async function handleExecute(event) {
		protectEvent(event);

		const originalText = executeButton.innerHTML;
		executeButton.innerHTML = "⏳ 执行中";
		executeButton.disabled = true;
		executeButton.style.opacity = "0.7";

		try {
			await queueOnlyCurrentNode(node);
			executeButton.innerHTML = "✅ 已提交";
			executeButton.style.background = "linear-gradient(135deg, #064e3b, #059669)";
			executeButton.style.borderColor = "#10b981";
		} catch (error) {
			console.error("[GJJ] 执行节点时发生错误:", error);
			executeButton.innerHTML = "❌ 执行失败";
			executeButton.style.background = "linear-gradient(135deg, #7f1d1d, #dc2626)";
			executeButton.style.borderColor = "#ef4444";
		} finally {
			setTimeout(() => {
				executeButton.innerHTML = originalText;
				executeButton.disabled = false;
				executeButton.style.opacity = "1";
				executeButton.style.background = "linear-gradient(135deg, #064e3b, #059669)";
				executeButton.style.borderColor = "#10b981";
			}, 1500);
		}
	}

	function handleSettings(event) {
		protectEvent(event);
		setSettingsOpen(node, !settingsOpen(node));
	}

	setupButtonHover(executeButton, "linear-gradient(135deg, #064e3b, #059669)", "linear-gradient(135deg, #059669, #10b981)");
	setupButtonHover(settingsButton, "linear-gradient(135deg, #1f2933, #374151)", "linear-gradient(135deg, #374151, #4b5563)");
	setupButtonEvents(executeButton, handleExecute);
	setupButtonEvents(settingsButton, handleSettings);
	updateSettingsButtonState(node);

	container.appendChild(executeButton);
	container.appendChild(settingsButton);
	return container;
}

function createImagePreview(node) {
	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
	].join(";");

	const image = document.createElement("img");
	image.dataset.gjjCustomPreview = "true";
	image.style.cssText = [
		"max-width:100%",
		"max-height:400px",
		"object-fit:contain",
		"display:none",
		"cursor:pointer",
		"border-radius:8px",
		"border:1px solid #33434a",
		"background:#0f1418",
		"pointer-events:auto",
		"position:relative",
		"z-index:100",
		"transition:transform 0.2s ease",
	].join(";");

	image.addEventListener("mouseenter", () => {
		image.style.transform = "scale(1.02)";
	});
	image.addEventListener("mouseleave", () => {
		image.style.transform = "scale(1)";
	});

	image.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();

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
		previewImg.src = image.src;
		previewImg.style.cssText = [
			"max-width:90%",
			"max-height:90%",
			"object-fit:contain",
			"border-radius:8px",
			"box-shadow:0 0 40px rgba(0, 0, 0, 0.5)",
			"transition:transform 0.1s ease",
			"cursor:grab",
		].join(";");

		let currentScale = 1;
		const minScale = 0.1;
		const maxScale = 10;

		overlay.addEventListener("wheel", (e) => {
			e.preventDefault();
			e.stopPropagation();

			const delta = e.deltaY > 0 ? -0.1 : 0.1;
			currentScale = Math.max(minScale, Math.min(maxScale, currentScale + delta));
			previewImg.style.transform = `scale(${currentScale})`;
		});

		previewImg.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			currentScale = 1;
			previewImg.style.transform = `scale(${currentScale})`;
		});

		const closeHint = document.createElement("div");
		closeHint.textContent = "滚轮缩放 · 双击重置 · 点击关闭";
		closeHint.style.cssText = [
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

		overlay.appendChild(previewImg);
		overlay.appendChild(closeHint);
		document.body.appendChild(overlay);

		overlay.addEventListener("click", () => {
			overlay.remove();
		});
	});

	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "wheel"]) {
		container.addEventListener(eventName, (event) => {
			event.stopPropagation();
		});
	}

	container.appendChild(image);

	node.__gjjPreviewImage = image;
	return container;
}

function imageDataToUrl(imageData) {
	if (!imageData) return null;

	if (typeof imageData === "object" && !Array.isArray(imageData)) {
		imageData = [imageData];
	}

	if (Array.isArray(imageData) && imageData.length > 0) {
		const img = imageData[0];
		if (typeof img === "object") {
			let filename = img.filename || img.name || img.file || img.path || "";
			let subfolder = img.subfolder || img.sub || "";
			let type = img.type || img.t || "output";

			if (filename) {
				const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
				const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : "";
				let url = `/view?filename=${encodeURIComponent(filename)}`;
				if (subfolder) {
					url += `&subfolder=${encodeURIComponent(subfolder)}`;
				}
				if (type) {
					url += `&type=${encodeURIComponent(type)}`;
				}
				url += `${previewFormat}${randParam}`;
				return api.apiURL(url);
			}
		}
	}

	if (typeof imageData === "string") {
		if (imageData.startsWith("http://") || imageData.startsWith("https://")) {
			return imageData;
		}
		return api.apiURL(`/view?filename=${encodeURIComponent(imageData)}`);
	}

	return null;
}

function updateImagePreview(node, images) {
	if (!node.__gjjPreviewImage) {
		return;
	}

	if (!images || !images.length) {
		node.__gjjPreviewImage.style.display = "none";
		return;
	}

	const imageUrl = imageDataToUrl(images);
	if (!imageUrl) {
		node.__gjjPreviewImage.style.display = "none";
		return;
	}

	node.__gjjPreviewImage.src = imageUrl;
	node.__gjjPreviewImage.style.display = "block";
	node.__gjjPreviewImage.style.visibility = "visible";
	node.__gjjPreviewImage.style.height = "";
	node.__gjjPreviewImage.style.width = "";
	node.__gjjPreviewImage.style.margin = "";
	node.__gjjPreviewImage.style.padding = "";
	node.__gjjPreviewImage.style.opacity = "";
	node.__gjjPreviewImage.style.position = "";
	node.__gjjPreviewImage.style.left = "";

	node.__gjjPreviewImage.onload = () => {
	};
	node.__gjjPreviewImage.onerror = () => {
	};

	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function hideDefaultPreviewElements(node) {
	let nodeElement = null;
	try {
		if (node.imgs) {
			nodeElement = node.imgs;
		} else if (node.element) {
			nodeElement = node.element;
		} else if (node.dummyEl) {
			nodeElement = node.dummyEl;
		} else {
			const allCanvasNodes = document.querySelectorAll('.litegraph');
			for (const canvasNode of allCanvasNodes) {
				const potentialNodes = canvasNode.querySelectorAll ?
					canvasNode.querySelectorAll('[data-node-id]') : [];
				for (const el of potentialNodes) {
					if (el.getAttribute('data-node-id') === String(node.id)) {
						nodeElement = el;
						break;
					}
				}
			}
		}
	} catch (e) {
	}

	if (nodeElement) {
		const allElements = nodeElement.querySelectorAll ?
			nodeElement.querySelectorAll("*") : [];

		const allImgs = nodeElement.querySelectorAll ?
			nodeElement.querySelectorAll("img") : [];

		for (const img of allImgs) {
			if (!img.dataset?.gjjCustomPreview) {
				img.style.display = "none";
				img.style.visibility = "hidden";
			}
		}

		for (const el of allElements) {
			const classStr = String(el.className || "").toLowerCase();
			const idStr = String(el.id || "").toLowerCase();
			const tagName = String(el.tagName || "").toLowerCase();

			if (
				classStr.includes("preview") ||
				idStr.includes("preview") ||
				(tagName === "div" && el.querySelector && el.querySelector("img"))) {
				let isOurCustomPreview = false;
				const customImgs = el.querySelectorAll ?
					el.querySelectorAll("img[data-gjj-custom-preview='true']") : [];
				if (customImgs.length > 0) {
					isOurCustomPreview = true;
				}

				if (!isOurCustomPreview) {
					el.style.visibility = "hidden";
					el.style.height = "0px";
					el.style.overflow = "hidden";
					el.style.margin = "0px";
					el.style.padding = "0px";
				}
			}

			const text = String(el.textContent || "").trim();

			if (
				text.includes("执行完成") ||
				text.includes("完成：") ||
				text.includes("耗时") ||
				text.includes("已完成") ||
				classStr.includes("status") ||
				classStr.includes("progress")
			) {
				const hasCustomStatus = el.querySelector?.(`[name="${STATUS_WIDGET}"]`);
				const isOurStatus =
					el === node.__gjjCheckpointStatus?.widget?.element ||
					el.contains?.(node.__gjjCheckpointStatus?.label);

				if (!isOurStatus && !hasCustomStatus) {
					el.style.visibility = "hidden";
					el.style.height = "0px";
					el.style.overflow = "hidden";
					el.style.margin = "0px";
					el.style.padding = "0px";
				}
			}
		}
	}
}

function setupPreviewObserver(node) {
	if (node.__gjjPreviewObserver) {
		try {
			node.__gjjPreviewObserver.disconnect();
		} catch (e) {
		}
	}

	let targetElement = null;
	try {
		if (node.imgs) {
			targetElement = node.imgs;
		} else if (node.element) {
			targetElement = node.element;
		} else if (node.dummyEl) {
			targetElement = node.dummyEl;
		}
	} catch (e) {
	}

	if (targetElement && targetElement.ownerDocument) {
		node.__gjjPreviewObserver = new MutationObserver((mutations) => {
			let needsHide = false;

			for (const mutation of mutations) {
				if (mutation.addedNodes && mutation.addedNodes.length > 0) {
					needsHide = true;
					break;
				}
				if (mutation.type === 'attributes' &&
					(mutation.attributeName === 'style' ||
					 mutation.attributeName === 'class' ||
					 mutation.attributeName === 'src')) {
					needsHide = true;
					break;
				}
			}

			if (needsHide) {
				setTimeout(() => hideDefaultPreviewElements(node), 0);
				setTimeout(() => hideDefaultPreviewElements(node), 20);
				setTimeout(() => hideDefaultPreviewElements(node), 50);
			}
		});

		try {
			node.__gjjPreviewObserver.observe(targetElement, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['style', 'class', 'src'],
			});
		} catch (e) {
			// Error setting up MutationObserver
		}
	}
}

function stabilizeNode(node) {
	if (!node) return;

	installModelHelpProvider(node);

	if (node.__gjjStabilized) {
		return;
	}
	node.__gjjStabilized = true;

	ensureStatusWidget(node);

	if (!node.__gjjExecuteButtonWidget) {
		const buttonsContainer = createExecuteButton(node);
		node.__gjjExecuteButtonWidget = node.addDOMWidget(EXECUTE_BUTTON_NAME, "HTML", buttonsContainer, { serialize: false });
	}

	if (!node.__gjjImagePreviewWidget) {
		const previewContainer = createImagePreview(node);
		node.__gjjImagePreviewWidget = node.addDOMWidget(IMAGE_PREVIEW_NAME, "HTML", previewContainer, { serialize: false });
	}

	applySettingsVisibility(node);
	setStatus(node, "等待执行");

	node.setDirtyCanvas?.(true, true);
	node.graph?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};

	const targetNode = app.graph?._nodes?.find((node) => String(node?.id) === String(detail.node));
	if (!targetNode) {
		return;
	}

	const nodeClass = String(targetNode.comfyClass || targetNode.type || "");

	if (nodeClass !== TARGET_NODE) {
		return;
	}

	setStatus(targetNode, detail.text || "处理中...");
});

app.registerExtension({
	name: "Comfy.GJJ.CheckpointDirectGenerator",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_NODE) {
			return;
		}

		nodeData.output_preview = false;

		if (nodeData.outputs && Array.isArray(nodeData.outputs)) {
			for (const output of nodeData.outputs) {
				output.preview = false;
			}
		}

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);

			this.__gjjPreviewObserver = null;

			setTimeout(() => {
				stabilizeNode(this);
				hideDefaultPreviewElements(this);
				setupPreviewObserver(this);
			}, 0);
			setTimeout(() => scheduleSettingsVisibility(this), 40);

			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			setTimeout(() => {
				scheduleSettingsVisibility(this);
				if (this.__gjjCheckpointStatus) {
					setStatus(this, "等待执行");
				}
				hideDefaultPreviewElements(this);
			}, 0);
			return result;
		};

		const originalResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalResize?.apply(this, args);
			updateSettingsButtonState(this);
			scheduleCheckpointRefresh(this);
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			scheduleSettingsVisibility(this);
			return result;
		};

		const originalExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {

			let images = null;

			if (message?.images) {
				images = message.images;
			} else if (message?.ui?.images) {
				images = message.ui.images;
			} else if (message?.output?.images) {
				images = message.output.images;
			} else if (message?.results?.images) {
				images = message.results.images;
			} else if (Array.isArray(message?.ui)) {
				for (const uiItem of message.ui) {
					if (uiItem?.images) {
						images = uiItem.images;
						break;
					}
				}
			}

			if (images) {
				updateImagePreview(this, images);
			}

			setTimeout(() => hideDefaultPreviewElements(this), 0);
			setTimeout(() => hideDefaultPreviewElements(this), 20);
			setTimeout(() => hideDefaultPreviewElements(this), 50);
		};
	},
});
