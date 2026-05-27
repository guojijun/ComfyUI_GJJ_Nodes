import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_CLASS = "GJJ_LTX23ImageToVideoMultiRef";
const CONFIG_KEY = "gjj_ltx23_config";
const SCENE_COUNT_PROP = "__gjj_ltx_scene_count";
const SCENE_LINKS_PROP = "__gjj_ltx_scene_links";
const PANEL_WIDGET = "gjj_ltx23_clean_panel";
const SCENE_RE = /^(?:scene_0*(\d+)|场景\s*(\d+)|(?:🖼️\s*)?(\d+))$/i;
const FIRST_SCENE_TYPE = "GJJ_BATCH_IMAGE,IMAGE";
const SCENE_TYPE = "IMAGE";
const MAX_SCENES = 20;

const DEFAULT_CONFIG = {
  ltx_model_name: "",
  positive_prompt: "多张参考图连续过渡，主体动作自然，镜头语言稳定，电影感光影，细节真实。",
  negative_prompt: "titles, subtitles, text, watermark, logo, blurry text, distorted text, overexposed, underexposed, low contrast, washed out colors, excessive noise, motion blur, camera shake, background clutter, unnatural skin tones, deformed facial features, extra limbs, disfigured hands, uncanny valley, mismatched lip sync, off-sync audio, jittery movement, awkward pauses, incorrect timing, AI artifacts",
  segment_seconds: 5.0,
  width: 1280,
  height: 720,
  fps: 24,
  seed: 483811081311996,
  denoise_strength: 1.0,
  transition_enabled: false,
  transition_curve: "前置过渡",
  transition_early_tail_ratio: 0.75,
  transition_implicit_guide_count: 2,
  transition_implicit_guide_strength: 0.55,
  transition_early_tail_strength: 0.75,
  transition_final_guide_strength: 1.0,
  segmented_execution: true,
  segment_save_preset: "video/GJJ_LTX多图分段",
  segment_video_format: "video/h264-mp4",
};


const MAIN_WIDGET_KEYS = [
  "ltx_model_name",
  "positive_prompt",
  "negative_prompt",
  "segment_seconds",
  "width",
  "height",
  "fps",
  "seed",
  "denoise_strength",
];
const NUMERIC_WIDGET_KEYS = new Set(["segment_seconds", "width", "height", "fps", "seed", "denoise_strength"]);

function coerceMainWidgetValue(key, value) {
  if (!NUMERIC_WIDGET_KEYS.has(key)) return value == null ? "" : String(value);
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (["width", "height", "fps", "seed"].includes(key)) return Math.round(n);
  return n;
}

function readNativeMainWidgetConfig(node) {
  const out = {};
  for (const key of MAIN_WIDGET_KEYS) {
    const widget = node.widgets?.find(w => w?.name === key);
    if (!widget) continue;
    out[key] = coerceMainWidgetValue(key, widget.value);
  }
  return out;
}

function writeConfigJson(node, cfg, markDirty = false) {
  if (!node.properties) node.properties = {};
  const json = JSON.stringify(cfg);
  node.properties[CONFIG_KEY] = json;
  const hidden = node.widgets?.find(w => w?.name === "config_json");
  if (hidden) hidden.value = json;
  if (markDirty) {
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
  }
  return cfg;
}

function syncNativeMainWidgets(node, markDirty = false) {
  if (!node || !isTarget(node)) return getConfig(node);
  const cfg = { ...getConfig(node), ...readNativeMainWidgetConfig(node) };
  return writeConfigJson(node, cfg, markDirty);
}

function wireNativeMainWidgets(node) {
  if (node.__gjjLtxNativeWidgetsWired) return;
  node.__gjjLtxNativeWidgetsWired = true;
  for (const key of MAIN_WIDGET_KEYS) {
    const widget = node.widgets?.find(w => w?.name === key);
    if (!widget) continue;
    const oldCallback = widget.callback;
    widget.callback = function (...args) {
      const ret = oldCallback?.apply(this, args);
      try { syncNativeMainWidgets(node, true); } catch (_) {}
      return ret;
    };
  }
}

function isTarget(node) {
  const text = `${node?.comfyClass || ""} ${node?.type || ""} ${node?.title || ""}`;
  return text.includes(NODE_CLASS) || /GJJ.*LTX.*多图/i.test(text);
}

