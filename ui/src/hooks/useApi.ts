import { useCallback, useEffect, useState } from 'react';
import type { Envelope, Source } from '@/services/api';

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  source: Source | null;
  reason?: string;
  reload: () => void;
}

/**
 * Generic loader for the typed endpoints in services/api.ts.
 *
 * `source` is surfaced rather than swallowed so the header can state
 * plainly whether the figures on screen came from a live run or from
 * the bundled fixture batch.
 */
export function useApi<T>(fn: () => Promise<Envelope<T>>, deps: unknown[] = []): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<Source | null>(null);
  const [reason, setReason] = useState<string | undefined>();
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fn().then((env) => {
      if (cancelled) return;
      setData(env.data);
      setSource(env.source);
      setReason(env.reason);
      setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, source, reason, reload };
}
