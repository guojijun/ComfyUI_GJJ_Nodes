import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const NODE = "GJJ_MTVAudioToPrompt";
const USER_SETTINGS_ENDPOINT = "/gjj/user_settings";
const SHARED_PROMPT_SECTION = "mtv_ltx_prompt_bridge";
const COMPACT_HEIGHT = 150;
const STATUS_HEIGHT = 24;
const PANELS = {
	"🧠": {
		title: "🧠 所用模型树",
		modelTree: true,
		fields: [],
		intro: "音乐音频 → Mel-Band RoFormer 人声/背景音乐分离 → SRT 时间分段 → Qwen3.5 音频理解 → MTV / LTX 场景提示词",
	},
	"⏰": {
		title: "⏰ 分段与时间",
		fields: ["min_segment_seconds", "max_segment_seconds", "current_segment", "fps", "boundary_fade_seconds"],
		intro: "歌词边界优先：多句歌词超过最长目标时在句间拆分，单句自身过长才延长；同时检测真实人声区间，约 1 秒以上的纯音乐前奏、间奏和尾奏会独立成为无人空镜。",
	},
	"📢": {
		title: "📢 音频参数",
		fields: ["vocal_threshold_db", "target_lufs"],
		intro: "整段音频只分离一次。无人声段输出等长静音；完整背景音乐不切段，直接用于后期混音。",
	},
	"📒": {
		title: "📒 提示词参数",
		fields: ["max_tokens", "temperature", "seed", "keep_model"],
		sharedFields: [
			["prompt_instruction", "有人声提示词模板"],
			["empty_prompt_instruction", "无人声提示词模板"],
			["vocal_image_prompt", "有人声图片提示（闭嘴、特写）"],
			["vocal_ltx_prompt", "有人声 LTX 替换（开口、运镜）"],
		],
		intro: "每个分段单独生成一条提示词，最终严格用“换行 --- 换行”连接。",
	},
};

async function readSharedPrompts() {
	const response = await api.fetchApi(USER_SETTINGS_ENDPOINT);
	const data = await response.json();
	return data?.settings?.[SHARED_PROMPT_SECTION] || {};
}

async function writeSharedPrompt(name, value) {
	await api.fetchApi(USER_SETTINGS_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ section: SHARED_PROMPT_SECTION, values: { [name]: value } }),
	});
}

function sharedPromptEditor(name, labelText, value) {
	const row = document.createElement("label");
	row.className = "gjj-mtv-row";
	const label = document.createElement("span");
	label.textContent = labelText;
	const input = document.createElement("textarea");
	input.value = value ?? "";
	input.addEventListener("change", async () => {
		await writeSharedPrompt(name, input.value);
	});
	row.append(label, input);
	return row;
}

function widget(node, name) {
	return node.widgets?.find((item) => item?.name === name);
}

