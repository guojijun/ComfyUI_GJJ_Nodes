import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { GJJ_Utils, queueOnlyCurrentNode } from "./gjj_utils.js";

const NODE_NAME = "GJJ_ImageToSVGZero";
const UI_KEY = "gjj_image_to_svg_zero";
const PANEL_WIDGET = "__gjj_image_to_svg_zero_panel";
const PREVIEW_WIDGET = "__gjj_image_to_svg_zero_preview";
const UPLOAD_SUBFOLDER = "gjj_image_to_svg_zero";
const BRANCHES = [
	{ key: "彩色", icon: "🎨", title: "彩色色块 SVG" },
	{ key: "黑白", icon: "⚫", title: "黑白色块 SVG" },
	{ key: "线稿", icon: "✏️", title: "边缘线稿 SVG" },
	{ key: "内嵌", icon: "🧩", title: "兼容旧工作流：输出色块 SVG，不嵌入位图" },
];
const PARAM_WIDGETS = [
	"branch",
	"max_size",
	"color_count",
	"threshold",
	"background",
	"foreground",
	"invert",
	"min_alpha",
	"filename_prefix",
	"save_directory",
	"file_references",
	"hierarchical",
	"trace_mode",
	"filter_speckle",
	"color_precision",
	"layer_difference",
	"corner_threshold",
	"length_threshold",
	"max_iterations",
	"splice_threshold",
	"path_precision",
	"input_foreground",
	"turnpolicy",
	"turdsize",
	"zero_sharp_corners",
	"opttolerance",
	"optimize_curve",
	"stroke_color",
	"stroke_width",
];
const SETTINGS_WIDGETS = PARAM_WIDGETS.filter((name) => name !== "file_references");
const VISIBLE_SETTINGS_WIDGETS = SETTINGS_WIDGETS.filter((name) => name !== "background");
const COMMON_SETTINGS_WIDGETS = ["filename_prefix", "save_directory"];
const BRANCH_SETTINGS_WIDGETS = {
	"彩色": ["max_size", "hierarchical", "trace_mode", "filter_speckle", "color_precision", "layer_difference", "corner_threshold", "length_threshold", "max_iterations", "splice_threshold", "path_precision", "min_alpha"],
	"黑白": ["max_size", "trace_mode", "filter_speckle", "corner_threshold", "length_threshold", "splice_threshold", "threshold", "input_foreground", "turnpolicy", "turdsize", "zero_sharp_corners", "opttolerance", "optimize_curve", "foreground"],
	"线稿": ["max_size", "trace_mode", "filter_speckle", "corner_threshold", "length_threshold", "splice_threshold", "threshold", "foreground", "stroke_color", "stroke_width"],
	"内嵌": ["max_size", "trace_mode", "filter_speckle", "color_precision", "path_precision"],
};
const SELECT_OPTIONS = {
	hierarchical: ["stacked", "cutout"],
	trace_mode: ["spline", "polygon", "none"],
	input_foreground: ["Black on White", "White on Black"],
	turnpolicy: ["minority", "majority", "black", "white", "left", "right"],
};
const PREVIEW_BG_PROP = "gjj_image_to_svg_preview_background";
const PREVIEW_BG_OPEN_PROP = "gjj_image_to_svg_preview_background_open";
const PREVIEW_BG_SWATCHES = ["transparent", "#ffffff", "#f8fafc", "#1d2328", "#111111", "#3b82f6", "#22c55e", "#f59e0b", "#ef4444"];

function isTarget(node) {
	return (node?.comfyClass || node?.type) === NODE_NAME;
}

function widget(node, name) {
	return GJJ_Utils.getWidget?.(node, name) || node?.widgets?.find((item) => item?.name === name);
}

function value(node, name, fallback = "") {
	const found = widget(node, name);
	return found ? found.value : fallback;
}

function setValue(node, name, next) {
	const found = widget(node, name);
	if (!found) return;
	found.value = next;
	const index = node.widgets?.indexOf(found) ?? -1;
	if (Array.isArray(node.widgets_values) && index >= 0) node.widgets_values[index] = next;
	try { found.callback?.(next); } catch (_) {}
	app.graph?.setDirtyCanvas?.(true, true);
}

