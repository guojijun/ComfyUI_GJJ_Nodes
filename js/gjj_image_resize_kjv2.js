import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "GJJ_ImageResizeKJv2";
const CONFIG_WIDGET = "config_json";
const TAIL_WIDGET_NAME = "gjj_multifunction_resize_bottom";
const PARAM_LINKS_PROPERTY = "gjj_mf_resize_param_links";
const LEGACY_RATIO_WIDGET_NAME = "gjj_multifunction_resize_original_ratio";
const PARAM_INPUTS = [
  { name: "target_width", cfgKey: "width", label: "📐 目标宽度", mode: "宽高", type: "INT", min: 1, max: 16384, sliderMax: 4096, step: 8, defaultValue: 1024, excludeFitMode: "补边" },
  { name: "target_height", cfgKey: "height", label: "📐 目标高度", mode: "宽高", type: "INT", min: 1, max: 16384, sliderMax: 4096, step: 8, defaultValue: 1024, excludeFitMode: "补边" },
  { name: "border_left", cfgKey: "border_left", label: "⬅️ 左", mode: "宽高", fitMode: "补边", type: "INT", min: 0, max: 16384, sliderMax: 2048, step: 8, defaultValue: 0 },
  { name: "border_top", cfgKey: "border_top", label: "⬆️ 上", mode: "宽高", fitMode: "补边", type: "INT", min: 0, max: 16384, sliderMax: 2048, step: 8, defaultValue: 0 },
  { name: "border_right", cfgKey: "border_right", label: "➡️ 右", mode: "宽高", fitMode: "补边", type: "INT", min: 0, max: 16384, sliderMax: 2048, step: 8, defaultValue: 0 },
  { name: "border_bottom", cfgKey: "border_bottom", label: "⬇️ 下", mode: "宽高", fitMode: "补边", type: "INT", min: 0, max: 16384, sliderMax: 2048, step: 8, defaultValue: 0 },
  { name: "scale_percent", cfgKey: "scale_percent", label: "📊 缩放百分比", mode: "等比", type: "FLOAT", min: 0.1, max: 10000, sliderMax: 400, step: 1, defaultValue: 100 },
  { name: "long_side_length", cfgKey: "long_side_length", label: "📏 长边长度", mode: "长边", type: "INT", min: 1, max: 16384, sliderMax: 4096, step: 8, defaultValue: 1024 },
  { name: "total_pixel_k", cfgKey: "total_pixel_k", label: "🧮 总像素/K", mode: "像素", type: "INT", min: 1, max: 1000000, sliderMax: 4096, step: 1, defaultValue: 260 },
  { name: "aspect_ratio", cfgKey: "aspect_ratio", label: "🖼️ 输出比例", mode: "像素", type: "STRING", widgetType: "combo", values: ["原始比例", "自定义", "1:1", "3:2", "4:3", "16:9", "2:3", "3:4", "9:16"], defaultValue: "1:1" },
];

const DEFAULT_CONFIG = {
  mode: "等比",
  fit_mode: "留边填充",
  upscale_method: "兰索斯",
  round_to_multiple: "8",
  pad_color: "#000000",
  pad_feather: 0,
  crop_position: "中",
  device: "CPU",
  width: 1024,
  height: 1024,
  border_left: 0,
  border_top: 0,
  border_right: 0,
  border_bottom: 0,
  scale_percent: 100,
  long_side_length: 1024,
  total_pixel_k: 260,
  aspect_ratio: "1:1",
  proportional_width: 1,
  proportional_height: 1,
  extra_outputs: [],
  show_settings: false,
  source_width: 0,
  source_height: 0,
};

const MODES = ["宽高", "等比", "长边", "像素"];
const MODE_BUTTONS = {
  "宽高": { icon: "宽高", title: "宽高：按目标宽度和目标高度输出。" },
  "等比": { icon: "等比", title: "等比：按缩放百分比输出。" },
  "长边": { icon: "长边", title: "长边：把最长边缩放到指定长度。" },
  "像素": { icon: "像素", title: "像素：按总像素和画幅比例计算输出尺寸。" },
};
const FIT_BUTTONS = {
  "拉伸": { icon: "拉伸", title: "拉伸：直接变成目标尺寸。" },
  "补边": { icon: "补边", title: "补边：不裁剪原图，等比保留完整画面，只在目标宽高内补上边缘。" },
  "留边填充": { icon: "留边", title: "留边填充：等比缩放后补边；未接入遮罩时会输出补边遮罩。" },
  "裁剪填满": { icon: "裁剪", title: "裁剪填满：等比缩放后居中裁剪。" },
};
const POSITION_BUTTONS = {
  "上": { icon: "上", title: "上：补边/留边时贴上，裁剪时保留上方内容。" },
  "下": { icon: "下", title: "下：补边/留边时贴下，裁剪时保留下方内容。" },
  "左": { icon: "左", title: "左：补边/留边时贴左，裁剪时保留左侧内容。" },
  "右": { icon: "右", title: "右：补边/留边时贴右，裁剪时保留右侧内容。" },
  "中": { icon: "中", title: "中：居中补边、留边或裁剪。" },
};
const OUTPUTS = [
  { key: "original_size", icon: "📦", label: "📦 原始尺寸", outName: "原始尺寸", type: "*", title: "更多输出：原始尺寸 [宽度, 高度]。单击单选，Ctrl/Shift 可复选。" },
  { key: "output_width", icon: "↔️", label: "↔️ 输出宽度", outName: "输出宽度", type: "*", title: "更多输出：输出处理后的宽度。单击单选，Ctrl/Shift 可复选。" },
  { key: "output_height", icon: "↕️", label: "↕️ 输出高度", outName: "输出高度", type: "*", title: "更多输出：输出处理后的高度。单击单选，Ctrl/Shift 可复选。" },
  { key: "image_count", icon: "🔢", label: "数量", outName: "数量", type: "*", title: "更多输出：本次总共处理的图片数量。单击单选，Ctrl/Shift 可复选。" },
];


const PANEL_WIDGET_NAME = "gjj_multifunction_resize_panel";

const CONFIG_INPUT_RE = /(config_json|隐藏配置|前端面板写入|Internal JSON config)/i;

const PARAM_ALIASES = {
  target_width: ["target_width", "width", "custom_width", "output_width", "目标宽度", "宽度", "输出宽度"],
  target_height: ["target_height", "height", "custom_height", "output_height", "目标高度", "高度", "输出高度"],
  border_left: ["border_left", "left", "pad_left", "padding_left", "左", "左补边"],
  border_top: ["border_top", "top", "up", "pad_top", "padding_top", "上", "上补边"],
  border_right: ["border_right", "right", "pad_right", "padding_right", "右", "右补边"],
  border_bottom: ["border_bottom", "bottom", "down", "pad_bottom", "padding_bottom", "下", "下补边"],
  scale_percent: ["scale_percent", "scale", "percent", "缩放百分比", "百分比", "缩放"],
  long_side_length: ["long_side_length", "long_side", "longside", "长边长度", "长边"],
  total_pixel_k: ["total_pixel_k", "total_pixel", "total_pixels", "pixel", "pixels", "总像素K", "总像素", "像素"],
  aspect_ratio: ["aspect_ratio", "ratio", "输出比例", "画幅比例", "比例"],
};

function normalizeParamToken(value) {
  return String(value || "")
    .trim()
    .replace(/^converted-widget:/i, "")
    .replace(/^[^0-9A-Za-z\u4e00-\u9fff]+/g, "")
    .replace(/[^0-9A-Za-z\u4e00-\u9fff]+/g, "")
    .toLowerCase();
}

function paramAliasSet(def) {
  const aliases = [
    def?.name,
    def?.cfgKey,
    def?.label,
    ...(PARAM_ALIASES[def?.name] || []),
  ];
  return new Set(aliases.map(normalizeParamToken).filter(Boolean));
}

function getParamInputDef(name) {
  const token = normalizeParamToken(name);
  if (!token) return null;
  return PARAM_INPUTS.find((item) => paramAliasSet(item).has(token)) || null;
}

function getParamInputDefFromInput(input) {
  const values = [
    input?.name,
    input?.label,
    input?.localized_name,
    input?.display_name,
    input?.widget?.name,
    input?.widget?.label,
    input?.widget?.type,
    input?.widget?.options?.name,
    input?.widget?.options?.display_name,
  ];
  for (const value of values) {
    const def = getParamInputDef(value);
    if (def) return def;
  }
  return null;
}

function isParamInputName(name) {
  return !!getParamInputDef(name);
}

function findWidget(node, name) {
  const key = String(name || "");
  return (node?.widgets || []).find((widget) => {
    if (!widget) return false;
    return String(widget.name || "") === key
      || String(widget.options?.name || "") === key
      || String(widget.options?.display_name || "") === key
      || String(widget.label || "") === key
      || String(widget.localized_name || "") === key;
  }) || null;
}

function findInputSlot(node, name) {
  const def = getParamInputDef(name);
  if (!def) return (node?.inputs || []).find((input) => String(input?.name || "") === name) || null;
  return (node?.inputs || []).find((input) => getParamInputDefFromInput(input)?.name === def.name) || null;
}

