import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_CLASS_NAME = "GJJ_BatchOutpaint";
const STATUS_WIDGET_NAME = "gjj_batch_outpaint_status";

const WORKFLOW_KEYS = [
    "512-inpainting-ema扩图",
    "Flux2-klein扩图",
    "Qwen_image_edit扩图",
    "flux_fill_dev扩图",
];

const WORKFLOW_LABELS = {
    "512-inpainting-ema扩图": "SD1.5 Inpaint",
    "Flux2-klein扩图": "Flux2 Klein",
    "Qwen_image_edit扩图": "Qwen Edit",
    "flux_fill_dev扩图": "Flux Fill",
};

const DEFAULT_WORKFLOW = "flux_fill_dev扩图";
const DYNAMIC_KEYS = ["left", "right", "top", "bottom", "target_width", "target_height", "direction"];
const LEGACY_WIDGET_NAMES = ["workflow_0", "workflow_1", "workflow_2", "workflow_3", "outpaint_mode"];
const HIDDEN_WIDGET_NAMES = ["prompt", "negative", "反向提示词", "提示词"];
const PREVIEW_WIDGET_NAMES = ["preview", "image", "images", "预览", "预览图像", "preview_image"];

function props(node) {
    node.properties = node.properties || {};
    return node.properties;
}

function requestRedraw(node) {
    try { node.setDirtyCanvas?.(true, true); } catch (_) {}
    try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
}

function removeLegacyWidgets(node) {
    if (!Array.isArray(node.widgets)) return;
    node.widgets = node.widgets.filter((w) => !LEGACY_WIDGET_NAMES.includes(w?.name));
}

function removePromptWidgets(node) {
    if (!Array.isArray(node.widgets)) return;
    node.widgets = node.widgets.filter((w) => {
        const name = String(w?.name || "");
        const label = String(w?.label || "");
        return !HIDDEN_WIDGET_NAMES.includes(name) && !HIDDEN_WIDGET_NAMES.includes(label);
    });
}

function removeInternalPreviewWidgets(node) {
    if (!Array.isArray(node.widgets)) return;
    node.widgets = node.widgets.filter((w) => {
        const name = String(w?.name || "").toLowerCase();
        const type = String(w?.type || "").toLowerCase();
        const label = String(w?.label || "").toLowerCase();
        const isPreviewName = PREVIEW_WIDGET_NAMES.some((key) => name.includes(String(key).toLowerCase()) || label.includes(String(key).toLowerCase()));
        const isImageWidget = type.includes("image") || type.includes("preview");
        return !(isPreviewName && isImageWidget);
    });
}

function cleanupNodeWidgets(node) {
    cleanupNodeWidgets(node);
    removePromptWidgets(node);
    removeInternalPreviewWidgets(node);
}