function hideWidget(found) {
	if (!found) return;
	found.hidden = true;
	found.serialize = true;
	found.disabled = true;
	found.type = "hidden";
	found.options ||= {};
	found.options.hidden = true;
	found.options.display = "hidden";
	found.computeSize = () => [0, -4];
	found.getHeight = () => 0;
	found.draw = () => {};
	found.mouse = () => false;
	if (found.widget) found.widget.style.display = "none";
	if (found.element) found.element.style.display = "none";
	if (found.inputEl) found.inputEl.style.display = "none";
}

function hideNativeWidgets(node) {
	for (const name of PARAM_WIDGETS) hideWidget(widget(node, name));
}

function protect(event) {
	event?.preventDefault?.();
	event?.stopPropagation?.();
}

function buttonBase(button) {
	button.type = "button";
	button.style.cssText = [
		"height:30px",
		"min-width:30px",
		"border:1px solid #43545c",
		"border-radius:6px",
		"background:#1d2b31",
		"color:#edf6fa",
		"font:700 14px/1 system-ui,sans-serif",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"cursor:pointer",
		"padding:0 8px",
		"box-sizing:border-box",
	].join(";");
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
		button.addEventListener(eventName, protect, true);
	}
	return button;
}

function setBranch(node, branch) {
	setValue(node, "branch", branch);
	renderPanel(node);
}

function activeBranch(node) {
	const current = String(value(node, "branch", "彩色") || "彩色");
	return BRANCHES.some((item) => item.key === current) ? current : "彩色";
}

function visibleSettings(node) {
	const ordered = [...(BRANCH_SETTINGS_WIDGETS[activeBranch(node)] || []), ...COMMON_SETTINGS_WIDGETS];
	return ordered.filter((name) => VISIBLE_SETTINGS_WIDGETS.includes(name));
}

function uploadUrl(path) {
	try {
		return api?.apiURL ? api.apiURL(path) : path;
	} catch (_) {
		return path;
	}
}