function getGraphLinks(node) {
  const links = node?.graph?.links || app.graph?.links;
  if (!links) return [];
  return Array.isArray(links) ? links.filter(Boolean) : Object.values(links).filter(Boolean);
}

function getGraphLinkId(link) {
  return Array.isArray(link) ? link[0] : link?.id;
}

function getGraphLinkTargetId(link) {
  return Array.isArray(link) ? link[3] : link?.target_id;
}

function getGraphLinkTargetSlot(link) {
  return Array.isArray(link) ? link[4] : link?.target_slot;
}

function getGraphLink(node, linkId) {
  if (linkId == null) return null;
  const links = node?.graph?.links || app.graph?.links;
  if (!links) return null;
  if (!Array.isArray(links)) return links[linkId] || links[String(linkId)] || null;
  return links.find((link) => String(getGraphLinkId(link)) === String(linkId)) || null;
}

function findGraphLinkForInput(node, index) {
  if (!node || index == null || index < 0) return null;
  const nodeId = node.id;
  return getGraphLinks(node).find((link) => (
    String(getGraphLinkTargetId(link)) === String(nodeId)
    && Number(getGraphLinkTargetSlot(link)) === Number(index)
  )) || null;
}

function getInputLinkId(input, node = null, index = -1) {
  if (input?.link != null) return input.link;
  const link = node ? findGraphLinkForInput(node, index) : null;
  const linkId = getGraphLinkId(link);
  if (linkId != null && input) input.link = linkId;
  return linkId ?? null;
}

function inputHasRealLink(input, node = null, index = -1) {
  return getInputLinkId(input, node, index) != null;
}

function refreshInputLinksFromGraph(node) {
  if (!Array.isArray(node?.inputs)) return;
  for (let index = 0; index < node.inputs.length; index++) {
    getInputLinkId(node.inputs[index], node, index);
  }
}

function setInputLinkSlot(link, nodeId, slot, type) {
  if (!link) return;
  if (Array.isArray(link)) {
    link[3] = nodeId;
    link[4] = slot;
    if (type) link[5] = type;
    return;
  }
  link.target_id = nodeId;
  link.target_slot = slot;
  if (type) link.type = type;
}

function repairInputLinkSlots(node) {
  if (!Array.isArray(node?.inputs)) return;
  refreshInputLinksFromGraph(node);
  for (let index = 0; index < node.inputs.length; index++) {
    const input = node.inputs[index];
    const linkId = getInputLinkId(input, node, index);
    if (linkId == null) continue;
    setInputLinkSlot(getGraphLink(node, linkId), node.id, index, input.type);
  }
}

function getSerializedParamLinks(node) {
  const stored = Array.isArray(node?.__gjjMfSerializedParamLinks) ? node.__gjjMfSerializedParamLinks : [];
  const props = Array.isArray(node?.properties?.[PARAM_LINKS_PROPERTY]) ? node.properties[PARAM_LINKS_PROPERTY] : [];
  const byName = new Map();
  for (const item of [...props, ...stored]) {
    const def = getParamInputDef(item?.name);
    const link = item?.link;
    if (!def || link == null) continue;
    byName.set(def.name, { name: def.name, link });
  }
  return [...byName.values()];
}

function getSerializedLinkedParamNames(node) {
  return new Set(getSerializedParamLinks(node).map((item) => item.name));
}

function rememberSerializedParamLinks(node, data = {}) {
  node.properties ||= {};
  const links = [];
  for (const input of (data?.inputs || data?.inputs_values || [])) {
    const def = getParamInputDefFromInput(input);
    const link = input?.link;
    if (def && link != null) links.push({ name: def.name, link });
  }
  const propLinks = Array.isArray(data?.properties?.[PARAM_LINKS_PROPERTY]) ? data.properties[PARAM_LINKS_PROPERTY] : [];
  for (const item of propLinks) {
    const def = getParamInputDef(item?.name);
    if (def && item?.link != null && !links.some((x) => x.name === def.name)) {
      links.push({ name: def.name, link: item.link });
    }
  }
  node.__gjjMfSerializedParamLinks = links;
  if (links.length) node.properties[PARAM_LINKS_PROPERTY] = links;
}

function saveCurrentParamLinks(node, data = null) {
  node.properties ||= {};
  const links = [];
  if (Array.isArray(node?.inputs)) {
    for (let index = 0; index < node.inputs.length; index++) {
      const input = node.inputs[index];
      const def = getParamInputDefFromInput(input);
      const link = getInputLinkId(input, node, index);
      if (def && link != null) links.push({ name: def.name, link });
    }
  }
  node.__gjjMfSerializedParamLinks = links;
  node.properties[PARAM_LINKS_PROPERTY] = links;
  if (data) {
    data.properties ||= {};
    data.properties[PARAM_LINKS_PROPERTY] = links;
  }
  return links;
}

function repairSerializedParamLinks(node) {
  if (!Array.isArray(node?.inputs)) return;
  for (const item of getSerializedParamLinks(node)) {
    const def = getParamInputDef(item.name);
    if (!def || item.link == null) continue;
    const slot = node.inputs.findIndex((input) => getParamInputDefFromInput(input)?.name === def.name);
    if (slot < 0) continue;
    node.inputs[slot].link = item.link;
    setInputLinkSlot(getGraphLink(node, item.link), node.id, slot, node.inputs[slot].type);
  }
  repairInputLinkSlots(node);
}

function setWidgetVisible(widget, visible) {
  if (!widget) return;
  if (!widget.__gjjMfNativeSaved) {
    widget.__gjjMfNativeSaved = {
      type: widget.type,
      computeSize: widget.computeSize,
      getHeight: widget.getHeight,
      draw: widget.draw,
      mouse: widget.mouse,
      label: widget.label,
      size: Array.isArray(widget.size) ? [...widget.size] : widget.size,
    };
  }
  if (visible) {
    const saved = widget.__gjjMfNativeSaved || {};
    widget.hidden = false;
    widget.disabled = false;
    if (saved.type !== undefined) widget.type = String(saved.type || "").startsWith("converted-widget:") ? "number" : saved.type;
    if (saved.computeSize !== undefined) widget.computeSize = saved.computeSize;
    else delete widget.computeSize;
    if (saved.getHeight !== undefined) widget.getHeight = saved.getHeight;
    else delete widget.getHeight;
    if (saved.draw !== undefined) widget.draw = saved.draw;
    else delete widget.draw;
    if (saved.mouse !== undefined) widget.mouse = saved.mouse;
    else delete widget.mouse;
    if (saved.label !== undefined) widget.label = saved.label;
    if (saved.size !== undefined) widget.size = Array.isArray(saved.size) ? [...saved.size] : saved.size;
    widget.computedHeight = undefined;
    widget.margin_top = undefined;
    if (widget.options && typeof widget.options === "object") {
      widget.options.hidden = false;
      delete widget.options.display;
    }
    for (const el of [widget.inputEl, widget.element, widget.widget]) {
      if (!el?.style) continue;
      el.style.display = "";
      el.style.height = "";
      el.style.minHeight = "";
      el.style.margin = "";
      el.style.padding = "";
      el.style.border = "";
      el.style.overflow = "";
    }
    return;
  }
  widget.hidden = true;
  widget.disabled = true;
  if (widget.options && typeof widget.options === "object") {
    widget.options.hidden = true;
    widget.options.display = "hidden";
  }
  widget.type = `converted-widget:${widget.name || "hidden"}`;
  widget.computeSize = () => [0, 0];
  widget.getHeight = () => 0;
  widget.draw = () => {};
  widget.mouse = () => false;
  widget.label = "";
  widget.size = [0, 0];
  widget.last_y = 0;
  widget.computedHeight = 0;
  widget.margin_top = 0;
  for (const el of [widget.inputEl, widget.element, widget.widget]) {
    if (!el?.style) continue;
    el.style.display = "none";
    el.style.height = "0";
    el.style.minHeight = "0";
    el.style.margin = "0";
    el.style.padding = "0";
    el.style.border = "0";
    el.style.overflow = "hidden";
  }
}

