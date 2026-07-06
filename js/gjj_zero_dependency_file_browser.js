import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_NAME = "GJJ_ZeroDependencyFileBrowser";
const UI_KEY = "gjj_zero_dependency_file_browser";
const LIST_API = "/gjj/zero_dependency_file_browser/list";
const OPEN_DIR_API = "/gjj/zero_dependency_file_browser/open_dir";
const PICK_DIR_API = "/gjj/zero_dependency_file_browser/pick_dir";
const THUMB_API = "/gjj/zero_dependency_file_browser/thumbnail";
const USER_SETTINGS_ENDPOINT = "/gjj/user_settings";
const USER_SETTINGS_SECTION = "zero_dependency_file_browser";
const QUEUE_DELAY_MS = 300;
const RUN_FALLBACK_MS = 1500;
const AUTO_REFRESH_DELAY_MS = 220;
const MAX_RENDERED_TILES = 500;
const MAX_SCAN_RESULTS = 5000;
const MIN_NODE_WIDTH = 360;
const FILTER_MODE_OPTIONS = ["包含", "通配符", "正则"];
const SORT_MODE_OPTIONS = ["名称 A-Z", "名称 Z-A", "修改时间 新-旧", "修改时间 旧-新", "大小 大-小", "大小 小-大", "路径 A-Z", "路径 Z-A", "类型 A-Z", "类型 Z-A"];
const SORT_BUTTONS = {
	name: { icon: "🔤", title: "按文件名排序", modes: ["名称 A-Z", "名称 Z-A"] },
	time: { icon: "🕒", title: "按修改时间排序", modes: ["修改时间 新-旧", "修改时间 旧-新"] },
	size: { icon: "📏", title: "按文件尺寸排序", modes: ["大小 大-小", "大小 小-大"] },
	type: { icon: "🏷️", title: "按文件类型排序", modes: ["类型 A-Z", "类型 Z-A"] },
};
const OUTPUT_MODE_OPTIONS = ["绝对路径", "相对路径", "文件名"];
const FILE_OUTPUT_MODE_OPTIONS = ["按文件类型", "路径文本"];
const GJJ_FILE_DRAG_MIME = "application/x-gjj-file-browser-item";
const TYPE_FILTERS = {
	text: { icon: "📄", title: "只显示文本", extensions: "txt,csv,tsv,json,yaml,yml,md,html,htm,xml,ini,log,py,js,css" },
	image: { icon: "🖼️", title: "只显示图片", extensions: "png,jpg,jpeg,webp,bmp,gif,tif,tiff,exr,hdr" },
	audio: { icon: "🎵", title: "只显示音频", extensions: "wav,mp3,flac,ogg,m4a,aac,wma,aiff,aif" },
	video: { icon: "🎬", title: "只显示视频", extensions: "mp4,mov,mkv,webm,avi,m4v,wmv,flv" },
};

const CURRENT_WIDGET = "current_index";
const DIRECTORY_WIDGET = "directory";
const FILTER_WIDGET = "filter_text";
const FILTER_MODE_WIDGET = "filter_mode";
const EXTENSIONS_WIDGET = "extensions";
const SORT_WIDGET = "sort_mode";
const OUTPUT_MODE_WIDGET = "output_mode";
const FILE_OUTPUT_MODE_WIDGET = "file_output_mode";
const STATE_WIDGET = "browser_state";
const PANEL_WIDGET = "gjj_file_browser_panel";

const PARAM_WIDGETS = [
	CURRENT_WIDGET,
	DIRECTORY_WIDGET,
	FILTER_WIDGET,
	FILTER_MODE_WIDGET,
	EXTENSIONS_WIDGET,
	SORT_WIDGET,
	OUTPUT_MODE_WIDGET,
	FILE_OUTPUT_MODE_WIDGET,
	STATE_WIDGET,
];

const DEFAULT_STATE = {
	auto_execute: true,
	recursive: false,
	recursive_depth: 0,
	show_hidden: false,
	output_full_path: false,
	settings_open: false,
	status: "未读取目录",
	parent: "",
	root: "",
};
const DEFAULT_USER_SETTINGS = {
	auto_execute: true,
	recursive_depth: 0,
	show_hidden: false,
	settings_open: false,
	directory: "",
	filter_text: "",
	filter_mode: "包含",
	extensions: "",
	sort_mode: "名称 A-Z",
	output_mode: "绝对路径",
	file_output_mode: "按文件类型",
	favorites: [],
};

let activeRun = null;
let autoQueueTimer = null;
let lastPromptId = null;
let queuePatched = false;
let patchRetryCount = 0;
let userSettings = { ...DEFAULT_USER_SETTINGS };
let userSettingsLoaded = false;
let userSettingsPromise = null;
let saveUserSettingsTimer = null;

function dirty(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function findWidget(node, name) {
	return node?.widgets?.find((widget) => widget?.name === name);
}

function widgetValue(node, name, fallback = "") {
	const widget = findWidget(node, name);
	return widget ? widget.value : fallback;
}

function setWidgetValue(node, name, value) {
	const widget = findWidget(node, name);
	if (!widget) return;
	widget.value = value;
	widget.callback?.call(widget, value);
}

async function apiJson(path, options = {}) {
	const response = api?.fetchApi ? await api.fetchApi(path, options) : await fetch(path, options);
	const data = await response.json().catch(() => ({}));
	if (!response.ok || data?.ok === false) throw new Error(data?.error || response.statusText || "请求失败");
	return data;
}

function normalizeFavoritePath(value) {
	return String(value || "").trim();
}

function normalizeFavorites(value) {
	const result = [];
	const seen = new Set();
	for (const raw of Array.isArray(value) ? value : []) {
		const item = typeof raw === "string" ? { path: raw } : raw;
		const path = normalizeFavoritePath(item?.path);
		if (!path) continue;
		const key = path.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push({
			path,
			label: String(item?.label || path.split(/[\\/]/).filter(Boolean).pop() || path).trim(),
		});
	}
	return result.slice(0, 80);
}

function normalizeUserSettings(value) {
	const input = value && typeof value === "object" ? value : {};
	return {
		...DEFAULT_USER_SETTINGS,
		...input,
		auto_execute: boolValue(input.auto_execute, DEFAULT_USER_SETTINGS.auto_execute),
		recursive_depth: clampDepth(input.recursive_depth),
		show_hidden: boolValue(input.show_hidden, DEFAULT_USER_SETTINGS.show_hidden),
		settings_open: boolValue(input.settings_open, DEFAULT_USER_SETTINGS.settings_open),
		favorites: normalizeFavorites(input.favorites),
	};
}

async function loadUserSettings() {
	if (userSettingsLoaded) return userSettings;
	if (!userSettingsPromise) {
		userSettingsPromise = apiJson(USER_SETTINGS_ENDPOINT)
			.then((data) => {
				userSettings = normalizeUserSettings(data?.settings?.[USER_SETTINGS_SECTION]);
				userSettingsLoaded = true;
				return userSettings;
			})
			.catch((error) => {
				console.warn("[GJJ File Browser] 读取用户设置失败:", error);
				userSettingsLoaded = true;
				return userSettings;
			});
	}
	return userSettingsPromise;
}

function collectUserSettings(node) {
	const data = state(node);
	return normalizeUserSettings({
		...userSettings,
		auto_execute: data.auto_execute,
		recursive_depth: data.recursive_depth,
		show_hidden: data.show_hidden,
		settings_open: data.settings_open,
		directory: String(widgetValue(node, DIRECTORY_WIDGET, "") || ""),
		filter_text: String(widgetValue(node, FILTER_WIDGET, "") || ""),
		filter_mode: String(widgetValue(node, FILTER_MODE_WIDGET, FILTER_MODE_OPTIONS[0]) || FILTER_MODE_OPTIONS[0]),
		extensions: String(widgetValue(node, EXTENSIONS_WIDGET, "") || ""),
		sort_mode: String(widgetValue(node, SORT_WIDGET, SORT_MODE_OPTIONS[0]) || SORT_MODE_OPTIONS[0]),
		output_mode: String(widgetValue(node, OUTPUT_MODE_WIDGET, OUTPUT_MODE_OPTIONS[0]) || OUTPUT_MODE_OPTIONS[0]),
		file_output_mode: String(widgetValue(node, FILE_OUTPUT_MODE_WIDGET, FILE_OUTPUT_MODE_OPTIONS[0]) || FILE_OUTPUT_MODE_OPTIONS[0]),
	});
}

function saveUserSettingsSoon(node) {
	if (!userSettingsLoaded || !node || node.__gjjFileBrowserApplyingUserSettings) return;
	userSettings = collectUserSettings(node);
	clearTimeout(saveUserSettingsTimer);
	saveUserSettingsTimer = setTimeout(() => {
		const values = { ...userSettings, favorites: normalizeFavorites(userSettings.favorites) };
		apiJson(USER_SETTINGS_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ section: USER_SETTINGS_SECTION, values }),
		}).catch((error) => {
			console.warn("[GJJ File Browser] 保存用户设置失败:", error);
		});
	}, 350);
}

