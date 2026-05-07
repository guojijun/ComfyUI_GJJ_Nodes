/**
 * GJJ 颜色选择器使用示例
 * 
 * 如何在你的节点中使用 GJJ_ColorPicker
 */

// ========================================
// 方法 1: 在节点前端 JS 中使用
// ========================================

// 在你的节点 JS 文件中，添加以下代码：
importScripts('GJJ_ColorPicker.js'); // 引入颜色选择器

// 在 onNodeCreated 或 getExtraMenuOptions 中注册自定义 Widget
function onNodeCreated() {
    // 添加颜色选择器 Widget
    const colorWidget = this.addInput('color', 'COLOR_PICKER');
    
    // 或者使用自定义 Widget
    this.addWidget('COLOR_PICKER', '颜色', '#FF0000', (value) => {
        console.log('选择的颜色:', value);
        // value 格式: '#FF0000' 或 'rgba(255, 0, 0, 100%)'
    });
}

// ========================================
// 方法 2: 直接在 Widget 的 mouse 事件中调用
// ========================================

// 在你的节点 JS 中定义 Widget
const widget = {
    name: 'color',
    type: 'custom_color',
    value: '#FF0000',
    
    // 绘制 Widget
    draw: function(ctx, node, widgetWidth, widgetY, height) {
        const border = 3;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, widgetY, widgetWidth, height);
        
        ctx.fillStyle = this.value;
        ctx.fillRect(border, widgetY + border, widgetWidth - border * 2, height - border * 2);
        
        ctx.fillStyle = '#fff';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(this.value, widgetWidth * 0.5, widgetY + height * 0.5 + 4);
    },
    
    // 鼠标点击事件
    mouse: function(e, pos, node) {
        if (e.type === 'pointerdown' || e.type === 'mousedown') {
            const rect = [this.last_y, this.last_y + 32];
            if (pos[1] > rect[0] && pos[1] < rect[1]) {
                // 显示颜色选择器
                GJJ_ColorPicker.show(node, this, this.value, (newColor) => {
                    this.value = newColor;
                    // 触发节点更新
                    node.setDirtyCanvas(true, true);
                });
            }
        }
    },
    
    // 计算 Widget 尺寸
    computeSize: function(width) {
        return [width, 32];
    }
};

// ========================================
// 方法 3: 在 Python 后端节点中使用
// ========================================

// Python 后端代码（.py 文件）
class GJJ_MyColorNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "color": ("STRING", {
                    "default": "#FF0000",
                    "display_name": "颜色",
                    "tooltip": "点击节点上的颜色块打开颜色选择器",
                }),
            }
        }
    
    RETURN_TYPES = ("STRING",)
    FUNCTION = "run"
    
    def run(self, color):
        # color 值格式: "#FF0000" 或 "rgba(255, 0, 0, 100%)"
        print(f"选择的颜色: {color}")
        return (color,)

// ========================================
// API 说明
// ========================================

/*
GJJ_ColorPicker.show(node, widget, currentValue, callback)

参数:
- node: ComfyUI 节点对象 (this)
- widget: 触发颜色选择器的 Widget 对象
- currentValue: 当前颜色值 (支持 #RRGGBB, #RRGGBBAA, rgba(R,G,B,A%))
- callback: 颜色选择回调函数 (newColor) => void

回调函数接收:
- newColor: 新选择的颜色值 (格式: #RRGGBBAA)

示例:
GJJ_ColorPicker.show(node, widget, '#FF0000', (color) => {
    console.log('新颜色:', color); // '#FF0000FF'
    widget.value = color;
});
*/

// ========================================
// 支持的颜色格式
// ========================================

/*
输入支持:
- Hex 6位: '#FF0000'
- Hex 8位: '#FF0000FF'
- RGB: 'rgb(255, 0, 0)'
- RGBA: 'rgba(255, 0, 0, 100%)'

输出格式:
- Hex 8位: '#RRGGBBAA' (包含 Alpha 通道)
*/
