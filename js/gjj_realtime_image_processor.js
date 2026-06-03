import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

const TARGET_CLASS = "GJJ_RealtimeImageProcessor";
const CONFIG_WIDGET = "config_json";
const INTERNAL_FILE_WIDGET = "internal_file";
const PANEL_WIDGET = "gjj_realtime_image_processor_panel";
const HIDDEN_WIDGETS = new Set([CONFIG_WIDGET, INTERNAL_FILE_WIDGET]);
const MIN_WIDTH = 520;
const MIN_PREVIEW_HEIGHT = 220;
const DEFAULT_IMAGE_URL = "https://raw.githubusercontent.com/Comfy-Org/example_workflows/main/flux/krea/flux1_krea_dev.png";
const MEDIA_COPY_SUBDIR = "GJJ_RealtimeImageProcessor";

const CATEGORIES = [
	{ id: "color", label: "🎨调色", title: "基础光影色彩" },
	{ id: "geometry", label: "📐几何", title: "尺寸方位" },
	{ id: "detail", label: "🔎细节", title: "模糊与锐化" },
	{ id: "pixel", label: "🧱像素", title: "像素形态处理" },
	{ id: "blend", label: "🧪叠加", title: "双图简易合成" },
	{ id: "filter", label: "✨滤镜", title: "轻量预制特效" },
	{ id: "channel", label: "🧬通道", title: "通道与透明处理" },
	{ id: "crop", label: "✂️修整", title: "画面裁切修整" },
];

const OPS = [
	op("color", "brightness", "☀️亮度", [{ k: "amount", l: "亮度", min: -1, max: 1, step: 0.01, d: 0 }]),
	op("color", "contrast", "◐对比度", [{ k: "amount", l: "对比", min: -1, max: 1, step: 0.01, d: 0 }]),
	op("color", "saturation", "🌈饱和度", [{ k: "amount", l: "饱和", min: -1, max: 2, step: 0.01, d: 0 }]),
	op("color", "hue", "🌀色相", [{ k: "degrees", l: "角度", min: -180, max: 180, step: 1, d: 0, unit: "°" }]),
	op("color", "lightness", "💡明度", [{ k: "amount", l: "明度", min: -1, max: 1, step: 0.01, d: 0 }]),
	op("color", "gamma", "γ伽马", [{ k: "gamma", l: "Gamma", min: 0.1, max: 4, step: 0.01, d: 1 }]),
	op("color", "levels", "▥色阶", [
		{ k: "black", l: "黑场", min: 0, max: 0.95, step: 0.01, d: 0 },
		{ k: "gray", l: "灰场", min: 0.1, max: 3, step: 0.01, d: 1 },
		{ k: "white", l: "白场", min: 0.05, max: 1, step: 0.01, d: 1 },
	]),
	op("color", "rgb_channels", "🔴RGB单通道", [
		{ k: "red", l: "红", min: 0, max: 2, step: 0.01, d: 1 },
		{ k: "green", l: "绿", min: 0, max: 2, step: 0.01, d: 1 },
		{ k: "blue", l: "蓝", min: 0, max: 2, step: 0.01, d: 1 },
	]),
	op("color", "hsl_channels", "🎚HSL分通道", [
		{ k: "hue", l: "H偏移", min: -180, max: 180, step: 1, d: 0, unit: "°" },
		{ k: "saturation", l: "S增减", min: -1, max: 2, step: 0.01, d: 0 },
		{ k: "lightness", l: "L增减", min: -1, max: 1, step: 0.01, d: 0 },
	]),
	op("color", "invert", "🔁反色/负片", [{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 1 }]),
	op("color", "grayscale", "⚫去色黑白", [{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 1 }]),
	op("color", "white_balance", "⚖️白平衡", [
		{ k: "temperature", l: "冷暖", min: -1, max: 1, step: 0.01, d: 0 },
		{ k: "tint", l: "洋红/绿色", min: -1, max: 1, step: 0.01, d: 0 },
	]),
	op("color", "color_shift", "🎛色彩偏移", [{ k: "amount", l: "偏移", min: -1, max: 1, step: 0.01, d: 0 }]),
	op("color", "color_temp", "🌡色温", [{ k: "temperature", l: "冷暖", min: -1, max: 1, step: 0.01, d: 0 }]),
	op("color", "highlight_recover", "🌤高光压暗", [{ k: "amount", l: "压暗", min: 0, max: 1, step: 0.01, d: 0 }]),
	op("color", "shadow_lift", "🌘阴影提亮", [{ k: "amount", l: "提亮", min: 0, max: 1, step: 0.01, d: 0 }]),
	op("color", "exposure", "📸曝光", [{ k: "ev", l: "EV", min: -4, max: 4, step: 0.01, d: 0 }]),
	op("color", "split_tone", "🌗色调分离", [
		{ k: "shadow_hue", l: "阴影色相", min: 0, max: 360, step: 1, d: 220, unit: "°" },
		{ k: "highlight_hue", l: "高光色相", min: 0, max: 360, step: 1, d: 35, unit: "°" },
		{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 0 },
	]),
	op("color", "auto_levels", "🪄自动色阶", [{ k: "strength", l: "强度", min: 0, max: 1, step: 0.01, d: 1 }]),
	op("color", "auto_contrast", "🪄自动对比", [{ k: "strength", l: "强度", min: 0, max: 1, step: 0.01, d: 1 }]),
	op("color", "auto_white_balance", "🪄自动白平衡", [{ k: "strength", l: "强度", min: 0, max: 1, step: 0.01, d: 1 }]),

	op("geometry", "rotate", "↻任意旋转", [{ k: "angle", l: "角度", min: -180, max: 180, step: 1, d: 0, unit: "°" }]),
	op("geometry", "flip_h", "↔水平镜像", [{ k: "enabled", l: "启用", min: 0, max: 1, step: 1, d: 1 }]),
	op("geometry", "flip_v", "↕垂直镜像", [{ k: "enabled", l: "启用", min: 0, max: 1, step: 1, d: 1 }]),
	op("geometry", "scale", "🔍缩放", [
		{ k: "x", l: "宽度倍数", min: 0.1, max: 3, step: 0.01, d: 1 },
		{ k: "y", l: "高度倍数", min: 0.1, max: 3, step: 0.01, d: 1 },
	]),
	op("geometry", "crop", "▣自定义裁剪", [
		{ k: "width", l: "宽度比例", min: 0.05, max: 1, step: 0.01, d: 1 },
		{ k: "height", l: "高度比例", min: 0.05, max: 1, step: 0.01, d: 1 },
	]),
	op("geometry", "pad", "⬚边缘补边", [
		{ k: "size", l: "补边比例", min: 0, max: 0.5, step: 0.01, d: 0 },
		{ k: "value", l: "填充值", min: 0, max: 1, step: 0.01, d: 0 },
	]),
	op("geometry", "translate", "↗位移平移", [
		{ k: "x", l: "水平", min: -1, max: 1, step: 0.01, d: 0 },
		{ k: "y", l: "垂直", min: -1, max: 1, step: 0.01, d: 0 },
	]),
	op("geometry", "perspective", "◇透视微调", [
		{ k: "x", l: "水平倾斜", min: -0.8, max: 0.8, step: 0.01, d: 0 },
		{ k: "y", l: "垂直倾斜", min: -0.8, max: 0.8, step: 0.01, d: 0 },
	]),
	op("geometry", "aspect_crop", "□等比例裁切", [{ k: "ratio", l: "宽高比", min: 0.2, max: 4, step: 0.01, d: 1 }]),
	op("geometry", "exif_orient", "🧭旋转修正", [{ k: "quarter_turns", l: "90°次数", min: 0, max: 3, step: 1, d: 0 }]),

	op("detail", "gaussian_blur", "🌫高斯模糊", [{ k: "radius", l: "半径", min: 0, max: 12, step: 1, d: 0 }]),
	op("detail", "mean_blur", "▫️均值模糊", [{ k: "radius", l: "半径", min: 0, max: 12, step: 1, d: 0 }]),
	op("detail", "box_blur", "◻方框模糊", [{ k: "radius", l: "半径", min: 0, max: 12, step: 1, d: 0 }]),
	op("detail", "bilateral_blur", "🫧双边近似", [
		{ k: "radius", l: "半径", min: 0, max: 12, step: 1, d: 0 },
		{ k: "strength", l: "强度", min: 0, max: 1, step: 0.01, d: 0.4 },
	]),
	op("detail", "radial_blur", "⭕径向模糊", [{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 0 }]),
	op("detail", "motion_blur", "💨运动模糊", [
		{ k: "radius", l: "半径", min: 0, max: 18, step: 1, d: 0 },
		{ k: "angle", l: "角度", min: -180, max: 180, step: 1, d: 0, unit: "°" },
	]),
	op("detail", "usm_sharpen", "🗡USM锐化", [
		{ k: "amount", l: "强度", min: 0, max: 3, step: 0.01, d: 0 },
		{ k: "radius", l: "半径", min: 0.5, max: 8, step: 0.5, d: 1 },
	]),
	op("detail", "smart_sharpen", "💎智能锐化", [
		{ k: "amount", l: "强度", min: 0, max: 3, step: 0.01, d: 0 },
		{ k: "threshold", l: "阈值", min: 0, max: 0.25, step: 0.01, d: 0.03 },
	]),
	op("detail", "edge_sharpen", "⚡边缘锐化", [{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 0 }]),
	op("detail", "denoise", "🧼降噪平滑", [{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 0 }]),
	op("detail", "skin_blur", "🪞局部磨皮", [{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 0 }]),
	op("detail", "channel_sharpen", "📺分通道锐化", [
		{ k: "red", l: "红", min: 0, max: 2, step: 0.01, d: 0 },
		{ k: "green", l: "绿", min: 0, max: 2, step: 0.01, d: 0 },
		{ k: "blue", l: "蓝", min: 0, max: 2, step: 0.01, d: 0 },
	]),

	op("pixel", "dilate", "⬆膨胀", [{ k: "radius", l: "半径", min: 0, max: 8, step: 1, d: 0 }]),
	op("pixel", "erode", "⬇腐蚀", [{ k: "radius", l: "半径", min: 0, max: 8, step: 1, d: 0 }]),
	op("pixel", "open_morph", "🔓开运算", [{ k: "radius", l: "半径", min: 0, max: 8, step: 1, d: 0 }]),
	op("pixel", "close_morph", "🔒闭运算", [{ k: "radius", l: "半径", min: 0, max: 8, step: 1, d: 0 }]),
	op("pixel", "quantize", "🎚像素量化", [{ k: "levels", l: "色阶数", min: 2, max: 32, step: 1, d: 8 }]),
	op("pixel", "threshold_key", "🕳阈值抠图", [
		{ k: "threshold", l: "阈值", min: 0, max: 1, step: 0.01, d: 0.5 },
		{ k: "softness", l: "柔和", min: 0, max: 0.5, step: 0.01, d: 0 },
	]),
	op("pixel", "binary", "◼黑白二值", [{ k: "threshold", l: "阈值", min: 0, max: 1, step: 0.01, d: 0.5 }]),
	op("pixel", "despeckle", "🧽噪点去除", [{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 0 }]),
	op("pixel", "resample", "📏像素重采样", [
		{ k: "scale", l: "缩放", min: 0.1, max: 3, step: 0.01, d: 1 },
		{ k: "mode", l: "模式 0近邻 1双线 2三次", min: 0, max: 2, step: 1, d: 1 },
	]),

	op("blend", "blend_mode", "🧩图层混合", [
		{ k: "mode", l: "0正常 1正片 2滤色 3叠加 4差值", min: 0, max: 4, step: 1, d: 0 },
		{ k: "opacity", l: "透明度", min: 0, max: 1, step: 0.01, d: 0.5 },
	]),
	op("blend", "opacity_blend", "🫥透明度混合", [{ k: "opacity", l: "当前层占比", min: 0, max: 1, step: 0.01, d: 0.5 }]),
	op("blend", "solid_overlay", "🟦纯色填充叠加", [
		{ k: "red", l: "红", min: 0, max: 1, step: 0.01, d: 0 },
		{ k: "green", l: "绿", min: 0, max: 1, step: 0.01, d: 0.5 },
		{ k: "blue", l: "蓝", min: 0, max: 1, step: 0.01, d: 1 },
		{ k: "opacity", l: "透明度", min: 0, max: 1, step: 0.01, d: 0 },
	]),
	op("blend", "mask_cut", "🎭蒙版遮罩裁切", [
		{ k: "threshold", l: "阈值", min: 0, max: 1, step: 0.01, d: 0.5 },
		{ k: "softness", l: "羽化", min: 0, max: 0.5, step: 0.01, d: 0.1 },
	]),
	op("blend", "local_mask_color", "🎯局部遮罩调色", [{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 0 }]),
	op("blend", "alpha_key", "🟩Alpha抠像", [
		{ k: "threshold", l: "阈值", min: 0, max: 1, step: 0.01, d: 0.1 },
		{ k: "softness", l: "柔和", min: 0.01, max: 1, step: 0.01, d: 0.05 },
	]),

	op("filter", "mono_filter", "🎨单色滤镜", [
		{ k: "hue", l: "色相", min: 0, max: 360, step: 1, d: 200, unit: "°" },
		{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 0 },
	]),
	op("filter", "sepia", "📜复古棕黄", [{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 0 }]),
	op("filter", "cool_cyan", "🧊冷调青蓝", [{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 0 }]),
	op("filter", "cyber_cool", "🌌赛博冷色", [{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 0 }]),
	op("filter", "film_grain", "🎞胶片颗粒", [
		{ k: "amount", l: "颗粒", min: 0, max: 1, step: 0.01, d: 0 },
		{ k: "seed", l: "种子", min: 0, max: 9999, step: 1, d: 0 },
	]),
	op("filter", "vignette", "🔦暗角", [
		{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 0 },
		{ k: "size", l: "范围", min: 0.1, max: 1, step: 0.01, d: 0.65 },
	]),
	op("filter", "dust_gradient", "🌫渐变蒙尘", [{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 0 }]),
	op("filter", "negative", "🎞反相底片", [{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 1 }]),
	op("filter", "mono_mask", "⚪单色蒙版", [{ k: "threshold", l: "阈值", min: 0, max: 1, step: 0.01, d: 0.5 }]),
	op("filter", "sketch_desat", "✏️手绘去饱和", [{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 0 }]),
	op("filter", "soft_fog", "☁️柔光雾化", [{ k: "amount", l: "强度", min: 0, max: 1, step: 0.01, d: 0 }]),

	op("channel", "alpha_extract", "🅰️Alpha提取", [{ k: "source", l: "0透明 1亮度", min: 0, max: 1, step: 1, d: 0 }]),
	op("channel", "transparent_remove", "🧹透明底剔除", [{ k: "background", l: "背景灰度", min: 0, max: 1, step: 0.01, d: 1 }]),
	op("channel", "feather_alpha", "🪶边缘羽化", [{ k: "radius", l: "半径", min: 0, max: 12, step: 1, d: 0 }]),
	op("channel", "transparent_fill", "⬜透明填充", [{ k: "value", l: "填充灰度", min: 0, max: 1, step: 0.01, d: 1 }]),
	op("channel", "rgb_split_merge", "🔀RGB分离/合并", [{ k: "mode", l: "0RGB 1GBR 2BRG 3BGR", min: 0, max: 3, step: 1, d: 0 }]),
	op("channel", "channel_invert", "↩通道反转", [{ k: "channel", l: "0红 1绿 2蓝", min: 0, max: 2, step: 1, d: 0 }]),
	op("channel", "single_channel_gray", "📺单通道灰度", [{ k: "channel", l: "0红 1绿 2蓝", min: 0, max: 2, step: 1, d: 0 }]),

	op("crop", "center_trim", "🎯居中裁切", [{ k: "amount", l: "裁除比例", min: 0, max: 0.95, step: 0.01, d: 0 }]),
	op("crop", "fixed_crop", "📏固定宽高裁剪", [
		{ k: "width", l: "宽度比例", min: 0.05, max: 1, step: 0.01, d: 1 },
		{ k: "height", l: "高度比例", min: 0.05, max: 1, step: 0.01, d: 1 },
	]),
	op("crop", "border_trim", "🧽边框裁除", [{ k: "amount", l: "裁除比例", min: 0, max: 0.45, step: 0.01, d: 0 }]),
	op("crop", "canvas_expand", "⬚画布扩边", [
		{ k: "amount", l: "扩边比例", min: 0, max: 0.5, step: 0.01, d: 0 },
		{ k: "value", l: "填充值", min: 0, max: 1, step: 0.01, d: 0 },
	]),
	op("crop", "asymmetric_pad", "↔不对称补边", [
		{ k: "left", l: "左", min: 0, max: 0.5, step: 0.01, d: 0 },
		{ k: "right", l: "右", min: 0, max: 0.5, step: 0.01, d: 0 },
		{ k: "top", l: "上", min: 0, max: 0.5, step: 0.01, d: 0 },
		{ k: "bottom", l: "下", min: 0, max: 0.5, step: 0.01, d: 0 },
	]),
	op("crop", "rounded_corner", "◜边角圆角", [
		{ k: "radius", l: "半径比例", min: 0, max: 0.5, step: 0.01, d: 0 },
		{ k: "background", l: "背景灰度", min: 0, max: 1, step: 0.01, d: 0 },
	]),
];