function applyUserSettingsToNode(node, settings = userSettings) {
	if (!node || node.__gjjFileBrowserUserSettingsApplied) return;
	node.__gjjFileBrowserUserSettingsApplied = true;
	const data = normalizeUserSettings(settings);
	node.__gjjFileBrowserApplyingUserSettings = true;
	try {
		userSettings = data;
		updateState(node, {
			auto_execute: data.auto_execute,
			recursive_depth: data.recursive_depth,
			show_hidden: data.show_hidden,
			settings_open: data.settings_open,
		});
		const widgetDefaults = {
			[DIRECTORY_WIDGET]: data.directory,
			[FILTER_WIDGET]: data.filter_text,
			[FILTER_MODE_WIDGET]: data.filter_mode,
			[EXTENSIONS_WIDGET]: data.extensions,
			[SORT_WIDGET]: data.sort_mode,
			[OUTPUT_MODE_WIDGET]: data.output_mode,
			[FILE_OUTPUT_MODE_WIDGET]: data.file_output_mode,
		};
		for (const [name, value] of Object.entries(widgetDefaults)) {
			if (value !== undefined && value !== null && String(value) !== "") {
				setWidgetValue(node, name, value);
			}
		}
	} finally {
		node.__gjjFileBrowserApplyingUserSettings = false;
	}
	renderPanel(node);
	scheduleAutoRefresh(node, false);
}

function boolValue(value, fallback = false) {
	if (value === undefined || value === null || value === "") return fallback;
	if (typeof value === "string") {
		return !["false", "0", "off", "no", "关", "关闭", "否"].includes(value.trim().toLowerCase());
	}
	return Boolean(value);
}

function state(node) {
	node.properties = node.properties || {};
	const props = node.properties;
	const widget = findWidget(node, STATE_WIDGET);
	if (widget?.value && !props.__gjj_file_browser_state_loaded) {
		try {
			const parsed = JSON.parse(String(widget.value || "{}"));
			if (parsed && typeof parsed === "object") {
				for (const [key, value] of Object.entries(parsed)) props[`gjj_file_browser_${key}`] = value;
			}
		} catch (error) {
			// Keep defaults for old or hand-edited JSON.
		}
		props.__gjj_file_browser_state_loaded = true;
	}
	const next = {
		auto_execute: boolValue(props.gjj_file_browser_auto_execute, DEFAULT_STATE.auto_execute),
		recursive_depth: clampDepth(props.gjj_file_browser_recursive_depth ?? (boolValue(props.gjj_file_browser_recursive, false) ? 3 : 0)),
		recursive: false,
		show_hidden: boolValue(props.gjj_file_browser_show_hidden, DEFAULT_STATE.show_hidden),
		output_full_path: boolValue(props.gjj_file_browser_output_full_path, DEFAULT_STATE.output_full_path),
		settings_open: boolValue(props.gjj_file_browser_settings_open, DEFAULT_STATE.settings_open),
		status: String(props.gjj_file_browser_status || DEFAULT_STATE.status),
		items: Array.isArray(node.__gjjFileBrowserItems) ? node.__gjjFileBrowserItems : [],
		dirs: Array.isArray(node.__gjjFileBrowserDirs) ? node.__gjjFileBrowserDirs : [],
		total_files: Number(node.__gjjFileBrowserTotalFiles || 0) || 0,
		parent: String(props.gjj_file_browser_parent || ""),
		root: String(props.gjj_file_browser_root || ""),
	};
	next.recursive = next.recursive_depth > 0;
	props.gjj_file_browser_auto_execute = next.auto_execute;
	props.gjj_file_browser_recursive = next.recursive;
	props.gjj_file_browser_recursive_depth = next.recursive_depth;
	props.gjj_file_browser_show_hidden = next.show_hidden;
	props.gjj_file_browser_output_full_path = next.output_full_path;
	props.gjj_file_browser_settings_open = next.settings_open;
	props.gjj_file_browser_status = next.status;
	delete props.gjj_file_browser_items;
	delete props.gjj_file_browser_dirs;
	delete props.gjj_file_browser_total_files;
	props.gjj_file_browser_parent = next.parent;
	props.gjj_file_browser_root = next.root;
	return next;
}

function clampDepth(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.min(3, Math.floor(number))) : 0;
}

function statePayload(node) {
	const data = state(node);
	return JSON.stringify({
		auto_execute: data.auto_execute,
		recursive: data.recursive,
		recursive_depth: data.recursive_depth,
		show_hidden: data.show_hidden,
		output_full_path: data.output_full_path,
		settings_open: data.settings_open,
	});
}

function updateState(node, patch = {}) {
	const current = state(node);
	const next = { ...current, ...patch };
	node.properties.gjj_file_browser_auto_execute = Boolean(next.auto_execute);
	const depth = clampDepth(next.recursive_depth ?? (next.recursive ? 3 : 0));
	node.properties.gjj_file_browser_recursive = depth > 0;
	node.properties.gjj_file_browser_recursive_depth = depth;
	node.properties.gjj_file_browser_show_hidden = Boolean(next.show_hidden);
	node.properties.gjj_file_browser_output_full_path = Boolean(next.output_full_path);
	node.properties.gjj_file_browser_settings_open = Boolean(next.settings_open);
	node.properties.gjj_file_browser_status = String(next.status || DEFAULT_STATE.status);
	delete node.properties.gjj_file_browser_items;
	delete node.properties.gjj_file_browser_dirs;
	delete node.properties.gjj_file_browser_total_files;
	if (Array.isArray(next.items)) node.__gjjFileBrowserItems = next.items;
	if (Array.isArray(next.dirs)) node.__gjjFileBrowserDirs = next.dirs;
	if (next.total_files !== undefined) node.__gjjFileBrowserTotalFiles = Number(next.total_files || 0) || 0;
	node.properties.gjj_file_browser_parent = String(next.parent || "");
	node.properties.gjj_file_browser_root = String(next.root || "");
	syncStateWidget(node);
	renderPanel(node);
	saveUserSettingsSoon(node);
	return state(node);
}

function ensureStateWidget(node) {
	let widget = findWidget(node, STATE_WIDGET);
	if (!widget) {
		widget = node.addWidget?.("text", STATE_WIDGET, statePayload(node), () => {}, { serialize: true });
		if (widget) widget.name = STATE_WIDGET;
	}
	if (widget) {
		widget.serialize = true;
		widget.serializeValue = () => statePayload(node);
		widget.value = statePayload(node);
	}
	return widget;
}

function syncStateWidget(node) {
	const widget = findWidget(node, STATE_WIDGET);
	if (!widget) return;
	widget.serialize = true;
	widget.serializeValue = () => statePayload(node);
	widget.value = statePayload(node);
}

function hideWidget(widget) {
	if (!widget) return;
	widget.hidden = true;
	widget.serialize = true;
	widget.computeSize = () => [0, -4];
	widget.getHeight = () => -4;
	widget.draw = () => {};
	widget.y = -10000;
	widget.last_y = -10000;
	if (widget.element) widget.element.style.display = "none";
	if (widget.inputEl) widget.inputEl.style.display = "none";
}

