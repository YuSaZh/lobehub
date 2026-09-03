import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AiProviderListItem } from '@lobechat/types';
import type { EnabledAiModel } from 'model-bank';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import type { LobeChatDatabase } from '../../type';
import { AiInfraRepos } from './index';
import {
  getEffectiveModelAbilities,
  MODEL_CAPABILITY_OVERRIDES_PATH_ENV,
  resetModelCapabilityOverridesCache,
} from './modelCapabilityOverrides';

const userId = 'model-capability-overrides-test-user';
const mockProviderConfigs = { openai: { enabled: true } };

let serverDB: LobeChatDatabase;
let tempDirectory: string;
let originalOverridesPath: string | undefined;

const writeOverrides = (value: unknown) => {
  const overridesPath = path.join(tempDirectory, 'model-capability-overrides.json');
  writeFileSync(overridesPath, JSON.stringify(value), 'utf8');
  process.env[MODEL_CAPABILITY_OVERRIDES_PATH_ENV] = overridesPath;
  resetModelCapabilityOverridesCache();
};

beforeAll(async () => {
  serverDB = await getTestDB();
}, 30000);

beforeEach(() => {
  originalOverridesPath = process.env[MODEL_CAPABILITY_OVERRIDES_PATH_ENV];
  delete process.env[MODEL_CAPABILITY_OVERRIDES_PATH_ENV];
  tempDirectory = mkdtempSync(path.join(tmpdir(), 'lobehub-model-capability-overrides-'));
  resetModelCapabilityOverridesCache();
});

afterEach(() => {
  if (originalOverridesPath === undefined) {
    delete process.env[MODEL_CAPABILITY_OVERRIDES_PATH_ENV];
  } else {
    process.env[MODEL_CAPABILITY_OVERRIDES_PATH_ENV] = originalOverridesPath;
  }
  resetModelCapabilityOverridesCache();
  rmSync(tempDirectory, { force: true, recursive: true });
});

