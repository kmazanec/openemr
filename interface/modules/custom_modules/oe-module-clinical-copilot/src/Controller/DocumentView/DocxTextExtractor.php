<?php

/**
 * DOCX → plain-text extractor (server-side mirror of
 * `agent/src/pipeline/docxText.ts`).
 *
 * The agent rasterizes referral letters as `mode: docx-text-passthrough`
 * (no rasterization, no vision-image branch). Citations on those
 * extractions use a 4-tuple bbox shape `[charStart, charEnd, 0, 0]`
 * where the first two integers are character offsets into the same
 * plain-text body produced by this extractor. The clinical-copilot
 * panel's `documentViewer.js` calls `document_view.php` to render the
 * source document; for a DOCX it reads back the plain text via this
 * extractor and highlights the cited character range.
 *
 * The two extractors must produce byte-equivalent output for the same
 * input so the bbox offsets line up. Both:
 *   - read `word/document.xml` from the ZIP archive,
 *   - walk a tiny tag-state machine recognising `<w:t>`, `<w:p>`,
 *     `<w:tab/>`, `<w:br/>`,
 *   - join paragraphs with a single `\n`,
 *   - decode the standard XML entity set.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Controller\DocumentView;

use RuntimeException;
use ZipArchive;

final class DocxParseException extends RuntimeException
{
}

final readonly class DocxTextExtractor
{
    /**
     * Read `word/document.xml` from the supplied DOCX bytes and
     * return the paragraph-level plain text.
     *
     * @throws DocxParseException
     */
    public function extract(string $docxBytes): string
    {
        $tmpPath = tempnam(sys_get_temp_dir(), 'docx-view-');
        if ($tmpPath === false) {
            throw new DocxParseException('failed to create temp file for docx extraction');
        }
        try {
            $written = file_put_contents($tmpPath, $docxBytes);
            if ($written === false) {
                throw new DocxParseException('failed to write docx bytes to temp file');
            }
            $zip = new ZipArchive();
            $opened = $zip->open($tmpPath);
            if ($opened !== true) {
                throw new DocxParseException('not a ZIP archive (ZipArchive::open returned ' . (string) $opened . ')');
            }
            try {
                $xml = $zip->getFromName('word/document.xml');
                if ($xml === false || $xml === '') {
                    throw new DocxParseException("DOCX archive missing required member 'word/document.xml'");
                }
                return $this->walkDocumentXml($xml);
            } finally {
                $zip->close();
            }
        } finally {
            @unlink($tmpPath);
        }
    }

    /**
     * Walk the `document.xml` text and emit one paragraph per
     * `<w:p>...</w:p>` block. Mirrors the agent walker step-for-step;
     * see `agent/src/pipeline/docxText.ts` for the design rationale.
     */
    private function walkDocumentXml(string $xml): string
    {
        $paragraphs = [];
        $para = '';
        $inTextRun = false;
        $textRun = '';

        $len = strlen($xml);
        $i = 0;
        while ($i < $len) {
            $ch = $xml[$i];
            if ($ch !== '<') {
                if ($inTextRun) {
                    $textRun .= $ch;
                }
                $i++;
                continue;
            }
            $tagEnd = strpos($xml, '>', $i);
            if ($tagEnd === false) {
                break;
            }
            $tag = substr($xml, $i + 1, $tagEnd - $i - 1);
            $i = $tagEnd + 1;

            if ($tag === 'w:t' || str_starts_with($tag, 'w:t ')) {
                $inTextRun = true;
                $textRun = '';
                continue;
            }
            if ($tag === '/w:t') {
                $para .= $this->decodeXmlEntities($textRun);
                $inTextRun = false;
                $textRun = '';
                continue;
            }
            if (str_starts_with($tag, 'w:tab') && str_ends_with($tag, '/')) {
                $para .= ' ';
                continue;
            }
            if (str_starts_with($tag, 'w:br') && str_ends_with($tag, '/')) {
                $para .= "\n";
                continue;
            }
            if ($tag === '/w:p') {
                $paragraphs[] = $para;
                $para = '';
                continue;
            }
            // Any other tag is structural and silently skipped.
        }
        return implode("\n", $paragraphs);
    }

    private function decodeXmlEntities(string $s): string
    {
        return preg_replace_callback(
            '/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/u',
            static function (array $match): string {
                $body = $match[1];
                if (str_starts_with($body, '#x') || str_starts_with($body, '#X')) {
                    $cp = (int) hexdec(substr($body, 2));
                    return mb_chr($cp, 'UTF-8') ?: '';
                }
                if (str_starts_with($body, '#')) {
                    return mb_chr((int) substr($body, 1), 'UTF-8') ?: '';
                }
                return match ($body) {
                    'amp' => '&',
                    'lt' => '<',
                    'gt' => '>',
                    'quot' => '"',
                    'apos' => "'",
                    default => '&' . $body . ';',
                };
            },
            $s,
        ) ?? $s;
    }
}
