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

    /**
     * 为指定的 widget 名称列表设置颜色选择器（使用浏览器原生颜色选择器）。
     * @param {object} node - ComfyUI 节点实例
     * @param {string[]} colorWidgetNames - 需要设置颜色选择器的 widget 名称数组
     */
    static setupColorPickers(node, colorWidgetNames) {
        if (node.__gjjColorPickersSetup) return;
        node.__gjjColorPickersSetup = true;

        // 找到颜色相关的 widgets
        const colorWidgets = [];
        (node.widgets || []).forEach(widget => {
            if (colorWidgetNames.includes(widget.name)) {
                colorWidgets.push(widget);
            }
        });
        
        // 为每个颜色 widget 添加颜色选择器功能
        colorWidgets.forEach(widget => {
            if (!widget) return;
            
            // 重写绘制方法，显示颜色预览
            widget.draw = function(ctx, node, widgetWidth, widgetY, height) {
                const border = 3;
                const x = 10;
                const y = widgetY;
                const w = widgetWidth - 20;
                const h = height - 6;
                
                // 绘制背景
                ctx.fillStyle = '#000';
                ctx.fillRect(x, y, w, h);
                
                // 绘制颜色预览
                const color = this.value || '#000000';
                ctx.fillStyle = color;
                ctx.fillRect(x + border, y + border, w - border * 2, h - border * 2);
                
                // 绘制边框
                ctx.strokeStyle = '#555';
                ctx.lineWidth = 1;
                ctx.strokeRect(x, y, w, h);
                
                // 保存位置用于点击检测
                this.last_y = y;
            };
            
            // 鼠标点击事件 - 使用浏览器原生颜色选择器
            widget.mouse = function(e, pos, node) {
                if (e.type === 'pointerdown' || e.type === 'mousedown') {
                    const rect = [this.last_y, this.last_y + 32];
                    if (pos[1] > rect[0] && pos[1] < rect[1]) {
                        // 创建原生颜色选择器
                        const picker = document.createElement('input');
                        picker.type = 'color';
                        picker.value = this.value || '#000000';
                        
                        // 定位到屏幕外
                        picker.style.position = 'absolute';
                        picker.style.left = '-9999px';
                        picker.style.top = '-9999px';
                        
                        document.body.appendChild(picker);
                        
                        // 监听颜色变化
                        picker.addEventListener('change', () => {
                            this.value = picker.value;
                            node.graph._version++;
                            node.setDirtyCanvas(true, true);
                            picker.remove();
                        });
                        
                        // 触发点击
                        picker.click();
                    }
                }
            };
            
            // 设置 widget 尺寸
            widget.computeSize = function(width) {
                return [width, 32];
            };
        });
    }

    /**
     * 创建按钮组替换下拉列表控件。
     * @param {object} node - ComfyUI 节点实例
     * @param {string} widgetName - 要替换的下拉列表控件名称
     * @param {string[]} options - 按钮选项数组
     * @param {string} [label=""] - 显示标签（可选）
     * @returns {object} DOM Widget 实例
     */
    static createButtonGroup(node, widgetName, options, label = "") {
        const widget = GJJ_Utils.getWidget(node, widgetName);
        if (!widget) return null;

        // 隐藏原始下拉列表
        GJJ_Utils.hideWidget(widget);

        // 创建按钮容器
        const container = document.createElement("div");
        container.style.cssText = [
            "box-sizing: border-box",
            "width: 100%",
            "display: flex",
            "flex-direction: column",
            "gap: 4px",
            "padding: 4px 0"
        ].join(";");

        // 添加标签（如果有）
        if (label) {
            const labelEl = document.createElement("div");
            labelEl.textContent = label;
            labelEl.style.cssText = [
                "font-size: 12px",
                "color: #aaa",
                "padding-left: 4px",
                "font-weight: bold"
            ].join(";");
            container.appendChild(labelEl);
        }

        // 创建按钮行容器
        const buttonRow = document.createElement("div");
        buttonRow.style.cssText = [
            "display: flex",
            "gap: 4px",
            "padding: 0 4px"
        ].join(";");

        // 创建按钮
        options.forEach(option => {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = option;
            button.style.cssText = [
                "flex: 1",
                "height: 32px",
                "padding: 6px 8px",
                "border: 1px solid #3b5560",
                "border-radius: 6px",
                "background: #20323a",
                "color: #edf6fa",
                "font: 700 12px sans-serif",
                "cursor: pointer",
                "transition: all 0.2s ease",
                "white-space: nowrap",
                "overflow: hidden",
                "text-overflow: ellipsis"
            ].join(";");

            // 设置初始状态
            if (option === widget.value) {
                button.style.background = "#1f6b43";
                button.style.borderColor = "#48ad73";
                button.style.color = "#fff";
            }

            button.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();

                // 更新所有按钮样式
                buttonRow.querySelectorAll("button").forEach(btn => {
                    btn.style.background = "#20323a";
                    btn.style.borderColor = "#3b5560";
                    btn.style.color = "#edf6fa";
                });

                // 设置当前按钮为激活状态
                button.style.background = "#1f6b43";
                button.style.borderColor = "#48ad73";
                button.style.color = "#fff";

                // 更新 widget 值
                widget.value = option;
                if (widget.callback) {
                    widget.callback(option);
                }

                node.graph?.change?.();
                node.setDirtyCanvas(true, true);
                app.graph?.setDirtyCanvas(true, true);
            });

            buttonRow.appendChild(button);
        });

        container.appendChild(buttonRow);

        // 添加 DOM Widget
        const buttonWidget = node.addDOMWidget(
            `${widgetName}_buttons`,
            `${widgetName}_buttons`,
            container,
            {
                serialize: false,
                hideOnZoom: false,
                getHeight: () => label ? 72 : 40
            }
        );

        buttonWidget.value = widget.value;
        return buttonWidget;
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
     * 刷新节点尺寸和画布。默认保留当前宽度，仅按 computeSize() 自动回收高度。
     * @param {object} node - ComfyUI 节点实例
     * @param {object} [options={}] - 可选参数
     * @param {boolean} [options.preserveWidth=true] - 是否保留当前宽度
     * @param {number} [options.minWidth=300] - 最小宽度
     * @param {number} [options.minHeight=80] - 最小高度
     * @param {number} [options.width] - 强制指定宽度
     * @param {number} [options.height] - 强制指定高度
     * @param {boolean} [options.dirtyCanvas=true] - 是否刷新画布
     */
    static refreshNode(node, options = {}) {
        if (!node) return;
        const {
            preserveWidth = true,
            minWidth = 300,
            minHeight = 80,
            width = null,
            height = null,
            dirtyCanvas = true,
        } = options || {};

        const size = node.computeSize?.() || [];
        const currentWidth = Number(node.size?.[0] || 0);
        const currentHeight = Number(node.size?.[1] || 0);
        const computedWidth = Number(size[0] || 0);
        const computedHeight = Number(size[1] || 0);

        const nextWidth = Number.isFinite(width)
            ? width
            : Math.max(
                preserveWidth ? (currentWidth || computedWidth || minWidth) : (computedWidth || currentWidth || minWidth),
                minWidth
            );
        const nextHeight = Number.isFinite(height)
            ? height
            : Math.max(computedHeight || currentHeight || minHeight, minHeight);

        node.setSize?.([nextWidth, nextHeight]);
        if (dirtyCanvas) {
            node.setDirtyCanvas?.(true, true);
            app.graph?.setDirtyCanvas?.(true, true);
        }
    }

    /**
     * 在下一帧或延迟后再刷新节点尺寸，适合 DOMWidget 还没完成渲染时调用。
     * @param {object} node - ComfyUI 节点实例
     * @param {object} [options={}] - 与 refreshNode 相同的参数
     * @param {number} [options.delay=0] - 额外延迟毫秒数
     * @param {boolean} [options.useAnimationFrame=true] - 是否先等一帧
     */
    static scheduleRefreshNode(node, options = {}) {
        if (!node) return;
        const {
            delay = 0,
            useAnimationFrame = true,
            ...refreshOptions
        } = options || {};
        const run = () => GJJ_Utils.refreshNode(node, refreshOptions);
        if (useAnimationFrame && typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => {
                if (delay > 0) setTimeout(run, delay);
                else run();
            });
            return;
        }
        if (delay > 0) {
            setTimeout(run, delay);
            return;
        }
        run();
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
        widget.computeSize = () => [0, 0];
        widget.getHeight = () => 0;
        widget.draw = () => {};
        widget.label = "";
        
        // 重置关键布局属性 - 按照《隐藏参数挤出空行问题完全指南.md》的要求
        widget.last_y = 0;              // ⭐ 最关键，必须设置为 0 而不是负值
        widget.computedHeight = 0;
        widget.margin_top = 0;
        widget.size = [0, 0];
        
        // 隐藏 DOM 元素
        if (widget.element) {
            widget.element.style.display = "none";
            widget.element.style.height = "0";
            widget.element.style.margin = "0";
            widget.element.style.padding = "0";
        }
        if (widget.inputEl) {
            widget.inputEl.style.display = "none";
            widget.inputEl.style.height = "0";
            widget.inputEl.style.margin = "0";
            widget.inputEl.style.padding = "0";
        }
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

