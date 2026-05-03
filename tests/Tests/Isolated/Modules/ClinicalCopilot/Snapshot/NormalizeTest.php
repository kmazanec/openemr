<?php

/**
 * Isolated tests for the OpenEMR-row normalization helpers.
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Normalize;
use PHPUnit\Framework\TestCase;

final class NormalizeTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/Normalize.php';
    }

    /**
     * @return iterable<string, array{?string, ?string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function dateCases(): iterable
    {
        yield 'null stays null' => [null, null];
        yield 'empty string -> null' => ['', null];
        yield 'whitespace -> null' => ['   ', null];
        yield 'OpenEMR zero-date -> null' => ['0000-00-00', null];
        yield 'OpenEMR zero-datetime -> null' => ['0000-00-00 00:00:00', null];
        yield 'epoch placeholder -> null' => ['1970-01-01 00:00:00', null];
        yield 'real date passes through' => ['2026-04-15', '2026-04-15'];
        yield 'real datetime trims to date' => ['2026-04-15 09:30:00', '2026-04-15'];
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('dateCases')]
    public function testToDateString(?string $input, ?string $expected): void
    {
        $this->assertSame($expected, Normalize::toDateString($input));
    }

    public function testToDateImmutableReturnsNullForUnknown(): void
    {
        $this->assertNull(Normalize::toDateImmutable('0000-00-00'));
        $this->assertNull(Normalize::toDateImmutable(''));
        $this->assertNull(Normalize::toDateImmutable(null));
    }

    public function testToDateImmutableParsesRealDate(): void
    {
        $d = Normalize::toDateImmutable('2026-04-15');
        $this->assertNotNull($d);
        $this->assertSame('2026-04-15', $d->format('Y-m-d'));
    }

    public function testToDateImmutableParsesDateTime(): void
    {
        $d = Normalize::toDateImmutable('2026-04-15 09:30:00');
        $this->assertNotNull($d);
        $this->assertSame('2026-04-15', $d->format('Y-m-d'));
    }

    public function testToDateImmutableReturnsNullOnUnparseable(): void
    {
        $this->assertNull(Normalize::toDateImmutable('not-a-date'));
        $this->assertNull(Normalize::toDateImmutable('99/99/9999'));
    }

    /**
     * @return iterable<string, array{?string, ?string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function stringCases(): iterable
    {
        yield 'null stays null' => [null, null];
        yield 'empty string -> null' => ['', null];
        yield 'whitespace-only -> null' => ['   ', null];
        yield 'real value passes through trimmed' => ['  metformin  ', 'metformin'];
        yield 'numeric string preserved' => ['500', '500'];
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('stringCases')]
    public function testToOptionalString(?string $input, ?string $expected): void
    {
        $this->assertSame($expected, Normalize::toOptionalString($input));
    }

    public function testRequireRecordIdAcceptsIntegerStrings(): void
    {
        $this->assertSame('42', Normalize::requireRecordId(42));
        $this->assertSame('42', Normalize::requireRecordId('42'));
        $this->assertSame('uuid-abc', Normalize::requireRecordId('uuid-abc'));
    }

    public function testRequireRecordIdRejectsEmpty(): void
    {
        $this->expectException(\DomainException::class);
        Normalize::requireRecordId('');
    }

    public function testRequireRecordIdRejectsNull(): void
    {
        $this->expectException(\DomainException::class);
        Normalize::requireRecordId(null);
    }

    public function testRequireRecordIdRejectsZeroInt(): void
    {
        // OpenEMR's "no row" sentinel is sometimes 0; treat as missing so we
        // don't carry a meaningless source ref into a citation.
        $this->expectException(\DomainException::class);
        Normalize::requireRecordId(0);
    }

    public function testRequireRecordIdRejectsZeroString(): void
    {
        // A column read as the string "0" (PDO without int-typing) is the
        // same sentinel — reject so a stringly-typed read doesn't slip past.
        $this->expectException(\DomainException::class);
        Normalize::requireRecordId('0');
    }

    public function testAgeYearsReturnsNullForMissingDob(): void
    {
        $this->assertNull(Normalize::ageYears(null));
    }

    public function testAgeYearsBeforeBirthdayInReferenceYear(): void
    {
        // DOB Feb 14 1968, reference Feb 13 2026 → 57 (birthday hasn't
        // landed yet that year). Pin the reference so the test does not
        // slide with the system clock.
        $age = Normalize::ageYears(
            new DateTimeImmutable('1968-02-14'),
            new DateTimeImmutable('2026-02-13'),
        );
        $this->assertSame(57, $age);
    }

    public function testAgeYearsOnBirthday(): void
    {
        $age = Normalize::ageYears(
            new DateTimeImmutable('1968-02-14'),
            new DateTimeImmutable('2026-02-14'),
        );
        $this->assertSame(58, $age);
    }

    public function testAgeYearsAfterBirthday(): void
    {
        $age = Normalize::ageYears(
            new DateTimeImmutable('1968-02-14'),
            new DateTimeImmutable('2026-12-31'),
        );
        $this->assertSame(58, $age);
    }

    public function testAgeYearsReturnsNullForFutureDob(): void
    {
        // A DOB in the future is data corruption — treat as missing
        // rather than returning a negative or zero age.
        $age = Normalize::ageYears(
            new DateTimeImmutable('2030-01-01'),
            new DateTimeImmutable('2026-05-03'),
        );
        $this->assertNull($age);
    }
}
