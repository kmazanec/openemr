<?php

/**
 * Isolated render check for the Clinical Co-Pilot panel template.
 *
 * The panel template is deliberately self-contained (no `extends`, no
 * app-specific filters) so we render it through a minimal
 * `FilesystemLoader` and assert the structural anchors the JS bundle
 * relies on. The browser renderer keys off `data-role` attributes on the
 * thread, suggestions rail, and composer; if those drift, the JS
 * silently fails to populate the chat — which is exactly the kind of
 * regression this test catches.
 *
 * §4.5 update: the panel was reshaped from seven hard-coded sections
 * into a chat thread + composer. The previous `data-section="…"`
 * anchors are gone; the new contract is `data-role="thread"`,
 * `data-role="suggestions"`, `data-role="composer"`, `data-role="input"`,
 * `data-role="submit"` plus the existing root-container attributes.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Keith Mazanec <keith@devforward.com>
 * @copyright Copyright (c) 2026 Keith Mazanec
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\ClinicalCopilot;

use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;
use Twig\Environment;
use Twig\Loader\FilesystemLoader;
use Twig\TwigFilter;

#[Group('isolated')]
final class PanelTemplateTest extends TestCase
{
    private static function buildTwig(): Environment
    {
        $loader = new FilesystemLoader([
            __DIR__ . '/../../../../../interface/modules/custom_modules/oe-module-clinical-copilot/templates',
        ]);
        $twig = new Environment($loader, ['autoescape' => 'html']);
        // The template uses OpenEMR's `|xlt` (translate-and-escape) filter,
        // which the production stack registers via TwigExtension. The
        // isolated suite has no translator, so we pass through with the
        // same HTML escaping `|xlt` would apply at runtime.
        $twig->addFilter(new TwigFilter('xlt', static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES)));
        return $twig;
    }

    /**
     * @return array<string, mixed>
     */
    private static function defaultParams(): array
    {
        return [
            'cssUrl' => '/modules/copilot/panel.css',
            'jsUrl' => '/modules/copilot/panel.js',
            'proxyUrl' => '/modules/copilot/agent.php',
            'pid' => 42,
            'siteId' => 'default',
            'commonHeader' => '<meta charset="utf-8" />',
        ];
    }

    #[Test]
    public function rendersTheRootContainerWithProxyAndPidWiredForJs(): void
    {
        $twig = self::buildTwig();
        $html = $twig->render('panel.html.twig', self::defaultParams());

        self::assertStringContainsString('class="copilot-panel"', $html);
        self::assertStringContainsString('data-pid="42"', $html);
        self::assertStringContainsString('data-site-id="default"', $html);
        self::assertStringContainsString('data-proxy-url="/modules/copilot/agent.php"', $html);
    }

    #[Test]
    public function emitsAStatusElementForFailureStateText(): void
    {
        $twig = self::buildTwig();
        $html = $twig->render('panel.html.twig', self::defaultParams());

        self::assertStringContainsString('data-role="status"', $html);
    }

    #[Test]
    public function rendersTheChatThreadAnchorTheJsAppendsBubblesInto(): void
    {
        $twig = self::buildTwig();
        $html = $twig->render('panel.html.twig', self::defaultParams());

        self::assertStringContainsString('class="copilot-thread"', $html);
        self::assertStringContainsString('data-role="thread"', $html);
    }

    #[Test]
    public function rendersTheSuggestionsRailReservedForFollowupSuggestions(): void
    {
        $twig = self::buildTwig();
        $html = $twig->render('panel.html.twig', self::defaultParams());

        // §4.1 will populate this rail. It ships hidden so an empty rail
        // doesn't show a stripe of unused space below the bubble.
        self::assertMatchesRegularExpression(
            '/data-role="suggestions"[^>]*hidden|hidden[^>]*data-role="suggestions"/',
            $html,
        );
    }

    #[Test]
    public function rendersTheComposerFormEnabledForFreeTextFollowUps(): void
    {
        // §4.5 lifts the disabled state so the clinician can type ad-hoc
        // questions. The submit handler in panel.js POSTs to the same
        // proxy endpoint with `task: 'follow_up'` and the typed
        // question; the agent runs the same verification gate over the
        // resulting claims.
        $twig = self::buildTwig();
        $html = $twig->render('panel.html.twig', self::defaultParams());

        self::assertStringContainsString('data-role="composer"', $html);
        self::assertDoesNotMatchRegularExpression(
            '/<textarea[^>]*data-role="input"[^>]*disabled/',
            $html,
        );
        self::assertDoesNotMatchRegularExpression(
            '/<button[^>]*data-role="submit"[^>]*disabled/',
            $html,
        );
    }

    #[Test]
    public function loadsTheJsBundleWithDeferSoTheDomIsReadyOnInit(): void
    {
        $twig = self::buildTwig();
        $html = $twig->render('panel.html.twig', self::defaultParams());

        self::assertStringContainsString('src="/modules/copilot/panel.js"', $html);
        self::assertStringContainsString(' defer', $html);
    }

    #[Test]
    public function escapesProxyUrlSoUntrustedConfigCannotInjectMarkup(): void
    {
        $twig = self::buildTwig();
        $html = $twig->render(
            'panel.html.twig',
            array_merge(self::defaultParams(), [
                'proxyUrl' => '" onclick="alert(1)" data-x="',
            ]),
        );

        self::assertStringNotContainsString('onclick="alert(1)"', $html);
    }
}
