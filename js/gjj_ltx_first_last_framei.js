import { app } from "/scripts/app.js";

const TARGET_CLASS = "GJJ_LTX_FirstLastFrame";
const TARGET_TITLE_PREFIX = "GJJ · 🎬 LTX";
const MAX_GUIDES = 64;
const DATA_PROPERTY = "guide_config_json";

const LEGACY_INPUTS = new Set([
  "images", "first_image", "last_image", "guide_config_json", "gjj_guide_config",
  "frame_indices", "strengths", "first_strength", "last_strength", "num_images"
]);
const BAD_INPUT_NAMES = new Set(["", " ", "*", "undefined", "null", "guide_config_json", "gjj_guide_config", "frame_indices", "strengths", "first_strength", "last_strength", "num_images"]);
const LEGACY_WIDGETS = new Set(["frame_indices", "strengths", "first_strength", "last_strength", "guide_config_json", "gjj_guide_config", "num_images"]);

function isTargetNode(node) {
  return node?.comfyClass === TARGET_CLASS || String(node?.title || "").startsWith(TARGET_TITLE_PREFIX);
}

function guideName(index) {
  return `image_${String(index).padStart(2, "0")}`;
}

function guideIndex(name) {
  const match = String(name || "").match(/^image_(\d+)$/);
  return match ? Number(match[1]) || 0 : 0;
}

function sortedGuideInputs(node) {
  return [...(node.inputs || [])]
    .filter((input) => guideIndex(input?.name) > 0)
    .sort((a, b) => guideIndex(a.name) - guideIndex(b.name));
}

function highestConnectedGuideIndex(node) {
  let max = 0;
  for (const input of node.inputs || []) {
    const idx = guideIndex(input?.name);
    if (idx > 0 && input.link != null) max = Math.max(max, idx);
  }
  return max;
}

function connectedGuideCount(node) {
  return sortedGuideInputs(node).filter((input) => input.link != null).length;
}

function inputByName(node, name) {
  return (node.inputs || []).find((input) => input?.name === name);
}

