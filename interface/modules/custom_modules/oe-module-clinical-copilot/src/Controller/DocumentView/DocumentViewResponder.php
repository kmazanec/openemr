<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Controller\DocumentView;

/**
 * Application service for the panel's session-side document viewer.
 *
 * The public shim ({@see /public/document_view.php}) handles HTTP
 * concerns — globals, ACL, session pid resolution, header emission —
 * and hands the parsed inputs to this responder. The responder is a
 * pure function of `(ResolvedDocument|null, sessionPid)` returning a
 * {@see DocumentViewResponse}. No HTTP side-effects, no globals.
 *
 * Branches:
 *   - null document       → 404 `document_not_found`.
 *   - foreign_id mismatch → 403 `patient_scope_mismatch` (cross-chart
 *                           defense; refuses non-attached documents).
 *   - empty bytes         → 404 `document_empty`.
 *   - image/tiff or
 *     image/x-tiff        → decode via {@see TiffDecoder}, respond
 *                           with `image/png`. Decoder failure → 500
 *                           `tiff_decode_failed`.
 *   - any other MIME      → respond with the document's recorded MIME
 *                           and bytes; an empty/missing MIME falls
 *                           back to `application/octet-stream`.
 */
final readonly class DocumentViewResponder
{
    /**
     * IANA registers `image/tiff`. `image/x-tiff` is a legacy variant
     * occasionally seen from older fax gateways; we treat both as TIFF
     * so a clinician's chart is not gated on that distinction.
     */
    private const TIFF_MIME_TYPES = ['image/tiff', 'image/x-tiff'];

    public function __construct(private TiffDecoder $tiffDecoder)
    {
    }

    public function respond(?ResolvedDocument $document, int $sessionPid): DocumentViewResponse
    {
        if ($document === null) {
            return DocumentViewResponse::error(404, 'document_not_found');
        }
        if ($document->foreignId <= 0 || $document->foreignId !== $sessionPid) {
            return DocumentViewResponse::error(403, 'patient_scope_mismatch');
        }
        if ($document->bytes === '') {
            return DocumentViewResponse::error(404, 'document_empty');
        }

        $mime = $document->mimeType !== '' ? $document->mimeType : 'application/octet-stream';
        if (in_array(strtolower($mime), self::TIFF_MIME_TYPES, strict: true)) {
            try {
                $png = $this->tiffDecoder->decodeToPng($document->bytes);
            } catch (TiffDecodeException) {
                return DocumentViewResponse::error(500, 'tiff_decode_failed');
            }
            return DocumentViewResponse::ok('image/png', $png);
        }

        return DocumentViewResponse::ok($mime, $document->bytes);
    }
}
