// eslint-rules/no-octokit-outside-github.test.js
import { RuleTester } from 'eslint';
import rule from './no-octokit-outside-github.js';
import { describe, it } from 'vitest';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

tester.run('no-octokit-outside-github', rule, {
  valid: [
    {
      filename: '/repo/lib/github/octokit-client.ts',
      code: "import { Octokit } from '@octokit/rest';",
    },
    {
      filename: '/repo/lib/github/fake-client.ts',
      code: "// no octokit import",
    },
    {
      filename: '/repo/lib/services/forges.ts',
      code: "import { getGitHubClient } from '@/lib/github/client';",
    },
  ],
  invalid: [
    {
      filename: '/repo/lib/services/forges.ts',
      code: "import { Octokit } from '@octokit/rest';",
      errors: [{ messageId: 'forbiddenImport' }],
    },
    {
      filename: '/repo/app/api/forges/route.ts',
      code: "import { createAppAuth } from '@octokit/auth-app';",
      errors: [{ messageId: 'forbiddenImport' }],
    },
  ],
});
