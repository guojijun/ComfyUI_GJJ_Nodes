# -*- coding: utf-8 -*-
"""批量更新节点文件，将 GJJ_BATCH_IMAGE_TYPE 声明改为兼容 IMAGE 格式。

将所有 RETURN_TYPES = (GJJ_BATCH_IMAGE_TYPE,) 
改为 RETURN_TYPES = ("GJJ_BATCH_IMAGE,IMAGE",)

以及 INPUT_TYPES 中的类型声明从 "GJJ_BATCH_IMAGE" 改为 "GJJ_BATCH_IMAGE,IMAGE"
"""
import re
from pathlib import Path

NODES_DIR = Path(__file__).parent

# 需要更新的文件列表
FILES_TO_UPDATE = [
    "gjj_batch_image_bridge.py",
    "gjj_batch_text_segmenter.py",
    "gjj_batch_watermark_remover.py",
    "gjj_character_multiview_studio.py",
    "gjj_color_balance.py",
    "gjj_comprehensive_matting.py",
    "gjj_image_analysis.py",
    "gjj_image_collage.py",
    "gjj_image_splitter.py",
    "gjj_lazy_image_studio.py",
    "gjj_lora_face_material_generator.py",
    "gjj_ltx23_first_last_outfit.py",
    "gjj_ltx23_multiref_image_to_video.py",
    "gjj_multi_image_loader.py",
    "gjj_multi_video_loader.py",
    "gjj_qwen2511_edit_outpaint.py",
    "gjj_text_overlay.py",
    "gjj_video_combine.py",
    "gjj_wan22_rapid_aio_mega.py",
]

def update_return_types(content):
    """更新 RETURN_TYPES 声明。"""
    # 匹配 RETURN_TYPES = (GJJ_BATCH_IMAGE_TYPE,)
    pattern = r'RETURN_TYPES\s*=\s*\(\s*GJJ_BATCH_IMAGE_TYPE\s*,?\s*\)'
    replacement = 'RETURN_TYPES = ("GJJ_BATCH_IMAGE,IMAGE",)'
    
    updated = re.sub(pattern, replacement, content)
    return updated

def update_input_output_types(content):
    """更新 INPUT_TYPES/OUTPUT_TYPES 中的类型字符串。"""
    # 匹配 "type": "GJJ_BATCH_IMAGE" 或 "type": GJJ_BATCH_IMAGE_TYPE
    # 但不匹配已经是 "GJJ_BATCH_IMAGE,IMAGE" 的情况
    
    # 模式1: "type": "GJJ_BATCH_IMAGE"
    pattern1 = r'"type"\s*:\s*"GJJ_BATCH_IMAGE"(?!,IMAGE)'
    replacement1 = '"type": "GJJ_BATCH_IMAGE,IMAGE"'
    
    # 模式2: "type": GJJ_BATCH_IMAGE_TYPE (变量引用)
    pattern2 = r'"type"\s*:\s*GJJ_BATCH_IMAGE_TYPE(?!,\s*"IMAGE")'
    replacement2 = '"type": "GJJ_BATCH_IMAGE,IMAGE"'
    
    updated = re.sub(pattern1, replacement1, content)
    updated = re.sub(pattern2, replacement2, updated)
    
    return updated

def update_file(file_path):
    """更新单个文件。"""
    if not file_path.exists():
        print(f"⚠ 文件不存在: {file_path.name}")
        return False
    
    with open(file_path, 'r', encoding='utf-8') as f:
        original_content = f.read()
    
    content = original_content
    
    # 更新 RETURN_TYPES
    content = update_return_types(content)
    
    # 更新 INPUT_TYPES/OUTPUT_TYPES 中的类型声明
    content = update_input_output_types(content)
    
    # 如果内容有变化，写回文件
    if content != original_content:
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"✅ 已更新: {file_path.name}")
        return True
    else:
        print(f"⏭️ 无需更新: {file_path.name}")
        return False

def main():
    """主函数。"""
    print("=" * 80)
    print("批量更新 GJJ_BATCH_IMAGE 类型声明为兼容 IMAGE 格式")
    print("=" * 80)
    print()
    
    updated_count = 0
    skipped_count = 0
    
    for filename in FILES_TO_UPDATE:
        file_path = NODES_DIR / filename
        if update_file(file_path):
            updated_count += 1
        else:
            skipped_count += 1
    
    print()
    print("=" * 80)
    print(f"更新完成!")
    print(f"  ✅ 已更新: {updated_count} 个文件")
    print(f"  ⏭️ 跳过: {skipped_count} 个文件")
    print("=" * 80)

if __name__ == "__main__":
    main()
