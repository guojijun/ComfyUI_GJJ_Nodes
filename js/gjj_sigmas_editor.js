import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_SigmasEditor"]);
const MIN_NODE_WIDTH = 420;
const CHART_HEIGHT = 220;
const CHART_PADDING = { top: 16, right: 18, bottom: 22, left: 40 };
const JSON_OUTPUT = { name: "Sigmas JSON", type: "STRING" };

const CURVE_MODES = [
    { value: "linear", label: "📏", tooltip: "线性曲线" },
    { value: "smooth", label: "〰️", tooltip: "平滑曲线" },
    { value: "step", label: "🪜", tooltip: "阶梯曲线" },
];

const PRESET_OPTIONS = [
    { value: "默认1", label: "1️⃣", tooltip: "预设模板 1" },
    { value: "默认2", label: "2️⃣", tooltip: "预设模板 2" },
    { value: "自定义", label: "🔢", tooltip: "自定义 Sigmas" },
];

const HIDDEN_WIDGET_NAMES = new Set(["sigmas_data", "curve_mode", "preset"]);
const DEFAULT_NODE_HEIGHT = CHART_HEIGHT + 42;

function hideOriginalPythonWidgets(node) {
    const widgetsToHide = ["sigmas_data", "curve_mode", "preset"];

    if (node.widgets) {
        node.widgets.forEach((widget) => {
            if (widgetsToHide.includes(widget.name)) {
                // 按照标准方法隐藏 Widget
                widget.type = "hidden";
                widget.hidden = true;
                widget.serialize = true;
                widget.computeSize = () => [0, 0];
                widget.draw = () => {};
                widget.label = "";

                // 重置关键布局属性
                widget.last_y = 0;              // ⭐ 最关键
                widget.computedHeight = 0;
                widget.margin_top = 0;
                widget.size = [0, 0];

                // 隐藏 DOM 元素
                if (widget.inputEl) {
                    widget.inputEl.style.display = "none";
                    widget.inputEl.style.height = "0";
                    widget.inputEl.style.margin = "0";
                    widget.inputEl.style.padding = "0";
                }
                if (widget.element) {
                    widget.element.style.display = "none";
                    widget.element.style.height = "0";
                }
                if (widget.widget) {
                    widget.widget.style.display = "none";
                    widget.widget.style.height = "0";
                }
            }
        });
    }

    // ⭐ 删除隐藏参数的输入插槽（左侧小圆点）
    if (node.inputs) {
        for (let i = node.inputs.length - 1; i >= 0; i--) {
            const input = node.inputs[i];
            const inputName = String(input?.name || "");
            if (widgetsToHide.includes(inputName)) {
                try { node.disconnectInput?.(i); } catch (_) { /* ignore */ }
                if (typeof node.removeInput === "function") {
                    node.removeInput(i);
                } else if (node.inputs.splice) {
                    node.inputs.splice(i, 1);
                }
            }
        }
    }
}

