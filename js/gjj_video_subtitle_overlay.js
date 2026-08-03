import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_NAME = "GJJ_VideoSubtitleOverlay";
const OUTPUTS_PROPERTY = "gjj_subtitle_outputs_visible";
const PARAMETER_ORDER_VERSION = "gjj_subtitle_parameter_order_version";
const SETTINGS_PROPERTY = "gjj_subtitle_named_settings";
const SERIALIZED_PARAMETER_ORDER = [
	"filename_prefix", "font_name", "font_size", "font_color", "outline_color", "outline_width", "bottom_margin",
	"save_directory", "output_format", "video_codec", "encoding_preset", "crf", "save_srt",
	"font_size_percent", "bottom_margin_percent", "outline_width_percent",
];
const PARAMETER_DEFAULTS = {
	filename_prefix: "GJJ/字幕视频", font_name: "Microsoft YaHei", font_size: 48,
	font_color: "#FFFFFF", outline_color: "#000000", outline_width: 3, bottom_margin: 60,
	save_directory: "", output_format: "mp4", video_codec: "H.264", encoding_preset: "medium",
	crf: 18, save_srt: true, font_size_percent: 5, bottom_margin_percent: 8, outline_width_percent: 6,
};
const OUTPUT_DEFS = [
	{ name: "字幕视频", type: "VIDEO" },
	{ name: "同名SRT", type: "STRING" },
	{ name: "保存路径", type: "STRING" },
];
const PARAMETER_NAMES = [
	"filename_prefix", "font_name", "font_size", "font_color", "outline_color",
	"outline_width", "bottom_margin", "save_directory", "output_format", "video_codec",
	"encoding_preset", "crf", "save_srt", "font_size_percent", "bottom_margin_percent",
	"outline_width_percent",
];
const PANEL_CLASS = "gjj-subtitle-floating-panel";

function injectStyle() {
	if (document.getElementById("gjj-video-subtitle-overlay-style")) return;
	const style = document.createElement("style");
	style.id = "gjj-video-subtitle-overlay-style";
	style.textContent = `
.gjj-vso-toolbar{display:flex;align-items:center;gap:6px;width:100%;padding:3px 2px;box-sizing:border-box}
.gjj-vso-toolbar button{flex:1 1 0;height:30px;min-width:34px;border:1px solid #40555d;border-radius:7px;background:#142128;color:#e8f0ef;font:700 16px/28px system-ui;cursor:pointer}
.gjj-vso-toolbar button:hover,.gjj-vso-toolbar button.active{border-color:#54c991;background:#1b3b32;color:#fff}
.${PANEL_CLASS}{position:fixed;z-index:100003;width:min(420px,calc(100vw - 24px));max-height:min(620px,calc(100vh - 24px));overflow:auto;padding:12px;box-sizing:border-box;border:1px solid #49616a;border-radius:10px;background:#10191e;color:#dce8e8;box-shadow:0 16px 48px rgba(0,0,0,.55);font:13px/1.4 system-ui,"Microsoft YaHei",sans-serif}
.gjj-vso-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;font-weight:800;color:#effff9}
.gjj-vso-close,.gjj-vso-action{border:1px solid #425a63;border-radius:6px;background:#19272e;color:#dce8e8;cursor:pointer}
.gjj-vso-close{width:28px;height:26px}.gjj-vso-action{min-height:30px;padding:0 10px}.gjj-vso-action:hover{border-color:#54c991;color:#fff}
.gjj-vso-field{display:grid;grid-template-columns:112px minmax(0,1fr);align-items:center;gap:8px;margin:8px 0}
.gjj-vso-field.wide{grid-template-columns:1fr}.gjj-vso-field label{color:#aebfc4}
.gjj-vso-field input,.gjj-vso-field select{width:100%;height:32px;box-sizing:border-box;border:1px solid #3c535c;border-radius:6px;background:#081116;color:#edf5f4;padding:4px 7px}
.gjj-vso-field input[type="color"]{height:52px;padding:3px;cursor:pointer}
.gjj-vso-range{display:grid;grid-template-columns:minmax(0,1fr) 58px;align-items:center;gap:8px}.gjj-vso-range output{text-align:right;color:#9de3bd}
.gjj-vso-swatches{display:grid;grid-template-columns:repeat(10,1fr);gap:5px;margin:8px 0}.gjj-vso-swatch{aspect-ratio:1;border:1px solid rgba(255,255,255,.35);border-radius:5px;cursor:pointer}
.gjj-vso-search{width:100%;height:34px;box-sizing:border-box;margin-bottom:8px;border:1px solid #3c535c;border-radius:6px;background:#081116;color:#edf5f4;padding:5px 8px}
.gjj-vso-font-list{display:flex;flex-direction:column;gap:4px;max-height:360px;overflow:auto}.gjj-vso-font{display:flex;justify-content:space-between;gap:8px;padding:7px 8px;border:1px solid #2c4149;border-radius:6px;background:#0b1419;color:#e5eeee;cursor:pointer;text-align:left}.gjj-vso-font:hover,.gjj-vso-font.active{border-color:#54c991;background:#173128}.gjj-vso-font small{color:#849ba3}
.gjj-vso-stage{position:relative;aspect-ratio:16/9;margin:8px 0 12px;overflow:hidden;border:1px solid #48606a;border-radius:8px;background:linear-gradient(150deg,#253a48,#0b1218 65%);cursor:ns-resize;user-select:none}
.gjj-vso-stage:before{content:"视频画面";position:absolute;left:10px;top:8px;color:#7f959d;font-size:11px}
.gjj-vso-sample{position:absolute;left:4%;right:4%;text-align:center;font-weight:800;line-height:1.15;color:#fff;transform:translateY(50%);pointer-events:none}
.gjj-vso-note{color:#8fa4ac;font-size:12px;margin:6px 0}.gjj-vso-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:10px}
`;
	document.head.appendChild(style);
}

