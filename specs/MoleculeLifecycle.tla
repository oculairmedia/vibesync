------------------------- MODULE MoleculeLifecycle -------------------------
(***************************************************************************)
(* The lifecycle of one molecule run in the vibesync engine.               *)
(*                                                                         *)
(* Modelled from the code in src/engine/dispatcher:                        *)
(*  - step beads: open -> in_progress -> closed (beads/molecule-writer.ts) *)
(*  - readiness: open, every dependency closed and ruled on                *)
(*  - FormulaDispatcher.runReadyStep: no start once the run failed or was  *)
(*    cancelled; at most MaxParallel turns in flight                       *)
(*  - StepTurnRunner.runStep: the turn returns, the reply is judged (a     *)
(*    final step can wait minutes on CI), the engine decides to write, and *)
(*    the write lands. A failed try below MaxAttempts reopens the step.    *)
(*    "Decides to write" and "the write lands" are two actions: a tracker  *)
(*    write is a separate process (bd), not an atomic assignment.          *)
(*  - a role may close its own step declaring a failure_class; the retry   *)
(*    policy must still rule on it                                         *)
(*  - MoleculeSettler: settle only when no turn is in flight               *)
(*  - closing a failed or cancelled root closes its unstarted steps        *)
(*                                                                         *)
(* cancel(), two designs (CancelMode):                                     *)
(*  "direct" (before vibesync-6zos.3): mark the run; record every step     *)
(*    captured as running as `cancelled`, without re-reading it; close the *)
(*    root. It does not wait for the turns it stopped.                     *)
(*  "single_writer" (the code now): mark the run, after which a turn that  *)
(*    returns writes nothing; wait for every turn of the run to return;    *)
(*    record as cancelled each step still in_progress; close the root.     *)
(*    The wait is bounded (UnwindTimeout).                                 *)
(*                                                                         *)
(* Not modelled: process restart and resume, the review loop, waits, more  *)
(* than one run, the tracker being unavailable, and the code skipping the  *)
(* judge call for a run already cancelled when the turn returns (a saving, *)
(* not a safety rule: the write is what is refused).                       *)
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
          UnwindTimeout,    \* TRUE: cancel()'s wait can run out with a turn still in flight
          WriteOutlastsWait \* TRUE: a tracker write that had begun before the cancel can
                            \*   still be on its way when that wait runs out

VARIABLES status,       \* "open" | "in_progress" | "closed"
          result,       \* "none" | "declared" | "done" | "failed" | "cancelled" | "run_closed"
                        \*   "declared" = closed by its own role with a failure_class, not yet ruled on
          turn,         \* "idle" | "running" | "returned_*" | "cleared_*" | "writing_*"  (* = ok | fail)
          root,         \* "open" | "closed"
          outcome,      \* "none" | "completed" | "failed" | "cancelled"
          runFailed,    \* run.failed (in memory)
          runCancelled, \* run.cancelled (in memory)
          attempts,     \* tries started per step
          cancelSet     \* "direct": steps cancel() captured as running and has yet to record

vars == <<status, result, turn, root, outcome, runFailed, runCancelled, attempts, cancelSet>>

Init ==
  /\ status = [s \in Steps |-> "open"]
  /\ result = [s \in Steps |-> "none"]
  /\ turn = [s \in Steps |-> "idle"]
  /\ root = "open" /\ outcome = "none"
  /\ runFailed = FALSE /\ runCancelled = FALSE
  /\ attempts = [s \in Steps |-> 0]
  /\ cancelSet = {}

