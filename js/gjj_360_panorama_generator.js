import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const TARGET_NODES = new Set(["GJJ_360PanoramaGenerator"]);
const SETTINGS_OPEN_PROPERTY = "gjj_360_panorama_settings_open_v1";
const OUTPUT_MODE_PROPERTY = "gjj_360_panorama_output_current_view_v1";
const SAVE_DIRECTORY_PROPERTY = "gjj_360_panorama_save_directory_v1";
const EXECUTE_WIDGET = "__gjj_360_panorama_execute";
const PREVIEW_WIDGET = "__gjj_360_panorama_preview";
let ACTIVE_360_NODE_ID = "";
const ALWAYS_VISIBLE_WIDGETS = new Set(["positive_prompt"]);
const HIDDEN_CONTROL_WIDGETS = new Set(["output_current_view", "current_view_data", "save_directory"]);
const SETTINGS_WIDGETS = [
	"positive_prompt",
	"negative_prompt",
	"unet_name",
	"unet_dtype",
	"clip_name",
	"vae_name",
	"lora_1_name",
	"lora_1_strength",
	"lora_2_name",
	"lora_2_strength",
	"seed",
	"steps",
	"cfg",
	"sampler_name",
	"scheduler",
	"denoise",
	"base_width",
	"base_height",
	"final_width",
	"final_height",
	"upscale_enabled",
	"upscale_model_name",
	"prompt_suffix",
	"seam_prompt",
	"seam_mask_width",
	"seam_blur",
	"repair_enabled",
	"output_current_view",
	"current_view_data",
	"save_directory",
];
const MODEL_FILE_RE = /\.(safetensors|ckpt|pt2?|pth|bin|gguf|sft)$/i;
const CLIP_MODEL_RE = /(^|[\\/_\-.])(clip|text[_\s-]*encoder|t5|bert|qwen[_\s-]*2\.?5|vl)([\\/_\-.]|$)/i;
const VAE_MODEL_RE = /(^|[\\/_\-.])vae([\\/_\-.]|$)/i;
const LORA_MODEL_RE = /(^|[\\/_\-.])(lora|lightning|mickmumpitz|360)([\\/_\-.]|$)/i;
const SHIFTED_WIDGETS = [
	"clip_name",
	"vae_name",
	"lora_1_name",
	"lora_1_strength",
	"lora_2_name",
	"lora_2_strength",
	"seed",
	"steps",
	"cfg",
	"sampler_name",
	"scheduler",
	"denoise",
	"base_width",
	"base_height",
	"final_width",
	"final_height",
	"upscale_enabled",
	"upscale_model_name",
	"prompt_suffix",
	"seam_prompt",
	"seam_mask_width",
	"seam_blur",
	"repair_enabled",
	"output_current_view",
	"current_view_data",
	"save_directory",
];

function isTarget(node) {
	return TARGET_NODES.has(node?.comfyClass || node?.type);
}

function getWidget(node, name) {
	return GJJ_Utils.getWidget?.(node, name) || node?.widgets?.find((widget) => widget?.name === name);
}

function ensureHiddenControlWidget(node, name) {
	let widget = getWidget(node, name);
	if (widget || typeof node?.addWidget !== "function") return widget;
	const isToggle = name === "output_current_view";
	widget = node.addWidget(isToggle ? "toggle" : "text", name, isToggle ? false : "", () => {}, { serialize: true });
	widget.name = name;
	widget.serialize = true;
	setWidgetHidden(widget, true);
	return widget;
}

function setWidgetValue(node, name, value) {
	const widget = getWidget(node, name) || ensureHiddenControlWidget(node, name);
	if (!widget) return;
	widget.value = value;
	const index = node.widgets?.indexOf(widget) ?? -1;
	if (Array.isArray(node.widgets_values) && index >= 0) node.widgets_values[index] = value;
	try { widget.callback?.(value); } catch (_) {}
	app.graph?.setDirtyCanvas?.(true, true);
}

function getWidgetValue(node, name, fallback = "") {
	const widget = getWidget(node, name);
	return widget?.value ?? fallback;
}

function looksLikeModel(value, pattern = MODEL_FILE_RE) {
	const text = String(value ?? "").trim();
	return MODEL_FILE_RE.test(text) && pattern.test(text);
}

