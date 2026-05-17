import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const TARGET = "GJJ_AudioSeparator";
const PROP_MORE_OUTPUTS = "gjj_audio_separator_more_outputs";
const PROP_TOOLBAR_READY = "gjj_audio_separator_toolbar_ready";
const MIN_NODE_WIDTH_FOR_NATIVE_LABELS = 460;
const MEDIA_SENTINEL = "🔌 外接音频优先";
const OLD_MEDIA_SENTINELS = ["🔌 使用连接输入", "[不加载]", ""];

const MODE_AUTO = "自动兼容";
const MODE_REPAIR = "显式维度修复";

const FULL_OUTPUTS = [
  { name: "人声", type: "AUDIO" },
  { name: "背景声", type: "AUDIO" },
  { name: "音频时长", type: "FLOAT" },
  { name: "音频标签", type: "STRING" },
];

const ACCEPT_MEDIA = [
  ".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus",
  ".mp4", ".mov", ".mkv", ".webm", ".avi", ".wmv"
].join(",");

// 标签显示全部交给 ComfyUI 原生 display_name/name，不再用 JS 额外改名或画文字。

function ensureStyles() {
  if (document.getElementById("gjj-audio-separator-toolbar-style")) return;
  const style = document.createElement("style");
  style.id = "gjj-audio-separator-toolbar-style";
  style.textContent = `
    .gjj-audio-separator-toolbar {
      width: 100%;
      box-sizing: border-box;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
      padding: 4px 0 2px 0;
      user-select: none;
    }
    .gjj-audio-separator-toolbar button {
      min-width: 0;
      height: 26px;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 7px;
      background: rgba(255,255,255,0.10);
      color: rgba(255,255,255,0.88);
      font-size: 15px;
      line-height: 24px;
      cursor: pointer;
      padding: 0 4px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .gjj-audio-separator-toolbar button:hover {
      background: rgba(255,255,255,0.18);
      border-color: rgba(255,255,255,0.28);
    }
    .gjj-audio-separator-toolbar button.gjj-active {
      background: rgba(80, 170, 255, 0.38);
      border-color: rgba(120, 205, 255, 0.74);
      color: #fff;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.12);
    }
    .gjj-audio-separator-toolbar button.gjj-busy {
      opacity: 0.72;
      cursor: wait;
    }
    .gjj-audio-separator-status {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 10px;
      margin-top: 6px;
      border-radius: 8px;
      background: rgba(255, 30, 30, 0.14);
      border: 1px solid rgba(255, 100, 100, 0.32);
      color: rgba(255, 220, 220, 0.96);
      font-size: 13px;
      line-height: 1.5;
      user-select: text;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .gjj-audio-separator-status:empty {
      display: none;
    }
    .gjj-audio-separator-copy-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-top: 8px;
      padding: 6px 12px;
      border: 1px solid rgba(255, 255, 255, 0.32);
      border-radius: 6px;
      background: rgba(255, 80, 80, 0.25);
      color: #fff;
      font-size: 13px;
      cursor: pointer;
      user-select: none;
    }
    .gjj-audio-separator-copy-btn:hover {
      background: rgba(255, 100, 100, 0.35);
    }
    .gjj-audio-separator-copy-btn.gjj-copied {
      background: rgba(80, 200, 80, 0.35);
      border-color: rgba(120, 255, 120, 0.5);
    }
  `;
  document.head.appendChild(style);
}

function stopEvent(e) {
  try { e.preventDefault(); } catch (_) {}
  try { e.stopPropagation(); } catch (_) {}
}

function cloneSlot(slot) {
  return {
    ...slot,
    links: slot?.links ? [...slot.links] : null,
  };
}

function hasExtraOutputLinks(node) {
  return (node.outputs || []).slice(1).some((o) => o?.links && o.links.length > 0);
}

function getFullOutputs(node) {
  const existing = node.__gjjAudioSeparatorFullOutputs;
  if (existing && existing.length >= FULL_OUTPUTS.length) return existing.map(cloneSlot);

  const fromNode = (node.outputs || []).map(cloneSlot);
  const full = FULL_OUTPUTS.map((fallback, index) => {
    const current = fromNode[index] || {};
    return {
      ...fallback,
      ...current,
      name: fallback.name,
      type: current.type || fallback.type,
      links: current.links || null,
    };
  });
  node.__gjjAudioSeparatorFullOutputs = full.map(cloneSlot);
  return full;
}

