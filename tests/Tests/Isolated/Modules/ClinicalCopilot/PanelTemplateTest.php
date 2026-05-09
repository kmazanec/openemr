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
            'documentViewerJsUrl' => '/modules/copilot/documentViewer.js',
            'documentViewUrlBase' => '/modules/copilot/document_view.php',
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
    public function rendersTheHistorySidebarShellWithItsAnchors(): void
    {
        // §4.7: the history sidebar lists this clinician's prior
        // conversations on the active patient. The JS bundle binds to
        // these data-role anchors — empty state, list container, and
        // an IntersectionObserver sentinel for infinite scroll.
        $twig = self::buildTwig();
        $html = $twig->render('panel.html.twig', self::defaultParams());

        self::assertStringContainsString('class="copilot-history"', $html);
        self::assertStringContainsString('data-role="history"', $html);
        self::assertStringContainsString('data-role="history-list"', $html);
        self::assertStringContainsString('data-role="history-empty"', $html);
        self::assertStringContainsString('data-role="history-sentinel"', $html);
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

    #[Test]
    public function rendersTheD1FilePickerMountPointsTheJsBindsAgainst(): void
    {
        // §D.1: panel.js wires `data-role="attach"` (the visible
        // paperclip button) and `data-role="file"` (the hidden native
        // input) plus `data-role="upload-toast"` (the typed-error
        // region). Drift in any of these drops the upload UI silently;
        // pin them as the JS contract.
        $twig = self::buildTwig();
        $html = $twig->render('panel.html.twig', self::defaultParams());

        self::assertStringContainsString('data-role="attach"', $html);
        self::assertStringContainsString('data-role="file"', $html);
        self::assertStringContainsString('data-role="upload-toast"', $html);
        // The hidden file input must declare the MIME allowlist as a
        // hint to the browser picker; the server still content-sniffs.
        self::assertMatchesRegularExpression(
            '/<input[^>]*data-role="file"[^>]*accept="application\/pdf,image\/png,image\/jpeg,image\/tiff,application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document,\.docx"/',
            $html,
        );
        // The toast renders hidden by default so an empty <div> doesn't
        // show a stripe of unused chrome below the composer.
        self::assertMatchesRegularExpression(
            '/data-role="upload-toast"[^>]*hidden|hidden[^>]*data-role="upload-toast"/',
            $html,
        );
    }

    #[Test]
    public function rendersTheF4DocumentViewerMountPointAndCloseControl(): void
    {
        // F.4: extracted_document chip click → side-by-side viewer pane
        // un-hides and `documentViewer.openDocument` mounts inside
        // `[data-role="document-viewer"]`. The pane renders hidden by
        // default; the close button gives the clinician a discoverable
        // exit (Escape also works, wired in panel.js).
        $twig = self::buildTwig();
        $html = $twig->render('panel.html.twig', self::defaultParams());

        self::assertStringContainsString('class="copilot-doc-viewer"', $html);
        self::assertStringContainsString('data-role="document-viewer-pane"', $html);
        self::assertStringContainsString('data-role="document-viewer"', $html);
        self::assertStringContainsString('data-role="document-viewer-close"', $html);
        // Pane ships hidden so an empty viewer doesn't claim half the
        // panel on first paint.
        self::assertMatchesRegularExpression(
            '/data-role="document-viewer-pane"[^>]*hidden|hidden[^>]*data-role="document-viewer-pane"/',
            $html,
        );
    }

    #[Test]
    public function rendersTheDocumentViewUrlBaseAttributeForJsViewer(): void
    {
        // F.4: panel.js reads `dataset.documentViewUrl` off the
        // `.copilot-panel` root to compose the document-fetch URL.
        // Drift in this attribute name silently breaks chip clicks.
        $twig = self::buildTwig();
        $html = $twig->render('panel.html.twig', self::defaultParams());

        self::assertStringContainsString(
            'data-document-view-url="/modules/copilot/document_view.php"',
            $html,
        );
    }

    #[Test]
    public function loadsTheDocumentViewerJsBundleAlongsidePanelJs(): void
    {
        // F.4: documentViewer.js is loaded as a separate <script> tag
        // (with `defer`, same as panel.js) so it's ready when the panel
        // resolves the global on the first chip click. Loading it
        // separately keeps the lazy-import contract honest: the
        // viewer's PDF.js dynamic-import fires only on PDF chip click,
        // not on every page load.
        $twig = self::buildTwig();
        $html = $twig->render('panel.html.twig', self::defaultParams());

        self::assertStringContainsString('src="/modules/copilot/documentViewer.js"', $html);
        self::assertMatchesRegularExpression(
            '/<script[^>]*src="\/modules\/copilot\/documentViewer\.js"[^>]*\sdefer/',
            $html,
        );
    }
}
