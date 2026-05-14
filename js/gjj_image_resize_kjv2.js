import { app } from "/scripts/app.js";

const NODE_CLASS = "GJJ_ImageResizeKJv2";
const MODES = ["宽高", "等比", "长边", "像素"];

const ORDER = [
  "resize_mode",
  "width",
  "height",
  "scale_percent",
  "long_side_length",
  "total_pixel_k",
  "aspect_ratio",
  "proportional_width",
  "proportional_height",
  "fit_mode",
  "upscale_method",
  "round_to_multiple",
  "pad_color",
  "device",
];

const CONTROLLED = new Set(ORDER.filter((name) => name !== "resize_mode"));
const MANAGED = new Set(ORDER);

const GROUPS = {
  "宽高": ["width", "height", "fit_mode", "upscale_method", "round_to_multiple", "pad_color", "device"],
  "等比": ["scale_percent", "upscale_method", "round_to_multiple", "device"],
  "长边": ["long_side_length", "upscale_method", "round_to_multiple", "device"],
  "像素": ["total_pixel_k", "aspect_ratio", "fit_mode", "upscale_method", "round_to_multiple", "pad_color", "device"],
};

const MODE_ALIAS = {
  "固定宽高": "宽高",
  "等比缩放": "等比",
  "长边适配": "长边",
  "像素控制": "像素",
};

// 旧节点被旧 JS 污染后用于兜底恢复；新节点通常会走原始类型恢复。
const WIDGET_TYPE_FALLBACK = {
  width: "number",
  height: "number",
  scale_percent: "number",
  long_side_length: "number",
  total_pixel_k: "number",
  aspect_ratio: "combo",
  proportional_width: "number",
  proportional_height: "number",
  fit_mode: "combo",
  upscale_method: "combo",
  round_to_multiple: "combo",
  pad_color: "text",
  device: "combo",
};

const WIDGET_LABEL_FALLBACK = {
  resize_mode: "缩放模式",
  width: "📐 目标宽度",
  height: "📐 目标高度",
  scale_percent: "🔍 缩放百分比",
  long_side_length: "📏 长边长度",
  total_pixel_k: "🔢 总像素/K",
  aspect_ratio: "🧩 输出比例",
  proportional_width: "↔️ 自定义比例宽",
  proportional_height: "↕️ 自定义比例高",
  fit_mode: "🧲 适配方式",
  upscale_method: "🔄 缩放算法",
  round_to_multiple: "🔢 尺寸对齐",
  pad_color: "🎨 留边颜色",
  device: "⚙️ 计算设备",
};

const WIDGET_TOOLTIP_FALLBACK = {
  resize_mode: "选择缩放计算方式。前端会显示为按钮：宽高、等比、长边、像素。",
  width: "宽高模式使用。设置最终输出图片的宽度，单位为像素。",
  height: "宽高模式使用。设置最终输出图片的高度，单位为像素。",
  scale_percent: "等比模式使用。100 表示原尺寸，50 表示缩小一半，200 表示放大两倍。",
  long_side_length: "长边模式使用。把图片较长的一边缩放到此长度，另一边按原比例自动计算。",
  total_pixel_k: "像素模式使用。按总像素数量计算输出尺寸，单位为千像素。例如 1024 表示约 102.4 万像素。",
  aspect_ratio: "像素模式使用。决定总像素如何分配成宽高。选择原始比例会沿用输入图片比例；选择自定义会显示自定义比例宽和高。",
  proportional_width: "像素模式且输出比例为自定义时使用。与自定义比例高共同决定宽高比例。",
  proportional_height: "像素模式且输出比例为自定义时使用。与自定义比例宽共同决定宽高比例。",
  fit_mode: "宽高和像素模式使用。拉伸会直接变成目标宽高；留边填充会保持比例并补边；裁剪填满会保持比例并居中裁剪。",
  upscale_method: "图片缩放采样算法。兰索斯质量较高但只支持 CPU；GPU 模式请使用最近邻、双线性、区域或双三次。",
  round_to_multiple: "把输出宽高向上对齐到指定倍数。常用于确保尺寸能被 8、16、32、64 等整除。选择无则不额外对齐。",
  pad_color: "留边填充时使用的背景颜色。支持颜色选择器、十六进制颜色和常见颜色名称。",
  device: "选择缩放计算设备。兰索斯不支持 GPU，如果选择 GPU 请改用其它缩放算法。",
};

