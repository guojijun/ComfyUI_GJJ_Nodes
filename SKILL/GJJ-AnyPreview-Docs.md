# GJJ · 👀 任意对象预览器 — 功能文档

## 概述

**节点名：** `GJJ · 👀 任意对象预览器`（`GJJ_AnyPreview`）

**定位：** ComfyUI 万能预览输出节点。动态接收任意类型的输入，自动识别内容类型（图片/文本/音频/视频/其他对象），并渲染对应的预览界面。是 GJJ 节点生态中的"瑞士军刀"——工作流最终输出的默认选择。

**版本：** 2.0.0（2026-05-04）

---

## 架构设计

```
输入层（动态）：
  ├─ batch_image (GJJ_BATCH_IMAGE) — 固定首槽，GJJ 专用批量图片
  ├─ any_01 (*) — 动态插槽，按需扩展
  ├─ any_02 (*)
  └─ any_NN (*) — 最多 99 个

处理层：
  1. 收集所有非空输入值
  2. 类型识别（图片批次 → 文本列表 → 音频对象 → 视频对象 → 其他）
  3. 合并同类数据（图片拼接批次、文本用换行符连接）
  4. 生成预览 UI 数据

输出层：
  └─ 统一预览结果 (*/IMAGE/STRING) — 合并后的对象，类型自动适配
```

---

## 支持的预览类型

### 1. 图片预览

| 属性 | 说明 |
|------|------|
| 触发条件 | 所有已连接输入均为 `torch.Tensor` 形状 `[B,H,W,C]` |
| 合并策略 | 统一尺寸为最大宽高（lanczos 缩放），沿 batch 维度拼接 |
| 显示方式 | 自适应网格（`auto-fill, minmax(120px, 1fr)`） |
| 单图模式 | 占满预览区高度（360px），大图模式 |
| 多图模式 | 缩略图网格，卡片高度 145px，图片高度 108px |
| 交互 | 点击放大到全屏浮层（ESC 关闭），悬停显示序号 |
| 后端管线 | 使用 ComfyUI 原生 `PreviewImage` 保存临时 PNG，返回 `ui.images` |

### 2. 文本预览

| 属性 | 说明 |
|------|------|
| 触发条件 | 所有已连接输入均为 `str` 类型 |
| 合并策略 | 用 `\n` 连接所有文本 |
| 渲染引擎 | 自研 Markdown 渲染器（纯 JS，不依赖第三方库） |
| 交互 | 双击复制全文到剪贴板（绿色闪烁反馈） |

**支持的 Markdown 语法：**

