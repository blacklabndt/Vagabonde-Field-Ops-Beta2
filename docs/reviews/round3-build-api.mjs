import { fileURLToPath } from 'node:url';
import { build } from '../../vite-app/node_modules/vite/dist/node/index.js';
import config from '../../vite-app/vite.config.js';
process.chdir(fileURLToPath(new URL('../../vite-app/', import.meta.url)));
await build({ ...config, configFile: false });
