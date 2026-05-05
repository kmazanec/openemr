<?php

/**
 * Isolated tests for ExternalEncounterAdapter.
 *
 * Mirrors {@see EncounterAdapterTest}: the two adapters share row
 * shape and DTO, but differ on `source.system` — `'ccda-importer'`
 * here, `'openemr'` there. The §4.1 follow-ups generator and the
 * verifier both rely on that distinction.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ExternalEncounterAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ExternalEncounterDataSource;
use PHPUnit\Framework\TestCase;

final class ExternalEncounterAdapterTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/SourceReference.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Encounter.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Normalize.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/ExternalEncounterDataSource.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/ExternalEncounterAdapter.php';
    }

    public function testHappyPathTagsCcdaImporterSystem(): void
    {
        $rows = [
            [
                'encounter' => 7,
                'encounter_date' => '2026-04-22',
                'encounter_type' => 'St. Mary ED',
                'reason' => 'Chest pain - discharged after negative workup',
            ],
        ];
        $list = (new ExternalEncounterAdapter($this->source($rows)))->fetchRecent(101, 365);

        $this->assertCount(1, $list);
        $first = $list[0];
        $this->assertNotNull($first->encounterDate);
        $this->assertSame('2026-04-22', $first->encounterDate->format('Y-m-d'));
        $this->assertSame('St. Mary ED', $first->type);
        $this->assertSame('Chest pain - discharged after negative workup', $first->reason);
        $this->assertSame('chart', $first->source->sourceType);
        $this->assertSame('7', $first->source->sourceId);
    }

    public function testPassesLookbackToDataSource(): void
    {
        $source = new class implements ExternalEncounterDataSource {
            public ?int $pid = null;

            public ?int $days = null;

            public function findRecentForPid(int $pid, int $lookbackDays): array
            {
                $this->pid = $pid;
                $this->days = $lookbackDays;
                return [];
            }
        };

        (new ExternalEncounterAdapter($source))->fetchRecent(101, 365);

        $this->assertSame(101, $source->pid);
        $this->assertSame(365, $source->days);
    }

    public function testZeroDateNormalizesToNull(): void
    {
        $rows = [
            [
                'encounter' => 9,
                'encounter_date' => '0000-00-00 00:00:00',
                'encounter_type' => 'St. Mary ED',
                'reason' => null,
            ],
        ];
        $list = (new ExternalEncounterAdapter($this->source($rows)))->fetchRecent(101, 365);
        $this->assertNull($list[0]->encounterDate);
        $this->assertNull($list[0]->reason);
        $this->assertSame('chart', $list[0]->source->sourceType);
    }

    public function testStripsRowsWithEmptyEncounterId(): void
    {
        $rows = [
            ['encounter' => 0, 'encounter_date' => '2026-04-22', 'encounter_type' => 'St. Mary ED', 'reason' => 'x'],
            ['encounter' => 7, 'encounter_date' => '2026-04-22', 'encounter_type' => 'St. Mary ED', 'reason' => 'x'],
        ];
        $list = (new ExternalEncounterAdapter($this->source($rows)))->fetchRecent(101, 365);
        $this->assertCount(1, $list);
        $this->assertSame('7', $list[0]->source->sourceId);
    }

    public function testEmptyResultPassesThrough(): void
    {
        $list = (new ExternalEncounterAdapter($this->source([])))->fetchRecent(101, 365);
        $this->assertSame([], $list);
    }

    /**
     * @param list<array<string, mixed>> $rows
     */
    private function source(array $rows): ExternalEncounterDataSource
    {
        return new class ($rows) implements ExternalEncounterDataSource {
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
