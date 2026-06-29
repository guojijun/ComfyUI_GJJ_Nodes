import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const NODE_TYPE = "GJJ_SceneFusionPrep";
const PANEL_WIDGET = "gjj_scene_fusion_prep_panel";
const CONFIG_WIDGET = "placement_config";
const BACKGROUND_UPLOAD_WIDGET = "background_upload";
const PERSON_UPLOADS_WIDGET = "person_uploads_json";
const CUTOUT_PREVIEW_WIDGET = "cutout_preview_only";
const ALIGN_TO_BACKGROUND_WIDGET = "align_to_background";
const PAUSED_LINKS_PROPERTY = "gjj_scene_fusion_paused_links";
const MODEL_DEFAULTS = {
	fusion_unet_name: "FireRed-Image-Edit-1.1_fp8mixed_comfy.safetensors",
	fusion_clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
	fusion_vae_name: "qwen_image_vae.safetensors",
	fusion_lora_1_name: "QWEN/FireRed-Image-Edit-1.0-Lightning-8steps-v1.1.safetensors",
	fusion_lora_2_name: "QWEN/edit_2511人景色交互20-LORA+by_xiaodu.safetensors",
};
const MODEL_FALLBACKS = {
	fusion_vae_name: ["qwen_image_HDR_vae_fp32_comfy.safetensors"],
};
const DEFAULT_FUSION_PROMPT = "按颜色将图1中的角色精准放置到图2场景指定位置，保持角色外观、服装、随身道具不变，并匹配场景的光照遮挡与透视尺度，不改动背景与构图。";
const PERSON_PREFIX = "person_";
const MEDIA_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO";
const MIN_PERSONS = 1;
const MAX_PERSONS = 12;
const HIDDEN_WIDGETS = new Set([
	"width", "height", CONFIG_WIDGET, "background_fit", "device", "process_res", "mask_blur",
	"positive_prompt", "negative_prompt", "seed", "steps", "cfg", "sampler_name", "scheduler", "denoise",
	"model_shift", "cfg_norm_strength", "cfg_norm_pre_cfg",
	"fusion_unet_name", "fusion_unet_dtype", "fusion_clip_name", "fusion_clip_dtype", "fusion_vae_name", "fusion_vae_dtype",
	"fusion_lora_1_name", "fusion_lora_1_strength", "fusion_lora_2_name", "fusion_lora_2_strength",
	BACKGROUND_UPLOAD_WIDGET, PERSON_UPLOADS_WIDGET, CUTOUT_PREVIEW_WIDGET, ALIGN_TO_BACKGROUND_WIDGET,
]);
const PY_WIDGET_ORDER = [
	"width", "height", CONFIG_WIDGET, "background_fit", "device", "process_res", "mask_blur",
	"positive_prompt", "negative_prompt", "seed", "steps", "cfg", "sampler_name", "scheduler", "denoise",
	"model_shift", "cfg_norm_strength", "cfg_norm_pre_cfg",
	"fusion_unet_name", "fusion_unet_dtype", "fusion_clip_name", "fusion_clip_dtype", "fusion_vae_name", "fusion_vae_dtype",
	"fusion_lora_1_name", "fusion_lora_1_strength", "fusion_lora_2_name", "fusion_lora_2_strength",
	BACKGROUND_UPLOAD_WIDGET, PERSON_UPLOADS_WIDGET, CUTOUT_PREVIEW_WIDGET, ALIGN_TO_BACKGROUND_WIDGET,
];
const SETTINGS_FIELDS = [
	["width", "宽度", "number"],
	["height", "高度", "number"],
	["fusion_unet_name", "主模型", "model"],
	["fusion_clip_name", "CLIP", "model"],
	["fusion_vae_name", "VAE", "model"],
	["fusion_lora_1_name", "LoRA 1", "model"],
	["fusion_lora_2_name", "LoRA 2", "model"],
];
const DEFAULT_COLORS = ["#0000FF", "#FF0000", "#00FF00", "#FF00FF", "#00FFFF", "#FFFF00"];
const RANDOM_COLOR_POOL = [
	"#2563EB", "#DC2626", "#16A34A", "#C026D3", "#0891B2", "#CA8A04",
	"#EA580C", "#7C3AED", "#059669", "#E11D48", "#0D9488", "#4F46E5",
	"#65A30D", "#DB2777", "#0284C7", "#9333EA", "#B45309", "#BE123C",
];
const DEFAULT_POSE = {
	head: [0, -0.43],
	neck: [0, -0.25],
	pelvis: [0, 0.14],
	left_shoulder: [-0.15, -0.21],
	right_shoulder: [0.15, -0.21],
	left_elbow: [-0.22, 0.02],
	right_elbow: [0.22, 0.02],
	left_hand: [-0.18, 0.25],
	right_hand: [0.18, 0.25],
	left_knee: [-0.11, 0.42],
	right_knee: [0.11, 0.42],
	left_foot: [-0.13, 0.66],
	right_foot: [0.13, 0.66],
};
const POSE_PRESETS = [
	{
		emoji: "🚶",
		title: "走路",
		pose: {
			head: [0.02, -0.43], neck: [0.01, -0.25], pelvis: [0, 0.14],
			left_shoulder: [-0.14, -0.21], right_shoulder: [0.16, -0.21],
			left_elbow: [-0.25, -0.02], right_elbow: [0.28, 0.04],
			left_hand: [-0.18, 0.22], right_hand: [0.12, 0.25],
			left_knee: [-0.18, 0.41], right_knee: [0.18, 0.36],
			left_foot: [-0.34, 0.65], right_foot: [0.34, 0.60],
		},
	},
	{
		emoji: "🧍",
		title: "站立",
		pose: structuredClone(DEFAULT_POSE),
	},
	{
		emoji: "🧎",
		title: "跪姿",
		pose: {
			head: [0, -0.43], neck: [0, -0.25], pelvis: [0.02, 0.18],
			left_shoulder: [-0.15, -0.21], right_shoulder: [0.15, -0.21],
			left_elbow: [-0.23, 0.02], right_elbow: [0.23, 0.02],
			left_hand: [-0.12, 0.25], right_hand: [0.14, 0.25],
			left_knee: [-0.28, 0.36], right_knee: [0.26, 0.50],
			left_foot: [-0.52, 0.42], right_foot: [0.42, 0.74],
		},
	},
	{
		emoji: "🏃‍♂️",
		title: "跑步",
		pose: {
			head: [0.05, -0.43], neck: [0.03, -0.25], pelvis: [0, 0.14],
			left_shoulder: [-0.12, -0.21], right_shoulder: [0.18, -0.20],
			left_elbow: [-0.30, -0.08], right_elbow: [0.31, 0.02],
			left_hand: [-0.18, 0.09], right_hand: [0.13, 0.24],
			left_knee: [-0.34, 0.28], right_knee: [0.26, 0.43],
			left_foot: [-0.58, 0.42], right_foot: [0.55, 0.66],
		},
	},
	{
		emoji: "🕺",
		title: "跳舞",
		pose: {
			head: [-0.02, -0.44], neck: [-0.01, -0.25], pelvis: [0.03, 0.14],
			left_shoulder: [-0.17, -0.22], right_shoulder: [0.15, -0.20],
			left_elbow: [-0.32, -0.38], right_elbow: [0.35, -0.02],
			left_hand: [-0.18, -0.56], right_hand: [0.47, -0.15],
			left_knee: [-0.18, 0.40], right_knee: [0.27, 0.34],
			left_foot: [-0.36, 0.64], right_foot: [0.42, 0.54],
		},
	},
	{
		emoji: "🤺",
		title: "击剑",
		pose: {
			head: [0.03, -0.43], neck: [0.02, -0.25], pelvis: [-0.02, 0.14],
			left_shoulder: [-0.14, -0.21], right_shoulder: [0.18, -0.21],
			left_elbow: [-0.27, -0.02], right_elbow: [0.40, -0.20],
			left_hand: [-0.20, 0.22], right_hand: [0.65, -0.21],
			left_knee: [-0.28, 0.42], right_knee: [0.28, 0.36],
			left_foot: [-0.55, 0.64], right_foot: [0.58, 0.61],
		},
	},
	{
		emoji: "🏌",
		title: "高尔夫",
		pose: {
			head: [0.06, -0.41], neck: [0.03, -0.24], pelvis: [0, 0.16],
			left_shoulder: [-0.14, -0.20], right_shoulder: [0.18, -0.20],
			left_elbow: [0.02, 0.00], right_elbow: [0.30, 0.05],
			left_hand: [0.23, 0.20], right_hand: [0.30, 0.21],
			left_knee: [-0.16, 0.41], right_knee: [0.18, 0.41],
			left_foot: [-0.34, 0.64], right_foot: [0.36, 0.64],
		},
	},
	{
		emoji: "🏋",
		title: "举重",
		pose: {
			head: [0, -0.43], neck: [0, -0.25], pelvis: [0, 0.16],
			left_shoulder: [-0.16, -0.22], right_shoulder: [0.16, -0.22],
			left_elbow: [-0.30, -0.45], right_elbow: [0.30, -0.45],
			left_hand: [-0.32, -0.68], right_hand: [0.32, -0.68],
			left_knee: [-0.30, 0.42], right_knee: [0.30, 0.42],
			left_foot: [-0.58, 0.62], right_foot: [0.58, 0.62],
		},
	},
	{
		emoji: "🤸",
		title: "倒立",
		rotation: 180,
		face_angle: 0,
		pose: {
			head: [0, -0.42], neck: [0, -0.24], pelvis: [0, 0.12],
			left_shoulder: [-0.16, -0.21], right_shoulder: [0.16, -0.21],
			left_elbow: [-0.31, -0.26], right_elbow: [0.23, -0.44],
			left_hand: [-0.48, -0.10], right_hand: [0.14, -0.66],
			left_knee: [-0.30, 0.38], right_knee: [0.30, 0.38],
			left_foot: [-0.58, 0.66], right_foot: [0.58, 0.66],
		},
	},
	{
		emoji: "🤾",
		title: "手球",
		pose: {
			head: [0.04, -0.44], neck: [0.02, -0.25], pelvis: [0, 0.14],
			left_shoulder: [-0.15, -0.21], right_shoulder: [0.18, -0.22],
			left_elbow: [-0.30, 0.02], right_elbow: [0.36, -0.42],
			left_hand: [-0.18, 0.25], right_hand: [0.30, -0.66],
			left_knee: [-0.32, 0.30], right_knee: [0.20, 0.44],
			left_foot: [-0.55, 0.50], right_foot: [0.42, 0.66],
		},
	},
	{
		emoji: "🧘",
		title: "打坐",
		pose: {
			head: [0, -0.43], neck: [0, -0.25], pelvis: [0, 0.22],
			left_shoulder: [-0.15, -0.21], right_shoulder: [0.15, -0.21],
			left_elbow: [-0.28, 0.02], right_elbow: [0.28, 0.02],
			left_hand: [-0.14, 0.25], right_hand: [0.14, 0.25],
			left_knee: [-0.38, 0.43], right_knee: [0.38, 0.43],
			left_foot: [0.10, 0.56], right_foot: [-0.10, 0.56],
		},
	},
];
const FIGURE_ASPECT = 0.42;
const IK_CHAINS = [
	{ root: "left_shoulder", mid: "left_elbow", end: "left_hand", bend: 1 },
	{ root: "right_shoulder", mid: "right_elbow", end: "right_hand", bend: -1 },
	{ root: "pelvis", mid: "left_knee", end: "left_foot", bend: 1 },
	{ root: "pelvis", mid: "right_knee", end: "right_foot", bend: -1 },
];
const POSE_LINES = [
	["head", "neck"], ["neck", "pelvis"], ["left_shoulder", "right_shoulder"],
	["neck", "left_shoulder"], ["neck", "right_shoulder"],
	["left_shoulder", "left_elbow"], ["left_elbow", "left_hand"],
	["right_shoulder", "right_elbow"], ["right_elbow", "right_hand"],
	["pelvis", "left_knee"], ["left_knee", "left_foot"],
	["pelvis", "right_knee"], ["right_knee", "right_foot"],
];
const MERGED_UPPER_JOINT = "upper_body";
const HIDDEN_DRAW_JOINTS = new Set(["neck", "left_shoulder", "right_shoulder"]);

