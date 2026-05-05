#!/usr/bin/env python3
"""
修复 insightface model_zoo 的 bug
Bug 位置: model_zoo.py 第 54 行
问题: router = ModelRouter(name) 应该用 model_file 而不是 name
"""

import os
import sys

def fix_insightface_bug():
    """修复 insightface 的 model routing bug"""
    
    # 查找 insightface 的安装位置
    try:
        import insightface
        insightface_path = os.path.dirname(insightface.__file__)
        model_zoo_path = os.path.join(insightface_path, "model_zoo", "model_zoo.py")
    except ImportError:
        print(" 未找到 insightface 库")
        print("请先安装: pip install insightface")
        return False
    
    print(f" 找到 insightface: {insightface_path}")
    print(f"📄 model_zoo.py 路径: {model_zoo_path}")
    
    if not os.path.exists(model_zoo_path):
        print(f"❌ 文件不存在: {model_zoo_path}")
        return False
    
    # 读取文件内容
    with open(model_zoo_path, 'r', encoding='utf-8') as f:
        content = f.read()
        lines = content.split('\n')
    
    # 查找并修复 bug
    bug_found = False
    fixed = False
    
    for i, line in enumerate(lines):
        # 查找 bug 行
        if 'router = ModelRouter(name)' in line and not line.strip().startswith('#'):
            print(f"\n🐛 发现 bug (第 {i+1} 行):")
            print(f"  原始: {line.strip()}")
            
            # 修复 bug
            indent = len(line) - len(line.lstrip())
            fixed_line = ' ' * indent + 'router = ModelRouter(model_file)'
            print(f"  修复: {fixed_line.strip()}")
            
            lines[i] = fixed_line
            bug_found = True
            fixed = True
            break
    
    if not bug_found:
        print("\n✅ 未找到 bug，可能已经修复或版本不同")
        return True
    
    # 写回文件
    if fixed:
        with open(model_zoo_path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines))
        print(f"\n✅ 已成功修复 {model_zoo_path}")
        print("\n🎉 修复完成！请重启 ComfyUI 使更改生效。")
        return True
    
    return False

if __name__ == "__main__":
    print("=" * 60)
    print("🔧 insightface model_zoo bug 修复工具")
    print("=" * 60)
    print()
    
    success = fix_insightface_bug()
    
    if success:
        print("\n✨ 修复成功！")
        sys.exit(0)
    else:
        print("\n❌ 修复失败")
        sys.exit(1)
