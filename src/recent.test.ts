// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), events: new Map<string, (event: { payload: string }) => void>() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, handler: (event: { payload: string }) => void) => { mocks.events.set(name, handler); return () => {}; }) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onDragDropEvent: vi.fn().mockResolvedValue(() => {}) }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

const key = 'mdv-recent-files';
const paths = () => JSON.parse(localStorage.getItem(key) || '[]');
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.recent-open')];
async function start() { await import('./main'); }
async function openFile(path: string) {
  mocks.open.mockResolvedValueOnce(path);
  document.querySelector<HTMLButtonElement>('#open')!.click();
  await vi.waitFor(() => expect(document.querySelector('#location')!.textContent).toBe(path));
}

beforeEach(() => {
  window.dispatchEvent(new Event('beforeunload'));
  vi.resetModules();
  vi.clearAllMocks();
  mocks.events.clear();
  localStorage.clear();
  localStorage.setItem('mdv-theme', 'light');
  document.body.innerHTML = '<div id="app"></div>';
  mocks.invoke.mockImplementation(async (command: string, args?: { path: string }) => command === 'read_document'
    ? { path: args!.path, content: '# 문서' } : null);
});

describe('recent documents', () => {
  it('keeps the latest ten successful opens, moving duplicates to the top', async () => {
    await start();
    for (let i = 0; i < 11; i++) await openFile(`/docs/${i}.md`);
    expect(paths()).toHaveLength(10);
    expect(paths()).not.toContain('/docs/0.md');
    await openFile('/docs/5.md');
    expect(paths()[0]).toBe('/docs/5.md');
    expect(paths().filter((path: string) => path === '/docs/5.md')).toHaveLength(1);
    expect(buttons()[0].getAttribute('aria-current')).toBe('true');
  });

  it('restores paths and reads the file again when clicked', async () => {
    localStorage.setItem(key, JSON.stringify(['C:\\문서\\hello.md', '/other/hello.md']));
    await start();
    expect(buttons().map(button => button.title)).toEqual(['C:\\문서\\hello.md', '/other/hello.md']);
    buttons()[1].click();
    await vi.waitFor(() => expect(paths()[0]).toBe('/other/hello.md'));
    expect(mocks.invoke).toHaveBeenCalledWith('read_document', { path: '/other/hello.md' });
  });

  it('removes entries and clears persisted history without closing the document', async () => {
    await start();
    await openFile('/docs/a.md');
    await openFile('/docs/b.md');
    document.querySelector<HTMLButtonElement>('.recent-remove')!.click();
    expect(paths()).toEqual(['/docs/a.md']);
    document.querySelector<HTMLButtonElement>('#clear-recent')!.click();
    expect(paths()).toEqual([]);
    expect(document.querySelector<HTMLElement>('#recent-empty')!.hidden).toBe(false);
    expect(document.querySelector('#location')!.textContent).toBe('/docs/b.md');
  });

  it('keeps the current document and history if reopening a missing file fails', async () => {
    localStorage.setItem(key, JSON.stringify(['/missing.md']));
    await start();
    await openFile('/docs/a.md');
    mocks.invoke.mockRejectedValueOnce('파일을 찾을 수 없습니다.');
    buttons()[1].click();
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('#error')!.hidden).toBe(false));
    expect(paths()).toEqual(['/docs/a.md', '/missing.md']);
    expect(document.querySelector('#location')!.textContent).toBe('/docs/a.md');
  });

  it.each(['invalid json', '{}', '[null, 12, "", "/ok.md", "/ok.md"]'])('handles malformed stored history: %s', async stored => {
    localStorage.setItem(key, stored);
    await start();
    expect(buttons().length).toBe(stored.includes('/ok.md') ? 1 : 0);
    await openFile('/new.md');
    expect(paths()[0]).toBe('/new.md');
  });

  it('still opens documents if persisting history fails', async () => {
    await start();
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    try {
      await openFile('/docs/a.md');
      expect(buttons()[0].title).toBe('/docs/a.md');
      expect(document.querySelector<HTMLElement>('#error')!.hidden).toBe(true);
    } finally { storage.mockRestore(); }
  });
});


describe('live document updates', () => {
  it('refreshes content and headings while preserving scroll and history', async () => {
    await start();
    await openFile('/docs/a.md');
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('watch_document', { path: '/docs/a.md' }));
    const reader = document.querySelector<HTMLElement>('#reader')!;
    reader.scrollTop = 240;
    mocks.invoke.mockImplementation(async (command: string, args?: { path: string }) => command === 'read_document'
      ? { path: args!.path, content: '# Updated\n\nNew text' } : null);
    mocks.events.get('document-changed')!({ payload: '/docs/a.md' });
    await vi.waitFor(() => expect(document.querySelector('#document')!.textContent).toContain('New text'));
    expect(document.querySelector('#toc')!.textContent).toContain('Updated');
    expect(reader.scrollTop).toBe(240);
    expect(paths()).toEqual(['/docs/a.md']);
  });

  it('keeps the last good content on read failure and recovers on the next save', async () => {
    await start();
    await openFile('/docs/a.md');
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'read_document') throw '파일을 찾을 수 없습니다.';
      return null;
    });
    mocks.events.get('document-changed')!({ payload: '/docs/a.md' });
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('#error')!.hidden).toBe(false));
    expect(document.querySelector('#document')!.textContent).toContain('문서');
    mocks.invoke.mockImplementation(async (command: string, args?: { path: string }) => command === 'read_document'
      ? { path: args!.path, content: '# 복구됨' } : null);
    mocks.events.get('document-changed')!({ payload: '/docs/a.md' });
    await vi.waitFor(() => expect(document.querySelector('#document')!.textContent).toContain('복구됨'));
    expect(document.querySelector<HTMLElement>('#error')!.hidden).toBe(true);
  });

  it('discards an automatic read that finishes after a newer file is opened', async () => {
    await start();
    await openFile('/docs/a.md');
    let finish!: (doc: { path: string; content: string }) => void;
    mocks.invoke.mockImplementation(async (command: string, args?: { path: string }) => {
      if (command !== 'read_document') return null;
      if (args!.path === '/docs/a.md') return new Promise(resolve => { finish = resolve; });
      return { path: args!.path, content: '# B' };
    });
    mocks.events.get('document-changed')!({ payload: '/docs/a.md' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await openFile('/docs/b.md');
    finish({ path: '/docs/a.md', content: '# Stale A' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector('#location')!.textContent).toBe('/docs/b.md');
    expect(document.querySelector('#document')!.textContent!.trim()).toBe('B');
    expect(paths()).toEqual(['/docs/b.md', '/docs/a.md']);
  });
});