function setWidgetValueQuiet(node, name, value) {
	const widget = getWidget(node, name);
	if (!widget) return false;
	widget.value = value;
	const index = node.widgets?.indexOf(widget) ?? -1;
	if (Array.isArray(node.widgets_values) && index >= 0) node.widgets_values[index] = value;
	return true;
}

function repairShiftedWidgetValues(node) {
	if (!isTarget(node) || node.__gjj360ShiftedWidgetsRepaired) return;
	const clip = String(getWidgetValue(node, "clip_name", "") ?? "").trim();
	const vae = String(getWidgetValue(node, "vae_name", "") ?? "").trim();
	const lora1 = String(getWidgetValue(node, "lora_1_name", "") ?? "").trim();
	const lora1Strength = String(getWidgetValue(node, "lora_1_strength", "") ?? "").trim();
	const obviousOneSlotShift = /^default$/i.test(clip)
		&& looksLikeModel(vae, CLIP_MODEL_RE)
		&& looksLikeModel(lora1, VAE_MODEL_RE)
		&& looksLikeModel(lora1Strength, LORA_MODEL_RE);
	if (!obviousOneSlotShift) return;

	const previous = new Map(SHIFTED_WIDGETS.map((name) => [name, getWidgetValue(node, name, undefined)]));
	for (let index = 0; index < SHIFTED_WIDGETS.length - 1; index += 1) {
		setWidgetValueQuiet(node, SHIFTED_WIDGETS[index], previous.get(SHIFTED_WIDGETS[index + 1]));
	}
	if (typeof getWidgetValue(node, "repair_enabled") !== "boolean") setWidgetValueQuiet(node, "repair_enabled", true);
	node.__gjj360ShiftedWidgetsRepaired = true;
	app.graph?.setDirtyCanvas?.(true, true);
}

function settingsOpen(node) {
	return Boolean(node?.properties?.[SETTINGS_OPEN_PROPERTY]);
}

function rememberWidget(widget) {
	if (!widget || widget.__gjj360NativeState) return;
	widget.__gjj360NativeState = {
		type: widget.type,
		hidden: widget.hidden,
		disabled: widget.disabled,
		computeSize: widget.computeSize,
		getHeight: widget.getHeight,
		draw: widget.draw,
		mouse: widget.mouse,
		widgetDisplay: widget.widget?.style?.display || "",
		elementDisplay: widget.element?.style?.display || "",
		inputDisplay: widget.inputEl?.style?.display || "",
	};
}

function setWidgetHidden(widget, hidden) {
	if (!widget) return;
	rememberWidget(widget);
	const state = widget.__gjj360NativeState || {};
	widget.options ||= {};
	if (!hidden) {
		widget.hidden = false;
		widget.disabled = false;
		widget.serialize = true;
		widget.type = state.type || widget.type || "text";
		if (state.computeSize) widget.computeSize = state.computeSize;
		else delete widget.computeSize;
		if (state.getHeight) widget.getHeight = state.getHeight;
		else delete widget.getHeight;
		if (state.draw) widget.draw = state.draw;
		else delete widget.draw;
		if (state.mouse) widget.mouse = state.mouse;
		else delete widget.mouse;
		delete widget.options.hidden;
		delete widget.options.display;
		if (widget.widget) widget.widget.style.display = state.widgetDisplay || "";
		if (widget.element) widget.element.style.display = state.elementDisplay || "";
		if (widget.inputEl) widget.inputEl.style.display = state.inputDisplay || "";
		return;
	}
	widget.hidden = true;
	widget.disabled = true;
	widget.serialize = true;
	widget.type = "hidden";
	widget.options.hidden = true;
	widget.options.display = "hidden";
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.mouse = () => false;
	if (widget.widget) widget.widget.style.display = "none";
	if (widget.element) widget.element.style.display = "none";
	if (widget.inputEl) widget.inputEl.style.display = "none";
}

