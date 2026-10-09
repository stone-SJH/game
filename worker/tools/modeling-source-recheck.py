"""Read-only source gate probe. Never changes the source or declares engine acceptance."""
import argparse
import json
import sys
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))
from modeling_scene import load_scene, sha256, write_json
from modeling_quality import check_scene

parser = argparse.ArgumentParser()
parser.add_argument('--directory', required=True)
parser.add_argument('--spec', required=True)
parser.add_argument('--traversal-plan')
parser.add_argument('--report', required=True)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
read = lambda file: json.loads(Path(file).read_text(encoding='utf-8-sig'))
directory = Path(args.directory).resolve()
source = directory / 'source.blend'
manifest_file = directory / 'asset-manifest.json'
before = sha256(source)
spec, manifest = read(args.spec), read(manifest_file)
record = read(args.traversal_plan) if args.traversal_plan else None
if record and (record['input']['sourceHash'] != before or record['input']['manifestHash'] != sha256(manifest_file)):
    raise ValueError('Reviewed traversal plan must identify the exact retained source and manifest')
load_scene(source)
result = check_scene(spec, manifest, traversal_plan=record)
assert sha256(source) == before
write_json(args.report, {'sourceHash': before, 'originalSourceUnchanged': True, 'source': result,
                        'scope': 'Source gates only; exports, visual review, engine integration and packaging remain separate.'})
print(json.dumps({'passed': result['passed'], 'gaps': [gate for gate in result['gates'] if gate['status'] == 'GAP'],
                  'originalSourceUnchanged': True})[:5000])
