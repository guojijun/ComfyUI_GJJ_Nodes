import { queueOnlyCurrentNode } from "./gjj_utils.js";
import { api } from "/scripts/api.js";

const { app } = window.comfyAPI.app;

const NODE_NAME = "GJJ_Ideogram4DirectGenerator";
const TEMPLATE_PARAMS_NODE = "GJJ_TemplateParams";
const TEMPLATE_WIDGET = "template_text";
const VALUES_WIDGET = "values_json";
const SCHEMA_WIDGET = "schema_json";
const SETTINGS_PROPERTY = "gjj_ideogram4_direct_settings_open";
const MODEL_SETTINGS_PROPERTY = "gjj_ideogram4_direct_model_settings_open";
const RANDOM_SEED_PROPERTY = "gjj_ideogram4_direct_random_seed";
const PARAM_ENABLED_PROPERTY = "gjj_ideogram4_direct_template_enabled";
const PARAM_SOURCE_PROPERTY = "gjj_ideogram4_direct_template_source";
const PARAM_BACKUP_PROPERTY = "gjj_ideogram4_direct_param_backup";
const PARAM_WIDGETS = ["width", "height"];
const LORA_CHAIN_INPUT = "lora_chain_config";
const TEST_CONFIG_WIDGET = "test_config";
const KEEP_MODEL_WIDGET = "keep_model";
const TEST_FILTER_PROPERTY = "gjj_ideogram4_direct_test_filter";
const TEST_SORT_PROPERTY = "gjj_ideogram4_direct_test_sort";
const PREVIEW_WIDGET_NAME = "__gjj_ideogram4_final_preview";
const MODEL_WIDGETS = [
  "unet_name",
  "uncond_unet_name",
  "clip_name",
  "vae_name",
  "weight_dtype",
  "lora_name",
  "lora_strength",
];
const SETTINGS_WIDGETS = [
  "mode",
  "cfg",
  "override_cfg",
  "override_start",
  "override_end",
  "sampler_name",
  "batch_size",
  "seed",
];
const HIDDEN_PANEL_WIDGETS = [...MODEL_WIDGETS, ...SETTINGS_WIDGETS, TEST_CONFIG_WIDGET, KEEP_MODEL_WIDGET];
const MODEL_TREE_META = {
  unet_name: { label: "主扩散模型", path: "ComfyUI/models/diffusion_models" },
  uncond_unet_name: { label: "无条件扩散模型", path: "ComfyUI/models/diffusion_models" },
  clip_name: { label: "Ideogram 4 文本编码器", path: "ComfyUI/models/text_encoders" },
  vae_name: { label: "Flux2 VAE", path: "ComfyUI/models/vae" },
  weight_dtype: { label: "加载精度", path: "UNETLoader / weight_dtype" },
  lora_name: { label: "LoRA", path: "ComfyUI/models/loras" },
  lora_strength: { label: "LoRA 强度", path: "LoRA / strength" },
};
const MODEL_FILTER_DEFAULTS = {
  unet_name: "ideogram",
  uncond_unet_name: "ideogram",
  clip_name: "qwen3vl_8b",
  vae_name: "flux2-vae",
  weight_dtype: "",
  lora_name: "ideogram",
};

function chainCallback(object, property, callback) {
  if (!object) return;
  const original = object[property];
  object[property] = function (...args) {
    const result = original?.apply?.(this, args);
    callback.apply(this, args);
    return result;
  };
}

function markCanvasDirty() {
  app.graph?.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty?.(true, true);
}

function findWidget(node, name) {
  return (node?.widgets || []).find((widget) => String(widget?.name || "") === name);
}

function setWidgetValue(node, name, value) {
  const widget = findWidget(node, name);
  if (!widget) return false;
  widget.value = value;
  if (widget.inputEl) widget.inputEl.value = value;
  if (widget.element && "value" in widget.element) widget.element.value = value;
  widget.callback?.(value);
  return true;
}

function getWidgetValue(node, name) {
  return findWidget(node, name)?.value;
}

function keepModelEnabled(node) {
  const value = getWidgetValue(node, KEEP_MODEL_WIDGET);
  return value === true || value === 1 || String(value || "").toLowerCase() === "true";
}

function setKeepModelEnabled(node, enabled) {
  setWidgetValue(node, KEEP_MODEL_WIDGET, Boolean(enabled));
  refreshButtons(node);
  markCanvasDirty();
}

