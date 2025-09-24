#!/usr/bin/env node
/**
 * Helper script to exercise callCohereChatAPI for profiling with clinic.js.
 *
 * Usage (recommended):
 *   npx clinic flame -- node --enable-source-maps scripts/profile-cohere.mjs
 *
 * Ensure COHERE_API_KEY is set in your environment before running.
 * This script performs multiple sequential chat calls to produce a representative profile.
 */

import 'dotenv/config';
import { createCohereClient, callCohereChatAPI } from '../src/utils/cohereClientFactory.mjs';

const token = process.env.COHERE_API_KEY || process.env.COHERE_TOKEN || process.env.COHERE_KEY;
if (!token) {
  console.error('Missing Cohere API token. Set COHERE_API_KEY (or COHERE_TOKEN).');
  process.exit(1);
}

(async () => {
  try {
    const { client } = await createCohereClient({ token });
    const payload = {
      model: process.env.COHERE_MODEL || 'command-a-03-2025',
      message: 'Profile run: please reply briefly.',
      max_tokens: 16,
      temperature: 0.0,
    };

    console.log('Starting profiling run (calls will be made sequentially)...');
    // Warm-up
    try { await callCohereChatAPI(client, payload); } catch (e) { /* ignore warm-up errors */ }

    const iterations = Number(process.env.PROFILE_ITERATIONS) || 20;
    for (let i = 0; i < iterations; i++) {
      try {
        const res = await callCohereChatAPI(client, payload);
        process.stdout.write('.');
      } catch (err) {
        process.stdout.write('E');
        console.error('\nCall error:', err && err.message ? err.message : err);
      }
    }
    console.log('\nProfiling run complete.');
  } catch (err) {
    console.error('Fatal error during profiling run:', err);
    process.exit(1);
  }
})();