async function uploadImageFile(file) {
	const form = new FormData();
	form.append("image", file, file.name);
	form.append("type", "input");
	form.append("subfolder", UPLOAD_SUBFOLDER);
	form.append("overwrite", "true");
	const endpoints = ["/upload/image", "/api/upload/image"];
	let lastError = null;
	for (const endpoint of endpoints) {
		try {
			const response = await fetch(uploadUrl(endpoint), { method: "POST", body: form });
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				lastError = new Error(data?.error || response.statusText || `HTTP ${response.status}`);
				continue;
			}
			return {
				filename: String(data?.name || data?.filename || file.name),
				subfolder: String(data?.subfolder || UPLOAD_SUBFOLDER),
				type: "input",
				name: file.name,
				size: file.size,
			};
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError || new Error("上传失败");
}

async function pickFiles(node) {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "image/*";
	input.multiple = true;
	input.style.position = "fixed";
	input.style.left = "-9999px";
	document.body.appendChild(input);
	try {
		const files = await new Promise((resolve) => {
			input.addEventListener("change", () => resolve(Array.from(input.files || [])), { once: true });
			input.click();
		});
		if (!files.length) return;
		const status = node.__gjjSvgStatus;
		if (status) status.textContent = `正在上传 ${files.length} 个文件...`;
		const refs = [];
		for (const file of files) refs.push(await uploadImageFile(file));
		setValue(node, "file_references", JSON.stringify(refs));
		if (status) status.textContent = `已选择 ${refs.length} 个文件，点击 ▶ 执行。`;
		renderPanel(node);
	} catch (error) {
		if (node.__gjjSvgStatus) node.__gjjSvgStatus.textContent = `上传失败：${error?.message || error}`;
		console.warn("[GJJ_ImageToSVGZero] upload failed", error);
	} finally {
		input.remove();
	}
}

function fileRefs(node) {
	try {
		const refs = JSON.parse(String(value(node, "file_references", "[]") || "[]"));
		return Array.isArray(refs) ? refs : [];
	} catch (_) {
		return [];
	}
}

function setSettingsOpen(node, open) {
	node.properties ||= {};
	node.properties.gjj_image_to_svg_settings_open = Boolean(open);
	renderPanel(node);
	GJJ_Utils.refreshNode?.(node);
}

function settingsOpen(node) {
	return Boolean(node?.properties?.gjj_image_to_svg_settings_open);
}

function previewBackground(node) {
	return String(node?.properties?.[PREVIEW_BG_PROP] || "transparent").trim() || "transparent";
}

function colorInputValue(node) {
	const current = previewBackground(node);
	return /^#[0-9a-f]{6}$/i.test(current) ? current : "#f8fafc";
}

function normalizeColorValue(value, fallback = "#111111") {
	const text = String(value || "").trim();
	if (/^#[0-9a-f]{6}$/i.test(text)) return text;
	if (/^#[0-9a-f]{3}$/i.test(text)) {
		return "#" + text.slice(1).split("").map((ch) => ch + ch).join("");
	}
	return fallback;
}

function colorPanelOpen(node) {
	return Boolean(node?.properties?.[PREVIEW_BG_OPEN_PROP]);
}

function setColorPanelOpen(node, open) {
	node.properties ||= {};
	node.properties[PREVIEW_BG_OPEN_PROP] = Boolean(open);
	renderPanel(node);
	GJJ_Utils.refreshNode?.(node);
}

function applyPreviewBackground(node, color) {
	node.properties ||= {};
	node.properties[PREVIEW_BG_PROP] = String(color || "transparent").trim() || "transparent";
	if (node.__gjjSvgPreviewViewport) node.__gjjSvgPreviewViewport.style.background = previewBackground(node);
	renderPanel(node);
	GJJ_Utils.refreshNode?.(node);
}

function openSavePrompt(node) {
	const current = String(value(node, "save_directory", "") || "");
	const next = window.prompt("SVG 保存路径：可填绝对路径，或相对 ComfyUI/output 的目录。留空表示不自动保存。", current);
	if (next === null) return;
	setValue(node, "save_directory", String(next || "").trim());
	renderPanel(node);
}

async function runNode(node) {
	if (node.__gjjSvgStatus) node.__gjjSvgStatus.textContent = "正在提交当前节点...";
	try {
		const ok = await queueOnlyCurrentNode(node);
		if (node.__gjjSvgStatus) node.__gjjSvgStatus.textContent = ok ? "已提交，等待 SVG..." : "提交失败";
	} catch (error) {
		if (node.__gjjSvgStatus) node.__gjjSvgStatus.textContent = `执行失败：${error?.message || error}`;
	}
}

function createPanel(node) {
	const wrap = document.createElement("div");
	wrap.className = "gjj-svg-zero";
	wrap.style.cssText = "position:relative;display:flex;flex-direction:column;gap:6px;width:100%;box-sizing:border-box;color:#dce7ea;font:12px/1.35 system-ui,sans-serif;overflow:visible;";
	const bar = document.createElement("div");
	bar.style.cssText = "display:flex;align-items:center;gap:5px;width:100%;box-sizing:border-box;flex-wrap:wrap;";

	const run = buttonBase(document.createElement("button"));
	run.textContent = "▶";
	run.title = "只执行当前节点";
	run.style.background = "#12533e";
	run.style.borderColor = "#2ea86f";
	run.addEventListener("click", (event) => {
		protect(event);
		void runNode(node);
	});

	const open = buttonBase(document.createElement("button"));
	open.textContent = "📂";
	open.title = "打开一个或多个图片文件";
	open.addEventListener("click", (event) => {
		protect(event);
		void pickFiles(node);
	});

	const save = buttonBase(document.createElement("button"));
	save.textContent = "💾";
	save.title = "设置 SVG 保存路径";
	save.addEventListener("click", (event) => {
		protect(event);
		openSavePrompt(node);
	});

	const settings = buttonBase(document.createElement("button"));
	settings.textContent = "⚙️";
	settings.title = "显示参数浮动窗口";
	settings.dataset.action = "settings";
	settings.addEventListener("click", (event) => {
		protect(event);
		setSettingsOpen(node, !settingsOpen(node));
	});

	const color = buttonBase(document.createElement("button"));
	color.textContent = "🖌️";
	color.title = "设置节点内 SVG 预览底色，不写入 SVG";
	color.dataset.action = "preview-bg";
	color.addEventListener("click", (event) => {
		protect(event);
		setColorPanelOpen(node, !colorPanelOpen(node));
	});

	bar.append(open);
	for (const item of BRANCHES) {
		const branch = buttonBase(document.createElement("button"));
		branch.textContent = item.icon;
		branch.dataset.branch = item.key;
		branch.title = item.title;
		branch.addEventListener("click", (event) => {
			protect(event);
			setBranch(node, item.key);
		});
		bar.append(branch);
	}
	bar.append(color, save, settings, run);

	const status = document.createElement("div");
	status.className = "gjj-svg-status";
	status.style.cssText = "min-height:17px;color:#9fb2ba;white-space:normal;";
	status.textContent = "可连接图片，或点击 📂 上传图片。";
	node.__gjjSvgStatus = status;

	const float = document.createElement("div");
	float.className = "gjj-svg-settings";
	float.style.cssText = [
		"display:none",
		"position:absolute",
		"z-index:20",
		"top:37px",
		"right:0",
		"width:min(520px,100%)",
		"grid-template-columns:1fr",
		"gap:7px",
		"padding:9px",
		"border:1px solid #4b626d",
		"border-radius:7px",
		"background:#111c21",
		"box-shadow:0 10px 26px rgba(0,0,0,.42)",
		"box-sizing:border-box",
	].join(";");
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "wheel"]) {
		float.addEventListener(eventName, (event) => event.stopPropagation());
	}
	node.__gjjSvgSettings = float;
	const colorPanel = document.createElement("div");
	colorPanel.className = "gjj-svg-preview-bg-panel";
	colorPanel.style.cssText = [
		"display:none",
		"position:absolute",
		"z-index:21",
		"top:37px",
		"left:0",
		"width:min(300px,100%)",
		"grid-template-columns:28px 1fr",
		"gap:7px",
		"align-items:center",
		"padding:9px",
		"border:1px solid #4b626d",
		"border-radius:7px",
		"background:#111c21",
		"box-shadow:0 10px 26px rgba(0,0,0,.42)",
		"box-sizing:border-box",
	].join(";");
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "wheel"]) {
		colorPanel.addEventListener(eventName, (event) => event.stopPropagation());
	}
	node.__gjjSvgColorPanel = colorPanel;
	wrap.append(bar, float, colorPanel, status);
	installOutsideClose(node);
	return wrap;
}

