import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import noPrismaOutsideServices from "./eslint-rules/no-prisma-outside-services.js";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    plugins: {
      "crystal-forge": {
        rules: { "no-prisma-outside-services": noPrismaOutsideServices },
      },
    },
    rules: { "crystal-forge/no-prisma-outside-services": "error" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Custom rule source/tests are CJS/non-Next code that doesn't need linting.
    "eslint-rules/**",
  ]),
]);

export default eslintConfig;
