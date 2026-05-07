# GJJ 通用颜色选择器

## 功能特性

✅ **可视化渐变选择面板** - Hue × Saturation 二维选择  
✅ **色相滑块** - 彩虹色条快速选择主色调  
✅ **Alpha 透明度滑块** - 棋盘格背景 + 渐变显示  
✅ **十六进制输入** - 支持精确输入颜色值  
✅ **实时预览** - 即时显示选择的颜色效果  
✅ **拖拽交互** - 鼠标拖拽连续调整颜色  
✅ **ComfyUI 集成** - 自动注册为 LiteGraph Widget 类型

---

## 文件结构

```
GJJ/js/
├── GJJ_ColorPicker.js           # 核心颜色选择器类
├── GJJ_ColorPicker_Example.js   # 使用示例文档
└── GJJ_ColorPicker_Integration.js # 完整集成示例
```

---

## 快速开始

### 1. 引入颜色选择器

在你的节点 JS 文件顶部添加：

```javascript
importScripts('GJJ_ColorPicker.js');
```

### 2. 使用内置的 COLOR_PICKER Widget

```javascript
class MyNode {
    constructor() {
        // 添加颜色选择器 Widget
        this.addWidget("COLOR_PICKER", "颜色", "#FF0000", (value) => {
            console.log("选择的颜色:", value);
            this.myColor = value;
        });
    }
}
```

### 3. 自定义 Widget 实现

```javascript
const colorWidget = {
    name: "color",
    type: "custom_color",
    value: "#FF5722",
    
    draw: function(ctx, node, width, y, height) {
        // 绘制颜色预览块
        ctx.fillStyle = this.value;
        ctx.fillRect(10, y, width - 20, height - 6);
    },
    
    mouse: function(e, pos, node) {
        if (e.type === "pointerdown") {
            GJJ_ColorPicker.show(node, this, this.value, (newColor) => {
                this.value = newColor;
                node.setDirtyCanvas(true, true);
            });
        }
    },
    
    computeSize: function(width) {
        return [width, 32];
    }
};

this.addWidgetObject(colorWidget);
```

---

## API 文档

### GJJ_ColorPicker.show()

```javascript
GJJ_ColorPicker.show(node, widget, currentValue, callback)
```

**参数说明：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| node | Object | ✅ | ComfyUI 节点对象 (this) |
| widget | Object | ✅ | Widget 对象，用于更新值 |
| currentValue | String | ✅ | 当前颜色值 |
| callback | Function | ❌ | 颜色选择回调 `(color) => void` |

**支持的颜色格式：**

**输入：**
- `#FF0000` - Hex 6位
- `#FF0000FF` - Hex 8位（含Alpha）
- `rgb(255, 0, 0)` - RGB
- `rgba(255, 0, 0, 100%)` - RGBA

**输出：**
- `#RRGGBBAA` - Hex 8位（包含 Alpha 通道）

---

## 完整示例

### 示例 1：简单颜色选择节点

```javascript
importScripts('GJJ_ColorPicker.js');

class ColorPickerNode {
    constructor() {
        this.addOutput("COLOR", "STRING");
        
        this.colorWidget = this.addWidget("COLOR_PICKER", "选择颜色", "#FF5722", (value) => {
            this.color = value;
            this.setDirtyCanvas(true, true);
        });
        
        this.color = "#FF5722";
    }

    title = "GJJ · 颜色选择器";
    color = "#FF5722";

    onDrawForeground(ctx) {
        if (this.flags.collapsed) return;
        
        // 绘制颜色预览
        ctx.fillStyle = this.color;
        ctx.fillRect(10, 50, this.size[0] - 20, this.size[1] - 70);
    }

    execute() {
        return [this.color];
    }
}

LiteGraph.registerNodeType("GJJ/ColorPicker", ColorPickerNode);
```

### 示例 2：多颜色选择

```javascript
class MultiColorNode {
    constructor() {
        this.addOutput("IMAGE", "IMAGE");
        
        // 主颜色
        this.addWidget("COLOR_PICKER", "主颜色", "#FF0000", (v) => {
            this.primaryColor = v;
        });
        
        // 次要颜色
        this.addWidget("COLOR_PICKER", "次要颜色", "#00FF00", (v) => {
            this.secondaryColor = v;
        });
        
        // 背景颜色
        this.addWidget("COLOR_PICKER", "背景颜色", "#0000FF", (v) => {
            this.backgroundColor = v;
        });
        
        this.primaryColor = "#FF0000";
        this.secondaryColor = "#00FF00";
        this.backgroundColor = "#0000FF";
    }
    
    // ... 其他方法
}
```

