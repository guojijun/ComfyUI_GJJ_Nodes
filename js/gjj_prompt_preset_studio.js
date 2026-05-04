import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const TARGET_NODES = new Set(["GJJ_PromptPresetStudio"]);
const STYLES_API_URL = "/gjj/prompt_preset_styles";
const SCHEMA_API_URL = "/gjj/prompt_preset_schema";

const TOOLBAR_WIDGET_NAME = "gjj_prompt_preset_toolbar";
const PANEL_WIDGET_NAME = "gjj_prompt_preset_panel";
const CONFIG_STORE_WIDGET = "配置存储";
const SECTION_PROPERTY_KEY = "gjj_prompt_preset_section";

const MIN_NODE_WIDTH = 364;
const MIN_NODE_HEIGHT = 220;
const MIN_TOOLBAR_HEIGHT = 46;
const MIN_PANEL_HEIGHT = 180;
const NODE_BOTTOM_PADDING = 12;

const OPTION_NONE = "无";
const OPTION_OFF = "关闭";
const OPTION_ON = "启用";
const OPTION_SINGLE = "单风格";
const OPTION_MULTI = "多风格";
const OPTION_SEPARATOR = "｜";

const BASE_WIDGETS = ["正向基础词", "反向基础词", "通用反向预设", "随机种子"];
const EXTERNAL_INPUT_NAMES = ["positive_input", "negative_input"];

const FALLBACK_SECTIONS = [
	{ key: "style", label: "风格", mode_key: "风格模式", mode_options: [OPTION_OFF, OPTION_SINGLE, OPTION_MULTI], fields: ["主风格", "附加风格列表"] },
	{ key: "idPhoto", label: "证件照", mode_key: "证件照模式", mode_options: [OPTION_OFF, OPTION_ON], fields: [] },
	{ key: "angle", label: "多角度", mode_key: "多角度模式", mode_options: [OPTION_OFF, OPTION_ON], fields: [] },
	{ key: "subject", label: "主体", mode_key: "主体模式", mode_options: [OPTION_OFF, OPTION_ON], fields: [] },
	{ key: "environment", label: "环境", mode_key: "环境模式", mode_options: [OPTION_OFF, OPTION_ON], fields: [] },
	{ key: "random", label: "随机灵感", mode_key: "随机灵感模式", mode_options: [OPTION_OFF, OPTION_ON], fields: [] },
];

const FALLBACK_DEFAULTS = {
	"风格模式": OPTION_OFF,
	"主风格": OPTION_NONE,
	"附加风格列表": "",
	"证件照模式": OPTION_OFF,
	"多角度模式": OPTION_OFF,
	"视角旋转": 0,
	"视角俯仰": 0,
	"镜头远近": 5.0,
	"视角描述": "详细",
	"主体模式": OPTION_OFF,
	"环境模式": OPTION_OFF,
	"随机灵感模式": OPTION_OFF,
};

let schemaCache = null;
let schemaPromise = null;
let schemaLoaded = false;
let styleCatalog = [];
let styleCatalogPromise = null;
let stylesLoaded = false;
const styleLookup = new Map();

function normalizeText(value) {
	return String(value ?? "").trim();
}

function normalizeKey(value) {
	return normalizeText(value)
		.toLowerCase()
		.replace(/[\s,，;；|/\\:_\-]+/g, "");
}

function splitTokens(text) {
	return String(text ?? "")
		.split(/[\n,，;；]+/g)
		.map((token) => normalizeText(token))
		.filter(Boolean);
}

function extractOptionValue(value) {
	const text = normalizeText(value);
	if (text.includes(OPTION_SEPARATOR)) {
		return normalizeText(text.split(OPTION_SEPARATOR).slice(-1)[0]);
	}
	return text;
}

function getOptionDisplayText(value) {
	const text = normalizeText(value);
	if (text.includes(OPTION_SEPARATOR)) {
		return normalizeText(text.split(OPTION_SEPARATOR, 1)[0]);
	}
	return text;
}

function uniqueStrings(values) {
	const result = [];
	const seen = new Set();
	for (const value of values) {
		const clean = normalizeText(value);
		if (!clean) {
			continue;
		}
		const key = normalizeKey(clean);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(clean);
	}
	return result;
}

function clampNumber(value, min, max, fallback = min) {
	const numeric = Number.parseFloat(String(value));
	if (!Number.isFinite(numeric)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, numeric));
}

function getAnglePreviewData(state) {
	const rotate = clampNumber(state?.["视角旋转"], 0, 360, 0);
	const vertical = clampNumber(state?.["视角俯仰"], -90, 90, 0);
	const zoom = clampNumber(state?.["镜头远近"], 0, 10, 5);
	const detailMode = normalizeText(state?.["视角描述"]) === "简洁" ? "简洁" : "详细";
	const addAnglePrompt = detailMode !== "简洁";
	const hAngle = ((rotate % 360) + 360) % 360;
	const hSuffix = addAnglePrompt ? "" : " quarter";

	let horizontalPrompt = "front view";
	let horizontalLabel = "正面";
	if (hAngle < 22.5 || hAngle >= 337.5) {
		horizontalPrompt = "front view";
		horizontalLabel = "正面";
	} else if (hAngle < 67.5) {
		horizontalPrompt = `front-right${hSuffix} view`;
		horizontalLabel = "右前45°";
	} else if (hAngle < 112.5) {
		horizontalPrompt = "right side view";
		horizontalLabel = "右侧";
	} else if (hAngle < 157.5) {
		horizontalPrompt = `back-right${hSuffix} view`;
		horizontalLabel = "右后45°";
	} else if (hAngle < 202.5) {
		horizontalPrompt = "back view";
		horizontalLabel = "背面";
	} else if (hAngle < 247.5) {
		horizontalPrompt = `back-left${hSuffix} view`;
		horizontalLabel = "左后45°";
	} else if (hAngle < 292.5) {
		horizontalPrompt = "left side view";
		horizontalLabel = "左侧";
	} else {
		horizontalPrompt = `front-left${hSuffix} view`;
		horizontalLabel = "左前45°";
	}

	let verticalPrompt = "eye level";
	let verticalLabel = "平视";
	if (addAnglePrompt) {
		if (vertical === -90) {
			verticalPrompt = "bottom-looking-up perspective, extreme worm's eye view, focus subject bottom";
			verticalLabel = "极限仰视";
		} else if (vertical < -75) {
			verticalPrompt = "bottom-looking-up perspective, extreme worm's eye view";
			verticalLabel = "强仰视";
		} else if (vertical < -45) {
			verticalPrompt = "ultra-low angle";
			verticalLabel = "超低角度";
		} else if (vertical < -15) {
			verticalPrompt = "low angle";
			verticalLabel = "低角度";
		} else if (vertical < 15) {
			verticalPrompt = "eye level";
			verticalLabel = "平视";
		} else if (vertical < 45) {
			verticalPrompt = "high angle";
			verticalLabel = "高角度";
		} else if (vertical < 75) {
			verticalPrompt = "bird's eye view";
			verticalLabel = "鸟瞰";
		} else if (vertical < 90) {
			verticalPrompt = "top-down perspective, looking straight down at the top of the subject";
			verticalLabel = "顶视";
		} else {
			verticalPrompt = "top-down perspective, looking straight down at the top of the subject, face not visible, focus on subject head";
			verticalLabel = "正顶视";
		}
	} else if (vertical < -15) {
		verticalPrompt = "low-angle shot";
		verticalLabel = "低机位";
	} else if (vertical < 15) {
		verticalPrompt = "eye-level shot";
		verticalLabel = "平视";
	} else if (vertical < 45) {
		verticalPrompt = "elevated shot";
		verticalLabel = "抬高机位";
	} else if (vertical < 75) {
		verticalPrompt = "high-angle shot";
		verticalLabel = "高机位";
	} else {
		verticalPrompt = "top-down shot";
		verticalLabel = "俯拍";
	}

	let distancePrompt = "medium shot";
	let distanceLabel = "中景";
	if (zoom < 2) {
		distancePrompt = "extreme wide shot";
		distanceLabel = "超远景";
	} else if (zoom < 4) {
		distancePrompt = "wide shot";
		distanceLabel = "远景";
	} else if (zoom < 6) {
		distancePrompt = "medium shot";
		distanceLabel = "中景";
	} else if (zoom < 8) {
		distancePrompt = "close-up";
		distanceLabel = "近景特写";
	} else {
		distancePrompt = "extreme close-up";
		distanceLabel = "超特写";
	}

	const prompt = addAnglePrompt
		? `${horizontalPrompt}, ${verticalPrompt}, ${distancePrompt} (horizontal: ${Math.round(rotate)}, vertical: ${Math.round(vertical)}, zoom: ${zoom.toFixed(1)})`
		: `${horizontalPrompt} ${verticalPrompt} ${distancePrompt}`;

	return {
		rotate,
		vertical,
		zoom,
		detailMode,
		horizontalLabel,
		verticalLabel,
		distanceLabel,
		prompt,
		cubeTransform: `rotateX(${(-vertical * 0.72).toFixed(1)}deg) rotateY(${(-hAngle).toFixed(1)}deg)`,
	};
}