function preserveNodeSize(node) {
    node.properties ||= {};
    const savedWidth = Number(node?.size?.[0] || 0);
    const shouldCompactOnce = !node.properties.gjj_sigmas_compacted_layout_v2;
    const currentWidth = shouldCompactOnce ? MIN_NODE_WIDTH : Math.max(MIN_NODE_WIDTH, savedWidth);
    node.size ||= [currentWidth, DEFAULT_NODE_HEIGHT];
    node.size[0] = currentWidth;
    node.min_width = currentWidth;
    node.minWidth = currentWidth;
    const currentHeight = shouldCompactOnce ? DEFAULT_NODE_HEIGHT : Math.max(Number(node.size?.[1] || 0), DEFAULT_NODE_HEIGHT);
    node.properties.gjj_sigmas_compacted_layout_v2 = true;
    node.setSize?.([currentWidth, currentHeight]);
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

function findJsonOutputIndex(node) {
    return (node.outputs || []).findIndex((output) => String(output?.name || "") === JSON_OUTPUT.name);
}

function jsonOutputHasLinks(node) {
    const index = findJsonOutputIndex(node);
    const output = index >= 0 ? node.outputs[index] : null;
    return Array.isArray(output?.links) && output.links.length > 0;
}

function setJsonOutputVisible(node, visible) {
    node.properties ||= {};
    const currentlyVisible = findJsonOutputIndex(node) >= 0;
    const shouldKeepForLinks = jsonOutputHasLinks(node);

    if (visible && !currentlyVisible) {
        node.addOutput?.(JSON_OUTPUT.name, JSON_OUTPUT.type);
    } else if (!visible && currentlyVisible && !shouldKeepForLinks) {
        const index = findJsonOutputIndex(node);
        if (index >= 0) {
            if (typeof node.removeOutput === "function") {
                node.removeOutput(index);
            } else {
                node.outputs.splice(index, 1);
            }
        }
    }

    node.properties.gjj_sigmas_show_json_output = Boolean(visible || shouldKeepForLinks);
    node.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

function syncJsonOutputVisibility(node) {
    const showJson = Boolean(node.properties?.gjj_sigmas_show_json_output || jsonOutputHasLinks(node));
    setJsonOutputVisible(node, showJson);
}

function safeParseArray(text, fallback = []) {
    try {
        const value = JSON.parse(String(text || "[]"));
        return Array.isArray(value) ? value.map(v => parseFloat(v)).filter(v => !isNaN(v)) : fallback;
    } catch {
        return fallback;
    }
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function ensureEditor(node) {
    if (node.__gjjSigmasEditor) return node.__gjjSigmasEditor;

    // 获取 widgets 引用
    const sigmasWidget = node.widgets?.find((w) => w.name === "sigmas_data");
    const curveWidget = node.widgets?.find((w) => w.name === "curve_mode");
    const presetWidget = node.widgets?.find((w) => w.name === "preset");

    const root = document.createElement("div");
    root.style.cssText = "display:flex;flex-direction:column;gap:0;height:100%;width:100%;box-sizing:border-box;padding:0;";

    const toolbar = document.createElement("div");
    toolbar.style.cssText = "display:flex;gap:0;align-items:center;flex-wrap:wrap;margin:0;padding:0;";
    root.appendChild(toolbar);

    function createIconButton(label, tooltip) {
        const button = document.createElement("button");
        button.textContent = label;
        button.title = tooltip;
        button.style.cssText = "width:28px;height:24px;display:inline-flex;align-items:center;justify-content:center;padding:0;margin:0;border-radius:5px;border:1px solid #41535b;background:#182127;color:#dce7e2;cursor:pointer;font-size:13px;line-height:1;transition:all 0.15s;";
        button.addEventListener("mouseenter", () => { button.style.background = "#253038"; button.style.borderColor = "#4d636e"; });
        button.addEventListener("mouseleave", () => { button.style.background = "#182127"; button.style.borderColor = "#41535b"; });
        button.addEventListener("mousedown", () => { button.style.background = "#0f1519"; button.style.transform = "scale(0.95)"; });
        button.addEventListener("mouseup", () => { button.style.background = "#253038"; button.style.transform = "scale(1)"; });
        return button;
    }

    const wrap = document.createElement("div");
    wrap.title = "点击图表添加点，拖拽调整位置，右键删除";
    wrap.style.cssText = `position:relative;height:${CHART_HEIGHT}px;width:100%;box-sizing:border-box;border:1px solid #34444c;border-radius:8px;background:#0b1013;overflow:hidden;touch-action:none;margin:0;padding:0;`;
    root.appendChild(wrap);

    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;width:100%;height:100%;background:#0f1519;user-select:none;margin:0;padding:0;";
    wrap.appendChild(canvas);

    const curveButtonsContainer = document.createElement("div");
    curveButtonsContainer.style.cssText = "display:flex;gap:0;margin:0;padding:0;";
    toolbar.appendChild(curveButtonsContainer);

    const presetButtonsContainer = document.createElement("div");
    presetButtonsContainer.style.cssText = "display:flex;gap:0;margin:0;padding:0;";
    toolbar.appendChild(presetButtonsContainer);

    const addButton = createIconButton("➕", "添加一个 Sigma 点");
    toolbar.appendChild(addButton);

    const clearButton = createIconButton("🧹", "清空为起点和终点");
    toolbar.appendChild(clearButton);

    const jsonButton = createIconButton("📄", "显示或收起 Sigmas JSON 输出口");
    toolbar.appendChild(jsonButton);

    const editor = {
        canvas,
        wrap,
        sigmasWidget,
        curveWidget,
        presetWidget,
        sigmas: [1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.881203, 0.863321, 0.841251, 0.820089, 0.655, 0.381875, 0.0],
        draggingIndex: -1,
        hoveredIndex: -1,
        currentCurveMode: "smooth",
        currentPreset: "默认1",
    };

    function createModeButtons(container, options, getCurrent, setCurrent, onSelect) {
        const buttons = [];

        options.forEach((opt) => {
            const btn = document.createElement("button");
            btn.textContent = opt.label;
            btn.title = opt.tooltip || opt.value;
            btn.style.cssText = "width:28px;height:24px;display:inline-flex;align-items:center;justify-content:center;padding:0;margin:0;border-radius:5px;border:1px solid #41535b;background:#182127;color:#dce7e2;cursor:pointer;font-size:13px;line-height:1;transition:all 0.2s;";

            const updateBtnStyle = () => {
                if (btn.dataset.value === getCurrent()) {
                    btn.style.background = "#2a3a42";
                    btn.style.borderColor = "#38c8ff";
                    btn.style.color = "#38c8ff";
                } else {
                    btn.style.background = "#182127";
                    btn.style.borderColor = "#41535b";
                    btn.style.color = "#dce7e2";
                }
            };

            btn.dataset.value = opt.value;
            buttons.push({ btn, updateBtnStyle });
            updateBtnStyle();

            btn.onclick = (e) => {
                e.stopPropagation();
                setCurrent(opt.value);
                buttons.forEach((b) => b.updateBtnStyle());
                onSelect?.(opt.value);
                draw();
            };

            container.appendChild(btn);
        });

        return buttons;
    }

    createModeButtons(
        curveButtonsContainer,
        CURVE_MODES,
        () => editor.currentCurveMode,
        (v) => {
            editor.currentCurveMode = v;
            writeBack();
        },
        null
    );

    const presetButtons = createModeButtons(
        presetButtonsContainer,
        PRESET_OPTIONS,
        () => editor.currentPreset,
        (v) => {
            editor.currentPreset = v;
        },
        (v) => {
            if (v !== "自定义") {
                if (v === "默认1") {
                    editor.sigmas = [1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.881203, 0.863321, 0.841251, 0.820089, 0.655, 0.381875, 0.0];
                } else if (v === "默认2") {
                    editor.sigmas = [1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0];
                }
                writeBack();
                node.dirty = true;
                if (typeof app.queuePrompt === "function") {
                    app.queuePrompt();
                } else if (typeof app.graph?.queueNodeExecution === "function") {
                    app.graph.queueNodeExecution(node);
                } else if (typeof app.graph?.requestExecution === "function") {
                    app.graph.requestExecution();
                }
            } else {
                editor.sigmas = [0.85, 0.7250, 0.4219, 0.0];
                writeBack();
            }
        }
    );

    function markCustomPresetForEdit() {
        editor.currentPreset = "自定义";
        presetButtons.forEach((b) => b.updateBtnStyle());
    }

    function updateJsonButton() {
        const enabled = Boolean(node.properties?.gjj_sigmas_show_json_output || jsonOutputHasLinks(node));
        jsonButton.style.background = enabled ? "#2a3a42" : "#182127";
        jsonButton.style.borderColor = enabled ? "#38c8ff" : "#41535b";
        jsonButton.style.color = enabled ? "#38c8ff" : "#dce7e2";
    }

    function getChartArea() {
        const rect = wrap.getBoundingClientRect();
        const scaleX = wrap.clientWidth / rect.width;
        const scaleY = wrap.clientHeight / rect.height;
        return {
            x: CHART_PADDING.left * scaleX,
            y: CHART_PADDING.top * scaleY,
            width: Math.max(1, wrap.clientWidth - CHART_PADDING.left * scaleX - CHART_PADDING.right * scaleX),
            height: Math.max(1, wrap.clientHeight - CHART_PADDING.top * scaleY - CHART_PADDING.bottom * scaleY),
        };
    }

    function toChartPoint(event) {
        const rect = wrap.getBoundingClientRect();
        const scaleX = wrap.clientWidth / rect.width;
        const scaleY = wrap.clientHeight / rect.height;
        const area = getChartArea();
        const localX = (event.clientX - rect.left) * scaleX - area.x;
        const localY = (event.clientY - rect.top) * scaleY - area.y;

        if (localX < 0 || localX > area.width || localY < 0 || localY > area.height) return null;

        return { t: localX / area.width, value: 1.0 - (localY / area.height) };
    }

    function findNearestPoint(t, threshold = 0.05) {
        const points = editor.sigmas;
        if (!points.length) return -1;

        let nearestIndex = -1;
        let minDist = threshold;

        for (let i = 0; i < points.length; i++) {
            const pt = i / (points.length - 1 || 1);
            const dist = Math.abs(pt - t);
            if (dist < minDist) {
                minDist = dist;
                nearestIndex = i;
            }
        }

        return nearestIndex;
    }

    function syncFromWidgets() {
        if (editor.sigmasWidget) {
            editor.sigmas = safeParseArray(editor.sigmasWidget.value, [1.0, 0.0]);
        }
        if (editor.curveWidget) {
            editor.currentCurveMode = editor.curveWidget.value || "smooth";
        }
        if (editor.presetWidget) {
            editor.currentPreset = editor.presetWidget.value || "默认1";
        }
        draw();
    }

    function writeBack() {
        if (editor.sigmasWidget) {
            editor.sigmasWidget.value = JSON.stringify(editor.sigmas);
            editor.sigmasWidget.callback?.(editor.sigmasWidget.value);
        }
        if (editor.curveWidget) {
            editor.curveWidget.value = editor.currentCurveMode;
            editor.curveWidget.callback?.(editor.currentCurveMode);
        }
        if (editor.presetWidget) {
            editor.presetWidget.value = editor.currentPreset;
            editor.presetWidget.callback?.(editor.currentPreset);
        }
        draw();
    }

    function draw() {
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const cssWidth = Math.max(1, wrap.clientWidth || 1);
        const cssHeight = Math.max(1, wrap.clientHeight || 1);
        const realWidth = Math.round(cssWidth * dpr);
        const realHeight = Math.round(cssHeight * dpr);

        if (canvas.width !== realWidth || canvas.height !== realHeight) {
            canvas.width = realWidth;
            canvas.height = realHeight;
        }

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssWidth, cssHeight);

        ctx.fillStyle = "#0f1519";
        ctx.fillRect(0, 0, cssWidth, cssHeight);

        const area = getChartArea();

        ctx.fillStyle = "#141b1f";
        ctx.fillRect(area.x, area.y, area.width, area.height);

        ctx.strokeStyle = "#34444c";
        ctx.lineWidth = 1;
        ctx.strokeRect(area.x, area.y, area.width, area.height);

        drawGrid(ctx, area);
        drawCurve(ctx, area);
        drawPoints(ctx, area);
    }

    function drawGrid(ctx, area) {
        ctx.save();
        ctx.strokeStyle = "#2a3a42";
        ctx.lineWidth = 1;

        for (let i = 0; i <= 5; i++) {
            const y = area.y + (i / 5) * area.height;
            ctx.beginPath();
            ctx.moveTo(area.x, y);
            ctx.lineTo(area.x + area.width, y);
            ctx.stroke();

            ctx.fillStyle = "#6b7b85";
            ctx.font = "11px sans-serif";
            ctx.textAlign = "right";
            ctx.fillText((1.0 - i / 5).toFixed(1), area.x - 8, y + 4);
        }

        for (let i = 0; i <= 5; i++) {
            const x = area.x + (i / 5) * area.width;
            ctx.beginPath();
            ctx.moveTo(x, area.y);
            ctx.lineTo(x, area.y + area.height);
            ctx.stroke();

            ctx.fillStyle = "#6b7b85";
            ctx.font = "11px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText((i / 5).toFixed(1), x, area.y + area.height + 20);
        }

        ctx.restore();
    }

    function drawCurve(ctx, area) {
        const points = editor.sigmas;
        if (points.length < 2) return;

        ctx.save();
        ctx.strokeStyle = "#38c8ff";
        ctx.lineWidth = 2;
        ctx.beginPath();

        const mode = editor.currentCurveMode;

        if (mode === "step") {
            for (let i = 0; i < points.length; i++) {
                const t = i / (points.length - 1);
                const x = area.x + t * area.width;
                const y = area.y + (1 - points[i]) * area.height;
                if (i === 0) ctx.moveTo(x, y);
                else {
                    const prevX = area.x + ((i - 1) / (points.length - 1)) * area.width;
                    ctx.lineTo(prevX, y);
                    ctx.lineTo(x, y);
                }
            }
        } else if (mode === "smooth") {
            const samples = 100;
            for (let i = 0; i <= samples; i++) {
                const t = i / samples;
                const value = clampedCatmullRomInterpolation(points, t);
                const x = area.x + t * area.width;
                const y = area.y + (1 - value) * area.height;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
        } else {
            for (let i = 0; i < points.length; i++) {
                const t = i / (points.length - 1);
                const x = area.x + t * area.width;
                const y = area.y + (1 - points[i]) * area.height;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
        }

        ctx.stroke();
        ctx.restore();
    }

    function clampedCatmullRomInterpolation(points, t) {
        const n = points.length;
        if (n === 1) return points[0];

        const clampedT = clamp(t, 0, 1);
        const index = clampedT * (n - 1);
        const i = Math.floor(index);
        const frac = index - i;

        let p0, p1, p2, p3;

        if (i === 0) {
            p0 = points[0]; p1 = points[0]; p2 = points[1]; p3 = points[Math.min(2, n - 1)];
        } else if (i >= n - 1) {
            p0 = points[Math.max(0, n - 3)]; p1 = points[n - 2]; p2 = points[n - 1]; p3 = points[n - 1];
        } else {
            p0 = points[i - 1]; p1 = points[i]; p2 = points[i + 1]; p3 = points[Math.min(i + 2, n - 1)];
        }

        const t2 = frac * frac;
        const t3 = t2 * frac;

        const rawValue = 0.5 * ((-p0 + 3 * p1 - 3 * p2 + p3) * t3 + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + p2) * frac + 2 * p1);

        return clamp(rawValue, 0, 1);
    }

    function drawPoints(ctx, area) {
        const points = editor.sigmas;

        for (let i = 0; i < points.length; i++) {
            const t = i / (points.length - 1);
            const x = area.x + t * area.width;
            const y = area.y + (1 - points[i]) * area.height;
            const isHovered = i === editor.hoveredIndex;
            const isDragging = i === editor.draggingIndex;
            const radius = isHovered || isDragging ? 10 : 7;

            ctx.save();

            if (isDragging) {
                ctx.shadowColor = "#38c8ff";
                ctx.shadowBlur = 15;
            }

            ctx.fillStyle = "#1a252b";
            ctx.strokeStyle = isHovered || isDragging ? "#79dcff" : "#38c8ff";
            ctx.lineWidth = isHovered || isDragging ? 3 : 2;

            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = "#38c8ff";
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fill();

            ctx.font = "bold 11px sans-serif";
            ctx.fillStyle = "#9eb3ab";
            ctx.textAlign = "center";
            ctx.fillText(points[i].toFixed(4), x, y - radius - 8);

            ctx.restore();
        }
    }

    addButton.onclick = () => {
        const newIndex = Math.floor(editor.sigmas.length / 2);
        const leftVal = editor.sigmas[Math.max(0, newIndex - 1)] || 1.0;
        const rightVal = editor.sigmas[Math.min(editor.sigmas.length - 1, newIndex)] || 0.0;
        editor.sigmas.splice(newIndex, 0, (leftVal + rightVal) / 2);
        markCustomPresetForEdit();
        writeBack();
    };

    clearButton.onclick = () => {
        editor.sigmas = [1.0, 0.0];
        markCustomPresetForEdit();
        writeBack();
    };

    jsonButton.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const nextVisible = !(node.properties?.gjj_sigmas_show_json_output || jsonOutputHasLinks(node));
        setJsonOutputVisible(node, nextVisible);
        updateJsonButton();
    };

    wrap.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const point = toChartPoint(event);
        if (!point) return;
        const index = findNearestPoint(point.t, 0.1);
        if (index >= 0 && editor.sigmas.length > 2) {
            editor.sigmas.splice(index, 1);
            markCustomPresetForEdit();
            writeBack();
        }
    });

    wrap.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        wrap.setPointerCapture?.(event.pointerId);

        const point = toChartPoint(event);
        if (!point) return;

        const index = findNearestPoint(point.t, 0.08);

        if (index >= 0) {
            editor.draggingIndex = index;
            draw();
        } else {
            const newIndex = Math.floor(point.t * (editor.sigmas.length - 1)) + 1;
            editor.sigmas.splice(newIndex, 0, clamp(point.value, 0, 1));
            editor.draggingIndex = newIndex;
            markCustomPresetForEdit();
            writeBack();
        }
    });

    wrap.addEventListener("pointermove", (event) => {
        if (editor.draggingIndex >= 0) {
            const point = toChartPoint(event);
            if (point) {
                editor.sigmas[editor.draggingIndex] = clamp(point.value, 0, 1);
                markCustomPresetForEdit();
                writeBack();
            }
        } else {
            const point = toChartPoint(event);
            editor.hoveredIndex = point ? findNearestPoint(point.t, 0.08) : -1;
            draw();
        }
    });

    wrap.addEventListener("pointerup", () => {
        editor.draggingIndex = -1;
        draw();
    });

    wrap.addEventListener("pointerleave", () => {
        editor.hoveredIndex = -1;
        if (editor.draggingIndex >= 0) editor.draggingIndex = -1;
        draw();
    });

    const widget = node.addDOMWidget("gjj_sigmas_editor", "gjj_sigmas_editor", root, {
        hideOnZoom: false,
        getHeight: () => CHART_HEIGHT + 26,
        getMinHeight: () => CHART_HEIGHT + 26,
        getMaxHeight: () => CHART_HEIGHT + 26,
    });
    widget.computeSize = (width) => [Math.max(MIN_NODE_WIDTH, Number(width || 0)), CHART_HEIGHT + 26];

    node.__gjjSigmasEditor = { widget, editor, draw, syncFromWidgets };
    syncFromWidgets();
    updateJsonButton();
    return node.__gjjSigmasEditor;
}

