"""suppliers-sim (T-055a; R22, R45 F4): three SIMULATED supplier agents behind A2A. Never a real supplier, price,
order or payment (hard rule 5). Every card, name and reply says "Simulated supplier".

Deterministic: a personality is data (personalities.json), so the same request always gets the same reply. The buyer
(intel's negotiation, specialist Inventory & Purchasing) sends typed data parts; the agent replies in plain text, which
intel treats as untrusted and reads only through its no-tools extractor.
"""
