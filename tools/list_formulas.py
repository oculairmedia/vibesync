def list_formulas() -> dict:
    """
    List every vibesync formula in the active catalog, with the
    `whenToUse` hint each formula carries so you can pick the right one
    for a bead before calling dispatch_molecule.

    Use this BEFORE dispatch_molecule whenever the right formula is not
    already obvious. Read each formula's whenToUse field — it describes
    when that formula is the right tool. Pick by matching the bead's
    nature against whenToUse, not by guessing from the name.

    Workflow:
      1. Call list_formulas() to read the catalog.
      2. Match the bead to a formula via whenToUse.
      3. Call dispatch_molecule(formula=<name>, input=<bead description or
         relevant context>, motivating_bead_id=<bead id>).

    Returns:
        dict: On success, {
          "ok": True,
          "formulas": [
            {
              "name": "code-review",
              "pack": "gastown",
              "description": "...",
              "whenToUse": "...",
              "stepCount": 3,
              "roles": ["reviewer", "coder", "tester"]
            },
            ...
          ]
        }
        On failure, { "ok": False, "error": "..." }.
    """
    import os
    import json
    import urllib.request
    import urllib.error

    base = os.environ.get("VIBESYNC_API_BASE_URL", "http://localhost:3099").rstrip("/")
    token = os.environ.get("VIBESYNC_ORCHESTRATION_TOKEN", "").strip()

    url = f"{base}/formulas"
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    request = urllib.request.Request(url, headers=headers, method="GET")

    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            raw = response.read().decode("utf-8")
            parsed = json.loads(raw)
            formulas = parsed.get("formulas", []) if isinstance(parsed, dict) else []
            return {"ok": True, "formulas": formulas}
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