Terminal == {"done", "failed", "cancelled", "run_closed"}
InFlight == {s \in Steps : turn[s] # "idle"}
Returned(s) == turn[s] \in {"returned_ok", "returned_fail"}
Cleared(s) == turn[s] \in {"cleared_ok", "cleared_fail"}
Writing(s) == turn[s] \in {"writing_ok", "writing_fail"}
FailedTry(s) == turn[s] \in {"returned_fail", "cleared_fail", "writing_fail"} \/ result[s] = "declared"
Ready(s) == status[s] = "open" /\ \A d \in Deps[s] : status[d] = "closed" /\ result[d] # "declared"

Start(s) ==
  /\ root = "open" /\ ~runFailed /\ ~runCancelled
  /\ Ready(s) /\ turn[s] = "idle"
  /\ Cardinality(InFlight) < MaxParallel
  /\ status' = [status EXCEPT ![s] = "in_progress"]
  /\ turn' = [turn EXCEPT ![s] = "running"]
  /\ attempts' = [attempts EXCEPT ![s] = @ + 1]
  /\ UNCHANGED <<result, root, outcome, runFailed, runCancelled, cancelSet>>

\* The role closes its own step during its turn, declaring a failure_class.
AgentCloses(s) ==
  /\ turn[s] = "running" /\ status[s] = "in_progress"
  /\ status' = [status EXCEPT ![s] = "closed"]
  /\ result' = [result EXCEPT ![s] = "declared"]
  /\ UNCHANGED <<turn, root, outcome, runFailed, runCancelled, attempts, cancelSet>>

TurnEnds(s, ok) ==
  /\ turn[s] = "running"
  /\ turn' = [turn EXCEPT ![s] = IF ok THEN "returned_ok" ELSE "returned_fail"]
  /\ UNCHANGED <<status, result, root, outcome, runFailed, runCancelled, attempts, cancelSet>>

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
    ELSE /\ status' = [status EXCEPT ![s] = "closed"]
         /\ result' = [result EXCEPT ![s] = IF FailedTry(s) THEN "failed" ELSE "done"]
         /\ runFailed' = (runFailed \/ FailedTry(s))

\* The reply is judged. A "direct" design may read its fence here.
Judge(s) ==
  /\ FenceAt = "before_judge" /\ Returned(s)
  /\ turn' = [turn EXCEPT ![s] = IF Discard(s) THEN "idle"
                                 ELSE IF turn[s] = "returned_ok" THEN "cleared_ok" ELSE "cleared_fail"]
  /\ UNCHANGED <<status, result, root, outcome, runFailed, runCancelled, attempts, cancelSet>>

\* The engine decides to write. Under "single_writer" a cancelled run's turn
\* writes nothing at all: cancel() records the step once the turn is back.
WriteBegin(s) ==
  /\ FenceAt = "before_judge" /\ Cleared(s)
  /\ turn' = [turn EXCEPT ![s] = IF CancelMode = "single_writer" /\ runCancelled THEN "idle"
                                 ELSE IF turn[s] = "cleared_ok" THEN "writing_ok" ELSE "writing_fail"]
  /\ UNCHANGED <<status, result, root, outcome, runFailed, runCancelled, attempts, cancelSet>>

\* The write lands on the tracker.
WriteLand(s) ==
  /\ Writing(s)
  /\ turn' = [turn EXCEPT ![s] = "idle"]
  /\ WriteRuling(s)
  /\ UNCHANGED <<root, outcome, runCancelled, attempts, cancelSet>>

\* FenceAt = "at_write": fence read and write in one step.
WriteAtomic(s) ==
  /\ FenceAt = "at_write" /\ Returned(s)
  /\ turn' = [turn EXCEPT ![s] = "idle"]
  /\ IF Discard(s) THEN UNCHANGED <<status, result, runFailed>> ELSE WriteRuling(s)
  /\ UNCHANGED <<root, outcome, runCancelled, attempts, cancelSet>>

CloseOpen == [s \in Steps |-> IF status[s] = "open" THEN "closed" ELSE status[s]]
MarkRunClosed == [s \in Steps |-> IF status[s] = "open" THEN "run_closed" ELSE result[s]]

SettleFailed ==
  /\ root = "open" /\ runFailed /\ ~runCancelled /\ InFlight = {}
  /\ status' = CloseOpen /\ result' = MarkRunClosed
  /\ root' = "closed" /\ outcome' = "failed"
  /\ UNCHANGED <<turn, runFailed, runCancelled, attempts, cancelSet>>

