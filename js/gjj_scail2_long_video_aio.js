import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const NODE_NAME = "GJJ_SCAIL2LongVideoAIO";
const DIRECTOR_WIDGET = "director_storyboard_json";
const TOOLBAR_WIDGET = "gjj_scail2_toolbar";
const STATUS_WIDGET = "gjj_scail2_status";
const PREVIEW_WIDGET = "gjj_scail2_preview";
const TOOLBAR_LABEL = "🎬 👤 🔗 🕺 🎞️ 📐 🧠 ⚙️ ▶";
const IMAGE_UPLOAD_SUBFOLDER = "gjj_scail2_aio";
const VIDEO_UPLOAD_API = "/gjj/upload_video";
const VIDEO_LIST_API = "/gjj/input_videos";
const VIDEO_META_API = "/gjj/video_meta";
const IMAGE_LIST_API = "/gjj/input_images";
const TEMP_IMAGE_UPLOAD_API = "/gjj/multi_image_loader/upload_temp_images";
const MEDIA_BY_HASH_API = "/gjj/media_by_hash";
const STORYBOARD_API = "/gjj/video_smart_storyboard/analyze";
const MODEL_LIST_API = "/gjj/scail2_long_video_aio/models";
const REF_STITCH_API = "/gjj/scail2_long_video_aio/stitch_references";
const REF_REMOVE_BG_API = "/gjj/scail2_long_video_aio/remove_background_references";
const AUDIO_UPLOAD_API = "/gjj/scail2_long_video_aio/upload_audio";
const CHARACTER_MULTIVIEW_API = "/gjj/character_library/generate_multiview";
const DEFAULT_NEGATIVE_PROMPT = "(worst quality, low quality, normal quality:1.3), (blurry, out of focus, pixelated, jpeg artifacts, noise, grainy:1.2), (text, watermark, logo, signature, subtitle, border, qr code:1.3), (bad anatomy, bad hands, malformed fingers, extra digits, missing digits, fused fingers, extra limbs, missing limbs, deformed body:1.2), (facial distortion, cross-eyed, asymmetric face, plastic skin, uncanny valley:1.2), (flickering, frame jitter, color flickering, inconsistent lighting, overexposed, underexposed, motion distortion, unnatural movement, rigid movement:1.3), (duplicate characters, extra people, floating objects, wrong background, style drift, 3d render, cartoon, cgi if unwanted:1.1), ugly, disfigured, mutated, morbid, gore";
const MIN_WIDTH = 360;
const NODE_HEIGHT = 210;
const PROMPT_HEIGHT = 30;
const STATUS_HEIGHT = 34;
const PREVIEW_HEIGHT = 230;
const BUTTON_SIZE = 28;
const BUTTON_GAP = 2;
const BUTTON_Y = 132;
const NO_LORA_LABEL = "🚫 不使用 LoRA";
const NO_LORA_VALUES = new Set(["", "不使用", "不使用LoRA", "不使用 LoRA", NO_LORA_LABEL]);
const BASE_MODEL_WIDGETS = new Set([
	"model_file",
	"vae_file",
	"text_encoder_file",
	"clip_vision_file",
	"accel_lora_file",
	"dpo_lora_file",
	"slop_bounce_lora_file",
	"sam3_checkpoint",
]);
const MULTIVIEW_MODEL_WIDGETS = new Set([
	"multiview_unet",
	"multiview_clip",
	"multiview_vae",
	"multiview_lora_1",
	"multiview_lora_2",
	"multiview_lora_3",
	"rmbg_model",
]);
const OPTIONAL_LORA_WIDGETS = new Set([
	"accel_lora_file",
	"dpo_lora_file",
	"slop_bounce_lora_file",
	"multiview_lora_3",
]);
const DEFAULT_MULTIVIEW_LORA_WIDGETS = new Set([
	"multiview_lora_1",
	"multiview_lora_2",
]);

const BUTTONS = [
	["video", "🎬", "导入/选择原视频"],
	["image", "👤", "导入/选择参考图"],
	["link", "🔗", "断开/恢复全部输入"],
	["mode", "🕺", "动作驱动 / 人物替换"],
	["director", "🎞️", "导演台"],
	["size", "📐", "尺寸"],
	["model", "🧠", "模型"],
	["other", "⚙️", "参数"],
	["run", "▶", "执行当前节点"],
];

const RUNNING_NODE_IDS = new Set();
const IMPORTING_NODE_IDS = new Set();

const SIZE_FIELDS = [
	["video_size_mode", "视频尺寸来源", "segmented", { options: ["面板尺寸", "原视频尺寸"], tooltip: "面板尺寸：使用下面的宽高；原视频尺寸：运行时自动使用原视频帧宽高，下面宽高只保留为备用值。" }],
	["width", "宽度", "number", { align: "multiple16", min: 320, max: 2048, disabledWhen: ["video_size_mode", "原视频尺寸"], tooltip: "输出宽度。范围 320-2048，会自动对齐到 16 的倍数；视频尺寸来源为“原视频尺寸”时运行中会使用原视频宽度并限制在该范围。" }],
	["height", "高度", "number", { align: "multiple16", min: 320, max: 2048, disabledWhen: ["video_size_mode", "原视频尺寸"], tooltip: "输出高度。范围 320-2048，会自动对齐到 16 的倍数；视频尺寸来源为“原视频尺寸”时运行中会使用原视频高度并限制在该范围。" }],
	["frame_rate", "帧率", "number", { min: 1, max: 240, tooltip: "兜底输出帧率。导入原视频时优先沿用原视频帧率；没有原视频时使用这里。" }],
	["max_frames", "最大帧数", "number", { align: "frames4n1", min: 0, max: 100000, allowZero: true, tooltip: "最多生成多少帧。0 表示不限制；非 0 时会自动对齐到 4n+1。" }],
	["window_length", "窗口帧数", "number", { align: "frames4n1", min: 5, max: 100000, tooltip: "每次采样窗口帧数。会自动对齐到 4n+1，例如 121。" }],
	["previous_frame_count", "锚定帧数", "number", { align: "frames4n1", min: 1, max: 1000, tooltip: "续段时保留上一段末尾多少帧作为锚定。会自动对齐到 4n+1，例如 5。" }],
	["reference_resize_mode", "参考图缩放", "segmented", { options: ["补边", "裁剪", "拉伸", "原图"], tooltip: "参考图送入模型前的缩放方式。补边=等比完整保留；裁剪=铺满但可能裁掉边缘；拉伸=强制变形到输出尺寸；原图=不改尺寸。" }],
	["reference_crop_keep_position", "保留位置", "segmented", { options: ["上", "下", "左", "右", "中"], disabledWhen: ["reference_resize_mode", "裁剪", true], tooltip: "参考图缩放为“裁剪”时，决定裁剪后优先保留画面的上、下、左、右或中心区域。" }],
	["reference_pad_color", "补边底色", "segmented", { options: ["黑色", "灰色", "白色", "边缘均色"], disabledWhen: ["reference_resize_mode", "补边", true], tooltip: "参考图缩放为“补边”时的留边颜色。边缘均色会从图片边缘自动取平均色。" }],
];

const MODEL_FIELDS = [
	["model_file", "SCAIL模型", "text"],
	["vae_file", "VAE", "text"],
	["text_encoder_file", "T5", "text"],
	["clip_vision_file", "CLIP Vision", "text"],
	["accel_lora_file", "加速LoRA", "text"],
	["dpo_lora_file", "DPO LoRA", "text"],
	["slop_bounce_lora_file", "Slop Bounce", "text"],
	["sam3_checkpoint", "SAM3", "text"],
];

const MODEL_FIELD_FALLBACKS = {
	model_file: "wan2.1_14B_SCAIL_2_fp8_scaled.safetensors",
	vae_file: "wan_2.1_vae.safetensors",
	text_encoder_file: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
	clip_vision_file: "clip_vision_h.safetensors",
	accel_lora_file: "wan/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors",
	dpo_lora_file: "wan/wan2.1_SCAIL_2_DPO_lora_bf16.safetensors",
	slop_bounce_lora_file: "wan/i2v_slop_bounce.safetensors",
	sam3_checkpoint: "sam3.1_multiplex.safetensors",
	multiview_unet: "qwen_image_edit_2511_int8_convrot.safetensors",
	multiview_clip: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
	multiview_vae: "qwen_image_vae.safetensors",
	multiview_lora_1: "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
	multiview_lora_2: "qwen-image-edit-2511-multiple-angles-lora.safetensors",
	multiview_lora_3: "",
	rmbg_model: "rmbg1.4.safetensors",
};

const MODEL_FIELD_ICONS = {
	diffusion_models: "🟣",
	vae: "🔴",
	text_encoders: "🟡",
	clip_vision: "🟡",
	loras: "🟠",
	checkpoints: "🟣",
	RMBG: "🟣",
	translation: "🧠",
};

const EXTRA_MODEL_FIELDS = [
	{
		name: "multiview_unet",
		label: "多视图主模型",
		folder: "diffusion_models",
		path: "models/diffusion_models",
		anyKeywords: [],
		keywords: ["qwen", "image", "edit", "2511"],
		extensions: [".safetensors", ".gguf"],
		description: "【生成多视图】按 GJJ_CharacterMultiViewStudio 的 2511 链路使用 Qwen Image Edit 主模型。",
		required: false,
	},
	{
		name: "multiview_clip",
		label: "多视图CLIP",
		folder: "text_encoders",
		path: "models/text_encoders",
		anyKeywords: [],
		keywords: ["qwen", "2.5", "vl"],
		extensions: [".safetensors", ".gguf"],
		description: "【生成多视图】2511 链路使用的 Qwen 2.5 VL 文本/视觉编码器。",
		required: false,
	},
	{
		name: "multiview_vae",
		label: "多视图VAE",
		folder: "vae",
		path: "models/vae",
		anyKeywords: [],
		keywords: ["qwen", "image", "vae"],
		extensions: [".safetensors"],
		description: "【生成多视图】2511 链路使用的 Qwen Image VAE。",
		required: false,
	},
	{
		name: "multiview_lora_1",
		label: "多视图Lightning LoRA",
		folder: "loras",
		path: "models/loras",
		keywords: ["qwen", "lightning"],
		extensions: [".safetensors"],
		description: "【生成多视图】2511 链路使用的 Lightning / 加速 LoRA。",
		required: false,
	},
	{
		name: "multiview_lora_2",
		label: "多角度LoRA",
		folder: "loras",
		path: "models/loras",
		keywords: ["multiple", "angles"],
		extensions: [".safetensors"],
		description: "【生成多视图】2511 链路使用的多角度一致性 LoRA。",
		required: false,
	},
	{
		name: "multiview_lora_3",
		label: "多视图LoRA 3",
		folder: "loras",
		path: "models/loras",
		anyKeywords: [],
		keywords: [],
		extensions: [".safetensors"],
		description: "【生成多视图】可选第3组微调模型；留空表示不使用。",
		required: false,
	},
	{
		name: "rmbg_model",
		label: "RMBG抠图模型",
		folder: "RMBG",
		path: "models/RMBG",
		keywords: ["rmbg", "1.4"],
		extensions: [".safetensors", ".pth"],
		description: "【去背景/拼接】多视图人物资产、批量去背景和 GJJ_RemoveBgStitch 拼接图片使用的 RMBG1.4 模型。",
		required: false,
	},
];

const OTHER_FIELDS = [
	["seed", "种子", "number"],
	["steps", "步数", "number"],
	["cfg", "CFG", "number"],
	["sampler_name", "采样器", "text"],
	["scheduler", "调度器", "text"],
	["denoise", "降噪", "number"],
	["pose_strength", "姿态强度", "number"],
	["pose_start", "姿态开始", "number"],
	["pose_end", "姿态结束", "number"],
	["model_dtype", "模型dtype", "text"],
	["use_accel_lora", "使用加速LoRA", "checkbox"],
	["enable_model_sampling_sd3", "SD3采样补丁", "checkbox"],
	["model_sampling_sd3_shift", "SD3移位", "number"],
	["sam3_target", "跟踪目标", "text"],
	["sam3_object_indices", "对象编号", "text"],
	["sam3_detection_threshold", "检测阈值", "number", { default: 0.5, min: 0, tooltip: "SAM3 目标检测阈值，范围 0-1。留空会自动使用 0.5。" }],
	["sam3_max_objects", "最大对象数", "number"],
	["sam3_detect_interval", "检测间隔", "number"],
	["decode_tiled", "分块解码", "checkbox"],
	["vary_seed_per_window", "每段递增种子", "checkbox"],
	["output_format", "输出格式", "text"],
	["filename_prefix", "文件名前缀", "text"],
	["negative_prompt", "负向提示词", "text", { default: DEFAULT_NEGATIVE_PROMPT }],
];

function isTarget(nodeOrData) {
	const values = [
		nodeOrData?.name,
		nodeOrData?.comfyClass,
		nodeOrData?.type,
		nodeOrData?.title,
		nodeOrData?.display_name,
		nodeOrData?.nodeData?.name,
		nodeOrData?.nodeData?.display_name,
	];
	return values.some((value) => {
		const text = String(value || "");
		return text === NODE_NAME || text.includes("SCAIL2LongVideoAIO") || text.includes("SCAIL2 超长视频");
	});
}

function apiUrl(path) {
	return api?.apiURL ? api.apiURL(path) : path;
}

async function fetchJson(path, options = {}) {
	const response = api?.fetchApi ? await api.fetchApi(path, options) : await fetch(apiUrl(path), options);
	const data = await response.json().catch(() => ({}));
	if (!response.ok || data?.ok === false) throw new Error(data?.error || `请求失败：${response.status}`);
	return data;
}

function widget(node, name) {
	return (node.widgets || []).find((item) => String(item?.name || "") === name);
}

function getWidget(node, name, fallback = "") {
	const item = widget(node, name);
	return item ? item.value : fallback;
}

function boolValue(value) {
	if (typeof value === "string") {
		return ["1", "true", "yes", "on", "是", "开", "开启"].includes(value.trim().toLowerCase());
	}
	return Boolean(value);
}

function finiteNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function setWidget(node, name, value) {
	const item = widget(node, name);
	if (!item) return;
	item.value = value;
	item.callback?.(value);
	node.properties ||= {};
	if (["selected_video_json", "selected_reference_json", "selected_audio_json", DIRECTOR_WIDGET].includes(name)) {
		node.properties[name] = value;
	}
	updateDomToolbarState(node);
	app.graph?.setDirtyCanvas?.(true, true);
}

function isNoLoraValue(value) {
	return NO_LORA_VALUES.has(String(value || "").trim());
}

function sanitizeWidgetValues(node) {
	const numberDefaults = {
		width: [512, 320, 2048],
		height: [896, 320, 2048],
		frame_rate: [8, 1, 240],
		max_frames: [0, 0, 100000],
		window_length: [121, 5, 100000],
		previous_frame_count: [5, 1, 1000],
		seed: [1, 0, Number.MAX_SAFE_INTEGER],
		steps: [6, 1, 10000],
		cfg: [1, 0, 100],
		denoise: [1, 0, 1],
		pose_strength: [1, 0, 10],
		pose_start: [0, 0, 1],
		pose_end: [1, 0, 1],
		model_sampling_sd3_shift: [5, 0, 100],
		sam3_detection_threshold: [0.5, 0, 1],
		sam3_max_objects: [1, 0, 64],
		sam3_detect_interval: [1, 1, 999],
	};
	for (const [name, [fallback, min, max]] of Object.entries(numberDefaults)) {
		const item = widget(node, name);
		if (!item) continue;
		const value = finiteNumber(item.value);
		if (value == null || value < min || value > max) {
			item.value = fallback;
			item.callback?.(fallback);
		}
	}
	const positive = widget(node, "positive_prompt");
	if (positive && positive.value == null) positive.value = "";
	const negative = widget(node, "negative_prompt");
	if (negative && !String(negative.value || "").trim()) negative.value = DEFAULT_NEGATIVE_PROMPT;
	const enumDefaults = {
		sampler_name: ["euler", ["euler", "uni_pc", "dpmpp_2m"]],
		scheduler: ["simple", ["simple", "normal", "beta"]],
		sam3_sort_by: ["从左到右", ["从左到右", "面积从大到小", "保持原顺序"]],
		reference_resize_mode: ["补边", ["补边", "裁剪", "拉伸", "原图"]],
		reference_crop_keep_position: ["中", ["上", "下", "左", "右", "中"]],
		video_size_mode: ["面板尺寸", ["面板尺寸", "原视频尺寸"]],
		reference_pad_color: ["黑色", ["黑色", "灰色", "白色", "边缘均色"]],
	};
	for (const [name, [fallback, values]] of Object.entries(enumDefaults)) {
		const item = widget(node, name);
		if (item && !values.includes(item.value)) item.value = fallback;
	}
	for (const [name, fallback] of Object.entries({
		selected_video_json: "[]",
		selected_reference_json: "[]",
		selected_audio_json: "[]",
		director_storyboard_json: "{}",
	})) {
		const item = widget(node, name);
		if (!item) continue;
		const text = String(item.value || "").trim();
		if (!text.startsWith("[") && !text.startsWith("{")) item.value = fallback;
	}
	for (const name of DEFAULT_MULTIVIEW_LORA_WIDGETS) {
		const item = widget(node, name);
		const fallback = MODEL_FIELD_FALLBACKS[name] || "";
		if (item && fallback && isNoLoraValue(item.value)) item.value = fallback;
	}
}

function readJson(value, fallback) {
	try {
		const parsed = JSON.parse(String(value || ""));
		return parsed == null ? fallback : parsed;
	} catch (_) {
		return fallback;
	}
}

function selectedItems(node, name) {
	const data = readJson(getWidget(node, name, "[]"), []);
	return Array.isArray(data) ? normalizeMediaItems(data) : [];
}

function setSelectedItems(node, name, items) {
	setWidget(node, name, JSON.stringify(normalizeMediaItems(items || [])));
}

function mediaLabel(item) {
	if (!item) return "未选择";
	if (item.label) return String(item.label);
	return item.subfolder ? `${item.subfolder}/${item.filename}` : String(item.filename || "未命名");
}

function viewUrl(item) {
	if (item?.preview_url) return item.preview_url;
	if (!item?.filename) return "";
	const type = encodeURIComponent(item.type || "input");
	const filename = encodeURIComponent(item.filename);
	const subfolder = item.subfolder ? `&subfolder=${encodeURIComponent(item.subfolder)}` : "";
	return apiUrl(`/view?filename=${filename}&type=${type}${subfolder}`);
}

function normalizeMediaItem(item) {
	const result = { ...(item || {}) };
	let filename = String(result.filename || "").replaceAll("\\", "/").trim();
	let subfolder = String(result.subfolder || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
	if (filename.includes("/")) {
		const parts = filename.split("/").filter(Boolean);
		filename = parts.pop() || filename;
		const fromFilename = parts.join("/");
		subfolder = [subfolder, fromFilename].filter(Boolean).join("/");
	}
	const cleanParts = [];
	for (const part of subfolder.split("/").filter(Boolean)) {
		if (part === "." || part === "..") continue;
		if (!cleanParts.length || cleanParts[cleanParts.length - 1] !== part) cleanParts.push(part);
	}
	result.filename = filename;
	result.subfolder = cleanParts.join("/");
	result.type = String(result.type || "input").trim() || "input";
	delete result.preview_url;
	delete result.pending;
	return result;
}

function normalizeMediaItems(items) {
	return Array.from(items || []).map(normalizeMediaItem).filter((item) => item.filename);
}

async function fetchVideoMeta(item) {
	const media = normalizeMediaItem(item);
	if (!media.filename) return {};
	const params = new URLSearchParams();
	params.set("filename", media.filename);
	params.set("type", media.type || "input");
	if (media.subfolder) params.set("subfolder", media.subfolder);
	return fetchJson(`${VIDEO_META_API}?${params.toString()}`);
}

function mediaItemKey(item) {
	const normalized = normalizeMediaItem(item);
	return `${normalized.type || "input"}|${normalized.subfolder || ""}|${normalized.filename || ""}`;
}

function mergeMediaItems(...lists) {
	const merged = [];
	const seen = new Set();
	for (const item of normalizeMediaItems(lists.flat())) {
		const key = mediaItemKey(item);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(item);
	}
	return merged;
}

function mediaItemFromViewUrl(text) {
	try {
		const url = new URL(String(text || ""), window.location.href);
		if (!url.pathname.endsWith("/view")) return null;
		const filename = url.searchParams.get("filename") || "";
		if (!filename) return null;
		const type = url.searchParams.get("type") || "temp";
		const subfolder = url.searchParams.get("subfolder") || "";
		return normalizeMediaItem({ filename, subfolder, type });
	} catch (_) {
		return null;
	}
}

async function mediaItemsFromUrls(urls) {
	const direct = [];
	const files = [];
	for (const raw of Array.from(urls || [])) {
		const item = mediaItemFromViewUrl(raw);
		if (item) {
			direct.push(item);
			continue;
		}
		const response = await fetch(apiUrl(String(raw || "")));
		if (!response.ok) continue;
		const blob = await response.blob();
		files.push(new File([blob], `gjj_view_${files.length + 1}.png`, { type: blob.type || "image/png" }));
	}
	const uploaded = files.length ? await uploadImageFiles(files) : [];
	return normalizeMediaItems([...direct, ...uploaded]);
}

function hasLinkedInput(node, inputName) {
	const input = (node.inputs || []).find((item) => item?.name === inputName);
	return !!input && input.link != null;
}

function hasVideoResource(node) {
	return hasLinkedInput(node, "original_video") || selectedItems(node, "selected_video_json").length > 0;
}

function hasImageResource(node) {
	return hasLinkedInput(node, "reference_image") || selectedItems(node, "selected_reference_json").length > 0;
}

function hasLinkInfo(node) {
	return hasAnyLink(node) || savedLinks(node).length > 0;
}

function isNodeRunning(node) {
	return node?.id != null && RUNNING_NODE_IDS.has(String(node.id));
}

function isNodeImporting(node, kind = "") {
	const key = `${node?.id ?? ""}:${kind}`;
	return node?.id != null && (IMPORTING_NODE_IDS.has(String(node.id)) || IMPORTING_NODE_IDS.has(key));
}

function hideNativeWidgets(node) {
	for (const item of node.widgets || []) {
		const name = String(item?.name || "");
		if (item.__gjjScail2Keep || name === TOOLBAR_WIDGET) {
			item.hidden = false;
			item.serialize = false;
			const keepName = item.__gjjScail2ToolbarName || name;
			const heightFor = () => {
				if (keepName === STATUS_WIDGET) return STATUS_HEIGHT;
				if (keepName === PREVIEW_WIDGET) return previewPanelHeight(node);
				return 36;
			};
			item.computeSize = (width) => [Math.max(280, Number(width || 280)), keepName === PREVIEW_WIDGET ? previewPanelHeight(node, width) : heightFor()];
			item.getHeight = heightFor;
			continue;
		}
		if (name === "positive_prompt") {
			item.hidden = false;
			item.serialize = true;
			item.label = item.label || "正向提示词";
			item.options ||= {};
			item.options.multiline = false;
			item.options.rows = 1;
			item.computeSize = (width) => [Math.max(240, Number(width || 240)), PROMPT_HEIGHT];
			item.getHeight = () => PROMPT_HEIGHT;
			if (item.inputEl?.style) {
				item.inputEl.style.height = `${PROMPT_HEIGHT}px`;
				item.inputEl.style.maxHeight = `${PROMPT_HEIGHT}px`;
				item.inputEl.style.overflow = "hidden";
				item.inputEl.style.whiteSpace = "nowrap";
				item.inputEl.style.resize = "none";
			}
			continue;
		}
		item.hidden = true;
		item.type = "hidden";
		item.serialize = true;
		item.computeSize = () => [0, -4];
	}
}

function ensureSize(node) {
	const width = Math.max(MIN_WIDTH, Number(node.size?.[0] || MIN_WIDTH));
	const hasPreview = Boolean(node.properties?.gjj_scail2_final_video?.filename);
	const height = NODE_HEIGHT + (hasPreview ? previewPanelHeight(node, width) : 0);
	node.minWidth = MIN_WIDTH;
	node.min_width = MIN_WIDTH;
	node.minHeight = height;
	node.min_height = height;
	node.size = [width, height];
	node.setSize?.([width, height]);
}

function previewAspect(node) {
	const stored = Number(node?.properties?.gjj_scail2_preview_aspect || 0);
	if (Number.isFinite(stored) && stored > 0) return Math.max(0.05, Math.min(6, stored));
	const width = Number(getWidget(node, "width", 512) || 512);
	const height = Number(getWidget(node, "height", 896) || 896);
	if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
		return Math.max(0.05, Math.min(6, height / width));
	}
	return 9 / 16;
}

