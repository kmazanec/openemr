<?php

/**
 * Builds the display-safe Demographics DTO for a ChartSnapshot.
 *
 * Excludes by design (per ARCHITECTURE.md §"Excluded by default"):
 * SSN, full street address, phone, email, driver's license. The
 * adapter only reads the fields it carries forward; the data source
 * may surface more columns but they never reach the DTO.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\Demographics;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Normalize;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;
use RuntimeException;

final readonly class PatientAdapter
{
    public function __construct(
        private PatientDataSource $source,
    ) {
    }

    public function fetch(int $pid): Demographics
    {
        $row = $this->source->findByPid($pid);
        if ($row === null) {
            throw new RuntimeException('patient not found for pid ' . $pid);
        }

        $uuid = Normalize::stringField($row, 'uuid');
        if ($uuid === null) {
            throw new RuntimeException('patient row missing uuid for pid ' . $pid);
        }

        $dob = Normalize::toDateImmutable(Normalize::stringField($row, 'DOB'));
        return new Demographics(
            pid: $pid,
            uuid: $uuid,
            displayName: self::displayName($row),
            sex: Normalize::toOptionalString(Normalize::stringField($row, 'sex')),
            dateOfBirth: $dob,
            ageYears: Normalize::ageYears($dob),
            source: new SourceReference(
                system: 'openemr',
                recordType: 'Patient',
                recordId: Normalize::requireRecordId($pid),
            ),
        );
    }

    /**
     * @param array<string, mixed> $row
     */
    private static function displayName(array $row): string
    {
        $last = Normalize::stringField($row, 'lname') ?? '';
        $first = Normalize::stringField($row, 'fname') ?? '';
        $middle = Normalize::toOptionalString(Normalize::stringField($row, 'mname'));

        $given = $middle !== null ? trim($first . ' ' . $middle) : $first;
        return trim($last . ', ' . $given);
    }
}