function fieldKind(name) {
	if (["invert", "zero_sharp_corners", "optimize_curve"].includes(name)) return "checkbox";
	if (["foreground", "stroke_color"].includes(name)) return "color";
	if (SELECT_OPTIONS[name]) return "select";
	if (["max_size", "color_count", "threshold", "min_alpha", "filter_speckle", "color_precision", "layer_difference", "corner_threshold", "length_threshold", "max_iterations", "splice_threshold", "path_precision", "turdsize", "opttolerance", "stroke_width"].includes(name)) return "number";
	return "text";
}

function fieldLabel(name) {
	return ({
		branch: "分支",
		max_size: "最大尺寸",
		color_count: "颜色数",
		threshold: "阈值",
		hierarchical: "层级方式",
		trace_mode: "描摹模式",
		filter_speckle: "斑点过滤",
		color_precision: "颜色精度",
		layer_difference: "层级差异",
		corner_threshold: "拐角阈值",
		length_threshold: "长度阈值",
		max_iterations: "最大迭代",
		splice_threshold: "拼接阈值",
		path_precision: "路径精度",
		input_foreground: "前景判定",
		turnpolicy: "转向策略",
		turdsize: "杂点尺寸",
		zero_sharp_corners: "消除尖角",
		opttolerance: "优化容差",
		optimize_curve: "优化曲线",
		foreground: "前景色",
		stroke_color: "描边颜色",
		stroke_width: "描边宽度",
		invert: "反相",
		min_alpha: "透明阈值",
		filename_prefix: "文件名前缀",
		save_directory: "保存路径",
	})[name] || name;
}

