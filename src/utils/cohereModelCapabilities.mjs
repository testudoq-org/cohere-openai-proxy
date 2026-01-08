/**
 * Cohere Model Capability Detection
 * 
 * Determines which Cohere models support tool calling (function calling).
 * Based on Cohere's official documentation.
 * 
 * @see https://docs.cohere.com/docs/tool-use
 * @see https://docs.cohere.com/docs/models
 * 
 * Supports env-based overrides:
 * - COHERE_FORCE_STRIP_TOOLS=true - Disable tools for all models
 * - COHERE_TOOL_CAPABLE_MODELS=model1,model2 - Override capable models list
 */

/**
 * Models confirmed to support tool calling based on Cohere documentation.
 * These are Command family models that explicitly support "tool use" or "function calling".
 */
export const TOOL_CAPABLE_MODELS = new Set([
  // Current recommended models for tool use
  'command-a-03-2025',
  'command-r7b-12-2024',
  'command-r-08-2024',
  'command-r-plus-08-2024',
  
  // Legacy aliases (deprecated Sept 15, 2025 but still functional)
  'command-r',
  'command-r-plus',
  'command-r-03-2024',
  'command-r-plus-04-2024',
  'command-nightly',
]);

/**
 * Models that explicitly do NOT support tool calling.
 * Vision, translation, reasoning, and simpler models without tool support.
 */
export const NON_TOOL_MODELS = new Set([
  // Vision models - image analysis only
  'command-a-vision-07-2025',
  
  // Translation model
  'command-a-translate-08-2025',
  
  // Reasoning model - may support tools in future, but not documented
  'command-a-reasoning-08-2025',
  
  // Deprecated simpler models
  'command',
  'command-light',
  'command-light-nightly',
  
  // Aya models - multilingual/vision, no tool use
  'c4ai-aya-expanse-8b',
  'c4ai-aya-expanse-32b',
  'c4ai-aya-vision-8b',
  'c4ai-aya-vision-32b',
]);

// Pattern matching for unknown models (fallback)
const TOOL_CAPABLE_PATTERNS = [
  /^command-r/i,
  /^command-r-plus/i,
  /^command-r7b/i,
];

// Patterns that indicate NO tool support
const NON_TOOL_PATTERNS = [
  /vision/i,
  /translate/i,
  /embed/i,
  /rerank/i,
  /aya/i,
];

export function parseEnvList(envVar) {
  if (!envVar) return [];
  return envVar.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Determines if a Cohere model supports tool calling (function calling).
 * 
 * @param {string} modelName - The Cohere model name/ID
 * @returns {boolean} - True if the model supports tool calling
 */
export function supportsTools(modelName) {
  if (!modelName || typeof modelName !== 'string') return false;
  
  const normalized = modelName.trim().toLowerCase();
  
  // Global force-strip override
  const forceStrip = String(process.env.COHERE_FORCE_STRIP_TOOLS || '').toLowerCase();
  if (['1', 'true', 'yes'].includes(forceStrip)) return false;

  // If explicit env list provided, use it exclusively
  const envList = parseEnvList(process.env.COHERE_TOOL_CAPABLE_MODELS);
  if (envList.length > 0) {
    for (const entry of envList) {
      if (entry === normalized) return true;
      // Support simple wildcard matching: prefix* or *suffix
      if (entry.includes('*')) {
        const parts = entry.split('*').filter(Boolean);
        if (parts.length === 0) continue;
        let matched = true;
        let startIndex = 0;
        for (const part of parts) {
          const idx = normalized.indexOf(part, startIndex);
          if (idx === -1) { matched = false; break; }
          startIndex = idx + part.length;
        }
        if (matched) return true;
      }
    }
    return false;
  }

  // Check explicit tool-capable list first
  if (TOOL_CAPABLE_MODELS.has(normalized)) {
    return true;
  }
  
  // Check explicit non-tool list
  if (NON_TOOL_MODELS.has(normalized)) {
    return false;
  }
  
  // Check non-tool patterns (vision, translate, embed, etc.)
  if (NON_TOOL_PATTERNS.some(re => re.test(normalized))) {
    return false;
  }
  
  // Check tool-capable patterns for unknown models
  if (TOOL_CAPABLE_PATTERNS.some(re => re.test(normalized))) {
    return true;
  }
  
  // Safe default: unknown models don't support tools
  return false;
}

/**
 * Gets detailed capability information about a model.
 * 
 * @param {string} modelName - The Cohere model name/ID
 * @returns {object} - Capability information
 */
export function getModelCapabilities(modelName) {
  const normalized = (modelName || '').trim().toLowerCase();
  
  return {
    model: modelName,
    supportsTools: supportsTools(modelName),
    isKnownToolCapable: TOOL_CAPABLE_MODELS.has(normalized),
    isKnownNonTool: NON_TOOL_MODELS.has(normalized),
    isUnknown: !TOOL_CAPABLE_MODELS.has(normalized) && !NON_TOOL_MODELS.has(normalized),
  };
}

/**
 * Strips tool-related parameters from an OpenAI-format request body
 * if the target Cohere model doesn't support tools.
 * 
 * @param {object} requestBody - The OpenAI-format request body
 * @param {string} targetModel - The Cohere model to use
 * @param {object} [logger] - Optional logger for debugging
 * @returns {object} - Modified request body (tools stripped if unsupported)
 */
export function stripToolsIfUnsupported(requestBody, targetModel, logger = null) {
  if (!requestBody || typeof requestBody !== 'object') {
    return requestBody;
  }
  
  const hasTools = requestBody.tools && Array.isArray(requestBody.tools) && requestBody.tools.length > 0;
  if (!hasTools) {
    return requestBody;
  }
  
  if (supportsTools(targetModel)) {
    return requestBody; // Model supports tools, keep them
  }
  
  // Model doesn't support tools - strip them
  const strippedBody = { ...requestBody };
  const toolCount = strippedBody.tools?.length || 0;
  const toolNames = (strippedBody.tools || []).map(t => t?.function?.name || t?.name || 'unknown').slice(0, 10);
  
  delete strippedBody.tools;
  delete strippedBody.tool_choice;
  delete strippedBody.parallel_tool_calls;
  
  if (logger && typeof logger.info === 'function') {
    logger.info({
      targetModel,
      toolCount,
      toolNames,
      reason: 'model_does_not_support_tools',
      action: 'tools_stripped'
    }, 'Automatically stripped tools - model does not support tool calling');
  }
  
  return strippedBody;
}

export function getDefaultToolCapablePatterns() {
  return [...TOOL_CAPABLE_PATTERNS];
}

export default {
  TOOL_CAPABLE_MODELS,
  NON_TOOL_MODELS,
  supportsTools,
  getModelCapabilities,
  stripToolsIfUnsupported,
};
