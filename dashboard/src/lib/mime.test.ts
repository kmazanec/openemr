import { describe, expect, it } from 'vitest';
import { classifyMime } from './mime';

describe('classifyMime', () => {
  it('classifies pdf', () => {
    expect(classifyMime('application/pdf')).toBe('pdf');
  });

  it('strips MIME parameters before matching', () => {
    expect(classifyMime('application/pdf; charset=binary')).toBe('pdf');
    expect(classifyMime('image/png; foo=bar')).toBe('image');
  });

  it('is case-insensitive', () => {
    expect(classifyMime('IMAGE/PNG')).toBe('image');
    expect(classifyMime('Application/Pdf')).toBe('pdf');
  });

  it('classifies png and jpeg as image', () => {
    expect(classifyMime('image/png')).toBe('image');
    expect(classifyMime('image/jpeg')).toBe('image');
  });

  it('classifies tiff distinctly so the UI can show a fallback', () => {
    expect(classifyMime('image/tiff')).toBe('tiff');
  });

  it('classifies DOCX so the side panel can text-render referrals', () => {
    expect(
      classifyMime(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe('docx');
  });

  it('returns unsupported for anything else', () => {
    expect(classifyMime('text/html')).toBe('unsupported');
    expect(classifyMime('image/gif')).toBe('unsupported');
    expect(classifyMime(null)).toBe('unsupported');
    expect(classifyMime(undefined)).toBe('unsupported');
    expect(classifyMime('')).toBe('unsupported');
  });
});