function randomSeedValue() {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

function randomSeedEnabled(node) {
  return Boolean(node?.properties?.[RANDOM_SEED_PROPERTY]);
}

function setRandomSeedEnabled(node, enabled) {
  node.properties ||= {};
  node.properties[RANDOM_SEED_PROPERTY] = Boolean(enabled);
  if (enabled) setWidgetValue(node, "seed", randomSeedValue());
  const control = findWidget(node, "control_after_generate");
  if (control) {
    // This panel randomizes immediately before prompt serialization. Keep
    // ComfyUI's post-queue control fixed so the displayed seed is the one used.
    control.value = "fixed";
    control.callback?.(control.value);
  }
  refreshButtons(node);
  markCanvasDirty();
}

function randomizeEnabledSeeds() {
  for (const node of app.graph?._nodes || []) {
    if (String(node?.comfyClass || node?.type || "") !== NODE_NAME) continue;
    if (!randomSeedEnabled(node)) continue;
    setWidgetValue(node, "seed", randomSeedValue());
    refreshButtons(node);
  }
}

function installGraphToPromptPatch() {
  if (app.__gjjIdeogram4DirectSeedPatchInstalled || typeof app.graphToPrompt !== "function") return;
  app.__gjjIdeogram4DirectSeedPatchInstalled = true;
  const originalGraphToPrompt = app.graphToPrompt.bind(app);
  app.graphToPrompt = async function (...args) {
    randomizeEnabledSeeds();
    return originalGraphToPrompt(...args);
  };
}

function inputLinked(node, name) {
  const input = node?.inputs?.find((item) => String(item?.name || "") === name);
  return Boolean(input?.link != null);
}

function normalizedWidgetValue(node, name) {
  const widget = findWidget(node, name);
  const clean = (value) => {
    if (value == null) return "";
    if (typeof value === "object") return String(value.value ?? value.name ?? value.content ?? value.label ?? "").trim();
    return String(value).trim();
  };
  const values = Array.isArray(widget?.options?.values) ? widget.options.values : [];
  let value = clean(widget?.value);
  if (/^\d+$/.test(value) && values[Number(value)] != null) value = clean(values[Number(value)]);
  return value || clean(values[0]);
}

function installModelHelpProvider(node) {
  if (!node || node.__gjjIdeogram4DirectHelpProviderInstalled) return;
  node.__gjjIdeogram4DirectHelpProviderInstalled = true;
  node.__gjjHelpModelTreeEntries = function () {
    const entries = [];
    for (const [widgetName, folder, label, tooltip] of [
      ["unet_name", "diffusion_models", "主扩散模型", "调用方法：节点内部走官方 UNETLoader 加载 Ideogram 4 主扩散模型。"],
      ["uncond_unet_name", "diffusion_models", "无条件扩散模型", "调用方法：节点内部走官方 UNETLoader 加载 Ideogram 4 unconditional 模型。"],
      ["clip_name", "text_encoders", "文本编码器", "调用方法：节点内部走官方 CLIPLoader 按 ideogram4 类型加载文本编码器。"],
      ["vae_name", "vae", "VAE", "调用方法：节点内部走官方 VAELoader 加载 VAE。"],
    ]) {
      const value = normalizedWidgetValue(this, widgetName);
      if (!value) continue;
      entries.push({ label, value, folder, kind: folder, name: widgetName, tooltip });
    }
    if (inputLinked(this, LORA_CHAIN_INPUT)) {
      entries.push({
        label: "🔗 LoRA串联配置",
        value: "已连接外部输入",
        folder: "loras",
        kind: "loras",
        name: LORA_CHAIN_INPUT,
        tooltip: "调用方法：执行时读取 GJJ · 额外LoRA串联配置，按顺序应用到主扩散模型、无条件扩散模型与 CLIP。",
      });
    }
    return entries;
  };
}

function hideWidget(widget) {
  if (!widget) return;
  if (!widget.__gjjIdeo4DirectHidden) {
    widget.__gjjIdeo4DirectHidden = {
      type: widget.type,
      hidden: widget.hidden,
      computeSize: widget.computeSize,
      getHeight: widget.getHeight,
      draw: widget.draw,
      y: widget.y,
      last_y: widget.last_y,
      optionsHidden: widget.options?.hidden,
      optionsDisplay: widget.options?.display,
    };
  }
  widget.hidden = true;
  widget.type = `converted-widget:${widget.name || "hidden"}`;
  widget.computeSize = () => [0, 0];
  widget.getHeight = () => 0;
  widget.draw = () => {};
  widget.y = -100000;
  widget.last_y = -100000;
  widget.options ||= {};
  widget.options.hidden = true;
  widget.options.display = "hidden";
  if (widget.inputEl) widget.inputEl.style.display = "none";
  if (widget.element?.style) widget.element.style.display = "none";
}

function restoreWidget(widget, fallbackType = "") {
  const saved = widget?.__gjjIdeo4DirectHidden;
  if (!widget) return;
  const forceVisible = Boolean(fallbackType);
  if (!saved) {
    const wasConverted = String(widget.type || "").startsWith("converted-widget:");
    const wasHidden = Boolean(widget.hidden || widget.options?.hidden || widget.options?.display === "hidden");
    widget.hidden = false;
    if (fallbackType && wasConverted) {
      widget.type = fallbackType;
    }
    if (wasConverted || wasHidden) {
      delete widget.computeSize;
      delete widget.getHeight;
      delete widget.draw;
    }
    widget.options ||= {};
    delete widget.options.hidden;
    delete widget.options.display;
    if (widget.inputEl) widget.inputEl.style.display = "";
    if (widget.element?.style) widget.element.style.display = "";
    return;
  }
  const savedType = String(saved.type || "");
  widget.type = forceVisible && savedType.startsWith("converted-widget:") ? fallbackType : saved.type;
  widget.hidden = forceVisible ? false : saved.hidden;
  const savedWasHidden = Boolean(saved.hidden || saved.optionsHidden || saved.optionsDisplay === "hidden" || savedType.startsWith("converted-widget:"));
  if (!forceVisible || !savedWasHidden) {
    if (saved.computeSize) widget.computeSize = saved.computeSize;
    else delete widget.computeSize;
    if (saved.getHeight) widget.getHeight = saved.getHeight;
    else delete widget.getHeight;
    if (saved.draw) widget.draw = saved.draw;
    else delete widget.draw;
  } else {
    delete widget.computeSize;
    delete widget.getHeight;
    delete widget.draw;
  }
  widget.y = forceVisible && Number(saved.y) < 0 ? 0 : saved.y;
  widget.last_y = forceVisible && Number(saved.last_y) < 0 ? 0 : saved.last_y;
  widget.options ||= {};
  if (forceVisible) {
    delete widget.options.hidden;
    delete widget.options.display;
  } else {
    if (saved.optionsHidden === undefined) delete widget.options.hidden;
    else widget.options.hidden = saved.optionsHidden;
    if (saved.optionsDisplay === undefined) delete widget.options.display;
    else widget.options.display = saved.optionsDisplay;
  }
  if (widget.inputEl) widget.inputEl.style.display = "";
  if (widget.element?.style) widget.element.style.display = "";
  delete widget.__gjjIdeo4DirectHidden;
}

function removeInputByName(node, name) {
  const index = (node?.inputs || []).findIndex((input) => String(input?.name || "") === name || String(input?.widget?.name || "") === name);
  if (index < 0) return;
  try { node.disconnectInput?.(index); } catch (_) {}
  node.removeInput?.(index);
}

function backupParamWidget(node, name, widget) {
  if (!node || !widget) return;
  node.properties ||= {};
  const backup = { ...(node.properties[PARAM_BACKUP_PROPERTY] || {}) };
  backup[name] = {
    value: widget.value,
    options: { ...(widget.options || {}) },
  };
  node.properties[PARAM_BACKUP_PROPERTY] = backup;
}

function removeWidgetByName(node, name) {
  if (!Array.isArray(node?.widgets)) return null;
  const index = node.widgets.findIndex((widget) => String(widget?.name || "") === name);
  if (index < 0) return null;
  const [widget] = node.widgets.splice(index, 1);
  return { widget, index };
}

function insertWidgetBefore(node, widget, beforeName) {
  if (!Array.isArray(node?.widgets) || !widget) return;
  const currentIndex = node.widgets.indexOf(widget);
  if (currentIndex >= 0) node.widgets.splice(currentIndex, 1);
  const beforeIndex = node.widgets.findIndex((item) => String(item?.name || "") === beforeName);
  node.widgets.splice(beforeIndex >= 0 ? beforeIndex : node.widgets.length, 0, widget);
}

function paramLabel(name) {
  return name === "width" ? "宽度" : "高度";
}

function paramTooltip(name) {
  return name === "width"
    ? "生成宽度；执行时会按 16 倍数向上对齐。"
    : "生成高度；执行时会按 16 倍数向上对齐。";
}

function numberWidgetOptions(name, oldWidget, backupOptions = {}) {
  const backup = { ...backupOptions, ...(oldWidget?.__gjjParamBackupOptions || {}) };
  const options = { ...backup, ...(oldWidget?.options || {}) };
  options.min = Number.isFinite(Number(options.min)) ? Number(options.min) : 256;
  options.max = Number.isFinite(Number(options.max)) ? Number(options.max) : 8192;
  options.step = Number.isFinite(Number(options.step)) ? Number(options.step) : 16;
  options.round = Number.isFinite(Number(options.round)) ? Number(options.round) : 1;
  options.display_name = paramLabel(name);
  options.tooltip ||= paramTooltip(name);
  delete options.hidden;
  delete options.display;
  return options;
}

function decorateParamWidget(widget, name) {
  if (!widget) return;
  const label = paramLabel(name);
  widget.name = name;
  widget.label = label;
  widget.localized_name = label;
  widget.display_name = label;
  widget.options ||= {};
  widget.options.display_name = label;
  widget.options.tooltip ||= paramTooltip(name);
}

function ensureParamInput(node, name) {
  if (!node) return;
  let input = (node.inputs || []).find((item) => String(item?.name || "") === name || String(item?.widget?.name || "") === name);
  if (!input) {
    node.addInput?.(name, "INT");
    input = node.inputs?.[node.inputs.length - 1];
  }
  if (!input) return;
  const label = paramLabel(name);
  input.name = name;
  input.type = "INT";
  input.label = label;
  input.localized_name = label;
  input.display_name = label;
  input.tooltip = paramTooltip(name);
  input.widget = { name };
}

function replacePanelNumberWidget(node, name) {
  if (!node?.addWidget || !Array.isArray(node.widgets)) return;
  const backup = node.properties?.[PARAM_BACKUP_PROPERTY]?.[name] || {};
  const oldIndex = node.widgets.findIndex((widget) => String(widget?.name || "") === name);
  const oldWidget = oldIndex >= 0 ? node.widgets[oldIndex] : null;
  if (oldWidget) {
    restoreWidget(oldWidget, "number");
    oldWidget.value = align16Min256(oldWidget.value ?? backup.value ?? 1024);
    oldWidget.options = numberWidgetOptions(name, oldWidget, backup.options || {});
    decorateParamWidget(oldWidget, name);
    if (oldWidget.inputEl) oldWidget.inputEl.style.display = "";
    if (oldWidget.element?.style) oldWidget.element.style.display = "";
    return;
  }
  const value = align16Min256(backup.value ?? 1024);
  const options = numberWidgetOptions(name, null, backup.options || {});
  const created = node.addWidget("number", name, value, () => markCanvasDirty(), options);
  if (!created) return;
  created.value = value;
  created.options = { ...(created.options || {}), ...options };
  created.hidden = false;
  decorateParamWidget(created, name);
  if (created.inputEl) created.inputEl.style.display = "";
  if (created.element?.style) created.element.style.display = "";
  delete created.__gjjIdeo4DirectHidden;
  const currentIndex = node.widgets.indexOf(created);
  const targetIndex = oldIndex >= 0 ? oldIndex : node.widgets.findIndex((widget) => String(widget?.name || "") === "batch_size");
  if (currentIndex >= 0 && targetIndex >= 0 && currentIndex !== targetIndex) {
    node.widgets.splice(currentIndex, 1);
    node.widgets.splice(targetIndex, 0, created);
  }
  if (Array.isArray(node.widgets_values)) {
    node.widgets_values = node.widgets.map((widget) => widget?.value);
  }
}

function ensureHiddenParamWidget(node, name) {
  if (!node?.addWidget || !Array.isArray(node.widgets)) return null;
  let widget = findWidget(node, name);
  if (!widget) {
    const backup = node.properties?.[PARAM_BACKUP_PROPERTY]?.[name] || {};
    const value = align16Min256(backup.value ?? 1024);
    const options = numberWidgetOptions(name, null, backup.options || {});
    widget = node.addWidget("number", name, value, () => markCanvasDirty(), options);
    insertWidgetBefore(node, widget, "batch_size");
  }
  decorateParamWidget(widget, name);
  return widget;
}

function align16Min256(value) {
  const number = Math.max(1, Math.round(Number(value) || 1024));
  return Math.max(Math.ceil(number / 16) * 16, 256);
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(String(text || "")) ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function parseScalar(value) {
  if (typeof value !== "string") return value;
  const raw = value.trim();
  if (/^[-+]?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw)) return Number.parseFloat(raw);
  return value;
}

function splitTemplateLine(line) {
  const raw = String(line || "").trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("//") || raw.startsWith(";")) return null;
  const match = raw.match(/^([^:=：=]+?)\s*[:：=]\s*([\s\S]*)$/);
  if (!match) return null;
  let label = match[1].trim().replace(/\s*(?:\[[^\]]+?\]|【[^】]+?】)\s*$/, "").trim();
  let key = "";
  const explicit = label.match(/^(.+?)[（(]\s*([^（）()]+?)\s*[）)]$/);
  if (explicit) {
    label = explicit[1].trim();
    key = String(explicit[2] || "").split(/\s*(?:\||,|，|；|;|\bor\b|或)\s*/i)[0].trim();
  }
  let value = match[2].trim();
  const hashIndex = value.indexOf("#");
  if (hashIndex >= 0) value = value.slice(0, hashIndex).trim();
  return { key, label, value: parseScalar(value) };
}

