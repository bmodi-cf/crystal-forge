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
