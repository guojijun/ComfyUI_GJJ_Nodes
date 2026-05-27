import { app } from "/scripts/app.js";

const NODE_NAME = "GJJ_ModelOptimizer";
const PROP_NAME = "gjj_model_optimizer_config";

const DEFAULT_CONFIG = {
    enable_torch_compile: false,
    compile_backend: "inductor",
    compile_fullgraph: false,
    compile_mode: "default",
    compile_dynamic: "自动",
    compile_transformer_blocks_only: true,
    sage_attention: "关闭",
    allow_sage_compile: false,
    enable_fp16_accumulation: false,
    dynamo_cache_size_limit: 64,
};

const SAGE_MODES = [
    "关闭",
    "自动",
    "int8_fp16_cuda",
    "int8_fp16_triton",
    "int8_fp8_cuda",
    "int8_fp8_cuda_plus",
    "sageattn3",
    "sageattn3分块均值",
];

const COMPILE_MODES = [
    "default",
    "max-autotune",
    "max-autotune-no-cudagraphs",
    "reduce-overhead",
];

const TABS = [
    { id: "torch", label: "Torch编译", tip: "独立开关：启用或关闭 Torch 编译参数。" },
    { id: "sage", label: "Sage注意力", tip: "独立开关：启用或关闭 SageAttention 参数。" },
    { id: "fp16", label: "FP16累积", tip: "独立开关：启用或关闭 FP16 累积。" },
];

function ensureStyles() {
    if (document.getElementById("gjj-model-optimizer-style-v15")) return;
    const style = document.createElement("style");
    style.id = "gjj-model-optimizer-style-v15";
    style.textContent = `
.gjj-model-opt-tabs {
    box-sizing: border-box;
    width: 100%;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 7px;
    padding: 5px 9px 7px;
    pointer-events: auto;
    user-select: none;
}
.gjj-model-opt-tab {
    height: 30px;
    min-width: 0;
    border: 1px solid #536171;
    border-radius: 9px;
    background: #252a30;
    color: #c7d0dc;
    font: 700 12px/28px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    box-sizing: border-box;
}
.gjj-model-opt-tab:hover {
    border-color: #8bd8ff;
    color: #ffffff;
    background: #303845;
}
.gjj-model-opt-tab.active {
    border-color: #b8f2ff;
    background: #1684e8;
    color: #ffffff;
    box-shadow: 0 0 0 1px rgba(184, 242, 255, 0.6) inset, 0 0 10px rgba(77, 184, 255, 0.55);
}
`;
    document.head.appendChild(style);
}

function normalizeConfig(raw = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...(raw || {}) };
    cfg.enable_torch_compile = !!cfg.enable_torch_compile;
    cfg.compile_fullgraph = !!cfg.compile_fullgraph;
    cfg.compile_transformer_blocks_only = cfg.compile_transformer_blocks_only !== false;
    cfg.allow_sage_compile = !!cfg.allow_sage_compile;
    cfg.enable_fp16_accumulation = !!cfg.enable_fp16_accumulation;
    cfg.dynamo_cache_size_limit = Math.max(0, Math.min(1024, Number.parseInt(cfg.dynamo_cache_size_limit ?? 64, 10) || 0));
    if (!SAGE_MODES.includes(cfg.sage_attention)) cfg.sage_attention = "关闭";
    if (!COMPILE_MODES.includes(cfg.compile_mode)) cfg.compile_mode = "default";
    if (!["自动", "启用", "关闭"].includes(cfg.compile_dynamic)) cfg.compile_dynamic = "自动";
    if (!["inductor", "cudagraphs"].includes(cfg.compile_backend)) cfg.compile_backend = "inductor";
    return cfg;
}

function getConfig(node) {
    node.properties = node.properties || {};
    const old = node.properties.gjj_model_opt_config;
    const cur = node.properties[PROP_NAME];
    const cfg = normalizeConfig({ ...(old || {}), ...(cur || {}) });
    node.properties[PROP_NAME] = cfg;
    delete node.properties.gjj_model_opt_config;
    return cfg;
}

