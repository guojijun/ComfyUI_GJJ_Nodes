const comfyApi = window.comfyAPI || {};
const appModule = comfyApi.app || {};
const apiModule = comfyApi.api || {};
const app = appModule.app || window.app || appModule;
const api = apiModule.api || window.api || apiModule;

const TARGET = "GJJ_UniversalTTS";
const MAX_REFERENCES = 10;
const AUDIO_PREFIX = "reference_";
const SETTINGS_ENDPOINT = "/gjj/user_settings";
const IMPORT_MEDIA_ENDPOINT = "/gjj/universal_tts/import_media";
const CHECK_ENDPOINT = "/gjj/universal_tts/check";
const AUDIO_LIBRARY_ENDPOINT = "/gjj/universal_tts/audio_library";
const TERMS_ENDPOINT = "/gjj/universal_tts/terms";
const CHARACTER_LIBRARY_ENDPOINT = "/gjj/character_library/list";
const STATUS_WIDGET = "gjj_universal_tts_panel";
const TOOLBAR_WIDGET = "gjj_universal_tts_toolbar";
const AUDIO_WIDGET = "gjj_universal_tts_audio";
const LOCAL_AUDIO_SORT_MODES = new Set(["name_asc", "name_desc", "date_desc", "date_asc", "size_desc", "size_asc"]);
const QWEN_CUSTOM_VOICES = ["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"];
const QWEN_CUSTOM_VOICE_LABELS = {
	Vivian: "中文·普通话｜明亮年轻女声",
	Serena: "中文·普通话｜温暖温柔女声",
	Uncle_Fu: "中文·普通话｜成熟醇厚男声",
	Dylan: "中文·北京口音｜年轻男声",
	Eric: "中文·四川口音｜活力男声",
	Ryan: "英文｜节奏感男声",
	Aiden: "英文·美式｜阳光男声",
	Ono_Anna: "日文｜俏皮女声",
	Sohee: "韩文｜温暖女声",
};
let universalTTSPresetCache = null;
let universalTTSPresetPromise = null;
const MANAGED_PROPS = {
	keep_model_loaded: true,
	random_seed: false,
	settings_open: false,
	output_audio_mode: "整体合并",
	output_text_format: "SRT",
	detached_links: {},
	local_audio_order: [],
};

const cloneValue = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const COMMON_WIDGETS = new Set([
	"text", "open_file_button", "keep_model_loaded", "branch", "link_button", "random_seed",
	"local_audio_name", "audio_output_mode", "timeline_format", "settings_button", "generate_button",
	"model_name",
	"edge_voice", "custom_voice", "speed", "pitch", "language", "device",
	"precision", "steps", "guidance_strength", "pause_after_speaker", "seed",
	"audio_output_mode", "timeline_format", "mp3_filename_prefix", "mp3_quality", "fail_mode",
	"segment_min_chars", "segment_max_chars",
	"local_audio_order_json", "edge_speaker_voices_json", "tts_voice_orders_json",
	"qwen_max_new_tokens", "qwen_top_p", "qwen_top_k", "qwen_temperature", "qwen_repetition_penalty", "qwen_x_vector_only",
	"emotion_prompt", "audio_format", "qwen_instruct",
]);

const CORE_WIDGETS = new Set(["text"]);
const SETTINGS_COMMON_WIDGETS = new Set([
	"mp3_filename_prefix", "mp3_quality", "fail_mode", "segment_min_chars", "segment_max_chars", "audio_format",
]);
const PANEL_MANAGED_WIDGETS = new Set(["edge_speaker_voices_json", "tts_voice_orders_json"]);

const BRANCH_PRIVATE = {
	EdgeTTS: new Set(["speed", "pitch", "edge_speaker_voices_json"]),
	FishAudioS2: new Set(["model_name", "language", "device", "precision", "seed", "pause_after_speaker"]),
	"LongCat-1B": new Set(["model_name", "device", "precision", "steps", "guidance_strength", "seed", "pause_after_speaker"]),
	"LongCat3.5B": new Set(["model_name", "device", "precision", "steps", "guidance_strength", "seed", "pause_after_speaker"]),
	"Fun-CosyVoice3-0.5B-2512": new Set(["model_name", "speed", "seed"]),
	"Qwen3-CustomVoice": new Set(["model_name", "language", "device", "precision", "seed", "qwen_max_new_tokens", "qwen_top_p", "qwen_top_k", "qwen_temperature", "qwen_repetition_penalty"]),
	"Qwen3-VoiceDesign": new Set(["model_name", "qwen_instruct", "language", "device", "precision", "seed", "qwen_max_new_tokens", "qwen_top_p", "qwen_top_k", "qwen_temperature", "qwen_repetition_penalty"]),
	"Qwen3-VoiceClone": new Set(["model_name", "language", "device", "precision", "seed", "qwen_max_new_tokens", "qwen_top_p", "qwen_top_k", "qwen_temperature", "qwen_repetition_penalty", "qwen_x_vector_only"]),
	"IndexTTS-v1.5": new Set(["device", "precision", "seed"]),
	"IndexTTS-v1.0": new Set(["device", "precision", "seed"]),
	"IndexTTS-v2": new Set(["emotion_prompt", "device", "precision", "seed"]),
	VoxCPM2: new Set(["model_name", "emotion_prompt", "device", "steps", "guidance_strength", "seed", "pause_after_speaker"]),
};

const BRANCH_VALUES = Object.keys(BRANCH_PRIVATE);
const BRANCH_DISPLAY = {
	EdgeTTS: "🗣️ TTS · EdgeTTS",
	FishAudioS2: "🎙️ 克隆 · FishAudioS2",
	"LongCat-1B": "🎙️ 克隆 · LongCat-1B",
	"LongCat3.5B": "🎙️ 克隆 · LongCat3.5B",
	"Fun-CosyVoice3-0.5B-2512": "🎙️ 克隆 · Fun-CosyVoice3-0.5B-2512",
	"Qwen3-CustomVoice": "🗣️ TTS · Qwen3-CustomVoice",
	"Qwen3-VoiceDesign": "🗣️ TTS · Qwen3-VoiceDesign",
	"Qwen3-VoiceClone": "🎙️ 克隆 · Qwen3-VoiceClone",
	"IndexTTS-v1.5": "🎙️ 克隆 · IndexTTS-v1.5",
	"IndexTTS-v1.0": "🎙️ 克隆 · IndexTTS-v1.0",
	"IndexTTS-v2": "🎙️ 克隆 · IndexTTS-v2",
	VoxCPM2: "🎙️ 克隆/设计 · VoxCPM2",
};
const CHOICE_DEFAULTS = {
	branch: "EdgeTTS",
	model_name: "自动",
	edge_voice: "[中文] zh-CN Xiaoxiao 女声",
	language: "auto",
	device: "auto",
	precision: "auto",
	audio_output_mode: "整体合并",
	timeline_format: "SRT",
	mp3_quality: "320k",
	fail_mode: "报错",
	audio_format: "WAV",
};

const NUMBER_DEFAULTS = {
	speed: { value: 1.0, min: 0.5, max: 2.0, decimals: 2 },
	pitch: { value: 0, min: -20, max: 20, int: true },
	steps: { value: 16, min: 1, max: 128, int: true },
	guidance_strength: { value: 4.0, min: 0, max: 20, decimals: 2 },
	pause_after_speaker: { value: 0.4, min: 0, max: 0.8, decimals: 2 },
	seed: { value: 42, min: 0, max: 0x7fffffff, int: true },
	segment_min_chars: { value: 12, min: 0, max: 200, int: true },
	segment_max_chars: { value: 80, min: 8, max: 500, int: true },
	qwen_max_new_tokens: { value: 2048, min: 512, max: 8192, int: true },
	qwen_top_p: { value: 0.8, min: 0, max: 1, decimals: 2 },
	qwen_top_k: { value: 20, min: 0, max: 100, int: true },
	qwen_temperature: { value: 1.0, min: 0.1, max: 2.0, decimals: 2 },
	qwen_repetition_penalty: { value: 1.05, min: 1.0, max: 2.0, decimals: 2 },
};

const BOOLEAN_DEFAULTS = {
	qwen_x_vector_only: false,
};

const QWEN_PARAM_NAMES = ["qwen_max_new_tokens", "qwen_top_p", "qwen_top_k", "qwen_temperature", "qwen_repetition_penalty", "qwen_x_vector_only"];
const QWEN_PARAM_PRESETS = {
	"Qwen3-CustomVoice": { qwen_max_new_tokens: 8192, qwen_top_p: 1.0, qwen_top_k: 50, qwen_temperature: 0.9, qwen_repetition_penalty: 1.05, qwen_x_vector_only: false },
	"Qwen3-VoiceDesign": { qwen_max_new_tokens: 4096, qwen_top_p: 0.9, qwen_top_k: 40, qwen_temperature: 0.8, qwen_repetition_penalty: 1.05, qwen_x_vector_only: false },
	"Qwen3-VoiceClone": { qwen_max_new_tokens: 2048, qwen_top_p: 0.8, qwen_top_k: 20, qwen_temperature: 1.0, qwen_repetition_penalty: 1.05, qwen_x_vector_only: false },
};

const SERIALIZED_WIDGET_ORDER = [
	"text", "branch", "model_name", "local_audio_name",
	"edge_voice", "custom_voice", "speed", "pitch", "language", "device", "precision",
	"steps", "guidance_strength", "pause_after_speaker", "seed",
	"audio_output_mode", "timeline_format", "mp3_filename_prefix", "mp3_quality", "fail_mode",
	"segment_min_chars", "segment_max_chars", "local_audio_order_json", "edge_speaker_voices_json", "tts_voice_orders_json",
	"qwen_max_new_tokens", "qwen_top_p", "qwen_top_k", "qwen_temperature", "qwen_repetition_penalty", "qwen_x_vector_only",
	"emotion_prompt", "audio_format", "qwen_instruct",
];
const SERIALIZED_WIDGET_RANK = new Map(SERIALIZED_WIDGET_ORDER.map((name, index) => [name, index]));

function normalizeLocalAudioSortMode(value) {
	return LOCAL_AUDIO_SORT_MODES.has(String(value || "")) ? String(value) : "name_asc";
}

function nextLibrarySortMode(mode, includeFileStats = false) {
	const modes = includeFileStats ? ["name_asc", "name_desc", "date_desc", "date_asc", "size_desc", "size_asc"] : ["name_asc", "name_desc"];
	const current = normalizeLocalAudioSortMode(mode);
	return modes[(Math.max(0, modes.indexOf(current)) + 1) % modes.length] || modes[0];
}

function librarySortLabel(mode) {
	return ({
		name_asc: "A-Z",
		name_desc: "Z-A",
		date_desc: "⏰新",
		date_asc: "⏰旧",
		size_desc: "💾大",
		size_asc: "💾小",
	})[normalizeLocalAudioSortMode(mode)] || "A-Z";
}

function formatBytes(bytes) {
	const value = Number(bytes || 0);
	if (!Number.isFinite(value) || value <= 0) return "";
	if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)}GB`;
	if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}MB`;
	if (value >= 1024) return `${(value / 1024).toFixed(1)}KB`;
	return `${Math.round(value)}B`;
}

function normalizeCharacterKey(value) {
	return String(value || "")
		.trim()
		.replace(/^@+/, "")
		.replace(/[♀♂]/g, "")
		.replace(/\s+/g, "")
		.toLowerCase();
}

function branchDisplayName(value) {
	return BRANCH_DISPLAY[String(value || "")] || String(value || "");
}

function voiceDisplayLabel(branch, value) {
	const name = String(value || "");
	const detail = branch === "Qwen3-CustomVoice" ? QWEN_CUSTOM_VOICE_LABELS[name] : "";
	return detail ? `${name} — ${detail}` : name;
}

function isTtsVoiceLibraryBranch(branch) {
	return new Set(["EdgeTTS", "Qwen3-CustomVoice", "Qwen3-VoiceDesign"]).has(String(branch || ""));
}

function isCloneVoiceLibraryBranch(branch) {
	return !isTtsVoiceLibraryBranch(branch);
}

function nodePresetFromSettings(settings) {
	const nodes = settings?.nodes;
	const preset = nodes && typeof nodes === "object" ? nodes[TARGET] : null;
	if (!preset || typeof preset !== "object") return {};
	return {
		branch: String(preset.branch || ""),
		local_audio_sort_mode: normalizeLocalAudioSortMode(preset.local_audio_sort_mode),
	};
}

async function loadUniversalTTSPreset() {
	if (universalTTSPresetCache) return universalTTSPresetCache;
	if (!universalTTSPresetPromise) {
		universalTTSPresetPromise = fetch(SETTINGS_ENDPOINT)
			.then((response) => response.json())
			.then((data) => {
				universalTTSPresetCache = nodePresetFromSettings(data?.settings);
				return universalTTSPresetCache;
			})
			.catch(() => {
				universalTTSPresetCache = {};
				return universalTTSPresetCache;
			});
	}
	return universalTTSPresetPromise;
}

