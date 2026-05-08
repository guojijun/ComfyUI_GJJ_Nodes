# DOM文本更新防重复规范

## 概述

在前端JavaScript开发中，特别是在ComfyUI自定义节点开发场景下，经常需要更新包含固定前缀/后缀的DOM元素文本。为了避免在界面中重复显示静态文本内容，必须遵循严格的更新规范。

## 问题场景

当HTML结构中已经包含了静态文本（如标签、单位等），如果在JavaScript中错误地重复拼接这些静态文本，会导致界面显示异常，出现重复的文字内容。

### 典型错误示例

**HTML结构**：
```html
<span>时长: <label id="duration">0.0</span>秒</span>
```

**错误的JavaScript更新方式**：
```javascript
// ❌ 错误：重复拼接静态文本
const element = document.querySelector('span');
element.textContent = '时长: ' + newValue + '秒';
```

**错误后果**：
- 第一次更新：显示 "时长: 10.0秒" ✓
- 第二次更新：显示 "时长: 时长: 20.0秒秒" ❌
- 第三次更新：显示 "时长: 时长: 时长: 30.0秒秒秒" ❌

## 正确解决方案

### 方案一：仅更新动态部分（推荐）

**核心原则**：只更新HTML结构中的动态内容部分，保持静态文本在HTML中定义。

**实现步骤**：

1. **HTML结构设计**：
   ```html
   <!-- 静态文本在HTML中定义 -->
   <span>时长: <label id="duration">0.0</label>秒</span>
   ```

2. **JavaScript更新逻辑**：
   ```javascript
   // ✅ 正确：仅更新动态部分
   const durationElement = document.getElementById('duration');
   durationElement.textContent = newValue;
   ```

### 方案二：完全动态控制（适用于复杂场景）

**适用场景**：当无法预先确定HTML结构，或者需要完全动态控制整个文本内容时。

**实现步骤**：

1. **HTML结构设计**：
   ```html
   <!-- 整个内容由JavaScript控制 -->
   <span id="full-duration"></span>
   ```

2. **JavaScript更新逻辑**：
   ```javascript
   // ✅ 正确：完全控制整个内容
   const fullDurationElement = document.getElementById('full-duration');
   fullDurationElement.textContent = `时长: ${newValue}秒`;
   ```

## ComfyUI自定义节点最佳实践

在ComfyUI自定义节点开发中，应遵循以下额外规范：

### 1. 使用标准API创建UI

```javascript
// ✅ 推荐：使用addDOMWidget创建UI容器
const container = node.addDOMWidget("status_container", "text", {
    // 配置选项
});
```

### 2. 单容器管理策略

- 创建一个DOMWidget作为根容器
- 内部子元素使用原生HTML/DOM API管理
- 更新时仅清空容器`innerHTML`并重绘

### 3. 避免外部DOM操作

```javascript
// ❌ 禁止：直接操作外部DOM
document.querySelector('.comfy-node').innerHTML += '<div>新内容</div>';

// ✅ 推荐：通过标准API操作
node.addDOMWidget("custom_widget", "text", widgetConfig);
```

## 常见模式与模板

### 模式1：状态显示面板

**HTML模板**：
```html
<div class="status-panel">
    <div>处理进度: <span class="progress-value">0%</span></div>
    <div>剩余时间: <span class="remaining-time">--</span></div>
    <div>文件大小: <span class="file-size">0 MB</span></div>
</div>
```

**JavaScript更新**：
```javascript
// 更新进度
document.querySelector('.progress-value').textContent = `${progress}%`;

// 更新剩余时间  
document.querySelector('.remaining-time').textContent = remainingTime;

// 更新文件大小
document.querySelector('.file-size').textContent = `${fileSize} MB`;
```

### 模式2：数值调节器显示

**HTML模板**：
```html
<div class="slider-display">
    <label>亮度: </label>
    <input type="range" id="brightness-slider" min="0" max="100" value="50">
    <span id="brightness-value">50</span>
    <span>%</span>
</div>
```

**JavaScript更新**：
```javascript
// 仅更新数值部分
document.getElementById('brightness-value').textContent = sliderValue;
```

## 调试与验证方法

### 1. 开发时检查清单

- [ ] HTML结构中的静态文本是否与JavaScript更新逻辑分离？
- [ ] 是否只更新了动态内容部分？
- [ ] 多次更新后是否会出现重复文本？

### 2. 测试用例

```javascript
// 测试多次更新不会产生重复
function testTextUpdate() {
    const element = document.getElementById('test-element');
    const originalText = element.innerHTML;
    
    // 模拟多次更新
    updateText('第一次');
    updateText('第二次'); 
    updateText('第三次');
    
    // 验证最终结果
    const finalText = element.innerHTML;
    console.assert(finalText === '时长: 第三次秒', '文本更新正确');
}
```

## 总结

- **核心原则**：静态文本在HTML中定义，动态内容通过JavaScript单独更新
- **关键技巧**：使用ID或class选择器精确定位动态内容区域
- **避免陷阱**：不要在JavaScript中重复拼接HTML中已存在的静态文本
- **最佳实践**：在ComfyUI开发中优先使用标准API而非直接DOM操作

遵循这些规范可以确保界面显示的一致性和正确性，避免因文本重复导致的用户体验问题。