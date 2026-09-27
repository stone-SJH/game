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
    collision: en(['none', 'convex']), lodTriangles: { ...list({ type: 'integer', minimum: 4, maximum: 2000000 }, 8),
      description: 'LOD1 and later triangle limits only. LOD0 is maxTriangles; exclude it here. Each entry must be strictly smaller than the preceding limit. Example: maxTriangles=1000, lodTriangles=[500,250].' },
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

export function contractIssues(spec, { allowIncompleteTraversal = false } = {}) {
  const c = spec.contract;
  if (!c) return [];
  const issues = [];
  const issue = (field, message, kind = 'CONTRACT_INVALID') => issues.push({ assetId: spec.assetId, field, message, kind });
  const traversal = c.traversal;
  // A traversal ability/visual prop is not a static player passage. Engineering separately
  // classifies room shells, doorways and paths; a bare mention of "traversal" is not geometry.
  if (!allowIncompleteTraversal && Object.hasOwn(c, 'traversal') && !traversal && /\btraversable\b|\b(?:player|capsule)\s+(?:passage|clearance|sweep)\b|(?:角色|玩家).{0,12}通行/i.test([spec.description, ...(spec.requirements || [])].join('\n'))) {
    issue('contract.traversal', 'CONTRACT_INCOMPLETE: traversability requires explicit capsule dimensions and paths; do not invent defaults.', 'CONTRACT_INCOMPLETE');
  }
  if (traversal) {
    if (c.runtime.collision !== 'convex') issue('contract.runtime.collision', 'Traversal requires the calibrated static FBX convex-collision profile.');
    if (c.runtime.profile !== 'fbx-static') issue('contract.runtime.profile', 'Traversal requires the calibrated static FBX convex-collision profile.');
    if (traversal.capsule.halfHeightMeters < traversal.capsule.radiusMeters) issue('contract.traversal.capsule.halfHeightMeters', 'Capsule half-height includes its hemispheres and cannot be smaller than the radius.');
    if (new Set(traversal.paths.map(p => p.id)).size !== traversal.paths.length) issue('contract.traversal.paths', 'Duplicate traversal path id.');
    if (traversal.paths.some(p => p.startMeters.every((v,i) => v === p.endMeters[i]))) issue('contract.traversal.paths', 'Traversal requires a nonzero sweep path.');
  }
  c.dimensions.meters?.forEach((n, i) => { if (n <= 0) issue(`contract.dimensions.meters[${i}]`, 'Measured dimensions must be positive.'); });
  if (c.pivot.mode === 'custom' && !c.pivot.meters) issue('contract.pivot', 'Custom pivot requires a position.');
  if (c.runtime.profile === 'fbx-skeletal' && !spec.requireRig) issue('contract.runtime.profile', 'Skeletal export requires a rig.');
  if (c.assetClass === 'skeletal-character' && !spec.requireRig) issue('contract.assetClass', 'Skeletal character requires measured rig binding.');
  if (c.runtime.profile === 'glb-static' && (spec.requireRig || c.runtime.collision !== 'none' || c.runtime.lodTriangles.length || c.runtime.sockets.length)) issue('contract.runtime.profile', 'Static GLB profile cannot promise rig/collision/LOD/socket handoff; select the corresponding FBX profile. Preserve collision, LOD, socket and rig requirements.');
  if (c.runtime.animations.length && !spec.requireRig) issue('contract.runtime.animations', 'Animation requirements need a rig.');
  c.runtime.lodTriangles.forEach((n, i, a) => {
    const previous = i ? a[i - 1] : spec.maxTriangles;
    if (n >= previous) issue(`contract.runtime.lodTriangles[${i}]`, `LOD budgets must decrease from LOD0. LOD${i + 1}=${n} must be < ${previous}; maxTriangles=${spec.maxTriangles} already specifies LOD0. lodTriangles contains LOD1 and later only.`);
  });
  for (const key of ['sockets', 'animations']) {
    if (new Set(c.runtime[key]).size !== c.runtime[key].length) issue(`contract.runtime.${key}`, 'Duplicate runtime requirement; retain every unique required name.');
  }
  for (const match of c.referenceMatches) {
    if (!spec.referenceImages.includes(match.image)) issue('contract.referenceMatches', 'Reference match must name a supplied reference.');
    if (match.view === 'perspective') issue('contract.referenceMatches', 'Exact reference matching requires a registered orthographic view.');
  }
  return issues;
}

export function validateContractSemantics(spec) {
  const issues = contractIssues(spec);
  if (!issues.length) return;
  const error = Object.assign(new Error(issues.map(item => `${item.assetId}.${item.field}: ${item.message}`).join('\n')), { validationIssues: issues });
  if (issues[0].kind === 'CONTRACT_INCOMPLETE') Object.assign(error, { kind: 'CONTRACT_INCOMPLETE', hardFailure: true });
  throw error;
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
