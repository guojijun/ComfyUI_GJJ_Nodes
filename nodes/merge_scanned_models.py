# -*- coding: utf-8 -*-
"""Merge scanned models into model_keywords.tsv."""
import csv
from pathlib import Path

TSV_FILE = Path(__file__).parent / "presets" / "model_keywords.tsv"
SCANNED_FILE = Path(__file__).parent / "scanned_models_corrected.tsv"

def load_existing_models():
    """Load existing models from TSV file."""
    models = {}
    if not TSV_FILE.exists():
        return models
    
    with TSV_FILE.open("r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            
            parts = line.split("\t")
            if len(parts) >= 2:
                model_id = parts[0].lower()
                category = parts[1].lower()
                key = (model_id, category)
                models[key] = line
    
    return models


def load_scanned_models():
    """Load scanned models from scan result."""
    models = []
    if not SCANNED_FILE.exists():
        return models
    
    with SCANNED_FILE.open("r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("id\t"):
                continue
            
            parts = line.split("\t")
            if len(parts) >= 7:
                models.append(line)
    
    return models


def main():
    """Merge scanned models into TSV."""
    print("Loading existing models...")
    existing = load_existing_models()
    print(f"  Found {len(existing)} existing models")
    
    print("\nLoading scanned models...")
    scanned = load_scanned_models()
    print(f"  Found {len(scanned)} scanned models")
    
    # Merge: add new models that don't exist
    added = 0
    skipped = 0
    
    for line in scanned:
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        
        model_id = parts[0].lower()
        category = parts[1].lower()
        key = (model_id, category)
        
        if key not in existing:
            existing[key] = line
            added += 1
        else:
            skipped += 1
    
    print(f"\nMerge results:")
    print(f"  Added: {added} new models")
    print(f"  Skipped: {skipped} duplicates")
    print(f"  Total: {len(existing)} models")
    
    # Write back to TSV
    print(f"\nWriting to {TSV_FILE}...")
    with TSV_FILE.open("w", encoding="utf-8-sig", newline="") as f:
        # Write header comments
        f.write("""# GJJ 模型关键词索引表 (Model Keywords Index)
# 
# 用途说明：
# 1. 统一管理所有模型的关键词（去扩展名、去量化参数）
# 2. 支持模糊搜索和子目录匹配
# 3. 方便维护和扩展
#
# 字段说明：
# - id: 唯一标识符（小写，使用连字符分隔）
# - category: 模型类别 (unet/clip/vae/lora/controlnet/upscaler/audio/embedding)
# - keywords: 搜索关键词（多个用 | 分隔，已去除扩展名和量化参数）
# - display_name: 显示名称（人类可读）
# - description: 描述信息
# - tags: 标签（多个用 | 分隔）
# - priority: 优先级（0-100，数字越大越优先匹配）
#
# 规范化规则：
# 1. 去除扩展名：.safetensors, .ckpt, .pth, .pt, .bin, .gguf, .onnx
# 2. 去除量化参数：_fp8, _fp16, _bf16, _fp4, _nvfp4, _e4m3fn, _scaled, _turbo 等
# 3. 统一使用小写字母和连字符
#
# 示例：
# 原始文件名: "ltx-2.3-22b-distilled_transformer_only_fp8_input_scaled_v3.safetensors"
# 规范化后: "ltx-2.3-22b-distilled-transformer-only"
# 关键词: "ltx|2.3|22b|distilled|transformer|only"

""")
        
        # Sort by category then by id
        sorted_keys = sorted(existing.keys(), key=lambda x: (x[1], x[0]))
        
        for key in sorted_keys:
            f.write(existing[key] + "\n")
    
    print(f"\n✅ Done! Updated {TSV_FILE}")
    print(f"   Total models: {len(existing)}")


if __name__ == "__main__":
    main()
