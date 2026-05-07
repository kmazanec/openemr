<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Controller;

use OpenEMR\Modules\ClinicalCopilot\Service\DocumentReferenceWriteService;
use OpenEMR\Modules\ClinicalCopilot\Service\DocumentUuidGenerator;
use OpenEMR\Modules\ClinicalCopilot\Service\LocalDocumentStore;
use OpenEMR\Modules\ClinicalCopilot\Service\SpacesUploadService;
use Psr\Log\LoggerInterface;

/**
 * Browser-side document upload controller.
 *
 * Trust direction: the **panel JS** posts a multipart upload while the
 * clinician is signed into OpenEMR. The session-bootstrapped `.php`
 * entry point ({@see ../../public/document_upload.php}) applies the
 * existing `patients/med` ACL gate, derives `pid` from the session,
 * and hands the validated file payload to this controller. No JWT is
 * involved — the OpenEMR session *is* the trust anchor on this path
 * (mirrors `panel.php` and `extract.php`, the other browser-inbound
 * entry points; `snapshot/*.php` is reserved for agent-callback
 * bearer-token traffic).
 *
 * Persistence shape: the controller writes the bytes to **both**
 * DigitalOcean Spaces (so the agent's vision pipeline can pull them
 * for the external LLM) and to local disk under
 * `OE_SITE_DIR/documents/<pid>/`, then pre-writes the `documents` row
 * with `type='file_url'` + `path_depth=1` so the legacy Documents-tab
 * viewer renders chat-uploaded files identically to legacy uploads.
 * The agent-side `persist` node confirms (rather than re-inserts) the
 * row by UUID — see {@see DocumentReferenceController::handle}.
 *
 * Failure handling: if the local-disk write or row insert fails after
 * a successful Spaces upload, we return 503. We don't roll back the
 * Spaces upload — the orphaned object is tolerable (the agent's
 * idempotency check on `extraction_artifacts.document_uuid` ensures
 * we don't re-process it on retry).
 *
 * MIME validation is content-sniff first (via `finfo`), filename and
 * declared client MIME are not trusted. The 10 MB cap matches the
 * client-side soft cap in `panel.js`.
 */
