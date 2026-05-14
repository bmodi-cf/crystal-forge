// eslint.config.mjs
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import noPrismaOutsideServices from "./eslint-rules/no-prisma-outside-services.js";
import noOctokitOutsideGithub from "./eslint-rules/no-octokit-outside-github.js";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    plugins: {
      "crystal-forge": {
        rules: {
          "no-prisma-outside-services": noPrismaOutsideServices,
          "no-octokit-outside-github": noOctokitOutsideGithub,
        },
      },
    },
    rules: {
      "crystal-forge/no-prisma-outside-services": "error",
      "crystal-forge/no-octokit-outside-github": "error",
      // React 19's new rule is over-aggressive for legitimate patterns
      // (e.g. setting "connecting" state at the top of a connect effect).
      // Keep it as a signal but don't block CI on it.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  {
    // E2E test fixtures are intentionally CommonJS Node scripts that get
    // exec'd as subprocesses. Allow require() inside them.
    files: ["tests/e2e/fixtures/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "eslint-rules/**",
  ]),
]);

export default eslintConfig;