function orderWidgets(node) {
	if (!Array.isArray(node?.widgets)) return;
	const rank = (widget) => {
		const name = String(widget?.name || "");
		if (widget === node.__gjj360ExecuteWidget || name === EXECUTE_WIDGET) return 0;
		if (name === "positive_prompt") return 10;
		if (widget === node.__gjj360PreviewWidget || name === PREVIEW_WIDGET) return 100;
		if (widget?.hidden) return 900;
		return 50;
	};
	node.widgets = node.widgets
		.map((widget, index) => ({ widget, index }))
		.sort((left, right) => rank(left.widget) - rank(right.widget) || left.index - right.index)
		.map((item) => item.widget);
}

function applySettingsVisibility(node) {
	const open = settingsOpen(node);
	for (const name of SETTINGS_WIDGETS) {
		const widget = getWidget(node, name);
		if (!widget) continue;
		setWidgetHidden(widget, HIDDEN_CONTROL_WIDGETS.has(name) || (!open && !ALWAYS_VISIBLE_WIDGETS.has(name)));
	}
	updateSettingsButton(node);
	orderWidgets(node);
	GJJ_Utils.refreshNode?.(node);
}

function setSettingsOpen(node, open) {
	node.properties ||= {};
	node.properties[SETTINGS_OPEN_PROPERTY] = Boolean(open);
	applySettingsVisibility(node);
}

function updateSettingsButton(node) {
	const button = node?.__gjj360SettingsButton;
	if (!button) return;
	const open = settingsOpen(node);
	button.textContent = open ? "⚙️收起" : "⚙️设置";
	button.title = open ? "收起参数，只保留正向提示词。" : "显示模型、LoRA、尺寸、采样和中缝修复参数。";
	button.style.background = open ? "linear-gradient(135deg,#4b5563,#64748b)" : "linear-gradient(135deg,#1f2933,#374151)";
	button.style.borderColor = open ? "#94a3b8" : "#55636f";
}

function updateCameraButton(node) {
	const button = node?.__gjj360CameraButton;
	if (!button) return;
	const enabled = Boolean(node?.properties?.[OUTPUT_MODE_PROPERTY]);
	button.textContent = enabled ? "📷 视窗" : "📷 全景";
	button.title = enabled ? "下游 IMAGE 输出当前 3D 视窗。" : "下游 IMAGE 输出完整 360 全景图。";
	button.style.background = enabled ? "linear-gradient(135deg,#7c3aed,#2563eb)" : "linear-gradient(135deg,#26313a,#3f4b55)";
	button.style.borderColor = enabled ? "#93c5fd" : "#647482";
}

function updateSaveButton(node) {
	const button = node?.__gjj360SaveButton;
	if (!button) return;
	const directory = String(node?.properties?.[SAVE_DIRECTORY_PROPERTY] || "").trim();
	button.textContent = directory ? "💾 已设" : "💾 保存";
	button.title = directory ? `保存到：${directory}` : "设置保存位置。可填绝对路径，或相对 ComfyUI/output 的目录。";
	button.style.background = directory ? "linear-gradient(135deg,#7c2d12,#ca8a04)" : "linear-gradient(135deg,#26313a,#3f4b55)";
	button.style.borderColor = directory ? "#facc15" : "#647482";
}

function protect(event) {
	event.preventDefault();
	event.stopPropagation();
}

