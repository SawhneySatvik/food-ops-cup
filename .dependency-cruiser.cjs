// Repo boundaries, 03-architecture §7. Run via `make boundaries` (scripts/check/boundaries.sh).
// Red-proven by scripts/check/planted-violations.sh: each rule below has a plant that must trip it by name.
// Service test files: services/<svc>/test/** and colocated services/<svc>/src/**/*.test.ts.
const TEST_FILES = "^services/[^/]+/test/|^services/[^/]+/src/.*\\.test\\.ts$";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "web-imports-only-public-packages",
      comment: "apps/web may import only @munim/sdk, @munim/ui, @munim/contracts (and npm deps).",
      severity: "error",
      from: { path: "^apps/web/" },
      to: {
        path: "^(services|adapters|tools|db|e2e|evals|infra|scripts)/|^packages/",
        pathNot: "^packages/(sdk|ui|contracts)/",
      },
    },
    {
      name: "web-imports-only-public-packages-unresolved",
      comment: "An undeclared @munim/* import from apps/web is still a boundary breach.",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { couldNotResolve: true, path: "^@munim/", pathNot: "^@munim/(sdk|ui|contracts)(/|$)" },
    },
    {
      name: "core-api-modules-via-index-only",
      comment: "src/modules/<a>/** may import src/modules/<b>/** only through src/modules/<b>/index.ts.",
      severity: "error",
      from: { path: "^services/core-api/src/modules/([^/]+)/" },
      to: {
        path: "^services/core-api/src/modules/[^/]+/",
        pathNot: ["^services/core-api/src/modules/$1/", "^services/core-api/src/modules/[^/]+/index\\.ts$"],
      },
    },
    {
      name: "adapters-dev-only-from-dev-root",
      comment: "Dev adapters (the dev host etc.) never leave adapters/dev except through a dev composition root (R9).",
      severity: "error",
      from: { pathNot: ["^adapters/dev/", "^services/[^/]+/src/dev-root\\.ts$", TEST_FILES] },
      to: { path: "^adapters/dev/" },
    },
    {
      name: "tests-import-only-idp-local-from-adapters-dev",
      comment: "Service tests may sign test JWTs with the local dev IdP and nothing else from adapters/dev (W1 fix #72).",
      severity: "error",
      from: { path: TEST_FILES },
      to: { path: "^adapters/dev/", pathNot: "^adapters/dev/idp-local/" },
    },
    {
      name: "no-unresolvable-imports",
      comment: "An import that cannot be resolved cannot be boundary-checked.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(node_modules|\\.next|dist|contracts_gen)/" },
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
  },
};
