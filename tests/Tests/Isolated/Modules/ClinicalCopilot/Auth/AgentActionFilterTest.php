<?php

/**
 * Regression test for the action-name shape filter in `agent.php`.
 *
 * The filter is the only thing standing between an attacker-controlled
 * `?action=` query parameter and the PolicyGate allowlist lookup. It
 * has been wrong before — `getAlnum()` silently strips underscores and
 * turned `latest_conversation` into `latestconversation`, which the
 * gate then rejected as `UnknownAction`. The test pins:
 *
 *   1. Every allowlisted action name passes the filter unchanged.
 *   2. The filter rejects characters that would let the action escape
 *      the allowlist (slashes, dots, percent escapes, NUL bytes).
 *   3. An over-aggressive filter such as `getAlnum()` that strips
 *      underscores is detected — at least one allowlisted action name
 *      contains a character `getAlnum()` would drop.
 *
 * The regex literal is duplicated from `public/agent.php` on purpose;
 * the boundary is so small that lifting it into a class earns nothing
 * but indirection. Both sites are checked against this single source
 * of truth.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Auth;

use OpenEMR\Modules\ClinicalCopilot\Auth\PolicyGate;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use ReflectionClass;

final class AgentActionFilterTest extends TestCase
{
    private const ACTION_SHAPE_REGEX = '/\A[a-z_]{1,64}\z/';

    private const MODULE_AUTH_DIR = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth';

    private const AGENT_PHP = __DIR__
        . '/../../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/public/agent.php';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_AUTH_DIR . '/PolicyGate.php';
    }

    public function testEveryAllowlistedActionPassesTheShapeFilter(): void
    {
        foreach ($this->allowlistedActions() as $action) {
            self::assertSame(
                1,
                preg_match(self::ACTION_SHAPE_REGEX, $action),
                "Action '{$action}' is in PolicyGate's allowlist but the "
                . "shape filter in agent.php would reject it. Either the "
                . "regex is too narrow or the action name needs to be "
                . "renamed.",
            );
        }
    }

    /**
     * @return iterable<string, array{string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function rejectedInputsProvider(): iterable
    {
        yield 'empty string' => [''];
        yield 'uppercase' => ['Briefing'];
        yield 'digits' => ['action1'];
        yield 'slash (path traversal)' => ['briefing/../echo'];
        yield 'dot' => ['briefing.echo'];
        yield 'percent escape' => ['briefing%2F'];
        yield 'NUL byte' => ["briefing\0"];
        yield 'whitespace' => ['briefing '];
        yield 'overlong (65 chars)' => [str_repeat('a', 65)];
    }

    #[DataProvider('rejectedInputsProvider')]
    public function testFilterRejectsOutOfShapeInputs(string $input): void
    {
        self::assertSame(
            0,
            preg_match(self::ACTION_SHAPE_REGEX, $input),
            "Input '" . addcslashes($input, "\0..\37\\") . "' should "
            . "have been rejected but matched the shape filter.",
        );
    }

    public function testAtLeastOneAllowlistedActionWouldBeMangledByGetAlnum(): void
    {
        // Catches accidental regression to `getAlnum()` (or any filter
        // that drops underscores). If a future refactor renames every
        // multi-word action to a single token, this test loses its
        // teeth — the test should be updated to assert the new
        // canonical shape rather than just deleted.
        $hasUnderscore = false;
        foreach ($this->allowlistedActions() as $action) {
            if (str_contains($action, '_')) {
                $hasUnderscore = true;
                break;
            }
        }
        self::assertTrue(
            $hasUnderscore,
            "Expected at least one allowlisted action to contain an "
            . "underscore so this test guards against `getAlnum()`-style "
            . "filters. None do.",
        );
    }

    public function testAgentPhpUsesTheSameRegex(): void
    {
        // Belt-and-braces: read the actual entry point and confirm the
        // regex literal matches the one this test pins. If someone
        // changes one, they have to change both.
        $source = file_get_contents(self::AGENT_PHP);
        self::assertIsString($source);
        self::assertStringContainsString(
            self::ACTION_SHAPE_REGEX,
            $source,
            "agent.php no longer contains the action-shape regex this "
            . "test pins. Either the entry point regressed or this test "
            . "needs to be updated alongside the new shape.",
        );
    }

    /**
     * @return list<string>
     */
    private function allowlistedActions(): array
    {
        $reflection = new ReflectionClass(PolicyGate::class);
        $allowlist = $reflection->getReflectionConstant('ACTION_SCOPE_ALLOWLIST');
        self::assertNotFalse($allowlist);
        $value = $allowlist->getValue();
        self::assertIsArray($value);
        return array_keys($value);
    }
}
