import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const TARGET = "GJJ_QwenImageLayeredPSDStudio";
const PANEL = "__gjj_qwen_layered_panel";
const HIDDEN = new Set([
	"method",
	"prompt",
	"negative_prompt",
	"largest_size",
	"layers",
	"unet_name",
	"clip_name",
	"vae_name",
	"seed",
	"steps",
	"cfg",
	"sampler_name",
	"scheduler",
	"denoise",
	"keep_model_loaded",
	"lora_data",
	"uploaded_image",
]);

function widget(node, name) {
	return node?.widgets?.find((item) => item?.name === name || item?.options?.name === name) || null;
}

function getValue(node, name, fallback = "") {
	const value = widget(node, name)?.value;
	return value === undefined || value === null || value === "" ? fallback : value;
}

function setValue(node, name, value) {
	const w = widget(node, name);
	if (!w) return;
	w.value = value;
	if (w.inputEl) w.inputEl.value = value;
	if (w.element && "value" in w.element) w.element.value = value;
	try { w.callback?.(value); } catch (_) {}
	refresh(node);
}

function hideWidget(w) {
	if (!w || w.__gjjLayeredHidden) return;
	w.type = "hidden";
	w.hidden = true;
	w.computeSize = () => [0, -4];
	w.serialize = true;
	w.__gjjLayeredHidden = true;
}

function refresh(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function apiViewUrl(ref, rand = true) {
	if (!ref?.filename) return "";
	const suffix = rand ? `&rand=${Date.now()}` : "";
	return `/api/view?filename=${encodeURIComponent(ref.filename)}&type=${encodeURIComponent(ref.type || "temp")}&subfolder=${encodeURIComponent(ref.subfolder || "")}${suffix}`;
}

function stopCanvas(event) {
	event.stopPropagation();
}

function protect(element) {
	for (const name of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "keydown", "keyup"]) {
		element.addEventListener(name, stopCanvas, true);
	}
	element.addEventListener("wheel", stopCanvas, { passive: true });
}

function button(label, title, onClick) {
	const el = document.createElement("button");
	el.type = "button";
	el.textContent = label;
	el.title = title;
	el.style.cssText = [
		"height:32px",
		"min-width:34px",
		"border:1px solid #4b616b",
		"border-radius:6px",
		"background:#182329",
		"color:#edf7f3",
		"cursor:pointer",
		"font-size:15px",
		"font-weight:700",
		"line-height:1",
		"padding:0 8px",
		"box-sizing:border-box",
		"pointer-events:auto",
	].join(";");
	el.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
	el.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.(event, el);
	}, true);
	return el;
}

function field(label, child) {
	const wrap = document.createElement("label");
	wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;min-width:0;color:#b8c9c8;font-size:11px;";
	const span = document.createElement("span");
	span.textContent = label;
	span.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
	wrap.append(span, child);
	return wrap;
}

function input(node, name, type = "text") {
	const el = document.createElement(type === "textarea" ? "textarea" : "input");
	if (type !== "textarea") el.type = type;
	el.value = getValue(node, name, "");
	el.style.cssText = [
		"width:100%",
		"box-sizing:border-box",
		"border:1px solid #39515a",
		"border-radius:6px",
		"background:#10181d",
		"color:#edf7f3",
		"padding:7px 8px",
		"font-size:12px",
		"resize:vertical",
		"min-height:" + (type === "textarea" ? "96px" : "30px"),
	].join(";");
	el.addEventListener("input", () => setValue(node, name, type === "number" ? Number(el.value) : el.value));
	el.addEventListener("keydown", stopCanvas, true);
	el.addEventListener("pointerdown", stopCanvas, true);
	return el;
}

function select(node, name) {
	const w = widget(node, name);
	const el = document.createElement("select");
	const values = Array.isArray(w?.options?.values) ? w.options.values : [];
	for (const value of values) {
		const option = document.createElement("option");
		option.value = String(value);
		option.textContent = String(value);
		el.appendChild(option);
	}
	el.value = String(getValue(node, name, values[0] || ""));
	el.style.cssText = "width:100%;box-sizing:border-box;border:1px solid #39515a;border-radius:6px;background:#10181d;color:#edf7f3;padding:6px 8px;font-size:12px;";
	el.addEventListener("change", () => setValue(node, name, el.value));
	el.addEventListener("pointerdown", stopCanvas, true);
	return el;
}

