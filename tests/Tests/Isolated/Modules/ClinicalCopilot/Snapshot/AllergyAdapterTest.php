<?php

/**
 * Isolated tests for AllergyAdapter.
 *
 * Per ARCHITECTURE.md §"Verification Architecture > Safety Rules", a
 * data-layer error here is a hard stop — the adapter must propagate the
 * exception, not paper over it.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AllergyAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AllergyDataSource;
use PHPUnit\Framework\TestCase;
use RuntimeException;

final class AllergyAdapterTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/SourceReference.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Allergy.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Normalize.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/AllergyDataSource.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/AllergyAdapter.php';
    }

    public function testHappyPathBuildsAllergyList(): void
    {
        $rows = [
            [
                'id' => 4001,
                'title' => 'penicillin',
                'reaction_title' => 'hives',
                'severity_al' => 'moderate',
            ],
        ];
        $list = (new AllergyAdapter($this->source($rows)))->fetchActive(101);

        $this->assertCount(1, $list);
        $this->assertSame('penicillin', $list[0]->substance);
        $this->assertSame('hives', $list[0]->reaction);
        $this->assertSame('moderate', $list[0]->severity);
        $this->assertSame('AllergyIntolerance', $list[0]->source->recordType);
        $this->assertSame('4001', $list[0]->source->recordId);
    }

    public function testEmptyReactionAndSeverityNormalizeToNull(): void
    {
        $rows = [
            ['id' => 4001, 'title' => 'penicillin', 'reaction_title' => '', 'severity_al' => ''],
        ];
        $list = (new AllergyAdapter($this->source($rows)))->fetchActive(101);
        $this->assertNull($list[0]->reaction);
        $this->assertNull($list[0]->severity);
    }

    public function testNoKnownAllergiesReturnsEmptyList(): void
    {
        $list = (new AllergyAdapter($this->source([])))->fetchActive(101);
        $this->assertSame([], $list);
    }

    public function testDataLayerExceptionPropagates(): void
    {
        // Fail-closed: the verifier (Phase 3.3) treats missing allergies as
        // a hard stop on medication summaries. The adapter is the
        // boundary — surface the failure, never swallow it.
        $source = new class implements AllergyDataSource {
            public function findActiveForPid(int $pid): array
            {
                throw new RuntimeException('database connection lost');
            }
        };

        $this->expectException(RuntimeException::class);
        (new AllergyAdapter($source))->fetchActive(101);
    }

    public function testStripsRowsWithEmptySubstance(): void
    {
        $rows = [
            ['id' => 1, 'title' => '', 'reaction_title' => 'rash', 'severity_al' => ''],
            ['id' => 2, 'title' => 'sulfa', 'reaction_title' => 'rash', 'severity_al' => 'mild'],
        ];
        $list = (new AllergyAdapter($this->source($rows)))->fetchActive(101);
        $this->assertCount(1, $list);
        $this->assertSame('sulfa', $list[0]->substance);
    }

    /**
     * @param list<array<string, mixed>> $rows
     */
    private function source(array $rows): AllergyDataSource
    {
        return new class ($rows) implements AllergyDataSource {
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