function hideNativeWidgets(node) {
	for (const name of PARAM_WIDGETS) hideWidget(findWidget(node, name));
}

function ensureOutputSocket(node) {
	if (!node) return;
	if (!Array.isArray(node.outputs) || !node.outputs.length) {
		node.addOutput?.("文件", "*");
	}
	const output = node.outputs[0];
	if (output) {
		output.name = output.name || "文件";
		output.label = output.label || "文件";
		output.type = "*";
	}
	const enabled = Boolean(state(node).output_full_path);
	if (enabled) {
		if (!node.outputs[1]) node.addOutput?.("文件完整路径", "STRING");
		const fullPathOutput = node.outputs[1];
		if (fullPathOutput) {
			fullPathOutput.name = "文件完整路径";
			fullPathOutput.label = "文件完整路径";
			fullPathOutput.type = "STRING";
		}
		return;
	}
	const fullPathOutput = node.outputs[1];
	const hasLinks = Array.isArray(fullPathOutput?.links) && fullPathOutput.links.length > 0;
	if (fullPathOutput && hasLinks) {
		node.properties.gjj_file_browser_output_full_path = true;
		fullPathOutput.name = "文件完整路径";
		fullPathOutput.label = "文件完整路径";
		fullPathOutput.type = "STRING";
		return;
	}
	if (fullPathOutput && !hasLinks) node.removeOutput?.(1);
}

function updateCurrentBounds(node, total) {
	const widget = findWidget(node, CURRENT_WIDGET);
	if (!widget) return;
	const max = Math.max(1, Number(total || 0) || 1);
	widget.options = widget.options || {};
	widget.options.max = max;
	if (widget.value > max) widget.value = max;
	if (widget.value < 1) widget.value = 1;
}