function saveConfig(node, cfg) {
    node.properties = node.properties || {};
    node.properties[PROP_NAME] = normalizeConfig(cfg);
}

function activeIdsFromConfig(cfg) {
    const ids = new Set();
    if (cfg.enable_torch_compile) ids.add("torch");
    if (cfg.sage_attention !== "关闭") ids.add("sage");
    if (cfg.enable_fp16_accumulation) ids.add("fp16");
    return ids;
}

function applyActiveIds(node, ids) {
    const cfg = getConfig(node);
    cfg.enable_torch_compile = ids.has("torch");
    cfg.enable_fp16_accumulation = ids.has("fp16");
    if (ids.has("sage")) {
        cfg.sage_attention = cfg.sage_attention === "关闭" ? "自动" : cfg.sage_attention;
    } else {
        cfg.sage_attention = "关闭";
    }
    saveConfig(node, cfg);
}

function toggleFeature(node, id) {
    const cfg = getConfig(node);
    let ids = activeIdsFromConfig(cfg);
    ids.has(id) ? ids.delete(id) : ids.add(id);
    applyActiveIds(node, ids);
}

function markParam(widget, tooltip) {
    widget.__gjj_model_optimizer_param = true;
    widget.__gjj_model_optimizer_ui = true;
    widget.serialize = false;
    if (tooltip) widget.tooltip = tooltip;
    // 防止切换后继承旧布局缓存
    widget.last_y = 0;
    widget.computedHeight = 0;
    widget.margin_top = 0;
    return widget;
}

function clearWidgetLayout(widget) {
    if (!widget) return;
    widget.hidden = true;
    widget.type = "hidden";
    widget.serialize = false;
    widget.computeSize = () => [0, 0];
    widget.draw = () => {};
    widget.label = "";
    widget.last_y = 0;
    widget.computedHeight = 0;
    widget.margin_top = 0;
    widget.size = [0, 0];
    if (widget.inputEl) {
        widget.inputEl.style.display = "none";
        widget.inputEl.style.height = "0";
        widget.inputEl.style.margin = "0";
        widget.inputEl.style.padding = "0";
    }
    if (widget.element) {
        widget.element.style.display = "none";
        widget.element.style.height = "0";
        widget.element.style.margin = "0";
        widget.element.style.padding = "0";
    }
    if (widget.widget) {
        widget.widget.style.display = "none";
        widget.widget.style.height = "0";
        widget.widget.style.margin = "0";
        widget.widget.style.padding = "0";
    }
}

function removeParamWidgets(node) {
    if (!Array.isArray(node.widgets)) return;
    for (const widget of node.widgets) {
        if (widget?.__gjj_model_optimizer_param) clearWidgetLayout(widget);
    }
    node.widgets = node.widgets.filter((w) => !w?.__gjj_model_optimizer_param);
    // 保留“参数分组”自绘 widget，不再删除重建，避免切换后从节点面板消失。
    for (const widget of node.widgets || []) {
        widget.last_y = 0;
        widget.computedHeight = 0;
        widget.margin_top = 0;
    }
}

function ensureTabWidget(node) {
    if (!Array.isArray(node.widgets)) node.widgets = [];
    let tab = node.widgets.find((w) => w?.__gjj_model_optimizer_tabs);
    if (!tab) tab = createTabWidget(node);
    // 保证选项卡永远排在参数前面、model 后面。
    const rest = node.widgets.filter((w) => w !== tab);
    node.widgets = [tab, ...rest];
    tab.hidden = false;
    tab.serialize = false;
    tab.computeSize = tab.computeSize || ((width) => [width || node.size?.[0] || 330, 44]);
    updateTabWidgetState(node);
    return tab;
}

function refresh(node) {
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

function getLocalPos(node, pos, event) {
    if (Array.isArray(pos)) return pos;
    if (event && typeof event.canvasX === "number" && typeof event.canvasY === "number") {
        return [event.canvasX - node.pos[0], event.canvasY - node.pos[1]];
    }
    if (event && typeof event.offsetX === "number" && typeof event.offsetY === "number" && app.canvas?.convertEventToCanvasOffset) {
        const p = app.canvas.convertEventToCanvasOffset(event);
        return [p[0] - node.pos[0], p[1] - node.pos[1]];
    }
    return [0, 0];
}

function roundedRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, r);
        return;
    }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
}

