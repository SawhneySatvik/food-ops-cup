// Owner-typed display text is plain text; when none was set the slug is shown title-cased (kit 20 §3). Categories are
// plain slugs (gap G-01), so they only ever get the title-case fallback.
export const titleCase = (key: string): string =>
  key.replace(/^(item|variant|group|option)\./, "").replaceAll(/[._]+/g, " ").replace(/^./, (c) => c.toUpperCase());
export const labelOf = (x: { display_name: string | null; name_key: string }): string => x.display_name ?? titleCase(x.name_key);