function currentIndex(node) {
	const value = Number(widgetValue(node, CURRENT_WIDGET, 1));
	return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function fileBrowserNodes() {
	return (app.graph?._nodes || []).filter((node) => node?.comfyClass === NODE_NAME);
}

function ensureStyles(root) {
	if (!root || root.__gjjFileBrowserStyleReady) return;
	root.__gjjFileBrowserStyleReady = true;
	const style = document.createElement("style");
	style.textContent = `
		.gjj-file-browser{box-sizing:border-box;width:100%;height:100%;display:flex;flex-direction:column;gap:6px;padding:0 2px;color:#e7edf0;font:12px/1.35 sans-serif;position:relative;overflow:visible}
		.gjj-file-browser *{box-sizing:border-box}
		.gjj-file-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:4px;min-height:28px;background:#263238;border:1px solid #3d4c52;border-radius:6px;padding:3px}
		.gjj-file-toolbar button,.gjj-file-settings button{width:26px;height:24px;border:1px solid #41545c;border-radius:5px;background:#17242a;color:#f1f7fa;font:15px/1 sans-serif;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
		.gjj-file-toolbar button[data-action]{background:#1b3038}
		.gjj-file-toolbar button[data-key].on{background:#236a39;border-color:#5fbf7a}
		.gjj-file-toolbar button[data-depth].on{background:#245c9c;border-color:#76b7ff}
		.gjj-file-toolbar button[data-sort].on{background:#6a4b1c;border-color:#e0a94f}
		.gjj-file-toolbar button[data-type-filter].on{background:#663a6d;border-color:#c884d5}
		.gjj-file-toolbar button[data-action="settings"].on{background:#6a3141;border-color:#e17a92}
		.gjj-file-toolbar button:disabled{opacity:.45;cursor:default}
		.gjj-file-content{min-height:128px;display:grid;grid-template-columns:96px minmax(0,1fr);gap:6px}
		.gjj-file-favorites{min-height:128px;max-height:360px;overflow:auto;background:#151f24;border:1px solid #334750;border-radius:7px;padding:5px;display:flex;flex-direction:column;gap:4px}
		.gjj-file-fav-head{display:flex;align-items:center;gap:4px;min-height:24px}
		.gjj-file-fav-title{flex:1;min-width:0;color:#b8cad1;font:700 11px/1.2 sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.gjj-file-fav-add{width:22px;height:22px;border:1px solid #49616c;border-radius:5px;background:#22333a;color:#ffd866;cursor:pointer;padding:0;font:14px/1 sans-serif}
		.gjj-file-fav-list{display:flex;flex-direction:column;gap:3px}
		.gjj-file-fav{min-height:23px;display:grid;grid-template-columns:minmax(0,1fr) 18px;gap:2px;align-items:center;border:1px solid transparent;border-radius:5px;background:#1d2a30;color:#e6f2f6;cursor:pointer;padding:2px 2px 2px 6px;text-align:left;font:11px/1.2 sans-serif}
		.gjj-file-fav:hover{background:#263b45;border-color:#4e6874}
		.gjj-file-fav.active{background:#315b39;border-color:#68b779}
		.gjj-file-fav span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.gjj-file-fav-remove{width:17px;height:17px;border:0;border-radius:4px;background:transparent;color:#afc1c9;cursor:pointer;padding:0;font:12px/1 sans-serif}
		.gjj-file-fav-remove:hover{background:rgba(255,255,255,.14);color:#fff}
		.gjj-file-main{min-width:0;display:flex;flex-direction:column;gap:6px}
		.gjj-file-address{display:flex;align-items:center;gap:5px;min-height:30px;background:#4b739e;border-radius:4px;padding:3px 6px;overflow:hidden}
		.gjj-file-address .folder{font-size:15px;cursor:pointer;border-radius:4px;padding:2px}
		.gjj-file-address .folder:hover{background:rgba(255,255,255,.16)}
		.gjj-file-crumbs{flex:1;min-width:0;display:flex;align-items:center;gap:4px;overflow:auto;white-space:nowrap;scrollbar-width:thin}
		.gjj-file-crumb{border:0;background:transparent;color:#f6fbff;font:700 14px/1.2 sans-serif;padding:3px 4px;border-radius:4px;cursor:pointer;max-width:190px;overflow:hidden;text-overflow:ellipsis}
		.gjj-file-crumb:hover{background:rgba(255,255,255,.16)}
		.gjj-file-address-edit{flex:1;min-width:0;background:rgba(10,18,22,.72);border:1px solid rgba(255,255,255,.24);border-radius:4px;color:#fff;padding:4px 7px;font:13px sans-serif}
		.gjj-file-sep{color:#d8e7f3;opacity:.85;font-size:13px}
		.gjj-file-settings{display:none;position:absolute;top:34px;right:2px;z-index:30;width:min(360px,calc(100% - 4px));grid-template-columns:1fr 1fr;gap:6px;background:#121d22;border:1px solid #4f6974;border-radius:7px;padding:8px;box-shadow:0 10px 24px rgba(0,0,0,.45)}
		.gjj-file-settings.open{display:grid}
		.gjj-file-field{display:flex;flex-direction:column;gap:3px;min-width:0;color:#afc1c9}
		.gjj-file-field label{font-size:11px;color:#95aab3}
		.gjj-file-field input,.gjj-file-field select{min-width:0;background:#0c1519;border:1px solid #39505a;border-radius:5px;color:#edf6fa;padding:5px 7px;font:12px sans-serif}
		.gjj-file-field.wide{grid-column:1 / -1}
		.gjj-file-status{min-height:26px;border:1px solid #334750;border-radius:6px;background:#0e171b;color:#bfd0d6;padding:5px 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.gjj-file-grid{height:128px;max-height:360px;overflow:auto;background:#202525;border:1px solid #343f43;border-radius:7px;padding:10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));align-content:start;gap:14px 10px}
		.gjj-file-tile{min-width:0;height:112px;border:1px solid transparent;border-radius:5px;background:transparent;color:#f5fff8;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:7px;padding:5px;cursor:pointer}
		.gjj-file-tile:hover{background:#28363a;border-color:#4d656d}
		.gjj-file-tile.active{background:#4d9b1d;border-color:#71bd45}
		.gjj-file-tile.dragging{opacity:.65;outline:2px solid #7fc7ff}
		.gjj-file-icon{width:54px;height:54px;display:flex;align-items:center;justify-content:center;font-size:36px;filter:drop-shadow(0 1px 1px rgba(0,0,0,.35));overflow:hidden;border-radius:4px}
		.gjj-file-thumb{width:54px;height:54px;display:block;object-fit:cover;border-radius:4px;background:#132126}
		.gjj-file-thumb-fallback{display:none}
		.gjj-file-name{width:100%;min-height:38px;max-height:42px;background:#529f1d;color:#fff;border-radius:2px;padding:3px 4px;text-align:center;font:12px/1.25 sans-serif;overflow:hidden;word-break:break-all;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
		.gjj-file-tile.dir .gjj-file-name{background:#4d739c}
		.gjj-file-tile.active .gjj-file-name{background:#6eb927}
		.gjj-file-empty{grid-column:1 / -1;color:#9fb0b7;padding:16px;text-align:center}
	`;
	root.appendChild(style);
}

function panelHeight(node) {
	const panel = node.__gjjFileBrowserPanel;
	if (!panel) return 300;
	return Math.max(300, Math.ceil(panel.scrollHeight || panel.offsetHeight || 300) + 4);
}

function refreshNodeSize(node) {
	const width = Math.max(MIN_NODE_WIDTH, Number(node.size?.[0] || MIN_NODE_WIDTH));
	const computed = node.computeSize?.() || node.size || [width, 360];
	const height = Math.max(360, Number(computed?.[1] || 360));
	node.setSize?.([width, height]);
	dirty(node);
}

function scheduleNodeSize(node) {
	if (!node || node.__gjjFileBrowserSizeQueued) return;
	node.__gjjFileBrowserSizeQueued = true;
	requestAnimationFrame(() => {
		node.__gjjFileBrowserSizeQueued = false;
		refreshNodeSize(node);
	});
}

function optionList(widget, fallback) {
	const values = widget?.options?.values || widget?.options || fallback;
	return Array.isArray(values) ? values : fallback;
}

function setupPanel(node) {
	if (node.__gjjFileBrowserPanel) return;
	const wrap = document.createElement("div");
	wrap.className = "gjj-file-browser";
	wrap.innerHTML = `
		<div class="gjj-file-toolbar">
			<button data-action="parent" title="返回上级目录">⬆️</button>
			<button data-action="refresh" title="刷新当前目录">🔄</button>
			<button data-action="prompt" title="输入或粘贴目录路径">📂</button>
			<button data-action="prev" title="选择上一个文件">◀️</button>
			<button data-action="next" title="选择下一个文件">▶️</button>
			<button data-key="auto_execute" title="自动队列输出过滤后的文件">🔁</button>
			<button data-depth="1" title="扫描 1 层子目录">1️⃣</button>
			<button data-depth="2" title="扫描 2 层子目录">2️⃣</button>
			<button data-depth="3" title="扫描 3 层子目录，最多到这里，避免卡死">3️⃣</button>
			<button data-sort="name" title="${SORT_BUTTONS.name.title}">${SORT_BUTTONS.name.icon}</button>
			<button data-sort="time" title="${SORT_BUTTONS.time.title}">${SORT_BUTTONS.time.icon}</button>
			<button data-sort="size" title="${SORT_BUTTONS.size.title}">${SORT_BUTTONS.size.icon}</button>
			<button data-sort="type" title="${SORT_BUTTONS.type.title}">${SORT_BUTTONS.type.icon}</button>
			<button data-type-filter="text" title="${TYPE_FILTERS.text.title}">${TYPE_FILTERS.text.icon}</button>
			<button data-type-filter="image" title="${TYPE_FILTERS.image.title}">${TYPE_FILTERS.image.icon}</button>
			<button data-type-filter="audio" title="${TYPE_FILTERS.audio.title}">${TYPE_FILTERS.audio.icon}</button>
			<button data-type-filter="video" title="${TYPE_FILTERS.video.title}">${TYPE_FILTERS.video.icon}</button>
			<button data-key="show_hidden" title="显示隐藏文件和隐藏目录">👁️</button>
			<button data-key="output_full_path" title="显示/隐藏“文件完整路径”输出接口">🔌</button>
			<button data-action="settings" title="参数设置">⚙️</button>
		</div>
		<div class="gjj-file-content">
			<div class="gjj-file-favorites">
				<div class="gjj-file-fav-head"><div class="gjj-file-fav-title">收藏夹</div><button class="gjj-file-fav-add" title="收藏当前目录">★</button></div>
				<div class="gjj-file-fav-list"></div>
			</div>
			<div class="gjj-file-main">
				<div class="gjj-file-address" title="双击输入目录地址"><span class="folder" title="选择目录">📁</span><div class="gjj-file-crumbs"></div></div>
				<div class="gjj-file-status">未读取目录</div>
				<div class="gjj-file-grid"></div>
			</div>
		</div>
		<div class="gjj-file-settings">
			<div class="gjj-file-field wide"><label>过滤文本</label><input data-role="filter_text" spellcheck="false"></div>
			<div class="gjj-file-field"><label>过滤方式</label><select data-role="filter_mode"></select></div>
			<div class="gjj-file-field"><label>扩展名</label><input data-role="extensions" spellcheck="false" placeholder="wav,png,jpg"></div>
			<div class="gjj-file-field"><label>排序</label><select data-role="sort_mode"></select></div>
			<div class="gjj-file-field"><label>路径格式</label><select data-role="output_mode"></select></div>
			<div class="gjj-file-field"><label>输出内容</label><select data-role="file_output_mode"></select></div>
		</div>
	`;
	ensureStyles(wrap);
	for (const eventName of ["mousedown", "pointerdown", "click", "dblclick", "wheel"]) {
		wrap.addEventListener(eventName, (event) => event.stopPropagation());
	}
	node.__gjjFileBrowserPanel = wrap;
	node.__gjjFileBrowserPanelWidget = node.addDOMWidget(PANEL_WIDGET, "HTML", wrap, { serialize: false, hideOnZoom: false });
	node.__gjjFileBrowserPanelWidget.computeSize = (width) => [Math.max(MIN_NODE_WIDTH, Number(width || node.size?.[0] || MIN_NODE_WIDTH)), panelHeight(node)];
	node.__gjjFileBrowserPanelWidget.getHeight = () => panelHeight(node);
	if (typeof ResizeObserver !== "undefined") {
		node.__gjjFileBrowserResizeObserver = new ResizeObserver(() => scheduleNodeSize(node));
		node.__gjjFileBrowserResizeObserver.observe(wrap);
	}
	installPanelHandlers(node);
	renderPanel(node);
	scheduleNodeSize(node);
	scheduleAutoRefresh(node, true);
}

function installPanelHandlers(node) {
	const wrap = node.__gjjFileBrowserPanel;
	if (!wrap) return;
	wrap.querySelector('[data-action="refresh"]')?.addEventListener("click", () => refreshList(node, true));
	wrap.querySelector('[data-action="parent"]')?.addEventListener("click", () => {
		const parent = state(node).parent;
		if (parent) {
			setWidgetValue(node, DIRECTORY_WIDGET, parent);
			refreshList(node, true);
		}
	});
	wrap.querySelector('[data-action="prompt"]')?.addEventListener("click", () => {
		promptDirectory(node);
	});
	wrap.querySelector(".gjj-file-fav-add")?.addEventListener("click", () => addCurrentFavorite(node));
	wrap.querySelector(".folder")?.addEventListener("click", () => pickDirectory(node));
	wrap.querySelector(".gjj-file-address")?.addEventListener("dblclick", () => startAddressEdit(node));
	wrap.querySelector('[data-action="prev"]')?.addEventListener("click", () => selectFileIndex(node, currentIndex(node) - 1));
	wrap.querySelector('[data-action="next"]')?.addEventListener("click", () => selectFileIndex(node, currentIndex(node) + 1));
	wrap.querySelector('[data-action="settings"]')?.addEventListener("click", () => {
		const data = state(node);
		updateState(node, { settings_open: !data.settings_open });
	});
	for (const button of wrap.querySelectorAll("button[data-key]")) {
		button.addEventListener("click", () => {
			const key = button.dataset.key;
			const data = state(node);
			updateState(node, { [key]: !data[key] });
			if (key === "output_full_path") {
				ensureOutputSocket(node);
				scheduleNodeSize(node);
				dirty(node);
			}
			if (key === "show_hidden") refreshList(node, false);
		});
	}
	for (const button of wrap.querySelectorAll("button[data-depth]")) {
		button.addEventListener("click", () => {
			const depth = clampDepth(button.dataset.depth);
			const current = state(node).recursive_depth;
			updateState(node, { recursive_depth: current === depth ? 0 : depth });
			refreshList(node, false);
		});
	}
	for (const button of wrap.querySelectorAll("button[data-sort]")) {
		button.addEventListener("click", () => {
			const config = SORT_BUTTONS[button.dataset.sort];
			if (!config) return;
			const current = String(widgetValue(node, SORT_WIDGET, SORT_MODE_OPTIONS[0]) || SORT_MODE_OPTIONS[0]);
			const next = current === config.modes[0] ? config.modes[1] : config.modes[0];
			setWidgetValue(node, SORT_WIDGET, next);
			syncPanelInputs(node);
			renderPanel(node);
			saveUserSettingsSoon(node);
			refreshList(node, true);
		});
	}
	for (const button of wrap.querySelectorAll("button[data-type-filter]")) {
		button.addEventListener("click", () => {
			const type = button.dataset.typeFilter;
			const current = activeTypeFilter(node);
			const nextExtensions = current === type ? "" : TYPE_FILTERS[type]?.extensions || "";
			setWidgetValue(node, EXTENSIONS_WIDGET, nextExtensions);
			syncPanelInputs(node);
			renderPanel(node);
			saveUserSettingsSoon(node);
			refreshList(node, true);
		});
	}
	for (const role of [FILTER_WIDGET, FILTER_MODE_WIDGET, EXTENSIONS_WIDGET, SORT_WIDGET, OUTPUT_MODE_WIDGET, FILE_OUTPUT_MODE_WIDGET]) {
		const input = wrap.querySelector(`[data-role="${role}"]`);
		input?.addEventListener("change", () => {
			setWidgetValue(node, role, input.value);
			renderPanel(node);
			saveUserSettingsSoon(node);
			refreshList(node, true);
		});
	}
}

function syncPanelInputs(node) {
	const wrap = node.__gjjFileBrowserPanel;
	if (!wrap) return;
	const filter = wrap.querySelector('[data-role="filter_text"]');
	if (filter && filter !== document.activeElement) filter.value = String(widgetValue(node, FILTER_WIDGET, "") || "");
	const extensions = wrap.querySelector('[data-role="extensions"]');
	if (extensions && extensions !== document.activeElement) extensions.value = String(widgetValue(node, EXTENSIONS_WIDGET, "") || "");
	syncSelect(node, FILTER_MODE_WIDGET, FILTER_MODE_OPTIONS);
	syncSelect(node, SORT_WIDGET, SORT_MODE_OPTIONS);
	syncSelect(node, OUTPUT_MODE_WIDGET, OUTPUT_MODE_OPTIONS);
	syncSelect(node, FILE_OUTPUT_MODE_WIDGET, FILE_OUTPUT_MODE_OPTIONS);
}

function syncSelect(node, name, fallback) {
	const wrap = node.__gjjFileBrowserPanel;
	const select = wrap?.querySelector(`[data-role="${name}"]`);
	if (!select) return;
	const choices = fallback;
	const raw = String(widgetValue(node, name, choices[0] || "") || "");
	const current = choices.includes(raw) ? raw : (choices[0] || "");
	if (!select.__gjjOptions || select.__gjjOptions !== choices.join("|")) {
		select.innerHTML = choices.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join("");
		select.__gjjOptions = choices.join("|");
	}
	if (select !== document.activeElement) select.value = current;
}

function extensionTokens(value) {
	return String(value || "")
		.split(/[,，;\s]+/g)
		.map((item) => item.trim().toLowerCase().replace(/^\./, ""))
		.filter(Boolean)
		.sort();
}

function sameExtensions(a, b) {
	const left = extensionTokens(a);
	const right = extensionTokens(b);
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

function activeTypeFilter(node) {
	const current = widgetValue(node, EXTENSIONS_WIDGET, "");
	for (const [key, config] of Object.entries(TYPE_FILTERS)) {
		if (sameExtensions(current, config.extensions)) return key;
	}
	return "";
}

function currentDirectory(node) {
	return String(widgetValue(node, DIRECTORY_WIDGET, "") || state(node).root || "").trim();
}

function favoriteLabel(path) {
	const parts = String(path || "").split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] || path;
}

function addCurrentFavorite(node) {
	const path = normalizeFavoritePath(currentDirectory(node));
	if (!path) {
		updateState(node, { status: "没有可收藏的当前目录" });
		return;
	}
	const key = path.toLowerCase();
	const favorites = normalizeFavorites(userSettings.favorites);
	if (!favorites.some((item) => item.path.toLowerCase() === key)) {
		favorites.unshift({ path, label: favoriteLabel(path) });
		userSettings = normalizeUserSettings({ ...userSettings, favorites });
		saveUserSettingsSoon(node);
		renderPanel(node);
		updateState(node, { status: `已收藏：${path}` });
		return;
	}
	updateState(node, { status: `已在收藏夹：${path}` });
}

function removeFavorite(node, path) {
	const target = normalizeFavoritePath(path).toLowerCase();
	userSettings = normalizeUserSettings({
		...userSettings,
		favorites: normalizeFavorites(userSettings.favorites).filter((item) => item.path.toLowerCase() !== target),
	});
	saveUserSettingsSoon(node);
	renderPanel(node);
}

function renderFavorites(node) {
	const wrap = node.__gjjFileBrowserPanel;
	const list = wrap?.querySelector(".gjj-file-fav-list");
	if (!list) return;
	const current = currentDirectory(node).toLowerCase();
	const favorites = normalizeFavorites(userSettings.favorites);
	if (!favorites.length) {
		list.innerHTML = `<div class="gjj-file-empty" style="padding:8px 4px;font-size:11px">暂无收藏</div>`;
		return;
	}
	list.innerHTML = favorites.map((item) => {
		const active = item.path.toLowerCase() === current;
		return `<div class="gjj-file-fav ${active ? "active" : ""}" data-path="${escapeHtml(item.path)}" title="${escapeHtml(item.path)}"><span>${escapeHtml(item.label || favoriteLabel(item.path))}</span><button class="gjj-file-fav-remove" data-remove="${escapeHtml(item.path)}" title="移除收藏">×</button></div>`;
	}).join("");
	for (const fav of list.querySelectorAll(".gjj-file-fav[data-path]")) {
		fav.addEventListener("click", () => {
			const target = fav.dataset.path || "";
			if (!target) return;
			setWidgetValue(node, DIRECTORY_WIDGET, target);
			saveUserSettingsSoon(node);
			refreshList(node, true);
		});
	}
	for (const remove of list.querySelectorAll(".gjj-file-fav-remove[data-remove]")) {
		remove.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			removeFavorite(node, remove.dataset.remove || "");
		});
	}
}

