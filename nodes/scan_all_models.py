# -*- coding: utf-8 -*-
"""Scan all model directories and generate TSV entries."""
import os
from pathlib import Path
from collections import defaultdict

# Common ComfyUI model directories to scan
MODEL_DIRS = [
    "animatediff_models",
    "animatediff_motion_lora",
    "audio_encoders",
    "audiodit",
    "BEN",
    "BiRefNet",
    "blip",
    "checkpoints",
    "ckpts",
    "clip",
    "clip_vision",
    "clip_visions",
    "CogVideo",
    "controlnet",
    "cosyvoice",
    "detection",
    "diffusers",
    "diffusion_models",
    "dlib",
    "embeddings",
    "facerestore_models",
    "fishaudioS2",
    "FlashVSR",
    "FlashVSR-v1.1",
    "florence2",
    "frame_interpolatiom",
    "gligen",
    "hidream_i1_fast_local",
    "hypernetworks",
    "insightface",
    "instantid",
    "ipadapter",
    "Joy_caption",
    "latent_upscale_models",
    "latentsync",
    "liveportrait",
    "LLM",
    "loras",
    "mediapipe",
    "mmaudio",
    "modelscope",
    "nsfw_detector",
    "onnx",
    "photomaker",
    "pose_estimation",
    "Qwen3-ASR",
    "reactor",
    "RMBG",
    "sam2",
    "sam3",
    "sams",
    "SEEDVR2",
    "style_models",
    "text_encoders",
    "ultralytics",
    "unet",
    "upscale_models",
    "vae",
    "vae_approx",
    "vitmatte",
    "woosh",
    "xlabs",
    "yolo",
    "z_image_de_turbo_cached_local",
    "z_image_turbo_nvfp4_local",
]

# Map directory names to categories
DIR_TO_CATEGORY = {
    "checkpoints": "unet",
    "ckpts": "unet",
    "unet": "unet",
    "diffusion_models": "unet",
    "diffusers": "unet",
    
    "clip": "clip",
    "clip_vision": "clip",
    "clip_visions": "clip",
    "text_encoders": "clip",
    "audio_encoders": "clip",
    
    "vae": "vae",
    "vae_approx": "vae",
    
    "loras": "lora",
    "animatediff_motion_lora": "lora",
    
    "controlnet": "controlnet",
    "ipadapter": "controlnet",
    "instantid": "controlnet",
    "gligen": "controlnet",
    "xlabs": "controlnet",
    
    "upscale_models": "upscaler",
    "latent_upscale_models": "upscaler",
    "FlashVSR": "upscaler",
    "FlashVSR-v1.1": "upscaler",
    "SEEDVR2": "upscaler",
    
    "embeddings": "embedding",
    "hypernetworks": "embedding",
    
    "animatediff_models": "unet",
    "CogVideo": "unet",
    "hidream_i1_fast_local": "unet",
    "modelscope": "unet",
    
    "sam2": "unet",
    "sam3": "unet",
    "sams": "unet",
    
    "liveportrait": "unet",
    "facerestore_models": "unet",
    "photomaker": "unet",
    
    "RMBG": "unet",
    "BiRefNet": "unet",
    "vitmatte": "unet",
    "BEN": "unet",
    
    "ultralytics": "unet",
    "yolo": "unet",
    "detection": "unet",
    
    "florence2": "clip",
    "blip": "clip",
    "Joy_caption": "clip",
    "Qwen3-ASR": "clip",
    
    "audiodit": "audio",
    "fishaudioS2": "audio",
    "cosyvoice": "audio",
    "latentsync": "audio",
    "mmaudio": "audio",
    "woosh": "audio",
    
    "mediapipe": "model",
    "dlib": "model",
    "insightface": "model",
    "pose_estimation": "model",
    "reactor": "model",
    "nsfw_detector": "model",
    
    "style_models": "unet",
    "prompt_generator": "embedding",
}

# Model file extensions
MODEL_EXTENSIONS = {'.safetensors', '.ckpt', '.pth', '.pt', '.bin', '.gguf', '.onnx', '.engine'}