function applyUniversalTTSPreset(node, preset) {
	if (!node || !preset || typeof preset !== "object") return;
	const s = node.__gjjUniversalTTS;
	if (s) {
		s.mp3SortMode = normalizeLocalAudioSortMode(preset.local_audio_sort_mode);
		s.mp3SortAsc = s.mp3SortMode !== "name_desc";
	}
}

function syncLocalAudioOrderStorage(node) {
	ensureProperties(node);
	let order = Array.isArray(node.properties.local_audio_order) ? node.properties.local_audio_order.map((item) => String(item || "").trim()).filter(Boolean) : [];
	const storage = widget(node, "local_audio_order_json");
	if (!order.length && storage) {
		try {
			const parsed = JSON.parse(String(storage.value || "[]"));
			if (Array.isArray(parsed)) order = parsed.map((item) => String(item || "").trim()).filter(Boolean);
		} catch (_) {}
	}
	node.properties.local_audio_order = [...new Set(order)];
	if (storage) {
		const value = JSON.stringify(node.properties.local_audio_order);
		if (String(storage.value || "") !== value) storage.value = value;
	}
}

function isTarget(node) {
	const values = [
		node?.comfyClass,
		node?.type,
		node?.title,
		node?.constructor?.nodeData?.name,
		node?.constructor?.nodeData?.display_name,
		node?.constructor?.nodeData?.displayName,
		node?.nodeData?.name,
		node?.nodeData?.display_name,
		node?.nodeData?.displayName,
	].map((value) => String(value || ""));
	return values.some((value) => value === TARGET || value.includes("多功能文字转语音TTS"));
}

function isTargetNodeData(nodeData) {
	const values = [
		nodeData?.name,
		nodeData?.display_name,
		nodeData?.displayName,
		nodeData?.title,
	].map((value) => String(value || ""));
	return values.some((value) => value === TARGET || value.includes("多功能文字转语音TTS"));
}

function refresh(node) {
	const fit = () => {
		try {
			const computed = node?.computeSize?.();
			if (Array.isArray(computed)) {
				const width = Math.max(300, Math.round(node.size?.[0] || computed[0] || 300));
				const height = Math.max(100, Math.round(computed[1] || node.size?.[1] || 100));
				node.setSize?.([width, height]);
			}
		} catch (_) {}
		try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
		try { app.canvas?.setDirty?.(true, true); } catch (_) {}
		try { node?.graph?.change?.(); } catch (_) {}
	};
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(fit);
	else fit();
	setTimeout(fit, 80);
}

function hideWidget(item) {
	if (!item) return;
	if (!item.__gjjUniversalOriginal) {
		item.__gjjUniversalOriginal = {
			type: item.type,
			label: item.label,
			computeSize: item.computeSize || null,
			getHeight: item.getHeight || null,
			optionsHidden: item.options?.hidden,
			optionsDisplay: item.options?.display,
			draw: item.draw || null,
			mouse: item.mouse || null,
			widgetDisplay: item.widget?.style?.display || "",
			elementDisplay: item.element?.style?.display || "",
			inputDisplay: item.inputEl?.style?.display || "",
			y: item.y,
			lastY: item.last_y,
			computedHeight: item.computedHeight,
			marginTop: item.margin_top,
			size: Array.isArray(item.size) ? [...item.size] : item.size,
		};
	}
	if (!item.__gjjUniversalOriginalSize) {
		item.__gjjUniversalOriginalSize = item.computeSize || null;
	}
	item.hidden = true;
	item.disabled = true;
	item.options ||= {};
	item.options.hidden = true;
	item.options.display = "hidden";
	item.computeSize = () => [0, 0];
	item.getHeight = () => 0;
	item.draw = () => {};
	item.mouse = () => false;
	item.y = 0;
	item.last_y = 0;
	item.computedHeight = 0;
	item.margin_top = 0;
	item.size = [0, 0];
	if (item.widget) item.widget.style.display = "none";
	if (item.element) item.element.style.display = "none";
	if (item.inputEl) item.inputEl.style.display = "none";
}

function showWidget(item) {
	if (!item) return;
	item.hidden = false;
	item.disabled = false;
	const original = item.__gjjUniversalOriginal || {};
	if (original.type !== undefined) item.type = original.type;
	if (original.label !== undefined) item.label = original.label;
	if (original.computeSize) item.computeSize = original.computeSize;
	else delete item.computeSize;
	if (original.getHeight) item.getHeight = original.getHeight;
	else delete item.getHeight;
	if (original.draw) item.draw = original.draw;
	else delete item.draw;
	if (original.mouse) item.mouse = original.mouse;
	else delete item.mouse;
	if (item.options) {
		delete item.options.hidden;
		delete item.options.display;
	}
	item.y = original.y;
	item.last_y = original.lastY;
	if (original.computedHeight !== undefined) item.computedHeight = original.computedHeight;
	else delete item.computedHeight;
	if (original.marginTop !== undefined) item.margin_top = original.marginTop;
	else delete item.margin_top;
	if (original.size !== undefined) item.size = Array.isArray(original.size) ? [...original.size] : original.size;
	else delete item.size;
	if (item.widget) item.widget.style.display = original.widgetDisplay ?? "";
	if (item.element) item.element.style.display = original.elementDisplay ?? "";
	if (item.inputEl) item.inputEl.style.display = original.inputDisplay ?? "";
}

function moveWidgetToTop(node, widgetRef) {
	if (!widgetRef || !Array.isArray(node?.widgets)) return;
	const index = node.widgets.indexOf(widgetRef);
	if (index <= 0) return;
	node.widgets.splice(index, 1);
	node.widgets.unshift(widgetRef);
}

function moveWidgetsToTop(node, widgetRefs) {
	if (!Array.isArray(node?.widgets)) return;
	for (const widgetRef of [...widgetRefs].reverse()) {
		moveWidgetToTop(node, widgetRef);
	}
}

function canonicalWidgetRank(widgetRef, fallbackIndex) {
	if (!widgetRef || widgetRef.serialize === false || widgetRef.options?.serialize === false) {
		return 10000 + fallbackIndex;
	}
	return SERIALIZED_WIDGET_RANK.has(widgetRef.name) ? SERIALIZED_WIDGET_RANK.get(widgetRef.name) : 5000 + fallbackIndex;
}

function normalizeSerializedWidgetOrder(node) {
	if (!Array.isArray(node?.widgets)) return;
	const indexed = node.widgets.map((item, index) => ({ item, index }));
	indexed.sort((a, b) => canonicalWidgetRank(a.item, a.index) - canonicalWidgetRank(b.item, b.index));
	node.widgets.splice(0, node.widgets.length, ...indexed.map((entry) => entry.item));
}

function captureWidgetValuesByName(node) {
	ensureProperties(node);
	const values = {};
	for (const w of node.widgets || []) {
		if (!SERIALIZED_WIDGET_RANK.has(w?.name)) continue;
		values[w.name] = cloneValue(w.value);
	}
	node.properties.gjj_widget_values_by_name = values;
}

function restoreWidgetValuesByName(node) {
	const values = node?.properties?.gjj_widget_values_by_name;
	if (!values || typeof values !== "object") return;
	for (const [name, value] of Object.entries(values)) {
		if (!SERIALIZED_WIDGET_RANK.has(name)) continue;
		const w = widget(node, name);
		if (w) setWidgetValue(node, name, cloneValue(value));
	}
}

function removeToolbarWidgets(node) {
	if (!Array.isArray(node?.widgets)) return;
	for (let i = node.widgets.length - 1; i >= 0; i -= 1) {
		const w = node.widgets[i];
		if (w === node.__gjjUniversalTTSToolbarWidget) continue;
		if (w?.__gjjUniversalToolbar || w?.__gjjUniversalCanvasToolbar || w?.name === "gjj_universal_tts_toolbar") {
			try { w.element?.remove?.(); } catch (_) {}
			node.widgets.splice(i, 1);
		}
	}
	node.__gjjUniversalNativeToolbar = null;
}

function widget(node, name) {
	return (node?.widgets || []).find((item) => item?.name === name);
}

function setWidgetValue(node, name, value) {
	const w = widget(node, name);
	if (!w) return;
	w.value = value;
	try { w.callback?.(value); } catch (_) {}
	node.setDirtyCanvas?.(true, true);
	node.graph?.change?.();
}

function formatAudioName(index) {
	return `${AUDIO_PREFIX}${String(index).padStart(2, "0")}_audio`;
}

