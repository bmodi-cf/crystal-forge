// eslint-rules/no-octokit-outside-github.js
/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow importing @octokit/* outside lib/github/* — go through the GitHubClient interface.',
    },
    messages: {
      forbiddenImport:
        '@octokit/* may only be imported from lib/github/*. Use getGitHubClient() instead.',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    const normalised = filename.replace(/\\/g, '/');
    const isGithubLib = /\/lib\/github\//.test(normalised);

    if (isGithubLib) {
      return {};
    }

    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== 'string') return;
        if (node.importKind === 'type') return;
        if (/^@octokit\//.test(source)) {
          context.report({ node, messageId: 'forbiddenImport' });
        }
      },
    };
  },
};
