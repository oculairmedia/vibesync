def dispatch_molecule(formula: str, input: str, pack: str = "gastown", motivating_bead_id: str = "") -> dict:
    """
    Dispatch a vibesync formula (a multi-agent workflow) and return its molecule id.

    A "formula" is a named multi-step workflow shipped with vibesync — each step
    runs as a separate Letta agent with a role-specific persona. The molecule id
    that comes back identifies the running workflow; you can poll it via
    GET /molecules/<id> to see step progress, or read /molecules/<id>/events
    for a live SSE feed.

    Catalog: if you do not already know which formula matches the bead in front
    of you, call GET /formulas first — every formula carries a "whenToUse"
    field that describes when it is the right tool. Examples (subject to change):

      - code-review     → bead represents a drafted code change needing review+fix+verify
      - onboard-feature → bead represents a feature request needing decomposition first
      - refinery-sweep  → scheduled housekeeping (NOT for backlog work)

    Always set motivating_bead_id when the dispatch was triggered by a specific
    bead — the dispatcher writes the molecule's outcome (success or failure)
    back to that bead's notes on completion, so omitting it loses the trail.

    Args:
        formula: Name of the formula to run, e.g. "code-review".
        input: Free-text input passed to the first step (the diff to review, the
               feature description to onboard, etc.). Required, must be non-empty.
        pack: Pack the formula lives in. Defaults to "gastown".
        motivating_bead_id: Bead id that motivated this dispatch (e.g. "vibesync-bll").
                            When set, completion/failure writeback goes here.

    Returns:
        dict: { "ok": True, "molecule_id": "...", "formula_name": "...", "pack": "..." }
              on success; { "ok": False, "error": "..." } on dispatcher refusal.
    """
    import os
    import json
    import urllib.request
    import urllib.error

    base = os.environ.get("VIBESYNC_API_BASE_URL", "http://localhost:3099").rstrip("/")
    token = os.environ.get("VIBESYNC_ORCHESTRATION_TOKEN", "").strip()

    url = f"{base}/formulas/{formula}/run"
    payload = {"input": input, "pack": pack}
    if motivating_bead_id:
        payload["motivatingBeadId"] = motivating_bead_id

    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            raw = response.read().decode("utf-8")
            parsed = json.loads(raw)
            return {
                "ok": True,
                "molecule_id": parsed.get("moleculeId"),
                "formula_name": parsed.get("formulaName"),
                "pack": parsed.get("pack"),
            }
    except urllib.error.HTTPError as err:
        detail = ""
        try:
            detail = err.read().decode("utf-8")
        except Exception:
            pass
        return {"ok": False, "error": f"HTTP {err.code}: {detail or err.reason}"}
    except urllib.error.URLError as err:
        return {"ok": False, "error": f"URL error: {err.reason}"}
    except Exception as err:  # noqa: BLE001 — agent-facing tool, surface everything
        return {"ok": False, "error": f"{type(err).__name__}: {err}"}
