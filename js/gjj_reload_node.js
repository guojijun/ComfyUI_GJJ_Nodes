import { app } from "/scripts/app.js";

/**
 * GJJ 节点右键菜单扩展
 * 为所有 GJJ 节点添加 "Reload Node" 右键菜单选项
 */

(function () {
    const GJJ_PREFIX = "GJJ";

    /**
     * 检查节点是否为 GJJ 节点
     */
    function isGJJNode(node) {
        if (!node) return false;
        const className = node.comfyClass || node.type || "";
        return String(className).startsWith(GJJ_PREFIX);
    }

    function cloneData(value) {
        try {
            return structuredClone(value);
        } catch (_) {
            try {
                return JSON.parse(JSON.stringify(value));
            } catch (_) {
                return value;
            }
        }
    }

    function slotTypeText(slot) {
        return String(slot?.type || "*");
    }

    function splitTypes(type) {
        return String(type || "*")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
    }

    function typesCompatible(a, b) {
        const left = splitTypes(a);
        const right = splitTypes(b);
        if (!left.length || !right.length || left.includes("*") || right.includes("*")) {
            return true;
        }
        return left.some((item) => right.includes(item));
    }

    function slotName(slot) {
        return String(slot?.name || slot?.label || slot?.localized_name || "");
    }

    function normalizeText(value) {
        return String(value ?? "").toLowerCase().trim();
    }

    function normalizedSlotName(slot) {
        return normalizeText(slotName(slot).replace(/[：:]/g, "").replace(/\s+/g, ""));
    }

    function findCompatibleSlot(slots, sourceSlot, _preferredIndex, used = new Set()) {
        const list = Array.isArray(slots) ? slots : [];
        const sourceName = normalizedSlotName(sourceSlot);
        const sourceType = slotTypeText(sourceSlot);
        const exact = list.findIndex((slot, index) => !used.has(index) && normalizedSlotName(slot) === sourceName && typesCompatible(slotTypeText(slot), sourceType));
        if (exact >= 0) return exact;
        const byName = list.findIndex((slot, index) => !used.has(index) && sourceName && normalizedSlotName(slot) === sourceName);
        if (byName >= 0) return byName;
        const byType = list
            .map((slot, index) => ({ slot, index }))
            .filter((item) => !used.has(item.index) && typesCompatible(slotTypeText(item.slot), sourceType));
        if (byType.length === 1) return byType[0].index;
        const strictByType = list
            .map((slot, index) => ({ slot, index }))
            .filter((item) => !used.has(item.index) && slotTypeText(item.slot) === sourceType);
        if (strictByType.length === 1) return strictByType[0].index;
        return -1;
    }

    function stripSerializedLinks(nodeData) {
        const data = cloneData(nodeData) || {};
        if (Array.isArray(data.inputs)) {
            for (const input of data.inputs) {
                if (input) input.link = null;
            }
        }
        if (Array.isArray(data.outputs)) {
            for (const output of data.outputs) {
                if (output) output.links = [];
            }
        }
        return data;
    }

    function collectConnections(node, graph) {
        const links = graph?.links || {};
        const inputs = [];
        const outputs = [];

        for (let i = 0; i < (node.inputs || []).length; i++) {
            const input = node.inputs[i];
            const link = links[input?.link];
            if (!link) continue;
            inputs.push({
                slot: cloneData(input),
                slotIndex: i,
                originId: link.origin_id,
                originSlot: link.origin_slot,
            });
        }

        for (let i = 0; i < (node.outputs || []).length; i++) {
            const output = node.outputs[i];
            for (const linkId of output?.links || []) {
                const link = links[linkId];
                if (!link) continue;
                outputs.push({
                    slot: cloneData(output),
                    slotIndex: i,
                    targetId: link.target_id,
                    targetSlot: link.target_slot,
                });
            }
        }

        return { inputs, outputs };
    }

    function restoreWidgetValues(newNode, widgetSnapshot = []) {
        const widgets = Array.isArray(newNode?.widgets) ? newNode.widgets : [];
        const serializedWidgets = Array.isArray(widgetSnapshot) ? widgetSnapshot : [];
        for (const widget of widgets) {
            const name = String(widget?.name || "");
            const sourceWidget = name ? serializedWidgets.find((item) => String(item?.name || "") === name) : null;
            if (!sourceWidget || sourceWidget.value === undefined) continue;
            const restoredValue = validWidgetValue(widget, sourceWidget.value);
            if (!restoredValue.valid) continue;
            try {
                widget.value = restoredValue.value;
                widget.callback?.(widget.value, app.canvas, newNode, undefined, widget);
            } catch (_) {}
        }
    }

    function comboValues(widget) {
        const values = widget?.options?.values || widget?.options?.values_list || widget?.options?.items || widget?.values;
        return Array.isArray(values) ? values.map((item) => String(item)) : [];
    }

    function validWidgetValue(widget, value) {
        const type = String(widget?.type || "").toLowerCase();
        const values = comboValues(widget);
        if (type === "combo" || values.length) {
            const index = values.indexOf(String(value));
            return index >= 0 ? { valid: true, value: values[index] } : { valid: false };
        }
        if (type === "number" || type === "slider") {
            const numeric = Number(value);
            if (!Number.isFinite(numeric)) return { valid: false };
            const min = widget?.options?.min;
            const max = widget?.options?.max;
            if (Number.isFinite(Number(min)) && numeric < Number(min)) return { valid: false };
            if (Number.isFinite(Number(max)) && numeric > Number(max)) return { valid: false };
            return { valid: true, value: numeric };
        }
        if (type === "toggle" || type === "boolean") {
            return typeof value === "boolean" ? { valid: true, value } : { valid: false };
        }
        if (type === "text" || type === "string") {
            return typeof value === "string" ? { valid: true, value } : { valid: false };
        }
        return { valid: true, value };
    }

    function configureWithDefaults(nodeData, newNode) {
        const configureData = stripSerializedLinks(nodeData);
        configureData.id = nodeData.id;
        // LiteGraph 按 widget 下标恢复；节点升级后旧数组不能先写进新控件。
        configureData.widgets_values = (newNode.widgets || []).map((widget) => cloneData(widget?.value));
        return configureData;
    }

    function restoreConnections(graph, newNode, saved) {
        const inputUsed = new Set();
        for (const item of saved.inputs || []) {
            const sourceNode = graph.getNodeById?.(item.originId);
            if (!sourceNode) continue;
            const targetSlot = findCompatibleSlot(newNode.inputs, item.slot, item.slotIndex, inputUsed);
            if (targetSlot < 0) continue;
            try {
                sourceNode.connect(item.originSlot, newNode, targetSlot);
                inputUsed.add(targetSlot);
            } catch (error) {
                console.warn("[GJJ_ReloadNode] 输入连接恢复失败:", error);
            }
        }

        for (const item of saved.outputs || []) {
            const targetNode = graph.getNodeById?.(item.targetId);
            if (!targetNode) continue;
            const outputSlot = findCompatibleSlot(newNode.outputs, item.slot, item.slotIndex);
            if (outputSlot < 0) continue;
            try {
                newNode.connect(outputSlot, targetNode, item.targetSlot);
            } catch (error) {
                console.warn("[GJJ_ReloadNode] 输出连接恢复失败:", error);
            }
        }
    }

    function selectReloadedNode(newNode) {
        const canvas = app.canvas;
        if (!canvas || !newNode) return;
        if (typeof canvas.deselectAllNodes === "function") {
            canvas.deselectAllNodes();
        } else if (typeof canvas.deselectAll === "function") {
            canvas.deselectAll();
        }
        for (const item of app.graph?._nodes || []) {
            item.selected = false;
        }
        newNode.selected = true;
        canvas.selected_nodes = {};
        canvas.selected_nodes[newNode.id] = newNode;
        if (typeof canvas.setSelectedNodes === "function") {
            canvas.setSelectedNodes(canvas.selected_nodes);
        } else if (typeof canvas.selectNode === "function") {
            canvas.selectNode(newNode, false);
        }
    }

    /**
     * 重新加载节点
     * 通过序列化和反序列化来刷新节点状态
     */
    function reloadNode(node) {
        if (!node || !node.graph) return;

        try {
            console.log(`[GJJ_ReloadNode] 重新加载节点: ${node.comfyClass || node.type} (ID: ${node.id})`);

            // 保存当前节点的位置、参数、动态插槽和完整连接端点。
            const nodeData = node.serialize();
            const widgetSnapshot = (node.widgets || []).map((widget) => ({
                name: widget?.name,
                type: widget?.type,
                value: cloneData(widget?.value),
            }));
            const oldId = node.id;
            const posX = nodeData.pos?.[0] || node.pos?.[0] || 0;
            const posY = nodeData.pos?.[1] || node.pos?.[1] || 0;
            const size = nodeData.size || node.size;
            const flags = nodeData.flags || {};
            const properties = nodeData.properties || {};

            // 获取图
            const graph = node.graph;
            const savedConnections = collectConnections(node, graph);

            // 先创建新节点；如果创建失败，不动旧节点，避免工作流丢失。
            const newNode = LiteGraph.createNode(nodeData.type);
            if (!newNode) {
                console.error(`[GJJ_ReloadNode] 无法创建节点: ${nodeData.type}`);
                return;
            }
            const configureData = configureWithDefaults(nodeData, newNode);
            configureData.id = oldId;

            // 删除旧节点
            graph.remove(node);

            // 尽量保留原 ID，避免其它前端状态引用失效。
            newNode.id = oldId;
            graph.add(newNode);

            // 让节点自己的 onConfigure 先恢复动态插槽、隐藏状态和自定义属性。
            if (typeof newNode.configure === "function") {
                try {
                    newNode.configure(configureData);
                } catch (error) {
                    console.warn("[GJJ_ReloadNode] configure 恢复失败，继续使用手动参数恢复:", error);
                }
            }

            // 恢复基础外观和位置，避免 configure 中被默认值覆盖。
            newNode.pos = [posX, posY];
            if (size) newNode.size = size;
            newNode.flags = { ...(newNode.flags || {}), ...flags };
            if (nodeData.title && nodeData.title !== nodeData.type) newNode.title = nodeData.title;
            if (nodeData.color) newNode.color = nodeData.color;
            if (nodeData.bgcolor) newNode.bgcolor = nodeData.bgcolor;
            if (nodeData.boxcolor) newNode.boxcolor = nodeData.boxcolor;
            if (properties && Object.keys(properties).length > 0) newNode.properties = { ...(newNode.properties || {}), ...properties };

            // 仅按同名字段写回合法值；字段已移除、改名或旧值非法时保持新默认值。
            restoreWidgetValues(newNode, widgetSnapshot);

            // 恢复折叠标记，但不调用 collapse()，避免不同版本里变成切换折叠。
            if (node?.flags?.collapsed !== undefined) {
                newNode.flags = { ...(newNode.flags || {}), collapsed: Boolean(node.flags.collapsed) };
            } else if (flags.collapsed !== undefined) {
                newNode.flags = { ...(newNode.flags || {}), collapsed: Boolean(flags.collapsed) };
            }

            // 恢复连接：同名同类型优先，其次按唯一兼容类型；不再按顺序乱接。
            restoreConnections(graph, newNode, savedConnections);

            // 选中新节点
            selectReloadedNode(newNode);

            // 刷新画布
            app.canvas?.setDirty?.(true, true);
            graph.setDirtyCanvas?.(true, true);

            console.log(`[GJJ_ReloadNode] 节点重新加载完成: ${newNode.comfyClass || newNode.type} (ID: ${newNode.id})`);
        } catch (error) {
            console.error(`[GJJ_ReloadNode] 重新加载节点失败:`, error);
        }
    }

    /**
     * 为 GJJ 节点添加右键菜单选项
     */
    function addReloadMenuOption(node, options) {
        if (!isGJJNode(node)) return;

        // 在菜单顶部添加分隔线和重新加载选项
        options.unshift(null);
        options.unshift({
            content: "🔄 重新加载节点",
            callback: () => {
                reloadNode(node);
            },
        });
    }

    /**
     * 注册扩展
     */
    app.registerExtension({
        name: "GJJ.ReloadNodeMenu",

        async beforeRegisterNodeDef(nodeType, nodeData) {
            // 只为 GJJ 节点添加右键菜单
            if (!String(nodeData?.name || "").startsWith(GJJ_PREFIX)) {
                return;
            }

            // 保存原始的 getExtraMenuOptions
            const originalGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;

            // 重写 getExtraMenuOptions
            nodeType.prototype.getExtraMenuOptions = function (_, options) {
                // 调用原始方法
                if (originalGetExtraMenuOptions) {
                    originalGetExtraMenuOptions.call(this, _, options);
                }

                // 添加重新加载选项
                addReloadMenuOption(this, options);
            };
        },

        async setup() {
            console.log("[GJJ_ReloadNodeMenu] ✅ GJJ 节点右键重新加载功能已启用");
        },
    });
})();