function getWidget(node, names) {
	const pool = Array.isArray(names) ? names : [names];
	const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
	return widgets.find((widget) => {
		const candidates = [widget?.name, widget?.label, widget?.localized_name]
			.filter(Boolean)
			.map((value) => String(value));
		return pool.some((name) => candidates.includes(String(name)));
	});
}

function moveWidgetAfter(node, widgetName, afterName) {
	if (!node?.widgets?.length) {
		return;
	}
	const fromIndex = node.widgets.findIndex((widget) => widget?.name === widgetName);
	const afterIndex = node.widgets.findIndex((widget) => widget?.name === afterName);
	if (fromIndex < 0 || afterIndex < 0 || fromIndex === afterIndex) {
		return;
	}
	const [widget] = node.widgets.splice(fromIndex, 1);
	const targetIndex = fromIndex < afterIndex ? afterIndex : afterIndex + 1;
	node.widgets.splice(targetIndex, 0, widget);
}

function setWidgetValue(widget, value) {
	if (!widget) {
		return;
	}
	widget.value = value;
	if (widget.inputEl && "value" in widget.inputEl) {
		widget.inputEl.value = String(value);
	}
	if (widget.element && "value" in widget.element) {
		widget.element.value = value;
	}
	widget.callback?.(value);
}

function markDirty(node) {
	node?.setDirtyCanvas?.(true, true);
	app.graph?.setDirtyCanvas?.(true, true);
}

function notifyPanelStateChanged(node) {
	node?.__gjjPromptPresetPanelRefresh?.();
	scheduleLayout(node);
	markDirty(node);
}

function compactSingleLineTextWidget(widget) {
	if (!widget || widget.__gjjPromptPresetCompacted) {
		return;
	}
	widget.__gjjPromptPresetCompacted = true;
	widget.options = widget.options || {};
	widget.options.multiline = false;

	const originalComputeSize = widget.computeSize;
	widget.computeSize = (width) => {
		const size = typeof originalComputeSize === "function"
			? originalComputeSize.call(widget, width)
			: [Math.max(200, width || MIN_NODE_WIDTH), 34];
		return [Math.max(200, Number(size?.[0] || width || MIN_NODE_WIDTH)), 34];
	};

	const control = widget.inputEl || widget.element;
	if (!control) {
		return;
	}
	if (String(control.tagName || "").toUpperCase() === "TEXTAREA") {
		control.rows = 1;
	}
	control.style.minHeight = "32px";
	control.style.height = "32px";
	control.style.maxHeight = "32px";
	control.style.resize = "none";
	control.style.overflowY = "hidden";
}

function hideInternalWidget(widget) {
	if (!widget || widget.__gjjPromptPresetInternalHidden) {
		return;
	}
	widget.__gjjPromptPresetInternalHidden = true;
	widget.__gjjPromptPresetInternal = true;

	if (!widget.__gjjPromptPresetOriginalComputeSize) {
		widget.__gjjPromptPresetOriginalComputeSize = widget.computeSize;
	}
	if (!widget.__gjjPromptPresetOriginalGetHeight) {
		widget.__gjjPromptPresetOriginalGetHeight = widget.getHeight;
	}
	if (!widget.__gjjPromptPresetOriginalDraw) {
		widget.__gjjPromptPresetOriginalDraw = widget.draw;
	}
	if (!widget.__gjjPromptPresetOriginalType) {
		widget.__gjjPromptPresetOriginalType = widget.type;
	}

	widget.computeSize = () => [0, 0];
	widget.getHeight = () => 0;
	widget.draw = () => {};
	widget.type = `converted-widget:${widget.name || "internal"}`;
	widget.hidden = true;
	widget.y = -10000;
	widget.last_y = -10000;

	for (const element of [widget.inputEl, widget.element].filter(Boolean)) {
		element.style.display = "none";
		element.style.pointerEvents = "none";
	}
}

function removeAllInputs(node) {
	for (let index = (node.inputs?.length || 0) - 1; index >= 0; index -= 1) {
		node.removeInput?.(index);
	}
}

function ensureMinWidth(node) {
	const width = Math.max(MIN_NODE_WIDTH, Number(node?.size?.[0] || 0));
	if (width !== Number(node?.size?.[0] || 0)) {
		node.setSize?.([width, Number(node?.size?.[1] || 0)]);
	}
}

function getSections() {
	return Array.isArray(schemaCache?.sections) && schemaCache.sections.length
		? schemaCache.sections
		: FALLBACK_SECTIONS;
}

function getDefaults() {
	return schemaCache?.defaults || FALLBACK_DEFAULTS;
}

function getFieldConfig(fieldKey) {
	return schemaCache?.fields?.[fieldKey] || null;
}