function selectedWorkflows(node) {
    const raw = String(props(node).selected_workflows || "");
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function setSelectedWorkflows(node, list) {
    const clean = [...new Set(list.filter((k) => WORKFLOW_KEYS.includes(k)))];
    props(node).selected_workflows = clean.join(",");
    updateWorkflowButtons(node);
    requestRedraw(node);
}

function toggleWorkflow(node, key) {
    const list = selectedWorkflows(node);
    const index = list.indexOf(key);
    if (index >= 0) list.splice(index, 1);
    else list.push(key);
    setSelectedWorkflows(node, list);
}

function getMode(node) {
    return String(props(node).outpaint_mode || "像素扩图");
}

function setMode(node, mode) {
    props(node).outpaint_mode = mode;
    updateModeButtons(node);
    rebuildDynamicWidgets(node);
    requestRedraw(node);
}

function makeButton(text) {
    const btn = document.createElement("button");
    btn.textContent = text;
    btn.style.cssText = [
        "border:1px solid #3e4d54",
        "border-radius:7px",
        "background:#1a1f2e",
        "color:#dce7e2",
        "padding:5px 8px",
        "font-size:11px",
        "line-height:1.2",
        "cursor:pointer",
        "white-space:nowrap",
        "transition:background .15s,border-color .15s,transform .15s",
    ].join(";");
    btn.onmouseenter = () => (btn.style.transform = "translateY(-1px)");
    btn.onmouseleave = () => (btn.style.transform = "translateY(0)");
    return btn;
}

function createWorkflowSelector(node) {
    if (node.__gjjWorkflowContainer) return;

    const container = document.createElement("div");
    container.className = "gjj-batch-outpaint-workflows";
    container.style.cssText = [
        "box-sizing:border-box",
        "padding:8px 10px",
        "margin:4px 0",
        "background:#121a1f",
        "border:1px solid #3e4d54",
        "border-radius:10px",
    ].join(";");

    const title = document.createElement("div");
    title.textContent = "扩图工作流（单击单选，Ctrl/Shift 多选）";
    title.style.cssText = "font-size:12px;color:#9fb2bd;margin-bottom:6px;font-weight:700;";

    const row = document.createElement("div");
    row.style.cssText = "display:flex;flex-wrap:wrap;gap:5px;";

    for (const key of WORKFLOW_KEYS) {
        const btn = makeButton(WORKFLOW_LABELS[key] || key);
        btn.className = "gjj-workflow-btn";
        btn.dataset.key = key;
        btn.title = key;
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.ctrlKey || e.shiftKey) toggleWorkflow(node, key);
            else setSelectedWorkflows(node, [key]);
        });
        row.appendChild(btn);
    }

    const status = document.createElement("div");
    status.className = "gjj-workflow-status";
    status.style.cssText = "margin-top:6px;font-size:11px;color:#ffb74d;";

    container.appendChild(title);
    container.appendChild(row);
    container.appendChild(status);

    node.addDOMWidget("gjj_workflow_selector", "workflow_selector", container, {
        hideOnZoom: false,
        getHeight: () => 100,
    });
    node.__gjjWorkflowContainer = container;

    if (selectedWorkflows(node).length === 0) setSelectedWorkflows(node, [DEFAULT_WORKFLOW]);
    updateWorkflowButtons(node);
}

function updateWorkflowButtons(node) {
    const container = node.__gjjWorkflowContainer;
    if (!container) return;
    const list = selectedWorkflows(node);
    for (const btn of container.querySelectorAll(".gjj-workflow-btn")) {
        const active = list.includes(btn.dataset.key);
        btn.style.background = active ? "#1f6b3a" : "#1a1f2e";
        btn.style.borderColor = active ? "#55d17a" : "#3e4d54";
        btn.style.fontWeight = active ? "700" : "400";
    }
    const status = container.querySelector(".gjj-workflow-status");
    if (status) {
        status.textContent = list.length ? `已选择 ${list.length} 个：${list.map((k) => WORKFLOW_LABELS[k] || k).join(" / ")}` : "未选择工作流";
        status.style.color = list.length ? "#55d17a" : "#ffb74d";
    }
}

function createModeSelector(node) {
    if (node.__gjjModeContainer) return;
    const container = document.createElement("div");
    container.style.cssText = "display:flex;gap:6px;padding:4px 0;";

    for (const mode of ["像素扩图", "目标尺寸"]) {
        const btn = makeButton(mode);
        btn.className = "gjj-mode-btn";
        btn.dataset.mode = mode;
        btn.style.flex = "1";
        btn.style.fontSize = "12px";
        btn.style.padding = "7px 8px";
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            setMode(node, mode);
        });
        container.appendChild(btn);
    }

    node.addDOMWidget("gjj_mode_selector", "mode_selector", container, {
        hideOnZoom: false,
        getHeight: () => 38,
    });
    node.__gjjModeContainer = container;
    if (!props(node).outpaint_mode) props(node).outpaint_mode = "像素扩图";
    updateModeButtons(node);
}

function updateModeButtons(node) {
    const container = node.__gjjModeContainer;
    if (!container) return;
    const mode = getMode(node);
    for (const btn of container.querySelectorAll(".gjj-mode-btn")) {
        const active = btn.dataset.mode === mode;
        btn.style.background = active ? "#1f6b3a" : "#1a1f2e";
        btn.style.borderColor = active ? "#55d17a" : "#3e4d54";
        btn.style.fontWeight = active ? "700" : "400";
    }
}

