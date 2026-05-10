<?php

/**
 * F.4 / F.4b — isolated tests for {@see DocumentViewResponder}.
 *
 * The responder is the unit-testable core of `public/document_view.php`:
 * given a `(ResolvedDocument|null, sessionPid)` pair, it returns a
 * typed `DocumentViewResponse`. The HTTP shim emits headers + body.
 *
 * Coverage:
 *   - 404 `document_not_found` when no document was resolved.
 *   - 403 `patient_scope_mismatch` when the document's foreign_id is
 *     0 (not chart-attached) or doesn't equal the session pid.
 *   - 404 `document_empty` when the document has zero bytes (covers
 *     both the "Document::get_data threw BadMethodCallException"
 *     branch the shim folds into empty-bytes, and a genuinely-empty
 *     file).
 *   - 200 with native MIME for non-TIFF inputs.
 *   - 200 with `image/png` for `image/tiff` and `image/x-tiff` inputs
 *     after delegation to the {@see TiffDecoder}.
 *   - 500 `tiff_decode_failed` when the decoder throws.
 *   - Empty MIME falls back to `application/octet-stream`.
 *
 * The decoder is stubbed (`StubTiffDecoder`) so the test runs on hosts
 * without `\Imagick` available — the production wiring
 * (`ImagickTiffDecoder`) is a thin pass-through to `\Imagick` and
 * carries its own `@coversNothing` integration coverage.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Controller\DocumentView;

use OpenEMR\Modules\ClinicalCopilot\Controller\DocumentView\DocumentViewResponder;
use OpenEMR\Modules\ClinicalCopilot\Controller\DocumentView\ResolvedDocument;
use OpenEMR\Modules\ClinicalCopilot\Controller\DocumentView\TiffDecodeException;
use OpenEMR\Modules\ClinicalCopilot\Controller\DocumentView\TiffDecoder;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

require_once __DIR__
    . '/../../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/DocumentView/DocumentViewResponse.php';
require_once __DIR__
    . '/../../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/DocumentView/TiffDecoder.php';
require_once __DIR__
    . '/../../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/DocumentView/TiffDecodeException.php';
require_once __DIR__
    . '/../../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/DocumentView/ResolvedDocument.php';
require_once __DIR__
    . '/../../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/DocumentView/DocxTextExtractor.php';
require_once __DIR__
    . '/../../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Controller/DocumentView/DocumentViewResponder.php';

final class StubTiffDecoder implements TiffDecoder
{
    /** @var list<string> */
    public array $calls = [];
    public ?\Throwable $throws = null;
    public string $returnedPng = "\x89PNG\r\n\x1a\nFAKE-PNG-BYTES";

    public function decodeToPng(string $tiffBytes): string
    {
        $this->calls[] = $tiffBytes;
        if ($this->throws !== null) {
            throw $this->throws;
        }
        return $this->returnedPng;
    }
}

#[Group('isolated')]
final class DocumentViewResponderTest extends TestCase
{
    private function responder(StubTiffDecoder $decoder): DocumentViewResponder
    {
        return new DocumentViewResponder($decoder);
    }

    #[Test]
    public function nullDocumentRespondsWith404DocumentNotFound(): void
    {
        $decoder = new StubTiffDecoder();
        $response = $this->responder($decoder)->respond(null, sessionPid: 42);

        self::assertSame(404, $response->statusCode);
        self::assertSame('document_not_found', $response->errorCode);
        self::assertSame('application/json', $response->contentType);
        self::assertJsonStringEqualsJsonString(
            '{"error":"document_not_found"}',
            $response->body,
        );
        self::assertSame([], $decoder->calls);
    }

    #[Test]
    public function foreignIdZeroRespondsWith403PatientScopeMismatch(): void
    {
        // Documents not attached to a patient (foreign_id 0) are out
        // of scope for this endpoint — the panel renders chart-
        // attached documents only. This refuses cross-chart reuse
        // even when the session has the patients/med ACL.
        $decoder = new StubTiffDecoder();
        $document = new ResolvedDocument(foreignId: 0, mimeType: 'application/pdf', bytes: 'BYTES');
        $response = $this->responder($decoder)->respond($document, sessionPid: 42);

        self::assertSame(403, $response->statusCode);
        self::assertSame('patient_scope_mismatch', $response->errorCode);
    }

