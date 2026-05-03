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
            // Match the pretty-format-json pre-commit hook's settings
            // (.pre-commit-config.yaml: --indent=2, --no-sort-keys) so a
            // fresh regen lands on disk in the exact form the hook would
            // otherwise rewrite it to. Avoids spurious whitespace-only
            // diffs after the next commit.
            file_put_contents(
                $fixturePath,
                self::encodeWithTwoSpaceIndent($actual) . "\n",
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
     * Pretty-print with 2-space indent. PHP's JSON_PRETTY_PRINT is
     * hard-coded to 4 spaces, so we post-process the leading-whitespace
     * runs. The pretty-format-json pre-commit hook would otherwise
     * rewrite the file to this same shape on the next commit.
     *
     * @param array<int|string, mixed> $value
     */
    private static function encodeWithTwoSpaceIndent(array $value): string
    {
        $pretty = json_encode(
            $value,
            JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES,
        );
        return (string) preg_replace_callback(
            '/^( {4})+/m',
            static fn(array $m): string => str_repeat('  ', intdiv(strlen($m[0]), 4)),
            $pretty,
        );
    }

    /**
     * Replace every Y-m-d (and ISO-8601 datetime) string in the snapshot
     * payload with a stable placeholder. Operates on the decoded array so we
     * compare structure, not pretty-printed bytes. `ageYears` is derived
     * from DOB at snapshot time (`new DateTimeImmutable('today')`), so it
     * slides as the clock advances exactly like DOB-formatted strings;
     * mask it the same way.
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
            if ($k === 'ageYears' && is_int($v)) {
                $value[$k] = '<AGE>';
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