function previewVideoHeight(node, width = null) {
	const panelWidth = Math.max(240, Number(width || node?.size?.[0] || MIN_WIDTH) - 34);
	return Math.max(96, Math.round(panelWidth * previewAspect(node)));
}

function previewPanelHeight(node, width = null) {
	if (!node?.properties?.gjj_scail2_final_video?.filename) return 0;
	return previewVideoHeight(node, width) + 28;
}

function removeOldToolbar(node) {
	if (!Array.isArray(node.widgets)) return;
	for (let index = node.widgets.length - 1; index >= 0; index -= 1) {
		const item = node.widgets[index];
		if (
			item?.__gjjScail2Keep ||
			item?.__gjjScail2ToolbarName === TOOLBAR_WIDGET ||
			item?.__gjjScail2ToolbarName === PREVIEW_WIDGET ||
			String(item?.name || "") === TOOLBAR_WIDGET ||
			String(item?.name || "") === STATUS_WIDGET ||
			String(item?.name || "") === PREVIEW_WIDGET
		) {
			node.widgets.splice(index, 1);
		}
	}
}

function buttonActive(node, key) {
	if (key === "mode") return boolValue(getWidget(node, "mode_replacement", false));
	if (key === "link") return hasLinkInfo(node);
	if (key === "video") return hasVideoResource(node);
	if (key === "image") return hasImageResource(node);
	if (key === "size") return getWidget(node, "video_size_mode", "面板尺寸") === "原视频尺寸";
	if (key === "director") return hasDirectorState(node);
	if (key === "model") return hasModelState(node);
	if (key === "other") return hasOtherState(node);
	if (key === "run") return hasVideoResource(node);
	return false;
}

function hasDirectorState(node) {
	const data = readJson(getWidget(node, DIRECTOR_WIDGET, "{}"), {});
	const scenes = Array.isArray(data.scenes) ? data.scenes : [];
	const audios = Array.isArray(data.audios) ? data.audios : selectedItems(node, "selected_audio_json");
	return scenes.length > 1 || audios.length > 0 || Boolean(data.audio_override);
}

function hasModelState(node) {
	if (boolValue(getWidget(node, "keep_model_loaded", false))) return true;
	const names = [
		...MODEL_FIELDS.map((item) => item[0]),
		...EXTRA_MODEL_FIELDS.map((item) => item.name),
		"rmbg_model",
	];
	return names.some((name) => {
		const value = String(getWidget(node, name, "") || "").trim();
		return value && value !== "不使用";
	});
}

function hasOtherState(node) {
	const checks = {
		seed: 1,
		steps: 6,
		cfg: 1,
		denoise: 1,
		pose_strength: 1,
		pose_start: 0,
		pose_end: 1,
		zero_conditioning: true,
		decode_tiled: false,
		vary_seed_per_window: true,
		sam3_target: "person",
		sam3_detection_threshold: "0.5",
		sam3_max_objects: 1,
		sam3_detect_interval: 1,
		sam3_sort_by: "从左到右",
	};
	for (const [name, fallback] of Object.entries(checks)) {
		const value = getWidget(node, name, fallback);
		if (typeof fallback === "boolean" && boolValue(value) !== fallback) return true;
		if (typeof fallback === "number" && Number(value) !== fallback) return true;
		if (typeof fallback === "string" && String(value ?? "").trim() !== fallback) return true;
	}
	const negative = String(getWidget(node, "negative_prompt", DEFAULT_NEGATIVE_PROMPT) || "").trim();
	return Boolean(negative && negative !== DEFAULT_NEGATIVE_PROMPT);
}

function buttonDisabled(node, key) {
	if ((key === "video" || key === "image") && (isNodeRunning(node) || isNodeImporting(node, key))) return true;
	return key === "link" && !hasLinkInfo(node);
}

function buttonIcon(node, key, fallbackIcon) {
	if ((key === "video" || key === "image") && (isNodeRunning(node) || isNodeImporting(node, key))) return "⌛";
	if (key === "run" && isNodeRunning(node)) return "⌛";
	if (key === "mode") return buttonActive(node, key) ? "👥" : "🕺";
	return fallbackIcon;
}

function buttonTitle(node, key, baseTitle) {
	if (key === "mode") {
		return buttonActive(node, key) ? "当前：人物替换。点击切到动作驱动。" : "当前：动作驱动。点击切到人物替换。";
	}
	if (key === "video") {
		if (isNodeImporting(node, key)) return "正在导入视频...";
		if (isNodeRunning(node)) return "运行中，暂不能切换视频";
		return hasVideoResource(node) ? "已有视频资源。点击重新选择/导入原视频。" : "未选择视频。点击导入/选择原视频。";
	}
	if (key === "image") {
		if (isNodeImporting(node, key)) return "正在导入参考图...";
		if (isNodeRunning(node)) return "运行中，暂不能切换参考图";
		return hasImageResource(node) ? "已有参考图。点击重新选择/导入参考图。" : "未选择参考图。点击导入/选择参考图。";
	}
	if (key === "link" && buttonDisabled(node, key)) return "没有可断开或可恢复的外链";
	if (key === "size") {
		return buttonActive(node, key) ? "尺寸：原视频尺寸。点击打开尺寸面板。" : "尺寸：面板尺寸。点击打开尺寸面板。";
	}
	if (key === "director") return buttonActive(node, key) ? "导演台：已有分段/音频设置。点击打开。" : "导演台：未设置分段。点击打开。";
	if (key === "model") {
		if (boolValue(getWidget(node, "keep_model_loaded", false))) return "模型：保持模型已开启，分段之间不会卸载模型。点击查看/调整。";
		return buttonActive(node, key) ? "模型：已有模型选择。点击查看/调整。" : "模型：未手动选择，运行时按关键词自动匹配。";
	}
	if (key === "other") return buttonActive(node, key) ? "参数：已有非默认参数。点击调整。" : "参数：默认参数。点击调整。";
	if (key === "run") {
		if (isNodeRunning(node)) return "正在运行...";
		return buttonActive(node, key) ? "资源已就绪，点击执行当前节点。" : "请先选择或连接原视频。";
	}
	return baseTitle;
}

function buttonColors(node, key) {
	const disabled = buttonDisabled(node, key);
	const active = buttonActive(node, key);
	if (disabled) return ["#0b1114", "#25343d", "#71808a"];
	if (key === "video" || key === "image") {
		if (isNodeRunning(node) || isNodeImporting(node, key)) return ["#3a3214", "#d0a927", "#fff0a8"];
		if (active) return key === "video" ? ["#14334a", "#4c9bd1", "#e2f4ff"] : ["#2f2748", "#9d79ff", "#f0eaff"];
		return ["#10181d", "#4b6270", "#9aa8af"];
	}
	if (key === "link") return active ? ["#173b3f", "#42b4c8", "#d9fbff"] : ["#10181d", "#4b6270", "#f3f7f2"];
	if (key === "mode") return active ? ["#3a2748", "#b77cf2", "#f6e8ff"] : ["#14334a", "#4c9bd1", "#e2f4ff"];
	if (key === "director") return active ? ["#183a4a", "#58afd8", "#e0f7ff"] : ["#10181d", "#4b6270", "#f3f7f2"];
	if (key === "size" && active) return ["#263414", "#94b84a", "#f2ffd6"];
	if (key === "model") {
		if (boolValue(getWidget(node, "keep_model_loaded", false))) return ["#3a3214", "#d0a927", "#fff0a8"];
		return active ? ["#352b12", "#d0a927", "#fff0a8"] : ["#10181d", "#4b6270", "#f3f7f2"];
	}
	if (key === "other") return active ? ["#302f18", "#b5b85a", "#fdffd9"] : ["#10181d", "#4b6270", "#f3f7f2"];
	if (key === "run") {
		if (isNodeRunning(node)) return ["#3a3214", "#d0a927", "#fff0a8"];
		return active ? ["#143d2a", "#45b66f", "#dcffe8"] : ["#10181d", "#4b6270", "#9aa8af"];
	}
	if (active) return ["#244b3a", "#4dac6d", "#d9ffe8"];
	return ["#10181d", "#4b6270", "#f3f7f2"];
}

function updateDomButtonState(node, button, key, baseTitle) {
	const [background, border, color] = buttonColors(node, key);
	const active = buttonActive(node, key);
	const disabled = buttonDisabled(node, key);
	button.dataset.active = active ? "true" : "false";
	button.disabled = disabled;
	const config = BUTTONS.find((item) => item[0] === key);
	button.textContent = buttonIcon(node, key, config?.[1] || "");
	button.title = buttonTitle(node, key, baseTitle);
	button.style.background = background;
	button.style.borderColor = border;
	button.style.color = color;
	button.style.opacity = disabled ? "0.45" : "1";
	button.style.cursor = disabled ? "not-allowed" : "pointer";
	button.style.boxShadow = active && !disabled ? `0 0 0 1px ${border}66 inset` : "none";
}

function updateDomToolbarState(node) {
	const buttons = node?.__gjjScail2DomButtons;
	if (!buttons) return;
	for (const [key, button] of Object.entries(buttons)) {
		updateDomButtonState(node, button, key, button.__gjjScail2Title || button.title || "");
	}
}

function statusSummary(node) {
	const videos = selectedItems(node, "selected_video_json");
	const refs = selectedItems(node, "selected_reference_json");
	const linkedVideo = hasLinkedInput(node, "original_video");
	const linkedRef = hasLinkedInput(node, "reference_image");
	const videoText = linkedVideo ? "视频：外链输入" : videos.length ? `视频：${videos.length}段` : "视频：未选择";
	const refText = linkedRef ? "参考图：外链输入" : refs.length ? `参考图：${refs.length}张` : "参考图：未选择";
	const finalVideo = node.properties?.gjj_scail2_final_video;
	if (finalVideo?.filename) return `${videoText} · ${refText} · 输出：${finalVideo.subfolder ? `${finalVideo.subfolder}/` : ""}${finalVideo.filename}`;
	return `${videoText} · ${refText}`;
}

function setStatus(node, text = "", progress = null, extra = {}) {
	node.properties ||= {};
	node.properties.gjj_scail2_status_text = String(text || "");
	if (progress == null || !Number.isFinite(Number(progress))) {
		delete node.properties.gjj_scail2_status_progress;
	} else {
		node.properties.gjj_scail2_status_progress = Math.max(0, Math.min(1, Number(progress)));
	}
	if (extra.final_video) {
		node.properties.gjj_scail2_final_video = normalizeMediaItem(extra.final_video);
		addPreviewPanel(node);
		reorderWidgets(node);
		ensureSize(node);
	}
	updateStatusPanel(node);
	updatePreviewPanel(node);
	app.graph?.setDirtyCanvas?.(true, true);
}

function updateStatusPanel(node) {
	const panel = node?.__gjjScail2StatusPanel;
	if (!panel) return;
	const textEl = panel.querySelector(".gjj-scail2-status-text");
	const fillEl = panel.querySelector(".gjj-scail2-status-fill");
	const progress = node.properties?.gjj_scail2_status_progress;
	const running = isNodeRunning(node);
	const importing = isNodeImporting(node, "video") || isNodeImporting(node, "image");
	const text = running || importing
		? (node.properties?.gjj_scail2_status_text || (importing ? "正在导入资源..." : "正在运行..."))
		: statusSummary(node);
	if (textEl) textEl.textContent = text;
	const width = progress == null ? (running || importing ? 8 : 0) : Math.round(Number(progress) * 100);
	if (fillEl) {
		fillEl.style.width = `${Math.max(0, Math.min(100, width))}%`;
		fillEl.style.opacity = running || importing || progress != null ? "1" : "0";
	}
	panel.title = text;
}

function addStatusPanel(node) {
	if (node.__gjjScail2StatusWidget && (node.widgets || []).includes(node.__gjjScail2StatusWidget)) {
		updateStatusPanel(node);
		return true;
	}
	if (typeof node.addDOMWidget !== "function") return false;
	const panel = document.createElement("div");
	panel.className = "gjj-scail2-status-panel";
	panel.style.cssText = [
		"height:30px",
		"width:100%",
		"box-sizing:border-box",
		"border:1px solid #314750",
		"border-radius:6px",
		"background:#0b1216",
		"overflow:hidden",
		"position:relative",
		"pointer-events:none",
	].join(";");
	const fill = document.createElement("div");
	fill.className = "gjj-scail2-status-fill";
	fill.style.cssText = "position:absolute;left:0;top:0;bottom:0;width:0%;background:linear-gradient(90deg,#164a62,#3a6f45);opacity:0;transition:width .18s ease,opacity .18s ease;";
	const text = document.createElement("div");
	text.className = "gjj-scail2-status-text";
	text.style.cssText = "position:relative;z-index:1;height:100%;display:flex;align-items:center;padding:0 8px;color:#cfe1e8;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
	panel.append(fill, text);
	const status = node.addDOMWidget(STATUS_WIDGET, "HTML", panel, {
		getValue: () => "",
		setValue: () => {},
		serialize: false,
		hideOnZoom: false,
		getHeight: () => STATUS_HEIGHT,
	});
	if (!status) return false;
	status.__gjjScail2Keep = true;
	status.__gjjScail2ToolbarName = STATUS_WIDGET;
	status.name = STATUS_WIDGET;
	status.label = "";
	status.serialize = false;
	status.computeSize = (width) => [Math.max(280, Number(width || 280)), STATUS_HEIGHT];
	status.getHeight = () => STATUS_HEIGHT;
	status.draw = () => {};
	node.__gjjScail2StatusWidget = status;
	node.__gjjScail2StatusPanel = panel;
	updateStatusPanel(node);
	return true;
}

function updatePreviewPanel(node) {
	const panel = node?.__gjjScail2PreviewPanel;
	if (!panel) return;
	const item = node.properties?.gjj_scail2_final_video;
	panel.replaceChildren();
	if (!item?.filename) {
		panel.style.display = "none";
		return;
	}
	panel.style.display = "block";
	const videoHeight = previewVideoHeight(node);
	panel.style.height = `${previewPanelHeight(node)}px`;
	const video = document.createElement("video");
	video.controls = true;
	video.src = viewUrl(item);
	video.style.cssText = `width:100%;height:${videoHeight}px;object-fit:contain;background:#05090b;border:1px solid #30434d;border-radius:6px;`;
	video.onloadedmetadata = () => {
		if (!video.videoWidth || !video.videoHeight) return;
		node.properties ||= {};
		const nextAspect = video.videoHeight / video.videoWidth;
		if (Math.abs(Number(node.properties.gjj_scail2_preview_aspect || 0) - nextAspect) < 0.001) return;
		node.properties.gjj_scail2_preview_aspect = nextAspect;
		ensureSize(node);
		updatePreviewPanel(node);
		app.graph?.setDirtyCanvas?.(true, true);
	};
	const label = document.createElement("div");
	label.textContent = mediaLabel(item);
	label.style.cssText = "height:20px;line-height:20px;color:#cfe1e8;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;";
	panel.append(video, label);
}

function addPreviewPanel(node) {
	if (node.__gjjScail2PreviewWidget && (node.widgets || []).includes(node.__gjjScail2PreviewWidget)) {
		updatePreviewPanel(node);
		return true;
	}
	if (typeof node.addDOMWidget !== "function") return false;
	const panel = document.createElement("div");
	panel.className = "gjj-scail2-preview-panel";
	panel.style.cssText = "width:100%;box-sizing:border-box;padding-top:4px;pointer-events:auto;";
	const preview = node.addDOMWidget(PREVIEW_WIDGET, "HTML", panel, {
		getValue: () => "",
		setValue: () => {},
		serialize: false,
		hideOnZoom: false,
		getHeight: () => previewPanelHeight(node),
	});
	if (!preview) return false;
	preview.__gjjScail2Keep = true;
	preview.__gjjScail2ToolbarName = PREVIEW_WIDGET;
	preview.name = PREVIEW_WIDGET;
	preview.label = "";
	preview.serialize = false;
	preview.computeSize = (width) => [Math.max(280, Number(width || 280)), previewPanelHeight(node, width)];
	preview.getHeight = () => previewPanelHeight(node);
	preview.draw = () => {};
	node.__gjjScail2PreviewWidget = preview;
	node.__gjjScail2PreviewPanel = panel;
	updatePreviewPanel(node);
	return true;
}

function domButton(node, key, icon, title, action) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = icon;
	button.title = title;
	button.__gjjScail2Title = title;
	button.style.cssText = [
		"width:28px",
		"min-width:28px",
		"max-width:28px",
		"height:28px",
		"min-height:28px",
		"max-height:28px",
		"padding:0",
		"display:inline-flex",
		"align-items:center",
		"justify-content:center",
		"border:1px solid #4b6270",
		"border-radius:6px",
		"background:#10181d",
		"color:#f3f7f2",
		"font-size:16px",
		"line-height:1",
		"cursor:pointer",
		"pointer-events:auto",
	].join(";");
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
		button.addEventListener(eventName, (event) => event.stopPropagation(), true);
	}
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (buttonDisabled(node, key)) return;
		action?.();
		updateDomToolbarState(node);
	});
	updateDomButtonState(node, button, key, title);
	return button;
}

function addDomToolbar(node) {
	if (node.__gjjScail2DomToolbar && (node.widgets || []).includes(node.__gjjScail2DomToolbar)) {
		node.__gjjScail2HasDomToolbar = true;
		return true;
	}
	removeOldToolbar(node);
	node.__gjjScail2DomToolbar = null;
	node.__gjjScail2HasDomToolbar = false;
	if (typeof node.addDOMWidget !== "function") return false;
	const row = document.createElement("div");
	row.style.cssText = [
		"height:34px",
		"display:flex",
		"align-items:center",
		"gap:2px",
		"width:100%",
		"overflow:visible",
		"box-sizing:border-box",
		"padding:2px 0 0 0",
		"pointer-events:auto",
	].join(";");
	const actions = toolbarActions(node);
	node.__gjjScail2DomButtons = {};
	for (const [key, icon, title] of BUTTONS) {
		const button = domButton(node, key, icon, title, actions[key]);
		node.__gjjScail2DomButtons[key] = button;
		row.appendChild(button);
	}
	const toolbar = node.addDOMWidget(TOOLBAR_WIDGET, "HTML", row, {
		getValue: () => "",
		setValue: () => {},
		serialize: false,
		hideOnZoom: false,
		getHeight: () => 36,
	});
	if (!toolbar) return false;
	toolbar.__gjjScail2Keep = true;
	toolbar.__gjjScail2ToolbarName = TOOLBAR_WIDGET;
	toolbar.name = TOOLBAR_WIDGET;
	toolbar.label = "";
	toolbar.serialize = false;
	toolbar.computeSize = (width) => [Math.max(280, Number(width || 280)), 36];
	toolbar.getHeight = () => 36;
	toolbar.draw = () => {};
	node.__gjjScail2DomToolbar = toolbar;
	node.__gjjScail2HasDomToolbar = true;
	const positiveIndex = (node.widgets || []).findIndex((item) => String(item?.name || "") === "positive_prompt");
	const toolbarIndex = (node.widgets || []).indexOf(toolbar);
	if (positiveIndex >= 0 && toolbarIndex >= 0 && toolbarIndex > positiveIndex) {
		node.widgets.splice(toolbarIndex, 1);
		node.widgets.splice(positiveIndex, 0, toolbar);
	}
	return true;
}

function reorderWidgets(node) {
	if (!Array.isArray(node.widgets)) return;
	const toolbar = node.__gjjScail2DomToolbar;
	const status = node.__gjjScail2StatusWidget;
	const preview = node.__gjjScail2PreviewWidget;
	for (const item of [toolbar, status, preview]) {
		if (item) item.serialize = false;
	}
	if (!toolbar || !node.widgets.includes(toolbar)) return;
	const positiveIndex = node.widgets.findIndex((item) => String(item?.name || "") === "positive_prompt");
	if (positiveIndex < 0) return;
	const beforePrompt = [toolbar, status].filter((item) => item && node.widgets.includes(item));
	const afterPrompt = [preview].filter((item) => item && node.widgets.includes(item));
	for (const item of [...beforePrompt, ...afterPrompt]) {
		const index = node.widgets.indexOf(item);
		if (index >= 0) node.widgets.splice(index, 1);
	}
	const insertAt = node.widgets.findIndex((item) => String(item?.name || "") === "positive_prompt");
	node.widgets.splice(Math.max(0, insertAt), 0, ...beforePrompt);
	const promptAfterInsert = node.widgets.findIndex((item) => String(item?.name || "") === "positive_prompt");
	if (promptAfterInsert >= 0 && afterPrompt.length) {
		node.widgets.splice(promptAfterInsert + 1, 0, ...afterPrompt);
	}
}

function stabilize(node) {
	if (!node || !isTarget(node)) return;
	addDomToolbar(node);
	addStatusPanel(node);
	addPreviewPanel(node);
	hideNativeWidgets(node);
	reorderWidgets(node);
	sanitizeWidgetValues(node);
	ensureSize(node);
	updateDomToolbarState(node);
	updateStatusPanel(node);
	updatePreviewPanel(node);
	app.graph?.setDirtyCanvas?.(true, true);
}

