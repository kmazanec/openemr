<?php

/**
 * Isolated tests for PrescriptionProvenanceAdapter (§4.3 UC3).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Adapter;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PrescriptionProvenanceAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PrescriptionProvenanceDataSource;
use PHPUnit\Framework\TestCase;

final class PrescriptionProvenanceAdapterTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/Normalize.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/PrescriptionProvenance.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/PrescriptionProvenanceDataSource.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/PrescriptionProvenanceAdapter.php';
    }

    public function testHappyPathReturnsProvenance(): void
    {
        $row = [
            'id' => 7001,
            'drug' => 'lisinopril',
            'dosage' => '10 mg',
            'date_added' => '2026-03-20',
            'indication' => 'new-onset hypertension',
            'prescriber' => 'Patel, Maya',
        ];
        $prov = (new PrescriptionProvenanceAdapter($this->source($row)))->fetchByPid(101, 7001);

        $this->assertNotNull($prov);
        $this->assertSame(7001, $prov->prescriptionId);
        $this->assertSame('lisinopril', $prov->drugName);
        $this->assertSame('Patel, Maya', $prov->prescriber);
        $this->assertNotNull($prov->prescribingDate);
        $this->assertSame('2026-03-20', $prov->prescribingDate->format('Y-m-d'));
        $this->assertSame('new-onset hypertension', $prov->indication);
        $this->assertSame(
            [['dose' => '10 mg', 'date' => '2026-03-20']],
            $prov->doseAdjustments,
        );
    }

    public function testNullIndicationStaysNull(): void
    {
        $row = [
            'id' => 7002,
            'drug' => 'lisinopril',
            'dosage' => '10 mg',
            'date_added' => '2026-03-20',
            'indication' => null,
            'prescriber' => 'Patel, Maya',
        ];
        $prov = (new PrescriptionProvenanceAdapter($this->source($row)))->fetchByPid(101, 7002);
        $this->assertNotNull($prov);
        $this->assertNull($prov->indication);
    }

    public function testNullPrescriberStaysNull(): void
    {
        $row = [
            'id' => 7003,
            'drug' => 'lisinopril',
            'dosage' => '10 mg',
            'date_added' => '2026-03-20',
            'indication' => 'new-onset hypertension',
            'prescriber' => null,
        ];
        $prov = (new PrescriptionProvenanceAdapter($this->source($row)))->fetchByPid(101, 7003);
        $this->assertNotNull($prov);
        $this->assertNull($prov->prescriber);
    }

    public function testRowNotFoundReturnsNull(): void
    {
        $source = new class implements PrescriptionProvenanceDataSource {
            public function findByPrescriptionId(int $pid, int $prescriptionId): ?array
            {
                return null;
            }
        };
        $this->assertNull((new PrescriptionProvenanceAdapter($source))->fetchByPid(101, 9999));
    }

    public function testEmptyDoseAndDateProducesEmptyAdjustmentsList(): void
    {
        // Both fields null → nothing documented to surface; doseAdjustments
        // must be empty rather than `[{dose: null, date: null}]`, so the
        // model can't pretend a documented dose existed.
        $row = [
            'id' => 7004,
            'drug' => 'aspirin',
            'dosage' => '',
            'date_added' => '0000-00-00',
            'indication' => null,
            'prescriber' => null,
        ];
        $prov = (new PrescriptionProvenanceAdapter($this->source($row)))->fetchByPid(101, 7004);
        $this->assertNotNull($prov);
        $this->assertSame([], $prov->doseAdjustments);
    }

    public function testRowWithEmptyDrugReturnsNull(): void
    {
        // A prescription row with no drug name can't power a citation.
        // Returning null here lets the controller respond 404.
        $row = [
            'id' => 7005,
            'drug' => '',
            'dosage' => '10 mg',
            'date_added' => '2026-03-20',
            'indication' => null,
            'prescriber' => null,
        ];
        $this->assertNull(
            (new PrescriptionProvenanceAdapter($this->source($row)))->fetchByPid(101, 7005),
        );
    }

    /**
     * @param array<string, mixed> $row
     */
    private function source(array $row): PrescriptionProvenanceDataSource
    {
        return new class ($row) implements PrescriptionProvenanceDataSource {
            /** @param array<string, mixed> $row */
            public function __construct(private readonly array $row)
            {
            }

            // Covariant narrowing: the interface declares ?array (the
            // production source returns null on a row miss), but this
            // stub always serves the row it was constructed with — so
            // narrow to `array` rather than declare a nullable that
            // can never fire and trip PHPStan's `return.unusedType`.
            public function findByPrescriptionId(int $pid, int $prescriptionId): array
            {
                return $this->row;
            }
        };
    }
}