function widget(node, name) {
	return node?.widgets?.find((item) => item?.name === name);
}

function value(node, name, fallback = "") {
	const found = widget(node, name);
	return found ? found.value : fallback;
}

function setValue(node, name, next) {
	const found = widget(node, name);
	if (!found) return;
	found.value = next;
	if (found.inputEl) found.inputEl.value = next;
	if (found.element && "value" in found.element) found.element.value = next;
	found.callback?.(next);
	node.properties ||= {};
	node.properties[SETTINGS_PROPERTY] = {
		...PARAMETER_DEFAULTS,
		...(node.properties[SETTINGS_PROPERTY] || {}),
		[name]: next,
	};
	node.graph?.change?.();
}

function migrateSerializedWidgetOrder(data) {
	if (!data || !Array.isArray(data.widgets_values)) return;
	data.properties ||= {};
	const savedSettings = data.properties[SETTINGS_PROPERTY];
	if (savedSettings && typeof savedSettings === "object") {
		data.widgets_values = SERIALIZED_PARAMETER_ORDER.map((name) => savedSettings[name] ?? PARAMETER_DEFAULTS[name]);
		data.properties[PARAMETER_ORDER_VERSION] = 3;
		return;
	}
	const values = [...data.widgets_values];
	const isFormat = (value) => ["mp4", "mkv", "webm"].includes(String(value || "").toLowerCase());
	const isCodec = (value) => ["H.264", "H.265", "VP9"].includes(String(value || ""));
	let migrated = values;

	// Repair nodes already serialized after the old frontend rebuilt
	// widgets_values from an incomplete widget list.
	if (/^#[0-9a-f]{6}$/i.test(String(values[0] || "")) && isFormat(values[7]) && isCodec(values[8])) {
		migrated = [
			"GJJ/字幕视频", "Microsoft YaHei", 48, "#FFFFFF",
			values[0], values[1], values[2],
			values[6], values[7], values[8], values[9], values[10], values[11],
			values[3], values[4], values[5],
		];
	// Repair the intermediate schema where the three percentage controls
	// were inserted before the original save options.
	} else if (values.length >= 16 && isFormat(values[11]) && isCodec(values[12])) {
		migrated = [...values.slice(0, 7), ...values.slice(10, 16), ...values.slice(7, 10)];
	}
	// Some affected workflows lose one leading widget on every reload. Locate
	// the stable output-format / codec / preset triplet and realign the whole
	// array instead of trusting the old version marker.
	let formatIndex = -1;
	for (let index = 0; index + 2 < migrated.length; index += 1) {
		if (isFormat(migrated[index]) && isCodec(migrated[index + 1]) && ["ultrafast", "fast", "medium", "slow", "veryslow"].includes(String(migrated[index + 2] || ""))) {
			formatIndex = index;
			break;
		}
	}
	if (formatIndex >= 0 && formatIndex !== 8) {
		const missingLeading = Math.max(0, 8 - formatIndex);
		migrated = [
			...SERIALIZED_PARAMETER_ORDER.slice(0, missingLeading).map((name) => PARAMETER_DEFAULTS[name]),
			...migrated,
		];
	}
	const normalized = SERIALIZED_PARAMETER_ORDER.map((name, index) => migrated[index] ?? PARAMETER_DEFAULTS[name]);
	data.widgets_values = normalized;
	data.properties[SETTINGS_PROPERTY] = Object.fromEntries(
		SERIALIZED_PARAMETER_ORDER.map((name, index) => [name, normalized[index]])
	);
	data.properties[PARAMETER_ORDER_VERSION] = 3;
}