function injectStyles() {
	if (document.getElementById("gjj-scene-fusion-prep-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-scene-fusion-prep-style";
	style.textContent = `
.gjj-sfp-root{width:100%;box-sizing:border-box;color:#dce7e2;font:12px/1.35 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none;}
.gjj-sfp-buttons{display:flex;gap:6px;align-items:center;width:100%;box-sizing:border-box;overflow:hidden;white-space:nowrap;padding:2px 0 5px;}
.gjj-sfp-btn{height:27px;min-width:0;flex:1 1 0;border:1px solid #3f525a;border-radius:6px;background:#172229;color:#dce8ec;font:700 12px/25px system-ui,sans-serif;cursor:pointer;padding:0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gjj-sfp-btn:hover{background:#21313a;border-color:#55707a;}
.gjj-sfp-btn[data-active="true"]{background:#243b2e;border-color:#60a56f;color:#f2fff5;}
.gjj-sfp-pose-buttons{display:flex;gap:4px;align-items:center;width:100%;box-sizing:border-box;overflow:hidden;white-space:nowrap;padding:0 0 5px;}
.gjj-sfp-pose-buttons .gjj-sfp-btn{flex:1 1 0;height:24px;padding:0 2px;font-size:15px;line-height:22px;}
.gjj-sfp-stage-wrap{width:100%;box-sizing:border-box;padding-top:4px;}
.gjj-sfp-stage{position:relative;width:100%;overflow:hidden;border:1px solid #33454d;border-radius:7px;background:#081015;box-sizing:border-box;touch-action:none;}
.gjj-sfp-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;}
.gjj-sfp-overlay{position:absolute;inset:0;width:100%;height:100%;overflow:visible;touch-action:none;}
.gjj-sfp-person{cursor:grab;}
.gjj-sfp-bone{fill:none;stroke-linecap:round;stroke-linejoin:round;}
.gjj-sfp-person-hit{fill:none;stroke:rgba(255,255,255,0);stroke-linecap:round;stroke-linejoin:round;pointer-events:stroke;cursor:grab;}
.gjj-sfp-head{fill:rgba(8,16,21,.2);}
.gjj-sfp-joint{stroke:#071014;stroke-width:2;cursor:pointer;}
.gjj-sfp-joint-hit{fill:rgba(255,255,255,0);stroke:none;pointer-events:all;cursor:pointer;}
.gjj-sfp-handle{stroke:#071014;stroke-width:2;cursor:pointer;}
.gjj-sfp-face-line{stroke-linecap:round;}
.gjj-sfp-face-handle{stroke:#071014;stroke-width:2;cursor:pointer;}
.gjj-sfp-previews{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:0;padding-top:3px;overflow:hidden;}
.gjj-sfp-preview{flex:0 0 160px;width:160px;border:0;border-radius:0;background:transparent;padding:0;box-sizing:border-box;position:relative;overflow:hidden;}
.gjj-sfp-preview.person{flex:0 0 auto;width:auto;background:var(--gjj-person-color,#2f424a);}
.gjj-sfp-preview.person{border:5px solid var(--gjj-person-color,#2f424a);}
.gjj-sfp-preview.person.selected{box-shadow:inset 0 0 0 3px #f4fbff;}
.gjj-sfp-preview img{display:block;width:100%;height:92px;object-fit:contain;background:#071014;border-radius:0;}
.gjj-sfp-preview.person img{width:auto;max-width:none;background:var(--gjj-person-color,#2f424a);}
.gjj-sfp-preview span{position:absolute;left:0;right:0;bottom:0;display:block;padding:2px 3px;color:#d7e6e8;background:rgba(7,16,20,.72);font-size:10px;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;}
.gjj-sfp-preview.person span{color:var(--gjj-person-text,#ffffff);background:var(--gjj-person-color,#2f424a);font-weight:800;text-shadow:0 1px 1px rgba(0,0,0,.35);}
.gjj-sfp-settings{display:none;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;padding:5px 0;}
.gjj-sfp-settings.open{display:grid;}
.gjj-sfp-field{display:flex;flex-direction:column;gap:3px;min-width:0;}
.gjj-sfp-field.wide{grid-column:1/-1;}
.gjj-sfp-field span{color:#9fb1b8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gjj-sfp-input{width:100%;min-width:0;height:26px;border:1px solid #3f525a;border-radius:6px;background:#10191f;color:#e8f1f2;padding:2px 7px;box-sizing:border-box;font-size:12px;}
.gjj-sfp-progress{display:flex;align-items:center;gap:6px;height:13px;padding:0 1px 3px;box-sizing:border-box;}
.gjj-sfp-progress-track{position:relative;flex:1 1 auto;min-width:0;height:3px;border-radius:999px;background:#1b2a31;overflow:hidden;}
.gjj-sfp-progress-fill{position:absolute;left:0;top:0;height:100%;width:0%;border-radius:999px;background:#65d6ff;transition:width .16s ease;}
.gjj-sfp-progress-text{flex:0 1 auto;max-width:42%;min-width:0;color:#9fb1b8;font-size:10px;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gjj-sfp-var-popup{position:fixed;z-index:100000;width:min(560px,calc(100vw - 24px));max-height:min(560px,calc(100vh - 32px));display:flex;flex-direction:column;gap:7px;padding:9px;border:1px solid #486575;border-radius:8px;background:#08151a;color:#dce7e2;box-shadow:0 18px 46px rgba(0,0,0,.55);font:12px system-ui,"Microsoft YaHei",sans-serif;}
.gjj-sfp-var-grid{display:grid;grid-template-columns:minmax(120px,.75fr) minmax(0,1fr);gap:6px;overflow:hidden;min-height:160px;}
.gjj-sfp-var-list{overflow:auto;display:flex;flex-direction:column;gap:4px;border:1px solid #243941;border-radius:7px;padding:5px;}
.gjj-sfp-var-item{border:0;border-radius:6px;background:transparent;color:#dce7e2;text-align:left;padding:6px 7px;cursor:pointer;}
.gjj-sfp-var-item:hover,.gjj-sfp-var-item.active{background:#223741;}
`;
	document.head.appendChild(style);
}

function widget(node, name) {
	return GJJ_Utils.getWidget(node, name);
}

function findInput(node, name) {
	return Array.isArray(node?.inputs) ? node.inputs.find((item) => item?.name === name || String(item?.type || "") === `converted-widget:${name}`) : null;
}

function viewUrl(item) {
	if (!item?.filename) return "";
	if (item.__gjjSceneFusionCachedUrl) return item.__gjjSceneFusionCachedUrl;
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	item.__gjjSceneFusionCachedUrl = api.apiURL(`/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "temp")}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`);
	return item.__gjjSceneFusionCachedUrl;
}

function inputImageRef(value) {
	const text = String(value || "").replace(/\\/g, "/").trim();
	if (!text) return null;
	const parts = text.split("/");
	const filename = parts.pop() || text;
	return {
		filename,
		subfolder: parts.join("/"),
		type: "input",
		media_type: "image",
	};
}

function parseUploadList(value) {
	try {
		const parsed = JSON.parse(String(value || "[]"));
		return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
	} catch (_) {
		return [];
	}
}

function loadImageSize(ref) {
	const src = viewUrl(ref);
	if (!src) return Promise.resolve({ width: 0, height: 0 });
	return new Promise((resolve) => {
		const image = new Image();
		image.onload = () => resolve({ width: Number(image.naturalWidth || image.width || 0), height: Number(image.naturalHeight || image.height || 0) });
		image.onerror = () => resolve({ width: 0, height: 0 });
		image.src = src;
	});
}

function uploadedPersonCount(node) {
	return parseUploadList(widget(node, PERSON_UPLOADS_WIDGET)?.value || node?.properties?.[PERSON_UPLOADS_WIDGET]).length;
}

function uploadedPersonRefs(node) {
	return parseUploadList(widget(node, PERSON_UPLOADS_WIDGET)?.value || node?.properties?.[PERSON_UPLOADS_WIDGET])
		.map((name, index) => ({
			...inputImageRef(name),
			id: personName(index + 1),
			label: `人物 ${index + 1}`,
			color: DEFAULT_COLORS[index % DEFAULT_COLORS.length],
		}))
		.filter((item) => item?.filename);
}

function backgroundInputLinked(node) {
	return hasLink(findInput(node, "background"));
}

function personInputLinked(node) {
	return personInputs(node).some(hasLink);
}

function mediaSourceSignature(node) {
	const bgLink = linkIds(findInput(node, "background")).join(",");
	const bgUpload = backgroundInputLinked(node) ? "" : String(widget(node, BACKGROUND_UPLOAD_WIDGET)?.value || node?.properties?.[BACKGROUND_UPLOAD_WIDGET] || "");
	return `bg:${bgLink}:${bgUpload}|person:${personSourceSignature(node)}`;
}

function invalidatePayloadOnSourceChange(node) {
	const signature = mediaSourceSignature(node);
	if (node.__gjjSceneFusionMediaSourceSignature == null) {
		node.__gjjSceneFusionMediaSourceSignature = signature;
		return false;
	}
	if (node.__gjjSceneFusionMediaSourceSignature === signature) return false;
	node.__gjjSceneFusionMediaSourceSignature = signature;
	node.__gjjSceneFusionPayload = null;
	return true;
}

async function updateLocalPreview(node) {
	const hasExternalBackground = backgroundInputLinked(node);
	const hasExternalPersons = personInputLinked(node);
	const bgRef = hasExternalBackground ? null : inputImageRef(widget(node, BACKGROUND_UPLOAD_WIDGET)?.value || node?.properties?.[BACKGROUND_UPLOAD_WIDGET]);
	const existing = node.__gjjSceneFusionPayload;
	const background = bgRef || existing?.background;
	if (!background?.filename) return;
	const size = await loadImageSize(background);
	const widthWidget = Number(widget(node, "width")?.value || 0);
	const heightWidget = Number(widget(node, "height")?.value || 0);
	const backgroundW = align16(size.width);
	const backgroundH = align16(size.height);
	const staleSquare = align16(widthWidget) === 2048 && align16(heightWidget) === 2048 && (backgroundW !== 2048 || backgroundH !== 2048);
	if ((!align16(widthWidget) || staleSquare) && backgroundW) setWidgetValue(node, "width", backgroundW);
	if ((!align16(heightWidget) || staleSquare) && backgroundH) setWidgetValue(node, "height", backgroundH);
	const alignToBackground = alignToBackgroundEnabled(node);
	const canvasW = alignToBackground ? (backgroundW || Number(existing?.canvas?.width || 1024)) : (align16(widget(node, "width")?.value) || backgroundW || Number(existing?.canvas?.width || 1024));
	const canvasH = alignToBackground ? (backgroundH || Number(existing?.canvas?.height || 1024)) : (align16(widget(node, "height")?.value) || backgroundH || Number(existing?.canvas?.height || 1024));
	const personRefs = hasExternalPersons ? [] : uploadedPersonRefs(node);
	const linkedPersonCount = personInputs(node).filter(hasLink).length;
	const existingCount = hasExternalPersons && existing?.__sourceSignature === mediaSourceSignature(node) ? existing?.persons?.length || 0 : 0;
	const count = hasExternalPersons
		? Math.max(linkedPersonCount, existingCount)
		: Math.max(personRefs.length, existing?.persons?.length || 0);
	const saved = parseConfig(node);
	const persons = Array.from({ length: count }, (_, index) => ({
		...defaultPerson(index, count),
		...(saved[index] || {}),
		id: personName(index + 1),
		color: validColor(saved[index]?.color, DEFAULT_COLORS[index % DEFAULT_COLORS.length]),
	}));
	node.__gjjSceneFusionPayload = {
		__sourceSignature: mediaSourceSignature(node),
		canvas: { width: canvasW, height: canvasH, background_fit: widget(node, "background_fit")?.value || "裁切填满" },
		background,
		persons,
		person_refs: [],
		placement_config: { version: 1, persons },
		merged: null,
	};
	writeConfig(node, persons);
	renderPayload(node);
}

function parsePayload(message) {
	const direct = Array.isArray(message?.gjj_scene_fusion_prep) ? message.gjj_scene_fusion_prep[0] : message?.gjj_scene_fusion_prep;
	if (direct?.canvas) return direct;
	const nested = Array.isArray(message?.ui?.gjj_scene_fusion_prep) ? message.ui.gjj_scene_fusion_prep[0] : message?.ui?.gjj_scene_fusion_prep;
	return nested?.canvas ? nested : null;
}

function finite(value, fallback) {
	const number = Number(value);
	return Number.isFinite(number) ? number : fallback;
}

function clamp(value, lower, upper) {
	return Math.max(lower, Math.min(upper, value));
}

function align16(value) {
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) return 0;
	return Math.max(16, Math.floor(Math.max(16, Math.round(number)) / 16) * 16);
}

function personName(index) {
	return `${PERSON_PREFIX}${String(index).padStart(2, "0")}`;
}

function personIndex(name) {
	const match = String(name || "").match(/^person_(\d+)$/);
	return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function personInputs(node) {
	return Array.isArray(node?.inputs)
		? [...node.inputs].filter((input) => String(input?.name || "").startsWith(PERSON_PREFIX)).sort((a, b) => personIndex(a.name) - personIndex(b.name))
		: [];
}

function hasLink(input) {
	return input?.link != null || (Array.isArray(input?.links) && input.links.length > 0);
}

function linkIds(input) {
	if (!input) return [];
	if (Array.isArray(input.links)) return input.links.filter((id) => id != null);
	return input.link != null ? [input.link] : [];
}

function getGraphLink(graph, linkId) {
	if (!graph || linkId == null) return null;
	if (typeof graph.links?.get === "function") return graph.links.get(linkId);
	return graph.links?.[linkId] || null;
}

function pausedExternalLinks(node) {
	const value = node?.properties?.[PAUSED_LINKS_PROPERTY];
	return Array.isArray(value) ? value : [];
}

function managedExternalInputs(node) {
	const inputs = [findInput(node, "background"), ...personInputs(node)];
	return inputs.filter(Boolean);
}

function currentExternalLinks(node) {
	const graph = node?.graph || app.graph;
	const result = [];
	for (const input of managedExternalInputs(node)) {
		const targetSlot = node.inputs.indexOf(input);
		for (const linkId of linkIds(input)) {
			const link = getGraphLink(graph, linkId);
			if (!link) continue;
			result.push({
				origin_id: link.origin_id,
				origin_slot: link.origin_slot,
				target_name: input.name,
				target_slot: targetSlot,
			});
		}
	}
	return result;
}

function ensureInputName(node, name) {
	if (name === "background") return ensureInput(node, "background", MEDIA_TYPE);
	if (String(name || "").startsWith(PERSON_PREFIX)) {
		const target = personIndex(name);
		while (personInputs(node).length < target && personInputs(node).length < MAX_PERSONS) addPersonInput(node);
		return findInput(node, name);
	}
	return null;
}

function setPausedExternalLinks(node, links) {
	node.properties ||= {};
	node.properties[PAUSED_LINKS_PROPERTY] = Array.isArray(links) ? links : [];
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function updateLinkToggleButton(node) {
	const ui = node.__gjjSceneFusionUI;
	if (!ui?.linkToggle) return;
	const activeLinks = currentExternalLinks(node);
	const pausedLinks = pausedExternalLinks(node);
	const visible = activeLinks.length > 0 || pausedLinks.length > 0;
	ui.linkToggle.style.display = visible ? "" : "none";
	ui.linkToggle.dataset.active = pausedLinks.length > 0 && activeLinks.length === 0 ? "true" : "false";
	ui.linkToggle.title = activeLinks.length > 0
		? "断开外部背景/人物链接，并记住来源节点和插槽。"
		: "恢复上次断开的外部背景/人物链接。";
}

function disconnectExternalLinks(node) {
	const links = currentExternalLinks(node);
	if (!links.length) return false;
	setPausedExternalLinks(node, links);
	for (const input of managedExternalInputs(node)) {
		const slot = node.inputs.indexOf(input);
		if (slot < 0 || !hasLink(input)) continue;
		if (typeof node.disconnectInput === "function") node.disconnectInput(slot);
		else {
			for (const linkId of linkIds(input)) node.graph?.removeLink?.(linkId);
			input.link = null;
			input.links = null;
		}
	}
	node.graph?.change?.();
	normalizeInputs(node);
	updateLinkToggleButton(node);
	scheduleRefresh(node);
	return true;
}

function restoreExternalLinks(node) {
	const links = pausedExternalLinks(node);
	if (!links.length) return false;
	const graph = node?.graph || app.graph;
	for (const item of links) {
		const source = graph?.getNodeById?.(item.origin_id) || graph?._nodes?.find((candidate) => String(candidate?.id) === String(item.origin_id));
		const input = ensureInputName(node, item.target_name);
		const targetSlot = node.inputs.indexOf(input);
		if (!source || targetSlot < 0) continue;
		source.connect?.(item.origin_slot, node, targetSlot);
	}
	setPausedExternalLinks(node, []);
	node.graph?.change?.();
	normalizeInputs(node);
	updateLinkToggleButton(node);
	scheduleRefresh(node);
	schedulePersonCutoutPreview(node, true);
	return true;
}

function toggleExternalLinks(node) {
	if (currentExternalLinks(node).length) return disconnectExternalLinks(node);
	return restoreExternalLinks(node);
}

function defaultPerson(index, count) {
	return {
		id: personName(index + 1),
		x: count <= 1 ? 0.5 : (index + 1) / (count + 1),
		y: 0.58,
		scale: 1,
		rotation: 0,
		face_angle: 0,
		color: DEFAULT_COLORS[index % DEFAULT_COLORS.length],
		z: index,
		pose: structuredClone(DEFAULT_POSE),
	};
}

function parseConfig(node) {
	try {
		const raw = widget(node, CONFIG_WIDGET)?.value || node?.properties?.[CONFIG_WIDGET] || "";
		const parsed = JSON.parse(String(raw || "{}"));
		return Array.isArray(parsed?.persons) ? parsed.persons : [];
	} catch (_) {
		return [];
	}
}

function writeConfig(node, persons) {
	const clean = persons.map((item, index) => ({
		id: String(item.id || personName(index + 1)),
		x: clamp(finite(item.x, 0.5), -1, 2),
		y: clamp(finite(item.y, 0.58), -1, 2),
		scale: clamp(finite(item.scale, 1), 0.08, 4),
		rotation: clamp(finite(item.rotation, 0), -180, 180),
		face_angle: clamp(finite(item.face_angle, 0), -180, 180),
		color: validColor(item.color, DEFAULT_COLORS[index % DEFAULT_COLORS.length]),
		z: finite(item.z, index),
		pose: normalizePose(item.pose),
	}));
	const serialized = JSON.stringify({ version: 1, persons: clean });
	const item = widget(node, CONFIG_WIDGET);
	if (item) item.value = serialized;
	node.properties ||= {};
	node.properties[CONFIG_WIDGET] = serialized;
	node.graph?.change?.();
	node.setDirtyCanvas?.(true, true);
}

function normalizePose(value) {
	const pose = structuredClone(DEFAULT_POSE);
	if (value && typeof value === "object") {
		for (const key of Object.keys(DEFAULT_POSE)) {
			const point = value[key];
			if (Array.isArray(point) && point.length >= 2) {
				pose[key] = [clamp(finite(point[0], pose[key][0]), -1.2, 1.2), clamp(finite(point[1], pose[key][1]), -1.2, 1.2)];
			}
		}
	}
	return pose;
}

function metricPoint(point) {
	return [finite(point?.[0], 0) * FIGURE_ASPECT, finite(point?.[1], 0)];
}

function localPoint(point) {
	return [clamp(finite(point?.[0], 0) / FIGURE_ASPECT, -1.2, 1.2), clamp(finite(point?.[1], 0), -1.2, 1.2)];
}

function metricToLocal(point) {
	return localPoint(point);
}

function distanceMetric(a, b) {
	const pa = metricPoint(a);
	const pb = metricPoint(b);
	return Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
}

function boneLength(a, b) {
	return Math.max(0.01, distanceMetric(DEFAULT_POSE[a], DEFAULT_POSE[b]));
}

function translatePosePoints(clean, keys, delta) {
	for (const key of keys) {
		clean[key] = [
			clamp(finite(clean[key]?.[0], DEFAULT_POSE[key][0]) + delta[0], -1.2, 1.2),
			clamp(finite(clean[key]?.[1], DEFAULT_POSE[key][1]) + delta[1], -1.2, 1.2),
		];
	}
	return clean;
}

function fixedLengthPoint(anchorLocal, targetLocal, length, fallbackLocal) {
	const anchor = metricPoint(anchorLocal);
	const target = metricPoint(targetLocal);
	const fallback = metricPoint(fallbackLocal || targetLocal);
	let dx = target[0] - anchor[0];
	let dy = target[1] - anchor[1];
	let dist = Math.hypot(dx, dy);
	if (dist < 1e-5) {
		dx = fallback[0] - anchor[0];
		dy = fallback[1] - anchor[1];
		dist = Math.hypot(dx, dy) || 1;
	}
	return metricToLocal([anchor[0] + (dx / dist) * length, anchor[1] + (dy / dist) * length]);
}

function chainLengths(chain) {
	return {
		upper: Math.max(0.01, distanceMetric(DEFAULT_POSE[chain.root], DEFAULT_POSE[chain.mid])),
		lower: Math.max(0.01, distanceMetric(DEFAULT_POSE[chain.mid], DEFAULT_POSE[chain.end])),
	};
}

function sideOfLine(root, end, point, fallback = 1) {
	const a = metricPoint(root);
	const b = metricPoint(end);
	const p = metricPoint(point);
	const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
	return Math.abs(cross) < 1e-5 ? (fallback < 0 ? -1 : 1) : (cross < 0 ? -1 : 1);
}

function solveTwoBone(rootLocal, targetLocal, upperLen, lowerLen, bendSide = 1) {
	const root = metricPoint(rootLocal);
	let target = metricPoint(targetLocal);
	let dx = target[0] - root[0];
	let dy = target[1] - root[1];
	let dist = Math.hypot(dx, dy);
	if (dist < 1e-5) {
		dx = 0;
		dy = upperLen + lowerLen;
		dist = Math.hypot(dx, dy);
	}
	const minReach = Math.max(0.001, Math.abs(upperLen - lowerLen) + 0.001);
	const maxReach = Math.max(minReach, upperLen + lowerLen - 0.001);
	const solvedDist = clamp(dist, minReach, maxReach);
	const ux = dx / dist;
	const uy = dy / dist;
	target = [root[0] + ux * solvedDist, root[1] + uy * solvedDist];
	const along = clamp((upperLen * upperLen + solvedDist * solvedDist - lowerLen * lowerLen) / (2 * solvedDist), 0, upperLen);
	const height = Math.sqrt(Math.max(0, upperLen * upperLen - along * along));
	const side = bendSide < 0 ? -1 : 1;
	const mid = [
		root[0] + ux * along + (-uy) * height * side,
		root[1] + uy * along + ux * height * side,
	];
	return { mid: localPoint(mid), end: localPoint(target) };
}

function moveUpperBodyJoint(clean, local) {
	const oldNeck = clean.neck || DEFAULT_POSE.neck;
	const newNeck = fixedLengthPoint(clean.pelvis, local, boneLength("neck", "pelvis"), oldNeck);
	const delta = [newNeck[0] - oldNeck[0], newNeck[1] - oldNeck[1]];
	return translatePosePoints(clean, ["head", "neck", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_hand", "right_hand"], delta);
}

function movePelvisJoint(clean, local) {
	const oldPelvis = clean.pelvis || DEFAULT_POSE.pelvis;
	const newPelvis = fixedLengthPoint(clean.neck, local, boneLength("neck", "pelvis"), oldPelvis);
	const delta = [newPelvis[0] - oldPelvis[0], newPelvis[1] - oldPelvis[1]];
	return translatePosePoints(clean, ["pelvis", "left_knee", "right_knee", "left_foot", "right_foot"], delta);
}

function applyFkMidDrag(clean, chain, local) {
	const lengths = chainLengths(chain);
	const root = metricPoint(clean[chain.root]);
	const target = metricPoint(local);
	const oldMid = metricPoint(clean[chain.mid]);
	const oldEnd = metricPoint(clean[chain.end]);
	let dx = target[0] - root[0];
	let dy = target[1] - root[1];
	let dist = Math.hypot(dx, dy);
	if (dist < 1e-5) {
		dx = oldMid[0] - root[0];
		dy = oldMid[1] - root[1];
		dist = Math.hypot(dx, dy) || 1;
	}
	const newMid = [root[0] + (dx / dist) * lengths.upper, root[1] + (dy / dist) * lengths.upper];
	const delta = [newMid[0] - oldMid[0], newMid[1] - oldMid[1]];
	clean[chain.mid] = metricToLocal(newMid);
	const movedEnd = metricToLocal([oldEnd[0] + delta[0], oldEnd[1] + delta[1]]);
	clean[chain.end] = fixedLengthPoint(clean[chain.mid], movedEnd, lengths.lower, clean[chain.end]);
	return clean;
}

function normalizeIkPose(pose, active = null) {
	const clean = structuredClone(pose || DEFAULT_POSE);
	for (const chain of IK_CHAINS) {
		const lengths = chainLengths(chain);
		const bend = sideOfLine(clean[chain.root], clean[chain.end], clean[chain.mid], chain.bend);
		const solved = solveTwoBone(clean[chain.root], clean[chain.end], lengths.upper, lengths.lower, bend);
		if (active?.key === chain.mid) {
			const midSide = sideOfLine(clean[chain.root], clean[chain.end], active.local, chain.bend);
			const midSolved = solveTwoBone(clean[chain.root], clean[chain.end], lengths.upper, lengths.lower, midSide);
			clean[chain.mid] = midSolved.mid;
			continue;
		}
		clean[chain.mid] = solved.mid;
		clean[chain.end] = solved.end;
	}
	return clean;
}

function applyJointDrag(pose, key, local) {
	const clean = normalizePose(pose);
	if (key === MERGED_UPPER_JOINT) {
		return moveUpperBodyJoint(clean, local);
	}
	const chain = IK_CHAINS.find((item) => item.mid === key || item.end === key);
	if (!chain) {
		if (key === "pelvis") {
			return movePelvisJoint(clean, local);
		}
		if (key === "head") {
			clean.head = fixedLengthPoint(clean.neck, local, boneLength("head", "neck"), clean.head);
			return clean;
		}
		clean[key] = local;
		return clean;
	}
	if (key === chain.mid) {
		return applyFkMidDrag(clean, chain, local);
	}
	const lengths = chainLengths(chain);
	const bend = sideOfLine(clean[chain.root], local, clean[chain.mid], chain.bend);
	const solved = solveTwoBone(clean[chain.root], local, lengths.upper, lengths.lower, bend);
	clean[chain.mid] = solved.mid;
	clean[chain.end] = solved.end;
	return clean;
}

function validColor(value, fallback) {
	const text = String(value || "");
	return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toUpperCase() : fallback;
}

function colorRgb(hex) {
	const text = validColor(hex, "#000000").slice(1);
	return [0, 2, 4].map((index) => parseInt(text.slice(index, index + 2), 16));
}

function contrastTextColor(hex) {
	const [red, green, blue] = colorRgb(hex).map((value) => {
		const channel = value / 255;
		return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
	return luminance > 0.46 ? "#071014" : "#FFFFFF";
}

function colorDistance(a, b) {
	const ar = colorRgb(a);
	const br = colorRgb(b);
	const rgb = Math.hypot(ar[0] - br[0], ar[1] - br[1], ar[2] - br[2]);
	const al = (ar[0] * 0.299 + ar[1] * 0.587 + ar[2] * 0.114);
	const bl = (br[0] * 0.299 + br[1] * 0.587 + br[2] * 0.114);
	return rgb + Math.abs(al - bl) * 1.8;
}

function rgbToHex(rgb) {
	return `#${rgb.map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

async function averageImageColor(ref) {
	const src = viewUrl(ref);
	if (!src) return null;
	return await new Promise((resolve) => {
		const image = new Image();
		image.onload = () => {
			try {
				const canvas = document.createElement("canvas");
				canvas.width = 24;
				canvas.height = 24;
				const ctx = canvas.getContext("2d", { willReadFrequently: true });
				ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
				const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
				const total = [0, 0, 0];
				let count = 0;
				for (let index = 0; index < data.length; index += 4) {
					const alpha = data[index + 3] / 255;
					if (alpha <= 0.02) continue;
					total[0] += data[index] * alpha;
					total[1] += data[index + 1] * alpha;
					total[2] += data[index + 2] * alpha;
					count += alpha;
				}
				resolve(count ? rgbToHex(total.map((value) => value / count)) : null);
			} catch (_) {
				resolve(null);
			}
		};
		image.onerror = () => resolve(null);
		image.src = src;
	});
}

function pickPersonColors(count, backgroundColor) {
	const pool = [...RANDOM_COLOR_POOL].sort(() => Math.random() - 0.5);
	const colors = [];
	for (let index = 0; index < count; index += 1) {
		let best = pool[0] || DEFAULT_COLORS[index % DEFAULT_COLORS.length];
		let bestScore = -Infinity;
		for (const color of pool) {
			if (colors.includes(color)) continue;
			const bgScore = backgroundColor ? colorDistance(color, backgroundColor) : 0;
			const personScore = colors.length ? Math.min(...colors.map((used) => colorDistance(color, used))) : 180;
			const score = bgScore * 1.2 + personScore + Math.random() * 20;
			if (score > bestScore) {
				best = color;
				bestScore = score;
			}
		}
		colors.push(best);
	}
	return colors;
}

async function randomizePersonColors(node) {
	const persons = configFromPayload(node);
	if (!persons.length) return;
	const backgroundColor = await averageImageColor(node.__gjjSceneFusionPayload?.background);
	const colors = pickPersonColors(persons.length, backgroundColor);
	const nextPersons = persons.map((person, index) => ({ ...person, color: colors[index] || DEFAULT_COLORS[index % DEFAULT_COLORS.length] }));
	writeConfig(node, nextPersons);
	if (node.__gjjSceneFusionPayload?.canvas) {
		node.__gjjSceneFusionPayload = {
			...node.__gjjSceneFusionPayload,
			persons: nextPersons,
			placement_config: { version: 1, persons: nextPersons },
		};
	}
	renderPayload(node);
}

function configFromPayload(node) {
	const payload = node.__gjjSceneFusionPayload;
	const persons = Array.isArray(payload?.persons) ? payload.persons : [];
	const saved = parseConfig(node);
	const byId = new Map(saved.map((item) => [String(item?.id || ""), item]));
	return persons.map((person, index) => {
		const id = String(person?.id || personName(index + 1));
		const savedPerson = byId.get(id) || {};
		return {
			...defaultPerson(index, persons.length),
			...person,
			...savedPerson,
			id,
			color: validColor(savedPerson.color ?? person?.color, DEFAULT_COLORS[index % DEFAULT_COLORS.length]),
			face_angle: finite(savedPerson.face_angle ?? person?.face_angle, 0),
			pose: normalizePose((savedPerson || person)?.pose),
		};
	});
}

function personRect(person, canvasW, canvasH) {
	const figureH = Math.max(24, Math.round(canvasH * 0.56 * clamp(finite(person.scale, 1), 0.08, 4)));
	const figureW = Math.max(16, Math.round(figureH * 0.42));
	const cx = Math.round(finite(person.x, 0.5) * canvasW);
	const cy = Math.round(finite(person.y, 0.58) * canvasH);
	return { left: cx - figureW / 2, top: cy - figureH / 2, width: figureW, height: figureH, cx, cy };
}

function localToCanvas(local, rect, degrees) {
	const x = rect.cx + finite(local?.[0], 0) * rect.width;
	const y = rect.cy + finite(local?.[1], 0) * rect.height;
	const rad = (degrees || 0) * Math.PI / 180;
	const dx = x - rect.cx;
	const dy = y - rect.cy;
	return [rect.cx + dx * Math.cos(rad) - dy * Math.sin(rad), rect.cy + dx * Math.sin(rad) + dy * Math.cos(rad)];
}

function canvasToLocal(x, y, rect, degrees) {
	const rad = -(degrees || 0) * Math.PI / 180;
	const dx = x - rect.cx;
	const dy = y - rect.cy;
	const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
	const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
	return [clamp(rx / Math.max(1, rect.width), -1.2, 1.2), clamp(ry / Math.max(1, rect.height), -1.2, 1.2)];
}

function makeSvg(tag) {
	return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function renderPayload(node) {
	const payload = node.__gjjSceneFusionPayload;
	if (!payload?.canvas || !Array.isArray(payload.persons)) return;
	const ui = ensurePreview(node);
	if (!ui) return;
	const canvasW = Math.max(1, Number(payload.canvas.width || 1));
	const canvasH = Math.max(1, Number(payload.canvas.height || 1));
	ui.stage.style.aspectRatio = `${Math.round(canvasW)} / ${Math.round(canvasH)}`;
	ui.stage.replaceChildren();
	const bg = document.createElement("img");
	bg.className = "gjj-sfp-bg";
	bg.src = viewUrl(payload.background);
	ui.stage.appendChild(bg);
	const svg = makeSvg("svg");
	svg.classList.add("gjj-sfp-overlay");
	svg.setAttribute("viewBox", `0 0 ${canvasW} ${canvasH}`);
	ui.stage.appendChild(svg);

	const persons = configFromPayload(node);
	if (!node.__gjjSceneFusionSelected || !persons.some((p) => p.id === node.__gjjSceneFusionSelected)) {
		node.__gjjSceneFusionSelected = persons[0]?.id || "";
	}
	for (const person of [...persons].sort((a, b) => finite(a.z, 0) - finite(b.z, 0))) {
		drawPerson(node, svg, person, persons, canvasW, canvasH);
	}
	renderOutputPreviews(ui, payload);
	refreshSize(node);
}

function drawPerson(node, svg, person, persons, canvasW, canvasH) {
	const rect = personRect(person, canvasW, canvasH);
	const color = validColor(person.color, "#0000FF");
	const selected = node.__gjjSceneFusionSelected === person.id;
	const group = makeSvg("g");
	group.classList.add("gjj-sfp-person");
	if (selected) group.classList.add("selected");
	group.dataset.personId = person.id;
	const points = {};
	for (const key of Object.keys(DEFAULT_POSE)) points[key] = localToCanvas(person.pose?.[key] || DEFAULT_POSE[key], rect, finite(person.rotation, 0));
	const head = points.head;
	const radius = Math.max(10, Math.round(rect.height * 0.105));
	const faceAngle = finite(person.rotation, 0) + finite(person.face_angle, 0);
	const faceCenter = pointFromAngle(head, radius * 0.34, faceAngle);
	for (const [a, b] of POSE_LINES) {
		let start = points[a];
		let end = points[b];
		if (a === "head" || b === "head") {
			[start, end] = trimLineToCircle(start, end, faceCenter, radius * 0.96);
		}
		const line = makeSvg("line");
		line.classList.add("gjj-sfp-bone");
		line.setAttribute("x1", start[0]);
		line.setAttribute("y1", start[1]);
		line.setAttribute("x2", end[0]);
		line.setAttribute("y2", end[1]);
		line.setAttribute("stroke", color);
		line.setAttribute("stroke-width", Math.max(3, Math.round(rect.height * 0.018)));
		group.appendChild(line);
		const hitLine = makeSvg("line");
		hitLine.classList.add("gjj-sfp-person-hit");
		hitLine.setAttribute("x1", start[0]);
		hitLine.setAttribute("y1", start[1]);
		hitLine.setAttribute("x2", end[0]);
		hitLine.setAttribute("y2", end[1]);
		hitLine.setAttribute("stroke-width", Math.max(22, Math.round(rect.height * 0.075)));
		group.appendChild(hitLine);
	}
	const circle = makeSvg("circle");
	circle.classList.add("gjj-sfp-head");
	circle.setAttribute("cx", head[0]);
	circle.setAttribute("cy", head[1]);
	circle.setAttribute("r", radius);
	circle.setAttribute("stroke", color);
	circle.setAttribute("stroke-width", Math.max(3, Math.round(rect.height * 0.018)));
	group.appendChild(circle);
	const headHit = makeSvg("circle");
	headHit.classList.add("gjj-sfp-person-hit");
	headHit.setAttribute("cx", head[0]);
	headHit.setAttribute("cy", head[1]);
	headHit.setAttribute("r", Math.max(radius + 10, Math.round(rect.height * 0.16)));
	group.appendChild(headHit);
	const faceH1 = pointFromAngle(faceCenter, radius * 0.82, faceAngle);
	const faceH2 = pointFromAngle(faceCenter, radius * 0.82, faceAngle + 180);
	const faceV1 = pointFromAngle(faceCenter, radius * 0.82, faceAngle + 90);
	const faceV2 = pointFromAngle(faceCenter, radius * 0.82, faceAngle - 90);
	for (const [x1, y1, x2, y2] of [[faceH1[0], faceH1[1], faceH2[0], faceH2[1]], [faceV1[0], faceV1[1], faceV2[0], faceV2[1]]]) {
		const line = makeSvg("line");
		line.classList.add("gjj-sfp-face-line");
		line.setAttribute("x1", x1);
		line.setAttribute("y1", y1);
		line.setAttribute("x2", x2);
		line.setAttribute("y2", y2);
		line.setAttribute("stroke", color);
		line.setAttribute("stroke-width", Math.max(1, Math.round(rect.height * 0.008)));
		group.appendChild(line);
	}
	const jointEntries = Object.entries(points).filter(([key]) => !HIDDEN_DRAW_JOINTS.has(key));
	jointEntries.push([MERGED_UPPER_JOINT, points.neck]);
	for (const [key, point] of jointEntries) {
		const joint = makeSvg("circle");
		joint.classList.add("gjj-sfp-joint");
		joint.dataset.joint = key;
		joint.setAttribute("cx", point[0]);
		joint.setAttribute("cy", point[1]);
		joint.setAttribute("r", selected ? "8.5" : "6.5");
		joint.setAttribute("fill", color);
		bindJointDrag(node, joint, person, persons, canvasW, canvasH);
		group.appendChild(joint);
		const jointHit = makeSvg("circle");
		jointHit.classList.add("gjj-sfp-joint-hit");
		jointHit.dataset.joint = key;
		jointHit.setAttribute("cx", point[0]);
		jointHit.setAttribute("cy", point[1]);
		jointHit.setAttribute("r", selected ? "17" : "14");
		bindJointDrag(node, jointHit, person, persons, canvasW, canvasH);
		group.appendChild(jointHit);
	}
	if (selected) {
		drawControlHandles(node, group, person, persons, rect, head, radius, color, canvasW, canvasH);
	}
	bindPersonDrag(node, group, person, persons, canvasW, canvasH);
	svg.appendChild(group);
}

function pointFromAngle(center, length, degrees) {
	const rad = (degrees || 0) * Math.PI / 180;
	return [center[0] + Math.cos(rad) * length, center[1] + Math.sin(rad) * length];
}

function trimLineToCircle(start, end, center, radius) {
	const dx = end[0] - start[0];
	const dy = end[1] - start[1];
	const fx = start[0] - center[0];
	const fy = start[1] - center[1];
	const a = dx * dx + dy * dy;
	if (a <= 1e-6) return [start, end];
	const b = 2 * (fx * dx + fy * dy);
	const c = fx * fx + fy * fy - radius * radius;
	const disc = b * b - 4 * a * c;
	if (disc < 0) return [start, end];
	const root = Math.sqrt(disc);
	const ts = [(-b - root) / (2 * a), (-b + root) / (2 * a)].filter((t) => t >= 0 && t <= 1);
	if (!ts.length) return [start, end];
	const startInside = ((start[0] - center[0]) ** 2 + (start[1] - center[1]) ** 2) < radius * radius;
	const t = startInside ? Math.max(...ts) : Math.min(...ts);
	const point = [start[0] + dx * t, start[1] + dy * t];
	return startInside ? [point, end] : [start, point];
}

function drawControlHandles(node, group, person, persons, rect, head, radius, color, canvasW, canvasH) {
	const pelvis = localToCanvas(person.pose?.pelvis || DEFAULT_POSE.pelvis, rect, finite(person.rotation, 0));
	const move = pelvis;
	const rotate = pointFromAngle([rect.cx, rect.cy], Math.max(24, rect.height * 0.62), finite(person.rotation, 0) - 90);
	const scale = localToCanvas([0.28, 0.66], rect, finite(person.rotation, 0));
	const faceAngle = finite(person.rotation, 0) + finite(person.face_angle, 0);
	const faceCenter = pointFromAngle(head, radius * 0.34, faceAngle);
	const face = pointFromAngle(faceCenter, radius * 1.65, faceAngle);
	for (const [kind, point, size] of [["move", move, 13], ["rotate", rotate, 13], ["scale", scale, 13]]) {
		const handle = makeControlHandle(kind, point, size, color);
		bindHandleDrag(node, handle, person, persons, canvasW, canvasH);
		group.appendChild(handle);
	}
	const faceGuide = makeSvg("line");
	faceGuide.setAttribute("x1", faceCenter[0]);
	faceGuide.setAttribute("y1", faceCenter[1]);
	faceGuide.setAttribute("x2", face[0]);
	faceGuide.setAttribute("y2", face[1]);
	faceGuide.setAttribute("stroke", color);
	faceGuide.setAttribute("stroke-width", "1.5");
	faceGuide.setAttribute("stroke-dasharray", "4 4");
	group.appendChild(faceGuide);
	const faceHandle = makeControlHandle("face", face, 12, color);
	bindHandleDrag(node, faceHandle, person, persons, canvasW, canvasH);
	group.appendChild(faceHandle);
}

function makeControlHandle(kind, point, size, color) {
	const handle = makeSvg("g");
	handle.classList.add(kind === "face" ? "gjj-sfp-face-handle" : "gjj-sfp-handle");
	handle.dataset.handle = kind;
	handle.style.pointerEvents = "all";
	const x = Number(point[0]);
	const y = Number(point[1]);
	const fill = kind === "move" || kind === "face" ? "#FFFFFF" : color;
	let shape = null;
	if (kind === "move") {
		shape = makeSvg("polygon");
		shape.setAttribute("points", `${x},${y - size} ${x + size},${y} ${x},${y + size} ${x - size},${y}`);
	} else if (kind === "rotate") {
		shape = makeSvg("polygon");
		shape.setAttribute("points", `${x},${y - size} ${x + size * 0.9},${y + size * 0.65} ${x - size * 0.9},${y + size * 0.65}`);
	} else if (kind === "scale") {
		shape = makeSvg("rect");
		shape.setAttribute("x", x - size * 0.82);
		shape.setAttribute("y", y - size * 0.82);
		shape.setAttribute("width", size * 1.64);
		shape.setAttribute("height", size * 1.64);
		shape.setAttribute("rx", "2");
	} else {
		shape = makeSvg("circle");
		shape.setAttribute("cx", x);
		shape.setAttribute("cy", y);
		shape.setAttribute("r", size);
	}
	shape.setAttribute("fill", fill);
	shape.setAttribute("stroke", "#071014");
	shape.setAttribute("stroke-width", "2");
	shape.style.pointerEvents = "all";
	handle.appendChild(shape);

	const icon = makeSvg("text");
	icon.setAttribute("x", x);
	icon.setAttribute("y", y + size * 0.32);
	icon.setAttribute("text-anchor", "middle");
	icon.setAttribute("font-size", Math.max(10, size * 1.05));
	icon.setAttribute("font-weight", "800");
	icon.setAttribute("fill", kind === "move" || kind === "face" ? "#102026" : "#FFFFFF");
	icon.style.pointerEvents = "none";
	icon.textContent = kind === "move" ? "✥" : kind === "rotate" ? "↻" : kind === "scale" ? "□" : "👁";
	handle.appendChild(icon);
	return handle;
}

function svgPoint(event, svg, canvasW, canvasH) {
	const rect = svg.getBoundingClientRect();
	return svgPointFromRect(event, rect, canvasW, canvasH);
}

function svgPointFromRect(event, rect, canvasW, canvasH) {
	return [
		((event.clientX - rect.left) / Math.max(1, rect.width)) * canvasW,
		((event.clientY - rect.top) / Math.max(1, rect.height)) * canvasH,
	];
}

function bindPersonDrag(node, group, person, persons, canvasW, canvasH) {
	group.addEventListener("pointerdown", (event) => {
		if (event.target?.classList?.contains("gjj-sfp-joint") || event.target?.classList?.contains("gjj-sfp-joint-hit")) return;
		event.preventDefault();
		event.stopPropagation();
		node.__gjjSceneFusionSelected = person.id;
		const svg = group.ownerSVGElement;
		const svgRect = svg.getBoundingClientRect();
		const start = svgPointFromRect(event, svgRect, canvasW, canvasH);
		const origin = [finite(person.x, 0.5), finite(person.y, 0.58)];
		const maxZ = Math.max(0, ...persons.map((item) => finite(item.z, 0)));
		person.z = maxZ + 1;
		const move = (moveEvent) => {
			moveEvent.preventDefault();
			moveEvent.stopPropagation();
			const now = svgPointFromRect(moveEvent, svgRect, canvasW, canvasH);
			person.x = clamp(origin[0] + (now[0] - start[0]) / canvasW, -1, 2);
			person.y = clamp(origin[1] + (now[1] - start[1]) / canvasH, -1, 2);
			writeConfig(node, persons);
			renderPayload(node);
		};
		const up = (upEvent) => {
			upEvent.preventDefault();
			upEvent.stopPropagation();
			window.removeEventListener("pointermove", move, true);
			window.removeEventListener("pointerup", up, true);
			window.removeEventListener("pointercancel", up, true);
		};
		window.addEventListener("pointermove", move, true);
		window.addEventListener("pointerup", up, true);
		window.addEventListener("pointercancel", up, true);
		writeConfig(node, persons);
		renderPayload(node);
	});
}

function bindJointDrag(node, joint, person, persons, canvasW, canvasH) {
	joint.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		event.stopPropagation();
		node.__gjjSceneFusionSelected = person.id;
		const key = joint.dataset.joint;
		const svg = joint.ownerSVGElement;
		const svgRect = svg.getBoundingClientRect();
		const move = (moveEvent) => {
			moveEvent.preventDefault();
			moveEvent.stopPropagation();
			const [x, y] = svgPointFromRect(moveEvent, svgRect, canvasW, canvasH);
			const rect = personRect(person, canvasW, canvasH);
			person.pose ||= structuredClone(DEFAULT_POSE);
			const local = canvasToLocal(x, y, rect, finite(person.rotation, 0));
			person.pose = applyJointDrag(person.pose, key, local);
			writeConfig(node, persons);
			renderPayload(node);
		};
		const up = (upEvent) => {
			upEvent.preventDefault();
			upEvent.stopPropagation();
			window.removeEventListener("pointermove", move, true);
			window.removeEventListener("pointerup", up, true);
			window.removeEventListener("pointercancel", up, true);
		};
		window.addEventListener("pointermove", move, true);
		window.addEventListener("pointerup", up, true);
		window.addEventListener("pointercancel", up, true);
	});
}

function bindHandleDrag(node, handle, person, persons, canvasW, canvasH) {
	handle.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		event.stopPropagation();
		node.__gjjSceneFusionSelected = person.id;
		const kind = handle.dataset.handle;
		const svg = handle.ownerSVGElement;
		const svgRect = svg.getBoundingClientRect();
		const start = svgPointFromRect(event, svgRect, canvasW, canvasH);
		const origin = {
			x: finite(person.x, 0.5),
			y: finite(person.y, 0.58),
			scale: finite(person.scale, 1),
			rotation: finite(person.rotation, 0),
			face_angle: finite(person.face_angle, 0),
		};
		const startRect = personRect(person, canvasW, canvasH);
		const startDist = Math.hypot(start[0] - startRect.cx, start[1] - startRect.cy) || 1;
		const startAngle = Math.atan2(start[1] - startRect.cy, start[0] - startRect.cx) * 180 / Math.PI;
		const move = (moveEvent) => {
			moveEvent.preventDefault();
			moveEvent.stopPropagation();
			const now = svgPointFromRect(moveEvent, svgRect, canvasW, canvasH);
			if (kind === "move") {
				person.x = clamp(origin.x + (now[0] - start[0]) / canvasW, -1, 2);
				person.y = clamp(origin.y + (now[1] - start[1]) / canvasH, -1, 2);
			} else if (kind === "scale") {
				const distance = Math.hypot(now[0] - startRect.cx, now[1] - startRect.cy) || 1;
				person.scale = clamp(origin.scale * (distance / startDist), 0.08, 4);
			} else if (kind === "rotate") {
				const angle = Math.atan2(now[1] - startRect.cy, now[0] - startRect.cx) * 180 / Math.PI;
				person.rotation = clamp(origin.rotation + angle - startAngle, -180, 180);
			} else if (kind === "face") {
				const rect = personRect(person, canvasW, canvasH);
				const head = localToCanvas(person.pose?.head || DEFAULT_POSE.head, rect, finite(person.rotation, 0));
				const angle = Math.atan2(now[1] - head[1], now[0] - head[0]) * 180 / Math.PI;
				person.face_angle = clamp(angle - finite(person.rotation, 0), -180, 180);
			}
			writeConfig(node, persons);
			renderPayload(node);
		};
		const up = (upEvent) => {
			upEvent.preventDefault();
			upEvent.stopPropagation();
			window.removeEventListener("pointermove", move, true);
			window.removeEventListener("pointerup", up, true);
			window.removeEventListener("pointercancel", up, true);
		};
		window.addEventListener("pointermove", move, true);
		window.addEventListener("pointerup", up, true);
		window.addEventListener("pointercancel", up, true);
	});
}

function renderOutputPreviews(ui, payload) {
	if (!ui?.previews) return;
	ui.previews.replaceChildren();
	const cards = [];
	for (const person of (payload.persons || []).filter((item) => item?.filename)) {
		cards.push({ item: person, label: person.label || person.id || "人物", personId: person.id, color: person.color });
	}
	for (const { item, label, personId, color } of cards) {
		if (!item?.filename) continue;
		const card = document.createElement("div");
		card.className = "gjj-sfp-preview";
		if (personId) {
			card.classList.add("person");
			const personColor = validColor(color, "#2f424a");
			card.style.setProperty("--gjj-person-color", personColor);
			card.style.setProperty("--gjj-person-text", contrastTextColor(personColor));
			if (ui?.node?.__gjjSceneFusionSelected === personId) card.classList.add("selected");
		}
		const image = document.createElement("img");
		image.src = viewUrl(item);
		const text = document.createElement("span");
		text.textContent = label;
		card.append(image, text);
		if (personId) {
			card.title = `${label}：点击选择对应火柴人`;
			card.style.cursor = "pointer";
			card.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				ui.node.__gjjSceneFusionSelected = personId;
				renderPayload(ui.node);
			});
		}
		ui.previews.appendChild(card);
	}
}

function ensurePreview(node) {
	const ui = node.__gjjSceneFusionUI;
	if (!ui?.root) return null;
	ui.node = node;
	if (!ui.stageWrap) {
		const stageWrap = document.createElement("div");
		stageWrap.className = "gjj-sfp-stage-wrap";
		const stage = document.createElement("div");
		stage.className = "gjj-sfp-stage";
		const previews = document.createElement("div");
		previews.className = "gjj-sfp-previews";
		stageWrap.append(stage, previews);
		ui.root.appendChild(stageWrap);
		ui.stageWrap = stageWrap;
		ui.stage = stage;
		ui.previews = previews;
		ui.node = node;
	}
	return ui;
}

async function runCurrentNode(node, button = null) {
	const oldText = button?.textContent;
	if (button) {
		button.disabled = true;
		button.textContent = "⏳";
	}
	try {
		return await queueOnlyCurrentNode(node);
	} catch (error) {
		console.warn("[GJJ] 人景融合准备刷新失败：", error);
		return false;
	} finally {
		if (button) {
			button.disabled = false;
			button.textContent = oldText || "🔄";
		}
	}
}

function personSourceSignature(node) {
	const uploads = parseUploadList(widget(node, PERSON_UPLOADS_WIDGET)?.value || node?.properties?.[PERSON_UPLOADS_WIDGET]).join(",");
	const links = personInputs(node)
		.map((input) => `${input.name}:${input.link ?? ""}:${Array.isArray(input.links) ? input.links.join(",") : ""}`)
		.join("|");
	return `${uploads}|${links}`;
}

function hasPersonSource(node) {
	return uploadedPersonCount(node) > 0 || personInputs(node).some(hasLink);
}

async function runPersonCutoutPreview(node) {
	if (!node || !hasPersonSource(node)) return false;
	if (node.__gjjSceneFusionCutoutRunning) {
		node.__gjjSceneFusionCutoutPending = true;
		return false;
	}
	node.__gjjSceneFusionCutoutRunning = true;
	setProgress(node, "抠图", 0.01);
	setWidgetValue(node, CUTOUT_PREVIEW_WIDGET, true);
	try {
		return await runCurrentNode(node);
	} finally {
		setWidgetValue(node, CUTOUT_PREVIEW_WIDGET, false);
		node.__gjjSceneFusionCutoutRunning = false;
		if (node.__gjjSceneFusionCutoutPending) {
			node.__gjjSceneFusionCutoutPending = false;
			schedulePersonCutoutPreview(node, true);
		}
	}
}

function schedulePersonCutoutPreview(node, force = false) {
	if (!node) return;
	const signature = personSourceSignature(node);
	if (!force && node.__gjjSceneFusionLastPersonSourceSignature === signature) return;
	node.__gjjSceneFusionLastPersonSourceSignature = signature;
	clearTimeout(node.__gjjSceneFusionCutoutTimer);
	node.__gjjSceneFusionCutoutTimer = setTimeout(() => runPersonCutoutPreview(node), 180);
}

function resetPersons(node) {
	const payload = node.__gjjSceneFusionPayload;
	const count = Array.isArray(payload?.persons) ? payload.persons.length : personInputs(node).filter(hasLink).length;
	const persons = Array.from({ length: Math.max(1, count) }, (_, index) => defaultPerson(index, Math.max(1, count)));
	writeConfig(node, persons);
	renderPayload(node);
}

function applyPosePreset(node, preset) {
	const payload = node.__gjjSceneFusionPayload;
	const persons = configFromPayload(node);
	if (!persons.length || !preset?.pose) return;
	const selected = String(node.__gjjSceneFusionSelected || persons[0]?.id || "");
	let index = persons.findIndex((item) => String(item?.id || "") === selected);
	if (index < 0) index = 0;
	const nextPersons = persons.map((person, personIndex) => personIndex === index
		? {
			...person,
			pose: normalizeIkPose(normalizePose(preset.pose)),
			rotation: finite(preset.rotation ?? 0, 0),
			face_angle: finite(preset.face_angle ?? 0, 0),
		}
		: person);
	node.__gjjSceneFusionSelected = nextPersons[index]?.id || "";
	writeConfig(node, nextPersons);
	if (payload?.canvas) {
		node.__gjjSceneFusionPayload = {
			...payload,
			persons: nextPersons,
			placement_config: { version: 1, persons: nextPersons },
		};
	}
	renderPayload(node);
}

function reindexPersons(persons) {
	const count = Array.isArray(persons) ? persons.length : 0;
	return (persons || []).map((item, index) => ({
		...defaultPerson(index, count),
		...item,
		id: personName(index + 1),
		label: `人物 ${index + 1}`,
		color: DEFAULT_COLORS[index % DEFAULT_COLORS.length],
		z: finite(item?.z, index),
	}));
}

async function deleteSelectedPerson(node) {
	const payload = node.__gjjSceneFusionPayload;
	const persons = configFromPayload(node);
	if (!persons.length) return;
	const selected = String(node.__gjjSceneFusionSelected || persons[0]?.id || "");
	let index = persons.findIndex((item) => String(item?.id || "") === selected);
	if (index < 0) {
		const parsedIndex = personIndex(selected) - 1;
		index = Number.isFinite(parsedIndex) ? parsedIndex : 0;
	}
	index = clamp(index, 0, persons.length - 1);
	const uploads = parseUploadList(widget(node, PERSON_UPLOADS_WIDGET)?.value || node?.properties?.[PERSON_UPLOADS_WIDGET]);
	if (uploads.length && index < uploads.length) {
		setWidgetValue(node, PERSON_UPLOADS_WIDGET, JSON.stringify(uploads.filter((_, itemIndex) => itemIndex !== index)));
	}
	const nextPersons = reindexPersons(persons.filter((_, itemIndex) => itemIndex !== index));
	node.__gjjSceneFusionSelected = nextPersons[Math.min(index, nextPersons.length - 1)]?.id || "";
	writeConfig(node, nextPersons);
	if (payload?.canvas) {
		node.__gjjSceneFusionPayload = {
			...payload,
			persons: nextPersons,
			placement_config: { version: 1, persons: nextPersons },
		};
	}
	renderPayload(node);
}

function makeButton(label, title) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title || label;
	button.className = "gjj-sfp-btn";
	button.addEventListener("pointerdown", (event) => event.stopPropagation());
	button.addEventListener("mousedown", (event) => event.stopPropagation());
	return button;
}

function normalizeUploadFilename(data, file, requestedSubfolder = "") {
	const filename = String(data?.name || data?.filename || data?.file || file?.name || "").replace(/\\/g, "/");
	if (!filename) return "";
	if (filename.includes("/")) return filename;
	const subfolder = String(data?.subfolder ?? requestedSubfolder ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return subfolder ? `${subfolder}/${filename}` : filename;
}

async function uploadImageFile(file, subfolder = "gjj_scene_fusion_prep") {
	const cleanSubfolder = String(subfolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const form = new FormData();
	form.append("image", file, file.name);
	form.append("type", "input");
	form.append("overwrite", "true");
	if (cleanSubfolder) form.append("subfolder", cleanSubfolder);
	const response = api?.fetchApi
		? await api.fetchApi("/upload/image", { method: "POST", body: form })
		: await fetch(api.apiURL("/upload/image"), { method: "POST", body: form });
	if (!response?.ok) throw new Error(`上传失败：HTTP ${response?.status || "?"}`);
	const data = await response.json().catch(() => ({}));
	const filename = normalizeUploadFilename(data, file, cleanSubfolder);
	if (!filename) throw new Error("上传成功但没有返回文件名");
	return filename;
}

async function openImagesForNode(node, kind, files) {
	const list = Array.from(files || []).filter((file) => file?.type?.startsWith("image/"));
	if (!list.length) return;
	const uploaded = [];
	for (let index = 0; index < list.length; index += 1) {
		uploaded.push(await uploadImageFile(list[index]));
	}
	if (kind === "background") {
		setWidgetValue(node, BACKGROUND_UPLOAD_WIDGET, uploaded[0] || "");
	} else {
		setWidgetValue(node, PERSON_UPLOADS_WIDGET, JSON.stringify(uploaded));
	}
	normalizeInputs(node);
	await updateLocalPreview(node);
	if (kind === "person") {
		schedulePersonCutoutPreview(node, true);
	}
}

function setWidgetValue(node, name, value) {
	const item = widget(node, name);
	if (!item) return;
	const oldValue = item.value;
	item.value = value;
	if (item.inputEl && "value" in item.inputEl) item.inputEl.value = value;
	if (item.element && "value" in item.element) item.element.value = value;
	if (item.__gjjSceneFusionFieldEl && "value" in item.__gjjSceneFusionFieldEl) item.__gjjSceneFusionFieldEl.value = value;
	item.callback?.(value);
	node.properties ||= {};
	node.properties[name] = validParamValue(name, value);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
	if ((name === BACKGROUND_UPLOAD_WIDGET || name === PERSON_UPLOADS_WIDGET) && String(oldValue ?? "") !== String(value ?? "")) {
		invalidatePayloadOnSourceChange(node);
	}
	if (name === PERSON_UPLOADS_WIDGET && String(oldValue ?? "") !== String(value ?? "")) {
		schedulePersonCutoutPreview(node, true);
	}
	if (name === ALIGN_TO_BACKGROUND_WIDGET) {
		updateAlignButton(node);
		updateLocalPreview(node);
	}
}

function alignToBackgroundEnabled(node) {
	const item = widget(node, ALIGN_TO_BACKGROUND_WIDGET);
	const value = item?.value ?? node?.properties?.[ALIGN_TO_BACKGROUND_WIDGET];
	return value == null ? true : booleanParamValue(value, true);
}

function booleanParamValue(value, fallback = false) {
	if (value == null) return fallback;
	if (typeof value === "string") {
		const text = value.trim().toLowerCase();
		if (["false", "0", "no", "off", "关闭"].includes(text)) return false;
		if (["true", "1", "yes", "on", "开启"].includes(text)) return true;
	}
	return Boolean(value);
}

function updateAlignButton(node) {
	const button = node?.__gjjSceneFusionUI?.alignToBackground;
	if (!button) return;
	const enabled = alignToBackgroundEnabled(node);
	button.dataset.active = enabled ? "true" : "false";
	button.title = enabled
		? "📐 已开启：按背景图片尺寸对齐。点击后改用节点面板宽度和高度。"
		: "📐 已关闭：按节点面板宽度和高度对齐。点击后改用背景图片尺寸。";
}

function modelSelectValues(name, currentValue) {
	const values = [];
	const current = String(currentValue ?? "").trim();
	const preset = String(MODEL_DEFAULTS[name] || "").trim();
	if (current && current !== "自动") values.push(current);
	if (preset && !values.includes(preset)) values.push(preset);
	for (const fallback of MODEL_FALLBACKS[name] || []) {
		const text = String(fallback || "").trim();
		if (text && !values.includes(text)) values.push(text);
	}
	return values.length ? values : [preset || current || ""];
}

function makeSettingField(node, name, label, kind) {
	const item = widget(node, name);
	if (!item) return null;
	const wrap = document.createElement("label");
	wrap.className = "gjj-sfp-field";
	if (kind === "model") wrap.classList.add("wide");
	const title = document.createElement("span");
	title.textContent = label;
	let field;
	const currentValue = item.value ?? "";
	if (kind === "select" || kind === "model") {
		field = document.createElement("select");
		field.className = "gjj-sfp-input";
		const values = kind === "model"
			? modelSelectValues(name, currentValue)
			: (item.options?.values || item.values || ["裁切填满", "等比留边", "拉伸填满"]);
		for (const value of values) {
			const opt = document.createElement("option");
			opt.value = value;
			opt.textContent = value;
			field.appendChild(opt);
		}
	} else {
		field = document.createElement("input");
		field.className = "gjj-sfp-input";
		field.type = kind === "number" ? "number" : "text";
	}
	field.value = (kind === "model" && (!String(currentValue).trim() || String(currentValue).trim() === "自动"))
		? (MODEL_DEFAULTS[name] || "")
		: currentValue;
	if (kind === "model" && field.value && (!String(item.value ?? "").trim() || String(item.value ?? "").trim() === "自动")) {
		setWidgetValue(node, name, field.value);
	}
	item.__gjjSceneFusionFieldEl = field;
	field.addEventListener("change", () => {
		setWidgetValue(node, name, kind === "number" ? Number(field.value) : field.value);
	});
	for (const eventName of ["pointerdown", "mousedown", "wheel"]) field.addEventListener(eventName, (event) => event.stopPropagation());
	wrap.append(title, field);
	return wrap;
}

function variableOptions(node) {
	const apiObject = globalThis.GJJ_VariableBroadcast;
	const graph = node?.graph || app.graph;
	return typeof apiObject?.getVisibleSetOptions === "function" ? (apiObject.getVisibleSetOptions(graph) || []) : [];
}

function openTemplateParamPicker(node, sourceButton) {
	node.__gjjSceneFusionVariablePopup?.remove?.();
	const popup = document.createElement("div");
	popup.className = "gjj-sfp-var-popup";
	const rect = sourceButton?.getBoundingClientRect?.() || { left: 24, bottom: 80 };
	popup.style.left = `${Math.round(Math.max(12, Math.min(window.innerWidth - 580, rect.left || 24)))}px`;
	popup.style.top = `${Math.round(Math.max(12, Math.min(window.innerHeight - 580, (rect.bottom || 80) + 6)))}px`;
	const head = document.createElement("div");
	head.textContent = "⚡ TemplateParams 对齐参考";
	head.style.cssText = "font-weight:800;";
	const hint = document.createElement("div");
	hint.textContent = "左列是本节点可广播参数名；右列是当前工作流变量。变量名同名且没有真实连线时，执行会自动优先使用外部值。";
	hint.style.cssText = "color:#96a8af;font-size:11px;line-height:1.35;";
	const grid = document.createElement("div");
	grid.className = "gjj-sfp-var-grid";
	const left = document.createElement("div");
	left.className = "gjj-sfp-var-list";
	const right = document.createElement("div");
	right.className = "gjj-sfp-var-list";
	for (const [name, label] of [["width", "宽度"], ["height", "高度"], ["seed", "种子"], ["steps", "步数"], ["cfg", "CFG"], ["denoise", "降噪"]]) {
		const item = document.createElement("button");
		item.type = "button";
		item.className = "gjj-sfp-var-item";
		item.textContent = `${label}  (${name})`;
		left.appendChild(item);
	}
	const options = variableOptions(node);
	for (const option of options) {
		const value = String(option?.value || "").trim();
		if (!value) continue;
		const item = document.createElement("button");
		item.type = "button";
		item.className = "gjj-sfp-var-item";
		item.innerHTML = `<b>${String(option?.label || value)}</b><br><span style="color:#8fa3ad">${value}</span>`;
		right.appendChild(item);
	}
	if (!right.children.length) {
		const empty = document.createElement("div");
		empty.textContent = "当前没有可见变量";
		empty.style.cssText = "padding:12px;color:#8fa3ad;text-align:center;";
		right.appendChild(empty);
	}
	const close = makeButton("关闭", "关闭");
	close.addEventListener("click", () => popup.remove());
	grid.append(left, right);
	popup.append(head, hint, grid, close);
	for (const eventName of ["pointerdown", "mousedown", "wheel"]) popup.addEventListener(eventName, (event) => event.stopPropagation());
	document.body.appendChild(popup);
	node.__gjjSceneFusionVariablePopup = popup;
}

function setProgress(node, text, progress) {
	const ui = node.__gjjSceneFusionUI;
	if (!ui?.progressFill || !ui?.progressText) return;
	const pct = Number.isFinite(Number(progress)) ? clamp(Number(progress), 0, 1) : 0;
	node.__gjjSceneFusionLastProgressText = String(text || "待执行");
	ui.progressFill.style.width = `${Math.round(pct * 100)}%`;
	ui.progressText.textContent = `${String(text || "待执行")} ${Math.round(pct * 100)}%`;
	refreshSize(node);
}

function makePanel(node) {
	const root = document.createElement("div");
	root.className = "gjj-sfp-root";
	root.addEventListener("pointerdown", (event) => event.stopPropagation());
	root.addEventListener("mousedown", (event) => event.stopPropagation());
	const buttons = document.createElement("div");
	buttons.className = "gjj-sfp-buttons";
	const backgroundFile = document.createElement("input");
	backgroundFile.type = "file";
	backgroundFile.accept = "image/*";
	backgroundFile.style.display = "none";
	const personFile = document.createElement("input");
	personFile.type = "file";
	personFile.accept = "image/*";
	personFile.multiple = true;
	personFile.style.display = "none";
	root.append(backgroundFile, personFile);
	const background = makeButton("🖼️", "在当前节点内部打开背景图。");
	background.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		backgroundFile.click();
	});
	const person = makeButton("👤", "打开人物图并只执行抠图预览。");
	person.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		personFile.click();
	});
	const params = makeButton("⚡", "查看 GJJ_TemplateParams 变量与本节点参数的两列式对齐。");
	params.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		openTemplateParamPicker(node, params);
	});
	const removePerson = makeButton("🗑", "删除当前选中的人物。");
	removePerson.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		await deleteSelectedPerson(node);
	});
	const randomColor = makeButton("🎲", "随机人物颜色，并尽量避开背景主色。");
	randomColor.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		await randomizePersonColors(node);
	});
	const linkToggle = makeButton("🔗", "断开或恢复外部背景/人物链接。");
	linkToggle.style.display = "none";
	linkToggle.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		toggleExternalLinks(node);
	});
	const settingsButton = makeButton("⚙️", "展开或收起融合参数。");
	const alignToBackground = makeButton("📐", "按背景图片尺寸对齐。");
	if (widget(node, ALIGN_TO_BACKGROUND_WIDGET)?.value == null && node.properties?.[ALIGN_TO_BACKGROUND_WIDGET] == null) {
		setWidgetValue(node, ALIGN_TO_BACKGROUND_WIDGET, true);
	}
	alignToBackground.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		setWidgetValue(node, ALIGN_TO_BACKGROUND_WIDGET, !alignToBackgroundEnabled(node));
	});
	const refresh = makeButton("🔄", "重新执行当前节点，更新抠图和预览。");
	refresh.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		setProgress(node, "排队", 0.01);
		await runCurrentNode(node, refresh);
	});
	const reset = makeButton("↺", "重置人物位置、颜色和火柴棍姿势。");
	reset.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		resetPersons(node);
	});
	buttons.append(background, person, params, removePerson, randomColor, linkToggle, settingsButton, alignToBackground, refresh, reset);
	const poseButtons = document.createElement("div");
	poseButtons.className = "gjj-sfp-pose-buttons";
	for (const preset of POSE_PRESETS) {
		const button = makeButton(preset.emoji, `动作预设：${preset.title}`);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			applyPosePreset(node, preset);
		});
		poseButtons.appendChild(button);
	}
	const progress = document.createElement("div");
	progress.className = "gjj-sfp-progress";
	const progressTrack = document.createElement("div");
	progressTrack.className = "gjj-sfp-progress-track";
	const progressFill = document.createElement("div");
	progressFill.className = "gjj-sfp-progress-fill";
	const progressText = document.createElement("div");
	progressText.className = "gjj-sfp-progress-text";
	progressText.textContent = "待执行 0%";
	progressTrack.appendChild(progressFill);
	progress.append(progressTrack, progressText);
	const settings = document.createElement("div");
	settings.className = "gjj-sfp-settings";
	settings.classList.toggle("open", Boolean(node.properties?.gjj_scene_fusion_settings_open));
	settingsButton.dataset.active = settings.classList.contains("open") ? "true" : "false";
	settingsButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		const open = !settings.classList.contains("open");
		settings.classList.toggle("open", open);
		node.properties ||= {};
		node.properties.gjj_scene_fusion_settings_open = open;
		settingsButton.dataset.active = open ? "true" : "false";
		refreshSize(node);
	});
	for (const [name, label, kind] of SETTINGS_FIELDS) {
		const field = makeSettingField(node, name, label, kind);
		if (field) settings.appendChild(field);
	}
	backgroundFile.addEventListener("change", async () => {
		try { await openImagesForNode(node, "background", backgroundFile.files); }
		finally { backgroundFile.value = ""; }
	});
	personFile.addEventListener("change", async () => {
		try { await openImagesForNode(node, "person", personFile.files); }
		finally { personFile.value = ""; }
	});
	root.appendChild(buttons);
	root.appendChild(poseButtons);
	root.appendChild(progress);
	root.appendChild(settings);
	node.__gjjSceneFusionUI = { root, buttons, poseButtons, background, person, params, removePerson, randomColor, linkToggle, settingsButton, alignToBackground, refresh, reset, progress, progressFill, progressText, settings, stageWrap: null, stage: null, controls: null, previews: null };
	updateLinkToggleButton(node);
	updateAlignButton(node);
	return root;
}

function refreshSize(node) {
	const ui = node.__gjjSceneFusionUI;
	if (!ui?.root) return;
	const height = Math.max(44, Math.ceil(ui.root.scrollHeight || ui.root.offsetHeight || 44) + 8);
	const width = Math.round(Number(node.size?.[0] || 360));
	node.__gjjSceneFusionHeight = height;
	node.setSize?.([width, height]);
	node.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function hideWidgets(node) {
	for (const name of HIDDEN_WIDGETS) {
		GJJ_Utils.hideWidget(widget(node, name));
	}
	GJJ_Utils.removeHiddenInputSockets(node, HIDDEN_WIDGETS);
	GJJ_Utils.reorderWidgets(node, HIDDEN_WIDGETS);
}

function setInputMeta(input, name, label, type, tooltip) {
	if (!input) return;
	input.name = name;
	input.label = label;
	input.localized_name = label;
	input.type = type;
	input.tooltip = tooltip;
}

function ensureInput(node, name, type) {
	let input = findInput(node, name);
	if (!input) {
		node.addInput?.(name, type);
		input = findInput(node, name);
	}
	return input;
}

function addPersonInput(node) {
	const inputs = personInputs(node);
	const next = inputs.length ? personIndex(inputs[inputs.length - 1].name) + 1 : 1;
	if (next <= MAX_PERSONS) node.addInput?.(personName(next), MEDIA_TYPE);
}

function trimTrailingPersons(node) {
	const inputs = personInputs(node);
	for (let index = inputs.length - 1; index >= MIN_PERSONS; index -= 1) {
		if (hasLink(inputs[index])) break;
		const slotIndex = node.inputs.indexOf(inputs[index]);
		if (slotIndex >= 0) node.removeInput?.(slotIndex);
	}
}

function ensureTrailingPerson(node) {
	const inputs = personInputs(node);
	if (!inputs.length) {
		addPersonInput(node);
		return;
	}
	if (hasLink(inputs[inputs.length - 1]) && inputs.length < MAX_PERSONS) addPersonInput(node);
}

function reorderInputs(node) {
	if (!Array.isArray(node?.inputs)) return;
	const ordered = [];
	const used = new Set();
	const push = (input) => {
		if (input && !used.has(input)) {
			ordered.push(input);
			used.add(input);
		}
	};
	push(findInput(node, "background"));
	for (const input of personInputs(node)) push(input);
	for (const input of node.inputs) push(input);
	node.inputs.splice(0, node.inputs.length, ...ordered);
}

function normalizeInputs(node) {
	ensureInput(node, "background", MEDIA_TYPE);
	ensureInput(node, "person_01", MEDIA_TYPE);
	trimTrailingPersons(node);
	ensureTrailingPerson(node);
	reorderInputs(node);
	setInputMeta(findInput(node, "background"), "background", "背景图", MEDIA_TYPE, "最终场景背景图。");
	for (const [index, input] of personInputs(node).entries()) {
		const number = index + 1;
		setInputMeta(input, personName(number), `人物 ${number}`, MEDIA_TYPE, "连接人物图片；最后一个人物口连接后会自动扩展下一口。");
	}
	globalThis.GJJApplyTypeColorsToNode?.(node);
}

function normalizeOutputs(node) {
	if (!Array.isArray(node?.outputs)) return;
	while (node.outputs.length > 1) node.removeOutput?.(node.outputs.length - 1);
	if (!node.outputs[0]) node.addOutput?.("合并图片", "IMAGE");
	node.outputs[0].name = "合并图片";
	node.outputs[0].label = "合并图片";
	node.outputs[0].localized_name = "合并图片";
	node.outputs[0].type = "IMAGE";
}

function validParamValue(name, value) {
	if (name === "width" || name === "height") {
		return align16(value);
	}
	if (name === CONFIG_WIDGET) {
		const text = String(value ?? "");
		try {
			if (text) JSON.parse(text);
			return text;
		} catch (_) {
			return "";
		}
	}
	if (name === "background_fit") return ["裁切填满", "等比留边", "拉伸填满"].includes(value) ? value : "裁切填满";
	if (name === "device") return ["自动", "GPU", "CPU"].includes(value) ? value : "自动";
	if (name === "process_res") {
		const number = Number(value);
		return Number.isFinite(number) && number >= 64 && number <= 4096 ? Math.round(number) : 1024;
	}
	if (name === "mask_blur") {
		const number = Number(value);
		return Number.isFinite(number) && number >= 0 && number <= 32 ? number : 0.8;
	}
	if (["positive_prompt", "negative_prompt", "sampler_name", "scheduler", "fusion_unet_name", "fusion_unet_dtype", "fusion_clip_name", "fusion_clip_dtype", "fusion_vae_name", "fusion_vae_dtype", "fusion_lora_1_name", "fusion_lora_1_strength", "fusion_lora_2_name", "fusion_lora_2_strength"].includes(name)) {
		return String(value ?? "");
	}
	if (["seed", "steps", "process_res"].includes(name)) {
		const number = Number(value);
		return Number.isFinite(number) ? Math.round(number) : (name === "steps" ? 8 : 0);
	}
	if (["cfg", "denoise", "model_shift", "cfg_norm_strength"].includes(name)) {
		const number = Number(value);
		return Number.isFinite(number) ? number : (name === "model_shift" ? 3.1 : 1);
	}
	if (name === "cfg_norm_pre_cfg" || name === CUTOUT_PREVIEW_WIDGET || name === ALIGN_TO_BACKGROUND_WIDGET) return booleanParamValue(value, name === ALIGN_TO_BACKGROUND_WIDGET);
	return value ?? "";
}

function canonicalValues(properties = {}) {
	return PY_WIDGET_ORDER.map((name) => validParamValue(name, properties?.[name]));
}

function restoreProperties(node) {
	node.properties ||= {};
	for (const name of PY_WIDGET_ORDER) {
		const item = widget(node, name);
		let value = validParamValue(name, node.properties[name] ?? item?.value);
		if (name === "steps" && Number(value) === 6) value = 8;
		if (name === "positive_prompt" && !String(value || "").trim()) {
			value = DEFAULT_FUSION_PROMPT;
		}
		node.properties[name] = value;
		if (item) item.value = value;
	}
}

function prepareSerialized(serializedNode) {
	if (!serializedNode) return;
	serializedNode.properties ||= {};
	const raw = Array.isArray(serializedNode.widgets_values) ? serializedNode.widgets_values : [];
	for (let index = 0; index < PY_WIDGET_ORDER.length; index++) {
		const name = PY_WIDGET_ORDER[index];
		let value = validParamValue(name, serializedNode.properties[name] ?? raw[index]);
		if (name === "steps" && Number(value) === 6) value = 8;
		if (name === "positive_prompt" && !String(value || "").trim()) {
			value = DEFAULT_FUSION_PROMPT;
		}
		serializedNode.properties[name] = value;
	}
	serializedNode.widgets_values = canonicalValues(serializedNode.properties);
}

function mountPanel(node) {
	injectStyles();
	if (!node.__gjjSceneFusionPanelWidget) {
		const root = makePanel(node);
		const panel = node.addDOMWidget?.(PANEL_WIDGET, "HTML", root, {
			serialize: false,
			hideOnZoom: false,
			getHeight: () => node.__gjjSceneFusionHeight || Math.max(44, root.scrollHeight || root.offsetHeight || 44),
		});
		if (panel) {
			panel.serialize = false;
			panel.options ||= {};
			panel.options.serialize = false;
			panel.value = undefined;
			panel.computeSize = (width) => [Math.round(Number(width || node.size?.[0] || 360)), node.__gjjSceneFusionHeight || Math.max(44, root.scrollHeight || root.offsetHeight || 44)];
		}
		node.__gjjSceneFusionPanelWidget = panel || { element: root };
	}
	refreshSize(node);
}

function stabilize(node) {
	if (!node) return;
	restoreProperties(node);
	hideWidgets(node);
	normalizeInputs(node);
	if (node.__gjjSceneFusionMediaSourceSignature == null) {
		node.__gjjSceneFusionMediaSourceSignature = mediaSourceSignature(node);
	}
	if (node.__gjjSceneFusionLastPersonSourceSignature == null) {
		node.__gjjSceneFusionLastPersonSourceSignature = personSourceSignature(node);
	}
	if (node.__gjjSceneFusionPayload && node.__gjjSceneFusionPayload.__sourceSignature == null && (backgroundInputLinked(node) || personInputLinked(node))) {
		node.__gjjSceneFusionPayload = null;
	}
	normalizeOutputs(node);
	mountPanel(node);
	if (node.__gjjSceneFusionPayload) renderPayload(node);
	else updateLocalPreview(node);
	updateLinkToggleButton(node);
	refreshSize(node);
}

function scheduleStabilize(node, ms = 32) {
	clearTimeout(node.__gjjSceneFusionTimer);
	node.__gjjSceneFusionTimer = setTimeout(() => stabilize(node), ms);
}

function scheduleRefresh(node) {
	clearTimeout(node.__gjjSceneFusionRefreshTimer);
	node.__gjjSceneFusionRefreshTimer = setTimeout(() => updateLocalPreview(node), 120);
}

app.registerExtension({
	name: "GJJ.SceneFusionPrep",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;

		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			setTimeout(() => stabilize(this), 0);
			setTimeout(() => stabilize(this), 80);
			return result;
		};

		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			prepareSerialized(serializedNode);
			const result = originalConfigure?.apply(this, [serializedNode, ...args]);
			this.properties ||= {};
			Object.assign(this.properties, serializedNode?.properties || {});
			restoreProperties(this);
			setTimeout(() => stabilize(this), 0);
			setTimeout(() => stabilize(this), 80);
			return result;
		};

		const originalSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			const result = originalSerialize?.apply(this, [serializedNode]);
			this.properties ||= {};
			for (const name of PY_WIDGET_ORDER) {
				const item = widget(this, name);
				if (item) this.properties[name] = validParamValue(name, item.value);
			}
			if (serializedNode) {
				serializedNode.properties ||= {};
				Object.assign(serializedNode.properties, this.properties);
				serializedNode.widgets_values = canonicalValues(this.properties);
			}
			return result;
		};

		const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalConnectionsChange?.apply(this, args);
			invalidatePayloadOnSourceChange(this);
			scheduleStabilize(this);
			scheduleRefresh(this);
			setTimeout(() => updateLinkToggleButton(this), 0);
			setTimeout(() => schedulePersonCutoutPreview(this), 0);
			return result;
		};

		const originalExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message, ...args) {
			const result = originalExecuted?.apply(this, [message, ...args]);
			const payload = parsePayload(message);
			if (payload) {
				payload.__sourceSignature = mediaSourceSignature(this);
				this.__gjjSceneFusionMediaSourceSignature = payload.__sourceSignature;
				this.__gjjSceneFusionPayload = payload;
				if (payload.placement_config) writeConfig(this, payload.placement_config.persons || []);
				renderPayload(this);
				const lastText = this.__gjjSceneFusionLastProgressText || "完成";
				setProgress(this, lastText === "完成" ? "完成" : `完成:${lastText}`, 1);
			}
			setTimeout(() => stabilize(this), 0);
			return result;
		};
	},
	nodeCreated(node) {
		if (node?.comfyClass === NODE_TYPE) setTimeout(() => stabilize(node), 0);
	},
	setup() {
		api.addEventListener("gjj_node_progress", (event) => {
			const detail = event.detail || {};
			const nodeId = String(detail.node || "");
			const node = app.graph?._nodes?.find((item) => String(item?.id) === nodeId);
			if (!node || node.comfyClass !== NODE_TYPE) return;
			setProgress(node, String(detail.text || "处理中"), detail.progress);
		});
		for (const node of app.graph?._nodes || []) {
			if (node?.comfyClass === NODE_TYPE) stabilize(node);
		}
	},
});
