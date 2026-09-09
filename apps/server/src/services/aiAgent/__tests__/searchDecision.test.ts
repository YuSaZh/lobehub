import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MODEL_CAPABILITY_OVERRIDES_PATH_ENV,
  resetModelCapabilityOverridesCache,
} from '@/database/repositories/aiInfra/modelCapabilityOverrides';

import { resolveServerSearchDecision } from '../searchDecision';

describe('resolveServerSearchDecision', () => {
  it('does not borrow native search capability from another provider with the same model id', () => {
    const result = resolveServerSearchDecision({
      builtinModels: [
        {
          abilities: { search: true },
          id: 'grok-4.3',
          providerId: 'xai',
          settings: { searchImpl: 'params' },
        },
      ],
      chatConfig: { searchMode: 'on', useModelBuiltinSearch: true },
      model: 'grok-4.3',
      provider: 'custom-openai-compatible',
    });

    expect(result.useModelSearch).toBe(false);
    expect(result.useApplicationBuiltinSearchTool).toBe(true);
  });

  it('honors a stored abilities override that omits builtin search', () => {
    const result = resolveServerSearchDecision({
      builtinModels: [
        {
          abilities: { search: true },
          id: 'remote-model',
          providerId: 'custom-provider',
        },
      ],
      chatConfig: { searchMode: 'on', useModelBuiltinSearch: true },
      hasModelAbilitiesOverride: true,
      model: 'remote-model',
      provider: 'custom-provider',
    });

    expect(result.useModelSearch).toBe(false);
    expect(result.useApplicationBuiltinSearchTool).toBe(true);
  });

  it.each(['supergrok', 'openrouter'])(
    'uses %s provider search for an unlisted model',
    (provider) => {
      const result = resolveServerSearchDecision({
        builtinModels: [],
        chatConfig: { searchMode: 'on', useModelBuiltinSearch: true },
        model: 'new-remote-model',
        provider,
      });

      expect(result.isProviderHasBuiltinSearch).toBe(true);
      expect(result.useModelSearch).toBe(true);
      expect(result.useApplicationBuiltinSearchTool).toBe(false);
    },
  );

  it('uses explicit params search even when abilities.search is absent', () => {
    const result = resolveServerSearchDecision({
      builtinModels: [],
      chatConfig: { searchMode: 'on', useModelBuiltinSearch: true },
      model: 'remote-model',
      modelSearchImpl: 'params',
      provider: 'custom-provider',
    });

    expect(result.useModelSearch).toBe(true);
    expect(result.useApplicationBuiltinSearchTool).toBe(false);
  });

  it('infers internal search for a remotely discovered model', () => {
    const result = resolveServerSearchDecision({
      builtinModels: [],
      chatConfig: { searchMode: 'on' },
      model: 'jina-deepsearch-v1',
      modelSearchAbility: true,
      provider: 'jina',
    });

    expect(result.useModelSearch).toBe(true);
    expect(result.useApplicationBuiltinSearchTool).toBe(false);
  });

  it('disables both routes when search mode is off', () => {
    const result = resolveServerSearchDecision({
      builtinModels: [],
      chatConfig: { searchMode: 'off', useModelBuiltinSearch: true },
      model: 'remote-model',
      modelSearchImpl: 'internal',
      provider: 'custom-provider',
    });

    expect(result.useModelSearch).toBe(false);
    expect(result.useApplicationBuiltinSearchTool).toBe(false);
  });

  it('falls back to application search when selected native search is unsupported', () => {
    const result = resolveServerSearchDecision({
      builtinModels: [],
      chatConfig: { searchMode: 'on', useModelBuiltinSearch: true },
      model: 'remote-model',
      provider: 'custom-provider',
    });

    expect(result.useModelSearch).toBe(false);
    expect(result.useApplicationBuiltinSearchTool).toBe(true);
  });
});

