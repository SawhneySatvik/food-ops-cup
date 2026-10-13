import { StateNotFound } from "@munim/ui";

// S-404 (gotcha 16): one generic page for every bad link or key — it never says why.
export default function NotFound() {
  return <StateNotFound />;
}
