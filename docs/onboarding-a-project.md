# Onboard a project

The engine currently reads project settings from the project's committed `.meridian/project.json`. Later, project registration and settings move to the Meridian host (`letta-mobile-m0xhd`).

## Requirements

1. Put the project checkout under a registered path scanned by the registry.
2. Set up a Beads tracker in that checkout.
3. Register the project's role agents in the VibeSync registry.
4. Commit `.meridian/project.json` on the default branch. Use this exact shape, replacing the UUID and key/name:

```json
{
  "schemaVersion": 1,
  "projectId": "01234567-89ab-cdef-0123-456789abcdef",
  "key": "example-project",
  "name": "Example Project",
  "engine": {
    "formula": "onboard-feature",
    "readyLabel": "scheduler:eligible",
    "poolSize": 1,
    "ciChecks": ["typecheck", "test"]
  }
}
```

`engine` fields are optional. Missing values use the global scheduler defaults; `ciChecks` must name the project's final-step checks. Keep the project identifier key lowercase and stable once registered.

5. Enable its scheduler by adding the project identifier to `VIBESYNC_SCHEDULER_PROJECTS` in the service environment:

```sh
VIBESYNC_SCHEDULER_PROJECTS=example-project
```

For multiple projects, provide a comma-separated list. Restart VibeSync after changing the environment.
6. Label a bead `scheduler:eligible` (or the configured `readyLabel`) to make it eligible for scheduling.

The project file is read from the default branch's committed content, not the working tree, so uncommitted edits and branches under review do not change engine behavior.
