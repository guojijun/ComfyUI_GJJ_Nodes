# ComfyUI Boolean 控件改按钮并隐藏（无空行最优方案）

## 问题描述

在 ComfyUI 节点开发中，需要将 Boolean 控件改为自定义按钮形式，同时：
1. 完全隐藏原始 Boolean 控件，不产生空行
2. 确保 Boolean 值能够正确传递给后端
3. 按钮点击正常，不被其他元素遮挡

## 核心难点

- ComfyUI 的 LiteGraph 引擎会为 `required` 和 `optional` 中定义的所有参数自动创建 widget
- 即使将 widget 设置为 `hidden`、返回负高度、移出可视区，在某些版本中仍会预留空行
- 工作流加载时会从旧数据中恢复 widgets，需要彻底删除旧 widgets
- 隐藏 widget 可能遮挡自定义 DOM 按钮

## 最优解决方案（node.properties 方案）

### 核心思路

**完全不使用 widget 传递 Boolean 状态，直接使用 `node.properties`**：
- 前端按钮点击时直接将状态写入 `node.properties`
- `node.properties` 会自动序列化到工作流 JSON 中
- 后端通过 `extra_pnginfo` + `unique_id` 从 workflow 中读取当前节点的 `properties`
- **不创建任何隐藏 widget，因此不会有空行**

### 优势

1. ✅ **完全没有任何隐藏 widget** - 不需要隐藏任何东西
2. ✅ **绝对不会产生空行** - 没有 widget 就没有空行
3. ✅ **鼠标不会触发编辑框** - 没有 Value 输入框
4. ✅ **代码更简洁** - 减少了 100+ 行代码
5. ✅ **状态仍然持久化** - `node.properties` 会序列化到工作流
6. ✅ **比 JSON widget 方案更干净** - 这是 ChatGPT 推荐的更优解

---

## 后端实现

### 1. 修改 INPUT_TYPES

**不要在 `required` 或 `optional` 中定义 Boolean 参数**：

```python
@classmethod
def INPUT_TYPES(cls):
    return {
        "required": {
            # ... 其他参数（不要定义 Boolean 参数） ...
            "mode": (MODE_OPTIONS, {
                "default": "单人克隆",
                "display_name": "合成模式",
            }),
            # ... 其他参数 ...
        },
        "optional": {
            **_build_optional_inputs(),
            # 注意：不再定义单独的 Boolean 参数
        },
        "hidden": {
            "unique_id": "UNIQUE_ID",
            "extra_pnginfo": "EXTRA_PNGINFO",
        },
    }
```

**关键点**：
- 确保 `unique_id` 和 `extra_pnginfo` 在 `hidden` 中定义
- 完全不要定义 `bool_settings` 或任何 Boolean 参数

### 2. 修改 generate() 函数

从 `extra_pnginfo` 和 `unique_id` 中读取 `node.properties`：

```python
def generate(
    self,
    mode,
    model_path,
    # ... 其他参数 ...
    mp3_filename_prefix="audio/GJJ_FishAudioS2",
    mp3_quality="320k",
    unique_id=None,
    extra_pnginfo=None,
    **kwargs,
):
    # 从 properties 读取 Boolean 值（通过 extra_pnginfo + unique_id）
    props = {}
    try:
        if extra_pnginfo and isinstance(extra_pnginfo, dict):
            workflow = extra_pnginfo.get("workflow", {})
            if isinstance(workflow, dict):
                nodes = workflow.get("nodes", [])
                if isinstance(nodes, list):
                    uid = str(unique_id)
                    for n in nodes:
                        if isinstance(n, dict) and str(n.get("id")) == uid:
                            props = n.get("properties", {}) or {}
                            break
    except Exception:
        props = {}
    
    keep_model_loaded = bool(props.get("keep_model_loaded", True))
    offload_to_cpu = bool(props.get("offload_to_cpu", False))
    compile_model = bool(props.get("compile_model", False))
    
    # 使用解析后的 Boolean 值
    # ...
```

**关键点**：
- `generate()` 函数签名中**不要有 Boolean 参数**
- 通过 `extra_pnginfo` 获取 workflow 信息
- 通过 `unique_id` 找到当前节点
- 从节点的 `properties` 中读取 Boolean 值

---

## 前端实现

### 1. 彻底删除旧的 Boolean widgets

处理从工作流加载的旧数据：

```javascript
function patchNode(node) {
    if (!node || node.__gjjFishAudioS2Patched) {
        return;
    }
    node.__gjjFishAudioS2Patched = true;
    
    // ... 其他初始化逻辑 ...
    
    // 彻底删除旧的 Boolean widgets（从工作流加载的旧数据）
    BOOL_WIDGETS.forEach(widgetName => {
        const widgetIndex = (node.widgets || []).findIndex(w => w.name === widgetName);
        if (widgetIndex !== -1) {
            // 从 widgets 数组中完全移除
            node.widgets.splice(widgetIndex, 1);
        }
    });
    
    // ... 其他初始化逻辑 ...
}
```

**关键点**：
- 使用 `splice()` 从数组中删除，而不是隐藏
- 这样就不会产生任何空行
- **不需要隐藏 `bool_settings` widget，因为根本不需要它**

### 2. 初始化 Boolean 状态

