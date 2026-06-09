const { app } = window.comfyAPI.app;

const NODE_NAME = "GJJ_GemmaTextGenerate";
const SETTINGS_PROPERTY = "gjj_gemma_text_generate_settings_open";
const THINKING_WIDGET = "thinking";
const TEMPLATE_WIDGET = "use_default_template";
const MEDIA_INPUT = "media";
const MEDIA_INPUT_TYPE = "GJJ_BATCH_IMAGE,IMAGE,VIDEO";
const LEGACY_MEDIA_INPUTS = new Set(["image", "video", "图像", "视频帧", "媒体", "图片/视频"]);
const SETTINGS_WIDGETS = [
  "clip_name",
  "clip_type",
  "clip_device",
  "max_length",
  "sampling_mode",
  "temperature",
  "top_k",
  "top_p",
  "min_p",
  "repetition_penalty",
  "seed",
  "presence_penalty",
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

function asBool(value) {
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes", "on"].includes(String(value || "").toLowerCase());
}

function hideWidget(widget) {
  if (!widget) return;
  if (!widget.__gjjGemmaHidden) {
    widget.__gjjGemmaHidden = {
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

function hideNativeWidgets(node) {
  for (const name of [...SETTINGS_WIDGETS, THINKING_WIDGET, TEMPLATE_WIDGET]) {
    hideWidget(findWidget(node, name));
  }
}

function normalizeMediaInputSlot(node) {
  if (!Array.isArray(node?.inputs)) return;
  let mediaInput = node.inputs.find((input) => String(input?.name || "") === MEDIA_INPUT);
  if (!mediaInput) {
    mediaInput = node.inputs.find((input) => LEGACY_MEDIA_INPUTS.has(String(input?.name || "")) && input?.link != null)
      || node.inputs.find((input) => LEGACY_MEDIA_INPUTS.has(String(input?.name || "")));
  }
  for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
    const input = node.inputs[index];
    const name = String(input?.name || "");
    if (input !== mediaInput && LEGACY_MEDIA_INPUTS.has(name)) {
      if (input?.link != null) {
        try { node.disconnectInput?.(index); } catch (_) {}
      }
      node.removeInput?.(index);
    }
  }
  mediaInput = node.inputs.find((input) => String(input?.name || "") === MEDIA_INPUT)
    || node.inputs.find((input) => LEGACY_MEDIA_INPUTS.has(String(input?.name || "")));
  if (!mediaInput && typeof node.addInput === "function") {
    node.addInput(MEDIA_INPUT, MEDIA_INPUT_TYPE);
    mediaInput = node.inputs[node.inputs.length - 1];
  }
  if (!mediaInput) return;
  mediaInput.name = MEDIA_INPUT;
  mediaInput.type = MEDIA_INPUT_TYPE;
  mediaInput.label = "图片/视频";
  mediaInput.localized_name = "图片/视频";
  mediaInput.tooltip = "统一输入口，支持 GJJ_BATCH_IMAGE、普通 IMAGE/IMAGE batch 和官方 VIDEO；接 VIDEO 时自动读取视频帧。";
}

function stopProp(element) {
  for (const eventName of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "contextmenu"]) {
    element.addEventListener(eventName, (event) => event.stopPropagation());
  }
}

function widgetLabel(name) {
  const labels = {
    clip_name: "CLIP 名称",
    clip_type: "CLIP 类型",
    clip_device: "加载设备",
    max_length: "最大长度",
    sampling_mode: "采样模式",
    temperature: "温度",
    top_k: "Top K",
    top_p: "Top P",
    min_p: "最小概率",
    repetition_penalty: "重复惩罚",
    seed: "种子",
    presence_penalty: "出现惩罚",
  };
  return labels[name] || name;
}

function widgetChoices(widget) {
  const values = widget?.options?.values || widget?.options?.items || widget?.values;
  return Array.isArray(values) ? values.map((value) => String(value)) : null;
}

function numericValue(widget, value) {
  const type = String(widget?.type || "").toUpperCase();
  if (type === "INT") return Number.parseInt(value || "0", 10);
  if (type === "FLOAT" || type === "NUMBER") return Number.parseFloat(value || "0");
  return value;
}

function makeSettingField(node, name) {
  const widget = findWidget(node, name);
  if (!widget) return null;
  const row = document.createElement("div");
  row.className = "gjj-gemma-field";
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
    const type = String(widget?.type || "").toUpperCase();
    input.type = type === "INT" || type === "FLOAT" || type === "NUMBER" ? "number" : "text";
    if (input.type === "number") {
      if (Number.isFinite(Number(widget?.options?.min))) input.min = String(widget.options.min);
      if (Number.isFinite(Number(widget?.options?.max))) input.max = String(widget.options.max);
      if (Number.isFinite(Number(widget?.options?.step))) input.step = String(widget.options.step);
    }
  }
  input.value = getWidgetValue(node, name) ?? "";
  input.title = widget?.options?.tooltip || "";
  stopProp(input);
  const commit = () => {
    setWidgetValue(node, name, numericValue(widget, input.value));
    markCanvasDirty();
  };
  input.addEventListener("input", commit);
  input.addEventListener("change", commit);
  row.appendChild(input);
  return row;
}

function injectStyle() {
  if (document.getElementById("gjj-gemma-text-generate-style")) return;
  const style = document.createElement("style");
  style.id = "gjj-gemma-text-generate-style";
  style.textContent = `
    .gjj-gemma-panel{display:flex;flex-wrap:wrap;gap:5px;padding:3px 0 2px;box-sizing:border-box;width:100%;color:#d8e5e8;font:12px sans-serif;pointer-events:auto;}
    .gjj-gemma-btn{flex:0 1 auto;min-width:0;height:26px;border:1px solid #465960;border-radius:5px;background:#263136;color:#cfdde1;cursor:pointer;font:700 12px sans-serif;padding:0 8px;white-space:nowrap;}
    .gjj-gemma-btn:hover{border-color:#59c38f;color:#fff;}
    .gjj-gemma-btn.active{background:#1f4937;border-color:#65d692;color:#eafff0;}
    .gjj-gemma-settings{display:none;flex:1 1 100%;flex-direction:column;gap:6px;margin-top:3px;padding:7px;background:#20282c;border:1px solid #3b454a;border-radius:6px;color:#cfd8dc;font:11px sans-serif;box-sizing:border-box;}
    .gjj-gemma-settings.open{display:flex;}
    .gjj-gemma-field{display:grid;grid-template-columns:78px minmax(0,1fr);align-items:center;gap:6px;min-width:0;}
    .gjj-gemma-field label{color:#aebbc0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .gjj-gemma-field input,.gjj-gemma-field select{width:100%;min-width:0;box-sizing:border-box;background:#151b1e;border:1px solid #445157;border-radius:4px;color:#e0e7ea;font:12px sans-serif;padding:4px 6px;}
  `;
  document.head.appendChild(style);
}

function panelHeight(node) {
  const state = node.__gjjGemmaPanel;
  if (!state) return 32;
  return Math.max(32, Math.round((state.root?.scrollHeight || 32) + 2));
}

function fitNode(node) {
  const computed = node?.computeSize?.();
  if (!Array.isArray(computed)) return;
  const currentW = Math.round(node.size?.[0] || computed[0]);
  const nextH = Math.round(computed[1]);
  if (Math.abs((node.size?.[1] || 0) - nextH) > 1) node.setSize?.([currentW, nextH]);
  markCanvasDirty();
}

function renderSettingsPanel(node) {
  const state = node.__gjjGemmaPanel;
  if (!state?.settingsPanel) return;
  const open = Boolean(node?.properties?.[SETTINGS_PROPERTY]);
  state.settingsPanel.innerHTML = "";
  state.settingsPanel.classList.toggle("open", open);
  if (open) {
    for (const name of SETTINGS_WIDGETS) {
      const field = makeSettingField(node, name);
      if (field) state.settingsPanel.appendChild(field);
    }
  }
  requestAnimationFrame(() => fitNode(node));
}

function refreshButtons(node) {
  const state = node.__gjjGemmaPanel;
  if (!state) return;
  const thinking = asBool(getWidgetValue(node, THINKING_WIDGET));
  const template = asBool(getWidgetValue(node, TEMPLATE_WIDGET));
  const settingsOpen = Boolean(node?.properties?.[SETTINGS_PROPERTY]);
  state.thinkingButton.classList.toggle("active", thinking);
  state.thinkingButton.setAttribute("aria-pressed", thinking ? "true" : "false");
  state.thinkingButton.textContent = thinking ? "思考模式 开" : "思考模式";
  state.templateButton.classList.toggle("active", template);
  state.templateButton.setAttribute("aria-pressed", template ? "true" : "false");
  state.templateButton.textContent = template ? "默认模板 开" : "默认模板";
  state.settingsButton.classList.toggle("active", settingsOpen);
  state.settingsButton.setAttribute("aria-pressed", settingsOpen ? "true" : "false");
}

function applyVisibility(node) {
  hideNativeWidgets(node);
  normalizeMediaInputSlot(node);
  renderSettingsPanel(node);
  refreshButtons(node);
}

function addPanel(node) {
  if (node.__gjjGemmaPanel || typeof node.addDOMWidget !== "function") return;
  const root = document.createElement("div");
  root.className = "gjj-gemma-panel";

  const thinkingButton = document.createElement("button");
  thinkingButton.type = "button";
  thinkingButton.className = "gjj-gemma-btn";
  thinkingButton.title = "切换模型思考模式。";
  thinkingButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setWidgetValue(node, THINKING_WIDGET, !asBool(getWidgetValue(node, THINKING_WIDGET)));
    refreshButtons(node);
    markCanvasDirty();
  });
  root.appendChild(thinkingButton);

  const templateButton = document.createElement("button");
  templateButton.type = "button";
  templateButton.className = "gjj-gemma-btn";
  templateButton.title = "切换是否使用模型默认模板。";
  templateButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setWidgetValue(node, TEMPLATE_WIDGET, !asBool(getWidgetValue(node, TEMPLATE_WIDGET)));
    refreshButtons(node);
    markCanvasDirty();
  });
  root.appendChild(templateButton);

  const settingsButton = document.createElement("button");
  settingsButton.type = "button";
  settingsButton.className = "gjj-gemma-btn";
  settingsButton.textContent = "⚙️设置";
  settingsButton.title = "展开或收起模型与采样参数。";
  settingsButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    node.properties ||= {};
    node.properties[SETTINGS_PROPERTY] = !Boolean(node.properties[SETTINGS_PROPERTY]);
    applyVisibility(node);
  });
  root.appendChild(settingsButton);

  const settingsPanel = document.createElement("div");
  settingsPanel.className = "gjj-gemma-settings";
  root.appendChild(settingsPanel);

  for (const element of [root, thinkingButton, templateButton, settingsButton, settingsPanel]) stopProp(element);
  const widget = node.addDOMWidget("gjj_gemma_text_generate_buttons", "HTML", root, { serialize: false });
  const widgetIndex = node.widgets?.indexOf(widget);
  if (widgetIndex > 0) {
    node.widgets.splice(widgetIndex, 1);
    node.widgets.unshift(widget);
  }
  widget.computeSize = (width) => [Math.round(width || node.size?.[0] || 360), panelHeight(node)];
  widget.getHeight = () => panelHeight(node);
  node.__gjjGemmaPanel = { widget, root, thinkingButton, templateButton, settingsButton, settingsPanel };
  if (typeof ResizeObserver !== "undefined") {
    const layoutObserver = new ResizeObserver(() => requestAnimationFrame(() => fitNode(node)));
    layoutObserver.observe(root);
    node.__gjjGemmaPanel.layoutObserver = layoutObserver;
    chainCallback(node, "onRemoved", function () {
      try { layoutObserver.disconnect(); } catch (_) {}
    });
  }
  applyVisibility(node);
  requestAnimationFrame(() => fitNode(node));
}

app.registerExtension({
  name: "GJJ.GemmaTextGenerate",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;
    injectStyle();

    chainCallback(nodeType.prototype, "onNodeCreated", function () {
      addPanel(this);
      applyVisibility(this);
      setTimeout(() => {
        applyVisibility(this);
        fitNode(this);
      }, 80);
    });

    chainCallback(nodeType.prototype, "onConfigure", function () {
      setTimeout(() => {
        addPanel(this);
        applyVisibility(this);
        fitNode(this);
      }, 80);
    });

    chainCallback(nodeType.prototype, "onConnectionsChange", function () {
      applyVisibility(this);
      requestAnimationFrame(() => fitNode(this));
    });
  },
});