function setDirty(node) {
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

function removeInputAt(node, slotIndex) {
  if (slotIndex < 0 || !Array.isArray(node.inputs) || slotIndex >= node.inputs.length) return;
  try {
    node.removeInput?.(slotIndex);
  } catch (_) {
    // 兜底：只在没有连线时才直接删除，避免破坏已有 link。
    if (node.inputs[slotIndex]?.link == null) node.inputs.splice(slotIndex, 1);
  }
}

function removeBadInputs(node) {
  if (!Array.isArray(node.inputs)) return;
  // 必须倒序 removeInput，不能直接 node.inputs = filter(...)，否则 link 的 target_slot 会错位。
  for (let i = node.inputs.length - 1; i >= 0; i -= 1) {
    const input = node.inputs[i];
    const name = String(input?.name ?? "").trim();
    if (input?.link != null) continue;
    if (BAD_INPUT_NAMES.has(name) || LEGACY_INPUTS.has(name)) {
      removeInputAt(node, i);
    }
  }
}

function normalizeGuideInput(input) {
  const idx = guideIndex(input?.name);
  if (!idx) return;
  const text = `🖼️ ${String(idx).padStart(2, "0")}`;
  input.name = guideName(idx);      // 后端 key，必须稳定
  input.type = "IMAGE";            // 前端连接类型，必须是 IMAGE，不用 *
  input.label = text;              // 界面显示
  input.localized_name = text;
  input.tooltip = `参考图 ${idx}：连接图片后自动增加下一个参考图输入。`;
}

function ensureGuideInputs(node) {
  // 只保证“最后有一个空参考图输入”。不重排 node.inputs，避免破坏插槽连接。
  removeBadInputs(node);

  const desired = Math.min(MAX_GUIDES, Math.max(1, highestConnectedGuideIndex(node) + 1));

  for (let i = 1; i <= desired; i += 1) {
    const name = guideName(i);
    let input = inputByName(node, name);
    if (!input) {
      node.addInput?.(name, "IMAGE");
      input = inputByName(node, name);
    }
    normalizeGuideInput(input);
  }

  // 删除尾部多余空参考图。倒序删，只删未连接的。
  const guides = sortedGuideInputs(node).reverse();
  for (const input of guides) {
    const idx = guideIndex(input.name);
    if (idx <= desired || input.link != null) continue;
    removeInputAt(node, node.inputs.indexOf(input));
  }

  // 再归一化一次，处理工作流恢复后的 label/type。
  for (const input of sortedGuideInputs(node)) normalizeGuideInput(input);
  return desired;
}

function hideWidgetCompletely(widget) {
  if (!widget) return;
  widget.type = "hidden";
  widget.hidden = true;
  widget.serialize = true;
  widget.computeSize = () => [0, 0];
  widget.draw = () => {};
  widget.label = "";
  widget.last_y = 0;
  widget.computedHeight = 0;
  widget.margin_top = 0;
  widget.size = [0, 0];
  widget.y = 0;
  for (const key of ["inputEl", "element", "widget"]) {
    const el = widget[key];
    if (!el?.style) continue;
    el.style.display = "none";
    el.style.height = "0";
    el.style.minHeight = "0";
    el.style.maxHeight = "0";
    el.style.margin = "0";
    el.style.padding = "0";
    el.style.border = "0";
    el.style.overflow = "hidden";
  }
}

function hideLegacyWidgets(node) {
  for (const widget of node.widgets || []) {
    if (LEGACY_WIDGETS.has(widget?.name)) hideWidgetCompletely(widget);
  }
}

function parseConfig(node) {
  const raw = node.properties?.[DATA_PROPERTY] ?? node.properties?.gjj_guide_config ?? "[]";
  try {
    const parsed = JSON.parse(String(raw || "[]"));
    if (Array.isArray(parsed)) return parsed.map((item) => ({
      frame: Number.isFinite(Number(item?.frame)) ? Math.trunc(Number(item.frame)) : undefined,
      strength: Number.isFinite(Number(item?.strength)) ? clamp(Number(item.strength), 0, 1) : 0.7,
    }));
  } catch (_) {}
  return [];
}

function ensureState(node) {
  node.properties = node.properties || {};
  if (!node.__gjjLtxGuideState) node.__gjjLtxGuideState = { rows: parseConfig(node) };
  return node.__gjjLtxGuideState;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function defaultFrame(index, count) {
  if (count <= 1) return 0;
  if (index === 0) return 0;
  if (index === count - 1) return -1;
  return -1;
}

function normalizeRows(node, count) {
  const state = ensureState(node);
  const oldRows = Array.isArray(state.rows) ? state.rows : [];
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const row = oldRows[i] || {};
    rows.push({
      frame: Number.isFinite(Number(row.frame)) ? Math.trunc(Number(row.frame)) : defaultFrame(i, count),
      strength: Number.isFinite(Number(row.strength)) ? clamp(Number(row.strength), 0, 1) : 0.7,
    });
  }
  state.rows = rows;
  return rows;
}

function writeConfig(node) {
  const rows = (ensureState(node).rows || []).map((row) => ({
    frame: Number.isFinite(Number(row.frame)) ? Math.trunc(Number(row.frame)) : 0,
    strength: Number.isFinite(Number(row.strength)) ? clamp(Number(row.strength), 0, 1) : 0.7,
  }));
  const text = JSON.stringify(rows);
  node.properties = node.properties || {};
  node.properties[DATA_PROPERTY] = text;
  node.properties.gjj_guide_config = text;
}

function stopCanvasEvents(element) {
  for (const eventName of ["mousedown", "mouseup", "pointerdown", "pointerup", "click", "dblclick", "keydown", "keyup"]) {
    element.addEventListener(eventName, (event) => event.stopPropagation());
  }
  element.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
}

function inputStyle(width) {
  return `
    width:${width}px;height:20px;box-sizing:border-box;
    border:1px solid rgba(255,255,255,.12);border-radius:6px;
    background:rgba(255,255,255,.07);color:#edf3f8;
    padding:0 4px;outline:none;text-align:center;font-size:12px;
  `;
}

function isPartialNumber(text) {
  const value = String(text ?? "").trim();
  return value === "" || value === "-" || value === "+" || value === "." || value === "-." || value === "+.";
}

function setupPanel(node) {
  if (node.__gjjLtxGuideRoot) return;
  const root = document.createElement("div");
  root.className = "gjj-ltx-guide-panel";
  root.style.cssText = "box-sizing:border-box;width:100%;padding:0 4px;margin:0;color:#d5dde5;font:12px/1.2 var(--font, system-ui, sans-serif);overflow:hidden;";
  stopCanvasEvents(root);

  const widget = node.addDOMWidget?.("", "GJJ_LTX_GUIDE_PANEL", root, {
    getValue: () => "",
    setValue: () => {},
  });
  if (widget) {
    widget.serialize = false;
    widget.computeSize = (width) => [width, Math.max(0, root.__gjjHeight || 0)];
    widget.label = "";
    widget.name = "";
    widget.margin_top = 0;
  }
  node.__gjjLtxGuideRoot = root;
  node.__gjjLtxGuideWidget = widget;
}

function renderPanel(node) {
  const root = node.__gjjLtxGuideRoot;
  if (!root) return;
  const count = highestConnectedGuideIndex(node);
  const rows = normalizeRows(node, count);
  root.replaceChildren();

  if (count <= 0) {
    root.__gjjHeight = 0;
    writeConfig(node);
    return;
  }

  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:3px;margin:0;padding:0;";

  for (let i = 0; i < count; i += 1) {
    const data = rows[i];
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:5px;height:22px;margin:0;padding:0;";

    const label = document.createElement("div");
    label.textContent = `🖼️${String(i + 1).padStart(2, "0")}`;
    label.title = `参考图 ${i + 1}`;
    label.style.cssText = "width:42px;text-align:right;opacity:.92;white-space:nowrap;";

    const frame = document.createElement("input");
    frame.type = "number";
    frame.step = "1";
    frame.value = data.frame;
    frame.title = "🎞 作用帧：-1 表示最后一帧。";
    frame.style.cssText = inputStyle(48);
    stopCanvasEvents(frame);
    frame.addEventListener("input", () => {
      if (isPartialNumber(frame.value)) return;
      ensureState(node).rows[i].frame = Math.trunc(Number(frame.value));
      writeConfig(node);
    });
    frame.addEventListener("change", () => {
      const n = Number(frame.value);
      ensureState(node).rows[i].frame = Number.isFinite(n) ? Math.trunc(n) : defaultFrame(i, count);
      frame.value = ensureState(node).rows[i].frame;
      writeConfig(node);
    });

    const strength = document.createElement("input");
    strength.type = "number";
    strength.min = "0";
    strength.max = "1";
    strength.step = "0.01";
    strength.value = Number(data.strength).toFixed(2);
    strength.title = "💪 强度：0 表示跳过，1 表示最强。";
    strength.style.cssText = inputStyle(56);
    stopCanvasEvents(strength);
    strength.addEventListener("input", () => {
      if (isPartialNumber(strength.value)) return;
      ensureState(node).rows[i].strength = clamp(Number(strength.value), 0, 1);
      writeConfig(node);
    });
    strength.addEventListener("change", () => {
      const n = Number(strength.value);
      ensureState(node).rows[i].strength = Number.isFinite(n) ? clamp(n, 0, 1) : 0.7;
      strength.value = ensureState(node).rows[i].strength.toFixed(2);
      writeConfig(node);
    });

    const frameIcon = document.createElement("span");
    frameIcon.textContent = "🎞";
    frameIcon.title = frame.title;
    frameIcon.style.cssText = "opacity:.8;width:14px;text-align:center;";

    const strengthIcon = document.createElement("span");
    strengthIcon.textContent = "💪";
    strengthIcon.title = strength.title;
    strengthIcon.style.cssText = "opacity:.8;width:14px;text-align:center;";

    row.appendChild(label);
    row.appendChild(frameIcon);
    row.appendChild(frame);
    row.appendChild(strengthIcon);
    row.appendChild(strength);
    wrap.appendChild(row);
  }

  root.appendChild(wrap);
  root.__gjjHeight = count * 25;
  writeConfig(node);
}

function compactNodeSize(node) {
  const inputCount = Array.isArray(node.inputs) ? node.inputs.length : 0;
  const panelHeight = node.__gjjLtxGuideRoot?.__gjjHeight || 0;
  const width = Math.max(Number(node.size?.[0]) || 280, 280);
  const targetHeight = Math.max(108, 52 + inputCount * 20 + panelHeight);
  if (!node.size || Math.abs((node.size[1] || 0) - targetHeight) > 5 || node.size[0] < width) {
    node.setSize?.([width, targetHeight]);
    node.size = [width, targetHeight];
  }
}

function refreshNode(node) {
  if (!isTargetNode(node)) return;
  hideLegacyWidgets(node);
  removeBadInputs(node);
  ensureGuideInputs(node);
  setupPanel(node);
  renderPanel(node);
  hideLegacyWidgets(node);
  compactNodeSize(node);
  setDirty(node);
}

function scheduleRefresh(node, delay = 50) {
  clearTimeout(node.__gjjLtxRefreshTimer);
  node.__gjjLtxRefreshTimer = setTimeout(() => refreshNode(node), delay);
}

function chainMethod(proto, name, fn) {
  const old = proto[name];
  proto[name] = function(...args) {
    const result = old?.apply(this, args);
    try { fn.apply(this, args); } catch (error) { console.warn("[GJJ LTX 多帧引导]", error); }
    return result;
  };
}

app.registerExtension({
  name: "GJJ.LTX.FirstLastFrame.DynamicCleanUI.v5",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== TARGET_CLASS) return;

    chainMethod(nodeType.prototype, "onNodeCreated", function() {
      setTimeout(() => refreshNode(this), 0);
    });

    chainMethod(nodeType.prototype, "onConfigure", function() {
      setTimeout(() => {
        this.__gjjLtxGuideState = { rows: parseConfig(this) };
        refreshNode(this);
      }, 0);
    });

    chainMethod(nodeType.prototype, "onConnectionsChange", function() {
      scheduleRefresh(this, 50);
    });

    const oldSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function(serialized) {
      writeConfig(this);
      const result = oldSerialize?.apply(this, arguments) ?? serialized;
      if (result) {
        result.properties = result.properties || {};
        result.properties[DATA_PROPERTY] = this.properties?.[DATA_PROPERTY] || "[]";
        result.properties.gjj_guide_config = this.properties?.[DATA_PROPERTY] || "[]";
      }
      return result;
    };
  },

  setup() {
    setTimeout(() => {
      for (const node of app.graph?._nodes || []) {
        if (isTargetNode(node)) refreshNode(node);
      }
    }, 300);
  },
});
