<?php

/**
 * Source reference attached to every clinical fact in a ChartSnapshot.
 *
 * Mirrors ARCHITECTURE.md §"Source Reference". The UI uses these to
 * render citations and link back to OpenEMR records where practical;
 * the verifier rejects any claim that does not carry one.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot;

use DateTimeImmutable;
use DomainException;

/**
 * @phpstan-type SourceReferenceArray array{
 *     system: string,
 *     recordType: string,
 *     recordId: string,
 *     field: ?string,
 *     recordedAt: ?string,
 * }
 */
final readonly class SourceReference
{
    public function __construct(
        public string $system,
        public string $recordType,
        public string $recordId,
        public ?string $field = null,
        public ?DateTimeImmutable $recordedAt = null,
    ) {
        if ($system === '') {
            throw new DomainException('SourceReference.system must not be empty');
        }
        if ($recordType === '') {
            throw new DomainException('SourceReference.recordType must not be empty');
        }
        if ($recordId === '') {
            throw new DomainException('SourceReference.recordId must not be empty');
        }
    }

    /**
     * @return SourceReferenceArray
     */
    public function toArray(): array
    {
        return [
            'system' => $this->system,
            'recordType' => $this->recordType,
            'recordId' => $this->recordId,
            'field' => $this->field,
            'recordedAt' => $this->recordedAt?->format('Y-m-d'),
        ];
    }
}