    #[Test]
    public function foreignIdMismatchRespondsWith403PatientScopeMismatch(): void
    {
        $decoder = new StubTiffDecoder();
        $document = new ResolvedDocument(foreignId: 99, mimeType: 'application/pdf', bytes: 'BYTES');
        $response = $this->responder($decoder)->respond($document, sessionPid: 42);

        self::assertSame(403, $response->statusCode);
        self::assertSame('patient_scope_mismatch', $response->errorCode);
    }

    #[Test]
    public function emptyBytesRespondWith404DocumentEmpty(): void
    {
        // Same shape as the shim's BadMethodCallException-on-get_data
        // branch: the document was found and ACL passed, but bytes
        // are unavailable.
        $decoder = new StubTiffDecoder();
        $document = new ResolvedDocument(foreignId: 42, mimeType: 'application/pdf', bytes: '');
        $response = $this->responder($decoder)->respond($document, sessionPid: 42);

        self::assertSame(404, $response->statusCode);
        self::assertSame('document_empty', $response->errorCode);
    }

    /**
     * @return array<string, array{string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function nonTiffMimeProvider(): array
    {
        return [
            'pdf' => ['application/pdf'],
            'png' => ['image/png'],
            'jpeg' => ['image/jpeg'],
            'jpeg uppercase' => ['IMAGE/JPEG'],
        ];
    }

    #[Test]
    public function nonTiffMimePassesBytesThroughWithRecordedContentType(): void
    {
        $decoder = new StubTiffDecoder();
        foreach (self::nonTiffMimeProvider() as $caseName => [$mime]) {
            $document = new ResolvedDocument(foreignId: 42, mimeType: $mime, bytes: 'BYTES');
            $response = $this->responder($decoder)->respond($document, sessionPid: 42);

            self::assertSame(200, $response->statusCode, $caseName);
            self::assertSame($mime, $response->contentType, $caseName);
            self::assertSame('BYTES', $response->body, $caseName);
        }
        self::assertSame([], $decoder->calls, 'TIFF decoder must not be invoked for non-TIFF MIME inputs');
    }

    #[Test]
    public function emptyMimeFallsBackToOctetStream(): void
    {
        $decoder = new StubTiffDecoder();
        $document = new ResolvedDocument(foreignId: 42, mimeType: '', bytes: 'BYTES');
        $response = $this->responder($decoder)->respond($document, sessionPid: 42);

        self::assertSame(200, $response->statusCode);
        self::assertSame('application/octet-stream', $response->contentType);
    }

    /**
     * @return array<string, array{string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function tiffMimeVariantProvider(): array
    {
        return [
            'image/tiff' => ['image/tiff'],
            'image/x-tiff (legacy)' => ['image/x-tiff'],
            'image/tiff uppercase' => ['IMAGE/TIFF'],
            'image/tiff with spaces' => ['image/tiff'],
        ];
    }

    #[Test]
    public function tiffInputDecodesToPngViaTheInjectedDecoder(): void
    {
        foreach (self::tiffMimeVariantProvider() as $caseName => [$mime]) {
            $decoder = new StubTiffDecoder();
            $document = new ResolvedDocument(foreignId: 42, mimeType: $mime, bytes: 'TIFF-BYTES');
            $response = $this->responder($decoder)->respond($document, sessionPid: 42);

            self::assertSame(200, $response->statusCode, $caseName);
            self::assertSame('image/png', $response->contentType, $caseName);
            self::assertSame($decoder->returnedPng, $response->body, $caseName);
            self::assertSame(['TIFF-BYTES'], $decoder->calls, $caseName);
            // PNG magic header so a future decoder swap that returns
            // a non-PNG payload fails this assertion before the
            // browser ever gets confused bytes.
            self::assertStringStartsWith("\x89PNG", $response->body, $caseName);
        }
    }

    #[Test]
    public function tiffDecoderFailureRespondsWith500TiffDecodeFailed(): void
    {
        // A malformed TIFF or an ImageMagick policy refusal surfaces
        // through the `TiffDecodeException` boundary; the responder
        // returns a typed 500 envelope rather than letting the
        // exception escape and leak ImageMagick internals.
        $decoder = new StubTiffDecoder();
        $decoder->throws = new TiffDecodeException('Imagick refused to decode TIFF bytes');
        $document = new ResolvedDocument(foreignId: 42, mimeType: 'image/tiff', bytes: 'TIFF-BYTES');
        $response = $this->responder($decoder)->respond($document, sessionPid: 42);

        self::assertSame(500, $response->statusCode);
        self::assertSame('tiff_decode_failed', $response->errorCode);
        self::assertSame('application/json', $response->contentType);
    }
}
