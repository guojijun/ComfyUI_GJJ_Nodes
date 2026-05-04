---
name: comfyui-gjj-node-migration
description: 将 ComfyUI 自定义节点迁移、重写或精炼到 GJJ 包中。用于将节点从其他包移植到 GJJ、适配到经典 ComfyUI 节点风格、添加中文显示名和工具提示、遵循 GJJ 命名和暗色主题约定、添加前端 JS 行为、标准化面板宽/高行为，或移除非可移植依赖使节点包可复制到其他环境。
---

# ComfyUI GJJ 节点迁移

## 目标

在 `<GJJ>` 下创建、迁移或编辑节点时，一致地应用 GJJ 包约定。

优先直接实现，而非仅讨论答案。

## 参考来源优先级

当 ComfyUI 行为、节点契约或前端期望不明确时，将官方 ComfyUI 文档作为最高优先级参考：
- `https://docs.comfy.org/`

如果本地代码、第三方自定义节点、旧示例或记忆与官方文档冲突，优先使用官方文档，然后与本地运行时调和。

## 核心规则

1. **使用经典 ComfyUI 节点定义。** 使用 `INPUT_TYPES`、`RETURN_TYPES`、`FUNCTION`、`CATEGORY`、`NODE_CLASS_MAPPINGS`、`NODE_DISPLAY_NAME_MAPPINGS` 定义节点。

2. **分离前台/后台注册。** 前台用户节点使用 `GJJ_` 注册前缀，出现在正常 `GJJ` 搜索结果中。后台/参考/帮助节点使用 `guojijun_` 注册前缀，主要通过插槽默认值、工作流包装器或前端逻辑添加，而非手动搜索。除非用户明确要求保留旧工作流，不要为后台/参考/帮助节点保留旧的 `GJJ_` 兼容别名。前台 `NODE_DISPLAY_NAME_MAPPINGS` 可搜索，包含多个相关关键词帮助用户搜索。后台/参考/帮助节点排除在正常搜索外：`CATEGORY` 放在 `guojijun/内部引用` 下，`DEPRECATED = True`，`SEARCH_ALIASES = []`，显示名以 `guojijun ·` 开头。新 GJJ 节点模块文件使用 `gjj_` 前缀 + snake_case，如 `gjj_image_collage.py`。前端 JS 文件名与 Python 文件名**完全一致**，同样使用 `gjj_` + snake_case，如 `gjj_image_collage.js`。这样前后端同名，维护时无需做任何转换，一眼就能找到对应文件。

3. **遵循 GJJ 显示约定。** 包已将前台显示名规范化为 `GJJ · <中文名称>`。用中文编写面向用户的前台节点名称。每个前台 `NODE_DISPLAY_NAME_MAPPINGS` 值必须在 `GJJ ·` 后包含一个简洁的前导 emoji。使用清晰的简短中文名词或动宾形式，如 `GJJ · 📝 文本合并`、`GJJ · 🧩 图片拼版`、`GJJ · 🧾 模型元数据查看`。后台/参考/帮助显示名免于 `GJJ · emoji` 格式，使用 `guojijun · <中文名称>（内部引用）` 格式。

4. **全面使用中文标签。** 每个输入必须包含中文 `display_name` 和中文 `tooltip`。每个输出必须包含中文 `RETURN_NAMES` 和中文 `OUTPUT_TOOLTIPS`。

5. **保持依赖可移植。** 不依赖源包（如 `GuoJiJun`）。不引入额外 pip 依赖，除非它们已随 GJJ 附带并可一同移动。优先使用 Python 标准库、ComfyUI 内置功能和 GJJ 本地帮助模块。如果源节点依赖辅助函数，将这些辅助函数迁移到 GJJ 中或内联它们。默认目标是零外部自定义节点依赖：
   - 复制的 `GJJ` 文件夹应在无任何第三方自定义节点包的情况下正常工作
   - 优先使用 ComfyUI 核心模块、ComfyUI 捆绑的 comfy_extras 和 `GJJ` 自身的代码
   - 如果辅助代码很小，将其内联在节点内部而非导入其他包或工具模块
   - 如果在 GJJ 节点间可复用，将其移入 GJJ 本地模块