function createNativeParamWidget(node, def, cfg = readConfig(node)) {
  if (!node || typeof node.addWidget !== "function") return null;
  const value = cfg[def.cfgKey] ?? def.defaultValue;
  const callback = (nextValue) => {
    const next = def.type === "STRING" ? String(nextValue ?? "") : Number(nextValue);
    writeConfig(node, { [def.cfgKey]: next });
    redraw(node);
  };
  const options = {
    min: def.min,
    max: def.max,
    step: def.step,
    values: def.values,
    display_name: def.label,
    tooltip: `${def.label}：可手填，也可连接外部 ${def.type}。`,
    hidden: true,
    display: "hidden",
  };
  let widget = null;
  try {
    widget = node.addWidget(def.widgetType || "number", def.name, value, callback, options);
  } catch (_) {
    try { widget = node.addWidget("number", def.name, value, callback, options); } catch (_) {}
  }
  if (widget) {
    widget.name = def.name;
    widget.label = def.label;
    widget.localized_name = def.label;
    widget.options ||= {};
    Object.assign(widget.options, options);
  }
  return widget;
}
function setupNativeParamWidget(node, def) {
  const cfg = readConfig(node);
  const widget = findWidget(node, def.name) || createNativeParamWidget(node, def, cfg);
  if (!widget) return null;
  widget.name = def.name;
  widget.label = def.label;
  widget.localized_name = def.label;
  widget.options ||= {};
  widget.options.display_name = def.label;
  widget.options.tooltip = `${def.label}：可手填，也可连接外部 ${def.type}。`;
  widget.callback = (value) => {
    const next = def.type === "STRING" ? String(value ?? "") : Number(value);
    writeConfig(node, { [def.cfgKey]: next });
    redraw(node);
  };
  if (def.type === "STRING") {
    const next = String(cfg[def.cfgKey] ?? "");
    if (widget.value !== next) widget.value = next;
  } else if (Number.isFinite(Number(cfg[def.cfgKey])) && widget.value !== Number(cfg[def.cfgKey])) {
    widget.value = Number(cfg[def.cfgKey]);
  }
  return widget;
}

function isParamDefActive(def, cfg) {
  if (!def) return false;
  if (def.mode !== cfg.mode) return false;
  if (def.fitMode && normalizeFitMode(def.fitMode) !== normalizeFitMode(cfg.fit_mode)) return false;
  if (def.excludeFitMode && normalizeFitMode(def.excludeFitMode) === normalizeFitMode(cfg.fit_mode)) return false;
  return true;
}

function ensureNativeParamInputSlot(node, def) {
  let input = findInputSlot(node, def.name);
  if (!input) {
    try { node.addInput?.(def.name, def.type); } catch (_) {}
    input = findInputSlot(node, def.name);
  }
  if (!input) return null;
  input.name = def.name;
  input.type = def.type;
  input.label = def.label;
  input.localized_name = def.label;
  input.tooltip = `${def.label}：连接外部 ${def.type} 后会覆盖当前控件值。`;
  delete input.widget;
  return input;
}

function reorderNativeParamInputs(node, visibleDefs) {
  if (!Array.isArray(node?.inputs)) return;
  repairSerializedParamLinks(node);
  refreshInputLinksFromGraph(node);
  const visibleNames = new Set((visibleDefs || []).map((def) => def.name));
  const used = new Set();
  const fixed = [];
  for (const input of node.inputs) {
    if (!getParamInputDefFromInput(input)) fixed.push(input);
  }
  const orderedParams = [];
  const linkedExtras = [];
  for (const def of PARAM_INPUTS) {
    if (!visibleNames.has(def.name)) continue;
    const matches = node.inputs.filter((input) => !used.has(input) && getParamInputDefFromInput(input)?.name === def.name);
    const picked = matches.find((input) => inputHasRealLink(input, node, node.inputs.indexOf(input))) || matches[0];
    if (!picked) continue;
    orderedParams.push(picked);
    used.add(picked);
    for (const input of matches) {
      if (input === picked || used.has(input)) continue;
      if (inputHasRealLink(input, node, node.inputs.indexOf(input))) {
        linkedExtras.push(input);
        used.add(input);
      }
    }
  }
  const extras = node.inputs.filter((input) => !fixed.includes(input) && !used.has(input));
  const next = [...fixed, ...orderedParams, ...linkedExtras, ...extras];
  if (next.length !== node.inputs.length) return;
  let changed = false;
  for (let index = 0; index < next.length; index++) {
    if (next[index] !== node.inputs[index]) {
      changed = true;
      break;
    }
  }
  if (changed) node.inputs = next;
  repairInputLinkSlots(node);
  repairSerializedParamLinks(node);
}

function ensureNativeParamWidgets(node) {
  if (!node) return;
  repairSerializedParamLinks(node);
  repairInputLinkSlots(node);
  const cfg = readConfig(node);
  const linkedParamNames = new Set((node.inputs || [])
    .filter((input, index) => inputHasRealLink(input, node, index))
    .map((input) => getParamInputDefFromInput(input)?.name)
    .filter(Boolean));
  for (const name of getSerializedLinkedParamNames(node)) linkedParamNames.add(name);
  const visibleDefs = PARAM_INPUTS.filter((def) => isParamDefActive(def, cfg) || linkedParamNames.has(def.name));
  const widgetsByName = new Map();
  for (const def of PARAM_INPUTS) {
    const widget = setupNativeParamWidget(node, def);
    widgetsByName.set(def.name, widget);
    setWidgetVisible(widget, false);
  }

  const panelIndex = node.widgets?.indexOf(node.__gjjMfDomWidget) ?? -1;
  if (panelIndex >= 0) {
    for (const def of PARAM_INPUTS) {
      const widget = widgetsByName.get(def.name);
      if (!widget) continue;
      const current = node.widgets.indexOf(widget);
      if (current >= 0) node.widgets.splice(current, 1);
    }
    let insertAt = node.widgets.indexOf(node.__gjjMfDomWidget) + 1;
    for (const def of visibleDefs) {
      const widget = widgetsByName.get(def.name);
      if (widget) node.widgets.splice(insertAt++, 0, widget);
    }
  }

  for (const def of visibleDefs) ensureNativeParamInputSlot(node, def);
  reorderNativeParamInputs(node, visibleDefs);
  repairSerializedParamLinks(node);
  saveCurrentParamLinks(node);
  moveTailWidgetAfterParams(node);
}

function syncNativeParamInputSlots(node) {
  const cfg = readConfig(node);
  if (!Array.isArray(node?.inputs)) return;
  repairSerializedParamLinks(node);
  repairInputLinkSlots(node);
  const serializedLinked = getSerializedLinkedParamNames(node);
  for (let i = node.inputs.length - 1; i >= 0; i--) {
    const input = node.inputs[i];
    const def = getParamInputDefFromInput(input);
    if (!def || isParamDefActive(def, cfg)) continue;
    if (inputHasRealLink(input, node, i) || serializedLinked.has(def.name)) {
      input.name = def.name;
      input.type = def.type;
      input.label = def.label;
      input.localized_name = def.label;
      input.tooltip = `${def.label}：当前已有外部连接，刷新时会保留此接口。`;
      delete input.widget;
      continue;
    }
    node.inputs.splice(i, 1);
  }
  repairSerializedParamLinks(node);
  repairInputLinkSlots(node);
  saveCurrentParamLinks(node);
}

function isConfigInputSlot(input) {
  if (!input) return false;
  const text = [input.name, input.label, input.localized_name, input.type, input.tooltip].filter(Boolean).join(" ");
  return CONFIG_INPUT_RE.test(text);
}