function createButtonBar(node) {
	const bar = document.createElement("div");
	bar.style.cssText = [
		"display:flex",
		"gap:6px",
		"width:100%",
		"box-sizing:border-box",
		"pointer-events:auto",
	].join(";");
	const shared = [
		"height:32px",
		"border-radius:6px",
		"font:700 12px sans-serif",
		"cursor:pointer",
		"box-sizing:border-box",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"white-space:nowrap",
		"color:#e5edf2",
	].join(";");

	const run = document.createElement("button");
	run.type = "button";
	run.textContent = "🌐 生成360";
	run.title = "只执行当前 360 全景生成器节点。";
	run.style.cssText = `${shared};flex:1;border:1px solid #10b981;background:linear-gradient(135deg,#064e3b,#059669);color:#a7f3d0`;

	const settings = document.createElement("button");
	settings.type = "button";
	settings.style.cssText = `${shared};flex:0 0 74px;border:1px solid #55636f;background:linear-gradient(135deg,#1f2933,#374151)`;
	node.__gjj360SettingsButton = settings;

	const camera = document.createElement("button");
	camera.type = "button";
	camera.style.cssText = `${shared};flex:0 0 78px;border:1px solid #647482;background:linear-gradient(135deg,#26313a,#3f4b55)`;
	node.__gjj360CameraButton = camera;

	const save = document.createElement("button");
	save.type = "button";
	save.style.cssText = `${shared};flex:0 0 76px;border:1px solid #647482;background:linear-gradient(135deg,#26313a,#3f4b55)`;
	node.__gjj360SaveButton = save;

	for (const button of [run, camera, save, settings]) {
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
			button.addEventListener(eventName, protect, true);
		}
	}
	run.addEventListener("click", async (event) => {
		protect(event);
		ACTIVE_360_NODE_ID = String(node?.id || "");
		const outputCurrentView = Boolean(node?.properties?.[OUTPUT_MODE_PROPERTY]);
		for (const name of HIDDEN_CONTROL_WIDGETS) ensureHiddenControlWidget(node, name);
		setWidgetValue(node, "output_current_view", outputCurrentView);
		setWidgetValue(node, "save_directory", String(node?.properties?.[SAVE_DIRECTORY_PROPERTY] || "").trim());
		if (outputCurrentView) {
			setWidgetValue(node, "current_view_data", node.__gjj360Viewer?.screenshotDataUrl?.() || "");
		} else {
			setWidgetValue(node, "current_view_data", "");
		}
		resetPreview(node);
		if (node.__gjj360Status) node.__gjj360Status.textContent = `0% · 本次输出：${outputCurrentView ? "当前视窗" : "完整全景"}，准备提交...`;
		const old = run.textContent;
		run.textContent = "执行中...";
		run.disabled = true;
		try {
			const ok = await queueOnlyCurrentNode(node);
			run.textContent = ok ? "已提交" : "提交失败";
		} catch (error) {
			console.error("[GJJ_360PanoramaGenerator] queue failed", error);
			run.textContent = "执行失败";
		} finally {
			setTimeout(() => {
				run.textContent = old;
				run.disabled = false;
			}, 1400);
		}
	});
	settings.addEventListener("click", (event) => {
		protect(event);
		setSettingsOpen(node, !settingsOpen(node));
	});
	camera.addEventListener("click", (event) => {
		protect(event);
		node.properties ||= {};
		const next = !Boolean(node.properties[OUTPUT_MODE_PROPERTY]);
		node.properties[OUTPUT_MODE_PROPERTY] = next;
		for (const name of HIDDEN_CONTROL_WIDGETS) ensureHiddenControlWidget(node, name);
		setWidgetValue(node, "output_current_view", next);
		setWidgetValue(node, "current_view_data", next ? (node.__gjj360Viewer?.screenshotDataUrl?.() || "") : "");
		updateCameraButton(node);
		if (node.__gjj360Status) {
			node.__gjj360Status.textContent = next
				? "已截取当前完整视角，执行后下游输出视窗图。"
				: "已切回完整全景，执行后下游输出全景图。";
		}
		app.graph?.setDirtyCanvas?.(true, true);
	});
	save.addEventListener("click", (event) => {
		protect(event);
		const current = String(node?.properties?.[SAVE_DIRECTORY_PROPERTY] || "");
		const value = window.prompt("保存位置：可填绝对路径，或相对 ComfyUI/output 的目录。留空表示不自动保存。", current);
		if (value === null) return;
		node.properties ||= {};
		node.properties[SAVE_DIRECTORY_PROPERTY] = String(value || "").trim();
		updateSaveButton(node);
		app.graph?.setDirtyCanvas?.(true, true);
	});

	bar.append(run, camera, save, settings);
	updateSettingsButton(node);
	updateCameraButton(node);
	updateSaveButton(node);
	return bar;
}

function imageUrl(item) {
	if (!item?.filename) return "";
	const path = `/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "temp")}&subfolder=${encodeURIComponent(item.subfolder || "")}&rand=${Date.now()}`;
	return api?.apiURL ? api.apiURL(path) : path;
}

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
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