function panelStyle(width = 520) {
	return [
		"position:fixed",
		"z-index:100000",
		`width:min(${width}px, calc(100vw - 28px))`,
		"max-height:min(680px, calc(100vh - 32px))",
		"overflow:auto",
		"display:none",
		"flex-direction:column",
		"gap:9px",
		"padding:10px",
		"box-sizing:border-box",
		"border:1px solid #41535b",
		"border-radius:8px",
		"background:#10171b",
		"color:#dce7e2",
		"box-shadow:0 16px 42px rgba(0,0,0,.45)",
		"pointer-events:auto",
	].join(";");
}

function ensureFloating(node, key, title, width, build) {
	if (node[key]) return node[key];
	const panel = document.createElement("div");
	panel.style.cssText = panelStyle(width);
	protect(panel);
	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;position:sticky;top:0;background:#10171b;padding-bottom:4px;z-index:1;";
	const titleEl = document.createElement("div");
	titleEl.textContent = title;
	titleEl.style.cssText = "font-size:13px;font-weight:700;color:#f2faf7;";
	const close = button("×", "关闭", () => closeFloating(node));
	close.style.width = "28px";
	close.style.minWidth = "28px";
	header.append(titleEl, close);
	const body = document.createElement("div");
	body.style.cssText = "display:flex;flex-direction:column;gap:8px;";
	build(body);
	panel.append(header, body);
	document.body.appendChild(panel);
	node[key] = panel;
	return panel;
}

function positionFloating(node, panel, anchor) {
	const rect = anchor?.getBoundingClientRect?.();
	const vw = Math.max(320, window.innerWidth || 320);
	const vh = Math.max(240, window.innerHeight || 240);
	const left = Math.max(12, Math.min(Math.floor(rect?.left || 12), vw - Math.ceil(panel.getBoundingClientRect().width || 520) - 12));
	const top = Math.max(12, Math.min(Math.ceil(rect?.bottom || 12) + 6, vh - 120));
	panel.style.left = `${left}px`;
	panel.style.top = `${top}px`;
}

function closeFloating(node, except = null) {
	for (const key of ["__gjjLayeredModelPanel", "__gjjLayeredSizePanel", "__gjjLayeredSettingsPanel"]) {
		if (key !== except && node?.[key]) node[key].style.display = "none";
	}
}

function toggleFloating(node, key, anchor, title, width, build) {
	const panel = ensureFloating(node, key, title, width, build);
	const open = panel.style.display !== "none";
	closeFloating(node, key);
	if (open) {
		panel.style.display = "none";
		return;
	}
	panel.style.display = "flex";
	positionFloating(node, panel, anchor);
}

function scheduleSize(node) {
	clearTimeout(node.__gjjLayeredSizeTimer);
	node.__gjjLayeredSizeTimer = setTimeout(() => {
		const root = node.__gjjLayeredPanel;
		if (!root) return;
		const width = Math.max(390, Number(node.size?.[0] || 430));
		const height = Math.max(160, Math.ceil(root.scrollHeight || 160) + 14);
		node.setSize?.([width, height]);
		refresh(node);
	}, 30);
}

function updateKeepButton(node) {
	const btn = node.__gjjLayeredKeepButton;
	if (!btn) return;
	const active = Boolean(getValue(node, "keep_model_loaded", false));
	btn.textContent = active ? "📌" : "📍";
	btn.style.background = active ? "#1d6b58" : "#182329";
	btn.style.borderColor = active ? "#46b895" : "#4b616b";
}