const OP_BY_ID = Object.fromEntries(OPS.map((item) => [item.id, item]));
const OPS_BY_CATEGORY = Object.fromEntries(CATEGORIES.map((cat) => [cat.id, OPS.filter((item) => item.category === cat.id)]));

function op(category, id, label, params) {
	return { category, id, label, params };
}

function defaultState() {
	return { version: 1, activeCategory: "color", selected: [], values: {} };
}

function parseState(raw) {
	try {
		const value = JSON.parse(String(raw || "{}"));
		if (!value || typeof value !== "object") return defaultState();
		return normalizeState(value);
	} catch (_) {
		return defaultState();
	}
}

function normalizeState(value) {
	const state = defaultState();
	state.activeCategory = CATEGORIES.some((cat) => cat.id === value.activeCategory) ? value.activeCategory : "color";
	if (Array.isArray(value.selected)) state.selected = value.selected.filter((id) => OP_BY_ID[id]);
	else if (value.selected && typeof value.selected === "object") state.selected = Object.keys(value.selected).filter((id) => value.selected[id] && OP_BY_ID[id]);
	state.values = {};
	for (const item of OPS) {
		const src = value.values?.[item.id] || {};
		state.values[item.id] = {};
		for (const param of item.params) {
			const raw = Number(src[param.k]);
			state.values[item.id][param.k] = Number.isFinite(raw) ? clamp(raw, param.min, param.max) : param.d;
		}
	}
	return state;
}

function serializeState(state) {
	return JSON.stringify({
		version: 1,
		activeCategory: state.activeCategory,
		selected: [...state.selected],
		values: state.values,
	});
}

function findWidget(node, name) {
	return node.widgets?.find?.((widget) => widget?.name === name);
}

function getHiddenValue(node, name, fallback = "") {
	const prop = node.properties?.[name];
	if (prop !== undefined && prop !== null && prop !== "") return String(prop);
	const widget = findWidget(node, name);
	return widget?.value ?? fallback;
}

function setHiddenValue(node, name, value) {
	node.properties = node.properties || {};
	node.properties[name] = String(value ?? "");
	const widget = findWidget(node, name);
	if (widget) {
		widget.value = String(value ?? "");
		try { widget.callback?.(widget.value, app.canvas, node); } catch (_) {}
	}
	if (Array.isArray(node.widgets) && Array.isArray(node.widgets_values)) {
		const index = node.widgets.indexOf(widget);
		if (index >= 0) node.widgets_values[index] = String(value ?? "");
	}
	node.graph?.change?.();
	app.graph?.setDirtyCanvas?.(true, true);
}

function legacyWidgetValue(serializedNode, index) {
	const values = serializedNode?.widgets_values;
	const value = Array.isArray(values) ? values[index] : "";
	return value !== undefined && value !== null && value !== "" ? String(value) : "";
}

function compactNode(node) {
	node.properties = node.properties || {};
	for (const name of HIDDEN_WIDGETS) {
		const widget = findWidget(node, name);
		if (widget?.value && !node.properties[name]) node.properties[name] = String(widget.value);
	}
	for (const name of HIDDEN_WIDGETS) {
		GJJ_Utils.hideWidget(findWidget(node, name));
	}
	GJJ_Utils.removeHiddenInputSockets(node, HIDDEN_WIDGETS);
	GJJ_Utils.reorderWidgets(node, HIDDEN_WIDGETS);
	GJJ_Utils.refreshNode(node);
}

function targetClass(node) {
	return String(node?.comfyClass || node?.type || "");
}