function parseConfigState(rawValue) {
	if (!rawValue) {
		return {};
	}
	try {
		const parsed = JSON.parse(String(rawValue));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch (_error) {
		return {};
	}
}

function serializeConfigState(state) {
	try {
		return JSON.stringify(state);
	} catch (_error) {
		return "{}";
	}
}

function getConfigWidget(node) {
	return getWidget(node, CONFIG_STORE_WIDGET);
}

function getState(node) {
	const configWidget = getConfigWidget(node);
	const rawValue = configWidget?.value ?? node?.__gjjPromptPresetStateRaw ?? "{}";
	if (node.__gjjPromptPresetState && node.__gjjPromptPresetStateRaw === rawValue) {
		return node.__gjjPromptPresetState;
	}
	const nextState = {
		...getDefaults(),
		...parseConfigState(rawValue),
	};
	node.__gjjPromptPresetStateRaw = rawValue;
	node.__gjjPromptPresetState = nextState;
	return nextState;
}

function replaceState(node, nextState) {
	const merged = {
		...getDefaults(),
		...(nextState || {}),
	};
	const serialized = serializeConfigState(merged);
	node.__gjjPromptPresetState = merged;
	node.__gjjPromptPresetStateRaw = serialized;

	const configWidget = getConfigWidget(node);
	if (configWidget && String(configWidget.value ?? "") !== serialized) {
		setWidgetValue(configWidget, serialized);
		hideInternalWidget(configWidget);
	}
	return merged;
}

function updateState(node, patch) {
	return replaceState(node, {
		...getState(node),
		...(patch || {}),
	});
}

function isSectionEnabled(state, section) {
	const value = normalizeText(state?.[section?.mode_key]);
	if (section?.key === "style") {
		return value === OPTION_SINGLE || value === OPTION_MULTI;
	}
	return value === OPTION_ON;
}

function pickDefaultSection(node, stateOverride = null) {
	const sections = getSections();
	const state = stateOverride || getState(node);
	const firstEnabled = sections.find((section) => isSectionEnabled(state, section));
	return firstEnabled?.key || sections[0]?.key || "style";
}

function getCurrentSection(node) {
	const current = normalizeText(
		node?.properties?.[SECTION_PROPERTY_KEY]
		|| node?.__gjjPromptPresetSection
		|| "",
	);
	const sections = getSections();
	if (sections.some((section) => section.key === current)) {
		return current;
	}
	return pickDefaultSection(node);
}

function setCurrentSection(node, key) {
	if (!getSections().some((section) => section.key === key)) {
		return;
	}
	node.__gjjPromptPresetSection = key;
	node.properties = node.properties || {};
	node.properties[SECTION_PROPERTY_KEY] = key;
}

function getSectionByKey(key) {
	return getSections().find((section) => section.key === key) || getSections()[0] || FALLBACK_SECTIONS[0];
}

function getStyleModeFromNames(names) {
	return uniqueStrings(names).length > 1 ? OPTION_MULTI : OPTION_SINGLE;
}

function applySectionSelection(node, section, event) {
	const sections = getSections();
	const currentState = getState(node);
	const patch = {};
	const shiftPressed = Boolean(event?.shiftKey);

	if (shiftPressed) {
		const enableTarget = !isSectionEnabled(currentState, section);
		patch[section.mode_key] = section.key === "style"
			? (enableTarget ? getStyleModeFromNames(getSelectedStyleNamesFromState(currentState)) : OPTION_OFF)
			: (enableTarget ? OPTION_ON : OPTION_OFF);
	} else {
		for (const item of sections) {
			patch[item.mode_key] = item.key === "style"
				? (item.key === section.key ? getStyleModeFromNames(getSelectedStyleNamesFromState(currentState)) : OPTION_OFF)
				: (item.key === section.key ? OPTION_ON : OPTION_OFF);
		}
	}

	const nextState = updateState(node, patch);
	if (shiftPressed && !isSectionEnabled(nextState, section) && getCurrentSection(node) === section.key) {
		setCurrentSection(node, pickDefaultSection(node, nextState));
	} else {
		setCurrentSection(node, section.key);
	}
	renderNode(node);
}

function createPillButton(label, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.style.cssText = [
		"border:1px solid #314047",
		"background:#121a1f",
		"color:#dce7e2",
		"border-radius:10px",
		"padding:4px 10px",
		"font-size:11px",
		"line-height:1.2",
		"cursor:pointer",
		"white-space:nowrap",
		"box-sizing:border-box",
	].join(";");
	button.addEventListener("mousedown", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick?.(event);
	});
	return button;
}

function stylePillButton(button, state = {}) {
	if (!button) {
		return;
	}
	const active = Boolean(state.active);
	const accent = Boolean(state.accent);
	const disabled = Boolean(state.disabled);
	button.disabled = disabled;
	button.style.background = active ? "#27404a" : (accent ? "#17242a" : "#121a1f");
	button.style.borderColor = active ? "#79aebe" : (accent ? "#4d7581" : "#314047");
	button.style.color = active ? "#f2fbff" : (disabled ? "#7f9198" : "#dce7e2");
	button.style.opacity = disabled ? "0.72" : "1";
	button.style.cursor = disabled ? "not-allowed" : "pointer";
}

function stopControlMouse(control) {
	control.addEventListener("mousedown", (event) => event.stopPropagation());
	control.addEventListener("pointerdown", (event) => event.stopPropagation());
	control.addEventListener("click", (event) => event.stopPropagation());
}

function stopControlWheel(event) {
	event.stopPropagation();
}

function normalizeWheelDelta(event) {
	if (typeof event?.deltaY === "number" && Number.isFinite(event.deltaY)) {
		return event.deltaY;
	}
	if (typeof event?.wheelDelta === "number" && Number.isFinite(event.wheelDelta)) {
		return -event.wheelDelta;
	}
	return 0;
}

function captureWheelForScrollContainer(container) {
	if (!container || container.__gjjPromptPresetWheelCaptured) {
		return;
	}
	container.__gjjPromptPresetWheelCaptured = true;

	const handleWheel = (event) => {
		const deltaY = normalizeWheelDelta(event);
		if (!deltaY) {
			event.stopPropagation();
			return;
		}

		const beforeTop = container.scrollTop;
		container.scrollTop += deltaY;
		event.preventDefault();
		event.stopPropagation();

		if (container.scrollTop === beforeTop) {
			container.scrollTop += deltaY > 0 ? 1 : -1;
		}
	};

	container.addEventListener("wheel", handleWheel, { passive: false, capture: true });
	container.addEventListener("mousewheel", handleWheel, { passive: false, capture: true });
}

function isolateScrollableControl(control) {
	if (!control) {
		return;
	}
	stopControlMouse(control);
	control.addEventListener("wheel", stopControlWheel, { passive: true });
	control.addEventListener("mousewheel", stopControlWheel, { passive: true });
}

function cacheStyleCatalog(items) {
	styleCatalog = Array.isArray(items) ? items : [];
	styleLookup.clear();
	for (const item of styleCatalog) {
		const aliases = [
			item?.name,
			item?.name_cn,
			item?.label,
			extractOptionValue(item?.label),
		];
		for (const alias of aliases) {
			const text = normalizeText(alias);
			if (!text) {
				continue;
			}
			styleLookup.set(text, item);
			styleLookup.set(normalizeKey(text), item);
		}
	}
	return styleCatalog;
}

