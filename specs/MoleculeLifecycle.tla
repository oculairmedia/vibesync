------------------------- MODULE MoleculeLifecycle -------------------------
(***************************************************************************)
(* The lifecycle of one molecule run in the vibesync engine.               *)
(*                                                                         *)
(* Modelled from the code in src/engine/dispatcher:                        *)
(*  - step beads: open -> in_progress -> closed (beads/molecule-writer.ts) *)
(*  - readiness: open, every dependency closed and ruled on                *)
(*  - starting a step is THREE actions, as in the code (review on #188):  *)
(*    Admit (runReadyStep: run not failed or cancelled, capacity), then    *)
(*    Recheck (runStep, after the prompt render, which can wait on         *)
(*    memory: a cancelled run starts no turn), then MarkRunning (the bd    *)
(*    write that makes the step in_progress). cancel() can land between    *)
(*    any two of them.                                                     *)
(*  - StepTurnRunner.runStep: the turn returns, the reply is judged (a     *)
(*    final step can wait minutes on CI), the engine decides to write, and *)
(*    the write lands. A failed try below MaxAttempts reopens the step.    *)
(*    "Decides to write" and "the write lands" are two actions: a tracker  *)
(*    write is a separate process (bd), not an atomic assignment.          *)
(*  - a role may close its own step declaring a failure_class; the retry   *)
(*    policy must still rule on it                                         *)
(*  - MoleculeSettler: settle only when no turn is in flight               *)
(*  - closing a failed or cancelled root closes every step not yet closed *)
(*    (CloseSweeps = "all"); the "running" write is a compare-and-set      *)
(*    (StartCAS: bd --if-status open), so a late start is refused          *)
(*                                                                         *)
(* cancel(), two designs (CancelMode):                                     *)
(*  "direct" (before vibesync-6zos.3): mark the run; record every step     *)
(*    captured as running as `cancelled`, without re-reading it; close the *)
(*    root. It does not wait for the turns it stopped.                     *)
(*  cancel() is three actions: claim (set the flag, never cleared), decide *)
(*    (the old design could refuse and give the run back: CancelRefuses),  *)
(*    and a part-way failure (CancelAbort) that settlement then finishes.  *)
(*  "single_writer" (the code now): mark the run, after which a turn that  *)
(*    returns writes nothing; wait for every turn of the run to return;    *)
(*    record as cancelled each step still in_progress, read FRESH after    *)
(*    the wait (CancelRecords = "fresh"); close the root. The wait is      *)
(*    bounded (UnwindTimeout). CancelRecords = "snapshot" records only the *)
(*    steps read when cancel() began. With the old open-only sweep it was  *)
(*    rejected: a step admitted just before the flag is left in_progress   *)
(*    under the closed root. With the full sweep (CloseSweeps = "all") it  *)
(*    holds; fresh records are kept to record each running step itself.   *)
(*                                                                         *)
(* LIMITS: what passing configurations do NOT show (outside review of     *)
(* PR #188, rounds 3 and 4). Each is covered by unit tests or documented.  *)
(*  - ONE dispatcher. There is no second process closing steps or the      *)
(*    root, no "closed elsewhere", no not-started attempt, no conditional  *)
(*    root close. Those are covered by cancel-race.test.ts.                *)
(*  - Retry reopen, review-round reopen and result writes are NOT          *)
(*    conditional: one already issued that outlasts cancel()'s wait can    *)
(*    still land after the root closed (the slow-write configs fail).    *)
(*  - Sessions are not modelled: a stop is a request; one that times out   *)
(*    (ATTEMPT_STOP_TIMEOUT_MS) does not prove the session stopped, and an *)
(*    agent silent while observed can hold its turn open.                  *)
(*  - Two dispatchers on one molecule (fifth outside review): completion  *)
(*    can still be inferred from steps a foreign sweep closed if this run's *)
(*    own step finished first; and a closer slower than cancelUnwindMs     *)
(*    loses the root to this run's FAILED fallback (never COMPLETED).      *)
(*  - A start refused because another writer holds the step stops this   *)
(*    run without writing (claimedElsewhere). That does not prove the      *)
(*    other writer is alive: if it dies, the run waits for boot recovery   *)
(*    or a cancel.                                                         *)
(*  - A cancel whose root write fails twice (cancel, then settlement's     *)
(*    retry) leaves the root open until a restart, which closes it as      *)
(*    interrupted, not cancelled. Follow-ups: vibesync-cnxb, vibesync-dmte, vibesync-1l9w. *)
(*  - Settlement is one atomic action here; in the code it reads, then     *)
(*    writes, guarded by the finalizing claim (unit tested).               *)
(*  - Not modelled: restart and resume, the review loop, waits,           *)
(*    more than one run, the tracker being unavailable, two concurrent     *)
(*    cancel() calls (a unit test covers the refusal), and the code        *)
(*    skipping the judge call for a run already cancelled (a saving).      *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Steps,       \* step names
          Deps,        \* Deps[s] = the steps s depends on
          MaxParallel, \* maxParallelSteps
          MaxAttempts, \* tries a step gets before its failure is final
          Fence,       \* "direct" designs only: which late results the turn discards
                       \*   "none"            no fence
                       \*   "not_in_progress" unless the step is still in_progress
                       \*   "cancel_record"   the step carries the cancel's record
                       \*   "settled"         cancel record, or the root is closed
                       \*   "cancelling"      settled, or run.cancelled is set
          FenceAt,     \* "before_judge": fence read, judging, then the write
                       \* "at_write": fence read and write as ONE step (needs a
                       \*   compare-and-set on status that bd does not have)
          CancelMode,  \* "direct" | "single_writer" (see above)
          CancelRecords,    \* "single_writer": "fresh" (read after the wait) | "snapshot" (read at the start)
          RecheckBeforeStart, \* TRUE: runStep asks "cancelled?" after the render, before the turn starts
          CancelRefuses,    \* TRUE: cancel() refuses a run with nothing in_progress (before PR #188's review)
          StartCAS,         \* TRUE: the "running" write is `--if-status open` (since PR #188's review)
          CloseSweeps,      \* "all": the root close closes in_progress steps too; "open": only open ones (before)
          UnwindTimeout,    \* TRUE: cancel()'s wait can run out with a turn still in flight
          WriteOutlastsWait \* TRUE: a tracker write that had begun before the cancel can
                            \*   still be on its way when that wait runs out

VARIABLES status,       \* "open" | "in_progress" | "closed"
          result,       \* "none" | "declared" | "done" | "failed" | "cancelled" | "run_closed"
                        \*   "declared" = closed by its own role with a failure_class, not yet ruled on
          turn,         \* "idle" | "admitted" | "starting" | "running" | "returned_*" | "cleared_*" | "writing_*"  (* = ok | fail)
          root,         \* "open" | "closed"
          outcome,      \* "none" | "completed" | "failed" | "cancelled"
          runFailed,    \* run.failed (in memory)
          runCancelled, \* run.cancelled (in memory)
          attempts,     \* tries started per step
          cancelSet,    \* "direct": steps cancel() captured as running and has yet to record
          cancelPhase,  \* "none" | "claimed" | "committed" | "aborted": where cancel() is (single_writer)
          started       \* started[s]: s's try key is taken (runReadyStep's startedSteps); a reopen frees it

vars == <<status, result, turn, root, outcome, runFailed, runCancelled, attempts, cancelSet, cancelPhase, started>>

Init ==
  /\ status = [s \in Steps |-> "open"]
  /\ result = [s \in Steps |-> "none"]
  /\ turn = [s \in Steps |-> "idle"]
  /\ root = "open" /\ outcome = "none"
  /\ runFailed = FALSE /\ runCancelled = FALSE
  /\ attempts = [s \in Steps |-> 0]
  /\ cancelSet = {}
  /\ cancelPhase = "none"
  /\ started = [s \in Steps |-> FALSE]

Terminal == {"done", "failed", "cancelled", "run_closed"}
InFlight == {s \in Steps : turn[s] # "idle"}
Returned(s) == turn[s] \in {"returned_ok", "returned_fail"}
Cleared(s) == turn[s] \in {"cleared_ok", "cleared_fail"}
Writing(s) == turn[s] \in {"writing_ok", "writing_fail"}
FailedTry(s) == turn[s] \in {"returned_fail", "cleared_fail", "writing_fail"} \/ result[s] = "declared"
Ready(s) == status[s] = "open" /\ \A d \in Deps[s] : status[d] = "closed" /\ result[d] # "declared"

\* runReadyStep admits the step: the run is neither failed nor cancelled, there is capacity.
Admit(s) ==
  /\ root = "open" /\ ~runFailed /\ ~runCancelled
  /\ Ready(s) /\ turn[s] = "idle" /\ ~started[s]
  /\ Cardinality(InFlight) < MaxParallel
  /\ turn' = [turn EXCEPT ![s] = "admitted"]
  /\ started' = [started EXCEPT ![s] = TRUE]
  /\ UNCHANGED <<status, result, root, outcome, runFailed, runCancelled, attempts, cancelSet, cancelPhase>>

\* runStep, after the prompt render: a run cancelled meanwhile starts no turn.
Recheck(s) ==
  /\ turn[s] = "admitted"
  /\ turn' = [turn EXCEPT ![s] = IF RecheckBeforeStart /\ runCancelled THEN "idle" ELSE "starting"]
  /\ UNCHANGED <<status, result, root, outcome, runFailed, runCancelled, attempts, cancelSet, cancelPhase, started>>

\* The bd write that marks the step running, then the turn starts. StartCAS (the code since PR #188's review):
\* the write is `--if-status open`; on a step that is no longer open it writes nothing and the turn starts
\* nothing. Without it (before), the write reopened whatever it found.
MarkRunning(s) ==
  /\ turn[s] = "starting"
  /\ IF StartCAS /\ status[s] # "open"
       THEN /\ turn' = [turn EXCEPT ![s] = "idle"]
            /\ UNCHANGED <<status, attempts, cancelPhase, started>>
       ELSE /\ status' = [status EXCEPT ![s] = "in_progress"]
            /\ turn' = [turn EXCEPT ![s] = "running"]
            /\ attempts' = [attempts EXCEPT ![s] = @ + 1]
  /\ UNCHANGED <<result, root, outcome, runFailed, runCancelled, cancelSet, cancelPhase, started>>

\* The role closes its own step during its turn, declaring a failure_class.
AgentCloses(s) ==
  /\ turn[s] = "running" /\ status[s] = "in_progress"
  /\ status' = [status EXCEPT ![s] = "closed"]
  /\ result' = [result EXCEPT ![s] = "declared"]
  /\ UNCHANGED <<turn, root, outcome, runFailed, runCancelled, attempts, cancelSet, cancelPhase, started>>

TurnEnds(s, ok) ==
  /\ turn[s] = "running"
  /\ turn' = [turn EXCEPT ![s] = IF ok THEN "returned_ok" ELSE "returned_fail"]
  /\ UNCHANGED <<status, result, root, outcome, runFailed, runCancelled, attempts, cancelSet, cancelPhase, started>>

Discard(s) ==
  CASE Fence = "none" -> FALSE
    [] Fence = "not_in_progress" -> status[s] # "in_progress"
    [] Fence = "cancel_record" -> result[s] = "cancelled"
    [] Fence = "settled" -> result[s] = "cancelled" \/ root = "closed"
    [] Fence = "cancelling" -> result[s] = "cancelled" \/ root = "closed" \/ runCancelled

\* The retry policy's ruling, as written to the step bead.
WriteRuling(s) ==
  IF FailedTry(s) /\ attempts[s] < MaxAttempts
    THEN /\ status' = [status EXCEPT ![s] = "open"]
         /\ result' = [result EXCEPT ![s] = "none"]
         /\ UNCHANGED runFailed
         /\ started' = [started EXCEPT ![s] = FALSE]
    ELSE /\ status' = [status EXCEPT ![s] = "closed"]
         /\ result' = [result EXCEPT ![s] = IF FailedTry(s) THEN "failed" ELSE "done"]
         /\ runFailed' = (runFailed \/ FailedTry(s))
         /\ UNCHANGED started

\* The reply is judged. A "direct" design may read its fence here.
Judge(s) ==
  /\ FenceAt = "before_judge" /\ Returned(s)
  /\ turn' = [turn EXCEPT ![s] = IF Discard(s) THEN "idle"
                                 ELSE IF turn[s] = "returned_ok" THEN "cleared_ok" ELSE "cleared_fail"]
  /\ UNCHANGED <<status, result, root, outcome, runFailed, runCancelled, attempts, cancelSet, cancelPhase, started>>

\* The engine decides to write. Under "single_writer" a cancelled run's turn
\* writes nothing at all: cancel() records the step once the turn is back.
WriteBegin(s) ==
  /\ FenceAt = "before_judge" /\ Cleared(s)
  /\ turn' = [turn EXCEPT ![s] = IF CancelMode = "single_writer" /\ runCancelled THEN "idle"
                                 ELSE IF turn[s] = "cleared_ok" THEN "writing_ok" ELSE "writing_fail"]
  /\ UNCHANGED <<status, result, root, outcome, runFailed, runCancelled, attempts, cancelSet, cancelPhase, started>>

\* The write lands on the tracker.
WriteLand(s) ==
  /\ Writing(s)
  /\ turn' = [turn EXCEPT ![s] = "idle"]
  /\ WriteRuling(s)
  /\ UNCHANGED <<root, outcome, runCancelled, attempts, cancelSet, cancelPhase>>

\* FenceAt = "at_write": fence read and write in one step.
WriteAtomic(s) ==
  /\ FenceAt = "at_write" /\ Returned(s)
  /\ turn' = [turn EXCEPT ![s] = "idle"]
  /\ IF Discard(s) THEN UNCHANGED <<status, result, runFailed, cancelPhase, started>> ELSE WriteRuling(s)
  /\ UNCHANGED <<root, outcome, runCancelled, attempts, cancelSet, cancelPhase>>

\* Closing a failed or cancelled root closes every step that is not closed yet: open, and (CloseSweeps =
\* "all", the code since the outside review of PR #188) in_progress too; "open" is the design before it.
Sweep(s) == status[s] = "open" \/ (CloseSweeps = "all" /\ status[s] = "in_progress")
CloseOpen == [s \in Steps |-> IF Sweep(s) THEN "closed" ELSE status[s]]
MarkRunClosed == [s \in Steps |-> IF Sweep(s) THEN "run_closed" ELSE result[s]]

SettleFailed ==
  /\ root = "open" /\ runFailed /\ ~runCancelled /\ InFlight = {}
  /\ status' = CloseOpen /\ result' = MarkRunClosed
  /\ root' = "closed" /\ outcome' = "failed"
  /\ UNCHANGED <<turn, runFailed, runCancelled, attempts, cancelSet, cancelPhase, started>>

SettleCompleted ==
  /\ root = "open" /\ ~runFailed /\ ~runCancelled /\ InFlight = {}
  /\ \A s \in Steps : status[s] = "closed"
  /\ root' = "closed" /\ outcome' = "completed"
  /\ UNCHANGED <<status, result, turn, runFailed, runCancelled, attempts, cancelSet, cancelPhase, started>>

\* cancel() claims the run: the flag is set first (before any read). "direct" (before vibesync-6zos.3) read the
\* running steps first and refused if there were none, so it commits at once and never claims.
CancelBegin ==
  /\ root = "open" /\ ~runCancelled /\ cancelPhase = "none"
  /\ (CancelMode = "direct" => \E s \in Steps : status[s] = "in_progress")
  /\ runCancelled' = TRUE
  /\ cancelPhase' = IF CancelMode = "direct" THEN "committed" ELSE "claimed"
  /\ cancelSet' = IF CancelMode = "direct" THEN {s \in Steps : status[s] = "in_progress"} ELSE {}
  /\ UNCHANGED <<status, result, turn, root, outcome, runFailed, attempts, started>>

\* "single_writer": cancel()'s first read. CancelRefuses (82fd087): with nothing in_progress it refused and gave the
\* run back (cleared the flag), though turns had already seen the flag and given their steps up. The code now: it
\* always goes on. The "snapshot" design read the steps it would record here.
CancelDecide ==
  /\ cancelPhase = "claimed" /\ root = "open"
  /\ IF CancelRefuses /\ \A s \in Steps : status[s] # "in_progress"
       THEN /\ runCancelled' = FALSE /\ cancelPhase' = "none" /\ UNCHANGED cancelSet
       ELSE /\ cancelPhase' = "committed" /\ UNCHANGED runCancelled
            /\ cancelSet' = IF CancelRecords = "snapshot" THEN {s \in Steps : status[s] = "in_progress"} ELSE {}
  /\ UNCHANGED <<status, result, turn, root, outcome, runFailed, attempts, started>>

\* "single_writer": cancel() fails part-way (a stop, a tracker write) before it closed the root. It stays a cancel.
CancelAbort ==
  /\ CancelMode = "single_writer" /\ cancelPhase = "committed" /\ root = "open"
  /\ cancelPhase' = "aborted"
  /\ UNCHANGED <<status, result, turn, root, outcome, runFailed, runCancelled, attempts, cancelSet, started>>

\* Settlement closes the root of a cancel that failed part-way, once no turn is in flight (the retry in
\* settleKnownMoleculeOutcome). It did not record the steps: the root close's sweep is what closes them.
SettleCancelled ==
  /\ cancelPhase = "aborted" /\ root = "open" /\ InFlight = {}
  /\ status' = CloseOpen /\ result' = MarkRunClosed
  /\ root' = "closed" /\ outcome' = "cancelled"
  /\ UNCHANGED <<turn, runFailed, runCancelled, attempts, cancelSet, cancelPhase, started>>

\* "direct": cancel() records a captured step as cancelled. It does not re-read it.
CancelStep(s) ==
  /\ CancelMode = "direct" /\ root = "open" /\ s \in cancelSet
  /\ status' = [status EXCEPT ![s] = "closed"]
  /\ result' = [result EXCEPT ![s] = "cancelled"]
  /\ cancelSet' = cancelSet \ {s}
  /\ UNCHANGED <<turn, root, outcome, runFailed, runCancelled, attempts, cancelPhase, started>>

\* "single_writer": cancel() has stopped waiting for this step's turn. Either the
\* turn is back, or the wait ran out. ASSUMPTION when WriteOutlastsWait is FALSE:
\* a write that had begun lands within the wait (5 s in the code; a bd write
\* takes about 0.2 s). The *.single-writer-slow-write configurations drop the
\* assumption and fail: without a compare-and-set no bounded wait is safe then.
\* The "running" write is a tracker write too: under the same assumption it lands within the wait.
WaitOver(s) == turn[s] = "idle" \/ (UnwindTimeout /\ (WriteOutlastsWait \/ ~(Writing(s) \/ turn[s] = "starting")))

\* "single_writer": cancel() records a step that is STILL in_progress, read fresh. What
\* separates "fresh" from "snapshot" is when cancel() may close the root (CancelFinish):
\* recording a step outside the snapshot changes nothing if the root closes first.
CancelRecord(s) ==
  /\ CancelMode = "single_writer" /\ runCancelled /\ root = "open" /\ cancelPhase = "committed"
  /\ status[s] = "in_progress" /\ WaitOver(s)
  /\ status' = [status EXCEPT ![s] = "closed"]
  /\ result' = [result EXCEPT ![s] = "cancelled"]
  /\ cancelSet' = cancelSet \ {s}
  /\ UNCHANGED <<turn, root, outcome, runFailed, runCancelled, attempts, cancelPhase, started>>

\* "single_writer" closes the root once every turn is back (or the wait ran out) and the
\* steps it records are recorded: all of them ("fresh") or its snapshot ("snapshot").
CancelFinish ==
  /\ runCancelled /\ root = "open" /\ cancelPhase = "committed"
  /\ (CancelMode = "direct" => cancelSet = {})
  /\ (CancelMode = "single_writer" =>
        /\ \A s \in Steps : WaitOver(s)
        /\ \A s \in (IF CancelRecords = "snapshot" THEN cancelSet ELSE Steps) : status[s] # "in_progress")
  /\ status' = CloseOpen /\ result' = MarkRunClosed
  /\ root' = "closed" /\ outcome' = "cancelled"
  /\ UNCHANGED <<turn, runFailed, runCancelled, attempts, cancelSet, cancelPhase, started>>

Next ==
  \/ \E s \in Steps : Admit(s) \/ Recheck(s) \/ MarkRunning(s) \/ AgentCloses(s) \/ Judge(s) \/ WriteBegin(s) \/ WriteLand(s) \/ WriteAtomic(s)
  \/ \E s \in Steps : CancelStep(s) \/ CancelRecord(s)
  \/ \E s \in Steps, ok \in BOOLEAN : TurnEnds(s, ok)
  \/ SettleFailed \/ SettleCompleted \/ CancelBegin \/ CancelDecide \/ CancelAbort \/ SettleCancelled \/ CancelFinish

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

---------------------------------------------------------------------------
TypeOK ==
  /\ status \in [Steps -> {"open", "in_progress", "closed"}]
  /\ result \in [Steps -> {"none", "declared", "done", "failed", "cancelled", "run_closed"}]
  /\ turn \in [Steps -> {"idle", "admitted", "starting", "running", "returned_ok", "returned_fail", "cleared_ok", "cleared_fail", "writing_ok", "writing_fail"}]
  /\ root \in {"open", "closed"}
  /\ outcome \in {"none", "completed", "failed", "cancelled"}
  /\ cancelSet \subseteq Steps
  /\ cancelPhase \in {"none", "claimed", "committed", "aborted"}
  /\ started \in [Steps -> BOOLEAN]

\* A step never runs before everything it depends on is closed.
NoStepStartsEarly ==
  \A s \in Steps : status[s] = "in_progress" => \A d \in Deps[s] : status[d] = "closed"

ParallelLimit == Cardinality({s \in Steps : status[s] = "in_progress"}) <= MaxParallel

\* Under a closed root every step is closed: none left open, none still in_progress.
ClosedRootHasOnlyClosedSteps == root = "closed" => \A s \in Steps : status[s] = "closed"

CompletedMeansAllDone == outcome = "completed" => \A s \in Steps : result[s] = "done"

RootClosedHasOutcome == (root = "closed") <=> (outcome # "none")

\* While the run is live and not being cancelled, a step its role closed with a
\* declared failure is still going to be ruled on.
NoUnruledStepAtRest ==
  (root = "open" /\ ~runCancelled) => \A s \in Steps : result[s] = "declared" => turn[s] # "idle"

\* A terminal step record is never rewritten.
StepResultIsFinal ==
  [][\A s \in Steps : (result[s] \in Terminal) => (result'[s] = result[s])]_vars

\* Every run ends.
EventuallySettles == <>(root = "closed")

\* Outside review of PR #188, round 2. Once cancelled, a run stays cancelled (no un-cancel).
CancelMonotone == [][runCancelled => runCancelled']_vars
\* A cancelled run that closes, closes as cancelled: never completed or failed.
CancelledRootIsCancelled == (runCancelled /\ root = "closed") => outcome = "cancelled"
\* A closed root's outcome is never rewritten (a second closer must not overwrite it).
RootOutcomeIsFinal == [][root = "closed" => (root' = "closed" /\ outcome' = outcome)]_vars
\* No step is stranded while the run is live and not cancelled: none in_progress without a turn (a result given up
\* under a cancel that was then taken back), none open whose try key is taken but which never ran (a refused cancel
\* after the pre-start re-check sent its turn home). Outside review of PR #188 (Fable, GPT).
NoStrandedStep ==
  (root = "open" /\ ~runCancelled) =>
    \A s \in Steps : turn[s] = "idle" => (status[s] # "in_progress" /\ (status[s] = "open" => ~started[s]))
=============================================================================