function stopCanvasEvents(root) {
  for (const ev of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "wheel", "keydown", "keyup"]) {
    root.addEventListener(ev, (e) => {
      e.stopPropagation();
      if (ev === "wheel") e.preventDefault();
    }, { passive: ev !== "wheel" });
  }
}

function getConfig(node) {
  if (!node.properties) node.properties = {};
  const raw = node.properties[CONFIG_KEY];
  if (raw && typeof raw === "object") return { ...DEFAULT_CONFIG, ...raw };
  if (typeof raw === "string") {
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }; } catch (_) {}
  }
  const cfg = { ...DEFAULT_CONFIG };
  writeConfigJson(node, cfg, false);
  return cfg;
}

function setConfig(node, next) {
  if (!node.properties) node.properties = {};
  const base = { ...getConfig(node), ...readNativeMainWidgetConfig(node) };
  const cfg = { ...base, ...next };
  writeConfigJson(node, cfg, true);
  resizeNodeToFit(node);
}

function sceneIndex(input) {
  const m = String(input?.name || input?.label || "").match(SCENE_RE);
  if (!m) return 0;
  return Number(m[1] || m[2] || m[3] || 0) || 0;
}

function isSceneInput(input) { return sceneIndex(input) > 0; }

function setInputType(input, type) {
  if (!input) return;
  input.type = type;
  input.localized_name = input.localized_name || input.name;
}

function ensureInput(node, name, type) {
  let input = node.inputs?.find(i => String(i.name) === name);
  if (!input) {
    node.addInput(name, type);
    input = node.inputs?.[node.inputs.length - 1];
  }
  setInputType(input, type);
  return input;
}


function isImageLikeTypeText(type) {
  const text = String(type || "").toUpperCase();
  return text.includes("IMAGE") || text.includes("GJJ_BATCH_IMAGE");
}

function linkField(link, key, arrayIndex, fallback = undefined) {
  if (!link) return fallback;
  if (typeof link === "object" && !Array.isArray(link) && key in link) return link[key];
  if (Array.isArray(link) && link.length > arrayIndex) return link[arrayIndex];
  return fallback;
}

function setLinkField(link, key, arrayIndex, value) {
  if (!link) return;
  if (typeof link === "object" && !Array.isArray(link)) link[key] = value;
  if (Array.isArray(link) && link.length > arrayIndex) link[arrayIndex] = value;
}

function getGraphLink(node, linkId) {
  const links = node?.graph?.links;
  if (!links || linkId == null) return null;
  return links[linkId] || (Array.isArray(links) ? links.find(l => String(linkField(l, "id", 0)) === String(linkId)) : null);
}

function getNodeByGraphId(graph, id) {
  if (!graph || id == null) return null;
  return graph._nodes_by_id?.[id] || graph.getNodeById?.(id) || graph._nodes?.find(n => String(n.id) === String(id)) || null;
}

function getLinkSourceOutput(node, link) {
  try {
    const originId = linkField(link, "origin_id", 1);
    const originSlot = linkField(link, "origin_slot", 2);
    const sourceNode = getNodeByGraphId(node.graph, originId);
    return sourceNode?.outputs?.[originSlot] || null;
  } catch (_) {
    return null;
  }
}

function getLinkSourceOutputType(node, link) {
  const output = getLinkSourceOutput(node, link);
  return output?.type || linkField(link, "type", 5, "");
}

function getLinkSourceOutputName(node, link) {
  const output = getLinkSourceOutput(node, link);
  return `${output?.name || ""} ${output?.label || ""} ${output?.localized_name || ""} ${output?.display_name || ""}`;
}

function getLinkSourceNodeText(node, link) {
  try {
    const originId = linkField(link, "origin_id", 1);
    const sourceNode = getNodeByGraphId(node.graph, originId);
    return `${sourceNode?.comfyClass || ""} ${sourceNode?.type || ""} ${sourceNode?.title || ""}`;
  } catch (_) {
    return "";
  }
}

