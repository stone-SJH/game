import argparse
import sys
sys.dont_write_bytecode = True
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from modeling_reference import compare
from modeling_scene import write_json
p = argparse.ArgumentParser()
p.add_argument('--reference', required=True)
p.add_argument('--rendered', required=True)
p.add_argument('--min-iou', type=float, required=True)
p.add_argument('--max-aspect-error', type=float, required=True)
p.add_argument('--report', required=True)
a = p.parse_args(sys.argv[sys.argv.index('--')+1:])
write_json(a.report, compare(a.reference,a.rendered,a.min_iou,a.max_aspect_error))
