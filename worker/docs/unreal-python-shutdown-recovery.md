# Unreal Python batch shutdown recovery

The retained UE 5.8.2 scene import logged saved maps, `QUIT_EDITOR`, and
`Editor shut down`, then an `EditorModeToolsSingleton.IsValid()` ensure followed
by `Object is not packaged: ModeManagerInteractiveToolsContext None`. This is
a full-editor shutdown failure; it does not identify an uncooked game asset.
Keep the failed command and independently validate any saved outputs.

Use the repository launcher for batch imports, material edits and map inspection:

```powershell
node worker/tools/unreal-python.mjs --unreal D:/UE/UE_5.8/Engine/Binaries/Win64/UnrealEditor-Cmd.exe --project D:/task/project/Game.uproject --script worker/import.py --output logs/import-repair-1 --plugin GeometryScripting
```

The script and output directory are relative to the project. Each invocation
requires a new output directory and retains request, engine/stdout/stderr logs
and result. Nonzero exit, timeout, cancellation, unconfirmed shutdown, missing
engine log, Python errors, fatal errors and editor ensures fail the command.
Output validation remains separate from successful process execution.

Explicitly load the required map with `LevelEditorSubsystem.load_level()` in
the batch script and return normally. Do not call `SystemLibrary.quit_editor()`.
Preserve older scripts and write a corrected successor when reusing them.
Avoid rerunning an import that already changed the project merely to test exit;
use a read-only inspection or a disposable import fixture first.

`StaticMeshEditorSubsystem` may be absent from the commandlet subsystem
collection. Its batch mesh functions use the same fallback as the host validator:

```python
mesh_tools = (unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem)
              or unreal.get_default_object(unreal.StaticMeshEditorSubsystem))
```

This is specific to these batch mesh functions; it does not initialize
UI-dependent subsystems.

The launcher uses `-run=pythonscript -script=... -NullRHI`. `--rendering` replaces
NullRHI with `-AllowCommandletRendering` when an operation needs rendering. It
does not create the interactive editor lifecycle needed for PIE, Slate or
viewport capture, and never falls back to `-ExecutePythonScript` automatically.

See Epic's [Python scripting documentation](https://dev.epicgames.com/documentation/en-us/unreal-engine/scripting-the-unreal-editor-using-python)
for the full-editor and commandlet execution modes.

Before deploying this launcher/prompt change, migrate the retained workspace's
toolchain through `plan`, `stage`, `apply`, and `resume-check`. Preserve its
checkpoints, historical pins, journals and consumed budgets. Run the Windows
commandlet probe, then the autostart registration and monitor checks. No new
production iteration is needed to validate this repair.
