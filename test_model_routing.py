#!/usr/bin/env python3
"""
测试 ONNX 模型的路由逻辑
"""

import os
import sys
import onnxruntime as ort

print("=" * 60)
print("🧪 测试 ONNX 模型路由逻辑")
print("=" * 60)

# 模型路径
model_path = r"D:\AI\CUI\ComfyUI\models\insightface\buffalo_l\det_10g.onnx"

print(f"\n📂 模型路径: {model_path}")
print(f"📂 文件存在: {os.path.exists(model_path)}")

if not os.path.exists(model_path):
    print("❌ 模型文件不存在！")
    sys.exit(1)

try:
    print(f"\n 正在加载 ONNX 模型...")
    session = ort.InferenceSession(model_path, None)
    
    input_cfg = session.get_inputs()[0]
    input_shape = input_cfg.shape
    outputs = session.get_outputs()
    
    print(f"\n📊 输入形状: {input_shape}")
    print(f"📊 输出数量: {len(outputs)}")
    print(f"📊 输出形状:")
    for i, out in enumerate(outputs):
        print(f"  输出 {i}: {out.shape}")
    
    print(f"\n🔍 路由判断:")
    print(f"  len(outputs) >= 5: {len(outputs) >= 5} (实际: {len(outputs)})")
    print(f"  input_shape[2]==112 and input_shape[3]==112: {input_shape[2] == 112 and input_shape[3] == 112}")
    
    if len(outputs) >= 5:
        print(f"\n✅ 应该被识别为 SCRFD 模型")
    elif input_shape[2] == 112 and input_shape[3] == 112:
        print(f"\n✅ 应该被识别为 ArcFaceONNX 模型")
    else:
        print(f"\n 无法识别模型类型！")
        
except Exception as e:
    print(f"\n 模型加载失败: {e}")
    import traceback
    print(f" 详细堆栈:\n{traceback.format_exc()}")

print("\n" + "=" * 60)
