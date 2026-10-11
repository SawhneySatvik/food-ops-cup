"""Supplier negotiation (T-055; ledger R45 F4): rules bound the moves (`policy`), the AI picks among them (`chooser`),
replies are read only by the no-tools extractor (`extract`), deal review and the PO draft are code (`review`), the A2A
client sits behind `SupplierPort` (`port`), and `run.negotiate` ties them together. Suppliers are simulated (R22).
"""
