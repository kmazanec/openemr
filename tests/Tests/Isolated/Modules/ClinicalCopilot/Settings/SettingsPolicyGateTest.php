<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Settings;

use OpenEMR\Modules\ClinicalCopilot\Auth\PolicyDenyReason;
use OpenEMR\Modules\ClinicalCopilot\Settings\SettingsPolicyGate;
use PHPUnit\Framework\TestCase;

final class SettingsPolicyGateTest extends TestCase
{
    private const MODULE_AUTH_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth';

    private const MODULE_SETTINGS_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Settings';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_AUTH_DIR . '/PolicyDenyReason.php';
        require_once self::MODULE_AUTH_DIR . '/PolicyDecision.php';
        require_once self::MODULE_SETTINGS_DIR . '/SettingsPolicyGate.php';
    }

    public function testAllowsWriteWhenActingUuidMatchesTargetUuid(): void
    {
        $gate = new SettingsPolicyGate();

        $decision = $gate->evaluateWrite(
            'a8f5f167-f44f-4964-ad62-30e69e7e90d6',
            'a8f5f167-f44f-4964-ad62-30e69e7e90d6',
        );

        self::assertTrue($decision->allowed);
        self::assertNull($decision->reason);
    }

    public function testDeniesWriteWhenActingUuidDoesNotMatchTargetUuid(): void
    {
        $gate = new SettingsPolicyGate();

        $decision = $gate->evaluateWrite(
            'a8f5f167-f44f-4964-ad62-30e69e7e90d6',
            'b9c66377-1234-4eef-9999-30e69e7e9999',
        );

        self::assertFalse($decision->allowed);
        self::assertSame(PolicyDenyReason::NotOwnRow, $decision->reason);
    }

    public function testDeniesWriteWhenActingUuidIsEmpty(): void
    {
        $gate = new SettingsPolicyGate();

        $decision = $gate->evaluateWrite('', 'a8f5f167-f44f-4964-ad62-30e69e7e90d6');

        self::assertFalse($decision->allowed);
        self::assertSame(PolicyDenyReason::MissingSession, $decision->reason);
    }

    public function testDeniesWriteWhenTargetUuidIsEmpty(): void
    {
        $gate = new SettingsPolicyGate();

        $decision = $gate->evaluateWrite('a8f5f167-f44f-4964-ad62-30e69e7e90d6', '');

        self::assertFalse($decision->allowed);
        // Empty target on a self-only check is "you're not writing your own
        // row" — the same operational outcome as a uuid mismatch.
        self::assertSame(PolicyDenyReason::NotOwnRow, $decision->reason);
    }

}