function isImageLikeLink(node, link) {
  if (!link) return false;
  // 保存/重开后 link.type 可能被旧 repairLinks 改成目标口类型，比如 LORA_CHAIN_CONFIG。
  // 所以必须优先看源节点输出口 type/name/source node，同时兼容 LiteGraph object link 和 array link 两种结构。
  const sourceType = getLinkSourceOutputType(node, link);
  const linkType = linkField(link, "type", 5, "");
  const sourceName = getLinkSourceOutputName(node, link);
  const sourceNodeText = getLinkSourceNodeText(node, link);
  if (isImageLikeTypeText(sourceType) || isImageLikeTypeText(linkType)) return true;
  if (/图片|图像|image|batch|GJJ_BATCH/i.test(sourceName)) return true;
  // GJJ 批量图片加载/缩放这类源节点，即使保存后 link.type 被改坏，也应当按图片线修复。
  if (/multi.*image|image.*loader|图片加载|图片缩放|批量多图|多功能图片缩放|GJJ_MultiImage|GJJ.*ImageResize/i.test(sourceNodeText)) return true;
  return false;
}

function moveMisplacedImageLinksToScenes(node) {
  if (!node?.graph?.links || !Array.isArray(node.inputs)) return;
  // Clean v40：保存/重开后，图片线有时会错挂到任意非场景口，并且 link 可能是 object 或 array。
  // 只要源输出口看起来是 IMAGE/GJJ_BATCH_IMAGE/图片输出，就自动迁回场景口。
  const nonSceneInputs = node.inputs.filter(i => i && !isSceneInput(i));
  for (const input of nonSceneInputs) {
    if (!input?.link) continue;
    const link = getGraphLink(node, input.link);
    if (!link || !isImageLikeLink(node, link)) continue;

    let target = node.inputs.find(i => isSceneInput(i) && !i.link);
    if (!target) {
      const currentMax = Math.max(0, ...node.inputs.map(i => sceneIndex(i) || 0));
      const nextIndex = Math.min(MAX_SCENES, Math.max(1, currentMax + 1));
      node.addInput(`场景${nextIndex}`, nextIndex === 1 ? FIRST_SCENE_TYPE : SCENE_TYPE);
      target = node.inputs[node.inputs.length - 1];
    }
    const oldName = input.name;
    target.link = input.link;
    input.link = null;
    const targetIndex = node.inputs.indexOf(target);
    setLinkField(link, "target_id", 3, node.id);
    setLinkField(link, "target_slot", 4, targetIndex);
    setLinkField(link, "type", 5, target.type);
    target.slot_index = targetIndex;
    console.warn("[GJJ LTX2.3][Clean v40] moved misplaced image link from", oldName, "to", target.name, "sourceType=", getLinkSourceOutputType(node, link), "sourceName=", getLinkSourceOutputName(node, link));
  }
}

function getMaxSceneIndexFromInputs(inputs) {
  let maxIndex = 0;
  for (const input of inputs || []) maxIndex = Math.max(maxIndex, sceneIndex(input) || 0);
  return maxIndex;
}

function collectSceneLinkMap(node) {
  const map = {};
  for (const input of node.inputs || []) {
    const idx = sceneIndex(input);
    if (idx && input.link != null) {
      const link = getGraphLink(node, input.link);
      map[String(idx)] = {
        link: input.link,
        origin_id: linkField(link, "origin_id", 1, null),
        origin_slot: linkField(link, "origin_slot", 2, null),
        type: linkField(link, "type", 5, input.type || ""),
      };
    }
  }
  return map;
}

function saveSceneRestoreState(node) {
  if (!node) return;
  if (!node.properties) node.properties = {};
  const maxScene = Math.max(1, getMaxSceneIndexFromInputs(node.inputs));
  node.properties[SCENE_COUNT_PROP] = maxScene;
  node.properties[SCENE_LINKS_PROP] = collectSceneLinkMap(node);
}

function restoreSceneInputsFromSavedData(node, data) {
  if (!node) return;
  if (!node.properties) node.properties = {};
  const props = { ...(data?.properties || {}), ...(node.properties || {}) };
  const serializedMax = getMaxSceneIndexFromInputs(data?.inputs || []);
  const propMax = Number(props[SCENE_COUNT_PROP] || 0);
  const count = Math.max(1, serializedMax, Number.isFinite(propMax) ? propMax : 0);
  for (let i = 1; i <= Math.min(MAX_SCENES, count); i++) {
    const name = `场景${i}`;
    let inp = node.inputs?.find(x => sceneIndex(x) === i);
    if (!inp) {
      node.addInput(name, i === 1 ? FIRST_SCENE_TYPE : SCENE_TYPE);
      inp = node.inputs[node.inputs.length - 1];
    }
    inp.name = name;
    setInputType(inp, i === 1 ? FIRST_SCENE_TYPE : SCENE_TYPE);
  }
}

