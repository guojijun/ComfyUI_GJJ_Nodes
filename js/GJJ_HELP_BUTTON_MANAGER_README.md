# GJJ 节点帮助按钮管理器

## 📋 功能说明

自动将所有 GJJ 节点的帮助按钮（❓）移到节点面板 header 的右上角，确保：

- ✅ **位置统一**：所有帮助按钮都在 header 右上角
- ✅ **不被遮挡**：使用 `z-index: 1000` 确保在最上层
- ✅ **不影响其他元素**：精确定位，不扩散作用区域
- ✅ **美观交互**：悬停高亮效果，点击打开帮助文档

---

## 🎯 实现原理

### 1. 使用 ComfyUI 标准 API

通过 `getTitleButtons()` 方法添加按钮，这是 ComfyUI 官方推荐的在节点标题栏添加按钮的方式。

```javascript
nodeType.prototype.getTitleButtons = function() {
    const buttons = originalGetTitleButtons ? originalGetTitleButtons.call(this) : [];
    
    buttons.push({
        content: "❓",
        callback: () => {
            window.open(helpUrl, "_blank");
        },
        hint: "查看帮助文档",
    });
    
    return buttons;
};
```

### 2. 自动识别 GJJ 节点

只针对以 `GJJ_` 开头的节点添加帮助按钮，不影响其他自定义节点。

```javascript
const GJJ_NODE_PREFIXES = ["GJJ_"];

function isGJJNode(node) {
    return GJJ_NODE_PREFIXES.some(prefix => node.comfyClass.startsWith(prefix));
}
```

---

## 🚀 使用方法

### 自动加载

该脚本位于 `js/gjj_help_button_manager.js`，由于 `__init__.py` 中已设置：

```python
WEB_DIRECTORY = "./js"
```

ComfyUI 启动时会自动加载此脚本，无需额外配置。

### 效果展示

#### 更新前 ❌
- 帮助按钮可能在节点内部
- 位置不统一
- 可能被其他元素遮挡

#### 更新后 ✅
- 帮助按钮统一在 header 右上角
- 所有 GJJ 节点样式一致
- 始终可见，不被遮挡

---

## 🎨 样式特点

### 按钮样式

```css
position: absolute;
top: 4px;
right: 8px;
width: 24px;
height: 24px;
z-index: 1000;
```

### 交互效果

- **默认状态**：灰色（`#aaa`），透明背景
- **悬停状态**：白色（`#fff`），半透明白色背景，圆角
- **点击行为**：在新标签页打开帮助文档

---

## 🔧 自定义配置

### 修改帮助文档 URL

编辑 `gjj_help_button_manager.js` 中的 `HELP_URLS` 对象：

```javascript
const HELP_URLS = {
    "default": "https://github.com/guojijun/ComfyUI_GJJ",
    "GJJ_LazyImageStudio": "https://example.com/lazy-image-studio-help",
    "GJJ_BatchTextSegmenter": "https://example.com/batch-text-segmenter-help",
    // 添加更多节点的具体帮助链接
};
```

### 修改按钮图标

将 `"❓"` 改为其他 emoji 或文本：

```javascript
buttons.push({
    content: "📖",  // 改为书本图标
    // ...
});
```

### 添加更多 GJJ 节点前缀

如果需要支持其他前缀：

```javascript
const GJJ_NODE_PREFIXES = ["GJJ_", "GuoJiJun_", "GJJ-"];
```

---

## 📝 技术细节

### ComfyUI 节点生命周期

1. **beforeRegisterNodeDef**：节点定义注册前调用
   - 此时可以修改节点原型
   - 添加 `getTitleButtons` 方法

2. **setup**：应用初始化完成后调用
   - 可以为已存在的节点添加按钮
   - 执行一次性初始化逻辑

### getTitleButtons API

这是 ComfyUI 提供的标准按钮添加方式：

```javascript
{
    content: string,      // 按钮显示的文本或 emoji
    callback: Function,   // 点击回调函数
    hint?: string,        // 鼠标悬停提示（可选）
}
```

**优势**：
- ✅ 自动定位到 header 右上角
- ✅ 自动处理 z-index 和布局
- ✅ 与 ComfyUI 主题兼容
- ✅ 不影响节点其他功能

---

## ✨ 总结

✅ **已完成**：
- 创建了 `gjj_help_button_manager.js` 脚本
- 使用 ComfyUI 标准的 `getTitleButtons` API
- 自动识别并处理所有 GJJ 节点
- 精确定位到 header 右上角

✅ **符合规范**：
- 不修改节点核心逻辑
- 使用官方推荐方式
- 零侵入性，易于维护
- 自动加载，无需手动配置

✅ **用户体验**：
- 统一的视觉风格
- 清晰的交互反馈
- 便捷的帮助访问
- 不影响正常工作流

**现在所有 GJJ 节点的帮助按钮都会显示在 header 右上角，方便用户快速访问帮助文档！** 🎊
