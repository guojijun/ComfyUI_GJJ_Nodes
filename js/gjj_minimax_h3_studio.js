import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";
import { createTemplateSourceButton, updateTemplateSourcePanel } from "./gjj_generation_template_sources.js";
import { gjjLibraryThumbnailPath, loadGjjLibraryThumbnailBlobUrl, setGjjLibraryThumbnail } from "./gjj_library_thumbnails.js";

const NODE_TYPE = "GJJ_MiniMaxH3Studio";
const PANEL_WIDGET = "__gjj_minimax_h3_panel";
const RESULT_WIDGET = "__gjj_minimax_h3_result";
const STYLE_ID = "gjj-minimax-h3-studio-style";
const MEDIA_INPUTS = ["reference_media", "reference_media_2"];
const MANAGED_LINK_INPUTS = [...MEDIA_INPUTS, "external_prompt"];
const LINK_MEMORY_PROPERTY = "gjj_minimax_h3_media_links";
const MULTI_MEDIA_LINKS_PROPERTY = "gjj_minimax_h3_reference_media_2_virtual_links";
const MULTI_MEDIA_MEMORY_KEY = "__reference_media_2_virtual_links";
const PROMPT_BACKUP_PROPERTY = "gjj_minimax_h3_prompt";
const SETTINGS_BACKUP_PROPERTY = "gjj_minimax_h3_settings";
const SETTINGS_SCHEMA_PROPERTY = "gjj_minimax_h3_settings_schema";
const SETTINGS_SCHEMA_VERSION = 12;
const LORA_DATA_WIDGET = "lora_data";
const LORA_FILTER_PROPERTY = "gjj_minimax_h3_lora_filter";
const DEFAULT_LORA_FILTER = "minimax_h3_fl2v_lightx2v_turbo_4step";
const DEFAULT_ACCEL_STEPS = 4;
const IMAGE_COUNT_PROPERTY = "gjj_minimax_h3_image_count";
const UPLOAD_ROUTE = "/gjj/minimax_h3_studio/upload";
const PROMPT_MIN_HEIGHT = 58;
const PROMPT_DEFAULT_HEIGHT = 72;
const SIZE_MIN = 352;
const SIZE_MAX = 1920;
const SIZE_STEP = 32;
const CHARACTER_LIBRARY_ENDPOINT = "/gjj/character_library/list";
const SCENE_LIBRARY_ENDPOINT = "/gjj/scene_library/thumbnail_index";
const TEMPLATE_SOURCE_PROPERTY = "gjj_generation_template_sources";
const TEMPLATE_SOURCE_FIELDS = [
	{ name: "prompt", label: "提示词", type: "STRING", aliases: ["prompt", "positive", "提示词", "正向"] },
	{ name: "width", label: "宽度", type: "INT", aliases: ["width", "宽度", "w"] },
	{ name: "height", label: "高度", type: "INT", aliases: ["height", "高度", "h"] },
	{ name: "duration", label: "时长", type: "FLOAT", aliases: ["duration", "时长", "秒"] },
	{ name: "frame_rate", label: "帧率", type: "FLOAT", aliases: ["fps", "frame_rate", "帧率"] },
	{ name: "steps", label: "步数", type: "INT", aliases: ["steps", "步数"] },
	{ name: "seed", label: "种子", type: "INT", aliases: ["seed", "种子"] },
	{ name: "randomize_seed", label: "随机种子", type: "BOOLEAN", aliases: ["random", "randomize_seed", "随机种子"] },
	{ name: "sampler_name", label: "采样器", type: "STRING", aliases: ["sampler", "采样器"] },
	{ name: "scheduler", label: "调度器", type: "STRING", aliases: ["scheduler", "调度器"] },
	{ name: "denoise", label: "降噪", type: "FLOAT", aliases: ["denoise", "降噪"] },
	{ name: "ref_image_size", label: "参考图尺寸", type: "STRING", aliases: ["ref_image_size", "参考图", "尺寸"] },
	{ name: "filename_prefix", label: "文件名前缀", type: "STRING", aliases: ["filename", "prefix", "文件名", "前缀"] },
	{ name: "format_name", label: "输出格式", type: "STRING", aliases: ["format", "格式"] },
	{ name: "fl_model", label: "T2V/I2V模型", type: "STRING", aliases: ["fl_model", "fl2va", "t2v", "i2v"] },
	{ name: "ref_model", label: "参考模型", type: "STRING", aliases: ["ref_model", "ref2va", "参考模型"] },
	{ name: "clip_name", label: "编码器", type: "STRING", aliases: ["clip", "encoder", "编码器"] },
	{ name: "video_vae_name", label: "视频VAE", type: "STRING", aliases: ["video_vae", "视频vae"] },
	{ name: "audio_vae_name", label: "音频VAE", type: "STRING", aliases: ["audio_vae", "音频vae"] },
	{ name: "keep_model", label: "保持模型", type: "BOOLEAN", aliases: ["keep_model", "保持模型"] },
	{ name: "use_source_size", label: "首图尺寸", type: "BOOLEAN", aliases: ["source_size", "首图尺寸"] },
	{ name: "resize_fit_mode", label: "适配方式", type: "STRING", aliases: ["resize", "fit", "适配"] },
	{ name: "resize_anchor", label: "保留位置", type: "STRING", aliases: ["anchor", "保留位置", "对齐"] },
	{ name: "image_branch", label: "图片分支", type: "STRING", aliases: ["image_branch", "分支", "首尾帧", "参考"] },
	{ name: "reasoning_enabled", label: "启用推理", type: "BOOLEAN", aliases: ["reasoning", "thinking", "推理"] },
	{ name: "reasoning_model", label: "推理模型", type: "STRING", aliases: ["reasoning_model", "推理模型"] },
	{ name: "reasoning_system_prompt", label: "推理系统提示词", type: "STRING", aliases: ["system_prompt", "系统提示词"] },
	{ name: "global_prompt", label: "全局提示词", type: "STRING", aliases: ["global_prompt", "全局提示词"] },
	{ name: "negative_prompt", label: "负面提示词", type: "STRING", aliases: ["negative_prompt", "negative", "负面提示词"] },
	{ name: "prompt_replace_find", label: "查找提示词", type: "STRING", aliases: ["replace_find", "查找提示词"] },
	{ name: "prompt_replace_with", label: "替换为", type: "STRING", aliases: ["replace_with", "替换为"] },
	{ name: "patch_enable_sage_attention", label: "启用SageAttention", type: "BOOLEAN", aliases: ["sage", "sageattention"] },
	{ name: "patch_sage_attention_mode", label: "SageAttention模式", type: "STRING", aliases: ["sage_mode"] },
	{ name: "patch_allow_sage_compile", label: "允许Sage编译", type: "BOOLEAN", aliases: ["sage_compile"] },
	{ name: "patch_enable_fp16_accumulation", label: "启用FP16累积设置", type: "BOOLEAN", aliases: ["fp16_accumulation_setting"] },
	{ name: "patch_fp16_accumulation", label: "FP16累积", type: "BOOLEAN", aliases: ["fp16_accumulation"] },
	{ name: "patch_missing_sage_handling", label: "缺SageAttention处理", type: "STRING", aliases: ["missing_sage"] },
	{ name: "spectrum_enabled", label: "启用 Spectrum", type: "BOOLEAN", aliases: ["spectrum", "频谱加速"] },
	{ name: "spectrum_blend_weight", label: "频谱混合权重", type: "FLOAT", aliases: ["blend_weight"] },
	{ name: "spectrum_degree", label: "多项式阶数", type: "INT", aliases: ["degree"] },
	{ name: "spectrum_ridge_lambda", label: "岭回归强度", type: "FLOAT", aliases: ["ridge_lambda"] },
	{ name: "spectrum_window_size", label: "预测窗口", type: "FLOAT", aliases: ["window_size"] },
	{ name: "spectrum_flex_window", label: "自适应窗口增量", type: "FLOAT", aliases: ["flex_window"] },
	{ name: "spectrum_warmup_steps", label: "预热实算步数", type: "INT", aliases: ["warmup_steps"] },
	{ name: "spectrum_tail_actual_steps", label: "末尾实算步数", type: "INT", aliases: ["tail_actual_steps"] },
	{ name: "spectrum_max_history", label: "最大历史数量", type: "INT", aliases: ["max_history"] },
	{ name: "spectrum_debug", label: "调试日志", type: "BOOLEAN", aliases: ["debug"] },
	{ name: "spectrum_history_storage", label: "历史存储位置", type: "STRING", aliases: ["history_storage"] },
	{ name: "dialogue_language", label: "对白语言", type: "STRING", aliases: ["language", "dialogue_language", "语言", "对白语言"] },
	{ name: "megapixel_aspect", label: "百万像素比例", type: "STRING", aliases: ["aspect", "ratio", "比例"] },
	{ name: "megapixels", label: "百万像素", type: "FLOAT", aliases: ["megapixels", "mp", "百万像素"] },
	{ name: "cache_clip", label: "缓存CLIP", type: "BOOLEAN", aliases: ["cache_clip", "缓存CLIP"] },
	{ name: "director_storyboard_json", label: "导演分镜", type: "STRING", aliases: ["director", "storyboard", "导演台", "分镜"] },
	{ name: "use_video_size", label: "视频尺寸", type: "BOOLEAN", aliases: ["video_size", "视频尺寸"] },
	{ name: "prompt_structure", label: "提示词结构", type: "STRING", aliases: ["prompt_structure", "字段结构", "提示词结构"] },
	{ name: "visual_style", label: "视觉风格", type: "STRING", aliases: ["visual_style", "style", "视觉风格"] },
	{ name: "shot_plan", label: "分镜", type: "STRING", aliases: ["shot_plan", "cuts", "分镜", "切镜"] },
	{ name: "camera_motion", label: "运镜", type: "STRING", aliases: ["camera_motion", "camera", "运镜"] },
	{ name: "music_style", label: "音乐", type: "STRING", aliases: ["music_style", "music", "音乐", "配乐"] },
];
const HIDDEN = new Set([
	"width", "height", "duration", "frame_rate", "steps", "seed", "randomize_seed",
	"sampler_name", "scheduler", "denoise", "ref_image_size", "filename_prefix", "format_name",
	"fl_model", "ref_model", "clip_name", "video_vae_name", "audio_vae_name", "keep_model",
	"use_source_size",
	"size_mode", "resize_fit_mode", "resize_anchor",
	"internal_media_json",
	"image_branch",
	"reasoning_enabled", "reasoning_model", "reasoning_system_prompt",
	"selected_actors_json", "selected_scenes_json",
	"global_prompt", "negative_prompt", "prompt_replace_find", "prompt_replace_with",
	"patch_enable_sage_attention", "patch_sage_attention_mode", "patch_allow_sage_compile",
	"patch_enable_fp16_accumulation", "patch_fp16_accumulation", "patch_enable_ltxv_feedforward_chunk",
	"patch_feedforward_chunks", "patch_feedforward_threshold", "patch_missing_sage_handling",
	"spectrum_enabled", "spectrum_blend_weight", "spectrum_degree", "spectrum_ridge_lambda",
	"spectrum_window_size", "spectrum_flex_window", "spectrum_warmup_steps",
	"spectrum_tail_actual_steps", "spectrum_max_history", "spectrum_debug", "spectrum_history_storage",
	"dialogue_language",
	"megapixel_aspect", "megapixels",
	"lora_data",
	"cache_clip",
	"director_storyboard_json",
	"use_video_size",
	"prompt_structure",
	"visual_style", "shot_plan", "camera_motion", "music_style",
]);
const POPUP_GROUPS = {
	params: [["生成参数", ["duration", "frame_rate", "steps", "seed", "sampler_name", "scheduler", "denoise", "ref_image_size", "dialogue_language"]], ["输出", ["filename_prefix", "format_name"]]],
	size: [["画面尺寸", ["width", "height"]]],
	promptBook: [["提示词结构", ["prompt_structure", "visual_style", "shot_plan", "camera_motion", "music_style"]], ["附加提示词", ["global_prompt", "negative_prompt"]], ["替换提示词", ["prompt_replace_find", "prompt_replace_with"]]],
};