function renderChosenImage(node, ref) {
	if (!node.__gjjLayeredImageHint) return;
	node.__gjjLayeredImageHint.innerHTML = "";
	if (!ref?.filename) {
		node.__gjjLayeredImageHint.style.display = "none";
		scheduleSize(node);
		return;
	}
	const img = document.createElement("img");
	img.src = api.apiURL(`/view?filename=${encodeURIComponent(ref.filename)}&type=input&subfolder=&rand=${Date.now()}`);
	img.style.cssText = "width:42px;height:42px;object-fit:cover;border:1px solid #39515a;border-radius:6px;background:#10181d;";
	const text = document.createElement("div");
	text.textContent = ref.filename;
	text.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#aebfc5;font-size:11px;";
	node.__gjjLayeredImageHint.append(img, text);
	node.__gjjLayeredImageHint.style.display = "grid";
	scheduleSize(node);
}

async function chooseImage(node) {
	if (!node.__gjjLayeredFileInput) {
		const file = document.createElement("input");
		file.type = "file";
		file.accept = "image/png,image/jpeg,image/webp,image/bmp";
		file.style.display = "none";
		file.addEventListener("change", async () => {
			const chosen = file.files?.[0];
			if (!chosen) return;
			const form = new FormData();
			form.append("image", chosen);
			form.append("type", "input");
			form.append("subfolder", "");
			form.append("overwrite", "true");
			const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				console.warn("[GJJ] Qwen Layered 图片上传失败:", response.status, data);
				return;
			}
			const filename = data.name || data.image || data.filename || "";
			if (!filename) return;
			setValue(node, "uploaded_image", filename);
			setValue(node, "method", "图生图");
			renderChosenImage(node, { filename });
		});
		document.body.appendChild(file);
		node.__gjjLayeredFileInput = file;
	}
	node.__gjjLayeredFileInput.value = "";
	node.__gjjLayeredFileInput.click();
}

function buildModelPanel(node, body) {
	const sourceRow = document.createElement("div");
	sourceRow.style.cssText = "display:flex;align-items:center;gap:8px;color:#cfe1dc;font-size:12px;font-weight:700;";
	const label = document.createElement("span");
	label.textContent = "🧠 模型来源";
	const badge = document.createElement("span");
	badge.textContent = "UNET 主模型";
	badge.style.cssText = "margin-left:auto;min-width:160px;text-align:center;border:1px solid #10b981;border-radius:6px;background:#047857;color:#ecfdf5;padding:7px 12px;box-sizing:border-box;";
	sourceRow.append(label, badge);
	const tree = GJJ_Utils.createModelTreeView({
		node,
		entries: [
			{
				folder: "diffusion_models",
				widget: "unet_name",
				icon: "🟣",
				label: "UNET 主模型",
				keywords: ["qwen", "layer"],
				fallback: "qwen_image_layered_int8_convrot.safetensors",
				description: "Qwen-Image-Layered 主扩散模型，放在 models/diffusion_models。",
			},
			{
				folder: "text_encoders",
				widget: "clip_name",
				icon: "🟡",
				label: "文本编码器",
				keywords: ["qwen"],
				fallback: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
				description: "Qwen Image 文本编码器，放在 models/text_encoders。",
			},
			{
				folder: "vae",
				widget: "vae_name",
				icon: "🔴",
				label: "VAE",
				keywords: ["qwen", "layer"],
				fallback: "qwen_image_layered_vae.safetensors",
				description: "Qwen-Image-Layered VAE，放在 models/vae。",
			},
		],
		refresh: () => {
			scheduleSize(node);
			refresh(node);
		},
	});
	tree.style.maxHeight = "420px";
	body.append(sourceRow, tree);
}

function buildSizePanel(node, body) {
	const grid = document.createElement("div");
	grid.style.cssText = "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;";
	grid.append(
		field("生图方式", select(node, "method")),
		field("尺寸限制", input(node, "largest_size", "number")),
		field("图层数", input(node, "layers", "number")),
		field("种子", input(node, "seed", "number"))
	);
	body.append(grid);
}