// Isolate external override configuration from the developer's environment.
let directory: string;
let originalPath: string | undefined;
beforeEach(() => {
  originalPath = process.env[MODEL_CAPABILITY_OVERRIDES_PATH_ENV];
  delete process.env[MODEL_CAPABILITY_OVERRIDES_PATH_ENV];
  directory = mkdtempSync(path.join(tmpdir(), 'lobehub-search-overrides-'));
  resetModelCapabilityOverridesCache();
});
afterEach(() => {
  if (originalPath === undefined) delete process.env[MODEL_CAPABILITY_OVERRIDES_PATH_ENV];
  else process.env[MODEL_CAPABILITY_OVERRIDES_PATH_ENV] = originalPath;
  resetModelCapabilityOverridesCache();
  rmSync(directory, { force: true, recursive: true });
});

const writeOverrides = (models: unknown[]) => {
  const file = path.join(directory, 'overrides.json');
  writeFileSync(file, JSON.stringify({ version: 1, models }));
  process.env[MODEL_CAPABILITY_OVERRIDES_PATH_ENV] = file;
};
const searchInput = {
  builtinModels: [],
  chatConfig: { searchMode: 'auto' as const, useModelBuiltinSearch: true },
  hasModelAbilitiesOverride: true,
  model: 'gemini-3.8-flash',
  modelSearchAbility: false,
  provider: 'niniapi',
};

describe('external search capability overrides', () => {
  it.each([undefined, 'niniapi'])(
    'uses native search when the JSON rule overrides a stored false (%s)',
    (providerId) => {
      writeOverrides([{ providerId, modelId: searchInput.model, abilities: { search: true } }]);
      const result = resolveServerSearchDecision(searchInput);
      expect(result.useModelSearch).toBe(true);
      expect(result.useApplicationBuiltinSearchTool).toBe(false);
    },
  );

  it('lets a provider-specific false override a global true and stored search implementation', () => {
    writeOverrides([
      { modelId: searchInput.model, abilities: { search: true } },
      { providerId: 'niniapi', modelId: searchInput.model, abilities: { search: false } },
    ]);
    const result = resolveServerSearchDecision({
      ...searchInput,
      modelSearchAbility: true,
      modelSearchImpl: 'params',
    });
    expect(result.useModelSearch).toBe(false);
    expect(result.useApplicationBuiltinSearchTool).toBe(true);
    expect(
      resolveServerSearchDecision({ ...searchInput, provider: 'another-provider' }).useModelSearch,
    ).toBe(true);
  });

  it('preserves the original search ability when JSON only overrides vision', () => {
    writeOverrides([{ modelId: searchInput.model, abilities: { vision: true } }]);
    expect(resolveServerSearchDecision(searchInput).useModelSearch).toBe(false);
    expect(
      resolveServerSearchDecision({ ...searchInput, modelSearchAbility: true }).useModelSearch,
    ).toBe(true);
  });

  it('does not apply a provider rule to a different provider or model ID', () => {
    writeOverrides([
      { providerId: 'niniapi', modelId: searchInput.model, abilities: { search: true } },
    ]);
    expect(resolveServerSearchDecision({ ...searchInput, provider: 'other' }).useModelSearch).toBe(
      false,
    );
    expect(
      resolveServerSearchDecision({ ...searchInput, model: 'gemini-3.8-flash-high' })
        .useModelSearch,
    ).toBe(false);
  });

  it.each([
    { searchMode: 'off' as const, useModelBuiltinSearch: true, applicationSearch: false },
    { searchMode: 'auto' as const, useModelBuiltinSearch: false, applicationSearch: true },
  ])(
    'respects the search preference $searchMode/$useModelBuiltinSearch',
    ({ applicationSearch, ...chatConfig }) => {
      writeOverrides([{ modelId: searchInput.model, abilities: { search: true } }]);
      const result = resolveServerSearchDecision({ ...searchInput, chatConfig });
      expect(result.useModelSearch).toBe(false);
      expect(result.useApplicationBuiltinSearchTool).toBe(applicationSearch);
    },
  );
});
