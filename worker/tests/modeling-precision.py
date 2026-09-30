import sys
import struct
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from modeling_precision import measurement

def f32(value):
    return struct.unpack('f', struct.pack('f', value))[0]

for size in [0.01, 1.0, 100.0, 112.3179]:
    actual = f32(f32(size) * 100) / 100
    assert measurement([actual], [size], 0)['passed'], (size, actual)
    assert not measurement([size * 1.01], [size], 0)['passed']
assert measurement([0.000000534], [0], 0, 5.0)['passed']
assert not measurement([0.01], [0], 0, 5.0)['passed']
assert not measurement([float('nan')], [0], 0)['passed']
assert not measurement([1], [1], -0.1)['passed']
print('PASS: cm/m float32 calibration at 1 cm, 1 m, 100 m; real dimension and pivot defects still fail')