function removeConfigInputSlots(node) {
  if (!node?.inputs?.length) return;
  let removed = false;
  for (let i = node.inputs.length - 1; i >= 0; i--) {
    if (!isConfigInputSlot(node.inputs[i])) continue;
    node.inputs.splice(i, 1);
    removed = true;
  }
  if (removed) {
    repairInputLinkSlots(node);
    try { node.setDirtyCanvas?.(true, true); } catch (_) {}
    try { node.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
  }
}

function moveConfigWidgetToEnd(node) {
  if (!node?.widgets?.length) return;
  const idx = node.widgets.findIndex((w) => w?.name === CONFIG_WIDGET);
  if (idx >= 0 && idx !== node.widgets.length - 1) {
    const [w] = node.widgets.splice(idx, 1);
    node.widgets.push(w);
  }
}

function isResizeParamWidget(widget) {
  const name = String(widget?.name || "");
  return PARAM_INPUTS.some((def) => def.name === name);
}

function moveTailWidgetAfterParams(node) {
  const tail = node?.__gjjMfTailWidget;
  if (!tail || !node?.widgets?.includes(tail)) return;
  const current = node.widgets.indexOf(tail);
  if (current >= 0) node.widgets.splice(current, 1);
  const panelIndex = node.widgets.indexOf(node.__gjjMfDomWidget);
  let insertAt = panelIndex >= 0 ? panelIndex + 1 : node.widgets.length;
  for (let i = insertAt; i < node.widgets.length; i++) {
    const widget = node.widgets[i];
    if (widget?.name === CONFIG_WIDGET) break;
    if (isResizeParamWidget(widget) && !widget.hidden) insertAt = i + 1;
  }
  node.widgets.splice(insertAt, 0, tail);
}

const LEGACY_WIDGET_NAMES = new Set([
  LEGACY_RATIO_WIDGET_NAME,
  "gjj_multifunction_resize_panel",
  "gjj_resize_status",
  "gjj_status_bar",
  "gjj_progress_bar",
  "gjj_multifunction_resize_status",
  "gjj_multifunction_resize_progress",
  "状态栏",
  "进度条",
]);

function removeWidgetByObject(node, widget) {
  if (!node?.widgets || !widget) return;
  const idx = node.widgets.indexOf(widget);
  if (idx >= 0) node.widgets.splice(idx, 1);
  try { widget.element?.remove?.(); } catch (_) {}
  try { widget.inputEl?.remove?.(); } catch (_) {}
  try { widget.widget?.remove?.(); } catch (_) {}
}

function purgeLegacyStatusAndPanels(node, keepWidget = null) {
  removeConfigInputSlots(node);
  if (!node?.widgets) return;
  const widgets = [...node.widgets];
  for (const w of widgets) {
    if (!w || w === keepWidget || w.name === CONFIG_WIDGET) continue;
    const name = String(w.name || "");
    const type = String(w.type || "");
    const isLegacyName = LEGACY_WIDGET_NAMES.has(name) || /gjj.*(status|progress|resize_panel|multifunction_resize_panel)/i.test(name);
    const isLegacyDom = type.toLowerCase() === "dom" && w.element?.classList?.contains?.("gjj-mf-root");
    if (isLegacyName || isLegacyDom) removeWidgetByObject(node, w);
  }
}

function visibleElementHeight(element) {
  if (!element?.style) return 0;
  try {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return 0;
    const rect = element.getBoundingClientRect?.();
    const base = Math.max(Number(rect?.height) || 0, Number(element.scrollHeight) || 0);
    const marginTop = Number.parseFloat(style.marginTop || "0") || 0;
    const marginBottom = Number.parseFloat(style.marginBottom || "0") || 0;
    return Math.ceil(base + marginTop + marginBottom);
  } catch (_) {
    return Math.ceil(Number(element.scrollHeight) || Number(element.offsetHeight) || 0);
  }
}

function measurePanelHeight(root) {
  if (!root) return 1;
  let height = 0;
  let visibleCount = 0;
  for (const child of root.children || []) {
    const childHeight = visibleElementHeight(child);
    if (childHeight <= 0) continue;
    visibleCount += 1;
    height += childHeight;
  }
  try {
    const style = getComputedStyle(root);
    height += (Number.parseFloat(style.paddingTop || "0") || 0) + (Number.parseFloat(style.paddingBottom || "0") || 0);
    const gap = Number.parseFloat(style.rowGap || style.gap || "0") || 0;
    if (visibleCount > 1) height += gap * (visibleCount - 1);
  } catch (_) {}
  return Math.max(1, Math.ceil(height));
}

function measureTailHeight(root) {
  if (!root) return 0;
  let height = 0;
  let visibleCount = 0;
  for (const child of root.children || []) {
    const childHeight = visibleElementHeight(child);
    if (childHeight <= 0) continue;
    visibleCount += 1;
    height += childHeight;
  }
  if (visibleCount <= 0) return 0;
  try {
    const style = getComputedStyle(root);
    height += (Number.parseFloat(style.paddingTop || "0") || 0) + (Number.parseFloat(style.paddingBottom || "0") || 0);
    const gap = Number.parseFloat(style.rowGap || style.gap || "0") || 0;
    if (visibleCount > 1) height += gap * (visibleCount - 1);
  } catch (_) {}
  return Math.max(0, Math.ceil(height));
}

const OPTIONS = {
  fit_mode: ["拉伸", "补边", "留边填充", "裁剪填满"],
  crop_position: ["上", "下", "左", "右", "中"],
  upscale_method: ["兰索斯", "双三次", "双线性", "区域", "最近邻"],
  round_to_multiple: ["1", "2", "4", "8", "16", "32", "64", "128", "256", "512"],
  device: ["CPU", "GPU"],
  aspect_ratio: ["原始比例", "自定义", "1:1", "3:2", "4:3", "16:9", "2:3", "3:4", "9:16"],
};

function normalizeFitMode(value) {
  const text = String(value || "留边填充").trim();
  if (["补边", "add_border", "border", "border_pad", "pad_only"].includes(text)) return "补边";
  if (["留边", "留边填充", "letterbox", "pad", "padding"].includes(text)) return "留边填充";
  if (["裁剪", "裁剪填满", "crop"].includes(text)) return "裁剪填满";
  if (["拉伸", "stretch"].includes(text)) return "拉伸";
  return "留边填充";
}

function ensureStyles() {
  if (document.getElementById("gjj-mf-resize-style-v42")) return;
  const style = document.createElement("style");
  style.id = "gjj-mf-resize-style-v42";
  style.textContent = `
.gjj-mf-root{box-sizing:border-box;width:100%;padding:4px 0 7px 0;font-family:system-ui,"Microsoft YaHei",sans-serif;color:#dbeafe;pointer-events:auto;user-select:none;}
.gjj-mf-tail-root{box-sizing:border-box;width:100%;padding:0 0 7px 0;font-family:system-ui,"Microsoft YaHei",sans-serif;color:#dbeafe;pointer-events:auto;user-select:none;}
.gjj-mf-output-row{display:flex;align-items:center;gap:5px;margin:0 0 6px 0;min-width:0;}
.gjj-mf-mini-label{flex:0 0 auto;color:#93c5fd;font-size:11px;white-space:nowrap;}
.gjj-mf-panel{display:flex;flex-direction:column;gap:7px;}
.gjj-mf-button-row{display:flex;gap:6px;min-width:0;flex:1;}
.gjj-mf-choice{flex:1;min-width:0;height:28px;border:1px solid rgba(148,163,184,.36);background:rgba(15,23,42,.55);color:#dbeafe;border-radius:8px;padding:0 6px;font-size:15px;font-weight:700;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;}
.gjj-mf-choice:hover{border-color:rgba(34,211,238,.72);color:#fff;background:rgba(8,145,178,.2);}
.gjj-mf-choice.active{border-color:#22d3ee;color:#fff;background:rgba(14,165,233,.38);box-shadow:0 0 0 1px rgba(34,211,238,.22) inset;}
.gjj-mf-output-btn{flex:1 1 28px;}
.gjj-mf-settings-btn{flex:0 0 auto;height:28px;border:1px solid rgba(148,163,184,.38);background:rgba(15,23,42,.6);color:#dbeafe;border-radius:8px;padding:0 8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;}
.gjj-mf-settings-btn.active{border-color:#22d3ee;color:#fff;background:rgba(14,165,233,.33);}
.gjj-mf-field{display:flex;align-items:center;gap:7px;min-height:28px;}
.gjj-mf-label{width:82px;min-width:82px;color:#cbd5e1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gjj-mf-icon-label{width:24px;min-width:24px;text-align:center;font-size:15px;}
.gjj-mf-control{flex:1;min-width:0;height:28px;border:1px solid rgba(148,163,184,.28);background:rgba(17,24,39,.82);color:#fff;border-radius:8px;padding:0 8px;font-size:12px;outline:none;box-sizing:border-box;}
.gjj-mf-control:focus{border-color:#22d3ee;box-shadow:0 0 0 1px rgba(34,211,238,.25);}
.gjj-mf-control[type="color"]{padding:2px 5px;min-width:60px;}
.gjj-mf-range{flex:1;min-width:64px;height:18px;accent-color:#22d3ee;cursor:pointer;}
.gjj-mf-number{flex:0 0 66px;min-width:66px;text-align:center;}
.gjj-mf-section{margin-top:2px;padding-top:5px;border-top:1px solid rgba(148,163,184,.16);}
.gjj-mf-status{display:none;margin-top:8px;border:1px solid rgba(34,211,238,.34);border-radius:9px;background:rgba(2,6,23,.45);padding:6px 7px;color:#e0f2fe;font-size:12px;}
.gjj-mf-status.show{display:block;}
.gjj-mf-status.done{border-color:rgba(34,197,94,.72);color:#dcfce7;background:rgba(20,83,45,.22);}
.gjj-mf-status.error{border-color:rgba(248,113,113,.86);color:#fee2e2;background:rgba(127,29,29,.25);}
.gjj-mf-bar{display:none;height:5px;margin-top:5px;border-radius:999px;background:rgba(148,163,184,.25);overflow:hidden;}
.gjj-mf-status.running .gjj-mf-bar{display:block;}
.gjj-mf-fill{height:100%;width:35%;border-radius:999px;background:#22d3ee;animation:gjjMfRun 1.1s ease-in-out infinite alternate;}
.gjj-mf-preview{display:none;margin-top:8px;border:1px solid rgba(34,211,238,.28);border-radius:9px;background:rgba(2,6,23,.42);padding:7px;overflow:hidden;}
.gjj-mf-preview.show{display:block;}
.gjj-mf-preview-frame{width:100%;height:150px;display:flex;align-items:center;justify-content:center;border-radius:7px;background:rgba(15,23,42,.62);overflow:hidden;}
.gjj-mf-preview-frame img{max-width:100%;max-height:100%;object-fit:contain;display:block;}
.gjj-mf-preview-meta{margin-top:5px;text-align:center;color:#d8f3f7;font-size:11px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
@keyframes gjjMfRun{from{transform:translateX(-90%)}to{transform:translateX(255%)}}
`;
  document.head.appendChild(style);
}

function stop(e) {
  e.stopPropagation();
}

function readConfig(node) {
  let cfg = { ...DEFAULT_CONFIG };
  const w = node.widgets?.find((x) => x?.name === CONFIG_WIDGET);
  try {
    if (w?.value) {
      const parsed = JSON.parse(String(w.value));
      if (parsed && typeof parsed === "object") cfg = { ...cfg, ...parsed };
    }
  } catch (_) {}
  node.properties ||= {};
  if (node.properties.gjj_mf_resize_config && typeof node.properties.gjj_mf_resize_config === "object") {
    cfg = { ...cfg, ...node.properties.gjj_mf_resize_config };
  }
  if (!MODES.includes(cfg.mode)) cfg.mode = "等比";
  cfg.fit_mode = normalizeFitMode(cfg.fit_mode);
  if (cfg.fit_mode === "补边") cfg.mode = "宽高";
  if (!OPTIONS.crop_position.includes(cfg.crop_position)) cfg.crop_position = "中";
  if (!Array.isArray(cfg.extra_outputs)) cfg.extra_outputs = [];
  cfg.show_settings = !!cfg.show_settings;
  cfg.border_left = Math.max(0, Number(cfg.border_left) || 0);
  cfg.border_top = Math.max(0, Number(cfg.border_top) || 0);
  cfg.border_right = Math.max(0, Number(cfg.border_right) || 0);
  cfg.border_bottom = Math.max(0, Number(cfg.border_bottom) || 0);
  cfg.source_width = Math.max(0, Number(cfg.source_width) || 0);
  cfg.source_height = Math.max(0, Number(cfg.source_height) || 0);
  return cfg;
}

function writeConfig(node, patch = {}) {
  const cfg = { ...readConfig(node), ...patch };
  if (!MODES.includes(cfg.mode)) cfg.mode = "等比";
  cfg.fit_mode = normalizeFitMode(cfg.fit_mode);
  if (cfg.fit_mode === "补边") cfg.mode = "宽高";
  if (!OPTIONS.crop_position.includes(cfg.crop_position)) cfg.crop_position = "中";
  if (!Array.isArray(cfg.extra_outputs)) cfg.extra_outputs = [];
  cfg.show_settings = !!cfg.show_settings;
  cfg.border_left = Math.max(0, Number(cfg.border_left) || 0);
  cfg.border_top = Math.max(0, Number(cfg.border_top) || 0);
  cfg.border_right = Math.max(0, Number(cfg.border_right) || 0);
  cfg.border_bottom = Math.max(0, Number(cfg.border_bottom) || 0);
  cfg.source_width = Math.max(0, Number(cfg.source_width) || 0);
  cfg.source_height = Math.max(0, Number(cfg.source_height) || 0);
  node.properties ||= {};
  node.properties.gjj_mf_resize_config = cfg;
  const text = JSON.stringify(cfg);
  const w = node.widgets?.find((x) => x?.name === CONFIG_WIDGET);
  if (w) {
    w.value = text;
    try { w.callback?.(text, app.canvas, node, app.canvas?.graph_mouse, {}); } catch (_) {}
  }
  return cfg;
}

function getShowSettings(node) {
  const cfg = readConfig(node);
  node.__gjjMfShowSettings = !!cfg.show_settings;
  return node.__gjjMfShowSettings;
}

function setShowSettings(node, value) {
  node.__gjjMfShowSettings = !!value;
  return writeConfig(node, { show_settings: node.__gjjMfShowSettings });
}

function hideWidgetCompletely(widget) {
  if (!widget) return;
  if (!widget.__gjjMfSaved) {
    widget.__gjjMfSaved = true;
    widget.__gjjMfOriginal = {
      type: widget.type,
      computeSize: widget.computeSize,
      getHeight: widget.getHeight,
      draw: widget.draw,
      mouse: widget.mouse,
      label: widget.label,
      size: Array.isArray(widget.size) ? [...widget.size] : widget.size,
      last_y: widget.last_y,
      computedHeight: widget.computedHeight,
      margin_top: widget.margin_top,
    };
  }
  widget.type = "hidden";
  widget.hidden = true;
  widget.disabled = true;
  if (widget.options && typeof widget.options === "object") {
    widget.options.hidden = true;
    widget.options.display = "hidden";
  }
  widget.serialize = true;
  widget.computeSize = () => [0, 0];
  widget.getHeight = () => 0;
  widget.draw = () => {};
  widget.mouse = () => false;
  widget.label = "";
  widget.size = [0, 0];
  widget.last_y = 0;
  widget.computedHeight = 0;
  widget.margin_top = 0;
  for (const el of [widget.inputEl, widget.element, widget.widget]) {
    if (!el?.style) continue;
    el.style.display = "none";
    el.style.height = "0";
    el.style.minHeight = "0";
    el.style.margin = "0";
    el.style.padding = "0";
    el.style.border = "0";
    el.style.overflow = "hidden";
  }
}

function outputHasLinks(output) {
  if (!output) return false;
  if (Array.isArray(output.links)) return output.links.length > 0;
  return output.link != null;
}

function keyFromOutputName(name) {
  const text = String(name || "").trim();
  const found = OUTPUTS.find((x) => x.outName === text || x.label === text || x.key === text);
  return found?.key || null;
}

function collectOutputKeysFromSlots(outputs, { linkedOnly = false } = {}) {
  const keys = [];
  for (const output of (outputs || []).slice(2)) {
    if (linkedOnly && !outputHasLinks(output)) continue;
    const key = keyFromOutputName(output?.name || output?.label || output?.localized_name);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys.slice(0, 3);
}

function rememberSerializedOutputKeys(node, data) {
  const keys = collectOutputKeysFromSlots(data?.outputs || data?.outputs_values || [], { linkedOnly: false });
  if (keys.length) node.__gjjMfSerializedExtraOutputs = keys;
}

function repairConfigFromOutputs(node, cfg = readConfig(node), { restoreFromSlots = true } = {}) {
  const selected = Array.isArray(cfg.extra_outputs) ? [...cfg.extra_outputs] : [];
  if (!restoreFromSlots) {
    const next = selected.filter((key) => OUTPUTS.some((x) => x.key === key)).slice(0, 3);
    if (next.join("|") !== selected.join("|")) {
      cfg = writeConfig(node, { extra_outputs: next });
    }
    return cfg;
  }

  const serialized = Array.isArray(node.__gjjMfSerializedExtraOutputs) ? node.__gjjMfSerializedExtraOutputs : [];
  const linked = collectOutputKeysFromSlots(node.outputs, { linkedOnly: true });
  const named = collectOutputKeysFromSlots(node.outputs, { linkedOnly: false });
  const merged = [...selected];

  // 载入工作流时，先按序列化输出名/已有连线恢复按钮状态，避免初始化阶段误删输出槽导致断线。
  for (const key of [...serialized, ...linked, ...(selected.length ? [] : named)]) {
    if (key && !merged.includes(key)) merged.push(key);
  }

  const next = merged.filter((key) => OUTPUTS.some((x) => x.key === key)).slice(0, 3);
  if (next.join("|") !== selected.join("|")) {
    cfg = writeConfig(node, { extra_outputs: next });
  }
  return cfg;
}

function applyOutputSlot(output, def) {
  if (!output || !def) return;
  output.name = def.outName;
  output.label = def.outName;
  output.localized_name = def.outName;
  output.type = def.type;
  output.tooltip = def.title;
}

function updateOutputs(node, { fromUser = false } = {}) {
  if (!node.outputs) return;
  const cfg = repairConfigFromOutputs(node, readConfig(node), { restoreFromSlots: !fromUser });
  const selected = cfg.extra_outputs.slice(0, 3).filter((key) => OUTPUTS.some((x) => x.key === key));

  if (fromUser) {
    for (let i = node.outputs.length - 1; i >= 2; i--) {
      try { node.removeOutput(i); } catch (_) { node.outputs.splice(i, 1); }
    }
  }

  // 只收缩未使用的尾部输出；已有连线的槽位不硬删，先通过 repairConfigFromOutputs 并入 selected。
  for (let i = node.outputs.length - 1; i >= 2; i--) {
    if (i < 2 + selected.length) continue;
    if (!fromUser && outputHasLinks(node.outputs[i])) continue;
    try { node.removeOutput(i); } catch (_) { node.outputs.splice(i, 1); }
  }

  for (let i = 0; i < selected.length; i++) {
    const def = OUTPUTS.find((x) => x.key === selected[i]);
    const slot = 2 + i;
    if (!node.outputs[slot]) {
      node.addOutput(def.outName, def.type);
    } else {
      applyOutputSlot(node.outputs[slot], def);
    }
  }

  // 如果仍有多余的未连接输出，继续清掉；连接中的保留，避免刷新瞬间断线。
  for (let i = node.outputs.length - 1; i >= 2 + selected.length; i--) {
    if (!fromUser && outputHasLinks(node.outputs[i])) continue;
    try { node.removeOutput(i); } catch (_) { node.outputs.splice(i, 1); }
  }

  writeConfig(node, { extra_outputs: selected });
}

function redraw(node) {
  requestAnimationFrame(() => {
    try {
      const minW = 260;
      if (node.size) node.size[0] = Math.max(node.size[0], minW);
      if (node.__gjjMfDomWidget?.element) {
        const h = measurePanelHeight(node.__gjjMfDomWidget.element);
        node.__gjjMfDomWidget.computedHeight = h + 6;
        node.__gjjMfDomWidget.last_y = 0;
      }
      if (node.__gjjMfTailWidget?.element) {
        const h = measureTailHeight(node.__gjjMfTailWidget.element);
        node.__gjjMfTailWidget.computedHeight = h > 0 ? h + 6 : 0;
        node.__gjjMfTailWidget.last_y = 0;
      }
      const computed = node.computeSize?.();
      const nextHeight = Math.ceil(Number(computed?.[1]) || 0);
      if (node.size && nextHeight > 0 && Math.abs(Number(node.size[1]) - nextHeight) > 2) {
        node.size[1] = nextHeight;
      }
    } catch (_) {}
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
  });
}

function numberField(root, node, cfg, key, label, title, opts = {}) {
  const row = document.createElement("label");
  row.className = "gjj-mf-field";
  if (PARAM_INPUTS.some((def) => def.cfgKey === key)) row.dataset.gjjParamInput = key;
  row.title = title;
  const span = document.createElement("span");
  span.className = "gjj-mf-label";
  span.textContent = label;
  const range = document.createElement("input");
  range.className = "gjj-mf-range";
  range.type = "range";
  const valueMin = Number(opts.min ?? 0);
  const valueMax = Number(opts.max ?? 1000000);
  const sliderMax = Math.max(valueMin, Number(opts.sliderMax ?? opts.max ?? 1000000));
  range.min = String(valueMin);
  range.max = String(sliderMax);
  range.step = String(opts.step ?? 1);
  const input = document.createElement("input");
  input.className = "gjj-mf-control gjj-mf-number";
  input.type = "number";
  input.min = String(valueMin);
  input.max = String(valueMax);
  input.step = range.step;
  const normalize = (value) => {
    let next = Number(value);
    if (!Number.isFinite(next)) next = Number(opts.defaultValue ?? cfg[key] ?? 0);
    next = Math.max(valueMin, Math.min(valueMax, next));
    if (opts.type === "INT") next = Math.round(next);
    return next;
  };
  const syncRange = (value) => {
    range.value = String(Math.max(valueMin, Math.min(sliderMax, Number(value) || valueMin)));
  };
  const setValue = (value, { redrawNow = false } = {}) => {
    const next = normalize(value);
    syncRange(next);
    input.value = String(next);
    writeConfig(node, { [key]: next });
    const def = PARAM_INPUTS.find((item) => item.cfgKey === key);
    const widget = def ? findWidget(node, def.name) : null;
    if (widget) widget.value = next;
    if (redrawNow) redraw(node);
  };
  setValue(cfg[key], { redrawNow: false });
  range.addEventListener("input", (e) => {
    stop(e);
    setValue(range.value);
  });
  input.addEventListener("input", (e) => {
    stop(e);
    setValue(input.value);
  });
  range.addEventListener("change", (e) => { stop(e); setValue(range.value, { redrawNow: true }); });
  input.addEventListener("change", (e) => { stop(e); setValue(input.value, { redrawNow: true }); });
  for (const ev of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "keydown", "keyup", "wheel"]) {
    input.addEventListener(ev, stop);
    range.addEventListener(ev, stop);
  }
  row.append(span, range, input);
  root.appendChild(row);
}

function selectField(root, node, cfg, key, label, title, values) {
  const row = document.createElement("label");
  row.className = "gjj-mf-field";
  row.title = title;
  const span = document.createElement("span");
  span.className = "gjj-mf-label";
  span.textContent = label;
  const select = document.createElement("select");
  select.className = "gjj-mf-control";
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  }
  select.value = cfg[key];
  select.addEventListener("change", (e) => {
    stop(e);
    writeConfig(node, { [key]: select.value });
    buildPanel(node);
  });
  for (const ev of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "keydown", "keyup", "wheel"]) select.addEventListener(ev, stop);
  row.append(span, select);
  root.appendChild(row);
}

