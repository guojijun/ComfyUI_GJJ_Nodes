---
name: comfyui-dynamic-slots
description: 当需要编辑 ComfyUI 或 GJJ 节点以实现动态可扩展输入/输出插槽时使用。优先使用成熟的 GJJ_AnySwitch.js stabilize 模式，而非临时性的 nodeCreated 逻辑。
---

# ComfyUI 动态插槽

当一个 ComfyUI 节点需要动态输入或输出，根据连接状态进行扩展、收缩、重命名、隐藏或调整大小时，使用此技能。

## 首选模式

对于 GJJ 节点，复制 `<GJJ>/js/GJJ_AnySwitch.js` 中的结构化方案。

核心模式：
- 实现一个 `stabilizeNode(node)` 函数，在一个地方执行所有插槽维护。
- 实现 `scheduleStabilize(node, ms=32)`，使用节点本地计时器。
- 在 `beforeRegisterNodeDef` 中挂钩：
  - `onNodeCreated`
  - `onConfigure`
  - `onConnectionsChange`
- 在 `setup()` 中，对图上已有的节点进行重新稳定。

## 动态输入

`stabilizeNode(node)` 内部推荐顺序：
1. 按排序顺序读取当前动态输入。
2. 删除未使用的尾部输入，至少保留一个可见输入。
3. 确保恰好有一个尾部空输入。
4. 按顺序重命名输入。
5. 应用标签、本地化名称和工具提示。
6. 调用画布脏区域辅助函数。

## 动态输出

当输出应该真正从节点消失时，不要仅依赖 `output.hidden = true`。

推荐模式：
1. 首先保持始终可用的输出稳定。
2. 当条件满足且缺少可选输出时，`addOutput()` 添加它们。
3. 当条件不再满足时，从尾部 `removeOutput()` 直到只剩下稳定输出。
4. 每次稳定通过后重新应用输出名称、本地化名称、类型和工具提示。

仅在出于 API 兼容性需要保留插槽时才使用 `hidden`。如果用户期望插槽在视觉上消失，请使用真正的添加/删除输出逻辑。

对于相同类型的重复输出，如 `结果 1...结果 20`、`图片 1...图片 N`、预览、裁剪片段、选中项或逐项批量结果，动态扩展是默认行为。不要发布一个长时间可见的固定输出列表，除非用户明确要求固定插槽。优先显示稳定聚合输出加上一个尾部项目输出，当最后一个可见输出被链接时添加下一个项目输出，移除未使用的尾部项目输出。如有需要可保留后端返回容量，但前端应结构性隐藏未使用的重复输出。

## 混合类型动态输出（固定首槽 + 编号尾槽）

常见 GJJ 模式：一个 STRING/聚合输出 + N 个同类型 AUDIO/IMAGE 输出。例如：`分段列表`（STRING）+ `音频片段1..N`（AUDIO）。

关键规则：
1. **Python RETURN_TYPES 必须预先分配足够槽位。** 如果 JS 可添加上限 99 个动态输出，声明 `RETURN_TYPES = ("STRING",) + ("AUDIO",) * 99`，否则 ComfyUI 校验会因 `tuple index out of range` 报错。
2. **`renameOutputsSequentially` 需为每种输出类型使用独立计数器，** 不能直接用循环索引 `i`（因为固定首槽占用 slot 0）。例如：
   ```
   let audioIdx = 0;
   for (const output of node.outputs) {
     if (output.name === HEADER_NAME) { /* 按类型 A 重命名 */ }
     else if (audioIdx < segmentCount) {
       audioIdx++;
       output.name = formatName(audioIdx);  // 不是 i
     }
   }
   ```
   使用 `i` 会导致"片段1"被跳过，编号乱序。
3. **`addDynamicOutput` 调用后立即调用 `renameOutputsSequentially`** 修复标签，即使名称看起来已经正确。
4. **`removeUnusedOutputsFromEnd` 绝不能删除固定首槽输出**（用输出名检查做保护：`if (output?.name === SEGMENT_LIST_NAME) continue;`）。

## DOM 工具栏和按钮区域

