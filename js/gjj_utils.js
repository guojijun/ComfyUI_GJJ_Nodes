/**
 * GJJ ComfyUI 节点公共工具类
 *
 * 【永久规则】所有 GJJ 节点的新增/修改必须：
 * 1. 优先使用本文件已有的公共函数，禁止在单个节点文件中重复实现通用逻辑。
 * 2. 如果本文件没有所需通用功能，必须先将该逻辑封装为静态方法，再在节点中调用。
 * 3. 所有新节点必须在开头 `import { GJJ_Utils } from "./gjj_utils.js";`。
 */

import { app } from "../../scripts/app.js";

export class GJJ_Utils {

    // ═══════════════════════════════════════════════════════════════
    // Widget 辅助
    // ═══════════════════════════════════════════════════════════════

    /**
     * 按名称查找节点上的控件。
     * @param {object} node - ComfyUI 节点实例
     * @param {string} name - 控件名称
     * @returns {object|undefined} 匹配的控件，未找到返回 undefined
     */
    static getWidget(node, name) {
        return node?.widgets?.find((w) => w?.name === name);
    }

    /**
     * 按名称查找节点上的输入插槽。
     * @param {object} node - ComfyUI 节点实例
     * @param {string} name - 输入名称
     * @returns {object|undefined} 匹配的输入，未找到返回 undefined
     */
    static getInput(node, name) {
        return node?.inputs?.find((i) => i?.name === name);
    }

    // ═══════════════════════════════════════════════════════════════
    // UI 数据解包
    // ═══════════════════════════════════════════════════════════════

    /**
     * 解包 ComfyUI 后端返回的 ui 数据元组。
     * 后端返回格式 "(value,)" 元组会被前端收到为数组，取第一个元素。
     * @param {*} arr - 可能是数组或原始值
     * @returns {*} 解包后的值
     */
    static getFirstValue(arr) {
        if (Array.isArray(arr) && arr.length > 0) return arr[0];
        return arr;
    }

    // ═══════════════════════════════════════════════════════════════
    // 节点尺寸控制
    // ═══════════════════════════════════════════════════════════════

    /**
     * 刷新节点尺寸和画布。宽度优先使用 node.size[0]（保留用户手动调整宽度），
     * 高度使用 computeSize()[1] 自动适配内容。
     * @param {object} node - ComfyUI 节点实例
     */
    static refreshNode(node) {
        if (!node) return;
        node.setSize?.([
            node.size?.[0] || node.computeSize?.()?.[0] || 300,
            node.computeSize?.()?.[1] || node.size?.[1] || 80,
        ]);
        node.setDirtyCanvas?.(true, true);
        app.graph?.setDirtyCanvas?.(true, true);
    }

    /**
     * 仅标记画布脏（触发重绘），不改变节点尺寸。
     * @param {object} node - ComfyUI 节点实例
     */
    static dirtyCanvas(node) {
        node?.setDirtyCanvas?.(true, true);
        app.graph?.setDirtyCanvas?.(true, true);
    }

    // ═══════════════════════════════════════════════════════════════
    // 控件隐藏与清理
    // ═══════════════════════════════════════════════════════════════

    /**
     * 彻底隐藏一个控件 —— Node 2.0 标准写法。
     * 类型改为 converted-widget:NAME，尺寸和高度归零/负值，
     * DOM 元素 display:none，坐标移出可视区。
     * @param {object} widget - ComfyUI 控件实例
     */
    static hideWidget(widget) {
        if (!widget || widget.__gjjUtilsHidden) return;
        widget.__gjjUtilsHidden = true;
        widget.hidden = true;
        widget.type = `converted-widget:${widget.name || "hidden"}`;
        widget.computeSize = () => [0, -4];
        widget.getHeight = () => -4;
        widget.draw = () => {};
        widget.y = -10000;
        widget.last_y = -10000;
        if (widget.element) widget.element.style.display = "none";
        if (widget.inputEl) widget.inputEl.style.display = "none";
    }

    /**
     * 删除节点上属于隐藏控件集合的输入插槽。
     * 遍历 node.inputs，匹配 name 或 converted-widget:NAME 类型前缀，
     * 先断开连接再移除插槽。
     * @param {object} node - ComfyUI 节点实例
     * @param {Set<string>} hiddenNames - 隐藏控件名称集合
     */
    static removeHiddenInputSockets(node, hiddenNames) {
        if (!Array.isArray(node?.inputs)) return;
        for (let i = node.inputs.length - 1; i >= 0; i--) {
            const input = node.inputs[i];
            const name = String(input?.name || "");
            const type = String(input?.type || "");
            const converted = type.startsWith("converted-widget:") ? type.slice("converted-widget:".length) : "";
            if (hiddenNames.has(name) || hiddenNames.has(converted)) {
                try { node.disconnectInput?.(i); } catch (_) { /* ignore */ }
                if (typeof node.removeInput === "function") {
                    node.removeInput(i);
                } else {
                    node.inputs.splice(i, 1);
                }
            }
        }
    }