function choiceField(root, node, cfg, key, label, title, values) {
  const row = document.createElement("div");
  row.className = "gjj-mf-field";
  row.title = title;
  const span = document.createElement("span");
  span.className = "gjj-mf-label gjj-mf-icon-label";
  span.textContent = label;
  const group = document.createElement("div");
  group.className = "gjj-mf-button-row";
  for (const v of values) {
    const meta = key === "fit_mode" ? FIT_BUTTONS[v] : key === "mode" ? MODE_BUTTONS[v] : key === "crop_position" ? POSITION_BUTTONS[v] : null;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gjj-mf-choice";
    btn.textContent = meta?.icon || v;
    btn.classList.toggle("active", cfg[key] === v);
    btn.title = meta?.title || `${label}：${v}`;
    btn.addEventListener("click", (e) => {
      stop(e);
      const patch = { [key]: v };
      if (key === "fit_mode" && v === "补边") patch.mode = "宽高";
      if (key === "mode" && v !== "宽高" && cfg.fit_mode === "补边") patch.fit_mode = "留边填充";
      writeConfig(node, patch);
      buildPanel(node);
    });
    for (const ev of ["pointerdown", "mousedown", "mouseup", "dblclick", "keydown", "keyup", "wheel"]) btn.addEventListener(ev, stop);
    group.appendChild(btn);
  }
  row.append(span, group);
  root.appendChild(row);
}