function inputIndex(name) {
	const match = String(name || "").match(/^reference_(\d+)_(audio|text)$/);
	return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function isManagedInput(input) {
	return /^reference_\d+_audio$/.test(String(input?.name || ""));
}

function pairs(node) {
	return (node?.inputs || [])
		.filter(isManagedInput)
		.map((audio) => ({ index: inputIndex(audio.name), audio }))
		.sort((a, b) => a.index - b.index);
}

function hasLink(input) {
	return Boolean(input?.link);
}

function linkedInputs(node) {
	return (node?.inputs || []).filter((input) => hasLink(input));
}

function pairLinked(pair) {
	return hasLink(pair?.audio);
}

function pairDetached(node, pair) {
	const stored = node?.properties?.detached_links || {};
	return Boolean(stored[pair?.audio?.name]);
}

function removeInput(node, input) {
	const slot = node?.inputs?.indexOf(input);
	if (slot >= 0) node.removeInput(slot);
}

function addPair(node) {
	const count = pairs(node).length;
	if (count >= MAX_REFERENCES) return;
	const index = count + 1;
	node.addInput(formatAudioName(index), "AUDIO");
}

function normalizePairs(node) {
	for (let index = (node?.inputs || []).length - 1; index >= 0; index -= 1) {
		if (/^reference_\d+_text$/.test(String(node.inputs[index]?.name || ""))) node.removeInput(index);
	}
	for (const name of Object.keys(node?.properties?.detached_links || {})) {
		if (/^reference_\d+_text$/.test(name)) delete node.properties.detached_links[name];
	}
	let list = pairs(node);
	while (list.length < 1) {
		addPair(node);
		list = pairs(node);
	}
	const stored = node?.properties?.detached_links || {};
	const maxStoredIndex = Math.max(0, ...Object.keys(stored).map(inputIndex).filter((index) => Number.isFinite(index) && index !== Number.MAX_SAFE_INTEGER));
	while (list.length < Math.min(MAX_REFERENCES, maxStoredIndex)) {
		addPair(node);
		list = pairs(node);
	}
	for (let i = list.length - 1; i >= 1; i -= 1) {
		if (pairLinked(list[i]) || pairDetached(node, list[i])) break;
		removeInput(node, list[i].audio);
	}
	list = pairs(node);
	if (list.length && pairLinked(list[list.length - 1]) && list.length < MAX_REFERENCES) addPair(node);
	list = pairs(node);
	for (const [zero, pair] of list.entries()) {
		const index = zero + 1;
		if (pair.audio) {
			pair.audio.name = formatAudioName(index);
			pair.audio.label = `参考音频${index}`;
			pair.audio.localized_name = pair.audio.label;
			pair.audio.type = "AUDIO";
		}
	}
	updateLinkButton(node);
	refresh(node);
}

function ensureProperties(node) {
	node.properties ||= {};
	for (const [key, value] of Object.entries(MANAGED_PROPS)) {
		if (node.properties[key] === undefined) node.properties[key] = cloneValue(value);
	}
}

function button(label, title = "") {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.textContent = label;
	btn.title = title;
	btn.style.cssText = [
		"width:27px", "height:27px", "min-width:27px", "padding:0",
		"border:1px solid #46606a", "border-radius:6px",
		"background:#1f3037", "color:#f2fbff", "cursor:pointer",
		"display:inline-flex", "align-items:center", "justify-content:center",
		"font:700 14px/1 ui-sans-serif,system-ui,'Microsoft YaHei',sans-serif",
	].join(";");
	btn.addEventListener("pointerdown", (event) => event.stopPropagation());
	btn.addEventListener("mousedown", (event) => event.stopPropagation());
	return btn;
}

function compactTextWidget(node) {
	const textWidget = widget(node, "text");
	if (!textWidget) return;
	textWidget.options ||= {};
	textWidget.options.rows = Math.min(Number(textWidget.options.rows || 4) || 4, 4);
	textWidget.__gjjUniversalCompact = true;
	textWidget.computeSize = (width) => [width, 94];
	textWidget.getHeight = () => 94;
	if (textWidget.element) {
		textWidget.element.style.minHeight = "0";
		textWidget.element.style.height = "94px";
	}
	if (textWidget.inputEl) {
		textWidget.inputEl.style.minHeight = "0";
		textWidget.inputEl.style.height = "74px";
		textWidget.inputEl.style.resize = "vertical";
	}
}

function textValueFromNode(node) {
	const candidates = [];
	for (const w of node?.widgets || []) {
		if (typeof w?.value !== "string") continue;
		const value = w.value.trim();
		if (!value) continue;
		const name = String(w.name || "").toLowerCase();
		const score = (["text", "prompt", "markdown", "content"].includes(name) ? 100000 : 0) + value.length;
		candidates.push({ value, score });
	}
	candidates.sort((a, b) => b.score - a.score);
	return candidates[0]?.value || "";
}

function widgetNameForInput(input) {
	const name = String(input?.name || "");
	if (name === "text" || name === "合成文本") return "text";
	return COMMON_WIDGETS.has(name) ? name : "";
}

function linkedSynthesisText(node) {
	const result = linkedSynthesisTextValue(node);
	return result.linked ? result.text : "";
}

function linkedSynthesisTextValue(node) {
	const input = (node?.inputs || []).find((item) => ["text", "合成文本"].includes(String(item?.name || "")));
	if (!input?.link) return { linked: false, text: "" };
	const link = app.graph?.links?.[input.link];
	const origin = link ? app.graph?.getNodeById?.(link.origin_id) : null;
	return { linked: true, text: textValueFromNode(origin) };
}

function syncLinkedSynthesisText(node) {
	const linked = linkedSynthesisTextValue(node);
	if (!linked.linked) return false;
	const text = linked.text;
	const textWidget = widget(node, "text");
	if (!textWidget || String(textWidget.value || "") === text) return true;
	setWidgetValue(node, "text", text);
	return true;
}

function synthesisTextForSpeakerParsing(node) {
	const linked = linkedSynthesisTextValue(node);
	return linked.linked ? linked.text : String(widget(node, "text")?.value || "");
}

function parseSpeakerEntriesFromText(text) {
	const entries = new Map();
	const named = new Map();
	const tagRe = /^\s*((?:\[?speaker[_\s-]*(\d+)\]?|spk[_\s-]*(\d+)|角色\s*(\d+)|说话人\s*(\d+)))\s*[:：]/i;
	const namedTagRe = /^\s*([A-Za-z]|[甲乙丙丁戊己庚辛壬癸]|[\u4e00-\u9fffA-Za-z0-9_·]{1,12}(?:\s*[、,，/|&和与]\s*[\u4e00-\u9fffA-Za-z0-9_·]{1,12}){0,8})\s*[:：]/;
	const cleanLabel = (label) => String(label || "").trim().replace(/^[\[\]【】（）()\s]+|[\[\]【】（）()\s]+$/g, "");
	const addEntry = (index, label) => {
		const clean = cleanLabel(label);
		if (!clean) return;
		if (!entries.has(index)) entries.set(index, clean);
	};
	const speakerIndexFromLabel = (label) => {
		const raw = cleanLabel(label);
		const numeric = raw.match(/(?:speaker|spk|角色|说话人)?[_\s-]*(\d+)$/i);
		if (numeric) return Math.max(0, Number.parseInt(numeric[1], 10) - 1);
		const key = raw.toLowerCase();
		if (!named.has(key)) named.set(key, named.size);
		return named.get(key);
	};
	for (const line of String(text || "").split(/\r?\n/)) {
		const match = tagRe.exec(line);
		if (match) {
			const number = match.slice(2, 6).find(Boolean) || "1";
			const index = Math.max(0, Number.parseInt(number, 10) - 1);
			addEntry(index, match[1] || `说话人${index + 1}`);
			continue;
		}
		const namedMatch = namedTagRe.exec(line);
		if (!namedMatch) continue;
		const labels = String(namedMatch[1] || "").split(/\s*(?:[、,，/|&]|和|与)\s*/).map(cleanLabel).filter(Boolean);
		for (const label of labels) addEntry(speakerIndexFromLabel(label), label);
	}
	return [...entries.entries()]
		.sort((a, b) => a[0] - b[0])
		.slice(0, MAX_REFERENCES)
		.map(([index, label]) => ({ index, label }));
}

function readEdgeSpeakerVoiceMap(node) {
	const w = widget(node, "edge_speaker_voices_json");
	try {
		const parsed = JSON.parse(String(w?.value || "{}"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch (_) {
		return {};
	}
}

function readTTSVoiceOrders(node) {
	const w = widget(node, "tts_voice_orders_json");
	try {
		const parsed = JSON.parse(String(w?.value || "{}"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch (_) {}
	return {};
}

function readEdgeVoiceOrder(node, branch = "EdgeTTS") {
	const orders = readTTSVoiceOrders(node);
	const current = orders[String(branch || "")];
	if (Array.isArray(current)) return current.map((item) => String(item || "").trim()).filter(Boolean);
	if (branch === "EdgeTTS") {
		const legacy = widget(node, "edge_speaker_voices_json");
		try {
			const parsed = JSON.parse(String(legacy?.value || "[]"));
			if (Array.isArray(parsed)) return parsed.map((item) => String(item || "").trim()).filter(Boolean);
			if (parsed && typeof parsed === "object") {
				return Object.entries(parsed).sort((a, b) => Number(a[0]) - Number(b[0])).map(([, value]) => String(value || "").trim()).filter(Boolean);
			}
		} catch (_) {}
	}
	return [];
}

function writeEdgeVoiceOrder(node, branch, order) {
	const cleaned = [...new Set((order || []).map((item) => String(item || "").trim()).filter(Boolean))];
	const orders = readTTSVoiceOrders(node);
	orders[String(branch || "EdgeTTS")] = cleaned;
	setWidgetValue(node, "tts_voice_orders_json", JSON.stringify(orders));
	if (String(branch || "") === "EdgeTTS") setWidgetValue(node, "edge_speaker_voices_json", JSON.stringify(cleaned));
}

function writeEdgeSpeakerVoiceMap(node, value) {
	const cleaned = {};
	for (const [key, voice] of Object.entries(value || {})) {
		const text = String(voice || "").trim();
		if (text) cleaned[String(key)] = text;
	}
	setWidgetValue(node, "edge_speaker_voices_json", JSON.stringify(cleaned));
}

function speakerEntriesForLibrary(node) {
	const entries = parseSpeakerEntriesFromText(synthesisTextForSpeakerParsing(node));
	return entries.length ? entries : [{ index: 0, label: "说话人1" }];
}

async function loadCharacterLibraryForTTS() {
	try {
		const response = await fetch(CHARACTER_LIBRARY_ENDPOINT);
		const data = await response.json();
		return Array.isArray(data?.characters) ? data.characters : [];
	} catch (_) {
		return [];
	}
}

function characterVoiceForSpeaker(entry, characters) {
	const character = characterForSpeaker(entry, characters);
	return character ? String(character.voice_path || "").trim().replace(/\//g, "\\") : "";
}

function normalizeVoicePath(value) {
	return String(value || "").trim().replace(/\//g, "\\");
}

function voiceStem(value) {
	const name = normalizeVoicePath(value).split("\\").pop() || "";
	return normalizeCharacterKey(name.replace(/\.(?:wav|mp3)$/i, ""));
}

function voiceMatchesAnyAlias(value, aliases) {
	const stem = voiceStem(value);
	return Boolean(stem && aliases.some((alias) => {
		const key = normalizeCharacterKey(alias);
		return key && (stem === key || stem.startsWith(key) || (key.length >= 2 && stem.includes(key)));
	}));
}

function aliasesForSpeaker(entry, character) {
	return [
		entry?.label,
		character?.reference_name,
		character?.name,
		character?.id,
		String(character?.reference || "").replace(/^@+/, ""),
	].filter(Boolean);
}

function findNamedVoiceForSpeaker(entry, character, values) {
	const aliases = aliasesForSpeaker(entry, character);
	return (values || []).find((value) => voiceMatchesAnyAlias(value, aliases)) || "";
}

function characterVoiceForSpeakerFromValues(entry, characters, values, duplicateVoicePaths = new Set()) {
	const character = characterForSpeaker(entry, characters);
	const namedVoice = findNamedVoiceForSpeaker(entry, character, values);
	const voicePath = normalizeVoicePath(character?.voice_path);
	const known = new Set((values || []).map(normalizeVoicePath));
	if (voicePath && known.has(voicePath) && !duplicateVoicePaths.has(voicePath)) return voicePath;
	return namedVoice || (voicePath && known.has(voicePath) ? voicePath : "");
}

function characterForSpeaker(entry, characters) {
	const key = normalizeCharacterKey(entry?.label);
	if (!key) return null;
	for (const character of characters || []) {
		const aliases = [
			character?.reference_name,
			character?.name,
			character?.id,
			String(character?.reference || "").replace(/^@+/, ""),
		].map(normalizeCharacterKey).filter(Boolean);
		if (aliases.includes(key)) return character;
	}
	return null;
}

function renderEdgeSpeakerVoicePanel(node) {
	const s = node.__gjjUniversalTTS;
	if (!s?.speakerPanel) return;
	s.speakerPanel.style.display = "none";
	s.speakerPanel.replaceChildren();
	return;
	const branch = String(widget(node, "branch")?.value || "EdgeTTS");
	const open = Boolean(node.properties?.settings_open);
	if (branch !== "EdgeTTS" || !open) {
		s.speakerPanel.style.display = "none";
		s.speakerPanel.replaceChildren();
		return;
	}
	const voiceWidget = widget(node, "edge_voice");
	const voices = optionValues(voiceWidget);
	const fallback = String(voiceWidget?.value || voices[0] || "");
	const map = readEdgeSpeakerVoiceMap(node);
	const entries = parseSpeakerEntriesFromText(synthesisTextForSpeakerParsing(node));
	while (entries.length < 2) entries.push({ index: entries.length, label: `说话人${entries.length + 1}` });
	s.speakerPanel.replaceChildren();
	const title = document.createElement("div");
	title.textContent = "说话人音色";
	title.style.cssText = "font-weight:700;color:#edf7fb;margin-bottom:6px";
	s.speakerPanel.append(title);
	const seenIndexes = new Set();
	for (const entry of entries.slice(0, MAX_REFERENCES)) {
		const index = Math.max(0, Number(entry.index) || 0);
		if (seenIndexes.has(index)) continue;
		seenIndexes.add(index);
		const row = document.createElement("label");
		row.style.cssText = "display:flex;align-items:center;gap:8px;margin:4px 0";
		const label = document.createElement("span");
		label.textContent = String(entry.label || `说话人${index + 1}`);
		label.style.cssText = "width:70px;color:#c9d6dc;white-space:nowrap";
		const select = document.createElement("select");
		select.style.cssText = "flex:1;min-width:0;background:#2b3035;color:#f4fbff;border:1px solid #465862;border-radius:5px;padding:4px 6px";
		for (const value of voices.length ? voices : [fallback]) {
			const option = document.createElement("option");
			option.value = String(value);
			option.textContent = String(value);
			select.append(option);
		}
		select.value = String(map[String(index + 1)] || fallback);
		select.addEventListener("pointerdown", (event) => event.stopPropagation());
		select.addEventListener("mousedown", (event) => event.stopPropagation());
		select.addEventListener("change", () => {
			const next = readEdgeSpeakerVoiceMap(node);
			if (String(select.value) === fallback) delete next[String(index + 1)];
			else next[String(index + 1)] = select.value;
			writeEdgeSpeakerVoiceMap(node, next);
			refresh(node);
		});
		row.append(label, select);
		s.speakerPanel.append(row);
	}
	s.speakerPanel.style.display = "";
}

function toolbarHeight(state, width) {
	const measured = Number(state?.toolbar?.scrollHeight || 0);
	if (measured > 0) return Math.max(34, measured);
	return 34;
}

function ensureToolbarWidget(node, state) {
	const existing = node.__gjjUniversalTTSToolbarWidget;
	if (existing && node.widgets?.includes(existing)) {
		moveWidgetToTop(node, existing);
		return existing;
	}
	node.__gjjUniversalTTSToolbarWidget = null;
	removeToolbarWidgets(node);
	const toolbarWidget = node.addDOMWidget?.(TOOLBAR_WIDGET, "HTML", state.toolbar, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => toolbarHeight(state, node.size?.[0]),
	});
	if (toolbarWidget) {
		toolbarWidget.serialize = false;
		toolbarWidget.options ||= {};
		toolbarWidget.options.serialize = false;
		toolbarWidget.computeSize = (width) => [Math.max(260, Number(width || node.size?.[0] || 360)), toolbarHeight(state, width)];
		toolbarWidget.mouse = function (event) {
			const target = event?.target;
			if (target && state.toolbar.contains?.(target)) {
				event?.stopPropagation?.();
				return true;
			}
			return false;
		};
		node.__gjjUniversalTTSToolbarWidget = toolbarWidget;
		moveWidgetToTop(node, toolbarWidget);
		return toolbarWidget;
	}
	return null;
}

function ensurePanel(node) {
	if (node.__gjjUniversalTTS) return node.__gjjUniversalTTS;
	ensureProperties(node);
	const toolbar = document.createElement("div");
	toolbar.style.cssText = "display:flex;gap:4px;align-items:center;flex-wrap:nowrap;width:100%;box-sizing:border-box;overflow:visible";
	const open = button("📂", "打开文本、音频或视频文件");
	const keep = button("🧠", "切换是否保留模型");
	const branch = button("💱", "选择生成分支");
	const link = button("🔗", "记住外部链接并断开/恢复");
	const seed = button("🎲", "切换固定/随机种子");
	const mp3 = button("📢", "显示 models/GJJ/wav 及其子目录中的 .wav / .mp3 音频");
	const terms = button("👨‍🎨", "编辑术语库");
	const output = button("🔌", "选择输出口内容");
	const settings = button("⚙️", "显示/隐藏其它参数");
	const generate = button("🎤", "生成语音");
	const reset = button("🔄", "清空预览音频并初始化节点");
	toolbar.append(open, keep, branch, link, seed, mp3, terms, output, settings, generate, reset);

	const progress = document.createElement("div");
	progress.style.cssText = "display:none;padding:6px 8px;border:1px solid #41535b;border-radius:7px;background:#121a1f";
	const label = document.createElement("div");
	label.textContent = "";
	label.style.cssText = "margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
	const track = document.createElement("div");
	track.style.cssText = "height:6px;border-radius:999px;background:#27343b;overflow:hidden";
	const bar = document.createElement("div");
	bar.style.cssText = "width:0%;height:100%;background:#67c1ff;border-radius:999px;transition:width 160ms ease";
	track.append(bar);
	progress.append(label, track);

	const outputPanel = document.createElement("div");
	outputPanel.style.cssText = "display:none;padding:7px;border:1px solid #41535b;border-radius:7px;background:#10171b";
	const speakerPanel = document.createElement("div");
	speakerPanel.style.cssText = "display:none;padding:7px;border:1px solid #41535b;border-radius:7px;background:#10171b";

	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = ".txt,.srt,.vtt,.lrc,.json,.wav,.mp3,.flac,.m4a,.ogg,.aac,.mp4,.mov,.mkv,.webm,text/*,audio/*,video/*";
	fileInput.style.display = "none";

	const root = document.createElement("div");
	root.style.cssText = "display:flex;flex-direction:column;gap:7px;width:100%;box-sizing:border-box;color:#dce7e2;font:12px/1.35 ui-sans-serif,system-ui,'Microsoft YaHei',sans-serif";
	root.append(fileInput, progress, outputPanel, speakerPanel);

	const state = { root, toolbar, open, keep, branch, link, seed, mp3, terms, output, settings, generate, reset, progress, label, bar, outputPanel, speakerPanel, fileInput, branchPopup: null, mp3Popup: null, termsPopup: null, outputPopup: null, settingsPopup: null, mp3SortMode: "name_asc", mp3SortAsc: true };
	ensureToolbarWidget(node, state);
	const panelHeight = () => {
		let h = 0;
		if (progress.style.display !== "none") h += 52;
		if (outputPanel.style.display !== "none") h += Math.min(96, outputPanel.scrollHeight || 74);
		if (speakerPanel.style.display !== "none") h += Math.min(260, speakerPanel.scrollHeight || 116);
		return h;
	};
	const panel = node.addDOMWidget?.(STATUS_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
		getHeight: panelHeight,
	});
	if (panel) {
		panel.serialize = false;
		panel.options ||= {};
		panel.options.serialize = false;
		panel.computeSize = (width) => [Math.max(260, Number(width || node.size?.[0] || 300)), panelHeight()];
		panel.mouse = function (event) {
			const target = event?.target;
			if (root.contains?.(target)) {
				event?.stopPropagation?.();
				return true;
			}
			return false;
		};
	}
	state.widget = panel;
	node.__gjjUniversalTTS = state;
	wirePanel(node, state);
	syncButtons(node);
	return state;
}

function syncButtons(node) {
	const s = node.__gjjUniversalTTS;
	if (!s) return;
	ensureProperties(node);
	const branchValue = String(widget(node, "branch")?.value || "EdgeTTS");
	const audioMode = String(widget(node, "audio_output_mode")?.value || "整体合并");
	const textMode = String(widget(node, "timeline_format")?.value || "SRT");
	s.keep.style.background = node.properties.keep_model_loaded ? "#265f8f" : "#2a3034";
	s.keep.style.borderColor = node.properties.keep_model_loaded ? "#69b8e6" : "#46606a";
	s.keep.title = node.properties.keep_model_loaded ? "保留模型：开" : "保留模型：关";
	s.seed.style.background = node.properties.random_seed ? "#7a5c18" : "#2a3034";
	s.seed.style.borderColor = node.properties.random_seed ? "#ffc766" : "#46606a";
	s.seed.title = node.properties.random_seed ? "随机种子：每次变化" : `随机种子：固定 ${widget(node, "seed")?.value ?? 42}`;
	s.settings.style.background = s.settingsPopup ? "#4d5860" : "#1f3037";
	s.settings.style.borderColor = s.settingsPopup ? "#9fb0bd" : "#46606a";
	s.settings.title = s.settingsPopup ? "关闭参数弹窗" : "显示参数弹窗";
	const branchColors = ["#1f3037", "#273d62", "#3f3a1e", "#43304f", "#244437"];
	s.branch.style.background = branchColors[Math.max(0, BRANCH_VALUES.indexOf(branchValue)) % branchColors.length] || "#1f3037";
	s.branch.style.borderColor = branchValue === "EdgeTTS" ? "#46606a" : "#79a7d8";
	s.branch.title = `生成分支：${branchDisplayName(branchValue)}。点击选择`;
	s.branch.style.boxShadow = s.branchPopup ? "0 0 0 1px #9fb0bd inset" : "";
	s.output.style.background = s.outputPopup ? "#33414a" : "#1f3037";
	s.output.style.borderColor = s.outputPopup ? "#9fb0bd" : "#46606a";
	s.output.title = `输出：${audioMode} / ${textMode}`;
	const audioOrder = Array.isArray(node.properties.local_audio_order) ? node.properties.local_audio_order.filter(Boolean) : [];
	const audioName = audioOrder.length ? `已选 ${audioOrder.length} 个：${audioOrder.map((item, index) => `${index + 1}.${item}`).join(" / ")}` : String(widget(node, "local_audio_name")?.value || "").trim();
	const isTtsLibrary = isTtsVoiceLibraryBranch(branchValue);
	const edgeVoiceOrder = readEdgeVoiceOrder(node, branchValue);
	const ttsPrimaryVoice = branchValue === "EdgeTTS" ? String(widget(node, "edge_voice")?.value || "").trim() : String(widget(node, "custom_voice")?.value || "").trim();
	const libraryName = isTtsLibrary
		? (edgeVoiceOrder.length ? `已选 ${edgeVoiceOrder.length} 个：${edgeVoiceOrder.map((item, index) => `${index + 1}.${item}`).join(" / ")}` : ttsPrimaryVoice)
		: audioName;
	s.mp3.style.background = s.mp3Popup ? "#33414a" : "#1f3037";
	s.mp3.style.borderColor = s.mp3Popup ? "#9fb0bd" : "#46606a";
	s.mp3.title = isTtsLibrary
		? (libraryName ? `TTS 音色库：${libraryName}` : "选择当前 TTS 分支音色库")
		: (libraryName ? `本地参考音频：${libraryName}` : "选择 models/GJJ/wav 及其子目录中的 .wav / .mp3 音频");
	s.terms.style.background = s.termsPopup ? "#33414a" : "#1f3037";
	s.terms.style.borderColor = s.termsPopup ? "#9fb0bd" : "#46606a";
	s.terms.title = "编辑术语库";
	const detachedCount = Object.keys(node.properties.detached_links || {}).length;
	const linkedCount = linkedInputs(node).length;
	s.link.style.display = linkedCount || detachedCount ? "" : "none";
	s.link.style.background = detachedCount ? "#31475d" : "#1f3037";
	s.link.style.borderColor = detachedCount ? "#7eb2e0" : "#46606a";
	s.link.title = detachedCount ? `恢复已记住的 ${detachedCount} 条外部连接` : `复刻并断开 ${linkedCount} 条外部连接`;
}

async function saveUniversalTTSPreset(node, values = {}) {
	try {
		const branchWidget = widget(node, "branch");
		const s = node?.__gjjUniversalTTS;
		const preset = {
			branch: String(branchWidget?.value || "EdgeTTS"),
			local_audio_sort_mode: normalizeLocalAudioSortMode(s?.mp3SortMode),
			...values,
		};
		universalTTSPresetCache = { ...(universalTTSPresetCache || {}), ...preset };
		await fetch(SETTINGS_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ section: "nodes", values: { [TARGET]: preset } }),
		});
	} catch (_) {}
}

const saveBranchPreset = (node) => saveUniversalTTSPreset(node);

async function refreshDependencyNotice(node) {
	try {
		const branchValue = String(widget(node, "branch")?.value || "EdgeTTS");
		const modelValue = String(widget(node, "model_name")?.value || "");
		const params = new URLSearchParams({ branch: branchValue, model_name: modelValue });
		const response = await fetch(`${CHECK_ENDPOINT}?${params.toString()}`);
		const data = await response.json();
		if (data?.report && globalThis.GJJ_CommonDependencyModelNotice?.applyNotice) {
			const level = String(data.report.notice_level || "ok");
			const hasNotice = level !== "ok"
				|| (Array.isArray(data.report.missing_dependencies) && data.report.missing_dependencies.length > 0)
				|| (Array.isArray(data.report.missing_models) && data.report.missing_models.length > 0)
				|| (Array.isArray(data.report.optional_dependencies) && data.report.optional_dependencies.length > 0);
			globalThis.GJJ_CommonDependencyModelNotice.applyNotice(node, hasNotice ? data.report : {}, {
				detailed: true,
				dismissible: false,
			});
		}
	} catch (_) {}
}

function optionValues(w) {
	const values = w?.options?.values || w?.options?.values_list || [];
	return Array.isArray(values) ? values : [];
}

function coerceChoiceWidget(node, name, fallback) {
	const w = widget(node, name);
	if (!w) return;
	const values = optionValues(w);
	let value = String(w.value ?? "");
	if (values.length && !values.includes(value)) {
		value = values.includes(fallback) ? fallback : values[0];
		setWidgetValue(node, name, value);
	}
}

function coerceNumberWidget(node, name, config) {
	const w = widget(node, name);
	if (!w) return;
	let value = Number(w.value);
	if (!Number.isFinite(value)) value = Number(config.value);
	if (Number.isFinite(config.min)) value = Math.max(config.min, value);
	if (Number.isFinite(config.max)) value = Math.min(config.max, value);
	if (config.int) value = Math.round(value);
	else if (Number.isInteger(config.decimals)) value = Number(value.toFixed(config.decimals));
	setWidgetValue(node, name, String(value));
}

function boolValue(value, fallback = false) {
	if (typeof value === "boolean") return value;
	const text = String(value ?? "").trim().toLowerCase();
	if (["1", "true", "yes", "on", "开", "是"].includes(text)) return true;
	if (["0", "false", "no", "off", "关", "否"].includes(text)) return false;
	return Boolean(fallback);
}

function coerceBooleanWidget(node, name, fallback) {
	const w = widget(node, name);
	if (!w) return;
	const value = boolValue(w.value, fallback);
	if (w.value !== value) setWidgetValue(node, name, value);
}

function applyQwenParamPreset(node, force = false) {
	ensureProperties(node);
	const branch = String(widget(node, "branch")?.value || "");
	const preset = QWEN_PARAM_PRESETS[branch];
	if (!preset) return;
	const previous = String(node.properties.qwen_param_preset_branch || "");
	if (!force && previous === branch) return;
	for (const name of QWEN_PARAM_NAMES) {
		if (widget(node, name)) setWidgetValue(node, name, preset[name]);
	}
	node.properties.qwen_param_preset_branch = branch;
}

function normalizeRuntimeWidgetValues(node) {
	ensureProperties(node);
	syncLocalAudioOrderStorage(node);
	const emotionWidget = widget(node, "emotion_prompt");
	if (emotionWidget && ["0", "false", "no", "none", "null", "off", "关", "否", "无", "空"].includes(String(emotionWidget.value ?? "").trim().toLowerCase())) {
		setWidgetValue(node, "emotion_prompt", "");
	}
	for (const [name, fallback] of Object.entries(CHOICE_DEFAULTS)) {
		coerceChoiceWidget(node, name, fallback);
	}
	if (!BRANCH_VALUES.includes(String(widget(node, "branch")?.value || ""))) {
		setWidgetValue(node, "branch", "EdgeTTS");
	}
	const pauseWidget = widget(node, "pause_after_speaker");
	if (pauseWidget && Number(pauseWidget.value) > 0.8) {
		setWidgetValue(node, "pause_after_speaker", "0.4");
	}
	for (const [name, config] of Object.entries(NUMBER_DEFAULTS)) {
		coerceNumberWidget(node, name, config);
	}
	for (const [name, fallback] of Object.entries(BOOLEAN_DEFAULTS)) {
		coerceBooleanWidget(node, name, fallback);
	}
	applyQwenParamPreset(node);
	const minSegment = widget(node, "segment_min_chars");
	const maxSegment = widget(node, "segment_max_chars");
	if (minSegment && maxSegment && Number(minSegment.value) > Number(maxSegment.value)) {
		setWidgetValue(node, "segment_min_chars", String(maxSegment.value));
	}
	const text = widget(node, "text");
	if (text && typeof text.value !== "string") setWidgetValue(node, "text", String(text.value ?? ""));
	syncButtons(node);
}

function wirePanel(node, state) {
	state.open.addEventListener("click", () => state.fileInput.click());
	state.fileInput.addEventListener("change", async () => {
		const file = state.fileInput.files?.[0];
		if (!file) return;
		if (file.type.startsWith("text/") || /\.(txt|srt|vtt|lrc|json)$/i.test(file.name)) {
			setWidgetValue(node, "text", await file.text());
		} else {
			setStatus(node, "正在导入参考音频…", 12);
			const body = new FormData();
			body.append("file", file, file.name);
			try {
				const response = await fetch(IMPORT_MEDIA_ENDPOINT, { method: "POST", body });
				const data = await response.json();
				if (!response.ok || !data?.ok) {
					if (data?.report && globalThis.GJJ_CommonDependencyModelNotice?.applyNotice) {
						globalThis.GJJ_CommonDependencyModelNotice.applyNotice(node, data.report, { detailed: true, dismissible: false });
					}
					throw new Error(data?.error || "导入失败");
				}
				setWidgetValue(node, "local_audio_name", data.name || "");
				if (data.name) {
					ensureProperties(node);
					const currentOrder = Array.isArray(node.properties.local_audio_order) ? node.properties.local_audio_order : [];
					node.properties.local_audio_order = [data.name, ...currentOrder.filter((item) => item !== data.name)];
					syncLocalAudioOrderStorage(node);
				}
				setStatus(node, data.is_video ? "已提取视频音频作为参考音频" : "已导入参考音频", 100);
			} catch (error) {
				setStatus(node, `导入失败：${error?.message || error}`, 100);
			}
		}
		state.fileInput.value = "";
	});
	state.keep.addEventListener("click", () => {
		node.properties.keep_model_loaded = !node.properties.keep_model_loaded;
		syncButtons(node);
		node.graph?.change?.();
	});
	state.seed.addEventListener("click", () => {
		node.properties.random_seed = !node.properties.random_seed;
		syncButtons(node);
		node.graph?.change?.();
	});
	state.branch.addEventListener("click", () => {
		toggleBranchMenu(node);
	});
	state.output.addEventListener("click", () => {
		toggleOutputPanel(node);
	});
	state.settings.addEventListener("click", () => {
		toggleSettingsPanel(node);
	});
	state.mp3.addEventListener("click", () => toggleMp3List(node));
	state.terms.addEventListener("click", () => toggleTermsLibrary(node));
	state.reset.addEventListener("click", () => resetUniversalTTSNode(node));
	state.generate.addEventListener("click", async () => {
		const original = state.generate.textContent;
		const originalWidth = state.generate.style.width;
		const originalMinWidth = state.generate.style.minWidth;
		state.generate.textContent = "生成中…";
		state.generate.style.width = "74px";
		state.generate.style.minWidth = "74px";
		state.generate.disabled = true;
		setStatus(node, "正在生成语音…", 5);
		try {
			syncLinkedSynthesisText(node);
			normalizeRuntimeWidgetValues(node);
			applyWidgetVisibility(node);
			await queueOnlyCurrentNode(node);
		} finally {
			setTimeout(() => {
				state.generate.textContent = original;
				state.generate.style.width = originalWidth;
				state.generate.style.minWidth = originalMinWidth;
				state.generate.disabled = false;
			}, 500);
		}
	});
	state.link.addEventListener("click", () => toggleDetachLinks(node));
}

function updateLinkButton(node) {
	syncButtons(node);
}

function copyLinkedInputValue(node, input, link) {
	const targetName = widgetNameForInput(input);
	if (!targetName) return "";
	const origin = link ? app.graph?.getNodeById?.(link.origin_id) : null;
	const value = textValueFromNode(origin);
	if (!value) return "";
	setWidgetValue(node, targetName, value);
	return targetName;
}

function toggleDetachLinks(node) {
	ensureProperties(node);
	const stored = node.properties.detached_links || {};
	if (Object.keys(stored).length) {
		normalizePairs(node);
		for (const item of Object.values(stored)) {
			const input = node.inputs?.find((slot) => slot.name === item.inputName);
			if (!input || input.link) continue;
			const origin = app.graph?.getNodeById?.(item.originId);
			if (origin?.connect) origin.connect(item.originSlot, node, node.inputs.indexOf(input));
		}
		node.properties.detached_links = {};
	} else {
		const next = {};
		for (const input of node.inputs || []) {
			if (!input.link) continue;
			const link = app.graph?.links?.[input.link];
			if (!link) continue;
			const copiedTo = copyLinkedInputValue(node, input, link);
			next[input.name] = { inputName: input.name, originId: link.origin_id, originSlot: link.origin_slot, copiedTo };
			node.disconnectInput(node.inputs.indexOf(input));
		}
		node.properties.detached_links = next;
	}
	normalizePairs(node);
	applyWidgetVisibility(node);
	syncButtons(node);
	node.graph?.change?.();
}

function applyWidgetVisibility(node) {
	ensureProperties(node);
	for (const w of node.widgets || []) {
		if (!COMMON_WIDGETS.has(w.name)) continue;
		const visible = !PANEL_MANAGED_WIDGETS.has(w.name) && CORE_WIDGETS.has(w.name);
		if (visible) showWidget(w);
		else hideWidget(w);
	}
	renderEdgeSpeakerVoicePanel(node);
	compactTextWidget(node);
	refresh(node);
}

function setupNode(node) {
	if (!isTarget(node)) return;
	safePatchNode(node);
	requestAnimationFrame(() => {
		normalizePairs(node);
		normalizeRuntimeWidgetValues(node);
		applyWidgetVisibility(node);
		compactTextWidget(node);
	});
	setTimeout(() => {
		normalizePairs(node);
		normalizeRuntimeWidgetValues(node);
		applyWidgetVisibility(node);
		compactTextWidget(node);
	}, 120);
}

function setStatus(node, text, progress = null) {
	const s = ensurePanel(node);
	s.progress.style.display = "";
	s.label.textContent = String(text || "");
	const value = Number(progress);
	const pct = Number.isFinite(value) ? (value <= 1 ? value * 100 : value) : 0;
	s.bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
	refresh(node);
}

function buildViewUrl(item) {
	const params = new URLSearchParams();
	params.set("filename", item.filename || "");
	params.set("type", item.type || "output");
	if (item.subfolder) params.set("subfolder", item.subfolder);
	params.set("rand", String(Date.now()));
	return `/view?${params.toString()}`;
}

function ensureAudio(node) {
	if (node.__gjjUniversalTTSAudio) return node.__gjjUniversalTTSAudio;
	const box = document.createElement("div");
	box.style.cssText = "display:none;padding:8px;border:1px solid #41535b;border-radius:7px;background:#22282d";
	const audio = document.createElement("audio");
	audio.controls = true;
	audio.autoplay = true;
	audio.preload = "auto";
	audio.style.cssText = "display:block;width:100%;height:34px";
	box.append(audio);
	const widgetRef = node.addDOMWidget?.(AUDIO_WIDGET, AUDIO_WIDGET, box, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => (box.style.display === "none" ? 0 : 54),
	});
	node.__gjjUniversalTTSAudio = { box, audio, widget: widgetRef, queue: [], playingQueued: false };
	audio.addEventListener("ended", () => playNextQueuedAudio(node));
	audio.addEventListener("error", () => playNextQueuedAudio(node));
	return node.__gjjUniversalTTSAudio;
}

function extractAudioItem(message) {
	const list = message?.audio;
	if (!Array.isArray(list) || !list.length) return null;
	const first = list[0];
	if (typeof first === "string") return { filename: first, type: "output" };
	return first?.filename ? first : null;
}

function setAudioPreview(node, message) {
	const item = extractAudioItem(message);
	if (!item) return;
	const state = ensureAudio(node);
	const entry = { item };
	if (state.playingQueued && !state.audio.ended) {
		state.queue.push(entry);
		return;
	}
	playQueuedAudioEntry(node, entry);
}

function playQueuedAudioEntry(node, entry) {
	const state = ensureAudio(node);
	const item = entry?.item;
	if (!item) return;
	state.playingQueued = true;
	state.audio.src = buildViewUrl(item);
	state.box.style.display = "";
	state.audio.currentTime = 0;
	state.audio.play?.().catch?.(() => {
		state.playingQueued = false;
	});
	refresh(node);
}

function playNextQueuedAudio(node) {
	const state = ensureAudio(node);
	const next = state.queue.shift();
	if (next) {
		playQueuedAudioEntry(node, next);
		return;
	}
	state.playingQueued = false;
}

function clearAudioPreview(node) {
	const state = node?.__gjjUniversalTTSAudio;
	if (!state) return;
	state.queue = [];
	state.playingQueued = false;
	try { state.audio.pause?.(); } catch (_) {}
	try {
		state.audio.removeAttribute("src");
		state.audio.load?.();
	} catch (_) {
		state.audio.src = "";
	}
	state.box.style.display = "none";
}

function resetUniversalTTSNode(node) {
	const s = ensurePanel(node);
	closeUniversalPopups(node);
	clearAudioPreview(node);
	s.progress.style.display = "none";
	s.label.textContent = "";
	s.bar.style.width = "0%";
	s.outputPanel.style.display = "none";
	s.outputPanel.replaceChildren();
	s.speakerPanel.style.display = "none";
	s.speakerPanel.replaceChildren();
	s.fileInput.value = "";
	node.properties.settings_open = false;
	normalizePairs(node);
	normalizeRuntimeWidgetValues(node);
	applyWidgetVisibility(node);
	compactTextWidget(node);
	syncButtons(node);
	refresh(node);
	node.graph?.change?.();
}

function makeSelectRow(node, labelText, widgetName) {
	const row = document.createElement("label");
	row.style.cssText = "display:flex;align-items:center;gap:8px;margin:4px 0";
	const label = document.createElement("span");
	label.textContent = labelText;
	label.style.cssText = "width:70px;color:#c9d6dc;white-space:nowrap";
	const select = document.createElement("select");
	const w = widget(node, widgetName);
	const values = optionValues(w);
	select.style.cssText = "flex:1;min-width:0;background:#2b3035;color:#f4fbff;border:1px solid #465862;border-radius:5px;padding:4px 6px";
	for (const value of values.length ? values : [w?.value ?? ""]) {
		const option = document.createElement("option");
		option.value = String(value);
		option.textContent = String(value);
		select.append(option);
	}
	select.value = String(w?.value ?? "");
	select.addEventListener("pointerdown", (event) => event.stopPropagation());
	select.addEventListener("mousedown", (event) => event.stopPropagation());
	select.addEventListener("change", () => {
		setWidgetValue(node, widgetName, select.value);
		syncButtons(node);
		refresh(node);
	});
	row.append(label, select);
	return row;
}

const SETTING_LABELS = {
	model_name: "模型",
	edge_voice: "Edge音色",
	custom_voice: "自定义音色",
	speed: "语速",
	pitch: "音调",
	language: "语言",
	device: "设备",
	precision: "精度",
	steps: "步数",
	guidance_strength: "引导强度",
	pause_after_speaker: "停顿",
	seed: "种子",
	mp3_filename_prefix: "音频前缀",
	mp3_quality: "MP3质量",
	audio_format: "音频格式",
	qwen_instruct: "Instruct",
	fail_mode: "失败处理",
	segment_min_chars: "最短分段",
	segment_max_chars: "最长分段",
	qwen_max_new_tokens: "最大Token",
	qwen_top_p: "Top-P",
	qwen_top_k: "Top-K",
	qwen_temperature: "温度",
	qwen_repetition_penalty: "重复惩罚",
	qwen_x_vector_only: "仅音色向量",
	emotion_prompt: "情感描述",
};

function closeUniversalPopup(node, key) {
	const s = node?.__gjjUniversalTTS;
	const popup = s?.[key];
	if (!popup) return;
	popup.remove?.();
	s[key] = null;
	if (key === "settingsPopup") node.properties.settings_open = false;
}

function closeUniversalPopups(node, except = "") {
	const s = node?.__gjjUniversalTTS;
	if (!s) return;
	for (const key of ["branchPopup", "mp3Popup", "termsPopup", "outputPopup", "settingsPopup"]) {
		if (key !== except) closeUniversalPopup(node, key);
	}
	syncButtons(node);
}

function createToolbarPopup(titleText, width = 300) {
	const popup = document.createElement("div");
	popup.style.cssText = [
		"position:fixed", "z-index:100000", `width:${width}px`, "max-width:calc(100vw - 16px)",
		"padding:8px", "border:1px solid #526873", "border-radius:8px",
		"background:#10171b", "box-shadow:0 12px 28px rgba(0,0,0,.42)",
		"color:#dce7e2", "font:12px/1.35 ui-sans-serif,system-ui,'Microsoft YaHei',sans-serif",
	].join(";");
	const head = document.createElement("div");
	head.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px";
	const title = document.createElement("div");
	title.textContent = titleText;
	title.style.cssText = "font-weight:700;color:#edf7fb";
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "确定";
	close.style.cssText = "padding:4px 8px;border:1px solid #6ea6cf;border-radius:6px;background:#245477;color:#f4fbff;cursor:pointer;font-weight:700";
	head.append(title, close);
	popup.append(head);
	popup.addEventListener("pointerdown", (event) => event.stopPropagation());
	popup.addEventListener("mousedown", (event) => event.stopPropagation());
	return { popup, close };
}

function positionToolbarPopup(popup, anchor, fallbackWidth = 300) {
	document.body.append(popup);
	const rect = anchor.getBoundingClientRect();
	const width = popup.offsetWidth || fallbackWidth;
	const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.left));
	const top = Math.min(window.innerHeight - popup.offsetHeight - 8, Math.max(8, rect.bottom + 6));
	popup.style.left = `${left}px`;
	popup.style.top = `${top}px`;
}

function settingWidgetNames(node) {
	const branch = String(widget(node, "branch")?.value || "EdgeTTS");
	const visiblePrivate = BRANCH_PRIVATE[branch] || new Set();
	const names = new Set([...visiblePrivate, ...SETTINGS_COMMON_WIDGETS]);
	const audioFormat = String(widget(node, "audio_format")?.value || "WAV");
	return SERIALIZED_WIDGET_ORDER.filter((name) => names.has(name) && widget(node, name) && !(name === "mp3_quality" && audioFormat === "WAV"));
}

function makeSettingsRow(node, name) {
	const w = widget(node, name);
	const row = document.createElement("label");
	row.style.cssText = "display:flex;align-items:flex-start;gap:8px;margin:5px 0";
	const label = document.createElement("span");
	label.textContent = SETTING_LABELS[name] || name;
	label.style.cssText = "width:72px;color:#c9d6dc;white-space:nowrap;padding-top:5px";
	const values = optionValues(w);
	let control;
	const commit = (value) => {
		setWidgetValue(node, name, value);
		normalizeRuntimeWidgetValues(node);
		syncButtons(node);
		refreshDependencyNotice(node);
	};
	if (Object.prototype.hasOwnProperty.call(BOOLEAN_DEFAULTS, name)) {
		control = document.createElement("input");
		control.type = "checkbox";
		control.checked = boolValue(w?.value, BOOLEAN_DEFAULTS[name]);
		control.style.cssText = "margin-top:7px;width:16px;height:16px;accent-color:#58a6d6";
		control.addEventListener("change", () => commit(control.checked));
	} else if (values.length) {
		control = document.createElement("select");
		control.style.cssText = "flex:1;min-width:0;background:#2b3035;color:#f4fbff;border:1px solid #465862;border-radius:5px;padding:4px 6px";
		for (const value of values) {
			const option = document.createElement("option");
			option.value = String(value);
			option.textContent = String(value);
			control.append(option);
		}
		control.value = String(w?.value ?? "");
		control.addEventListener("change", () => commit(control.value));
	} else if (NUMBER_DEFAULTS[name]) {
		const config = NUMBER_DEFAULTS[name];
		control = document.createElement("input");
		control.type = "number";
		control.value = String(w?.value ?? config.value ?? "");
		if (Number.isFinite(config.min)) control.min = String(config.min);
		if (Number.isFinite(config.max)) control.max = String(config.max);
		control.step = config.int ? "1" : String(10 ** -(config.decimals || 2));
		control.style.cssText = "flex:1;min-width:0;background:#2b3035;color:#f4fbff;border:1px solid #465862;border-radius:5px;padding:5px 6px";
		control.addEventListener("change", () => commit(control.value));
	} else {
		const multiline = Boolean(w?.options?.multiline);
		control = multiline ? document.createElement("textarea") : document.createElement("input");
		if (!multiline) control.type = "text";
		control.value = String(w?.value ?? "");
		control.style.cssText = "flex:1;min-width:0;background:#2b3035;color:#f4fbff;border:1px solid #465862;border-radius:5px;padding:5px 6px;box-sizing:border-box";
		if (multiline) {
			control.rows = 3;
			control.style.resize = "vertical";
		}
		control.addEventListener("input", () => {
			setWidgetValue(node, name, control.value);
			syncButtons(node);
		});
		control.addEventListener("change", () => refreshDependencyNotice(node));
	}
	control.addEventListener("pointerdown", (event) => event.stopPropagation());
	control.addEventListener("mousedown", (event) => event.stopPropagation());
	row.append(label, control);
	return row;
}

function toggleBranchMenu(node) {
	const s = ensurePanel(node);
	closeUniversalPopups(node, "branchPopup");
	if (s.branchPopup) {
		closeUniversalPopup(node, "branchPopup");
		syncButtons(node);
		return;
	}
	const branchWidget = widget(node, "branch");
	const current = String(branchWidget?.value || "EdgeTTS");
	const values = optionValues(branchWidget).length ? optionValues(branchWidget) : BRANCH_VALUES;
	const popup = document.createElement("div");
	popup.style.cssText = [
		"position:fixed", "z-index:100000", "min-width:220px", "max-width:300px",
		"padding:8px", "border:1px solid #526873", "border-radius:8px",
		"background:#10171b", "box-shadow:0 12px 28px rgba(0,0,0,.42)",
		"color:#dce7e2", "font:12px/1.35 ui-sans-serif,system-ui,'Microsoft YaHei',sans-serif",
	].join(";");
	const title = document.createElement("div");
	title.textContent = "生成分支";
	title.style.cssText = "font-weight:700;color:#edf7fb;margin-bottom:6px";
	const list = document.createElement("div");
	list.style.cssText = "display:flex;flex-direction:column;gap:5px";
	for (const value of values) {
		const item = document.createElement("button");
		item.type = "button";
		item.textContent = branchDisplayName(value);
		item.title = String(value);
		const active = String(value) === current;
		item.style.cssText = [
			"width:100%", "box-sizing:border-box", "text-align:left", "padding:6px 8px",
			"border-radius:6px", "cursor:pointer", "font:600 12px/1.3 ui-sans-serif,system-ui,'Microsoft YaHei',sans-serif",
			`border:1px solid ${active ? "#78b8e8" : "#40515a"}`,
			`background:${active ? "#254761" : "#1b252a"}`,
			`color:${active ? "#ffffff" : "#d9e7ec"}`,
		].join(";");
		item.addEventListener("pointerdown", (event) => event.stopPropagation());
		item.addEventListener("mousedown", (event) => event.stopPropagation());
		item.addEventListener("click", () => {
			setWidgetValue(node, "branch", String(value));
			normalizeRuntimeWidgetValues(node);
			saveBranchPreset(node);
			if (s.branchPopup) {
				s.branchPopup.remove();
				s.branchPopup = null;
			}
			applyWidgetVisibility(node);
			refreshDependencyNotice(node);
			syncButtons(node);
		});
		list.append(item);
	}
	popup.append(title, list);
	popup.addEventListener("pointerdown", (event) => event.stopPropagation());
	popup.addEventListener("mousedown", (event) => event.stopPropagation());
	document.body.append(popup);
	const rect = s.branch.getBoundingClientRect();
	const width = popup.offsetWidth || 240;
	const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.left));
	const top = Math.min(window.innerHeight - popup.offsetHeight - 8, Math.max(8, rect.bottom + 6));
	popup.style.left = `${left}px`;
	popup.style.top = `${top}px`;
	const close = (event) => {
		if (popup.contains(event.target) || s.branch.contains(event.target)) return;
		popup.remove();
		s.branchPopup = null;
		document.removeEventListener("pointerdown", close, true);
		syncButtons(node);
	};
	setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
	s.branchPopup = popup;
	syncButtons(node);
}

