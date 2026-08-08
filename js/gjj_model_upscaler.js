import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const NODE_CLASS = "GJJ_ModelUpscaler";
const MODEL_WIDGET = "upscale_model_name";
const LOCAL_IMAGES_WIDGET = "selected_images";
const TEST_MODE_WIDGET = "test_mode";
const INTERNAL_WIDGETS = new Set(["enabled", MODEL_WIDGET, LOCAL_IMAGES_WIDGET, TEST_MODE_WIDGET]);
const LINK_MEMORY_PROPERTY = "gjj_model_upscaler_link_memory";
const PANEL_OPEN_PROPERTY = "gjj_model_upscaler_model_panel_open";

function widget(node, name) {
	return GJJ_Utils.getWidget(node, name);
}

function modelChoices(node) {
	const modelWidget = widget(node, MODEL_WIDGET);
	const values = modelWidget?.options?.values || modelWidget?.options?.items || [];
	return Array.isArray(values) ? values.map(String).filter(Boolean) : [];
}

function modelDefault(node) {
	const modelWidget = widget(node, MODEL_WIDGET);
	return String(modelWidget?.options?.gjj_default_model || modelChoices(node)[0] || modelWidget?.value || "");
}

function markChanged(node) {
	node?.graph?.change?.();
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function inputLink(node) {
	const slot = node?.inputs?.findIndex((input) => String(input?.name || "") === "image") ?? -1;
	const input = slot >= 0 ? node.inputs[slot] : null;
	const link = input?.link != null ? app.graph?.links?.[input.link] : null;
	return { slot, link };
}

function selectedImages(node) {
	const raw = widget(node, LOCAL_IMAGES_WIDGET)?.value;
	if (Array.isArray(raw)) return raw.filter((item) => item?.filename);
	try {
		const parsed = JSON.parse(String(raw || "[]"));
		return Array.isArray(parsed) ? parsed.filter((item) => item?.filename) : [];
	} catch {
		return [];
	}
}

function setActionAvailable(button, available, title) {
	if (!button) return;
	button.disabled = !available;
	button.title = available ? title : "请先连接外部图像，或点击 📁 打开素材";
	button.style.cursor = available ? "pointer" : "not-allowed";
	button.style.filter = available ? "none" : "grayscale(1)";
	button.style.opacity = available ? "1" : "0.42";
}

function updateSourceState(node) {
	const available = !node?.__gjjUpscalerTesting && Boolean(inputLink(node).link || selectedImages(node).length);
	setActionAvailable(node?.__gjjUpscalerTestButton, available, "一次提交所有放大模型进行测试");
	setActionAvailable(node?.__gjjUpscalerRunButton, available, "只运行当前节点");
	updateLocalPreview(node);
}

function updateLinkButton(node) {
	const button = node?.__gjjUpscalerLinkButton;
	if (!button) return;
	const { link } = inputLink(node);
	const memory = node?.properties?.[LINK_MEMORY_PROPERTY];
	button.style.display = link || memory ? "flex" : "none";
	button.title = link ? "记住并断开外部图像链接" : "恢复上次断开的外部图像链接";
	button.style.borderColor = link ? "#38bdf8" : "#f59e0b";
	button.style.background = link
		? "linear-gradient(135deg,#075985,#0284c7)"
		: "linear-gradient(135deg,#4a2f08,#b45309)";
}

function toggleExternalLink(node) {
	const { slot, link } = inputLink(node);
	node.properties = node.properties || {};
	if (link && slot >= 0) {
		node.properties[LINK_MEMORY_PROPERTY] = {
			origin_id: Number(link.origin_id),
			origin_slot: Number(link.origin_slot),
		};
		node.disconnectInput?.(slot);
	} else {
		const memory = node.properties[LINK_MEMORY_PROPERTY];
		const source = memory ? app.graph?.getNodeById?.(Number(memory.origin_id)) : null;
		const currentSlot = node.inputs?.findIndex((input) => String(input?.name || "") === "image") ?? -1;
		if (source && currentSlot >= 0 && source.outputs?.[Number(memory.origin_slot)]) {
			source.connect?.(Number(memory.origin_slot), node, currentSlot);
			delete node.properties[LINK_MEMORY_PROPERTY];
		}
	}
	updateLinkButton(node);
	markChanged(node);
}

async function chooseImages(node) {
	let input = node.__gjjUpscalerFileInput;
	if (!input) {
		input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.multiple = true;
		input.style.display = "none";
		document.body.appendChild(input);
		node.__gjjUpscalerFileInput = input;
	}
	input.value = "";
	const files = await new Promise((resolve) => {
		input.onchange = () => resolve(Array.from(input.files || []));
		input.click();
	});
	if (!files.length) return;
	const selected = [];
	for (const file of files) {
		const form = new FormData();
		form.append("image", file, file.name);
		form.append("type", "input");
		form.append("overwrite", "true");
		const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data?.error || `图片上传失败：${file.name}`);
		selected.push({
			filename: String(data?.name || data?.filename || file.name),
			subfolder: String(data?.subfolder || ""),
			type: String(data?.type || "input"),
		});
	}
	const target = widget(node, LOCAL_IMAGES_WIDGET);
	if (target) {
		target.value = JSON.stringify(selected);
		target.callback?.(target.value);
	}
	updateSourceState(node);
	markChanged(node);
}

