import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const layerRestrictions = (patterns) => ({
  patterns: [{
    group: patterns,
    message: 'Respect the model -> beads -> runtime -> dispatch -> scheduler/extensions -> app dependency order.',
  }],
});

const forbiddenHigherLayers = {
  model: ['../beads/**', '../runtime/**', '../dispatcher/**', '../scheduler/**', '../app/**'],
  beads: ['../runtime/**', '../dispatcher/**', '../scheduler/**', '../app/**'],
  runtime: ['../dispatcher/**', '../scheduler/**', '../app/**'],
  dispatcher: ['../scheduler/**', '../app/**'],
  scheduler: ['../app/**'],
};

const engineLayerRules = Object.entries(forbiddenHigherLayers).map(([layer, patterns]) => ({
  files: [`src/engine/${layer}/**/*.ts`],
  rules: { 'no-restricted-imports': ['error', layerRestrictions(patterns)] },
}));

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
    files: ['src/app/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', layerRestrictions(['../app/**', '../../app/**'])],
    },
  },
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