function toggleOutputPanel(node) {
	const s = ensurePanel(node);
	closeUniversalPopups(node, "outputPopup");
	s.outputPanel.style.display = "none";
	if (s.outputPopup) {
		closeUniversalPopup(node, "outputPopup");
		syncButtons(node);
		refresh(node);
		return;
	}
	const { popup, close } = createToolbarPopup("输出口内容", 300);
	const body = document.createElement("div");
	body.style.cssText = "display:flex;flex-direction:column;gap:4px";
	body.append(
		makeSelectRow(node, "音频输出", "audio_output_mode"),
		makeSelectRow(node, "文本输出", "timeline_format"),
	);
	popup.append(body);
	close.addEventListener("click", () => {
		closeUniversalPopup(node, "outputPopup");
		syncButtons(node);
	});
	positionToolbarPopup(popup, s.output, 300);
	s.outputPopup = popup;
	syncButtons(node);
	refresh(node);
}

function toggleSettingsPanel(node) {
	const s = ensurePanel(node);
	closeUniversalPopups(node, "settingsPopup");
	if (s.settingsPopup) {
		closeUniversalPopup(node, "settingsPopup");
		applyWidgetVisibility(node);
		syncButtons(node);
		return;
	}
	node.properties.settings_open = true;
	const branch = String(widget(node, "branch")?.value || "EdgeTTS");
	const { popup, close } = createToolbarPopup(`${branchDisplayName(branch)} 参数`, 340);
	const body = document.createElement("div");
	body.style.cssText = "max-height:420px;overflow:auto;display:flex;flex-direction:column;gap:2px";
	const names = settingWidgetNames(node);
	if (names.length) {
		for (const name of names) body.append(makeSettingsRow(node, name));
	} else {
		const empty = document.createElement("div");
		empty.textContent = "当前分支没有可调参数";
		empty.style.cssText = "padding:8px;color:#91a3ad";
		body.append(empty);
	}
	popup.append(body);
	close.addEventListener("click", () => {
		closeUniversalPopup(node, "settingsPopup");
		applyWidgetVisibility(node);
		syncButtons(node);
	});
	positionToolbarPopup(popup, s.settings, 340);
	s.settingsPopup = popup;
	applyWidgetVisibility(node);
	syncButtons(node);
}