function restoreSceneLinksFromSavedMap(node) {
  const map = node?.properties?.[SCENE_LINKS_PROP];
  if (!map || typeof map !== "object") return;
  for (const [idxText, info] of Object.entries(map)) {
    const idx = Number(idxText);
    if (!idx || idx < 1 || idx > MAX_SCENES) continue;
    const linkId = info?.link;
    const link = getGraphLink(node, linkId);
    if (!link) continue;
    const sceneInput = node.inputs?.find(i => sceneIndex(i) === idx);
    if (!sceneInput) continue;

    // 如果该 link 当前错挂在其它输入口，先清掉。
    for (const input of node.inputs || []) {
      if (input !== sceneInput && String(input.link) === String(linkId)) input.link = null;
    }
    sceneInput.link = linkId;
    const targetIndex = node.inputs.indexOf(sceneInput);
    setLinkField(link, "target_id", 3, node.id);
    setLinkField(link, "target_slot", 4, targetIndex);
    setLinkField(link, "type", 5, sceneInput.type);
    sceneInput.slot_index = targetIndex;
  }
}

function normalizeInputs(node) {
  if (!Array.isArray(node.inputs)) node.inputs = [];
  // Clean v40：修复保存/重开后图片线错位到任意非场景口的问题。
  // 只要非场景口上挂着 IMAGE/GJJ_BATCH_IMAGE 类型的 link，就自动迁回场景口。
  moveMisplacedImageLinksToScenes(node);
  // 清理重复场景口：同编号保留已连线者，否则保留第一个。
  const kept = [];
  const byScene = new Map();
  for (const input of node.inputs) {
    const idx = sceneIndex(input);
    if (!idx) { kept.push(input); continue; }
    const old = byScene.get(idx);
    if (!old) { byScene.set(idx, input); continue; }
    if (!old.link && input.link) byScene.set(idx, input);
  }
  // 固定口
  const audio = ensureInput(node, "input_audio", "AUDIO");
  audio.display_name = "驱动音频";
  const lora = ensureInput(node, "lora_chain_config", "LORA_CHAIN_CONFIG");
  lora.display_name = "LoRA串联配置";
  let s1 = byScene.get(1) || node.inputs.find(i => sceneIndex(i) === 1);
  if (!s1) {
    node.addInput("场景1", FIRST_SCENE_TYPE);
    s1 = node.inputs[node.inputs.length - 1];
  }
  s1.name = "场景1";
  setInputType(s1, FIRST_SCENE_TYPE);
  byScene.set(1, s1);

  // 根据连接状态追加一个尾部空场景口。
  let maxNeeded = 1;
  for (let i = 1; i <= MAX_SCENES; i++) {
    const inp = byScene.get(i) || node.inputs.find(x => sceneIndex(x) === i);
    if (inp?.link) maxNeeded = Math.min(MAX_SCENES, i + 1);
  }
  for (let i = 2; i <= maxNeeded; i++) {
    let inp = byScene.get(i) || node.inputs.find(x => sceneIndex(x) === i);
    if (!inp) {
      node.addInput(`场景${i}`, SCENE_TYPE);
      inp = node.inputs[node.inputs.length - 1];
    }
    inp.name = `场景${i}`;
    setInputType(inp, SCENE_TYPE);
    byScene.set(i, inp);
  }
  // 只保留到 maxNeeded；超过但有连线则保留。
  const sceneInputs = [...byScene.entries()]
    .filter(([i, inp]) => i <= maxNeeded || inp.link)
    .sort((a, b) => a[0] - b[0])
    .map(([i, inp]) => {
      inp.name = `场景${i}`;
      setInputType(inp, i === 1 ? FIRST_SCENE_TYPE : SCENE_TYPE);
      return inp;
    });
  const fixed = [audio, lora];
  const known = new Set([...fixed, ...sceneInputs]);
  // Clean v31：不要再创建/重排主参数 forceInput。
  // 主参数由 Python 原生 widget 管理，小圆点会显示在字段前面。
  const others = node.inputs.filter(i => !known.has(i) && !isSceneInput(i));
  node.inputs = [...fixed, ...sceneInputs, ...others];
  repairLinks(node);
  restoreSceneLinksFromSavedMap(node);
  repairLinks(node);
  saveSceneRestoreState(node);
}

