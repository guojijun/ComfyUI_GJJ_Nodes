# GJJ_FaceAnalysis 节点 - INSwapper landmark 类型修复

##  问题根源

在 [get_affine_matrix](file://d:\AI\MOD\custom_nodes\GJJ\vendor\insightface\model_zoo\inswapper.py#L107-L118) 方法中：

```python
dst = target_face.landmark  # 这是一个元组 tuple
tform.estimate(dst, src)    # skimage 期望 numpy 数组
```

**错误信息**：
```
IndexError: tuple index out of range
```

**原因**：`target_face.landmark` 是一个**元组** `(5, 2)`，而 `skimage.transform.SimilarityTransform.estimate()` 期望的是 **numpy 数组**。当传入元组时，skimage 尝试访问 `src.shape[0]` 失败，因为元组没有 `shape` 属性。

##  解决方案

将 landmark 元组转换为 numpy 数组：

```python
# 之前
dst = target_face.landmark

# 修复后
dst = np.array(target_face.landmark, dtype=np.float32)
```

### 完整修复代码

```python
def get_affine_matrix(self, target_face):
    tform = trans.SimilarityTransform()
    src = np.array([
      [38.2946, 51.6963],
      [73.5318, 51.5014],
      [56.0252, 71.7366],
      [41.5493, 92.3655],
      [70.7299, 92.2041] ], dtype=np.float32)
    
    #  关键修复：确保 landmark 是 numpy 数组
    dst = np.array(target_face.landmark, dtype=np.float32)
    
    tform.estimate(dst, src)
    M = tform.params[0:2, :]
    return M, tform
```

##  为什么需要转换

### Face 对象的 landmark 字段

```python
Face = collections.namedtuple('Face', [
    'bbox', 'landmark', 'det_score', 'embedding', 'gender', 'age',
])
```

`landmark` 字段通常存储为**元组**或**列表**，包含 5 个关键点的坐标：

```python
landmark = (
    [x1, y1],  # 左眼
    [x2, y2],  # 右眼
    [x3, y3],  # 鼻子
    [x4, y4],  # 左嘴角
    [x5, y5],  # 右嘴角
)
```

### skimage.transform 的要求

`SimilarityTransform.estimate()` 方法要求输入是 **numpy 数组**，因为它需要访问 `.shape` 属性并进行矩阵运算：

```python
def _umeyama(src, dst, estimate_scale):
    num = src.shape[0]  # 需要 .shape 属性
    dim = src.shape[1]
    # ...
```

##  预期日志输出

重启后应该看到：

```
[GJJ ModelRouter] ✅ 识别为 INSwapper 换脸模型
inswapper-shape: [1, 3, 128, 128]

[GJJ FaceAnalysis] ✅ 成功加载模型
set det-size: (640, 640)

# 换脸执行时（不再报错）
[GJJ FaceAnalysis] 开始换脸处理...
✅ 换脸完成
```

**关键验证点**：
✅ 没有看到 `IndexError: tuple index out of range`  
✅ 没有看到 `AttributeError`  
✅ 换脸节点成功输出结果图像

##  相关修复历史

1. **模型路由问题** - 修复 ModelRouter 参数错误
2. **模块缓存冲突** - 添加强制清除缓存逻辑
3. **非标准模型跳过** - 支持跳过 1k3d68.onnx
4. **模型选择优化** - 优先选择 112x112 识别模型
5. **INSwapper 支持** - 添加换脸模型实现
6. **landmark 类型修复** - 本修复（当前）

---

**修复状态**: ✅ 已完成  
**代码修改**: ✅ vendor/insightface/model_zoo/inswapper.py  
**缓存清除**: ✅ 已完成  
**下一步**: 🔄 **重启 ComfyUI**（必须！）
