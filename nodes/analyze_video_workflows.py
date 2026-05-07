# -*- coding: utf-8 -*-
"""Analyze video workflows (Wan, LTX) to extract model usage."""
import json
from pathlib import Path
from collections import defaultdict

VIDEO_WORKFLOW_DIRS = [
    "D:/AI/MOD/user/default/workflows/Video",
    "D:/AI/MOD/user/default/workflows/wan2.2",
    "D:/AI/MOD/user/default/workflows/wan2.2workflows",
]

def analyze_workflow(workflow_path):
    """Analyze a single workflow file for model usage."""
    try:
        with open(workflow_path, 'r', encoding='utf-8') as f:
            workflow = json.load(f)
    except Exception as e:
        print(f"Error reading {workflow_path.name}: {e}")
        return None
    
    models = []
    
    # Extract nodes from workflow
    nodes = workflow.get('nodes', [])
    
    for node in nodes:
        node_type = node.get('type', '')
        widgets = node.get('widgets_values', [])
        
        # Check for model loader nodes
        if node_type in ['UNETLoader', 'VAELoader', 'CLIPLoader', 'LoraLoader', 'LoraLoaderModelOnly']:
            model_info = {
                'node_type': node_type,
                'model_name': widgets[0] if widgets else None,
            }
            
            # Extract additional info for CLIPLoader
            if node_type == 'CLIPLoader' and len(widgets) > 1:
                model_info['clip_type'] = widgets[1] if len(widgets) > 1 else None
            
            models.append(model_info)
    
    return {
        'filename': workflow_path.name,
        'models': models,
    }


def main():
    """Main analysis function."""
    print("=" * 80)
    print("Video Workflow Model Analysis (Wan & LTX)")
    print("=" * 80)
    
    all_models = defaultdict(list)
    workflow_results = []
    
    for dir_path in VIDEO_WORKFLOW_DIRS:
        dir = Path(dir_path)
        if not dir.exists():
            print(f"\n⚠ Directory not found: {dir_path}")
            continue
        
        print(f"\n📁 Scanning: {dir.name}")
        workflow_files = list(dir.glob("*.json"))
        print(f"   Found {len(workflow_files)} workflow files")
        
        for wf_file in sorted(workflow_files):
            result = analyze_workflow(wf_file)
            if result and result['models']:
                workflow_results.append(result)
                
                for model in result['models']:
                    model_name = model.get('model_name', 'Unknown')
                    if model_name:
                        all_models[model_name].append({
                            'workflow': result['filename'],
                            'directory': dir.name,
                            'node_type': model['node_type'],
                        })
    
    # Print results
    print("\n" + "=" * 80)
    print("Model Usage Summary")
    print("=" * 80)
    
    for model_name, usages in sorted(all_models.items()):
        print(f"\n📦 {model_name}")
        print(f"   Used in {len(usages)} workflow(s):")
        for usage in usages:
            print(f"   - {usage['directory']}/{usage['workflow']} ({usage['node_type']})")
    
    print("\n" + "=" * 80)
    print(f"Total unique models: {len(all_models)}")
    print(f"Workflows with models: {len(workflow_results)}")
    print("=" * 80)
    
    # Generate TSV update suggestions
    print("\n\nTSV Update Suggestions for Video Models:")
    print("=" * 80)
    print("# Add these video models to presets/model_keywords.tsv")
    print("id\tcategory\tkeywords\tdisplay_name\tdescription\ttags\tpriority")
    
    for model_name in sorted(all_models.keys()):
        # Normalize model name
        normalized = model_name.lower().replace('.safetensors', '').replace('.ckpt', '')
        normalized = normalized.replace('_', '-').replace(' ', '-')
        
        # Determine category from usage
        usages = all_models[model_name]
        categories = set()
        for usage in usages:
            node_type = usage['node_type']
            if 'UNET' in node_type:
                categories.add('unet')
            elif 'VAE' in node_type:
                categories.add('vae')
            elif 'CLIP' in node_type:
                categories.add('clip')
            elif 'Lora' in node_type:
                categories.add('lora')
        
        category = '|'.join(sorted(categories)) if categories else 'unknown'
        
        # Generate display name
        display_name = normalized.replace('-', ' ').title()
        
        # Generate keywords
        keywords = normalized.split('-')[:6]
        keywords_str = '|'.join(keywords)
        
        # Generate tags
        tags = list(categories) + ['video', 'official-workflow']
        
        # Detect specific model families
        if 'wan' in normalized:
            tags.append('wan')
        if 'ltx' in normalized:
            tags.append('ltx')
        
        tags_str = '|'.join(tags)
        
        description = f"{display_name} (video model from official workflows)"
        
        # Priority based on usage count and model family
        base_priority = 70
        if 'wan' in normalized or 'ltx' in normalized:
            base_priority = 90  # High priority for Wan/LTX
        
        priority = min(100, base_priority + len(usages) * 3)
        
        print(f"{normalized}\t{category}\t{keywords_str}\t{display_name}\t{description}\t{tags_str}\t{priority}")


if __name__ == "__main__":
    main()
