<?php

/**
 * Isolated tests for DataCategory + DataCategorySet.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\DataCategory;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\DataCategorySet;
use PHPUnit\Framework\TestCase;

final class DataCategorySetTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/DataCategory.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/DataCategorySet.php';
    }

    public function testEnumCoversTheArchitectureCategorySet(): void
    {
        // ARCHITECTURE.md §"Verification > Claim Ledger" enumerates:
        // medication, lab, allergy, diagnosis, encounter, appointment.
        $names = array_map(static fn (DataCategory $c): string => $c->value, DataCategory::cases());
        sort($names);
        $this->assertSame(
            ['allergy', 'appointment', 'diagnosis', 'encounter', 'lab', 'medication'],
            $names,
        );
    }

    public function testFromCategoriesAcceptsAnArrayOfEnums(): void
    {
        $set = DataCategorySet::of(DataCategory::Diagnosis, DataCategory::Allergy);

        $this->assertTrue($set->contains(DataCategory::Diagnosis));
        $this->assertTrue($set->contains(DataCategory::Allergy));
        $this->assertFalse($set->contains(DataCategory::Medication));
    }

    public function testDeduplicatesRepeatedCategories(): void
    {
        $set = DataCategorySet::of(DataCategory::Diagnosis, DataCategory::Diagnosis);
        $this->assertCount(1, iterator_to_array($set));
    }

    public function testFromStringsParsesValidValues(): void
    {
        $set = DataCategorySet::fromStrings(['diagnosis', 'lab']);
        $this->assertTrue($set->contains(DataCategory::Diagnosis));
        $this->assertTrue($set->contains(DataCategory::Lab));
        $this->assertFalse($set->contains(DataCategory::Encounter));
    }

    public function testFromStringsRejectsUnknownCategory(): void
    {
        $this->expectException(\DomainException::class);
        $this->expectExceptionMessageMatches('/unknown.+nope/i');
        DataCategorySet::fromStrings(['diagnosis', 'nope']);
    }

    public function testEmptySetSerializesAsEmptyArray(): void
    {
        $set = DataCategorySet::empty();
        $this->assertSame([], $set->toStrings());
        $this->assertFalse($set->contains(DataCategory::Allergy));
    }

    public function testAllReturnsEverySupportedCategory(): void
    {
        $all = DataCategorySet::all();
        foreach (DataCategory::cases() as $case) {
            $this->assertTrue($all->contains($case), "all() must include {$case->value}");
        }
    }

    public function testToStringsIsStableAndSorted(): void
    {
        // Two equivalent constructions return the same serialization,
        // independent of the order categories were added — important so
        // the disclosure audit (Phase 2.4) can compare requests by their
        // category fingerprint without ambiguity.
        $a = DataCategorySet::of(DataCategory::Lab, DataCategory::Diagnosis);
        $b = DataCategorySet::of(DataCategory::Diagnosis, DataCategory::Lab);
        $this->assertSame($a->toStrings(), $b->toStrings());
        $this->assertSame(['diagnosis', 'lab'], $a->toStrings());
    }
}