    /**
     * 按优先级重排节点控件列表。
     * DOM 控件（名称含 "gjj_" 前缀）排最前，隐藏控件排最后。
     * @param {object} node - ComfyUI 节点实例
     * @param {Set<string>} hiddenNames - 隐藏控件名称集合
     */
    static reorderWidgets(node, hiddenNames) {
        if (!Array.isArray(node?.widgets)) return;
        const priority = (w) => {
            const n = String(w?.name || "");
            if (n.startsWith("gjj_")) return 10;
            if (hiddenNames.has(n)) return 90;
            return 50;
        };
        node.widgets = node.widgets
            .map((w, idx) => ({ w, idx }))
            .sort((a, b) => priority(a.w) - priority(b.w) || a.idx - b.idx)
            .map((e) => e.w);
    }

    /**
     * 完整压缩节点：隐藏内部控件 → 删除残留输入口 → 重排控件 → 刷新尺寸。
     * @param {object} node - ComfyUI 节点实例
     * @param {Set<string>} hiddenNames - 隐藏控件名称集合
     */
    static compactNode(node, hiddenNames) {
        if (!node || !hiddenNames) return;
        for (const name of hiddenNames) {
            GJJ_Utils.hideWidget(GJJ_Utils.getWidget(node, name));
        }
        GJJ_Utils.removeHiddenInputSockets(node, hiddenNames);
        GJJ_Utils.reorderWidgets(node, hiddenNames);
        GJJ_Utils.refreshNode(node);
    }

    // ═══════════════════════════════════════════════════════════════
    // 动态插槽命名
    // ═══════════════════════════════════════════════════════════════

    /**
     * 生成零填充的动态输入/输出名称，如 "image_01", "any_03"。
     * @param {string} prefix - 名称前缀
     * @param {number} index - 1-based 序号
     * @param {number} [pad=2] - 填充位数
     * @returns {string} 格式化后的名称
     */
    static formatSlotName(prefix, index, pad = 2) {
        return `${prefix}${String(index).padStart(pad, "0")}`;
    }

    /**
     * 从动态插槽名称中提取序号。
     * @param {string} name - 插槽名称
     * @param {string} prefix - 名称前缀
     * @returns {number} 提取的序号，不匹配时返回 Number.MAX_SAFE_INTEGER
     */
    static getSlotIndex(name, prefix) {
        const text = String(name || "");
        if (!text.startsWith(prefix)) return Number.MAX_SAFE_INTEGER;
        return Number.parseInt(text.slice(prefix.length), 10) || Number.MAX_SAFE_INTEGER;
    }

    /**
     * 获取并排序指定前缀的动态输入列表。
     * @param {object} node - ComfyUI 节点实例
     * @param {string} prefix - 输入名称前缀
     * @returns {Array} 排序后的输入数组
     */
    static getSlottedInputs(node, prefix) {
        return (node?.inputs || [])
            .filter((i) => String(i?.name || "").startsWith(prefix))
            .sort((a, b) => GJJ_Utils.getSlotIndex(a?.name, prefix) - GJJ_Utils.getSlotIndex(b?.name, prefix));
    }

    // ═══════════════════════════════════════════════════════════════
    // 动态输入管理（批量插槽增删改）
    // ═══════════════════════════════════════════════════════════════

    /**
     * 从末尾剪除未使用的动态输入。
     * @param {object} node - ComfyUI 节点实例
     * @param {string} prefix - 输入名称前缀
     * @param {number} [minVisible=1] - 至少保留的可见输入数量
     */
    static trimTrailingInputs(node, prefix, minVisible = 1) {
        const inputs = GJJ_Utils.getSlottedInputs(node, prefix);
        for (let i = inputs.length - 1; i >= minVisible; i--) {
            if (inputs[i]?.link) break;
            const idx = node.inputs.indexOf(inputs[i]);
            if (idx >= 0) node.removeInput?.(idx);
        }
    }

