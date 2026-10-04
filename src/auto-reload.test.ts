import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutoReload } from './auto-reload';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('automatic reload scheduling', () => {
  it('cancels scheduled reads when the viewer is disposed', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const reload = createAutoReload(() => '/a.md', refresh);
    reload.changed('/a.md');
    reload.dispose();
    reload.changed('/a.md');
    await vi.advanceTimersByTimeAsync(500);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('coalesces consecutive save notifications', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const reload = createAutoReload(() => '/a.md', refresh);
    reload.changed('/a.md');
    await vi.advanceTimersByTimeAsync(100);
    reload.changed('/a.md');
    await vi.advanceTimersByTimeAsync(199);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledExactlyOnceWith('/a.md');
  });

  it('ignores old file events and a queued save after switching documents', async () => {
    let path = '/a.md';
    const refresh = vi.fn().mockResolvedValue(undefined);
    const reload = createAutoReload(() => path, refresh);
    reload.changed(path);
    path = '/b.md';
    reload.changed('/a.md');
    await vi.advanceTimersByTimeAsync(300);
    expect(refresh).not.toHaveBeenCalled();
    reload.changed(path);
    await vi.advanceTimersByTimeAsync(200);
    expect(refresh).toHaveBeenCalledExactlyOnceWith('/b.md');
  });

  it('queues another save while reading without concurrent reads', async () => {
    let finish!: () => void;
    const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
    const reload = createAutoReload(() => '/a.md', refresh);
    reload.changed('/a.md');
    await vi.advanceTimersByTimeAsync(200);
    reload.changed('/a.md');
    await vi.advanceTimersByTimeAsync(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(200);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
