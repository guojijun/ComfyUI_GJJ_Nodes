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

    /**
     * 重新加载节点
     * 通过序列化和反序列化来刷新节点状态
     */
    function reloadNode(node) {
        if (!node || !node.graph) return;

        try {
            console.log(`[GJJ_ReloadNode] 重新加载节点: ${node.comfyClass || node.type} (ID: ${node.id})`);

            // 保存当前节点的位置和状态
            const nodeData = node.serialize();
            const posX = nodeData.pos?.[0] || node.pos?.[0] || 0;
            const posY = nodeData.pos?.[1] || node.pos?.[1] || 0;
            const size = nodeData.size || node.size;
            const flags = nodeData.flags || {};
            const properties = nodeData.properties || {};

            // 保存连接信息
            const inputLinks = [];
            const outputLinks = [];

            if (node.inputs) {
                for (let i = 0; i < node.inputs.length; i++) {
                    const input = node.inputs[i];
                    if (input.link !== null && input.link !== undefined) {
                        inputLinks.push({
                            slot: i,
                            linkId: input.link,
                        });
                    }
                }
            }

            if (node.outputs) {
                for (let i = 0; i < node.outputs.length; i++) {
                    const output = node.outputs[i];
                    if (output.links && output.links.length > 0) {
                        outputLinks.push({
                            slot: i,
                            linkIds: [...output.links],
                        });
                    }
                }
            }

            // 获取图
            const graph = node.graph;

            // 删除旧节点
            graph.remove(node);

            // 创建新节点
            const newNode = LiteGraph.createNode(nodeData.type);
            if (!newNode) {
                console.error(`[GJJ_ReloadNode] 无法创建节点: ${nodeData.type}`);
                return;
            }

            // 设置位置
            newNode.pos = [posX, posY];

            // 设置大小
            if (size) {
                newNode.size = size;
            }

            // 设置标志
            if (flags.collapsed !== undefined) {
                newNode.collapse(flags.collapsed);
            }

            // 设置属性
            if (properties && Object.keys(properties).length > 0) {
                newNode.properties = { ...newNode.properties, ...properties };
            }

            // 恢复 widget 值
            if (nodeData.widgets_values) {
                for (let i = 0; i < nodeData.widgets_values.length; i++) {
                    if (newNode.widgets && newNode.widgets[i]) {
                        const widget = newNode.widgets[i];
                        const value = nodeData.widgets_values[i];
                        if (widget.type === "number" || widget.type === "slider") {
                            widget.value = Number(value);
                        } else if (widget.type === "toggle" || widget.type === "boolean") {
                            widget.value = Boolean(value);
                        } else {
                            widget.value = value;
                        }
                    }
                }
            }

            // 添加到图
            graph.add(newNode);

            // 恢复输入连接
            for (const { slot, linkId } of inputLinks) {
                const link = graph.links[linkId];
                if (link) {
                    const sourceNode = graph.getNodeById(link.origin_id);
                    if (sourceNode) {
                        sourceNode.connect(link.origin_slot, newNode, slot);
                    }
                }
            }

            // 恢复输出连接
            for (const { slot, linkIds } of outputLinks) {
                for (const linkId of linkIds) {
                    const link = graph.links[linkId];
                    if (link) {
                        const targetNode = graph.getNodeById(link.target_id);
                        if (targetNode) {
                            newNode.connect(slot, targetNode, link.target_slot);
                        }
                    }
                }
            }

            // 选中新节点
            app.canvas?.selectNode?.(newNode, false);

            // 刷新画布
            app.canvas?.setDirty?.(true, true);

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