6. **前端行为保留在 GJJ 内。** 将 ComfyUI 前端扩展放在 `<GJJ>/js`。前端标签、按钮、提示和空状态提示保持中文。保留当前 GJJ 暗色视觉风格。将布尔/开关控件替换为文本按钮时，默认采用 `GJJ · 🧪 LoRA效果测试` 按钮布局：DOMWidget 面板、多动作每行两按钮、`button.on` 表示激活状态、绿色激活样式、紧凑 5-6px 圆角、粗体 12px 文字、标签如 `自动执行 开` / `自动执行 关`。彻底隐藏原始布尔控件。

7. **工作流包装节点必须清晰展示状态。** 对于包装工作流或打包多个内部步骤的 GJJ 节点：
   - 可行时在节点面板上显示执行进度
   - 可行时完成后在面板上显示执行耗时
   - 对缺失文件、无效参数或内部阶段失败抛出中文错误消息
   - 不要将原始英文内部异常直接暴露给用户

8. **所有面向用户的字段使用中文。** 对于 GJJ 节点：
   - 不在面板上直接暴露 `user_prompt`、`system_prompt` 等原始内部参数名
   - 每个可见输入和输出使用中文 `display_name`
   - 每个可见 `tooltip` 使用中文
   - 前端 JS 创建的按钮、状态卡片、通知或回退标签文字也必须为中文
   - 不在任何面向用户的 tooltip、状态文本、控件值、节点标签或错误上下文中暴露机器专用绝对路径。展示给用户的模型和资源路径必须规范化为仓库或 ComfyUI 相对路径，尤其是配置的 models 目录下的文件使用 `models/...`。绝对路径仅用于内部加载、缓存键和文件系统操作。

9. **标准化面板宽/高优先级。** 对于每个暴露面板宽/高且可推断或接收尺寸的 GJJ 节点：
   - 如果外部宽/高输入已连接，使用外部连接值进行所有计算，并清除面板宽/高显示
   - 如果无外部宽/高输入连接，使用当前面板显示的宽/高作为计算源
   - 检测到新图片源且无外部宽/高连接时，更新面板宽/高为新图片尺寸；之后允许用户手动编辑面板值，并遵循用户编辑值
   - 仅将图片尺寸、默认值、潜在大小或提示元数据作为初始化或刷新源；执行期间不静默覆盖已显示的面板宽/高
   - 将面板宽/高持久化到工作流中，最好同时在控件序列化和 node `properties` 中；存储图片/源签名使重载工作流时保留手动编辑的面板尺寸
   - 实现前端/后端交接，使后端收到的有效宽/高与面板一致，除直接外部输入已连接外
   - 对于自定义 DOM/canvas 编辑器，将节点框架宽度、DOM 面板宽度和 canvas/图片视口宽度置于单一真相源下：一个持久化的 node-width 属性。不调用 `node.setSize(node.computeSize())` 缩小用户已调整的宽度。不使用超出节点框架的 DOM `min-width` 值导致编辑器溢出。从当前工作宽/高宽高比计算 canvas 显示高度。

