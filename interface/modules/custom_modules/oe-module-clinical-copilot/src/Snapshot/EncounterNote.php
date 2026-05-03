<?php

/**
 * Encounter note (SOAP form) for a single visit.
 *
 * SOAP = Subjective / Objective / Assessment / Plan — the canonical
 * shape of a clinic visit note. Sourced from `form_soap` joined back
 * to `forms` and `form_encounter` so we can verify the note belongs
 * to the requested encounter.
 *
 * Each field is preserved verbatim from the underlying row — the
 * verifier compares displayed claim text against these strings, so
 * any normalization (HTML entity unwrap, whitespace squash) belongs
 * at the rendering layer, not here.
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
 * @phpstan-type EncounterNoteArray array{
 *     encounterId: string,
 *     noteId: string,
 *     noteDate: ?string,
 *     subjective: ?string,
 *     objective: ?string,
 *     assessment: ?string,
 *     plan: ?string,
 *     source: SourceReferenceArray,
 * }
 */
final readonly class EncounterNote
{
    public function __construct(
        public string $encounterId,
        public string $noteId,
        public ?DateTimeImmutable $noteDate,
        public ?string $subjective,
        public ?string $objective,
        public ?string $assessment,
        public ?string $plan,
        public SourceReference $source,
    ) {
    }

    /**
     * @return EncounterNoteArray
     */
    public function toArray(): array
    {
        return [
            'encounterId' => $this->encounterId,
            'noteId' => $this->noteId,
            'noteDate' => $this->noteDate?->format('Y-m-d'),
            'subjective' => $this->subjective,
            'objective' => $this->objective,
            'assessment' => $this->assessment,
            'plan' => $this->plan,
            'source' => $this->source->toArray(),
        ];
    }
}
