"""Ingestion (T-056; 04-agent-framework §8; ADR-014 §6.4): documents and chats → chunks, 768-d embeddings and claims; an
invoice image → a `purchasing.invoice.record.v1` draft whose numbers are document spans; a new import layout → a
`map.columns` rename suggestion from its headers alone. Every write goes through core's `/internal/intel/v1` (R25).

The extractor and vision models are quarantined (project rule 8): no tools, a response schema, and their output is
data checked by code — a claim's quote must be its source's text, a value on a draft must be a span of the page.
"""