function promptDirectory(node) {
	const current = String(widgetValue(node, DIRECTORY_WIDGET, "") || "");
	const value = window.prompt("目录路径", current);
	if (value === null) return;
	applyDirectory(node, value.trim());
}

function applyDirectory(node, value) {
	const next = String(value || "").trim();
	if (!next) return;
	setWidgetValue(node, DIRECTORY_WIDGET, next);
	saveUserSettingsSoon(node);
	refreshList(node, true);
}

function startAddressEdit(node) {
	const wrap = node.__gjjFileBrowserPanel;
	const address = wrap?.querySelector(".gjj-file-address");
	const crumbs = wrap?.querySelector(".gjj-file-crumbs");
	if (!address || !crumbs || address.querySelector(".gjj-file-address-edit")) return;
	const current = String(widgetValue(node, DIRECTORY_WIDGET, "") || state(node).root || "");
	const input = document.createElement("input");
	input.className = "gjj-file-address-edit";
	input.value = current;
	input.spellcheck = false;
	crumbs.replaceChildren(input);
	let finished = false;
	const finish = (apply) => {
		if (finished) return;
		finished = true;
		const value = input.value;
		renderBreadcrumbs(node);
		if (apply) applyDirectory(node, value);
	};
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") finish(true);
		if (event.key === "Escape") finish(false);
	});
	input.addEventListener("blur", () => finish(false), { once: true });
	requestAnimationFrame(() => {
		input.focus();
		input.select();
	});
}

