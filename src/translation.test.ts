// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { translationSegments, translateSegments, aiTranslationPrompt } from './translation';

it('preserves code, diagrams, attributes and opted-out text', async () => {
  const root = document.createElement('article');
  root.innerHTML = '<h1 id="hello">Hello</h1><p>Read <a href="/guide">guide</a> <code>const x</code></p><pre>code</pre><figure class="diagram">Diagram</figure><span translate="no">Name</span>';
  const segments = translationSegments(root);
  expect(segments.map(s => s.original)).toEqual(['Hello', 'Read ', 'guide']);
  const result = await translateSegments(segments, async texts => texts.map(() => '<img onerror="bad">'), () => true, () => {});
  segments.forEach((s, i) => { s.node.data = result![i]; });
  expect(root.querySelector('img')).toBeNull();
  expect(root.querySelector('a')!.getAttribute('href')).toBe('/guide');
  expect(root.querySelector('h1')!.id).toBe('hello');
  expect(root.querySelector('code')!.textContent).toBe('const x');
  segments.forEach(s => { s.node.data = s.original; });
  expect(root.querySelector('h1')!.textContent).toBe('Hello');
});

it('splits large text safely and reassembles in order', async () => {
  const root = document.createElement('article');
  root.textContent = 'a' + '😀'.repeat(20000);
  const translate = vi.fn(async (texts: string[]) => texts);
  const segments = translationSegments(root);
  const result = await translateSegments(segments, translate, () => true, () => {});
  expect(result).toEqual([root.textContent]);
  expect(translate).toHaveBeenCalledTimes(3);
  expect(segments[0].parts.every(p => Array.from(p).length <= 1000)).toBe(true);
});

it('ignores stale responses and sends no further batches', async () => {
  const root = document.createElement('article');
  root.textContent = 'a'.repeat(20000);
  let active = true;
  const translate = vi.fn(async (texts: string[]) => { active = false; return texts; });
  expect(await translateSegments(translationSegments(root), translate, () => active, () => {})).toBeNull();
  expect(translate).toHaveBeenCalledTimes(1);
});

it('rejects incomplete API responses without changing the document', async () => {
  const root = document.createElement('article');
  root.textContent = 'Hello';
  await expect(translateSegments(translationSegments(root), async () => [], () => true, () => {})).rejects.toThrow('응답 형식');
  expect(root.textContent).toBe('Hello');
});

it('retains whitespace around inline code even when translation trims it', async () => {
  const root = document.createElement('article');
  root.innerHTML = '<p>Use <code>npm</code> now.</p>';
  const result = await translateSegments(translationSegments(root), async () => ['번역'], () => true, () => {});
  expect(result).toEqual(['번역 ', ' 번역']);
});

it('prepares the original Markdown for manual AI translation without changing it', () => {
  const source = '# Hello\n\n```js\nconst text = "Hello";\n```';
  expect(aiTranslationPrompt(source)).toContain(source);
  expect(aiTranslationPrompt(source)).toContain('요약하거나 내용을 생략하지 마세요');
});

it('does not send whitespace-only chunks to the service', async () => {
  const root = document.createElement('article');
  root.textContent = 'Hello' + ' '.repeat(2100);
  const translate = vi.fn(async (texts: string[]) => texts);
  const result = await translateSegments(translationSegments(root), translate, () => true, () => {});
  expect(result).toEqual([root.textContent]);
  expect(translate).toHaveBeenCalledTimes(1);
});
