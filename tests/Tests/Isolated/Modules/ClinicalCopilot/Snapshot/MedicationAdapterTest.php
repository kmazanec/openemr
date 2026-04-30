<?php

/**
 * Isolated tests for MedicationAdapter.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\MedicationAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\MedicationDataSource;
use PHPUnit\Framework\TestCase;
use RuntimeException;

final class MedicationAdapterTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/SourceReference.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Medication.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Normalize.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/MedicationDataSource.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/MedicationAdapter.php';
    }

    public function testHappyPathBuildsMedicationList(): void
    {
        $rows = [
            [
                'id' => 7001,
                'drug' => 'metformin',
                'dosage' => '500 mg',
                'route_title' => 'oral',
                'interval_title' => 'BID',
                'date_added' => '2024-08-15',
                'date_modified' => null,
                'prescriber' => 'Patel, Maya',
            ],
        ];
        $list = (new MedicationAdapter($this->source($rows)))->fetchActive(101);

        $this->assertCount(1, $list);
        $med = $list[0];
        $this->assertSame('metformin', $med->name);
        $this->assertSame('500 mg', $med->dose);
        $this->assertSame('oral', $med->route);
        $this->assertSame('BID', $med->frequency);
        $this->assertNotNull($med->startDate);
        $this->assertSame('2024-08-15', $med->startDate->format('Y-m-d'));
        $this->assertNull($med->stopDate);
        $this->assertSame('Patel, Maya', $med->prescriber);
        $this->assertSame('MedicationRequest', $med->source->recordType);
        $this->assertSame('7001', $med->source->recordId);
    }

    public function testStopDateCarriedWhenPresent(): void
    {
        $rows = [
            [
                'id' => 7002,
                'drug' => 'lisinopril',
                'dosage' => '10 mg',
                'route_title' => 'oral',
                'interval_title' => 'daily',
                'date_added' => '2024-01-01',
                'date_modified' => '2026-04-01',
                'prescriber' => 'Patel, Maya',
            ],
        ];
        $list = (new MedicationAdapter($this->source($rows)))->fetchActive(101);
        $this->assertNotNull($list[0]->stopDate);
        $this->assertSame('2026-04-01', $list[0]->stopDate->format('Y-m-d'));
    }

    public function testEmptyOptionalFieldsNormalizeToNull(): void
    {
        $rows = [
            [
                'id' => 7003,
                'drug' => 'aspirin',
                'dosage' => '',
                'route_title' => '',
                'interval_title' => '',
                'date_added' => '0000-00-00',
                'date_modified' => null,
                'prescriber' => '',
            ],
        ];
        $list = (new MedicationAdapter($this->source($rows)))->fetchActive(101);
        $med = $list[0];
        $this->assertNull($med->dose);
        $this->assertNull($med->route);
        $this->assertNull($med->frequency);
        $this->assertNull($med->startDate);
        $this->assertNull($med->prescriber);
    }

    public function testStripsRowsWithEmptyDrugName(): void
    {
        $rows = [
            ['id' => 1, 'drug' => '', 'dosage' => '5 mg', 'route_title' => null, 'interval_title' => null,
                'date_added' => null, 'date_modified' => null, 'prescriber' => null],
            ['id' => 2, 'drug' => 'metformin', 'dosage' => '500 mg', 'route_title' => null, 'interval_title' => null,
                'date_added' => null, 'date_modified' => null, 'prescriber' => null],
        ];
        $list = (new MedicationAdapter($this->source($rows)))->fetchActive(101);
        $this->assertCount(1, $list);
        $this->assertSame('metformin', $list[0]->name);
    }

    public function testDataLayerExceptionPropagates(): void
    {
        $source = new class implements MedicationDataSource {
            public function findActiveForPid(int $pid): array
            {
                throw new RuntimeException('boom');
            }
        };
        $this->expectException(RuntimeException::class);
        (new MedicationAdapter($source))->fetchActive(101);
    }

    /**
     * @param list<array<string, mixed>> $rows
     */
    private function source(array $rows): MedicationDataSource
    {
        return new class ($rows) implements MedicationDataSource {
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