function isInputSlotChange(slotType) {
	return slotType === 0
		|| slotType === 1
		|| slotType === globalThis.LiteGraph?.INPUT
		|| String(slotType).toLowerCase() === "input";
}

function stop(event) {
	event.preventDefault();
	event.stopPropagation();
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function finite(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? number : fallback;
}

function normalizePreviewMode(value) {
	const text = String(value || "");
	return ["compare", "result", "original"].includes(text) ? text : "compare";
}

function eventNodeId(event) {
	return String(
		event?.detail?.node_id
			?? event?.detail?.node
			?? event?.detail?.display_node
			?? event?.detail?.nodeId
			?? "",
	);
}

function isNetworkImageUrl(value) {
	return /^https?:\/\//i.test(String(value || "").trim());
}

function uploadUrl(path) {
	try {
		if (api?.apiURL) return api.apiURL(path);
	} catch (_) {}
	return path;
}

function splitImageRelativePath(filename) {
	let text = String(filename || "").trim().replace(/\\/g, "/");
	if (!text) return { filename: "", subfolder: "" };
	const annotated = text.match(/\s+\[(input|output|temp)\]$/i);
	if (annotated) text = text.slice(0, annotated.index).trim();
	const parts = text.split("/").filter(Boolean);
	if (["input", "output", "temp"].includes(String(parts[0] || "").toLowerCase())) parts.shift();
	const name = parts.pop() || "";
	return { filename: name, subfolder: parts.join("/") };
}

function imageRefToViewUrl(value) {
	let text = String(value || "").trim().replace(/\\/g, "/");
	if (!text) return "";
	if (/^(?:blob:|data:|https?:\/\/)/i.test(text) && !new URL(text, window.location.href).pathname.endsWith("/view")) {
		return text;
	}
	try {
		const parsed = new URL(text, window.location.href);
		if (parsed.pathname.endsWith("/view")) {
			if (!parsed.searchParams.has("rand")) parsed.searchParams.set("rand", String(Date.now()));
			return api.apiURL(`${parsed.pathname}${parsed.search}`);
		}
	} catch (_) {}
	const annotated = text.match(/\s+\[(input|output|temp)\]$/i);
	let type = "input";
	if (annotated) {
		type = annotated[1].toLowerCase();
		text = text.slice(0, annotated.index).trim();
	}
	const parts = text.split("/").filter(Boolean);
	if (["input", "output", "temp"].includes(String(parts[0] || "").toLowerCase())) {
		type = parts.shift().toLowerCase();
	}
	const filename = parts.pop() || text;
	const subfolder = parts.join("/");
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	return api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}${previewFormat}${randParam}`);
}

function imageDataToUrl(data) {
	if (!data) return "";
	if (typeof data === "string") return imageRefToViewUrl(data);
	if (data.url) return imageRefToViewUrl(data.url);
	if (!data.filename) return "";
	const previewFormat = typeof app.getPreviewFormatParam === "function" ? app.getPreviewFormatParam() : "";
	const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : `&rand=${Date.now()}`;
	return api.apiURL(`/view?filename=${encodeURIComponent(data.filename)}&type=${encodeURIComponent(data.type || "temp")}&subfolder=${encodeURIComponent(data.subfolder || "")}${previewFormat}${randParam}`);
}

function firstImagePayload(...payloads) {
	const stack = [...payloads];
	while (stack.length) {
		const item = stack.shift();
		if (!item) continue;
		if (Array.isArray(item)) {
			stack.unshift(...item);
			continue;
		}
		if (typeof item !== "object") continue;
		if (item.filename || item.url) return item;
		for (const key of ["images", "preview_images", "preview_image", "image", "result"]) {
			if (item[key]) stack.push(item[key]);
		}
	}
	return null;
}

function safeImageFilename(name) {
	let text = String(name || "").replace(/\\/g, "/").split("/").pop() || "";
	try { text = decodeURIComponent(text); } catch (_) {}
	text = text.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().replace(/^[ ._]+|[ ._]+$/g, "");
	if (!text) text = "downloaded_image";
	if (!/\.[A-Za-z0-9]{2,8}$/.test(text)) text += ".png";
	return text;
}

function safeSubdirPart(name) {
	let text = String(name || "");
	try { text = decodeURIComponent(text); } catch (_) {}
	text = text.replace(/[<>:"/\\|?*\x00-\x1f\s]+/g, "_").trim().replace(/^[ ._]+|[ ._]+$/g, "");
	return (text || "network").slice(0, 72).replace(/[ ._]+$/g, "") || "network";
}

function hashText(text) {
	let hash = 2166136261;
	const source = String(text || "");
	for (let index = 0; index < source.length; index++) {
		hash ^= source.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 10);
}

function networkImageCacheInfo(url) {
	try {
		const parsed = new URL(String(url || "").trim(), window.location.href);
		const pathParts = parsed.pathname
			.split("/")
			.map((part) => {
				try { return decodeURIComponent(part); } catch (_) { return part; }
			})
			.filter(Boolean);
		const sourceName = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : (parsed.host || "network");
		const sourceDir = pathParts.slice(0, -1).join("/");
		let sourceKey = `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}/${sourceDir}`;
		if (parsed.search) sourceKey += parsed.search;
		const subfolder = `${MEDIA_COPY_SUBDIR}/${safeSubdirPart(sourceName)}_${hashText(sourceKey)}`;
		const filename = safeImageFilename(pathParts[pathParts.length - 1] || "network_image.png");
		return { filename, subfolder, relativePath: `${subfolder}/${filename}` };
	} catch (_) {
		const subfolder = `${MEDIA_COPY_SUBDIR}/network_${hashText(url)}`;
		const filename = safeImageFilename("network_image.png");
		return { filename, subfolder, relativePath: `${subfolder}/${filename}` };
	}
}

function normalizeUploadFilename(data, file, requestedSubfolder = "") {
	const filename = String(data?.name || data?.filename || data?.file || file?.name || "").replace(/\\/g, "/");
	if (!filename) return "";
	if (filename.includes("/")) return filename;
	const subfolder = String(data?.subfolder ?? requestedSubfolder ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return subfolder ? `${subfolder}/${filename}` : filename;
}

async function uploadImageToInput(file, subfolder = "") {
	const endpoints = ["/upload/image", "/api/upload/image"];
	const cleanSubfolder = String(subfolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	let lastError = null;
	for (const endpoint of endpoints) {
		const form = new FormData();
		form.append("image", file, file.name);
		form.append("type", "input");
		form.append("overwrite", "true");
		if (cleanSubfolder) form.append("subfolder", cleanSubfolder);
		try {
			const response = api?.fetchApi && endpoint === "/upload/image"
				? await api.fetchApi(endpoint, { method: "POST", body: form })
				: await fetch(uploadUrl(endpoint), { method: "POST", body: form });
			if (!response?.ok) {
				let detail = "";
				try { detail = await response.text(); } catch (_) {}
				lastError = new Error(`上传失败：HTTP ${response?.status || "?"}${detail ? ` ${detail}` : ""}`);
				continue;
			}
			const data = await response.json().catch(() => ({}));
			const filename = normalizeUploadFilename(data, file, cleanSubfolder);
			if (!filename) throw new Error("上传成功但没有返回文件名");
			return filename;
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError || new Error("上传失败：未知错误");
}

async function downloadNetworkImageViaBackend(url) {
	const response = await api.fetchApi("/gjj/realtime_image_processor/download_image", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ url }),
	});
	const data = await response.json().catch(() => ({}));
	if (!response?.ok || !data?.ok) throw new Error(data?.message || `HTTP ${response?.status || "?"}`);
	const filename = String(data?.filename || data?.name || "").trim();
	if (!filename) throw new Error("下载成功但没有返回文件名");
	return filename;
}

async function downloadNetworkImageInBrowser(url) {
	const response = await fetch(url, { cache: "no-store" });
	if (!response?.ok) throw new Error(`浏览器下载 HTTP ${response?.status || "?"}`);
	const blob = await response.blob();
	const cacheInfo = networkImageCacheInfo(url);
	const file = new File([blob], cacheInfo.filename, { type: blob.type || "image/png" });
	return uploadImageToInput(file, cacheInfo.subfolder);
}

async function ensureNetworkImageInInput(url) {
	try {
		return await downloadNetworkImageViaBackend(url);
	} catch (backendError) {
		console.warn("[GJJ] 图片实时对比处理：后端下载网络图片失败，改用浏览器上传", backendError);
		return downloadNetworkImageInBrowser(url);
	}
}

function inputLabelText(input) {
	return [
		input?.name,
		input?.display_name,
		input?.displayName,
		input?.localized_name,
		input?.label,
		input?.type,
	].map((item) => String(item || "")).join(" ");
}

function isImageInput(input) {
	const name = String(input?.name || "");
	if (name === "image") return true;
	return /(?:IMAGE|GJJ_BATCH_IMAGE|image|img|图片|图像|输入图片)/i.test(inputLabelText(input));
}

function linkedImageInput(node) {
	const inputs = Array.isArray(node?.inputs) ? node.inputs : [];
	const linked = inputs.filter((input) => input?.link != null);
	return linked.find((input) => String(input?.name || "") === "image")
		|| linked.find(isImageInput)
		|| (linked.length === 1 ? linked[0] : null)
		|| inputs.find((input) => String(input?.name || "") === "image")
		|| inputs.find(isImageInput)
		|| (inputs.length === 1 ? inputs[0] : null);
}

function linkedSourceNodeId(node) {
	const input = linkedImageInput(node);
	if (!input || input.link == null || !app.graph?.links) return "";
	const link = app.graph.links[input.link];
	if (!link) return "";
	return String(link.origin_id ?? link.source_id ?? link.from_id ?? "");
}

function isLinkedFromNode(node, sourceId) {
	const linked = linkedSourceNodeId(node);
	return linked && String(linked) === String(sourceId || "");
}

function imageElementInfo(sourceId, image, label) {
	if (!image?.src) return null;
	const width = image.naturalWidth || image.width || "";
	const height = image.naturalHeight || image.height || "";
	return {
		url: image.src,
		label,
		signature: `element:${sourceId}:${image.src}:${width}:${height}`,
	};
}

function getUpstreamImageInfo(node) {
	const sourceId = linkedSourceNodeId(node);
	if (!sourceId) return null;
	const sourceNode = app.graph.getNodeById?.(sourceId);
	if (!sourceNode) return null;
	const sourceClass = targetClass(sourceNode);
	if (sourceClass === "LoadImage" || sourceClass === "LoadImageOutput") {
		const widget = findWidget(sourceNode, "image") || findWidget(sourceNode, "file") || findWidget(sourceNode, "filename");
		if (widget?.value) {
			const type = sourceClass === "LoadImageOutput" ? "output" : "input";
			const url = imageRefToViewUrl(`${widget.value} [${type}]`);
			return {
				url,
				label: "上游载入图片",
				signature: `load:${sourceId}:${type}:${widget.value}`,
			};
		}
	}
	if (Array.isArray(sourceNode.imgs)) {
		const img = sourceNode.imgs.find((item) => item?.src);
		const info = imageElementInfo(sourceId, img, "上游预览");
		if (info) return info;
	}
	const imageInfo = imageElementInfo(sourceId, sourceNode.image, "上游图像");
	if (imageInfo) return imageInfo;
	const previewInfo = imageElementInfo(sourceId, sourceNode.preview, "上游预览");
	if (previewInfo) return previewInfo;
	return null;
}

function getUpstreamImageSrc(node) {
	return getUpstreamImageInfo(node)?.url || "";
}

function createFileInput(node, loadUrl) {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "image/png,image/jpeg,image/webp,image/bmp";
	input.style.display = "none";
	input.addEventListener("change", async () => {
		const file = input.files?.[0];
		if (!file) return;
		try {
			const dataUrl = await readLocalFile(file);
			loadUrl(dataUrl, `${file.name} · 本地预览`, `local:${file.name}:${file.size}:${file.lastModified}`, { force: true });
			const filename = await uploadImageToInput(file);
			if (filename) {
				setHiddenValue(node, INTERNAL_FILE_WIDGET, filename);
				loadUrl(imageRefToViewUrl(filename), `${filename} · 已上传`, `internal:${filename}:${Date.now()}`, { force: true });
			}
		} catch (error) {
			console.warn("[GJJ] 图片实时对比处理：打开图片失败", error);
		} finally {
			input.value = "";
		}
	});
	document.body.appendChild(input);
	return input;
}

function readLocalFile(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result || ""));
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});
}

function ensureStyle() {
	if (document.getElementById("gjj-realtime-image-processor-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-realtime-image-processor-style";
	style.textContent = `
