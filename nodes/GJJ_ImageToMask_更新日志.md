# GJJ_ImageToMask 节点更新日志

## v1.1.0 (2026-05-15) - RGB通道支持 & UI增强

### ✨ 新增功能

#### 1. RGB单通道提取
- 🔴 **红色通道模式**：提取图像的R通道作为遮罩
- 🟢 **绿色通道模式**：提取图像的G通道作为遮罩
- 🔵 **蓝色通道模式**：提取图像的B通道作为遮罩

**应用场景**：
- 颜色分离与分析
- 特定通道的遮罩生成
- 通道混合与合成
- 色彩校正辅助

#### 2. Emoji图标增强
所有选项和参数都添加了直观的emoji图标：
- 🎭 节点描述
- 🖼️ 输入图像参数
- 🔄 转换方法参数
- 💡 亮度模式
- 🔳 Alpha通道模式
- 🔴 红色通道
- 🟢 绿色通道
- 🔵 蓝色通道

#### 3. 详细中文Tooltip
为转换方法添加了多行详细提示：
```
选择遮罩生成方式：
• 💡 亮度：根据灰度值生成遮罩，适合黑白图、线稿
• 🔳 Alpha通道：使用透明通道，适合PNG透明图
• 🔴 红色通道：提取R通道作为遮罩
• 🟢 绿色通道：提取G通道作为遮罩
• 🔵 蓝色通道：提取B通道作为遮罩
```

#### 4. 前端JavaScript增强
新增 `js/gjj_image_to_mask.js`：
- 右键菜单快速切换模式功能
- 增强的鼠标悬停提示
- 自定义绘制逻辑支持
- 节点加载状态提示

### 🔧 技术改进

#### 智能方法解析
```python
# 移除 emoji 前缀，获取实际方法名
actual_method = method.split(" ", 1)[-1] if " " in method else method
```
支持带emoji的选项值，自动解析为实际方法名。

#### 扩展的条件分支
```python
if actual_method == "Alpha通道":
    return (image[:, :, :, 3],)
elif actual_method == "红色通道":
    return (image[:, :, :, 0],)
elif actual_method == "绿色通道":
    return (image[:, :, :, 1],)
elif actual_method == "蓝色通道":
    return (image[:, :, :, 2],)
else:  # 亮度模式
    return (_tensor_to_mask(image),)
```

### 📝 文档更新

#### 更新的文档
1. ✅ `gjj_image_to_mask_README.md` - 添加RGB通道说明
2. ✅ `GJJ_ImageToMask_快速参考.md` - 更新场景示例
3. ✅ `test_image_to_mask.json` - 更新测试工作流
4. ✅ 本更新日志

#### 新增文档
- `GJJ_ImageToMask_更新日志.md`（本文档）

### 🎯 使用示例

#### 示例1: 红色通道遮罩
```python
# 适合处理以红色为主的图像
# 例如：红外图像、热成像、红色标记等
image → GJJ_ImageToMask(🔴 红色通道) → MASK
```

#### 示例2: 绿色通道遮罩
```python
# 适合处理绿色背景或绿幕素材
# 例如：绿幕抠图、植物图像等
image → GJJ_ImageToMask(🟢 绿色通道) → MASK
```

#### 示例3: 蓝色通道遮罩
```python
# 适合处理蓝天、海洋等蓝色主题
# 例如：天空分割、水体检测等
image → GJJ_ImageToMask(🔵 蓝色通道) → MASK
```

#### 示例4: 通道对比分析
```
LoadImage 
    ├→ GJJ_ImageToMask(🔴 红色通道) → PreviewImage
    ├→ GJJ_ImageToMask(🟢 绿色通道) → PreviewImage
    └→ GJJ_ImageToMask(🔵 蓝色通道) → PreviewImage
```

### 📊 功能对比

| 版本 | 模式数量 | Emoji | Tooltip | JS增强 | RGB通道 |
|------|---------|-------|---------|--------|---------|
| v1.0.0 | 2种 | ❌ | 基础 | ❌ | ❌ |
| v1.1.0 | 5种 | ✅ | 详细 | ✅ | ✅ |

### 🔄 兼容性

- ✅ **向后兼容**：v1.0.0的工作流可以无缝升级到v1.1.0
- ⚠️ **注意**：旧工作流中的"亮度"需要更新为"💡 亮度"
- ✅ **自动迁移**：ComfyUI会自动处理选项值的变更

### 🐛 已知问题

无

### 📋 待办事项

- [ ] 添加CMYK通道支持（可选）
- [ ] 添加HSV/HSL通道支持（可选）
- [ ] 添加自定义通道权重（高级功能）
- [ ] 添加通道预览缩略图

### 🙏 致谢

感谢用户反馈和建议，使节点功能更加完善！

---

**更新日期**: 2026-05-15  
**版本**: v1.1.0  
**开发者**: GJJ AI Assistant
