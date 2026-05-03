<?php

/**
 * Isolated tests for PhiMinimizer.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use DateTimeImmutable;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Demographics;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\PhiMinimizer;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;
use PHPUnit\Framework\TestCase;

final class PhiMinimizerTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        $files = [
            'SourceReference.php',
            'Demographics.php',
            'PhiMinimizer.php',
        ];
        foreach ($files as $f) {
            require_once self::MODULE_SNAPSHOT_DIR . '/' . $f;
        }
    }

    public function testDemographicsCarriesNoExcludedFields(): void
    {
        // ARCHITECTURE.md §"ChartSnapshot > Excluded by default":
        //   SSN, driver's license, full street address, phone, email,
        //   non-unique MRN/pubpid (except as display text), billing data,
        //   family/contact fields, full historical chart outside window.
        // None of those names may appear as a key in Demographics::toArray().
        $serialized = json_encode($this->demographics()->toArray(), JSON_THROW_ON_ERROR);

        foreach (PhiMinimizer::EXCLUDED_FROM_DEMOGRAPHICS as $forbidden) {
            $this->assertStringNotContainsString(
                "\"{$forbidden}\"",
                $serialized,
                "Demographics must never carry the excluded field: {$forbidden}",
            );
        }
    }

    public function testExcludedListCoversArchitectureBullets(): void
    {
        // ARCHITECTURE.md §"Excluded by default" enumerates SSN,
        // driver's license, street address, phone, email, MRN/pubpid,
        // billing-only data, family/contact fields. The list pinned in
        // PhiMinimizer must cover each of those categories — the test
        // names them by the OpenEMR column shape a future contributor
        // is most likely to reach for.
        $required = [
            'ssn',           // SSN
            'drivers_license', // driver's license
            'street',        // full street address
            'phone_home',    // phone (home)
            'phone_cell',    // phone (cell)
            'phone_biz',     // phone (biz)
            'email',         // email
            'pubpid',        // non-unique MRN / pubpid
            'billing',       // billing-only data
            'mothersname',   // family/contact fields
            'next_of_kin',
            'guardian',
        ];
        foreach ($required as $field) {
            $this->assertContains(
                $field,
                PhiMinimizer::EXCLUDED_FROM_DEMOGRAPHICS,
                "EXCLUDED_FROM_DEMOGRAPHICS must include '{$field}' (architecture bullet)",
            );
        }
    }

    public function testExcludedListNeverOverlapsCarriedDemographicsKeys(): void
    {
        // Sanity: the exclusion list must not name any field that the
        // Demographics DTO actually carries — that would be contradictory.
        $carriedKeys = ['pid', 'uuid', 'displayName', 'sex', 'dateOfBirth', 'ageYears', 'source'];
        $overlap = array_intersect($carriedKeys, PhiMinimizer::EXCLUDED_FROM_DEMOGRAPHICS);
        $this->assertSame(
            [],
            array_values($overlap),
            'EXCLUDED_FROM_DEMOGRAPHICS must not name fields the Demographics DTO carries',
        );
    }

    private function demographics(): Demographics
    {
        return new Demographics(
            pid: 101,
            uuid: '550e8400-e29b-41d4-a716-446655440000',
            displayName: 'Patel, Maya',
            sex: 'F',
            dateOfBirth: new DateTimeImmutable('1968-02-14'),
            ageYears: 58,
            source: new SourceReference(
                system: 'openemr',
                recordType: 'Patient',
                recordId: '101',
            ),
        );
    }
}