如果节点添加了包含按钮或预设芯片的 DOM 控件工具栏：
- 不要硬编码过时的固定高度（如 `150`），除非内容确实是固定的。
- 对于可能溢出节点宽度的行，优先使用 `flex-wrap: wrap`。
- 使用 `requestAnimationFrame` 通过 `scrollHeight` 或 `offsetHeight` 测量实际容器高度并存储在节点上，然后在 `getHeight()` 和 `computeSize()` 中使用。
- 高度更改后，调用画布脏区域辅助函数使节点随内容调整大小。
- 如果预设过去被拆分多行仅为避免溢出，优先使用一个自然换行的逻辑组。

## Node 2.0 动态面板

如果 GJJ 节点有大型参数组切换器（如 `风格 / 主体 / 环境 / 随机灵感`），且 Node 2.0 隐藏控件后留下大面积空白：
- 不要不断来回硬性显示/隐藏整个原生控件组。
- 只保留始终可见的小控件（如基本文本字段、种子、分组工具栏）。
- 在一个自定义 DOM 面板中渲染活动分组详情，当前分组更改时重建该面板。
- 将原始原生控件仅作为内部状态载体（如果后端仍需它们），但将其作为内部控件隐藏并排除出命中测试，防止悬停工具提示落在隐藏行上。
- 如果用户需要插槽或输入真正消失，结构性移除它们而非仅隐藏。

`GJJ_PromptPresetStudio` 的实践经验：
- 将 `证件照 / 多角度 / 主体 / 环境 / 随机灵感` 控件移入动态 DOM 详情面板后，中间空白问题得到解决。
- 原始原生详情控件仅作为隐藏数据源留存，可见 UI 完全来自活动 DOM 分组。
- 最终节点高度优先测量当前可见面板，从最后一个可见控件向下收缩节点。

## 自定义预览节点

如果节点在 JS 中绘制自己的预览，除非有意同时显示系统预览，不要同时返回标准 `ui.images`。

规则：
- 如果绘制自己的图片画廊或图片 DOM 预览，Python 端**不要**返回标准 `ui.images`。
- 优先使用自定义键如 `preview_images`、`preview_text`、`preview_kind`，让节点 JS 消费这些键。
- 如果旧版本已发出标准预览键，旧节点实例可能仍保留陈旧预览控件；在 JS 中隐藏或忽略这些旧控件，并用全新添加的节点测试。
- 清除 `node.imgs` 或 `node.preview` 可能有帮助，但更可靠的做法是当节点拥有预览 UI 时停止返回系统预览载荷。

## 重要规则

不要仅依赖 `nodeCreated` 或临时 DOM 事件来实现动态插槽行为。如果动态扩展不稳定，将逻辑回退到 AnySwitch 风格的 stabilize 模式。

## 扩展不稳定排查清单

即使代码看起来正确，插槽仍然不扩展时，首先检查以下具体陷阱：
- 不要在剪除未使用尾部输入之前调用 `ensureTrailingEmptyInput()`。安全顺序为：
  1. 删除旧输入
  2. 剪除未使用尾部输入
  3. 确保一个尾部空输入
  4. 按顺序重命名
- 避免在同一 JS 文件稍后重新定义辅助函数。底部重复的 `setDirty()` 等函数可能因为提升而静默覆盖预期实现。
- 如果 `onConnectionsChange` 对该节点不可靠，保持轻量链接签名（如 `inputName:linkId|...`），在 `onDrawBackground` 中比较；签名变化时安排重新稳定。
- 稳定后，在节点上持久化当前链接签名，使绘制时回退不会每帧触发。
- 如果 UI 看起来隐藏但插槽仍占空间，确认节点是否需要真正的结构性添加/删除而非视觉隐藏。
- 如果节点仍显示重复预览，检查自定义预览 DOM 和系统 `ui.images` 是否同时激活。

## GJJ 特定指南

