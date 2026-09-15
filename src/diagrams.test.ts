// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { renderMarkdown } from './markdown';
import { renderDiagrams } from './diagrams';
const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));
let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<article></article>';
  root = document.querySelector('article')!;
  document.documentElement.dataset.theme = 'light';
  vi.clearAllMocks();
  mermaid.render.mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>안녕</text></svg>' });
});
it('renders multiple supported fences while preserving source and ordinary code', async () => {
  root.innerHTML = renderMarkdown('```mermaid\ngraph LR\nA-->B\n```\n\n```mermaidjs\nsequenceDiagram\nA->>B: 안녕\n```\n\n```js\nconst x = 1;\n```');
  await renderDiagrams(root);
  expect(root.querySelectorAll('.diagram img')).toHaveLength(2);
  expect(root.querySelector('details code')!.textContent).toContain('A-->B');
  expect(root.querySelector('code.language-js')).not.toBeNull();
  expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict', theme: 'default' }));
});
it('shows source on syntax errors and continues to the next diagram', async () => {
  mermaid.render.mockRejectedValueOnce(new Error('syntax error'));
  root.innerHTML = renderMarkdown('```mermaid\nbad\n```\n\n```mermaid\ngraph LR\nA-->B\n```');
  await renderDiagrams(root);
  expect(root.querySelector('details')!.open).toBe(true);
  expect(root.querySelectorAll('.diagram-error')).toHaveLength(1);
  expect(root.querySelectorAll('.diagram img')).toHaveLength(1);
});
it('replaces diagrams when the theme changes without nesting wrappers', async () => {
  root.innerHTML = renderMarkdown('```mermaid\ngraph LR\nA-->B\n```');
  await renderDiagrams(root);
  document.documentElement.dataset.theme = 'dark';
  await renderDiagrams(root);
  expect(root.querySelectorAll('.diagram')).toHaveLength(1);
  expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }));
});
it('does not insert a completed diagram into a newer document', async () => {
  let finish!: (result: { svg: string }) => void;
  mermaid.render.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  root.innerHTML = renderMarkdown('```mermaid\ngraph LR\nA-->B\n```');
  const rendering = renderDiagrams(root);
  await vi.waitFor(() => expect(finish).toBeDefined());
  root.innerHTML = '<p>다른 문서</p>';
  finish({ svg: '<svg></svg>' });
  await rendering;
  expect(root.innerHTML).toBe('<p>다른 문서</p>');
});
it('isolates sanitized SVG in an image and removes active content', async () => {
  mermaid.render.mockResolvedValueOnce({ svg: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject><p>HTML</p></foreignObject><text>safe</text></svg>' });
  root.innerHTML = renderMarkdown('```mermaid\ngraph LR\nA-->B\n```');
  await renderDiagrams(root);
  const svg = decodeURIComponent(root.querySelector('img')!.src.split(',')[1]);
  expect(svg).toContain('safe');
  expect(svg).not.toMatch(/script|onload|foreignObject/);
});

it('requires an explicit click before sending PlantUML and allows retry after failure', async () => {
  root.innerHTML = renderMarkdown('```plantuml\n@startuml\nAlice -> Bob: 안녕\n@enduml\n```');
  await renderDiagrams(root);
  expect(root.querySelector('img')).toBeNull();
  const button = root.querySelector('button')!;
  button.click();
  const image = root.querySelector('img')!;
  expect(image.src).toMatch(/^https:\/\/www.plantuml.com\/plantuml\/svg\/[0-9A-Za-z_-]+$/);
  expect(image.referrerPolicy).toBe('no-referrer');
  image.dispatchEvent(new Event('error'));
  expect(root.querySelector('.diagram-error')).not.toBeNull();
  expect(root.querySelector('details')!.open).toBe(true);
  expect(button.disabled).toBe(false);
  button.click();
  root.querySelector('img')!.dispatchEvent(new Event('load'));
  expect(button.hidden).toBe(true);
  await renderDiagrams(root);
  expect(root.querySelectorAll('.diagram')).toHaveLength(1);
  expect(root.querySelectorAll('img')).toHaveLength(1);
});

it('encodes Korean PlantUML as lossless compressed UTF-8', async () => {
  const { plantumlUrl } = await import('./diagrams');
  const { inflateSync, strFromU8 } = await import('fflate');
  const source = '@startuml\nAlice -> Bob: 안녕하세요 👋\n@enduml';
  const encoded = plantumlUrl(source).split('/svg/')[1];
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
  const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const binary = atob(encoded.replace(/./g, char => base64[alphabet.indexOf(char)]));
  expect(strFromU8(inflateSync(Uint8Array.from(binary, char => char.charCodeAt(0))))).toBe(source);
});
