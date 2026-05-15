import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_CLASS = "GJJ_LTX23ImageToVideoMultiRef";
const CONFIG_KEY = "gjj_ltx23_config";
const PANEL_WIDGET = "gjj_ltx23_clean_panel";
const STATUS_EVENT = "gjj_node_progress";
const SCENE_RE = /^(?:scene_0*(\d+)|场景\s*(\d+)|(?:🖼️\s*)?(\d+))$/i;
const FIRST_SCENE_TYPE = "GJJ_BATCH_IMAGE,IMAGE";
const SCENE_TYPE = "IMAGE";
const MAX_SCENES = 20;
const PARAM_INPUTS = [
  ["positive_prompt", "STRING", "正向提示词"],
  ["negative_prompt", "STRING", "反向提示词"],
  ["segment_seconds", "FLOAT", "场景间隔（秒）"],
  ["width", "INT", "宽度"],
  ["height", "INT", "高度"],
  ["fps", "INT", "帧率"],
  ["seed", "INT", "种子"],
  ["denoise_strength", "FLOAT", "降噪"],
];


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
  segmented_execution: false,
  segment_save_preset: "video/GJJ_LTX多图分段",
  segment_video_format: "video/h264-mp4",
};

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
  node.properties[CONFIG_KEY] = cfg;
  return cfg;
}

