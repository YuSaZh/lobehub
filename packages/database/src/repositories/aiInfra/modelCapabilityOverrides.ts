import { readFileSync } from 'node:fs';

import type { ModelAbilities } from 'model-bank';
import { z } from 'zod';

export const MODEL_CAPABILITY_OVERRIDES_PATH_ENV =
  'LOBEHUB_MODEL_CAPABILITY_OVERRIDES_PATH' as const;

const modelCapabilityOverrideAbilitiesSchema = z
  .object({
    audio: z.boolean().optional(),
    files: z.boolean().optional(),
    functionCall: z.boolean().optional(),
    imageOutput: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    search: z.boolean().optional(),
    structuredOutput: z.boolean().optional(),
    video: z.boolean().optional(),
    vision: z.boolean().optional(),
  })
  .strict();

const modelCapabilityOverrideSchema = z
  .object({
    abilities: modelCapabilityOverrideAbilitiesSchema,
    modelId: z.string().refine((value) => value.trim().length > 0, {
      message: 'modelId must not be empty',
    }),
    providerId: z.string().refine((value) => value.trim().length > 0, {
      message: 'providerId must not be empty',
    }),
  })
  .strict();

const modelCapabilityOverridesSchema = z
  .object({
    models: z.array(modelCapabilityOverrideSchema),
    version: z.literal(1),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Map<string, Set<string>>();

    for (const [index, model] of value.models.entries()) {
      const providerModels = seen.get(model.providerId);
      if (providerModels?.has(model.modelId)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate providerId/modelId pair: ${model.providerId}/${model.modelId}`,
          path: ['models', index],
        });
      }

      if (providerModels) {
        providerModels.add(model.modelId);
      } else {
        seen.set(model.providerId, new Set([model.modelId]));
      }
    }
  });

type ModelCapabilityOverrides = z.infer<typeof modelCapabilityOverridesSchema>;
type ModelCapabilityOverrideMap = Map<string, Map<string, ModelAbilities>>;

let cachedPath: string | undefined;
let cachedOverrides: ModelCapabilityOverrideMap | undefined;

const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error));

const loadModelCapabilityOverrides = (path: string): ModelCapabilityOverrideMap => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`[ai-infra] invalid JSON in model capability overrides file "${path}"`, {
        cause: error,
      });
    }

    throw new Error(
      `[ai-infra] failed to read model capability overrides file "${path}": ${formatError(error)}`,
      { cause: error },
    );
  }

  const result = modelCapabilityOverridesSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(
      `[ai-infra] invalid model capability overrides schema in "${path}": ${details}`,
    );
  }

  return createModelCapabilityOverrideMap(result.data);
};

const createModelCapabilityOverrideMap = (
  overrides: ModelCapabilityOverrides,
): ModelCapabilityOverrideMap => {
  const result: ModelCapabilityOverrideMap = new Map();

  for (const model of overrides.models) {
    let providerOverrides = result.get(model.providerId);
    if (!providerOverrides) {
      providerOverrides = new Map();
      result.set(model.providerId, providerOverrides);
    }
    providerOverrides.set(model.modelId, model.abilities);
  }

  return result;
};

const getModelCapabilityOverrides = (): ModelCapabilityOverrideMap | undefined => {
  const path = process.env[MODEL_CAPABILITY_OVERRIDES_PATH_ENV]?.trim();
  if (!path) return;

  if (cachedPath === path && cachedOverrides) return cachedOverrides;

  const overrides = loadModelCapabilityOverrides(path);
  cachedPath = path;
  cachedOverrides = overrides;
  return overrides;
};

export const getEffectiveModelAbilities = (
  providerId: string,
  modelId: string,
  abilities?: ModelAbilities,
): ModelAbilities | undefined => {
  const override = getModelCapabilityOverrides()?.get(providerId)?.get(modelId);
  if (!override) return abilities;

  return { ...abilities, ...override };
};

/** Reset the process-local cache so tests can isolate environment and file changes. */
export const resetModelCapabilityOverridesCache = () => {
  cachedPath = undefined;
  cachedOverrides = undefined;
};
