import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const NODE_TYPE = "GJJ_MiniMaxH3Studio";
const PANEL_WIDGET = "__gjj_minimax_h3_panel";
const STYLE_ID = "gjj-minimax-h3-studio-style";
const HIDDEN = new Set([
	"prompt", "width", "height", "duration", "frame_rate", "steps", "seed", "randomize_seed",
	"sampler_name", "scheduler", "denoise", "ref_image_size", "filename_prefix", "format_name",
	"fl_model", "ref_model", "clip_name", "video_vae_name", "audio_vae_name", "keep_model",
	"use_source_size",
]);
const POPUP_GROUPS = {
	params: [["生成参数", ["duration", "frame_rate", "steps", "seed", "sampler_name", "scheduler", "denoise", "ref_image_size"]], ["输出", ["filename_prefix", "format_name"]]],
	size: [["画面尺寸", ["width", "height"]]],
};

function widget(node, name) { return GJJ_Utils.getWidget(node, name); }
function value(node, name, fallback = "") { return widget(node, name)?.value ?? fallback; }
function setValue(node, name, next) {
	const target = widget(node, name); if (!target) return;
	target.value = next; target.callback?.(next); app.graph?.setDirtyCanvas?.(true, true);
}
function protect(element) {
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel", "keydown", "contextmenu"]) element.addEventListener(eventName, (event) => event.stopPropagation());
}
function installStyle() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style"); style.id = STYLE_ID;
	style.textContent = `
	.gjj-mh3-root{font:12px/1.3 system-ui;color:#dcebed;background:#10191d;border-radius:8px;padding:8px;display:grid;gap:7px}
	.gjj-mh3-toolbar{display:flex;gap:6px;align-items:center}.gjj-mh3-btn{height:32px;min-width:40px;border:1px solid #42747d;border-radius:6px;background:#173038;color:#dff;cursor:pointer;font-weight:700}.gjj-mh3-btn:hover{filter:brightness(1.18)}.gjj-mh3-btn.active{background:#175f4d;border-color:#55d2a2}.gjj-mh3-run{min-width:118px;background:#168953;border-color:#39d789;color:white;font-weight:900}
	.gjj-mh3-label{display:flex;align-items:center;gap:6px;color:#ffd27d;font-weight:700}.gjj-mh3-mode{margin-left:auto;color:#7ed9d3;font-weight:600}
	.gjj-mh3-prompt{box-sizing:border-box;width:100%;height:72px;min-height:58px;resize:vertical;border:1px solid #31535b;border-radius:6px;background:#091215;color:#f0f8f8;padding:7px;font:12px/1.35 ui-monospace,monospace}
	.gjj-mh3-status{height:16px;color:#8faeb4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
	.gjj-mh3-pop{position:fixed;z-index:100000;width:min(560px,calc(100vw - 28px));max-height:calc(100vh - 40px);overflow:auto;display:none;background:#101a1e;color:#e2f0f1;border:1px solid #4e7d86;border-radius:10px;box-shadow:0 14px 45px #000b;padding:10px}.gjj-mh3-pop.open{display:block}.gjj-mh3-pophead{display:flex;justify-content:space-between;align-items:center;font-weight:800;margin-bottom:8px}.gjj-mh3-close{border:1px solid #40717a;border-radius:5px;background:#173038;color:#dff;padding:5px 12px;cursor:pointer}.gjj-mh3-section{border-top:1px solid #29434a;padding-top:8px;margin-top:8px}.gjj-mh3-title{color:#7ed9d3;font-weight:800;margin-bottom:7px}.gjj-mh3-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.gjj-mh3-field{display:grid;gap:3px;color:#9eb8bd}.gjj-mh3-field.wide{grid-column:1/-1}.gjj-mh3-control{box-sizing:border-box;width:100%;min-width:0;background:#0b1316;color:#e8f5f5;border:1px solid #304e55;border-radius:5px;padding:6px}.gjj-mh3-toggle.active{background:#17614e;color:#fff}
	.gjj-mh3-size-tabs,.gjj-mh3-ratios{display:grid;gap:8px}.gjj-mh3-size-tabs{grid-template-columns:1fr 1fr;margin:8px 0 14px}.gjj-mh3-ratios{grid-template-columns:repeat(5,1fr);margin-bottom:15px}.gjj-mh3-size-choice{min-height:40px;border:1px solid #415861;border-radius:8px;background:#111b20;color:#dbe6e7;font-weight:800;font-size:14px;cursor:pointer}.gjj-mh3-size-choice.active{border-color:#19d8df;background:#0d8fb0;color:#fff}.gjj-mh3-size-tabs .gjj-mh3-size-choice.active{background:#12964d;border-color:#27dda0}.gjj-mh3-slider-row{display:grid;grid-template-columns:62px minmax(0,1fr) 90px;gap:10px;align-items:center;margin:13px 0;color:#c9d7da;font-weight:700}.gjj-mh3-slider-row input[type=range]{width:100%;accent-color:#19b7d0}.gjj-mh3-size-number{width:100%;box-sizing:border-box;border:1px solid #415861;border-radius:7px;background:#111b20;color:#eaf5f6;padding:8px;text-align:center;font-weight:800}.gjj-mh3-size-disabled{opacity:.42}`;
	document.head.appendChild(style);
}
function hideBackendWidgets(node) {
	for (const name of HIDDEN) {
		const target = widget(node, name); if (!target) continue;
		GJJ_Utils.hideWidget(target); target.hidden = true; target.computeSize = () => [0, 0]; target.getHeight = () => 0; target.draw = () => {}; target.last_y = 0; target.computedHeight = 0; target.size = [0, 0];
		target.options ||= {}; target.options.hidden = true; target.options.display = "hidden";
		for (const element of [target.element, target.inputEl, target.widget]) if (element?.style) { element.style.display = "none"; element.style.height = "0"; element.style.margin = "0"; element.style.padding = "0"; }
	}
}
function choices(target) {
	let items = target?.options?.values || target?.options?.items || target?.values;
	if (typeof items === "function") try { items = items(); } catch (_) { items = []; }
	return Array.isArray(items) ? items : [];
}
function makeControl(node, name) {
	const target = widget(node, name); if (!target) return null;
	let control; const items = choices(target);
	if (typeof target.value === "boolean") {
		control = document.createElement("button"); control.type = "button"; control.className = "gjj-mh3-control gjj-mh3-toggle";
		const sync = () => { control.textContent = target.value ? "开启" : "关闭"; control.classList.toggle("active", Boolean(target.value)); };
		control.addEventListener("click", () => { setValue(node, name, !Boolean(target.value)); sync(); }); sync();
	} else if (items.length) {
		control = document.createElement("select");
		for (const item of items) { const option = document.createElement("option"); option.value = String(item); option.textContent = String(item); control.appendChild(option); }
		control.value = String(target.value ?? ""); control.addEventListener("change", () => setValue(node, name, control.value));
	} else {
		control = document.createElement("input"); control.type = typeof target.value === "number" ? "number" : "text"; control.value = String(target.value ?? "");
		if (control.type === "number") { for (const attr of ["min", "max", "step"]) if (target.options?.[attr] != null) control[attr] = String(target.options[attr]); }
		control.addEventListener("change", () => setValue(node, name, typeof target.value === "number" ? Number(control.value) : control.value));
	}
	control.classList.add("gjj-mh3-control"); protect(control); return control;
}
function modelTreeEntries(node) {
	return (node.widgets || []).filter((target) => String(target?.options?.gjj_model_folder || "").trim()).map((target) => {
		const fieldName = String(target.name || target.options?.name || "").trim();
		const folder = String(target.options.gjj_model_folder).trim();
		const defaultModel = String(target?.options?.gjj_default_model || target?.options?.default || "").trim();
		return {
			widget: fieldName,
			folder,
			icon: String(target.options.gjj_model_icon || "🟣"),
			label: String(target?.options?.display_name || target?.label || fieldName),
			models: choices(target),
			defaultModel,
			fallback: defaultModel,
			autoSelect: true,
			floatingChoices: false,
			description: `候选项来自 models/${folder}；过滤词由当前模型的文件名自动提取。`,
		};
	});
}
function renderModelTree(node, host) {
	const tree = GJJ_Utils.createModelTreeView({
		node,
		entries: modelTreeEntries(node),
		refresh: () => GJJ_Utils.refreshNode?.(node),
		onApply: () => queueMicrotask(() => renderModelTree(node, host)),
	});
	tree.style.maxHeight = "min(460px,calc(100vh - 180px))";
	host.replaceChildren(tree);
}
function createSizePanel(node) {
	const host = document.createElement("div");
	const tabs = document.createElement("div"); tabs.className = "gjj-mh3-size-tabs";
	const sourceButton = document.createElement("button"); sourceButton.type = "button"; sourceButton.className = "gjj-mh3-size-choice"; sourceButton.textContent = "原图尺寸";
	const panelButton = document.createElement("button"); panelButton.type = "button"; panelButton.className = "gjj-mh3-size-choice"; panelButton.textContent = "画板尺寸";
	tabs.append(sourceButton, panelButton);
	const ratios = document.createElement("div"); ratios.className = "gjj-mh3-ratios";
	const ratioDefs = [[16, 9], [9, 16], [1, 1], [4, 3], [3, 4]];
	const ratioButtons = ratioDefs.map(([wide, high]) => {
		const button = document.createElement("button"); button.type = "button"; button.className = "gjj-mh3-size-choice"; button.textContent = `${wide}:${high}`; button.dataset.ratio = `${wide}:${high}`; ratios.appendChild(button); return button;
	});
	const dimensions = document.createElement("div");
	const controls = {};
	for (const [name, icon, label] of [["width", "📐", "宽度"], ["height", "📏", "高度"]]) {
		const target = widget(node, name); const row = document.createElement("label"); row.className = "gjj-mh3-slider-row";
		const caption = document.createElement("span"); caption.textContent = `${icon} ${label}`;
		const range = document.createElement("input"); range.type = "range"; range.min = String(target?.options?.min ?? 352); range.max = String(target?.options?.max ?? 1920); range.step = String(target?.options?.step ?? 32);
		const number = document.createElement("input"); number.type = "number"; number.className = "gjj-mh3-size-number"; number.min = range.min; number.max = range.max; number.step = range.step;
		const apply = (raw) => { const min = Number(range.min); const max = Number(range.max); const step = Number(range.step) || 1; const next = Math.max(min, Math.min(max, Math.round(Number(raw) / step) * step)); setValue(node, name, next); range.value = String(next); number.value = String(next); sync(); };
		range.addEventListener("input", () => apply(range.value)); number.addEventListener("change", () => apply(number.value)); row.append(caption, range, number); dimensions.appendChild(row); controls[name] = { range, number };
	}
	const sync = () => {
		const source = Boolean(value(node, "use_source_size", true)); sourceButton.classList.toggle("active", source); panelButton.classList.toggle("active", !source); dimensions.classList.toggle("gjj-mh3-size-disabled", source);
		for (const control of Object.values(controls)) { control.range.disabled = source; control.number.disabled = source; }
		for (const button of ratioButtons) button.disabled = source;
		controls.width.range.value = controls.width.number.value = String(value(node, "width", 864)); controls.height.range.value = controls.height.number.value = String(value(node, "height", 480));
		const width = Number(value(node, "width", 864)); const height = Number(value(node, "height", 480));
		for (const button of ratioButtons) { const [wide, high] = button.dataset.ratio.split(":").map(Number); button.classList.toggle("active", !source && Math.abs(width / height - wide / high) < 0.025); }
	};
	sourceButton.addEventListener("click", () => { setValue(node, "use_source_size", true); sync(); }); panelButton.addEventListener("click", () => { setValue(node, "use_source_size", false); sync(); });
	const aligned = (name, raw) => { const target = widget(node, name); const min = Number(target?.options?.min ?? 352); const max = Number(target?.options?.max ?? 1920); const step = Number(target?.options?.step ?? 32) || 1; return Math.max(min, Math.min(max, Math.round(Number(raw) / step) * step)); };
	ratioButtons.forEach((button, index) => button.addEventListener("click", () => { const [wide, high] = ratioDefs[index]; const edge = Math.max(Number(value(node, "width", 864)), Number(value(node, "height", 480))); if (wide >= high) { setValue(node, "width", aligned("width", edge)); setValue(node, "height", aligned("height", edge * high / wide)); } else { setValue(node, "height", aligned("height", edge)); setValue(node, "width", aligned("width", edge * wide / high)); } sync(); }));
	for (const element of [sourceButton, panelButton, ...ratioButtons, ...Object.values(controls).flatMap((item) => [item.range, item.number])]) protect(element);
	host.append(tabs, ratios, dimensions); host.__gjjSync = sync; sync(); return host;
}
function popup(node, key, title) {
	const root = document.createElement("div"); root.className = "gjj-mh3-pop"; root.dataset.popup = key; protect(root);
	const head = document.createElement("div"); head.className = "gjj-mh3-pophead"; const caption = document.createElement("span"); caption.textContent = title;
	const close = document.createElement("button"); close.className = "gjj-mh3-close"; close.textContent = key === "size" ? "×" : "确定"; close.addEventListener("click", () => closePopups(node)); head.append(caption, close); root.append(head);
	if (key === "size") {
		const sizePanel = createSizePanel(node); root.appendChild(sizePanel); root.__gjjSizePanel = sizePanel;
		document.body.appendChild(root);
		return root;
	}
	if (key === "model") {
		const treeHost = document.createElement("div");
		root.appendChild(treeHost);
		renderModelTree(node, treeHost);
		const keepSection = document.createElement("section"); keepSection.className = "gjj-mh3-section";
		const keepGrid = document.createElement("div"); keepGrid.className = "gjj-mh3-grid";
		const keepControl = makeControl(node, "keep_model");
		if (keepControl) { const row = document.createElement("label"); row.className = "gjj-mh3-field wide"; const label = document.createElement("span"); label.textContent = widget(node, "keep_model")?.options?.display_name || "保持模型"; row.append(label, keepControl); keepGrid.append(row); }
		keepSection.appendChild(keepGrid); root.appendChild(keepSection);
		root.__gjjModelTreeHost = treeHost;
		document.body.appendChild(root);
		return root;
	}
	for (const [sectionTitle, names] of POPUP_GROUPS[key] || []) {
		const section = document.createElement("section"); section.className = "gjj-mh3-section"; const heading = document.createElement("div"); heading.className = "gjj-mh3-title"; heading.textContent = sectionTitle;
		const grid = document.createElement("div"); grid.className = "gjj-mh3-grid";
		for (const name of names) { const control = makeControl(node, name); if (!control) continue; const row = document.createElement("label"); row.className = "gjj-mh3-field"; if (["filename_prefix", "format_name"].includes(name)) row.classList.add("wide"); const label = document.createElement("span"); label.textContent = widget(node, name)?.options?.display_name || widget(node, name)?.label || name; row.append(label, control); grid.append(row); }
		section.append(heading, grid); root.append(section);
	}
	document.body.appendChild(root); return root;
}
function closePopups(node) { for (const item of Object.values(node.__gjjMiniMaxPanel?.popups || {})) item.classList.remove("open"); for (const item of Object.values(node.__gjjMiniMaxPanel?.buttons || {})) item.classList.remove("active"); }
function openPopup(node, key, anchor) {
	const panel = node.__gjjMiniMaxPanel; const target = panel?.popups?.[key]; if (!target) return;
	const wasOpen = target.classList.contains("open"); closePopups(node); if (wasOpen) return;
	if (key === "size") target.__gjjSizePanel?.__gjjSync?.();
	if (key === "model" && target.__gjjModelTreeHost) renderModelTree(node, target.__gjjModelTreeHost);
	const rect = anchor.getBoundingClientRect(); const width = Math.min(560, window.innerWidth - 28); target.style.width = `${width}px`; target.style.left = `${Math.max(14, Math.min(window.innerWidth - width - 14, rect.left))}px`; target.style.top = `${Math.max(14, Math.min(window.innerHeight - 300, rect.bottom + 7))}px`; target.classList.add("open"); anchor.classList.add("active");
}
function makeButton(text, title, className = "") { const button = document.createElement("button"); button.type = "button"; button.className = `gjj-mh3-btn ${className}`; button.textContent = text; button.title = title; protect(button); return button; }
function cleanup(node) { closePopups(node); for (const item of Object.values(node.__gjjMiniMaxPanel?.popups || {})) item.remove(); node.__gjjMiniMaxPanel = null; }
function createPanel(node) {
	if (node.__gjjMiniMaxPanel) return; installStyle();
	const root = document.createElement("div"); root.className = "gjj-mh3-root"; protect(root);
	const toolbar = document.createElement("div"); toolbar.className = "gjj-mh3-toolbar";
	const run = makeButton("🎬 生成视频", "只运行当前 MiniMax H3 节点", "gjj-mh3-run");
	const size = makeButton("📐", "尺寸参数"); const seed = makeButton("🎲", "随机种子"); const model = makeButton("🧠", "模型参数"); const settings = makeButton("⚙", "生成参数");
	toolbar.append(run, size, seed, model, settings);
	const label = document.createElement("div"); label.className = "gjj-mh3-label"; label.textContent = "✨ 正向提示词"; const mode = document.createElement("span"); mode.className = "gjj-mh3-mode"; mode.textContent = "AUTO"; label.append(mode);
	const prompt = document.createElement("textarea"); prompt.className = "gjj-mh3-prompt"; prompt.placeholder = "输入提示词…"; prompt.value = String(value(node, "prompt", "")); prompt.addEventListener("input", () => setValue(node, "prompt", prompt.value)); protect(prompt);
	const status = document.createElement("div"); status.className = "gjj-mh3-status"; status.textContent = "无输入 T2V｜单图 I2V｜多媒体 Ref2V";
	root.append(toolbar, label, prompt, status);
	const dom = node.addDOMWidget(PANEL_WIDGET, "div", root, { serialize: false, hideOnZoom: false }); dom.computeSize = () => [Math.max(410, node.size?.[0] || 410), 190];
	const panel = node.__gjjMiniMaxPanel = { root, status, buttons: { size, seed, model, settings }, popups: {} };
	panel.popups.params = popup(node, "params", "生成参数"); panel.popups.size = popup(node, "size", "📐 尺寸"); panel.popups.model = popup(node, "model", "模型参数");
	run.addEventListener("click", async () => { closePopups(node); status.textContent = "正在提交当前节点…"; await queueOnlyCurrentNode(node); });
	size.addEventListener("click", () => openPopup(node, "size", size)); model.addEventListener("click", () => openPopup(node, "model", model)); settings.addEventListener("click", () => openPopup(node, "params", settings));
	const syncSeed = () => { const enabled = Boolean(value(node, "randomize_seed", true)); seed.classList.toggle("active", enabled); seed.title = enabled ? "随机种子已开启" : "随机种子已关闭"; }; seed.addEventListener("click", () => { setValue(node, "randomize_seed", !Boolean(value(node, "randomize_seed", true))); syncSeed(); }); syncSeed();
}
function stabilize(node) {
	if (String(node?.comfyClass || node?.type || "") !== NODE_TYPE) return;
	node.color = "#2b727e"; node.bgcolor = "#11191d"; node.boxcolor = "#6eb6c0"; hideBackendWidgets(node); createPanel(node); node.size = [Math.max(420, Number(node.size?.[0] || 420)), 292]; app.graph?.setDirtyCanvas?.(true, true);
}
app.registerExtension({
	name: "Comfy.GJJ.MiniMaxH3Studio",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;
		const created = nodeType.prototype.onNodeCreated; nodeType.prototype.onNodeCreated = function (...args) { const result = created?.apply(this, args); setTimeout(() => stabilize(this), 0); setTimeout(() => stabilize(this), 100); return result; };
		const configured = nodeType.prototype.onConfigure; nodeType.prototype.onConfigure = function (...args) { const result = configured?.apply(this, args); setTimeout(() => stabilize(this), 0); setTimeout(() => stabilize(this), 100); return result; };
		const connections = nodeType.prototype.onConnectionsChange; nodeType.prototype.onConnectionsChange = function (...args) { const result = connections?.apply(this, args); setTimeout(() => stabilize(this), 0); return result; };
		const removed = nodeType.prototype.onRemoved; nodeType.prototype.onRemoved = function (...args) { cleanup(this); return removed?.apply(this, args); };
		const executed = nodeType.prototype.onExecuted; nodeType.prototype.onExecuted = function (message) { const result = executed?.apply(this, arguments); if (this.__gjjMiniMaxPanel) this.__gjjMiniMaxPanel.status.textContent = `${message?.mode?.[0] || "视频"} 已完成`; return result; };
	},
	setup() {
		api.addEventListener("gjj_node_progress", (event) => { const detail = event?.detail || {}; for (const node of app.graph?._nodes || []) if (String(node?.comfyClass) === NODE_TYPE && String(node.id) === String(detail.node) && node.__gjjMiniMaxPanel) node.__gjjMiniMaxPanel.status.textContent = String(detail.text || "处理中…"); });
		window.addEventListener("pointerdown", (event) => { if (event.target?.closest?.(".gjj-mh3-pop,.gjj-mh3-btn")) return; for (const node of app.graph?._nodes || []) if (String(node?.comfyClass) === NODE_TYPE) closePopups(node); }, true);
	},
});