function createTabWidget(node) {
    ensureStyles();
    if (typeof node.addDOMWidget === "function") {
        const root = document.createElement("div");
        root.className = "gjj-model-opt-tabs";
        node.__gjj_model_optimizer_tab_rects = [];
        for (const ev of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
            root.addEventListener(ev, (event) => event.stopPropagation());
        }
        for (const tab of TABS) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "gjj-model-opt-tab";
            button.dataset.id = tab.id;
            button.title = tab.tip;
            button.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleFeature(node, tab.id);
                updateTabWidgetState(node);
                rebuild(node);
            });
            for (const ev of ["pointerdown", "mousedown", "mouseup", "dblclick", "keydown", "keyup", "wheel"]) {
                button.addEventListener(ev, (event) => event.stopPropagation());
            }
            root.appendChild(button);
        }
        const widget = node.addDOMWidget("参数分组", "DOM", root, {
            serialize: false,
            hideOnZoom: false,
        });
        widget.__gjj_model_optimizer_tabs = true;
        widget.__gjj_model_optimizer_ui = true;
        widget.serialize = false;
        widget.tooltip = "三个功能是独立开关，可同时启用；启用项会同时高亮显示。";
        widget.computeSize = (width) => [width || node.size?.[0] || 330, 44];
        widget.getHeight = () => 44;
        widget.element = root;
        updateTabWidgetState(node);
        return widget;
    }

    const widget = {
        name: "参数分组",
        type: "custom",
        __gjj_model_optimizer_tabs: true,
        __gjj_model_optimizer_ui: true,
        serialize: false,
        tooltip: "三个功能是独立开关，可同时启用；启用项会同时高亮显示。",
        computeSize(width) {
            return [width || node.size?.[0] || 330, 44];
        },
        draw(ctx, node, widgetWidth, y, widgetHeight) {
            const cfg = getConfig(node);
            const ids = activeIdsFromConfig(cfg);
            const padX = 10;
            const gap = 7;
            const h = 28;
            let x = padX;
            const yy = y + 8;
            const maxW = (widgetWidth || node.size?.[0] || 330) - padX * 2;
            const eachW = Math.max(86, Math.floor((maxW - gap * 2) / 3));
            node.__gjj_model_optimizer_tab_rects = [];
            ctx.save();
            ctx.font = "bold 12px sans-serif";
            ctx.textBaseline = "middle";
            for (const tab of TABS) {
                const active = ids.has(tab.id);

                // 强化选中态：亮蓝底、发光边框、✓ 前缀。未选中为暗色 + 号。
                if (active) {
                    ctx.save();
                    ctx.shadowColor = "rgba(77, 184, 255, 0.75)";
                    ctx.shadowBlur = 8;
                    roundedRect(ctx, x, yy, eachW, h, 9);
                    ctx.fillStyle = "#1684e8";
                    ctx.fill();
                    ctx.restore();

                    roundedRect(ctx, x, yy, eachW, h, 9);
                    ctx.strokeStyle = "#b8f2ff";
                    ctx.lineWidth = 2;
                    ctx.stroke();

                    // 顶部高光，避免和普通按钮混在一起。
                    roundedRect(ctx, x + 2, yy + 2, eachW - 4, Math.max(7, Math.floor(h / 3)), 7);
                    ctx.fillStyle = "rgba(255,255,255,0.20)";
                    ctx.fill();
                } else {
                    roundedRect(ctx, x, yy, eachW, h, 9);
                    ctx.fillStyle = "#252a30";
                    ctx.fill();
                    ctx.strokeStyle = "#536171";
                    ctx.lineWidth = 1;
                    ctx.stroke();
                }

                ctx.fillStyle = active ? "#ffffff" : "#c7d0dc";
                const text = `${active ? "✓" : "＋"} ${tab.label}`;
                const tw = ctx.measureText(text).width;
                ctx.fillText(text, x + Math.max(8, (eachW - tw) / 2), yy + h / 2 + 0.5);

                node.__gjj_model_optimizer_tab_rects.push({ id: tab.id, x, y: yy, w: eachW, h, tip: tab.tip });
                x += eachW + gap;
            }
            ctx.restore();
        },
        mouse(event, pos, node) {
            const p = getLocalPos(node, pos, event);
            const x = p[0];
            const y = p[1];
            for (const r of node.__gjj_model_optimizer_tab_rects || []) {
                if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
                    toggleFeature(node, r.id);
                    event?.preventDefault?.();
                    event?.stopPropagation?.();
                    rebuild(node);
                    return true;
                }
            }
            return false;
        },
    };
    if (node.addCustomWidget) node.addCustomWidget(widget);
    else {
        const w = node.addWidget("text", "参数分组", "", () => {}, {});
        Object.assign(w, widget);
    }
    return widget;
}

