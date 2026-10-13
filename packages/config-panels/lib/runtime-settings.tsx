import { useT } from '@extension/i18n';
import { defaultRuntimeConfig, runtimeConfigStorage } from '@extension/storage';
import { Button, Input, Label } from '@extension/ui';
import { useEffect, useState } from 'react';
import type { RuntimeConfig } from '@extension/storage';

const fields = [
  ['taskTimeLimitMinutes', 'runtime_timeBudget', 0, 1440],
  ['taskTokenLimit', 'runtime_tokenBudget', 0, Number.MAX_SAFE_INTEGER],
  ['streamIdleTimeoutSeconds', 'runtime_modelIdle', 1, 86400],
  ['toolTimeoutSeconds', 'runtime_toolTimeout', 1, 86400],
  ['longToolTimeoutSeconds', 'runtime_longToolTimeout', 1, 86400],
] as const;

const RuntimeSettings = () => {
  const t = useT();
  const [config, setConfig] = useState<RuntimeConfig>(defaultRuntimeConfig);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    runtimeConfigStorage
      .get()
      .then(value => {
        setConfig(value);
        setLoaded(true);
      })
      .catch(error => setError(String(error)));
  }, []);

  return (
    <form
      className="space-y-3"
      onSubmit={async event => {
        event.preventDefault();
        try {
          await runtimeConfigStorage.set(config);
          setError('');
          setSaved(true);
        } catch (error) {
          setError(String(error));
        }
      }}>
      <h3 className="text-sm font-medium">{t('runtime_title')}</h3>
      <p className="text-muted-foreground text-xs">{t('runtime_description')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map(([key, label, min, max]) => (
          <div className="grid gap-2" key={key}>
            <Label htmlFor={`runtime-${key}`}>{t(label)}</Label>
            <Input
              id={`runtime-${key}`}
              type="number"
              min={min}
              max={max}
              step={1}
              required
              disabled={!loaded}
              value={Number.isNaN(config[key]) ? '' : config[key]}
              onChange={event => {
                setConfig(previous => ({ ...previous, [key]: event.target.valueAsNumber }));
                setSaved(false);
              }}
            />
          </div>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">{t('runtime_budgetHint')}</p>
      <Button type="submit" size="sm" disabled={!loaded}>
        {t('runtime_save')}
      </Button>
      {saved && <span className="text-muted-foreground ml-2 text-xs">{t('common_saved')}</span>}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </form>
  );
};

export { RuntimeSettings };
