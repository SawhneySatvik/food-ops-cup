import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import Home from "../app/page";

// The deploy gates (T-011b) look for this exact marker on the live URL.
test("landing page shows the synthetic-demo marker and the simulation label", () => {
  const html = renderToStaticMarkup(<Home />);
  expect(html).toContain("Munim — synthetic demo");
  expect(html).toContain("Simulated suppliers · synthetic data");
});