function fieldTooltip(name) {
	return ({
		branch: "选择当前转换分支。不同分支会显示不同参数，并使用不同的描摹方式。",
		max_size: "处理前把输入图像缩放到的最长边尺寸。数值越大保留细节越多，但 SVG 路径数量和计算时间也会增加。",
		color_count: "旧版颜色数量参数。当前彩色分支主要使用“颜色精度”控制调色板规模，保留此项用于兼容旧工作流。",
		threshold: "黑白或线稿判定阈值。数值越低会保留更多暗部/边缘，数值越高会让结果更稀疏。",
		hierarchical: "彩色描摹的层级组织方式。stacked 倾向逐层叠加色块；cutout 预留为裁切式层级选项，当前零依赖实现会保持兼容读取。",
		trace_mode: "路径描摹模式。spline 使用平滑二次曲线；polygon 使用直线多边形；none 当前会按 polygon 兼容处理。",
		filter_speckle: "过滤小面积噪点的最小像素面积。彩色默认 2，优先保留头发、五官和衣服细节；透明/白底碎块主要由边缘背景剔除处理。",
		color_precision: "彩色分支的颜色精度。默认 7 约 128 色，适合人像保留明暗和材质层次；越大颜色越丰富，路径也越多。",
		layer_difference: "层级差异阈值，保留给 VTracer 风格调参。当前零依赖生成会记录该值，但主要由颜色精度和斑点过滤影响结果。",
		corner_threshold: "拐角识别阈值，保留给 VTracer 风格调参。当前平滑路径由描摹模式控制，此值用于兼容配置。",
		length_threshold: "轮廓简化和平滑强度。彩色默认 2.5，尽量减少锯齿又不抹掉五官细节；数值越大越平滑但越容易丢内容。",
		max_iterations: "曲线拟合最大迭代次数，保留给 VTracer 风格调参。当前轻量算法不做迭代拟合，但会保存该参数。",
		splice_threshold: "路径拼接角度阈值，保留给 VTracer 风格调参。当前零依赖实现暂不直接使用。",
		path_precision: "SVG 路径坐标的小数精度。数值越大坐标越精细、文件略大；数值越小文件更紧凑。",
		input_foreground: "黑白输入的前景方向。Black on White 适合白底黑物；White on Black 会反转前景判定。",
		turnpolicy: "Potrace 风格的路径转向策略。当前零依赖实现主要保留配置兼容，复杂交叉处仍由内部轮廓追踪决定。",
		turdsize: "Potrace 风格杂点过滤尺寸。会和斑点过滤一起生效，数值越大越会删除小孤立区域。",
		zero_sharp_corners: "Potrace 风格尖角处理开关。当前平滑路径已经会柔化角点，此项保留给配置兼容。",
		opttolerance: "曲线优化容差，会参与轮廓简化。默认 0.45 偏保细节；调大可减少锯齿，调小可保留更多原图边缘。",
		optimize_curve: "Potrace 风格曲线优化开关。当前生成默认已做轻量平滑，此项保留给兼容配置。",
		foreground: "黑白/线稿路径的填充颜色。只影响生成 SVG 的前景形状颜色，不会添加背景。",
		stroke_color: "线稿分支使用的线条颜色。当前实现会把线稿区域作为 SVG path 填充为该颜色。",
		stroke_width: "线稿描边宽度参数，保留给描边式输出兼容。当前零依赖实现主要输出填充 path。",
		invert: "反转前景/背景判定。打开后会选取相反区域生成路径。",
		min_alpha: "透明阈值。默认 64 会忽略较淡的半透明背景噪点，减少白色碎块；如果透明边缘细节丢失，可适当降低。",
		filename_prefix: "保存 SVG 文件时使用的文件名前缀。仅在填写保存路径时生效。",
		save_directory: "SVG 自动保存目录。可填绝对路径，或相对 ComfyUI/output 的目录；留空则只输出字符串不落盘。",
	})[name] || "";
}

