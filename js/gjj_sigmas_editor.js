import { app } from "/scripts/app.js";

const TARGET_NODES = new Set(["GJJ_SigmasEditor"]);
const MIN_NODE_WIDTH = 520;
const CHART_HEIGHT = 280;
const CHART_PADDING = { top: 30, right: 30, bottom: 40, left: 50 };

const CURVE_MODES = [
    { value: "linear", label: "线性" },
    { value: "smooth", label: "平滑" },
    { value: "step", label: "阶梯" },
];

const PRESET_OPTIONS = [
    { value: "默认1", label: "默认1" },
    { value: "默认2", label: "默认2" },
    { value: "自定义", label: "自定义" },
];

function hideWidget(widget) {
    if (!widget || widget.__gjjSigmasHidden) return;
    widget.__gjjSigmasHidden = { type: widget.type, computeSize: widget.computeSize };
    widget.type = "converted-widget";
    widget.computeSize = () => [0, -4];
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

    const sigmasWidget = node.widgets?.find((w) => w.name === "sigmas_data");
    const curveWidget = node.widgets?.find((w) => w.name === "curve_mode");
    const presetWidget = node.widgets?.find((w) => w.name === "preset");

    const root = document.createElement("div");
    root.style.cssText = "display:flex;flex-direction:column;gap:8px;height:100%;width:100%;box-sizing:border-box;padding:2px 0;";

    const toolbar = document.createElement("div");
    toolbar.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
    root.appendChild(toolbar);

    const hint = document.createElement("span");
    hint.textContent = "点击图表添加点，拖拽调整位置，右键删除";
    hint.style.cssText = "font-size:12px;color:#c9d6d0;flex:1 1 auto;";
    toolbar.appendChild(hint);

    const addButton = document.createElement("button");
    addButton.textContent = "+ 添加点";
    addButton.style.cssText = "padding:4px 10px;border-radius:999px;border:1px solid #41535b;background:#182127;color:#dce7e2;cursor:pointer;font-size:12px;";
    toolbar.appendChild(addButton);

    const clearButton = document.createElement("button");
    clearButton.textContent = "清空";
    clearButton.style.cssText = "padding:4px 10px;border-radius:999px;border:1px solid #41535b;background:#182127;color:#dce7e2;cursor:pointer;font-size:12px;";
    toolbar.appendChild(clearButton);

    const wrap = document.createElement("div");
    wrap.style.cssText = `position:relative;height:${CHART_HEIGHT}px;width:100%;box-sizing:border-box;border:1px solid #34444c;border-radius:12px;background:#0b1013;overflow:hidden;touch-action:none;`;
    root.appendChild(wrap);

    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;width:100%;height:100%;background:#0f1519;user-select:none;";
    wrap.appendChild(canvas);

    const controlsRow = document.createElement("div");
    controlsRow.style.cssText = "display:flex;gap:12px;align-items:center;flex-wrap:wrap;";
    root.appendChild(controlsRow);

    const curveModeLabel = document.createElement("span");
    curveModeLabel.textContent = "曲线方式:";
    curveModeLabel.style.cssText = "font-size:12px;color:#9eb3ab;";
    controlsRow.appendChild(curveModeLabel);

    const curveButtonsContainer = document.createElement("div");
    curveButtonsContainer.style.cssText = "display:flex;gap:4px;";
    controlsRow.appendChild(curveButtonsContainer);

    const presetLabel = document.createElement("span");
    presetLabel.textContent = "预设模板:";
    presetLabel.style.cssText = "font-size:12px;color:#9eb3ab;margin-left:12px;";
    controlsRow.appendChild(presetLabel);

    const presetButtonsContainer = document.createElement("div");
    presetButtonsContainer.style.cssText = "display:flex;gap:4px;";
    controlsRow.appendChild(presetButtonsContainer);

    const editor = {
        canvas,
        wrap,
        sigmasWidget,
        curveWidget,
        presetWidget,
        sigmas: safeParseArray(sigmasWidget?.value, [1.0, 0.5, 0.0]),
        draggingIndex: -1,
        hoveredIndex: -1,
        currentCurveMode: curveWidget?.value || "smooth",
        currentPreset: presetWidget?.value || "默认1",
    };

    function createModeButtons(container, options, getCurrent, setCurrent, onSelect) {
        options.forEach((opt) => {
            const btn = document.createElement("button");
            btn.textContent = opt.label;
            btn.style.cssText = "padding:4px 10px;border-radius:6px;border:1px solid #41535b;background:#182127;color:#dce7e2;cursor:pointer;font-size:12px;transition:all 0.2s;";
            
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
            updateBtnStyle();
            
            btn.onclick = (e) => {
                e.stopPropagation();
                setCurrent(opt.value);
                updateBtnStyle();
                onSelect?.(opt.value);
                draw();
            };
            
            container.appendChild(btn);
        });
    }

    createModeButtons(
        curveButtonsContainer,
        CURVE_MODES,
        () => editor.currentCurveMode,
        (v) => { editor.currentCurveMode = v; if (editor.curveWidget) { editor.curveWidget.value = v; editor.curveWidget.callback?.(v); } },
        null
    );

    createModeButtons(
        presetButtonsContainer,
        PRESET_OPTIONS,
        () => editor.currentPreset,
        (v) => { editor.currentPreset = v; if (editor.presetWidget) { editor.presetWidget.value = v; editor.presetWidget.callback?.(v); } },
        (v) => {
            if (v !== "自定义") {
                setTimeout(() => {
                    if (editor.sigmasWidget) {
                        editor.sigmas = safeParseArray(editor.sigmasWidget.value, [1.0, 0.5, 0.0]);
                    }
                    draw();
                }, 50);
            }
        }
    );

    function getChartArea() {
        const rect = wrap.getBoundingClientRect();
        return {
            x: CHART_PADDING.left,
            y: CHART_PADDING.top,
            width: Math.max(1, rect.width - CHART_PADDING.left - CHART_PADDING.right),
            height: Math.max(1, rect.height - CHART_PADDING.top - CHART_PADDING.bottom),
        };
    }

    function toChartPoint(event) {
        const rect = wrap.getBoundingClientRect();
        const area = getChartArea();
        const localX = event.clientX - rect.left - area.x;
        const localY = event.clientY - rect.top - area.y;

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

    function writeBack() {
        if (editor.sigmasWidget) {
            editor.sigmasWidget.value = JSON.stringify(editor.sigmas);
            editor.sigmasWidget.callback?.(editor.sigmasWidget.value);
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

        ctx.fillStyle = "#91a39b";
        ctx.font = "bold 13px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Sigmas Curve", cssWidth / 2, 18);

        ctx.fillStyle = "#6b7b85";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText("Step", 8, cssHeight - 8);
        ctx.textAlign = "right";
        ctx.fillText("Value", cssWidth - 8, cssHeight - 8);
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
        writeBack();
    };

    clearButton.onclick = () => {
        editor.sigmas = [1.0, 0.0];
        writeBack();
    };

    wrap.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const point = toChartPoint(event);
        if (!point) return;
        const index = findNearestPoint(point.t, 0.1);
        if (index >= 0 && editor.sigmas.length > 2) {
            editor.sigmas.splice(index, 1);
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
            writeBack();
        }
    });

    wrap.addEventListener("pointermove", (event) => {
        if (editor.draggingIndex >= 0) {
            const point = toChartPoint(event);
            if (point) {
                editor.sigmas[editor.draggingIndex] = clamp(point.value, 0, 1);
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
        getHeight: () => CHART_HEIGHT + 80,
        getMinHeight: () => CHART_HEIGHT + 80,
        getMaxHeight: () => CHART_HEIGHT + 80,
    });
    widget.computeSize = (width) => [Math.max(MIN_NODE_WIDTH, Number(width || 0)), CHART_HEIGHT + 80];

    node.__gjjSigmasEditor = { widget, editor, draw };
    draw();
    return node.__gjjSigmasEditor;
}

function patchNode(node) {
    if (!node || node.__gjjSigmasPatched) return;
    node.__gjjSigmasPatched = true;

    const sigmasWidget = node.widgets?.find((w) => w.name === "sigmas_data");
    const curveWidget = node.widgets?.find((w) => w.name === "curve_mode");
    const presetWidget = node.widgets?.find((w) => w.name === "preset");

    if (sigmasWidget) hideWidget(sigmasWidget);
    if (curveWidget) hideWidget(curveWidget);
    if (presetWidget) hideWidget(presetWidget);

    ensureEditor(node);
}

app.registerExtension({
    name: "GJJ.SigmasEditor",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!TARGET_NODES.has(String(nodeData?.name || ""))) return;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalOnNodeCreated?.apply(this, arguments);
            patchNode(this);
            return result;
        };

        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const result = originalOnConfigure?.apply(this, arguments);
            patchNode(this);
            return result;
        };

        const originalOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            originalOnExecuted?.apply(this, arguments);
            if (message?.sigmas?.[0]) {
                const editor = ensureEditor(this);
                editor.editor.sigmas = message.sigmas[0];
                editor.draw();
            }
        };
    },
    setup() {
        for (const node of app.graph?._nodes || []) {
            if (TARGET_NODES.has(String(node.comfyClass || node.type || ""))) {
                patchNode(node);
            }
        }
    },
});