10. **含有动态输出口的节点必须保证序列化往返正确。**
    - `widgets_values` 按 widget 在数组中的**位置**序列化，而非按名称。如果 `reorderWidgets` 改变了数组顺序，保存时的索引与加载时的索引不匹配，数据会错位到错误的控件上。
    - **核心状态数据不依赖 `widgets_values` 序列化**，改存 `serializedNode.properties`（key-value 按名称存取，不受位置影响）：
      ```javascript
      // onSerialize —— 保存
      serializedNode.properties = serializedNode.properties || {};
      serializedNode.properties["my_state"] = widget?.value || "";

      // onConfigure —— 恢复
      const saved = this.properties?.my_state;
      if (saved) { widget.value = saved;
      widget.callback?.(saved); }
      ```
    - **绝不删除承载核心数据的 Widget 输入槽**。`removeHiddenInputSockets` 删除被隐藏 Widget 的输入口后，ComfyUI 序列化时会在 `widgets_values` 中插入空占位，打乱所有后续索引。
    - **Python 端 `RETURN_TYPES` 声明的输出数量必须与实际 `return` 元组长度一致**，不一致时补齐空张量。
    - **`onSerialize` 中修剪动态输出口**，防止所有声明输出口全量写入工作流 JSON：
      ```javascript
      nodeType.prototype.onSerialize = function (serializedNode) {
          syncOutputs(this, currentRows, currentCols); // 先修剪到正确数量
          return originalOnSerialize?.apply(this, [serializedNode]);
      };
      ```

11. **遵循 Lazy Image Studio 提示输入标准。** 对于暴露正/负面提示字段的 GJJ 生成节点：
    - 使用命名为 `prompt` / `positive_prompt` 和 `negative_prompt` 的普通 `STRING` 控件
    - 默认 `multiline: False`，除非用户明确要求大型编辑器
    - 不在主要提示控件上设置 `forceInput: True`，因为这会移除可编辑面板字段
    - 不添加重复的可选输入（如 `positive_prompt_input`）仅为了支持文本链接
    - 依赖 ComfyUI 原生控件输入/小点机制，使同一条提示行保持面板可编辑同时可接受外部 `STRING`
    - 如果前端代码意外将提示控件转换为 `converted-widget:*`，恢复它而非创建第二个提示插槽
    - 匹配 `GJJ_LazyImageStudio` 行为：面板显示单行正面和负面提示框，同时原生外部 `STRING` 链接仍然可用

## 工作流程

1. 检查源节点，识别每个依赖项：imports、辅助模块、JSON 文件、JS 文件及其依赖的运行时资源。

2. 确定最小的可移植迁移形态。如果依赖项很小且仅限节点专用，内联它。如果多个 GJJ 节点可复用，移入 GJJ 本地辅助模块。

3. 将节点重写为 GJJ 格式。将框架专用代码（如 `comfy_api.latest` 节点）按需转换为经典 ComfyUI 节点类。保持类别命名与现有 GJJ 模式对齐（如 `GJJ` 或 `GJJ/LLM`）。

4. 添加或保留正确的 UI 行为。如果节点需要动态 UI，在 `<GJJ>/js` 下添加匹配的 JS 文件。UI 文字保持中文，行为对缺失输入和空值有弹性。自定义面板的内部序列化状态存储在 node `properties` 或真正不可连接的数据控件中。不在节点表面留下隐藏 STRING 控件或未标记的控件-输入插槽。

5. 本地验证。优先使用轻量本地检查：`python -m py_compile <file>`、直接导入单个节点文件、运行小功能烟雾测试、前端脚本用 `node --check <file.js>`。

6. 简要报告。告诉用户哪些文件被更改、哪些行为现已生效、以及验证的环境特定限制。

## 实现说明

- 语义匹配时复用以下 GJJ 自定义数据类型：
  - `LORA_CHAIN_CONFIG`：用于由配置/构建节点产生、被工作流包装生成节点消费的序列化多 LoRA 链数据。发送方和接收方必须使用完全相同的类型字符串。此类型表示"LoRA 链定义"，而非已加载的模型对象。
  - `GJJ_BATCH_IMAGE`：用于 GJJ 专用图片/帧批量队列，当载荷仍仅是普通图片张量批次且不携带额外元数据（如 fps、音频或旁车配置）时。典型用例：多图片加载器批量输出、多参考批量输入、批量出图结果队列、解码视频帧序列。如果连接语义上需要额外打包元数据，定义新自定义类型。