function renderSettings(node) {
	const float = node.__gjjSvgSettings;
	if (!float) return;
	float.style.display = settingsOpen(node) ? "grid" : "none";
	if (!settingsOpen(node)) return;
	float.innerHTML = "";
	for (const name of visibleSettings(node)) {
		const row = document.createElement("label");
		row.style.cssText = "display:grid;grid-template-columns:116px minmax(0,1fr);gap:8px;align-items:center;min-width:0;color:#aebfc6;font:700 12px/1.2 system-ui,sans-serif;";
		const tooltip = fieldTooltip(name);
		if (tooltip) row.title = tooltip;
		const label = document.createElement("span");
		label.textContent = fieldLabel(name);
		label.style.cssText = "min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
		if (tooltip) label.title = tooltip;
		const kind = fieldKind(name);
		const input = document.createElement(kind === "select" ? "select" : "input");
		if (kind !== "select") input.type = kind;
		if (tooltip) input.title = tooltip;
		input.style.cssText = ["foreground", "stroke_color"].includes(name)
			? "height:28px;width:40px;border:1px solid #3f535c;border-radius:5px;background:transparent;padding:0;box-sizing:border-box;cursor:pointer;"
			: "height:27px;border:1px solid #3f535c;border-radius:5px;background:#17262c;color:#edf7f9;padding:0 7px;box-sizing:border-box;font:12px system-ui,sans-serif;min-width:0;";
		if (name === "branch") {
			input.disabled = true;
			input.value = activeBranch(node);
		} else if (["foreground", "stroke_color"].includes(name)) {
			const colorWrap = document.createElement("div");
			colorWrap.style.cssText = "display:grid;grid-template-columns:40px minmax(0,1fr);gap:7px;align-items:center;min-width:0;";
			const colorText = document.createElement("input");
			colorText.type = "text";
			colorText.value = normalizeColorValue(value(node, name, "#111111"));
			colorText.spellcheck = false;
			if (tooltip) colorText.title = tooltip;
			colorText.style.cssText = "height:28px;border:1px solid #3f535c;border-radius:5px;background:#17262c;color:#edf7f9;padding:0 7px;box-sizing:border-box;font:12px system-ui,sans-serif;min-width:0;";
			input.value = normalizeColorValue(value(node, name, "#111111"));
			const applyColor = (next) => {
				const color = normalizeColorValue(next, input.value || "#111111");
				input.value = color;
				colorText.value = color;
				setValue(node, name, color);
			};
			input.addEventListener("input", () => applyColor(input.value));
			input.addEventListener("change", () => applyColor(input.value));
			colorText.addEventListener("change", () => applyColor(colorText.value));
			for (const eventName of ["pointerdown", "mousedown", "mouseup", "keydown", "wheel"]) {
				colorText.addEventListener(eventName, (event) => event.stopPropagation());
			}
			colorWrap.append(input, colorText);
			row.append(label, colorWrap);
			float.append(row);
			continue;
		} else if (kind === "select") {
			const options = SELECT_OPTIONS[name] || [];
			input.innerHTML = options.map((item) => `<option value="${String(item).replaceAll('"', "&quot;")}">${item}</option>`).join("");
			input.value = String(value(node, name, options[0] || "") || options[0] || "");
			input.addEventListener("change", () => setValue(node, name, input.value));
		} else if (input.type === "checkbox") {
			input.checked = Boolean(value(node, name, false));
			input.addEventListener("change", () => setValue(node, name, input.checked));
		} else {
			input.value = String(value(node, name, "") ?? "");
			input.addEventListener("change", () => setValue(node, name, input.type === "number" ? Number(input.value) : input.value));
		}
		for (const eventName of ["pointerdown", "mousedown", "mouseup", "keydown", "wheel"]) {
			input.addEventListener(eventName, (event) => event.stopPropagation());
		}
		row.append(label, input);
		float.append(row);
	}
	const refs = document.createElement("div");
	refs.style.cssText = "color:#8ba1a8;font:11px/1.35 system-ui,sans-serif;white-space:normal;overflow-wrap:anywhere;";
	const count = fileRefs(node).length;
	const savePath = String(value(node, "save_directory", "") || "").trim();
	refs.textContent = `已上传文件：${count} 个${savePath ? `；保存到：${savePath}` : ""}`;
	float.append(refs);
}

function renderColorPanel(node) {
	const panel = node.__gjjSvgColorPanel;
	if (!panel) return;
	panel.style.display = colorPanelOpen(node) ? "grid" : "none";
	if (!colorPanelOpen(node)) return;
	panel.innerHTML = "";

	const picker = document.createElement("input");
	picker.type = "color";
	picker.value = colorInputValue(node);
	picker.title = "预览底色";
	picker.style.cssText = "width:28px;height:28px;border:1px solid #526972;border-radius:5px;background:transparent;padding:0;cursor:pointer;";
	picker.addEventListener("input", () => applyPreviewBackground(node, picker.value));
	picker.addEventListener("change", () => applyPreviewBackground(node, picker.value));
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "keydown", "wheel"]) {
		picker.addEventListener(eventName, (event) => event.stopPropagation());
	}

	const swatches = document.createElement("div");
	swatches.style.cssText = "display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-width:0;";
	for (const color of PREVIEW_BG_SWATCHES) {
		const swatch = document.createElement("button");
		swatch.type = "button";
		swatch.title = color === "transparent" ? "透明" : color;
		swatch.style.cssText = [
			"width:24px",
			"height:24px",
			"border:1px solid #526972",
			"border-radius:5px",
			"cursor:pointer",
			"padding:0",
			`background:${color === "transparent" ? "linear-gradient(135deg,#eee 0 25%,#aaa 25% 50%,#eee 50% 75%,#aaa 75%)" : color}`,
		].join(";");
		if (previewBackground(node).toLowerCase() === color.toLowerCase()) swatch.style.outline = "2px solid #8fd3ff";
		swatch.addEventListener("click", (event) => {
			protect(event);
			applyPreviewBackground(node, color);
		});
		swatches.append(swatch);
	}
	panel.append(picker, swatches);
}

function eventPath(event) {
	return typeof event.composedPath === "function" ? event.composedPath() : [];
}

