import json, glob, os
path = r"D:\AI\MOD\user\default\workflows\GJJ_ViDEO\*.json"
for f in sorted(glob.glob(path)):
    name = os.path.basename(f)
    print(f"--- {name} ---")
    try:
        data = json.load(open(f, encoding="utf-8"))
        types = set(n.get("type", "") for n in data.get("nodes", []))
        for t in sorted(types):
            print(f"  {t}")
    except Exception as e:
        print(f"  ERROR: {e}")