final readonly class DocumentUploadController
{
    public const MAX_BYTES = 10 * 1024 * 1024;

    /**
     * Allowed MIME → file extension. The browser's `accept` attribute
     * mirrors the keys; the server is the trust anchor.
     */
    private const MIME_TO_EXT = [
        'application/pdf' => 'pdf',
        'image/png' => 'png',
        'image/jpeg' => 'jpg',
        'image/tiff' => 'tiff',
    ];

    // Mirrors `DocumentReferenceWriteService::DOC_TYPE_*` so the
    // upload-side constants don't pull the writer service into the
    // controller's require graph. The two must stay in lockstep — the
    // vocabulary is a wire-format contract with the agent's
    // `kickoffExtraction` handoff.
    public const DOC_TYPE_LAB_PDF = 'lab_pdf';
    public const DOC_TYPE_INTAKE_FORM = 'intake_form';

    public function __construct(
        private SpacesUploadService $uploadService,
        private LocalDocumentStore $localStore,
        private DocumentReferenceWriteService $writeService,
        private DocumentUuidGenerator $uuidGenerator,
        private LoggerInterface $logger,
    ) {
    }

    /**
     * Handle a parsed upload payload. Writes the JSON response or an
     * error envelope to PHP's output stream and sets the HTTP status
     * code. The entry point is responsible for the session+ACL gate;
     * this method assumes the caller is already authorized.
     *
     * `$detectedMime` is the result of content-sniffing the file bytes
     * server-side (via `finfo_buffer` or equivalent). The controller
     * still cross-checks it against the allowlist; a sniff that
     * resolves to anything outside {@see MIME_TO_EXT} fails closed.
     */
    public function handle(
        ?int $pid,
        ?string $originalFilename,
        ?string $detectedMime,
        ?string $bytes,
    ): void {
        if ($pid === null || $pid <= 0) {
            $this->respondError(400, 'missing_pid');
            return;
        }

        if ($bytes === null || $bytes === '') {
            $this->respondError(400, 'missing_file');
            return;
        }

        if (strlen($bytes) > self::MAX_BYTES) {
            $this->respondError(413, 'file_too_large');
            return;
        }

        if ($detectedMime === null || !isset(self::MIME_TO_EXT[$detectedMime])) {
            $this->respondError(415, 'unsupported_media_type');
            return;
        }

        $extension = self::MIME_TO_EXT[$detectedMime];
        $generated = $this->uuidGenerator->generate();
        $filenameForDisplay = is_string($originalFilename) && trim($originalFilename) !== ''
            ? $originalFilename
            : $generated->canonical . '.' . $extension;

        try {
            $spacesUrl = $this->uploadService->upload(
                pid: $pid,
                documentUuid: $generated->canonical,
                extension: $extension,
                bytes: $bytes,
                contentType: $detectedMime,
            );
        } catch (\DomainException | \RuntimeException $e) {
            $this->logger->error('Document upload to Spaces failed', [
                'pid' => $pid,
                'documentUuid' => $generated->canonical,
                'mime' => $detectedMime,
                'exception' => $e,
            ]);
            $this->respondError(503, 'upload_unavailable');
            return;
        }

        $docTypeGuess = $this->guessDocType($originalFilename, $detectedMime);

        // Spaces is now the source of truth for the bytes; mirror them
        // to local disk and pre-write the documents row so the legacy
        // Documents-tab viewer can render the upload immediately
        // (without waiting for the agent's persist node to fire). A
        // failure here is a hard error: we already have bytes in
        // Spaces but the chart row is missing, so the user would see a
        // ghost upload otherwise. The Spaces orphan is tolerable.
        try {
            $stored = $this->localStore->store($pid, $filenameForDisplay, $bytes);
            $fileUrl = 'file://' . $stored['absolutePath'];
            $this->writeService->write(
                pid: $pid,
                docType: $docTypeGuess,
                url: $fileUrl,
                mimeType: $detectedMime,
                filename: $stored['filename'],
                hash: $stored['hash'],
                size: $stored['size'],
                documentUuid: $generated->canonical,
            );
        } catch (\DomainException | \RuntimeException $e) {
            $this->logger->error('Local document persistence failed after Spaces upload', [
                'pid' => $pid,
                'documentUuid' => $generated->canonical,
                'exception' => $e,
            ]);
            $this->respondError(503, 'persist_unavailable');
            return;
        }

        $this->logger->info('Document uploaded to Spaces and persisted locally', [
            'pid' => $pid,
            'documentUuid' => $generated->canonical,
            'mime' => $detectedMime,
            'docTypeGuess' => $docTypeGuess,
        ]);

        // `canonical_ext` is the file extension the agent's pipeline
        // route expects on the trigger envelope (see B.8's
        // `extract.php` → `/v1/agent/extract`). Returning it explicitly
        // saves the panel from parsing it back out of `spaces_url`.
        $this->respondJson(200, [
            'document_uuid' => $generated->canonical,
            'doc_type_guess' => $docTypeGuess,
            'spaces_url' => $spacesUrl,
            'canonical_ext' => $extension,
        ]);
    }

    /**
     * Filename heuristic for the panel's pre-pipeline `doc_type` guess.
     * The clinician can override before posting to the supervisor — the
     * agent-side `kickoffExtraction` handoff carries `doc_type` in its
     * args, so a wrong guess here is recoverable.
     *
     * PDF defaults to `lab_pdf` (the dominant case in the W2 fixture
     * set); images default to `intake_form` (intake-form pages are
     * commonly photographed). Filename tokens override the
     * MIME-derived default.
     */
    private function guessDocType(?string $filename, string $mime): string
    {
        $lower = is_string($filename) ? strtolower($filename) : '';
        if ($lower !== '') {
            if (str_contains($lower, 'intake') || str_contains($lower, 'form') || str_contains($lower, 'questionnaire')) {
                return self::DOC_TYPE_INTAKE_FORM;
            }
            if (str_contains($lower, 'lab') || str_contains($lower, 'cbc') || str_contains($lower, 'a1c') || str_contains($lower, 'panel')) {
                return self::DOC_TYPE_LAB_PDF;
            }
        }
        return $mime === 'application/pdf' ? self::DOC_TYPE_LAB_PDF : self::DOC_TYPE_INTAKE_FORM;
    }

    private function respondError(int $status, string $code): void
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json');
        }
        echo json_encode(['error' => $code], JSON_THROW_ON_ERROR);
    }

    /**
     * @param array<string, mixed> $body
     */
    private function respondJson(int $status, array $body): void
    {
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json');
        }
        echo json_encode($body, JSON_THROW_ON_ERROR);
    }
}
