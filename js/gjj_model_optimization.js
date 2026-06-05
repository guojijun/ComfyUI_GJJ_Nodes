import { app } from "/scripts/app.js";

const NODE_NAME = "GJJ_ModelOptimizer";
const PROP_NAME = "gjj_model_optimizer_config";
const INPUT_SLOTS = [
    { name: "模型", label: "高模", type: "MODEL", tooltip: "需要应用当前优化设置的主模型 MODEL。" },
    { name: "低模", label: "低模", type: "MODEL", tooltip: "可选。需要应用同一优化设置的第二路模型 MODEL；未连接时低模输出为空。" },
];
const OUTPUT_SLOTS = [
    { name: "高模", type: "MODEL", tooltip: "应用当前优化设置后的高模 MODEL。" },
    { name: "低模", type: "MODEL", tooltip: "应用当前优化设置后的低模 MODEL；未连接低模输入时输出为空。" },
];

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
    { id: "torch", label: "Torch编译", tip: "独立开关：启用或关闭 torch.compile。首次运行会编译，可能很慢；形状稳定、重复推理时更可能加速。" },
    { id: "sage", label: "Sage注意力", tip: "独立开关：启用 SageAttention 注意力覆盖。需要安装 sageattention 或 sageattn3；模式要匹配显卡、CUDA 和包版本。" },
    { id: "fp16", label: "FP16累积", tip: "独立开关：运行前设置 torch.backends.cuda.matmul.allow_fp16_accumulation。需要较新的 PyTorch；可改善部分 FP16 矩阵乘累计精度/性能路径。" },
];

const TOOLTIP = {
    compile_backend: "TorchCompile 编译后端。选项说明：inductor=PyTorch 默认通用编译器，兼容性最好；cudagraphs=CUDA Graph 后端，适合固定形状、重复推理，动态尺寸或频繁换分辨率时可能不稳。",
    compile_fullgraph: "完整图编译。开启=要求整段图尽量完整编译，潜在性能更高但更容易因图外操作失败；关闭=允许图断开，通常更稳。",
    compile_mode: "TorchCompile 编译模式。选项说明：default=默认平衡；reduce-overhead=减少运行开销，适合重复执行；max-autotune=更激进调优，首次编译更慢且更占资源；max-autotune-no-cudagraphs=激进调优但不启用 CUDA Graph，适合 CUDA Graph 不稳定时尝试。",
    compile_dynamic: "动态形状。选项说明：自动=交给 PyTorch 判断；启用=允许动态尺寸/批次，适合分辨率变化多；关闭=按静态形状优化，适合固定尺寸，通常更快更稳。",
    compile_transformer_blocks_only: "仅编译 Transformer 块。开启=只编译 double_blocks/single_blocks/layers/transformer_blocks 等主要模块，通常更稳且首次编译更短；关闭=尝试编译整个 diffusion_model，可能收益更大但失败概率更高。",
    dynamo_cache_size_limit: "Torch Dynamo 缓存上限，范围 0-1024。数值越大可缓存更多编译图，适合多尺寸/多分支工作流，但会占更多内存；0 表示几乎不保留额外缓存，默认 64。",
    sage_attention: "SageAttention 模式。选项说明：自动=使用 sageattention.sageattn；int8_fp16_cuda=CUDA int8 QK + fp16 PV；int8_fp16_triton=Triton int8 QK + fp16 PV；int8_fp8_cuda=CUDA int8 QK + fp8 PV 累积；int8_fp8_cuda_plus=fp8 后端 plus 累积策略；sageattn3=使用 sageattn3_blackwell；sageattn3分块均值=sageattn3 per_block_mean 模式。需要对应运行库与显卡支持。",
    allow_sage_compile: "允许 SageAttention 参与 TorchCompile。关闭=对 Sage 函数加 torch.compiler.disable，更稳；开启=允许一起编译，可能更快，但需要 sageattention/sageattn3 与当前 PyTorch 版本兼容。",
    fp16_info: "FP16 累积已启用。执行时会设置 torch.backends.cuda.matmul.allow_fp16_accumulation=True；如果当前 PyTorch 不支持，会在后端给出警告。",
};

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