function templateParamEntries(templateNode) {
  const entries = new Map();
  const add = (key, value) => {
    const clean = String(key || "").trim();
    if (!clean) return;
    entries.set(clean, value);
    entries.set(clean.toLowerCase(), value);
  };
  const values = safeJsonParse(findWidget(templateNode, VALUES_WIDGET)?.value, {});
  const schema = safeJsonParse(findWidget(templateNode, SCHEMA_WIDGET)?.value, []);
  if (Array.isArray(schema)) {
    for (const field of schema) {
      if (!field || typeof field !== "object") continue;
      const key = String(field.key || "").trim();
      const label = String(field.label || "").trim();
      const raw = values[key] ?? values[label] ?? field.default ?? "";
      add(key, parseScalar(raw));
      add(label, parseScalar(raw));
    }
  }
  const template = String(findWidget(templateNode, TEMPLATE_WIDGET)?.value || "");
  for (const line of template.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    const parsed = splitTemplateLine(line);
    if (!parsed) continue;
    const raw = values[parsed.key] ?? values[parsed.label] ?? parsed.value;
    add(parsed.key, parseScalar(raw));
    add(parsed.label, parseScalar(raw));
  }
  for (const [key, value] of Object.entries(values || {})) add(key, parseScalar(value));
  return entries;
}

function getParam(entries, names) {
  for (const name of names) {
    if (entries.has(name)) return entries.get(name);
    const lower = String(name || "").toLowerCase();
    if (entries.has(lower)) return entries.get(lower);
  }
  return undefined;
}

function templateNodes() {
  return (app.graph?._nodes || []).filter((node) => String(node?.comfyClass || node?.type || "") === TEMPLATE_PARAMS_NODE);
}

function templateNodeLabel(node) {
  return String(node?.title || "").trim() || `模板参数 #${node?.id ?? "?"}`;
}

function getTemplateSourceNode(node) {
  const sourceId = String(node?.properties?.[PARAM_SOURCE_PROPERTY] || "").trim();
  if (!sourceId) return null;
  return (app.graph?._nodes || []).find((item) => String(item?.id ?? "") === sourceId) || null;
}

function paramsEnabled(node) {
  return Boolean(node?.properties?.[PARAM_ENABLED_PROPERTY] && node?.properties?.[PARAM_SOURCE_PROPERTY]);
}

function applyTemplateParams(node, templateNode) {
  const entries = templateParamEntries(templateNode);
  const width = Number(getParam(entries, ["width", "宽度"]));
  const height = Number(getParam(entries, ["height", "高度"]));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  setWidgetValue(node, "width", align16Min256(width));
  setWidgetValue(node, "height", align16Min256(height));
  return true;
}

function setParamsEnabled(node, enabled, templateNode = null) {
  node.properties ||= {};
  if (enabled) {
    if (!templateNode || !applyTemplateParams(node, templateNode)) return false;
    node.properties[PARAM_ENABLED_PROPERTY] = true;
    node.properties[PARAM_SOURCE_PROPERTY] = String(templateNode.id ?? "");
  } else {
    node.properties[PARAM_ENABLED_PROPERTY] = false;
    delete node.properties[PARAM_SOURCE_PROPERTY];
  }
  applyParamVisibility(node);
  refreshButtons(node);
  return true;
}

function syncActiveTemplateParams(node) {
  if (!paramsEnabled(node)) return false;
  const sourceNode = getTemplateSourceNode(node);
  if (!sourceNode) return false;
  return applyTemplateParams(node, sourceNode);
}

function applyParamVisibility(node) {
  const active = paramsEnabled(node);
  if (active) syncActiveTemplateParams(node);
  for (const name of PARAM_WIDGETS) {
    const widget = findWidget(node, name);
    if (active) {
      const backingWidget = ensureHiddenParamWidget(node, name);
      backupParamWidget(node, name, backingWidget);
      removeInputByName(node, name);
      hideWidget(backingWidget);
    } else {
      removeInputByName(node, name);
      replacePanelNumberWidget(node, name);
    }
  }
  const computed = node.computeSize?.();
  if (Array.isArray(computed)) node.setSize?.([Math.round(node.size?.[0] || computed[0]), Math.round(computed[1])]);
  markCanvasDirty();
}

function applySettingsVisibility(node) {
  for (const name of HIDDEN_PANEL_WIDGETS) {
    const widget = findWidget(node, name);
    hideWidget(widget);
  }
  applyParamVisibility(node);
  renderSettingsPanel(node);
  renderModelPanel(node);
  refreshButtons(node);
}

function openParamsMenu(node, anchor) {
  const nodes = templateNodes();
  if (!nodes.length && !paramsEnabled(node)) {
    alert("当前工作流里没有 GJJ_TemplateParams 节点。请先添加并设置宽度、高度。");
    return;
  }
  const existing = document.querySelector(".gjj-ideo4-direct-param-menu");
  existing?.remove?.();
  const menu = document.createElement("div");
  menu.className = "gjj-ideo4-direct-param-menu";
  menu.style.cssText = [
    "position:fixed",
    "z-index:10000",
    "min-width:220px",
    "max-width:320px",
    "padding:6px",
    "border:1px solid #3e4d54",
    "border-radius:8px",
    "background:#10191d",
    "box-shadow:0 10px 28px rgba(0,0,0,.38)",
    "color:#d8e6df",
    "font:12px system-ui,'Microsoft YaHei',sans-serif",
  ].join(";");
  const addItem = (label, title, handler, active = false) => {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = label;
    item.title = title || "";
    item.style.cssText = [
      "display:block",
      "width:100%",
      "margin:0 0 4px",
      "padding:6px 8px",
      "border:1px solid " + (active ? "#6bd68d" : "#34464d"),
      "border-radius:6px",
      "background:" + (active ? "#1d4930" : "#172126"),
      "color:#e8f3ee",
      "text-align:left",
      "cursor:pointer",
    ].join(";");
    item.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handler();
      menu.remove();
    });
    menu.appendChild(item);
  };
  if (paramsEnabled(node)) addItem("关闭参数联动", "恢复面板宽度和高度控件。", () => setParamsEnabled(node, false), false);
  for (const templateNode of nodes) {
    const active = paramsEnabled(node) && String(templateNode.id ?? "") === String(node.properties?.[PARAM_SOURCE_PROPERTY] || "");
    addItem(`使用 ${templateNodeLabel(templateNode)}`, "读取 width/宽度、height/高度；宽高按 16 倍数向上对齐。", () => {
      if (!setParamsEnabled(node, true, templateNode)) alert("GJJ_TemplateParams 缺少 width/宽度 或 height/高度。");
    }, active);
  }
  document.body.appendChild(menu);
  const rect = anchor?.getBoundingClientRect?.();
  const left = Math.max(8, Math.min((rect?.left ?? 20), window.innerWidth - menu.offsetWidth - 8));
  const top = Math.max(8, Math.min((rect?.bottom ?? 20) + 4, window.innerHeight - menu.offsetHeight - 8));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  const close = (event) => {
    if (!menu.contains(event.target)) {
      menu.remove();
      document.removeEventListener("mousedown", close, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close, true), 0);
}