function restoreNamedSettings(node, serialized = null) {
	const saved = serialized?.properties?.[SETTINGS_PROPERTY] || node.properties?.[SETTINGS_PROPERTY];
	const settings = { ...PARAMETER_DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
	node.properties ||= {};
	node.properties[SETTINGS_PROPERTY] = settings;
	for (const name of SERIALIZED_PARAMETER_ORDER) {
		const found = widget(node, name);
		if (!found) continue;
		found.value = settings[name];
		if (found.inputEl) found.inputEl.value = settings[name];
		if (found.element && "value" in found.element) found.element.value = settings[name];
	}
}

function fontDisplayName(fontValue) {
	const text = String(fontValue || "Microsoft YaHei").trim() || "Microsoft YaHei";
	return text.replaceAll("\\", "/").split("/").pop() || text;
}

function updateFontButton(node) {
	if (!node.__gjjSubtitleFontButton) return;
	const name = fontDisplayName(value(node, "font_name", "Microsoft YaHei"));
	node.__gjjSubtitleFontButton.textContent = `Ｆ ${name}`;
	node.__gjjSubtitleFontButton.title = `当前字体：${name}；点击搜索并选择 models/fonts 或系统字体`;
}

function hideWidget(found) {
	if (!found || found.__gjjSubtitleHidden) return;
	found.__gjjSubtitleHidden = true;
	found.computeSize = () => [0, -4];
	found.type = `gjj_hidden_${found.type || "widget"}`;
	found.hidden = true;
	if (found.inputEl) found.inputEl.style.display = "none";
	if (found.element) found.element.style.display = "none";
}

function hideParameters(node) {
	for (const name of PARAMETER_NAMES) hideWidget(widget(node, name));
}

function button(text, title, callback) {
	const result = document.createElement("button");
	result.type = "button";
	result.textContent = text;
	result.title = title;
	for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
		result.addEventListener(eventName, (event) => event.stopPropagation());
	}
	result.addEventListener("click", callback);
	return result;
}

function closePanels() {
	document.querySelectorAll(`.${PANEL_CLASS}`).forEach((panel) => panel.remove());
}

function panel(anchor, title) {
	closePanels();
	const root = document.createElement("div");
	root.className = PANEL_CLASS;
	const head = document.createElement("div");
	head.className = "gjj-vso-head";
	const label = document.createElement("span");
	label.textContent = title;
	const close = button("×", "关闭", () => root.remove());
	close.className = "gjj-vso-close";
	head.append(label, close);
	root.append(head);
	document.body.appendChild(root);
	const rect = anchor.getBoundingClientRect();
	const width = Math.min(420, window.innerWidth - 24);
	const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left));
	root.style.left = `${left}px`;
	root.style.top = `${Math.max(12, Math.min(window.innerHeight - 180, rect.bottom + 7))}px`;
	return root;
}

