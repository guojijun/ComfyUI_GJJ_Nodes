import { app } from "/scripts/app.js";

// GJJ - 田字格对齐面板 (Alt+A)
app.registerExtension({
    name: "Comfy.GJJ.TianAlign",
    async setup() {
        const DEFAULT_THEME = "#FFD700";
        let THEME_COLOR = localStorage.getItem("gjj.tianAlign.themeColor") || DEFAULT_THEME;

        const DEFAULT_V_GAP = 50;
        const DEFAULT_H_GAP = 100;
        let V_GAP = parseInt(localStorage.getItem("gjj.tianAlign.vGap")) || DEFAULT_V_GAP;
        let H_GAP = parseInt(localStorage.getItem("gjj.tianAlign.hGap")) || DEFAULT_H_GAP;

        function hexToRgba(hex, alpha) {
            const h = hex.replace("#", "");
            const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
            const r = parseInt(full.slice(0, 2), 16);
            const g = parseInt(full.slice(2, 4), 16);
            const b = parseInt(full.slice(4, 6), 16);
            return `rgba(${r},${g},${b},${alpha})`;
        }
        function updateThemeColors() {
            GOLD = THEME_COLOR;
            QZONE_BG = hexToRgba(THEME_COLOR, 0.12);
            QZONE_BORDER = hexToRgba(THEME_COLOR, 0.5);
            GLOW_DROP = hexToRgba(THEME_COLOR, 0.67);
        }

        let GOLD = THEME_COLOR;
        const LINE_COLOR = "rgba(194,194,194,0.5)";
        const LINE_DIM = "rgba(194,194,194,0.18)";
        let QZONE_BG = hexToRgba(THEME_COLOR, 0.12);
        let QZONE_BORDER = hexToRgba(THEME_COLOR, 0.5);
        let GLOW_DROP = hexToRgba(THEME_COLOR, 0.67);
        const TIAN_SIZE = 200;
        const PAD = 18;
        const CX = TIAN_SIZE / 2;
        const CY = TIAN_SIZE / 2;
        const HIT_LINE = 12;
        const HIT_ZONE = 28;
        const CENTER_RADIUS = 18;

        const PRESET_COLORS = [
            "#FFD700", "#FF6B6B", "#4ECDC4", "#A78BFA",
            "#F472B6", "#60A5FA", "#34D399", "#FBBF24",
            "#FFFFFF", "#FF8C42",
        ];

        const LINES = {
            v_left:   { type: "v", x: PAD,            key: "v_left" },
            v_mid:    { type: "v", x: CX,             key: "v_mid" },
            v_right:  { type: "v", x: TIAN_SIZE-PAD,  key: "v_right" },
            h_top:    { type: "h", y: PAD,            key: "h_top" },
            h_mid:    { type: "h", y: CY,             key: "h_mid" },
            h_bottom: { type: "h", y: TIAN_SIZE-PAD,  key: "h_bottom" },
        };
        const LINE_KEYS = Object.keys(LINES);

        // 4个区域分布功能
        const ZONES = {
            z_left:   { key: "z_left",   quads: [0, 2] },
            z_right:  { key: "z_right",  quads: [1, 3] },
            z_top:    { key: "z_top",    quads: [0, 1] },
            z_bottom: { key: "z_bottom", quads: [2, 3] },
        };

        let tianPanel = null;
        let tianIsOpen = false;
        let svgLineEls = {};
        let svgQuadEls = [];
        let centerDot = null;
        let centerGlow = null;
        let frameEl = null;
        let overlay = null;
        let hoveredType = null;
        let hoveredKey = null;
        let colorMenu = null;
        let colorMenuOpen = false;
        let centerDrag = null;
        let dirArrow = null;
        let pressRing = null;
        let pressTimer = null;
        let pressStartTime = 0;
        const DRAG_THRESHOLD = 60;
        const LONG_PRESS_MS = 1500;

        // --- 辅助函数 ---
        function getGraphNodeById(id) {
            if (id == null) return null;
            const graph = app.graph || app.canvas?.graph;
            try {
                const node = graph?.getNodeById?.(id);
                if (node) return node;
            } catch (_) {}
            const nodesById = graph?._nodes_by_id;
            if (nodesById instanceof Map) {
                return nodesById.get(id) || nodesById.get(String(id)) || null;
            }
            return nodesById?.[id]
                || nodesById?.[String(id)]
                || graph?._nodes?.find((node) => String(node?.id) === String(id))
                || null;
        }

        function isUsableNode(node) {
            return !!node
                && typeof node === "object"
                && Number.isFinite(Number(node.pos?.[0]))
                && Number.isFinite(Number(node.pos?.[1]))
                && Number.isFinite(Number(node.size?.[0]))
                && Number.isFinite(Number(node.size?.[1]));
        }

        function getSelectedNodes() {
            const result = new Set();
            const add = (value, key = null) => {
                const candidates = [
                    value,
                    value?.node,
                    getGraphNodeById(value?.id),
                    value !== true && typeof value !== "object" ? getGraphNodeById(value) : null,
                    getGraphNodeById(key),
                ];
                for (const node of candidates) {
                    if (isUsableNode(node)) {
                        result.add(node);
                        return;
                    }
                }
            };
            const collect = (value) => {
                if (!value) return;
                if (value instanceof Set) {
                    for (const item of value) add(item);
                } else if (value instanceof Map) {
                    for (const [key, item] of value.entries()) add(item, key);
                } else if (Array.isArray(value)) {
                    for (const item of value) add(item);
                } else if (typeof value === "object") {
                    for (const [key, item] of Object.entries(value)) add(item, key);
                }
            };

            const canvas = app.canvas;
            collect(canvas?.selected_nodes);
            collect(canvas?.selectedNodes);
            collect(canvas?.selected_items);
            collect(canvas?.selectedItems);
            collect(canvas?.selection);
            collect(canvas?._selected_nodes);
            try { collect(window?.LiteGraph?.active_canvas?.selected_nodes); } catch (_) {}
            if (result.size === 0) {
                for (const node of app.graph?._nodes || []) {
                    if (node?.selected || node?.flags?.selected || node?.__selected || node?.is_selected) add(node);
                }
            }
            return [...result];
        }

        function assignIndexedPosition(target, x, y) {
            if (!target || typeof target !== "object") return false;
            if (typeof target.set === "function") {
                try {
                    target.set.length >= 2 ? target.set(x, y) : target.set([x, y]);
                    return true;
                } catch (_) {}
            }
            try {
                if (0 in target || 1 in target || Array.isArray(target)) {
                    target[0] = x;
                    target[1] = y;
                    return true;
                }
                if ("x" in target || "y" in target) {
                    target.x = x;
                    target.y = y;
                    return true;
                }
            } catch (_) {}
            return false;
        }

        function setNodePosition(node, x, y) {
            if (!node) return;
            const nextX = Math.round(Number(x) || 0);
            const nextY = Math.round(Number(y) || 0);
            const oldPos = node.pos;
            try { node.pos = [nextX, nextY]; } catch (_) {}
            assignIndexedPosition(oldPos, nextX, nextY);
            assignIndexedPosition(node.pos, nextX, nextY);
            assignIndexedPosition(node.position, nextX, nextY);
            assignIndexedPosition(node._pos, nextX, nextY);
            assignIndexedPosition(node.layout?.position, nextX, nextY);
            assignIndexedPosition(node._layout?.position, nextX, nextY);
            assignIndexedPosition(node.comfyLayout?.position, nextX, nextY);
            if (typeof node.setPosition === "function") {
                try {
                    node.setPosition.length >= 2
                        ? node.setPosition(nextX, nextY)
                        : node.setPosition([nextX, nextY]);
                } catch (_) {}
            }
            try { node.pos = [nextX, nextY]; } catch (_) {}
            assignIndexedPosition(node.pos, nextX, nextY);
            assignIndexedPosition(node.position, nextX, nextY);
            assignIndexedPosition(node._pos, nextX, nextY);
            assignIndexedPosition(node.layout?.position, nextX, nextY);
            assignIndexedPosition(node._layout?.position, nextX, nextY);
            assignIndexedPosition(node.comfyLayout?.position, nextX, nextY);
        }

        function setNodeX(node, x) {
            setNodePosition(node, x, node.pos[1]);
        }

        function setNodeY(node, y) {
            setNodePosition(node, node.pos[0], y);
        }

        function setNodeSize(node, width, height) {
            if (!node) return;
            const nextWidth = Math.max(1, Math.round(Number(width) || 1));
            const nextHeight = Math.max(1, Math.round(Number(height) || 1));
            const oldSize = node.size;
            try { node.size = [nextWidth, nextHeight]; } catch (_) {}
            assignIndexedPosition(oldSize, nextWidth, nextHeight);
            assignIndexedPosition(node.size, nextWidth, nextHeight);
            assignIndexedPosition(node._size, nextWidth, nextHeight);
            assignIndexedPosition(node.layout?.size, nextWidth, nextHeight);
            assignIndexedPosition(node._layout?.size, nextWidth, nextHeight);
            assignIndexedPosition(node.comfyLayout?.size, nextWidth, nextHeight);
            if (typeof node.setSize === "function") {
                try {
                    node.setSize.length >= 2
                        ? node.setSize(nextWidth, nextHeight)
                        : node.setSize([nextWidth, nextHeight]);
                } catch (_) {}
            }
            try { node.size = [nextWidth, nextHeight]; } catch (_) {}
            assignIndexedPosition(node.size, nextWidth, nextHeight);
            assignIndexedPosition(node._size, nextWidth, nextHeight);
            assignIndexedPosition(node.layout?.size, nextWidth, nextHeight);
            assignIndexedPosition(node._layout?.size, nextWidth, nextHeight);
            assignIndexedPosition(node.comfyLayout?.size, nextWidth, nextHeight);
        }

        function beginChange() {
            const graphs = new Set([app.graph, app.canvas?.graph].filter(Boolean));
            for (const graph of graphs) {
                try { graph.beforeChange?.(); } catch (_) {}
            }
        }
        function drawChangedNodes(nodes = getSelectedNodes()) {
            const canvas = app.canvas;
            const graphs = new Set([app.graph, canvas?.graph].filter(Boolean));
            for (const node of nodes || []) {
                try { node.setDirtyCanvas?.(true, true); } catch (_) {}
                try { node.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
            }
            for (const graph of graphs) {
                try { graph.setDirtyCanvas?.(true, true); } catch (_) {}
            }
            try { canvas?.setDirty?.(true, true); } catch (_) {}
            try { canvas && (canvas.dirty_canvas = true); } catch (_) {}
            try { canvas && (canvas.dirty_bgcanvas = true); } catch (_) {}
            try { canvas?.draw?.(true, true); } catch (_) {}
        }
        function endChange(nodes = getSelectedNodes()) {
            const graphs = new Set([app.graph, app.canvas?.graph].filter(Boolean));
            for (const graph of graphs) {
                try { graph.afterChange?.(); } catch (_) {}
                try { graph.change?.(); } catch (_) {}
            }
            drawChangedNodes(nodes);
            if (typeof requestAnimationFrame === "function") {
                requestAnimationFrame(() => drawChangedNodes(nodes));
            }
        }
        function getLeftmost(nodes) {
            return nodes.reduce((a, n) => (n.pos[0] < a.pos[0] ? n : a), nodes[0]);
        }
        function getRightmost(nodes) {
            return nodes.reduce((a, n) => (n.pos[0] + n.size[0] > a.pos[0] + a.size[0] ? n : a), nodes[0]);
        }
        function getTopmost(nodes) {
            return nodes.reduce((a, n) => (n.pos[1] < a.pos[1] ? n : a), nodes[0]);
        }
        function getBottommost(nodes) {
            return nodes.reduce((a, n) => (n.pos[1] + n.size[1] > a.pos[1] + a.size[1] ? n : a), nodes[0]);
        }
        function getClosestToCenterH(nodes) {
            const avgCX = nodes.reduce((a, n) => a + n.pos[0] + n.size[0] / 2, 0) / nodes.length;
            let best = nodes[0], bestDist = Infinity;
            for (const n of nodes) {
                const cx = n.pos[0] + n.size[0] / 2;
                const d = Math.abs(cx - avgCX);
                if (d < bestDist) { bestDist = d; best = n; }
            }
            return best;
        }
        function getClosestToCenterV(nodes) {
            const avgCY = nodes.reduce((a, n) => a + n.pos[1] + n.size[1] / 2, 0) / nodes.length;
            let best = nodes[0], bestDist = Infinity;
            for (const n of nodes) {
                const cy = n.pos[1] + n.size[1] / 2;
                const d = Math.abs(cy - avgCY);
                if (d < bestDist) { bestDist = d; best = n; }
            }
            return best;
        }

        // --- 6个线对齐功能 ---
        // 左对齐、水平居中、右对齐：以最上面的节点为锚（不动）
        // 上对齐、垂直居中、下对齐：以最左侧的节点为锚（不动）
        function alignLeft() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();
            const anchor = getTopmost(nodes);
            nodes.forEach(n => setNodeX(n, anchor.pos[0]));
            endChange(nodes);
        }
        function alignRight() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();
            const anchor = getTopmost(nodes);
            const tx = anchor.pos[0] + anchor.size[0];
            nodes.forEach(n => setNodeX(n, tx - n.size[0]));
            endChange(nodes);
        }
        function alignTop() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();
            const anchor = getLeftmost(nodes);
            nodes.forEach(n => setNodeY(n, anchor.pos[1]));
            endChange(nodes);
        }
        function alignBottom() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();
            const anchor = getLeftmost(nodes);
            const ty = anchor.pos[1] + anchor.size[1];
            nodes.forEach(n => setNodeY(n, ty - n.size[1]));
            endChange(nodes);
        }
        function alignHCenter() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();
            const anchor = getTopmost(nodes);
            const cx = anchor.pos[0] + anchor.size[0] / 2;
            nodes.forEach(n => setNodeX(n, cx - n.size[0] / 2));
            endChange(nodes);
        }
        function alignVCenter() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();
            const anchor = getLeftmost(nodes);
            const cy = anchor.pos[1] + anchor.size[1] / 2;
            nodes.forEach(n => setNodeY(n, cy - n.size[1] / 2));
            endChange(nodes);
        }

        // --- 4个区域分布功能 ---
        // 上下分布（左侧/右侧区域）：以最上面节点为锚点
        // 左右分布（上侧/下侧区域）：以最左侧节点为锚点
        // 左侧区域：水平居中(以最上面节点为锚) + 垂直等距分布(两端不动)
        function distVLeftAnchor() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();
            const anchor = getTopmost(nodes);
            const targetCX = anchor.pos[0] + anchor.size[0] / 2;
            nodes.forEach(n => setNodeX(n, targetCX - n.size[0] / 2));

            const sorted = [...nodes].sort((a, b) => a.pos[1] - b.pos[1]);
            const minY = sorted[0].pos[1];
            const maxY = sorted[sorted.length-1].pos[1] + sorted[sorted.length-1].size[1];
            const totalH = sorted.reduce((a, n) => a + n.size[1], 0);
            const gap = (maxY - minY - totalH) / (sorted.length - 1);
            let y = minY;
            sorted.forEach(n => { setNodeY(n, y); y += n.size[1] + gap; });
            endChange(nodes);
        }
        // 右侧区域：水平居中(以最上面节点为锚) + 垂直固定间距堆叠(最上节点不动)
        function distVRightAnchor() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();
            const anchor = getTopmost(nodes);
            const targetCX = anchor.pos[0] + anchor.size[0] / 2;
            const startY = anchor.pos[1];
            nodes.forEach(n => setNodeX(n, targetCX - n.size[0] / 2));

            const sorted = [...nodes].sort((a, b) => a.pos[1] - b.pos[1]);
            let y = startY;
            sorted.forEach(n => { setNodeY(n, y); y += n.size[1] + V_GAP; });
            endChange(nodes);
        }
        // 上侧区域：垂直居中(以最左侧节点为锚) + 水平等距分布(两端不动)
        function distHTopAnchor() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();
            const anchor = getLeftmost(nodes);
            const targetCY = anchor.pos[1] + anchor.size[1] / 2;
            nodes.forEach(n => setNodeY(n, targetCY - n.size[1] / 2));

            const sorted = [...nodes].sort((a, b) => a.pos[0] - b.pos[0]);
            const minX = sorted[0].pos[0];
            const maxX = sorted[sorted.length-1].pos[0] + sorted[sorted.length-1].size[0];
            const totalW = sorted.reduce((a, n) => a + n.size[0], 0);
            const gap = (maxX - minX - totalW) / (sorted.length - 1);
            let x = minX;
            sorted.forEach(n => { setNodeX(n, x); x += n.size[0] + gap; });
            endChange(nodes);
        }
        // 下侧区域：垂直居中(以最左侧节点为锚) + 水平固定间距(最左节点不动)
        function distHBottomAnchor() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();
            const anchor = getLeftmost(nodes);
            const targetCY = anchor.pos[1] + anchor.size[1] / 2;
            nodes.forEach(n => setNodeY(n, targetCY - n.size[1] / 2));

            const sorted = [...nodes].sort((a, b) => a.pos[0] - b.pos[0]);
            const startX = anchor.pos[0];
            let x = startX;
            sorted.forEach(n => { setNodeX(n, x); x += n.size[0] + H_GAP; });
            endChange(nodes);
        }

        const ALIGN_FN = {
            v_left:   alignLeft,
            v_mid:    alignHCenter,
            v_right:  alignRight,
            h_top:    alignTop,
            h_mid:    alignVCenter,
            h_bottom: alignBottom,
        };
        const ZONE_FN = {
            z_left:   distVLeftAnchor,
            z_right:  distVRightAnchor,
            z_top:    distHTopAnchor,
            z_bottom: distHBottomAnchor,
        };

        // 中心功能：智能判断分布方向，等宽或等高
        function centerSameSize() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;

            // 判断节点是主要上下分布还是左右分布
            const minX = Math.min(...nodes.map(n => n.pos[0]));
            const maxX = Math.max(...nodes.map(n => n.pos[0] + n.size[0]));
            const minY = Math.min(...nodes.map(n => n.pos[1]));
            const maxY = Math.max(...nodes.map(n => n.pos[1] + n.size[1]));
            const totalW = maxX - minX;
            const totalH = maxY - minY;

            // 计算节点在X/Y方向上的总重叠范围
            // 如果垂直范围 > 水平范围 → 主要上下分布 → 等宽
            // 如果水平范围 > 垂直范围 → 主要左右分布 → 等高
            const verticalLayout = totalH > totalW;

            beginChange();
            if (verticalLayout) {
                // 上下分布 → 等宽，以最宽的节点为锚点（只加宽不加窄）
                const maxW = Math.max(...nodes.map(n => n.size[0]));
                nodes.forEach(n => {
                    const cx = n.pos[0] + n.size[0] / 2;
                    setNodeSize(n, maxW, n.size[1]);
                    setNodeX(n, cx - maxW / 2);
                });
            } else {
                // 左右分布 → 等高，以最高的节点为锚点（只加高不加窄）
                const maxH = Math.max(...nodes.map(n => n.size[1]));
                nodes.forEach(n => {
                    const cy = n.pos[1] + n.size[1] / 2;
                    setNodeSize(n, n.size[0], maxH);
                    setNodeY(n, cy - maxH / 2);
                });
            }
            endChange(nodes);
        }

        // 强制等宽（左右拖）
        function sameWidth() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();
            const maxW = Math.max(...nodes.map(n => n.size[0]));
            nodes.forEach(n => {
                const cx = n.pos[0] + n.size[0] / 2;
                setNodeSize(n, maxW, n.size[1]);
                setNodeX(n, cx - maxW / 2);
            });
            endChange(nodes);
        }

        // 强制等高（上下拖）
        function sameHeight() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();
            const maxH = Math.max(...nodes.map(n => n.size[1]));
            nodes.forEach(n => {
                const cy = n.pos[1] + n.size[1] / 2;
                setNodeSize(n, n.size[0], maxH);
                setNodeY(n, cy - maxH / 2);
            });
            endChange(nodes);
        }

        function autoArrange() {
            const nodes = getSelectedNodes();
            if (nodes.length < 2) return;
            beginChange();

            const nodeMap = new Map();
            nodes.forEach(n => nodeMap.set(n.id, n));

            const inputsOf = new Map();
            const outputsOf = new Map();
            nodes.forEach(n => {
                inputsOf.set(n.id, new Set());
                outputsOf.set(n.id, new Set());
            });

            nodes.forEach(n => {
                if (!n.inputs) return;
                n.inputs.forEach((inp) => {
                    if (!inp || inp.link == null) return;
                    const link = app.graph.links[inp.link];
                    if (!link) return;
                    const srcId = link.origin_id;
                    if (nodeMap.has(srcId) && srcId !== n.id) {
                        inputsOf.get(n.id).add(srcId);
                        outputsOf.get(srcId).add(n.id);
                    }
                });
            });

            const depth = new Map();
            const visiting = new Set();

            function getDepth(id) {
                if (depth.has(id)) return depth.get(id);
                if (visiting.has(id)) return 0;
                visiting.add(id);
                const inputs = inputsOf.get(id) || new Set();
                let d = 0;
                inputs.forEach(srcId => {
                    if (nodeMap.has(srcId)) {
                        d = Math.max(d, getDepth(srcId) + 1);
                    }
                });
                visiting.delete(id);
                depth.set(id, d);
                return d;
            }

            nodes.forEach(n => getDepth(n.id));

            const layers = new Map();
            let maxDepth = 0;
            nodes.forEach(n => {
                const d = depth.get(n.id) || 0;
                maxDepth = Math.max(maxDepth, d);
                if (!layers.has(d)) layers.set(d, []);
                layers.get(d).push(n);
            });

            let anchor = null;
            let minAnchorScore = Infinity;
            nodes.forEach(n => {
                const d = depth.get(n.id) || 0;
                const score = d * 10000 + n.pos[1];
                if (score < minAnchorScore) {
                    minAnchorScore = score;
                    anchor = n;
                }
            });
            if (!anchor) anchor = nodes[0];
            const anchorX = anchor.pos[0];
            const anchorY = anchor.pos[1];
            const anchorDepth = depth.get(anchor.id) || 0;

            const H_GAP = 70;
            const V_GAP = 50;

            const layerHeights = new Map();
            const layerMaxWidths = new Map();
            for (const [d, list] of layers) {
                const totalH = list.reduce((a, n) => a + n.size[1], 0) + V_GAP * (list.length - 1);
                layerHeights.set(d, totalH);
                const maxW = Math.max(...list.map(n => n.size[0] || 200));
                layerMaxWidths.set(d, maxW);
            }

            const layerXs = new Map();
            const sortedDepths = [...layers.keys()].sort((a, b) => a - b);

            {
                let rightX = anchorX + (layerMaxWidths.get(anchorDepth) || 200);
                for (const d of sortedDepths) {
                    if (d < anchorDepth) continue;
                    if (d === anchorDepth) {
                        layerXs.set(d, anchorX);
                    } else {
                        const lx = rightX + H_GAP;
                        layerXs.set(d, lx);
                        rightX = lx + (layerMaxWidths.get(d) || 200);
                    }
                }
            }

            {
                let leftX = anchorX;
                const reversedDepths = [...sortedDepths].filter(d => d < anchorDepth).sort((a, b) => b - a);
                for (const d of reversedDepths) {
                    const lx = leftX - H_GAP - (layerMaxWidths.get(d) || 200);
                    layerXs.set(d, lx);
                    leftX = lx;
                }
            }

            const anchorCenterY = anchorY + anchor.size[1] / 2;

            sortedDepths.forEach((d) => {
                const list = layers.get(d);
                const totalH = layerHeights.get(d);
                const startY = anchorCenterY - totalH / 2;

                list.sort((a, b) => a.pos[1] - b.pos[1]);

                const anchorIdx = list.findIndex(n => n.id === anchor.id);
                let adjustedStartY = startY;
                if (anchorIdx >= 0) {
                    let aboveH = 0;
                    for (let i = 0; i < anchorIdx; i++) {
                        aboveH += list[i].size[1] + V_GAP;
                    }
                    adjustedStartY = anchorY - aboveH;
                }

                let y = adjustedStartY;
                const lx = layerXs.get(d) || 0;
                list.forEach(n => {
                    setNodePosition(n, lx, y);
                    y += n.size[1] + V_GAP;
                });
            });

            endChange(nodes);
        }

        // --- 主题颜色应用 ---
        function applyThemeToVisuals() {
            if (!tianPanel) return;
            updateThemeColors();

            // 中心发光环
            if (centerGlow) {
                centerGlow.setAttribute("fill", hexToRgba(THEME_COLOR, 0.12));
                centerGlow.setAttribute("stroke", hexToRgba(THEME_COLOR, 0.6));
                centerGlow.style.filter = `drop-shadow(0 0 8px ${hexToRgba(THEME_COLOR, 0.67)})`;
            }
            // 方向尺子
            if (dirArrow) {
                const body = dirArrow.querySelector("rect");
                const lines = dirArrow.querySelectorAll("line");
                if (body) {
                    body.setAttribute("stroke", GOLD);
                    body.style.filter = `drop-shadow(0 0 5px ${hexToRgba(THEME_COLOR, 0.5)})`;
                }
                lines.forEach(l => {
                    l.setAttribute("stroke", GOLD);
                });
            }
            // 长按进度环
            if (pressRing) {
                pressRing.setAttribute("stroke", GOLD);
                pressRing.style.filter = `drop-shadow(0 0 6px ${hexToRgba(THEME_COLOR, 0.7)})`;
            }

            // 如果当前有悬停状态，重新应用
            if (hoveredType || hoveredKey) {
                const curType = hoveredType, curKey = hoveredKey;
                hoveredType = null; hoveredKey = null;
                setHover(curType, curKey);
            }
        }

        function setThemeColor(hex) {
            THEME_COLOR = hex;
            localStorage.setItem("gjj.tianAlign.themeColor", hex);
            applyThemeToVisuals();
        }

        // --- 颜色设置菜单 ---
        function buildColorMenu() {
            if (colorMenu) return;
            // 注入样式隐藏number输入框箭头
            if (!document.getElementById("gjj-tian-align-color-menu-style")) {
                const style = document.createElement("style");
                style.id = "gjj-tian-align-color-menu-style";
                style.textContent = `
                    #gjj-tian-align-color-menu input[type="number"]::-webkit-outer-spin-button,
                    #gjj-tian-align-color-menu input[type="number"]::-webkit-inner-spin-button {
                        -webkit-appearance: none;
                        margin: 0;
                    }
                    #gjj-tian-align-color-menu input[type="number"] {
                        -moz-appearance: textfield;
                    }
                `;
                document.head.appendChild(style);
            }
            colorMenu = document.createElement("div");
            colorMenu.id = "gjj-tian-align-color-menu";
            colorMenu.style.cssText = `
                display:none; position:fixed; z-index:10001;
                background: rgba(20,20,20,0.92);
                border: 1px solid rgba(255,255,255,0.15);
                border-radius: 10px;
                padding: 12px;
                backdrop-filter: blur(10px);
                box-shadow: 0 6px 24px rgba(0,0,0,0.6);
                user-select:none;
                font-family: "Microsoft YaHei", sans-serif;
                width: 210px;
            `;

            // 标题
            const title = document.createElement("div");
            title.textContent = "面板颜色";
            title.style.cssText = "color:#fff; font-size:13px; margin-bottom:10px; text-align:center; font-weight:500;";
            colorMenu.appendChild(title);

            // 预设颜色网格
            const grid = document.createElement("div");
            grid.style.cssText = "display:grid; grid-template-columns:repeat(5, 1fr); gap:8px; margin-bottom:10px;";
            PRESET_COLORS.forEach(color => {
                const swatch = document.createElement("div");
                swatch.style.cssText = `
                    width: 30px; height: 30px; border-radius: 6px;
                    background: ${color}; cursor: pointer;
                    border: 2px solid transparent;
                    box-sizing: border-box;
                    transition: all 0.15s ease;
                `;
                swatch.title = color;
                swatch.addEventListener("mouseenter", () => {
                    swatch.style.borderColor = "rgba(255,255,255,0.5)";
                    swatch.style.transform = "scale(1.1)";
                });
                swatch.addEventListener("mouseleave", () => {
                    if (color.toUpperCase() !== THEME_COLOR.toUpperCase()) {
                        swatch.style.borderColor = "transparent";
                    }
                    swatch.style.transform = "scale(1)";
                });
                swatch.addEventListener("click", (e) => {
                    e.stopPropagation();
                    setThemeColor(color);
                    updateSwatchSelection();
                    hideColorMenu();
                });
                swatch.dataset.color = color;
                grid.appendChild(swatch);
            });
            colorMenu.appendChild(grid);

            // 自定义颜色行
            const customRow = document.createElement("div");
            customRow.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:10px;";
            const customLabel = document.createElement("span");
            customLabel.textContent = "自定义";
            customLabel.style.cssText = "color:#bbb; font-size:12px;";
            const customInput = document.createElement("input");
            customInput.type = "color";
            customInput.value = THEME_COLOR;
            customInput.style.cssText = `
                width: 30px; height: 26px; border: none; background: none;
                cursor: pointer; padding: 0;
            `;
            customInput.addEventListener("input", (e) => {
                setThemeColor(e.target.value);
                updateSwatchSelection();
                hideColorMenu();
            });
            customRow.appendChild(customLabel);
            customRow.appendChild(customInput);
            colorMenu.appendChild(customRow);

            // 分隔线
            const divider1 = document.createElement("div");
            divider1.style.cssText = "height:1px; background:rgba(255,255,255,0.1); margin:10px 0;";
            colorMenu.appendChild(divider1);

            // 上下等距标题
            const vGapTitle = document.createElement("div");
            vGapTitle.textContent = "上下等距间距";
            vGapTitle.style.cssText = "color:#fff; font-size:12px; margin-bottom:8px;";
            colorMenu.appendChild(vGapTitle);

            // 上下等距设置行
            const vGapRow = document.createElement("div");
            vGapRow.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:12px;";
            const vGapSlider = document.createElement("input");
            vGapSlider.type = "range";
            vGapSlider.min = "10";
            vGapSlider.max = "200";
            vGapSlider.value = V_GAP;
            vGapSlider.style.cssText = "flex:1; accent-color:#FFD700;";
            const vGapNum = document.createElement("input");
            vGapNum.type = "number";
            vGapNum.min = "10";
            vGapNum.max = "500";
            vGapNum.value = V_GAP;
            vGapNum.style.cssText = `
                width: 56px; height: 26px; background: rgba(255,255,255,0.08);
                border: 1px solid rgba(255,255,255,0.25); border-radius: 5px;
                color: #fff; font-size: 12px; text-align: center;
                outline: none; cursor: text;
                transition: border-color 0.15s, box-shadow 0.15s;
            `;
            vGapNum.addEventListener("focus", () => {
                vGapNum.style.borderColor = "#FFD700";
                vGapNum.style.boxShadow = "0 0 0 2px rgba(255,215,0,0.2)";
            });
            vGapNum.addEventListener("blur", () => {
                vGapNum.style.borderColor = "rgba(255,255,255,0.25)";
                vGapNum.style.boxShadow = "none";
            });
            vGapNum.addEventListener("click", (e) => e.stopPropagation());
            vGapNum.addEventListener("pointerdown", (e) => e.stopPropagation());
            vGapNum.addEventListener("mousedown", (e) => e.stopPropagation());
            function applyVGap(val) {
                val = parseInt(val);
                if (isNaN(val) || val < 10) val = 10;
                if (val > 500) val = 500;
                V_GAP = val;
                localStorage.setItem("gjj.tianAlign.vGap", val);
                vGapSlider.value = val;
                vGapNum.value = val;
            }
            vGapSlider.addEventListener("input", (e) => applyVGap(e.target.value));
            vGapNum.addEventListener("input", (e) => {
                const numVal = parseInt(e.target.value);
                if (!isNaN(numVal) && numVal >= 10 && numVal <= 500) {
                    vGapSlider.value = numVal;
                    V_GAP = numVal;
                    localStorage.setItem("gjj.tianAlign.vGap", numVal);
                }
            });
            vGapNum.addEventListener("blur", () => applyVGap(vGapNum.value));
            vGapNum.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    applyVGap(vGapNum.value);
                    vGapNum.blur();
                }
            });
            vGapRow.appendChild(vGapSlider);
            vGapRow.appendChild(vGapNum);
            colorMenu.appendChild(vGapRow);

            // 左右等距标题
            const hGapTitle = document.createElement("div");
            hGapTitle.textContent = "左右等距间距";
            hGapTitle.style.cssText = "color:#fff; font-size:12px; margin-bottom:8px;";
            colorMenu.appendChild(hGapTitle);

            // 左右等距设置行
            const hGapRow = document.createElement("div");
            hGapRow.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:10px;";
            const hGapSlider = document.createElement("input");
            hGapSlider.type = "range";
            hGapSlider.min = "10";
            hGapSlider.max = "200";
            hGapSlider.value = H_GAP;
            hGapSlider.style.cssText = "flex:1; accent-color:#FFD700;";
            const hGapNum = document.createElement("input");
            hGapNum.type = "number";
            hGapNum.min = "10";
            hGapNum.max = "500";
            hGapNum.value = H_GAP;
            hGapNum.style.cssText = `
                width: 56px; height: 26px; background: rgba(255,255,255,0.08);
                border: 1px solid rgba(255,255,255,0.25); border-radius: 5px;
                color: #fff; font-size: 12px; text-align: center;
                outline: none; cursor: text;
                transition: border-color 0.15s, box-shadow 0.15s;
            `;
            hGapNum.addEventListener("focus", () => {
                hGapNum.style.borderColor = "#FFD700";
                hGapNum.style.boxShadow = "0 0 0 2px rgba(255,215,0,0.2)";
            });
            hGapNum.addEventListener("blur", () => {
                hGapNum.style.borderColor = "rgba(255,255,255,0.25)";
                hGapNum.style.boxShadow = "none";
            });
            hGapNum.addEventListener("click", (e) => e.stopPropagation());
            hGapNum.addEventListener("pointerdown", (e) => e.stopPropagation());
            hGapNum.addEventListener("mousedown", (e) => e.stopPropagation());
            function applyHGap(val) {
                val = parseInt(val);
                if (isNaN(val) || val < 10) val = 10;
                if (val > 500) val = 500;
                H_GAP = val;
                localStorage.setItem("gjj.tianAlign.hGap", val);
                hGapSlider.value = val;
                hGapNum.value = val;
            }
            hGapSlider.addEventListener("input", (e) => applyHGap(e.target.value));
            hGapNum.addEventListener("input", (e) => {
                const numVal = parseInt(e.target.value);
                if (!isNaN(numVal) && numVal >= 10 && numVal <= 500) {
                    hGapSlider.value = numVal;
                    H_GAP = numVal;
                    localStorage.setItem("gjj.tianAlign.hGap", numVal);
                }
            });
            hGapNum.addEventListener("blur", () => applyHGap(hGapNum.value));
            hGapNum.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    applyHGap(hGapNum.value);
                    hGapNum.blur();
                }
            });
            hGapRow.appendChild(hGapSlider);
            hGapRow.appendChild(hGapNum);
            colorMenu.appendChild(hGapRow);

            // 重置按钮
            const resetBtn = document.createElement("div");
            resetBtn.textContent = "恢复默认";
            resetBtn.style.cssText = `
                text-align:center; color:#aaa; font-size:12px;
                padding: 5px 0; cursor:pointer; border-radius: 5px;
                transition: all 0.15s;
            `;
            resetBtn.addEventListener("mouseenter", () => {
                resetBtn.style.color = "#FFD700";
                resetBtn.style.background = "rgba(255,215,0,0.1)";
            });
            resetBtn.addEventListener("mouseleave", () => {
                resetBtn.style.color = "#aaa";
                resetBtn.style.background = "transparent";
            });
            resetBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                setThemeColor(DEFAULT_THEME);
                customInput.value = DEFAULT_THEME;
                applyVGap(DEFAULT_V_GAP);
                applyHGap(DEFAULT_H_GAP);
                updateSwatchSelection();
                hideColorMenu();
            });
            colorMenu.appendChild(resetBtn);

            function updateSwatchSelection() {
                const swatches = grid.querySelectorAll("div");
                swatches.forEach(s => {
                    if (s.dataset.color.toUpperCase() === THEME_COLOR.toUpperCase()) {
                        s.style.borderColor = "#fff";
                    } else {
                        s.style.borderColor = "transparent";
                    }
                });
            }
            // 初始选中状态
            updateSwatchSelection();

            colorMenu._customInput = customInput;
            document.body.appendChild(colorMenu);
        }

        function showColorMenu(clientX, clientY) {
            buildColorMenu();
            colorMenu.style.display = "block";
            colorMenuOpen = true;

            // 定位到鼠标位置，自动检测边界
            const rect = colorMenu.getBoundingClientRect();
            let left = clientX + 10;
            let top = clientY;
            if (left + rect.width > window.innerWidth) left = clientX - rect.width - 10;
            if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height - 10;
            if (left < 10) left = 10;
            if (top < 10) top = 10;
            colorMenu.style.left = left + "px";
            colorMenu.style.top = top + "px";

            // 更新自定义颜色输入值
            if (colorMenu._customInput) colorMenu._customInput.value = THEME_COLOR;
        }

        function hideColorMenu() {
            if (colorMenu) colorMenu.style.display = "none";
            colorMenuOpen = false;
        }

        // --- 命中检测 ---
        function hitTest(mx, my) {
            // 范围检查
            if (mx < PAD-4 || mx > TIAN_SIZE-PAD+4 || my < PAD-4 || my > TIAN_SIZE-PAD+4) {
                return { type: null, key: null };
            }

            // 中心区域 → 等宽/等高
            const cdx = mx - CX, cdy = my - CY;
            if (Math.hypot(cdx, cdy) < CENTER_RADIUS) {
                return { type: "center", key: "center" };
            }

            // 计算到6条线的距离
            const dists = {};
            for (const key of LINE_KEYS) {
                const L = LINES[key];
                if (L.type === "v") {
                    if (my < PAD || my > TIAN_SIZE - PAD) { dists[key] = Infinity; continue; }
                    dists[key] = Math.abs(mx - L.x);
                } else {
                    if (mx < PAD || mx > TIAN_SIZE - PAD) { dists[key] = Infinity; continue; }
                    dists[key] = Math.abs(my - L.y);
                }
            }

            // 找最近的线
            let bestLine = null, bestLineDist = Infinity;
            for (const k of LINE_KEYS) {
                if (dists[k] < bestLineDist) { bestLineDist = dists[k]; bestLine = k; }
            }

            // 如果离某条线很近 → 线对齐模式
            if (bestLineDist <= HIT_LINE) {
                return { type: "line", key: bestLine };
            }

            // 否则判断区域分布模式：看离哪个边缘更近
            const dLeft   = mx - PAD;
            const dRight  = (TIAN_SIZE - PAD) - mx;
            const dTop    = my - PAD;
            const dBottom = (TIAN_SIZE - PAD) - my;

            // 在格子内部，判断更偏哪个方向
            // 比较水平方向和垂直方向哪个更"靠边"
            const hMin = Math.min(dLeft, dRight);
            const vMin = Math.min(dTop, dBottom);

            if (hMin < vMin) {
                // 更靠近左右边 → 垂直分布
                if (dLeft < dRight) return { type: "zone", key: "z_left" };
                else return { type: "zone", key: "z_right" };
            } else {
                // 更靠近上下边 → 水平分布
                if (dTop < dBottom) return { type: "zone", key: "z_top" };
                else return { type: "zone", key: "z_bottom" };
            }
        }

        // --- 重置所有视觉状态 ---
        function resetVisuals() {
            LINE_KEYS.forEach(k => {
                const el = svgLineEls[k];
                el.setAttribute("stroke", LINE_COLOR);
                el.setAttribute("stroke-width", "1.5");
                el.style.filter = "none";
            });
            svgQuadEls.forEach(el => {
                el.setAttribute("fill", "none");
                el.setAttribute("stroke", "none");
            });
            centerDot.setAttribute("fill", "rgba(194,194,194,0.5)");
            if (centerGlow) {
                centerGlow.setAttribute("opacity", "0");
            }
            if (dirArrow) {
                dirArrow.setAttribute("opacity", "0");
            }
            if (pressRing) {
                pressRing.setAttribute("opacity", "0");
            }
            if (overlay) overlay.style.cursor = "default";
            const tipEl = document.getElementById("gjj-tian-align-tip");
            if (tipEl) {
                tipEl.style.opacity = "0";
                tipEl.style.left = "50%";
                tipEl.style.top = "50%";
                tipEl.style.transform = "translate(-50%,-50%)";
                tipEl.style.writingMode = "horizontal-tb";
                tipEl.style.textOrientation = "initial";
            }
        }

        function dimAllLines() {
            LINE_KEYS.forEach(k => {
                const el = svgLineEls[k];
                el.setAttribute("stroke", LINE_DIM);
                el.setAttribute("stroke-width", "1.5");
                el.style.filter = "none";
            });
        }

        function setHover(htype, hkey) {
            if (hoveredType === htype && hoveredKey === hkey) return;
            hoveredType = htype;
            hoveredKey = hkey;

            resetVisuals();

            const tipEl = document.getElementById("gjj-tian-align-tip");

            if (!htype) {
                if (tipEl) tipEl.style.opacity = "0";
                return;
            }

            if (htype === "line") {
                // 线对齐模式：对应线变亮，其他线变暗，格子不亮
                dimAllLines();
                const el = svgLineEls[hkey];
                el.setAttribute("stroke", GOLD);
                el.setAttribute("stroke-width", "3");
                el.style.filter = `drop-shadow(0 0 6px ${GOLD}aa)`;
                centerDot.setAttribute("fill", GOLD);
                overlay.style.cursor = "pointer";
                if (tipEl) tipEl.style.opacity = "0";
            } else if (htype === "zone") {
                // 区域分布模式：对应两个格子亮起，线条变暗
                dimAllLines();
                const z = ZONES[hkey];
                z.quads.forEach(qi => {
                    const el = svgQuadEls[qi];
                    el.setAttribute("fill", QZONE_BG);
                    el.setAttribute("stroke", QZONE_BORDER);
                    el.setAttribute("stroke-width", "1");
                });
                centerDot.setAttribute("fill", GOLD);
                if (centerGlow) centerGlow.setAttribute("opacity", "0");
                overlay.style.cursor = "pointer";
                // 显示提示文字
                if (tipEl) {
                    const tips = {
                        z_left: "上下等分",
                        z_right: "上下等距",
                        z_top: "左右等分",
                        z_bottom: "左右等距"
                    };
                    tipEl.textContent = tips[hkey] || "";
                    tipEl.style.color = GOLD;
                    tipEl.style.textShadow = `0 0 6px rgba(0,0,0,0.9), 0 0 12px ${hexToRgba(THEME_COLOR, 0.5)}`;
                    // 重置transform
                    tipEl.style.left = "50%";
                    tipEl.style.top = "50%";
                    tipEl.style.transform = "translate(-50%,-50%)";
                    if (hkey === "z_left" || hkey === "z_right") {
                        tipEl.style.writingMode = "vertical-rl";
                        tipEl.style.textOrientation = "upright";
                        // 竖排：左右区域的文字放在对应半边，避开中心线
                        if (hkey === "z_left") {
                            tipEl.style.left = (PAD + (CX - PAD) / 2) + "px";
                        } else {
                            tipEl.style.left = (CX + (CX - PAD) / 2) + "px";
                        }
                        tipEl.style.transform = "translate(-50%, calc(-50% + 6px))";
                    } else {
                        tipEl.style.writingMode = "horizontal-tb";
                        tipEl.style.textOrientation = "initial";
                        // 横排：上下区域的文字放在对应半边，避开中心线
                        if (hkey === "z_top") {
                            tipEl.style.top = (PAD + (CY - PAD) / 2) + "px";
                        } else {
                            tipEl.style.top = (CY + (CY - PAD) / 2) + "px";
                        }
                        tipEl.style.transform = "translate(calc(-50% + 6px),-50%)";
                    }
                    tipEl.style.opacity = "1";
                }
            } else if (htype === "center") {
                // 中心模式：中心发光 + 所有线和格子变暗
                dimAllLines();
                svgQuadEls.forEach(el => {
                    el.setAttribute("fill", "none");
                    el.setAttribute("stroke", "none");
                });
                centerDot.setAttribute("fill", GOLD);
                if (centerGlow) centerGlow.setAttribute("opacity", "1");
                overlay.style.cursor = "pointer";
                if (tipEl) tipEl.style.opacity = "0";
            }
        }

        function executeAction(htype, hkey) {
            if (!htype) { closeTianPanel(); return; }
            if (getSelectedNodes().length < 2) { closeTianPanel(); return; }
            if (htype === "line") {
                const fn = ALIGN_FN[hkey];
                if (fn) fn();
            } else if (htype === "zone") {
                const fn = ZONE_FN[hkey];
                if (fn) fn();
            } else if (htype === "center") {
                centerSameSize();
            }
            closeTianPanel();
        }

        // --- 构建面板 ---
        function buildTianPanel() {
            if (tianPanel) return;
            tianPanel = document.createElement("div");
            tianPanel.id = "gjj-tian-align-panel";
            tianPanel.style.cssText = `
                display:none; position:fixed; z-index:10000;
                width:${TIAN_SIZE}px; height:${TIAN_SIZE}px;
                left:50%; top:50%;
                margin-left:-${TIAN_SIZE/2}px; margin-top:-${TIAN_SIZE/2}px;
                user-select:none;
                border-radius:14px;
                background: rgba(18,18,18,0.65);
                border: 1.5px solid rgba(194,194,194,0.28);
                box-shadow: 0 8px 40px rgba(0,0,0,0.55);
                backdrop-filter: blur(10px);
            `;

            const svgNS = "http://www.w3.org/2000/svg";
            const svg = document.createElementNS(svgNS, "svg");
            svg.setAttribute("width", TIAN_SIZE);
            svg.setAttribute("height", TIAN_SIZE);
            svg.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;display:block;";

            // 外框
            frameEl = document.createElementNS(svgNS, "rect");
            frameEl.setAttribute("x", PAD-5); frameEl.setAttribute("y", PAD-5);
            frameEl.setAttribute("width", TIAN_SIZE - 2*(PAD-5));
            frameEl.setAttribute("height", TIAN_SIZE - 2*(PAD-5));
            frameEl.setAttribute("rx", "8");
            frameEl.setAttribute("fill", "none");
            frameEl.setAttribute("stroke", "rgba(194,194,194,0.1)");
            frameEl.setAttribute("stroke-width", "1");
            svg.appendChild(frameEl);

            // 对角线装饰
            [[PAD,PAD,TIAN_SIZE-PAD,TIAN_SIZE-PAD],[TIAN_SIZE-PAD,PAD,PAD,TIAN_SIZE-PAD]].forEach(([x1,y1,x2,y2])=>{
                const d = document.createElementNS(svgNS,"line");
                d.setAttribute("x1",x1);d.setAttribute("y1",y1);
                d.setAttribute("x2",x2);d.setAttribute("y2",y2);
                d.setAttribute("stroke","rgba(194,194,194,0.06)");
                d.setAttribute("stroke-width","1");
                d.setAttribute("stroke-dasharray","3,5");
                svg.appendChild(d);
            });

            // 4个格子 (可高亮，先画在线下面)
            const quadDefs = [
                { x: PAD, y: PAD, w: CX-PAD, h: CY-PAD },      // 0 左上
                { x: CX,  y: PAD, w: CX-PAD, h: CY-PAD },      // 1 右上
                { x: PAD, y: CY,  w: CX-PAD, h: CY-PAD },      // 2 左下
                { x: CX,  y: CY,  w: CX-PAD, h: CY-PAD },      // 3 右下
            ];
            svgQuadEls = [];
            quadDefs.forEach(q => {
                const rect = document.createElementNS(svgNS, "rect");
                rect.setAttribute("x", q.x);
                rect.setAttribute("y", q.y);
                rect.setAttribute("width", q.w);
                rect.setAttribute("height", q.h);
                rect.setAttribute("fill", "none");
                rect.setAttribute("stroke", "none");
                rect.setAttribute("rx", "3");
                svg.appendChild(rect);
                svgQuadEls.push(rect);
            });

            // 6条线
            function mkLine(x1,y1,x2,y2,key) {
                const l = document.createElementNS(svgNS,"line");
                l.setAttribute("x1",x1);l.setAttribute("y1",y1);
                l.setAttribute("x2",x2);l.setAttribute("y2",y2);
                l.setAttribute("stroke",LINE_COLOR);
                l.setAttribute("stroke-width","1.5");
                l.setAttribute("stroke-linecap","round");
                svg.appendChild(l);
                svgLineEls[key] = l;
            }
            mkLine(PAD, PAD, PAD, TIAN_SIZE-PAD, "v_left");
            mkLine(CX,  PAD, CX,  TIAN_SIZE-PAD, "v_mid");
            mkLine(TIAN_SIZE-PAD, PAD, TIAN_SIZE-PAD, TIAN_SIZE-PAD, "v_right");
            mkLine(PAD, PAD, TIAN_SIZE-PAD, PAD, "h_top");
            mkLine(PAD, CY,  TIAN_SIZE-PAD, CY,  "h_mid");
            mkLine(PAD, TIAN_SIZE-PAD, TIAN_SIZE-PAD, TIAN_SIZE-PAD, "h_bottom");

            // 中心圆点
            centerDot = document.createElementNS(svgNS, "circle");
            centerDot.setAttribute("cx", CX); centerDot.setAttribute("cy", CY);
            centerDot.setAttribute("r", "3.5");
            centerDot.setAttribute("fill", "rgba(194,194,194,0.5)");
            svg.appendChild(centerDot);

            // 中心发光环 (悬停时显示)
            centerGlow = document.createElementNS(svgNS, "circle");
            centerGlow.setAttribute("cx", CX); centerGlow.setAttribute("cy", CY);
            centerGlow.setAttribute("r", CENTER_RADIUS);
            centerGlow.setAttribute("fill", hexToRgba(THEME_COLOR, 0.12));
            centerGlow.setAttribute("stroke", hexToRgba(THEME_COLOR, 0.6));
            centerGlow.setAttribute("stroke-width", "1.5");
            centerGlow.setAttribute("opacity", "0");
            centerGlow.style.filter = `drop-shadow(0 0 8px ${hexToRgba(THEME_COLOR, 0.67)})`;
            svg.appendChild(centerGlow);

            // 长按进度环（扩张动画）
            pressRing = document.createElementNS(svgNS, "circle");
            pressRing.setAttribute("cx", CX); pressRing.setAttribute("cy", CY);
            pressRing.setAttribute("r", CENTER_RADIUS);
            pressRing.setAttribute("fill", "none");
            pressRing.setAttribute("stroke", GOLD);
            pressRing.setAttribute("stroke-width", "2");
            pressRing.setAttribute("opacity", "0");
            pressRing.style.filter = `drop-shadow(0 0 6px ${hexToRgba(THEME_COLOR, 0.7)})`;
            svg.appendChild(pressRing);

            // 尺子（拖拽时显示）
            dirArrow = document.createElementNS(svgNS, "g");
            dirArrow.setAttribute("opacity", "0");
            // 尺子主体（长条矩形，居中）
            const rulerBody = document.createElementNS(svgNS, "rect");
            rulerBody.setAttribute("x", -8); rulerBody.setAttribute("y", -30);
            rulerBody.setAttribute("width", 16); rulerBody.setAttribute("height", 60);
            rulerBody.setAttribute("rx", 3);
            rulerBody.setAttribute("fill", "rgba(30,30,30,0.85)");
            rulerBody.setAttribute("stroke", GOLD);
            rulerBody.setAttribute("stroke-width", "1.5");
            rulerBody.style.filter = `drop-shadow(0 0 6px ${hexToRgba(THEME_COLOR, 0.5)})`;
            dirArrow.appendChild(rulerBody);
            // 中心0刻度
            const zeroTick = document.createElementNS(svgNS, "line");
            zeroTick.setAttribute("x1", -8); zeroTick.setAttribute("y1", 0);
            zeroTick.setAttribute("x2", 8); zeroTick.setAttribute("y2", 0);
            zeroTick.setAttribute("stroke", GOLD);
            zeroTick.setAttribute("stroke-width", "1.5");
            dirArrow.appendChild(zeroTick);
            // 刻度线（向两侧对称）
            for (let i = 1; i <= 3; i++) {
                const y = i * 10;
                const isLong = i % 2 === 0;
                // 正向
                const t1 = document.createElementNS(svgNS, "line");
                t1.setAttribute("x1", -8); t1.setAttribute("y1", y);
                t1.setAttribute("x2", isLong ? 8 : -4); t1.setAttribute("y2", y);
                t1.setAttribute("stroke", GOLD); t1.setAttribute("stroke-width", "1"); t1.setAttribute("opacity", "0.7");
                dirArrow.appendChild(t1);
                // 负向
                const t2 = document.createElementNS(svgNS, "line");
                t2.setAttribute("x1", -8); t2.setAttribute("y1", -y);
                t2.setAttribute("x2", isLong ? 8 : -4); t2.setAttribute("y2", -y);
                t2.setAttribute("stroke", GOLD); t2.setAttribute("stroke-width", "1"); t2.setAttribute("opacity", "0.7");
                dirArrow.appendChild(t2);
            }
            // 定位到中心
            dirArrow.setAttribute("transform", `translate(${CX}, ${CY})`);
            svg.appendChild(dirArrow);

            tianPanel.appendChild(svg);

            // 提示文字
            const tipEl = document.createElement("div");
            tipEl.id = "gjj-tian-align-tip";
            tipEl.style.cssText = `
                position:absolute; left:50%; top:50%;
                transform:translate(-50%,-50%);
                color:#fff; font-size:18px; font-family:"Microsoft YaHei",sans-serif;
                pointer-events:none;
                text-shadow:0 0 6px rgba(0,0,0,0.9), 0 0 10px rgba(255,215,0,0.3);
                opacity:0; transition:opacity 0.2s ease;
                font-weight:500;
                letter-spacing:12px;
                white-space:nowrap;
            `;
            tianPanel.appendChild(tipEl);

            // 交互覆盖层
            overlay = document.createElement("div");
            overlay.style.cssText = `
                position:absolute;left:0;top:0;
                width:100%;height:100%;
                cursor:default;
                border-radius:14px;
            `;
            function getLocal(e) {
                const r = overlay.getBoundingClientRect();
                return { x: e.clientX - r.left, y: e.clientY - r.top };
            }
            function isInCenter(x, y) {
                return Math.hypot(x - CX, y - CY) < CENTER_RADIUS;
            }

            function updateArrow(dx, dy, confirmed) {
                if (!dirArrow) return;
                const absDx = Math.abs(dx), absDy = Math.abs(dy);
                const dist = Math.hypot(dx, dy);
                if (dist < 4) { dirArrow.setAttribute("opacity", "0"); return; }
                dirArrow.setAttribute("opacity", "1");

                // 只允许水平或垂直方向（吸附到最近的轴）
                let angle, showDist, isHorizontal;
                if (absDx >= absDy) {
                    isHorizontal = true;
                    angle = dx >= 0 ? 90 : -90; // 朝右或朝左
                    showDist = absDx;
                } else {
                    isHorizontal = false;
                    angle = dy >= 0 ? 180 : 0; // 朝下或朝上
                    showDist = absDy;
                }

                // 超出阈值时更亮
                const overThreshold = showDist >= DRAG_THRESHOLD;
                const color = overThreshold ? GOLD : hexToRgba(THEME_COLOR, 0.8);
                const bodyFill = overThreshold ? "rgba(30,30,30,0.9)" : "rgba(30,30,30,0.75)";

                // 尺子长度：根据拖动距离，向两侧对称延伸
                const halfLen = Math.min(45, Math.max(17, showDist));
                const rulerW = 16;

                // 更新尺子主体（居中，上下/左右对称）
                const body = dirArrow.querySelector("rect");
                if (body) {
                    body.setAttribute("x", -rulerW/2);
                    body.setAttribute("y", -halfLen);
                    body.setAttribute("height", halfLen * 2);
                    body.setAttribute("fill", bodyFill);
                    body.setAttribute("stroke", color);
                    body.style.filter = `drop-shadow(0 0 ${overThreshold ? 8 : 5}px ${hexToRgba(THEME_COLOR, overThreshold ? 0.7 : 0.4)})`;
                }

                // 更新刻度线 - 先清除旧的再重画
                const oldTicks = dirArrow.querySelectorAll("line");
                oldTicks.forEach(t => t.remove());

                // 重新画刻度（从中心向两侧对称）
                const tickCount = Math.floor(halfLen / 10);
                const svgNS = "http://www.w3.org/2000/svg";
                // 0刻度（中心）
                const zeroTick = document.createElementNS(svgNS, "line");
                zeroTick.setAttribute("x1", -rulerW/2); zeroTick.setAttribute("y1", 0);
                zeroTick.setAttribute("x2", rulerW/2); zeroTick.setAttribute("y2", 0);
                zeroTick.setAttribute("stroke", color);
                zeroTick.setAttribute("stroke-width", "1.5");
                dirArrow.insertBefore(zeroTick, dirArrow.firstChild?.nextSibling || null);

                for (let i = 1; i <= tickCount; i++) {
                    const y = i * 10;
                    if (y > halfLen - 2) break;
                    const isLong = i % 2 === 0;
                    // 正向刻度
                    const tick1 = document.createElementNS(svgNS, "line");
                    tick1.setAttribute("x1", -rulerW/2);
                    tick1.setAttribute("y1", y);
                    tick1.setAttribute("x2", isLong ? rulerW/2 : -rulerW/2 + 4);
                    tick1.setAttribute("y2", y);
                    tick1.setAttribute("stroke", color);
                    tick1.setAttribute("stroke-width", "1");
                    tick1.setAttribute("opacity", overThreshold ? "0.9" : "0.6");
                    dirArrow.insertBefore(tick1, dirArrow.firstChild?.nextSibling || null);
                    // 负向刻度（对称）
                    const tick2 = document.createElementNS(svgNS, "line");
                    tick2.setAttribute("x1", -rulerW/2);
                    tick2.setAttribute("y1", -y);
                    tick2.setAttribute("x2", isLong ? rulerW/2 : -rulerW/2 + 4);
                    tick2.setAttribute("y2", -y);
                    tick2.setAttribute("stroke", color);
                    tick2.setAttribute("stroke-width", "1");
                    tick2.setAttribute("opacity", overThreshold ? "0.9" : "0.6");
                    dirArrow.insertBefore(tick2, dirArrow.firstChild?.nextSibling || null);
                }

                dirArrow.setAttribute("transform",
                    `translate(${CX}, ${CY}) rotate(${angle})`);
            }

            let pressRAF = null;
            let successRAF = null;
            function updatePressRing(progress) {
                if (!pressRing) return;
                const r = CENTER_RADIUS + 6;
                pressRing.setAttribute("r", r);
                pressRing.setAttribute("stroke", GOLD);
                pressRing.setAttribute("opacity", 0.5 + progress * 0.5);
                const circumference = 2 * Math.PI * r;
                pressRing.setAttribute("stroke-dasharray", circumference);
                pressRing.setAttribute("stroke-dashoffset", circumference * (1 - progress));
                pressRing.style.filter = `drop-shadow(0 0 ${4 + progress * 6}px ${hexToRgba(THEME_COLOR, 0.6 + progress * 0.4)})`;
            }
            function playSuccessAnimation() {
                if (successRAF) cancelAnimationFrame(successRAF);
                const startTime = performance.now();
                const duration = 300;
                function tick() {
                    const elapsed = performance.now() - startTime;
                    const t = Math.min(1, elapsed / duration);
                    const easeOut = 1 - Math.pow(1 - t, 3);
                    if (pressRing) {
                        pressRing.setAttribute("opacity", 1 - easeOut);
                        pressRing.setAttribute("stroke-width", 2 + easeOut * 3);
                    }
                    if (centerGlow) {
                        centerGlow.setAttribute("opacity", 1 - easeOut * 0.5);
                    }
                    if (t < 1) {
                        successRAF = requestAnimationFrame(tick);
                    }
                }
                successRAF = requestAnimationFrame(tick);
            }
            function startLongPress() {
                if (pressTimer) clearTimeout(pressTimer);
                if (pressRAF) cancelAnimationFrame(pressRAF);
                if (successRAF) cancelAnimationFrame(successRAF);
                pressStartTime = performance.now();
                if (pressRing) {
                    pressRing.setAttribute("opacity", "0.5");
                    pressRing.setAttribute("r", CENTER_RADIUS + 6);
                    pressRing.setAttribute("stroke-width", "2");
                    pressRing.setAttribute("stroke-dashoffset", 2 * Math.PI * (CENTER_RADIUS + 6));
                    pressRing.setAttribute("transform-origin", `${CX}px ${CY}px`);
                    pressRing.setAttribute("transform", "rotate(-90deg)");
                }
                function tick() {
                    const elapsed = performance.now() - pressStartTime;
                    const progress = Math.min(1, elapsed / LONG_PRESS_MS);
                    updatePressRing(progress);
                    const pulse = 0.8 + 0.2 * Math.sin(elapsed / 180);
                    if (centerGlow) {
                        centerGlow.setAttribute("opacity", pulse);
                    }
                    if (progress < 1 && centerDrag && centerDrag.active && !centerDrag.dragging) {
                        pressRAF = requestAnimationFrame(tick);
                    }
                }
                pressRAF = requestAnimationFrame(tick);
                pressTimer = setTimeout(() => {
                    if (centerDrag && centerDrag.active && !centerDrag.dragging) {
                        playSuccessAnimation();
                        if (getSelectedNodes().length >= 2) {
                            setTimeout(() => {
                                autoArrange();
                            }, 120);
                        }
                        setTimeout(() => {
                            cancelLongPress();
                            closeTianPanel();
                        }, 280);
                    }
                }, LONG_PRESS_MS);
            }
            function cancelLongPress() {
                if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
                if (pressRAF) { cancelAnimationFrame(pressRAF); pressRAF = null; }
                if (successRAF) { cancelAnimationFrame(successRAF); successRAF = null; }
                if (pressRing) {
                    pressRing.setAttribute("opacity", "0");
                    pressRing.setAttribute("stroke-width", "2");
                    pressRing.setAttribute("transform", "rotate(-90deg)");
                }
            }

            overlay.addEventListener("mousemove", (e) => {
                const { x, y } = getLocal(e);

                if (centerDrag && centerDrag.active) {
                    const dx = x - centerDrag.startX;
                    const dy = y - centerDrag.startY;
                    centerDrag.lastDx = dx;
                    centerDrag.lastDy = dy;

                    const dist = Math.hypot(dx, dy);
                    // 超过轻微移动阈值才显示尺子（区分单击和拖拽）
                    if (dist >= 5) {
                        if (!centerDrag.dragging) {
                            centerDrag.dragging = true;
                            cancelLongPress();
                        }
                        updateArrow(dx, dy, false);
                    }
                    // 保持中心发光
                    if (centerGlow) centerGlow.setAttribute("opacity", "1");
                    if (centerDot) centerDot.setAttribute("fill", GOLD);
                    return;
                }

                const r = hitTest(x, y);
                setHover(r.type, r.key);
            });
            overlay.addEventListener("mouseleave", () => {
                if (centerDrag && centerDrag.active) return;
                setHover(null, null);
            });
            overlay.addEventListener("mousedown", (e) => {
                if (e.button !== 0) return;
                if (colorMenuOpen) { hideColorMenu(); return; }
                const { x, y } = getLocal(e);
                if (isInCenter(x, y)) {
                    e.preventDefault();
                    e.stopPropagation();
                    centerDrag = { startX: x, startY: y, active: true, dragging: false };
                    setHover("center", "center");
                    startLongPress();
                }
            });
            overlay.addEventListener("click", (e) => {
                if (colorMenuOpen) { hideColorMenu(); return; }
                if (centerDrag && centerDrag.justDragged) {
                    centerDrag.justDragged = false;
                    return;
                }
                const { x, y } = getLocal(e);
                // 中心区域点击不执行操作（需要拖拽）
                if (isInCenter(x, y)) return;
                const r = hitTest(x, y);
                executeAction(r.type, r.key);
            });
            document.addEventListener("mouseup", () => {
                if (centerDrag && centerDrag.active) {
                    cancelLongPress();

                    if (centerDrag.dragging) {
                        const dx = centerDrag.lastDx || 0;
                        const dy = centerDrag.lastDy || 0;
                        const absDx = Math.abs(dx), absDy = Math.abs(dy);
                        const showDist = Math.max(absDx, absDy);
                        const hadAction = showDist >= DRAG_THRESHOLD && getSelectedNodes().length >= 2;

                        if (hadAction) {
                            if (absDx >= absDy) {
                                sameWidth();
                            } else {
                                sameHeight();
                            }
                        }

                        centerDrag = null;
                        if (dirArrow) dirArrow.setAttribute("opacity", "0");
                        if (hadAction) {
                            closeTianPanel();
                        } else {
                            setHover(null, null);
                        }
                    } else {
                        // 没有拖拽，是短按（未达2秒）→ 不执行任何操作
                        centerDrag = null;
                        setHover(null, null);
                    }
                }
            });
            overlay.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (centerDrag && centerDrag.active) {
                    cancelLongPress();
                    centerDrag = null;
                    if (dirArrow) dirArrow.setAttribute("opacity", "0");
                }
                setHover(null, null);
                showColorMenu(e.clientX, e.clientY);
            });

            tianPanel.appendChild(overlay);
            document.body.appendChild(tianPanel);
        }

        function openTianPanel() {
            buildTianPanel();
            setHover(null, null);
            tianPanel.style.display = "block";
            tianIsOpen = true;
        }
        function closeTianPanel() {
            if (!tianPanel) return;
            tianPanel.style.display = "none";
            tianIsOpen = false;
            hoveredType = null;
            hoveredKey = null;
            centerDrag = null;
            if (dirArrow) dirArrow.setAttribute("opacity", "0");
            if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
            if (pressRing) pressRing.setAttribute("opacity", "0");
            hideColorMenu();
        }
        function toggleTianPanel() {
            if (tianIsOpen) closeTianPanel();
            else {
                if (getSelectedNodes().length < 2) return;
                openTianPanel();
            }
        }

        window.__gjj_tian_align_close = closeTianPanel;

        // --- 键盘 ---
        document.addEventListener("keydown", (e) => {
            if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
            if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === "a") {
                e.preventDefault();
                e.stopImmediatePropagation();
                toggleTianPanel();
                return;
            }
            if (e.key === "Escape" && tianIsOpen) {
                e.preventDefault();
                if (colorMenuOpen) { hideColorMenu(); return; }
                closeTianPanel();
            }
        }, true);

        // 点击外部关闭
        document.addEventListener("pointerdown", (e) => {
            if (colorMenuOpen) {
                if (e.target.closest("#gjj-tian-align-color-menu")) return;
                hideColorMenu();
                return;
            }
            if (!tianIsOpen) return;
            if (e.target.closest("#gjj-tian-align-panel")) return;
            closeTianPanel();
        }, true);

        console.log("[GJJ] 田字格对齐面板已加载 (Alt+A)");
    }
});
