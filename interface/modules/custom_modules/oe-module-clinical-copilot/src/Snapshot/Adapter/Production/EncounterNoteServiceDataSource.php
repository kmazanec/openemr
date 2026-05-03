<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\Production;

use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\EncounterNoteDataSource;

/**
 * Production-wired {@see EncounterNoteDataSource} reading SOAP-form
 * rows from `form_soap` joined to `forms` (encounter linkage) and
 * back to `form_encounter` (patient ownership check).
 *
 * The patient-id predicate is the trust boundary: it stops a caller
 * authorized for patient A from reading patient B's encounter notes
 * by guessing an encounter id.
 *
 * Filters out rows where the encounter, the form-registry entry, or
 * the SOAP row itself has been soft-deleted (`forms.deleted = 1` or
 * `form_soap.activity = 0`).
 */
final readonly class EncounterNoteServiceDataSource implements EncounterNoteDataSource
{
    public function findByEncounterForPid(int $pid, int $encounterId): array
    {
        return RowAssertion::listWithStringKeys(QueryUtils::fetchRecords(
            "SELECT fs.id,
                    DATE(fs.`date`) AS note_date,
                    fs.subjective, fs.objective, fs.assessment, fs.plan
               FROM form_soap fs
               JOIN forms f
                 ON f.form_id = fs.id
                AND f.formdir = 'soap'
                AND (f.deleted = 0 OR f.deleted IS NULL)
               JOIN form_encounter fe
                 ON fe.encounter = f.encounter
                AND fe.pid = f.pid
              WHERE f.encounter = ?
                AND f.pid = ?
                AND fs.activity = 1
              ORDER BY fs.`date` ASC, fs.id ASC",
            [$encounterId, $pid],
        ));
    }
}
