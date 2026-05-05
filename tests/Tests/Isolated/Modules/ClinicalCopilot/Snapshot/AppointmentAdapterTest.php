<?php

/**
 * Isolated tests for AppointmentAdapter.
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AppointmentAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\AppointmentDataSource;
use PHPUnit\Framework\TestCase;

final class AppointmentAdapterTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/SourceReference.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Appointment.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Normalize.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/AppointmentDataSource.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/AppointmentAdapter.php';
    }

    public function testHappyPathBuildsAppointment(): void
    {
        $row = [
            'pc_eid' => 'apt-9',
            'pc_eventDate' => '2026-05-01',
            'pc_startTime' => '09:30:00',
            'pc_duration' => 1800, // OpenEMR stores duration in seconds
            'pc_catname' => 'office-visit',
            'pc_title' => 'diabetes follow-up',
        ];
        $today = new DateTimeImmutable('2026-05-01');

        $appt = (new AppointmentAdapter($this->source($row)))
            ->fetchToday(101, 'practitioner-uuid', $today);

        $this->assertNotNull($appt);
        $this->assertSame('apt-9', $appt->appointmentId);
        $this->assertSame('2026-05-01T09:30:00+00:00', $appt->startAt->format(\DateTimeInterface::ATOM));
        $this->assertSame(30, $appt->durationMinutes);
        $this->assertSame('office-visit', $appt->type);
        $this->assertSame('diabetes follow-up', $appt->reason);
        $this->assertSame('chart', $appt->source->sourceType);
        $this->assertSame('apt-9', $appt->source->sourceId);
    }

    public function testPassesScopeArgumentsToDataSource(): void
    {
        $source = new class implements AppointmentDataSource {
            public ?int $pid = null;

            public ?string $practitioner = null;

            public ?string $date = null;

            public function findOnDate(int $pid, string $practitionerUuid, DateTimeImmutable $date): ?array
            {
                $this->pid = $pid;
                $this->practitioner = $practitionerUuid;
                $this->date = $date->format('Y-m-d');
                return null;
            }
        };

        (new AppointmentAdapter($source))->fetchToday(101, 'practitioner-uuid', new DateTimeImmutable('2026-05-01'));

        $this->assertSame(101, $source->pid);
        $this->assertSame('practitioner-uuid', $source->practitioner);
        $this->assertSame('2026-05-01', $source->date);
    }

    public function testReturnsNullWhenNoAppointmentToday(): void
    {
        $appt = (new AppointmentAdapter($this->source(null)))
            ->fetchToday(101, 'practitioner-uuid', new DateTimeImmutable('2026-05-01'));
        $this->assertNull($appt);
    }

    public function testReturnsNullForUnparseableStartAt(): void
    {
        // OpenEMR's calendar table can carry partial/zero-date rows when
        // entries are abandoned. Treat as missing rather than synthesizing
        // a wrong startAt that would mislead the LLM.
        $row = [
            'pc_eid' => 'apt-9',
            'pc_eventDate' => '0000-00-00',
            'pc_startTime' => '00:00:00',
            'pc_duration' => 1800,
            'pc_catname' => 'office-visit',
            'pc_title' => null,
        ];
        $appt = (new AppointmentAdapter($this->source($row)))
            ->fetchToday(101, 'practitioner-uuid', new DateTimeImmutable('2026-05-01'));
        $this->assertNull($appt);
    }

    public function testNumericStringDurationConverts(): void
    {
        // MySQLi without typed-driver returns numeric columns as strings;
        // duration must still convert to minutes.
        $row = [
            'pc_eid' => 'apt-9',
            'pc_eventDate' => '2026-05-01',
            'pc_startTime' => '09:30:00',
            'pc_duration' => '1800',
            'pc_catname' => null,
            'pc_title' => null,
        ];
        $appt = (new AppointmentAdapter($this->source($row)))
            ->fetchToday(101, 'practitioner-uuid', new DateTimeImmutable('2026-05-01'));
        $this->assertNotNull($appt);
        $this->assertSame(30, $appt->durationMinutes);
    }

    public function testZeroDurationStoredVerbatim(): void
    {
        $row = [
            'pc_eid' => 'apt-9',
            'pc_eventDate' => '2026-05-01',
            'pc_startTime' => '09:30:00',
            'pc_duration' => 0,
            'pc_catname' => null,
            'pc_title' => null,
        ];
        $appt = (new AppointmentAdapter($this->source($row)))
            ->fetchToday(101, 'practitioner-uuid', new DateTimeImmutable('2026-05-01'));
        $this->assertNotNull($appt);
        $this->assertSame(0, $appt->durationMinutes);
        $this->assertNull($appt->type);
        $this->assertNull($appt->reason);
    }

    /**
     * @param ?array<string, mixed> $row
     */
    private function source(?array $row): AppointmentDataSource
    {
        return new class ($row) implements AppointmentDataSource {
            /** @param ?array<string, mixed> $row */
            public function __construct(private readonly ?array $row)
            {
            }

            public function findOnDate(int $pid, string $practitionerUuid, DateTimeImmutable $date): ?array
            {
                return $this->row;
            }
        };
    }
}