function markCanvasDirty(node) {
  try { node.setDirtyCanvas(true, true); } catch (_) {}
  try { app.graph?.setDirtyCanvas(true, true); } catch (_) {}
  try { node.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
}

function ensureNativeLabelSpace(node) {
  // 不画标签、不改标签，只把节点默认宽度留够，避免 ComfyUI 原生 display_name 被压缩成只剩 emoji。
  if (!node) return;
  try {
    node.min_width = Math.max(node.min_width || 0, MIN_NODE_WIDTH_FOR_NATIVE_LABELS);
    node.minWidth = Math.max(node.minWidth || 0, MIN_NODE_WIDTH_FOR_NATIVE_LABELS);
    if (Array.isArray(node.size)) node.size[0] = Math.max(node.size[0] || 0, MIN_NODE_WIDTH_FOR_NATIVE_LABELS);
    if (Array.isArray(node.constructor?.size)) node.constructor.size[0] = Math.max(node.constructor.size[0] || 0, MIN_NODE_WIDTH_FOR_NATIVE_LABELS);
  } catch (_) {}
}

function applyOutputMode(node, showMore) {
  if (!node || !Array.isArray(node.outputs)) return;

  // 已经连了背景声/时长/标签时，不强行隐藏，避免断线或看不到已有连接。
  if (!showMore && hasExtraOutputLinks(node)) showMore = true;

  node.properties = node.properties || {};
  node.properties[PROP_MORE_OUTPUTS] = !!showMore;

  const full = getFullOutputs(node);
  node.outputs = showMore ? full.map(cloneSlot) : [cloneSlot(full[0])];
  updateToolbarState(node);
  markCanvasDirty(node);
}

function findWidget(node, name) {
  return (node.widgets || []).find((w) => w?.name === name || w?.options?.name === name);
}

function findWidgetAny(node, names) {
  return (node.widgets || []).find((w) => names.some((name) => w?.name === name || w?.options?.name === name));
}

function getMediaFileWidget(node) {
  return findWidgetAny(node, ["📁 音视频文件", "media_file"]);
}

function getCompatWidget(node) {
  return findWidgetAny(node, ["🛠️ 维度修复模式", "compatibility_mode"]);
}

function getDebugWidget(node) {
  return findWidgetAny(node, ["🧾 日志输出", "debug_log"]);
}

const MEDIA_INPUT_ALIASES = new Set([
  "🎵 外部音频",
  "外部音频",
  "🎵 输入音频 / 视频",
  "输入音频 / 视频",
  "🎵 输入音视频",
  "输入音视频",
  "media",
  "audio",
]);

function isMediaInputSlot(input) {
  const name = input?.name || input?.label || input?.localized_name || "";
  const type = String(input?.type || "").toUpperCase();
  return MEDIA_INPUT_ALIASES.has(name) || (type.includes("AUDIO") && type.includes("VIDEO"));
}

function normalizeMediaInputSlot(input) {
  if (!input) return;
  // 后端执行参数名必须固定为 audio；界面标签仍显示中文。
  // 旧版用 emoji/中文作为 input.name，部分 ComfyUI 版本会在执行时丢失连接值。
  input.name = "audio";
  input.label = "🎵 外部音频";
  input.localized_name = "🎵 外部音频";
  input.type = "AUDIO,VIDEO";
}

function hasExternalMediaLink(node) {
  return (node?.inputs || []).some((input) => isMediaInputSlot(input) && input?.link != null);
}

function syncMediaFileForExternalInput(node) {
  if (!hasExternalMediaLink(node)) return;
  const widget = getMediaFileWidget(node);
  if (!widget) return;
  if (widget.value !== MEDIA_SENTINEL && !OLD_MEDIA_SENTINELS.includes(widget.value)) {
    setComboValue(widget, MEDIA_SENTINEL);
  } else if (widget.value !== MEDIA_SENTINEL) {
    setComboValue(widget, MEDIA_SENTINEL);
  }
}

function ensureSingleMediaInput(node) {
  if (!node || !Array.isArray(node.inputs)) return;
  const indices = [];
  node.inputs.forEach((input, index) => {
    if (isMediaInputSlot(input)) indices.push(index);
  });
  if (!indices.length) return;

  let keepIndex = indices.find((index) => node.inputs[index]?.link != null);
  if (keepIndex == null) keepIndex = indices[0];
  const keepInput = node.inputs[keepIndex];
  normalizeMediaInputSlot(keepInput);

  // 删除旧版本残留的重复 AUDIO/VIDEO 输入口，只保留一个唯一入口。
  for (let i = indices.length - 1; i >= 0; i--) {
    const idx = indices[i];
    if (idx === keepIndex) continue;
    try {
      if (typeof node.removeInput === "function") node.removeInput(idx);
      else node.inputs.splice(idx, 1);
    } catch (_) {
      try { node.inputs.splice(idx, 1); } catch (_) {}
    }
    if (idx < keepIndex) keepIndex--;
  }

  syncMediaFileForExternalInput(node);
}

function uploadUrl(path) {
  try {
    if (api?.apiURL) return api.apiURL(path);
  } catch (_) {}
  return path;
}

function normalizeUploadFilename(data, file) {
  const filename = data?.name || data?.filename || data?.file || file?.name;
  const subfolder = data?.subfolder || "";
  return subfolder ? `${subfolder}/${filename}` : filename;
}

async function uploadMediaToInput(file) {
  const endpoints = ["/upload/image", "/api/upload/image"];
  let lastError = null;

  for (const endpoint of endpoints) {
    const form = new FormData();
    // ComfyUI /upload/image 使用字段名 image；实际可以保存任意扩展名文件到 input 目录。
    form.append("image", file, file.name);
    form.append("type", "input");
    form.append("overwrite", "true");

    try {
      const res = await fetch(uploadUrl(endpoint), { method: "POST", body: form });
      if (!res.ok) {
        lastError = new Error(`上传失败：HTTP ${res.status}`);
        continue;
      }
      const data = await res.json().catch(() => ({}));
      return normalizeUploadFilename(data, file);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("上传失败：未知错误");
}

function setComboValue(widget, value) {
  if (!widget) return;
  widget.options = widget.options || {};
  const values = widget.options.values || widget.options.comboValues || widget.values;
  if (Array.isArray(values) && !values.includes(value)) values.push(value);
  widget.value = value;
  try { widget.callback?.(value); } catch (_) {}
}

function setBooleanWidget(widget, value) {
  if (!widget) return;
  widget.value = !!value;
  try { widget.callback?.(!!value); } catch (_) {}
}

function openMediaPicker(node) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ACCEPT_MEDIA;
  input.style.display = "none";

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;

    const btn = node.__gjjToolbarButtons?.open;
    const oldText = btn?.textContent || "📁";
    try {
      if (btn) {
        btn.textContent = "⏳";
        btn.classList.add("gjj-busy");
      }
      const uploadedName = await uploadMediaToInput(file);
      const mediaWidget = getMediaFileWidget(node);
      setComboValue(mediaWidget, uploadedName);
      markCanvasDirty(node);
    } catch (err) {
      console.error("[GJJ AudioSeparator] 打开/上传音视频失败：", err);
      alert(`打开音视频失败：${err?.message || err}\n\n请确认 ComfyUI 服务允许上传，并且文件格式是音频或视频。`);
    } finally {
      if (btn) {
        btn.textContent = oldText;
        btn.classList.remove("gjj-busy");
      }
      updateToolbarState(node);
    }
  }, { once: true });

  document.body.appendChild(input);
  input.click();
}