async function loadStyleCatalog() {
	if (!styleCatalogPromise) {
		styleCatalogPromise = api.fetchApi(STYLES_API_URL)
			.then((response) => {
				if (!response.ok) {
					throw new Error(`load styles failed: ${response.status}`);
				}
				return response.json();
			})
			.then((payload) => cacheStyleCatalog(payload?.styles))
			.catch((error) => {
				console.warn("[GJJ] 加载风格缩略图失败", error);
				return cacheStyleCatalog([]);
			})
			.finally(() => {
				stylesLoaded = true;
			});
	}
	return styleCatalogPromise;
}

async function loadSchema() {
	if (!schemaPromise) {
		schemaPromise = api.fetchApi(SCHEMA_API_URL)
			.then((response) => {
				if (!response.ok) {
					throw new Error(`load schema failed: ${response.status}`);
				}
				return response.json();
			})
			.then((payload) => {
				schemaCache = payload || null;
				return schemaCache;
			})
			.catch((error) => {
				console.warn("[GJJ] 加载提示词面板结构失败", error);
				return schemaCache;
			})
			.finally(() => {
				schemaLoaded = true;
			});
	}
	return schemaPromise;
}

function resolveStyleItem(token) {
	const raw = normalizeText(token);
	return styleLookup.get(raw)
		|| styleLookup.get(normalizeKey(raw))
		|| styleLookup.get(extractOptionValue(raw))
		|| styleLookup.get(normalizeKey(extractOptionValue(raw)))
		|| null;
}

function getSelectedStyleNamesFromState(state) {
	const selected = [];
	const primaryValue = normalizeText(state?.["主风格"]);
	if (primaryValue && primaryValue !== OPTION_NONE) {
		selected.push(resolveStyleItem(primaryValue)?.name || extractOptionValue(primaryValue));
	}
	for (const token of splitTokens(state?.["附加风格列表"])) {
		selected.push(resolveStyleItem(token)?.name || extractOptionValue(token));
	}
	return uniqueStrings(selected);
}

function setSelectedStyleNames(node, names, modeOverride = null) {
	const state = getState(node);
	const styleEnabled = modeOverride
		? modeOverride !== OPTION_OFF
		: isSectionEnabled(state, getSectionByKey("style"));
	const deduped = uniqueStrings(names)
		.map((name) => resolveStyleItem(name)?.name || name);
	const modeValue = modeOverride || (styleEnabled ? getStyleModeFromNames(deduped) : OPTION_OFF);
	const limited = modeValue === OPTION_SINGLE ? deduped.slice(0, 1) : deduped;
	updateState(node, {
		"风格模式": modeValue,
		"主风格": limited[0] || OPTION_NONE,
		"附加风格列表": limited.slice(1).join(", "),
	});
}

function ensureToolbar(node) {
	if (node.__gjjPromptPresetToolbar) {
		return node.__gjjPromptPresetToolbar;
	}

	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"padding:4px 0 2px",
	].join(";");
	isolateScrollableControl(container);

	const navRow = document.createElement("div");
	navRow.style.cssText = [
		"display:flex",
		"flex-wrap:wrap",
		"gap:6px",
	].join(";");

	container.appendChild(navRow);

	const widget = node.addDOMWidget?.(TOOLBAR_WIDGET_NAME, TOOLBAR_WIDGET_NAME, container, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => Math.max(MIN_TOOLBAR_HEIGHT, Number(node.__gjjPromptPresetToolbarHeight || MIN_TOOLBAR_HEIGHT)),
	});
	if (widget) {
		widget.computeSize = (width) => [
			Math.max(MIN_NODE_WIDTH, width || MIN_NODE_WIDTH),
			Math.max(MIN_TOOLBAR_HEIGHT, Number(node.__gjjPromptPresetToolbarHeight || MIN_TOOLBAR_HEIGHT)),
		];
	}

	node.__gjjPromptPresetToolbar = { widget, container, navRow };
	return node.__gjjPromptPresetToolbar;
}

function ensurePanel(node) {
	if (node.__gjjPromptPresetPanel) {
		return node.__gjjPromptPresetPanel;
	}

	const container = document.createElement("div");
	container.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"padding:2px 0 0",
	].join(";");
	isolateScrollableControl(container);

	const widget = node.addDOMWidget?.(PANEL_WIDGET_NAME, PANEL_WIDGET_NAME, container, {
		serialize: false,
		hideOnZoom: false,
		getHeight: () => Math.max(MIN_PANEL_HEIGHT, Number(node.__gjjPromptPresetPanelHeight || MIN_PANEL_HEIGHT)),
	});
	if (widget) {
		widget.computeSize = (width) => [
			Math.max(MIN_NODE_WIDTH, width || MIN_NODE_WIDTH),
			Math.max(MIN_PANEL_HEIGHT, Number(node.__gjjPromptPresetPanelHeight || MIN_PANEL_HEIGHT)),
		];
	}

	node.__gjjPromptPresetPanel = { widget, container };
	return node.__gjjPromptPresetPanel;
}

function renderToolbar(node) {
	const state = ensureToolbar(node);
	const sections = getSections();
	const currentKey = getCurrentSection(node);
	const currentState = getState(node);

	state.navRow.innerHTML = "";
	for (const section of sections) {
		const button = createPillButton(section.label, (event) => {
			applySectionSelection(node, section, event);
		});
		const enabled = isSectionEnabled(currentState, section);
		const focused = section.key === currentKey;
		stylePillButton(button, {
			active: enabled,
			accent: focused && !enabled,
		});
		button.style.boxShadow = focused ? "0 0 0 1px #9fd7eb inset" : "none";
		state.navRow.appendChild(button);
	}
}

function createHelpNotice(text) {
	const box = document.createElement("div");
	box.textContent = text;
	box.style.cssText = [
		"padding:12px 10px",
		"border:1px dashed #314047",
		"border-radius:12px",
		"color:#8fa4ac",
		"font-size:11px",
		"line-height:1.5",
		"background:#10181d",
	].join(";");
	return box;
}