function createPanoramaRenderer(canvas, status, node) {
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
		renderScale: 0.75,
		captureScale: 2,
		syncTimer: 0,
	};
	function setStatus(text) {
		if (status) status.textContent = text || "";
	}
	function resizeBacking() {
		const rect = canvas.getBoundingClientRect();
		const width = Math.max(180, Math.round(rect.width * state.renderScale));
		const height = Math.max(120, Math.round(rect.height * state.renderScale));
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
			targetCtx.fillText("等待 360 全景预览", width / 2, height / 2);
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
				let dx = px;
				let dy = py;
				let dz = -1;
				const invLen = 1 / Math.hypot(dx, dy, dz);
				dx *= invLen;
				dy *= invLen;
				dz *= invLen;
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
	}
	async function setImageUrl(url, label = "") {
		setStatus("正在加载 3D 全景预览...");
		const image = await loadImage(url);
		const maxSource = 4096;
		const scale = Math.min(1, maxSource / Math.max(image.width, image.height));
		sampleCanvas.width = Math.max(1, Math.round(image.width * scale));
		sampleCanvas.height = Math.max(1, Math.round(image.height * scale));
		sampleCtx.drawImage(image, 0, 0, sampleCanvas.width, sampleCanvas.height);
		state.imageData = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
		state.dirty = true;
		render();
		setStatus(`${label || "3D 预览"} ${image.width} x ${image.height}`);
	}
	function reset() {
		state.imageData = null;
		state.yaw = 0;
		state.pitch = 0;
		state.fov = Math.PI / 2.2;
		state.dirty = true;
		render();
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
		scheduleViewSync();
	}
	function screenshotDataUrl() {
		if (!state.imageData) return "";
		const cssWidth = Math.max(1, Math.round(canvas.clientWidth || canvas.width || 512));
		const cssHeight = Math.max(1, Math.round(canvas.clientHeight || canvas.height || 320));
		const scale = clamp(Number(state.captureScale || 2), 1, 4);
		const out = document.createElement("canvas");
		out.width = Math.max(1, Math.round(cssWidth * scale));
		out.height = Math.max(1, Math.round(cssHeight * scale));
		paintProjection(out.getContext("2d"), out.width, out.height);
		state.dirty = true;
		render();
		return out.toDataURL("image/png");
	}
	function viewState() {
		const width = Math.max(64, Math.round((canvas.clientWidth || 512) * 2));
		const height = Math.max(64, Math.round((canvas.clientHeight || 320) * 2));
		return {
			yaw: state.yaw,
			pitch: state.pitch,
			fov: state.fov,
			width,
			height,
		};
	}
	function scheduleViewSync() {
		if (!Boolean(node?.properties?.[OUTPUT_MODE_PROPERTY])) return;
		window.clearTimeout(state.syncTimer);
		state.syncTimer = window.setTimeout(() => {
			for (const name of HIDDEN_CONTROL_WIDGETS) ensureHiddenControlWidget(node, name);
			setWidgetValue(node, "output_current_view", true);
			setWidgetValue(node, "current_view_data", screenshotDataUrl());
		}, 120);
	}
	let dragging = false;
	canvas.addEventListener("pointerdown", (event) => {
		protect(event);
		dragging = true;
		state.lastX = event.clientX;
		state.lastY = event.clientY;
		canvas.setPointerCapture?.(event.pointerId);
	});
	canvas.addEventListener("pointermove", (event) => {
		if (!dragging) return;
		protect(event);
		const dx = event.clientX - state.lastX;
		const dy = event.clientY - state.lastY;
		state.lastX = event.clientX;
		state.lastY = event.clientY;
		nudge(-dx * 0.006, dy * 0.006);
		scheduleViewSync();
	});
	canvas.addEventListener("pointerup", (event) => {
		protect(event);
		dragging = false;
		canvas.releasePointerCapture?.(event.pointerId);
	});
	canvas.addEventListener("pointercancel", () => {
		dragging = false;
	});
	canvas.addEventListener("wheel", (event) => {
		protect(event);
		zoom(event.deltaY);
	}, { passive: false });
	return { render, reset, setImageUrl, screenshotDataUrl, viewState, scheduleViewSync };
}