| 元素 | 语法 |
|------|------|
| 标题 | `# H1` ~ `###### H6` |
| 粗体 | `**text**` / `__text__` |
| 斜体 | `*text*` / `_text_` |
| 删除线 | `~~text~~` |
| 行内代码 | `` `code` `` |
| 代码块 | ` ``` ` 围栏（无语法高亮） |
| 无序列表 | `- item` / `* item` / `+ item` |
| 有序列表 | `1. item` / `1) item` |
| 引用块 | `> quote` |
| 链接 | `[text](url)` |
| 图片 | `![alt](url)` |
| 自动链接 | 裸 URL 自动转为可点击链接 |
| 分隔线 | `---` / `***` / `___` |

### 3. 音频预览

| 属性 | 说明 |
|------|------|
| 触发条件 | 单个输入为 dict，含 `waveform` + `sample_rate` 键 |
| 后端处理 | `soundfile` 将 torch.Tensor 波形写入临时 WAV 文件 |
| 前端显示 | HTML5 `<audio>` 原生播放器（controls 全开） |
| 附加信息 | 文件名标签 + 文本简介区（时长、采样率、形状） |
| 格式支持 | WAV（后端生成），浏览器原生支持 MP3 等 |

### 4. 视频预览

| 属性 | 说明 |
|------|------|
| 触发条件 | 单个输入为对象，含 `get_components()` 方法（ComfyUI VIDEO 对象） |
| 后端处理 | 调用 `combine_video` 编码为 H.264 MP4 临时文件 |
| 前端显示 | HTML5 `<video>` 原生播放器（controls 全开，最大高度 320px） |
| 附加信息 | 文件名标签 + 文本简介区（时长、帧数、帧率、形状） |

### 5. 对象预览（兜底）

| 属性 | 说明 |
|------|------|
| 触发条件 | 不匹配以上任何类型 |
| 处理方式 | `json.dumps(indent=2)` 序列化为可读文本 |
| 特殊处理 | `torch.Tensor` 显示 `Tensor(shape=..., dtype=...)` |

---

## 动态插槽系统

### 插槽结构

```
节点输入口：
┌─────────────────────┐
│ GJJ 批量图片         │  ← 固定首槽，类型 GJJ_BATCH_IMAGE
├─────────────────────┤
│ 输入 01             │  ← 动态插槽，类型 *
│ 输入 02             │  ← 自动编号
│ ...                 │
│ 输入 NN（空尾槽）    │  ← 始终保留一个空槽用于拖线
└─────────────────────┘
```

### 自动行为

| 事件 | 行为 |
|------|------|
| 最后一个动态插槽被连线 | 自动新增一个空插槽（最多 99 个） |
| 尾部空插槽未连线 | 自动折叠删除（至少保留 1 个可见） |
| 插槽重排 | 每次稳定化后按 `any_01, any_02, ...` 顺序重命名 |
| 类型匹配 | 所有动态插槽类型始终为 `*`（万能接收） |

### 输出类型自动解析

根据已连接的输入类型自动推导输出口类型和名称：

| 连接情况 | 输出类型 | 输出名 |
|---------|---------|--------|
| 全部 IMAGE | `IMAGE` | 图片输出 |
| 全部 STRING | `STRING` | 文本输出 |
| 单一其他类型 | 该类型 | 对象输出 |
| 无连接但 kind=image | `IMAGE` | 图片输出 |
| 无连接但 kind=text | `STRING` | 文本输出 |
| 混合类型 | `*` | 预览结果 |

---

## LoRA 效果测试器集成

节点内置了与 `GJJ · 🧪 LoRA效果测试` 节点的联动：

- 自动检测上游是否连接了 `GJJ_LoraEffectTester`
- 从上游节点的 `__gjjLoraEffectLiveTexts` 读取实时测试状态文本
- 检测到后自动切换到"文本预览"模式，显示测试进度
- 连接断开后自动恢复普通预览模式

---

## 布局与尺寸

### 高度策略

| 内容类型 | 高度计算 |
|---------|---------|
| 图片（单图） | 360px（固定） |
| 图片（多图） | `行数 × 145px + 间距 + 18px`，自适应列数 |
| 音频 | 播放器 + 文本区，最小 96px |
| 视频 | 播放器（~320px）+ 文本区 |
| 文本 | `scrollHeight` 自适应，最小 96px |
| 空状态 | 最小 180px |

### 宽度策略

- **保留用户手动调整的宽度** — 只更新高度，不调用 `node.setSize(n.computeSize())`
- 网格列数根据当前可用宽度动态计算（`Math.floor(contentWidth / 120)`）
- 最小宽度 300px

---

## 数据流

```
Python execute()
  ├─ 收集输入 → 类型识别 → 合并数据
  ├─ 图片: PreviewImage.save_images() → ui["preview_images"] = [list]
  ├─ 音频: soundfile.write() → ui["preview_audio"] = ([list],)
  ├─ 视频: combine_video() → ui["preview_video"] = ([list],)
  └─ 文本/其他: ui["preview_text"] = ("text",)
       ↓
  return {"ui": ui, "result": (merged,)}

JS onExecuted(message)
  ├─ 解包: message.preview_kind[0], message.preview_text[0]
  ├─ 图片: message.preview_images (直接数组)
  ├─ 音频: message.preview_audio[0] (元组取[0])
  ├─ 视频: message.preview_video[0] (元组取[0])
  └─ 写入 node.__gjjAnyPreviewXXX 缓存
       ↓
  applyPreviewContent(node)
  ├─ 图片 → 构建缩略图网格 → body隐藏
  ├─ 音频 → 构建<audio>播放器 → body显示文本简介
  ├─ 视频 → 构建<video>播放器 → body显示文本简介
  └─ 文本 → renderMarkdown() → body显示
       ↓
  updateLayout(node) → setSize + setDirtyCanvas
