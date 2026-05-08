# 视频分段编辑器节点刷新功能开发经验

## 概述

本文档记录了为 `GJJ · ✂️ 可视化视频分段编辑器` 添加节点刷新功能的完整开发经验和关键修复步骤。该功能需要与 `GJJ · ✂️ 可视化音频分段编辑器` 的刷新行为保持完全一致。

## 核心问题

### 问题1：初始实现使用了错误的队列函数

**症状**：视频分段编辑器刷新功能无法正常工作

**原因**：最初使用了 `gjj_utils.js` 中的 `queueNode` 函数，但这个函数的功能不够强大

**解决方案**：使用音频编辑器中的 `queueOnlyCurrentNode` 函数替代

### 问题2：commit 方法调用了 syncOutputs 导致 DOM 冲突

**症状**：点击刷新按钮后抛出异常，刷新失败

**根本原因**：
- 视频编辑器在 `refreshVideo` 中调用了 `this.commit()`
- `commit()` 方法内部调用了 `syncOutputs()`
- `syncOutputs()` 会触发 `stabilizeNode()` 动态调整输出接口
- 在刷新过程中进行 DOM 操作可能导致时序冲突

**解决方案**：
- 在 `refreshVideo` 中直接调用 `_syncSegmentsJSON()` 和 `_syncProperties()`
- 不调用完整的 `commit()` 方法，避免触发输出接口的动态调整
- 与音频编辑器的 `refreshAudio` 实现保持一致

### 问题3：stabilizeNode 缺少异步高度更新

**症状**：节点高度可能无法正确更新

**原因**：视频编辑器的 `stabilizeNode` 函数缺少异步更新节点高度的逻辑

**解决方案**：添加 `requestAnimationFrame` 异步更新节点高度，避免 DOM 重排时序问题

## 关键代码实现

### 1. 添加专用节点队列函数

在文件开头添加三个关键函数（与音频编辑器完全一致）：

```javascript
// 刷新节点画布
function refreshNodeCanvas(node) {
    if (!node) return;
    
    try { node.setDirtyCanvas?.(true, true); } catch (_) {}
    try { node.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
    try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) {}
    try { app.canvas?.setDirty?.(true, true); } catch (_) {}
}

// 判断是否为输出节点
function isExecutionOutputNode(node) {
    if (!node) return false;
    if (node === undefined || node === null) return false;
    if (node.comfyClass === NODE_NAME) return true;
    if (node.constructor?.nodeData?.output_node === true) return true;
    if (node.nodeData?.output_node === true) return true;
    if (node.flags?.output === true) return true;
    return false;
}

// 只执行当前节点的专用函数
async function queueOnlyCurrentNode(node) {
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
                n.mode = 2; // 2 = 禁用
            }
        }
        
        // 只选中当前节点
        if (app.canvas) {
            app.canvas.selected_nodes = {};
            app.canvas.selected_nodes[node.id] = node;
            app.canvas.selected_node = node;
        }
        
        refreshNodeCanvas(node);
        
        // 执行队列
        if (typeof app.queuePrompt === "function") {
            await app.queuePrompt(0, 1);
            return true;
        }
        
        console.warn("[GJJ] app.queuePrompt 不存在，无法只刷新当前节点");
        return false;
    } finally {
        // 恢复其他节点状态
        for (const [n, mode] of savedModes) {
            n.mode = mode;
        }
        
        if (app.canvas) {
            app.canvas.selected_nodes = oldSelectedNodes;
            app.canvas.selected_node = oldSelectedNode;
        }
        
        refreshNodeCanvas(node);
    }
}
```

### 2. 完善 commit 方法

```javascript
commit() {
    this._syncSegmentsJSON();
    this._syncProperties();
    this.node.graph?.setDirtyCanvas?.(true, true);
    this.syncOutputs();
}

_syncSegmentsJSON() {
    const widget = this.node.widgets?.find(w => w.name === "segments_json");
    
    if (widget) {
        widget.value = JSON.stringify(this.segments);
        
        if (widget.callback) {
            try {
                widget.callback(widget.value);
            } catch (_) {}
        }
    }
}

_syncProperties() {
    if (!this.node.properties) {
        this.node.properties = {};
    }
    
    this.node.properties.segments = JSON.stringify(this.segments);
    
    refreshNodeCanvas(this.node);
}

syncOutputs() {
    const targetCount = Math.max(1, this.segments.length);
    stabilizeNode(this, targetCount);
}
```

### 3. 添加异步节点高度更新

```javascript
function stabilizeNode(node, segmentCount) {
    if (!node) return;
    
    const actualCount = Math.max(1, segmentCount || 1);
    const targetOutputs = actualCount + 1;
    
    ensureLeadingSegmentListOutput(node);
    
    // 添加缺失的视频输出
    const videoOutputs = getVideoOutputs(node);
    for (let i = videoOutputs.length; i < actualCount; i++) {
        const outputName = `视频片段${i + 1}`;
        addDynamicOutput(node, "VIDEO", outputName);
    }
    
    removeUnusedOutputsFromEnd(node, targetOutputs);
    renameOutputsSequentially(node, actualCount);
    setDirty(node);
    
    // 异步更新节点高度，避免 DOM 重排时序问题
    requestAnimationFrame(() => {
        if (!node) return;
        
        // 保留用户手动调整的宽度
        const currentWidth = Math.max(420, Number(node.size?.[0] || 420));
        
        // 使用 computeSize 计算新高度
        const computed = node.computeSize?.() || node.size;
        const newHeight = Math.max(320, Number(computed?.[1] || 320));
        
        // 仅更新高度，保留宽度
        node.setSize?.([currentWidth, newHeight]);
        refreshNodeCanvas(node);
    });
}
```