export function queueNode(node, reason = "manual") {
	if (!node || !node.graph) return;

	const graph = node.graph;
	const queueNodeFn = graph.queueNode;

	// 检查 queueNode 是否存在且为函数
	if (typeof queueNodeFn === 'function') {
		try {
			queueNodeFn(node);
			console.log(`[GJJ] 成功触发节点重新执行: ${node.name || 'unknown'} (${reason})`);
		} catch (err) {
			console.warn(`[GJJ] 触发节点重新执行失败: ${node.name || 'unknown'}, 错误:`, err);
			// 备用方案：设置脏标志
			graph.setDirtyCanvas?.(true, true);
		}
	} else {
		console.warn(`[GJJ] queueNode 函数不可用，尝试使用备用方法: ${node.name || 'unknown'}`);
		// 备用方案：直接设置脏标志
		graph.setDirtyCanvas?.(true, true);
	}
}

function isExecutionOutputNode(node) {
	if (!node) return false;
	if (node === undefined || node === null) return false;
	if (node.constructor?.nodeData?.output_node === true) return true;
	if (node.nodeData?.output_node === true) return true;
	if (node.flags?.output === true) return true;
	return false;
}

/**
 * 仅执行当前节点（不触发整个工作流队列）。
 * 核心功能：临时禁用其他输出节点，只执行当前节点，执行完成后恢复状态。
 * 
 * @param {object} node - 当前节点对象
 * @returns {Promise<boolean>} - 是否成功执行
 */