function injectStyle() {
  if (document.getElementById("gjj-ideogram4-direct-style")) return;
  const style = document.createElement("style");
  style.id = "gjj-ideogram4-direct-style";
  style.textContent = `
    .gjj-ideo4-direct-panel { display:flex; flex-wrap:wrap; align-content:flex-start; align-items:flex-start; gap:5px; padding:3px 0 2px; box-sizing:border-box; width:100%; color:#d8e5e8; font:12px sans-serif; pointer-events:auto; }
    .gjj-ideo4-direct-btn { flex:0 1 auto; min-width:0; height:26px; border:1px solid #465960; border-radius:5px; background:#263136; color:#cfdde1; cursor:pointer; font:700 12px sans-serif; padding:0 8px; white-space:nowrap; }
    .gjj-ideo4-direct-btn:hover { border-color:#59c38f; color:#fff; }
    .gjj-ideo4-direct-btn.active { background:#1f4937; border-color:#65d692; color:#eafff0; }
    .gjj-ideo4-direct-btn.model-keep-on { background:#174b35; border-color:#58d68d; color:#effff5; box-shadow:0 0 0 1px rgba(88,214,141,.16) inset; }
    .gjj-ideo4-direct-btn.model-keep-off { background:#2b3337; border-color:#56666d; color:#cbd5d9; }
    .gjj-ideo4-seed-btn.seed-on { background:linear-gradient(135deg,#854d0e,#ca8a04); border-color:#facc15; color:#fffbeb; box-shadow:0 0 0 1px rgba(250,204,21,.2) inset; }
    .gjj-ideo4-seed-btn.seed-off { background:linear-gradient(135deg,#1f2933,#374151); border-color:#55636f; color:#cbd5e1; }
    .gjj-ideo4-direct-settings { display:none; flex:0 0 100%; flex-direction:column; gap:6px; margin-top:3px; padding:7px; background:#20282c; border:1px solid #3b454a; border-radius:6px; color:#cfd8dc; font:11px sans-serif; box-sizing:border-box; }
    .gjj-ideo4-direct-settings.open { display:flex; }
    .gjj-ideo4-direct-field { display:grid; grid-template-columns:76px minmax(0,1fr); align-items:center; gap:6px; min-width:0; }
    .gjj-ideo4-direct-field label { color:#aebbc0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .gjj-ideo4-direct-field input, .gjj-ideo4-direct-field select { width:100%; min-width:0; box-sizing:border-box; background:#151b1e; border:1px solid #445157; border-radius:4px; color:#e0e7ea; font:12px sans-serif; padding:4px 6px; }
    .gjj-ideo4-direct-status { display:none; flex:0 0 100%; color:#aebbc0; line-height:1.35; white-space:normal; overflow-wrap:anywhere; }
    .gjj-ideo4-direct-status.show { display:block; }
    .gjj-ideo4-model-floating { position:fixed; z-index:100000; display:none; width:min(540px,calc(100vw - 28px)); max-height:min(680px,calc(100vh - 32px)); overflow:hidden; flex-direction:column; padding:10px; box-sizing:border-box; border:1px solid #586673; border-radius:9px; background:#10171b; color:#dce7e2; box-shadow:0 16px 42px rgba(0,0,0,.48); pointer-events:auto; }
    .gjj-ideo4-model-floating.open { display:flex; }
    .gjj-ideo4-model-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:0 0 8px; cursor:move; user-select:none; touch-action:none; }
    .gjj-ideo4-model-title { font-size:13px; font-weight:800; color:#f2faf7; }
    .gjj-ideo4-model-head-actions { display:flex; align-items:center; gap:6px; }
    .gjj-ideo4-model-keep { height:24px; padding:0 9px; border:1px solid #56666d; border-radius:6px; background:#222c31; color:#d3dde0; cursor:pointer; font:700 12px sans-serif; }
    .gjj-ideo4-model-keep.on { background:#174b35; border-color:#58d68d; color:#effff5; }
    .gjj-ideo4-model-close { width:26px; height:24px; border:1px solid #41535b; border-radius:6px; background:#1a2328; color:#dce7e2; cursor:pointer; }
    .gjj-ideo4-model-body { display:flex; flex-direction:column; gap:2px; min-height:0; overflow:auto; overscroll-behavior:contain; font:12px/1.35 monospace; }
    .gjj-ideo4-model-root { color:#b9c8cd; padding:2px 3px 4px; font-weight:700; }
    .gjj-ideo4-model-branch { display:grid; grid-template-columns:26px minmax(128px,.7fr) minmax(0,1.3fr); align-items:center; gap:5px; min-height:30px; padding:1px 3px; background:transparent; border:0; }
    .gjj-ideo4-model-tree-line { color:#70838b; white-space:nowrap; }
    .gjj-ideo4-model-label { color:#b9c7cc; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .gjj-ideo4-model-value { width:100%; min-width:0; height:27px; box-sizing:border-box; border:1px solid #35474f; border-radius:5px; background:#11191d; color:#e0e8eb; padding:3px 7px; text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
    .gjj-ideo4-model-value:hover { border-color:#63c495; color:#fff; }
    .gjj-ideo4-model-picker { position:fixed; z-index:100010; display:flex; flex-direction:column; gap:6px; width:min(480px,calc(100vw - 28px)); max-height:min(440px,calc(100vh - 36px)); padding:8px; box-sizing:border-box; border:1px solid #52646c; border-radius:8px; background:#0f171a; box-shadow:0 14px 34px rgba(0,0,0,.52); pointer-events:auto; }
    .gjj-ideo4-model-filter { width:100%; height:29px; box-sizing:border-box; border:1px solid #42555d; border-radius:5px; background:#172126; color:#e7eff1; padding:4px 7px; font:12px sans-serif; }
    .gjj-ideo4-model-list { display:flex; flex-direction:column; gap:2px; min-height:0; overflow:auto; }
    .gjj-ideo4-model-option { width:100%; padding:5px 7px; border:0; border-radius:4px; background:transparent; color:#cfdbdf; text-align:left; font:12px/1.35 monospace; cursor:pointer; overflow-wrap:anywhere; }
    .gjj-ideo4-model-option:hover,.gjj-ideo4-model-option.active { background:#234333; color:#effff5; }
  `;
  document.head.appendChild(style);
}

function stopProp(element) {
  for (const eventName of ["mousedown", "pointerdown", "wheel"]) {
    element.addEventListener(eventName, (event) => event.stopPropagation());
  }
}

function widgetLabel(name) {
  const labels = {
    unet_name: "主扩散模型",
    uncond_unet_name: "无条件模型",
    clip_name: "文本编码器",
    vae_name: "VAE",
    cfg: "CFG",
    override_cfg: "覆盖CFG",
    override_start: "覆盖起点",
    override_end: "覆盖终点",
    sampler_name: "采样器",
    weight_dtype: "加载精度",
    batch_size: "批次数",
    seed: "种子",
  };
  return labels[name] || name;
}

function clampFloatingPosition(panel, left, top) {
  const padding = 14;
  const rect = panel.getBoundingClientRect();
  return {
    left: Math.max(padding, Math.min(left, window.innerWidth - rect.width - padding)),
    top: Math.max(padding, Math.min(top, window.innerHeight - rect.height - padding)),
  };
}

function positionModelPanel(node) {
  const state = node?.__gjjIdeogram4DirectPanel;
  const panel = state?.modelPanel;
  if (!panel || panel.__gjjManualPosition) return;
  const anchor = state.modelButton?.getBoundingClientRect?.();
  const position = clampFloatingPosition(panel, anchor?.left ?? 20, (anchor?.bottom ?? 20) + 6);
  panel.style.left = `${Math.round(position.left)}px`;
  panel.style.top = `${Math.round(position.top)}px`;
}

function positionSettingsPanel(node) {
  const state = node?.__gjjIdeogram4DirectPanel;
  const panel = state?.settingsFloating;
  if (!panel || panel.__gjjManualPosition) return;
  const anchor = state.settingsButton?.getBoundingClientRect?.();
  const position = clampFloatingPosition(panel, anchor?.left ?? 20, (anchor?.bottom ?? 20) + 6);
  panel.style.left = `${Math.round(position.left)}px`;
  panel.style.top = `${Math.round(position.top)}px`;
}

function makeModelPanelDraggable(panel, handle) {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target?.closest?.("button,input,select")) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = panel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    panel.__gjjManualPosition = true;
    handle.setPointerCapture?.(event.pointerId);
    const move = (moveEvent) => {
      const position = clampFloatingPosition(panel, moveEvent.clientX - offsetX, moveEvent.clientY - offsetY);
      panel.style.left = `${Math.round(position.left)}px`;
      panel.style.top = `${Math.round(position.top)}px`;
    };
    const stop = (stopEvent) => {
      handle.releasePointerCapture?.(stopEvent.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  });
}

function createFloatingPanel(node, kind, titleText) {
  const panel = document.createElement("div");
  panel.className = "gjj-ideo4-model-floating";
  stopProp(panel);
  for (const eventName of ["click", "dblclick", "contextmenu", "keydown", "keyup"]) {
    panel.addEventListener(eventName, (event) => event.stopPropagation());
  }
  const head = document.createElement("div");
  head.className = "gjj-ideo4-model-head";
  const title = document.createElement("div");
  title.className = "gjj-ideo4-model-title";
  title.textContent = titleText;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "gjj-ideo4-model-close";
  close.textContent = "×";
  close.title = "关闭";
  close.addEventListener("click", () => {
    if (kind === "model") setModelPanelOpen(node, false);
    else setSettingsPanelOpen(node, false);
  });
  const actions = document.createElement("div");
  actions.className = "gjj-ideo4-model-head-actions";
  actions.appendChild(close);
  head.append(title, actions);
  makeModelPanelDraggable(panel, head);
  const body = document.createElement("div");
  body.className = "gjj-ideo4-model-body";
  panel.append(head, body);
  document.body.appendChild(panel);
  return { panel, body, head, actions, close };
}

function setModelPanelOpen(node, open) {
  node.properties ||= {};
  node.properties[MODEL_SETTINGS_PROPERTY] = Boolean(open);
  if (!open) closeModelPicker(node);
  if (!open && node.__gjjIdeogram4DirectPanel?.modelPanel) {
    node.__gjjIdeogram4DirectPanel.modelPanel.__gjjManualPosition = false;
  }
  if (open) {
    node.properties[SETTINGS_PROPERTY] = false;
    if (node.__gjjIdeogram4DirectPanel?.settingsFloating) {
      node.__gjjIdeogram4DirectPanel.settingsFloating.classList.remove("open");
    }
  }
  renderSettingsPanel(node);
  renderModelPanel(node);
  refreshButtons(node);
}

