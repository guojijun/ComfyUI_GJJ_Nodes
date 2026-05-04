# ComfyUI 技能综合文档

本文档整合了与 ComfyUI 相关的所有技能知识，包括 GJJ 节点开发、动态插槽管理、模型族预设等。

---

## 1. ComfyUI 动态插槽 (comfyui-dynamic-slots)

### 核心模式

对于 GJJ 节点，参考 `GJJ_AnySwitch.js` 中的 stabilize 结构方法。

核心模式:
- 实现一个 `stabilizeNode(node)` 函数，在一个地方执行所有插槽维护。
- 实现 `scheduleStabilize(node, ms=32)` 并使用节点本地计时器。
- 在 `beforeRegisterNodeDef` 中挂钩 `onNodeCreated`、`onConfigure`、`onConnectionsChange`。
- 在 `setup()` 中重新稳定图上已有的节点。

### 动态输入

`stabilizeNode(node)` 内的首选顺序:
1. 按排序顺序读取当前动态输入。
2. 删除未使用的尾部输入，至少保留一个可见输入。
3. 确保恰好有一个尾部空输入。
4. 按顺序重命名输入。
5. 应用标签、本地化名称和工具提示。
6. 调用画布脏区域辅助函数。

### 动态输出

当输出应该从节点真正消失时，不要只依赖 `output.hidden = true`。

推荐模式:
1. 首先保持始终可用的输出稳定。
2. 当条件满足时，如果缺少则 `addOutput()` 可选输出。
3. 当条件不再满足时，从尾部 `removeOutput()` 直到只剩下稳定的输出。
4. 每次稳定通过后重新应用输出名称、本地化名称、类型和工具提示。

仅在槽口必须出于API兼容性而存在时才使用隐藏。如果用户期望槽口在视觉上消失，请使用真正的添加/删除输出逻辑。

对于相同类型的重复输出（`结果 1...N`、`图片 1...N`），动态扩展是默认的。优先显示稳定的聚合输出以及一个尾随项目输出，当最后一个可见输出被链接时添加下一个项目输出，并移除未使用的尾随项目输出。

### 混合类型动态输出（固定首槽 + 编号尾槽）

常见 GJJ 模式：一个 STRING/聚合输出 + N 个同类型 AUDIO/IMAGE 输出。

关键规则：
1. **Python RETURN_TYPES 必须预先分配足够槽位。** 如果 JS 可添加上限 99 个动态输出，声明 `RETURN_TYPES = ("STRING",) + ("AUDIO",) * 99`，否则 ComfyUI 校验会因槽位不足报错。
2. **`renameOutputsSequentially` 需为每种输出类型使用独立计数器**，不能直接用循环索引 `i`（因为固定首槽占用 slot 0）。
3. **`addDynamicOutput` 后立即调用 `renameOutputsSequentially`** 修复标签。
4. **`removeUnusedOutputsFromEnd` 绝不能删除固定首槽输出**（用输出名检查做保护）。

### DOM 工具栏和按钮区域

- 不要硬编码过时的固定高度，除非内容确实是固定的。
- 对于可能溢出节点宽度的行，首选 `flex-wrap: wrap`。
- 使用 `requestAnimationFrame` 测量实际容器高度并存储在节点上，在 `getHeight()` 和 `computeSize()` 中使用。
- 高度更改后，调用画布脏区域辅助函数使节点与内容一起调整大小。

### Node 2.0 动态面板

当大参数组切换时（如 `风格 / 主体 / 环境`），Node 2.0 隐藏小部件会留空白：
- 只保留始终可见的小部件（基本文本字段、种子、面板工具栏）。
- 在一个自定义 DOM 面板中渲染活动部分详情，当前部分更改时重建该面板。
- 将原生小部件仅作为内部状态载体，隐藏并从命中测试中排除。
- 如用户希望套接字真正消失，结构上移除槽口而非仅仅隐藏。

### 自定义预览节点

- 如果节点在 JS 中绘制自己的预览，不要同时从 Python 返回标准 `ui.images`。
- 偏好使用自定义键如 `preview_images`、`preview_text`、`preview_kind`，让节点 JS 消费这些键。
- 清除 `node.imgs` 或 `node.preview` 有帮助，但更可靠的做法是当节点拥有预览 UI 时停止返回系统预览负载。

