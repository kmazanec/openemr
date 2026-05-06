<?php

/**
 * Tier-1 writer for the W2 ingestion pipeline.
 *
 * Records that the canonical bytes of a clinical document landed in
 * DigitalOcean Spaces by inserting a `documents` row that carries the
 * `s3://<bucket>/<pid>/<documentUuid>.<ext>` URL — the pipeline's
 * vision/persistence path uses Spaces for storage, so this service
 * does *not* upload bytes itself. It only writes the pointer row +
 * categorization OpenEMR's own document UI uses.
 *
 * The architecture's "fires existing `documents.post_insert` event"
 * line is satisfied by dispatching {@see DocumentReferenceCreatedEvent}:
 * core OpenEMR has no `documents.post_insert` Symfony event today, and
 * forking core for one event listener is the wrong trade. The W2 panel
 * + observability listeners attach to
 * {@see DocumentReferenceCreatedEvent::EVENT_HANDLE}.
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

    public function __construct(
        private DocumentTableWriter $tableWriter,
        private DocumentUuidGenerator $uuidGenerator,
        private EventDispatcherInterface $eventDispatcher,
        private ClockInterface $clock,
        private LoggerInterface $logger,
    ) {
    }

    /**
     * Insert a `documents` row pointing at the canonical Spaces URL,
     * categorize it under the W2 module's category tree, and fire
     * {@see DocumentReferenceCreatedEvent}. Returns the canonical
     * UUID string the agent persists in `extraction_artifacts.document_uuid`.
     *
     * @param int $pid Patient row id (`documents.foreign_id`).
     * @param string $docType Either {@see DOC_TYPE_LAB_PDF} or {@see DOC_TYPE_INTAKE_FORM}.
     * @param string $spacesUrl Canonical Spaces URL (e.g. `s3://bucket/<pid>/<uuid>.pdf`).
     * @param string $mimeType MIME type of the canonical bytes (e.g. `application/pdf`).
     * @param string $filename Display filename for the document UI.
     * @return string The DocumentReference UUID (lowercase 36-char form).
     */
    public function write(
        int $pid,
        string $docType,
        string $spacesUrl,
        string $mimeType,
        string $filename,
    ): string {
        if ($pid <= 0) {
            throw new \DomainException('pid must be positive');
        }
        if ($docType !== self::DOC_TYPE_LAB_PDF && $docType !== self::DOC_TYPE_INTAKE_FORM) {
            throw new \DomainException("unknown docType '{$docType}'");
        }
        if ($spacesUrl === '' || $mimeType === '' || $filename === '') {
            throw new \DomainException('spacesUrl, mimeType, filename must all be non-empty');
        }

        $generated = $this->uuidGenerator->generate();
        $createdAt = $this->clock->now();

        try {
            $categoryId = $this->tableWriter->ensureCategory($docType);
            $documentRowId = $this->tableWriter->insertDocumentReferenceRow(
                pid: $pid,
                uuidBinary: $generated->binary,
                url: $spacesUrl,
                mimeType: $mimeType,
                filename: $filename,
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
                spacesUrl: $spacesUrl,
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
}
