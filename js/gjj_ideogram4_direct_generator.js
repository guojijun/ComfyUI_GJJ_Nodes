const { app } = window.comfyAPI.app;
const api = window.comfyAPI?.api;

const NODE_NAME = "GJJ_Ideogram4DirectGenerator";
const TEMPLATE_PARAMS_NODE = "GJJ_TemplateParams";
const TEMPLATE_WIDGET = "template_text";
const VALUES_WIDGET = "values_json";
const SCHEMA_WIDGET = "schema_json";
const SETTINGS_PROPERTY = "gjj_ideogram4_direct_settings_open";
const PARAM_ENABLED_PROPERTY = "gjj_ideogram4_direct_template_enabled";
const PARAM_SOURCE_PROPERTY = "gjj_ideogram4_direct_template_source";
const PARAM_BACKUP_PROPERTY = "gjj_ideogram4_direct_param_backup";
const PARAM_WIDGETS = ["width", "height"];
const LORA_CHAIN_INPUT = "lora_chain_config";
const SETTINGS_WIDGETS = [
  "mode",
  "unet_name",
  "uncond_unet_name",
  "clip_name",
  "vae_name",
  "cfg",
  "override_cfg",
  "override_start",
  "override_end",
  "sampler_name",
  "weight_dtype",
];

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
  if (oldWidget && !String(oldWidget.type || "").startsWith("converted-widget:") && !oldWidget.hidden) {
    decorateParamWidget(oldWidget, name);
    ensureParamInput(node, name);
    return;
  }
  if (oldWidget && backup.options) oldWidget.__gjjParamBackupOptions = backup.options;
  const value = align16Min256(oldWidget?.value ?? backup.value ?? 1024);
  const options = numberWidgetOptions(name, oldWidget, backup.options || {});
  if (oldIndex >= 0) {
    node.widgets.splice(oldIndex, 1);
  }
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
  ensureParamInput(node, name);
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
  const open = Boolean(node?.properties?.[SETTINGS_PROPERTY]);
  for (const name of SETTINGS_WIDGETS) {
    const widget = findWidget(node, name);
    hideWidget(widget);
  }
  applyParamVisibility(node);
  renderSettingsPanel(node);
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
    .gjj-ideo4-direct-settings { display:none; flex:0 0 100%; flex-direction:column; gap:6px; margin-top:3px; padding:7px; background:#20282c; border:1px solid #3b454a; border-radius:6px; color:#cfd8dc; font:11px sans-serif; box-sizing:border-box; }
    .gjj-ideo4-direct-settings.open { display:flex; }
    .gjj-ideo4-direct-field { display:grid; grid-template-columns:76px minmax(0,1fr); align-items:center; gap:6px; min-width:0; }
    .gjj-ideo4-direct-field label { color:#aebbc0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .gjj-ideo4-direct-field input, .gjj-ideo4-direct-field select { width:100%; min-width:0; box-sizing:border-box; background:#151b1e; border:1px solid #445157; border-radius:4px; color:#e0e7ea; font:12px sans-serif; padding:4px 6px; }
    .gjj-ideo4-direct-status { display:none; flex:0 0 100%; color:#aebbc0; line-height:1.35; white-space:normal; overflow-wrap:anywhere; }
    .gjj-ideo4-direct-status.show { display:block; }
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
  };
  return labels[name] || name;
}

function widgetChoices(widget) {
  const values = widget?.options?.values || widget?.options?.items || widget?.values;
  return Array.isArray(values) ? values.map((value) => String(value)) : null;
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
  if (!state?.settingsPanel) return;
  const panel = state.settingsPanel;
  const open = Boolean(node?.properties?.[SETTINGS_PROPERTY]);
  panel.innerHTML = "";
  panel.classList.toggle("open", open);
  if (open) {
    for (const name of SETTINGS_WIDGETS) {
      const field = makeSettingField(node, name);
      if (field) panel.appendChild(field);
    }
  }
  requestAnimationFrame(() => fitNode(node));
}

function refreshButtons(node) {
  const state = node.__gjjIdeogram4DirectPanel;
  if (!state) return;
  const mode = String(findWidget(node, "mode")?.value || "默认");
  for (const button of state.modeButtons || []) {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
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
}

function addPanel(node) {
  if (node.__gjjIdeogram4DirectPanel || typeof node.addDOMWidget !== "function") return;
  const root = document.createElement("div");
  root.className = "gjj-ideo4-direct-panel";
  const modeButtons = [];
  for (const mode of ["质量", "默认", "极速"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gjj-ideo4-direct-btn";
    button.textContent = mode;
    button.dataset.mode = mode;
    button.title = `${mode}模式`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setWidgetValue(node, "mode", mode);
      refreshButtons(node);
      markCanvasDirty();
    });
    root.appendChild(button);
    modeButtons.push(button);
  }
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
  const settingsButton = document.createElement("button");
  settingsButton.type = "button";
  settingsButton.className = "gjj-ideo4-direct-btn";
  settingsButton.textContent = "⚙️设置";
  settingsButton.title = "展开或收起模型与高级采样设置。";
  settingsButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    node.properties ||= {};
    node.properties[SETTINGS_PROPERTY] = !Boolean(node.properties[SETTINGS_PROPERTY]);
    applySettingsVisibility(node);
  });
  root.appendChild(settingsButton);
  const settingsPanel = document.createElement("div");
  settingsPanel.className = "gjj-ideo4-direct-settings";
  root.appendChild(settingsPanel);
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
  node.__gjjIdeogram4DirectPanel = { widget, root, status, modeButtons, paramsButton, settingsButton, settingsPanel };
  if (typeof ResizeObserver !== "undefined") {
    const layoutObserver = new ResizeObserver(() => requestAnimationFrame(() => fitNode(node)));
    layoutObserver.observe(root);
    node.__gjjIdeogram4DirectPanel.layoutObserver = layoutObserver;
    chainCallback(node, "onRemoved", function () {
      try { layoutObserver.disconnect(); } catch (_) {}
    });
  }
  renderSettingsPanel(node);
  requestAnimationFrame(() => fitNode(node));
}

app.registerExtension({
  name: "GJJ.Ideogram4DirectGenerator",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;
    injectStyle();

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
