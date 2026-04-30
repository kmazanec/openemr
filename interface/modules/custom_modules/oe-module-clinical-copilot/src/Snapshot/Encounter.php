<?php

/**
 * Recent encounter summary line for a ChartSnapshot.
 *
 * Source-backed summary fields only — full notes are deliberately not
 * carried here in v1 (ARCHITECTURE.md §"ChartSnapshot": "recent
 * encounters with date, type, and source-backed summary fields"). If
 * Phase 4 needs full-text excerpts it should add a separate
 * `EncounterNote` DTO rather than widening this one.
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

/**
 * @phpstan-import-type SourceReferenceArray from SourceReference
 *
 * @phpstan-type EncounterArray array{
 *     encounterDate: ?string,
 *     type: ?string,
 *     reason: ?string,
 *     source: SourceReferenceArray,
 * }
 */
final readonly class Encounter
{
    public function __construct(
        public ?DateTimeImmutable $encounterDate,
        public ?string $type,
        public ?string $reason,
        public SourceReference $source,
    ) {
    }

    /**
     * @return EncounterArray
     */
    public function toArray(): array
    {
        return [
            'encounterDate' => $this->encounterDate?->format('Y-m-d'),
            'type' => $this->type,
            'reason' => $this->reason,
            'source' => $this->source->toArray(),
        ];
    }
}