```

---

## 交互功能一览

| 操作 | 功能 |
|------|------|
| 点击图片缩略图 | 全屏浮层查看（黑色遮罩） |
| 按 ESC | 关闭全屏图片 |
| 点击遮罩背景 | 关闭全屏图片 |
| 双击文本区域 | 复制全部文本到剪贴板（绿色闪烁反馈） |
| 音频播放器 | HTML5 原生控件：播放/暂停、进度拖拽、音量 |
| 视频播放器 | HTML5 原生控件：播放/暂停、进度拖拽、全屏 |
| 拖拽连线到空插槽 | 自动新增下一个空插槽 |

---

## Python 后端接口

### INPUT_TYPES

```python
{
    "required": {},
    "optional": FlexibleOptionalInputType(any_type, {
        "batch_image": (GJJ_BATCH_IMAGE_TYPE, {...}),
        # any_01..any_NN 由 FlexibleOptionalInputType 动态接受
    }),
    "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
}
```

### RETURN_TYPES / RETURN_NAMES

```python
RETURN_TYPES = (any_type,)         # AnyType("*") — 万能通配
RETURN_NAMES = ("统一预览结果",)
```

### 关键辅助函数

| 函数 | 用途 |
|------|------|
| `is_image_tensor(value)` | 检测 [B,H,W,C] / [H,W,C] 张量 |
| `is_audio_object(value)` | 检测 `{waveform, sample_rate}` 字典 |
| `is_video_object(value)` | 检测含 `get_components()` 的对象 |
| `merge_images(values)` | 统一尺寸 + 沿 batch 拼接 |
| `serialize_preview(value)` | 对象转可读文本 |
| `normalize_image_tensor(value)` | 3D 张量升维到 4D |

---

## 技术要点

1. **UI 数据格式遵循 ComfyUI 规范：**
   - 字符串/数值：`(value,)` 元组包裹
   - 图片列表：直接数组 `[list]`
   - 音频/视频列表：元组包裹 `([list],)`

2. **`AnyType("*")` 自定义类型：** `__ne__` 始终返回 `False`，使该类型与 ComfyUI 所有类型兼容，实现"万能插槽"。

3. **`FlexibleOptionalInputType`：** 自定义 dict 子类，`__contains__` 始终返回 `True`，允许 JS 动态创建任意 `any_NN` 输入口而 Python 端不报错。

4. **图片合并策略：** 所有图片统一缩放到最大宽高（lanczos），沿 batch 维度 `torch.cat`。保证不同来源/尺寸的图片能在一张网格中预览。

5. **音频处理链：** `torch.Tensor` → `.squeeze(0).cpu().numpy()` → `.T`（多声道转置） → `soundfile.write(wav)` → 前端 `/api/view` 加载。

6. **视频处理链：** `get_components()` → `combine_video()` → H.264 MP4 → 前端 `/api/view` 加载。

7. **Markdown 渲染：** 纯 JS 实现，零依赖。支持嵌套行内格式 + 块级元素。`renderInlineMarkdown()` 处理行内，`renderMarkdown()` 处理块级，`clampTextPreviewLines()` 防溢出。

8. **布局防抖：** `scheduleLayout` 使用 `requestAnimationFrame` + `__gjjAnyPreviewLayoutQueued` 标记防止重复触发。

---

## 使用示例

### 基础图片预览
```
[Load Image] → any_01 → [GJJ AnyPreview]
```

### 批量图片检查
```
[GJJ Batch Image Loader] → batch_image → [GJJ AnyPreview]
```

### 调试中间张量
```
[Any Node] → [GJJ AnyPreview]    # 自动显示 Tensor(shape=...)
```

### 音频生成预览
```
[TTS Node] → any_01 → [GJJ AnyPreview]  # 显示播放器 + 时长信息
```

### 视频合成预览
```
[Video Combine] → any_01 → [GJJ AnyPreview]  # 显示播放器 + 帧信息
```

### LoRA 测试监控
```
[GJJ LoRa Effect Tester] → any_01 → [GJJ AnyPreview]  # 实时显示测试进度
```

---

## 已知限制

- 音频/视频首次执行需要生成临时文件（位于 ComfyUI `temp` 目录），可能延迟 1-3 秒
- Markdown 代码块无语法高亮（仅等宽字体 + 暗色背景）
- 视频预览依赖浏览器 H.264 解码支持（现代浏览器均支持）
- 大尺寸图片单图模式可能超出屏幕（建议用缩略图网格模式）
- 混合类型输入（部分图片 + 部分文本）会走兜底序列化路径，而非分别预览
