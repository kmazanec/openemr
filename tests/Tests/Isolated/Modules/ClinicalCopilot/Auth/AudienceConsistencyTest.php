<?php

/**
 * Asserts the JWT audience string is consistent across all three places
 * it lives: the PHP minter constant, the Node agent's default, and the
 * deployed compose stacks' env vars.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Auth;

use OpenEMR\Modules\ClinicalCopilot\Auth\AgentTokenMinter;
use PHPUnit\Framework\TestCase;

/**
 * Three copies of the same string in three different files is exactly
 * the situation that produces "why is everything 401, my CI was green
 * yesterday" debugging sessions. A single grep here catches a typo
 * before it ships.
 *
 * The expected value is read directly from `AgentTokenMinter::AGENT_CLIENT_ID`,
 * so the minter is the single source of truth — change it there and CI
 * tells you which env vars / agent defaults need updating.
 */
final class AudienceConsistencyTest extends TestCase
{
    private const REPO_ROOT = __DIR__ . '/../../../../../..';

    private const MODULE_AUTH_DIR = self::REPO_ROOT
        . '/interface/modules/custom_modules/oe-module-clinical-copilot/src/Auth';

    public static function setUpBeforeClass(): void
    {
        require_once self::MODULE_AUTH_DIR . '/AgentTokenMintException.php';
        require_once self::MODULE_AUTH_DIR . '/AgentSigningKey.php';
        require_once self::MODULE_AUTH_DIR . '/JwksKeyId.php';
        require_once self::MODULE_AUTH_DIR . '/ClockInterface.php';
        require_once self::MODULE_AUTH_DIR . '/SystemClock.php';
        require_once self::MODULE_AUTH_DIR . '/JtiGenerator.php';
        require_once self::MODULE_AUTH_DIR . '/RandomJtiGenerator.php';
        require_once self::MODULE_AUTH_DIR . '/ResolvedFhirUser.php';
        require_once self::MODULE_AUTH_DIR . '/AgentTokenMinter.php';
    }

    /**
     * @return array<string, array{string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function composeStacksWithAudienceEnv(): array
    {
        return [
            'digitalocean' => [self::REPO_ROOT . '/docker/digitalocean/docker-compose.yml'],
            'development-easy' => [self::REPO_ROOT . '/docker/development-easy/docker-compose.yml'],
        ];
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('composeStacksWithAudienceEnv')]
    public function testComposeStackAudienceMatchesMinterConstant(string $composePath): void
    {
        $this->assertFileExists($composePath);
        $contents = file_get_contents($composePath);
        $this->assertNotFalse($contents);

        $matched = preg_match(
            '/^\s*AGENT_JWT_AUDIENCE:\s*(\S+)\s*$/m',
            $contents,
            $matches,
        );
        $this->assertSame(
            1,
            $matched,
            $composePath . ' must declare AGENT_JWT_AUDIENCE on the agent service',
        );
        $this->assertSame(
            AgentTokenMinter::AGENT_CLIENT_ID,
            $matches[1],
            'AGENT_JWT_AUDIENCE in ' . $composePath
                . ' must match AgentTokenMinter::AGENT_CLIENT_ID; if you changed the minter,'
                . ' update both compose files and the agent default',
        );
    }

    public function testAgentDefaultAudienceMatchesMinterConstant(): void
    {
        $serverIndex = self::REPO_ROOT . '/agent/src/server/index.ts';
        $this->assertFileExists($serverIndex);
        $contents = file_get_contents($serverIndex);
        $this->assertNotFalse($contents);

        $matched = preg_match(
            "/const\s+DEFAULT_AUDIENCE\s*=\s*'([^']+)'/",
            $contents,
            $matches,
        );
        $this->assertSame(
            1,
            $matched,
            'agent/src/server/index.ts must declare a string DEFAULT_AUDIENCE',
        );
        $this->assertSame(
            AgentTokenMinter::AGENT_CLIENT_ID,
            $matches[1],
            'DEFAULT_AUDIENCE in agent/src/server/index.ts must match AgentTokenMinter::AGENT_CLIENT_ID',
        );
    }
}