function setSettingsPanelOpen(node, open) {
  node.properties ||= {};
  node.properties[SETTINGS_PROPERTY] = Boolean(open);
  closeModelPicker(node);
  if (!open && node.__gjjIdeogram4DirectPanel?.settingsFloating) {
    node.__gjjIdeogram4DirectPanel.settingsFloating.__gjjManualPosition = false;
  }
  if (open) {
    node.properties[MODEL_SETTINGS_PROPERTY] = false;
    node.__gjjIdeogram4DirectPanel?.modelPanel?.classList.remove("open");
  }
  renderSettingsPanel(node);
  renderModelPanel(node);
  refreshButtons(node);
}

function closeModelPicker(node) {
  const picker = node?.__gjjIdeogram4ModelPicker;
  if (!picker) return;
  picker.__cleanup?.();
  picker.remove();
  node.__gjjIdeogram4ModelPicker = null;
}

function openModelPicker(node, name, anchor) {
  closeModelPicker(node);
  const widget = findWidget(node, name);
  const choices = branchModelChoices(name, widgetChoices(widget) || []);
  if (!choices.length) return;

  const picker = document.createElement("div");
  picker.className = "gjj-ideo4-model-picker";
  const filter = document.createElement("input");
  filter.className = "gjj-ideo4-model-filter";
  filter.type = "search";
  filter.value = MODEL_FILTER_DEFAULTS[name] ?? "ideogram";
  filter.placeholder = "过滤模型...";
  const list = document.createElement("div");
  list.className = "gjj-ideo4-model-list";
  picker.append(filter, list);
  document.body.appendChild(picker);
  node.__gjjIdeogram4ModelPicker = picker;
  for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "keydown", "keyup"]) {
    picker.addEventListener(eventName, (event) => event.stopPropagation());
  }
  picker.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

  const render = () => {
    const query = filter.value.trim().toLocaleLowerCase();
    const current = String(widget?.value ?? "");
    const visible = choices.filter((choice) => !query || choice.toLocaleLowerCase().includes(query));
    if (current && choices.includes(current) && !visible.includes(current)) visible.unshift(current);
    list.innerHTML = "";
    for (const choice of visible) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "gjj-ideo4-model-option";
      option.classList.toggle("active", choice === current);
      option.textContent = choice || "未选择";
      option.addEventListener("click", () => {
        setWidgetValue(node, name, choice);
        syncPairedIdeogramModel(node, name, choice);
        markCanvasDirty();
        setModelPanelOpen(node, false);
      });
      list.appendChild(option);
    }
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "gjj-ideo4-model-path";
      empty.textContent = `没有匹配“${filter.value}”的模型`;
      list.appendChild(empty);
    }
  };
  filter.addEventListener("input", render);
  render();

  const rect = anchor.getBoundingClientRect();
  const width = Math.min(480, window.innerWidth - 28);
  const left = Math.max(14, Math.min(rect.left, window.innerWidth - width - 14));
  const top = Math.max(14, Math.min(rect.bottom + 5, window.innerHeight - Math.min(440, picker.offsetHeight) - 14));
  picker.style.left = `${Math.round(left)}px`;
  picker.style.top = `${Math.round(top)}px`;
  const outside = (event) => {
    if (!picker.contains(event.target) && event.target !== anchor) closeModelPicker(node);
  };
  picker.__cleanup = () => document.removeEventListener("pointerdown", outside, true);
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  filter.focus();
  filter.select();
}

function widgetChoices(widget) {
  const values = widget?.options?.values || widget?.options?.items || widget?.values;
  return Array.isArray(values) ? values.map((value) => String(value)) : null;
}

function isUnconditionalModelName(value) {
  return /(?:^|[\\/_.-])unconditional(?:[\\/_.-]|$)|(?:^|[\\/_.-])uncond(?:[\\/_.-]|$)/i.test(String(value || ""));
}