SettleCompleted ==
  /\ root = "open" /\ ~runFailed /\ ~runCancelled /\ InFlight = {}
  /\ \A s \in Steps : status[s] = "closed"
  /\ root' = "closed" /\ outcome' = "completed"
  /\ UNCHANGED <<status, result, turn, runFailed, runCancelled, attempts, cancelSet>>

CancelBegin ==
  /\ root = "open" /\ ~runCancelled
  /\ \E s \in Steps : status[s] = "in_progress"
  /\ runCancelled' = TRUE
  /\ cancelSet' = IF CancelMode = "direct" THEN {s \in Steps : status[s] = "in_progress"} ELSE {}
  /\ UNCHANGED <<status, result, turn, root, outcome, runFailed, attempts>>

\* "direct": cancel() records a captured step as cancelled. It does not re-read it.
CancelStep(s) ==
  /\ CancelMode = "direct" /\ root = "open" /\ s \in cancelSet
  /\ status' = [status EXCEPT ![s] = "closed"]
  /\ result' = [result EXCEPT ![s] = "cancelled"]
  /\ cancelSet' = cancelSet \ {s}
  /\ UNCHANGED <<turn, root, outcome, runFailed, runCancelled, attempts>>

\* "single_writer": cancel() has stopped waiting for this step's turn. Either the
\* turn is back, or the wait ran out. ASSUMPTION when WriteOutlastsWait is FALSE:
\* a write that had begun lands within the wait (5 s in the code; a bd write
\* takes about 0.2 s). The *.single-writer-slow-write configurations drop the
\* assumption and fail: without a compare-and-set no bounded wait is safe then.
WaitOver(s) == turn[s] = "idle" \/ (UnwindTimeout /\ (WriteOutlastsWait \/ ~Writing(s)))

\* "single_writer": cancel() records a step that is STILL in_progress, read fresh.
CancelRecord(s) ==
  /\ CancelMode = "single_writer" /\ runCancelled /\ root = "open"
  /\ status[s] = "in_progress" /\ WaitOver(s)
  /\ status' = [status EXCEPT ![s] = "closed"]
  /\ result' = [result EXCEPT ![s] = "cancelled"]
  /\ UNCHANGED <<turn, root, outcome, runFailed, runCancelled, attempts, cancelSet>>

CancelFinish ==
  /\ runCancelled /\ root = "open" /\ cancelSet = {}
  /\ (CancelMode = "single_writer" =>
        \A s \in Steps : status[s] # "in_progress" /\ WaitOver(s))
  /\ status' = CloseOpen /\ result' = MarkRunClosed
  /\ root' = "closed" /\ outcome' = "cancelled"
  /\ UNCHANGED <<turn, runFailed, runCancelled, attempts, cancelSet>>

Next ==
  \/ \E s \in Steps : Start(s) \/ AgentCloses(s) \/ Judge(s) \/ WriteBegin(s) \/ WriteLand(s) \/ WriteAtomic(s)
  \/ \E s \in Steps : CancelStep(s) \/ CancelRecord(s)
  \/ \E s \in Steps, ok \in BOOLEAN : TurnEnds(s, ok)
  \/ SettleFailed \/ SettleCompleted \/ CancelBegin \/ CancelFinish

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

---------------------------------------------------------------------------
TypeOK ==
  /\ status \in [Steps -> {"open", "in_progress", "closed"}]
  /\ result \in [Steps -> {"none", "declared", "done", "failed", "cancelled", "run_closed"}]
  /\ turn \in [Steps -> {"idle", "running", "returned_ok", "returned_fail", "cleared_ok", "cleared_fail", "writing_ok", "writing_fail"}]
  /\ root \in {"open", "closed"}
  /\ outcome \in {"none", "completed", "failed", "cancelled"}
  /\ cancelSet \subseteq Steps

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
=============================================================================
