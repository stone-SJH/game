import { isDeepStrictEqual } from 'node:util';

const obj = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const en = values => ({ type: 'string', enum: values });
const number = { type: 'number', minimum: 0, maximum: 1000000 };
const maybe = schema => ({ anyOf: [schema, { type: 'null' }] });
const list = (items, maxItems = 32) => ({ type: 'array', items, maxItems });
const name = { type: 'string', minLength: 1, maxLength: 160 };
const vector = { ...list({ type: 'number', minimum: -1000000, maximum: 1000000 }, 3), minItems: 3 };

export const traversalSchema = obj({
  version: { type: 'integer', enum: [1] }, space: en(['asset-local-meters']),
  capsule: obj({ radiusMeters: { type: 'number', exclusiveMinimum: 0, minimum: 0.000001, maximum: 1000 },
    halfHeightMeters: { type: 'number', minimum: 0.000001, maximum: 1000 }, axis: en(['Z']) }),
  marginMeters: { type: 'number', minimum: 0, maximum: 1 },
  paths: { ...list(obj({ id: name, startMeters: vector, endMeters: vector }), 32), minItems: 1 },
  ueQuery: obj({ channel: en(['Visibility']), traceComplex: { type: 'boolean', enum: [false] } }),
});

export const contractSchema = obj({
  version: { type: 'integer', enum: [2] },
  assetClass: en(['static-prop', 'modular-kit', 'organic-static', 'skeletal-character']),
  styleProfile: en(['general', 'hard-surface', 'lowpoly']),
  dimensions: obj({ meters: maybe(vector), toleranceMeters: number }),
  pivot: obj({ mode: en(['unknown', 'base-center', 'center', 'custom']), meters: maybe(vector), toleranceMeters: number }),
  budgets: obj({ materials: { type: 'integer', minimum: 1, maximum: 128 }, maxTextureSize: { type: 'integer', minimum: 1, maximum: 16384 },
    textureBytes: { type: 'integer', minimum: 1, maximum: 2147483648 } }),
  runtime: obj({ engine: en(['none', 'unreal']), profile: en(['glb-static', 'fbx-static', 'fbx-skeletal']),
    collision: en(['none', 'convex']), lodTriangles: list({ type: 'integer', minimum: 4, maximum: 2000000 }, 8),
    sockets: list(name), animations: list(name), lightmapUV: { type: 'boolean' } }),
  referenceMatches: list(obj({ image: { ...name, maxLength: 1000 }, mask: { ...name, maxLength: 1000 },
    view: en(['front', 'side', 'back', 'top', 'perspective', 'other-side', 'bottom']),
    minIoU: { type: 'number', minimum: 0.1, maximum: 1 }, maxAspectError: { type: 'number', minimum: 0, maximum: 1 } }), 4),
  asymmetric: { type: 'boolean' },
});
// Existing frozen v2 contracts omit traversal; generation always emits the nullable key.
contractSchema.properties.traversal = maybe(traversalSchema);
export const generatedContractSchema = { ...contractSchema, required: [...contractSchema.required, 'traversal'] };

export function defaultContract(overrides = {}) {
  return { version: 2, assetClass: 'static-prop', styleProfile: 'general',
    dimensions: { meters: null, toleranceMeters: 0.005 }, pivot: { mode: 'unknown', meters: null, toleranceMeters: 0.005 },
    budgets: { materials: 8, maxTextureSize: 2048, textureBytes: 67108864 },
    runtime: { engine: 'none', profile: 'glb-static', collision: 'none', lodTriangles: [], sockets: [], animations: [], lightmapUV: false },
    referenceMatches: [], asymmetric: false, ...overrides };
}

export function validateContractSemantics(spec) {
  const c = spec.contract;
  if (!c) return;
  const traversal = c.traversal;
  if (Object.hasOwn(c, 'traversal') && !traversal && /\btraversable\b|\btraversal\b|(?:角色|玩家).{0,12}通行/i.test([spec.description, ...(spec.requirements || [])].join('\n'))) {
    throw Object.assign(new Error('CONTRACT_INCOMPLETE: traversability requires explicit capsule dimensions and paths; do not invent defaults.'), { kind: 'CONTRACT_INCOMPLETE', hardFailure: true });
  }
  if (traversal) {
    if (c.runtime.collision !== 'convex' || c.runtime.profile !== 'fbx-static') throw new Error('Traversal requires the calibrated static FBX convex-collision profile.');
    if (traversal.capsule.halfHeightMeters < traversal.capsule.radiusMeters) throw new Error('Capsule half-height includes its hemispheres and cannot be smaller than the radius.');
    if (new Set(traversal.paths.map(p => p.id)).size !== traversal.paths.length) throw new Error('Duplicate traversal path id.');
    if (traversal.paths.some(p => p.startMeters.every((v,i) => v === p.endMeters[i]))) throw new Error('Traversal requires a nonzero sweep path.');
  }
  if (c.dimensions.meters?.some(n => n <= 0)) throw new Error('Measured dimensions must be positive.');
  if (c.pivot.mode === 'custom' && !c.pivot.meters) throw new Error('Custom pivot requires a position.');
  if (c.runtime.profile === 'fbx-skeletal' && !spec.requireRig) throw new Error('Skeletal export requires a rig.');
  if (c.assetClass === 'skeletal-character' && !spec.requireRig) throw new Error('Skeletal character requires measured rig binding.');
  if (c.runtime.profile === 'glb-static' && (spec.requireRig || c.runtime.collision !== 'none' || c.runtime.lodTriangles.length || c.runtime.sockets.length)) throw new Error('Static GLB profile cannot promise rig/collision/LOD/socket handoff; select the corresponding FBX profile.');
  if (c.runtime.animations.length && !spec.requireRig) throw new Error('Animation requirements need a rig.');
  if (c.runtime.lodTriangles.some((n, i, a) => n >= (i ? a[i - 1] : spec.maxTriangles))) throw new Error('LOD budgets must decrease from LOD0.');
  if (new Set(c.runtime.sockets).size !== c.runtime.sockets.length || new Set(c.runtime.animations).size !== c.runtime.animations.length) throw new Error('Duplicate runtime requirement.');
  for (const match of c.referenceMatches) {
    if (!spec.referenceImages.includes(match.image)) throw new Error('Reference match must name a supplied reference.');
    if (match.view === 'perspective') throw new Error('Exact reference matching requires a registered orthographic view.');
  }
}

// A revision may add textual requirements, but must never silently alter its technical contract.
// A changed technical target is a new asset/revision contract accepted by the host, not an author repair.
export function preservesContract(original, revised) {
  return !original.contract || isDeepStrictEqual(original.contract, revised.contract);
}

export function modelViews(spec) {
  return spec.contract ? ['front', 'side', 'back', 'top', 'perspective', ...(spec.contract.assetClass === 'organic-static' ? ['lower-oblique'] : []), ...(spec.contract.asymmetric ? ['other-side', 'bottom'] : [])] : ['front', 'side', 'back', 'perspective'];
}

export function referenceFiles(spec) {
  return [...new Set([...spec.referenceImages, ...(spec.contract?.referenceMatches || []).map(m => m.mask)])];
}
