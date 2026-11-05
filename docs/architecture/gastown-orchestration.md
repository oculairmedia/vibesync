# Multi-Agent Orchestration in VibeSync

VibeSync owns the orchestration plane for Gastown-style role workflows:
formulas, molecules, runtime providers, event bus, the scheduler's causal
witness for liveness, role
packs, and layering invariants live in this repository.

Gastown role sessions run on persistent role agents over the Iroh wrapper,
through `IrohWrapperProvider` (`src/engine/runtime/iroh-wrapper-provider.ts`,
provider kind `letta-code-iroh`), the only runtime provider. The shim
provider and the Teams-backed provider were removed (vibesync-9lzk.29); a
routing row naming a removed kind fails loudly instead of falling back.

## Architecture shape

```
┌───────────────────────────────────────────────────────────────────┐
│ VibeSync — orchestration host                                     │
│   formulas · molecules · runtime providers · event bus            │
│   causal liveness witness · role packs · layering invariants       │
│                                                                   │
│   …………… RuntimeProvider interface ……………                          │
│   ┌───────────────────────────────────────────────────────┐     │
│   │ IrohWrapperProvider (letta-code-iroh)                 │     │
│   │ steps go directly to persistent role agents           │     │
│   └───────────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────────┘
```

Higher layers never depend on provider internals. They start sessions,
send prompts, observe events, and persist molecule state through the common
interfaces.

## Layering invariants

The repository-level `AGENTS.md` pins the five rules that keep the plane
maintainable:

1. No upward dependencies.
2. Beads is the universal persistence substrate.
3. Event bus is the universal observation substrate.
4. Config is the universal activation mechanism.
5. Zero hardcoded roles.

These are defects when violated even if the code appears to work.

## RuntimeProvider interface

`src/orchestration/runtime/provider.ts` is the chokepoint. Providers expose
only session lifecycle, prompting, nudging, and observation. Role memory,
conversation persistence, A2UI negotiation, and formula behavior remain
above this seam in pack config, prompt templates, and orchestration logic.

## Formulas and molecules

**Formula** means a TOML workflow template such as a code-review loop.
**Molecule** means a runtime instance backed by Beads rows: one root plus
dependency-linked child steps. The dispatcher walks formulas, creates
molecule state, dispatches steps in dependency order, records outputs, and
emits bus events for dashboards and trace APIs.

## Non-goals

- Do not add new domain persistence outside Beads/Dolt.
- Do not bypass the event bus for cross-layer visibility.
- Do not put role names or behavior in core TypeScript.
- Do not add a second route to the Letta runtime; transport goes through
  the Iroh wrapper.
- Do not reintroduce the shim or Teams-backed runtime integrations.

## References

- Gas Town: https://github.com/steveyegge/gastown
- Gas City: https://github.com/gastownhall/gascity
- A2UI protocol: https://a2ui.org/ · https://github.com/google/A2UI