function updateTabWidgetState(node) {
    const cfg = getConfig(node);
    const ids = activeIdsFromConfig(cfg);
    const tab = node.widgets?.find((w) => w?.__gjj_model_optimizer_tabs);
    const root = tab?.element;
    if (!root?.querySelectorAll) return;
    for (const button of root.querySelectorAll(".gjj-model-opt-tab")) {
        const active = ids.has(button.dataset.id);
        button.classList.toggle("active", active);
        const meta = TABS.find((item) => item.id === button.dataset.id);
        button.textContent = `${active ? "✓" : "+"} ${meta?.label || button.dataset.id}`;
    }
}

function addBool(node, label, key, tooltip) {
    const cfg = getConfig(node);
    const w = node.addWidget("toggle", label, !!cfg[key], (v) => {
        const now = getConfig(node);
        now[key] = !!v;
        saveConfig(node, now);
        resizeAndRefresh(node);
    }, {});
    w.value = !!cfg[key];
    return markParam(w, tooltip);
}

function addCombo(node, label, key, values, tooltip) {
    const cfg = getConfig(node);
    const value = values.includes(cfg[key]) ? cfg[key] : values[0];
    cfg[key] = value;
    saveConfig(node, cfg);
    const w = node.addWidget("combo", label, value, (v) => {
        const now = getConfig(node);
        now[key] = v;
        saveConfig(node, now);
        resizeAndRefresh(node);
    }, { values });
    w.value = value;
    return markParam(w, tooltip);
}


function addInfo(node, label, text, tooltip) {
    const w = node.addWidget("text", label, text, () => {}, {});
    w.value = text;
    w.disabled = true;
    return markParam(w, tooltip);
}

function addInt(node, label, key, tooltip) {
    const cfg = getConfig(node);
    const value = Math.max(0, Math.min(1024, Number.parseInt(cfg[key] ?? 64, 10) || 0));
    cfg[key] = value;
    saveConfig(node, cfg);
    const w = node.addWidget("number", label, value, (v) => {
        const now = getConfig(node);
        now[key] = Math.max(0, Math.min(1024, Math.round(Number(v) || 0)));
        saveConfig(node, now);
        resizeAndRefresh(node);
    }, { min: 0, max: 1024, step: 1, precision: 0 });
    w.value = value;
    return markParam(w, tooltip);
}

function resizeAndRefresh(node) {
    requestAnimationFrame(() => {
        try {
            const width = Math.max(node.size?.[0] || 360, 360);
            // 用当前真实可见 widget 数量计算高度，避免 hidden/旧 last_y 留下大空白。
            const visibleWidgets = (node.widgets || []).filter((w) => !w?.hidden);
            let h = 82; // 标题、输入口和底部内边距
            for (const w of visibleWidgets) {
                let wh = 32;
                try {
                    const cs = w.computeSize?.(width);
                    if (Array.isArray(cs) && Number.isFinite(cs[1])) wh = Math.max(24, cs[1]);
                } catch (_) {}
                h += wh;
            }
            h = Math.max(132, Math.min(h, 460));
            if (node.setSize) node.setSize([width, h]);
            else node.size = [width, h];
            // 让 LiteGraph 重新从正常起点排布 widgets。
            node.widgets_start_y = undefined;
        } catch (err) {
            console.warn("[GJJ ModelOptimizer] 重新计算高度失败", err);
        }
        refresh(node);
    });
}

