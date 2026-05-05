<?php

/**
 * Isolated tests for PrescriptionAdapter.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PrescriptionAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PrescriptionDataSource;
use PHPUnit\Framework\TestCase;
use RuntimeException;

final class PrescriptionAdapterTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/SourceReference.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Prescription.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Normalize.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/PrescriptionDataSource.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/PrescriptionAdapter.php';
    }

    public function testHappyPathBuildsPrescriptionList(): void
    {
        $rows = [
            [
                'id' => 7001,
                'drug' => 'metformin',
                'dosage' => '500 mg',
                'active' => 1,
                'route_title' => 'oral',
                'interval_title' => 'BID',
                'date_added' => '2024-08-15',
                'date_modified' => null,
                'prescriber' => 'Patel, Maya',
                'indication' => 'type 2 diabetes',
            ],
        ];
        $list = (new PrescriptionAdapter($this->source($rows)))->fetchRecent(101);

        $this->assertCount(1, $list);
        $rx = $list[0];
        $this->assertSame('metformin', $rx->name);
        $this->assertSame('500 mg', $rx->dose);
        $this->assertSame('oral', $rx->route);
        $this->assertSame('BID', $rx->frequency);
        $this->assertNotNull($rx->startDate);
        $this->assertSame('2024-08-15', $rx->startDate->format('Y-m-d'));
        $this->assertNull($rx->stopDate);
        $this->assertSame('Patel, Maya', $rx->prescriber);
        $this->assertSame('type 2 diabetes', $rx->indication);
        $this->assertSame(7001, $rx->prescriptionId);
        $this->assertSame('chart', $rx->source->sourceType);
        $this->assertSame('7001', $rx->source->sourceId);
    }

    public function testIndicationNormalizesEmptyToNull(): void
    {
        $rows = [
            [
                'id' => 7010,
                'drug' => 'lisinopril',
                'dosage' => '10 mg',
                'active' => 1,
                'route_title' => 'oral',
                'interval_title' => 'daily',
                'date_added' => '2026-03-20',
                'date_modified' => null,
                'prescriber' => 'Patel, Maya',
                'indication' => '',
            ],
        ];
        $rx = (new PrescriptionAdapter($this->source($rows)))->fetchRecent(101)[0];
        $this->assertNull($rx->indication);
    }

    public function testPrescriptionIdMirrorsSourceRecordId(): void
    {
        // The DTO carries prescriptionId as a top-level int alongside the
        // SourceReference's string recordId. They are the same value in
        // different shapes — pin that so a future change to one doesn't
        // silently desync from the other.
        $rows = [
            [
                'id' => 7020,
                'drug' => 'metformin',
                'dosage' => '500 mg',
                'active' => 1,
                'route_title' => 'oral',
                'interval_title' => 'BID',
                'date_added' => '2024-08-15',
                'date_modified' => null,
                'prescriber' => null,
                'indication' => null,
            ],
        ];
        $rx = (new PrescriptionAdapter($this->source($rows)))->fetchRecent(101)[0];
        $this->assertSame(7020, $rx->prescriptionId);
        $this->assertSame((string) $rx->prescriptionId, $rx->source->sourceId);
    }

    public function testActiveRowStopDateIsNullEvenWhenDateModifiedSet(): void
    {
        // Pins the safety contract: for active rows, date_modified
        // moves on benign edits (typo, route correction). Using it as a
        // stopDate would falsely "stop" the med. Active row → null
        // stopDate, period.
        $rows = [
            [
                'id' => 7002,
                'drug' => 'lisinopril',
                'dosage' => '10 mg',
                'active' => 1,
                'route_title' => 'oral',
                'interval_title' => 'daily',
                'date_added' => '2024-01-01',
                'date_modified' => '2026-04-01',
                'prescriber' => 'Patel, Maya',
            ],
        ];
        $list = (new PrescriptionAdapter($this->source($rows)))->fetchRecent(101);
        $this->assertNull($list[0]->stopDate);
    }

    public function testInactiveRowSurfacesStopDateFromDateModified(): void
    {
        // Inactive prescriptions surface in the snapshot so the briefing
        // can flag recent discontinuations. For active=0 rows the
        // adapter populates stopDate from date_modified — the best
        // signal `prescriptions` has for "when did this stop."
        $rows = [
            [
                'id' => 7030,
                'drug' => 'amlodipine',
                'dosage' => '5 mg',
                'active' => 0,
                'route_title' => 'oral',
                'interval_title' => 'daily',
                'date_added' => '2024-06-01',
                'date_modified' => '2026-04-15',
                'prescriber' => 'Patel, Maya',
                'indication' => 'hypertension',
            ],
        ];
        $list = (new PrescriptionAdapter($this->source($rows)))->fetchRecent(101);
        $this->assertCount(1, $list);
        $this->assertNotNull($list[0]->stopDate);
        $this->assertSame('2026-04-15', $list[0]->stopDate->format('Y-m-d'));
    }

    public function testEmptyOptionalFieldsNormalizeToNull(): void
    {
        $rows = [
            [
                'id' => 7003,
                'drug' => 'aspirin',
                'dosage' => '',
                'active' => 1,
                'route_title' => '',
                'interval_title' => '',
                'date_added' => '0000-00-00',
                'date_modified' => null,
                'prescriber' => '',
            ],
        ];
        $list = (new PrescriptionAdapter($this->source($rows)))->fetchRecent(101);
        $rx = $list[0];
        $this->assertNull($rx->dose);
        $this->assertNull($rx->route);
        $this->assertNull($rx->frequency);
        $this->assertNull($rx->startDate);
        $this->assertNull($rx->prescriber);
    }

    public function testStripsRowsWithEmptyDrugName(): void
    {
        $rows = [
            ['id' => 1, 'drug' => '', 'dosage' => '5 mg', 'active' => 1, 'route_title' => null,
                'interval_title' => null, 'date_added' => null, 'date_modified' => null, 'prescriber' => null],
            ['id' => 2, 'drug' => 'metformin', 'dosage' => '500 mg', 'active' => 1, 'route_title' => null,
                'interval_title' => null, 'date_added' => null, 'date_modified' => null, 'prescriber' => null],
        ];
        $list = (new PrescriptionAdapter($this->source($rows)))->fetchRecent(101);
        $this->assertCount(1, $list);
        $this->assertSame('metformin', $list[0]->name);
    }

    public function testDataLayerExceptionPropagates(): void
    {
        $source = new class implements PrescriptionDataSource {
            public function findRecentForPid(int $pid, int $lookbackDays): array
            {
                throw new RuntimeException('boom');
            }
        };
        $this->expectException(RuntimeException::class);
        (new PrescriptionAdapter($source))->fetchRecent(101);
    }

    public function testFetchRecentForwardsLookbackDays(): void
    {
        // The adapter passes its lookback param through to the data
        // source — pin that contract so a refactor of the production
        // SQL doesn't silently start ignoring the window.
        $source = new class implements PrescriptionDataSource {
            public ?int $capturedDays = null;

            public function findRecentForPid(int $pid, int $lookbackDays): array
            {
                $this->capturedDays = $lookbackDays;
                return [];
            }
        };
        (new PrescriptionAdapter($source))->fetchRecent(101, 30);
        $this->assertSame(30, $source->capturedDays);
    }

    /**
     * @param list<array<string, mixed>> $rows
     */
    private function source(array $rows): PrescriptionDataSource
    {
        return new class ($rows) implements PrescriptionDataSource {
            /** @param list<array<string, mixed>> $rows */
            public function __construct(private readonly array $rows)
            {
            }

            public function findRecentForPid(int $pid, int $lookbackDays): array
            {
                return $this->rows;
            }
        };
    }
}