### 4. 实现 refreshVideo 方法

```javascript
async refreshVideo() {
    if (!this.node || !this.node.graph) return;
    
    console.log("[GJJ] 刷新视频预览: 只执行当前节点");
    
    const btn = this.refreshBtn;
    const originalText = btn.textContent;
    
    try {
        btn.textContent = "🔄 刷新中...";
        btn.disabled = true;
        btn.style.cursor = "not-allowed";
        btn.style.opacity = "0.65";
        
        // 直接同步数据，不调用 commit()（与音频编辑器一致）
        this._syncSegmentsJSON();
        this._syncProperties();
        
        // 使用专用函数只刷新当前节点
        const ok = await queueOnlyCurrentNode(this.node);
        
        if (!ok) {
            console.warn("[GJJ] 当前节点刷新失败：queueOnlyCurrentNode 返回 false");
        }
    } catch (err) {
        console.error("[GJJ] 刷新视频失败:", err);
        alert("刷新失败，请检查控制台错误信息");
    } finally {
        setTimeout(() => {
            btn.textContent = originalText;
            btn.disabled = false;
            btn.style.cursor = "pointer";
            btn.style.opacity = "1";
        }, 500);
    }
}
```

### 5. 添加右键菜单选项

```javascript
{
    content: "只刷新当前节点",
    callback: () => {
        this.__gjjVideoSegmentEditor.refreshVideo();
    },
}
```

## 关键经验总结

### 1. 刷新功能不应调用完整的 commit

**错误做法**：
```javascript
async refreshVideo() {
    this.commit();  // ❌ 会触发 syncOutputs() 和 stabilizeNode()
    await queueOnlyCurrentNode(this.node);
}
```

**正确做法**：
```javascript
async refreshVideo() {
    this._syncSegmentsJSON();  // ✅ 只同步 JSON 数据
    this._syncProperties();    // ✅ 只同步节点属性
    await queueOnlyCurrentNode(this.node);
}
```

**原因**：
- `commit()` 方法通常用于用户交互时的数据提交（如拖拽分段边界）
- 刷新时只需同步数据到 widget 和属性，不需要调整输出接口
- 避免在刷新过程中进行复杂的 DOM 操作，防止时序冲突

### 2. stabilizeNode 必须使用异步高度更新

**为什么需要 requestAnimationFrame**：
- DOM 操作是同步的，但浏览器渲染是异步的
- 如果在同一帧中连续修改节点尺寸和触发重绘，可能导致渲染时序问题
- `requestAnimationFrame` 确保在下一帧才更新高度，避免冲突

### 3. queueOnlyCurrentNode 的工作原理

核心逻辑：
1. 临时禁用其他所有输出节点（mode = 2）
2. 只选中当前节点
3. 调用 `app.queuePrompt(0, 1)` 执行队列
4. 执行完成后恢复其他节点状态
5. 刷新画布显示

这样做的好处：
- 只执行当前节点，不影响工作流中的其他节点
- 大幅加快刷新速度
- 用户交互体验更好

### 4. 保持与音频编辑器的一致性

视频和音频分段编辑器应该保持相同的刷新行为：
- 使用相同的队列函数
- 使用相同的数据同步方式
- 使用相同的节点高度更新机制
- 使用相同的错误处理和用户反馈

## 相关文件

- `/js/gjj_video_segment_editor.js` - 视频分段编辑器前端实现
- `/js/gjj_audio_timestamp_editor.js` - 音频分段编辑器前端实现（参考）
- `/js/gjj_utils.js` - 公共工具函数库
- `/nodes/gjj_video_segment_editor.py` - 视频分段编辑器后端实现

## 测试要点

1. **基本刷新功能**：点击刷新按钮，只执行当前节点
2. **数据同步**：分段数据正确同步到 widget 和节点属性
3. **节点高度**：节点高度能正确自动调整
4. **右键菜单**：右键菜单中的"只刷新当前节点"选项正常工作
5. **错误处理**：刷新失败时有明确的错误提示
6. **按钮状态**：刷新过程中按钮正确显示禁用状态

## 后续优化建议

1. **性能优化**：对于大量分段的情况，可以考虑防抖机制
2. **用户反馈**：添加刷新进度的视觉反馈
3. **快捷键**：支持键盘快捷键触发刷新
4. **自动刷新**：在分段数据变化后自动触发刷新（可选）

## 版本历史

- 2026-05-07：初始实现，参考音频编辑器完成刷新功能
- 2026-05-07：修复刷新失败问题，添加异步高度更新
- 2026-05-07：优化刷新逻辑，避免调用完整的 commit 方法
