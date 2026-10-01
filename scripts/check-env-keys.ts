// Reports only WHICH keys are present in .env. Never prints a value.
import { readFileSync } from 'node:fs';
import { parseDotEnv } from '../src/config.js';

const text = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const env = parseDotEnv(text);
for (const key of Object.keys(env).sort()) {
  console.log(`${key}: ${env[key] ? 'set' : 'empty'}`);
}