### m4a / 非标准音频格式回退

`soundfile` (`sf.read`) 不支持 `.m4a` (AAC)、部分 `.ogg` 变体等。加载音频时：
- 先尝试 `sf.read(filepath)`。
- 异常时调用 `ffmpeg -i filepath -acodec pcm_s16le -ar 44100 -ac 2 tmp.wav`，然后 `sf.read(tmp.wav)`。
- 立即清理临时 WAV。
- 两者均失败则抛出合并的 RuntimeError。

### widget callback → queueNode 自动刷新

文件选择控件变化时触发重执行：
```javascript
audioFileWidget.callback = function (...args) {
  const result = origCallback?.apply(this, args);
  try { app.graph?.queueNode?.(self); } catch (_) {}
  return result;
};
```

### 快速检查清单

- 动态输入在最后一个可见槽位获得链接时扩展
- 链接移除时额外空槽位折叠
- 可选输出在条件不满足时真正消失
- 旧图节点在重载后通过 `onConfigure` 和 `setup()` 恢复
- 添加/删除后标签保持顺序
- 节点大小在稳定后刷新
- DOM 工具栏自然换行且与节点高度无底部悬空间隙
- 自定义预览节点只发出一种预览路径
- Python RETURN_TYPES 为 JS 动态输出预分配足够槽位
- 混合类型输出列表使用独立类型组计数器
- 音频加载回退到 ffmpeg 处理 soundfile 无法解码的格式

---

## 2. ComfyUI GJJ 节点迁移 (comfyui-gjj-node-migration)

### 核心规则

1. **使用经典 ComfyUI 节点定义。** 使用 `INPUT_TYPES`、`RETURN_TYPES`、`FUNCTION`、`CATEGORY`、`NODE_CLASS_MAPPINGS`、`NODE_DISPLAY_NAME_MAPPINGS`。

2. **分离前台/后台注册。** 前台用户节点用 `GJJ_` 前缀，后台/参考/帮助节点用 `guojijun_` 前缀。后台节点 `CATEGORY` 放在 `guojijun/内部引用` 下，`DEPRECATED = True`，`SEARCH_ALIASES = []`，显示名以 `guojijun ·` 开头。

3. **GJJ 显示约定。** 前台显示名格式 `GJJ · <emoji> <中文名称>`，如 `GJJ · 📝 文本合并`。模块文件用 `gjj_` 前缀 + snake_case，如 `gjj_image_collage.py`。

4. **全部中文标签。** 每个输入须有中文 `display_name` 和 `tooltip`。每个输出须有中文 `RETURN_NAMES` 和 `OUTPUT_TOOLTIPS`。

5. **零外部依赖。** 不依赖第三方自定义节点包。不引入额外 pip 依赖。优先使用 Python 标准库、ComfyUI 内置功能和 GJJ 本地帮助模块。小帮助函数直接内联。

6. **前端行为在 GJJ 内。** ComfyUI 前端扩展放在 `<GJJ>/js`。前端标签/按钮/提示/空状态均为中文。

7. **工作流包装节点显示状态。** 显示执行进度、执行时间。中文错误消息。

8. **所有用户字段中文。** 不暴露 `user_prompt`/`system_prompt` 等内部参数。不暴露机器绝对路径（规范化为 `models/...` 等相对路径）。

9. **面板宽/高度优先级。** 外部连接时用外部值并清面板显示。无外部连接时用面板值。新源检测时更新面板尺寸。持久化到 `properties`，存储源签名防覆盖。

10. **Lazy Image Studio 提示输入标准。** 正/负提示用普通 `STRING` 控件，默认 `multiline: False`，不设 `forceInput: True`。依靠 ComfyUI 原生小点机制同时支持面板编辑和外部链接。

### 音频/预览节点模式

适用场景：音频编辑器或波形预览节点（音频加载 + JSON 分段数据 + 动态 N 输出音频切片 + Canvas 波形可视化）。