    /**
     * 确保末尾恰好有一个空输入口。若最后一个输入已连接且未达上限，则新增。
     * @param {object} node - ComfyUI 节点实例
     * @param {string} prefix - 输入名称前缀
     * @param {string} type - 新输入的 ComfyUI 类型
     * @param {number} [maxInputs=99] - 最大输入数量
     */
    static ensureTrailingInput(node, prefix, type, maxInputs = 99) {
        const inputs = GJJ_Utils.getSlottedInputs(node, prefix);
        if (!inputs.length) {
            node.addInput?.(GJJ_Utils.formatSlotName(prefix, 1), type);
            return;
        }
        if (inputs[inputs.length - 1]?.link && inputs.length < maxInputs) {
            node.addInput?.(GJJ_Utils.formatSlotName(prefix, inputs.length + 1), type);
        }
    }

    /**
     * 按顺序重命名动态输入并设置标签/类型/提示。
     * @param {object} node - ComfyUI 节点实例
     * @param {string} prefix - 输入名称前缀
     * @param {string} labelPrefix - 显示标签前缀（如 "图片 "）
     * @param {string} type - ComfyUI 类型
     * @param {string} tooltip - 提示文本
     */
    static renameSlottedInputs(node, prefix, labelPrefix, type, tooltip) {
        GJJ_Utils.getSlottedInputs(node, prefix).forEach((input, i) => {
            const n = i + 1;
            input.name = GJJ_Utils.formatSlotName(prefix, n);
            input.label = `${labelPrefix}${n}`;
            input.localized_name = input.label;
            input.type = type;
            input.tooltip = tooltip;
        });
    }

    /**
     * 稳定化动态输入：剪除 → 确保空尾 → 重命名。
     * @param {object} node - ComfyUI 节点实例
     * @param {string} prefix - 输入名称前缀
     * @param {string} labelPrefix - 显示标签前缀
     * @param {string} type - ComfyUI 类型
     * @param {string} tooltip - 提示文本
     * @param {number} [minVisible=1] - 最少可见输入数
     * @param {number} [maxInputs=99] - 最大输入数
     */
    static stabilizeSlottedInputs(node, prefix, labelPrefix, type, tooltip, minVisible = 1, maxInputs = 99) {
        GJJ_Utils.trimTrailingInputs(node, prefix, minVisible);
        GJJ_Utils.ensureTrailingInput(node, prefix, type, maxInputs);
        GJJ_Utils.renameSlottedInputs(node, prefix, labelPrefix, type, tooltip);
    }

    /**
     * 防抖调度函数 —— 用于 onConnectionsChange 等高频事件。
     * @param {object} node - ComfyUI 节点实例
     * @param {string} timerProp - 存储定时器 ID 的属性名（如 "__myTimer"）
     * @param {Function} fn - 待执行的函数
     * @param {number} [ms=32] - 防抖毫秒数
     */
    static scheduleStabilize(node, timerProp, fn, ms = 32) {
        clearTimeout(node[timerProp]);
        node[timerProp] = setTimeout(() => fn(node), ms);
    }

    // ═══════════════════════════════════════════════════════════════
    // 图片加载
    // ═══════════════════════════════════════════════════════════════

