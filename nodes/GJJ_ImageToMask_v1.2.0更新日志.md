# GJJ_ImageToMask v1.2.0 更新日志

## v1.2.0 (2026-05-15) - 动态输出模式 & 智能格式切换

### ✨ 新增功能

#### 1. 动态输出模式选择
新增 **📤 输出方式** 参数，支持三种输出模式：

##### 🎭 仅遮罩模式
- **输出**: `(MASK,)` 
- **格式**: `[B, H, W]`
- **优势**: 节省内存，适合直接接入重绘节点
- **场景**: Inpaint、Paint等需要标准MASK格式的节点

##### 🖼️ 仅遮罩图模式
- **输出**: `(IMAGE,)`
- **格式**: `[B, H, W, 1]`
- **优势**: 可视化友好，方便预览和调试
- **场景**: PreviewImage、SaveImage等需要IMAGE格式的节点

##### ✨ 两者都输出模式（默认）
- **输出**: `(MASK, IMAGE)`
- **格式**: `[B, H, W]` + `[B, H, W, 1]`
- **优势**: 最灵活，同时满足两种需求
- **场景**: 需要同时连接重绘节点和预览节点

#### 2. 智能输出口切换
根据选择的输出模式，节点会自动调整输出口：
- 选择"仅遮罩" → 只显示1个输出口（MASK）
- 选择"仅遮罩图" → 只显示1个输出口（IMAGE）
- 选择"两者都输出" → 显示2个输出口（MASK + IMAGE）

#### 3. 右键菜单增强
新增右键菜单选项：
- 🔄 循环切换输出模式
- 🎭 仅遮罩
- 🖼️ 仅遮罩图
- ✨ 两者都输出

#### 4. 详细Tooltip提示
为输出方式参数添加多行详细说明：
```
选择输出格式：
• 🎭 仅遮罩：只输出 MASK 格式（节省内存）
• 🖼️ 仅遮罩图：只输出 IMAGE 格式（方便预览）
• ✨ 两者都输出：同时输出两种格式（最灵活）

💡 提示：Ctrl/Shift 点击可快速切换
```

---

### 🔧 技术实现

#### Python后端逻辑
```python
def convert(self, image, method, output_mode, ...):
    # 生成遮罩
    mask = generate_mask(image, method)
    
    # 根据输出模式返回不同格式
    output_mode_clean = output_mode.split(" ", 1)[-1]
    
    if output_mode_clean == "仅遮罩":
        return (mask,)  # 只返回 MASK
    elif output_mode_clean == "仅遮罩图":
        mask_image = mask.unsqueeze(-1)  # [B,H,W] -> [B,H,W,1]
        return (mask_image,)  # 只返回 IMAGE
    else:
        mask_image = mask.unsqueeze(-1)
        return (mask, mask_image)  # 返回两者
```

#### JavaScript前端增强
```javascript
// 监听output_mode变化，触发布局更新
originalWidget.callback = function(value) {
    if (originalCallback) originalCallback(value);
    // 触发画布刷新以更新输出口显示
    if (app.graph) {
        app.graph.setDirtyCanvas(true, true);
    }
};
```

---

### 📊 使用对比

| 场景 | v1.1.0 | v1.2.0 | 改进 |
|------|--------|--------|------|
| 接Inpaint节点 | ✅ 需手动转换 | ✅ 直接连接 | 更便捷 |
| 预览遮罩效果 | ❌ 需额外节点 | ✅ 直接预览 | 更高效 |
| 同时需要两者 | ⚠️ 需复制节点 | ✅ 一次输出 | 更简洁 |
| 内存占用 | 固定双输出 | 可选单输出 | 更节省 |
| 工作流复杂度 | 较高 | 较低 | 更清晰 |

---

### 🎯 使用示例

#### 示例1: 重绘工作流（仅遮罩）
```
LoadImage 
    → GJJ_ImageToMask(🎭 仅遮罩)
    → Inpaint节点
    → KSampler
    → VAE Decode
    → SaveImage
```
**优势**: 节省内存，无需额外的MaskToImage节点

#### 示例2: 预览调试（仅遮罩图）
```
LoadImage 
    → GJJ_ImageToMask(🖼️ 仅遮罩图)
    → PreviewImage
```
**优势**: 直接预览，无需转换节点

#### 示例3: 完整工作流（两者都输出）
```
LoadImage 
    → GJJ_ImageToMask(✨ 两者都输出)
        ├→ 🎭 遮罩 → Inpaint节点
        └→ 🖼️ 遮罩图 → PreviewImage
```
**优势**: 一个节点满足所有需求

---

### 📁 文件变更

#### 修改的文件
1. ✅ `nodes/gjj_image_to_mask.py` - 添加output_mode参数和动态输出逻辑
2. ✅ `js/gjj_image_to_mask.js` - 增强右键菜单和tooltip
3. ✅ `nodes/gjj_image_to_mask_README.md` - 更新输出说明

#### 新增的文件
1. ✨ `nodes/GJJ_ImageToMask_v1.2.0更新日志.md` - 本文档

---

### 🔄 兼容性

- ✅ **向后兼容**: v1.1.0的工作流可以无缝升级
- ⚠️ **注意**: 旧工作流默认会使用"✨ 两者都输出"模式
- ✅ **自动适配**: ComfyUI会自动处理返回值数量变化

---

### 💡 最佳实践

#### 1. 选择合适的输出模式
| 工作流类型 | 推荐模式 | 原因 |
|-----------|---------|------|
| 纯重绘流程 | 🎭 仅遮罩 | 节省内存，直接连接 |
| 调试预览 | 🖼️ 仅遮罩图 | 方便查看效果 |
| 复杂工作流 | ✨ 两者都输出 | 灵活性最高 |

#### 2. 快速切换技巧
- **方法1**: 下拉菜单选择
- **方法2**: 右键节点 → 选择模式
- **方法3**: 右键节点 → 循环切换

#### 3. 配合其他节点
```
GJJ_ImageToMask(🎭 仅遮罩)
    → GJJ_MaskGrowBlur (羽化)
    → GJJ_MaskOutline (描边)
    → Inpaint节点
```

---

### 🐛 已知问题

无

---

### 📋 待办事项

- [ ] 添加更多输出格式（如二值化遮罩）
- [ ] 支持自定义输出通道数
- [ ] 添加输出预览缩略图
- [ ] 支持批量输出模式配置

---

### 🙏 致谢

感谢用户反馈，使节点更加灵活和易用！

特别感谢：
- 提出动态输出需求
- 建议添加多种输出格式
- 要求优化内存使用

---

**更新日期**: 2026-05-15  
**版本**: v1.2.0  
**开发者**: GJJ AI Assistant