function colorField(root, node, cfg) {
  const row = document.createElement("label");
  row.className = "gjj-mf-field";
  row.title = "补边 / 留边填充时使用的背景颜色。拉伸和裁剪填满不会使用该颜色。Padding color.";
  const span = document.createElement("span");
  span.className = "gjj-mf-label";
  span.textContent = "🎨 补边颜色";
  const input = document.createElement("input");
  input.className = "gjj-mf-control";
  input.type = "color";
  input.value = String(cfg.pad_color || "#000000").startsWith("#") ? String(cfg.pad_color).slice(0, 7) : "#000000";
  input.addEventListener("input", (e) => { stop(e); writeConfig(node, { pad_color: input.value }); });
  input.addEventListener("change", stop);
  for (const ev of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "keydown", "keyup", "wheel"]) input.addEventListener(ev, stop);
  row.append(span, input);
  root.appendChild(row);
}

function buildPanel(node) {
  const dom = node.__gjjMfDom;
  if (!dom) return;
  const cfg = readConfig(node);
  node.__gjjMfShowSettings = !!cfg.show_settings;
  dom.panel.replaceChildren();

  choiceField(dom.panel, node, { ...cfg, mode: cfg.mode }, "mode", "📐", "尺寸模式：宽高、等比、长边、像素。", MODES);
  choiceField(dom.panel, node, cfg, "fit_mode", "🧲", "适配方式：拉伸、补边、留边填充、裁剪填满。", OPTIONS.fit_mode);

  if (cfg.show_settings) {
    const commonSection = document.createElement("div");
    commonSection.className = "gjj-mf-section";
    dom.panel.appendChild(commonSection);
    choiceField(commonSection, node, cfg, "crop_position", "📍", "补边/留边填充时决定图片贴边位置；裁剪填满时决定保留方向。默认居中。", OPTIONS.crop_position);
    selectField(commonSection, node, cfg, "upscale_method", "🔄 缩放算法", "缩放采样算法。Lanczos 高质量；Bicubic/Bilinear 更快。Resampling method.", OPTIONS.upscale_method);
    selectField(commonSection, node, cfg, "round_to_multiple", "🔢 尺寸对齐", "输出宽高向上对齐到指定倍数。Round output size to multiple.", OPTIONS.round_to_multiple);
    if (cfg.fit_mode === "补边" || cfg.fit_mode === "留边填充") {
      colorField(commonSection, node, cfg);
      numberField(commonSection, node, cfg, "pad_feather", "🪶 边缘羽化", "未接入外部遮罩时，对自动生成的补边遮罩边缘做柔化。0 为关闭。", { min: 0, max: 256, sliderMax: 128, step: 1, type: "INT" });
    }
    selectField(commonSection, node, cfg, "device", "⚙️ 计算设备", "选择 CPU 或 GPU 执行。Lanczos 在 CPU 更稳定。Compute device.", OPTIONS.device);
  }

  const section = document.createElement("div");
  section.className = "gjj-mf-section";
  dom.panel.appendChild(section);

  ensureNativeParamWidgets(node);
  syncNativeParamInputSlots(node);
  for (const def of PARAM_INPUTS.filter((item) => isParamDefActive(item, cfg))) {
    if (def.widgetType === "combo") {
      selectField(section, node, cfg, def.cfgKey, def.label, def.options?.tooltip || `${def.label}：选择或连接外部 ${def.type}。`, def.values || []);
    } else {
      numberField(section, node, cfg, def.cfgKey, def.label, def.options?.tooltip || `${def.label}：拖动滑块或输入数字。`, {
        min: def.min,
        max: def.max,
        sliderMax: def.sliderMax,
        step: def.step,
        type: def.type,
        defaultValue: def.defaultValue,
      });
    }
  }
  if (cfg.mode === "像素" && cfg.aspect_ratio === "自定义") {
    numberField(section, node, cfg, "proportional_width", "↔️ 比例宽", "自定义比例宽。Custom ratio width.", { min: 1, max: 100000, sliderMax: 100, step: 1, type: "FLOAT" });
    numberField(section, node, cfg, "proportional_height", "↕️ 比例高", "自定义比例高。Custom ratio height.", { min: 1, max: 100000, sliderMax: 100, step: 1, type: "FLOAT" });
  }

  updateDomState(node);
  writeConfig(node);
  redraw(node);
}