function createPreview(node) {
	const wrap = document.createElement("div");
	wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;width:100%;box-sizing:border-box;";
	const status = document.createElement("div");
	status.textContent = "0% · 等待生成 360 全景...";
	status.style.cssText = "color:#9fb3b8;font:12px/1.35 sans-serif;white-space:normal;";
	const progressOuter = document.createElement("div");
	progressOuter.style.cssText = [
		"width:100%",
		"height:6px",
		"border-radius:999px",
		"background:#172026",
		"overflow:hidden",
		"border:1px solid #2d3a42",
		"box-sizing:border-box",
	].join(";");
	const progressInner = document.createElement("div");
	progressInner.style.cssText = [
		"width:0%",
		"height:100%",
		"border-radius:999px",
		"background:linear-gradient(90deg,#10b981,#38bdf8)",
		"transition:width .18s ease",
	].join(";");
	progressOuter.append(progressInner);
	const canvas = document.createElement("canvas");
	canvas.style.cssText = [
		"display:block",
		"width:100%",
		"height:260px",
		"background:#071014",
		"border:1px solid #33434a",
		"border-radius:8px",
		"box-sizing:border-box",
		"cursor:grab",
		"touch-action:none",
	].join(";");
	const viewerStatus = document.createElement("div");
	viewerStatus.textContent = "3D 预览待生成";
	viewerStatus.style.cssText = "color:#7f959c;font:11px/1.3 sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
	wrap.append(status, progressOuter, canvas, viewerStatus);
	node.__gjj360Status = status;
	node.__gjj360ProgressInner = progressInner;
	node.__gjj360ViewerStatus = viewerStatus;
	node.__gjj360Viewer = createPanoramaRenderer(canvas, viewerStatus, node);
	node.__gjj360Viewer.render();
	return wrap;
}

function normalizeProgress(value, fallback = 0) {
	const number = Number(value);
	if (!Number.isFinite(number)) return Math.max(0, Math.min(1, Number(fallback) || 0));
	return Math.max(0, Math.min(1, number));
}

function setProgress(node, progress) {
	const value = normalizeProgress(progress, node?.__gjj360Progress || 0);
	node.__gjj360Progress = value;
	if (node?.__gjj360ProgressInner) node.__gjj360ProgressInner.style.width = `${Math.round(value * 100)}%`;
	return value;
}

function nodeIdFromDetail(detail) {
	return String(detail?.node_id ?? detail?.display_node ?? detail?.node ?? detail?.nodeId ?? detail?.id ?? "");
}

function setStatusDetail(node, detail = {}) {
	if (!isTarget(node) || !node.__gjj360Status) return;
	const text = String(detail?.text || "处理中...");
	const progress = setProgress(node, detail?.progress);
	const percent = Math.round(progress * 100);
	node.__gjj360CurrentStageText = text;
	if (Number.isFinite(Number(detail?.sampling_start)) && Number.isFinite(Number(detail?.sampling_end))) {
		node.__gjj360SamplingRange = [
			normalizeProgress(detail.sampling_start),
			normalizeProgress(detail.sampling_end, detail.sampling_start),
		];
		node.__gjj360SamplingTotal = Number(detail?.sampling_total) || 0;
	}
	node.__gjj360Status.textContent = `${percent}% · ${text}`;
	GJJ_Utils.refreshNode?.(node);
}

function resetPreview(node) {
	if (node?.__gjj360Status) node.__gjj360Status.textContent = "0% · 等待生成 360 全景...";
	setProgress(node, 0);
	node.__gjj360CurrentStageText = "";
	node.__gjj360SamplingRange = null;
	node.__gjj360SamplingTotal = 0;
	if (node?.__gjj360ViewerStatus) node.__gjj360ViewerStatus.textContent = "3D 预览待生成";
	node?.__gjj360Viewer?.reset?.();
	GJJ_Utils.refreshNode?.(node);
}

function updatePreview(node, detail) {
	if (!isTarget(node)) return;
	const url = imageUrl(detail?.image);
	if (node.__gjj360Viewer && url) {
		node.__gjj360Viewer.setImageUrl(url, detail?.stage || "3D 预览").catch((error) => {
			console.warn("[GJJ_360PanoramaGenerator] panorama preview failed", error);
			if (node.__gjj360ViewerStatus) node.__gjj360ViewerStatus.textContent = "3D 预览加载失败";
		});
	}
	GJJ_Utils.refreshNode?.(node);
}

