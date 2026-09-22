import argparse
import json
import sys
sys.dont_write_bytecode = True
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from modeling_scene import load_scene, inspect_scene, sha256, write_json

p = argparse.ArgumentParser()
p.add_argument('--source', required=True)
p.add_argument('--report', required=True)
p.add_argument('--objects', default='[]')
p.add_argument('--collection')
a = p.parse_args(sys.argv[sys.argv.index('--') + 1:])
load_scene(a.source)
report = inspect_scene()
selected = json.loads(a.objects)
if a.collection:
    import bpy
    collection = bpy.data.collections.get(a.collection)
    if collection is None:
        raise ValueError('Unknown collection')
    selected = [o.name for o in collection.all_objects if not selected or o.name in selected]
if selected or a.collection:
    report['objects'] = [o for o in report['objects'] if o['name'] in selected]
report['sourceHash'] = sha256(a.source)
write_json(a.report, report)