function toggleRepairMode(node) {
  const widget = getCompatWidget(node);
  const isRepair = widget?.value === MODE_REPAIR;
  setComboValue(widget, isRepair ? MODE_AUTO : MODE_REPAIR);
  updateToolbarState(node);
  markCanvasDirty(node);
}

function toggleLog(node) {
  const widget = getDebugWidget(node);
  setBooleanWidget(widget, !widget?.value);
  updateToolbarState(node);
  markCanvasDirty(node);
}

function button(label, tooltip, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = tooltip;
  b.addEventListener("pointerdown", stopEvent);
  b.addEventListener("mousedown", stopEvent);
  b.addEventListener("mouseup", stopEvent);
  b.addEventListener("click", (e) => {
    stopEvent(e);
    onClick?.(e);
  });
  return b;
}

function updateToolbarState(node) {
  const buttons = node?.__gjjToolbarButtons;
  if (!buttons) return;

  const repairOn = getCompatWidget(node)?.value === MODE_REPAIR;
  buttons.repair.classList.toggle("gjj-active", !!repairOn);
  buttons.repair.title = repairOn
    ? "维度修复：已开启。使用显式维度修复路径，适合 einops pack/unpack 维度异常环境。点击切回自动兼容。"
    : "维度修复：已关闭。当前使用自动兼容，失败时仍会尝试修复。点击固定使用显式维度修复。";

  const logOn = !!getDebugWidget(node)?.value;
  buttons.log.classList.toggle("gjj-active", logOn);
  buttons.log.title = logOn
    ? "日志：已开启。控制台会输出模型加载、音频读取、重采样、分块推理等详细信息。点击关闭。"
    : "日志：已关闭。界面更简洁，控制台只保留必要错误。点击开启详细日志。";

  const moreOn = !!node.properties?.[PROP_MORE_OUTPUTS] || hasExtraOutputLinks(node);
  buttons.more.classList.toggle("gjj-active", moreOn);
  buttons.more.title = moreOn
    ? "更多接口：已显示。输出口包含：人声、背景声、音频时长、音频标签。点击收起，只保留人声。"
    : "更多接口：默认关闭。点击显示背景声、音频时长、音频标签输出口。";
}