function updateStatus(node, detail) {
	setStatusDetail(node, detail || {});
}

function updateSamplingProgress(node, detail = {}) {
	if (!isTarget(node) || !node.__gjj360Status) return;
	const current = Number(detail?.value ?? detail?.current ?? 0);
	const total = Number(detail?.max ?? detail?.total ?? node.__gjj360SamplingTotal ?? 0);
	if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return;
	const safeCurrent = Math.max(0, Math.min(total, current));
	const sampleProgress = safeCurrent / total;
	const range = Array.isArray(node.__gjj360SamplingRange) ? node.__gjj360SamplingRange : [node.__gjj360Progress || 0, 0.95];
	const progress = range[0] + (range[1] - range[0]) * sampleProgress;
	setProgress(node, progress);
	const stageText = String(node.__gjj360CurrentStageText || "采样中...");
	const percent = Math.round(normalizeProgress(progress) * 100);
	node.__gjj360Status.textContent = `${percent}% · ${stageText} · 采样第 ${Math.round(safeCurrent)} / ${Math.round(total)} 步`;
	GJJ_Utils.refreshNode?.(node);
}

function configureInputs(node) {
	const input = node?.inputs?.find((item) => String(item?.name || "") === "image");
	if (input) {
		input.type = "GJJ_BATCH__IMAGE,GJJ_BATCH_IMAGE,IMAGE";
		input.label = "输入图像";
		input.localized_name = "输入图像";
		input.tooltip = "可选。有图时图生 360；不连接时文生 360。";
	}
}

function patchNode(node) {
	if (!isTarget(node)) return;
	configureInputs(node);
	repairShiftedWidgetValues(node);
	if (!node.__gjj360ExecuteWidget && typeof node.addDOMWidget === "function") {
		node.__gjj360ExecuteWidget = node.addDOMWidget(EXECUTE_WIDGET, "HTML", createButtonBar(node), { serialize: false });
	}
	if (!node.__gjj360PreviewWidget && typeof node.addDOMWidget === "function") {
		node.__gjj360PreviewWidget = node.addDOMWidget(PREVIEW_WIDGET, "HTML", createPreview(node), { serialize: false });
	}
	for (const name of HIDDEN_CONTROL_WIDGETS) setWidgetHidden(ensureHiddenControlWidget(node, name), true);
	updateCameraButton(node);
	updateSaveButton(node);
	applySettingsVisibility(node);
	if (node.__gjj360Patched) return;
	node.__gjj360Patched = true;
	const originalOnConfigure = node.onConfigure;
	node.onConfigure = function (...args) {
		const result = originalOnConfigure?.apply(this, args);
		setTimeout(() => patchNode(this), 0);
		return result;
	};
}

api.addEventListener("gjj_360_panorama_preview", (event) => {
	const detail = event?.detail || {};
	const nodeId = String(detail.node || "");
	for (const node of app.graph?._nodes || []) {
		if (isTarget(node) && String(node.id) === nodeId) updatePreview(node, detail);
	}
});

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const nodeId = String(detail.node || "");
	if (nodeId) ACTIVE_360_NODE_ID = nodeId;
	for (const node of app.graph?._nodes || []) {
		if (isTarget(node) && String(node.id) === nodeId) updateStatus(node, detail);
	}
});

api.addEventListener("progress", (event) => {
	const detail = event?.detail || {};
	const nodeId = nodeIdFromDetail(detail) || ACTIVE_360_NODE_ID;
	if (!nodeId) return;
	for (const node of app.graph?._nodes || []) {
		if (isTarget(node) && String(node.id) === nodeId) updateSamplingProgress(node, detail);
	}
});

app.registerExtension({
	name: "GJJ.360PanoramaGenerator",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name) || nodeType.prototype.__gjj360PrototypePatched) return;
		nodeType.prototype.__gjj360PrototypePatched = true;
		nodeData.output_preview = false;
		if (Array.isArray(nodeData.outputs)) {
			for (const output of nodeData.outputs) output.preview = false;
		}
		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			setTimeout(() => patchNode(this), 0);
			return result;
		};
	},
	nodeCreated(node) {
		patchNode(node);
	},
	setup() {
		for (const node of app.graph?._nodes || []) patchNode(node);
	},
});
