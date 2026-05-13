<?php

/**
 * Asserts every browser-inbound entry point that mints an agent JWT
 * derives its `iss` claim through {@see AgentEndpointBootstrap::resolveIssuer()}
 * rather than composing `site_addr_oath + webroot + /oauth2/{site}`
 * directly.
 *
 * The direct composition produces OpenEMR's *self* URL (e.g.
 * `http://localhost:8300` inside the dev container), which mismatches
 * the agent's `AGENT_JWT_ISSUER` on any deploy where the browser-facing
 * URL differs (https://localhost:9300 in dev, https://emr.biograph.dev
 * in prod). The shared helper honors `OE_AGENT_JWT_ISSUER` so the two
 * sides stay locked together.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot\Auth;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class IssuerResolutionConsistencyTest extends TestCase
{
    private const REPO_ROOT = __DIR__ . '/../../../../../..';

    private const PUBLIC_DIR = self::REPO_ROOT
        . '/interface/modules/custom_modules/oe-module-clinical-copilot/public';

    /**
     * @return array<string, array{string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function browserMintEntryPoints(): array
    {
        return [
            'agent.php' => [self::PUBLIC_DIR . '/agent.php'],
            'extract.php' => [self::PUBLIC_DIR . '/extract.php'],
        ];
    }

    #[DataProvider('browserMintEntryPoints')]
    public function testEntryPointResolvesIssuerThroughHelper(string $path): void
    {
        $this->assertFileExists($path);
        $contents = file_get_contents($path);
        $this->assertNotFalse($contents);

        $this->assertMatchesRegularExpression(
            '/AgentEndpointBootstrap::resolveIssuer\(/',
            $contents,
            $path . ' must derive the JWT issuer via AgentEndpointBootstrap::resolveIssuer()'
                . ' so it agrees with the agent verifier\'s AGENT_JWT_ISSUER',
        );

        // The direct composition pattern is the regression we are
        // guarding against. If a future edit reintroduces it, the
        // verifier will 401 every request on any deploy where
        // site_addr_oath differs from AGENT_JWT_ISSUER.
        $this->assertDoesNotMatchRegularExpression(
            '/\$issuer\s*=\s*\$siteAddr\s*\.\s*\$webroot\s*\.\s*[\'"]\/oauth2\//',
            $contents,
            $path . ' must not compose $issuer from $siteAddr + $webroot directly;'
                . ' use AgentEndpointBootstrap::resolveIssuer() instead',
        );
    }
}
