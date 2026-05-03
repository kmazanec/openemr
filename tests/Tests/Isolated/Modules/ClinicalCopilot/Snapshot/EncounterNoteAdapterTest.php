<?php

/**
 * Isolated tests for EncounterNoteAdapter.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\EncounterNoteAdapter;
use OpenEMR\Modules\ClinicalCopilot\Snapshot\Adapter\EncounterNoteDataSource;
use PHPUnit\Framework\TestCase;

final class EncounterNoteAdapterTest extends TestCase
{
    private const MODULE_SNAPSHOT_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Snapshot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_SNAPSHOT_DIR . '/SourceReference.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/EncounterNote.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Normalize.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/EncounterNoteDataSource.php';
        require_once self::MODULE_SNAPSHOT_DIR . '/Adapter/EncounterNoteAdapter.php';
    }

    public function testHappyPathBuildsNotesList(): void
    {
        $rows = [
            [
                'id' => 7,
                'note_date' => '2026-04-15',
                'subjective' => 'Pt reports good adherence.',
                'objective' => 'BP 138/82.',
                'assessment' => 'HTN well controlled.',
                'plan' => 'Continue current meds.',
            ],
        ];
        $list = (new EncounterNoteAdapter($this->source($rows)))->fetchForEncounter(101, 99);

        $this->assertCount(1, $list);
        $note = $list[0];
        $this->assertSame('99', $note->encounterId);
        $this->assertSame('7', $note->noteId);
        $this->assertSame('Pt reports good adherence.', $note->subjective);
        $this->assertSame('BP 138/82.', $note->objective);
        $this->assertSame('HTN well controlled.', $note->assessment);
        $this->assertSame('Continue current meds.', $note->plan);
        $this->assertNotNull($note->noteDate);
        $this->assertSame('2026-04-15', $note->noteDate->format('Y-m-d'));
        $this->assertSame('DocumentReference', $note->source->recordType);
        $this->assertSame('7', $note->source->recordId);
    }

    public function testEmptySoapRowDropped(): void
    {
        // A SOAP row whose four fields are all empty/whitespace has
        // nothing to quote. Drop so the verifier never sees a citation
        // pointing at a placeholder.
        $rows = [
            ['id' => 1, 'note_date' => '2026-04-15',
                'subjective' => '', 'objective' => '   ', 'assessment' => '', 'plan' => null],
            ['id' => 2, 'note_date' => '2026-04-15',
                'subjective' => 'Real note.', 'objective' => '', 'assessment' => '', 'plan' => ''],
        ];
        $list = (new EncounterNoteAdapter($this->source($rows)))->fetchForEncounter(101, 99);
        $this->assertCount(1, $list);
        $this->assertSame('2', $list[0]->source->recordId);
    }

    public function testStripsRowWithMissingId(): void
    {
        $rows = [
            ['id' => 0, 'note_date' => '2026-04-15',
                'subjective' => 'Has content.', 'objective' => '', 'assessment' => '', 'plan' => ''],
            ['id' => 5, 'note_date' => '2026-04-15',
                'subjective' => 'Has content.', 'objective' => '', 'assessment' => '', 'plan' => ''],
        ];
        $list = (new EncounterNoteAdapter($this->source($rows)))->fetchForEncounter(101, 99);
        $this->assertCount(1, $list);
        $this->assertSame('5', $list[0]->source->recordId);
    }

    public function testPassesArgsToDataSource(): void
    {
        $source = new class implements EncounterNoteDataSource {
            public ?int $pid = null;

            public ?int $encounterId = null;

            public function findByEncounterForPid(int $pid, int $encounterId): array
            {
                $this->pid = $pid;
                $this->encounterId = $encounterId;
                return [];
            }
        };

        (new EncounterNoteAdapter($source))->fetchForEncounter(101, 99);

        $this->assertSame(101, $source->pid);
        $this->assertSame(99, $source->encounterId);
    }

    public function testEmptyResultPassesThrough(): void
    {
        $list = (new EncounterNoteAdapter($this->source([])))->fetchForEncounter(101, 99);
        $this->assertSame([], $list);
    }

    public function testMultipleNotesForSameEncounter(): void
    {
        // form_soap can carry multiple rows per encounter (amendments,
        // multi-author docs); the adapter must return all of them.
        $rows = [
            ['id' => 7, 'note_date' => '2026-04-15',
                'subjective' => 'First note.', 'objective' => null, 'assessment' => null, 'plan' => null],
            ['id' => 8, 'note_date' => '2026-04-15',
                'subjective' => 'Amendment.', 'objective' => null, 'assessment' => null, 'plan' => null],
        ];
        $list = (new EncounterNoteAdapter($this->source($rows)))->fetchForEncounter(101, 99);
        $this->assertCount(2, $list);
        $this->assertSame('First note.', $list[0]->subjective);
        $this->assertSame('Amendment.', $list[1]->subjective);
    }

    /**
     * @param list<array<string, mixed>> $rows
     */
    private function source(array $rows): EncounterNoteDataSource
    {
        return new class ($rows) implements EncounterNoteDataSource {
            /** @param list<array<string, mixed>> $rows */
            public function __construct(private readonly array $rows)
            {
            }

            public function findByEncounterForPid(int $pid, int $encounterId): array
            {
                return $this->rows;
            }
        };
    }
}
