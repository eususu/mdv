// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { documentUrl, localPath, renderMarkdown } from './markdown';

describe('Markdown rendering', () => {
  it('renders Korean headings, GFM tables, and fenced code', () => {
    const html = renderMarkdown('# 안녕하세요\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```');
    expect(html).toContain('<h1>안녕하세요</h1>');
    expect(html).toContain('<table>');
    expect(html).toContain('language-js');
  });
  it('removes active HTML, injected styles, and unsafe links', () => {
    const html = renderMarkdown('<script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">bad</a><iframe src="https://example.com"></iframe><style>body{display:none}</style><p style="position:fixed">text</p>');
    expect(html).not.toMatch(/<script|onerror|javascript:|<iframe|<style|style=/i);
    expect(html).toContain('text');
  });
  it('preserves ordinary image and fragment links', () => {
    expect(renderMarkdown('![image](./assets/image.png)\n\n[section](#hello)')).toContain('src="./assets/image.png"');
    expect(renderMarkdown('[section](#hello)')).toContain('href="#hello"');
  });
});
describe('local document URLs', () => {
  it.each(['/Users/me/한글 #1.md', 'C:\\Users\\me\\한글 #1.md', '\\\\?\\C:\\Users\\me\\file.md'])('resolves relative images for %s', path => {
    const url = new URL('./assets/a%20b.png', documentUrl(path));
    expect(localPath(url)).toMatch(/\/assets\/a b.png$/);
    expect(url.hash).toBe('');
  });
  it('keeps Windows drive letters', () => {
    expect(localPath(new URL('../other.md', documentUrl('C:\\docs\\nested\\file.md')))).toBe('C:/docs/other.md');
  });
});