function updateLocalPreview(node) {
	const popup = node?.__gjjUpscalerLocalPreview;
	if (!popup) return;
	popup.replaceChildren();
	for (const item of selectedImages(node)) {
		const image = document.createElement("img");
		image.src = api.apiURL(`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "input")}&subfolder=${encodeURIComponent(item.subfolder || "")}`);
		image.alt = String(item.filename);
		image.title = String(item.filename);
		image.style.cssText = "display:block;width:132px;height:96px;object-fit:contain;border-radius:5px;background:#070b0d;";
		popup.appendChild(image);
	}
}

function closeModelPanel(node) {
	node.__gjjUpscalerModelPanel?.remove();
	node.__gjjUpscalerModelPanel = null;
	node.properties = node.properties || {};
	node.properties[PANEL_OPEN_PROPERTY] = false;
}

function openModelPanel(node) {
	if (node.__gjjUpscalerModelPanel) {
		closeModelPanel(node);
		return;
	}
	const panel = document.createElement("div");
	panel.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:100003;width:min(720px,calc(100vw - 28px));max-height:min(640px,calc(100vh - 28px));padding:10px;border:1px solid #526872;border-radius:10px;background:#10171b;box-shadow:0 20px 64px rgba(0,0,0,.68);box-sizing:border-box;color:#e5edf2;";
	const header = document.createElement("div");
	header.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px;font:800 14px system-ui;";
	header.innerHTML = "<span style='flex:1'>🧠 放大模型</span>";
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "×";
	close.style.cssText = "width:28px;height:26px;border:1px solid #526872;border-radius:6px;background:#1a2328;color:#dce7e2;cursor:pointer;";
	close.onclick = () => closeModelPanel(node);
	header.appendChild(close);
	panel.appendChild(header);
	panel.appendChild(GJJ_Utils.createModelTreeView({
		node,
		entries: [{
			widget: MODEL_WIDGET,
			label: "放大模型",
			folder: "models/upscale_models",
			icon: "🟣",
			models: modelChoices(node),
			fallback: modelDefault(node),
			defaultModel: modelDefault(node),
			floatingChoices: true,
			description: "当前模型名会自动转换为模型族过滤词；无匹配项时显示默认模型。",
		}],
		refresh: () => markChanged(node),
		onApply: () => markChanged(node),
	}));
	for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "keydown", "wheel"]) {
		panel.addEventListener(eventName, (event) => event.stopPropagation());
	}
	document.body.appendChild(panel);
	node.__gjjUpscalerModelPanel = panel;
	node.properties = node.properties || {};
	node.properties[PANEL_OPEN_PROPERTY] = true;
}