async function toggleTermsLibrary(node) {
	const s = ensurePanel(node);
	closeUniversalPopups(node, "termsPopup");
	if (s.termsPopup) {
		closeUniversalPopup(node, "termsPopup");
		syncButtons(node);
		return;
	}
	const { popup, close } = createToolbarPopup("术语库", 520);
	const body = document.createElement("div");
	body.style.cssText = "display:flex;flex-direction:column;gap:6px";
	const hint = document.createElement("div");
	hint.textContent = "保存为 TSV：原术语<TAB>替换读法";
	hint.style.cssText = "color:#9fb0bd";
	const tableWrap = document.createElement("div");
	tableWrap.style.cssText = "height:280px;overflow:auto;border:1px solid #526873;border-radius:6px;background:#172126";
	const table = document.createElement("table");
	table.style.cssText = "width:100%;border-collapse:collapse;table-layout:fixed";
	const thead = document.createElement("thead");
	thead.style.cssText = "position:sticky;top:0;background:#203039;z-index:1";
	const headRow = document.createElement("tr");
	const rowsBody = document.createElement("tbody");
	const sortState = { key: "source", asc: true };
	let termRows = [];
	const parseTerms = (text) => String(text || "")
		.split(/\r?\n/)
		.map((line) => line.trim() ? line.split("\t", 2) : null)
		.filter((parts) => parts && parts.length === 2 && !String(parts[0] || "").trim().startsWith("#"))
		.map(([source, target]) => ({ source: String(source || "").trim(), target: String(target || "").trim() }));
	const serializeTerms = () => {
		const lines = ["# 原术语\t替换读法"];
		for (const row of termRows) {
			const source = String(row.source || "").trim();
			const target = String(row.target || "").trim();
			if (source || target) lines.push(`${source}\t${target}`);
		}
		return `${lines.join("\n")}\n`;
	};
	const addHeader = (label, key) => {
		const th = document.createElement("th");
		th.style.cssText = "padding:6px;text-align:left;border-bottom:1px solid #526873;color:#d9edf6;font-weight:700";
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = label;
		btn.style.cssText = "width:100%;text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;font-weight:700";
		btn.addEventListener("click", () => {
			sortState.asc = sortState.key === key ? !sortState.asc : true;
			sortState.key = key;
			termRows.sort((a, b) => String(a[key] || "").localeCompare(String(b[key] || ""), "zh-Hans-CN") * (sortState.asc ? 1 : -1));
			renderRows();
		});
		th.append(btn);
		headRow.append(th);
	};
	addHeader("原术语", "source");
	addHeader("替换读法", "target");
	const actionHead = document.createElement("th");
	actionHead.style.cssText = "width:44px;padding:6px;border-bottom:1px solid #526873";
	headRow.append(actionHead);
	thead.append(headRow);
	table.append(thead, rowsBody);
	tableWrap.append(table);
	const makeCellInput = (row, key) => {
		const input = document.createElement("input");
		input.type = "text";
		input.value = row[key] || "";
		input.style.cssText = "width:100%;box-sizing:border-box;border:1px solid #3d4e57;border-radius:4px;background:#10191e;color:#f0f7f8;padding:5px 6px;font:12px/1.35 ui-monospace,Consolas,monospace";
		input.addEventListener("input", () => { row[key] = input.value; });
		return input;
	};
	function renderRows() {
		rowsBody.replaceChildren();
		termRows.forEach((row, index) => {
			const tr = document.createElement("tr");
			for (const key of ["source", "target"]) {
				const td = document.createElement("td");
				td.style.cssText = "padding:4px 6px;border-bottom:1px solid rgba(82,104,115,.35)";
				td.append(makeCellInput(row, key));
				tr.append(td);
			}
			const action = document.createElement("td");
			action.style.cssText = "padding:4px 6px;border-bottom:1px solid rgba(82,104,115,.35);text-align:center";
			const remove = document.createElement("button");
			remove.type = "button";
			remove.textContent = "×";
			remove.title = "删除";
			remove.style.cssText = "width:24px;height:24px;border:1px solid #526873;border-radius:5px;background:#2b3035;color:#f4fbff;cursor:pointer";
			remove.addEventListener("click", () => {
				termRows.splice(index, 1);
				renderRows();
			});
			action.append(remove);
			tr.append(action);
			rowsBody.append(tr);
		});
	}
	const addRow = document.createElement("button");
	addRow.type = "button";
	addRow.textContent = "添加术语";
	addRow.style.cssText = "align-self:flex-start;padding:5px 9px;border:1px solid #526873;border-radius:6px;background:#203039;color:#f4fbff;cursor:pointer";
	addRow.addEventListener("click", () => {
		termRows.push({ source: "", target: "" });
		renderRows();
	});
	const status = document.createElement("div");
	status.style.cssText = "min-height:16px;color:#91c7e8";
	body.append(hint, tableWrap, addRow, status);
	popup.append(body);
	status.textContent = "加载中…";
	try {
		const response = await fetch(TERMS_ENDPOINT);
		const data = await response.json();
		termRows = parseTerms(data?.text || "");
		if (!termRows.length) termRows.push({ source: "", target: "" });
		renderRows();
		status.textContent = data?.path ? `文件：${data.path}` : "";
	} catch (error) {
		termRows = [{ source: "", target: "" }];
		renderRows();
		status.textContent = `读取失败：${error?.message || error}`;
	}
	close.textContent = "保存";
	close.addEventListener("click", async () => {
		try {
			const response = await fetch(TERMS_ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text: serializeTerms() }),
			});
			const data = await response.json();
			if (!response.ok || data?.ok === false) throw new Error(data?.error || "保存失败");
			status.textContent = "已保存";
			closeUniversalPopup(node, "termsPopup");
			syncButtons(node);
		} catch (error) {
			status.textContent = `保存失败：${error?.message || error}`;
		}
	});
	positionToolbarPopup(popup, s.terms, 520);
	s.termsPopup = popup;
	syncButtons(node);
}