def normalize_model_name(name):
    """Normalize model name (remove extension and quantization params)."""
    import re
    
    # Remove path
    name = name.replace('\\', '/').split('/')[-1]
    
    # Remove extension
    for ext in MODEL_EXTENSIONS:
        if name.lower().endswith(ext):
            name = name[:-len(ext)]
            break
    
    # Remove common quantization patterns
    quant_patterns = [
        r'_fp8[_\w]*', r'_fp16[_\w]*', r'_fp4[_\w]*', r'_bf16[_\w]*',
        r'_int8[_\w]*', r'_nvfp4[_\w]*', r'_e4m3fn[_\w]*',
        r'_scaled[_\w]*', r'_turbo[_\w]*', r'_v\d+[\.\d_]*',
    ]
    
    for pattern in quant_patterns:
        name = re.sub(pattern, '', name, flags=re.IGNORECASE)
    
    # Clean up extra hyphens and underscores
    name = re.sub(r'[-_]+', '-', name).strip('-_')
    
    return name.lower()


def scan_directory(base_path, dir_name):
    """Scan a directory for model files."""
    dir_path = base_path / dir_name
    if not dir_path.exists():
        return []
    
    models = []
    category = DIR_TO_CATEGORY.get(dir_name, "unknown")
    
    # Walk through directory (including subdirectories)
    for root, dirs, files in os.walk(dir_path):
        for filename in files:
            if any(filename.lower().endswith(ext) for ext in MODEL_EXTENSIONS):
                # Get relative path from base
                rel_path = Path(root) / filename
                rel_to_base = rel_path.relative_to(base_path)
                
                # Normalize name
                normalized = normalize_model_name(filename)
                
                if normalized and len(normalized) > 2:
                    models.append({
                        'filename': str(rel_to_base),
                        'normalized': normalized,
                        'category': category,
                        'directory': dir_name,
                    })
    
    return models


def main():
    """Main function to scan and generate TSV."""
    # Use the correct models directory path
    possible_paths = [
        Path("D:/AI/MOD/models"),  # ✅ Correct path via symbolic link
        Path("D:/AI/CUI/ComfyUI/models"),  # Alternative ComfyUI path
        Path("D:/ComfyUI/models"),
        Path("D:/AI/ComfyUI/models"),
        Path("C:/ComfyUI/models"),
        Path("../../models"),  # Relative to nodes directory
        Path("../models"),
    ]
    
    base_path = None
    for path in possible_paths:
        if path.exists():
            base_path = path
            print(f"Found models directory: {base_path}")
            break
    
    if not base_path:
        print("Models directory not found. Please specify the path.")
        print("\nAvailable directories to scan:")
        for d in MODEL_DIRS:
            print(f"  - {d}")
        return
    
    print(f"\nScanning {len(MODEL_DIRS)} directories...\n")
    
    all_models = []
    for dir_name in MODEL_DIRS:
        models = scan_directory(base_path, dir_name)
        if models:
            print(f"✓ {dir_name}: {len(models)} models")
            all_models.extend(models)
        else:
            print(f"○ {dir_name}: empty or not found")
    
    print(f"\n{'='*80}")
    print(f"Total: {len(all_models)} models found")
    print(f"{'='*80}\n")
    
    # Generate TSV output
    print("# Additional models scanned from ComfyUI models directory")
    print("# Add these to presets/model_keywords.tsv")
    print("id\tcategory\tkeywords\tdisplay_name\tdescription\ttags\tpriority")
    
    # Group by category for better organization
    by_category = defaultdict(list)
    for model in all_models:
        by_category[model['category']].append(model)
    
    for category in sorted(by_category.keys()):
        models = by_category[category]
        for model in sorted(models, key=lambda x: x['normalized']):
            normalized = model['normalized']
            filename = model['filename']
            dir_name = model['directory']
            
            # Generate display name
            display_name = normalized.replace('-', ' ').replace('_', ' ').title()
            
            # Generate keywords
            keywords = normalized.replace('_', '-').split('-')
            keywords_str = '|'.join(keywords[:5])  # Limit to 5 keywords
            
            # Generate tags
            tags = [category, dir_name.replace('_', '-')]
            tags_str = '|'.join(tags)
            
            # Description
            description = f"{display_name} ({category})"
            
            # Priority based on directory importance
            priority_map = {
                "checkpoints": 90,
                "clip": 85,
                "vae": 85,
                "loras": 80,
                "controlnet": 80,
                "upscale_models": 75,
            }
            priority = priority_map.get(dir_name, 60)
            
            print(f"{normalized}\t{category}\t{keywords_str}\t{display_name}\t{description}\t{tags_str}\t{priority}")


if __name__ == "__main__":
    main()
