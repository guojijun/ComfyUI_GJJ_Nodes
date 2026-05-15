/**
 * GJJ_ImageToMask 节点前端增强
 * 实现输出方式按钮组和动态输出口切换
 */

import { app } from "../../scripts/app.js";

const NODE_TYPE = "GJJ_ImageToMask";

// 输出模式配置
const OUTPUT_MODES = [
    { value: "🎭 仅遮罩", icon: "🎭", label: "仅遮罩", tooltip: "只输出 MASK 格式（节省内存）" },
    { value: "🖼️ 仅遮罩图", icon: "🖼️", label: "仅遮罩图", tooltip: "只输出 IMAGE 格式（方便预览）" },
    { value: "✨ 两者都输出", icon: "✨", label: "两者都输出", tooltip: "同时输出两种格式（最灵活）" },
];

app.registerExtension({
    name: "GJJ.ImageToMask.Enhanced",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== NODE_TYPE) {
            return;
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            // 获取 output_mode widget
            const outputModeWidget = this.widgets?.find(w => w.name === "output_mode");

            if (outputModeWidget && outputModeWidget.type === "combo") {
                // 保存原始 widget 引用
                const originalWidget = outputModeWidget;

                // 添加增强的 tooltip
                originalWidget.tooltip = "📤 输出方式选择：\n" +
                    "• 🎭 仅遮罩：MASK 格式，适合重绘\n" +
                    "• 🖼️ 仅遮罩图：IMAGE 格式，方便预览\n" +
                    "• ✨ 两者都输出：双格式输出\n\n" +
                    "💡 Ctrl/Shift 点击可快速切换";

                // 监听值变化，触发布局更新
                const originalCallback = originalWidget.callback;
                originalWidget.callback = function(value) {
                    if (originalCallback) {
                        originalCallback(value);
                    }
                    // 触发画布刷新以更新输出口显示
                    if (app.graph) {
                        app.graph.setDirtyCanvas(true, true);
                    }
                };
            }

            return result;
        };

        // 添加右键菜单选项
        const originalGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function(_, options) {
            const r = originalGetExtraMenuOptions ? originalGetExtraMenuOptions.apply(this, arguments) : undefined;

            // 添加快速切换输出模式的菜单项
            const outputModeWidget = this.widgets?.find(w => w.name === "output_mode");
            if (outputModeWidget) {
                options.push({
                    content: "🔄 循环切换输出模式",
                    callback: () => {
                        const currentIndex = OUTPUT_MODES.findIndex(m => m.value === outputModeWidget.value);
                        const nextIndex = (currentIndex + 1) % OUTPUT_MODES.length;
                        outputModeWidget.value = OUTPUT_MODES[nextIndex].value;
                        if (outputModeWidget.callback) {
                            outputModeWidget.callback(outputModeWidget.value);
                        }
                        app.graph.setDirtyCanvas(true, true);
                    },
                    has_submenu: false
                });

                // 为每个模式添加单独菜单项
                OUTPUT_MODES.forEach((mode, index) => {
                    options.push({
                        content: `${mode.icon} ${mode.label}`,
                        callback: () => {
                            outputModeWidget.value = mode.value;
                            if (outputModeWidget.callback) {
                                outputModeWidget.callback(mode.value);
                            }
                            app.graph.setDirtyCanvas(true, true);
                        },
                        has_submenu: false
                    });
                });
            }

            return r;
        };
    },

    // 节点加载后的处理
    loadedGraphNode(node, app) {
        if (node.type === NODE_TYPE) {
            console.log("[GJJ] ImageToMask 节点已加载 - 支持动态输出模式");
        }
    }
});
