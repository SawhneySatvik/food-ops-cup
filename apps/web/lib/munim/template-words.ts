// file: lib/munim/template-words.ts
// Plain words for snapshot templates: the snapshot drawer's `label` (02 §4). Owner home and the inbox (12) and Ask
// Munim (13) use it. A template not listed here shows its id.
const WORDS: Record<string, string> = {
  "kitchen.ticket_coverage": "Kitchen tickets",
  "kitchen.ticket_times": "Kitchen ticket times",
  "kitchen.prep_need": "What to prep",
  "people.labour_pct": "Labour and net sales by week",
  "inventory.waste_week": "Waste this week",
  "inventory.below_reorder": "Stock below its minimum",
  "purchasing.quote_compare": "Quotes from simulated suppliers",
  "cares.impact": "Food shared",
  "inventory.expiry_risk": "Stock close to its use-by date",
  "cares.recipient_match": "Simulated recipients that can take this food",
  "inventory.shortfall": "Stock short of what is needed",
  "purchasing.price_creep": "Supplier prices over time",
  "purchasing.deal_inputs": "What a quote was checked against",
};

export const templateWords = (templateId: string): string => WORDS[templateId] ?? templateId;
