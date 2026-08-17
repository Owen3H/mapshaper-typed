import { registerHooks } from 'node:module';

registerHooks('./_loader.mjs', import.meta.url);