function createAnglePreview(node, disabled) {
	const card = document.createElement("div");
	card.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:10px",
		"padding:10px",
		"border-radius:14px",
		"border:1px solid #314047",
		"background:linear-gradient(180deg, #10181d 0%, #0d1418 100%)",
	].join(";");

	const header = document.createElement("div");
	header.style.cssText = [
		"display:flex",
		"justify-content:space-between",
		"align-items:center",
		"gap:8px",
		"flex-wrap:wrap",
	].join(";");

	const title = document.createElement("div");
	title.textContent = "多角度预览";
	title.style.cssText = [
		"font-size:12px",
		"font-weight:600",
		"color:#e8f3f7",
	].join(";");

	const modeBadge = document.createElement("div");
	modeBadge.style.cssText = [
		"padding:4px 8px",
		"border-radius:999px",
		"font-size:10px",
		"line-height:1",
		"border:1px solid #3d5964",
		"background:#162228",
		"color:#d7e8ee",
	].join(";");

	header.appendChild(title);
	header.appendChild(modeBadge);
	card.appendChild(header);

	const main = document.createElement("div");
	main.style.cssText = [
		"display:grid",
		"grid-template-columns:92px minmax(0, 1fr)",
		"gap:12px",
		"align-items:center",
	].join(";");

	const stage = document.createElement("div");
	stage.style.cssText = [
		"position:relative",
		"height:104px",
		"border-radius:12px",
		"border:1px solid #27343b",
		"background:radial-gradient(circle at 35% 25%, #1d2d36 0%, #10181d 62%, #0a1014 100%)",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"perspective:720px",
		"overflow:hidden",
	].join(";");

	const cube = document.createElement("div");
	cube.style.cssText = [
		"position:relative",
		"width:58px",
		"height:58px",
		"transform-style:preserve-3d",
		"transition:transform 120ms ease-out",
	].join(";");

	const faceDefs = [
		{ label: "👧", title: "正面", transform: "translateZ(29px)", background: "rgba(134, 199, 232, 0.24)" },
		{ label: "🔙", title: "背面", transform: "rotateY(180deg) translateZ(29px)", background: "rgba(123, 164, 186, 0.16)" },
		{ label: "👈", title: "左侧", transform: "rotateY(-90deg) translateZ(29px)", background: "rgba(117, 175, 204, 0.18)" },
		{ label: "👉", title: "右侧", transform: "rotateY(90deg) translateZ(29px)", background: "rgba(117, 175, 204, 0.18)" },
		{ label: "👆", title: "顶视", transform: "rotateX(90deg) translateZ(29px)", background: "rgba(178, 222, 244, 0.26)" },
		{ label: "👇", title: "底视", transform: "rotateX(-90deg) translateZ(29px)", background: "rgba(70, 101, 116, 0.20)" },
	];
	for (const faceDef of faceDefs) {
		const face = document.createElement("div");
		face.textContent = faceDef.label;
		face.title = faceDef.title;
		face.style.cssText = [
			"position:absolute",
			"inset:0",
			"display:flex",
			"align-items:center",
			"justify-content:center",
			"border:1px solid rgba(144, 204, 230, 0.44)",
			"border-radius:12px",
			`background:${faceDef.background}`,
			"backdrop-filter:blur(1px)",
			"box-sizing:border-box",
			"font-size:15px",
			"font-weight:700",
			"color:#eef8fd",
			"text-shadow:0 1px 3px rgba(0, 0, 0, 0.35)",
			`transform:${faceDef.transform}`,
		].join(";");
		cube.appendChild(face);
	}

	const floor = document.createElement("div");
	floor.style.cssText = [
		"position:absolute",
		"left:12px",
		"right:12px",
		"bottom:12px",
		"height:12px",
		"border-radius:999px",
		"background:radial-gradient(circle, rgba(102, 167, 194, 0.22) 0%, rgba(102, 167, 194, 0) 72%)",
		"filter:blur(3px)",
	].join(";");

	stage.appendChild(floor);
	stage.appendChild(cube);
	main.appendChild(stage);

	const info = document.createElement("div");
	info.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"min-width:0",
	].join(";");

	const chips = document.createElement("div");
	chips.style.cssText = [
		"display:flex",
		"flex-wrap:wrap",
		"gap:6px",
	].join(";");

	const makeChip = () => {
		const chip = document.createElement("div");
		chip.style.cssText = [
			"padding:4px 8px",
			"border-radius:999px",
			"border:1px solid #314047",
			"background:#121a1f",
			"font-size:10px",
			"line-height:1.2",
			"color:#dbe8ee",
		].join(";");
		return chip;
	};

	const horizontalChip = makeChip();
	const verticalChip = makeChip();
	const distanceChip = makeChip();
	chips.appendChild(horizontalChip);
	chips.appendChild(verticalChip);
	chips.appendChild(distanceChip);

	const metrics = document.createElement("div");
	metrics.style.cssText = [
		"font-size:10px",
		"line-height:1.45",
		"color:#8fa7b1",
	].join(";");

	const distanceRow = document.createElement("div");
	distanceRow.style.cssText = [
		"display:flex",
		"justify-content:space-between",
		"align-items:center",
		"gap:8px",
		"font-size:10px",
		"line-height:1.2",
		"color:#dbe8ee",
	].join(";");

	const distanceTitle = document.createElement("div");
	distanceTitle.style.cssText = [
		"font-weight:600",
		"color:#e8f3f7",
	].join(";");

	const distanceValue = document.createElement("div");
	distanceValue.style.cssText = [
		"padding:3px 7px",
		"border-radius:999px",
		"border:1px solid #314047",
		"background:#121a1f",
		"color:#bcd5de",
	].join(";");

	distanceRow.appendChild(distanceTitle);
	distanceRow.appendChild(distanceValue);

	const zoomTrack = document.createElement("div");
	zoomTrack.style.cssText = [
		"height:10px",
		"border-radius:999px",
		"background:#162228",
		"overflow:hidden",
		"border:1px solid #243239",
	].join(";");

	const zoomFill = document.createElement("div");
	zoomFill.style.cssText = [
		"height:100%",
		"width:50%",
		"border-radius:999px",
		"background:linear-gradient(90deg, #5f93a7 0%, #8bc3d8 100%)",
		"box-shadow:0 0 8px rgba(139, 195, 216, 0.2)",
	].join(";");
	zoomTrack.appendChild(zoomFill);

	const zoomScale = document.createElement("div");
	zoomScale.style.cssText = [
		"display:flex",
		"justify-content:space-between",
		"align-items:center",
		"font-size:10px",
		"line-height:1.2",
		"color:#7f98a2",
	].join(";");

	const zoomFar = document.createElement("div");
	zoomFar.textContent = "远";
	const zoomNear = document.createElement("div");
	zoomNear.textContent = "近";
	zoomScale.appendChild(zoomFar);
	zoomScale.appendChild(zoomNear);

	const status = document.createElement("div");
	status.style.cssText = [
		"font-size:10px",
		"line-height:1.45",
		"color:#9fb1b8",
	].join(";");

	info.appendChild(chips);
	info.appendChild(metrics);
	info.appendChild(distanceRow);
	info.appendChild(zoomTrack);
	info.appendChild(zoomScale);
	info.appendChild(status);
	main.appendChild(info);
	card.appendChild(main);

	const promptLabel = document.createElement("div");
	promptLabel.textContent = "角度提示词预览";
	promptLabel.style.cssText = [
		"font-size:10px",
		"line-height:1.2",
		"color:#8fa7b1",
	].join(";");

	const promptBox = document.createElement("div");
	promptBox.style.cssText = [
		"padding:9px 10px",
		"border-radius:10px",
		"border:1px solid #26353c",
		"background:#0f171b",
		"font-size:11px",
		"line-height:1.45",
		"color:#eef7fb",
		"word-break:break-word",
		"user-select:text",
	].join(";");
	stopControlMouse(promptBox);

	card.appendChild(promptLabel);
	card.appendChild(promptBox);

	const update = () => {
		const data = getAnglePreviewData(getState(node));
		card.style.opacity = disabled ? "0.76" : "1";
		cube.style.transform = data.cubeTransform;
		modeBadge.textContent = data.detailMode === "简洁" ? "简洁模式" : "详细模式";
		modeBadge.style.borderColor = data.detailMode === "简洁" ? "#516a74" : "#79aebe";
		modeBadge.style.background = data.detailMode === "简洁" ? "#152126" : "#19303a";

		horizontalChip.textContent = `水平：${data.horizontalLabel}`;
		verticalChip.textContent = `垂直：${data.verticalLabel}`;
		distanceChip.textContent = `景别：${data.distanceLabel}`;

		metrics.textContent = `旋转 ${Math.round(data.rotate)}° · 俯仰 ${Math.round(data.vertical)}° · 缩放 ${data.zoom.toFixed(1)}`;
		distanceTitle.textContent = `远近：${data.distanceLabel}`;
		distanceValue.textContent = `${data.zoom.toFixed(1)} / 10`;
		zoomFill.style.width = `${Math.max(0, Math.min(100, data.zoom * 10))}%`;
		status.textContent = disabled
			? "当前只做预览；顶部按钮选中“多角度”后才会参与生成。"
			: "当前角度词已参与生成，下面英文预览会与输出保持一致。";
		promptBox.textContent = data.prompt;
	};

	update();
	return { element: card, update };
}