function toggleMp3List(node) {
	const s = ensurePanel(node);
	closeUniversalPopups(node, "mp3Popup");
	if (s.mp3Popup) {
		closeUniversalPopup(node, "mp3Popup");
		syncButtons(node);
		return;
	}
	const branch = String(widget(node, "branch")?.value || "EdgeTTS");
	const isTtsLibrary = isTtsVoiceLibraryBranch(branch);
	const isEdge = branch === "EdgeTTS";
	const primaryWidgetName = isEdge ? "edge_voice" : (isTtsLibrary ? "custom_voice" : "local_audio_name");
	const w = widget(node, primaryWidgetName);
	const baseValues = branch === "Qwen3-CustomVoice" ? QWEN_CUSTOM_VOICES : ((isEdge || !isTtsLibrary) ? optionValues(w) : []);
	const audioLibraryValues = new Set();
	const audioMeta = new Map();
	const characterMatches = new Map();
	let characterVoiceDefaults = [];
	let characterDefaultsApplied = false;
	const applyCharacterDefaults = () => {
		if (characterDefaultsApplied || !characterVoiceDefaults.length) return;
		const current = selectedOrder();
		if (!isTtsLibrary && current.length >= characterVoiceDefaults.length) {
			characterDefaultsApplied = true;
			return;
		}
		const next = [...new Set([...characterVoiceDefaults, ...current])];
		if (next.join("\n") !== current.join("\n")) saveOrder(next);
		characterDefaultsApplied = true;
		render();
	};
	if (!isTtsLibrary) {
		fetch(AUDIO_LIBRARY_ENDPOINT)
			.then((response) => response.json())
			.then((data) => {
				for (const item of data?.items || []) {
					if (item?.name) {
						const name = String(item.name);
						audioLibraryValues.add(name);
						audioMeta.set(name, item);
					}
				}
				render();
			})
			.catch(() => {});
		loadCharacterLibraryForTTS().then((characters) => {
			const valueList = allValues();
			const values = new Set(valueList);
			const normalizedValueMap = new Map(valueList.map((value) => [normalizeVoicePath(value), value]));
			const entries = speakerEntriesForLibrary(node);
			const voiceCounts = new Map();
			for (const entry of entries) {
				const voice = normalizeVoicePath(characterForSpeaker(entry, characters)?.voice_path);
				if (voice) voiceCounts.set(voice, (voiceCounts.get(voice) || 0) + 1);
			}
			const duplicateVoicePaths = new Set([...voiceCounts.entries()].filter(([, count]) => count > 1).map(([voice]) => voice));
			characterMatches.clear();
			for (const entry of entries) {
				const character = characterForSpeaker(entry, characters);
				if (character) characterMatches.set(Math.max(0, Number(entry.index) || 0), character);
			}
			characterVoiceDefaults = entries
				.map((entry) => characterVoiceForSpeakerFromValues(entry, characters, valueList, duplicateVoicePaths))
				.map((voice) => normalizedValueMap.get(normalizeVoicePath(voice)) || "")
				.filter((voice) => voice && values.has(voice));
			applyCharacterDefaults();
			render();
		});
	}
	const allValues = () => {
		const manualValues = readEdgeVoiceOrder(node, branch);
		const primaryValue = String(widget(node, primaryWidgetName)?.value || "").trim();
		const values = [...new Set([...(baseValues || []), ...audioLibraryValues, ...manualValues, primaryValue].map((item) => String(item || "").trim()).filter(Boolean))];
		return audioLibraryValues.size ? values.filter((item) => !item.startsWith("[未找到 models/GJJ/wav")) : values;
	};
	const selectedOrder = () => {
		ensureProperties(node);
		const values = allValues();
		const known = new Set(values);
		if (isTtsLibrary) {
			let order = readEdgeVoiceOrder(node, branch).filter((item) => known.has(item));
			const legacy = String(widget(node, primaryWidgetName)?.value || "").trim();
			if (legacy && known.has(legacy) && !order.includes(legacy)) order = [legacy, ...order];
			return [...new Set(order)];
		}
		let order = Array.isArray(node.properties.local_audio_order) ? node.properties.local_audio_order.map((item) => String(item || "").trim()).filter((item) => item && known.has(item)) : [];
		const legacy = String(widget(node, "local_audio_name")?.value || "").trim();
		if (legacy && known.has(legacy) && !order.includes(legacy)) order = [legacy, ...order];
		node.properties.local_audio_order = [...new Set(order)];
		return node.properties.local_audio_order;
	};
	const saveOrder = (order) => {
		const cleaned = [...new Set(order.filter(Boolean))];
		if (isTtsLibrary) {
			writeEdgeVoiceOrder(node, branch, cleaned);
			if (cleaned[0]) setWidgetValue(node, primaryWidgetName, cleaned[0]);
		} else {
			node.properties.local_audio_order = cleaned;
			syncLocalAudioOrderStorage(node);
			setWidgetValue(node, "local_audio_name", node.properties.local_audio_order[0] || "");
		}
		node.graph?.change?.();
	};
	const popup = document.createElement("div");
	popup.style.cssText = [
		"position:fixed", "z-index:100000", `width:${branch === "Qwen3-CustomVoice" ? 430 : 300}px`, "max-width:calc(100vw - 16px)",
		"padding:8px", "border:1px solid #526873", "border-radius:8px",
		"background:#10171b", "box-shadow:0 12px 28px rgba(0,0,0,.42)",
		"color:#dce7e2", "font:12px/1.35 ui-sans-serif,system-ui,'Microsoft YaHei',sans-serif",
	].join(";");
	const head = document.createElement("div");
	head.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px";
	const title = document.createElement("div");
	title.textContent = isTtsLibrary ? `${branchDisplayName(branch)} 音色库` : "本地参考语音表";
	title.style.cssText = "font-weight:700;color:#edf7fb";
	const clearBtn = document.createElement("button");
	clearBtn.type = "button";
	clearBtn.textContent = "清空";
	clearBtn.style.cssText = "padding:4px 7px;border:1px solid #40515a;border-radius:6px;background:#1b252a;color:#d9e7ec;cursor:pointer";
	const sortBtn = document.createElement("button");
	sortBtn.type = "button";
	sortBtn.style.cssText = "padding:4px 7px;border:1px solid #40515a;border-radius:6px;background:#1b252a;color:#d9e7ec;cursor:pointer";
	const confirmBtn = document.createElement("button");
	confirmBtn.type = "button";
	confirmBtn.textContent = "确定";
	confirmBtn.style.cssText = "padding:4px 8px;border:1px solid #6ea6cf;border-radius:6px;background:#245477;color:#f4fbff;cursor:pointer;font-weight:700";
	const actions = document.createElement("div");
	actions.style.cssText = "display:flex;gap:5px;align-items:center";
	actions.append(clearBtn, sortBtn, confirmBtn);
	head.append(title, actions);
	const speakerBox = document.createElement("div");
	speakerBox.style.cssText = "margin:0 0 5px 0;padding:5px 6px;border:1px solid #33444d;border-radius:6px;background:#0b1114;display:flex;flex-direction:column;gap:2px;max-height:92px;overflow:auto";
	const input = document.createElement("input");
	input.placeholder = isTtsLibrary && !isEdge ? "输入音色名后回车添加" : "过滤关键词";
	input.style.cssText = "box-sizing:border-box;width:100%;margin-bottom:6px;background:#0b1114;color:#e5f3f7;border:1px solid #41535b;border-radius:5px;padding:6px";
	const list = document.createElement("div");
	list.style.cssText = "max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:4px";
	const renderSpeakers = (selected) => {
		speakerBox.replaceChildren();
		const entries = speakerEntriesForLibrary(node);
		const titleLine = document.createElement("div");
		titleLine.textContent = "说话人 → 音色";
		titleLine.style.cssText = "font-weight:700;color:#edf7fb;margin-bottom:1px;font-size:11px";
		speakerBox.append(titleLine);
		for (const entry of entries) {
			const index = Math.max(0, Number(entry.index) || 0);
			const voice = selected.length ? selected[index % selected.length] : "";
			const character = characterMatches.get(index);
			const row = document.createElement("div");
			const text = `${entry.label || `说话人${index + 1}`}  →  ${voice ? voiceDisplayLabel(branch, voice) : "未选择"}`;
			row.title = character ? `${character.name || character.id || entry.label}\n${text}` : text;
			row.style.cssText = "display:flex;align-items:center;gap:5px;min-width:0;color:#c9d6dc;font-size:11px;line-height:1.25";
			if (character?.cover) {
				const img = document.createElement("img");
				img.src = character.cover;
				img.alt = String(character.name || entry.label || "角色");
				img.style.cssText = "width:22px;height:22px;border-radius:4px;object-fit:cover;flex:0 0 auto;border:1px solid #3b515a;background:#172228";
				row.append(img);
			}
			const label = document.createElement("div");
			label.textContent = text;
			label.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0";
			row.append(label);
			speakerBox.append(row);
		}
	};
	const render = () => {
		const key = input.value.trim().toLowerCase();
		const values = allValues();
		s.mp3SortMode = normalizeLocalAudioSortMode(s.mp3SortMode || (s.mp3SortAsc ? "name_asc" : "name_desc"));
		s.mp3SortAsc = s.mp3SortMode !== "name_desc";
		sortBtn.textContent = librarySortLabel(s.mp3SortMode);
		sortBtn.title = "排序：A-Z / Z-A / ⏰日期 / 💾磁盘空间";
		list.replaceChildren();
		const selected = selectedOrder();
		renderSpeakers(selected);
		const selectedSet = new Set(selected);
		const compare = (a, b) => {
			const mode = normalizeLocalAudioSortMode(s.mp3SortMode);
			const ma = audioMeta.get(a) || {};
			const mb = audioMeta.get(b) || {};
			if (mode === "date_desc" || mode === "date_asc") {
				const diff = Number(mb.mtime || 0) - Number(ma.mtime || 0);
				return mode === "date_desc" ? diff : -diff;
			}
			if (mode === "size_desc" || mode === "size_asc") {
				const diff = Number(mb.size || 0) - Number(ma.size || 0);
				return mode === "size_desc" ? diff : -diff;
			}
			return mode === "name_desc" ? b.localeCompare(a) : a.localeCompare(b);
		};
		const remaining = values.filter((value) => !selectedSet.has(value));
		const matched = remaining
			.filter((value) => !key || value.toLowerCase().includes(key))
			.sort(compare);
		const others = key
			? remaining.filter((value) => !value.toLowerCase().includes(key)).sort(compare)
			: [];
		const ordered = [...selected, ...matched, ...others];
		clearBtn.disabled = !selected.length;
		clearBtn.style.opacity = selected.length ? "1" : ".55";
		if (!ordered.length) {
			const empty = document.createElement("div");
			empty.textContent = "没有可用音色";
			empty.style.cssText = "padding:8px;color:#91a3ad";
			list.append(empty);
			return;
		}
		for (const item of ordered) {
			const selectedIndex = selected.indexOf(item);
			const active = selectedIndex >= 0;
			const matchedKeyword = !key || item.toLowerCase().includes(key);
			const row = document.createElement("div");
			row.style.cssText = [
				"width:100%", "box-sizing:border-box", "display:flex", "align-items:center", "gap:4px",
				"border-radius:6px", "font:600 12px/1.3 ui-sans-serif,system-ui,'Microsoft YaHei',sans-serif",
				`border:1px solid ${active ? "#78b8e8" : "#40515a"}`,
				`background:${active ? "#254761" : "#1b252a"}`,
				`color:${active ? "#ffffff" : "#d9e7ec"}`,
				`opacity:${matchedKeyword || active ? "1" : ".68"}`,
			].join(";");
			const main = document.createElement("button");
			main.type = "button";
			const meta = audioMeta.get(item) || {};
			const suffix = !isTtsLibrary && (meta.size || meta.mtime) ? `  ${formatBytes(meta.size)}` : "";
			const displayItem = voiceDisplayLabel(branch, item);
			main.textContent = active ? `${selectedIndex + 1}. ${displayItem}${suffix}` : `${displayItem}${suffix}`;
			main.title = displayItem;
			main.style.cssText = "flex:1;min-width:0;text-align:left;padding:6px 8px;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;overflow:hidden;text-overflow:ellipsis";
			main.addEventListener("click", () => {
				const next = selectedOrder();
				if (next.includes(item)) {
					saveOrder(next.filter((value) => value !== item));
				} else {
					saveOrder([...next, item]);
				}
				render();
				syncButtons(node);
			});
			row.append(main);
			if (active) {
				const move = (delta) => {
					const next = selectedOrder();
					const from = next.indexOf(item);
					const to = from + delta;
					if (from < 0 || to < 0 || to >= next.length) return;
					const [picked] = next.splice(from, 1);
					next.splice(to, 0, picked);
					saveOrder(next);
					render();
					syncButtons(node);
				};
				for (const [label, delta, disabled] of [["↑", -1, selectedIndex <= 0], ["↓", 1, selectedIndex >= selected.length - 1]]) {
					const btn = document.createElement("button");
					btn.type = "button";
					btn.textContent = label;
					btn.disabled = disabled;
					btn.style.cssText = "width:24px;height:24px;border:0;border-left:1px solid rgba(255,255,255,.16);background:transparent;color:inherit;cursor:pointer;opacity:" + (disabled ? ".35" : "1");
					btn.addEventListener("click", (event) => {
						event.stopPropagation();
						move(delta);
					});
					row.append(btn);
				}
			}
			list.append(row);
		}
	};
	sortBtn.addEventListener("click", () => {
		s.mp3SortMode = nextLibrarySortMode(s.mp3SortMode, !isTtsLibrary);
		s.mp3SortAsc = s.mp3SortMode !== "name_desc";
		saveUniversalTTSPreset(node, { local_audio_sort_mode: s.mp3SortMode });
		render();
	});
	clearBtn.addEventListener("click", () => {
		saveOrder([]);
		render();
		syncButtons(node);
	});
	confirmBtn.addEventListener("click", () => {
		popup.remove();
		s.mp3Popup = null;
		syncButtons(node);
	});
	input.addEventListener("input", render);
	input.addEventListener("keydown", (event) => {
		if (!(isTtsLibrary && !isEdge) || event.key !== "Enter") return;
		const value = input.value.trim();
		if (!value) return;
		event.preventDefault();
		const next = selectedOrder();
		if (!next.includes(value)) saveOrder([...next, value]);
		input.value = "";
		render();
		syncButtons(node);
	});
	popup.append(head, speakerBox, input, list);
	popup.addEventListener("pointerdown", (event) => event.stopPropagation());
	popup.addEventListener("mousedown", (event) => event.stopPropagation());
	document.body.append(popup);
	render();
	const rect = s.mp3.getBoundingClientRect();
	const width = popup.offsetWidth || 300;
	const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.left));
	const top = Math.min(window.innerHeight - popup.offsetHeight - 8, Math.max(8, rect.bottom + 6));
	popup.style.left = `${left}px`;
	popup.style.top = `${top}px`;
	s.mp3Popup = popup;
	syncButtons(node);
	setTimeout(() => input.focus(), 0);
}