function rebuild(node) {
    if (node.__gjj_model_optimizer_rebuilding) return;
    node.__gjj_model_optimizer_rebuilding = true;
    try {
        removeParamWidgets(node);
        getConfig(node);
        ensureTabWidget(node);
        const cfg = getConfig(node);

        if (cfg.enable_torch_compile) {
            addCombo(node, "编译后端", "compile_backend", ["inductor", "cudagraphs"], "TorchCompile 编译后端：inductor 通用；cudagraphs 适合 CUDA 场景。");
            addBool(node, "完整图编译", "compile_fullgraph", "启用完整图编译。遇到图外操作时可能报错，不稳定时建议关闭。");
            addCombo(node, "编译模式", "compile_mode", COMPILE_MODES, "编译优化模式：default 平衡；max-autotune 更激进；reduce-overhead 减少运行开销。");
            addCombo(node, "动态形状", "compile_dynamic", ["自动", "启用", "关闭"], "动态形状模式：自动检测、强制启用或关闭。");
            addBool(node, "仅编译Transformer块", "compile_transformer_blocks_only", "只编译 Transformer 块，通常更快、更稳，也能减少首次编译时间。");
            addInt(node, "Dynamo缓存上限", "dynamo_cache_size_limit", "Torch Dynamo 缓存大小上限，数值越大越占内存。默认 64。");
        }

        if (getConfig(node).sage_attention !== "关闭") {
            addCombo(node, "SageAttention模式", "sage_attention", SAGE_MODES.filter((v) => v !== "关闭"), "SageAttention 加速模式，需要安装 sageattention 库。");
            addBool(node, "允许Sage参与编译", "allow_sage_compile", "允许 SageAttention 参与 TorchCompile。通常需要 sageattention 2.2.0 或更高版本。");
        }

        if (getConfig(node).enable_fp16_accumulation) {
            const onlyFp16 = getConfig(node).enable_fp16_accumulation && !getConfig(node).enable_torch_compile && getConfig(node).sage_attention === "关闭";
            if (onlyFp16) {
                addInfo(node, "FP16累积", "已启用", "顶部 FP16 累积已选中，执行时会启用 PyTorch FP16 累积。这个功能没有额外参数。");
            }
        }
    } finally {
        node.__gjj_model_optimizer_rebuilding = false;
    }
    resizeAndRefresh(node);
}

app.registerExtension({
    name: "GJJ.ModelOptimizer.NoOptionalCanvasTabs.v14",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = originalOnNodeCreated?.apply(this, arguments);
            this.properties = this.properties || {};
            getConfig(this);
            setTimeout(() => rebuild(this), 0);
            return r;
        };

        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = originalOnConfigure?.apply(this, arguments);
            this.properties = this.properties || {};
            getConfig(this);
            setTimeout(() => rebuild(this), 0);
            return r;
        };

        const originalOnMouseDown = nodeType.prototype.onMouseDown;
        nodeType.prototype.onMouseDown = function (event, pos, canvas) {
            for (const r of this.__gjj_model_optimizer_tab_rects || []) {
                const p = getLocalPos(this, pos, event);
                if (p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h) {
                    toggleFeature(this, r.id);
                    event?.preventDefault?.();
                    event?.stopPropagation?.();
                    rebuild(this);
                    return true;
                }
            }
            return originalOnMouseDown?.apply(this, arguments);
        };

        const originalOnSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (o) {
            const r = originalOnSerialize?.apply(this, arguments);
            o.properties = o.properties || {};
            o.properties[PROP_NAME] = { ...getConfig(this) };
            if (Array.isArray(o.widgets_values)) o.widgets_values = [];
            return r;
        };
    },
});