function createToolbar(node) {
  ensureStyles();
  const wrap = document.createElement("div");
  wrap.className = "gjj-audio-separator-toolbar";
  wrap.addEventListener("pointerdown", stopEvent);
  wrap.addEventListener("mousedown", stopEvent);
  wrap.addEventListener("mouseup", stopEvent);
  wrap.addEventListener("click", stopEvent);

  const open = button("📁", "打开音视频：从电脑磁盘选择音频/视频，自动上传到 ComfyUI/input/，并写入本节点的“音视频文件”。没有外接音频时使用；视频只取音轨。", () => openMediaPicker(node));
  const repair = button("🛠️", "维度修复：默认开启，固定使用显式维度修复，避免部分环境下 einops pack/unpack 丢维度报错。", () => toggleRepairMode(node));
  const log = button("🧾", "日志开关：默认关闭。开启后控制台输出模型加载、音频读取、重采样、分块推理等详细中文日志。", () => toggleLog(node));
  const more = button("🔌", "更多接口：默认关闭。点击显示背景声、音频时长、音频标签输出口。", () => {
    const current = !!node.properties?.[PROP_MORE_OUTPUTS] || hasExtraOutputLinks(node);
    applyOutputMode(node, !current);
  });

  wrap.append(open, repair, log, more);

  node.__gjjToolbarButtons = { open, repair, log, more };
  return wrap;
}

function createStatusBar(node) {
  // 创建状态栏容器
  const statusContainer = document.createElement("div");
  statusContainer.style.width = "100%";
  statusContainer.style.marginTop = "8px";

  // 状态栏文字
  const statusText = document.createElement("div");
  statusText.className = "gjj-audio-separator-status";
  statusText.textContent = "";
  statusContainer.appendChild(statusText);

  // 复制按钮
  const copyBtn = document.createElement("button");
  copyBtn.className = "gjj-audio-separator-copy-btn";
  copyBtn.style.display = "none";
  copyBtn.textContent = "📋 复制安装命令";
  copyBtn.addEventListener("click", async () => {
    const cmd = copyBtn.__gjj_install_cmd || "";
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      copyBtn.classList.add("gjj-copied");
      copyBtn.textContent = "✅ 已复制";
      setTimeout(() => {
        copyBtn.classList.remove("gjj-copied");
        copyBtn.textContent = "📋 复制安装命令";
      }, 1500);
    } catch (e) {
      console.error("[GJJ AudioSeparator] 复制失败：", e);
      // 回退方案
      const textarea = document.createElement("textarea");
      textarea.value = cmd;
      textarea.style.position = "fixed";
      textarea.style.top = "-9999px";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
        copyBtn.classList.add("gjj-copied");
        copyBtn.textContent = "✅ 已复制";
        setTimeout(() => {
          copyBtn.classList.remove("gjj-copied");
          copyBtn.textContent = "📋 复制安装命令";
        }, 1500);
      } catch (e2) {
        console.error("[GJJ AudioSeparator] 回退复制也失败：", e2);
      } finally {
        textarea.remove();
      }
    }
  });
  statusContainer.appendChild(copyBtn);

  // 保存引用到节点
  node.__gjjStatusText = statusText;
  node.__gjjCopyBtn = copyBtn;
  node.__gjjStatusContainer = statusContainer;

  return statusContainer;
}

function completeHideWidget(widget) {
  if (!widget) return;
  widget.hidden = true;
  widget.computeSize = () => [0, -4];
  widget.serialize = true;
  widget.type = widget.type || "hidden";
  widget.options = widget.options || {};
  widget.options.hidden = true;
  widget.last_y = 0;
  widget.y = 0;
}

