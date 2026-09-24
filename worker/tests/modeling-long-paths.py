"""Run in real Blender; exercise Python I/O beyond MAX_PATH without changing OS policy."""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import bpy
from modeling_scene import io_path, sha256, write_json, render_views

parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
root = Path(args.out).resolve()
root.mkdir(parents=True, exist_ok=False)
rows = []
for label, parent in [('short', root / 'short'), ('long', root / ('a' * 80) / ('b' * 80) / ('c' * 80)),
                      ('unicode', root / ('模型' * 35) / ('目录' * 35) / ('报告' * 35))]:
    file = parent / 'geometry-report.json'
    if label != 'short':
        assert len(str(file)) > 260
    write_json(file, {'source': {'passed': True}, 'path': str(file)})
    value = json.loads(io_path(file).read_text(encoding='utf-8'))
    assert value['source']['passed'] and value['path'] == str(file)
    assert sha256(file) == hashlib.sha256(io_path(file).read_bytes()).hexdigest()
    assert io_path(io_path(file)) == io_path(file)
    rows.append({'case': label, 'length': len(str(file)), 'passed': True})
if os.name == 'nt':
    assert str(io_path(r'\\server\share\folder\file.json')).startswith('\\\\?\\UNC\\server\\share\\')
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add()
views = render_views(root / ('render' * 15) / ('views' * 16) / ('long' * 20), ['front'], size=64)
assert len(views) == 1 and len(views[0]['file']) > 260
assert views[0]['sha256'] == sha256(views[0]['file'])
rows.append({'case': 'long-fixed-render', 'length': len(views[0]['file']), 'passed': True})
write_json(root / 'report.json', {'passed': True, 'rows': rows})
print(json.dumps({'passed': True, 'rows': rows}))