async function openCurrentDirectory(node) {
	const directory = String(widgetValue(node, DIRECTORY_WIDGET, "") || state(node).root || "").trim();
	if (!directory) {
		promptDirectory(node);
		return;
	}
	try {
		const response = await api.fetchApi(OPEN_DIR_API, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ directory }),
		});
		const payload = await response.json();
		if (!response.ok || !payload?.ok) throw new Error(payload?.error || response.statusText || "打开目录失败");
		updateState(node, { status: `已打开目录：${payload.directory || directory}` });
	} catch (error) {
		updateState(node, { status: `打开目录失败：${error?.message || error}` });
	}
}

async function pickDirectory(node) {
	const current = String(widgetValue(node, DIRECTORY_WIDGET, "") || state(node).root || "").trim();
	try {
		updateState(node, { status: "等待选择目录..." });
		const response = await api.fetchApi(PICK_DIR_API, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ directory: current }),
		});
		const payload = await response.json().catch(() => ({}));
		if (payload?.cancelled) {
			updateState(node, { status: "已取消选择目录" });
			return;
		}
		if (!response.ok || !payload?.ok || !payload?.directory) {
			throw new Error(payload?.error || response.statusText || "选择目录失败");
		}
		applyDirectory(node, payload.directory);
	} catch (error) {
		updateState(node, { status: `选择目录失败：${error?.message || error}` });
	}
}

function renderPanel(node) {
	const wrap = node.__gjjFileBrowserPanel;
	if (!wrap) return;
	const data = state(node);
	syncPanelInputs(node);
	renderBreadcrumbs(node);
	const settings = wrap.querySelector(".gjj-file-settings");
	settings?.classList.toggle("open", data.settings_open);
	const settingsButton = wrap.querySelector('[data-action="settings"]');
	settingsButton?.classList.toggle("on", data.settings_open);
	renderFavorites(node);
	for (const button of wrap.querySelectorAll("button[data-key]")) {
		const key = button.dataset.key;
		button.classList.toggle("on", Boolean(data[key]));
	}
	for (const button of wrap.querySelectorAll("button[data-depth]")) {
		button.classList.toggle("on", Number(button.dataset.depth || 0) === Number(data.recursive_depth || 0));
	}
	const sortMode = String(widgetValue(node, SORT_WIDGET, SORT_MODE_OPTIONS[0]) || SORT_MODE_OPTIONS[0]);
	for (const button of wrap.querySelectorAll("button[data-sort]")) {
		const config = SORT_BUTTONS[button.dataset.sort];
		const isActive = Boolean(config?.modes?.includes(sortMode));
		button.classList.toggle("on", isActive);
		if (config) {
			const direction = sortMode === config.modes[0] ? "当前：正向" : sortMode === config.modes[1] ? "当前：反向" : "点击排序";
			button.title = `${config.title}；${direction}；再次点击反向`;
		}
	}
	const typeFilter = activeTypeFilter(node);
	for (const button of wrap.querySelectorAll("button[data-type-filter]")) {
		button.classList.toggle("on", button.dataset.typeFilter === typeFilter);
	}
	const parentButton = wrap.querySelector('[data-action="parent"]');
	if (parentButton) parentButton.disabled = !data.parent;
	const status = wrap.querySelector(".gjj-file-status");
	if (status) status.textContent = data.status || DEFAULT_STATE.status;
	const grid = wrap.querySelector(".gjj-file-grid");
	if (!grid) return;
	const index = currentIndex(node);
	const dirs = data.recursive_depth > 0 ? [] : data.dirs;
	const files = data.items.slice(0, MAX_RENDERED_TILES);
	const dirHtml = dirs.map((item) => tileHtml("dir", item, "📁", item.name));
	const fileHtml = files.map((item, i) => tileHtml("file", item, fileIconHtml(item), item.name, i + 1 === index, i + 1));
	const moreHtml = data.items.length > MAX_RENDERED_TILES
		? [`<div class="gjj-file-empty">已显示前 ${MAX_RENDERED_TILES} 个文件；队列仍会按完整列表输出。</div>`]
		: [];
	grid.innerHTML = dirHtml.concat(fileHtml, moreHtml).join("") || `<div class="gjj-file-empty">没有可显示的文件</div>`;
	fitGridHeight(node, dirs.length + files.length + moreHtml.length);
	for (const image of grid.querySelectorAll(".gjj-file-thumb")) {
		image.addEventListener("error", () => {
			image.style.display = "none";
			const fallback = image.nextElementSibling;
			if (fallback) fallback.style.display = "flex";
		}, { once: true });
	}
	for (const tile of grid.querySelectorAll(".gjj-file-tile")) {
		tile.addEventListener("click", () => {
			const kind = tile.dataset.kind;
			if (kind === "dir") {
				setWidgetValue(node, DIRECTORY_WIDGET, tile.dataset.path || "");
				refreshList(node, true);
				return;
			}
			selectFileIndex(node, Number(tile.dataset.index || 1));
		});
		tile.addEventListener("dblclick", () => {
			if (tile.dataset.kind === "file") app.queuePrompt?.(0);
		});
		tile.addEventListener("dragstart", (event) => {
			if (tile.dataset.kind !== "file") return;
			event.stopPropagation();
			const payload = fileTilePayload(node, tile);
			event.dataTransfer?.setData(GJJ_FILE_DRAG_MIME, JSON.stringify(payload));
			event.dataTransfer?.setData("text/plain", payload.path);
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
			tile.classList.add("dragging");
		});
		tile.addEventListener("dragend", (event) => {
			tile.classList.remove("dragging");
			if (event.dataTransfer?.dropEffect && event.dataTransfer.dropEffect !== "none") return;
			if (isPointInBrowserPanel(node, event.clientX, event.clientY)) return;
			const importer = globalThis.__gjjAnyPreviewImportLocalFileAtPoint;
			if (typeof importer !== "function") return;
			const payload = fileTilePayload(node, tile);
			if (!payload.path) return;
			Promise.resolve(importer(payload, event.clientX, event.clientY)).catch((error) => {
				console.warn("[GJJ File Browser] 拖拽创建 AnyPreview 失败:", error);
			});
		});
		tile.addEventListener("pointerdown", (event) => {
			if (tile.dataset.kind !== "file" || event.button !== 0) return;
			installPointerDragFallback(node, tile, event);
		});
	}
}

function fitGridHeight(node, visibleCount) {
	const grid = node.__gjjFileBrowserPanel?.querySelector(".gjj-file-grid");
	if (!grid) return;
	if (!visibleCount) {
		grid.style.height = "128px";
		return;
	}
	const width = Math.max(1, Number(grid.clientWidth || node.size?.[0] || 640) - 20);
	const columns = Math.max(1, Math.floor(width / 104));
	const rows = Math.ceil(visibleCount / columns);
	const height = Math.max(128, Math.min(360, 20 + rows * 126));
	grid.style.height = `${height}px`;
}

function fileTilePayload(node, tile) {
	const item = state(node).items[Number(tile.dataset.index || 1) - 1];
	return {
		source: NODE_NAME,
		path: item?.path || tile.dataset.path || "",
		name: item?.name || tile.dataset.name || "",
	};
}

function isPointInBrowserPanel(node, clientX, clientY) {
	const element = document.elementFromPoint(Number(clientX || 0), Number(clientY || 0));
	return Boolean(element?.closest?.(".gjj-file-browser") === node.__gjjFileBrowserPanel);
}

