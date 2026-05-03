<?php

/**
 * Isolated tests for PatientAdapter.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use DateTimeImmutable;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PatientAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\PatientDataSource;
use PHPUnit\Framework\TestCase;
use RuntimeException;

final class PatientAdapterTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/SourceReference.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Demographics.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Normalize.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/PatientDataSource.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/PatientAdapter.php';
    }

    public function testHappyPathBuildsDemographics(): void
    {
        $row = [
            'pid' => 101,
            'uuid' => '550e8400-e29b-41d4-a716-446655440000',
            'fname' => 'Maya',
            'lname' => 'Patel',
            'mname' => '',
            'sex' => 'Female',
            'DOB' => '1968-02-14',
        ];
        $adapter = new PatientAdapter($this->source($row));

        $demo = $adapter->fetch(101);

        $this->assertSame(101, $demo->pid);
        $this->assertSame('550e8400-e29b-41d4-a716-446655440000', $demo->uuid);
        $this->assertSame('Patel, Maya', $demo->displayName);
        $this->assertSame('Female', $demo->sex);
        $this->assertNotNull($demo->dateOfBirth);
        $this->assertSame('1968-02-14', $demo->dateOfBirth->format('Y-m-d'));
        $this->assertSame('Patient', $demo->source->recordType);
        $this->assertSame('101', $demo->source->recordId);

        // Age computation uses "today" — pin it to whole-year arithmetic
        // against the DOB rather than a fixed expected number, so the
        // test does not need to be reseeded annually.
        $expectedAge = (new DateTimeImmutable('today'))
            ->diff(new DateTimeImmutable('1968-02-14'))->y;
        $this->assertSame($expectedAge, $demo->ageYears);
    }

    public function testZeroDobNormalizesToNull(): void
    {
        $row = [
            'pid' => 101,
            'uuid' => '550e8400-e29b-41d4-a716-446655440000',
            'fname' => 'X',
            'lname' => 'Y',
            'mname' => '',
            'sex' => '',
            'DOB' => '0000-00-00',
        ];
        $demo = (new PatientAdapter($this->source($row)))->fetch(101);

        $this->assertNull($demo->dateOfBirth);
        $this->assertNull($demo->sex);
        $this->assertNull($demo->ageYears);
    }

    public function testIncludesMiddleNameWhenPresent(): void
    {
        $row = [
            'pid' => 101,
            'uuid' => '550e8400-e29b-41d4-a716-446655440000',
            'fname' => 'Maya',
            'lname' => 'Patel',
            'mname' => 'K',
            'sex' => 'Female',
            'DOB' => '1968-02-14',
        ];
        $demo = (new PatientAdapter($this->source($row)))->fetch(101);
        $this->assertSame('Patel, Maya K', $demo->displayName);
    }

    public function testThrowsWhenPatientNotFound(): void
    {
        $this->expectException(RuntimeException::class);
        (new PatientAdapter($this->source(null)))->fetch(999);
    }

    public function testNeverIncludesPhiFromExcludedColumns(): void
    {
        // Adapter must not surface SSN/phone/address even if the data source
        // accidentally returns them — only the documented Demographics
        // fields can ever leave the adapter.
        $row = [
            'pid' => 101,
            'uuid' => '550e8400-e29b-41d4-a716-446655440000',
            'fname' => 'Maya',
            'lname' => 'Patel',
            'mname' => '',
            'sex' => 'Female',
            'DOB' => '1968-02-14',
            'ss' => '111-22-3333',
            'phone_home' => '555-1234',
            'street' => '1 Main St',
            'email' => 'maya@example.com',
        ];
        $demo = (new PatientAdapter($this->source($row)))->fetch(101);

        $serialized = json_encode($demo->toArray(), JSON_THROW_ON_ERROR);
        $this->assertStringNotContainsString('111-22-3333', $serialized);
        $this->assertStringNotContainsString('555-1234', $serialized);
        $this->assertStringNotContainsString('Main St', $serialized);
        $this->assertStringNotContainsString('maya@example.com', $serialized);
    }

    /**
     * @param ?array<string, mixed> $row
     */
    private function source(?array $row): PatientDataSource
    {
        return new class ($row) implements PatientDataSource {
            /** @param ?array<string, mixed> $row */
            public function __construct(private readonly ?array $row)
            {
            }

            public function findByPid(int $pid): ?array
            {
                return $this->row;
            }
        };
    }
}
