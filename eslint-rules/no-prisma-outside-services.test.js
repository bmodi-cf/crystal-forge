import { RuleTester } from 'eslint';
import rule from './no-prisma-outside-services.js';
import { describe, it } from 'vitest';

// Bridge ESLint's RuleTester to vitest so its internal describe/it calls
// resolve to vitest's suite/test and not the (unset) defaults.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

tester.run('no-prisma-outside-services', rule, {
  valid: [
    { filename: '/repo/lib/services/forges.ts', code: "import { prisma } from '@/lib/prisma';" },
    { filename: '/repo/lib/services/users.ts', code: "import { prisma } from '../prisma';" },
    { filename: '/repo/app/dashboard/page.tsx', code: "import { listForges } from '@/lib/services/forges';" },
  ],
  invalid: [
    {
      filename: '/repo/app/dashboard/page.tsx',
      code: "import { prisma } from '@/lib/prisma';",
      errors: [{ messageId: 'forbiddenImport' }],
    },
    {
      filename: '/repo/components/Foo.tsx',
      code: "import { prisma } from '../lib/prisma';",
      errors: [{ messageId: 'forbiddenImport' }],
    },
  ],
});