describe('model capability overrides', () => {
  it('does not change abilities when the environment variable is unset', () => {
    const abilities = { reasoning: true };

    expect(getEffectiveModelAbilities('openai', 'gpt-4', abilities)).toBe(abilities);
  });

  it('applies exact true/false overrides while preserving other ability fields', () => {
    writeOverrides({
      models: [
        {
          abilities: { search: false, vision: true },
          modelId: 'gpt-4',
          providerId: 'openai',
        },
      ],
      version: 1,
    });

    expect(
      getEffectiveModelAbilities('openai', 'gpt-4', {
        reasoning: true,
        search: true,
        vision: false,
      }),
    ).toEqual({ reasoning: true, search: false, vision: true });
    expect(getEffectiveModelAbilities('openai', 'other-model', { reasoning: true })).toEqual({
      reasoning: true,
    });
  });

  it('caches file contents until the process-local cache is reset', () => {
    writeOverrides({
      models: [{ abilities: { vision: true }, modelId: 'gpt-4', providerId: 'openai' }],
      version: 1,
    });

    expect(getEffectiveModelAbilities('openai', 'gpt-4', {})).toEqual({ vision: true });

    const overridesPath = path.join(tempDirectory, 'model-capability-overrides.json');
    writeFileSync(
      overridesPath,
      JSON.stringify({
        models: [{ abilities: { vision: false }, modelId: 'gpt-4', providerId: 'openai' }],
        version: 1,
      }),
      'utf8',
    );
    expect(getEffectiveModelAbilities('openai', 'gpt-4', {})).toEqual({ vision: true });

    resetModelCapabilityOverridesCache();
    expect(getEffectiveModelAbilities('openai', 'gpt-4', {})).toEqual({ vision: false });
  });

  it.each([
    {
      name: 'duplicate provider and model',
      value: {
        models: [
          { abilities: { vision: true }, modelId: 'gpt-4', providerId: 'openai' },
          { abilities: { vision: false }, modelId: 'gpt-4', providerId: 'openai' },
        ],
        version: 1,
      },
    },
    {
      name: 'unknown top-level key',
      value: { models: [], unexpected: true, version: 1 },
    },
    {
      name: 'unknown model key',
      value: {
        models: [{ abilities: {}, modelId: 'gpt-4', providerId: 'openai', unexpected: true }],
        version: 1,
      },
    },
    {
      name: 'unknown ability key',
      value: {
        models: [{ abilities: { unsupported: true }, modelId: 'gpt-4', providerId: 'openai' }],
        version: 1,
      },
    },
    {
      name: 'non-boolean ability value',
      value: {
        models: [{ abilities: { vision: 'true' }, modelId: 'gpt-4', providerId: 'openai' }],
        version: 1,
      },
    },
    {
      name: 'empty provider id',
      value: {
        models: [{ abilities: { vision: true }, modelId: 'gpt-4', providerId: '  ' }],
        version: 1,
      },
    },
    {
      name: 'empty model id',
      value: {
        models: [{ abilities: { vision: true }, modelId: '', providerId: 'openai' }],
        version: 1,
      },
    },
  ])('rejects $name', ({ value }) => {
    writeOverrides(value);

    expect(() => getEffectiveModelAbilities('openai', 'gpt-4', {})).toThrow(
      /invalid model capability overrides schema/,
    );
  });

  it('rejects missing files and invalid JSON without falling back', () => {
    const missingPath = path.join(tempDirectory, 'missing.json');
    process.env[MODEL_CAPABILITY_OVERRIDES_PATH_ENV] = missingPath;

    expect(() => getEffectiveModelAbilities('openai', 'gpt-4', {})).toThrow(
      /failed to read model capability overrides file/,
    );

    const invalidPath = path.join(tempDirectory, 'invalid.json');
    writeFileSync(invalidPath, '{"version":', 'utf8');
    process.env[MODEL_CAPABILITY_OVERRIDES_PATH_ENV] = invalidPath;
    resetModelCapabilityOverridesCache();

    expect(() => getEffectiveModelAbilities('openai', 'gpt-4', {})).toThrow(
      /invalid JSON in model capability overrides file/,
    );
  });

  it('applies overrides to builtin models without database rows and injects search settings afterward', async () => {
    const repo = new AiInfraRepos(serverDB, userId, mockProviderConfigs);
    writeOverrides({
      models: [{ abilities: { search: true }, modelId: 'gpt-4', providerId: 'openai' }],
      version: 1,
    });

    vi.spyOn(repo.aiModelModel, 'getModelListByProviderId').mockResolvedValue([]);
    vi.spyOn(repo as any, 'fetchBuiltinModels').mockResolvedValue([
      { abilities: { search: false }, enabled: true, id: 'gpt-4', type: 'chat' },
    ]);

    const result = await repo.getAiProviderModelList('openai');
    expect(result).toContainEqual(
      expect.objectContaining({
        abilities: { search: true },
        id: 'gpt-4',
        settings: { searchImpl: 'params' },
      }),
    );
  });

  it('applies overrides to builtin models with database rows', async () => {
    const repo = new AiInfraRepos(serverDB, userId, mockProviderConfigs);
    writeOverrides({
      models: [{ abilities: { vision: true }, modelId: 'gpt-4', providerId: 'openai' }],
      version: 1,
    });

    vi.spyOn(repo, 'getAiProviderList').mockResolvedValue([
      { enabled: true, id: 'openai' } as AiProviderListItem,
    ]);
    vi.spyOn(repo.aiModelModel, 'getAllModels').mockResolvedValue([
      {
        abilities: { vision: false },
        enabled: true,
        id: 'gpt-4',
        providerId: 'openai',
        type: 'chat',
      } as EnabledAiModel,
    ]);
    vi.spyOn(repo as any, 'fetchBuiltinModels').mockResolvedValue([
      { abilities: { reasoning: true }, enabled: true, id: 'gpt-4', type: 'chat' },
    ]);

    const result = await repo.getEnabledModels();
    expect(result).toContainEqual(
      expect.objectContaining({
        abilities: { vision: true },
        id: 'gpt-4',
        providerId: 'openai',
      }),
    );
  });

  it('applies overrides to remote models appended for a custom provider', async () => {
    const repo = new AiInfraRepos(serverDB, userId, mockProviderConfigs);
    writeOverrides({
      models: [{ abilities: { files: true }, modelId: 'newapi-model', providerId: 'custom' }],
      version: 1,
    });

    vi.spyOn(repo, 'getAiProviderList').mockResolvedValue([
      { enabled: true, id: 'custom' } as AiProviderListItem,
    ]);
    vi.spyOn(repo.aiModelModel, 'getAllModels').mockResolvedValue([
      {
        abilities: { files: false },
        enabled: true,
        id: 'newapi-model',
        providerId: 'custom',
        source: 'remote',
        type: 'chat',
      } as EnabledAiModel,
    ]);
    vi.spyOn(repo as any, 'fetchBuiltinModels').mockResolvedValue([]);

    const result = await repo.getEnabledModels();
    expect(result).toContainEqual(
      expect.objectContaining({
        abilities: { files: true },
        id: 'newapi-model',
        providerId: 'custom',
      }),
    );
  });
});