function drawRoundRect(ctx, x, y, w, h, r) {
	if (ctx.roundRect) {
		ctx.beginPath();
		ctx.roundRect(x, y, w, h, r);
		return;
	}
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + w - r, y);
	ctx.quadraticCurveTo(x + w, y, x + w, y + r);
	ctx.lineTo(x + w, y + h - r);
	ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
	ctx.lineTo(x + r, y + h);
	ctx.quadraticCurveTo(x, y + h, x, y + h - r);
	ctx.lineTo(x, y + r);
	ctx.quadraticCurveTo(x, y, x + r, y);
}

function toolbarActions(node) {
	return {
		video: () => openMediaPicker(node, "video"),
		link: () => toggleLinks(node),
		image: () => openMediaPicker(node, "image"),
		mode: () => {
			setWidget(node, "mode_replacement", !boolValue(getWidget(node, "mode_replacement", false)));
			updateDomToolbarState(node);
			app.graph?.setDirtyCanvas?.(true, true);
		},
		director: () => openDirector(node),
		size: () => openFieldPopup(node, "尺寸", SIZE_FIELDS),
		model: () => openModelPopup(node),
		other: () => openFieldPopup(node, "参数", OTHER_FIELDS),
		run: () => runOnlyThisNode(node),
	};
}

function drawToolbar(node, ctx) {
	if (!isTarget(node) || !ctx) return;
	ensureSize(node);
	const actions = toolbarActions(node);
	node.__gjjScail2Rects = [];
	ctx.save();
	ctx.font = "18px sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	const x0 = 22;
	const promptWidget = widget(node, "positive_prompt");
	const promptY = Number(promptWidget?.last_y ?? promptWidget?.y ?? 0);
	const toolbarY = Math.max(74, Math.min(Number(node.size?.[1] || NODE_HEIGHT) - BUTTON_SIZE - 12, (promptY > 0 ? promptY - BUTTON_SIZE - 10 : BUTTON_Y)));
	for (let index = 0; index < BUTTONS.length; index += 1) {
		const [key, icon, title] = BUTTONS[index];
		const x = x0 + index * (BUTTON_SIZE + BUTTON_GAP);
		const disabled = buttonDisabled(node, key);
		const [background, border, color] = buttonColors(node, key);
		const drawIcon = buttonIcon(node, key, icon);
		ctx.fillStyle = background;
		ctx.strokeStyle = border;
		ctx.lineWidth = 1.5;
		ctx.globalAlpha = disabled ? 0.48 : 1;
		drawRoundRect(ctx, x, toolbarY, BUTTON_SIZE, BUTTON_SIZE, 6);
		ctx.fill();
		ctx.stroke();
		ctx.globalAlpha = 1;
		ctx.fillStyle = color;
		ctx.fillText(drawIcon, x + BUTTON_SIZE / 2, toolbarY + BUTTON_SIZE / 2 + 1);
		node.__gjjScail2Rects.push({ x, y: toolbarY, w: BUTTON_SIZE, h: BUTTON_SIZE, title: buttonTitle(node, key, title), action: actions[key], disabled });
	}
	ctx.restore();
}

function handleToolbarClick(node, event, pos) {
	if (!isTarget(node)) return false;
	const x = Number(pos?.[0] ?? -1);
	const y = Number(pos?.[1] ?? -1);
	for (const rect of node.__gjjScail2Rects || []) {
		if (x < rect.x || x > rect.x + rect.w || y < rect.y || y > rect.y + rect.h) continue;
		event?.preventDefault?.();
		event?.stopPropagation?.();
		if (rect.disabled) return true;
		rect.action?.();
		return true;
	}
	return false;
}

function hasAnyLink(node) {
	return (node.inputs || []).some((input) => input?.link != null);
}

function savedLinks(node) {
	return Array.isArray(node.properties?.gjj_scail2_saved_links) ? node.properties.gjj_scail2_saved_links : [];
}

function toggleLinks(node) {
	node.properties ||= {};
	if (hasAnyLink(node)) {
		const links = [];
		for (let inputIndex = 0; inputIndex < (node.inputs || []).length; inputIndex += 1) {
			const input = node.inputs[inputIndex];
			if (input?.link == null) continue;
			const link = app.graph?.links?.[input.link] || app.graph?.links?.get?.(input.link);
			if (link) {
				links.push({
					inputIndex,
					originId: link.origin_id,
					originSlot: link.origin_slot,
				});
			}
			node.disconnectInput?.(inputIndex);
		}
		node.properties.gjj_scail2_saved_links = links;
	} else {
		for (const link of savedLinks(node)) {
			const origin = app.graph?.getNodeById?.(link.originId);
			if (origin) origin.connect?.(link.originSlot, node, link.inputIndex);
		}
		node.properties.gjj_scail2_saved_links = [];
	}
	app.graph?.setDirtyCanvas?.(true, true);
}

async function uploadVideoFiles(files) {
	const list = Array.from(files || []).filter((file) => file instanceof File);
	if (!list.length) return [];
	const result = [];
	for (const file of list) {
		const reused = await findExistingMediaByHash(file, "video");
		if (reused) {
			result.push(reused);
			continue;
		}
		const form = new FormData();
		form.append("video", file, file.name || "video.mp4");
		const data = await fetchJson(VIDEO_UPLOAD_API, { method: "POST", body: form });
		result.push(...normalizeMediaItems(Array.isArray(data.videos) ? data.videos : []));
	}
	return result;
}

async function uploadImageFiles(files) {
	const list = Array.from(files || []).filter((file) => file instanceof File);
	const result = [];
	for (const file of list) {
		const reused = await findExistingMediaByHash(file, "image");
		if (reused) {
			result.push(reused);
			continue;
		}
		const form = new FormData();
		form.append("image", file, file.name || "image.png");
		const data = await fetchJson(TEMP_IMAGE_UPLOAD_API, { method: "POST", body: form });
		result.push(...normalizeMediaItems(Array.isArray(data.images) ? data.images : Array.isArray(data.items) ? data.items : []));
	}
	return result;
}

async function uploadAudioFiles(files) {
	const list = Array.from(files || []).filter((file) => file instanceof File);
	const result = [];
	for (const file of list) {
		const reused = await findExistingMediaByHash(file, "audio");
		if (reused) {
			result.push(reused);
			continue;
		}
		const form = new FormData();
		form.append("audio", file, file.name || "audio.wav");
		const data = await fetchJson(AUDIO_UPLOAD_API, { method: "POST", body: form });
		result.push(...normalizeMediaItems(Array.isArray(data.audios) ? data.audios : []));
	}
	return result;
}

async function sha256File(file) {
	const buffer = await file.arrayBuffer();
	const hash = await crypto.subtle.digest("SHA-256", buffer);
	return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function findExistingMediaByHash(file, kind) {
	try {
		const digest = await sha256File(file);
		const data = await fetchJson(`${MEDIA_BY_HASH_API}?hash=${encodeURIComponent(digest)}&kind=${encodeURIComponent(kind || "")}`);
		const match = data.match || (Array.isArray(data.items) ? data.items[0] : null);
		return match ? normalizeMediaItem(match) : null;
	} catch (error) {
		console.warn("[GJJ SCAIL2 AIO] hash lookup failed", error);
		return null;
	}
}

function openMediaPicker(node, kind) {
	if (kind === "video" && hasLinkedInput(node, "original_video")) return;
	if (kind === "image" && hasLinkedInput(node, "reference_image")) return;
	const input = document.createElement("input");
	input.type = "file";
	input.multiple = kind === "image";
	input.accept = kind === "video" ? "video/*" : "image/*";
	input.style.display = "none";
	input.addEventListener("change", async () => {
		const files = Array.from(input.files || []);
		if (!files.length) {
			input.remove();
			return;
		}
		const importKey = `${node?.id ?? ""}:${kind}`;
		try {
			IMPORTING_NODE_IDS.add(importKey);
			setStatus(node, kind === "video" ? "正在导入视频..." : "正在导入参考图...", 0.08);
			updateDomToolbarState(node);
			if (kind === "video") {
				const videos = await uploadVideoFiles(files);
				if (videos.length) setSelectedItems(node, "selected_video_json", videos);
			} else {
				const images = await uploadImageFiles(files);
				if (images.length) setSelectedItems(node, "selected_reference_json", images);
			}
			setStatus(node, kind === "video" ? "视频导入完成。" : "参考图导入完成。", 1.0);
			stabilize(node);
		} catch (error) {
			setStatus(node, error?.message || "导入失败", null);
			alert(error?.message || "导入失败");
		} finally {
			IMPORTING_NODE_IDS.delete(importKey);
			updateDomToolbarState(node);
			updateStatusPanel(node);
			input.remove();
		}
	});
	document.body.appendChild(input);
	input.click();
}

function clamp(value, min, max) {
	return Math.max(min, Math.min(max, value));
}

function graphPointToClient(canvas, x, y) {
	const element = canvas?.canvas;
	const rect = element?.getBoundingClientRect?.();
	if (!rect) return null;
	const converted = typeof canvas.convertOffsetToCanvas === "function"
		? canvas.convertOffsetToCanvas([x, y])
		: [
			(x + Number(canvas?.ds?.offset?.[0] || 0)) * Number(canvas?.ds?.scale || 1),
			(y + Number(canvas?.ds?.offset?.[1] || 0)) * Number(canvas?.ds?.scale || 1),
		];
	return {
		x: rect.left + Number(converted?.[0] || 0),
		y: rect.top + Number(converted?.[1] || 0),
		canvasRect: rect,
	};
}

function positionPopupNearNode(wrap, node) {
	const canvas = app.canvas;
	const nodeX = Number(node?.pos?.[0] || 0);
	const nodeY = Number(node?.pos?.[1] || 0);
	const width = Math.max(120, Number(node?.size?.[0] || 120));
	const height = Math.max(80, Number(node?.size?.[1] || NODE_HEIGHT));
	const buttonRowWidth = 22 + BUTTONS.length * BUTTON_SIZE + Math.max(0, BUTTONS.length - 1) * BUTTON_GAP;
	const topLeft = graphPointToClient(canvas, nodeX, nodeY);
	const topRight = graphPointToClient(canvas, nodeX + width, nodeY);
	const buttonRight = graphPointToClient(canvas, nodeX + Math.max(width, buttonRowWidth), nodeY + BUTTON_Y);
	const bottomLeft = graphPointToClient(canvas, nodeX, nodeY + height);
	if (!topLeft || !topRight) {
		wrap.style.left = "50%";
		wrap.style.top = "50%";
		wrap.style.transform = "translate(-50%,-50%)";
		return;
	}
	const rect = wrap.getBoundingClientRect();
	const popupWidth = Math.max(260, rect.width || Number.parseFloat(wrap.style.width) || 360);
	const popupHeight = Math.max(120, rect.height || 240);
	const margin = 12;
	const rightAnchor = Math.max(topRight.x, Number(buttonRight?.x || topRight.x));
	const preferredLeft = rightAnchor + margin;
	const leftSide = topLeft.x - popupWidth - margin;
	const belowTop = Number(bottomLeft?.y || topLeft.y) + margin;
	const canUseRight = preferredLeft + popupWidth <= window.innerWidth - margin;
	const canUseBelow = belowTop + popupHeight <= window.innerHeight - margin;
	const rawLeft = canUseRight ? preferredLeft : (canUseBelow ? topLeft.x : leftSide);
	const rawTop = canUseRight ? topLeft.y : (canUseBelow ? belowTop : topLeft.y);
	const left = clamp(rawLeft, margin, Math.max(margin, window.innerWidth - popupWidth - margin));
	const top = clamp(rawTop, margin, Math.max(margin, window.innerHeight - popupHeight - margin));
	wrap.style.left = `${left}px`;
	wrap.style.top = `${top}px`;
	wrap.style.transform = "none";
}

function followNodePopup(wrap, node) {
	const update = () => {
		if (!wrap.isConnected) return;
		if (!wrap.__gjjScail2ManualPosition) positionPopupNearNode(wrap, node);
		wrap.__gjjScail2PopupFrame = requestAnimationFrame(update);
	};
	update();
}

function makePopupDraggable(wrap, handle) {
	handle.style.cursor = "move";
	handle.title = handle.title || "拖动移动窗口";
	handle.addEventListener("pointerdown", (event) => {
		if (event.target?.tagName === "BUTTON") return;
		event.preventDefault();
		event.stopPropagation();
		wrap.__gjjScail2ManualPosition = true;
		const rect = wrap.getBoundingClientRect();
		const startX = Number(event.clientX || 0);
		const startY = Number(event.clientY || 0);
		const baseLeft = rect.left;
		const baseTop = rect.top;
		handle.setPointerCapture?.(event.pointerId);
		const move = (moveEvent) => {
			const popupRect = wrap.getBoundingClientRect();
			const margin = 8;
			const left = clamp(baseLeft + Number(moveEvent.clientX || 0) - startX, margin, Math.max(margin, window.innerWidth - popupRect.width - margin));
			const top = clamp(baseTop + Number(moveEvent.clientY || 0) - startY, margin, Math.max(margin, window.innerHeight - popupRect.height - margin));
			wrap.style.left = `${left}px`;
			wrap.style.top = `${top}px`;
			wrap.style.transform = "none";
		};
		const up = (upEvent) => {
			handle.releasePointerCapture?.(upEvent.pointerId);
			document.removeEventListener("pointermove", move, true);
			document.removeEventListener("pointerup", up, true);
		};
		document.addEventListener("pointermove", move, true);
		document.addEventListener("pointerup", up, true);
	}, true);
}

function popupBase(title, width = 360, node = null) {
	closePopup();
	const wrap = document.createElement("div");
	wrap.className = "gjj-scail2-popup";
	wrap.style.cssText = [
		"position:fixed",
		"z-index:999999",
		"left:12px",
		"top:12px",
		"transform:none",
		`width:${width}px`,
		"max-width:calc(100vw - 40px)",
		"max-height:calc(100vh - 40px)",
		"overflow:auto",
		"resize:both",
		"background:#10181d",
		"color:#eef7f2",
		"border:1px solid #4b6270",
		"border-radius:8px",
		"box-shadow:0 18px 60px rgba(0,0,0,.55)",
		"font:13px system-ui,sans-serif",
		"padding:10px",
	].join(";");
	const head = document.createElement("div");
	head.style.cssText = "display:flex;align-items:center;gap:8px;margin:-2px -2px 10px -2px;padding:2px;";
	const label = document.createElement("b");
	label.textContent = title;
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "×";
	close.title = "关闭";
	close.style.cssText = "margin-left:auto;width:28px;height:28px;border:1px solid #465761;border-radius:6px;background:#151d22;color:#fff;";
	close.onclick = closePopup;
	head.append(label, close);
	wrap.appendChild(head);
	makePopupDraggable(wrap, head);
	wrap.addEventListener("pointerdown", (event) => event.stopPropagation());
	document.body.appendChild(wrap);
	if (node) followNodePopup(wrap, node);
	return wrap;
}

function closePopup() {
	document.querySelectorAll(".gjj-scail2-popup").forEach((item) => {
		if (item.__gjjScail2PopupFrame) cancelAnimationFrame(item.__gjjScail2PopupFrame);
		item.remove();
	});
}

function alignFieldNumber(value, meta = {}) {
	let number = Number(value);
	if (!Number.isFinite(number)) return value;
	if (meta.allowZero && number === 0) return 0;
	if (meta.align === "multiple16") {
		number = Math.max(Number(meta.min || 16), Math.round(number / 16) * 16);
	} else if (meta.align === "frames4n1") {
		const min = Number(meta.min || 1);
		number = Math.max(min, Math.round((number - 1) / 4) * 4 + 1);
		if (number < min) number = Math.ceil((min - 1) / 4) * 4 + 1;
	} else if (meta.min != null) {
		number = Math.max(Number(meta.min), number);
	}
	return number;
}

function fieldInput(node, name, type, meta = {}) {
	const current = getWidget(node, name, "");
	let input;
	const notifyFieldChange = () => input.dispatchEvent(new CustomEvent("gjj-field-change", { bubbles: true }));
	const baseStyle = "width:100%;box-sizing:border-box;border:1px solid #3f525d;border-radius:6px;background:#1b2429;color:#eef7f2;padding:6px;";
	if (type === "checkbox") {
		input = document.createElement("input");
		input.type = "checkbox";
		input.checked = !!current;
		input.onchange = () => {
			setWidget(node, name, input.checked);
			notifyFieldChange();
		};
		input.style.cssText = baseStyle;
	} else if (type === "segmented" || type === "select") {
		input = document.createElement("div");
		const options = Array.isArray(meta.options) && meta.options.length ? meta.options : [String(current || "")];
		const selected = options.includes(current) ? String(current) : String(meta.default || options[0] || "");
		input.__gjjFieldControls = [];
		input.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;width:100%;";
		const refreshButtons = () => {
			for (const button of input.__gjjFieldControls || []) {
				const active = String(button.dataset.value || "") === String(getWidget(node, name, selected));
				button.style.background = active ? "#155e75" : "#1b2429";
				button.style.borderColor = active ? "#38bdf8" : "#3f525d";
				button.style.color = active ? "#e0f7ff" : "#d8e5ea";
				button.style.boxShadow = active ? "0 0 0 1px rgba(56,189,248,.25) inset" : "none";
			}
		};
		for (const optionText of options) {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = String(optionText);
			button.dataset.value = String(optionText);
			button.style.cssText = "min-width:66px;height:30px;border:1px solid #3f525d;border-radius:7px;background:#1b2429;color:#d8e5ea;padding:0 10px;cursor:pointer;";
			button.onclick = () => {
				if (input.__gjjDisabled) return;
				setWidget(node, name, String(optionText));
				refreshButtons();
				notifyFieldChange();
			};
			input.__gjjFieldControls.push(button);
			input.appendChild(button);
		}
		setWidget(node, name, selected);
		refreshButtons();
	} else if (type === "textarea") {
		input = document.createElement("textarea");
		input.value = String(current || "");
		input.rows = 4;
		input.oninput = () => {
			setWidget(node, name, input.value);
			notifyFieldChange();
		};
		input.style.cssText = baseStyle;
	} else if (type === "number") {
		input = document.createElement("div");
		input.style.cssText = "display:grid;grid-template-columns:minmax(120px,1fr) 78px;gap:8px;align-items:center;width:100%;";
		const slider = document.createElement("input");
		slider.type = "range";
		const min = Number(meta.min ?? 0);
		const max = Number(meta.max ?? Math.max(min + 100, Number(current || 0) * 2 || 100));
		const step = meta.align === "multiple16" ? 16 : (meta.align === "frames4n1" ? 4 : (Number.isInteger(Number(current)) ? 1 : 0.1));
		slider.min = String(min);
		slider.max = String(max);
		slider.step = String(step);
		slider.value = String(clamp(Number(current || meta.default || min), min, max));
		slider.style.cssText = "width:100%;accent-color:#38bdf8;";
		const value = document.createElement("input");
		value.type = "number";
		value.value = String(current ?? "");
		value.min = String(min);
		value.max = String(max);
		value.step = String(step);
		value.style.cssText = "width:78px;box-sizing:border-box;border:1px solid #3f525d;border-radius:6px;background:#1b2429;color:#eef7f2;padding:6px;text-align:right;";
		input.__gjjFieldControls = [slider, value];
		const setBoth = (next, commit = false) => {
			const raw = commit ? alignFieldNumber(next, meta) : Number(next);
			const numeric = Number.isFinite(Number(raw)) ? clamp(Number(raw), min, max) : min;
			slider.value = String(numeric);
			value.value = String(numeric);
			setWidget(node, name, numeric);
			notifyFieldChange();
		};
		slider.oninput = () => setBoth(slider.value, false);
		slider.onchange = () => setBoth(slider.value, true);
		value.oninput = () => setBoth(value.value, false);
		value.addEventListener("blur", () => setBoth(value.value, true));
		value.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			setBoth(value.value, true);
			value.blur();
		});
		input.append(slider, value);
	} else {
		input = document.createElement("input");
		input.type = "text";
		input.value = String((current == null || current === "") && meta.default != null ? meta.default : current ?? "");
		if ((current == null || current === "") && meta.default != null) setWidget(node, name, meta.default);
		input.oninput = () => {
			setWidget(node, name, input.value);
			notifyFieldChange();
		};
		input.style.cssText = baseStyle;
	}
	if (meta.tooltip) input.title = meta.tooltip;
	input.__gjjFieldName = name;
	input.__gjjFieldMeta = meta;
	return input;
}

function booleanButtonField(node, name, label, meta = {}) {
	const wrap = document.createElement("button");
	wrap.type = "button";
	wrap.textContent = label;
	wrap.__gjjFieldName = name;
	wrap.__gjjFieldMeta = meta;
	wrap.__gjjFieldControls = [wrap];
	wrap.style.cssText = "height:30px;border:1px solid #3f525d;border-radius:7px;background:#1b2429;color:#d8e5ea;padding:0 10px;cursor:pointer;white-space:nowrap;";
	const refresh = () => {
		const active = boolValue(getWidget(node, name, false));
		wrap.dataset.active = active ? "true" : "false";
		wrap.style.background = active ? "#155e75" : "#1b2429";
		wrap.style.borderColor = active ? "#38bdf8" : "#3f525d";
		wrap.style.color = active ? "#e0f7ff" : "#d8e5ea";
		wrap.style.boxShadow = active ? "0 0 0 1px rgba(56,189,248,.25) inset" : "none";
	};
	wrap.onclick = () => {
		if (wrap.__gjjDisabled) return;
		setWidget(node, name, !boolValue(getWidget(node, name, false)));
		refresh();
		wrap.dispatchEvent(new CustomEvent("gjj-field-change", { bubbles: true }));
	};
	if (meta.tooltip) wrap.title = meta.tooltip;
	refresh();
	return wrap;
}

function refreshFieldDisabledState(node, inputs) {
	for (const input of inputs) {
		const meta = input.__gjjFieldMeta || {};
		const disabledWhen = Array.isArray(meta.disabledWhen) ? meta.disabledWhen : null;
		const disabled = disabledWhen ? (disabledWhen[2] ? getWidget(node, disabledWhen[0], "") !== disabledWhen[1] : getWidget(node, disabledWhen[0], "") === disabledWhen[1]) : false;
		input.__gjjDisabled = disabled;
		input.disabled = disabled;
		input.style.opacity = disabled ? "0.42" : "1";
		input.style.cursor = disabled ? "not-allowed" : "";
		for (const control of input.__gjjFieldControls || []) {
			control.disabled = disabled;
			control.style.cursor = disabled ? "not-allowed" : (control.tagName === "BUTTON" ? "pointer" : "");
		}
		input.title = disabled
			? `${meta.tooltip || ""}\n当前状态下此项不可编辑。`.trim()
			: (meta.tooltip || "");
		const label = input.__gjjFieldLabel;
		if (label) label.style.opacity = disabled ? "0.5" : "1";
	}
}