function updateDomState(node) {
  const dom = node.__gjjMfDom;
  if (!dom) return;
  const cfg = readConfig(node);
  dom.outputs.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", cfg.extra_outputs.includes(btn.dataset.key));
  });
  if (dom.settingsBtn) {
    const showSettings = getShowSettings(node);
    dom.settingsBtn.classList.toggle("active", showSettings);
    dom.settingsBtn.textContent = showSettings ? "⚙更多设置 收起" : "⚙更多设置";
  }
}

function createDom(node) {
  ensureStyles();
  const root = document.createElement("div");
  root.className = "gjj-mf-root";
  for (const ev of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) root.addEventListener(ev, stop);

  const outputs = document.createElement("div");
  outputs.className = "gjj-mf-output-row";
  outputs.title = "更多输出：单击为单选，Ctrl/Shift 可复选。";

  const settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "gjj-mf-settings-btn";
  settingsBtn.textContent = "⚙更多设置";
  settingsBtn.title = "显示或隐藏缩放算法、尺寸对齐、补边颜色、边缘羽化和计算设备。";
  settingsBtn.addEventListener("click", (e) => {
    stop(e);
    setShowSettings(node, !getShowSettings(node));
    updateDomState(node);
    buildPanel(node);
  });
  for (const ev of ["pointerdown", "mousedown", "mouseup", "dblclick", "keydown", "keyup", "wheel"]) settingsBtn.addEventListener(ev, stop);
  outputs.appendChild(settingsBtn);

  const outputLabel = document.createElement("span");
  outputLabel.className = "gjj-mf-mini-label";
  outputLabel.textContent = "更多输出:";
  outputLabel.title = "输出扩充口：单击为单选，Ctrl/Shift 可复选。";
  outputs.appendChild(outputLabel);

  for (const item of OUTPUTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gjj-mf-choice gjj-mf-output-btn";
    btn.dataset.key = item.key;
    btn.textContent = item.icon;
    btn.title = item.title;
    btn.addEventListener("click", (e) => {
      stop(e);
      const cfg = readConfig(node);
      let selected = [...cfg.extra_outputs];
      if (e.ctrlKey || e.shiftKey) {
        selected = selected.includes(item.key) ? selected.filter((x) => x !== item.key) : [...selected, item.key];
      } else {
        selected = selected.length === 1 && selected[0] === item.key ? [] : [item.key];
      }
      writeConfig(node, { extra_outputs: selected.slice(0, 3) });
      updateOutputs(node, { fromUser: true });
      updateDomState(node);
      redraw(node);
    });
    for (const ev of ["pointerdown", "mousedown", "mouseup", "dblclick", "keydown", "keyup", "wheel"]) btn.addEventListener(ev, stop);
    outputs.appendChild(btn);
  }

  const panel = document.createElement("div");
  panel.className = "gjj-mf-panel";

  root.append(outputs, panel);
  node.__gjjMfDom = {
    ...(node.__gjjMfDom || {}),
    root,
    outputs,
    settingsBtn,
    panel,
  };
  return root;
}

function createTailDom(node) {
  ensureStyles();
  const root = document.createElement("div");
  root.className = "gjj-mf-tail-root";
  for (const ev of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) root.addEventListener(ev, stop);

  const status = document.createElement("div");
  status.className = "gjj-mf-status";
  status.innerHTML = `<div class="gjj-mf-status-text">准备就绪</div><div class="gjj-mf-bar"><div class="gjj-mf-fill"></div></div>`;

  const preview = document.createElement("div");
  preview.className = "gjj-mf-preview";
  preview.innerHTML = `<div class="gjj-mf-preview-frame"><img alt="缩放预览"></div><div class="gjj-mf-preview-meta"></div>`;

  root.append(status, preview);
  node.__gjjMfDom = {
    ...(node.__gjjMfDom || {}),
    tailRoot: root,
    status,
    preview,
    previewImg: preview.querySelector("img"),
    previewMeta: preview.querySelector(".gjj-mf-preview-meta"),
  };
  return root;
}

function ensureDomWidget(node) {
  removeConfigInputSlots(node);
  if (node.__gjjMfDomWidget && node.widgets?.includes(node.__gjjMfDomWidget)) {
    if (!node.__gjjMfDom?.panel || !node.__gjjMfDom?.outputs || node.__gjjMfDomWidget.element?.querySelector?.(".gjj-mf-status, .gjj-mf-preview")) {
      removeWidgetByObject(node, node.__gjjMfDomWidget);
      node.__gjjMfDomWidget = null;
      node.__gjjMfDom = {
        status: node.__gjjMfDom?.status,
        preview: node.__gjjMfDom?.preview,
        previewImg: node.__gjjMfDom?.previewImg,
        previewMeta: node.__gjjMfDom?.previewMeta,
        tailRoot: node.__gjjMfDom?.tailRoot,
      };
    } else {
      purgeLegacyStatusAndPanels(node, node.__gjjMfDomWidget);
      return;
    }
  }
  if (node.__gjjMfDomWidget && node.widgets?.includes(node.__gjjMfDomWidget)) {
    purgeLegacyStatusAndPanels(node, node.__gjjMfDomWidget);
    return;
  }
  purgeLegacyStatusAndPanels(node, null);
  const root = createDom(node);
  let widget;
  if (typeof node.addDOMWidget === "function") {
    widget = node.addDOMWidget(PANEL_WIDGET_NAME, "DOM", root, {
      serialize: false,
      hideOnZoom: false,
      getValue: () => "",
      setValue: () => {},
    });
  } else {
    widget = node.addWidget("text", PANEL_WIDGET_NAME, "", () => {}, { serialize: false });
    widget.element = root;
  }
  widget.serialize = false;
  widget.computeSize = () => {
    const h = measurePanelHeight(root);
    return [Math.max(235, (node.size?.[0] || 270) - 28), h + 6];
  };
  widget.getHeight = () => measurePanelHeight(root) + 6;
  node.__gjjMfDomWidget = widget;
  purgeLegacyStatusAndPanels(node, widget);
}

function ensureTailWidget(node) {
  if (node.__gjjMfTailWidget && node.widgets?.includes(node.__gjjMfTailWidget)) {
    if (!node.__gjjMfDom?.status || !node.__gjjMfDom?.preview || !node.__gjjMfDom?.previewImg) {
      removeWidgetByObject(node, node.__gjjMfTailWidget);
      node.__gjjMfTailWidget = null;
    } else {
      moveTailWidgetAfterParams(node);
      return;
    }
  }
  const root = createTailDom(node);
  let widget;
  if (typeof node.addDOMWidget === "function") {
    widget = node.addDOMWidget(TAIL_WIDGET_NAME, "DOM", root, {
      serialize: false,
      hideOnZoom: false,
      getValue: () => "",
      setValue: () => {},
    });
  } else {
    widget = node.addWidget("text", TAIL_WIDGET_NAME, "", () => {}, { serialize: false });
    widget.element = root;
  }
  widget.serialize = false;
  widget.computeSize = () => {
    const h = measureTailHeight(root);
    return [Math.max(235, (node.size?.[0] || 270) - 28), h > 0 ? h + 6 : 0];
  };
  widget.getHeight = () => {
    const h = measureTailHeight(root);
    return h > 0 ? h + 6 : 0;
  };
  node.__gjjMfTailWidget = widget;
  moveTailWidgetAfterParams(node);
}

function showStatus(node, text, kind = "running", progress = null) {
  ensureTailWidget(node);
  const st = node.__gjjMfDom?.status;
  if (!st) return;
  st.classList.remove("running", "error", "done");
  st.classList.add("show");
  st.dataset.state = kind;
  if (kind === "running") {
    st.classList.add("running");
    st.dataset.backendDone = "0";
  } else if (kind === "error") {
    st.classList.add("error");
  } else if (kind === "done") {
    st.classList.add("done");
  }
  const textEl = st.querySelector(".gjj-mf-status-text");
  if (textEl) textEl.textContent = text;
  const fill = st.querySelector(".gjj-mf-fill");
  if (fill) {
    if (typeof progress === "number" && isFinite(progress)) {
      fill.style.animation = "none";
      fill.style.transform = "none";
      fill.style.width = `${Math.max(0, Math.min(100, progress * 100))}%`;
    } else {
      fill.style.width = "35%";
      fill.style.animation = "gjjMfRun 1.1s ease-in-out infinite alternate";
      fill.style.transform = "";
    }
  }
  redraw(node);
}

function hideStatus(node) {
  const st = node.__gjjMfDom?.status;
  if (st) {
    st.classList.remove("show", "running", "error", "done");
    st.dataset.state = "hidden";
    delete st.dataset.backendDone;
    const fill = st.querySelector(".gjj-mf-fill");
    if (fill) {
      fill.style.width = "0%";
      fill.style.animation = "none";
      fill.style.transform = "none";
    }
  }
  redraw(node);
}

