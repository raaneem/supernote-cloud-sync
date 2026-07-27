import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "benchmarks/baselines/**",
      "benchmarks/private/**",
      "benchmarks/results/**",
      "main.js",
      "node_modules/**",
    ],
  },
  {
    ...eslint.configs.recommended,
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["benchmarks/**/*.cjs", "src/shared/desktop-command.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  prettier,
);