function buildSettingsPanel(node, body) {
	const grid = document.createElement("div");
	grid.style.cssText = "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;";
	grid.append(
		field("步数", input(node, "steps", "number")),
		field("CFG", input(node, "cfg", "number")),
		field("降噪", input(node, "denoise", "number")),
		field("采样器", select(node, "sampler_name")),
		field("调度器", select(node, "scheduler"))
	);
	body.append(field("负面提示词", input(node, "negative_prompt", "textarea")), grid, field("LoRA 数据", input(node, "lora_data", "textarea")));
}

function renderProgress(node, text) {
	const root = node.__gjjLayeredProgress;
	if (!root) return;
	const clean = String(text || "").trim();
	if (!clean) {
		root.style.display = "none";
		scheduleSize(node);
		return;
	}
	root.textContent = clean;
	root.style.display = "block";
	scheduleSize(node);
	if (/完成|失败|执行失败/.test(clean)) {
		clearTimeout(node.__gjjLayeredProgressHideTimer);
		node.__gjjLayeredProgressHideTimer = setTimeout(() => {
			root.style.display = "none";
			scheduleSize(node);
		}, 1800);
	}
}

function renderPreview(node, refs = []) {
	const host = node.__gjjLayeredPreviewHost;
	if (!host) return;
	host.innerHTML = "";
	if (!Array.isArray(refs) || refs.length === 0) {
		host.style.display = "none";
		scheduleSize(node);
		return;
	}
	host.style.display = "flex";
	const title = document.createElement("div");
	title.textContent = `图层预览：${refs.length} 层`;
	title.style.cssText = "font-size:12px;color:#d9e9e4;font-weight:700;";
	const stage = document.createElement("div");
	stage.style.cssText = [
		"position:relative",
		"width:100%",
		"aspect-ratio:1/1",
		"min-height:220px",
		"background:linear-gradient(45deg,#152026 25%,#1d2a31 25%,#1d2a31 50%,#152026 50%,#152026 75%,#1d2a31 75%)",
		"background-size:24px 24px",
		"border:1px solid #39515a",
		"border-radius:8px",
		"overflow:hidden",
	].join(";");
	refs.forEach((ref, index) => {
		const img = document.createElement("img");
		img.src = apiViewUrl(ref);
		img.title = `Layer ${index + 1}`;
		img.style.cssText = [
			"position:absolute",
			"inset:0",
			"width:100%",
			"height:100%",
			"object-fit:contain",
			"opacity:.92",
			`transform:translate(${index * 4}px,${index * -3}px)`,
			"filter:drop-shadow(0 2px 4px rgba(0,0,0,.35))",
		].join(";");
		stage.appendChild(img);
	});
	host.append(title, stage);
	scheduleSize(node);
}