function applyInputSlot(input, def) {
    if (!input || !def) return;
    input.name = def.name;
    input.type = def.type;
    input.label = def.label;
    input.localized_name = def.label;
    input.display_name = def.label;
    input.tooltip = def.tooltip;
}

function applyOutputSlot(output, def) {
    if (!output || !def) return;
    output.name = def.name;
    output.type = def.type;
    output.label = def.name;
    output.localized_name = def.name;
    output.display_name = def.name;
    output.tooltip = def.tooltip;
}

function stabilizeIO(node) {
    if (!node) return;
    if (!Array.isArray(node.inputs)) node.inputs = [];
    if (!Array.isArray(node.outputs)) node.outputs = [];

    let highInput = node.inputs.find((input) => String(input?.name || "") === "模型")
        || node.inputs.find((input) => String(input?.name || input?.label || input?.localized_name || "") === "高模")
        || node.inputs[0];
    if (!highInput) {
        node.addInput?.(INPUT_SLOTS[0].name, INPUT_SLOTS[0].type);
        highInput = node.inputs[node.inputs.length - 1];
    }
    applyInputSlot(highInput, INPUT_SLOTS[0]);

    let lowInput = node.inputs.find((input) => String(input?.name || input?.label || input?.localized_name || "") === "低模");
    if (!lowInput) {
        node.addInput?.(INPUT_SLOTS[1].name, INPUT_SLOTS[1].type);
        lowInput = node.inputs[node.inputs.length - 1];
    }
    applyInputSlot(lowInput, INPUT_SLOTS[1]);

    const orderedInputs = [
        highInput,
        lowInput,
        ...node.inputs.filter((input) => input !== highInput && input !== lowInput),
    ];
    node.inputs = orderedInputs;

    for (let index = 0; index < OUTPUT_SLOTS.length; index++) {
        if (!node.outputs[index]) node.addOutput?.(OUTPUT_SLOTS[index].name, OUTPUT_SLOTS[index].type);
        applyOutputSlot(node.outputs[index], OUTPUT_SLOTS[index]);
    }
    refresh(node);
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
            addCombo(node, "编译后端", "compile_backend", ["inductor", "cudagraphs"], TOOLTIP.compile_backend);
            addBool(node, "完整图编译", "compile_fullgraph", TOOLTIP.compile_fullgraph);
            addCombo(node, "编译模式", "compile_mode", COMPILE_MODES, TOOLTIP.compile_mode);
            addCombo(node, "动态形状", "compile_dynamic", ["自动", "启用", "关闭"], TOOLTIP.compile_dynamic);
            addBool(node, "仅编译Transformer块", "compile_transformer_blocks_only", TOOLTIP.compile_transformer_blocks_only);
            addInt(node, "Dynamo缓存上限", "dynamo_cache_size_limit", TOOLTIP.dynamo_cache_size_limit);
        }

        if (getConfig(node).sage_attention !== "关闭") {
            addCombo(node, "SageAttention模式", "sage_attention", SAGE_MODES.filter((v) => v !== "关闭"), TOOLTIP.sage_attention);
            addBool(node, "允许Sage参与编译", "allow_sage_compile", TOOLTIP.allow_sage_compile);
        }

        if (getConfig(node).enable_fp16_accumulation) {
            const onlyFp16 = getConfig(node).enable_fp16_accumulation && !getConfig(node).enable_torch_compile && getConfig(node).sage_attention === "关闭";
            if (onlyFp16) {
                addInfo(node, "FP16累积", "已启用", TOOLTIP.fp16_info);
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
            stabilizeIO(this);
            getConfig(this);
            setTimeout(() => rebuild(this), 0);
            return r;
        };

        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = originalOnConfigure?.apply(this, arguments);
            this.properties = this.properties || {};
            stabilizeIO(this);
            getConfig(this);
            setTimeout(() => {
                stabilizeIO(this);
                rebuild(this);
            }, 0);
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