**Python 后端：**
- `OUTPUT_NODE = True`，`RETURN_TYPES = ("STRING",) + ("AUDIO",) * 99` 预分配所有 JS 动态输出槽位。
- `is_audio_object()` 辅助函数检查 `{waveform, sample_rate}` 字典形状。
- 音频加载：`sf.read` → `ffmpeg` 回退 → `sf.read(tmp.wav)`。
- 输出元组：`[json_str] + [audio_dict, ...]`，聚合在前，切片在后。
- UI 数据返回 `preview_segments`、`preview_duration`、`preview_sample_rate`、`preview_segment_count`。

**前端 JS：**
- 动态输出管理：`setupOutputs()` 按 `segmentCount + 1` 对齐。
- `renameOutputsSequentially()` 使用按类型组的独立计数器。
- `removeUnusedOutputsFromEnd()` 保护固定首槽不被删除。
- `addDynamicOutput(idx, "名称")` 后立即调用 `renameOutputsSequentially()`。
- 文件下拉回调触发 `app.graph?.queueNode?.(self)` 自动刷新。
- Canvas 波形：`drawWaveform(canvas, samples, sampleRate, segments, selectedIdx)` — `requestAnimationFrame`，尊重 devicePixelRatio，绘制顺序：背景 → 波形线 → 分段矩形 → 选中高亮 → 时间刻度。
- 点击选段：`e.offsetX * canvas.width / canvas.clientWidth` 比例换算。
- 双击添加新分段。

---

## 3. ComfyUI 模型族预设 (comfyui-model-family-presets)

### 默认查找类别

ComfyUI 模型文件夹：`checkpoints/`、`clip/`、`clip_vision/`、`controlnet/`、`loras/`、`vae/`、`unet/`、`upscale_models/`、`embeddings/`、`hypernetworks/`。

### 动态查找规则

1. 优先使用运行时类别列表：
   - `folder_paths.get_filename_list(category)`
   - `folder_paths.get_full_path(...)`
   - `folder_paths.models_dir`

2. 假设类别列表可能包含子目录相对条目。

3. 默认值解析顺序：精确匹配 → 跨子目录基名匹配 → 最长公共连续片段匹配。

4. 不应使用 `folder_paths.models_dir` 手动构建路径；应始终通过 `folder_paths` API。

### 模型族优先级

1. 将所选 UNET 与模型族预设匹配。
2. 从模型族派生 `clip_type`，而不只是从可见 CLIP 控件。
3. 为族自动选择推荐的文本编码器和 VAE。
4. 如族有推荐加速 LoRA，预加载为默认可见 LoRA。
5. 如果启用的 LoRA 名暗示步数，自动覆盖步数。

---

## 4. GJJ LoRA 效果测试器模式

### 核心约定

- 保持执行载荷与显示文本分离。
- 输出 `LORA_CHAIN_CONFIG` 仅包含子目录相对文件名和数字强度：
  ```json
  [{"enabled": true, "name": "SDXL\\644.safetensors", "strength": 1.0}]
  ```
- 绝不在实际 LoRA 配置中包含 `✅`、`❌`、`(1.00)` 等显示前缀。
- 显示标签仅用于文本/列表/注释输出。

### 状态和 UI

- 在 `test_state` 序列化状态控件中存储过滤文本、选定强度、通过/失败键、自动运行、跳过错误和刷新令牌。
- 当前索引默认从 1 开始。
- 过滤、刷新或强度变化时：重新加载池 → 重置索引为 1 → 清除通过/失败列表 → 写入后端状态 → 推送实时文本到预览节点。

### 成功与失败判定

- 仅跟踪连接到 `LORA_CHAIN_CONFIG` 输出的生成消费者节点。
- 消费者报告 `executed` 时标记 ✅，消费者出错时标记 ❌。
- 不相关错误（保存/拼贴/预览/侧分支）不得覆盖已有 ✅。

---

## 5. ComfyUI UI 数据格式规范

### 格式要求

| 数据类型 | 正确格式 | 错误格式 |
|---------|---------|---------|
| 字符串/数值 | `(value,)` 元组 | `"text"` 直接值 |
| 图片列表 | `[list]` 直接列表 | `([list],)` 元组包裹 |
| 音频列表 | `(list,)` 元组包裹 | `[list]` 直接列表 |
| 视频列表 | `(list,)` 元组包裹 | `[list]` 直接列表 |

```python
# ✅ 正确
ui["preview_text"] = ("some text",)
ui["preview_images"] = [{"filename": "img.png"}]
ui["preview_audio"] = ([{"filename": "audio.wav"}],)
ui["preview_video"] = ([{"filename": "video.mp4"}],)
```