function widget(node, name) { return GJJ_Utils.getWidget(node, name); }
function value(node, name, fallback = "") { return widget(node, name)?.value ?? fallback; }
function setValue(node, name, next) {
	const target = widget(node, name); if (!target) return;
	target.value = next; target.callback?.(next); app.graph?.setDirtyCanvas?.(true, true);
}
function templateSources(node) {
	const raw = node?.properties?.[TEMPLATE_SOURCE_PROPERTY];
	if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
	try { const parsed = JSON.parse(String(raw || "{}")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch (_) { return {}; }
}
function boundVariable(node, name) { return String(templateSources(node)?.[name] || "").trim(); }
function applyBoundState(node, name, control) {
	if (!control) return; const variableName = boundVariable(node, name); const target = widget(node, name); const disabled = Boolean(variableName || target?.disabled);
	control.disabled = disabled; control.style.opacity = disabled ? "0.45" : ""; control.title = variableName ? `已由广播变量“${variableName}”接管` : "";
}
function inputDefinition(node, name) {
	const input = node?.constructor?.nodeData?.input || node?.constructor?.nodeData?.inputs || node?.nodeData?.input || {};
	for (const group of [input?.required, input?.optional]) if (Array.isArray(group?.[name])) return group[name];
	return null;
}
function declaredDefault(node, name) {
	const definition = inputDefinition(node, name); const options = definition?.[1] || {}; const target = widget(node, name); const items = declaredChoices(node, name, target);
	if (Object.prototype.hasOwnProperty.call(options, "default")) return options.default;
	if (items.length) return items[0];
	const type = definition?.[0]; if (type === "BOOLEAN") return false; if (type === "INT" || type === "FLOAT") return 0; return "";
}
function normalizedSettingValue(node, name, current) {
	const definition = inputDefinition(node, name); if (!definition) return current; const type = definition[0]; const options = definition[1] || {}; const items = declaredChoices(node, name, widget(node, name)); const fallback = declaredDefault(node, name);
	if (items.length) return items.map(String).includes(String(current)) ? current : fallback;
	if (type === "BOOLEAN") return typeof current === "boolean" ? current : fallback;
	if (type === "INT" || type === "FLOAT") { const number = Number(current); if (!Number.isFinite(number) || (options.min != null && number < Number(options.min)) || (options.max != null && number > Number(options.max))) return fallback; if (name === "width" || name === "height") return normalizeCanvasDimension(number); return type === "INT" ? Math.round(number) : number; }
	if (type === "STRING") return typeof current === "string" ? current : fallback;
	return current;
}
function normalizeCanvasDimension(raw, fallback = 864) {
	const numeric = Number(raw); const safe = Number.isFinite(numeric) ? numeric : Number(fallback);
	return Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(safe / SIZE_STEP) * SIZE_STEP));
}
function repairSerializedSettings(node) {
	for (const name of persistedWidgetNames(node)) { const target = widget(node, name); if (!target) continue; const next = normalizedSettingValue(node, name, target.value); if (next !== target.value) setValue(node, name, next); }
	const internal = widget(node, "internal_media_json"); if (internal) { try { const parsed = JSON.parse(String(internal.value || "[]")); if (!Array.isArray(parsed)) throw new Error(); } catch (_) { setValue(node, "internal_media_json", "[]"); } }
}
function protect(element) {
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel", "keydown", "contextmenu"]) element.addEventListener(eventName, (event) => event.stopPropagation());
}
function installStyle() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style"); style.id = STYLE_ID;
	style.textContent = `
	.gjj-mh3-root{font:12px/1.3 system-ui;color:#dcebed;background:#10191d;border-radius:8px;padding:8px;display:grid;gap:7px;align-content:start;grid-auto-rows:max-content}
	.gjj-mh3-toolbar{display:flex;flex-wrap:wrap;gap:0;align-items:center;align-content:flex-start;max-width:100%;margin:0;padding:0}.gjj-mh3-btn{box-sizing:border-box;width:28px;height:28px;min-width:28px;flex:0 0 28px;margin:0;padding:0;border:1px solid #42747d;border-radius:0;background:#173038;color:#dff;cursor:pointer;font:700 19px/1 "Segoe UI Emoji","Apple Color Emoji",sans-serif}.gjj-mh3-toolbar>.gjj-mh3-btn:first-child{border-radius:5px 0 0 5px}.gjj-mh3-toolbar>.gjj-mh3-btn:last-child{border-radius:0 5px 5px 0}.gjj-mh3-btn:hover{filter:brightness(1.18)}.gjj-mh3-btn.active{background:#175f4d;border-color:#55d2a2}.gjj-mh3-run{background:#168953;border-color:#39d789;color:white;font-weight:900}
	.gjj-mh3-btn.gjj-mh3-source-size{background:#695018;border-color:#f2bd3f;color:#fff4c8;box-shadow:inset 0 0 0 1px #f2bd3f55}.gjj-mh3-btn.gjj-mh3-spectrum,.gjj-mh3-btn.gjj-mh3-spectrum.active{background:#173038;border-color:#42747d;color:#dff;box-shadow:none}.gjj-mh3-btn.gjj-mh3-spectrum.enabled,.gjj-mh3-btn.gjj-mh3-spectrum.enabled.active{background:#175f4d;border-color:#55d2a2;color:#fff;box-shadow:inset 0 0 0 1px #55d2a255}
	.gjj-mh3-folder.loaded{background:#17614e;border-color:#55d2a2}.gjj-mh3-folder:disabled{opacity:.4;cursor:not-allowed}.gjj-mh3-link{display:none}.gjj-mh3-link.show{display:block}.gjj-mh3-link.detached{background:#6b5420;border-color:#d5a83c}
	.gjj-mh3-media-tip{position:fixed;z-index:100006;width:min(440px,calc(100vw - 24px));max-height:min(520px,calc(100vh - 24px));overflow:auto;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:9px;border:1px solid #4e7d86;border-radius:9px;background:#0d161a;color:#dcebed;box-shadow:0 14px 45px #000c}.gjj-mh3-media-card{min-width:0;border:1px solid #304e55;border-radius:7px;background:#111d21;padding:6px;display:grid;gap:5px}.gjj-mh3-media-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#a9c7cc}.gjj-mh3-media-card img,.gjj-mh3-media-card video{display:block;width:100%;max-height:190px;object-fit:contain;background:#000;border-radius:4px}.gjj-mh3-media-card audio{width:100%;height:34px}.gjj-mh3-media-text{max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:#dce7e2;font:11px/1.4 ui-monospace,monospace}
	.gjj-mh3-label{display:flex;align-items:center;gap:6px;color:#ffd27d;font-weight:700}.gjj-mh3-mode{margin-left:auto;color:#7ed9d3;font-weight:600}
	.gjj-mh3-prompt{box-sizing:border-box;width:100%;height:72px;min-height:58px;resize:vertical;border:1px solid #31535b;border-radius:6px;background:#091215;color:#f0f8f8;padding:7px;font:12px/1.35 ui-monospace,monospace}
	.gjj-mh3-mention-editor{box-sizing:border-box;width:100%;min-height:72px;max-height:220px;overflow:auto;padding:9px;border:1px solid #31535b;border-radius:6px;outline:none;background:#202124;color:#e8eaed;font:16px/1.55 system-ui,sans-serif;white-space:pre-wrap;word-break:break-word;cursor:text}.gjj-mh3-mention-editor *{cursor:text}.gjj-mh3-mention-editor.linked{border-color:#4a5053;background:#17191a;color:#858b8e;box-shadow:inset 0 0 0 1px #0005;cursor:not-allowed}.gjj-mh3-mention-editor.linked *{cursor:not-allowed}.gjj-mh3-mention-editor.linked .gjj-mh3-mention-chip{color:#768b89}.gjj-mh3-mention-editor.linked .gjj-mh3-mention-chip img{filter:grayscale(.65);opacity:.65}.gjj-mh3-mention-editor:empty::before{content:attr(data-placeholder);color:#75868b;pointer-events:none}.gjj-mh3-mention-chip{display:inline-flex;align-items:center;gap:3px;margin:0 2px;color:#11e2d0;vertical-align:middle;white-space:nowrap}.gjj-mh3-mention-chip img{width:24px;height:24px;border-radius:5px;object-fit:cover;background:#101719}.gjj-mh3-mention-menu{position:fixed;z-index:100020;width:min(360px,calc(100vw - 24px));max-height:330px;overflow:auto;padding:5px;border:1px solid #4d747b;border-radius:8px;background:#10191d;box-shadow:0 14px 42px #000c}.gjj-mh3-mention-option{display:grid;grid-template-columns:42px minmax(0,1fr);gap:8px;align-items:center;width:100%;padding:5px;border:0;border-radius:6px;background:transparent;color:#e6f3f3;text-align:left;cursor:pointer}.gjj-mh3-mention-option:hover{background:#19473f}.gjj-mh3-mention-option img{width:40px;height:40px;border-radius:6px;object-fit:cover;background:#081014}.gjj-mh3-mention-option strong,.gjj-mh3-mention-option small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gjj-mh3-mention-option small{margin-top:2px;color:#88a7ab}
	.gjj-mh3-status{height:16px;color:#8faeb4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
	.gjj-mh3-branches{display:flex;gap:7px;flex-wrap:wrap}.gjj-mh3-branch{min-width:64px;padding:6px 12px;border:1px solid #41666e;border-radius:7px;background:#15272d;color:#cfe3e6;cursor:pointer;font-weight:800}.gjj-mh3-branch.active{background:#137a61;border-color:#48d9a5;color:#fff}
	.gjj-mh3-library{position:fixed;z-index:100008;width:min(620px,calc(100vw - 28px));max-height:min(620px,calc(100vh - 32px));overflow:auto;padding:10px;border:1px solid #4e7d86;border-radius:10px;background:#0d171b;color:#e2f0f1;box-shadow:0 16px 48px #000c}.gjj-mh3-library-head{display:flex;align-items:center;gap:8px;margin-bottom:9px}.gjj-mh3-library-title{font-weight:900;color:#8de1d6}.gjj-mh3-library-search{flex:1;min-width:0;border:1px solid #365b64;border-radius:6px;background:#091215;color:#eef8f8;padding:7px}.gjj-mh3-library-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.gjj-mh3-library-card{min-width:0;border:1px solid #304e55;border-radius:8px;background:#122027;color:#dcebed;padding:6px;cursor:pointer;display:grid;gap:5px;text-align:left}.gjj-mh3-library-card.active{border-color:#4fd9a8;background:#164735}.gjj-mh3-library-card img{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:5px;background:#081014}.gjj-mh3-library-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:800}.gjj-mh3-library-empty{grid-column:1/-1;padding:24px;text-align:center;color:#8faeb4}
	.gjj-mh3-library-chips{display:none;flex-wrap:wrap;gap:5px;align-items:flex-start;align-content:flex-start}.gjj-mh3-library-chip{border:1px solid #456b73;border-radius:999px;background:#172a30;color:#d8eef0;padding:4px 9px;cursor:pointer;font-size:11px}.gjj-mh3-library-chip:hover{border-color:#62c9bd;background:#1d3a3d}
	.gjj-mh3-library-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px 3px 4px}.gjj-mh3-library-chip img{width:23px;height:23px;border-radius:50%;object-fit:cover;background:#081014}.gjj-mh3-library-button{position:relative;overflow:hidden}.gjj-mh3-library-button>img{display:block;width:100%;height:100%;object-fit:cover}.gjj-mh3-library-count{position:absolute;right:1px;bottom:0;min-width:13px;height:13px;border-radius:7px;background:#0b171bde;color:#fff;font:9px/13px system-ui;text-align:center}.gjj-mh3-library-preview{position:fixed;z-index:100012;width:280px;padding:7px;border:1px solid #54838b;border-radius:9px;background:#0b1418;color:#e5f1f2;box-shadow:0 16px 46px #000d}.gjj-mh3-library-preview img{display:block;width:100%;max-height:330px;object-fit:contain;border-radius:6px;background:#05090b}.gjj-mh3-library-preview div{padding:7px 3px 2px;line-height:1.4;white-space:normal}
	.gjj-mh3-pop{position:fixed;z-index:100000;width:min(560px,calc(100vw - 28px));max-height:calc(100vh - 40px);overflow:auto;display:none;background:#101a1e;color:#e2f0f1;border:1px solid #4e7d86;border-radius:10px;box-shadow:0 14px 45px #000b;padding:10px}.gjj-mh3-pop.open{display:block}.gjj-mh3-pophead{display:flex;justify-content:space-between;align-items:center;font-weight:800;margin-bottom:8px}.gjj-mh3-close{border:1px solid #40717a;border-radius:5px;background:#173038;color:#dff;padding:5px 12px;cursor:pointer}.gjj-mh3-section{border-top:1px solid #29434a;padding-top:8px;margin-top:8px}.gjj-mh3-title{color:#7ed9d3;font-weight:800;margin-bottom:7px}.gjj-mh3-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.gjj-mh3-field{display:grid;gap:3px;color:#9eb8bd}.gjj-mh3-field.wide{grid-column:1/-1}.gjj-mh3-control{box-sizing:border-box;width:100%;min-width:0;background:#0b1316;color:#e8f5f5;border:1px solid #304e55;border-radius:5px;padding:6px}.gjj-mh3-toggle.active{background:#17614e;color:#fff}
	.gjj-mh3-size-tabs,.gjj-mh3-ratios{display:grid;gap:8px}.gjj-mh3-size-tabs{grid-template-columns:repeat(4,1fr);margin:8px 0 14px}.gjj-mh3-ratios{grid-template-columns:repeat(8,minmax(0,1fr));gap:4px;margin-bottom:10px}.gjj-mh3-ratios .gjj-mh3-size-choice{min-width:0;padding:4px 1px;font-size:11px}.gjj-mh3-size-choice{min-height:40px;border:1px solid #415861;border-radius:8px;background:#111b20;color:#dbe6e7;font-weight:800;font-size:14px;cursor:pointer}.gjj-mh3-size-choice.active{border-color:#19d8df;background:#0d8fb0;color:#fff}.gjj-mh3-size-tabs .gjj-mh3-size-choice.active{background:#12964d;border-color:#27dda0}.gjj-mh3-choice-row{display:grid;grid-template-columns:42px repeat(var(--count),1fr);gap:8px;margin:8px 0}.gjj-mh3-choice-icon{display:grid;place-items:center;font-size:20px}.gjj-mh3-slider-row{display:grid;grid-template-columns:62px minmax(0,1fr) 90px;gap:10px;align-items:center;margin:13px 0;color:#c9d7da;font-weight:700}.gjj-mh3-slider-row input[type=range]{width:100%;accent-color:#19b7d0}.gjj-mh3-size-number{width:100%;box-sizing:border-box;border:1px solid #415861;border-radius:7px;background:#111b20;color:#eaf5f6;padding:8px;text-align:center;font-weight:800}.gjj-mh3-size-disabled{opacity:.42}.gjj-mh3-megapixel{display:grid;gap:10px;margin:4px 0 14px}.gjj-mh3-size-result{padding:9px;border:1px solid #31535b;border-radius:7px;background:#091215;color:#8fe1d5;text-align:center;font-weight:900;font-size:15px}.gjj-mh3-preview{position:relative;display:none;width:100%;margin-top:4px;background:#000;border-radius:6px;overflow:hidden}.gjj-mh3-preview video{display:block;width:100%;height:100%;object-fit:contain;background:#000}.gjj-mh3-preview-nav{position:absolute;z-index:3;left:50%;top:7px;transform:translateX(-50%);display:none;align-items:center;gap:5px;padding:3px;border:1px solid rgba(124,194,203,.65);border-radius:7px;background:rgba(5,14,18,.82);box-shadow:0 2px 10px rgba(0,0,0,.38)}.gjj-mh3-preview-nav button{width:25px;height:24px;padding:0;border:1px solid #42636b;border-radius:5px;background:#14262d;color:#eaffff;cursor:pointer;font-weight:900}.gjj-mh3-preview-nav button:disabled{opacity:.35;cursor:default}.gjj-mh3-preview-label{min-width:74px;color:#dff7f7;text-align:center;font:700 11px/1.2 system-ui,sans-serif;white-space:nowrap}`;
	document.head.appendChild(style);
}
function hideBackendWidgets(node) {
	for (const name of HIDDEN) {
		const target = widget(node, name); if (!target) continue;
		GJJ_Utils.hideWidget(target); target.hidden = true; target.computeSize = () => [0, 0]; target.getHeight = () => 0; target.draw = () => {}; target.last_y = 0; target.computedHeight = 0; target.size = [0, 0];
		target.options ||= {}; target.options.hidden = true; target.options.display = "hidden";
		for (const element of [target.element, target.inputEl, target.widget]) if (element?.style) { element.style.display = "none"; element.style.height = "0"; element.style.margin = "0"; element.style.padding = "0"; }
	}
	removeUnusedHiddenInputSockets(node);
}
function removeUnusedHiddenInputSockets(node) {
	if (!Array.isArray(node?.inputs)) return;
	for (let index = node.inputs.length - 1; index >= 0; index--) {
		const input = node.inputs[index];
		const name = String(input?.name || "");
		const type = String(input?.type || "");
		const convertedName = type.startsWith("converted-widget:")
			? type.slice("converted-widget:".length)
			: "";
		if (!HIDDEN.has(name) && !HIDDEN.has(convertedName)) continue;
		const links = Array.isArray(input?.link) ? input.link.filter((item) => item != null) : (input?.link != null ? [input.link] : []);
		// 已连接的转换输入仍属于工作流接口，不能因界面收起而删除。
		if (links.length) continue;
		if (typeof node.removeInput === "function") node.removeInput(index);
		else node.inputs.splice(index, 1);
	}
}
function choices(target) {
	let items = target?.options?.values || target?.options?.items || target?.values;
	if (typeof items === "function") try { items = items(); } catch (_) { items = []; }
	return Array.isArray(items) ? items : [];
}
function declaredChoices(node, name, target = widget(node, name)) {
	const nativeItems = choices(target);
	if (nativeItems.length) return nativeItems;
	const definition = inputDefinition(node, name);
	return Array.isArray(definition?.[0]) ? definition[0] : [];
}
function widgetDefinitionOptions(node, target) {
	const fieldName = String(target?.name || target?.options?.name || "").trim();
	const definition = inputDefinition(node, fieldName); return definition?.[1] && typeof definition[1] === "object" ? definition[1] : {};
}
function looksLikeModelChoice(target) {
	return choices(target).some((item) => /\.(?:safetensors|ckpt|pt|pth|bin|gguf)(?:$|[?#])/i.test(String(item || "")));
}
function inferredModelFolder(fieldName) {
	const key = String(fieldName || "").toLowerCase();
	if (key.includes("vae")) return "vae";
	if (key.includes("clip") || key.includes("text_encoder")) return "text_encoders";
	if (key.includes("lora")) return "loras";
	if (key.includes("control")) return "controlnet";
	return "diffusion_models";
}
function inferredModelIcon(folder) {
	return folder === "vae" ? "🔴" : (folder === "text_encoders" ? "🟡" : (folder === "loras" ? "🟢" : "🟣"));
}
function declaredKeywords(...values) {
	for (const value of values) {
		if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
		if (typeof value === "string" && value.trim()) return value.split(/[\s,，|]+/).map((item) => item.trim()).filter(Boolean);
	}
	return [];
}
function makeControl(node, name) {
	const target = widget(node, name); if (!target) return null;
	let control; const items = declaredChoices(node, name, target);
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
	control.classList.add("gjj-mh3-control"); control.dataset.widgetName = name; applyBoundState(node, name, control); protect(control); return control;
}
function modelTreeEntries(node) {
	return (node.widgets || []).filter((target) => {
		if (String(target?.name || "") === "reasoning_model" && !Boolean(value(node, "reasoning_enabled", false))) return false;
		if (boundVariable(node, String(target?.name || ""))) return false;
		const declared = widgetDefinitionOptions(node, target);
		return Boolean(String(target?.options?.gjj_model_folder || declared?.gjj_model_folder || "").trim()) || looksLikeModelChoice(target);
	}).map((target) => {
		const fieldName = String(target.name || target.options?.name || "").trim();
		const declared = widgetDefinitionOptions(node, target);
		const folder = String(target?.options?.gjj_model_folder || declared?.gjj_model_folder || inferredModelFolder(fieldName)).trim();
		const defaultModel = String(target?.options?.gjj_default_model || declared?.gjj_default_model || target?.options?.default || declared?.default || target?.value || "").trim();
		return {
			widget: fieldName,
			folder,
			icon: String(target.options?.gjj_model_icon || declared?.gjj_model_icon || inferredModelIcon(folder)),
			label: String(target?.options?.display_name || declared?.display_name || target?.label || fieldName),
			models: choices(target),
			keywords: declaredKeywords(target.options?.gjj_model_keywords, declared?.gjj_model_keywords),
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
	tree.style.maxHeight = "min(300px,calc(100vh - 260px))";
	host.replaceChildren(tree);
}
function normalizeLoraRows(raw) {
	let parsed = [];
	try { const value = JSON.parse(String(raw || "[]")); if (Array.isArray(value)) parsed = value; } catch (_) {}
	const rows = parsed.filter((item) => item && typeof item === "object" && String(item.name || "").trim()).map((item) => ({
		name: String(item.name || "").trim(),
		enabled: item.enabled !== false,
		strength: Number.isFinite(Number(item.strength)) ? Number(item.strength) : 1,
	}));
	rows.push({ name: "", enabled: true, strength: 1 });
	return rows;
}
function serializeLoraRows(rows) {
	return JSON.stringify(rows.filter((row) => String(row?.name || "").trim()).map((row) => ({
		enabled: row.enabled !== false,
		name: String(row.name).trim(),
		strength: Number.isFinite(Number(row.strength)) ? Number(row.strength) : 1,
	})));
}
function miniMaxLoraToken(value) {
	return String(value || "").trim().toLocaleLowerCase().split(/[\\/]/).pop()
		.replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, "").replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}
function miniMaxLoraMetadata(metadata, name) {
	const selected = miniMaxLoraToken(name);
	return (metadata || []).find((item) => (Array.isArray(item?.match) ? item.match : []).some((keyword) => {
		const token = miniMaxLoraToken(keyword); return token && (selected.includes(token) || token.includes(selected));
	})) || null;
}
function preferredMiniMaxAccelLora(names) {
	const terms = DEFAULT_LORA_FILTER.toLocaleLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/i).filter(Boolean);
	return [...(names || [])]
		.filter((name) => terms.every((term) => String(name).toLocaleLowerCase().includes(term)))
		.sort((a, b) => Number(String(a).toLocaleLowerCase().includes("converted")) - Number(String(b).toLocaleLowerCase().includes("converted")) || String(a).length - String(b).length)[0] || "";
}
function syncStepsFromAccelLora(node, name) {
	const match = String(name || "").match(/(?:^|[^0-9])(\d+)[_-]?steps?(?:[^a-z0-9]|$)/i);
	if (match) setValue(node, "steps", Math.max(1, Number(match[1])));
}
async function fetchMiniMaxLoras() {
	try {
		const [listResponse, metadataResponse] = await Promise.all([fetch("/gjj/loras"), fetch("/gjj/lora-metadata")]);
		const listPayload = listResponse.ok ? await listResponse.json() : {};
		const metadataPayload = metadataResponse.ok ? await metadataResponse.json() : {};
		return {
			names: Array.isArray(listPayload?.loras) ? listPayload.loras.map(String).filter(Boolean) : [],
			metadata: Array.isArray(metadataPayload?.metadata) ? metadataPayload.metadata : [],
			previews: metadataPayload?.previews && typeof metadataPayload.previews === "object" ? metadataPayload.previews : {},
		};
	} catch (_) { return { names: [], metadata: [], previews: {} }; }
}
function createLoraPanel(node) {
	const section = document.createElement("section"); section.className = "gjj-mh3-section";
	const title = document.createElement("div"); title.className = "gjj-mh3-title"; title.textContent = "🧩 LoRA";
	const filter = document.createElement("input"); filter.className = "gjj-mh3-control"; filter.placeholder = "全局过滤 LoRA";
	node.properties = node.properties || {};
	if (!Object.prototype.hasOwnProperty.call(node.properties, LORA_FILTER_PROPERTY)) node.properties[LORA_FILTER_PROPERTY] = DEFAULT_LORA_FILTER;
	filter.value = String(node.properties[LORA_FILTER_PROPERTY] || "");
	const rowsHost = document.createElement("div"); rowsHost.style.cssText = "display:grid;gap:7px;margin-top:8px";
	let catalog = { names: [], metadata: [], previews: {} };
	let rows = normalizeLoraRows(value(node, LORA_DATA_WIDGET, "[]"));
	const save = () => setValue(node, LORA_DATA_WIDGET, serializeLoraRows(rows));
	const render = () => {
		rows = normalizeLoraRows(serializeLoraRows(rows));
		rowsHost.replaceChildren();
		const keyword = String(filter.value || "").trim().toLocaleLowerCase();
		const filterTerms = keyword.split(/[^a-z0-9\u4e00-\u9fff]+/i).filter(Boolean);
		rows.forEach((row, index) => {
			const metadata = miniMaxLoraMetadata(catalog.metadata, row.name);
			const preview = String(catalog.previews?.[row.name] || "");
			const selectedByOtherRows = new Set(rows
				.filter((_item, rowIndex) => rowIndex !== index)
				.map((item) => String(item?.name || "").trim())
				.filter(Boolean));
			const line = document.createElement("div"); line.style.cssText = `display:grid;grid-template-columns:${row.name && preview ? "58px " : ""}minmax(0,1fr) auto 72px;gap:7px;align-items:center;padding:7px;border:1px solid #304e55;border-radius:8px;background:#111d21`;
			if (row.name && preview) {
				const thumb = document.createElement("img"); thumb.src = preview; thumb.alt = metadata?.title || row.name; thumb.title = metadata?.summary || metadata?.title || row.name;
				thumb.style.cssText = "width:58px;height:58px;object-fit:cover;border:1px solid #3c5660;border-radius:7px;background:#081014;cursor:zoom-in";
				thumb.addEventListener("click", () => window.open(preview, "_blank", "noopener,noreferrer")); protect(thumb); line.appendChild(thumb);
			}
			const available = catalog.names.filter((name) => {
				if (selectedByOtherRows.has(String(name || "").trim())) return false;
				const item = miniMaxLoraMetadata(catalog.metadata, name);
				const haystack = [name, item?.title, item?.trigger, item?.summary, ...(Array.isArray(item?.match) ? item.match : [])].filter(Boolean).join(" ").toLocaleLowerCase();
				return !filterTerms.length || filterTerms.every((term) => haystack.includes(term));
			});
			const names = row.name && !available.includes(row.name) ? [row.name, ...available] : available;
			const main = document.createElement("div"); main.style.cssText = "position:relative;display:grid;gap:5px;min-width:0";
			const selectButton = document.createElement("button"); selectButton.type = "button"; selectButton.className = "gjj-mh3-control";
			selectButton.textContent = row.name || "未选择"; selectButton.title = row.name || "点击选择 LoRA"; selectButton.style.textAlign = "left";
			selectButton.addEventListener("click", () => {
				const existingPicker = main.querySelector(".gjj-mh3-lora-picker");
				if (existingPicker) { existingPicker.remove(); return; }
				const picker = document.createElement("div"); picker.className = "gjj-mh3-lora-picker";
				const anchor = selectButton.getBoundingClientRect();
				const pickerWidth = Math.max(280, Math.min(820, window.innerWidth - 32));
				const pickerLeft = Math.max(16, Math.min(anchor.left, window.innerWidth - pickerWidth - 16));
				picker.style.cssText = `position:fixed;z-index:100006;left:${pickerLeft}px;top:${Math.max(16, Math.min(anchor.bottom + 3, window.innerHeight - 310))}px;width:${pickerWidth}px;display:grid;gap:5px;padding:7px;box-sizing:border-box;border:1px solid #4e7d86;border-radius:8px;background:#101a1e;box-shadow:0 12px 32px #000b`;
				const localFilter = document.createElement("input"); localFilter.type = "text"; localFilter.className = "gjj-mh3-control";
				localFilter.placeholder = "二次过滤当前 LoRA 列表";
				const optionHost = document.createElement("div"); optionHost.style.cssText = "display:grid;gap:3px;max-height:240px;overflow:auto";
				const renderOptions = () => {
					const terms = String(localFilter.value || "").toLocaleLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/i).filter(Boolean);
					const filteredNames = names.filter((name) => {
						const item = miniMaxLoraMetadata(catalog.metadata, name);
						const haystack = [name, item?.title, item?.trigger, item?.summary, ...(Array.isArray(item?.match) ? item.match : [])].filter(Boolean).join(" ").toLocaleLowerCase();
						return !terms.length || terms.every((term) => haystack.includes(term));
					});
					optionHost.replaceChildren();
					const options = ["", ...filteredNames];
					for (const name of options) {
						const option = document.createElement("button"); option.type = "button"; option.className = "gjj-mh3-control";
						option.textContent = `${name === row.name ? "✓ " : ""}${name || "未选择"}`; option.title = name || "清除当前 LoRA"; option.style.cssText += ";text-align:left;white-space:normal;overflow-wrap:anywhere";
						option.addEventListener("click", () => { rows[index].name = name; syncStepsFromAccelLora(node, name); save(); render(); });
						protect(option); optionHost.appendChild(option);
					}
					if (!filteredNames.length && terms.length) {
						const empty = document.createElement("div"); empty.textContent = "没有匹配的 LoRA"; empty.style.cssText = "padding:7px;color:#c58f93"; optionHost.appendChild(empty);
					}
				};
				localFilter.addEventListener("input", renderOptions);
				localFilter.addEventListener("keydown", (event) => { if (event.key === "Escape") picker.remove(); });
				protect(localFilter); protect(picker); picker.append(localFilter, optionHost); main.appendChild(picker); renderOptions();
				setTimeout(() => localFilter.focus(), 0);
			});
			protect(selectButton); main.appendChild(selectButton);
			if (row.name && metadata) {
				const meta = document.createElement("div"); meta.style.cssText = "display:flex;align-items:center;gap:7px;min-width:0;color:#a9c5c8;font-size:11px";
				const text = document.createElement("span"); text.textContent = [metadata.title, metadata.trigger, metadata.strength != null ? `建议 ${metadata.strength}` : ""].filter(Boolean).join("　"); text.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"; meta.appendChild(text);
				const source = String(metadata.source || "").trim();
				try {
					const url = new URL(source);
					if (url.protocol === "https:") {
						const link = document.createElement("button"); link.type = "button"; link.textContent = "🌐"; link.title = `打开 LoRA 网页：${url.href}`; link.style.cssText = "flex:0 0 26px;width:26px;height:23px;padding:0;border:1px solid #41535b;border-radius:6px;background:#17242a;color:#dce7e2;cursor:pointer";
						link.addEventListener("click", () => window.open(url.href, "_blank", "noopener,noreferrer")); protect(link); meta.appendChild(link);
					}
				} catch (_) {}
				main.appendChild(meta);
			}
			const toggleLabel = document.createElement("label"); toggleLabel.style.cssText = "display:flex;align-items:center;gap:4px;white-space:nowrap";
			const toggle = document.createElement("input"); toggle.type = "checkbox"; toggle.checked = row.enabled !== false; toggleLabel.append(toggle, document.createTextNode("启用"));
			const strength = document.createElement("input"); strength.type = "number"; strength.className = "gjj-mh3-control"; strength.min = "-10"; strength.max = "10"; strength.step = "0.05"; strength.value = String(row.strength);
			toggle.addEventListener("change", () => { rows[index].enabled = toggle.checked; save(); });
			strength.addEventListener("change", () => { rows[index].strength = Number(strength.value) || 0; save(); });
			for (const control of [toggle, strength]) protect(control);
			line.append(main, toggleLabel, strength); rowsHost.appendChild(line);
		});
		save();
	};
	filter.addEventListener("input", () => { node.properties[LORA_FILTER_PROPERTY] = filter.value; render(); });
	protect(filter);
	section.append(title, filter, rowsHost);
	section.__gjjRefresh = async () => {
		catalog = await fetchMiniMaxLoras();
		rows = normalizeLoraRows(value(node, LORA_DATA_WIDGET, "[]"));
		if (!rows.some((row) => row.name)) {
			const defaultName = preferredMiniMaxAccelLora(catalog.names);
			if (defaultName) { rows = [{ name: defaultName, enabled: true, strength: 1 }, { name: "", enabled: true, strength: 1 }]; syncStepsFromAccelLora(node, defaultName); }
		}
		render();
	};
	section.__gjjRefresh();
	return section;
}
function createReasoningPanel(node, treeHost) {
	const section = document.createElement("section"); section.className = "gjj-mh3-section";
	const title = document.createElement("div"); title.className = "gjj-mh3-title"; title.textContent = "🧠 可选推理";
	const buttonRow = document.createElement("div"); buttonRow.style.cssText = "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px";
	const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "gjj-mh3-control gjj-mh3-toggle"; protect(toggle);
	const keep = document.createElement("button"); keep.type = "button"; keep.className = "gjj-mh3-control gjj-mh3-toggle"; keep.textContent = "保持模型"; protect(keep);
	const cacheClip = document.createElement("button"); cacheClip.type = "button"; cacheClip.className = "gjj-mh3-control gjj-mh3-toggle"; cacheClip.textContent = "缓存CLIP"; protect(cacheClip);
	const details = document.createElement("div"); details.className = "gjj-mh3-grid"; details.style.marginTop = "8px";
	const promptRow = document.createElement("label"); promptRow.className = "gjj-mh3-field wide";
	const promptLabel = document.createElement("span"); promptLabel.textContent = "推理系统提示词";
	const prompt = document.createElement("textarea"); prompt.className = "gjj-mh3-control"; prompt.rows = 7; prompt.value = String(value(node, "reasoning_system_prompt", "")); protect(prompt);
	prompt.addEventListener("input", () => setValue(node, "reasoning_system_prompt", prompt.value));
	promptRow.append(promptLabel, prompt); details.appendChild(promptRow);
	const sync = () => {
		const enabled = Boolean(value(node, "reasoning_enabled", false));
		toggle.textContent = "开启推理"; toggle.classList.toggle("active", enabled);
		keep.classList.toggle("active", Boolean(value(node, "keep_model", false)));
		cacheClip.classList.toggle("active", Boolean(value(node, "cache_clip", false)));
		details.style.display = enabled ? "grid" : "none";
		if (enabled && document.activeElement !== prompt) prompt.value = String(value(node, "reasoning_system_prompt", ""));
		applyBoundState(node, "reasoning_enabled", toggle); applyBoundState(node, "keep_model", keep); applyBoundState(node, "cache_clip", cacheClip); applyBoundState(node, "reasoning_system_prompt", prompt);
	};
	toggle.addEventListener("click", () => { setValue(node, "reasoning_enabled", !Boolean(value(node, "reasoning_enabled", false))); sync(); renderModelTree(node, treeHost); });
	keep.addEventListener("click", () => { setValue(node, "keep_model", !Boolean(value(node, "keep_model", false))); sync(); });
	cacheClip.addEventListener("click", () => { setValue(node, "cache_clip", !Boolean(value(node, "cache_clip", false))); sync(); });
	buttonRow.append(toggle, keep, cacheClip); section.append(title, buttonRow, details); section.__gjjSync = sync; sync(); return section;
}
function createModelPatchPanel(node) {
	const section = document.createElement("section"); section.className = "gjj-mh3-section";
	const title = document.createElement("div"); title.className = "gjj-mh3-title"; title.textContent = "⚡ 模型优化";
	const buttons = document.createElement("div"); buttons.style.cssText = "display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:5px";
	const booleanFields = [
		["patch_enable_sage_attention", "Sage"],
		["patch_allow_sage_compile", "Sage编译"],
		["patch_enable_fp16_accumulation", "FP16设置"],
		["patch_fp16_accumulation", "FP16累积"],
	];
	const syncButtons = () => {
		for (const button of buttons.children) button.classList.toggle("active", Boolean(value(node, button.dataset.widgetName, false)));
	};
	for (const [name, label] of booleanFields) {
		const button = document.createElement("button"); button.type = "button"; button.className = "gjj-mh3-control gjj-mh3-toggle"; button.textContent = label; button.dataset.widgetName = name;
		button.addEventListener("click", () => { setValue(node, name, !Boolean(value(node, name, false))); syncButtons(); });
		applyBoundState(node, name, button); protect(button); buttons.appendChild(button);
	}
	const modes = document.createElement("div"); modes.className = "gjj-mh3-grid"; modes.style.marginTop = "6px";
	for (const name of ["patch_sage_attention_mode", "patch_missing_sage_handling"]) {
		const control = makeControl(node, name); if (!control) continue;
		const row = document.createElement("label"); row.className = "gjj-mh3-field";
		const label = document.createElement("span"); label.textContent = name === "patch_sage_attention_mode" ? "Sage 模式" : "缺失处理";
		row.append(label, control); modes.appendChild(row);
	}
	section.append(title, buttons, modes); section.__gjjSync = syncButtons; syncButtons(); return section;
}
const SPECTRUM_FIELDS = [
	"spectrum_enabled", "spectrum_blend_weight", "spectrum_degree", "spectrum_ridge_lambda",
	"spectrum_window_size", "spectrum_flex_window", "spectrum_warmup_steps",
	"spectrum_tail_actual_steps", "spectrum_max_history", "spectrum_debug", "spectrum_history_storage",
];
function syncSpectrumButton(node) {
	const button = node.__gjjMiniMaxPanel?.spectrumButton; if (!button) return;
	const enabled = Boolean(value(node, "spectrum_enabled", false));
	button.classList.toggle("enabled", enabled);
	button.title = enabled ? "Spectrum MiniMax H3 加速已启用；点击设置参数" : "Spectrum MiniMax H3 加速未启用；点击设置参数";
}
function createSpectrumPanel(node) {
	const section = document.createElement("section"); section.className = "gjj-mh3-section";
	const title = document.createElement("div"); title.className = "gjj-mh3-title"; title.textContent = "🚀 Spectrum MiniMax H3 加速";
	const grid = document.createElement("div"); grid.className = "gjj-mh3-grid";
	for (const name of SPECTRUM_FIELDS) {
		const control = makeControl(node, name); if (!control) continue;
		if (name === "spectrum_enabled") control.addEventListener("click", () => syncSpectrumButton(node));
		const row = document.createElement("label"); row.className = "gjj-mh3-field";
		if (["spectrum_enabled", "spectrum_history_storage"].includes(name)) row.classList.add("wide");
		const label = document.createElement("span"); label.textContent = widget(node, name)?.options?.display_name || widget(node, name)?.label || name;
		row.append(label, control); grid.appendChild(row);
	}
	const note = document.createElement("div"); note.className = "gjj-mh3-field wide"; note.style.color = "#8faeb4";
	note.textContent = "🚀 亮起表示采样模型会应用 GJJ_SpectrumApplyMiniMaxH3。最大历史数量必须不少于多项式阶数 + 1。";
	grid.appendChild(note); section.append(title, grid); section.__gjjSync = () => syncSpectrumButton(node); return section;
}
function createSizePanel(node) {
	const host = document.createElement("div");
	const tabs = document.createElement("div"); tabs.className = "gjj-mh3-size-tabs";
	const sourceButton = document.createElement("button"); sourceButton.type = "button"; sourceButton.className = "gjj-mh3-size-choice"; sourceButton.textContent = "首图尺寸";
	const videoButton = document.createElement("button"); videoButton.type = "button"; videoButton.className = "gjj-mh3-size-choice"; videoButton.textContent = "视频尺寸";
	const panelButton = document.createElement("button"); panelButton.type = "button"; panelButton.className = "gjj-mh3-size-choice"; panelButton.textContent = "画板尺寸";
	const megapixelButton = document.createElement("button"); megapixelButton.type = "button"; megapixelButton.className = "gjj-mh3-size-choice"; megapixelButton.textContent = "百万像素";
	tabs.append(sourceButton, videoButton, panelButton, megapixelButton);
	const choiceControls = new Map();
	const makeChoiceRow = (name, icon, values) => {
		const row = document.createElement("div"); row.className = "gjj-mh3-choice-row"; row.style.setProperty("--count", String(values.length));
		const iconCell = document.createElement("span"); iconCell.className = "gjj-mh3-choice-icon"; iconCell.textContent = icon; row.appendChild(iconCell);
		const buttons = values.map((item) => { const button = document.createElement("button"); button.type = "button"; button.className = "gjj-mh3-size-choice"; button.textContent = item; button.addEventListener("click", () => { setValue(node, name, item); sync(); }); row.appendChild(button); return button; });
		choiceControls.set(name, { values, buttons }); return row;
	};
	const fitRow = makeChoiceRow("resize_fit_mode", "🧲", ["拉伸", "补边", "留边", "裁剪"]);
	const anchorRow = makeChoiceRow("resize_anchor", "📍", ["上", "下", "左", "右", "中"]);
	const dimensions = document.createElement("div");
	const megapixelPanel = document.createElement("div"); megapixelPanel.className = "gjj-mh3-megapixel";
	const ratioRow = document.createElement("div"); ratioRow.className = "gjj-mh3-ratios";
	const ratios = ["21:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"];
	const ratioButtons = ratios.map((ratio) => { const button = document.createElement("button"); button.type = "button"; button.className = "gjj-mh3-size-choice"; button.textContent = ratio; button.addEventListener("click", () => { setValue(node, "megapixel_aspect", ratio); sync(); }); ratioRow.appendChild(button); return button; });
	const mpRow = document.createElement("label"); mpRow.className = "gjj-mh3-slider-row";
	const mpCaption = document.createElement("span"); mpCaption.textContent = "📐 MP";
	const mpRange = document.createElement("input"); mpRange.type = "range"; mpRange.min = "0.2"; mpRange.max = "2.0"; mpRange.step = "0.1";
	const mpNumber = document.createElement("input"); mpNumber.type = "number"; mpNumber.className = "gjj-mh3-size-number"; mpNumber.min = mpRange.min; mpNumber.max = mpRange.max; mpNumber.step = mpRange.step;
	const sizeResult = document.createElement("div"); sizeResult.className = "gjj-mh3-size-result";
	mpRow.append(mpCaption, mpRange, mpNumber); megapixelPanel.append(ratioRow, mpRow, sizeResult);
	const controls = {};
	for (const [name, icon, label] of [["width", "📐", "宽度"], ["height", "📏", "高度"]]) {
		const target = widget(node, name); const row = document.createElement("label"); row.className = "gjj-mh3-slider-row";
		const caption = document.createElement("span"); caption.textContent = `${icon} ${label}`;
		const range = document.createElement("input"); range.type = "range"; range.min = String(SIZE_MIN); range.max = String(SIZE_MAX); range.step = String(SIZE_STEP);
		const number = document.createElement("input"); number.type = "number"; number.className = "gjj-mh3-size-number"; number.min = range.min; number.max = range.max; number.step = range.step;
		const apply = (raw) => { const next = normalizeCanvasDimension(raw, name === "width" ? 864 : 480); setValue(node, name, next); range.value = String(next); number.value = String(next); sync(); };
		range.addEventListener("input", () => apply(range.value)); number.addEventListener("change", () => apply(number.value)); row.append(caption, range, number); dimensions.appendChild(row); controls[name] = { range, number };
	}
	const sync = () => {
		const video = Boolean(value(node, "use_video_size", false));
		const source = Boolean(value(node, "use_source_size", true)) && !video;
		const megapixelMode = !source && !video && String(value(node, "size_mode", "宽高")) === "百万像素";
		sourceButton.classList.toggle("active", source); videoButton.classList.toggle("active", video); panelButton.classList.toggle("active", !source && !video && !megapixelMode); megapixelButton.classList.toggle("active", megapixelMode); dimensions.style.display = source || video || megapixelMode ? "none" : ""; megapixelPanel.style.display = megapixelMode ? "" : "none";
		syncMainSizeButton(node);
		const sourceBound = Boolean(boundVariable(node, "use_source_size")); const videoBound = Boolean(boundVariable(node, "use_video_size"));
		sourceButton.disabled = sourceBound; videoButton.disabled = videoBound; panelButton.disabled = sourceBound || videoBound; megapixelButton.disabled = sourceBound || videoBound;
		sourceButton.title = sourceBound ? `首图尺寸已由广播变量“${boundVariable(node, "use_source_size")}”接管` : ""; videoButton.title = videoBound ? `视频尺寸已由广播变量“${boundVariable(node, "use_video_size")}”接管` : "";
		for (const [name, control] of Object.entries(controls)) { const bound = Boolean(boundVariable(node, name)); control.range.disabled = source || video || bound; control.number.disabled = source || video || bound; const tip = bound ? `已由广播变量“${boundVariable(node, name)}”接管` : ""; control.range.title = control.number.title = tip; }
		for (const [name, group] of choiceControls) group.buttons.forEach((button, index) => { const variableName = boundVariable(node, name); button.classList.toggle("active", String(value(node, name, group.values[0])) === group.values[index]); button.disabled = Boolean(variableName); button.style.opacity = variableName ? "0.45" : ""; button.title = variableName ? `已由广播变量“${variableName}”接管` : ""; });
		for (const [name, fallback] of [["width", 864], ["height", 480]]) { const next = normalizeCanvasDimension(value(node, name, fallback), fallback); if (Number(value(node, name, fallback)) !== next) setValue(node, name, next); controls[name].range.value = controls[name].number.value = String(next); }
		const aspect = String(value(node, "megapixel_aspect", "16:9")); ratioButtons.forEach((button, index) => button.classList.toggle("active", ratios[index] === aspect));
		const mp = Math.max(0.2, Math.min(2, Number(value(node, "megapixels", 0.4)) || 0.4)); mpRange.value = mpNumber.value = String(mp);
		const [rw, rh] = aspect.split(":").map(Number); const total = mp * 1024 * 1024; const outputWidth = Math.round(Math.sqrt(total * rw / rh) / 32) * 32; const outputHeight = Math.round(Math.sqrt(total * rh / rw) / 32) * 32; sizeResult.textContent = `实际尺寸：${outputWidth} × ${outputHeight}`;
	};
	const applyMegapixels = (raw) => { const next = Math.round(Math.max(0.2, Math.min(2, Number(raw) || 0.4)) * 10) / 10; setValue(node, "megapixels", next); sync(); };
	mpRange.addEventListener("input", () => applyMegapixels(mpRange.value)); mpNumber.addEventListener("change", () => applyMegapixels(mpNumber.value));
	sourceButton.addEventListener("click", () => { setValue(node, "use_video_size", false); setValue(node, "use_source_size", true); sync(); });
	videoButton.addEventListener("click", () => { setValue(node, "use_source_size", false); setValue(node, "use_video_size", true); sync(); });
	panelButton.addEventListener("click", () => { setValue(node, "use_source_size", false); setValue(node, "use_video_size", false); setValue(node, "size_mode", "宽高"); sync(); });
	megapixelButton.addEventListener("click", () => { setValue(node, "use_source_size", false); setValue(node, "use_video_size", false); setValue(node, "size_mode", "百万像素"); sync(); });
	for (const element of [sourceButton, videoButton, panelButton, megapixelButton, ...ratioButtons, mpRange, mpNumber, ...Array.from(choiceControls.values()).flatMap((item) => item.buttons), ...Object.values(controls).flatMap((item) => [item.range, item.number])]) protect(element);
	host.append(tabs, fitRow, anchorRow, dimensions, megapixelPanel); host.__gjjSync = sync; sync(); return host;
}
function readDirectorPlan(node) {
	let saved = {};
	try { saved = JSON.parse(String(value(node, "director_storyboard_json", "{}") || "{}")); } catch (_) {}
	const fps = Math.max(1, Number(value(node, "frame_rate", 24)) || 24);
	const totalFrames = Math.max(5, Math.round((Number(value(node, "duration", 5)) || 5) * fps));
	const prompt = String(value(node, "prompt", "") || "");
	const scenes = Array.isArray(saved?.scenes) && saved.scenes.length ? saved.scenes : [{ start_frame: 1, end_frame: totalFrames, prompt: "" }];
	return {
		configured: Boolean(saved?.configured),
		enabled: Boolean(saved?.enabled),
		fps,
		total_frames: Math.max(totalFrames, Number(saved?.total_frames || 0)),
		scenes: scenes.map((scene, index) => ({
			index: index + 1,
			start_frame: Math.max(1, Math.round(Number(scene?.start_frame || 1))),
			end_frame: Math.max(1, Math.round(Number(scene?.end_frame || totalFrames))),
			prompt: String(scene?.prompt ?? ""),
			actors: Array.isArray(scene?.actors) ? scene.actors : [],
			scenes: Array.isArray(scene?.scenes) ? scene.scenes : [],
			media: Array.isArray(scene?.media) ? scene.media : [],
		})),
	};
}
function saveDirectorPlan(node, plan) {
	plan.scenes.sort((a, b) => Number(a.start_frame) - Number(b.start_frame));
	plan.scenes.forEach((scene, index) => { scene.index = index + 1; });
	setValue(node, "director_storyboard_json", JSON.stringify({ ...plan, configured: true }));
	const button = node.__gjjMiniMaxPanel?.buttons?.director;
	button?.classList.toggle("active", Boolean(plan.enabled));
}
function panelPromptForDirectorScene(node, sceneIndex) {
	const prompt = String(value(node, "prompt", "") || "");
	if (!prompt.includes("---")) return prompt.trim();
	const parts = prompt.split("---").map((part) => part.trim()).filter(Boolean);
	return parts.length ? parts[Math.min(Math.max(0, sceneIndex), parts.length - 1)] : "";
}
function syncDirectorButton(node) {
	const button = node.__gjjMiniMaxPanel?.buttons?.director;
	if (!button) return;
	let configured = false; let enabled = false;
	try { const saved = JSON.parse(String(value(node, "director_storyboard_json", "{}") || "{}")); configured = Boolean(saved?.configured); enabled = Boolean(saved?.enabled); } catch (_) {}
	button.classList.toggle("active", enabled);
	button.title = enabled ? "导演台：已启用" : (configured ? "导演台：已设置但未启用" : "导演台：未启用");
}
function createDirectorPanel(node) {
	const host = document.createElement("div");
	const plan = readDirectorPlan(node);
	let playhead = 1;
	let viewStart = 1;
	let viewEnd = plan.total_frames;
	let selectedScene = 0;
	let draggedActorIndex = -1;
	let draggedMedia = null;
	let playheadLines = [];
	let playheadBadges = [];
	const preview = document.createElement("video"); preview.controls = true; preview.playsInline = true; preview.preload = "metadata"; preview.style.cssText = "display:block;width:100%;height:260px;object-fit:contain;background:#05090b;border:1px solid #304e55;border-radius:7px;margin-bottom:8px";
	const tools = document.createElement("div"); tools.style.cssText = "display:grid;grid-template-columns:auto auto auto 110px auto auto auto auto 1fr;gap:6px;align-items:center;margin-bottom:8px";
	const openMedia = document.createElement("button"); openMedia.className = "gjj-mh3-close"; openMedia.textContent = "📁"; openMedia.title = "向当前时间线片段添加视频、图片或文字";
	const enable = document.createElement("button"); enable.className = "gjj-mh3-close";
	const mediaInput = document.createElement("input"); mediaInput.type = "file"; mediaInput.multiple = true; mediaInput.accept = "video/*,image/*,text/plain,.txt,.md,.prompt"; mediaInput.style.display = "none";
	const auto = document.createElement("button"); auto.className = "gjj-mh3-close"; auto.textContent = "自动分段";
	const snap = document.createElement("button"); snap.className = "gjj-mh3-close"; snap.textContent = "🧲"; snap.title = "把切点吸附到合法的 17n+5 分段边界";
	const segmentFrames = document.createElement("input"); segmentFrames.type = "number"; segmentFrames.min = "5"; segmentFrames.readOnly = true; segmentFrames.className = "gjj-mh3-control"; segmentFrames.title = "按时长和帧率自动计算的 17n+5 分段帧数";
	const fit = document.createElement("button"); fit.className = "gjj-mh3-close"; fit.textContent = "适配";
	const zoomOut = document.createElement("button"); zoomOut.className = "gjj-mh3-close"; zoomOut.textContent = "－";
	const zoomIn = document.createElement("button"); zoomIn.className = "gjj-mh3-close"; zoomIn.textContent = "＋";
	const reset = document.createElement("button"); reset.className = "gjj-mh3-close"; reset.textContent = "清空";
	const info = document.createElement("span"); info.style.cssText = "text-align:right;color:#8fb0b7";
	tools.append(enable, openMedia, auto, snap, segmentFrames, fit, zoomOut, zoomIn, reset, info);
	const promptPreview = document.createElement("div"); promptPreview.title = "双击编辑当前片段提示词"; promptPreview.style.cssText = "min-height:34px;max-height:92px;overflow:auto;margin-bottom:7px;padding:7px;border:1px solid #31535b;border-radius:6px;background:#0b1519;color:#e7f5f5;white-space:pre-wrap;cursor:text";
	const timeline = document.createElement("div"); timeline.style.cssText = "position:relative;height:112px;border:1px solid #304e55;border-radius:7px;background:#091215;overflow:hidden;cursor:crosshair;user-select:none";
	const audioTrack = document.createElement("div"); audioTrack.style.cssText = "position:relative;height:38px;margin-top:6px;border:1px solid #315b58;border-radius:6px;background:#102c2a;overflow:hidden;cursor:ew-resize;user-select:none";
	const refsHeader = document.createElement("div"); refsHeader.style.cssText = "display:flex;gap:6px;align-items:center;margin-top:9px";
	const refsTitle = document.createElement("strong"); refsTitle.style.marginRight = "auto";
	const actorRef = document.createElement("button"); actorRef.className = "gjj-mh3-close"; actorRef.textContent = "👤 角色";
	const sceneRef = document.createElement("button"); sceneRef.className = "gjj-mh3-close"; sceneRef.textContent = "🏕️ 场景";
	const reuseRefs = document.createElement("button"); reuseRefs.className = "gjj-mh3-close"; reuseRefs.textContent = "全局复用";
	const clearRefs = document.createElement("button"); clearRefs.className = "gjj-mh3-close"; clearRefs.textContent = "清空";
	refsHeader.append(refsTitle, actorRef, sceneRef, reuseRefs, clearRefs);
	const refsGrid = document.createElement("div"); refsGrid.style.cssText = "display:flex;gap:8px;min-height:82px;margin-top:6px;padding:8px;border:1px solid #304e55;border-radius:7px;background:#091215;overflow:auto;align-items:flex-start";
	const clamp = (number, min, max) => Math.max(min, Math.min(max, number));
	const videoItem = () => internalMediaItems(node).find((item) => String(item?.media_type || "").toLowerCase() === "video");
	const syncEnabled = () => { enable.textContent = plan.enabled ? "启用：开" : "启用：关"; enable.classList.toggle("active", Boolean(plan.enabled)); enable.style.background = plan.enabled ? "#17614e" : "#173038"; enable.style.borderColor = plan.enabled ? "#55d2a2" : "#40717a"; enable.title = plan.enabled ? "导演台已启用，执行时使用时间线分镜" : "导演台已关闭，执行时使用主面板参数"; };
	const syncPreview = () => {
		const item = videoItem(); const source = item ? internalMediaUrl(item) : "";
		if (source && preview.getAttribute("src") !== source) { preview.src = source; preview.load?.(); }
		if (!source) preview.removeAttribute("src");
	};
	const movePlayhead = () => {
		const nearbyBoundary = plan.scenes.find((scene, index) =>
			index < plan.scenes.length - 1
			&& scene.end_frame === plan.scenes[index + 1].start_frame
			&& Math.abs(scene.end_frame - playhead) <= 1
		);
		if (nearbyBoundary) playhead = nearbyBoundary.end_frame;
		const span = Math.max(1, viewEnd - viewStart + 1);
		const left = `${clamp(((playhead - viewStart) / span) * 100, 0, 100)}%`;
		for (const line of playheadLines) line.style.left = left;
		const atBoundary = plan.scenes.some((scene, index) =>
			index < plan.scenes.length - 1
			&& scene.end_frame === playhead
			&& plan.scenes[index + 1].start_frame === playhead
		);
		for (const badge of playheadBadges) {
			badge.textContent = atBoundary ? "🈴" : "✂️";
			badge.title = atBoundary ? "点击合并切点两侧片段" : "点击在当前位置切割";
			badge.style.borderColor = atBoundary ? "#52e09a" : "#d76cff";
		}
		info.textContent = `${plan.total_frames} 帧 @ ${Number(plan.fps).toLocaleString()} FPS · 播放头 ${playhead}`;
	};
	const normalize = () => {
		plan.scenes.sort((a, b) => a.start_frame - b.start_frame);
		let previousEnd = 1;
		for (const [index, scene] of plan.scenes.entries()) {
			scene.start_frame = index === 0 ? 1 : previousEnd;
			scene.end_frame = clamp(Math.max(scene.start_frame, Math.round(Number(scene.end_frame || scene.start_frame))), scene.start_frame, plan.total_frames);
			previousEnd = scene.end_frame;
		}
		if (plan.scenes.length) plan.scenes[plan.scenes.length - 1].end_frame = plan.total_frames;
		plan.scenes = plan.scenes.filter((scene) => scene.start_frame <= plan.total_frames);
	};
	const boundaryIndex = () => plan.scenes.findIndex((scene, index) => index < plan.scenes.length - 1 && scene.end_frame === playhead && plan.scenes[index + 1].start_frame === playhead);
	const splitAtPlayhead = () => {
		const index = plan.scenes.findIndex((scene) => playhead > scene.start_frame && playhead < scene.end_frame);
		if (index < 0 || boundaryIndex() >= 0) return;
		const scene = plan.scenes[index]; const oldEnd = scene.end_frame; scene.end_frame = playhead;
		plan.scenes.splice(index + 1, 0, { start_frame: playhead, end_frame: oldEnd, prompt: scene.prompt, actors: [...(scene.actors || [])], scenes: [...(scene.scenes || [])], media: [...(scene.media || [])] });
		selectedScene = index + 1; render();
	};
	const mergeAtBoundary = () => {
		const index = boundaryIndex();
		if (index < 0) return;
		const current = plan.scenes[index]; const next = plan.scenes[index + 1];
		current.end_frame = next.end_frame;
		if (String(next.prompt || "").trim() && String(next.prompt || "").trim() !== String(current.prompt || "").trim()) current.prompt = `${String(current.prompt || "").trim()}\n${String(next.prompt || "").trim()}`.trim();
		for (const key of ["actors", "scenes"]) {
			const merged = [...(current[key] || []), ...(next[key] || [])]; const seen = new Set();
			current[key] = merged.filter((item) => { const id = String(item?.id || item?.name); if (seen.has(id)) return false; seen.add(id); return true; });
		}
		current.media = [...(current.media || []), ...(next.media || [])].filter((item, itemIndex, all) => all.findIndex((entry) => String(entry?.filename) === String(item?.filename)) === itemIndex);
		plan.scenes.splice(index + 1, 1); selectedScene = index; render();
	};
	const playheadAction = () => boundaryIndex() >= 0 ? mergeAtBoundary() : splitAtPlayhead();
	const appendPlayhead = (track, top) => {
		const span = Math.max(1, viewEnd - viewStart + 1);
		const line = document.createElement("div"); line.style.cssText = `position:absolute;z-index:8;top:0;bottom:0;width:2px;background:#ffd45c;left:${clamp(((playhead - viewStart) / span) * 100, 0, 100)}%`;
		const badge = document.createElement("button"); badge.type = "button"; badge.style.cssText = `position:absolute;left:50%;${top ? "top:0" : "bottom:0"};transform:translate(-50%,${top ? "-1px" : "1px"});font-size:14px;line-height:18px;background:#14352d;border:1px solid #d76cff;border-radius:4px;padding:0 2px;cursor:pointer;pointer-events:auto`;
		badge.addEventListener("pointerdown", (event) => event.stopPropagation());
		badge.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); playheadAction(); });
		line.appendChild(badge); track.appendChild(line); playheadLines.push(line); playheadBadges.push(badge);
	};
	const render = () => {
		normalize();
		syncEnabled();
		segmentFrames.value = String(alignedSegmentFrames());
		timeline.replaceChildren();
		audioTrack.replaceChildren();
		playheadLines = []; playheadBadges = [];
		const span = Math.max(1, viewEnd - viewStart + 1);
		for (const [index, scene] of plan.scenes.entries()) {
			const start = Math.max(scene.start_frame, viewStart); const end = Math.min(scene.end_frame, viewEnd);
			if (end < start) continue;
			const block = document.createElement("div");
			block.style.cssText = `position:absolute;top:10px;bottom:10px;left:${((start - viewStart) / span) * 100}%;width:${Math.max(.7, ((end - start + 1) / span) * 100)}%;border:${index === selectedScene ? "2px solid #ffd45c" : "1px solid #55bcd0"};background:${index % 2 ? "#183c49" : "#174b43"};color:#e8ffff;box-sizing:border-box;overflow:hidden`;
			const sceneImage = (scene.media || []).find((item) => String(item?.media_type || "").toLowerCase() === "image");
			const sceneText = (scene.media || []).find((item) => String(item?.media_type || "").toLowerCase() === "text");
			const source = preview.getAttribute("src");
			if (sceneImage) {
				const thumbnail = document.createElement("img"); thumbnail.src = internalMediaUrl(sceneImage);
				thumbnail.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.82;pointer-events:none";
				block.appendChild(thumbnail);
			} else if (source) {
				const thumbnail = document.createElement("video");
				thumbnail.muted = true; thumbnail.playsInline = true; thumbnail.preload = "metadata"; thumbnail.src = source;
				thumbnail.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.82;pointer-events:none";
				thumbnail.addEventListener("loadedmetadata", () => {
					const target = clamp((((scene.start_frame + scene.end_frame) / 2) - 1) / plan.fps, 0, Math.max(0, Number(thumbnail.duration || 0) - .05));
					if (Number.isFinite(target)) thumbnail.currentTime = target;
				}, { once: true });
				block.appendChild(thumbnail);
			}
			if (sceneText) { const textBadge = document.createElement("span"); textBadge.textContent = `📝 ${String(sceneText.preview_text || sceneText.original_name || "文字").slice(0, 42)}`; textBadge.style.cssText = "position:absolute;left:5px;right:5px;top:34px;max-height:38px;overflow:hidden;padding:3px 5px;border-radius:4px;background:#25183ddd;color:#f4eaff;font-size:10px;pointer-events:none"; block.appendChild(textBadge); }
			const sceneLabel = document.createElement("strong"); sceneLabel.textContent = `分镜 ${index + 1}`; sceneLabel.style.cssText = "position:absolute;left:5px;top:5px;padding:2px 5px;border-radius:4px;background:#071014c9;color:#fff;pointer-events:none";
			const rangeLabel = document.createElement("span"); rangeLabel.textContent = `${scene.start_frame}-${scene.end_frame}`; rangeLabel.style.cssText = "position:absolute;left:5px;bottom:4px;padding:1px 4px;border-radius:3px;background:#071014c9;color:#eaffff;pointer-events:none";
			block.append(sceneLabel, rangeLabel);
			block.addEventListener("pointerdown", () => { selectedScene = index; });
			block.addEventListener("dragover", (event) => { if (!draggedMedia) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; block.style.boxShadow = "inset 0 0 0 3px #ffd45c"; });
			block.addEventListener("dragleave", () => { block.style.boxShadow = ""; });
			block.addEventListener("drop", (event) => {
				if (!draggedMedia) return;
				event.preventDefault(); event.stopPropagation();
				const sourceScene = plan.scenes[draggedMedia.sceneIndex]; const targetScene = plan.scenes[index];
				const [moved] = sourceScene?.media?.splice(draggedMedia.itemIndex, 1) || [];
				if (moved && targetScene) { targetScene.media ||= []; targetScene.media.push(moved); selectedScene = index; }
				draggedMedia = null; render();
			});
			timeline.appendChild(block);
		}
		const audioBody = document.createElement("div"); audioBody.style.cssText = "position:absolute;inset:5px;background:#18594f;border:1px solid #48a98e;border-radius:4px";
		const audioLabel = document.createElement("span"); audioLabel.textContent = videoItem() ? "原视频音频" : "音频轨"; audioLabel.style.cssText = "position:absolute;left:7px;top:3px;color:#d6fff1;font-size:11px";
		const wave = document.createElement("div"); wave.style.cssText = "position:absolute;left:8px;right:8px;top:50%;border-top:1px dashed #75d5b9aa";
		audioBody.append(audioLabel, wave); audioTrack.appendChild(audioBody);
		appendPlayhead(timeline, true); appendPlayhead(audioTrack, false);
		const active = plan.scenes[clamp(selectedScene, 0, plan.scenes.length - 1)] || plan.scenes[0];
		if (active && !promptPreview.isContentEditable) {
			const ownPrompt = String(active.prompt || "").trim();
			const fallbackPrompt = panelPromptForDirectorScene(node, selectedScene);
			promptPreview.textContent = ownPrompt || `未设置分段提示词，使用主正向提示词：\n${fallbackPrompt || "（主正向提示词为空）"}`;
			promptPreview.style.color = ownPrompt ? "#e7f5f5" : "#8fb5ba";
		}
		refsTitle.textContent = `片段 ${selectedScene + 1} 参考素材`;
		refsGrid.replaceChildren();
		const refs = [
			...(Array.isArray(active?.actors) ? active.actors.map((item, index) => ["actor", item, index]) : []),
			...(Array.isArray(active?.scenes) ? active.scenes.map((item, index) => ["scene", item, index]) : []),
		];
		for (const [itemIndex, item] of (active?.media || []).entries()) refs.push(["media", item, itemIndex]);
		for (const [kind, item, itemIndex] of refs) {
			const card = document.createElement("button"); card.type = "button"; card.style.cssText = "width:78px;flex:0 0 78px;padding:5px;border:1px solid #3d626a;border-radius:6px;background:#14242a;color:#e5f3f3";
			const image = document.createElement("img"); image.style.cssText = "display:block;width:66px;height:58px;object-fit:cover;border-radius:4px;background:#05090b";
			if (kind === "media") { const mediaType = String(item?.media_type || ""); if (mediaType === "image") image.src = internalMediaUrl(item); else { image.style.display = "none"; card.style.background = mediaType === "text" ? "#25183d" : "#14242a"; } }
			else setGjjLibraryThumbnail(image, api, kind === "scene" ? "scene" : "character", item);
			const label = document.createElement("span"); label.textContent = kind === "media" ? `${String(item?.media_type) === "text" ? "📝" : "🖼️"} ${item?.original_name || item?.filename || "素材"}` : `${kind === "scene" ? "🏕️" : "👤"} ${libraryDisplayName(item)}`; label.style.cssText = "display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:4px;font-size:11px";
			card.title = kind === "actor" ? "拖动调整角色顺序；Ctrl/Cmd+点击删除" : "Ctrl/Cmd+点击从当前片段删除"; card.append(image, label);
			card.addEventListener("click", (event) => {
				if (!event.ctrlKey && !event.metaKey) return;
				if (kind === "media") active.media.splice(itemIndex, 1);
				else { const key = kind === "scene" ? "scenes" : "actors"; const id = String(item?.id || item?.name); active[key] = (active[key] || []).filter((entry) => String(entry?.id || entry?.name) !== id); }
				render();
			});
			if (kind === "actor") {
				card.draggable = true; card.dataset.actorIndex = String(itemIndex); card.style.cursor = "grab";
				card.addEventListener("dragstart", (event) => {
					draggedActorIndex = itemIndex; card.style.opacity = ".45";
					event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(itemIndex));
				});
				card.addEventListener("dragend", () => { draggedActorIndex = -1; card.style.opacity = ""; });
				card.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; card.style.borderColor = "#ffd45c"; });
				card.addEventListener("dragleave", () => { card.style.borderColor = "#3d626a"; });
				card.addEventListener("drop", (event) => {
					event.preventDefault(); event.stopPropagation();
					const from = draggedActorIndex; let to = itemIndex;
					if (from < 0 || from === to || !Array.isArray(active.actors)) return;
					const [moved] = active.actors.splice(from, 1);
					active.actors.splice(to, 0, moved); draggedActorIndex = -1; render();
				});
			}
			if (kind === "media") {
				card.draggable = true; card.style.cursor = "grab";
				card.title = "拖到上方分镜可调整素材归属；在素材卡之间拖动可调整顺序；Ctrl/Cmd+点击删除";
				card.addEventListener("dragstart", (event) => {
					draggedMedia = { sceneIndex: selectedScene, itemIndex }; card.style.opacity = ".45";
					event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-gjj-director-media", `${selectedScene}:${itemIndex}`);
				});
				card.addEventListener("dragend", () => { draggedMedia = null; card.style.opacity = ""; });
				card.addEventListener("dragover", (event) => { if (!draggedMedia || draggedMedia.sceneIndex !== selectedScene) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; card.style.borderColor = "#ffd45c"; });
				card.addEventListener("dragleave", () => { card.style.borderColor = "#3d626a"; });
				card.addEventListener("drop", (event) => {
					if (!draggedMedia || draggedMedia.sceneIndex !== selectedScene) return;
					event.preventDefault(); event.stopPropagation();
					const media = active.media || []; const from = draggedMedia.itemIndex;
					if (from !== itemIndex && media[from]) { const [moved] = media.splice(from, 1); media.splice(itemIndex, 0, moved); }
					draggedMedia = null; render();
				});
			}
			refsGrid.appendChild(card);
		}
		if (!refs.length) { const empty = document.createElement("span"); empty.textContent = "当前片段没有参考素材"; empty.style.cssText = "margin:auto;color:#78939a"; refsGrid.appendChild(empty); }
		movePlayhead();
		saveDirectorPlan(node, plan);
	};
	let selectionRenderTimer = 0;
	const beginPromptEdit = () => {
		const active = plan.scenes[clamp(selectedScene, 0, plan.scenes.length - 1)]; if (!active) return;
		promptPreview.contentEditable = "true"; promptPreview.style.color = "#e7f5f5"; promptPreview.textContent = active.prompt || ""; promptPreview.focus();
		const range = document.createRange(); range.selectNodeContents(promptPreview); range.collapse(false);
		const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
	};
	const installTrackDrag = (track) => track.addEventListener("pointerdown", (event) => {
		if (event.button !== 0 || event.target?.closest?.("button")) return;
		const update = (next, snap = true) => {
			const rect = track.getBoundingClientRect();
			let frame = clamp(Math.round(viewStart + ((next.clientX - rect.left) / Math.max(1, rect.width)) * (viewEnd - viewStart)), 1, plan.total_frames);
			if (snap) {
				const threshold = Math.max(1, Math.round((viewEnd - viewStart + 1) * 8 / Math.max(1, rect.width)));
				const boundaries = plan.scenes.slice(1).map((scene) => scene.start_frame);
				const nearest = boundaries.reduce((best, value) => Math.abs(value - frame) < Math.abs(best - frame) ? value : best, Number.POSITIVE_INFINITY);
				if (Number.isFinite(nearest) && Math.abs(nearest - frame) <= threshold) frame = nearest;
			}
			playhead = frame;
			selectedScene = Math.max(0, plan.scenes.findIndex((scene) => playhead >= scene.start_frame && playhead <= scene.end_frame));
			if (preview.src) preview.currentTime = (playhead - 1) / plan.fps;
			movePlayhead();
		};
		update(event);
		const move = (next) => update(next);
		const stop = () => {
			window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", stop, true);
			clearTimeout(selectionRenderTimer); selectionRenderTimer = window.setTimeout(render, 220);
		};
		window.addEventListener("pointermove", move, true); window.addEventListener("pointerup", stop, true);
	});
	installTrackDrag(timeline); installTrackDrag(audioTrack);
	timeline.addEventListener("dblclick", (event) => {
		event.preventDefault(); event.stopPropagation(); clearTimeout(selectionRenderTimer);
		const rect = timeline.getBoundingClientRect();
		const frame = clamp(Math.round(viewStart + ((event.clientX - rect.left) / Math.max(1, rect.width)) * (viewEnd - viewStart)), 1, plan.total_frames);
		const found = plan.scenes.findIndex((scene) => frame >= scene.start_frame && frame <= scene.end_frame);
		if (found >= 0) selectedScene = found;
		playhead = frame; if (preview.src) preview.currentTime = (playhead - 1) / plan.fps; movePlayhead(); beginPromptEdit();
	});
	const alignedSegmentFrames = () => {
		const base = Math.max(5, Math.round((Number(value(node, "duration", 5)) || 5) * (Number(value(node, "frame_rate", 24)) || 24)));
		return base + ((5 - (base % 17)) % 17);
	};
	auto.addEventListener("click", () => {
		const size = alignedSegmentFrames(); const advance = Math.max(4, size - 1); segmentFrames.value = String(size);
		const active = plan.scenes[clamp(selectedScene, 0, plan.scenes.length - 1)] || {};
		plan.scenes = []; for (let start = 1; start <= plan.total_frames; start += advance) {
			plan.scenes.push({ start_frame: start, end_frame: Math.min(plan.total_frames, start + size - 1), prompt: "", actors: [...(active.actors || [])], scenes: [...(active.scenes || [])], media: [...(active.media || [])] });
			if (start + size - 1 >= plan.total_frames) break;
		}
		render();
	});
	snap.addEventListener("click", () => {
		const size = alignedSegmentFrames(); const advance = Math.max(4, size - 1); segmentFrames.value = String(size);
		const oldScenes = plan.scenes.map((scene) => ({ ...scene }));
		const sceneAt = (frame) => oldScenes.find((scene) => frame >= scene.start_frame && frame <= scene.end_frame) || oldScenes.at(-1) || {};
		const snapped = [];
		for (let start = 1; start <= plan.total_frames; start += advance) {
			const source = sceneAt(start); snapped.push({ start_frame: start, end_frame: Math.min(plan.total_frames, start + size - 1), prompt: source.prompt || "", actors: [...(source.actors || [])], scenes: [...(source.scenes || [])], media: [...(source.media || [])] });
			if (start + size - 1 >= plan.total_frames) break;
		}
		plan.scenes = snapped; selectedScene = clamp(selectedScene, 0, plan.scenes.length - 1); render();
	});
	promptPreview.addEventListener("dblclick", beginPromptEdit);
	promptPreview.addEventListener("blur", () => {
		if (!promptPreview.isContentEditable) return;
		const active = plan.scenes[clamp(selectedScene, 0, plan.scenes.length - 1)];
		if (active) active.prompt = String(promptPreview.textContent || "").trim();
		promptPreview.contentEditable = "false"; render();
	});
	const directorSelection = {
		get: (kind) => {
			const active = plan.scenes[clamp(selectedScene, 0, plan.scenes.length - 1)] || {};
			return kind === "scene" ? (active.scenes || []) : (active.actors || []);
		},
		set: (kind, items) => {
			const active = plan.scenes[clamp(selectedScene, 0, plan.scenes.length - 1)]; if (!active) return;
			active[kind === "scene" ? "scenes" : "actors"] = items; render();
		},
	};
	actorRef.addEventListener("click", () => toggleLibraryPicker(node, "actor", actorRef, directorSelection));
	sceneRef.addEventListener("click", () => toggleLibraryPicker(node, "scene", sceneRef, directorSelection));
	reuseRefs.addEventListener("click", () => {
		const active = plan.scenes[clamp(selectedScene, 0, plan.scenes.length - 1)]; if (!active) return;
		for (const scene of plan.scenes) { scene.actors = [...(active.actors || [])]; scene.scenes = [...(active.scenes || [])]; }
		render();
	});
	clearRefs.addEventListener("click", () => {
		const active = plan.scenes[clamp(selectedScene, 0, plan.scenes.length - 1)]; if (!active) return;
		active.actors = []; active.scenes = []; render();
	});
	fit.addEventListener("click", () => { viewStart = 1; viewEnd = plan.total_frames; render(); });
	const zoom = (factor) => { const width = clamp(Math.round((viewEnd - viewStart + 1) * factor), 8, plan.total_frames); viewStart = clamp(playhead - Math.floor(width / 2), 1, Math.max(1, plan.total_frames - width + 1)); viewEnd = Math.min(plan.total_frames, viewStart + width - 1); render(); };
	zoomOut.addEventListener("click", () => zoom(1.5)); zoomIn.addEventListener("click", () => zoom(.65));
	enable.addEventListener("click", () => { plan.enabled = !plan.enabled; render(); syncDirectorButton(node); });
	openMedia.addEventListener("click", () => mediaInput.click());
	mediaInput.addEventListener("change", async () => {
		const files = Array.from(mediaInput.files || []);
		mediaInput.value = "";
		if (!files.length) return;
		openMedia.disabled = true;
		info.textContent = "正在导入视频、图片或文字…";
		try {
			const uploaded = await uploadInternalMedia(node, files, true);
			const distribute = (items, mediaType) => items.forEach((item, index) => {
				if (!plan.scenes.length) return;
				const target = plan.scenes[index % plan.scenes.length]; target.media ||= [];
				if (index < plan.scenes.length) target.media = target.media.filter((entry) => String(entry?.media_type || "").toLowerCase() !== mediaType);
				target.media.push(item);
			});
			distribute(uploaded.filter((item) => String(item?.media_type || "").toLowerCase() === "image"), "image");
			distribute(uploaded.filter((item) => String(item?.media_type || "").toLowerCase() === "text"), "text");
			syncPreview();
			render();
			info.textContent = `已导入 ${files.length} 个媒体文件`;
		} catch (error) {
			info.textContent = `导入失败：${error?.message || error}`;
		} finally {
			openMedia.disabled = false;
		}
	});
	preview.addEventListener("loadedmetadata", () => {
		if (!Number.isFinite(preview.duration) || preview.duration <= 0) return;
		const nextTotal = Math.max(5, Math.round(preview.duration * plan.fps));
		if (nextTotal !== plan.total_frames) {
			plan.total_frames = nextTotal; viewStart = 1; viewEnd = nextTotal;
			if (plan.scenes.length) plan.scenes[plan.scenes.length - 1].end_frame = nextTotal;
			render();
		}
	});
	preview.addEventListener("timeupdate", () => {
		playhead = clamp(Math.round(preview.currentTime * plan.fps) + 1, 1, plan.total_frames);
		movePlayhead();
	});
	reset.addEventListener("click", () => {
		setValue(node, "director_storyboard_json", "{}");
		syncDirectorButton(node);
		closePopups(node);
	});
	for (const element of [tools, promptPreview, timeline, audioTrack, refsHeader, refsGrid]) protect(element);
	host.append(mediaInput, preview, tools, promptPreview, timeline, audioTrack, refsHeader, refsGrid); host.__gjjSync = () => { syncPreview(); render(); }; syncPreview(); render(); return host;
}
function enableDirectorDrag(root, handle) {
	handle.style.cursor = "move";
	handle.addEventListener("pointerdown", (event) => {
		if (event.button !== 0 || event.target?.closest?.("button,input,textarea,select")) return;
		event.preventDefault();
		const rect = root.getBoundingClientRect();
		const offsetX = event.clientX - rect.left; const offsetY = event.clientY - rect.top;
		const move = (next) => {
			root.style.left = `${Math.max(0, Math.min(window.innerWidth - root.offsetWidth, next.clientX - offsetX))}px`;
			root.style.top = `${Math.max(0, Math.min(window.innerHeight - 50, next.clientY - offsetY))}px`;
		};
		const stop = () => { window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", stop, true); };
		window.addEventListener("pointermove", move, true); window.addEventListener("pointerup", stop, true);
	}, true);
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
	if (key === "director") {
		const directorPanel = createDirectorPanel(node); root.appendChild(directorPanel); root.__gjjDirectorPanel = directorPanel;
		enableDirectorDrag(root, head);
		document.body.appendChild(root);
		return root;
	}
	if (key === "model") {
		const treeHost = document.createElement("div");
		const reasoningPanel = createReasoningPanel(node, treeHost);
		root.append(reasoningPanel, treeHost);
		renderModelTree(node, treeHost);
		const loraPanel = createLoraPanel(node);
		root.appendChild(loraPanel);
		const patchPanel = createModelPatchPanel(node);
		root.appendChild(patchPanel);
		root.__gjjModelTreeHost = treeHost;
		root.__gjjReasoningPanel = reasoningPanel;
		root.__gjjLoraPanel = loraPanel;
		root.__gjjPatchPanel = patchPanel;
		document.body.appendChild(root);
		return root;
	}
	if (key === "spectrum") {
		const spectrumPanel = createSpectrumPanel(node); root.appendChild(spectrumPanel); root.__gjjSpectrumPanel = spectrumPanel;
		document.body.appendChild(root);
		return root;
	}
	for (const [sectionTitle, names] of POPUP_GROUPS[key] || []) {
		const section = document.createElement("section"); section.className = "gjj-mh3-section"; const heading = document.createElement("div"); heading.className = "gjj-mh3-title"; heading.textContent = sectionTitle;
		const grid = document.createElement("div"); grid.className = "gjj-mh3-grid";
		for (const name of names) { let control = makeControl(node, name); if (!control) continue; const row = document.createElement("label"); row.className = "gjj-mh3-field"; if (["filename_prefix", "format_name", "global_prompt", "negative_prompt", "prompt_replace_find", "prompt_replace_with"].includes(name)) row.classList.add("wide"); if (key === "promptBook" && ["global_prompt", "negative_prompt", "prompt_replace_find", "prompt_replace_with"].includes(name)) { const textarea = document.createElement("textarea"); textarea.className = "gjj-mh3-control"; textarea.rows = name === "prompt_replace_find" ? 2 : 4; textarea.value = String(value(node, name, "")); textarea.dataset.widgetName = name; textarea.placeholder = name === "global_prompt" ? "添加到每个分段前" : name === "negative_prompt" ? "作为每个分段必须避免的内容" : name === "prompt_replace_find" ? "不区分大小写的纯文本查找" : "替换后的提示词"; textarea.addEventListener("input", () => setValue(node, name, textarea.value)); applyBoundState(node, name, textarea); protect(textarea); control = textarea; } const label = document.createElement("span"); label.textContent = widget(node, name)?.options?.display_name || widget(node, name)?.label || name; row.append(label, control); grid.append(row); }
		section.append(heading, grid); root.append(section);
	}
	if (key === "promptBook") root.__gjjSync = () => { for (const control of root.querySelectorAll("textarea[data-widget-name]")) if (document.activeElement !== control) control.value = String(value(node, control.dataset.widgetName, "")); };
	document.body.appendChild(root); return root;
}
function closePopups(node) { for (const item of Object.values(node.__gjjMiniMaxPanel?.popups || {})) item.classList.remove("open"); for (const item of Object.values(node.__gjjMiniMaxPanel?.buttons || {})) item.classList.remove("active"); syncDirectorButton(node); }
function openPopup(node, key, anchor) {
	const panel = node.__gjjMiniMaxPanel; const target = panel?.popups?.[key]; if (!target) return;
	const wasOpen = target.classList.contains("open"); closePopups(node); if (wasOpen) return;
	if (key === "size") target.__gjjSizePanel?.__gjjSync?.();
	if (key === "model" && target.__gjjModelTreeHost) { target.__gjjReasoningPanel?.__gjjSync?.(); renderModelTree(node, target.__gjjModelTreeHost); target.__gjjLoraPanel?.__gjjRefresh?.(); target.__gjjPatchPanel?.__gjjSync?.(); }
	if (key === "spectrum") target.__gjjSpectrumPanel?.__gjjSync?.();
	if (key === "promptBook") target.__gjjSync?.();
	if (key === "director") target.__gjjDirectorPanel?.__gjjSync?.();
	const rect = anchor.getBoundingClientRect(); const width = Math.min(key === "director" ? 900 : 560, window.innerWidth - 28); target.style.width = `${width}px`; target.style.left = `${Math.max(14, Math.min(window.innerWidth - width - 14, rect.left))}px`; target.style.top = `${Math.max(14, Math.min(window.innerHeight - 300, rect.bottom + 7))}px`; target.classList.add("open"); anchor.classList.add("active");
}
function makeButton(text, title, className = "") { const button = document.createElement("button"); button.type = "button"; button.className = `gjj-mh3-btn ${className}`; button.textContent = text; button.title = title; protect(button); return button; }
function firstPreviewItem(...values) {
	for (const value of values) {
		if (!value) continue;
		if (Array.isArray(value)) { const nested = firstPreviewItem(...value); if (nested) return nested; }
		else if (typeof value === "object" && value.filename) return value;
	}
	return null;
}
function previewItemFromPath(rawPath) {
	const clean = String(Array.isArray(rawPath) ? rawPath[0] : rawPath || "").replaceAll("\\", "/"); if (!clean) return null;
	const filename = clean.split("/").pop(); if (!filename) return null;
	const marker = clean.toLowerCase().lastIndexOf("/output/"); const subfolder = marker >= 0 ? clean.slice(marker + 8, clean.length - filename.length).replace(/^\/+|\/+$/g, "") : "";
	return { filename, subfolder, type: "output" };
}
function previewScalar(value, fallback = "") { return Array.isArray(value) ? (value[0] ?? fallback) : (value ?? fallback); }
function orderedPreviewEntries(state) {
	return Array.from(state?.previewEntries?.values?.() || []).sort((a, b) => {
		if (a.kind === b.kind) return Number(a.segment || 0) - Number(b.segment || 0);
		return a.kind === "segment" ? -1 : 1;
	});
}
function showStoredPreview(node, key) {
	const state = node.__gjjMiniMaxPanel; const entry = state?.previewEntries?.get?.(key); if (!entry) return;
	state.activePreviewKey = key; const item = entry.item;
	const query = `/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "output")}&subfolder=${encodeURIComponent(item.subfolder || "")}&rand=${Date.now()}`;
	state.resultRoot.style.display = "grid";
	state.video.src = api.apiURL(query); state.preview.style.display = "block"; state.video.load(); const play = state.video.play?.(); play?.catch?.(() => {});
	const entries = orderedPreviewEntries(state); const activeIndex = Math.max(0, entries.findIndex((candidate) => candidate.key === key));
	if (state.previewNav) state.previewNav.style.display = entries.length > 1 ? "flex" : "none";
	if (state.previewLabel) state.previewLabel.textContent = entry.kind === "final" ? "最终视频" : `片段 ${entry.segment}/${entry.segmentCount}`;
	if (state.previewPrev) state.previewPrev.disabled = activeIndex <= 0;
	if (state.previewNext) state.previewNext.disabled = activeIndex >= entries.length - 1;
	const resize = () => { const contentWidth = Math.max(1, Number(state.preview.clientWidth || state.resultRoot?.clientWidth || node.size?.[0] - 36 || 1)); const mediaHeight = Math.max(1, Math.round(contentWidth * Number(state.video.videoHeight || 9) / Math.max(1, Number(state.video.videoWidth || 16)))); state.preview.style.height = `${mediaHeight}px`; fitPanel(node); };
	state.video.onloadedmetadata = resize; state.previewObserver?.disconnect?.(); let lastWidth = 0; state.previewObserver = new ResizeObserver((entries) => { const width = Math.round(entries[0]?.contentRect?.width || 0); if (width > 0 && width !== lastWidth) { lastWidth = width; resize(); } }); state.previewObserver.observe(state.preview); setTimeout(resize, 50);
}
function resetResultPreview(node) {
	const state = node?.__gjjMiniMaxPanel; if (!state) return;
	state.previewEntries?.clear?.(); state.activePreviewKey = null; state.previewObserver?.disconnect?.();
	if (state.video) { state.video.pause?.(); state.video.removeAttribute("src"); state.video.load?.(); state.video.onloadedmetadata = null; }
	if (state.preview) { state.preview.style.display = "none"; state.preview.style.height = "0"; }
	if (state.resultRoot) state.resultRoot.style.display = "none";
	if (state.previewNav) state.previewNav.style.display = "none";
	fitPanel(node); node.setDirtyCanvas?.(true, true); app.graph?.setDirtyCanvas?.(true, true);
}
function renderResultPreview(node, message = {}) {
	const state = node.__gjjMiniMaxPanel; if (!state?.preview || !state?.video) return;
	const output = message?.output && typeof message.output === "object" ? message.output : message;
	const item = firstPreviewItem(output.preview_media, output.preview_video, output.gifs, output.animated, output.videos, output.video) || previewItemFromPath(output.output_path);
	if (!item) return;
	state.previewEntries ||= new Map(); const segment = Number(previewScalar(output.segment, 0)); const segmentCount = Number(previewScalar(output.segment_count, 1)); const scope = String(previewScalar(output.preview_scope, ""));
	const kind = segment > 0 ? "segment" : (scope === "final" || segmentCount > 1 ? "final" : "single"); const key = kind === "segment" ? `segment:${segment}` : kind;
	state.previewEntries.set(key, { key, kind, segment, segmentCount, item }); showStoredPreview(node, key);
}
function mediaInput(node, name) { return (node.inputs || []).find((item) => String(item?.name || "") === name); }
function ensureExternalPromptInput(node) {
	if (mediaInput(node, "external_prompt") || typeof node?.addInput !== "function") return;
	node.addInput("external_prompt", "STRING"); const input = mediaInput(node, "external_prompt"); if (input) { input.label = "外部提示词"; input.localized_name = "外部提示词"; }
}
function graphLink(linkId) {
	const ids = Array.isArray(linkId) ? linkId : [linkId];
	for (const id of ids) {
		if (id == null || Number(id) < 0) continue;
		const link = app.graph?.links?.[id] || app.graph?.links?.get?.(id) || app.graph?.links?.get?.(Number(id)) || app.graph?._links?.[id] || app.graph?._links?.get?.(id) || app.graph?._links?.get?.(Number(id));
		if (link) return link;
	}
	return null;
}
function connectedTextSource(node, inputName, visited = new Set()) {
	const link = graphLink(mediaInput(node, inputName)?.link);
	const source = link ? app.graph?.getNodeById?.(link.origin_id) : null;
	if (!source || visited.has(source.id)) return null;
	visited.add(source.id);

	// 文本预览节点有上游时会把实际预览正文写回实时字段和 text 控件；
	// 没有上游时，text 控件本身就是它真正输出的内容。
	if (String(source?.comfyClass || source?.type || "") === "GJJ_TextInput") {
		const live = source.__gjjTextInputLiveText;
		if (live != null && String(live) !== "等待执行后预览上游文本") return String(live);
		const saved = source?.properties?.gjj_text_input_saved_text;
		const current = widget(source, "text")?.value;
		if (current != null && String(current) !== "等待执行后预览上游文本") return String(current);
		if (saved != null && String(saved) !== "等待执行后预览上游文本") return String(saved);
		// 仅在预览节点自身尚无可用正文时，才继续追踪它的 text_in 来源。
		return connectedTextSource(source, "text_in", visited);
	}

	// 兼容常见文本节点：优先读取与已连接输出同名的控件，再尝试通用文本控件。
	const outputName = String(source.outputs?.[Number(link.origin_slot)]?.name || "");
	for (const name of [outputName, "text", "prompt", "STRING"]) {
		const current = widget(source, name)?.value;
		if (current != null) return String(current);
	}
	return null;
}
function effectivePromptText(node) {
	const connected = connectedTextSource(node, "external_prompt");
	return connected != null ? connected : String(value(node, "prompt", "") || "");
}
function multiMediaLinks(node) { node.properties ||= {}; return Array.isArray(node.properties[MULTI_MEDIA_LINKS_PROPERTY]) ? node.properties[MULTI_MEDIA_LINKS_PROPERTY] : []; }
function activeMediaLinks(node) { return MEDIA_INPUTS.some((name) => mediaInput(node, name)?.link != null) || multiMediaLinks(node).length > 0; }
function activeManagedLinks(node) { return MANAGED_LINK_INPUTS.some((name) => mediaInput(node, name)?.link != null) || multiMediaLinks(node).length > 0; }
function linkMemory(node) { node.properties ||= {}; node.properties[LINK_MEMORY_PROPERTY] ||= {}; return node.properties[LINK_MEMORY_PROPERTY]; }
function hasRememberedLinks(node) { return Object.values(linkMemory(node)).some((item) => item && typeof item === "object"); }
function toggleMediaLinks(node) {
	const memory = linkMemory(node);
	if (activeManagedLinks(node)) {
		for (const name of MANAGED_LINK_INPUTS) { const input = mediaInput(node, name); const linkId = Array.isArray(input?.link) ? input.link[0] : input?.link; const link = app.graph?.links?.[linkId]; if (!input || !link) continue; memory[name] = { origin_id: link.origin_id, origin_slot: link.origin_slot }; const inputIndex = node.inputs.indexOf(input); node.disconnectInput?.(inputIndex); }
		const virtualLinks = multiMediaLinks(node);
		if (virtualLinks.length) { memory[MULTI_MEDIA_MEMORY_KEY] = virtualLinks.map((item) => ({ ...item })); node.properties[MULTI_MEDIA_LINKS_PROPERTY] = []; }
	} else {
		for (const name of MANAGED_LINK_INPUTS) { const record = memory[name]; const target = mediaInput(node, name); const source = app.graph?.getNodeById?.(record?.origin_id); if (!record || !target || !source?.connect) continue; source.connect(Number(record.origin_slot), node, node.inputs.indexOf(target)); }
		const rememberedVirtualLinks = memory[MULTI_MEDIA_MEMORY_KEY];
		if (Array.isArray(rememberedVirtualLinks)) node.properties[MULTI_MEDIA_LINKS_PROPERTY] = rememberedVirtualLinks.map((item) => ({ ...item }));
	}
	node.graph?.change?.(); syncMediaToolbar(node); app.graph?.setDirtyCanvas?.(true, true);
}
function internalMediaItems(node) { try { const result = JSON.parse(String(value(node, "internal_media_json", "[]"))); return Array.isArray(result) ? result : []; } catch (_) { return []; } }
function mentionEditorText(editor) {
	let result = ""; const visit = (item) => {
		if (item.nodeType === Node.TEXT_NODE) { result += String(item.textContent || "").replaceAll("\u200B", ""); return; }
		if (item.nodeType !== Node.ELEMENT_NODE) return;
		if (item.classList?.contains("gjj-mh3-mention-chip")) { result += String(item.dataset.token || ""); return; }
		if (item.tagName === "BR") { result += "\n"; return; }
		if (["DIV", "P"].includes(item.tagName) && result && !result.endsWith("\n")) result += "\n";
		for (const child of item.childNodes || []) visit(child);
	}; for (const child of editor?.childNodes || []) visit(child); return result;
}
function mentionSourcePreview(source) {
	const image = (source?.imgs || []).find((item) => item?.src); if (image?.src) return image.src;
	for (const target of source?.widgets || []) {
		const elementImage = target?.element?.matches?.("img") ? target.element : target?.element?.querySelector?.("img"); if (elementImage?.src) return elementImage.src;
		const raw = target?.value; const filename = typeof raw === "object" ? raw?.filename : raw;
		if (!filename || !/\.(png|jpe?g|webp|gif|bmp)$/i.test(String(filename))) continue;
		const params = new URLSearchParams({ filename: String(filename), type: typeof raw === "object" ? String(raw.type || "input") : "input" }); if (typeof raw === "object" && raw.subfolder) params.set("subfolder", String(raw.subfolder)); return api.apiURL(`/view?${params.toString()}`);
	} return "";
}
function mentionMediaItemUrl(item) {
	const direct = String(item?.url || item?.preview_url || item?.src || ""); if (/^(?:blob:|data:|https?:)/i.test(direct)) return direct;
	const filename = String(item?.filename || item?.name || ""); if (!filename) return "";
	const params = new URLSearchParams({ filename, type: String(item?.type || "input") }); if (item?.subfolder) params.set("subfolder", String(item.subfolder)); return api.apiURL(`/view?${params.toString()}`);
}
function mentionSourceImages(source, sourceSlot = 0) {
	const state = source?.__gjjMultiImageState || source?.__gjjMultiImageLoaderState || {}; let selected = [];
	try { const parsed = JSON.parse(String(widget(source, "selected_images")?.value || source?.properties?.selected_images || "[]")); if (Array.isArray(parsed)) selected = parsed; } catch (_) {}
	let items = []; for (const candidate of [state.executedImages, state.selection, selected]) if (Array.isArray(candidate) && candidate.length) { items = candidate; break; }
	const output = source?.outputs?.[Number(sourceSlot)]; const outputName = String(output?.name || output?.label || ""); if (/(?:图片|导出图片|image)\s*0*\d+/i.test(outputName)) items = items.slice(0, 1);
	let count = items.length; if (!count) count = Math.max(0, Number(source?.properties?.gjj_batch_crop_resize_media_count || source?.properties?.gjj_image_batch_multi_input_count || 0));
	count = Math.max(1, count); const fallback = mentionSourcePreview(source); return Array.from({ length: count }, (_, index) => ({ preview: mentionMediaItemUrl(items[index]) || fallback, detail: String(items[index]?.original_name || items[index]?.filename || source?.title || source?.comfyClass || "连接图片") }));
}
async function mentionEditorOptions(node) {
	const options = []; const seenSources = new Set(); let imageIndex = 0;
	const addSource = (sourceId, sourceSlot = 0, declaredType = "") => { const id = Number(sourceId); const sourceKey = `${id}:${Number(sourceSlot)}`; if (!Number.isFinite(id) || seenSources.has(sourceKey)) return; const source = app.graph?.getNodeById?.(id); if (!source) return; const outputType = String(declaredType || source.outputs?.[Number(sourceSlot)]?.type || "").toUpperCase(); if (outputType && !outputType.includes("IMAGE") && !outputType.includes("GJJ_BATCH_IMAGE")) return; seenSources.add(sourceKey); for (const item of mentionSourceImages(source, sourceSlot)) { imageIndex += 1; options.push({ kind: "image", token: `@图片${imageIndex}`, label: `图片${imageIndex}`, detail: item.detail, preview: item.preview }); } };
	for (const name of MEDIA_INPUTS) { const input = mediaInput(node, name); for (const linkId of (Array.isArray(input?.link) ? input.link : [input?.link])) { const link = app.graph?.links?.[linkId]; if (link) addSource(link.origin_id, link.origin_slot); } }
	for (const link of multiMediaLinks(node)) addSource(link?.origin_id ?? link?.source_id, link?.origin_slot ?? link?.source_slot, link?.media_type);
	for (const item of internalMediaItems(node).filter((entry) => String(entry?.media_type || "").toLowerCase() === "image")) { imageIndex += 1; options.push({ kind: "image", token: `@图片${imageIndex}`, label: `图片${imageIndex}`, detail: String(item.original_name || item.filename || "内部图片"), preview: internalMediaUrl(item) }); }
	try { const index = await promptLibraryIndex(); for (const item of index.actor || []) { const label = libraryDisplayName(item); if (label) options.push({ kind: "actor", token: `@${label}`, label, detail: "角色库", item }); } } catch (_) {}
	return options;
}
function makeMentionImage(option) { const image = document.createElement("img"); image.alt = ""; image.draggable = false; if (option.kind === "actor") setGjjLibraryThumbnail(image, api, "character", option.item); else if (option.preview) image.src = option.preview; return image; }
function makeInlineMention(option) { const chip = document.createElement("span"); chip.className = "gjj-mh3-mention-chip"; chip.contentEditable = "false"; chip.dataset.token = option.token; chip.title = option.detail || option.label; const label = document.createElement("span"); label.textContent = option.token; chip.append(makeMentionImage(option), label); return chip; }
function renderMentionEditor(editor, text, options) {
	const source = String(text || ""); const sorted = [...options].sort((a, b) => b.token.length - a.token.length); const fragment = document.createDocumentFragment(); let cursor = 0;
	while (cursor < source.length) { const option = sorted.find((item) => source.startsWith(item.token, cursor)); if (option) { fragment.append(makeInlineMention(option)); cursor += option.token.length; continue; } let end = cursor + 1; while (end < source.length && !sorted.some((item) => source.startsWith(item.token, end))) end += 1; fragment.append(document.createTextNode(source.slice(cursor, end))); cursor = end; }
	editor.replaceChildren(fragment);
}
function closeMentionEditorMenu(node) { node.__gjjMentionMenu?.remove?.(); node.__gjjMentionMenu = null; }
async function openMentionEditorMenu(node, editor) {
	const selection = window.getSelection?.(); if (!selection?.rangeCount) return closeMentionEditorMenu(node); const range = selection.getRangeAt(0);
	if (!editor.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE) return closeMentionEditorMenu(node);
	const before = String(range.startContainer.textContent || "").slice(0, range.startOffset); const match = /@([^\s@]*)$/u.exec(before); if (!match) return closeMentionEditorMenu(node);
	const options = (await mentionEditorOptions(node)).filter((item) => !match[1] || `${item.label} ${item.detail}`.toLocaleLowerCase().includes(match[1].toLocaleLowerCase())).slice(0, 30); closeMentionEditorMenu(node);
	const menu = document.createElement("div"); menu.className = "gjj-mh3-mention-menu";
	if (!options.length) { const empty = document.createElement("div"); empty.style.cssText = "padding:9px;color:#81999d"; empty.textContent = "没有匹配的图片或角色"; menu.append(empty); }
	for (const option of options) { const button = document.createElement("button"); button.type = "button"; button.className = "gjj-mh3-mention-option"; const text = document.createElement("span"); const name = document.createElement("strong"); name.textContent = option.token; const detail = document.createElement("small"); detail.textContent = option.detail; text.append(name, detail); button.append(makeMentionImage(option), text); button.addEventListener("pointerdown", (event) => { event.preventDefault(); const textNode = range.startContainer; const replacement = document.createRange(); replacement.setStart(textNode, range.startOffset - match[0].length); replacement.setEnd(textNode, range.startOffset); replacement.deleteContents(); const chip = makeInlineMention(option); replacement.insertNode(chip); const space = document.createTextNode("\u00a0"); chip.after(space); const caret = document.createRange(); caret.setStart(space, 1); caret.collapse(true); selection.removeAllRanges(); selection.addRange(caret); editor.focus(); const prompt = mentionEditorText(editor); editor.dataset.sourceText = prompt; setValue(node, "prompt", prompt); closeMentionEditorMenu(node); schedulePromptLibrarySync(node); }); menu.append(button); }
	document.body.append(menu); const rect = range.getBoundingClientRect(); menu.style.left = `${Math.max(8, Math.min(window.innerWidth - 368, rect.left))}px`; menu.style.top = `${Math.max(8, Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 6))}px`; node.__gjjMentionMenu = menu;
}
function createMentionPromptEditor(node) {
	const editor = document.createElement("div"); editor.className = "gjj-mh3-mention-editor"; editor.contentEditable = "true"; editor.spellcheck = false; editor.dataset.placeholder = "输入提示词；键入 @ 引用图片或角色库"; protect(editor);
	const target = widget(node, "prompt"); GJJ_Utils.hideWidget(target); target.hidden = true; target.computeSize = () => [0, 0]; target.getHeight = () => 0; for (const element of [target?.element, target?.inputEl]) if (element?.style) element.style.display = "none";
	node.__gjjMentionEditor = editor; void syncMentionPromptEditor(node);
	editor.addEventListener("input", () => { if (promptInputLinked(node)) return; const text = mentionEditorText(editor); editor.dataset.sourceText = text; setValue(node, "prompt", text); void openMentionEditorMenu(node, editor); schedulePromptLibrarySync(node); });
	editor.addEventListener("keyup", (event) => { if (!["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) void openMentionEditorMenu(node, editor); }); editor.addEventListener("keydown", (event) => { if (event.key === "Escape") closeMentionEditorMenu(node); event.stopPropagation(); });
	editor.addEventListener("paste", (event) => { event.preventDefault(); document.execCommand("insertText", false, event.clipboardData?.getData("text/plain") || ""); }); editor.addEventListener("blur", () => setTimeout(() => closeMentionEditorMenu(node), 180)); return editor;
}
async function syncMentionPromptEditor(node) {
	const editor = node?.__gjjMentionEditor; if (!editor) return; const linked = promptInputLinked(node); const text = effectivePromptText(node);
	editor.contentEditable = linked ? "false" : "true"; editor.setAttribute("aria-disabled", linked ? "true" : "false"); editor.tabIndex = linked ? -1 : 0; editor.classList.toggle("linked", linked); editor.dataset.placeholder = linked ? "外部提示词为空" : "输入提示词；键入 @ 引用图片或角色库"; editor.title = linked ? "已连接外部提示词，本地输入已禁用" : ""; if (linked) closeMentionEditorMenu(node);
	const context = `${currentImageCount(node)}|${JSON.stringify(multiMediaLinks(node))}|${String(value(node, "internal_media_json", "[]"))}`; if ((!linked && document.activeElement === editor) || (editor.dataset.sourceText === text && editor.dataset.sourceContext === context)) return;
	editor.dataset.sourceText = text; editor.dataset.sourceContext = context; const expected = text; const options = await mentionEditorOptions(node); if (effectivePromptText(node) !== expected) { editor.dataset.sourceText = ""; return; } renderMentionEditor(editor, expected, options);
}
function librarySelection(node, kind) {
	const name = kind === "scene" ? "selected_scenes_json" : "selected_actors_json";
	try { const items = JSON.parse(String(value(node, name, "[]"))); return Array.isArray(items) ? items : []; } catch (_) { return []; }
}
function saveLibrarySelection(node, kind, items) {
	setValue(node, kind === "scene" ? "selected_scenes_json" : "selected_actors_json", JSON.stringify(items)); if (items.length) setValue(node, "image_branch", "参考"); syncLibraryButtons(node); syncBranchButtons(node);
}
function libraryDisplayName(item) { return String(item?.name || item?.id || "未命名").replace(/^\s*(?:♀️|♂️|♀|♂)\s*/, "").trim(); }
let libraryIndexPromise = null;
function escapeRegExp(text) { return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
async function promptLibraryIndex() {
	if (libraryIndexPromise) return libraryIndexPromise;
	libraryIndexPromise = Promise.all([
		api.fetchApi(`${CHARACTER_LIBRARY_ENDPOINT}?summary=1`).then((response) => response.json()),
		api.fetchApi(SCENE_LIBRARY_ENDPOINT).then((response) => response.json()),
	]).then(([characters, scenes]) => ({
		actor: Array.isArray(characters?.characters) ? characters.characters : [],
		scene: Array.isArray(scenes?.scenes) ? scenes.scenes : [],
	})).catch((error) => { libraryIndexPromise = null; throw error; });
	return libraryIndexPromise;
}
function referencedLibraryItems(prompt, kind, items) {
	const text = String(prompt || ""); if (!text || !Array.isArray(items)) return [];
	const marker = kind === "scene" ? "🏕️?\\s*" : "@\\s*";
	const matches = [];
	for (const item of items) {
		const aliases = [...new Set([libraryDisplayName(item), String(item?.id || "").trim()].filter(Boolean))].sort((a, b) => b.length - a.length);
		for (const alias of aliases) {
			const found = new RegExp(`${marker}${escapeRegExp(alias)}`, "iu").exec(text);
			if (found) { matches.push({ position: found.index, length: alias.length, item }); break; }
		}
	}
	matches.sort((a, b) => a.position - b.position || b.length - a.length);
	const result = []; const seenPositions = new Set(); const seenIds = new Set();
	for (const match of matches) {
		if (seenPositions.has(match.position)) continue;
		const id = String(match.item?.id || libraryDisplayName(match.item)); if (seenIds.has(id)) continue;
		seenPositions.add(match.position); seenIds.add(id); result.push(match.item);
	}
	return result;
}
function promptInputLinked(node) { return Boolean(graphLink(mediaInput(node, "external_prompt")?.link)); }
function mergeLibraryItems(current, parsed) {
	const result = []; const seen = new Set();
	for (const item of [...(current || []), ...(parsed || [])]) {
		const id = String(item?.id || libraryDisplayName(item));
		if (!id || seen.has(id)) continue;
		seen.add(id); result.push(item);
	}
	return result;
}
async function syncPromptLibrarySelections(node) {
	const prompt = effectivePromptText(node);
	if (node.__gjjMiniMaxParsedLibraryPrompt === prompt) return;
	node.__gjjMiniMaxParsedLibraryPrompt = prompt;
	if (!prompt.includes("@") && !prompt.includes("🏕")) return;
	try {
		const index = await promptLibraryIndex();
		if (effectivePromptText(node) !== prompt) { node.__gjjMiniMaxParsedLibraryPrompt = null; return; }
		for (const kind of ["actor", "scene"]) {
			const markerPresent = kind === "actor" ? prompt.includes("@") : prompt.includes("🏕"); if (!markerPresent) continue;
			const parsed = referencedLibraryItems(prompt, kind, index[kind]); if (!parsed.length) continue;
			const current = librarySelection(node, kind);
			const next = promptInputLinked(node) ? parsed : mergeLibraryItems(current, parsed);
			const currentIds = current.map((item) => String(item?.id || libraryDisplayName(item)));
			const nextIds = next.map((item) => String(item?.id || libraryDisplayName(item)));
			if (JSON.stringify(currentIds) !== JSON.stringify(nextIds)) saveLibrarySelection(node, kind, next);
		}
	} catch (error) { console.warn("[GJJ_MiniMaxH3Studio] 解析提示词资料库引用失败", error); }
}
async function addParsedLibraryButtons(node, kind, names) {
	const requested = new Set((Array.isArray(names) ? names : []).map((name) => String(name || "").trim().toLocaleLowerCase()).filter(Boolean));
	if (!requested.size) return;
	try {
		const index = await promptLibraryIndex();
		const parsed = index[kind].filter((item) => [libraryDisplayName(item), String(item?.id || "").trim()].some((alias) => requested.has(alias.toLocaleLowerCase())));
		const current = librarySelection(node, kind);
		const next = promptInputLinked(node) ? parsed : mergeLibraryItems(current, parsed);
		const currentIds = current.map((item) => String(item?.id || libraryDisplayName(item)));
		const nextIds = next.map((item) => String(item?.id || libraryDisplayName(item)));
		if (parsed.length && JSON.stringify(currentIds) !== JSON.stringify(nextIds)) saveLibrarySelection(node, kind, next);
	} catch (error) { console.warn("[GJJ_MiniMaxH3Studio] 回显提示词资料库按钮失败", error); }
}
function schedulePromptLibrarySync(node) {
	const prompt = effectivePromptText(node);
	if (node.__gjjMiniMaxParsedLibraryPrompt === prompt || node.__gjjMiniMaxScheduledLibraryPrompt === prompt) return;
	clearTimeout(node.__gjjMiniMaxLibraryParseTimer);
	node.__gjjMiniMaxScheduledLibraryPrompt = prompt;
	node.__gjjMiniMaxLibraryParseTimer = setTimeout(() => { node.__gjjMiniMaxScheduledLibraryPrompt = null; void syncPromptLibrarySelections(node); }, 80);
}
let activeLibraryPreview = null;
function closeLibraryPreview(owner = null) { if (!activeLibraryPreview || (owner && activeLibraryPreview.owner !== owner)) return; activeLibraryPreview.element.remove(); activeLibraryPreview = null; }
function showLibraryPreview(owner, kind, item) {
	closeLibraryPreview(); if (!owner || !item) return; const path = gjjLibraryThumbnailPath(kind === "scene" ? "scene" : "character", item); if (!path) return;
	const preview = document.createElement("div"); preview.className = "gjj-mh3-library-preview"; const image = document.createElement("img"); const caption = document.createElement("div"); const marker = kind === "scene" ? "🏕️" : "@"; const notes = String(item?.notes || "").replace(/\s+/g, " ").trim(); caption.textContent = `${marker}${libraryDisplayName(item)}${notes ? `（${notes}）` : ""}`; preview.append(image, caption); document.body.appendChild(preview);
	void loadGjjLibraryThumbnailBlobUrl(api, kind === "scene" ? "scene" : "character", item).then((blobUrl) => { image.src = blobUrl || api.apiURL(path); }); const rect = owner.getBoundingClientRect(); preview.style.left = `${Math.max(8, Math.min(window.innerWidth - 294, rect.right + 8))}px`; preview.style.top = `${Math.max(8, Math.min(window.innerHeight - 390, rect.top))}px`; activeLibraryPreview = { owner, element: preview };
}
async function appendLibraryReference(node, reference) {
	if (promptInputLinked(node)) { if (node.__gjjMiniMaxPanel) node.__gjjMiniMaxPanel.status.textContent = "外部提示词已连接，请在上游输入中添加引用"; return; }
	const current = String(value(node, "prompt", "") || ""); const next = `${current}${current && !/\s$/.test(current) ? " " : ""}${reference}`;
	setValue(node, "prompt", next); await syncMentionPromptEditor(node);
	const editor = node.__gjjMentionEditor; if (!editor) return; editor.focus(); const selection = window.getSelection?.(); if (!selection) return; const caret = document.createRange(); caret.selectNodeContents(editor); caret.collapse(false); selection.removeAllRanges(); selection.addRange(caret);
}
function syncLibraryButtons(node) {
	const panel = node.__gjjMiniMaxPanel; if (!panel) return;
	for (const [kind, button] of [["scene", panel.sceneButton], ["actor", panel.actorButton]]) {
		if (!button) continue; const selected = librarySelection(node, kind); const count = selected.length; button.classList.toggle("active", count > 0); button.replaceChildren(); if (count) { const image = document.createElement("img"); setGjjLibraryThumbnail(image, api, kind === "scene" ? "scene" : "character", selected[0]); const badge = document.createElement("span"); badge.className = "gjj-mh3-library-count"; badge.textContent = String(count); button.append(image, badge); button.onmouseenter = () => showLibraryPreview(button, kind, selected[0]); button.onmouseleave = () => closeLibraryPreview(button); } else { button.textContent = kind === "scene" ? "🏕️" : "👤"; button.onmouseenter = null; button.onmouseleave = null; } button.title = count ? `已选择 ${count} 个${kind === "scene" ? "场景" : "角色"}；悬停预览，点击修改` : `选择${kind === "scene" ? "场景库" : "角色库"}引用`;
	}
	if (panel.libraryChips) { panel.libraryChips.replaceChildren(); const entries = [["actor", ...librarySelection(node, "actor")], ["scene", ...librarySelection(node, "scene")]];
		for (const group of entries) { const kind = group[0]; for (const item of group.slice(1)) { const reference = `${kind === "scene" ? "🏕️" : "@"}${libraryDisplayName(item)}`; const chip = document.createElement("button"); chip.type = "button"; chip.className = "gjj-mh3-library-chip"; const image = document.createElement("img"); setGjjLibraryThumbnail(image, api, kind === "scene" ? "scene" : "character", item); const label = document.createElement("span"); label.textContent = reference; chip.append(image, label); chip.title = "点击追加到提示词末尾；Ctrl/Cmd+点击移除"; chip.addEventListener("mouseenter", () => showLibraryPreview(chip, kind, item)); chip.addEventListener("mouseleave", () => closeLibraryPreview(chip)); chip.addEventListener("click", (event) => { closeLibraryPreview(chip); if (event.ctrlKey || event.metaKey) { const id = String(item?.id || item?.name); saveLibrarySelection(node, kind, librarySelection(node, kind).filter((entry) => String(entry?.id || entry?.name) !== id)); return; } void appendLibraryReference(node, reference); }); panel.libraryChips.appendChild(chip); } }
		panel.libraryChips.style.display = panel.libraryChips.childElementCount ? "flex" : "none";
	}
}
function closeLibraryPicker(node) { closeLibraryPreview(); const panel = node.__gjjMiniMaxPanel; panel?.libraryPicker?.remove?.(); if (panel) panel.libraryPicker = null; panel?.sceneButton?.classList.remove("picker-open"); panel?.actorButton?.classList.remove("picker-open"); }
async function toggleLibraryPicker(node, kind, anchor, selectionAdapter = null) {
	const panel = node.__gjjMiniMaxPanel; if (!panel) return;
	if (panel.libraryPicker?.dataset?.kind === kind) { closeLibraryPicker(node); return; }
	closeLibraryPicker(node);
	const picker = document.createElement("div"); picker.className = "gjj-mh3-library"; picker.dataset.kind = kind; protect(picker);
	const head = document.createElement("div"); head.className = "gjj-mh3-library-head";
	const title = document.createElement("div"); title.className = "gjj-mh3-library-title"; title.textContent = kind === "scene" ? "🏕️ 场景库" : "👤 角色库";
	const search = document.createElement("input"); search.className = "gjj-mh3-library-search"; search.placeholder = "搜索名称或备注";
	const done = document.createElement("button"); done.className = "gjj-mh3-close"; done.textContent = "确定"; done.addEventListener("click", () => closeLibraryPicker(node));
	head.append(title, search, done); const grid = document.createElement("div"); grid.className = "gjj-mh3-library-grid"; picker.append(head, grid); document.body.appendChild(picker); panel.libraryPicker = picker; anchor.classList.add("picker-open");
	const rect = anchor.getBoundingClientRect(); picker.style.left = `${Math.max(14, Math.min(window.innerWidth - picker.offsetWidth - 14, rect.left))}px`; picker.style.top = `${Math.max(14, Math.min(window.innerHeight - picker.offsetHeight - 14, rect.bottom + 7))}px`;
	try {
		const endpoint = kind === "scene" ? SCENE_LIBRARY_ENDPOINT : `${CHARACTER_LIBRARY_ENDPOINT}?summary=1`; const response = await api.fetchApi(endpoint); const data = await response.json(); if (!response.ok || data?.ok === false) throw new Error(data?.error || "读取资料库失败");
		const allItems = Array.isArray(kind === "scene" ? data.scenes : data.characters) ? (kind === "scene" ? data.scenes : data.characters) : [];
		const getSelection = () => selectionAdapter?.get?.(kind) || librarySelection(node, kind);
		const setSelection = (items) => selectionAdapter?.set ? selectionAdapter.set(kind, items) : saveLibrarySelection(node, kind, items);
		const render = () => { const keyword = search.value.trim().toLowerCase(); const selected = getSelection(); const selectedIds = new Set(selected.map((item) => String(item?.id || item?.name))); const filtered = allItems.filter((item) => !keyword || [libraryDisplayName(item), item?.id, item?.notes, ...(item?.keywords || [])].join(" ").toLowerCase().includes(keyword)); grid.replaceChildren();
			for (const item of filtered) { const id = String(item?.id || libraryDisplayName(item)); const card = document.createElement("button"); card.type = "button"; card.className = `gjj-mh3-library-card${selectedIds.has(id) ? " active" : ""}`; const image = document.createElement("img"); setGjjLibraryThumbnail(image, api, kind === "scene" ? "scene" : "character", item); const name = document.createElement("div"); name.className = "gjj-mh3-library-name"; name.textContent = `${kind === "scene" ? "🏕️" : "@"}${libraryDisplayName(item)}`; card.title = String(item?.notes || libraryDisplayName(item)); card.append(image, name); card.addEventListener("click", () => { const current = getSelection(); const exists = current.some((entry) => String(entry?.id || entry?.name) === id); setSelection(exists ? current.filter((entry) => String(entry?.id || entry?.name) !== id) : [...current, { id, name: libraryDisplayName(item), notes: String(item?.notes || "") }]); render(); }); grid.appendChild(card); }
			if (!filtered.length) { const empty = document.createElement("div"); empty.className = "gjj-mh3-library-empty"; empty.textContent = allItems.length ? "没有匹配项目" : "资料库为空"; grid.appendChild(empty); }
		}; search.addEventListener("input", render); render();
	} catch (error) { grid.textContent = `读取失败：${error?.message || error}`; }
}
function linkedImageCount(node) {
	let count = 0;
	for (const name of MEDIA_INPUTS) {
		const input = mediaInput(node, name); const link = input?.link != null ? graphLink(input.link) : null;
		if (!link || !String(link.type || input?.type || "").toUpperCase().includes("IMAGE")) continue;
		const source = app.graph?.getNodeById?.(link.origin_id); const state = source?.__gjjMultiImageState || source?.__gjjMultiImageLoaderState || {};
		let selected = []; try { const parsed = JSON.parse(String(widget(source, "selected_images")?.value || source?.properties?.selected_images || "[]")); if (Array.isArray(parsed)) selected = parsed; } catch (_) {}
		const candidates = [state.selection, state.executedImages, selected]; let found = 0;
		for (const items of candidates) if (Array.isArray(items) && items.length) { found = items.length; break; }
		const output = source?.outputs?.[Number(link.origin_slot)]; const outputName = String(output?.name || output?.label || "");
		if (/(?:图片|导出图片|image)\s*0*\d+/i.test(outputName)) found = 1;
		if (!found) found = Math.max(0, Number(source?.properties?.gjj_batch_crop_resize_media_count || source?.properties?.gjj_image_batch_multi_input_count || 0));
		count += Math.max(1, found);
	}
	return count;
}
function currentImageCount(node) {
	if (!activeMediaLinks(node)) return internalMediaItems(node).filter((item) => String(item?.media_type || "") === "image").length;
	return linkedImageCount(node) || Math.max(0, Number(node.properties?.[IMAGE_COUNT_PROPERTY] || 0));
}
function branchChoices(count) {
	if (count === 1) return ["参考", "首帧", "尾帧"];
	if (count === 2) return ["参考", "首尾帧"];
	if (count > 2) return ["参考", "分段首尾帧"];
	return [];
}
function syncBranchButtons(node) {
	const panel = node.__gjjMiniMaxPanel; if (!panel?.branches) return;
	const count = currentImageCount(node); const items = branchChoices(count); panel.branches.replaceChildren();
	if (!items.length) { panel.branches.style.display = "none"; return; }
	panel.branches.style.display = "flex";
	let selected = String(value(node, "image_branch", "参考")); if (!items.includes(selected)) { selected = "参考"; setValue(node, "image_branch", selected); }
	const variableName = boundVariable(node, "image_branch");
	for (const label of items) { const button = document.createElement("button"); button.type = "button"; button.className = "gjj-mh3-branch"; button.textContent = label; button.classList.toggle("active", label === selected); button.disabled = Boolean(variableName); button.style.opacity = variableName ? "0.45" : ""; button.title = variableName ? `图片分支已由广播变量“${variableName}”接管` : ""; button.addEventListener("click", () => { if (variableName) return; setValue(node, "image_branch", label); syncBranchButtons(node); }); panel.branches.appendChild(button); }
}
function internalMediaUrl(item) {
	return api.apiURL(`/view?filename=${encodeURIComponent(item?.filename || "")}&type=${encodeURIComponent(item?.type || "input")}&subfolder=${encodeURIComponent(item?.subfolder || "")}&rand=${Date.now()}`);
}
function closeMediaTooltip(node) { clearTimeout(node.__gjjMiniMaxTipTimer); node.__gjjMiniMaxPanel?.tooltip?.remove?.(); if (node.__gjjMiniMaxPanel) node.__gjjMiniMaxPanel.tooltip = null; }
function scheduleMediaTooltipClose(node) { clearTimeout(node.__gjjMiniMaxTipTimer); node.__gjjMiniMaxTipTimer = setTimeout(() => closeMediaTooltip(node), 140); }
function showMediaTooltip(node) {
	const panel = node.__gjjMiniMaxPanel; const items = internalMediaItems(node); if (!panel || !items.length || activeMediaLinks(node)) return;
	closeMediaTooltip(node); const tip = document.createElement("div"); tip.className = "gjj-mh3-media-tip"; protect(tip);
	for (const item of items) {
		const card = document.createElement("div"); card.className = "gjj-mh3-media-card"; const name = document.createElement("div"); name.className = "gjj-mh3-media-name"; name.textContent = item.original_name || item.filename || "素材"; name.title = name.textContent;
		const type = String(item.media_type || ""); let media;
		if (type === "image") { media = document.createElement("img"); media.loading = "lazy"; media.src = internalMediaUrl(item); }
		else if (type === "video") { media = document.createElement("video"); media.src = internalMediaUrl(item); media.muted = true; media.loop = true; media.playsInline = true; media.preload = "metadata"; media.controls = true; }
		else if (type === "audio") { media = document.createElement("audio"); media.src = internalMediaUrl(item); media.preload = "metadata"; media.controls = true; }
		else { media = document.createElement("div"); media.className = "gjj-mh3-media-text"; media.textContent = item.preview_text || "文本素材"; }
		card.append(name, media); tip.appendChild(card);
	}
	document.body.appendChild(tip); const rect = panel.folder.getBoundingClientRect(); const tipRect = tip.getBoundingClientRect(); tip.style.left = `${Math.max(12, Math.min(window.innerWidth - tipRect.width - 12, rect.left))}px`; tip.style.top = `${Math.max(12, Math.min(window.innerHeight - tipRect.height - 12, rect.bottom + 7))}px`;
	tip.addEventListener("mouseenter", () => clearTimeout(node.__gjjMiniMaxTipTimer)); tip.addEventListener("mouseleave", () => scheduleMediaTooltipClose(node)); panel.tooltip = tip;
}
function syncMediaToolbar(node) {
	const panel = node.__gjjMiniMaxPanel; if (!panel) return;
	const linkedMedia = activeMediaLinks(node); const linked = activeManagedLinks(node); const remembered = hasRememberedLinks(node); const loaded = internalMediaItems(node).length > 0;
	panel.folder.disabled = linkedMedia; panel.folder.classList.toggle("loaded", loaded && !linkedMedia); panel.folder.title = linkedMedia ? "外部媒体入口已连接，内部媒体选择已禁用" : (loaded ? `已载入 ${internalMediaItems(node).length} 个内部文件` : "打开图片、文本、音频或视频");
	panel.link.classList.toggle("show", linked || remembered); panel.link.classList.toggle("detached", !linked && remembered); panel.link.title = linked ? "记录并断开上游媒体与提示词链接" : "恢复记录的上游媒体与提示词链接";
}
async function uploadInternalMedia(node, files, append = false) {
	const form = new FormData(); for (const file of files) form.append("media", file, file.name);
	const response = await fetch(api.apiURL(UPLOAD_ROUTE), { method: "POST", body: form }); const data = await response.json().catch(() => ({}));
	if (!response.ok || data?.ok === false) throw new Error(data?.error || "媒体上传失败");
	const uploaded = Array.isArray(data.items) ? data.items : [];
	const items = append ? [...internalMediaItems(node), ...uploaded] : uploaded;
	setValue(node, "internal_media_json", JSON.stringify(items)); if (node.__gjjMiniMaxPanel) node.__gjjMiniMaxPanel.status.textContent = `已载入 ${items.length} 个内部文件`; syncMediaToolbar(node); syncBranchButtons(node);
	return uploaded;
}
function cleanup(node) { closePopups(node); closeLibraryPicker(node); closeMediaTooltip(node); closeMentionEditorMenu(node); node.__gjjMiniMaxPanel?.previewObserver?.disconnect?.(); for (const item of Object.values(node.__gjjMiniMaxPanel?.popups || {})) item.remove(); node.__gjjMentionEditor = null; node.__gjjMiniMaxPanel = null; }
function arrangePanelWidgets(node, toolbarWidget, resultWidget) {
	if (!Array.isArray(node.widgets)) return;
	const backendOrder = persistedWidgetNames(node); const backendSet = new Set(backendOrder); const widgetMap = new Map();
	for (const item of node.widgets) {
		const name = String(item?.name || ""); if (backendSet.has(name) && !widgetMap.has(name)) widgetMap.set(name, item);
		else if (item !== toolbarWidget && item !== resultWidget) { item.serialize = false; item.options ||= {}; item.options.serialize = false; }
	}
	const canonical = backendOrder.map((name) => widgetMap.get(name)).filter(Boolean); const promptIndex = canonical.findIndex((item) => item.name === "prompt");
	if (promptIndex < 0) return; canonical.splice(promptIndex, 0, toolbarWidget); canonical.splice(promptIndex + 2, 0, resultWidget); node.widgets = canonical;
}
function persistedWidgetNames(node) {
	const input = node?.constructor?.nodeData?.input || node?.constructor?.nodeData?.inputs || node?.nodeData?.input || {};
	// ComfyUI 会先创建 required widgets，再创建 optional widgets；按相同顺序持久化，
	// 同时确保 required 中的 prompt 也进入按名称备份，避免重载后恢复为空。
	return [...Object.keys(input?.required || {}), ...Object.keys(input?.optional || {})]
		.filter((name, index, names) => names.indexOf(name) === index && Boolean(widget(node, name)) && name !== PANEL_WIDGET && name !== RESULT_WIDGET);
}
function writeSettingsBackup(node) {
	node.properties ||= {};
	// ⚠️ 改为合并模式：先继承已有 backup，再用当前 widget 值更新。
	// 原因：如果 widget.value 因时机问题（如 ComfyUI 尚未恢复 widgets_values、
	// DOM 未同步等）为空或默认值，完全覆盖会丢失用户之前保存的正确值。
	const oldBackup = (node.properties[SETTINGS_BACKUP_PROPERTY] && typeof node.properties[SETTINGS_BACKUP_PROPERTY] === "object" && !Array.isArray(node.properties[SETTINGS_BACKUP_PROPERTY]))
		? { ...node.properties[SETTINGS_BACKUP_PROPERTY] }
		: {};
	const backup = { ...oldBackup };
	for (const name of persistedWidgetNames(node)) {
		const target = widget(node, name);
		if (!target) continue;
		const currentValue = target.value;
		// prompt 特殊保护：如果当前 widget 值为空但旧 backup 有值，保留旧值
		// 防止 ComfyUI 恢复时序问题导致 prompt 被空值覆盖
		if (name === "prompt") {
			const oldVal = oldBackup[name];
			if ((currentValue == null || String(currentValue).trim() === "") && oldVal != null && String(oldVal).trim() !== "") {
				backup[name] = oldVal;
				continue;
			}
		}
		backup[name] = currentValue;
	}
	node.properties[SETTINGS_BACKUP_PROPERTY] = backup;
	node.properties[PROMPT_BACKUP_PROPERTY] = String(backup.prompt || "");
	return backup;
}
function serializedNamedSettings(serializedNode) {
	const properties = serializedNode?.properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
	const result = {};
	if (properties[SETTINGS_BACKUP_PROPERTY] && typeof properties[SETTINGS_BACKUP_PROPERTY] === "object" && !Array.isArray(properties[SETTINGS_BACKUP_PROPERTY])) {
		result[SETTINGS_BACKUP_PROPERTY] = { ...properties[SETTINGS_BACKUP_PROPERTY] };
	}
	if (Object.prototype.hasOwnProperty.call(properties, PROMPT_BACKUP_PROPERTY)) result[PROMPT_BACKUP_PROPERTY] = String(properties[PROMPT_BACKUP_PROPERTY] ?? "");
	if (Object.prototype.hasOwnProperty.call(properties, SETTINGS_SCHEMA_PROPERTY)) result[SETTINGS_SCHEMA_PROPERTY] = Number(properties[SETTINGS_SCHEMA_PROPERTY] || 0);
	return Object.keys(result).length ? result : null;
}
function restoreSerializedNamedSettings(node, saved) {
	if (!saved) return;
	node.properties ||= {};
	// 只按属性名恢复；禁止读取 widgets_values 或使用任何数组位置推断参数。
	for (const [name, value] of Object.entries(saved)) node.properties[name] = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : value;
}
function ensureSettingsPersistence(node) {
	node.properties ||= {}; let backup = node.properties[SETTINGS_BACKUP_PROPERTY]; const currentSchema = Number(node.properties[SETTINGS_SCHEMA_PROPERTY] || 0);
	if (currentSchema !== SETTINGS_SCHEMA_VERSION || !backup || typeof backup !== "object" || Array.isArray(backup)) {
		const legacyPrompt = String(node.properties[PROMPT_BACKUP_PROPERTY] || "");
		const oldBackup = (backup && typeof backup === "object" && !Array.isArray(backup)) ? { ...backup } : {};
		backup = {};
		for (const name of persistedWidgetNames(node)) {
			// 升级 schema 时优先保留：旧 backup(按名称) > 当前 widget.value(原生加载的可能错位值) > declaredDefault
			// 这样即使跨版本升级也能最大程度保留用户已保存的参数
			const candidate = Object.prototype.hasOwnProperty.call(oldBackup, name)
				? oldBackup[name]
				: (widget(node, name)?.value ?? declaredDefault(node, name));
			backup[name] = declaredDefault(node, name); // 先占位默认值，防止类型错误
			backup[name] = normalizedSettingValue(node, name, candidate);
		}
		if (legacyPrompt) backup.prompt = legacyPrompt;
		node.properties[SETTINGS_BACKUP_PROPERTY] = backup; node.properties[SETTINGS_SCHEMA_PROPERTY] = SETTINGS_SCHEMA_VERSION;
	}
	for (const name of persistedWidgetNames(node)) {
		const target = widget(node, name); if (!target) continue;
		// ✅ 必须保持 serialize=true：ComfyUI 构造 prompt.inputs 时会遍历 widget，
		// 只有 serialize=true 的 widget 才会按名称进入 prompt 发送给后端执行。
		// 解决错位的策略：onConfigure 时先用原生 widgets_values(可能错位) 恢复，
		// 然后立刻用 properties 按名称覆盖 widget.value，保证结果始终正确。
		target.serialize = true;
		target.options ||= {}; target.options.serialize = true;

		// ⚠️ prompt 特殊处理：优先从 PROMPT_BACKUP_PROPERTY 恢复
		// PROMPT_BACKUP_PROPERTY 是独立的、始终同步的 prompt 备份，
		// 比 SETTINGS_BACKUP_PROPERTY.prompt 更可靠（不会被合并逻辑意外清空）
		if (name === "prompt") {
			const promptBackup = String(node.properties[PROMPT_BACKUP_PROPERTY] || "");
			if (promptBackup) {
				backup.prompt = promptBackup;
			} else if (!Object.prototype.hasOwnProperty.call(backup, "prompt")) {
				backup.prompt = String(target.value ?? "");
			}
		}

		// ⚠️ 强制按名称从 backup 覆盖 widget.value，无论原生 widgets_values 是否错位。
		// 这是修复「重启 ComfyUI 参数错位」的核心：原生按索引、GJJ 按名称双轨并行，
		// 但名称映射的优先级始终高于索引数组。
		if (Object.prototype.hasOwnProperty.call(backup, name)) {
			target.value = normalizedSettingValue(node, name, backup[name]);
		} else {
			backup[name] = normalizedSettingValue(node, name, target.value);
		}
		if (!target.__gjjSettingsPersistence) {
			const original = target.callback;
			target.callback = function (nextValue, ...args) {
				node.properties ||= {}; node.properties[SETTINGS_BACKUP_PROPERTY] ||= {};
				const finalValue = (nextValue != null) ? nextValue : target.value;
				node.properties[SETTINGS_BACKUP_PROPERTY][name] = finalValue;
				if (name === "prompt") node.properties[PROMPT_BACKUP_PROPERTY] = String(finalValue ?? "");
				return original?.call(this, nextValue, ...args);
			};
			target.__gjjSettingsPersistence = true;
		}
	}
	node.properties[PROMPT_BACKUP_PROPERTY] = String(backup.prompt || "");
}
function fitPanel(node) {
	if (node.__gjjMiniMaxFitting) return;
	node.__gjjMiniMaxFitting = true;
	requestAnimationFrame(() => {
		try {
			const panel = node.__gjjMiniMaxPanel;
			if (panel?.preview && !panel.video?.getAttribute?.("src")) {
				panel.preview.style.display = "none";
				panel.preview.style.height = "0";
				panel.resultRoot.style.display = "none";
			}
			const width = Math.max(280, Number(node.size?.[0] || 420));
			if (Array.isArray(node.size)) node.size[1] = 1;
			const computed = node.computeSize?.(); const height = Math.max(140, Number(computed?.[1] || 140));
			node.__gjjMiniMaxFixedHeight = Math.max(0, height - Number(node.__gjjMiniMaxPromptHeight || PROMPT_DEFAULT_HEIGHT));
			node.setSize?.([width, height]); node.__gjjMiniMaxLastNodeHeight = height; app.graph?.setDirtyCanvas?.(true, true);
		} finally { node.__gjjMiniMaxFitting = false; }
	});
}
function fitPanelOnceAfterLoad(node) {
	if (node.__gjjMiniMaxLoadFitDone || node.__gjjMiniMaxLoadFitTimer) return;
	node.__gjjMiniMaxLoadFitTimer = setTimeout(() => {
		node.__gjjMiniMaxLoadFitTimer = null;
		if (node.__gjjMiniMaxLoadFitDone) return;
		if (!node.graph || !node.__gjjMiniMaxPanel) { fitPanelOnceAfterLoad(node); return; }
		node.__gjjMiniMaxLoadFitDone = true;
		syncBranchButtons(node);
		fitPanel(node);
	}, 300);
}
function syncBroadcastUI(node) {
	updateTemplateSourcePanel(node, TEMPLATE_SOURCE_FIELDS);
	for (const control of node.__gjjMiniMaxPanel?.root?.querySelectorAll?.("[data-widget-name]") || []) applyBoundState(node, control.dataset.widgetName, control);
	for (const popupRoot of Object.values(node.__gjjMiniMaxPanel?.popups || {})) for (const control of popupRoot?.querySelectorAll?.("[data-widget-name]") || []) applyBoundState(node, control.dataset.widgetName, control);
	applyBoundState(node, "randomize_seed", node.__gjjMiniMaxPanel?.seedButton);
	node.__gjjMiniMaxPanel?.popups?.size?.__gjjSizePanel?.__gjjSync?.();
	node.__gjjMiniMaxPanel?.popups?.model?.__gjjReasoningPanel?.__gjjSync?.();
	syncBranchButtons(node);
	syncMainSizeButton(node);
}
function syncMainSizeButton(node) {
	const button = node.__gjjMiniMaxPanel?.buttons?.size; if (!button) return;
	const video = Boolean(value(node, "use_video_size", false));
	const source = Boolean(value(node, "use_source_size", true)) && !video;
	button.classList.toggle("gjj-mh3-source-size", source || video);
	button.title = video ? "尺寸参数（当前使用第一个视频尺寸）" : (source ? "尺寸参数（当前使用首图尺寸）" : "尺寸参数（当前使用画板或百万像素尺寸）");
}
function applyPromptHeight(node, rawHeight) {
	const target = widget(node, "prompt"); if (!target) return;
	const height = Math.max(PROMPT_MIN_HEIGHT, Math.round(Number(rawHeight || PROMPT_DEFAULT_HEIGHT)));
	node.__gjjMiniMaxPromptHeight = height; target.computedHeight = height; target.size = [Math.max(0, Number(node.size?.[0] || 420) - 20), height]; target.computeSize = (width) => [Math.max(0, Number(width || node.size?.[0] || 420) - 20), height]; target.getHeight = () => height;
	const element = target.inputEl || target.element; if (element?.style) { element.style.height = `${height}px`; element.style.minHeight = `${PROMPT_MIN_HEIGHT}px`; element.style.maxHeight = "none"; }
}
function resizePromptOnly(node, nextSize) {
	const nextHeight = Number(nextSize?.[1] ?? node.size?.[1]); if (!Number.isFinite(nextHeight)) return;
	node.__gjjMiniMaxLastNodeHeight = nextHeight;
	if (node.__gjjMiniMaxFitting) return;
	const fixedHeight = Number(node.__gjjMiniMaxFixedHeight); if (!Number.isFinite(fixedHeight)) return;
	const nextPromptHeight = Math.max(PROMPT_MIN_HEIGHT, nextHeight - fixedHeight); if (Math.abs(nextPromptHeight - Number(node.__gjjMiniMaxPromptHeight || 0)) < 0.5) return;
	applyPromptHeight(node, nextPromptHeight); app.graph?.setDirtyCanvas?.(true, true);
}
function createPanel(node) {
	if (node.__gjjMiniMaxPanel) return; installStyle();
	const root = document.createElement("div"); root.className = "gjj-mh3-root"; protect(root);
	const toolbar = document.createElement("div"); toolbar.className = "gjj-mh3-toolbar";
	const libraryChips = document.createElement("div"); libraryChips.className = "gjj-mh3-library-chips";
	const folder = makeButton("📁", "打开图片、文本、音频或视频", "gjj-mh3-folder"); const link = makeButton("🔗", "记录并断开/恢复上游媒体与提示词接口", "gjj-mh3-link");
	const file = document.createElement("input"); file.type = "file"; file.multiple = true; file.accept = "image/*,text/plain,.txt,.md,.prompt,audio/*,video/*"; file.style.display = "none"; root.appendChild(file);
	const run = makeButton("▶️", "运行当前 MiniMax H3 节点", "gjj-mh3-run");
	const sceneButton = makeButton("🏕️", "选择场景库引用", "gjj-mh3-library-button"); const actorButton = makeButton("👤", "选择角色库引用", "gjj-mh3-library-button");
	const director = makeButton("🎞️", "导演台：逐帧切割和编辑分镜"); const size = makeButton("📐", "尺寸参数"); const seed = makeButton("🎲", "随机种子"); const model = makeButton("🧠", "模型参数"); const spectrum = makeButton("🚀", "Spectrum MiniMax H3 加速设置", "gjj-mh3-spectrum"); const promptBook = makeButton("📒", "全局、负面与替换提示词"); const settings = makeButton("⚙️", "生成参数");
	const variables = createTemplateSourceButton(node, TEMPLATE_SOURCE_FIELDS); variables.classList.add("gjj-mh3-btn"); variables.style.height = "32px"; variables.style.minWidth = "36px"; variables.style.width = "36px"; variables.style.flex = "0 0 36px"; variables.style.padding = "0"; variables.style.margin = "0"; variables.style.borderRadius = "0";
	toolbar.append(folder, link, sceneButton, actorButton, director, size, seed, model, spectrum, promptBook, variables, settings, run);
	const resultRoot = document.createElement("div"); resultRoot.className = "gjj-mh3-root"; protect(resultRoot);
	resultRoot.style.display = "none";
	const branches = document.createElement("div"); branches.className = "gjj-mh3-branches";
	const status = document.createElement("div"); status.className = "gjj-mh3-status"; status.textContent = "图片数量决定可选生成分支";
	const preview = document.createElement("div"); preview.className = "gjj-mh3-preview"; const video = document.createElement("video"); video.controls = true; video.loop = true; video.playsInline = true; video.preload = "metadata";
	preview.style.display = "none"; preview.style.height = "0";
	const previewNav = document.createElement("div"); previewNav.className = "gjj-mh3-preview-nav"; const previewPrev = document.createElement("button"); previewPrev.type = "button"; previewPrev.textContent = "‹"; previewPrev.title = "上一片段"; const previewLabel = document.createElement("span"); previewLabel.className = "gjj-mh3-preview-label"; const previewNext = document.createElement("button"); previewNext.type = "button"; previewNext.textContent = "›"; previewNext.title = "下一片段"; previewNav.append(previewPrev, previewLabel, previewNext); preview.append(video, previewNav); protect(preview);
	const mentionEditor = createMentionPromptEditor(node);
	root.append(toolbar, libraryChips, mentionEditor, branches, status); resultRoot.append(preview);
	const dom = node.addDOMWidget(PANEL_WIDGET, "div", root, { serialize: false, hideOnZoom: false }); dom.serialize = false; dom.options ||= {}; dom.options.serialize = false; dom.computeSize = () => [Math.max(0, Number(node.size?.[0] || 0) - 20), Math.max(40, Number(root.scrollHeight || 40))]; dom.getHeight = () => Math.max(40, Number(root.scrollHeight || 40));
	const resultDom = node.addDOMWidget(RESULT_WIDGET, "div", resultRoot, { serialize: false, hideOnZoom: false }); resultDom.serialize = false; resultDom.options ||= {}; resultDom.options.serialize = false; resultDom.computeSize = () => {
		const hasPreview = Boolean(video.getAttribute("src")) && preview.style.display !== "none";
		return [Math.max(0, Number(node.size?.[0] || 0) - 20), hasPreview ? Math.max(1, Number(resultRoot.scrollHeight || preview.offsetHeight || 1)) : 0];
	}; resultDom.getHeight = () => Number(resultDom.computeSize?.()[1] || 0);
	arrangePanelWidgets(node, dom, resultDom);
	const panel = node.__gjjMiniMaxPanel = { root, resultRoot, branches, status, preview, video, previewNav, previewPrev, previewNext, previewLabel, previewEntries: new Map(), activePreviewKey: null, folder, link, sceneButton, actorButton, libraryChips, libraryPicker: null, seedButton: seed, spectrumButton: spectrum, variables, buttons: { director, size, seed, model, spectrum, promptBook, settings }, popups: {} };
	panel.popups.params = popup(node, "params", "生成参数"); panel.popups.director = popup(node, "director", "🎞️ 导演台"); panel.popups.size = popup(node, "size", "📐 尺寸"); panel.popups.model = popup(node, "model", "模型参数"); panel.popups.spectrum = popup(node, "spectrum", "🚀 Spectrum 加速"); panel.popups.promptBook = popup(node, "promptBook", "📒 提示词");
	const turnPreview = (offset) => { const entries = orderedPreviewEntries(panel); const index = entries.findIndex((entry) => entry.key === panel.activePreviewKey); const target = entries[index + offset]; if (target) showStoredPreview(node, target.key); };
	previewPrev.addEventListener("click", () => turnPreview(-1)); previewNext.addEventListener("click", () => turnPreview(1));
	run.addEventListener("click", async () => { closePopups(node); resetResultPreview(node); status.textContent = "正在提交当前节点…"; await queueOnlyCurrentNode(node); });
	folder.addEventListener("click", () => { if (!folder.disabled) file.click(); }); file.addEventListener("change", async () => { const files = Array.from(file.files || []); file.value = ""; if (!files.length) return; try { status.textContent = "正在载入媒体…"; await uploadInternalMedia(node, files); } catch (error) { status.textContent = `载入失败：${error?.message || error}`; } });
	folder.addEventListener("mouseenter", () => showMediaTooltip(node)); folder.addEventListener("mouseleave", () => scheduleMediaTooltipClose(node));
	link.addEventListener("click", () => toggleMediaLinks(node));
	sceneButton.addEventListener("click", () => toggleLibraryPicker(node, "scene", sceneButton)); actorButton.addEventListener("click", () => toggleLibraryPicker(node, "actor", actorButton));
	director.addEventListener("click", () => openPopup(node, "director", director)); size.addEventListener("click", () => openPopup(node, "size", size)); model.addEventListener("click", () => openPopup(node, "model", model)); spectrum.addEventListener("click", () => openPopup(node, "spectrum", spectrum)); promptBook.addEventListener("click", () => openPopup(node, "promptBook", promptBook)); settings.addEventListener("click", () => openPopup(node, "params", settings));
	const syncSeed = () => { const enabled = Boolean(value(node, "randomize_seed", true)); seed.classList.toggle("active", enabled); if (!boundVariable(node, "randomize_seed")) seed.title = enabled ? "随机种子已开启" : "随机种子已关闭"; }; seed.addEventListener("click", () => { if (boundVariable(node, "randomize_seed")) return; setValue(node, "randomize_seed", !Boolean(value(node, "randomize_seed", true))); syncSeed(); }); applyPromptHeight(node, node.__gjjMiniMaxPromptHeight || PROMPT_DEFAULT_HEIGHT); syncSeed(); syncDirectorButton(node); syncSpectrumButton(node); syncLibraryButtons(node); syncMediaToolbar(node); syncBranchButtons(node); syncBroadcastUI(node); fitPanel(node);
}
// ⚠️ 关键修复：hook prompt widget 的 DOM 事件，实时同步到 properties
// 原因：ComfyUI 原生 multiline STRING widget 用户输入时只更新 widget.value，
// 不会触发 widget.callback，导致 ensureSettingsPersistence 中的 callback hook 永远不执行，
// properties[SETTINGS_BACKUP_PROPERTY].prompt 不会被实时更新。
// 虽然 onSerialize 时 writeSettingsBackup 会从 widget.value 读取，
// 但如果存在时序问题（如 ComfyUI 延迟恢复），prompt 值就会丢失。
// 通过 hook DOM input 事件，确保每次用户输入都实时更新 properties。
function hookPromptWidget(node) {
	const target = widget(node, "prompt");
	if (!target || target.__gjjPromptHooked) return;
	target.__gjjPromptHooked = true;

	// 实时同步函数：从 DOM/widget 读取最新值并写入 properties
	const syncToProperties = (rawValue) => {
		const finalValue = (rawValue != null) ? String(rawValue) : String(target.value ?? "");
		node.properties ||= {};
		node.properties[SETTINGS_BACKUP_PROPERTY] ||= {};
		node.properties[SETTINGS_BACKUP_PROPERTY].prompt = finalValue;
		node.properties[PROMPT_BACKUP_PROPERTY] = finalValue;
		schedulePromptLibrarySync(node);
	};

	// hook DOM 元素的 input/change/blur 事件
	// ComfyUI STRING multiline widget 的 DOM 元素通常在 inputEl（textarea）或 element 上
	const elements = [target.inputEl, target.element].filter(Boolean);
	for (const el of elements) {
		if (el.addEventListener) {
			el.addEventListener("input", () => syncToProperties(el.value));
			el.addEventListener("change", () => syncToProperties(el.value));
			el.addEventListener("blur", () => syncToProperties(el.value));
		}
	}

	// 同时保留 callback hook（覆盖式更新，防止重复 hook）
	const originalCallback = target.callback;
	target.callback = function (nextValue, ...args) {
		syncToProperties(nextValue);
		return originalCallback?.call(this, nextValue, ...args);
	};
}
function syncPromptBackupFromWidget(node) {
	const target = widget(node, "prompt"); if (!target) return;
	const current = String(target.value ?? "");
	node.properties ||= {}; node.properties[SETTINGS_BACKUP_PROPERTY] ||= {};
	const saved = String(node.properties[PROMPT_BACKUP_PROPERTY] ?? node.properties[SETTINGS_BACKUP_PROPERTY].prompt ?? "");
	// 原生 multiline widget 在部分前端版本中输入时不触发 callback；画布绘制时
	// 对非空变化做兜底同步。空值仍由 callback/onSerialize 处理，避免加载时短暂空值覆盖备份。
	if (current && current !== saved) {
		node.properties[SETTINGS_BACKUP_PROPERTY].prompt = current;
		node.properties[PROMPT_BACKUP_PROPERTY] = current;
	}
	schedulePromptLibrarySync(node);
	void syncMentionPromptEditor(node);
}
function stabilizeLogic(node) {
	// ⚠️ 纯逻辑（无 DOM 依赖）：必须同步执行，确保原生 widgets_values 错位后立刻被按名称覆盖
	if (String(node?.comfyClass || node?.type || "") !== NODE_TYPE) return;
	node.color = "#2b727e"; node.bgcolor = "#11191d"; node.boxcolor = "#6eb6c0";
	ensureSettingsPersistence(node);
	repairSerializedSettings(node);
	// ⚠️ 不再调用 writeSettingsBackup！
	// 原因：stabilizeLogic 在 onConfigure 中同步执行，此时 ComfyUI 可能尚未恢复
	// widgets_values，widget.value 可能是默认空值。如果此时调用 writeSettingsBackup，
	// 会用空值覆盖 properties 中之前保存的正确值（特别是 prompt 会被清空）。
	// writeSettingsBackup 只在 onSerialize（保存工作流）时调用即可。
}
function stabilizeUI(node) {
	// DOM 相关：依赖 widget/节点已挂载到画布，允许延后执行
	if (String(node?.comfyClass || node?.type || "") !== NODE_TYPE) return;
	ensureExternalPromptInput(node);
	hideBackendWidgets(node);
	createPanel(node);
	hookPromptWidget(node);   // ⚠️ 关键：hook prompt DOM 事件，实时同步到 properties
	void syncMentionPromptEditor(node);
	syncMediaToolbar(node);
	syncBranchButtons(node);
	syncBroadcastUI(node);
	schedulePromptLibrarySync(node);
}
function stabilize(node) {
	stabilizeLogic(node);
	stabilizeUI(node);
}
app.registerExtension({
	name: "Comfy.GJJ.MiniMaxH3Studio",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_TYPE) return;
		const created = nodeType.prototype.onNodeCreated; nodeType.prototype.onNodeCreated = function (...args) {
			const result = created?.apply(this, args);
			// 新节点创建阶段不生成空的命名备份；否则加载工作流时可能先用空值覆盖保存值。
			this.color = "#2b727e"; this.bgcolor = "#11191d"; this.boxcolor = "#6eb6c0";
			// DOM 面板允许延后，确保节点已加入画布、尺寸可计算
			setTimeout(() => stabilizeUI(this), 0);
			setTimeout(() => stabilizeUI(this), 100);
			return result;
		};
		const configured = nodeType.prototype.onConfigure; nodeType.prototype.onConfigure = function (...args) {
			// 在任何原生配置代码运行前捕获工作流里的命名属性。原生 widgets_values 即使
			// 发生错位也不会参与本节点的恢复决策。
			const savedNamedSettings = serializedNamedSettings(args[0]);
			const result = configured?.apply(this, args);
			restoreSerializedNamedSettings(this, savedNamedSettings);
			stabilizeLogic(this);
			// 延迟阶段仍先恢复同一份命名属性，再按变量名覆盖 widget，绝不按位置恢复。
			for (const delay of [0, 50, 200]) setTimeout(() => { restoreSerializedNamedSettings(this, savedNamedSettings); stabilizeLogic(this); stabilizeUI(this); }, delay);
			fitPanelOnceAfterLoad(this);
			return result;
		};
		const connections = nodeType.prototype.onConnectionsChange; nodeType.prototype.onConnectionsChange = function (...args) {
			const result = connections?.apply(this, args);
			// ComfyUI 各前端版本更新 input.link 与 graph.links 的时机不同；连接和断开后
			// 分阶段复查真实连线，确保禁用态无需刷新页面即可可靠切换。
			for (const delay of [0, 50, 200, 500]) setTimeout(() => {
				stabilizeLogic(this); stabilizeUI(this); void syncMentionPromptEditor(this);
			}, delay);
			return result;
		};
		const resized = nodeType.prototype.onResize; nodeType.prototype.onResize = function (size) { const result = resized?.apply(this, arguments); resizePromptOnly(this, size || this.size); return result; };
		const drawn = nodeType.prototype.onDrawForeground; nodeType.prototype.onDrawForeground = function (...args) { syncPromptBackupFromWidget(this); return drawn?.apply(this, args); };
		const removed = nodeType.prototype.onRemoved; nodeType.prototype.onRemoved = function (...args) { if (this.__gjjMiniMaxLoadFitTimer) clearTimeout(this.__gjjMiniMaxLoadFitTimer); if (this.__gjjMiniMaxLibraryParseTimer) clearTimeout(this.__gjjMiniMaxLibraryParseTimer); cleanup(this); return removed?.apply(this, args); };
		const serialized = nodeType.prototype.onSerialize; nodeType.prototype.onSerialize = function (data) {
			// ✅ 保存时：先同步刷新一次 properties backup（按名称），确保 data.properties 中
			// 的 SETTINGS_BACKUP_PROPERTY 是完整且按名称映射的，与节点类型解耦。
			const backup = writeSettingsBackup(this);
			this.properties[SETTINGS_SCHEMA_PROPERTY] = SETTINGS_SCHEMA_VERSION;
			const result = serialized?.apply(this, arguments);
			data.properties ||= {};
			data.properties[SETTINGS_BACKUP_PROPERTY] = backup;
			data.properties[PROMPT_BACKUP_PROPERTY] = String(backup.prompt || "");
			data.properties[SETTINGS_SCHEMA_PROPERTY] = SETTINGS_SCHEMA_VERSION;
			return result;
		};
		const executed = nodeType.prototype.onExecuted; nodeType.prototype.onExecuted = function (message) { const result = executed?.apply(this, arguments); this.properties ||= {}; this.properties[IMAGE_COUNT_PROPERTY] = Number(message?.source_image_count?.[0] || 0); if (this.__gjjMiniMaxPanel) this.__gjjMiniMaxPanel.status.textContent = `${message?.mode?.[0] || "视频"} 已完成`; void addParsedLibraryButtons(this, "actor", message?.parsed_actors); void addParsedLibraryButtons(this, "scene", message?.parsed_scenes); syncBranchButtons(this); renderResultPreview(this, message); return result; };
	},
	setup() {
		api.addEventListener("executing", (event) => { const detail = event?.detail; const nodeId = detail && typeof detail === "object" ? detail.node : detail; if (nodeId == null) return; const node = app.graph?.getNodeById?.(nodeId); if (String(node?.comfyClass || node?.type || "") === NODE_TYPE) resetResultPreview(node); });
		api.addEventListener("gjj_node_progress", (event) => { const detail = event?.detail || {}; for (const node of app.graph?._nodes || []) if (String(node?.comfyClass) === NODE_TYPE && String(node.id) === String(detail.node) && node.__gjjMiniMaxPanel) { if (Array.isArray(detail.parsed_actors) || Array.isArray(detail.parsed_scenes)) resetResultPreview(node); node.__gjjMiniMaxPanel.status.textContent = String(detail.text || "处理中…"); if (Array.isArray(detail.parsed_actors)) void addParsedLibraryButtons(node, "actor", detail.parsed_actors); if (Array.isArray(detail.parsed_scenes)) void addParsedLibraryButtons(node, "scene", detail.parsed_scenes); if (detail.preview_media || detail.preview_video || detail.gifs || detail.animated || detail.videos || detail.video || detail.output_path) renderResultPreview(node, detail); } });
		if (!window.__gjjMiniMaxH3TemplateSourceListener) { window.__gjjMiniMaxH3TemplateSourceListener = true; const refresh = () => setTimeout(() => { for (const node of app.graph?._nodes || []) if (String(node?.comfyClass || node?.type || "") === NODE_TYPE) syncBroadcastUI(node); }, 50); window.addEventListener("gjj-generation-template-sources-updated", refresh); window.addEventListener("gjj-variable-broadcast-updated", refresh); window.addEventListener("gjj-template-params-updated", refresh); }
		window.addEventListener("pointerdown", (event) => { if (event.target?.closest?.(".gjj-mh3-library")) return; for (const node of app.graph?._nodes || []) if (String(node?.comfyClass) === NODE_TYPE) closeLibraryPicker(node); if (event.target?.closest?.(".gjj-mh3-pop,.gjj-mh3-btn")) return; for (const node of app.graph?._nodes || []) if (String(node?.comfyClass) === NODE_TYPE) closePopups(node); }, true);
	},
});