- 标签和工具提示使用中文。
- 优先使用一个动态前缀，如 `image_`、`any_` 或 `mask_`。
- 内部名称保持零填充编号，如 `image_01`、`image_02`。
- 如果动态节点也依赖本地模型（如 SAM3），通过 ComfyUI 类别列表搜索模型，使用子目录相对名称，采用去除扩展名的最长片段模糊匹配。缺失模型应在节点面板中报出完整的所需相对路径（如 `models/.../<file>`），而不是在节点设计为保持工作流继续时崩溃。
- 对于重复的 GJJ 输入（如 场景1..N、图片1..N、动作图1..N、参考图1..N、说话人1..N），动态扩展是默认行为。不要发布一个初始即显示长固定列表（如 场景1...场景20）的节点，除非明确要求。
- 对于重复的 GJJ 输出（如 结果1..N、图片1..N、裁剪图1..N、单图结果1..N），动态扩展同样默认。在稳定聚合输出后从一个可见项目输出开始，链接被使用时添加一个尾部输出，用真正的 `removeOutput()` 调用剪除未使用尾部项目输出。
- Python 节点应仅声明最小初始插槽，通常是一个尾部空输入。如果后端需要接受动态添加的插槽，使用灵活的可选输入映射或等效的 `__getitem__` / `__contains__` 处理。
- 当预设节点子类化动态基节点时，将每个子类注册键添加到前端 `TARGET_NODES`；否则只有基节点会稳定，预设节点将显示原始固定插槽列表。
- 自定义 GJJ 批处理类型必须保持精确。批处理图片插槽使用 `GJJ_BATCH_IMAGE`，不要用 `GJJ_BATCH_IMAGE,IMAGE`；逗号组合的回退类型会阻止 ComfyUI 匹配 GJJ 批处理插槽。将普通的 `IMAGE` 兼容性放在单独的动态图片插槽上。
- 如果输出有条件显示，当用户期望插槽出现或消失时，优先 JS 端的结构性添加/删除。
- 使用 `apply_patch` 进行手动编辑。

## m4a / 非标准音频格式回退

`soundfile` (`sf.read`) 不支持 `.m4a`（AAC）、部分 `.ogg` 变体或 ffmpeg 可处理的格式。从用户文件加载音频时：

- 先尝试 `sf.read(filepath)`。
- 异常时调用 `ffmpeg -i filepath -acodec pcm_s16le -ar 44100 -ac 2 tmp.wav`，然后 `sf.read(tmp.wav)`。
- 读取后立即清理临时 WAV。
- 两者均失败则抛出合并的 RuntimeError。

不要在后端可以解码更多格式时，在 UI 或文档中悄悄限制仅支持 WAV/MP3/FLAC。

## widget callback → queueNode 自动刷新

当文件选择控件（下拉框/文件选择器）更改且节点需重新执行以刷新波形/预览/时长时：
```javascript
audioFileWidget.callback = function (...args) {
  const result = origCallback?.apply(this, args);
  try { app.graph?.queueNode?.(self); } catch (_) {}
  return result;
};
```
这是 GJJ 标准的从控件变化触发重执行的方式，无需用户手动排队。

## 快速检查清单

- 动态输入在最后一个可见插槽获得链接时扩展
- 链接移除时额外空插槽折叠
- 可选输出在条件不满足时真正消失
- 旧图节点在重载后通过 `onConfigure` 和 `setup()` 恢复
- 添加/删除后标签保持顺序
- 节点大小在稳定后刷新
- DOM 工具栏自然换行且与节点高度无底部悬空间隙
- 自定义预览节点仅发出一种预览路径
- Python RETURN_TYPES 为 JS 管理的动态输出预分配足够槽位
- 混合类型输出列表在 renameOutputsSequentially 中使用按类型组独立计数器
- 音频文件加载回退到 ffmpeg 处理 soundfile 无法解码的格式
- 文件选择控件变化时触发 queueNode 自动刷新

## Node 1.0 与 2.0 DOM 预览说明

ComfyUI Node 1.0 和 Node 2.0 对 DOM 预览控件的表现不同。

工作规则：
- 首先将 Node 2.0 视为稳定的 DOM 路径。
- 不要随意在 Node 2.0 上复用 Node 1.0 的高度修复。
- 如果修复仅用于 Node 1.0，将其隔离在显式分支或模式开关后，而非更改共享 DOM 高度链。

