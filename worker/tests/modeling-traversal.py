"""Analytic counterexamples for the continuous swept-capsule distance gate."""
import itertools
import math
import sys
import unittest
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from modeling_traversal import convex_distance, sweep_capsule

def box(center, size):
    return [tuple(c+s*t*.5 for c,s,t in zip(center,size,signs)) for signs in itertools.product([-1,1],repeat=3)]

class TraversalTests(unittest.TestCase):
    def test_known_convex_distances(self):
        for gap in [0,.0001,.2,1,20]:
            distance = convex_distance(box((0,0,0),(1,1,1)),box((1+gap,0,0),(1,1,1)))
            self.assertTrue(distance['converged'])
            self.assertAlmostEqual(distance['upper'],gap,places=7)
            self.assertAlmostEqual(distance['lower'],gap,places=7)

    def sweep(self, collider, **options):
        return sweep_capsule((0,-1,.97),(0,1,.97),.42,.96,collider,.005,**options)

    def test_open_door_and_blockers(self):
        self.assertTrue(self.sweep(box((-1,0,1.2),(.4,.4,2.4)))['passed'])
        self.assertTrue(self.sweep(box((1,0,1.2),(.4,.4,2.4)))['passed'])
        self.assertTrue(self.sweep(box((0,0,2.6),(2.4,.4,.4)))['passed'])
        for center,size in [((0,0,1),(1,.01,2)),((0,-1,.97),(.1,.1,.1)),((.45,0,1),(.1,.1,1))]:
            self.assertFalse(self.sweep(box(center,size))['passed'])

    def test_clearance_boundary_and_corner_distance(self):
        for face,passed in [(.4249,False),(.4251,True)]:
            self.assertEqual(self.sweep(box((face+.05,0,1),(.1,.1,2)))['passed'],passed)
        # Corner gap sqrt(.31^2+.31^2) exceeds radius+.005; plane inflation would reject it incorrectly.
        result = sweep_capsule((0,-1,0),(0,0,0),.42,.42,box((.36,.36,0),(.1,.1,1)),.005)
        self.assertTrue(result['passed'])
        self.assertAlmostEqual(result['minimumClearanceMeters'],math.sqrt(2*.31**2)-.42,places=6)

    def test_thin_obstacle_between_discrete_samples(self):
        self.assertFalse(self.sweep(box((0,.123456,.97),(.2,.00001,.2)))['passed'])

    def test_no_convergence_and_invalid_geometry_never_pass(self):
        self.assertFalse(self.sweep(box((2,0,1),(1,1,1)),max_iterations=0)['passed'])
        with self.assertRaises(ValueError): self.sweep([(math.nan,0,0)])

    def test_translated_and_rotated_geometry(self):
        original = box((1,0,1.2),(.4,.4,2.4))
        transform = lambda p: (-p[1]+10,p[0]-7,p[2]+3)
        result = sweep_capsule(transform((0,-1,.97)),transform((0,1,.97)),.42,.96,[transform(p) for p in original],.005)
        self.assertTrue(result['passed'])

if __name__ == '__main__': unittest.main()
