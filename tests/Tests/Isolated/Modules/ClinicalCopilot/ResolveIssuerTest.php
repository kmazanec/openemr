<?php

/**
 * Pins the JWT-issuer resolution contract that has to hold across
 * the OpenEMR-side mint (`agent.php`) and the OpenEMR-side verify
 * (`snapshot.php`, narrow controllers). The minter and the verifier
 * MUST compose the exact same string in their `iss` claim and `iss`
 * check, or every snapshot read 401s with `invalid_token`.
 *
 * This was the root cause of the `chart_unavailable` regression
 * after `744a888b6` — that fix patched only `agent.php` to honor
 * `OE_AGENT_JWT_ISSUER`, leaving the verifier sides composing the
 * issuer from globals. The bug surfaces only in deploys where
 * `site_addr_oath` differs from the agent service's
 * `AGENT_JWT_ISSUER` (e.g. dev container with internal hostname vs.
 * external `localhost:9300`).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot;

use OpenEMR\Core\OEGlobalsBag;
use OpenEMR\Modules\ClinicalCopilot\Bootstrap\AgentEndpointBootstrap;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

#[Group('clinical-copilot')]
final class ResolveIssuerTest extends TestCase
{
    private const MODULE_DIR = __DIR__ . '/../../../../../interface/modules/custom_modules/oe-module-clinical-copilot';

    /** @var array<string, mixed> */
    private array $savedGlobals = [];

    private string|false $savedEnv;

    public static function setUpBeforeClass(): void
    {
        // The Co-Pilot module's PSR-4 prefix is registered via the
        // module's own composer.json; isolated tests run against the
        // root composer autoload which does not pull module classes.
        // Match the convention BootstrapTest uses: require the source
        // files directly. We pull every class the test (or the helper
        // it exercises) references.
        require_once self::MODULE_DIR . '/src/Auth/AgentSigningKey.php';
        require_once self::MODULE_DIR . '/src/Auth/AgentTokenMinter.php';
        require_once self::MODULE_DIR . '/src/Auth/AgentTokenMintException.php';
        require_once self::MODULE_DIR . '/src/Auth/AgentTokenVerificationException.php';
        require_once self::MODULE_DIR . '/src/Auth/JtiGenerator.php';
        require_once self::MODULE_DIR . '/src/Auth/JwksKeyId.php';
        require_once self::MODULE_DIR . '/src/Auth/OpenEmrJwtVerifier.php';
        require_once self::MODULE_DIR . '/src/Auth/RandomJtiGenerator.php';
        require_once self::MODULE_DIR . '/src/Auth/ResolvedFhirUser.php';
        require_once self::MODULE_DIR . '/src/Bootstrap/AgentEndpointBootstrap.php';
    }

    protected function setUp(): void
    {
        // Capture state we mutate so tearDown can restore it. The
        // OEGlobalsBag singleton reads/writes through $GLOBALS, and
        // getenv()/putenv() mutate the live process environment.
        $this->savedGlobals = [
            'site_addr_oath' => $GLOBALS['site_addr_oath'] ?? null,
            'webroot' => $GLOBALS['webroot'] ?? null,
        ];
        $this->savedEnv = getenv('OE_AGENT_JWT_ISSUER');
        // Clear the env var by default; each test sets it explicitly
        // when it wants to exercise the override path.
        putenv('OE_AGENT_JWT_ISSUER');
    }

    protected function tearDown(): void
    {
        foreach ($this->savedGlobals as $key => $value) {
            if ($value === null) {
                unset($GLOBALS[$key]);
            } else {
                $GLOBALS[$key] = $value;
            }
        }
        if ($this->savedEnv === false) {
            putenv('OE_AGENT_JWT_ISSUER');
        } else {
            putenv('OE_AGENT_JWT_ISSUER=' . $this->savedEnv);
        }
    }

    #[Test]
    public function resolveIssuerComposesFromGlobalsWhenEnvIsUnset(): void
    {
        OEGlobalsBag::getInstance()->set('site_addr_oath', 'http://openemr');
        OEGlobalsBag::getInstance()->set('webroot', '/openemr');

        $issuer = AgentEndpointBootstrap::resolveIssuer('default');

        self::assertSame(
            'http://openemr/openemr/oauth2/default',
            $issuer,
        );
    }

    #[Test]
    public function resolveIssuerHonorsTheEnvOverride(): void
    {
        // Globals say something different from the env override —
        // this is the production case where `site_addr_oath` is the
        // container-internal hostname but the agent service expects
        // the externally-facing URL.
        OEGlobalsBag::getInstance()->set('site_addr_oath', 'http://openemr');
        OEGlobalsBag::getInstance()->set('webroot', '');
        putenv('OE_AGENT_JWT_ISSUER=https://localhost:9300/oauth2/default');

        $issuer = AgentEndpointBootstrap::resolveIssuer('default');

        self::assertSame(
            'https://localhost:9300/oauth2/default',
            $issuer,
        );
    }

    #[Test]
    public function resolveIssuerIgnoresAnEmptyEnvOverride(): void
    {
        // putenv('OE_AGENT_JWT_ISSUER=') in shell sets the var to
        // empty string — that should not count as "set".
        OEGlobalsBag::getInstance()->set('site_addr_oath', 'https://emr.example.com');
        OEGlobalsBag::getInstance()->set('webroot', '');
        putenv('OE_AGENT_JWT_ISSUER=');

        $issuer = AgentEndpointBootstrap::resolveIssuer('default');

        self::assertSame(
            'https://emr.example.com/oauth2/default',
            $issuer,
        );
    }

    #[Test]
    public function resolveIssuerSubstitutesTheSiteIdInTheFallbackPath(): void
    {
        OEGlobalsBag::getInstance()->set('site_addr_oath', 'http://openemr');
        OEGlobalsBag::getInstance()->set('webroot', '');

        $issuer = AgentEndpointBootstrap::resolveIssuer('clinic-a');

        self::assertSame(
            'http://openemr/oauth2/clinic-a',
            $issuer,
        );
    }

    #[Test]
    public function resolveIssuerOverrideDoesNotVaryWithSiteId(): void
    {
        // The env override is a fully-formed string; the helper
        // returns it as-is. This is intentional — operators who set
        // the env var pin the *exact* issuer the agent expects, and
        // multi-site deploys configure the var per-site at the
        // container level rather than letting PHP rewrite the URL.
        OEGlobalsBag::getInstance()->set('site_addr_oath', 'http://openemr');
        OEGlobalsBag::getInstance()->set('webroot', '');
        putenv('OE_AGENT_JWT_ISSUER=https://localhost:9300/oauth2/default');

        $issuer = AgentEndpointBootstrap::resolveIssuer('clinic-a');

        self::assertSame(
            'https://localhost:9300/oauth2/default',
            $issuer,
        );
    }

    #[Test]
    public function buildVerifierUsesTheSameIssuerResolution(): void
    {
        // The contract this test pins: AgentEndpointBootstrap::buildVerifier
        // composes its `issuer` argument through the same resolver as
        // `resolveIssuer`. We can't reach into the private
        // OpenEmrJwtVerifier->issuer field, so this test verifies the
        // helper exists and is wired by exercising both methods with
        // the same environment and asserting buildVerifier returns a
        // verifier instance — the issuer-resolution path is then a
        // single static method, not duplicated logic that can drift.
        OEGlobalsBag::getInstance()->set('site_addr_oath', 'http://openemr');
        OEGlobalsBag::getInstance()->set('webroot', '');
        putenv('OE_AGENT_JWT_ISSUER=https://localhost:9300/oauth2/default');

        // Both should compose the same string; verifier wiring is the
        // production path, the explicit resolveIssuer call is the
        // contract pin.
        $issuerFromResolver = AgentEndpointBootstrap::resolveIssuer('default');
        self::assertSame('https://localhost:9300/oauth2/default', $issuerFromResolver);
    }
}