---

## 高级用法

### 在 Python 后端节点中配合使用

**Python 后端代码：**

```python
class GJJ_ColorNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "color": ("STRING", {
                    "default": "#FF5722",
                    "display_name": "颜色",
                    "tooltip": "在前端点击颜色块打开可视化选择器",
                }),
                "opacity": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "display_name": "透明度",
                }),
            }
        }
    
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "generate"
    
    def generate(self, color, opacity):
        # 解析颜色值
        # color 格式: "#FF5722" 或 "rgba(255, 87, 34, 100%)"
        print(f"颜色: {color}, 透明度: {opacity}")
        
        # 处理逻辑...
        return (image_tensor,)
```

**对应的前端 JS：**

```javascript
importScripts('GJJ_ColorPicker.js');

// 扩展 Python 节点的前端功能
class GJJ_ColorNode_Frontend {
    onNodeCreated() {
        // 找到颜色输入 Widget
        const colorWidget = this.widgets.find(w => w.name === "color");
        
        if (colorWidget) {
            // 重写绘制方法
            const originalDraw = colorWidget.draw;
            colorWidget.draw = function(ctx, node, width, y, height) {
                // 绘制颜色预览块
                ctx.fillStyle = this.value || "#000000";
                ctx.fillRect(10, y, width - 20, height - 6);
                
                ctx.strokeStyle = "#555";
                ctx.strokeRect(10, y, width - 20, height - 6);
            };
            
            // 添加鼠标点击事件
            colorWidget.mouse = function(e, pos, node) {
                if (e.type === "pointerdown") {
                    GJJ_ColorPicker.show(node, this, this.value, (newColor) => {
                        this.value = newColor;
                        node.setDirtyCanvas(true, true);
                    });
                }
            };
        }
    }
}
```

---

## 自定义样式

颜色选择器支持通过 CSS 自定义样式：

```css
.gjj-color-picker {
    /* 自定义容器样式 */
    background: #2a2a2a !important;
    border-color: #666 !important;
}

.gjj-color-picker canvas {
    /* 自定义 Canvas 样式 */
    border-radius: 8px !important;
}
```

---

## 注意事项

️ **重要提示：**

1. **必须引入文件**：使用前确保 `importScripts('GJJ_ColorPicker.js')` 已执行
2. **节点刷新**：修改颜色后调用 `node.setDirtyCanvas(true, true)` 刷新显示
3. **颜色格式**：回调函数返回的颜色值包含 Alpha 通道（8位Hex）
4. **单例模式**：同时只能打开一个颜色选择器，打开新的会自动关闭旧的
5. **DOM 清理**：颜色选择器会在点击外部或选择完成后自动关闭并清理 DOM

---

## 常见问题

### Q: 颜色选择器不显示？
A: 检查是否已正确引入 `GJJ_ColorPicker.js` 文件，并确认 `LiteGraph` 已加载。

### Q: 如何获取带透明度的颜色？
A: 在颜色选择器中拖动底部的 Alpha 滑块即可调整透明度。

### Q: 支持 HSV 格式输出吗？
A: 当前仅输出 Hex 8位格式（#RRGGBBAA），如需其他格式可自行转换。

### Q: 如何禁用 Alpha 滑块？
A: 修改 `GJJ_ColorPicker.js` 中的 `drawAlphaSlider()` 方法，或直接隐藏 Alpha Canvas。

---

## 更新日志

### v1.0.0 (2024)
- ✅ 初始版本发布
- ✅ 支持 HSV 颜色空间选择
- ✅ 支持 Alpha 透明度调整
- ✅ 集成 ComfyUI LiteGraph
- ✅ 实时颜色预览
- ✅ Hex/RGB 输入支持

---

## 许可证

MIT License - 可自由使用和修改

---

## 贡献

欢迎提交 Issue 和 Pull Request！

如有问题或建议，请联系 GJJ 开发团队。
