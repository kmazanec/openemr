<?php

/**
 * Isolated tests for MedicationStatementAdapter.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\MedicationStatementAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\MedicationStatementDataSource;
use PHPUnit\Framework\TestCase;
use RuntimeException;

final class MedicationStatementAdapterTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/SourceReference.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/MedicationStatement.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Normalize.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/MedicationStatementDataSource.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/MedicationStatementAdapter.php';
    }

    public function testHappyPathBuildsStatementList(): void
    {
        $rows = [
            [
                'id'                          => 95001,
                'pid'                         => 5005,
                'title'                       => 'Tylenol',
                'begdate'                     => '2024-06-01',
                'enddate'                     => null,
                'date'                        => '2024-06-01',
                'drug_dosage_instructions'    => '500 mg as needed',
                'usage_category_title'        => 'OTC',
                'information_source_title'    => 'Patient',
            ],
        ];
        $list = (new MedicationStatementAdapter($this->source($rows)))->fetchActive(5005);

        $this->assertCount(1, $list);
        $stmt = $list[0];
        $this->assertSame('Tylenol', $stmt->name);
        $this->assertSame('500 mg as needed', $stmt->dose);
        $this->assertSame('OTC', $stmt->usageCategory);
        $this->assertSame('Patient', $stmt->informationSource);
        $this->assertNotNull($stmt->startDate);
        $this->assertSame('2024-06-01', $stmt->startDate->format('Y-m-d'));
        $this->assertNull($stmt->stopDate);
        $this->assertSame(95001, $stmt->listId);
        $this->assertSame('chart', $stmt->source->sourceType);
        $this->assertSame('95001', $stmt->source->sourceId);
    }

    public function testNullDoseAndUsageCategoryStayNull(): void
    {
        // Patient-reported entries often arrive without structure.
        // The DTO must accept that — the verifier only requires the
        // `name`, so a row with just a name still produces a valid
        // citation.
        $rows = [
            [
                'id'                          => 95010,
                'pid'                         => 999,
                'title'                       => 'Vitamin D',
                'begdate'                     => null,
                'enddate'                     => null,
                'date'                        => null,
                'drug_dosage_instructions'    => null,
                'usage_category_title'        => null,
                'information_source_title'    => null,
            ],
        ];
        $stmt = (new MedicationStatementAdapter($this->source($rows)))->fetchActive(999)[0];
        $this->assertSame('Vitamin D', $stmt->name);
        $this->assertNull($stmt->dose);
        $this->assertNull($stmt->usageCategory);
        $this->assertNull($stmt->informationSource);
        $this->assertNull($stmt->startDate);
    }

    public function testStripsRowsWithEmptyTitle(): void
    {
        $rows = [
            ['id' => 1, 'pid' => 99, 'title' => '', 'begdate' => null, 'enddate' => null,
                'date' => null, 'drug_dosage_instructions' => null,
                'usage_category_title' => null, 'information_source_title' => null],
            ['id' => 2, 'pid' => 99, 'title' => 'Tylenol', 'begdate' => null, 'enddate' => null,
                'date' => null, 'drug_dosage_instructions' => null,
                'usage_category_title' => null, 'information_source_title' => null],
        ];
        $list = (new MedicationStatementAdapter($this->source($rows)))->fetchActive(99);
        $this->assertCount(1, $list);
        $this->assertSame('Tylenol', $list[0]->name);
    }

    public function testEndedEntryCarriesStopDate(): void
    {
        // A patient who reports they stopped taking an OTC entry —
        // the briefing should show the stopDate so the clinician
        // sees the recent change.
        $rows = [
            [
                'id'                          => 95020,
                'pid'                         => 99,
                'title'                       => 'Aspirin',
                'begdate'                     => '2023-01-01',
                'enddate'                     => '2026-03-15',
                'date'                        => '2023-01-01',
                'drug_dosage_instructions'    => '81 mg daily',
                'usage_category_title'        => 'OTC',
                'information_source_title'    => 'Patient',
            ],
        ];
        $stmt = (new MedicationStatementAdapter($this->source($rows)))->fetchActive(99)[0];
        $this->assertNotNull($stmt->stopDate);
        $this->assertSame('2026-03-15', $stmt->stopDate->format('Y-m-d'));
    }

    public function testDataLayerExceptionPropagates(): void
    {
        $source = new class implements MedicationStatementDataSource {
            public function findActiveForPid(int $pid): array
            {
                throw new RuntimeException('boom');
            }
        };
        $this->expectException(RuntimeException::class);
        (new MedicationStatementAdapter($source))->fetchActive(99);
    }

    /**
     * @param list<array<string, mixed>> $rows
     */
    private function source(array $rows): MedicationStatementDataSource
    {
        return new class ($rows) implements MedicationStatementDataSource {
            /** @param list<array<string, mixed>> $rows */
            public function __construct(private readonly array $rows)
            {
            }

            public function findActiveForPid(int $pid): array
            {
                return $this->rows;
            }
        };
    }
}
