<?php

/**
 * Isolated tests for the SourceReference value object.
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\SourceReference;
use PHPUnit\Framework\TestCase;

final class SourceReferenceTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/SourceReference.php';
    }

    public function testToArrayShapeMatchesArchitectureDoc(): void
    {
        $ref = new SourceReference(
            system: 'openemr',
            recordType: 'MedicationRequest',
            recordId: 'rx-123',
            field: 'dosageInstruction',
            recordedAt: new DateTimeImmutable('2026-04-20'),
        );

        $this->assertSame(
            [
                'system' => 'openemr',
                'recordType' => 'MedicationRequest',
                'recordId' => 'rx-123',
                'field' => 'dosageInstruction',
                'recordedAt' => '2026-04-20',
            ],
            $ref->toArray(),
        );
    }

    public function testFieldAndRecordedAtAreOptional(): void
    {
        $ref = new SourceReference(
            system: 'openemr',
            recordType: 'AllergyIntolerance',
            recordId: 'allergy-7',
        );

        $this->assertSame(
            [
                'system' => 'openemr',
                'recordType' => 'AllergyIntolerance',
                'recordId' => 'allergy-7',
                'field' => null,
                'recordedAt' => null,
            ],
            $ref->toArray(),
        );
    }

    public function testEmptyRequiredFieldsAreRejected(): void
    {
        $this->expectException(\DomainException::class);
        new SourceReference(system: '', recordType: 'MedicationRequest', recordId: 'rx-1');
    }

    public function testEmptyRecordTypeIsRejected(): void
    {
        $this->expectException(\DomainException::class);
        new SourceReference(system: 'openemr', recordType: '', recordId: 'rx-1');
    }

    public function testEmptyRecordIdIsRejected(): void
    {
        $this->expectException(\DomainException::class);
        new SourceReference(system: 'openemr', recordType: 'MedicationRequest', recordId: '');
    }

    public function testJsonEncodableRoundTrip(): void
    {
        $ref = new SourceReference(
            system: 'openemr',
            recordType: 'Observation',
            recordId: 'obs-9',
            field: 'valueQuantity',
            recordedAt: new DateTimeImmutable('2026-01-15'),
        );

        $encoded = json_encode($ref->toArray(), JSON_THROW_ON_ERROR);
        $decoded = json_decode($encoded, true, flags: JSON_THROW_ON_ERROR);

        $this->assertSame($ref->toArray(), $decoded);
    }
}