function installPointerDragFallback(node, tile, startEvent) {
	const payload = fileTilePayload(node, tile);
	if (!payload.path) return;
	const startX = Number(startEvent.clientX || 0);
	const startY = Number(startEvent.clientY || 0);
	let moved = false;
	const cleanup = () => {
		tile.classList.remove("dragging");
		document.removeEventListener("pointermove", onMove, true);
		document.removeEventListener("pointerup", onUp, true);
		document.removeEventListener("pointercancel", onCancel, true);
	};
	const onMove = (event) => {
		const dx = Math.abs(Number(event.clientX || 0) - startX);
		const dy = Math.abs(Number(event.clientY || 0) - startY);
		if (dx + dy > 8) {
			moved = true;
			tile.classList.add("dragging");
		}
	};
	const onCancel = () => cleanup();
	const onUp = (event) => {
		const wasMoved = moved;
		cleanup();
		if (!wasMoved) return;
		if (isPointInBrowserPanel(node, event.clientX, event.clientY)) return;
		const importer = globalThis.__gjjAnyPreviewImportLocalFileAtPoint;
		if (typeof importer !== "function") return;
		event.preventDefault();
		event.stopPropagation();
		Promise.resolve(importer(payload, event.clientX, event.clientY)).catch((error) => {
			console.warn("[GJJ File Browser] 拖拽到 AnyPreview 失败:", error);
		});
	};
	document.addEventListener("pointermove", onMove, true);
	document.addEventListener("pointerup", onUp, true);
	document.addEventListener("pointercancel", onCancel, true);
}

function renderBreadcrumbs(node) {
	const wrap = node.__gjjFileBrowserPanel;
	const crumbs = wrap?.querySelector(".gjj-file-crumbs");
	if (!crumbs) return;
	const path = String(widgetValue(node, DIRECTORY_WIDGET, "") || state(node).root || "").trim();
	if (!path) {
		crumbs.innerHTML = `<button class="gjj-file-crumb" data-empty="1" title="点击 📂 设置目录">未设置目录</button>`;
		return;
	}
	crumbs.innerHTML = pathSegments(path)
		.map((part, index) => {
			const sep = index > 0 ? `<span class="gjj-file-sep">▶</span>` : "";
			return `${sep}<button class="gjj-file-crumb" data-path="${escapeHtml(part.path)}" title="${escapeHtml(part.path)}">${escapeHtml(part.label)}</button>`;
		})
		.join("");
	for (const crumb of crumbs.querySelectorAll(".gjj-file-crumb[data-path]")) {
		crumb.addEventListener("click", () => {
			const target = crumb.dataset.path || "";
			if (!target) return;
			setWidgetValue(node, DIRECTORY_WIDGET, target);
			refreshList(node, true);
		});
	}
}