function removeDynamicWidgets(node) {
    if (!Array.isArray(node.widgets)) return;
    node.widgets = node.widgets.filter((w) => !DYNAMIC_KEYS.includes(w?.gjj_key));
}

function addNumberWidget(node, key, label, defaultValue, min, max, step) {
    const p = props(node);
    if (p[key] === undefined || p[key] === null || p[key] === "") p[key] = defaultValue;
    const w = node.addWidget("number", label, Number(p[key]), (v) => {
        p[key] = Number(v);
        requestRedraw(node);
    }, { min, max, step });
    w.gjj_key = key;
    return w;
}

function addComboWidget(node, key, label, defaultValue, values) {
    const p = props(node);
    if (!values.includes(p[key])) p[key] = defaultValue;
    const w = node.addWidget("combo", label, p[key], (v) => {
        p[key] = v;
        requestRedraw(node);
    }, { values });
    w.gjj_key = key;
    return w;
}

function addTextWidget(node, key, label, defaultValue) {
    const p = props(node);
    if (p[key] === undefined || p[key] === null) p[key] = defaultValue;
    const w = node.addWidget("text", label, String(p[key] || ""), (v) => {
        p[key] = String(v || "");
        requestRedraw(node);
    }, { multiline: false });
    w.gjj_key = key;
    return w;
}

function rebuildDynamicWidgets(node) {
    removeDynamicWidgets(node);
    const mode = getMode(node);

    if (mode === "目标尺寸") {
        addNumberWidget(node, "target_width", "目标宽度", 1024, 64, 8192, 8);
        addNumberWidget(node, "target_height", "目标高度", 1024, 64, 8192, 8);
        addComboWidget(node, "direction", "扩图方向", "居中扩展", ["居中扩展", "向右扩展", "向左扩展", "向上扩展", "向下扩展"]);
    } else {
        addNumberWidget(node, "left", "左扩", 0, 0, 4096, 8);
        addNumberWidget(node, "right", "右扩", 0, 0, 4096, 8);
        addNumberWidget(node, "top", "上扩", 0, 0, 4096, 8);
        addNumberWidget(node, "bottom", "下扩", 0, 0, 4096, 8);
    }

    requestRedraw(node);
}

function createStatusWidget(node) {
    if (node.__gjjStatusBox) return;
    const box = document.createElement("div");
    box.textContent = "等待执行";
    box.style.cssText = [
        "box-sizing:border-box",
        "min-height:34px",
        "padding:7px 10px",
        "border:1px solid #41535b",
        "border-radius:10px",
        "background:#121a1f",
        "color:#dce7e2",
        "font-size:12px",
        "line-height:1.35",
        "white-space:pre-wrap",
        "word-break:break-word",
    ].join(";");
    node.addDOMWidget(STATUS_WIDGET_NAME, STATUS_WIDGET_NAME, box, {
        hideOnZoom: false,
        getHeight: () => Math.max(42, box.scrollHeight + 10),
    });
    node.__gjjStatusBox = box;
}

function setStatus(node, text) {
    const value = String(text || "等待执行");
    if (node.__gjjGenerateBtn) {
        node.__gjjGenerateBtn.textContent = value;
    }
    if (node.__gjjStatusBox) {
        node.__gjjStatusBox.textContent = value;
    }
    requestRedraw(node);
}

function createGenerateButton(node) {
    if (node.__gjjGenerateBtn) return;
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;gap:6px;padding:4px 0;";

    const btn = makeButton("生成当前节点");
    btn.style.flex = "1";
    btn.style.background = "#1f6b3a";
    btn.style.borderColor = "#55d17a";
    btn.style.fontSize = "13px";
    btn.style.padding = "8px 10px";
    btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearError(node);
        setStatus(node, "正在提交执行...");
        btn.disabled = true;
        try {
            await app.queuePrompt(0, 1);
        } catch (err) {
            showError(node, "提交失败", err?.message || String(err));
            setStatus(node, "提交失败");
        } finally {
            setTimeout(() => {
                btn.disabled = false;
            }, 500);
        }
    });

    wrap.appendChild(btn);
    node.addDOMWidget("gjj_generate_button", "generate_button", wrap, {
        hideOnZoom: false,
        getHeight: () => 42,
    });
    node.__gjjGenerateBtn = btn;
}

