import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";
import { setGjjLibraryThumbnail } from "./gjj_library_thumbnails.js";

const NODE = "GJJ_MTVAudioToPrompt";
const USER_SETTINGS_ENDPOINT = "/gjj/user_settings";
const SHARED_PROMPT_SECTION = "mtv_ltx_prompt_bridge";
const LIBRARY_CONFIG = {
	actor: { icon: "👤", title: "角色库", endpoint: "/gjj/character_library/list?summary=1", key: "characters", widget: "selected_actors_json", marker: "@" },
	scene: { icon: "🏕️", title: "场景库", endpoint: "/gjj/scene_library/thumbnail_index", key: "scenes", widget: "selected_scenes_json", marker: "🏕️" },
};
const COMPACT_HEIGHT = 150;
const STATUS_HEIGHT = 24;
const PREVIEW_HEIGHT = 190;
const PANELS = {
	"🧠": {
		title: "🧠 所用模型树",
		modelTree: true,
		fields: [],
		intro: "音乐音频 → Mel-Band RoFormer 人声/背景音乐分离 → SRT 时间分段 → Qwen3.5 音频理解 → MTV / LTX 场景提示词",
	},
	"⏰": {
		title: "⏰ 分段与时间",
		fields: ["min_segment_seconds", "max_segment_seconds", "current_segment", "fps", "boundary_fade_seconds", "alignment_model"],
		intro: "歌词与气口边界优先；再按所选视频模型的合法帧数向较短方向吸附断点。WAN=4n+1、LTX=8n+1、MinimaxH3=17n+5，不再在分段末尾补帧。",
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
			["reference_feature_instruction", "参考图特征提取指令"],
			["segment_request_template", "分镜完整请求模板"],
			["singing_segment_context", "有人声分段附加约束"],
			["silent_segment_context", "无人声分段附加模板"],
			["silent_intro_context", "无人声片头约束"],
			["silent_transition_context", "无人声过场约束"],
			["silent_outro_context", "无人声片尾约束"],
			["silent_lyrics_context", "无人声歌词上下文模板"],
			["reference_identity_context", "参考人物一致性模板"],
			["selected_scene_rule", "已选场景标记规则"],
			["unselected_scene_rule", "未选场景标记规则"],
			["actor_default_notes", "角色库默认约束"],
			["scene_default_notes", "场景库默认约束"],
		],
		intro: "所有发送给推理模型的指令都在此处管理。完整请求模板支持 {instruction}、{start}、{end}、{duration}、{lyrics}、{reference_context}、{segment_context}、{actor_library}、{scene_library}、{assigned_scenes}、{assigned_actors}、{previous_storyboard}、{next_scenes}、{next_actors}、{scene_marker_rule}。",
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

function mediaWidget(node) { return widget(node, "media_file"); }
function audioInputIndex(node) { return node.inputs?.findIndex((input) => input?.name === "audio") ?? -1; }

async function uploadMedia(file) {
	let lastError;
	for (const endpoint of ["/upload/image", "/api/upload/image"]) {
		const form = new FormData();
		form.append("image", file, file.name); form.append("type", "input"); form.append("overwrite", "true");
		try {
			const response = await fetch(api?.apiURL ? api.apiURL(endpoint) : endpoint, { method: "POST", body: form });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const data = await response.json().catch(() => ({}));
			const name = data?.name || data?.filename || file.name;
			return data?.subfolder ? `${data.subfolder}/${name}` : name;
		} catch (error) { lastError = error; }
	}
	throw lastError || new Error("上传失败");
}

function updateSourceButtons(node) {
	const media = String(mediaWidget(node)?.value || "").trim();
	node.__gjjMtvFileButton?.classList.toggle("gjj-mtv-file-active", Boolean(media));
	if (node.__gjjMtvFileButton) node.__gjjMtvFileButton.title = media ? `已选择：${media}` : "选择音频或视频（视频仅取音轨）";
	const index = audioInputIndex(node);
	const linked = index >= 0 && node.inputs?.[index]?.link != null;
	const paused = Boolean(node.properties?.gjj_mtv_audio_link);
	if (node.__gjjMtvLinkButton) {
		node.__gjjMtvLinkButton.style.display = linked || paused ? "" : "none";
		node.__gjjMtvLinkButton.classList.toggle("gjj-mtv-link-paused", paused && !linked);
		node.__gjjMtvLinkButton.title = linked ? "记住上游接口并断开" : "恢复已记住的上游接口";
	}
}

function toggleAudioLink(node) {
	const index = audioInputIndex(node); if (index < 0) return;
	const linkId = node.inputs?.[index]?.link;
	if (linkId != null) {
		const link = node.graph?.links?.[linkId];
		if (link) { node.properties ||= {}; node.properties.gjj_mtv_audio_link = { origin_id: link.origin_id, origin_slot: link.origin_slot }; }
		node.disconnectInput?.(index);
	} else {
		const saved = node.properties?.gjj_mtv_audio_link;
		const origin = saved && node.graph?.getNodeById?.(saved.origin_id);
		if (origin) origin.connect?.(saved.origin_slot, node, index);
		if (node.inputs?.[index]?.link != null) delete node.properties.gjj_mtv_audio_link;
	}
	node.graph?.change?.(); updateSourceButtons(node);
}

function chooseMedia(node) {
	const input = document.createElement("input");
	input.type = "file"; input.accept = "audio/*,video/*,.wav,.mp3,.flac,.m4a,.aac,.ogg,.opus,.mp4,.mov,.mkv,.webm,.avi,.m4v";
	input.onchange = async () => {
		const file = input.files?.[0]; if (!file) return;
		try {
			setLiveStatus(node, `正在上传 ${file.name}…`);
			const value = await uploadMedia(file); const target = mediaWidget(node);
			if (target) { target.value = value; target.callback?.(value); }
			saveWidgetValues(node); node.graph?.change?.(); updateSourceButtons(node);
			setLiveStatus(node, `已选择：${file.name}`, 3500);
		} catch (error) { setLiveStatus(node, `素材打开失败：${error?.message || error}`, 6000); }
	};
	input.click();
}

function librarySelection(node, kind) {
	try {
		const value = JSON.parse(String(widget(node, LIBRARY_CONFIG[kind].widget)?.value || "[]"));
		return Array.isArray(value) ? value : [];
	} catch (_) { return []; }
}

function libraryName(item) {
	return String(item?.display_name || item?.name || item?.title || item?.id || "").replace(/^\s*[♀♂]\ufe0f?\s*/, "").trim();
}

function saveLibrarySelection(node, kind, values) {
	const target = widget(node, LIBRARY_CONFIG[kind].widget);
	const text = JSON.stringify(values.map((item) => ({ id: String(item?.id || libraryName(item)), name: libraryName(item), notes: String(item?.notes || "") })));
	if (target) { target.value = text; target.callback?.(text); }
	saveWidgetValues(node); node.graph?.change?.(); updateLibraryButtons(node);
}

let activeLibraryPreview = null;
function closeLibraryPreview() {
	activeLibraryPreview?.remove(); activeLibraryPreview = null;
}

function showLibraryPreview(owner, kind, item, marker) {
	closeLibraryPreview(); if (!owner || !item) return;
	const preview = document.createElement("div"); preview.className = "gjj-mtv-library-preview";
	const image = document.createElement("img"); setGjjLibraryThumbnail(image, api, kind === "scene" ? "scene" : "character", item);
	const caption = document.createElement("div");
	const notes = String(item?.notes || "").replace(/\s+/g, " ").trim();
	caption.textContent = `${marker}${libraryName(item)}${notes ? `（${notes}）` : ""}`;
	preview.append(image, caption); document.body.appendChild(preview);
	const rect = owner.getBoundingClientRect();
	preview.style.left = `${Math.max(8, Math.min(innerWidth - 300, rect.right + 8))}px`;
	preview.style.top = `${Math.max(8, Math.min(innerHeight - 390, rect.top))}px`;
	activeLibraryPreview = preview;
}

function updateLibraryButtons(node) {
	for (const kind of Object.keys(LIBRARY_CONFIG)) {
		const control = node[`__gjjMtv${kind}Button`]; if (!control) continue;
		const selected = librarySelection(node, kind); const count = selected.length;
		control.replaceChildren();
		if (count) {
			const image = document.createElement("img");
			setGjjLibraryThumbnail(image, api, kind === "scene" ? "scene" : "character", selected[0]);
			const badge = document.createElement("span"); badge.className = "gjj-mtv-library-count"; badge.textContent = String(count);
			control.append(image, badge);
			control.onmouseenter = () => showLibraryPreview(control, kind, selected[0], LIBRARY_CONFIG[kind].marker);
			control.onmouseleave = closeLibraryPreview;
		} else {
			control.textContent = LIBRARY_CONFIG[kind].icon; control.onmouseenter = null; control.onmouseleave = null;
		}
		control.classList.toggle("gjj-mtv-library-active", count > 0);
		control.title = count ? `已选择 ${count} 个${LIBRARY_CONFIG[kind].title}项目；悬停预览，点击修改` : `从${LIBRARY_CONFIG[kind].title}选择`;
	}
}

async function openLibraryPicker(node, kind) {
	closeLibraryPreview(); document.querySelector(".gjj-mtv-library-modal")?.remove();
	const config = LIBRARY_CONFIG[kind];
	const response = await api.fetchApi(config.endpoint); const data = await response.json();
	if (!response.ok || data?.ok === false) throw new Error(data?.error || `读取${config.title}失败`);
	const items = Array.isArray(data?.[config.key]) ? data[config.key] : [];
	let selected = librarySelection(node, kind); const selectedIds = () => new Set(selected.map((item) => String(item.id || item.name)));
	const modal = document.createElement("div"); modal.className = "gjj-mtv-modal gjj-mtv-library-modal";
	const close = document.createElement("button"); close.className = "gjj-mtv-close"; close.textContent = "确定"; close.onclick = () => { closeLibraryPreview(); modal.remove(); };
	const title = document.createElement("h2"); title.textContent = `${config.icon} ${config.title}（可多选）`;
	const search = document.createElement("input"); search.placeholder = "搜索名称或备注"; search.style.cssText = "width:100%;box-sizing:border-box;padding:7px;background:#0b1114;color:#fff;border:1px solid #40515a;border-radius:6px";
	const list = document.createElement("div"); list.className = "gjj-mtv-library-grid";
	const render = () => {
		closeLibraryPreview(); list.replaceChildren(); const ids = selectedIds(); const query = search.value.trim().toLocaleLowerCase();
		for (const item of items.filter((value) => !query || `${libraryName(value)} ${value?.notes || ""}`.toLocaleLowerCase().includes(query))) {
			const id = String(item?.id || libraryName(item)); const card = document.createElement("button"); card.type = "button";
			card.className = `gjj-mtv-library-card${ids.has(id) ? " active" : ""}`; card.title = String(item?.notes || libraryName(item));
			const image = document.createElement("img"); setGjjLibraryThumbnail(image, api, kind === "scene" ? "scene" : "character", item);
			const name = document.createElement("span"); name.textContent = `${config.marker}${libraryName(item)}`; card.append(image, name);
			card.onmouseenter = () => showLibraryPreview(card, kind, item, config.marker);
			card.onmouseleave = closeLibraryPreview;
			card.onclick = () => { selected = ids.has(id) ? selected.filter((entry) => String(entry.id || entry.name) !== id) : [...selected, item]; saveLibrarySelection(node, kind, selected); render(); };
			list.append(card);
		}
	};
	search.oninput = render; modal.append(close, title, search, list); document.body.appendChild(modal); render();
}

function addStyles() {
	if (document.getElementById("gjj-mtv-prompt-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-mtv-prompt-style";
	style.textContent = `
		.gjj-mtv-toolbar{display:flex;gap:7px;align-items:center;padding:3px 1px}
		.gjj-mtv-toolbar button{font-size:19px;line-height:28px;width:40px;height:32px;border:1px solid #52616a;border-radius:8px;background:#172126;color:#fff;cursor:pointer}
		.gjj-mtv-toolbar button:hover{background:#2c414a}
		.gjj-mtv-toolbar button.gjj-mtv-file-active{background:#315f48;border-color:#79d49d;box-shadow:0 0 0 1px #79d49d55 inset}
		.gjj-mtv-toolbar button.gjj-mtv-link-paused{background:#5d4927;border-color:#e8b65c}
		.gjj-mtv-toolbar button.gjj-mtv-library-active{background:#3b315f;border-color:#aa91ef}
		.gjj-mtv-toolbar button.gjj-mtv-library-active{position:relative;overflow:hidden;padding:0}.gjj-mtv-toolbar button.gjj-mtv-library-active>img{display:block;width:100%;height:100%;object-fit:cover}.gjj-mtv-library-count{position:absolute;right:1px;bottom:0;min-width:13px;height:13px;border-radius:7px;background:#0b171bde;color:#fff;font:9px/13px system-ui;text-align:center}
		.gjj-mtv-library-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));align-content:start;gap:5px;margin-top:9px}
		.gjj-mtv-library-card{position:relative;height:88px;padding:0;overflow:hidden;border:1px solid #40515a;border-radius:6px;background:#091114;color:#fff;cursor:pointer}
		.gjj-mtv-library-card:hover,.gjj-mtv-library-card.active{outline:2px solid #6fc696;outline-offset:-2px}.gjj-mtv-library-card.active{background:#244b39}
		.gjj-mtv-library-card.active:after{content:"✓";position:absolute;right:5px;top:2px;color:#9be0b5;font-weight:900;text-shadow:0 1px 2px #000}
		.gjj-mtv-library-card img{display:block;width:100%;height:100%;object-fit:cover;background:#091114}.gjj-mtv-library-card span{position:absolute;left:0;right:0;bottom:0;padding:15px 3px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:linear-gradient(transparent,rgba(0,0,0,.9));font-size:10px;font-weight:800;text-align:center;text-shadow:0 1px 2px #000}
		.gjj-mtv-library-preview{position:fixed;z-index:10030;width:280px;max-height:380px;padding:7px;border:1px solid #628278;border-radius:9px;background:#0d171b;color:#eaf6f1;box-shadow:0 16px 38px #000a;pointer-events:none;font:12px/1.4 system-ui}
		.gjj-mtv-library-preview img{display:block;width:100%;max-height:320px;object-fit:contain;border-radius:6px;background:#071014}.gjj-mtv-library-preview div{padding:6px 3px 1px;overflow-wrap:anywhere}
		.gjj-mtv-prompt-preview{display:none;margin:5px 2px 0;padding:7px;height:170px;box-sizing:border-box;overflow:auto;border:1px solid #40545d;border-radius:6px;background:#0d1519;color:#cfe1e5;font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word;user-select:text}
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
	const entry = (name, label, folder, icon, description) => {
		const item = widget(node, name);
		return {
			widget: name,
			label,
			folder,
			icon,
			models: GJJ_Utils._modelTreeWidgetChoices(item),
			missingDefault: item?.options?.modelTreeMissingDefault === true,
			searchValue: (_entry, source) => GJJ_Utils._modelTreeFamilyStem(source?.value),
			fallback: String(item?.value || ""),
			description,
		};
	};
	return [
		entry("separator_model", "人声分离模型", "models/diffusion_models", "🎵", "对整段音乐执行人声与背景音乐分离。"),
		entry("text_model", "音频理解与提示词模型", "models/text_encoders", "🧠", "逐段生成参考画面与 LTX 视频提示词。"),
		entry("asr_model_name", "Qwen3 ASR 模型", "models/ASR", "🎤", "SRT 留空且使用本地素材时识别歌词。"),
		entry("aligner_model_name", "Qwen3 强制对齐模型", "models/ASR", "⏱️", "将识别歌词对齐至音乐时间轴并生成同步 SRT。"),
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

function removeForeignAsrPanel(node) {
	const index = node.widgets?.findIndex((item) => item?.name === "__gjj_qwen3_asr_panel") ?? -1;
	if (index >= 0) {
		const foreign = node.widgets[index];
		foreign?.element?.remove?.(); foreign?.inputEl?.remove?.();
		node.widgets.splice(index, 1);
	}
	node.__gjjQwen3Panel?.root?.remove?.();
	delete node.__gjjQwen3Panel;
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
	resizeMtvNode(node);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
	if (message && autoHideMs > 0) {
		node.__gjjMtvStatusTimer = setTimeout(() => setLiveStatus(node, ""), autoHideMs);
	}
}

function resizeMtvNode(node) {
	const hasStatus = node?.__gjjMtvStatus?.style.display !== "none";
	const hasPreview = node?.__gjjMtvPreview?.style.display !== "none";
	node?.setSize?.([Math.max(390, Number(node?.size?.[0] || 0)), COMPACT_HEIGHT + (hasStatus ? STATUS_HEIGHT : 0) + (hasPreview ? PREVIEW_HEIGHT : 0)]);
	node?.setDirtyCanvas?.(true, true); app.graph?.setDirtyCanvas?.(true, true);
}

function setPromptPreview(node, text, completed = 0, total = 0) {
	const preview = node?.__gjjMtvPreview; if (!preview) return;
	const value = String(text || "").trim();
	preview.textContent = value;
	preview.title = total > 0 ? `已完成 ${completed}/${total} 段` : "分镜提示词实时预览";
	preview.style.display = value ? "block" : "none";
	if (value) requestAnimationFrame(() => { preview.scrollTop = preview.scrollHeight; });
	resizeMtvNode(node);
}

app.registerExtension({
	name: "GJJ.MTVAudioToPrompt",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE) return;
		const original = nodeType.prototype.onNodeCreated;
		const connectionsChanged = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = connectionsChanged?.apply(this, args);
			queueMicrotask(() => updateSourceButtons(this));
			return result;
		};
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = original?.apply(this, args);
			removeForeignAsrPanel(this);
			addStyles();
			hideNativeWidgets(this);
			restoreWidgetValues(this);
			const root = document.createElement("div");
			const bar = document.createElement("div");
			bar.className = "gjj-mtv-toolbar";
			const fileButton = document.createElement("button");
			fileButton.textContent = "📁";
			fileButton.onclick = () => chooseMedia(this);
			bar.appendChild(fileButton);
			this.__gjjMtvFileButton = fileButton;
			for (const kind of ["actor", "scene"]) {
				const control = document.createElement("button"); control.textContent = LIBRARY_CONFIG[kind].icon;
				control.onclick = () => openLibraryPicker(this, kind).catch((error) => setLiveStatus(this, error?.message || error, 6000));
				bar.appendChild(control); this[`__gjjMtv${kind}Button`] = control;
			}
			for (const [emoji, definition] of Object.entries(PANELS)) {
				const button = document.createElement("button");
				button.textContent = emoji;
				button.title = definition.title;
				button.onclick = () => openPanel(this, definition);
				bar.appendChild(button);
				if (emoji === "🧠") {
					const linkButton = document.createElement("button");
					linkButton.textContent = "🔗";
					linkButton.onclick = () => toggleAudioLink(this);
					bar.appendChild(linkButton);
					this.__gjjMtvLinkButton = linkButton;
				}
			}
			const status = document.createElement("div");
			status.style.cssText = "display:none;margin:2px 2px 0;padding:4px 7px;border-left:3px solid #55b8a7;border-radius:3px;background:#152329;color:#bfe1da;font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
			const preview = document.createElement("div"); preview.className = "gjj-mtv-prompt-preview";
			root.append(bar, status, preview);
			this.__gjjMtvStatus = status;
			this.__gjjMtvPreview = preview;
			this.addDOMWidget?.("gjj_mtv_toolbar", "HTML", root, { serialize: false });
			this.setSize?.([Math.max(390, this.size?.[0] || 0), COMPACT_HEIGHT]);
			updateSourceButtons(this);
			updateLibraryButtons(this);
			return result;
		};
		const configured = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = configured?.apply(this, args);
			removeForeignAsrPanel(this);
			hideNativeWidgets(this);
			restoreWidgetValues(this);
			setLiveStatus(this, "");
			setPromptPreview(this, "");
			updateSourceButtons(this);
			updateLibraryButtons(this);
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

api.addEventListener("gjj_mtv_prompt_preview", (event) => {
	const detail = event?.detail || {};
	const node = app.graph?._nodes?.find((item) => String(item?.id) === String(detail.node));
	if (!node || String(node.comfyClass || node.type || "") !== NODE) return;
	setPromptPreview(node, detail.text, detail.completed, detail.total);
});

api.addEventListener("execution_error", (event) => {
	const detail = event?.detail || {};
	const nodeId = detail.node_id ?? detail.node;
	const node = app.graph?._nodes?.find((item) => String(item?.id) === String(nodeId));
	if (!node || String(node.comfyClass || node.type || "") !== NODE) return;
	setLiveStatus(node, "执行失败，请查看错误信息", 6000);
});