function createDetailRow(node, fieldKey, field, disabled) {
	const state = getState(node);
	const row = document.createElement("div");
	row.title = normalizeText(field?.tooltip);
	row.style.cssText = [
		"display:grid",
		"grid-template-columns:84px minmax(0, 1fr)",
		"gap:8px",
		"align-items:center",
	].join(";");

	const label = document.createElement("div");
	label.textContent = normalizeText(field?.display_name || fieldKey);
	label.style.cssText = [
		"font-size:11px",
		"line-height:1.35",
		"color:#aabcc2",
		"word-break:break-word",
		`opacity:${disabled ? 0.58 : 1}`,
	].join(";");

	const shell = document.createElement("div");
	shell.style.cssText = `opacity:${disabled ? 0.64 : 1};`;

	let control = null;
	if (field?.kind === "select") {
		control = document.createElement("select");
		const values = Array.isArray(field.options) ? field.options.map((value) => String(value)) : [];
		const currentValue = String(state[fieldKey] ?? field.default ?? "");
		const mergedValues = values.includes(currentValue) || !currentValue ? values : [currentValue, ...values];
		for (const value of mergedValues) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = getOptionDisplayText(value);
			option.title = value;
			option.selected = value === currentValue;
			control.appendChild(option);
		}
		control.addEventListener("change", () => {
			updateState(node, { [fieldKey]: control.value });
			notifyPanelStateChanged(node);
		});
	} else if (field?.kind === "int" || field?.kind === "float") {
		control = document.createElement("input");
		control.type = "number";
		control.value = String(state[fieldKey] ?? field.default ?? "");
		if (typeof field.min === "number") {
			control.min = String(field.min);
		}
		if (typeof field.max === "number") {
			control.max = String(field.max);
		}
		if (typeof field.step === "number") {
			control.step = String(field.step);
		}
		const syncNumberValue = (soft = false) => {
			const nextValue = field.kind === "int"
				? Number.parseInt(control.value, 10)
				: Number.parseFloat(control.value);
			if (Number.isNaN(nextValue)) {
				if (!soft) {
					control.value = String(getState(node)[fieldKey] ?? field.default ?? "");
				}
				return;
			}
			updateState(node, { [fieldKey]: nextValue });
			notifyPanelStateChanged(node);
		};
		control.addEventListener("input", () => syncNumberValue(true));
		control.addEventListener("change", () => syncNumberValue(false));
	} else {
		control = document.createElement("input");
		control.type = "text";
		control.value = String(state[fieldKey] ?? field?.default ?? "");
		control.placeholder = normalizeText(field?.display_name || fieldKey);
		control.addEventListener("change", () => {
			updateState(node, { [fieldKey]: control.value });
			notifyPanelStateChanged(node);
		});
	}

	control.disabled = disabled;
	control.style.cssText = [
		"width:100%",
		"height:30px",
		"padding:0 10px",
		"border-radius:9px",
		"border:1px solid #314047",
		"background:#121a1f",
		"color:#dce7e2",
		"font-size:11px",
		"outline:none",
		"box-sizing:border-box",
	].join(";");
	stopControlMouse(control);

	shell.appendChild(control);
	row.appendChild(label);
	row.appendChild(shell);
	return row;
}

function renderDetailPanel(node, section, container) {
	const currentState = getState(node);
	const enabled = isSectionEnabled(currentState, section);

	if (!schemaCache?.fields) {
		container.appendChild(createHelpNotice(schemaLoaded ? "未读取到参数结构数据。" : "参数结构加载中，稍后会自动填充。"));
		if (!schemaLoaded) {
			loadSchema().then(() => renderNode(node));
		}
		return;
	}

	const summary = document.createElement("div");
	summary.textContent = enabled
		? (section.key === "angle"
			? "当前分类：多角度，下面预览会随参数实时更新。"
			: `当前分类：${section.label}，共 ${(section.fields || []).length} 项。`)
		: `当前分类：${section.label}，顶部按钮选中后才会参与生成。`;
	summary.style.cssText = [
		"font-size:11px",
		"line-height:1.45",
		"color:#9fb1b8",
	].join(";");
	container.appendChild(summary);

	if (section.key === "angle") {
		const anglePreview = createAnglePreview(node, !enabled);
		node.__gjjPromptPresetPanelRefresh = anglePreview.update;
		container.appendChild(anglePreview.element);
	} else {
		node.__gjjPromptPresetPanelRefresh = null;
	}

	const body = document.createElement("div");
	body.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:8px",
		"overflow:visible",
		"padding-right:2px",
	].join(";");

	for (const fieldKey of section.fields || []) {
		const field = getFieldConfig(fieldKey);
		if (!field) {
			continue;
		}
		body.appendChild(createDetailRow(node, fieldKey, field, !enabled));
	}

	container.appendChild(body);
}

