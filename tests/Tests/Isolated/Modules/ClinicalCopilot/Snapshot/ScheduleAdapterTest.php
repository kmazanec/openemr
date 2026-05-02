<?php

/**
 * Isolated tests for ScheduleAdapter.
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
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ScheduleAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ScheduleDataSource;
use PHPUnit\Framework\TestCase;

final class ScheduleAdapterTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/SourceReference.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/ScheduleSlot.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Normalize.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/ScheduleDataSource.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/ScheduleAdapter.php';
    }

    public function testHappyPathReturnsSlotsInStartTimeOrder(): void
    {
        // Rows arrive in non-deterministic order from the data source —
        // the adapter is the place that imposes startAt-ascending order
        // so the morning-prep job and the schedule view both consume a
        // sorted list without re-sorting.
        $rows = [
            self::row('apt-2', 12, '2026-05-01', '14:30:00', 1800, 'office-visit', 'med refill'),
            self::row('apt-1', 11, '2026-05-01', '09:00:00', 900, 'office-visit', 'diabetes follow-up'),
            self::row('apt-3', 13, '2026-05-01', '11:15:00', 1800, 'new-patient', 'intake'),
        ];

        $slots = (new ScheduleAdapter($this->source($rows)))
            ->fetchSchedule('practitioner-uuid', new DateTimeImmutable('2026-05-01'));

        $this->assertCount(3, $slots);
        $this->assertSame('apt-1', $slots[0]->appointmentId);
        $this->assertSame(11, $slots[0]->pid);
        $this->assertSame('2026-05-01T09:00:00+00:00', $slots[0]->startAt->format(\DateTimeInterface::ATOM));
        $this->assertSame(15, $slots[0]->durationMinutes);
        $this->assertSame('office-visit', $slots[0]->type);
        $this->assertSame('diabetes follow-up', $slots[0]->reason);
        $this->assertSame('Appointment', $slots[0]->source->recordType);
        $this->assertSame('apt-1', $slots[0]->source->recordId);

        $this->assertSame('apt-3', $slots[1]->appointmentId);
        $this->assertSame('apt-2', $slots[2]->appointmentId);
    }

    public function testEmptyDataSourceReturnsEmptyList(): void
    {
        $slots = (new ScheduleAdapter($this->source([])))
            ->fetchSchedule('practitioner-uuid', new DateTimeImmutable('2026-05-01'));
        $this->assertSame([], $slots);
    }

    public function testRowWithUnparseableStartAtIsSkipped(): void
    {
        // OpenEMR's calendar table can carry partial/zero-date rows;
        // skip rather than fabricate a startAt the LLM would trust.
        $rows = [
            self::row('apt-1', 11, '2026-05-01', '09:00:00', 900, 'office-visit', 'follow-up'),
            self::row('apt-2', 12, '0000-00-00', '00:00:00', 1800, 'office-visit', 'abandoned'),
        ];

        $slots = (new ScheduleAdapter($this->source($rows)))
            ->fetchSchedule('practitioner-uuid', new DateTimeImmutable('2026-05-01'));

        $this->assertCount(1, $slots);
        $this->assertSame('apt-1', $slots[0]->appointmentId);
    }

    public function testRowWithMissingPidIsSkipped(): void
    {
        // Schedule slots are useless without a pid (the schedule view
        // needs it to navigate to the chart). Skip rather than emit a
        // half-formed slot.
        $rows = [
            self::row('apt-1', 0, '2026-05-01', '09:00:00', 900, null, null),
        ];

        $slots = (new ScheduleAdapter($this->source($rows)))
            ->fetchSchedule('practitioner-uuid', new DateTimeImmutable('2026-05-01'));

        $this->assertSame([], $slots);
    }

    public function testForwardsArgumentsToDataSource(): void
    {
        $source = new class implements ScheduleDataSource {
            public ?string $practitioner = null;

            public ?string $date = null;

            /**
             * @return list<array<string, mixed>>
             */
            public function findScheduleByPractitioner(string $practitionerUuid, DateTimeImmutable $date): array
            {
                $this->practitioner = $practitionerUuid;
                $this->date = $date->format('Y-m-d');
                return [];
            }
        };

        (new ScheduleAdapter($source))
            ->fetchSchedule('practitioner-uuid', new DateTimeImmutable('2026-05-01'));

        $this->assertSame('practitioner-uuid', $source->practitioner);
        $this->assertSame('2026-05-01', $source->date);
    }

    public function testNumericStringDurationConverts(): void
    {
        // MySQLi without typed-driver returns numeric columns as strings.
        $rows = [self::row('apt-1', 11, '2026-05-01', '09:00:00', '1800', null, null)];

        $slots = (new ScheduleAdapter($this->source($rows)))
            ->fetchSchedule('practitioner-uuid', new DateTimeImmutable('2026-05-01'));

        $this->assertCount(1, $slots);
        $this->assertSame(30, $slots[0]->durationMinutes);
    }

    /**
     * @return array<string, mixed>
     */
    private static function row(
        string $eid,
        int $pid,
        string $eventDate,
        string $startTime,
        int|string $durationSeconds,
        ?string $catname,
        ?string $title,
    ): array {
        return [
            'pc_eid' => $eid,
            'pc_pid' => $pid,
            'pc_eventDate' => $eventDate,
            'pc_startTime' => $startTime,
            'pc_duration' => $durationSeconds,
            'pc_catname' => $catname,
            'pc_title' => $title,
        ];
    }

    /**
     * @param list<array<string, mixed>> $rows
     */
    private function source(array $rows): ScheduleDataSource
    {
        return new class ($rows) implements ScheduleDataSource {
            /** @param list<array<string, mixed>> $rows */
            public function __construct(private readonly array $rows)
            {
            }

            /**
             * @return list<array<string, mixed>>
             */
            public function findScheduleByPractitioner(string $practitionerUuid, DateTimeImmutable $date): array
            {
                return $this->rows;
            }
        };
    }
}
