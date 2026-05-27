import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "GJJ_ImageResizeKJv2";
const CONFIG_WIDGET = "config_json";
const PARAM_INPUTS = [
  { name: "target_width", cfgKey: "width", label: "📐 目标宽度", mode: "宽高", type: "INT", min: 1, max: 16384, step: 8, defaultValue: 1024 },
  { name: "target_height", cfgKey: "height", label: "📐 目标高度", mode: "宽高", type: "INT", min: 1, max: 16384, step: 8, defaultValue: 1024 },
  { name: "scale_percent", cfgKey: "scale_percent", label: "📊 缩放百分比", mode: "等比", type: "FLOAT", min: 0.1, max: 10000, step: 1, defaultValue: 100 },
  { name: "long_side_length", cfgKey: "long_side_length", label: "📏 长边长度", mode: "长边", type: "INT", min: 1, max: 16384, step: 8, defaultValue: 1024 },
  { name: "total_pixel_k", cfgKey: "total_pixel_k", label: "🧮 总像素/K", mode: "像素", type: "INT", min: 1, max: 1000000, step: 1, defaultValue: 260 },
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
  scale_percent: 100,
  long_side_length: 1024,
  total_pixel_k: 260,
  aspect_ratio: "1:1",
  proportional_width: 1,
  proportional_height: 1,
  extra_outputs: [],
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
  "留边填充": { icon: "留边", title: "留边填充：等比缩放后补边；未接入遮罩时会输出补边遮罩。" },
  "裁剪填满": { icon: "裁剪", title: "裁剪填满：等比缩放后居中裁剪。" },
};
const POSITION_BUTTONS = {
  "上": { icon: "上", title: "上：留边时贴上，裁剪时保留上方内容。" },
  "下": { icon: "下", title: "下：留边时贴下，裁剪时保留下方内容。" },
  "左": { icon: "左", title: "左：留边时贴左，裁剪时保留左侧内容。" },
  "右": { icon: "右", title: "右：留边时贴右，裁剪时保留右侧内容。" },
  "中": { icon: "中", title: "中：居中留边或居中裁剪。" },
};
const OUTPUTS = [
  { key: "original_size", icon: "📦", label: "📦 原始尺寸", outName: "原始尺寸", type: "*", title: "更多输出：原始尺寸 [宽度, 高度]。单击单选，Ctrl/Shift 可复选。" },
  { key: "output_height", icon: "↕️", label: "↕️ 输出高度", outName: "输出高度", type: "*", title: "更多输出：输出处理后的高度。单击单选，Ctrl/Shift 可复选。" },
  { key: "output_width", icon: "↔️", label: "↔️ 输出宽度", outName: "输出宽度", type: "*", title: "更多输出：输出处理后的宽度。单击单选，Ctrl/Shift 可复选。" },
  { key: "image_count", icon: "🔢", label: "数量", outName: "数量", type: "*", title: "更多输出：本次总共处理的图片数量。单击单选，Ctrl/Shift 可复选。" },
];


const PANEL_WIDGET_NAME = "gjj_multifunction_resize_panel";

const CONFIG_INPUT_RE = /(config_json|隐藏配置|前端面板写入|Internal JSON config)/i;

function getParamInputDef(name) {
  return PARAM_INPUTS.find((item) => item.name === String(name || "")) || null;
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
  return (node?.inputs || []).find((input) => String(input?.name || "") === name) || null;
}