function isExecutionOutputNode(node) {
	return Boolean(node?.flags?.output || node?.constructor?.nodeData?.output_node || node?.nodeData?.output_node);
}

async function queueOnlyCurrentNode(node) {
	const allNodes = app.graph?._nodes || [];
	const saved = [];
	const oldSelectedNodes = app.canvas?.selected_nodes;
	const oldSelectedNode = app.canvas?.selected_node;
	try {
		for (const n of allNodes) {
			if (n !== node && isExecutionOutputNode(n)) {
				saved.push([n, n.mode]);
				n.mode = 2;
			}
		}
		if (app.canvas) {
			app.canvas.selected_nodes = { [node.id]: node };
			app.canvas.selected_node = node;
		}
		await app.queuePrompt?.(0, 1);
		return true;
	} finally {
		for (const [n, mode] of saved) n.mode = mode;
		if (app.canvas) {
			app.canvas.selected_nodes = oldSelectedNodes;
			app.canvas.selected_node = oldSelectedNode;
		}
	}
}

function patchNode(node) {
	if (!node) return;
	ensurePanel(node);
	if (universalTTSPresetCache) {
		applyUniversalTTSPreset(node, universalTTSPresetCache);
	} else if (!node.__gjjUniversalTTSPresetRequested) {
		node.__gjjUniversalTTSPresetRequested = true;
		loadUniversalTTSPreset().then((preset) => {
			applyUniversalTTSPreset(node, preset);
			normalizeRuntimeWidgetValues(node);
			applyWidgetVisibility(node);
			refreshDependencyNotice(node);
			syncButtons(node);
		});
	}
	ensureAudio(node);
	normalizePairs(node);
	normalizeRuntimeWidgetValues(node);
	applyWidgetVisibility(node);
	compactTextWidget(node);
	const branchWidget = widget(node, "branch");
	if (branchWidget && !branchWidget.__gjjUniversalPatched) {
		branchWidget.__gjjUniversalPatched = true;
		const original = branchWidget.callback;
		branchWidget.callback = function (...args) {
			const result = original?.apply(this, args);
			saveBranchPreset(node);
			applyWidgetVisibility(node);
			refreshDependencyNotice(node);
			return result;
		};
	}
	for (const name of ["text", "edge_voice"]) {
		const w = widget(node, name);
		if (!w || w.__gjjUniversalSpeakerVoicePatched) continue;
		w.__gjjUniversalSpeakerVoicePatched = true;
		const original = w.callback;
		w.callback = function (...args) {
			const result = original?.apply(this, args);
			renderEdgeSpeakerVoicePanel(node);
			if (node.__gjjUniversalTTS?.mp3Popup) {
				node.__gjjUniversalTTS.mp3Popup.remove();
				node.__gjjUniversalTTS.mp3Popup = null;
				syncButtons(node);
			}
			return result;
		};
	}
	setTimeout(() => {
		normalizePairs(node);
		normalizeRuntimeWidgetValues(node);
		applyWidgetVisibility(node);
		refreshDependencyNotice(node);
	}, 80);
	setTimeout(() => {
		normalizePairs(node);
		normalizeRuntimeWidgetValues(node);
		applyWidgetVisibility(node);
		refreshDependencyNotice(node);
	}, 300);
}

