import { createStorage, StorageEnum } from '../base/index.js';

interface RuntimeConfig {
  /** Zero means no overall task deadline. */
  taskTimeLimitMinutes: number;
  /** Soft budget for main-loop usage; auxiliary summarization is not included. */
  taskTokenLimit: number;
  streamIdleTimeoutSeconds: number;
  toolTimeoutSeconds: number;
  longToolTimeoutSeconds: number;
}

const defaultRuntimeConfig: RuntimeConfig = {
  taskTimeLimitMinutes: 0,
  taskTokenLimit: 0,
  streamIdleTimeoutSeconds: 300,
  toolTimeoutSeconds: 60,
  longToolTimeoutSeconds: 600,
};

const assertRuntimeConfig: (value: unknown) => asserts value is RuntimeConfig = value => {
  if (!value || typeof value !== 'object') throw new Error('Invalid agent runtime configuration');
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(defaultRuntimeConfig) as (keyof RuntimeConfig)[]) {
    const min = key === 'taskTimeLimitMinutes' || key === 'taskTokenLimit' ? 0 : 1;
    const max =
      key === 'taskTokenLimit'
        ? Number.MAX_SAFE_INTEGER
        : key === 'taskTimeLimitMinutes'
          ? 1440
          : 86400;
    if (
      !Number.isSafeInteger(config[key]) ||
      (config[key] as number) < min ||
      (config[key] as number) > max
    ) {
      throw new Error(`Invalid ${key}: expected an integer from ${min} to ${max}`);
    }
  }
};

const rawStorage = createStorage<RuntimeConfig>('agent-runtime', defaultRuntimeConfig, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

const runtimeConfigStorage = {
  get: async (): Promise<RuntimeConfig> => {
    const config = await rawStorage.get();
    assertRuntimeConfig(config);
    return config;
  },
  set: async (config: RuntimeConfig): Promise<void> => {
    assertRuntimeConfig(config);
    await rawStorage.set(config);
  },
};

export { runtimeConfigStorage, defaultRuntimeConfig, assertRuntimeConfig };
export type { RuntimeConfig };