function createErrorArea(node) {
    if (node.__gjjErrorBox) return;
    const box = document.createElement("div");
    box.style.cssText = [
        "display:none",
        "box-sizing:border-box",
        "padding:7px 10px",
        "border:1px solid #c62828",
        "border-radius:10px",
        "background:#1a0a0a",
        "color:#ff8a80",
        "font-size:11px",
        "line-height:1.4",
        "white-space:pre-wrap",
        "word-break:break-word",
    ].join(";");
    node.addDOMWidget("gjj_error_area", "error_area", box, {
        hideOnZoom: false,
        getHeight: () => box.style.display === "none" ? 0 : Math.max(50, box.scrollHeight + 10),
    });
    node.__gjjErrorBox = box;
}

function showError(node, title, message) {
    if (!node.__gjjErrorBox) return;
    node.__gjjErrorBox.innerHTML = `<b>${escapeHtml(title)}</b><br>${escapeHtml(message)}`;
    node.__gjjErrorBox.style.display = "block";
    requestRedraw(node);
}

function clearError(node) {
    if (!node.__gjjErrorBox) return;
    node.__gjjErrorBox.innerHTML = "";
    node.__gjjErrorBox.style.display = "none";
    requestRedraw(node);
}

function escapeHtml(text) {
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function initNode(node) {
    cleanupNodeWidgets(node);
    if (!props(node).outpaint_mode) props(node).outpaint_mode = "像素扩图";
    if (!props(node).selected_workflows) props(node).selected_workflows = DEFAULT_WORKFLOW;

    createWorkflowSelector(node);
    createModeSelector(node);
    rebuildDynamicWidgets(node);
    createGenerateButton(node);
    setStatus(node, "生成当前节点");
    createErrorArea(node);

    updateWorkflowButtons(node);
    updateModeButtons(node);
    const w = Math.max(420, node.size?.[0] || 420);
    const h = Math.max(520, node.size?.[1] || 520);
    node.setSize?.([w, h]);
    requestRedraw(node);
}

app.registerExtension({
    name: `GJJ.${NODE_CLASS_NAME}`,

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_CLASS_NAME) return;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const r = originalOnNodeCreated?.apply(this, args);
            setTimeout(() => initNode(this), 0);
            return r;
        };

        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const r = originalOnConfigure?.apply(this, args);
            setTimeout(() => initNode(this), 50);
            return r;
        };

        const originalOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            originalOnExecuted?.apply(this, arguments);
            clearError(this);
            setStatus(this, "执行完成");
            requestRedraw(this);
        };

        const originalOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function (...args) {
            delete this.__gjjWorkflowContainer;
            delete this.__gjjModeContainer;
            delete this.__gjjStatusBox;
            delete this.__gjjGenerateBtn;
            delete this.__gjjErrorBox;
            return originalOnRemoved?.apply(this, args);
        };
    },

    async setup() {
        api.addEventListener("gjj_node_progress", (event) => {
            const detail = event.detail || {};
            const nodeId = String(detail.node || "");
            const node = app.graph?.nodes?.find((n) => String(n.id) === nodeId);
            if (!node || node.comfyClass !== NODE_CLASS_NAME) return;
            const label = String(detail.text || "");
            const pct = detail.progress != null ? ` ${Math.round(Number(detail.progress) * 100)}%` : "";
            setStatus(node, `${label}${pct}`.trim() || "生成中...");
        });

        api.addEventListener("gjj_batch_outpaint_error", (event) => {
            const detail = event.detail || {};
            const nodeId = String(detail.node || "");
            const node = app.graph?.nodes?.find((n) => String(n.id) === nodeId);
            if (!node || node.comfyClass !== NODE_CLASS_NAME) return;
            showError(node, String(detail.title || "错误"), String(detail.message || ""));
            if (node.__gjjGenerateBtn) node.__gjjGenerateBtn.textContent = "生成当前节点";
        });
    },
});
