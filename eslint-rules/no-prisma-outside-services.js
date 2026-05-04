const path = require('path');

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow importing Prisma outside lib/services/*.' },
    messages: {
      forbiddenImport:
        'Prisma client may only be imported from lib/services/*. Move database access into a service function.',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    const normalised = filename.replace(/\\/g, '/');
    const isService = /\/lib\/services\//.test(normalised) || /\/lib\/services\.[tj]sx?$/.test(normalised);
    const isPrismaItself = /\/lib\/prisma\.[tj]sx?$/.test(normalised);
    const isPrismaSeed = /\/prisma\/seed\.[tj]sx?$/.test(normalised);
    const isTestHelper = /\/lib\/test\//.test(normalised);

    if (isService || isPrismaItself || isPrismaSeed || isTestHelper) {
      return {};
    }

    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== 'string') return;
        // Type-only imports (`import type { ... }`) are erased at build time
        // and do not constitute runtime DB access. Allow them anywhere so
        // shared type aliases (e.g. Prisma.ForgeWhereInput in lib/acl.ts)
        // don't have to live inside lib/services/*.
        if (node.importKind === 'type') return;
        if (
          source === '@/lib/prisma' ||
          source.endsWith('/lib/prisma') ||
          source === '@prisma/client' ||
          /^(\.\.\/)+(?:lib\/)?prisma$/.test(source)
        ) {
          context.report({ node, messageId: 'forbiddenImport' });
        }
      },
    };
  },
};