export async function queueOnlyCurrentNode(node) {
	if (!node || !node.graph) return false;

	const graph = node.graph || app.graph;
	const allNodes = graph?._nodes || app.graph?._nodes || [];
	const savedModes = [];
	const oldSelectedNodes = app.canvas?.selected_nodes;
	const oldSelectedNode = app.canvas?.selected_node;

	try {
		// 临时禁用其他输出节点
		for (const n of allNodes) {
			if (!n || n === node) continue;
			if (isExecutionOutputNode(n)) {
				savedModes.push([n, n.mode]);
				n.mode = 2;  // 临时禁用以阻止执行
			}
		}

		// 只选中当前节点
		if (app.canvas) {
			app.canvas.selected_nodes = {};
			app.canvas.selected_nodes[node.id] = node;
			app.canvas.selected_node = node;
		}

		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);

		// 执行节点
		if (typeof app.queuePrompt === "function") {
			await app.queuePrompt(0, 1);
			return true;
		}
		
		console.warn("[GJJ] app.queuePrompt 不存在，无法只刷新当前节点");
		return false;
	} finally {
		// 恢复所有被禁用的节点
		for (const [n, mode] of savedModes) {
			n.mode = mode;
		}

		if (app.canvas) {
			app.canvas.selected_nodes = oldSelectedNodes;
			app.canvas.selected_node = oldSelectedNode;
		}

		node.setDirtyCanvas?.(true, true);
		node.graph?.setDirtyCanvas?.(true, true);
		app.graph?.setDirtyCanvas?.(true, true);
	}
}