function addToolbar(node) {
  if (!node || node.__gjjAudioToolbarWidget) return;

  // 默认：维度修复开启、日志关闭。
  setComboValue(getCompatWidget(node), MODE_REPAIR);
  setBooleanWidget(getDebugWidget(node), false);

  const el = createToolbar(node);
  let widget = null;
  if (typeof node.addDOMWidget === "function") {
    widget = node.addDOMWidget("gjj_audio_toolbar", "GJJ 音频工具栏", el, {
      getValue: () => node.properties?.[PROP_TOOLBAR_READY] || "1",
      setValue: () => {},
      serialize: false,
    });
  } else if (typeof node.addWidget === "function") {
    widget = node.addWidget("button", "📁 🛠️ 🧾 🔌", null, () => openMediaPicker(node));
    widget.options = widget.options || {};
    widget.options.tooltip = "当前 ComfyUI 版本不支持 addDOMWidget，已退回普通按钮。";
  }

  if (widget) {
    widget.name = "gjj_audio_toolbar";
    widget.label = "";
    widget.options = widget.options || {};
    widget.options.serialize = false;
    node.__gjjAudioToolbarWidget = widget;
  }

  node.properties = node.properties || {};
  node.properties[PROP_TOOLBAR_READY] = "1";
  updateToolbarState(node);
}

function addStatusBar(node) {
  if (!node || node.__gjjAudioStatusWidget) return;

  const el = createStatusBar(node);
  let widget = null;
  if (typeof node.addDOMWidget === "function") {
    widget = node.addDOMWidget("gjj_audio_status", "GJJ 音频状态栏", el, {
      getValue: () => "",
      setValue: () => {},
      serialize: false,
    });
  }

  if (widget) {
    widget.name = "gjj_audio_status";
    widget.label = "";
    widget.options = widget.options || {};
    widget.options.serialize = false;
    node.__gjjAudioStatusWidget = widget;
  }
}

function sortWidgets(node) {
  try {
    const widgets = node.widgets || [];
    const toolbar = node.__gjjAudioToolbarWidget;
    if (!toolbar) return;

    const idx = widgets.indexOf(toolbar);
    if (idx >= 0) widgets.splice(idx, 1);
    widgets.unshift(toolbar);
  } catch (_) {}
}

function setupNode(node) {
  ensureSingleMediaInput(node);
  ensureNativeLabelSpace(node);
  addToolbar(node);
  addStatusBar(node);
  completeHideWidget(getCompatWidget(node));
  completeHideWidget(getDebugWidget(node));
  sortWidgets(node);

  setTimeout(() => {
    const showMore = !!node.properties?.[PROP_MORE_OUTPUTS] || hasExtraOutputLinks(node);
      applyOutputMode(node, showMore);
      updateToolbarState(node);
    ensureSingleMediaInput(node);
    syncMediaFileForExternalInput(node);
    markCanvasDirty(node);
  }, 0);
}

app.registerExtension({
  name: "GJJ.AudioSeparator.UI.V12",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== TARGET) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const r = onNodeCreated?.apply(this, args);
      setupNode(this);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const r = onConfigure?.apply(this, args);
      setupNode(this);
      return r;
    };

    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (...args) {
      const r = onConnectionsChange?.apply(this, args);
      ensureSingleMediaInput(this);
      syncMediaFileForExternalInput(this);
      markCanvasDirty(this);
      return r;
    };
  },

  async setup() {
    // 监听后端发送的错误事件
    api?.addEventListener?.("gjj_audio_separator_error", (event) => {
      try {
        const data = event.detail || {};
        const nodeId = data.node;
        const errorMessage = data.error || "";
        const installCommand = data.install_command || "";
        if (!nodeId) return;

        // 遍历所有节点，找到匹配的那个
        for (const node of app.graph?._nodes || []) {
          if (String(node.id) !== String(nodeId)) continue;

          // 更新状态栏
          if (node.__gjjStatusText) {
            node.__gjjStatusText.textContent = errorMessage;
          }

          // 显示复制按钮
          if (node.__gjjCopyBtn) {
            if (installCommand) {
              node.__gjjCopyBtn.style.display = "inline-flex";
              node.__gjjCopyBtn.__gjj_install_cmd = installCommand;
            } else {
              node.__gjjCopyBtn.style.display = "none";
            }
          }

          markCanvasDirty(node);
          break;
        }
      } catch (e) {
        console.error("[GJJ AudioSeparator] 处理错误事件失败：", e);
      }
    });
  },
});
