<?php

/**
 * Data-source seam for EncounterNoteAdapter.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

interface EncounterNoteDataSource
{
    /**
     * SOAP-form rows attached to a single encounter for a given
     * patient. The PID predicate is non-redundant: it prevents an
     * encounter id from a different patient (or a deleted encounter
     * row) from yielding notes the caller is not authorized to see.
     *
     * @return list<array<string, mixed>>
     */
    public function findByEncounterForPid(int $pid, int $encounterId): array;
}
