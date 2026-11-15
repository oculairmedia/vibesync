---- MODULE MC ----
EXTENDS MoleculeLifecycle, TLC
\* mayor -> coder -> reviewer (the shape of onboard-feature)
ChainDeps == [s \in Steps |-> IF s = "coder" THEN {"mayor"} ELSE IF s = "reviewer" THEN {"coder"} ELSE {}]
\* coder, then reviewer and tester side by side
FanDeps == [s \in Steps |-> IF s \in {"reviewer", "tester"} THEN {"coder"} ELSE {}]
====