function repairLinks(node) {
  if (!node?.graph?.links) return;
  node.inputs?.forEach((input, index) => {
    input.slot_index = index;
    const link = input.link ? getGraphLink(node, input.link) : null;
    if (link) {
      setLinkField(link, "target_id", 3, node.id);
      setLinkField(link, "target_slot", 4, index);
      setLinkField(link, "type", 5, input.type);
    }
  });
}

function numberInput(label, key, step = "1", min = null, max = null) {
  return { label, key, step, min, max, type: "number" };
}

function makeField(node, spec) {
  const cfg = getConfig(node);
  const row = document.createElement("label");
  row.className = "gjj-ltx-row";
  const span = document.createElement("span");
  span.textContent = spec.label;
  const input = spec.type === "textarea" ? document.createElement("textarea") : document.createElement("input");
  if (spec.type === "number") {
    input.type = "number";
    input.step = spec.step || "1";
    if (spec.min != null) input.min = spec.min;
    if (spec.max != null) input.max = spec.max;
  } else if (spec.type !== "textarea") {
    input.type = "text";
  }
  input.value = cfg[spec.key] ?? "";
  if (spec.placeholder) input.placeholder = spec.placeholder;
  if (spec.tooltip) {
    input.title = spec.tooltip;
    row.title = spec.tooltip;
  }
  const commit = () => {
    let value = input.value;
    if (spec.type === "number") value = Number(value);
    setConfig(node, { [spec.key]: value });
  };
  input.addEventListener("input", commit);
  input.addEventListener("change", commit);
  input.addEventListener("blur", commit);
  row.append(span, input);
  return row;
}

function makeSelect(node, label, key, options) {
  const cfg = getConfig(node);
  const row = document.createElement("label");
  row.className = "gjj-ltx-row";
  const span = document.createElement("span"); span.textContent = label;
  const select = document.createElement("select");
  const current = cfg[key] || "";
  const list = [...new Set([current, ...options].filter(Boolean))];
  for (const item of list) {
    const opt = document.createElement("option");
    opt.value = item; opt.textContent = item;
    select.appendChild(opt);
  }
  select.value = current;
  select.addEventListener("change", () => setConfig(node, { [key]: select.value }));
  row.append(span, select);
  return { row, select };
}

async function fetchModels(node, select) {
  try {
    const res = await api.fetchApi("/gjj/ltx23/models");
    const data = await res.json();
    const cfg = getConfig(node);
    const models = Array.isArray(data.models) ? data.models : [];
    if (!cfg.ltx_model_name && (data.default || models[0])) setConfig(node, { ltx_model_name: data.default || models[0] });
    const current = getConfig(node).ltx_model_name || data.default || models[0] || "";
    select.innerHTML = "";
    for (const item of [...new Set([current, ...models].filter(Boolean))]) {
      const opt = document.createElement("option");
      opt.value = item; opt.textContent = item;
      select.appendChild(opt);
    }
    select.value = current;
  } catch (err) {
    console.warn("[GJJ LTX2.3 Clean] model list fetch failed", err);
  }
}

async function openVideoDir(node) {
  const cfg = getConfig(node);
  try {
    const res = await api.fetchApi("/gjj/ltx23/open_video_dir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preset: cfg.segment_save_preset || "video/GJJ_LTX多图分段",
        node: String(node?.id ?? ""),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data?.ok) console.warn("[GJJ LTX2.3 Clean v40] open video dir failed", data);
    else console.log("[GJJ LTX2.3 Clean v40] opened video dir:", data.path);
  } catch (err) {
    console.warn("[GJJ LTX2.3 Clean v40] open video dir error", err);
  }
}


