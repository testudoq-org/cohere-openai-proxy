/**
 * Tests for Cohere Model Capability Detection
 * 
 * Verifies that the supportsTools function correctly identifies
 * which models support tool calling and respects environment overrides.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  supportsTools,
  getModelCapabilities,
  stripToolsIfUnsupported,
  parseEnvList,
  TOOL_CAPABLE_MODELS,
  NON_TOOL_MODELS,
} from '../src/utils/cohereModelCapabilities.mjs';

describe('cohereModelCapabilities', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear environment overrides before each test
    delete process.env.COHERE_FORCE_STRIP_TOOLS;
    delete process.env.COHERE_TOOL_CAPABLE_MODELS;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('TOOL_CAPABLE_MODELS Set', () => {
    it('should include current recommended tool-use models', () => {
      expect(TOOL_CAPABLE_MODELS.has('command-a-03-2025')).toBe(true);
      expect(TOOL_CAPABLE_MODELS.has('command-r7b-12-2024')).toBe(true);
      expect(TOOL_CAPABLE_MODELS.has('command-r-08-2024')).toBe(true);
      expect(TOOL_CAPABLE_MODELS.has('command-r-plus-08-2024')).toBe(true);
    });

    it('should include legacy aliases', () => {
      expect(TOOL_CAPABLE_MODELS.has('command-r')).toBe(true);
      expect(TOOL_CAPABLE_MODELS.has('command-r-plus')).toBe(true);
      expect(TOOL_CAPABLE_MODELS.has('command-nightly')).toBe(true);
    });
  });

  describe('NON_TOOL_MODELS Set', () => {
    it('should include vision models', () => {
      expect(NON_TOOL_MODELS.has('command-a-vision-07-2025')).toBe(true);
    });

    it('should include translation model', () => {
      expect(NON_TOOL_MODELS.has('command-a-translate-08-2025')).toBe(true);
    });

    it('should include aya models', () => {
      expect(NON_TOOL_MODELS.has('c4ai-aya-expanse-8b')).toBe(true);
      expect(NON_TOOL_MODELS.has('c4ai-aya-vision-32b')).toBe(true);
    });
  });

  describe('supportsTools()', () => {
    describe('known tool-capable models', () => {
      const toolCapableModels = [
        'command-a-03-2025',
        'command-r7b-12-2024',
        'command-r-08-2024',
        'command-r-plus-08-2024',
        'command-r',
        'command-r-plus',
        'command-nightly',
      ];

      it.each(toolCapableModels)('should return true for %s', (model) => {
        expect(supportsTools(model)).toBe(true);
      });

      it('should be case-insensitive', () => {
        expect(supportsTools('COMMAND-R-08-2024')).toBe(true);
        expect(supportsTools('Command-R-Plus-08-2024')).toBe(true);
      });

      it('should handle whitespace', () => {
        expect(supportsTools('  command-r-08-2024  ')).toBe(true);
      });
    });

    describe('known non-tool models', () => {
      const nonToolModels = [
        'command-a-vision-07-2025',
        'command-a-translate-08-2025',
        'command-a-reasoning-08-2025',
        'command',
        'command-light',
        'c4ai-aya-expanse-8b',
        'c4ai-aya-vision-32b',
      ];

      it.each(nonToolModels)('should return false for %s', (model) => {
        expect(supportsTools(model)).toBe(false);
      });
    });

    describe('unknown models with pattern matching', () => {
      it('should return true for command-r pattern variants', () => {
        expect(supportsTools('command-r-99-2099')).toBe(true);
        expect(supportsTools('command-r-plus-99-2099')).toBe(true);
        expect(supportsTools('command-r7b-99-2099')).toBe(true);
      });

      it('should return false for vision/embed/translate patterns', () => {
        expect(supportsTools('some-new-vision-model')).toBe(false);
        expect(supportsTools('cohere-embed-v5')).toBe(false);
        expect(supportsTools('translate-enhanced')).toBe(false);
        expect(supportsTools('c4ai-aya-new-model')).toBe(false);
      });

      it('should return false for completely unknown models (safe default)', () => {
        expect(supportsTools('some-random-model')).toBe(false);
        expect(supportsTools('unknown-model-2030')).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should return false for null/undefined', () => {
        expect(supportsTools(null)).toBe(false);
        expect(supportsTools(undefined)).toBe(false);
      });

      it('should return false for non-string input', () => {
        expect(supportsTools(123)).toBe(false);
        expect(supportsTools({})).toBe(false);
        expect(supportsTools([])).toBe(false);
      });

      it('should return false for empty string', () => {
        expect(supportsTools('')).toBe(false);
        expect(supportsTools('   ')).toBe(false);
      });
    });

    describe('environment variable overrides', () => {
      describe('COHERE_FORCE_STRIP_TOOLS', () => {
        it.each(['1', 'true', 'yes', 'TRUE', 'YES'])('should return false when set to %s', (value) => {
          process.env.COHERE_FORCE_STRIP_TOOLS = value;
          expect(supportsTools('command-r-08-2024')).toBe(false);
        });

        it.each(['0', 'false', 'no', ''])('should allow tools when set to %s', (value) => {
          process.env.COHERE_FORCE_STRIP_TOOLS = value;
          expect(supportsTools('command-r-08-2024')).toBe(true);
        });
      });

      describe('COHERE_TOOL_CAPABLE_MODELS', () => {
        it('should use env list exclusively when provided', () => {
          process.env.COHERE_TOOL_CAPABLE_MODELS = 'custom-model-1,custom-model-2';
          
          // Custom models should work
          expect(supportsTools('custom-model-1')).toBe(true);
          expect(supportsTools('custom-model-2')).toBe(true);
          
          // Default capable models should NOT work when env list is provided
          expect(supportsTools('command-r-08-2024')).toBe(false);
        });

        it('should support wildcard matching', () => {
          process.env.COHERE_TOOL_CAPABLE_MODELS = 'custom-*,*-special';
          
          expect(supportsTools('custom-model')).toBe(true);
          expect(supportsTools('custom-anything')).toBe(true);
          expect(supportsTools('my-special')).toBe(true);
          expect(supportsTools('unmatched-model')).toBe(false);
        });

        it('should handle mixed exact and wildcard entries', () => {
          process.env.COHERE_TOOL_CAPABLE_MODELS = 'exact-model,prefix-*,*-suffix';
          
          expect(supportsTools('exact-model')).toBe(true);
          expect(supportsTools('prefix-anything')).toBe(true);
          expect(supportsTools('anything-suffix')).toBe(true);
          expect(supportsTools('no-match')).toBe(false);
        });

        it('should be case-insensitive', () => {
          process.env.COHERE_TOOL_CAPABLE_MODELS = 'My-Custom-Model';
          expect(supportsTools('my-custom-model')).toBe(true);
          expect(supportsTools('MY-CUSTOM-MODEL')).toBe(true);
        });
      });
    });
  });

  describe('parseEnvList()', () => {
    it('should parse comma-separated values', () => {
      expect(parseEnvList('a,b,c')).toEqual(['a', 'b', 'c']);
    });

    it('should trim whitespace', () => {
      expect(parseEnvList('  a  ,  b  ,  c  ')).toEqual(['a', 'b', 'c']);
    });

    it('should lowercase values', () => {
      expect(parseEnvList('ABC,DEF')).toEqual(['abc', 'def']);
    });

    it('should filter empty values', () => {
      expect(parseEnvList('a,,b,  ,c')).toEqual(['a', 'b', 'c']);
    });

    it('should return empty array for empty input', () => {
      expect(parseEnvList('')).toEqual([]);
      expect(parseEnvList(null)).toEqual([]);
      expect(parseEnvList(undefined)).toEqual([]);
    });
  });

  describe('getModelCapabilities()', () => {
    it('should return correct capabilities for tool-capable model', () => {
      const caps = getModelCapabilities('command-r-08-2024');
      
      expect(caps.model).toBe('command-r-08-2024');
      expect(caps.supportsTools).toBe(true);
      expect(caps.isKnownToolCapable).toBe(true);
      expect(caps.isKnownNonTool).toBe(false);
      expect(caps.isUnknown).toBe(false);
    });

    it('should return correct capabilities for non-tool model', () => {
      const caps = getModelCapabilities('command-a-vision-07-2025');
      
      expect(caps.model).toBe('command-a-vision-07-2025');
      expect(caps.supportsTools).toBe(false);
      expect(caps.isKnownToolCapable).toBe(false);
      expect(caps.isKnownNonTool).toBe(true);
      expect(caps.isUnknown).toBe(false);
    });

    it('should return correct capabilities for unknown model', () => {
      const caps = getModelCapabilities('some-unknown-model');
      
      expect(caps.model).toBe('some-unknown-model');
      expect(caps.supportsTools).toBe(false);
      expect(caps.isKnownToolCapable).toBe(false);
      expect(caps.isKnownNonTool).toBe(false);
      expect(caps.isUnknown).toBe(true);
    });
  });

  describe('stripToolsIfUnsupported()', () => {
    const mockTools = [
      { type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: {} } },
      { type: 'function', function: { name: 'search', description: 'Search', parameters: {} } },
    ];

    const mockRequestWithTools = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: mockTools,
      tool_choice: 'auto',
    };

    it('should not modify request for tool-capable model', () => {
      const result = stripToolsIfUnsupported(mockRequestWithTools, 'command-r-08-2024');
      
      expect(result.tools).toEqual(mockTools);
      expect(result.tool_choice).toBe('auto');
    });

    it('should strip tools for non-tool model', () => {
      const result = stripToolsIfUnsupported(mockRequestWithTools, 'command-a-vision-07-2025');
      
      expect(result.tools).toBeUndefined();
      expect(result.tool_choice).toBeUndefined();
      // Other properties preserved
      expect(result.model).toBe('gpt-4');
      expect(result.messages).toEqual(mockRequestWithTools.messages);
    });

    it('should strip parallel_tool_calls for non-tool model', () => {
      const reqWithParallel = {
        ...mockRequestWithTools,
        parallel_tool_calls: true,
      };
      const result = stripToolsIfUnsupported(reqWithParallel, 'command-a-vision-07-2025');
      
      expect(result.parallel_tool_calls).toBeUndefined();
    });

    it('should not modify request without tools', () => {
      const reqNoTools = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const result = stripToolsIfUnsupported(reqNoTools, 'command-a-vision-07-2025');
      
      expect(result).toEqual(reqNoTools);
    });

    it('should handle empty tools array', () => {
      const reqEmptyTools = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [],
      };
      const result = stripToolsIfUnsupported(reqEmptyTools, 'command-a-vision-07-2025');
      
      expect(result.tools).toEqual([]); // Empty array preserved, not stripped
    });

    it('should handle null/undefined input', () => {
      expect(stripToolsIfUnsupported(null, 'command-r-08-2024')).toBeNull();
      expect(stripToolsIfUnsupported(undefined, 'command-r-08-2024')).toBeUndefined();
    });

    it('should call logger when stripping tools', () => {
      const mockLogger = { info: vi.fn() };
      
      stripToolsIfUnsupported(mockRequestWithTools, 'command-a-vision-07-2025', mockLogger);
      
      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          targetModel: 'command-a-vision-07-2025',
          toolCount: 2,
          toolNames: ['get_weather', 'search'],
          reason: 'model_does_not_support_tools',
          action: 'tools_stripped',
        }),
        'Automatically stripped tools - model does not support tool calling'
      );
    });
  });
});
