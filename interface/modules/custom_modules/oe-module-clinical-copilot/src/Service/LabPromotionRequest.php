<?php

/**
 * Typed input for {@see ObservationLabWriteService::write()}. One
 * `LabPromotionRequest` corresponds to one accepted lab panel — the
 * clinician clicked "accept" on a single extracted lab document, the
 * agent translated it into this request, and the service writes a
 * `procedure_report` (the panel) plus one `procedure_result` per
 * analyte.
 *
 * Idempotency key is `(sourceDocumentUuid, panelCode, collectionDate)`
 * — re-promoting the same panel returns the existing IDs rather than
 * inserting duplicates. `panelCode` is nullable because some lab PDFs
 * lack a coded panel header; in that case the key collapses to
 * `(sourceDocumentUuid, NULL, collectionDate)`, which is still
 * sufficient because the document UUID is per-document.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Service;

use DomainException;

final readonly class LabPromotionRequest
{
    /**
     * @param non-empty-list<ObservationResult> $results
     */
    public function __construct(
        public int $pid,
        public string $sourceDocumentUuid,
        public ?string $panelCode,
        public string $collectionDate,
        public array $results,
        public int $promotedByUserId,
    ) {
        if ($this->pid <= 0) {
            throw new DomainException('LabPromotionRequest.pid must be positive');
        }
        if ($this->sourceDocumentUuid === '') {
            throw new DomainException('LabPromotionRequest.sourceDocumentUuid must be non-empty');
        }
        if ($this->collectionDate === '') {
            throw new DomainException('LabPromotionRequest.collectionDate must be non-empty');
        }
        if ($this->panelCode !== null && $this->panelCode === '') {
            throw new DomainException('LabPromotionRequest.panelCode must be null or non-empty');
        }
        if ($this->promotedByUserId <= 0) {
            throw new DomainException('LabPromotionRequest.promotedByUserId must be positive');
        }
    }
}
