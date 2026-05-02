<?php

/**
 * Isolated tests for ObservationAdapter.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ObservationAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ObservationDataSource;
use PHPUnit\Framework\TestCase;

final class ObservationAdapterTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/SourceReference.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/LabObservation.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Normalize.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/ObservationDataSource.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/ObservationAdapter.php';
    }

    public function testHappyPathBuildsLabList(): void
    {
        $rows = [
            [
                'id' => 12,
                'analyte' => 'A1c',
                'value' => '8.4',
                'units' => '%',
                'range' => '4.0-5.6',
                'abnormal' => 'H',
                'observed_at' => '2026-04-15',
            ],
        ];
        $list = (new ObservationAdapter($this->source($rows)))->fetchRecent(101, 90);

        $this->assertCount(1, $list);
        $lab = $list[0];
        $this->assertSame('A1c', $lab->analyte);
        $this->assertSame('8.4', $lab->value);
        $this->assertSame('%', $lab->unit);
        $this->assertSame('4.0-5.6', $lab->referenceRange);
        $this->assertSame('H', $lab->abnormalFlag);
        $this->assertNotNull($lab->observedAt);
        $this->assertSame('2026-04-15', $lab->observedAt->format('Y-m-d'));
        $this->assertSame('Observation', $lab->source->recordType);
        $this->assertSame('12', $lab->source->recordId);
    }

    public function testPassesLookbackToDataSource(): void
    {
        $source = new class implements ObservationDataSource {
            public ?int $pid = null;

            public ?int $days = null;

            public function findRecentForPid(int $pid, int $lookbackDays): array
            {
                $this->pid = $pid;
                $this->days = $lookbackDays;
                return [];
            }

            public function findHistoryByAnalyteForPid(
                int $pid,
                string $analyte,
                int $lookbackDays,
            ): array {
                return [];
            }
        };

        (new ObservationAdapter($source))->fetchRecent(101, 90);

        $this->assertSame(101, $source->pid);
        $this->assertSame(90, $source->days);
    }

    public function testPreservesNonNumericValues(): void
    {
        // Lab values can carry text qualifiers (>500, <0.01, positive).
        // Adapter must not coerce — verifier compares against the source.
        $rows = [
            ['id' => 1, 'analyte' => 'TSH', 'value' => '<0.01', 'units' => 'mIU/L',
                'range' => '0.4-4.0', 'abnormal' => 'L', 'observed_at' => '2026-04-15'],
            ['id' => 2, 'analyte' => 'Strep A', 'value' => 'positive', 'units' => null,
                'range' => null, 'abnormal' => null, 'observed_at' => '2026-04-15'],
        ];
        $list = (new ObservationAdapter($this->source($rows)))->fetchRecent(101, 30);
        $this->assertSame('<0.01', $list[0]->value);
        $this->assertSame('positive', $list[1]->value);
        $this->assertNull($list[1]->unit);
    }

    public function testStripsRowsWithEmptyAnalyteOrValue(): void
    {
        $rows = [
            ['id' => 1, 'analyte' => '', 'value' => '8.4', 'units' => '%',
                'range' => null, 'abnormal' => null, 'observed_at' => '2026-04-15'],
            ['id' => 2, 'analyte' => 'A1c', 'value' => '', 'units' => '%',
                'range' => null, 'abnormal' => null, 'observed_at' => '2026-04-15'],
            ['id' => 3, 'analyte' => 'A1c', 'value' => '8.4', 'units' => '%',
                'range' => null, 'abnormal' => null, 'observed_at' => '2026-04-15'],
        ];
        $list = (new ObservationAdapter($this->source($rows)))->fetchRecent(101, 30);
        $this->assertCount(1, $list);
        $this->assertSame('3', $list[0]->source->recordId);
    }

    public function testEmptyResultPassesThrough(): void
    {
        $list = (new ObservationAdapter($this->source([])))->fetchRecent(101, 30);
        $this->assertSame([], $list);
    }

    public function testFetchHistoryByAnalyteBuildsLabList(): void
    {
        $rows = [
            ['id' => 11, 'analyte' => 'Hemoglobin A1c', 'value' => '7.2', 'units' => '%',
                'range' => '4.0-5.6', 'abnormal' => 'H', 'observed_at' => '2024-04-15'],
            ['id' => 12, 'analyte' => 'Hemoglobin A1c', 'value' => '8.1', 'units' => '%',
                'range' => '4.0-5.6', 'abnormal' => 'H', 'observed_at' => '2025-04-15'],
            ['id' => 13, 'analyte' => 'Hemoglobin A1c', 'value' => '9.4', 'units' => '%',
                'range' => '4.0-5.6', 'abnormal' => 'H', 'observed_at' => '2026-04-15'],
        ];
        $list = (new ObservationAdapter($this->historySource($rows)))
            ->fetchHistoryByAnalyte(101, 'Hemoglobin A1c', 730);

        $this->assertCount(3, $list);
        $this->assertSame('7.2', $list[0]->value);
        $this->assertSame('9.4', $list[2]->value);
    }

    public function testFetchHistoryByAnalytePassesArgsToDataSource(): void
    {
        $source = new class implements ObservationDataSource {
            public ?int $pid = null;

            public ?string $analyte = null;

            public ?int $days = null;

            public function findRecentForPid(int $pid, int $lookbackDays): array
            {
                return [];
            }

            public function findHistoryByAnalyteForPid(
                int $pid,
                string $analyte,
                int $lookbackDays,
            ): array {
                $this->pid = $pid;
                $this->analyte = $analyte;
                $this->days = $lookbackDays;
                return [];
            }
        };

        (new ObservationAdapter($source))
            ->fetchHistoryByAnalyte(101, 'A1c', 730);

        $this->assertSame(101, $source->pid);
        $this->assertSame('A1c', $source->analyte);
        $this->assertSame(730, $source->days);
    }

    public function testFetchHistoryByAnalyteStripsRowsWithEmptyAnalyteOrValue(): void
    {
        $rows = [
            ['id' => 1, 'analyte' => '', 'value' => '8.1', 'units' => '%',
                'range' => null, 'abnormal' => null, 'observed_at' => '2025-04-15'],
            ['id' => 2, 'analyte' => 'A1c', 'value' => '', 'units' => '%',
                'range' => null, 'abnormal' => null, 'observed_at' => '2025-04-15'],
            ['id' => 3, 'analyte' => 'A1c', 'value' => '9.4', 'units' => '%',
                'range' => null, 'abnormal' => null, 'observed_at' => '2026-04-15'],
        ];
        $list = (new ObservationAdapter($this->historySource($rows)))
            ->fetchHistoryByAnalyte(101, 'A1c', 730);
        $this->assertCount(1, $list);
        $this->assertSame('3', $list[0]->source->recordId);
    }

    /**
     * @param list<array<string, mixed>> $rows
     */
    private function source(array $rows): ObservationDataSource
    {
        return new class ($rows) implements ObservationDataSource {
            /** @param list<array<string, mixed>> $rows */
            public function __construct(private readonly array $rows)
            {
            }

            public function findRecentForPid(int $pid, int $lookbackDays): array
            {
                return $this->rows;
            }

            public function findHistoryByAnalyteForPid(
                int $pid,
                string $analyte,
                int $lookbackDays,
            ): array {
                return [];
            }
        };
    }

    /**
     * @param list<array<string, mixed>> $rows
     */
    private function historySource(array $rows): ObservationDataSource
    {
        return new class ($rows) implements ObservationDataSource {
            /** @param list<array<string, mixed>> $rows */
            public function __construct(private readonly array $rows)
            {
            }

            public function findRecentForPid(int $pid, int $lookbackDays): array
            {
                return [];
            }

            public function findHistoryByAnalyteForPid(
                int $pid,
                string $analyte,
                int $lookbackDays,
            ): array {
                return $this->rows;
            }
        };
    }
}
