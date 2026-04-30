<?php

/**
 * NoteContext is the per-patient chart snapshot the seed command computes
 * once and passes to EncounterNoteGenerator for token substitution. Holds
 * the most recent vital and lab values plus a comma-separated medication
 * list — the data points encounter notes plausibly reference.
 *
 * Optional fields are nullable (rather than empty strings) so the
 * generator can fall back cleanly when a patient lacks the data.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Seed\Generators;

final readonly class NoteContext
{
    public function __construct(
        public ?string $bp = null,
        public ?int $bpSystolic = null,
        public ?float $weight = null,
        public ?string $a1c = null,
        public ?float $a1cValue = null,
        public ?string $a1cAgeRelative = null,
        public ?string $medsCsv = null,
        public ?string $abnormalSummary = null,
    ) {
    }
}
