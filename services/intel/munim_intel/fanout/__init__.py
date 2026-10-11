"""Fan-out (ledger R45 F5, F8; ADR-014 §3.3, §6.3): on `investigate`, the Manager asks up to four specialists at once,
each acting read-only in a clean context (`tool.py`), and merges their reports in `submit_answer`."""