async function testAllModels(node, button, runButton) {
	const target = widget(node, MODEL_WIDGET);
	const testMode = widget(node, TEST_MODE_WIDGET);
	const models = modelChoices(node);
	if (!target || !models.length) return;
	const original = target.value;
	const originalTestMode = testMode?.value;
	if (node.__gjjUpscalerPreview) node.__gjjUpscalerPreview.replaceChildren();
	node.__gjjUpscalerTesting = true;
	button.disabled = true;
	if (runButton) runButton.disabled = true;
	try {
		if (testMode) testMode.value = true;
		for (let index = 0; index < models.length; index += 1) {
			button.textContent = `${index + 1}/${models.length}`;
			target.value = models[index];
			target.callback?.(target.value);
			if (!await queueOnlyCurrentNode(node)) throw new Error(`模型提交失败：${models[index]}`);
		}
		button.textContent = "✅";
	} catch (error) {
		console.error("[GJJ_ModelUpscaler] 全模型测试失败:", error);
		button.textContent = "❌";
	} finally {
		target.value = original;
		target.callback?.(target.value);
		if (testMode) testMode.value = originalTestMode ?? false;
		setTimeout(() => {
			button.textContent = "🧪";
			node.__gjjUpscalerTesting = false;
			updateSourceState(node);
		}, 1200);
	}
}

function createButton(label, title, colors) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title;
	button.style.cssText = `height:36px;min-width:36px;padding:0 7px;border:1px solid ${colors.border};border-radius:6px;background:${colors.background};color:${colors.color};font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-sizing:border-box;`;
	return button;
}

function createPanel(node) {
	const root = document.createElement("div");
	root.style.cssText = "position:relative;display:flex;flex-direction:column;gap:6px;width:100%;pointer-events:auto;box-sizing:border-box;";
	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;align-items:center;gap:0;width:100%;";
	const folder = createButton("📁", "打开一张或多张本地图像", { border: "#64748b", background: "linear-gradient(135deg,#1e293b,#475569)", color: "#f8fafc" });
	const link = createButton("🔗", "断开或恢复外部图像链接", { border: "#38bdf8", background: "linear-gradient(135deg,#075985,#0284c7)", color: "#e0f2fe" });
	const model = createButton("🧠", "设置放大模型树", { border: "#8b5cf6", background: "linear-gradient(135deg,#4c1d95,#7c3aed)", color: "#f5f3ff" });
	const test = createButton("🧪", "一次提交所有放大模型进行测试", { border: "#f59e0b", background: "linear-gradient(135deg,#4a2f08,#b45309)", color: "#fffbeb" });
	const run = createButton("▶️", "只运行当前节点", { border: "#10b981", background: "linear-gradient(135deg,#064e3b,#059669)", color: "#d1fae5" });
	node.__gjjUpscalerLinkButton = link;
	node.__gjjUpscalerTestButton = test;
	node.__gjjUpscalerRunButton = run;
	const localPreview = document.createElement("div");
	localPreview.style.cssText = "display:none;position:absolute;left:0;top:40px;z-index:20;max-width:440px;max-height:330px;overflow:auto;padding:6px;grid-template-columns:repeat(3,132px);gap:6px;border:1px solid #64748b;border-radius:8px;background:#10171b;box-shadow:0 12px 32px rgba(0,0,0,.62);pointer-events:none;";
	node.__gjjUpscalerLocalPreview = localPreview;
	const protect = (handler) => async (event) => {
		event.preventDefault();
		event.stopPropagation();
		try { await handler(event); } catch (error) { console.error("[GJJ_ModelUpscaler] 操作失败:", error); }
	};
	folder.onclick = protect(() => chooseImages(node));
	link.onclick = protect(() => toggleExternalLink(node));
	model.onclick = protect(() => openModelPanel(node));
	test.onclick = protect(() => testAllModels(node, test, run));
	run.onclick = protect(() => queueOnlyCurrentNode(node));
	folder.addEventListener("mouseenter", () => {
		updateLocalPreview(node);
		if (selectedImages(node).length) localPreview.style.display = "grid";
	});
	folder.addEventListener("mouseleave", () => { localPreview.style.display = "none"; });
	toolbar.append(folder, link, model, test, run);
	const preview = document.createElement("div");
	preview.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:6px;width:100%;";
	node.__gjjUpscalerPreview = preview;
	root.append(toolbar, localPreview, preview);
	updateLinkButton(node);
	updateSourceState(node);
	return root;
}

