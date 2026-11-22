import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ESLint 配置（整改报告 P2-11）
 *
 * 目标：先能跑起来、不误报，规则以「不崩、不漏掉明显问题」为主。
 * 类型相关的高级规则（type-checked）不开，避免拖慢检查。
 */
export default tseslint.config(
  {
    ignores: [
      ".next/**",
      ".next-old/**",
      ".next-broken/**",
      ".next-build-old/**",
      "node_modules/**",
      ".tmp/**",
      "data/**",
      "next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mjs}"],
    languageOptions: {
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        // Node
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        __dirname: "readonly",
        // 浏览器
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        atob: "readonly",
        btoa: "readonly",
        MouseEvent: "readonly",
        KeyboardEvent: "readonly",
        HTMLElement: "readonly",
        Node: "readonly",
        File: "readonly",
        Blob: "readonly",
        React: "readonly",
      },
    },
    rules: {
      /* 类型/未使用变量：只警告，不阻塞构建（大量 as any 与下划线参数） */
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      /* 业务代码里大量用的模式，关掉避免噪音 */
      "no-empty": ["error", { allowEmptyCatch: true }],
      /* 历史文件里有全角空格，降级为警告 */
      "no-irregular-whitespace": "warn",
      "no-useless-assignment": "warn",
      "no-useless-catch": "warn",
      "no-constant-condition": "warn",
      "prefer-const": "warn",
      eqeqeq: ["warn", "smart"],
      /* 安全类：保留为错误 */
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    /* 脚本允许 console 与 require 风格 */
    files: ["scripts/**/*.mjs"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  }
);
