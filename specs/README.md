# Specs

TLA+ specifications of the engine, checked by TLC on every pull request (CI job `tlc`).

## What is here

| File | What it is |
|---|---|
| `MoleculeLifecycle.tla` | One molecule run: steps starting, turns returning, results being written, retries, the run settling, and cancel. |
| `MC.tla` | The two step graphs the configurations use: a chain (mayor, coder, reviewer) and a fan-out (coder, then reviewer and tester side by side). |
| `*.cfg` | One model configuration each: a step graph plus a design choice. |
| `EXPECTED` | What TLC must report for every configuration. This file is the gate. |

The spec's header lists what it models, from which code, and what it leaves out. Read that before trusting a result: a property holds only for what is modelled.

## Run it

```
scripts/ci/tlc.sh
```

Needs Java 11 or newer. The script downloads the pinned checker (tla2tools 1.7.4), verifies its checksum, runs every configuration with one worker and compares each result with `EXPECTED`. It takes about 20 seconds. Pass an existing jar as the first argument to skip the download; its checksum is still verified.

It exits 0 only when every configuration ends exactly as listed: the ones that must pass, pass; the ones that must fail report the named invariant or property. A configuration that is not listed, or a listed one that is missing, fails the run.

## Why some configurations must fail

A model checker that only ever says "no error" has shown nothing: the spec may simply be unable to express the bug. So the designs TLC rejected stay in the set, and every run shows the checker failing on them:

- `*.main`: cancel as it was before vibesync-6zos.3. It recorded the running steps and closed the run without waiting for the turns it had stopped.
- `*.fence-before-judge`, `*.fence-atomic-settled`: two attempts to fix that by having the returning turn check whether its step was already settled.
- `*.single-writer-slow-write`: the design in the code, without the assumption that a tracker write already under way lands within cancel's wait. This is the design's stated limit. bd has no compare-and-set on a bead's status, so no bounded wait is safe against a write slower than the wait.

`*.single-writer` and `*.single-writer-timeout` are the design in the code and must pass.

## Changing the spec

1. Change the spec and the code together. The spec must be at least as unkind as the code: if the code does something in two steps, model two steps. A first version of this spec made cancel a single atomic write and passed a fix that was wrong.
2. Reproduce every counterexample TLC finds on the real code, as a test that fails before the fix. A counterexample that cannot be reproduced means the spec and the code disagree; find out which is wrong.
3. Add the configuration to `EXPECTED`. If a design is rejected, keep its configuration as a `fail` line.
4. Do not weaken an invariant to make a configuration pass. Say what assumption the design needs, and add a configuration that drops it.

## Found so far

- vibesync-6zos.3 (2026-11-15): a turn returning after cancel overwrote the step's `cancelled` record, marked the step finished, or reopened it under a closed run. Found by TLC in five steps on its first run; reproduced on the real dispatcher (tests/unit/engine/dispatcher/cancel-race.test.ts).
- vibesync-6zos.5: the same overwrite is possible when cancel lands during `resume()`. Not yet modelled.
