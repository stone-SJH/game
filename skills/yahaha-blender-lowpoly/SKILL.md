---
name: yahaha-blender-lowpoly
description: Build budgeted flat-shaded low-poly game assets with a reproducible primitive recipe and palette material in the Yahaha Blender pipeline. Use only for explicitly selected lowpoly style.
---

# Low-poly recipes

Allocate the host's triangle budget across the major parts before modeling. Spend triangles
on the silhouette, with coarse round sections and mirrored repeated parts. Use flat shading
and palette contrast to keep parts readable from the game camera. The host's dimensions and
style requirements override sample object sizes and preset budgets.

The skill-plan gives a copied helper directory. Add it to `sys.path`, then import
`lpm_upstream as lpm` for `Palette`, `box`, `prism`, `lathe`, `sweep`, `plate`, transforms
and `finish`. `finish` reports an over-budget mesh; it does not enforce acceptance.
Use the host's technical checks for the actual budget and final output.

Do not call `export_unity`: its channel packing and naming target a different engine.
Use the local `export_asset` helper in `yahaha_lpm.py`, or normal Blender GLB/FBX export
with the selected runtime profile. Palette inputs store metallic and roughness in the
actual Blender shader; inspect GLB material results instead of forwarding Unity MaskMap.
Declare helper/collision/LOD objects in `asset-manifest.json`. Lowpoly does not imply a
closed mesh or a rig unless the specification requires them.

Keep a recipe with named dimensions, output `source.blend` during blockout, inspect the
host-provided five views, then repair and export final geometry. Preserve the recipe and
parameters for reproducibility. No external image/model generation call is part of this helper.

The unchanged MIT toolkit is pinned by `skills/modeling-upstream-lock.json`; its license is
in `upstream/lpm-LICENSE`. Local adaptation lives in `yahaha_lpm.py` so upgrades are reviewable.