- 引入或复用时，在 GJJ JS 中注册稳定的前端插槽颜色。推荐挂钩：`app.canvas.default_connection_color_byType` 和 `LGraphCanvas.link_type_colors`。

- 优先使用简洁中文节点名，如 `文本合并`、`翻译`、`提示词生成`。
- 使用解释行为而非仅复述参数名的中文 tooltip。
- 防御性处理空输入。缺失可选输入和空白文本不应引发可避免的错误。
- 对于序列、索引、范围、项目数、批量选择等编号 UI 语义，默认使用 1-based 用户面编号。范围默认从 1 开始，标签如"图片 1 / 动作图 1"，循环返回应回到 1 而非 0，除非 ComfyUI 核心张量索引明确要求内部 0-based 处理。
- 当 GJJ 序列节点按 `start + count - 1` 输出范围时，其自动后生成步进必须前进 `count` 而非 1。否则下游批量消费者将收到重叠范围而非对齐块。如果 ComfyUI 原生 `control_after_generate` 仅递增 1，在成功执行后添加前端 `count - 1` 补偿。
- 对于重复的用户面插槽（场景1..N、图片1..N 等），不默认暴露长固定输入列表。使用动态可扩展输入：
  - Python `INPUT_TYPES` 仅暴露最小初始可见插槽。
  - 后端可选输入处理通过灵活输入映射接受任意生成的名称。
  - 前端 JS 使用 AnySwitch 风格 stabilize 模式。
  - 如果动态重复输入紧邻固定可选输入，每次稳定后明确重排 `node.inputs`。
  - 如果预设节点子类化动态基节点，动态 JS 目标列表必须包含每个子类注册名。
- 对于相同类型的重复输出，同样默认使用动态可扩展输出。保持稳定聚合输出在前，显示一个尾部项目输出，最后一个可见被链接时添加下一个，用真正的 `removeOutput()` 剪除未使用尾部输出，每次稳定通过重新应用中文标签/工具提示。
- 自定义 GJJ 批处理插槽类型不附加回退原始类型。使用 `GJJ_BATCH_IMAGE` 精确，不用 `GJJ_BATCH_IMAGE,IMAGE`。
- 对于具有 LoRA 默认值的工作流包装节点：
  - 原始工作流有标准/默认 LoRA 则解析并显示具体已解析 LoRA。
  - 无默认 LoRA 则不显示该下拉框或强度控件。
  - 始终提供 `LORA_CHAIN_CONFIG` 输入 `LoRA串联配置`。
- 对于输出 `LORA_CHAIN_CONFIG` 和状态文本的 LoRA 效果/批量测试节点：
  - 实际 LoRA 加载配置仅保留子目录相对文件名和数字强度。✅/❌ 等状态标记仅属于文本输出。
  - 手动"刷新列表"重新读取 LoRA 列表，重置索引为 1，清除通过/失败状态。
  - 不通过全局 `execution_error` 判定，跟踪连接到 `LORA_CHAIN_CONFIG` 输出的目标消费节点。
  - 目标消费者已成功则后续不相关错误不得降级。
  - 筛选、刷新、状态标记或强度变化时推送当前前端列表到链接预览器。
