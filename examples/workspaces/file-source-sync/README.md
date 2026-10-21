# File-Level Source Sync Example

This example demonstrates the file-level source sync feature in AllAgents.

## Directory Structure

```
examples/
├── workspaces/
│   └── file-source-sync/       # The workspace
│       ├── .allagents/
│       │   └── workspace.yaml
│       ├── shared-config/      # Default source (workspace.source)
│       │   ├── AGENTS.md
│       │   └── config/
│       │       └── settings.json
│       └── README.md
└── team-config/                # Shared fixture, outside the workspace templates
    └── rules.md
```

## How It Works

The `workspace.yaml` demonstrates three source patterns:

1. **String shorthand** - `AGENTS.md` resolves to `shared-config/AGENTS.md`
2. **Relative source** - `source: config/settings.json` resolves to `shared-config/config/settings.json`
3. **File-level override** - `source: ../../team-config/rules.md` uses a shared fixture outside `workspaces/`, resolved from the workspace root

## Running the Example

```bash
cd examples/workspaces/file-source-sync
allagents workspace sync --dry-run
```

After sync, the workspace root will contain:
- `AGENTS.md` (from shared-config, with WORKSPACE-RULES injected)
- `CLAUDE.md` (auto-copied from AGENTS.md for claude client)
- `settings.json` (from shared-config/config/)
- `TEAM-RULES.md` (from team-config/rules.md)

## Key Behaviors

- **Source is truth**: Local files are overwritten on every sync
- **Deleted files restored**: Delete AGENTS.md locally, sync restores it
- **WORKSPACE-RULES injection**: AGENTS.md and CLAUDE.md get workspace discovery rules
