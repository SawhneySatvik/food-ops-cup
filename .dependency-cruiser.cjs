// Repo boundaries, 03-architecture §7. Run via `make boundaries` (scripts/check/boundaries.sh).
// Red-proven by scripts/check/planted-violations.sh: each rule below has a plant that must trip it by name.
const WEB_FORBIDDEN = "^(services|adapters|tools|db|e2e|evals|infra|scripts)/|^packages/";
const WEB_PUBLIC = "^packages/(sdk|ui|contracts)/";
// apps/web's server code (lib/server) may also reach its sign-in grants: Identity Platform's, and a development
// checkout's own (`@munim-dev/web-signin`, resolved by tsconfig paths; the Cup export has no adapters/dev).
const WEB_SERVER_GRANTS = ["^adapters/gcp/idp-identity-platform/", "^adapters/dev/env/web-signin\\.ts$"];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "web-imports-only-public-packages",
      comment: "apps/web may import only @munim/sdk, @munim/ui, @munim/contracts (and npm deps); lib/server also its sign-in grants.",
      severity: "error",
      from: { path: "^apps/web/", pathNot: "^apps/web/lib/server/" },
      to: { path: WEB_FORBIDDEN, pathNot: WEB_PUBLIC },
    },
    {
      name: "web-server-imports-only-public-packages-and-grants",
      comment: "apps/web/lib/server: the public packages plus the sign-in grants, nothing else from the repo.",
      severity: "error",
      from: { path: "^apps/web/lib/server/" },
      to: { path: WEB_FORBIDDEN, pathNot: [WEB_PUBLIC, ...WEB_SERVER_GRANTS] },
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
      name: "adapters-dev-stays-in-adapters-dev",
      comment:
        "Dev adapters (the hosted dev database's IdP and storage, the dev env names) are reached only from adapters/dev itself, " +
        "config's dev-mapping test, and apps/web's one dev grant; packages/config loads the mapping by a computed path (T-122, R54 P-4).",
      severity: "error",
      from: { pathNot: ["^adapters/dev/", "^packages/config/test/dev-env\\.test\\.ts$", "^apps/web/lib/server/"] },
      to: { path: "^adapters/dev/" },
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
    // For apps/web's "@/*" path (the only tsconfig paths entry in the repo).
    tsConfig: { fileName: "tsconfig.depcruise.json" },
    combinedDependencies: false,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
  },
};