function pairedModelKey(value) {
  return String(value || "")
    .toLocaleLowerCase()
    .replace(/\.(?:safetensors|gguf|bin|pt|pth|ckpt)$/i, "")
    .replace(/(?:^|[\\/_.-])(?:unconditional|uncond)(?=[\\/_.-]|$)/gi, "_")
    .replace(/[\\/_.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function branchModelChoices(name, choices) {
  if (name === "unet_name") return choices.filter((choice) => !isUnconditionalModelName(choice));
  if (name === "uncond_unet_name") return choices.filter((choice) => isUnconditionalModelName(choice));
  return choices;
}

function syncPairedIdeogramModel(node, changedName, selectedValue) {
  if (changedName !== "unet_name" && changedName !== "uncond_unet_name") return;
  const targetName = changedName === "unet_name" ? "uncond_unet_name" : "unet_name";
  const targetWidget = findWidget(node, targetName);
  const targetChoices = branchModelChoices(targetName, widgetChoices(targetWidget) || []);
  const key = pairedModelKey(selectedValue);
  const match = targetChoices.find((choice) => pairedModelKey(choice) === key);
  if (match) setWidgetValue(node, targetName, match);
}

function makeSettingField(node, name) {
  const widget = findWidget(node, name);
  if (!widget || name === "mode") return null;
  const row = document.createElement("div");
  row.className = "gjj-ideo4-direct-field";
  const label = document.createElement("label");
  label.textContent = widgetLabel(name);
  label.title = widget?.options?.tooltip || widgetLabel(name);
  row.appendChild(label);
  const choices = widgetChoices(widget);
  let input;
  if (choices?.length) {
    input = document.createElement("select");
    for (const choice of choices) {
      const option = document.createElement("option");
      option.value = choice;
      option.textContent = choice || "未选择";
      input.appendChild(option);
    }
  } else {
    input = document.createElement("input");
    input.type = widget?.type === "number" || widget?.type === "INT" || widget?.type === "FLOAT" ? "number" : "text";
  }
  input.value = getWidgetValue(node, name) ?? "";
  input.title = widget?.options?.tooltip || "";
  stopProp(input);
  const commit = () => {
    let value = input.value;
    if (widget?.type === "number" || widget?.type === "INT") value = Number.parseInt(value || "0", 10);
    if (widget?.type === "FLOAT") value = Number.parseFloat(value || "0");
    setWidgetValue(node, name, value);
    markCanvasDirty();
  };
  input.addEventListener("input", commit);
  input.addEventListener("change", commit);
  row.appendChild(input);
  return row;
}

function fitNode(node) {
  const computed = node?.computeSize?.();
  if (!Array.isArray(computed)) return;
  const currentW = Math.round(node.size?.[0] || computed[0]);
  const nextH = Math.round(computed[1]);
  if (Math.abs((node.size?.[1] || 0) - nextH) > 1) {
    node.setSize?.([currentW, nextH]);
  }
  markCanvasDirty();
}

function panelHeight(node) {
  const state = node.__gjjIdeogram4DirectPanel;
  if (!state) return 32;
  const root = state.root;
  if (!root) return 32;
  const style = window.getComputedStyle?.(root);
  const paddingBottom = Number.parseFloat(style?.paddingBottom || "0") || 0;
  let contentBottom = 0;
  for (const child of root.children || []) {
    if (!child?.getClientRects?.().length) continue;
    const bottom = Number(child.offsetTop || 0) + Number(child.offsetHeight || child.scrollHeight || 0);
    contentBottom = Math.max(contentBottom, bottom);
  }
  return Math.max(32, Math.round(contentBottom + paddingBottom + 2));
}

function renderSettingsPanel(node) {
  const state = node.__gjjIdeogram4DirectPanel;
  if (!state?.settingsPanel || !state?.settingsFloating) return;
  const panel = state.settingsPanel;
  const open = Boolean(node?.properties?.[SETTINGS_PROPERTY]);
  panel.innerHTML = "";
  state.settingsFloating.classList.toggle("open", open);
  if (open) {
    for (const name of SETTINGS_WIDGETS) {
      const field = makeSettingField(node, name);
      if (field) panel.appendChild(field);
    }
    requestAnimationFrame(() => positionSettingsPanel(node));
  }
}

function renderModelPanel(node) {
  const state = node.__gjjIdeogram4DirectPanel;
  if (!state?.modelPanel || !state?.modelBody) return;
  const open = Boolean(node?.properties?.[MODEL_SETTINGS_PROPERTY]);
  state.modelPanel.classList.toggle("open", open);
  state.modelBody.innerHTML = "";
  if (open) {
    const root = document.createElement("div");
    root.className = "gjj-ideo4-model-root";
    root.textContent = "📁 models/";
    state.modelBody.appendChild(root);
    MODEL_WIDGETS.forEach((name, index) => {
      const meta = MODEL_TREE_META[name];
      const branch = document.createElement("div");
      branch.className = "gjj-ideo4-model-branch";
      const line = document.createElement("span");
      line.className = "gjj-ideo4-model-tree-line";
      line.textContent = index === MODEL_WIDGETS.length - 1 ? "└─" : "├─";
      const label = document.createElement("span");
      label.className = "gjj-ideo4-model-label";
      label.textContent = `${name === "lora_name" ? "🧠" : "📁"} ${meta.label}`;
      label.title = meta.path;
      const widget = findWidget(node, name);
      const choices = widgetChoices(widget);
      let control;
      if (choices?.length) {
        control = document.createElement("button");
        control.type = "button";
        control.className = "gjj-ideo4-model-value";
        control.textContent = String(widget?.value || "未选择");
        const defaultFilter = MODEL_FILTER_DEFAULTS[name] ?? "ideogram";
        control.title = `${meta.path}\n点击选择；列表顶部默认过滤${defaultFilter ? ` ${defaultFilter}` : "词为空"}`;
        control.addEventListener("click", () => openModelPicker(node, name, control));
      } else {
        control = document.createElement("input");
        control.className = "gjj-ideo4-model-value";
        control.type = "number";
        control.value = widget?.value ?? 1.0;
        control.addEventListener("input", () => {
          setWidgetValue(node, name, Number.parseFloat(control.value || "0"));
          markCanvasDirty();
        });
      }
      branch.append(line, label, control);
      state.modelBody.appendChild(branch);
    });
    requestAnimationFrame(() => positionModelPanel(node));
  }
}

function refreshButtons(node) {
  const state = node.__gjjIdeogram4DirectPanel;
  if (!state) return;
  const mode = String(findWidget(node, "mode")?.value || "默认");
  if (state.modeButton) {
    const labels = { "质量": "🐭质量", "默认": "🐴默认", "极速": "🚀急速" };
    state.modeButton.textContent = labels[mode] || `🐴${mode}`;
    state.modeButton.dataset.mode = mode;
    state.modeButton.title = `当前模式：${mode}。点击切换下一档。`;
  }
  if (state.paramsButton) {
    const active = paramsEnabled(node);
    const sourceNode = getTemplateSourceNode(node);
    state.paramsButton.classList.toggle("active", active);
    state.paramsButton.setAttribute("aria-pressed", active ? "true" : "false");
    state.paramsButton.textContent = active ? "⚡联动" : "⚡";
    state.paramsButton.title = active
      ? `宽度和高度已由 ${sourceNode ? templateNodeLabel(sourceNode) : "GJJ_TemplateParams"} 接管。`
      : "从 GJJ_TemplateParams 读取 width/宽度、height/高度，并隐藏面板宽高控件。";
  }
  if (state.settingsButton) {
    const open = Boolean(node.properties?.[SETTINGS_PROPERTY]);
    state.settingsButton.classList.toggle("active", open);
    state.settingsButton.setAttribute("aria-pressed", open ? "true" : "false");
  }
  if (state.modelButton) {
    const open = Boolean(node.properties?.[MODEL_SETTINGS_PROPERTY]);
    const keep = keepModelEnabled(node);
    state.modelButton.classList.toggle("active", open);
    state.modelButton.classList.toggle("model-keep-on", keep);
    state.modelButton.classList.toggle("model-keep-off", !keep);
    state.modelButton.setAttribute("aria-pressed", open ? "true" : "false");
    state.modelButton.title = `打开 Ideogram 4 模型树；保持模型${keep ? "已开启" : "已关闭"}。`;
  }
  if (state.keepModelButton) {
    const keep = keepModelEnabled(node);
    state.keepModelButton.classList.toggle("on", keep);
    state.keepModelButton.textContent = keep ? "保持模型：开" : "保持模型：关";
    state.keepModelButton.title = keep
      ? "生成完成后保留模型缓存；点击改为用后卸载。"
      : "生成完成后卸载模型缓存；点击改为保持模型。";
    state.keepModelButton.setAttribute("aria-pressed", keep ? "true" : "false");
  }
  if (state.seedButton) {
    const enabled = randomSeedEnabled(node);
    state.seedButton.classList.toggle("seed-on", enabled);
    state.seedButton.classList.toggle("seed-off", !enabled);
    state.seedButton.setAttribute("aria-pressed", enabled ? "true" : "false");
    state.seedButton.title = enabled
      ? "随机种：开启。每次执行自动换种；点击会立即换种并关闭。"
      : "随机种：关闭。点击会立即换种并开启每次执行自动换种。";
  }
}

function escapeTestHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sortedTestModels(models, sortMode) {
  const items = [...(Array.isArray(models) ? models : [])];
  const name = (item) => String(item?.name || "").toLocaleLowerCase();
  const bytes = (item) => Number(item?.bytes || 0);
  if (sortMode === "name_desc") {
    items.sort((a, b) => name(b).localeCompare(name(a), "zh-Hans") || bytes(b) - bytes(a));
  } else if (sortMode === "size_desc") {
    items.sort((a, b) => bytes(b) - bytes(a) || name(a).localeCompare(name(b), "zh-Hans"));
  } else if (sortMode === "size_asc") {
    items.sort((a, b) => bytes(a) - bytes(b) || name(a).localeCompare(name(b), "zh-Hans"));
  } else {
    items.sort((a, b) => name(a).localeCompare(name(b), "zh-Hans") || bytes(b) - bytes(a));
  }
  return items;
}

async function fetchIdeogram4TestModels(node) {
  try {
    const response = await api.fetchApi("/gjj/ideogram4-direct/test-models");
    if (response?.ok) {
      const data = await response.json();
      return (Array.isArray(data?.models) ? data.models : []).map((item) => ({
        name: String(item?.name || ""),
        size: String(item?.size || ""),
        bytes: Number(item?.bytes || 0),
        unconditional: String(item?.unconditional || ""),
        available: Boolean(item?.available),
      })).filter((item) => item.name);
    }
  } catch (error) {
    console.warn("[GJJ Ideogram4] 无法读取批测模型接口，改用主模型下拉列表。", error);
  }
  const values = findWidget(node, "unet_name")?.options?.values;
  return (Array.isArray(values) ? values : []).map((name) => ({
    name: String(name || ""),
    size: "",
    bytes: 0,
    unconditional: "",
    available: true,
  })).filter((item) => item.name);
}

function openModelTestDialog(node, testButton) {
  node.__gjjIdeogram4TestOverlay?.remove?.();
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.64);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:14px;box-sizing:border-box;";
  const panel = document.createElement("div");
  panel.style.cssText = "width:min(720px,calc(100vw - 28px));height:min(640px,calc(100vh - 28px));border:1px solid #40525b;border-radius:8px;background:#0f171b;color:#e7f2f4;box-shadow:0 22px 60px rgba(0,0,0,.56);display:flex;flex-direction:column;font:12px/1.4 system-ui,'Microsoft YaHei',sans-serif;overflow:hidden;";
  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2c3e45;">
      <div style="font-weight:800;font-size:14px;flex:1 1 auto;">🧪 Ideogram 4 主模型批量测试</div>
      <button data-close style="width:28px;height:28px;border:1px solid #465a62;border-radius:6px;background:#17242a;color:#e7f2f4;cursor:pointer;">×</button>
    </div>
    <div style="display:flex;gap:8px;padding:10px 12px 8px;">
      <input data-filter placeholder="按模型名称筛选" style="flex:1 1 auto;height:30px;border:1px solid #3f535b;border-radius:6px;background:#071014;color:#dce7e2;padding:0 9px;outline:none;">
      <button data-select-all style="height:30px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;cursor:pointer;padding:0 9px;font-weight:700;">全选可用</button>
      <button data-clear style="height:30px;border:1px solid #40535b;border-radius:6px;background:#1b2730;color:#dce7e2;cursor:pointer;padding:0 9px;font-weight:700;">清空</button>
    </div>
    <div data-sort style="display:flex;align-items:center;gap:6px;padding:0 12px 8px;flex-wrap:wrap;">
      <span style="color:#91a7ad;font-weight:700;">排序</span>
    </div>
    <div data-status style="padding:0 12px 7px;color:#91a7ad;min-height:18px;"></div>
    <div data-list style="flex:1 1 auto;overflow:auto;padding:0 12px 12px;display:flex;flex-direction:column;gap:5px;"></div>
    <div style="padding:8px 12px;color:#91a7ad;border-top:1px solid #263940;">输出文件名：主模型名_宽×高_耗时；自动匹配同版本 unconditional。</div>
    <div style="display:flex;justify-content:flex-end;gap:8px;padding:10px 12px;border-top:1px solid #2c3e45;">
      <button data-cancel style="height:32px;border:1px solid #4b5f67;border-radius:6px;background:#17242a;color:#dce7e2;cursor:pointer;padding:0 12px;font-weight:700;">取消</button>
      <button data-ok style="height:32px;border:1px solid #10b981;border-radius:6px;background:linear-gradient(135deg,#064e3b,#059669);color:#d1fae5;cursor:pointer;padding:0 14px;font-weight:800;">加入批测队列</button>
    </div>
  `;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  node.__gjjIdeogram4TestOverlay = overlay;
  const list = panel.querySelector("[data-list]");
  const status = panel.querySelector("[data-status]");
  const filter = panel.querySelector("[data-filter]");
  const sortBar = panel.querySelector("[data-sort]");
  const hasSavedFilter = Object.prototype.hasOwnProperty.call(
    node?.properties || {},
    TEST_FILTER_PROPERTY,
  );
  const state = {
    models: [],
    filter: hasSavedFilter
      ? String(node?.properties?.[TEST_FILTER_PROPERTY] ?? "")
      : "ideogram",
    sort: String(node?.properties?.[TEST_SORT_PROPERTY] || "name_asc"),
  };
  filter.value = state.filter;

  const selectedNames = () => [...panel.querySelectorAll("input[data-model-name]:checked")]
    .map((input) => input.dataset.modelName)
    .filter(Boolean);

  function saveState() {
    node.properties ||= {};
    node.properties[TEST_FILTER_PROPERTY] = state.filter;
    node.properties[TEST_SORT_PROPERTY] = state.sort;
    markCanvasDirty();
  }

  function renderSort() {
    sortBar.querySelectorAll("button[data-sort-mode]").forEach((button) => button.remove());
    for (const option of [
      ["name_asc", "名称↑"],
      ["name_desc", "名称↓"],
      ["size_desc", "大小↓"],
      ["size_asc", "大小↑"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.sortMode = option[0];
      button.textContent = option[1];
      const active = state.sort === option[0];
      button.style.cssText = `height:26px;border:1px solid ${active ? "#65d189" : "#40535b"};border-radius:6px;background:${active ? "#1d5d39" : "#1b2730"};color:#fff;cursor:pointer;padding:0 8px;font-weight:700;`;
      button.onclick = () => {
        state.sort = option[0];
        saveState();
        renderSort();
        renderList();
      };
      sortBar.appendChild(button);
    }
  }

  function renderList() {
    const selected = new Set(selectedNames());
    const query = state.filter.trim().toLocaleLowerCase();
    const visible = sortedTestModels(
      state.models.filter((item) => !query || String(item.name).toLocaleLowerCase().includes(query)),
      state.sort,
    );
    list.innerHTML = "";
    for (const item of visible) {
      const row = document.createElement("label");
      const disabled = !item.available;
      const pairTitle = disabled
        ? "缺少对应 unconditional"
        : `unconditional：${item.unconditional}`;
      row.title = pairTitle;
      row.style.cssText = `display:grid;grid-template-columns:22px minmax(0,1fr);align-items:center;gap:7px;min-height:34px;padding:5px 7px;border:1px solid #263940;border-radius:6px;background:#111d22;${disabled ? "opacity:.52;cursor:not-allowed;" : "cursor:pointer;"}`;
      row.innerHTML = `
        <input type="checkbox" data-model-name="${escapeTestHtml(item.name)}" ${selected.has(item.name) ? "checked" : ""} ${disabled ? "disabled" : ""}>
        <span style="display:flex;align-items:center;gap:10px;min-width:0;white-space:nowrap;">
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:650;color:${disabled ? "#fca5a5" : "#e7f2f4"};">${escapeTestHtml(item.name)}</span>
          <span style="flex:0 0 auto;color:${disabled ? "#fca5a5" : "#92a7ad"};font-variant-numeric:tabular-nums;">${disabled ? "缺少 unconditional" : `${escapeTestHtml(item.size)} ×2`}</span>
        </span>
      `;
      list.appendChild(row);
    }
    status.textContent = `主模型：${visible.length}/${state.models.length}，已选 ${selectedNames().length}`;
  }

  const close = () => {
    overlay.remove();
    if (node.__gjjIdeogram4TestOverlay === overlay) node.__gjjIdeogram4TestOverlay = null;
  };
  panel.querySelector("[data-close]").onclick = close;
  panel.querySelector("[data-cancel]").onclick = close;
  overlay.onclick = (event) => { if (event.target === overlay) close(); };
  filter.oninput = () => {
    state.filter = filter.value;
    saveState();
    renderList();
  };
  list.onchange = renderList;
  panel.querySelector("[data-select-all]").onclick = () => {
    panel.querySelectorAll("input[data-model-name]:not(:disabled)").forEach((input) => { input.checked = true; });
    renderList();
  };
  panel.querySelector("[data-clear]").onclick = () => {
    panel.querySelectorAll("input[data-model-name]").forEach((input) => { input.checked = false; });
    renderList();
  };
  panel.querySelector("[data-ok]").onclick = async () => {
    const models = selectedNames();
    if (!models.length) {
      status.textContent = "请至少选择一个有 unconditional 配对的主模型。";
      return;
    }
    const configWidget = findWidget(node, TEST_CONFIG_WIDGET);
    if (!configWidget) {
      status.textContent = "缺少模型测试配置控件，请重启 ComfyUI 后重试。";
      return;
    }
    setWidgetValue(node, TEST_CONFIG_WIDGET, JSON.stringify({ models, requested_at: new Date().toISOString() }));
    close();
    const original = testButton.textContent;
    testButton.textContent = "⏳";
    testButton.disabled = true;
    clearFinalPreview(node);
    try {
      const ok = await queueOnlyCurrentNode(node);
      testButton.textContent = ok ? "✅" : "❌";
    } catch (error) {
      console.error("[GJJ Ideogram4] 批量测试提交失败", error);
      testButton.textContent = "❌";
    } finally {
      setWidgetValue(node, TEST_CONFIG_WIDGET, "");
      setTimeout(() => {
        testButton.textContent = original;
        testButton.disabled = false;
      }, 1200);
    }
  };

  renderSort();
  status.textContent = "正在读取 Ideogram 4 主模型...";
  void fetchIdeogram4TestModels(node).then((models) => {
    state.models = models;
    renderList();
  });
}