function safePatchNode(node) {
	try {
		patchNode(node);
	} catch (error) {
		console.warn("[GJJ] Universal TTS UI patch failed", error);
		try {
			if (node?.addDOMWidget && !node.__gjjUniversalTTSToolbarWidget) {
				const state = ensurePanel(node);
				ensureToolbarWidget(node, state);
			}
		} catch (_) {}
	}
}

function patchAllExistingNodes() {
	for (const node of app?.graph?._nodes || []) {
		if (isTarget(node)) safePatchNode(node);
	}
}

api?.addEventListener?.("gjj_node_progress", (event) => {
	const detail = event?.detail || {};
	const node = app.graph?._nodes?.find((item) => String(item?.id) === String(detail.node));
	if (!isTarget(node)) return;
	setStatus(node, detail.text || "处理中…", detail.progress);
});

api?.addEventListener?.("gjj_node_audio", (event) => {
	const detail = event?.detail || {};
	const node = app.graph?._nodes?.find((item) => String(item?.id) === String(detail.node));
	if (!isTarget(node)) return;
	setAudioPreview(node, { audio: detail.audio || [] });
	if (detail.preview) {
		setStatus(node, detail.text || "片段预览已更新", null);
	} else {
		setStatus(node, detail.text || "完成，音频已保存", 100);
	}
});

if (app?.registerExtension) {
	app.registerExtension({
		name: "Comfy.GJJ.UniversalTTS",
		beforeRegisterNodeDef(nodeType, nodeData) {
			if (!isTargetNodeData(nodeData)) return;
			const created = nodeType.prototype.onNodeCreated;
			nodeType.prototype.onNodeCreated = function (...args) {
				const result = created?.apply(this, args);
				for (const delay of [0, 30, 120, 300]) {
					setTimeout(() => safePatchNode(this), delay);
				}
				return result;
			};
			const configured = nodeType.prototype.onConfigure;
			nodeType.prototype.onConfigure = function (...args) {
				const result = configured?.apply(this, args);
				try { restoreWidgetValuesByName(this); } catch (_) {}
				try { syncLocalAudioOrderStorage(this); } catch (_) {}
				for (const delay of [0, 30, 120, 300]) {
					setTimeout(() => safePatchNode(this), delay);
				}
				return result;
			};
			const serialized = nodeType.prototype.onSerialize;
			nodeType.prototype.onSerialize = function (...args) {
				try { syncLocalAudioOrderStorage(this); } catch (_) {}
				try { syncLinkedSynthesisText(this); } catch (_) {}
				try { captureWidgetValuesByName(this); } catch (_) {}
				return serialized?.apply(this, args);
			};
			const connections = nodeType.prototype.onConnectionsChange;
			nodeType.prototype.onConnectionsChange = function (...args) {
				const result = connections?.apply(this, args);
				setTimeout(() => normalizePairs(this), 20);
				return result;
			};
			const executed = nodeType.prototype.onExecuted;
			nodeType.prototype.onExecuted = function (message, ...args) {
				const result = executed?.apply(this, [message, ...args]);
				setAudioPreview(this, message);
				return result;
			};
		},
		setup() {
			patchAllExistingNodes();
			for (const delay of [80, 300, 900, 1800]) setTimeout(patchAllExistingNodes, delay);
		},
		nodeCreated(node) {
			setupNode(node);
		},
		loadedGraphNode(node) {
			setupNode(node);
		},
	});
	for (const delay of [0, 250, 1000, 2200]) setTimeout(patchAllExistingNodes, delay);
} else {
	console.error("[GJJ] Universal TTS UI failed: Comfy app API is unavailable");
}