function setConfig(node, next) {
  if (!node.properties) node.properties = {};
  const cfg = { ...getConfig(node), ...next };
  const json = JSON.stringify(cfg);
  // Clean v4：properties 直接存 JSON 字符串，避免队列执行时嵌套 object 未同步，
  // 导致面板显示 1024x1024 但后端仍按默认 1280x720/旧值执行。
  node.properties[CONFIG_KEY] = json;
  const widget = node.widgets?.find(w => w.name === "config_json");
  if (widget) widget.value = json;
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
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

function ensureParamInputs(node) {
  const result = [];
  for (const [name, type, label] of PARAM_INPUTS) {
    const input = ensureInput(node, name, type);
    input.display_name = label;
    input.localized_name = label;
    setInputType(input, type);
    result.push(input);
  }
  return result;
}

function isParamInput(input) {
  return PARAM_INPUTS.some(([name]) => String(input?.name || "") === name);
}

function normalizeInputs(node) {
  if (!Array.isArray(node.inputs)) node.inputs = [];
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
  const paramInputs = ensureParamInputs(node);
  const fixed = [audio, lora];
  const known = new Set([...fixed, ...sceneInputs, ...paramInputs]);
  const others = node.inputs.filter(i => !known.has(i) && !isSceneInput(i) && !isParamInput(i));
  node.inputs = [...fixed, ...sceneInputs, ...paramInputs, ...others];
  repairLinks(node);
}

function repairLinks(node) {
  if (!node?.graph?.links) return;
  node.inputs?.forEach((input, index) => {
    input.slot_index = index;
    if (input.link && node.graph.links[input.link]) {
      const link = node.graph.links[input.link];
      link.target_slot = index;
      link.type = input.type;
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

function buildPanel(node) {
  const root = document.createElement("div");
  root.className = "gjj-ltx-clean";
  stopCanvasEvents(root);
  const title = document.createElement("div");
  title.className = "gjj-ltx-title";
  title.textContent = "LTX 2.3 参数面板 · Clean v3";
  root.appendChild(title);

  const model = makeSelect(node, "LTX主模型", "ltx_model_name", []);
  root.appendChild(model.row);
  fetchModels(node, model.select);

  root.appendChild(makeField(node, { label: "正向提示词", key: "positive_prompt", type: "textarea" }));
  root.appendChild(makeField(node, { label: "反向提示词", key: "negative_prompt", type: "textarea" }));
  const grid = document.createElement("div");
  grid.className = "gjj-ltx-grid";
  for (const spec of [
    numberInput("场景间隔", "segment_seconds", "0.1", "0.1"),
    numberInput("宽度", "width", "32", "64"),
    numberInput("高度", "height", "32", "64"),
    numberInput("帧率", "fps", "1", "1"),
    numberInput("种子", "seed", "1", "0"),
    numberInput("降噪", "denoise_strength", "0.01", "0", "1"),
  ]) grid.appendChild(makeField(node, spec));
  root.appendChild(grid);
  const tip = document.createElement("div");
  tip.className = "gjj-ltx-tip";
  tip.textContent = "左侧同名输入口连接后，会优先覆盖面板中的主参数。";
  root.appendChild(tip);

  const buttons = document.createElement("div");
  buttons.className = "gjj-ltx-tabs";
  const transitionBtn = document.createElement("button");
  const segmentBtn = document.createElement("button");
  const transitionPanel = document.createElement("div");
  const segmentPanel = document.createElement("div");
  transitionPanel.className = "gjj-ltx-subpanel";
  segmentPanel.className = "gjj-ltx-subpanel";
  function updateButtons() {
    const cfg = getConfig(node);
    transitionBtn.textContent = `${cfg.transition_enabled ? "✅" : "⬜"} 转场控制`;
    segmentBtn.textContent = `${cfg.segmented_execution ? "✅" : "⬜"} 多图分段执行`;
    transitionBtn.classList.toggle("active", !!cfg.transition_enabled);
    segmentBtn.classList.toggle("active", !!cfg.segmented_execution);
    transitionPanel.style.display = cfg.transition_enabled ? "block" : "none";
    segmentPanel.style.display = cfg.segmented_execution ? "block" : "none";
    resizeNodeToFit(node);
  }
  transitionBtn.onclick = () => { setConfig(node, { transition_enabled: !getConfig(node).transition_enabled }); updateButtons(); };
  segmentBtn.onclick = () => { setConfig(node, { segmented_execution: !getConfig(node).segmented_execution }); updateButtons(); };
  buttons.append(transitionBtn, segmentBtn);
  root.appendChild(buttons);

  transitionPanel.appendChild(makeSelect(node, "过渡曲线", "transition_curve", ["前置过渡", "平滑过渡", "线性过渡", "后置过渡"]).row);
  for (const spec of [
    numberInput("尾帧提前注入", "transition_early_tail_ratio", "0.01", "0.1", "0.95"),
    numberInput("中间隐式guide", "transition_implicit_guide_count", "1", "0", "4"),
    numberInput("隐式guide强度", "transition_implicit_guide_strength", "0.01", "0", "1"),
    numberInput("提前尾帧强度", "transition_early_tail_strength", "0.01", "0", "1"),
    numberInput("终点guide强度", "transition_final_guide_strength", "0.01", "0", "1"),
  ]) transitionPanel.appendChild(makeField(node, spec));
  segmentPanel.appendChild(makeField(node, { label: "保存位置", key: "segment_save_preset", type: "text" }));
  segmentPanel.appendChild(makeSelect(node, "视频格式", "segment_video_format", ["video/h264-mp4", "video/h265-mp4", "video/webm"]).row);
  root.append(transitionPanel, segmentPanel);

  const status = document.createElement("div");
  status.className = "gjj-ltx-status";
  status.style.display = "none";
  status.innerHTML = `<div class="gjj-ltx-status-text"></div><div class="gjj-ltx-bar"><div></div></div>`;
  root.appendChild(status);
  node.__gjjLtxCleanStatus = status;
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

function updateStatus(node, detail) {
  ensurePanel(node);
  const status = node.__gjjLtxCleanStatus;
  if (!status) return;
  const text = status.querySelector(".gjj-ltx-status-text");
  const bar = status.querySelector(".gjj-ltx-bar > div");
  status.style.display = "block";
  text.textContent = detail.text || detail.message || "正在执行...";
  const p = Number(detail.progress);
  if (Number.isFinite(p) && bar) bar.style.width = `${Math.max(0, Math.min(100, p * 100))}%`;
  resizeNodeToFit(node);
}

function findNodeById(id) {
  const graph = app.graph;
  if (!graph) return null;
  return graph._nodes?.find(n => String(n.id) === String(id)) || null;
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
    .gjj-ltx-status{margin-top:8px;border:1px solid rgba(100,220,255,.35);border-radius:8px;padding:6px;background:#0b2028;color:#d8fbff;}
    .gjj-ltx-status-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px;}
    .gjj-ltx-bar{height:5px;background:rgba(255,255,255,.12);border-radius:99px;overflow:hidden;}
    .gjj-ltx-bar>div{height:100%;width:0%;background:#23d18b;transition:width .2s ease;}
  `;
  document.head.appendChild(style);
}

function stabilize(node) {
  if (!isTarget(node)) return;
  injectStyles();
  normalizeInputs(node);
  ensurePanel(node);
  repairLinks(node);
}

api.addEventListener(STATUS_EVENT, (event) => {
  const detail = event.detail || {};
  const node = findNodeById(detail.node || detail.node_id);
  if (node && isTarget(node)) updateStatus(node, detail);
});

app.registerExtension({
  name: "GJJ.LTX23.CleanV1",
  beforeRegisterNodeDef(nodeType, nodeData) {
    const typeName = nodeData?.name || nodeData?.display_name || nodeData?.title || "";
    if (!String(typeName).includes(NODE_CLASS) && !/GJJ.*LTX.*多图/i.test(String(typeName))) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      onNodeCreated?.apply(this, args);
      console.log("[GJJ LTX2.3] clean v4: batch container recursion + config_json sync + branch debug status");
      requestAnimationFrame(() => stabilize(this));
      setTimeout(() => stabilize(this), 250);
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      onConfigure?.apply(this, args);
      requestAnimationFrame(() => stabilize(this));
      setTimeout(() => stabilize(this), 250);
    };
    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (...args) {
      onConnectionsChange?.apply(this, args);
      requestAnimationFrame(() => stabilize(this));
      setTimeout(() => stabilize(this), 50);
    };
  },
  loadedGraphNode(node) { requestAnimationFrame(() => stabilize(node)); },
});

// 兜底：某些前端版本不稳定触发生命周期时，低频扫描一次。
setInterval(() => {
  for (const node of app.graph?._nodes || []) {
    if (isTarget(node)) stabilize(node);
  }
}, 1200);