function field(labelText, control, wide = false) {
	const row = document.createElement("div");
	row.className = `gjj-vso-field${wide ? " wide" : ""}`;
	const label = document.createElement("label");
	label.textContent = labelText;
	row.append(label, control);
	return row;
}

function rangeControl(min, max, step, current, suffix, onInput) {
	const wrap = document.createElement("div");
	wrap.className = "gjj-vso-range";
	const input = document.createElement("input");
	input.type = "range";
	input.min = String(min);
	input.max = String(max);
	input.step = String(step);
	input.value = String(current);
	const output = document.createElement("output");
	const update = () => {
		output.textContent = `${Number(input.value).toFixed(step < 1 ? 1 : 0)}${suffix}`;
		onInput(Number(input.value));
	};
	input.addEventListener("input", update);
	output.textContent = `${Number(current).toFixed(step < 1 ? 1 : 0)}${suffix}`;
	wrap.append(input, output);
	return { wrap, input, output };
}

async function openFonts(node, anchor) {
	const root = panel(anchor, "Ｆ 字体选择");
	const search = document.createElement("input");
	search.className = "gjj-vso-search";
	search.placeholder = "搜索 models/fonts 与系统字体…";
	const list = document.createElement("div");
	list.className = "gjj-vso-font-list";
	root.append(search, list);
	let pageNumber = 0;
	let hasMore = true;
	let loading = false;
	let requestToken = 0;
	let searchTimer = null;
	const loadingRow = document.createElement("div");
	loadingRow.className = "gjj-vso-note";
	loadingRow.style.textAlign = "center";
	const appendRows = (fonts) => {
		const selected = String(value(node, "font_name", ""));
		for (const item of fonts) {
			const row = document.createElement("button");
			row.type = "button";
			row.className = `gjj-vso-font${selected === item.value || selected === item.path || selected === item.name ? " active" : ""}`;
			const name = document.createElement("span");
			name.textContent = item.name;
			const source = document.createElement("small");
			source.textContent = item.source;
			row.append(name, source);
			row.addEventListener("click", () => {
				setValue(node, "font_name", item.path || item.value || item.name);
				updateFontButton(node);
				root.remove();
			});
			list.append(row);
		}
	};
	const loadNext = async (reset = false) => {
		if (reset) {
			requestToken += 1;
			pageNumber = 0;
			hasMore = true;
			loading = false;
			list.replaceChildren();
		}
		if (loading || !hasMore) return;
		const token = requestToken;
		loading = true;
		loadingRow.textContent = pageNumber ? "正在加载更多字体…" : "正在读取字体…";
		list.append(loadingRow);
		try {
			const nextPage = pageNumber + 1;
			const query = encodeURIComponent(search.value.trim());
			const response = await api.fetchApi(`/gjj/video_subtitle_overlay/fonts?page=${nextPage}&page_size=20&search=${query}`);
			const data = await response.json();
			if (token !== requestToken || !root.isConnected) return;
			loadingRow.remove();
			const fonts = Array.isArray(data?.fonts) ? data.fonts : [];
			appendRows(fonts);
			pageNumber = nextPage;
			hasMore = Boolean(data?.has_more);
			if (!list.children.length) {
				loadingRow.textContent = "没有匹配字体";
				list.append(loadingRow);
			} else if (hasMore) {
				loadingRow.textContent = "向下滚动继续加载";
				list.append(loadingRow);
			}
		} catch (error) {
			if (token === requestToken && root.isConnected) {
				loadingRow.textContent = `字体读取失败：${error.message || error}`;
				list.append(loadingRow);
			}
		} finally {
			if (token === requestToken) loading = false;
		}
	};
	list.addEventListener("scroll", () => {
		if (list.scrollTop + list.clientHeight >= list.scrollHeight - 80) loadNext();
	});
	search.addEventListener("input", () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => loadNext(true), 180);
	});
	await loadNext(true);
}

