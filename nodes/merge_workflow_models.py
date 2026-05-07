# -*- coding: utf-8 -*-
"""Merge workflow analysis results into model_keywords.tsv."""
from pathlib import Path

TSV_FILE = Path(__file__).parent / "presets" / "model_keywords.tsv"
VIDEO_ANALYSIS = Path(__file__).parent / "video_workflow_analysis.txt"
OFFICIAL_ANALYSIS = Path(__file__).parent / "workflow_analysis.txt"

def extract_models_from_analysis(analysis_file):
    """Extract model entries from analysis file."""
    models = []
    if not analysis_file.exists():
        return models
    
    with open(analysis_file, 'r', encoding='utf-8-sig') as f:
        in_tsv_section = False
        for line in f:
            line = line.strip()
            
            # Detect TSV section
            if line.startswith('# Add these') or line.startswith('id\tcategory'):
                in_tsv_section = True
                continue
            
            if in_tsv_section and line and '\t' in line:
                parts = line.split('\t')
                if len(parts) >= 7:
                    models.append(line)
    
    return models


def main():
    """Merge analysis results into TSV."""
    print("=" * 80)
    print("Merging Workflow Analysis Results")
    print("=" * 80)
    
    # Load existing TSV
    existing_lines = []
    existing_ids = set()
    
    if TSV_FILE.exists():
        with open(TSV_FILE, 'r', encoding='utf-8-sig') as f:
            for line in f:
                existing_lines.append(line)
                if '\t' in line and not line.startswith('#'):
                    parts = line.split('\t')
                    if parts:
                        existing_ids.add(parts[0].lower())
    
    print(f"\nExisting models in TSV: {len(existing_ids)}")
    
    # Extract models from analyses
    video_models = extract_models_from_analysis(VIDEO_ANALYSIS)
    official_models = extract_models_from_analysis(OFFICIAL_ANALYSIS)
    
    print(f"Video workflow models: {len(video_models)}")
    print(f"Official workflow models: {len(official_models)}")
    
    # Merge new models
    added = 0
    skipped = 0
    
    all_new_models = video_models + official_models
    
    for line in all_new_models:
        parts = line.split('\t')
        if not parts:
            continue
        
        model_id = parts[0].lower()
        
        if model_id not in existing_ids:
            existing_lines.append(line + '\n')
            existing_ids.add(model_id)
            added += 1
        else:
            skipped += 1
    
    print(f"\nMerge results:")
    print(f"  Added: {added} new models")
    print(f"  Skipped: {skipped} duplicates")
    print(f"  Total: {len(existing_ids)} models")
    
    # Write back to TSV
    print(f"\nWriting to {TSV_FILE}...")
    with open(TSV_FILE, 'w', encoding='utf-8-sig', newline='') as f:
        f.writelines(existing_lines)
    
    print(f"\n✅ Done! Updated {TSV_FILE}")
    print(f"   Total models: {len(existing_ids)}")


if __name__ == "__main__":
    main()