function buildStyleCard(node, item, selectedSet) {
	const button = document.createElement("button");
	button.type = "button";
	button.title = normalizeText(item?.name_cn || item?.name);
	button.style.cssText = [
		"display:flex",
		"flex-direction:column",
		"gap:5px",
		"width:100%",
		"padding:5px",
		"border-radius:11px",
		"border:1px solid #314047",
		"background:#121a1f",
		"color:#dce7e2",
		"text-align:left",
		"cursor:pointer",
		"box-sizing:border-box",
	].join(";");
	button.addEventListener("mousedown", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();

		const state = getState(node);
		let selectedNames = getSelectedStyleNamesFromState(state);
		if (event.shiftKey) {
			selectedNames = selectedSet.has(item.name)
				? selectedNames.filter((name) => name !== item.name)
				: [...selectedNames, item.name];
		} else {
			selectedNames = selectedNames.length === 1 && selectedNames[0] === item.name
				? []
				: [item.name];
		}

		setCurrentSection(node, "style");
		setSelectedStyleNames(node, selectedNames, event.shiftKey ? getStyleModeFromNames(selectedNames) : OPTION_SINGLE);
		renderToolbar(node);
		updateStylePanelContents(node);
	});

	const imageFrame = document.createElement("div");
	imageFrame.style.cssText = [
		"align-self:center",
		"width:auto",
		"max-width:100%",
		"height:62px",
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"overflow:visible",
		"box-sizing:border-box",
	].join(";");

	const image = document.createElement("img");
	image.loading = "lazy";
	image.referrerPolicy = "no-referrer";
	image.src = normalizeText(item?.thumbnail);
	image.alt = normalizeText(item?.name_cn || item?.name);
	image.style.cssText = [
		"width:auto",
		"max-width:100%",
		"height:100%",
		"object-fit:contain",
		"border-radius:8px",
		"display:block",
	].join(";");
	image.addEventListener("error", () => {
		image.style.opacity = "0.22";
		image.style.objectFit = "contain";
	});

	const title = document.createElement("div");
	title.textContent = normalizeText(item?.name_cn || item?.name);
	title.style.cssText = [
		"font-size:11px",
		"line-height:1.32",
		"font-weight:600",
		"color:#e5f0f4",
		"word-break:break-word",
	].join(";");

	imageFrame.appendChild(image);
	button.appendChild(imageFrame);
	button.appendChild(title);

	if (normalizeText(item?.name_cn) && normalizeText(item?.name_cn) !== normalizeText(item?.name)) {
		const subtitle = document.createElement("div");
		subtitle.textContent = normalizeText(item?.name);
		subtitle.style.cssText = [
			"font-size:10px",
			"line-height:1.3",
			"color:#8fa4ac",
			"word-break:break-word",
		].join(";");
		button.appendChild(subtitle);
	}

	stylePillButton(button, {
		active: selectedSet.has(item.name),
		accent: selectedSet.has(item.name),
	});
	return button;
}

function updateStylePanelContents(node) {
	const panelState = node.__gjjPromptPresetStylePanel;
	if (!panelState) {
		return;
	}

	const currentState = getState(node);
	const selectedNames = getSelectedStyleNamesFromState(currentState);
	const selectedSet = new Set(selectedNames);
	const modeValue = normalizeText(currentState["风格模式"]);
	const { clearButton, summary, grid } = panelState;

	clearButton.disabled = selectedNames.length === 0;
	summary.textContent = modeValue === OPTION_OFF
		? "当前风格分类未选中。点击上方“风格”按钮可启用；按 Shift 可与其它分类多选。"
		: `当前模式：${modeValue}，已选 ${selectedNames.length} 个风格。风格卡片按 Shift 可多选。`;

	grid.innerHTML = "";

	if (!styleCatalog.length && !stylesLoaded) {
		loadStyleCatalog().then(() => renderNode(node));
	}
	if (!styleCatalog.length) {
		grid.appendChild(createHelpNotice(stylesLoaded ? "未读取到风格缩略图数据。" : "风格缩略图加载中，稍后会自动显示。"));
		scheduleLayout(node);
		return;
	}

	const query = normalizeKey(node.__gjjPromptPresetStyleSearch || "");
	const filtered = styleCatalog
		.filter((item) => {
			if (!query) {
				return true;
			}
			return [item?.name, item?.name_cn, item?.label]
				.some((value) => normalizeKey(value).includes(query));
		})
		.sort((left, right) => {
			const leftSelected = selectedSet.has(left?.name);
			const rightSelected = selectedSet.has(right?.name);
			if (leftSelected !== rightSelected) {
				return leftSelected ? -1 : 1;
			}
			return String(left?.name_cn || left?.name || "").localeCompare(
				String(right?.name_cn || right?.name || ""),
				"zh-CN",
			);
		});

	if (!filtered.length) {
		grid.appendChild(createHelpNotice("没有找到匹配的风格。"));
		scheduleLayout(node);
		return;
	}

	for (const item of filtered) {
		grid.appendChild(buildStyleCard(node, item, selectedSet));
	}
	scheduleLayout(node);
}

function renderStylePanel(node, container) {
	const tools = document.createElement("div");
	tools.style.cssText = [
		"display:flex",
		"align-items:center",
		"gap:8px",
	].join(";");

	const searchInput = document.createElement("input");
	searchInput.type = "text";
	searchInput.placeholder = "搜索风格...";
	searchInput.value = node.__gjjPromptPresetStyleSearch || "";
	searchInput.style.cssText = [
		"flex:1 1 auto",
		"height:32px",
		"padding:0 12px",
		"border-radius:10px",
		"border:1px solid #314047",
		"background:#121a1f",
		"color:#dce7e2",
		"font-size:12px",
		"outline:none",
		"box-sizing:border-box",
	].join(";");
	stopControlMouse(searchInput);
	searchInput.addEventListener("input", () => {
		node.__gjjPromptPresetStyleSearch = searchInput.value;
		updateStylePanelContents(node);
	});

	const clearButton = createPillButton("清空已选", () => {
		const styleEnabled = isSectionEnabled(getState(node), getSectionByKey("style"));
		setSelectedStyleNames(node, [], styleEnabled ? OPTION_SINGLE : OPTION_OFF);
		updateStylePanelContents(node);
		renderToolbar(node);
	});

	tools.appendChild(searchInput);
	tools.appendChild(clearButton);
	container.appendChild(tools);

	const summary = document.createElement("div");
	summary.style.cssText = [
		"font-size:11px",
		"line-height:1.45",
		"color:#9fb1b8",
	].join(";");
	container.appendChild(summary);

	const grid = document.createElement("div");
	grid.style.cssText = [
		"display:grid",
		"grid-template-columns:repeat(3, minmax(0, 1fr))",
		"gap:8px",
		"overflow:visible",
		"padding-right:2px",
	].join(";");
	container.appendChild(grid);

	node.__gjjPromptPresetStylePanel = {
		searchInput,
		clearButton,
		summary,
		grid,
	};
	updateStylePanelContents(node);
}

function renderPanel(node) {
	const panel = ensurePanel(node);
	const currentSection = getSectionByKey(getCurrentSection(node));
	panel.container.innerHTML = "";
	node.__gjjPromptPresetPanelRefresh = null;

	if (!getConfigWidget(node)) {
		panel.container.appendChild(createHelpNotice("检测到旧节点定义。请先重启 ComfyUI，再重新拖一个新的“GJJ · 多功能提示词预设”。"));
		return;
	}

	if (currentSection.key === "style") {
		renderStylePanel(node, panel.container);
	} else {
		node.__gjjPromptPresetStylePanel = null;
		renderDetailPanel(node, currentSection, panel.container);
	}
}