    /**
     * 从 URL 加载图片并返回其自然尺寸。
     * @param {string} url - 图片 URL
     * @returns {Promise<{width:number, height:number}|null>} 尺寸对象或 null
     */
    static loadImageDimensionsFromUrl(url) {
        if (!url) return Promise.resolve(null);
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => resolve(null);
            img.src = url;
        });
    }

    /**
     * 从上游 LoadImage / LoadImageOutput 节点获取图片文件名并加载尺寸。
     * @param {object} sourceNode - 上游源节点
     * @returns {Promise<{width:number, height:number}|null>} 尺寸对象或 null
     */
    static async loadImageDimensionsFromSourceNode(sourceNode) {
        if (!sourceNode) return null;
        const imageWidget = GJJ_Utils.getWidget(sourceNode, "image");
        const filename = String(imageWidget?.value || "").trim();
        if (!filename) return null;
        let viewType = null;
        if (sourceNode.comfyClass === "LoadImage") viewType = "input";
        else if (sourceNode.comfyClass === "LoadImageOutput") viewType = "output";
        else return null;
        const url = `/api/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(viewType)}&rand=${Date.now()}`;
        return GJJ_Utils.loadImageDimensionsFromUrl(url);
    }

    // ═══════════════════════════════════════════════════════════════
    // URL 构建
    // ═══════════════════════════════════════════════════════════════

    /**
     * 构建 ComfyUI 图片预览 URL。
     * @param {string} filename - 文件名
     * @param {string} [type="temp"] - 视图类型（"input"|"output"|"temp"）
     * @param {string} [subfolder=""] - 子目录
     * @returns {string} 完整的 /api/view URL
     */
    static buildViewUrl(filename, type = "temp", subfolder = "") {
        return `/api/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(type)}&subfolder=${encodeURIComponent(subfolder)}&rand=${Date.now()}`;
    }

    // ═══════════════════════════════════════════════════════════════
    // 生命周期钩子工厂
    // ═══════════════════════════════════════════════════════════════

    /**
     * 为标准动态插槽节点批量安装 onNodeCreated / onConfigure / onConnectionsChange 钩子，
     * 并在稳定化后自动调用 refreshNode 调整节点高度。
     * 在 beforeRegisterNodeDef 中调用。
     * @param {object} nodeType - nodeType.prototype
     * @param {Function} stabilizeFn - 稳定化函数，签名为 (node) => void
     * @param {Function} [scheduleFn] - 防抖调度函数；默认用 scheduleStabilize 包装 stabilizeFn
     * @param {Function} [linkSigFn] - 链接签名函数，签名为 (node) => string；提供后启用 onDrawBackground 签名检测
     */
    static installDynamicSlotHooks(nodeType, stabilizeFn, scheduleFn, linkSigFn) {
        const sched = scheduleFn || ((node) => GJJ_Utils.scheduleStabilize(node, "__gjjUtilsTimer", stabilizeFn));

        // onNodeCreated —— 新节点添加到画布
        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = origCreated?.apply(this, args);
            setTimeout(() => {
                stabilizeFn(this);
                GJJ_Utils.refreshNode(this);  // 动态调整高度
            }, 0);
            return result;
        };

        // onConfigure —— 从工作流加载
        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const result = origConfigure?.apply(this, args);
            stabilizeFn(this);
            GJJ_Utils.refreshNode(this);
            // 二次确认：DOM 面板可能延迟渲染
            setTimeout(() => {
                stabilizeFn(this);
                GJJ_Utils.refreshNode(this);
            }, 120);
            return result;
        };

        // onConnectionsChange —— 连线变化时防抖稳定化
        const origConnChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (...args) {
            const result = origConnChange?.apply(this, args);
            sched(this);
            return result;
        };

        // onDrawBackground —— 连线签名变化时兜底（处理 onConnectionsChange 不可靠的情况）
        if (linkSigFn) {
            const timerProp = "__gjjUtilsDrawTimer";
            const origDrawBg = nodeType.prototype.onDrawBackground;
            nodeType.prototype.onDrawBackground = function (...args) {
                const result = origDrawBg?.apply(this, args);
                const sig = linkSigFn(this);
                if (sig !== this.__gjjUtilsLinkSignature) {
                    this.__gjjUtilsLinkSignature = sig;
                    GJJ_Utils.scheduleStabilize(this, timerProp, stabilizeFn);
                }
                return result;
            };
        }
    }

    /**
     * 在 setup() 中对图上已有节点批量执行稳定化并调整高度。
     * @param {Set<string>} targetNodes - 目标节点类名集合
     * @param {Function} stabilizeFn - 稳定化函数
     */
    static setupExistingNodes(targetNodes, stabilizeFn) {
        for (const node of app.graph?._nodes || []) {
            if (targetNodes.has(node?.comfyClass)) {
                stabilizeFn(node);
                GJJ_Utils.refreshNode(node);
            }
        }
    }

    /**
     * 一键注册动态插槽扩展：同时安装 beforeRegisterNodeDef 钩子和 setup() 回调。
     * 替代手写 app.registerExtension({...}) 中的样板代码。
     *
     * @param {string} extName - 扩展名称，如 "Comfy.GJJ.AnySwitch"
     * @param {Set<string>} targetNodes - 目标节点类名集合
     * @param {Function} stabilizeFn - 稳定化函数，签名为 (node) => void
     * @param {Function} [scheduleFn] - 自定义防抖调度函数
     * @param {Function} [linkSigFn] - 链接签名函数，签名为 (node) => string
     * @returns {object} 扩展对象，如有额外钩子可 .extend({...})
     */
    static registerDynamicSlotExtension(extName, targetNodes, stabilizeFn, scheduleFn, linkSigFn) {
        app.registerExtension({
            name: extName,

            async beforeRegisterNodeDef(nodeType, nodeData) {
                if (!targetNodes.has(nodeData?.name)) return;
                GJJ_Utils.installDynamicSlotHooks(nodeType, stabilizeFn, scheduleFn, linkSigFn);
            },

            setup() {
                GJJ_Utils.setupExistingNodes(targetNodes, stabilizeFn);
            },
        });
    }
}
