# Sandbox-owned onebox control plane

The sandbox is the authority for a game-production goal. The host submits a frozen preflight input and reads a status projection; it does not own the goal state, task DAG, leases, acceptance, retry decision or completion decision.

## Boundary

```text
controller/tools/trigger-task.mjs
  -> control/inbox/<hostTaskId>.json
  -> sandbox controller
  -> goals/<goalId>/{input,plan,state,events}
  -> sandbox executor lease
  -> output/evidence.json
  -> sandbox acceptance evaluator
  -> public/tasks/<hostTaskId>.json
```

The inbox and public projection can be placed on a shared mount for the first integration. They are transport surfaces only. The authoritative files are inside the sandbox control root and must remain available when the host is offline.

## Preflight input

The host input is the result of the user-facing planning phase. It must contain:

- the core gameplay contract;
- scene structure and greybox constraints;
- visual style and quality bar;
- global acceptance criteria;
- expected outputs;
- optional bounded task overrides.

The sandbox freezes this input into a revision and compiles the task DAG. A changed input creates a new goal revision; it never mutates an active goal.

## Autonomous acceptance

Every executor must write `output/evidence.json`. The evaluator checks exact criterion coverage, safe relative paths, file existence and SHA-256 hashes. Process exit, a screenshot, or a model statement is not acceptance. The sandbox then performs task acceptance and global acceptance without a host review request.

Missing or inconsistent evidence yields `HOLD`/`NEEDS_REPLAN`, with the reason persisted in the goal event log. It never becomes a successful task by timeout or exit code.

## Host correlation

The host-generated `hostTaskId` is immutable. The sandbox assigns `goalId` and mirrors both IDs in `public/tasks/<hostTaskId>.json`. The host can therefore create a task and later query its remote state without owning or reconstructing the remote scheduler state.

## Executor contract

The next adapter must receive `{ goal, plan, task, taskDirectory }` and return only after it has either written `output/evidence.json` or recorded an explicit execution failure. It may launch Codex, Unreal, Blender or other tools inside the sandbox. It must not change the goal state or call host commands; only the controller may advance the DAG.
