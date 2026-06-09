const { app } = window.comfyAPI.app;
const api = window.comfyAPI?.api;

function chainCallback(object, property, callback) {
  if (!object) return;
  if (property in object) {
    const original = object[property];
    object[property] = function () {
      const result = original.apply(this, arguments);
      callback.apply(this, arguments);
      return result;
    };
  } else {
    object[property] = callback;
  }
}

function addMiddleClickPan(element) {
  const onMouseDown = (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    const ds = app.canvas?.ds;
    if (!ds) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const startOffsetX = ds.offset[0];
    const startOffsetY = ds.offset[1];
    const onMove = (moveEvent) => {
      ds.offset[0] = startOffsetX + (moveEvent.clientX - startX);
      ds.offset[1] = startOffsetY + (moveEvent.clientY - startY);
      app.canvas.setDirty(true, true);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  element.addEventListener("mousedown", onMouseDown);
}

function addWheelPassthrough(element) {
  element.addEventListener("wheel", (event) => {
    const graphCanvas = document.getElementById("graph-canvas");
    if (graphCanvas) {
      graphCanvas.dispatchEvent(new WheelEvent(event.type, event));
      event.preventDefault();
    }
  }, { passive: false });
}

function cursorForBboxMode(mode) {
  if (mode === "move") return "move";
  if (mode === "resize-tl" || mode === "resize-br") return "nwse-resize";
  if (mode === "resize-tr" || mode === "resize-bl") return "nesw-resize";
  if (mode === "resize-t" || mode === "resize-b") return "ns-resize";
  if (mode === "resize-l" || mode === "resize-r") return "ew-resize";
  return null;
}

const HANDLE = 8;            // hit radius (canvas px) for corners/edges
const MAX_ELEM_COLORS = 5;   // Ideogram 4 per-element palette cap
const MAX_STYLE_COLORS = 16; // Ideogram 4 style palette cap
const TEMPLATE_PARAMS_NODE = "GJJ_TemplateParams";
const SOCKETS_PROPERTY = "gjj_ideogram4_prompt_builder_sockets_enabled";
const SETTINGS_PROPERTY = "gjj_ideogram4_prompt_builder_settings_open";
const IMAGE_SETTINGS_PROPERTY = "gjj_ideogram4_prompt_builder_image_settings_open";
const PARAM_SOURCE_PROPERTY = "gjj_ideogram4_prompt_builder_template_source";
const PARAM_MODE_PROPERTY = "gjj_ideogram4_prompt_builder_template_mode";
const PARAM_WIDGETS = [
  "width", "height", "high_level_description", "background", "style", "photo", "art_style",
  "aesthetics", "lighting", "medium",
  "image_caption_backend", "image_caption_model", "image_caption_prompt",
  "image_caption_thinking", "image_caption_keep_alive", "image_caption_max_tokens", "ollama_host",
];
const SYSTEM_PARAM_WIDGETS = ["width", "height", "high_level_description", "background", "style", "photo", "art_style", "aesthetics", "lighting", "medium"];
const IMAGE_PARAM_WIDGETS = ["image_caption_backend", "image_caption_model", "image_caption_prompt", "image_caption_thinking", "image_caption_keep_alive", "image_caption_max_tokens", "ollama_host"];
const SOCKET_WIDGETS = {
  width: { type: "INT", label: "画布宽度" },
  height: { type: "INT", label: "画布高度" },
  bboxes: { type: "STRING", label: "外部框选" },
};
const COLOR_SCHEMES = [
  { name: "电影暖调", colors: ["#1B1B2F", "#E43F5A", "#F7C59F", "#FF6B35", "#F5F5F5"] },
  { name: "清透自然", colors: ["#0B3954", "#087E8B", "#BFD7EA", "#FFFAFB", "#70C1B3"] },
  { name: "霓虹赛博", colors: ["#090A1A", "#00F5D4", "#9B5DE5", "#F15BB5", "#FEE440"] },
  { name: "复古胶片", colors: ["#2B2118", "#6F4E37", "#A67C52", "#D9CAB3", "#F2E8CF"] },
  { name: "高级灰蓝", colors: ["#111827", "#334155", "#64748B", "#CBD5E1", "#F8FAFC"] },
  { name: "国风雅色", colors: ["#2F3E46", "#52796F", "#84A98C", "#CAD2C5", "#C1121F"] },
];
let copiedBox = null;        // internal clipboard for copy/paste of regions (shared across nodes)

// Black or white, whichever contrasts better with the given hex background.
function textOn(hex) {
  const h = (hex || "").replace("#", "");
  if (h.length < 6) return "#000";
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 140 ? "#000" : "#fff";
}

function injectStyle() {
  if (document.getElementById("kjideo-style")) return;
  const s = document.createElement("style");
  s.id = "kjideo-style";
  s.textContent = `
    .kjideo-wrap { display:flex; flex-direction:column; overflow:hidden; position:relative; pointer-events:auto; gap:4px; }
    .kjideo-canvas { cursor:crosshair; display:block; width:100%; height:auto; flex:0 0 auto; background:#1a1a1a; border-radius:4px; outline:none; }
    .kjideo-bar { display:flex; align-items:center; gap:6px; font:11px sans-serif; color:#aaa; user-select:none; padding:0 2px; flex:0 0 auto; flex-wrap:wrap; }
    .kjideo-hint { flex:1 1 100%; min-width:0; color:#aebbc0; line-height:1.35; white-space:normal; word-break:normal; overflow-wrap:break-word; }
    .kjideo-panel { display:flex; flex-direction:column; gap:5px; padding:6px; background:#262626; border-radius:4px; font:11px sans-serif; color:#bbb; flex:0 0 auto; }
    .kjideo-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
    .kjideo-btn { background:#333; border:1px solid #555; border-radius:4px; color:#bbb; font:11px sans-serif; cursor:pointer; padding:2px 8px; line-height:16px; white-space:nowrap; flex-shrink:0; }
    .kjideo-btn:hover { border-color:#46b4e6; color:#fff; }
    .kjideo-btn.active { border-color:#46b4e6; color:#46b4e6; background:#2a3a42; }
    .kjideo-area { width:100%; box-sizing:border-box; background:#1d1d1d; border:1px solid #444; border-radius:4px; color:#ddd; font:13px monospace; padding:4px 6px; resize:vertical; min-height:36px; }
    .kjideo-settings { display:none; flex-direction:column; gap:6px; padding:7px; background:#20282c; border:1px solid #3b454a; border-radius:6px; color:#cfd8dc; font:11px sans-serif; }
    .kjideo-settings.open { display:flex; }
    .kjideo-field { display:grid; grid-template-columns:70px minmax(0,1fr); align-items:center; gap:6px; min-width:0; }
    .kjideo-field label { color:#aebbc0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .kjideo-field input, .kjideo-field select, .kjideo-field textarea { width:100%; min-width:0; box-sizing:border-box; background:#151b1e; border:1px solid #445157; border-radius:4px; color:#e0e7ea; font:12px sans-serif; padding:4px 6px; }
    .kjideo-field textarea { min-height:48px; resize:vertical; line-height:1.35; }
    .kjideo-choice-row { display:flex; flex-wrap:wrap; gap:5px; min-width:0; }
    .kjideo-sw { width:20px; height:20px; border:1px solid #666; border-radius:3px; cursor:pointer; flex-shrink:0; position:relative; }
    .kjideo-sw input { position:absolute; opacity:0; width:0; height:0; pointer-events:none; }
    .kjideo-preset-row { display:flex; align-items:center; gap:5px; flex-wrap:wrap; min-width:0; }
    .kjideo-preset { display:flex; width:42px; height:20px; padding:2px; gap:1px; border:1px solid #565f67; border-radius:4px; background:#242b30; cursor:pointer; box-sizing:border-box; flex-shrink:0; }
    .kjideo-preset:hover { border-color:#46b4e6; filter:brightness(1.12); }
    .kjideo-preset span { flex:1 1 0; min-width:0; border-radius:2px; }
    .kjideo-inline { position:absolute; box-sizing:border-box; background:rgba(18,18,18,0.92); border:2px solid #46b4e6; border-radius:3px; color:#fff; font:13px monospace; padding:3px 4px; resize:none; outline:none; z-index:10; }
  `;
  document.head.appendChild(s);
}

app.registerExtension({
  name: "GJJ.Ideogram4PromptBuilder",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "GJJ_Ideogram4PromptBuilder") return;
    injectStyle();

    chainCallback(nodeType.prototype, "onNodeCreated", function () {
      const node = this;
      const findW = (n) => node.widgets?.find((w) => w.name === n);
      const elementsWidget = findW("elements_data");
      const stylePaletteWidget = findW("style_palette_data");
      const imageElementWidget = findW("image_element_data");
      const bboxesWidget = findW("bboxes");
      const wWidget = findW("width"), hWidget = findW("height");
      function hideWidget(widget) {
        if (!widget || widget.__gjjIdeoHidden) return;
        widget.__gjjIdeoHidden = {
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
        widget.hidden = true;
        widget.type = `converted-widget:${widget.name || "hidden"}`;
        widget.computeSize = () => [0, 0];
        widget.getHeight = () => 0;
        widget.draw = () => {};
        widget.options ||= {};
        widget.options.hidden = true;
        widget.options.display = "hidden";
        widget.y = -100000;
        widget.last_y = -100000;
      }
      function restoreWidget(widget) {
        const saved = widget?.__gjjIdeoHidden;
        if (!widget || !saved) return;
        widget.type = saved.type;
        widget.hidden = saved.hidden;
        widget.computeSize = saved.computeSize;
        widget.getHeight = saved.getHeight;
        widget.draw = saved.draw;
        widget.y = saved.y;
        widget.last_y = saved.last_y;
        widget.options ||= {};
        if (saved.optionsHidden === undefined) delete widget.options.hidden;
        else widget.options.hidden = saved.optionsHidden;
        if (saved.optionsDisplay === undefined) delete widget.options.display;
        else widget.options.display = saved.optionsDisplay;
        delete widget.__gjjIdeoHidden;
      }
      function removeInputByName(name) {
        const index = node.inputs?.findIndex((input) => input.name === name);
        if (index != null && index >= 0) {
          try { node.disconnectInput?.(index); } catch (_) {}
          node.removeInput(index);
        }
      }
      function ensureWidgetInput(name, type, label) {
        let input = node.inputs?.find((item) => item.name === name);
        if (!input) {
          node.addInput(label || name, type);
          input = node.inputs?.[node.inputs.length - 1];
        }
        if (input) {
          input.name = name;
          input.label = label || name;
          input.localized_name = label || name;
          input.type = type;
          input.widget = { name };
        }
      }
      function hideParamWidgets() {
        for (const name of PARAM_WIDGETS) hideWidget(findW(name));
        hideWidget(bboxesWidget);
      }
      // Hide the data widgets while keeping them serializable.
      function hideDataWidgets() {
        for (const w of [elementsWidget, stylePaletteWidget, imageElementWidget]) {
          if (!w) continue;
          hideWidget(w);
        }
        for (const name of ["elements_data", "style_palette_data", "image_element_data"]) {
          const i = node.inputs?.findIndex((inp) => inp.name === name);
          if (i != null && i !== -1) node.removeInput(i);
        }
      }
      function socketsEnabled() {
        return Boolean(node.properties?.[SOCKETS_PROPERTY]);
      }
      function paramModeEnabled() {
        return Boolean(node.properties?.[PARAM_MODE_PROPERTY]);
      }
      function applySocketVisibility() {
        const enabled = socketsEnabled();
        for (const [name, spec] of Object.entries(SOCKET_WIDGETS)) {
          if (enabled && !(paramModeEnabled() && (name === "width" || name === "height"))) ensureWidgetInput(name, spec.type, spec.label);
          else removeInputByName(name);
        }
        hideParamWidgets();
        app.graph?.setDirtyCanvas?.(true, true);
        app.canvas?.setDirty?.(true, true);
      }
      hideDataWidgets();
      hideParamWidgets();
      applySocketVisibility();

      node._boxes = [];        // {x,y,w,h normalized 0-1, type, text, desc, palette[]}
      node._stylePalette = []; // global style color palette (hex[])
      node._activeIdx = -1;
      node._drawing = false;
      node._dragMode = null;
      node._dragStartN = null; // mouse-down point, normalized
      node._boxAtStart = null; // active box snapshot at drag start
      node._hoverTitle = null; // index of the title chip under the cursor
      node._hoverBox = null;   // index of the box under the cursor
      node._hoverFolder = null; // index of the image element folder button
      node._focused = false;   // editor (DOM) focused — gates the active-box highlight
      node._selected = false;  // node selected in the graph
      node._lastImported = ""; // last import_json applied to the editor (avoid re-apply)
      node._areaH = node._areaH || {};      // remembered textarea heights (per field)
      node._areaObservers = [];             // live ResizeObservers to disconnect on rebuild
      node._imageElementThumbs = new Map();
      node._upstreamImageThumbSrc = "";

      // ── DOM ──
      const wrap = document.createElement("div");
      wrap.className = "kjideo-wrap";
      const bar = document.createElement("div");
      bar.className = "kjideo-bar";
      const hint = document.createElement("span");
      hint.className = "kjideo-hint";
      const copyBtn = document.createElement("button");
      copyBtn.className = "kjideo-btn";
      copyBtn.textContent = "复制";
      copyBtn.title = "复制当前生成的 Ideogram 4 JSON 提示词";
      const settingsBtn = document.createElement("button");
      settingsBtn.className = "kjideo-btn";
      settingsBtn.textContent = "⚙️设置";
      settingsBtn.title = "展开或收起图片反推模型和接口设置";
      const imageSettingsBtn = document.createElement("button");
      imageSettingsBtn.className = "kjideo-btn";
      imageSettingsBtn.textContent = "📝描述";
      imageSettingsBtn.title = "展开或收起画布、整体描述和样式设置";
      const paramsBtn = document.createElement("button");
      paramsBtn.className = "kjideo-btn";
      paramsBtn.textContent = "⚡参数";
      paramsBtn.title = "开启后从 GJJ_TemplateParams 动态读取宽度和高度，并隐藏宽高插槽";
      const colorBtn = document.createElement("button");
      colorBtn.className = "kjideo-btn";
      colorBtn.textContent = "🎨色系";
      colorBtn.title = "按色系风格随机给样式和每个元素分配配色";
      const socketBtn = document.createElement("button");
      socketBtn.className = "kjideo-btn";
      socketBtn.textContent = "🔌接口";
      socketBtn.title = "显示或隐藏宽度、高度、外部框选 bboxes 输入口";
      const importBtn = document.createElement("button");
      importBtn.className = "kjideo-btn";
      importBtn.textContent = "导入";
      importBtn.title = "从剪贴板或弹窗粘贴 Ideogram 4 JSON，并导入到编辑器";
      const clearBtn = document.createElement("button");
      clearBtn.className = "kjideo-btn";
      clearBtn.textContent = "清空";
      const tokenSpan = document.createElement("span");
      tokenSpan.style.cssText = "color:#888; white-space:nowrap;";
      tokenSpan.title = "粗略词元估算（约等于字符数 / 4），仅供参考";
      bar.appendChild(hint); bar.appendChild(tokenSpan); bar.appendChild(settingsBtn); bar.appendChild(imageSettingsBtn); bar.appendChild(paramsBtn); bar.appendChild(colorBtn); bar.appendChild(socketBtn); bar.appendChild(copyBtn); bar.appendChild(importBtn); bar.appendChild(clearBtn);

      // Persistent global style-palette row
      const styleBar = document.createElement("div");
      styleBar.className = "kjideo-bar";
      const styleLbl = document.createElement("span");
      styleLbl.textContent = "样式颜色：";
      styleBar.appendChild(styleLbl);

      const settingsPanel = document.createElement("div");
      settingsPanel.className = "kjideo-settings";
      const imageSettingsPanel = document.createElement("div");
      imageSettingsPanel.className = "kjideo-settings";

      const canvasEl = document.createElement("canvas");
      canvasEl.className = "kjideo-canvas";
      canvasEl.tabIndex = 0;                                  // focusable, so it can receive key events
      canvasEl.title = "拖拽绘制区域 · 单击选择 · Alt 单击切换重叠区域 · 双击编辑描述 · Delete 删除 · Ctrl/Cmd+C/V/D 复制/粘贴/复制区域";
      const ctx = canvasEl.getContext("2d");
      const imageFileInput = document.createElement("input");
      imageFileInput.type = "file";
      imageFileInput.accept = "image/*";
      imageFileInput.style.display = "none";
      wrap.appendChild(imageFileInput);
      addWheelPassthrough(wrap);
      addMiddleClickPan(canvasEl);

      function ensureBoxId(box) {
        if (!box) return "";
        if (!box.gjjImageId) box.gjjImageId = `img_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        return box.gjjImageId;
      }

      function setImageElementThumb(box, src) {
        const next = String(src || "").trim();
        const key = ensureBoxId(box);
        if (!key) return;
        if (!next) {
          node._imageElementThumbs.delete(key);
          if (box) delete box.imageData;
          drawCanvas();
          return;
        }
        if (box) box.imageData = next;
        const cached = node._imageElementThumbs.get(key);
        if (cached?.src === next && cached?.image) return;
        const img = new Image();
        img.onload = () => drawCanvas();
        img.onerror = () => drawCanvas();
        img.src = next;
        node._imageElementThumbs.set(key, { src: next, image: img });
        drawCanvas();
      }

      function restoreImageElementThumbs() {
        node._imageElementThumbs = new Map();
        const legacy = imageElementWidget?.value || "";
        for (const box of node._boxes) {
          if (box?.type !== "image") continue;
          const src = String(box.imageData || box.image_data || "").trim() || (legacy && !node._boxes.some((b) => b?.imageData) ? legacy : "");
          if (src) setImageElementThumb(box, src);
        }
      }

      function imageForBox(box) {
        const key = ensureBoxId(box);
        const localSrc = String(box?.imageData || box?.image_data || "").trim();
        if (localSrc) {
          const cached = node._imageElementThumbs.get(key);
          if (!cached || cached.src !== localSrc) setImageElementThumb(box, localSrc);
          return node._imageElementThumbs.get(key)?.image || null;
        }
        const upstream = String(node._upstreamImageThumbSrc || "").trim();
        if (!upstream) return null;
        const upstreamKey = `${key}:upstream`;
        const cached = node._imageElementThumbs.get(upstreamKey);
        if (cached?.src === upstream) return cached.image;
        const img = new Image();
        img.onload = () => drawCanvas();
        img.onerror = () => drawCanvas();
        img.src = upstream;
        node._imageElementThumbs.set(upstreamKey, { src: upstream, image: img });
        return img;
      }

      function drawImageThumbInRect(box, x1, y1, w, h) {
        const img = imageForBox(box);
        if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight || w <= 1 || h <= 1) return false;
        const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
        const dw = Math.max(1, Math.round(img.naturalWidth * scale));
        const dh = Math.max(1, Math.round(img.naturalHeight * scale));
        const dx = Math.round(x1 + (w - dw) / 2);
        const dy = Math.round(y1 + (h - dh) / 2);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x1, y1, w, h);
        ctx.clip();
        ctx.fillStyle = "#0d1113";
        ctx.fillRect(x1, y1, w, h);
        ctx.drawImage(img, dx, dy, dw, dh);
        ctx.restore();
        return true;
      }

      const panel = document.createElement("div");
      panel.className = "kjideo-panel";

      // Canvas above panel so the panel grows downward without shifting the canvas.
      wrap.appendChild(bar); wrap.appendChild(settingsPanel); wrap.appendChild(imageSettingsPanel); wrap.appendChild(styleBar); wrap.appendChild(canvasEl); wrap.appendChild(panel);

      const TOOLBAR_H = 22;
      node._widgetHeight = 360;
      node.ideoEditor = node.addDOMWidget("ideo_editor", "Ideogram4Editor", wrap, {
        serialize: false, hideOnZoom: false,
        getMinHeight: () => node._widgetHeight,
      });
      node.resizable = true;

      // ── canvas sizing ──
      // The display size is CSS-driven (width:100% + aspect-ratio); the backing store
      // is sized to display × devicePixelRatio in prepCanvas() so text/lines stay crisp.
      function setCanvasSize(w, h) {
        canvasEl.style.aspectRatio = `${w} / ${h}`;          // display shape only
        if (node.graph) node.graph.setDirtyCanvas(true, true);
      }
      function syncCanvasToDims() {
        const w = wWidget ? wWidget.value : 1024, h = hWidget ? hWidget.value : 1024;
        setCanvasSize(Math.max(1, w), Math.max(1, h));
        drawCanvas();
      }

      // Content height = panel's bottom edge in the wrapper (includes toolbar/canvas/gaps).
      function recalcWidgetHeight() {
        const contentH = panel.offsetTop + panel.offsetHeight;
        if (contentH > 0) {
          node._widgetHeight = contentH + 10;                  // margin pad
        } else {                                               // not laid out yet — estimate
          const ratio = (hWidget?.value || 1) / (wWidget?.value || 1);
          node._widgetHeight = Math.round(Math.max(100, node.size[0] - 30) * ratio) + TOOLBAR_H + 70;
        }
      }
      function fitNode() {
        recalcWidgetHeight();
        // computeSize (stable min-heights), not last_y which creeps with growable widgets above.
        const minH = node.computeSize()[1];
        const currentW = Math.round(node.size?.[0] || 360);
        const nextH = Math.round(minH);
        if (Math.abs((node.size?.[1] || 0) - nextH) > 1) {
          node.setSize([currentW, nextH]);
        }
      }

      // ── geometry helpers ── (logical CSS px = the displayed canvas size)
      function logW() { return canvasEl.offsetWidth || 1; }
      function logH() { return canvasEl.offsetHeight || 1; }
      function toPx(b) {
        const W = logW(), H = logH();
        return { x1: b.x * W, y1: b.y * H, x2: (b.x + b.w) * W, y2: (b.y + b.h) * H };
      }
      function mouseN(e) {
        const r = canvasEl.getBoundingClientRect();
        return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
      }
      function clamp01(v) { return Math.max(0, Math.min(1, v)); }
      function ellipsizeLine(text, maxW) {
        const dots = "...";
        const raw = String(text || "");
        if (ctx.measureText(raw).width <= maxW) return raw;
        let out = "";
        for (const ch of Array.from(raw)) {
          const next = out + ch;
          if (ctx.measureText(next + dots).width > maxW) break;
          out = next;
        }
        return out ? out + dots : dots;
      }
      // Greedy word-wrap to maxW px. Chinese/long tokens are broken by character;
      // vertical overflow is represented by ... on the final visible line.
      function wrapLines(text, maxW, maxLines = Infinity) {
        maxW = Math.max(8, Number(maxW) || 8);
        maxLines = Math.max(1, Math.floor(Number(maxLines) || 1));
        const all = [];
        const pushLine = (line) => all.push(String(line || ""));
        const pushToken = (token, line) => {
          let current = line;
          for (const ch of Array.from(token)) {
            const next = current + ch;
            if (current && ctx.measureText(next).width > maxW) {
              pushLine(current);
              current = ch;
            } else {
              current = next;
            }
          }
          return current;
        };
        for (const para of String(text || "").split("\n")) {
          let line = "";
          for (const token of para.split(/(\s+)/)) {
            if (!token) continue;
            const isSpace = /^\s+$/.test(token);
            const next = line + token;
            if (ctx.measureText(next).width <= maxW) {
              line = next;
            } else if (isSpace) {
              pushLine(line.trimEnd());
              line = "";
            } else if (!line) {
              line = pushToken(token, "");
            } else {
              pushLine(line.trimEnd());
              line = pushToken(token, "");
            }
          }
          pushLine(line.trimEnd());
        }
        const lines = all.filter((line, index) => line || index === 0);
        if (lines.length <= maxLines) return lines;
        const visible = lines.slice(0, maxLines);
        visible[visible.length - 1] = ellipsizeLine(visible[visible.length - 1], maxW);
        return visible;
      }
      function normalizeBox(b) {
        // collapse negative size to positive top-left + w/h, clamp into canvas
        let x = b.x, y = b.y, w = b.w, h = b.h;
        if (w < 0) { x += w; w = -w; }
        if (h < 0) { y += h; h = -h; }
        x = clamp01(x); y = clamp01(y);
        w = Math.min(w, 1 - x); h = Math.min(h, 1 - y);
        return { ...b, x, y, w: Math.max(0, w), h: Math.max(0, h) };
      }

      // All boxes under the point, top-first to match draw order: the active box is
      // drawn last (on top), then the rest by index high→low.
      function boxesAt(mN) {
        const rx = HANDLE / logW(), ry = HANDLE / logH();
        const res = [];
        for (let i = node._boxes.length - 1; i >= 0; i--) {
          const b = node._boxes[i];
          const mode = rectHitTestN(mN.x, mN.y, b.x, b.y, b.x + b.w, b.y + b.h, rx, ry);
          if (mode) res.push({ index: i, mode });
        }
        const ai = res.findIndex((c) => c.index === node._activeIdx);
        if (ai > 0) res.unshift(res.splice(ai, 1)[0]);
        return res;
      }
      // Hover / right-click: prefer a resize handle on the active box, else topmost.
      function hitTest(mN) {
        const cands = boxesAt(mN);
        if (!cands.length) return null;
        return cands.find((c) => c.index === node._activeIdx && c.mode !== "move") || cands[0];
      }
      // Tag-chip rects (canvas px), placed to avoid overlapping each other: each
      // box's tag tries top-left, top-right, bottom-right, bottom-left in turn.
      function tagRects() {
        ctx.font = "bold 11px monospace";
        const W = logW(), H = logH(), h = 14;
        const placed = [], rects = [];
        const hits = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        for (let i = 0; i < node._boxes.length; i++) {
          const b = node._boxes[i];
          const x1 = b.x * W, y1 = b.y * H, x2 = (b.x + b.w) * W, y2 = (b.y + b.h) * H;
          const tag = String(i + 1).padStart(2, "0");
          const w = ctx.measureText(tag).width + 8;
          let pick = [x1, y1];
          for (const [cx, cy] of [[x1, y1], [x2 - w, y1], [x2 - w, y2 - h], [x1, y2 - h]]) {
            if (!placed.some((p) => hits({ x: cx, y: cy, w, h }, p))) { pick = [cx, cy]; break; }
          }
          const r = { x: pick[0], y: pick[1], w, h, tag };
          placed.push(r); rects[i] = r;
        }
        return rects;
      }
      function titleAt(mN) {
        const px = mN.x * logW(), py = mN.y * logH();
        const rects = tagRects();
        for (let i = node._boxes.length - 1; i >= 0; i--) {
          const r = rects[i];
          if (r && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return i;
        }
        return null;
      }
      function folderRects() {
        const W = logW(), H = logH();
        const rects = [];
        for (let i = 0; i < node._boxes.length; i++) {
          const b = node._boxes[i];
          if (b.type !== "image") continue;
          const x2 = (b.x + b.w) * W, y1 = b.y * H;
          rects[i] = { x: Math.max(0, x2 - 25), y: Math.max(0, y1 + 4), w: 21, h: 19 };
        }
        return rects;
      }
      function folderAt(mN) {
        const px = mN.x * logW(), py = mN.y * logH();
        const rects = folderRects();
        for (let i = node._boxes.length - 1; i >= 0; i--) {
          const r = rects[i];
          if (r && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return i;
        }
        return null;
      }
      // Click selection: active box's resize handle wins (corner resize); then a
      // title-chip click selects that box (drawn to front); Alt-click cycles the
      // overlap stack; else the topmost box.
      function pickForSelection(mN, cycle) {
        const cands = boxesAt(mN);
        if (!cands.length) return null;
        const ah = cands.find((c) => c.index === node._activeIdx && c.mode !== "move");
        if (ah && !cycle) return ah;
        const ti = titleAt(mN);
        if (ti !== null && !cycle) return { index: ti, mode: "move" };
        if (cycle && cands.length > 1) {
          const pos = cands.findIndex((c) => c.index === node._activeIdx);
          return cands[(pos + 1) % cands.length];
        }
        return cands.find((c) => c.index === node._activeIdx && c.mode !== "move") || cands[0];
      }
      // normalized variant of rectHitTest with separate x/y radii
      function rectHitTestN(mx, my, x1, y1, x2, y2, rx, ry) {
        const h = (cx, cy) => Math.abs(mx - cx) < rx && Math.abs(my - cy) < ry;
        if (h(x1, y1)) return "resize-tl";
        if (h(x2, y1)) return "resize-tr";
        if (h(x1, y2)) return "resize-bl";
        if (h(x2, y2)) return "resize-br";
        if (mx >= x1 && mx <= x2 && Math.abs(my - y1) < ry) return "resize-t";
        if (mx >= x1 && mx <= x2 && Math.abs(my - y2) < ry) return "resize-b";
        if (my >= y1 && my <= y2 && Math.abs(mx - x1) < rx) return "resize-l";
        if (my >= y1 && my <= y2 && Math.abs(mx - x2) < rx) return "resize-r";
        if (mx >= x1 && mx <= x2 && my >= y1 && my <= y2) return "move";
        return null;
      }

      function applyDrag(mode, start, dN) {
        let { x, y, w, h } = start;
        const dx = dN.x, dy = dN.y;
        switch (mode) {
          case "move": x += dx; y += dy; x = clamp01(Math.min(x, 1 - w)); y = clamp01(Math.min(y, 1 - h)); break;
          case "draw":
          case "resize-br": w += dx; h += dy; break;
          case "resize-tl": x += dx; y += dy; w -= dx; h -= dy; break;
          case "resize-tr": y += dy; w += dx; h -= dy; break;
          case "resize-bl": x += dx; w -= dx; h += dy; break;
          case "resize-t": y += dy; h -= dy; break;
          case "resize-b": h += dy; break;
          case "resize-l": x += dx; w -= dx; break;
          case "resize-r": w += dx; break;
        }
        return mode === "move" ? { ...start, x, y } : normalizeBox({ ...start, x, y, w, h });
      }

      // ── drawing ──
      let _rafPending = false;
      function drawCanvas() {
        if (_rafPending) return;
        _rafPending = true;
        requestAnimationFrame(() => {
          _rafPending = false;
          _draw();
        });
      }
      function _draw() {
        // Size the backing store to display × DPR and draw in logical px (crisp text/lines).
        const W = logW(), H = logH(), d = window.devicePixelRatio || 1;
        const bw = Math.round(W * d), bh = Math.round(H * d);
        if (canvasEl.width !== bw || canvasEl.height !== bh) { canvasEl.width = bw; canvasEl.height = bh; }
        ctx.setTransform(d, 0, 0, d, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = "#1a1a1a"; ctx.fillRect(0, 0, W, H);
        // active box only when the editor is focused or the node is selected
        const aIdx = (node._focused || node._selected) ? node._activeIdx : -1;
        const order = node._boxes.map((_, i) => i).filter((i) => i !== aIdx);
        if (aIdx >= 0 && aIdx < node._boxes.length) order.push(aIdx);  // active drawn last (on top)
        const tagR = tagRects();                              // collision-avoided tag positions
        for (const i of order) {
          const b = node._boxes[i], active = i === aIdx;
          const pal = (b.palette || []).filter(Boolean);
          const col = pal.length ? pal[0] : "#8c8c8c";       // box color = first palette color, else neutral grey
          const { x1, y1, x2, y2 } = toPx(b);
          const w = x2 - x1, h = y2 - y1;
          const hovered = i === node._hoverBox || active;    // active box stays highlighted (on top)
          if (active) {                                      // opaque backing so contents read clearly over boxes behind
            ctx.fillStyle = "rgba(26,26,26,0.88)";
            ctx.fillRect(x1, y1, w, h);
          }
          ctx.fillStyle = col + (hovered ? "3a" : "22");     // tint of the box color
          ctx.fillRect(x1, y1, w, h);
          if (b.type === "image") {
            const drewThumb = drawImageThumbInRect(b, x1, y1, w, h);
            if (drewThumb && hovered) {
              ctx.fillStyle = "rgba(70,180,230,0.12)";
              ctx.fillRect(x1, y1, w, h);
            }
          }
          if (b.nobbox) ctx.setLineDash([6, 4]);             // unplaced (no bbox in source)
          const lw = active ? 2 : (hovered ? 1.5 : 1);
          ctx.strokeStyle = col; ctx.lineWidth = lw;
          ctx.strokeRect(x1 + lw / 2, y1 + lw / 2, w - lw, h - lw);  // inside the box so strip/badge align at y1
          ctx.setLineDash([]);
          if (pal.length) {                                  // palette shown as a strip along the top edge
            const sw = w / pal.length, n = pal.length, sh = 7;
            for (let p = 0; p < n; p++) {
              const sx = x1 + Math.round(p * sw);
              ctx.fillStyle = pal[p];
              ctx.fillRect(sx, y1, x1 + Math.round((p + 1) * sw) - sx, sh);
            }
          }
          if (b.type === "image") {
            const fr = folderRects()[i];
            if (fr) {
              ctx.save();
              ctx.fillStyle = i === node._hoverFolder ? "rgba(70,180,230,0.95)" : "rgba(18,18,18,0.82)";
              ctx.strokeStyle = "#6bc8f0";
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.roundRect?.(fr.x, fr.y, fr.w, fr.h, 4);
              if (ctx.roundRect) {
                ctx.fill();
                ctx.stroke();
              } else {
                ctx.fillRect(fr.x, fr.y, fr.w, fr.h);
                ctx.strokeRect(fr.x, fr.y, fr.w, fr.h);
              }
              ctx.font = "13px sans-serif";
              ctx.fillStyle = "#fff";
              ctx.fillText("📁", fr.x + 4, fr.y + 14);
              ctx.restore();
            }
          }
          // in-box content (clipped to the box): prompt text, tag chip on top
          ctx.save();
          ctx.beginPath(); ctx.rect(x1, y1, w, h); ctx.clip();

          let body = b.desc || "";
          if (b.type === "image") {
            const label = body ? "描述已写入JSON" : "等待图片反推";
            ctx.font = "11px sans-serif";
            const pad = 5;
            const labelW = Math.min(w - 8, ctx.measureText(label).width + pad * 2);
            if (labelW > 18 && h > 28) {
              const labelH = 18;
              const lx = x1 + 4;
              const ly = y2 - labelH - 4;
              ctx.fillStyle = "rgba(13,17,19,0.78)";
              ctx.fillRect(lx, ly, labelW, labelH);
              ctx.strokeStyle = "rgba(255,255,255,0.18)";
              ctx.lineWidth = 1;
              ctx.strokeRect(lx + 0.5, ly + 0.5, labelW - 1, labelH - 1);
              ctx.fillStyle = "#e8f1f3";
              ctx.fillText(label, lx + pad, ly + 13);
            }
            body = "";
          }
          if (b.type === "text" && b.text) body = `"${b.text}"` + (body ? " — " + body : "");
          if (body) {
            ctx.font = "12px monospace";
            ctx.fillStyle = "#d4d4d4";                      // neutral prompt text
            const pad = 4, lh = 14;
            let ty = y1 + 15 + 12;                          // first line below the tag chip
            const maxLines = Math.max(1, Math.floor((y1 + h - ty) / lh) + 1);
            for (const line of wrapLines(body, w - pad * 2, maxLines)) {
              ctx.fillText(line, x1 + pad, ty);
              ty += lh;
            }
          }
          // tag chip on top, at its collision-avoided position
          const tr = tagR[i];
          const tagBg = col;                                  // neutral tag chip
          ctx.font = "bold 11px monospace";
          ctx.fillStyle = tagBg;
          ctx.fillRect(tr.x, tr.y, tr.w, 14);
          if (i === node._hoverTitle) {                       // hover highlight
            ctx.fillStyle = "rgba(255,255,255,0.25)"; ctx.fillRect(tr.x, tr.y, tr.w, 14);
            ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.strokeRect(tr.x + 0.5, tr.y + 0.5, tr.w - 1, 13);
          }
          ctx.fillStyle = textOn(tagBg);
          ctx.fillText(tr.tag, tr.x + 4, tr.y + 11);
          ctx.restore();
        }
      }

      // ── serialization ──
      function serialize() {
        if (elementsWidget) elementsWidget.value = node._boxes.length ? JSON.stringify(node._boxes) : "";
        if (stylePaletteWidget) stylePaletteWidget.value = node._stylePalette.length ? JSON.stringify(node._stylePalette) : "";
      }

      function commit() { serialize(); renderPanel(); drawCanvas(); updateTokens(); }

      function removeBox(i) {
        node._boxes.splice(i, 1);
        if (node._boxes.length === 0) node._activeIdx = -1;
        else if (i <= node._activeIdx) node._activeIdx = Math.max(0, node._activeIdx - 1);
      }

      // ── pointer interaction ──
      canvasEl.addEventListener("mousedown", (e) => {
        const folderIndex = folderAt(mouseN(e));
        if (e.button === 0 && folderIndex !== null) {
          e.preventDefault();
          e.stopPropagation();
          node._activeIdx = folderIndex;
          imageFileInput.click();
          drawCanvas();
          renderPanel();
          return;
        }
        if (e.button === 2) {            // right-click delete
          e.preventDefault();
          const hit = hitTest(mouseN(e));
          if (hit) removeBox(hit.index);
          else if (node._activeIdx >= 0) removeBox(node._activeIdx);
          commit(); fitNode();
          return;
        }
        if (e.button !== 0) return;
        canvasEl.focus();                // so Delete/Backspace targets this editor
        node._hoverTitle = null; node._hoverBox = null;  // clear hover highlight while interacting
        const mN = mouseN(e);
        const hit = pickForSelection(mN, e.altKey);
        if (hit) {
          node._activeIdx = hit.index;
          node._dragMode = hit.mode;
          node._boxAtStart = { ...node._boxes[hit.index] };
        } else {
          node._dragMode = "draw";
          const nb = { x: mN.x, y: mN.y, w: 0, h: 0, type: "obj", text: "", desc: "", palette: [] };
          node._boxes.push(nb);
          node._activeIdx = node._boxes.length - 1;
          node._boxAtStart = { ...nb };
        }
        node._drawing = true;
        node._dragStartN = mN;
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        e.preventDefault(); e.stopPropagation();
        drawCanvas();   // panel rebuild/resize deferred to onUp so the canvas doesn't shift mid-drag
      });

      canvasEl.addEventListener("mousemove", (e) => {
        if (node._drawing) return;
        const mN = mouseN(e);
        const fi = folderAt(mN);
        const ti = titleAt(mN);
        const hit = hitTest(mN);
        const hb = ti != null ? ti : (hit ? hit.index : null);
        if (ti !== node._hoverTitle || hb !== node._hoverBox || fi !== node._hoverFolder) {
          node._hoverTitle = ti; node._hoverBox = hb; node._hoverFolder = fi; drawCanvas();
        }
        canvasEl.style.cursor = fi != null || ti != null ? "pointer" : (hit ? (cursorForBboxMode(hit.mode) || "crosshair") : "crosshair");
      });
      canvasEl.addEventListener("mouseleave", () => {
        if (node._hoverTitle !== null || node._hoverBox !== null || node._hoverFolder !== null) {
          node._hoverTitle = null; node._hoverBox = null; node._hoverFolder = null; drawCanvas();
        }
      });

      imageFileInput.addEventListener("change", () => {
        const file = imageFileInput.files?.[0];
        imageFileInput.value = "";
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result || "");
          const b = node._boxes[node._activeIdx];
          if (b) {
            b.type = "image";
            b.desc = "";
            setImageElementThumb(b, dataUrl);
          }
          commit();
          fitNode();
        };
        reader.readAsDataURL(file);
      });

      // ── inline description editing (double-click a region) ──
      let inlineTa = null;
      function closeInlineEditor() {
        if (inlineTa) { inlineTa.remove(); inlineTa = null; }
      }
      function openInlineEditor(idx) {
        closeInlineEditor();
        const b = node._boxes[idx];
        if (!b) return;
        node._activeIdx = idx;
        const dw = canvasEl.offsetWidth, dh = canvasEl.offsetHeight;       // CSS display size
        const ox = canvasEl.offsetLeft, oy = canvasEl.offsetTop;
        const w = Math.min(dw, Math.max(70, b.w * dw));
        const h = Math.min(dh, Math.max(42, b.h * dh));
        // clamp so the editor stays inside the canvas (wrapper is overflow:hidden)
        const left = Math.max(ox, Math.min(ox + b.x * dw, ox + dw - w));
        const top = Math.max(oy, Math.min(oy + b.y * dh, oy + dh - h));
        const ta = document.createElement("textarea");
        ta.className = "kjideo-inline";
        ta.value = b.desc || "";
        ta.style.left = left + "px";
        ta.style.top = top + "px";
        ta.style.width = w + "px";
        ta.style.height = h + "px";
        ta.style.borderColor = (b.palette || []).find(Boolean) || "#46b4e6";  // first palette color, else accent
        stopProp(ta);
        wrap.appendChild(ta);
        inlineTa = ta;
        ta.focus(); ta.select();
        const orig = b.desc || "";
        let cancelled = false;
        ta.addEventListener("input", () => { b.desc = ta.value; drawCanvas(); updateTokens(); });
        ta.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Escape") { cancelled = true; b.desc = orig; ta.blur(); }
          else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ta.blur();
        });
        ta.addEventListener("blur", () => {
          if (!cancelled) b.desc = ta.value;
          closeInlineEditor();
          commit();
        });
      }
      canvasEl.addEventListener("dblclick", (e) => {
        e.preventDefault(); e.stopPropagation();
        const cands = boxesAt(mouseN(e));     // edit the active box if it's under the cursor, else topmost
        const target = cands.find((c) => c.index === node._activeIdx) || cands[0];
        if (target) openInlineEditor(target.index);
      });

      // Paste a clone of the clipboard box, offset slightly and clamped into the canvas.
      function pasteBox() {
        if (!copiedBox) return;
        const nb = JSON.parse(JSON.stringify(copiedBox));
        nb.x = Math.max(0, Math.min(clamp01(nb.x + 0.03), 1 - nb.w));
        nb.y = Math.max(0, Math.min(clamp01(nb.y + 0.03), 1 - nb.h));
        delete nb.nobbox;                              // a pasted box is placed
        node._boxes.push(nb);
        node._activeIdx = node._boxes.length - 1;
        commit(); fitNode();
      }
      // Keyboard: Delete removes; Ctrl/Cmd C/V/D copy/paste/duplicate the active region.
      // Canvas must be focused; stop the event so LiteGraph doesn't act on the node.
      canvasEl.addEventListener("keydown", (e) => {
        if (node._drawing) return;
        const ctrl = e.ctrlKey || e.metaKey;
        if ((e.key === "Delete" || e.key === "Backspace") && node._activeIdx >= 0) {
          e.preventDefault(); e.stopPropagation();
          removeBox(node._activeIdx); commit(); fitNode();
        } else if (ctrl && e.key === "c" && node._activeIdx >= 0) {
          e.preventDefault(); e.stopPropagation();
          copiedBox = JSON.parse(JSON.stringify(node._boxes[node._activeIdx]));
        } else if (ctrl && e.key === "v" && copiedBox) {
          e.preventDefault(); e.stopPropagation();
          pasteBox();
        } else if (ctrl && e.key === "d" && node._activeIdx >= 0) {
          e.preventDefault(); e.stopPropagation();
          copiedBox = JSON.parse(JSON.stringify(node._boxes[node._activeIdx]));
          pasteBox();
        }
      });

      function onMove(e) {
        if (!node._drawing) return;
        const mN = mouseN(e);
        const dN = { x: mN.x - node._dragStartN.x, y: mN.y - node._dragStartN.y };
        const nb = applyDrag(node._dragMode, node._boxAtStart, dN);
        delete nb.nobbox;            // moving/resizing places the element (gives it a bbox)
        node._boxes[node._activeIdx] = nb;
        drawCanvas();
      }
      function onUp() {
        if (!node._drawing) return;
        node._drawing = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        // drop zero-size boxes created by an accidental click
        const b = node._boxes[node._activeIdx];
        if (b && (b.w < 0.005 || b.h < 0.005) && node._dragMode === "draw") {
          removeBox(node._activeIdx);
        }
        commit();
      }

      canvasEl.addEventListener("contextmenu", (e) => e.preventDefault());
      clearBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      clearBtn.addEventListener("click", () => {
        closeInlineEditor();
        node._boxes = []; node._activeIdx = -1; node._stylePalette = [];
        if (imageElementWidget) imageElementWidget.value = "";
        node._imageElementThumbs = new Map();
        node._upstreamImageThumbSrc = "";
        commit(); rebuildStylePalette(); fitNode();
      });
      settingsBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      settingsBtn.addEventListener("click", () => {
        node.properties ||= {};
        node.properties[SETTINGS_PROPERTY] = !node.properties[SETTINGS_PROPERTY];
        refreshSettingsPanel();
      });
      imageSettingsBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      imageSettingsBtn.addEventListener("click", () => {
        node.properties ||= {};
        node.properties[IMAGE_SETTINGS_PROPERTY] = !node.properties[IMAGE_SETTINGS_PROPERTY];
        refreshSettingsPanel();
      });
      paramsBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      paramsBtn.addEventListener("click", toggleTemplateParamsMode);
      colorBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      colorBtn.addEventListener("click", applyColorScheme);
      socketBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      socketBtn.addEventListener("click", () => {
        node.properties ||= {};
        node.properties[SOCKETS_PROPERTY] = !node.properties[SOCKETS_PROPERTY];
        applySocketVisibility();
        refreshSettingsPanel();
        fitNode();
      });

      // ── build caption JSON (mirrors Python key order) ──
      // pyJson: matches Python _dumps — indent=4, but scalar arrays stay on one line.
      function pyJson(v, lvl = 0) {
        if (v === null) return "null";
        if (typeof v === "number" || typeof v === "boolean") return String(v);
        if (typeof v === "string") return JSON.stringify(v);
        const pad = "    ".repeat(lvl + 1), end = "    ".repeat(lvl);
        if (Array.isArray(v)) {
          if (!v.length) return "[]";
          if (v.every((x) => x === null || typeof x !== "object"))   // scalar array → inline
            return "[" + v.map((x) => pyJson(x, lvl)).join(", ") + "]";
          return "[\n" + v.map((x) => pad + pyJson(x, lvl + 1)).join(",\n") + "\n" + end + "]";
        }
        const keys = Object.keys(v);
        if (!keys.length) return "{}";
        return "{\n" + keys.map((k) => pad + JSON.stringify(k) + ": " + pyJson(v[k], lvl + 1)).join(",\n") + "\n" + end + "}";
      }
      function getW(name) { const w = findW(name); return w ? w.value : ""; }
      function setW(name, value) {
        const w = findW(name);
        if (!w) return false;
        w.value = value;
        if (w.inputEl) w.inputEl.value = value;
        if (w.element && "value" in w.element) w.element.value = value;
        w.callback?.(value);
        return true;
      }
      function ensureCaptionBackendForModel() {
        const model = String(getW("image_caption_model") || "").trim();
        const backend = String(getW("image_caption_backend") || "");
        if (model && (backend === "关闭" || backend === "off")) setW("image_caption_backend", "Ollama");
      }
      function cleanPalette(arr) { return (arr || []).filter((c) => c).map((c) => c.toUpperCase()); }
      function align16Min256(value) {
        const n = Math.max(1, Math.round(Number(value) || 1024));
        return Math.max(Math.ceil(n / 16) * 16, 256);
      }
      function safeJsonParse(text, fallback) {
        try { return JSON.parse(String(text || "")) ?? fallback; } catch (_) { return fallback; }
      }
      function parseScalar(value) {
        if (typeof value !== "string") return value;
        const raw = value.trim();
        if (/^[-+]?\d+$/.test(raw)) return Number.parseInt(raw, 10);
        if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw)) return Number.parseFloat(raw);
        return value;
      }
      function templateParamEntries(templateNode) {
        const entries = new Map();
        const add = (key, value) => {
          const clean = String(key || "").trim();
          if (!clean) return;
          entries.set(clean, value);
          entries.set(clean.toLowerCase(), value);
        };
        const values = safeJsonParse(findWOnNode(templateNode, "values_json")?.value, {});
        const schema = safeJsonParse(findWOnNode(templateNode, "schema_json")?.value, []);
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
        for (const [key, value] of Object.entries(values || {})) add(key, parseScalar(value));
        return entries;
      }
      function findWOnNode(target, name) {
        return (target?.widgets || []).find((widget) => widget.name === name);
      }
      function templateNodes() {
        return (app.graph?._nodes || []).filter((n) => String(n?.comfyClass || n?.type || "") === TEMPLATE_PARAMS_NODE);
      }
      function selectedTemplateNode() {
        const nodes = templateNodes();
        const source = String(node.properties?.[PARAM_SOURCE_PROPERTY] || "");
        return nodes.find((n) => String(n?.id ?? "") === source) || nodes[0] || null;
      }
      function getParam(entries, names) {
        for (const name of names) {
          if (entries.has(name)) return entries.get(name);
          const lower = String(name).toLowerCase();
          if (entries.has(lower)) return entries.get(lower);
        }
        return undefined;
      }
      function applyTemplateParams(templateNode) {
        const entries = templateParamEntries(templateNode);
        const width = Number(getParam(entries, ["width", "宽度"]));
        const height = Number(getParam(entries, ["height", "高度"]));
        if (!Number.isFinite(width) || !Number.isFinite(height)) {
          alert("GJJ_TemplateParams 缺少 width/宽度 或 height/高度。");
          return false;
        }
        setW("width", align16Min256(width));
        setW("height", align16Min256(height));
        node.properties ||= {};
        node.properties[PARAM_SOURCE_PROPERTY] = String(templateNode?.id ?? "");
        syncCanvasToDims();
        fitNode();
        return true;
      }
      function refreshTemplateParams() {
        if (!paramModeEnabled()) return false;
        const chosen = selectedTemplateNode();
        if (!chosen) return false;
        return applyTemplateParams(chosen);
      }
      function toggleTemplateParamsMode() {
        node.properties ||= {};
        const next = !paramModeEnabled();
        if (!next) {
          node.properties[PARAM_MODE_PROPERTY] = false;
          applySocketVisibility();
          refreshSettingsPanel();
          fitNode();
          return;
        }
        const chosen = selectedTemplateNode();
        if (!chosen) {
          alert("当前工作流里没有 GJJ_TemplateParams 节点。");
          return;
        }
        node.properties[PARAM_MODE_PROPERTY] = true;
        if (applyTemplateParams(chosen)) {
          applySocketVisibility();
          refreshSettingsPanel();
          fitNode();
        }
      }
      function randomFrom(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
      }
      function applyColorScheme() {
        const scheme = randomFrom(COLOR_SCHEMES);
        node._stylePalette = scheme.colors.slice(0, MAX_STYLE_COLORS);
        for (const box of node._boxes) {
          const count = Math.min(MAX_ELEM_COLORS, Math.max(1, 2 + Math.floor(Math.random() * 3)));
          const shuffled = scheme.colors.slice().sort(() => Math.random() - 0.5);
          box.palette = shuffled.slice(0, count);
        }
        serialize();
        rebuildStylePalette();
        renderPanel();
        drawCanvas();
        updateTokens();
        colorBtn.textContent = `🎨${scheme.name}`;
        setTimeout(() => { colorBtn.textContent = "🎨色系"; }, 1000);
      }
      function normBboxJS(b) {
        const c = (v) => Math.max(0, Math.min(1000, Math.round(v * 1000)));
        let ymin = c(b.y), xmin = c(b.x), ymax = c(b.y + b.h), xmax = c(b.x + b.w);
        if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
        if (xmin > xmax) [xmin, xmax] = [xmax, xmin];
        return [ymin, xmin, ymax, xmax];
      }
      function buildCaption() {
        if (paramModeEnabled()) refreshTemplateParams();
        const cap = {};
        if ((getW("high_level_description") || "").trim()) cap.high_level_description = getW("high_level_description");
        const styleW = findW("style");
        const kind = styleW ? styleW.value : "无样式";
        if (kind !== "无样式" && kind !== "none") {
          const sd = { aesthetics: getW("aesthetics"), lighting: getW("lighting") };
          if (kind === "照片" || kind === "photo") { sd.photo = getW("photo") || ""; sd.medium = getW("medium"); }
          else { sd.medium = getW("medium"); sd.art_style = getW("art_style") || ""; }
          const pal = cleanPalette(node._stylePalette);
          if (pal.length) sd.color_palette = pal;
          cap.style_description = sd;
        }
        const elements = node._boxes.map((b) => {
          const etype = b.type === "text" ? "text" : "obj";
          const el = { type: etype };
          if (!b.nobbox) el.bbox = normBboxJS(b);            // unplaced elements omit bbox
          if (etype === "text") el.text = b.text || "";
          el.desc = b.desc || "";
          const pal = cleanPalette(b.palette).slice(0, MAX_ELEM_COLORS);
          if (pal.length) el.color_palette = pal;
          return el;
        });
        cap.compositional_deconstruction = { background: getW("background"), elements };
        return pyJson(cap);
      }
      // Rough token estimate (~chars/4); exact count needs the Qwen tokenizer.
      function updateTokens() {
        tokenSpan.textContent = "约 " + Math.ceil(buildCaption().length / 4) + " 词元";
      }
      async function doCopy() {
        const txt = buildCaption();
        try { await navigator.clipboard.writeText(txt); copyBtn.textContent = "已复制"; setTimeout(() => (copyBtn.textContent = "复制"), 900); }
        catch (e) { window.prompt("复制结构化 JSON：", txt); }
      }
      copyBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      copyBtn.addEventListener("click", doCopy);

      // ── import a caption JSON and populate the node ──
      function setWidgetVal(name, val) {
        const w = findW(name);
        if (w) { w.value = val; w.callback?.(val); }
      }
      function cleanHexList(arr, max) {
        return (Array.isArray(arr) ? arr : [])
          .map((c) => String(c || "").trim().toUpperCase())
          .filter(Boolean)
          .slice(0, max);
      }
      function bboxElemToBox(el, idx) {
        if (!el || typeof el !== "object") return null;
        const box = { type: el.type === "text" ? "text" : "obj",
          text: el.text || "", desc: el.desc || "",
          palette: cleanHexList(el.color_palette, MAX_ELEM_COLORS) };
        const bb = el.bbox;
        if (Array.isArray(bb) && bb.length === 4) {
          const [ymin, xmin, ymax, xmax] = bb;
          box.x = xmin / 1000; box.y = ymin / 1000; box.w = (xmax - xmin) / 1000; box.h = (ymax - ymin) / 1000;
        } else {
          // No bbox: "unplaced" element — small placeholder, flagged so export omits bbox.
          const k = (idx || 0) % 6;
          box.x = 0.03 + k * 0.035; box.y = 0.03 + k * 0.035; box.w = 0.22; box.h = 0.14;
          box.nobbox = true;
        }
        return box;
      }
      function applyCaption(cap) {
        const cd = (cap && cap.compositional_deconstruction) || {};
        const els = Array.isArray(cd.elements) ? cd.elements : [];
        node._boxes = els.map((el, i) => bboxElemToBox(el, i)).filter(Boolean);
        node._activeIdx = node._boxes.length ? 0 : -1;
        setWidgetVal("high_level_description", cap.high_level_description || "");
        setWidgetVal("background", cd.background || "");
        const sd = cap.style_description || {};
        let kind = "无样式";
        if (typeof sd.photo === "string") kind = "照片";
        else if (typeof sd.art_style === "string") kind = "艺术风格";
        setWidgetVal("style", kind);
        setWidgetVal("photo", kind === "照片" ? (sd.photo || "") : "");
        setWidgetVal("art_style", kind === "艺术风格" ? (sd.art_style || "") : "");
        setWidgetVal("aesthetics", sd.aesthetics || "");
        setWidgetVal("lighting", sd.lighting || "");
        setWidgetVal("medium", sd.medium || "");
        node._stylePalette = cleanHexList(sd.color_palette, MAX_STYLE_COLORS);
        serialize();
      }
      function tryParseCaption(t) {
        if (!t) return null;
        try { const o = JSON.parse(t); return (o && typeof o === "object" && o.compositional_deconstruction) ? o : null; }
        catch (e) { return null; }
      }
      async function doImport() {
        let cap = null, txt = "";
        try { txt = (await navigator.clipboard.readText() || "").trim(); cap = tryParseCaption(txt); } catch (e) {}
        if (!cap) { txt = (window.prompt("粘贴 Ideogram 4 结构化 JSON：", "") || "").trim(); cap = tryParseCaption(txt); }
        if (!cap) { if (txt) alert("不是有效的 Ideogram 4 结构化 JSON，需要包含构图解析内容。"); return; }
        closeInlineEditor();
        applyCaption(cap);
        syncCanvasToDims(); commit(); rebuildStylePalette(); fitNode();
      }
      importBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      importBtn.addEventListener("click", doImport);

      // Populate the editor from a caption pushed back by execute() when import_json
      // is connected (a connected socket can't be read in the frontend directly).
      function applyImported(capStr) {
        if (!capStr) return;
        const cap = tryParseCaption(capStr);
        if (!cap) return;
        node._lastImported = capStr;
        closeInlineEditor();
        applyCaption(cap);
        syncCanvasToDims(); commit(); rebuildStylePalette(); fitNode();
      }
      function ensureImageElementForThumb() {
        if (node._boxes.some((box) => box?.type === "image")) return;
        node._boxes.push({ x: 0.12, y: 0.12, w: 0.76, h: 0.76, type: "image", text: "", desc: "", palette: [] });
        node._activeIdx = node._boxes.length - 1;
        serialize();
      }
      function applyImageElementCaptions(raw) {
        const text = Array.isArray(raw) ? raw[0] : raw;
        const rows = safeJsonParse(text, []);
        if (!Array.isArray(rows) || !rows.length) return false;
        let changed = false;
        for (const row of rows) {
          const index = Number(row?.index);
          const desc = String(row?.desc || "").trim();
          const box = Number.isInteger(index) ? node._boxes[index] : null;
          if (!box || box.type !== "image" || !desc) continue;
          box.desc = desc;
          changed = true;
        }
        if (changed) {
          serialize();
          renderPanel();
          drawCanvas();
          updateTokens();
          fitNode();
        }
        return changed;
      }
      chainCallback(node, "onExecuted", function (message) {
        const appliedImageCaptions = message?.image_element_captions ? applyImageElementCaptions(message.image_element_captions) : false;
        if (!appliedImageCaptions && message?.caption) applyImported(message.caption[0]);
        if (message?.image_element_preview?.[0]) {
          ensureImageElementForThumb();
          node._upstreamImageThumbSrc = String(message.image_element_preview[0] || "");
          renderPanel();
          drawCanvas();
          fitNode();
        }
      });

      // ── property panel ──
      function stopProp(el) {
        for (const ev of ["mousedown", "pointerdown", "wheel"]) el.addEventListener(ev, (e) => e.stopPropagation());
      }
      function widgetLabel(name) {
        const labels = {
          width: "宽度",
          height: "高度",
          high_level_description: "整体概述",
          background: "背景",
          style: "样式",
          photo: "照片质感",
          art_style: "艺术风格",
          aesthetics: "审美",
          lighting: "光照",
          medium: "媒介",
          image_caption_backend: "反推方式",
          image_caption_model: "反推模型",
          image_caption_prompt: "反推提示",
          image_caption_thinking: "思考",
          image_caption_keep_alive: "模型处理",
          image_caption_max_tokens: "反推长度",
          ollama_host: "Ollama",
        };
        return labels[name] || name;
      }
      function widgetChoices(widget) {
        const values = widget?.options?.values || widget?.options?.items || widget?.values;
        return Array.isArray(values) ? values.map((v) => String(v)) : null;
      }
      function makeSettingField(name) {
        const widget = findW(name);
        if (!widget) return null;
        const row = document.createElement("div");
        row.className = "kjideo-field";
        const label = document.createElement("label");
        label.textContent = widgetLabel(name);
        label.title = widget?.options?.tooltip || widgetLabel(name);
        row.appendChild(label);
        const choices = widgetChoices(widget);
        let input;
        if (name === "style" && choices && choices.length) {
          input = document.createElement("div");
          input.className = "kjideo-choice-row";
          for (const choice of choices) {
            const btn = document.createElement("button");
            btn.className = "kjideo-btn" + (String(widget.value ?? "") === choice ? " active" : "");
            btn.textContent = choice || "未选择";
            btn.title = widget?.options?.tooltip || "";
            stopProp(btn);
            btn.addEventListener("click", () => {
              setW(name, choice);
              refreshSettingsPanel();
              updateTokens();
              drawCanvas();
              fitNode();
            });
            input.appendChild(btn);
          }
          row.appendChild(input);
          return row;
        } else if (choices && choices.length) {
          input = document.createElement("select");
          for (const choice of choices) {
            const option = document.createElement("option");
            option.value = choice;
            option.textContent = choice || "未选择";
            input.appendChild(option);
          }
        } else if (widget?.options?.multiline || name === "high_level_description" || name === "background" || name === "image_caption_prompt") {
          input = document.createElement("textarea");
        } else {
          input = document.createElement("input");
          input.type = widget?.type === "number" || widget?.type === "INT" || widget?.type === "FLOAT" ? "number" : "text";
        }
        input.value = widget.value ?? "";
        input.title = widget?.options?.tooltip || "";
        stopProp(input);
        input.addEventListener("input", () => {
          const value = (name === "width" || name === "height") ? align16Min256(input.value) : input.value;
          setW(name, value);
          if (name === "image_caption_model") ensureCaptionBackendForModel();
          if (name === "width" || name === "height") syncCanvasToDims();
          updateTokens();
          drawCanvas();
          fitNode();
        });
        input.addEventListener("change", () => {
          const value = (name === "width" || name === "height") ? align16Min256(input.value) : input.value;
          setW(name, value);
          if (name === "image_caption_model") ensureCaptionBackendForModel();
          input.value = getW(name);
          if (name === "width" || name === "height") syncCanvasToDims();
          updateTokens();
          drawCanvas();
          fitNode();
        });
        row.appendChild(input);
        return row;
      }
      function descriptionFieldNames() {
        const names = ["high_level_description", "background", "style"];
        const kind = String(getW("style") || "无样式");
        if (kind !== "无样式" && kind !== "none") {
          if (kind === "照片" || kind === "photo") names.push("photo");
          if (kind === "艺术风格" || kind === "art_style") names.push("art_style");
          names.push("aesthetics", "lighting", "medium");
        }
        if (!paramModeEnabled()) names.unshift("width", "height");
        return names;
      }
      function refreshSettingsPanel() {
        if (paramModeEnabled()) refreshTemplateParams();
        settingsPanel.innerHTML = "";
        imageSettingsPanel.innerHTML = "";
        for (const name of IMAGE_PARAM_WIDGETS) {
          const field = makeSettingField(name);
          if (field) settingsPanel.appendChild(field);
        }
        if (paramModeEnabled()) {
          const note = document.createElement("div");
          note.style.cssText = "color:#8ea0a7;font-size:11px;line-height:1.35;";
          note.textContent = "宽度和高度由 GJJ_TemplateParams 动态读取，按 16 倍数向上对齐，最小 256。";
          imageSettingsPanel.appendChild(note);
        }
        for (const name of descriptionFieldNames()) {
          const field = makeSettingField(name);
          if (field) imageSettingsPanel.appendChild(field);
        }
        settingsPanel.classList.toggle("open", Boolean(node.properties?.[SETTINGS_PROPERTY]));
        imageSettingsPanel.classList.toggle("open", Boolean(node.properties?.[IMAGE_SETTINGS_PROPERTY]));
        settingsBtn.classList.toggle("active", Boolean(node.properties?.[SETTINGS_PROPERTY]));
        imageSettingsBtn.classList.toggle("active", Boolean(node.properties?.[IMAGE_SETTINGS_PROPERTY]));
        paramsBtn.classList.toggle("active", paramModeEnabled());
        socketBtn.classList.toggle("active", socketsEnabled());
        requestAnimationFrame(fitNode);
      }
      // Color swatches: onEdit on change, onStruct on add/remove. Shared by both palettes.
      function buildSwatchRow(container, arr, max, onEdit, onStruct) {
        arr.forEach((hex, i) => {
          const sw = document.createElement("div");
          sw.className = "kjideo-sw";
          sw.style.background = hex;
          sw.title = "单击修改颜色 · 右键移除";
          const inp = document.createElement("input");
          inp.type = "color"; inp.value = hex;
          stopProp(sw);
          sw.addEventListener("click", () => inp.click());
          sw.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); arr.splice(i, 1); onStruct(); });
          inp.addEventListener("input", () => { arr[i] = inp.value; sw.style.background = inp.value; onEdit(); });
          sw.appendChild(inp);
          container.appendChild(sw);
        });
        if (arr.length < max) {
          const add = document.createElement("button");
          add.className = "kjideo-btn"; add.textContent = "+";
          stopProp(add);
          add.addEventListener("click", () => { arr.push("#ffffff"); onStruct(); });
          container.appendChild(add);
        }
      }

      function addStyleColorToActiveBox(hex) {
        const color = String(hex || "").trim().toUpperCase();
        const box = node._boxes[node._activeIdx];
        if (!box) {
          hint.textContent = "请先选择一个区域，再添加样式颜色。";
          return;
        }
        box.palette = cleanHexList(box.palette || [], MAX_ELEM_COLORS);
        if (box.palette.includes(color)) {
          return;
        }
        if (box.palette.length >= MAX_ELEM_COLORS) {
          hint.textContent = `区域 ${node._activeIdx + 1} 最多保留 ${MAX_ELEM_COLORS} 个颜色。`;
          return;
        }
        box.palette.push(color);
        commit();
        rebuildStylePalette();
      }

      function buildStylePaletteRow(container) {
        node._stylePalette.forEach((hex, i) => {
          const sw = document.createElement("div");
          sw.className = "kjideo-sw";
          sw.style.background = hex;
          sw.title = "单击添加到当前元素 · 右键移除样式颜色";
          stopProp(sw);
          sw.addEventListener("click", () => addStyleColorToActiveBox(hex));
          sw.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            node._stylePalette.splice(i, 1);
            serialize();
            drawCanvas();
            rebuildStylePalette();
            fitNode();
          });
          container.appendChild(sw);
        });
        if (node._stylePalette.length < MAX_STYLE_COLORS) {
          const add = document.createElement("button");
          add.className = "kjideo-btn";
          add.textContent = "+";
          stopProp(add);
          add.addEventListener("click", () => {
            node._stylePalette.push("#ffffff");
            serialize();
            drawCanvas();
            rebuildStylePalette();
            fitNode();
          });
          container.appendChild(add);
        }
      }

      function appendStylePalettePresets(container) {
        const presetRow = document.createElement("div");
        presetRow.className = "kjideo-preset-row";
        presetRow.title = "点击套用到样式颜色";
        for (const scheme of COLOR_SCHEMES) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "kjideo-preset";
          btn.title = `套用样式颜色：${scheme.name}`;
          stopProp(btn);
          for (const hex of scheme.colors.slice(0, 5)) {
            const chip = document.createElement("span");
            chip.style.background = hex;
            btn.appendChild(chip);
          }
          btn.addEventListener("click", () => {
            node._stylePalette = scheme.colors.slice(0, MAX_STYLE_COLORS);
            serialize();
            drawCanvas();
            rebuildStylePalette();
            fitNode();
          });
          presetRow.appendChild(btn);
        }
        container.appendChild(presetRow);
      }

      function rebuildStylePalette() {
        while (styleBar.children.length > 1) styleBar.removeChild(styleBar.lastChild);
        buildStylePaletteRow(styleBar);
        appendStylePalettePresets(styleBar);
      }

      // Textarea whose user-dragged height persists across panel rebuilds / box switches.
      function makeArea(field, value, placeholder, onInput, defaultH) {
        const ta = document.createElement("textarea");
        ta.className = "kjideo-area";
        ta.placeholder = placeholder;
        ta.value = value || "";
        const h = node._areaH[field] || defaultH;
        if (h) ta.style.height = h + "px";
        stopProp(ta);
        ta.addEventListener("input", onInput);
        const ro = new ResizeObserver(() => {
          if (ta.offsetHeight > 0) { node._areaH[field] = ta.offsetHeight; fitNode(); }
        });
        ro.observe(ta);
        node._areaObservers.push(ro);
        return ta;
      }
      function renderPanel() {
        for (const ro of node._areaObservers) ro.disconnect();
        node._areaObservers = [];
        panel.innerHTML = "";
        const b = node._boxes[node._activeIdx];
        if (!b) {
          hint.textContent = "在画布上拖拽添加区域";
          const p = document.createElement("div");
          p.style.color = "#888";
          p.textContent = node._boxes.length ? "单击一个区域即可编辑。" : "还没有区域。";
          panel.appendChild(p);
          requestAnimationFrame(fitNode);
          return;
        }
        const col = (b.palette || []).find(Boolean) || "#bbb";   // accent = first palette color of this region
        hint.innerHTML = `正在编辑 <b style="color:${col}">区域 ${node._activeIdx + 1}</b> · 双击编辑 · Alt 单击切换重叠区域 · 右键或 Delete 删除`;

        // type toggle
        const typeRow = document.createElement("div");
        typeRow.className = "kjideo-row";
        const lbl = document.createElement("span"); lbl.textContent = "类型："; typeRow.appendChild(lbl);
        for (const t of ["obj", "text", "image"]) {
          const btn = document.createElement("button");
          btn.className = "kjideo-btn" + (b.type === t ? " active" : "");
          btn.textContent = t === "text" ? "文字" : (t === "image" ? "图片" : "对象");
          stopProp(btn);
          btn.addEventListener("click", () => { b.type = t; commit(); });
          typeRow.appendChild(btn);
        }
        panel.appendChild(typeRow);

        // text (only for text type)
        if (b.type === "text") {
          panel.appendChild(makeArea("text", b.text, "需要画面渲染的文字（原样写入）",
            function () { b.text = this.value; serialize(); drawCanvas(); updateTokens(); }));
        }

        // desc — 图片元素只由 Ollama 反推写入描述，避免和对象/文字的手写描述混淆。
        if (b.type !== "image") {
          panel.appendChild(makeArea("desc", b.desc, "描述这个区域的内容、材质、动作和视觉特征",
            function () { b.desc = this.value; serialize(); drawCanvas(); updateTokens(); }, 110));
        } else {
          const note = document.createElement("div");
          note.style.cssText = "color:#8ea0a7;font-size:11px;line-height:1.35;padding:4px 2px;";
          note.textContent = "图片元素不手写描述；在 ⚙️设置 中开启 Ollama 反推后，会自动写入 JSON。";
          panel.appendChild(note);
        }

        // palette
        const palRow = document.createElement("div");
        palRow.className = "kjideo-row";
        const pl = document.createElement("span"); pl.textContent = "颜色："; palRow.appendChild(pl);
        b.palette = b.palette || [];
        buildSwatchRow(palRow, b.palette, MAX_ELEM_COLORS,
          () => { serialize(); drawCanvas(); }, commit);
        panel.appendChild(palRow);

        requestAnimationFrame(fitNode);
      }

      // ── width/height widget callbacks ──
      for (const w of [wWidget, hWidget]) {
        if (!w) continue;
        chainCallback(w, "callback", () => { syncCanvasToDims(); drawCanvas(); fitNode(); });
      }
      // Update the token estimate when the caption-level text widgets change.
      for (const name of ["background", "high_level_description", "aesthetics", "lighting", "medium", "style", "photo", "art_style"]) {
        const w = findW(name);
        if (w) chainCallback(w, "callback", () => updateTokens());
      }

      // ── keep canvas + getMinHeight in sync while the node is resized ──
      let _resizing = false;
      chainCallback(node, "onResize", function () {
        if (_resizing) return;
        _resizing = true;
        recalcWidgetHeight();
        // Resize clamp reads computeSize() before getMinHeight refreshes; re-grow with fresh min.
        const minH = Math.round(node.computeSize()[1]);
        if (Math.abs((node.size?.[1] || 0) - minH) > 1) node.size[1] = minH;
        drawCanvas();
        _resizing = false;
      });

      if (typeof ResizeObserver !== "undefined") {
        const layoutObserver = new ResizeObserver(() => requestAnimationFrame(fitNode));
        layoutObserver.observe(wrap);
        chainCallback(node, "onRemoved", function () {
          try { layoutObserver.disconnect(); } catch (_) {}
        });
      }

      // Active-box highlight only while the editor is focused or the node is selected.
      wrap.addEventListener("focusin", () => { if (!node._focused) { node._focused = true; drawCanvas(); } });
      wrap.addEventListener("focusout", (e) => {
        if (!wrap.contains(e.relatedTarget)) { node._focused = false; drawCanvas(); }
      });
      chainCallback(node, "onSelected", function () { node._selected = true; drawCanvas(); });
      chainCallback(node, "onDeselected", function () { node._selected = false; drawCanvas(); });

      chainCallback(node, "onRemoved", function () {
        closeInlineEditor();
        for (const ro of node._areaObservers) ro.disconnect();
        node._areaObservers = [];
      });

      // ── restore on load ──
      chainCallback(node, "onConfigure", function () {
        if (elementsWidget?.value) {
          try {
            const parsed = JSON.parse(elementsWidget.value);
            if (Array.isArray(parsed)) {
              node._boxes = parsed.filter((b) => b && typeof b.x === "number");
              node._activeIdx = node._boxes.length ? 0 : -1;
            }
          } catch (e) {}
        }
        if (stylePaletteWidget?.value) {
          try {
            const sp = JSON.parse(stylePaletteWidget.value);
            if (Array.isArray(sp)) node._stylePalette = sp.filter((c) => typeof c === "string");
          } catch (e) {}
        }
        hideDataWidgets();
        hideParamWidgets();
        ensureCaptionBackendForModel();
        refreshTemplateParams();
        applySocketVisibility();
        restoreImageElementThumbs();
        syncCanvasToDims();
        rebuildStylePalette();
        refreshSettingsPanel();
        renderPanel();
        drawCanvas();
        updateTokens();
        requestAnimationFrame(fitNode);
      });

      // initial layout (deferred so size/last_y are settled)
      setTimeout(() => {
        hideDataWidgets();
        hideParamWidgets();
        ensureCaptionBackendForModel();
        refreshTemplateParams();
        applySocketVisibility();
        restoreImageElementThumbs();
        syncCanvasToDims();
        rebuildStylePalette();
        refreshSettingsPanel();
        renderPanel();
        drawCanvas();
        updateTokens();
        fitNode();
      }, 0);
    });
  },
});