function pathSegments(rawPath) {
	const original = String(rawPath || "").trim();
	const normalized = original.replace(/\//g, "\\").replace(/\\+$/g, "");
	const driveMatch = normalized.match(/^([A-Za-z]:)(?:\\|$)/);
	if (driveMatch) {
		const drive = driveMatch[1];
		const parts = [{ label: drive, path: `${drive}\\` }];
		const rest = normalized.slice(driveMatch[0].length).split("\\").filter(Boolean);
		let current = `${drive}\\`;
		for (const item of rest) {
			current = current.endsWith("\\") ? `${current}${item}` : `${current}\\${item}`;
			parts.push({ label: item, path: current });
		}
		return parts;
	}
	if (normalized.startsWith("\\\\")) {
		const rest = normalized.slice(2).split("\\").filter(Boolean);
		const parts = [];
		let current = "\\\\";
		for (const item of rest) {
			current = current === "\\\\" ? `\\\\${item}` : `${current}\\${item}`;
			parts.push({ label: item, path: current });
		}
		return parts.length ? parts : [{ label: "\\\\", path: "\\\\" }];
	}
	if (original.startsWith("/")) {
		const parts = [{ label: "/", path: "/" }];
		let current = "";
		for (const item of original.split("/").filter(Boolean)) {
			current += `/${item}`;
			parts.push({ label: item, path: current });
		}
		return parts;
	}
	const parts = [];
	let current = "";
	for (const item of original.replace(/\\/g, "/").split("/").filter(Boolean)) {
		current = current ? `${current}/${item}` : item;
		parts.push({ label: item, path: current });
	}
	return parts.length ? parts : [{ label: original, path: original }];
}

function tileHtml(kind, item, icon, label, active = false, index = 0) {
	const draggable = kind === "file" ? " draggable=\"true\"" : "";
	return `<div class="gjj-file-tile ${kind} ${active ? "active" : ""}" data-kind="${kind}" data-index="${index}" data-path="${escapeHtml(item.path || "")}" data-name="${escapeHtml(item.name || "")}" title="${escapeHtml(item.path || "")}"${draggable}>
		<div class="gjj-file-icon">${icon}</div>
		<div class="gjj-file-name">${escapeHtml(label || "")}</div>
	</div>`;
}

function isImageFile(name) {
	return /\.(png|jpe?g|webp|bmp|gif|tiff?|exr|hdr)$/i.test(String(name || ""));
}

function thumbnailUrl(item) {
	const params = new URLSearchParams();
	params.set("path", String(item?.path || ""));
	if (item?.mtime !== undefined) params.set("mtime", String(Math.round(Number(item.mtime || 0))));
	return `${THUMB_API}?${params.toString()}`;
}

function fileIconHtml(item) {
	if (isImageFile(item?.name)) {
		return `<img class="gjj-file-thumb" src="${escapeHtml(thumbnailUrl(item))}" loading="lazy"><span class="gjj-file-thumb-fallback">🖼️</span>`;
	}
	return fileIcon(item?.name);
}

function fileIcon(name) {
	const lower = String(name || "").toLowerCase();
	if (/\.(wav|mp3|flac|ogg|m4a|aac)$/i.test(lower)) return "🎵";
	if (/\.(png|jpg|jpeg|webp|bmp|gif|tif|tiff)$/i.test(lower)) return "🖼️";
	if (/\.(mp4|mov|mkv|webm|avi)$/i.test(lower)) return "🎬";
	if (/\.(txt|csv|tsv|json|yaml|yml|md)$/i.test(lower)) return "📄";
	return "📄";
}

function escapeHtml(value) {
	return String(value || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function selectFileIndex(node, index) {
	const total = Math.max(1, Number(state(node).total_files || 0) || 1);
	const next = Math.min(total, Math.max(1, Number(index || 1) || 1));
	setWidgetValue(node, CURRENT_WIDGET, next);
	updateCurrentBounds(node, total);
	const item = state(node).items[next - 1];
	updateState(node, { status: item ? `已选择 ${next} / ${total}：${item.relative_path || item.name}` : state(node).status });
	dirty(node);
}

function queryParams(node) {
	const data = state(node);
	const params = new URLSearchParams();
	params.set("directory", String(widgetValue(node, DIRECTORY_WIDGET, "") || ""));
	params.set("filter_text", String(widgetValue(node, FILTER_WIDGET, "") || ""));
	params.set("filter_mode", String(widgetValue(node, FILTER_MODE_WIDGET, "包含") || "包含"));
	params.set("extensions", String(widgetValue(node, EXTENSIONS_WIDGET, "") || ""));
	params.set("sort_mode", String(widgetValue(node, SORT_WIDGET, "名称 A-Z") || "名称 A-Z"));
	params.set("recursive", data.recursive_depth > 0 ? "1" : "0");
	params.set("recursive_depth", String(clampDepth(data.recursive_depth)));
	params.set("show_hidden", data.show_hidden ? "1" : "0");
	params.set("limit", String(MAX_SCAN_RESULTS));
	return params;
}

function refreshSignature(node) {
	return queryParams(node).toString();
}

function scheduleAutoRefresh(node, resetIndex = false) {
	clearTimeout(node.__gjjFileBrowserAutoRefreshTimer);
	node.__gjjFileBrowserAutoRefreshTimer = setTimeout(() => {
		const directory = String(widgetValue(node, DIRECTORY_WIDGET, "") || "").trim();
		if (!directory) return;
		const signature = refreshSignature(node);
		if (node.__gjjFileBrowserLastRefreshSignature === signature) return;
		refreshList(node, resetIndex);
	}, AUTO_REFRESH_DELAY_MS);
}

async function refreshList(node, resetIndex) {
	try {
		const signature = refreshSignature(node);
		updateState(node, { status: "正在读取目录..." });
		const response = await api.fetchApi(`${LIST_API}?${queryParams(node).toString()}`);
		const payload = await response.json();
		if (!response.ok || !payload?.ok) throw new Error(payload?.error || response.statusText || "读取失败");
		const items = Array.isArray(payload.items) ? payload.items : [];
		const dirs = Array.isArray(payload.dirs) ? payload.dirs : [];
		if (payload.root) setWidgetValue(node, DIRECTORY_WIDGET, payload.root);
		if (resetIndex) setWidgetValue(node, CURRENT_WIDGET, 1);
		updateCurrentBounds(node, items.length);
		const index = Math.min(currentIndex(node), Math.max(1, items.length));
		const current = items[index - 1];
		updateState(node, {
			items,
			dirs,
			total_files: items.length,
			parent: String(payload.parent || ""),
			root: String(payload.root || ""),
			status: items.length ? `${dirs.length} 个文件夹，${items.length} 个文件；当前 ${index} / ${items.length}：${current?.relative_path || current?.name || ""}` : `${dirs.length} 个文件夹，没有匹配的文件`,
		});
		node.__gjjFileBrowserLastRefreshSignature = signature;
	} catch (error) {
		updateState(node, { dirs: [], items: [], total_files: 0, parent: "", status: `读取失败：${error?.message || error}` });
	}
	renderPanel(node);
	scheduleNodeSize(node);
	dirty(node);
}

function compactNode(node) {
	ensureOutputSocket(node);
	ensureStateWidget(node);
	hideNativeWidgets(node);
	setupPanel(node);
	void loadUserSettings().then((settings) => {
		applyUserSettingsToNode(node, settings);
		renderPanel(node);
	});
	renderPanel(node);
	scheduleNodeSize(node);
	scheduleAutoRefresh(node, false);
}

function scheduleCompact(node, ms = 80) {
	clearTimeout(node.__gjjFileBrowserCompactTimer);
	node.__gjjFileBrowserCompactTimer = setTimeout(() => compactNode(node), ms);
}

function eventPromptId(event) {
	return event?.detail?.prompt_id || null;
}

function samePrompt(event) {
	const promptId = eventPromptId(event);
	return !(promptId && lastPromptId && promptId !== lastPromptId);
}

function queueNextIfNeeded(run, reason) {
	const node = run?.node;
	if (!node || run.finished) return;
	run.finished = true;
	clearTimeout(run.fallbackTimer);
	const total = Math.max(0, Number(run.totalFiles || 0) || 0);
	const effective = Math.max(1, Number(run.effectiveIndex || currentIndex(node)) || 1);
	if (total <= 0) {
		updateState(node, { status: `${reason}，没有可用文件` });
		return;
	}
	if (effective >= total) {
		setWidgetValue(node, CURRENT_WIDGET, total);
		updateState(node, { status: `${reason}，已到末尾：${total} / ${total}` });
		dirty(node);
		return;
	}
	const next = effective + 1;
	setWidgetValue(node, CURRENT_WIDGET, next);
	updateCurrentBounds(node, total);
	if (!state(node).auto_execute) {
		updateState(node, { status: `${reason}，下一项 ${next} / ${total}` });
		dirty(node);
		return;
	}
	updateState(node, { status: `${reason}，下一项 ${next} / ${total}，${QUEUE_DELAY_MS}ms 后继续` });
	clearTimeout(autoQueueTimer);
	autoQueueTimer = setTimeout(async () => {
		autoQueueTimer = null;
		try {
			await app.queuePrompt(0);
		} catch (error) {
			updateState(node, { status: `自动排队失败：${error?.message || error}` });
			dirty(node);
		}
	}, QUEUE_DELAY_MS);
}

function patchPromptQueue() {
	if (!queuePatched && typeof app.queuePrompt === "function") {
		const original = app.queuePrompt;
		app.queuePrompt = async function (...args) {
			for (const node of fileBrowserNodes()) compactNode(node);
			return original.apply(this, args);
		};
		queuePatched = true;
	}
	if (!queuePatched && patchRetryCount < 30) {
		patchRetryCount += 1;
		setTimeout(patchPromptQueue, 500);
	}
}

api.addEventListener("execution_start", (event) => {
	lastPromptId = eventPromptId(event);
	clearTimeout(activeRun?.fallbackTimer);
	activeRun = null;
	clearTimeout(autoQueueTimer);
	autoQueueTimer = null;
});

api.addEventListener("execution_success", (event) => {
	if (!samePrompt(event) || !activeRun) {
		activeRun = null;
		return;
	}
	queueNextIfNeeded(activeRun, "执行完成");
	activeRun = null;
});

for (const eventName of ["execution_error", "execution_interrupted"]) {
	api.addEventListener(eventName, () => {
		clearTimeout(autoQueueTimer);
		autoQueueTimer = null;
		clearTimeout(activeRun?.fallbackTimer);
		if (activeRun?.node) updateState(activeRun.node, { status: "执行停止，自动队列已停止" });
		activeRun = null;
	});
}

patchPromptQueue();

app.registerExtension({
	name: "Comfy.GJJ.ZeroDependencyFileBrowser",

	beforeQueuePrompt() {
		for (const node of fileBrowserNodes()) compactNode(node);
	},

	beforeQueued() {
		for (const node of fileBrowserNodes()) compactNode(node);
	},

	nodeCreated(node) {
		if (node.comfyClass !== NODE_NAME) return;
		compactNode(node);
		setTimeout(() => compactNode(node), 0);
		setTimeout(() => compactNode(node), 160);
	},

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData?.name !== NODE_NAME) return;
		if (Array.isArray(nodeData.output)) {
			nodeData.output[0] = "*";
			nodeData.output[1] = "STRING";
		}
		if (Array.isArray(nodeData.output_name)) {
			nodeData.output_name[0] = nodeData.output_name[0] || "文件";
			nodeData.output_name[1] = nodeData.output_name[1] || "文件完整路径";
		}
		if (Array.isArray(nodeData.outputs)) {
			if (typeof nodeData.outputs[0] === "string") nodeData.outputs[0] = "*";
			else if (nodeData.outputs[0]) nodeData.outputs[0].type = "*";
			if (typeof nodeData.outputs[1] === "string") nodeData.outputs[1] = "STRING";
			else if (nodeData.outputs[1]) {
				nodeData.outputs[1].name = nodeData.outputs[1].name || "文件完整路径";
				nodeData.outputs[1].type = "STRING";
			}
		}

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => compactNode(this), 0);
			setTimeout(() => compactNode(this), 160);
			return result;
		};

		const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (...args) {
			const result = originalOnConnectionsChange?.apply(this, args);
			scheduleCompact(this);
			return result;
		};

		const originalOnExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			const result = originalOnExecuted?.apply(this, [message]);
			const data = Array.isArray(message?.[UI_KEY]) ? message[UI_KEY][0] : null;
			if (data) {
				const items = Array.isArray(data.items) ? data.items : [];
				updateCurrentBounds(this, data.total_files || 0);
				updateState(this, {
					items,
					total_files: Number(data.total_files || 0) || 0,
					status: data.status || `当前 ${data.effective_index || currentIndex(this)} / ${data.total_files || 0}`,
				});
				activeRun = {
					node: this,
					effectiveIndex: Number(data.effective_index || currentIndex(this)) || 1,
					totalFiles: Number(data.total_files || 0) || 0,
					finished: false,
				};
				const run = activeRun;
				run.fallbackTimer = setTimeout(() => {
					if (activeRun !== run || run.finished) return;
					queueNextIfNeeded(run, "执行完成");
					if (activeRun === run) activeRun = null;
				}, RUN_FALLBACK_MS);
				dirty(this);
			}
			return result;
		};
	},

	setup() {
		for (const node of fileBrowserNodes()) compactNode(node);
	},
});