```python
# ❌ 错误
ui["preview_text"] = "some text"
ui["preview_audio"] = [{"filename": "audio.wav"}]
```

### 前端解包

```javascript
// 元组字段：取 [0]
this.__previewKind = message?.preview_kind?.[0] || "";
this.__previewText = message?.preview_text?.[0] || "";
// 图片：直接数组
this.__images = Array.isArray(message?.preview_images) ? message.preview_images : [];
// 音频/视频：先取元组[0]再判断数组
this.__audio = Array.isArray(message?.preview_audio?.[0]) ? message.preview_audio[0] : [];
```

### 问题排查流程

```
前端无预览 → 检查 console 是否有 onExecuted 日志
  ├─ 无日志 → onExecuted 未被调用 → 后端 ui 格式错误 → 修正格式
  └─ 有日志但数据空 → 前端解包错误 → 确认 message 结构 → 修正解包
```

---

## 6. ComfyUI 节点开发实战：音频分段编辑器

### 架构设计

```
输入层：
  - 外部音频 (AUDIO) - 可选
  - 音频文件 (COMBO) - 节点内选择
  - 分段列表JSON (STRING) - 手动配置

处理层：
  1. 加载音频（外部优先于内部）
  2. 解析/生成分段列表
  3. 按时间段批量裁剪
  4. 构建固定数量输出

输出层：
  - 分段列表 (STRING) - 第1个输出
  - 音频片段1..N (AUDIO) - 动态数量

UI数据：
  - preview_segments - 分段JSON
  - preview_duration - 音频时长
  - preview_segment_count - 分段数量
```

### 关键技术模式

**固定最大输出 + None 填充：**
```python
MAX_OUTPUTS = 99
RETURN_TYPES = tuple(["AUDIO"] * MAX_OUTPUTS + ["STRING"])
result_list = [actual_audio[i] if i < len(actual_audio) else None for i in range(MAX_OUTPUTS)]
result_list.append(json_str)
```

**双标记可视化（起止时间）：**
- 开始标记：青绿色 `#4ecdc4`
- 结束标记：红色 `#ff6b6b`
- 填充区域：半透明 `rgba(78, 205, 196, 0.2)`
- 约束：start ≤ end - 0.01

**音频裁剪：**
```python
start_sample = max(0, min(int(start * sr), total - 1))
end_sample = max(start_sample + 1, min(int(end * sr), total))
cropped = waveform[..., start_sample:end_sample].contiguous()
```

**节点内文件选择器：**
```python
@classmethod
def _get_files(cls, dir_type, extensions):
    files = ["[不加载]"]
    search_dir = folder_paths.get_input_directory()
    for root, _, filenames in os.walk(search_dir):
        for name in filenames:
            if Path(name).suffix.lower() in extensions:
                files.append(name)
    return files
```

### 常见问题

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 输出全是 None | 分段列表为空或格式错误 | 检查 JSON 格式 |
| 裁剪失败 | 时间范围超出时长 | 边界检查限制在 [0, duration] |
| 波形不显示 | 音频未加载或格式不支持 | 检查音频数据格式 |
| 前端标记拖不动 | Canvas 事件未绑定 | 检查 bindEvents() |

---

## 7. 通用最佳实践

- **1-based 编号：** 用户面编号/范围从 1 开始。内部索引才用 0-based。
- **批量节点步进：** 范围输出 `start + count - 1` 后自动前进 `count` 而非 1。
- **GJJ 批量类型：** 使用 `GJJ_BATCH_IMAGE` 精确类型，不附加 `,IMAGE` 回退。
- **LaTeX 节点模式切换：** 优先 show + disable 而非硬隐藏，避免 Node 2.0 布局异常。
- **API 兼容性：** 旧工作流 `widgets_values` 可能过时，引导用户重加节点。
- **模型查找：** 子目录感知 + 最长公共片段匹配 + 扩展名剥离 + 信任度阈值。
- **DOMWidget 高度：** 内容驱动，用 `scrollHeight` 计算，保留用户宽度。
- **长文本编辑：** 隐藏原生 STRING 控件，使用 GJJ 自有 textarea，通过 `properties` 持久化。

---