function openColors(node, anchor) {
	const root = panel(anchor, "🎨 字幕与描边色盘");
	const colors = ["#FFFFFF", "#000000", "#FFE45C", "#FF6B6B", "#FF4FA3", "#A56EFF", "#4D8DFF", "#3ED6D0", "#54D17A", "#FF9F43"];
	const addPicker = (labelText, name) => {
		const picker = document.createElement("input");
		picker.type = "color";
		picker.value = String(value(node, name, "#FFFFFF"));
		const hex = document.createElement("input");
		hex.value = picker.value.toUpperCase();
		const sync = (next) => {
			const normalized = /^#[0-9a-f]{6}$/i.test(next) ? next.toUpperCase() : picker.value.toUpperCase();
			picker.value = normalized;
			hex.value = normalized;
			setValue(node, name, normalized);
		};
		picker.addEventListener("input", () => sync(picker.value));
		hex.addEventListener("change", () => sync(hex.value));
		root.append(field(labelText, picker), field("十六进制", hex));
		const swatches = document.createElement("div");
		swatches.className = "gjj-vso-swatches";
		for (const color of colors) {
			const swatch = document.createElement("button");
			swatch.type = "button";
			swatch.className = "gjj-vso-swatch";
			swatch.style.background = color;
			swatch.title = color;
			swatch.addEventListener("click", () => sync(color));
			swatches.append(swatch);
		}
		root.append(swatches);
	};
	addPicker("字幕颜色", "font_color");
	addPicker("描边颜色", "outline_color");
}

function openPosition(node, anchor) {
	const root = panel(anchor, "📐 字幕位置与大小");
	const stage = document.createElement("div");
	stage.className = "gjj-vso-stage";
	const sample = document.createElement("div");
	sample.className = "gjj-vso-sample";
	sample.textContent = "字幕位置与大小预览";
	stage.append(sample);
	const size = rangeControl(0.5, 20, 0.1, Number(value(node, "font_size_percent", 5)), "%", (next) => {
		setValue(node, "font_size_percent", next);
		draw();
	});
	const margin = rangeControl(0, 50, 0.1, Number(value(node, "bottom_margin_percent", 8)), "%", (next) => {
		setValue(node, "bottom_margin_percent", next);
		draw();
	});
	const outline = rangeControl(0, 30, 0.25, Number(value(node, "outline_width_percent", 6)), "%", (next) => {
		setValue(node, "outline_width_percent", next);
		draw();
	});
	const draw = () => {
		const bottom = Number(margin.input.value);
		const fontSize = Number(size.input.value);
		const stroke = Math.max(0, fontSize * Number(outline.input.value) / 100);
		sample.style.bottom = `${bottom}%`;
		sample.style.fontSize = `${Math.max(10, fontSize * 3.2)}px`;
		sample.style.color = String(value(node, "font_color", "#FFFFFF"));
		sample.style.webkitTextStroke = `${stroke}px ${String(value(node, "outline_color", "#000000"))}`;
	};
	const drag = (event) => {
		const rect = stage.getBoundingClientRect();
		const next = Math.max(0, Math.min(50, ((rect.bottom - event.clientY) / rect.height) * 100));
		margin.input.value = String(next);
		margin.output.textContent = `${next.toFixed(1)}%`;
		setValue(node, "bottom_margin_percent", next);
		draw();
	};
	stage.addEventListener("pointerdown", (event) => {
		stage.setPointerCapture(event.pointerId);
		drag(event);
	});
	stage.addEventListener("pointermove", (event) => {
		if (stage.hasPointerCapture(event.pointerId)) drag(event);
	});
	const note = document.createElement("div");
	note.className = "gjj-vso-note";
	note.textContent = "在预览画面中上下拖动字幕，可直接设置距底部位置。数值按视频高度百分比保存。";
	root.append(stage, note, field("字幕大小", size.wrap), field("距底部", margin.wrap), field("描边宽度", outline.wrap));
	draw();
}