function getNativeWidgetHeight(widget, width) {
	if (!widget) {
		return 0;
	}
	try {
		if (typeof widget.computeSize === "function") {
			const size = widget.computeSize(width);
			if (Array.isArray(size) && Number.isFinite(size[1])) {
				return Math.max(0, Number(size[1]));
			}
		}
	} catch (error) {
		console.warn("[GJJ] 读取控件高度失败", widget?.name, error);
	}
	return 34;
}

function getWidgetHeight(node, widget, width) {
	if (!widget) {
		return 0;
	}
	if (widget.name === TOOLBAR_WIDGET_NAME) {
		return Math.max(MIN_TOOLBAR_HEIGHT, Number(node.__gjjPromptPresetToolbarHeight || MIN_TOOLBAR_HEIGHT));
	}
	if (widget.name === PANEL_WIDGET_NAME) {
		return Math.max(MIN_PANEL_HEIGHT, Number(node.__gjjPromptPresetPanelHeight || MIN_PANEL_HEIGHT));
	}
	return getNativeWidgetHeight(widget, width);
}

function getVisibleWidgets(node) {
	const visible = [];
	for (const widgetName of BASE_WIDGETS) {
		const widget = getWidget(node, widgetName);
		if (widget) {
			visible.push(widget);
		}
	}
	for (const widgetName of [TOOLBAR_WIDGET_NAME, PANEL_WIDGET_NAME]) {
		const widget = getWidget(node, widgetName);
		if (widget) {
			visible.push(widget);
		}
	}
	return visible;
}

function measureDomHeights(node) {
	const toolbarState = node.__gjjPromptPresetToolbar;
	if (toolbarState?.container) {
		node.__gjjPromptPresetToolbarHeight = Math.max(
			MIN_TOOLBAR_HEIGHT,
			Math.ceil(toolbarState.container.offsetHeight || toolbarState.container.scrollHeight || MIN_TOOLBAR_HEIGHT),
		);
	}
	const panelState = node.__gjjPromptPresetPanel;
	if (panelState?.container) {
		node.__gjjPromptPresetPanelHeight = Math.max(
			MIN_PANEL_HEIGHT,
			Math.ceil(panelState.container.offsetHeight || panelState.container.scrollHeight || MIN_PANEL_HEIGHT),
		);
	}
}

function layoutWidgets(node, width) {
	const visibleWidgets = getVisibleWidgets(node);
	const startY = Math.max(0, Number(node?.widgets_start_y || 0));
	let cursor = startY;

	for (const widget of visibleWidgets) {
		widget.y = cursor;
		widget.last_y = cursor;
		cursor += getWidgetHeight(node, widget, width) + 4;
	}

	const configWidget = getConfigWidget(node);
	if (configWidget) {
		configWidget.y = -10000;
		configWidget.last_y = -10000;
	}

	return Math.max(startY, cursor - 4);
}

function reorderWidgets(node) {
	moveWidgetAfter(node, TOOLBAR_WIDGET_NAME, "随机种子");
	moveWidgetAfter(node, PANEL_WIDGET_NAME, TOOLBAR_WIDGET_NAME);
	moveWidgetAfter(node, CONFIG_STORE_WIDGET, PANEL_WIDGET_NAME);
}

function refreshLayout(node) {
	if (!node) {
		return;
	}
	measureDomHeights(node);
	const width = Math.max(MIN_NODE_WIDTH, Number(node?.size?.[0] || MIN_NODE_WIDTH));
	const bottom = layoutWidgets(node, width);
	const height = Math.max(MIN_NODE_HEIGHT, Math.ceil(bottom + NODE_BOTTOM_PADDING));
	node.setSize?.([width, height]);
	markDirty(node);
}

function scheduleLayout(node) {
	if (!node || node.__gjjPromptPresetLayoutQueued) {
		return;
	}
	node.__gjjPromptPresetLayoutQueued = true;
	requestAnimationFrame(() => {
		node.__gjjPromptPresetLayoutQueued = false;
		refreshLayout(node);
	});
}

function renderNode(node) {
	ensureMinWidth(node);
	ensureToolbar(node);
	ensurePanel(node);
	reorderWidgets(node);
	renderToolbar(node);
	renderPanel(node);
	scheduleLayout(node);

	if (!schemaLoaded) {
		loadSchema().then(() => renderNode(node));
	}
	if (getCurrentSection(node) === "style" && !stylesLoaded) {
		loadStyleCatalog().then(() => renderNode(node));
	}
}

function patchWidgetHitTest(node) {
	if (!node || node.__gjjPromptPresetHitTestPatched) {
		return;
	}
	node.__gjjPromptPresetHitTestPatched = true;

	for (const methodName of ["getWidgetOnPos", "getWidgetAt"]) {
		if (typeof node[methodName] !== "function") {
			continue;
		}
		const original = node[methodName];
		node[methodName] = function (...args) {
			const widget = original.apply(this, args);
			return widget?.__gjjPromptPresetInternal ? null : widget;
		};
	}
}

function patchNodeHooks(node) {
	if (!node || node.__gjjPromptPresetHooksPatched) {
		return;
	}
	node.__gjjPromptPresetHooksPatched = true;

	patchWidgetHitTest(node);

	const originalOnSerialize = node.onSerialize;
	node.onSerialize = function (serializedNode) {
		replaceState(this, getState(this));
		const result = typeof originalOnSerialize === "function"
			? originalOnSerialize.apply(this, arguments)
			: serializedNode;
		return result ?? serializedNode;
	};

	const originalOnResize = node.onResize;
	node.onResize = function (...args) {
		const result = typeof originalOnResize === "function"
			? originalOnResize.apply(this, args)
			: undefined;
		scheduleLayout(this);
		return result;
	};
}

function ensureNode(node) {
	if (!TARGET_NODES.has(node?.comfyClass || node?.type)) {
		return;
	}

	patchNodeHooks(node);
	removeAllInputs(node);
	compactSingleLineTextWidget(getWidget(node, "正向基础词"));
	compactSingleLineTextWidget(getWidget(node, "反向基础词"));
	hideInternalWidget(getConfigWidget(node));
	setCurrentSection(node, getCurrentSection(node));
	renderNode(node);
}

app.registerExtension({
	name: "Comfy.GJJ.PromptPresetStudio",

	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TARGET_NODES.has(nodeData?.name)) {
			return;
		}

		const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function (...args) {
			const result = originalOnNodeCreated?.apply(this, args);
			setTimeout(() => ensureNode(this), 0);
			return result;
		};

		const originalOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function (...args) {
			const result = originalOnConfigure?.apply(this, args);
			setTimeout(() => ensureNode(this), 0);
			return result;
		};
	},

	nodeCreated(node) {
		setTimeout(() => ensureNode(node), 0);
	},

	setup() {
		loadSchema();
		loadStyleCatalog();
		for (const node of app.graph?._nodes || []) {
			if (TARGET_NODES.has(node?.comfyClass || node?.type)) {
				ensureNode(node);
			}
		}
	},
});