function eventInside(element, event) {
	if (!element) return false;
	const path = eventPath(event);
	return path.includes(element) || element.contains?.(event.target);
}

function eventOnFloatingToggle(node, event) {
	const panel = node.__gjjSvgPanel;
	const target = event.target?.closest?.("button[data-action]");
	return Boolean(target && panel?.contains?.(target) && ["settings", "preview-bg"].includes(target.dataset.action));
}

function closeFloatingPanels(node) {
	node.properties ||= {};
	const wasSettingsOpen = settingsOpen(node);
	const wasColorOpen = colorPanelOpen(node);
	if (!wasSettingsOpen && !wasColorOpen) return false;
	node.properties.gjj_image_to_svg_settings_open = false;
	node.properties[PREVIEW_BG_OPEN_PROP] = false;
	renderPanel(node);
	GJJ_Utils.refreshNode?.(node);
	return true;
}

function installOutsideClose(node) {
	if (node.__gjjSvgOutsideCloseInstalled) return;
	node.__gjjSvgOutsideCloseInstalled = true;
	document.addEventListener("pointerdown", (event) => {
		if (!isTarget(node)) return;
		if (!settingsOpen(node) && !colorPanelOpen(node)) return;
		if (eventInside(node.__gjjSvgSettings, event) || eventInside(node.__gjjSvgColorPanel, event)) return;
		if (eventOnFloatingToggle(node, event)) return;
		closeFloatingPanels(node);
	}, true);
}

function renderPanel(node) {
	const panel = node.__gjjSvgPanel;
	if (!panel) return;
	const current = activeBranch(node);
	for (const button of panel.querySelectorAll("button[data-branch]")) {
		const on = button.dataset.branch === current;
		button.style.background = on ? "#245c42" : "#1d2b31";
		button.style.borderColor = on ? "#5fc585" : "#43545c";
		button.style.color = on ? "#ffffff" : "#edf6fa";
	}
	const saveButton = Array.from(panel.querySelectorAll("button")).find((button) => button.textContent === "💾");
	if (saveButton) {
		const hasPath = String(value(node, "save_directory", "") || "").trim();
		saveButton.style.background = hasPath ? "#6b4a18" : "#1d2b31";
		saveButton.style.borderColor = hasPath ? "#e2a849" : "#43545c";
	}
	const settingsButton = Array.from(panel.querySelectorAll("button")).find((button) => button.textContent === "⚙️");
	if (settingsButton) {
		settingsButton.style.background = settingsOpen(node) ? "#563548" : "#1d2b31";
		settingsButton.style.borderColor = settingsOpen(node) ? "#cf7c9e" : "#43545c";
	}
	const colorButton = panel.querySelector('button[data-action="preview-bg"]');
	if (colorButton) {
		const bg = previewBackground(node);
		colorButton.style.background = bg === "transparent" ? "#1d2b31" : bg;
		colorButton.style.borderColor = colorPanelOpen(node) ? "#8fd3ff" : bg === "transparent" ? "#43545c" : "#d8e7ea";
		colorButton.style.color = bg === "transparent" ? "#edf6fa" : "#111820";
	}
	if (node.__gjjSvgPreviewViewport) node.__gjjSvgPreviewViewport.style.background = previewBackground(node);
	renderColorPanel(node);
	renderSettings(node);
}

function createPreview(node) {
	const wrap = document.createElement("div");
	wrap.className = "gjj-svg-preview";
	wrap.style.cssText = "display:none;width:100%;box-sizing:border-box;flex-direction:column;gap:5px;";
	const viewport = document.createElement("div");
	viewport.className = "gjj-svg-preview-viewport";
	viewport.style.cssText = [
		"display:block",
		"width:100%",
		"min-height:120px",
		"max-height:360px",
		"overflow:auto",
		"border:1px solid #334852",
		"border-radius:7px",
		`background:${previewBackground(node)}`,
		"box-sizing:border-box",
		"padding:6px",
	].join(";");
	const meta = document.createElement("div");
	meta.style.cssText = "color:#8fa3aa;font:11px/1.35 system-ui,sans-serif;white-space:normal;overflow-wrap:anywhere;";
	wrap.append(viewport, meta);
	node.__gjjSvgPreviewWrap = wrap;
	node.__gjjSvgPreviewViewport = viewport;
	node.__gjjSvgPreviewMeta = meta;
	return wrap;
}