function openSave(node, anchor) {
	const root = panel(anchor, "💾 文件保存设置");
	const directory = document.createElement("input");
	directory.placeholder = "留空：ComfyUI/output";
	directory.value = String(value(node, "save_directory", ""));
	directory.addEventListener("change", () => setValue(node, "save_directory", directory.value.trim()));
	const directoryRow = document.createElement("div");
	directoryRow.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px";
	const browse = button("浏览…", "选择服务器本地目录", async () => {
		try {
			const response = await api.fetchApi("/gjj/zero_dependency_file_browser/pick_dir", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ directory: directory.value.trim() }),
			});
			const data = await response.json();
			if (data?.ok && data.directory) {
				directory.value = data.directory;
				setValue(node, "save_directory", data.directory);
			}
		} catch (error) {
			alert(`目录选择失败：${error.message || error}`);
		}
	});
	browse.className = "gjj-vso-action";
	directoryRow.append(directory, browse);
	const prefix = document.createElement("input");
	prefix.value = String(value(node, "filename_prefix", "GJJ/字幕视频"));
	prefix.addEventListener("change", () => setValue(node, "filename_prefix", prefix.value.trim() || "GJJ/字幕视频"));
	const select = (name, options) => {
		const control = document.createElement("select");
		for (const option of options) control.add(new Option(option, option));
		control.value = String(value(node, name, options[0]));
		control.addEventListener("change", () => setValue(node, name, control.value));
		return control;
	};
	const format = select("output_format", ["mp4", "mkv", "webm"]);
	const codec = select("video_codec", ["H.264", "H.265", "VP9"]);
	const preset = select("encoding_preset", ["ultrafast", "fast", "medium", "slow", "veryslow"]);
	const quality = document.createElement("input");
	quality.type = "number";
	quality.min = "0";
	quality.max = "51";
	quality.value = String(value(node, "crf", 18));
	quality.addEventListener("change", () => setValue(node, "crf", Math.max(0, Math.min(51, Number(quality.value)))));
	const saveSrt = document.createElement("input");
	saveSrt.type = "checkbox";
	saveSrt.checked = Boolean(value(node, "save_srt", true));
	saveSrt.addEventListener("change", () => setValue(node, "save_srt", saveSrt.checked));
	root.append(
		field("保存目录", directoryRow),
		field("文件名前缀", prefix),
		field("封装格式", format),
		field("视频编码", codec),
		field("编码预设", preset),
		field("画质 CRF", quality),
		field("保存同名 SRT", saveSrt),
	);
	format.addEventListener("change", () => {
		if (format.value === "webm") {
			codec.value = "VP9";
			setValue(node, "video_codec", "VP9");
		}
	});
}

function removeOutputs(node) {
	if ((node.outputs || []).some((output) => output?.links?.length)) return false;
	for (let index = (node.outputs || []).length - 1; index >= 0; index -= 1) node.removeOutput?.(index);
	return true;
}

function showOutputs(node) {
	while ((node.outputs || []).length < OUTPUT_DEFS.length) {
		const def = OUTPUT_DEFS[node.outputs.length];
		node.addOutput?.(def.name, def.type);
	}
	OUTPUT_DEFS.forEach((def, index) => {
		const output = node.outputs?.[index];
		if (!output) return;
		output.name = output.label = output.localized_name = def.name;
		output.type = def.type;
	});
}

function setOutputsVisible(node, visible) {
	node.properties ||= {};
	if (visible) {
		showOutputs(node);
		node.properties[OUTPUTS_PROPERTY] = true;
	} else if (removeOutputs(node)) {
		node.properties[OUTPUTS_PROPERTY] = false;
	} else {
		alert("输出口仍有连线，请先断开连线后再隐藏。");
		node.properties[OUTPUTS_PROPERTY] = true;
	}
	node.__gjjSubtitleOutputButton?.classList.toggle("active", Boolean(node.properties[OUTPUTS_PROPERTY]));
	node.setSize?.([Math.max(320, node.size?.[0] || 320), Math.max(100, node.computeSize?.()[1] || 100)]);
	node.graph?.setDirtyCanvas?.(true, true);
}