.gjj-rip-root{box-sizing:border-box;width:100%;padding:0 8px 6px;color:#dbe7ea;font-family:system-ui,"Microsoft YaHei",sans-serif;pointer-events:auto;user-select:none;}
.gjj-rip-top{display:flex;align-items:end;gap:4px;min-width:0;position:relative;padding-bottom:1px;margin-bottom:4px;}
.gjj-rip-top::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;background:linear-gradient(90deg,rgba(85,198,133,.2),rgba(85,198,133,.86),rgba(71,152,214,.38));pointer-events:none;}
.gjj-rip-open,.gjj-rip-save{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:1px solid rgba(116,140,150,.5);border-radius:7px;background:#18252b;color:#dff9f5;font-size:15px;cursor:pointer;flex:0 0 auto;position:relative;z-index:1;}
.gjj-rip-save{background:#162821;color:#dfffe9;}
.gjj-rip-save:disabled{opacity:.45;cursor:not-allowed;}
.gjj-rip-tabs{display:flex;align-items:end;gap:0;min-width:0;overflow:hidden;}
.gjj-rip-tab{height:28px;padding:0 8px;border:1px solid rgba(116,140,150,.42);border-bottom-color:rgba(85,198,133,.42);border-radius:7px 7px 0 0;background:#121b20;color:#9fb4bd;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;position:relative;z-index:1;margin-bottom:-1px;}
.gjj-rip-tab.on{background:#1d3034;color:#f0fffb;border-color:rgba(82,201,169,.82);border-bottom-color:#1d3034;box-shadow:0 2px 0 #55c685;}
.gjj-rip-ops{display:flex;flex-wrap:wrap;gap:4px;padding:5px 0 4px;}
.gjj-rip-op{height:24px;padding:0 8px;border:1px solid rgba(116,140,150,.45);border-radius:5px;background:#172228;color:#cbdce0;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;}
.gjj-rip-op.on{background:#1d563d;border-color:#55c685;color:white;}
.gjj-rip-options{display:grid;grid-template-columns:1fr;gap:4px;padding:2px 0 5px;}
.gjj-rip-card{border:1px solid rgba(116,140,150,.22);border-radius:7px;background:rgba(14,22,26,.72);padding:5px 6px;}
.gjj-rip-card-title{font-size:11px;color:#9ee6cb;font-weight:800;margin-bottom:3px;}
.gjj-rip-row{display:grid;grid-template-columns:96px minmax(120px,1fr) 48px;gap:6px;align-items:center;min-height:22px;}
.gjj-rip-row label{font-size:11px;color:#c8d6da;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gjj-rip-row input{width:100%;accent-color:#55c685;}
.gjj-rip-value{text-align:right;font-size:10px;color:#a7bcc4;font-variant-numeric:tabular-nums;}
.gjj-rip-preview{position:relative;border:1px solid rgba(116,140,150,.36);border-radius:7px;background:#091015;overflow:hidden;min-height:${MIN_PREVIEW_HEIGHT}px;}
.gjj-rip-preview canvas{display:block;width:100%;height:100%;cursor:ew-resize;}
.gjj-rip-preview-mode{position:absolute;top:8px;z-index:3;height:22px;padding:0 12px;border:1px solid rgba(156,231,202,.32);border-radius:4px;background:rgba(9,16,21,.72);color:#eafff7;font-size:11px;font-weight:800;line-height:20px;cursor:pointer;}
.gjj-rip-preview-mode.result{left:10px;}
.gjj-rip-preview-mode.original{right:10px;}
.gjj-rip-preview-mode.on{background:#1d563d;border-color:#55c685;color:#fff;box-shadow:0 0 0 1px rgba(85,198,133,.18);}
.gjj-rip-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;color:#7f98a2;font-size:12px;line-height:1.5;padding:14px;pointer-events:none;}
.gjj-rip-status{display:flex;justify-content:space-between;gap:8px;font-size:10px;color:#89a6ae;padding:3px 1px 0;min-height:14px;}
`;
	document.head.appendChild(style);
}

function makeButton(className, text, title = "") {
	const button = document.createElement("button");
	button.type = "button";
	button.className = className;
	button.textContent = text;
	button.title = title;
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick"]) {
		button.addEventListener(eventName, stop);
	}
	return button;
}

function createPanel(node) {
	ensureStyle();
	const state = parseState(getHiddenValue(node, CONFIG_WIDGET, ""));
	let sourceImage = null;
	let sourceLabel = "";
	let sourceSignature = "";
	let lastProcessedCanvas = null;
	let dragging = false;
	let compareRatio = finite(node.properties?.gjj_realtime_compare_ratio, 0.5);
	let previewMode = normalizePreviewMode(node.properties?.gjj_realtime_preview_mode);
	let previewAspect = 1;
	let framePending = false;

	const root = document.createElement("div");
	root.className = "gjj-rip-root";
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
		root.addEventListener(eventName, (event) => event.stopPropagation());
	}

	const top = document.createElement("div");
	top.className = "gjj-rip-top";
	const openButton = makeButton("gjj-rip-open", "📁", "打开图片：上传到 ComfyUI input，同时用于节点内实时预览");
	const saveButton = makeButton("gjj-rip-save", "💾", "保存当前实时处理结果到 ComfyUI output");
	saveButton.disabled = true;
	const tabs = document.createElement("div");
	tabs.className = "gjj-rip-tabs";
	top.append(openButton, saveButton, tabs);

	const opsRow = document.createElement("div");
	opsRow.className = "gjj-rip-ops";
	const options = document.createElement("div");
	options.className = "gjj-rip-options";

	const preview = document.createElement("div");
	preview.className = "gjj-rip-preview";
	const canvas = document.createElement("canvas");
	canvas.width = 900;
	canvas.height = 420;
	const empty = document.createElement("div");
	empty.className = "gjj-rip-empty";
	empty.textContent = "连接 IMAGE，或点击 📁 打开图片\n未连接时自动载入默认示例图";
	const resultButton = makeButton("gjj-rip-preview-mode result", "结果", "只显示处理结果；再次点击回到实时对比");
	const originalButton = makeButton("gjj-rip-preview-mode original", "原图", "只显示原图；再次点击回到实时对比");
	preview.append(canvas, resultButton, originalButton, empty);

	const status = document.createElement("div");
	status.className = "gjj-rip-status";
	const statusLeft = document.createElement("span");
	const statusRight = document.createElement("span");
	status.append(statusLeft, statusRight);

	root.append(top, opsRow, options, preview, status);

	const fileInput = createFileInput(node, loadImageUrl);
	openButton.addEventListener("click", (event) => {
		stop(event);
		fileInput.click();
	});
	saveButton.addEventListener("click", (event) => {
		stop(event);
		saveCurrentImage();
	});
	resultButton.addEventListener("click", (event) => {
		stop(event);
		setPreviewMode(previewMode === "result" ? "compare" : "result");
	});
	originalButton.addEventListener("click", (event) => {
		stop(event);
		setPreviewMode(previewMode === "original" ? "compare" : "original");
	});

	function syncState() {
		setHiddenValue(node, CONFIG_WIDGET, serializeState(state));
		node.properties.gjj_realtime_compare_ratio = compareRatio;
		node.properties.gjj_realtime_preview_mode = previewMode;
	}

	function rebuildTabs() {
		tabs.replaceChildren();
		for (const cat of CATEGORIES) {
			const button = makeButton("gjj-rip-tab", cat.label, cat.title);
			button.classList.toggle("on", cat.id === state.activeCategory);
			button.addEventListener("click", (event) => {
				stop(event);
				state.activeCategory = cat.id;
				syncState();
				rebuild();
			});
			tabs.appendChild(button);
		}
	}

	function rebuildOps() {
		opsRow.replaceChildren();
		const items = OPS_BY_CATEGORY[state.activeCategory] || [];
		for (const item of items) {
			const button = makeButton("gjj-rip-op", item.label, "点击选择；再次点击取消");
			button.classList.toggle("on", state.selected.includes(item.id));
			button.addEventListener("click", (event) => {
				stop(event);
				if (state.selected.includes(item.id)) {
					state.selected = state.selected.filter((id) => id !== item.id);
				} else {
					state.selected.push(item.id);
				}
				syncState();
				rebuild();
				schedulePreview();
			});
			opsRow.appendChild(button);
		}
	}

	function rebuildOptions() {
		options.replaceChildren();
		for (const id of state.selected) {
			const item = OP_BY_ID[id];
			if (!item || item.category !== state.activeCategory) continue;
			const card = document.createElement("div");
			card.className = "gjj-rip-card";
			const title = document.createElement("div");
			title.className = "gjj-rip-card-title";
			title.textContent = item.label;
			card.appendChild(title);
			for (const param of item.params) {
				card.appendChild(createSlider(item, param));
			}
			options.appendChild(card);
		}
	}

	function createSlider(item, param) {
		const row = document.createElement("div");
		row.className = "gjj-rip-row";
		const label = document.createElement("label");
		label.textContent = param.l;
		const input = document.createElement("input");
		input.type = "range";
		input.min = String(param.min);
		input.max = String(param.max);
		input.step = String(param.step);
		input.value = String(state.values[item.id]?.[param.k] ?? param.d);
		const value = document.createElement("span");
		value.className = "gjj-rip-value";
		const showValue = () => {
			const raw = Number(input.value);
			value.textContent = `${Number.isInteger(raw) ? raw : raw.toFixed(param.step < 0.1 ? 2 : 1)}${param.unit || ""}`;
		};
		showValue();
		input.addEventListener("input", (event) => {
			event.stopPropagation();
			state.values[item.id] ||= {};
			state.values[item.id][param.k] = Number(input.value);
			showValue();
			syncState();
			schedulePreview();
		});
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
			input.addEventListener(eventName, (event) => event.stopPropagation());
		}
		row.append(label, input, value);
		return row;
	}

	function rebuild() {
		rebuildTabs();
		rebuildOps();
		rebuildOptions();
		resizeNode();
	}

	function syncPreviewModeButtons() {
		resultButton.classList.toggle("on", previewMode === "result");
		originalButton.classList.toggle("on", previewMode === "original");
		canvas.style.cursor = previewMode === "compare" ? "ew-resize" : "default";
	}

	function setPreviewMode(mode) {
		previewMode = normalizePreviewMode(mode);
		syncPreviewModeButtons();
		syncState();
		schedulePreview();
	}

	function updatePreviewAspect(imageWidth, imageHeight) {
		const next = clamp(Math.max(1, Number(imageHeight) || 1) / Math.max(1, Number(imageWidth) || 1), 0.05, 20);
		if (Math.abs(next - previewAspect) <= 0.001) return;
		previewAspect = next;
		preview.style.height = `${previewHeight()}px`;
		requestAnimationFrame(resizeNode);
	}

	function scheduleNetworkImageToInput(url, label = "默认示例图") {
		if (!isNetworkImageUrl(url)) return;
		if (getUpstreamImageInfo(node)?.url) return;
		node.__gjjRealtimeNetworkJobs = node.__gjjRealtimeNetworkJobs || new Map();
		if (node.__gjjRealtimeNetworkJobs.has(url)) return;
		const job = ensureNetworkImageInInput(url)
			.then((filename) => {
				const current = getHiddenValue(node, INTERNAL_FILE_WIDGET, "");
				if (current && current !== url && current !== DEFAULT_IMAGE_URL) return;
				setHiddenValue(node, INTERNAL_FILE_WIDGET, filename);
				loadImageUrl(imageRefToViewUrl(filename), `${filename} · 已缓存`, `internal:${filename}:${Date.now()}`, { force: true });
			})
			.catch((error) => {
				console.warn("[GJJ] 图片实时对比处理：网络图片缓存失败", error);
				if (!getUpstreamImageInfo(node)?.url) statusLeft.textContent = `${label} · 直链预览`;
			})
			.finally(() => node.__gjjRealtimeNetworkJobs?.delete(url));
		node.__gjjRealtimeNetworkJobs.set(url, job);
	}

	function loadImageUrl(url, label = "", signature = "", options = {}) {
		if (!url) {
			sourceImage = null;
			sourceLabel = "";
			sourceSignature = "";
			lastProcessedCanvas = null;
			saveButton.disabled = true;
			schedulePreview();
			return;
		}
		const nextSignature = String(signature || url || "");
		if (!options.force && sourceSignature && nextSignature && sourceSignature === nextSignature) return;
		const img = new Image();
		img.crossOrigin = "anonymous";
		img.onload = () => {
			sourceImage = img;
			sourceLabel = label || "图片";
			sourceSignature = nextSignature;
			saveButton.disabled = false;
			statusLeft.textContent = `${sourceLabel}`;
			statusRight.textContent = `${img.naturalWidth || img.width} × ${img.naturalHeight || img.height}`;
			empty.style.display = "none";
			updatePreviewAspect(img.naturalWidth || img.width || 1, img.naturalHeight || img.height || 1);
			schedulePreview();
			resizeNode();
			if (isNetworkImageUrl(url)) scheduleNetworkImageToInput(url, label || "网络图片");
		};
		img.onerror = () => {
			sourceImage = null;
			lastProcessedCanvas = null;
			sourceSignature = "";
			saveButton.disabled = true;
			statusLeft.textContent = "图片加载失败";
			empty.style.display = "flex";
			schedulePreview();
		};
		img.src = url;
	}

	function refreshUpstreamImage(options = {}) {
		const upstream = getUpstreamImageInfo(node);
		if (upstream?.url) {
			loadImageUrl(upstream.url, upstream.label || "上游预览", upstream.signature, options);
			return true;
		}
		return false;
	}

	function tryLoadInitialImage(options = {}) {
		if (refreshUpstreamImage(options)) return;
		const internalFile = getHiddenValue(node, INTERNAL_FILE_WIDGET, DEFAULT_IMAGE_URL) || DEFAULT_IMAGE_URL;
		const url = imageRefToViewUrl(internalFile);
		if (url) {
			const label = internalFile === DEFAULT_IMAGE_URL ? "默认示例图" : `${internalFile} · 内部图片`;
			loadImageUrl(url, label, `internal:${internalFile}`, options);
			if (isNetworkImageUrl(internalFile)) scheduleNetworkImageToInput(internalFile, label);
		}
	}

	function refreshFromExecuted(event) {
		const sourceId = eventNodeId(event);
		if (!sourceId || !isLinkedFromNode(node, sourceId)) return false;
		const output = event?.detail?.output || event?.detail || {};
		const imagePayload = firstImagePayload(output.images, output.preview_images, output.preview_image, output);
		if (imagePayload) {
			const url = imageDataToUrl(imagePayload);
			if (url) {
				const signature = `executed:${sourceId}:${imagePayload.filename || imagePayload.url || Date.now()}:${imagePayload.type || ""}:${imagePayload.subfolder || ""}`;
				loadImageUrl(url, "上游执行预览", signature, { force: true });
				return true;
			}
		}
		setTimeout(() => tryLoadInitialImage({ force: true }), 180);
		return true;
	}

	function schedulePreview() {
		if (framePending) return;
		framePending = true;
		requestAnimationFrame(() => {
			framePending = false;
			renderPreview();
		});
	}

	function previewLayoutWidth() {
		const domWidth = Number(preview.clientWidth || preview.offsetWidth || root.clientWidth || root.offsetWidth || 0);
		if (Number.isFinite(domWidth) && domWidth > 0) {
			return Math.max(320, Math.round(domWidth));
		}
		return Math.max(320, Math.round(Math.max(MIN_WIDTH - 24, Number(node.size?.[0] || MIN_WIDTH) - 24)));
	}

	function previewHeightForWidth(width) {
		return Math.max(120, Math.round(Math.max(1, Number(width) || 1) * previewAspect));
	}

	function renderPreview() {
		const width = previewLayoutWidth();
		const height = previewHeightForWidth(width);
		const heightPx = `${height}px`;
		if (preview.style.height !== heightPx) {
			preview.style.height = heightPx;
		}
		const dpr = Math.max(1, window.devicePixelRatio || 1);
		const canvasWidth = Math.max(1, Math.round(width * dpr));
		const canvasHeight = Math.max(1, Math.round(height * dpr));
		if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
			canvas.width = canvasWidth;
			canvas.height = canvasHeight;
		}
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		ctx.fillStyle = "#091015";
		ctx.fillRect(0, 0, width, height);
		if (!sourceImage) {
			empty.style.display = "flex";
			statusLeft.textContent = "等待图片";
			statusRight.textContent = `${state.selected.length} 个操作`;
			lastProcessedCanvas = null;
			saveButton.disabled = true;
			return;
		}
		empty.style.display = "none";
		const original = imageToCanvas(sourceImage);
		const processed = processCanvas(original, state);
		lastProcessedCanvas = processed;
		saveButton.disabled = false;
		const fit = containRect(width, height, original.width, original.height);
		if (previewMode === "result") {
			const resultFit = containRect(width, height, processed.width, processed.height);
			ctx.drawImage(processed, resultFit.x, resultFit.y, resultFit.w, resultFit.h);
		} else if (previewMode === "original") {
			ctx.drawImage(original, fit.x, fit.y, fit.w, fit.h);
		} else {
			ctx.drawImage(original, fit.x, fit.y, fit.w, fit.h);
			ctx.save();
			ctx.beginPath();
			ctx.rect(fit.x, fit.y, fit.w * compareRatio, fit.h);
			ctx.clip();
			ctx.drawImage(processed, fit.x, fit.y, fit.w, fit.h);
			ctx.restore();

			const dividerX = fit.x + fit.w * compareRatio;
			ctx.strokeStyle = "rgba(255,255,255,.85)";
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			ctx.moveTo(dividerX, fit.y);
			ctx.lineTo(dividerX, fit.y + fit.h);
			ctx.stroke();
		}
		statusLeft.textContent = `${sourceLabel || "图片"} · ${state.selected.length} 个操作`;
		statusRight.textContent = `${processed.width} × ${processed.height}`;
	}

	function previewHeight() {
		return previewHeightForWidth(previewLayoutWidth());
	}

	function resizeNode() {
		if (node.__gjjRealtimeImageProcessorSizing) return;
		requestAnimationFrame(() => {
			node.__gjjRealtimeImageProcessorSizing = true;
			const width = Math.max(MIN_WIDTH, Number(node.size?.[0] || MIN_WIDTH));
			preview.style.height = `${previewHeight()}px`;
			const height = Math.max(120, Math.ceil(root.scrollHeight || root.offsetHeight || 120));
			node.__gjjRealtimeImageProcessorHeight = height + 4;
			node.minWidth = MIN_WIDTH;
			node.min_width = MIN_WIDTH;
			node.setSize?.([width, height + 4]);
			GJJ_Utils.refreshNode(node);
			app.graph?.setDirtyCanvas?.(true, true);
			schedulePreview();
			requestAnimationFrame(() => { node.__gjjRealtimeImageProcessorSizing = false; });
		});
	}

	async function saveCurrentImage() {
		if (!sourceImage) {
			statusLeft.textContent = "没有可保存的图片";
			return;
		}
		try {
			saveButton.disabled = true;
			statusLeft.textContent = "正在保存...";
			const canvasToSave = lastProcessedCanvas || processCanvas(imageToCanvas(sourceImage), state);
			const image = canvasToSave.toDataURL("image/png");
			const response = await api.fetchApi("/gjj/realtime_image_processor/save", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ image, prefix: "GJJ_RealtimeImageProcessor" }),
			});
			const data = await response.json();
			if (!response.ok || !data?.ok) {
				throw new Error(data?.message || `HTTP ${response.status}`);
			}
			statusLeft.textContent = `已保存：${data.filename}`;
			statusRight.textContent = "output";
		} catch (error) {
			statusLeft.textContent = `保存失败：${error?.message || error}`;
		} finally {
			saveButton.disabled = !sourceImage;
		}
	}

	function pointerToRatio(event) {
		const rect = canvas.getBoundingClientRect();
		return clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
	}

	canvas.addEventListener("pointerdown", (event) => {
		stop(event);
		if (previewMode !== "compare") {
			previewMode = "compare";
			syncPreviewModeButtons();
		}
		dragging = true;
		compareRatio = pointerToRatio(event);
		syncState();
		schedulePreview();
		canvas.setPointerCapture?.(event.pointerId);
	});
	canvas.addEventListener("pointermove", (event) => {
		if (!dragging && (event.buttons & 1) !== 1) return;
		stop(event);
		compareRatio = pointerToRatio(event);
		syncState();
		schedulePreview();
	});
	canvas.addEventListener("pointerup", (event) => {
		if (!dragging) return;
		stop(event);
		dragging = false;
	});
	canvas.addEventListener("pointerleave", () => {
		dragging = false;
	});

	node.__gjjRealtimeCleanup = () => {
		try { fileInput.remove(); } catch (_) {}
		if (node.__gjjRealtimeUpstreamPoll) {
			clearInterval(node.__gjjRealtimeUpstreamPoll);
			delete node.__gjjRealtimeUpstreamPoll;
		}
	};
	node.__gjjRealtimeReloadImage = tryLoadInitialImage;
	node.__gjjRealtimeRefreshFromExecuted = refreshFromExecuted;
	node.__gjjRealtimeResize = resizeNode;
	if (!node.__gjjRealtimeUpstreamPoll) {
		node.__gjjRealtimeUpstreamPoll = setInterval(() => {
			const signature = getUpstreamImageInfo(node)?.signature || "";
			if (signature && signature !== node.__gjjRealtimeUpstreamSignature) {
				node.__gjjRealtimeUpstreamSignature = signature;
				tryLoadInitialImage({ force: true });
			}
		}, 500);
	}

	syncPreviewModeButtons();
	rebuild();
	setTimeout(tryLoadInitialImage, 250);
	setTimeout(resizeNode, 60);
	return root;
}

function imageToCanvas(img) {
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, img.naturalWidth || img.width || 1);
	canvas.height = Math.max(1, img.naturalHeight || img.height || 1);
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	return canvas;
}

function containRect(areaW, areaH, imgW, imgH) {
	const scale = Math.min(areaW / Math.max(1, imgW), areaH / Math.max(1, imgH));
	const w = Math.max(1, imgW * scale);
	const h = Math.max(1, imgH * scale);
	return { x: (areaW - w) / 2, y: (areaH - h) / 2, w, h };
}

function cloneCanvas(source) {
	const canvas = document.createElement("canvas");
	canvas.width = source.width;
	canvas.height = source.height;
	canvas.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0);
	return canvas;
}

function processCanvas(source, state) {
	let canvas = cloneCanvas(source);
	for (const id of state.selected) {
		const item = OP_BY_ID[id];
		if (!item) continue;
		try {
			canvas = applyCanvasOp(canvas, item, state.values[id] || {});
		} catch (error) {
			console.debug?.("[GJJ] 图片实时对比处理预览跳过操作", id, error);
		}
	}
	return canvas;
}

function applyCanvasOp(canvas, item, values) {
	const id = item.id;
	if (["rotate", "flip_h", "flip_v", "scale", "crop", "pad", "translate", "perspective", "aspect_crop", "exif_orient", "center_trim", "fixed_crop", "border_trim", "canvas_expand", "asymmetric_pad"].includes(id)) {
		return geometryOp(canvas, id, values);
	}
	if (["gaussian_blur", "mean_blur", "box_blur", "bilateral_blur", "radial_blur", "motion_blur", "denoise", "skin_blur", "soft_fog", "feather_alpha"].includes(id)) {
		const radius = finite(values.radius, id === "soft_fog" ? 6 : 0);
		const amount = finite(values.amount, finite(values.strength, radius > 0 ? 1 : 0));
		return blurCanvas(canvas, Math.max(radius, amount * 6));
	}
	if (["usm_sharpen", "smart_sharpen", "edge_sharpen", "channel_sharpen"].includes(id)) {
		return sharpenCanvas(canvas, finite(values.amount, 0) || Math.max(finite(values.red, 0), finite(values.green, 0), finite(values.blue, 0)));
	}
	if (["dilate", "erode", "open_morph", "close_morph"].includes(id)) {
		return morphCanvas(canvas, id, Math.round(finite(values.radius, 0)));
	}
	return pixelOp(canvas, id, values);
}

function geometryOp(canvas, id, values) {
	const out = document.createElement("canvas");
	let w = canvas.width;
	let h = canvas.height;
	if (id === "crop" || id === "fixed_crop") {
		w = Math.max(1, Math.round(canvas.width * clamp(finite(values.width, 1), 0.05, 1)));
		h = Math.max(1, Math.round(canvas.height * clamp(finite(values.height, 1), 0.05, 1)));
		out.width = w;
		out.height = h;
		out.getContext("2d").drawImage(canvas, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h, 0, 0, w, h);
		return out;
	}
	if (id === "aspect_crop") {
		const ratio = clamp(finite(values.ratio, 1), 0.2, 4);
		if (canvas.width / canvas.height > ratio) w = Math.round(canvas.height * ratio);
		else h = Math.round(canvas.width / ratio);
		out.width = w;
		out.height = h;
		out.getContext("2d").drawImage(canvas, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h, 0, 0, w, h);
		return out;
	}
	if (id === "center_trim") {
		const amount = clamp(finite(values.amount, 0), 0, 0.95);
		w = Math.max(1, Math.round(canvas.width * (1 - amount)));
		h = Math.max(1, Math.round(canvas.height * (1 - amount)));
		out.width = w;
		out.height = h;
		out.getContext("2d").drawImage(canvas, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h, 0, 0, w, h);
		return out;
	}
	if (id === "border_trim") {
		const amount = clamp(finite(values.amount, 0), 0, 0.45);
		const x = Math.round(canvas.width * amount);
		const y = Math.round(canvas.height * amount);
		w = Math.max(1, canvas.width - x * 2);
		h = Math.max(1, canvas.height - y * 2);
		out.width = w;
		out.height = h;
		out.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, w, h);
		return out;
	}
	if (id === "pad" || id === "canvas_expand" || id === "asymmetric_pad") {
		const unit = Math.min(canvas.width, canvas.height);
		const left = id === "asymmetric_pad" ? unit * finite(values.left, 0) : unit * finite(values.size ?? values.amount, 0);
		const right = id === "asymmetric_pad" ? unit * finite(values.right, 0) : left;
		const top = id === "asymmetric_pad" ? unit * finite(values.top, 0) : left;
		const bottom = id === "asymmetric_pad" ? unit * finite(values.bottom, 0) : left;
		out.width = Math.max(1, Math.round(canvas.width + left + right));
		out.height = Math.max(1, Math.round(canvas.height + top + bottom));
		const ctx = out.getContext("2d");
		const gray = Math.round(clamp(finite(values.value, 0), 0, 1) * 255);
		ctx.fillStyle = `rgb(${gray},${gray},${gray})`;
		ctx.fillRect(0, 0, out.width, out.height);
		ctx.drawImage(canvas, Math.round(left), Math.round(top));
		return out;
	}
	out.width = canvas.width;
	out.height = canvas.height;
	const ctx = out.getContext("2d");
	ctx.save();
	ctx.translate(out.width / 2, out.height / 2);
	if (id === "rotate") ctx.rotate((finite(values.angle, 0) * Math.PI) / 180);
	if (id === "exif_orient") ctx.rotate((Math.round(finite(values.quarter_turns, 0)) * Math.PI) / 2);
	if (id === "flip_h") ctx.scale(-1, 1);
	if (id === "flip_v") ctx.scale(1, -1);
	if (id === "scale") ctx.scale(Math.max(0.05, finite(values.x, 1)), Math.max(0.05, finite(values.y, 1)));
	if (id === "translate") ctx.translate(finite(values.x, 0) * canvas.width * 0.5, finite(values.y, 0) * canvas.height * 0.5);
	if (id === "perspective") ctx.transform(1, finite(values.y, 0), finite(values.x, 0), 1, 0, 0);
	ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
	ctx.restore();
	return out;
}

function pixelOp(canvas, id, values) {
	const out = cloneCanvas(canvas);
	const ctx = out.getContext("2d", { willReadFrequently: true });
	const imageData = ctx.getImageData(0, 0, out.width, out.height);
	const data = imageData.data;
	const w = out.width;
	const h = out.height;
	const lumaAt = (i) => (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
	for (let i = 0; i < data.length; i += 4) {
		let r = data[i] / 255;
		let g = data[i + 1] / 255;
		let b = data[i + 2] / 255;
		let a = data[i + 3] / 255;
		const lum = r * 0.299 + g * 0.587 + b * 0.114;
		if (id === "brightness") [r, g, b] = [r + finite(values.amount, 0), g + finite(values.amount, 0), b + finite(values.amount, 0)];
		else if (id === "contrast") {
			const amount = finite(values.amount, 0);
			const f = 1 + amount * (amount > 0 ? 2 : 1);
			[r, g, b] = [(r - 0.5) * f + 0.5, (g - 0.5) * f + 0.5, (b - 0.5) * f + 0.5];
		} else if (id === "saturation") {
			const f = 1 + finite(values.amount, 0);
			[r, g, b] = [lum + (r - lum) * f, lum + (g - lum) * f, lum + (b - lum) * f];
		} else if (id === "hue") {
			[r, g, b] = hueRotate(r, g, b, finite(values.degrees, 0));
		} else if (id === "lightness") {
			const amount = finite(values.amount, 0);
			[r, g, b] = amount >= 0 ? [r + (1 - r) * amount, g + (1 - g) * amount, b + (1 - b) * amount] : [r * (1 + amount), g * (1 + amount), b * (1 + amount)];
		} else if (id === "gamma") {
			const gamma = Math.max(0.05, finite(values.gamma, 1));
			[r, g, b] = [r ** (1 / gamma), g ** (1 / gamma), b ** (1 / gamma)];
		} else if (id === "levels") {
			const black = Math.min(finite(values.black, 0), finite(values.white, 1) - 0.001);
			const white = Math.max(finite(values.white, 1), black + 0.001);
			const gray = Math.max(0.05, finite(values.gray, 1));
			[r, g, b] = [r, g, b].map((x) => clamp(((x - black) / (white - black)), 0, 1) ** (1 / gray));
		} else if (id === "rgb_channels") [r, g, b] = [r * finite(values.red, 1), g * finite(values.green, 1), b * finite(values.blue, 1)];
		else if (id === "hsl_channels") {
			[r, g, b] = hueRotate(r, g, b, finite(values.hue, 0));
			const l = r * 0.299 + g * 0.587 + b * 0.114;
			const sf = 1 + finite(values.saturation, 0);
			[r, g, b] = [l + (r - l) * sf + finite(values.lightness, 0), l + (g - l) * sf + finite(values.lightness, 0), l + (b - l) * sf + finite(values.lightness, 0)];
		} else if (id === "invert" || id === "negative") {
			const amount = finite(values.amount, 1);
			[r, g, b] = [r * (1 - amount) + (1 - r) * amount, g * (1 - amount) + (1 - g) * amount, b * (1 - amount) + (1 - b) * amount];
		} else if (id === "grayscale") {
			const amount = finite(values.amount, 1);
			[r, g, b] = [r * (1 - amount) + lum * amount, g * (1 - amount) + lum * amount, b * (1 - amount) + lum * amount];
		} else if (id === "white_balance") [r, g, b] = [r + finite(values.temperature, 0), g + finite(values.tint, 0) * 0.5, b - finite(values.temperature, 0)];
		else if (id === "color_shift") {
			const amount = (finite(values.amount, 0) + 1) / 2;
			[r, g, b] = [r * (1 - amount) + b * amount, g * (1 - amount) + r * amount, b * (1 - amount) + g * amount];
		} else if (id === "color_temp") [r, g, b] = [r + finite(values.temperature, 0), g + finite(values.temperature, 0) * 0.18, b - finite(values.temperature, 0)];
		else if (id === "highlight_recover") {
			const m = clamp((lum - 0.55) / 0.45, 0, 1) * finite(values.amount, 0) * 0.6;
			[r, g, b] = [r - m, g - m, b - m];
		} else if (id === "shadow_lift") {
			const m = clamp((0.55 - lum) / 0.55, 0, 1) * finite(values.amount, 0);
			[r, g, b] = [r + (1 - r) * m, g + (1 - g) * m, b + (1 - b) * m];
		} else if (id === "exposure") [r, g, b] = [r, g, b].map((x) => x * 2 ** finite(values.ev, 0));
		else if (id === "split_tone") {
			const amount = finite(values.amount, 0);
			const shadow = hueColor(finite(values.shadow_hue, 220));
			const high = hueColor(finite(values.highlight_hue, 35));
			[r, g, b] = [r, g, b].map((x, c) => x * (1 - amount) + (shadow[c] * (1 - lum) + high[c] * lum) * amount);
		} else if (id === "auto_levels" || id === "auto_contrast" || id === "auto_white_balance") {
			const strength = finite(values.strength, 1);
			const avg = (r + g + b) / 3;
			[r, g, b] = [r * (1 - strength) + clamp((r - 0.05) / 0.9, 0, 1) * strength, g * (1 - strength) + clamp((g - 0.05) / 0.9, 0, 1) * strength, b * (1 - strength) + clamp((b - 0.05) / 0.9, 0, 1) * strength];
			if (id === "auto_white_balance") [r, g, b] = [r * (1 - strength) + avg * strength, g * (1 - strength) + avg * strength, b * (1 - strength) + avg * strength];
		} else if (id === "quantize") {
			const levels = Math.max(2, Math.round(finite(values.levels, 8)));
			[r, g, b] = [r, g, b].map((x) => Math.round(x * (levels - 1)) / (levels - 1));
		} else if (id === "threshold_key" || id === "mask_cut") {
			const threshold = finite(values.threshold, 0.5);
			const softness = Math.max(0.001, finite(values.softness, 0));
			const m = clamp((lum - threshold + softness) / (softness * 2), 0, 1);
			if (id === "mask_cut") a *= m;
			else [r, g, b] = [r * m, g * m, b * m];
		} else if (id === "binary" || id === "mono_mask") [r, g, b] = lum >= finite(values.threshold, 0.5) ? [1, 1, 1] : [0, 0, 0];
		else if (id === "blend_mode") {
			const mode = Math.round(finite(values.mode, 0)) % 5;
			const opacity = finite(values.opacity, 0.5);
			const overlay = [b, r, g];
			[r, g, b] = blendRGB([r, g, b], overlay, mode, opacity);
		} else if (id === "solid_overlay") {
			const overlay = [finite(values.red, 0), finite(values.green, 0.5), finite(values.blue, 1)];
			[r, g, b] = blendRGB([r, g, b], overlay, 3, finite(values.opacity, 0));
		} else if (id === "local_mask_color") {
			const amount = finite(values.amount, 0) * lum;
			[r, g, b] = [r + (b - r) * amount, g + (r - g) * amount, b + (g - b) * amount];
		} else if (id === "alpha_key") {
			const dist = Math.hypot(r, g - 1, b);
			a *= clamp((dist - finite(values.threshold, 0.1)) / Math.max(0.001, finite(values.softness, 0.05)), 0, 1);
		} else if (id === "mono_filter") {
			const amount = finite(values.amount, 0);
			const color = hueColor(finite(values.hue, 200));
			[r, g, b] = [r * (1 - amount) + lum * color[0] * amount, g * (1 - amount) + lum * color[1] * amount, b * (1 - amount) + lum * color[2] * amount];
		} else if (id === "sepia") {
			const amount = finite(values.amount, 0);
			const sr = r * 0.393 + g * 0.769 + b * 0.189;
			const sg = r * 0.349 + g * 0.686 + b * 0.168;
			const sb = r * 0.272 + g * 0.534 + b * 0.131;
			[r, g, b] = [r * (1 - amount) + sr * amount, g * (1 - amount) + sg * amount, b * (1 - amount) + sb * amount];
		} else if (id === "cool_cyan") {
			const amount = finite(values.amount, 0);
			[r, g, b] = [r - 0.06 * amount, g + 0.04 * amount, b + 0.12 * amount];
		} else if (id === "cyber_cool") {
			const amount = finite(values.amount, 0);
			const cyber = hueRotate(r * 1.18 + 0.03, g * 1.18 + 0.03, b * 1.18 + 0.03, -18);
			[r, g, b] = [r * (1 - amount) + cyber[0] * amount, g * (1 - amount) + cyber[1] * amount, b * (1 - amount) + cyber[2] * amount];
		} else if (id === "film_grain") {
			const n = pseudoNoise(i + finite(values.seed, 0) * 97) - 0.5;
			const amount = finite(values.amount, 0) * 0.35;
			[r, g, b] = [r + n * amount, g + n * amount, b + n * amount];
		} else if (id === "dust_gradient") {
			const x = ((i / 4) % w) / Math.max(1, w - 1);
			const amount = finite(values.amount, 0);
			[r, g, b] = [r * (1 - amount * 0.25) + x * amount * 0.25, g * (1 - amount * 0.25) + x * amount * 0.25, b * (1 - amount * 0.25) + x * amount * 0.25];
		} else if (id === "vignette") {
			const p = i / 4;
			const x = ((p % w) / Math.max(1, w - 1)) * 2 - 1;
			const y = (Math.floor(p / w) / Math.max(1, h - 1)) * 2 - 1;
			const mask = 1 - clamp((Math.hypot(x, y) - finite(values.size, 0.65)) / Math.max(0.001, 1.2 - finite(values.size, 0.65)), 0, 1) * finite(values.amount, 0);
			[r, g, b] = [r * mask, g * mask, b * mask];
		} else if (id === "sketch_desat") {
			const amount = finite(values.amount, 0);
			const edge = clamp(1 - Math.abs(lum - lumaAt(Math.max(0, i - 4))) * 5, 0, 1);
			[r, g, b] = [r * (1 - amount) + edge * amount, g * (1 - amount) + edge * amount, b * (1 - amount) + edge * amount];
		} else if (id === "alpha_extract") {
			const source = Math.round(finite(values.source, 0));
			const m = source ? lum : a;
			[r, g, b, a] = [m, m, m, 1];
		} else if (id === "transparent_remove" || id === "transparent_fill") {
			const bg = finite(values.background ?? values.value, 1);
			[r, g, b, a] = [r * a + bg * (1 - a), g * a + bg * (1 - a), b * a + bg * (1 - a), 1];
		} else if (id === "rgb_split_merge") {
			const mode = Math.round(finite(values.mode, 0)) % 4;
			if (mode === 1) [r, g, b] = [g, b, r];
			else if (mode === 2) [r, g, b] = [b, r, g];
			else if (mode === 3) [r, g, b] = [b, g, r];
		} else if (id === "channel_invert") {
			const channel = Math.round(finite(values.channel, 0)) % 3;
			if (channel === 0) r = 1 - r;
			if (channel === 1) g = 1 - g;
			if (channel === 2) b = 1 - b;
		} else if (id === "single_channel_gray") {
			const channel = Math.round(finite(values.channel, 0)) % 3;
			const m = channel === 0 ? r : channel === 1 ? g : b;
			[r, g, b] = [m, m, m];
		} else if (id === "rounded_corner") {
			const p = i / 4;
			const x = p % w;
			const y = Math.floor(p / w);
			const radius = Math.min(w, h) * finite(values.radius, 0);
			if (radius > 0) {
				const dx = Math.max(radius - Math.min(x, w - 1 - x), 0);
				const dy = Math.max(radius - Math.min(y, h - 1 - y), 0);
				if (Math.hypot(dx, dy) > radius) {
					const bg = finite(values.background, 0);
					[r, g, b, a] = [bg, bg, bg, a];
				}
			}
		}
		data[i] = clamp(Math.round(r * 255), 0, 255);
		data[i + 1] = clamp(Math.round(g * 255), 0, 255);
		data[i + 2] = clamp(Math.round(b * 255), 0, 255);
		data[i + 3] = clamp(Math.round(a * 255), 0, 255);
	}
	ctx.putImageData(imageData, 0, 0);
	return out;
}

function blurCanvas(canvas, radius) {
	radius = Math.max(0, radius);
	if (radius <= 0) return canvas;
	const out = document.createElement("canvas");
	out.width = canvas.width;
	out.height = canvas.height;
	const ctx = out.getContext("2d");
	ctx.filter = `blur(${radius}px)`;
	ctx.drawImage(canvas, 0, 0);
	ctx.filter = "none";
	return out;
}

function sharpenCanvas(canvas, amount) {
	amount = clamp(amount, 0, 3);
	if (amount <= 0) return canvas;
	const blurred = blurCanvas(canvas, 1.2);
	const out = cloneCanvas(canvas);
	const ctx = out.getContext("2d", { willReadFrequently: true });
	const a = ctx.getImageData(0, 0, out.width, out.height);
	const b = blurred.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, out.width, out.height);
	for (let i = 0; i < a.data.length; i += 4) {
		for (let c = 0; c < 3; c++) a.data[i + c] = clamp(a.data[i + c] + (a.data[i + c] - b.data[i + c]) * amount, 0, 255);
	}
	ctx.putImageData(a, 0, 0);
	return out;
}

function morphCanvas(canvas, id, radius) {
	if (radius <= 0) return canvas;
	const out = cloneCanvas(canvas);
	const ctx = out.getContext("2d", { willReadFrequently: true });
	const src = ctx.getImageData(0, 0, out.width, out.height);
	const dst = ctx.createImageData(out.width, out.height);
	const maxMode = id === "dilate" || id === "close_morph";
	for (let y = 0; y < out.height; y++) {
		for (let x = 0; x < out.width; x++) {
			const di = (y * out.width + x) * 4;
			for (let c = 0; c < 4; c++) {
				let best = maxMode ? 0 : 255;
				for (let yy = -radius; yy <= radius; yy++) {
					for (let xx = -radius; xx <= radius; xx++) {
						const sx = clamp(x + xx, 0, out.width - 1);
						const sy = clamp(y + yy, 0, out.height - 1);
						const value = src.data[(sy * out.width + sx) * 4 + c];
						best = maxMode ? Math.max(best, value) : Math.min(best, value);
					}
				}
				dst.data[di + c] = best;
			}
		}
	}
	ctx.putImageData(dst, 0, 0);
	if (id === "open_morph") return morphCanvas(out, "dilate", radius);
	if (id === "close_morph") return morphCanvas(out, "erode", radius);
	return out;
}

function hueRotate(r, g, b, degrees) {
	const angle = (degrees * Math.PI) / 180;
	const cosA = Math.cos(angle);
	const sinA = Math.sin(angle);
	return [
		r * (0.299 + 0.701 * cosA + 0.168 * sinA) + g * (0.587 - 0.587 * cosA + 0.330 * sinA) + b * (0.114 - 0.114 * cosA - 0.497 * sinA),
		r * (0.299 - 0.299 * cosA - 0.328 * sinA) + g * (0.587 + 0.413 * cosA + 0.035 * sinA) + b * (0.114 - 0.114 * cosA + 0.292 * sinA),
		r * (0.299 - 0.300 * cosA + 1.250 * sinA) + g * (0.587 - 0.588 * cosA - 1.050 * sinA) + b * (0.114 + 0.886 * cosA - 0.203 * sinA),
	];
}

function hueColor(degrees) {
	const h = ((degrees % 360) + 360) % 360 / 60;
	const c = 1;
	const x = c * (1 - Math.abs((h % 2) - 1));
	if (h < 1) return [c, x, 0];
	if (h < 2) return [x, c, 0];
	if (h < 3) return [0, c, x];
	if (h < 4) return [0, x, c];
	if (h < 5) return [x, 0, c];
	return [c, 0, x];
}

function blendRGB(base, overlay, mode, opacity) {
	const mixed = base.map((v, i) => {
		const o = overlay[i];
		if (mode === 1) return v * o;
		if (mode === 2) return 1 - (1 - v) * (1 - o);
		if (mode === 3) return v < 0.5 ? 2 * v * o : 1 - 2 * (1 - v) * (1 - o);
		if (mode === 4) return Math.abs(v - o);
		return o;
	});
	return base.map((v, i) => v * (1 - opacity) + mixed[i] * opacity);
}

function pseudoNoise(seed) {
	const x = Math.sin(seed * 12.9898) * 43758.5453;
	return x - Math.floor(x);
}

function ensurePanel(node) {
	if (node.__gjjRealtimePanelWidget) return;
	node.properties = node.properties || {};
	if (!getHiddenValue(node, INTERNAL_FILE_WIDGET, "")) {
		node.properties[INTERNAL_FILE_WIDGET] = DEFAULT_IMAGE_URL;
	}
	compactNode(node);
	const root = createPanel(node);
	const widget = node.addDOMWidget(PANEL_WIDGET, "HTML", root, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => node.__gjjRealtimeImageProcessorHeight || Math.max(260, root.scrollHeight || root.offsetHeight || 260),
	});
	widget.serialize = false;
	node.__gjjRealtimePanelWidget = widget;
	GJJ_Utils.reorderWidgets(node, HIDDEN_WIDGETS);
	GJJ_Utils.refreshNode(node);
}

app.registerExtension({
	name: "GJJ.RealtimeImageProcessor",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== TARGET_CLASS) return;

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => ensurePanel(this), 0);
			setTimeout(() => compactNode(this), 120);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (serializedNode, ...args) {
			const result = originalOnConfigure?.apply(this, [serializedNode, ...args]);
			this.properties = this.properties || {};
			const savedConfig = serializedNode?.properties?.[CONFIG_WIDGET] || legacyWidgetValue(serializedNode, 0);
			const savedInternalFile = serializedNode?.properties?.[INTERNAL_FILE_WIDGET] || legacyWidgetValue(serializedNode, 1);
			if (savedConfig) this.properties[CONFIG_WIDGET] = savedConfig;
			if (savedInternalFile) this.properties[INTERNAL_FILE_WIDGET] = savedInternalFile;
			else if (!this.properties[INTERNAL_FILE_WIDGET]) this.properties[INTERNAL_FILE_WIDGET] = DEFAULT_IMAGE_URL;
			if (serializedNode?.properties?.gjj_realtime_preview_mode) {
				this.properties.gjj_realtime_preview_mode = normalizePreviewMode(serializedNode.properties.gjj_realtime_preview_mode);
			}
			setTimeout(() => ensurePanel(this), 0);
			setTimeout(() => compactNode(this), 120);
			return result;
		};

		const originalOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (serializedNode) {
			const savedConfig = getHiddenValue(this, CONFIG_WIDGET, JSON.stringify(defaultState()));
			const savedInternalFile = getHiddenValue(this, INTERNAL_FILE_WIDGET, DEFAULT_IMAGE_URL);
			const result = originalOnSerialize?.apply(this, [serializedNode]);
			serializedNode.properties = serializedNode.properties || {};
			serializedNode.properties[CONFIG_WIDGET] = savedConfig;
			serializedNode.properties[INTERNAL_FILE_WIDGET] = savedInternalFile;
			serializedNode.properties.gjj_realtime_compare_ratio = finite(this.properties?.gjj_realtime_compare_ratio, 0.5);
			serializedNode.properties.gjj_realtime_preview_mode = normalizePreviewMode(this.properties?.gjj_realtime_preview_mode);
			if (Array.isArray(serializedNode.widgets_values) && Array.isArray(this.widgets)) {
				const configIndex = this.widgets.findIndex((widget) => widget?.name === CONFIG_WIDGET);
				if (configIndex >= 0) serializedNode.widgets_values[configIndex] = savedConfig;
			}
			compactNode(this);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (slotType, slotIndex, connected, linkInfo) {
			const result = originalOnConnectionsChange?.apply(this, arguments);
			if (isInputSlotChange(slotType)) {
				const input = this.inputs?.[slotIndex];
				if (!input || input === linkedImageInput(this) || isImageInput(input)) {
					setTimeout(() => this.__gjjRealtimeReloadImage?.({ force: true }), 160);
				}
			}
			return result;
		};

		const originalOnResize = nodeType.prototype.onResize;
		nodeType.prototype.onResize = function (...args) {
			const result = originalOnResize?.apply(this, args);
			if (!this.__gjjRealtimeImageProcessorSizing) {
				setTimeout(() => {
					this.__gjjRealtimeResize?.();
					this.__gjjRealtimeReloadImage?.();
				}, 0);
			}
			return result;
		};

		const originalOnDrawForeground = nodeType.prototype.onDrawForeground;
		nodeType.prototype.onDrawForeground = function (...args) {
			const result = originalOnDrawForeground?.apply(this, args);
			const signature = getUpstreamImageInfo(this)?.signature || "";
			if (signature !== this.__gjjRealtimeUpstreamSignature) {
				this.__gjjRealtimeUpstreamSignature = signature;
				setTimeout(() => this.__gjjRealtimeReloadImage?.({ force: true }), 80);
			}
			return result;
		};

		const originalOnRemoved = nodeType.prototype.onRemoved;
		nodeType.prototype.onRemoved = function (...args) {
			this.__gjjRealtimeCleanup?.();
			return originalOnRemoved?.apply(this, args);
		};
	},

	nodeCreated(node) {
		if (targetClass(node) !== TARGET_CLASS) return;
		ensurePanel(node);
		setTimeout(() => compactNode(node), 120);
	},
});

if (!window.__gjjRealtimeImageProcessorExecutedListenerInstalled) {
	window.__gjjRealtimeImageProcessorExecutedListenerInstalled = true;
	api.addEventListener("executed", (event) => {
		const sourceId = eventNodeId(event);
		if (!sourceId) return;
		for (const node of app.graph?._nodes || []) {
			if (targetClass(node) !== TARGET_CLASS) continue;
			node.__gjjRealtimeRefreshFromExecuted?.(event);
		}
	});
}