function previewImageUrl(item) {
  if (!item?.filename) return "";
  const previewFormat = typeof app.getPreviewFormatParam === "function"
    ? app.getPreviewFormatParam()
    : "";
  const randParam = typeof app.getRandParam === "function" ? app.getRandParam() : "";
  return api.apiURL(
    `/view?filename=${encodeURIComponent(item.filename)}&type=${encodeURIComponent(item.type || "temp")}&subfolder=${encodeURIComponent(item.subfolder || "")}${previewFormat}${randParam}`,
  );
}

function openFinalPreviewOverlay(items, startIndex = 0) {
  const sources = (Array.isArray(items) ? items : []).map(previewImageUrl).filter(Boolean);
  if (!sources.length) return;
  let index = Math.max(0, Math.min(sources.length - 1, Number(startIndex) || 0));
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.9);backdrop-filter:blur(8px);cursor:zoom-out;";
  const image = document.createElement("img");
  image.style.cssText = "max-width:92%;max-height:92%;object-fit:contain;border-radius:8px;box-shadow:0 18px 60px rgba(0,0,0,.55);cursor:default;";
  const label = document.createElement("div");
  label.style.cssText = "position:absolute;bottom:18px;left:50%;transform:translateX(-50%);color:#fff;font:12px system-ui,'Microsoft YaHei',sans-serif;opacity:.76;";
  const show = () => {
    image.src = sources[index];
    label.textContent = sources.length > 1
      ? `${index + 1}/${sources.length} · ← → 切换 · 点击背景关闭`
      : "点击背景关闭";
  };
  const close = () => {
    document.removeEventListener("keydown", onKeydown, true);
    overlay.remove();
  };
  const onKeydown = (event) => {
    if (event.key === "Escape") close();
    else if (event.key === "ArrowLeft" && sources.length > 1) {
      index = (index - 1 + sources.length) % sources.length;
      show();
    } else if (event.key === "ArrowRight" && sources.length > 1) {
      index = (index + 1) % sources.length;
      show();
    }
  };
  image.onclick = (event) => event.stopPropagation();
  overlay.onclick = close;
  overlay.append(image, label);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKeydown, true);
  show();
}

function finalPreviewHeight(node, width = null) {
  const items = node?.__gjjIdeogram4PreviewItems || [];
  if (!items.length) return 0;
  const contentWidth = Math.max(120, Math.round(Number(width || node?.size?.[0] || 360) - 20));
  const columns = items.length === 1 ? 1 : Math.min(3, items.length);
  const rows = Math.ceil(items.length / columns);
  const gap = 5;
  const cellWidth = Math.max(60, (contentWidth - gap * (columns - 1)) / columns);
  const first = items[0] || {};
  const ratio = Number(first.height || 1) / Math.max(1, Number(first.width || 1));
  return Math.max(96, Math.ceil(rows * cellWidth * ratio + gap * (rows - 1) + 4));
}

function ensureFinalPreviewWidget(node) {
  if (node.__gjjIdeogram4PreviewWidget || typeof node.addDOMWidget !== "function") {
    return node.__gjjIdeogram4PreviewWidget;
  }
  const container = document.createElement("div");
  container.style.cssText = "display:grid;width:100%;gap:5px;box-sizing:border-box;overflow:hidden;";
  const widget = node.addDOMWidget(PREVIEW_WIDGET_NAME, "HTML", container, { serialize: false });
  widget.computeSize = (width) => [
    Math.max(120, Math.round(Number(width || node?.size?.[0] || 360) - 20)),
    finalPreviewHeight(node, width),
  ];
  widget.getHeight = () => finalPreviewHeight(node);
  node.__gjjIdeogram4PreviewWidget = widget;
  node.__gjjIdeogram4PreviewContainer = container;
  return widget;
}

