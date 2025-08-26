import { CohereClient } from 'cohere-ai';
import { httpsAgent as defaultHttpsAgent } from './httpAgent.mjs';

/**
 * Create a Cohere client, trying common agent option names for SDK compatibility.
 *
 * @param {object} params
 * @param {string} params.token - Cohere API token
 * @param {any} [params.agentOptions=defaultHttpsAgent] - agent/options to pass when attempting SDK construction
 * @param {object} [params.logger=console] - logger with .warn available
 * @returns {Promise<{client: any, acceptedAgentOption: 'agent'|'httpsAgent'|'none'}>}
 */
export async function createCohereClient({ token, agentOptions = defaultHttpsAgent, logger = console } = {}) {
  // Try 'agent' first
  try {
    const client = new CohereClient({ token, agent: agentOptions });
    return { client, acceptedAgentOption: 'agent' };
  } catch (e1) {
    // Try 'httpsAgent'
    try {
      const client = new CohereClient({ token, httpsAgent: agentOptions });
      return { client, acceptedAgentOption: 'httpsAgent' };
    } catch (e2) {
      // Final fallback to no agent
      try {
        logger?.warn?.('CohereClient did not accept agent options; falling back to default constructor.');
      } catch (e) {
        // ignore logger failures
      }
      const client = new CohereClient({ token });
      return { client, acceptedAgentOption: 'none' };
    }
  }
}