---
name: Pinned pnpm in Replit
description: Work around a mismatch between the workspace-pinned pnpm and the system pnpm used by managed workflows.
---

When a workspace pins pnpm in `packageManager` but Replit's system `pnpm` is a different major version, managed workflow commands that invoke bare `pnpm` can repeatedly attempt a package-manager self-install and abort. Use `corepack pnpm` to install and run commands at the pinned version. If a managed workflow must invoke bare `pnpm`, set `manage-package-manager-versions=false` in the user-level pnpm config so the system binary stops recursively switching.

**Why:** In this workspace, the managed API workflow repeatedly aborted while trying to install the pinned pnpm, even though the pinned version worked through Corepack.

**How to apply:** Check the root `packageManager` field and `pnpm --version` before reinstalling or restarting. Prefer Corepack for direct commands; use the user-level setting only when the managed workflow's configured command cannot be changed.
