import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { GJJ_Utils } from "./gjj_utils.js";

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
    .gjj-audio-separator-toolbar.gjj-has-copy {
      grid-template-columns: repeat(5, minmax(0, 1fr));
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

function refreshAudioNode(node) {
  try {
    GJJ_Utils.scheduleRefreshNode(node, { minWidth: MIN_NODE_WIDTH_FOR_NATIVE_LABELS, minHeight: 80 });
  } catch (_) {
    markCanvasDirty(node);
  }
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

function getModelWidget(node) {
  return findWidgetAny(node, ["📦 模型选择", "model_name"]);
}

function getAudioTagWidget(node) {
  return findWidgetAny(node, ["🏷️ 音频标签", "audio_tag"]);
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

function comboValues(widget) {
  const values = widget?.options?.values || widget?.options?.comboValues || widget?.values;
  return Array.isArray(values) ? values : [];
}

function isComboValueValid(widget, value) {
  const values = comboValues(widget);
  return !values.length || values.includes(value);
}

function setWidgetValue(widget, value) {
  if (!widget) return;
  widget.value = value;
  try { widget.callback?.(value); } catch (_) {}
}

function isModelFilename(value) {
  return /(?:melbandroformer|mel[-_ ]?band[-_ ]?roformer|\.safetensors$|\.ckpt$|\.pt$|\.pth$|\.bin$)/i.test(String(value || ""));
}

function repairShiftedWidgetValues(node) {
  const modelWidget = getModelWidget(node);
  const mediaWidget = getMediaFileWidget(node);
  const tagWidget = getAudioTagWidget(node);
  const compatWidget = getCompatWidget(node);
  const debugWidget = getDebugWidget(node);

  const modelValue = String(modelWidget?.value || "");
  const mediaValue = String(mediaWidget?.value || "");
  const tagValue = String(tagWidget?.value || "");
  const compatValue = String(compatWidget?.value || "");
  const modelChoices = comboValues(modelWidget);
  const shiftedValues = [mediaValue, tagValue, compatValue].map((item) => String(item || "").trim()).filter(Boolean);

  if (modelWidget && (!modelValue || !isComboValueValid(modelWidget, modelWidget.value))) {
    const shiftedModel = shiftedValues.find((value) => modelChoices.includes(value))
      || shiftedValues.find((value) => isModelFilename(value) && (!modelChoices.length || modelChoices.includes(value)));
    if (shiftedModel) setWidgetValue(modelWidget, shiftedModel);
    else if (modelChoices.length) setWidgetValue(modelWidget, modelChoices[0]);
  }

  if (mediaWidget && (!isComboValueValid(mediaWidget, mediaWidget.value) || isModelFilename(mediaValue) || /^&\s*"/.test(mediaValue))) {
    setWidgetValue(mediaWidget, MEDIA_SENTINEL);
  }
  if (compatWidget && !isComboValueValid(compatWidget, compatWidget.value)) {
    setWidgetValue(compatWidget, MODE_REPAIR);
  }
  if (tagWidget && (!tagValue || tagValue === MEDIA_SENTINEL || tagValue === MODE_REPAIR || tagValue === MODE_AUTO || isModelFilename(tagValue) || tagValue === modelValue || /^&\s*"/.test(tagValue))) {
    setWidgetValue(tagWidget, "input_audio");
  }
  if (debugWidget && typeof debugWidget.value !== "boolean") {
    setWidgetValue(debugWidget, false);
  }
}

function makeTransientWidget(widget) {
  if (!widget) return widget;
  widget.serialize = false;
  widget.value = undefined;
  widget.options = widget.options || {};
  widget.options.serialize = false;
  return widget;
}

function shouldSerializeAudioWidget(widget) {
  if (!widget) return false;
  const name = String(widget.name || widget.label || "");
  if (name === "gjj_audio_toolbar" || name === "gjj_audio_status" || name === "gjj_audio_copy_command") return false;
  if (name.startsWith("gjj_") || name.startsWith("GJJ_")) return false;
  if (widget.serialize === false || widget.options?.serialize === false) return false;
  return Object.prototype.hasOwnProperty.call(widget, "value");
}

function sanitizeSerializedWidgetValues(node, data) {
  if (!data || !Array.isArray(node?.widgets)) return;
  repairShiftedWidgetValues(node);
  data.widgets_values = node.widgets
    .filter(shouldSerializeAudioWidget)
    .map((widget) => widget.value);
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

function firstWarningLine(text) {
  const line = String(text || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean) || "";
  return line.startsWith("⚠️") ? line : "";
}

let audioHelpByClass = null;
let audioHelpPromise = null;

function currentHelpPayload(nodeData = null) {
  const backend = audioHelpByClass?.[TARGET] || {};
  const inlineHelp = nodeData?.help || nodeData?.GJJ_HELP || null;
  const inlineHasNotice = !!(
    inlineHelp?.warning_message
    || inlineHelp?.notice
    || inlineHelp?.copy_text
    || inlineHelp?.install_cmd
    || inlineHelp?.model_download_url
  );
  const help = inlineHasNotice ? inlineHelp : (backend?.help || inlineHelp || {});
  const description = String(nodeData?.description || nodeData?.DESCRIPTION || backend?.description || "").trim();
  return { help, description };
}

function startupNotice(nodeData = null) {
  const { help, description } = currentHelpPayload(nodeData);
  const warning = firstWarningLine(help?.warning_message || help?.notice || help?.description) || firstWarningLine(description);
  const copyText = warning ? String(help?.copy_text || help?.install_cmd || help?.model_download_url || "").trim() : "";
  const copyLabel = String(help?.copy_label || "").trim();
  return { warning, copyText, copyLabel };
}

function applyStartupNotice(node, nodeData = null) {
  if (!node || node.__gjjAudioRuntimeStatusShown) return;
  const { warning, copyText, copyLabel } = startupNotice(nodeData);
  if (warning && node.__gjjStatusText) {
    node.__gjjStatusText.textContent = warning;
  }
  setPanelCopy(node, copyText, copyLabel);
  setToolbarCopy(node, copyText, copyLabel);
  refreshAudioNode(node);
  markCanvasDirty(node);
}

async function loadAudioHelpData() {
  if (audioHelpByClass) return audioHelpByClass;
  if (audioHelpPromise) return audioHelpPromise;
  audioHelpPromise = (async () => {
    try {
      const response = await api.fetchApi("/gjj/node_help");
      if (!response?.ok) return {};
      const payload = await response.json();
      audioHelpByClass = payload || {};
      return audioHelpByClass;
    } catch (error) {
      console.warn("[GJJ AudioSeparator] 节点帮助信息加载失败：", error);
      return {};
    }
  })();
  return audioHelpPromise;
}

function setToolbarCopy(node, copyText = "", copyLabel = "") {
  const copy = node?.__gjjToolbarButtons?.copy;
  const wrap = node?.__gjjToolbarButtons?.wrap;
  if (!copy) return;
  const text = String(copyText || "").trim();
  copy.__gjj_copy_text = text;
  copy.textContent = /^https?:\/\//i.test(text) ? "🌏" : "📋";
  copy.title = text ? `${GJJ_Utils.getDependencyCopyLabel(text, copyLabel)}\n${text}` : "复制安装命令或模型下载网址";
  copy.style.display = text ? "" : "none";
  wrap?.classList?.toggle("gjj-has-copy", !!text);
}

function setPanelCopy(node, copyText = "", copyLabel = "") {
  const copyBtn = node?.__gjjCopyBtn;
  if (!copyBtn) return;
  const text = String(copyText || "").trim();
  copyBtn.__gjj_copy_text = text;
  copyBtn.__gjj_install_cmd = text;
  copyBtn.__gjj_copy_label = String(copyLabel || "").trim();
  GJJ_Utils.applyDependencyCopyButton(copyBtn, {
    copyText: text,
    copyLabel,
    visible: !!text,
    onCopied: () => {
      flashToolbarCopy(node);
    },
  });
  refreshAudioNode(node);
}

function flashPanelCopy(node) {
  const copyBtn = node?.__gjjCopyBtn;
  if (!copyBtn) return;
  GJJ_Utils.flashDependencyCopyButton(copyBtn);
}

function copyPanelText(node) {
  const text = String(node?.__gjjCopyBtn?.__gjj_copy_text || node?.__gjjCopyBtn?.__gjj_install_cmd || "").trim();
  if (!text) return false;
  const now = Date.now();
  if (now - Number(node.__gjjAudioLastPanelCopyAt || 0) < 350) return true;
  node.__gjjAudioLastPanelCopyAt = now;
  GJJ_Utils.copyTextToClipboard(text).then((ok) => {
    if (!ok) return;
    flashPanelCopy(node);
    flashToolbarCopy(node);
  }).catch((error) => {
    console.error("[GJJ AudioSeparator] 复制失败：", error);
  });
  return true;
}

function flashToolbarCopy(node) {
  const copy = node?.__gjjToolbarButtons?.copy;
  if (!copy) return;
  const old = copy.textContent || "📋";
  copy.textContent = "✅";
  copy.classList.add("gjj-active");
  setTimeout(() => {
    copy.textContent = old;
    copy.classList.remove("gjj-active");
  }, 1200);
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
  const copy = button("📋", "复制安装命令或模型下载网址", async () => {
    const text = String(copy.__gjj_copy_text || "").trim();
    if (!text) return;
    try {
      const ok = await GJJ_Utils.copyTextToClipboard(text);
      if (!ok) return;
      flashToolbarCopy(node);
    } catch (error) {
      console.error("[GJJ AudioSeparator] 复制失败：", error);
    }
  });
  copy.style.display = "none";

  wrap.append(open, repair, log, more, copy);

  node.__gjjToolbarButtons = { open, repair, log, more, copy, wrap };
  return wrap;
}

function handleToolbarMouse(event, pos, node) {
  const buttons = node?.__gjjToolbarButtons;
  if (!buttons) return false;
  const hasCopy = !!String(buttons.copy?.__gjj_copy_text || "").trim();
  const labels = hasCopy ? ["open", "repair", "log", "more", "copy"] : ["open", "repair", "log", "more"];
  const width = Math.max(1, Number(node.size?.[0] || 1) - 20);
  const rawX = Number(pos?.[0] ?? 0);
  const x = Math.max(0, Math.min(width - 1, rawX > width ? rawX - 10 : rawX));
  const target = labels[Math.max(0, Math.min(labels.length - 1, Math.floor((x / width) * labels.length)))];

  try { event?.preventDefault?.(); } catch (_) {}
  try { event?.stopPropagation?.(); } catch (_) {}

  if (target === "open") openMediaPicker(node);
  else if (target === "repair") toggleRepairMode(node);
  else if (target === "log") toggleLog(node);
  else if (target === "more") {
    const current = !!node.properties?.[PROP_MORE_OUTPUTS] || hasExtraOutputLinks(node);
    applyOutputMode(node, !current);
  } else if (target === "copy") {
    const text = String(buttons.copy?.__gjj_copy_text || "").trim();
    if (!text) return true;
    const now = Date.now();
    if (now - Number(node.__gjjAudioLastCopyAt || 0) < 350) return true;
    node.__gjjAudioLastCopyAt = now;
    GJJ_Utils.copyTextToClipboard(text).then((ok) => {
      if (!ok) return;
      flashToolbarCopy(node);
    }).catch((error) => {
      console.error("[GJJ AudioSeparator] 复制失败：", error);
    });
  }
  markCanvasDirty(node);
  return true;
}

function createStatusBar(node, initialText = "", initialCopyText = "", initialCopyLabel = "") {
  // 创建状态栏容器
  const statusContainer = document.createElement("div");
  statusContainer.style.width = "100%";
  statusContainer.style.marginTop = "8px";

  // 状态栏文字
  const statusText = document.createElement("div");
  statusText.className = "gjj-audio-separator-status";
  statusText.textContent = initialText || "";
  statusContainer.appendChild(statusText);

  // 复制按钮
  const copyBtn = document.createElement("button");
  copyBtn.className = "gjj-audio-separator-copy-btn";
  GJJ_Utils.applyDependencyCopyButton(copyBtn, { visible: false });
  copyBtn.style.marginTop = "8px";
  statusContainer.appendChild(copyBtn);

  // 保存引用到节点
  node.__gjjStatusText = statusText;
  node.__gjjCopyBtn = copyBtn;
  node.__gjjStatusContainer = statusContainer;
  if (initialCopyText) {
    setPanelCopy(node, initialCopyText, initialCopyLabel);
  }

  return statusContainer;
}

function handleStatusMouse(event, pos, node) {
  const copyText = String(node?.__gjjCopyBtn?.__gjj_copy_text || "").trim();
  if (!copyText) return false;
  const eventType = String(event?.type || "");
  if (eventType && !["pointerdown", "mousedown", "click"].includes(eventType)) return false;

  try { event?.preventDefault?.(); } catch (_) {}
  try { event?.stopPropagation?.(); } catch (_) {}
  copyPanelText(node);
  markCanvasDirty(node);
  return true;
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
      hideOnZoom: false,
      getHeight: () => 34,
    });
  } else if (typeof node.addWidget === "function") {
    widget = node.addWidget("button", "📁 🛠️ 🧾 🔌", null, () => openMediaPicker(node));
    widget.options = widget.options || {};
    widget.options.tooltip = "当前 ComfyUI 版本不支持 addDOMWidget，已退回普通按钮。";
  }

  if (widget) {
    makeTransientWidget(widget);
    widget.name = "gjj_audio_toolbar";
    widget.label = "";
    widget.mouse = function (event, pos, canvasNode) {
      const eventType = String(event?.type || "");
      if (eventType && !["pointerdown", "mousedown", "click"].includes(eventType)) return false;
      return handleToolbarMouse(event, pos, canvasNode || node);
    };
    node.__gjjAudioToolbarWidget = widget;
  }

  node.properties = node.properties || {};
  node.properties[PROP_TOOLBAR_READY] = "1";
  updateToolbarState(node);
}

function addStatusBar(node, initialText = "", initialCopyText = "", initialCopyLabel = "") {
  if (!node || node.__gjjAudioStatusWidget) return;

  const el = createStatusBar(node, initialText, initialCopyText, initialCopyLabel);
  let widget = null;
  if (typeof node.addDOMWidget === "function") {
    widget = node.addDOMWidget("gjj_audio_status", "GJJ 音频状态栏", el, {
      getValue: () => "",
      setValue: () => {},
      serialize: false,
      hideOnZoom: false,
      getHeight: () => {
        const hasText = !!String(node.__gjjStatusText?.textContent || "").trim();
        const hasCopy = !!String(node.__gjjCopyBtn?.__gjj_copy_text || "").trim();
        if (!hasText && !hasCopy) return 0;
        return Math.max(42, (node.__gjjStatusContainer?.scrollHeight || 34) + 10);
      },
    });
  }

  if (widget) {
    makeTransientWidget(widget);
    widget.name = "gjj_audio_status";
    widget.label = "";
    widget.mouse = function (event, pos, canvasNode) {
      return handleStatusMouse(event, pos, canvasNode || node);
    };
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

function removeLegacyCopyWidget(node) {
  if (!Array.isArray(node?.widgets)) return;
  for (let i = node.widgets.length - 1; i >= 0; i--) {
    const name = String(node.widgets[i]?.name || node.widgets[i]?.label || "");
    if (name === "gjj_audio_copy_command") {
      node.widgets.splice(i, 1);
    }
  }
}

function setupNode(node, nodeData = null) {
  const { warning, copyText, copyLabel } = startupNotice(nodeData);
  ensureSingleMediaInput(node);
  ensureNativeLabelSpace(node);
  removeLegacyCopyWidget(node);
  repairShiftedWidgetValues(node);
  addToolbar(node);
  addStatusBar(node, warning, copyText, copyLabel);
  applyStartupNotice(node, nodeData);
  completeHideWidget(getCompatWidget(node));
  completeHideWidget(getDebugWidget(node));
  sortWidgets(node);

  setTimeout(() => {
    const showMore = !!node.properties?.[PROP_MORE_OUTPUTS] || hasExtraOutputLinks(node);
      applyOutputMode(node, showMore);
      updateToolbarState(node);
    repairShiftedWidgetValues(node);
    ensureSingleMediaInput(node);
    syncMediaFileForExternalInput(node);
    applyStartupNotice(node, nodeData);
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
      setupNode(this, nodeData);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const r = onConfigure?.apply(this, args);
      setupNode(this, nodeData);
      return r;
    };

    const onMouseDown = nodeType.prototype.onMouseDown;
    nodeType.prototype.onMouseDown = function (event, pos, canvas) {
      const toolbar = this.__gjjAudioToolbarWidget;
      if (toolbar) {
        const y = Number(pos?.[1] ?? -1);
        const widgetY = Number(toolbar.last_y ?? toolbar.y ?? -9999);
        if ((y >= widgetY && y <= widgetY + 36) || (y >= 0 && y <= 36)) {
          if (handleToolbarMouse(event, pos, this)) return true;
        }
      }
      return onMouseDown?.apply(this, arguments);
    };

    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (...args) {
      const r = onConnectionsChange?.apply(this, args);
      ensureSingleMediaInput(this);
      syncMediaFileForExternalInput(this);
      markCanvasDirty(this);
      return r;
    };

    const onSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (data) {
      repairShiftedWidgetValues(this);
      const r = onSerialize?.apply(this, arguments);
      sanitizeSerializedWidgetValues(this, data);
      return r;
    };
  },

  async setup() {
    loadAudioHelpData().then(() => {
      for (const node of app.graph?._nodes || []) {
        if (String(node?.comfyClass || node?.type || "") === TARGET) {
          setupNode(node, {});
        }
      }
    });

    // 监听后端发送的错误事件
    api?.addEventListener?.("gjj_audio_separator_error", (event) => {
      try {
        const data = event.detail || {};
        const nodeId = data.node;
        const errorMessage = data.panel_message || data.warning_message || data.error || "";
        const copyText = data.copy_text || data.install_command || data.model_download_url || "";
        const copyLabel = data.copy_label || "";

        const nodes = (app.graph?._nodes || []).filter((node) => {
          if (String(node?.comfyClass || node?.type || "") !== TARGET) return false;
          return nodeId ? String(node.id) === String(nodeId) : true;
        });

        // 优先更新匹配 unique_id 的节点；如果后端没带 unique_id，则更新当前图里的同类节点。
        for (const node of nodes) {

          addStatusBar(node);
          node.__gjjAudioRuntimeStatusShown = true;

          // 更新状态栏
          if (node.__gjjStatusText) {
            node.__gjjStatusText.textContent = errorMessage;
          }

          // 显示复制按钮
          setPanelCopy(node, copyText, copyLabel);
          setToolbarCopy(node, copyText, copyLabel);

          refreshAudioNode(node);
          markCanvasDirty(node);
          if (nodeId) break;
        }
      } catch (e) {
        console.error("[GJJ AudioSeparator] 处理错误事件失败：", e);
      }
    });
  },
});
