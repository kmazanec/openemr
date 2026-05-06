<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

/**
 * Writes canonical document bytes to DigitalOcean Spaces. The interface
 * exists so {@see DocumentUploadController} can be tested with an
 * in-memory fake — the production implementation
 * ({@see Production\SigV4SpacesUploadService}) signs requests with raw
 * SigV4 over Guzzle to avoid pulling in `aws/aws-sdk-php`.
 *
 * Returns the canonical `s3://<bucket>/<key>` URL, which the agent's
 * pipeline reads via {@see DocumentReferenceWriteService::write} when it
 * persists the Tier-1 DocumentReference row.
 */
interface SpacesUploadService
{
    /**
     * @param int $pid Patient row id; first segment of the canonical key.
     * @param string $documentUuid Lowercase 36-char canonical UUID.
     * @param string $extension File extension *without* leading dot
     *     (`pdf`, `png`, `jpg`, `tiff`). Caller is responsible for
     *     mapping MIME → ext consistently.
     * @param string $bytes Raw bytes of the file.
     * @param string $contentType MIME type (`application/pdf`, …).
     * @return string The canonical `s3://<bucket>/<pid>/<uuid>.<ext>` URL.
     * @throws \DomainException Caller passed structurally invalid input
     *     (non-positive pid, empty uuid/extension/contentType, zero bytes).
     * @throws \RuntimeException Network / signing / 5xx failures wrap into RuntimeException.
     */
    public function upload(
        int $pid,
        string $documentUuid,
        string $extension,
        string $bytes,
        string $contentType,
    ): string;
}
