"""Continuous vertical-capsule sweeps against convex UCX geometry, in meter coordinates.

The swept capsule is the convex hull of four axis endpoints plus a radius sphere.
GJK computes distance from that polytope to each collider. Both upper and lower
distance bounds are retained; uncertain convergence never grants passage.
This module has no Blender dependency so geometric counterexamples run directly.
"""
import itertools
import math

def dot(a, b):
    return sum(x*y for x,y in zip(a,b))

def sub(a, b):
    return tuple(x-y for x,y in zip(a,b))

def solve(matrix, vector):
    """Small pivoted Gaussian elimination; singular affine subsets are skipped."""
    rows = [list(row)+[v] for row,v in zip(matrix,vector)]
    n = len(rows)
    for column in range(n):
        pivot = max(range(column,n), key=lambda r: abs(rows[r][column]))
        if abs(rows[pivot][column]) < 1e-14:
            return None
        rows[column], rows[pivot] = rows[pivot], rows[column]
        divisor = rows[column][column]
        rows[column] = [v/divisor for v in rows[column]]
        for r in range(n):
            if r != column:
                factor = rows[r][column]
                rows[r] = [v-factor*w for v,w in zip(rows[r], rows[column])]
    return [row[-1] for row in rows]

def closest(simplex):
    best = None
    for count in range(1,min(4,len(simplex))+1):
        for indices in itertools.combinations(range(len(simplex)),count):
            points = [simplex[i] for i in indices]
            matrix = [[dot(a,b) for b in points]+[1.0] for a in points]
            matrix.append([1.0]*count+[0.0])
            answer = solve(matrix,[0.0]*count+[1.0])
            if answer is None or any(v < -1e-9 for v in answer[:count]):
                continue
            weights = [max(0,v) for v in answer[:count]]
            total = sum(weights)
            point = tuple(sum(w*p[axis] for w,p in zip(weights,points))/total for axis in range(3))
            distance2 = dot(point,point)
            if best is None or distance2 < best[0]:
                best = (distance2,point,[p for p,w in zip(points,weights) if w > 1e-10])
    if best is None:
        raise ValueError('Degenerate distance simplex')
    return best[1],best[2]

def convex_distance(left, right, max_iterations=64, tolerance=1e-8):
    if not left or not right or any(len(p)!=3 or not all(math.isfinite(v) for v in p) for p in [*left,*right]):
        raise ValueError('Convex distance requires finite 3D vertices')
    def support(direction):
        return sub(max(left,key=lambda p:dot(p,direction)),min(right,key=lambda p:dot(p,direction)))
    simplex = [support((1,0,0))]
    lower,upper = 0.0,math.inf
    for iteration in range(max_iterations):
        point,simplex = closest(simplex)
        upper = math.sqrt(dot(point,point))
        if upper <= tolerance:
            return {'converged': True, 'lower': 0.0, 'upper': upper, 'iterations': iteration+1}
        other = support(tuple(-v for v in point))
        lower = max(0.0,dot(point,other)/upper)
        if upper-lower <= tolerance:
            return {'converged': True, 'lower': lower, 'upper': upper, 'iterations': iteration+1}
        if any(sum((a-b)**2 for a,b in zip(other,p)) <= 1e-24 for p in simplex):
            break
        simplex.append(other)
    return {'converged': False, 'lower': lower, 'upper': upper, 'iterations': max_iterations}

def sweep_capsule(start, end, radius, half_height, collider, margin=0.0, max_iterations=64):
    if not (math.isfinite(radius) and math.isfinite(half_height) and math.isfinite(margin) and radius > 0 and half_height >= radius and margin >= 0):
        raise ValueError('Invalid capsule dimensions or margin')
    half_axis = half_height-radius
    axis_points = [tuple(point[i]+(offset if i==2 else 0) for i in range(3)) for point in [start,end] for offset in [-half_axis,half_axis]]
    distance = convex_distance(axis_points,collider,max_iterations=max_iterations)
    clearance = distance['lower']-radius
    # Touching the margin boundary is conservatively GAP in both DCC and UE.
    return {**distance,'minimumClearanceMeters': clearance,
            'passed': distance['converged'] and clearance > margin+1e-7}

def check_traversal(traversal, colliders):
    if not traversal:
        return {'status': 'NOT_REQUESTED', 'paths': []}
    if not colliders:
        return {'status': 'GAP', 'reason': 'Missing convex collision evidence', 'paths': []}
    rows = []
    for route in traversal['paths']:
        for name,vertices in colliders:
            result = sweep_capsule(route['startMeters'],route['endMeters'],traversal['capsule']['radiusMeters'],
                                   traversal['capsule']['halfHeightMeters'],vertices,traversal['marginMeters'])
            rows.append({'pathId':route['id'],'collider':name,**result})
    return {'status': 'PASS' if rows and all(r['passed'] for r in rows) else 'GAP', 'paths': rows}