const MODE_TOOLTIP = {
  "宽高": "宽高：直接指定输出宽度和高度，可选择拉伸、留边填充或裁剪填满。",
  "等比": "等比：按百分比整体缩放，始终保持原图比例。",
  "长边": "长边：指定图片较长一边的长度，短边自动按原比例计算。",
  "像素": "像素：按总像素/K和输出比例自动计算宽高。",
};

function normalizeMode(value) {
  return MODE_ALIAS[value] || value || "宽高";
}

function findWidget(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

function widgetValue(node, name, fallback = undefined) {
  const w = findWidget(node, name);
  return w?.value ?? fallback;
}

function stopCanvasEvent(e) {
  e.preventDefault?.();
  e.stopPropagation?.();
}

function stopCanvasEventHard(e) {
  e.preventDefault?.();
  e.stopPropagation?.();
  e.stopImmediatePropagation?.();
}

function setWidgetValue(node, name, value) {
  const w = findWidget(node, name);
  if (!w) return;
  w.value = value;
  node.properties ??= {};
  node.properties[name] = value;
  w.callback?.(value, app.canvas, node, app.canvas?.graph_mouse, {});
}

function rememberOriginalWidget(widget) {
  if (!widget || widget.__gjjResizeOriginalSaved) return;
  if (widget.type === "hidden" || widget.hidden === true) return;

  widget.__gjjResizeOriginalSaved = true;
  widget.__gjjResizeOriginal = {
    type: widget.type,
    hidden: widget.hidden,
    disabled: widget.disabled,
    computeSize: widget.computeSize,
    draw: widget.draw,
    label: widget.label,
    last_y: widget.last_y,
    computedHeight: widget.computedHeight,
    margin_top: widget.margin_top,
    size: Array.isArray(widget.size) ? [...widget.size] : widget.size,
  };
}

function hideWidgetCompletely(widget) {
  if (!widget) return;
  rememberOriginalWidget(widget);

  widget.type = "hidden";
  widget.hidden = true;
  widget.disabled = true;
  widget.serialize = true;
  widget.options ??= {};
  widget.options.hidden = true;
  widget.computeSize = () => [0, -4];
  widget.draw = () => {};
  widget.label = "";
  widget.last_y = 0;
  widget.computedHeight = -4;
  widget.margin_top = 0;
  widget.size = [0, -4];

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

function showWidgetCompletely(widget) {
  if (!widget) return;

  const original = widget.__gjjResizeOriginal;
  const hasValidOriginal = widget.__gjjResizeOriginalSaved && original?.type && original.type !== "hidden";

  widget.hidden = false;
  widget.disabled = false;
  widget.serialize = true;
  widget.options ??= {};
  delete widget.options.hidden;

  if (hasValidOriginal) {
    widget.type = original.type;
    widget.computeSize = original.computeSize;
    widget.draw = original.draw;
    widget.label = original.label || WIDGET_LABEL_FALLBACK[widget.name] || widget.name;
    widget.options.tooltip ??= WIDGET_TOOLTIP_FALLBACK[widget.name];
    widget.last_y = original.last_y || 0;
    widget.computedHeight = original.computedHeight;
    widget.margin_top = original.margin_top || 0;
    widget.size = Array.isArray(original.size) ? [...original.size] : original.size;
  } else {
    widget.type = WIDGET_TYPE_FALLBACK[widget.name] || "number";
    widget.computeSize = undefined;
    widget.draw = undefined;
    widget.label = WIDGET_LABEL_FALLBACK[widget.name] || widget.label || widget.name;
    widget.options.tooltip = WIDGET_TOOLTIP_FALLBACK[widget.name] || widget.options.tooltip;
    widget.last_y = 0;
    widget.computedHeight = undefined;
    widget.margin_top = 0;
    widget.size = undefined;
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
}

function ensureStyles() {
  if (document.getElementById("gjj-image-resize-kjv2-style")) return;
  const style = document.createElement("style");
  style.id = "gjj-image-resize-kjv2-style";
  style.textContent = `
    .gjj-resize-kjv2-row {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 5px;
      width: 100%;
      box-sizing: border-box;
      padding: 0;
      margin: 0;
      pointer-events: auto;
      user-select: none;
    }
    .gjj-resize-kjv2-btn {
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 8px;
      background: rgba(255,255,255,.075);
      color: rgba(255,255,255,.9);
      font-size: 11px;
      line-height: 1.15;
      padding: 6px 2px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: clip;
      pointer-events: auto;
      transition: background .12s ease, border-color .12s ease, transform .08s ease;
    }
    .gjj-resize-kjv2-btn:hover {
      background: rgba(255,255,255,.14);
      border-color: rgba(255,255,255,.34);
    }
    .gjj-resize-kjv2-btn:active { transform: translateY(1px); }
    .gjj-resize-kjv2-btn.active {
      background: rgba(66, 153, 225, .66);
      border-color: rgba(144, 205, 244, .95);
      color: #fff;
      font-weight: 700;
    }
  `;
  document.head.appendChild(style);
}

function addModeButtons(node) {
  if (node.__gjjResizeModeButtons) return;
  ensureStyles();

  const row = document.createElement("div");
  row.className = "gjj-resize-kjv2-row";

  for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
    row.addEventListener(eventName, stopCanvasEvent, { capture: true });
  }

  const buttons = new Map();
  for (const mode of MODES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gjj-resize-kjv2-btn";
    btn.textContent = mode;
    btn.title = MODE_TOOLTIP[mode] || `切换到：${mode}`;

    for (const eventName of ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu"]) {
      btn.addEventListener(eventName, stopCanvasEvent, { capture: true });
    }

    btn.addEventListener("click", (e) => {
      stopCanvasEventHard(e);
      setWidgetValue(node, "resize_mode", mode);
      updateNodeUI(node);
      node.setDirtyCanvas?.(true, true);
      app.graph?.setDirtyCanvas?.(true, true);
    });

    buttons.set(mode, btn);
    row.appendChild(btn);
  }

  const domWidget = node.addDOMWidget("gjj_resize_mode_buttons", "GJJResizeModeButtons", row, {
    serialize: false,
    hideOnZoom: false,
    getValue: () => normalizeMode(widgetValue(node, "resize_mode", "宽高")),
    setValue: (value) => setWidgetValue(node, "resize_mode", normalizeMode(value)),
  });

  domWidget.computeSize = function(width) {
    return [width, 30];
  };
  domWidget.serialize = false;
  domWidget.label = "";
  domWidget.margin_top = 0;

  node.__gjjResizeModeButtons = { row, buttons, domWidget };
}

function removeManagedInputSlots(node) {
  // 只保留真正数据输入口 image / mask；参数输入口由面板按钮控制，不在左侧出现。
  if (!Array.isArray(node.inputs)) return;
  for (const name of MANAGED) {
    let idx = node.inputs.findIndex((input) => input?.name === name);
    while (idx !== -1) {
      node.removeInput?.(idx);
      idx = node.inputs.findIndex((input) => input?.name === name);
    }
  }
}

function collectManagedWidgets(node) {
  const map = new Map();
  for (const name of ORDER) {
    const widget = findWidget(node, name);
    if (widget) map.set(name, widget);
  }
  return map;
}

function rebuildWidgetOrder(node, visibleNames) {
  if (!Array.isArray(node.widgets)) return;
  const modeButtons = node.__gjjResizeModeButtons?.domWidget;
  const visibleSet = new Set(visibleNames);

  const managedMap = collectManagedWidgets(node);
  const visibleWidgets = [];
  const hiddenWidgets = [];

  for (const name of ORDER) {
    const widget = managedMap.get(name);
    if (!widget) continue;
    if (visibleSet.has(name)) visibleWidgets.push(widget);
    else hiddenWidgets.push(widget);
  }

  const otherWidgets = node.widgets.filter((w) => {
    if (w === modeButtons) return false;
    if (MANAGED.has(w.name)) return false;
    return true;
  });

  // 关键：按“当前模式需要的控件”重排，按钮放在当前控件之后；隐藏控件放最后，避免旧参数在中间挤空行。
  node.widgets = [...otherWidgets, ...visibleWidgets, ...(modeButtons ? [modeButtons] : []), ...hiddenWidgets];
}

function applyChineseWidgetText(node) {
  if (!Array.isArray(node.widgets)) return;
  for (const widget of node.widgets) {
    if (!MANAGED.has(widget.name)) continue;
    widget.options ??= {};
    widget.label = WIDGET_LABEL_FALLBACK[widget.name] || widget.label || widget.name;
    widget.options.tooltip = WIDGET_TOOLTIP_FALLBACK[widget.name] || widget.options.tooltip;
  }
}

function updateNodeUI(node) {
  if (!node?.widgets) return;

  applyChineseWidgetText(node);
  removeManagedInputSlots(node);

  for (const w of node.widgets) {
    if (MANAGED.has(w.name)) rememberOriginalWidget(w);
  }

  let mode = normalizeMode(widgetValue(node, "resize_mode", "宽高"));
  if (!MODES.includes(mode)) mode = "宽高";

  const modeWidget = findWidget(node, "resize_mode");
  if (modeWidget && modeWidget.value !== mode) modeWidget.value = mode;

  const visibleNames = [...(GROUPS[mode] || GROUPS["宽高"])] ;

  if (mode === "像素" && widgetValue(node, "aspect_ratio", "原始比例") === "自定义") {
    const idx = visibleNames.indexOf("aspect_ratio");
    visibleNames.splice(idx + 1, 0, "proportional_width", "proportional_height");
  }

  const visibleSet = new Set(visibleNames);

  hideWidgetCompletely(modeWidget);
  for (const name of CONTROLLED) {
    const w = findWidget(node, name);
    if (!w) continue;
    if (visibleSet.has(name)) showWidgetCompletely(w);
    else hideWidgetCompletely(w);
  }

  rebuildWidgetOrder(node, visibleNames);

  const buttons = node.__gjjResizeModeButtons?.buttons;
  if (buttons) {
    for (const [name, btn] of buttons.entries()) {
      btn.classList.toggle("active", name === mode);
    }
  }

  removeManagedInputSlots(node);

  const size = node.computeSize?.();
  if (size) {
    node.size[0] = Math.max(node.size?.[0] || 240, size[0]);
    node.size[1] = size[1];
  }
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

function hookWidgetCallbacks(node) {
  for (const name of ["resize_mode", "aspect_ratio"]) {
    const w = findWidget(node, name);
    if (!w || w.__gjjResizeHooked) continue;
    const old = w.callback;
    w.callback = function (...args) {
      const r = old?.apply(this, args);
      requestAnimationFrame(() => updateNodeUI(node));
      return r;
    };
    w.__gjjResizeHooked = true;
  }
}

function install(node) {
  requestAnimationFrame(() => {
    addModeButtons(node);
    hookWidgetCallbacks(node);
    updateNodeUI(node);
    setTimeout(() => updateNodeUI(node), 50);
    setTimeout(() => updateNodeUI(node), 200);
  });
}

app.registerExtension({
  name: "GJJ.ImageResizeKJv2.UI",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;

    const originalAddWidget = nodeType.prototype.addWidget;
    if (originalAddWidget && !nodeType.prototype.__gjjResizeAddWidgetHookedV5) {
      nodeType.prototype.addWidget = function (...args) {
        const widget = originalAddWidget.apply(this, args);
        if (widget && MANAGED.has(widget.name)) rememberOriginalWidget(widget);
        if (widget?.name === "resize_mode") hideWidgetCompletely(widget);
        return widget;
      };
      nodeType.prototype.__gjjResizeAddWidgetHookedV5 = true;
    }

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const r = onNodeCreated?.apply(this, args);
      install(this);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const r = onConfigure?.apply(this, args);
      install(this);
      return r;
    };
  },
});