function openFieldPopup(node, title, fields) {
	const wrap = popupBase(title, title === "尺寸" || title === "参数" ? 540 : 420, node);
	if (title === "参数") {
		const notice = document.createElement("div");
		notice.textContent = "提示词可以留空。检测阈值等数字项如果留空，会自动使用默认值；检测阈值默认 0.5。";
		notice.style.cssText = "margin:0 0 10px 0;padding:8px 10px;border:1px solid #5b4a12;border-radius:6px;background:#211b08;color:#ffd84d;font-size:12px;line-height:1.45;";
		wrap.appendChild(notice);
	}
	const grid = document.createElement("div");
	grid.style.cssText = "display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:center;";
	const inputs = [];
	const booleanFields = title === "参数" ? fields.filter((field) => field[2] === "checkbox") : [];
	if (booleanFields.length) {
		const boolTitle = document.createElement("div");
		boolTitle.textContent = "开关";
		boolTitle.style.cssText = "color:#aeb9bd;margin:0 0 6px;";
		const boolRow = document.createElement("div");
		boolRow.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;";
		for (const [name, label, _type, meta = {}] of booleanFields) {
			const button = booleanButtonField(node, name, label, meta);
			inputs.push(button);
			boolRow.appendChild(button);
		}
		wrap.append(boolTitle, boolRow);
	}
	for (const [name, label, type, meta = {}] of fields) {
		if (title === "参数" && type === "checkbox") continue;
		const text = document.createElement("div");
		text.textContent = label;
		if (meta.tooltip) text.title = meta.tooltip;
		text.style.cssText = "color:#aeb9bd;";
		const input = fieldInput(node, name, type, meta);
		input.__gjjFieldLabel = text;
		inputs.push(input);
		grid.append(text, input);
	}
	wrap.addEventListener("gjj-field-change", () => refreshFieldDisabledState(node, inputs));
	wrap.appendChild(grid);
	refreshFieldDisabledState(node, inputs);
}

function modelFilterKey(value) {
	let text = String(value || "").replaceAll("\\", "/").split("/").pop().toLowerCase();
	text = text.replace(/\.(safetensors|ckpt|pt|pt2|pth|bin|gguf|onnx|engine|torchscript)$/i, "");
	text = text.replace(/(^|[_\-. ])(fp8mixed|fp8_scaled|fp8_e4m3fn|fp(?:8|16|32)|bf16|f16|f32|q[2-8](?:_[a-z0-9]+)?|int(?:4|8)|e4m3fn(?:_fast)?|e5m2|bnb(?:4|8)bit|scaled|mixed)(?=$|[_\-. ])/gi, " ");
	return text.replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").replace(/\s+/g, " ").trim();
}

function modelCompactKey(value) {
	return modelFilterKey(value).replace(/\s+/g, "");
}

function sortModelNames(names) {
	const result = [];
	const seen = new Set();
	for (const item of Array.from(names || [])) {
		const name = String(item || "").trim();
		const key = name.replaceAll("\\", "/").toLowerCase();
		if (!name || seen.has(key)) continue;
		seen.add(key);
		result.push(name);
	}
	const rank = (name) => {
		const raw = String(name || "").replaceAll("\\", "/").toLowerCase();
		if (raw.endsWith(".safetensors")) return 0;
		if (raw.endsWith(".gguf")) return 1;
		return 2;
	};
	return result.sort((a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b), "zh-Hans-u-co-pinyin", { sensitivity: "base" }));
}

function filterModelNames(names, field) {
	const keywords = Array.from(field?.keywords || []).map((keyword) => String(keyword || "").trim()).filter(Boolean);
	const anyKeywords = Array.from(field?.anyKeywords || []).map(modelFilterKey).filter(Boolean);
	const extensions = Array.from(field?.extensions || []).map((ext) => String(ext || "").trim().toLowerCase()).filter(Boolean);
	return sortModelNames(Array.from(names || []).filter((name) => {
		const key = modelFilterKey(name);
		const compactKey = modelCompactKey(name);
		const raw = String(name || "").replaceAll("\\", "/").toLowerCase();
		if (extensions.length && !extensions.some((ext) => raw.endsWith(ext))) return false;
		if (anyKeywords.length && !anyKeywords.some((keyword) => key.includes(keyword) || compactKey.includes(keyword.replace(/\s+/g, "")))) return false;
		if (keywords.length && !keywords.every((rawKeyword) => {
			if (rawKeyword.includes("|")) {
				const options = rawKeyword.split("|").map(modelFilterKey).filter(Boolean);
				return options.some((part) => key.includes(part) || compactKey.includes(part.replace(/\s+/g, "")));
			}
			const keyword = modelFilterKey(rawKeyword);
			const parts = keyword.split(/\s+/).filter(Boolean);
			const compact = parts.join("");
			return parts.every((part) => key.includes(part)) || (!!compact && compactKey.includes(compact));
		})) return false;
		return true;
	}));
}

function modelKeywordLabel(field) {
	const anyKeywords = Array.from(field?.anyKeywords || []).map((keyword) => String(keyword || "").trim()).filter(Boolean);
	const allKeywords = Array.from(field?.keywords || [])
		.map((keyword) => String(keyword || "").replaceAll("|", " 或 "))
		.filter(Boolean);
	if (anyKeywords.length) allKeywords.unshift(anyKeywords.join(" 或 "));
	return allKeywords.join(" + ");
}

function modelTooltip(field, filteredCount, totalCount) {
	const roots = Array.isArray(field?.roots) && field.roots.length ? field.roots.join("\n") : field?.path || "";
	const keywords = modelKeywordLabel(field);
	return [
		`目录：${field?.path || field?.folder || ""}`,
		roots ? `实际路径：\n${roots}` : "",
		keywords ? `关键词：${keywords}` : "",
		`候选：${filteredCount}/${totalCount}`,
		field?.description ? `说明：${field.description}` : "",
	].filter(Boolean).join("\n");
}

function mergeExtraModelFields(fields) {
	const result = Array.from(fields || []);
	const byName = new Set(result.map((field) => String(field?.name || "")));
	const byFolder = new Map();
	for (const field of result) {
		const folder = String(field?.folder || "");
		if (!folder || byFolder.has(folder)) continue;
		byFolder.set(folder, field);
	}
	for (const extra of EXTRA_MODEL_FIELDS) {
		if (byName.has(extra.name)) continue;
		const source = byFolder.get(extra.folder) || {};
		result.push({
			...extra,
			models: Array.isArray(source.models) ? source.models : [],
			roots: Array.isArray(source.roots) ? source.roots : [],
		});
	}
	return result;
}

function modelTreeEntriesFromFields(fields) {
	return (fields || [])
		.map((field) => {
			const name = String(field?.name || "");
			if (!name) return null;
			const localExtra = EXTRA_MODEL_FIELDS.find((item) => item.name === name);
			const merged = localExtra ? { ...field, ...localExtra } : field;
			return {
				widget: name,
				label: merged.label || name,
				folder: merged.path || merged.folder || "",
				icon: MODEL_FIELD_ICONS[String(merged.folder || "").replace(/^models[\\/]/, "")] || "🟣",
				models: Array.isArray(merged.models) ? merged.models : [],
				keywords: Array.isArray(merged.keywords) ? merged.keywords : [],
				anyKeywords: Array.isArray(merged.anyKeywords) ? merged.anyKeywords : [],
				fallback: MODEL_FIELD_FALLBACKS[name] || merged.preferred_name || merged.filename || "",
				description: merged.description || "",
				required: Boolean(merged.required),
				noModelLabel: OPTIONAL_LORA_WIDGETS.has(name) ? NO_LORA_LABEL : "",
				noModelValue: OPTIONAL_LORA_WIDGETS.has(name) ? NO_LORA_LABEL : "",
			};
		})
		.filter(Boolean);
}

function modelGroupTitle(title, note = "") {
	const wrap = document.createElement("div");
	wrap.style.cssText = "display:flex;align-items:baseline;gap:8px;margin:2px 0 0;";
	const label = document.createElement("div");
	label.textContent = title;
	label.style.cssText = "color:#eef7f2;font-weight:700;";
	wrap.appendChild(label);
	if (note) {
		const hint = document.createElement("div");
		hint.textContent = note;
		hint.style.cssText = "color:#9fb0b8;font-size:12px;";
		wrap.appendChild(hint);
	}
	return wrap;
}

function modelEntriesForGroup(entries, group) {
	const names = group === "multiview" ? MULTIVIEW_MODEL_WIDGETS : BASE_MODEL_WIDGETS;
	return entries.filter((entry) => names.has(String(entry?.widget || "")));
}

function openModelPopup(node) {
	const wrap = popupBase("模型", 560, node);
	const panel = document.createElement("div");
	panel.style.cssText = "display:flex;flex-direction:column;gap:10px;";
	const keepRow = document.createElement("div");
	keepRow.style.cssText = "display:flex;align-items:center;gap:8px;margin:0 0 2px;";
	const keepButton = booleanButtonField(node, "keep_model_loaded", "保持模型", {
		tooltip: "开启后，超长视频分段之间只清理临时帧，不主动卸载模型/清空显存缓存；速度更快，但显存占用会保持较高。",
	});
	keepButton.addEventListener("gjj-field-change", () => {
		updateDomToolbarState(node);
		app.graph?.setDirtyCanvas?.(true, true);
	});
	const keepHint = document.createElement("div");
	keepHint.textContent = "分段之间不卸载模型";
	keepHint.style.cssText = "color:#9fb0b8;font-size:12px;";
	keepRow.append(keepButton, keepHint);
	panel.appendChild(keepRow);
	const loading = document.createElement("div");
	loading.textContent = "读取模型列表...";
	loading.style.cssText = "color:#9fb0b8;padding:8px 0;";
	panel.appendChild(loading);
	wrap.appendChild(panel);

	fetchJson(MODEL_LIST_API).then((data) => {
		panel.replaceChildren(keepRow);
		const fields = mergeExtraModelFields(Array.isArray(data.fields) ? data.fields : []);
		if (!fields.length) {
			const empty = document.createElement("div");
			empty.textContent = "没有读取到模型配置。";
			empty.style.cssText = "color:#fca5a5;padding:8px 0;";
			panel.appendChild(empty);
			return;
		}
		const entries = modelTreeEntriesFromFields(fields);
		const refresh = () => {
			updateDomToolbarState(node);
			app.graph?.setDirtyCanvas?.(true, true);
		};
		const onApply = (entry, value) => {
			setWidget(node, entry.widget, value);
		};
		const baseEntries = modelEntriesForGroup(entries, "base");
		const multiviewEntries = modelEntriesForGroup(entries, "multiview");
		if (baseEntries.length) {
			panel.appendChild(modelGroupTitle("🧠 SCAIL2 基本模型", "生成长视频会使用这一组"));
			panel.appendChild(GJJ_Utils.createModelTreeView({ node, entries: baseEntries, refresh, onApply }));
		}
		if (multiviewEntries.length) {
			panel.appendChild(modelGroupTitle("可选：多视图 / 多角度模型", "只在导演台里生成多视图参考图时使用"));
			panel.appendChild(GJJ_Utils.createModelTreeView({ node, entries: multiviewEntries, refresh, onApply }));
		}
	}).catch((error) => {
		panel.replaceChildren();
		const fail = document.createElement("div");
		fail.textContent = error?.message || "读取模型列表失败";
		fail.style.cssText = "color:#fca5a5;padding:8px 0;";
		panel.appendChild(fail);
	});
}

function directorPlan(node) {
	const current = readJson(getWidget(node, DIRECTOR_WIDGET, "{}"), {});
	const videos = selectedItems(node, "selected_video_json");
	const refs = selectedItems(node, "selected_reference_json");
	const audios = selectedItems(node, "selected_audio_json");
	const total = Math.max(1, Number(current.total_frames || getWidget(node, "max_frames", 0) || 121));
	const sceneRefUnion = mergeMediaItems(...(Array.isArray(current.scenes) ? current.scenes.map((scene) => scene?.references || []) : []));
	const savedRefs = Array.isArray(current.references) ? normalizeMediaItems(current.references) : sceneRefUnion;
	const savedRefKeys = new Set(savedRefs.map(mediaItemKey));
	const addedMainRefs = refs.filter((ref) => !savedRefKeys.has(mediaItemKey(ref)));
	const hadMainRefDrift = addedMainRefs.length > 0;
	const scenes = Array.isArray(current.scenes)
		? current.scenes
		: [{ start_frame: 1, end_frame: total, prompt: getWidget(node, "positive_prompt", ""), references: refs }];
	const plan = {
		videos,
		audios,
		references: mergeMediaItems(savedRefs, refs),
		fps: Number(current.fps || getWidget(node, "frame_rate", 8) || 8),
		total_frames: total,
		scenes: scenes.map((scene, index) => ({
			index: index + 1,
			start_frame: Math.max(1, Number(scene.start_frame || 1)),
			end_frame: Math.max(1, Number(scene.end_frame || scene.start_frame || total)),
			source_start_frame: Math.max(1, Number(scene.source_start_frame || scene.start_frame || 1)),
			source_end_frame: Math.max(1, Number(scene.source_end_frame || scene.end_frame || scene.start_frame || total)),
			prompt: String(scene.prompt || ""),
			references: mergeMediaItems(Array.isArray(scene.references) ? scene.references : [], addedMainRefs.length ? addedMainRefs : (!Array.isArray(scene.references) ? refs : [])),
			video: scene.video ? normalizeMediaItem(scene.video) : (videos[index] || videos[0] || null),
		})),
	};
	if (hadMainRefDrift) Object.defineProperty(plan, "__references_synced", { value: true });
	return plan;
}

function saveDirectorPlan(node, plan) {
	const saved = JSON.stringify({ ...plan, updated_at: new Date().toISOString() });
	setWidget(node, DIRECTOR_WIDGET, saved);
	node.properties ||= {};
	node.properties[DIRECTOR_WIDGET] = saved;
	app.graph?.setDirtyCanvas?.(true, true);
}

