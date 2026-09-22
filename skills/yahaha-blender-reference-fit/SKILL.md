---
name: yahaha-blender-reference-fit
description: Fit a Blender game asset to supplied reference views, preserving part counts, silhouette, dimensions and UV coverage. Use when the host provides reference images or measured reference-match requirements.
---

# Reference fitting

Read the host's reference images and `contract.referenceMatches`. Distinguish orthographic
views from perspective concepts. Use reliable dimensions and landmarks; flag unseen structure
as an assumption. Do not reinterpret a texture sheet or wireframe as a shaded silhouette.

Build major contours and thickness before texture details. Compare front and side together;
changing depth to improve one view may break the other. Re-render after changes in the same
camera profile. The host supplies front/side/back/top and perspective images after blockout.
Use `blender_render_views` when another intermediate comparison would resolve a defect.

Measured silhouette checks use a supplied binary mask (white object, black background), the
registered orthographic view, and frozen minimum IoU/maximum aspect error. The host compares
cropped silhouettes at equal canvas size and measures aspect separately. This is a shape test,
not a test of physical scale or camera placement. Physical dimensions have independent gates.
Do not invent masks or relax thresholds to make the current output pass. When no comparable
mask exists, use independent visual review without claiming a numeric match.

For closed/extruded assets, check front, back and sidewalls. A front-facing decal alone does
not establish texture coverage. Inspect UVs per actual material, consistent texel scale, and
back/side material appearance; planar palette styles remain valid when explicitly requested.
Repair silhouette with geometry, UV placement with UVs, and material differences with materials.

This skill uses the same explicit save/reopen and output contract as yahaha-blender-modeling.
Reference measurement is performed by the host's `modeling-reference-check.py`; the author
does not write its passing report. Guidance is adapted from the pinned MIT reference-analysis
and closed-surface UV sources in `upstream/`; the local lifecycle and host budgets take precedence.
