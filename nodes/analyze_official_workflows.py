# -*- coding: utf-8 -*-
"""Analyze official workflows to extract model usage patterns."""
import json
from pathlib import Path
from collections import defaultdict

WORKFLOW_DIR = Path("D:/AI/MOD/user/default/workflows/官方工作流")

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
            
            # Extract additional info for specific loaders
            if node_type == 'CLIPLoader' and len(widgets) > 1:
                model_info['clip_type'] = widgets[1] if len(widgets) > 1 else None
            
            models.append(model_info)
        
        # Check for checkpoint loaders (older format)
        elif node_type == 'CheckpointLoaderSimple':
            if widgets:
                models.append({
                    'node_type': 'CheckpointLoader',
                    'model_name': widgets[0],
                })
    
    return {
        'filename': workflow_path.name,
        'models': models,
    }


def main():
    """Main analysis function."""
    print("=" * 80)
    print("Official Workflow Model Analysis")
    print("=" * 80)
    
    workflow_files = list(WORKFLOW_DIR.glob("*.json"))
    print(f"\nFound {len(workflow_files)} workflow files\n")
    
    all_models = defaultdict(list)
    workflow_results = []
    
    for wf_file in sorted(workflow_files):
        result = analyze_workflow(wf_file)
        if result and result['models']:
            workflow_results.append(result)
            
            for model in result['models']:
                model_name = model.get('model_name', 'Unknown')
                if model_name:
                    all_models[model_name].append({
                        'workflow': result['filename'],
                        'node_type': model['node_type'],
                    })
    
    # Print results
    print("=" * 80)
    print("Model Usage Summary")
    print("=" * 80)
    
    for model_name, usages in sorted(all_models.items()):
        print(f"\n📦 {model_name}")
        print(f"   Used in {len(usages)} workflow(s):")
        for usage in usages:
            print(f"   - {usage['workflow']} ({usage['node_type']})")
    
    print("\n" + "=" * 80)
    print(f"Total unique models: {len(all_models)}")
    print(f"Workflows with models: {len(workflow_results)}")
    print("=" * 80)
    
    # Generate TSV update suggestions
    print("\n\nTSV Update Suggestions:")
    print("=" * 80)
    print("# Add these models to presets/model_keywords.tsv")
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
            if 'UNET' in node_type or 'Checkpoint' in node_type:
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
        keywords = normalized.split('-')[:5]
        keywords_str = '|'.join(keywords)
        
        # Generate tags
        tags = list(categories) + ['official-workflow']
        tags_str = '|'.join(tags)
        
        description = f"{display_name} (from official workflows)"
        
        # Priority based on usage count
        priority = min(100, 70 + len(usages) * 5)
        
        print(f"{normalized}\t{category}\t{keywords_str}\t{display_name}\t{description}\t{tags_str}\t{priority}")


if __name__ == "__main__":
    main()
