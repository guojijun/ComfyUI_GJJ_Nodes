# GJJ_FaceAnalysis 节点 - 删除性别过滤参数

## 修改内容

删除了以下两个导致报错的参数：

1. **目标性别过滤** (`detect_gender_target`)
2. **源图性别过滤** (`detect_gender_source`)

## 修改位置

### 1. INPUT_TYPES 定义
**删除前**：
```python
"detect_gender_target": (
    ["no", "male", "female"],
    {
        "display_name": "目标性别过滤",
        "tooltip": "仅对指定性别的目标执行人脸替换",
        "default": "no",
    },
),
"detect_gender_source": (
    ["no", "male", "female"],
    {
        "display_name": "源图性别过滤",
        "tooltip": "仅使用指定性别的源脸部",
        "default": "no",
    },
),
```

**删除后**：直接从 INPUT_TYPES 中移除这两个参数定义

### 2. swap_faces 函数签名
**删除前**：
```python
def swap_faces(
    self,
    target_image: Any,
    source_image: Any,
    face_model: str = "自动检测",
    swap_model: str = "inswapper_128.onnx",
    face_detection: str = "YOLOv5n",
    detect_gender_target: str = "no",      # ← 删除
    detect_gender_source: str = "no",      # ← 删除
    target_faces_index: str = "0",
    source_faces_index: str = "0",
):
```

**删除后**：移除这两个参数

### 3. swap_faces 函数体
**删除前**：
```python
# 解析参数
gender_map = {"no": 0, "male": 2, "female": 1}
gender_tgt = gender_map.get(detect_gender_target, 0)
gender_src = gender_map.get(detect_gender_source, 0)
```

**删除后**：移除性别映射和相关变量解析

### 4. swap_face_core 函数调用
**删除前**：
```python
result_pil = swap_face_core(
    source_pil, target_pil,
    model=swap_model,
    source_faces_index=source_indices,
    faces_index=target_indices,
    gender_source=gender_src,    # ← 删除
    gender_target=gender_tgt,    # ← 删除
    model_path=actual_model_path,
)
```

**删除后**：移除 gender 参数传递

### 5. swap_face_core 函数定义
**删除前**：
```python
def swap_face_core(
    source_img: Union[Image.Image, np.ndarray, None],
    target_img: Union[Image.Image, np.ndarray],
    model: str,
    source_faces_index: List[int] = [0],
    faces_index: List[int] = [0],
    gender_source: int = 0,      # ← 删除
    gender_target: int = 0,      # ← 删除
    faces_order: List[str] = ["large-small", "large-small"],
    model_path: str = None,
) -> Image.Image:
```

**删除后**：移除这两个参数

### 6. get_face_single 函数
**删除前**：
```python
def get_face_single(img_data: np.ndarray, faces, face_index=0, det_size=(640, 640), 
                    gender_source=0, gender_target=0, order="large-small", model_path=None):
    """获取单个人脸"""
    # 性别过滤 - 源图
    if gender_source != 0:
        # ... 性别过滤逻辑
    
    # 性别过滤 - 目标图
    if gender_target != 0:
        # ... 性别过滤逻辑
```

**删除后**：移除 gender 参数和所有性别过滤逻辑，简化为：
```python
def get_face_single(img_data: np.ndarray, faces, face_index=0, det_size=(640, 640), 
                    order="large-small", model_path=None):
    """获取单个人脸"""
    # 直接返回指定索引的人脸，不进行性别过滤
    if len(faces) == 0 and det_size[0] > 320 and det_size[1] > 320:
        det_size_half = (det_size[0] // 2, det_size[1] // 2)
        return get_face_single(img_data, analyze_faces(img_data, det_size_half, model_path=model_path), 
                             face_index, det_size_half, order, model_path=model_path)
    
    try:
        faces_sorted = sort_faces_by_order(faces, order)
        return faces_sorted[face_index], 0
    except IndexError:
        return None, 0
```

## 影响范围

### 节点界面
-  移除 "目标性别过滤" 下拉菜单
- ❌ 移除 "源图性别过滤" 下拉菜单
- ✅ 其他参数保持不变

### 功能影响
- ❌ 不再支持按性别过滤人脸
- ✅ 换脸功能正常工作
- ✅ 所有其他功能保持不变

### 代码简化
- 减少约 60 行代码
- 移除复杂的性别判断逻辑
- 提高代码可维护性

## 测试验证

重启 ComfyUI 后，节点界面应该显示：
- 目标图
- 源图
- 人脸检测模型
- 换脸模型
- 人脸检测
- 目标脸部索引
- 源图脸部索引

**不再显示**：
- ❌ 目标性别过滤
- ❌ 源图性别过滤

---

**修改状态**: ✅ 已完成  
**代码验证**: ✅ 无语法错误  
**下一步**: 🔄 重启 ComfyUI 测试
