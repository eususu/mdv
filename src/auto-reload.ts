// Coalesce editor save bursts and serialize reads. Events for previous files are ignored.
export function createAutoReload(currentPath: () => string, refresh: (path: string) => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let disposed = false;
  let pending = '';
  const flush = async () => {
    timer = undefined;
    if (disposed || running) return;
    const path = pending;
    pending = '';
    if (!path || path !== currentPath()) return;
    running = true;
    try { await refresh(path); }
    finally {
      running = false;
      if (!disposed && pending && timer === undefined) timer = setTimeout(() => { void flush(); }, 200);
    }
  };
  return {
    dispose() { disposed = true; pending = ''; clearTimeout(timer); },
    changed(path: string) {
      if (disposed || !path || path !== currentPath()) return;
      pending = path;
      clearTimeout(timer);
      timer = setTimeout(() => { void flush(); }, 200);
    },
  };
}