function clearPreview(node) {
	if (node.__gjjSvgPreviewWrap) node.__gjjSvgPreviewWrap.style.display = "none";
	if (node.__gjjSvgPreviewViewport) node.__gjjSvgPreviewViewport.replaceChildren();
	if (node.__gjjSvgPreviewMeta) node.__gjjSvgPreviewMeta.textContent = "";
	GJJ_Utils.refreshNode?.(node);
}

function svgElementFromText(svg) {
	const parsed = new DOMParser().parseFromString(String(svg || ""), "image/svg+xml");
	const parserError = parsed.querySelector("parsererror");
	const element = parsed.documentElement;
	if (parserError || !element || element.tagName.toLowerCase() !== "svg") return null;
	for (const item of element.querySelectorAll("script,foreignObject")) item.remove();
	for (const item of element.querySelectorAll("*")) {
		for (const attr of Array.from(item.attributes || [])) {
			const name = attr.name.toLowerCase();
			const value = String(attr.value || "").trim().toLowerCase();
			if (name.startsWith("on") || value.startsWith("javascript:")) item.removeAttribute(attr.name);
		}
	}
	element.style.maxWidth = "100%";
	element.style.height = "auto";
	element.style.display = "block";
	return document.importNode(element, true);
}

function updatePreview(node, data) {
	const svg = String(data?.svg || "");
	if (!svg) {
		clearPreview(node);
		return;
	}
	if (node.__gjjSvgPreviewWrap) node.__gjjSvgPreviewWrap.style.display = "flex";
	if (node.__gjjSvgPreviewViewport) {
		const element = svgElementFromText(svg);
		node.__gjjSvgPreviewViewport.replaceChildren(element || document.createTextNode("SVG 解析失败"));
	}
	if (node.__gjjSvgPreviewMeta) {
		const saved = Array.isArray(data?.saved) && data.saved.length ? `；已保存：${data.saved[data.saved.length - 1]}` : "";
		node.__gjjSvgPreviewMeta.textContent = `${data?.status || "SVG 已生成"}${saved}`;
	}
	if (node.__gjjSvgStatus) node.__gjjSvgStatus.textContent = data?.status || "SVG 已生成";
	GJJ_Utils.refreshNode?.(node);
}

function configureNode(node) {
	if (!isTarget(node)) return;
	hideNativeWidgets(node);
	const input = node.inputs?.find((item) => item?.name === "image");
	if (input) {
		input.type = "GJJ_BATCH_IMAGE,IMAGE";
		input.label = "输入图像";
		input.localized_name = "输入图像";
	}
	const mask = node.inputs?.find((item) => item?.name === "mask");
	if (mask) {
		mask.type = "MASK";
		mask.label = "透明遮罩";
		mask.localized_name = "透明遮罩";
	}
	if (!node.__gjjSvgPanelWidget && typeof node.addDOMWidget === "function") {
		const panel = createPanel(node);
		node.__gjjSvgPanel = panel;
		node.__gjjSvgPanelWidget = node.addDOMWidget(PANEL_WIDGET, "HTML", panel, { serialize: false });
	}
	if (!node.__gjjSvgPreviewWidget && typeof node.addDOMWidget === "function") {
		node.__gjjSvgPreviewWidget = node.addDOMWidget(PREVIEW_WIDGET, "HTML", createPreview(node), { serialize: false });
	}
	renderPanel(node);
	if (!node.__gjjSvgPatched) {
		node.__gjjSvgPatched = true;
		const originalConfigure = node.onConfigure;
		node.onConfigure = function (...args) {
			const result = originalConfigure?.apply(this, args);
			setTimeout(() => configureNode(this), 0);
			return result;
		};
	}
	GJJ_Utils.refreshNode?.(node);
}

app.registerExtension({
	name: "Comfy.GJJ.ImageToSVGZero",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME || nodeType.prototype.__gjjSvgZeroPatched) return;
		nodeType.prototype.__gjjSvgZeroPatched = true;
		nodeData.output_preview = false;
		if (Array.isArray(nodeData.outputs)) {
			for (const output of nodeData.outputs) output.preview = false;
		}
		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			setTimeout(() => configureNode(this), 0);
			setTimeout(() => configureNode(this), 160);
			return result;
		};
		const originalExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalExecuted?.apply(this, [message]);
			const data = Array.isArray(message?.[UI_KEY]) ? message[UI_KEY][0] : null;
			if (data) updatePreview(this, data);
			return result;
		};
	},
	nodeCreated(node) {
		configureNode(node);
	},
	setup() {
		for (const node of app.graph?._nodes || []) configureNode(node);
	},
});
