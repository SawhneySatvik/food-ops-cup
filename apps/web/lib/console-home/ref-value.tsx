"use client";
// One proposed number = one ref, rendered by the ONE ref renderer (RefText, design-system §7): a one-segment envelope
// whose text is the ref token, with the value core resolved for it. The value shows as an evidence chip formatted by the
// pack (unit from the cited column's suffix) that opens its snapshot rows; an unresolved ref reads "cannot verify".
// No number reaches the screen any other way from here.
import { RefText, type FormatSpec, type ResolvedRef } from "@munim/ui";
import { useMemo } from "react";

export function RefValue({ token, resolved, format }: { token: string; resolved: readonly ResolvedRef[]; format: FormatSpec }) {
  const envelope = useMemo(() => ({ abstained: false, segments: [{ text: token, refs: [] }] }), [token]);
  return (
    <div className="ch-refvalue" data-ref-value="">
      <RefText envelope={envelope} resolved={resolved} format={format} />
    </div>
  );
}
