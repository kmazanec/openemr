<?php

/**
 * Isolated tests for ReminderAdapter.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ReminderAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\ReminderDataSource;
use PHPUnit\Framework\TestCase;
use RuntimeException;

final class ReminderAdapterTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/SourceReference.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Reminder.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Normalize.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/ReminderDataSource.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/ReminderAdapter.php';
    }

    public function testHappyPathBuildsReminderList(): void
    {
        $rows = [
            [
                'id'                => 85001,
                'pid'               => 5005,
                'due_status'        => 'overdue',
                'category'          => 'screening',
                'item'              => 'mammogram',
                'date_created'      => '2025-11-01',
                'due_status_title'  => 'overdue',
                'category_title'    => 'Screening',
                'item_title'        => 'Mammogram screening',
            ],
        ];
        $list = (new ReminderAdapter($this->source($rows)))->fetchDue(5005);

        $this->assertCount(1, $list);
        $reminder = $list[0];
        $this->assertSame('mammogram', $reminder->item);
        $this->assertSame('Mammogram screening', $reminder->itemTitle);
        $this->assertSame('screening', $reminder->category);
        $this->assertSame('Screening', $reminder->categoryTitle);
        $this->assertSame('overdue', $reminder->dueStatus);
        $this->assertNotNull($reminder->createdAt);
        $this->assertSame('2025-11-01', $reminder->createdAt->format('Y-m-d'));
        $this->assertSame(85001, $reminder->reminderId);
        $this->assertSame('chart', $reminder->source->sourceType);
        $this->assertSame('85001', $reminder->source->sourceId);
    }

    public function testFallsBackToRawCodesWhenListOptionsJoinMisses(): void
    {
        // Seeded data sometimes carries codes with no matching
        // list_options row. The LEFT JOIN's title columns come back
        // null; the adapter substitutes the raw code so the briefing
        // gets a less polished label rather than dropping the row.
        $rows = [
            [
                'id'                => 85010,
                'pid'               => 1234,
                'due_status'        => 'due',
                'category'          => 'unknown_cat',
                'item'              => 'unknown_item',
                'date_created'      => '2026-04-01',
                'due_status_title'  => null,
                'category_title'    => null,
                'item_title'        => null,
            ],
        ];
        $reminder = (new ReminderAdapter($this->source($rows)))->fetchDue(1234)[0];
        $this->assertSame('unknown_item', $reminder->itemTitle);
        $this->assertSame('unknown_cat', $reminder->categoryTitle);
        $this->assertSame('due', $reminder->dueStatus);
    }

    public function testStripsRowsWithEmptyItem(): void
    {
        $rows = [
            ['id' => 1, 'pid' => 99, 'due_status' => 'overdue', 'category' => 'screening',
                'item' => '', 'date_created' => null,
                'due_status_title' => null, 'category_title' => null, 'item_title' => null],
            ['id' => 2, 'pid' => 99, 'due_status' => 'overdue', 'category' => 'screening',
                'item' => 'mammogram', 'date_created' => null,
                'due_status_title' => null, 'category_title' => null, 'item_title' => null],
        ];
        $list = (new ReminderAdapter($this->source($rows)))->fetchDue(99);
        $this->assertCount(1, $list);
        $this->assertSame('mammogram', $list[0]->item);
    }

    public function testStripsRowsWithEmptyDueStatus(): void
    {
        // due_status carries the actionable signal; without it the
        // verifier rule has nothing to match on, so the row is no
        // better than a hallucination.
        $rows = [
            ['id' => 1, 'pid' => 99, 'due_status' => '', 'category' => 'screening',
                'item' => 'mammogram', 'date_created' => null,
                'due_status_title' => null, 'category_title' => null, 'item_title' => null],
        ];
        $this->assertSame([], (new ReminderAdapter($this->source($rows)))->fetchDue(99));
    }

    public function testFetchDueForwardsCapToDataSource(): void
    {
        $source = new class implements ReminderDataSource {
            public ?int $capturedCap = null;

            public function findDueForPid(int $pid, int $cap): array
            {
                $this->capturedCap = $cap;
                return [];
            }
        };
        (new ReminderAdapter($source))->fetchDue(99, 3);
        $this->assertSame(3, $source->capturedCap);
    }

    public function testDataLayerExceptionPropagates(): void
    {
        $source = new class implements ReminderDataSource {
            public function findDueForPid(int $pid, int $cap): array
            {
                throw new RuntimeException('boom');
            }
        };
        $this->expectException(RuntimeException::class);
        (new ReminderAdapter($source))->fetchDue(99);
    }

    /**
     * @param list<array<string, mixed>> $rows
     */
    private function source(array $rows): ReminderDataSource
    {
        return new class ($rows) implements ReminderDataSource {
            /** @param list<array<string, mixed>> $rows */
            public function __construct(private readonly array $rows)
            {
            }

            public function findDueForPid(int $pid, int $cap): array
            {
                return $this->rows;
            }
        };
    }
}