function afterNodeReady(node) {
    hideOriginalPythonWidgets(node);

    // ⭐ 额外的防护：再次删除输入插槽（确保彻底删除）
    const widgetsToHide = ["sigmas_data", "curve_mode", "preset"];
    if (node.inputs) {
        for (let i = node.inputs.length - 1; i >= 0; i--) {
            const input = node.inputs[i];
            const inputName = String(input?.name || "");
            if (widgetsToHide.includes(inputName)) {
                try { node.disconnectInput?.(i); } catch (_) { /* ignore */ }
                if (typeof node.removeInput === "function") {
                    node.removeInput(i);
                } else if (node.inputs.splice) {
                    node.inputs.splice(i, 1);
                }
            }
        }
    }

    syncJsonOutputVisibility(node);
    const view = ensureEditor(node);
    view.syncFromWidgets();
    preserveNodeSize(node);
}

app.registerExtension({
    name: "GJJ.SigmasEditor",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!TARGET_NODES.has(String(nodeData?.name || ""))) return;

        // 防护层1: Hook addWidget
        const originalAddWidget = nodeType.prototype.addWidget;
        if (originalAddWidget) {
            nodeType.prototype.addWidget = function(...args) {
                const widget = originalAddWidget.apply(this, args);
                const widgetsToHide = ["sigmas_data", "curve_mode", "preset"];
                if (widget && widgetsToHide.includes(widget.name)) {
                    hideOriginalPythonWidgets(this);
                    setTimeout(() => {
                        if (widget.inputEl) widget.inputEl.style.display = "none";
                        if (widget.element) widget.element.style.display = "none";
                        if (widget.widget) widget.widget.style.display = "none";
                    }, 0);
                }
                return widget;
            };
        }

        // 防护层2: onNodeCreated
        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalOnNodeCreated?.apply(this, arguments);
            afterNodeReady(this);
            return result;
        };

        // 防护层3: onConfigure
        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const result = originalOnConfigure?.apply(this, arguments);
            afterNodeReady(this);
            return result;
        };

        const originalOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message, outputs) {
            const result = originalOnExecuted?.apply(this, arguments);
            const uiData = message?.ui || message;
            const sigmasData = uiData?.sigmas?.[0] || outputs?.[0];
            if (sigmasData && Array.isArray(sigmasData)) {
                const view = ensureEditor(this);
                view.editor.sigmas = sigmasData;
                view.draw();
            }
            return result;
        };

        const originalOnResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (...args) {
            const result = originalOnResize?.apply(this, arguments);
            ensureEditor(this).draw();
            return result;
        };
    },
    setup() {
        for (const node of app.graph?._nodes || []) {
            if (TARGET_NODES.has(String(node.comfyClass || node.type || ""))) {
                afterNodeReady(node);
            }
        }
    },
});
