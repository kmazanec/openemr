<?php

/**
 * Builds the encounter-note list for a single visit.
 *
 * Encounters can carry multiple SOAP rows (a visit may be amended or
 * documented across multiple authors); the adapter returns all of
 * them in date-ascending order so the caller can render the visit's
 * documentation as a coherent narrative.
 *
 * Empty SOAP fields normalize to null. A row in which all four SOAP
 * fields are empty is dropped — verifier rules require a citation to
 * point at content the model can quote, and there is nothing to quote
 * in an empty note.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

use DomainException;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\EncounterNote;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Normalize;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;

final readonly class EncounterNoteAdapter
{
    public function __construct(
        private EncounterNoteDataSource $source,
    ) {
    }

    /**
     * @return list<EncounterNote>
     */
    public function fetchForEncounter(int $pid, int $encounterId): array
    {
        $rows = $this->source->findByEncounterForPid($pid, $encounterId);

        $out = [];
        foreach ($rows as $row) {
            $note = $this->mapRow($row, $encounterId);
            if ($note !== null) {
                $out[] = $note;
            }
        }
        return $out;
    }

    /**
     * @param array<string, mixed> $row
     */
    private function mapRow(array $row, int $encounterId): ?EncounterNote
    {
        try {
            $noteId = Normalize::requireRecordId(Normalize::intOrStringField($row, 'id'));
        } catch (DomainException) {
            return null;
        }

        $subjective = Normalize::toOptionalString(Normalize::stringField($row, 'subjective'));
        $objective = Normalize::toOptionalString(Normalize::stringField($row, 'objective'));
        $assessment = Normalize::toOptionalString(Normalize::stringField($row, 'assessment'));
        $plan = Normalize::toOptionalString(Normalize::stringField($row, 'plan'));

        if ($subjective === null && $objective === null && $assessment === null && $plan === null) {
            return null;
        }

        $noteDate = Normalize::toDateImmutable(Normalize::stringField($row, 'note_date'));

        return new EncounterNote(
            encounterId: (string) $encounterId,
            noteId: $noteId,
            noteDate: $noteDate,
            subjective: $subjective,
            objective: $objective,
            assessment: $assessment,
            plan: $plan,
            source: new SourceReference(
                sourceType: 'chart',
                sourceId: $noteId,
                locator: ['field' => 'documentReference.text'],
                quote: $assessment ?? $subjective ?? 'note ' . $noteId,
                meta: $noteDate !== null ? ['record_recorded_at' => $noteDate->format('Y-m-d')] : null,
            ),
        );
    }
}
