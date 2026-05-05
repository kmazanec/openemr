<?php

/**
 * Isolated tests for VitalsAdapter.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\VitalsAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\VitalsDataSource;
use PHPUnit\Framework\TestCase;

final class VitalsAdapterTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/SourceReference.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/VitalSign.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Normalize.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/VitalsDataSource.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/VitalsAdapter.php';
    }

    public function testHappyPathBuildsVitalsList(): void
    {
        $rows = [
            [
                'id' => 12,
                'observed_at' => '2026-04-15',
                'bps' => '142',
                'bpd' => '86',
                'pulse' => '78',
                'respiration' => '16',
                'temperature' => '98.6',
                'weight' => '212.4',
                'height' => '70.0',
                'BMI' => '30.5',
                'oxygen_saturation' => '98',
            ],
        ];
        $list = (new VitalsAdapter($this->source($rows)))->fetchRecent(101, 90);

        $this->assertCount(1, $list);
        $vital = $list[0];
        $this->assertSame('142', $vital->bpSystolic);
        $this->assertSame('86', $vital->bpDiastolic);
        $this->assertSame('78', $vital->pulse);
        $this->assertSame('212.4', $vital->weightLbs);
        $this->assertSame('30.5', $vital->bmi);
        $this->assertSame('98', $vital->oxygenSaturation);
        $this->assertNotNull($vital->observedAt);
        $this->assertSame('2026-04-15', $vital->observedAt->format('Y-m-d'));
        $this->assertSame('chart', $vital->source->sourceType);
        $this->assertSame('12', $vital->source->sourceId);
    }

    public function testZeroFilledNumericsNormalizeToNull(): void
    {
        // form_vitals zero-fills missing numerics ("0.000000"); the
        // adapter must treat those as missing so a trend doesn't surface
        // filler values as if they were measured zeros.
        $rows = [
            [
                'id' => 1,
                'observed_at' => '2026-04-15',
                'bps' => '138',
                'bpd' => '82',
                'pulse' => '0',
                'respiration' => '0.000000',
                'temperature' => '0.0',
                'weight' => '210.0',
                'height' => '0.000000',
                'BMI' => '0.0',
                'oxygen_saturation' => '0.00',
            ],
        ];
        $list = (new VitalsAdapter($this->source($rows)))->fetchRecent(101, 90);

        $vital = $list[0];
        $this->assertSame('138', $vital->bpSystolic);
        $this->assertSame('210.0', $vital->weightLbs);
        $this->assertNull($vital->pulse);
        $this->assertNull($vital->respiration);
        $this->assertNull($vital->temperatureF);
        $this->assertNull($vital->heightInches);
        $this->assertNull($vital->bmi);
        $this->assertNull($vital->oxygenSaturation);
    }

    public function testStripsRowsWithNoVitalFieldsAtAll(): void
    {
        // A row that recorded nothing (zero-filled across the board) is
        // noise from an empty-form insert. Drop so the verifier never
        // sees a citation pointing to a row with nothing to cite.
        $rows = [
            [
                'id' => 1,
                'observed_at' => '2026-04-15',
                'bps' => '0', 'bpd' => '0', 'pulse' => '0', 'respiration' => '0',
                'temperature' => '0', 'weight' => '0', 'height' => '0',
                'BMI' => '0', 'oxygen_saturation' => '0',
            ],
            [
                'id' => 2,
                'observed_at' => '2026-04-15',
                'bps' => '138', 'bpd' => '82', 'pulse' => '0', 'respiration' => '0',
                'temperature' => '0', 'weight' => '0', 'height' => '0',
                'BMI' => '0', 'oxygen_saturation' => '0',
            ],
        ];
        $list = (new VitalsAdapter($this->source($rows)))->fetchRecent(101, 30);
        $this->assertCount(1, $list);
        $this->assertSame('2', $list[0]->source->sourceId);
    }

    public function testStripsRowWithMissingId(): void
    {
        $rows = [
            ['id' => 0, 'observed_at' => '2026-04-15',
                'bps' => '138', 'bpd' => '82', 'pulse' => null, 'respiration' => null,
                'temperature' => null, 'weight' => null, 'height' => null,
                'BMI' => null, 'oxygen_saturation' => null],
            ['id' => 7, 'observed_at' => '2026-04-15',
                'bps' => '142', 'bpd' => '88', 'pulse' => null, 'respiration' => null,
                'temperature' => null, 'weight' => null, 'height' => null,
                'BMI' => null, 'oxygen_saturation' => null],
        ];
        $list = (new VitalsAdapter($this->source($rows)))->fetchRecent(101, 30);
        $this->assertCount(1, $list);
        $this->assertSame('7', $list[0]->source->sourceId);
    }

    public function testPassesLookbackToDataSource(): void
    {
        $source = new class implements VitalsDataSource {
            public ?int $pid = null;

            public ?int $days = null;

            public function findRecentForPid(int $pid, int $lookbackDays): array
            {
                $this->pid = $pid;
                $this->days = $lookbackDays;
                return [];
            }

            public function findHistoryByVitalTypeForPid(
                int $pid,
                string $vitalType,
                int $lookbackDays,
            ): array {
                return [];
            }
        };

        (new VitalsAdapter($source))->fetchRecent(101, 90);

        $this->assertSame(101, $source->pid);
        $this->assertSame(90, $source->days);
    }

    public function testFetchHistoryPassesArgsToDataSource(): void
    {
        $source = new class implements VitalsDataSource {
            public ?int $pid = null;

            public ?string $vitalType = null;

            public ?int $days = null;

            public function findRecentForPid(int $pid, int $lookbackDays): array
            {
                return [];
            }

            public function findHistoryByVitalTypeForPid(
                int $pid,
                string $vitalType,
                int $lookbackDays,
            ): array {
                $this->pid = $pid;
                $this->vitalType = $vitalType;
                $this->days = $lookbackDays;
                return [];
            }
        };

        (new VitalsAdapter($source))->fetchHistory(101, 'systolic_bp', 730);

        $this->assertSame(101, $source->pid);
        $this->assertSame('systolic_bp', $source->vitalType);
        $this->assertSame(730, $source->days);
    }

    public function testFetchHistoryBuildsList(): void
    {
        $rows = [
            ['id' => 11, 'observed_at' => '2025-04-15',
                'bps' => '148', 'bpd' => '88', 'pulse' => null, 'respiration' => null,
                'temperature' => null, 'weight' => null, 'height' => null,
                'BMI' => null, 'oxygen_saturation' => null],
            ['id' => 12, 'observed_at' => '2026-04-15',
                'bps' => '138', 'bpd' => '82', 'pulse' => null, 'respiration' => null,
                'temperature' => null, 'weight' => null, 'height' => null,
                'BMI' => null, 'oxygen_saturation' => null],
        ];
        $list = (new VitalsAdapter($this->historySource($rows)))->fetchHistory(101, 'systolic_bp', 730);

        $this->assertCount(2, $list);
        $this->assertSame('148', $list[0]->bpSystolic);
        $this->assertSame('138', $list[1]->bpSystolic);
    }

    public function testEmptyResultPassesThrough(): void
    {
        $list = (new VitalsAdapter($this->source([])))->fetchRecent(101, 30);
        $this->assertSame([], $list);
    }

    public function testVitalTypesAllowlistCoversCommonTokens(): void
    {
        // The TS-side getVitalsHistory tool shares this list verbatim;
        // a divergence would surface as a 400 from the controller.
        $tokens = array_keys(VitalsAdapter::VITAL_TYPES);
        $this->assertContains('systolic_bp', $tokens);
        $this->assertContains('diastolic_bp', $tokens);
        $this->assertContains('weight', $tokens);
        $this->assertContains('bmi', $tokens);
    }

    /**
     * @param list<array<string, mixed>> $rows
     */
    private function source(array $rows): VitalsDataSource
    {
        return new class ($rows) implements VitalsDataSource {
            /** @param list<array<string, mixed>> $rows */
            public function __construct(private readonly array $rows)
            {
            }

            public function findRecentForPid(int $pid, int $lookbackDays): array
            {
                return $this->rows;
            }

            public function findHistoryByVitalTypeForPid(
                int $pid,
                string $vitalType,
                int $lookbackDays,
            ): array {
                return [];
            }
        };
    }

    /**
     * @param list<array<string, mixed>> $rows
     */
    private function historySource(array $rows): VitalsDataSource
    {
        return new class ($rows) implements VitalsDataSource {
            /** @param list<array<string, mixed>> $rows */
            public function __construct(private readonly array $rows)
            {
            }

            public function findRecentForPid(int $pid, int $lookbackDays): array
            {
                return [];
            }

            public function findHistoryByVitalTypeForPid(
                int $pid,
                string $vitalType,
                int $lookbackDays,
            ): array {
                return $this->rows;
            }
        };
    }
}
