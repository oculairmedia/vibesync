import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The engine's packages in dependency order (vibesync-9lzk.59.1). A package may
 * import from its own layer's other packages only through their index, and from
 * any lower layer; never from a higher one. Every directory under src/engine
 * must appear here exactly once: tests/unit/engine-layers.test.ts fails otherwise.
 * boot.ts (the composition root) is the one file allowed to import every layer.
 */
export const ENGINE_LAYERS = [
  ['contracts', 'events', 'retry', 'runtime', 'store', 'verdict'],
  ['molecule', 'formula', 'packs'],
  ['beads'],
  ['escalation', 'pm-wake', 'refinery', 'waits'],
  ['dispatcher'],
  ['scheduler'],
];

/**
 * no-restricted-imports matches the import string, not the file it resolves to,
 * so a pattern written for one folder depth misses an importer one folder
 * deeper (`../beads/**` does not match `../../beads/x.js` from
 * src/engine/runtime/iroh/). Every pattern is therefore generated for each depth
 * a package's files can sit at: one folder for every level of nesting.
 */
export const ENGINE_MAX_NESTING = 3;
const upTo = (depth) => '../'.repeat(depth);

const engineLayerRules = ENGINE_LAYERS.flatMap((packages, layer) => {
  const higher = ENGINE_LAYERS.slice(layer + 1).flat();
  return packages.map((pkg) => {
    const group = [];
    for (let depth = 1; depth <= ENGINE_MAX_NESTING; depth++) {
      group.push(...higher.map((h) => `${upTo(depth)}${h}/**`), `${upTo(depth)}boot`, `${upTo(depth)}boot.js`, `${upTo(depth + 1)}app/**`);
    }
    return {
      files: [`src/engine/${pkg}/**/*.ts`],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [{
            group,
            message: `${pkg} is in engine layer ${layer}; it may not import ${higher.length ? higher.join(', ') + ', ' : ''}boot or src/app. See ENGINE_LAYERS in eslint.config.js.`,
          }],
        }],
      },
    };
  });
});

export default [
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    rules: {
      // Error prevention
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off', // Allow console for CLI/server apps
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',

      // Code quality
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'warn',
      'prefer-arrow-callback': 'warn',
      'no-throw-literal': 'error',

      // Style (relaxed for existing codebase)
      'semi': ['warn', 'always'],
      'quotes': ['warn', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
      'comma-dangle': ['warn', 'always-multiline'],
      'no-trailing-spaces': 'warn',
      'no-multiple-empty-lines': ['warn', { max: 2, maxEOF: 1 }],
    },
  },
  {
    // Test files - more relaxed rules
    files: ['tests/**/*.js', '**/*.test.js', '**/*.spec.js'],
    rules: {
      'no-unused-vars': 'off', // Test helpers may appear unused
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
  })),
  ...engineLayerRules,
  {
    // Ignore patterns
    ignores: [
      'node_modules/**',
      'coverage/**',
      'html/**',
      'dist/**',
      'temporal/dist/**',
      '.beads/**',
      'data/**',
      'ui/**',
      'vibe-kanban-source/**',
      '.next/**',
    ],
  },
];