GJJ 图片预览节点的实践经验：
- `onResize + DOM 高度同步` 可帮助 Node 1.0，但相同逻辑可能在 Node 2.0 引起递归增长。
- 同时写入容器高度和内部预览高度在 Node 2.0 尤其危险；优先最小数量的高度写入。
- DOM 控件的 `computeSize()` 通常应仅暴露固定最小高度，不依赖当前节点高度，否则 Node 1.0 可能卡在可放大但无法缩回的状态。
- `getHeight()` 比 `computeSize()` 更安全地反映当前可用高度，但需在 Node 1.0 和 Node 2.0 中独立验证。
- 引入 Node 1.0 回退渲染路径之前，首先保留已知良好的 Node 2.0 基线，使 1.0 更改隔离且可逆。
- 如果前端未暴露可靠的官方 "Node 1.0 vs 2.0" 运行时标识，当稳定性至关重要时，优先使用显式节点模式切换而非启发式自动检测。

未来修复的安全工作流：
1. 冻结最后已知良好的 Node 2.0 版本。
2. 单独测试 Node 1.0 修复。
3. 避免在同一次迭代中混合 DOM 高度同步、节点 `setSize()` 和画布回退。
4. 如果行为退化，首先回滚到 Node 2.0 良好基线，然后用更小的隔离补丁重试。

## Node 2.0 参数模式切换说明

对于在两个参数组之间切换的节点（如"目标尺寸扩图"vs"四边像素扩图"），Node 2.0 对硬控件隐藏的容忍度远低于 Node 1.0。

`GJJ_Qwen2511EditOutpaint` 的工作规则：
- 优先使用 **显示 + 禁用** 而非硬隐藏/显示两个参数组。
- 在控件列表中保持两个组可见，但禁用非活动组，避免 Node 2.0 留出大面积空白或陈旧的侧连接器。
- 如果某个字段必须保持真正隐藏（如仅作为内部状态载体），仅隐藏该单一字段并将其移出可见工具栏/按钮区域，防止误触。
- 将自定义模式按钮放在受控参数组之前，而非之后。
- 禁用控件时，尽量淡化整行而不仅是输入框，使非活动组在 Node 1.0 和 Node 2.0 中均清晰可读。

实践模式：
1. 保持真正的隐藏模式控件作为真相源。
2. 添加自定义按钮来设置隐藏模式控件值。
3. 对每个受控控件：
   - 保持可见
   - 切换 `disabled`
   - 如果禁用则淡化行/容器
4. 仅真正隐藏那一个隐藏模式控件，并将其移到可见区域/顺序之外。

为什么这样更安全：
- Node 1.0 通常可以承受隐藏/显示把戏。
- Node 2.0 在控件被激进隐藏或转换时经常留下空白布局行、陈旧插槽或点击穿透问题。
- "可见但禁用"产生的布局错误更少，更容易在两种渲染器间保持稳定。

## 官方 ImageCompare / Node 2.0 专用说明

官方 `nodes_image_compare` 的行为：
- 它**不**检查字符串版本（如 `"1.0"` / `"2.0"`）。
- 实现为一个 `comfy_api.latest` 节点（`IO.ComfyNode`），暴露专用输入类型：
  - `IO.ImageCompare.Input("compare_view")`
- 在 `comfy_api.latest._io` 中，此输入注册为：
  - `@comfytype(io_type="IMAGECOMPARE")`

有用的具体检测点：
- 服务端 `/object_info` 对这些节点不同处理：
  - `issubclass(obj_class, _ComfyNodeInternal)`
- 因此可靠的服务端"新 API 节点"分支是：
  - `issubclass(node_class, _ComfyNodeInternal)`
- 但这仍意味着"Comfy API / V3 风格节点"，而非直接"当前前端是 Node 2.0 模式"。

实践含义：
- 官方 ImageCompare 最终"仅 Node 2.0"，因为 Node 2.0 前端知道如何渲染 `IMAGECOMPARE` 输入类型。
- Node 1.0 回退，因为它不支持该输入/控件类型。
- 因此，对于前端兼容性工作，不要使用 `FUNCTION`、`RETURN_TYPES` 或 `execute` 作为 Node 1.0/2.0 渲染模式的代理。
- 如需模仿官方行为，更准确的规则是：
  - "使用 Node 2.0 专用的自定义输入/控件类型"而非"检查节点版本字符串"。