- 节点依赖本地模型或运行时数据时，优先从本地 ComfyUI 环境发现而非硬编码。
- 模型查找应动态且子目录感知。默认规则：使用 `folder_paths.get_filename_list(category)`、处理子目录相对条目、精确匹配 → 基名匹配 → 最长公共连续片段匹配。
- SAM3 等本地模型 GJJ 节点默认假设所需模型可能存在于 `models/...` 类别目录下。按完整类别列表搜索，去除扩展名后选择最长可信连续文件名片段匹配。无匹配时不自动下载、不替代无关模型，在面板显示中文警告。
- 源代码工作流模型文件名作为查找种子保留，不手动缩短。用户可能在子目录下通过追加中文注释、强度提示重命名。标准模糊匹配：搜索 ComfyUI `folder_paths` 类别列表 → 仅去除扩展名比较 → 最长公共连续文件名片段优先。
- 保持代码易于打包。复制的 `GJJ` 文件夹应在无源包情况下保持功能。
- 将"零依赖"作为 GJJ 迁移默认目标。
- 对 GJJ 节点内部提示词、标签、语义目标的翻译，优先使用本地 TSV 辅助 `utils/tsv_translation.py`。翻译失败不阻塞可警告继续的节点。
- 优先使用中文运行时错误（如"未找到模型文件…"、"加载 CLIP 失败…"）。
- 如果打包节点仅需微小外部辅助，直接内联。例：包装器节点仅需 `conditioning_set_values`，添加节点本地私有辅助而非依赖 `node_helpers`。
- 多视角或多参考编辑包装器不重用其他节点的通用辅助限制。
- 对于小且自包含的外部自定义节点运行时包，优先将其拷入 `GJJ/vendor`。例：`sam2` 风格包装器复制本地 `sam2` 包和 `sam2_configs` 到 `GJJ/vendor`。
- 如果源插件主要提供预处理工具而非真正模型运行时，优先仅提取核心逻辑到独立 GJJ 节点。
- 对于较大分割运行时（如 `sam3`），将最小运行时包拷入 `GJJ/vendor` 并在其上重建 GJJ 节点。推荐模式：复制模型运行时包 → 补丁可选导入 → 子目录感知模型搜索 → 优先 GJJ 本地经典节点。
- 当拷入的模型代码通常期望 `.pt` 检查点但本地为 `.safetensors` 时，优先使用 `comfy.utils.load_torch_file(...)` 手动加载 state dict。
- 避免在可复用节点文件中顶层 `from server import PromptServer`。在进度辅助函数内部延迟导入。
- 对于大型 GJJ DOMWidget 面板（风格选择器、预设工作室、长参数表单），优先内容驱动节点高度而非内部滚动区域。默认让节点随内容增长。如果弹出列表需要，优先视口级浮动面板。
- 风格卡片缩略图和预览图避免拉伸填满卡片宽度。优先固定高度框架 + 居中内容 + `object-fit: contain`。
- 多图片预览网格遵循 `GJJ · 🗂️ 批量多图片加载预览器` 缩略图约定：grid + 紧凑暗色卡片 + `height:108px` + `object-fit:contain`。节点/控件高度从图片数量、列数、卡片高度和间隙计算。
- 动态隐藏的 ComfyUI 控件使其真正不占空间：保存原始 type/computeSize/getHeight 后设为隐藏类型、`hidden = true`、隐藏 DOM/输入元素、`draw = () => {}`、`computeSize = () => [0, 0]`、`getHeight = () => 0`、移动 y/last_y 离屏。恢复时还原所有原始值并强制重算尺寸。
- 紧凑 GJJ DOMWidget 控制面板（如 CSV/TSV 行迭代器）不依赖 LiteGraph 默认高度。证明模式：在序列化后备控件中保持内部 JSON 状态，LoRA 风格隐藏（`converted-widget:<name>`、`hidden = true`、无绘制、离屏 y/last_y、零高度），然后可见 DOMWidget 通过 `scrollHeight/offsetHeight` 报告自身高度，`nodeCreated`/`onConfigure` 后调度 `requestAnimationFrame` 尺寸通行。
- 小型覆盖控件（如 GJJ 帮助按钮）优先零高度 DOMWidget 而非节点级 `onMouseDown`。先添加 DOMWidget，设 `getHeight: () => 0` 和 `computeSize: () => [0, -4]`，从控件实际 `last_y` 定位内部按钮。
- 不将大型序列化状态以单长行放入可见 `required`/`optional` 控件默认值中。用户相关则格式化展示（`json.dumps(indent=2)` 或 `multiline: True`）。纯内部状态则保持控件默认值短/空，全文存储在 `node.properties`。
- 不在序列化 JSON 默认值中嵌入含 `\n` 的 tooltip 字符串（JSON 会转义为 `\\n`）。保持 JSON 状态结构化，在 JS 中构建带真实 `\n` 的 DOM `title` 文本。
- ComfyUI 帮助面板可能将 tooltip 中的 `\n` 折叠为空格。长可读 tooltip 用 `<br>` 连接显示行。保留原始 `\n` 给原生浏览器 `title` 悬停文本。
- GJJ 自定义帮助渲染器在分配 `textContent` 前规范化：`<br>` 和 `\\n` → 真实换行、JSON 值美化、`white-space: pre-wrap` 应用于帮助值/工具提示块。
- 内部前端状态字段使用简短中文 `display_name`/`tooltip`，JS 中标记为界面隐藏，可见用户控件承载有用解释。
- 长文本/Markdown DOMWidget 节点（如 `GJJ_TextInput`）不用 `max-height` 或内部 `overflow:auto` 滚动条限制主要内容预览体。让节点随内容增长。保护用户调整的宽度：不在无当前宽度时调用 `node.setSize(node.computeSize())`、在 `node.properties` 中存储手动宽度、内容变化后仅自动更新高度。编辑/预览切换时，优先 GJJ 自有的 `<textarea>` 而非恢复 ComfyUI 原生 `STRING` 控件。从保存属性或文本控件值填充 textarea，在 `input/change/blur` 时回写。

