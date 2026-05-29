# vibesync-tr3e: Environment Variables for vibesync.service

**Task:** Wire persistent per-project role-agent pool into live dispatch (vibesync-tr3e)

**Status:** Code changes committed. Operator must apply systemd environment changes.

---

## Required Environment Variables

The `vibesync.service` systemd unit must have the following environment variables set to enable the RoleAgentBootstrapper to provision persistent role agents on the local backend:

```ini
Environment="LETTA_LOCAL_BACKEND_DIR=/root/.letta/lc-local-backend"
Environment="LETTA_LOCAL_BACKEND_EXPERIMENTAL=1"
```

These environment variables are already present in `lettashim.service` and must be mirrored in `vibesync.service` so that:

1. The `RoleAgentBootstrapper` can validate that its `storageDir` input matches `process.env.LETTA_LOCAL_BACKEND_DIR` (contract assertion to prevent routing corruption)
2. The `@letta-ai/letta-code-sdk` subprocess spawned by the bootstrapper writes agent JSON files to the same directory the shim reads from

### Optional Environment Variables

The SDK supports `LETTA_CLI_PATH` to override the CLI location, but it is **not required** in production. The SDK will automatically resolve the CLI from `node_modules/@letta-ai/letta-code` if the env var is absent.

If you need to override the CLI path, you can set:

```ini
Environment="LETTA_CLI_PATH=/path/to/letta-code/letta.js"
```

---

## Deployment Steps

**The operator must:**

1. Edit `/etc/systemd/system/vibesync.service`
2. Add the environment variables listed above to the `[Service]` section
3. Run `systemctl daemon-reload`
4. Run `systemctl restart vibesync.service`

**Example diff for `/etc/systemd/system/vibesync.service`:**

```diff
 [Service]
 Type=simple
 User=mcp-user
 WorkingDirectory=/opt/stacks/vibesync
 ExecStart=/usr/bin/node /opt/stacks/vibesync/dist/index.js
+Environment="LETTA_LOCAL_BACKEND_DIR=/root/.letta/lc-local-backend"
+Environment="LETTA_LOCAL_BACKEND_EXPERIMENTAL=1"
 Restart=always
 RestartSec=5
```

---

## Verification

After restarting the service, check the logs for:

```
Orchestration plane initialized
```

If the RoleAgentBootstrapper is wired correctly, subsequent formula dispatches for the `letta-code-parallel` project will:

1. Call `buildRoleAgentContextResolver`, which returns non-null (because all deps are present)
2. Call `roleAgentBootstrapper.ensureRoleAgent` for each role (mayor, coder, reviewer, tester)
3. Reuse the same persistent agent across dispatches (logged as `agent-<uuid>` in the orchestration events)

If the environment variables are missing or mismatched, the bootstrapper will throw at runtime with a clear error message about the missing `LETTA_LOCAL_BACKEND_DIR` or a mismatch between the env var and the configured storage dir.

---

## Root Cause (Resolved)

Before this change, `bootOrchestrationPlane` was called with only `providerRouting.store`. The `buildRoleAgentContextResolver` function returned `null` because `roleAgentBootstrapper`, `packDirsByProject`, and `storageDirsByProject` were absent. This caused dispatch to always fall through to the ephemeral general-purpose subagent path.

Now all three deps are wired, so the resolver returns a non-null context for `letta-code-parallel`, and role agents are reused per project.
