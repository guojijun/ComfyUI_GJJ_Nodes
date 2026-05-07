# -*- coding: utf-8 -*-
"""Scan all hardcoded model names in the project (with incremental update support)."""
import re
import json
import hashlib
from pathlib import Path
from collections import defaultdict
from datetime import datetime

ROOT = Path(__file__).parent
CACHE_FILE = ROOT / ".model_scan_cache.json"
MODEL_EXTENSIONS = {'.safetensors', '.ckpt', '.pth', '.pt', '.bin', '.gguf', '.onnx'}
models_by_category = defaultdict(lambda: defaultdict(list))

def load_cache():
    """加载扫描缓存（包含文件哈希和时间戳）。"""
    if CACHE_FILE.exists():
        try:
            with open(CACHE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {"version": 1, "scan_time": None, "file_hashes": {}, "results": {}}

def save_cache(cache_data):
    """保存扫描缓存。"""
    try:
        with open(CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(cache_data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[Warning] Failed to save cache: {e}")

def compute_file_hash(file_path):
    """计算文件的 MD5 哈希值（用于检测变更）。"""
    try:
        hash_md5 = hashlib.md5()
        with open(file_path, 'rb') as f:
            for chunk in iter(lambda: f.read(4096), b""):
                hash_md5.update(chunk)
        return hash_md5.hexdigest()
    except Exception:
        return None

def extract_model_names(file_path):
    try:
        content = file_path.read_text(encoding='utf-8-sig')
    except Exception:
        return []
    
    results = []
    patterns = [
        (r'(?:unet|checkpoint|model)[_\s]*(?:name|path|candidates?).*?=.*?["\']([^"\']+\.safetensors[^"\']*)["\']', 'unet'),
        (r'DEFAULT_CKPT.*?=.*?["\']([^"\']+\.safetensors[^"\']*)["\']', 'unet'),
        (r'(?:clip|text_encoder)[_\s]*(?:name|candidates?).*?=.*?["\']([^"\']+\.safetensors[^"\']*)["\']', 'clip'),
        (r'DEFAULT_TEXT_ENCODER.*?=.*?["\']([^"\']+\.safetensors[^"\']*)["\']', 'clip'),
        (r'(?:vae|video_vae)[_\s]*(?:name|candidates?).*?=.*?["\']([^"\']+\.safetensors[^"\']*)["\']', 'vae'),
        (r'DEFAULT_VIDEO_VAE.*?=.*?["\']([^"\']+\.safetensors[^"\']*)["\']', 'vae'),
        (r'(?:lora)[_\s]*(?:name|candidates?).*?=.*?["\']([^"\']+\.safetensors[^"\']*)["\']', 'lora'),
        (r'(?:controlnet)[_\s]*(?:name|candidates?).*?=.*?["\']([^"\']+\.safetensors[^"\']*)["\']', 'controlnet'),
        (r'(?:upscaler|latent_upscaler)[_\s]*(?:name|candidates?).*?=.*?["\']([^"\']+\.safetensors[^"\']*)["\']', 'upscaler'),
        (r'DEFAULT_LATENT_UPSCALER.*?=.*?["\']([^"\']+\.safetensors[^"\']*)["\']', 'upscaler'),
        (r'["\']([\w\-\.]+\.safetensors)["\']', 'unknown'),
    ]
    
    for pattern, category in patterns:
        matches = re.finditer(pattern, content, re.IGNORECASE | re.DOTALL)
        for match in matches:
            model_name = match.group(1).strip()
            if model_name and not model_name.startswith('{'):
                results.append((model_name, category))
    
    return results


def normalize_model_name(name):
    name = name.replace('\\', '/').split('/')[-1]
    for ext in ['.safetensors', '.ckpt', '.pth', '.pt', '.bin', '.gguf', '.onnx']:
        if name.lower().endswith(ext):
            name = name[:-len(ext)]
            break
    
    quant_patterns = [
        r'_fp8[_\w]*', r'_fp16[_\w]*', r'_fp4[_\w]*', r'_bf16[_\w]*',
        r'_int8[_\w]*', r'_nvfp4[_\w]*', r'_e4m3fn[_\w]*',
        r'_scaled[_\w]*', r'_turbo[_\w]*',
    ]
    
    for pattern in quant_patterns:
        name = re.sub(pattern, '', name, flags=re.IGNORECASE)
    
    name = re.sub(r'[-_]+', '-', name).strip('-_')
    return name.lower()


# ============================================================================
# 主逻辑：支持增量扫描
# ============================================================================

print("Scanning project for model usage...")

# 1. 加载缓存
cache = load_cache()
current_hashes = {}
needs_full_scan = False

# 2. 获取所有需要扫描的 Python 文件
py_files = list(ROOT.glob('**/*.py'))
py_files = [f for f in py_files if 'common_utils' not in str(f) and '__pycache__' not in str(f)]

# 3. 检查哪些文件发生了变更
changed_files = []
for py_file in py_files:
    current_hash = compute_file_hash(py_file)
    if current_hash:
        current_hashes[str(py_file)] = current_hash
        cached_hash = cache.get("file_hashes", {}).get(str(py_file))
        if cached_hash != current_hash:
            changed_files.append(py_file)
            needs_full_scan = True

# 4. 决定扫描策略
if not needs_full_scan and cache.get("results"):
    print("[Info] No changes detected. Using cached results.")
    # 直接使用缓存的结果
    for category, models in cache["results"].items():
        for model_name, files in models.items():
            for file_name in files:
                models_by_category[category][model_name].append(file_name)
else:
    print(f"[Info] Detected {len(changed_files)} changed file(s). Performing full scan...")
    # 执行完整扫描
    for py_file in py_files:
        models = extract_model_names(py_file)
        for model_name, category in models:
            normalized = normalize_model_name(model_name)
            if normalized and len(normalized) > 2:
                models_by_category[category][normalized].append(py_file.name)
    
    # 更新缓存
    cache["scan_time"] = datetime.now().isoformat()
    cache["file_hashes"] = current_hashes
    cache["results"] = {
        cat: {model: list(set(files)) for model, files in models.items()}
        for cat, models in models_by_category.items()
    }
    save_cache(cache)
    print("[Info] Cache updated.")

print("=" * 80)
print("Model Usage Statistics Report")
print("=" * 80)

total_models = 0
for category in sorted(models_by_category.keys()):
    models = models_by_category[category]
    print(f"\n[{category.upper()}] - {len(models)} models")
    print("-" * 80)
    
    for model_name in sorted(models.keys()):
        files = models[model_name]
        unique_files = list(set(files))
        total_models += 1
        
        print(f"  - {model_name}")
        print(f"    Used by {len(unique_files)} files: {', '.join(sorted(unique_files)[:5])}")
        if len(unique_files) > 5:
            print(f"    ... and {len(unique_files) - 5} more files")

print("\n" + "=" * 80)
print(f"Total: {total_models} unique models (normalized)")
print("=" * 80)

print("\n\nTSV Output (copy to model_keywords.tsv):")
print("=" * 80)
print("id\tcategory\tkeywords\tdisplay_name\tdescription\ttags\tpriority")

for category in sorted(models_by_category.keys()):
    models = models_by_category[category]
    for model_name in sorted(models.keys()):
        files = models[model_name]
        usage_count = len(set(files))
        
        display_name = model_name.replace('-', ' ').replace('_', ' ').title()
        keywords = model_name.replace('_', '-').split('-')
        keywords_str = '|'.join(keywords)
        priority = min(100, 50 + usage_count * 10)
        
        tags = [category]
        if usage_count > 3:
            tags.append('popular')
        tags_str = '|'.join(tags)
        
        description = f"{display_name} ({category})"
        
        print(f"{model_name}\t{category}\t{keywords_str}\t{display_name}\t{description}\t{tags_str}\t{priority}")