## 音频/预览节点模式

对于组合以下功能的音频编辑器或波形预览节点：

- 音频加载（内置下拉 + 可选外部 AUDIO 插槽）
- JSON 驱动分段/时间戳数据
- 动态 N 输出音频切片扩展
- 前端 Canvas 波形可视化

应用 `GJJ_AudioTimestampEditor` 的证明模式：

**Python 后端：**
- `OUTPUT_NODE = True`，`RETURN_TYPES = ("STRING",) + ("AUDIO",) * 99` —— 为 JS 管理的动态输出预分配所有槽位。
- `is_audio_object()` 辅助函数检查 dict `{waveform, sample_rate}` 形状。
- 音频加载：先尝试 `sf.read(filepath)`，对 m4a/ogg 回退到 `ffmpeg -i filepath -acodec pcm_s16le -ar 44100 -ac 2 tmp.wav` + `sf.read(tmp.wav)`。
- 输出元组：`[json_str] + [audio_dict, ...]` —— 聚合在前，切片在后。
- UI 数据返回 `preview_segments`（JSON 字符串）、`preview_duration`（float）、`preview_sample_rate`（int）、`preview_segment_count`（int）。
- 隐藏输入：`prompt`、`extra_pnginfo`、`unique_id` 用于 ComfyUI 路由。

**前端 JS：**
- 动态输出管理：`setupOutputs()` 对齐到 `segmentCount + 1`（1 个固定 + N 个音频）。
- `renameOutputsSequentially()` 当固定 STRING slot 0 后跟编号 AUDIO 插槽时，使用按类型组独立计数器而非原始循环索引。
- `removeUnusedOutputsFromEnd()` 绝不能删除固定 STRING 首槽输出（用输出名检查保护）。
- `addDynamicOutput` 后立即调用 `renameOutputsSequentially()`。
- 文件下拉框控件回调触发 `app.graph?.queueNode?.(self)` 自动刷新。
- Canvas 波形：`drawWaveform(canvas, samples, sampleRate, segments, selectedIdx)` —— 使用 `requestAnimationFrame`、尊重 devicePixelRatio、绘制背景 → 波形线 → 分段矩形 → 选中高亮 → 时间刻度。
- 通过 `e.offsetX * canvas.width / canvas.clientWidth` 比例点击选择分段。
- 双击在点击位置添加新分段。

## 回复风格

保持最终回复简短实用：

- 列出修改的文件
- 说明已实现的行为
- 提及已验证的内容
- 仅在必要时提及剩余限制