function openDirector(node) {
	const wrap = popupBase("导演台", 980, node);
	wrap.style.height = "720px";
	wrap.tabIndex = -1;
	const plan = directorPlan(node);
	if (plan.__references_synced) saveDirectorPlan(node, plan);
	const video = document.createElement("video");
	video.controls = true;
	video.style.cssText = "width:100%;height:260px;background:#05090b;border:1px solid #30434d;border-radius:6px;object-fit:contain;";
	if (plan.videos[0]) video.src = viewUrl(plan.videos[0]);
	const controls = document.createElement("div");
	controls.style.cssText = "display:flex;gap:8px;align-items:center;margin:8px 0;";
	const auto = smallButton("自动分镜");
	const cut = smallButton("当前位置切割");
	const addVideo = smallButton("导入视频");
	const addAudio = smallButton("导入音频");
	const fitViewBtn = smallButton("适配");
	fitViewBtn.title = "显示完整时间线";
	const zoomOutBtn = smallButton("－");
	zoomOutBtn.title = "缩小时间线视图";
	const zoomInBtn = smallButton("＋");
	zoomInBtn.title = "放大时间线视图";
	const trimLabel = document.createElement("span");
	trimLabel.style.cssText = "margin-left:auto;color:#9fb0b8;font-size:12px;";
	controls.append(auto, cut, addVideo, addAudio, fitViewBtn, zoomOutBtn, zoomInBtn, trimLabel);
	const timeline = document.createElement("div");
	timeline.style.cssText = [
		"position:relative",
		"height:116px",
		"border:1px solid #263841",
		"background:#0b1114",
		"border-radius:6px",
		"overflow:hidden",
		"cursor:crosshair",
		"touch-action:none",
		"user-select:none",
	].join(";");
	const audioTrack = document.createElement("div");
	audioTrack.style.cssText = [
		"position:relative",
		"height:42px",
		"margin-top:6px",
		"border:1px solid #263841",
		"background:#080d10",
		"border-radius:6px",
		"overflow:hidden",
		"cursor:pointer",
		"user-select:none",
	].join(";");
	const refsTitle = document.createElement("div");
	refsTitle.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin:10px 0 6px;color:#aeb9bd;font-size:12px;";
	const refsLabel = document.createElement("span");
	const refsRange = document.createElement("span");
	const refsActions = document.createElement("div");
	refsActions.style.cssText = "display:flex;align-items:center;gap:6px;margin-left:auto;";
	const multiViewBtn = smallButton("生成多视图");
	multiViewBtn.title = "用选中的参考图调用人物库“自定义视图/多视图”能力，生成结果会加入当前片段参考图。";
	const removeBgBtn = smallButton("去除背景");
	removeBgBtn.title = "用选中的参考图调用 RMBG1.4 去除背景，生成透明 PNG 并加入当前片段参考图。";
	const stitchBtn = smallButton("拼接图片");
	stitchBtn.title = "用选中的参考图调用 GJJ_RemoveBgStitch 去背景拼接，生成结果会加入当前片段参考图。";
	const reuseBtn = smallButton("全局复用");
	reuseBtn.title = "把选中的参考图同步到所有视频片段；未多选时会复用当前片段的全部参考图。";
	refsActions.append(multiViewBtn, removeBgBtn, stitchBtn, reuseBtn, refsRange);
	refsTitle.append(refsLabel, refsActions);
	const refs = document.createElement("div");
	refs.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:8px;min-height:86px;border:1px solid #263841;background:#0b1114;border-radius:6px;padding:8px;align-content:start;";
	let selected = 0;
	let playheadFrame = 1;
	let raf = 0;
	let thumbnailJob = 0;
	const thumbnailCache = new Map();
	const audioWaveformCache = new Map();
	const selectedRefIndexes = new Set();
	let lastSelectedRefIndex = -1;
	let selectedAudioIndex = -1;
	let currentPreviewKey = "";
	let referenceLightbox = null;
	let viewStart = Math.max(1, Number(plan.view_start || 1));
	let viewEnd = Math.max(viewStart, Number(plan.view_end || plan.total_frames || 1));
	let refreshReferenceActionButtons = () => {};

	const sceneVideo = (scene) => normalizeMediaItem(scene?.video || plan.videos?.[0] || {});
	const currentAudio = () => normalizeMediaItem((plan.audios || [])[0] || {});
	const lightboxSceneReferences = () => normalizeMediaItems((plan.scenes[selected] || plan.scenes[0])?.references || plan.references || []);
	const closeReferenceLightbox = () => {
		referenceLightbox?.overlay?.remove();
		referenceLightbox = null;
	};
	const showReferenceLightboxImage = (index) => {
		if (!referenceLightbox) return;
		const items = lightboxSceneReferences();
		if (!items.length) {
			closeReferenceLightbox();
			return;
		}
		const safeIndex = ((Math.round(index) % items.length) + items.length) % items.length;
		referenceLightbox.index = safeIndex;
		referenceLightbox.scale = 1;
		const item = items[safeIndex];
		referenceLightbox.img.src = viewUrl(item);
		referenceLightbox.img.title = mediaLabel(item);
		referenceLightbox.caption.textContent = `${safeIndex + 1} / ${items.length}  ${mediaLabel(item)}`;
		referenceLightbox.img.style.transform = "scale(1)";
	};
	const openReferenceLightbox = (index) => {
		const items = lightboxSceneReferences();
		if (!items.length) return;
		if (!referenceLightbox) {
			const overlay = document.createElement("div");
			overlay.style.cssText = [
				"position:fixed",
				"inset:0",
				"z-index:10020",
				"background:rgba(0,0,0,.78)",
				"display:flex",
				"align-items:center",
				"justify-content:center",
				"cursor:pointer",
				"pointer-events:auto",
			].join(";");
			const stage = document.createElement("div");
			stage.style.cssText = "position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;";
			const img = document.createElement("img");
			img.draggable = false;
			img.style.cssText = [
				"max-width:94vw",
				"max-height:92vh",
				"object-fit:contain",
				"border:1px solid rgba(190,220,235,.38)",
				"border-radius:8px",
				"background:#05090b",
				"box-shadow:0 18px 60px rgba(0,0,0,.55)",
				"transform-origin:center center",
				"transition:transform .08s ease-out",
				"cursor:zoom-out",
			].join(";");
			const caption = document.createElement("div");
			caption.style.cssText = "position:absolute;left:18px;right:18px;bottom:14px;color:#dce8ed;font-size:12px;text-align:center;text-shadow:0 1px 3px #000;pointer-events:none;";
			stage.append(img, caption);
			overlay.appendChild(stage);
			referenceLightbox = { overlay, img, caption, index: 0, scale: 1 };
			overlay.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (event.target === img) closeReferenceLightbox();
				else showReferenceLightboxImage(referenceLightbox.index + 1);
			}, true);
			overlay.addEventListener("wheel", (event) => {
				event.preventDefault();
				event.stopPropagation();
				const factor = event.deltaY < 0 ? 1.12 : 0.88;
				referenceLightbox.scale = clamp(referenceLightbox.scale * factor, 0.2, 8);
				img.style.transform = `scale(${referenceLightbox.scale})`;
			}, { passive: false, capture: true });
			document.body.appendChild(overlay);
		}
		showReferenceLightboxImage(index);
	};
	const audioLabel = (item = currentAudio()) => {
		if (item?.filename) return item.source_kind === "video_audio" ? "原视频音频：自动分离并保留" : mediaLabel(item);
		return plan.videos?.length ? "原视频音频：自动分离并保留" : "音频：未选择";
	};
	const totalFrames = () => Math.max(1, Number(plan.total_frames || 1));
	const sceneMaxFrame = () => Math.max(1, ...Array.from(plan.scenes || []).map((scene) => Number(scene.end_frame || 1)));
	const normalizeView = () => {
		const total = totalFrames();
		viewStart = clamp(Math.round(viewStart || 1), 1, total);
		viewEnd = clamp(Math.round(viewEnd || total), viewStart, total);
		plan.view_start = viewStart;
		plan.view_end = viewEnd;
	};
	const visibleFrames = () => {
		normalizeView();
		return Math.max(1, viewEnd - viewStart + 1);
	};
	const fitView = () => {
		viewStart = 1;
		viewEnd = totalFrames();
		normalizeView();
	};
	const zoomView = (factor, centerFrame = playheadFrame) => {
		const total = totalFrames();
		const span = visibleFrames();
		const nextSpan = clamp(Math.round(span * factor), 8, total);
		const center = clamp(Math.round(centerFrame || 1), 1, total);
		viewStart = clamp(center - Math.floor(nextSpan / 2), 1, Math.max(1, total - nextSpan + 1));
		viewEnd = Math.min(total, viewStart + nextSpan - 1);
		normalizeView();
	};
	const frameToPercent = (frame) => ((Number(frame || 1) - viewStart) / Math.max(1, visibleFrames() - 1)) * 100;
	const clipRangeToView = (start, end) => {
		normalizeView();
		const clippedStart = Math.max(Number(start || 1), viewStart);
		const clippedEnd = Math.min(Number(end || clippedStart), viewEnd);
		if (clippedEnd < clippedStart) return null;
		const width = Math.max(0.6, ((clippedEnd - clippedStart + 1) / Math.max(1, visibleFrames())) * 100);
		return {
			start: clippedStart,
			end: clippedEnd,
			left: ((clippedStart - viewStart) / Math.max(1, visibleFrames())) * 100,
			width,
		};
	};
	const mediaWaveformKey = (item) => mediaItemKey(item || {});
	const audioDisplayItems = () => {
		const audios = Array.from(plan.audios || []).filter((item) => normalizeMediaItem(item).filename);
		if (audios.length) return audios;
		const firstVideo = normalizeMediaItem(plan.videos?.[0] || {});
		return firstVideo.filename ? [{ ...firstVideo, media_type: "audio", source_kind: "video_audio", label: "原视频音频" }] : [];
	};
	const syncAudioWidgetFromPlan = () => {
		plan.audios = normalizeMediaItems(plan.audios || []);
		plan.audios.sort((a, b) => Number(a.start_frame || 1) - Number(b.start_frame || 1));
		setSelectedItems(node, "selected_audio_json", plan.audios);
	};
	const ensureEditableAudioTrack = () => {
		if ((plan.audios || []).length) return true;
		const firstVideo = normalizeMediaItem(plan.videos?.[0] || {});
		if (!firstVideo.filename) return false;
		const total = totalFrames();
		plan.audios = [{
			...firstVideo,
			media_type: "audio",
			source_kind: "video_audio",
			label: "原视频音频",
			start_frame: 1,
			end_frame: total,
			source_start_frame: 1,
			source_end_frame: total,
			source_total_frames: total,
		}];
		plan.audio_override = true;
		syncAudioWidgetFromPlan();
		saveDirectorPlan(node, plan);
		return true;
	};
	const audioFrameFromEvent = (event) => {
		const rect = audioTrack.getBoundingClientRect();
		const x = clamp(Number(event.clientX || 0) - rect.left, 0, Math.max(1, rect.width));
		return Math.round(viewStart + (x / Math.max(1, rect.width)) * (visibleFrames() - 1));
	};
	const audioDurationFrames = async (item) => {
		try {
			const normalized = normalizeMediaItem(item);
			const response = await fetch(viewUrl(normalized));
			if (!response.ok) throw new Error("音频读取失败");
			const buffer = await response.arrayBuffer();
			const AudioCtor = window.AudioContext || window.webkitAudioContext;
			if (!AudioCtor) throw new Error("浏览器不支持音频解析");
			const context = new AudioCtor();
			try {
				const decoded = await context.decodeAudioData(buffer.slice(0));
				return Math.max(1, Math.round(Number(decoded.duration || 0) * Number(plan.fps || 1)));
			} finally {
				context.close?.();
			}
		} catch (_) {
			return Math.max(1, totalFrames());
		}
	};
	const drawWaveformFallback = (canvas, text = "") => {
		const ctx = canvas.getContext("2d");
		const width = Math.max(1, canvas.width);
		const height = Math.max(1, canvas.height);
		ctx.clearRect(0, 0, width, height);
		ctx.strokeStyle = "rgba(167,243,208,.65)";
		ctx.setLineDash([6, 6]);
		ctx.beginPath();
		ctx.moveTo(0, height / 2);
		ctx.lineTo(width, height / 2);
		ctx.stroke();
		ctx.setLineDash([]);
		if (text) {
			ctx.fillStyle = "rgba(215,251,232,.78)";
			ctx.font = "12px system-ui,sans-serif";
			ctx.fillText(text, 8, Math.max(12, height / 2 - 4));
		}
	};
	const drawWaveformPeaks = (canvas, peaks) => {
		const ctx = canvas.getContext("2d");
		const width = Math.max(1, canvas.width);
		const height = Math.max(1, canvas.height);
		ctx.clearRect(0, 0, width, height);
		ctx.strokeStyle = "rgba(167,243,208,.9)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		const mid = height / 2;
		for (let x = 0; x < width; x += 1) {
			const amp = Math.max(0.02, Number(peaks[Math.floor((x / width) * peaks.length)] || 0));
			const y = amp * (height * 0.46);
			ctx.moveTo(x + 0.5, mid - y);
			ctx.lineTo(x + 0.5, mid + y);
		}
		ctx.stroke();
	};
	const loadWaveformPeaks = async (item) => {
		const normalized = normalizeMediaItem(item);
		const key = mediaWaveformKey(normalized);
		if (audioWaveformCache.has(key)) return audioWaveformCache.get(key);
		const response = await fetch(viewUrl(normalized));
		if (!response.ok) throw new Error("音频读取失败");
		const buffer = await response.arrayBuffer();
		const AudioCtor = window.AudioContext || window.webkitAudioContext;
		if (!AudioCtor) throw new Error("浏览器不支持音频波形解析");
		const context = new AudioCtor();
		try {
			const decoded = await context.decodeAudioData(buffer.slice(0));
			const length = Math.max(1, decoded.length);
			const bins = 512;
			const peaks = new Array(bins).fill(0);
			for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
				const data = decoded.getChannelData(channel);
				for (let bin = 0; bin < bins; bin += 1) {
					const start = Math.floor((bin / bins) * length);
					const end = Math.max(start + 1, Math.floor(((bin + 1) / bins) * length));
					let peak = 0;
					for (let index = start; index < end; index += 32) peak = Math.max(peak, Math.abs(data[index] || 0));
					peaks[bin] = Math.max(peaks[bin], peak);
				}
			}
			audioWaveformCache.set(key, peaks);
			return peaks;
		} finally {
			context.close?.();
		}
	};
	const scheduleWaveform = (canvas, item) => {
		drawWaveformFallback(canvas, "读取波形...");
		loadWaveformPeaks(item).then((peaks) => {
			if (!canvas.isConnected || !wrap.isConnected) return;
			drawWaveformPeaks(canvas, peaks);
		}).catch(() => {
			if (!canvas.isConnected || !wrap.isConnected) return;
			drawWaveformFallback(canvas);
		});
	};
	const findSceneAtFrame = (frame) => plan.scenes.findIndex((scene) => {
		const start = Number(scene.start_frame || 1);
		const end = Number(scene.end_frame || start);
		return frame >= start && frame <= end;
	});
	const setPreviewVideoForScene = (scene) => {
		const item = sceneVideo(scene);
		const key = mediaItemKey(item);
		const source = viewUrl(item);
		if (!source || key === currentPreviewKey) return;
		currentPreviewKey = key;
		video.removeAttribute("src");
		video.src = source;
		video.load?.();
	};
	const syncVideoWidgetFromScenes = () => {
		const merged = [];
		const seen = new Set();
		for (const item of normalizeMediaItems(plan.videos || [])) {
			const key = mediaItemKey(item);
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(item);
		}
		for (const scene of plan.scenes || []) {
			const item = sceneVideo(scene);
			if (!item.filename) continue;
			const key = mediaItemKey(item);
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(item);
		}
		plan.videos = merged;
		setSelectedItems(node, "selected_video_json", merged);
	};
	const videoFramesFromUrl = (source) => new Promise((resolve) => {
		if (!source) {
			resolve(0);
			return;
		}
		const probe = document.createElement("video");
		const done = () => {
			const frames = Math.max(0, Math.round(Number(probe.duration || 0) * Number(plan.fps || 1)));
			probe.removeAttribute("src");
			probe.load?.();
			resolve(frames);
		};
		probe.preload = "metadata";
		probe.addEventListener("loadedmetadata", done, { once: true });
		probe.addEventListener("error", () => resolve(0), { once: true });
		probe.src = source;
		probe.load?.();
	});
	const refreshVideoMetaFromServer = async () => {
		const videos = normalizeMediaItems(plan.videos || []);
		if (!videos.length) return;
		const metas = await Promise.all(videos.map((item) => fetchVideoMeta(item).catch(() => null)));
		let changed = false;
		let cursor = 1;
		const singleScene = plan.scenes.length === 1 && videos.length === 1;
		if (singleScene && mediaItemKey(sceneVideo(plan.scenes[0])) === mediaItemKey(videos[0])) {
			const meta = metas[0] || {};
			const frames = Math.max(0, Math.round(Number(meta.frames || meta.frame_count || 0)));
			const fps = Number(meta.fps || meta.frame_rate || 0);
			if (frames > 0 && frames !== Number(plan.scenes[0].end_frame || 0)) {
				plan.scenes[0].start_frame = 1;
				plan.scenes[0].end_frame = frames;
				plan.scenes[0].source_start_frame = 1;
				plan.scenes[0].source_end_frame = frames;
				plan.total_frames = frames;
				changed = true;
			}
			if (fps > 0 && Math.abs(Number(plan.fps || 0) - fps) > 0.001) {
				plan.fps = fps;
				changed = true;
			}
		} else if (plan.scenes.length === videos.length) {
			for (const [index, scene] of plan.scenes.entries()) {
				if (mediaItemKey(sceneVideo(scene)) !== mediaItemKey(videos[index])) return;
				const meta = metas[index] || {};
				const frames = Math.max(0, Math.round(Number(meta.frames || meta.frame_count || 0)));
				if (frames <= 0) return;
			}
			for (const [index, scene] of plan.scenes.entries()) {
				const meta = metas[index] || {};
				const frames = Math.max(1, Math.round(Number(meta.frames || meta.frame_count || 1)));
				scene.start_frame = cursor;
				scene.end_frame = cursor + frames - 1;
				scene.source_start_frame = 1;
				scene.source_end_frame = frames;
				scene.video = videos[index];
				cursor += frames;
			}
			const fps = Number((metas[0] || {}).fps || (metas[0] || {}).frame_rate || 0);
			if (fps > 0) plan.fps = fps;
			plan.total_frames = Math.max(1, cursor - 1);
			changed = true;
		}
		const maxFrame = sceneMaxFrame();
		if (maxFrame > Number(plan.total_frames || 0)) {
			plan.total_frames = maxFrame;
			changed = true;
		}
		if (!changed) return;
		fitView();
		saveDirectorPlan(node, plan);
		render();
		seekFrame(Math.min(playheadFrame, totalFrames()));
	};
	const setBusy = (button, label = "⌛执行中...") => {
		const oldText = button.textContent;
		button.dataset.gjjBusy = "1";
		button.textContent = label;
		button.disabled = true;
		return () => {
			delete button.dataset.gjjBusy;
			button.textContent = oldText;
			refreshReferenceActionButtons();
		};
	};
	const deleteSelectedScene = () => {
		if (!plan.scenes.length) return;
		plan.scenes.splice(selected, 1);
		selected = clamp(selected, 0, Math.max(0, plan.scenes.length - 1));
		if (plan.scenes.length) relayoutScenesSequentially();
		const scene = plan.scenes[selected] || plan.scenes[0];
		playheadFrame = scene ? Number(scene.start_frame || 1) : 1;
		syncVideoWidgetFromScenes();
		render();
		if (scene) seekFrame(playheadFrame);
	};
	const mergeAdjacentScenes = (index) => {
		if (index < 0 || index >= plan.scenes.length - 1) return false;
		const left = plan.scenes[index];
		const right = plan.scenes[index + 1];
		if (mediaItemKey(sceneVideo(left)) !== mediaItemKey(sceneVideo(right))) return false;
		if (Number(left.end_frame || 1) + 1 !== Number(right.start_frame || 1)) return false;
		const refsMerged = [];
		const seenRefs = new Set();
		for (const ref of normalizeMediaItems([...(left.references || []), ...(right.references || [])])) {
			const key = mediaItemKey(ref);
			if (seenRefs.has(key)) continue;
			seenRefs.add(key);
			refsMerged.push(ref);
		}
		left.end_frame = right.end_frame;
		left.source_end_frame = right.source_end_frame || left.source_end_frame || right.end_frame;
		left.prompt = [left.prompt, right.prompt].map((item) => String(item || "").trim()).filter(Boolean).join("\n");
		left.references = refsMerged;
		plan.scenes.splice(index + 1, 1);
		selected = index;
		playheadFrame = Number(left.start_frame || 1);
		syncReferenceWidgetFromScenes();
		render();
		seekFrame(playheadFrame);
		return true;
	};
	const seamIndexFromEvent = (event) => {
		const rect = timeline.getBoundingClientRect();
		const toleranceFrames = Math.max(1, Math.ceil((visibleFrames() / Math.max(1, rect.width)) * 8));
		const frame = frameFromEvent(event);
		return seamIndexNearFrame(frame, toleranceFrames);
	};
	const seamIndexNearFrame = (frame, toleranceFrames = 1) => {
		for (let index = 0; index < plan.scenes.length - 1; index += 1) {
			const left = plan.scenes[index];
			const right = plan.scenes[index + 1];
			if (mediaItemKey(sceneVideo(left)) !== mediaItemKey(sceneVideo(right))) continue;
			if (Number(left.end_frame || 1) + 1 !== Number(right.start_frame || 1)) continue;
			if (Math.abs(frame - Number(right.start_frame || 1)) <= toleranceFrames) return index;
		}
		return -1;
	};
	const audioSeamIndexNearFrame = (frame, toleranceFrames = 1) => {
		const audios = plan.audios || [];
		for (let index = 0; index < audios.length - 1; index += 1) {
			const left = audios[index];
			const right = audios[index + 1];
			if (mediaItemKey(left) !== mediaItemKey(right)) continue;
			if (Number(left.end_frame || 1) + 1 !== Number(right.start_frame || 1)) continue;
			if (Number(left.source_end_frame || 1) + 1 !== Number(right.source_start_frame || 1)) continue;
			if (Math.abs(frame - Number(right.start_frame || 1)) <= toleranceFrames) return index;
		}
		return -1;
	};
	const snapFrameToMergeSeam = (frame) => {
		const rect = timeline.getBoundingClientRect();
		const toleranceFrames = Math.max(1, Math.ceil((visibleFrames() / Math.max(1, rect.width || 1)) * 8));
		const seamIndex = seamIndexNearFrame(Math.round(frame || 1), toleranceFrames);
		return seamIndex >= 0 ? Number(plan.scenes[seamIndex + 1]?.start_frame || frame || 1) : Math.round(frame || 1);
	};
	const snapFrameToAudioSeam = (frame) => {
		const rect = audioTrack.getBoundingClientRect();
		const toleranceFrames = Math.max(1, Math.ceil((visibleFrames() / Math.max(1, rect.width || 1)) * 8));
		const seamIndex = audioSeamIndexNearFrame(Math.round(frame || 1), toleranceFrames);
		return seamIndex >= 0 ? Number(plan.audios?.[seamIndex + 1]?.start_frame || frame || 1) : Math.round(frame || 1);
	};
	const mergeAdjacentAudio = (index) => {
		const audios = plan.audios || [];
		if (index < 0 || index >= audios.length - 1) return false;
		const left = audios[index];
		const right = audios[index + 1];
		if (mediaItemKey(left) !== mediaItemKey(right)) return false;
		if (Number(left.end_frame || 1) + 1 !== Number(right.start_frame || 1)) return false;
		if (Number(left.source_end_frame || 1) + 1 !== Number(right.source_start_frame || 1)) return false;
		left.end_frame = right.end_frame;
		left.source_end_frame = right.source_end_frame || left.source_end_frame;
		left.source_total_frames = Math.max(Number(left.source_total_frames || 0), Number(right.source_total_frames || 0));
		audios.splice(index + 1, 1);
		selectedAudioIndex = index;
		playheadFrame = Number(left.start_frame || 1);
		plan.audio_override = audios.length > 0;
		syncAudioWidgetFromPlan();
		saveDirectorPlan(node, plan);
		render();
		return true;
	};

	const cutAtFrame = (frame) => {
		const current = clamp(Math.round(frame || playheadFrame || 1), 2, totalFrames());
		const index = plan.scenes.findIndex((scene) => current > scene.start_frame && current <= scene.end_frame);
		if (index < 0) return;
		const scene = plan.scenes[index];
		plan.scenes.splice(index, 1,
			{
				...scene,
				end_frame: current - 1,
				source_end_frame: Number(scene.source_start_frame || scene.start_frame || 1) + (current - Number(scene.start_frame || 1)) - 1,
			},
			{
				...scene,
				start_frame: current,
				source_start_frame: Number(scene.source_start_frame || scene.start_frame || 1) + (current - Number(scene.start_frame || 1)),
				index: index + 2,
			},
		);
		selected = index + 1;
		playheadFrame = current;
		render();
	};
	const cutAudioAtFrame = (frame) => {
		const current = clamp(Math.round(frame || playheadFrame || 1), 2, totalFrames());
		const seamIndex = audioSeamIndexNearFrame(current, 0);
		if (seamIndex >= 0) return mergeAdjacentAudio(seamIndex);
		if (!(plan.audios || []).length) ensureEditableAudioTrack();
		const index = (plan.audios || []).findIndex((item) => current > Number(item.start_frame || 1) && current <= Number(item.end_frame || item.start_frame || 1));
		if (index < 0) return false;
		const item = plan.audios[index];
		const start = Number(item.start_frame || 1);
		const end = Number(item.end_frame || start);
		const sourceStart = Number(item.source_start_frame || 1);
		plan.audios.splice(index, 1,
			{
				...item,
				end_frame: current - 1,
				source_end_frame: sourceStart + (current - start) - 1,
			},
			{
				...item,
				start_frame: current,
				source_start_frame: sourceStart + (current - start),
				source_end_frame: Number(item.source_end_frame || sourceStart + (end - start)),
			},
		);
		selectedAudioIndex = index + 1;
		plan.audio_override = true;
		syncAudioWidgetFromPlan();
		saveDirectorPlan(node, plan);
		render();
		return true;
	};
	const deleteSelectedAudio = () => {
		if (selectedAudioIndex < 0 || selectedAudioIndex >= (plan.audios || []).length) return false;
		plan.audios.splice(selectedAudioIndex, 1);
		selectedAudioIndex = Math.min(selectedAudioIndex, (plan.audios || []).length - 1);
		plan.audio_override = (plan.audios || []).length > 0;
		syncAudioWidgetFromPlan();
		saveDirectorPlan(node, plan);
		render();
		return true;
	};
	const audioNeighborBounds = (audioIndex) => {
		const item = plan.audios?.[audioIndex];
		const start = Number(item?.start_frame || 1);
		const ordered = (plan.audios || [])
			.map((entry, index) => ({ entry, index }))
			.filter(({ index }) => index !== audioIndex)
			.sort((a, b) => Number(a.entry.start_frame || 1) - Number(b.entry.start_frame || 1));
		let minStart = 1;
		let maxEnd = totalFrames();
		for (const { entry } of ordered) {
			const otherStart = Number(entry.start_frame || 1);
			const otherEnd = Number(entry.end_frame || otherStart);
			if (otherEnd < start) minStart = Math.max(minStart, otherEnd + 1);
			if (otherStart > start) maxEnd = Math.min(maxEnd, otherStart - 1);
		}
		return { minStart, maxEnd };
	};
	const sortScenes = () => {
		plan.scenes.sort((a, b) => Number(a.start_frame || 1) - Number(b.start_frame || 1));
		for (const [index, scene] of plan.scenes.entries()) scene.index = index + 1;
		selected = Math.max(0, Math.min(selected, plan.scenes.length - 1));
	};
	const relayoutScenesSequentially = () => {
		let cursor = 1;
		for (const [index, scene] of plan.scenes.entries()) {
			const length = Math.max(1, Number(scene.end_frame || scene.start_frame || cursor) - Number(scene.start_frame || cursor) + 1);
			scene.index = index + 1;
			scene.start_frame = cursor;
			scene.end_frame = cursor + length - 1;
			scene.frames = length;
			cursor += length;
		}
		plan.total_frames = Math.max(1, cursor - 1);
	};
	const frameFromEvent = (event) => {
		const rect = timeline.getBoundingClientRect();
		const x = clamp(Number(event.clientX || 0) - rect.left, 0, Math.max(1, rect.width));
		return Math.round(viewStart + (x / Math.max(1, rect.width)) * (visibleFrames() - 1));
	};
	const seekFrame = (frame) => {
		const previousSelected = selected;
		playheadFrame = clamp(snapFrameToMergeSeam(frame || 1), 1, totalFrames());
		const sceneIndex = findSceneAtFrame(playheadFrame);
		if (sceneIndex >= 0) selected = sceneIndex;
		const scene = plan.scenes[selected] || plan.scenes[0];
		if (scene) {
			setPreviewVideoForScene(scene);
			if (Number(plan.fps || 0) > 0) {
				const relativeFrame = clamp(playheadFrame - Number(scene.start_frame || 1) + 1, 1, Math.max(1, Number(scene.end_frame || scene.start_frame || 1) - Number(scene.start_frame || 1) + 1));
				video.currentTime = Math.max(0, (relativeFrame - 1) / Number(plan.fps || 1));
			}
		}
		updatePlayhead();
		if (selected !== previousSelected) render();
	};
	const seekAudioFrame = (frame) => {
		const previousSelected = selected;
		playheadFrame = clamp(snapFrameToAudioSeam(frame || 1), 1, totalFrames());
		const sceneIndex = findSceneAtFrame(playheadFrame);
		if (sceneIndex >= 0) selected = sceneIndex;
		updatePlayhead();
		if (selected !== previousSelected) render();
	};
	const selectScene = (index, syncVideo = true) => {
		selectedAudioIndex = -1;
		selected = clamp(index, 0, Math.max(0, plan.scenes.length - 1));
		const scene = plan.scenes[selected];
		if (scene) setPreviewVideoForScene(scene);
		if (scene && syncVideo) seekFrame(scene.start_frame);
		render();
	};
	const sceneThumbKey = (scene) => {
		const videoKey = mediaItemKey(sceneVideo(scene));
		return `${videoKey}|${Number(scene?.start_frame || 1)}-${Number(scene?.end_frame || 1)}|${Number(plan.fps || 1)}`;
	};
	const applySegmentThumbnail = (item, key, active) => {
		const url = thumbnailCache.get(key);
		item.style.backgroundColor = active ? "#20384a" : "#121b20";
		item.style.backgroundImage = url
			? `linear-gradient(180deg,rgba(8,15,19,.48),rgba(8,15,19,.08) 46%,rgba(8,15,19,.64)),url("${url}")`
			: "";
		item.style.backgroundSize = url ? "100% 100%, contain" : "";
		item.style.backgroundPosition = "center";
		item.style.backgroundRepeat = "no-repeat";
	};
	const scheduleTimelineThumbnails = () => {
		if (!plan.scenes.length) return;
		const job = ++thumbnailJob;
		setTimeout(async () => {
			if (job !== thumbnailJob || !wrap.isConnected) return;
			for (const scene of plan.scenes.slice()) {
				const source = viewUrl(sceneVideo(scene));
				if (!source) continue;
				const key = sceneThumbKey(scene);
				if (thumbnailCache.has(key)) continue;
				const worker = document.createElement("video");
				worker.muted = true;
				worker.preload = "auto";
				worker.crossOrigin = "anonymous";
				const wait = (eventName) => new Promise((resolve, reject) => {
					const done = () => {
						worker.removeEventListener(eventName, done);
						worker.removeEventListener("error", fail);
						resolve();
					};
					const fail = () => {
						worker.removeEventListener(eventName, done);
						worker.removeEventListener("error", fail);
						reject(new Error("视频缩略图读取失败"));
					};
					worker.addEventListener(eventName, done, { once: true });
					worker.addEventListener("error", fail, { once: true });
				});
				try {
					const loaded = wait("loadedmetadata");
					worker.src = source;
					worker.load?.();
					await loaded;
					if (job !== thumbnailJob || !wrap.isConnected) return;
					const canvas = document.createElement("canvas");
					canvas.width = 192;
					canvas.height = 108;
					const ctx = canvas.getContext("2d");
					const midFrame = (Number(scene.start_frame || 1) + Number(scene.end_frame || scene.start_frame || 1)) / 2;
					const relativeFrame = Math.max(1, midFrame - Number(scene.start_frame || 1) + 1);
					worker.currentTime = Math.max(0, (relativeFrame - 1) / Math.max(0.01, Number(plan.fps || 1)));
					await wait("seeked");
					ctx.fillStyle = "#071014";
					ctx.fillRect(0, 0, canvas.width, canvas.height);
					const scale = Math.min(canvas.width / Math.max(1, worker.videoWidth || canvas.width), canvas.height / Math.max(1, worker.videoHeight || canvas.height));
					const drawWidth = Math.max(1, Math.round((worker.videoWidth || canvas.width) * scale));
					const drawHeight = Math.max(1, Math.round((worker.videoHeight || canvas.height) * scale));
					ctx.drawImage(worker, Math.round((canvas.width - drawWidth) / 2), Math.round((canvas.height - drawHeight) / 2), drawWidth, drawHeight);
					const url = canvas.toDataURL("image/jpeg", 0.72);
					thumbnailCache.set(key, url);
					const item = Array.from(timeline.querySelectorAll("[data-thumb-key]")).find((entry) => entry.dataset.thumbKey === key);
					if (item) applySegmentThumbnail(item, key, Number(item.dataset.index || -1) === selected);
				} catch (error) {
					console.warn("[GJJ SCAIL2 AIO] timeline thumbnail failed", error);
				} finally {
					worker.removeAttribute("src");
					worker.load?.();
				}
			}
		}, 40);
	};
	const updatePlayhead = () => {
		const left = frameToPercent(playheadFrame);
		const visible = playheadFrame >= viewStart && playheadFrame <= viewEnd;
		for (const marker of [timeline.querySelector(".gjj-scail2-playhead"), audioTrack.querySelector(".gjj-scail2-audio-playhead")].filter(Boolean)) {
			marker.style.left = `${left}%`;
			marker.style.display = visible ? "block" : "none";
			marker.title = `${playheadFrame}f`;
		}
		const scissor = timeline.querySelector(".gjj-scail2-playhead button");
		if (scissor) {
			const mergeIndex = seamIndexNearFrame(playheadFrame, 0);
			const merging = mergeIndex >= 0;
			scissor.textContent = merging ? "🈴" : "✂";
			scissor.title = merging ? "合并当前切割缝两侧片段" : "按黄色播放线切割视频";
			scissor.style.borderColor = merging ? "#86efac" : "#c084fc";
			scissor.style.background = merging ? "#14351f" : "#241333";
			scissor.style.color = merging ? "#dcfce7" : "#f5d0fe";
		}
		const audioScissor = audioTrack.querySelector(".gjj-scail2-audio-playhead button");
		if (audioScissor) {
			const audioMergeIndex = audioSeamIndexNearFrame(playheadFrame, 0);
			const audioMerging = audioMergeIndex >= 0;
			const hasEditable = (plan.audios || []).some((item) => playheadFrame > Number(item.start_frame || 1) && playheadFrame <= Number(item.end_frame || item.start_frame || 1));
			const hasFallback = !(plan.audios || []).length && Boolean(normalizeMediaItem(plan.videos?.[0] || {}).filename) && playheadFrame > 1;
			const canCut = hasEditable || hasFallback;
			audioScissor.textContent = audioMerging ? "🈴" : "✂";
			audioScissor.style.opacity = "1";
			audioScissor.title = audioMerging ? "合并当前音频切口" : (canCut ? "按黄色播放线切割音频" : "播放线不在可切割音频范围内");
			audioScissor.style.borderColor = audioMerging ? "#86efac" : "#6ee7b7";
			audioScissor.style.background = audioMerging ? "#14351f" : "#0f2e25";
			audioScissor.style.color = audioMerging ? "#dcfce7" : "#d1fae5";
		}
	};
	const refreshFromVideo = () => {
		if (!wrap.isConnected) return;
		if (!video.paused && Number(plan.fps || 0) > 0) {
			const scene = plan.scenes[selected] || plan.scenes[0];
			const start = Number(scene?.start_frame || 1);
			const end = Number(scene?.end_frame || start);
			const previousSelected = selected;
			playheadFrame = clamp(Math.round((video.currentTime || 0) * Number(plan.fps || 1)) + start, start, end);
			const sceneIndex = findSceneAtFrame(playheadFrame);
			if (sceneIndex >= 0) selected = sceneIndex;
			updatePlayhead();
			if (selected !== previousSelected) render();
		}
		raf = requestAnimationFrame(refreshFromVideo);
	};
	const normalizeScene = (scene, index) => {
		const prevEnd = index > 0 ? Number(plan.scenes[index - 1]?.end_frame || 0) : 0;
		const nextStart = index < plan.scenes.length - 1 ? Number(plan.scenes[index + 1]?.start_frame || totalFrames() + 1) : totalFrames() + 1;
		scene.start_frame = clamp(Math.round(Number(scene.start_frame || 1)), prevEnd + 1, Math.max(prevEnd + 1, nextStart - 1));
		scene.end_frame = clamp(Math.round(Number(scene.end_frame || scene.start_frame)), scene.start_frame, nextStart - 1);
		scene.frames = Math.max(1, scene.end_frame - scene.start_frame + 1);
	};
	const syncReferenceWidgetFromScenes = () => {
		const merged = [];
		const seen = new Set();
		for (const scene of plan.scenes || []) {
			for (const ref of normalizeMediaItems(scene?.references || [])) {
				const key = mediaItemKey(ref);
				if (seen.has(key)) continue;
				seen.add(key);
				merged.push(ref);
			}
		}
		plan.references = merged;
		setSelectedItems(node, "selected_reference_json", merged);
	};
	const currentSceneReferences = () => {
		const scene = plan.scenes[selected] || plan.scenes[0];
		return Array.isArray(scene?.references) ? scene.references : [];
	};
	const selectedReferenceItems = () => {
		const refsList = currentSceneReferences();
		const indexes = Array.from(selectedRefIndexes).filter((index) => index >= 0 && index < refsList.length);
		return indexes.length ? indexes.map((index) => refsList[index]) : refsList.slice(0, 1);
	};
	const selectedOrCurrentReferenceItems = () => {
		const refsList = currentSceneReferences();
		const indexes = Array.from(selectedRefIndexes).filter((index) => index >= 0 && index < refsList.length);
		return indexes.length ? indexes.map((index) => refsList[index]) : refsList.slice();
	};
	const selectedReferenceCount = () => selectedReferenceItems().length;
	const stitchReferenceCount = () => selectedOrCurrentReferenceItems().length;
	const setReferenceActionButtonState = (button, enabled, enabledTitle, disabledTitle) => {
		const busy = button.dataset.gjjBusy === "1";
		button.disabled = busy || !enabled;
		button.title = busy ? "正在执行，请稍候。" : (enabled ? enabledTitle : disabledTitle);
		button.style.opacity = button.disabled ? "0.45" : "1";
		button.style.cursor = button.disabled ? "not-allowed" : "pointer";
	};
	refreshReferenceActionButtons = () => {
		const selectedCount = selectedReferenceCount();
		const stitchCount = stitchReferenceCount();
		setReferenceActionButtonState(
			multiViewBtn,
			selectedCount >= 1,
			"用选中的参考图调用 GJJ_CharacterMultiViewStudio 生成【侧面】【背面】，结果会加入当前片段参考图。",
			"需要当前片段至少有 1 张参考图，才能生成多视图。",
		);
		setReferenceActionButtonState(
			removeBgBtn,
			selectedCount >= 1,
			"用选中的参考图调用 RMBG1.4 去除背景，生成透明 PNG 并加入当前片段参考图。",
			"需要当前片段至少有 1 张参考图，才能去除背景。",
		);
		setReferenceActionButtonState(
			stitchBtn,
			stitchCount >= 2,
			"用选中的参考图调用 GJJ_RemoveBgStitch 去背景拼接，生成结果会加入当前片段参考图。",
			"需要至少 2 张参考图，才能拼接图片。",
		);
	};
	const addMediaItemsToSelectedScene = (items) => {
		const currentScene = plan.scenes[selected] || plan.scenes[0];
		if (!currentScene) return;
		const additions = normalizeMediaItems(items || []);
		if (!additions.length) return;
		const existing = normalizeMediaItems(currentScene.references || []);
		const seen = new Set(existing.map(mediaItemKey));
		for (const item of additions) {
			const key = mediaItemKey(item);
			if (seen.has(key)) continue;
			seen.add(key);
			existing.push(item);
		}
		currentScene.references = existing;
		selectedRefIndexes.clear();
		syncReferenceWidgetFromScenes();
		saveDirectorPlan(node, plan);
		render();
	};
	const imageBlobFromReferences = async (items) => {
		const refsList = normalizeMediaItems(items || []);
		if (!refsList.length) throw new Error("请先选择参考图片。");
		const images = await Promise.all(refsList.map((item) => new Promise((resolve, reject) => {
			const img = new Image();
			img.crossOrigin = "anonymous";
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error(`参考图读取失败：${mediaLabel(item)}`));
			img.src = viewUrl(item);
		})));
		const cell = 512;
		const width = cell * images.length;
		const height = cell;
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = "#20262D";
		ctx.fillRect(0, 0, width, height);
		for (const [index, img] of images.entries()) {
			const scale = Math.min(cell / Math.max(1, img.naturalWidth || img.width), cell / Math.max(1, img.naturalHeight || img.height));
			const drawW = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
			const drawH = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
			ctx.drawImage(img, index * cell + Math.round((cell - drawW) / 2), Math.round((cell - drawH) / 2), drawW, drawH);
		}
		return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("参考图合成失败")), "image/png"));
	};
	const stitchedImageBlobFromReferences = async (items) => {
		const refsList = normalizeMediaItems(items || []);
		if (refsList.length < 2) return null;
		const images = await Promise.all(refsList.map((item) => new Promise((resolve, reject) => {
			const img = new Image();
			img.crossOrigin = "anonymous";
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error(`参考图读取失败：${mediaLabel(item)}`));
			img.src = viewUrl(item);
		})));
		const heights = images.map((img) => Math.max(1, img.naturalHeight || img.height || 1));
		const targetHeight = Math.max(1, Math.min(1280, ...heights));
		const sizes = images.map((img) => {
			const width = Math.max(1, img.naturalWidth || img.width || 1);
			const height = Math.max(1, img.naturalHeight || img.height || 1);
			const scale = targetHeight / height;
			return { width: Math.max(1, Math.round(width * scale)), height: targetHeight };
		});
		const canvas = document.createElement("canvas");
		canvas.width = sizes.reduce((sum, size) => sum + size.width, 0);
		canvas.height = targetHeight;
		const ctx = canvas.getContext("2d");
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		let x = 0;
		for (const [index, img] of images.entries()) {
			const size = sizes[index];
			ctx.drawImage(img, x, 0, size.width, size.height);
			x += size.width;
		}
		return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("参考图拼接失败")), "image/png"));
	};
	const attachSegmentDrag = (item, scene, index, line) => {
		item.addEventListener("pointerdown", (event) => {
			if (event.target?.closest?.(".gjj-scail2-prompt-line, textarea")) return;
			event.preventDefault();
			event.stopPropagation();
			wrap.focus?.({ preventScroll: true });
			item.setPointerCapture?.(event.pointerId);
			const edge = event.target?.dataset?.edge || "";
			const mode = edge || "move";
			const startX = Number(event.clientX || 0);
			const original = { start: Number(scene.start_frame || 1), end: Number(scene.end_frame || 1) };
			const prevEnd = index > 0 ? Number(plan.scenes[index - 1]?.end_frame || 0) : 0;
			const nextStart = index < plan.scenes.length - 1 ? Number(plan.scenes[index + 1]?.start_frame || totalFrames() + 1) : totalFrames() + 1;
			const framesPerPixel = visibleFrames() / Math.max(1, timeline.getBoundingClientRect().width);
			let reorderIndex = index;
			const targetIndexFromDelta = (delta) => {
				const center = (original.start + original.end) / 2 + delta;
				let target = 0;
				for (const [sceneIndex, other] of plan.scenes.entries()) {
					if (sceneIndex === index) continue;
					const otherCenter = (Number(other.start_frame || 1) + Number(other.end_frame || other.start_frame || 1)) / 2;
					if (center > otherCenter) target += 1;
				}
				return clamp(target, 0, plan.scenes.length - 1);
			};
			const updateItemPosition = () => {
				const total = Math.max(1, totalFrames());
				const start = Number(scene.start_frame || 1);
				const end = Number(scene.end_frame || start);
				const clipped = clipRangeToView(start, end);
				if (clipped) {
					item.style.left = `${clipped.left}%`;
					item.style.width = `${clipped.width}%`;
				}
				line.textContent = `${scene.start_frame}-${scene.end_frame}`;
				trimLabel.textContent = `当前片段 ${selected + 1}/${plan.scenes.length} · ${scene.start_frame}-${scene.end_frame}f`;
				refsRange.textContent = `${scene.start_frame}-${scene.end_frame}f`;
				updatePlayhead();
			};
			selected = index;
			setPreviewVideoForScene(scene);
			updatePlayhead();
			const move = (moveEvent) => {
				const delta = Math.round((Number(moveEvent.clientX || 0) - startX) * framesPerPixel);
				if (mode === "left") {
					scene.start_frame = clamp(original.start + delta, prevEnd + 1, original.end);
				} else if (mode === "right") {
					scene.end_frame = clamp(original.end + delta, original.start, nextStart - 1);
				} else {
					const length = Math.max(1, original.end - original.start + 1);
					const minStart = prevEnd + 1;
					const maxStart = Math.max(minStart, nextStart - length);
					if (minStart === maxStart && plan.scenes.length > 1) {
						reorderIndex = targetIndexFromDelta(delta);
						item.style.transform = `translateX(${Number(moveEvent.clientX || 0) - startX}px)`;
						item.style.opacity = reorderIndex === index ? "" : "0.72";
						return;
					} else {
						scene.start_frame = clamp(original.start + delta, minStart, maxStart);
						scene.end_frame = scene.start_frame + length - 1;
					}
				}
				normalizeScene(scene, index);
				playheadFrame = scene.start_frame;
				updateItemPosition();
			};
			const up = (upEvent) => {
				item.releasePointerCapture?.(upEvent.pointerId);
				document.removeEventListener("pointermove", move, true);
				document.removeEventListener("pointerup", up, true);
				item.style.transform = "";
				item.style.opacity = "";
				if (mode === "move" && reorderIndex !== index) {
					const [moved] = plan.scenes.splice(index, 1);
					plan.scenes.splice(reorderIndex, 0, moved);
					selected = reorderIndex;
					relayoutScenesSequentially();
					playheadFrame = Number(moved.start_frame || 1);
					syncReferenceWidgetFromScenes();
					saveDirectorPlan(node, plan);
					render();
					seekFrame(playheadFrame);
					return;
				}
				seekFrame(scene.start_frame);
				saveDirectorPlan(node, plan);
				render();
			};
			document.addEventListener("pointermove", move, true);
			document.addEventListener("pointerup", up, true);
		});
	};
	const attachAudioDrag = (item, audioItem, audioIndex) => {
		item.addEventListener("pointerdown", (event) => {
			if (event.target?.closest?.("button")) return;
			event.preventDefault();
			event.stopPropagation();
			wrap.focus?.({ preventScroll: true });
			item.setPointerCapture?.(event.pointerId);
			selectedAudioIndex = audioIndex;
			const mode = event.target?.dataset?.edge || "move";
			const startX = Number(event.clientX || 0);
			const original = {
				start: Number(audioItem.start_frame || 1),
				end: Number(audioItem.end_frame || audioItem.start_frame || 1),
				sourceStart: Number(audioItem.source_start_frame || 1),
				sourceEnd: Number(audioItem.source_end_frame || audioItem.source_start_frame || 1),
				sourceTotal: Number(audioItem.source_total_frames || audioItem.source_end_frame || audioItem.source_start_frame || 1),
			};
			const framesPerPixel = visibleFrames() / Math.max(1, audioTrack.getBoundingClientRect().width);
			const bounds = audioNeighborBounds(audioIndex);
			const updateAudio = (nextStart, nextEnd, nextSourceStart = original.sourceStart, nextSourceEnd = original.sourceEnd) => {
				audioItem.start_frame = Math.round(nextStart);
				audioItem.end_frame = Math.round(nextEnd);
				audioItem.source_start_frame = Math.round(nextSourceStart);
				audioItem.source_end_frame = Math.round(nextSourceEnd);
				const clipped = clipRangeToView(audioItem.start_frame, audioItem.end_frame);
				if (clipped) {
					item.style.left = `${clipped.left}%`;
					item.style.width = `${clipped.width}%`;
				}
				const line = item.querySelector("[data-audio-range]");
				if (line) line.textContent = `${audioItem.start_frame}-${audioItem.end_frame}f`;
			};
			const move = (moveEvent) => {
				moveEvent.preventDefault();
				moveEvent.stopPropagation();
				const delta = Math.round((Number(moveEvent.clientX || 0) - startX) * framesPerPixel);
				const length = Math.max(1, original.end - original.start + 1);
				if (mode === "left") {
					const nextStart = clamp(original.start + delta, bounds.minStart, original.end);
					const sourceDelta = nextStart - original.start;
					updateAudio(nextStart, original.end, original.sourceStart + sourceDelta, original.sourceEnd);
				} else if (mode === "right") {
					const sourceLimitedEnd = original.start + Math.max(0, original.sourceTotal - original.sourceStart);
					const nextEnd = clamp(original.end + delta, original.start, Math.min(bounds.maxEnd, sourceLimitedEnd));
					updateAudio(original.start, nextEnd, original.sourceStart, original.sourceStart + (nextEnd - original.start));
				} else {
					const nextStart = clamp(original.start + delta, bounds.minStart, Math.max(bounds.minStart, bounds.maxEnd - length + 1));
					updateAudio(nextStart, nextStart + length - 1, original.sourceStart, original.sourceEnd);
				}
			};
			const up = (upEvent) => {
				item.releasePointerCapture?.(upEvent.pointerId);
				document.removeEventListener("pointermove", move, true);
				document.removeEventListener("pointerup", up, true);
				plan.audio_override = (plan.audios || []).length > 0;
				syncAudioWidgetFromPlan();
				saveDirectorPlan(node, plan);
				render();
			};
			document.addEventListener("pointermove", move, true);
			document.addEventListener("pointerup", up, true);
		}, true);
	};
	const openPromptEditor = (scene, index) => {
		const editor = document.createElement("div");
		editor.className = "gjj-scail2-prompt-editor";
		editor.style.cssText = [
			"position:fixed",
			"z-index:1000000",
			"left:50%",
			"top:50%",
			"transform:translate(-50%,-50%)",
			"width:520px",
			"max-width:calc(100vw - 40px)",
			"background:#10181d",
			"border:1px solid #4b6270",
			"border-radius:8px",
			"box-shadow:0 18px 60px rgba(0,0,0,.55)",
			"padding:10px",
			"color:#eef7f2",
			"font:13px system-ui,sans-serif",
		].join(";");
		const head = document.createElement("div");
		head.textContent = `片段 ${index + 1} 提示词`;
		head.style.cssText = "font-weight:700;margin-bottom:8px;";
		const input = document.createElement("textarea");
		input.value = String(scene.prompt || "");
		input.rows = 5;
		input.style.cssText = "width:100%;box-sizing:border-box;border:1px solid #3f525d;border-radius:6px;background:#1b2429;color:#eef7f2;padding:8px;resize:vertical;";
		const buttons = document.createElement("div");
		buttons.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:8px;";
		const cancel = smallButton("取消");
		const save = smallButton("保存");
		const close = () => editor.remove();
		const commit = () => {
			scene.prompt = input.value;
			saveDirectorPlan(node, plan);
			close();
			render();
		};
		cancel.onclick = close;
		save.onclick = commit;
		input.addEventListener("keydown", (event) => {
			if (event.key === "Escape") close();
			if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) commit();
		});
		editor.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
		buttons.append(cancel, save);
		editor.append(head, input, buttons);
		document.body.appendChild(editor);
		input.focus();
		input.select();
	};
	const render = () => {
		sortScenes();
		syncVideoWidgetFromScenes();
		syncAudioWidgetFromPlan();
		if (selectedAudioIndex >= (plan.audios || []).length) selectedAudioIndex = (plan.audios || []).length - 1;
		saveDirectorPlan(node, plan);
		timeline.replaceChildren();
		audioTrack.replaceChildren();
		const total = Math.max(1, Number(plan.total_frames || 1));
		normalizeView();
		const ruler = document.createElement("div");
		ruler.style.cssText = "position:absolute;left:0;right:0;top:0;height:22px;border-bottom:1px solid #21333c;background:#10181d;";
		for (let i = 0; i <= 4; i += 1) {
			const tick = document.createElement("div");
			tick.style.cssText = `position:absolute;left:${i * 25}%;top:0;bottom:0;border-left:1px solid #2c414b;color:#78909a;font-size:10px;padding-left:4px;line-height:20px;`;
			tick.textContent = `${Math.round(viewStart + (visibleFrames() - 1) * i / 4)}f`;
			ruler.appendChild(tick);
		}
		timeline.appendChild(ruler);
		for (const [index, scene] of plan.scenes.entries()) {
			normalizeScene(scene, index);
			const item = document.createElement("div");
			const start = Number(scene.start_frame || 1);
			const end = Number(scene.end_frame || start);
			const clipped = clipRangeToView(start, end);
			if (!clipped) continue;
			const thumbKey = sceneThumbKey(scene);
			item.style.cssText = [
				"position:absolute",
				`left:${clipped.left}%`,
				`width:${clipped.width}%`,
				"top:32px",
				"height:66px",
				"border:1px solid #3c535e",
				"color:#eef7f2",
				"border-radius:6px",
				"text-align:left",
				"padding:6px 14px",
				"overflow:hidden",
				"box-sizing:border-box",
				"cursor:grab",
			].join(";");
			item.className = "gjj-scail2-segment";
			item.dataset.index = String(index);
			item.dataset.thumbKey = thumbKey;
			applySegmentThumbnail(item, thumbKey, index === selected);
			const line = document.createElement("div");
			line.textContent = `${scene.start_frame}-${scene.end_frame}`;
			line.style.cssText = "position:absolute;left:14px;right:14px;bottom:5px;font-size:11px;color:#cbd5da;text-shadow:0 1px 2px #000;";
			const promptLine = document.createElement("div");
			promptLine.textContent = scene.prompt || "正向提示词";
			promptLine.className = "gjj-scail2-prompt-line";
			promptLine.title = "双击编辑提示词";
			promptLine.style.cssText = [
				"position:absolute",
				"left:14px",
				"right:14px",
				"top:5px",
				"height:21px",
				"line-height:21px",
				"padding:0 6px",
				"box-sizing:border-box",
				"border-radius:5px",
				"background:rgba(5,10,14,.62)",
				"font-size:12px",
				"font-weight:700",
				"white-space:nowrap",
				"overflow:hidden",
				"text-overflow:ellipsis",
				"text-shadow:0 1px 2px #000",
				"cursor:text",
			].join(";");
			const leftHandle = document.createElement("div");
			leftHandle.dataset.edge = "left";
			leftHandle.style.cssText = "position:absolute;left:0;top:0;bottom:0;width:10px;background:rgba(125,211,252,.22);cursor:ew-resize;";
			const rightHandle = document.createElement("div");
			rightHandle.dataset.edge = "right";
			rightHandle.style.cssText = "position:absolute;right:0;top:0;bottom:0;width:10px;background:rgba(125,211,252,.22);cursor:ew-resize;";
			item.append(leftHandle, rightHandle, promptLine, line);
			item.onclick = () => {
				wrap.focus?.({ preventScroll: true });
				selectScene(index, true);
			};
			promptLine.ondblclick = (event) => {
				event.preventDefault();
				event.stopPropagation();
				selected = index;
				openPromptEditor(scene, index);
			};
			attachSegmentDrag(item, scene, index, line);
			timeline.appendChild(item);
		}
		const marker = document.createElement("div");
		marker.className = "gjj-scail2-playhead";
		marker.style.cssText = "position:absolute;top:22px;bottom:0;width:2px;background:#facc15;box-shadow:0 0 0 1px rgba(0,0,0,.45);pointer-events:auto;cursor:ew-resize;z-index:8;";
		const scissor = document.createElement("button");
		scissor.type = "button";
		scissor.textContent = "✂";
		scissor.title = "按黄色播放线切割视频";
		scissor.style.cssText = [
			"position:absolute",
			"left:50%",
			"top:-21px",
			"transform:translateX(-50%)",
			"width:24px",
			"height:22px",
			"padding:0",
			"border:1px solid #c084fc",
			"border-radius:6px",
			"background:#241333",
			"color:#f5d0fe",
			"font-size:14px",
			"line-height:18px",
			"cursor:pointer",
			"pointer-events:auto",
		].join(";");
		scissor.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			event.stopPropagation();
		}, true);
		scissor.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			const mergeIndex = seamIndexNearFrame(playheadFrame, 0);
			if (mergeIndex >= 0) mergeAdjacentScenes(mergeIndex);
			else cutAtFrame(playheadFrame);
		});
		marker.appendChild(scissor);
		timeline.appendChild(marker);
		const visibleAudioItems = audioDisplayItems();
		const audioItemsForRender = visibleAudioItems.length ? visibleAudioItems : [];
		for (const [audioIndex, audioItem] of audioItemsForRender.entries()) {
			const start = Math.max(1, Number(audioItem.start_frame || 1));
			const end = Math.max(start, Number(audioItem.end_frame || total));
			const clipped = clipRangeToView(start, end);
			if (!clipped) continue;
			const editableAudio = (plan.audios || []).includes(audioItem);
			const activeAudio = editableAudio && audioIndex === selectedAudioIndex;
			const audioFill = document.createElement("div");
			audioFill.className = editableAudio ? "gjj-scail2-audio-segment" : "gjj-scail2-audio-fallback";
			audioFill.style.cssText = [
				"position:absolute",
				`left:${clipped.left}%`,
				`width:${clipped.width}%`,
				"top:8px",
				"height:26px",
				`border:${activeAudio ? "2px solid #facc15" : "1px solid #365568"}`,
				"border-radius:5px",
				`background:${activeAudio ? "linear-gradient(90deg,rgba(57,82,41,.86),rgba(26,86,72,.86))" : "linear-gradient(90deg,rgba(34,94,122,.72),rgba(42,79,55,.76))"}`,
				"box-sizing:border-box",
				"overflow:hidden",
				`cursor:${editableAudio ? "grab" : "default"}`,
				"box-shadow:" + (activeAudio ? "0 0 0 2px rgba(250,204,21,.16)" : "none"),
			].join(";");
			audioFill.dataset.audioIndex = String(audioIndex);
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(160, Math.round(audioTrack.getBoundingClientRect().width * clipped.width / 100));
			canvas.height = 24;
			canvas.style.cssText = "position:absolute;left:0;right:0;top:1px;width:100%;height:24px;opacity:.9;";
			const audioText = document.createElement("div");
			audioText.textContent = audioLabel(audioItem);
			audioText.style.cssText = "position:absolute;left:8px;right:36px;top:0;height:100%;display:flex;align-items:center;color:#d7fbe8;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px #000;pointer-events:none;";
			const audioRange = document.createElement("div");
			audioRange.dataset.audioRange = "1";
			audioRange.textContent = `${start}-${end}f`;
			audioRange.style.cssText = "position:absolute;right:8px;bottom:1px;color:#ccefe2;font-size:10px;text-shadow:0 1px 2px #000;pointer-events:none;";
			audioFill.append(canvas, audioText, audioRange);
			if (editableAudio) {
				const leftHandle = document.createElement("div");
				leftHandle.dataset.edge = "left";
				leftHandle.style.cssText = "position:absolute;left:0;top:0;bottom:0;width:9px;background:rgba(167,243,208,.2);cursor:ew-resize;";
				const rightHandle = document.createElement("div");
				rightHandle.dataset.edge = "right";
				rightHandle.style.cssText = "position:absolute;right:0;top:0;bottom:0;width:9px;background:rgba(167,243,208,.2);cursor:ew-resize;";
				const removeAudio = document.createElement("button");
				removeAudio.type = "button";
				removeAudio.textContent = "×";
				removeAudio.title = "删除这段音频";
				removeAudio.style.cssText = "position:absolute;right:4px;top:3px;width:18px;height:18px;border:1px solid #8eb6a8;border-radius:5px;background:rgba(5,10,14,.76);color:#eafff8;padding:0;line-height:14px;cursor:pointer;";
				removeAudio.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
				removeAudio.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					selectedAudioIndex = audioIndex;
					deleteSelectedAudio();
				});
				audioFill.append(leftHandle, rightHandle, removeAudio);
				audioFill.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					selectedAudioIndex = audioIndex;
					const sceneIndex = findSceneAtFrame(start);
					if (sceneIndex >= 0) selected = sceneIndex;
					playheadFrame = start;
					updatePlayhead();
					render();
				});
				attachAudioDrag(audioFill, audioItem, audioIndex);
			}
			audioTrack.append(audioFill);
			scheduleWaveform(canvas, audioItem);
		}
		if (!audioItemsForRender.length) {
			const emptyAudio = document.createElement("div");
			emptyAudio.textContent = "音频：未选择";
			emptyAudio.style.cssText = "position:absolute;left:10px;right:10px;top:0;height:100%;display:flex;align-items:center;color:#78909a;font-size:12px;";
			audioTrack.appendChild(emptyAudio);
		}
		const audioMarker = document.createElement("div");
		audioMarker.className = "gjj-scail2-audio-playhead";
		audioMarker.style.cssText = "position:absolute;top:0;bottom:0;width:24px;transform:translateX(-50%);pointer-events:auto;cursor:ew-resize;z-index:8;";
		const audioLine = document.createElement("div");
		audioLine.style.cssText = "position:absolute;left:50%;top:0;bottom:0;width:2px;transform:translateX(-50%);background:#facc15;box-shadow:0 0 0 1px rgba(0,0,0,.45);pointer-events:none;";
		const audioScissor = document.createElement("button");
		audioScissor.type = "button";
		audioScissor.textContent = "✂";
		audioScissor.style.cssText = "position:absolute;left:50%;top:2px;transform:translateX(-50%);width:22px;height:20px;padding:0;border:1px solid #6ee7b7;border-radius:6px;background:#0f2e25;color:#d1fae5;font-size:13px;line-height:16px;cursor:pointer;pointer-events:auto;box-shadow:0 1px 4px rgba(0,0,0,.45);";
		audioScissor.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			event.stopPropagation();
		}, true);
		audioScissor.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			cutAudioAtFrame(playheadFrame);
		});
		audioMarker.append(audioLine, audioScissor);
		audioTrack.appendChild(audioMarker);
		const clearAudio = document.createElement("button");
		clearAudio.type = "button";
		clearAudio.textContent = "×";
		clearAudio.title = "清空外部音频，恢复使用原视频音频";
		clearAudio.style.cssText = "position:absolute;right:8px;top:9px;width:24px;height:24px;padding:0;border:1px solid #49606b;border-radius:5px;background:#10181d;color:#e2edf2;cursor:pointer;z-index:4;";
		clearAudio.style.display = currentAudio().filename ? "block" : "none";
		clearAudio.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			plan.audios = [];
			selectedAudioIndex = -1;
			plan.audio_override = false;
			setSelectedItems(node, "selected_audio_json", []);
			render();
		};
		audioTrack.appendChild(clearAudio);
		updatePlayhead();
		const scene = plan.scenes[selected] || plan.scenes[0];
		trimLabel.textContent = scene ? `当前片段 ${selected + 1}/${plan.scenes.length} · ${scene.start_frame}-${scene.end_frame}f · 视图 ${viewStart}-${viewEnd}f` : "";
		refsLabel.textContent = scene ? `片段 ${selected + 1} 参考图片` : "参考图片";
		refsRange.textContent = scene ? `${scene.start_frame}-${scene.end_frame}f` : "";
		refs.replaceChildren();
		const sceneRefs = scene?.references || plan.references || [];
		for (const index of Array.from(selectedRefIndexes)) {
			if (index < 0 || index >= sceneRefs.length) selectedRefIndexes.delete(index);
		}
		for (const [refIndex, ref] of sceneRefs.entries()) {
			const tile = document.createElement("div");
			tile.draggable = true;
			tile.dataset.index = String(refIndex);
			const activeRef = selectedRefIndexes.has(refIndex);
			tile.style.cssText = `position:relative;width:100%;aspect-ratio:1/1;border-radius:6px;border:${activeRef ? "2px solid #facc15" : "1px solid #30434d"};background:#05090b;overflow:hidden;cursor:pointer;box-shadow:${activeRef ? "0 0 0 2px rgba(250,204,21,.2)" : "none"};`;
			const img = document.createElement("img");
			img.src = viewUrl(ref);
			img.title = mediaLabel(ref);
			img.draggable = false;
			img.style.cssText = "width:100%;height:100%;object-fit:contain;background:#05090b;";
			const remove = document.createElement("button");
			remove.type = "button";
			remove.textContent = "×";
			remove.title = "移除这张参考图";
			remove.style.cssText = "position:absolute;right:4px;top:4px;width:20px;height:20px;border:1px solid #7f9aaa;border-radius:5px;background:rgba(5,10,14,.78);color:#eef7f2;padding:0;line-height:16px;cursor:pointer;";
			remove.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
			remove.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				const currentScene = plan.scenes[selected] || plan.scenes[0];
				const list = Array.isArray(currentScene?.references) ? currentScene.references : [];
				list.splice(refIndex, 1);
				if (currentScene) currentScene.references = list;
				syncReferenceWidgetFromScenes();
				saveDirectorPlan(node, plan);
				render();
			});
			tile.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (event.shiftKey && lastSelectedRefIndex >= 0) {
					const start = Math.min(lastSelectedRefIndex, refIndex);
					const end = Math.max(lastSelectedRefIndex, refIndex);
					for (let index = start; index <= end; index += 1) selectedRefIndexes.add(index);
					lastSelectedRefIndex = refIndex;
					render();
				} else if (event.ctrlKey || event.metaKey || event.shiftKey) {
					if (selectedRefIndexes.has(refIndex)) selectedRefIndexes.delete(refIndex);
					else selectedRefIndexes.add(refIndex);
					lastSelectedRefIndex = refIndex;
					render();
				} else {
					selectedRefIndexes.clear();
					selectedRefIndexes.add(refIndex);
					lastSelectedRefIndex = refIndex;
					render();
					openReferenceLightbox(refIndex);
				}
			});
			tile.addEventListener("dragstart", (event) => {
				event.dataTransfer?.setData("text/plain", String(refIndex));
				event.dataTransfer.effectAllowed = "move";
				tile.style.opacity = "0.55";
			});
			tile.addEventListener("dragend", () => {
				tile.style.opacity = "";
			});
			tile.addEventListener("dragover", (event) => {
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				tile.style.outline = "2px solid #93c5fd";
			});
			tile.addEventListener("dragleave", () => {
				tile.style.outline = "";
			});
			tile.addEventListener("drop", (event) => {
				event.preventDefault();
				tile.style.outline = "";
				const from = Number(event.dataTransfer?.getData("text/plain"));
				const to = refIndex;
				const currentScene = plan.scenes[selected] || plan.scenes[0];
				const list = Array.isArray(currentScene?.references) ? currentScene.references : [];
				if (!Number.isFinite(from) || from === to || from < 0 || from >= list.length) return;
				const [moved] = list.splice(from, 1);
				list.splice(to, 0, moved);
				if (currentScene) currentScene.references = list;
				syncReferenceWidgetFromScenes();
				saveDirectorPlan(node, plan);
				render();
			});
			tile.append(img, remove);
			refs.appendChild(tile);
		}
		const addTile = document.createElement("button");
		addTile.type = "button";
		addTile.textContent = "+";
		addTile.title = "添加参考图片";
		addTile.style.cssText = "width:100%;aspect-ratio:1/1;border:1px dashed #45616e;border-radius:6px;background:#071014;color:#9fb0b8;font-size:28px;cursor:pointer;";
		addTile.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
		addTile.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			openSceneReferencePicker();
		});
		refs.appendChild(addTile);
		if (!sceneRefs.length) {
			const empty = document.createElement("div");
			empty.textContent = "当前片段没有参考图片，双击添加";
			empty.style.cssText = "color:#78909a;font-size:12px;padding:24px 4px;";
			refs.appendChild(empty);
		}
		refreshReferenceActionButtons();
		scheduleTimelineThumbnails();
	};
	const addReferencesToSelectedScene = async (files = [], directItems = []) => {
		const currentScene = plan.scenes[selected] || plan.scenes[0];
		if (!currentScene) return;
		const previewUrls = [];
		for (const file of Array.from(files || []).filter((item) => item instanceof File)) {
			const previewUrl = URL.createObjectURL(file);
			previewUrls.push(previewUrl);
			const img = document.createElement("img");
			img.src = previewUrl;
			img.title = file.name;
			img.style.cssText = "width:72px;height:72px;object-fit:contain;border-radius:6px;border:1px dashed #64748b;background:#05090b;opacity:.72;";
			refs.insertBefore(img, refs.lastElementChild || null);
		}
		try {
			const uploaded = await uploadImageFiles(files);
			const additions = normalizeMediaItems([...(directItems || []), ...uploaded]);
			if (!additions.length) return;
			const existing = normalizeMediaItems(currentScene.references || []);
			const seen = new Set(existing.map(mediaItemKey));
			for (const item of additions) {
				const key = mediaItemKey(item);
				if (seen.has(key)) continue;
				seen.add(key);
				existing.push(item);
			}
			currentScene.references = existing;
			syncReferenceWidgetFromScenes();
			saveDirectorPlan(node, plan);
			render();
		} finally {
			for (const url of previewUrls) URL.revokeObjectURL(url);
		}
	};
	const openSceneReferencePicker = () => {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.accept = "image/*";
		input.style.display = "none";
		input.addEventListener("change", async () => {
			const files = Array.from(input.files || []).filter((file) => file instanceof File);
			try {
				await addReferencesToSelectedScene(files, []);
			} catch (error) {
				alert(error?.message || "导入参考图失败");
			} finally {
				input.remove();
			}
		});
		document.body.appendChild(input);
		input.click();
	};
	const insertVideoSegment = async (frame, file, previewUrl) => {
		const start = clamp(Math.round(frame || totalFrames() + 1), 1, Math.max(1, totalFrames() + 1));
		if (findSceneAtFrame(start) >= 0) return;
		video.removeAttribute("src");
		video.src = previewUrl;
		video.load?.();
		currentPreviewKey = `preview:${previewUrl}`;
		playheadFrame = start;
		thumbnailCache.clear();
		thumbnailJob += 1;
		const framesFromVideo = await videoFramesFromUrl(previewUrl);
		const videos = await uploadVideoFiles([file]);
		if (!videos.length) return;
		const videoItem = normalizeMediaItem(videos[0]);
		const meta = await fetchVideoMeta(videoItem).catch(() => null);
		const metaFrames = Number(meta?.frames || meta?.frame_count || 0);
		const wantedFrames = Math.max(1, Math.round(Number(metaFrames || framesFromVideo || getWidget(node, "max_frames", 0) || 121)));
		const nextScene = plan.scenes
			.filter((scene) => Number(scene.start_frame || 1) > start)
			.sort((a, b) => Number(a.start_frame || 1) - Number(b.start_frame || 1))[0];
		const nextStart = nextScene ? Number(nextScene.start_frame || start + wantedFrames) : 0;
		const end = nextScene ? Math.min(start + wantedFrames - 1, nextStart - 1) : start + wantedFrames - 1;
		if (end < start) return;
		plan.total_frames = Math.max(totalFrames(), end);
		plan.scenes.push({
			index: plan.scenes.length + 1,
			start_frame: start,
			end_frame: end,
			source_start_frame: 1,
			source_end_frame: wantedFrames,
			prompt: getWidget(node, "positive_prompt", ""),
			references: [],
			video: videoItem,
		});
		sortScenes();
		selected = plan.scenes.findIndex((scene) => mediaItemKey(sceneVideo(scene)) === mediaItemKey(videoItem) && Number(scene.start_frame || 1) === start);
		if (selected < 0) selected = findSceneAtFrame(start);
		syncVideoWidgetFromScenes();
		saveDirectorPlan(node, plan);
		render();
		seekFrame(start);
	};
	const openDirectorVideoPicker = () => {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.accept = "video/*";
		input.style.display = "none";
		input.addEventListener("change", async () => {
			const files = Array.from(input.files || []).filter((item) => item instanceof File);
			const previewUrls = [];
			const releaseBusy = setBusy(addVideo);
			try {
				if (!files.length) return;
				for (const file of files) previewUrls.push(URL.createObjectURL(file));
				video.removeAttribute("src");
				video.src = previewUrls[0];
				video.load?.();
				currentPreviewKey = `preview:${previewUrls[0]}`;
				playheadFrame = 1;
				thumbnailCache.clear();
				thumbnailJob += 1;
				const frameCounts = [];
				for (const url of previewUrls) frameCounts.push(await videoFramesFromUrl(url));
				const videos = await uploadVideoFiles(files);
				if (!videos.length) return;
				plan.videos = normalizeMediaItems(videos);
				setSelectedItems(node, "selected_video_json", plan.videos);
				const serverMetas = await Promise.all(plan.videos.map((item) => fetchVideoMeta(item).catch(() => null)));
				const source = viewUrl(plan.videos[0]);
				video.removeAttribute("src");
				video.src = source;
				video.load?.();
				thumbnailCache.clear();
				thumbnailJob += 1;
				playheadFrame = 1;
				let cursor = 1;
				plan.scenes = plan.videos.map((item, index) => {
					const meta = serverMetas[index] || {};
					const metaFrames = Number(meta.frames || meta.frame_count || 0);
					const metaFps = Number(meta.fps || meta.frame_rate || 0);
					if (index === 0 && metaFps > 0) plan.fps = metaFps;
					const frames = Math.max(1, Math.round(Number(metaFrames || frameCounts[index] || getWidget(node, "max_frames", 0) || 121)));
					const scene = {
						index: index + 1,
						start_frame: cursor,
						end_frame: cursor + frames - 1,
						source_start_frame: 1,
						source_end_frame: frames,
						prompt: getWidget(node, "positive_prompt", ""),
						references: index === 0 && Array.isArray(plan.references) ? plan.references : [],
						video: item,
					};
					cursor += frames;
					return scene;
				});
				plan.total_frames = Math.max(1, cursor - 1);
				selected = 0;
				saveDirectorPlan(node, plan);
				render();
				seekFrame(1);
			} catch (error) {
				alert(error?.message || "导入视频失败");
			} finally {
				releaseBusy();
				for (const url of previewUrls) {
					if (video.src !== url) URL.revokeObjectURL(url);
				}
				input.remove();
			}
		});
		document.body.appendChild(input);
		input.click();
	};
	const openDirectorAudioPicker = () => {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.accept = "audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.opus,.webm";
		input.style.display = "none";
		input.addEventListener("change", async () => {
			const files = Array.from(input.files || []);
			if (!files.length) {
				input.remove();
				return;
			}
			try {
				const audios = await uploadAudioFiles(files);
				if (!audios.length) throw new Error("没有导入到可用音频。");
				plan.audio_override = true;
				plan.audios ||= [];
				let cursor = clamp(playheadFrame || 1, 1, totalFrames());
				for (const audio of audios) {
					const occupied = Array.from(plan.audios || []).some((item) => cursor >= Number(item.start_frame || 1) && cursor <= Number(item.end_frame || item.start_frame || 1));
					if (occupied) throw new Error("当前播放线位置已有音频片段，请移动到空白位置后再添加。");
					const nextStart = Math.min(
						totalFrames() + 1,
						...Array.from(plan.audios || [])
							.map((item) => Number(item.start_frame || 1))
							.filter((start) => start > cursor),
					);
					const maxEnd = Math.min(totalFrames(), nextStart - 1);
					if (cursor > maxEnd) throw new Error("当前播放线后面没有可插入音频的空位。");
					const frames = await audioDurationFrames(audio);
					const end = Math.min(maxEnd, cursor + frames - 1);
					plan.audios.push({
						...normalizeMediaItem(audio),
						start_frame: cursor,
						end_frame: end,
						source_start_frame: 1,
						source_end_frame: end - cursor + 1,
						source_total_frames: frames,
					});
					selectedAudioIndex = plan.audios.length - 1;
					cursor = end + 1;
				}
				syncAudioWidgetFromPlan();
				saveDirectorPlan(node, plan);
				render();
			} catch (error) {
				alert(error?.message || "导入音频失败");
			} finally {
				input.remove();
			}
		});
		document.body.appendChild(input);
		input.click();
	};
	const openAddVideoSegmentPicker = (frame) => {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = false;
		input.accept = "video/*";
		input.style.display = "none";
		input.addEventListener("change", async () => {
			const file = Array.from(input.files || []).find((item) => item instanceof File);
			let previewUrl = "";
			const releaseBusy = setBusy(addVideo);
			try {
				if (!file) return;
				previewUrl = URL.createObjectURL(file);
				await insertVideoSegment(frame, file, previewUrl);
			} catch (error) {
				alert(error?.message || "添加视频片段失败");
			} finally {
				releaseBusy();
				if (previewUrl && video.src !== previewUrl) URL.revokeObjectURL(previewUrl);
				input.remove();
			}
		});
		document.body.appendChild(input);
		input.click();
	};
	const multiviewOptions = [
		{ label: "侧面", prompt: "side view, full body", checked: true },
		{ label: "背面", prompt: "back view, full body", checked: true },
		{ label: "正面", prompt: "front view, full body", checked: false },
		{ label: "右前45°", prompt: "front-right quarter view, full body", checked: false },
		{ label: "右后45°", prompt: "back-right quarter view, full body", checked: false },
		{ label: "左后45°", prompt: "back-left quarter view, full body", checked: false },
		{ label: "左前45°", prompt: "front-left quarter view, full body", checked: false },
	];
	const captureCurrentVideoFrameBlob = async () => {
		if (!video.videoWidth || !video.videoHeight) throw new Error("当前视频帧还没有加载完成。");
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, video.videoWidth);
		canvas.height = Math.max(1, video.videoHeight);
		canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
		return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("当前视频帧抓取失败")), "image/png"));
	};
	const openMultiviewDialog = () => new Promise((resolve) => {
		const overlay = document.createElement("div");
		overlay.style.cssText = "position:fixed;inset:0;z-index:1000002;background:rgba(0,0,0,.54);display:flex;align-items:center;justify-content:center;padding:20px;";
		const dialog = document.createElement("div");
		dialog.style.cssText = "width:min(560px,calc(100vw - 40px));border:1px solid #3f525d;border-radius:8px;background:#10191e;color:#e7f1f4;box-shadow:0 18px 60px rgba(0,0,0,.46);padding:14px;";
		const title = document.createElement("div");
		title.textContent = "生成多视图";
		title.style.cssText = "font-size:15px;font-weight:800;margin-bottom:10px;";
		const grid = document.createElement("div");
		grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:8px;margin-bottom:12px;";
		const rows = multiviewOptions.map((option) => {
			const row = document.createElement("label");
			row.style.cssText = "display:flex;align-items:center;gap:7px;border:1px solid #30434d;border-radius:7px;background:#162127;padding:8px;cursor:pointer;font-size:13px;";
			const input = document.createElement("input");
			input.type = "checkbox";
			input.checked = option.checked;
			input.style.margin = "0";
			const text = document.createElement("span");
			text.textContent = option.label;
			row.append(input, text);
			grid.appendChild(row);
			return { ...option, input };
		});
		const actionRow = document.createElement("label");
		actionRow.style.cssText = "display:flex;align-items:center;gap:8px;border:1px solid #30434d;border-radius:7px;background:#0c1418;padding:9px;margin-bottom:12px;font-size:13px;cursor:pointer;";
		const actionInput = document.createElement("input");
		actionInput.type = "checkbox";
		actionInput.style.margin = "0";
		const actionText = document.createElement("span");
		actionText.textContent = "使用当前视频帧动作";
		actionRow.append(actionInput, actionText);
		const buttons = document.createElement("div");
		buttons.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
		const cancel = smallButton("取消");
		const ok = smallButton("生成");
		buttons.append(cancel, ok);
		dialog.append(title, grid, actionRow, buttons);
		overlay.appendChild(dialog);
		const finish = (value) => {
			overlay.remove();
			resolve(value);
		};
		overlay.addEventListener("pointerdown", (event) => {
			if (event.target === overlay) finish(null);
		});
		dialog.addEventListener("pointerdown", (event) => event.stopPropagation());
		cancel.onclick = (event) => {
			event.preventDefault();
			finish(null);
		};
		ok.onclick = (event) => {
			event.preventDefault();
			const selectedViews = rows.filter((row) => row.input.checked);
			if (!selectedViews.length && !actionInput.checked) {
				alert("请至少选择一个视图，或开启“使用当前视频帧动作”。");
				return;
			}
			finish({
				labels: selectedViews.length ? selectedViews.map((row) => row.label) : ["当前视频帧动作"],
				promptLabels: selectedViews.length ? selectedViews.map((row) => row.prompt) : [""],
				useCurrentFrameAction: actionInput.checked,
			});
		};
		document.body.appendChild(overlay);
	});
	const runReferenceMultiview = async () => {
		const items = selectedReferenceItems().slice(0, 1);
		if (!items.length) throw new Error("请先选择参考图片。");
		const options = await openMultiviewDialog();
		if (!options) return;
		const releaseBusy = setBusy(multiViewBtn);
		try {
			const blob = await imageBlobFromReferences(items);
			const actionBlob = options.useCurrentFrameAction ? await captureCurrentVideoFrameBlob() : null;
			const form = new FormData();
			form.append("name", `SCAIL2片段${selected + 1}多视图`);
			form.append("file", blob, "scail2_reference_board.png");
			form.append("labels", JSON.stringify(options.labels));
			form.append("prompt_labels", JSON.stringify(options.promptLabels));
			for (const name of ["multiview_unet", "multiview_clip", "multiview_vae", "multiview_lora_1", "multiview_lora_2", "multiview_lora_3", "rmbg_model"]) {
				const value = String(getWidget(node, name, "") || "").trim();
				if (name === "multiview_unet" && value && !/qwen.*image.*edit.*2511|firered.*image.*edit/i.test(value)) continue;
				if (name === "multiview_clip" && value && !/qwen[_-]?2\.?5.*vl|qwen25vl/i.test(value)) continue;
				if (name === "multiview_vae" && value && !/qwen[_-]?image[_-]?vae/i.test(value)) continue;
				if (value && !isNoLoraValue(value)) form.append(name, value);
			}
			if (actionBlob) {
				for (let index = 0; index < options.labels.length; index += 1) {
					form.append(`action_file_${index + 1}`, actionBlob, `current_video_frame_${index + 1}.png`);
				}
			}
			const data = await fetchJson(CHARACTER_MULTIVIEW_API, { method: "POST", body: form });
			const views = Array.isArray(data?.character?.views) ? data.character.views : [];
			const generatedLabels = new Set((Array.isArray(data?.labels) ? data.labels : options.labels).map((label) => String(label || "").trim()).filter(Boolean));
			const urls = views
				.filter((view) => !generatedLabels.size || generatedLabels.has(String(view?.label || view?.id || "").trim()))
				.map((view) => view?.url)
				.filter(Boolean);
			const additions = await mediaItemsFromUrls(urls);
			if (!additions.length) throw new Error("多视图已执行，但没有拿到可加入参考图的图片。");
			addMediaItemsToSelectedScene(additions);
		} finally {
			releaseBusy();
		}
	};
	const runReferenceRemoveBackground = async () => {
		const items = selectedReferenceItems();
		if (!items.length) throw new Error("请先选择参考图片。");
		const releaseBusy = setBusy(removeBgBtn);
		try {
			const data = await fetchJson(REF_REMOVE_BG_API, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ references: items.map(normalizeMediaItem) }),
			});
			const additions = normalizeMediaItems(data.images || []);
			if (!additions.length) throw new Error("去除背景完成，但没有返回图片。");
			addMediaItemsToSelectedScene(additions);
		} finally {
			releaseBusy();
		}
	};
	const runReferenceStitch = async () => {
		const items = selectedOrCurrentReferenceItems();
		if (items.length < 2) throw new Error("请至少选择或添加 2 张参考图片。");
		const releaseBusy = setBusy(stitchBtn);
		try {
			const blob = await stitchedImageBlobFromReferences(items);
			if (!blob) return;
			const file = new File([blob], `scail2_stitched_${Date.now()}.png`, { type: "image/png" });
			const additions = await uploadImageFiles([file]);
			addMediaItemsToSelectedScene(additions);
		} catch (error) {
			console.warn("[GJJ SCAIL2 AIO] reference stitch skipped", error);
		} finally {
			releaseBusy();
		}
	};
	const reuseReferencesGlobally = () => {
		const items = normalizeMediaItems(selectedOrCurrentReferenceItems());
		if (!items.length) {
			alert("请先选择或添加参考图片。");
			return;
		}
		for (const scene of plan.scenes || []) {
			scene.references = items.map((item) => ({ ...item }));
		}
		plan.references = items.map((item) => ({ ...item }));
		syncReferenceWidgetFromScenes();
		saveDirectorPlan(node, plan);
		render();
	};
	refs.title = "双击打开文件浏览器并添加参考图片";
	refs.addEventListener("dragover", (event) => {
		event.preventDefault();
		refs.style.borderColor = "#93c5fd";
		refs.style.background = "#0d1a20";
	});
	refs.addEventListener("dragleave", (event) => {
		if (refs.contains(event.relatedTarget)) return;
		refs.style.borderColor = "#263841";
		refs.style.background = "#0b1114";
	});
	refs.addEventListener("drop", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		refs.style.borderColor = "#263841";
		refs.style.background = "#0b1114";
		const files = Array.from(event.dataTransfer?.files || []).filter((file) => file instanceof File && String(file.type || "").startsWith("image/"));
		const directItems = [];
		for (const type of ["text/uri-list", "text/plain"]) {
			const text = event.dataTransfer?.getData(type);
			const item = mediaItemFromViewUrl(text);
			if (item) directItems.push(item);
		}
		try {
			await addReferencesToSelectedScene(files, directItems);
		} catch (error) {
			alert(error?.message || "添加参考图失败");
		}
	});
	refs.addEventListener("dblclick", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openSceneReferencePicker();
	});
	timeline.addEventListener("pointerdown", (event) => {
		if (event.target?.closest?.(".gjj-scail2-segment")) return;
		if (event.target?.closest?.("button")) return;
		event.preventDefault();
		const move = (moveEvent) => seekFrame(frameFromEvent(moveEvent));
		const up = () => {
			document.removeEventListener("pointermove", move, true);
			document.removeEventListener("pointerup", up, true);
		};
		seekFrame(frameFromEvent(event));
		document.addEventListener("pointermove", move, true);
		document.addEventListener("pointerup", up, true);
	}, true);
	timeline.addEventListener("wheel", (event) => {
		if (!event.ctrlKey && !event.altKey) return;
		event.preventDefault();
		const center = frameFromEvent(event);
		zoomView(event.deltaY > 0 ? 1.4 : 0.7, center);
		render();
		updatePlayhead();
	}, { passive: false });
	timeline.addEventListener("dblclick", (event) => {
		if (event.target?.closest?.("button")) return;
		if (event.target?.closest?.(".gjj-scail2-prompt-line")) return;
		event.preventDefault();
		event.stopPropagation();
		const seamIndex = seamIndexFromEvent(event);
		if (seamIndex >= 0) {
			mergeAdjacentScenes(seamIndex);
			return;
		}
		if (event.target?.closest?.(".gjj-scail2-segment")) return;
		const frame = frameFromEvent(event);
		if (findSceneAtFrame(frame) >= 0) return;
		openAddVideoSegmentPicker(frame);
	}, true);
	const handleDirectorKeydown = (event) => {
		if (!wrap.isConnected) {
			document.removeEventListener("keydown", handleDirectorKeydown, true);
			return;
		}
		if (referenceLightbox && event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			closeReferenceLightbox();
			return;
		}
		if (!["Delete", "Backspace"].includes(event.key)) return;
		const active = document.activeElement;
		if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;
		event.preventDefault();
		event.stopPropagation();
		if (selectedAudioIndex >= 0) deleteSelectedAudio();
		else deleteSelectedScene();
	};
	document.addEventListener("keydown", handleDirectorKeydown, true);
	cut.onclick = () => {
		const current = Math.max(2, playheadFrame || Math.floor(plan.total_frames / 2));
		const mergeIndex = seamIndexNearFrame(current, 0);
		if (mergeIndex >= 0) mergeAdjacentScenes(mergeIndex);
		else cutAtFrame(current);
	};
	auto.onclick = async () => {
		const releaseBusy = setBusy(auto);
		try {
			if (!plan.videos[0]) throw new Error("请先导入原视频。");
			plan.videos = normalizeMediaItems(plan.videos);
			setSelectedItems(node, "selected_video_json", plan.videos);
			const data = await fetchJson(STORYBOARD_API, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(normalizeMediaItem(plan.videos[0])),
			});
			const scenes = Array.isArray(data.scenes) ? data.scenes : [];
			if (!scenes.length) throw new Error("自动分镜没有返回分段。");
			plan.scenes = scenes.map((scene, index) => ({
				index: index + 1,
				start_frame: Number(scene.start_frame || 1),
				end_frame: Number(scene.end_frame || scene.start_frame || 1),
				prompt: String(scene.prompt || ""),
				references: plan.references,
				video: plan.videos[0],
			}));
			plan.total_frames = Math.max(...plan.scenes.map((scene) => scene.end_frame), plan.total_frames);
			selected = 0;
			render();
		} catch (error) {
			alert(error?.message || "自动分镜失败");
		} finally {
			releaseBusy();
		}
	};
	addVideo.onclick = () => openDirectorVideoPicker();
	addAudio.onclick = () => openDirectorAudioPicker();
	fitViewBtn.onclick = () => {
		fitView();
		render();
		updatePlayhead();
	};
	zoomOutBtn.onclick = () => {
		zoomView(1.5, playheadFrame);
		render();
		updatePlayhead();
	};
	zoomInBtn.onclick = () => {
		zoomView(0.65, playheadFrame);
		render();
		updatePlayhead();
	};
	audioTrack.addEventListener("pointerdown", (event) => {
		if (event.target?.closest?.(".gjj-scail2-audio-segment, button")) return;
		event.preventDefault();
		event.stopPropagation();
		selectedAudioIndex = -1;
		const move = (moveEvent) => {
			seekAudioFrame(audioFrameFromEvent(moveEvent));
		};
		const up = () => {
			document.removeEventListener("pointermove", move, true);
			document.removeEventListener("pointerup", up, true);
		};
		seekAudioFrame(audioFrameFromEvent(event));
		render();
		document.addEventListener("pointermove", move, true);
		document.addEventListener("pointerup", up, true);
	}, true);
	audioTrack.ondblclick = (event) => {
		if (event.target?.closest?.(".gjj-scail2-audio-segment, button")) return;
		event.preventDefault();
		event.stopPropagation();
		seekAudioFrame(audioFrameFromEvent(event));
		openDirectorAudioPicker();
	};
	multiViewBtn.onclick = () => runReferenceMultiview().catch((error) => alert(error?.message || "生成多视图失败"));
	removeBgBtn.onclick = () => runReferenceRemoveBackground().catch((error) => alert(error?.message || "去除背景失败"));
	stitchBtn.onclick = () => runReferenceStitch().catch((error) => console.warn("[GJJ SCAIL2 AIO] reference stitch failed", error));
	reuseBtn.onclick = () => reuseReferencesGlobally();
	wrap.addEventListener("remove", () => {
		cancelAnimationFrame(raf);
		closeReferenceLightbox();
		document.removeEventListener("keydown", handleDirectorKeydown, true);
	});
	wrap.append(video, controls, timeline, audioTrack, refsTitle, refs);
	render();
	refreshVideoMetaFromServer().catch((error) => console.warn("[GJJ SCAIL2 AIO] video meta refresh failed", error));
	refreshFromVideo();
}