function getPreviewPayload(message) {
  const ui = message?.ui || message || {};
  const output = message?.output || {};
  const raw =
    ui?.gjj_image_resize_kjv2_preview?.[0] ||
    ui?.gjj_image_resize_kjv2_preview ||
    output?.gjj_image_resize_kjv2_preview?.[0] ||
    output?.gjj_image_resize_kjv2_preview ||
    message?.gjj_image_resize_kjv2_preview?.[0] ||
    message?.gjj_image_resize_kjv2_preview;
  if (!raw) return null;
  if (typeof raw === "string") return { src: raw };
  if (typeof raw === "object") return raw;
  return null;
}

function setDomPreview(node, payload) {
  const src = String(payload?.src || payload?.data || payload?.image || "");
  if (!node || !src) return;
  ensureDomWidget(node);
  ensureTailWidget(node);
  const dom = node.__gjjMfDom;
  if (!dom?.preview || !dom?.previewImg) return;
  dom.previewImg.onload = () => {
    redraw(node);
  };
  dom.previewImg.onerror = () => {
    dom.preview.classList.remove("show");
    redraw(node);
  };
  dom.previewImg.src = src;
  const width = Number(payload?.width) || Number(payload?.preview_width) || 0;
  const height = Number(payload?.height) || Number(payload?.preview_height) || 0;
  const originalWidth = Number(payload?.original_width) || width || 0;
  const originalHeight = Number(payload?.original_height) || height || 0;
  if (originalWidth && originalHeight) {
    writeConfig(node, { source_width: originalWidth, source_height: originalHeight });
  }
  const count = Number(payload?.count) || 1;
  const countText = count > 1 ? ` · 共 ${count} 张，预览第 1 张` : "";
  if (dom.previewMeta) {
    dom.previewMeta.textContent = `${width || "?"} × ${height || "?"}${countText}`;
  }
  dom.preview.classList.add("show");
  redraw(node);
}

function findNodeByBackendId(nodeId) {
  if (!nodeId || !app?.graph) return null;
  const idText = String(nodeId);
  const idNum = Number(idText);
  try {
    if (Number.isFinite(idNum)) {
      const n = app.graph.getNodeById?.(idNum);
      if (n?.type === NODE_CLASS) return n;
    }
  } catch (_) {}
  for (const n of app.graph._nodes || []) {
    if (!n || n.type !== NODE_CLASS) continue;
    if (String(n.id) === idText) return n;
    if (String(n?.properties?.NodeID || "") === idText) return n;
  }
  return null;
}

function handleBackendStatus(detail) {
  const data = detail?.detail || detail || {};
  const node = findNodeByBackendId(data.node_id);
  if (!node) return;
  ensureDomWidget(node);
  ensureTailWidget(node);
  const state = data.state || "running";
  const msg = data.message || (state === "done" ? "执行完成" : state === "error" ? "执行错误" : "正在执行");
  const progress = typeof data.progress === "number" ? data.progress : null;
  if (state === "done") {
    showStatus(node, msg, "done", 1);
    const st = node.__gjjMfDom?.status;
    if (st) st.dataset.backendDone = "1";
  } else if (state === "error") {
    showStatus(node, msg, "error", 1);
    const st = node.__gjjMfDom?.status;
    if (st) st.dataset.backendDone = "1";
  } else {
    const st = node.__gjjMfDom?.status;
    if (st) st.dataset.backendDone = "0";
    showStatus(node, msg, "running", progress);
  }
}

function ensureBackendStatusListener() {
  if (window.__gjjMfResizeStatusListenerV43) return;
  window.__gjjMfResizeStatusListenerV43 = true;
  try {
    api.addEventListener("gjj_image_resize_kjv2_status", handleBackendStatus);
  } catch (_) {}
}

function initNode(node) {
  node.properties ||= {};
  node.__gjjMfShowSettings = !!readConfig(node).show_settings;
  removeConfigInputSlots(node);
  for (const w of node.widgets || []) {
    if (w?.name === CONFIG_WIDGET) hideWidgetCompletely(w);
  }
  ensureDomWidget(node);
  ensureTailWidget(node);
  moveConfigWidgetToEnd(node);
  removeConfigInputSlots(node);
  writeConfig(node, { ...readConfig(node), show_settings: node.__gjjMfShowSettings });
  buildPanel(node);
  ensureNativeParamWidgets(node);
  syncNativeParamInputSlots(node);
  moveTailWidgetAfterParams(node);
  moveConfigWidgetToEnd(node);
  updateOutputs(node);
  hideStatus(node); // 默认隐藏，不占位。
  setTimeout(() => {
    for (const w of node.widgets || []) if (w?.name === CONFIG_WIDGET) hideWidgetCompletely(w);
    moveConfigWidgetToEnd(node);
    removeConfigInputSlots(node);
    purgeLegacyStatusAndPanels(node, node.__gjjMfDomWidget);
    ensureTailWidget(node);
    buildPanel(node);
    ensureNativeParamWidgets(node);
    syncNativeParamInputSlots(node);
    moveTailWidgetAfterParams(node);
    moveConfigWidgetToEnd(node);
    updateOutputs(node);
    hideStatus(node);
  }, 50);
  setTimeout(() => {
    ensureTailWidget(node);
    ensureNativeParamWidgets(node);
    syncNativeParamInputSlots(node);
    moveTailWidgetAfterParams(node);
    moveConfigWidgetToEnd(node);
    redraw(node);
  }, 300);
}

app.registerExtension({
  name: "GJJ.MultiFunctionImageResize.v44.borderBoardSliders",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    ensureBackendStatusListener();
    if (nodeData.name !== NODE_CLASS) return;

    const originalOnResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (...args) {
      const ret = originalOnResize?.apply(this, args);
      redraw(this);
      return ret;
    };

    const originalAddWidget = nodeType.prototype.addWidget;
    nodeType.prototype.addWidget = function (...args) {
      const widget = originalAddWidget?.apply(this, args);
      if (widget?.name === CONFIG_WIDGET) {
        hideWidgetCompletely(widget);
        setTimeout(() => hideWidgetCompletely(widget), 0);
      }
      return widget;
    };

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const ret = originalOnNodeCreated?.apply(this, arguments);
      initNode(this);
      return ret;
    };

    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (data) {
      rememberSerializedOutputKeys(this, data);
      rememberSerializedParamLinks(this, data);
      const ret = originalOnConfigure?.apply(this, arguments);
      rememberSerializedOutputKeys(this, data);
      rememberSerializedParamLinks(this, data);
      setTimeout(() => initNode(this), 0);
      setTimeout(() => initNode(this), 180);
      setTimeout(() => {
        ensureNativeParamWidgets(this);
        repairSerializedParamLinks(this);
        moveTailWidgetAfterParams(this);
        redraw(this);
      }, 700);
      setTimeout(() => {
        ensureNativeParamWidgets(this);
        repairSerializedParamLinks(this);
        saveCurrentParamLinks(this);
        moveTailWidgetAfterParams(this);
        redraw(this);
      }, 1500);
      return ret;
    };

    const originalOnSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (o) {
      saveCurrentParamLinks(this, o);
      writeConfig(this, readConfig(this));
      saveCurrentParamLinks(this, o);
      const ret = originalOnSerialize?.apply(this, arguments);
      saveCurrentParamLinks(this, o);
      return ret;
    };

    const originalOnExecutionStart = nodeType.prototype.onExecutionStart;
    nodeType.prototype.onExecutionStart = function () {
      this.__gjjMfStart = performance.now();
      purgeLegacyStatusAndPanels(this, this.__gjjMfDomWidget);
      writeConfig(this, readConfig(this));
      ensureTailWidget(this);
      ensureNativeParamWidgets(this);
      moveTailWidgetAfterParams(this);
      showStatus(this, "开始执行：正在按前台参数处理图片 Batch Resize...", "running", 0);
      return originalOnExecutionStart?.apply(this, arguments);
    };

    const originalOnExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message, ...args) {
      const ret = originalOnExecuted?.apply(this, arguments);
      const preview = getPreviewPayload(message);
      if (preview) setDomPreview(this, preview);
      const st = this.__gjjMfDom?.status;
      // 后台 websocket 的 done 消息包含真实图片数量，前端 onExecuted 只作为兜底，不能覆盖真实统计。
      if (!st || st.dataset.backendDone !== "1") {
        const elapsed = this.__gjjMfStart ? ((performance.now() - this.__gjjMfStart) / 1000).toFixed(2) : "0.00";
        showStatus(this, `执行完成：耗时 ${elapsed} 秒`, "done", 1);
      }
      return ret;
    };

    const originalOnExecutionError = nodeType.prototype.onExecutionError;
    nodeType.prototype.onExecutionError = function (error) {
      const msg = error?.message || String(error || "未知错误");
      showStatus(this, `执行错误：${msg}。请检查输入图片、torch/Pillow 依赖、尺寸参数。`, "error", 1);
      return originalOnExecutionError?.apply(this, arguments);
    };

  },
});
