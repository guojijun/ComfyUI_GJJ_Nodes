import { app } from "/scripts/app.js";

const NODE_NAME = "GJJ_WanAnimate2LongVideoAIO";
const TOOLBAR = "gjj_wan_animate2_toolbar";
const KEEP = new Set(["prompt", TOOLBAR]);
const GROUPS = {
	size: { title: "📐 尺寸与分段", fields: ["width", "height", "segment_frames", "overlap_frames"] },
	prompt: { title: "✍️ 提示词", fields: ["negative_prompt", "pose_prompt"] },
	model: { title: "🧠 模型", fields: ["unet_name", "lora_name", "clip_name", "clip_vision_name", "vae_name"] },
	settings: { title: "⚙️ 生成参数", fields: ["steps", "cfg", "seed", "pose_strength", "reference_strength", "filename_prefix"] },
};
const BUTTONS = [
	["size", "📐", "尺寸与分段"], ["prompt", "✍️", "负向/动作提示词"],
	["model", "🧠", "模型"], ["settings", "⚙️", "生成参数"], ["run", "▶", "执行当前节点"],
];

function widget(node, name) {
	return (node.widgets || []).find((item) => String(item?.name || "") === name);
}

function hideWidgets(node) {
	for (const item of node.widgets || []) {
		if (KEEP.has(String(item?.name || ""))) continue;
		item.hidden = true;
		item.type = "hidden";
		item.serialize = true;
		item.computeSize = () => [0, -4];
	}
	const prompt = widget(node, "prompt");
	if (prompt) {
		prompt.hidden = false;
		prompt.serialize = true;
		prompt.label = "正向提示词";
		prompt.computeSize = (width) => [Math.max(260, Number(width || 260)), 72];
		prompt.getHeight = () => 72;
	}
}

function styleInput(element) {
	element.style.cssText = "width:100%;box-sizing:border-box;background:#172126;color:#edf5f7;border:1px solid #40545e;border-radius:5px;padding:7px 8px;outline:none;";
}

function editorFor(item) {
	const values = item?.options?.values;
	let input;
	if (Array.isArray(values)) {
		input = document.createElement("select");
		for (const value of values) {
			const option = document.createElement("option");
			option.value = String(value); option.textContent = String(value);
			input.appendChild(option);
		}
		input.value = String(item.value ?? "");
	} else if (typeof item?.value === "number") {
		input = document.createElement("input"); input.type = "number";
		for (const key of ["min", "max", "step"]) if (item.options?.[key] != null) input[key] = item.options[key];
		input.value = String(item.value);
	} else if (item?.options?.multiline) {
		input = document.createElement("textarea"); input.rows = 4; input.value = String(item.value ?? "");
	} else {
		input = document.createElement("input"); input.type = "text"; input.value = String(item?.value ?? "");
	}
	styleInput(input);
	return input;
}

function openDialog(node, group) {
	const overlay = document.createElement("div");
	overlay.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center;padding:20px;";
	const panel = document.createElement("div");
	panel.style.cssText = "width:min(620px,calc(100vw - 40px));max-height:calc(100vh - 50px);overflow:auto;background:#10191e;color:#e7f1f4;border:1px solid #40545e;border-radius:9px;padding:16px;box-shadow:0 18px 60px rgba(0,0,0,.5);";
	const title = document.createElement("div"); title.textContent = group.title; title.style.cssText = "font-size:17px;font-weight:700;margin-bottom:14px;";
	const grid = document.createElement("div"); grid.style.cssText = "display:grid;grid-template-columns:130px 1fr;gap:10px 12px;align-items:center;";
	const editors = [];
	for (const name of group.fields) {
		const item = widget(node, name); if (!item) continue;
		const label = document.createElement("label"); label.textContent = item.label || name;
		const input = editorFor(item); editors.push([item, input]); grid.append(label, input);
	}
	const actions = document.createElement("div"); actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:16px;";
	const cancel = document.createElement("button"); cancel.textContent = "取消";
	const save = document.createElement("button"); save.textContent = "确定";
	for (const button of [cancel, save]) button.style.cssText = "border:1px solid #526975;border-radius:5px;background:#263943;color:white;padding:7px 16px;cursor:pointer;";
	const close = () => overlay.remove(); cancel.onclick = close; overlay.onclick = (event) => { if (event.target === overlay) close(); };
	save.onclick = () => {
		for (const [item, input] of editors) {
			let value = input.value;
			if (typeof item.value === "number") value = Number(value);
			item.value = value; item.callback?.(value); item.onChange?.(value);
		}
		app.graph?.setDirtyCanvas?.(true, true); close();
	};
	actions.append(cancel, save); panel.append(title, grid, actions); overlay.appendChild(panel); document.body.appendChild(overlay);
}

function addToolbar(node) {
	if (widget(node, TOOLBAR) || typeof node.addDOMWidget !== "function") return;
	const row = document.createElement("div"); row.style.cssText = "height:36px;display:flex;align-items:center;gap:4px;padding-top:2px;box-sizing:border-box;";
	for (const [key, icon, title] of BUTTONS) {
		const button = document.createElement("button"); button.textContent = icon; button.title = title;
		button.style.cssText = "width:32px;height:30px;border:1px solid #50636c;border-radius:6px;background:#1c2b32;color:white;cursor:pointer;font-size:17px;";
		button.onclick = (event) => { event.preventDefault(); event.stopPropagation(); key === "run" ? app.queuePrompt?.(0, 1) : openDialog(node, GROUPS[key]); };
		row.appendChild(button);
	}
	const toolbar = node.addDOMWidget(TOOLBAR, "HTML", row, { serialize: false, getValue: () => "", setValue: () => {}, getHeight: () => 36 });
	toolbar.serialize = false; toolbar.computeSize = (width) => [Math.max(260, Number(width || 260)), 36]; toolbar.getHeight = () => 36;
	const promptIndex = (node.widgets || []).findIndex((item) => item.name === "prompt");
	const toolbarIndex = node.widgets.indexOf(toolbar);
	if (promptIndex >= 0 && toolbarIndex > promptIndex) { node.widgets.splice(toolbarIndex, 1); node.widgets.splice(promptIndex, 0, toolbar); }
}

function stabilize(node) {
	addToolbar(node); hideWidgets(node);
	const width = Math.max(360, Number(node.size?.[0] || 360));
	node.setSize?.([width, 180]); node.size = [width, 180];
	app.graph?.setDirtyCanvas?.(true, true);
}

app.registerExtension({
	name: "Comfy.GJJ.WanAnimate2LongVideoAIO.CompactPanel",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME || nodeType.prototype.__gjjWanAnimate2Compact) return;
		nodeType.prototype.__gjjWanAnimate2Compact = true;
		const created = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) { const result = created?.apply(this, args); setTimeout(() => stabilize(this), 0); setTimeout(() => stabilize(this), 150); return result; };
		const configured = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) { const result = configured?.apply(this, args); setTimeout(() => stabilize(this), 0); return result; };
	},
});
