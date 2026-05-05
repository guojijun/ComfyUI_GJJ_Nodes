#!/usr/bin/env python3
"""
测试 vendor 中的 insightface 是否能正确加载
"""

import os
import sys

print("=" * 60)
print("🧪 测试 vendor 中的 insightface 加载")
print("=" * 60)

# 模拟节点的加载逻辑
vendor_path = os.path.join(os.path.dirname(__file__), 'vendor')
print(f"\n📂 vendor 路径: {vendor_path}")
print(f"📂 vendor 存在: {os.path.exists(vendor_path)}")

if vendor_path not in sys.path:
    sys.path.insert(0, vendor_path)
    print(f"✅ 已添加 vendor 到 sys.path")
else:
    print(f"ℹ️  vendor 已在 sys.path 中")

print(f"\n📋 sys.path 前 3 项:")
for i, p in enumerate(sys.path[:3]):
    print(f"  {i}: {p}")

# 尝试导入 insightface
try:
    import insightface
    print(f"\n✅ 成功导入 insightface")
    print(f" insightface 路径: {insightface.__file__}")
    
    # 检查是否是 vendor 中的版本
    if 'vendor' in insightface.__file__:
        print(f"🎉 使用的是 vendor 中的 insightface！")
    else:
        print(f"⚠️  使用的是系统 Python 的 insightface！")
        print(f"   路径: {insightface.__file__}")
        
except ImportError as e:
    print(f"\n❌ 无法导入 insightface: {e}")

print("\n" + "=" * 60)