function buildPanel(node) {
  const root = document.createElement("div");
  root.className = "gjj-ltx-clean";
  stopCanvasEvents(root);
  const title = document.createElement("div");
  title.className = "gjj-ltx-title";
  title.textContent = "LTX 2.3 高级面板 · Clean v40";
  root.appendChild(title);
  const tip = document.createElement("div");
  tip.className = "gjj-ltx-tip";
  tip.textContent = "主模型、提示词、宽高、帧率、种子、降噪已改回原生字段；接入口会显示在字段前面。多图分段里可用“转场LoRA序列”控制每段是否启用转场，例如 1,0,1。";
  root.appendChild(tip);
  const buttons = document.createElement("div");
  buttons.className = "gjj-ltx-tab-buttons";
  const segmentBtn = document.createElement("button");
  segmentBtn.className = "gjj-ltx-tab-btn";
  const segmentPanel = document.createElement("div");
  segmentPanel.className = "gjj-ltx-section";

  function updateButtons() {
    const cfg = getConfig(node);
    segmentBtn.textContent = `${cfg.segmented_execution ? "✅" : "⬜"} 多图分段执行`;
    segmentBtn.classList.toggle("active", !!cfg.segmented_execution);
    segmentPanel.style.display = cfg.segmented_execution ? "block" : "none";
    resizeNodeToFit(node);
  }
  segmentBtn.onclick = () => { setConfig(node, { segmented_execution: !getConfig(node).segmented_execution }); updateButtons(); };
  buttons.append(segmentBtn);
  root.appendChild(buttons);

  segmentPanel.appendChild(makeField(node, { label: "转场LoRA序列", key: "transition_lora_switches", type: "text", placeholder: "例如：1,0,1", tooltip: "🧬 每段是否启用转场 LoRA：1=启用，0=关闭；不填/越界=默认启用。" }));
  segmentPanel.appendChild(makeField(node, { label: "保存位置", key: "segment_save_preset", type: "text", tooltip: "📁 分段视频保存到 ComfyUI/output 下的相对目录，支持 {date}/{time}/{node}/{segment}/{start}/{end}。" }));
  segmentPanel.appendChild(makeSelect(node, "视频格式", "segment_video_format", ["video/h264-mp4", "video/h265-mp4", "video/webm"]).row);
  const openDirBtn = document.createElement("button");
  openDirBtn.className = "gjj-ltx-open-dir";
  openDirBtn.textContent = "📁 打开视频所在目录";
  openDirBtn.title = "打开当前分段视频保存目录。默认：ComfyUI/output/video/GJJ_LTX多图分段";
  openDirBtn.onclick = () => openVideoDir(node);
  segmentPanel.appendChild(openDirBtn);
  root.append(segmentPanel);

  updateButtons();
  requestAnimationFrame(() => resizeNodeToFit(node));
  return root;
}

function ensurePanel(node) {
  if (!isTarget(node)) return;
  if (node.__gjjLtxCleanPanel && node.widgets?.some(w => w.name === PANEL_WIDGET)) return;
  const root = buildPanel(node);
  const widget = node.addDOMWidget?.(PANEL_WIDGET, PANEL_WIDGET, root, { serialize: false, hideOnZoom: false });
  if (widget) {
    widget.computeSize = () => [Math.max(300, node.size?.[0] || 360) - 20, Math.max(40, root.offsetHeight + 8)];
    widget.serialize = false;
  }
  node.__gjjLtxCleanPanel = root;
  resizeNodeToFit(node);
}

function resizeNodeToFit(node) {
  requestAnimationFrame(() => {
    try {
      const size = node.computeSize?.();
      if (size && Array.isArray(size)) {
        const width = Math.max(node.size?.[0] || 360, 360);
        const height = Math.max(size[1] + 10, 260);
        node.setSize?.([width, height]);
      }
      node.setDirtyCanvas?.(true, true);
    } catch (_) {}
  });
}

