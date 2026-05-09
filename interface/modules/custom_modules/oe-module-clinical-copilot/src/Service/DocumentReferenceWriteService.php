<?php

/**
 * Tier-1 writer for the W2 ingestion pipeline.
 *
 * The chat-upload flow pre-writes the `documents` row at the
 * {@see \OpenEMR\Modules\ClinicalCopilot\Controller\DocumentUploadController}
 * boundary so chat uploads land identical-on-disk to legacy
 * Documents-tab uploads (`type='file_url'`, `path_depth=1`,
 * `url='file://.../sites/default/documents/<pid>/<filename>'`). The
 * agent's persist node confirms the existing row instead of
 * re-inserting — see {@see confirmExisting}. The legacy
 * "post-extraction insert from the agent" mode still works for tests
 * and replays via {@see write}, but production traffic now flows
 * through the upload controller.
 *
 * The "fires existing `documents.post_insert` event" line in the
 * architecture is satisfied by dispatching
 * {@see DocumentReferenceCreatedEvent}: core OpenEMR has no
 * `documents.post_insert` Symfony event today, and forking core for one
 * event listener is the wrong trade. The W2 panel + observability
 * listeners attach to {@see DocumentReferenceCreatedEvent::EVENT_HANDLE}.
 *
 * The actual writes (documents row, categories tree, category linkage)
 * go through {@see DocumentTableWriter} so this service stays free of
 * SQL strings and is testable without a live DBAL connection.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

use OpenEMR\Modules\ClinicalCopilot\Auth\ClockInterface;
use OpenEMR\Modules\ClinicalCopilot\Events\DocumentReferenceCreatedEvent;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

final readonly class DocumentReferenceWriteService
{
    public const DOC_TYPE_LAB_PDF = 'lab_pdf';
    public const DOC_TYPE_INTAKE_FORM = 'intake_form';
    public const DOC_TYPE_REFERRAL_LETTER = 'referral_letter';

    private const VALID_DOC_TYPES = [
        self::DOC_TYPE_LAB_PDF,
        self::DOC_TYPE_INTAKE_FORM,
        self::DOC_TYPE_REFERRAL_LETTER,
    ];

    public function __construct(
        private DocumentTableWriter $tableWriter,
        private DocumentUuidGenerator $uuidGenerator,
        private EventDispatcherInterface $eventDispatcher,
        private ClockInterface $clock,
        private LoggerInterface $logger,
    ) {
    }

    /**
     * Insert a `documents` row pointing at a local file URL,
     * categorize it under the W2 module's category tree, and fire
     * {@see DocumentReferenceCreatedEvent}. Returns the canonical
     * UUID string the agent persists in `extraction_artifacts.document_uuid`.
     *
     * Idempotency: when `$documentUuid` is provided and a row already
     * exists for that UUID, this short-circuits and returns the
     * existing canonical UUID without re-inserting or re-dispatching
     * the event. The chat-upload controller passes the freshly minted
     * UUID through; replays/tests can omit it for a full insert with a
     * fresh UUID.
     *
     * @param int $pid Patient row id (`documents.foreign_id`).
     * @param string $docType One of {@see DOC_TYPE_LAB_PDF}, {@see DOC_TYPE_INTAKE_FORM}, {@see DOC_TYPE_REFERRAL_LETTER}.
     * @param string $url Local file URL (`file://<absolute-path>`).
     * @param string $mimeType MIME type of the canonical bytes (e.g. `application/pdf`).
     * @param string $filename Display filename for the document UI.
     * @param string $hash Content hash matching {@see \Document::createDocument} (sha3-512 hex).
     * @param int $size Byte count of the persisted file.
     * @param string|null $documentUuid Canonical UUID to use; null mints a fresh one.
     * @return string The DocumentReference UUID (lowercase 36-char form).
     */
    public function write(
        int $pid,
        string $docType,
        string $url,
        string $mimeType,
        string $filename,
        string $hash,
        int $size,
        ?string $documentUuid = null,
    ): string {
        if ($pid <= 0) {
            throw new \DomainException('pid must be positive');
        }
        if (!in_array($docType, self::VALID_DOC_TYPES, true)) {
            throw new \DomainException("unknown docType '{$docType}'");
        }
        if ($url === '' || $mimeType === '' || $filename === '') {
            throw new \DomainException('url, mimeType, filename must all be non-empty');
        }
        if ($hash === '') {
            throw new \DomainException('hash must be non-empty');
        }
        if ($size <= 0) {
            throw new \DomainException('size must be positive');
        }

        $generated = $documentUuid !== null
            ? $this->uuidGenerator->fromCanonical($documentUuid)
            : $this->uuidGenerator->generate();

        // Idempotency probe — caller (the chat-upload controller) has
        // already pre-written the row with this UUID, so a re-call
        // (e.g. retry after a transient agent-callback failure) must be
        // a no-op rather than a UNIQUE-violation crash. Look up by
        // binary UUID, not row id, because that's the value the caller
        // owns end-to-end.
        $existingRowId = $this->tableWriter->findRowIdByUuid($generated->binary);
        if ($existingRowId !== null) {
            $this->logger->info('Tier-1 DocumentReference already present (idempotent)', [
                'pid' => $pid,
                'docType' => $docType,
                'documentUuid' => $generated->canonical,
                'documentRowId' => $existingRowId,
            ]);
            return $generated->canonical;
        }

        $createdAt = $this->clock->now();

        try {
            $categoryId = $this->tableWriter->ensureCategory($docType);
            $documentRowId = $this->tableWriter->insertDocumentReferenceRow(
                pid: $pid,
                uuidBinary: $generated->binary,
                url: $url,
                mimeType: $mimeType,
                filename: $filename,
                hash: $hash,
                size: $size,
                createdAt: $createdAt,
                categoryId: $categoryId,
            );
        } catch (\Throwable $e) {
            $this->logger->error('Tier-1 DocumentReference write failed', [
                'pid' => $pid,
                'docType' => $docType,
                'exception' => $e,
            ]);
            throw new \RuntimeException('Tier-1 DocumentReference write failed', 0, $e);
        }

        $this->eventDispatcher->dispatch(
            new DocumentReferenceCreatedEvent(
                documentUuid: $generated->canonical,
                documentRowId: $documentRowId,
                pid: $pid,
                docType: $docType,
                spacesUrl: $url,
                createdAt: $createdAt,
            ),
            DocumentReferenceCreatedEvent::EVENT_HANDLE,
        );

        $this->logger->info('Tier-1 DocumentReference written', [
            'pid' => $pid,
            'docType' => $docType,
            'documentUuid' => $generated->canonical,
            'documentRowId' => $documentRowId,
        ]);

        return $generated->canonical;
    }

    /**
     * Confirm a `documents` row pre-written by the chat-upload
     * controller. The agent's persist node calls this after extraction
     * succeeds; the row already exists and we simply validate the
     * caller's identity claims (pid + docType) against the row before
     * acknowledging it.
     *
     * Throws {@see \DomainException} for shape violations and
     * {@see \RuntimeException} for an absent row. The Tier-1 endpoint
     * controller maps the latter to HTTP 409 with
     * `error: document_not_pre_written`.
     */
    public function confirmExisting(int $pid, string $docType, string $documentUuid): string
    {
        if ($pid <= 0) {
            throw new \DomainException('pid must be positive');
        }
        if (!in_array($docType, self::VALID_DOC_TYPES, true)) {
            throw new \DomainException("unknown docType '{$docType}'");
        }
        if ($documentUuid === '') {
            throw new \DomainException('documentUuid must be non-empty');
        }

        $generated = $this->uuidGenerator->fromCanonical($documentUuid);
        $existing = $this->tableWriter->findRowByUuid($generated->binary);
        if ($existing === null) {
            $this->logger->warning('Tier-1 confirm refused: no pre-written row', [
                'pid' => $pid,
                'docType' => $docType,
                'documentUuid' => $generated->canonical,
            ]);
            throw new \RuntimeException('document_not_pre_written');
        }

        if ($existing['pid'] !== $pid) {
            $this->logger->warning('Tier-1 confirm refused: pid mismatch', [
                'pid' => $pid,
                'existingPid' => $existing['pid'],
                'documentUuid' => $generated->canonical,
            ]);
            throw new \DomainException('pid_mismatch');
        }

        if ($existing['docType'] !== '' && $existing['docType'] !== $docType) {
            $this->logger->warning('Tier-1 confirm refused: docType mismatch', [
                'docType' => $docType,
                'existingDocType' => $existing['docType'],
                'documentUuid' => $generated->canonical,
            ]);
            throw new \DomainException('doc_type_mismatch');
        }

        $this->logger->info('Tier-1 DocumentReference confirmed (pre-written)', [
            'pid' => $pid,
            'docType' => $docType,
            'documentUuid' => $generated->canonical,
            'documentRowId' => $existing['rowId'],
        ]);
        return $generated->canonical;
    }
}