function createPanel(node) {
	const root = document.createElement("div");
	root.style.cssText = "display:flex;flex-direction:column;gap:8px;width:100%;box-sizing:border-box;padding:2px 0;color:#edf7f3;font-family:system-ui,sans-serif;pointer-events:auto;";
	protect(root);

	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;";

	const run = button("✨", "生成当前节点", async (_event, btn) => {
		if (node.__gjjLayeredRandomSeed) setValue(node, "seed", Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
		btn.textContent = "⏳";
		renderProgress(node, "提交生成...");
		try {
			await queueOnlyCurrentNode?.(node);
		} finally {
			setTimeout(() => { btn.textContent = "✨"; }, 500);
		}
	});
	const random = button("🎲", "随机种子开关", (_event, btn) => {
		node.__gjjLayeredRandomSeed = !node.__gjjLayeredRandomSeed;
		btn.style.background = node.__gjjLayeredRandomSeed ? "#79520f" : "#182329";
	});
	const keep = button("📍", "保持模型开关", () => {
		setValue(node, "keep_model_loaded", !Boolean(getValue(node, "keep_model_loaded", false)));
		updateKeepButton(node);
	});
	node.__gjjLayeredKeepButton = keep;

	toolbar.append(
		button("📁", "选择图片", () => chooseImage(node)),
		run,
		button("🧠", "模型", (_event, anchor) => toggleFloating(node, "__gjjLayeredModelPanel", anchor, "🧠 模型参数", 560, (body) => buildModelPanel(node, body))),
		button("📐", "尺寸", (_event, anchor) => toggleFloating(node, "__gjjLayeredSizePanel", anchor, "📐 尺寸与图层", 420, (body) => buildSizePanel(node, body))),
		button("⚙️", "其它参数", (_event, anchor) => toggleFloating(node, "__gjjLayeredSettingsPanel", anchor, "⚙️ 采样与负面", 520, (body) => buildSettingsPanel(node, body))),
		random,
		keep
	);

	const prompt = input(node, "prompt", "textarea");
	prompt.placeholder = "正向提示词";

	const imageHint = document.createElement("div");
	imageHint.style.cssText = "display:none;grid-template-columns:42px minmax(0,1fr);gap:7px;align-items:center;padding:6px;border:1px solid #2e424a;border-radius:7px;background:#121b20;";
	node.__gjjLayeredImageHint = imageHint;

	const progress = document.createElement("div");
	progress.style.cssText = "display:none;padding:6px 8px;border:1px solid #37525c;border-radius:6px;background:#10181d;color:#a7f3d0;font-size:12px;";
	node.__gjjLayeredProgress = progress;

	const preview = document.createElement("div");
	preview.style.cssText = "display:none;flex-direction:column;gap:7px;";
	node.__gjjLayeredPreviewHost = preview;

	root.append(toolbar, field("正向提示词", prompt), imageHint, progress, preview);
	node.__gjjLayeredPanel = root;
	updateKeepButton(node);
	renderChosenImage(node, getValue(node, "uploaded_image", "") ? { filename: getValue(node, "uploaded_image", "") } : null);
	renderPreview(node, node.__gjjLayeredLastRefs || []);
	return root;
}

function install(node) {
	if (!node || node.__gjjLayeredInstalled) return;
	node.__gjjLayeredInstalled = true;
	for (const w of node.widgets || []) {
		if (HIDDEN.has(w?.name)) hideWidget(w);
	}
	const panel = createPanel(node);
	const domWidget = node.addDOMWidget(PANEL, "HTML", panel, { serialize: false });
	domWidget.computeSize = () => [Math.max(390, Number(node.size?.[0] || 430)), Math.max(160, panel.scrollHeight + 14)];
	domWidget.getHeight = () => Math.max(160, panel.scrollHeight + 14);
	scheduleSize(node);
}

function nodeById(id) {
	return app.graph?.getNodeById?.(Number(id)) || app.graph?._nodes?.find((item) => String(item?.id) === String(id));
}

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const node = nodeById(detail.node || detail.node_id);
	if (!node || (node.comfyClass || node.type) !== TARGET) return;
	renderProgress(node, detail.text || detail.message || "");
});

app.registerExtension({
	name: "Comfy.GJJ.QwenImageLayeredPSDStudio",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			setTimeout(() => install(this), 0);
			return result;
		};

		const originalConfigured = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalConfigured?.apply(this, args);
			setTimeout(() => install(this), 0);
			return result;
		};

		const originalRemoved = nodeType.prototype.onRemoved;
		nodeType.prototype.onRemoved = function (...args) {
			closeFloating(this);
			for (const key of ["__gjjLayeredModelPanel", "__gjjLayeredSizePanel", "__gjjLayeredSettingsPanel", "__gjjLayeredFileInput"]) {
				this[key]?.remove?.();
				this[key] = null;
			}
			return originalRemoved?.apply(this, args);
		};

		nodeType.prototype.onDrawForeground = function () {
			for (const [key, anchor] of [
				["__gjjLayeredModelPanel", null],
				["__gjjLayeredSizePanel", null],
				["__gjjLayeredSettingsPanel", null],
			]) {
				if (this[key]?.style?.display === "flex") positionFloating(this, this[key], anchor || this.__gjjLayeredPanel);
			}
			return undefined;
		};

		nodeType.prototype.onExecuted = function (message) {
			const refs = message?.gjj_layer_images || message?.ui?.gjj_layer_images || message?.images || message?.ui?.images || [];
			this.__gjjLayeredLastRefs = refs;
			renderPreview(this, refs);
			return undefined;
		};
	},
});