function injectStyles() {
  if (document.getElementById("gjj-ltx-clean-style")) return;
  const style = document.createElement("style");
  style.id = "gjj-ltx-clean-style";
  style.textContent = `
    .gjj-ltx-clean{box-sizing:border-box;width:100%;padding:6px 8px 4px;color:#d7dde6;font:12px/1.35 system-ui,"Microsoft YaHei",sans-serif;}
    .gjj-ltx-title{font-weight:700;color:#9fe8ff;margin:0 0 6px;opacity:.9;}
    .gjj-ltx-row{display:grid;grid-template-columns:82px minmax(0,1fr);align-items:center;gap:6px;margin:5px 0;}
    .gjj-ltx-row span{color:#aeb8c8;white-space:nowrap;}
    .gjj-ltx-row input,.gjj-ltx-row select,.gjj-ltx-row textarea{box-sizing:border-box;width:100%;border:1px solid rgba(255,255,255,.08);border-radius:7px;background:#30343a;color:#f1f5f9;padding:5px 7px;outline:none;font:12px system-ui,"Microsoft YaHei",sans-serif;}
    .gjj-ltx-row textarea{height:46px;resize:vertical;}
    .gjj-ltx-grid{display:block;}
    .gjj-ltx-tip{margin:3px 0 6px;color:#7f8fa8;font-size:11px;line-height:1.25;}
    .gjj-ltx-tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0 4px;}
    .gjj-ltx-tabs button{border:1px solid rgba(125,245,255,.45);border-radius:8px;background:#12313a;color:#dffcff;padding:5px 6px;font-weight:700;cursor:pointer;}
    .gjj-ltx-tabs button.active{background:#0b756d;border-color:#5dfff1;box-shadow:0 0 8px rgba(80,255,235,.25) inset;}
    .gjj-ltx-subpanel{border:1px solid rgba(125,245,255,.18);border-radius:10px;padding:5px 7px;margin:6px 0;background:rgba(10,25,30,.35);}
    .gjj-ltx-open-dir{width:100%;margin:6px 0 2px;border:1px solid rgba(125,245,255,.45);border-radius:8px;background:#12313a;color:#dffcff;padding:6px 8px;font-weight:700;cursor:pointer;}
    .gjj-ltx-open-dir:hover{background:#0b756d;border-color:#5dfff1;}
  `;
  document.head.appendChild(style);
}

function stabilize(node) {
  if (!isTarget(node)) return;
  injectStyles();
  normalizeInputs(node);
  wireNativeMainWidgets(node);
  syncNativeMainWidgets(node, false);
  ensurePanel(node);
  repairLinks(node);
}

app.registerExtension({
  name: "GJJ.LTX23.CleanV40",
  beforeRegisterNodeDef(nodeType, nodeData) {
    const typeName = nodeData?.name || nodeData?.display_name || nodeData?.title || "";
    if (!String(typeName).includes(NODE_CLASS) && !/GJJ.*LTX.*多图/i.test(String(typeName))) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      onNodeCreated?.apply(this, args);
      console.log("[GJJ LTX2.3] clean v40: multi-frame segments force first-last workflow and auto transition LoRA");
      requestAnimationFrame(() => stabilize(this));
      setTimeout(() => stabilize(this), 250);
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      onConfigure?.apply(this, args);
      try { restoreSceneInputsFromSavedData(this, args?.[0]); } catch (_) {}
      requestAnimationFrame(() => stabilize(this));
      setTimeout(() => stabilize(this), 120);
      setTimeout(() => stabilize(this), 400);
      setTimeout(() => stabilize(this), 900);
    };
    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (...args) {
      onConnectionsChange?.apply(this, args);
      requestAnimationFrame(() => stabilize(this));
      setTimeout(() => stabilize(this), 50);
    };
    const onSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (data, ...args) {
      onSerialize?.apply(this, [data, ...args]);
      try {
        syncNativeMainWidgets(this, false);
        saveSceneRestoreState(this);
        if (data && this.properties) data.properties = { ...(data.properties || {}), ...this.properties };
      } catch (_) {}
      // 重要：不要 return，避免 LGraphNode.ts 的 onSerialize 警告。
    };
  },
  loadedGraphNode(node) { requestAnimationFrame(() => stabilize(node)); setTimeout(() => stabilize(node), 250); setTimeout(() => stabilize(node), 800); },
});

// 兜底：某些前端版本不稳定触发生命周期时，低频扫描一次。
setInterval(() => {
  for (const node of app.graph?._nodes || []) {
    if (isTarget(node)) stabilize(node);
  }
}, 1200);