function firstValue(value, fallback = "") {
	return Array.isArray(value) ? (value[0] ?? fallback) : (value ?? fallback);
}

function appendTestPreview(node, message) {
	const images = Array.isArray(message?.images) ? message.images : [];
	if (!images.length || !node?.__gjjUpscalerPreview) return;
	const label = String(firstValue(message?.gjj_result_label, firstValue(message?.gjj_model_name, "模型测试")));
	for (const item of images) {
		if (!item?.filename) continue;
		const card = document.createElement("div");
		card.style.cssText = "min-width:0;padding:5px;border:1px solid #33454c;border-radius:7px;background:#0f171b;color:#dce7e2;box-sizing:border-box;";
		const image = document.createElement("img");
		image.src = api.apiURL(`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "output")}&subfolder=${encodeURIComponent(item.subfolder || "")}&rand=${Date.now()}`);
		image.alt = label;
		image.title = label;
		image.style.cssText = "display:block;width:100%;height:118px;object-fit:contain;border-radius:5px;background:#070b0d;";
		const caption = document.createElement("div");
		caption.textContent = label;
		caption.title = label;
		caption.style.cssText = "margin-top:4px;font:11px/1.35 ui-monospace,Consolas,monospace;white-space:normal;overflow-wrap:anywhere;color:#dce7e2;";
		card.append(image, caption);
		node.__gjjUpscalerPreview.appendChild(card);
	}
	GJJ_Utils.refreshNode(node);
}

function stabilize(node) {
	for (const name of INTERNAL_WIDGETS) GJJ_Utils.hideWidget(widget(node, name));
	if (!node.__gjjUpscalerPanelWidget) {
		node.__gjjUpscalerPanelWidget = node.addDOMWidget("gjj_model_upscaler_panel", "HTML", createPanel(node), { serialize: false });
	}
	updateLinkButton(node);
	updateSourceState(node);
	GJJ_Utils.refreshNode(node);
}

app.registerExtension({
	name: "Comfy.GJJ.ModelUpscaler",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_CLASS) return;
		nodeData.output_preview = false;
		nodeType.prototype.hideOutputImages = true;
		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			const result = originalCreated?.apply(this, arguments);
			setTimeout(() => stabilize(this), 0);
			return result;
		};
		const originalConfigured = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function () {
			const result = originalConfigured?.apply(this, arguments);
			setTimeout(() => stabilize(this), 0);
			return result;
		};
		const originalConnections = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function () {
			const result = originalConnections?.apply(this, arguments);
			setTimeout(() => {
				updateLinkButton(this);
				updateSourceState(this);
			}, 0);
			return result;
		};
		const originalExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalExecuted?.apply(this, arguments);
			appendTestPreview(this, message || {});
			return result;
		};
		const originalRemoved = nodeType.prototype.onRemoved;
		nodeType.prototype.onRemoved = function () {
			closeModelPanel(this);
			this.__gjjUpscalerFileInput?.remove();
			return originalRemoved?.apply(this, arguments);
		};
	},
});
