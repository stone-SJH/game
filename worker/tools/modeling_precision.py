"""Numerical error allowance, separate from the authored engineering tolerance.

float32 mesh coordinates cross Blender meters and Unreal centimeters. Eight
roundings (bounds min/max, extent, unit conversion) give a conservative gamma(8)
bound. This never changes integer/topology/identity or visual acceptance gates.
"""
import math

PROFILE = 'float32-bounds-cm-m-v1'
EPSILON = 2.0 ** -23


def numerical_error(values, extent=0.0):
    scale = max([abs(float(v)) for v in values] + [abs(float(extent)), 0.01])
    return scale * (8 * EPSILON / (1 - 8 * EPSILON))


def measurement(actual, expected, engineering_tolerance, extent=0.0):
    values = list(actual) + list(expected)
    valid = (len(actual) == len(expected) and math.isfinite(engineering_tolerance)
             and engineering_tolerance >= 0 and all(math.isfinite(v) for v in values))
    error = numerical_error(values, extent) if valid else 0
    return {'passed': valid and all(abs(a-b) <= engineering_tolerance + error for a, b in zip(actual, expected)),
            'engineeringTolerance': engineering_tolerance, 'numericalError': error,
            'effectiveTolerance': engineering_tolerance + error, 'profile': PROFILE}
