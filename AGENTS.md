# Codex Engineering Harness

This is the repository-wide instruction for Codex changes. The objective is to keep changes made
on cloud deployment machines small, reviewable and verifiable before they are committed.

## Identify the machine role

At the start of a task, identify the execution role from the operator context, host configuration
and deployment paths. Use `CODEX_MACHINE_ROLE` when it is set:

- `controller`: Linux ECS controller machine. The deployed worktree is normally
  `~/workspace/game`; the service uses `/opt/yahahagame-controller`.
- `worker`: Windows GPU worker machine. The deployed worktree is normally
  `$HOME\workspace\game`; the worker uses the configured `YAHAHAGAME_WORKER_ROOT`.
- `dev`: a local development environment that is not one of the two deployment machines.

Do not silently assume a role when the deployment context is ambiguous. Inspect the host and
active service markers, or ask for the role before making a code change.

## Cloud change boundary

These are mandatory defaults for code changes on the two cloud roles:

- On `controller`, code changes must be limited to `app/` and `controller/`.
- On `worker`, code changes must be limited to `worker/` and `skills/`.

The boundary applies to both tracked and newly created code files. It includes tests, deployment
scripts and build-related code beneath the allowed directories. Do not edit the installed release
under `/opt/yahahagame-controller` or the worker release directory as a substitute for editing
the Git worktree. Keep secrets and machine-specific runtime configuration outside the repository.

Documentation changes are exempt from this path boundary. Documentation means Markdown and other
clearly identified runbooks or explanatory files; a change that mixes documentation and code must
still obey the code boundary. The boundary does not apply on a `dev` machine.

## Exceptions

An exception is allowed only when an allowed code change cannot work without a change outside its
role boundary, such as a shared protocol, schema, package lockfile or generated interface. Before
making the exception:

1. Explain why the dependency cannot be isolated inside the allowed directory.
2. Keep the outside change to the smallest required surface and do not include unrelated cleanup.
3. Run verification for both the changed component and the affected interface.
4. Record the exception and its verification in the final response and commit message.

Never use an exception to include unverified experiments, temporary output, credentials, runtime
state, large generated artifacts or unrelated refactors in a cloud commit.

## Commit gate

Before committing on a cloud role, inspect the staged paths:

```bash
git diff --cached --name-status
git diff --cached --check
```

On `controller`, every staged non-documentation path must begin with `app/` or `controller/`.
On `worker`, every staged non-documentation path must begin with `worker/` or `skills/`. If a path
falls outside the boundary, stop and either remove it from the commit or apply the documented
exception process. Do not weaken the rule by adding broad ignores or staging the whole worktree.

## Verification gate

Run focused checks for the changed code before committing. Controller changes normally require
`npm --prefix controller run test:unit` plus relevant integration tests or a deployment dry-run.
Worker and skill changes require syntax checks and the relevant worker or production-harness
probe; repeat the check on Windows when the change depends on Windows process, path or tool
behavior. Report skipped checks and their reason. A clean path check does not replace behavior
verification.

When deploying, use the repository-owned Git deployment scripts and record the exact commit. Do
not create or upload a tar release from a cloud role. Preserve active tasks, allocations, worker
journals and artifacts unless the task explicitly authorizes a tested migration.