```javascript
// 初始化 Boolean 状态（使用 node.properties）
BOOL_WIDGETS.forEach(widgetName => {
    if (!node.properties) node.properties = {};
    if (node.properties[widgetName] === undefined) {
        node.properties[widgetName] = widgetName === "keep_model_loaded" ? true : false;
    }
});
```

### 3. 按钮点击时直接保存到 properties

```javascript
// 点击切换状态
btn.addEventListener("click", () => {
    btn.__boolValue = !btn.__boolValue;
    
    // 更新按钮样式
    if (btn.__boolValue) {
        btn.style.background = "#5aa8ff";
        btn.style.color = "#fff";
    } else {
        btn.style.background = "#3a3a3a";
        btn.style.color = "#aaa";
    }
    
    // 保存到 node.properties（用于持久化和后端读取）
    if (!node.properties) node.properties = {};
    node.properties[config.name] = btn.__boolValue;
    
    // 通知 ComfyUI 节点已更改
    node.setDirtyCanvas?.(true, true);
    node.graph?.setDirtyCanvas?.(true, true);
    node.graph?.change?.();
});
```

**关键点**：
- 直接将 Boolean 值保存到 `node.properties`
- **不需要同步到任何 widget**
- 调用 `setDirtyCanvas` 和 `graph.change()` 确保状态持久化

### 4. 初始化时从 properties 恢复状态

```javascript
// 同步 Boolean 按钮状态（从 properties 初始化）
const status = node.__gjjFishAudioS2Status;
if (status?.boolButtons) {
    Object.entries(status.boolButtons).forEach(([name, btn]) => {
        // 从 properties 读取值
        const value = node.properties?.[name] ?? btn.__boolValue;
        btn.__boolValue = value;
        
        // 更新按钮样式
        if (btn.__boolValue) {
            btn.style.background = "#5aa8ff";
            btn.style.color = "#fff";
        } else {
            btn.style.background = "#3a3a3a";
            btn.style.color = "#aaa";
        }
    });
}
```

**关键点**：
- 优先从 `node.properties` 读取值
- 不需要从任何 widget 恢复状态

---

## 数据流

```
用户点击按钮
    ↓
更新 btn.__boolValue
    ↓
保存到 node.properties
    ↓
ComfyUI 序列化 node.properties 到工作流 JSON
    ↓
后端通过 extra_pnginfo 获取 workflow
    ↓
通过 unique_id 找到当前节点
    ↓
读取节点的 properties
    ↓
获取 Boolean 值
    ↓
使用 Boolean 值执行逻辑
```

---

## 关键要点

### 必须做的

1. **后端**：
   - 在 `hidden` 中定义 `unique_id` 和 `extra_pnginfo`
   - **从 `required` 和 `optional` 中删除所有 Boolean 参数**
   - **从 `generate()` 函数签名中移除 Boolean 参数**
   - 在函数开始时从 `extra_pnginfo` 读取 properties

2. **前端**：
   - **使用 `splice()` 彻底删除旧的 Boolean widgets**（处理工作流加载的旧数据）
   - 按钮点击时直接保存到 `node.properties`
   - 初始化时从 `node.properties` 恢复状态

3. **重启服务器**：
   - 修改后端 Python 代码后，**必须重启 ComfyUI 服务器**
   - 前端代码修改后刷新浏览器即可

### 不要做的

1. ❌ 不要在 `required` 或 `optional` 中保留 Boolean 参数
2. ❌ 不要试图隐藏 Boolean widgets（必须彻底删除）
3. ❌ 不要在 `generate()` 函数签名中保留 Boolean 参数
4. ❌ 不要创建 `bool_settings` 或其他 JSON widget
5. ❌ 不要忘记重启 ComfyUI 服务器

---

## 常见错误

### 错误 1：TypeError missing required positional arguments

**原因**：后端 `generate()` 函数签名中仍有 Boolean 参数

**解决**：检查函数签名，确保只接收 `unique_id` 和 `extra_pnginfo`，移除所有 Boolean 参数

### 错误 2：控件还在（未隐藏）

**原因**：工作流加载了旧数据，ComfyUI 重建了 Boolean widgets

**解决**：使用 `splice()` 彻底删除旧的 widgets

### 错误 3：空行出现

**原因**：试图隐藏 widgets 而不是删除它们

**解决**：使用 `splice()` 从数组中删除，不要使用 `hidden = true`

### 错误 4：按钮无法点击

**原因**：隐藏的 widget 遮挡了按钮（旧方案）

**解决**：新方案中不需要任何隐藏 widget，因此不会有这个问题

---

## 参考实现

- `d:\AI\MOD\custom_nodes\GJJ\nodes\gjj_fish_audio_s2_generator.py` - 应用此方案的节点（后端）
- `d:\AI\MOD\custom_nodes\GJJ\js\gjj_fish_audio_s2_generator.js` - 应用此方案的节点（前端）

---

## 总结

这个方案的核心是**完全不使用 widget 传递 Boolean 状态**，而是直接使用 `node.properties`。通过将 Boolean 状态直接保存到 `properties`，前端完全不需要创建或隐藏任何 widget，后端也能通过 `extra_pnginfo` 正确接收数据。

这是 ComfyUI 节点开发中处理隐藏参数的**最优雅方案**，已被实践验证有效，比使用隐藏 JSON widget 的方案更干净、更简洁。
