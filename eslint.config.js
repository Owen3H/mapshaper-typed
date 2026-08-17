import { defineConfig } from "eslint/config"
import eslintJs from "@eslint/js"

export default defineConfig([
	{
		files: ["**/*.js", "**/*.mjs"],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
			globals: {
				VERSION: "readonly",
				window: "readonly",
				document: "readonly",
				console: "readonly",
				process: "readonly",
				Buffer: "readonly",
			},
		},
		...eslintJs.configs.recommended,
		rules: {
			"no-prototype-builtins": "off",
			"no-control-regex": "off",
			"no-empty": "off",
			"no-constant-condition": "off",
			"no-unused-vars": "off",
			"linebreak-style": ["error", "unix"],
			indent: "off",
			quotes: "off",
			semi: ["error", "always"]
		}
	}
])