<?php

/**
 * Display-safe demographics for a ChartSnapshot.
 *
 * Adapter responsibility (Phase 2.2 PatientAdapter): SSN, full address,
 * phone, and email are excluded by default per ARCHITECTURE.md
 * §"Excluded by default". This DTO carries only the identity bits the
 * model needs.
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
 * @phpstan-type DemographicsArray array{
 *     pid: int,
 *     uuid: string,
 *     displayName: string,
 *     sex: ?string,
 *     dateOfBirth: ?string,
 *     ageYears: ?int,
 *     source: SourceReferenceArray,
 * }
 */
final readonly class Demographics
{
    public function __construct(
        public int $pid,
        public string $uuid,
        public string $displayName,
        public ?string $sex,
        public ?DateTimeImmutable $dateOfBirth,
        // Computed at adapter time from DOB and the current date. Carried
        // alongside DOB so the model never has to derive age from the date —
        // it kept getting that off-by-one because the year arithmetic
        // crosses the birthday differently in different prompts.
        public ?int $ageYears,
        public SourceReference $source,
    ) {
    }

    /**
     * @return DemographicsArray
     */
    public function toArray(): array
    {
        return [
            'pid' => $this->pid,
            'uuid' => $this->uuid,
            'displayName' => $this->displayName,
            'sex' => $this->sex,
            'dateOfBirth' => $this->dateOfBirth?->format('Y-m-d'),
            'ageYears' => $this->ageYears,
            'source' => $this->source->toArray(),
        ];
    }
}
