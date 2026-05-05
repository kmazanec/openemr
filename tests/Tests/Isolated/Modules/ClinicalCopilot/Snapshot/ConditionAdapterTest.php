<?php

/**
 * Isolated tests for ConditionAdapter (active diagnoses).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ConditionAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ConditionDataSource;
use PHPUnit\Framework\TestCase;

final class ConditionAdapterTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/SourceReference.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Diagnosis.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Normalize.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/ConditionDataSource.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/ConditionAdapter.php';
    }

    public function testHappyPathBuildsDiagnosisList(): void
    {
        $rows = [
            [
                'id' => 9001,
                'title' => 'Type 2 diabetes mellitus without complications',
                'diagnosis' => 'ICD10:E11.9',
                'date' => '2024-08-01',
                'enddate' => null,
            ],
            [
                'id' => 9002,
                'title' => 'Hypertension',
                'diagnosis' => 'ICD10:I10',
                'date' => '2023-01-15',
                'enddate' => null,
            ],
        ];
        $adapter = new ConditionAdapter($this->source($rows));

        $list = $adapter->fetchActive(101);
        $this->assertCount(2, $list);

        $diabetes = $list[0];
        $this->assertSame('E11.9', $diabetes->code);
        $this->assertSame('ICD-10', $diabetes->codeSystem);
        $this->assertSame('Type 2 diabetes mellitus without complications', $diabetes->label);
        $this->assertNotNull($diabetes->onsetDate);
        $this->assertSame('2024-08-01', $diabetes->onsetDate->format('Y-m-d'));
        $this->assertSame('chart', $diabetes->source->sourceType);
        $this->assertSame('9001', $diabetes->source->sourceId);
    }

    public function testStripsEntriesMissingDiagnosisCode(): void
    {
        // OpenEMR allows free-text problem entries without a coded diagnosis.
        // Verifier rejects un-cited claims, so an un-coded row can't satisfy
        // a citation — drop it at the adapter, don't carry it forward as
        // an empty source.
        $rows = [
            ['id' => 1, 'title' => 'Heartburn (free text)', 'diagnosis' => '', 'date' => '2024-01-01', 'enddate' => null],
            ['id' => 2, 'title' => 'Type 2 DM', 'diagnosis' => 'ICD10:E11.9', 'date' => '2024-08-01', 'enddate' => null],
        ];
        $list = (new ConditionAdapter($this->source($rows)))->fetchActive(101);

        $this->assertCount(1, $list);
        $this->assertSame('E11.9', $list[0]->code);
    }

    public function testZeroDateNormalizesToNullOnset(): void
    {
        $rows = [
            ['id' => 1, 'title' => 'DM', 'diagnosis' => 'ICD10:E11.9', 'date' => '0000-00-00', 'enddate' => null],
        ];
        $list = (new ConditionAdapter($this->source($rows)))->fetchActive(101);
        $this->assertNull($list[0]->onsetDate);
    }

    public function testParsesIcd9SystemPrefix(): void
    {
        $rows = [
            ['id' => 5, 'title' => 'DM type 2', 'diagnosis' => 'ICD9:250.00', 'date' => '2010-01-01', 'enddate' => null],
        ];
        $list = (new ConditionAdapter($this->source($rows)))->fetchActive(101);
        $this->assertSame('250.00', $list[0]->code);
        $this->assertSame('ICD-9', $list[0]->codeSystem);
    }

    public function testReturnsEmptyListWhenNoActiveDiagnoses(): void
    {
        $list = (new ConditionAdapter($this->source([])))->fetchActive(101);
        $this->assertSame([], $list);
    }

    /**
     * @param list<array<string, mixed>> $rows
     */
    private function source(array $rows): ConditionDataSource
    {
        return new class ($rows) implements ConditionDataSource {
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