function setWidgetVisible(widget, visible) {
  if (!widget) return;
  if (!widget.__gjjMfNativeSaved) {
    widget.__gjjMfNativeSaved = {
      type: widget.type,
      computeSize: widget.computeSize,
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
    if (saved.draw !== undefined) widget.draw = saved.draw;
    if (saved.mouse !== undefined) widget.mouse = saved.mouse;
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
  input.widget = { name: def.name };
  return input;
}

function ensureNativeParamWidgets(node) {
  if (!node) return;
  const cfg = readConfig(node);
  const visibleDefs = PARAM_INPUTS.filter((def) => def.mode === cfg.mode);
  const widgetsByName = new Map();
  for (const def of PARAM_INPUTS) {
    const widget = setupNativeParamWidget(node, def);
    widgetsByName.set(def.name, widget);
    setWidgetVisible(widget, def.mode === cfg.mode);
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
}

function syncNativeParamInputSlots(node) {
  const cfg = readConfig(node);
  if (!Array.isArray(node?.inputs)) return;
  for (let i = node.inputs.length - 1; i >= 0; i--) {
    const def = getParamInputDef(node.inputs[i]?.name);
    if (!def || def.mode === cfg.mode) continue;
    try { node.disconnectInput?.(i); } catch (_) {}
    try { node.removeInput?.(i); } catch (_) { node.inputs.splice(i, 1); }
  }
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
    try { node.disconnectInput?.(i); } catch (_) {}
    node.inputs.splice(i, 1);
    removed = true;
  }
  if (removed) {
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

const LEGACY_WIDGET_NAMES = new Set([
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

const OPTIONS = {
  fit_mode: ["拉伸", "留边填充", "裁剪填满"],
  crop_position: ["上", "下", "左", "右", "中"],
  upscale_method: ["兰索斯", "双三次", "双线性", "区域", "最近邻"],
  round_to_multiple: ["1", "2", "4", "8", "16", "32", "64", "128", "256", "512"],
  device: ["CPU", "GPU"],
  aspect_ratio: ["原始比例", "自定义", "1:1", "3:2", "4:3", "16:9", "2:3", "3:4", "9:16"],
};

function ensureStyles() {
  if (document.getElementById("gjj-mf-resize-style-v41")) return;
  const style = document.createElement("style");
  style.id = "gjj-mf-resize-style-v41";
  style.textContent = `
.gjj-mf-root{box-sizing:border-box;width:100%;padding:4px 0 7px 0;font-family:system-ui,"Microsoft YaHei",sans-serif;color:#dbeafe;pointer-events:auto;user-select:none;}
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
.gjj-mf-section{margin-top:2px;padding-top:5px;border-top:1px solid rgba(148,163,184,.16);}
.gjj-mf-status{display:none;margin-top:8px;border:1px solid rgba(34,211,238,.34);border-radius:9px;background:rgba(2,6,23,.45);padding:6px 7px;color:#e0f2fe;font-size:12px;}
.gjj-mf-status.show{display:block;}
.gjj-mf-status.done{border-color:rgba(34,197,94,.72);color:#dcfce7;background:rgba(20,83,45,.22);}
.gjj-mf-status.error{border-color:rgba(248,113,113,.86);color:#fee2e2;background:rgba(127,29,29,.25);}
.gjj-mf-bar{display:none;height:5px;margin-top:5px;border-radius:999px;background:rgba(148,163,184,.25);overflow:hidden;}
.gjj-mf-status.running .gjj-mf-bar{display:block;}
.gjj-mf-fill{height:100%;width:35%;border-radius:999px;background:#22d3ee;animation:gjjMfRun 1.1s ease-in-out infinite alternate;}
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
  if (!OPTIONS.crop_position.includes(cfg.crop_position)) cfg.crop_position = "中";
  if (!Array.isArray(cfg.extra_outputs)) cfg.extra_outputs = [];
  return cfg;
}

function writeConfig(node, patch = {}) {
  const cfg = { ...readConfig(node), ...patch };
  if (!MODES.includes(cfg.mode)) cfg.mode = "等比";
  if (!OPTIONS.crop_position.includes(cfg.crop_position)) cfg.crop_position = "中";
  if (!Array.isArray(cfg.extra_outputs)) cfg.extra_outputs = [];
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

function hideWidgetCompletely(widget) {
  if (!widget) return;
  if (!widget.__gjjMfSaved) {
    widget.__gjjMfSaved = true;
    widget.__gjjMfOriginal = {
      type: widget.type,
      computeSize: widget.computeSize,
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
        const h = Math.max(1, Math.ceil(node.__gjjMfDomWidget.element.scrollHeight || node.__gjjMfDomWidget.element.offsetHeight || 1));
        node.__gjjMfDomWidget.computedHeight = h + 6;
        node.__gjjMfDomWidget.last_y = 0;
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
  const input = document.createElement("input");
  input.className = "gjj-mf-control";
  input.type = "number";
  input.value = cfg[key];
  input.min = opts.min ?? 1;
  input.max = opts.max ?? 1000000;
  input.step = opts.step ?? 1;
  input.addEventListener("input", (e) => {
    stop(e);
    writeConfig(node, { [key]: Number(input.value) });
  });
  input.addEventListener("change", (e) => { stop(e); redraw(node); });
  for (const ev of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "keydown", "keyup", "wheel"]) input.addEventListener(ev, stop);
  row.append(span, input);
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
      writeConfig(node, { [key]: v });
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
  row.title = "留边填充 Letterbox/Padding 时使用的背景颜色。拉伸和裁剪填满不会使用该颜色。Padding color.";
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
  dom.panel.replaceChildren();

  choiceField(dom.panel, node, { ...cfg, mode: cfg.mode }, "mode", "📐", "尺寸模式：宽高、等比、长边、像素。", MODES);
  choiceField(dom.panel, node, cfg, "fit_mode", "🧲", "适配方式：拉伸、留边填充、裁剪填满。", OPTIONS.fit_mode);

  if (node.__gjjMfShowSettings) {
    const commonSection = document.createElement("div");
    commonSection.className = "gjj-mf-section";
    dom.panel.appendChild(commonSection);
    choiceField(commonSection, node, cfg, "crop_position", "📍", "留边填充时决定图片贴边位置；裁剪填满时决定保留方向。默认居中。", OPTIONS.crop_position);
    selectField(commonSection, node, cfg, "upscale_method", "🔄 缩放算法", "缩放采样算法。Lanczos 高质量；Bicubic/Bilinear 更快。Resampling method.", OPTIONS.upscale_method);
    selectField(commonSection, node, cfg, "round_to_multiple", "🔢 尺寸对齐", "输出宽高向上对齐到指定倍数。Round output size to multiple.", OPTIONS.round_to_multiple);
    if (cfg.fit_mode === "留边填充") {
      colorField(commonSection, node, cfg);
      numberField(commonSection, node, cfg, "pad_feather", "🪶 边缘羽化", "未接入外部遮罩时，对自动生成的补边遮罩边缘做柔化。0 为关闭。", { min: 0, max: 256, step: 1 });
    }
    selectField(commonSection, node, cfg, "device", "⚙️ 计算设备", "选择 CPU 或 GPU 执行。Lanczos 在 CPU 更稳定。Compute device.", OPTIONS.device);
  }

  const section = document.createElement("div");
  section.className = "gjj-mf-section";
  dom.panel.appendChild(section);

  ensureNativeParamWidgets(node);
  syncNativeParamInputSlots(node);
  if (cfg.mode === "像素" && cfg.aspect_ratio === "自定义") {
    numberField(section, node, cfg, "proportional_width", "↔️ 比例宽", "自定义比例宽。Custom ratio width.", { min: 1, max: 100000, step: 1 });
    numberField(section, node, cfg, "proportional_height", "↕️ 比例高", "自定义比例高。Custom ratio height.", { min: 1, max: 100000, step: 1 });
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
    dom.settingsBtn.classList.toggle("active", !!node.__gjjMfShowSettings);
    dom.settingsBtn.textContent = node.__gjjMfShowSettings ? "⚙更多设置 收起" : "⚙更多设置";
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
    node.__gjjMfShowSettings = !node.__gjjMfShowSettings;
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

  const status = document.createElement("div");
  status.className = "gjj-mf-status";
  status.innerHTML = `<div class="gjj-mf-status-text">准备就绪</div><div class="gjj-mf-bar"><div class="gjj-mf-fill"></div></div>`;

  root.append(outputs, panel, status);
  node.__gjjMfDom = { root, outputs, settingsBtn, panel, status };
  return root;
}

function ensureDomWidget(node) {
  removeConfigInputSlots(node);
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
    const h = Math.max(1, Math.ceil(root.scrollHeight || root.offsetHeight || 1));
    return [Math.max(235, (node.size?.[0] || 270) - 28), h + 6];
  };
  node.__gjjMfDomWidget = widget;
  purgeLegacyStatusAndPanels(node, widget);
}

function showStatus(node, text, kind = "running", progress = null) {
  const st = node.__gjjMfDom?.status;
  if (!st) return;
  st.classList.remove("running", "error", "done");
  st.classList.add("show");
  st.dataset.state = kind;
  if (kind === "running") st.classList.add("running");
  else if (kind === "error") st.classList.add("error");
  else if (kind === "done") st.classList.add("done");
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
    const fill = st.querySelector(".gjj-mf-fill");
    if (fill) {
      fill.style.width = "0%";
      fill.style.animation = "none";
      fill.style.transform = "none";
    }
  }
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
  if (window.__gjjMfResizeStatusListenerV40) return;
  window.__gjjMfResizeStatusListenerV40 = true;
  try {
    api.addEventListener("gjj_image_resize_kjv2_status", handleBackendStatus);
  } catch (_) {}
}

function initNode(node) {
  node.properties ||= {};
  removeConfigInputSlots(node);
  for (const w of node.widgets || []) {
    if (w?.name === CONFIG_WIDGET) hideWidgetCompletely(w);
  }
  ensureDomWidget(node);
  moveConfigWidgetToEnd(node);
  removeConfigInputSlots(node);
  writeConfig(node, readConfig(node));
  buildPanel(node);
  ensureNativeParamWidgets(node);
  syncNativeParamInputSlots(node);
  updateOutputs(node);
  hideStatus(node); // 默认隐藏，不占位。
  setTimeout(() => {
    for (const w of node.widgets || []) if (w?.name === CONFIG_WIDGET) hideWidgetCompletely(w);
    moveConfigWidgetToEnd(node);
    removeConfigInputSlots(node);
    purgeLegacyStatusAndPanels(node, node.__gjjMfDomWidget);
    buildPanel(node);
    ensureNativeParamWidgets(node);
    syncNativeParamInputSlots(node);
    updateOutputs(node);
    hideStatus(node);
  }, 50);
  setTimeout(() => {
    ensureNativeParamWidgets(node);
    syncNativeParamInputSlots(node);
    redraw(node);
  }, 300);
}

app.registerExtension({
  name: "GJJ.MultiFunctionImageResize.v41.compactPanel",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    ensureBackendStatusListener();
    if (nodeData.name !== NODE_CLASS) return;

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
      const ret = originalOnConfigure?.apply(this, arguments);
      rememberSerializedOutputKeys(this, data);
      setTimeout(() => initNode(this), 0);
      setTimeout(() => initNode(this), 180);
      return ret;
    };

    const originalOnSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (o) {
      writeConfig(this, readConfig(this));
      originalOnSerialize?.apply(this, arguments);
    };

    const originalOnExecutionStart = nodeType.prototype.onExecutionStart;
    nodeType.prototype.onExecutionStart = function () {
      this.__gjjMfStart = performance.now();
      purgeLegacyStatusAndPanels(this, this.__gjjMfDomWidget);
      writeConfig(this, readConfig(this));
      ensureNativeParamWidgets(this);
      showStatus(this, "开始执行：正在按前台参数处理图片 Batch Resize...", "running", 0);
      return originalOnExecutionStart?.apply(this, arguments);
    };

    const originalOnExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function () {
      const ret = originalOnExecuted?.apply(this, arguments);
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
