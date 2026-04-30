<?php

/**
 * Fixed-seed full-ChartSnapshot fixture test.
 *
 * Builds a complete ChartSnapshot for every PatientArchetype using
 * ArchetypeChartFactory at a pinned Faker seed, then compares the
 * resulting structure (decoded into PHP arrays — not formatted JSON
 * text) against committed fixtures in `fixtures/snapshot/{archetype}.json`.
 *
 * Comparing decoded structures rather than pretty-printed bytes means
 * the fixture-formatting on disk is purely cosmetic — the JSON hook
 * can normalize whitespace/key-quote style without breaking the test,
 * and the test itself doesn't have to pin a particular indentation.
 *
 * Regenerate fixtures (review the diff before committing!):
 *   UPDATE_FIXTURES=1 composer phpunit-isolated -- --filter ChartSnapshotFixtureTest
 *
 * This is the closest isolated equivalent to PRESEARCH decision #4's
 * "deterministic JSON snapshots from a pinned archetype distribution
 * and a pinned PRNG seed". Phase 3.6 lifts these into LangSmith
 * datasets.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot;

use OpenEMR\Seed\PatientArchetype;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\ArchetypeChartFactory;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\RequireModuleClasses;
use OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Snapshot\Archetype\SnapshotBuilder;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class ChartSnapshotFixtureTest extends TestCase
{
    private const FAKER_SEED = 20260430;

    private const FIXTURE_DIR = __DIR__ . '/fixtures/snapshot';

    public static function setUpBeforeClass(): void
    {
        RequireModuleClasses::load();
    }

    /**
     * @return iterable<string, array{PatientArchetype}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function archetypes(): iterable
    {
        foreach (PatientArchetype::cases() as $case) {
            yield $case->value => [$case];
        }
    }

    #[DataProvider('archetypes')]
    public function testSnapshotMatchesFixture(PatientArchetype $archetype): void
    {
        $chart = (new ArchetypeChartFactory(self::FAKER_SEED))->build($archetype);
        $snapshot = SnapshotBuilder::build($chart);
        // Faker's dateTimeBetween is pinned by seed *relative to now* — the
        // resulting Y-m-d slides as the system clock advances. Mask the
        // volatile date fields with a stable placeholder before comparison so
        // the fixture still pins the structural shape (key set, citation
        // shapes, archetype-driven content) without being reseeded daily.
        $actual = self::maskVolatileDates($snapshot->toArray());
        $fixturePath = self::FIXTURE_DIR . '/' . $archetype->value . '.json';

        if (getenv('UPDATE_FIXTURES') !== false && getenv('UPDATE_FIXTURES') !== '') {
            if (!is_dir(self::FIXTURE_DIR)) {
                mkdir(self::FIXTURE_DIR, 0o755, true);
            }
            file_put_contents(
                $fixturePath,
                json_encode(
                    $actual,
                    JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES,
                ) . "\n",
            );
            $this->assertFileExists($fixturePath);
            return;
        }

        $this->assertFileExists(
            $fixturePath,
            "Missing fixture for {$archetype->value}; regenerate with "
            . 'UPDATE_FIXTURES=1 composer phpunit-isolated -- --filter ChartSnapshotFixtureTest',
        );

        $expected = json_decode(
            (string) file_get_contents($fixturePath),
            associative: true,
            flags: JSON_THROW_ON_ERROR,
        );
        $this->assertEquals(
            $expected,
            $actual,
            "Snapshot diverged for {$archetype->value}. If the change is intended, "
            . 'regenerate with UPDATE_FIXTURES=1 and review the diff before committing.',
        );
    }

    /**
     * Replace every Y-m-d (and ISO-8601 datetime) string in the snapshot
     * payload with a stable placeholder. Operates on the decoded array so we
     * compare structure, not pretty-printed bytes.
     *
     * @param array<int|string, mixed> $value
     * @return array<int|string, mixed>
     */
    private static function maskVolatileDates(array $value): array
    {
        foreach ($value as $k => $v) {
            if (is_array($v)) {
                $value[$k] = self::maskVolatileDates($v);
                continue;
            }
            if (!is_string($v)) {
                continue;
            }
            if (preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/', $v) === 1) {
                $value[$k] = '<DATETIME>';
            } elseif (preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) === 1) {
                $value[$k] = '<DATE>';
            }
        }
        return $value;
    }
}
