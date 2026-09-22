---
name: yahaha-blender-unreal-handoff
description: Prepare declared Blender meshes, materials, collisions, LODs and rigs for measured Unreal import validation. Use when the asset contract targets Unreal.
---

# Unreal asset handoff

Read `contract.runtime`. Keep the editable source and GLB for DCC review. A `glb-static`
profile uses GLB as its import file. `fbx-static`/`fbx-skeletal` additionally require `model.fbx`.
Export in meter units with unit conversion enabled; never compensate scale in both Blender
and Unreal. The host measures the actual imported dimensions in centimeters. Canonical
Blender modeling axes are front -Y, Z up. Use an asymmetric model to verify orientation.

Name render meshes `SM_*`, skeletal meshes `SK_*`. Name convex collision proxies
`UCX_<render-name>_00`; socket helpers `SOCKET_<render-name>_00`. Record logical socket names
in the contract and ensure the importer produces those names. Declare every mesh's role
in `asset-manifest.json`. LOD meshes share origin and bounds; export their exact files or
groups according to the verified importer profile. A decorative mesh may explicitly need
no collision or LOD; do not fabricate requirements.

Each entry in `runtime.lodTriangles` requires an ADDITIONAL LOD even when LOD0 is already
below that budget: entry 0 means LOD1. Keep those meshes in the saved source and declare
`role: "lod", lod: 1` (then 2, etc.) in the manifest. Export them separately from LOD0.

For textured materials validate Base Color, normal map convention, roughness, metallic and
AO separately. Do not assume an imported FBX wires every PBR channel, and do not pass a
Unity smoothness MaskMap to Unreal without mapping roughness correctly.

In the DCC author stage, create files only; the production integration stage imports them
into the project's `/Game/` namespace. Integration writes `plan/modeling-engine-imports.json`:

```json
{"protocol":2,"assets":[{"assetId":"example","packagePath":"/Game/Models/SM_Example.SM_Example","mapPath":"/Game/Maps/AssetTest"}]}
```

The host independently loads each object and checks actual dimensions, geometry, materials,
collision, LODs and required sockets/animations. Required animation evidence must reference
actual imported animation assets in the entry's `animations` mapping (logical name to object
path). The asset must be placed visibly in mapPath; host screenshots and image review finish
the engine handoff. Source changes return through the host's modeling revision request.
Export success means DCC readiness; only host checks can establish engine readiness.

Practices adapted from the pinned MIT Unreal/LOD/collision/QA sources in `upstream/`. Validate
profile behavior on the installed Blender and UE versions; archive instructions are not a
substitute for the measured import.