function updateFinalPreview(node, images) {
  const items = (Array.isArray(images) ? images : []).filter((item) => item?.filename);
  if (!items.length) return;
  ensureFinalPreviewWidget(node);
  const container = node.__gjjIdeogram4PreviewContainer;
  if (!container) return;
  node.__gjjIdeogram4PreviewItems = items;
  const columns = items.length === 1 ? 1 : Math.min(3, items.length);
  container.style.gridTemplateColumns = `repeat(${columns},minmax(0,1fr))`;
  container.replaceChildren();
  items.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.title = "点击查看最终大图";
    button.style.cssText = "display:block;min-width:0;padding:0;border:1px solid #33434a;border-radius:8px;background:#0f1418;overflow:hidden;cursor:pointer;";
    const image = document.createElement("img");
    image.src = previewImageUrl(item);
    image.alt = "Ideogram 4 最终预览";
    image.style.cssText = "display:block;width:100%;height:100%;object-fit:contain;background:#0f1418;";
    image.onload = () => {
      if (!item.width) item.width = image.naturalWidth;
      if (!item.height) item.height = image.naturalHeight;
      requestAnimationFrame(() => fitNode(node));
    };
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openFinalPreviewOverlay(items, index);
    };
    button.appendChild(image);
    container.appendChild(button);
  });
  requestAnimationFrame(() => fitNode(node));
}

function clearFinalPreview(node) {
  node.__gjjIdeogram4PreviewItems = [];
  node.__gjjIdeogram4PreviewContainer?.replaceChildren?.();
  requestAnimationFrame(() => fitNode(node));
}

function addPanel(node) {
  if (node.__gjjIdeogram4DirectPanel || typeof node.addDOMWidget !== "function") return;
  const root = document.createElement("div");
  root.className = "gjj-ideo4-direct-panel";
  const modeButton = document.createElement("button");
  modeButton.type = "button";
  modeButton.className = "gjj-ideo4-direct-btn active";
  modeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const modes = ["质量", "默认", "极速"];
    const current = String(getWidgetValue(node, "mode") || "默认");
    const next = modes[(Math.max(0, modes.indexOf(current)) + 1) % modes.length];
    setWidgetValue(node, "mode", next);
    refreshButtons(node);
    markCanvasDirty();
  });
  root.appendChild(modeButton);
  const paramsButton = document.createElement("button");
  paramsButton.type = "button";
  paramsButton.className = "gjj-ideo4-direct-btn";
  paramsButton.textContent = "⚡";
  paramsButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openParamsMenu(node, paramsButton);
  });
  root.appendChild(paramsButton);
  const seedButton = document.createElement("button");
  seedButton.type = "button";
  seedButton.className = "gjj-ideo4-direct-btn gjj-ideo4-seed-btn seed-off";
  seedButton.textContent = "🎲";
  seedButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setRandomSeedEnabled(node, !randomSeedEnabled(node));
  });
  root.appendChild(seedButton);
  const modelButton = document.createElement("button");
  modelButton.type = "button";
  modelButton.className = "gjj-ideo4-direct-btn";
  modelButton.textContent = "🧠";
  modelButton.title = "打开 Ideogram 4 模型树。";
  modelButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setModelPanelOpen(node, !Boolean(node.properties?.[MODEL_SETTINGS_PROPERTY]));
  });
  root.appendChild(modelButton);
  const testButton = document.createElement("button");
  testButton.type = "button";
  testButton.className = "gjj-ideo4-direct-btn";
  testButton.textContent = "🧪";
  testButton.title = "按名称或大小排序并批量测试 Ideogram 4 主模型。";
  testButton.setAttribute("aria-label", "模型批量测试");
  testButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openModelTestDialog(node, testButton);
  });
  root.appendChild(testButton);
  const settingsButton = document.createElement("button");
  settingsButton.type = "button";
  settingsButton.className = "gjj-ideo4-direct-btn";
  settingsButton.textContent = "⚙️设置";
  settingsButton.title = "展开或收起高级采样设置。";
  settingsButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setSettingsPanelOpen(node, !Boolean(node.properties?.[SETTINGS_PROPERTY]));
  });
  root.appendChild(settingsButton);
  const executeButton = document.createElement("button");
  executeButton.type = "button";
  executeButton.className = "gjj-ideo4-direct-btn";
  executeButton.textContent = "▶️";
  executeButton.title = "执行当前 Ideogram 4 节点。";
  executeButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    executeButton.disabled = true;
    try {
      await queueOnlyCurrentNode(node);
    } finally {
      executeButton.disabled = false;
    }
  });
  root.appendChild(executeButton);
  const status = document.createElement("div");
  status.className = "gjj-ideo4-direct-status";
  root.appendChild(status);
  const widget = node.addDOMWidget("gjj_ideogram4_direct_buttons", "HTML", root, { serialize: false });
  const widgetIndex = node.widgets?.indexOf(widget);
  if (widgetIndex > 0) {
    node.widgets.splice(widgetIndex, 1);
    node.widgets.unshift(widget);
  }
  widget.computeSize = (width) => [Math.round(width || node.size?.[0] || 360), panelHeight(node)];
  widget.getHeight = () => panelHeight(node);
  const floating = createFloatingPanel(node, "model", "🧠 Ideogram 4 模型树");
  const keepModelButton = document.createElement("button");
  keepModelButton.type = "button";
  keepModelButton.className = "gjj-ideo4-model-keep";
  keepModelButton.addEventListener("pointerdown", (event) => event.stopPropagation());
  keepModelButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setKeepModelEnabled(node, !keepModelEnabled(node));
  });
  floating.actions.insertBefore(keepModelButton, floating.close);
  const settingsFloating = createFloatingPanel(node, "settings", "⚙️ 高级采样设置");
  node.__gjjIdeogram4DirectPanel = {
    widget,
    root,
    status,
    modeButton,
    paramsButton,
    seedButton,
    modelButton,
    keepModelButton,
    testButton,
    settingsButton,
    executeButton,
    settingsPanel: settingsFloating.body,
    settingsFloating: settingsFloating.panel,
    modelPanel: floating.panel,
    modelBody: floating.body,
  };
  if (typeof ResizeObserver !== "undefined") {
    const layoutObserver = new ResizeObserver(() => requestAnimationFrame(() => fitNode(node)));
    layoutObserver.observe(root);
    node.__gjjIdeogram4DirectPanel.layoutObserver = layoutObserver;
    chainCallback(node, "onRemoved", function () {
      try { layoutObserver.disconnect(); } catch (_) {}
      closeModelPicker(node);
      try { node.__gjjIdeogram4TestOverlay?.remove?.(); } catch (_) {}
      try { floating.panel.remove(); } catch (_) {}
      try { settingsFloating.panel.remove(); } catch (_) {}
    });
  }
  renderSettingsPanel(node);
  requestAnimationFrame(() => fitNode(node));
}

app.registerExtension({
  name: "GJJ.Ideogram4DirectGenerator",

  setup() {
    installGraphToPromptPatch();
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;
    injectStyle();
    nodeData.output_preview = false;
    nodeType.prototype.hideOutputImages = true;
    if (Array.isArray(nodeData.outputs)) {
      for (const output of nodeData.outputs) output.preview = false;
    }

    chainCallback(nodeType.prototype, "onNodeCreated", function () {
      installModelHelpProvider(this);
      addPanel(this);
      applySettingsVisibility(this);
      refreshButtons(this);
      setTimeout(() => {
        applySettingsVisibility(this);
        refreshButtons(this);
        fitNode(this);
      }, 80);
    });

    chainCallback(nodeType.prototype, "onConfigure", function () {
      setTimeout(() => {
        installModelHelpProvider(this);
        addPanel(this);
        applySettingsVisibility(this);
        refreshButtons(this);
        fitNode(this);
      }, 80);
    });

    chainCallback(nodeType.prototype, "onExecuted", function (message) {
      let images =
        message?.gjj_images ||
        message?.ui?.gjj_images ||
        message?.images ||
        message?.ui?.images ||
        message?.output?.images ||
        message?.results?.images ||
        null;
      if (!images && Array.isArray(message?.ui)) {
        for (const item of message.ui) {
          images = item?.gjj_images || item?.images || null;
          if (images) break;
        }
      }
      if (images?.length) updateFinalPreview(this, images);
    });

    const originalOnSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (serializedNode, ...args) {
      syncActiveTemplateParams(this);
      return originalOnSerialize?.apply(this, [serializedNode, ...args]);
    };
  },
});

api?.addEventListener?.("gjj_node_progress", (event) => {
  const data = event.detail || {};
  const node = app.graph?.getNodeById?.(Number(data.node || ""));
  const status = node?.__gjjIdeogram4DirectPanel?.status;
  if (!status) return;
  status.textContent = String(data.text || "");
  status.classList.toggle("show", Boolean(status.textContent));
  requestAnimationFrame(() => fitNode(node));
});

api?.addEventListener?.("gjj_ideogram4_test_preview", (event) => {
  const data = event.detail || {};
  const node = app.graph?.getNodeById?.(Number(data.node || ""));
  if (!node) return;
  if (data.reset) clearFinalPreview(node);
  if (Array.isArray(data.images) && data.images.length) {
    updateFinalPreview(node, data.images);
  }
  const status = node.__gjjIdeogram4DirectPanel?.status;
  if (status && Number(data.total || 0) > 0) {
    status.textContent = `模型测试预览 ${Number(data.completed || 0)}/${Number(data.total || 0)}`;
    status.classList.add("show");
  }
});