function addStyles() {
	if (document.getElementById("gjj-mtv-prompt-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-mtv-prompt-style";
	style.textContent = `
		.gjj-mtv-toolbar{display:flex;gap:7px;align-items:center;padding:3px 1px}
		.gjj-mtv-toolbar button{font-size:19px;line-height:28px;width:40px;height:32px;border:1px solid #52616a;border-radius:8px;background:#172126;color:#fff;cursor:pointer}
		.gjj-mtv-toolbar button:hover{background:#2c414a}
		.gjj-mtv-modal{position:fixed;z-index:10020;left:50%;top:50%;transform:translate(-50%,-50%);width:min(620px,90vw);max-height:82vh;overflow:auto;background:#111a1f;color:#e9f3f6;border:1px solid #59707a;border-radius:12px;box-shadow:0 20px 70px #000c;padding:16px;font:13px system-ui}
		.gjj-mtv-modal h2{margin:0 0 8px;font-size:18px}.gjj-mtv-modal p{color:#aebfc6;line-height:1.5}
		.gjj-mtv-row{display:grid;grid-template-columns:150px 1fr;gap:10px;align-items:center;margin:10px 0}
		.gjj-mtv-row input,.gjj-mtv-row select,.gjj-mtv-row textarea{box-sizing:border-box;width:100%;background:#0b1114;color:#fff;border:1px solid #40515a;border-radius:6px;padding:7px}
		.gjj-mtv-row textarea{min-height:120px;resize:vertical}.gjj-mtv-close{float:right;background:#34464e;color:#fff;border:0;border-radius:6px;padding:5px 10px;cursor:pointer}
	`;
	document.head.appendChild(style);
}

function editorFor(node, name) {
	const source = widget(node, name);
	if (!source) return null;
	const row = document.createElement("label");
	row.className = "gjj-mtv-row";
	const label = document.createElement("span");
	label.textContent = source.label || name;
	let input;
	if (Array.isArray(source.options?.values)) {
		input = document.createElement("select");
		for (const value of source.options.values) {
			const option = document.createElement("option");
			option.value = value; option.textContent = value; input.appendChild(option);
		}
		input.value = source.value;
	} else if (typeof source.value === "boolean") {
		input = document.createElement("input"); input.type = "checkbox"; input.checked = source.value;
	} else if (String(source.value || "").includes("\n") || name.includes("instruction")) {
		input = document.createElement("textarea"); input.value = source.value ?? "";
	} else {
		input = document.createElement("input");
		input.type = typeof source.value === "number" ? "number" : "text";
		input.value = source.value ?? "";
		input.step = source.options?.step || "any";
	}
	input.addEventListener("change", () => {
		source.value = input.type === "checkbox" ? input.checked
			: (typeof source.value === "number" ? Number(input.value) : input.value);
		source.callback?.(source.value);
		node.setDirtyCanvas?.(true, true);
		saveWidgetValues(node);
	});
	row.append(label, input);
	return row;
}

function modelTreeEntries(node) {
	const textModel = widget(node, "text_model");
	const separatorModel = widget(node, "separator_model");
	return [
		{
			widget: "separator_model",
			label: "人声分离模型",
			folder: "models/diffusion_models",
			icon: "🎵",
			anyKeywords: ["melband", "roformer", "vocal"],
			searchValue: String(separatorModel?.value || "MelBandRoformer"),
			fallback: String(separatorModel?.value || "MelBandRoformer_fp16.safetensors"),
			description: "先对整段音乐执行人声与背景音乐分离；背景音乐保持整段输出。",
		},
		{
			widget: "text_model",
			label: "音频理解与提示词模型",
			folder: "models/text_encoders",
			icon: "🧠",
			anyKeywords: ["qwen3.5", "qwen35"],
			searchValue: String(textModel?.value || "Qwen3.5-4B-Uncensored"),
			fallback: String(textModel?.value || "Qwen3.5-4B-Uncensored-FP8_E4M3FN.safetensors"),
			description: "通过 GJJ_GemmaTextGenerate 音频理解流程，逐段生成参考画面与 LTX 视频提示词。",
		},
	];
}

function appendModelTree(node, panel) {
	const tree = GJJ_Utils.createModelTreeView({
		node,
		entries: modelTreeEntries(node),
		refresh: () => {
			node.graph?.change?.();
			app.graph?.setDirtyCanvas?.(true, true);
		},
		onApply: () => {
			node.graph?.change?.();
			app.graph?.setDirtyCanvas?.(true, true);
			saveWidgetValues(node);
		},
	});
	tree.style.maxHeight = "430px";
	panel.appendChild(tree);
}

function openPanel(node, definition) {
	document.querySelector(".gjj-mtv-modal")?.remove();
	const panel = document.createElement("div");
	panel.className = "gjj-mtv-modal";
	const close = document.createElement("button");
	close.className = "gjj-mtv-close"; close.textContent = "关闭"; close.onclick = () => panel.remove();
	const title = document.createElement("h2"); title.textContent = definition.title;
	const intro = document.createElement("p"); intro.textContent = definition.intro;
	panel.append(close, title, intro);
	if (definition.modelTree) appendModelTree(node, panel);
	for (const name of definition.fields) {
		const row = editorFor(node, name);
		if (row) panel.appendChild(row);
	}
	if (definition.sharedFields?.length) {
		readSharedPrompts().then((values) => {
			for (const [name, label] of definition.sharedFields) {
				panel.appendChild(sharedPromptEditor(name, label, values[name]));
			}
		}).catch((error) => {
			const message = document.createElement("p");
			message.textContent = `读取共享提示词失败：${error?.message || error}`;
			panel.appendChild(message);
		});
	}
	document.body.appendChild(panel);
}

function hideNativeWidgets(node) {
	for (const item of node.widgets || []) {
		if (!["audio", "srt"].includes(item.name) && item.name !== "gjj_mtv_toolbar") {
			item.hidden = true;
			item.computeSize = () => [0, -4];
		}
	}
}

function restoreWidgetValues(node) {
	const saved = node?.properties?.gjj_mtv_values;
	if (!saved || typeof saved !== "object") return;
	for (const item of node.widgets || []) {
		if (!item || !item.name) continue;
		const savedValue = saved[item.name];
		if (savedValue === undefined) continue;
		if (typeof item.value === "number" && typeof savedValue === "number") {
			item.value = savedValue;
		} else if (typeof item.value === "boolean" && typeof savedValue === "boolean") {
			item.value = savedValue;
		} else if (typeof item.value === "string") {
			item.value = String(savedValue);
		} else {
			item.value = savedValue;
		}
		if (item.inputEl && "value" in item.inputEl) {
			item.inputEl.value = item.value;
		}
		if (item.element && "value" in item.element) {
			item.element.value = item.value;
		}
	}
}

function saveWidgetValues(node) {
	const values = {};
	for (const item of node.widgets || []) {
		if (!item || !item.name) continue;
		if (["audio", "srt", "gjj_mtv_toolbar"].includes(item.name)) continue;
		values[item.name] = item.value;
	}
	node.properties ||= {};
	node.properties.gjj_mtv_values = values;
}

function setLiveStatus(node, text, autoHideMs = 0) {
	const status = node?.__gjjMtvStatus;
	if (!status) return;
	clearTimeout(node.__gjjMtvStatusTimer);
	const message = String(text || "").trim();
	status.textContent = message;
	status.title = message;
	status.style.display = message ? "block" : "none";
	node.setSize?.([
		Math.max(390, Number(node.size?.[0] || 0)),
		message ? COMPACT_HEIGHT + STATUS_HEIGHT : COMPACT_HEIGHT,
	]);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
	if (message && autoHideMs > 0) {
		node.__gjjMtvStatusTimer = setTimeout(() => setLiveStatus(node, ""), autoHideMs);
	}
}

app.registerExtension({
	name: "GJJ.MTVAudioToPrompt",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE) return;
		const original = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = original?.apply(this, args);
			addStyles();
			hideNativeWidgets(this);
			restoreWidgetValues(this);
			const root = document.createElement("div");
			const bar = document.createElement("div");
			bar.className = "gjj-mtv-toolbar";
			for (const [emoji, definition] of Object.entries(PANELS)) {
				const button = document.createElement("button");
				button.textContent = emoji;
				button.title = definition.title;
				button.onclick = () => openPanel(this, definition);
				bar.appendChild(button);
			}
			const status = document.createElement("div");
			status.style.cssText = "display:none;margin:2px 2px 0;padding:4px 7px;border-left:3px solid #55b8a7;border-radius:3px;background:#152329;color:#bfe1da;font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
			root.append(bar, status);
			this.__gjjMtvStatus = status;
			this.addDOMWidget?.("gjj_mtv_toolbar", "HTML", root, { serialize: false });
			this.setSize?.([Math.max(390, this.size?.[0] || 0), COMPACT_HEIGHT]);
			return result;
		};
		const configured = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = configured?.apply(this, args);
			hideNativeWidgets(this);
			restoreWidgetValues(this);
			setLiveStatus(this, "");
			return result;
		};
	},
});

api.addEventListener("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const node = app.graph?._nodes?.find((item) => String(item?.id) === String(detail.node));
	if (!node || String(node.comfyClass || node.type || "") !== NODE) return;
	const text = String(detail.text || "");
	setLiveStatus(node, text, /^4\/4\s/.test(text) ? 5000 : 0);
});

api.addEventListener("execution_error", (event) => {
	const detail = event?.detail || {};
	const nodeId = detail.node_id ?? detail.node;
	const node = app.graph?._nodes?.find((item) => String(item?.id) === String(nodeId));
	if (!node || String(node.comfyClass || node.type || "") !== NODE) return;
	setLiveStatus(node, "执行失败，请查看错误信息", 6000);
});
