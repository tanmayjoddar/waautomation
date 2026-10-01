// Reports only WHICH keys are present in .env. Never prints a value.
//
// For the two Supabase keys it also prints the key *shape*, because a
// publishable/anon key in the service-role slot is the usual cause of
// "row-level security policy" errors when seeding.
import { readFileSync } from 'node:fs';
import { EnvError, loadEnvFromFile, parseDotEnv, supabaseKeyRole } from '../src/config.js';

const text = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const env = parseDotEnv(text);
for (const key of Object.keys(env).sort()) {
  console.log(`${key}: ${env[key] ? 'set' : 'empty'}`);
}

/** Prints the role a key acts as. Never prints key material. */
const keyShape = (label: string, key: string | undefined): void => {
  if (!key) {
    console.log(`${label}: EMPTY`);
    return;
  }
  const role = supabaseKeyRole(key);
  console.log(`${label}: ${role === 'unknown' ? 'unrecognised format' : role} role`);
};

console.log('--- Supabase key shapes ---');
keyShape('SUPABASE_SERVICE_ROLE_KEY', env.SUPABASE_SERVICE_ROLE_KEY);
keyShape('SUPABASE_ANON_KEY', env.SUPABASE_ANON_KEY);

if (supabaseKeyRole(env.SUPABASE_SERVICE_ROLE_KEY) === 'anon') {
  console.log('  ^ this key cannot bypass RLS, so the seed and every server write will fail.');
  console.log('    Fix: Project Settings -> API Keys -> the secret key.');
}
if (supabaseKeyRole(env.SUPABASE_ANON_KEY) === 'service_role') {
  console.log('  ^ this key bypasses RLS and must never reach a browser or dashboard.');
  console.log('    Fix: use the publishable (anon) key for SUPABASE_ANON_KEY.');
}

console.log('--- config validity ---');
try {
  loadEnvFromFile('.env');
  console.log('ok: the app will start with this .env');
} catch (error) {
  if (error instanceof EnvError) {
    for (const problem of error.problems) console.log(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}