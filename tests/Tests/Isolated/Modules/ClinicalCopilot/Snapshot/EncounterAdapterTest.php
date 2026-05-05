<?php

/**
 * Isolated tests for EncounterAdapter.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\EncounterAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\EncounterDataSource;
use PHPUnit\Framework\TestCase;

final class EncounterAdapterTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/SourceReference.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Encounter.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Normalize.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/EncounterDataSource.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/EncounterAdapter.php';
    }

    public function testHappyPathBuildsEncounterList(): void
    {
        $rows = [
            [
                'encounter' => 44,
                'encounter_date' => '2026-03-10',
                'encounter_type' => 'office-visit',
                'reason' => 'follow-up: diabetes',
            ],
            [
                'encounter' => 45,
                'encounter_date' => '2026-04-01',
                'encounter_type' => 'telehealth',
                'reason' => 'med refill',
            ],
        ];
        $list = (new EncounterAdapter($this->source($rows)))->fetchRecent(101, 180);

        $this->assertCount(2, $list);
        $first = $list[0];
        $this->assertNotNull($first->encounterDate);
        $this->assertSame('2026-03-10', $first->encounterDate->format('Y-m-d'));
        $this->assertSame('office-visit', $first->type);
        $this->assertSame('follow-up: diabetes', $first->reason);
        $this->assertSame('chart', $first->source->sourceType);
        $this->assertSame('44', $first->source->sourceId);
    }

    public function testPassesLookbackToDataSource(): void
    {
        $source = new class implements EncounterDataSource {
            public ?int $pid = null;

            public ?int $days = null;

            public function findRecentForPid(int $pid, int $lookbackDays): array
            {
                $this->pid = $pid;
                $this->days = $lookbackDays;
                return [];
            }
        };

        (new EncounterAdapter($source))->fetchRecent(101, 180);

        $this->assertSame(101, $source->pid);
        $this->assertSame(180, $source->days);
    }

    public function testZeroDateNormalizesToNull(): void
    {
        $rows = [
            ['encounter' => 44, 'encounter_date' => '0000-00-00 00:00:00',
                'encounter_type' => 'office-visit', 'reason' => null],
        ];
        $list = (new EncounterAdapter($this->source($rows)))->fetchRecent(101, 180);
        $this->assertNull($list[0]->encounterDate);
        $this->assertNull($list[0]->reason);
    }

    public function testStripsRowsWithEmptyEncounterId(): void
    {
        $rows = [
            ['encounter' => 0, 'encounter_date' => '2026-03-10', 'encounter_type' => 'office-visit', 'reason' => 'x'],
            ['encounter' => 44, 'encounter_date' => '2026-03-10', 'encounter_type' => 'office-visit', 'reason' => 'x'],
        ];
        $list = (new EncounterAdapter($this->source($rows)))->fetchRecent(101, 180);
        $this->assertCount(1, $list);
        $this->assertSame('44', $list[0]->source->sourceId);
    }

    public function testEmptyResultPassesThrough(): void
    {
        $list = (new EncounterAdapter($this->source([])))->fetchRecent(101, 180);
        $this->assertSame([], $list);
    }

    /**
     * @param list<array<string, mixed>> $rows
     */
    private function source(array $rows): EncounterDataSource
    {
        return new class ($rows) implements EncounterDataSource {
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
