# Skill Routing

Use one Unreal engine skill set and add only the disciplines needed by the current stage.

| Stage concern | Discipline | Unreal binding |
| --- | --- | --- |
| asset family, provenance, import | `create-game-assets` | project import validation |
| blockout, pacing, traversal | `level-design` | Blueprint/editor level work |
| input, rebinding, buffering | `input-systems` | `unreal-enhanced-input` |
| player, systems, components | engine-agnostic gameplay | `unreal-cpp-gameplay` or `unreal-blueprints` |
| enemy decisions, navigation | `game-ai` | `unreal-behavior-trees` |
| materials, dissolve, outlines | `shader-programming` | Unreal material/shader workflow |
| effects | `game-feel` | `unreal-niagara` and camera hooks |
| HUD, menus, safe area | `game-ui-ux` | Unreal UMG/Blueprint implementation |
| audio buses and adaptive layers | `audio-design` | Unreal audio system |
| save state | `save-systems` | Unreal serialization implementation |
| profiling and budgets | `performance-optimization` | Unreal profiler and packaging settings |
| final cook and package | none | `unreal-packaging` |

Load `create-game-assets` before producing a family of related assets so the art direction and
manifest are stable. Load `unreal-packaging` only after the default map, project settings, and
required content are accepted. Do not let a specialist skill silently change the stage plan;
return its outputs to the orchestrator.