function addToolbar(node) {
	if (node.__gjjSubtitleToolbar) return;
	const row = document.createElement("div");
	row.className = "gjj-vso-toolbar";
	const font = button("Ｆ Microsoft YaHei", "选择 models/fonts 与系统字体", (event) => openFonts(node, event.currentTarget));
	font.style.flex = "2 1 0";
	font.style.fontSize = "12px";
	font.style.whiteSpace = "nowrap";
	font.style.overflow = "hidden";
	font.style.textOverflow = "ellipsis";
	const colors = button("🎨", "使用色盘选择字幕色与描边色", (event) => openColors(node, event.currentTarget));
	const position = button("📐", "可视化设置字幕位置、大小和描边", (event) => openPosition(node, event.currentTarget));
	const outputs = button("🔌", "显示或隐藏全部输出接口", () => setOutputsVisible(node, !Boolean(node.properties?.[OUTPUTS_PROPERTY])));
	const save = button("💾", "设置文件保存位置、格式与编码", (event) => openSave(node, event.currentTarget));
	row.append(font, colors, position, outputs, save);
	const toolbar = node.addDOMWidget?.("gjj_video_subtitle_toolbar", "HTML", row, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => 40,
	});
	node.__gjjSubtitleToolbar = toolbar || row;
	node.__gjjSubtitleFontButton = font;
	node.__gjjSubtitleOutputButton = outputs;
	updateFontButton(node);
	outputs.classList.toggle("active", Boolean(node.properties?.[OUTPUTS_PROPERTY]));
}

function normalize(node, serialized = null) {
	injectStyle();
	restoreNamedSettings(node, serialized);
	hideParameters(node);
	node.properties ||= {};
	if (serialized) {
		const hasSavedProperty = Object.prototype.hasOwnProperty.call(serialized.properties || {}, OUTPUTS_PROPERTY);
		node.properties[OUTPUTS_PROPERTY] = hasSavedProperty
			? Boolean(serialized.properties[OUTPUTS_PROPERTY])
			: Boolean(serialized.outputs?.some((output) => output?.links?.length));
	} else if (!Object.prototype.hasOwnProperty.call(node.properties, OUTPUTS_PROPERTY)) {
		node.properties[OUTPUTS_PROPERTY] = false;
	}
	if (node.properties[OUTPUTS_PROPERTY]) showOutputs(node);
	else removeOutputs(node);
	addToolbar(node);
	updateFontButton(node);
	node.__gjjSubtitleOutputButton?.classList.toggle("active", Boolean(node.properties[OUTPUTS_PROPERTY]));
	node.setSize?.([Math.max(320, node.size?.[0] || 320), Math.max(100, node.computeSize?.()[1] || 100)]);
	node.graph?.setDirtyCanvas?.(true, true);
}

app.registerExtension({
	name: "GJJ.VideoSubtitleOverlay.Panel",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) return;
		const originalCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalCreated?.apply(this, args);
			setTimeout(() => normalize(this), 0);
			return result;
		};
		const originalConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (data, ...args) {
			migrateSerializedWidgetOrder(data);
			const result = originalConfigure?.apply(this, [data, ...args]);
			setTimeout(() => normalize(this, data), 0);
			return result;
		};
		const originalSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function (...args) {
			this.properties ||= {};
			this.properties[OUTPUTS_PROPERTY] = Boolean(this.properties[OUTPUTS_PROPERTY]);
			const previous = this.properties[SETTINGS_PROPERTY] || {};
			this.properties[SETTINGS_PROPERTY] = Object.fromEntries(
				SERIALIZED_PARAMETER_ORDER.map((name) => [name, widget(this, name)?.value ?? previous[name] ?? PARAMETER_DEFAULTS[name]])
			);
			this.properties[PARAMETER_ORDER_VERSION] = 3;
			return originalSerialize?.apply(this, args);
		};
		const originalRemoved = nodeType.prototype.onRemoved;
		nodeType.prototype.onRemoved = function (...args) {
			closePanels();
			return originalRemoved?.apply(this, args);
		};
	},
});
