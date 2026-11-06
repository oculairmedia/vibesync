import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

const layerRestrictions = (patterns) => ({
  paths: patterns.map((name) => ({
    name,
    message: 'Respect the model -> beads -> runtime -> dispatch -> scheduler/extensions -> app dependency order.',
  })),
});

export default tseslint.config(
  {
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
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node, ...globals.es2021 } },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.ts'],
  })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node, ...globals.es2021 },
    },
    plugins: { import: importPlugin },
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      'no-console': 'off',
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'no-throw-literal': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'import/no-cycle': ['error', { maxDepth: Infinity }],
      // Existing findings are baselined in eslint-baseline.json. CI fails on
      // additions while the baseline is reduced as violations are fixed.
    },
  },
  {
    files: ['src/engine/model/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', layerRestrictions(['../beads/**', '../runtime/**', '../dispatcher/**', '../scheduler/**', '../app/**'])],
    },
  },
  {
    files: ['src/engine/beads/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', layerRestrictions(['../runtime/**', '../dispatcher/**', '../scheduler/**', '../app/**'])],
    },
  },
  {
    files: ['src/engine/runtime/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', layerRestrictions(['../dispatcher/**', '../scheduler/**', '../app/**'])],
    },
  },
  {
    files: ['src/engine/dispatcher/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', layerRestrictions(['../scheduler/**', '../app/**'])],
    },
  },
  {
    files: ['src/engine/scheduler/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', layerRestrictions(['../app/**'])],
    },
  },
);
