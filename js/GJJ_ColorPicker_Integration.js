/**
 * GJJ 颜色选择器集成示例
 * 演示如何在实际节点中使用颜色选择器
 */

importScripts('GJJ_ColorPicker.js');

// ========================================
// 示例节点：颜色背景生成器
// ========================================

class GJJ_ColorBackgroundNode {
    constructor() {
        this.size = [300, 200];
        this.addOutput("IMAGE", "IMAGE");
        
        // 添加颜色选择器 Widget
        this.colorWidget = this.addWidget("COLOR_PICKER", "背景颜色", "#FF5722", (value) => {
            this.backgroundColor = value;
            this.setDirtyCanvas(true, true);
        });
        
        this.backgroundColor = "#FF5722";
    }

    title = "GJJ · 颜色背景生成器";
    color = "#FF5722";
    bgcolor = "#2A2A2A";

    // 绘制节点预览
    onDrawForeground(ctx) {
        if (this.flags.collapsed) return;
        
        const w = this.size[0];
        const h = this.size[1];
        
        // 绘制颜色预览区域
        ctx.fillStyle = this.backgroundColor || "#000000";
        ctx.fillRect(10, 50, w - 20, h - 70);
        
        // 绘制边框
        ctx.strokeStyle = "#555";
        ctx.lineWidth = 1;
        ctx.strokeRect(10, 50, w - 20, h - 70);
    }

    // 执行节点逻辑
    execute() {
        // 这里实现生成纯色背景图片的逻辑
        const color = this.backgroundColor || "#FF5722";
        console.log("生成背景颜色:", color);
        
        // 返回 IMAGE 对象
        return [/* 图片数据 */];
    }
}

// 注册节点
LiteGraph.registerNodeType("GJJ/ColorBackground", GJJ_ColorBackgroundNode);

// ========================================
// 示例节点 2：自定义 Widget 实现
// ========================================

class GJJ_CustomColorNode {
    constructor() {
        this.size = [350, 250];
        this.addOutput("IMAGE", "IMAGE");
        
        // 创建自定义颜色 Widget
        const widget = {
            name: "primary_color",
            type: "custom_color_picker",
            value: "#4CAF50",
            
            draw: function(ctx, node, widgetWidth, widgetY, height) {
                const border = 3;
                const x = 10;
                const y = widgetY;
                const w = widgetWidth - 20;
                const h = height - 6;
                
                // 绘制背景
                ctx.fillStyle = "#1a1a1a";
                ctx.fillRect(x, y, w, h);
                
                // 绘制颜色预览
                ctx.fillStyle = this.value || "#000000";
                ctx.fillRect(x + border, y + border, w - border * 2, h - border * 2);
                
                // 绘制边框
                ctx.strokeStyle = "#555";
                ctx.lineWidth = 1;
                ctx.strokeRect(x, y, w, h);
                
                // 绘制颜色文本
                ctx.fillStyle = "#fff";
                ctx.font = "11px monospace";
                ctx.textAlign = "center";
                ctx.fillText(this.value, x + w / 2, y + h / 2 + 4);
                
                // 保存位置用于点击检测
                this.last_y = y;
            },
            
            mouse: function(e, pos, node) {
                if (e.type === "pointerdown" || e.type === "mousedown") {
                    const rect = [this.last_y, this.last_y + 32];
                    if (pos[1] > rect[0] && pos[1] < rect[1]) {
                        GJJ_ColorPicker.show(node, this, this.value, (newColor) => {
                            this.value = newColor;
                            node.primaryColor = newColor;
                            node.setDirtyCanvas(true, true);
                            
                            // 触发值变化回调
                            if (this.callback) {
                                this.callback(newColor);
                            }
                        });
                    }
                }
            },
            
            computeSize: function(width) {
                return [width, 32];
            }
        };
        
        this.addWidgetObject(widget);
        this.primaryColor = "#4CAF50";
    }

    title = "GJJ · 自定义颜色节点";
    color = "#4CAF50";

    addWidgetObject(widget) {
        this.widgets.push(widget);
    }

    onDrawForeground(ctx) {
        if (this.flags.collapsed) return;
        
        const w = this.size[0];
        const h = this.size[1];
        
        // 绘制主颜色预览
        ctx.fillStyle = this.primaryColor || "#000000";
        ctx.fillRect(10, 60, w - 20, 80);
        
        ctx.strokeStyle = "#555";
        ctx.lineWidth = 1;
        ctx.strokeRect(10, 60, w - 20, 80);
    }
}

// 注册节点
LiteGraph.registerNodeType("GJJ/CustomColorPicker", GJJ_CustomColorNode);

console.log('[GJJ_ColorPicker_Examples] 示例节点已加载');
