import argparse
import json
import sys
sys.dont_write_bytecode = True
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from modeling_scene import load_scene, render_views, sha256, write_json

p = argparse.ArgumentParser()
p.add_argument('--source', required=True)
p.add_argument('--directory', required=True)
p.add_argument('--report', required=True)
p.add_argument('--views', default='front,side,back,top,perspective')
p.add_argument('--manifest')
a = p.parse_args(sys.argv[sys.argv.index('--') + 1:])
load_scene(a.source)
manifest = json.loads(Path(a.manifest).read_text(encoding='utf-8-sig')) if a.manifest else None
views = render_views(a.directory, a.views.split(','), manifest)
write_json(a.report, {'protocol': 2, 'sourceHash': sha256(a.source), 'views': views})
