<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Cli;

use DateInterval;
use DateTimeImmutable;
use OpenEMR\Modules\ClinicalCopilot\Cli\InWindowPredicate;
use OpenEMR\Modules\ClinicalCopilot\Settings\PractitionerSettings;
use PHPUnit\Framework\TestCase;

/**
 * §5.3 cron-window correctness, including DST. The predicate is the
 * difference between firing for the right practitioners at the right
 * time versus over- or under-firing across timezones.
 */
final class InWindowPredicateTest extends TestCase
{
    private const MODULE_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_DIR . '/src/Settings/PractitionerSettings.php';
        require_once self::MODULE_DIR . '/src/Cli/InWindowPredicate.php';
    }

    public function testOptedOutPractitionerIsNeverInWindow(): void
    {
        $settings = $this->settings(enabled: false);
        $predicate = new InWindowPredicate();
        // A UTC instant that *would* match if the flag were on.
        $now = new DateTimeImmutable('2026-01-15T13:50:00+00:00');
        $this->assertFalse($predicate($settings, $now, new DateInterval('PT1H')));
    }

    /**
     * January in America/Chicago = CST (UTC−6). Local 07:50 = UTC 13:50.
     * A cron tick at UTC 13:55 is 5 minutes into the window.
     */
    public function testInsideWindowDuringCstWinter(): void
    {
        $settings = $this->settings();
        $predicate = new InWindowPredicate();
        $now = new DateTimeImmutable('2026-01-15T13:55:00+00:00');
        $this->assertTrue($predicate($settings, $now, new DateInterval('PT1H')));
    }

    /**
     * July in America/Chicago = CDT (UTC−5). Local 07:50 = UTC 12:50.
     * The same window at UTC 12:55 must still match — this is the case
     * a naive UTC-offset check would miss.
     */
    public function testInsideWindowDuringCdtSummer(): void
    {
        $settings = $this->settings();
        $predicate = new InWindowPredicate();
        $now = new DateTimeImmutable('2026-07-15T12:55:00+00:00');
        $this->assertTrue($predicate($settings, $now, new DateInterval('PT1H')));
    }

    public function testStartOfWindowIsInclusive(): void
    {
        $settings = $this->settings();
        $predicate = new InWindowPredicate();
        // CST: 07:50 local exactly.
        $now = new DateTimeImmutable('2026-01-15T13:50:00+00:00');
        $this->assertTrue($predicate($settings, $now, new DateInterval('PT1H')));
    }

    public function testEndOfWindowIsExclusive(): void
    {
        $settings = $this->settings();
        $predicate = new InWindowPredicate();
        // CST: 08:50 local — exactly +1h, must NOT match.
        $now = new DateTimeImmutable('2026-01-15T14:50:00+00:00');
        $this->assertFalse($predicate($settings, $now, new DateInterval('PT1H')));
    }

    public function testBeforeWindowDoesNotMatch(): void
    {
        $settings = $this->settings();
        $predicate = new InWindowPredicate();
        // CST: 07:49 local — one minute before the window opens.
        $now = new DateTimeImmutable('2026-01-15T13:49:00+00:00');
        $this->assertFalse($predicate($settings, $now, new DateInterval('PT1H')));
    }

    public function testAlternativeTimezoneShiftsTheWindow(): void
    {
        $settings = $this->settings(timezone: 'Europe/London');
        $predicate = new InWindowPredicate();
        // Europe/London winter = UTC+0; 07:50 local = 07:50 UTC.
        $now = new DateTimeImmutable('2026-01-15T07:55:00+00:00');
        $this->assertTrue($predicate($settings, $now, new DateInterval('PT1H')));
        // The same UTC instant that fires for America/Chicago must NOT
        // fire for London — that's the whole point of timezone-aware
        // wall-clock matching.
        $chicagoTime = new DateTimeImmutable('2026-01-15T13:55:00+00:00');
        $this->assertFalse($predicate($settings, $chicagoTime, new DateInterval('PT1H')));
    }

    private function settings(
        bool $enabled = true,
        string $timezone = 'America/Chicago',
        string $localTime = '07:50:00',
    ): PractitionerSettings {
        return new PractitionerSettings(
            practitionerUuid: '11111111-1111-1111-1111-111111111111',
            morningPrepEnabled: $enabled,
            morningPrepTimeLocal: $localTime,
            timezone: $timezone,
            updatedAt: new DateTimeImmutable('2026-04-30T12:00:00+00:00'),
        );
    }
}