function smallButton(label) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.style.cssText = "height:28px;border:1px solid #465761;border-radius:6px;background:#151d22;color:#eef7f2;padding:0 10px;";
	return button;
}

async function openMediaList(node, kind) {
	const isVideo = kind === "video";
	const data = await fetchJson(isVideo ? VIDEO_LIST_API : IMAGE_LIST_API);
	const items = isVideo ? (data.videos || []) : (data.images || []);
	return items;
}

function runOnlyThisNode(node) {
	try {
		sanitizeWidgetValues(node);
		RUNNING_NODE_IDS.add(String(node.id));
		setStatus(node, "已提交执行，等待开始...", 0.02);
		updateDomToolbarState(node);
		app.canvas?.selectNode?.(node);
		app.queuePrompt?.(0, 1);
	} catch (_) {
		app.queuePrompt?.();
	}
}

app.registerExtension({
	name: "Comfy.GJJ.SCAIL2LongVideoAIO.Rewrite",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (!isTarget(nodeData) || nodeType.prototype.__gjjScail2RewritePatched) return;
		nodeType.prototype.__gjjScail2RewritePatched = true;

		const created = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = created?.apply(this, args);
			setTimeout(() => stabilize(this), 0);
			setTimeout(() => stabilize(this), 120);
			return result;
		};

		const configured = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = configured?.apply(this, args);
			const properties = args[0]?.properties || {};
			for (const name of ["selected_video_json", "selected_reference_json", "selected_audio_json", DIRECTOR_WIDGET]) {
				if (properties[name] != null) setWidget(this, name, properties[name]);
			}
			setTimeout(() => stabilize(this), 0);
			setTimeout(() => stabilize(this), 180);
			return result;
		};

		const connections = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = connections?.apply(this, args);
			setTimeout(() => stabilize(this), 0);
			return result;
		};

		const draw = nodeType.prototype.onDrawForeground;
		nodeType.prototype.onDrawForeground = function (ctx, ...args) {
			const result = draw?.apply(this, [ctx, ...args]);
			drawToolbar(this, ctx);
			return result;
		};

		const mouse = nodeType.prototype.onMouseDown;
		nodeType.prototype.onMouseDown = function (event, pos, canvas) {
			if (handleToolbarClick(this, event, pos)) return true;
			return mouse?.apply(this, arguments);
		};

		const serialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (data) {
			sanitizeWidgetValues(this);
			const result = serialize?.apply(this, [data]);
			data.properties ||= {};
			for (const name of ["selected_video_json", "selected_reference_json", "selected_audio_json", DIRECTOR_WIDGET]) {
				const item = widget(this, name);
				if (item) data.properties[name] = item.value;
			}
			return result;
		};

		const executed = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...args) {
			const ui = message?.ui || message || {};
			const latestVideo = Array.isArray(ui.preview_media) && ui.preview_media.length ? ui.preview_media[ui.preview_media.length - 1] : null;
			if (latestVideo?.filename) {
				this.properties ||= {};
				this.properties.gjj_scail2_final_video = normalizeMediaItem(latestVideo);
				this.imgs = [];
				if (this.images) this.images = [];
				addPreviewPanel(this);
				reorderWidgets(this);
				ensureSize(this);
				updateStatusPanel(this);
				updatePreviewPanel(this);
			}
			const result = executed?.apply(this, [message, ...args]);
			if (latestVideo?.filename) {
				this.imgs = [];
				if (this.images) this.images = [];
				addPreviewPanel(this);
				reorderWidgets(this);
				ensureSize(this);
				updateStatusPanel(this);
				updatePreviewPanel(this);
			}
			app.graph?.setDirtyCanvas?.(true, true);
			return result;
		};
	},
	nodeCreated(node) {
		if (isTarget(node)) setTimeout(() => stabilize(node), 0);
	},
	loadedGraphNode(node) {
		if (!isTarget(node)) return;
		setTimeout(() => stabilize(node), 0);
		setTimeout(() => stabilize(node), 200);
		setTimeout(() => stabilize(node), 800);
	},
	setup() {
		if (!app.__gjjScail2QueueSanitizePatched && typeof app.queuePrompt === "function") {
			app.__gjjScail2QueueSanitizePatched = true;
			const queuePrompt = app.queuePrompt;
			app.queuePrompt = function (...args) {
				for (const node of app.graph?._nodes || []) {
					if (!isTarget(node)) continue;
					sanitizeWidgetValues(node);
					RUNNING_NODE_IDS.add(String(node.id));
					setStatus(node, "已提交执行，等待开始...", 0.02);
					updateDomToolbarState(node);
				}
				return queuePrompt.apply(this, args);
			};
		}
		const all = () => {
			for (const node of app.graph?._nodes || []) {
				if (isTarget(node)) stabilize(node);
			}
		};
		const refreshRunningState = () => {
			for (const node of app.graph?._nodes || []) {
				if (!isTarget(node)) continue;
				updateDomToolbarState(node);
				app.graph?.setDirtyCanvas?.(true, true);
			}
		};
		const nodeFromEvent = (event) => {
			const detail = event?.detail;
			const id = detail?.node ?? detail?.node_id ?? detail?.id ?? detail;
			if (id == null) return null;
			return app.graph?.getNodeById?.(Number(id)) || (app.graph?._nodes || []).find((node) => String(node?.id) === String(id)) || null;
		};
		if (!app.__gjjScail2ExecutionEventsPatched && api?.addEventListener) {
			app.__gjjScail2ExecutionEventsPatched = true;
			api.addEventListener("gjj_node_progress", (event) => {
				const detail = event?.detail || {};
				const node = nodeFromEvent(event);
				if (!node || !isTarget(node)) return;
				RUNNING_NODE_IDS.add(String(node.id));
				setStatus(node, detail.text || "正在运行...", detail.progress, { final_video: detail.final_video });
				if (detail.done) {
					RUNNING_NODE_IDS.delete(String(node.id));
					setStatus(node, detail.text || "完成", 1.0, { final_video: detail.final_video });
				}
				updateDomToolbarState(node);
			});
			api.addEventListener("executing", (event) => {
				const node = nodeFromEvent(event);
				if (!node) {
					RUNNING_NODE_IDS.clear();
					refreshRunningState();
					return;
				}
				if (isTarget(node)) {
					RUNNING_NODE_IDS.add(String(node.id));
					refreshRunningState();
				}
			});
			api.addEventListener("executed", (event) => {
				const node = nodeFromEvent(event);
				if (node?.id != null) RUNNING_NODE_IDS.delete(String(node.id));
				refreshRunningState();
			});
			for (const eventName of ["execution_success", "execution_error", "execution_interrupted"]) {
				api.addEventListener(eventName, () => {
					RUNNING_NODE_IDS.clear();
					refreshRunningState();
				});
			}
		}
		all();
		setTimeout(all, 200);
		setTimeout(all, 1000);
	},
});
